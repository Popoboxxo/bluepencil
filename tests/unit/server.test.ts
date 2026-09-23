/**
 * Sidecar server tests (FR-17 §3 — the frozen embed/attach contract).
 *
 * `server/handler.ts` is the pure half of the sidecar, so the whole documented contract is tested
 * here without a socket: health, list filters (route/session/includeDone/status), create with an
 * invalid payload, patch, message append, bulk-delete with and without `confirm`, sessions, the
 * canonical bundle, the documented status codes (400/403/404/405/413/415/500) and the error shape
 * `{ error: { code, message } }`, plus environment isolation (NFR-18) and the Markdown mirror.
 *
 * `server/index.ts` owns the OS side and is exercised directly: the atomic store file (no temp
 * litter), the Markdown mirror, the startup read path (a corrupt store refuses to start instead of
 * being served as an empty set) and the CLI parsing. One test drives the real `node:http` glue on
 * an ephemeral port (health, a write, the static `index.html` fallback) and closes it again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as nodeRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNote, type Environment, type Note, type NoteDraft } from "../../src/core/model";
import { toMarkdown } from "../../src/core/export/markdown";
import { createBundle } from "../../src/data/bundle";
import { validateBundle } from "../../src/data/schema";
import {
  DEFAULT_BASE_PATH,
  SERVER_VERSION,
  SIDECAR_APP_NAME,
  handleRequest,
  normalizeBase,
  type HandlerContext,
  type MutationEvent,
  type NoteStoreState,
  type ServerRequest,
  type ServerResponse,
} from "../../server/handler";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  StoreFileError,
  createFileStore,
  loadNotes,
  parseNoteSet,
  parseServerArgs,
  startServer,
  type ServerOptions,
} from "../../server/index";

type Json = Record<string, any>;

const BASE = DEFAULT_BASE_PATH;

/** A fixed clock: every timestamp a test sees is deterministic (NFR-17). */
function fixedClock(start = "2026-09-15T10:00:00.000Z"): () => string {
  let ticks = 0;
  return () => {
    ticks += 1;
    return new Date(Date.parse(start) + ticks * 1000).toISOString();
  };
}

function draft(overrides: Partial<NoteDraft> = {}): NoteDraft {
  return {
    type: "text",
    body: "first note",
    anchor: { hook: "checkout-submit", route: "/checkout" },
    ...overrides,
  };
}

/** A valid note with a fixed id/creation time, built through the shared factory. */
function note(id: string, createdAt: string, overrides: Partial<NoteDraft> = {}): Note {
  return createNote({ ...draft(), id, now: createdAt, ...overrides });
}

/** Builds one request; `contentType: null` means "send the body without a content type". */
function request(
  method: string,
  url: string,
  init: { body?: unknown; contentType?: string | null; headers?: Record<string, string> } = {},
): ServerRequest {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body = "";
  if (init.body !== undefined) {
    body = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
    const contentType = init.contentType === undefined ? "application/json" : init.contentType;
    if (contentType !== null) headers["content-type"] = contentType;
  }
  return { method, url: url.startsWith("http") ? url : `${BASE}${url}`, headers, body };
}

function jsonOf(response: ServerResponse): Json {
  return JSON.parse(response.body) as Json;
}

interface Harness {
  context: HandlerContext;
  state: NoteStoreState;
  /** How often the persist hook ran. */
  saves(): number;
  /** The mutation events the persist hook saw, in order — what a journal records (FR-18). */
  events(): (MutationEvent | undefined)[];
  call(request: ServerRequest): ServerResponse;
}

function createHarness(
  options: {
    notes?: Note[];
    readOnly?: boolean;
    allowEnvMismatch?: boolean;
    cors?: string;
    base?: string;
    environment?: Environment;
    persist?: (state: NoteStoreState, event?: MutationEvent) => void;
  } = {},
): Harness {
  const state: NoteStoreState = { notes: options.notes ? [...options.notes] : [] };
  const persist = vi.fn(options.persist ?? ((): void => undefined));
  const context: HandlerContext = {
    store: state,
    base: options.base ?? BASE,
    environment: options.environment ?? "dev",
    readOnly: options.readOnly ?? false,
    allowEnvMismatch: options.allowEnvMismatch ?? false,
    appName: "test-app",
    now: fixedClock(),
    persist,
    ...(options.cors !== undefined ? { cors: options.cors } : {}),
  };
  return {
    context,
    state,
    saves: () => persist.mock.calls.length,
    events: () => persist.mock.calls.map((call) => call[1] as MutationEvent | undefined),
    call: (input) => handleRequest(input, context),
  };
}

/** Four notes across two routes, two sessions, three statuses and two intents. */
function seedNotes(): Note[] {
  return [
    note("n1", "2026-09-15T09:00:01.000Z", { sessionRef: "s1" }),
    note("n2", "2026-09-15T09:00:02.000Z", { sessionRef: "s1", status: "done" }),
    note("n3", "2026-09-15T09:00:03.000Z", {
      sessionRef: "s2",
      status: "needs_decision",
      anchor: { hook: "cart-total", route: "/cart" },
    }),
    note("n4", "2026-09-15T09:00:04.000Z", {
      sessionRef: "s2",
      intent: "feedback",
      anchor: { hook: "cart-empty", route: "/cart" },
    }),
  ];
}

function idsOf(response: ServerResponse): string[] {
  const notes = jsonOf(response).notes;
  return Array.isArray(notes) ? notes.map((entry: Json) => entry.id as string) : [];
}

