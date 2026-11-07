/**
 * CORS metadata for the hub's doors — the notes API, the MCP route and the optional admin surface —
 * plus the viewer surface's bookmarklet reflection (issue #140).
 *
 * One vocabulary rather than one per route: a browser sends the same preflight for all of them, and
 * two lists that drift apart turn into "the notes API works but the admin route does not" for a
 * reason nobody can see in the network tab.
 *
 * This module has no runtime imports on purpose. The `ServerRequest` import is type-only and erased
 * before the module runs, so `server/handler.ts` can re-export it, `server/hub.ts` and
 * `server/mcp.ts` can import it from there, and `server/admin.ts` can import it directly — that is
 * what makes the last edge safe instead of a runtime cycle.
 *
 * `preflightResponse` is the one implementation of an `OPTIONS` answer on the hub, used by every
 * door that can be reached cross-origin: the notes router, the MCP route, the admin surface and the
 * static site (#102). Each caller names the methods *it* documents, and that list is the preflight's
 * answer — `/mcp` advertises `POST, OPTIONS`, `/health` advertises `GET, HEAD, OPTIONS`. Routing
 * still happens in the caller, so a path that is not part of the API keeps its 404 rather than
 * becoming an empty preflight answer.
 *
 * The viewer surface is deliberately *not* a general CORS surface (spec §2.5): it answers a
 * preflight only for a bookmarklet that asks with `x-bluepencil-viewer`, and it reflects the calling
 * origin on `{base}/notes*` answers so that client can read successes and validation errors. No
 * cookie is ever involved — the token is the credential, so `access-control-allow-credentials` has
 * no place here.
 */

import type { ServerRequest } from "./handler";

/**
 * Every header any caller of this API actually sends, or the browser drops it before the request
 * leaves: `Authorization` (signed token), `x-bluepencil-auth` (shared secret, #99 — without it an
 * authenticated cross-origin pairing fails after the preflight passes), and the identity/session
 * pair both MCP and the notes API record (`x-bluepencil-client`, `mcp-session-id`,
 * `x-bluepencil-actor` for the journal). Header names match case-insensitively.
 */
const ALLOW_HEADERS: readonly string[] = [
  "Content-Type",
  "Authorization",
  "X-Bluepencil-Auth",
  "X-Bluepencil-Client",
  "X-Bluepencil-Actor",
  "Mcp-Session-Id",
  "MCP-Protocol-Version",
];

/** A safety warning `--cors` can raise; structurally compatible with the hub's `StartupWarning`. */
export interface CorsWarning {
  code: "cors_wildcard";
  message: string;
}

/**
 * What `--cors` resolved to, or why it was refused (SEC-06, ADR-0.12-S1).
 *
 * `origin: null` means "no `--cors` at all" — the default, and the only value that emits no CORS
 * header. A refusal carries the machine-readable code the usage error and the tests quote.
 */
export type CorsOriginPolicy =
  | { ok: true; origin: string | null; warning?: CorsWarning }
  | { ok: false; code: "cors_value_missing" | "cors_wildcard_unauthenticated" };

/** The one warning `--cors '*'` produces; the hub prefixes it with its own name on stderr. */
export const CORS_WILDCARD_WARNING: CorsWarning = {
  code: "cors_wildcard",
  message:
    "WARNING (cors_wildcard): --cors '*' admits every origin to the notes API — any page a " +
    "browser visits can read and write every note it can reach, and the client credential is the " +
    "only boundary left. Name one origin instead of '*'.",
};

/**
 * Resolves the `--cors` flag (ADR-0.12-S1, SEC-06).
 *
 * A bare `--cors` used to mean `*` silently, which turned "I enabled CORS" into "every website may
 * read every note". The value is now required: absent means no CORS at all, `--cors ''` is a usage
 * error (`cors_value_missing`), and the wildcard has to be spelled out as `'*'` *and* needs a
 * configured client credential (`cors_wildcard_unauthenticated` otherwise) — the wildcard is only
 * survivable when the gate behind it is real. An explicit origin is passed through unchanged.
 *
 * `hasCredential` is the *client* gate (`--auth-secret` / `--token-key`), never the admin secret:
 * the admin secret guards an operator surface, it does not authenticate a browser.
 */
export function corsOriginPolicy(
  raw: string | undefined,
  hasCredential: boolean,
): CorsOriginPolicy {
  if (raw === undefined) return { ok: true, origin: null };
  const value = raw.trim();
  if (value === "") return { ok: false, code: "cors_value_missing" };
  if (value === "*") {
    if (!hasCredential) return { ok: false, code: "cors_wildcard_unauthenticated" };
    return { ok: true, origin: "*", warning: CORS_WILDCARD_WARNING };
  }
  return { ok: true, origin: value };
}

