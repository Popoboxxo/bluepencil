/**
 * Hub fetch relay — the service worker's outbound path for the layer's hub requests (#116).
 *
 * The layer runs in the page's MAIN world, so its `fetch` is the page's `fetch`: a document with
 * `default-src 'self'` and no `connect-src` blocks every hub call, and the pair silently never
 * syncs. The MV3 service worker is outside the page's CSP and already has the host permission, so
 * the request is relayed page → isolated-world bridge → this module. This file is the only party
 * that talks to the hub, and it is therefore the trust boundary — **not** the bridge.
 *
 * Why the bridge cannot be the boundary: any page script can post
 * `{source:"bluepencil-page", kind:"fetch"}` to the window, and the bridge's job is relaying, not
 * authorising. All checks live here, and they are deliberately allowlists:
 *
 *   - **Target:** only the configured endpoint's origin *and* base path. `{base}/admin` is denied
 *     explicitly (defence in depth — the admin credential header is not on the allowlist anyway).
 *   - **Methods:** `GET`, `POST`, `PATCH`. The adapter never sends `DELETE` (`remove()` uses
 *     `POST /notes/bulk-delete`), so the relay does not offer it.
 *   - **Headers:** `accept`, `content-type`, `authorization`, `x-bluepencil-auth`, and nothing else.
 *     An unknown name is an error rather than a silent drop, so a caller learns why.
 *   - **No ambient credentials:** `credentials: "omit"`, `cache: "no-store"`,
 *     `referrerPolicy: "no-referrer"`. The layer authenticates with a header, never a cookie.
 *   - **No redirects:** `redirect: "manual"`. Following one would carry the credential to an origin
 *     the user never configured, and the browser hides `Location` on an opaque redirect, so the
 *     target cannot be checked before it is contacted. The caller is told to save the final URL.
 *   - **Budgets:** 30 s, 1 MiB request, 8 MiB response. A non-2xx status is a normal answer, not a
 *     transport error — the adapter turns it into an `HttpAdapterError` with the real status.
 *
 * The module is free of DOM and `chrome.*` so every rule above is unit-testable (the pattern is
 * `connection.ts` / `handoff.ts`). Nothing about the note content is inspected here: it is bytes and
 * headers, in and out.
 */

/** The `kind` a page uses on the bridge channel to ask for a relayed request. */
export const PAGE_FETCH_KIND = "fetch";

/** 30 s, 1 MiB request body, 8 MiB response body. Exported so the pins can assert the numbers. */
export const HUB_FETCH_LIMITS = {
  timeoutMs: 30_000,
  maxRequestBodyBytes: 1024 * 1024,
  maxResponseBodyBytes: 8 * 1024 * 1024,
} as const;

/** The only methods the adapter uses (`src/adapters/http.ts`); `DELETE` is deliberately absent. */
export const HUB_FETCH_METHODS = ["GET", "POST", "PATCH"] as const;
export type HubFetchMethod = (typeof HUB_FETCH_METHODS)[number];

/**
 * Forwarded headers, lowercased. `cookie`, `origin` and `referer` are absent on purpose: the page
 * must not be able to smuggle ambient credentials or forge a provenance header through the relay.
 */
export const HUB_FETCH_HEADERS = [
  "accept",
  "content-type",
  "authorization",
  "x-bluepencil-auth",
] as const;

/** One header value may not exceed this; a header blob is not a payload channel. */
const MAX_HEADER_VALUE_BYTES = 4 * 1024;
/** A request with more headers than this is refused rather than truncated. */
const MAX_HEADERS = 8;

export type HubFetchErrorCode =
  | "disallowed_target"
  | "disallowed_method"
  | "disallowed_header"
  | "invalid_request"
  | "payload_too_large"
  | "timeout"
  | "network"
  | "redirect_not_allowed";

export interface HubFetchError {
  code: HubFetchErrorCode;
  /** Human-readable, never contains a header value, a token or a query string. */
  message: string;
}

