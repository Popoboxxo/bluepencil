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
 *   one-time ticket on the **hub** origin (`GET {base}/viewer/start`), redeems that ticket on the
 *   viewer origin for a short-lived session token, which travels as an HttpOnly cookie for the
 *   proxied page and as a header for the bookmarklet. The secret itself never reaches the viewer
 *   origin: a page served by the viewer can read anything the layer can, and a leaked *session*
 *   dies.
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
import { isLoopbackAddress } from "./handler";
import { ADMIN_HEADER } from "../src/core/protocol-headers";
import type { HostResolver } from "../src/federation/net-policy";
import {
  classifyAddress,
  createDnsResolver,
  isIpLiteral,
  METADATA_HOSTNAMES,
} from "../src/federation/net-policy";
import { verifyOperatorSecret } from "./admin";
import { bookmarkletSnippet, bookmarkletTextArtifact } from "./viewer-bookmarklet";
import { renderViewerHtml } from "./viewer-html";

/** The length of a viewer session token in bytes (hex-doubled on the wire). */
const SESSION_BYTES = 24;

/** The length of a one-time launcher ticket in bytes (hex-doubled on the wire). */
const TICKET_BYTES = 24;

/**
 * How long a launcher ticket stays redeemable. The operator's browser is redirected immediately, so
 * a minute is generous; a stolen ticket is worthless once it expires or is used.
 */
export const VIEWER_TICKET_TTL_SECONDS = 60;

/** Upper bound on live tickets: minting past it drops the oldest entry (insertion order). */
export const VIEWER_MAX_TICKETS = 1024;

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
  /**
   * Public origin of the viewer listener, e.g. `https://view.example.com`. No path, query or
   * fragment. Resolved by `startHub()` **before the first served request**; the cookie's `Secure`
   * flag and every absolute link derive from it.
   */
  origin?: string;
  /**
   * @deprecated Input alias from 0.13.0. `resolveOptions()` normalises it onto `origin`; `origin`
   * wins when both are set.
   */
  publicBaseUrl?: string;
  /**
   * The hub's **bind** origin (`http://<bind address>:<port>`), used only for the launcher hint in
   * the session-refusal message. Never a secret and never the public hub origin: `startHub()` sets
   * it only when the hub bind is loopback.
   */
  hubOrigin?: string;
  /** Live sessions, in memory — a restart ends every viewer session. */
  sessions: ViewerSessions;
  /**
   * One-time launcher tickets, in memory. `resolveOptions()` creates this exactly once; the field is
   * optional here only so embedded hosts and the pre-viewer build keep compiling.
   */
  tickets?: ViewerTickets;
  /** Extra host names for the host gate (derived from `--viewer-origin`). */
  hostAliases?: readonly string[];
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

/**
 * One-time launcher tickets: 24 random bytes as 48 hex characters, short-lived, single-use, memory
 * only. The operator's admin secret is exchanged for one of these on the hub origin, so the secret
 * never travels to the viewer origin in a URL the viewer can read.
 */
export interface ViewerTickets {
  mint(): { ticket: string; expiresAt: number };
  /** Atomically true only on the first call for a valid, unexpired ticket. */
  consume(ticket: string | undefined): boolean;
  /** Live tickets, after pruning the expired ones. */
  size(): number;
}

