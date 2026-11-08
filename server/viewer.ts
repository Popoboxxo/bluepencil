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
import { isLoopbackAddress, surfaceOf } from "./handler";
import { ADMIN_STRINGS, adminLanguage, type AdminStrings } from "./admin-i18n";
import { renderLauncherHtml, fillTemplate } from "./launcher-html";
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
  return firstHeaderValue(request, name);
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

/** The surface a context belongs to is read through `surfaceOf()` (`server/handler.ts`). */

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
      // The answer is produced without reading a body (§5.1 rule 9): a kept-alive socket would
      // carry unread bytes into the next request.
      connection: "close",
    },
    body: JSON.stringify({
      error: {
        code: "service_not_ready",
        message: "the viewer origin is not resolved yet — retry shortly",
      },
    }),
  };
}

/* ------------------------------------------------------------------------------------------------
 * Launcher: answer format, origin basis, body field and the header-only gates (spec §5.1–§5.3)
 * ---------------------------------------------------------------------------------------------- */

/** Size limit of the launcher body in bytes. Small, because the form carries exactly one field. */
export const VIEWER_LAUNCHER_MAX_BODY_BYTES = 8 * 1024;

/** The launcher's one field name. */
export const VIEWER_LAUNCHER_FIELD = "secret";

/** The answer format an `Accept` header asks for. Total: missing/unknown → `"json"`. */
export type LauncherFormat = "html" | "json";

/** The one media type a launcher body may declare (spec §5.1 rule 6). */
const LAUNCHER_FORM_TYPE = "application/x-www-form-urlencoded";

/** The CSP of every launcher HTML answer (spec §6): no script, no external resource, no framing. */
const LAUNCHER_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/** The JSON message of a refused secret — unchanged since 0.14.0 (AC-L03/L11 keep this body). */
const LAUNCHER_INVALID_MESSAGE =
  "the launcher needs the operator secret (x-bluepencil-admin header or ?k=)";

/**
 * Every value of one header, in wire order; an absent header is an empty list.
 *
 * The lookup walks the keys instead of indexing two spellings, so it is fully case-insensitive
 * for every caller (the same shape as `headerOf()` in `server/admin.ts`): a request built by
 * hand may spell the name in any case, `node:http` lower-cases it on the wire.
 */
function headerValues(request: Pick<ServerRequest, "headers">, name: string): string[] {
  const headers = request.headers;
  if (headers === undefined) return [];
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const raw = headers[key];
    if (typeof raw === "string") return [raw];
    if (Array.isArray(raw)) return raw;
    return [];
  }
  return [];
}

/** The first value of one header — the list-aware variant is `headerValues()` above. */
function firstHeaderValue(request: Pick<ServerRequest, "headers">, name: string): string | undefined {
  return headerValues(request, name)[0];
}

/**
 * The first **non-empty** element of a comma-separated header, trimmed and lower-cased
 * (spec §5.2 rule 1). `X-Forwarded-Host: , hub.example.com` therefore yields `hub.example.com`.
 */
