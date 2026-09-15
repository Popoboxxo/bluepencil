/**
 * Store tests (docs/INTERNAL-API.md §2, FR-13.1/13.2, NFR-8).
 *
 * Covered here: optimistic mutation and the mutation→adapter→notify order, the immediate call of a
 * new subscriber, snapshot isolation, lazy adapter-name resolution (including the unknown name and
 * the adapters that need host configuration), failure propagation with an injected failing adapter,
 * and the state changes behind reply/setStatus/setIntent.
 */
import { describe, expect, it, vi } from "vitest";
import type { Adapter, AdapterLike } from "../../src/core/adapter";
import {
  BluepencilValidationError,
  createNote,
  newId,
  type Note,
  type NoteDraft,
} from "../../src/core/model";
import { createStore, registerAdapter } from "../../src/core/store";
import { createMemoryAdapter } from "../../src/adapters/memory";
import { createFileAdapter, type FileAdapterIo } from "../../src/adapters/file";

function draft(overrides: Partial<NoteDraft> = {}): NoteDraft {
  return {
    type: "text",
    body: "draft body",
    anchor: { hook: "checkout-submit", route: "/checkout" },
    ...overrides,
  };
}

interface FakeAdapter {
  adapter: Adapter;
  log: string[];
  calls: { op: string; args: unknown[] }[];
}

/** Adapter that records every call and can be made to fail per operation. */
function createFakeAdapter(options: { name?: string; failOn?: string[] } = {}): FakeAdapter {
  const backend = createMemoryAdapter();
  const log: string[] = [];
  const calls: { op: string; args: unknown[] }[] = [];
  const failOn = new Set(options.failOn ?? []);

  const track = <T>(op: string, args: unknown[], run: () => Promise<T>): Promise<T> => {
    log.push(`adapter:${op}`);
    calls.push({ op, args });
    if (failOn.has(op)) {
      return Promise.reject(new Error(`adapter failure: ${op}`));
    }
    return run();
  };

  const adapter: Adapter = {
    name: options.name ?? "fake",
    list: (filter) => track("list", [filter], () => backend.list(filter)),
    create: (draftValue) => track("create", [draftValue], () => backend.create(draftValue)),
    update: (id, patch) => track("update", [id, patch], () => backend.update(id, patch)),
    remove: (id) => track("remove", [id], () => backend.remove(id)),
    bulkRemove: (filter) => track("bulkRemove", [filter], () => backend.bulkRemove(filter)),
    exportSession: (ref) => track("exportSession", [ref], () => backend.exportSession(ref)),
  };
  return { adapter, log, calls };
}

/** Minimal in-memory "file" used to prove the registry hook wires real I/O. */
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

