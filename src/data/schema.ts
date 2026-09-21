/**
 * Schema validation for notes and bundles (FR-3.5, FR-14.2, FR-15.1/15.3).
 *
 * Pure, DOM-free and dependency-free — the UI, the CLI and the MCP server all use exactly
 * these validators, so a schema change breaks exactly one place (single source of truth).
 *
 * Every validator returns a list of human-readable issues; an empty list means "valid".
 * Issue paths are prefixed (`note.body`, `bundle.notes[2].anchor`) so a caller can print
 * them straight to a terminal.
 */
import {
  AUTHOR_TYPES,
  BUNDLE_KIND,
  BluepencilValidationError,
  ENVIRONMENTS,
  MESSAGE_KINDS,
  NOTE_INTENTS,
  NOTE_STATUSES,
  NOTE_TYPES,
  REVEAL_CONTAINERS,
  SCHEMA_VERSION,
} from "../core/model";
import type { Bundle, Note } from "../core/model";

/** Loose view of unknown JSON input while validating. */
type JsonObject = Record<string, unknown>;

/** ISO 8601 with an explicit zone — the only timestamp form bluepencil writes. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isIsoTimestamp(value: unknown): boolean {
  return typeof value === "string" && ISO_8601.test(value) && !Number.isNaN(Date.parse(value));
}

/** Short, safe rendering of a rejected value for an issue message. */
function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return Array.isArray(value) ? "an array" : "an object";
}

function enumIssues(path: string, value: unknown, allowed: readonly string[]): string[] {
  if (typeof value === "string" && allowed.includes(value)) return [];
  return [`${path} must be one of ${allowed.join(", ")} (got ${describe(value)})`];
}

function schemaVersionIssues(path: string, value: unknown): string[] {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return [`${path} must be a positive integer (got ${describe(value)})`];
  }
  if (value > SCHEMA_VERSION) {
    return [`${path} ${value} is newer than the supported schema version ${SCHEMA_VERSION}`];
  }
  return [];
}

function anchorIssues(value: unknown, path: string): string[] {
  if (!isObject(value)) return [`${path} must be an object`];
  const issues: string[] = [];
  const hasTarget =
    isNonEmptyString(value.hook) || isNonEmptyString(value.selector) || isNonEmptyString(value.quote);
  if (!hasTarget) issues.push(`${path} needs at least one of hook, selector or quote`);
  for (const key of ["hook", "selector", "quote", "route", "degraded"] as const) {
    const field = value[key];
    if (field !== undefined && typeof field !== "string") issues.push(`${path}.${key} must be a string`);
  }
  if (value.orphaned !== undefined && typeof value.orphaned !== "boolean") {
    issues.push(`${path}.orphaned must be a boolean`);
  }
  issues.push(...revealIssues(value.reveal, `${path}.reveal`));
  return issues;
}

/** Issue #20: the optional reveal hint, validated like every other part of an anchor. */
function revealIssues(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!isObject(value)) return [`${path} must be an object`];
  const issues: string[] = [];
  const container = value.container;
  if (
    typeof container !== "string" ||
    !(REVEAL_CONTAINERS as readonly string[]).includes(container)
  ) {
    issues.push(`${path}.container must be one of ${REVEAL_CONTAINERS.join(", ")}`);
  }
  for (const key of ["triggerHook", "triggerSelector", "triggerLabel"] as const) {
    const field = value[key];
    if (field !== undefined && typeof field !== "string") {
      issues.push(`${path}.${key} must be a string`);
    }
  }
  return issues;
}

function stringListIssues(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) return [`${path} must be an array of strings`];
  const issues: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string") issues.push(`${path}[${index}] must be a string`);
  });
  return issues;
}

function stringMapIssues(value: unknown, path: string): string[] {
  if (!isObject(value)) return [`${path} must be an object of strings`];
  const issues: string[] = [];
  for (const key of Object.keys(value)) {
    if (typeof value[key] !== "string") issues.push(`${path}.${key} must be a string`);
  }
  return issues;
}

