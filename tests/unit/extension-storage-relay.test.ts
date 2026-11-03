/**
 * The page-side `chrome.storage.local` relay — one key, derived from the bridge's own location.
 *
 * The bridge is reachable by any page script, so the interesting property is not "a page can store
 * its notes" but "a page cannot select a foreign bucket". Since 0.12 the extension partitions
 * storage per origin (`bluepencil:v2:<origin>`, SEC-13): the relay takes a `location`, derives the
 * one permitted key from it, and refuses anything else by name — settings, the legacy blob, UI
 * state, the assign sidecar and every other origin. An opaque origin has no bucket at all.
 *
 * Every refusal is a code (`foreign_key`, `invalid_envelope`, `opaque_origin`, `unavailable`,
 * `storage_failure`), never a silent drop, and a refusal never touches the area.
 */
import { describe, expect, it, vi } from "vitest";

import { storageKeyForLocation } from "../../src/data/origin";
import {
  relayPageStorage,
  type PageStorageArea,
} from "../../extension/src/storage-relay";

const ORIGIN = "https://a.example";
const LOCATION = { origin: ORIGIN };
const KEY = "bluepencil:v2:https://a.example";
const OTHER_KEY = "bluepencil:v2:https://b.example";
const SETTINGS_KEY = "bluepencil:settings";
const LEGACY_KEY = "bluepencil:default:v1";
const UI_KEY = "bluepencil:ui:panel";
const SIDECAR_KEY = "bluepencil:assign:https://a.example";

/** A fake area that records every call; a refused request must leave it untouched. */
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

describe("storageKeyForLocation — the only key derivation the relay uses", () => {
  it("derives the per-origin key from the location-like (AC-B29)", () => {
    expect(storageKeyForLocation(LOCATION)).toBe(KEY);
    expect(storageKeyForLocation({ origin: "http://127.0.0.1:8787" })).toBe(
      "bluepencil:v2:http://127.0.0.1:8787",
    );
  });

  it("normalises a non-canonical location-like to the canonical key", () => {
    // Browsers hand a canonical origin to a content script; normalising here means a hand-made
    // location-like cannot create a second spelling of the same bucket.
    expect(storageKeyForLocation({ origin: "https://A.example" })).toBe(KEY);
    expect(storageKeyForLocation({ origin: "https://a.example/" })).toBe(KEY);
    expect(storageKeyForLocation({ origin: "https://a.example:443" })).toBe(KEY);
  });

  it("refuses opaque inputs instead of inventing a bucket (AC-B05)", () => {
    expect(storageKeyForLocation({ origin: "null" })).toBeNull();
    expect(storageKeyForLocation({ origin: "file:///tmp/x" })).toBeNull();
    expect(storageKeyForLocation(null)).toBeNull();
    expect(storageKeyForLocation(undefined)).toBeNull();
    expect(storageKeyForLocation({})).toBeNull();
  });
});

describe("storage relay — envelope shape (AC-B02, AC-B29)", () => {
  it("refuses a page-supplied origin or key instead of using it", async () => {
    const spoofedOrigin = fakeArea();
    const originReply = await relayPageStorage(
      spoofedOrigin.area,
      { op: "get", keys: KEY, origin: OTHER_KEY } as never,
      LOCATION,
    );
    expect(originReply).toMatchObject({ ok: false, code: "invalid_envelope" });
    expect(spoofedOrigin.calls).toEqual([]);

    const spoofedKey = fakeArea();
    const keyReply = await relayPageStorage(
      spoofedKey.area,
      { op: "get", keys: KEY, key: OTHER_KEY } as never,
      LOCATION,
    );
    expect(keyReply).toMatchObject({ ok: false, code: "invalid_envelope" });
    expect(spoofedKey.calls).toEqual([]);
  });

  it("refuses any field that is not op/keys/items", async () => {
    const { area, calls } = fakeArea();
    expect(
      await relayPageStorage(area, { op: "get", keys: KEY, extra: true } as never, LOCATION),
    ).toMatchObject({ ok: false, code: "invalid_envelope" });
    expect(calls).toEqual([]);
  });

  it("requires a known operation", async () => {
    const { area, calls } = fakeArea();
    expect(await relayPageStorage(area, {}, LOCATION)).toMatchObject({
      ok: false,
      code: "invalid_envelope",
    });
    expect(await relayPageStorage(area, { op: 7 }, LOCATION)).toMatchObject({
      ok: false,
      code: "invalid_envelope",
    });
    expect(await relayPageStorage(area, { op: "clear" }, LOCATION)).toMatchObject({
      ok: false,
      code: "invalid_envelope",
    });
    expect(calls).toEqual([]);
  });

  it("requires the payload shape the operation uses", async () => {
    const { area, calls } = fakeArea();
    expect(await relayPageStorage(area, { op: "get", keys: null }, LOCATION)).toMatchObject({
      ok: false,
      code: "invalid_envelope",
    });
    expect(await relayPageStorage(area, { op: "get", keys: 7 }, LOCATION)).toMatchObject({
      ok: false,
      code: "invalid_envelope",
    });
    expect(await relayPageStorage(area, { op: "get", keys: [KEY, 7] }, LOCATION)).toMatchObject({
      ok: false,
      code: "invalid_envelope",
    });
    expect(await relayPageStorage(area, { op: "set", items: "nope" }, LOCATION)).toMatchObject({
      ok: false,
      code: "invalid_envelope",
    });
    expect(await relayPageStorage(area, { op: "set", items: [] }, LOCATION)).toMatchObject({
      ok: false,
      code: "invalid_envelope",
    });
    expect(await relayPageStorage(area, { op: "remove" }, LOCATION)).toMatchObject({
      ok: false,
      code: "invalid_envelope",
    });
    expect(calls).toEqual([]);
  });

  it("treats a non-object envelope as invalid", async () => {
    const { area, calls } = fakeArea();
    expect(await relayPageStorage(area, null as never, LOCATION)).toMatchObject({
      ok: false,
      code: "invalid_envelope",
    });
    expect(calls).toEqual([]);
  });
});

