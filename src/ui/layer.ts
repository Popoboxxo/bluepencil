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

import { deriveAnchor, describeElement, resolveAnchorDetailed } from "../core/anchor";
import { selectionQuote } from "../core/capture";
import { toJson } from "../core/export/json";
import { toMarkdown } from "../core/export/markdown";
import type {
  Anchor,
  Environment,
  Note,
  NotePriority,
  NoteSeverity,
  NoteStatus,
} from "../core/model";
import { isNotePriority, isNoteSeverity } from "../core/model";
import type { Store } from "../core/store";
import { applyTranslations } from "../i18n";
import type { MessageKey } from "../i18n/en";
import { createComposer, type Composer, type ComposerTarget } from "./composer";
import { createLegend } from "./legend";
import { keyIdentifier, resolveKeymap, type KeymapOverrides } from "./keymap";
import {
  CAPTURE_MODES,
  CAPTURE_PRESETS,
  isCaptureMode,
  type CaptureMode,
  type CaptureSemantics,
} from "./modes";
import { createLayerJump, type LayerJumpUnit } from "./layer-jump";
import { createLayerNotes, type LayerNotesUnit } from "./layer-notes";
import { createLayerSettings } from "./layer-settings";
import { createLayerPresentation, type LayerPresentationUnit } from "./layer-presentation";
import { VERSION } from "../version";
import {
  createPanel,
  createSettings,
  noteCounters,
  type LayerSettings,
  type Panel,
  type PanelActions,
  type SettingsPopover,
} from "./panel";
import { createLayerTeardown } from "./layer-teardown";
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
  /** Registered target selectors (FR-1.12): the nearest match in the click path becomes the target. */
  annotateSelectors?: readonly string[];
  /**
   * Host ceiling for capture modes (FR-4.10): the modes this host offers. `"none"` mounts a
   * read-only layer (list, exports, legend and settings stay available, nothing can be captured).
   */
  modes?: readonly CaptureMode[] | "none";
  /** Shortcut overrides (FR-12.11); conflicts and non-remappable keys are reported (FR-12.11). */
  keymap?: KeymapOverrides;
  /** Initial chrome level (FR-12.9); the user's choice is persisted on top of it. */
  chrome?: ChromeLevel;
  /** The edge the strip and its handle dock to (FR-12.13); the mode hint takes the opposite edge. */
  dock?: "top" | "bottom";
  getRoute?: (element?: Element) => string;
  identity?: { getUser?: () => { id?: string; name: string } } | "prompt" | "anonymous";
  markerStrategy?: "overlay" | "sibling";
  defaultShowDone?: boolean;
  buildRef?: string;
  /** Name/build of the embedding app, stamped into an exported bundle (issue #21). */
  app?: { name: string; buildRef?: string };
  /** Exporter recorded in an exported bundle (issue #21); default `"unknown"`. */
  exportedBy?: string;
  /** Environment stamped into an exported bundle; a store scopes its notes by it (NFR-18). */
  environment?: Environment;
  /**
   * Steps between the host's own chapters (FR-20.7). The layer knows its notes, not the talk: the
   * chapter order belongs to the product that embeds the layer, so the `present.chapter.*` keys
   * are forwarded here instead of being handled in the panel. `+1` is next, `-1` is previous.
   */
  onChapter?: (direction: 1 | -1) => void;
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

/** Annotation modes (FR-1.3 text / FR-1.4 design / FR-1.13 bug / FR-1.14 feature). */
type Mode = "off" | CaptureMode;

/** Bar slots that carry pressed state — one per capture mode plus the toggles. */
type BarSlot = `mode-${CaptureMode}` | "panel" | "feedback-only" | "show-done";

function modeSlot(mode: CaptureMode): BarSlot {
  return `mode-${mode}`;
}

/**
 * How much chrome the layer shows: `full` = bar + handle, `quiet` = handle only, `off` = neither.
 * Not `disable()`: annotations stay, only the layer's own controls go (NFR-15 keeps that meaning).
 */
export type ChromeLevel = "full" | "quiet" | "off";

/* -------------------------------------------------------------------------- */
/* style registry — one sheet per document, removed with the last layer        */
/* -------------------------------------------------------------------------- */

