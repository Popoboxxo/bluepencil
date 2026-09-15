/**
 * Unit tests for the protocol helpers (docs/PROTOCOL.md §2/§3/§4/§6, FR-5.1/5.4/5.5).
 */

import { describe, expect, it } from "vitest";

import type {
  AuthorType,
  Message,
  Note,
  NoteDraft,
  NoteIntent,
  NoteStatus,
  NoteType,
} from "../../src/core/model";
import { BluepencilValidationError, createNote, isExceptionNote, isImplementable } from "../../src/core/model";
import {
  answerDecision,
  completeNote,
  exceptionNotes,
  implementableNotes,
  requestDecision,
  respondFeedback,
  sortForReview,
  summarize,
} from "../../src/core/protocol";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:10:00.000Z";
const T2 = "2026-01-01T00:20:00.000Z";
const T3 = "2026-01-01T00:30:00.000Z";

interface NodeSpec {
  id: string;
  now?: string;
  body?: string;
  type?: NoteType;
  intent?: NoteIntent;
  status?: NoteStatus;
  author?: string;
  authorType?: AuthorType;
  route?: string;
  messages?: Message[];
}

function makeNote(spec: NodeSpec): Note {
  const draft: NoteDraft = {
    id: spec.id,
    now: spec.now ?? T0,
    type: spec.type ?? "text",
    body: spec.body ?? `body of ${spec.id}`,
    intent: spec.intent,
    status: spec.status,
    author: spec.author ?? "Ada",
    authorType: spec.authorType,
    anchor: { hook: `#${spec.id}`, route: spec.route ?? "/checkout" },
    messages: spec.messages,
  };
  return createNote(draft);
}

/** Snapshot used to prove that a helper did not mutate its input. */
function snapshot(note: Note): string {
  return JSON.stringify(note);
}

describe("sortForReview", () => {
  it("orders by FR-4.6 priority, then creation time, then id", () => {
    const done = makeNote({ id: "n-done", status: "done", now: T0 });
    const open = makeNote({ id: "n-open", status: "open", now: T0 });
    const feedback = makeNote({ id: "n-feedback", intent: "feedback", now: T0 });
    const decision = makeNote({ id: "n-decision", status: "needs_decision", now: T0 });

    const sorted = sortForReview([done, open, feedback, decision]);
    expect(sorted.map((note) => note.id)).toEqual(["n-decision", "n-feedback", "n-open", "n-done"]);
  });

  it("uses createdAt as tie-breaker inside one priority class and does not mutate the input", () => {
    const later = makeNote({ id: "n-later", status: "open", now: T2 });
    const earlier = makeNote({ id: "n-earlier", status: "open", now: T1 });
    const input = [later, earlier];

    const sorted = sortForReview(input);
    expect(sorted.map((note) => note.id)).toEqual(["n-earlier", "n-later"]);
    expect(input.map((note) => note.id)).toEqual(["n-later", "n-earlier"]);
  });

  it("keeps a feedback note ahead of an open note even when it is done", () => {
    const doneFeedback = makeNote({ id: "n-done-feedback", intent: "feedback", status: "done", now: T0 });
    const open = makeNote({ id: "n-open", status: "open", now: T0 });
    expect(sortForReview([open, doneFeedback]).map((note) => note.id)).toEqual(["n-done-feedback", "n-open"]);
  });
});