describe("store", () => {
  it("applies a mutation to memory first, then to the adapter, then notifies", async () => {
    const fake = createFakeAdapter();
    const store = createStore({ adapter: fake.adapter });
    const order: string[] = [];
    store.subscribe(() => {
      order.push("notify");
    });
    order.length = 0;

    const pending = store.create(draft({ body: "first" }));
    // Optimistic: memory already holds the note, the adapter has not answered yet.
    expect(store.notes().map((note) => note.body)).toEqual(["first"]);
    expect(order).toEqual([]);

    const created = await pending;
    expect(created.body).toBe("first");
    expect(fake.calls.map((call) => call.op)).toEqual(["create"]);
    expect(order).toEqual(["notify"]);
  });

  it("calls a new subscriber immediately and after every change", async () => {
    const store = createStore();
    await store.create(draft({ body: "a" }));
    const seen: string[][] = [];
    const unsubscribe = store.subscribe((notes) => seen.push(notes.map((note) => note.body)));
    expect(seen).toEqual([["a"]]);
    await store.create(draft({ body: "b" }));
    expect(seen).toEqual([["a"], ["a", "b"]]);
    unsubscribe();
    await store.create(draft({ body: "c" }));
    expect(seen).toEqual([["a"], ["a", "b"]]);
  });

  it("hands out snapshots and copies, never its internal state", async () => {
    const store = createStore();
    const created = await store.create(draft({ body: "original" }));
    const notes = store.notes();
    const first = notes[0];
    if (first) {
      first.body = "mutated";
    }
    notes.length = 0;
    expect(store.notes().map((note) => note.body)).toEqual(["original"]);

    const fetched = await store.get(created.id);
    if (fetched) {
      fetched.body = "mutated again";
    }
    expect((await store.get(created.id))?.body).toBe("original");
  });

  it("rejects an unknown adapter name with a clear validation error", () => {
    const unknown = "does-not-exist" as unknown as AdapterLike;
    expect(() => createStore({ adapter: unknown })).toThrow(BluepencilValidationError);
    expect(() => createStore({ adapter: unknown })).toThrow(/does-not-exist/);
  });

  it("resolves the built-in memory name lazily", async () => {
    const store = createStore({ adapter: "memory" });
    expect(store.adapterName).toBe("memory");
    const note = await store.create(draft());
    expect(note.id).not.toBe("");
    expect(store.notes()).toHaveLength(1);
  });

  it("resolves the built-in localStorage name, degrading gracefully without Storage", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const store = createStore({ adapter: "localStorage" });
    const note = await store.create(draft({ body: "persisted" }));
    expect(store.adapterName).toBe("localStorage");
    expect((await store.get(note.id))?.body).toBe("persisted");
    expect(store.notes()).toHaveLength(1);

    const storage = globalThis.localStorage as Storage | undefined;
    if (storage) {
      const key = `bluepencil:${globalThis.location.host || globalThis.location.hostname}:default:v1`;
      expect(storage.getItem(key) ?? "").toContain("persisted");
    } else {
      // No Storage in this runtime (jsdom exposes none): one report, data stays in memory (NFR-8).
      expect(debug).toHaveBeenCalledTimes(1);
      expect(String(debug.mock.calls[0]?.[0])).toMatch(/not usable/);
    }
  });

  it("resolves the built-in http name against the current origin", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as NoteDraft;
      return new Response(JSON.stringify({ ok: true, note: createNote(body) }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const store = createStore({ adapter: "http" });
      const note = await store.create(draft({ body: "over http" }));
      expect(store.adapterName).toBe("http");
      expect(note.body).toBe("over http");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/^http:\/\/localhost:\d+\/api\/v1\/bluepencil\/notes$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses the file name without injected I/O", async () => {
    const store = createStore({ adapter: "file" });
    expect(store.adapterName).toBe("file");
    await expect(store.list()).rejects.toThrow(/createFileAdapter/);
  });

  it("keeps the in-memory change and rejects when the adapter fails (NFR-8)", async () => {
    const fake = createFakeAdapter({ failOn: ["create", "update", "remove", "bulkRemove"] });
    const store = createStore({ adapter: fake.adapter });
    const sizes: number[] = [];
    store.subscribe((notes) => sizes.push(notes.length));
    expect(sizes).toEqual([0]);

    await expect(store.create(draft({ body: "kept" }))).rejects.toThrow(/adapter failure: create/);
    expect(store.notes().map((note) => note.body)).toEqual(["kept"]);
    expect(sizes).toEqual([0, 1]);

    const id = store.notes()[0]?.id ?? "";
    await expect(store.setStatus(id, "done")).rejects.toThrow(/adapter failure: update/);
    expect(store.notes()[0]?.status).toBe("done");

    await expect(store.remove(id)).rejects.toThrow(/adapter failure: remove/);
    expect(store.notes()).toHaveLength(0);

    await expect(store.bulkRemove({})).rejects.toThrow(/adapter failure: bulkRemove/);
    expect(store.notes()).toHaveLength(0);
  });

  it("validates a draft before touching memory or the adapter", async () => {
    const fake = createFakeAdapter();
    const store = createStore({ adapter: fake.adapter });
    await expect(store.create({ type: "text", body: "", anchor: { hook: "h" } })).rejects.toThrow(
      BluepencilValidationError,
    );
    expect(store.notes()).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("routes setStatus and setIntent through update() with a patch", async () => {
    const fake = createFakeAdapter();
    const store = createStore({ adapter: fake.adapter });
    const note = await store.create(draft());
    fake.calls.length = 0;

    expect((await store.setStatus(note.id, "done")).status).toBe("done");
    expect(fake.calls[0]?.op).toBe("update");
    expect(fake.calls[0]?.args[1]).toEqual({ status: "done" });

    expect((await store.setIntent(note.id, "feedback")).intent).toBe("feedback");
    expect(fake.calls[1]?.args[1]).toEqual({ intent: "feedback" });

    const persisted = (await fake.adapter.list())[0];
    expect(persisted?.status).toBe("done");
    expect(persisted?.intent).toBe("feedback");
  });

  it("appends replies as protocol messages without replacing the thread", async () => {
    const store = createStore();
    const note = await store.create(draft({ body: "root" }));

    const replied = await store.reply(note.id, {
      text: "please fix the label",
      author: "daniel",
      authorType: "agent",
      kind: "decision",
    });
    expect(replied.messages.map((message) => message.kind)).toEqual(["decision"]);
    expect(replied.messages[0]?.authorType).toBe("agent");

    const again = await store.reply(note.id, { text: "second" });
    expect(again.messages.map((message) => message.text)).toEqual(["please fix the label", "second"]);
    expect(again.messages[1]?.kind).toBe("reply");

    const stored = (await store.list()).find((entry) => entry.id === note.id);
    expect(stored?.messages).toHaveLength(2);

    const message = await store.addMessage(note.id, {
      id: newId("m"),
      ts: new Date().toISOString(),
      author: "tool",
      authorType: "agent",
      kind: "note",
      text: "from the test runner",
    });
    expect(message.messages).toHaveLength(3);

    await expect(store.reply(note.id, { text: "   " })).rejects.toThrow(BluepencilValidationError);
  });

  it("absorbs notes written behind its back on reload() and notifies (FR-13.1)", async () => {
    const backend = createMemoryAdapter();
    const store = createStore({ adapter: backend });
    await store.create(draft({ body: "mine" }));
    await backend.create(draft({ body: "from the test runner", source: "tool:test-runner" }));
    expect(store.notes()).toHaveLength(1);

    const sizes: number[] = [];
    store.subscribe((notes) => sizes.push(notes.length));
    await store.reload();
    expect(store.notes().map((note) => note.body)).toContain("from the test runner");
    expect(sizes).toEqual([1, 2]);

    await store.list({ source: "tool:test-runner" });
    expect(sizes).toEqual([1, 2]);
  });

  it("list(filter) delegates to the adapter and keeps the full set in memory", async () => {
    const store = createStore();
    await store.create(draft({ body: "a", anchor: { hook: "h", route: "/a" } }));
    await store.create(draft({ body: "b", anchor: { hook: "h", route: "/b" } }));
    const filtered = await store.list({ route: "/a" });
    expect(filtered.map((note) => note.body)).toEqual(["a"]);
    expect(store.notes()).toHaveLength(2);
  });

  it("bulkRemove() drops the matching notes and reports the adapter's count", async () => {
    const store = createStore();
    await store.create(draft({ body: "a", anchor: { hook: "h", route: "/a" } }));
    await store.create(draft({ body: "b", anchor: { hook: "h", route: "/b" } }));
    expect(await store.bulkRemove({ route: "/a" })).toEqual({ removed: 1 });
    expect(store.notes().map((note) => note.body)).toEqual(["b"]);
    expect(await store.bulkRemove({ route: "/a" })).toEqual({ removed: 0 });
  });

  it("exportSession() returns the session's notes and absorbs them", async () => {
    const store = createStore();
    await store.create(draft({ body: "s1 note", sessionRef: "s1" }));
    await store.create(draft({ body: "other", sessionRef: "s2" }));
    const exported = await store.exportSession("s1");
    expect(exported.map((note) => note.body)).toEqual(["s1 note"]);
    expect(store.notes()).toHaveLength(2);
  });

  it("get() reads memory first and falls back to the adapter without absorbing", async () => {
    const backend = createMemoryAdapter();
    const store = createStore({ adapter: backend });
    const mine = await store.create(draft({ body: "mine" }));
    expect((await store.get(mine.id))?.body).toBe("mine");

    const external = await backend.create(draft({ body: "external" }));
    expect((await store.get(external.id))?.body).toBe("external");
    expect(store.notes()).toHaveLength(1);
    expect(await store.get("n-missing")).toBeUndefined();
  });

  it("applies the configured session and environment to new notes", async () => {
    const store = createStore({ sessionRef: "review-1", environment: "staging" });
    const note = await store.create(draft());
    expect(note.sessionRef).toBe("review-1");
    expect(note.environment).toBe("staging");
    expect((await store.create(draft({ sessionRef: "other" }))).sessionRef).toBe("other");
  });

  it("uses the injected clock for derived timestamps", async () => {
    const fixed = "2026-02-02T02:02:02.000Z";
    const store = createStore({ now: () => fixed });
    const note = await store.create(draft());
    expect(note.createdAt).toBe(fixed);
    expect(note.updatedAt).toBe(fixed);
    const replied = await store.reply(note.id, { text: "ping" });
    expect(replied.messages[0]?.ts).toBe(fixed);
    expect(replied.updatedAt).toBe(fixed);
  });

  it("injects an adapter for a built-in name through registerAdapter and can undo it", async () => {
    const file = createFakeFile();
    const unregister = registerAdapter("file", () => createFileAdapter(file.io));
    try {
      const store = createStore({ adapter: "file" });
      await store.create(draft({ body: "via the registry" }));
      expect(store.adapterName).toBe("file");
      expect(file.text() ?? "").toContain("via the registry");
    } finally {
      unregister();
    }
    await expect(createStore({ adapter: "file" }).list()).rejects.toThrow(/createFileAdapter/);
  });

  it("ignores a factory registered for another name", async () => {
    const fake = createFakeAdapter({ name: "custom" });
    const unregister = registerAdapter("custom", () => fake.adapter);
    try {
      const store = createStore();
      expect(store.adapterName).toBe("memory");
      await store.create(draft());
      expect(fake.calls).toEqual([]);
    } finally {
      unregister();
    }
  });

  it("destroy() clears the list, drops subscribers and is idempotent", async () => {
    const store = createStore();
    await store.create(draft());
    const sizes: number[] = [];
    store.subscribe((notes) => sizes.push(notes.length));
    await store.destroy();
    expect(store.notes()).toEqual([]);
    await store.destroy();
    expect(sizes).toEqual([1]);
    await expect(store.create(draft())).rejects.toThrow(/destroyed/);
    await expect(store.list()).rejects.toThrow(/destroyed/);
  });

  it("accepts an adapter instance and a factory in the options", async () => {
    const instance = createFakeAdapter({ name: "instance" });
    const fromInstance = createStore({ adapter: instance.adapter });
    expect(fromInstance.adapterName).toBe("instance");
    await fromInstance.create(draft());
    expect(instance.calls.map((call) => call.op)).toEqual(["create"]);

    const fromFactory = createStore({ adapter: () => createFakeAdapter({ name: "factory" }).adapter });
    expect(fromFactory.adapterName).toBe("factory");
    expect((await fromFactory.create(draft())).body).toBe("draft body");
  });
});

/* Keep the model import honest: the store's notes are plain model objects. */
describe("store/model integration", () => {
  it("returns notes that satisfy the model contract", async () => {
    const store = createStore({ adapter: "memory" });
    const note: Note = await store.create(draft());
    expect(note.schemaVersion).toBe(1);
    expect(note.status).toBe("open");
    expect(note.intent).toBe("implement");
    expect(note.authorType).toBe("human");
    expect(note.source).toBe("ui:human");
    expect(note.messages).toEqual([]);
  });
});