export interface HubFetchRequest {
  method: HubFetchMethod;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** A successful relay, including non-2xx statuses: the adapter decides what a status means. */
export interface HubFetchSuccess {
  ok: true;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string | null;
}

export type HubFetchReply = HubFetchSuccess | { ok: false; error: HubFetchError };

export type HubFetchValidation =
  | { ok: true; request: HubFetchRequest }
  | { ok: false; error: HubFetchError };

export interface HubFetchPolicy {
  /** The configured API base, e.g. `http://127.0.0.1:8787/api/v1/bluepencil`. */
  endpoint: string;
  timeoutMs: number;
  maxRequestBodyBytes: number;
  maxResponseBodyBytes: number;
}

/** The production policy: the configured endpoint plus the fixed budgets. */
export function hubFetchPolicy(endpoint: string): HubFetchPolicy {
  return { endpoint, ...HUB_FETCH_LIMITS };
}

export interface HubFetchDeps {
  /** Injectable for tests; the worker uses the service worker's global `fetch`. */
  fetchImpl?: typeof fetch;
}

function fail(code: HubFetchErrorCode, message: string): { ok: false; error: HubFetchError } {
  // `code` is a protocol field, not a code string: the Webstore scan only flags a `code` property
  // *inside* an `executeScript(...)` call (CR-116-04), so the documented `error.code` shape can be
  // written plainly. See `scripts/lib/webstore-rules.mjs`.
  return { ok: false, error: { code, message } };
}

/** Build a refusal reply for a caller that already knows why it is refusing (used by the worker). */
export function refuse(code: HubFetchErrorCode, message: string): HubFetchReply {
  return fail(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Parse the configured endpoint once per call. A bad endpoint is a configuration error and is
 * reported as `disallowed_target`, the same code a page sees for a URL outside it — the worker never
 * has two kinds of "I do not know where the hub is".
 */
function baseOf(endpoint: string): URL | null {
  try {
    const base = new URL(endpoint);
    if (base.protocol !== "http:" && base.protocol !== "https:") return null;
    if (base.username !== "" || base.password !== "") return null;
    return base;
  } catch {
    return null;
  }
}

/** `"/api/v1/bluepencil"` → `"/api/v1/bluepencil"`, `"/"` → `""` (the whole origin). */
function basePathOf(base: URL): string {
  return base.pathname.replace(/\/+$/, "");
}

/**
 * Is `url` inside the configured hub base?
 *
 * The prefix check always continues with a `/`, so `/api/v1/bluepencilX` cannot pass for
 * `/api/v1/bluepencil`. **Any** percent-encoding in the path is refused: `%2e%2e/` may be decoded
 * after the browser has stopped normalising it, and encoded letters let `{base}/admin` be spelled
 * around the deny rule (`%61dmin`, `ad%6din`). The adapter never percent-encodes a path segment it
 * generates (note ids are `n-<uuid>`), so nothing the layer sends is lost. A configured endpoint
 * whose own base path contains `%` would become unusable — that is preferable to a rule that is
 * only sometimes true.
 */
function checkTarget(rawUrl: string, base: URL): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "the request URL is not absolute";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "only http and https targets are allowed";
  }
  if (url.username !== "" || url.password !== "") {
    return "the request URL must not carry credentials";
  }
  if (url.origin !== base.origin) {
    return "the request target is outside the configured hub origin";
  }
  if (url.hash !== "") {
    return "the request URL must not carry a fragment";
  }

  const basePath = basePathOf(base);
  const path = url.pathname;
  // Reject every percent-encoding, not just the separator/dot forms: the hub decodes the path, so
  // `%61dmin` is `/admin` to it while the literal segment check below only sees `%61dmin` (CR-116-02).
  if (path.includes("%")) {
    return "the request path is outside the configured hub base";
  }
  if (basePath !== "") {
    if (path !== basePath && !path.startsWith(`${basePath}/`)) {
      return "the request path is outside the configured hub base";
    }
  }

  const adminPath = basePath === "" ? "/admin" : `${basePath}/admin`;
  if (path === adminPath || path.startsWith(`${adminPath}/`)) {
    return "the hub admin surface is not reachable through the relay";
  }
  return null;
}

/**
 * Validate an untrusted request envelope from the bridge.
 *
 * Pure: no network, no globals, no clock. Every rejection is a named code, so a page (or the smoke
 * test) can assert *why* it was refused instead of matching prose.
 */
export function validateHubRequest(raw: unknown, policy: HubFetchPolicy): HubFetchValidation {
  if (!isRecord(raw)) {
    return fail("invalid_request", "the relay request must be an object");
  }

  const method = raw.method;
  if (typeof method !== "string") {
    return fail("invalid_request", "the relay request needs a method");
  }
  if (!(HUB_FETCH_METHODS as readonly string[]).includes(method)) {
    return fail("disallowed_method", `the relay does not allow ${method}`);
  }

  const rawUrl = raw.url;
  if (typeof rawUrl !== "string" || rawUrl === "") {
    return fail("invalid_request", "the relay request needs a URL");
  }
  const base = baseOf(policy.endpoint);
  if (base === null) {
    return fail("disallowed_target", "the configured hub endpoint is not a usable http(s) URL");
  }
  const targetError = checkTarget(rawUrl, base);
  if (targetError !== null) {
    return fail("disallowed_target", targetError);
  }

  const rawHeaders = raw.headers;
  if (rawHeaders !== undefined && !isRecord(rawHeaders)) {
    return fail("invalid_request", "the relay request headers must be an object");
  }
  const entries = Object.entries(rawHeaders ?? {});
  if (entries.length > MAX_HEADERS) {
    return fail("disallowed_header", `the relay allows at most ${MAX_HEADERS} headers`);
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (!(HUB_FETCH_HEADERS as readonly string[]).includes(lower)) {
      return fail("disallowed_header", `the relay does not forward the "${lower}" header`);
    }
    if (/[\r\n]/.test(name)) {
      return fail("disallowed_header", "a header name must not contain CR or LF");
    }
    if (typeof value !== "string") {
      return fail("invalid_request", `the "${lower}" header needs a string value`);
    }
    if (/[\r\n]/.test(value)) {
      return fail("disallowed_header", `the "${lower}" header value must not contain CR or LF`);
    }
    if (byteLength(value) > MAX_HEADER_VALUE_BYTES) {
      return fail("disallowed_header", `the "${lower}" header value exceeds ${MAX_HEADER_VALUE_BYTES} bytes`);
    }
    // Case variants of one name would silently overwrite each other, so the last writer would win
    // without anyone noticing. A duplicate is a malformed envelope, not a merge.
    if (headers[lower] !== undefined) {
      return fail("disallowed_header", `the "${lower}" header is present twice`);
    }
    headers[lower] = value;
  }

  const rawBody = raw.body;
  if (rawBody !== undefined && typeof rawBody !== "string") {
    return fail("invalid_request", "the relay request body must be a string");
  }
  if (rawBody !== undefined && method === "GET") {
    return fail("invalid_request", "a GET request must not carry a body");
  }
  if (typeof rawBody === "string") {
    const size = byteLength(rawBody);
    if (size > policy.maxRequestBodyBytes) {
      return fail(
        "payload_too_large",
        `the request body is ${size} bytes, the relay allows ${policy.maxRequestBodyBytes}`,
      );
    }
  }

  return {
    ok: true,
    request: {
      method: method as HubFetchMethod,
      url: rawUrl,
      headers,
      ...(typeof rawBody === "string" ? { body: rawBody } : {}),
    },
  };
}

/**
 * A failure text that cannot leak: only the error's *name* is used. Native fetch messages can carry
 * the URL (with its query) and a caller-supplied `Error` can carry anything, so neither is copied.
 */
function networkMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  return `the request could not be completed (${name})`;
}

