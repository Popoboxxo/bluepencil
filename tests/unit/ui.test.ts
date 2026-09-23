/**
 * Unit tests of the review layer: lifecycle, capture UI, markers, panel, i18n, host safety.
 *
 * Covers: FR-1.1/1.3/1.4/1.5/1.6/1.7/1.8/1.9, FR-2.3/2.4, FR-4.1–4.8, FR-5.2/5.3/5.5, FR-8.1,
 * FR-9.3, FR-11.1/11.2, FR-12.1/12.2/12.6, NFR-2/NFR-15.
 *
 * Everything runs against the real `createStore` + `createMemoryAdapter` (no stubs of other
 * agents' modules) and a real jsdom document, so the wiring `src/index.ts` uses is exercised.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMemoryAdapter } from "../../src/adapters/memory";
import { resolveAnchor } from "../../src/core/anchor";
import { BluepencilValidationError, createNote, type Note, type NoteDraft } from "../../src/core/model";
import { createStore, type Store } from "../../src/core/store";
import { de } from "../../src/i18n/de";
import { en } from "../../src/i18n/en";
import type { MessageKey } from "../../src/i18n/en";
import { applyTranslations, createTranslator, translate, type Messages } from "../../src/i18n";
import { createLayer, type LayerHandle, type LayerOptions } from "../../src/ui/layer";
import { SHORTCUTS, legendGroups } from "../../src/ui/keymap";
import { noteCounters } from "../../src/ui/panel";
import { STYLES } from "../../src/ui/styles";

/* -------------------------------------------------------------------------- */
/* test doubles and helpers                                                    */
/* -------------------------------------------------------------------------- */

let observersCreated = 0;
let observersDisconnected = 0;

/** jsdom has no `ResizeObserver`; the layer must degrade — this double proves it disconnects. */
class FakeResizeObserver {
  constructor(_callback: () => void) {
    observersCreated += 1;
  }

  observe(): void {
    // geometry tracking is irrelevant for the assertions
  }

  unobserve(): void {
    // nothing to do
  }

  disconnect(): void {
    observersDisconnected += 1;
  }
}

interface ListenerTracker {
  /** Live listener count on document/window/body — the layer's whole event surface. */
  total(): number;
  restore(): void;
}

/** Event types the layer is allowed to use; anything else on those targets is not ours. */
const LAYER_EVENT_TYPES = new Set(["click", "change", "keydown", "scroll", "resize", "animationend"]);

/** Wrap add/removeEventListener on the three targets the layer may touch (NFR-15). */
function trackListeners(): ListenerTracker {
  const targets: EventTarget[] = [document, window, document.body];
  const originals: [EventTarget, EventTarget["addEventListener"], EventTarget["removeEventListener"]][] = [];
  const live = new Map<EventTarget, number>();

  for (const target of targets) {
    const originalAdd = target.addEventListener;
    const originalRemove = target.removeEventListener;
    originals.push([target, originalAdd, originalRemove]);
    live.set(target, 0);

    const wrappedAdd: EventTarget["addEventListener"] = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      if (LAYER_EVENT_TYPES.has(type)) live.set(target, (live.get(target) ?? 0) + 1);
      originalAdd.call(this, type, listener, options);
    };
    const wrappedRemove: EventTarget["removeEventListener"] = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ): void {
      if (LAYER_EVENT_TYPES.has(type)) live.set(target, (live.get(target) ?? 0) - 1);
      originalRemove.call(this, type, listener, options);
    };
    target.addEventListener = wrappedAdd;
    target.removeEventListener = wrappedRemove;
  }

  return {
    total: () => Array.from(live.values()).reduce((sum, value) => sum + value, 0),
    restore: () => {
      for (const [target, add, remove] of originals) {
        target.addEventListener = add;
        target.removeEventListener = remove;
      }
    },
  };
}

/** Microtask flush — no timers, so the tests never rely on the clock (NFR-2 discipline). */
async function flush(times = 16): Promise<void> {
  let chain = Promise.resolve();
  for (let index = 0; index < times; index += 1) {
    chain = chain.then(() => undefined);
  }
  await chain;
}

function makeStore(): Store {
  return createStore({ adapter: createMemoryAdapter() });
}

/** Minimal in-memory `Storage`, installed for the persistence test (jsdom ships none here). */
function installStorage(): { storage: Storage; restore(): void } {
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length(): number {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => Array.from(entries.keys())[index] ?? null,
    removeItem: (key: string) => {
      entries.delete(key);
    },
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
  const original = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true, writable: true });
  return {
    storage,
    restore: () => {
      if (original) Object.defineProperty(window, "localStorage", original);
      else Reflect.deleteProperty(window, "localStorage");
    },
  };
}

/**
 * Handles created by `startLayer`. A failing assertion must not leak a live layer — and with it a
 * document-level key listener — into the next test, which would fail for the wrong reason.
 */
const liveHandles: LayerHandle[] = [];

function startLayer(store: Store, extra: Partial<LayerOptions> = {}): LayerHandle {
  const handle = createLayer({ store, document, ...extra });
  handle.enable();
  liveHandles.push(handle);
  return handle;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`test fixture is missing #${id}`);
  return found as T;
}

function query<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector(selector);
  if (found === null) throw new Error(`expected the layer to render ${selector}`);
  return found as T;
}

function root(): HTMLElement {
  return query('[data-bp-part="root"]');
}

function mode(): string | null {
  return root().getAttribute("data-bp-mode");
}

function composer(): HTMLElement {
  return query('[data-bp-part="composer"]');
}

function panelEl(): HTMLElement {
  return query('[data-bp-part="panel"]');
}

function legendEl(): HTMLElement {
  return query('[data-bp-part="legend"]');
}

function noteEntries(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[data-bp-part="note"]')).filter(
    (node): node is HTMLElement => node instanceof HTMLElement,
  );
}

function barButton(action: string): HTMLElement {
  return query(`[data-bp-part="bar"] [data-bp-action="${action}"]`);
}

function markerCount(): number {
  return document.querySelectorAll('[data-bp-part="marker"]').length;
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function pressKey(key: string, init: KeyboardEventInit = {}): void {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
  );
}

/** Simulate a text selection (FR-1.5) with a real DOM Range. */
function selectText(node: Node, start: number, end: number): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = document.getSelection();
  if (selection === null) throw new Error("jsdom provided no Selection");
  selection.removeAllRanges();
  selection.addRange(range);
}

function writeComposerBody(value: string): void {
  const textarea = composer().querySelector("textarea");
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("composer has no textarea");
  textarea.value = value;
}

async function saveComposer(value: string): Promise<void> {
  writeComposerBody(value);
  click(query('[data-bp-part="composer"] [data-bp-action="composer-save"]'));
  await flush();
}

async function addNote(store: Store, draft: Partial<NoteDraft> = {}): Promise<Note> {
  return store.create({
    type: draft.type ?? "text",
    body: draft.body ?? "note body",
    anchor: draft.anchor ?? { hook: "seed" },
    ...(draft.status !== undefined ? { status: draft.status } : {}),
    ...(draft.intent !== undefined ? { intent: draft.intent } : {}),
    ...(draft.now !== undefined ? { now: draft.now } : {}),
    ...(draft.environment !== undefined ? { environment: draft.environment } : {}),
  });
}

function statuses(): (string | null)[] {
  return noteEntries().map((entry) => entry.getAttribute("data-bp-status"));
}

function intents(): (string | null)[] {
  return noteEntries().map((entry) => entry.getAttribute("data-bp-intent"));
}

/** Collected `data-bp-i18n*` markers: key -> rendered label. */
const I18N_TARGET_ATTRIBUTE: Record<string, string> = {
  "data-bp-i18n-aria": "aria-label",
  "data-bp-i18n-title": "title",
  "data-bp-i18n-placeholder": "placeholder",
};

function collectLabels(scope: ParentNode): Map<string, string> {
  const labels = new Map<string, string>();
  for (const attribute of ["data-bp-i18n", ...Object.keys(I18N_TARGET_ATTRIBUTE)]) {
    for (const node of Array.from(scope.querySelectorAll(`[${attribute}]`))) {
      const key = node.getAttribute(attribute);
      if (key === null) continue;
      const target = I18N_TARGET_ATTRIBUTE[attribute];
      const value = target === undefined ? (node.textContent ?? "") : (node.getAttribute(target) ?? "");
      labels.set(key, value);
    }
  }
  return labels;
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.getSelection()?.removeAllRanges();
  // jsdom without `--localstorage-file` has no storage — the layer must survive that (NFR-5).
  (window as unknown as { localStorage?: Storage }).localStorage?.clear();
  observersCreated = 0;
  observersDisconnected = 0;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
});

afterEach(() => {
  for (const handle of liveHandles.splice(0)) {
    try {
      handle.disable();
    } catch {
      // Teardown must not mask the assertion that just failed.
    }
  }
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  document.body.innerHTML = "";
});

