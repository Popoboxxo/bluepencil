/**
 * The review layer — one host container with bar, handle, markers, composer, panel, settings and
 * legend (INTERNAL-API §8, ARCHITECTURE §2/§6b/§7).
 *
 * Lifecycle contract (FR-12.1/12.2, NFR-1/NFR-15):
 *  - `enable()` is idempotent and builds **one** container per instance under `options.mount`;
 *  - `disable()` removes nodes, listeners, observers, style reference and store subscription —
 *    after N cycles the footprint equals the starting state;
 *  - `enabled()`-style gating lives in `src/index.ts`; a disabled layer renders nothing at all.
 *
 * Host safety (FR-1.8/12.6, NFR-1/NFR-2/NFR-6):
 *  - nothing is ever written to host nodes: markers, highlight and bar are own fixed-position
 *    overlay nodes inside `contain: layout style`, so host boxes never move;
 *  - clicks are evaluated on `event.composedPath()` (FR-12.4) and `stopPropagation()` is called
 *    **only** while an annotation mode is active; `a[href]`, form fields, `[data-bp-ignore]`,
 *    `[contenteditable]` and `options.canAnnotate === false` are passed through even then;
 *  - no timers: marker geometry follows `ResizeObserver`, `scroll` and `resize` (NFR-2); the
 *    highlight removes itself through a CSS `animationend` event;
 *  - production text is only ever set via `textContent` (FR-9.3) and all copy comes from
 *    `src/i18n` (FR-11.1);
 *  - keyboard (FR-1.6/1.7/11.2): the reserved keys `c`, `d`, `l`, `f`, `b`, `j`, `k`, `1`–`9`, `?`
 *    and `Escape` (plus `Ctrl/⌘ + Enter` in the composer) are only ever *swallowed* while an
 *    annotation mode is active or one of the layer's own surfaces is open. While the layer is
 *    idle they may still act on the layer, but the host's default action and propagation survive
 *    (FR-12.6);
 *  - failures go to `options.onError` / `console.debug` and to a translated inline message of the
 *    panel or the composer, never into the page (NFR-14).
 */

import { deriveAnchor, describeElement, resolveAnchor, resolveAnchorDetailed } from "../core/anchor";
import { captureContext, selectionQuote } from "../core/capture";
import { toJson } from "../core/export/json";
import { toMarkdown } from "../core/export/markdown";
import type { Anchor, CapturedContext, MessageKind, Note, NoteStatus } from "../core/model";
import { answerDecision } from "../core/protocol";
import type { Store } from "../core/store";
import { applyTranslations, createTranslator, normalizeLanguage, type Translate } from "../i18n";
import type { MessageKey } from "../i18n/en";
import { createComposer, type Composer, type ComposerSaveInput, type ComposerSaveResult, type ComposerTarget } from "./composer";
import { createLegend } from "./legend";
import { normaliseKey, resolveKeymap, type KeymapOverrides } from "./keymap";
import {
  createPanel,
  createSettings,
  DEFAULT_SETTINGS,
  noteCounters,
  type LayerSettings,
  type Panel,
  type PanelActions,
  type SettingsPopover,
} from "./panel";
import { STYLES } from "./styles";

/* -------------------------------------------------------------------------- */
/* public contract (INTERNAL-API §8 — do not change without the docs)          */
/* -------------------------------------------------------------------------- */

export interface LayerOptions {
  store: Store;
  document?: Document;
  mount?: Element | Document;
  language?: string;
  theme?: Record<string, string>;
  anchorHooks?: string[];
  canAnnotate?: (el: Element) => boolean;
  /**
   * Registered target selectors (FR-1.12, issue #3): a host that brings its own component vocabulary
   * lists selectors here. The nearest match in the click path becomes the annotation target — the
   * card itself, not the heading inside it — in text *and* design mode. Invalid selectors are
   * reported once by `readAnnotateSelectors` (element path) and ignored here.
   */
  annotateSelectors?: readonly string[];
  /**
   * Shortcut overrides (FR-12.11): `{ bar: "g", panel: ["l", "p"] }`. Conflicts, unknown ids and
   * keys that cannot be remapped are reported — the legend always shows the effective keymap.
   */
  keymap?: KeymapOverrides;
  /** Initial chrome level (FR-12.9); the user's choice is persisted on top of it. */
  chrome?: ChromeLevel;
  getRoute?: (element?: Element) => string;
  identity?: { getUser?: () => { id?: string; name: string } } | "prompt" | "anonymous";
  markerStrategy?: "overlay" | "sibling";
  defaultShowDone?: boolean;
  buildRef?: string;
  onError?: (err: unknown) => void;
}

export interface LayerHandle {
  enable(): void;
  disable(): void;
  isEnabled(): boolean;
  refresh(): void;
  setShowDone(value: boolean): void;
  /**
   * Chrome level at runtime (FR-12.9): `full` keeps the bar/handle pair, `quiet` leaves only the
   * handle, `off` leaves the annotations without chrome of their own. Persisted; `disable()` removes
   * everything regardless of the level.
   */
  setChrome(level: ChromeLevel): void;
  /** The current chrome level (FR-12.9), as persisted. */
  chrome(): ChromeLevel;
  /**
   * Resolves when the store hydration kicked off by `enable()` has settled (additive; `ready()`
   * of the public `Blueprint` awaits it instead of starting a second read). Never rejects: a
   * failed load is reported through `options.onError` and the store simply stays as it is.
   */
  hydrated(): Promise<void>;
}

/** Annotation modes (FR-1.3 text / FR-1.4 design). */
type Mode = "off" | "text" | "design";

/**
 * How much chrome the layer shows (FR-12.9): `full` = bar + handle, `quiet` = handle only, `off` =
 * neither. Deliberately *not* `disable()`: the annotations and their markers stay, only the layer's
 * own controls go — `disable()` is what removes every node (NFR-15).
 */
export type ChromeLevel = "full" | "quiet" | "off";

/* -------------------------------------------------------------------------- */
/* style node registry — one <style> per document, removed with the last layer */
/* -------------------------------------------------------------------------- */

const STYLE_NODES = new WeakMap<Document, { node: HTMLStyleElement; refs: number }>();

function acquireStyles(doc: Document): void {
  const existing = STYLE_NODES.get(doc);
  if (existing) {
    existing.refs += 1;
    return;
  }
  const node = doc.createElement("style");
  node.setAttribute("data-bp-styles", "");
  node.setAttribute("data-bp-part", "styles");
  node.textContent = STYLES;
  const parent = doc.head ?? doc.documentElement;
  parent?.append(node);
  STYLE_NODES.set(doc, { node, refs: 1 });
}

function releaseStyles(doc: Document): void {
  const entry = STYLE_NODES.get(doc);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  entry.node.remove();
  STYLE_NODES.delete(doc);
}

/* -------------------------------------------------------------------------- */
/* host interaction rules (FR-1.3, FR-1.9, FR-12.6)                            */
/* -------------------------------------------------------------------------- */

/** Elements that carry text (FR-1.3) — text mode snaps to the nearest one in the path. */
const TEXT_TAGS = new Set([
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "P",
  "LI",
  "TD",
  "TH",
  "DT",
  "DD",
  "LABEL",
  "LEGEND",
  "BLOCKQUOTE",
  "FIGCAPTION",
  "CAPTION",
  "PRE",
  "CODE",
  "EM",
  "STRONG",
  "SMALL",
  "TIME",
  "SPAN",
  "MARK",
]);

