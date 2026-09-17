/**
 * Embed vocabulary (FR-17) — the single place where attribute names, `data-*` keys, defaults and
 * the attribute → configuration rules live.
 *
 * The custom element (`src/element/index.ts`) and the loader (`src/embed/attach.ts`) both read
 * this module, so a host learns exactly one vocabulary and a rename breaks exactly one place
 * (single source of truth, FR-15.3). Everything here is pure: no DOM beyond a `getAttribute`-style
 * source, no I/O, so the mapping is unit-testable without a browser.
 *
 * Resolution rules (documented in docs/EMBED.md and asserted in tests/unit/embed.test.ts):
 *   headers merge order: `headers` (static JSON) → `headers-from()` result → `token` (wins).
 *   `token` value: `token-scheme` present → `${scheme} ${token}`, else verbatim.
 *   `headers-from`, `route-from` and `gate` take a dotted path into the host's global scope
 *   (`myApp.flags.reviewNotes`); an unresolvable path is reported, never silently ignored.
 */
import { isEnvironment, type Environment } from "../core/model";
import { resolveKeymap, type KeymapOverrides } from "../ui/keymap";

/** Attributes that existed before FR-17 — kept unchanged for existing hosts. */
export const CORE_ATTRIBUTES = [
  "enabled",
  "adapter",
  "language",
  "identity",
  "session",
  "environment",
  "show-done",
  "theme-accent",
  "theme-surface",
  "mount",
] as const;

/** Attributes added by FR-17: the remote store, tokens, routing and the host gate. */
export const EMBED_ATTRIBUTES = [
  "endpoint",
  "headers",
  "headers-from",
  "token",
  "token-header",
  "token-scheme",
  "theme",
  "route",
  "route-from",
  "gate",
  "anchor-hooks",
  "can-annotate",
  "annotate-selectors",
  "keymap",
  "dock",
] as const;

/** Every attribute the element observes and documents. */
export const ALL_ATTRIBUTES = [...CORE_ATTRIBUTES, ...EMBED_ATTRIBUTES] as const;

/** `data-*` keys understood by the loader that have no element equivalent. */
export const LOADER_KEYS = ["src", "version", "manifest", "integrity", "watch", "tag", "auto"] as const;

export type AttributeName = (typeof ALL_ATTRIBUTES)[number];
export type LoaderKey = (typeof LOADER_KEYS)[number];

/** Anything that can hand out an attribute value (Element, HTMLScriptElement, a test double). */
export interface AttributeSource {
  getAttribute(name: string): string | null;
}

/** A dotted-path lookup into the host's global scope; returns `undefined` when unresolvable. */
export type GlobalResolver = (path: string) => unknown;

/** Minimal view of the object a resolved path has to look like. */
export type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads an attribute and treats an empty string like "not set" (an empty attribute value). */
export function readAttribute(source: AttributeSource, name: string): string | undefined {
  const raw = source.getAttribute(name);
  return raw === null || raw === "" ? undefined : raw;
}

/**
 * Parses a JSON-valued attribute (e.g. `headers='{"X-Workspace":"7"}'`). A malformed value is
 * reported as an issue instead of being ignored — a host that mistypes a token silently losing it
 * is exactly the failure mode this contract exists to prevent.
 */
export function readJsonAttribute(
  source: AttributeSource,
  name: string,
): { value: UnknownRecord | undefined; issue?: string } {
  const raw = readAttribute(source, name);
  if (raw === undefined) {
    return { value: undefined };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { value: undefined, issue: `${name} is not valid JSON (${reason})` };
  }
  if (!isRecord(parsed)) {
    return { value: undefined, issue: `${name} must be a JSON object` };
  }
  return { value: parsed };
}

