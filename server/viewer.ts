/**
 * The hub's **viewer** door: serve a website from this origin with the layer injected, and hand out
 * the bookmarklet for the pages a proxy cannot carry.
 *
 * Why it exists (issue #140): reviewing a page needs the layer on that page. Until now that meant a
 * browser extension or a host that embeds the layer itself. The viewer closes that gap for the
 * operator: the hub fetches the page, injects the layer and serves it **under its own origin**, so
 * the layer's store calls are same-origin — no CORS, no preflight, no credential in the page.
 *
 * Design, and why it sits where it does:
 *
 * - **Off unless configured.** `--viewer` without `--viewer-assets` is a startup error, and without
 *   `--admin-secret` there is no operator credential to gate it, so `parseHubArgs` refuses the
 *   combination. No flag, no routes: `viewerGate` answers `none` and the router's ordinary 404
 *   stands. A surface that can be forgotten into existence is the wrong default.
 * - **Asynchronous, therefore outside the pure router.** Fetching another site is I/O; the router
 *   (`handleRequest`) is deliberately synchronous and body-dependent. The viewer is a door like the
 *   MCP one: the glue asks `isViewerRequest` and awaits `handleViewer`.
 * - **Its own session, not the shared secret.** The operator exchanges the admin secret for a
 *   short-lived session token (`GET {base}/viewer?k=…`), which travels as an HttpOnly cookie for
 *   the proxied page and as a header for the bookmarklet. The secret itself never enters a page: a
 *   page served by the viewer can read anything the layer can, and a leaked *session* dies.
 * - **Everything injected is absolute.** The injected `<base href>` re-points relative URLs at the
 *   target site — including the layer's own `endpoint` (measured: a relative endpoint POSTs to the
 *   target and fails with "Failed to fetch"). Both the element endpoint and the module script URL
 *   are absolute for that reason.
 * - **The target's CSP is removed, not negotiated.** A page that ships `script-src 'self'` would
 *   block the loader and a `connect-src` without this origin would block the writes. Header policies
 *   are dropped by not copying them; `<meta http-equiv>` policies are stripped here (measured need).
 * - **Allowlist, not a URL parameter.** The hub fetches server-side, so an open parameter is SSRF:
 *   `--viewer-allow` names the hosts that may be fetched, checked again on **every** redirect hop.
 * - **No framework, no client dependency** — same reasoning as `server/admin-html.ts`: the runtime
 *   image ships `dist/server.js` and nothing else.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";

import type { HandlerContext, ServerRequest, ServerResponse } from "./handler";
import { bookmarkletSnippet, bookmarkletTextArtifact } from "./viewer-bookmarklet";
import { renderViewerHtml } from "./viewer-html";

/** The length of a viewer session token in bytes (hex-doubled on the wire). */
const SESSION_BYTES = 24;

/** Default lifetime of a viewer session: eight hours, capped at seven days. */
export const DEFAULT_VIEWER_TTL_SECONDS = 8 * 60 * 60;
export const MAX_VIEWER_TTL_SECONDS = 7 * 24 * 60 * 60;

/** How long the hub waits for a target site before giving up on it. */
export const VIEWER_FETCH_TIMEOUT_MS = 8000;

/** The largest target document the viewer will buffer. Anything bigger is refused, not truncated. */
export const VIEWER_MAX_BYTES = 5 * 1024 * 1024;

/** Redirect hops followed, each one re-checked against the allowlist. */
export const VIEWER_MAX_REDIRECTS = 3;

/** The element bundles the viewer may serve from `--viewer-assets` (basenames, never paths). */
export const VIEWER_ASSET_FILES = ["bluepencil.element.min.js", "bluepencil.element.js"] as const;

/** The cookie the proxied page carries; HttpOnly, so target JavaScript cannot read the token. */
export const VIEWER_COOKIE = "bp_viewer";

/** The header the bookmarklet carries, for pages served by another origin. */
export const VIEWER_HEADER = "x-bluepencil-viewer";

