/**
 * Import/merge logic (FR-14.3/14.4, NFR-18).
 *
 * Three modes, all idempotent, none ever silently overwriting:
 *  - `merge` (default): add unknown ids, skip known ones.
 *  - `upsert`: also update known notes whose content changed; threads are concatenated.
 *  - `replace-session`: drop the notes of the sessions carried by the incoming set first.
 *
 * Content that an import would change is a **conflict**: it is always listed, and the write is
 * refused unless the caller resolved it explicitly (`onConflict`). A dry run computes the same
 * result without refusing, so a report can be produced before anything is written.
 */
import { BluepencilValidationError } from "../core/model";
import type { Environment, Message, Note } from "../core/model";
import { canonicalNote, serializeCanonical } from "./canonical";

export type MergeMode = "merge" | "upsert" | "replace-session";

export interface MergeOptions {
  mode?: MergeMode;
  dryRun?: boolean;
  allowEnvMismatch?: boolean;
  onConflict?: "fail" | "keep-incoming" | "keep-existing";
  targetEnvironment?: Environment;
}

export interface MergeConflict {
  id: string;
  reason: string;
  existingUpdatedAt: string;
  incomingUpdatedAt: string;
}

export interface MergeResult {
  added: number;
  updated: number;
  skipped: number;
  removed: number;
  conflicts: MergeConflict[];
  notes: Note[];
}

/** Sentinels used to compare content while ignoring `updatedAt` (that is what diverges by design). */
const IGNORED_UPDATED_AT = "0000-01-01T00:00:00.000Z";

function contentKey(note: Note): string {
  return serializeCanonical(canonicalNote({ ...note, updatedAt: IGNORED_UPDATED_AT }));
}

function laterTimestamp(a: string, b: string): string {
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isNaN(left)) return b;
  if (Number.isNaN(right)) return a;
  return left >= right ? a : b;
}

/** Human-readable list of the fields that differ (used for the conflict reason). */
function divergingFields(existing: Note, incoming: Note): string[] {
  const left = canonicalNote(existing);
  const right = canonicalNote(incoming);
  const fields: string[] = [];
  if (left.type !== right.type) fields.push("type");
  if (left.intent !== right.intent) fields.push("intent");
  if (left.status !== right.status) fields.push("status");
  if (left.body !== right.body) fields.push("body");
  if (left.author !== right.author) fields.push("author");
  if (left.authorType !== right.authorType) fields.push("authorType");
  if (serializeCanonical(left.anchor) !== serializeCanonical(right.anchor)) fields.push("anchor");
  if (serializeCanonical(left.context) !== serializeCanonical(right.context)) fields.push("context");
  if (serializeCanonical(left.messages) !== serializeCanonical(right.messages)) fields.push("messages");
  if (left.source !== right.source) fields.push("source");
  if (left.environment !== right.environment) fields.push("environment");
  if ((left.sessionRef ?? null) !== (right.sessionRef ?? null)) fields.push("sessionRef");
  if ((left.ticketRef ?? null) !== (right.ticketRef ?? null)) fields.push("ticketRef");
  if (serializeCanonical(left.debug ?? null) !== serializeCanonical(right.debug ?? null)) fields.push("debug");
  if (left.createdAt !== right.createdAt) fields.push("createdAt");
  if (left.schemaVersion !== right.schemaVersion) fields.push("schemaVersion");
  return fields;
}

/** Append-only thread merge: incoming messages are appended, deduplicated by message id. */
function concatMessages(existing: readonly Message[], incoming: readonly Message[]): Message[] {
  const merged = existing.map((message) => ({ ...message }));
  const seen = new Set(merged.map((message) => message.id));
  for (const message of incoming) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push({ ...message });
  }
  return merged;
}

/** Incoming content wins; the note keeps its identity and history (FR-14.3 upsert). */
function mergeNoteInto(existing: Note, incoming: Note): Note {
  const sessionRef = incoming.sessionRef ?? existing.sessionRef;
  const ticketRef = incoming.ticketRef ?? existing.ticketRef;
  const debug = incoming.debug ?? existing.debug;
  return {
    id: existing.id,
    schemaVersion: incoming.schemaVersion,
    createdAt: existing.createdAt,
    updatedAt: laterTimestamp(existing.updatedAt, incoming.updatedAt),
    ...(sessionRef !== undefined ? { sessionRef } : {}),
    type: incoming.type,
    intent: incoming.intent,
    status: incoming.status,
    body: incoming.body,
    author: incoming.author,
    authorType: incoming.authorType,
    anchor: { ...incoming.anchor },
    context: incoming.context === null ? null : { ...incoming.context },
    messages: concatMessages(existing.messages, incoming.messages),
    source: incoming.source,
    environment: incoming.environment,
    ...(ticketRef !== undefined ? { ticketRef } : {}),
    ...(debug !== undefined ? { debug: { ...debug } } : {}),
  };
}

function uniqueEnvironments(notes: readonly Note[]): Environment[] {
  return [...new Set(notes.map((note) => note.environment))].sort();
}

/** The single environment of a note set, or `undefined` when it is empty or mixed. */
function singleEnvironment(notes: readonly Note[]): Environment | undefined {
  const found = uniqueEnvironments(notes);
  return found.length === 1 ? found[0] : undefined;
}

/**
 * Environment isolation by default (NFR-18): importing a `live` bundle into a `dev` store is
 * refused with an explanation unless the caller explicitly allows the mismatch.
 */
