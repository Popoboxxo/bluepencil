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
 *   headers merge order: `headers` (static JSON) → `headers-from()` result (wins).
 *   credentials are worker-only in 0.12.0 (G6, ADR-0.12-S3): `token`, `token-header` and
 *   `token-scheme` are no longer part of the vocabulary and are never read into a header; a host
 *   that still sets them gets an `issues` entry instead of a silent unauthenticated request.
 *   `headers-from`, `route-from` and `gate` take a dotted path into the host's global scope
 *   (`myApp.flags.reviewNotes`); an unresolvable path is reported, never silently ignored.
 *   route: `url` (the default, also when `route` is absent) stores the pathname only;
 *   `url-with-query` is the explicit opt-in, filtered by `query-allow`/`query-deny`
 *   (G8, ADR-0.12-S5). The policy itself lives in {@link routeFor}, not here.
 */
import { isEnvironment, type Environment } from "../core/model";
import { resolveKeymap, type KeymapOverrides } from "../ui/keymap";
import { CAPTURE_MODES, isCaptureMode, type CaptureMode } from "../ui/modes";

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

/** Attributes added by FR-17: the remote store, routing and the host gate. */
export const EMBED_ATTRIBUTES = [
  "endpoint",
  "headers",
  "headers-from",
  "theme",
  "route",
  "route-from",
  "query-allow",
  "query-deny",
  "gate",
  "anchor-hooks",
  "can-annotate",
  "annotate-selectors",
  "keymap",
  "modes",
  "dock",
  "app",
  "build-ref",
  "exported-by",
] as const;

/** Every attribute the element observes and documents. */
export const ALL_ATTRIBUTES = [...CORE_ATTRIBUTES, ...EMBED_ATTRIBUTES] as const;

/** `data-*` keys understood by the loader that have no element equivalent. */
export const LOADER_KEYS = ["src", "version", "manifest", "integrity", "watch", "tag", "auto"] as const;

export type AttributeName = (typeof ALL_ATTRIBUTES)[number];
export type LoaderKey = (typeof LOADER_KEYS)[number];

/**
 * Anything that can hand out an attribute value (Element, HTMLScriptElement, a test double).
 *
 * The name is `EmbedAttributeSource` (CSR-08). The extension's own `ExtensionAttributeSource`
 * (`Pick<ExtensionSettings, …>`, B.0) is a different type with a different job: it cannot answer
 * `route`/`query-allow`, so the two must not be exchanged for another.
 */
