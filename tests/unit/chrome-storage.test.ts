/**
 * `chrome.storage` adapter — the extension's local store (#34).
 *
 * The happy path is shared with every other adapter through `createJsonAdapter` and is already
 * covered by the conformance suite in `adapters.test.ts`. What matters here is the behaviour that
 * is specific to this adapter: the lazy `chrome` lookup, the cross-origin sharing that
 * `localStorage` cannot provide, and the degrade path on a page with no extension API.
 */

import { describe, expect, it, vi } from "vitest";

import { createMemoryAdapter } from "../../src/adapters/memory";
import {
  CHROME_STORAGE_ADAPTER_NAME,
  chromeStorageKey,
  createChromeStorageAdapter,
  type ChromeStorageArea,
} from "../../src/adapters/chrome-storage";
import { createStore } from "../../src/core/store";
import type { NoteDraft } from "../../src/core/model";

/** A minimal in-memory stand-in for `chrome.storage.local`, promise-based like the real one. */
function fakeArea(
  initial: Record<string, unknown> = {},
): ChromeStorageArea & { data: Record<string, unknown> } {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      const names = typeof keys === "string" ? [keys] : keys;
      const out: Record<string, unknown> = {};
      for (const name of names) if (name in data) out[name] = data[name];
      return out;
    },
    async set(items) {
      Object.assign(data, items);
    },
    async remove(keys) {
      for (const name of typeof keys === "string" ? [keys] : keys) delete data[name];
    },
  };
}

function draft(body: string): NoteDraft {
  return { type: "text", body, anchor: { hook: `h-${body}`, route: "/page" } };
}

describe("chromeStorage adapter", () => {
  it("keys the blob per instance and defaults to a shared scope", () => {
    expect(chromeStorageKey()).toBe("bluepencil:default:v1");
    expect(chromeStorageKey("wiki")).toBe("bluepencil:wiki:v1");
  });

  it("round-trips a note through the injected area", async () => {
    const area = fakeArea();
    const adapter = createChromeStorageAdapter({ area });
    const note = await adapter.create(draft("A"));
    expect(note.id).toBeTruthy();
    expect(area.data[chromeStorageKey()]).toContain("h-A");

    const listed = await adapter.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.body).toBe("A");
  });

  it("shares one blob across adapter instances, which localStorage cannot do per origin", async () => {
    // The reason this adapter exists: a second tab, or a different site, reads the same notes.
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
    const area = fakeArea({ [chromeStorageKey()]: "{not json" });
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
