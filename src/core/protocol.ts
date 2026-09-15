/**
 * Agent collaboration protocol (docs/PROTOCOL.md, FR-5.1/5.4/5.5/5.6/5.7).
 *
 * The four states an agent has to distinguish (PROTOCOL §2) are expressed here as the only
 * transitions this module offers:
 *
 * | Situation        | Signal                                   | Transition                          |
 * |------------------|------------------------------------------|-------------------------------------|
 * | Normal work item | `intent=implement`, `status=open`        | `completeNote` → `kind=reply`, done |
 * | Opinion wanted   | `intent=feedback`                        | `respondFeedback` → `kind=feedback`, status untouched |
 * | Question pending | `status=needs_decision`                  | wait; `answerDecision` (human) reopens |
 * | Unclear          | none of the above                        | `requestDecision` → `kind=decision_request`, needs_decision |
 *
 * Every function is pure: it returns a new note, never mutates its input, and sets
 * `updatedAt` to the timestamp of the appended message. Threads stay append-only (FR-3.3).
 *
 * Hard prohibitions enforced in code (PROTOCOL §6): a decision is appended by a human
 * (`answerDecision` defaults to `author_type=human`, and nothing in this module ever invents
 * one), `intent=feedback` is never implemented, and `needs_decision` is never marked done.
 */

import type { Note, NoteSource, NoteStatus } from "./model";
import {
  BluepencilValidationError,
  appendMessage,
  createMessage,
  isExceptionNote,
  isImplementable,
} from "./model";

/** FR-4.6 priority: needs_decision first, then feedback, then open, then done. */
function reviewPriority(note: Note): number {
  if (note.status === "needs_decision") {
    return 0;
  }
  if (note.intent === "feedback") {
    return 1;
  }
  return note.status === "open" ? 2 : 3;
}