/* -------------------------------------------------------------------------- */
/* lifecycle (FR-12.1/12.2, NFR-1/NFR-15)                                      */
/* -------------------------------------------------------------------------- */

describe("layer lifecycle", () => {
  it("renders nothing while it is not enabled (FR-1.1)", async () => {
    document.body.innerHTML = `<main id="host"><p>host text</p></main>`;
    const tracker = trackListeners();
    const store = makeStore();
    const handle = createLayer({ store, document });
    await flush();

    expect(handle.isEnabled()).toBe(false);
    expect(document.querySelector('[data-bp-part="root"]')).toBeNull();
    expect(document.querySelectorAll("style[data-bp-styles]").length).toBe(0);
    expect(tracker.total()).toBe(0);
    expect(observersCreated).toBe(0);
    expect(byId("host").textContent).toBe("host text");
    expect(store.notes()).toEqual([]);

    tracker.restore();
  });

  it("is idempotent over 20 enable/disable cycles (FR-12.2, NFR-15)", () => {
    document.body.innerHTML = `<main id="host"><p data-bluepencil="p1">hello</p></main>`;
    const tracker = trackListeners();
    const store = makeStore();
    const handle = createLayer({ store, document });

    const nodesBefore = document.getElementsByTagName("*").length;
    const stylesBefore = document.querySelectorAll("style").length;
    const listenersBefore = tracker.total();

    for (let cycle = 0; cycle < 20; cycle += 1) {
      handle.enable();
      expect(handle.isEnabled()).toBe(true);
      handle.disable();
      expect(handle.isEnabled()).toBe(false);
      expect(document.querySelector('[data-bp-part="root"]')).toBeNull();
    }

    // double enable / double disable are no-ops
    handle.enable();
    handle.enable();
    handle.disable();
    handle.disable();

    expect(document.getElementsByTagName("*").length).toBe(nodesBefore);
    expect(document.querySelectorAll("style").length).toBe(stylesBefore);
    expect(document.querySelectorAll("style[data-bp-styles]").length).toBe(0);
    expect(tracker.total()).toBe(listenersBefore);
    expect(observersCreated).toBeGreaterThan(0);
    expect(observersDisconnected).toBe(observersCreated);

    tracker.restore();
  });

  it("keeps one style node per document shared by two instances (FR-12.2)", () => {
    const mountA = document.createElement("div");
    const mountB = document.createElement("div");
    document.body.append(mountA, mountB);
    const layerA = createLayer({ store: makeStore(), document, mount: mountA });
    const layerB = createLayer({ store: makeStore(), document, mount: mountB });

    layerA.enable();
    layerB.enable();
    expect(document.querySelectorAll("style[data-bp-styles]").length).toBe(1);
    expect(mountA.querySelectorAll('[data-bp-part="root"]').length).toBe(1);
    expect(mountB.querySelectorAll('[data-bp-part="root"]').length).toBe(1);

    layerA.disable();
    expect(document.querySelectorAll("style[data-bp-styles]").length).toBe(1);
    layerB.disable();
    expect(document.querySelectorAll("style[data-bp-styles]").length).toBe(0);
  });

  it("treats enable() as a no-op while already enabled (idempotent, NFR-15)", () => {
    document.body.innerHTML = `<main id="host"></main>`;
    const handle = startLayer(makeStore());
    const nodesAfterFirst = document.getElementsByTagName("*").length;
    handle.enable();
    handle.enable();
    expect(document.getElementsByTagName("*").length).toBe(nodesAfterFirst);
    expect(document.querySelectorAll('[data-bp-part="root"]').length).toBe(1);
    handle.disable();
  });
});

/* -------------------------------------------------------------------------- */
/* capture (FR-1.3/1.4/1.5, FR-2.2/2.3)                                       */
/* -------------------------------------------------------------------------- */

