/**
 * Schema versioning and migrations (FR-3.5, NFR-9).
 *
 * Older documents are upgraded step by step to the current schema, missing fields are filled
 * with defaults, legacy timestamps are normalised to ISO 8601 and unknown enum values fall back
 * to the documented default. The input value is never mutated, and a document from a *newer*
 * version is refused instead of being silently down-graded.
 */
import {
  AUTHOR_TYPES,
  BUNDLE_KIND,
  BluepencilValidationError,
  DEFAULT_ENVIRONMENT,
  ENVIRONMENTS,
  MESSAGE_KINDS,
  NOTE_INTENTS,
  NOTE_STATUSES,
  NOTE_TYPES,
  REVEAL_CONTAINERS,
  SCHEMA_VERSION,
  newId,
  systemClock,
} from "../core/model";
import type {
  Anchor,
  Bundle,
  CapturedContext,
  DebugContext,
  Environment,
  Message,
  Note,
  NoteSource,
  RevealContainer,
  RevealHint,
  Session,
} from "../core/model";
import { assertBundle, assertNote } from "./schema";

/** Loose view of unknown JSON input while migrating. */
type JsonObject = Record<string, unknown>;
/** One upgrade step: receives a document of version n-1, returns version n. */
type Migration = (doc: JsonObject) => JsonObject;

/** Documents without a `schemaVersion` predate versioning and are read as v1. */
const LEGACY_VERSION = 1;

/**
 * Migration steps, keyed by the schema version they produce. v1 is the current shape, so the
 * table documents the slot and stays an identity step until a v2 exists.
 */
const NOTE_MIGRATIONS: Record<number, Migration> = {
  1: (doc) => doc,
};

const BUNDLE_MIGRATIONS: Record<number, Migration> = {
  1: (doc) => doc,
};

const SCHEMES = ["light", "dark"] as const;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Deep copy of plain JSON data — guarantees the caller's input is never touched. */
function deepCopy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepCopy);
  if (isObject(value)) {
    const out: JsonObject = {};
    for (const key of Object.keys(value)) out[key] = deepCopy(value[key]);
    return out;
  }
  return value;
}

function copyObject(value: JsonObject): JsonObject {
  return deepCopy(value) as JsonObject;
}

function readVersion(value: unknown, path: string): number {
  if (value === undefined || value === null) return LEGACY_VERSION;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new BluepencilValidationError([`${path}.schemaVersion must be a positive integer`]);
  }
  if (value > SCHEMA_VERSION) {
    throw new BluepencilValidationError([
      `${path}.schemaVersion ${value} is newer than the supported schema version ${SCHEMA_VERSION}`,
    ]);
  }
  return value;
}

function runMigrations(value: JsonObject, fromVersion: number, table: Record<number, Migration>): JsonObject {
  let current = copyObject(value);
  for (let version = fromVersion + 1; version <= SCHEMA_VERSION; version += 1) {
    const step = table[version];
    if (step !== undefined) current = step(current);
  }
  return current;
}

/** Known enum value or the documented default — legacy vocabularies must not block a load. */
function pickLiteral<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof value === "string") {
    const match = allowed.find((candidate) => candidate === value);
    if (match !== undefined) return match;
  }
  return fallback;
}

