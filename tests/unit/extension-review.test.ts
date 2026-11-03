/**
 * The per-origin review page (contract B.2): aggregation, mismatch/duplicate flags, corrupt
 * stores, and the two properties the page must never lose — text-only rendering and no network.
 *
 * The fixtures are the raw `chrome.storage.local` entries the page receives: strings for note
 * blobs, plus the keys that are explicitly *not* note sets (settings, UI state, the assign
 * sidecar). `aggregateOriginStores` is pure, so every rule is observable without a browser.
 *
 * The last two blocks are source assertions. A DOM test cannot prove "no `innerHTML` anywhere" or
 * "no `fetch` anywhere" — one untested branch would be enough — so the page's sources are scanned
 * for the APIs themselves, and `review.html` for the `connect-src 'none'` that backs the claim up.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  aggregateOriginStores,
  applyAssign,
  applyUndo,
  previewAssign,
  previewUndo,
  renderReview,
  reviewActions,
  runReviewPage,
  type OriginGroup,
  type ReviewStorageArea,
} from "../../extension/src/review";
import { planUndoAssign } from "../../src/data/legacy-assign";
import { parseNoteSet, serializeNoteSet } from "../../src/data/note-set";

const A = "https://a.example";
const B = "https://b.example";
const KEY_A = `bluepencil:v2:${A}`;
const KEY_B = `bluepencil:v2:${B}`;
const LEGACY_KEY = "bluepencil:default:v1";
const SIDECAR_KEY = `bluepencil:assign:${A}`;
const SETTINGS_KEY = "bluepencil:settings";
const UI_KEY = "bluepencil:ui:panel";

/** A stored note as the page receives it. Only `id` is mandatory for the codec. */
function note(id: string, origin: string | null, body = `body ${id}`): Record<string, unknown> {
  return {
    id,
    origin,
    body,
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "text",
    status: "open",
    // A real stored note always has an anchor; `migrateNote` rejects a note without one.
    anchor: { selector: `#${id}` },
  };
}

/** A stored note set, exactly as the adapters serialise one. */
function blob(notes: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ version: 1, notes });
}

function groupByOrigin(groups: readonly OriginGroup[], origin: string | null): OriginGroup {
  const found = groups.find((group) => group.origin === origin && !group.legacy);
  if (found === undefined) throw new Error(`no group for ${String(origin)}`);
  return found;
}

function legacyGroup(groups: readonly OriginGroup[]): OriginGroup {
  const found = groups.find((group) => group.legacy);
  if (found === undefined) throw new Error("no legacy group");
  return found;
}