describe("capture UI", () => {
  it("creates a text note with the hook anchor, the route and the selection quote (FR-1.3/1.5)", async () => {
    document.body.innerHTML = `<main id="host"><p data-bluepencil="intro">Hello world of notes</p></main>`;
    const paragraph = byId("host").querySelector("p");
    if (paragraph === null || paragraph.firstChild === null) throw new Error("fixture missing");
    selectText(paragraph.firstChild, 0, 5);

    const store = makeStore();
    const handle = startLayer(store, { getRoute: () => "/review/page" });

    pressKey("c");
    expect(mode()).toBe("text");
    click(paragraph);
    expect(composer().hidden).toBe(false);

    await saveComposer("Please make this friendlier.");

    const notes = store.notes();
    expect(notes).toHaveLength(1);
    const note = notes[0];
    expect(note?.type).toBe("text");
    expect(note?.anchor.hook).toBe("intro");
    expect(note?.anchor.route).toBe("/review/page");
    expect(note?.anchor.quote).toBe("Hello");
    // FR-2.1: the hook is stored as the primary anchor, the CSS path as the fallback, and the
    // anchor resolves back to the very element that was clicked.
    expect(note?.anchor.selector ?? "").toBeTruthy();
    expect(note === undefined ? null : resolveAnchor(note.anchor)).toBe(paragraph);
    expect(note?.body).toBe("Please make this friendlier.");
    expect(note?.intent).toBe("implement");
    expect(note?.status).toBe("open");
    expect(note?.authorType).toBe("human");
    expect(note?.source).toBe("ui:human");
    expect(note?.context).toBeNull();
    expect(composer().hidden).toBe(true);

    handle.disable();
  });

  it("asks the host for the route of the annotated element, not of the viewport (FR-2.4)", async () => {
    document.body.innerHTML = `
      <main id="host">
        <section data-chapter="kapitel-05"><p data-bluepencil="intro">Hello world of notes</p></section>
      </main>`;
    const paragraph = byId("host").querySelector("p");
    if (paragraph === null) throw new Error("fixture missing");

    const seen: Array<Element | undefined> = [];
    const store = makeStore();
    const handle = startLayer(store, {
      getRoute: (element) => {
        seen.push(element);
        return element?.closest("section")?.getAttribute("data-chapter") ?? "";
      },
    });

    pressKey("c");
    click(paragraph);
    await saveComposer("Kapitelnotiz.");

    // The route comes from the clicked element's own chapter. Before this, the host was called without
    // arguments, the answer was "" and the note lost its chapter — on the AI-Extremismus one-pager a
    // measured 2 of 8 attributed chapters were wrong that way.
    expect(store.notes()[0]?.anchor.route).toBe("kapitel-05");
    expect(seen[0]).toBe(paragraph);

    handle.disable();
  });

  it("keeps links operable in every annotation mode (FR-1.9, issue #2)", async () => {
    document.body.innerHTML = `
      <main id="host">
        <p data-bluepencil="intro">See <a href="#ziel" data-testid="link">the harness list</a> for details</p>
      </main>`;
    const link = query('[data-testid="link"]');
    const store = makeStore();
    const handle = startLayer(store, {});

    pressKey("c");
    click(link);

    // The link stays a link: no composer opens and nothing is stored.
    expect(composer().hidden).toBe(true);
    expect(store.notes()).toHaveLength(0);

    // The surrounding text still opens it, so the mode itself is working.
    const paragraph = byId("host").querySelector("p");
    if (paragraph === null) throw new Error("fixture missing");
    click(paragraph);
    expect(composer().hidden).toBe(false);

    handle.disable();
  });

  it("honours can-annotate: a rejected element opens nothing, an accepted one does (FR-1.10)", async () => {
    document.body.innerHTML = `
      <main id="host">
        <p data-bluepencil="intro">Yes</p>
        <aside data-bluepencil="side">No</aside>
      </main>`;
    const store = makeStore();
    const handle = startLayer(store, { canAnnotate: (element) => element.tagName !== "ASIDE" });

    pressKey("c");
    const aside = byId("host").querySelector("aside");
    if (aside === null) throw new Error("fixture missing");
    click(aside);
    expect(composer().hidden).toBe(true);
    expect(store.notes()).toHaveLength(0);

    const paragraph = byId("host").querySelector("p");
    if (paragraph === null) throw new Error("fixture missing");
    click(paragraph);
    expect(composer().hidden).toBe(false);

    handle.disable();
  });

  it("uses a registered selector as the target, so the component is the anchor (FR-1.12, issue #3)", async () => {
    document.body.innerHTML = `
      <main id="host">
        <article class="card" data-bluepencil="card-1">
          <h3 class="card-title">Umsatz 42</h3>
        </article>
      </main>`;
    const store = makeStore();
    const handle = startLayer(store, { annotateSelectors: [".card"] });

    pressKey("c");
    click(query(".card-title"));
    expect(composer().hidden).toBe(false);
    await saveComposer("Karte prüfen");

    const notes = store.notes();
    expect(notes).toHaveLength(1);
    const note = notes[0];
    if (note === undefined) throw new Error("note was not stored");
    // The registered `.card` wins over the "nearest text" heuristic: the anchor is the component,
    // not the heading inside it.
    expect(JSON.stringify(note.anchor)).toContain("card");
    expect(JSON.stringify(note.anchor)).not.toContain("h3");

    handle.disable();
  });

  it("bounds the unit in design mode too when the host registered it (FR-1.12)", async () => {
    document.body.innerHTML = `
      <main id="host">
        <article class="card" data-bluepencil="card-1">
          <h3 class="card-title">Umsatz 42</h3>
        </article>
      </main>`;
    const store = makeStore();
    const handle = startLayer(store, { annotateSelectors: [".card"] });

    pressKey("d");
    click(query(".card-title"));
    expect(composer().hidden).toBe(false);
    await saveComposer("Ganze Karte");

    const notes = store.notes();
    expect(notes).toHaveLength(1);
    const note = notes[0];
    if (note === undefined) throw new Error("note was not stored");
    expect(JSON.stringify(note.anchor)).toContain("card");
    expect(JSON.stringify(note.anchor)).not.toContain("h3");

    handle.disable();
  });

  it("keeps a component whose text lives in children annotatable (issue #3)", async () => {
    document.body.innerHTML = `
      <main id="host">
        <div class="tile" data-bluepencil="tile-1"><span>Umsatz</span></div>
      </main>`;
    const store = makeStore();
    const handle = startLayer(store);

    pressKey("c");
    click(query(".tile"));

    // Before the fallback this click ended as `null` — the component looked inert, without a message.
    expect(composer().hidden).toBe(false);

    handle.disable();
  });

  it("still passes links through inside a registered card (FR-1.9 before FR-1.12)", async () => {
    document.body.innerHTML = `
      <main id="host">
        <article class="card" data-bluepencil="card-1">
          <a href="#ziel" data-testid="card-link">weiter</a>
        </article>
      </main>`;
    const store = makeStore();
    const handle = startLayer(store, { annotateSelectors: [".card"] });

    pressKey("c");
    click(query('[data-testid="card-link"]'));

    expect(composer().hidden).toBe(true);
    expect(store.notes()).toHaveLength(0);

    handle.disable();
  });

  it("switches the layer's own chrome between full, quiet and off (FR-12.9)", () => {
    document.body.innerHTML = `<main id="host"><p data-bluepencil="a">Text</p></main>`;
    const store = makeStore();
    const handle = startLayer(store);
    const bar = query('[data-bp-part="bar"]');
    const chromeHandle = query('[data-bp-part="handle"]');

    expect(handle.chrome()).toBe("full");
    expect(bar.hidden).toBe(false);
    expect(chromeHandle.hidden).toBe(true);

    handle.setChrome("quiet");
    expect(bar.hidden).toBe(true);
    expect(chromeHandle.hidden).toBe(false);

    handle.setChrome("off");
    expect(bar.hidden).toBe(true);
    expect(chromeHandle.hidden).toBe(true);

    handle.setChrome("full");
    expect(bar.hidden).toBe(false);
    expect(chromeHandle.hidden).toBe(true);

    // "off" is not teardown: disable() is what removes the nodes (NFR-15).
    handle.disable();
    expect(document.querySelector('[data-bp-part="bar"]')).toBeNull();
  });

  it("cycles the chrome level with the registry key (FR-12.9)", () => {
    document.body.innerHTML = `<main id="host"><p data-bluepencil="a">Text</p></main>`;
    const store = makeStore();
    const handle = startLayer(store);

    pressKey("c"); // own the keyboard
    expect(handle.chrome()).toBe("full");
    pressKey("h");
    expect(handle.chrome()).toBe("quiet");
    pressKey("h");
    expect(handle.chrome()).toBe("off");
    pressKey("h");
    expect(handle.chrome()).toBe("full");

    handle.disable();
  });

  it("persists the level across a reload (FR-12.9)", () => {
    document.body.innerHTML = `<main id="host"><p data-bluepencil="a">Text</p></main>`;
    const { storage, restore } = installStorage();
    try {
      const first = startLayer(makeStore());
      first.setChrome("quiet");
      first.disable();

      const stored = Array.from({ length: storage.length }, (_, index) => storage.key(index))
        .map((key) => (key === null ? "" : String(storage.getItem(key))))
        .join(" ");
      expect(stored).toContain('"chromeLevel":"quiet"');

      const second = startLayer(makeStore());
      expect(second.chrome()).toBe("quiet");
      expect(query('[data-bp-part="bar"]').hidden).toBe(true);
      second.disable();
    } finally {
      restore();
    }
  });

  it("applies ?bp-chrome= for one load without persisting it (FR-12.12)", () => {
    document.body.innerHTML = `<main id="host"><p data-bluepencil="a">Text</p></main>`;
    const { storage, restore } = installStorage();
    try {
      window.history.replaceState({}, "", "?bp-chrome=off");

      const handle = startLayer(makeStore());
      expect(handle.chrome()).toBe("off");
      expect(query('[data-bp-part="bar"]').hidden).toBe(true);
      expect(query('[data-bp-part="handle"]').hidden).toBe(true);

      // Read-only for this load: nothing was written back.
      const written = Array.from({ length: storage.length }, (_, index) => storage.key(index))
        .map((key) => (key === null ? "" : String(storage.getItem(key))))
        .join(" ");
      expect(written).not.toContain("chromeLevel");

      // An explicit change wins over the parameter — and only that one is persisted.
      handle.setChrome("full");
      expect(handle.chrome()).toBe("full");
      expect(query('[data-bp-part="bar"]').hidden).toBe(false);

      handle.disable();
    } finally {
      window.history.replaceState({}, "", "/");
      restore();
    }
  });

  it("acts on every key the registry documents (FR-1.11)", () => {
    document.body.innerHTML = `<main id="host"><p data-bluepencil="a">Text</p></main>`;
    const store = makeStore();
    const handle = startLayer(store);

    // Keep the layer owning the keyboard, so "swallowed" is the signal that it acted.
    const ensureOwned = (): void => {
      if (mode() === "off" && panelEl().hidden) pressKey("l");
    };
    const documented: string[] = [];
    for (const shortcut of SHORTCUTS) {
      if (shortcut.range !== undefined || (shortcut.scope ?? "document") === "composer") continue;
      for (const key of shortcut.keys) {
        ensureOwned();
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        document.body.dispatchEvent(event);
        // A documented key must be owned by the layer: the prototype's legend advertised keys the
        // handler did not accept, and nothing failed.
        expect(event.defaultPrevented, `documented key "${key}" (${shortcut.id}) was ignored`).toBe(true);
        documented.push(key);
      }
    }
    expect(documented).toEqual(["c", "d", "l", "f", "b", "h", "?", "Escape", "j", "k"]);

    handle.disable();
  });

  it("renders the legend from the registry, not from a hand-written list (FR-1.11)", () => {
    document.body.innerHTML = `<main id="host"><p data-bluepencil="a">Text</p></main>`;
    const store = makeStore();
    const handle = startLayer(store);

    pressKey("?");
    const rendered = Array.from(legendEl().querySelectorAll('[data-bp-part="legend-row"]')).map((row) => ({
      keys: Array.from(row.querySelectorAll("kbd")).map((kbd) => kbd.textContent ?? ""),
      label: row.querySelector("[data-bp-i18n]")?.getAttribute("data-bp-i18n") ?? "",
    }));
    const expected = legendGroups().flatMap((group) =>
      group.rows.map((row) => ({ keys: [...row.keys], label: row.label })),
    );
    expect(rendered).toEqual(expected);

    handle.disable();
  });

  it("lets the host remap a key — it acts and the legend shows the new one (FR-12.11)", () => {
    document.body.innerHTML = `<main id="host"><p data-bluepencil="a">Text</p></main>`;
    const store = makeStore();
    const handle = startLayer(store, { keymap: { bar: "g" } });

    pressKey("c"); // own the keyboard
    const bar = query('[data-bp-part="bar"]');
    expect(bar.hidden).toBe(false);

    pressKey("g");
    expect(bar.hidden).toBe(true);

    // The old key does not do it any more — and it is documented nowhere either.
    pressKey("b");
    expect(bar.hidden).toBe(true);

    pressKey("?");
    const barRow = Array.from(legendEl().querySelectorAll('[data-bp-part="legend-row"]')).find(
      (row) => row.querySelector("[data-bp-i18n]")?.getAttribute("data-bp-i18n") === "legend.key.bar",
    );
    expect(Array.from(barRow?.querySelectorAll("kbd") ?? []).map((kbd) => kbd.textContent)).toEqual(["G"]);

    handle.disable();
  });

  it("shows every chrome surface in a declared slot (FR-12.10)", () => {
    document.body.innerHTML = `<main id="host"><p data-bluepencil="a">Text</p></main>`;
    const store = makeStore();
    const handle = startLayer(store, { dock: "bottom" });

    expect(query('[data-bp-part="bar"]').getAttribute("data-bp-slot")).toBe("top-end");
    expect(query('[data-bp-part="handle"]').getAttribute("data-bp-slot")).toBe("top-end");
    expect(query('[data-bp-part="mode-hint"]').getAttribute("data-bp-slot")).toBe("bottom-center");
    expect(document.querySelector(".bp-root")?.getAttribute("data-bp-dock")).toBe("bottom");

    handle.disable();
  });

  it("drops to quiet on a narrow viewport and back when it grows (FR-12.13)", () => {
    document.body.innerHTML = `<main id="host"><p data-bluepencil="a">Text</p></main>`;
    const store = makeStore();
    const original = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const setWidth = (width: number): void => {
      Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
    };
    try {
      setWidth(1280);
      const handle = startLayer(store);
      expect(query('[data-bp-part="bar"]').hidden).toBe(false);
      expect(handle.chrome()).toBe("full"); // the preference is untouched by the viewport

      setWidth(390);
      window.dispatchEvent(new Event("resize"));
      expect(query('[data-bp-part="bar"]').hidden).toBe(true);
      expect(query('[data-bp-part="handle"]').hidden).toBe(false);
      expect(handle.chrome()).toBe("full"); // narrow is a viewport fact, not a stored choice

      setWidth(1024);
      window.dispatchEvent(new Event("resize"));
      expect(query('[data-bp-part="bar"]').hidden).toBe(false);
      expect(query('[data-bp-part="handle"]').hidden).toBe(true);

      handle.disable();
    } finally {
      if (original !== undefined) Object.defineProperty(window, "innerWidth", original);
    }
  });

  it("captures the element state in design mode (FR-1.4)", async () => {
    document.body.innerHTML = `<main id="host"><div class="card" data-bluepencil="card">card</div></main>`;
    const card = byId("host").querySelector(".card");
    if (card === null) throw new Error("fixture missing");

    const store = makeStore();
    const handle = startLayer(store, { buildRef: "abc1234" });

    pressKey("d");
    expect(mode()).toBe("design");
    click(card);

    const captured = query('[data-bp-part="composer-captured"]');
    expect(captured.hidden).toBe(false);
    expect(captured.textContent).toContain("card");

    await saveComposer("Spacing looks off.");

    const note = store.notes()[0];
    expect(note?.type).toBe("design");
    expect(note?.context).not.toBeNull();
    expect(note?.context?.tag).toBe("div");
    expect(note?.context?.classes).toContain("card");
    expect(note?.context?.buildRef).toBe("abc1234");
    expect(note?.context?.viewport).toEqual({ w: window.innerWidth, h: window.innerHeight });
    expect(note?.context?.scheme === "light" || note?.context?.scheme === "dark").toBe(true);
    expect(Object.keys(note?.context?.styles ?? {}).length).toBeGreaterThan(5);

    handle.disable();
  });

  it("refuses to save when the element is gone (FR-2.3)", async () => {
    document.body.innerHTML = `<main id="host"><p data-bluepencil="gone">text</p></main>`;
    const paragraph = byId("host").querySelector("p");
    if (paragraph === null) throw new Error("fixture missing");

    const store = makeStore();
    const handle = startLayer(store);
    pressKey("c");
    click(paragraph);
    expect(composer().hidden).toBe(false);

    // The host re-renders: the anchor is no longer resolvable anywhere.
    byId("host").textContent = "";
    await saveComposer("does not matter");

    expect(store.notes()).toHaveLength(0);
    const error = query('[data-bp-part="composer-error"]');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe(en["composer.error.vanished"]);
    expect(composer().hidden).toBe(false);

    handle.disable();
  });

  it("pre-selects intent=feedback in feedback-only mode (FR-5.2)", async () => {
    document.body.innerHTML = `<main id="host"><p data-bluepencil="p1">text</p></main>`;
    const paragraph = byId("host").querySelector("p");
    if (paragraph === null) throw new Error("fixture missing");

    const store = makeStore();
    const handle = startLayer(store);
    click(barButton("feedback-only"));

    pressKey("c");
    click(paragraph);
    const feedbackButton = query('[data-bp-action="composer-intent-feedback"]');
    expect(feedbackButton.getAttribute("aria-pressed")).toBe("true");
    expect(query('[data-bp-part="composer-feedback-note"]').hidden).toBe(false);

    await saveComposer("Just an opinion.");
    expect(store.notes()[0]?.intent).toBe("feedback");

    handle.disable();
  });

  it("cancels with Esc, restores focus and stores nothing (FR-11.2)", async () => {
    document.body.innerHTML = `<main id="host"><p data-bluepencil="p1">text</p></main>`;
    const paragraph = byId("host").querySelector("p");
    if (paragraph === null) throw new Error("fixture missing");
    paragraph.tabIndex = 0;
    paragraph.focus();

    const store = makeStore();
    const handle = startLayer(store);
    pressKey("c");
    click(paragraph);
    expect(composer().hidden).toBe(false);

    pressKey("Escape");
    expect(composer().hidden).toBe(true);
    expect(document.activeElement).toBe(paragraph);
    expect(store.notes()).toHaveLength(0);
    // Esc closed the composer, not the mode
    expect(mode()).toBe("text");
    pressKey("Escape");
    expect(mode()).toBe("off");

    handle.disable();
  });
});

