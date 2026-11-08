/**
 * bluepencil hub — process glue (FR-17 §3, the M2 `server/` deliverable).
 *
 * `server/index.ts` is the build entry point and stays thin (argv → `main()`); everything that
 * touches the operating system lives here, so the hub can grow federation wiring (FR-6.15,
 * FR-16.14) without turning the entry point into a second implementation.
 *
 * The hub is the reference implementation of the HTTP contract the built-in `http` adapter
 * speaks (ARCHITECTURE §5, docs/INTEGRATION.md §5). One dependency-free process serves
 *   * the notes API under `--base` (default `/api/v1/bluepencil`, exactly the path the built-in
 *     `adapter: "http"` default expects) and
 *   * with `--root`, a static directory on the same origin with an `index.html` fallback, so a
 *     presentation page and the API live behind one port (and one firewall rule).
 *
 * Layout: `server/handler.ts` is the pure half (routing, validation, canonical output, no I/O).
 * This module owns everything that touches the operating system:
 *   * the store file — canonical bundle JSON, written atomically (temp file in the target
 *     directory, `rename`, and the temp file removed in `finally`, the same pattern as the CLI);
 *     the in-memory set is the source of truth while the process runs and is reloaded from disk at
 *     startup. A corrupt store file is NEVER served as an empty set: the process refuses to start
 *     with a one-line error (exit 2), because "my notes are gone" is the worst answer to a typo;
 *   * the optional Markdown mirror (`src/core/export/markdown`), written next to the store;
 *   * `node:http`, the body reader (bounded), the static file server and the CLI parsing.
 *
 * Safety defaults (contract §3): bind `127.0.0.1`, no CORS header unless `--cors` is given,
 * `--read-only` available for a presentation that must not change anything. Everything about
 * notes is delegated to `src/core/**` + `src/data/**` through the handler (FR-15.3); this file
 * adds no note logic of its own.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse as NodeResponse,
} from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { hostname as osHostname } from "node:os";
import { booleanFlag } from "../src/argv";
import { isRecord } from "../src/core/adapter";
import { toMarkdown } from "../src/core/export/markdown";
import {
  BUNDLE_KIND,
  DEFAULT_ENVIRONMENT,
  ENVIRONMENTS,
  isEnvironment,
  type Environment,
  type Note,
} from "../src/core/model";
import { bundleToJson, createBundle } from "../src/data/bundle";
import { migrateBundle } from "../src/data/migrate";
import { assertBundle } from "../src/data/schema";
import { errorText, oneLine } from "./text";
import {
  DEFAULT_BASE_PATH,
  JSON_CONTENT_TYPE,
  SERVER_VERSION,
  HUB_APP_NAME,
  HUB_EXPORTED_BY,
  THROTTLE_BUDGETS,
  authorize,
  corsHeaders,
  errorBody,
  gateRequest,
  handleRequest,
  hostRefusal,
  hubViewerPathRefusal,
  isApiPath,
  isLoopbackAddress,
  normalizeBase,
  preflightResponse,
  publicError,
  requestPath,
  surfaceOf,
  viewerSurfaceRefusal,
  type AdminThrottle,
  type HandlerContext,
  type NoteStoreState,
  type ServerErrorCode,
  type ServerRequest,
  type ServerResponse,
  type ThrottleKind,
  type MutationEvent,
} from "./handler";
import { CORS_WILDCARD_WARNING, corsOriginPolicy } from "./cors";
import { writeAtomic } from "./atomic-write";
import {
  credentialMode,
  SECRET_MIN_LENGTH,
  TOKEN_KEY_MIN_LENGTH,
  type CredentialMode,
} from "./credentials";
import { asHandlerVerifier, createTokenIssuer } from "./tokens";
// The admin surface's device registry lives next to the store; the page itself is only a route.
import { devicesPathFor } from "./admin";
import {
  createViewerSessions,
  createViewerTickets,
  DEFAULT_VIEWER_TTL_SECONDS,
  handleViewer,
  handleViewerStart,
  isViewerRequest,
  isViewerStartRequest,
  launcherDeclaresBody,
  launcherHeadRefusal,
  MAX_VIEWER_TTL_SECONDS,
  VIEWER_LAUNCHER_MAX_BODY_BYTES,
  type ViewerOptions,
} from "./viewer";
import { createPresence } from "./presence";
import { selectJournal, type Journal, type JournalRecord, type JournalStatus } from "./journal";
import { handleMcpRoute, type McpBackendFactoryInput } from "./mcp";
import { createStoreBackend, type McpBackend } from "../src/mcp/backend";
import { createFederatedBackend, type SelfSource } from "../src/federation/backend";
import { InstanceClient } from "../src/federation/client";
import { FederationError } from "../src/federation/errors";
import {
  loadRegistry,
  RegistryError,
  REGISTRY_DEFAULT_CONCURRENCY,
  REGISTRY_DEFAULT_LIMIT,
  REGISTRY_DEFAULT_TIMEOUT_MS,
  REGISTRY_MAX_TIMEOUT_MS,
  type ResolvedRegistry,
} from "../src/federation/registry";

/** Bind/port defaults: loopback only, and the port the contract documents. */
export const DEFAULT_PORT = 8787;
export const DEFAULT_HOST = "127.0.0.1";

/** Request bodies above this are aborted (socket destroyed), never buffered or drained (SEC-08). */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/* The credential floors live in `server/credentials.ts` next to the rest of the credential policy,
 * and are re-exported here because this is where the CLI contract documents them (contract §3.4 D).
 * One definition, two import paths — `server/mint-cli.ts` must not pull the hub in for a number. */
export { SECRET_MIN_LENGTH, TOKEN_KEY_MIN_LENGTH } from "./credentials";

/** A start-up safety warning. `code` is stable; `message` is what an operator reads on stderr. */
export interface StartupWarning {
  code:
    | "unauthenticated_non_loopback"
    | "cors_wildcard"
    | "viewer_cookie_shared_host"
    | "viewer_non_loopback_insecure"
    | "viewer_public_url_deprecated";
  message: string;
}

/**
 * True when `--host` names an address only this machine can reach (G1).
 *
 * This is deliberately the *bind* question, not a request question: `--host localhost` binds `::1`,
 * `--host 0.0.0.0` binds every interface, and the two mean opposite things for a hub without a
 * credential. `""` is not a loopback spelling — `listen(port, "")` binds the unspecified address.
 */
export function isLoopbackBind(host: string): boolean {
  return isLoopbackAddress(host.trim());
}

const WILDCARD_BINDS: ReadonlySet<string> = new Set(["", "0.0.0.0", "::", "[::]"]);

/**
 * The **one** definition of a wildcard (unspecified) bind address (spec §2.4).
 *
 * `""` is included on purpose: it is not an empty host, it is the spelling `listen()` turns into
 * "every interface". Applied only to an **resolved** bind address (`viewer.host ?? host ??
 * DEFAULT_HOST`), never to `undefined` as "the flag is absent". No origin may ever be derived from
 * a `true` address — `http://0.0.0.0:<port>` and `http://[::]:<port>` are not reachable origins.
 */
export function isWildcardBind(address: string): boolean {
  return WILDCARD_BINDS.has(address.trim());
}

/** The stable diagnosis of a start that must not serve (spec §2.4, AC-F20/AC-F23). */
export type HubStartupErrorCode =
  | "viewer_origin_required"
  | "viewer_origin_is_hub_origin"
  | "cors_viewer_origin"
  | "cors_wildcard_with_viewer"
  | "viewer_origin_invalid"
  | "viewer_ttl_invalid";

/**
 * A start-up failure raised by `resolveOptions()`/`startHub()` before anything is served.
 *
 * Unlike a `parseHubArgs` usage string this is thrown: the programmatic path has no stdout to write
 * a one-liner to, and the caller has to be able to react to the {@link HubStartupErrorCode}.
 */
export class HubStartupError extends Error {
  readonly code: HubStartupErrorCode;

  constructor(code: HubStartupErrorCode, message: string) {
    super(message);
    this.name = "HubStartupError";
    this.code = code;
  }
}

/** A bind address reduced to the spelling two flags have to agree on (`[::1]` vs `::1`). */
function normalizeBind(address: string): string {
  const trimmed = address.trim().toLowerCase();
  return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
}

/**
 * True when two bind addresses denote the **same socket** (spec §5.2, F-04).
 *
 * Spelling equality alone is not enough: `""`, `0.0.0.0`, `::` and `[::]` all mean "the
 * unspecified address", so `--host 0.0.0.0 --viewer-host ""` would collide at `listen()` time
 * (the second bind fails with `EADDRINUSE`) even though the two strings differ. The wildcard
 * question is answered by {@link isWildcardBind}, the one definition of that set; everything else
 * is compared by spelling.
 */
function sameBind(a: string, b: string): boolean {
  if (isWildcardBind(a) && isWildcardBind(b)) return true;
  return normalizeBind(a) === normalizeBind(b);
}

/**
 * The **one** origin comparison form (spec §2.4 rule 5): scheme and host lower-cased, default port
 * removed, no userinfo, no path/query/fragment. `null` means "not an absolute http(s) origin".
 *
 * A trailing `/` is the empty path and is accepted (it is what a browser prints for an origin);
 * anything else in the path is a configuration error, because the viewer's links and cookies are
 * built by appending `base` to this value.
 */
function normalizeOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  if (url.search !== "" || url.hash !== "") return null;
  const host = url.hostname.toLowerCase();
  if (host === "") return null;
  return `${url.protocol}//${host}${url.port === "" ? "" : `:${url.port}`}`;
}

/** Hostname of an already normalised origin, without brackets/port — for the shared-host warning. */
function originHostname(origin: string): string | null {
  const normalized = normalizeOrigin(origin);
  if (normalized === null) return null;
  const parsed = new URL(normalized);
  const host = parsed.hostname.toLowerCase();
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * The warnings a hub start owes its operator (G1, SEC-01/SEC-10, ADR-0.12-S1).
 *
 * Pure on purpose: the decision is testable without a socket, and the process only has to print the
 * list. A non-loopback bind without a client credential is **allowed** (refusing it would break
 * every existing LAN/lab setup with no migration path) but never silent — see
 * {@link startHub}, which writes these before any `--quiet` check, because a warning an operator can
 * switch off is not a warning. The CORS wildcard is reported the same way; a hub that has no
 * credential cannot reach this point through the CLI (`--cors '*'` is refused at parse time), so a
 * `cors_wildcard` here always means "spelled out and gated".
 */
export function startupWarnings(input: {
  readonly host: string;
  readonly credential: CredentialMode;
  readonly cors: string | null;
  /**
   * The resolved viewer, when configured. `host` is the viewer *bind* address, `origin` the public
   * origin a browser sees, and `usedPublicUrlAlias` whether the deprecated `--viewer-public-url`
   * spelling was given (it stays a warning for one release period).
   */
  readonly viewer?: {
    readonly host: string;
    readonly origin: string;
    readonly usedPublicUrlAlias: boolean;
  };
}): StartupWarning[] {
  const warnings: StartupWarning[] = [];
  if (!isLoopbackBind(input.host) && input.credential === "none") {
    warnings.push({
      code: "unauthenticated_non_loopback",
      message:
        `WARNING (unauthenticated_non_loopback): this hub is bound to ${input.host || "every interface"} ` +
        "and accepts requests without a credential, so notes, the journal location and the author " +
        "identity are readable by anyone who can reach the port. Set --auth-secret or --token-key. " +
        "This warning is not suppressed by --quiet.",
    });
  }
  if (input.cors === "*") {
    // The same constant `corsOriginPolicy` returns, so the line an operator reads cannot drift from
    // the warning the policy carries.
    warnings.push({
      code: CORS_WILDCARD_WARNING.code,
      message: CORS_WILDCARD_WARNING.message,
    });
  }
  if (input.viewer !== undefined) {
    const viewerHostname = originHostname(input.viewer.origin);
    /* §4.7: the cookie is not port-isolated. With a concrete hub bind the two host names decide;
     * a wildcard hub bind answers under *any* name, so it shares the cookie with every non-loopback
     * viewer name. */
    const sharedHost =
      viewerHostname === null
        ? false
        : isWildcardBind(input.host)
          ? !isLoopbackBind(viewerHostname)
          : normalizeBind(input.host) === viewerHostname;
    if (sharedHost) {
      warnings.push({
        code: "viewer_cookie_shared_host",
        message:
          `WARNING (viewer_cookie_shared_host): the viewer shares its host name with the hub ` +
          `(hub bind ${input.host || "every interface"}, viewer origin ${input.viewer.origin}). ` +
          "The bp_viewer cookie is not port-isolated, so the hub port receives it too (and ignores " +
          "it). Prefer a dedicated viewer host name. This warning is not suppressed by --quiet.",
      });
    }
    if (
      !isLoopbackBind(input.viewer.host) &&
      (normalizeOrigin(input.viewer.origin) ?? input.viewer.origin).startsWith("http://")
    ) {
      warnings.push({
        code: "viewer_non_loopback_insecure",
        message:
          `WARNING (viewer_non_loopback_insecure): the viewer is bound to ${input.viewer.host || "every interface"} ` +
          `and its origin is plain http (${input.viewer.origin}), so the session cookie and every ` +
          "note travel unencrypted. Terminate TLS in front of it or use an https viewer origin. " +
          "This warning is not suppressed by --quiet.",
      });
    }
    if (input.viewer.usedPublicUrlAlias) {
      warnings.push({
        code: "viewer_public_url_deprecated",
        message:
          "WARNING (viewer_public_url_deprecated): --viewer-public-url is a deprecated alias for " +
          "--viewer-origin and will be removed in the next release. Rename the flag. " +
          "This warning is not suppressed by --quiet.",
      });
    }
  }
  return warnings;
}

/** Raised when the store file exists but is not a valid note set — never treated as "no notes". */
export class StoreFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreFileError";
  }
}

/** Where the viewer's second listener binds and which origin it advertises (spec §2.4). */
export interface ViewerListenOptions {
  /**
   * Bind address; defaults to the resolved hub bind address (`viewer.host ?? host ?? DEFAULT_HOST`).
   * A wildcard value — including one inherited from `--host` — makes `origin` mandatory.
   */
  host?: string;
  /** Required whenever the viewer is configured; 0..65535, `0` (ephemeral) allowed. */
  port: number;
  /** Public origin; defaults to the bind address plus the actual port, never from a wildcard. */
  origin?: string;
}

