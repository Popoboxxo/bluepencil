/**
 * Context capture — the curated snapshot a design note carries (FR-1.4, FR-13.5).
 *
 * Only a deliberate subset of the computed style is stored (never all of `getComputedStyle`), so a
 * note stays small, diffable and readable in a Markdown export. The module is DOM-aware but
 * framework-agnostic and dependency-free.
 *
 * Degradation contract: every environment API is optional. Headless DOMs (jsdom) have no layout —
 * `getBoundingClientRect` returns zeros, so `box` is all zeros rather than throwing; a window
 * without `matchMedia` means `light`; a missing `getComputedStyle` yields empty string values.
 * The shape of `CapturedContext` is stable: every subset key is always present.
 */

import { BluepencilValidationError, type CapturedContext } from "./model";

/**
 * Curated computed-style subset (INTERNAL-API §5): typography, colour, spacing, border, radius and
 * layout properties that a reviewer actually reads. `border*` is captured as the four widths plus
 * the `border-style`/`border-color` shorthands, which browsers resolve in the computed style.
 */
export const STYLE_SUBSET: readonly string[] = Object.freeze([
  "display",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-align",
  "color",
  "background-color",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-style",
  "border-color",
  "border-radius",
  "gap",
  "row-gap",
  "column-gap",
]);

interface StyleLike {
  getPropertyValue?: (property: string) => string;
}

interface RectLike {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  left?: number;
  top?: number;
}

interface SelectionLike {
  toString?: () => string;
  rangeCount?: number;
  getRangeAt?: (index: number) => { toString?: () => string };
}

/* -------------------------------------------------------------------------- */
/* internal helpers                                                            */
/* -------------------------------------------------------------------------- */

function isElementLike(value: unknown): value is Element {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { tagName?: unknown }).tagName === "string"
  );
}

/** Window to read viewport/scheme/selection from: explicit, else the element's own view. */
function resolveView(el: Element, view?: Window): Window | undefined {
  if (view) return view;
  const owner = (el as { ownerDocument?: Document | null }).ownerDocument;
  const defaultView = owner ? (owner as { defaultView?: Window | null }).defaultView : null;
  if (defaultView) return defaultView;
  const globalWindow = (globalThis as { window?: Window }).window;
  return globalWindow ?? undefined;
}

function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function computedStyleOf(view: Window | undefined, el: Element): StyleLike | null {
  const compute =
    view && typeof view.getComputedStyle === "function"
      ? view.getComputedStyle
      : (globalThis as { getComputedStyle?: (element: Element) => StyleLike }).getComputedStyle;
  if (typeof compute !== "function") return null;
  try {
    return view ? compute.call(view, el) : compute(el);
  } catch {
    return null;
  }
}