/* -------------------------------------------------------------------------- */
/* markers and panel (FR-4.1–4.8)                                              */
/* -------------------------------------------------------------------------- */

describe("markers and panel", () => {
  it("collapses notes on one element into a single marker with a count (FR-4.1)", async () => {
    document.body.innerHTML = `<main id="host"><p data-bluepencil="p1">text</p></main>`;
    const store = makeStore();
    const first = await addNote(store, { body: "first", anchor: { hook: "p1" } });
    const second = await addNote(store, { body: "second", anchor: { hook: "p1" } });
    const handle = startLayer(store);

    expect(markerCount()).toBe(1);
    const marker = query('[data-bp-part="marker"]');
    expect(marker.getAttribute("data-bp-count")).toBe("2");
    expect(query('[data-bp-part="marker-count"]').textContent).toBe("2");
    expect(marker.getAttribute("aria-label")).toBe(en["a11y.markerCount"].replace("{count}", "2"));

    // done notes leave the markers as well (FR-4.3)
    await store.setStatus(first.id, "done");
    expect(markerCount()).toBe(1);
    expect(query('[data-bp-part="marker-count"]').textContent).toBe("");

    await store.setStatus(second.id, "done");
    expect(markerCount()).toBe(0);
    handle.disable();
  });

  it("hides done notes by default and reveals them with one control (FR-4.3/4.4)", async () => {
    document.body.innerHTML = `<main id="host"><p data-bluepencil="a">A</p><p data-bluepencil="b">B</p></main>`;
    const store = makeStore();
    await addNote(store, { body: "still open", anchor: { hook: "a" } });
    await addNote(store, { body: "already finished", anchor: { hook: "b" }, status: "done" });
    const handle = startLayer(store);

    pressKey("l");
    expect(panelEl().hidden).toBe(false);
    expect(noteEntries()).toHaveLength(1);
    expect(noteEntries()[0]?.textContent).toContain("still open");
    expect(markerCount()).toBe(1);
    expect(query('[data-bp-part="panel-status"]').textContent).toContain(en["panel.doneHidden"]);

    click(barButton("show-done"));
    expect(noteEntries()).toHaveLength(2);
    expect(markerCount()).toBe(2);
    handle.disable();
  });

  it("orders needs_decision, then feedback, then the rest (FR-4.6)", async () => {
    const store = makeStore();
    await addNote(store, { body: "plain open", now: "2026-01-01T10:00:00.000Z" });
    await addNote(store, { body: "assessment wanted", intent: "feedback", now: "2026-01-01T11:00:00.000Z" });
    await addNote(store, { body: "please decide", status: "needs_decision", now: "2026-01-01T12:00:00.000Z" });
    await addNote(store, { body: "finished", status: "done", now: "2026-01-01T09:00:00.000Z" });
    const handle = startLayer(store);

    click(barButton("show-done"));
    expect(statuses()).toEqual(["needs_decision", "open", "open", "done"]);
    expect(intents()).toEqual(["implement", "feedback", "implement", "implement"]);
    expect(noteEntries()[0]?.textContent).toContain("please decide");
    handle.disable();
  });

  it("keeps the bar counters in sync with the store (FR-4.8)", async () => {
    const store = makeStore();
    await addNote(store, { body: "a" });
    await addNote(store, { body: "b", status: "needs_decision" });
    await addNote(store, { body: "c", intent: "feedback" });
    await addNote(store, { body: "d", status: "done" });
    const handle = startLayer(store);
    const counters = (): (string | null)[] =>
      (["total", "open", "decisions", "feedback"] as const).map(
        (key) => query(`[data-bp-part="counter-${key}"]`).textContent,
      );

    expect(counters()).toEqual(["3", "2", "1", "1"]);
    await addNote(store, { body: "e" });
    expect(counters()).toEqual(["4", "3", "1", "1"]);
    handle.disable();
  });

  it("filters the list by type, intent and status (FR-4.2)", async () => {
    const store = makeStore();
    await addNote(store, { body: "text work" });
    await addNote(store, { body: "design work", type: "design" });
    await addNote(store, { body: "opinion wanted", intent: "feedback" });
    const handle = startLayer(store);

    pressKey("l");
    expect(noteEntries()).toHaveLength(3);

    const typeFilter = query<HTMLSelectElement>('[data-bp-filter="type"]');
    typeFilter.value = "design";
    typeFilter.dispatchEvent(new Event("change", { bubbles: true }));
    expect(noteEntries()).toHaveLength(1);
    expect(noteEntries()[0]?.textContent).toContain("design work");

    typeFilter.value = "all";
    typeFilter.dispatchEvent(new Event("change", { bubbles: true }));
    const intentFilter = query<HTMLSelectElement>('[data-bp-filter="intent"]');
    intentFilter.value = "feedback";
    intentFilter.dispatchEvent(new Event("change", { bubbles: true }));
    expect(noteEntries()).toHaveLength(1);
    expect(noteEntries()[0]?.textContent).toContain("opinion wanted");
    handle.disable();
  });

  it("marks unresolvable notes as orphaned with a jump-not-possible hint (FR-2.4/4.7)", async () => {
    document.body.innerHTML = `<main id="host"><p data-bluepencil="a">A</p></main>`;
    const store = makeStore();
    await addNote(store, { body: "alive", anchor: { hook: "a" } });
    await addNote(store, { body: "dead", anchor: { hook: "vanished", selector: "#nowhere" } });
    const handle = startLayer(store);

    pressKey("l");
    const orphan = noteEntries().find((entry) => entry.textContent?.includes("dead"));
    expect(orphan?.classList.contains("is-orphaned")).toBe(true);
    expect(orphan?.querySelector('[data-bp-part="badge-orphaned"]')?.textContent).toBe(en["panel.orphaned"]);
    expect(orphan?.querySelector('[data-bp-part="orphan-hint"]')?.textContent).toBe(en["panel.orphanedHint"]);
    expect(orphan?.querySelector('[data-bp-action="jump"]')?.hasAttribute("disabled")).toBe(true);
    expect(markerCount()).toBe(1);
    handle.disable();
  });

  it("jumps to and highlights a resolvable entry without touching the host (FR-4.7)", async () => {
    document.body.innerHTML = `<main id="host"><p data-bluepencil="a">A</p></main>`;
    const store = makeStore();
    await addNote(store, { body: "jump me", anchor: { hook: "a" } });
    const handle = startLayer(store);

    pressKey("l");
    click(query('[data-bp-action="jump"]'));
    expect(noteEntries()[0]?.classList.contains("is-selected")).toBe(true);
    const highlight = query('[data-bp-part="highlight"]');
    expect(highlight.hidden).toBe(false);
    expect(byId("host").querySelector("[style]")).toBeNull();

    // the highlight cleans itself up on the CSS animation end — no timer (NFR-2)
    highlight.dispatchEvent(new Event("animationend"));
    expect(highlight.hidden).toBe(true);
    handle.disable();
  });

  it("navigates the list with J and K (FR-1.6)", async () => {
    const store = makeStore();
    await addNote(store, { body: "one", now: "2026-01-01T10:00:00.000Z" });
    await addNote(store, { body: "two", now: "2026-01-01T11:00:00.000Z" });
    const handle = startLayer(store);
    const selectedText = (): string =>
      noteEntries()
        .filter((entry) => entry.classList.contains("is-selected"))
        .map((entry) => entry.textContent ?? "")
        .join("");

    pressKey("j");
    expect(panelEl().hidden).toBe(false);
    expect(selectedText()).toContain("one");
    pressKey("j");
    expect(selectedText()).toContain("two");
    pressKey("k");
    expect(selectedText()).toContain("one");
    // digits jump straight to a list position (FR-1.6)
    pressKey("2");
    expect(selectedText()).toContain("two");
    pressKey("9");
    expect(selectedText()).toContain("two");
    handle.disable();
  });
});

