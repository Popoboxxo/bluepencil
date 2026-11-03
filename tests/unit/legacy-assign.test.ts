/**
 * Copy-only assign and provenance-based undo (contract B.2, RVW-01/RVW2-04/RVW2-16).
 *
 * Every case runs against a plain map, because that is what the review page passes in: the raw
 * entries of a `chrome.storage.local` read plus an `AssignIo` over the same area. The fixtures
 * cover the two properties that must never drift — the legacy blob is byte-identical after every
 * write, and undo deletes only copies the sidecar proves — as well as the full error matrix.
 */
import { describe, expect, it } from "vitest";

import {
  assignProvenanceKey,
  beginAssign,
  commitAssign,
  commitUndoAssign,
  parseAssignProvenance,
  planAssignToOrigin,
  planUndoAssign,
  type AssignIo,
} from "../../src/data/legacy-assign";
import { parseNoteSet, serializeNoteSet } from "../../src/data/note-set";
import { ASSIGN_PROVENANCE_PREFIX, LEGACY_STORAGE_KEY } from "../../src/data/origin";
import type { Note } from "../../src/core/model";

const A = "https://a.example";
const B = "https://b.example";
const C = "https://c.example";
const KEY_A = `bluepencil:v2:${A}`;
const KEY_B = `bluepencil:v2:${B}`;
const SIDECAR_A = assignProvenanceKey(A);
const NOW = "2026-02-02T00:00:00.000Z";

function note(id: string, origin: string | null, extra: Partial<Note> = {}): Note {
  return {
    id,
    schemaVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    origin,
    type: "text",
    intent: "implement",
    status: "open",
    body: `body ${id}`,
    author: "reviewer",
    authorType: "human",
    anchor: { selector: `#${id}` },
    context: null,
    messages: [],
    source: "ui:human",
    environment: "dev",
    ...extra,
  };
}

function blob(notes: readonly Note[]): string {
  return serializeNoteSet(notes);
}

function idsOf(text: unknown): string[] {
  return typeof text === "string" ? parseNoteSet(text).map((stored) => stored.id) : [];
}

interface MemoryStore {
  data: Record<string, unknown>;
  sets: Array<Record<string, string>>;
  failGet: boolean;
  failSet: boolean;
}

function memoryStore(data: Record<string, unknown> = {}): MemoryStore {
  return { data: { ...data }, sets: [], failGet: false, failSet: false };
}

function ioFor(store: MemoryStore): AssignIo {
  return {
    async get(keys) {
      if (store.failGet) throw new Error("read failed");
      const list = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const key of list) {
        if (key in store.data) {
          result[key] = store.data[key];
        }
      }
      return result;
    },
    async set(items) {
      if (store.failSet) throw new Error("write failed");
      store.sets.push({ ...items });
      Object.assign(store.data, items);
    },
  };
}