function firstForwardedValue(request: Pick<ServerRequest, "headers">, name: string): string | undefined {
  for (const value of headerValues(request, name).join(",").split(",")) {
    const trimmed = value.trim().toLowerCase();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

/**
 * The answer format an `Accept` header asks for (spec §5.1 rule 1).
 *
 * `html` only when an explicit `text/html` or `application/xhtml+xml` with `q > 0` is present and
 * its `q` is at least the `q` of `application/json`; `*​/*`, `text/*` and a missing header are never
 * an HTML wish. A tie wins HTML: browsers send `text/html` first, scripts send `*​/*`.
 */
export function launcherFormat(accept: string | undefined): LauncherFormat {
  if (accept === undefined || accept.trim().length === 0) return "json";
  let qHtml = 0;
  let qJson = 0;
  for (const rawRange of accept.split(",")) {
    const parts = rawRange.split(";");
    const media = (parts[0] ?? "").trim().toLowerCase();
    let q = 1;
    for (const rawParam of parts.slice(1)) {
      const [key, ...rest] = rawParam.split("=");
      if ((key ?? "").trim().toLowerCase() !== "q") continue;
      const value = rest.join("=").trim();
      const parsed = value === "" ? Number.NaN : Number(value);
      // Unparseable → 1; a parseable value is clamped into the documented 0..1 range.
      q = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 1;
    }
    if (media === "text/html" || media === "application/xhtml+xml") {
      qHtml = Math.max(qHtml, q);
    } else if (media === "application/json") {
      qJson = Math.max(qJson, q);
    }
  }
  return qHtml > 0 && qHtml >= qJson ? "html" : "json";
}

/**
 * The origin a page served by this hub reports in `Origin`: the forwarded chain first
 * (`x-forwarded-host` + `x-forwarded-proto`), `Host` as the fallback. `null` when it cannot be
 * derived — the caller refuses with `403` rather than guessing (spec §5.2 rule 1).
 */
export function launcherOriginBasis(request: Pick<ServerRequest, "headers">): string | null {
  const host =
    firstForwardedValue(request, "x-forwarded-host") ?? firstForwardedValue(request, "host");
  if (host === undefined) return null;
  // A Host value is a host[:port] and nothing else. Anything that looks like userinfo, a path, a
  // query, a fragment, embedded whitespace — or a backslash, which several clients and proxies
  // normalize to `/` — is not an origin we are willing to compare against.
  if (/[/\\?#@\s]/.test(host)) return null;
  const scheme = firstForwardedValue(request, "x-forwarded-proto") === "https" ? "https" : "http";
  return normalizeOrigin(`${scheme}://${host}`);
}

/** First value of the `secret` field of a form-urlencoded body; `undefined` when it is absent. */
export function launcherSecretFromBody(body: string | undefined): string | undefined {
  // `URLSearchParams` is the form-urlencoded contract itself: `+` → space, percent-decoding that
  // never throws (`%zz` stays literal), and the first value for a duplicate key. No hand parser.
  const value = new URLSearchParams(body ?? "").get(VIEWER_LAUNCHER_FIELD);
  return value === null ? undefined : value;
}

/** The string table the launcher answers in: the same selection as `/admin` (FR-6.30). */
function launcherStrings(request: Pick<ServerRequest, "headers">): AdminStrings {
  return ADMIN_STRINGS[adminLanguage(firstHeaderValue(request, "accept-language"))];
}

/** One launcher HTML answer: the form page, optionally with the one-line error block (spec §4). */
function launcherPageAnswer(
  request: Pick<ServerRequest, "headers">,
  context: HandlerContext,
  status: number,
  error?: string,
  extra: Record<string, string> = {},
): ServerResponse {
  return {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": LAUNCHER_CSP,
      "referrer-policy": "no-referrer",
      ...extra,
    },
    body: renderLauncherHtml(launcherStrings(request), {
      action: viewerStartPath(context.base),
      ...(error === undefined || error.length === 0 ? {} : { error }),
    }),
  };
}

/**
 * An error answer in the format the request asked for (spec §3, "einheitliches Fehlerformat"):
 * HTML gets the form plus the localized message, JSON keeps the `{error:{code,message}}` shape.
 * `localizedError === undefined` renders the form without an error block — the 405 answer has no
 * string in the shared table (§5.8 has exactly fourteen keys).
 */
function launcherErrorAnswer(
  request: Pick<ServerRequest, "headers">,
  context: HandlerContext,
  status: number,
  format: LauncherFormat,
  code: string,
  message: string,
  localizedError: string | undefined,
  extra: Record<string, string> = {},
): ServerResponse {
  if (format === "html") return launcherPageAnswer(request, context, status, localizedError, extra);
  const answer = refusal(status, code, message);
  return { status: answer.status, headers: { ...answer.headers, ...extra }, body: answer.body };
}

/** The declared `content-length`, or `null` when it is absent or not a number. */
function declaredContentLength(request: Pick<ServerRequest, "headers">): number | null {
  const raw = firstHeaderValue(request, "content-length");
  if (raw === undefined || raw.trim().length === 0) return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : null;
}

/**
 * True when the request itself declares a body (spec §5.1 rule 6) — the ONE implementation, shared
 * with the `node:http` glue that decides whether to read a body at all.
 *
 * The semantics are binding for both callers: a body is declared when the **first** `content-length`
 * value parses as a number greater than `0`, **or** a `transfer-encoding` header is present. The
 * `transfer-encoding` clause is not subordinate to the length: `content-length: 0` *plus*
 * `transfer-encoding: chunked` is a declared (streamed) body, so the glue reads it and the media
 * type gate below must see exactly the same answer. Everything else — no length, `0`, an
 * unparseable length — is "no body".
 */
export function launcherDeclaresBody(request: Pick<ServerRequest, "headers">): boolean {
  const length = declaredContentLength(request);
  if (length !== null && length > 0) return true;
  return firstHeaderValue(request, "transfer-encoding") !== undefined;
}

/** True when a declared body carries a media type other than the form's (spec §5.1 rule 6). */
function refusesMediaType(request: Pick<ServerRequest, "headers">): boolean {
  if (!launcherDeclaresBody(request)) return false;
  const raw = firstHeaderValue(request, "content-type");
  if (raw === undefined) return true;
  const [type, ...params] = raw.split(";");
  if ((type ?? "").trim().toLowerCase() !== LAUNCHER_FORM_TYPE) return true;
  for (const param of params) {
    const [name, ...rest] = param.split("=");
    if ((name ?? "").trim().toLowerCase() !== "charset") continue;
    const value = rest.join("=").trim().replace(/^"(.*)"$/, "$1").toLowerCase();
    if (value !== "utf-8") return true;
  }
  return false;
}

/**
 * True when a `POST` cannot have come from this hub's own page (spec §5.2 rules 4/6): a
 * multi-valued or `null` `Origin`, an `Origin` that does not match the derived basis, or
 * `Sec-Fetch-Site: cross-site`. A **missing** `Origin` is not an attack signal (curl has none).
 */
function refusesCrossSite(request: Pick<ServerRequest, "headers">): boolean {
  const fetchSite = firstHeaderValue(request, "sec-fetch-site");
  if (fetchSite !== undefined && fetchSite.split(",")[0]?.trim().toLowerCase() === "cross-site") {
    return true;
  }
  const origins = headerValues(request, "origin");
  if (origins.length === 0) return false;
  if (origins.length > 1) return true; // several values are not a browser request — never parsed
  const origin = origins[0];
  if (origin === undefined) return false;
  const raw = origin.trim().toLowerCase();
  if (raw === "null") return true; // sandboxed iframe / file:// — never a match
  // An `Origin` is scheme + host + port and nothing else; a path, query, fragment, userinfo or
  // embedded whitespace is refused unparsed (spec §5.2 rule 4).
  const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  if (/[/?#@\s]/.test(withoutScheme)) return true;
  const normalized = normalizeOrigin(raw);
  if (normalized === null) return true;
  const basis = launcherOriginBasis(request);
  return basis === null || normalized !== basis;
}

/**
 * The 413 answer for a body the request itself declared larger than the limit (spec §5.3). Its only
 * caller is `launcherHeadRefusal()`; the glue has no `too_large` branch, because a streamed
 * overshoot is cut off the way `readBody()` does it (no answer at all).
 */
export function launcherTooLargeAnswer(
  request: Pick<ServerRequest, "url" | "headers">,
  context: HandlerContext,
): ServerResponse {
  const strings = launcherStrings(request);
  return launcherErrorAnswer(
    request,
    context,
    413,
    launcherFormat(firstHeaderValue(request, "accept")),
    "payload_too_large",
    strings.launcherBodyTooLarge,
    strings.launcherBodyTooLarge,
    { connection: "close" },
  );
}

/**
 * The header-only half of the launcher — the ONE implementation of the gates in spec §3:
 * `405` (method ∉ {GET, POST}), `503` (viewer origin unresolved), `403` (CSRF gate, POST only),
 * `415` (POST with a declared body, media type ≠ the form type), `413` (declared size over the
 * limit).
 *
 * Reads no body, calls no `verifyOperatorSecret()`, spends no budget, mints nothing. Its answer
 * format comes from `launcherFormat(accept)` itself — with one deliberate exception: the `503`
 * start-window answer (`serviceNotReady()`) is **always** JSON, because it reports a hub state
 * rather than anything a form could fix, so no form is rendered for it. Every answer carries
 * `connection: close`, because no branch has consumed a body.
 *
 * `null` means: the caller may read the body (POST) or check the secret (GET).
 */
export function launcherHeadRefusal(
  request: Pick<ServerRequest, "method" | "url" | "headers">,
  context: HandlerContext,
): ServerResponse | null {
  const format = launcherFormat(firstHeaderValue(request, "accept"));
  const method = (request.method ?? "GET").toUpperCase();

  // 1. Method first: nothing below it (origin, secret, budget) may run for a foreign verb.
  if (method !== "GET" && method !== "POST") {
    return launcherErrorAnswer(
      request,
      context,
      405,
      format,
      "method_not_allowed",
      `${method} is not allowed on ${viewerStartPath(context.base)} — documented method(s): GET, POST`,
      undefined,
      { allow: "GET, POST", connection: "close" },
    );
  }

  // 2. Origin resolved: the start window answers JSON — no form value can fix it.
  const origin = context.viewer?.origin;
  if (context.viewer === undefined || origin === undefined || origin.length === 0) {
    return serviceNotReady();
  }

  if (method === "POST") {
    // 3. CSRF gate before the media type, the size and any read (spec §5.2).
    if (refusesCrossSite(request)) {
      const strings = launcherStrings(request);
      return launcherErrorAnswer(
        request,
        context,
        403,
        format,
        "forbidden_origin",
        strings.launcherForbidden,
        strings.launcherForbidden,
        { connection: "close" },
      );
    }
    // 4. Media type — only for a request that declares a body, so a body-less header POST
    //    (the admin button) passes like a GET with a header.
    if (refusesMediaType(request)) {
      const strings = launcherStrings(request);
      return launcherErrorAnswer(
        request,
        context,
        415,
        format,
        "unsupported_media_type",
        strings.launcherUnsupportedBody,
        strings.launcherUnsupportedBody,
        { connection: "close" },
      );
    }
    // 5. Declared size: answer before the body is read. A streamed overshoot is not handled here.
    const declared = declaredContentLength(request);
    if (declared !== null && declared > VIEWER_LAUNCHER_MAX_BODY_BYTES) {
      return launcherTooLargeAnswer(request, context);
    }
  }

  return null;
}

/**
 * The hub-side launcher: operator secret → one-time ticket → `302`/`303` onto the viewer origin,
 * or the form page / `{"url": …}` for the two browser paths (spec §5.1 rule 2, §3).
 *
 * Only the **hub** surface owns this route; the viewer surface answers `null` so its own refusal
 * stands. The gate order is `launcherHeadRefusal()`'s, then secret, then one mint. `?k=` is read on
 * `GET` only: a `POST` never reads and never compares it (§2.5 rule 3).
 */
export function handleViewerStart(
  request: ServerRequest,
  context: HandlerContext,
): ServerResponse | null {
  const viewer = context.viewer;
  if (viewer === undefined) return null;
  if (surfaceOf(context) !== "hub") return null;
  if (!isViewerStartRequest(request.url ?? "/", context)) return null;

  const method = (request.method ?? "GET").toUpperCase();
  const format = launcherFormat(firstHeaderValue(request, "accept"));

  // Defense in depth: the glue runs the same gates before it reads a body (§5.3 rule 8).
  const head = launcherHeadRefusal(request, context);
  if (head !== null) return head;

  // Secret extraction. The header always wins; `?k=` is a GET-only compatibility path.
  const header = firstHeaderValue(request, ADMIN_HEADER);
  const url = new URL(request.url ?? "/", "http://hub.invalid");
  const presented =
    header !== undefined
      ? header
      : method === "POST"
        ? launcherSecretFromBody(request.body)
        : (url.searchParams.get("k") ?? undefined);

  // A browser without a secret gets the page — and spends no budget, because nothing was guessed.
  if (
    (presented === undefined || presented === "") &&
    format === "html" &&
    method === "GET"
  ) {
    return launcherPageAnswer(request, context, 200);
  }

  const verdict = verifyOperatorSecret(request, context, presented);

  if (verdict.kind === "throttled") {
    const seconds = verdict.retryAfterSeconds;
    if (format === "html") {
      return launcherPageAnswer(
        request,
        context,
        429,
        fillTemplate(launcherStrings(request).launcherThrottled, { seconds }),
        { "retry-after": String(seconds) },
      );
    }
    return {
      status: 429,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": String(seconds),
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
    if (format === "html") {
      return launcherPageAnswer(request, context, 401, launcherStrings(request).launcherInvalidSecret);
    }
    return refusal(401, "unauthorized", LAUNCHER_INVALID_MESSAGE);
  }

  if (viewer.tickets === undefined) return serviceNotReady();
  const origin = viewer.origin;
  if (origin === undefined || origin.length === 0) return serviceNotReady();

  // Exactly one mint, and one local computation of the destination (spec §5.1 rule 2 step 9).
  const ticket = viewer.tickets.mint().ticket;
  const location = `${origin.replace(/\/+$/, "")}${context.base.replace(/\/+$/, "")}/viewer?ticket=${ticket}`;

  if (method === "POST" && format === "json") {
    // 200, not 303: `fetch` follows a redirect opaquely, so the JSON path hands the URL over as
    // data and the page navigates once (§5.4).
    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      body: JSON.stringify({ url: location }),
    };
  }

  return {
    status: method === "POST" ? 303 : 302,
    headers: {
      location,
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
