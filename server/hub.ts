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
import { readFileSync, statSync } from "node:fs";
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
import {
  DEFAULT_BASE_PATH,
  JSON_CONTENT_TYPE,
  SERVER_VERSION,
  HUB_APP_NAME,
  HUB_EXPORTED_BY,
  corsHeaders,
  errorBody,
  handleRequest,
  isApiPath,
  isLoopbackAddress,
  normalizeBase,
  requestPath,
  type AdminThrottle,
  type HandlerContext,
  type NoteStoreState,
  type ServerErrorCode,
  type MutationEvent,
} from "./handler";
import { writeAtomic } from "./atomic-write";
import { asHandlerVerifier, createTokenIssuer } from "./tokens";
// The admin surface's device registry lives next to the store; the page itself is only a route.
import { devicesPathFor } from "./admin";
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

/** Request bodies above this are refused with 413 instead of being buffered without bound. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Raised when the store file exists but is not a valid note set — never treated as "no notes". */
export class StoreFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreFileError";
  }
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
    adminSecret: options.adminSecret,
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The documented error shape, for the answers the glue itself produces (413, static 404/405). */
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

/** Reads the request body with a hard limit, so a huge payload cannot exhaust the process. */
function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const declared = Number(request.headers["content-length"] ?? NaN);
    if (Number.isFinite(declared) && declared > limit) {
      request.resume();
      rejectPromise(new BodyTooLargeError(`the request body exceeds ${limit} bytes`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) rejectPromise(new BodyTooLargeError(`the request body exceeds ${limit} bytes`));
      else resolvePromise(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", (error: unknown) => rejectPromise(error));
  });
}