/** Normalise any parseable timestamp to ISO 8601; anything else falls back. */
function toIso(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return fallback;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function upgradeAnchor(value: unknown, path: string): Anchor {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw new BluepencilValidationError([`${path} must be an object`]);
  const anchor: Anchor = {};
  if (typeof value.hook === "string") anchor.hook = value.hook;
  if (typeof value.selector === "string") anchor.selector = value.selector;
  if (typeof value.quote === "string") anchor.quote = value.quote;
  if (typeof value.route === "string") anchor.route = value.route;
  if (typeof value.orphaned === "boolean") anchor.orphaned = value.orphaned;
  if (typeof value.degraded === "string") anchor.degraded = value.degraded;
  if (isObject(value.reveal)) {
    const container = value.reveal.container;
    if (typeof container === "string" && (REVEAL_CONTAINERS as readonly string[]).includes(container)) {
      const reveal: RevealHint = { container: container as RevealContainer };
      for (const key of ["triggerHook", "triggerSelector", "triggerLabel"] as const) {
        const field = value.reveal[key];
        if (typeof field === "string" && field !== "") reveal[key] = field;
      }
      anchor.reveal = reveal;
    }
  }
  return anchor;
}

function upgradeContext(value: unknown, path: string): CapturedContext | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw new BluepencilValidationError([`${path} must be null or an object`]);
  const box = isObject(value.box) ? value.box : {};
  const viewport = isObject(value.viewport) ? value.viewport : {};
  const classes = Array.isArray(value.classes) ? value.classes.filter((entry): entry is string => typeof entry === "string") : [];
  const styles: Record<string, string> = {};
  if (isObject(value.styles)) {
    for (const key of Object.keys(value.styles)) {
      const entry = value.styles[key];
      if (typeof entry === "string") styles[key] = entry;
    }
  }
  return {
    tag: typeof value.tag === "string" ? value.tag : "",
    classes,
    styles,
    box: {
      w: numberOrZero(box.w),
      h: numberOrZero(box.h),
      x: numberOrZero(box.x),
      y: numberOrZero(box.y),
    },
    scheme: pickLiteral(value.scheme, SCHEMES, "light"),
    viewport: { w: numberOrZero(viewport.w), h: numberOrZero(viewport.h) },
    ...(typeof value.buildRef === "string" ? { buildRef: value.buildRef } : {}),
  };
}

function upgradeDebug(value: unknown, path: string): DebugContext | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isObject(value)) throw new BluepencilValidationError([`${path} must be an object`]);
  const debug: DebugContext = {};
  if (typeof value.test === "string") debug.test = value.test;
  if (typeof value.stack === "string") debug.stack = value.stack;
  if (typeof value.log === "string") debug.log = value.log;
  if (typeof value.commit === "string") debug.commit = value.commit;
  if (typeof value.file === "string") debug.file = value.file;
  return debug;
}

function upgradeMessage(value: unknown, path: string, now: string): Message {
  if (!isObject(value)) throw new BluepencilValidationError([`${path} must be an object`]);
  return {
    id: nonEmptyString(value.id) ?? newId("m"),
    ts: toIso(value.ts, now),
    author: nonEmptyString(value.author) ?? "unknown",
    authorType: pickLiteral(value.authorType, AUTHOR_TYPES, "human"),
    kind: pickLiteral(value.kind, MESSAGE_KINDS, "note"),
    text: typeof value.text === "string" ? value.text : "",
  };
}

function upgradeMessages(value: unknown, path: string, now: string): Message[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BluepencilValidationError([`${path} must be an array`]);
  return value.map((entry, index) => upgradeMessage(entry, `${path}[${index}]`, now));
}

/** Defaults that a surrounding bundle contributes (environment and source of its notes). */
interface NoteDefaults {
  environment?: Environment;
  source?: NoteSource;
}

function upgradeNote(value: unknown, defaults: NoteDefaults, path: string): Note {
  if (!isObject(value)) throw new BluepencilValidationError([`${path} must be an object`]);
  const version = readVersion(value.schemaVersion, path);
  const doc = runMigrations(value, version, NOTE_MIGRATIONS);
  const now = systemClock.now();

  const createdAt = toIso(doc.createdAt, now);
  const sessionRef = nonEmptyString(doc.sessionRef);
  const ticketRef = nonEmptyString(doc.ticketRef);
  const debug = upgradeDebug(doc.debug, `${path}.debug`);
  const source = nonEmptyString(doc.source) ?? defaults.source ?? "cli:import";

  const note: Note = {
    id: nonEmptyString(doc.id) ?? newId("n"),
    schemaVersion: SCHEMA_VERSION,
    createdAt,
    updatedAt: toIso(doc.updatedAt, createdAt),
    ...(sessionRef !== undefined ? { sessionRef } : {}),
    type: pickLiteral(doc.type, NOTE_TYPES, "text"),
    intent: pickLiteral(doc.intent, NOTE_INTENTS, "implement"),
    status: pickLiteral(doc.status, NOTE_STATUSES, "open"),
    body: typeof doc.body === "string" ? doc.body : "",
    author: nonEmptyString(doc.author) ?? "anonymous",
    authorType: pickLiteral(doc.authorType, AUTHOR_TYPES, "human"),
    anchor: upgradeAnchor(doc.anchor, `${path}.anchor`),
    context: upgradeContext(doc.context, `${path}.context`),
    messages: upgradeMessages(doc.messages, `${path}.messages`, now),
    source,
    environment: pickLiteral(doc.environment, ENVIRONMENTS, defaults.environment ?? DEFAULT_ENVIRONMENT),
    ...(ticketRef !== undefined ? { ticketRef } : {}),
    ...(debug !== undefined ? { debug } : {}),
  };
  return assertNote(note);
}

