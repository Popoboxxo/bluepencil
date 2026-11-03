/**
 * Unit tests for the extracted note-mutation unit (CQ-03 split, spec §3.13 L).
 *
 * The unit is the layer's write path without the layer: it takes the store, settings, panel and
 * composer handles as arguments. These tests pin the seam the composition root relies on —
 * the composer target lives in the unit, a write reports via `onError`/the panel instead of
 * throwing, and `dispose()` drops the target so a stale save can never land after teardown.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryAdapter } from "../../src/adapters/memory";
import { deriveAnchor } from "../../src/core/anchor";
import type { Note } from "../../src/core/model";
import { createStore, type Store } from "../../src/core/store";
import { createTranslator } from "../../src/i18n";
import type { Composer, ComposerTarget } from "../../src/ui/composer";
import { createLayerNotes, type LayerNotesUnit } from "../../src/ui/layer-notes";
import { DEFAULT_SETTINGS, type LayerSettings, type Panel } from "../../src/ui/panel";

interface Harness {
  unit: LayerNotesUnit;
  store: Store;
  settings: LayerSettings;
  panelErrors: { noteId: string; key?: string }[];
  announced: string[];
  renders: number;
  errors: unknown[];
}

function makePanel(errors: Harness["panelErrors"]): Panel {
  const noop = (): void => undefined;
  return {
    element: document.createElement("div"),
    open: noop,
    close: noop,
    toggle: noop,
    isOpen: () => false,
    render: noop,
    visibleNotes: () => [],
    filters: () => ({ type: "all", intent: "all", status: "all", severity: "all", priority: "all" }),
    setFilter: noop,
    resetFilters: noop,
    replyValue: () => "",
    reportNoteError: (note: Note, key?: string) => {
      errors.push({ noteId: note.id, ...(key === undefined ? {} : { key }) });
    },
    reportMessage: noop,
  } as Panel;
}

function makeHarness(): Harness {
  const store = createStore({ adapter: createMemoryAdapter() });
  const settings: LayerSettings = { ...DEFAULT_SETTINGS };
  const panelErrors: Harness["panelErrors"] = [];
  const announced: string[] = [];
  const errors: unknown[] = [];
  let renders = 0;
  const unit = createLayerNotes({
    store,
    t: createTranslator("en").t,
    settings: () => settings,
    panel: () => makePanel(panelErrors),
    composer: () => null as Composer | null,
    announce: (key) => announced.push(key),
    renderAll: () => {
      renders += 1;
    },
    onError: (error) => errors.push(error),
  });
  return {
    unit,
    store,
    settings,
    panelErrors,
    announced,
    get renders() {
      return renders;
    },
    errors,
  };
}

function connectedTarget(): { target: ComposerTarget; element: HTMLElement } {
  const element = document.createElement("p");
  element.textContent = "a paragraph the reviewer marked";
  document.body.append(element);
  const target: ComposerTarget = {
    type: "text",
    anchor: deriveAnchor(element),
    context: null,
    element,
    label: "p",
  };
  return { target, element };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("layer note-mutation unit", () => {
  it("refuses to save without a composer target", async () => {
    const harness = makeHarness();
    await expect(
      harness.unit.save({ type: "text", intent: "implement", body: "hello" }),
    ).resolves.toEqual({ ok: false, reasonKey: "composer.error.save" });
    expect(harness.store.notes()).toHaveLength(0);
  });

  it("saves a draft through the store, announces and re-renders", async () => {
    const harness = makeHarness();
    harness.settings.author = "  Dana  ";
    const { target, element } = connectedTarget();
    harness.unit.setTarget(target);

    const result = await harness.unit.save({ type: "text", intent: "implement", body: "a gap in the copy" });

    expect(result).toEqual({ ok: true });
    const notes = harness.store.notes();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.body).toBe("a gap in the copy");
    expect(notes[0]?.author).toBe("Dana");
    expect(harness.announced).toContain("a11y.liveSaved");
    expect(harness.renders).toBe(1);
    // The element is the anchor source, not a mutation of the host node.
    expect(element.textContent).toBe("a paragraph the reviewer marked");
  });

  it("refuses a draft whose element vanished before the save", async () => {
    const harness = makeHarness();
    const { target, element } = connectedTarget();
    harness.unit.setTarget(target);
    element.remove();

    await expect(
      harness.unit.save({ type: "text", intent: "implement", body: "late" }),
    ).resolves.toEqual({ ok: false, reasonKey: "composer.error.vanished" });
    expect(harness.store.notes()).toHaveLength(0);
  });

  it("reports an empty reply inline instead of writing", async () => {
    const harness = makeHarness();
    const note = await harness.store.create({
      type: "text",
      body: "reviewed",
      anchor: { quote: "reviewed" },
      intent: "implement",
    });

    await harness.unit.reply(note, "   ");

    expect(harness.panelErrors).toEqual([{ noteId: note.id, key: "panel.reply.empty" }]);
    expect(harness.store.notes()[0]?.messages).toHaveLength(0);
  });

  it("routes a failing mutation to onError and the note entry (NFR-14)", async () => {
    const harness = makeHarness();
    const note = await harness.store.create({
      type: "text",
      body: "reviewed",
      anchor: { quote: "reviewed" },
      intent: "implement",
    });
    const failure = new Error("store is read-only");

    await harness.unit.mutate(() => Promise.reject(failure), note);

    expect(harness.errors).toEqual([failure]);
    expect(harness.panelErrors).toEqual([{ noteId: note.id, key: "panel.error.action" }]);
  });

  it("drops the composer target on dispose() (FR-12.2)", async () => {
    const harness = makeHarness();
    const { target } = connectedTarget();
    harness.unit.setTarget(target);
    expect(harness.unit.target()).toBe(target);

    harness.unit.dispose();

    expect(harness.unit.target()).toBeNull();
    await expect(
      harness.unit.save({ type: "text", intent: "implement", body: "stale" }),
    ).resolves.toEqual({ ok: false, reasonKey: "composer.error.save" });
    expect(harness.store.notes()).toHaveLength(0);
  });
});
