#!/usr/bin/env node
/**
 * bluepencil sidecar — process glue (FR-17 §3, the M2 `server/` deliverable).
 *
 * The sidecar is the reference implementation of the HTTP contract the built-in `http` adapter
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
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse as NodeResponse,
} from "node:http";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
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
  SIDECAR_APP_NAME,
  SIDECAR_EXPORTED_BY,
  corsHeaders,
  errorBody,
  handleRequest,
  isApiPath,
  normalizeBase,
  requestPath,
  type HandlerContext,
  type NoteStoreState,
  type ServerErrorCode,
} from "./handler";

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
  /** Canonical bundle JSON the sidecar reads at startup and writes on every mutation. */
  storePath: string;
  port?: number;
  host?: string;
  base?: string;
  /** Static directory served with an `index.html` fallback (`--root`). */
  root?: string;
  environment?: Environment;
  readOnly?: boolean;
  allowEnvMismatch?: boolean;
  /** Optional Markdown mirror of the note set (`--mirror`). */
  mirror?: string;
  /** Allowed CORS origin (`--cors <origin|*>`); unset means no CORS header at all. */
  cors?: string;
  quiet?: boolean;
  appName?: string;
  exportedBy?: string;
  /** Injectable clock, so tests are deterministic (NFR-17). */
  now?: () => string;
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
  mirror: string | undefined;
  cors: string | undefined;
  quiet: boolean;
  appName: string;
  exportedBy: string;
  now: (() => string) | undefined;
}