describe("requestDecision", () => {
  it("appends a decision_request as agent and sets needs_decision", () => {
    const note = makeNote({ id: "n-1" });
    const before = snapshot(note);

    const asked = requestDecision(note, {
      text: 'the chapter heading still reads "FOPA" while the lead sentence says "fauxpas"',
      options: ['Keep "FOPA" as the established short form', 'Rename the heading to "Fauxpas — …"'],
      recommendation: "B, because the lead already uses the word",
      now: T1,
    });

    expect(snapshot(note)).toBe(before);
    expect(asked).not.toBe(note);
    expect(asked.status).toBe("needs_decision");
    expect(asked.intent).toBe("implement");
    expect(asked.messages).toHaveLength(1);

    const message = asked.messages[0];
    expect(message?.kind).toBe("decision_request");
    expect(message?.authorType).toBe("agent");
    expect(message?.ts).toBe(T1);
    expect(asked.updatedAt).toBe(T1);

    expect(message?.text).toContain("Decision needed: the chapter heading still reads");
    expect(message?.text).toContain('  A) Keep "FOPA" as the established short form');
    expect(message?.text).toContain('  B) Rename the heading to "Fauxpas — …"');
    expect(message?.text).toContain("I recommend B, because the lead already uses the word.");
    expect(message?.text.trimEnd().endsWith("Reply in this note and I will implement it.")).toBe(true);
  });

  it("appends instead of replacing the existing thread and keeps it append-only", () => {
    const existing: Message = {
      id: "m-1",
      ts: T0,
      author: "Ada",
      authorType: "human",
      kind: "note",
      text: "the heading is inconsistent",
    };
    const note = makeNote({ id: "n-1", messages: [existing] });

    const asked = requestDecision(note, { text: "heading wording", options: ["A", "B"], now: T1 });
    expect(asked.messages).toHaveLength(2);
    expect(asked.messages[0]).toEqual(existing);
  });

  it("never invents a human answer: only a decision_request is not implementable", () => {
    const asked = requestDecision(makeNote({ id: "n-1" }), {
      text: "heading wording",
      options: ["keep", "rename"],
      recommendation: "rename",
      now: T1,
    });

    expect(asked.messages.every((message) => message.kind !== "decision")).toBe(true);
    expect(asked.messages.some((message) => message.authorType === "human")).toBe(false);
    expect(implementableNotes([asked])).toEqual([]);
    expect(isImplementable(asked)).toBe(false);
    expect(isExceptionNote(asked)).toBe(true);
  });

  it("letters more than 26 options without producing an empty label", () => {
    const options = Array.from({ length: 27 }, (_value, index) => `option ${index + 1}`);
    const asked = requestDecision(makeNote({ id: "n-1" }), { text: "many options", options, now: T1 });
    const text = asked.messages[0]?.text ?? "";
    expect(text).toContain("  A) option 1");
    expect(text).toContain("  Z) option 26");
    expect(text).toContain("  A1) option 27");
  });
});

describe("answerDecision", () => {
  it("appends kind=decision as a human by default and reopens the note", () => {
    const asked = requestDecision(makeNote({ id: "n-1" }), { text: "heading wording", now: T1 });
    const before = snapshot(asked);

    const answered = answerDecision(asked, { text: "Take option B.", now: T2 });

    expect(snapshot(asked)).toBe(before);
    expect(answered.status).toBe("open");
    expect(answered.updatedAt).toBe(T2);
    const message = answered.messages[1];
    expect(message?.kind).toBe("decision");
    expect(message?.authorType).toBe("human");
    expect(message?.author).toBe("human");
    expect(message?.text).toBe("Take option B.");
    expect(implementableNotes([answered]).map((note) => note.id)).toEqual(["n-1"]);
  });

  it("keeps an explicitly named author but stays author_type=human", () => {
    const answered = answerDecision(makeNote({ id: "n-1", status: "needs_decision" }), {
      text: "B",
      author: "Ada",
      now: T2,
    });
    expect(answered.messages[0]?.author).toBe("Ada");
    expect(answered.messages[0]?.authorType).toBe("human");
  });
});

describe("respondFeedback", () => {
  it("appends kind=feedback and leaves the status untouched", () => {
    const note = makeNote({ id: "n-1", intent: "feedback", status: "open" });
    const before = snapshot(note);

    const answered = respondFeedback(note, { text: "The shorter variant reads better; a rename is a risk.", now: T2 });

    expect(snapshot(note)).toBe(before);
    expect(answered.status).toBe("open");
    expect(answered.intent).toBe("feedback");
    expect(answered.updatedAt).toBe(T2);
    expect(answered.messages[0]?.kind).toBe("feedback");
    expect(answered.messages[0]?.authorType).toBe("agent");
  });

  it("does not reopen a pending decision", () => {
    const asked = requestDecision(makeNote({ id: "n-1" }), { text: "heading wording", now: T1 });
    const answered = respondFeedback(asked, { text: "assessment", now: T2 });
    expect(answered.status).toBe("needs_decision");
  });
});