export interface ServerOptions {
  /** Canonical bundle JSON the hub reads at startup and writes on every mutation. */
  storePath: string;
  port?: number;
  host?: string;
  base?: string;
  /** Static directory served with an `index.html` fallback (`--root`). */
  root?: string;
  environment?: Environment;
  readOnly?: boolean;
  /**
   * Shared secret required in the `x-bluepencil-auth` header on every request (#36).
   *
   * The flag takes it directly; the environment variable is the safer one, because a secret on a
   * command line is visible in the process list to every other user on the machine. Both are read,
   * the flag winning.
   */
  authSecret?: string;
  /**
   * HMAC key for signed per-device tokens (`--token-key`, `BLUEPENCIL_TOKEN_KEY`) (#36, phase 2).
   *
   * Never given to a client. The hub signs a token and hands it out; the client presents it and
   * cannot re-sign it, which is what makes a token revocable in a way a shared secret is not. Because
   * it is sensitive, the environment variable is the better of the two ways to set it — a value on a
   * command line is visible in the process list to every other user on the machine.
   */
  tokenKey?: string;
  /** Lifetime of newly issued tokens in seconds (`--token-ttl`); the issuer's own default applies when unset. */
  tokenTtlSeconds?: number;
  /** Token ids to refuse (`--revoked-tokens`); loaded from that file at startup. */
  revokedTokens?: ReadonlySet<string>;
  /** Where the revocation list was read from, so a startup log can name it. */
  revokedPath?: string;
  /**
   * The admin surface's credential (`--admin-secret`). Its own switch, not a second auth mode:
   * unset, the page and its routes do not exist at all — the only defensible default for a surface
   * that mints credentials.
   */
  adminSecret?: string;
  /**
   * The viewer (`--viewer`): serve a website from its own origin with the layer injected, and hand
   * out the bookmarklet artifact. Off unless configured — and then only with a second listener
   * (`port`), an allowlist, an operator credential and the directory holding the built layer,
   * because the hub fetches server-side.
   */
  viewer?: ViewerListenOptions & {
    /** Directory with the built element bundles (`dist`). */
    assetsDir: string;
    /** Hosts that may be fetched (`example.com`, `*.example.com`). */
    allow: readonly string[];
    /** Session lifetime in seconds (60..604800, also checked programmatically). */
    ttlSeconds: number;
    /** @deprecated 0.13.0 input alias, normalised onto `origin`; warns for one release period. */
    publicBaseUrl?: string;
  };
  allowEnvMismatch?: boolean;
  /** Optional Markdown mirror of the note set (`--mirror`). */
  mirror?: string;
  /**
   * Name the hub reports over `GET {base}/config` (`--name`), so a client can offer a readable entry
   * — "Unraid" instead of `c9da11460bfc`. Defaults to the machine's hostname (FR-6.10).
   */
  name?: string;
  /** Allowed CORS origin (`--cors <origin|*>`); unset means no CORS header at all. */
  cors?: string;
  quiet?: boolean;
  appName?: string;
  exportedBy?: string;
  /**
   * Store journal backend (FR-18). `auto` (default) picks `git` when the store lives in a work tree
   * and `file` otherwise; `none` switches the history off on purpose.
   */
  journal?: "auto" | "git" | "file" | "none";
  /** Directory of the journal file (`--journal-dir`); defaults to the store's directory. */
  journalDir?: string;
  /** Repository root of the `git` backend (`--journal-repo`); defaults to the store's directory. */
  journalRepo?: string;
  /** Milliseconds a `git` commit waits for more changes (`--journal-coalesce`, default 2000). */
  journalCoalesceMs?: number;
  /** `Name <mail>` used for the journal commits (`--journal-author`). */
  journalAuthor?: string;
  /** Commit subject template (`--journal-subject`): `{count}`, `{op}`, `{actor}`, `{app}` are substituted. */
  journalSubject?: string;
  /** Injectable clock, so tests are deterministic (NFR-17). */
  now?: () => string;
}

/**
 * Hub options: the local hub (FR-17) plus the federation knobs the hub grows in 0.10
 * (FR-6.15/FR-16.14). They are parsed and carried now so the `/config` contract and the CLI are
 * stable before the federated `/mcp` backend is wired in the next step.
 */
export interface HubOptions extends ServerOptions {
  /** `--registry` / `BLUEPENCIL_REGISTRY`: a registry file makes `/mcp` an aggregate in 5b. */
  registry?: string;
  /** `--include-self` / `--no-self` (default: the registry's `defaults.includeSelf`). */
  includeSelf?: boolean;
  /** `--allow-write`: the second lock for federated writes; default false. */
  allowWrite?: boolean;
  /** `--allow-insecure`: pass-through for the registry URL policy; default false. */
  allowInsecure?: boolean;
  /** `--timeout`: aggregate read timeout in milliseconds (default 3000). */
  timeoutMs?: number;
  /** `--concurrency`: parallel instance reads, 1..16 (default 8). */
  concurrency?: number;
  /** `--limit`: maximum notes in an aggregate, 1..1000 (default 200). */
  limit?: number;
}

/**
 * The viewer options **after** `resolveOptions()` (spec §2.4 rule 1, F-07).
 *
 * `host`/`port` are the resolved *bind* pair (`viewer.host ?? host ?? DEFAULT_HOST` and the
 * configured viewer port, `0` when ephemeral). They live next to the `ViewerOptions` fields
 * because `startHub()` needs them for the second listener; the handler only ever reads the
 * `ViewerOptions` half.
 */
interface ResolvedViewer extends ViewerOptions {
  readonly host: string;
  readonly port: number;
}

interface ResolvedOptions {
  storePath: string;
  port: number;
  host: string;
  base: string;
  root: string | undefined;
  environment: Environment;
  readOnly: boolean;
  allowEnvMismatch: boolean;
  /** Phase 1's shared secret, and phase 2's signing key — alternatives, both settable. */
  authSecret: string | undefined;
  tokenKey: string | undefined;
  tokenTtlSeconds: number | undefined;
  revokedTokens: ReadonlySet<string> | undefined;
  revokedPath: string | undefined;
  adminSecret: string | undefined;
  viewer: ResolvedViewer | undefined;
  mirror: string | undefined;
  cors: string | undefined;
  quiet: boolean;
  appName: string;
  exportedBy: string;
  journal: "auto" | "git" | "file" | "none";
  journalDir: string | undefined;
  journalRepo: string | undefined;
  journalCoalesceMs: number | undefined;
  journalAuthor: string | undefined;
  journalSubject: string | undefined;
  now: (() => string) | undefined;
  registry: string | undefined;
  includeSelf: boolean | undefined;
  allowWrite: boolean;
  allowInsecure: boolean;
  /** `undefined` means "not given on the command line" — the registry defaults then apply. */
  timeoutMs: number | undefined;
  concurrency: number | undefined;
  limit: number | undefined;
}

/**
 * Builds the one `ViewerOptions` instance a start will ever have (spec §2.4 rule 1, F-07).
 *
 * Everything the second listener and the viewer door need is wired here **once**:
 * `sessions`/`tickets` (never re-created per require), the normalised explicit `origin` (with the
 * deprecated `publicBaseUrl` alias folded into it), the resolved bind `host`/`port` and the host
 * gate aliases derived from an explicit origin. Two checks also run here, before any socket exists:
 *
 * - `ttlSeconds` is the session lifetime and is bounded programmatically (`60..604800`), not only
 *   by `parseHubArgs`, because an embedding caller never sees the CLI;
 * - a wildcard (**resolved**) bind without an explicit origin is `viewer_origin_required` — no
 *   origin is ever derived from `""`, `0.0.0.0`, `::` or `[::]`, and `port: 0` changes nothing
 *   about the obligation.
 *
 * Failures are `HubStartupError`s and are raised before `activeJournal` is touched (spec §2.4
 * rule 5), so a refused start leaves a previous process state alone.
 */
function resolveViewerOptions(options: HubOptions): ResolvedViewer | undefined {
  const input = options.viewer;
  if (input === undefined) return undefined;

  if (
    !Number.isInteger(input.ttlSeconds) ||
    input.ttlSeconds < 60 ||
    input.ttlSeconds > MAX_VIEWER_TTL_SECONDS
  ) {
    throw new HubStartupError(
      "viewer_ttl_invalid",
      `the viewer session lifetime must be an integer between 60 and ${MAX_VIEWER_TTL_SECONDS} seconds ` +
        `(got ${JSON.stringify(input.ttlSeconds)})`,
    );
  }

  // `origin` wins over the deprecated alias (S2), but both are validated with the same rules and
  // the alias is kept as a marker so `startHub()` can warn for one release period.
  const originInput = input.origin ?? input.publicBaseUrl;
  let origin: string | undefined;
  if (originInput !== undefined) {
    const normalized = normalizeOrigin(originInput);
    if (normalized === null) {
      throw new HubStartupError(
        "viewer_origin_invalid",
        `the viewer origin ${JSON.stringify(originInput)} must be an absolute http(s) origin without ` +
          "path, query or fragment",
      );
    }
    origin = normalized;
  }

  // The obligation follows the **resolved** bind, including a wildcard inherited from `--host`
  // (spec §2.4 rule 1, AC-F6/AC-F23).
  const host = input.host ?? options.host ?? DEFAULT_HOST;
  if (isWildcardBind(host) && origin === undefined) {
    throw new HubStartupError(
      "viewer_origin_required",
      `the viewer is bound to a wildcard address (${JSON.stringify(host)}) and has no explicit origin — ` +
        "set one; an origin is never derived from 0.0.0.0 or [::]",
    );
  }

  // A loopback-bound viewer is reached under its configured public name; that name has to pass the
  // Host gate, which only knows loopback spellings (AC-5.23).
  const originName = origin === undefined ? undefined : originHostname(origin);
  const hostAliases = originName === undefined || originName === null ? undefined : [originName];

  return {
    assetsDir: input.assetsDir,
    allow: input.allow,
    ttlSeconds: input.ttlSeconds,
    origin,
    ...(input.publicBaseUrl === undefined ? {} : { publicBaseUrl: origin }),
    host,
    port: input.port,
    hostAliases,
    // Exactly once per start: the sessions and launcher tickets are process state, never
    // re-created per request (spec §2.4 rules 1/2).
    sessions: createViewerSessions(input.ttlSeconds),
    tickets: createViewerTickets(),
  };
}

function resolveOptions(options: HubOptions): ResolvedOptions {
  return {
    storePath: options.storePath,
    port: options.port ?? DEFAULT_PORT,
    host: options.host ?? DEFAULT_HOST,
    base: normalizeBase(options.base ?? DEFAULT_BASE_PATH),
    root: options.root === undefined ? undefined : resolve(options.root),
    environment: options.environment ?? DEFAULT_ENVIRONMENT,
    readOnly: options.readOnly ?? false,
    allowEnvMismatch: options.allowEnvMismatch ?? false,
    authSecret: options.authSecret,
    // R2-F1: an empty string is not a configured operator secret. Normalise it to `undefined` so a
    // programmatic `startHub({ adminSecret: "" })` behaves exactly like a hub without an admin
    // surface: `/admin/*` is 404 and the launcher answers `401 unauthorized` without spending the
    // `admin` budget. `parseHubArgs()` already refuses an empty `--admin-secret`; this closes the
    // programmatic path that bypasses it.
    adminSecret:
      options.adminSecret === undefined || options.adminSecret.length === 0
        ? undefined
        : options.adminSecret,
    viewer: resolveViewerOptions(options),
    tokenKey: options.tokenKey,
    tokenTtlSeconds: options.tokenTtlSeconds,
    revokedTokens: options.revokedTokens,
    revokedPath: options.revokedPath,
    mirror: options.mirror,
    cors: options.cors,
    quiet: options.quiet ?? false,
    appName: options.appName ?? HUB_APP_NAME,
    exportedBy: options.exportedBy ?? HUB_EXPORTED_BY,
    journal: options.journal ?? "auto",
    journalDir: options.journalDir,
    journalRepo: options.journalRepo,
    journalCoalesceMs: options.journalCoalesceMs,
    journalAuthor: options.journalAuthor,
    journalSubject: options.journalSubject,
    now: options.now,
    registry: options.registry,
    includeSelf: options.includeSelf,
    allowWrite: options.allowWrite ?? false,
    allowInsecure: options.allowInsecure ?? false,
    timeoutMs: options.timeoutMs,
    concurrency: options.concurrency,
    limit: options.limit,
  };
}

/* ------------------------------------------------------------------------------------------------
 * The store file
 * ---------------------------------------------------------------------------------------------- */

/** Reads a file, or `null` when it does not exist; any other I/O failure is escalated. */
function readTextIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new StoreFileError(`cannot read ${path}: ${errorText(error)}`);
  }
}

/**
 * Parses a store file into notes (FR-6.5/F9, the read path the CLI documents):
 *   * a file that does not exist is the documented empty start;
 *   * a *current* document (one carrying `schemaVersion`) is validated exactly as written —
 *     an unknown enum, an empty body or a missing field refuses the start;
 *   * a legacy document (no `schemaVersion`, or a bare `Note[]`) goes through the shared
 *     migration (`src/data/migrate`), which never mutates the file.
 * Anything else — unparseable JSON, an empty file or a document that is not a note set at all —
 * raises `StoreFileError` and the process refuses to start.
 */