function resolveOptions(options: ServerOptions): ResolvedOptions {
  return {
    storePath: options.storePath,
    port: options.port ?? DEFAULT_PORT,
    host: options.host ?? DEFAULT_HOST,
    base: normalizeBase(options.base ?? DEFAULT_BASE_PATH),
    root: options.root === undefined ? undefined : resolve(options.root),
    environment: options.environment ?? DEFAULT_ENVIRONMENT,
    readOnly: options.readOnly ?? false,
    allowEnvMismatch: options.allowEnvMismatch ?? false,
    mirror: options.mirror,
    cors: options.cors,
    quiet: options.quiet ?? false,
    appName: options.appName ?? SIDECAR_APP_NAME,
    exportedBy: options.exportedBy ?? SIDECAR_EXPORTED_BY,
    now: options.now,
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

let writeCounter = 0;

/**
 * Atomic write: the temp file lives in the target directory (so `rename` never crosses a mount,
 * FR-6.5) and is removed on *every* exit path — including a failed rename — so a refused write
 * can never leave litter behind. The counter keeps two writes of one process from sharing a temp
 * path, which would let one rename publish a blob another write is still filling in.
 */
function writeAtomic(path: string, text: string): void {
  writeCounter += 1;
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${writeCounter}`);
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
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
  const appName = options.appName ?? SIDECAR_APP_NAME;

  const bundleText = (current: NoteStoreState): string =>
    bundleToJson(
      createBundle(current.notes, {
        environment: options.environment,
        app: { name: appName },
        exportedBy: options.exportedBy ?? SIDECAR_EXPORTED_BY,
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

async function respond(
  request: IncomingMessage,
  response: NodeResponse,
  options: ResolvedOptions,
  context: HandlerContext,
): Promise<void> {
  const url = request.url ?? "/";
  const method = (request.method ?? "GET").toUpperCase();

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

  write(
    response,
    handleRequest(
      { method, url, headers: request.headers, body },
      context,
    ),
  );
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
 * Starts the sidecar. The store file is read and validated *before* the socket is bound, so a
 * corrupt store rejects here instead of serving an empty set (F9).
 */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const resolved = resolveOptions(options);
  const store = createFileStore({
    ...(resolved.mirror !== undefined ? { mirror: resolved.mirror } : {}),
    storePath: resolved.storePath,
    environment: resolved.environment,
    appName: resolved.appName,
    exportedBy: resolved.exportedBy,
    ...(resolved.now !== undefined ? { now: resolved.now } : {}),
  });

  const context: HandlerContext = {
    store: store.state,
    base: resolved.base,
    environment: resolved.environment,
    readOnly: resolved.readOnly,
    allowEnvMismatch: resolved.allowEnvMismatch,
    version: SERVER_VERSION,
    appName: resolved.appName,
    exportedBy: resolved.exportedBy,
    ...(resolved.cors !== undefined ? { cors: resolved.cors } : {}),
    ...(resolved.now !== undefined ? { now: resolved.now } : {}),
    persist: (state) => store.persist(state),
  };

  const server = createServer((request, response) => {
    respond(request, response, resolved, context).catch((error: unknown) => {
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
  if (!resolved.quiet) {
    process.stderr.write(
      `bluepencil server: http://${resolved.host}:${port}${resolved.base || "/"} — ${store.state.notes.length} note(s), ` +
        `environment ${resolved.environment}, ${resolved.readOnly ? "read-only" : "read-write"}, store ${resolved.storePath}\n`,
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
export function parseServerArgs(argv: string[]): ServerOptions | string {
  const get = (flag: string): string | undefined => {
    const withEquals = argv.find((arg) => arg.startsWith(`${flag}=`));
    if (withEquals !== undefined) return withEquals.slice(flag.length + 1);
    const index = argv.indexOf(flag);
    if (index < 0) return undefined;
    const next = argv[index + 1];
    return next !== undefined && !next.startsWith("--") ? next : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);

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

  const root = get("--root");
  const mirror = get("--mirror");
  const host = get("--host");
  const base = get("--base");
  const cors = argv.some((arg) => arg === "--cors" || arg.startsWith("--cors="))
    ? (get("--cors") ?? "*")
    : undefined;

  return {
    storePath,
    port,
    ...(host !== undefined ? { host } : {}),
    ...(base !== undefined ? { base } : {}),
    ...(root !== undefined ? { root } : {}),
    environment,
    readOnly: has("--read-only"),
    allowEnvMismatch: has("--allow-env-mismatch"),
    ...(mirror !== undefined ? { mirror } : {}),
    ...(cors !== undefined ? { cors } : {}),
    quiet: has("--quiet"),
  };
}

const HELP = `bluepencil sidecar ${SERVER_VERSION} — static site + notes API on one port.

Usage:
  node dist/server.js --store notes.json [--port 8787] [--host 127.0.0.1]
    [--base /api/v1/bluepencil] [--root <static dir>] [--environment dev|staging|live]
    [--read-only] [--allow-env-mismatch] [--mirror notes.md] [--cors <origin|*>] [--quiet]

Endpoints (base defaults to /api/v1/bluepencil — the default of the built-in http adapter):
  GET    {base}/health              { ok, status, version }
  GET    {base}/notes               filters: route, intent, type, session, source, environment,
                                    includeDone, since, repeated status  → { notes }
  POST   {base}/notes               NoteDraft JSON                     → { note }
  PATCH  {base}/notes/{id}          note fields only                   → { note }
  POST   {base}/notes/{id}/messages { id, ts, text, author, author_type, kind } → { note }
  POST   {base}/notes/bulk-delete   { ids? , filter?, confirm: true }  → { removed }
  GET    {base}/sessions            → { sessions }
  GET    {base}/bundle              canonical bundle (src/data) — for agents/exports

Rules: bulk-delete requires "confirm": true; an unknown id is 404; a malformed body is 400; a body
that is not application/json is 415; a known path with the wrong method is 405; every error is
{"error":{"code","message"}}. --read-only refuses every write (403). The sidecar is bound to ONE
environment: a write that names another one is refused (400) unless --allow-env-mismatch promotes
it (FR-14.8). The store file is canonical bundle JSON, written atomically; a corrupt store file
refuses the start (exit 2) instead of being served as an empty set. --root serves a static
directory with an index.html fallback on the same origin. --cors is off by default.

Exit codes: 0 serving ended normally, 1 usage error, 2 the store file is not a valid note set.`;

function fail(message: string, code: number): never {
  process.stderr.write(`bluepencil server: ${oneLine(message)}\n`);
  process.exit(code);
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (argv.includes("--version")) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }
  const parsed = parseServerArgs(argv);
  if (typeof parsed === "string") {
    fail(parsed, 1);
  }
  try {
    await startServer(parsed);
  } catch (error) {
    // A usage failure is exit 1, an unreadable/corrupt store file is exit 2 (as the MCP server).
    fail(errorText(error), error instanceof StoreFileError ? 2 : 1);
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  // Only the real entry point starts a server; importing this module (tests) never does.
  void main(process.argv.slice(2));
}