function assertEnvironmentCompatible(
  existing: readonly Note[],
  incoming: readonly Note[],
  options: MergeOptions,
): void {
  if (options.allowEnvMismatch === true) return;
  const incomingEnvironments = uniqueEnvironments(incoming);
  const target = options.targetEnvironment ?? singleEnvironment(existing);
  const issues: string[] = [];
  if (incomingEnvironments.length > 1) {
    issues.push(
      `incoming notes span multiple environments (${incomingEnvironments.join(", ")}); import one environment at a time`,
    );
  }
  if (target !== undefined && incomingEnvironments.length === 1) {
    const incomingEnvironment = incomingEnvironments[0];
    if (incomingEnvironment !== undefined && incomingEnvironment !== target) {
      issues.push(
        `environment mismatch: incoming notes are "${incomingEnvironment}" but the target is "${target}"; pass allowEnvMismatch (--allow-env-mismatch) to import anyway`,
      );
    }
  }
  if (issues.length > 0) throw new BluepencilValidationError(issues);
}

interface MergeCounts {
  added: number;
  updated: number;
  skipped: number;
  removed: number;
  conflicts: number;
}

/**
 * The write is refused, but the caller still learns what would have happened (FR-14.4).
 * `counts.conflicts` is the number of *unresolved* entries listed in the issues; a `merge`-mode
 * divergence that only skips a note is reported in `MergeResult.conflicts` and never refuses.
 */
function refusal(conflicts: readonly MergeConflict[], counts: MergeCounts): BluepencilValidationError {
  return new BluepencilValidationError([
    ...conflicts.map((conflict) => `conflict: ${conflict.reason}`),
    `counts: added=${counts.added}, updated=${counts.updated}, skipped=${counts.skipped}, removed=${counts.removed}, conflicts=${counts.conflicts}`,
  ]);
}

/**
 * Merge an incoming note set into an existing one and report exactly what happened
 * (`added`/`updated`/`skipped`/`removed`/`conflicts`). The input arrays and notes are never
 * mutated; `notes` is the resulting set, which a dry run merely computes instead of applying
 * (the caller decides whether to write it).
 */
export function mergeNotes(
  existing: Note[],
  incoming: Note[],
  options: MergeOptions = {},
): MergeResult {
  const mode: MergeMode = options.mode ?? "merge";
  const dryRun = options.dryRun === true;
  const onConflict = options.onConflict;

  assertEnvironmentCompatible(existing, incoming, options);

  let working: Note[] = [...existing];
  let removed = 0;

  // replace-session: the sessions carried by the incoming set are replaced, note by note.
  if (mode === "replace-session") {
    const incomingSessions = new Set<string>();
    for (const note of incoming) {
      if (note.sessionRef !== undefined && note.sessionRef !== "") incomingSessions.add(note.sessionRef);
    }
    if (incomingSessions.size > 0) {
      const kept: Note[] = [];
      for (const note of working) {
        if (note.sessionRef !== undefined && incomingSessions.has(note.sessionRef)) removed += 1;
        else kept.push(note);
      }
      working = kept;
    }
  }

  const positionById = new Map<string, number>();
  const knownIds = new Set<string>();
  working.forEach((note, position) => {
    if (!knownIds.has(note.id)) {
      knownIds.add(note.id);
      positionById.set(note.id, position);
    }
  });

  const conflicts: MergeConflict[] = [];
  const unresolved: MergeConflict[] = [];
  const additions: Note[] = [];
  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const incomingNote of incoming) {
    const position = positionById.get(incomingNote.id);

    if (position === undefined) {
      if (!knownIds.has(incomingNote.id)) {
        knownIds.add(incomingNote.id);
        additions.push(incomingNote);
        added += 1;
      }
      continue;
    }

    const existingNote = working[position];
    if (existingNote === undefined) continue;
    if (contentKey(existingNote) === contentKey(incomingNote)) {
      skipped += 1;
      continue;
    }

    const conflict: MergeConflict = {
      id: incomingNote.id,
      reason: `note ${JSON.stringify(incomingNote.id)} already exists with different content (${divergingFields(existingNote, incomingNote).join(", ") || "unknown fields"})`,
      existingUpdatedAt: existingNote.updatedAt,
      incomingUpdatedAt: incomingNote.updatedAt,
    };
    conflicts.push(conflict);

    if (mode === "merge") {
      // `merge` never overwrites: the conflict is reported, the existing note (and its thread) wins.
      if (onConflict === "keep-incoming") {
        throw new BluepencilValidationError([
          `merge mode never overwrites existing notes: use mode "upsert" with onConflict "keep-incoming" to accept the incoming version of ${JSON.stringify(incomingNote.id)}`,
        ]);
      }
      skipped += 1;
      continue;
    }

    const merged = mergeNoteInto(existingNote, incomingNote);
    if (contentKey(merged) === contentKey(existingNote)) {
      // Append-only: the incoming version adds nothing the existing note does not already have.
      skipped += 1;
      continue;
    }

    if (onConflict === "keep-existing") {
      skipped += 1;
      continue;
    }

    if (onConflict === "keep-incoming") {
      updated += 1;
      working[position] = merged;
      continue;
    }

    // Unresolved conflict: listed, never applied. A dry run only reports, a real import refuses.
    unresolved.push(conflict);
    skipped += 1;
  }

  if (unresolved.length > 0 && !dryRun) {
    throw refusal(unresolved, {
      added,
      updated,
      skipped,
      removed,
      conflicts: unresolved.length,
    });
  }

  return {
    added,
    updated,
    skipped,
    removed,
    conflicts,
    notes: [...working, ...additions],
  };
}