function compareText(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/** Append a message and optionally patch the note; the input note is left untouched. */
function withMessage(
  note: Note,
  message: ReturnType<typeof createMessage>,
  patch?: { status?: NoteStatus; source?: NoteSource },
): Note {
  const appended = appendMessage(note, message);
  if (patch === undefined) {
    return appended;
  }
  return {
    ...appended,
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.source !== undefined ? { source: patch.source } : {}),
  };
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** `A`, `B`, … `Z`, `A1`, `B1`, … — a lettered option must always be answerable in one line. */
function optionLabel(index: number): string {
  const letter = LETTERS.charAt(index % LETTERS.length);
  const cycle = Math.floor(index / LETTERS.length);
  return cycle === 0 ? letter : `${letter}${cycle}`;
}

/**
 * Compose the ask in the PROTOCOL §3 style: what the decision is about, the lettered options,
 * one explicit recommendation, and the closing line that says what happens next.
 */
function decisionRequestText(input: {
  text: string;
  options?: string[];
  recommendation?: string;
}): string {
  const lines: string[] = [`Decision needed: ${input.text.trim()}`];
  for (const [index, option] of (input.options ?? []).entries()) {
    lines.push(`  ${optionLabel(index)}) ${option.trim()}`);
  }
  const recommendation = input.recommendation?.trim() ?? "";
  if (recommendation !== "") {
    lines.push(`I recommend ${recommendation}${/[.!?]$/.test(recommendation) ? "" : "."}`);
  }
  lines.push("Reply in this note and I will implement it.");
  return lines.join("\n");
}

/**
 * Ask the human for a decision (FR-5.4, PROTOCOL §3): appends a `decision_request` as the
 * agent and sets `status=needs_decision`, which blocks implementation until a human answers.
 * No answer is ever invented — the note stays unusable for `implementableNotes` until
 * `answerDecision` runs.
 */
export function requestDecision(
  note: Note,
  input: { text: string; options?: string[]; recommendation?: string; author?: string; now?: string },
): Note {
  const message = createMessage({
    text: decisionRequestText(input),
    kind: "decision_request",
    author: input.author ?? "agent",
    authorType: "agent",
    now: input.now,
  });
  return withMessage(note, message, { status: "needs_decision" });
}

/**
 * Record the human's answer (FR-5.5, PROTOCOL §2/§3): appends `kind=decision` as a human and
 * returns the note to `open` so the agent may implement it. Only a human answers a decision.
 */
export function answerDecision(
  note: Note,
  input: { text: string; author?: string; now?: string },
): Note {
  const message = createMessage({
    text: input.text,
    kind: "decision",
    author: input.author ?? "human",
    authorType: "human",
    now: input.now,
  });
  return withMessage(note, message, { status: "open" });
}

/**
 * Answer an `intent=feedback` note with an assessment (PROTOCOL §2/§6.2): appends
 * `kind=feedback` and deliberately leaves `intent` and `status` alone — the human decides what
 * to do with an assessment.
 */
export function respondFeedback(
  note: Note,
  input: { text: string; author?: string; now?: string },
): Note {
  const message = createMessage({
    text: input.text,
    kind: "feedback",
    author: input.author ?? "agent",
    authorType: "agent",
    now: input.now,
  });
  return withMessage(note, message);
}

/**
 * Close a normal work item (FR-5.1, PROTOCOL §4): appends the `kind=reply` that reports what
 * changed and sets `status=done`. Refuses (PROTOCOL §6.2/§6.3) for `intent=feedback` — an
 * assessment is never implemented — and for `status=needs_decision` — the question is
 * pending, so there is nothing to complete yet.
 */
export function completeNote(
  note: Note,
  input: { text: string; author?: string; source?: NoteSource; now?: string },
): Note {
  const issues: string[] = [];
  if (note.intent === "feedback") {
    issues.push(
      "PROTOCOL §6.2: intent=feedback notes are never implemented — answer with kind=feedback and leave the decision to the human",
    );
  }
  if (note.status === "needs_decision") {
    issues.push(
      "PROTOCOL §6.3: status=needs_decision must not be marked done — wait for kind=decision from a human, then implement",
    );
  }
  if (issues.length > 0) {
    throw new BluepencilValidationError(issues);
  }
  const message = createMessage({
    text: input.text,
    kind: "reply",
    author: input.author ?? "agent",
    authorType: "agent",
    now: input.now,
  });
  return withMessage(note, message, { status: "done", ...(input.source !== undefined ? { source: input.source } : {}) });
}

/**
 * The exception cases an agent reads first (FR-5.6, PROTOCOL §7): pending decisions and
 * assessment-only notes. A note can appear in both lists. Both lists are in review order.
 */
export function exceptionNotes(notes: Note[]): { decisions: Note[]; feedback: Note[] } {
  const exceptions = notes.filter((note) => isExceptionNote(note));
  return {
    decisions: sortForReview(exceptions.filter((note) => note.status === "needs_decision")),
    feedback: sortForReview(exceptions.filter((note) => note.intent === "feedback")),
  };
}

/**
 * The notes an agent may implement right now: `intent=implement` and `status=open`
 * (PROTOCOL §2). Anything else — feedback-only, pending decision, already done — is excluded.
 */
export function implementableNotes(notes: Note[]): Note[] {
  return sortForReview(notes.filter((note) => isImplementable(note)));
}

/**
 * FR-4.6 review order: needs_decision, feedback, open, done; creation time and then id break
 * ties, so the order is total and deterministic.
 */
export function sortForReview(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => {
    const byPriority = reviewPriority(a) - reviewPriority(b);
    if (byPriority !== 0) {
      return byPriority;
    }
    const byCreated = compareText(a.createdAt, b.createdAt);
    if (byCreated !== 0) {
      return byCreated;
    }
    return compareText(a.id, b.id);
  });
}

/** One-line list label: vocabulary, route (when known) and the first line of the body. */
export function summarize(note: Note): string {
  const head = `[${note.type}/${note.intent}/${note.status}]`;
  const route = (note.anchor.route ?? "").replace(/\s+/g, " ").trim();
  const body = note.body.replace(/\s+/g, " ").trim();
  const short = body.length > 80 ? `${body.slice(0, 79)}…` : body;
  const labelled = route === "" ? head : `${head} ${route}`;
  return short === "" ? labelled : `${labelled} — ${short}`;
}
