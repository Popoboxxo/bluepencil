/**
 * bluepencil sidecar — request handling (FR-17 §3, the M2 `server/` deliverable).
 *
 * The host either implements the documented HTTP contract on its own backend or runs this
 * sidecar: one dependency-free process that serves the notes API (`dist/server.js`) and, with
 * `--root`, a static site on the same origin (ARCHITECTURE §5, docs/INTEGRATION.md §5). The
 * default base path is exactly what the built-in `adapter: "http"` default expects
 * (`<origin>/api/v1/bluepencil`), so the sidecar is drop-in for the element.
 *
 * This module is the *pure* half of the sidecar: `handleRequest(request, context)` maps one HTTP
 * request onto `{ status, headers, body }` and imports nothing but `src/**` — no `node:http`, no
 * `node:fs`, no socket, no timer. The `node:http` glue, the static file serving, the CLI parsing
 * and the file store live in `server/index.ts`; persistence arrives as `context.persist`, which is
 * called exactly once per accepted mutation (and whose failure rolls the mutation back).
 *
 * Everything is delegated to the single implementation of `src/core/**` and `src/data/**`
 * (FR-15.3) — nothing about notes is re-implemented here:
 *   `createNote`/`applyPatch`/`appendMessage`  the state change (src/core/model, src/core/adapter)
 *   `validateNote`                             the shared schema check (src/data/schema)
 *   `matchesFilter`/`filterNotes`              the ONE filter predicate (src/core/adapter)
 *   `canonicalNote`/`createBundle`/`bundleToJson`  canonical output (src/data/canonical, bundle)
 *   `sortForReview`                            the FR-4.6 review order (src/core/protocol)
 *
 * Rules (frozen contract §3):
 *  - exactly the eight documented endpoints exist; an unknown path is 404, a known path with an
 *    undocumented method is 405 (`Allow` header set), a body that is not `application/json` is
 *    415, a malformed body is 400, an unknown note id is 404;
 *  - `POST {base}/notes/bulk-delete` needs `confirm: true` (else 400) and either `ids` or `filter`;
 *  - `--read-only` refuses every write with 403;
 *  - environment isolation per note (NFR-18): the sidecar is bound to ONE environment. A write
 *    that names (or targets) another environment is refused with 400, unless the host started the
 *    sidecar with `--allow-env-mismatch` — then the stamp is *promoted* to the bound environment
 *    (FR-14.8), so a running sidecar never accumulates notes of a second environment;
 *  - every error answer is JSON of the stable shape `{ error: { code, message } }`;
 *  - status codes are fixed for errors only: the contract names no 201/204 for the eight
 *    endpoints, so every successful answer is 200 (plus 204 for a CORS preflight). `--cors` is off
 *    by default, so no CORS header is sent unless the host asked for it.
 */

import {
  AUTHOR_TYPES,
  BluepencilValidationError,
  ENVIRONMENTS,
  MESSAGE_KINDS,
  NOTE_INTENTS,
  NOTE_STATUSES,
  NOTE_TYPES,
  appendMessage,
  createMessage,
  createNote,
  isAuthorType,
  isEnvironment,
  isMessageKind,
  isNoteIntent,
  isNoteStatus,
  isNoteType,
  systemClock,
  type AuthorType,
  type Environment,
  type Message,
  type MessageKind,
  type Note,
  type NoteDraft,
  type NoteFilter,
  type NotePatch,
  type NoteStatus,
} from "../src/core/model";
import { applyPatch, filterNotes, isRecord } from "../src/core/adapter";
import { sortForReview } from "../src/core/protocol";
import { canonicalNote } from "../src/data/canonical";
import { bundleToJson, createBundle } from "../src/data/bundle";
import { validateNote } from "../src/data/schema";

/**
 * Build-time version stamp. esbuild (scripts/build.mjs) replaces `__BLUEPENCIL_VERSION__` with the
 * package version when it bundles `dist/server.js`; `typeof` keeps the module working (and TypeScript
 * happy) when it is imported directly from the sources, e.g. in the unit tests or via tsx.
 */
declare const __BLUEPENCIL_VERSION__: string | undefined;

/** Version reported by `GET {base}/health`; `"dev"` when the sources run without a build stamp. */
export const SERVER_VERSION: string =
  typeof __BLUEPENCIL_VERSION__ === "string" ? __BLUEPENCIL_VERSION__ : "dev";