describe("planAssignToOrigin — a plan is pure and total (AC-B10, AC-B31, AC-B32, AC-B33, AC-B44)", () => {
  it("returns a plan and never touches the entries it was given", () => {
    const entries = {
      [LEGACY_STORAGE_KEY]: blob([note("n1", null), note("n2", null)]),
    };
    const before = structuredClone(entries);

    const planned = planAssignToOrigin(entries, { ids: ["n1"], origin: A, now: NOW });

    expect(planned.ok).toBe(true);
    expect(entries).toEqual(before);
  });

  it("resolves a non-canonical target to its canonical origin and key", () => {
    const planned = planAssignToOrigin(
      { [LEGACY_STORAGE_KEY]: blob([note("n1", null)]) },
      { ids: ["n1"], origin: "https://A.example:443/", now: NOW },
    );

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.targetOrigin).toBe(A);
    expect(planned.plan.targetKey).toBe(KEY_A);
    expect(planned.plan.provenanceKey).toBe(`bluepencil:assign:${A}`);
    expect(planned.plan.baseText).toBe("");
    expect(planned.plan.baseProvenance).toEqual({});
  });

  it("refuses every unusable target with invalid_origin (AC-B10)", () => {
    const entries = { [LEGACY_STORAGE_KEY]: blob([note("n1", null)]) };
    for (const origin of ["file:///x", "", null, 42]) {
      const planned = planAssignToOrigin(entries, { ids: ["n1"], origin });
      expect(planned).toMatchObject({ ok: false, code: "invalid_origin" });
    }
  });

  it("refuses an empty or whitespace-only selection (AC-B32)", () => {
    const entries = { [LEGACY_STORAGE_KEY]: blob([note("n1", null)]) };
    expect(planAssignToOrigin(entries, { ids: [], origin: A })).toMatchObject({
      ok: false,
      code: "empty_selection",
    });
    expect(planAssignToOrigin(entries, { ids: ["   "], origin: A })).toMatchObject({
      ok: false,
      code: "empty_selection",
    });
  });

  it("trims and dedupes the selection before planning", () => {
    const planned = planAssignToOrigin(
      { [LEGACY_STORAGE_KEY]: blob([note("n1", null)]) },
      { ids: [" n1 ", "n1"], origin: A },
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.moved).toEqual(["n1"]);
    expect(planned.plan.notes).toHaveLength(1);
  });

  it("refuses an id that exists nowhere with unknown_note (AC-B32)", () => {
    const planned = planAssignToOrigin(
      { [LEGACY_STORAGE_KEY]: blob([note("n1", null)]) },
      { ids: ["n99"], origin: A },
    );
    expect(planned).toMatchObject({ ok: false, code: "unknown_note" });
  });

  it("refuses an id that lives in another origin store with conflict (AC-B31)", () => {
    const entries = {
      [LEGACY_STORAGE_KEY]: blob([note("n1", null)]),
      [KEY_B]: blob([note("n1", B)]),
    };
    const before = structuredClone(entries);

    const planned = planAssignToOrigin(entries, { ids: ["n1"], origin: A });

    expect(planned).toMatchObject({ ok: false, code: "conflict" });
    expect(entries).toEqual(before);
  });

  it("refuses a corrupt legacy blob with corrupt_source (AC-B33)", () => {
    const planned = planAssignToOrigin(
      { [LEGACY_STORAGE_KEY]: "{nicht json" },
      { ids: ["n1"], origin: A },
    );
    expect(planned).toMatchObject({ ok: false, code: "corrupt_source" });
  });

  it("refuses a corrupt target blob with corrupt_source (AC-B33)", () => {
    const planned = planAssignToOrigin(
      {
        [LEGACY_STORAGE_KEY]: blob([note("n1", null)]),
        [KEY_A]: "{nicht json",
      },
      { ids: ["n1"], origin: A },
    );
    expect(planned).toMatchObject({ ok: false, code: "corrupt_source" });
  });

  it("fails closed on a corrupt foreign origin group, even when the source is readable (AC-B44, RVW2-16)", () => {
    const entries = {
      [LEGACY_STORAGE_KEY]: blob([note("n1", null), note("n2", null)]),
      [`bluepencil:v2:${C}`]: "{nicht json",
    };
    const before = structuredClone(entries);

    const planned = planAssignToOrigin(entries, { ids: ["n2"], origin: A });

    expect(planned).toMatchObject({ ok: false, code: "corrupt_source" });
    expect(entries).toEqual(before);
  });

  it("reports an id already in the target as skipped, not as a copy", () => {
    const planned = planAssignToOrigin(
      {
        [LEGACY_STORAGE_KEY]: blob([note("n1", null), note("n2", null)]),
        [KEY_A]: blob([note("n1", A)]),
      },
      { ids: ["n1", "n2"], origin: A },
    );

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.moved).toEqual(["n2"]);
    expect(planned.plan.skipped).toEqual(["n1"]);
    expect(planned.plan.notes.map((copy) => copy.id)).toEqual(["n2"]);
  });
});