/**
 * The method list a preflight advertises: the caller's documented methods *are* the answer, plus
 * `OPTIONS`, deduped case-insensitively. The global list is deliberately not merged in here — a door
 * that only answers `POST` must not advertise `PATCH` (#102).
 */
function preflightMethods(documented: readonly string[]): string {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [...documented, "OPTIONS"]) {
    const trimmed = candidate.trim().toUpperCase();
    if (trimmed === "") continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(trimmed);
  }
  return names.join(", ");
}

/**
 * CORS headers for one deployment; the default (no `--cors`) sends none at all.
 *
 * `access-control-allow-methods` is deliberately absent: the header is only meaningful on a
 * preflight, and `preflightResponse` is the one place that names a door's documented methods. An
 * ordinary answer carrying the global vocabulary would contradict the preflight for the same door
 * (#102) — and every caller passed no list, so it always did.
 *
 * `extraAllowHeaders` is for a door that speaks a header of its own (the admin surface's
 * `x-bluepencil-admin`). Duplicates are dropped case-insensitively and the first spelling wins, so
 * the answer never lists one header twice in two casings.
 */
export function corsHeaders(
  cors: string | undefined,
  extraAllowHeaders: readonly string[] = [],
): Record<string, string> {
  if (cors === undefined || cors === "") return {};
  const names: string[] = [...ALLOW_HEADERS];
  const seen = new Set(names.map((name) => name.toLowerCase()));
  for (const extra of extraAllowHeaders) {
    const trimmed = extra.trim();
    if (trimmed === "") continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(trimmed);
  }
  return {
    "access-control-allow-origin": cors,
    "access-control-allow-headers": names.join(", "),
    "access-control-max-age": "600",
    ...(cors === "*" ? {} : { vary: "Origin" }),
  };
}

/** The shape a preflight answer has; structurally compatible with the handler's `ServerResponse`. */
export interface PreflightAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * The one CORS preflight implementation (#98, #99, #102).
 *
 * A browser sends `OPTIONS` without a credential — it cannot know one yet — so a credential check
 * on it could only refuse the pairing, never protect a note. `null` means "this is not a preflight
 * on a CORS-enabled hub": either the method is not OPTIONS, or `--cors` is off and the caller keeps
 * its ordinary route refusal.
 *
 * `allowMethods` names the methods the door documents and is authoritative for the preflight answer
 * (`OPTIONS` is appended, duplicates are dropped); `extraAllowHeaders` is for a door that speaks a
 * header of its own (the admin surface's `x-bluepencil-admin`). The shared header list is never
 * repeated per route — that is what makes it one vocabulary rather than five.
 */
export function preflightResponse(
  method: string | undefined,
  context: { readonly cors?: string | undefined },
  allowMethods: readonly string[] = [],
  extraAllowHeaders: readonly string[] = [],
): PreflightAnswer | null {
  if ((method ?? "GET").toUpperCase() !== "OPTIONS") return null;
  if (context.cors === undefined || context.cors === "") return null;
  return {
    status: 204,
    headers: {
      ...corsHeaders(context.cors, extraAllowHeaders),
      "access-control-allow-methods": preflightMethods(allowMethods),
    },
    body: "",
  };
}

/**
 * The header the bookmarklet carries (mirrors `VIEWER_HEADER` in `server/viewer.ts`).
 *
 * Defined here rather than imported so this module keeps its no-runtime-import rule; the two
 * spellings are pinned together by the viewer tests and by the preflight/answer path.
 */
const VIEWER_HEADER = "x-bluepencil-viewer";

/** The method union the whole `{base}/notes*` family documents (spec §2.5 Regel 1). */
const VIEWER_ALLOW_METHODS = "GET, POST, PATCH, OPTIONS";

/** The bookmarklet sends `content-type` plus its token header; nothing else is advertised. */
const VIEWER_ALLOW_HEADERS = "Content-Type, X-Bluepencil-Viewer";

/**
 * The origin a viewer response may reflect, or `null`.
 *
 * An `Origin` header is a serialised origin: scheme, host and optional port — never a path, query,
 * fragment or userinfo. `new URL()` normalises a bare origin to pathname `/`, so the pathname check
 * rejects `/anything` while accepting the browser's spelling. `null` (the header a sandboxed frame
 * sends) is not an origin and is refused.
 */
function reflectedOrigin(value: string | undefined): string | null {
  if (value === undefined) return null;
  const origin = value.trim();
  if (origin === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") return null;
  return origin;
}

/** Case-insensitive read of one request header; a repeated header joins with `", "`. */
function headerValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    return Array.isArray(value) ? value.join(", ") : value;
  }
  return undefined;
}

/** True when a comma-separated `Access-Control-Request-Headers` value names `name`. */
function requestsHeader(value: string | undefined, name: string): boolean {
  if (value === undefined) return false;
  const wanted = name.toLowerCase();
  return value.split(",").some((entry) => entry.trim().toLowerCase() === wanted);
}

/**
 * Path of a request target, never the host — same reading as `requestPath()` in `handler.ts`, kept
 * local so this module does not depend on the handler at runtime.
 */
function pathnameOf(url: string): string {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
  const target = absolute ? url : `http://localhost${url.startsWith("/") ? "" : "/"}${url}`;
  try {
    return new URL(target).pathname;
  } catch {
    const [path = ""] = url.split("?");
    return path;
  }
}

/** True for `{base}/notes` and `{base}/notes/…`, false for `{base}/notesx` and other routes. */
function isNotesPath(url: string, base: string): boolean {
  const trimmedBase = base.replace(/\/+$/, "");
  const notes = `${trimmedBase}/notes`;
  const pathname = pathnameOf(url);
  return pathname === notes || pathname.startsWith(`${notes}/`);
}

/**
 * The bookmarklet's preflight answer, or `null` (spec §2.5 Regel 1, AC-5.21).
 *
 * Only the viewer surface uses this, and only for `{base}/notes*`. A browser sends `OPTIONS` without
 * a credential, so the method/origin/requested-header gate is not an authorization: it selects the
 * one client that is allowed to *read* the answer. The gate is `x-bluepencil-viewer` in
 * `Access-Control-Request-Headers` — a plain cross-origin page asking for `content-type` gets `null`
 * and keeps the viewer's ordinary `405`. There is deliberately no `allowMethods` parameter: the
 * fixed union above is what every route of the family advertises, and a per-route list would make a
 * `PATCH` preflight fail on a door that only happened to name `GET, POST`.
 */
export function viewerBookmarkletPreflight(
  method: string | undefined,
  requestOrigin: string | undefined,
  requestedHeaders: string | undefined,
): PreflightAnswer | null {
  if ((method ?? "").toUpperCase() !== "OPTIONS") return null;
  const origin = reflectedOrigin(requestOrigin);
  if (origin === null) return null;
  if (!requestsHeader(requestedHeaders, VIEWER_HEADER)) return null;
  return {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": VIEWER_ALLOW_METHODS,
      "access-control-allow-headers": VIEWER_ALLOW_HEADERS,
      "access-control-max-age": "600",
      vary: "Origin",
    },
    body: "",
  };
}