describe("completeNote", () => {
  it("appends kind=reply and sets done for an implementable note", () => {
    const note = makeNote({ id: "n-1", status: "open", intent: "implement" });
    const before = snapshot(note);

    const completed = completeNote(note, {
      text: "Renamed the heading in src/pages/Chapter.tsx; no other change.",
      now: T3,
      source: "agent",
    });

    expect(snapshot(note)).toBe(before);
    expect(completed.status).toBe("done");
    expect(completed.updatedAt).toBe(T3);
    expect(completed.source).toBe("agent");
    expect(completed.messages[0]?.kind).toBe("reply");
    expect(completed.messages[0]?.authorType).toBe("agent");
  });

  it("refuses an intent=feedback note (PROTOCOL §6.2)", () => {
    const note = makeNote({ id: "n-1", intent: "feedback", status: "open" });
    const before = snapshot(note);

    expect(() => completeNote(note, { text: "done", now: T3 })).toThrow(BluepencilValidationError);
    try {
      completeNote(note, { text: "done", now: T3 });
    } catch (error) {
      expect((error as BluepencilValidationError).issues.join(" ")).toContain("§6.2: intent=feedback notes are never implemented");
    }
    expect(snapshot(note)).toBe(before);
  });

  it("refuses a needs_decision note (PROTOCOL §6.3)", () => {
    const asked = requestDecision(makeNote({ id: "n-1" }), { text: "heading wording", now: T1 });
    const before = snapshot(asked);

    expect(() => completeNote(asked, { text: "done anyway", now: T3 })).toThrow(BluepencilValidationError);
    try {
      completeNote(asked, { text: "done anyway", now: T3 });
    } catch (error) {
      expect((error as BluepencilValidationError).issues.join(" ")).toContain("§6.3: status=needs_decision must not be marked done");
    }
    expect(asked.status).toBe("needs_decision");
    expect(asked.messages).toHaveLength(1);
    expect(snapshot(asked)).toBe(before);
  });

  it("reports both prohibitions when intent and status both block completion", () => {
    const note = makeNote({ id: "n-1", intent: "feedback", status: "needs_decision" });
    try {
      completeNote(note, { text: "done", now: T3 });
      expect.unreachable("completeNote should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(BluepencilValidationError);
      expect((error as BluepencilValidationError).issues).toHaveLength(2);
    }
  });
});

describe("exceptionNotes / implementableNotes", () => {
  const decision = makeNote({ id: "n-decision", status: "needs_decision", now: T1 });
  const feedback = makeNote({ id: "n-feedback", intent: "feedback", now: T2 });
  const both = makeNote({ id: "n-both", intent: "feedback", status: "needs_decision", now: T0 });
  const open = makeNote({ id: "n-open", status: "open", now: T0 });
  const done = makeNote({ id: "n-done", status: "done", now: T0 });
  const all = [done, open, feedback, decision, both];

  it("splits the exception cases and sorts both lists for review", () => {
    const exceptions = exceptionNotes(all);
    expect(exceptions.decisions.map((note) => note.id)).toEqual(["n-both", "n-decision"]);
    expect(exceptions.feedback.map((note) => note.id)).toEqual(["n-both", "n-feedback"]);
  });

  it("does not mutate the input array", () => {
    const input = [...all];
    exceptionNotes(input);
    implementableNotes(input);
    expect(input.map((note) => note.id)).toEqual(all.map((note) => note.id));
  });

  it("lists only intent=implement with status=open as implementable", () => {
    expect(implementableNotes(all).map((note) => note.id)).toEqual(["n-open"]);
    expect(implementableNotes([done, decision, feedback, both])).toEqual([]);
  });

  it("leaves a note in no exception list once it is done and implementable", () => {
    const exceptions = exceptionNotes([open, done]);
    expect(exceptions.decisions).toEqual([]);
    expect(exceptions.feedback).toEqual([]);
  });
});

describe("summarize", () => {
  it("returns a single line with vocabulary, route and body", () => {
    const note = makeNote({ id: "n-1", body: "the heading is\ninconsistent", route: "/checkout" });
    const label = summarize(note);
    expect(label).toBe("[text/implement/open] /checkout — the heading is inconsistent");
    expect(label.includes("\n")).toBe(false);
  });

  it("omits the route when there is none and truncates very long bodies", () => {
    const note = createNote({
      id: "n-2",
      now: T0,
      type: "design",
      body: "x".repeat(200),
      anchor: { hook: "#n-2" },
    });
    const label = summarize(note);
    expect(label.startsWith("[design/implement/open] — xxx")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(112);
  });
});