describe("commitAssign — copy-only, one write, byte-identical legacy (AC-B09, AC-B11, AC-B34, AC-B45)", () => {
  const legacyNotes = [
    note("n1", null, { timing: { at: 12, label: "intro" } }),
    note("n2", null),
    note("n3", null),
  ];

  function seeded(): { store: MemoryStore; io: AssignIo } {
    const store = memoryStore({ [LEGACY_STORAGE_KEY]: blob(legacyNotes) });
    return { store, io: ioFor(store) };
  }

  it("copies the selected notes and leaves the legacy blob byte-identical (AC-B11)", async () => {
    const { store, io } = seeded();
    const legacyText = store.data[LEGACY_STORAGE_KEY];

    const state = beginAssign(store.data, { ids: ["n1", "n3"], origin: A, now: NOW });
    expect(state.confirmed).toBe(false);
    expect(state.plan?.moved).toEqual(["n1", "n3"]);
    expect(state.plan?.skipped).toEqual([]);

    state.confirmed = true;
    const result = await commitAssign(state, io);

    expect(result).toEqual({ ok: true, added: ["n1", "n3"], skipped: [] });
    // The legacy key was not written, removed or re-serialised.
    expect(store.data[LEGACY_STORAGE_KEY]).toBe(legacyText);
    expect(store.sets).toHaveLength(1);
    expect(Object.keys(store.sets[0] ?? {}).sort()).toEqual([SIDECAR_A, KEY_A].sort());

    const targetNotes = parseNoteSet(store.data[KEY_A] as string);
    expect(targetNotes.map((stored) => stored.id)).toEqual(["n1", "n3"]);
    expect(parseAssignProvenance(store.data[SIDECAR_A])).toEqual({ n1: NOW, n3: NOW });

    const legacyNote = parseNoteSet(legacyText as string).find((stored) => stored.id === "n1");
    const copy = targetNotes.find((stored) => stored.id === "n1");
    expect(legacyNote).toBeDefined();
    expect(copy).toBeDefined();
    if (legacyNote === undefined || copy === undefined) return;

    // Every field but `origin` is equal; `timing` is a separate object.
    expect(copy).toEqual({ ...legacyNote, origin: A });
    expect(copy.id).toBe(legacyNote.id);
    expect(copy.createdAt).toBe(legacyNote.createdAt);
    expect(copy.updatedAt).toBe(legacyNote.updatedAt);
    expect(copy.body).toBe(legacyNote.body);
    expect(copy.timing).toEqual(legacyNote.timing);
    expect(copy.timing).not.toBe(legacyNote.timing);
    expect(copy.anchor).not.toBe(legacyNote.anchor);

    // 3 legacy notes stay where they are, 2 copies live in the target.
    expect(parseNoteSet(legacyText as string)).toHaveLength(3);
    expect(store.data[LEGACY_STORAGE_KEY]).toBe(legacyText);
  });

  it("refuses an unconfirmed plan without a write (AC-B09)", async () => {
    const { store, io } = seeded();
    const state = beginAssign(store.data, { ids: ["n1"], origin: A, now: NOW });
    const result = await commitAssign(state, io);

    expect(result).toEqual({ ok: false, code: "not_confirmed" });
    expect(store.sets).toEqual([]);
    expect(store.data[KEY_A]).toBeUndefined();
  });

  it("refuses a plan with no plan at all as not_confirmed", async () => {
    const { store, io } = seeded();
    expect(await commitAssign({ plan: null, confirmed: true }, io)).toEqual({
      ok: false,
      code: "not_confirmed",
    });
    expect(store.sets).toEqual([]);
  });

  it("is stale when the target changes between plan and commit (AC-B34)", async () => {
    const { store, io } = seeded();
    const state = beginAssign(store.data, { ids: ["n1"], origin: A, now: NOW });
    store.data[KEY_A] = blob([note("n7", A)]);

    state.confirmed = true;
    expect(await commitAssign(state, io)).toEqual({ ok: false, code: "stale_plan" });
    expect(store.sets).toEqual([]);
    expect(idsOf(store.data[KEY_A])).toEqual(["n7"]);

    // A new plan sees n7, and committing it keeps n7 beside the copy.
    const replanned = beginAssign(store.data, { ids: ["n1"], origin: A, now: NOW });
    replanned.confirmed = true;
    const result = await commitAssign(replanned, io);
    expect(result).toEqual({ ok: true, added: ["n1"], skipped: [] });
    expect(idsOf(store.data[KEY_A])).toEqual(["n7", "n1"]);
  });

  it("is stale when the sidecar changes between plan and commit", async () => {
    const { store, io } = seeded();
    const state = beginAssign(store.data, { ids: ["n1"], origin: A, now: NOW });
    store.data[SIDECAR_A] = JSON.stringify({ n5: NOW });

    state.confirmed = true;
    expect(await commitAssign(state, io)).toEqual({ ok: false, code: "stale_plan" });
    expect(store.sets).toEqual([]);
  });

  it("answers a throwing write with storage_failure and no partial write (AC-B45)", async () => {
    const { store, io } = seeded();
    const legacyText = store.data[LEGACY_STORAGE_KEY];
    const state = beginAssign(store.data, { ids: ["n1"], origin: A, now: NOW });
    state.confirmed = true;
    store.failSet = true;

    await expect(commitAssign(state, io)).resolves.toEqual({
      ok: false,
      code: "storage_failure",
    });
    expect(store.data[KEY_A]).toBeUndefined();
    expect(store.data[SIDECAR_A]).toBeUndefined();
    expect(store.data[LEGACY_STORAGE_KEY]).toBe(legacyText);
  });

  it("answers a throwing read with storage_failure instead of throwing", async () => {
    const { store, io } = seeded();
    const state = beginAssign(store.data, { ids: ["n1"], origin: A, now: NOW });
    state.confirmed = true;
    store.failGet = true;

    await expect(commitAssign(state, io)).resolves.toEqual({
      ok: false,
      code: "storage_failure",
    });
    expect(store.sets).toEqual([]);
  });
});

