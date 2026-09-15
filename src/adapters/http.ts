/**
 * HTTP adapter — a **thin** REST client for the documented contract (ARCHITECTURE §5, FR-6.2/6.3).
 *
 * It maps the transport contract onto the reference server's endpoints and does nothing else: no
 * business logic, no local cache, no retry, no polling (NFR-2). Filter criteria are forwarded as
 * query parameters, JSON in and JSON out. Errors never come back as HTML: every non-2xx response,
 * every non-JSON body and every transport failure is reported by throwing an `Error` carrying the
 * status and the raw body, so a caller or the store can surface it.
 *
 * Endpoints used:
 *   GET    /notes                    list + filter + session export
 *   POST   /notes                    create
 *   PATCH  /notes/{id}               update (status, intent, body, …)
 *   POST   /notes/{id}/messages      append a thread message
 *   POST   /notes/bulk-delete        remove / bulk remove (filter + confirm token)
 *   GET    /sessions                 sessions of the note set
 *   GET    /health                   liveness of the endpoint
 */
import {
  BluepencilValidationError,
  type Message,
  type Note,
  type NoteDraft,
  type NoteFilter,
  type NotePatch,
  type Session,
} from "../core/model";
import {
  cloneNote,
  cloneNotes,
  coerceNote,
  isRecord,
  type Adapter,
  type AdapterPatch,
} from "../core/adapter";

/** Adapter name reported to the store and to hosts. */
export const HTTP_ADAPTER_NAME = "http";

export interface HttpAdapterOptions {
  /** Base URL of the API, e.g. `/api/v1/bluepencil` or `https://host/api/v1/bluepencil`. */
  endpoint: string;
  /** Evaluated on **every** request, so refreshed tokens are picked up (FR-9.1). */
  headers?: () => Record<string, string>;
  /** Injectable for tests and for runtimes without a global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface HttpHealth {
  ok: boolean;
  status?: string;
  version?: string;
}

/** The transport contract plus the two read-only endpoints a host may want to probe. */
export type HttpAdapter = Adapter & {
  health(): Promise<HttpHealth>;
  sessions(): Promise<Session[]>;
};

/** Raised for any non-2xx status, any non-JSON body and any transport failure. */
export class HttpAdapterError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(details: { status: number; body: string; method: string; url: string; reason?: string }) {
    super(formatMessage(details));
    this.name = "HttpAdapterError";
    this.status = details.status;
    this.body = details.body;
  }
}

function formatMessage(details: {
  status: number;
  body: string;
  method: string;
  url: string;
  reason?: string;
}): string {
  const snippet = details.body.replace(/\s+/g, " ").trim().slice(0, 200);
  const fallbackReason = /^\s*</.test(details.body) ? "endpoint returned HTML instead of JSON" : undefined;
  const reason = details.reason ?? fallbackReason;
  return [
    `bluepencil http: ${details.method} ${details.url} → ${details.status}`,
    reason ? ` (${reason})` : "",
    snippet ? `: ${snippet}` : "",
  ].join("");
}