describe("sidecar handler — the documented endpoints", () => {
  it("answers GET {base}/health with ok, status and version", () => {
    const harness = createHarness();
    const response = harness.call(request("GET", "/health"));
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    const body = jsonOf(response);
    expect(body.ok).toBe(true);
    expect(body.status).toBe("ok");
    expect(body.version).toBe(SERVER_VERSION);
    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
  });

  describe("GET {base}/notes", () => {
    it("returns every note in the shared review order and canonical form", () => {
      const harness = createHarness({ notes: seedNotes() });
      const response = harness.call(request("GET", "/notes"));
      expect(response.status).toBe(200);
      // FR-4.6: needs_decision, feedback, open, done.
      expect(idsOf(response)).toEqual(["n3", "n4", "n1", "n2"]);
      const first = jsonOf(response).notes[0];
      expect(Object.keys(first)).toEqual([
        "id",
        "schemaVersion",
        "createdAt",
        "updatedAt",
        "sessionRef",
        "type",
        "intent",
        "status",
        "body",
        "author",
        "authorType",
        "anchor",
        "context",
        "messages",
        "source",
        "environment",
      ]);
    });

    it("filters by route", () => {
      const harness = createHarness({ notes: seedNotes() });
      expect(idsOf(harness.call(request("GET", "/notes?route=/checkout")))).toEqual(["n1", "n2"]);
      expect(idsOf(harness.call(request("GET", `/notes?route=${encodeURIComponent("/cart")}`)))).toEqual([
        "n3",
        "n4",
      ]);
    });

    it("filters by session", () => {
      const harness = createHarness({ notes: seedNotes() });
      expect(idsOf(harness.call(request("GET", "/notes?session=s2")))).toEqual(["n3", "n4"]);
      expect(idsOf(harness.call(request("GET", "/notes?session=unknown")))).toEqual([]);
    });

    it("drops done notes with includeDone=false", () => {
      const harness = createHarness({ notes: seedNotes() });
      expect(idsOf(harness.call(request("GET", "/notes?includeDone=false")))).toEqual(["n3", "n4", "n1"]);
    });

    it("keeps an explicit status filter even when includeDone=false (shared rule)", () => {
      const harness = createHarness({ notes: seedNotes() });
      expect(idsOf(harness.call(request("GET", "/notes?status=done&includeDone=false")))).toEqual(["n2"]);
    });

    it("accepts a repeated status filter", () => {
      const harness = createHarness({ notes: seedNotes() });
      // n4 is `open` with `intent: feedback`, so status=open legitimately matches it too.
      expect(idsOf(harness.call(request("GET", "/notes?status=open&status=needs_decision")))).toEqual([
        "n3",
        "n4",
        "n1",
      ]);
      expect(idsOf(harness.call(request("GET", "/notes?status=needs_decision")))).toEqual(["n3"]);
      expect(idsOf(harness.call(request("GET", "/notes?status=open&status=done")))).toEqual(["n4", "n1", "n2"]);
    });

    it("filters by intent, type, source and since", () => {
      const harness = createHarness({ notes: seedNotes() });
      expect(idsOf(harness.call(request("GET", "/notes?intent=feedback")))).toEqual(["n4"]);
      expect(idsOf(harness.call(request("GET", "/notes?type=text")))).toEqual(["n3", "n4", "n1", "n2"]);
      expect(idsOf(harness.call(request("GET", "/notes?type=design")))).toEqual([]);
      expect(idsOf(harness.call(request("GET", "/notes?source=ui:human")))).toEqual(["n3", "n4", "n1", "n2"]);
      expect(idsOf(harness.call(request("GET", "/notes?since=2026-09-15T09:00:03.000Z")))).toEqual(["n3", "n4"]);
    });

    it("refuses an invalid filter value with 400 invalid_query", () => {
      const harness = createHarness({ notes: seedNotes() });
      const response = harness.call(request("GET", "/notes?status=broken"));
      expect(response.status).toBe(400);
      expect(jsonOf(response).error.code).toBe("invalid_query");
      expect(harness.call(request("GET", "/notes?includeDone=maybe")).status).toBe(400);
      expect(harness.call(request("GET", "/notes?environment=staging")).status).toBe(200);
      expect(harness.call(request("GET", "/notes?environment=prod")).status).toBe(400);
    });
  });

  describe("POST {base}/notes", () => {
    it("creates a note, answers it canonically and persists exactly once", () => {
      const harness = createHarness();
      const response = harness.call(request("POST", "/notes", { body: draft({ sessionRef: "s1" }) }));
      expect(response.status).toBe(200);
      const body = jsonOf(response);
      expect(body.note.id).toBeTruthy();
      expect(body.note.status).toBe("open");
      expect(body.note.intent).toBe("implement");
      expect(body.note.environment).toBe("dev");
      expect(body.note.sessionRef).toBe("s1");
      expect(body.note.anchor).toEqual({ hook: "checkout-submit", route: "/checkout" });
      expect(harness.state.notes).toHaveLength(1);
      expect(harness.saves()).toBe(1);
    });

    it("refuses an invalid payload with 400 and the issue list", () => {
      const harness = createHarness();
      const response = harness.call(
        request("POST", "/notes", { body: { type: "nonsense", body: "  ", anchor: {} } }),
      );
      expect(response.status).toBe(400);
      const error = jsonOf(response).error;
      expect(error.code).toBe("invalid_payload");
      expect(error.message).toContain("body must be a non-empty string");
      expect(error.message).toContain("type must be one of text, design");
      expect(error.message).toContain("anchor needs at least one of hook, selector or quote");
      expect(harness.state.notes).toEqual([]);
      expect(harness.saves()).toBe(0);
    });

    it("refuses a second note with the same id", () => {
      const harness = createHarness({ notes: [note("n1", "2026-09-15T09:00:01.000Z")] });
      const response = harness.call(request("POST", "/notes", { body: draft({ id: "n1" }) }));
      expect(response.status).toBe(400);
      expect(jsonOf(response).error.code).toBe("duplicate_id");
    });

    it("refuses every write while --read-only and keeps the set untouched", () => {
      const harness = createHarness({ notes: seedNotes(), readOnly: true });
      const response = harness.call(request("POST", "/notes", { body: draft() }));
      expect(response.status).toBe(403);
      expect(jsonOf(response).error.code).toBe("read_only");
      expect(harness.state.notes).toHaveLength(4);
      expect(harness.saves()).toBe(0);
      // reads keep working
      expect(harness.call(request("GET", "/notes")).status).toBe(200);
    });
  });

  describe("PATCH {base}/notes/{id}", () => {
    it("applies the patch, bumps updatedAt and persists", () => {
      const harness = createHarness({ notes: [note("n1", "2026-09-15T09:00:01.000Z")] });
      const response = harness.call(
        request("PATCH", "/notes/n1", { body: { status: "done", body: "rewritten", ticketRef: "ABC-7" } }),
      );
      expect(response.status).toBe(200);
      const updated = jsonOf(response).note;
      expect(updated.status).toBe("done");
      expect(updated.body).toBe("rewritten");
      expect(updated.ticketRef).toBe("ABC-7");
      expect(updated.updatedAt).not.toBe("2026-09-15T09:00:01.000Z");
      expect(harness.state.notes[0]?.status).toBe("done");
      expect(harness.saves()).toBe(1);
    });

    it("answers 404 for an unknown note id", () => {
      const harness = createHarness({ notes: [note("n1", "2026-09-15T09:00:01.000Z")] });
      const response = harness.call(request("PATCH", "/notes/nope", { body: { status: "done" } }));
      expect(response.status).toBe(404);
      expect(jsonOf(response).error.code).toBe("not_found");
      expect(harness.saves()).toBe(0);
    });

    it("refuses immutable or unknown patch fields", () => {
      const harness = createHarness({ notes: [note("n1", "2026-09-15T09:00:01.000Z")] });
      const response = harness.call(request("PATCH", "/notes/n1", { body: { id: "n2", status: "done" } }));
      expect(response.status).toBe(400);
      expect(jsonOf(response).error.message).toContain("unknown patch field(s) id");
    });

    it("surfaces an invalid field value as 400 with the shared issue text", () => {
      const harness = createHarness({ notes: [note("n1", "2026-09-15T09:00:01.000Z")] });
      const response = harness.call(request("PATCH", "/notes/n1", { body: { status: "closed" } }));
      expect(response.status).toBe(400);
      expect(jsonOf(response).error.message).toContain("status must be open, done or needs_decision");
      expect(harness.state.notes[0]?.status).toBe("open");
    });
  });

  describe("POST {base}/notes/{id}/messages", () => {
    it("appends the documented payload to the thread (append-only)", () => {
      const harness = createHarness({ notes: [note("n1", "2026-09-15T09:00:01.000Z")] });
      const response = harness.call(
        request("POST", "/notes/n1/messages", {
          body: {
            id: "m-1",
            ts: "2026-09-15T11:00:00.000Z",
            text: "implemented in abc1234",
            author: "agent",
            author_type: "agent",
            kind: "reply",
          },
        }),
      );
      expect(response.status).toBe(200);
      const updated = jsonOf(response).note;
      expect(updated.messages).toHaveLength(1);
      expect(updated.messages[0]).toEqual({
        id: "m-1",
        ts: "2026-09-15T11:00:00.000Z",
        author: "agent",
        authorType: "agent",
        kind: "reply",
        text: "implemented in abc1234",
      });
      expect(updated.updatedAt).toBe("2026-09-15T11:00:00.000Z");
      expect(harness.saves()).toBe(1);

      // A second message is appended, never replacing the first one (FR-3.3).
      const second = harness.call(
        request("POST", "/notes/n1/messages", {
          body: { ts: "2026-09-15T12:00:00.000Z", text: "and the tests", kind: "reply" },
        }),
      );
      const thread = jsonOf(second).note.messages;
      expect(thread).toHaveLength(2);
      expect(thread.map((entry: Json) => entry.id)).toEqual(["m-1", thread[1].id]);
      expect(thread[1].text).toBe("and the tests");
      expect(jsonOf(second).note.updatedAt).toBe("2026-09-15T12:00:00.000Z");
    });

    it("refuses an unknown message kind or an empty text", () => {
      const harness = createHarness({ notes: [note("n1", "2026-09-15T09:00:01.000Z")] });
      const bad = harness.call(request("POST", "/notes/n1/messages", { body: { text: "x", kind: "shout" } }));
      expect(bad.status).toBe(400);
      expect(jsonOf(bad).error.message).toContain("kind must be one of");
      const empty = harness.call(request("POST", "/notes/n1/messages", { body: { text: "", kind: "note" } }));
      expect(empty.status).toBe(400);
      expect(jsonOf(empty).error.message).toContain("text must be a non-empty string");
      expect(harness.state.notes[0]?.messages).toEqual([]);
    });

    it("answers 404 for an unknown note id", () => {
      const harness = createHarness();
      expect(harness.call(request("POST", "/notes/nope/messages", { body: { text: "hi" } })).status).toBe(404);
    });
  });

  describe("POST {base}/notes/bulk-delete", () => {
    it("refuses without confirm:true and removes nothing", () => {
      const harness = createHarness({ notes: seedNotes() });
      const response = harness.call(request("POST", "/notes/bulk-delete", { body: { ids: ["n1"] } }));
      expect(response.status).toBe(400);
      expect(jsonOf(response).error.code).toBe("confirm_required");
      expect(harness.state.notes).toHaveLength(4);
      expect(harness.saves()).toBe(0);
      expect(harness.call(request("POST", "/notes/bulk-delete", { body: { ids: ["n1"], confirm: false } })).status).toBe(
        400,
      );
    });

    it("removes the given ids once confirmed", () => {
      const harness = createHarness({ notes: seedNotes() });
      const response = harness.call(
        request("POST", "/notes/bulk-delete", { body: { ids: ["n1", "n3", "gone"], confirm: true } }),
      );
      expect(response.status).toBe(200);
      expect(jsonOf(response).removed).toBe(2);
      expect(harness.state.notes.map((entry) => entry.id)).toEqual(["n2", "n4"]);
      expect(harness.saves()).toBe(1);
    });

    it("removes every note matching a filter", () => {
      const harness = createHarness({ notes: seedNotes() });
      const response = harness.call(
        request("POST", "/notes/bulk-delete", { body: { filter: { route: "/cart" }, confirm: true } }),
      );
      expect(response.status).toBe(200);
      expect(jsonOf(response).removed).toBe(2);
      expect(harness.state.notes.map((entry) => entry.id)).toEqual(["n1", "n2"]);
    });

    it("refuses a request without ids and without a filter", () => {
      const harness = createHarness({ notes: seedNotes() });
      const response = harness.call(request("POST", "/notes/bulk-delete", { body: { confirm: true } }));
      expect(response.status).toBe(400);
      expect(jsonOf(response).error.code).toBe("invalid_payload");
      expect(harness.saves()).toBe(0);
    });

    it("refuses a malformed ids value", () => {
      const harness = createHarness({ notes: seedNotes() });
      const response = harness.call(
        request("POST", "/notes/bulk-delete", { body: { ids: "n1", confirm: true } }),
      );
      expect(response.status).toBe(400);
      expect(jsonOf(response).error.message).toContain("ids must be an array of note ids");
    });
  });

  describe("GET {base}/sessions", () => {
    it("derives the sessions from the notes' sessionRef", () => {
      const harness = createHarness({ notes: seedNotes() });
      const response = harness.call(request("GET", "/sessions"));
      expect(response.status).toBe(200);
      expect(jsonOf(response).sessions).toEqual([
        { ref: "s1", label: "s1", createdAt: "2026-09-15T09:00:01.000Z" },
        { ref: "s2", label: "s2", createdAt: "2026-09-15T09:00:03.000Z" },
      ]);
    });

    it("returns no session for an empty set", () => {
      const harness = createHarness();
      expect(jsonOf(harness.call(request("GET", "/sessions"))).sessions).toEqual([]);
    });
  });

  describe("GET {base}/bundle", () => {
    it("returns the canonical bundle of the set", () => {
      const harness = createHarness({ notes: seedNotes() });
      const response = harness.call(request("GET", "/bundle"));
      expect(response.status).toBe(200);
      const bundle = jsonOf(response);
      expect(bundle.kind).toBe("bluepencil.bundle");
      expect(bundle.environment).toBe("dev");
      expect(bundle.app.name).toBe("test-app");
      expect(bundle.sessions.map((session: Json) => session.ref)).toEqual(["s1", "s2"]);
      // Canonical bundle order: by route, then review priority, then creation time (NFR-17).
      expect(bundle.notes.map((entry: Json) => entry.id)).toEqual(["n3", "n4", "n1", "n2"]);
      // The shared validator accepts what the endpoint serves (FR-14.2/F15.3).
      expect(validateBundle(bundle)).toEqual([]);
      expect(response.body.endsWith("\n")).toBe(true);
    });
  });

  describe("routing, methods and the documented error shape", () => {
    const cases: Array<[string, string, string]> = [
      ["POST", "/health", "GET"],
      ["DELETE", "/health", "GET"],
      ["DELETE", "/notes", "GET, POST"],
      ["PUT", "/notes", "GET, POST"],
      ["PUT", "/notes/n1", "GET, PATCH"],
      ["GET", "/notes/bulk-delete", "POST"],
      ["GET", "/notes/n1/messages", "POST"],
      ["PATCH", "/sessions", "GET"],
      ["POST", "/bundle", "GET"],
    ];

    it("answers 405 with an Allow header for a documented path with the wrong method", () => {
      const harness = createHarness({ notes: [note("n1", "2026-09-15T09:00:01.000Z")] });
      for (const [method, path, allow] of cases) {
        const response = harness.call(request(method, path, method === "GET" ? {} : { body: {} }));
        expect(`${method} ${path} -> ${response.status}`).toBe(`${method} ${path} -> 405`);
        expect(response.headers.allow).toBe(allow);
        expect(response.headers["content-type"]).toContain("application/json");
        expect(jsonOf(response).error.code).toBe("method_not_allowed");
      }
    });

    it("answers 404 for an unknown endpoint", () => {
      const harness = createHarness();
      expect(harness.call(request("GET", "/nope")).status).toBe(404);
      expect(harness.call(request("GET", "/notes/n1/extra")).status).toBe(404);
      expect(harness.call(request("GET", "/notes/n1/messages/2")).status).toBe(404);
      expect(harness.call(request("GET", "http://elsewhere.example/notes")).status).toBe(404);
      expect(harness.call(request("GET", "/")).status).toBe(404);
      expect(jsonOf(harness.call(request("GET", "/nope"))).error.code).toBe("not_found");
    });

    it("answers 415 when the body is not application/json", () => {
      const harness = createHarness();
      const wrongType = harness.call(
        request("POST", "/notes", { body: draft(), contentType: "text/plain" }),
      );
      expect(wrongType.status).toBe(415);
      expect(jsonOf(wrongType).error.code).toBe("unsupported_media_type");
      const missingType = harness.call(request("POST", "/notes", { body: draft(), contentType: null }));
      expect(missingType.status).toBe(415);
      // The documented JSON media type with a charset is accepted.
      const withCharset = harness.call(
        request("POST", "/notes", { body: draft(), contentType: "application/json; charset=utf-8" }),
      );
      expect(withCharset.status).toBe(200);
    });

    it("answers 400 for a malformed, empty or non-object body", () => {
      const harness = createHarness();
      const broken = harness.call(request("POST", "/notes", { body: "{not json" }));
      expect(broken.status).toBe(400);
      expect(jsonOf(broken).error.code).toBe("invalid_json");
      expect(harness.call(request("POST", "/notes", { body: "" })).status).toBe(400);
      const list = harness.call(request("POST", "/notes", { body: "[]" }));
      expect(list.status).toBe(400);
      expect(jsonOf(list).error.code).toBe("invalid_payload");
    });

    it("always answers errors as { error: { code, message } }", () => {
      const harness = createHarness({ readOnly: true });
      for (const response of [
        harness.call(request("GET", "/nope")),
        harness.call(request("POST", "/health", { body: {} })),
        harness.call(request("POST", "/notes", { body: draft() })),
      ]) {
        const body = jsonOf(response);
        expect(Object.keys(body)).toEqual(["error"]);
        expect(Object.keys(body.error)).toEqual(["code", "message"]);
        expect(typeof body.error.code).toBe("string");
        expect(typeof body.error.message).toBe("string");
        expect(body.error.message.includes("\n")).toBe(false);
      }
    });

    it("sends no CORS header by default and honours --cors <origin>", () => {
      const plain = createHarness();
      expect(plain.call(request("GET", "/health")).headers["access-control-allow-origin"]).toBeUndefined();

      const open = createHarness({ cors: "*" });
      const allowed = open.call(request("GET", "/health"));
      expect(allowed.headers["access-control-allow-origin"]).toBe("*");
      expect(allowed.headers["access-control-allow-methods"]).toContain("PATCH");

      const preflight = open.call({ method: "OPTIONS", url: `${BASE}/notes`, headers: {}, body: "" });
      expect(preflight.status).toBe(204);
      expect(preflight.body).toBe("");
      expect(preflight.headers["access-control-allow-origin"]).toBe("*");

      const fixed = createHarness({ cors: "https://app.example" });
      const scoped = fixed.call(request("GET", "/health"));
      expect(scoped.headers["access-control-allow-origin"]).toBe("https://app.example");
      expect(scoped.headers.vary).toBe("Origin");
    });

    it("serves a normalised custom base path", () => {
      const harness = createHarness({ base: "/notes-api/" });
      expect(harness.call(request("GET", "http://host/notes-api/health")).status).toBe(200);
      expect(harness.call(request("GET", "http://host/notes-api/notes/")).status).toBe(200);
      expect(harness.call(request("GET", "http://host/notes-api")).status).toBe(404);
      expect(harness.call(request("GET", "http://host/health")).status).toBe(404);
    });

    it("normalises the documented base paths", () => {
      expect(normalizeBase("/api/v1/bluepencil/")).toBe("/api/v1/bluepencil");
      expect(normalizeBase("api/v1/bluepencil")).toBe("/api/v1/bluepencil");
      expect(normalizeBase("/")).toBe("");
      expect(DEFAULT_BASE_PATH).toBe("/api/v1/bluepencil");
    });
  });

  describe("environment isolation (NFR-18)", () => {
    it("refuses a live note on a dev sidecar with 400", () => {
      const harness = createHarness({ environment: "dev" });
      const response = harness.call(request("POST", "/notes", { body: draft({ environment: "live" }) }));
      expect(response.status).toBe(400);
      expect(jsonOf(response).error.code).toBe("environment_mismatch");
      expect(jsonOf(response).error.message).toContain("dev");
      expect(harness.state.notes).toEqual([]);
      expect(harness.saves()).toBe(0);
    });

    it("promotes the note with --allow-env-mismatch instead of storing a foreign stamp", () => {
      const harness = createHarness({ environment: "dev", allowEnvMismatch: true });
      const response = harness.call(request("POST", "/notes", { body: draft({ environment: "live" }) }));
      expect(response.status).toBe(200);
      expect(jsonOf(response).note.environment).toBe("dev");
      expect(harness.state.notes[0]?.environment).toBe("dev");
    });

    it("refuses a patch or a message on a foreign note unless allowed", () => {
      const foreign = createNote({ ...draft(), id: "live-1", now: "2026-09-15T09:00:01.000Z", environment: "live" });
      const harness = createHarness({ notes: [foreign], environment: "dev" });
      expect(harness.call(request("PATCH", "/notes/live-1", { body: { status: "done" } })).status).toBe(400);
      expect(
        harness.call(request("POST", "/notes/live-1/messages", { body: { text: "hello" } })).status,
      ).toBe(400);
      expect(harness.state.notes[0]?.status).toBe("open");
      expect(harness.saves()).toBe(0);
    });

    it("promotes a foreign note once --allow-env-mismatch is set", () => {
      const foreign = createNote({ ...draft(), id: "live-1", now: "2026-09-15T09:00:01.000Z", environment: "live" });
      const harness = createHarness({ notes: [foreign], environment: "dev", allowEnvMismatch: true });
      const response = harness.call(request("PATCH", "/notes/live-1", { body: { status: "done" } }));
      expect(response.status).toBe(200);
      expect(jsonOf(response).note.environment).toBe("dev");
      expect(harness.state.notes[0]?.environment).toBe("dev");
    });

    it("refuses to bulk-delete foreign notes unless allowed", () => {
      const foreign = createNote({ ...draft(), id: "live-1", now: "2026-09-15T09:00:01.000Z", environment: "live" });
      const refused = createHarness({ notes: [foreign], environment: "dev" });
      expect(
        refused.call(
          request("POST", "/notes/bulk-delete", { body: { ids: ["live-1"], confirm: true } }),
        ).status,
      ).toBe(400);
      expect(refused.state.notes).toHaveLength(1);

      const allowed = createHarness({ notes: [foreign], environment: "dev", allowEnvMismatch: true });
      const response = allowed.call(
        request("POST", "/notes/bulk-delete", { body: { ids: ["live-1"], confirm: true } }),
      );
      expect(response.status).toBe(200);
      expect(jsonOf(response).removed).toBe(1);
    });

    it("answers a foreign environment filter without touching the bound one", () => {
      const harness = createHarness({ notes: seedNotes(), environment: "dev" });
      // Reads are not narrowed implicitly: the bound environment decides the writes, the query
      // parameter decides the reads (?environment=… is the documented filter).
      expect(harness.call(request("GET", "/notes?environment=dev")).status).toBe(200);
      expect(jsonOf(harness.call(request("GET", "/notes?environment=live"))).notes).toEqual([]);
    });
  });

  describe("persistence failure", () => {
    it("answers 500 store_write_failed and rolls the mutation back", () => {
      const harness = createHarness({
        notes: [note("n1", "2026-09-15T09:00:01.000Z")],
        persist: () => {
          throw new Error("disk full");
        },
      });
      const created = harness.call(request("POST", "/notes", { body: draft({ id: "n2" }) }));
      expect(created.status).toBe(500);
      expect(jsonOf(created).error.code).toBe("store_write_failed");
      expect(jsonOf(created).error.message).toContain("disk full");
      expect(harness.state.notes.map((entry) => entry.id)).toEqual(["n1"]);

      const patched = harness.call(request("PATCH", "/notes/n1", { body: { status: "done" } }));
      expect(patched.status).toBe(500);
      expect(harness.state.notes[0]?.status).toBe("open");

      const removed = harness.call(
        request("POST", "/notes/bulk-delete", { body: { ids: ["n1"], confirm: true } }),
      );
      expect(removed.status).toBe(500);
      expect(harness.state.notes).toHaveLength(1);
    });
  });
});