function styleValue(computed: StyleLike | null, property: string): string {
  if (!computed || typeof computed.getPropertyValue !== "function") return "";
  try {
    const value = computed.getPropertyValue(property);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function rectOf(el: Element): RectLike | null {
  const getRect = (el as { getBoundingClientRect?: () => RectLike }).getBoundingClientRect;
  if (typeof getRect !== "function") return null;
  try {
    return getRect.call(el);
  } catch {
    return null;
  }
}

function classesOf(el: Element): string[] {
  const classList = (el as { classList?: ArrayLike<string> }).classList;
  if (classList && typeof classList.length === "number") {
    const names: string[] = [];
    for (let i = 0; i < classList.length; i += 1) {
      const name = classList[i];
      if (typeof name === "string" && name !== "") names.push(name);
    }
    return names;
  }
  const readAttribute = (el as { getAttribute?: (name: string) => string | null }).getAttribute;
  if (typeof readAttribute !== "function") return [];
  const raw = readAttribute.call(el, "class");
  if (typeof raw !== "string" || raw.trim() === "") return [];
  return raw.split(/\s+/).filter((name) => name !== "");
}

function readSelection(view: Window | undefined): SelectionLike | null {
  if (!view) return null;
  const getSelection = (view as { getSelection?: () => SelectionLike | null }).getSelection;
  if (typeof getSelection === "function") {
    try {
      const selection = getSelection.call(view);
      if (selection) return selection;
    } catch {
      /* fall through to the document */
    }
  }
  const owner = (view as { document?: Document | null }).document;
  const documentSelection = owner
    ? (owner as { getSelection?: () => SelectionLike | null }).getSelection
    : undefined;
  if (typeof documentSelection === "function") {
    try {
      return documentSelection.call(owner) ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

function selectionText(selection: SelectionLike): string | undefined {
  // Range first: it is the value that actually carries the text, and it avoids the useless
  // `Object.prototype.toString` inherited by every object.
  const rangeCount = typeof selection.rangeCount === "number" ? selection.rangeCount : 0;
  if (rangeCount > 0 && typeof selection.getRangeAt === "function") {
    try {
      const range = selection.getRangeAt(0);
      const text = range && typeof range.toString === "function" ? range.toString() : undefined;
      if (typeof text === "string" && text.trim() !== "") return text;
    } catch {
      /* fall through to toString */
    }
  }
  const toString = selection.toString;
  if (typeof toString === "function" && toString !== Object.prototype.toString) {
    try {
      const text = toString.call(selection);
      if (typeof text === "string") return text;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* public API                                                                  */
/* -------------------------------------------------------------------------- */

/** Scheme from `prefers-color-scheme`; `light` whenever the API is unavailable (FR-1.4). */
export function detectScheme(view?: Window): "light" | "dark" {
  if (!view) return "light";
  const matchMedia = (view as { matchMedia?: (query: string) => { matches?: boolean } }).matchMedia;
  if (typeof matchMedia !== "function") return "light";
  try {
    const query = matchMedia.call(view, "(prefers-color-scheme: dark)");
    return query && query.matches === true ? "dark" : "light";
  } catch {
    return "light";
  }
}

/**
 * Text of the current selection, trimmed — stored verbatim as the note quote (FR-1.5).
 * Returns `undefined` when there is no selection or the API is missing.
 */
export function selectionQuote(view?: Window): string | undefined {
  const globalWindow = (globalThis as { window?: Window }).window;
  const target = view ?? globalWindow ?? undefined;
  if (!target) return undefined;
  const selection = readSelection(target);
  if (!selection) return undefined;
  const text = selectionText(selection);
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Capture the curated context of an annotated element (FR-1.4). `buildRef` is stored verbatim
 * when the host supplies it (FR-2.5); the viewport comes from `window.innerWidth/innerHeight`.
 */
export function captureContext(
  el: Element,
  options?: { buildRef?: string; view?: Window },
): CapturedContext {
  if (!isElementLike(el)) {
    throw new BluepencilValidationError(["captureContext: expected a DOM Element"]);
  }
  const view = resolveView(el, options?.view);
  const computed = computedStyleOf(view, el);
  const styles: Record<string, string> = {};
  for (const property of STYLE_SUBSET) {
    styles[property] = styleValue(computed, property);
  }

  const rect = rectOf(el);
  const context: CapturedContext = {
    tag: String(el.tagName).toLowerCase(),
    classes: classesOf(el),
    styles,
    box: {
      w: finiteOrZero(rect?.width),
      h: finiteOrZero(rect?.height),
      x: finiteOrZero(rect?.x ?? rect?.left),
      y: finiteOrZero(rect?.y ?? rect?.top),
    },
    scheme: detectScheme(view),
    viewport: {
      w: finiteOrZero(view?.innerWidth),
      h: finiteOrZero(view?.innerHeight),
    },
  };

  const buildRef = options?.buildRef;
  if (typeof buildRef === "string" && buildRef.trim() !== "") context.buildRef = buildRef;
  return context;
}