/* -------------------------------------------------------------------------- */
/* threads, deletion and settings (FR-5.5, FR-8.1, FR-4.5)                      */
/* -------------------------------------------------------------------------- */

describe("threads, deletion and settings", () => {
  it("answers a pending decision in the thread and reopens the note (FR-5.5)", async () => {
    const store = makeStore();
    const note = await addNote(store, { body: "needs a call", status: "needs_decision" });
    const handle = startLayer(store, { identity: { getUser: () => ({ name: "Dana" }) } });

    pressKey("l");
    const replyInput = query<HTMLTextAreaElement>('[data-bp-part="reply-input"]');
    replyInput.value = "Go with option B.";
    click(query('[data-bp-action="reply"]'));
    await flush();

    const updated = store.notes().find((candidate) => candidate.id === note.id);
    expect(updated?.status).toBe("open");
    const messages = updated?.messages ?? [];
    const last = messages[messages.length - 1];
    expect(last?.kind).toBe("decision");
    expect(last?.authorType).toBe("human");
    expect(last?.author).toBe("Dana");
    expect(last?.text).toBe("Go with option B.");
    expect(query('[data-bp-part="message"]').textContent).toContain("Go with option B.");
    handle.disable();
  });

  it("switches the intent of an existing note both ways (FR-5.3)", async () => {
    const store = makeStore();
    const note = await addNote(store, { body: "implement me" });
    const handle = startLayer(store);

    pressKey("l");
    click(query('[data-bp-action="toggle-intent"]'));
    await flush();
    expect(store.notes()[0]?.intent).toBe("feedback");
    click(query('[data-bp-action="toggle-intent"]'));
    await flush();
    expect(store.notes()[0]?.intent).toBe("implement");
    expect(store.notes()[0]?.id).toBe(note.id);
    handle.disable();
  });

  it("deletes a single note only after an explicit confirmation (FR-8.1)", async () => {
    const store = makeStore();
    await addNote(store, { body: "delete me" });
    const handle = startLayer(store);

    pressKey("l");
    const remove = query('[data-bp-action="delete"]');
    click(remove);
    expect(store.notes()).toHaveLength(1);
    expect(remove.textContent).toBe(en["panel.action.confirmDelete"]);

    click(remove);
    await flush();
    expect(store.notes()).toHaveLength(0);
    expect(noteEntries()).toHaveLength(0);
    handle.disable();
  });

  it("persists settings, switches language at runtime and resets to defaults (FR-4.5/11.1)", async () => {
    const installed = installStorage();
    try {
      const store = makeStore();
      await addNote(store, { body: "done work", status: "done" });
      const handle = startLayer(store, { language: "de" });
      const key = `bluepencil:ui:${window.location.host}:v1`;

      pressKey("l");
      expect(noteEntries()).toHaveLength(0);

      const showDone = query<HTMLInputElement>('[data-bp-setting="show-done"]');
      showDone.checked = true;
      showDone.dispatchEvent(new Event("change", { bubbles: true }));
      expect(noteEntries()).toHaveLength(1);
      expect(noteEntries()[0]?.textContent).toContain("done work");

      const language = query<HTMLSelectElement>('[data-bp-setting="language"]');
      language.value = "en";
      language.dispatchEvent(new Event("change", { bubbles: true }));
      expect(collectLabels(root()).get("panel.hideDone")).toBe(en["panel.hideDone"]);
      expect(root().getAttribute("lang")).toBe("en");

      const stored = JSON.parse(installed.storage.getItem(key) ?? "{}");
      expect(stored).toMatchObject({ showDone: true, language: "en" });

      click(query('[data-bp-action="settings-reset"]'));
      expect(collectLabels(root()).get("panel.showDone")).toBe(de["panel.showDone"]);
      expect(JSON.parse(installed.storage.getItem(key) ?? "{}")).toMatchObject({
        showDone: false,
        language: "de",
      });
      expect(noteEntries()).toHaveLength(0);
      handle.disable();
    } finally {
      installed.restore();
    }
  });

  it("exports Markdown and JSON through the host download path (FR-7.1/7.2)", async () => {
    const store = makeStore();
    await addNote(store, { body: "export me" });
    const handle = startLayer(store);

    const blobs: Blob[] = [];
    const revoked: string[] = [];
    const urlApi = globalThis.URL as unknown as {
      createObjectURL?: (blob: Blob) => string;
      revokeObjectURL?: (url: string) => void;
    };
    const originalCreate = urlApi.createObjectURL;
    const originalRevoke = urlApi.revokeObjectURL;
    urlApi.createObjectURL = (blob: Blob): string => {
      blobs.push(blob);
      // A hash URL keeps jsdom from logging an unsupported-navigation warning.
      return "#bluepencil-export";
    };
    urlApi.revokeObjectURL = (url: string): void => {
      revoked.push(url);
    };

    const readBlob = (blob: Blob): Promise<string> =>
      new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(blob);
      });

    try {
      click(query('[data-bp-action="export-markdown"]'));
      await flush();
      expect(blobs).toHaveLength(1);
      expect(await readBlob(blobs[0] as Blob)).toContain("export me");

      click(query('[data-bp-action="export-json"]'));
      await flush();
      expect(blobs).toHaveLength(2);
      const json: unknown = JSON.parse(await readBlob(blobs[1] as Blob));
      expect(JSON.stringify(json)).toContain("export me");
      expect(revoked).toEqual(["#bluepencil-export", "#bluepencil-export"]);
    } finally {
      urlApi.createObjectURL = originalCreate;
      urlApi.revokeObjectURL = originalRevoke;
    }

    handle.disable();
  });

  it("renders note text as text, never as HTML (FR-9.3)", async () => {
    const store = makeStore();
    const hostile = '<img src=x onerror="window.__bpXss=1"> & <b>bold</b>';
    await addNote(store, { body: hostile });
    const handle = startLayer(store);

    pressKey("l");
    const entry = noteEntries()[0];
    expect(entry?.textContent).toContain(hostile);
    expect(entry?.querySelector("img")).toBeNull();
    expect(entry?.querySelector("b")).toBeNull();
    expect((window as unknown as { __bpXss?: number }).__bpXss).toBeUndefined();
    handle.disable();
  });
});

