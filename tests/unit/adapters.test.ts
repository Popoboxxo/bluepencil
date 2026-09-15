/**
 * Adapter conformance suite (FR-6.1, NFR-11): **one** suite, parameterised over all four built-in
 * adapters. Any adapter must pass the same expectations — list/create/update/remove/bulkRemove/
 * exportSession semantics, filter semantics, idempotence and the fallback paths.
 *
 * Adapter-specific behaviour (key namespacing, quota fallback, HTTP status handling) is tested in
 * the trailing describes, which are additive and do not weaken the shared suite.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Adapter, AdapterPatch } from "../../src/core/adapter";
import {
  createMessage,
  newId,
  type Message,
  type NoteDraft,
  type NoteFilter,
  type NotePatch,
  type NoteStatus,
  type Session,
} from "../../src/core/model";
import { createMemoryAdapter } from "../../src/adapters/memory";
import { createLocalStorageAdapter, localStorageKey } from "../../src/adapters/local-storage";
import { createFileAdapter, type FileAdapterIo } from "../../src/adapters/file";
import { HttpAdapterError, createHttpAdapter } from "../../src/adapters/http";
import { createStore } from "../../src/core/store";

const ROUTE_A = "/checkout";
const ROUTE_B = "/settings";
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";
const BETWEEN = "2026-01-01T12:00:00.000Z";

function draft(overrides: Partial<NoteDraft> = {}): NoteDraft {
  return {
    type: "text",
    body: "note body",
    anchor: { hook: "checkout-submit", route: ROUTE_A },
    now: T0,
    ...overrides,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Fakes used by the fixtures (and by the adapter-specific tests)
 * ---------------------------------------------------------------------------------------------- */

function createFakeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length(): number {
      return data.size;
    },
    clear: () => {
      data.clear();
    },
    getItem: (key: string) => {
      const value = data.get(key);
      return value === undefined ? null : value;
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, String(value));
    },
  };
}

/** Storage that exists but rejects every access — private mode, denied cookies. */
function createUnusableStorage(): Storage {
  const fail = (): never => {
    throw new Error("storage access denied");
  };
  return {
    length: 0,
    clear: fail,
    getItem: fail,
    key: fail,
    removeItem: fail,
    setItem: fail,
  };
}

/** Storage that reads fine but cannot write any more — the quota case. */
function createFullStorage(): Storage {
  const base = createFakeStorage();
  return {
    get length(): number {
      return base.length;
    },
    clear: () => base.clear(),
    getItem: (key: string) => base.getItem(key),
    key: (index: number) => base.key(index),
    removeItem: (key: string) => base.removeItem(key),
    setItem: () => {
      throw Object.assign(new Error("quota exceeded"), { name: "QuotaExceededError" });
    },
  };
}

function createFakeFile(initial: string | null = null): { io: FileAdapterIo; text: () => string | null } {
  let content = initial;
  return {
    io: {
      read: async () => content,
      write: async (text: string) => {
        content = text;
      },
    },
    text: () => content,
  };
}

const HTTP_BASE = "http://localhost:3000/api/v1/bluepencil";
const HTTP_PATH = "/api/v1/bluepencil";

interface FakeServer {
  fetch: typeof fetch;
  calls: { method: string; path: string; query: URLSearchParams; headers: Headers; body: unknown }[];
  backend: Adapter;
}

/**
 * A minimal reference server over a memory adapter: enough of ARCHITECTURE §5 to prove that the
 * HTTP adapter speaks the documented contract (query parameters, JSON envelopes, status codes).
 */
