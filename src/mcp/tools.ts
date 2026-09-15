/**
 * MCP tool implementations (FR-16.1–16.7).
 *
 * These are **thin wrappers** over the headless data library and the store — no separate merge,
 * validation or canonicalisation logic (FR-15.3/16.7, F5/M2): ordering comes from
 * `core/protocol.ts`, filtering from `core/adapter.ts`, merge and validation from `src/data`.
 * The same functions back the UI and the CLI, so `bluepencil merge` and `import_bundle` behave
 * identically for the same input.
 *
 * Safety model:
 *  - **read-only by default**: every write tool returns a clear refusal unless the session was
 *    started with an explicit opt-in (FR-16.2);
 *  - a session is bound to **one store, one app and one environment** (FR-16.3/NFR-18): every list
 *    is filtered to `context.environment`, every read by id compares the note's environment with
 *    the binding and refuses a note of another environment — naming both — and every write does the
 *    same, so a `dev`-bound session can neither see nor mutate a `live` note;
 *  - agent writes carry `source=agent` plus the MCP client name and session id (FR-16.4);
 *  - **a write is only success once it is on disk**: after every mutation the store is reloaded and
 *    the backing medium is read back through {@link McpPersistence.readPersisted}, because a failing
 *    adapter degrades to memory instead of throwing (NFR-8) and would otherwise report a change it
 *    never persisted (F7);
 *  - an **import applies the full merged note** — identity, timestamps, thread, debug, all of it —
 *    through {@link McpPersistence.replaceAll}, never a partial patch (F5/F6/FR-14.3), and a
 *    conflicting import is refused unless the caller resolved it with `on_conflict`, exactly like
 *    the CLI (F10);
 *  - enumerated arguments are validated against the documented sets (F12b) — the JSON schema is a
 *    description for the client, not a validator on the server.
 */
import { canonicalBundle, canonicalNote, serializeCanonical } from "../data/canonical";
import { createBundle, inspectBundle, parseBundle, bundleToJson, type BundleSummary } from "../data/bundle";
import { mergeNotes, type MergeMode, type MergeResult } from "../data/merge";
import { validateNote } from "../data/schema";
import { excludeDone, filterNotes, isRecord, type Adapter } from "../core/adapter";
import { createFileAdapter, type FileAdapterIo } from "../adapters/file";
import { parseNoteSet, serializeNoteSet } from "../adapters/memory";
import { sortForReview, summarize } from "../core/protocol";
import type { Store } from "../core/store";
import {
  BluepencilValidationError,
  MESSAGE_KINDS,
  NOTE_INTENTS,
  NOTE_STATUSES,
  NOTE_TYPES,
  createMessage,
  systemClock,
  type Anchor,
  type Environment,
  type MessageKind,
  type Note,
  type NoteFilter,
  type NoteIntent,
  type NoteStatus,
} from "../core/model";

/** Merge modes the tool accepts (FR-14.3) — the schema and the validator share this list. */
export const MERGE_MODES = ["merge", "upsert", "replace-session"] as const;
/** Conflict policies the tool accepts (FR-14.4) — the schema and the validator share this list. */
export const CONFLICT_POLICIES = ["fail", "keep-incoming", "keep-existing"] as const;
/** Output formats of `list_notes` and `export_bundle`. */
export const FORMATS = ["json", "markdown"] as const;
/**
 * Message kinds this server may append. `decision` is missing on purpose: a decision is a human
 * act (PROTOCOL §6.1), so the tool never advertises it and refuses it explicitly.
 */
export const AGENT_MESSAGE_KINDS: readonly MessageKind[] = MESSAGE_KINDS.filter(
  (kind) => kind !== "decision",
);

export type ConflictPolicy = (typeof CONFLICT_POLICIES)[number];

export interface ToolContext {
  store: Store;
  /** Explicit write opt-in for this session (FR-16.2). */
  allowWrite: boolean;
  /** Environment this session is bound to (FR-16.3). */
  environment: Environment;
  appName: string;
  clientName: string;
  sessionId: string;
  now?: () => string;
  /** Host hooks the frozen `Store`/`Adapter` contracts cannot express (F5/F6/F7). */
  persistence: McpPersistence;
}