/** What the hub needs to run the viewer; absent means the door does not exist. */
export interface ViewerOptions {
  /** Directory holding the built layer bundles (`dist/`). */
  assetsDir: string;
  /** Hosts the viewer may fetch: `example.com` or `*.example.com`. */
  allow: readonly string[];
  /** Session lifetime in seconds. */
  ttlSeconds: number;
  /** Public origin, when it differs from the request's `Host` (reverse proxy, TLS terminator). */
  publicBaseUrl?: string;
  /** Live sessions, in memory — a restart ends every viewer session. */
  sessions: ViewerSessions;
}

/** Sessions are a plain in-memory map: no persistence, so a restart is also a revocation. */
export interface ViewerSessions {
  mint(): { token: string; expiresAt: number };
  verify(token: string | undefined): boolean;
  /** Number of live sessions — the admin status line reports it. */
  size(): number;
}

/** A session store shared by every request of one hub process. */
export function createViewerSessions(ttlSeconds: number): ViewerSessions {
  const live = new Map<string, number>();
  const prune = (now: number): void => {
    for (const [token, expiresAt] of live) {
      if (expiresAt <= now) live.delete(token);
    }
  };
  return {
    mint() {
      const now = Date.now();
      prune(now);
      const token = randomBytes(SESSION_BYTES).toString("hex");
      const expiresAt = now + ttlSeconds * 1000;
      live.set(token, expiresAt);
      return { token, expiresAt };
    },
    verify(token) {
      if (token === undefined || token.length === 0) return false;
      const now = Date.now();
      const expiresAt = live.get(token);
      if (expiresAt === undefined) return false;
      if (expiresAt <= now) {
        live.delete(token);
        return false;
      }
      return true;
    },
    size() {
      prune(Date.now());
      return live.size;
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * Allowlist (SSRF guard)
 * ---------------------------------------------------------------------------------------------- */

/**
 * True when `host` matches one of the configured entries.
 *
 * Exact, case-insensitive match, or `*.suffix` for a whole zone. Deliberately no implicit wildcard
 * and no "any host" shorthand: the list is the security boundary, so it has to be readable in a
 * process listing without decoding.
 */
export function hostAllowed(host: string, allow: readonly string[]): boolean {
  const candidate = host.trim().toLowerCase();
  if (candidate.length === 0) return false;
  // A port in the *candidate* is not a reason to refuse an allowlist entry that names a bare host:
  // `example.com` has to cover `example.com:8443`, or every non-default port would need its own line.
  // The reverse is strict — an entry that names a port means exactly that port.
  const candidateHasPort = /:\d+$/.test(candidate);
  const candidateHost = candidateHasPort ? candidate.replace(/:\d+$/, "") : candidate;
  for (const raw of allow) {
    const pattern = raw.trim().toLowerCase();
    if (pattern.length === 0) continue;
    const patternHasPort = /:\d+$/.test(pattern);
    const patternHost = patternHasPort ? pattern.replace(/:\d+$/, "") : pattern;
    if (patternHasPort && pattern !== candidate) continue;
    if (patternHost.startsWith("*.")) {
      const suffix = patternHost.slice(1); // ".example.com"
      if (candidateHost.endsWith(suffix) && candidateHost.length > suffix.length) return true;
      continue;
    }
    if (candidateHost === patternHost) return true;
  }
  return false;
}

/** Why a target may not be fetched, or `null` when it may be. */
export function targetRefusal(raw: string, allow: readonly string[]): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "the url is not an absolute URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "only http and https targets can be viewed";
  }
  if (url.username !== "" || url.password !== "") {
    return "a target URL must not carry credentials";
  }
  if (!hostAllowed(url.host, allow)) {
    return `the host ${url.host} is not in --viewer-allow`;
  }
  return null;
}

/* ------------------------------------------------------------------------------------------------
 * Injection (pure — the measured contract of issue #140)
 * ---------------------------------------------------------------------------------------------- */

export interface ViewDocumentInput {
  /** The target document as fetched. */
  html: string;
  /** Absolute base of the target site, e.g. `https://example.com/`. */
  baseHref: string;
  /** Absolute endpoint of this hub's notes API, e.g. `http://hub:8787/bluepencil/api`. */
  endpoint: string;
  /** Absolute URL of the element bundle. */
  elementSrc: string;
  /** Environment the layer writes into (`dev|staging|live`). */
  environment: string;
  /** UI language of the layer. */
  language?: string;
}

/** A `<meta http-equiv="content-security-policy">` element, whatever the quoting style. */
const META_CSP = /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi;
/** The same, when the attribute order is reversed (`content="…" http-equiv="…"`). */
const META_CSP_REVERSED = /<meta\b[^>]*content\s*=\s*["'][^"']*content-security-policy[^"']*["'][^>]*>/gi;

/** One line, no quotes-in-quotes breakage: the attribute payload is JSON, the tag is hand-built. */
function attribute(value: string): string {
  return `"${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;
}

/**
 * Inserts `<base>`, the element and the loader into a fetched document.
 *
 * Three properties are load-bearing and each is a measured failure mode:
 * 1. the CSP `<meta>` policies are **removed** (a page-served policy blocks the loader and the writes);
 * 2. `<base href>` is inserted so relative assets keep resolving against the target, not the hub;
 * 3. the element `endpoint` and the script `src` are **absolute** — with a `<base>` in the document a
 *    relative endpoint would resolve against the target site and every write would 404.
 */
export function buildViewDocument(input: ViewDocumentInput): string {
  const withoutCsp = input.html.replace(META_CSP, "").replace(META_CSP_REVERSED, "");
  const injection = [
    `<base href=${attribute(input.baseHref)}>`,
    `<bluepencil-notes endpoint=${attribute(input.endpoint)} environment=${attribute(input.environment)}` +
      `${input.language === undefined ? "" : ` language=${attribute(input.language)}`} enabled="true"></bluepencil-notes>`,
    `<script type="module" src=${attribute(input.elementSrc)}></script>`,
  ].join("\n");

  const headOpen = /<head\b[^>]*>/i;
  if (headOpen.test(withoutCsp)) {
    return withoutCsp.replace(headOpen, (match) => `${match}\n${injection}`);
  }
  // No `<head>` at all: the document is still served, the injection goes in front so the parser sees
  // `<base>` before any relative URL in the body.
  return `${injection}\n${withoutCsp}`;
}

/* ------------------------------------------------------------------------------------------------
 * Gate and handler
 * ---------------------------------------------------------------------------------------------- */

/** What the gate found: not ours, served now, or the path the handler should take. */
export type ViewerGateResult =
  | { kind: "none" }
  | { kind: "response"; response: ServerResponse }
  | { kind: "handler" };

/** The paths the viewer owns, relative to the API base. */
function viewerPaths(base: string): { page: string; view: string; bookmarklet: string; assets: string } {
  const trimmed = base.replace(/\/+$/, "");
  return {
    page: `${trimmed}/viewer`,
    view: `${trimmed}/view`,
    bookmarklet: `${trimmed}/viewer/bookmarklet.txt`,
    assets: `${trimmed}/viewer/assets`,
  };
}

function requestPath(url: string): string {
  const question = url.indexOf("?");
  return (question < 0 ? url : url.slice(0, question)).replace(/\/+$/, "");
}

/** True when this URL belongs to the viewer — the glue asks this before any body is read. */
export function isViewerRequest(url: string, context: HandlerContext): boolean {
  if (context.viewer === undefined) return false;
  const path = requestPath(url);
  const paths = viewerPaths(context.base);
  return path === paths.page || path === paths.view || path === paths.bookmarklet ||
    path.startsWith(`${paths.assets}/`);
}

/** The viewer's own credential: the HttpOnly cookie, or the bookmarklet's header. */
export function viewerAuthorized(request: ServerRequest, context: HandlerContext): boolean {
  const viewer = context.viewer;
  if (viewer === undefined) return false;
  const header = headerValue(request, VIEWER_HEADER);
  if (viewer.sessions.verify(header)) return true;
  return viewer.sessions.verify(cookieValue(request, VIEWER_COOKIE));
}

function headerValue(request: ServerRequest, name: string): string | undefined {
  const raw = request.headers?.[name] ?? request.headers?.[name.toLowerCase()];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw[0];
  return undefined;
}

function cookieValue(request: ServerRequest, name: string): string | undefined {
  const raw = headerValue(request, "cookie");
  if (raw === undefined) return undefined;
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

/** The `Set-Cookie` value for a freshly minted session. */
export function sessionCookie(token: string, ttlSeconds: number, base: string): string {
  const path = base.replace(/\/+$/, "") || "/";
  return `${VIEWER_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${ttlSeconds}`;
}

function json(status: number, payload: unknown): ServerResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify(payload),
  };
}

function text(status: number, body: string, contentType = "text/plain; charset=utf-8"): ServerResponse {
  return { status, headers: { "content-type": contentType, "cache-control": "no-store" }, body };
}

function refusal(status: number, code: string, message: string): ServerResponse {
  return json(status, { error: { code, message } });
}

/** The base URL a page or the layer should address: the request's own origin unless overridden. */
export function publicOrigin(request: ServerRequest, viewer: ViewerOptions): string {
  if (viewer.publicBaseUrl !== undefined) return viewer.publicBaseUrl.replace(/\/+$/, "");
  const host = headerValue(request, "host") ?? "127.0.0.1";
  const forwarded = headerValue(request, "x-forwarded-proto");
  const proto = forwarded === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

/** Why a target's response cannot be shown, or `null` when it can. */
function contentTypeRefusal(contentType: string | null): string | null {
  if (contentType === null) return null;
  const plain = contentType.toLowerCase();
  if (plain.includes("text/html") || plain.includes("application/xhtml+xml")) return null;
  return `the target answered with ${plain.split(";")[0]}, not HTML`;
}

/**
 * Answers a viewer request, or `null` when the request is not one.
 *
 * Async because the proxy fetches; every early answer is a documented JSON refusal so a caller can
 * tell "not configured" (404) from "no session" (401) from "not allowed" (403).
 */
export async function handleViewer(
  request: ServerRequest,
  context: HandlerContext,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<ServerResponse | null> {
  const viewer = context.viewer;
  if (viewer === undefined) return null;
  const method = (request.method ?? "GET").toUpperCase();
  const url = new URL(request.url ?? "/", "http://hub.invalid");
  const path = requestPath(url.pathname);
  const paths = viewerPaths(context.base);

  if (method !== "GET") {
    return { ...refusal(405, "method_not_allowed", `${method} is not allowed on ${path}`), headers: { "content-type": "application/json; charset=utf-8", allow: "GET" } };
  }

  // The exchange: the operator's admin secret becomes a session cookie. Deliberately the only way
  // in — a viewer reachable by URL alone would be a viewer any page could hand out.
  if (path === paths.page && url.searchParams.has("k")) {
    const presented = url.searchParams.get("k") ?? "";
    const expected = context.adminSecret ?? "";
    if (expected.length === 0 || !secretsEqual(expected, presented)) {
      return refusal(401, "unauthorized", "the viewer needs the admin secret (--admin-secret) as ?k=");
    }
    const session = viewer.sessions.mint();
    return {
      status: 302,
      headers: {
        location: context.base.replace(/\/+$/, "") + "/viewer",
        "set-cookie": sessionCookie(session.token, viewer.ttlSeconds, context.base),
        "cache-control": "no-store",
      },
      body: "",
    };
  }

  if (!viewerAuthorized(request, context)) {
    return refusal(401, "unauthorized", "the viewer needs a session — open {base}/viewer?k=<admin-secret>");
  }

  if (path === paths.page) {
    const origin = publicOrigin(request, viewer);
    const base = context.base.replace(/\/+$/, "");
    return {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-frame-options": "SAMEORIGIN",
      },
      body: renderViewerHtml({
        base,
        origin,
        allow: viewer.allow,
        environment: context.environment,
        bookmarklet: bookmarkletSnippet({
          origin,
          base,
          environment: context.environment,
          token: headerValue(request, VIEWER_HEADER),
        }),
      }),
    };
  }

  if (path === paths.bookmarklet) {
    return text(200, bookmarkletTextArtifact({
      origin: publicOrigin(request, viewer),
      base: context.base.replace(/\/+$/, ""),
      environment: context.environment,
    }));
  }

  if (path.startsWith(`${paths.assets}/`)) {
    const name = basename(path.slice(paths.assets.length + 1));
    if (!(VIEWER_ASSET_FILES as readonly string[]).includes(name)) {
      return refusal(404, "not_found", `unknown viewer asset ${name}`);
    }
    try {
      const body = readFileSync(join(viewer.assetsDir, name), "utf8");
      return {
        status: 200,
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          // The bookmarklet loads this file from a foreign page: a module script is fetched with
          // CORS, so the asset route has to answer the preflight-free cross-origin case.
          "access-control-allow-origin": "*",
          "cache-control": "no-cache",
        },
        body,
      };
    } catch {
      return refusal(404, "not_found", `${name} is not in --viewer-assets`);
    }
  }

  if (path === paths.view) {
    return proxyTarget(url, request, context, viewer, deps);
  }

  return refusal(404, "not_found", `unknown viewer route ${path}`);
}

/** Fetches the target (following checked redirects) and returns it with the layer injected. */
async function proxyTarget(
  requestUrl: URL,
  request: ServerRequest,
  context: HandlerContext,
  viewer: ViewerOptions,
  deps: { fetchImpl?: typeof fetch },
): Promise<ServerResponse> {
  const raw = requestUrl.searchParams.get("url");
  if (raw === null || raw.length === 0) {
    return refusal(400, "missing_url", "the viewer needs ?url=<absolute http(s) url>");
  }
  const doFetch = deps.fetchImpl ?? fetch;
  let current = raw;
  for (let hop = 0; hop <= VIEWER_MAX_REDIRECTS; hop += 1) {
    const refused = targetRefusal(current, viewer.allow);
    if (refused !== null) return refusal(403, "target_not_allowed", refused);
    let response: Response;
    try {
      response = await doFetch(current, {
        redirect: "manual",
        headers: { "user-agent": "bluepencil-viewer" },
        signal: AbortSignal.timeout(VIEWER_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return refusal(502, "target_unreachable", `could not fetch ${current}: ${reason}`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) return refusal(502, "target_unreachable", "the target redirected without a location");
      current = new URL(location, current).href;
      continue;
    }
    if (response.status !== 200) {
      return refusal(502, "target_unreachable", `the target answered ${response.status}`);
    }
    const typeRefusal = contentTypeRefusal(response.headers.get("content-type"));
    if (typeRefusal !== null) return refusal(415, "target_not_html", typeRefusal);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > VIEWER_MAX_BYTES) {
      return refusal(413, "target_too_large", `the target is larger than ${VIEWER_MAX_BYTES} bytes`);
    }
    const origin = publicOrigin(request, viewer);
    const html = buildViewDocument({
      html: new TextDecoder("utf-8").decode(buffer),
      baseHref: new URL(current).origin + "/",
      endpoint: `${origin}${context.base.replace(/\/+$/, "")}`,
      elementSrc: `${origin}${context.base.replace(/\/+$/, "")}/viewer/assets/bluepencil.element.min.js`,
      environment: context.environment,
      language: "de",
    });
    return {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        // The proxied document runs on this origin on purpose (that is the feature); it must not be
        // framed by anyone else, and it must not inherit a policy from the target.
        "x-frame-options": "SAMEORIGIN",
      },
      body: html,
    };
  }
  return refusal(502, "too_many_redirects", `more than ${VIEWER_MAX_REDIRECTS} redirects`);
}

/** Constant-time-ish comparison for the admin secret (length first, then a fixed-time loop). */
function secretsEqual(expected: string, presented: string): boolean {
  if (expected.length !== presented.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ presented.charCodeAt(index);
  }
  return diff === 0;
}
