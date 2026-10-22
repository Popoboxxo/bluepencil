/**
 * Federation HTTP client for exactly one instance (FR-16.12/16.13/16.15, NFR-22, plan §6).
 *
 * The client is deliberately dumb: it maps the documented HTTP contract onto typed calls, turns
 * every failure into one canonical {@link FederationError} and carries identity (`id`, `app`,
 * `mode`) as data. It adds no retry, no cache beyond `/config` and no write gate — the second
 * write lock lives in the federation backend, and a client that also refused writes would report
 * the wrong authority for the refusal.
 *
 * Safety rules this module is responsible for (plan §6, Rev. 4):
 *  - **Fail closed before every request.** `checkBaseUrl` runs first; a host that resolves to a
 *    link-local or metadata address is `invalid_base_url` and no `fetch` happens at all (T92).
 *    This holds with `allowInsecure: true`.
 *  - **No redirects.** `redirect: "manual"` and any 3xx is `invalid_response`; a custom auth header
 *    therefore cannot follow a `Location` to a foreign host (T78).
 *  - **No hanging request.** Every request races its `fetch` against an `AbortController` timeout,
 *    so a server that accepts the socket and never answers is `timeout`, never an empty success
 *    (T15).
 *  - **No secret leaves this process.** The credential value is only ever used to build a header.
 *    It is not an enumerable field, not part of a message and every message is passed through the
 *    caller's {@link Redactor} plus a defensive redactor built from the value itself (T16/NFR-22).
 */

import {
  isEnvironment,
  type Environment,
  type Message,
  type Note,
  type NoteDraft,
  type NoteFilter,
  type NotePatch,
  type Session,
} from "../core/model";
import type { ToolResponse } from "../mcp/tools";
import { VERSION } from "../version";
import type { ReadSource } from "./aggregate";
import { FederationError, Redactor, canonicalErrorCode, type FederationErrorCode } from "./errors";
import { assertFederatableNoteId } from "./ids";
import {
  UrlPolicyError,
  checkBaseUrl,
  createDnsResolver,
  type HostResolver,
} from "./net-policy";

/* ------------------------------------------------------------------------------------------------
 * Shapes
 * ---------------------------------------------------------------------------------------------- */

/** Credential plus the optional header/scheme a registry may override. */
export interface InstanceAuth {
  /** The resolved environment value. Never log, serialise or echo this. */
  value: string;
  /** Explicit header name; wins over the header derived from `/config.auth`. */
  header?: string;
  /** Optional scheme prefix, e.g. `Bearer` or `Token`. */
  scheme?: string;
}

export interface InstanceClientOptions {
  /** Registry id; every error carries it as `instance`. */
  id: string;
  /** Normalised base URL, e.g. `https://hub.example/api/v1/bluepencil`. */
  base: string;
  /** Expected app name; a differing `/config.app` is `identity_mismatch` in {@link health}. */
  app?: string;
  /** Registry mode. Data only — the write gate lives in the federation backend. */
  mode?: "read" | "write";
  auth?: InstanceAuth;
  /** Admits plain http and RFC1918/ULA targets. Link-local/metadata stay blocked. */
  allowInsecure?: boolean;
  /** Per-request timeout in milliseconds (default 3000). */
  timeoutMs?: number;
  /** Injectable for tests and runtimes without a global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Applied to every error message before it leaves the process. */
  redactor?: Redactor;
  /** Injected DNS resolver for the pre-flight address check. */
  resolver?: HostResolver;
  /** Sent as `x-bluepencil-client` on every `/mcp` request (provenance, FR-16.4). */
  clientName?: string;
  /** Sent as `mcp-session-id` on every `/mcp` request (provenance, FR-16.4). */
  sessionId?: string;
}

export interface HubConfig {
  name?: string | null;
  version?: string;
  base?: string;
  auth?: "none" | "secret" | "token";
  readOnly?: boolean;
  environment?: Environment;
  app?: string;
  /** 0.10 field. Absent on older hubs — {@link InstanceClient.health} refuses those (T90). */
  federates?: boolean;
  bind?: { host: string; port: number; loopbackOnly: boolean } | null;
}

