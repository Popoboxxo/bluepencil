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
 * behind a *closed* shadow root cannot be resolved and is reported as the resolution's `degraded`
 * segment — the note keeps hook/quote and is flagged instead of failing silently (FR-2.4, §6b).
 *
 * Resolution is non-mutating: `resolveAnchor`/`resolveAnchorDetailed` never write to the caller's
 * anchor object (the layer keeps notes alive across renders, so a hidden side effect would leak
 * into data the host owns). The degradation of a failed boundary is returned, not stored.
 *
 * Input handling contract:
 *  - `deriveAnchor` throws `BluepencilValidationError` for anything that is not an element-like
 *    object (a note must not be built from an invalid anchor, FR-2.3);
 *  - `hookValue`/`resolveAnchor`/`resolvePath`/`findQuote` never throw — they return
 *    `undefined`/`null` so a broken anchor can only ever produce an *orphaned* note;
 *  - `cssPath`/`composePath`/`describeElement` are formatting helpers and return `""` for invalid
 *    input, so a list render loop can never break on a half-built node.
 */

import {
  BluepencilValidationError,
  type Anchor,
  type RevealContainer,
  type RevealHint,
} from "./model";

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

  // Issue #20: remember how to bring a target inside a closed dialog/popover/tab back, so that a
  // later jump can reveal the container instead of reporting a note as unreachable.
  const reveal = captureReveal(el, options);
  if (reveal !== undefined) anchor.reveal = reveal;
  return anchor;
}

/* -------------------------------------------------------------------------- */
/* transient containers (issue #20)                                            */
/* -------------------------------------------------------------------------- */

/**
 * `data-*` attribute a host can set on its own container to name the trigger explicitly, e.g.
 * `data-bluepencil-reveal="notification-bell"` (a hook value) or
 * `data-bluepencil-reveal="[data-testid=\"bell\"]"` (a selector). Checked before the generic
 * lookups, so a host whose markup does not follow the ARIA conventions can still be revealed.
 */
const REVEAL_ATTRIBUTE = "data-bluepencil-reveal";

