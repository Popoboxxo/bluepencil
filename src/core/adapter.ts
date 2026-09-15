/**
 * Transport contract for bluepencil note sets — docs/INTERNAL-API.md §1, FR-6.1.
 *
 * The first block is the frozen contract (`Adapter`, `AdapterName`, `AdapterLike`) and is kept
 * exactly as specified there. Everything below it is additive, DOM-free helper logic shared by
 * the store and the built-in adapters: filter, patch and copy semantics must exist exactly once
 * (FR-15.3) and the store needs them for its authoritative in-memory set while the adapters need
 * them for their own backing stores.
 *
 * Nothing in this module touches the DOM, `node:fs` or timers.
 */
import {
  BluepencilValidationError,
  isAuthorType,
  isEnvironment,
  isNoteIntent,
  isNoteStatus,
  isNoteType,
  systemClock,
  type Anchor,
  type CapturedContext,
  type DebugContext,
  type Message,
  type Note,
  type NoteDraft,
  type NoteFilter,
  type NotePatch,
} from "./model";

export interface Adapter {
  readonly name: string;
  list(filter?: NoteFilter): Promise<Note[]>;
  create(draft: NoteDraft): Promise<Note>;
  update(id: string, patch: NotePatch): Promise<Note>;
  remove(id: string): Promise<void>;
  bulkRemove(filter: NoteFilter): Promise<{ removed: number }>;
  exportSession(sessionRef: string): Promise<Note[]>;
  subscribe?(cb: (notes: Note[]) => void): () => void;
}

export type AdapterName = "memory" | "localStorage" | "file" | "http";

export type AdapterLike = Adapter | AdapterName;

/* ------------------------------------------------------------------------------------------------
 * Additive helpers (transport-level note semantics, no I/O)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Patch accepted by the write path. `NotePatch` itself has no thread field, while the HTTP
 * contract documents a message endpoint (ARCHITECTURE §5) — an append therefore travels as an
 * extra, optional `messages` array on the patch. Every field is optional, so a plain `NotePatch`
 * stays valid everywhere and an adapter that only understands `NotePatch` keeps working.
 */
export interface AdapterPatch extends NotePatch {
  /** Messages appended to the existing thread — never replacing it (FR-3.3). */
  messages?: Message[];
}

/** True for plain JSON-style objects (used when reading untrusted/adapter-returned data). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep copy of a note. Adapters hand out copies so that no caller can mutate the stored state
 * through a returned reference (NFR-8: the stored set is only changed by explicit operations).
 */
export function cloneNote(note: Note): Note {
  return {
    ...note,
    anchor: { ...note.anchor },
    context: cloneContext(note.context),
    messages: note.messages.map((message) => ({ ...message })),
    ...(note.debug === undefined ? {} : { debug: { ...note.debug } }),
  };
}

export function cloneNotes(notes: readonly Note[]): Note[] {
  return notes.map(cloneNote);
}

function cloneContext(context: CapturedContext | null): CapturedContext | null {
  if (!context) {
    return null;
  }
  return {
    ...context,
    classes: [...context.classes],
    styles: { ...context.styles },
    box: { ...context.box },
    viewport: { ...context.viewport },
  };
}

/**
 * Filter semantics shared by every adapter (FR-6.1, NFR-11): all given criteria are combined
 * with AND. `includeDone` only narrows the default view — an explicit `status` filter wins over
 * it, so `{ status: "done", includeDone: false }` still returns the done notes.
 */
export function matchesFilter(note: Note, filter?: NoteFilter): boolean {
  if (!filter) {
    return true;
  }
  if (filter.route !== undefined && note.anchor.route !== filter.route) {
    return false;
  }
  if (filter.type !== undefined && note.type !== filter.type) {
    return false;
  }
  if (filter.intent !== undefined && note.intent !== filter.intent) {
    return false;
  }
  if (filter.session !== undefined && note.sessionRef !== filter.session) {
    return false;
  }
  if (filter.source !== undefined && note.source !== filter.source) {
    return false;
  }
  if (filter.environment !== undefined && note.environment !== filter.environment) {
    return false;
  }
  const statuses =
    filter.status === undefined
      ? undefined
      : Array.isArray(filter.status)
        ? filter.status
        : [filter.status];
  if (statuses && !statuses.includes(note.status)) {
    return false;
  }
  if (!statuses && filter.includeDone === false && note.status === "done") {
    return false;
  }
  if (filter.since !== undefined && !isAtOrAfter(note.updatedAt, filter.since)) {
    return false;
  }
  return true;
}

function isAtOrAfter(value: string, since: string): boolean {
  const left = Date.parse(value);
  const right = Date.parse(since);
  if (Number.isNaN(left) || Number.isNaN(right)) {
    return value >= since;
  }
  return left >= right;
}

/**
 * Applies a patch to a note and returns the next version (FR-5.3/5.5). Only the mutable fields
 * of the model are accepted; everything else is preserved. Appended messages bump `updatedAt`
 * to the timestamp of the newest message, mirroring `appendMessage` in the model.
 */