function numberIssues(value: unknown, path: string, keys: readonly string[]): string[] {
  if (!isObject(value)) return [`${path} must be an object`];
  const issues: string[] = [];
  for (const key of keys) {
    const field = value[key];
    if (typeof field !== "number" || Number.isNaN(field)) issues.push(`${path}.${key} must be a number`);
  }
  return issues;
}

function contextIssues(value: unknown, path: string): string[] {
  if (value === undefined) return [`${path} must be null or an object`];
  if (value === null) return [];
  if (!isObject(value)) return [`${path} must be null or an object`];
  const issues: string[] = [];
  if (!isNonEmptyString(value.tag)) issues.push(`${path}.tag must be a non-empty string`);
  issues.push(...stringListIssues(value.classes, `${path}.classes`));
  issues.push(...stringMapIssues(value.styles, `${path}.styles`));
  issues.push(...numberIssues(value.box, `${path}.box`, ["w", "h", "x", "y"]));
  issues.push(...enumIssues(`${path}.scheme`, value.scheme, ["light", "dark"]));
  issues.push(...numberIssues(value.viewport, `${path}.viewport`, ["w", "h"]));
  if (value.buildRef !== undefined && typeof value.buildRef !== "string") {
    issues.push(`${path}.buildRef must be a string`);
  }
  return issues;
}

function debugIssues(value: unknown, path: string): string[] {
  if (!isObject(value)) return [`${path} must be an object`];
  const issues: string[] = [];
  for (const key of ["test", "stack", "log", "commit", "file"] as const) {
    const field = value[key];
    if (field !== undefined && typeof field !== "string") issues.push(`${path}.${key} must be a string`);
  }
  return issues;
}

function messageIssues(value: unknown, path: string): string[] {
  if (!isObject(value)) return [`${path} must be an object`];
  const issues: string[] = [];
  if (!isNonEmptyString(value.id)) issues.push(`${path}.id must be a non-empty string`);
  if (!isIsoTimestamp(value.ts)) issues.push(`${path}.ts must be an ISO 8601 timestamp`);
  if (!isNonEmptyString(value.author)) issues.push(`${path}.author must be a non-empty string`);
  issues.push(...enumIssues(`${path}.authorType`, value.authorType, AUTHOR_TYPES));
  issues.push(...enumIssues(`${path}.kind`, value.kind, MESSAGE_KINDS));
  if (!isNonEmptyString(value.text)) issues.push(`${path}.text must be a non-empty string`);
  return issues;
}

function messagesIssues(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) return [`${path} must be an array`];
  const issues: string[] = [];
  value.forEach((message, index) => issues.push(...messageIssues(message, `${path}[${index}]`)));
  return issues;
}

/** Field-level checks shared by `validateNote` and `validateBundle`. */
function noteIssues(note: JsonObject, path: string): string[] {
  const issues: string[] = [];
  if (!isNonEmptyString(note.id)) issues.push(`${path}.id must be a non-empty string`);
  issues.push(...schemaVersionIssues(`${path}.schemaVersion`, note.schemaVersion));
  if (!isIsoTimestamp(note.createdAt)) issues.push(`${path}.createdAt must be an ISO 8601 timestamp`);
  if (!isIsoTimestamp(note.updatedAt)) issues.push(`${path}.updatedAt must be an ISO 8601 timestamp`);
  if (note.sessionRef !== undefined && !isNonEmptyString(note.sessionRef)) {
    issues.push(`${path}.sessionRef must be a non-empty string`);
  }
  issues.push(...enumIssues(`${path}.type`, note.type, NOTE_TYPES));
  issues.push(...enumIssues(`${path}.intent`, note.intent, NOTE_INTENTS));
  issues.push(...enumIssues(`${path}.status`, note.status, NOTE_STATUSES));
  if (!isNonEmptyString(note.body)) issues.push(`${path}.body must be a non-empty string`);
  if (!isNonEmptyString(note.author)) issues.push(`${path}.author must be a non-empty string`);
  issues.push(...enumIssues(`${path}.authorType`, note.authorType, AUTHOR_TYPES));
  issues.push(...anchorIssues(note.anchor, `${path}.anchor`));
  issues.push(...contextIssues(note.context, `${path}.context`));
  issues.push(...messagesIssues(note.messages, `${path}.messages`));
  if (!isNonEmptyString(note.source)) issues.push(`${path}.source must be a non-empty string`);
  issues.push(...enumIssues(`${path}.environment`, note.environment, ENVIRONMENTS));
  if (note.ticketRef !== undefined && !isNonEmptyString(note.ticketRef)) {
    issues.push(`${path}.ticketRef must be a non-empty string`);
  }
  if (note.debug !== undefined) issues.push(...debugIssues(note.debug, `${path}.debug`));
  return issues;
}