/** A ticket store shared by every request of one hub process. */
export function createViewerTickets(
  ttlSeconds: number = VIEWER_TICKET_TTL_SECONDS,
): ViewerTickets {
  const live = new Map<string, number>();
  const prune = (now: number): void => {
    for (const [ticket, expiresAt] of live) {
      if (expiresAt <= now) live.delete(ticket);
    }
  };
  return {
    mint() {
      const now = Date.now();
      prune(now);
      // Insertion order is age order: the first key is always the oldest ticket.
      while (live.size >= VIEWER_MAX_TICKETS) {
        const oldest = live.keys().next();
        if (oldest.done === true) break;
        live.delete(oldest.value);
      }
      const ticket = randomBytes(TICKET_BYTES).toString("hex");
      const expiresAt = now + ttlSeconds * 1000;
      live.set(ticket, expiresAt);
      return { ticket, expiresAt };
    },
    consume(ticket) {
      if (ticket === undefined || ticket.length === 0) return false;
      const expiresAt = live.get(ticket);
      if (expiresAt === undefined) return false;
      // Delete before answering: a replay can never observe the entry again.
      live.delete(ticket);
      return expiresAt > Date.now();
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
  // The reverse is strict — an entry that names a port means exactly that port. An IPv6 literal has
  // several colons and no port unless it is bracketed (`[::1]:8080`), which the splitter handles.
  const candidateParts = splitHostPort(candidate);
  const candidateHost = stripHostBrackets(candidateParts.host);
  for (const raw of allow) {
    const pattern = raw.trim().toLowerCase();
    if (pattern.length === 0) continue;
    const patternParts = splitHostPort(pattern);
    const patternHost = stripHostBrackets(patternParts.host);
    if (patternParts.port !== null && pattern !== candidate) continue;
    if (patternHost.startsWith("*.")) {
      const suffix = patternHost.slice(1); // ".example.com"
      if (candidateHost.endsWith(suffix) && candidateHost.length > suffix.length) return true;
      continue;
    }
    if (candidateHost === patternHost) return true;
  }
  return false;
}

/** Splits `host`, `host:port` and `[v6]`/`[v6]:port` without mistaking an IPv6 colon for a port. */
function splitHostPort(value: string): { host: string; port: string | null } {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end >= 0) {
      const host = value.slice(0, end + 1);
      const rest = value.slice(end + 1);
      return { host, port: rest.startsWith(":") ? rest.slice(1) : null };
    }
  }
  const first = value.indexOf(":");
  const last = value.lastIndexOf(":");
  if (first >= 0 && first === last && /^\d+$/.test(value.slice(last + 1))) {
    return { host: value.slice(0, last), port: value.slice(last + 1) };
  }
  return { host: value, port: null };
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

/** Stable, viewer-local refusal reasons; deliberately not part of `ERROR_CODES` (spec §2.9). */
export type TargetRefusalCode =
  | "target_not_allowed"
  | "target_metadata_host"
  | "unresolvable_host"
  | "target_address_forbidden"
  | "target_forbidden_origin";

/** A machine-readable refusal reason plus the human-readable detail for the JSON body. */
export interface TargetRefusal {
  readonly code: TargetRefusalCode;
  readonly message: string;
}

/** Everything the asynchronous target policy needs; every field has a safe default. */
export interface TargetPolicyDeps {
  /** DNS resolver; defaults to `createDnsResolver({ timeoutMs: 2000 })`. */
  resolver?: HostResolver;
  /** Origins that may never be a target (the viewer origin, optionally the hub origin). */
  forbiddenOrigins?: readonly string[];
  /** Default `true`: private targets are allowed only for an exact (never wildcard) entry. */
  allowPrivateExact?: boolean;
}

function refuse(code: TargetRefusalCode, message: string): TargetRefusal {
  return { code, message };
}

function stripHostBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** True when the host name is a known cloud metadata endpoint (checked before allowlist/DNS). */
function isMetadataHostname(hostname: string): boolean {
  return METADATA_HOSTNAMES.includes(hostname.trim().toLowerCase());
}

/**
 * True when `hostname` appears **literally** in the allowlist. A wildcard entry never counts: a
 * `*.example.com` line may route public addresses, but authorizing a private resolution has to be
 * an explicit, readable decision.
 */
function exactAllowEntry(hostname: string, allow: readonly string[]): boolean {
  const candidate = stripHostBrackets(hostname.trim().toLowerCase());
  return allow.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry.length === 0 || entry.includes("*")) return false;
    return stripHostBrackets(entry) === candidate;
  });
}