describe("storage relay — only the derived key may be named (AC-B03, AC-B04, AC-B16, AC-B29)", () => {
  const foreignKeys = [
    SETTINGS_KEY,
    UI_KEY,
    LEGACY_KEY,
    OTHER_KEY,
    SIDECAR_KEY,
    "bluepencil:v2:https://A.example",
  ];

  it.each(foreignKeys)("get(%s) is a foreign_key without a storage call", async (key) => {
    const { area, data, calls } = fakeArea({
      [key]: "extension state",
      [KEY]: "own blob",
    });
    const reply = await relayPageStorage(area, { op: "get", keys: key }, LOCATION);
    expect(reply).toMatchObject({ ok: false, code: "foreign_key" });
    expect(calls).toEqual([]);
    expect(data[key]).toBe("extension state");
  });

  it("never reads the settings blob, so the credential cannot leave the isolated world (AC-B16)", async () => {
    const { area, calls } = fakeArea({ [SETTINGS_KEY]: { endpoint: "https://attacker.example" } });
    expect(await relayPageStorage(area, { op: "get", keys: SETTINGS_KEY }, LOCATION)).toMatchObject({
      ok: false,
      code: "foreign_key",
    });
    expect(calls).toEqual([]);
  });

  it("allows a string key and a one-element array, both yielding the same value", async () => {
    const { area } = fakeArea({ [KEY]: "{\"notes\":[]}" });
    const asString = await relayPageStorage(area, { op: "get", keys: KEY }, LOCATION);
    const asList = await relayPageStorage(area, { op: "get", keys: [KEY] }, LOCATION);
    expect(asString).toEqual({ ok: true, value: { [KEY]: "{\"notes\":[]}" } });
    expect(asList).toEqual(asString);
  });

  it("refuses an empty or multi-key read (AC-B04)", async () => {
    const { area, calls } = fakeArea({ [KEY]: "own" });
    expect(await relayPageStorage(area, { op: "get", keys: [] }, LOCATION)).toMatchObject({
      ok: false,
      code: "foreign_key",
    });
    expect(await relayPageStorage(area, { op: "get", keys: [KEY, SETTINGS_KEY] }, LOCATION)).toMatchObject({
      ok: false,
      code: "foreign_key",
    });
    expect(calls).toEqual([]);
  });

  it("refuses a two-key write atomically instead of writing the allowed half (AC-B04)", async () => {
    const { area, data, calls } = fakeArea({ [KEY]: "own" });
    const reply = await relayPageStorage(
      area,
      { op: "set", items: { [KEY]: "new", [OTHER_KEY]: "leak" } },
      LOCATION,
    );
    expect(reply).toMatchObject({ ok: false, code: "foreign_key" });
    expect(calls).toEqual([]);
    expect(data).toEqual({ [KEY]: "own" });
  });

  it("refuses writing settings, the legacy blob, UI state or the sidecar (AC-B03)", async () => {
    for (const key of [SETTINGS_KEY, LEGACY_KEY, UI_KEY, SIDECAR_KEY, OTHER_KEY]) {
      const { area, calls } = fakeArea();
      const reply = await relayPageStorage(area, { op: "set", items: { [key]: "x" } }, LOCATION);
      expect(reply, key).toMatchObject({ ok: false, code: "foreign_key" });
      expect(calls, key).toEqual([]);
    }
  });

  it("refuses an empty write (AC-B04)", async () => {
    const { area, calls } = fakeArea();
    expect(await relayPageStorage(area, { op: "set", items: {} }, LOCATION)).toMatchObject({
      ok: false,
      code: "foreign_key",
    });
    expect(calls).toEqual([]);
  });

  it("refuses removing more than the derived key (AC-B04)", async () => {
    const { area, data, calls } = fakeArea({ [KEY]: "own", [SETTINGS_KEY]: "state" });
    expect(
      await relayPageStorage(area, { op: "remove", keys: [KEY, SETTINGS_KEY] }, LOCATION),
    ).toMatchObject({ ok: false, code: "foreign_key" });
    expect(await relayPageStorage(area, { op: "remove", keys: SETTINGS_KEY }, LOCATION)).toMatchObject({
      ok: false,
      code: "foreign_key",
    });
    expect(calls).toEqual([]);
    expect(data[KEY]).toBe("own");
    expect(data[SETTINGS_KEY]).toBe("state");
  });

  it("allows the layer's own read, write and remove", async () => {
    const { area, data } = fakeArea({ [KEY]: "{\"notes\":[]}" });
    expect(await relayPageStorage(area, { op: "get", keys: KEY }, LOCATION)).toEqual({
      ok: true,
      value: { [KEY]: "{\"notes\":[]}" },
    });
    expect(await relayPageStorage(area, { op: "set", items: { [KEY]: "{\"notes\":[1]}" } }, LOCATION)).toEqual({
      ok: true,
    });
    expect(data[KEY]).toBe("{\"notes\":[1]}");
    expect(await relayPageStorage(area, { op: "remove", keys: [KEY] }, LOCATION)).toEqual({ ok: true });
    expect(data[KEY]).toBeUndefined();
  });
});