/** Host I/O of the session's store file; `read()` returns `null` while the file does not exist. */
export interface StoreFileIo {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

/**
 * What the MCP layer needs from its host beyond the frozen `Store` contract.
 *
 * `Store.create`/`update` derive `createdAt`, `updatedAt` and `schemaVersion` from the call site
 * (`createNote`, `applyPatch`) and cannot carry an existing thread, so the frozen contract cannot
 * express "this note, exactly". An import must be able to (FR-14.3/F5/F6): the incoming note
 * arrives with its identity, its timestamps, its refs, its thread and its debug payload.
 * `replaceAll` is that one missing capability and nothing more — it writes the whole set through
 * the adapter's **own** codec, so the stored file keeps exactly one format (FR-6.5/FR-15.3).
 *
 * The two read-back hooks exist because a failed write is invisible otherwise: the JSON adapter
 * degrades to memory and keeps the change there (NFR-8), so only the medium itself can tell
 * whether the change arrived (F7).
 */
export interface McpPersistence {
  /** Replaces the persisted set with exactly these notes (canonical form, NFR-17). */
  replaceAll(notes: readonly Note[]): Promise<void>;
  /** Reads the set back from the backing medium; throws when it is unreadable. */
  readPersisted(): Promise<Note[]>;
  /** The underlying I/O error of the last failed write, or `null` after a successful one (F7). */
  lastWriteError(): unknown;
}

/**
 * Builds the store adapter and the persistence hooks of one session (F5/F6/F7).
 *
 * The host supplies only the medium (a file, a string in a test); everything else is the adapter's
 * own read-modify-write engine, so there is no second implementation of the stored shape.
 */
export function createStorePersistence(io: StoreFileIo): {
  adapter: Adapter;
  persistence: McpPersistence;
} {
  let lastWriteError: unknown = null;

  /** Every write of this session goes through here, so a failure is remembered, never swallowed. */
  const write = async (text: string): Promise<void> => {
    try {
      await io.write(text);
      lastWriteError = null;
    } catch (error) {
      lastWriteError = error;
      throw error;
    }
  };

  const fileIo: FileAdapterIo = { read: () => io.read(), write: (text) => write(text) };

  return {
    adapter: createFileAdapter(fileIo),
    persistence: {
      async replaceAll(notes: readonly Note[]): Promise<void> {
        // Canonical form: the stored blob has the same shape an export produces (NFR-17), and every
        // field of the note survives — this is the point of the whole capability (F5/F6).
        await write(serializeNoteSet(notes.map((note) => canonicalNote(note))));
      },
      readPersisted: async (): Promise<Note[]> => parseNoteSet(await io.read()),
      lastWriteError: (): unknown => lastWriteError,
    },
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Read-only tools are always available; write tools need the opt-in. */
  write: boolean;
}

export interface ToolContent {
  type: "text";
  text: string;
}

export interface ToolResponse {
  content: ToolContent[];
  isError?: boolean;
}

const READ_ONLY_NOTE = "Read-only session: writes are disabled (FR-16.2).";

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "list_notes",
    description:
      "List the notes of this session's store, newest review order (open decisions first, then " +
      "feedback-only, then the rest). Only notes of the session's environment are returned; done " +
      "notes are hidden unless include_done is true.",
    write: false,
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: [...NOTE_STATUSES] },
        intent: { type: "string", enum: [...NOTE_INTENTS] },
        type: { type: "string", enum: [...NOTE_TYPES] },
        route: { type: "string" },
        session: { type: "string" },
        include_done: { type: "boolean", default: false },
        format: { type: "string", enum: [...FORMATS], default: "json" },
      },
    },
  },
  {
    name: "get_note",
    description: "Fetch exactly one note with its anchor, captured context and full thread.",
    write: false,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "create_note",
    description:
      "Create a note in the bound store and environment (source=agent). Anchors may use a host hook " +
      "(data-bluepencil/data-testid), a CSS path or a text quote.",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string" },
        type: { type: "string", enum: [...NOTE_TYPES], default: "text" },
        intent: { type: "string", enum: [...NOTE_INTENTS], default: "implement" },
        hook: { type: "string" },
        selector: { type: "string" },
        quote: { type: "string" },
        route: { type: "string" },
        session: { type: "string" },
        ticket_ref: { type: "string" },
      },
      required: ["body"],
    },
  },
  {
    name: "reply",
    description:
      "Append a message to a note's thread (append-only). kind=reply reports work that was " +
      "actually done; kind=decision_request asks the human and sets status=needs_decision; " +
      "kind=feedback answers an intent=feedback note without changing anything.",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        text: { type: "string" },
        kind: { type: "string", enum: [...AGENT_MESSAGE_KINDS], default: "reply" },
        set_done: { type: "boolean", default: false },
      },
      required: ["id", "text"],
    },
  },
  {
    name: "set_status",
    description:
      "Set a note's status. Refused for `done` while the note waits for a decision; refused for " +
      "`done` on intent=feedback notes (PROTOCOL §6) — the human decides those.",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: [...NOTE_STATUSES] },
      },
      required: ["id", "status"],
    },
  },
  {
    name: "set_intent",
    description: "Switch a note between implement and feedback.",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        intent: { type: "string", enum: [...NOTE_INTENTS] },
      },
      required: ["id", "intent"],
    },
  },
  {
    name: "export_bundle",
    description:
      "Export the current set as a portable bundle (JSON) or as the agent-facing Markdown export " +
      "whose exception sections come first.",
    write: false,
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: [...FORMATS], default: "markdown" },
        include_done: { type: "boolean", default: true },
      },
    },
  },
  {
    name: "inspect_bundle",
    description: "Summarise a bundle (sessions, counts, environments, routes) without writing anything.",
    write: false,
    inputSchema: {
      type: "object",
      properties: { bundle: { type: ["string", "object"] } },
      required: ["bundle"],
    },
  },
  {
    name: "import_bundle",
    description:
      "Import a bundle with mode merge (idempotent, default), upsert or replace-session. Conflicts " +
      "are reported and never resolved silently — the import is refused unless on_conflict says " +
      "which side wins (F10, same rule as `bluepencil merge`); an environment mismatch is refused " +
      "unless allow_env_mismatch is set.",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        bundle: { type: ["string", "object"] },
        mode: { type: "string", enum: [...MERGE_MODES], default: "merge" },
        dry_run: { type: "boolean", default: true },
        on_conflict: { type: "string", enum: [...CONFLICT_POLICIES] },
        allow_env_mismatch: { type: "boolean", default: false },
      },
      required: ["bundle"],
    },
  },
];