/* -------------------------------------------------------------------------- */
/* bar, handle and legend (FR-1.2/1.6/1.7)                                     */
/* -------------------------------------------------------------------------- */

describe("bar, handle and legend", () => {
  it("collapses the bar to the handle and back without losing the shortcut path (FR-1.2)", () => {
    const handle = startLayer(makeStore());

    expect(query('[data-bp-part="bar"]').hidden).toBe(false);
    expect(query('[data-bp-part="handle"]').hidden).toBe(true);

    pressKey("b");
    expect(query('[data-bp-part="bar"]').hidden).toBe(true);
    expect(query('[data-bp-part="handle"]').hidden).toBe(false);

    // the handle brings the bar back
    click(query('[data-bp-action="expand"]'));
    expect(query('[data-bp-part="bar"]').hidden).toBe(false);

    // modes stay reachable by keyboard while the bar is hidden
    pressKey("b");
    pressKey("c");
    expect(mode()).toBe("text");
    handle.disable();
  });

  it("opens the shortcut legend with ? and closes it with Esc and the backdrop (FR-1.7)", () => {
    const handle = startLayer(makeStore());

    pressKey("?");
    expect(legendEl().hidden).toBe(false);
    expect(legendEl().querySelectorAll('[data-bp-part="legend-group"]').length).toBeGreaterThanOrEqual(4);
    const labels = collectLabels(legendEl());
    expect(labels.get("legend.title")).toBe(en["legend.title"]);
    expect(labels.get("legend.key.save")).toBe(en["legend.key.save"]);

    pressKey("Escape");
    expect(legendEl().hidden).toBe(true);

    pressKey("?");
    expect(legendEl().hidden).toBe(false);
    click(query('[data-bp-part="legend-backdrop"]'));
    expect(legendEl().hidden).toBe(true);

    // the close button works as well, and the layer is left without overlays
    pressKey("?");
    click(query('[data-bp-action="legend-close"]'));
    expect(legendEl().hidden).toBe(true);
    handle.disable();
  });

  it("touches the host event stream only while a mode is active (FR-12.6)", () => {
    // Deliberate reading of FR-12.6: `stopPropagation()` is called *exclusively* while an
    // annotation mode is active, so a click on the layer's own bar still reaches host listeners.
    document.body.innerHTML = `<main id="host"><p data-bluepencil="p1">text</p></main>`;
    const handle = startLayer(makeStore());
    const seen: string[] = [];
    const record = (): void => {
      seen.push("host");
    };
    document.body.addEventListener("click", record);

    click(barButton("panel"));
    expect(seen).toEqual(["host"]);
    expect(panelEl().hidden).toBe(false);

    // …while a mode is active the layer does swallow the annotate click (see host-safety test)
    pressKey("c");
    seen.length = 0;
    click(byId("host").querySelector("p") as Element);
    expect(seen).toEqual([]);

    document.body.removeEventListener("click", record);
    handle.disable();
  });
});