function appIssues(value: unknown): string[] {
  if (!isObject(value)) return ["bundle.app must be an object"];
  const issues: string[] = [];
  if (!isNonEmptyString(value.name)) issues.push("bundle.app.name must be a non-empty string");
  if (value.buildRef !== undefined && typeof value.buildRef !== "string") {
    issues.push("bundle.app.buildRef must be a string");
  }
  return issues;
}

function sessionIssues(value: unknown): string[] {
  if (!Array.isArray(value)) return ["bundle.sessions must be an array"];
  const issues: string[] = [];
  const seen = new Set<string>();
  value.forEach((session, index) => {
    const path = `bundle.sessions[${index}]`;
    if (!isObject(session)) {
      issues.push(`${path} must be an object`);
      return;
    }
    if (!isNonEmptyString(session.ref)) issues.push(`${path}.ref must be a non-empty string`);
    if (!isNonEmptyString(session.label)) issues.push(`${path}.label must be a non-empty string`);
    if (!isIsoTimestamp(session.createdAt)) issues.push(`${path}.createdAt must be an ISO 8601 timestamp`);
    if (typeof session.ref === "string") {
      if (seen.has(session.ref)) issues.push(`${path}.ref ${JSON.stringify(session.ref)} is not unique`);
      seen.add(session.ref);
    }
  });
  return issues;
}

function bundleNoteIssues(value: unknown): string[] {
  if (!Array.isArray(value)) return ["bundle.notes must be an array"];
  const issues: string[] = [];
  const seen = new Set<string>();
  value.forEach((note, index) => {
    const path = `bundle.notes[${index}]`;
    if (!isObject(note)) {
      issues.push(`${path} must be an object`);
      return;
    }
    issues.push(...noteIssues(note, path));
    if (typeof note.id === "string") {
      if (seen.has(note.id)) issues.push(`${path}.id ${JSON.stringify(note.id)} is not unique`);
      seen.add(note.id);
    }
  });
  return issues;
}

/** Validate a single note. Returns `[]` when the note is valid (FR-15.1). */
export function validateNote(value: unknown): string[] {
  if (!isObject(value)) return ["note must be an object"];
  return noteIssues(value, "note");
}

/** Validate a bundle (FR-14.2). Returns `[]` when the bundle is valid. */
export function validateBundle(value: unknown): string[] {
  if (!isObject(value)) return ["bundle must be an object"];
  const issues: string[] = [];
  if (value.kind !== BUNDLE_KIND) {
    issues.push(`bundle.kind must be ${JSON.stringify(BUNDLE_KIND)} (got ${describe(value.kind)})`);
  }
  issues.push(...schemaVersionIssues("bundle.schemaVersion", value.schemaVersion));
  if (!isIsoTimestamp(value.exportedAt)) issues.push("bundle.exportedAt must be an ISO 8601 timestamp");
  if (!isNonEmptyString(value.exportedBy)) issues.push("bundle.exportedBy must be a non-empty string");
  issues.push(...enumIssues("bundle.environment", value.environment, ENVIRONMENTS));
  issues.push(...appIssues(value.app));
  issues.push(...sessionIssues(value.sessions));
  issues.push(...bundleNoteIssues(value.notes));
  return issues;
}

/** Assert that a value is a valid note — throws with every issue, never silently. */
export function assertNote(value: unknown): Note {
  const issues = validateNote(value);
  if (issues.length > 0) throw new BluepencilValidationError(issues);
  return value as Note;
}

/** Assert that a value is a valid bundle — throws with every issue, never silently. */
export function assertBundle(value: unknown): Bundle {
  const issues = validateBundle(value);
  if (issues.length > 0) throw new BluepencilValidationError(issues);
  return value as Bundle;
}