/**
 * Perform one validated request in the worker and translate the answer into a reply the bridge can
 * relay. The fetch is made with the service worker's privileges but none of the page's ambient
 * state: no cookies, no cache, no referrer, no redirect following.
 *
 * **Precondition:** `request` must come from `validateHubRequest`. This function does not re-apply
 * the target/method/header policy — doing so would be a second implementation of it (FR-15.3). The
 * shape gate below only stops a caller that skipped the validator in the first place (CR-116-07).
 */
export async function runHubRequest(
  request: HubFetchRequest,
  policy: HubFetchPolicy,
  deps: HubFetchDeps = {},
): Promise<HubFetchReply> {
  if (
    typeof request !== "object" ||
    request === null ||
    typeof (request as { url?: unknown }).url !== "string" ||
    typeof (request as { method?: unknown }).method !== "string" ||
    !isRecord((request as { headers?: unknown }).headers)
  ) {
    return fail("invalid_request", "the relay request was not validated before it was performed");
  }
  const fetchImpl = deps.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof fetchImpl !== "function") {
    return fail("network", "this runtime has no fetch()");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
  try {
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
      credentials: "omit",
      cache: "no-store",
      redirect: "manual",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    };
    if (request.body !== undefined) {
      init.body = request.body;
    }

    const response = await fetchImpl(request.url, init);

    // `redirect: "manual"` gives an opaque redirect for a cross-origin 30x (status 0, no `Location`)
    // and the raw 3xx for a same-origin one. Both are refused: the credential has already been sent,
    // and the target cannot be inspected before following it.
    if (response.status >= 300 && response.status < 400) {
      return fail(
        "redirect_not_allowed",
        "the hub answered with a redirect; save its final URL in the options instead",
      );
    }
    if (response.type === "opaqueredirect") {
      return fail(
        "redirect_not_allowed",
        "the hub answered with a redirect; save its final URL in the options instead",
      );
    }
    if (response.status === 0) {
      return fail("network", "the request did not complete");
    }

    // `content-length` is a hint, not a guarantee, so it only short-circuits an obviously oversized
    // answer; the decoded body is measured as well.
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > policy.maxResponseBodyBytes) {
      return fail(
        "payload_too_large",
        `the hub response is ${declared} bytes, the relay allows ${policy.maxResponseBodyBytes}`,
      );
    }

    const text = await response.text();
    const size = byteLength(text);
    if (size > policy.maxResponseBodyBytes) {
      return fail(
        "payload_too_large",
        `the hub response is ${size} bytes, the relay allows ${policy.maxResponseBodyBytes}`,
      );
    }

    // Only `content-type` is relayed back. The adapter needs it for nothing, but a caller reading the
    // body should be able to see what it is; no other response header is the page's business.
    const contentType = response.headers.get("content-type");
    const headers: Record<string, string> = {};
    if (contentType !== null) {
      headers["content-type"] = contentType;
    }

    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      headers,
      body: text,
    };
  } catch (error) {
    // The only abort source is our own timer, so an AbortError is a timeout.
    if (error instanceof Error && error.name === "AbortError") {
      return fail("timeout", `the hub did not answer within ${policy.timeoutMs} ms`);
    }
    return fail("network", networkMessage(error));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn a successful reply back into a `Response` in the page, so the HTTP adapter needs no new
 * branch: it consumes exactly the object `fetch` would have returned.
 *
 * `204`, `205` and `304` are null-body statuses and throw if a body is passed, which is why they are
 * singled out. An error reply throws — a caller must not be able to mistake a refusal for data.
 */
export function replyToResponse(reply: HubFetchReply): Response {
  if (!reply.ok) {
    throw new Error(reply.error.message);
  }
  const nullBody = reply.status === 204 || reply.status === 205 || reply.status === 304;
  return new Response(nullBody ? null : (reply.body ?? ""), {
    status: reply.status,
    statusText: reply.statusText,
    headers: reply.headers,
  });
}
