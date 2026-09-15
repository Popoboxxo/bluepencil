/**
 * Element anchoring — derive, encode and resolve note anchors (FR-2.x, FR-12.4, ARCHITECTURE §6b).
 *
 * This module is DOM-aware but framework-agnostic and dependency-free. It is the only place that
 * knows how a note finds its element again after a re-render:
 *
 *  - primary anchor: host hook (`data-bluepencil`, `data-testid`) — the most stable anchor (D6);
 *  - secondary anchor: CSS path, shadow boundaries encoded as ` >> ` and resolved segment by
 *    segment via `element.shadowRoot` (ARCHITECTURE §6b);
 *  - last resort: text quote, so a re-worded element is still found (FR-1.5, FR-2.1).
 *
 * Resolution order is hook -> selector -> quote. An unresolvable anchor returns `null`; the caller
 * marks `anchor.orphaned = true` and never drops the note (FR-2.4). A path segment that lives
 * behind a *closed* shadow root cannot be resolved and is reported as `anchor.degraded` — the note
 * keeps hook/quote and is flagged instead of failing silently (FR-2.4, §6b).
 *
 * Input handling contract:
 *  - `deriveAnchor` throws `BluepencilValidationError` for anything that is not an element-like
 *    object (a note must not be built from an invalid anchor, FR-2.3);
 *  - `hookValue`/`resolveAnchor`/`resolvePath`/`findQuote` never throw — they return
 *    `undefined`/`null` so a broken anchor can only ever produce an *orphaned* note;
 *  - `cssPath`/`composePath`/`describeElement` are formatting helpers and return `""` for invalid
 *    input, so a list render loop can never break on a half-built node.
 */

import { BluepencilValidationError, type Anchor } from "./model";

/** Tree-scope separator used inside a stored CSS path (ARCHITECTURE §6b). */
const SHADOW_BOUNDARY = " >> ";

/** Default hooks, in priority order (D6, INTERNAL-API §4). */
const DEFAULT_HOOKS: readonly string[] = Object.freeze(["data-bluepencil", "data-testid"]);

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

/** `Node.TEXT_NODE` without relying on a DOM global being present. */
const TEXT_NODE = 3;

/** Longest text excerpt used by `describeElement`. */
const LABEL_MAX = 40;

export interface AnchorOptions {
  hooks?: string[];
  root?: ParentNode;
}

/* -------------------------------------------------------------------------- */
/* internal helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Hook attribute names to use. `undefined` means the defaults; an explicit list is used as given
 * (an empty list disables hook resolution entirely).
 */
function normalizeHooks(hooks?: readonly string[]): string[] {
  if (hooks === undefined) return [...DEFAULT_HOOKS];
  return hooks.filter((name): name is string => typeof name === "string" && name.trim() !== "");
}

function isElementLike(value: unknown): value is Element {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { tagName?: unknown }).tagName === "string"
  );
}

function assertElementLike(value: unknown, where: string): asserts value is Element {
  if (!isElementLike(value)) {
    throw new BluepencilValidationError([`${where}: expected a DOM Element`]);
  }
}

interface HookMatch {
  name: string;
  value: string;
}

/** First hook attribute present on the element, in hook priority order. */
function hookMatch(el: Element, hooks: readonly string[]): HookMatch | undefined {
  if (typeof el.getAttribute !== "function") return undefined;
  for (const name of hooks) {
    let value: string | null = null;
    try {
      value = el.getAttribute(name);
    } catch {
      value = null;
    }
    if (typeof value === "string" && value !== "") return { name, value };
  }
  return undefined;
}

export function hookValue(el: Element, hooks?: string[]): string | undefined {
  if (!isElementLike(el)) return undefined;
  return hookMatch(el, normalizeHooks(hooks))?.value;
}

/** Escape a value for use inside a double-quoted attribute selector. */
function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Absolute selector for a hooked element: `button[data-testid="save"]`. */
function hookElementSelector(el: Element, match: HookMatch): string {
  return `${selectorTag(el)}[${match.name}="${escapeAttributeValue(match.value)}"]`;
}

