/**
 * `chrome.storage` adapter — the extension's local store (#34).
 *
 * The happy path is shared with every other adapter through `createJsonAdapter` and is already
 * covered by the conformance suite in `adapters.test.ts`. What matters here is the behaviour that
 * is specific to this adapter: the lazy `chrome` lookup, the cross-origin sharing that
 * `localStorage` cannot provide, and the degrade path on a page with no extension API.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMemoryAdapter } from "../../src/adapters/memory";
import {
  CHROME_STORAGE_ADAPTER_NAME,
  chromeStorageKey,
  createChromeStorageAdapter,
  type ChromeStorageArea,
} from "../../src/adapters/chrome-storage";
import { createStore } from "../../src/core/store";
import type { NoteDraft } from "../../src/core/model";
import {
  ASSIGN_PROVENANCE_PREFIX,
  LEGACY_STORAGE_KEY,
  NOTES_STORAGE_PREFIX,
  chromeStorageKeyForOrigin,
  parseNotesStorageKey,
  storageKeyForLocation,
} from "../../src/data/origin";

/** A minimal in-memory stand-in for `chrome.storage.local`, promise-based like the real one. */
function fakeArea(initial: Record<string, unknown> = {}): ChromeStorageArea & {
  data: Record<string, unknown>;
  /** Every key the adapter touched — the observation for "never the legacy key" (AC-B41). */
  calls: { get: string[]; set: string[]; remove: string[] };
} {
  const data = { ...initial };
  const calls = { get: [] as string[], set: [] as string[], remove: [] as string[] };
  return {
    data,
    calls,
    async get(keys) {
      const names = typeof keys === "string" ? [keys] : keys;
      calls.get.push(...names);
      const out: Record<string, unknown> = {};
      for (const name of names) if (name in data) out[name] = data[name];
      return out;
    },
    async set(items) {
      calls.set.push(...Object.keys(items));
      Object.assign(data, items);
    },
    async remove(keys) {
      const names = typeof keys === "string" ? [keys] : keys;
      calls.remove.push(...names);
      for (const name of names) delete data[name];
    },
  };
}

/**
 * Points `globalThis.location` at an origin for one test.
 *
 * jsdom defines `location` as a non-configurable accessor (`Cannot redefine property: location`),
 * which is why the existing cross-origin suite never sets it. Vitest's `stubGlobal` replaces the
 * property on the test global and restores it, so the adapter's derivation is observable without
 * touching jsdom internals. `"null"` is the opaque origin (`file:`, a sandboxed frame).
 */
