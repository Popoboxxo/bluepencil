/**
 * Core data model of bluepencil — the single source of truth for every note.
 *
 * This module is intentionally DOM-free and dependency-free: the UI, the headless data
 * library, the CLI and the MCP server all build on exactly these types (FR-15.3).
 *
 * Requirement references:
 *  - FR-3.1/3.2/3.3 note model, vocabulary and append-only thread
 *  - FR-2.x      anchor structure and orphaning
 *  - FR-5.x      intent/status/thread (see docs/PROTOCOL.md)
 *  - FR-13.3/13.5/13.6 source, debug context, file references
 *  - FR-14.1     environment tag
 *  - FR-3.5      schema version
 */

/** Schema version carried by every note and every bundle (FR-3.5, NFR-9). */
export const SCHEMA_VERSION = 1;

/** Marker for a portable export file (FR-14.2). */
export const BUNDLE_KIND = "bluepencil.bundle";

/** Environment a fresh store/note defaults to when the host does not say otherwise (FR-14.1). */
export const DEFAULT_ENVIRONMENT: Environment = "dev";

export const NOTE_TYPES = ["text", "design"] as const;
export const NOTE_INTENTS = ["implement", "feedback"] as const;
export const NOTE_STATUSES = ["open", "done", "needs_decision"] as const;
export const AUTHOR_TYPES = ["human", "agent"] as const;
export const MESSAGE_KINDS = [
  "note",
  "decision_request",
  "decision",
  "feedback",
  "reply",
] as const;
export const ENVIRONMENTS = ["dev", "staging", "live"] as const;

/** What a note is about: content/wording vs. appearance/layout (FR-3.2). */
export type NoteType = (typeof NOTE_TYPES)[number];
/** What should happen with the note. `feedback` means "assessment only" (FR-5.1). */
export type NoteIntent = (typeof NOTE_INTENTS)[number];
/** Where the note stands right now. `needs_decision` blocks implementation (FR-5.4). */
export type NoteStatus = (typeof NOTE_STATUSES)[number];
export type AuthorType = (typeof AUTHOR_TYPES)[number];
export type MessageKind = (typeof MESSAGE_KINDS)[number];
/** Environment a note belongs to; imports never mix them by accident (NFR-18). */
export type Environment = (typeof ENVIRONMENTS)[number];

/**
 * Where a note came from (FR-13.3). Machine sources must stay distinguishable
 * from human ones (docs/PROTOCOL.md §8).
 */
export type NoteSource =
  | "ui:human"
  | "agent"
  | "tool:test-runner"
  | "tool:build"
  | "cli:import"
  | (string & {});

/**
 * Kinds of container a target can live in when it is only visible in a transient UI state
 * (issue #20): an inactive tab, a closed dialog, a closed popover or a collapsed menu.
 */
export const REVEAL_CONTAINERS = ["tabpanel", "dialog", "popover", "menu", "other"] as const;

/** Kind of transient container — see `REVEAL_CONTAINERS`. */
export type RevealContainer = (typeof REVEAL_CONTAINERS)[number];

/**
 * How to bring a target back that is only reachable through a transient UI state (issue #20).
 *
 * Such a target cannot be described by the anchor alone: in the default state of the very route it
 * was captured on it is not in the DOM at all, so hook, selector *and* quote all fail and the note
 * reads as orphaned although nothing is wrong with it. The hint records the container's kind and the
 * trigger that opens it, so a jump can activate the trigger first and a human is told which view to
 * open — without ever inventing a resolution that does not exist.
 */
export interface RevealHint {
  /** Kind of container that has to be entered first. */
  container: RevealContainer;
  /** Hook value of the trigger element (preferred over the path, FR-2.1). */
  triggerHook?: string;
  /** CSS path of the trigger, same encoding as `Anchor.selector`. */
  triggerSelector?: string;
  /** Human-readable name of the trigger, or of the container when no trigger could be derived. */
  triggerLabel?: string;
}

/** Resolution order: host hook → stored CSS path → text quote (FR-2.1). */
export interface Anchor {
  /** Value of `data-bluepencil` / `data-testid` (FR-2.1, D6). */
  hook?: string;
  /** CSS path fallback; shadow boundaries encoded as ` >> ` (FR-12.4). */
  selector?: string;
  /** Text excerpt of the selection — survives rewording (FR-1.5, FR-2.1). */
  quote?: string;
  /** Page/SPA route at capture time (FR-2.2). */
  route?: string;
  /** How to bring a target inside a transient container back into the DOM (issue #20). */
  reveal?: RevealHint;
  /** Set when resolution failed at read time; the note is never dropped (FR-2.4). */
  orphaned?: boolean;
  /** CSS path segments that could not be resolved (shadow root closed, etc.). */
  degraded?: string;
}