/** Lower-cased tag for HTML, verbatim tag for foreign (e.g. SVG) elements, `*` when unknown. */
function selectorTag(el: Element): string {
  const raw = typeof el.tagName === "string" ? el.tagName : "";
  if (raw === "") return "*";
  const namespace = (el as { namespaceURI?: string | null }).namespaceURI;
  return namespace && namespace !== HTML_NAMESPACE ? raw : raw.toLowerCase();
}

function isDocumentRootElement(el: Element): boolean {
  const owner = (el as { ownerDocument?: Document | null }).ownerDocument;
  const documentElement = owner ? owner.documentElement : null;
  return documentElement !== null && documentElement === el;
}

interface Queryable {
  querySelector?: (selectors: string) => Element | null;
  querySelectorAll?: (selectors: string) => ArrayLike<Element>;
}

function defaultRoot(): ParentNode | null {
  const globalDocument = (globalThis as { document?: Document }).document;
  return globalDocument ?? null;
}

function isShadowRootNode(node: Node | null | undefined): node is ShadowRoot {
  if (!node || typeof node !== "object") return false;
  const host = (node as { host?: unknown }).host;
  return typeof host !== "undefined" && host !== null;
}

/** Tree scope root of a node — `getRootNode()` when available, parent walk otherwise. */
function scopeRootOf(node: Node): Node {
  const withRootNode = node as Node & { getRootNode?: () => Node };
  if (typeof withRootNode.getRootNode === "function") {
    try {
      return withRootNode.getRootNode();
    } catch {
      /* fall through to the parent walk */
    }
  }
  let current: Node = node;
  for (;;) {
    const parent: Node | null = current.parentNode;
    if (!parent) return current;
    current = parent;
  }
}

/** True for a closed shadow root: present, but not reachable from the host element. */
function isClosedShadowRoot(root: Node): boolean {
  return isShadowRootNode(root) && (root as { mode?: unknown }).mode === "closed";
}

function shadowRootOf(el: Element): ShadowRoot | null {
  const root = (el as { shadowRoot?: ShadowRoot | null }).shadowRoot;
  if (!root || typeof root !== "object") return null;
  return root;
}

/** Direct child elements of a container (light DOM only; shadow content is added explicitly). */
function childElements(container: ParentNode): Element[] {
  const children = (container as { children?: ArrayLike<Element> }).children;
  if (!children) return [];
  const out: Element[] = [];
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child) out.push(child);
  }
  return out;
}