export function parseNoteSet(text: string | null, path: string): Note[] {
  if (text === null) return [];
  if (text.trim() === "") {
    throw new StoreFileError(`${path} is not a valid note set: the file is empty`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new StoreFileError(`${path} is not a valid note set: the file is not valid JSON (${errorText(error)})`);
  }
  const record = isRecord(parsed) ? parsed : null;
  const looksLikeNoteSet =
    Array.isArray(parsed) || (record !== null && (Array.isArray(record.notes) || record.kind === BUNDLE_KIND));
  if (!looksLikeNoteSet) {
    throw new StoreFileError(
      `${path} is not a valid note set: expected a bluepencil bundle (kind "${BUNDLE_KIND}") or an array of notes`,
    );
  }
  const legacy = record === null || record.schemaVersion === undefined || record.schemaVersion === null;
  try {
    return legacy ? migrateBundle(parsed).notes : assertBundle(parsed).notes;
  } catch (error) {
    throw new StoreFileError(`${path} is not a valid note set: ${errorText(error)}`);
  }
}

/** The notes of a store file, or `[]` for a file that does not exist yet. */
export function loadNotes(path: string): Note[] {
  return parseNoteSet(readTextIfExists(path), path);
}

export interface FileNoteStore {
  /** The in-memory set — the source of truth while the process runs. */
  state: NoteStoreState;
  /** Canonical bundle text of a state (default: the current one), the form written to disk. */
  bundleText(state?: NoteStoreState): string;
  /** Markdown mirror text, or `null` when no `--mirror` was configured. */
  mirrorText(state?: NoteStoreState): string | null;
  /** Writes the store (and the mirror) atomically; throws when the write fails. */
  persist(state?: NoteStoreState): void;
}

/**
 * Builds the file-backed store: the store file is read (and validated) *now*, so a corrupt file
 * stops the process before the first byte is served.
 */
export function createFileStore(options: {
  storePath: string;
  mirror?: string;
  environment: Environment;
  appName?: string;
  exportedBy?: string;
  now?: () => string;
}): FileNoteStore {
  const state: NoteStoreState = { notes: loadNotes(options.storePath) };
  const appName = options.appName ?? HUB_APP_NAME;

  const bundleText = (current: NoteStoreState): string =>
    bundleToJson(
      createBundle(current.notes, {
        environment: options.environment,
        app: { name: appName },
        exportedBy: options.exportedBy ?? HUB_EXPORTED_BY,
        ...(options.now !== undefined ? { now: options.now() } : {}),
      }),
      { pretty: true },
    );

  return {
    state,
    bundleText: (current: NoteStoreState = state) => bundleText(current),
    mirrorText: (current: NoteStoreState = state) =>
      options.mirror === undefined
        ? null
        : toMarkdown(current.notes, { includeDone: true, title: `${appName} review notes` }),
    persist: (current: NoteStoreState = state) => {
      writeAtomic(options.storePath, bundleText(current));
      if (options.mirror !== undefined) {
        writeAtomic(options.mirror, toMarkdown(current.notes, { includeDone: true, title: `${appName} review notes` }));
      }
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * Static files (`--root`)
 * ---------------------------------------------------------------------------------------------- */

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".wasm": "application/wasm",
};

function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** True when `candidate` is the root itself or below it — never outside (path traversal). */
function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/**
 * The file to serve for a request path: the path itself, its `index.html`, or the root
 * `index.html` — the documented fallback that lets one origin serve a presentation page and the
 * API (a SPA route such as `/slate` resolves to `/index.html`).
 */
function findStaticFile(root: string, relative: string): string | null {
  const resolved = resolve(root, relative.replace(/^\/+/, ""));
  if (!isInside(root, resolved)) return null;
  for (const candidate of [resolved, join(resolved, "index.html"), join(root, "index.html")]) {
    if (!isInside(root, candidate)) continue;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not there (or not readable) — keep looking.
    }
  }
  return null;
}

/* ------------------------------------------------------------------------------------------------
 * node:http glue
 * ---------------------------------------------------------------------------------------------- */

/** The few bytes `node:http` needs; the handler's `ServerResponse` is a superset of this. */
interface GlueResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
}

function write(response: NodeResponse, result: GlueResponse): void {
  response.writeHead(result.status, result.headers);
  response.end(result.body);
}

/** The documented error shape, for the answers the glue itself produces (static 404/405, read errors). */
function glueError(
  status: number,
  code: ServerErrorCode,
  message: string,
  options: ResolvedOptions,
): GlueResponse {
  return {
    status,
    headers: { "content-type": JSON_CONTENT_TYPE, ...corsHeaders(options.cors) },
    body: errorBody(code, message),
  };
}

class BodyTooLargeError extends Error {}

/**
 * Reads the request body with a hard limit, so a huge payload cannot exhaust the process.
 *
 * SEC-08: once the body is known to exceed the limit — from `content-length` or from the streamed
 * size — the request is **destroyed**, not drained to its end. Draining means the hub keeps
 * reading bytes it has already refused, which on a slow client is exactly the cheap flood the
 * limit exists to stop. There is no 413 for this case: a destroyed socket cannot carry a response,
 * and the documented behaviour of this hub is that an over-limit request is cut off.
 */
function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const declared = Number(request.headers["content-length"] ?? NaN);
    if (Number.isFinite(declared) && declared > limit) {
      rejectPromise(new BodyTooLargeError(`the request body exceeds ${limit} bytes`));
      request.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        rejectPromise(new BodyTooLargeError(`the request body exceeds ${limit} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!tooLarge) resolvePromise(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", (error: unknown) => {
      if (!tooLarge) rejectPromise(error);
    });
  });
}

function serveStatic(url: string, method: string, options: ResolvedOptions, response: NodeResponse): void {
  const pathname = requestPath(url);
  // The static site answers its own preflight through the shared helper; `GET, HEAD, OPTIONS` is the
  // documented pair, so the answer does not advertise the notes API's `POST`/`PATCH`.
  const preflight = preflightResponse(method, options, ["GET", "HEAD"]);
  if (preflight !== null) {
    write(response, preflight);
    return;
  }
  if (method !== "GET" && method !== "HEAD") {
    const refusal = glueError(
      405,
      "method_not_allowed",
      `${method} is not allowed on ${pathname} — documented method(s): GET, HEAD`,
      options,
    );
    refusal.headers.allow = "GET, HEAD";
    write(response, refusal);
    return;
  }
  let relative: string;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    relative = pathname;
  }
  const root = options.root ?? ".";
  const file = findStaticFile(root, relative);
  if (file === null) {
    write(response, {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", ...corsHeaders(options.cors) },
      body: "not found\n",
    });
    return;
  }
  let body: Buffer;
  try {
    body = readFileSync(file);
  } catch (error) {
    /* SEC-09 (AC-D10): the answer is the fixed pair, never the fs text — a Node fs error names the
     * absolute path, and this used to be echoed into the body. The detail is for the operator only,
     * on stderr, with the same `internal_error:` prefix `publicError` uses for unexpected failures. */
    process.stderr.write(`bluepencil server: internal_error: ${oneLine(errorText(error))}\n`);
    write(response, glueError(500, "internal_error", "internal error", options));
    return;
  }
  write(response, {
    status: 200,
    headers: {
      "content-type": contentTypeOf(file),
      "content-length": String(body.byteLength),
      ...corsHeaders(options.cors),
    },
    body,
  });
}

/** The journal changes are flushed on a signal, so a `git` batch is not lost to a shutdown. */
let activeJournal: Journal | null = null;

/** Flushes the active journal, if any — used by the entry point's signal handlers (FR-18). */
export function flushHubJournal(): void {
  activeJournal?.flush();
}

/**
 * The journal's one-line summary of a mutation: what happened, to which note, and how many notes the
 * set holds now — the shape the presentation page's own server already used for its commits (FR-18).
 */
function describeMutation(state: NoteStoreState, event: MutationEvent | undefined): JournalRecord {
  const op = event?.op ?? "update";
  const removed = event?.removed;
  const detail =
    op === "bulk-delete" && removed !== undefined
      ? `bulk-delete ${removed} note(s)`
      : `${op}${event?.noteId === undefined ? "" : ` ${event.noteId}`}`;
  return {
    op,
    ...(event?.noteId === undefined ? {} : { noteId: event.noteId }),
    ...(event?.actor === undefined ? {} : { actor: event.actor }),
    summary: `${detail} — ${state.notes.length} note(s) in the set`,
  };
}

/** The path of the journal endpoint for a (normalised) base path. */
function journalPathOf(base: string): string {
  return base === "" ? "/journal" : `${base}/journal`;
}

/**
 * `GET {base}/journal[?since=<seq>]` — the audit trail (FR-18).
 *
 * It lives in the glue and not in the pure handler: the journal is deployment infrastructure, and
 * the handler stays free of `node:fs`. `since` makes the endpoint cheap for an agent that only wants
 * what changed since its last round.
 */
function journalResponse(
  method: string,
  url: string,
  journal: Journal,
  options: ResolvedOptions,
): GlueResponse {
  if (method !== "GET") {
    return glueError(405, "method_not_allowed", `${method} is not allowed on the journal — use GET`, options);
  }
  let since = 0;
  const query = url.indexOf("?");
  if (query !== -1) {
    const raw = new URLSearchParams(url.slice(query + 1)).get("since");
    if (raw !== null) {
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return glueError(400, "invalid_query", `since must be a non-negative integer (got ${JSON.stringify(raw)})`, options);
      }
      since = parsed;
    }
  }
  const read = journal.read(since);
  const status: JournalStatus = journal.status();
  return {
    status: 200,
    headers: { "content-type": JSON_CONTENT_TYPE, ...corsHeaders(options.cors) },
    body: JSON.stringify({
      journal: status,
      ...(read.issue === undefined ? {} : { issue: read.issue }),
      entries: read.entries,
    }),
  };
}

/**
 * True when `url` targets this hub's MCP door (`{base}/mcp`), the one API route the synchronous
 * router does not own. The body-dependent half lives in `handleMcpRoute`; the glue only needs the
 * path here to run the identity check before reading a body (SEC-08).
 */
function isMcpRequest(url: string, base: string): boolean {
  const path = requestPath(url);
  const prefix = normalizeBase(base);
  const relative =
    prefix === "" ? path : path === prefix ? "/" : path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : null;
  return relative === "/mcp" || relative === "/mcp/";
}

/**
 * SEC-08: everything that can be refused without touching the request body or the store file.
 *
 * The glue asks this before `readBody`/`loadNotes`, so an unauthenticated or unknown request costs
 * a header check and nothing else. The decisions themselves are the router's own —
 * `gateRequest` for the notes API and the admin surface, `authorize` for the MCP door — so this is
 * an ordering, not a second policy. `null` means "read the body and let the normal path answer".
 */
function earlyRefusal(request: IncomingMessage, context: HandlerContext): ServerResponse | null {
  const method = (request.method ?? "GET").toUpperCase();
  const url = request.url ?? "/";
  const remote = request.socket.remoteAddress;
  const minimal: ServerRequest = {
    method,
    url,
    headers: request.headers,
    ...(remote === undefined ? {} : { remote }),
  };
  // The MCP door is asynchronous and lives outside the router. A read-scoped token may post a read
  // message, so the pre-check demands identity only; the write scope follows from the message and
  // is enforced after the body is read, inside the door. Non-POST verbs keep their own 405 answer.
  if (isMcpRequest(url, context.base)) {
    return method === "POST" ? authorize(minimal, context, "read") : null;
  }
  // The viewer is asynchronous (it fetches another site), so the pre-check lets it through to
  // `respond()` instead of asking the synchronous router, which would answer 404 for a path it
  // does not know. The door itself decides about the credential. The surface gate is normative
  // (spec §2.1 rule 7): on the hub surface a viewer path must reach `hubViewerPathRefusal()` — as a
  // 404 — without reading a body or loading the store first.
  if (surfaceOf(context) === "viewer" && context.viewer !== undefined && isViewerRequest(url, context)) {
    return null;
  }
  const gate = gateRequest(minimal, context);
  return gate.kind === "response" ? gate.response : null;
}

async function respond(
  request: IncomingMessage,
  response: NodeResponse,
  options: ResolvedOptions,
  context: HandlerContext,
  journal: Journal,
  store: FileNoteStore,
  federation: HubFederation | undefined,
): Promise<void> {
  const url = request.url ?? "/";
  const method = (request.method ?? "GET").toUpperCase();

  // SEC-02: the journal and the static site bypass the pure router, so the Host gate is asked here
  // as well — one implementation (`hostRefusal`), three call sites, no path that forgets it. It runs
  // before anything is read off the socket, so a foreign name costs no body and no store load.
  const refusedHost = hostRefusal(request, context);
  if (refusedHost !== null) {
    write(response, refusedHost);
    return;
  }

  // Spec §2.1 rules 5/8 and §5.3: the launcher belongs to the hub surface only and runs before the
  // router. The header-only gates run before anything is read off the socket (405/503/403/415/413
  // cost no body and no budget), then the body is read with the **existing** reader and its own
  // 8 KiB limit, then the same handler that a unit test calls directly.
  if (surfaceOf(context) === "hub" && isViewerStartRequest(url, context)) {
    const remote = request.socket.remoteAddress;
    const launcherRequest = {
      method,
      url,
      headers: request.headers,
      ...(remote === undefined ? {} : { remote }),
    };
    const refused = launcherHeadRefusal(launcherRequest, context);
    if (refused !== null) {
      write(response, refused);
      return;
    }
    // Only a POST that declares a body gets a read; a body-less POST (the admin button) behaves
    // exactly like a GET with a header. The predicate is the launcher's own, so the read decision
    // and the media-type/size gates can never disagree (spec §5.1 rule 6).
    const declaresBody = launcherDeclaresBody(request);
    let body: string | undefined;
    if (method === "POST" && declaresBody) {
      try {
        body = await readBody(request, VIEWER_LAUNCHER_MAX_BODY_BYTES);
      } catch {
        // `readBody()` destroys the socket on a streamed overshoot and on a broken transport; a
        // destroyed socket cannot carry an answer, and there is no second read on this socket.
        if (!response.writableEnded && !response.destroyed) response.end();
        return;
      }
    }
    const launcher = handleViewerStart(
      { ...launcherRequest, ...(body === undefined ? {} : { body }) },
      context,
    );
    if (launcher !== null) {
      write(response, launcher);
      return;
    }
    // The launcher answers or consumes the body itself and returns; it never falls through to the
    // journal, the static site, earlyRefusal() or the router's readBody().
    if (!response.writableEnded && !response.destroyed) response.end();
    return;
  }

  // The surface split is the one security boundary (spec §2.1 rules 5/6). Both refusals are
  // header-only and no-ops on the other surface; they sit here — before the journal, the `--root`
  // static fallback and the body-dependent router — so `--root` can never serve an `index.html`
  // for a viewer path on the hub, and the viewer origin never reaches journal/static/MCP.
  const viewerPathOnHub = hubViewerPathRefusal({ url }, context);
  if (viewerPathOnHub !== null) {
    write(response, viewerPathOnHub);
    return;
  }
  const unservedOnViewer = viewerSurfaceRefusal({ url }, context);
  if (unservedOnViewer !== null) {
    write(response, unservedOnViewer);
    return;
  }

  // The viewer door: asynchronous, so it sits outside the pure router — the same placement as the
  // MCP door. It answers its own 404/401/403/502, so a `null` here means "not a viewer request".
  // The double gate is normative (spec §2.1 rule 7): only the viewer surface *and* a viewer path
  // reach `handleViewer()`, so `/health`, `{base}/notes*`, `{base}/sessions` and `{base}/bundle` are
  // never swallowed and keep running through `gateRequest()`.
  if (surfaceOf(context) === "viewer" && isViewerRequest(url, context)) {
    const remote = request.socket.remoteAddress;
    const answer = await handleViewer(
      { method, url, headers: request.headers, ...(remote === undefined ? {} : { remote }) },
      context,
    );
    if (answer !== null) {
      write(response, answer);
      return;
    }
  }

  // The journal answers before the static/API split: it belongs to neither. The viewer surface has
  // already been refused above, so this line is hub-only by construction.
  if (requestPath(url) === journalPathOf(options.base)) {
    write(response, journalResponse(method, url, journal, options));
    return;
  }

  // Without `--root` the handler answers everything (and 404s for anything outside the API).
  if (options.root !== undefined && !isApiPath(url, context.base)) {
    serveStatic(url, method, options, response);
    return;
  }

  // SEC-08: host check → credential gate → then a body. Everything refused here (401/403/404/429,
  // the two public probes and the preflight) costs no body read and no store load; only an allowed
  // request reaches `readBody` below. The store is re-read after that, so a refused flood cannot
  // turn into CPU and disk work proportional to the note set.
  const early = earlyRefusal(request, context);
  if (early !== null) {
    write(response, early);
    return;
  }

  let body = "";
  try {
    body = await readBody(request, MAX_BODY_BYTES);
  } catch (error) {
    // Over-limit bodies destroy the socket inside `readBody` (SEC-08); there is no stream left to
    // carry an answer, so nothing is written. Any other read error is still a documented 400.
    if (error instanceof BodyTooLargeError) {
      if (!response.writableEnded && !response.destroyed) response.end();
      return;
    }
    write(
      response,
      glueError(400, "invalid_json", `the request body could not be read: ${errorText(error)}`, options),
    );
    return;
  }

  // FR-16.9: the store file is the one truth both doors write to, so the in-memory set is refreshed
  // before each request — a note an agent wrote over MCP (or a human wrote in an editor) is visible
  // to the next browser request, and this hub's own writes are based on what is actually on disk.
  try {
    store.state.notes = loadNotes(options.storePath);
  } catch (error) {
    // A file that became unreadable mid-run keeps the last good set: refusing every request would
    // turn one bad edit into an outage, and the next readable state wins.
    if (!options.quiet) {
      process.stderr.write(
        `bluepencil server: keeping the last good note set — ${oneLine(errorText(error))}\n`,
      );
    }
  }

  // The MCP door (FR-16.8) is asynchronous, so it is answered here instead of inside the synchronous
  // handler. It shares the store file, the atomic write path and the authentication gate.
  const remote = request.socket.remoteAddress;
  const mcpResponse = await handleMcpRoute(
    { method, url, headers: request.headers, body, ...(remote === undefined ? {} : { remote }) },
    context,
    {
      read: async () => readTextIfExists(options.storePath),
      write: async (text) => {
        writeAtomic(options.storePath, text);
        if (options.mirror !== undefined) {
          // The mirror is a second rendering of the same set, so it is refreshed from what was just
          // written — otherwise `--mirror` would silently drift behind an MCP write.
          store.state.notes = loadNotes(options.storePath);
          writeAtomic(options.mirror, store.mirrorText() ?? "");
        }
      },
    },
    federation === undefined
      ? {}
      : { backendFactory: federationBackendFactory(federation, options) },
  );
  if (mcpResponse !== null) {
    write(response, mcpResponse);
    return;
  }

  write(
    response,
    handleRequest(
      { method, url, headers: request.headers, body, ...(remote === undefined ? {} : { remote }) },
      context,
    ),
  );
}

/* ------------------------------------------------------------------------------------------------
 * Federation (FR-16.14, PR 5b)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Everything the hub resolved once at start-up. It is deliberately built **before** the socket is
 * bound: a registry that fails validation, an identity mismatch or a nested federation must refuse
 * the start instead of serving a half-wired aggregate.
 *
 * The clients are shared across requests; a per-request {@link federationBackendFactory} only adds
 * this request's in-process `self` source. No request reloads the registry.
 */
export interface HubFederation {
  readonly registry: ResolvedRegistry;
  readonly clients: readonly InstanceClient[];
  readonly includeSelf: boolean;
  readonly timeoutMs: number;
  readonly concurrency: number;
  readonly limit: number;
  readonly allowWrite: boolean;
  readonly allowInsecure: boolean;
  readonly readOnly: boolean;
}

/**
 * Maps the registry taxonomy onto the start-up taxonomy of plan §7. `FederationError` from the
 * loader (unreadable file, unsafe permissions) is already canonical and passes through unchanged.
 */
function registryStartupError(error: unknown): FederationError {
  if (error instanceof FederationError) return error;
  if (error instanceof RegistryError) {
    const codes = new Set(error.issues.map((issue) => issue.code));
    const code = codes.has("missing_env_var")
      ? "missing_credential"
      : codes.has("invalid_base_url")
        ? "invalid_base_url"
        : "invalid_registry";
    return new FederationError(code, error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new FederationError("invalid_registry", message);
}

/** Degraded start is allowed only for a peer that is not there yet (T72); everything else is fatal. */
function degradable(code: string): boolean {
  return code === "instance_unreachable" || code === "timeout";
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"]);

/** Origin+base of a bind; IPv6 literals need brackets to be a valid URL. */
function originOf(host: string, port: number, base: string): string {
  const formatted = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formatted}:${port}${base}`;
}

function effectivePort(url: URL): string {
  if (url.port !== "") return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || /^127\./u.test(host);
}

/** Normalised path; an empty or root path is the same instance. */
function pathOf(url: URL): string {
  const path = url.pathname.replace(/\/+$/u, "");
  return path === "" ? "/" : path;
}

/**
 * True when two bases address this same process. Hostnames `127.0.0.1`, `localhost` and `::1` on the
 * same port and path are the same instance (plan §6 step 5).
 *
 * Wildcard binds remain a documented limitation (plan §12 open point 12): a hub bound to `0.0.0.0`
 * or `::` cannot, from the bind address alone, know which concrete address a registry used, so a
 * self-entry written with a specific interface address is only caught when the addresses match
 * literally. We do not guess.
 */
export function sameInstanceBase(a: string, b: string): boolean {
  let left: URL;
  let right: URL;
  try {
    left = new URL(a);
    right = new URL(b);
  } catch {
    return false;
  }
  if (left.protocol !== right.protocol) return false;
  if (effectivePort(left) !== effectivePort(right)) return false;
  if (pathOf(left) !== pathOf(right)) return false;
  if (left.hostname === right.hostname) return true;
  return isLoopbackHost(left.hostname) && isLoopbackHost(right.hostname);
}

function assertNotSelfReference(federation: HubFederation, ownBase: string): void {
  for (const client of federation.clients) {
    if (!sameInstanceBase(client.base, ownBase)) continue;
    throw new FederationError(
      "self_reference",
      `instance "${client.id}" points at this hub (${ownBase}); a hub cannot federate with itself`,
      { instance: client.id },
    );
  }
}

/**
 * Loads the registry, builds one client per instance and verifies every peer's identity — all
 * before `listen()`.
 *
 * Precedence: CLI > registry defaults > the documented constants. `includeSelf` defaults to `true`
 * in a combined hub (FR-16.14).
 */
async function loadHubFederation(resolved: ResolvedOptions): Promise<HubFederation | undefined> {
  if (resolved.registry === undefined) return undefined;

  let registry: ResolvedRegistry;
  try {
    registry = await loadRegistry(resolved.registry, process.env, {
      allowInsecure: resolved.allowInsecure,
    });
  } catch (error) {
    throw registryStartupError(error);
  }

  const includeSelf = resolved.includeSelf ?? registry.defaults.includeSelf;
  const timeoutMs =
    resolved.timeoutMs ?? registry.defaults.timeoutMs ?? REGISTRY_DEFAULT_TIMEOUT_MS;
  const concurrency =
    resolved.concurrency ?? registry.defaults.concurrency ?? REGISTRY_DEFAULT_CONCURRENCY;
  const limit = resolved.limit ?? registry.defaults.limit ?? REGISTRY_DEFAULT_LIMIT;

  const clients = registry.instances.map((instance) => {
    const credential = instance.credential;
    return new InstanceClient({
      id: instance.id,
      base: instance.base,
      mode: instance.mode,
      allowInsecure: resolved.allowInsecure,
      timeoutMs,
      clientName: resolved.appName,
      ...(instance.app === undefined ? {} : { app: instance.app }),
      ...(credential === undefined
        ? {}
        : {
            auth: {
              value: credential.value,
              ...(instance.tokenHeader === undefined ? {} : { header: instance.tokenHeader }),
              ...(instance.tokenScheme === undefined ? {} : { scheme: instance.tokenScheme }),
            },
          }),
    });
  });

  const federation: HubFederation = {
    registry,
    clients,
    includeSelf,
    timeoutMs,
    concurrency,
    limit,
    allowWrite: resolved.allowWrite,
    allowInsecure: resolved.allowInsecure,
    readOnly: resolved.readOnly,
  };

  /* A self-reference on a fixed, already known port can be refused before any request is sent.
   * The post-listen check repeats this for `--port 0`, where the actual bind is only known then. */
  if (resolved.port !== 0) {
    assertNotSelfReference(federation, originOf(resolved.host, resolved.port, resolved.base));
  }

  for (const client of clients) {
    try {
      const health = await client.health();
      /* T49: an older hub without `app` is still usable, but its identity is unverified. A missing
       * `federates` is NOT this case — it is a start error inside `health()` (T90). */
      if (health.unverified === true && !resolved.quiet) {
        process.stderr.write(
          `bluepencil server: instance "${client.id}" does not report "app" in /config — identity unverified\n`,
        );
      }
    } catch (error) {
      const failure =
        error instanceof FederationError
          ? error
          : new FederationError(
              "instance_unreachable",
              `instance "${client.id}" could not be verified at start-up`,
              { instance: client.id },
            );
      /* T72: a peer that is not up yet must not take the whole hub down. It stays in
       * `list_instances` with `ok:false` and makes aggregates `partial`. */
      if (degradable(failure.code)) {
        if (!resolved.quiet) {
          process.stderr.write(
            `bluepencil server: instance "${client.id}" is not reachable at start-up (${failure.code}) — starting degraded\n`,
          );
        }
        continue;
      }
      throw failure;
    }
  }

  return federation;
}

/** The in-process `self` source over this request's store backend (no HTTP, no credentials). */
function selfSourceOf(backend: McpBackend, resolved: ResolvedOptions): SelfSource {
  return {
    id: "self",
    app: resolved.appName,
    environment: resolved.environment,
    readOnly: resolved.readOnly,
    list: async (filter) => (await backend.list(filter)).notes,
    get: (id) => backend.get(id),
    create: (draft) => backend.create(draft),
    update: (id, patch) => backend.update(id, patch),
    addMessage: (id, message) => backend.addMessage(id, message),
    remove: (id) => backend.remove(id),
    bulkRemove: (filter) => backend.bulkRemove(filter),
    sessions: () => backend.sessions(),
    exportBundle: (options) => backend.exportBundle("self", options),
    importBundle: (bundle, options) => backend.importBundle(bundle, options, "self"),
    confirmWrite: (expected, action) => backend.confirmWrite(expected, action),
  };
}

/**
 * Per-request backend of a combined hub: the pre-built registry clients plus an in-process `self`
 * over this request's store. The self store backend is built with `allowWrite: true` on purpose —
 * the federation backend owns the two-lock decision (FR-16.13/16.14), so the inner store must not
 * refuse a write the session explicitly allowed.
 */
function federationBackendFactory(
  federation: HubFederation,
  resolved: ResolvedOptions,
): (input: McpBackendFactoryInput) => McpBackend {
  return (input) => {
    const storeBackend = createStoreBackend(input.store, {
      allowWrite: true,
      environment: input.environment,
      appName: input.appName,
      persistence: input.persistence,
      clientName: input.clientName,
      sessionId: input.sessionId,
      ...(input.now === undefined ? {} : { now: input.now }),
    });

    return createFederatedBackend({
      sources: federation.clients,
      self: selfSourceOf(storeBackend, resolved),
      allowWrite: federation.allowWrite,
      readOnly: federation.readOnly,
      appName: resolved.appName,
      environment: resolved.environment,
      clientName: input.clientName,
      defaults: {
        includeSelf: federation.includeSelf,
        timeoutMs: federation.timeoutMs,
        concurrency: federation.concurrency,
        limit: federation.limit,
      },
    });
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
}

/* ------------------------------------------------------------------------------------------------
 * Credential throttle
 * ---------------------------------------------------------------------------------------------- */

/**
 * Upper bound on tracked (peer, kind) pairs. The map is keyed by a client-supplied-ish value (the
 * peer address) multiplied by three credential kinds, so without a cap a flood from many addresses
 * would grow it without limit. Past the cap the oldest entry is evicted — an attacker can then
 * reset their own count by rotating addresses, but every address they rotate to still costs them
 * one connection, which is the same budget as no throttle.
 */
const THROTTLE_MAX_ENTRIES = 4096;

interface ThrottleEntry {
  count: number;
  /** When the current window started (epoch milliseconds). */
  firstAt: number;
}

/**
 * The one in-memory brute-force brake for every secret comparison (SEC-03, SEC-07, G2): the admin
 * secret on `/admin/*` and on `/notes*`, the client shared secret, and signed tokens.
 *
 * It lives in the glue, not in the pure handler, because it needs a clock and mutable process
 * state. Each credential kind has its own counter per peer ({@link THROTTLE_BUDGETS}), so burning
 * one budget never locks another. A success clears only that kind's entry — an operator who
 * mistypes once and then gets it right should not carry the failure into the rest of the window.
 *
 * State stays bounded: at most {@link THROTTLE_MAX_ENTRIES} pairs, one small counter object each,
 * and expired windows are pruned on every failure. No credential value is ever stored here — the
 * key is the peer address and the kind, which is all a brute-force brake needs.
 */
function createAdminThrottle(now: () => number = Date.now): AdminThrottle {
  const entries = new Map<string, ThrottleEntry>();
  const keyOf = (remote: string | undefined, kind: ThrottleKind): string =>
    `${kind}\u0000${remote ?? "unknown"}`;
  const expired = (entry: ThrottleEntry, at: number, windowMs: number): boolean =>
    at - entry.firstAt >= windowMs;
  const prune = (at: number): void => {
    for (const [key, entry] of entries) {
      const kind = key.slice(0, key.indexOf("\u0000")) as ThrottleKind;
      if (expired(entry, at, THROTTLE_BUDGETS[kind].windowMs)) entries.delete(key);
    }
  };

  return {
    allow: (remote, kind = "admin") => {
      const at = now();
      const key = keyOf(remote, kind);
      const entry = entries.get(key);
      if (entry === undefined) return true;
      if (expired(entry, at, THROTTLE_BUDGETS[kind].windowMs)) {
        entries.delete(key);
        return true;
      }
      return entry.count < THROTTLE_BUDGETS[kind].maxFailures;
    },
    failure: (remote, kind = "admin") => {
      const at = now();
      prune(at);
      const key = keyOf(remote, kind);
      const entry = entries.get(key);
      if (entry !== undefined) {
        entry.count += 1;
        return;
      }
      if (entries.size >= THROTTLE_MAX_ENTRIES) {
        // Map iteration is insertion order, so the first key is the oldest entry.
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(key, { count: 1, firstAt: at });
    },
    success: (remote, kind = "admin") => {
      entries.delete(keyOf(remote, kind));
    },
  };
}

export interface RunningViewer {
  readonly server: Server;
  /** The address the socket actually bound (not `--viewer-host`, which may be a name). */
  readonly host: string;
  /** The actual port — the ephemeral one when `--viewer-port 0` was requested. */
  readonly port: number;
  /** `origin` plus the normalised base path. */
  readonly url: string;
  /**
   * The public origin links and cookies use. Explicit when configured, otherwise derived from the
   * bind address and port — never from a wildcard address (spec §2.4 rule 6).
   */
  readonly origin: string;
}

export interface RunningServer {
  readonly server: Server;
  readonly host: string;
  /** Actual port — the resolved one when `port: 0` was requested. */
  readonly port: number;
  /** Origin plus base path, as a client would call it. */
  readonly url: string;
  /** Present only when the viewer (`--viewer`) is configured (spec §2.4). */
  readonly viewer?: RunningViewer;
  /** Closes both listeners; waits for both, then throws the first error (spec §2.4 rule 8). */
  close(): Promise<void>;
}

/**
 * `@internal` test seam for AC-F16 — the current module state of `activeJournal`.
 *
 * Not re-exported from `server/index.ts` and not a public contract: a failed start must not leave a
 * journal behind (spec §2.4 rule 11), and the only direct way to observe that is the module
 * variable. Tests read it; production code uses {@link flushHubJournal}.
 */
export function activeJournalForTests(): Journal | null {
  return activeJournal;
}

/** A request handler as `node:http` sees it; the dispatch slot is swapped after the start window. */
type RequestHandler = (request: IncomingMessage, response: NodeResponse) => void;

/**
 * The answer both listeners give while `port 0` has its sockets bound but the origins are not
 * resolved and validated yet (spec §2.4 rule 4, AC-F22).
 *
 * Deliberately written without `glueError()`: `service_not_ready` is not part of the documented
 * `ERROR_CODES` vocabulary (spec §2.9, C10). The answer carries no CORS header, no `Location` and
 * no `Set-Cookie`.
 */
function startWindowResponse(response: NodeResponse): void {
  const body = JSON.stringify({
    error: {
      code: "service_not_ready",
      message: "the hub is still starting — the listener is not ready yet, retry shortly",
    },
  });
  response.writeHead(503, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "retry-after": "1",
    "content-length": String(Buffer.byteLength(body)),
  });
  response.end(body);
}

/** The dispatch slot's start value: every request is answered `503` (see above). */
const startWindowHandler: RequestHandler = (_request, response) => startWindowResponse(response);

/**
 * Binds one server and resolves when it is listening. A start-up failure rejects (the caller closes
 * what it already bound); after that the error is logged instead of thrown, because an `error`
 * event with no listener would take the process down.
 */
function listenServer(server: Server, port: number, host: string, quiet: boolean): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const onStartupError = (error: Error): void => rejectPromise(error);
    server.once("error", onStartupError);
    server.listen(port, host, () => {
      server.off("error", onStartupError);
      server.on("error", (error: Error) => {
        if (!quiet) process.stderr.write(`bluepencil server: ${oneLine(errorText(error))}\n`);
      });
      resolvePromise();
    });
  });
}

/** The live binding, straight from the socket; the configured pair is the fallback. */
function boundAddress(server: Server, host: string, port: number): { host: string; port: number } {
  const address = server.address();
  if (address === null || typeof address === "string") return { host, port };
  return { host: address.address, port: address.port };
}

/** Everything the start validation compares (spec §2.4 rule 5). */
interface ViewerStartValidation {
  /** True when the operator named the origin, so a wildcard bind is acceptable. */
  readonly explicitOrigin: boolean;
  /** The **resolved** viewer bind address the wildcard obligation follows. */
  readonly viewerHost: string;
  /** The resolved viewer origin V (explicit or derived from a non-wildcard address). */
  readonly viewerOrigin: string;
  /** The hub origin H from the bound address and the actual port. */
  readonly hubOrigin: string;
  /** `--cors` as configured; `undefined` means no CORS at all. */
  readonly cors: string | undefined;
}

/**
 * The start validation of spec §2.4 rule 5 — one function, so the pre-`listen()` (fixed ports) and
 * post-`listen()` (`port 0`) paths cannot drift.
 *
 * Every failure that returns here happens after `activeJournal = journal`, so `startHub()`'s catch
 * resets the module state; no listener is left serving either, because the caller closes what it
 * bound before rethrowing.
 */
function assertViewerStart(input: ViewerStartValidation): void {
  // Defense in depth: `resolveViewerOptions()` already refuses this before any socket exists. The
  // check runs on the **resolved** bind, so a wildcard inherited from `--host` is caught too.
  if (!input.explicitOrigin && isWildcardBind(input.viewerHost)) {
    throw new HubStartupError(
      "viewer_origin_required",
      `the viewer is bound to a wildcard address (${JSON.stringify(input.viewerHost)}) and has no ` +
        "explicit origin — an origin is never derived from 0.0.0.0 or [::]",
    );
  }
  const viewer = normalizeOrigin(input.viewerOrigin);
  if (viewer === null) {
    throw new HubStartupError(
      "viewer_origin_invalid",
      `the viewer origin ${JSON.stringify(input.viewerOrigin)} must be an absolute http(s) origin ` +
        "without path, query or fragment",
    );
  }
  const hub = normalizeOrigin(input.hubOrigin);
  if (hub !== null && viewer === hub) {
    throw new HubStartupError(
      "viewer_origin_is_hub_origin",
      `the viewer origin ${input.viewerOrigin} is the hub origin — the viewer needs its own origin`,
    );
  }
  if (input.cors === "*") {
    throw new HubStartupError(
      "cors_wildcard_with_viewer",
      "CORS '*' must not be combined with a viewer — the viewer origin could read the hub journal",
    );
  }
  const cors = input.cors === undefined ? null : normalizeOrigin(input.cors);
  if (cors !== null && cors === viewer) {
    throw new HubStartupError(
      "cors_viewer_origin",
      `CORS must not name the viewer origin (${input.viewerOrigin})`,
    );
  }
}

/**
 * Starts the hub. The store file is read and validated *before* the socket is bound, so a
 * corrupt store rejects here instead of serving an empty set (F9).
 *
 * With `--viewer` a second listener is bound (hub first, then viewer). Every failure after
 * `activeJournal` was set resets it, so a later start never inherits a stale journal
 * (spec §2.4 rule 11, AC-F16).
 */
export async function startHub(options: HubOptions): Promise<RunningServer> {
  const resolved = resolveOptions(options);
  // O3: the lab flag weakens the URL policy (plain http, private addresses), so it must be visible
  // once on stderr. One line, no credentials, only when the operator did not ask for silence.
  if (resolved.allowInsecure && !resolved.quiet) {
    process.stderr.write(
      "bluepencil server: --allow-insecure is active — plain http and private addresses are admitted for registry peers (link-local and metadata stay blocked)\n",
    );
  }
  // FR-16.14/plan §6: registry, clients and identity checks all happen before the socket exists.
  // A failure here means "no partial start" — nothing has been served yet.
  const federation = await loadHubFederation(resolved);
  const journal = selectJournal({
    backend: resolved.journal,
    storePath: resolved.storePath,
    ...(resolved.journalDir === undefined ? {} : { dir: resolved.journalDir }),
    ...(resolved.journalRepo === undefined ? {} : { repo: resolved.journalRepo }),
    ...(resolved.journalCoalesceMs === undefined ? {} : { coalesceMs: resolved.journalCoalesceMs }),
    ...(resolved.journalAuthor === undefined ? {} : { author: resolved.journalAuthor }),
    ...(resolved.journalSubject === undefined ? {} : { subjectTemplate: resolved.journalSubject }),
    appName: resolved.appName,
    paths: [resolved.storePath, ...(resolved.mirror === undefined ? [] : [resolved.mirror])],
    onError: (message) => {
      if (!resolved.quiet) process.stderr.write(`bluepencil server: ${oneLine(message)}\n`);
    },
  });
  activeJournal = journal;
  try {
    return await startListeners(resolved, journal, federation, options);
  } catch (error) {
    // Normative (spec §2.4 rule 11): a failure after the journal was selected must not leave module
    // state behind. Every branch below either throws before a socket exists or closes what it bound
    // before rethrowing.
    activeJournal = null;
    throw error;
  }
}

async function startListeners(
  resolved: ResolvedOptions,
  journal: Journal,
  federation: HubFederation | undefined,
  options: HubOptions,
): Promise<RunningServer> {
  const store = createFileStore({
    ...(resolved.mirror !== undefined ? { mirror: resolved.mirror } : {}),
    storePath: resolved.storePath,
    environment: resolved.environment,
    appName: resolved.appName,
    exportedBy: resolved.exportedBy,
    ...(resolved.now !== undefined ? { now: resolved.now } : {}),
  });

  // Built once, from the key, so every request verifies against the same key and the TTL applies
  // only to newly issued tokens. `asHandlerVerifier` narrows the verdict to what the handler needs,
  // which keeps the token format out of the routes (#36, phase 2).
  const tokenIssuer =
    resolved.tokenKey === undefined
      ? undefined
      : createTokenIssuer({
          key: resolved.tokenKey,
          ...(resolved.tokenTtlSeconds !== undefined ? { ttlSeconds: resolved.tokenTtlSeconds } : {}),
          ...(resolved.now !== undefined ? { now: () => new Date(resolved.now!()) } : {}),
        });

  // Revocation has to be live *and* durable: the set below is what the verifier reads on every
  // request, and the file is what survives a restart. Doing only one of the two would make a
  // revocation either a speed bump (memory) or invisible until restart (file). The admin surface
  // adds to both through `revokeToken`.
  const liveRevoked = new Set<string>(resolved.revokedTokens ?? []);

  // One presence tracker for the whole process, so a credential accepted on the viewer surface is
  // visible in the hub's `/admin/status` — it is the same deployment, not a second hub.
  const presence = createPresence(
    resolved.now === undefined
      ? {}
      : { now: () => new Date(resolved.now!()).getTime() },
  );

  /** The one persist closure both surfaces share (C2: one store, one journal). */
  const persist: HandlerContext["persist"] = (state, event) => {
    store.persist(state);
    // The note is on disk at this point; a journal failure must never roll it back, so the journal
    // reports its own problems and leaves the request alone (see `server/journal.ts`).
    journal.record(describeMutation(state, event));
  };

  const hubContext: HandlerContext = {
    store: store.state,
    base: resolved.base,
    environment: resolved.environment,
    readOnly: resolved.readOnly,
    allowEnvMismatch: resolved.allowEnvMismatch,
    version: SERVER_VERSION,
    hubName: options.name ?? osHostname(),
    appName: resolved.appName,
    // FR-6.15: `/config` always reports this. `true` means the process aggregates a registry —
    // also when a peer started degraded; it is true iff `--registry` was configured.
    federates: resolved.registry !== undefined,
    exportedBy: resolved.exportedBy,
    // These two were parsed, validated and then never passed on, so `--auth-secret` had no effect on
    // a real server: the handler was configured without it and served every request. The unit tests
    // could not catch it, because they call the handler directly with their own context.
    ...(resolved.authSecret !== undefined ? { authSecret: resolved.authSecret } : {}),
    ...(resolved.adminSecret !== undefined ? { adminSecret: resolved.adminSecret } : {}),
    // The same wiring rule as the two credentials above: parsed, validated — and it has to reach the
    // context, or `--viewer` would answer 404 on a hub that reports it as configured.
    ...(resolved.viewer !== undefined ? { viewer: resolved.viewer } : {}),
    ...(tokenIssuer !== undefined ? { verifyToken: asHandlerVerifier(tokenIssuer), tokenIssuer } : {}),
    revokedTokens: liveRevoked,
    ...(devicesPathFor(resolved.storePath) !== undefined ? { devicesPath: devicesPathFor(resolved.storePath) } : {}),
    ...(resolved.revokedPath !== undefined ? { revocationPath: resolved.revokedPath } : {}),
    adminThrottle: createAdminThrottle(),
    revokeToken: (jti: string) => {
      // Live first, always: the running process must cut the device off even if the file write
      // below fails. The result then says whether a restart would let it back in.
      liveRevoked.add(jti);
      const path = resolved.revokedPath;
      if (path === undefined) return { durable: false };
      try {
        // A file that does not exist at runtime is treated as an empty list; startup already
        // validated the configured path (`parseHubArgs` refuses a missing file), so this is a file
        // that disappeared after the hub came up. Anything that is not a JSON array of strings is
        // refused instead of overwritten: replacing a corrupt list with `[jti]` would silently
        // un-revoke every id it used to hold.
        const raw = readTextIfExists(path);
        let list: string[] = [];
        if (raw !== null) {
          const parsed: unknown = JSON.parse(raw);
          if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
            return {
              durable: false,
              error: `${path} must contain a JSON array of token id strings — the revocation is live only until restart`,
            };
          }
          list = parsed;
        }
        if (!list.includes(jti)) list.push(jti);
        writeAtomic(path, JSON.stringify(list, null, 2));
        return { durable: true };
      } catch (error) {
        return {
          durable: false,
          error: `${path} could not be updated: ${oneLine(errorText(error))}`,
        };
      }
    },
    cors: resolved.cors,
    now: resolved.now,
    presence,
    persist,
    surface: "hub",
  };

  const viewer = resolved.viewer;
  /**
   * The viewer surface is an **explicit allowlist** (spec §2.4 rule 2, C4) — deliberately not
   * `...hubContext`: `adminSecret`, `tokenIssuer`, `revokeToken`, `devicesPath`, `revocationPath`,
   * `root`, `registry` and `federation` must be structurally absent, not merely unused. `root` and
   * `cors` are off here as well, so the static fallback is structurally disabled and no viewer answer
   * carries hub CORS. `revokedTokens` is the **same** Set reference (`liveRevoked`), so a revocation
   * through the hub's admin surface takes effect on the viewer origin without a restart (AC-5.32).
   */
  const viewerContext: HandlerContext | undefined =
    viewer === undefined
      ? undefined
      : {
          store: hubContext.store,
          base: hubContext.base,
          environment: hubContext.environment,
          readOnly: hubContext.readOnly,
          allowEnvMismatch: hubContext.allowEnvMismatch,
          authSecret: hubContext.authSecret,
          verifyToken: hubContext.verifyToken,
          requiredScope: hubContext.requiredScope,
          revokedTokens: hubContext.revokedTokens,
          adminThrottle: hubContext.adminThrottle,
          presence: hubContext.presence,
          persist: hubContext.persist,
          version: hubContext.version,
          appName: hubContext.appName,
          exportedBy: hubContext.exportedBy,
          now: hubContext.now,
          viewer,
          surface: "viewer",
          bind: { host: viewer.host, port: viewer.port },
          hostAliases: viewer.hostAliases,
          cors: undefined,
        };

  // The viewer listener gets its own option view: no static root and no CORS, so neither can leak
  // onto that surface even if a path refusal were ever missed (spec §2.4 rule 2).
  const viewerResolved: ResolvedOptions | undefined =
    viewer === undefined ? undefined : { ...resolved, root: undefined, cors: undefined };

  /* Every listener answers `503 service_not_ready` until the dispatch slot is swapped. For fixed
   * ports that happens **before** `listen()` (origins and validation are known synchronously); for
   * `port 0` only after both binds and the post-`listen()` validation (spec §2.4 rule 4). */
  let hubDispatch: RequestHandler = startWindowHandler;
  let viewerDispatch: RequestHandler = startWindowHandler;
  const hubServer = createServer((request, response) => hubDispatch(request, response));
  const viewerServer =
    viewer === undefined ? undefined : createServer((request, response) => viewerDispatch(request, response));

  const hubHandler: RequestHandler = (request, response) => {
    respond(request, response, resolved, hubContext, journal, store, federation).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      /* SEC-09: the glue's last-resort answer is the same fixed pair the router uses. `publicError`
       * writes the detail — which may name an absolute path or a stack — to stderr and returns
       * `internal_error` / `internal error`, so this path cannot leak what `handler.ts` already
       * hides. */
      const failure = publicError(error);
      write(response, glueError(500, failure.code, failure.message, resolved));
    });
  };
  const viewerHandler: RequestHandler = (request, response) => {
    if (viewerResolved === undefined || viewerContext === undefined) {
      startWindowResponse(response);
      return;
    }
    // R2-F5: the viewer surface never speaks for the federation. `/mcp` is refused by
    // `viewerSurfaceRefusal()` before this call, so the federation backend factory would be dead
    // code here anyway — passing `undefined` keeps the object structurally out of the viewer's
    // dispatch path instead of relying on that refusal alone.
    respond(request, response, viewerResolved, viewerContext, journal, store, undefined).catch(
      (error: unknown) => {
        if (response.headersSent) {
          response.end();
          return;
        }
        const failure = publicError(error);
        write(response, glueError(500, failure.code, failure.message, viewerResolved));
      },
    );
  };

  /** The explicit origin as it was resolved; `undefined` means "derive from the bind". */
  const explicitViewerOrigin = viewer?.origin;
  const bothPortsFixed = resolved.port !== 0 && (viewer === undefined || viewer.port !== 0);

  if (viewer !== undefined && viewerContext !== undefined) {
    // The Host gate must not run bind-less in the start window, so `bind` is the configured pair
    // until the socket replaces it (spec §2.4 rule 4).
    viewerContext.bind = { host: viewer.host, port: viewer.port };
    viewer.hubOrigin =
      isLoopbackAddress(resolved.host) ? originOf(resolved.host, resolved.port, "") : undefined;
  }

  let hubBinding = { host: resolved.host, port: resolved.port };
  let viewerBinding = viewer === undefined ? undefined : { host: viewer.host, port: viewer.port };

  if (bothPortsFixed) {
    hubContext.bind = { host: resolved.host, port: resolved.port };
    if (viewer !== undefined && viewerContext !== undefined) {
      if (explicitViewerOrigin === undefined) {
        // Fixed ports: the origin is fully determined by the configured bind and the fixed port,
        // so it is resolved *before* `listen()` and never re-derived from the socket (§4.9 no. 10).
        viewer.origin = normalizeOrigin(originOf(viewer.host, viewer.port, "")) ?? undefined;
      }
      assertViewerStart({
        explicitOrigin: explicitViewerOrigin !== undefined,
        viewerHost: viewer.host,
        viewerOrigin: viewer.origin ?? originOf(viewer.host, viewer.port, ""),
        hubOrigin: originOf(resolved.host, resolved.port, ""),
        cors: resolved.cors,
      });
    }
    hubDispatch = hubHandler;
    viewerDispatch = viewerHandler;
  }

  const bound: Server[] = [];
  try {
    await listenServer(hubServer, resolved.port, resolved.host, resolved.quiet);
    bound.push(hubServer);
    if (viewerServer !== undefined && viewer !== undefined) {
      // Hub first, then viewer — a failed second bind closes the first (AC-F12).
      await listenServer(viewerServer, viewer.port, viewer.host, resolved.quiet);
      bound.push(viewerServer);
    }

    const hubAddress = boundAddress(hubServer, resolved.host, resolved.port);
    hubBinding = hubAddress;
    // FR-6.10: the *live* binding, straight from the socket — this is what a client reads from
    // `{base}/config`. Deliberately not `--host`: `--host localhost` binds `::1`, and a status
    // display that repeated the flag would call a network-reachable hub "this machine only".
    hubContext.bind = { host: hubAddress.host, port: hubAddress.port };
    // Without a viewer there is no origin to resolve: the hub may serve the moment it is bound.
    if (viewerServer === undefined) hubDispatch = hubHandler;

    if (viewerServer !== undefined && viewer !== undefined && viewerContext !== undefined) {
      const viewerAddress = boundAddress(viewerServer, viewer.host, viewer.port);
      viewerBinding = viewerAddress;

      if (!bothPortsFixed) {
        // `port 0` on either side: only the socket knows the actual ports, so the origin and the
        // whole validation run now — still before the real handler is installed.
        if (explicitViewerOrigin === undefined) {
          viewer.origin =
            normalizeOrigin(originOf(viewerAddress.host, viewerAddress.port, "")) ?? undefined;
        }
        assertViewerStart({
          explicitOrigin: explicitViewerOrigin !== undefined,
          viewerHost: viewerAddress.host,
          viewerOrigin: viewer.origin ?? originOf(viewerAddress.host, viewerAddress.port, ""),
          hubOrigin: originOf(hubAddress.host, hubAddress.port, ""),
          cors: resolved.cors,
        });
        hubDispatch = hubHandler;
        viewerDispatch = viewerHandler;
      }

      // The launcher hint names the hub's *bind* origin, and only when that bind is loopback: a
      // public hub origin behind a proxy is not known to this process (§4.9 no. 9).
      viewer.hubOrigin = isLoopbackAddress(hubAddress.host)
        ? originOf(hubAddress.host, hubAddress.port, "")
        : undefined;
      viewerContext.bind = { host: viewerAddress.host, port: viewerAddress.port };
    }
  } catch (error) {
    await Promise.allSettled(bound.map((server) => closeServer(server)));
    throw error;
  }

  /* The resolved viewer is needed twice below — for the warnings and for the start line — and its
   * origin is known by now: explicit from `resolveOptions()`, or derived in the fixed/first branch
   * above. A wildcard bind can never reach this point without an explicit origin. */
  let runningViewer: RunningViewer | undefined;
  if (viewer !== undefined && viewerServer !== undefined && viewerBinding !== undefined) {
    const origin = viewer.origin ?? normalizeOrigin(originOf(viewerBinding.host, viewerBinding.port, ""))!;
    runningViewer = {
      server: viewerServer,
      host: viewerBinding.host,
      port: viewerBinding.port,
      origin,
      url: `${origin}${resolved.base}`,
    };
  }

  /* G1/SEC-01: the binding is only known now, so the safety warnings are decided here and written
   * before the `--quiet` check below — deliberately. `--quiet` silences progress chatter, not the
   * one line that says this hub hands every note to anyone who can reach the port; a warning that a
   * flag can switch off is not a warning. The decision itself is `startupWarnings()`, pure and
   * testable without a socket. The viewer half (shared cookie host, plain-http bind, deprecated
   * alias) is the same list and the same rule (spec §2.4 rule 9, AC-F13). */
  for (const warning of startupWarnings({
    host: hubContext.bind?.host ?? hubBinding.host,
    credential: credentialMode({
      ...(resolved.authSecret !== undefined ? { authSecret: resolved.authSecret } : {}),
      ...(tokenIssuer !== undefined ? { verifyToken: tokenIssuer } : {}),
    }),
    cors: resolved.cors ?? null,
    ...(viewer !== undefined && runningViewer !== undefined
      ? {
          viewer: {
            host: runningViewer.host,
            origin: runningViewer.origin,
            usedPublicUrlAlias: viewer.publicBaseUrl !== undefined,
          },
        }
      : {}),
  })) {
    process.stderr.write(`bluepencil server: ${warning.message}\n`);
  }

  /* Plan §6 step 5: the actual bind is only known now, so the self-reference check runs again for
   * `--port 0`. A registry entry that addresses this very hub must not turn into a loop (it would
   * also be `nested_federation`, but `self_reference` is the precise diagnosis). */
  if (federation !== undefined) {
    try {
      assertNotSelfReference(
        federation,
        originOf(hubBinding.host, hubBinding.port, resolved.base),
      );
    } catch (error) {
      await Promise.allSettled(bound.map((server) => closeServer(server)));
      throw error;
    }
  }

  if (!resolved.quiet) {
    process.stderr.write(
      `bluepencil server: "${hubContext.hubName}" on http://${resolved.host}:${hubBinding.port}${resolved.base || "/"}` +
        (runningViewer === undefined ? "" : ` — viewer on ${runningViewer.url}`) +
        ` — ${store.state.notes.length} note(s), environment ${resolved.environment}, ` +
        `${resolved.readOnly ? "read-only" : "read-write"}, ` +
        `${isLoopbackAddress(hubBinding.host) ? "reachable on this machine only" : `reachable from the network (bound ${hubBinding.host})`}, ` +
        `store ${resolved.storePath}\n`,
    );
  }

  return {
    server: hubServer,
    host: resolved.host,
    port: hubBinding.port,
    url: `http://${resolved.host}:${hubBinding.port}${resolved.base}`,
    ...(runningViewer === undefined ? {} : { viewer: runningViewer }),
    close: async () => {
      const results = await Promise.allSettled(
        (viewerServer === undefined ? [hubServer] : [hubServer, viewerServer]).map((server) =>
          closeServer(server),
        ),
      );
      // Both closes are awaited before the first failure surfaces: one failing close must never
      // leave the other listener running (spec §2.4 rule 8).
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
      }
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * CLI
 * ---------------------------------------------------------------------------------------------- */

/**
 * Parses the documented command line (contract §3). Returns the options, or a one-line usage
 * error as a string — the same contract as the MCP server's `parseArgs`, so `main()` stays thin.
 */
export function parseHubArgs(argv: string[]): HubOptions | string {
  const get = (flag: string): string | undefined => {
    const withEquals = argv.find((arg) => arg.startsWith(`${flag}=`));
    if (withEquals !== undefined) return withEquals.slice(flag.length + 1);
    const index = argv.indexOf(flag);
    if (index < 0) return undefined;
    const next = argv[index + 1];
    return next !== undefined && !next.startsWith("--") ? next : undefined;
  };
  /** True iff the flag appears at all — used only for "both given" diagnostics. */
  const present = (flag: string): boolean =>
    argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
  /* F5: a present flag without a value must be a usage error. Treating it as absent silently
   * applied a default (or let a registry default win), so `--store x --registry` looked valid while
   * the caller's typo stayed invisible. `--flag=value` always counts as present. */
  const VALUED_FLAGS = [
    "--store",
    "--registry",
    "--app",
    "--port",
    "--timeout",
    "--concurrency",
    "--limit",
    /* Every value-taking viewer flag (AC-F14): a present flag without a value must be diagnosed,
     * never silently read as "absent" — which would drop the viewer's whole security envelope. */
    "--viewer-assets",
    "--viewer-allow",
    "--viewer-ttl",
    "--viewer-host",
    "--viewer-port",
    "--viewer-origin",
    "--viewer-public-url",
  ] as const;
  for (const flag of VALUED_FLAGS) {
    if (argv.some((arg) => arg.startsWith(`${flag}=`))) continue;
    const index = argv.indexOf(flag);
    if (index < 0) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      return `${flag} requires a value (got ${next === undefined ? "nothing" : JSON.stringify(next)})`;
    }
  }
  const integerFlag = (
    flag: string,
    min: number,
    max?: number,
  ): number | string | undefined => {
    const raw = get(flag);
    /* Absent means "let the registry decide", not "use the built-in default": otherwise
     * `--registry` could never contribute `defaults.timeoutMs/concurrency/limit` (FR-16.14). */
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
      const range = max === undefined ? `a positive integer` : `an integer between ${min} and ${max}`;
      return `${flag} must be ${range} (got ${JSON.stringify(raw)})`;
    }
    return parsed;
  };

  const storePath = get("--store") ?? process.env.BLUEPENCIL_STORE ?? "";
  if (storePath === "") {
    return "--store <path> is required (the canonical bundle JSON the notes live in)";
  }

  const portRaw = get("--port");
  let port = DEFAULT_PORT;
  if (portRaw !== undefined) {
    const parsed = Number(portRaw);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      return `--port must be an integer between 0 and 65535 (got ${JSON.stringify(portRaw)})`;
    }
    port = parsed;
  }

  const environment = get("--environment") ?? process.env.BLUEPENCIL_ENVIRONMENT ?? DEFAULT_ENVIRONMENT;
  if (!isEnvironment(environment)) {
    return `--environment must be one of ${ENVIRONMENTS.join(", ")} (got ${JSON.stringify(environment)})`;
  }

  // Federation aggregate defaults (FR-16.12/FR-16.14). They are validated here so a bad `--timeout`
  // is a usage error at startup. An absent flag is left undefined so the registry defaults can
  // apply (CLI > registry.defaults > built-in constant).
  // F6: the same cap the registry enforces, so the CLI cannot configure a request that outlives
  // the documented start-up budget.
  const timeoutMs = integerFlag("--timeout", 1, REGISTRY_MAX_TIMEOUT_MS);
  if (typeof timeoutMs === "string") return timeoutMs;
  const concurrency = integerFlag("--concurrency", 1, 16);
  if (typeof concurrency === "string") return concurrency;
  const limit = integerFlag("--limit", 1, 1000);
  if (typeof limit === "string") return limit;

  const root = get("--root");
  const mirror = get("--mirror");
  const host = get("--host");
  const base = get("--base");
  // The name a client shows for this hub. An empty value is a configuration error rather than
  // "use the hostname": `--name ""` reads as a typo, and a blank entry in a picker is worse than none.
  const name = get("--name");
  if (name !== undefined && name.trim().length === 0) {
    return "--name must not be empty — omit it to use the machine's hostname";
  }
  // FR-6.15/FR-16.14: the identity anchor reported as `/config.app`. The flag wins over the env;
  // an empty value is a configuration error, not "use the default" — `--app ""` reads as a typo and
  // would make the registry identity check ambiguous.
  const appRaw = get("--app") ?? process.env.BLUEPENCIL_APP;
  if (appRaw !== undefined && appRaw.trim().length === 0) {
    return "--app must not be empty — omit it to use the default hub name";
  }
  const appName = appRaw;

  // A registry makes `/mcp` an aggregate in the next step; the hub itself keeps working without one.
  const registryRaw = get("--registry") ?? process.env.BLUEPENCIL_REGISTRY;
  if (registryRaw !== undefined && registryRaw.trim().length === 0) {
    return "--registry must not be empty — omit it to run without a registry";
  }
  const registry = registryRaw;

  // `--include-self` and `--no-self` are opposites; silently letting the later one win would hide a
  // scripted mistake. Both accept an explicit `=true|false` (the strict shared parser), so
  // `--no-self=false` means "include self" instead of being misread as a bare presence check.
  // `--no-self=false` → includeSelf true; `--include-self=false` → includeSelf false.
  const includeSelfFlag = booleanFlag(argv, "--include-self");
  if (typeof includeSelfFlag === "string") return includeSelfFlag;
  const noSelfFlag = booleanFlag(argv, "--no-self");
  if (typeof noSelfFlag === "string") return noSelfFlag;
  if (present("--include-self") && present("--no-self")) {
    return "--include-self and --no-self are mutually exclusive";
  }
  const includeSelf = present("--include-self")
    ? includeSelfFlag === true
    : present("--no-self")
      ? noSelfFlag === false
      : undefined;

  /* F-04: every boolean flag is parsed, not probed with `includes`. `--allow-write false` used to
   * evaluate true (presence-only), which is a fail-open on the write lock and the network policy;
   * a non-boolean value is now a usage error. */
  const readOnlyFlag = booleanFlag(argv, "--read-only");
  if (typeof readOnlyFlag === "string") return readOnlyFlag;
  const allowWriteFlag = booleanFlag(argv, "--allow-write");
  if (typeof allowWriteFlag === "string") return allowWriteFlag;
  const allowInsecureFlag = booleanFlag(argv, "--allow-insecure");
  if (typeof allowInsecureFlag === "string") return allowInsecureFlag;
  const allowEnvMismatchFlag = booleanFlag(argv, "--allow-env-mismatch");
  if (typeof allowEnvMismatchFlag === "string") return allowEnvMismatchFlag;
  const quietFlag = booleanFlag(argv, "--quiet");
  if (typeof quietFlag === "string") return quietFlag;

  const journalRaw = get("--journal") ?? process.env.BLUEPENCIL_JOURNAL;
  if (journalRaw !== undefined && !["auto", "git", "file", "none"].includes(journalRaw)) {
    return `--journal must be one of auto, git, file, none (got ${JSON.stringify(journalRaw)})`;
  }
  const coalesceRaw = get("--journal-coalesce");
  let journalCoalesceMs: number | undefined;
  if (coalesceRaw !== undefined) {
    const parsed = Number(coalesceRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return `--journal-coalesce must be a non-negative integer (got ${JSON.stringify(coalesceRaw)})`;
    }
    journalCoalesceMs = parsed;
  }
  // The flag or the environment, and an empty value is a configuration error rather than "no
  // authentication": `--auth-secret=` reads as a typo, and silently accepting it would leave a
  // deployment unprotected while looking configured (#36).
  const authSecretRaw = get("--auth-secret") ?? process.env.BLUEPENCIL_AUTH_SECRET;
  if (authSecretRaw !== undefined && authSecretRaw.length === 0) {
    return "--auth-secret must not be empty — omit it entirely to run without authentication";
  }
  // G2/SEC-07: the shared secret is the only gate on the note routes for every browser that holds
  // it, so it gets the same floor as the operator secret. A short existing value breaks the start
  // (CHANGELOG) — that is the point: the hub says so instead of quietly being guessable.
  if (authSecretRaw !== undefined && authSecretRaw.length < SECRET_MIN_LENGTH) {
    return (
      `--auth-secret must be at least ${SECRET_MIN_LENGTH} characters (secret_too_short) — ` +
      "a short shared secret is guessable"
    );
  }
  const authSecret = authSecretRaw;

  // The admin surface's own credential (`--admin-secret` / `BLUEPENCIL_ADMIN_SECRET`). Kept separate
  // from `--auth-secret` because they are handed to different people: the client credential lives in
  // every browser that uses the extension, this one belongs to the operator and unlocks token
  // issuing and revocation. An empty value reads as a typo for the same reason as above.
  const adminSecretRaw = get("--admin-secret") ?? process.env.BLUEPENCIL_ADMIN_SECRET;
  if (adminSecretRaw !== undefined && adminSecretRaw.length === 0) {
    return "--admin-secret must not be empty — omit it entirely to run without an admin surface";
  }
  // The admin secret mints and revokes every other credential, so it is the one secret that must
  // not be guessable: a short one turns the surface into a brute-force target that answers 401
  // quickly. The same floor as the client secret, from the same constant — two numbers would drift.
  if (adminSecretRaw !== undefined && adminSecretRaw.length < SECRET_MIN_LENGTH) {
    return `--admin-secret must be at least ${SECRET_MIN_LENGTH} characters — a short operator secret is guessable`;
  }
  const adminSecret = adminSecretRaw;

  // The viewer (`--viewer`): an SSRF-capable door on a second listener, so it exists only as a
  // complete set — a port, an allowlist, an operator credential and the directory holding the built
  // layer. Every missing piece is a startup error rather than a half-open feature.
  //
  // `--viewer` is a strict boolean (AC-F17): `--viewer=false`/`BLUEPENCIL_VIEWER=0` is "off", and a
  // non-boolean value is a usage error rather than a silent `true`. The flag wins over the env.
  const viewerFlagValue = booleanFlag(argv, "--viewer");
  if (typeof viewerFlagValue === "string") return viewerFlagValue;
  const viewerEnvValue = process.env.BLUEPENCIL_VIEWER;
  let viewerFromEnv: boolean | undefined;
  if (viewerEnvValue !== undefined) {
    if (viewerEnvValue === "1" || viewerEnvValue === "true") {
      viewerFromEnv = true;
    } else if (viewerEnvValue === "0" || viewerEnvValue === "false") {
      viewerFromEnv = false;
    } else {
      return `BLUEPENCIL_VIEWER must be true or false (got ${JSON.stringify(viewerEnvValue)})`;
    }
  }
  const viewerActive = present("--viewer") ? viewerFlagValue === true : viewerFromEnv === true;

  /* Every viewer flag (and its environment twin) is either part of an active viewer or a usage
   * error — a silently ignored `--viewer-port` is how a deployment believes it runs a separate
   * origin while it does not (AC-F7). */
  const VIEWER_VALUE_FLAGS: readonly { flag: string; env?: string }[] = [
    { flag: "--viewer-assets", env: "BLUEPENCIL_VIEWER_ASSETS" },
    { flag: "--viewer-allow", env: "BLUEPENCIL_VIEWER_ALLOW" },
    { flag: "--viewer-ttl" },
    { flag: "--viewer-host", env: "BLUEPENCIL_VIEWER_HOST" },
    { flag: "--viewer-port", env: "BLUEPENCIL_VIEWER_PORT" },
    { flag: "--viewer-origin", env: "BLUEPENCIL_VIEWER_ORIGIN" },
    { flag: "--viewer-public-url", env: "BLUEPENCIL_VIEWER_PUBLIC_URL" },
  ];
  let viewer: ServerOptions["viewer"];
  if (!viewerActive) {
    const strayViewerFlag = VIEWER_VALUE_FLAGS.some(
      ({ flag, env }) => present(flag) || (env !== undefined && process.env[env] !== undefined),
    );
    if (strayViewerFlag) return "--viewer-* require --viewer (viewer_flags_without_viewer)";
  } else {
    // Port: mandatory, because sharing the hub port is exactly the topology this feature replaces.
    const viewerPortRaw = get("--viewer-port") ?? process.env.BLUEPENCIL_VIEWER_PORT;
    if (viewerPortRaw === undefined) {
      return "--viewer requires --viewer-port <port> (viewer_port_required) — the viewer must not share the hub port";
    }
    const viewerPort = Number(viewerPortRaw);
    if (viewerPortRaw.trim() === "" || !Number.isInteger(viewerPort) || viewerPort < 0 || viewerPort > 65535) {
      return `--viewer-port must be an integer between 0 and 65535 (got ${JSON.stringify(viewerPortRaw)})`;
    }

    const ttlRaw = get("--viewer-ttl");
    let viewerTtl = DEFAULT_VIEWER_TTL_SECONDS;
    if (ttlRaw !== undefined) {
      const parsed = Number(ttlRaw);
      if (
        ttlRaw.trim() === "" ||
        !Number.isInteger(parsed) ||
        parsed < 60 ||
        parsed > MAX_VIEWER_TTL_SECONDS
      ) {
        return `--viewer-ttl must be an integer between 60 and ${MAX_VIEWER_TTL_SECONDS} (got ${JSON.stringify(ttlRaw)}) (viewer_ttl_invalid)`;
      }
      viewerTtl = parsed;
    }

    // The resolved viewer bind: an explicit `--viewer-host` wins, otherwise the hub bind is
    // inherited — including its wildcard, which triggers the same obligation (AC-F6). `""` is a
    // real value here (unspecified address), so `??` and not `||` is what keeps the inheritance
    // honest.
    const resolvedHubHost = host ?? DEFAULT_HOST;
    const viewerHostRaw = get("--viewer-host") ?? process.env.BLUEPENCIL_VIEWER_HOST;
    const resolvedViewerHost = viewerHostRaw ?? resolvedHubHost;

    // Two listeners on one address and one port cannot both bind. `0` is ephemeral and therefore
    // never a conflict; a different bind address is a different socket (AC-F3/AC-F19). "Different"
    // is asked semantically (`sameBind`): all wildcard spellings — `""`, `0.0.0.0`, `::`, `[::]` —
    // mean the same unspecified socket, so spelling-only equality would let the start fail later
    // at `listen()` with `EADDRINUSE` (F-04).
    if (viewerPort !== 0 && port !== 0 && viewerPort === port && sameBind(resolvedViewerHost, resolvedHubHost)) {
      return "--viewer-port must differ from --port on the same bind address (viewer_port_conflict)";
    }

    // Raw `--cors`, read before `corsOriginPolicy` because the viewer changes what is allowed.
    const corsRaw = present("--cors") ? get("--cors") : undefined;
    if (corsRaw !== undefined && corsRaw.trim() === "*") {
      return "--cors '*' must not be combined with --viewer (cors_wildcard_with_viewer)";
    }

    // Origin and its deprecated alias. Both go through the one origin form; equal values are
    // accepted, different values are a usage error instead of a coin toss (S1).
    const originRaw = get("--viewer-origin") ?? process.env.BLUEPENCIL_VIEWER_ORIGIN;
    const publicRaw = get("--viewer-public-url") ?? process.env.BLUEPENCIL_VIEWER_PUBLIC_URL;
    let explicitOrigin: string | undefined;
    let originLabel = "--viewer-origin";
    if (originRaw !== undefined) {
      const normalized = normalizeOrigin(originRaw);
      if (normalized === null) {
        return "--viewer-origin must be an absolute http(s) origin without path, query or fragment (viewer_origin_invalid)";
      }
      explicitOrigin = normalized;
    }
    if (publicRaw !== undefined) {
      const normalized = normalizeOrigin(publicRaw);
      if (normalized === null) {
        return "--viewer-public-url must be an absolute http(s) origin without path, query or fragment (viewer_origin_invalid)";
      }
      if (explicitOrigin !== undefined && explicitOrigin !== normalized) {
        return "--viewer-origin and --viewer-public-url disagree (viewer_origin_conflict)";
      }
      explicitOrigin = normalized;
      if (originRaw === undefined) originLabel = "--viewer-public-url";
    }

    // No origin is ever derived from an unspecified address; with a wildcard bind the operator has
    // to name the public origin. This holds for `--viewer-port 0` as well (AC-F6).
    if (isWildcardBind(resolvedViewerHost) && explicitOrigin === undefined) {
      return "--viewer-origin is required when the viewer bind is a wildcard address (viewer_origin_required)";
    }

    // The viewer origin is known at parse time when it is explicit, or when the port is fixed and
    // the bind is concrete. Otherwise (`--viewer-port 0`) the post-`listen()` check applies.
    const viewerOriginCandidate =
      explicitOrigin ??
      (viewerPort !== 0 && !isWildcardBind(resolvedViewerHost)
        ? (normalizeOrigin(originOf(resolvedViewerHost, viewerPort, "")) ?? undefined)
        : undefined);

    // "Hub origin" is the bind origin when it is knowable, plus any concrete `--cors` origin: both
    // are names this process answers under, so the viewer must not reuse either (AC-F5/AC-F21).
    // Precedence: the bind origin is a hard identity clash; a concrete `--cors` origin names the
    // viewer origin (`cors_viewer_origin`) unless the deprecated alias was the spelling used, in
    // which case the alias is answering a hub origin (AC-F21).
    const hubBindOrigin =
      port !== 0 && !isWildcardBind(resolvedHubHost)
        ? (normalizeOrigin(originOf(resolvedHubHost, port, "")) ?? undefined)
        : undefined;
    const corsOrigin =
      corsRaw !== undefined && corsRaw.trim() !== "*" ? normalizeOrigin(corsRaw.trim()) : null;
    if (viewerOriginCandidate !== undefined) {
      if (viewerOriginCandidate === hubBindOrigin) {
        return `${originLabel} must differ from the hub origin (viewer_origin_is_hub_origin)`;
      }
      if (corsOrigin !== null && corsOrigin === viewerOriginCandidate) {
        return originLabel === "--viewer-public-url"
          ? `${originLabel} must differ from the hub origin (viewer_origin_is_hub_origin)`
          : "--cors must not name the viewer origin (cors_viewer_origin)";
      }
    }

    const assetsRaw = get("--viewer-assets") ?? process.env.BLUEPENCIL_VIEWER_ASSETS;
    if (assetsRaw === undefined || assetsRaw.length === 0) {
      return "--viewer requires --viewer-assets <dir> (the directory with the built layer bundles)";
    }
    const elementPath = resolve(assetsRaw, "bluepencil.element.min.js");
    if (!existsSync(elementPath)) {
      return `--viewer-assets: ${elementPath} not found — run npm run build or point at dist/`;
    }
    const allowRaw = get("--viewer-allow") ?? process.env.BLUEPENCIL_VIEWER_ALLOW ?? "";
    const allow = allowRaw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (allow.length === 0) {
      return "--viewer requires --viewer-allow <host[,host]> — an open proxy is a server-side request forgery door";
    }
    if (adminSecret === undefined) {
      return "--viewer requires --admin-secret: the viewer is an operator surface";
    }
    viewer = {
      ...(viewerHostRaw === undefined ? {} : { host: viewerHostRaw }),
      port: viewerPort,
      ...(explicitOrigin === undefined ? {} : { origin: explicitOrigin }),
      ...(publicRaw === undefined || explicitOrigin === undefined
        ? {}
        : { publicBaseUrl: explicitOrigin }),
      assetsDir: resolve(assetsRaw),
      allow,
      ttlSeconds: viewerTtl,
    };
  }

  // Phase 2 (#36): a signing key for per-device tokens. Separate from the shared secret on purpose —
  // it is a different credential with a different job, and one is not a substitute for the other:
  // the key never leaves the hub, the secret is handed to every client. Setting both is
  // legitimate, and the handler then accepts either.
  const tokenKeyRaw = get("--token-key") ?? process.env.BLUEPENCIL_TOKEN_KEY;
  if (tokenKeyRaw !== undefined && tokenKeyRaw.length === 0) {
    return "--token-key must not be empty — omit it entirely to run without token authentication";
  }
  // G2/SEC-04: an HMAC key is the strength ceiling of every token it signs, so it gets a higher
  // floor than the shared secret. `bluepencil token` refuses the same lengths (server/mint-cli.ts).
  if (tokenKeyRaw !== undefined && tokenKeyRaw.length < TOKEN_KEY_MIN_LENGTH) {
    return (
      `--token-key must be at least ${TOKEN_KEY_MIN_LENGTH} characters (token_key_too_short) — ` +
      "a short key weakens every token it signs"
    );
  }
  const tokenKey = tokenKeyRaw;

  // CORS (SEC-06, ADR-0.12-S1). A bare `--cors` used to become `*` silently, which turned "I turned
  // CORS on" into "every site may read every note"; the value is required now, and the wildcard
  // needs a real client gate behind it. `present()` distinguishes "flag absent" from "flag without a
  // value", which `get()` alone cannot. The *client* credential decides — the admin secret guards an
  // operator surface, it does not authenticate a browser.
  const hasClientCredential = authSecret !== undefined || tokenKey !== undefined;
  const corsPolicy = corsOriginPolicy(
    present("--cors") ? (get("--cors") ?? "") : undefined,
    hasClientCredential,
  );
  if (!corsPolicy.ok) {
    return corsPolicy.code === "cors_value_missing"
      ? "--cors requires an explicit origin (cors_value_missing) — pass --cors <origin> " +
          "or spell out --cors '*'"
      : "--cors '*' needs a client credential (cors_wildcard_unauthenticated) — set a " +
          "client credential or name one origin";
  }
  const cors = corsPolicy.origin ?? undefined;
  let tokenTtlSeconds: number | undefined;
  const tokenTtlRaw = get("--token-ttl");
  if (tokenTtlRaw !== undefined) {
    const parsed = Number.parseInt(tokenTtlRaw, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return `--token-ttl must be a positive number of seconds, got ${tokenTtlRaw}`;
    }
    tokenTtlSeconds = parsed;
  }
  // Where revoked token ids are kept. It has to be a file: a revocation list that lives in memory
  // disappears on restart, and a device that was deliberately cut off would be let back in by
  // restarting the hub. That would make revocation a speed bump.
  const revokedPath = get("--revoked-tokens") ?? process.env.BLUEPENCIL_REVOKED_TOKENS;
  if (revokedPath !== undefined && revokedPath.length === 0) {
    return "--revoked-tokens must not be empty — omit it entirely to run with an empty list";
  }
  // Revoked ids, read once at startup. Read here rather than per request so a corrupt or unreadable
  // file is a startup failure an operator sees, not a silent empty list that un-revokes everything.
  let revokedTokens: ReadonlySet<string> | undefined;
  if (revokedPath !== undefined) {
    try {
      const raw = readFileSync(revokedPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
        return `${revokedPath} must contain a JSON array of token id strings`;
      }
      revokedTokens = new Set(parsed);
    } catch (error) {
      return `could not read ${revokedPath}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return {
    storePath,
    port,
    ...(host !== undefined ? { host } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(base !== undefined ? { base } : {}),
    ...(root !== undefined ? { root } : {}),
    environment,
    readOnly: readOnlyFlag ?? false,
    // `--auth-secret <value>` or the environment, never both: an unset secret means "no
    // authentication", so a typo in the flag must not silently fall back to that (#36).
    ...(authSecret !== undefined ? { authSecret } : {}),
    ...(adminSecret !== undefined ? { adminSecret } : {}),
    ...(viewer !== undefined ? { viewer } : {}),
    ...(tokenKey !== undefined ? { tokenKey } : {}),
    ...(tokenTtlSeconds !== undefined ? { tokenTtlSeconds } : {}),
    ...(revokedTokens !== undefined ? { revokedTokens } : {}),
    ...(revokedPath !== undefined ? { revokedPath } : {}),
    allowEnvMismatch: allowEnvMismatchFlag ?? false,
    ...(mirror !== undefined ? { mirror } : {}),
    ...(cors !== undefined ? { cors } : {}),
    ...(journalRaw !== undefined ? { journal: journalRaw as "auto" | "git" | "file" | "none" } : {}),
    ...(get("--journal-dir") === undefined ? {} : { journalDir: get("--journal-dir") as string }),
    ...(get("--journal-repo") === undefined ? {} : { journalRepo: get("--journal-repo") as string }),
    ...(journalCoalesceMs === undefined ? {} : { journalCoalesceMs }),
    ...(get("--journal-author") === undefined ? {} : { journalAuthor: get("--journal-author") as string }),
    ...(get("--journal-subject") === undefined ? {} : { journalSubject: get("--journal-subject") as string }),
    ...(appName !== undefined ? { appName } : {}),
    ...(registry !== undefined ? { registry } : {}),
    ...(includeSelf !== undefined ? { includeSelf } : {}),
    allowWrite: allowWriteFlag ?? false,
    allowInsecure: allowInsecureFlag ?? false,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(limit === undefined ? {} : { limit }),
    quiet: quietFlag ?? false,
  };
}

export const HELP = `bluepencil hub ${SERVER_VERSION} — static site + notes API on one port.

Usage:
  node dist/server.js --store notes.json [--port 8787] [--host 127.0.0.1] [--name "<text>"]
    [--base /api/v1/bluepencil] [--root <static dir>] [--environment dev|staging|live]
    [--read-only] [--auth-secret <value>] [--admin-secret <value>] [--allow-env-mismatch] [--mirror notes.md] [--cors <origin|*>] [--quiet]
    [--journal auto|git|file|none] [--journal-dir <dir>] [--journal-repo <dir>]
    [--journal-coalesce <ms>] [--journal-author "Name <mail>"] [--journal-subject "<template>"]
    [--app "<text>"] [--registry <path>] [--include-self|--no-self] [--allow-write] [--allow-insecure]
    [--timeout <ms>] [--concurrency <1..16>] [--limit <1..1000>]
    [--viewer --viewer-port <port> --viewer-assets <dir> --viewer-allow <host[,host]>]
    [--viewer-host <host>] [--viewer-origin <url>] [--viewer-ttl <seconds>] [--viewer-public-url <url>]
      env: BLUEPENCIL_APP, BLUEPENCIL_REGISTRY, BLUEPENCIL_AUTH_SECRET, BLUEPENCIL_ADMIN_SECRET,
           BLUEPENCIL_JOURNAL (backend), BLUEPENCIL_JOURNAL_AUTHOR, BLUEPENCIL_JOURNAL_SUBJECT,
           BLUEPENCIL_VIEWER, BLUEPENCIL_VIEWER_PORT, BLUEPENCIL_VIEWER_HOST, BLUEPENCIL_VIEWER_ORIGIN,
           BLUEPENCIL_VIEWER_PUBLIC_URL, BLUEPENCIL_VIEWER_ASSETS, BLUEPENCIL_VIEWER_ALLOW
      a flag wins over the env; without an author the commits carry the repository's identity,
      and the journal status reports which identity is in use

Federation (FR-6.15/FR-16.14):
  --app <text>, BLUEPENCIL_APP   identity reported as /config.app (default "bluepencil hub")
  --registry <path>, BLUEPENCIL_REGISTRY  registry file; /mcp aggregates only when set (/notes stays local)
  --include-self / --no-self     include this hub's own store in the /mcp aggregate (default true)
  --allow-write                  second lock for federated writes; /notes is unaffected (default off)
  --allow-insecure               allow http and private IPs in the registry (link-local always blocked)
  --timeout <ms>                 aggregate read timeout (default 3000)
  --concurrency <1..16>          parallel instance reads (default 8)
  --limit <1..1000>              maximum notes in an aggregate (default 200)

Authentication:
  With --auth-secret (or BLUEPENCIL_AUTH_SECRET) the note-carrying routes — /notes*, /sessions,
  /bundle and POST /mcp — require the secret in the x-bluepencil-auth header; a missing or wrong
  value is answered 401 {"error":{"code":"unauthorized"}}. Public on purpose, because they carry no
  note and no secret: /config, GET|HEAD /health, GET /journal (audit metadata only, no note body)
  and the CORS OPTIONS preflight. Without the flag there is no authentication at all — which is the
  right default for a hub bound to loopback, and the wrong one as soon as it is not. Prefer the
  environment variable: a secret on a command line is visible in the process list to every other
  user on the machine. An empty value is rejected rather than treated as "off", and fewer than 16
  characters is refused as secret_too_short — a short secret on a hub that hands it to every browser
  is a brute-force target, not a credential. Every secret comparison (this header, the admin secret
  on its two doors, and signed tokens) is throttled per peer with a separate budget per credential
  kind: after 10 failures within 5 minutes the answer is 429 with Retry-After: 300, and burning one
  budget does not lock another.

  With --admin-secret (or BLUEPENCIL_ADMIN_SECRET, at least 16 characters) the hub serves an admin
  page at {base}/admin and the routes behind it. The page itself is not gated (it carries no notes);
  the routes answer only for the x-bluepencil-admin header with that value — a separate credential
  from the one in every browser, because this one mints and revokes the other kind. Without the flag
  the surface does not exist at all (404, not a locked page). The admin secret is a second
  credential on the notes routes only (never on /mcp), so the page edits notes with the one value it
  holds. Minting tokens additionally needs --token-key (at least 32 characters, token_key_too_short
  below that; bluepencil token enforces the same floor); a revocation is live at once and written to
  --revoked-tokens so it survives a restart (without that file it is live only until restart).
  Failed secret checks are throttled: after 10 wrong attempts from one address within 5 minutes the
  answer is 429 with Retry-After: 300. Minting and revoking are credential management rather than
  note writes, so they stay available under --read-only while note writes remain 403. The surface
  speaks plain HTTP like the rest of the hub: bind it to loopback or put it behind TLS, because the
  admin secret travels in a header on every request.

Endpoints (base defaults to /api/v1/bluepencil — the default of the built-in http adapter):
  GET    {base}/config              name, app, federates, version, base, which credential, and the
                                    live binding — needs no credential itself (FR-6.10, FR-6.15)
  GET|HEAD {base}/health            { ok, status, version }
  POST   {base}/mcp                 MCP over HTTP (tools/list, tools/call, resources, prompts) —
                                    POST only, no sessions, same credential and same store as the
                                    notes API (FR-16.8)
  GET    {base}/notes               filters: route, intent, type, session, source, environment,
                                    includeDone, since, repeated status  → { notes }
  POST   {base}/notes               NoteDraft JSON                     → { note }
  PATCH  {base}/notes/{id}          note fields only                   → { note }
  POST   {base}/notes/{id}/messages { id, ts, text, author, author_type, kind } → { note }
  POST   {base}/notes/bulk-delete   { ids? , filter?, confirm: true }  → { removed }
  GET    {base}/sessions            → { sessions }
  GET    {base}/bundle              canonical bundle (src/data) — for agents/exports
  GET    {base}/journal             history: { journal: {backend, location, entries, lastSeq},
                                    entries } — optional ?since=<seq> for agents (FR-18)
  GET    {base}/admin               the admin page (HTML, not gated); exists only with --admin-secret
  GET    {base}/admin/status        hub + registry summary            → { version, …, devices }
  GET    {base}/admin/devices       the device registry               → { devices }
  POST   {base}/admin/devices       { device, scope?, ttlSeconds? }   → { token, jti, … }
  POST   {base}/admin/devices/revoke { jti }                          → { revoked, known, durable }

Rules: bulk-delete requires "confirm": true; an unknown id is 404; a malformed body is 400; a body
that is not application/json is 415; a known path with the wrong method is 405; every error is
{"error":{"code","message"}}. --read-only refuses every note write (403); admin mint/revoke stay
available because they manage credentials, not notes. The hub is bound to ONE
environment: a write that names another one is refused (400) unless --allow-env-mismatch promotes
it (FR-14.8). The store file is canonical bundle JSON, written atomically; a corrupt store file
refuses the start (exit 2) instead of being served as an empty set. --root serves a static
directory with an index.html fallback on the same origin.

CORS (SEC-06): off by default. --cors needs an explicit value — a bare --cors is a usage error
(cors_value_missing), because it used to mean "every origin" without anyone saying so. --cors '*'
is only accepted together with a client credential (cors_wildcard_unauthenticated otherwise) and
still prints a start-up warning: the wildcard lets any page a browser visits read and write every
note it can reach. --cors https://app.example names one origin and is the recommended form.

Binding (G1): a bind other than loopback without --auth-secret/--token-key is allowed — existing
LAN and lab setups keep working — but it prints a warning on stderr that --quiet does not suppress,
because the notes, the journal location and the author identity are readable by anyone who can
reach the port.

Viewer (issue #140): --viewer starts a SECOND listener on its own origin. It requires
--viewer-port (0..65535; the viewer must not share the hub port), --viewer-assets, --viewer-allow
and --admin-secret. --viewer-host defaults to the hub bind address. A wildcard bind ("", 0.0.0.0,
::, [::]) — explicit or inherited from --host — requires an explicit --viewer-origin; no origin is
ever derived from an unspecified address. --viewer-origin must be a bare http(s) origin (no path,
query or fragment) and must differ from the hub origin. --viewer-public-url is a deprecated alias
with the same rules and prints a warning for one release period. --viewer-ttl is 60..604800
seconds (default 28800). --cors '*' and a --cors equal to the viewer origin are refused with
--viewer. Every viewer flag without an active --viewer is a usage error, and a viewer flag without
a value is diagnosed, never read as absent. Viewer warnings (shared host name, non-loopback plain
http, deprecated alias) are not suppressed by --quiet.

Journal (FR-18): the hub keeps a history of every accepted mutation. --journal auto (default)
commits through the surrounding git work tree when there is one (staged paths, empty diffs skipped,
batched over --journal-coalesce ms, default 2000) and otherwise appends to a hash-chained
journal.jsonl next to the store; --journal none switches the history off. A journal failure never
fails a request: it is reported once on stderr and stays visible in GET {base}/journal.

Exit codes: 0 serving ended normally, 1 usage error, 2 the store file is not a valid note set.`;