/** Curated snapshot of the annotated element's state, captured for design notes. */
export interface CapturedContext {
  tag: string;
  classes: string[];
  /** Curated subset: font-*, color, background, spacing, border, radius. */
  styles: Record<string, string>;
  box: { w: number; h: number; x: number; y: number };
  scheme: "light" | "dark";
  viewport: { w: number; h: number };
  /** App/build identifier the note was taken in (FR-2.5). */
  buildRef?: string;
}

/** Optional debug payload attached by tooling (FR-13.5). */
export interface DebugContext {
  test?: string;
  stack?: string;
  log?: string;
  commit?: string;
  /** Source location `file:line` next to the DOM anchor (FR-13.6). */
  file?: string;
}

/** One entry of a note's append-only thread (FR-3.3). */
export interface Message {
  id: string;
  /** ISO 8601 timestamp. */
  ts: string;
  author: string;
  authorType: AuthorType;
  kind: MessageKind;
  text: string;
}

export interface Note {
  id: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  /** Review round this note belongs to (FR-3.4). */
  sessionRef?: string;
  type: NoteType;
  intent: NoteIntent;
  status: NoteStatus;
  body: string;
  /** Author of the note itself (FR-3.1). */
  author: string;
  authorType: AuthorType;
  anchor: Anchor;
  /** `null` for text notes unless the host asks for a capture (ARCHITECTURE §3). */
  context: CapturedContext | null;
  messages: Message[];
  /** Origin of the note — UI, agent, test runner, CLI (FR-13.3). */
  source: NoteSource;
  /** Environment the note was taken in (FR-14.1). */
  environment: Environment;
  /** Optional external ticket/requirement reference (FR-5.8). */
  ticketRef?: string;
  /** Optional debug context written by tooling (FR-13.5/13.6). */
  debug?: DebugContext;
}

/** Everything a caller may supply when creating a note; the rest is derived. */
export interface NoteDraft {
  type: NoteType;
  body: string;
  anchor: Anchor;
  intent?: NoteIntent;
  status?: NoteStatus;
  author?: string;
  authorType?: AuthorType;
  context?: CapturedContext | null;
  sessionRef?: string;
  source?: NoteSource;
  environment?: Environment;
  ticketRef?: string;
  debug?: DebugContext;
  /** Injectable timestamp/ids — used by tests for deterministic output. */
  now?: string;
  id?: string;
  messages?: Message[];
}

/** Mutable fields of an existing note (FR-5.3, FR-5.5). */
export interface NotePatch {
  status?: NoteStatus;
  intent?: NoteIntent;
  body?: string;
  ticketRef?: string;
  environment?: Environment;
  anchor?: Anchor;
  context?: CapturedContext | null;
  sessionRef?: string;
}

export interface NoteFilter {
  route?: string;
  status?: NoteStatus | NoteStatus[];
  intent?: NoteIntent;
  type?: NoteType;
  session?: string;
  /** ISO timestamp — only notes updated at/after this point. */
  since?: string;
  source?: NoteSource;
  environment?: Environment;
  /** Include `done` notes (default: adapters return everything, the UI filters). */
  includeDone?: boolean;
}

export interface Session {
  ref: string;
  label: string;
  createdAt: string;
}

/** One portable JSON file carrying a whole note set (FR-14.2, NFR-17/19). */
export interface Bundle {
  kind: typeof BUNDLE_KIND;
  schemaVersion: number;
  exportedAt: string;
  exportedBy: string;
  environment: Environment;
  app: { name: string; buildRef?: string };
  sessions: Session[];
  notes: Note[];
}

/** Thrown whenever a note/bundle violates the schema — never thrown silently. */
export class BluepencilValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`bluepencil: ${issues.length} validation issue(s): ${issues.join("; ")}`);
    this.name = "BluepencilValidationError";
    this.issues = issues;
  }
}

let idCounter = 0;

/** Stable, collision-safe id. Prefers `crypto.randomUUID` (browser + Node 20+). */
export function newId(prefix = "n"): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) {
    return `${prefix}-${cryptoObj.randomUUID()}`;
  }
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export interface Clock {
  now(): string;
}

/** Injectable time source so exports and tests stay deterministic (NFR-17). */
export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