export function jsonResponse(value: unknown, isError = false): ToolResponse {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

export function errorResponse(message: string): ToolResponse {
  return { content: [{ type: "text", text: `error: ${message}` }], isError: true };
}

/* ------------------------------------------------------------------------------------------------
 * Argument handling
 * ---------------------------------------------------------------------------------------------- */

function requireWrite(context: ToolContext): ToolResponse | null {
  return context.allowWrite ? null : errorResponse(READ_ONLY_NOTE);
}

function nowIso(context: ToolContext): string {
  return (context.now ?? systemClock.now)();
}

function agentAuthor(context: ToolContext): string {
  return `${context.clientName} (mcp:${context.sessionId})`;
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return error === undefined || error === null ? "unknown error" : String(error);
}

/** A value, or the reason it is not one of the allowed values (F12b: schema is not validation). */
interface EnumArgument<T extends string> {
  value: T | undefined;
  issue: string | null;
}

/** Reads an enumerated argument; absent is `undefined` without an issue, anything else is checked. */
function readEnumArgument<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): EnumArgument<T> {
  if (value === undefined || value === null) {
    return { value: undefined, issue: null };
  }
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return { value: value as T, issue: null };
  }
  return {
    value: undefined,
    issue: `${name} must be one of ${allowed.join(", ")} (got ${JSON.stringify(value)})`,
  };
}

/**
 * The filter of `list_notes`. The session's environment is **always** part of it: a filter without
 * the binding is how a `dev` session ended up listing `live` notes (F8/B2, FR-16.3/NFR-18).
 */