describe("sidecar store file", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bluepencil-server-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function contextFor(fileStore: ReturnType<typeof createFileStore>): HandlerContext {
    return {
      store: fileStore.state,
      base: BASE,
      environment: "dev",
      appName: SIDECAR_APP_NAME,
      now: fixedClock(),
      persist: (state) => fileStore.persist(state),
    };
  }

  it("starts empty when the store file does not exist yet", () => {
    const fileStore = createFileStore({ storePath: join(dir, "notes.json"), environment: "dev" });
    expect(fileStore.state.notes).toEqual([]);
    expect(loadNotes(join(dir, "notes.json"))).toEqual([]);
  });

  it("reloads the set from disk at startup and keeps it after a write", () => {
    const storePath = join(dir, "notes.json");
    const existing = [note("n1", "2026-09-15T09:00:01.000Z")];
    writeFileSync(storePath, JSON.stringify(createBundle(existing, { environment: "dev" }), null, 2), "utf8");

    const fileStore = createFileStore({ storePath, environment: "dev" });
    expect(fileStore.state.notes.map((entry) => entry.id)).toEqual(["n1"]);

    // A mutation writes the canonical bundle atomically — and leaves no temp file behind.
    const context = contextFor(fileStore);
    const created = handleRequest(request("POST", "/notes", { body: draft({ id: "n2" }) }), context);
    expect(created.status).toBe(200);
    expect(readdirSync(dir)).toEqual(["notes.json"]);

    const written = JSON.parse(readFileSync(storePath, "utf8")) as Json;
    expect(written.kind).toBe("bluepencil.bundle");
    expect(written.environment).toBe("dev");
    expect(written.notes.map((entry: Json) => entry.id).sort()).toEqual(["n1", "n2"]);
    expect(validateBundle(written)).toEqual([]);

    // The moment the file lands, a second process reads the same set (the source of truth).
    expect(loadNotes(storePath).map((entry) => entry.id).sort()).toEqual(["n1", "n2"]);
  });

  it("writes the Markdown mirror next to the store", () => {
    const storePath = join(dir, "notes.json");
    const mirrorPath = join(dir, "notes.md");
    const fileStore = createFileStore({ storePath, mirror: mirrorPath, environment: "dev" });
    const context = contextFor(fileStore);

    expect(
      handleRequest(
        request("POST", "/notes", {
          body: draft({ id: "n1", body: "make the total bigger", sessionRef: "s1" }),
        }),
        context,
      ).status,
    ).toBe(200);

    const mirror = readFileSync(mirrorPath, "utf8");
    expect(mirror).toBe(
      toMarkdown(fileStore.state.notes, { includeDone: true, title: `${SIDECAR_APP_NAME} review notes` }),
    );
    expect(mirror).toContain(`# ${SIDECAR_APP_NAME} review notes`);
    expect(mirror).toContain("make the total bigger");
    expect(mirror).toContain("hook `checkout-submit`");
    expect(readdirSync(dir).sort()).toEqual(["notes.json", "notes.md"]);
  });

  it("refuses to start on a corrupt store instead of serving an empty set", async () => {
    const storePath = join(dir, "broken.json");
    writeFileSync(storePath, '{"hello":"world"}', "utf8");

    expect(() => loadNotes(storePath)).toThrow(StoreFileError);
    expect(() => loadNotes(storePath)).toThrow(/is not a valid note set/);

    const options: ServerOptions = { storePath, quiet: true };
    await expect(startServer(options)).rejects.toThrow(/is not a valid note set/);
  });

  it("refuses truncated, empty and non-note-set files", () => {
    const cases: Array<[string, string]> = [
      ["truncated.json", '{"kind":"bluepencil.bundle","schemaVersion":1,"notes":[{"id":"n1"'],
      ["empty.json", ""],
      ["array.json", "[1,2,3]"],
      ["junk.json", "not json at all"],
    ];
    for (const [name, content] of cases) {
      const path = join(dir, name);
      writeFileSync(path, content, "utf8");
      expect(() => loadNotes(path)).toThrow(StoreFileError);
    }
    // A valid bundle stays readable.
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify(createBundle([note("n1", "2026-09-15T09:00:01.000Z")], { environment: "dev" })), "utf8");
    expect(loadNotes(good).map((entry) => entry.id)).toEqual(["n1"]);
  });

  it("migrates a legacy note array and a legacy bundle (no schemaVersion)", () => {
    const legacyArray = join(dir, "legacy-array.json");
    writeFileSync(legacyArray, JSON.stringify([{ id: "n1", type: "text", body: "old note", anchor: { hook: "a" } }]), "utf8");
    expect(loadNotes(legacyArray).map((entry) => entry.id)).toEqual(["n1"]);

    const legacyBundle = join(dir, "legacy-bundle.json");
    writeFileSync(legacyBundle, JSON.stringify({ notes: [{ id: "n2", body: "older note", anchor: { quote: "q" } }] }), "utf8");
    expect(loadNotes(legacyBundle).map((entry) => entry.id)).toEqual(["n2"]);

    // A current document is validated, never repaired.
    expect(() =>
      parseNoteSet(
        JSON.stringify({ kind: "bluepencil.bundle", schemaVersion: 1, notes: [{ id: "n3", status: "broken" }] }),
        "inline.json",
      ),
    ).toThrow(/is not a valid note set/);
  });
});

