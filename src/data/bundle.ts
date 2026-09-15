/**
 * Bundle I/O: create, serialise, parse and inspect the portable JSON exchange file
 * (FR-14.2, FR-14.5, FR-14.9, NFR-19).
 *
 * A bundle is plain, self-describing JSON — readable by a 20-line script without bluepencil.
 * Everything written here goes through the canonical form, so two exports of the same set are
 * byte-identical (NFR-17).
 */
import {
  BUNDLE_KIND,
  BluepencilValidationError,
  DEFAULT_ENVIRONMENT,
  ENVIRONMENTS,
  NOTE_INTENTS,
  NOTE_STATUSES,
  NOTE_TYPES,
  SCHEMA_VERSION,
  isEnvironment,
  systemClock,
} from "../core/model";
import type { Bundle, Environment, Note, Session } from "../core/model";
import { canonicalBundle, serializeCanonical } from "./canonical";
import { assertBundle, assertNote } from "./schema";

export interface BundleOptions {
  exportedBy?: string;
  environment?: Environment;
  app?: { name: string; buildRef?: string };
  sessions?: Session[];
  /** Injectable timestamp — tests and deterministic exports pass a fixed value (NFR-17). */
  now?: string;
}

/** What `inspect` reports before an import writes anything (FR-14.9). */
export interface BundleSummary {
  notes: number;
  sessions: Session[];
  environments: Environment[];
  byStatus: Record<string, number>;
  byIntent: Record<string, number>;
  byType: Record<string, number>;
  routes: string[];
  app?: { name: string; buildRef?: string };
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function uniqueEnvironments(values: readonly Environment[]): Environment[] {
  return [...new Set(values)].sort(compareStrings);
}

function zeroCounts(keys: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of keys) counts[key] = 0;
  return counts;
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * A bundle carries exactly one environment. An explicit `options.environment` is authoritative
 * and re-tags the notes (this is how a deliberate promotion dev → live works, FR-14.8); without
 * one, the notes themselves must agree (NFR-18).
 */
function resolveEnvironment(found: Environment[], requested: Environment | undefined): Environment {
  if (requested !== undefined) {
    if (!isEnvironment(requested)) {
      throw new BluepencilValidationError([
        `options.environment must be one of ${ENVIRONMENTS.join(", ")}`,
      ]);
    }
    return requested;
  }
  const first = found[0];
  if (found.length === 1 && first !== undefined) return first;
  if (found.length === 0) return DEFAULT_ENVIRONMENT;
  throw new BluepencilValidationError([
    `notes span multiple environments (${found.join(", ")}); export one environment at a time or pass options.environment explicitly`,
  ]);
}

/** Sessions that are only referenced by notes, without a caller-supplied label. */
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

/**
 * Build a portable bundle from a note set (FR-14.2). Notes are validated and canonicalised;
 * sessions are derived from `sessionRef` when the caller does not supply them.
 */
export function createBundle(notes: Note[], options: BundleOptions = {}): Bundle {
  if (!Array.isArray(notes)) {
    throw new BluepencilValidationError(["notes must be an array"]);
  }
  const validated = notes.map((note) => assertNote(note));
  const environment = resolveEnvironment(
    uniqueEnvironments(validated.map((note) => note.environment)),
    options.environment,
  );
  const tagged = validated.map((note) =>
    note.environment === environment ? note : { ...note, environment },
  );

  const bundle: Bundle = {
    kind: BUNDLE_KIND,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: options.now ?? systemClock.now(),
    exportedBy: options.exportedBy ?? "unknown",
    environment,
    app: { name: options.app?.name ?? "unknown", ...(options.app?.buildRef !== undefined ? { buildRef: options.app.buildRef } : {}) },
    sessions: options.sessions ?? deriveSessions(tagged),
    notes: tagged,
  };
  return assertBundle(canonicalBundle(bundle));
}

/** Serialise a bundle. `pretty` (default) is the canonical, diffable form (NFR-17). */
export function bundleToJson(bundle: Bundle, options: { pretty?: boolean } = {}): string {
  const canonical = assertBundle(canonicalBundle(bundle));
  if (options.pretty === false) return `${JSON.stringify(canonical)}\n`;
  return serializeCanonical(canonical);
}

/** Parse and validate a bundle file. Throws with all issues instead of loading bad data. */
export function parseBundle(text: string): Bundle {
  if (typeof text !== "string" || text.trim() === "") {
    throw new BluepencilValidationError(["bundle text must be a non-empty string"]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new BluepencilValidationError([`bundle is not valid JSON: ${reason}`]);
  }
  return assertBundle(parsed);
}

/** Summary of a bundle — counts, sessions, environments, routes, app. Writes nothing (FR-14.9). */
export function inspectBundle(bundle: Bundle): BundleSummary {
  const value = assertBundle(bundle);
  const byStatus = zeroCounts(NOTE_STATUSES);
  const byIntent = zeroCounts(NOTE_INTENTS);
  const byType = zeroCounts(NOTE_TYPES);
  const routes = new Set<string>();

  for (const note of value.notes) {
    increment(byStatus, note.status);
    increment(byIntent, note.intent);
    increment(byType, note.type);
    const route = note.anchor.route;
    if (route !== undefined && route !== "") routes.add(route);
  }

  return {
    notes: value.notes.length,
    sessions: value.sessions.map((session) => ({ ...session })).sort((a, b) => compareStrings(a.ref, b.ref) || compareStrings(a.createdAt, b.createdAt)),
    environments: uniqueEnvironments(value.notes.map((note) => note.environment)),
    byStatus,
    byIntent,
    byType,
    routes: [...routes].sort(compareStrings),
    app: {
      name: value.app.name,
      ...(value.app.buildRef !== undefined ? { buildRef: value.app.buildRef } : {}),
    },
  };
}