export interface HubHealth {
  ok: boolean;
  app?: string;
  federates: boolean;
  /** Only set when `/config` did not name an `app`; never for a missing `federates`. */
  unverified?: boolean;
  environment?: Environment;
  version?: string;
  readOnly?: boolean;
  code?: FederationErrorCode;
  status?: number;
}

/* ------------------------------------------------------------------------------------------------
 * Constants and helpers
 * ---------------------------------------------------------------------------------------------- */

export const DEFAULT_CLIENT_TIMEOUT_MS = 3000;
export const DEFAULT_MCP_CLIENT_NAME = "bluepencil-federation";
export const MCP_PROTOCOL_VERSION = "2024-11-05";

const DEFAULT_AUTH_HEADER = "x-bluepencil-auth";
const TOKEN_AUTH_HEADER = "Authorization";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Stable HTTP status → federation code table (T67, plan §7). 3xx is included because a redirect
 * is a response the client must never follow (T78). This is only a fallback: a server that sends
 * `{error:{code}}` names the code itself.
 */
export function mapHttpStatus(status: number): FederationErrorCode {
  if (status >= 300 && status < 400) return "invalid_response";
  switch (status) {
    case 400:
      return "environment_mismatch";
    case 401:
      return "missing_credential";
    case 403:
      return "read_only";
    case 404:
      return "not_found";
    case 405:
      return "mode_denied";
    case 408:
      return "timeout";
    case 409:
    case 422:
      return "invalid_argument";
    default:
      return status >= 500 ? "not_persisted" : "invalid_response";
  }
}

/**
 * Hub-side `error.code` values that are not themselves canonical federation codes. The hub
 * contract uses HTTP/DTO vocabulary; the client keeps its own taxonomy (plan §7).
 */
const HUB_ERROR_CODES: Readonly<Record<string, FederationErrorCode>> = {
  read_only: "read_only",
  environment_mismatch: "environment_mismatch",
  not_found: "not_found",
  invalid_payload: "invalid_argument",
  invalid_query: "invalid_argument",
  confirm_required: "invalid_argument",
  duplicate_id: "invalid_argument",
  method_not_allowed: "mode_denied",
  unauthorized: "missing_credential",
  forbidden: "mode_denied",
  not_persisted: "not_persisted",
};

/** Maps a server-reported code if it is known; `undefined` means "fall back to the status". */
function mapServerCode(code: unknown): FederationErrorCode | undefined {
  if (typeof code !== "string" || code === "") return undefined;
  return canonicalErrorCode(code) ?? HUB_ERROR_CODES[code];
}

/** Query string for `GET /notes`; arrays are repeated `status` parameters (T66). */
export function noteFilterQuery(filter: NoteFilter): URLSearchParams {
  const query = new URLSearchParams();
  if (filter.status !== undefined) {
    for (const status of Array.isArray(filter.status) ? filter.status : [filter.status]) {
      query.append("status", status);
    }
  }
  if (filter.intent !== undefined) query.set("intent", filter.intent);
  if (filter.type !== undefined) query.set("type", filter.type);
  if (filter.priority !== undefined) query.set("priority", filter.priority);
  if (filter.route !== undefined) query.set("route", filter.route);
  if (filter.session !== undefined) query.set("session", filter.session);
  if (filter.since !== undefined) query.set("since", filter.since);
  if (filter.source !== undefined) query.set("source", filter.source);
  if (filter.environment !== undefined) query.set("environment", filter.environment);
  if (filter.includeDone !== undefined) query.set("includeDone", String(filter.includeDone));
  return query;
}

/** `POST /notes/{id}/messages` takes the documented snake_case shape. */
function messageBody(message: Message): Record<string, string> {
  return {
    text: message.text,
    kind: message.kind,
    author: message.author,
    author_type: message.authorType,
  };
}