export function applyPatch(note: Note, patch: AdapterPatch, now?: string): Note {
  const issues: string[] = [];
  if (patch.status !== undefined && !isNoteStatus(patch.status)) {
    issues.push("status must be open, done or needs_decision");
  }
  if (patch.intent !== undefined && !isNoteIntent(patch.intent)) {
    issues.push("intent must be implement or feedback");
  }
  if (patch.body !== undefined && (typeof patch.body !== "string" || patch.body.trim() === "")) {
    issues.push("body must be a non-empty string");
  }
  if (patch.ticketRef !== undefined && typeof patch.ticketRef !== "string") {
    issues.push("ticketRef must be a string");
  }
  if (patch.environment !== undefined && !isEnvironment(patch.environment)) {
    issues.push("environment must be dev, staging or live");
  }
  if (issues.length > 0) {
    throw new BluepencilValidationError(issues);
  }

  const next = cloneNote(note);
  if (patch.status !== undefined) {
    next.status = patch.status;
  }
  if (patch.intent !== undefined) {
    next.intent = patch.intent;
  }
  if (patch.body !== undefined) {
    next.body = patch.body;
  }
  if (patch.ticketRef !== undefined) {
    next.ticketRef = patch.ticketRef;
  }
  if (patch.environment !== undefined) {
    next.environment = patch.environment;
  }
  if (patch.anchor !== undefined) {
    next.anchor = { ...patch.anchor };
  }
  if (patch.context !== undefined) {
    next.context = cloneContext(patch.context);
  }
  if (patch.sessionRef !== undefined) {
    next.sessionRef = patch.sessionRef;
  }
  if (patch.messages !== undefined && patch.messages.length > 0) {
    next.messages = [...next.messages, ...patch.messages.map((message) => ({ ...message }))];
  }
  const newest = patch.messages?.[patch.messages.length - 1];
  next.updatedAt = now ?? newest?.ts ?? systemClock.now();
  return next;
}

/**
 * Turns arbitrary data into a note, or `null` when it cannot be one. Used for values coming from
 * a storage blob or a server response: unknown fields are dropped, missing optional fields are
 * filled with model defaults, and only entries without an id are rejected (they could not be
 * addressed at all). This keeps a partially corrupt store readable instead of losing everything
 * (NFR-8).
 */
export function coerceNote(value: unknown): Note | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = value.id;
  if (typeof id !== "string" || id === "") {
    return null;
  }
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : systemClock.now();
  const note: Note = {
    id,
    schemaVersion: typeof value.schemaVersion === "number" ? value.schemaVersion : 1,
    createdAt,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : createdAt,
    type: isNoteType(value.type) ? value.type : "text",
    intent: isNoteIntent(value.intent) ? value.intent : "implement",
    status: isNoteStatus(value.status) ? value.status : "open",
    body: typeof value.body === "string" ? value.body : "",
    author: typeof value.author === "string" ? value.author : "anonymous",
    authorType: isAuthorType(value.authorType) ? value.authorType : "human",
    anchor: coerceAnchor(value.anchor),
    context: coerceContext(value.context),
    messages: coerceMessages(value.messages),
    source: typeof value.source === "string" ? value.source : "ui:human",
    environment: isEnvironment(value.environment) ? value.environment : "dev",
    ...(typeof value.sessionRef === "string" ? { sessionRef: value.sessionRef } : {}),
    ...(typeof value.ticketRef === "string" ? { ticketRef: value.ticketRef } : {}),
    ...(isRecord(value.debug) ? { debug: coerceDebug(value.debug) } : {}),
  };
  return note;
}

function coerceAnchor(value: unknown): Anchor {
  if (!isRecord(value)) {
    return {};
  }
  const anchor: Anchor = {};
  if (typeof value.hook === "string") {
    anchor.hook = value.hook;
  }
  if (typeof value.selector === "string") {
    anchor.selector = value.selector;
  }
  if (typeof value.quote === "string") {
    anchor.quote = value.quote;
  }
  if (typeof value.route === "string") {
    anchor.route = value.route;
  }
  if (value.orphaned === true) {
    anchor.orphaned = true;
  }
  if (typeof value.degraded === "string") {
    anchor.degraded = value.degraded;
  }
  return anchor;
}

function coerceContext(value: unknown): CapturedContext | null {
  if (!isRecord(value)) {
    return null;
  }
  const box = isRecord(value.box) ? value.box : {};
  const viewport = isRecord(value.viewport) ? value.viewport : {};
  return {
    tag: typeof value.tag === "string" ? value.tag : "",
    classes: Array.isArray(value.classes) ? value.classes.filter((c): c is string => typeof c === "string") : [],
    styles: isRecord(value.styles)
      ? Object.fromEntries(
          Object.entries(value.styles).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        )
      : {},
    box: {
      w: typeof box.w === "number" ? box.w : 0,
      h: typeof box.h === "number" ? box.h : 0,
      x: typeof box.x === "number" ? box.x : 0,
      y: typeof box.y === "number" ? box.y : 0,
    },
    scheme: value.scheme === "dark" ? "dark" : "light",
    viewport: {
      w: typeof viewport.w === "number" ? viewport.w : 0,
      h: typeof viewport.h === "number" ? viewport.h : 0,
    },
    ...(typeof value.buildRef === "string" ? { buildRef: value.buildRef } : {}),
  };
}

function coerceMessages(value: unknown): Message[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const messages: Message[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = entry.id;
    if (typeof id !== "string" || id === "") {
      continue;
    }
    messages.push({
      id,
      ts: typeof entry.ts === "string" ? entry.ts : systemClock.now(),
      author: typeof entry.author === "string" ? entry.author : "unknown",
      authorType: isAuthorType(entry.authorType) ? entry.authorType : "human",
      kind: isMessageKind(entry.kind) ? entry.kind : "note",
      text: typeof entry.text === "string" ? entry.text : "",
    });
  }
  return messages;
}

function isMessageKind(value: unknown): value is Message["kind"] {
  return (
    value === "note" ||
    value === "decision_request" ||
    value === "decision" ||
    value === "feedback" ||
    value === "reply"
  );
}

function coerceDebug(value: Record<string, unknown>): DebugContext {
  const debug: DebugContext = {};
  for (const key of ["test", "stack", "log", "commit", "file"] as const) {
    const field = value[key];
    if (typeof field === "string") {
      debug[key] = field;
    }
  }
  return debug;
}