function deriveSessions(notes: readonly Note[]): Session[] {
  const earliest = new Map<string, string>();
  for (const note of notes) {
    const ref = note.sessionRef;
    if (ref === undefined || ref === "") continue;
    const current = earliest.get(ref);
    if (current === undefined || note.createdAt < current) earliest.set(ref, note.createdAt);
  }
  return [...earliest.entries()].map(([ref, createdAt]) => ({ ref, label: ref, createdAt }));
}

function upgradeSessions(value: unknown, notes: readonly Note[], now: string): Session[] {
  if (value === undefined || value === null) return deriveSessions(notes);
  if (!Array.isArray(value)) throw new BluepencilValidationError(["bundle.sessions must be an array"]);
  return value.map((entry, index) => {
    const path = `bundle.sessions[${index}]`;
    if (!isObject(entry)) throw new BluepencilValidationError([`${path} must be an object`]);
    const ref = nonEmptyString(entry.ref) ?? `session-${index + 1}`;
    return {
      ref,
      label: nonEmptyString(entry.label) ?? ref,
      createdAt: toIso(entry.createdAt, now),
    };
  });
}

function upgradeApp(value: unknown): { name: string; buildRef?: string } {
  if (value === undefined || value === null) return { name: "unknown" };
  if (!isObject(value)) throw new BluepencilValidationError(["bundle.app must be an object"]);
  const name = nonEmptyString(value.name) ?? "unknown";
  const buildRef = nonEmptyString(value.buildRef);
  return { name, ...(buildRef !== undefined ? { buildRef } : {}) };
}

/** Upgrade one document to the current note schema (never mutates its input). */
export function migrateNote(value: unknown): Note {
  return upgradeNote(value, {}, "note");
}

/**
 * Upgrade one document to the current bundle schema (never mutates its input). Accepts a
 * bundle object, a bare `Note[]` (older exports) or an object without a `schemaVersion`.
 */
export function migrateBundle(value: unknown): Bundle {
  const source: unknown = Array.isArray(value) ? { notes: value } : value;
  if (!isObject(source)) {
    throw new BluepencilValidationError(["bundle must be an object or an array of notes"]);
  }
  const version = readVersion(source.schemaVersion, "bundle");
  const doc = runMigrations(source, version, BUNDLE_MIGRATIONS);
  const now = systemClock.now();

  const environment = pickLiteral(doc.environment, ENVIRONMENTS, DEFAULT_ENVIRONMENT);
  let notes: Note[] = [];
  if (doc.notes !== undefined && doc.notes !== null) {
    if (!Array.isArray(doc.notes)) throw new BluepencilValidationError(["bundle.notes must be an array"]);
    notes = doc.notes.map((entry, index) =>
      upgradeNote(entry, { environment, source: "cli:import" }, `bundle.notes[${index}]`),
    );
  }

  const bundle: Bundle = {
    kind: BUNDLE_KIND,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: toIso(doc.exportedAt, now),
    exportedBy: nonEmptyString(doc.exportedBy) ?? "unknown",
    environment,
    app: upgradeApp(doc.app),
    sessions: upgradeSessions(doc.sessions, notes, now),
    notes,
  };
  return assertBundle(bundle);
}