/** Light children plus, for an open shadow host, the shadow children. */
function composedChildElements(container: ParentNode): Element[] {
  const out = childElements(container);
  const shadow = (container as { shadowRoot?: ShadowRoot | null }).shadowRoot;
  if (shadow) out.push(...childElements(shadow));
  return out;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function textContentOf(node: Node): string {
  const text = (node as { textContent?: string | null }).textContent;
  return typeof text === "string" ? text : "";
}

/** Visible-ish text of an element, including open shadow subtrees (textContent stops at them). */
function composedText(el: Element): string {
  const parts: string[] = [];
  collectText(el, parts);
  const shadow = shadowRootOf(el);
  if (shadow) collectText(shadow, parts);
  return normalizeText(parts.join(" "));
}

function collectText(container: ParentNode, parts: string[]): void {
  for (const node of container.childNodes) {
    if (node.nodeType === TEXT_NODE) {
      parts.push(textContentOf(node));
    } else if (isElementLike(node)) {
      parts.push(composedText(node));
    }
  }
}

function querySelectorSafe(scope: ParentNode, selector: string): Element | null {
  const query = (scope as Queryable).querySelector;
  if (typeof query !== "function") return null;
  try {
    return scope.querySelector(selector);
  } catch {
    // Malformed selector (corrupted anchor) must degrade to "not found", never throw into the page.
    return null;
  }
}

function querySelectorAllSafe(scope: ParentNode, selector: string): Element[] {
  const query = (scope as Queryable).querySelectorAll;
  if (typeof query !== "function") return [];
  try {
    const list = scope.querySelectorAll(selector);
    const out: Element[] = [];
    for (let i = 0; i < list.length; i += 1) {
      const el = list[i];
      if (el) out.push(el);
    }
    return out;
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* path building                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One segment for an element inside its own tree scope: `tag:nth-of-type(n)`.
 * `withOrdinal = false` is used for the scope root (`html`), where no ordinal is needed.
 */
function structuralSegment(el: Element, withOrdinal: boolean): string {
  const tag = selectorTag(el);
  if (!withOrdinal) return tag;
  let ordinal = 1;
  const parent = (el as { parentElement?: Element | null }).parentElement;
  if (parent) {
    for (const sibling of childElements(parent)) {
      if (sibling === el) break;
      if (selectorTag(sibling) === tag) ordinal += 1;
    }
  }
  return `${tag}:nth-of-type(${ordinal})`;
}

/**
 * Path of `el` inside its own tree scope, hook-aware:
 *
 *  - `leafHook` allows the element's own hook to short-circuit the whole path (used for the host
 *    segments of a composed path, where the host is not the element the note is about);
 *  - the anchor's own element is *never* described by its own hook, so the stored selector still
 *    resolves after that hook was removed (FR-2.1 fallback);
 *  - an ancestor hook short-circuits the walk, which keeps the path stable when the surrounding
 *    list is re-rendered (FR-2.6);
 *  - without any hook the path falls back to `nth-of-type` segments.
 */
function cssPathInScope(el: Element, hooks: readonly string[], leafHook: boolean): string {
  const chain: Element[] = [];
  let node: Element | null = el;
  while (node) {
    chain.unshift(node);
    node = (node as { parentElement?: Element | null }).parentElement ?? null;
  }

  if (leafHook) {
    const own = hookMatch(el, hooks);
    if (own) return hookElementSelector(el, own);
  }

  // Outermost hooked ancestor below the element itself becomes the base of the path.
  let base = 0;
  for (let i = 0; i < chain.length - 1; i += 1) {
    const candidate = chain[i];
    if (candidate && hookMatch(candidate, hooks)) {
      base = i;
      break;
    }
  }

  const segments: string[] = [];
  for (let i = base; i < chain.length; i += 1) {
    const current = chain[i];
    if (!current) continue;
    if (i === base && base > 0) {
      const match = hookMatch(current, hooks);
      segments.push(
        match ? hookElementSelector(current, match) : structuralSegment(current, true),
      );
    } else {
      segments.push(structuralSegment(current, i !== 0 || !isDocumentRootElement(current)));
    }
  }
  return segments.join(" > ");
}

interface ComposedPath {
  /** Path segments, outermost tree scope first. */
  segments: string[];
  /** First segment that sits behind a closed shadow root (unresolvable from the outside). */
  degraded?: string;
}

/** Full path across shadow boundaries, boundary by boundary (ARCHITECTURE §6b). */
function composePathSegments(el: Element, hooks: readonly string[]): ComposedPath {
  const entries: { segment: string; closed: boolean }[] = [];
  let current: Element = el;
  for (;;) {
    const root = scopeRootOf(current);
    const insideShadow = isShadowRootNode(root);
    entries.push({
      segment: cssPathInScope(current, hooks, entries.length > 0),
      closed: insideShadow && isClosedShadowRoot(root),
    });
    if (!insideShadow) break;
    current = root.host;
  }
  entries.reverse();
  const ordered = entries.map((entry) => entry.segment);
  const unreachable = entries.find((entry) => entry.closed);
  return unreachable
    ? { segments: ordered, degraded: unreachable.segment }
    : { segments: ordered };
}

/**
 * Complete CSS path of an element, shadow boundaries encoded as ` >> ` (FR-12.4, §6b).
 * Hook-aware: host hooks and ancestor hooks are preferred over `nth-of-type` segments (D6).
 * Returns `""` for invalid input.
 */
export function cssPath(el: Element, hooks?: string[]): string {
  if (!isElementLike(el)) return "";
  return composePathSegments(el, normalizeHooks(hooks)).segments.join(SHADOW_BOUNDARY);
}

/** `cssPath` with the default hooks — the plain, hook-based composition of a shadow-aware path. */
export function composePath(el: Element): string {
  return cssPath(el);
}

/** Short human label for the note list, e.g. `button.btn-primary "Save changes"`. */
export function describeElement(el: Element): string {
  if (!isElementLike(el)) return "";
  const parts = [selectorTag(el)];
  const id = typeof el.id === "string" ? el.id : "";
  const match = hookMatch(el, normalizeHooks(undefined));
  if (id !== "") {
    parts.push(`#${id}`);
  } else if (match) {
    parts.push(`[${match.name}="${match.value}"]`);
  } else {
    const classes = classListOf(el).slice(0, 2);
    if (classes.length > 0) parts.push(`.${classes.join(".")}`);
  }
  const label = elementLabel(el);
  return label === "" ? parts.join("") : `${parts.join("")} "${label}"`;
}

function classListOf(el: Element): string[] {
  const classList = (el as { classList?: ArrayLike<string> }).classList;
  if (classList && typeof classList.length === "number") {
    const names: string[] = [];
    for (let i = 0; i < classList.length; i += 1) {
      const name = classList[i];
      if (typeof name === "string" && name !== "") names.push(name);
    }
    return names;
  }
  // Foreign elements (e.g. SVG) expose `className` as an object — read the attribute instead.
  const raw = typeof el.getAttribute === "function" ? el.getAttribute("class") : null;
  if (typeof raw !== "string" || raw.trim() === "") return [];
  return raw.split(/\s+/).filter((name) => name !== "");
}

function elementLabel(el: Element): string {
  let text = composedText(el);
  if (text === "" && typeof el.getAttribute === "function") {
    for (const attribute of ["aria-label", "title", "alt", "placeholder"]) {
      const value = el.getAttribute(attribute);
      if (typeof value === "string" && value.trim() !== "") {
        text = normalizeText(value);
        break;
      }
    }
  }
  if (text.length <= LABEL_MAX) return text;
  return `${text.slice(0, LABEL_MAX).trimEnd()}…`;
}

/* -------------------------------------------------------------------------- */
/* anchor derivation                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Derive the anchor of an element: hook, full CSS path, quote and route when available.
 * `route` and `quote` come from the caller (SPA route, current selection) — the module never
 * reads global state on its own (no global side effects).
 */
export function deriveAnchor(
  el: Element,
  options?: AnchorOptions & { route?: string; quote?: string },
): Anchor {
  assertElementLike(el, "deriveAnchor");
  const hooks = normalizeHooks(options?.hooks);
  const composed = composePathSegments(el, hooks);
  const match = hookMatch(el, hooks);

  const anchor: Anchor = {};
  if (match) anchor.hook = match.value;
  anchor.selector = composed.segments.join(SHADOW_BOUNDARY);

  const quote = typeof options?.quote === "string" ? options.quote.trim() : "";
  if (quote !== "") anchor.quote = quote;

  const route = typeof options?.route === "string" ? options.route.trim() : "";
  if (route !== "") anchor.route = route;

  if (composed.degraded !== undefined) anchor.degraded = composed.degraded;
  return anchor;
}

/* -------------------------------------------------------------------------- */
/* resolution                                                                  */
/* -------------------------------------------------------------------------- */

interface PathResolution {
  element: Element | null;
  /** Segment that could not be resolved. */
  failedSegment?: string;
  /** True when the failure was a shadow boundary that cannot be entered (closed root). */
  blockedByShadowBoundary: boolean;
}

function resolvePathDetailed(path: string, root?: ParentNode): PathResolution {
  if (typeof path !== "string") return { element: null, blockedByShadowBoundary: false };
  const segments = path.split(SHADOW_BOUNDARY).map((segment) => segment.trim());
  if (segments.length === 0) return { element: null, blockedByShadowBoundary: false };

  let scope: ParentNode | null = root ?? defaultRoot();
  let element: Element | null = null;

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment === undefined || segment === "") {
      return { element: null, blockedByShadowBoundary: false };
    }
    if (i > 0) {
      // Cross a shadow boundary: only an *open* root can be entered from the host.
      const shadow = element ? shadowRootOf(element) : null;
      if (!shadow) {
        return {
          element: null,
          failedSegment: segment,
          blockedByShadowBoundary: true,
        };
      }
      scope = shadow;
    }
    if (!scope) return { element: null, failedSegment: segment, blockedByShadowBoundary: false };
    const found = querySelectorSafe(scope, segment);
    if (!found) return { element: null, failedSegment: segment, blockedByShadowBoundary: false };
    element = found;
  }
  return { element, blockedByShadowBoundary: false };
}

/**
 * Resolve a stored CSS path segment by segment; returns `null` when it no longer matches.
 * `root` is the scope to search (document by default, or a shadow root / mount container).
 */
export function resolvePath(path: string, root?: ParentNode): Element | null {
  return resolvePathDetailed(path, root).element;
}

/** Find the deepest, leftmost element whose text contains the quote (FR-1.5, FR-2.1). */
export function findQuote(quote: string, root?: ParentNode): Element | null {
  if (typeof quote !== "string") return null;
  const needle = normalizeText(quote);
  if (needle === "") return null;
  const scope = root ?? defaultRoot();
  if (!scope) return null;
  if (isElementLike(scope)) return searchQuote(scope, needle).element;
  for (const child of composedChildElements(scope)) {
    const hit = searchQuote(child, needle).element;
    if (hit) return hit;
  }
  return null;
}

interface QuoteSearch {
  /** Deepest element of this subtree carrying the quote, if any. */
  element: Element | null;
  /** Composed text of the subtree, so it is computed exactly once per element. */
  text: string;
}

function searchQuote(el: Element, needle: string): QuoteSearch {
  const parts: string[] = [];
  let hit: Element | null = null;
  const visit = (container: ParentNode): void => {
    for (const node of container.childNodes) {
      if (node.nodeType === TEXT_NODE) {
        parts.push(textContentOf(node));
        continue;
      }
      if (!isElementLike(node)) continue;
      const found = searchQuote(node, needle);
      parts.push(found.text);
      if (hit === null && found.element !== null) hit = found.element;
    }
  };
  visit(el);
  const shadow = shadowRootOf(el);
  if (shadow) visit(shadow);

  const text = normalizeText(parts.join(" "));
  if (hit !== null) return { element: hit, text };
  return { element: text.includes(needle) ? el : null, text };
}

/** First element carrying the hook value — fast light-DOM query, then a shadow-piercing scan. */
function findByHook(value: string, hooks: readonly string[], root?: ParentNode): Element | null {
  const scope = root ?? defaultRoot();
  if (!scope) return null;

  if (hooks.length > 0) {
    const selector = hooks
      .map((name) => `[${name}="${escapeAttributeValue(value)}"]`)
      .join(",");
    const first = querySelectorAllSafe(scope, selector)[0];
    if (first) return first;
  }

  // `querySelectorAll` does not cross shadow boundaries — hooks inside open roots need a scan.
  if (isElementLike(scope)) {
    const self = hookMatch(scope, hooks);
    if (self && self.value === value) return scope;
  }
  for (const child of composedChildElements(scope)) {
    const hit = scanForHook(child, value, hooks);
    if (hit) return hit;
  }
  return null;
}

function scanForHook(el: Element, value: string, hooks: readonly string[]): Element | null {
  const match = hookMatch(el, hooks);
  if (match && match.value === value) return el;
  for (const child of childElements(el)) {
    const hit = scanForHook(child, value, hooks);
    if (hit) return hit;
  }
  const shadow = shadowRootOf(el);
  if (shadow) {
    for (const child of childElements(shadow)) {
      const hit = scanForHook(child, value, hooks);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Resolve an anchor in the order hook -> selector -> quote (FR-2.1) and return `null` when nothing
 * matches. The caller marks `anchor.orphaned = true` (FR-2.4); a failing shadow boundary is
 * recorded on the anchor as `anchor.degraded` so the degradation stays visible (FR-2.4, §6b).
 */
export function resolveAnchor(anchor: Anchor, options?: AnchorOptions): Element | null {
  if (!anchor || typeof anchor !== "object") return null;
  const hooks = normalizeHooks(options?.hooks);
  const root = options?.root;

  if (typeof anchor.hook === "string" && anchor.hook !== "") {
    const byHook = findByHook(anchor.hook, hooks, root);
    if (byHook) return byHook;
  }

  if (typeof anchor.selector === "string" && anchor.selector !== "") {
    const resolution = resolvePathDetailed(anchor.selector, root);
    if (resolution.element) return resolution.element;
    if (resolution.blockedByShadowBoundary && resolution.failedSegment !== undefined) {
      anchor.degraded = resolution.failedSegment;
    }
  }

  if (typeof anchor.quote === "string" && anchor.quote.trim() !== "") {
    const byQuote = findQuote(anchor.quote, root);
    if (byQuote) return byQuote;
  }

  return null;
}