function serveStatic(url: string, method: string, options: ResolvedOptions, response: NodeResponse): void {
  const pathname = requestPath(url);
  if (method === "OPTIONS" && options.cors !== undefined && options.cors !== "") {
    write(response, { status: 204, headers: corsHeaders(options.cors), body: "" });
    return;
  }
  if (method !== "GET" && method !== "HEAD") {
    write(
      response,
      glueError(405, "method_not_allowed", `${method} is not allowed on ${pathname} — documented method(s): GET, HEAD`, options),
    );
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
    write(response, glueError(500, "internal_error", `cannot read ${file}: ${errorText(error)}`, options));
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

  // The journal answers before the static/API split: it belongs to neither.
  if (requestPath(url) === journalPathOf(options.base)) {
    write(response, journalResponse(method, url, journal, options));
    return;
  }

  // Without `--root` the handler answers everything (and 404s for anything outside the API).
  if (options.root !== undefined && !isApiPath(url, context.base)) {
    serveStatic(url, method, options, response);
    return;
  }

  let body = "";
  try {
    body = await readBody(request, MAX_BODY_BYTES);
  } catch (error) {
    const tooLarge = error instanceof BodyTooLargeError;
    write(
      response,
      tooLarge
        ? glueError(413, "payload_too_large", oneLine(errorText(error)), options)
        : glueError(400, "invalid_json", `the request body could not be read: ${errorText(error)}`, options),
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
 * Admin throttle
 * ---------------------------------------------------------------------------------------------- */

/** Failed admin-secret checks a peer may make inside one window before it is answered 429. */
const ADMIN_THROTTLE_LIMIT = 10;
/** Length of that window: five minutes, the value the answer names in `Retry-After`. */
const ADMIN_THROTTLE_WINDOW_MS = 5 * 60 * 1000;
/**
 * Upper bound on tracked peers. The map is keyed by a client-supplied-ish value (the peer address),
 * so without a cap a flood from many addresses would grow it without limit. Past the cap the oldest
 * entry is evicted — an attacker can then reset their own count by rotating addresses, but every
 * address they rotate to still costs them one connection, which is the same budget as no throttle.
 */
const ADMIN_THROTTLE_MAX_ENTRIES = 4096;

interface ThrottleEntry {
  count: number;
  /** When the current window started (epoch milliseconds). */
  firstAt: number;
}

/**
 * The in-memory brute-force brake for `--admin-secret`: 10 failed checks per peer per 5 minutes.
 *
 * It lives in the glue, not in the pure handler, because it needs a clock and mutable process
 * state. A success clears the peer's entry — an operator who mistypes once and then gets it right
 * should not carry the failure into the rest of the window.
 */
function createAdminThrottle(now: () => number = Date.now): AdminThrottle {
  const entries = new Map<string, ThrottleEntry>();
  const keyOf = (remote: string | undefined): string => remote ?? "unknown";
  const expired = (entry: ThrottleEntry, at: number): boolean =>
    at - entry.firstAt >= ADMIN_THROTTLE_WINDOW_MS;
  const prune = (at: number): void => {
    for (const [key, entry] of entries) {
      if (expired(entry, at)) entries.delete(key);
    }
  };

  return {
    allow: (remote) => {
      const at = now();
      const key = keyOf(remote);
      const entry = entries.get(key);
      if (entry === undefined) return true;
      if (expired(entry, at)) {
        entries.delete(key);
        return true;
      }
      return entry.count < ADMIN_THROTTLE_LIMIT;
    },
    failure: (remote) => {
      const at = now();
      prune(at);
      const key = keyOf(remote);
      const entry = entries.get(key);
      if (entry !== undefined) {
        entry.count += 1;
        return;
      }
      if (entries.size >= ADMIN_THROTTLE_MAX_ENTRIES) {
        // Map iteration is insertion order, so the first key is the oldest entry.
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(key, { count: 1, firstAt: at });
    },
    success: (remote) => {
      entries.delete(keyOf(remote));
    },
  };
}

export interface RunningServer {
  readonly server: Server;
  readonly host: string;
  /** Actual port — the resolved one when `port: 0` was requested. */
  readonly port: number;
  /** Origin plus base path, as a client would call it. */
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Starts the hub. The store file is read and validated *before* the socket is bound, so a
 * corrupt store rejects here instead of serving an empty set (F9).
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

  const context: HandlerContext = {
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
    ...(resolved.cors !== undefined ? { cors: resolved.cors } : {}),
    ...(resolved.now !== undefined ? { now: resolved.now } : {}),
    persist: (state, event) => {
      store.persist(state);
      // The note is on disk at this point; a journal failure must never roll it back, so the journal
      // reports its own problems and leaves the request alone (see `server/journal.ts`).
      journal.record(describeMutation(state, event));
    },
  };

  const server = createServer((request, response) => {
    respond(request, response, resolved, context, journal, store, federation).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      write(response, glueError(500, "internal_error", errorText(error), resolved));
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onStartupError = (error: Error): void => rejectPromise(error);
    server.once("error", onStartupError);
    server.listen(resolved.port, resolved.host, () => {
      server.off("error", onStartupError);
      server.on("error", (error: Error) => {
        if (!resolved.quiet) process.stderr.write(`bluepencil server: ${oneLine(errorText(error))}\n`);
      });
      resolvePromise();
    });
  });

  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : resolved.port;
  // FR-6.10: the *live* binding, straight from the socket — this is what a client reads from
  // `{base}/config`. Deliberately not `--host`: `--host localhost` binds `::1`, and a status display
  // that repeated the flag would call a network-reachable hub "this machine only".
  const boundHost = address !== null && typeof address === "object" ? address.address : resolved.host;
  context.bind = { host: boundHost, port };

  /* Plan §6 step 5: the actual bind is only known now, so the self-reference check runs again for
   * `--port 0`. A registry entry that addresses this very hub must not turn into a loop (it would
   * also be `nested_federation`, but `self_reference` is the precise diagnosis). */
  if (federation !== undefined) {
    try {
      assertNotSelfReference(federation, originOf(boundHost, port, resolved.base));
    } catch (error) {
      activeJournal = null;
      await closeServer(server);
      throw error;
    }
  }
  if (!resolved.quiet) {
    process.stderr.write(
      `bluepencil server: "${context.hubName}" on http://${resolved.host}:${port}${resolved.base || "/"} — ` +
        `${store.state.notes.length} note(s), environment ${resolved.environment}, ` +
        `${resolved.readOnly ? "read-only" : "read-write"}, ` +
        `${isLoopbackAddress(boundHost) ? "reachable on this machine only" : `reachable from the network (bound ${boundHost})`}, ` +
        `store ${resolved.storePath}\n`,
    );
  }

  return {
    server,
    host: resolved.host,
    port,
    url: `http://${resolved.host}:${port}${resolved.base}`,
    close: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      }),
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
  const cors = argv.some((arg) => arg === "--cors" || arg.startsWith("--cors="))
    ? (get("--cors") ?? "*")
    : undefined;
  // The flag or the environment, and an empty value is a configuration error rather than "no
  // authentication": `--auth-secret=` reads as a typo, and silently accepting it would leave a
  // deployment unprotected while looking configured (#36).
  const authSecretRaw = get("--auth-secret") ?? process.env.BLUEPENCIL_AUTH_SECRET;
  if (authSecretRaw !== undefined && authSecretRaw.length === 0) {
    return "--auth-secret must not be empty — omit it entirely to run without authentication";
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
  // quickly. 16 characters is the floor, not a recommendation.
  if (adminSecretRaw !== undefined && adminSecretRaw.length < 16) {
    return "--admin-secret must be at least 16 characters — a short operator secret is guessable";
  }
  const adminSecret = adminSecretRaw;

  // Phase 2 (#36): a signing key for per-device tokens. Separate from the shared secret on purpose —
  // it is a different credential with a different job, and one is not a substitute for the other:
  // the key never leaves the hub, the secret is handed to every client. Setting both is
  // legitimate, and the handler then accepts either.
  const tokenKeyRaw = get("--token-key") ?? process.env.BLUEPENCIL_TOKEN_KEY;
  if (tokenKeyRaw !== undefined && tokenKeyRaw.length === 0) {
    return "--token-key must not be empty — omit it entirely to run without token authentication";
  }
  const tokenKey = tokenKeyRaw;
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
      env: BLUEPENCIL_APP, BLUEPENCIL_REGISTRY, BLUEPENCIL_AUTH_SECRET, BLUEPENCIL_ADMIN_SECRET,
           BLUEPENCIL_JOURNAL (backend), BLUEPENCIL_JOURNAL_AUTHOR, BLUEPENCIL_JOURNAL_SUBJECT
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
  With --auth-secret (or BLUEPENCIL_AUTH_SECRET) every request under the base must present the
  secret in the x-bluepencil-auth header; anything else is answered 401 {"error":{"code":
  "unauthorized"}}. Without the flag there is no authentication at all — which is the right default
  for a hub bound to loopback, and the wrong one as soon as it is not. Prefer the environment
  variable: a secret on a command line is visible in the process list to every other user on the
  machine. An empty value is rejected rather than treated as "off".

  With --admin-secret (or BLUEPENCIL_ADMIN_SECRET, at least 16 characters) the hub serves an admin
  page at {base}/admin and the routes behind it. The page itself is not gated (it carries no notes);
  the routes answer only for the x-bluepencil-admin header with that value — a separate credential
  from the one in every browser, because this one mints and revokes the other kind. Without the flag
  the surface does not exist at all (404, not a locked page). The admin secret is a second
  credential on the notes routes only (never on /mcp), so the page edits notes with the one value it
  holds. Minting tokens additionally needs --token-key; a revocation is live at once and written to
  --revoked-tokens so it survives a restart (without that file it is live only until restart).
  Failed secret checks are throttled: after 10 wrong attempts from one address within 5 minutes the
  answer is 429 with Retry-After: 300. Minting and revoking are credential management rather than
  note writes, so they stay available under --read-only while note writes remain 403. The surface
  speaks plain HTTP like the rest of the hub: bind it to loopback or put it behind TLS, because the
  admin secret travels in a header on every request.

Endpoints (base defaults to /api/v1/bluepencil — the default of the built-in http adapter):
  GET    {base}/config              name, app, federates, version, base, which credential, and the
                                    live binding — needs no credential itself (FR-6.10, FR-6.15)
  GET    {base}/health              { ok, status, version }
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
directory with an index.html fallback on the same origin. --cors is off by default.

Journal (FR-18): the hub keeps a history of every accepted mutation. --journal auto (default)
commits through the surrounding git work tree when there is one (staged paths, empty diffs skipped,
batched over --journal-coalesce ms, default 2000) and otherwise appends to a hash-chained
journal.jsonl next to the store; --journal none switches the history off. A journal failure never
fails a request: it is reported once on stderr and stays visible in GET {base}/journal.

Exit codes: 0 serving ended normally, 1 usage error, 2 the store file is not a valid note set.`;