/** A `chrome.storage.local` stand-in that answers `get` and records every call. */
function fakeArea(entries: Record<string, unknown>): {
  area: ReviewStorageArea;
  calls: Array<string | string[] | null | undefined>;
} {
  const calls: Array<string | string[] | null | undefined> = [];
  return {
    area: {
      get: async (keys) => {
        calls.push(keys);
        return entries;
      },
    },
    calls,
  };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("aggregateOriginStores — the profile as origin groups (AC-B07)", () => {
  it("groups two origin stores ascending and puts the legacy blob last", () => {
    const groups = aggregateOriginStores({
      [KEY_B]: blob([note("n2", B)]),
      [LEGACY_KEY]: blob([note("n9", null)]),
      [KEY_A]: blob([note("n1", A)]),
    });

    expect(groups.map((group) => group.origin)).toEqual([A, B, null]);
    expect(groups.map((group) => group.legacy)).toEqual([false, false, true]);
    expect(groups.map((group) => group.key)).toEqual([KEY_A, KEY_B, LEGACY_KEY]);
    for (const group of groups) {
      expect(group.error).toBeUndefined();
    }
  });

  it("ignores settings, UI state and the assign sidecar (only note keys are groups)", () => {
    const groups = aggregateOriginStores({
      [KEY_A]: blob([note("n1", A)]),
      [LEGACY_KEY]: blob([]),
      [SIDECAR_KEY]: JSON.stringify({ n1: "2026-01-01T00:00:00.000Z" }),
      [SETTINGS_KEY]: JSON.stringify({ store: "chromeStorage" }),
      [UI_KEY]: JSON.stringify({ open: true }),
    });

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.key)).toEqual([KEY_A, LEGACY_KEY]);
  });

  it("marks legacy:true only on the legacy group, and gives it no origin and no notes origin", () => {
    const groups = aggregateOriginStores({
      [KEY_A]: blob([note("n1", A)]),
      [LEGACY_KEY]: blob([note("n9", null)]),
    });
    const legacy = legacyGroup(groups);

    expect(legacy.origin).toBeNull();
    expect(legacy.key).toBe(LEGACY_KEY);
    expect(legacy.notes.map((view) => view.note.id)).toEqual(["n9"]);
    expect(legacy.notes[0]?.mismatch).toBe(false);
    expect(legacy.notes[0]?.keyOrigin).toBeNull();
  });

  it("keeps every group readable when one blob is corrupt (AC-B33)", () => {
    const groups = aggregateOriginStores({
      [KEY_A]: "{nicht json",
      [KEY_B]: blob([note("n2", B)]),
      [LEGACY_KEY]: "{nicht json",
    });

    const a = groupByOrigin(groups, A);
    expect(a.error?.code).toBe("corrupt_blob");
    expect(a.notes).toEqual([]);
    expect(a.mismatched).toEqual([]);

    const corruptLegacy = legacyGroup(groups);
    expect(corruptLegacy.error?.code).toBe("corrupt_blob");
    expect(corruptLegacy.notes).toEqual([]);

    // The readable store is unaffected by its corrupt neighbours.
    expect(groupByOrigin(groups, B).notes.map((view) => view.note.id)).toEqual(["n2"]);
  });

  it("treats a non-text value as a corrupt store instead of throwing", () => {
    const groups = aggregateOriginStores({ [KEY_A]: { notes: [note("n1", A)] } });
    expect(groups[0]?.error?.code).toBe("corrupt_blob");
    expect(groups[0]?.notes).toEqual([]);
  });
});

describe("mismatch — the key wins, the note keeps its own origin (AC-B08)", () => {
  it("flags a note whose origin differs from its storage key", () => {
    const groups = aggregateOriginStores({ [KEY_A]: blob([note("n1", B)]) });
    const group = groupByOrigin(groups, A);
    const view = group.notes[0];

    expect(group.origin).toBe(A);
    expect(view?.keyOrigin).toBe(A);
    expect(view?.mismatch).toBe(true);
    expect(group.mismatched).toEqual(["n1"]);
    // The stored note is not rewritten.
    expect(view?.note.origin).toBe(B);
  });

  it("does not flag a note whose origin matches, or an unassigned note in legacy", () => {
    const groups = aggregateOriginStores({
      [KEY_A]: blob([note("n1", A)]),
      [LEGACY_KEY]: blob([note("n9", null)]),
    });

    expect(groupByOrigin(groups, A).mismatched).toEqual([]);
    expect(legacyGroup(groups).mismatched).toEqual([]);
  });

  it("treats a missing origin in an origin store as a mismatch (key wins)", () => {
    const bare = note("n1", null);
    delete bare.origin;
    const groups = aggregateOriginStores({ [KEY_A]: blob([bare]) });
    expect(groupByOrigin(groups, A).mismatched).toEqual(["n1"]);
  });
});

