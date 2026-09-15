/**
 * Unit tests for the import/merge logic (FR-14.3/14.4, NFR-18): the three modes, idempotence,
 * thread concatenation, conflict reporting, refusal and environment isolation.
 */
import { describe, expect, it } from "vitest";
import { BluepencilValidationError, createNote } from "../../src/core/model";
import type { Environment, Message, Note, NoteDraft, NoteIntent, NoteStatus, NoteType } from "../../src/core/model";
import { mergeNotes } from "../../src/data/index";

const T = "2026-09-14T18:20:00.000Z";
const LATER = "2026-09-14T19:00:00.000Z";

/** Fixture accessor that keeps `noUncheckedIndexedAccess` happy without casts. */
function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`fixture has no entry at ${index}`);
  return value;
}

function msg(id: string, ts: string, text?: string): Message {
  return { id, ts, author: "noa", authorType: "human", kind: "note", text: text ?? `text of ${id}` };
}

interface NoteInput {
  id: string;
  status?: NoteStatus;
  intent?: NoteIntent;
  type?: NoteType;
  body?: string;
  environment?: Environment;
  sessionRef?: string;
  messages?: Message[];
  now?: string;
}

function makeNote(input: NoteInput): Note {
  const draft: NoteDraft = {
    id: input.id,
    type: input.type ?? "text",
    body: input.body ?? `body of ${input.id}`,
    anchor: { hook: `hook-${input.id}` },
    now: input.now ?? T,
    status: input.status,
    intent: input.intent,
    environment: input.environment,
    sessionRef: input.sessionRef,
    messages: input.messages,
  };
  return createNote(draft);
}

function ids(notes: readonly Note[]): string[] {
  return notes.map((note) => note.id);
}

function expectRefusal(run: () => unknown): BluepencilValidationError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BluepencilValidationError);
  return caught as BluepencilValidationError;
}

describe("merge mode (default)", () => {
  it("adds unknown ids, skips known ones and is idempotent", () => {
    const existing = [makeNote({ id: "n-1" })];
    const incoming = [makeNote({ id: "n-1" }), makeNote({ id: "n-2" })];

    const first = mergeNotes(existing, incoming);
    expect(first).toMatchObject({ added: 1, updated: 0, skipped: 1, removed: 0, conflicts: [] });
    expect(ids(first.notes)).toEqual(["n-1", "n-2"]);
    expect(existing).toHaveLength(1);

    const second = mergeNotes(first.notes, incoming);
    expect(second).toMatchObject({ added: 0, updated: 0, skipped: 2, removed: 0, conflicts: [] });
    expect(second.notes).toEqual(first.notes);
  });

  it("reports divergent content but never overwrites it (FR-14.4)", () => {
    const existing = [makeNote({ id: "n-1", body: "original", messages: [msg("m-1", T, "keep me")] })];
    const incoming = [makeNote({ id: "n-1", body: "rewritten", now: LATER, messages: [msg("m-2", LATER, "new")] })];

    const result = mergeNotes(existing, incoming);
    expect(result).toMatchObject({ added: 0, updated: 0, skipped: 1 });
    expect(result.conflicts).toHaveLength(1);

    const conflict = at(result.conflicts, 0);
    expect(conflict.id).toBe("n-1");
    expect(conflict.reason).toContain("n-1");
    expect(conflict.reason).toContain("body");
    expect(conflict.reason).toContain("messages");
    expect(conflict.existingUpdatedAt).toBe(T);
    expect(conflict.incomingUpdatedAt).toBe(LATER);

    const kept = at(result.notes, 0);
    expect(kept.body).toBe("original");
    expect(kept.messages.map((message) => message.id)).toEqual(["m-1"]);
    expect(at(existing, 0).body).toBe("original");
  });

  it("refuses keep-incoming in merge mode with a pointer to upsert", () => {
    const existing = [makeNote({ id: "n-1", body: "original" })];
    const incoming = [makeNote({ id: "n-1", body: "rewritten" })];
    const error = expectRefusal(() => mergeNotes(existing, incoming, { onConflict: "keep-incoming" }));
    expect(error.issues.join("|")).toContain("upsert");
  });

  it("leaves a clean bundle untouched on a second import", () => {
    const incoming = [makeNote({ id: "n-1" }), makeNote({ id: "n-2" })];
    const first = mergeNotes([], incoming);
    expect(first.added).toBe(2);
    const second = mergeNotes(first.notes, incoming);
    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.notes).toEqual(first.notes);
  });
});