/** Default base path — the documented default of the built-in `http` adapter (contract §3). */
export const DEFAULT_BASE_PATH = "/api/v1/bluepencil";

/** What the sidecar records as the exporter of the bundles it writes. */
export const SIDECAR_EXPORTED_BY = "server:bluepencil";

/** App name the sidecar stamps into canonical bundles and the Markdown mirror. */
export const SIDECAR_APP_NAME = "bluepencil sidecar";

export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/**
 * Stable error codes of the sidecar. The wire format is always
 * `{ "error": { "code": "<one of these>", "message": "<one line>" } }`.
 */
export const ERROR_CODES = [
  "invalid_json",
  "invalid_payload",
  "invalid_query",
  "environment_mismatch",
  "duplicate_id",
  "confirm_required",
  "not_found",
  "method_not_allowed",
  "read_only",
  "unsupported_media_type",
  "payload_too_large",
  "store_write_failed",
  "internal_error",
] as const;

export type ServerErrorCode = (typeof ERROR_CODES)[number];

/** One HTTP request, already read off the socket (the handler never touches a stream). */
export interface ServerRequest {
  method: string;
  /** Request target: path and query, e.g. `/api/v1/bluepencil/notes?route=/cart`. */
  url: string;
  /** Header names are matched case-insensitively. */
  headers?: Record<string, string | string[] | undefined>;
  /** Raw request body text; empty when the request has none. */
  body?: string;
}

/** One HTTP response; `headers` are already complete, `body` is the exact bytes to send. */
export interface ServerResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * The in-memory note set of one running sidecar. It is the source of truth while the process runs
 * and is reloaded from the store file at startup (`server/index.ts`); a mutation replaces the
 * array (never mutates it in place), which is what makes a rolled-back write cheap.
 */
export interface NoteStoreState {
  notes: Note[];
}

/** Everything the pure handler needs: the set, the deployment settings and the persist hook. */
export interface HandlerContext {
  store: NoteStoreState;
  /** Base path (normalised by `normalizeBase`), e.g. `/api/v1/bluepencil`. */
  base: string;
  /** The one environment this sidecar serves (NFR-18). */
  environment: Environment;
  /** `--read-only`: every non-GET request is refused with 403. */
  readOnly?: boolean;
  /** `--allow-env-mismatch`: a foreign-environment write is promoted instead of refused (FR-14.8). */
  allowEnvMismatch?: boolean;
  /** `--cors <origin|*>`: the allowed origin; unset means no CORS headers at all. */
  cors?: string;
  /** Version reported by `/health`; defaults to `SERVER_VERSION`. */
  version?: string;
  /** App name stamped into bundles / the Markdown mirror. */
  appName?: string;
  /** Value of the bundle's `exportedBy` field. */
  exportedBy?: string;
  /** Injectable clock, so tests are deterministic (NFR-17). */
  now?: () => string;
  /**
   * Persists the current store state — called once per accepted mutation, *after* the state was
   * changed. A throwing persist rolls the mutation back and answers 500 (`store_write_failed`),
   * so the in-memory set never claims more than the medium holds.
   *
   * The optional `event` says *what* the mutation was, so a journal (FR-18) can record an audit
   * trail without guessing from a state diff.
   */
  persist?: (state: NoteStoreState, event?: MutationEvent) => void;
}

/** What a mutation was about — the sidecar's journal records this, the note set is the payload. */
export interface MutationEvent {
  op: "create" | "update" | "message" | "bulk-delete";
  /** The note the mutation was about; unset for a filtered bulk delete. */
  noteId?: string;
  /** How many notes a bulk delete removed. */
  removed?: number;
}

/** A refusal with a documented status code and error code. */
class HttpError extends Error {
  readonly status: number;
  readonly code: ServerErrorCode;