describe("duplicates — an id in more than one store (AC-B35 preparation)", () => {
  it("marks the id in every affected view", () => {
    const groups = aggregateOriginStores({
      [KEY_A]: blob([note("n1", A)]),
      [LEGACY_KEY]: blob([note("n1", null)]),
    });

    expect(groupByOrigin(groups, A).notes[0]?.duplicate).toBe(true);
    expect(legacyGroup(groups).notes[0]?.duplicate).toBe(true);
  });

  it("does not mark unique ids", () => {
    const groups = aggregateOriginStores({
      [KEY_A]: blob([note("n1", A)]),
      [KEY_B]: blob([note("n2", B)]),
    });

    expect(groups.flatMap((group) => group.notes).every((view) => !view.duplicate)).toBe(true);
  });

  it("shows a duplicated body once and marks the legacy row as a copy", () => {
    const groups = aggregateOriginStores({
      [KEY_A]: blob([note("n1", A, "the body appears once")]),
      [LEGACY_KEY]: blob([note("n1", null, "the body appears once")]),
    });
    const root = document.createElement("div");

    renderReview(document, root, groups);

    const occurrences = (root.textContent ?? "").split("the body appears once").length - 1;
    expect(occurrences).toBe(1);
    expect(root.querySelector(".bp-review-copy")?.textContent).toContain("Copy of note n1");
    expect(root.querySelector(".bp-review-copy")?.textContent).toContain(`shown under ${A}`);
  });
});

describe("rendering — text only, never markup", () => {
  it("writes a note body as text and never constructs an element from it", () => {
    const payload = '<img src=x onerror="globalThis.__bpReviewPwned = true">';
    const groups = aggregateOriginStores({ [KEY_A]: blob([note("n1", A, payload)]) });
    const root = document.createElement("div");

    renderReview(document, root, groups);

    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain(payload);
    expect((globalThis as { __bpReviewPwned?: unknown }).__bpReviewPwned).toBeUndefined();
  });

  it("renders groups, keys and error messages as text", () => {
    const groups = aggregateOriginStores({ [KEY_A]: "{nicht json" });
    const root = document.createElement("div");

    renderReview(document, root, groups);

    expect(root.querySelector("section.bp-review-group")?.getAttribute("data-key")).toBe(KEY_A);
    expect(root.querySelector(".bp-review-key")?.textContent).toBe(KEY_A);
    expect(root.querySelector(".bp-review-error")?.textContent).toContain("cannot be read");
    expect(root.querySelector("script")).toBeNull();
  });

  it("clears the container on a re-render instead of appending twice", () => {
    const root = document.createElement("div");
    const groups = aggregateOriginStores({ [KEY_A]: blob([note("n1", A)]) });

    renderReview(document, root, groups);
    renderReview(document, root, groups);

    expect(root.querySelectorAll("section.bp-review-group")).toHaveLength(1);
  });
});