/** Attribute value of `el`, trimmed; `undefined` for missing/empty/Non-string values. */
function attributeOf(el: Element, name: string): string | undefined {
  const read = (el as { getAttribute?: (attribute: string) => string | null }).getAttribute;
  if (typeof read !== "function") return undefined;
  const value = read.call(el, name);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function hasAttributeOf(el: Element, name: string): boolean {
  const has = (el as { hasAttribute?: (attribute: string) => boolean }).hasAttribute;
  if (typeof has === "function") {
    try {
      return has.call(el, name) === true;
    } catch {
      return false;
    }
  }
  return attributeOf(el, name) !== undefined;
}

/** Parent element, or the shadow host when the element is the first child of an open root. */
function parentOrHost(el: Element): Element | null {
  const parent = (el as { parentElement?: Element | null }).parentElement ?? null;
  if (parent) return parent;
  const root = scopeRootOf(el);
  return isShadowRootNode(root) ? root.host : null;
}

/** Element with `id` in the element's own document (for `aria-labelledby`/`aria-controls`). */
function elementById(el: Element, id: string): Element | null {
  const doc = (el as { ownerDocument?: Document | null }).ownerDocument;
  if (!doc || typeof doc.getElementById !== "function") return null;
  try {
    return doc.getElementById(id) ?? null;
  } catch {
    return null;
  }
}

/**
 * Kind of transient container `el` is, or `undefined` for ordinary page content. Markers follow the
 * platform vocabulary (native `dialog`/`popover`, ARIA roles), so a host does not have to learn a
 * bluepencil-specific convention to be supported.
 */
export function containerKind(el: Element): RevealContainer | undefined {
  if (!isElementLike(el)) return undefined;
  const role = (attributeOf(el, "role") ?? "").toLowerCase();
  if (selectorTag(el) === "dialog" || role === "dialog" || attributeOf(el, "aria-modal") === "true") {
    return "dialog";
  }
  if (role === "tabpanel") return "tabpanel";
  if (role === "menu" || role === "menubar" || role === "listbox") return "menu";
  if (role === "tooltip" || hasAttributeOf(el, "popover")) return "popover";
  return undefined;
}

/** Nearest ancestor of `el` (crossing open shadow roots) that is a transient container. */
function nearestContainer(el: Element): { container: Element; kind: RevealContainer } | undefined {
  let node = parentOrHost(el);
  while (node) {
    const kind = containerKind(node);
    if (kind) return { container: node, kind };
    node = parentOrHost(node);
  }
  return undefined;
}

/** Human-readable name of a container: its `aria-label`, else "". */
function containerLabel(container: Element): string {
  return attributeOf(container, "aria-label") ?? "";
}

/**
 * The element that brings `container` back, in order of reliability: the host's explicit
 * `data-bluepencil-reveal`, the native popover target, the tab of a tab panel, then any element
 * declaring `aria-controls` for it. Returns `null` when the markup offers no way in — the hint then
 * still names the container so a human can open it.
 */
function findRevealTrigger(
  container: Element,
  kind: RevealContainer,
  hooks: readonly string[],
  root: ParentNode | undefined,
): Element | null {
  const scope: ParentNode | undefined = root ?? defaultRoot() ?? undefined;
  const query = (selector: string): Element | null =>
    scope === undefined ? null : querySelectorSafe(scope, selector);

  const explicit = attributeOf(container, REVEAL_ATTRIBUTE);
  if (explicit) {
    const byHook = findByHook(explicit, hooks, scope);
    if (byHook) return byHook;
    const bySelector = query(explicit);
    if (bySelector) return bySelector;
  }

  const id = attributeOf(container, "id");
  if (id) {
    const byPopoverTarget = query(`[popovertarget="${escapeAttributeValue(id)}"]`);
    if (byPopoverTarget) return byPopoverTarget;
  }

  if (kind === "tabpanel") {
    const labelledBy = attributeOf(container, "aria-labelledby");
    if (labelledBy) {
      const tab = elementById(container, labelledBy);
      if (tab) return tab;
    }
    if (id) {
      const byControls = query(`[role="tab"][aria-controls="${escapeAttributeValue(id)}"]`);
      if (byControls) return byControls;
    }
    // Last resort for a tab panel: the tab that is currently selected in its tab list.
    const list = querySelectorSafe(parentOrHost(container) ?? container, '[role="tablist"]');
    const selected = list ? querySelectorSafe(list, '[role="tab"][aria-selected="true"]') : null;
    if (selected) return selected;
  }

  if (id) {
    const byControls = query(`[aria-controls="${escapeAttributeValue(id)}"]`);
    if (byControls) return byControls;
  }
  return null;
}

/**
 * Capture how to bring the annotated element back when it only exists in a transient UI state
 * (issue #20). Returns `undefined` for ordinary page content, so an anchor of an element that is
 * always visible stays byte-identical to the version without this feature.
 */
export function captureReveal(el: Element, options?: AnchorOptions): RevealHint | undefined {
  if (!isElementLike(el)) return undefined;
  const hooks = normalizeHooks(options?.hooks);
  const found = nearestContainer(el);
  if (!found) return undefined;

  const root = options?.root ?? defaultRoot() ?? undefined;
  const trigger = findRevealTrigger(found.container, found.kind, hooks, root);
  const hint: RevealHint = { container: found.kind };

  if (trigger) {
    const match = hookMatch(trigger, hooks);
    if (match) hint.triggerHook = match.value;
    const path = composePathSegments(trigger, hooks).segments.join(SHADOW_BOUNDARY);
    if (path !== "") hint.triggerSelector = path;
    const label = elementLabel(trigger);
    if (label !== "") hint.triggerLabel = label;
    return hint;
  }

  const label = containerLabel(found.container);
  if (label !== "") hint.triggerLabel = label;
  return hint;
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

/** Which fallback of the documented order (hook -> selector -> quote) resolved the anchor. */
export type AnchorStrategy = "hook" | "selector" | "quote";

/** Result of one resolution: the element plus the degradation of an unreachable shadow boundary. */
export interface AnchorResolution {
  element: Element | null;
  /** Path segment behind a closed shadow root — the caller flags the note (FR-2.4, §6b). */
  degraded?: string;
  /**
   * Fallback that matched, absent when nothing matched. Lets a host measure anchor health (how many
   * notes still resolve through their hook, how many only through the quote fallback).
   */
  strategy?: AnchorStrategy;
}

/**
 * Resolve an anchor in the order hook -> selector -> quote (FR-2.1) and report the failure of an
 * unreachable shadow boundary next to the element (FR-2.4, §6b).
 *
 * Non-mutating: the caller's anchor object is never written to, so a note kept alive by the layer
 * cannot change behind its owner's back. Marking `anchor.orphaned = true` stays the caller's job.
 */
export function resolveAnchorDetailed(anchor: Anchor, options?: AnchorOptions): AnchorResolution {
  if (!anchor || typeof anchor !== "object") return { element: null };
  const hooks = normalizeHooks(options?.hooks);
  const root = options?.root;
  let degraded: string | undefined;

  if (typeof anchor.hook === "string" && anchor.hook !== "") {
    const byHook = findByHook(anchor.hook, hooks, root);
    if (byHook) return { element: byHook, strategy: "hook" };
  }

  if (typeof anchor.selector === "string" && anchor.selector !== "") {
    const resolution = resolvePathDetailed(anchor.selector, root);
    if (resolution.element) return { element: resolution.element, strategy: "selector" };
    if (resolution.blockedByShadowBoundary && resolution.failedSegment !== undefined) {
      degraded = resolution.failedSegment;
    }
  }

  if (typeof anchor.quote === "string" && anchor.quote.trim() !== "") {
    const byQuote = findQuote(anchor.quote, root);
    if (byQuote) {
      return { element: byQuote, strategy: "quote", ...(degraded === undefined ? {} : { degraded }) };
    }
  }

  return { element: null, ...(degraded === undefined ? {} : { degraded }) };
}

/**
 * `resolveAnchorDetailed(anchor, options).element` — the documented one-liner of FR-2.1.
 * An unresolvable anchor is only ever reported as `null`; the degradation of a closed shadow
 * boundary is available through `resolveAnchorDetailed` (§6b) and is never written to the anchor.
 */
export function resolveAnchor(anchor: Anchor, options?: AnchorOptions): Element | null {
  return resolveAnchorDetailed(anchor, options).element;
}

/* -------------------------------------------------------------------------- */
/* revealing a transient container (issue #20)                                 */
/* -------------------------------------------------------------------------- */

/** Options of `revealAnchorDetailed`: how long the host may take to render after a click. */
export interface RevealOptions extends AnchorOptions {
  /** Upper bound of one settle window in ms (default 400). */
  settleMs?: number;
  /** Poll interval inside a settle window in ms (default 25). */
  stepMs?: number;
}

/** Result of a reveal attempt: the ordinary resolution plus what had to be done for it. */
export interface RevealResolution extends AnchorResolution {
  /** `true` when a trigger was activated; `false` when the anchor resolved on its own (or has no hint). */
  revealed: boolean;
  /** The trigger that was activated, when the hint pointed at one that exists right now. */
  trigger?: Element;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms > 0 ? ms : 0);
  });
}