/** Parses `/config` defensively: unknown fields are dropped, wrong types are ignored. */
function parseConfig(value: unknown): HubConfig | null {
  if (!isRecord(value)) return null;

  const config: HubConfig = {};

  const name = value["name"];
  if (typeof name === "string" || name === null) config.name = name;

  const version = value["version"];
  if (typeof version === "string") config.version = version;

  const base = value["base"];
  if (typeof base === "string") config.base = base;

  const auth = value["auth"];
  if (auth === "none" || auth === "secret" || auth === "token") config.auth = auth;

  const readOnly = value["readOnly"];
  if (typeof readOnly === "boolean") config.readOnly = readOnly;

  const environment = value["environment"];
  if (typeof environment === "string" && isEnvironment(environment)) {
    config.environment = environment;
  }

  const app = value["app"];
  if (typeof app === "string") config.app = app;

  const federates = value["federates"];
  if (typeof federates === "boolean") config.federates = federates;

  const bind = value["bind"];
  if (bind === null) {
    config.bind = null;
  } else if (
    isRecord(bind) &&
    typeof bind["host"] === "string" &&
    typeof bind["port"] === "number" &&
    typeof bind["loopbackOnly"] === "boolean"
  ) {
    config.bind = {
      host: bind["host"],
      port: bind["port"],
      loopbackOnly: bind["loopbackOnly"],
    };
  }

  return config;
}

interface RequestInitLike {
  query?: URLSearchParams;
  body?: unknown;
  headers?: Record<string, string>;
}

/* ------------------------------------------------------------------------------------------------
 * InstanceClient
 * ---------------------------------------------------------------------------------------------- */

export class InstanceClient implements ReadSource {
  readonly id: string;
  readonly mode: "read" | "write";
  readonly base: string;

  readonly #expectedApp: string | undefined;
  readonly #allowInsecure: boolean;
  readonly #timeoutMs: number;
  readonly #fetchImpl: typeof fetch | undefined;
  readonly #auth: InstanceAuth | undefined;
  readonly #resolver: HostResolver;
  readonly #clientName: string | undefined;
  readonly #sessionId: string | undefined;
  /** Own redactor so even a caller without one cannot leak the credential (NFR-22). */
  readonly #redactors: readonly Redactor[];

  /** Learnable only from `/config`; before that the secret header is the safe default. */
  #authMode: "none" | "secret" | "token" | undefined;
  #cachedConfig: HubConfig | undefined;
  /** One shared in-flight `/config` load; all concurrent callers await this same promise. */
  #configPromise: Promise<HubConfig> | undefined;
  #unverified = false;
  #initialized: Promise<void> | undefined;
  #rpcId = 0;

  constructor(options: InstanceClientOptions) {
    this.id = options.id;
    this.#expectedApp = options.app;
    this.mode = options.mode === "write" ? "write" : "read";
    this.base = options.base.replace(/\/+$/u, "");
    this.#allowInsecure = options.allowInsecure === true;
    this.#timeoutMs =
      typeof options.timeoutMs === "number" && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_CLIENT_TIMEOUT_MS;
    this.#fetchImpl = options.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
    this.#auth = options.auth;
    /* Default on purpose: a client without a resolver would never see a DNS answer, so an
     * attacker-controlled hostname could point at link-local space unchecked (F-01). */
    this.#resolver = options.resolver ?? createDnsResolver();
    this.#clientName = options.clientName;
    this.#sessionId = options.sessionId;

    const redactors: Redactor[] = [];
    if (options.redactor !== undefined) redactors.push(options.redactor);
    if (options.auth !== undefined && options.auth.value !== "") {
      redactors.push(new Redactor([options.auth.value]));
    }
    this.#redactors = redactors;
  }

  /**
   * App identity: the hub's own `/config.app` wins once known, the registry expectation is only
   * the fallback (live identity beats a stale registry entry, F-05).
   */
  get app(): string | undefined {
    return this.#cachedConfig?.app ?? this.#expectedApp;
  }

  /** True when the last `/config` did not name an `app`; never set for a missing `federates`. */
  get unverified(): boolean {
    return this.#unverified;
  }

  /** Environment reported by `/config`, once the client has seen it. */
  get environment(): Environment | undefined {
    return this.#cachedConfig?.environment;
  }