/** Dotted path into the global scope; an optional `window.`/`globalThis.` prefix is stripped. */
export function resolveGlobalPath(scope: unknown, path: string): unknown {
  const clean = path.trim().replace(/^(?:window|globalThis|self)\./, "");
  if (clean === "") {
    return undefined;
  }
  let current: unknown = scope;
  for (const part of clean.split(".")) {
    if (!isRecord(current) && typeof current !== "function") {
      return undefined;
    }
    current = (current as UnknownRecord)[part];
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

/** Header name → string value pairs, with non-string values dropped and reported. */
function stringEntries(value: UnknownRecord, label: string): { entries: Record<string, string>; issues: string[] } {
  const entries: Record<string, string> = {};
  const issues: string[] = [];
  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (typeof entry === "string") {
      entries[key] = entry;
    } else {
      issues.push(`${label}.${key} must be a string`);
    }
  }
  return { entries, issues };
}

export interface ResolvedHeaders {
  /** Evaluated on every request, so refreshed tokens are picked up (FR-9.1). */
  headers?: () => Record<string, string>;
  issues: string[];
}

/**
 * Builds the per-request header function from `headers`, `headers-from` and `token`.
 * `undefined` means "no headers configured" — the http adapter then sends only `Accept`.
 */
export function readHeaders(source: AttributeSource, resolve: GlobalResolver): ResolvedHeaders {
  const issues: string[] = [];
  const staticHeaders = readJsonAttribute(source, "headers");
  if (staticHeaders.issue !== undefined) issues.push(staticHeaders.issue);
  const base: { entries: Record<string, string>; issues: string[] } =
    staticHeaders.value === undefined
      ? { entries: {}, issues: [] }
      : stringEntries(staticHeaders.value, "headers");

  const headersFromPath = readAttribute(source, "headers-from");
  let dynamic: (() => Record<string, string>) | undefined;
  if (headersFromPath !== undefined) {
    const resolved = resolve(headersFromPath);
    if (typeof resolved === "function") {
      dynamic = () => {
        const produced = (resolved as () => unknown)();
        if (!isRecord(produced)) {
          return {};
        }
        return stringEntries(produced, "headers-from()").entries;
      };
    } else {
      issues.push(`headers-from "${headersFromPath}" does not resolve to a function`);
    }
  }

  const token = readAttribute(source, "token");
  const tokenHeader = readAttribute(source, "token-header") ?? "Authorization";
  const tokenScheme = readAttribute(source, "token-scheme");
  const tokenValue = token === undefined ? undefined : tokenScheme === undefined ? token : `${tokenScheme} ${token}`;

  if (base.issues.length > 0) issues.push(...base.issues);
  if (dynamic === undefined && tokenValue === undefined && Object.keys(base.entries).length === 0) {
    return { issues };
  }

  return {
    headers: () => ({
      ...base.entries,
      ...(dynamic?.() ?? {}),
      ...(tokenValue === undefined ? {} : { [tokenHeader]: tokenValue }),
    }),
    issues,
  };
}

/** Theme tokens from `theme` (JSON) plus the long-standing `theme-accent`/`theme-surface`. */
export function readTheme(source: AttributeSource): { theme: Record<string, string>; issues: string[] } {
  const theme: Record<string, string> = {};
  const issues: string[] = [];
  const json = readJsonAttribute(source, "theme");
  if (json.issue !== undefined) issues.push(json.issue);
  if (json.value !== undefined) {
    const parsed = stringEntries(json.value, "theme");
    Object.assign(theme, parsed.entries);
    issues.push(...parsed.issues);
  }
  const accent = readAttribute(source, "theme-accent");
  const surface = readAttribute(source, "theme-surface");
  if (accent !== undefined) theme.accent = accent;
  if (surface !== undefined) theme.surface = surface;
  return { theme, issues };
}

/** What `identity` may be: the documented shorthands, or a host object with a `getUser()`. */
type IdentityKind = "prompt" | "anonymous" | { getUser?: () => { id?: string; name: string } };

/**
 * `can-annotate="hostApp.canAnnotate"` — the host decides which elements may be annotated (FR-1.10).
 *
 * A generic layer cannot know a host's component vocabulary, so target resolution has to be an
 * extension point instead of a growing selector list. The function is called with the candidate
 * element; `false` rejects it, anything else accepts. Before this, the option existed in the library
 * but a host wiring bluepencil with the tag could not reach it.
 */
export function readCanAnnotate(
  source: AttributeSource,
  resolve: GlobalResolver,
): { canAnnotate?: (element: Element) => boolean; issues: string[] } {
  const issues: string[] = [];
  const path = readAttribute(source, "can-annotate");
  if (path === undefined) {
    return { issues };
  }
  const resolved = resolve(path);
  if (typeof resolved === "function") {
    return {
      canAnnotate: (element: Element) => (resolved as (el: Element) => unknown)(element) !== false,
      issues,
    };
  }
  issues.push(`can-annotate "${path}" does not resolve to a function`);
  return { issues };
}

/**
 * `annotate-selectors=".card, .tile, figure.map"` — the host's own target vocabulary (FR-1.12,
 * issue #3). The nearest match in the click path becomes the annotation target in text *and* design
 * mode, so the anchor is the component and not the text node inside it. A selector the DOM rejects is
 * reported once through `element.issues` instead of failing silently at click time.
 */
export function readAnnotateSelectors(source: AttributeSource): {
  annotateSelectors?: readonly string[];
  issues: string[];
} {
  const issues: string[] = [];
  const raw = readAttribute(source, "annotate-selectors");
  if (raw === undefined) return { issues };

  const selectors: string[] = [];
  for (const candidate of raw.split(",")) {
    const selector = candidate.trim();
    if (selector === "") continue;
    if (!isValidSelector(selector)) {
      issues.push(`annotate-selectors "${selector}" is not a valid CSS selector`);
      continue;
    }
    selectors.push(selector);
  }
  if (selectors.length === 0) return { issues };
  return { annotateSelectors: Object.freeze(selectors), issues };
}

/** Ask the DOM's own parser rather than guessing at a selector's grammar. */
function isValidSelector(selector: string): boolean {
  try {
    document.createDocumentFragment().querySelectorAll(selector);
    return true;
  } catch {
    return false;
  }
}

/**
 * `keymap="bar=g, panel=p"` — remap the layer's shortcuts from markup (FR-12.11).
 *
 * A shortcut is never lost silently: an unknown id, a missing key, a key claimed twice or a key that
 * cannot be remapped (the `1…9` range, the composer-scoped save) is reported through `element.issues`.
 * The legend then shows the effective keys, because it renders from the same registry.
 */
export function readKeymap(source: AttributeSource): { keymap?: KeymapOverrides; issues: string[] } {
  const raw = readAttribute(source, "keymap");
  if (raw === undefined) return { issues: [] };

  const overrides: Record<string, string[]> = {};
  const issues: string[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const separator = trimmed.indexOf("=");
    const id = (separator === -1 ? trimmed : trimmed.slice(0, separator)).trim();
    const key = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
    if (key === "") {
      issues.push(`keymap "${trimmed}" is missing a key (expected shortcut=key)`);
      continue;
    }
    const bucket = overrides[id];
    if (bucket === undefined) overrides[id] = [key];
    else bucket.push(key);
  }
  if (Object.keys(overrides).length === 0) return { issues };
  return { keymap: overrides, issues: [...issues, ...resolveKeymap(overrides).issues] };
}

/**
 * `dock="bottom"` — the edge the strip and its handle dock to (FR-12.13). The mode hint moves to the
 * opposite edge, so a docked layer never collides with itself. Anything but `top`/`bottom` is
 * reported instead of quietly falling back.
 */
export function readDock(source: AttributeSource): { dock?: "top" | "bottom"; issues: string[] } {
  const raw = readAttribute(source, "dock");
  if (raw === undefined) return { issues: [] };
  if (raw === "top" || raw === "bottom") return { dock: raw, issues: [] };
  return { issues: [`dock must be "top" or "bottom" (got ${JSON.stringify(raw)})`] };
}

/**
 * `anchor-hooks="data-testid,id"` — the attribute names `deriveAnchor` may use as the primary anchor.
 *
 * A host whose markup carries stable hooks can anchor on those instead of on a CSS path: a
 * `data-testid` survives refactoring, while `h2.reveal.is-in` (or any class-styled element) does not.
 * Hosts that put test hooks on every interactive element get this for one attribute.
 */
export function readAnchorHooks(source: AttributeSource): { hooks?: string[]; issues: string[] } {
  const issues: string[] = [];
  const raw = readAttribute(source, "anchor-hooks");
  if (raw === undefined) {
    return { issues };
  }
  const hooks = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (hooks.length === 0) {
    issues.push(
      'anchor-hooks is empty — expected a comma-separated list of attribute names (e.g. "data-testid,id")',
    );
    return { issues };
  }
  return { hooks, issues };
}

/**
 * `route="url"` stores the current URL; `route-from` delegates to a host function.
 *
 * The host function is called with the **annotated element** (FR-2.4, contract §2): a host that can
 * answer "which chapter is this element in?" then gets the note's own chapter, not the one that
 * happens to be scrolled into view. Hosts that take no argument are unaffected — an extra argument is
 * ignored by a zero-parameter function.
 */
export function readRoute(
  source: AttributeSource,
  resolve: GlobalResolver,
  location: { pathname: string; search: string } | undefined,
): { getRoute?: (element?: Element) => string; issues: string[] } {
  const issues: string[] = [];
  const path = readAttribute(source, "route-from");
  if (path !== undefined) {
    const resolved = resolve(path);
    if (typeof resolved === "function") {
      return {
        getRoute: (element?: Element) => String((resolved as (el?: Element) => unknown)(element)),
        issues,
      };
    }
    issues.push(`route-from "${path}" does not resolve to a function`);
  }
  const mode = readAttribute(source, "route");
  if (mode === undefined) {
    return { issues };
  }
  if (mode !== "url") {
    issues.push(`route must be "url" (got ${JSON.stringify(mode)})`);
    return { issues };
  }
  if (!location) {
    issues.push('route="url" needs a location (no window in this host)');
    return { issues };
  }
  return { getRoute: () => `${location.pathname}${location.search}`, issues };
}

/**
 * The host gate: `gate` resolves to a function (or a boolean) and is ANDed with
 * `enabled != "false"`, exactly like the documented FR-10.4 admin-debug-mode pattern.
 */
export function readGate(
  source: AttributeSource,
  resolve: GlobalResolver,
): { gate?: () => boolean; issues: string[] } {
  const path = readAttribute(source, "gate");
  if (path === undefined) {
    return { issues: [] };
  }
  const resolved = resolve(path);
  if (typeof resolved === "function") {
    // Re-resolved on every call, so a host that replaces the function (a new feature-flag closure)
    // is picked up on the next `enable()` instead of being frozen at configuration time.
    return {
      gate: () => {
        const current = resolve(path);
        return typeof current === "function" ? (current as () => unknown)() === true : false;
      },
      issues: [],
    };
  }
  if (typeof resolved === "boolean") {
    // A boolean path is documented as legal, so it is honoured — and re-resolved per call, which is
    // what makes a plain flag in the host's global scope a working gate.
    return { gate: () => resolve(path) === true, issues: [] };
  }
  return { issues: [`gate "${path}" does not resolve to a function or a boolean`] };
}

/** `adapter="http"` with an explicit `endpoint`, or just the plain adapter name. */
export function readStore(source: AttributeSource): { endpoint?: string; adapterName?: string } {
  const endpoint = readAttribute(source, "endpoint");
  const adapterName = readAttribute(source, "adapter");
  return {
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(adapterName === undefined ? {} : { adapterName }),
  };
}

/** Environment + session, validated so a typo cannot silently cross the environment boundary. */
export function readEnvironment(
  source: AttributeSource,
  resolve?: GlobalResolver,
): { environment?: Environment; sessionRef?: string; identity?: IdentityKind; showDone?: boolean; issues: string[] } {
  const issues: string[] = [];
  const raw = readAttribute(source, "environment");
  let environment: Environment | undefined;
  if (raw !== undefined) {
    if (isEnvironment(raw)) {
      environment = raw;
    } else {
      issues.push(`environment must be dev, staging or live (got ${JSON.stringify(raw)})`);
    }
  }
  const sessionRef = readAttribute(source, "session");
  const identityRaw = readAttribute(source, "identity");
  let identity: IdentityKind | undefined;
  if (identityRaw === "prompt" || identityRaw === "anonymous") {
    identity = identityRaw;
  } else if (identityRaw !== undefined) {
    // Issue #12: a host that wires bluepencil with the tag cannot pass an object in markup, so a
    // global path is accepted here exactly like for `gate`, `route-from` and `headers-from` — it has
    // to resolve to `{ getUser() }`. The documented shorthand values keep working unchanged.
    const resolved = resolve?.(identityRaw);
    if (isRecord(resolved) && typeof (resolved as { getUser?: unknown }).getUser === "function") {
      identity = resolved as IdentityKind;
    } else {
      issues.push(
        `identity must be "prompt" or "anonymous" (got ${JSON.stringify(identityRaw)}) — or a global path that resolves to { getUser() }`,
      );
    }
  }
  return {
    ...(environment === undefined ? {} : { environment }),
    ...(sessionRef === undefined ? {} : { sessionRef }),
    ...(identity === undefined ? {} : { identity }),
    showDone: readAttribute(source, "show-done") === "true",
    issues,
  };
}

/* -------------------------------------------------------------------------- */
/* loader (`data-*` on the attach script tag)                                  */
/* -------------------------------------------------------------------------- */

export interface LoaderOptions {
  /** `data-*` values forwarded to the element verbatim (kebab-case, no `data-` prefix). */
  attributes: Record<string, string>;
  src?: string;
  version?: string;
  manifest?: string;
  integrity: boolean;
  watchSeconds: number;
  tag: string;
  auto: boolean;
}

/** Reads every attribute of an element, without the `data-` prefix. */
export function collectDataAttributes(source: {
  attributes?: ArrayLike<{ name: string; value: string }>;
  getAttribute(name: string): string | null;
}): Record<string, string> {
  const out: Record<string, string> = {};
  const list = source.attributes;
  if (!list) {
    return out;
  }
  for (let index = 0; index < list.length; index += 1) {
    const attribute = list[index];
    if (!attribute || !attribute.name.startsWith("data-")) continue;
    out[attribute.name.slice(5)] = attribute.value;
  }
  return out;
}

/**
 * Splits the script tag's `data-*` values into loader-only options and element attributes. The
 * element vocabulary is forwarded verbatim, so the loader never has to translate anything.
 */
export function parseLoaderOptions(data: Record<string, string>): LoaderOptions {
  const attributes: Record<string, string> = {};
  for (const name of ALL_ATTRIBUTES) {
    const value = data[name];
    if (value !== undefined && value !== "") {
      attributes[name] = value;
    }
  }
  const watch = data.watch === undefined ? 0 : Number.parseInt(data.watch, 10);
  return {
    attributes,
    ...(data.src === undefined || data.src === "" ? {} : { src: data.src }),
    ...(data.version === undefined || data.version === "" ? {} : { version: data.version }),
    ...(data.manifest === undefined || data.manifest === "" ? {} : { manifest: data.manifest }),
    integrity: data.integrity === "true",
    watchSeconds: Number.isFinite(watch) && watch > 0 ? watch : 0,
    tag: data.tag === undefined || data.tag === "" ? "bluepencil-notes" : data.tag,
    auto: data.auto !== "false",
  };
}