describe("the page — one storage read, no network, no write", () => {
  it("reads chrome.storage.local once and renders the summary", async () => {
    const root = document.createElement("div");
    const status = document.createElement("p");
    status.id = "review-status";
    document.body.append(root, status);

    const { area, calls } = fakeArea({
      [KEY_A]: blob([note("n1", A)]),
      [LEGACY_KEY]: blob([note("n9", null)]),
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await runReviewPage(document, area, root);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(calls).toEqual([null]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(status.textContent).toBe("2 stores, 2 notes.");
    expect(root.querySelectorAll("section.bp-review-group")).toHaveLength(2);
  });

  it("reports an unreadable store in the summary", async () => {
    const root = document.createElement("div");
    const status = document.createElement("p");
    status.id = "review-status";
    document.body.append(root, status);

    const { area } = fakeArea({ [KEY_A]: "{nicht json" });
    await runReviewPage(document, area, root);

    expect(status.textContent).toBe("1 store, 0 notes, 1 unreadable.");
  });
});

/** A `chrome.storage.local` stand-in that also records writes. */
function writableArea(entries: Record<string, unknown>): {
  area: ReviewStorageArea;
  data: Record<string, unknown>;
  sets: Array<Record<string, string>>;
} {
  const data: Record<string, unknown> = { ...entries };
  const sets: Array<Record<string, string>> = [];
  return {
    data,
    sets,
    area: {
      get: async (keys) => {
        if (keys === null || keys === undefined) return { ...data };
        const list = Array.isArray(keys) ? keys : [keys];
        const result: Record<string, unknown> = {};
        for (const key of list) {
          if (key in data) result[key] = data[key];
        }
        return result;
      },
      set: async (items) => {
        sets.push({ ...items });
        Object.assign(data, items);
      },
    },
  };
}

/** A store state with one legacy blob and an empty (or given) target. */
function legacyState(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [LEGACY_KEY]: blob([note("n1", null), note("n2", null)]),
    ...extra,
  };
}

describe("assign and undo on the review page (AC-B33, AC-B35, AC-B44, AC-B46, AC-B51)", () => {
  it("previews the normalised target origin and the copy count", () => {
    const preview = previewAssign(legacyState(), { ids: ["n1", "n2"], origin: "https://A.example" });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.origin).toBe(A);
    expect(preview.copies).toBe(2);
    expect(preview.label).toBe(`Copy 2 notes to ${A}`);
  });

  it("offers no assign action when a foreign group is corrupt (AC-B44)", () => {
    const entries = legacyState({ [`bluepencil:v2:https://c.example`]: "{nicht json" });

    const preview = previewAssign(entries, { ids: ["n1"], origin: A });
    expect(preview).toMatchObject({ ok: false, code: "corrupt_source" });

    // The page's action list is derived from the same plan, so no commit button exists.
    expect(reviewActions(entries).filter((action) => action.kind === "assign")).toEqual([]);
  });

  it("offers no assign action when the target blob is corrupt (AC-B33)", () => {
    const entries = legacyState({ [KEY_A]: "{nicht json" });

    expect(previewAssign(entries, { ids: ["n1"], origin: A })).toMatchObject({
      ok: false,
      code: "corrupt_source",
    });
    expect(reviewActions(entries).filter((action) => action.kind === "assign")).toEqual([]);
  });

  it("copies without writing the legacy key, then shows the copy once (AC-B35)", async () => {
    const { area, data, sets } = writableArea(legacyState());
    const legacyText = data[LEGACY_KEY];

    const result = await applyAssign(area, { ids: ["n1"], origin: A }, () => true);

    expect(result).toEqual({ ok: true, kind: "assign", origin: A, count: 1 });
    // Only the v2 store and the sidecar were written; the legacy blob is byte-identical.
    expect(sets).toHaveLength(1);
    expect(Object.keys(sets[0] ?? {}).sort()).toEqual([KEY_A, SIDECAR_KEY].sort());
    expect(data[LEGACY_KEY]).toBe(legacyText);

    const groups = aggregateOriginStores(data);
    const target = groupByOrigin(groups, A);
    expect(target.notes.map((view) => view.note.id)).toEqual(["n1"]);
    expect(target.notes[0]?.duplicate).toBe(true);
    expect(legacyGroup(groups).notes.find((view) => view.note.id === "n1")?.duplicate).toBe(true);

    // Undo deletes the copy from the target store only.
    const undo = await applyUndo(area, { ids: ["n1"], origin: A }, () => true);
    expect(undo).toEqual({ ok: true, kind: "undo", origin: A, count: 1 });
    expect(groupByOrigin(aggregateOriginStores(data), A).notes).toEqual([]);
    expect(data[LEGACY_KEY]).toBe(legacyText);
  });

  it("never writes the legacy key and leaves it byte-identical across assign and undo (AC-B12)", async () => {
    const { area, data, sets } = writableArea(legacyState());
    const before = data[LEGACY_KEY];

    await applyAssign(area, { ids: ["n1", "n2"], origin: A }, () => true);
    await applyUndo(area, { ids: ["n1", "n2"], origin: A }, () => true);

    expect(data[LEGACY_KEY]).toBe(before);
    for (const items of sets) {
      for (const key of Object.keys(items)) {
        expect([KEY_A, SIDECAR_KEY]).toContain(key);
        expect(key).not.toBe(LEGACY_KEY);
      }
    }
  });

  it("undoes only proven copies; an id that was already in the target is skipped (AC-B46)", async () => {
    // n1 is already in the target before any assign; only n2 will be proven.
    const { area, data } = writableArea({
      [LEGACY_KEY]: blob([note("n1", null), note("n2", null)]),
      [KEY_A]: blob([note("n1", A)]),
    });

    const result = await applyAssign(area, { ids: ["n1", "n2"], origin: A }, () => true);
    expect(result).toEqual({ ok: true, kind: "assign", origin: A, count: 1 });
    expect(JSON.parse(String(data[SIDECAR_KEY]))).toEqual({ n2: expect.any(String) });

    // n1 has no provenance: nothing is removed and no confirmation is requested.
    let asked = 0;
    const unproven = await applyUndo(area, { ids: ["n1"], origin: A }, () => {
      asked += 1;
      return true;
    });
    expect(unproven).toEqual({ ok: true, kind: "undo", origin: A, count: 0 });
    expect(asked).toBe(0);
    // n1 and the proven copy n2 are both still there.
    expect(groupByOrigin(aggregateOriginStores(data), A).notes.map((view) => view.note.id)).toEqual([
      "n1",
      "n2",
    ]);

    const proven = await applyUndo(area, { ids: ["n2"], origin: A }, () => true);
    expect(proven).toEqual({ ok: true, kind: "undo", origin: A, count: 1 });
    expect(groupByOrigin(aggregateOriginStores(data), A).notes.map((view) => view.note.id)).toEqual([
      "n1",
    ]);
    expect(JSON.parse(String(data[SIDECAR_KEY]))).toEqual({});
  });

  it("cleans a sidecar entry whose copy is already gone (AC-B51)", async () => {
    const { area, data, sets } = writableArea({
      [LEGACY_KEY]: blob([note("n1", null)]),
      [KEY_A]: blob([note("n2", A)]),
      [SIDECAR_KEY]: JSON.stringify({ n3: "2026-01-01T00:00:00.000Z" }),
    });
    // A stored target is canonical (produced by the same codec), so a cleanup must not rewrite it.
    const targetText = serializeNoteSet(parseNoteSet(String(data[KEY_A])));
    data[KEY_A] = targetText;

    const preview = previewUndo(data, { ids: ["n3"], origin: A });
    expect(preview).toMatchObject({ ok: true, copies: 0, removed: [], skipped: ["n3"] });

    // `applyUndo` performs the cleanup because the plan has a sidecar change to write.
    const result = await applyUndo(area, { ids: ["n3"], origin: A }, () => true);
    expect(result).toEqual({ ok: true, kind: "undo", origin: A, count: 0 });
    expect(sets).toHaveLength(1);
    expect(data[KEY_A]).toBe(targetText);
    expect(JSON.parse(String(data[SIDECAR_KEY]))).toEqual({});
  });

  it("does not confirm or write when the user declines", async () => {
    const { area, sets } = writableArea(legacyState());

    const result = await applyAssign(area, { ids: ["n1"], origin: A }, () => false);

    expect(result).toMatchObject({ ok: false, code: "declined" });
    expect(sets).toEqual([]);
  });

  it("refuses a write on a read-only area", async () => {
    const { area } = fakeArea(legacyState());
    expect(await applyAssign(area, { ids: ["n1"], origin: A }, () => true)).toMatchObject({
      ok: false,
      code: "unavailable",
    });
    expect(await applyUndo(area, { ids: ["n1"], origin: A }, () => true)).toMatchObject({
      ok: false,
      code: "unavailable",
    });
  });

  it("renders assign and undo buttons with the origin and copy count", async () => {
    const { area, data } = writableArea({
      [LEGACY_KEY]: blob([note("n1", null), note("n2", null)]),
      [KEY_A]: blob([note("n1", A)]),
      [SIDECAR_KEY]: JSON.stringify({ n1: "2026-01-01T00:00:00.000Z" }),
    });
    const root = document.createElement("div");
    const status = document.createElement("p");
    status.id = "review-status";
    document.body.append(root, status);

    await runReviewPage(document, area, root, { confirm: () => false });

    const assign = root.querySelector('button[data-action="assign"]');
    expect(assign?.textContent).toBe(`Copy 1 note to ${A}`);
    expect(assign?.getAttribute("data-origin")).toBe(A);
    expect(assign?.getAttribute("data-copies")).toBe("1");

    const undo = root.querySelector('button[data-action="undo"]');
    expect(undo?.textContent).toBe(`Remove 1 copied note from ${A}`);
    expect(undo?.getAttribute("data-copies")).toBe("1");

    // A declining dialog leaves the stores alone even after the DOM action is wired.
    expect(data[LEGACY_KEY]).toBe(blob([note("n1", null), note("n2", null)]));
  });

  it("keeps the legacy notes visible after an undo (AC-B35)", async () => {
    const { area, data } = writableArea(legacyState());
    await applyAssign(area, { ids: ["n1"], origin: A }, () => true);
    const planned = planUndoAssign(data, { ids: ["n1"], origin: A });

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    await applyUndo(area, { ids: ["n1"], origin: A }, () => true);

    // The legacy row survives the undo; only the copy is gone.
    expect(legacyGroup(aggregateOriginStores(data)).notes.map((view) => view.note.id)).toEqual([
      "n1",
      "n2",
    ]);
  });
});

describe("source assertions — the properties that must not regress", () => {
  const root = process.cwd();
  const source = readFileSync(join(root, "extension/src/review.ts"), "utf8");
  const html = readFileSync(join(root, "extension/review.html"), "utf8");

  it("never renders with an HTML sink", () => {
    expect(source).not.toMatch(/\.innerHTML\s*=/);
    expect(source).not.toMatch(/\.outerHTML\s*=/);
    expect(source).not.toMatch(/insertAdjacentHTML\s*\(/);
    expect(source).not.toMatch(/document\.write\s*\(/);
    // The one creation API is `createElement` + `textContent`.
    expect(source).toMatch(/createElement\s*\(/);
    expect(source).toMatch(/textContent\s*=/);
  });

  it("uses no network API in either the script or the page", () => {
    for (const text of [source, html]) {
      expect(text).not.toMatch(/\bfetch\s*\(/);
      expect(text).not.toMatch(/\bXMLHttpRequest\b/);
      expect(text).not.toMatch(/\bWebSocket\b/);
      expect(text).not.toMatch(/\bEventSource\b/);
      expect(text).not.toMatch(/\bsendBeacon\b/);
      expect(text).not.toMatch(/https?:\/\//);
    }
  });

  it("declares script-src 'self' and connect-src 'none', and loads exactly one module", () => {
    expect(html).toMatch(/script-src 'self'/);
    expect(html).toMatch(/connect-src 'none'/);
    expect(html).toMatch(/default-src 'none'/);
    expect(html.match(/<script/g) ?? []).toHaveLength(1);
    expect(html).toMatch(/<script type="module" src="\.\/review\.js"><\/script>/);
  });

  it("carries no inline event handler and no remote resource", () => {
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/web_accessible_resources/);
  });
});

/**
 * AC-B52, source half: the review page's build and import surface, asserted without a `dist`.
 *
 * The build half of AC-B52 is `smoke:ext:review`, which loads the artefact; this block pins the
 * inputs that decide whether such an artefact can exist at all. Two failure modes are invisible in
 * a diff and only observable here:
 *
 *   - a value the page imports silently drops out of `src/data/index.ts` (the built `dist/data.js`
 *     would then be missing an export, and `review.js` would fail at load);
 *   - `scripts/build.mjs` stops rebuilding the extension for `data`/`adapters`, leaving `--watch`
 *     on a stale data bundle behind a fresh review page (B.2, `ELEMENT_JOBS`).
 *
 * Deliberately absent: the `buildTestGrant()` self-call. It belongs to T-B10 (AC-B57), so this
 * block must not require it — a task that has not landed yet cannot be a precondition here.
 */
describe("source assertions — AC-B52 review surface without a build", () => {
  const root = process.cwd();
  const read = (path: string): string => readFileSync(join(root, path), "utf8");

  /**
   * The 14 values contract B.2 names as the page's whole data surface. Counting them here is what
   * makes "the export surface is complete" a numeric claim instead of a sampled one.
   */
  const REVIEW_VALUES = [
    "parseNoteSet",
    "migrateNote",
    "parseNotesStorageKey",
    "chromeStorageKeyForOrigin",
    "assignProvenanceKey",
    "parseAssignProvenance",
    "planAssignToOrigin",
    "beginAssign",
    "commitAssign",
    "planUndoAssign",
    "commitUndoAssign",
    "LEGACY_STORAGE_KEY",
    "normaliseOrigin",
    "parseOriginInput",
  ] as const;

  it("re-exports all 14 review values from src/data/index.ts", async () => {
    const surface = (await import("../../src/data/index")) as Record<string, unknown>;
    for (const name of REVIEW_VALUES) {
      expect(surface[name], `missing export ${name}`).toBeDefined();
    }
    expect(REVIEW_VALUES).toHaveLength(14);
    expect(surface.LEGACY_STORAGE_KEY).toBe("bluepencil:default:v1");
    expect(typeof surface.parseNoteSet).toBe("function");
    expect(typeof surface.parseNotesStorageKey).toBe("function");
  });

  it("declares Note and NoteOrigin on the data surface the page typechecks against", () => {
    const dataIndex = read("src/data/index.ts");
    expect(dataIndex).toContain('export type { Note, NoteOrigin } from "../core/model";');

    const declaration = read("extension/src/review-data.d.ts");
    expect(declaration).toContain(
      'export type NoteOrigin = import("../../src/core/model").NoteOrigin;',
    );
    expect(declaration).toContain('export type Note = import("../../src/core/model").Note;');
  });

  it("review.ts imports neither cloneNote nor src/core/model directly", () => {
    const review = read("extension/src/review.ts");
    // `cloneNote` is a source-level import inside the data bundle, not a public entry (B.2).
    expect(review).not.toMatch(/\bcloneNote\b/);
    // The page talks to `dist/data.js`; reaching into the model would be a second surface.
    expect(review).not.toMatch(/core\/model|src\/core\//);
    expect(review).toMatch(/from "\.\.\/\.\.\/dist\/data\.js"/);
  });

  it("extension/build.mjs defines the review entry and bundles the built data bundle", () => {
    const build = read("extension/build.mjs");
    expect(build).toMatch(/review:\s*join\(here, "src", "review\.ts"\)/);
    expect(build).toMatch(/const DATA_BUNDLE = join\(root, "dist", "data\.js"\)/);
    expect(build).toMatch(/"review\.html"/);
    expect(build).toMatch(/"review\.js"/);
  });

  it("scripts/build.mjs rebuilds the extension for data and adapters too (ELEMENT_JOBS)", () => {
    const build = read("scripts/build.mjs");
    const match = build.match(/const ELEMENT_JOBS = new Set\(\[([^\]]*)\]\)/);
    expect(match, "ELEMENT_JOBS declaration not found").not.toBeNull();
    const jobs = (match?.[1] ?? "")
      .split(",")
      .map((value) => value.trim().replace(/"/g, ""))
      .filter((value) => value.length > 0);
    expect(jobs).toContain("element");
    expect(jobs).toContain("element-iife");
    // The review page bundles `dist/data.js`, which imports the adapters it names.
    expect(jobs).toContain("data");
    expect(jobs).toContain("adapters");
  });

  it("exposes smoke:ext:review, which loads only dist-test and names a missing artefact", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.["smoke:ext:review"]).toBe("node extension/smoke-review.mjs");

    const smoke = read("extension/smoke-review.mjs");
    expect(smoke).toContain('const extDist = join(here, "dist-test");');
    // A missing build artefact is a named FAIL with its path and the command that builds it — the
    // check must run before the browser requirement, otherwise "no Chrome" would mask it.
    expect(smoke.indexOf("missingArtefacts()")).toBeGreaterThan(-1);
    expect(smoke.indexOf("missingArtefacts()")).toBeLessThan(smoke.indexOf("requireBrowser("));
    expect(smoke).toMatch(/FAIL missing \$\{/);
    expect(smoke).toContain("npm run smoke:ext");
    expect(smoke).toMatch(/process\.exit\(1\)/);
  });
});