describe("sidecar CLI", () => {
  it("parses the documented flags with their defaults", () => {
    const parsed = parseServerArgs(["--store", "notes.json"]);
    expect(parsed).toEqual({
      storePath: "notes.json",
      port: DEFAULT_PORT,
      environment: "dev",
      readOnly: false,
      allowEnvMismatch: false,
      quiet: false,
    });
  });

  it("accepts every documented flag, in both spelling forms", () => {
    const parsed = parseServerArgs([
      "--store=notes.json",
      "--port",
      "9090",
      "--host",
      "0.0.0.0",
      "--base",
      "/api/notes/",
      "--root",
      "./public",
      "--environment",
      "staging",
      "--read-only",
      "--allow-env-mismatch",
      "--mirror",
      "notes.md",
      "--cors",
      "https://app.example",
      "--quiet",
    ]);
    expect(parsed).toEqual({
      storePath: "notes.json",
      port: 9090,
      host: "0.0.0.0",
      base: "/api/notes/",
      root: "./public",
      environment: "staging",
      readOnly: true,
      allowEnvMismatch: true,
      mirror: "notes.md",
      cors: "https://app.example",
      quiet: true,
    });
    expect(parseServerArgs(["--store", "n.json", "--cors"])).toMatchObject({ cors: "*" });
    // A wildcard CORS origin keeps the defaults for everything else.
    expect(parseServerArgs(["--store", "n.json", "--cors=*"])).toMatchObject({ cors: "*" });
  });

  it("reports usage errors as one line", () => {
    expect(parseServerArgs([])).toContain("--store <path> is required");
    expect(parseServerArgs(["--store", "n.json", "--port", "abc"])).toContain("--port must be an integer");
    expect(parseServerArgs(["--store", "n.json", "--environment", "prod"])).toContain(
      "--environment must be one of dev, staging, live",
    );
  });

  it("exports the documented bind defaults", () => {
    expect(DEFAULT_HOST).toBe("127.0.0.1");
    expect(DEFAULT_PORT).toBe(8787);
  });
});