/**
 * Activate a trigger the way a user would. A platform `click()` produces exactly the event a real
 * interaction produces and is understood by every framework's event delegation; a constructed
 * `MouseEvent` is only the fallback for nodes without `click()`.
 *
 * `view` is deliberately *not* part of the init: engines validate it against their own realm's
 * `Window` type and refuse the event otherwise ("member view is not of type Window"), which would
 * turn a working reveal into a silent no-op.
 */
function activateTrigger(el: Element): boolean {
  const click = (el as { click?: () => void }).click;
  if (typeof click === "function") {
    try {
      click.call(el);
      return true;
    } catch {
      /* fall through to the constructed event */
    }
  }
  const doc = (el as { ownerDocument?: Document | null }).ownerDocument;
  const view = doc ? (doc as { defaultView?: Window | null }).defaultView : null;
  const Ctor = (view as { MouseEvent?: typeof MouseEvent } | null)?.MouseEvent;
  if (typeof Ctor !== "function") return false;
  try {
    el.dispatchEvent(new Ctor("click", { bubbles: true, cancelable: true }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve an anchor whose target only exists inside a transient container by entering the container
 * first (issue #20): activate the stored trigger, wait for the host's DOM to settle, resolve again.
 *
 * Two attempts, because the first click can *close* a container that happened to be open while the
 * target was still unreachable for another reason — a toggle would otherwise walk into the opposite
 * direction.
 *
 * The anchor is never mutated and no resolution is invented: when the target still cannot be found
 * the result stays `element: null` and the caller keeps the note flagged as orphaned. The difference
 * is that the layer now tried the one thing a human would try before giving up.
 */
export async function revealAnchorDetailed(
  anchor: Anchor,
  options?: RevealOptions,
): Promise<RevealResolution> {
  const direct = resolveAnchorDetailed(anchor, options);
  if (direct.element) return { ...direct, revealed: false };

  const hint = anchor && typeof anchor === "object" ? anchor.reveal : undefined;
  if (!hint) return { ...direct, revealed: false };

  const hooks = normalizeHooks(options?.hooks);
  const root = options?.root;
  const trigger =
    hint.triggerHook !== undefined
      ? findByHook(hint.triggerHook, hooks, root)
      : hint.triggerSelector !== undefined
        ? resolvePath(hint.triggerSelector, root)
        : null;
  if (!trigger) return { ...direct, revealed: false };

  const settleMs = options?.settleMs ?? 400;
  const stepMs = options?.stepMs ?? 25;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!activateTrigger(trigger)) return { ...direct, revealed: false };
    const deadline = Date.now() + settleMs;
    for (;;) {
      const after = resolveAnchorDetailed(anchor, options);
      if (after.element) return { ...after, revealed: true, trigger };
      if (Date.now() >= deadline) break;
      await sleep(stepMs);
    }
  }
  return { ...direct, revealed: true, trigger };
}

/** `revealAnchorDetailed(anchor, options).element` — the one-liner for a jump handler. */
export async function revealAnchor(anchor: Anchor, options?: RevealOptions): Promise<Element | null> {
  const result = await revealAnchorDetailed(anchor, options);
  return result.element;
}