function useLocation(origin: string | null): void {
  vi.stubGlobal("location", { origin });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function draft(body: string): NoteDraft {
  return { type: "text", body, anchor: { hook: `h-${body}`, route: "/page" } };
}

/** The productive per-origin key for `https://a.example`. */
const A_KEY = "bluepencil:v2:https://a.example";

describe("chromeStorage adapter", () => {
  it("keys the blob per instance and defaults to a shared scope", () => {
    expect(chromeStorageKey()).toBe("bluepencil:default:v1");
    expect(chromeStorageKey("wiki")).toBe("bluepencil:wiki:v1");
  });

  it("round-trips a note through the injected area", async () => {
    useLocation("https://a.example");
    const area = fakeArea();
    const adapter = createChromeStorageAdapter({ area });
    const note = await adapter.create(draft("A"));
    expect(note.id).toBeTruthy();
    expect(area.data[A_KEY]).toContain("h-A");

    const listed = await adapter.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.body).toBe("A");
  });

  it("shares one blob across adapter instances on the same origin", async () => {
    // Two tabs of the same site still share their notes (per-origin, not per-tab). This is the
    // surviving half of the old property; the cross-site half moves to the cross-origin suite,
    // where the same setup now proves the opposite (AC-B06).
    useLocation("https://a.example");
    const area = fakeArea();
    const first = createChromeStorageAdapter({ area });
    const second = createChromeStorageAdapter({ area });
    await first.create(draft("shared"));
    expect(await second.list()).toHaveLength(1);
  });

  it("keeps instances apart when a scope is given", async () => {
    const area = fakeArea();
    const a = createChromeStorageAdapter({ area, key: chromeStorageKey("team-a") });
    const b = createChromeStorageAdapter({ area, key: chromeStorageKey("team-b") });
    await a.create(draft("x"));
    expect(await b.list()).toHaveLength(0);
  });

  it("reports the adapter name it actually used", async () => {
    const store = createStore({ adapter: createChromeStorageAdapter({ area: fakeArea() }) });
    expect(store.adapterName).toBe(CHROME_STORAGE_ADAPTER_NAME);
  });

  it("degrades to memory when no extension API exists, and reports it once", async () => {
    // The plain-page case: `chrome` is undefined, exactly as on a site the element runs on outside
    // an extension. Construction must not throw, or the bundle would break there.
    const onFallback = vi.fn();
    const store = createStore({
      adapter: createChromeStorageAdapter({ area: null, onFallback }),
    });
    const note = await store.create(draft("e9"));
    expect(note.body).toBe("e9");
    // The change is kept in memory rather than lost — degrade, not reject.
    expect(store.notes()).toHaveLength(1);

    await store.create(draft("e10"));
    // Reported once, not once per write (NFR-14): a degrading store must not become a log stream.
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("survives a corrupt blob rather than throwing at the host", async () => {
    useLocation("https://a.example");
    const area = fakeArea({ [A_KEY]: "{not json" });
    const onFallback = vi.fn();
    const store = createStore({ adapter: createChromeStorageAdapter({ area, onFallback }) });
    expect(store.notes()).toEqual([]);
    await store.reload();
    expect(onFallback).toHaveBeenCalled();
  });

  it("resolves the global chrome namespace lazily, not at import time", () => {
    // Importing the module must be safe without `chrome`; constructing with no area falls through
    // the lazy lookup and degrades instead of throwing.
    const store = createStore({ adapter: createChromeStorageAdapter() });
    expect(store.notes()).toEqual([]);
  });

  it("is reachable by name from a host, without constructing the adapter itself", async () => {
    // The extension passes the name, not an instance — the lazy registry must resolve it.
    const store = createStore({ adapter: "chromeStorage" });
    expect(store.adapterName).toBe(CHROME_STORAGE_ADAPTER_NAME);
  });

  it("does not collide with the memory adapter's contract", () => {
    // Guards against a copy-paste returning the wrong adapter name.
    expect(createMemoryAdapter().name).not.toBe(CHROME_STORAGE_ADAPTER_NAME);
  });
});

/**
 * The productive key precedence (B.1, AC-B41). Three cases, in order:
 *
 *   explicit `options.key`  →  `storageKeyForLocation(globalThis.location)`  →  `null`
 *
 * The last one is not a silent fallback to a shared bucket: it is "no bucket", the adapter never
 * touches `chrome.storage.local`, and `onFallback` sees `{ code: "opaque_origin" }` exactly once.
 */
describe("chromeStorage — productive key precedence (AC-B41)", () => {
  it("derives a per-origin key when no key is given and never touches the legacy blob", async () => {
    useLocation("https://a.example");
    const area = fakeArea({ [LEGACY_STORAGE_KEY]: "sentinel" });
    const adapter = createChromeStorageAdapter({ area });

    await adapter.create(draft("derived"));

    expect(area.data[A_KEY]).toContain("h-derived");
    // The whole exchange — the read of the create cycle and its write — used the derived key only.
    expect(area.calls.get).toEqual([A_KEY]);
    expect(area.calls.set).toEqual([A_KEY]);
    expect(area.calls.get).not.toContain(LEGACY_STORAGE_KEY);
    expect(area.calls.set).not.toContain(LEGACY_STORAGE_KEY);
    // A pre-existing legacy blob is read-only for this path, not migrated or overwritten.
    expect(area.data[LEGACY_STORAGE_KEY]).toBe("sentinel");
    expect(Object.keys(area.data).sort()).toEqual([A_KEY, LEGACY_STORAGE_KEY].sort());
  });

  it("lets an explicit key win over the derived one, always", async () => {
    useLocation("https://a.example");
    const area = fakeArea();
    const adapter = createChromeStorageAdapter({ area, key: "bluepencil:custom:v1" });

    await adapter.create(draft("explicit"));

    expect(area.calls.get).toEqual(["bluepencil:custom:v1"]);
    expect(area.calls.set).toEqual(["bluepencil:custom:v1"]);
    // The location would have produced a different key; the explicit one must suppress it.
    expect(area.data[A_KEY]).toBeUndefined();
  });

  it("touches no storage at all on an opaque origin and reports the reason once", async () => {
    // `location.origin === "null"` is what a `file:` page or a sandboxed frame reports. There is no
    // bucket to write to — and a catch-all would share notes between unrelated pages, so the only
    // honest answer is memory.
    useLocation("null");
    const area = fakeArea();
    const onFallback = vi.fn();
    const adapter = createChromeStorageAdapter({ area, onFallback });

    expect(await adapter.list()).toEqual([]);
    const created = await adapter.create(draft("mem"));
    expect(created.body).toBe("mem");
    // Degrade, not reject: the note stays usable for this session.
    expect(await adapter.list()).toHaveLength(1);

    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith({ code: "opaque_origin" });
    expect(area.calls.get).toEqual([]);
    expect(area.calls.set).toEqual([]);
    expect(area.data).toEqual({});
  });

  it("treats an absent location like an opaque origin", async () => {
    // Node has no `location`; the adapter must degrade there too instead of inventing a bucket.
    vi.stubGlobal("location", undefined);
    const onFallback = vi.fn();
    const adapter = createChromeStorageAdapter({ area: fakeArea(), onFallback });

    await adapter.create(draft("headless"));

    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith({ code: "opaque_origin" });
  });

  it("keeps the change in memory when the write fails under the default degrade", async () => {
    useLocation("https://a.example");
    const area = fakeArea();
    area.set = () => Promise.reject(new Error("QUOTA_BYTES quota exceeded"));
    const onFallback = vi.fn();
    const adapter = createChromeStorageAdapter({ area, onFallback });

    // Degrade is the extension's contract: a note has no second copy, so the promise resolves.
    await expect(adapter.create(draft("quota"))).resolves.toMatchObject({ body: "quota" });
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(await adapter.list()).toHaveLength(1);
  });
});

/**
 * The per-origin key layout (G5, SEC-13). These are the helpers the extension relay, the review
 * page and the productive adapter share; the strict parsing is what keeps a spoofed or
 * non-canonical key from opening a pseudo-origin bucket.
 */
describe("per-origin storage keys", () => {
  it("spells the key layout exactly once (AC-B01)", () => {
    expect(LEGACY_STORAGE_KEY).toBe("bluepencil:default:v1");
    expect(NOTES_STORAGE_PREFIX).toBe("bluepencil:v2:");
    expect(ASSIGN_PROVENANCE_PREFIX).toBe("bluepencil:assign:");
    // The legacy key is what `chromeStorageKey()` still produces; the constants cannot drift.
    expect(chromeStorageKey()).toBe(LEGACY_STORAGE_KEY);
  });

  it("derives a key from a canonical origin and nothing else (AC-B01)", () => {
    expect(chromeStorageKeyForOrigin("https://a.example")).toBe("bluepencil:v2:https://a.example");
    expect(chromeStorageKeyForOrigin(null)).toBeNull();
    // A non-canonical string is not a bucket — the key must never disagree with the parser.
    expect(chromeStorageKeyForOrigin("https://A.example")).toBeNull();
    expect(chromeStorageKeyForOrigin("https://a.example:443")).toBeNull();
    expect(chromeStorageKeyForOrigin("")).toBeNull();
  });

  it("parses the canonical per-origin key (AC-B28)", () => {
    expect(parseNotesStorageKey("bluepencil:v2:https://a.example")).toEqual({
      kind: "origin",
      origin: "https://a.example",
    });
    // A non-default port is part of the canonical origin and therefore a valid bucket.
    expect(parseNotesStorageKey("bluepencil:v2:http://127.0.0.1:8787")).toEqual({
      kind: "origin",
      origin: "http://127.0.0.1:8787",
    });
  });

  it("recognises the legacy blob and nothing else (AC-B28)", () => {
    expect(parseNotesStorageKey(LEGACY_STORAGE_KEY)).toEqual({ kind: "legacy" });
    expect(parseNotesStorageKey("bluepencil:settings")).toBeNull();
    expect(parseNotesStorageKey("bluepencil:ui:x")).toBeNull();
    // The assign sidecar is never a note group (B.2), so it must not parse as one.
    expect(parseNotesStorageKey(`${ASSIGN_PROVENANCE_PREFIX}https://a.example`)).toBeNull();
  });

  it.each([
    "bluepencil:v2:",
    "bluepencil:v2:null",
    "bluepencil:v2:file:///x",
    "bluepencil:v2:https://A.example",
    "bluepencil:v2:https://a.example:443",
    "bluepencil:v2:https://a.example/",
    "bluepencil:v2:https://a.example/x",
    "bluepencil:v2: https://a.example",
    "BLUEPENCIL:v2:https://a.example",
    "bluepencil:default:v2:https://a.example",
  ])("rejects a non-canonical remainder as no bucket (AC-B28): %s", (key) => {
    expect(parseNotesStorageKey(key)).toBeNull();
  });

  it("derives the key from the location-like, never from anything else (B.1)", () => {
    expect(storageKeyForLocation({ origin: "https://a.example" })).toBe(
      "bluepencil:v2:https://a.example",
    );
    // Opaque origins (`file:`, sandboxed frames) have no bucket — never a shared catch-all.
    expect(storageKeyForLocation({ origin: "null" })).toBeNull();
    expect(storageKeyForLocation(null)).toBeNull();
    expect(storageKeyForLocation(undefined)).toBeNull();
    expect(storageKeyForLocation({})).toBeNull();
    expect(storageKeyForLocation({ origin: 42 })).toBeNull();
  });
});