/**
 * One address against the IP policy: `public` and (opt-in) exactly allowed private addresses.
 *
 * `subject` is what the exact-entry rule looks at: the literal IP for an IP target, the host name
 * for a DNS result (an exact `internal.example.com` entry authorizes its `10.0.0.5`, a wildcard
 * never does).
 */
function classifyHostAddress(
  address: string,
  subject: string,
  allow: readonly string[],
  deps: TargetPolicyDeps,
): TargetRefusal | null {
  const kind = classifyAddress(address);
  if (kind === "public") return null;
  if (kind === "private") {
    if (deps.allowPrivateExact !== false && exactAllowEntry(subject, allow)) return null;
    return refuse(
      "target_address_forbidden",
      `the target resolves to the private address ${address}; only an exact --viewer-allow entry may authorize it`,
    );
  }
  return refuse("target_address_forbidden", `the target resolves to a ${kind} address (${address})`);
}

/** Normalises an origin for comparison: scheme + host + port, default ports dropped. */
function normalizeOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** `target_forbidden_origin` when the target is one of the forbidden origins (self-proxy guard). */
function forbiddenOriginRefusal(
  url: URL,
  forbidden: readonly string[] | undefined,
): TargetRefusal | null {
  if (forbidden === undefined || forbidden.length === 0) return null;
  const target = url.origin;
  for (const raw of forbidden) {
    const normalized = normalizeOrigin(raw);
    if (normalized !== null && normalized === target) {
      return refuse("target_forbidden_origin", `${target} is a forbidden target origin`);
    }
  }
  return null;
}

/**
 * The one target check (spec §2.2 rule 12, §4.8). **Total**: every failure is a `TargetRefusal`,
 * never a thrown exception — a resolver error must not become a `500`.
 *
 * Order is part of the security property: metadata host names are refused before the allowlist and
 * before any DNS traffic, the synchronous allowlist is consulted before the resolver, and each
 * resolved address is classified individually (one forbidden address rejects the whole target).
 */