describe("planUndoAssign / commitUndoAssign — only proven copies go (AC-B35, AC-B45…AC-B47, AC-B51)", () => {
  it("removes a proven copy from the target and keeps the legacy note (AC-B35)", async () => {
    const legacy = [note("n1", null), note("n2", null)];
    const store = memoryStore({ [LEGACY_STORAGE_KEY]: blob(legacy) });
    const io = ioFor(store);
    const legacyText = store.data[LEGACY_STORAGE_KEY];

    const assign = beginAssign(store.data, { ids: ["n1"], origin: A, now: NOW });
    assign.confirmed = true;
    await commitAssign(assign, io);

    const planned = planUndoAssign(store.data, { ids: ["n1"], origin: A });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.removed).toEqual(["n1"]);
    expect(planned.plan.skipped).toEqual([]);

    const result = await commitUndoAssign({ plan: planned.plan, confirmed: true }, io);

    expect(result).toEqual({ ok: true, removed: ["n1"], skipped: [] });
    expect(idsOf(store.data[KEY_A])).toEqual([]);
    expect(parseAssignProvenance(store.data[SIDECAR_A])).toEqual({});
    // Undo touched neither the legacy blob nor its byte content.
    expect(store.data[LEGACY_STORAGE_KEY]).toBe(legacyText);
    expect(idsOf(legacyText)).toEqual(["n1", "n2"]);
  });

  it("refuses every unusable target with invalid_origin (AC-B45)", () => {
    for (const origin of ["file:///x", "", null, 42]) {
      expect(planUndoAssign({}, { ids: ["n1"], origin })).toMatchObject({
        ok: false,
        code: "invalid_origin",
      });
    }
  });

  it("refuses an id that exists nowhere with unknown_note (AC-B45)", () => {
    expect(
      planUndoAssign(
        { [LEGACY_STORAGE_KEY]: blob([note("n1", null)]), [KEY_A]: blob([note("n2", A)]) },
        { ids: ["n99"], origin: A },
      ),
    ).toMatchObject({ ok: false, code: "unknown_note" });
  });

  it("refuses a corrupt target blob with corrupt_source (AC-B45)", () => {
    expect(
      planUndoAssign({ [KEY_A]: "{nicht json" }, { ids: ["n1"], origin: A }),
    ).toMatchObject({ ok: false, code: "corrupt_source" });
  });

  it("undoes only ids the sidecar proves (AC-B46)", async () => {
    // n1 was already in the target before any assign; n2 is the only proven copy.
    const store = memoryStore({
      [LEGACY_STORAGE_KEY]: blob([note("n1", null), note("n2", null)]),
      [KEY_A]: blob([note("n1", A)]),
      [SIDECAR_A]: JSON.stringify({ n2: NOW }),
    });
    const io = ioFor(store);
    const legacyText = store.data[LEGACY_STORAGE_KEY];

    const unproven = planUndoAssign(store.data, { ids: ["n1"], origin: A });
    expect(unproven.ok).toBe(true);
    if (!unproven.ok) return;
    expect(unproven.plan.removed).toEqual([]);
    expect(unproven.plan.skipped).toEqual(["n1"]);

    const noWrite = await commitUndoAssign({ plan: unproven.plan, confirmed: true }, io);
    expect(noWrite).toEqual({ ok: true, removed: [], skipped: ["n1"] });
    expect(store.sets).toEqual([]);
    expect(idsOf(store.data[KEY_A])).toEqual(["n1"]);

    // The later assign of n2 is the only thing that earns n2 a sidecar entry.
    const copy = beginAssign(store.data, { ids: ["n2"], origin: A, now: NOW });
    copy.confirmed = true;
    expect(await commitAssign(copy, io)).toEqual({ ok: true, added: ["n2"], skipped: [] });
    expect(idsOf(store.data[KEY_A])).toEqual(["n1", "n2"]);

    const proven = planUndoAssign(store.data, { ids: ["n2"], origin: A });
    expect(proven.ok).toBe(true);
    if (!proven.ok) return;
    expect(proven.plan.removed).toEqual(["n2"]);

    const removed = await commitUndoAssign({ plan: proven.plan, confirmed: true }, io);
    expect(removed).toEqual({ ok: true, removed: ["n2"], skipped: [] });
    expect(idsOf(store.data[KEY_A])).toEqual(["n1"]);
    expect(parseAssignProvenance(store.data[SIDECAR_A])).toEqual({});
    expect(store.data[LEGACY_STORAGE_KEY]).toBe(legacyText);
  });

  it("writes once to clean a sidecar entry whose copy is already gone (AC-B51)", async () => {
    const targetText = blob([note("n2", A)]);
    const store = memoryStore({
      [LEGACY_STORAGE_KEY]: blob([note("n2", null), note("n3", null)]),
      [KEY_A]: targetText,
      [SIDECAR_A]: JSON.stringify({ n3: NOW }),
    });
    const io = ioFor(store);

    const planned = planUndoAssign(store.data, { ids: ["n3"], origin: A });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.removed).toEqual([]);
    expect(planned.plan.skipped).toEqual(["n3"]);
    expect(planned.plan.remainingProvenance).toEqual({});

    const result = await commitUndoAssign({ plan: planned.plan, confirmed: true }, io);

    expect(result).toEqual({ ok: true, removed: [], skipped: ["n3"] });
    expect(store.sets).toHaveLength(1);
    expect(store.data[KEY_A]).toBe(targetText);
    expect(parseAssignProvenance(store.data[SIDECAR_A])).toEqual({});
  });

  it("is stale when the target changes between undo plan and commit (AC-B47)", async () => {
    const store = memoryStore({
      [LEGACY_STORAGE_KEY]: blob([note("n2", null)]),
      [KEY_A]: blob([note("n2", A)]),
      [SIDECAR_A]: JSON.stringify({ n2: NOW }),
    });
    const io = ioFor(store);
    const planned = planUndoAssign(store.data, { ids: ["n2"], origin: A });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    store.data[KEY_A] = blob([note("n2", A), note("n9", A)]);
    expect(await commitUndoAssign({ plan: planned.plan, confirmed: true }, io)).toEqual({
      ok: false,
      code: "stale_plan",
    });
    expect(store.sets).toEqual([]);
    expect(idsOf(store.data[KEY_A])).toEqual(["n2", "n9"]);

    // A fresh plan sees n9 and keeps it while removing n2.
    const replanned = planUndoAssign(store.data, { ids: ["n2"], origin: A });
    expect(replanned.ok).toBe(true);
    if (!replanned.ok) return;
    await commitUndoAssign({ plan: replanned.plan, confirmed: true }, io);
    expect(idsOf(store.data[KEY_A])).toEqual(["n9"]);
  });

  it("answers a throwing undo write with storage_failure and no partial write (AC-B45)", async () => {
    const targetText = blob([note("n2", A)]);
    const store = memoryStore({
      [KEY_A]: targetText,
      [SIDECAR_A]: JSON.stringify({ n2: NOW }),
    });
    const io = ioFor(store);
    const planned = planUndoAssign(store.data, { ids: ["n2"], origin: A });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    store.failSet = true;

    await expect(commitUndoAssign({ plan: planned.plan, confirmed: true }, io)).resolves.toEqual({
      ok: false,
      code: "storage_failure",
    });
    expect(store.data[KEY_A]).toBe(targetText);
    expect(parseAssignProvenance(store.data[SIDECAR_A])).toEqual({ n2: NOW });
  });

  it("refuses an unconfirmed undo without a write", async () => {
    const store = memoryStore({
      [KEY_A]: blob([note("n2", A)]),
      [SIDECAR_A]: JSON.stringify({ n2: NOW }),
    });
    const io = ioFor(store);
    const planned = planUndoAssign(store.data, { ids: ["n2"], origin: A });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    expect(await commitUndoAssign({ plan: planned.plan, confirmed: false }, io)).toEqual({
      ok: false,
      code: "not_confirmed",
    });
    expect(store.sets).toEqual([]);
  });
});

describe("parseAssignProvenance — total, never a throw", () => {
  it("returns {} for anything that is not a JSON object", () => {
    for (const raw of [undefined, null, 42, "{nicht json", "[]", "null", {}]) {
      expect(parseAssignProvenance(raw)).toEqual({});
    }
  });

  it("keeps string timestamps and drops other values", () => {
    expect(parseAssignProvenance({ n1: NOW, n2: 42, "": NOW })).toEqual({ n1: NOW });
    expect(parseAssignProvenance(JSON.stringify({ n1: NOW }))).toEqual({ n1: NOW });
  });

  it("names the sidecar with the documented prefix", () => {
    expect(ASSIGN_PROVENANCE_PREFIX).toBe("bluepencil:assign:");
    expect(assignProvenanceKey(A)).toBe("bluepencil:assign:https://a.example");
  });
});