  /** Version reported by `/config`, once the client has seen it. */
  get version(): string | undefined {
    return this.#cachedConfig?.version;
  }

  /* ----------------------------------------------------------------------------------------------
   * Discovery
   * -------------------------------------------------------------------------------------------- */

  /** The cached `/config`. Only the first successful answer is reused. */
  async config(): Promise<HubConfig> {
    if (this.#cachedConfig !== undefined) return this.#cachedConfig;
    return this.#loadConfig();
  }

  /**
   * Fresh `/config` plus `/health`. Rev. 4 decision 1: a hub that does not answer `federates` with
   * a boolean is not federatable (`federates_missing`) — a missing field is never "unverified".
   * `unverified` is reserved for a readable hub that merely lacks `app`.
   */
  async health(): Promise<HubHealth> {
    const config = await this.#loadConfig();

    if (typeof config.federates !== "boolean") {
      throw this.#failure(
        "federates_missing",
        `instance "${this.id}" does not report a boolean "federates" in /config; it is not a 0.10 hub`,
      );
    }
    if (config.federates) {
      throw this.#failure(
        "nested_federation",
        `instance "${this.id}" declares federates:true — a federating hub cannot be a federation member`,
      );
    }

    const configApp = typeof config.app === "string" && config.app !== "" ? config.app : undefined;
    /* Compare against the registry expectation, not the getter: the fresh `/config` has just
     * updated the cached identity, so the getter would always agree with itself. */
    if (this.#expectedApp !== undefined && configApp !== undefined && configApp !== this.#expectedApp) {
      throw this.#failure(
        "identity_mismatch",
        `instance "${this.id}" reports app "${configApp}" but the registry expects "${this.#expectedApp}"`,
      );
    }

    const payload = await this.#requestJson("GET", "/health", {});
    if (!isRecord(payload)) {
      throw this.#failure("invalid_response", `instance "${this.id}" returned a non-object /health`);
    }

    const result: HubHealth = {
      ok: payload["ok"] === true,
      federates: false,
    };
    if (configApp !== undefined) result.app = configApp;
    else result.unverified = true;
    if (config.environment !== undefined) result.environment = config.environment;
    if (config.readOnly !== undefined) result.readOnly = config.readOnly;

    const version = typeof payload["version"] === "string" ? payload["version"] : config.version;
    if (version !== undefined) result.version = version;

    return result;
  }

  /* ----------------------------------------------------------------------------------------------
   * Notes
   * -------------------------------------------------------------------------------------------- */

  async list(filter: NoteFilter): Promise<Note[]> {
    const query = noteFilterQuery(filter);
    const payload = await this.#requestJson("GET", "/notes", { query });
    const notes = isRecord(payload) ? payload["notes"] : undefined;
    if (!Array.isArray(notes)) {
      throw this.#failure("invalid_response", `instance "${this.id}" returned no note list`);
    }
    /* Validate every entry here so a malformed payload is a redacted `invalid_response`, not a
     * raw `TypeError` later in the aggregate (F-22). */
    for (const entry of notes) {
      if (!isRecord(entry) || typeof entry["id"] !== "string") {
        throw this.#failure(
          "invalid_response",
          `instance "${this.id}" returned a note list with a malformed entry`,
        );
      }
    }
    return notes as Note[];
  }

  async getNote(id: string): Promise<Note> {
    assertFederatableNoteId(id);
    const payload = await this.#requestJson("GET", `/notes/${encodeURIComponent(id)}`, {});
    return this.#noteFrom(payload, `note ${id}`);
  }

  async createNote(draft: NoteDraft): Promise<Note> {
    const payload = await this.#requestJson("POST", "/notes", { body: draft });
    return this.#noteFrom(payload, "the created note");
  }

  async updateNote(id: string, patch: NotePatch): Promise<Note> {
    assertFederatableNoteId(id);
    const payload = await this.#requestJson("PATCH", `/notes/${encodeURIComponent(id)}`, {
      body: patch,
    });
    return this.#noteFrom(payload, `note ${id}`);
  }

  async addMessage(id: string, message: Message): Promise<Note> {
    assertFederatableNoteId(id);
    const payload = await this.#requestJson(
      "POST",
      `/notes/${encodeURIComponent(id)}/messages`,
      { body: messageBody(message) },
    );
    return this.#noteFrom(payload, `note ${id}`);
  }

  async bulkRemove(ids: string[]): Promise<{ removed: number }> {
    /* Qualified ids are split by the caller; a slash here would smuggle a path segment. */
    for (const id of ids) assertFederatableNoteId(id);
    const payload = await this.#requestJson("POST", "/notes/bulk-delete", {
      body: { ids: [...ids], confirm: true },
    });
    /* A 200 with no count means the client cannot confirm the delete; reporting 0 would look
     * like a successful no-op instead of a contract violation (F-06). */
    const removed = isRecord(payload) ? payload["removed"] : undefined;
    if (typeof removed !== "number" || !Number.isFinite(removed)) {
      throw this.#failure(
        "invalid_response",
        `instance "${this.id}" returned no removal count for bulk-delete`,
      );
    }
    return { removed };
  }

  async sessions(): Promise<Session[]> {
    const payload = await this.#requestJson("GET", "/sessions", {});
    if (!isRecord(payload) || !Array.isArray(payload["sessions"])) {
      throw this.#failure("invalid_response", `instance "${this.id}" returned no session list`);
    }

    const sessions: Session[] = [];
    for (const entry of payload["sessions"]) {
      if (!isRecord(entry) || typeof entry["ref"] !== "string") continue;
      const ref = entry["ref"];
      sessions.push({
        ref,
        label: typeof entry["label"] === "string" ? entry["label"] : ref,
        createdAt: typeof entry["createdAt"] === "string" ? entry["createdAt"] : "",
      });
    }
    return sessions;
  }

  /** Raw authenticated GET against `{base}{path}`; `path` must start with `/` (no host override). */
  async resource<T = unknown>(path: string): Promise<T> {
    if (!path.startsWith("/")) {
      throw this.#failure("invalid_argument", `resource path must start with "/", got "${path}"`);
    }
    return (await this.#requestJson("GET", path, {})) as T;
  }

  /* ----------------------------------------------------------------------------------------------
   * MCP door (export/import, plan §6)
   * -------------------------------------------------------------------------------------------- */

  async mcpCall(tool: string, args: Record<string, unknown>): Promise<ToolResponse> {
    await this.#ensureInitialized();

    const payload = await this.#requestJson("POST", "/mcp", {
      headers: this.#mcpHeaders(),
      body: {
        jsonrpc: "2.0",
        id: this.#nextRpcId(),
        method: "tools/call",
        params: { name: tool, arguments: args },
      },
    });
    return this.#toolResponse(payload, `tools/call ${tool}`);
  }

  /** Alias so callers can read `call(tool, args)` without knowing the wire name. */
  async call(tool: string, args: Record<string, unknown>): Promise<ToolResponse> {
    return this.mcpCall(tool, args);
  }

  async exportBundle(options: {
    format: "json" | "markdown";
    includeDone: boolean;
  }): Promise<ToolResponse> {
    return this.mcpCall("export_bundle", options);
  }

  async importBundle(
    bundle: unknown,
    options: Record<string, unknown>,
  ): Promise<ToolResponse> {
    return this.mcpCall("import_bundle", { ...options, bundle });
  }

  /* ----------------------------------------------------------------------------------------------
   * Transport
   * -------------------------------------------------------------------------------------------- */

  /**
   * One shared in-flight `/config` load. Every concurrent caller (`config()`, `health()`,
   * `#primeAuth()`) awaits the same promise, so a request that arrives while `/config` is still
   * loading waits for it instead of racing ahead with the secret-header default (N-02).
   *
   * The slot is cleared once the attempt settles: a success is then served from
   * `#cachedConfig`, a failure can be retried. The request itself goes through `#send` directly,
   * never through `#requestJson`, because that path primes auth and would recurse into here.
   */
  #loadConfig(): Promise<HubConfig> {
    if (this.#configPromise !== undefined) return this.#configPromise;

    const attempt = this.#fetchConfig();
    this.#configPromise = attempt;
    const clear = (): void => {
      if (this.#configPromise === attempt) this.#configPromise = undefined;
    };
    attempt.then(clear, clear);
    return attempt;
  }

  /** `GET /config` without priming; only {@link #loadConfig} calls this. */
  async #fetchConfig(): Promise<HubConfig> {
    const response = await this.#send("GET", "/config", {});
    const payload = await this.#readJson(response, "GET /config");
    const config = parseConfig(payload);
    if (config === null) {
      throw this.#failure(
        "invalid_response",
        `instance "${this.id}" returned a non-object /config`,
      );
    }
    this.#cachedConfig = config;
    this.#authMode = config.auth;
    // `unverified` describes identity only; `federates` has its own start error.
    this.#unverified = typeof config.app !== "string" || config.app === "";
    return config;
  }

  #noteFrom(payload: unknown, label: string): Note {
    const note = isRecord(payload) ? payload["note"] : undefined;
    // A note without a string id is malformed, not merely unexpected: fail as a response error.
    if (!isRecord(note) || typeof note["id"] !== "string") {
      throw this.#failure("invalid_response", `instance "${this.id}" returned no ${label}`);
    }
    return note as unknown as Note;
  }

  async #requestJson(
    method: string,
    path: string,
    init: RequestInitLike,
  ): Promise<unknown> {
    /* Learn the auth mode before any non-config request, so a token hub receives its first
     * `/notes` call with `Authorization`, not the secret-header default (F-21). */
    await this.#primeAuth();
    const response = await this.#send(method, path, init);
    return this.#readJson(response, `${method} ${path}`);
  }

  /**
   * Fetches `/config` once when a credential is configured without an explicit header. An
   * explicit header/scheme is already unambiguous, so priming would be a wasted roundtrip.
   *
   * Concurrent callers all await the shared in-flight load (N-02). If the priming fetch fails we
   * deliberately swallow the error and fall back to the secret-header default: the operation must
   * still run so its own outcome (usually a 401 → `missing_credential` on a token hub) is what the
   * caller sees, not the incidental `/config` error of a load the caller never asked for.
   */
  async #primeAuth(): Promise<void> {
    const auth = this.#auth;
    if (auth === undefined || auth.header !== undefined) return;
    if (this.#cachedConfig !== undefined) return;
    try {
      await this.config();
    } catch {
      /* Fall through to the default `x-bluepencil-auth` header; see the method comment. */
    }
  }

  /** Reads a body without ever letting a read failure surface as a raw error (F-14). */
  async #bodyText(response: Response, label: string): Promise<string> {
    try {
      return await response.text();
    } catch (error) {
      if (!response.ok) {
        // The status is still a fact, even when the body is unreadable.
        throw this.#httpFailure(response.status, "");
      }
      throw this.#failure(
        "instance_unreachable",
        `${label}: response body could not be read: ${messageOf(error)}`,
        { status: response.status },
      );
    }
  }

  async #readJson(response: Response, label: string): Promise<unknown> {
    if (response.status >= 300 && response.status < 400) {
      throw this.#failure(
        "invalid_response",
        `${label}: redirect refused (${response.status}); the client does not follow redirects`,
        { status: response.status },
      );
    }

    const text = await this.#bodyText(response, label);

    if (!response.ok) {
      throw this.#httpFailure(response.status, text);
    }
    if (text.trim() === "") {
      throw this.#failure("invalid_response", `${label}: expected JSON, got an empty body`, {
        status: response.status,
      });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw this.#failure("invalid_response", `${label}: expected JSON`, {
        status: response.status,
      });
    }
  }

  /** Used for notifications, whose documented answer is 202 with an empty body. */
  async #readNone(response: Response, label: string): Promise<void> {
    if (response.status >= 300 && response.status < 400) {
      throw this.#failure(
        "invalid_response",
        `${label}: redirect refused (${response.status}); the client does not follow redirects`,
        { status: response.status },
      );
    }

    const text = await this.#bodyText(response, label);
    if (!response.ok) {
      throw this.#httpFailure(response.status, text);
    }
  }

  /**
   * Non-2xx handling. The server's own `error.code` wins when it is a code we know (plan §7);
   * otherwise the HTTP status is the fallback. The documented `{error:{message}}` supplies the
   * (redacted) text. A non-JSON body is diagnosed but still mapped through the status.
   */
  #httpFailure(status: number, text: string): FederationError {
    const trimmed = text.trim();

    if (trimmed !== "") {
      let parsed: unknown;
      let isJson = false;
      try {
        parsed = JSON.parse(trimmed);
        isJson = true;
      } catch {
        isJson = false;
      }

      if (!isJson) {
        const snippet = trimmed.replace(/\s+/gu, " ").slice(0, 200);
        return this.#failure(mapHttpStatus(status), `HTTP ${status}: ${snippet}`, { status });
      }

      if (isRecord(parsed) && isRecord(parsed["error"])) {
        const code = mapServerCode(parsed["error"]["code"]) ?? mapHttpStatus(status);
        const serverMessage = parsed["error"]["message"];
        if (typeof serverMessage === "string" && serverMessage !== "") {
          return this.#failure(code, `HTTP ${status}: ${serverMessage}`, { status });
        }
        return this.#failure(code, `HTTP ${status}`, { status });
      }
    }

    return this.#failure(mapHttpStatus(status), `HTTP ${status}`, { status });
  }

  /** One HTTP exchange with pre-flight policy, timeout and redirect refusal. */
  async #send(method: string, path: string, init: RequestInitLike): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    /* The deadline starts before the pre-flight check: a resolver that never answers would
     * otherwise escape the request timeout entirely (F-09). */
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);

    /* A real `fetch` rejects on abort, but an injected or non-conforming implementation may keep a
     * promise pending forever. Racing against the abort event is what makes T15 deterministic. */
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("request aborted")), {
        once: true,
      });
    });
    aborted.catch(() => {});

    let phase: "check" | "fetch" = "check";
    try {
      // The DNS/address gate shares the same budget as the request that follows it.
      await Promise.race([this.#checkBase(), aborted]);

      const fetchImpl = this.#fetchImpl;
      if (fetchImpl === undefined) {
        throw this.#failure(
          "invalid_argument",
          "no fetch implementation available; pass fetchImpl (Node 20+, browser or test stub)",
        );
      }

      const url = this.#url(path, init.query);
      const headers: Record<string, string> = { Accept: "application/json" };
      Object.assign(headers, init.headers ?? {});
      Object.assign(headers, this.#authHeader());

      const requestInit: RequestInit = {
        method,
        headers,
        redirect: "manual",
        signal: controller.signal,
      };

      if (init.body !== undefined) {
        headers["Content-Type"] = "application/json";
        requestInit.body = JSON.stringify(init.body);
      }

      phase = "fetch";
      return await Promise.race([fetchImpl(url, requestInit), aborted]);
    } catch (error) {
      // Policy and contract failures already carry their canonical code.
      if (error instanceof FederationError) throw error;
      const url = this.#url(path, init.query);
      if (timedOut) {
        throw this.#failure(
          "timeout",
          `${method} ${url} timed out after ${this.#timeoutMs} ms`,
        );
      }
      if (phase === "check") throw error;
      throw this.#failure(
        "instance_unreachable",
        `${method} ${url} failed: ${messageOf(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** DNS-rebinding gate: every request re-checks the base URL before any socket is opened. */
  async #checkBase(): Promise<void> {
    try {
      await checkBaseUrl(this.base, {
        allowInsecure: this.#allowInsecure,
        resolver: this.#resolver,
      });
    } catch (error) {
      if (error instanceof UrlPolicyError) {
        throw this.#failure(
          "invalid_base_url",
          `base URL rejected for instance "${this.id}": ${error.reason}: ${error.message}`,
        );
      }
      throw error;
    }
  }

  #url(path: string, query: URLSearchParams | undefined): string {
    const suffix = query === undefined || query.toString() === "" ? "" : `?${query.toString()}`;
    return `${this.base}${path}${suffix}`;
  }

  /**
   * Derives the auth header for this request. An explicit registry header/scheme always wins.
   * Before `/config` is known the secret header is used; afterwards `auth:"token"` switches to
   * `Authorization: Bearer …`.
   */
  #authHeader(): Record<string, string> {
    const auth = this.#auth;
    if (auth === undefined) return {};
    if (auth.header !== undefined) {
      return {
        [auth.header]: auth.scheme === undefined ? auth.value : `${auth.scheme} ${auth.value}`,
      };
    }
    if (this.#authMode === "token") {
      return { [TOKEN_AUTH_HEADER]: `Bearer ${auth.value}` };
    }
    return { [DEFAULT_AUTH_HEADER]: auth.value };
  }

  #mcpHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.#clientName !== undefined) headers["x-bluepencil-client"] = this.#clientName;
    if (this.#sessionId !== undefined) headers["mcp-session-id"] = this.#sessionId;
    return headers;
  }

  #nextRpcId(): number {
    this.#rpcId += 1;
    return this.#rpcId;
  }

  /* ----------------------------------------------------------------------------------------------
   * MCP handshake
   * -------------------------------------------------------------------------------------------- */

  /** Concurrent callers share one in-flight handshake; a failure frees the slot for a retry. */
  #ensureInitialized(): Promise<void> {
    if (this.#initialized === undefined) {
      const attempt = this.#initializeOnce();
      this.#initialized = attempt.catch((error: unknown) => {
        if (this.#initialized === attempt) this.#initialized = undefined;
        throw error;
      });
    }
    return this.#initialized;
  }

  async #initializeOnce(): Promise<void> {
    /* Load /config first so the initialize request already carries the right auth header for
     * token-authenticated hubs. The call is cached, so this costs one request per client. */
    await this.config();

    const response = await this.#send("POST", "/mcp", {
      headers: this.#mcpHeaders(),
      body: {
        jsonrpc: "2.0",
        id: this.#nextRpcId(),
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: this.#clientName ?? DEFAULT_MCP_CLIENT_NAME,
            version: VERSION,
          },
        },
      },
    });
    const payload = await this.#readJson(response, "initialize");
    if (isRecord(payload) && isRecord(payload["error"])) {
      throw this.#rpcFailure(payload["error"], "initialize");
    }

    const notification = await this.#send("POST", "/mcp", {
      headers: this.#mcpHeaders(),
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    await this.#readNone(notification, "notifications/initialized");
  }

  /** JSON-RPC error → canonical code. A malformed result is `invalid_response`. */
  #toolResponse(payload: unknown, label: string): ToolResponse {
    if (!isRecord(payload)) {
      throw this.#failure("invalid_response", `${label}: JSON-RPC response is not an object`);
    }
    if (isRecord(payload["error"])) {
      throw this.#rpcFailure(payload["error"], label);
    }

    const result = payload["result"];
    if (!isRecord(result) || !Array.isArray(result["content"])) {
      throw this.#failure("invalid_response", `${label}: JSON-RPC result is not a tool response`);
    }
    return result as unknown as ToolResponse;
  }

  #rpcFailure(error: Record<string, unknown>, label: string): FederationError {
    const code = error["code"];
    const text = typeof error["message"] === "string" ? error["message"] : "no message";
    const mapped: FederationErrorCode =
      code === -32600 || code === -32601 || code === -32602
        ? "invalid_argument"
        : "invalid_response";
    return this.#failure(mapped, `${label}: JSON-RPC error ${String(code)}: ${text}`);
  }

  /* ----------------------------------------------------------------------------------------------
   * Errors
   * -------------------------------------------------------------------------------------------- */

  #failure(
    code: FederationErrorCode,
    message: string,
    details?: { status?: number },
  ): FederationError {
    let text = message;
    for (const redactor of this.#redactors) text = redactor.redact(text);
    return new FederationError(code, text, {
      instance: this.id,
      ...(details?.status === undefined ? {} : { status: details.status }),
    });
  }
}

/** Factory: the class is one shape, but callers get a typed constructor without `new` friction. */
export function createHttpInstanceClient(options: InstanceClientOptions): InstanceClient {
  return new InstanceClient(options);
}