function toFilter(context: ToolContext, args: Record<string, unknown>): { filter: NoteFilter } | { issue: string } {
  const status = readEnumArgument(args.status, NOTE_STATUSES, "status");
  if (status.issue) return { issue: status.issue };
  const intent = readEnumArgument(args.intent, NOTE_INTENTS, "intent");
  if (intent.issue) return { issue: intent.issue };
  const type = readEnumArgument(args.type, NOTE_TYPES, "type");
  if (type.issue) return { issue: type.issue };

  return {
    filter: {
      environment: context.environment,
      ...(status.value !== undefined ? { status: status.value } : {}),
      ...(intent.value !== undefined ? { intent: intent.value } : {}),
      ...(type.value !== undefined ? { type: type.value } : {}),
      ...(typeof args.route === "string" ? { route: args.route } : {}),
      ...(typeof args.session === "string" ? { session: args.session } : {}),
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * Environment binding (FR-16.3, NFR-18) — the read path is guarded exactly like the write path
 * ---------------------------------------------------------------------------------------------- */

/** A note that passed the environment guard, or the refusal to return instead. */
type NoteLookup = { note: Note } | { refusal: ToolResponse };

/**
 * Refuses a note of another environment, naming both environments and the rule. Applied to reads as
 * well as writes: `get_note` on a `live` note from a `dev`-bound session is the same violation as
 * appending to it (FR-16.3/NFR-18).
 */
function environmentRefusal(context: ToolContext, note: Note, action: string): ToolResponse | null {
  if (note.environment === context.environment) {
    return null;
  }
  return errorResponse(
    `note ${note.id} belongs to environment "${note.environment}" but this session is bound to ` +
      `"${context.environment}": ${action} is refused (FR-16.3 — a session may only read and write ` +
      `notes of its own environment)`,
  );
}

/**
 * Loads one note through the store's adapter (not through the store's optimistic memory, which can
 * lag behind a change made outside `create`/`update` — F5) and applies the environment guard.
 */
async function loadBoundNote(context: ToolContext, id: string, action: string): Promise<NoteLookup> {
  const notes = await context.store.list();
  const note = notes.find((candidate) => candidate.id === id);
  if (!note) {
    return { refusal: errorResponse(`note ${id} not found`) };
  }
  const refusal = environmentRefusal(context, note, action);
  return refusal ? { refusal } : { note };
}

/* ------------------------------------------------------------------------------------------------
 * Persistence confirmation (F7)
 * ---------------------------------------------------------------------------------------------- */

/** Fields compared when a write is confirmed — every field of the model, nothing left out (F5/F6). */
const COMPARED_FIELDS = [
  "id",
  "schemaVersion",
  "createdAt",
  "updatedAt",
  "sessionRef",
  "type",
  "intent",
  "status",
  "body",
  "author",
  "authorType",
  "anchor",
  "context",
  "messages",
  "source",
  "environment",
  "ticketRef",
  "debug",
] as const;

/** Names of the fields in which two notes differ — the diagnostic text of a failed write. */
function noteDivergences(expected: Note, actual: Note): string[] {
  const left = canonicalNote(expected);
  const right = canonicalNote(actual);
  return COMPARED_FIELDS.filter(
    (field) => serializeCanonical(left[field]) !== serializeCanonical(right[field]),
  );
}

/**
 * Compares the set a write *should* have produced with the set that is actually persisted and
 * returns one issue per divergence (F5/F6/F7). Pure, so it is unit-tested without a process.
 */
export function compareNoteSets(expected: readonly Note[], persisted: readonly Note[]): string[] {
  const issues: string[] = [];
  const byId = new Map(persisted.map((note) => [note.id, note]));
  for (const note of expected) {
    const actual = byId.get(note.id);
    if (!actual) {
      issues.push(`note ${note.id} is missing from the persisted set`);
      continue;
    }
    const diverging = noteDivergences(note, actual);
    if (diverging.length > 0) {
      issues.push(`note ${note.id} was persisted differently (${diverging.join(", ")})`);
    }
  }
  const expectedIds = new Set(expected.map((note) => note.id));
  for (const note of persisted) {
    if (!expectedIds.has(note.id)) {
      issues.push(`note ${note.id} is still in the persisted set`);
    }
  }
  return issues;
}

/** The isError result of a write that never reached the medium, naming the underlying error. */
function notPersisted(context: ToolContext, action: string, reason: string): ToolResponse {
  const cause = context.persistence.lastWriteError();
  const detail =
    cause === null || cause === undefined || reason.includes(errorText(cause))
      ? ""
      : ` (underlying error: ${errorText(cause)})`;
  return errorResponse(`${action} did not persist — the store was not changed: ${reason}${detail}`);
}

/**
 * Runs a mutation and turns a rejection into the "did not persist" answer (F7). A failing write
 * reaches the tool in one of two ways — the adapter rejects the mutation (file/http) or it keeps
 * the change in memory only (the `degrade` policy of the localStorage path) — and both must end in
 * the same, actionable answer instead of a bare I/O message or, worse, a reported success.
 */
async function attemptWrite<T>(
  context: ToolContext,
  action: string,
  mutate: () => Promise<T>,
): Promise<{ value: T } | { failure: ToolResponse }> {
  try {
    return { value: await mutate() };
  } catch (error) {
    return { failure: notPersisted(context, action, errorText(error)) };
  }
}

/**
 * Confirms a mutation really reached the backing medium (F7): the store is reloaded from the
 * adapter and the persisted set is read back from the medium itself. Returns `null` when the write
 * is on disk, an isError response otherwise — a change that only lives in the adapter's fallback
 * memory is never reported as a success.
 */
async function confirmWrite(
  context: ToolContext,
  action: string,
  expected: readonly Note[],
): Promise<ToolResponse | null> {
  try {
    await context.store.reload();
    const persisted = await context.persistence.readPersisted();
    const issues = compareNoteSets(expected, persisted);
    return issues.length === 0 ? null : notPersisted(context, action, issues.join("; "));
  } catch (error) {
    return notPersisted(context, action, errorText(error));
  }
}

/* ------------------------------------------------------------------------------------------------
 * Startup validation (F9)
 * ---------------------------------------------------------------------------------------------- */

/** The note entries of a stored blob (`{ version, notes }`) or of a bare note array. */
function storedNoteEntries(text: string): unknown[] {
  const parsed = JSON.parse(text) as unknown;
  if (Array.isArray(parsed)) {
    return parsed;
  }
  return isRecord(parsed) && Array.isArray(parsed.notes) ? parsed.notes : [];
}

/**
 * Validates a store file before the server starts serving (F9). Returns `null` when the file is a
 * valid note set — or `null` for `text === null`, the documented empty start — and the reason
 * otherwise, so that a corrupt file can never be served as "no notes": a client cannot tell those
 * two apart, and "my notes are gone" is the worst possible answer to a typo.
 *
 * The shape check reuses the adapter's own codec (FR-6.5); the field check reuses the shared note
 * schema (FR-15.3).
 */
export function validateStoredNoteSet(text: string | null): string | null {
  if (text === null) {
    return null;
  }
  try {
    parseNoteSet(text);
  } catch (error) {
    return error instanceof BluepencilValidationError ? error.issues.join("; ") : errorText(error);
  }
  const entries = storedNoteEntries(text);
  for (const [index, entry] of entries.entries()) {
    const issues = validateNote(entry);
    if (issues.length > 0) {
      return `notes[${index}]: ${issues.join("; ")}`;
    }
  }
  return null;
}

/* ------------------------------------------------------------------------------------------------
 * Tools
 * ---------------------------------------------------------------------------------------------- */

export async function callTool(
  context: ToolContext,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResponse> {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name);
  if (!definition) {
    return errorResponse(`unknown tool "${name}"`);
  }

  switch (name) {
    case "list_notes": {
      const built = toFilter(context, args);
      if ("issue" in built) {
        return errorResponse(built.issue);
      }
      const format = readEnumArgument(args.format, FORMATS, "format");
      if (format.issue) {
        return errorResponse(format.issue);
      }
      const includeDone = args.include_done === true;
      // One read path for every list: the shared filter (FR-15.3) including the session's
      // environment (FR-16.3), the shared done-rule and the shared review order (M2/FR-16.7).
      const all = await context.store.list();
      const matching = filterNotes(all, built.filter);
      const ordered = sortForReview(includeDone ? matching : excludeDone(matching));
      if (format.value === "markdown") {
        const lines = ordered.map((note) => `- ${summarize(note)}`);
        return {
          content: [
            {
              type: "text",
              text: [
                `# ${context.appName} — ${ordered.length} note(s) [env: ${context.environment}]`,
                "",
                ...(lines.length > 0 ? lines : ["(no notes)"]),
              ].join("\n"),
            },
          ],
        };
      }
      return jsonResponse({
        environment: context.environment,
        app: context.appName,
        count: ordered.length,
        notes: ordered.map(canonicalNote),
      });
    }

    case "get_note": {
      const lookup = await loadBoundNote(context, String(args.id ?? ""), "reading the note");
      if ("refusal" in lookup) {
        return lookup.refusal;
      }
      return jsonResponse(canonicalNote(lookup.note));
    }

    case "create_note": {
      const refusal = requireWrite(context);
      if (refusal) return refusal;
      const type = readEnumArgument(args.type, NOTE_TYPES, "type");
      if (type.issue) {
        return errorResponse(type.issue);
      }
      const intent = readEnumArgument(args.intent, NOTE_INTENTS, "intent");
      if (intent.issue) {
        return errorResponse(intent.issue);
      }
      const body = String(args.body ?? "").trim();
      if (body === "") {
        return errorResponse("body must not be empty");
      }
      const anchor: Anchor = {};
      if (typeof args.hook === "string" && args.hook) anchor.hook = args.hook;
      if (typeof args.selector === "string" && args.selector) anchor.selector = args.selector;
      if (typeof args.quote === "string" && args.quote) anchor.quote = args.quote;
      if (typeof args.route === "string" && args.route) anchor.route = args.route;
      if (!anchor.hook && !anchor.selector && !anchor.quote) {
        return errorResponse("an anchor needs at least one of hook, selector or quote");
      }
      const before = await context.store.list();
      const attempt = await attemptWrite(context, "create_note", () =>
        context.store.create({
          type: type.value ?? "text",
          body,
          anchor,
          intent: intent.value ?? "implement",
          author: agentAuthor(context),
          authorType: "agent",
          source: "agent",
          // The note is born in the session's environment, never in another one (FR-16.3).
          environment: context.environment,
          ...(typeof args.session === "string" ? { sessionRef: args.session } : {}),
          ...(typeof args.ticket_ref === "string" ? { ticketRef: args.ticket_ref } : {}),
        }),
      );
      if ("failure" in attempt) return attempt.failure;
      const created = attempt.value;
      const failure = await confirmWrite(context, `create_note ${created.id}`, [...before, created]);
      if (failure) return failure;
      return jsonResponse({ created: canonicalNote(created) });
    }

    case "reply": {
      const refusal = requireWrite(context);
      if (refusal) return refusal;
      const id = String(args.id ?? "");
      if (args.kind === "decision") {
        return errorResponse(
          "a decision must come from a human (PROTOCOL §6.1) — use kind=decision_request and let the human answer",
        );
      }
      const kind = readEnumArgument(args.kind, AGENT_MESSAGE_KINDS, "kind");
      if (kind.issue) {
        return errorResponse(kind.issue);
      }
      const text = String(args.text ?? "");
      if (text.trim() === "") {
        return errorResponse("text must not be empty");
      }
      const lookup = await loadBoundNote(context, id, "replying to the note");
      if ("refusal" in lookup) {
        return lookup.refusal;
      }
      const note = lookup.note;
      const messageKind: MessageKind = kind.value ?? "reply";
      // Every refusal comes before the first write: an answer that is not allowed must not append a
      // message either (PROTOCOL §4.5/§6.2/§6.3).
      if (messageKind !== "decision_request" && args.set_done === true) {
        if (note.intent === "feedback") {
          return errorResponse("intent=feedback notes are not set to done by an agent (PROTOCOL §4.5/§6.2)");
        }
        if (note.status === "needs_decision") {
          return errorResponse("refusing to mark a pending decision as done (PROTOCOL §6.3)");
        }
      }
      const before = await context.store.list();
      const attempt = await attemptWrite(context, `reply to ${id}`, async () => {
        const message = createMessage({
          text,
          kind: messageKind,
          author: agentAuthor(context),
          authorType: "agent",
          now: nowIso(context),
        });
        let updated = await context.store.addMessage(id, message);
        if (messageKind === "decision_request") {
          updated = await context.store.setStatus(id, "needs_decision");
        } else if (args.set_done === true) {
          updated = await context.store.setStatus(id, "done");
        }
        return updated;
      });
      if ("failure" in attempt) return attempt.failure;
      const updated = attempt.value;
      const expected = before.map((candidate) => (candidate.id === updated.id ? updated : candidate));
      const failure = await confirmWrite(context, `reply to ${id}`, expected);
      if (failure) return failure;
      return jsonResponse({ note: canonicalNote(updated) });
    }

    case "set_status": {
      const refusal = requireWrite(context);
      if (refusal) return refusal;
      const id = String(args.id ?? "");
      const status = readEnumArgument(args.status, NOTE_STATUSES, "status");
      if (status.issue) {
        return errorResponse(status.issue);
      }
      const wanted: NoteStatus | undefined = status.value;
      if (wanted === undefined) {
        return errorResponse(`status must be one of ${NOTE_STATUSES.join(", ")}`);
      }
      const lookup = await loadBoundNote(context, id, "setting the status");
      if ("refusal" in lookup) {
        return lookup.refusal;
      }
      if (wanted === "done") {
        if (lookup.note.status === "needs_decision") {
          return errorResponse("refusing to mark a pending decision as done (PROTOCOL §6.3)");
        }
        if (lookup.note.intent === "feedback") {
          return errorResponse("intent=feedback notes are decided by the human (PROTOCOL §6.2)");
        }
      }
      const before = await context.store.list();
      const attempt = await attemptWrite(context, `set_status on ${id}`, () => context.store.setStatus(id, wanted));
      if ("failure" in attempt) return attempt.failure;
      const updated = attempt.value;
      const expected = before.map((candidate) => (candidate.id === updated.id ? updated : candidate));
      const failure = await confirmWrite(context, `set_status on ${id}`, expected);
      if (failure) return failure;
      return jsonResponse({ note: canonicalNote(updated) });
    }

    case "set_intent": {
      const refusal = requireWrite(context);
      if (refusal) return refusal;
      const id = String(args.id ?? "");
      const intent = readEnumArgument(args.intent, NOTE_INTENTS, "intent");
      if (intent.issue) {
        return errorResponse(intent.issue);
      }
      const wanted: NoteIntent | undefined = intent.value;
      if (wanted === undefined) {
        return errorResponse(`intent must be one of ${NOTE_INTENTS.join(", ")}`);
      }
      const lookup = await loadBoundNote(context, id, "changing the intent");
      if ("refusal" in lookup) {
        return lookup.refusal;
      }
      const before = await context.store.list();
      const attempt = await attemptWrite(context, `set_intent on ${id}`, () => context.store.setIntent(id, wanted));
      if ("failure" in attempt) return attempt.failure;
      const updated = attempt.value;
      const expected = before.map((candidate) => (candidate.id === updated.id ? updated : candidate));
      const failure = await confirmWrite(context, `set_intent on ${id}`, expected);
      if (failure) return failure;
      return jsonResponse({ note: canonicalNote(updated) });
    }

    case "export_bundle": {
      const format = readEnumArgument(args.format, FORMATS, "format");
      if (format.issue) {
        return errorResponse(format.issue);
      }
      const includeDone = args.include_done !== false;
      const scoped = filterNotes(await context.store.list(), { environment: context.environment });
      const selected = includeDone ? scoped : excludeDone(scoped);
      if (format.value === "json") {
        const bundle = createBundle(selected, {
          environment: context.environment,
          exportedBy: agentAuthor(context),
          app: { name: context.appName },
          now: nowIso(context),
        });
        return { content: [{ type: "text", text: bundleToJson(bundle) }] };
      }
      const { toMarkdown } = await import("../core/export/markdown");
      return {
        content: [
          { type: "text", text: toMarkdown(selected, { includeDone, title: `${context.appName} review notes` }) },
        ],
      };
    }

    case "inspect_bundle": {
      const parsed = parseBundleInput(args.bundle);
      if (typeof parsed === "string") {
        return errorResponse(parsed);
      }
      return jsonResponse(summaryWithEnvironment(parsed, context));
    }

    case "import_bundle": {
      const refusal = requireWrite(context);
      if (refusal) return refusal;

      // F12b: a bogus enum value must never be echoed back and treated as the default. Both values
      // are validated before the bundle is even looked at, so a bad call names the allowed set
      // instead of failing for an unrelated reason.
      const mode = readEnumArgument(args.mode, MERGE_MODES, "mode");
      if (mode.issue) {
        return errorResponse(mode.issue);
      }
      const onConflict = readEnumArgument(args.on_conflict, CONFLICT_POLICIES, "on_conflict");
      if (onConflict.issue) {
        return errorResponse(onConflict.issue);
      }
      const parsed = parseBundleInput(args.bundle);
      if (typeof parsed === "string") {
        return errorResponse(parsed);
      }
      const bundle = parsed;

      const policy: ConflictPolicy | undefined =
        onConflict.value === "keep-incoming" || onConflict.value === "keep-existing"
          ? onConflict.value
          : undefined;
      const modeValue: MergeMode = mode.value ?? "merge";
      const dryRun = args.dry_run !== false;

      if (bundle.environment !== context.environment && args.allow_env_mismatch !== true) {
        return errorResponse(
          `bundle is tagged "${bundle.environment}" but this session is bound to "${context.environment}" ` +
            `— pass allow_env_mismatch to override deliberately (NFR-18)`,
        );
      }

      const existing = await context.store.list();
      let result: MergeResult;
      try {
        result = mergeNotes(existing, bundle.notes, {
          mode: modeValue,
          dryRun,
          allowEnvMismatch: args.allow_env_mismatch === true,
          targetEnvironment: context.environment,
          ...(policy !== undefined ? { onConflict: policy } : {}),
        });
      } catch (error) {
        return errorResponse(errorText(error));
      }

      const report = {
        mode: modeValue,
        dry_run: dryRun,
        added: result.added,
        updated: result.updated,
        skipped: result.skipped,
        removed: result.removed,
        conflicts: result.conflicts,
      };

      // F10, CLI parity: `bluepencil merge` reports the conflicts and exits 2 without writing. An
      // unresolved conflict is therefore an error here too — and nothing is persisted either way,
      // because `dry_run` is the default.
      if (result.conflicts.length > 0 && policy === undefined) {
        return jsonResponse(
          {
            ...report,
            refused:
              "unresolved conflict(s) — nothing was written; pass on_conflict keep-incoming or keep-existing to resolve them",
          },
          true,
        );
      }

      const resolution =
        policy !== undefined && result.conflicts.length > 0
          ? { conflicts_resolved: result.conflicts.length, resolution: policy }
          : {};

      if (dryRun) {
        return jsonResponse({ ...report, ...resolution });
      }

      // Write nothing when there is nothing to write: an idempotent import leaves the store file
      // untouched, so an unchanged note keeps its bytes as well as its fields (F6, NFR-10).
      if (result.added + result.updated + result.removed === 0) {
        return jsonResponse({ ...report, ...resolution, written: false });
      }

      try {
        // Removals go through the store (it owns the authoritative set); everything else is one
        // whole-set write of the exact merged notes — full notes, never partial patches (F5/F6).
        const keepIds = new Set(result.notes.map((note) => note.id));
        for (const note of existing) {
          if (!keepIds.has(note.id)) {
            await context.store.remove(note.id);
          }
        }
      } catch (error) {
        return notPersisted(context, `import of ${result.notes.length} note(s)`, errorText(error));
      }
      const attempt = await attemptWrite(context, `import of ${result.notes.length} note(s)`, () =>
        context.persistence.replaceAll(result.notes),
      );
      if ("failure" in attempt) return attempt.failure;
      const failure = await confirmWrite(
        context,
        `import of ${result.notes.length} note(s)`,
        result.notes,
      );
      if (failure) return failure;
      return jsonResponse({ ...report, ...resolution, written: true });
    }

    default:
      return errorResponse(`tool "${name}" is not implemented`);
  }
}

function summaryWithEnvironment(bundle: ReturnType<typeof parseBundle>, context: ToolContext): BundleSummary & { targetEnvironment: string; environmentMatches: boolean } {
  const summary = inspectBundle(bundle);
  return {
    ...summary,
    targetEnvironment: context.environment,
    environmentMatches: bundle.environment === context.environment,
  };
}

function parseBundleInput(input: unknown): ReturnType<typeof parseBundle> | string {
  try {
    if (typeof input === "string") {
      return parseBundle(input);
    }
    if (input && typeof input === "object") {
      return parseBundle(JSON.stringify(input));
    }
    return "bundle must be a JSON string or an object";
  } catch (error) {
    if (error instanceof BluepencilValidationError) {
      return error.issues.join("; ");
    }
    return errorText(error);
  }
}

/** Resources are read without tools so a host can fetch them directly (FR-16.5). */
export async function readResource(
  context: ToolContext,
  uri: string,
): Promise<{ uri: string; mimeType: string; text: string } | null> {
  // Resources obey the same environment binding as the tools (FR-16.3): a resource must never be
  // the side door that hands a host another environment's notes.
  const notes = filterNotes(await context.store.list(), { environment: context.environment });
  switch (uri) {
    case "bluepencil://notes": {
      const { toMarkdown } = await import("../core/export/markdown");
      return {
        uri,
        mimeType: "text/markdown",
        text: toMarkdown(notes, { includeDone: true, title: `${context.appName} review notes` }),
      };
    }
    case "bluepencil://notes.json":
      return { uri, mimeType: "application/json", text: JSON.stringify(notes.map(canonicalNote), null, 2) };
    case "bluepencil://bundle": {
      const bundle = createBundle(notes, {
        environment: context.environment,
        exportedBy: agentAuthor(context),
        app: { name: context.appName },
        now: nowIso(context),
      });
      return { uri, mimeType: "application/json", text: bundleToJson(bundle) };
    }
    default:
      return null;
  }
}

export function listResources(): Array<{ uri: string; name: string; mimeType: string }> {
  return [
    { uri: "bluepencil://notes", name: "Review notes (Markdown)", mimeType: "text/markdown" },
    { uri: "bluepencil://notes.json", name: "Review notes (JSON)", mimeType: "application/json" },
    { uri: "bluepencil://bundle", name: "Portable bundle", mimeType: "application/json" },
  ];
}

export function listPrompts(): Array<{ name: string; description: string }> {
  return [
    {
      name: "work-off-open-notes",
      description: "Work list of implementable notes, with the exception sections first (PROTOCOL §7).",
    },
    {
      name: "summarise-decisions",
      description: "Summarise every note that waits for a human decision, with the recommendation.",
    },
  ];
}

export function getPrompt(name: string): ToolResponse {
  switch (name) {
    case "work-off-open-notes":
      return {
        content: [
          {
            type: "text",
            text: [
              "Read the resource bluepencil://notes first.",
              "1. Read the sections '⚠ open decisions' and '💬 feedback only' before anything else — they constrain the rest.",
              "2. Implement only notes with intent=implement and status=open.",
              "3. For every note you implemented: reply in that note's thread (kind=reply: what changed, where, deviations) and set status=done.",
              "4. For intent=feedback notes: answer with kind=feedback and change nothing, leave the status alone.",
              "5. If something is unclear: kind=decision_request with lettered options and a recommendation, status=needs_decision, then stop and wait.",
              "6. Never invent a human decision and never mark a pending decision as done.",
            ].join("\n"),
          },
        ],
      };
    case "summarise-decisions":
      return {
        content: [
          {
            type: "text",
            text: "Call list_notes with status=needs_decision, then list every note with its id, body, options and recommendation in one table. Do not decide for the human.",
          },
        ],
      };
    default:
      return errorResponse(`unknown prompt "${name}"`);
  }
}

export { createBundle, canonicalBundle };