describe("sidecar over HTTP (node:http glue)", () => {
  let dir = "";
  let running: Awaited<ReturnType<typeof startServer>> | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bluepencil-server-http-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>review</title><h1>deck</h1>", "utf8");
  });

  afterEach(async () => {
    if (running) {
      await running.close();
      running = null;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function call(
    port: number,
    method: string,
    path: string,
    payload?: unknown,
  ): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
    return new Promise((resolvePromise, rejectPromise) => {
      const body = payload === undefined ? undefined : JSON.stringify(payload);
      const requestHeaders: Record<string, string> = body === undefined ? {} : { "content-type": "application/json" };
      const client = nodeRequest(
        { host: DEFAULT_HOST, port, path, method, headers: requestHeaders },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolvePromise({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      client.on("error", rejectPromise);
      if (body !== undefined) client.write(body);
      client.end();
    });
  }

  it("serves health, a write round trip and the static index.html fallback on one port", async () => {
    running = await startServer({
      storePath: join(dir, "notes.json"),
      root: dir,
      port: 0,
      quiet: true,
      environment: "dev",
    });
    const port = running.port;
    expect(port).toBeGreaterThan(0);

    const health = await call(port, "GET", `${BASE}/health`);
    expect(health.status).toBe(200);
    expect((JSON.parse(health.body) as Json).ok).toBe(true);

    const created = await call(port, "POST", `${BASE}/notes`, draft({ id: "http-1" }));
    expect(created.status).toBe(200);
    expect((JSON.parse(created.body) as Json).note.id).toBe("http-1");

    const listed = await call(port, "GET", `${BASE}/notes?includeDone=false`);
    expect((JSON.parse(listed.body) as Json).notes.map((entry: Json) => entry.id)).toEqual(["http-1"]);

    const refused = await call(port, "POST", `${BASE}/notes`, { type: "text", body: "", anchor: {} });
    expect(refused.status).toBe(400);
    expect((JSON.parse(refused.body) as Json).error.code).toBe("invalid_payload");

    // One origin serves the presentation page and the API.
    const page = await call(port, "GET", "/");
    expect(page.status).toBe(200);
    expect(page.body).toContain("<h1>deck</h1>");
    expect(page.headers["content-type"]).toContain("text/html");
    const fallback = await call(port, "GET", "/deep/spa/route");
    expect(fallback.status).toBe(200);
    expect(fallback.body).toContain("<h1>deck</h1>");

    // The write really landed in the store file.
    expect(loadNotes(join(dir, "notes.json")).map((entry) => entry.id)).toEqual(["http-1"]);
  });

  it("refuses every write over HTTP when started read-only", async () => {
    running = await startServer({
      storePath: join(dir, "notes.json"),
      port: 0,
      quiet: true,
      environment: "dev",
      readOnly: true,
    });
    const created = await call(running.port, "POST", `${BASE}/notes`, draft());
    expect(created.status).toBe(403);
    expect((JSON.parse(created.body) as Json).error.code).toBe("read_only");
    // Without --root, a request outside the API is a documented 404 (never HTML).
    const outside = await call(running.port, "GET", "/nope");
    expect(outside.status).toBe(404);
    expect((JSON.parse(outside.body) as Json).error.code).toBe("not_found");
  });

  it("rejects a request body above the documented limit with 413", async () => {
    running = await startServer({ storePath: join(dir, "notes.json"), port: 0, quiet: true });
    const response = await call(running.port, "POST", `${BASE}/notes`, {
      type: "text",
      anchor: { hook: "a" },
      body: "x".repeat(9 * 1024 * 1024),
    });
    expect(response.status).toBe(413);
    expect((JSON.parse(response.body) as Json).error.code).toBe("payload_too_large");
  });

  it("refuses to start on a corrupt store file", async () => {
    const storePath = join(dir, "broken.json");
    writeFileSync(storePath, "}{", "utf8");
    await expect(startServer({ storePath, port: 0, quiet: true })).rejects.toThrow(StoreFileError);
  });
});

describe("sidecar handler — reading one note (GET {base}/notes/{id})", () => {
  it("answers the note canonically, without needing the whole set", () => {
    const harness = createHarness({ notes: seedNotes() });
    const response = harness.call(request("GET", "/notes/n3"));
    expect(response.status).toBe(200);
    const body = jsonOf(response);
    expect(body.note.id).toBe("n3");
    expect(body.note.anchor).toEqual({ hook: "cart-total", route: "/cart" });
    expect(harness.saves()).toBe(0);
  });

  it("answers 404 not_found for an unknown id", () => {
    const harness = createHarness({ notes: seedNotes() });
    const response = harness.call(request("GET", "/notes/n-missing"));
    expect(response.status).toBe(404);
    expect(jsonOf(response).error.code).toBe("not_found");
  });

  it("gates by environment when asked: a foreign note is 404, its own is 200, no filter is no gate", () => {
    const harness = createHarness({
      notes: [
        note("n-dev", "2026-09-15T09:00:01.000Z"),
        note("n-live", "2026-09-15T09:00:02.000Z", { environment: "live" }),
      ],
    });
    expect(harness.call(request("GET", "/notes/n-live?environment=dev")).status).toBe(404);
    expect(harness.call(request("GET", "/notes/n-live?environment=live")).status).toBe(200);
    expect(harness.call(request("GET", "/notes/n-live")).status).toBe(200);
  });

  it("refuses an invalid environment value with 400 invalid_query", () => {
    const harness = createHarness({ notes: seedNotes() });
    const response = harness.call(request("GET", "/notes/n1?environment=prod"));
    expect(response.status).toBe(400);
    expect(jsonOf(response).error.code).toBe("invalid_query");
  });

  it("still refuses DELETE and names both documented methods in Allow", () => {
    const harness = createHarness({ notes: seedNotes() });
    const response = harness.call(request("DELETE", "/notes/n1"));
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe("GET, PATCH");
    expect(harness.saves()).toBe(0);
  });
});

describe("sidecar handler — a create body is not a guessing game", () => {
  it("refuses an unknown field instead of storing nothing and answering 200", () => {
    const harness = createHarness();
    const response = harness.call(
      request("POST", "/notes", { body: { type: "text", body: "x", anchor: { hook: "a" }, bogusField: 1 } }),
    );
    expect(response.status).toBe(400);
    expect(jsonOf(response).error.code).toBe("invalid_payload");
    expect(jsonOf(response).error.message).toContain("bogusField");
    expect(harness.saves()).toBe(0);
    expect(harness.state.notes).toHaveLength(0);
  });

  it("names the right place for the classic near-misses route and session", () => {
    const harness = createHarness();
    const route = harness.call(
      request("POST", "/notes", { body: { type: "text", body: "x", anchor: { hook: "a" }, route: "/cart" } }),
    );
    expect(route.status).toBe(400);
    expect(jsonOf(route).error.message).toContain("anchor.route");

    const session = harness.call(
      request("POST", "/notes", { body: { type: "text", body: "x", anchor: { hook: "a" }, session: "s1" } }),
    );
    expect(jsonOf(session).error.message).toContain("sessionRef");
  });

  it("accepts every field NoteDraft knows, in the correct spelling", () => {
    const harness = createHarness();
    const response = harness.call(
      request("POST", "/notes", {
        body: {
          type: "text",
          body: "x",
          anchor: { hook: "a", route: "/cart" },
          sessionRef: "s1",
          ticketRef: "T-1",
          debug: { commit: "abc" },
        },
      }),
    );
    expect(response.status).toBe(200);
    const created = jsonOf(response).note;
    expect(created.sessionRef).toBe("s1");
    expect(created.anchor.route).toBe("/cart");
    expect(created.ticketRef).toBe("T-1");
  });
});

describe("sidecar handler — the journal's 'who' (FR-18)", () => {
  it("records the X-Bluepencil-Actor header for a create", () => {
    const harness = createHarness();
    harness.call(request("POST", "/notes", { body: draft(), headers: { "x-bluepencil-actor": "dduchrow" } }));
    expect(harness.events()[0]?.actor).toBe("dduchrow");
  });

  it("falls back to the payload author when no header is sent", () => {
    const harness = createHarness();
    harness.call(request("POST", "/notes", { body: draft({ author: "Hermes" }) }));
    expect(harness.events()[0]?.actor).toBe("Hermes");
  });

  it("names the message author, and leaves the field unset when nobody is named", () => {
    const harness = createHarness({ notes: [note("n1", "2026-09-15T09:00:01.000Z")] });
    harness.call(
      request("POST", "/notes/n1/messages", {
        body: { text: "reply from the agent", author: "Hermes", author_type: "agent", kind: "reply" },
      }),
    );
    expect(harness.events().map((event) => event?.actor)).toEqual(["Hermes"]);

    const quiet = createHarness({ notes: [note("n1", "2026-09-15T09:00:01.000Z")] });
    quiet.call(request("PATCH", "/notes/n1", { body: { status: "done" } }));
    expect(quiet.events()[0]?.actor).toBeUndefined();
  });
});