describe("host safety", () => {
  it("never interferes while idle and keeps links, fields and ignored nodes usable in a mode (FR-1.9/12.6)", async () => {
    document.body.innerHTML = [
      `<main id="host">`,
      `<p data-bluepencil="p1">Text <a href="#x" id="link">link</a></p>`,
      `<input id="field" />`,
      `<div id="ignored" data-bp-ignore>ignored</div>`,
      `</main>`,
    ].join("");
    const store = makeStore();
    const handle = startLayer(store);
    const seen: string[] = [];
    const record = (event: Event): void => {
      const target = event.target;
      seen.push(target instanceof Element ? target.id || target.tagName : "other");
    };
    document.body.addEventListener("click", record);

    const paragraph = byId("host").querySelector("p");
    if (paragraph === null) throw new Error("fixture missing");

    // idle: the host click arrives untouched and nothing opens
    click(paragraph);
    expect(seen).toEqual(["P"]);
    expect(composer().hidden).toBe(true);

    // active mode: a link stays operable (FR-1.9) and never opens the composer
    pressKey("c");
    seen.length = 0;
    click(byId("link"));
    expect(seen).toEqual(["link"]);
    expect(composer().hidden).toBe(true);

    // active mode: form fields stay operable
    seen.length = 0;
    click(byId("field"));
    expect(seen).toEqual(["field"]);
    expect(composer().hidden).toBe(true);

    // active mode: [data-bp-ignore] stays operable
    seen.length = 0;
    click(byId("ignored"));
    expect(seen).toEqual(["ignored"]);
    expect(composer().hidden).toBe(true);

    // active mode: a text click is captured and swallowed for the host
    seen.length = 0;
    click(paragraph);
    expect(seen).toEqual([]);
    expect(composer().hidden).toBe(false);

    // host fields are never hijacked by shortcuts
    pressKey("Escape");
    seen.length = 0;
    const field = byId<HTMLInputElement>("field");
    field.focus();
    pressKey("c", {});
    expect(mode()).toBe("off");

    document.body.removeEventListener("click", record);
    handle.disable();
    expect(store.notes()).toHaveLength(0);
  });

  it("honours canAnnotate even while a mode is active (FR-10.3)", () => {
    document.body.innerHTML = `<main id="host"><p data-bluepencil="p1">blocked</p></main>`;
    const paragraph = byId("host").querySelector("p");
    if (paragraph === null) throw new Error("fixture missing");
    const handle = startLayer(makeStore(), { canAnnotate: () => false });

    pressKey("c");
    click(paragraph);
    expect(composer().hidden).toBe(true);
    handle.disable();
  });

  it("leaves host nodes and their attributes untouched (FR-1.8)", async () => {
    document.body.innerHTML = [`<main id="host">`, `<p data-bluepencil="p1">Hello</p>`, `<button id="btn">go</button>`, `</main>`].join("");
    const host = byId("host");
    const snapshot = (): string =>
      Array.from(host.querySelectorAll("*"), (node) =>
        [node.tagName, node.getAttributeNames().join("|"), node.getAttribute("style") ?? "-"].join(":"),
      ).join(";");
    const before = snapshot();
    const beforeHtml = host.outerHTML;
    expect(host.querySelectorAll("[style]").length).toBe(0);

    const handle = startLayer(makeStore());
    pressKey("c");
    click(host.querySelector("p") as Element);
    pressKey("Escape");

    pressKey("d");
    click(byId("btn"));
    await flush();
    pressKey("Escape");

    expect(snapshot()).toBe(before);
    expect(host.outerHTML).toBe(beforeHtml);
    // the layer lives outside the host subtree; markers/highlight are overlay nodes, not children
    expect(host.querySelector('[data-bp-part="root"]')).toBeNull();
    expect(host.querySelector('[data-bp-part="marker"]')).toBeNull();

    handle.disable();
    expect(host.outerHTML).toBe(beforeHtml);
  });

  it("throws nothing and reports through onError when a host API is missing (NFR-5)", () => {
    document.body.innerHTML = `<main id="host"><p data-bluepencil="p1">text</p></main>`;
    const errors: unknown[] = [];
    expect(() => {
      const handle = startLayer(makeStore(), { onError: (error) => errors.push(error) });
      handle.disable();
    }).not.toThrow();
    expect(document.querySelectorAll('[data-bp-part="root"]').length).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* multi-instance and i18n (FR-12.3, FR-11.1)                                   */
/* -------------------------------------------------------------------------- */

describe("multi-instance and i18n", () => {
  it("keeps two instances on one page apart (FR-12.3)", async () => {
    const mountA = document.createElement("div");
    mountA.id = "mount-a";
    const mountB = document.createElement("div");
    mountB.id = "mount-b";
    document.body.append(mountA, mountB);

    const storeA = makeStore();
    const storeB = makeStore();
    await addNote(storeA, { body: "note in A" });
    const layerA = createLayer({ store: storeA, document, mount: mountA, language: "en" });
    const layerB = createLayer({ store: storeB, document, mount: mountB, language: "de" });
    layerA.enable();
    layerB.enable();

    click(mountA.querySelector('[data-bp-action="panel"]') as Element);
    expect(mountA.querySelector('[data-bp-part="panel"]')?.hasAttribute("hidden")).toBe(false);
    expect(mountB.querySelector('[data-bp-part="panel"]')?.hasAttribute("hidden")).toBe(true);
    expect(mountA.textContent).toContain("note in A");
    expect(mountB.textContent).not.toContain("note in A");

    const instanceA = mountA.querySelector('[data-bp-part="root"]')?.getAttribute("data-bp-instance");
    const instanceB = mountB.querySelector('[data-bp-part="root"]')?.getAttribute("data-bp-instance");
    expect(instanceA).toBeTruthy();
    expect(instanceA).not.toBe(instanceB);
    expect(mountA.querySelector('[data-bp-part="root"]')?.className).toContain(`bp-${instanceA ?? ""}`);

    layerA.disable();
    layerB.disable();
  });

  it("switches every label between en and de (FR-11.1)", () => {
    const mountEn = document.createElement("div");
    mountEn.id = "mount-en";
    const mountDe = document.createElement("div");
    mountDe.id = "mount-de";
    document.body.append(mountEn, mountDe);

    const layerEn = createLayer({ store: makeStore(), document, mount: mountEn, language: "en" });
    // region tags must normalise to the primary language
    const layerDe = createLayer({ store: makeStore(), document, mount: mountDe, language: "de-AT" });
    layerEn.enable();
    layerDe.enable();

    // open every surface so its labels are part of the comparison
    for (const scope of [mountEn, mountDe]) {
      click(scope.querySelector('[data-bp-action="panel"]') as Element);
      click(scope.querySelector('[data-bp-action="settings"]') as Element);
      click(scope.querySelector('[data-bp-action="legend"]') as Element);
    }

    const labelsEn = collectLabels(mountEn);
    const labelsDe = collectLabels(mountDe);

    expect(labelsEn.size).toBeGreaterThan(50);
    expect(Array.from(labelsDe.keys()).sort()).toEqual(Array.from(labelsEn.keys()).sort());

    const empty = Array.from(labelsEn.entries())
      .filter(([, value]) => value === "")
      .map(([key]) => key);
    expect(empty, `labels without text: ${empty.join(", ")}`).toEqual([]);

    for (const [key, text] of labelsEn) {
      const translated = labelsDe.get(key) ?? "";
      expect(text).not.toBe("");
      expect(translated).not.toBe("");
      // no raw keys and a real translation on both sides
      expect(text).not.toBe(key);
      expect(translated).not.toBe(key);
      expect(translated).not.toBe(text);
      if (!en[key as MessageKey].includes("{")) {
        expect(text).toBe(en[key as MessageKey]);
        expect(translated).toBe(de[key as MessageKey]);
      }
      expect(text.includes("{")).toBe(false);
      expect(translated.includes("{")).toBe(false);
    }

    layerEn.disable();
    layerDe.disable();
  });

  it("ships a token-driven, host-safe stylesheet (FR-1.9/10.3, NFR-6)", () => {
    // every colour/size flows through custom properties with fallbacks
    expect(STYLES).toContain("var(--bp-accent");
    expect(STYLES).toContain("var(--bp-surface");
    expect(STYLES).toContain("var(--bp-ink");
    expect(STYLES).toContain("var(--bp-muted");
    expect(STYLES).toContain("var(--bp-line");
    expect(STYLES).toContain("var(--bp-radius");
    expect(STYLES).toContain("var(--bp-space");
    expect(STYLES).toContain("contain: layout style");
    expect(STYLES).toContain("z-index: var(--bp-z");
    expect(STYLES).toContain("@media print");
    expect(STYLES).toContain("@media (prefers-color-scheme: dark)");
    expect(STYLES).toContain("@media (prefers-reduced-motion: reduce)");

    // no global resets, no inline handlers, no eval-flavoured constructs
    expect(STYLES).not.toMatch(/(^|})\s*(html|body|:root|\*)\s*\{/);
    expect(STYLES).not.toContain("onclick");
    expect(STYLES).not.toContain("@import");
  });

  it("applies host theme tokens on the layer root only (FR-10.3)", () => {
    document.body.innerHTML = `<main id="host"><p data-bluepencil="p1">text</p></main>`;
    const handle = startLayer(makeStore(), { theme: { accent: "#ff0000", "--bp-surface": "#eeeeee" } });
    const style = root().getAttribute("style") ?? "";
    expect(style).toContain("--bp-accent: #ff0000");
    expect(style).toContain("--bp-surface: #eeeeee");
    expect(byId("host").querySelector("[style]")).toBeNull();
    handle.disable();
  });

  /* The dark palette must be a *fallback*, not an override: a host that sets --bp-* on :root (the
     recipe in docs/INTEGRATION.md §8) kept its own values in light mode and lost them the moment
     the OS turned dark, because the media block re-declared the tokens on .bp-root — and a custom
     property set on the element beats an inherited one. Measured before: --bp-accent fell back to
     the library's #7ba2ff instead of the host's #8c3b2e, with no warning. */
  it("keeps the dark palette as a var() fallback so a host :root token still wins", () => {
    const dark = STYLES.slice(STYLES.indexOf("@media (prefers-color-scheme: dark)"));
    // Every dark token has to be self-referential in the fallback position, never a literal.
    for (const token of [
      "surface",
      "surface-alt",
      "ink",
      "muted",
      "line",
      "accent",
      "accent-ink",
      "danger",
      "decision",
      "feedback",
      "highlight",
      "backdrop",
      "shadow",
    ]) {
      expect(dark).toContain(`--bp-${token}: var(--bp-${token}, `);
    }
    // And no dark rule may hard-set a token to a literal any more.
    expect(dark).not.toMatch(/--bp-[a-z-]+:\s*#/);
  });
});

/* -------------------------------------------------------------------------- */
/* counters, keyboard reservation and failure paths                            */
/* (FR-4.3/4.8, FR-12.6, FR-2.4, NFR-14)                                       */
/* -------------------------------------------------------------------------- */

describe("counters, keyboard and failure paths", () => {
  it("excludes done notes from every counter, feedback included (FR-4.3/4.8)", async () => {
    const store = makeStore();
    const doneFeedback = await addNote(store, {
      body: "done assessment",
      status: "done",
      intent: "feedback",
    });
    const openFeedback = await addNote(store, { body: "open assessment", intent: "feedback" });
    const openImplement = await addNote(store, { body: "open work" });

    // the reported triple: a done feedback note must not be counted anywhere
    expect(noteCounters([doneFeedback, openFeedback, openImplement])).toEqual({
      total: 2,
      open: 2,
      decisions: 0,
      feedback: 1,
    });

    const handle = startLayer(store);
    const counters = (): (string | null)[] =>
      (["total", "open", "decisions", "feedback"] as const).map(
        (key) => query(`[data-bp-part="counter-${key}"]`).textContent,
      );
    expect(counters()).toEqual(["2", "2", "0", "1"]);
    handle.disable();
  });

  it("leaves the host's keyboard alone while idle and owns it in a mode (FR-12.6)", () => {
    document.body.innerHTML = `<main id="host"><p data-bluepencil="p1">text</p></main>`;
    const handle = startLayer(makeStore());
    const seen: string[] = [];
    const record = (): void => {
      seen.push("host");
    };
    document.body.addEventListener("keydown", record);

    const press = (key: string): KeyboardEvent => {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      // Dispatched on a host node, so a swallowed key is visible as "the host listener never ran".
      document.body.dispatchEvent(event);
      return event;
    };

    // Idle: the layer still acts on its own shortcut, but the host's key survives. The reported
    // defect was `c`/`d`: they toggled the mode *and* swallowed the event for the host.
    const c = press("c");
    expect(mode()).toBe("text");
    expect(c.defaultPrevented).toBe(false);
    expect(seen).toEqual(["host"]);

    // A mode is active: the reserved keys belong to the layer.
    seen.length = 0;
    const f = press("f");
    expect(f.defaultPrevented).toBe(true);
    expect(seen).toEqual([]);

    // Esc leaves the mode (itself a reserved key while a mode is active) …
    seen.length = 0;
    const escape = press("Escape");
    expect(mode()).toBe("off");
    expect(escape.defaultPrevented).toBe(true);
    expect(seen).toEqual([]);

    // … and the layer is idle again: the host gets its key back.
    seen.length = 0;
    const panelKey = press("l");
    expect(panelEl().hidden).toBe(false);
    expect(panelKey.defaultPrevented).toBe(false);
    expect(seen).toEqual(["host"]);

    // With one of its own surfaces open the layer owns the keyboard again.
    seen.length = 0;
    const closeKey = press("l");
    expect(panelEl().hidden).toBe(true);
    expect(closeKey.defaultPrevented).toBe(true);
    expect(seen).toEqual([]);

    document.body.removeEventListener("keydown", record);
    handle.disable();
  });

  it("reports a failing JSON export through onError and inline, never into the page (NFR-14)", async () => {
    const errors: unknown[] = [];
    const store = makeStore();
    await addNote(store, { body: "dev note", environment: "dev" });
    await addNote(store, { body: "live note", environment: "live" });
    const handle = startLayer(store, { onError: (error) => errors.push(error) });

    const blobs: Blob[] = [];
    const urlApi = globalThis.URL as unknown as { createObjectURL?: (blob: Blob) => string };
    const originalCreate = urlApi.createObjectURL;
    urlApi.createObjectURL = (blob: Blob): string => {
      blobs.push(blob);
      return "#bluepencil-export";
    };

    try {
      click(barButton("panel"));
      // A bundle carries exactly one environment (FR-14.1): this export cannot succeed …
      expect(() => click(query('[data-bp-action="export-json"]'))).not.toThrow();

      // … so the host hears about it, the user sees it, and nothing was downloaded.
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(BluepencilValidationError);
      const message = query('[data-bp-part="panel-message"]');
      expect(message.hidden).toBe(false);
      expect(message.textContent).toBe(en["panel.error.export"]);
      expect(blobs).toEqual([]);
    } finally {
      urlApi.createObjectURL = originalCreate;
    }
    handle.disable();
  });

  it("reports a failing Markdown export inline as well and clears the message on success (NFR-14)", async () => {
    const errors: unknown[] = [];
    // A hand-edited or imported note can carry a body that is not a string (FR-14.6): the export
    // must not explode inside the click listener.
    const corrupt: Note = {
      ...createNote({
        id: "n-corrupt",
        type: "text",
        body: "broken",
        anchor: { hook: "corrupt" },
        now: "2026-09-15T10:00:00.000Z",
      }),
      body: null as unknown as string,
    };
    const store = createStore({ adapter: createMemoryAdapter({ seed: [corrupt] }) });
    const handle = startLayer(store, { onError: (error) => errors.push(error) });
    await handle.hydrated();

    const blobs: Blob[] = [];
    const urlApi = globalThis.URL as unknown as { createObjectURL?: (blob: Blob) => string };
    const originalCreate = urlApi.createObjectURL;
    urlApi.createObjectURL = (blob: Blob): string => {
      blobs.push(blob);
      return "#bluepencil-export";
    };

    try {
      click(barButton("panel"));
      expect(() => click(query('[data-bp-action="export-markdown"]'))).not.toThrow();
      expect(errors).toHaveLength(1);
      const message = query('[data-bp-part="panel-message"]');
      expect(message.textContent).toBe(en["panel.error.export"]);
      expect(message.hidden).toBe(false);
      expect(blobs).toEqual([]);

      // With the broken note gone the same action succeeds and clears the inline message.
      await store.remove("n-corrupt");
      click(query('[data-bp-action="export-markdown"]'));
      expect(blobs).toHaveLength(1);
      expect(query('[data-bp-part="panel-message"]').hidden).toBe(true);
      expect(errors).toHaveLength(1);
    } finally {
      urlApi.createObjectURL = originalCreate;
    }
    handle.disable();
  });

  it("shows a degraded anchor without writing into the stored note (FR-2.4, §6b)", async () => {
    document.body.innerHTML = `<div id="host"></div>`;
    byId("host").attachShadow({ mode: "closed" }).innerHTML = `<span class="secret">hidden</span>`;

    const anchor = { selector: "div#host:nth-of-type(1) >> span:nth-of-type(1)" };
    const seeded = createNote({
      id: "n-degraded",
      type: "text",
      body: "closed root note",
      anchor,
      now: "2026-09-15T10:00:00.000Z",
    });
    const store = createStore({ adapter: createMemoryAdapter({ seed: [seeded] }) });
    const handle = startLayer(store);
    await handle.hydrated();

    pressKey("l");
    const entry = noteEntries()[0];
    expect(entry?.classList.contains("is-orphaned")).toBe(true);
    expect(entry?.querySelector(".bp-badge--degraded")?.textContent).toBe(en["panel.degraded"]);
    // The degradation was reported by the resolution, not stamped onto the note the host owns.
    expect(store.notes()[0]?.anchor.degraded).toBeUndefined();
    expect(seeded.anchor.degraded).toBeUndefined();
    expect(anchor).toEqual({ selector: "div#host:nth-of-type(1) >> span:nth-of-type(1)" });
    handle.disable();
  });
});

/* -------------------------------------------------------------------------- */
/* i18n lookup fallbacks (FR-11.1, FR-9.3, NFR-14)                              */
/* -------------------------------------------------------------------------- */

describe("i18n lookup fallbacks", () => {
  it("falls back to English for a missing key and renders an unknown key instead of throwing", () => {
    const partial: Partial<Messages> = { ...de };
    delete partial["bar.panel"];
    const translator = createTranslator("de", partial);

    expect(translator.language).toBe("de");
    expect(translator.t("bar.title")).toBe(de["bar.title"]);
    // the reported gap: a table without that key used to throw inside the translation
    expect(translator.t("bar.panel")).toBe(en["bar.panel"]);
    expect(translator.t("not.a.key" as MessageKey)).toBe("not.a.key");
    expect(translate("de", "bar.panel")).toBe(de["bar.panel"]);

    // the DOM walk of the layer survives both cases (no TypeError on the host page)
    const mount = document.createElement("div");
    mount.innerHTML = [
      `<span data-bp-i18n="bar.panel"></span>`,
      `<span data-bp-i18n="not.a.key"></span>`,
      `<span data-bp-i18n-aria="bar.title"></span>`,
    ].join("");
    expect(() => applyTranslations(mount, translator.t)).not.toThrow();
    const nodes = Array.from(mount.querySelectorAll("span"));
    expect(nodes[0]?.textContent).toBe(en["bar.panel"]);
    // unknown keys stay out of the UI — a marked node is never rendered as a raw key (FR-9.3)
    expect(nodes[1]?.textContent).toBe("");
    expect(nodes[2]?.getAttribute("aria-label")).toBe(de["bar.title"]);

    // an unsupported language tag still resolves to English
    expect(createTranslator("fr-FR").t("bar.panel")).toBe(en["bar.panel"]);
  });
});


/* Issue #21: an exported bundle must name the app, the build and the exporter — a host that embeds
   the layer with the tag had no way to stamp them, so every export said "unknown". */
describe("layer — bundle metadata on export (issue #21)", () => {
  it("stamps app, build ref, exporter and environment into the exported JSON", async () => {
    const store = makeStore();
    await addNote(store, { body: "with metadata", environment: "staging" });
    const handle = startLayer(store, {
      app: { name: "ReqogniLoom" },
      buildRef: "1.8.0-beta.12",
      exportedBy: "dduchrow",
      environment: "staging",
    });

    const blobs: Blob[] = [];
    const urlApi = globalThis.URL as unknown as {
      createObjectURL?: (blob: Blob) => string;
      revokeObjectURL?: (url: string) => void;
    };
    const originalCreate = urlApi.createObjectURL;
    const originalRevoke = urlApi.revokeObjectURL;
    urlApi.createObjectURL = (blob: Blob): string => {
      blobs.push(blob);
      return "#bluepencil-export";
    };
    urlApi.revokeObjectURL = (): void => undefined;

    const readBlob = (blob: Blob): Promise<string> =>
      new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(blob);
      });

    try {
      click(query('[data-bp-action="export-json"]'));
      await flush();
      expect(blobs).toHaveLength(1);
      const bundle = JSON.parse(await readBlob(blobs[0] as Blob)) as {
        app?: { name?: string; buildRef?: string };
        exportedBy?: string;
        environment?: string;
        notes?: unknown[];
      };

      expect(bundle.app).toEqual({ name: "ReqogniLoom", buildRef: "1.8.0-beta.12" });
      expect(bundle.exportedBy).toBe("dduchrow");
      expect(bundle.environment).toBe("staging");
      expect(bundle.notes).toHaveLength(1);
    } finally {
      urlApi.createObjectURL = originalCreate;
      urlApi.revokeObjectURL = originalRevoke;
    }

    handle.disable();
  });
});