export function createHttpAdapter(options: HttpAdapterOptions): HttpAdapter {
  const endpoint = options.endpoint?.trim();
  if (!endpoint) {
    throw new BluepencilValidationError([
      'the http adapter needs an endpoint, e.g. createHttpAdapter({ endpoint: "/api/v1/bluepencil" })',
    ]);
  }
  const base = endpoint.replace(/\/+$/, "");

  const request = async (
    method: string,
    path: string,
    init: { query?: URLSearchParams; body?: unknown } = {},
  ): Promise<unknown> => {
    const query = init.query?.toString();
    const url = `${base}${path}${query ? `?${query}` : ""}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(options.headers?.() ?? {}),
    };
    const requestInit: RequestInit = { method, headers };
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
      requestInit.body = JSON.stringify(init.body);
    }

    const fetchImpl = options.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!fetchImpl) {
      throw new BluepencilValidationError([
        "the http adapter needs fetch(): use a browser, Node 20+ or pass fetchImpl",
      ]);
    }

    let response: Response;
    try {
      response = await fetchImpl(url, requestInit);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new HttpAdapterError({
        status: 0,
        body: "",
        method,
        url,
        reason: `request failed: ${reason}`,
      });
    }

    const text = await response.text();
    if (!response.ok) {
      throw new HttpAdapterError({ status: response.status, body: text, method, url });
    }
    if (text.trim() === "") {
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new HttpAdapterError({
        status: response.status,
        body: text,
        method,
        url,
        reason: "response is not JSON",
      });
    }
  };

  const noteFrom = (payload: unknown): Note | null => {
    const direct = coerceNote(payload);
    if (direct) {
      return direct;
    }
    if (!isRecord(payload)) {
      return null;
    }
    const single = coerceNote(payload.note);
    if (single) {
      return single;
    }
    const list = payload.notes;
    if (Array.isArray(list)) {
      return coerceNote(list[0]);
    }
    return null;
  };

  const requireNote = (payload: unknown, action: string): Note => {
    const note = noteFrom(payload);
    if (!note) {
      throw new BluepencilValidationError([`the server returned no note for ${action}`]);
    }
    return note;
  };

  const notesFrom = (payload: unknown): Note[] | null => {
    const list = Array.isArray(payload)
      ? payload
      : isRecord(payload) && Array.isArray(payload.notes)
        ? payload.notes
        : null;
    if (!list) {
      return null;
    }
    const notes: Note[] = [];
    for (const entry of list) {
      const note = coerceNote(entry);
      if (note) {
        notes.push(note);
      }
    }
    return notes;
  };

  const removeViaBulk = async (ids: readonly string[]): Promise<number> => {
    const payload = await request("POST", "/notes/bulk-delete", {
      body: { ids: [...ids], confirm: true },
    });
    return countFrom(payload) ?? ids.length;
  };

  const adapter: HttpAdapter = {
    name: HTTP_ADAPTER_NAME,

    async list(filter?: NoteFilter): Promise<Note[]> {
      const payload = await request("GET", "/notes", { query: toQuery(filter) });
      const notes = notesFrom(payload);
      if (!notes) {
        throw new BluepencilValidationError(["the server response has no note list"]);
      }
      return cloneNotes(notes);
    },

    async create(draft: NoteDraft): Promise<Note> {
      return cloneNote(requireNote(await request("POST", "/notes", { body: draft }), "the created note"));
    },

    async update(id: string, patch: NotePatch): Promise<Note> {
      const { messages, ...fields } = patch as AdapterPatch;
      const path = `/notes/${encodeURIComponent(id)}`;
      let note: Note | null = null;
      if (Object.keys(fields).length > 0 || !messages || messages.length === 0) {
        note = requireNote(await request("PATCH", path, { body: fields }), `note ${id}`);
      }
      for (const message of messages ?? []) {
        note = requireNote(
          await request("POST", `${path}/messages`, { body: toMessagePayload(message) }),
          `note ${id}`,
        );
      }
      if (!note) {
        throw new BluepencilValidationError([`the server returned no note for ${id}`]);
      }
      return cloneNote(note);
    },

    async remove(id: string): Promise<void> {
      await removeViaBulk([id]);
    },

    async bulkRemove(filter: NoteFilter): Promise<{ removed: number }> {
      const payload = await request("POST", "/notes/bulk-delete", {
        body: { filter, confirm: true },
      });
      return { removed: countFrom(payload) ?? 0 };
    },

    async exportSession(sessionRef: string): Promise<Note[]> {
      const query = new URLSearchParams();
      query.set("session", sessionRef);
      const payload = await request("GET", "/notes", { query });
      const notes = notesFrom(payload);
      if (!notes) {
        throw new BluepencilValidationError(["the server response has no note list"]);
      }
      return cloneNotes(notes);
    },

    async health(): Promise<HttpHealth> {
      const payload = await request("GET", "/health");
      if (!isRecord(payload)) {
        return { ok: false };
      }
      const health: HttpHealth = { ok: payload.ok === true };
      if (typeof payload.status === "string") {
        health.status = payload.status;
      }
      if (typeof payload.version === "string") {
        health.version = payload.version;
      }
      return health;
    },

    async sessions(): Promise<Session[]> {
      const payload = await request("GET", "/sessions");
      const raw = isRecord(payload) && Array.isArray(payload.sessions) ? payload.sessions : null;
      if (!raw) {
        throw new BluepencilValidationError(["the server response has no session list"]);
      }
      const sessions: Session[] = [];
      for (const entry of raw) {
        if (!isRecord(entry) || typeof entry.ref !== "string") {
          continue;
        }
        sessions.push({
          ref: entry.ref,
          label: typeof entry.label === "string" ? entry.label : entry.ref,
          createdAt: typeof entry.createdAt === "string" ? entry.createdAt : "",
        });
      }
      return sessions;
    },
  };
  return adapter;
}

/** Forwards the filter as query parameters (arrays as repeated parameters). */
function toQuery(filter?: NoteFilter): URLSearchParams {
  const query = new URLSearchParams();
  if (!filter) {
    return query;
  }
  if (filter.route !== undefined) {
    query.set("route", filter.route);
  }
  if (filter.intent !== undefined) {
    query.set("intent", filter.intent);
  }
  if (filter.type !== undefined) {
    query.set("type", filter.type);
  }
  if (filter.session !== undefined) {
    query.set("session", filter.session);
  }
  if (filter.source !== undefined) {
    query.set("source", filter.source);
  }
  if (filter.environment !== undefined) {
    query.set("environment", filter.environment);
  }
  if (filter.includeDone !== undefined) {
    query.set("includeDone", String(filter.includeDone));
  }
  if (filter.since !== undefined) {
    query.set("since", filter.since);
  }
  if (filter.status !== undefined) {
    for (const status of Array.isArray(filter.status) ? filter.status : [filter.status]) {
      query.append("status", status);
    }
  }
  return query;
}

/** Request payload for `POST /notes/{id}/messages` — snake_case as documented (ARCHITECTURE §5). */
function toMessagePayload(message: Message): Record<string, string> {
  return {
    id: message.id,
    ts: message.ts,
    text: message.text,
    author: message.author,
    author_type: message.authorType,
    kind: message.kind,
  };
}

/** Reads the removal count from any of the documented/expected response shapes. */
function countFrom(payload: unknown): number | null {
  if (!isRecord(payload)) {
    return null;
  }
  for (const key of ["removed", "deleted", "count"] as const) {
    const value = payload[key];
    if (typeof value === "number") {
      return value;
    }
  }
  return null;
}
