/**
 * The page-side `chrome.storage.local` relay — above all, the write rule (#116, CR-116-01).
 *
 * The bridge is reachable by any page script, so the interesting property is not "a page can store
 * its notes" but "a page cannot write extension state". `bluepencil:settings` carries the hub
 * endpoint and the credential; writing it would let a page repoint the hub relay at an arbitrary
 * origin and use the service worker as a CSP bypass. Reads stay available — that exposure predates
 * the rule and is documented — and the positive path is pinned so the rule cannot be tightened into
 * breaking the layer's own store.
 */
import { describe, expect, it, vi } from "vitest";

import {
  isPageWritableStorageKey,
  relayPageStorage,
  type PageStorageArea,
} from "../../extension/src/storage-relay";

/** A fake area that records every call; a refused write must leave it untouched. */
function fakeArea(initial: Record<string, unknown> = {}): {
  area: PageStorageArea;
  data: Record<string, unknown>;
  calls: string[];
} {
  const data: Record<string, unknown> = { ...initial };
  const calls: string[] = [];
  const area: PageStorageArea = {
    get: async (keys) => {
      calls.push("get");
      const wanted = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const key of wanted) {
        if (key in data) result[key] = data[key];
      }
      return result;
    },
    set: async (items) => {
      calls.push("set");
      Object.assign(data, items);
    },
    remove: async (keys) => {
      calls.push("remove");
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  };
  return { area, data, calls };
}

const SETTINGS = { "bluepencil:settings": { endpoint: "https://attacker.example", auth: "none" } };

describe("page storage relay — write rule", () => {
  it("recognises only the layer's own store namespace", () => {
    expect(isPageWritableStorageKey("bluepencil:default:v1")).toBe(true);
    expect(isPageWritableStorageKey("bluepencil:wiki:v1")).toBe(true);
    expect(isPageWritableStorageKey("bluepencil:team-a:v1")).toBe(true);
    expect(isPageWritableStorageKey("bluepencil:settings")).toBe(false);
    expect(isPageWritableStorageKey("bluepencil:settings:v1")).toBe(false);
    expect(isPageWritableStorageKey("bp-smoke-bridge-sentinel")).toBe(false);
  });

  it("refuses a page-initiated write to bluepencil:settings without touching storage", async () => {
    const { area, data, calls } = fakeArea({ "bluepencil:settings": { endpoint: "http://original" } });
    const reply = await relayPageStorage(area, { op: "set", items: SETTINGS });
    expect(reply).toMatchObject({ ok: false });
    expect(calls).not.toContain("set");
    expect(data["bluepencil:settings"]).toEqual({ endpoint: "http://original" });
  });

  it("refuses a mixed write atomically instead of writing the allowed half", async () => {
    const { area, calls } = fakeArea();
    const reply = await relayPageStorage(area, {
      op: "set",
      items: { "bluepencil:default:v1": "{}", ...SETTINGS },
    });
    expect(reply).toMatchObject({ ok: false });
    expect(calls).not.toContain("set");
  });

  it("refuses removing bluepencil:settings", async () => {
    const { area, data, calls } = fakeArea({ "bluepencil:settings": { endpoint: "http://original" } });
    const reply = await relayPageStorage(area, { op: "remove", keys: "bluepencil:settings" });
    expect(reply).toMatchObject({ ok: false });
    expect(calls).not.toContain("remove");
    expect(data["bluepencil:settings"]).toBeDefined();
  });

  it("allows the store blob the layer actually writes", async () => {
    const { area, data } = fakeArea();
    const reply = await relayPageStorage(area, {
      op: "set",
      items: { "bluepencil:default:v1": "{\"notes\":[]}" },
    });
    expect(reply).toEqual({ ok: true });
    expect(data["bluepencil:default:v1"]).toBe("{\"notes\":[]}");
    const removed = await relayPageStorage(area, { op: "remove", keys: ["bluepencil:default:v1"] });
    expect(removed).toEqual({ ok: true });
    expect(data["bluepencil:default:v1"]).toBeUndefined();
  });

  it("keeps reads available, including the settings exposure that predates the rule", async () => {
    const { area } = fakeArea({ "bluepencil:settings": { endpoint: "http://original" } });
    const reply = await relayPageStorage(area, { op: "get", keys: "bluepencil:settings" });
    expect(reply).toMatchObject({ ok: true, value: { "bluepencil:settings": { endpoint: "http://original" } } });
  });

  it("rejects a malformed write and reports a missing area", async () => {
    const { area } = fakeArea();
    expect(await relayPageStorage(area, { op: "set", items: "nope" })).toMatchObject({ ok: false });
    expect(await relayPageStorage(area, { op: "remove", keys: 7 })).toMatchObject({ ok: false });
    expect(await relayPageStorage(undefined, { op: "get", keys: [] })).toMatchObject({ ok: false });
  });

  it("reports an unknown operation rather than inventing a result", async () => {
    const { area } = fakeArea();
    const reply = await relayPageStorage(area, { op: "clear" });
    expect(reply).toMatchObject({ ok: false });
  });

  it("keeps the area's error out of a crash without dropping the message", async () => {
    const area: PageStorageArea = {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {
        throw new Error("quota exceeded");
      }),
      remove: vi.fn(async () => undefined),
    };
    const reply = await relayPageStorage(area, { op: "set", items: { "bluepencil:default:v1": "x" } });
    expect(reply).toEqual({ ok: false, error: "quota exceeded" });
  });
});