describe("storage relay — opaque origin has no bucket (AC-B05)", () => {
  const opaqueLocations = [{ origin: "null" }, { origin: "file:///tmp/x" }, null];

  it.each(opaqueLocations)("refuses every operation for %j without a storage call", async (location) => {
    const { area, calls } = fakeArea({ [KEY]: "own" });
    for (const envelope of [
      { op: "get", keys: KEY },
      { op: "set", items: { [KEY]: "x" } },
      { op: "remove", keys: KEY },
    ]) {
      expect(await relayPageStorage(area, envelope, location)).toMatchObject({
        ok: false,
        code: "opaque_origin",
      });
    }
    expect(calls).toEqual([]);
  });
});

describe("storage relay — unavailable and failing areas never escape as a throw (AC-B30)", () => {
  it("reports a missing area as unavailable", async () => {
    expect(await relayPageStorage(undefined, { op: "get", keys: KEY }, LOCATION)).toMatchObject({
      ok: false,
      code: "unavailable",
    });
    expect(await relayPageStorage(undefined, { op: "set", items: { [KEY]: "x" } }, LOCATION)).toMatchObject({
      ok: false,
      code: "unavailable",
    });
    expect(await relayPageStorage(undefined, { op: "remove", keys: KEY }, LOCATION)).toMatchObject({
      ok: false,
      code: "unavailable",
    });
  });

  it("maps a throwing get/set/remove to storage_failure with the message", async () => {
    const throwing: PageStorageArea = {
      get: vi.fn(async () => {
        throw new Error("read failed");
      }),
      set: vi.fn(async () => {
        throw new Error("quota exceeded");
      }),
      remove: vi.fn(async () => {
        throw new Error("remove failed");
      }),
    };
    await expect(relayPageStorage(throwing, { op: "get", keys: KEY }, LOCATION)).resolves.toEqual({
      ok: false,
      code: "storage_failure",
      error: "read failed",
    });
    await expect(
      relayPageStorage(throwing, { op: "set", items: { [KEY]: "x" } }, LOCATION),
    ).resolves.toEqual({ ok: false, code: "storage_failure", error: "quota exceeded" });
    await expect(relayPageStorage(throwing, { op: "remove", keys: KEY }, LOCATION)).resolves.toEqual({
      ok: false,
      code: "storage_failure",
      error: "remove failed",
    });
  });
});
