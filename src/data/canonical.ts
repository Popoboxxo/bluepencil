/**
 * Canonical form, serialisation and hashing (NFR-17).
 *
 * The canonical form fixes the key order of every record and the order of every list, so
 * two exports of the same note set are byte-identical and a single changed note produces a
 * single hunk in `git diff`. Nothing here depends on locale, time, platform or the DOM.
 */
import { BUNDLE_KIND } from "../core/model";
import type {
  Anchor,
  Bundle,
  CapturedContext,
  DebugContext,
  Message,
  Note,
  RevealHint,
  Session,
} from "../core/model";

/** Code-unit comparison: deterministic on every platform, unlike `localeCompare`. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Review order (NFR-10, docs/INTERNAL-API.md §7): a pending decision first, then notes that
 * only ask for an assessment (`intent: "feedback"`), then open, then done.
 */
function priorityOf(note: Note): number {
  if (note.status === "needs_decision") return 0;
  if (note.intent === "feedback") return 1;
  if (note.status === "open") return 2;
  return 3; // done
}

function routeOf(note: Note): string {
  return note.anchor.route ?? "";
}

function compareNotes(a: Note, b: Note): number {
  return (
    compareStrings(routeOf(a), routeOf(b)) ||
    priorityOf(a) - priorityOf(b) ||
    compareStrings(a.createdAt, b.createdAt) ||
    compareStrings(a.id, b.id)
  );
}

function compareMessages(a: Message, b: Message): number {
  return compareStrings(a.ts, b.ts) || compareStrings(a.id, b.id);
}

function compareSessions(a: Session, b: Session): number {
  return compareStrings(a.ref, b.ref) || compareStrings(a.createdAt, b.createdAt);
}

function canonicalAnchor(anchor: Anchor): Anchor {
  const out: Anchor = {};
  if (anchor.hook !== undefined) out.hook = anchor.hook;
  if (anchor.selector !== undefined) out.selector = anchor.selector;
  if (anchor.quote !== undefined) out.quote = anchor.quote;
  if (anchor.route !== undefined) out.route = anchor.route;
  if (anchor.orphaned !== undefined) out.orphaned = anchor.orphaned;
  if (anchor.degraded !== undefined) out.degraded = anchor.degraded;
  if (anchor.reveal !== undefined) out.reveal = canonicalReveal(anchor.reveal);
  return out;
}

/** Canonical field order of the reveal hint (issue #20) — same shape, stable key order. */
function canonicalReveal(reveal: RevealHint): RevealHint {
  const out: RevealHint = { container: reveal.container };
  if (reveal.triggerHook !== undefined) out.triggerHook = reveal.triggerHook;
  if (reveal.triggerSelector !== undefined) out.triggerSelector = reveal.triggerSelector;
  if (reveal.triggerLabel !== undefined) out.triggerLabel = reveal.triggerLabel;
  return out;
}

function canonicalContext(context: CapturedContext): CapturedContext {
  const styles: Record<string, string> = {};
  for (const key of Object.keys(context.styles).sort(compareStrings)) {
    const value = context.styles[key];
    if (value !== undefined) styles[key] = value;
  }
  return {
    tag: context.tag,
    classes: [...context.classes],
    styles,
    box: { w: context.box.w, h: context.box.h, x: context.box.x, y: context.box.y },
    scheme: context.scheme,
    viewport: { w: context.viewport.w, h: context.viewport.h },
    ...(context.buildRef !== undefined ? { buildRef: context.buildRef } : {}),
  };
}

function canonicalDebug(debug: DebugContext): DebugContext {
  const out: DebugContext = {};
  if (debug.test !== undefined) out.test = debug.test;
  if (debug.stack !== undefined) out.stack = debug.stack;
  if (debug.log !== undefined) out.log = debug.log;
  if (debug.commit !== undefined) out.commit = debug.commit;
  if (debug.file !== undefined) out.file = debug.file;
  return out;
}

function canonicalMessage(message: Message): Message {
  return {
    id: message.id,
    ts: message.ts,
    author: message.author,
    authorType: message.authorType,
    kind: message.kind,
    text: message.text,
  };
}

/**
 * Canonical form of a note: fixed key order, optional keys only when they carry a value,
 * thread sorted by `ts` then `id`.
 */
export function canonicalNote(note: Note): Note {
  return {
    id: note.id,
    schemaVersion: note.schemaVersion,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    ...(note.sessionRef !== undefined ? { sessionRef: note.sessionRef } : {}),
    type: note.type,
    intent: note.intent,
    status: note.status,
    body: note.body,
    author: note.author,
    authorType: note.authorType,
    anchor: canonicalAnchor(note.anchor),
    context: note.context === null ? null : canonicalContext(note.context),
    messages: note.messages.map(canonicalMessage).sort(compareMessages),
    source: note.source,
    environment: note.environment,
    ...(note.ticketRef !== undefined ? { ticketRef: note.ticketRef } : {}),
    ...(note.debug !== undefined ? { debug: canonicalDebug(note.debug) } : {}),
  };
}

function canonicalSession(session: Session): Session {
  return { ref: session.ref, label: session.label, createdAt: session.createdAt };
}

/** Canonical form of a bundle: fixed key order, notes and sessions in a stable order. */
export function canonicalBundle(bundle: Bundle): Bundle {
  return {
    kind: bundle.kind,
    schemaVersion: bundle.schemaVersion,
    exportedAt: bundle.exportedAt,
    exportedBy: bundle.exportedBy,
    environment: bundle.environment,
    app: {
      name: bundle.app.name,
      ...(bundle.app.buildRef !== undefined ? { buildRef: bundle.app.buildRef } : {}),
    },
    sessions: bundle.sessions.map(canonicalSession).sort(compareSessions),
    notes: bundle.notes.map(canonicalNote).sort(compareNotes),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBundleLike(value: unknown): value is Record<string, unknown> {
  return isObject(value) && value.kind === BUNDLE_KIND && Array.isArray(value.notes);
}

function isNoteLike(value: unknown): value is Record<string, unknown> {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.body === "string" &&
    Array.isArray(value.messages) &&
    isObject(value.anchor)
  );
}

/** Generic fallback: keys sorted, arrays kept, values canonicalised recursively. */
function canonicalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (isBundleLike(value)) return canonicalBundle(value as unknown as Bundle);
  if (isNoteLike(value)) return canonicalNote(value as unknown as Note);
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareStrings)) {
      out[key] = canonicalizeValue(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Deterministic JSON: canonical shape, two-space indentation, trailing newline, so bundles
 * can be committed, diffed and hashed (NFR-17, NFR-19).
 */
export function serializeCanonical(value: unknown): string {
  return `${JSON.stringify(canonicalizeValue(value), null, 2)}\n`;
}

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

/** UTF-8 bytes without depending on `TextEncoder` (works in every host). */
function utf8Bytes(input: string): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    let code = input.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < input.length) {
      const next = input.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        index += 1;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

/** FNV-1a 64-bit over the canonical serialisation, as 16 lowercase hex digits (no deps). */
export function hashBundle(bundle: Bundle): string {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of utf8Bytes(serializeCanonical(bundle))) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & UINT64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}