/** Interactive host elements that must stay operable even while a mode is active (FR-1.9). */
const PASS_THROUGH_TAGS = new Set([
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "OPTION",
  "OPTGROUP",
  "BUTTON",
  "SUMMARY",
  "AUDIO",
  "VIDEO",
  "IFRAME",
  "OBJECT",
  "EMBED",
]);

const PASS_THROUGH_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "slider",
  "combobox",
  "searchbox",
  "spinbutton",
]);

function isElement(node: unknown): node is Element {
  return (
    typeof node === "object" &&
    node !== null &&
    typeof (node as { tagName?: unknown }).tagName === "string"
  );
}

/** `a[href]`, form fields, `[data-bp-ignore]`, editable regions and interactive roles. */
function isPassThroughElement(el: Element): boolean {
  const tag = el.tagName;
  if (tag === "A") return el.hasAttribute("href");
  if (PASS_THROUGH_TAGS.has(tag)) return true;
  if (el.hasAttribute("data-bp-ignore")) return true;
  if (el.hasAttribute("contenteditable")) return true;
  const role = el.getAttribute("role");
  return role !== null && PASS_THROUGH_ROLES.has(role);
}

/** Text of an editable host field, so shortcuts never fire while the host is being typed into. */
function isEditableTarget(target: unknown): boolean {
  if (!isElement(target)) return false;
  if (target.hasAttribute("contenteditable")) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/* -------------------------------------------------------------------------- */
/* the layer                                                                   */
/* -------------------------------------------------------------------------- */

let instanceCounter = 0;

/** UI preferences key — namespaced like the storage keys of the adapters (ARCHITECTURE §6b). */
function settingsKey(view: Window | undefined): string {
  const host = view?.location?.host !== undefined && view.location.host !== "" ? view.location.host : "local";
  return `bluepencil:ui:${host}:v1`;
}

function readStoredSettings(view: Window | undefined): Partial<LayerSettings> {
  try {
    const raw = view?.localStorage?.getItem(settingsKey(view));
    if (typeof raw !== "string") return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const source = parsed as Record<string, unknown>;
    const result: Partial<LayerSettings> = {};
    if (typeof source.showDone === "boolean") result.showDone = source.showDone;
    if (typeof source.feedbackOnly === "boolean") result.feedbackOnly = source.feedbackOnly;
    if (typeof source.author === "string") result.author = source.author;
    if (typeof source.language === "string") result.language = source.language;
    if (typeof source.barCollapsed === "boolean") result.barCollapsed = source.barCollapsed;
    if (source.chromeLevel === "full" || source.chromeLevel === "quiet" || source.chromeLevel === "off") {
      result.chromeLevel = source.chromeLevel;
    }
    return result;
  } catch (error) {
    // Private mode / disabled storage must degrade, never break (NFR-5).
    return {};
  }
}

/**
 * `?bp-chrome=quiet|full|off` — the level for one load, never persisted (FR-12.12). For screenshots,
 * QA runs and handovers: whoever takes over can set the state without touching a stored preference.
 */
function chromeFromUrl(view: Window | undefined): ChromeLevel | null {
  const search = view?.location?.search ?? "";
  const match = /[?&]bp-chrome=(quiet|full|off)(&|$)/.exec(search);
  return match === null ? null : (match[1] as ChromeLevel);
}

export function createLayer(options: LayerOptions): LayerHandle {
  instanceCounter += 1;
  const instanceId = `i${instanceCounter}`;

  const ownerDocument = options.document ?? (typeof document !== "undefined" ? document : undefined);
  const view = ownerDocument?.defaultView ?? (typeof window !== "undefined" ? window : undefined);

  /* -- state --------------------------------------------------------------- */

  const stored = readStoredSettings(view);
  /**
   * A `?bp-chrome=` level is good for this load only (FR-12.12): it is never written back, and an
   * explicit change at runtime wins over it (then it is gone).
   */
  let chromeOverride = chromeFromUrl(view);
  const settings: LayerSettings = {
    ...DEFAULT_SETTINGS,
    showDone: options.defaultShowDone ?? false,
    ...(options.chrome === undefined ? {} : { chromeLevel: options.chrome }),
    ...stored,
  };
  // An explicit host language always wins over the persisted one (FR-10.3); without it the
  // persisted choice survives a reload (FR-4.5).
  settings.language = normalizeLanguage(options.language ?? settings.language);

  let translator = createTranslator(settings.language);
  /** Stable translator handed to the components — a language switch only swaps `translator`. */
  const t: Translate = (key, vars) => translator.t(key, vars);

  let enabled = false;
  let mode: Mode = "off";
  let selectedId: string | null = null;
  let degradedReported = false;

  /** Element resolution per note id, refreshed on every render (FR-2.4/4.7). */
  const resolutions = new Map<string, Element | null>();

  /** Degraded notes of the last resolution round — resolution itself never mutates a note (§6b). */
  const degradations = new Set<string>();

  /** Store hydration of the last `enable()`; awaited by `hydrated()` (never rejects). */
  let hydration: Promise<void> = Promise.resolve();

  /** Nodes belonging to this instance (all inside `root`). */
  let root: HTMLElement | null = null;
  let bar: HTMLElement | null = null;
  let handle: HTMLButtonElement | null = null;
  let handleCount: HTMLElement | null = null;
  let modeHint: HTMLElement | null = null;
  let modeHintText: HTMLElement | null = null;
  let markersLayer: HTMLElement | null = null;
  let highlight: HTMLElement | null = null;
  let liveRegion: HTMLElement | null = null;
  let barCollapseButton: HTMLButtonElement | null = null;
  const counterValues: Partial<Record<keyof ReturnType<typeof noteCounters>, HTMLElement>> = {};
  const pressedButtons: Partial<Record<"mode-text" | "mode-design" | "panel" | "feedback-only" | "show-done", HTMLButtonElement>> = {};

  let panel: Panel | null = null;
  let composer: Composer | null = null;
  let legend: ReturnType<typeof createLegend> | null = null;

  /**
   * Resolved once (FR-1.11): the handler and the legend both read this — a shortcut that only exists
   * in the help text, or only in the code, is impossible by construction.
   */
  const keymap = resolveKeymap(options.keymap);
  // Conflicts are surfaced, never swallowed: the host hears about a lost shortcut (FR-12.11).
  for (const issue of keymap.issues) reportError(new Error(issue));
  let settingsPopover: SettingsPopover | null = null;

  /** Marker node per annotated host element (one marker, count badge — FR-4.1). */
  const markerNodes = new Map<Element, HTMLButtonElement>();
  let observedTargets: Element[] = [];
  let resizeObserver: { disconnect(): void; observe(target: Element): void; unobserve(target: Element): void } | null = null;
  let unsubscribeStore: (() => void) | null = null;

  /** Every listener this instance owns, so `disable()` can prove a complete teardown. */
  const listeners: [EventTarget, string, EventListener, boolean | AddEventListenerOptions][] = [];

  function listen(
    target: EventTarget,
    type: string,
    handler: EventListener,
    options?: boolean | AddEventListenerOptions,
  ): void {
    const opts = options ?? false;
    target.addEventListener(type, handler, opts);
    listeners.push([target, type, handler, opts]);
  }

  function unlistenAll(): void {
    for (const [target, type, handler, opts] of listeners.splice(0)) {
      target.removeEventListener(type, handler, opts);
    }
  }

  /* -- diagnostics --------------------------------------------------------- */

  function reportError(error: unknown): void {
    try {
      if (options.onError) {
        options.onError(error);
        return;
      }
      view?.console?.debug?.("[bluepencil]", error);
    } catch {
      // Reporting must never escalate into the host page (NFR-14).
    }
  }

  function reportDegraded(detail: string): void {
    if (degradedReported) return;
    degradedReported = true;
    try {
      view?.console?.debug?.("[bluepencil]", t("status.degraded"), detail);
    } catch {
      // ignore
    }
  }

  /**
   * A failed action is reported twice: to the host (`onError`) and to the user, as a translated
   * inline message in the panel and — when it is open — in the composer (NFR-14, FR-11.1).
   */
  function reportFailure(key: MessageKey, error: unknown): void {
    reportError(error);
    panel?.reportMessage(key);
    if (composer?.isOpen()) composer.reportError(key);
  }

  /** Wraps a delegated listener so no exception of ours can ever reach the host page (NFR-14). */
  function guard(handler: (event: Event) => void): EventListener {
    return (event: Event): void => {
      try {
        handler(event);
      } catch (error) {
        reportError(error);
      }
    };
  }

  /** True while no mode is active and no own surface holds the keyboard (FR-12.6). */
  function isIdle(): boolean {
    return (
      mode === "off" &&
      !(composer?.isOpen() ?? false) &&
      !(panel?.isOpen() ?? false) &&
      !(legend?.isOpen() ?? false) &&
      !(settingsPopover?.isOpen() ?? false)
    );
  }

  /* -- persistence (FR-4.5, FR-1.2) --------------------------------------- */

  function persistSettings(): void {
    try {
      view?.localStorage?.setItem(settingsKey(view), JSON.stringify(settings));
    } catch {
      // Best effort only: storage may be unavailable or full (NFR-5).
    }
  }

  /* -- container (one per instance, FR-12.3) ------------------------------- */

  function resolveMount(node: Element | Document | undefined): Element | null {
    if (node === undefined) return ownerDocument?.body ?? ownerDocument?.documentElement ?? null;
    if (isElement(node)) return node;
    const doc = node as Document;
    return doc.body ?? doc.documentElement ?? null;
  }

  function buildRoot(): HTMLElement | null {
    const doc = ownerDocument;
    const mount = resolveMount(options.mount);
    if (!doc || !mount || typeof doc.createElement !== "function") return null;

    const node = doc.createElement("div");
    node.className = `bp-root bp-${instanceId}`;
    node.id = `bp-${instanceId}`;
    node.setAttribute("data-bp-part", "root");
    node.setAttribute("data-bp-instance", instanceId);
    node.setAttribute("data-bp-mode", "off");
    node.setAttribute("data-bp-i18n-aria", "a11y.layerLabel");
    node.setAttribute("lang", settings.language);
    // Host theme tokens (FR-10.3): applied as custom properties on the layer root only.
    if (options.theme) {
      for (const [name, value] of Object.entries(options.theme)) {
        node.style.setProperty(name.startsWith("--") ? name : `--bp-${name}`, value);
      }
    }

    markersLayer = doc.createElement("div");
    markersLayer.className = "bp-markers";
    markersLayer.id = `bp-${instanceId}-markers`;
    markersLayer.setAttribute("data-bp-part", "markers");
    markersLayer.setAttribute("aria-hidden", "true");

    highlight = doc.createElement("div");
    highlight.className = "bp-highlight";
    highlight.id = `bp-${instanceId}-highlight`;
    highlight.setAttribute("data-bp-part", "highlight");
    highlight.setAttribute("aria-hidden", "true");
    highlight.hidden = true;
    // No timer for UI state (NFR-2): the highlight removes itself when its CSS animation ends.
    listen(highlight, "animationend", () => {
      if (highlight) {
        highlight.hidden = true;
        highlight.removeAttribute("style");
      }
    });

    /* -- bar and handle (FR-1.2, FR-4.8) ----------------------------------- */

    bar = doc.createElement("div");
    bar.className = "bp-bar";
    bar.id = `bp-${instanceId}-bar`;
    bar.setAttribute("data-bp-part", "bar");
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("data-bp-i18n-aria", "a11y.barLabel");

    const barTitle = doc.createElement("span");
    barTitle.className = "bp-bar-title";
    barTitle.setAttribute("data-bp-i18n", "bar.title");
    bar.append(barTitle);

    const barButton = (
      action: string,
      key: MessageKey,
      slot?: "mode-text" | "mode-design" | "panel" | "feedback-only" | "show-done",
    ): HTMLButtonElement => {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "bp-btn";
      button.setAttribute("data-bp-action", action);
      button.setAttribute("data-bp-i18n", key);
      if (slot) {
        button.setAttribute("aria-pressed", "false");
        pressedButtons[slot] = button;
      }
      return button;
    };

    bar.append(barButton("mode-text", "bar.mode.text", "mode-text"));
    bar.append(barButton("mode-design", "bar.mode.design", "mode-design"));
    bar.append(barButton("panel", "bar.panel", "panel"));

    const counters = doc.createElement("div");
    counters.className = "bp-counters";
    counters.setAttribute("data-bp-part", "counters");
    for (const key of ["total", "open", "decisions", "feedback"] as const) {
      const counter = doc.createElement("span");
      counter.className = "bp-counter";
      counter.setAttribute("data-bp-counter", key);
      const value = doc.createElement("span");
      value.className = "bp-counter-value";
      value.setAttribute("data-bp-part", `counter-${key}`);
      value.textContent = "0";
      const label = doc.createElement("span");
      label.className = "bp-counter-label";
      label.setAttribute("data-bp-i18n", `counters.${key}` as MessageKey);
      counter.append(value, label);
      counters.append(counter);
      counterValues[key] = value;
    }
    bar.append(counters);

    bar.append(barButton("feedback-only", "bar.feedbackOnly", "feedback-only"));
    bar.append(barButton("show-done", "bar.showDone", "show-done"));
    bar.append(barButton("legend", "bar.legend"));
    bar.append(barButton("settings", "bar.settings"));
    barCollapseButton = barButton("collapse", "bar.collapse");

    handle = doc.createElement("button");
    handle.type = "button";
    handle.className = "bp-handle";
    handle.id = `bp-${instanceId}-handle`;
    handle.setAttribute("data-bp-part", "handle");
    handle.setAttribute("data-bp-action", "expand");
    handle.setAttribute("data-bp-i18n-aria", "a11y.handleLabel");
    handleCount = doc.createElement("span");
    handleCount.className = "bp-handle-count";
    handleCount.textContent = "0";
    const handleLabel = doc.createElement("span");
    handleLabel.className = "bp-visually-hidden";
    handleLabel.setAttribute("data-bp-i18n", "bar.expand");
    handle.append(handleCount, handleLabel);

    modeHint = doc.createElement("div");
    modeHint.className = "bp-mode-hint";
    modeHint.id = `bp-${instanceId}-mode-hint`;
    modeHint.setAttribute("data-bp-part", "mode-hint");
    modeHintText = doc.createElement("span");
    modeHintText.setAttribute("data-bp-part", "mode-hint-text");
    modeHintText.setAttribute("data-bp-i18n", "mode.text.hint");
    modeHint.append(modeHintText);
    modeHint.hidden = true;

    liveRegion = doc.createElement("p");
    liveRegion.className = "bp-visually-hidden bp-live";
    liveRegion.id = `bp-${instanceId}-live`;
    liveRegion.setAttribute("data-bp-part", "live");
    liveRegion.setAttribute("role", "status");
    liveRegion.setAttribute("aria-live", "polite");

    /* -- panel, composer, settings, legend --------------------------------- */

    panel = createPanel({
      document: doc,
      t,
      instanceId,
      notes: () => options.store.notes(),
      resolve: (note) => resolutions.get(note.id) ?? null,
      degraded: (note) => degradations.has(note.id) || note.anchor.degraded !== undefined,
      showDone: () => settings.showDone,
      selectedId: () => selectedId,
      actions: panelActions(),
      onError: reportError,
    });

    composer = createComposer({
      document: doc,
      t,
      instanceId,
      author: () => settings.author,
      feedbackOnly: () => settings.feedbackOnly,
      onSave: (input) => saveNote(input),
      onCancel: () => applyUiState(),
      onError: reportError,
    });

    settingsPopover = createSettings({
      document: doc,
      t,
      instanceId,
      state: () => settings,
      onChange: (patch) => applySettingsPatch(patch),
      onReset: () => resetSettings(),
    });

    legend = createLegend({
      document: doc,
      t,
      instanceId,
      keymap: options.keymap,
      onClose: () => applyUiState(),
    });

    node.append(
      markersLayer,
      highlight,
      bar,
      handle,
      modeHint,
      panel.element,
      composer.element,
      settingsPopover.element,
      legend.backdrop,
      legend.element,
      liveRegion,
    );

    mount.append(node);
    return node;
  }

  /* -- rendering: resolution, markers, counters, panel (FR-4.1/4.7/4.8) --- */

  let activeTarget: (ComposerTarget & { element: Element | null }) | null = null;

  function anchorOptions(): { hooks?: string[] } {
    return options.anchorHooks ? { hooks: options.anchorHooks } : {};
  }

  function refreshResolutions(): void {
    resolutions.clear();
    degradations.clear();
    for (const note of options.store.notes()) {
      try {
        const resolution = resolveAnchorDetailed(note.anchor, anchorOptions());
        resolutions.set(note.id, resolution.element);
        if (resolution.degraded !== undefined) {
          degradations.add(note.id);
        }
      } catch (error) {
        reportError(error);
        resolutions.set(note.id, null);
      }
    }
  }

  function visibleList(): Note[] {
    return panel?.visibleNotes() ?? [];
  }

  function renderCounters(): void {
    const counts = noteCounters(options.store.notes());
    for (const key of ["total", "open", "decisions", "feedback"] as const) {
      const node = counterValues[key];
      if (node) node.textContent = String(counts[key]);
    }
    if (handleCount) handleCount.textContent = String(counts.total);
  }

  function syncObservedTargets(targets: Iterable<Element>): void {
    const next = new Set<Element>(targets);
    const docElement = ownerDocument?.documentElement;
    if (docElement) next.add(docElement);
    if (resizeObserver) {
      for (const element of observedTargets) {
        if (!next.has(element)) resizeObserver.unobserve(element);
      }
      for (const element of next) {
        if (!observedTargets.includes(element)) resizeObserver.observe(element);
      }
    }
    observedTargets = Array.from(next);
  }

  /** One overlay marker per annotated element, with a count badge when notes share it (FR-4.1). */
  function renderMarkers(): void {
    const doc = ownerDocument;
    if (!markersLayer || !doc) return;

    const groups = new Map<Element, Note[]>();
    for (const note of visibleList()) {
      const element = resolutions.get(note.id) ?? null;
      if (!element) continue;
      const list = groups.get(element) ?? [];
      list.push(note);
      groups.set(element, list);
    }

    for (const [element, node] of Array.from(markerNodes.entries())) {
      if (!groups.has(element)) {
        node.remove();
        markerNodes.delete(element);
      }
    }

    for (const [element, notes] of groups) {
      let node = markerNodes.get(element);
      if (!node) {
        node = doc.createElement("button");
        node.type = "button";
        node.className = "bp-marker";
        node.setAttribute("data-bp-part", "marker");
        node.setAttribute("data-bp-action", "marker");
        node.setAttribute("data-bp-i18n-title", "a11y.markerLabel");
        const badge = doc.createElement("span");
        badge.className = "bp-marker-count";
        badge.setAttribute("data-bp-part", "marker-count");
        node.append(badge);
        markersLayer.append(node);
        markerNodes.set(element, node);
      }
      const first = notes[0];
      if (!first) continue;
      node.setAttribute("data-bp-note-id", first.id);
      node.setAttribute("data-bp-status", first.status);
      node.setAttribute("data-bp-intent", first.intent);
      node.setAttribute("data-bp-count", String(notes.length));
      node.setAttribute(
        "aria-label",
        notes.length > 1 ? t("a11y.markerCount", { count: notes.length }) : t("a11y.markerLabel"),
      );
      const badge = node.querySelector('[data-bp-part="marker-count"]');
      if (badge instanceof HTMLElement) {
        badge.textContent = notes.length > 1 ? String(notes.length) : "";
        badge.hidden = notes.length <= 1;
      }
    }

    syncObservedTargets(groups.keys());
    positionMarkers();
  }

  /**
   * Marker geometry is read, never written to the host: markers are `position: fixed` inside a
   * fixed container, so the host's box model is untouched (FR-1.8).
   */
  function positionMarkers(): void {
    if (!enabled) return;
    for (const [element, node] of markerNodes) {
      const rect =
        typeof element.getBoundingClientRect === "function" ? element.getBoundingClientRect() : null;
      if (!rect) {
        node.hidden = true;
        continue;
      }
      node.hidden = false;
      node.style.left = `${Math.round(rect.left - 4)}px`;
      node.style.top = `${Math.round(rect.top - 4)}px`;
    }
  }

  function renderAll(): void {
    if (!enabled || !root) return;
    refreshResolutions();
    panel?.render();
    renderMarkers();
    renderCounters();
    applyTranslations(root, t);
  }

  /* -- UI state ----------------------------------------------------------- */

  function pressedFor(slot: "mode-text" | "mode-design" | "panel" | "feedback-only" | "show-done"): boolean {
    if (slot === "mode-text") return mode === "text";
    if (slot === "mode-design") return mode === "design";
    if (slot === "panel") return panel?.isOpen() ?? false;
    if (slot === "feedback-only") return settings.feedbackOnly;
    return settings.showDone;
  }

  function applyUiState(): void {
    if (!enabled || !root) return;
    root.setAttribute("data-bp-mode", mode);
    root.setAttribute("data-bp-instance", instanceId);
    // Chrome level (FR-12.9): full keeps the bar/handle pair as before, quiet leaves only the
    // handle, off leaves the annotations without any chrome of their own.
    const level = chromeOverride ?? settings.chromeLevel;
    if (bar) bar.hidden = settings.barCollapsed || level !== "full";
    if (handle) handle.hidden = level === "off" || (level === "full" && !settings.barCollapsed);
    if (barCollapseButton) {
      barCollapseButton.setAttribute("data-bp-i18n", settings.barCollapsed ? "bar.expand" : "bar.collapse");
    }
    for (const slot of ["mode-text", "mode-design", "panel", "feedback-only", "show-done"] as const) {
      const button = pressedButtons[slot];
      if (button) {
        const pressed = pressedFor(slot);
        button.setAttribute("aria-pressed", pressed ? "true" : "false");
        button.classList.toggle("is-active", pressed);
      }
    }
    if (modeHint) modeHint.hidden = mode === "off";
    if (modeHintText && mode !== "off") {
      modeHintText.setAttribute("data-bp-i18n", mode === "design" ? "mode.design.hint" : "mode.text.hint");
    }
    settingsPopover?.render();
    renderAll();
  }

  function setMode(next: Mode): void {
    mode = next;
    applyUiState();
  }

  function setBarCollapsed(value: boolean): void {
    applySettingsPatch({ barCollapsed: value });
  }

  function setFeedbackOnly(value: boolean): void {
    applySettingsPatch({ feedbackOnly: value });
  }

  function announce(key: MessageKey): void {
    if (liveRegion) liveRegion.textContent = t(key);
  }

  /**
   * Set the chrome level and persist it (FR-12.9). `off` also closes the layer's own surfaces, so
   * "off" really means off; `disable()` remains the call that removes every node (NFR-15).
   */
  function setChromeLevel(level: ChromeLevel): void {
    chromeOverride = null; // an explicit choice wins over the one-load URL parameter
    applySettingsPatch({ chromeLevel: level });
    if (level === "off") {
      if (legend?.isOpen()) legend.close();
      if (settingsPopover?.isOpen()) settingsPopover.close();
      if (panel?.isOpen()) panel.close();
    }
    applyUiState();
  }

  function applySettingsPatch(patch: Partial<LayerSettings>): void {
    let languageChanged = false;
    if (patch.showDone !== undefined) settings.showDone = patch.showDone;
    if (patch.feedbackOnly !== undefined) settings.feedbackOnly = patch.feedbackOnly;
    if (patch.author !== undefined) settings.author = patch.author;
    if (patch.barCollapsed !== undefined) settings.barCollapsed = patch.barCollapsed;
    if (patch.chromeLevel !== undefined) settings.chromeLevel = patch.chromeLevel;
    if (patch.language !== undefined) {
      const next = normalizeLanguage(patch.language);
      languageChanged = next !== settings.language;
      settings.language = next;
    }
    if (languageChanged) {
      translator = createTranslator(settings.language);
      root?.setAttribute("lang", settings.language);
    }
    persistSettings();
    applyUiState();
  }

  /** Settings -> "reset to defaults" (FR-4.5), including the host's `defaultShowDone` (D4). */
  function resetSettings(): void {
    settings.showDone = options.defaultShowDone ?? DEFAULT_SETTINGS.showDone;
    settings.feedbackOnly = DEFAULT_SETTINGS.feedbackOnly;
    settings.author = DEFAULT_SETTINGS.author;
    settings.barCollapsed = DEFAULT_SETTINGS.barCollapsed;
    settings.language = normalizeLanguage(options.language);
    translator = createTranslator(settings.language);
    panel?.resetFilters();
    persistSettings();
    applyUiState();
  }

  /* -- store actions (the layer is the only part of the UI that writes) ---- */

  /** Run a store mutation; failures are reported, never thrown into the page (NFR-14). */
  async function mutate(action: () => Promise<unknown>, note?: Note): Promise<void> {
    try {
      await action();
    } catch (error) {
      reportError(error);
      if (note) panel?.reportNoteError(note, "panel.error.action");
    }
  }

  function authorName(): string {
    const configured = settings.author.trim();
    if (configured !== "") return configured;
    const identity = options.identity;
    if (identity !== undefined && identity !== "prompt" && identity !== "anonymous") {
      try {
        const user = identity.getUser?.();
        if (user && typeof user.name === "string" && user.name.trim() !== "") return user.name.trim();
      } catch (error) {
        reportError(error);
      }
    }
    return "anonymous";
  }

  /** Save the composer form into the store (FR-2.3, FR-9.3 — text only, resolved anchor first). */
  async function saveNote(input: ComposerSaveInput): Promise<ComposerSaveResult> {
    const target = activeTarget;
    const element = target?.element ?? null;
    if (target === null || element === null) {
      return { ok: false, reasonKey: "composer.error.save" };
    }
    if (!element.isConnected) {
      return { ok: false, reasonKey: "composer.error.vanished" };
    }
    let resolved = true;
    try {
      resolved = resolveAnchor(target.anchor, anchorOptions()) !== null;
    } catch (error) {
      reportError(error);
      resolved = false;
    }
    if (!resolved) {
      return { ok: false, reasonKey: "composer.error.vanished" };
    }

    const context = input.type === "design" ? (target.context ?? captureSafely(element)) : null;
    try {
      await options.store.create({
        type: input.type,
        body: input.body,
        anchor: { ...target.anchor },
        intent: input.intent,
        author: authorName(),
        authorType: "human",
        source: "ui:human",
        context,
      });
    } catch (error) {
      reportError(error);
      return { ok: false, reasonKey: "composer.error.save" };
    }
    announce("a11y.liveSaved");
    renderAll();
    return { ok: true };
  }

  function captureSafely(element: Element): CapturedContext | null {
    try {
      return captureContext(element, {
        ...(options.buildRef !== undefined ? { buildRef: options.buildRef } : {}),
        ...(view ? { view } : {}),
      });
    } catch (error) {
      reportError(error);
      return null;
    }
  }

  function panelActions(): PanelActions {
    return {
      reply: (note, text) => {
        void replyTo(note, text);
      },
      setIntent: (note, intent) => {
        void mutate(() => options.store.setIntent(note.id, intent), note);
      },
      setStatus: (note, status: NoteStatus) => {
        void mutate(() => options.store.setStatus(note.id, status), note);
      },
      remove: (note) => {
        void mutate(() => options.store.remove(note.id), note);
      },
      jump: (note, element) => jumpTo(note, element),
      export: (format) => exportNotes(format),
      setShowDone: (value) => {
        applySettingsPatch({ showDone: value });
      },
    };
  }

  /**
   * Answer a note (FR-5.5). `src/core/protocol.ts` decides the vocabulary: an answer to a pending
   * decision is `kind=decision` and reopens the note; everything else is a human `kind=reply`.
   */
  async function replyTo(note: Note, text: string): Promise<void> {
    const body = text.trim();
    if (body === "") {
      panel?.reportNoteError(note, "panel.reply.empty");
      return;
    }
    const author = authorName();
    const answered = note.status === "needs_decision" ? answerDecision(note, { text: body, author }) : null;
    const lastMessage = answered?.messages[answered.messages.length - 1];
    const kind: MessageKind = lastMessage?.kind ?? "reply";
    try {
      await options.store.reply(note.id, { text: body, author, authorType: "human", kind });
      if (answered !== null && answered.status !== note.status) {
        await options.store.setStatus(note.id, answered.status);
      }
    } catch (error) {
      reportError(error);
      panel?.reportNoteError(note, "panel.reply.error");
      return;
    }
    announce("a11y.liveSaved");
    renderAll();
  }

  /* -- jump and highlight (FR-4.7) ---------------------------------------- */

  function jumpTo(note: Note, element: Element | null): void {
    selectedId = note.id;
    if (element !== null) {
      try {
        const scroll = (element as { scrollIntoView?: (options?: ScrollIntoViewOptions) => void })
          .scrollIntoView;
        if (typeof scroll === "function") scroll.call(element, { block: "center", inline: "nearest" });
      } catch {
        // Scrolling is best effort; an unresolvable layout must not break the jump.
      }
      showHighlight(element);
    }
    panel?.render();
    renderMarkers();
  }

  /** Highlight overlay instead of touching host styles — the host box stays untouched (FR-1.8). */
  function showHighlight(element: Element): void {
    if (!highlight || typeof element.getBoundingClientRect !== "function") return;
    const rect = element.getBoundingClientRect();
    highlight.hidden = true;
    highlight.style.top = `${Math.round(rect.top)}px`;
    highlight.style.left = `${Math.round(rect.left)}px`;
    highlight.style.width = `${Math.round(rect.width)}px`;
    highlight.style.height = `${Math.round(rect.height)}px`;
    highlight.hidden = false;
    // Restart the CSS animation without a timer (NFR-2): a synchronous reflow read is enough.
    highlight.style.animation = "none";
    void highlight.offsetWidth;
    highlight.style.animation = "";
  }

  /* -- export (FR-7.1/7.2) ------------------------------------------------ */

  /**
   * Export the whole set. Both formats can fail — a JSON bundle refuses notes of two environments
   * (FR-14.1), a Markdown export can hit a broken anchor — so the failure is caught here, reported
   * to the host and shown inline; nothing is thrown into the click path (NFR-14).
   */
  function exportNotes(format: "markdown" | "json"): void {
    const isJson = format === "json";
    try {
      const notes = options.store.notes();
      const text = isJson
        ? toJson(notes)
        : toMarkdown(notes, {
            language: settings.language === "de" ? "de" : "en",
            includeDone: true,
          });
      download(
        text,
        isJson ? "bluepencil-notes.json" : "bluepencil-notes.md",
        isJson ? "application/json" : "text/markdown",
      );
      panel?.reportMessage(undefined);
    } catch (error) {
      reportFailure("panel.error.export", error);
    }
  }

  /** Host-provided download path; unavailable APIs degrade to a console note (NFR-5). */
  function download(text: string, filename: string, mime: string): void {
    const doc = ownerDocument;
    const urlApi = (globalThis as { URL?: { createObjectURL?: (blob: Blob) => string; revokeObjectURL?: (url: string) => void } }).URL;
    if (!doc || typeof Blob === "undefined" || typeof urlApi?.createObjectURL !== "function") {
      reportError(new Error(`bluepencil: ${t("status.error")} (URL.createObjectURL is unavailable)`));
      return;
    }
    try {
      const url = urlApi.createObjectURL(new Blob([text], { type: mime }));
      const anchor = doc.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.rel = "noopener";
      anchor.setAttribute("data-bp-ignore", "");
      anchor.click();
      urlApi.revokeObjectURL?.(url);
    } catch (error) {
      reportError(error);
    }
  }

  /* -- delegated host events ---------------------------------------------- */

  function composedPath(event: Event): readonly unknown[] {
    const getPath = (event as { composedPath?: () => EventTarget[] }).composedPath;
    if (typeof getPath === "function") {
      try {
        return getPath.call(event);
      } catch {
        // Fall through to the plain target below.
      }
    }
    return event.target ? [event.target] : [];
  }

  /** First element in the path that carries text, or a leaf block with its own text (FR-1.3). */
  /**
   * Registered selectors win over the built-in heuristic (FR-1.12): the host knows that `.card` is a
   * meaningful unit, the layer cannot. The nearest match in the path is the target, so the anchor is
   * the component and not the text node inside it.
   */
  function findRegisteredTarget(elements: readonly Element[]): Element | null {
    const selectors = options.annotateSelectors;
    if (selectors === undefined || selectors.length === 0) return null;
    for (const node of elements) {
      if (node.tagName === "BODY" || node.tagName === "HTML") break;
      for (const selector of selectors) {
        // Invalid selectors never reach here (they are filtered where the attribute is read) —
        // and a throw here must not kill the click.
        try {
          if (node.matches(selector)) return node;
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  function findTextTarget(elements: readonly Element[]): Element | null {
    const deepest = elements[0];
    for (const node of elements) {
      if (node.tagName === "BODY" || node.tagName === "HTML") break;
      if (TEXT_TAGS.has(node.tagName)) return node;
      if (node === deepest && hasDirectText(node)) return node;
    }
    // Issue #3: a component whose text lives in children used to end here as `null` — the click did
    // nothing and the component looked inert. The nearest element that *holds* text is still a
    // sensible block; a host that wants a different unit registers `annotateSelectors`.
    for (const node of elements) {
      if (node.tagName === "BODY" || node.tagName === "HTML") break;
      if (hasText(node)) return node;
    }
    return null;
  }

  function hasDirectText(element: Element): boolean {
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === 3 && (child.textContent ?? "").trim() !== "") return true;
    }
    return false;
  }

  function hasText(element: Element): boolean {
    return (element.textContent ?? "").trim() !== "";
  }

  function canAnnotate(element: Element): boolean {
    if (!options.canAnnotate) return true;
    try {
      return options.canAnnotate(element) !== false;
    } catch (error) {
      reportError(error);
      return false;
    }
  }

  function onDocumentClick(event: Event): void {
    if (!enabled || !root) return;
    const path = composedPath(event);
    if (path.includes(root)) {
      // Clicks on the layer's own UI are routed by action. Deliberately no `stopPropagation()`
      // here: FR-12.6 restricts that call to the active-mode branch below.
      handleLayerClick(event, path);
      return;
    }
    // Another bluepencil instance's UI is never an annotation target (multi-instance, FR-12.3).
    if (path.some((node) => isElement(node) && node.hasAttribute("data-bp-instance"))) return;
    // Idle: the layer never interferes with host events (FR-12.6).
    if (mode === "off") return;

    const elements = path.filter(isElement);
    const target = elements[0];
    if (!target) return;
    // FR-1.9: links, form fields, [data-bp-ignore], editable regions stay operable in every mode.
    if (elements.some((element) => isPassThroughElement(element))) return;
    if (!canAnnotate(target)) return;

    // A registered component wins over the built-in heuristic in both modes (FR-1.12).
    const picked = findRegisteredTarget(elements) ?? (mode === "design" ? target : findTextTarget(elements));
    if (picked === null || !canAnnotate(picked)) return;

    // Only while a mode is active do we swallow the click for the host.
    event.stopPropagation();
    openComposerFor(picked, mode === "design" ? "design" : "text");
  }

  /**
   * Route a click inside the layer by `data-bp-action` (one listener for the whole instance).
   * The whole dispatch runs guarded: a failing store, export or render step is reported through
   * `onError` and shown inline instead of escaping into the host page (NFR-14). The click itself
   * is never swallowed here (FR-12.6).
   */
  function handleLayerClick(event: Event, path: readonly unknown[]): void {
    try {
      dispatchLayerAction(event, path);
    } catch (error) {
      reportFailure("panel.error.action", error);
    }
  }

  function dispatchLayerAction(event: Event, path: readonly unknown[]): void {
    const actionNode = path.find((node) => isElement(node) && node.hasAttribute("data-bp-action"));
    if (!isElement(actionNode)) return;
    const action = actionNode.getAttribute("data-bp-action");
    settingsPopover?.commitFields();
    const note = noteForNode(actionNode);

    switch (action) {
      case "mode-text":
        setMode(mode === "text" ? "off" : "text");
        return;
      case "mode-design":
        setMode(mode === "design" ? "off" : "design");
        return;
      case "panel":
        panel?.toggle();
        applyUiState();
        return;
      case "panel-close":
        panel?.close();
        applyUiState();
        return;
      case "feedback-only":
        setFeedbackOnly(!settings.feedbackOnly);
        return;
      case "show-done":
        applySettingsPatch({ showDone: !settings.showDone });
        return;
      case "legend":
        if (legend?.isOpen()) {
          legend.close();
        } else {
          legend?.open();
        }
        applyUiState();
        return;
      case "legend-close":
      case "legend-backdrop":
        legend?.close();
        return;
      case "settings":
        settingsPopover?.toggle();
        applyUiState();
        return;
      case "settings-close":
        settingsPopover?.close();
        return;
      case "settings-reset":
        resetSettings();
        return;
      case "collapse":
        setBarCollapsed(true);
        return;
      case "expand":
        setBarCollapsed(false);
        return;
      case "composer-cancel":
        composer?.close();
        applyUiState();
        return;
      case "composer-save":
        composer?.save();
        return;
      case "marker":
      case "jump":
        if (note) jumpTo(note, resolutions.get(note.id) ?? null);
        return;
      case "reply":
        if (note) void replyTo(note, panel?.replyValue(note) ?? "");
        return;
      case "toggle-intent":
        if (note) {
          void mutate(
            () => options.store.setIntent(note.id, note.intent === "implement" ? "feedback" : "implement"),
            note,
          );
        }
        return;
      case "mark-done":
        if (note) void mutate(() => options.store.setStatus(note.id, "done"), note);
        return;
      case "reopen":
        if (note) void mutate(() => options.store.setStatus(note.id, "open"), note);
        return;
      case "delete":
        confirmDelete(actionNode, note);
        return;
      case "export-markdown":
        exportNotes("markdown");
        return;
      case "export-json":
        exportNotes("json");
        return;
      default:
        composer?.handleClick(event);
    }
  }

  /** Two-step delete for a single note (FR-8.1) — no blocking `confirm()` in the host page. */
  function confirmDelete(button: Element, note: Note | null): void {
    if (note === null) return;
    if (button.getAttribute("data-bp-confirm") !== "true") {
      button.setAttribute("data-bp-confirm", "true");
      button.setAttribute("data-bp-i18n", "panel.action.confirmDelete");
      button.textContent = t("panel.action.confirmDelete");
      return;
    }
    void mutate(() => options.store.remove(note.id), note);
  }

  function noteForNode(node: Element): Note | null {
    const holder = node.closest("[data-bp-note-id]") ?? node;
    const id = holder.getAttribute("data-bp-note-id");
    if (id === null || id === "") return null;
    return options.store.notes().find((note) => note.id === id) ?? null;
  }

  /** Filters (FR-4.2) and the settings surface (FR-4.5) — both delegated to one listener. */
  function onDocumentChange(event: Event): void {
    if (!enabled) return;
    const target = event.target;
    if (!isElement(target)) return;

    const filterName = target.getAttribute("data-bp-filter");
    if (filterName === "type" || filterName === "intent" || filterName === "status") {
      panel?.setFilter(filterName, (target as HTMLSelectElement).value);
      renderMarkers();
      renderCounters();
      return;
    }

    const setting = target.getAttribute("data-bp-setting");
    if (setting === "show-done") {
      applySettingsPatch({ showDone: (target as HTMLInputElement).checked });
    } else if (setting === "feedback-only") {
      applySettingsPatch({ feedbackOnly: (target as HTMLInputElement).checked });
    } else if (setting === "author") {
      settingsPopover?.markDirty();
      applySettingsPatch({ author: (target as HTMLInputElement).value });
    } else if (setting === "language") {
      applySettingsPatch({ language: (target as HTMLSelectElement).value });
    }
  }

  /**
   * Keyboard operation (FR-1.6/1.7/11.2) — one capture-phase listener for the whole layer.
   *
   * Reserved keys while the layer owns the keyboard (`mode !== "off"` or one of its surfaces is
   * open): `c`/`d` modes, `l` panel, `f` feedback-only, `b` bar, `?` legend, `j`/`k` selection,
   * `1`–`9` jump, `Escape` cancel, and `Ctrl/⌘ + Enter` inside the composer. They are only ever
   * swallowed (preventDefault/stopPropagation) in that state; while the layer is idle the same
   * shortcuts still act on the layer, but the host keeps its own key (FR-12.6).
   */
  function onDocumentKeyDown(event: Event): void {
    if (!enabled) return;
    if (!(event instanceof KeyboardEvent)) return;
    const rawKey = event.key;
    const key = rawKey.length === 1 ? rawKey.toLowerCase() : rawKey;
    // Captured before the switch: `c`/`d` change the mode themselves, and the decision to swallow
    // the key belongs to the state the layer was in when the key arrived.
    const idle = isIdle();

    if (composer?.isOpen()) {
      if (composer.handleKey(event)) {
        event.preventDefault();
        if (!idle) event.stopPropagation();
      }
      return;
    }

    if (key === "Escape") {
      if (escape()) {
        event.preventDefault();
        // Swallowing follows the state the key arrived in: leaving a mode is still our action.
        if (!idle) event.stopPropagation();
      }
      return;
    }

    // Never hijack typing in a host field (FR-12.6).
    if (isEditableTarget(event.target)) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;

    // The registry decides which key means what (FR-1.11): handler and legend read the same table, so
    // a key cannot work without being documented — or be documented without working.
    const shortcut = keymap.binding.get(normaliseKey(rawKey));
    let handled = true;
    if (shortcut === undefined) {
      if (/^[1-9]$/.test(key)) {
        jumpToIndex(Number(key) - 1);
      } else {
        handled = false;
      }
    } else {
      switch (shortcut.id) {
        case "mode.text":
          setMode(mode === "text" ? "off" : "text");
          break;
        case "mode.design":
          setMode(mode === "design" ? "off" : "design");
          break;
        case "panel":
          panel?.toggle();
          applyUiState();
          break;
        case "feedback-only":
          setFeedbackOnly(!settings.feedbackOnly);
          break;
        case "bar":
          setBarCollapsed(!settings.barCollapsed);
          break;
        case "chrome":
          setChromeLevel(
            settings.chromeLevel === "full" ? "quiet" : settings.chromeLevel === "quiet" ? "off" : "full",
          );
          break;
        case "legend":
          if (legend?.isOpen()) {
            legend.close();
          } else {
            legend?.open();
          }
          applyUiState();
          break;
        case "next":
          moveSelection(1);
          break;
        case "previous":
          moveSelection(-1);
          break;
        case "cancel":
          // `Esc` is consumed by `escape()` above; this branch keeps the switch exhaustive.
          break;
        case "jump":
        case "save":
          // Range and composer-scoped shortcuts never reach the document handler.
          handled = false;
          break;
      }
    }
    if (!handled || idle) return;
    event.preventDefault();
    // FR-12.6: a key is swallowed for the host only while the layer owns the keyboard.
    event.stopPropagation();
  }

  /** Esc: closes the topmost layer surface, then leaves the mode (FR-1.7/11.2). */
  function escape(): boolean {
    if (composer?.isOpen()) {
      composer.close();
      return true;
    }
    if (legend?.isOpen()) {
      legend.close();
      return true;
    }
    if (settingsPopover?.isOpen()) {
      settingsPopover.close();
      return true;
    }
    if (mode !== "off") {
      setMode("off");
      return true;
    }
    if (panel?.isOpen()) {
      panel.close();
      applyUiState();
      return true;
    }
    return false;
  }

  function moveSelection(delta: number): void {
    const list = visibleList();
    if (list.length === 0) return;
    const current = selectedId === null ? -1 : list.findIndex((note) => note.id === selectedId);
    const nextIndex =
      current === -1
        ? delta > 0
          ? 0
          : list.length - 1
        : Math.min(Math.max(current + delta, 0), list.length - 1);
    const note = list[nextIndex];
    if (!note) return;
    if (!panel?.isOpen()) panel?.open();
    jumpTo(note, resolutions.get(note.id) ?? null);
  }

  function jumpToIndex(index: number): void {
    const note = visibleList()[index];
    if (!note) return;
    if (!panel?.isOpen()) panel?.open();
    jumpTo(note, resolutions.get(note.id) ?? null);
  }

  function onScroll(): void {
    positionMarkers();
  }

  function onResize(): void {
    positionMarkers();
  }

  /* -- anchoring a new note (FR-1.3/1.4/1.5/2.2) -------------------------- */

  function safeRoute(element?: Element): string | undefined {
    if (!options.getRoute) return undefined;
    try {
      // The annotated element goes in: a host that derives the route from the element answers for
      // *that* note instead of for whatever happens to be on screen when the composer opens.
      const route = options.getRoute(element);
      return typeof route === "string" && route !== "" ? route : undefined;
    } catch (error) {
      reportError(error);
      return undefined;
    }
  }

  function safeSelectionQuote(): string | undefined {
    try {
      return view ? selectionQuote(view) : undefined;
    } catch (error) {
      reportError(error);
      return undefined;
    }
  }

  function openComposerFor(element: Element, type: "text" | "design"): void {
    const route = safeRoute(element);
    const quote = type === "text" ? safeSelectionQuote() : undefined;
    let anchor: Anchor;
    let label: string;
    try {
      anchor = deriveAnchor(element, {
        ...anchorOptions(),
        ...(route !== undefined ? { route } : {}),
        ...(quote !== undefined ? { quote } : {}),
      });
      label = describeElement(element);
    } catch (error) {
      reportError(error);
      return;
    }
    const context = type === "design" ? captureSafely(element) : null;
    const target: ComposerTarget = {
      type,
      anchor,
      ...(quote !== undefined ? { quote } : {}),
      context,
      element,
      label,
    };
    activeTarget = target;
    composer?.open(target);
  }

  /* -- listeners, observer, lifecycle (FR-12.1/12.2, NFR-15) --------------- */

  function attachListeners(): void {
    const doc = ownerDocument;
    if (!doc) return;
    // Capture phase everywhere: the layer sees events before the host does, and only then
    // decides whether to interfere (FR-12.6). Every handler is guarded, so a defect in our own
    // code reports through `onError` instead of surfacing in the host's console (NFR-14).
    listen(doc, "click", guard(onDocumentClick), true);
    listen(doc, "change", guard(onDocumentChange), true);
    listen(doc, "keydown", guard(onDocumentKeyDown), true);
    if (view) {
      listen(view, "scroll", onScroll, { capture: true, passive: true });
      listen(view, "resize", onResize, { passive: true });
    }
  }

  function attachObserver(): void {
    const Observer = (globalThis as { ResizeObserver?: new (callback: () => void) => { observe(target: Element): void; unobserve(target: Element): void; disconnect(): void } }).ResizeObserver;
    if (typeof Observer !== "function") {
      reportDegraded("ResizeObserver is unavailable — markers follow scroll and resize only");
      return;
    }
    try {
      resizeObserver = new Observer(() => {
        positionMarkers();
      });
    } catch (error) {
      resizeObserver = null;
      reportError(error);
    }
  }

  function enable(): void {
    if (enabled) return;
    if (!ownerDocument || typeof ownerDocument.createElement !== "function") {
      reportDegraded("no document is available — the layer stays disabled (FR-1.1)");
      return;
    }
    const node = buildRoot();
    if (!node) {
      reportDegraded("the host provides no mount target — the layer stays disabled (FR-1.1)");
      return;
    }
    root = node;
    enabled = true;
    acquireStyles(ownerDocument);
    attachListeners();
    attachObserver();
    try {
      unsubscribeStore = options.store.subscribe(() => {
        if (enabled) renderAll();
      });
    } catch (error) {
      unsubscribeStore = null;
      reportError(error);
    }
    applyUiState();
    // Hydrate from the adapter on every enable(): the store starts empty and only the host (or
    // this call) asks the transport for persisted notes (NFR-2, NFR-8). reload() notifies the
    // subscription above, so the bar, markers and panel render the restored set, and `hydrated()`
    // lets `Blueprint.ready()` await it instead of starting a second read.
    hydration = Promise.resolve()
      .then(() => options.store.reload())
      .catch((error: unknown) => reportError(error));
    void hydration;
    if (options.markerStrategy === "sibling") {
      reportDegraded("markerStrategy 'sibling' is not implemented in M1 — using the overlay strategy (D2)");
    }
  }

  /** Complete, idempotent teardown: nodes, listeners, observer, subscription, style (FR-12.2). */
  function disable(): void {
    if (!enabled) return;
    enabled = false;

    unlistenAll();
    if (unsubscribeStore) {
      try {
        unsubscribeStore();
      } catch (error) {
        reportError(error);
      }
      unsubscribeStore = null;
    }
    if (resizeObserver) {
      try {
        resizeObserver.disconnect();
      } catch (error) {
        reportError(error);
      }
      resizeObserver = null;
    }
    observedTargets = [];

    panel?.close();
    composer?.close();
    legend?.close();
    settingsPopover?.close();

    markerNodes.clear();
    resolutions.clear();
    degradations.clear();
    selectedId = null;
    mode = "off";
    activeTarget = null;

    root?.remove();
    root = null;
    bar = null;
    handle = null;
    handleCount = null;
    modeHint = null;
    modeHintText = null;
    markersLayer = null;
    highlight = null;
    liveRegion = null;
    barCollapseButton = null;
    panel = null;
    composer = null;
    legend = null;
    settingsPopover = null;

    if (ownerDocument) releaseStyles(ownerDocument);
  }

  return {
    enable,
    disable,
    chrome: () => chromeOverride ?? settings.chromeLevel,
    setChrome: setChromeLevel,
    isEnabled: () => enabled,
    /** Store hydration of the last `enable()` (additive; used by `Blueprint.ready()`). */
    hydrated: () => hydration,
    /** Re-render from the current store snapshot (host-driven refresh). */
    refresh(): void {
      if (!enabled) return;
      renderAll();
    },
    setShowDone(value: boolean): void {
      applySettingsPatch({ showDone: value });
    },
  };
}