/**
 * How the sheet was delivered, because the two ways need different teardown.
 *
 * - `node`     an inline `<style>` element in the document head.
 * - `adopted`  a constructable `CSSStyleSheet` on `document.adoptedStyleSheets`.
 */
type StyleSheetHandle =
  | { kind: "node"; node: HTMLStyleElement }
  | { kind: "adopted"; previous: CSSStyleSheet[] };

type StyleEntry = { handle: StyleSheetHandle; refs: number };

const STYLE_NODES = new WeakMap<Document, StyleEntry>();

/**
 * Whether the inline `<style>` node actually took effect.
 *
 * A page CSP can drop an inline stylesheet: under `style-src 'self'` the node is still inserted,
 * but the engine does not apply it, so the sheet is inert and the layer renders unstyled — which
 * is worse than no sheet, because everything *looks* mounted. The tell is `sheet.cssRules`: an
 * applied sheet exposes its rules, a discarded one has no `CSSStyleSheet` at all.
 */
function inlineSheetApplied(node: HTMLStyleElement): boolean {
  try {
    return node.sheet !== null && node.sheet.cssRules.length > 0;
  } catch {
    // A cross-origin sheet can throw on access. That is not our node, so treat it as "not ours
    // to judge" and fall through to the alternative path rather than guessing.
    return false;
  }
}

/** Deliver the stylesheet as a constructable sheet, which a page CSP does not govern. */
function adoptStyles(doc: Document): boolean {
  const Sheet = (globalThis as { CSSStyleSheet?: typeof CSSStyleSheet }).CSSStyleSheet;
  const target = doc as Document & { adoptedStyleSheets?: CSSStyleSheet[] };
  // A constructable sheet is only usable if the engine supports construction, adoption AND the
  // sync form. jsdom ships a CSSStyleSheet constructor without `replaceSync`, so checking for the
  // method here is what keeps the fallback honest instead of assuming it exists.
  const constructable = (Sheet as { prototype?: { replaceSync?: unknown } } | undefined)?.prototype;
  if (Sheet === undefined || constructable?.replaceSync === undefined) return false;
  if (target.adoptedStyleSheets === undefined) return false;
  try {
    const sheet = new Sheet();
    sheet.replaceSync(STYLES);
    // Record what the document had adopted BEFORE adding ours, so teardown can put the host's own
    // sheets back. Capturing the array after the assignment would store the combined list and make
    // teardown a no-op that leaks our sheet into the page for good.
    const previous = target.adoptedStyleSheets;
    target.adoptedStyleSheets = [...previous, sheet];
    STYLE_NODES.set(doc, { handle: { kind: "adopted", previous }, refs: 1 });
    return true;
  } catch {
    return false;
  }
}

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

  // A CSP that forbids inline styles leaves the node in place but inert. Verify before trusting
  // it, and switch to a constructable sheet otherwise — the layer must not depend on the host
  // permitting inline styles.
  if (inlineSheetApplied(node)) {
    STYLE_NODES.set(doc, { handle: { kind: "node", node }, refs: 1 });
    return;
  }
  if (!adoptStyles(doc)) {
    // No constructable sheets either (an old engine, or a document that forbids them). Keep the
    // node: a CSP that merely *reports* a violation still renders on some engines, and an empty
    // document is strictly worse than an unverified one.
    STYLE_NODES.set(doc, { handle: { kind: "node", node }, refs: 1 });
    return;
  }
  node.remove();
}

function releaseStyles(doc: Document): void {
  const entry = STYLE_NODES.get(doc);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  if (entry.handle.kind === "node") {
    entry.handle.node.remove();
  } else {
    // Restore whatever the document had adopted before — a host's own sheets must survive a
    // layer that mounts and unmounts.
    const target = doc as Document & { adoptedStyleSheets?: CSSStyleSheet[] };
    if (target.adoptedStyleSheets !== undefined) {
      target.adoptedStyleSheets = entry.handle.previous;
    }
  }
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

/** The interactive elements Alt+click may annotate (FR-1.15). */
const ALT_CLICK_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "OPTION", "OPTGROUP", "BUTTON", "SUMMARY"]);

function isInteractiveElement(el: Element): boolean {
  if (el.tagName === "A") return el.hasAttribute("href");
  if (ALT_CLICK_TAGS.has(el.tagName)) return true;
  if (el.hasAttribute("contenteditable")) return true;
  const role = el.getAttribute("role");
  return role !== null && PASS_THROUGH_ROLES.has(role);
}

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