export function createMessage(input: {
  text: string;
  kind?: MessageKind;
  author?: string;
  authorType?: AuthorType;
  now?: string;
  id?: string;
}): Message {
  return {
    id: input.id ?? newId("m"),
    ts: input.now ?? systemClock.now(),
    author: input.author ?? "unknown",
    authorType: input.authorType ?? "human",
    kind: input.kind ?? "note",
    text: input.text,
  };
}

/**
 * Build a valid note from a draft. Rejects anything the schema forbids so that an
 * invalid note can never reach an adapter (FR-2.3, FR-3.2).
 */
export function createNote(draft: NoteDraft): Note {
  const issues: string[] = [];
  if (!draft || typeof draft !== "object") {
    throw new BluepencilValidationError(["draft must be an object"]);
  }
  if (typeof draft.body !== "string" || draft.body.trim() === "") {
    issues.push("body must be a non-empty string");
  }
  if (!NOTE_TYPES.includes(draft.type)) {
    issues.push(`type must be one of ${NOTE_TYPES.join(", ")}`);
  }
  if (!draft.anchor || typeof draft.anchor !== "object") {
    issues.push("anchor is required");
  } else if (!draft.anchor.hook && !draft.anchor.selector && !draft.anchor.quote) {
    issues.push("anchor needs at least one of hook, selector or quote");
  }
  if (draft.intent !== undefined && !NOTE_INTENTS.includes(draft.intent)) {
    issues.push(`intent must be one of ${NOTE_INTENTS.join(", ")}`);
  }
  if (draft.status !== undefined && !NOTE_STATUSES.includes(draft.status)) {
    issues.push(`status must be one of ${NOTE_STATUSES.join(", ")}`);
  }
  if (draft.authorType !== undefined && !AUTHOR_TYPES.includes(draft.authorType)) {
    issues.push(`authorType must be one of ${AUTHOR_TYPES.join(", ")}`);
  }
  if (draft.environment !== undefined && !ENVIRONMENTS.includes(draft.environment)) {
    issues.push(`environment must be one of ${ENVIRONMENTS.join(", ")}`);
  }
  if (issues.length > 0) {
    throw new BluepencilValidationError(issues);
  }

  const ts = draft.now ?? systemClock.now();
  const authorType: AuthorType = draft.authorType ?? "human";
  const note: Note = {
    id: draft.id ?? newId("n"),
    schemaVersion: SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    type: draft.type,
    intent: draft.intent ?? "implement",
    status: draft.status ?? "open",
    body: draft.body,
    author: draft.author ?? "anonymous",
    authorType,
    anchor: { ...draft.anchor },
    context: draft.context ?? null,
    messages: draft.messages ? draft.messages.map((m) => ({ ...m })) : [],
    source: draft.source ?? (authorType === "agent" ? "agent" : "ui:human"),
    environment: draft.environment ?? "dev",
    ...(draft.sessionRef !== undefined ? { sessionRef: draft.sessionRef } : {}),
    ...(draft.ticketRef !== undefined ? { ticketRef: draft.ticketRef } : {}),
    ...(draft.debug !== undefined ? { debug: draft.debug } : {}),
  };
  return note;
}

/** Append a message to a note. Threads are append-only: nothing is ever replaced. */
export function appendMessage(note: Note, message: Message): Note {
  return {
    ...note,
    messages: [...note.messages, message],
    updatedAt: message.ts,
  };
}

/**
 * The two exception cases an agent must read first (FR-5.6, docs/PROTOCOL.md §2):
 * a pending decision, or a note that only asks for an assessment.
 */
export function isExceptionNote(note: Note): boolean {
  return note.status === "needs_decision" || note.intent === "feedback";
}

/** True when an agent may implement this note (intent=implement, status=open). */
export function isImplementable(note: Note): boolean {
  return note.status === "open" && note.intent === "implement";
}

export function isNoteType(value: unknown): value is NoteType {
  return typeof value === "string" && (NOTE_TYPES as readonly string[]).includes(value);
}

export function isNoteIntent(value: unknown): value is NoteIntent {
  return typeof value === "string" && (NOTE_INTENTS as readonly string[]).includes(value);
}

export function isNoteStatus(value: unknown): value is NoteStatus {
  return typeof value === "string" && (NOTE_STATUSES as readonly string[]).includes(value);
}

export function isMessageKind(value: unknown): value is MessageKind {
  return typeof value === "string" && (MESSAGE_KINDS as readonly string[]).includes(value);
}

export function isAuthorType(value: unknown): value is AuthorType {
  return typeof value === "string" && (AUTHOR_TYPES as readonly string[]).includes(value);
}

export function isEnvironment(value: unknown): value is Environment {
  return typeof value === "string" && (ENVIRONMENTS as readonly string[]).includes(value);
}