function createFakeServer(): FakeServer {
  const backend = createMemoryAdapter();
  const calls: FakeServer["calls"] = [];

  const json = (status: number, payload: unknown): Response =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });

  const filterFrom = (query: URLSearchParams): NoteFilter => {
    const filter: NoteFilter = {};
    const route = query.get("route");
    if (route !== null) filter.route = route;
    const intent = query.get("intent");
    if (intent !== null) filter.intent = intent as NoteFilter["intent"];
    const type = query.get("type");
    if (type !== null) filter.type = type as NoteFilter["type"];
    const session = query.get("session");
    if (session !== null) filter.session = session;
    const source = query.get("source");
    if (source !== null) filter.source = source;
    const environment = query.get("environment");
    if (environment !== null) filter.environment = environment as NoteFilter["environment"];
    const since = query.get("since");
    if (since !== null) filter.since = since;
    const includeDone = query.get("includeDone");
    if (includeDone !== null) filter.includeDone = includeDone === "true";
    const statuses = query.getAll("status") as NoteStatus[];
    if (statuses.length === 1) filter.status = statuses[0];
    if (statuses.length > 1) filter.status = statuses;
    return filter;
  };

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    const method = (init?.method ?? "GET").toUpperCase();
    const body: unknown = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({
      method,
      path: url.pathname,
      query: url.searchParams,
      headers: new Headers(init?.headers),
      body,
    });

    if (url.pathname === `${HTTP_PATH}/health` && method === "GET") {
      return json(200, { ok: true, status: "ok", version: "0.1.0" });
    }
    if (url.pathname === `${HTTP_PATH}/sessions` && method === "GET") {
      const sessions: Session[] = [{ ref: "s1", label: "Review", createdAt: T0 }];
      return json(200, { ok: true, sessions });
    }
    if (url.pathname === `${HTTP_PATH}/notes/bulk-delete` && method === "POST") {
      const payload = (body ?? {}) as { ids?: string[]; filter?: NoteFilter };
      if (Array.isArray(payload.ids)) {
        let removed = 0;
        for (const id of payload.ids) {
          try {
            await backend.remove(id);
            removed += 1;
          } catch {
            removed += 0;
          }
        }
        return removed > 0 ? json(200, { ok: true, removed }) : json(404, { ok: false, error: "note not found" });
      }
      const result = await backend.bulkRemove(payload.filter ?? {});
      return json(200, { ok: true, removed: result.removed });
    }
    if (url.pathname === `${HTTP_PATH}/notes` && method === "GET") {
      return json(200, { ok: true, notes: await backend.list(filterFrom(url.searchParams)) });
    }
    if (url.pathname === `${HTTP_PATH}/notes` && method === "POST") {
      try {
        const note = await backend.create(body as NoteDraft);
        return json(201, { ok: true, note });
      } catch (error) {
        return json(400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    const messages = /^\/api\/v1\/bluepencil\/notes\/([^/]+)\/messages$/.exec(url.pathname);
    if (messages && method === "POST") {
      const id = decodeURIComponent(messages[1] ?? "");
      const raw = (body ?? {}) as Record<string, unknown>;
      const message: Message = {
        id: typeof raw.id === "string" ? raw.id : newId("m"),
        ts: typeof raw.ts === "string" ? raw.ts : T1,
        author: typeof raw.author === "string" ? raw.author : "unknown",
        authorType: raw.author_type === "agent" ? "agent" : "human",
        kind: typeof raw.kind === "string" ? (raw.kind as Message["kind"]) : "note",
        text: typeof raw.text === "string" ? raw.text : "",
      };
      const patch: AdapterPatch = { messages: [message] };
      try {
        return json(200, { ok: true, note: await backend.update(id, patch) });
      } catch {
        return json(404, { ok: false, error: `note not found: ${id}` });
      }
    }

    const single = /^\/api\/v1\/bluepencil\/notes\/([^/]+)$/.exec(url.pathname);
    if (single && method === "PATCH") {
      const id = decodeURIComponent(single[1] ?? "");
      try {
        const note = await backend.update(id, (body ?? {}) as NotePatch);
        return json(200, { ok: true, note });
      } catch {
        return json(404, { ok: false, error: `note not found: ${id}` });
      }
    }

    return json(404, { ok: false, error: `no route for ${method} ${url.pathname}` });
  };

  return { fetch: fetchImpl as typeof fetch, calls, backend };
}

/* ------------------------------------------------------------------------------------------------
 * The shared conformance suite
 * ---------------------------------------------------------------------------------------------- */

interface AdapterFixture {
  readonly label: string;
  create(): Adapter | Promise<Adapter>;
}

const fixtures: AdapterFixture[] = [
  { label: "memory", create: () => createMemoryAdapter() },
  {
    label: "localStorage",
    create: () => createLocalStorageAdapter({ key: "bluepencil:conformance:v1", storage: createFakeStorage() }),
  },
  { label: "file", create: () => createFileAdapter(createFakeFile().io) },
  { label: "http", create: () => createHttpAdapter({ endpoint: HTTP_BASE, fetchImpl: createFakeServer().fetch }) },
];

for (const fixture of fixtures) {
  describe(`adapter contract — ${fixture.label}`, () => {
    let adapter: Adapter;

    const seed = async (): Promise<void> => {
      await adapter.create(draft({ now: T0, body: "A", anchor: { hook: "h1", route: ROUTE_A } }));
      await adapter.create(
        draft({
          now: T1,
          body: "B",
          type: "design",
          intent: "feedback",
          sessionRef: "s1",
          source: "tool:build",
          environment: "staging",
          anchor: { hook: "h2", route: ROUTE_B },
        }),
      );
      await adapter.create(
        draft({
          now: T0,
          body: "C",
          status: "done",
          sessionRef: "s2",
          anchor: { hook: "h3", route: ROUTE_A },
        }),
      );
    };

    beforeEach(async () => {
      adapter = await fixture.create();
    });

    it("names itself and starts empty", async () => {
      expect(adapter.name).toBe(fixture.label);
      expect(await adapter.list()).toEqual([]);
    });

    it("create() stores the note and returns it", async () => {
      const note = await adapter.create(draft({ body: "hello" }));
      expect(note.schemaVersion).toBe(1);
      expect(note.id).not.toBe("");
      const stored = await adapter.list();
      expect(stored.map((entry) => entry.body)).toEqual(["hello"]);
      expect(stored[0]?.id).toBe(note.id);
    });

    it("hands out copies, never the stored objects", async () => {
      const created = await adapter.create(draft({ body: "original" }));
      const first = await adapter.list();
      const copy = first[0];
      if (copy) {
        copy.body = "mutated";
      }
      first.length = 0;
      const second = await adapter.list();
      expect(second.map((entry) => entry.body)).toEqual(["original"]);
      expect(second[0]?.id).toBe(created.id);
    });

    it("honours an explicit id", async () => {
      const note = await adapter.create(draft({ id: "n-fixed" }));
      expect(note.id).toBe("n-fixed");
      expect((await adapter.list()).map((entry) => entry.id)).toEqual(["n-fixed"]);
    });

    it("applies filter semantics (route, type, intent, session, source, environment, since, status, includeDone)", async () => {
      await seed();
      const bodies = async (filter?: NoteFilter): Promise<string[]> =>
        (await adapter.list(filter)).map((note) => note.body);

      expect(await bodies()).toEqual(["A", "B", "C"]);
      expect(await bodies({})).toEqual(["A", "B", "C"]);
      expect(await bodies({ route: ROUTE_A })).toEqual(["A", "C"]);
      expect(await bodies({ route: ROUTE_B })).toEqual(["B"]);
      expect(await bodies({ type: "design" })).toEqual(["B"]);
      expect(await bodies({ intent: "feedback" })).toEqual(["B"]);
      expect(await bodies({ session: "s1" })).toEqual(["B"]);
      expect(await bodies({ source: "tool:build" })).toEqual(["B"]);
      expect(await bodies({ environment: "staging" })).toEqual(["B"]);
      expect(await bodies({ status: "open" })).toEqual(["A", "B"]);
      expect(await bodies({ status: ["done", "open"] })).toEqual(["A", "B", "C"]);
      expect(await bodies({ since: BETWEEN })).toEqual(["B"]);
      expect(await bodies({ includeDone: false })).toEqual(["A", "B"]);
      expect(await bodies({ status: "done", includeDone: false })).toEqual(["C"]);
      expect(await bodies({ route: ROUTE_A, type: "text", status: "open" })).toEqual(["A"]);
    });

    it("update() patches only the given fields and bumps updatedAt", async () => {
      const note = await adapter.create(draft({ now: T0, body: "before" }));
      const updated = await adapter.update(note.id, {
        status: "done",
        intent: "feedback",
        body: "after",
      });
      expect(updated.id).toBe(note.id);
      expect(updated.status).toBe("done");
      expect(updated.intent).toBe("feedback");
      expect(updated.body).toBe("after");
      expect(updated.anchor).toEqual(note.anchor);
      expect(updated.updatedAt).not.toBe(note.updatedAt);
      const stored = await adapter.list({ status: "done" });
      expect(stored.map((entry) => entry.body)).toEqual(["after"]);
    });

    it("re-applying the same patch keeps the same content (idempotent fields)", async () => {
      const note = await adapter.create(draft({ now: T0 }));
      await adapter.update(note.id, { status: "done" });
      await adapter.update(note.id, { status: "done" });
      const stored = await adapter.list();
      expect(stored).toHaveLength(1);
      expect(stored[0]?.status).toBe("done");
    });

    it("appends thread messages through update() without replacing the thread", async () => {
      const note = await adapter.create(draft());
      const first: AdapterPatch = { messages: [createMessage({ text: "first", kind: "reply", now: T1 })] };
      const second: AdapterPatch = { messages: [createMessage({ text: "second", kind: "decision", now: T1 })] };
      const afterFirst = await adapter.update(note.id, first);
      expect(afterFirst.messages.map((message) => message.text)).toEqual(["first"]);
      const afterSecond = await adapter.update(note.id, second);
      expect(afterSecond.messages.map((message) => message.text)).toEqual(["first", "second"]);
      expect((await adapter.list())[0]?.messages).toHaveLength(2);
    });

    it("remove() deletes exactly one note", async () => {
      const keep = await adapter.create(draft({ body: "keep" }));
      const drop = await adapter.create(draft({ body: "drop" }));
      await adapter.remove(drop.id);
      expect((await adapter.list()).map((note) => note.id)).toEqual([keep.id]);
    });

    it("bulkRemove() removes exactly the matching notes and is idempotent", async () => {
      await seed();
      expect(await adapter.bulkRemove({ route: ROUTE_A })).toEqual({ removed: 2 });
      expect((await adapter.list()).map((note) => note.body)).toEqual(["B"]);
      expect(await adapter.bulkRemove({ route: ROUTE_A })).toEqual({ removed: 0 });
      expect((await adapter.list()).map((note) => note.body)).toEqual(["B"]);
    });

    it("exportSession() returns exactly that session and changes nothing", async () => {
      await seed();
      const first = await adapter.exportSession("s1");
      expect(first.map((note) => note.body)).toEqual(["B"]);
      expect(await adapter.exportSession("s1")).toEqual(first);
      expect(await adapter.list()).toHaveLength(3);
      expect(await adapter.exportSession("unknown")).toEqual([]);
    });

    it("rejects update() and remove() for an unknown id instead of failing silently", async () => {
      await expect(adapter.update("n-nope", { status: "done" })).rejects.toBeInstanceOf(Error);
      await expect(adapter.remove("n-nope")).rejects.toBeInstanceOf(Error);
    });

    it("notifies subscribers immediately and after every change (where supported)", async () => {
      if (!adapter.subscribe) {
        return;
      }
      const sizes: number[] = [];
      const unsubscribe = adapter.subscribe((notes) => sizes.push(notes.length));
      expect(sizes).toEqual([0]);
      await adapter.create(draft());
      expect(sizes).toEqual([0, 1]);
      await adapter.create(draft({ body: "second" }));
      expect(sizes).toEqual([0, 1, 2]);
      unsubscribe();
      await adapter.create(draft({ body: "third" }));
      expect(sizes).toEqual([0, 1, 2]);
    });
  });
}

/* ------------------------------------------------------------------------------------------------
 * localStorage specifics
 * ---------------------------------------------------------------------------------------------- */

describe("localStorage adapter specifics", () => {
  it("namespaces the key as bluepencil:<host>:<instance>:v1", () => {
    expect(localStorageKey("app.example.com", "review-a")).toBe("bluepencil:app.example.com:review-a:v1");
    expect(localStorageKey()).toMatch(/^bluepencil:.+:default:v1$/);
    expect(localStorageKey("host.example.com", "instance-b")).toBe("bluepencil:host.example.com:instance-b:v1");
  });

  it("persists one JSON blob under the configured key", async () => {
    const storage = createFakeStorage();
    const adapter = createLocalStorageAdapter({ key: "bluepencil:test:default:v1", storage });
    await adapter.create(draft({ body: "persisted" }));
    const raw = storage.getItem("bluepencil:test:default:v1");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw ?? "{}") as { version: number; notes: { body: string }[] };
    expect(parsed.version).toBe(1);
    expect(parsed.notes.map((note) => note.body)).toEqual(["persisted"]);
  });

  it("serializes concurrent read-modify-write cycles so no write is lost", async () => {
    const storage = createFakeStorage();
    const adapter = createLocalStorageAdapter({ key: "k", storage });
    await Promise.all(
      Array.from({ length: 6 }, (_unused, index) => adapter.create(draft({ body: `n${index}` }))),
    );
    expect(await adapter.list()).toHaveLength(6);
    const parsed = JSON.parse(storage.getItem("k") ?? "{}") as { notes: unknown[] };
    expect(parsed.notes).toHaveLength(6);
  });

  it("falls back to memory when no Storage exists and reports it once", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.stubGlobal("localStorage", undefined);
    try {
      const adapter = createLocalStorageAdapter();
      expect(adapter.name).toBe("localStorage");
      const note = await adapter.create(draft({ body: "in memory" }));
      expect((await adapter.list()).map((entry) => entry.id)).toEqual([note.id]);
      await adapter.create(draft({ body: "second" }));
      expect(await adapter.list()).toHaveLength(2);
      expect(debug).toHaveBeenCalledTimes(1);
      expect(String(debug.mock.calls[0]?.[0])).toMatch(/not usable/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to memory when Storage denies access, keeping the change (NFR-8)", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const adapter = createLocalStorageAdapter({ key: "denied", storage: createUnusableStorage() });
    const note = await adapter.create(draft({ body: "kept" }));
    expect((await adapter.list()).map((entry) => entry.id)).toEqual([note.id]);
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it("degrades after a quota error without losing the write (NFR-8)", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const storage = createFullStorage();
    const adapter = createLocalStorageAdapter({ key: "full", storage });
    const first = await adapter.create(draft({ body: "first" }));
    expect((await adapter.list()).map((entry) => entry.id)).toEqual([first.id]);
    await adapter.create(draft({ body: "second" }));
    expect((await adapter.list()).map((entry) => entry.body)).toEqual(["first", "second"]);
    expect(debug).toHaveBeenCalledTimes(1);
    expect(storage.getItem("full")).toBeNull();
  });

  it("keeps a corrupt blob untouched instead of overwriting it", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const storage = createFakeStorage();
    storage.setItem("corrupt", "{ not json");
    const adapter = createLocalStorageAdapter({ key: "corrupt", storage });
    expect(await adapter.list()).toEqual([]);
    await adapter.create(draft({ body: "new" }));
    expect(await adapter.list()).toHaveLength(1);
    expect(storage.getItem("corrupt")).toBe("{ not json");
    expect(debug).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------------------------------------
 * file specifics
 * ---------------------------------------------------------------------------------------------- */

describe("file adapter specifics", () => {
  it("round-trips through the injected I/O", async () => {
    const file = createFakeFile();
    const adapter = createFileAdapter(file.io);
    expect(adapter.name).toBe("file");
    const note = await adapter.create(draft({ body: "written" }));
    const text = file.text() ?? "";
    expect(text).toContain("written");
    const reloaded = createFileAdapter(file.io);
    expect((await reloaded.list()).map((entry) => entry.id)).toEqual([note.id]);
  });

  it("reads an existing bare array as well as the documented envelope", async () => {
    const bare = createFakeFile(JSON.stringify([{ id: "n-1", schemaVersion: 1, type: "text", body: "legacy", anchor: { hook: "x" } }]));
    expect((await createFileAdapter(bare.io).list()).map((note) => note.id)).toEqual(["n-1"]);
  });

  it("needs an I/O object with read() and write()", () => {
    expect(() => createFileAdapter({} as unknown as FileAdapterIo)).toThrow(/injected I\/O/);
  });

  it("falls back to memory when the file cannot be read, reporting once", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const adapter = createFileAdapter({
      read: async () => {
        throw new Error("EACCES");
      },
      write: async () => undefined,
    });
    const note = await adapter.create(draft({ body: "kept" }));
    expect((await adapter.list()).map((entry) => entry.id)).toEqual([note.id]);
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it("rejects a failing write instead of reporting a write that never reached the file (NFR-8)", async () => {
    // Root cause of the swallowed-write MCP defect: the mutation used to resolve while the
    // adapter only logged, so a tool reported success for a note that was never persisted.
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    let writes = 0;
    let content: string | null = null;
    const adapter = createFileAdapter({
      read: async () => content,
      write: async () => {
        writes += 1;
        throw Object.assign(new Error("EACCES: permission denied, open 'store.json'"), {
          code: "EACCES",
        });
      },
    });

    await expect(adapter.create(draft({ body: "never persisted" }))).rejects.toThrow(/EACCES/);
    expect(content).toBeNull();
    expect(debug).toHaveBeenCalledTimes(1);
    expect(String(debug.mock.calls[0]?.[0])).toMatch(/file adapter I\/O failed/);

    // The failure is not cached: the next write is attempted again and rejects as well.
    await expect(adapter.create(draft({ body: "second" }))).rejects.toThrow(/EACCES/);
    expect(writes).toBe(2);
    expect(debug).toHaveBeenCalledTimes(1);

    // A usable write after the failure persists again and resolves.
    content = "[]";
    const reloaded = createFileAdapter({
      read: async () => content,
      write: async (text: string) => {
        content = text;
      },
    });
    await expect(reloaded.create(draft({ body: "on disk" }))).resolves.toMatchObject({ body: "on disk" });
    expect(content).toContain("on disk");
  });

  it("propagates a failed write to the store mutation so a caller cannot mistake it for a save", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const store = createStore({
      adapter: createFileAdapter({
        read: async () => null,
        write: async () => {
          throw new Error("EACCES: permission denied");
        },
      }),
    });

    await expect(store.create(draft({ body: "not saved" }))).rejects.toThrow(/EACCES/);
    // NFR-8: the in-memory change stays — the caller learns about it, the user loses nothing.
    expect(store.notes().map((entry) => entry.body)).toEqual(["not saved"]);
    expect(debug).toHaveBeenCalledTimes(1);
    await store.destroy();
  });
});

/* ------------------------------------------------------------------------------------------------
 * subscriber isolation
 * ---------------------------------------------------------------------------------------------- */

describe("adapter subscriber isolation", () => {
  it("keeps a memory-adapter mutation successful when a subscriber throws", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const adapter = createMemoryAdapter();
    const seen: string[][] = [];
    let armed = false;
    // The immediate call of a fresh subscriber is not the subject here: only *notifications* are.
    adapter.subscribe?.(() => {
      if (armed) {
        throw new Error("broken subscriber");
      }
    });
    adapter.subscribe?.((notes) => {
      seen.push(notes.map((note) => note.body));
    });
    armed = true;

    const note = await adapter.create(draft({ body: "still saved" }));
    expect(note.body).toBe("still saved");
    // the healthy subscriber still saw the change …
    expect(seen.at(-1)).toEqual(["still saved"]);
    // … and the failure is a log line, not a rejected mutation (mirrors store.notify, NFR-8)
    expect(debug).toHaveBeenCalledWith("bluepencil: an adapter subscriber failed", expect.any(Error));
  });

  it("keeps a JSON-adapter mutation successful when a subscriber throws", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const adapter = createLocalStorageAdapter({ key: "subscribers", storage: createFakeStorage() });
    let armed = false;
    adapter.subscribe?.(() => {
      if (armed) {
        throw new Error("broken subscriber");
      }
    });
    armed = true;

    const note = await adapter.create(draft({ body: "persisted anyway" }));
    const stored = await adapter.list();
    expect(stored.map((entry) => entry.id)).toEqual([note.id]);
    expect(debug).toHaveBeenCalledWith("bluepencil: an adapter subscriber failed", expect.any(Error));
  });
});

/* ------------------------------------------------------------------------------------------------
 * http specifics
 * ---------------------------------------------------------------------------------------------- */

describe("http adapter specifics", () => {
  const failing = (response: Response): typeof fetch =>
    (async () => response) as unknown as typeof fetch;

  it("needs an endpoint", () => {
    expect(() => createHttpAdapter({ endpoint: "  " })).toThrow(/endpoint/);
  });

  it("throws an Error carrying status and body for a non-2xx response", async () => {
    const adapter = createHttpAdapter({
      endpoint: HTTP_BASE,
      fetchImpl: failing(new Response(JSON.stringify({ ok: false, error: "boom" }), { status: 500 })),
    });
    const error = await adapter.list().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(HttpAdapterError);
    const httpError = error as HttpAdapterError;
    expect(httpError.status).toBe(500);
    expect(httpError.body).toContain("boom");
    expect(httpError.message).toMatch(/500/);
  });

  it("never parses an HTML error page as JSON", async () => {
    const adapter = createHttpAdapter({
      endpoint: HTTP_BASE,
      fetchImpl: failing(new Response("<html><body>gateway</body></html>", { status: 502 })),
    });
    const error = (await adapter.list().catch((reason: unknown) => reason)) as HttpAdapterError;
    expect(error).toBeInstanceOf(HttpAdapterError);
    expect(error.status).toBe(502);
    expect(error.message).toMatch(/HTML/);
  });

  it("reports a success status with a non-JSON body as an error", async () => {
    const adapter = createHttpAdapter({
      endpoint: HTTP_BASE,
      fetchImpl: failing(new Response("<html>login</html>", { status: 200 })),
    });
    const error = (await adapter.list().catch((reason: unknown) => reason)) as HttpAdapterError;
    expect(error).toBeInstanceOf(HttpAdapterError);
    expect(error.status).toBe(200);
    expect(error.message).toMatch(/not JSON/);
  });

  it("reports a transport failure as an error instead of an unhandled rejection", async () => {
    const adapter = createHttpAdapter({
      endpoint: HTTP_BASE,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(adapter.list()).rejects.toBeInstanceOf(HttpAdapterError);
  });

  it("surfaces a missing note as a 404 error", async () => {
    const server = createFakeServer();
    const adapter = createHttpAdapter({ endpoint: HTTP_BASE, fetchImpl: server.fetch });
    await expect(adapter.remove("n-missing")).rejects.toMatchObject({ status: 404 });
  });

  it("re-evaluates headers() on every request", async () => {
    const server = createFakeServer();
    let token = "first";
    const adapter = createHttpAdapter({
      endpoint: HTTP_BASE,
      fetchImpl: server.fetch,
      headers: () => ({ Authorization: `Bearer ${token}` }),
    });
    await adapter.list();
    token = "second";
    await adapter.list();
    expect(server.calls.map((call) => call.headers.get("authorization"))).toEqual([
      "Bearer first",
      "Bearer second",
    ]);
  });

  it("talks to the documented health and sessions endpoints", async () => {
    const server = createFakeServer();
    const adapter = createHttpAdapter({ endpoint: `${HTTP_BASE}/`, fetchImpl: server.fetch });
    expect(await adapter.health()).toEqual({ ok: true, status: "ok", version: "0.1.0" });
    expect(await adapter.sessions()).toEqual([{ ref: "s1", label: "Review", createdAt: T0 }]);
    expect(server.calls.map((call) => call.path)).toEqual([
      `${HTTP_PATH}/health`,
      `${HTTP_PATH}/sessions`,
    ]);
  });

  it("sends filters as query parameters and messages as the documented payload", async () => {
    const server = createFakeServer();
    const adapter = createHttpAdapter({ endpoint: HTTP_BASE, fetchImpl: server.fetch });
    const note = await adapter.create(draft());
    await adapter.list({ route: ROUTE_A, status: ["open", "done"], since: T0, includeDone: false });
    const patch: AdapterPatch = { messages: [createMessage({ text: "hi", kind: "reply", now: T1 })] };
    await adapter.update(note.id, patch);

    const listCall = server.calls.find((call) => call.method === "GET" && call.query.has("route"));
    expect(listCall?.query.get("route")).toBe(ROUTE_A);
    expect(listCall?.query.getAll("status")).toEqual(["open", "done"]);
    expect(listCall?.query.get("since")).toBe(T0);
    expect(listCall?.query.get("includeDone")).toBe("false");

    const messageCall = server.calls.find((call) => call.path.endsWith("/messages"));
    expect(messageCall?.body).toMatchObject({ text: "hi", kind: "reply", author_type: "human" });
  });
});