describe("upsert mode", () => {
  const existing = [makeNote({ id: "n-1", body: "original", status: "open" })];
  const changed = [makeNote({ id: "n-1", body: "rewritten", status: "done" })];

  it("refuses the write and still reports the counts (FR-14.4)", () => {
    const error = expectRefusal(() => mergeNotes(existing, changed, { mode: "upsert" }));
    const issues = error.issues.join("|");
    expect(issues).toContain("n-1");
    expect(issues).toContain("status, body");
    expect(issues).toContain("counts: added=0, updated=0, skipped=1, removed=0, conflicts=1");
    expect(at(existing, 0).body).toBe("original");
  });

  it("refuses when onConflict is explicitly fail", () => {
    expectRefusal(() => mergeNotes(existing, changed, { mode: "upsert", onConflict: "fail" }));
  });

  it("updates the note and concatenates the thread on keep-incoming", () => {
    const base = [
      makeNote({
        id: "n-1",
        body: "original",
        status: "open",
        messages: [msg("m-1", T, "question")],
      }),
    ];
    // The same note as it comes back from another machine: same creation time, later update,
    // two appended messages.
    const incoming = [
      {
        ...makeNote({
          id: "n-1",
          body: "original",
          status: "done",
          messages: [msg("m-1", T, "question"), msg("m-2", LATER, "answer"), msg("m-3", LATER, "extra")],
        }),
        updatedAt: LATER,
      },
    ];

    const result = mergeNotes(base, incoming, { mode: "upsert", onConflict: "keep-incoming" });
    expect(result).toMatchObject({ added: 0, updated: 1, skipped: 0, removed: 0 });
    expect(result.conflicts).toHaveLength(1);

    const merged = at(result.notes, 0);
    expect(merged.status).toBe("done");
    expect(merged.body).toBe("original");
    expect(merged.createdAt).toBe(T);
    expect(merged.updatedAt).toBe(LATER);
    expect(merged.messages.map((message) => message.id)).toEqual(["m-1", "m-2", "m-3"]);
    expect(merged).not.toBe(at(base, 0));
    expect(at(base, 0).messages).toHaveLength(1);

    const second = mergeNotes(result.notes, incoming, { mode: "upsert", onConflict: "keep-incoming" });
    expect(second).toMatchObject({ added: 0, updated: 0, removed: 0 });
    expect(second.notes).toEqual(result.notes);
    expect(second.notes).not.toBe(result.notes);
  });

  it("keeps the existing thread for a message id that already exists (append-only)", () => {
    const base = [makeNote({ id: "n-1", messages: [msg("m-1", T, "original")] })];
    const incoming = [makeNote({ id: "n-1", messages: [msg("m-1", T, "reworded")] })];

    const result = mergeNotes(base, incoming, { mode: "upsert", onConflict: "keep-incoming" });
    expect(result).toMatchObject({ added: 0, updated: 0, skipped: 1 });
    expect(result.conflicts).toHaveLength(1);
    expect(at(result.notes, 0).messages.map((message) => message.text)).toEqual(["original"]);
  });

  it("keeps the existing note on keep-existing", () => {
    const result = mergeNotes(existing, changed, { mode: "upsert", onConflict: "keep-existing" });
    expect(result).toMatchObject({ added: 0, updated: 0, skipped: 1 });
    expect(result.conflicts).toHaveLength(1);
    expect(at(result.notes, 0)).toBe(at(existing, 0));
  });

  it("adds unknown ids in every mode", () => {
    const incoming = [makeNote({ id: "n-1", body: "original" }), makeNote({ id: "n-9" })];
    const result = mergeNotes(existing, incoming, { mode: "upsert", dryRun: true });
    expect(result.added).toBe(1);
    expect(ids(result.notes)).toEqual(["n-1", "n-9"]);
  });
});

describe("dry run", () => {
  const existing = [makeNote({ id: "n-1", body: "original" })];
  const incoming = [makeNote({ id: "n-1", body: "rewritten" }), makeNote({ id: "n-2" })];

  it("reports counts and conflicts without refusing or touching the input", () => {
    const snapshot = JSON.parse(JSON.stringify(existing)) as unknown;
    const result = mergeNotes(existing, incoming, { mode: "upsert", dryRun: true });
    expect(result).toMatchObject({ added: 1, updated: 0, skipped: 1 });
    expect(result.conflicts).toHaveLength(1);
    expect(ids(result.notes)).toEqual(["n-1", "n-2"]);
    expect(at(result.notes, 0).body).toBe("original");
    expect(existing).toEqual(snapshot);
  });

  it("previews a resolved update without applying it", () => {
    const result = mergeNotes(existing, incoming, { mode: "upsert", dryRun: true, onConflict: "keep-incoming" });
    expect(result).toMatchObject({ added: 1, updated: 1, skipped: 0 });
    expect(at(result.notes, 0).body).toBe("rewritten");
    expect(at(existing, 0).body).toBe("original");
  });

  it("previews a replace-session run", () => {
    const base = [makeNote({ id: "n-1", sessionRef: "s-1" }), makeNote({ id: "n-2", sessionRef: "s-2" })];
    const bundle = [makeNote({ id: "n-9", sessionRef: "s-1" })];
    const result = mergeNotes(base, bundle, { mode: "replace-session", dryRun: true });
    expect(result).toMatchObject({ added: 1, removed: 1, skipped: 0 });
    expect(ids(result.notes)).toEqual(["n-2", "n-9"]);
    expect(ids(base)).toEqual(["n-1", "n-2"]);
  });
});