export interface EmbedAttributeSource {
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
export function readAttribute(source: EmbedAttributeSource, name: string): string | undefined {
  const raw = source.getAttribute(name);
  return raw === null || raw === "" ? undefined : raw;
}

/**
 * Parses a JSON-valued attribute (e.g. `headers='{"X-Workspace":"7"}'`). A malformed value is
 * reported as an issue instead of being ignored — a host that mistypes a token silently losing it
 * is exactly the failure mode this contract exists to prevent.
 */
export function readJsonAttribute(
  source: EmbedAttributeSource,
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
 * The credential attributes that 0.12.0 removed from the embed vocabulary (G6, ADR-0.12-S3).
 *
 * They used to build the `Authorization` header in the page. Since the credential lives in the
 * extension's service worker, a page must never receive one — not as an attribute, not as a header.
 */
export const LEGACY_TOKEN_ATTRIBUTES = ["token", "token-header", "token-scheme"] as const;

/**
 * Reports token attributes a host still passes, instead of dropping them without a word.
 *
 * The failure mode this replaces is a silent one: before 0.12.0 a `token` attribute authenticated
 * every request, so a host that keeps it after the upgrade would otherwise send unauthenticated
 * requests with no visible reason. One issue names exactly what was found, points at the worker-only
 * credential and at the options page where the credential is configured now.
 *
 * Detection is by presence, not by value: an empty `token=""` is still a host that believes it
 * configures a credential here.
 */
export function readLegacyTokenAttributes(source: EmbedAttributeSource): { issues: string[] } {
  const found = LEGACY_TOKEN_ATTRIBUTES.filter((name) => source.getAttribute(name) !== null);
  if (found.length === 0) {
    return { issues: [] };
  }
  return {
    issues: [
      "token attributes are no longer supported in 0.12.0 — authenticate through the extension: " +
        `remove ${found.map((name) => `\`${name}\``).join(", ")} because the hub credential is ` +
        "worker-only, stays in the extension's service worker and never reaches the page; " +
        "configure it on the extension options page (docs/EXTENSION.md)",
    ],
  };
}

/**
 * Builds the per-request header function from `headers` and `headers-from`.
 * `undefined` means "no headers configured" — the http adapter then sends only `Accept`.
 *
 * The removed `token*` attributes are not read here (ADR-0.12-S3): a host that still sets them gets
 * an issue and no credential header, never a silent unauthenticated send with no explanation.
 */
export function readHeaders(source: EmbedAttributeSource, resolve: GlobalResolver): ResolvedHeaders {
  const issues: string[] = [];
  issues.push(...readLegacyTokenAttributes(source).issues);
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

  if (base.issues.length > 0) issues.push(...base.issues);
  if (dynamic === undefined && Object.keys(base.entries).length === 0) {
    return { issues };
  }

  return {
    headers: () => ({
      ...base.entries,
      ...(dynamic?.() ?? {}),
    }),
    issues,
  };
}

/** Theme tokens from `theme` (JSON) plus the long-standing `theme-accent`/`theme-surface`. */
export function readTheme(source: EmbedAttributeSource): { theme: Record<string, string>; issues: string[] } {
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
  source: EmbedAttributeSource,
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
export function readAnnotateSelectors(source: EmbedAttributeSource): {
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

/**
 * `app="ReqogniLoom"`, `build-ref="1.8.0-beta.12"`, `exported-by="dduchrow"` — the metadata an
 * exported bundle carries (FR-14.2, issue #21).
 *
 * A bundle is the hand-off artifact between reviewer and agent. Without these attributes a
 * tag-embedded deployment could not name itself, so every export said `app.name: "unknown"` /
 * `exportedBy: "unknown"` and two bundles from two products were indistinguishable.
 *
 * `build-ref` doubles as the host's build identifier for a design note's `context.buildRef`, so a
 * host declares its build once instead of twice.
 */
export function readAppInfo(source: EmbedAttributeSource): {
  app?: { name: string; buildRef?: string };
  exportedBy?: string;
} {
  const name = readAttribute(source, "app");
  const buildRef = readAttribute(source, "build-ref");
  const exportedBy = readAttribute(source, "exported-by");
  return {
    // A build reference without an app name is legal: the name then stays the documented default.
    ...(name === undefined && buildRef === undefined
      ? {}
      : { app: { name: name ?? "unknown", ...(buildRef === undefined ? {} : { buildRef }) } }),
    ...(exportedBy === undefined ? {} : { exportedBy }),
  };
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
export function readKeymap(source: EmbedAttributeSource): { keymap?: KeymapOverrides; issues: string[] } {
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
export function readDock(source: EmbedAttributeSource): { dock?: "top" | "bottom"; issues: string[] } {
  const raw = readAttribute(source, "dock");
  if (raw === undefined) return { issues: [] };
  if (raw === "top" || raw === "bottom") return { dock: raw, issues: [] };
  return { issues: [`dock must be "top" or "bottom" (got ${JSON.stringify(raw)})`] };
}

/**
 * `modes="text,design,bug"` (or `modes="none"`) — the host's capture-mode ceiling (FR-4.10).
 *
 * A host that only supports some kinds of feedback must not offer the rest: a design note on a page
 * that cannot act on design is noise. An absent attribute means "all modes" (the historical
 * behaviour); `"none"` mounts a read-only layer whose list and exports still work.
 *
 * Fail closed: if the attribute contains no recognisable mode at all (a typo, the wrong separator),
 * the result is `"none"`, never "all". A typo must not widen the ceiling the host tried to set;
 * each unknown value is reported through `element.issues` so it is not silently swallowed either.
 */
export function readModes(source: EmbedAttributeSource): {
  modes?: readonly CaptureMode[] | "none";
  issues: string[];
} {
  const raw = readAttribute(source, "modes");
  if (raw === undefined) return { issues: [] };

  const trimmed = raw.trim();
  if (trimmed === "") return { issues: [] };
  if (trimmed === "none") return { modes: "none", issues: [] };

  const issues: string[] = [];
  const valid: CaptureMode[] = [];
  for (const candidate of trimmed.split(",")) {
    const value = candidate.trim();
    if (value === "") continue;
    if (!isCaptureMode(value)) {
      issues.push(`modes "${value}" is not one of ${CAPTURE_MODES.join(", ")}`);
      continue;
    }
    if (!valid.includes(value)) valid.push(value);
  }
  if (valid.length === 0) return { modes: "none", issues };
  return { modes: Object.freeze(valid), issues };
}

/**
 * `anchor-hooks="data-testid,id"` — the attribute names `deriveAnchor` may use as the primary anchor.
 *
 * A host whose markup carries stable hooks can anchor on those instead of on a CSS path: a
 * `data-testid` survives refactoring, while `h2.reveal.is-in` (or any class-styled element) does not.
 * Hosts that put test hooks on every interactive element get this for one attribute.
 */
export function readAnchorHooks(source: EmbedAttributeSource): { hooks?: string[]; issues: string[] } {
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

/* -------------------------------------------------------------------------- */
/* route + query policy (G8, ADR-0.12-S5)                                     */
/* -------------------------------------------------------------------------- */

/** How much of the location a note stores. `url` is the default; the query is explicit opt-in. */
export type RouteMode = "url" | "url-with-query";

/**
 * Query-parameter names that look like credentials. A host that opts into the full query still has
 * to name one of these explicitly in `allow` to keep it — the default is "drop, do not ask".
 *
 * Matching is case-sensitive like every `allow`/`deny` entry. `X-Amz-*` is a prefix entry, so every
 * presigned-URL parameter (`X-Amz-Signature`, `X-Amz-Credential`, …) is covered without listing them
 * one by one.
 */
export const DEFAULT_QUERY_DENY: readonly string[] = Object.freeze([
  "token",
  "code",
  "state",
  "sig",
  "signature",
  "key",
  "password",
  "secret",
  "access_token",
  "id_token",
  "X-Amz-*",
]);

/** The route a note stores plus the allow/deny lists that decide which query parameters survive. */
export interface QueryPolicy {
  mode: RouteMode;
  allow: readonly string[];
  deny: readonly string[];
}

/** Exact match, or a prefix when the entry ends in `*` (case-sensitive, per ADR-0.12-S5). */
function matchesQueryEntry(name: string, entry: string): boolean {
  if (entry === "") return false;
  return entry.endsWith("*") ? name.startsWith(entry.slice(0, -1)) : name === entry;
}

function matchesQueryList(name: string, entries: readonly string[]): boolean {
  return entries.some((entry) => matchesQueryEntry(name, entry));
}

/** A fragment is never part of a stored route, whatever a caller hands in. */
function withoutFragment(value: string): string {
  const index = value.indexOf("#");
  return index === -1 ? value : value.slice(0, index);
}

/**
 * Builds the string a note stores for the current location (FR-2.2, G8, ADR-0.12-S5).
 *
 * - `mode:"url"` stores the path only. The query is dropped whether or not it looks sensitive, so
 *   the default cannot leak a deep-link token (AC-C01).
 * - `mode:"url-with-query"` without allow/deny keeps `pathname + search` verbatim (AC-C02): the
 *   documented full opt-in.
 * - With allow/deny the parameters are filtered (AC-C03). Precedence per parameter name: explicit
 *   `deny` → drop (even when `allow` matches too); explicit `allow` → keep (this also overrides
 *   `DEFAULT_QUERY_DENY`); otherwise a non-empty `allow` is a whitelist, and with an empty `allow`
 *   `DEFAULT_QUERY_DENY` decides.
 *
 * `URLSearchParams` decodes names before matching and re-encodes the survivors, emitting them in
 * the order they appeared in the URL — deterministic output (NFR-17), no locale involved. An empty
 * result is the pathname alone, never a trailing `?`.
 */
export function routeFor(
  location: { pathname: string; search: string },
  policy: QueryPolicy,
): string {
  const pathname = withoutFragment(location.pathname);
  const search = withoutFragment(location.search);

  // An unknown mode (a host typo, a future value) falls back to the secure default: path only.
  if (policy.mode !== "url-with-query") {
    return pathname;
  }
  if (policy.allow.length === 0 && policy.deny.length === 0) {
    return search === "" || search === "?" ? pathname : `${pathname}${search}`;
  }

  const kept = new URLSearchParams();
  for (const [name, value] of new URLSearchParams(search)) {
    if (matchesQueryList(name, policy.deny)) continue;
    const allowed = matchesQueryList(name, policy.allow);
    if (!allowed) {
      if (policy.allow.length > 0) continue;
      if (matchesQueryList(name, DEFAULT_QUERY_DENY)) continue;
    }
    kept.append(name, value);
  }
  const query = kept.toString();
  return query === "" ? pathname : `${pathname}?${query}`;
}

/** Reads a comma-separated `allow`/`deny` list; an empty value means "not configured". */
function readQueryList(source: EmbedAttributeSource, name: "query-allow" | "query-deny"): string[] {
  const raw = readAttribute(source, name);
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * Reads the route configuration of an element (G8, ADR-0.12-S5).
 *
 * - No `route` attribute means the safe default `url` — the note still carries the page's path, so
 *   the deep-link context is kept, but the query is never stored (AC-C04).
 * - `route="url"` is the same path-only mode; `route="url-with-query"` is the explicit opt-in and
 *   is filtered by `query-allow`/`query-deny` (AC-C01…AC-C03).
 * - `route-from` wins and stays host responsibility: it returns the whole string and is never
 *   filtered here.
 *
 * The string itself is built by {@link routeFor}; this function only reads the vocabulary. A value
 * outside the two documented modes is reported as an issue and falls back to `url`, so an unknown
 * value can never opt the host into storing the query.
 *
 * The host function is called with the **annotated element** (FR-2.4, contract §2): a host that can
 * answer "which chapter is this element in?" then gets the note's own chapter, not the one that
 * happens to be scrolled into view. Hosts that take no argument are unaffected — an extra argument is
 * ignored by a zero-parameter function.
 */
export function readRoute(
  source: EmbedAttributeSource,
  resolve: GlobalResolver,
  location: { pathname: string; search: string } | undefined,
  options?: { query?: QueryPolicy },
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
  const raw = readAttribute(source, "route");
  const documented = raw === undefined || raw === "url" || raw === "url-with-query";
  if (!documented) {
    // A typo is reported, and the route falls back to the safe path-only mode instead of losing the
    // page context entirely (the constraint on unknown values: never a silent, never an unsafe one).
    issues.push(`route must be "url" or "url-with-query" (got ${JSON.stringify(raw)})`);
  }
  // Absent `route` is the documented path-only default, not "no route at all".
  const mode: RouteMode = raw === "url-with-query" ? "url-with-query" : "url";
  if (!location) {
    // An explicit `route` that cannot be honoured is reported; the implicit default is simply not
    // available in a host without a location (SSR, a worker) and must not flood `issues`.
    if (raw !== undefined && documented) {
      issues.push(`route="${raw}" needs a location (no window in this host)`);
    }
    return { issues };
  }
  const policy: QueryPolicy = options?.query ?? {
    mode,
    allow: readQueryList(source, "query-allow"),
    deny: readQueryList(source, "query-deny"),
  };
  return { getRoute: () => routeFor(location, policy), issues };
}

/**
 * The host gate: `gate` resolves to a function (or a boolean) and is ANDed with
 * `enabled != "false"`, exactly like the documented FR-10.4 admin-debug-mode pattern.
 */
export function readGate(
  source: EmbedAttributeSource,
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
export function readStore(source: EmbedAttributeSource): { endpoint?: string; adapterName?: string } {
  const endpoint = readAttribute(source, "endpoint");
  const adapterName = readAttribute(source, "adapter");
  return {
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(adapterName === undefined ? {} : { adapterName }),
  };
}

/** Environment + session, validated so a typo cannot silently cross the environment boundary. */
export function readEnvironment(
  source: EmbedAttributeSource,
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
  /**
   * Problems found while reading the tag, e.g. a removed `data-token*` attribute.
   *
   * The credential itself is never forwarded to the element (ADR-0.12-S3) — that would put the
   * secret back into the page's DOM; the diagnostic travels with the loader options so the drop is
   * not silent. Omitted when the tag is clean.
   */
  issues?: string[];
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
 *
 * Removed credential keys (`data-token`, `data-token-header`, `data-token-scheme`) are **not**
 * forwarded — that would put the secret back into the page's DOM — but they are reported through
 * `issues` so the drop is never silent (ADR-0.12-S3).
 */
export function parseLoaderOptions(data: Record<string, string>): LoaderOptions {
  const attributes: Record<string, string> = {};
  for (const name of ALL_ATTRIBUTES) {
    const value = data[name];
    if (value !== undefined && value !== "") {
      attributes[name] = value;
    }
  }
  const legacy = readLegacyTokenAttributes({ getAttribute: (name) => data[name] ?? null }).issues;
  const watch = data.watch === undefined ? 0 : Number.parseInt(data.watch, 10);
  return {
    attributes,
    ...(legacy.length === 0 ? {} : { issues: legacy }),
    ...(data.src === undefined || data.src === "" ? {} : { src: data.src }),
    ...(data.version === undefined || data.version === "" ? {} : { version: data.version }),
    ...(data.manifest === undefined || data.manifest === "" ? {} : { manifest: data.manifest }),
    integrity: data.integrity === "true",
    watchSeconds: Number.isFinite(watch) && watch > 0 ? watch : 0,
    tag: data.tag === undefined || data.tag === "" ? "bluepencil-notes" : data.tag,
    auto: data.auto !== "false",
  };
}