export async function checkTarget(
  raw: string,
  allow: readonly string[],
  deps: TargetPolicyDeps = {},
): Promise<TargetRefusal | null> {
  try {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return refuse("target_not_allowed", "the url is not an absolute URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return refuse("target_not_allowed", "only http and https targets can be viewed");
    }
    if (url.username !== "" || url.password !== "") {
      return refuse("target_not_allowed", "a target URL must not carry credentials");
    }

    const hostname = url.hostname.toLowerCase();
    // Metadata first: a cloud metadata name is refused even when it is allowlisted, and without
    // spending a DNS lookup on it.
    if (isMetadataHostname(hostname)) {
      return refuse("target_metadata_host", `${hostname} is a cloud metadata service`);
    }

    const synchronous = targetRefusal(raw, allow);
    if (synchronous !== null) return refuse("target_not_allowed", synchronous);

    if (isIpLiteral(hostname)) {
      const refused = classifyHostAddress(hostname, hostname, allow, deps);
      return refused !== null ? refused : forbiddenOriginRefusal(url, deps.forbiddenOrigins);
    }

    const resolver = deps.resolver ?? createDnsResolver({ timeoutMs: 2000 });
    let addresses: readonly string[];
    try {
      addresses = await resolver(hostname);
    } catch {
      return refuse("unresolvable_host", `could not resolve ${hostname}`);
    }
    if (!Array.isArray(addresses) || addresses.length === 0) {
      return refuse("unresolvable_host", `${hostname} did not resolve to an address`);
    }
    for (const address of addresses) {
      if (typeof address !== "string" || !isIpLiteral(address)) {
        return refuse("unresolvable_host", `${hostname} resolved to a non-IP value`);
      }
      const refused = classifyHostAddress(address, hostname, allow, deps);
      if (refused !== null) return refused;
    }
    return forbiddenOriginRefusal(url, deps.forbiddenOrigins);
  } catch {
    // The function is total by contract: an unexpected parse or resolver shape is a refusal.
    return refuse("target_not_allowed", "the target could not be checked");
  }
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

/**
 * The `Set-Cookie` value for a freshly minted session.
 *
 * Exact contract (spec §2.2 rule 2): `bp_viewer=<token>; HttpOnly; SameSite=Lax; Path=<base>;
 * Max-Age=<ttl>` and `; Secure` exactly when the resolved public origin is `https:`. No `Domain`
 * (host-only) and no `Expires` — `Max-Age` is the single lifetime statement.
 */
export function sessionCookie(
  token: string,
  options: { ttlSeconds: number; base: string; secure: boolean },
): string {
  const path = options.base.replace(/\/+$/, "") || "/";
  const cookie =
    `${VIEWER_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${options.ttlSeconds}`;
  return options.secure ? `${cookie}; Secure` : cookie;
}

/** Path of the hub-side launcher: `{base}/viewer/start`. */
export function viewerStartPath(base: string): string {
  return `${base.replace(/\/+$/, "")}/viewer/start`;
}

/**
 * The one message for every viewer-session refusal: shell, bookmarklet, `/view` and the fail-closed
 * `401` of the notes routes. With a `hubOrigin` set by `startHub()` it names the launcher URL; without
 * one it stays URL-less rather than inventing a `http://` address. The old `{base}/viewer?k=` dead end
 * never appears.
 */
export function viewerSessionRefusalMessage(context: HandlerContext): string {
  const hubOrigin = context.viewer?.hubOrigin?.replace(/\/+$/, "") ?? "";
  if (hubOrigin.length === 0) {
    return "the viewer needs a session — open the hub launcher on the hub origin";
  }
  return `the viewer needs a session — open the hub launcher at ${hubOrigin}${viewerStartPath(context.base)}`;
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

/**
 * The base URL a page or the layer should address: the configured public origin when present,
 * otherwise the request's own origin.
 *
 * `X-Forwarded-Proto: https` is trusted only from a loopback peer (the reverse proxy on the same
 * machine). A non-loopback peer claiming `https` is ignored, and an explicit origin always wins.
 */
export function publicOrigin(request: ServerRequest, viewer: ViewerOptions): string {
  const explicit = viewer.origin ?? viewer.publicBaseUrl;
  if (explicit !== undefined) return explicit.replace(/\/+$/, "");
  const host = headerValue(request, "host") ?? "127.0.0.1";
  const forwarded = headerValue(request, "x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  const trustedPeer = request.remote !== undefined && isLoopbackAddress(request.remote);
  const proto = trustedPeer && forwarded === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

/** Why a target's response cannot be shown, or `null` when it can. */
function contentTypeRefusal(contentType: string | null): string | null {
  if (contentType === null) return null;
  const plain = contentType.toLowerCase();
  if (plain.includes("text/html") || plain.includes("application/xhtml+xml")) return null;
  return `the target answered with ${plain.split(";")[0]}, not HTML`;
}

/** The surface a context belongs to; `undefined` means "hub" (spec §2.1). */
type Surface = "hub" | "viewer";

type SurfaceAwareContext = HandlerContext & { surface?: Surface };

/**
 * Reads the surface switch without importing `server/handler.ts`'s `surfaceOf()` (Task 6 owns that
 * function). An absent switch is the hub, which keeps every pre-viewer embed on the old surface.
 */
function surfaceOf(context: HandlerContext): Surface {
  return (context as SurfaceAwareContext).surface === "viewer" ? "viewer" : "hub";
}

/** Path of the hub-side launcher: `{base}/viewer/start`. */
export function isViewerStartRequest(url: string, context: HandlerContext): boolean {
  if (context.viewer === undefined) return false;
  return requestPath(url) === requestPath(viewerStartPath(context.base));
}

/** The JSON answer the start window gives while `viewer.origin` is still unresolved (AC-F22). */
function serviceNotReady(): ServerResponse {
  return {
    status: 503,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": "1",
    },
    body: JSON.stringify({
      error: {
        code: "service_not_ready",
        message: "the viewer origin is not resolved yet — retry shortly",
      },
    }),
  };
}

/**
 * The hub-side launcher: operator secret → one-time ticket → `302` onto the viewer origin
 * (spec §2.2 rule 4, §3.1).
 *
 * Only the **hub** surface owns this route; the viewer surface answers `null` so the router's
 * ordinary 404 stands. The origin check runs before `verifyOperatorSecret()`, so an unresolved
 * origin never spends the `admin` budget and never mints a ticket.
 */
export function handleViewerStart(
  request: ServerRequest,
  context: HandlerContext,
): ServerResponse | null {
  const viewer = context.viewer;
  if (viewer === undefined) return null;
  if (surfaceOf(context) !== "hub") return null;
  if (!isViewerStartRequest(request.url ?? "/", context)) return null;

  // R2-F4: the launcher is a GET-only route (spec §2.8). A state-changing verb must be refused
  // before the origin and the operator secret are consulted, so a POST can never mint a ticket and
  // never spends the `admin` budget. `Allow` names the one documented method.
  const method = (request.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    const response = refusal(
      405,
      "method_not_allowed",
      `${method} is not allowed on ${viewerStartPath(context.base)} — documented method(s): GET`,
    );
    response.headers.allow = "GET";
    return response;
  }

  // Defense in depth: `startHub()` resolves the origin before the first served request. This
  // branch must never emit a relative or empty Location, and it must not mint.
  if (viewer.origin === undefined || viewer.origin.length === 0) return serviceNotReady();

  const url = new URL(request.url ?? "/", "http://hub.invalid");
  const header = headerValue(request, ADMIN_HEADER);
  // The header wins: when it is present, a `?k=` value is never consulted.
  const presented = header !== undefined ? header : (url.searchParams.get("k") ?? undefined);
  const verdict = verifyOperatorSecret(request, context, presented);

  if (verdict.kind === "throttled") {
    return {
      status: 429,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": String(verdict.retryAfterSeconds),
      },
      body: JSON.stringify({
        error: {
          code: "too_many_attempts",
          message: "too many wrong operator-secret attempts from this address — wait before trying again",
        },
      }),
    };
  }
  if (verdict.kind === "invalid") {
    return refusal(401, "unauthorized", "the launcher needs the operator secret (x-bluepencil-admin header or ?k=)");
  }
  if (viewer.tickets === undefined) return serviceNotReady();

  const ticket = viewer.tickets.mint().ticket;
  const origin = viewer.origin.replace(/\/+$/, "");
  const base = context.base.replace(/\/+$/, "");
  return {
    status: 302,
    headers: {
      location: `${origin}${base}/viewer?ticket=${ticket}`,
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
    body: "",
  };
}

/** Serves one of the two known layer bundles; public and session-free by design (AC-5.14). */
function serveAsset(path: string, assetsPrefix: string, viewer: ViewerOptions): ServerResponse {
  const name = basename(path.slice(assetsPrefix.length + 1));
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
        "cross-origin-resource-policy": "cross-origin",
        "cache-control": "no-cache",
      },
      body,
    };
  } catch {
    return refusal(404, "not_found", `${name} is not in --viewer-assets`);
  }
}