/**
 * The same origin reflection for an actual (non-`OPTIONS`) response (spec §2.5 Regel 2).
 *
 * The bookmarklet must be able to read `200` answers *and* the `400 invalid_query`/
 * `invalid_payload` refusals the notes routes produce, otherwise its UI shows "network error" for
 * an input mistake. Only the origin and `vary` are set: no methods, no headers, no credentials.
 */
export function viewerBookmarkletCors(requestOrigin: string | undefined): Record<string, string> {
  const origin = reflectedOrigin(requestOrigin);
  if (origin === null) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
  };
}

/**
 * The subset of `HandlerContext` `responseCorsHeaders()` reads.
 *
 * Structural rather than an import of `HandlerContext` so the function stays usable from the pure
 * handler while the surface field is introduced (Task 6); every `HandlerContext` remains assignable.
 */
export interface ResponseCorsContext {
  /** Normalised API base; `"/"` and `""` both mean "everything is under the base". */
  readonly base: string;
  /** `--cors`; read on the hub surface only. */
  readonly cors?: string;
  /** `"viewer"` selects bookmarklet reflection; absent or `"hub"` is the hub. */
  readonly surface?: "hub" | "viewer";
}

/**
 * CORS headers for `json()`/`errorResponse()`/`/bundle` (spec §2.5 Regel 3).
 *
 * Hub: byte-identical to `corsHeaders(context.cors)` — this is the one place the hub's `--cors`
 * policy is applied, and the viewer work must not change it.
 *
 * Viewer: `context.cors` is never read. Only `{base}/notes*` answers reflect the calling origin, and
 * never an `OPTIONS`: a preflight's `204` comes from `viewerBookmarkletPreflight()`, and a negative
 * `405` carries no CORS header at all. Every other viewer route — `bundle`, `sessions`, `health`,
 * `viewer`, the refusals — stays at `{}`.
 */
export function responseCorsHeaders(
  request: Pick<ServerRequest, "url" | "headers" | "method">,
  context: ResponseCorsContext,
): Record<string, string> {
  if (context.surface !== "viewer") return corsHeaders(context.cors);
  if (request.method.toUpperCase() === "OPTIONS") return {};
  if (!isNotesPath(request.url, context.base)) return {};
  return viewerBookmarkletCors(headerValue(request.headers, "origin"));
}