  constructor(status: number, code: ServerErrorCode, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

/** Throws the documented refusal — only ever caught by `applyMutation`/`handleRequest`. */
function refuse(status: number, code: ServerErrorCode, message: string): never {
  throw new HttpError(status, code, message);
}

/* ------------------------------------------------------------------------------------------------
 * Small text/HTTP helpers
 * ---------------------------------------------------------------------------------------------- */

/** Collapses any message to a single line — an error body is never a multi-line blob. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function errorText(error: unknown): string {
  if (error instanceof BluepencilValidationError) return error.issues.join("; ");
  return error instanceof Error ? error.message : String(error);
}

function headerValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = headers[key];
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/** Media type without parameters, lower-cased (`application/json; charset=utf-8` → `application/json`). */
function mediaType(value: string | undefined): string {
  if (value === undefined) return "";
  const semicolon = value.indexOf(";");
  return (semicolon === -1 ? value : value.slice(0, semicolon)).trim().toLowerCase();
}

/**
 * Strips leading/trailing slashes: `/api/v1/bluepencil/` → `/api/v1/bluepencil`, `/` → `""`
 * (an empty base means "everything is API", which is what a host behind a dedicated port wants).
 */
export function normalizeBase(base: string): string {
  const trimmed = (base ?? "").trim();
  if (trimmed === "" || trimmed === "/") return "";
  const withoutTrailing = trimmed.replace(/\/+$/, "");
  return withoutTrailing.startsWith("/") ? withoutTrailing : `/${withoutTrailing}`;
}

/**
 * Path of a request target, never the host: a target like `//evil.example/notes` is a path on this
 * server (it is not protocol-relative in an HTTP request line), which keeps the router honest.
 */
function parseRequestUrl(url: string): { pathname: string; query: URLSearchParams } {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
  const target = absolute ? url : `http://localhost${url.startsWith("/") ? "" : "/"}${url}`;
  const parsed = new URL(target);
  return { pathname: parsed.pathname, query: parsed.searchParams };
}

/** Path of a request target — used by the `node:http` glue to route API vs. static requests. */
export function requestPath(url: string): string {
  return parseRequestUrl(url).pathname;
}

/** True when the request target belongs to the API (and not to the static `--root`). */
export function isApiPath(url: string, base: string): boolean {
  return pathWithin(requestPath(url), normalizeBase(base)) !== null;
}

/** Path below `base`, or `null` when the target is outside the API. */
function pathWithin(pathname: string, base: string): string | null {
  if (base === "") return pathname;
  if (pathname === base) return "";
  return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : null;
}

function splitSegments(rest: string): string[] {
  return rest
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/**
 * The methods the contract documents for a path — `null` for an unknown path (404). `/notes/{id}`
 * is `PATCH` only: removal is the documented bulk-delete, there is no `DELETE {base}/notes/{id}`.
 */
function allowedMethods(segments: readonly string[]): string[] | null {
  const first = segments[0];
  if (segments.length === 1) {
    if (first === "health") return ["GET"];
    if (first === "notes") return ["GET", "POST"];
    if (first === "sessions") return ["GET"];
    if (first === "bundle") return ["GET"];
    return null;
  }
  if (segments.length === 2 && first === "notes") {
    return segments[1] === "bulk-delete" ? ["POST"] : ["PATCH"];
  }
  if (segments.length === 3 && first === "notes" && segments[2] === "messages") return ["POST"];
  return null;
}

/** CORS headers for one deployment; the default (no `--cors`) sends none at all. */
export function corsHeaders(cors: string | undefined): Record<string, string> {
  if (cors === undefined || cors === "") return {};
  return {
    "access-control-allow-origin": cors,
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
    "access-control-max-age": "600",
    ...(cors === "*" ? {} : { vary: "Origin" }),
  };
}

function json(status: number, payload: unknown, context: HandlerContext): ServerResponse {
  return {
    status,
    headers: {
      "content-type": JSON_CONTENT_TYPE,
      "cache-control": "no-store",
      ...corsHeaders(context.cors),
    },
    body: JSON.stringify(payload),
  };
}

function errorResponse(
  status: number,
  code: ServerErrorCode,
  message: string,
  context: HandlerContext,
): ServerResponse {
  return {
    status,
    headers: {
      "content-type": JSON_CONTENT_TYPE,
      "cache-control": "no-store",
      ...corsHeaders(context.cors),
    },
    body: errorBody(code, message),
  };
}

/**
 * The documented error body as text: `{ "error": { "code", "message" } }`. Exported so the
 * `node:http` glue can answer with exactly the same shape for its own failures (413, static 404).
 */
export function errorBody(code: ServerErrorCode, message: string): string {
  return JSON.stringify({ error: { code, message: oneLine(message) } });
}

/** Maps a thrown refusal/validation failure onto the documented answer. */
function toErrorResponse(error: unknown, context: HandlerContext): ServerResponse {
  if (error instanceof HttpError) {
    return errorResponse(error.status, error.code, error.message, context);
  }
  if (error instanceof BluepencilValidationError) {
    // The issue list is the payload a caller needs: it is joined into the one-line message.
    return errorResponse(400, "invalid_payload", error.issues.join("; ") || "invalid payload", context);
  }
  return errorResponse(500, "internal_error", errorText(error), context);
}

/**
 * Runs one mutation: the callback changes `context.store`, then the injected `persist` writes it.
 * A refusal (or a validation failure) leaves the set untouched; a failing persist restores the
 * previous array, so a reported success always means the medium holds the change.
 */
function applyMutation(
  context: HandlerContext,
  mutate: () => ServerResponse,
  event?: MutationEvent | (() => MutationEvent),
): ServerResponse {
  const previous = context.store.notes;
  let response: ServerResponse;
  try {
    response = mutate();
  } catch (error) {
    context.store.notes = previous;
    return toErrorResponse(error, context);
  }
  if (context.persist) {
    try {
      context.persist(context.store, typeof event === "function" ? event() : event);
    } catch (error) {
      context.store.notes = previous;
      return errorResponse(
        500,
        "store_write_failed",
        `the note set could not be written: ${errorText(error)}`,
        context,
      );
    }
  }
  return response;
}

/* ------------------------------------------------------------------------------------------------
 * Reading the request
 * ---------------------------------------------------------------------------------------------- */

/** Reads and validates a JSON object body; refuses 415 (media type) and 400 (JSON/shape). */
function readJsonObject(request: ServerRequest): Record<string, unknown> {
  const type = mediaType(headerValue(request.headers, "content-type"));
  if (type !== "application/json") {
    refuse(
      415,
      "unsupported_media_type",
      `the request body must be application/json (got ${type === "" ? "no content type" : JSON.stringify(type)})`,
    );
  }
  const raw = request.body ?? "";
  if (raw.trim() === "") {
    refuse(400, "invalid_json", "the request body is empty");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    refuse(400, "invalid_json", `the request body is not valid JSON: ${errorText(error)}`);
  }
  if (!isRecord(parsed)) {
    refuse(400, "invalid_payload", "the request body must be a JSON object");
  }
  return parsed;
}

function currentTime(context: HandlerContext): string {
  return context.now ? context.now() : systemClock.now();
}

/** Builds a note filter from query parameters; unknown parameters are ignored, bad values are 400. */
function filterFromQuery(query: URLSearchParams): NoteFilter {
  const filter: NoteFilter = {};

  const route = query.get("route");
  if (route !== null) filter.route = route;
  const session = query.get("session");
  if (session !== null) filter.session = session;
  const source = query.get("source");
  if (source !== null) filter.source = source;
  const since = query.get("since");
  if (since !== null) filter.since = since;

  const intent = query.get("intent");
  if (intent !== null) {
    if (!isNoteIntent(intent)) {
      refuse(400, "invalid_query", `intent must be one of ${NOTE_INTENTS.join(", ")} (got ${JSON.stringify(intent)})`);
    }
    filter.intent = intent;
  }
  const type = query.get("type");
  if (type !== null) {
    if (!isNoteType(type)) {
      refuse(400, "invalid_query", `type must be one of ${NOTE_TYPES.join(", ")} (got ${JSON.stringify(type)})`);
    }
    filter.type = type;
  }
  const environment = query.get("environment");
  if (environment !== null) {
    if (!isEnvironment(environment)) {
      refuse(
        400,
        "invalid_query",
        `environment must be one of ${ENVIRONMENTS.join(", ")} (got ${JSON.stringify(environment)})`,
      );
    }
    filter.environment = environment;
  }
  const includeDone = query.get("includeDone");
  if (includeDone !== null) {
    if (includeDone !== "true" && includeDone !== "false") {
      refuse(400, "invalid_query", `includeDone must be true or false (got ${JSON.stringify(includeDone)})`);
    }
    filter.includeDone = includeDone === "true";
  }
  const statuses = query.getAll("status");
  if (statuses.length > 0) {
    const checked: NoteStatus[] = [];
    for (const status of statuses) {
      if (!isNoteStatus(status)) {
        refuse(
          400,
          "invalid_query",
          `status must be one of ${NOTE_STATUSES.join(", ")} (got ${JSON.stringify(status)})`,
        );
      }
      checked.push(status);
    }
    filter.status = checked;
  }
  return filter;
}

/** The same field checks for the `filter` object of a bulk-delete body. */
function filterFromBody(value: unknown): NoteFilter {
  if (!isRecord(value)) {
    refuse(400, "invalid_payload", "filter must be a JSON object");
  }
  const query = new URLSearchParams();
  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (entry === undefined || entry === null) continue;
    if (key === "status") {
      for (const status of Array.isArray(entry) ? entry : [entry]) {
        query.append("status", String(status));
      }
      continue;
    }
    if (key === "includeDone") {
      query.set("includeDone", String(entry));
      continue;
    }
    if (key === "route" || key === "session" || key === "source" || key === "since") {
      query.set(key, String(entry));
      continue;
    }
    if (key === "intent" || key === "type" || key === "environment") {
      query.set(key, String(entry));
    }
  }
  return filterFromQuery(query);
}

const PATCH_FIELDS = new Set([
  "status",
  "intent",
  "body",
  "ticketRef",
  "environment",
  "anchor",
  "context",
  "sessionRef",
]);

/** A patch carries mutable fields only — an unknown key is a client bug, not something to ignore. */
function patchFromBody(payload: Record<string, unknown>): NotePatch {
  const unknown = Object.keys(payload).filter((key) => !PATCH_FIELDS.has(key));
  if (unknown.length > 0) {
    refuse(
      400,
      "invalid_payload",
      `unknown patch field(s) ${unknown.join(", ")} — a patch carries mutable note fields only`,
    );
  }
  return payload as unknown as NotePatch;
}

/** Maps the documented message payload (snake_case `author_type`) onto the model message. */
function messageFromBody(payload: Record<string, unknown>, context: HandlerContext): Message {
  const authorType = payload.author_type ?? payload.authorType ?? "human";
  const kind = payload.kind ?? "note";
  if (!isAuthorType(authorType)) {
    refuse(
      400,
      "invalid_payload",
      `author_type must be one of ${AUTHOR_TYPES.join(", ")} (got ${JSON.stringify(authorType)})`,
    );
  }
  if (!isMessageKind(kind)) {
    refuse(400, "invalid_payload", `kind must be one of ${MESSAGE_KINDS.join(", ")} (got ${JSON.stringify(kind)})`);
  }
  return createMessage({
    text: typeof payload.text === "string" ? payload.text : "",
    author: typeof payload.author === "string" ? payload.author : "unknown",
    authorType: authorType as AuthorType,
    kind: kind as MessageKind,
    now: typeof payload.ts === "string" ? payload.ts : currentTime(context),
    ...(typeof payload.id === "string" ? { id: payload.id } : {}),
  });
}

function findNote(context: HandlerContext, id: string): Note {
  const note = context.store.notes.find((candidate) => candidate.id === id);
  if (!note) {
    refuse(404, "not_found", `no note with id ${JSON.stringify(id)}`);
  }
  return note;
}

/**
 * Environment isolation (NFR-18): a write that names or targets another environment is refused
 * unless the host allowed it; with `--allow-env-mismatch` the note ends up in the sidecar's
 * environment (FR-14.8 promotion) instead of being stored next to it.
 */
function assertEnvironment(noteEnvironment: Environment, context: HandlerContext): void {
  if (noteEnvironment === context.environment || context.allowEnvMismatch) return;
  refuse(
    400,
    "environment_mismatch",
    `this sidecar serves the ${context.environment} environment — a ${noteEnvironment} note is refused ` +
      `(restart it with --allow-env-mismatch to promote such notes)`,
  );
}

/* ------------------------------------------------------------------------------------------------
 * The endpoints (contract §3)
 * ---------------------------------------------------------------------------------------------- */

function health(context: HandlerContext): ServerResponse {
  return json(200, { ok: true, status: "ok", version: context.version ?? SERVER_VERSION }, context);
}

function listNotes(query: URLSearchParams, context: HandlerContext): ServerResponse {
  const filter = filterFromQuery(query);
  // One filter predicate for UI, CLI, MCP and the sidecar (FR-15.3), then the shared review order.
  const matching = sortForReview(filterNotes(context.store.notes, filter));
  return json(200, { notes: matching.map(canonicalNote) }, context);
}

/** `createBundle` derives the sessions from the notes' `sessionRef` — the one implementation. */
function bundleOf(context: HandlerContext) {
  return createBundle(context.store.notes, {
    environment: context.environment,
    app: { name: context.appName ?? SIDECAR_APP_NAME },
    exportedBy: context.exportedBy ?? SIDECAR_EXPORTED_BY,
    ...(context.now !== undefined ? { now: context.now() } : {}),
  });
}

function createNoteFromBody(request: ServerRequest, context: HandlerContext): ServerResponse {
  const payload = readJsonObject(request);
  const requested = payload.environment;
  if (requested !== undefined && !isEnvironment(requested)) {
    refuse(
      400,
      "invalid_payload",
      `environment must be one of ${ENVIRONMENTS.join(", ")} (got ${JSON.stringify(requested)})`,
    );
  }
  let created = "";
  return applyMutation(context, () => {
    if (requested !== undefined) assertEnvironment(requested, context);
    const draft: NoteDraft = {
      ...(payload as unknown as NoteDraft),
      // A note is always born in the sidecar's environment (see `assertEnvironment`).
      environment: context.environment,
    };
    if (draft.now === undefined && context.now !== undefined) draft.now = context.now();
    const note = createNote(draft);
    const issues = validateNote(note);
    if (issues.length > 0) {
      throw new BluepencilValidationError(issues);
    }
    if (context.store.notes.some((candidate) => candidate.id === note.id)) {
      refuse(400, "duplicate_id", `a note with id ${JSON.stringify(note.id)} already exists`);
    }
    context.store.notes = [...context.store.notes, note];
    created = note.id;
    return json(200, { note: canonicalNote(note) }, context);
  }, () => ({ op: "create", noteId: created }));
}

function patchNote(id: string, request: ServerRequest, context: HandlerContext): ServerResponse {
  const patch = patchFromBody(readJsonObject(request));
  const note = findNote(context, id);
  return applyMutation(context, () => {
    assertEnvironment(note.environment, context);
    const next = applyPatch(note, patch, context.now ? context.now() : undefined);
    // Promotion (FR-14.8): an accepted write never leaves a second environment behind.
    next.environment = context.environment;
    const issues = validateNote(next);
    if (issues.length > 0) {
      throw new BluepencilValidationError(issues);
    }
    context.store.notes = context.store.notes.map((candidate) => (candidate.id === id ? next : candidate));
    return json(200, { note: canonicalNote(next) }, context);
  }, { op: "update", noteId: id });
}

function appendMessageToNote(id: string, request: ServerRequest, context: HandlerContext): ServerResponse {
  const payload = readJsonObject(request);
  const note = findNote(context, id);
  return applyMutation(context, () => {
    assertEnvironment(note.environment, context);
    const message = messageFromBody(payload, context);
    // Append-only: the shared model helper extends the thread and bumps `updatedAt` (FR-3.3).
    const next = appendMessage(note, message);
    next.environment = context.environment;
    const issues = validateNote(next);
    if (issues.length > 0) {
      throw new BluepencilValidationError(issues);
    }
    context.store.notes = context.store.notes.map((candidate) => (candidate.id === id ? next : candidate));
    return json(200, { note: canonicalNote(next) }, context);
  }, { op: "message", noteId: id });
}

function bulkDelete(request: ServerRequest, context: HandlerContext): ServerResponse {
  const payload = readJsonObject(request);
  if (payload.confirm !== true) {
    refuse(400, "confirm_required", 'bulk-delete requires {"confirm": true} — nothing was removed');
  }
  const rawIds = payload.ids;
  const rawFilter = payload.filter;
  if (rawIds === undefined && rawFilter === undefined) {
    refuse(400, "invalid_payload", "bulk-delete needs ids or filter — refusing to guess what to remove");
  }
  let ids: string[] | null = null;
  if (rawIds !== undefined) {
    if (!Array.isArray(rawIds) || rawIds.some((entry) => typeof entry !== "string")) {
      refuse(400, "invalid_payload", "ids must be an array of note ids");
    }
    ids = rawIds as string[];
  }
  const filter = rawFilter !== undefined ? filterFromBody(rawFilter) : null;

  let removedCount = 0;
  return applyMutation(context, () => {
    const selected =
      ids !== null
        ? context.store.notes.filter((note) => (ids as string[]).includes(note.id))
        : filterNotes(context.store.notes, filter ?? {});
    if (!context.allowEnvMismatch) {
      const foreign = selected
        .map((note) => note.environment)
        .filter((environment, index, all) => environment !== context.environment && all.indexOf(environment) === index);
      if (foreign.length > 0) {
        refuse(
          400,
          "environment_mismatch",
          `the selection contains ${foreign.join(", ")} note(s) — refusing to remove them from a ` +
            `${context.environment} sidecar (restart with --allow-env-mismatch to allow it)`,
        );
      }
    }
    const doomed = new Set(selected.map((note) => note.id));
    const remaining = context.store.notes.filter((note) => !doomed.has(note.id));
    const removed = context.store.notes.length - remaining.length;
    context.store.notes = remaining;
    removedCount = removed;
    return json(200, { removed }, context);
  }, () => ({ op: "bulk-delete", ...(removedCount === 0 ? {} : { removed: removedCount }) }));
}

/* ------------------------------------------------------------------------------------------------
 * Entry point
 * ---------------------------------------------------------------------------------------------- */

/**
 * Handles one request. Pure with respect to the process: it reads and writes only `context.store`
 * (and the injected `persist` hook), performs no I/O of its own and never throws — every failure
 * is a documented JSON answer (a refusal raised while reading the request is mapped here, a
 * refusal raised inside a mutation by `applyMutation`).
 */
export function handleRequest(request: ServerRequest, context: HandlerContext): ServerResponse {
  try {
    return routeRequest(request, context);
  } catch (error) {
    return toErrorResponse(error, context);
  }
}

/** The router itself; every refusal is a thrown `HttpError`, mapped by `handleRequest`. */
function routeRequest(request: ServerRequest, context: HandlerContext): ServerResponse {
  const base = normalizeBase(context.base);
  const { pathname, query } = parseRequestUrl(request.url);
  const method = (request.method ?? "GET").toUpperCase();
  const rest = pathWithin(pathname, base);
  const segments = rest === null ? [] : splitSegments(rest);
  const allow = rest === null ? null : allowedMethods(segments);

  if (allow === null) {
    return errorResponse(404, "not_found", `unknown endpoint ${pathname} — the API lives under ${base || "/"}`, context);
  }
  if (method === "OPTIONS" && context.cors !== undefined && context.cors !== "") {
    return { status: 204, headers: corsHeaders(context.cors), body: "" };
  }
  if (!allow.includes(method)) {
    const response = errorResponse(
      405,
      "method_not_allowed",
      `${method} is not allowed on ${pathname} — documented method(s): ${allow.join(", ")}`,
      context,
    );
    response.headers.allow = allow.join(", ");
    return response;
  }
  if (context.readOnly === true && method !== "GET") {
    return errorResponse(
      403,
      "read_only",
      "this sidecar runs read-only (--read-only) — writes are refused",
      context,
    );
  }

  const first = segments[0];
  if (first === "health") return health(context);
  if (first === "notes") {
    if (segments.length === 1) {
      return method === "GET" ? listNotes(query, context) : createNoteFromBody(request, context);
    }
    if (segments.length === 2) {
      const second = segments[1] ?? "";
      return second === "bulk-delete" ? bulkDelete(request, context) : patchNote(second, request, context);
    }
    return appendMessageToNote(segments[1] ?? "", request, context);
  }
  if (first === "sessions") {
    try {
      return json(200, { sessions: bundleOf(context).sessions }, context);
    } catch (error) {
      return toErrorResponse(error, context);
    }
  }
  if (first === "bundle") {
    try {
      return {
        status: 200,
        headers: { "content-type": JSON_CONTENT_TYPE, "cache-control": "no-store", ...corsHeaders(context.cors) },
        body: bundleToJson(bundleOf(context), { pretty: true }),
      };
    } catch (error) {
      return toErrorResponse(error, context);
    }
  }
  // Unreachable: `allowedMethods` already rejected anything else.
  return errorResponse(404, "not_found", `unknown endpoint ${pathname}`, context);
}