describe("replace-session mode", () => {
  const existing = [
    makeNote({ id: "n-1", sessionRef: "s-1", body: "one" }),
    makeNote({ id: "n-2", sessionRef: "s-1", body: "two" }),
    makeNote({ id: "n-3", sessionRef: "s-2", body: "three" }),
  ];
  const incoming = [
    makeNote({ id: "n-1", sessionRef: "s-1", body: "rewritten" }),
    makeNote({ id: "n-4", sessionRef: "s-1", body: "four" }),
  ];

  it("removes the notes of the incoming sessions and re-adds them", () => {
    const result = mergeNotes(existing, incoming, { mode: "replace-session" });
    expect(result).toMatchObject({ added: 2, updated: 0, skipped: 0, removed: 2, conflicts: [] });
    expect(ids(result.notes)).toEqual(["n-3", "n-1", "n-4"]);
    expect(at(result.notes, 1).body).toBe("rewritten");
    expect(existing).toHaveLength(3);
  });

  it("is idempotent", () => {
    const first = mergeNotes(existing, incoming, { mode: "replace-session" });
    const second = mergeNotes(first.notes, incoming, { mode: "replace-session" });
    expect(second).toMatchObject({ added: 2, removed: 2, updated: 0 });
    expect(second.notes).toEqual(first.notes);
  });

  it("still refuses to rewrite a note outside the replaced sessions", () => {
    const bundle = [makeNote({ id: "n-3", sessionRef: "s-1", body: "from bundle" })];
    const error = expectRefusal(() => mergeNotes(existing, bundle, { mode: "replace-session" }));
    expect(error.issues.join("|")).toContain("n-3");
  });

  it("only replaces the sessions that the incoming set carries", () => {
    const bundle = [makeNote({ id: "n-9", sessionRef: "s-2" })];
    const result = mergeNotes(existing, bundle, { mode: "replace-session" });
    expect(result).toMatchObject({ added: 1, removed: 1 });
    expect(ids(result.notes)).toEqual(["n-1", "n-2", "n-9"]);
  });
});

describe("environment isolation (NFR-18)", () => {
  const devStore = [makeNote({ id: "n-1", environment: "dev" })];
  const liveBundle = [makeNote({ id: "n-2", environment: "live" })];

  it("refuses a live bundle in a dev store and explains why", () => {
    const error = expectRefusal(() => mergeNotes(devStore, liveBundle));
    const issues = error.issues.join("|");
    expect(issues).toContain('environment mismatch: incoming notes are "live" but the target is "dev"');
    expect(issues).toContain("allowEnvMismatch");
    expect(devStore).toHaveLength(1);
  });

  it("allows the mismatch when explicitly asked", () => {
    const result = mergeNotes(devStore, liveBundle, { allowEnvMismatch: true });
    expect(result).toMatchObject({ added: 1, conflicts: [] });
    expect(at(result.notes, 1).environment).toBe("live");
  });

  it("uses targetEnvironment for an empty store", () => {
    expectRefusal(() => mergeNotes([], liveBundle, { targetEnvironment: "dev" }));
    expect(mergeNotes([], liveBundle, { targetEnvironment: "live" }).added).toBe(1);
    expect(mergeNotes([], liveBundle, { targetEnvironment: "staging", allowEnvMismatch: true }).added).toBe(1);
  });

  it("refuses an incoming set that mixes environments", () => {
    const mixed = [makeNote({ id: "n-1", environment: "dev" }), makeNote({ id: "n-2", environment: "live" })];
    expectRefusal(() => mergeNotes([], mixed));
    expect(mergeNotes([], mixed, { allowEnvMismatch: true }).added).toBe(2);
  });

  it("accepts a matching environment", () => {
    const liveStore = [makeNote({ id: "n-1", environment: "live" })];
    expect(mergeNotes(liveStore, liveBundle).added).toBe(1);
  });
});