export function createLayer(options: LayerOptions): LayerHandle {
  instanceCounter += 1;
  const instanceId = `i${instanceCounter}`;

  const ownerDocument = options.document ?? (typeof document !== "undefined" ? document : undefined);
  const view = ownerDocument?.defaultView ?? (typeof window !== "undefined" ? window : undefined);

  /* -- state --------------------------------------------------------------- */

  /**
   * The settings unit (CQ-03 split, spec §3.13 L): preferences, persistence, translator, chrome
   * level and the host mode ceiling. `settings` stays a live alias so the render paths read the
   * same object the unit mutates in place.
   */
  const settingsUnit = createLayerSettings({
    ...(view === undefined ? {} : { view }),
    ...(options.language === undefined ? {} : { language: options.language }),
    ...(options.chrome === undefined ? {} : { chrome: options.chrome }),
    ...(options.defaultShowDone === undefined ? {} : { defaultShowDone: options.defaultShowDone }),
    ...(options.modes === undefined ? {} : { modes: options.modes }),
  });
  const settings = settingsUnit.settings;
  const hostModes = settingsUnit.hostModes;
  const t = settingsUnit.t;

  let enabled = false;
  let mode: Mode = "off";
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
  let liveRegion: HTMLElement | null = null;
  let barCollapseButton: HTMLButtonElement | null = null;
  const counterValues: Partial<Record<keyof ReturnType<typeof noteCounters>, HTMLElement>> = {};
  const pressedButtons: Partial<Record<BarSlot, HTMLButtonElement>> = {};

  let panel: Panel | null = null;
  let composer: Composer | null = null;
  let legend: ReturnType<typeof createLegend> | null = null;
  /** Presentation mode surface (FR-20); null until enable() builds it. */
  let presentation: LayerPresentationUnit | null = null;

  /**
   * The write path (CQ-03 split, spec §3.13 L): one unit for every store mutation, the composer
   * target and the author resolution. Created once per layer instance; `dispose()` on `disable()`.
   */
  const notes: LayerNotesUnit = createLayerNotes({
    store: options.store,
    t,
    settings: () => settings,
    panel: () => panel,
    composer: () => composer,
    ...(options.anchorHooks === undefined ? {} : { anchorHooks: options.anchorHooks }),
    ...(options.buildRef === undefined ? {} : { buildRef: options.buildRef }),
    ...(view === undefined ? {} : { view }),
    ...(options.identity === undefined ? {} : { identity: options.identity }),
    announce,
    renderAll,
    onError: reportError,
  });

  /**
   * The selection, the highlight overlay and `j`/`k`/digits navigation (CQ-03 split, spec §3.13 L;
   * FR-4.7). Created per instance; the overlay itself per `enable()`.
   */
  const jump: LayerJumpUnit = createLayerJump({
    panel: () => panel,
    elementFor: (note) => resolutions.get(note.id) ?? null,
    onRevealed: (note, element) => {
      resolutions.set(note.id, element);
    },
    visibleNotes: () => panel?.visibleNotes() ?? [],
    renderMarkers,
    ...(options.anchorHooks === undefined ? {} : { anchorHooks: options.anchorHooks }),
    onError: reportError,
  });

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

  /** Ordered `dispose()` steps of one enable cycle (CQ-03 split, spec §3.13 L; FR-12.2). */
  const teardown = createLayerTeardown();

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
    node.setAttribute("data-bp-version", VERSION);
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

    // The highlight overlay is owned by the jump unit; it registers its own animation listener.
    const highlight = jump.attach(doc, instanceId);

    /* -- bar and handle (FR-1.2, FR-4.8) ----------------------------------- */

    bar = doc.createElement("div");
    bar.className = "bp-bar";
    bar.id = `bp-${instanceId}-bar`;
    bar.setAttribute("data-bp-part", "bar");
    bar.setAttribute("data-bp-slot", "top-end");
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("data-bp-i18n-aria", "a11y.barLabel");

    const barTitle = doc.createElement("span");
    barTitle.className = "bp-bar-title";
    barTitle.setAttribute("data-bp-i18n", "bar.title");
    bar.append(barTitle);

    const barButton = (action: string, key: MessageKey, slot?: BarSlot): HTMLButtonElement => {
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

    // One button per preset, in the table's order — adding a mode never means new bar code.
    for (const captureMode of CAPTURE_MODES) {
      bar.append(
        barButton(`mode-${captureMode}`, `bar.mode.${captureMode}` as MessageKey, modeSlot(captureMode)),
      );
    }
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
    handle.setAttribute("data-bp-slot", "top-end");
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
    modeHint.setAttribute("data-bp-slot", "bottom-center");
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
      selectedId: () => jump.selectedId(),
      actions: panelActions(),
      onError: reportError,
    });

    composer = createComposer({
      document: doc,
      t,
      instanceId,
      author: () => settings.author,
      feedbackOnly: () => settings.feedbackOnly,
      onSave: (input) => notes.save(input),
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
      hostModes: () => hostModes,
    });

    legend = createLegend({
      document: doc,
      t,
      instanceId,
      keymap: options.keymap,
      modes: () => settingsUnit.availableModes(),
      onClose: () => applyUiState(),
    });

    /* -- presentation mode (FR-20) --------------------------------------- */

    // The panel writes through the same store as the composer (FR-15.3: one source of truth), so a
    // cue edited while presenting is the same note the review list shows. Writes go through
    // `mutate` like every other layer action, which keeps the error path in one place.
    presentation = createLayerPresentation({
      t,
      notes: () => options.store.notes(),
      onWrite: (id, body) => {
        const note = options.store.notes().find((candidate) => candidate.id === id);
        if (!note) return;
        void notes.mutate(() => options.store.update(id, { body }), note);
      },
      onRetime: (id, at) => {
        const note = options.store.notes().find((candidate) => candidate.id === id);
        if (!note) return;
        void notes.mutate(() => options.store.update(id, { timing: { ...note.timing, at } }), note);
      },
      onError: reportError,
    });
    presentation.attach(doc);

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
    // The presenter panel reads the same store snapshot, so it follows the same render pass —
    // a note added or retimed in the review list is visible in the next cue immediately.
    presentation?.refresh();
    applyTranslations(root, t);
  }

  /* -- UI state ----------------------------------------------------------- */

  function pressedFor(slot: BarSlot): boolean {
    if (slot.startsWith("mode-")) return mode === slot.slice("mode-".length);
    if (slot === "panel") return panel?.isOpen() ?? false;
    if (slot === "feedback-only") return settings.feedbackOnly;
    return settings.showDone;
  }

  function applyUiState(): void {
    if (!enabled || !root) return;
    // FR-4.10: a mode that became unavailable (host ceiling or a settings change) cannot stay
    // active — falling back to "off" is the only state the bar can still show honestly.
    if (mode !== "off" && !settingsUnit.modeAvailable(mode)) mode = "off";
    root.setAttribute("data-bp-mode", mode);
    root.setAttribute("data-bp-instance", instanceId);
    // Chrome level (FR-12.9): full keeps the bar/handle pair as before, quiet leaves only the
    // handle, off leaves the annotations without any chrome of their own. A narrow viewport behaves
    // as `quiet` on its own (FR-12.13) without touching the stored preference.
    const level = settingsUnit.chromeLevel();
    root.setAttribute("data-bp-dock", options.dock === "bottom" ? "bottom" : "top");
    if (bar) bar.hidden = settings.barCollapsed || level !== "full";
    if (handle) handle.hidden = level === "off" || (level === "full" && !settings.barCollapsed);
    if (barCollapseButton) {
      barCollapseButton.setAttribute("data-bp-i18n", settings.barCollapsed ? "bar.expand" : "bar.collapse");
    }
    for (const captureMode of CAPTURE_MODES) {
      const button = pressedButtons[modeSlot(captureMode)];
      if (!button) continue;
      // Unavailable modes disappear instead of looking clickable but inert (FR-4.10).
      button.hidden = !settingsUnit.modeAvailable(captureMode);
      const pressed = mode === captureMode;
      button.setAttribute("aria-pressed", pressed ? "true" : "false");
      button.classList.toggle("is-active", pressed);
    }
    for (const slot of ["panel", "feedback-only", "show-done"] as const) {
      const button = pressedButtons[slot];
      if (button) {
        const pressed = pressedFor(slot);
        button.setAttribute("aria-pressed", pressed ? "true" : "false");
        button.classList.toggle("is-active", pressed);
      }
    }
    // A read-only host offers no capture at all; the feedback-only toggle would be meaningless.
    const feedbackButton = pressedButtons["feedback-only"];
    if (feedbackButton) feedbackButton.hidden = !settingsUnit.anyModeAvailable();
    if (modeHint) modeHint.hidden = mode === "off";
    if (modeHintText && mode !== "off") {
      modeHintText.setAttribute("data-bp-i18n", `mode.${mode}.hint` as MessageKey);
    }
    settingsPopover?.render();
    renderAll();
  }

  function setMode(next: Mode): void {
    mode = next;
    applyUiState();
  }

  /** Toggle a capture mode; unavailable modes are a no-op (FR-4.10) — the button/key is inert. */
  function toggleMode(next: CaptureMode): void {
    if (!settingsUnit.modeAvailable(next)) return;
    setMode(mode === next ? "off" : next);
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
   * The viewport crossed (or left) the narrow range (FR-12.13). Below `NARROW_WIDTH` the strip yields
   * to its handle on its own; above it the stored preference applies again. Never persisted — this is
   * a fact about the viewport, not a choice.
   */
  function onViewportResize(): void {
    if (view === undefined) return;
    if (settingsUnit.updateWidth(view.innerWidth)) applyUiState();
  }

  /**
   * Set the chrome level and persist it (FR-12.9). `off` also closes the layer's own surfaces, so
   * "off" really means off; `disable()` remains the call that removes every node (NFR-15).
   */
  function setChromeLevel(level: ChromeLevel): void {
    settingsUnit.setChromeOverride(null); // an explicit choice wins over the one-load URL parameter
    applySettingsPatch({ chromeLevel: level });
    if (level === "off") {
      if (legend?.isOpen()) legend.close();
      if (settingsPopover?.isOpen()) settingsPopover.close();
      if (panel?.isOpen()) panel.close();
    }
    applyUiState();
  }

  function applySettingsPatch(patch: Partial<LayerSettings>): void {
    // State, persistence and the translator swap live in the settings unit; the root's `lang`
    // attribute and the render pass stay here, because they are DOM.
    const { languageChanged } = settingsUnit.patch(patch);
    if (languageChanged) root?.setAttribute("lang", settings.language);
    applyUiState();
  }

  /** Settings -> "reset to defaults" (FR-4.5), including the host's `defaultShowDone` (D4). */
  function resetSettings(): void {
    settingsUnit.reset();
    panel?.resetFilters();
    applyUiState();
  }

  /* -- panel actions (wiring table over the units) ------------------------- */

  /**
   * The panel's action table: it only routes to the units and to the layer's own render/export
   * steps. The write path itself lives in `layer-notes.ts` (CQ-03 split, spec §3.13 L).
   */
  function panelActions(): PanelActions {
    return {
      reply: (note, text) => {
        void notes.reply(note, text);
      },
      setIntent: (note, intent) => {
        void notes.mutate(() => options.store.setIntent(note.id, intent), note);
      },
      setStatus: (note, status: NoteStatus) => {
        void notes.mutate(() => options.store.setStatus(note.id, status), note);
      },
      setSeverity: (note, severity: NoteSeverity | null) => {
        void notes.mutate(() => options.store.update(note.id, { severity }), note);
      },
      setPriority: (note, priority: NotePriority | null) => {
        void notes.mutate(() => options.store.update(note.id, { priority }), note);
      },
      remove: (note) => {
        void notes.mutate(() => options.store.remove(note.id), note);
      },
      jump: (note, element) => jump.jumpTo(note, element),
      export: (format) => exportNotes(format),
      setShowDone: (value) => {
        applySettingsPatch({ showDone: value });
      },
    };
  }

  /* -- export (FR-7.1/7.2) ------------------------------------------------ */

  /**
   * Bundle metadata the host configured (issue #21). Without it every export of a tag-embedded
   * deployment said `app.name: "unknown"` / `exportedBy: "unknown"`, so two bundles from two
   * products were indistinguishable for the reviewer/agent hand-off.
   */
  function bundleApp(): { name: string; buildRef?: string } | undefined {
    const name = options.app?.name;
    const buildRef = options.app?.buildRef ?? options.buildRef;
    if (name === undefined && buildRef === undefined) return undefined;
    return { name: name ?? "unknown", ...(buildRef === undefined ? {} : { buildRef }) };
  }

  /**
   * Export the whole set. Both formats can fail — a JSON bundle refuses notes of two environments
   * (FR-14.1), a Markdown export can hit a broken anchor — so the failure is caught here, reported
   * to the host and shown inline; nothing is thrown into the click path (NFR-14).
   */
  function exportNotes(format: "markdown" | "json"): void {
    const isJson = format === "json";
    try {
      const notes = options.store.notes();
      const app = bundleApp();
      const text = isJson
        ? toJson(notes, {
            ...(app === undefined ? {} : { app }),
            ...(options.exportedBy === undefined ? {} : { exportedBy: options.exportedBy }),
            ...(options.environment === undefined ? {} : { environment: options.environment }),
          })
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

  /**
   * Resolve the text target along the path (FR-1.3).
   *
   * `strict` skips the Issue #3 ancestry fallback: the hybrid preset (FR-1.14) must decide from the
   * clicked subtree alone, because an ancestor's text may come from a sibling outside it. Without
   * `strict` the fallback stays intact for the text and design presets.
   */
  function findTextTarget(elements: readonly Element[], strict = false): Element | null {
    const deepest = elements[0];
    for (const node of elements) {
      if (node.tagName === "BODY" || node.tagName === "HTML") break;
      if (TEXT_TAGS.has(node.tagName)) return node;
      if (node === deepest && hasDirectText(node)) return node;
    }
    if (strict) return null;
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

  /** Resolve the element and the payload a normal (non-Alt) click captures for one preset. */
  function resolveCapture(
    captureMode: CaptureMode,
    elements: readonly Element[],
    registered: Element | null,
  ): { picked: Element; semantics: CaptureSemantics } | null {
    const preset = CAPTURE_PRESETS[captureMode];
    const target = elements[0];
    if (!target) return null;
    if (preset.capture === "text") {
      const picked = registered ?? findTextTarget(elements);
      return picked === null ? null : { picked, semantics: "text" };
    }
    if (preset.capture === "design") {
      return { picked: registered ?? target, semantics: "design" };
    }
    // Hybrid (FR-1.14): a registered component is the unit, but only a genuinely textual one gets
    // a quote; otherwise — and without a registered component — fall back to the strict text
    // heuristic (clicked subtree only, no ancestor whose text comes from elsewhere), then to the
    // clicked element with design semantics.
    if (registered !== null) {
      const textual = TEXT_TAGS.has(registered.tagName) || hasDirectText(registered);
      return { picked: registered, semantics: textual ? "text" : "design" };
    }
    const textTarget = findTextTarget(elements, true);
    if (textTarget !== null) return { picked: textTarget, semantics: "text" };
    return { picked: target, semantics: "design" };
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

    // FR-1.15 / FR-12.6: Alt+click is the documented exception that reaches an interactive host
    // element. `[data-bp-ignore]` and `canAnnotate` stay vetoes — a host can still opt out.
    const altClick = (event as MouseEvent).altKey === true;
    const interactive = elements.find(isInteractiveElement);
    if (altClick && interactive !== undefined) {
      if (elements.some((element) => element.hasAttribute("data-bp-ignore"))) return;
      const picked = findRegisteredTarget(elements) ?? interactive;
      if (!canAnnotate(interactive) || !canAnnotate(picked)) return;
      // The host click is explicitly replaced by the capture, including its default action.
      event.preventDefault();
      event.stopPropagation();
      openComposerFor(picked, mode);
      return;
    }

    // FR-1.9: links, form fields, [data-bp-ignore], editable regions stay operable in every mode.
    if (elements.some((element) => isPassThroughElement(element))) return;
    if (!canAnnotate(target)) return;

    // A registered component wins over the built-in heuristic in every mode (FR-1.12).
    const resolved = resolveCapture(mode, elements, findRegisteredTarget(elements));
    if (resolved === null || !canAnnotate(resolved.picked)) return;

    // Only while a mode is active do we swallow the click for the host.
    event.stopPropagation();
    openComposerFor(resolved.picked, mode, resolved.semantics);
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
    const note = notes.noteForNode(actionNode);

    switch (action) {
      case "mode-text":
        toggleMode("text");
        return;
      case "mode-design":
        toggleMode("design");
        return;
      case "mode-bug":
        toggleMode("bug");
        return;
      case "mode-feature":
        toggleMode("feature");
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
        if (note) jump.jumpTo(note, resolutions.get(note.id) ?? null);
        return;
      case "reply":
        if (note) void notes.reply(note, panel?.replyValue(note) ?? "");
        return;
      case "toggle-intent":
        if (note) {
          void notes.mutate(
            () => options.store.setIntent(note.id, note.intent === "implement" ? "feedback" : "implement"),
            note,
          );
        }
        return;
      case "mark-done":
        if (note) void notes.mutate(() => options.store.setStatus(note.id, "done"), note);
        return;
      case "reopen":
        if (note) void notes.mutate(() => options.store.setStatus(note.id, "open"), note);
        return;
      case "delete":
        notes.confirmDelete(actionNode, note);
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

  /** Filters (FR-4.2) and the settings surface (FR-4.5) — both delegated to one listener. */
  function onDocumentChange(event: Event): void {
    if (!enabled) return;
    const target = event.target;
    if (!isElement(target)) return;

    // FR-4.10: in-place grading of an existing note (severity for a bug, priority for a feature).
    const noteField = target.getAttribute("data-bp-note-field");
    if (noteField === "severity" || noteField === "priority") {
      const holder = target.closest("[data-bp-note-id]");
      const id = holder?.getAttribute("data-bp-note-id") ?? null;
      const note = id === null ? null : (options.store.notes().find((entry) => entry.id === id) ?? null);
      if (note === null) return;
      const raw = (target as HTMLSelectElement).value;
      if (noteField === "severity") {
        const severity = isNoteSeverity(raw) ? raw : null;
        panelActions().setSeverity(note, severity);
      } else {
        const priority = isNotePriority(raw) ? raw : null;
        panelActions().setPriority(note, priority);
      }
      return;
    }

    const filterName = target.getAttribute("data-bp-filter");
    if (
      filterName === "type" ||
      filterName === "intent" ||
      filterName === "status" ||
      filterName === "severity" ||
      filterName === "priority"
    ) {
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
    } else if (setting !== null && setting.startsWith("mode-")) {
      const captureMode = setting.slice("mode-".length);
      if (isCaptureMode(captureMode)) {
        // The full record, so a stale partial patch can never half-change the ceiling checks.
        applySettingsPatch({
          modes: { ...settings.modes, [captureMode]: (target as HTMLInputElement).checked },
        });
      }
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

    // FR-20.8: the presentation keys are the only ones that need `Shift`, so a shifted key that is
    // not in the registry belongs to the host and must fall through untouched (FR-12.6).
    // The lookup uses `keyIdentifier`, not the raw name: an engine that reports `ARROWLEFT` would
    // otherwise miss the `Shift+ArrowLeft` entry and hand a documented key to the host.
    const shift = event.shiftKey;
    if (shift && !keymap.binding.has(keyIdentifier(rawKey, true))) return;

    // The registry decides which key means what (FR-1.11): handler and legend read the same table, so
    // a key cannot work without being documented — or be documented without working.
    const shortcut = keymap.binding.get(keyIdentifier(rawKey, shift));
    let handled = true;
    if (shortcut === undefined) {
      if (/^[1-9]$/.test(key)) {
        jump.jumpToIndex(Number(key) - 1);
      } else {
        handled = false;
      }
    } else {
      switch (shortcut.id) {
        case "mode.text":
          if (!settingsUnit.modeAvailable("text")) {
            handled = false;
            break;
          }
          toggleMode("text");
          break;
        case "mode.design":
          if (!settingsUnit.modeAvailable("design")) {
            handled = false;
            break;
          }
          toggleMode("design");
          break;
        case "mode.bug":
          if (!settingsUnit.modeAvailable("bug")) {
            handled = false;
            break;
          }
          toggleMode("bug");
          break;
        case "mode.feature":
          if (!settingsUnit.modeAvailable("feature")) {
            handled = false;
            break;
          }
          toggleMode("feature");
          break;
        case "panel":
          panel?.toggle();
          applyUiState();
          break;
        case "feedback-only":
          // The bar button is hidden when no mode is available; the shortcut must be just as inert
          // and leave the key to the host (FR-4.10, FR-12.6).
          if (!settingsUnit.anyModeAvailable()) {
            handled = false;
            break;
          }
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
          jump.moveSelection(1);
          break;
        case "previous":
          jump.moveSelection(-1);
          break;
        case "cancel":
          // `Esc` is consumed by `escape()` above; this branch keeps the switch exhaustive.
          break;
        case "present.toggle":
          presentation?.toggle();
          break;
        case "present.mode":
          presentation?.toggleMode();
          break;
        case "present.audience":
          presentation?.openAudience();
          break;
        case "present.timer":
          // One key for both directions: the clock knows whether it is running.
          presentation?.toggleClock();
          break;
        case "present.reset":
          presentation?.reset();
          break;
        case "present.chapter.next":
        case "present.chapter.previous":
          // Stepping between chapters is the *host's* job — the layer only knows its own notes, so
          // it asks the host through the same route provider that names a note's chapter.
          options.onChapter?.(shortcut.id === "present.chapter.next" ? 1 : -1);
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

  function onScroll(): void {
    positionMarkers();
  }

  function onResize(): void {
    positionMarkers();
    onViewportResize();
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

  /**
   * Open the composer for one mode. `type` always comes from the preset table (FR-1.3/1.4/1.13/1.14);
   * `captureOverride` only decides the `hybrid` case (a feature on text vs. on design).
   */
  function openComposerFor(
    element: Element,
    captureMode: CaptureMode,
    captureOverride?: CaptureSemantics,
  ): void {
    const preset = CAPTURE_PRESETS[captureMode];
    const semantics: CaptureSemantics =
      preset.capture === "hybrid" ? (captureOverride ?? "design") : preset.capture;
    const route = safeRoute(element);
    const quote = semantics === "text" ? safeSelectionQuote() : undefined;
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
    const context = semantics === "design" ? notes.capture(element) : null;
    const target: ComposerTarget = {
      type: preset.type,
      anchor,
      ...(quote !== undefined ? { quote } : {}),
      context,
      element,
      label,
    };
    notes.setTarget(target);
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

  /**
   * Registers the teardown steps in the order `disable()` must run them (FR-12.2, NFR-15): the
   * event/listener surface first, then the units, then state and the style/root nodes.
   */
  function registerTeardown(): void {
    teardown.add(unlistenAll);
    teardown.add(() => {
      if (unsubscribeStore) {
        try {
          unsubscribeStore();
        } catch (error) {
          reportError(error);
        }
        unsubscribeStore = null;
      }
    });
    teardown.add(() => {
      if (resizeObserver) {
        try {
          resizeObserver.disconnect();
        } catch (error) {
          reportError(error);
        }
        resizeObserver = null;
      }
      observedTargets = [];
    });
    teardown.add(() => {
      panel?.close();
      composer?.close();
      legend?.close();
      settingsPopover?.close();
    });
    teardown.add(() => {
      // FR-12.2: teardown must leave no timer, listener or channel behind. The presentation surface
      // owns a 250 ms ticker and a BroadcastChannel, so it is torn down with everything else.
      presentation?.dispose();
      presentation = null;
    });
    // The jump unit owns the highlight node and its animation listener (FR-12.2).
    teardown.add(() => {
      jump.dispose();
    });
    teardown.add(() => {
      notes.dispose();
    });
    teardown.add(() => {
      markerNodes.clear();
      resolutions.clear();
      degradations.clear();
      mode = "off";
    });
    teardown.add(() => {
      if (ownerDocument) releaseStyles(ownerDocument);
    });
    teardown.add(() => {
      root?.remove();
      root = null;
      bar = null;
      handle = null;
      handleCount = null;
      modeHint = null;
      modeHintText = null;
      markersLayer = null;
      liveRegion = null;
      barCollapseButton = null;
      panel = null;
      composer = null;
      legend = null;
      settingsPopover = null;
      // Settings owns no node, but the unit contract is uniform; the stored preference survives.
      settingsUnit.dispose();
    });
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
    registerTeardown();
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

  /** Complete, idempotent teardown: the ordered `dispose()` list (FR-12.2). */
  function disable(): void {
    if (!enabled) return;
    enabled = false;
    teardown.run(reportError);
  }

  return {
    enable,
    disable,
    chrome: () => settingsUnit.chrome(),
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