/**
 * Answers a viewer request, or `null` when the request is not one.
 *
 * Bound to the **viewer** surface: the hub surface never serves a proxied document, an asset or the
 * shell (AC-5.15/AC-5.9). Assets are served before every session check (a cross-site `<script src>`
 * can send neither the cookie nor a custom header); a valid `?ticket` wins over `?k=`; `?k=` is
 * never compared here — the hub launcher is the only place that sees the operator secret.
 */
export async function handleViewer(
  request: ServerRequest,
  context: HandlerContext,
  deps: { fetchImpl?: typeof fetch; resolver?: HostResolver } = {},
): Promise<ServerResponse | null> {
  const viewer = context.viewer;
  if (viewer === undefined) return null;
  if (surfaceOf(context) !== "viewer") return null;
  const requestUrl = request.url ?? "/";
  if (!isViewerRequest(requestUrl, context)) return null;

  const method = (request.method ?? "GET").toUpperCase();
  const url = new URL(requestUrl, "http://hub.invalid");
  const path = requestPath(url.pathname);
  const paths = viewerPaths(context.base);

  // 1. Method first: a non-GET never reaches a session check or the network.
  if (method !== "GET") {
    return {
      ...refusal(405, "method_not_allowed", `${method} is not allowed on ${path}`),
      headers: { "content-type": "application/json; charset=utf-8", allow: "GET" },
    };
  }

  // 2. Assets before every session check (they ignore `?k=` and `?ticket`).
  if (path.startsWith(`${paths.assets}/`)) return serveAsset(path, paths.assets, viewer);

  // 3. Ticket redemption. It wins over `?k=`; an invalid ticket is a plain session refusal.
  if (path === paths.page && url.searchParams.has("ticket")) {
    const ticket = url.searchParams.get("ticket") ?? "";
    if (viewer.tickets === undefined || !viewer.tickets.consume(ticket)) {
      return refusal(401, "unauthorized", viewerSessionRefusalMessage(context));
    }
    const session = viewer.sessions.mint();
    const secure = publicOrigin(request, viewer).startsWith("https:");
    return {
      status: 302,
      headers: {
        location: context.base.replace(/\/+$/, "") + "/viewer",
        "set-cookie": sessionCookie(session.token, {
          ttlSeconds: viewer.ttlSeconds,
          base: context.base,
          secure,
        }),
        "referrer-policy": "no-referrer",
        "cache-control": "no-store",
      },
      body: "",
    };
  }

  // 4. `?k=` on a session-protected viewer route is an explicit dead end: the value is never
  //    compared, never mints and never spends the admin throttle. The message points at the hub
  //    launcher instead of the removed `{base}/viewer?k=` exchange.
  const sessionProtected = path === paths.page || path === paths.view || path === paths.bookmarklet;
  if (sessionProtected && url.searchParams.has("k")) {
    return refusal(401, "unauthorized", viewerSessionRefusalMessage(context));
  }

  // 5. Session.
  if (!viewerAuthorized(request, context)) {
    return refusal(401, "unauthorized", viewerSessionRefusalMessage(context));
  }

  // 6. Shell / bookmarklet / proxy.
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
  deps: { fetchImpl?: typeof fetch; resolver?: HostResolver },
): Promise<ServerResponse> {
  const raw = requestUrl.searchParams.get("url");
  if (raw === null || raw.length === 0) {
    return refusal(400, "missing_url", "the viewer needs ?url=<absolute http(s) url>");
  }
  const doFetch = deps.fetchImpl ?? fetch;
  const resolver = deps.resolver ?? createDnsResolver({ timeoutMs: 2000 });
  const forbiddenOrigins = viewer.origin === undefined ? [] : [viewer.origin];
  let current = raw;
  for (let hop = 0; hop <= VIEWER_MAX_REDIRECTS; hop += 1) {
    // The same check runs before the first fetch and before every redirect hop; an unallowed hop
    // costs no network beyond the answer that pointed at it.
    const refused = await checkTarget(current, viewer.allow, {
      resolver,
      forbiddenOrigins,
      allowPrivateExact: true,
    });
    if (refused !== null) return refusal(403, refused.code, refused.message);
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
        // framed by anyone else, and it must not inherit a policy from the target. No CSP header is
        // copied; `buildViewDocument()` removes the target's `<meta>` CSP.
        "x-frame-options": "SAMEORIGIN",
      },
      body: html,
    };
  }
  return refusal(502, "too_many_redirects", `more than ${VIEWER_MAX_REDIRECTS} redirects`);
}
