/**
 * `chrome.storage` adapter — how the store is partitioned across sites (G5, SEC-13).
 *
 * Until 0.12.0 this suite proved the opposite of what it proves now: one shared blob meant a note
 * written on one site was visible on every other. That property is exactly the finding SEC-13
 * names — an intranet note leaked into the wiki — so the adapter now derives its key from the page
 * origin. The interesting behaviour is therefore *not* "a note travels between origins" but "two
 * origins never touch the same blob, and neither uses the legacy shared key" (AC-B06).
 *
 * The setup is unchanged, which is the point: two genuinely different origins with separate
 * globals and separate `localStorage`s, one shared `chrome.storage.local`. Only the expectation is
 * inverted. A `localStorage`-backed store could not satisfy either version, because its key is per
 * host and its storage is per origin; `chrome.storage` is per extension, which is why the adapter
 * has to do the partitioning itself.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import { createChromeStorageAdapter } from "../../src/adapters/chrome-storage.js";
import { LEGACY_STORAGE_KEY } from "../../src/data/origin.js";
import {
  relayPageStorage,
  type PageStorageArea,
  type PageStorageEnvelope,
} from "../../extension/src/storage-relay";
import type { NoteDraft } from "../../src/core/model";

const DRAFT: NoteDraft = {
  type: "text",
  body: "The layer must survive a follow-up link to another site.",
  anchor: { selector: "#article", quote: "the intro paragraph" },
};

interface FakeStorage {
  data: Map<string, unknown>;
  area: {
    get: (k: string) => Promise<Record<string, unknown>>;
    set: (items: Record<string, unknown>) => Promise<void>;
    remove: (k: string) => Promise<void>;
  };
}

/** A `chrome.storage.local` stand-in: one map, shared by every origin, like the real thing. */
function fakeChromeStorage(): FakeStorage {
  const data = new Map<string, unknown>();
  return {
    data,
    area: {
      get: (k) => Promise.resolve(data.has(k) ? { [k]: data.get(k) } : {}),
      set: (items) => {
        for (const [k, v] of Object.entries(items)) data.set(k, v);
        return Promise.resolve();
      },
      remove: (k) => {
        data.delete(k);
        return Promise.resolve();
      },
    },
  };
}

/**
 * The page-side area the adapter sees in the extension: every call goes through the relay.
 *
 * In the real page the bridge performs that call in the isolated world and posts the answer back;
 * the relay is the enforcement point either way. A refusal is surfaced as a rejection, exactly as
 * the bridge does, so the adapter's degrade path is the same one production takes.
 */
function bridgedArea(area: PageStorageArea, location: { origin?: unknown }) {
  const call = async (envelope: PageStorageEnvelope): Promise<Record<string, unknown>> => {
    const reply = await relayPageStorage(area, envelope, location);
    if (!reply.ok) throw new Error(`${reply.code}: ${reply.error}`);
    return reply.value ?? {};
  };
  return {
    get: (keys: string | string[]) => call({ op: "get", keys }),
    set: (items: Record<string, unknown>) => call({ op: "set", items }).then(() => undefined),
    remove: (keys: string | string[]) => call({ op: "remove", keys }).then(() => undefined),
  };
}

/**
 * An origin with its own `window`, its own `localStorage` and its own `location`, and optionally
 * its own `chrome`.
 *
 * Two of these are two different websites as far as the adapter is concerned: separate globals,
 * separate location, no shared references. The location is what the productive adapter derives its
 * key from, so it is the central input of this suite (B.1).
 */

function makeOrigin(opts: { host: string; chrome?: unknown }): {
  host: string;
  localStorage: Map<string, string>;
  restore: () => void;
} {
  const store = new Map<string, string>();
  const g = globalThis as Record<string, unknown>;
  const previous = {
    window: g.window,
    localStorage: g.localStorage,
    chrome: g.chrome,
    location: Object.getOwnPropertyDescriptor(globalThis, "location"),
  };

  const localStorageShim = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  g.window = { localStorage: localStorageShim };
  setGlobal("localStorage", localStorageShim);
  setGlobal("location", { origin: `https://${opts.host}` });
  if (opts.chrome === undefined) delete g.chrome;
  else g.chrome = opts.chrome;

  return {
    host: opts.host,
    localStorage: store,
    restore: () => {
      g.window = previous.window;
      setGlobal("localStorage", previous.localStorage);
      g.chrome = previous.chrome;
      if (previous.location) {
        Object.defineProperty(globalThis, "location", previous.location);
      } else {
        delete g.location;
      }
    },
  };
}

/** Installs the globals for one test and hands back a restorer. */
function useOrigin(chrome: unknown | undefined): { localStorage: Map<string, string> } {
  const origin = makeOrigin({ host: "t.test", chrome });
  restorers.push(origin.restore);
  return origin;
}

/**
 * Installs a global that jsdom exposes as a getter.
 *
 * jsdom defines `localStorage` (and, on the jsdom window, `location`) as accessor properties, so
 * `globalThis.localStorage = shim` throws "Cannot set property localStorage of [object Window]
 * which has only a getter". A descriptor is what makes a second "origin" testable at all, which is
 * the whole point of this suite.
 */
function setGlobal(key: string, value: unknown): void {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

const restorers: (() => void)[] = [];
afterEach(() => {
  while (restorers.length) restorers.pop()!();
});

/** The derived key for the helper origin `t.test`. */
const T_KEY = "bluepencil:v2:https://t.test";

/**
 * Silences the adapter's degrade message for the duration of a test.
 *
 * These cases exercise the degrade path on purpose, so the message is expected — but six of them
 * printing the same line into a shared test run makes a real failure hard to spot. Capturing it is
 * also an assertion in its own right: the single-report rule (NFR-14) is only proven if the message
 * appears at all, so `onFallback` is the tested channel and the console write is what is muted.
 */
async function withMutedConsole<T>(run: () => Promise<T>): Promise<{ result: T; said: unknown[][] }> {
  const original = console.debug;
  const said: unknown[][] = [];
  console.debug = (...args: unknown[]) => {
    said.push(args);
  };
  try {
    return { result: await run(), said };
  } finally {
    console.debug = original;
  }
}

describe("chromeStorage — one bucket per origin, never the legacy blob (AC-B06)", () => {
  it("keeps a note on the origin it was written on, with separate keys", async () => {
    const fake = fakeChromeStorage();
    const { area } = fake;

    // Origin A: construct the adapter while A's location is active — the key is resolved there.
    const a = makeOrigin({ host: "a.example", chrome: { local: area } });
    const first = createChromeStorageAdapter();
    const created = await first.create(DRAFT);
    // A fresh instance on A is the "reload": new adapter, same origin, same area.
    const reloaded = createChromeStorageAdapter();

    // Origin B: a different site with its own location, sharing the extension's storage area.
    const b = makeOrigin({ host: "b.example", chrome: { local: area } });
    // LIFO: restore B first (back to A), then A (back to jsdom's own location).
    restorers.push(a.restore, b.restore);

    const onB = createChromeStorageAdapter();
    expect(await onB.list()).toEqual([]);

    const aKey = "bluepencil:v2:https://a.example";
    expect(fake.data.has(aKey)).toBe(true);
    expect(fake.data.has("bluepencil:v2:https://b.example")).toBe(false);
    // The legacy shared blob is not part of the productive path: no read, no write.
    expect(fake.data.has(LEGACY_STORAGE_KEY)).toBe(false);
    // …and A is complete after the reload, because that adapter kept A's key.
    expect(await reloaded.list()).toHaveLength(1);
    expect((await reloaded.list())[0]?.id).toBe(created.id);
  });

  it("does not touch the page's localStorage at all", async () => {
    // Partitioning by extension, not by page. A note must never leak into the host page's own
    // storage: the extension shares one store with the user, but not with the site.
    const fake = fakeChromeStorage();
    const site = useOrigin({ local: fake.area });

    await createChromeStorageAdapter().create(DRAFT);

    expect(site.localStorage.size).toBe(0);
    expect(fake.data.has(T_KEY)).toBe(true);
    expect(fake.data.has(LEGACY_STORAGE_KEY)).toBe(false);
  });
});

describe("chromeStorage — with the page relay (AC-B42)", () => {
  it("refuses a foreign-key write and keeps its own blob complete after a reload", async () => {
    const fake = fakeChromeStorage();
    const site = makeOrigin({ host: "a.example", chrome: { local: fake.area } });
    restorers.push(site.restore);
    const location = { origin: "https://a.example" };
    const area = fake.area as unknown as PageStorageArea;

    // What any page script can attempt: select B's bucket through the bridge channel.
    const before = fake.data.size;
    const refused = await relayPageStorage(
      area,
      { op: "set", items: { "bluepencil:v2:https://b.example": "{}" } },
      location,
    );
    expect(refused).toMatchObject({ ok: false, code: "foreign_key" });
    // Refused before the storage call: B is unchanged and nothing else was touched either.
    expect(fake.data.size).toBe(before);
    expect(fake.data.has("bluepencil:v2:https://b.example")).toBe(false);

    // The productive adapter, no explicit key, on A, over the relay.
    const adapter = createChromeStorageAdapter({
      area: bridgedArea(area, location),
      onFallback: vi.fn(),
    });
    const created = await adapter.create(DRAFT);
    expect(fake.data.has("bluepencil:v2:https://a.example")).toBe(true);

    // Reload on A: a fresh adapter over a fresh relay view reads the same blob back in full.
    const reloaded = createChromeStorageAdapter({
      area: bridgedArea(area, location),
      onFallback: vi.fn(),
    });
    expect(await reloaded.list()).toHaveLength(1);
    expect((await reloaded.list())[0]?.id).toBe(created.id);
    expect(fake.data.has("bluepencil:v2:https://b.example")).toBe(false);
  });
});

describe("chromeStorage — the extension API is not always there", () => {
  it("degrades to memory in a plain page, where there is no chrome at all", async () => {
    // The element bundle is also used in embed mode, on pages that are not an extension host. If
    // using this adapter threw there, the embed path would break for everyone because of a feature
    // only the extension uses.
    useOrigin(undefined);

    const adapter = createChromeStorageAdapter();
    const { result } = await withMutedConsole(async () => {
      const created = await adapter.create(DRAFT);
      return { created, listed: await adapter.list() };
    });

    expect(result.created).toMatchObject({ body: DRAFT.body });
    expect(result.listed).toHaveLength(1);
  });

  it("degrades when chrome exists but storage.local does not", async () => {
    // Measured shape of the failure: the namespace is there, the area is not. A check for `chrome`
    // alone would miss this and then call `area.get` on undefined.
    useOrigin({});

    const { result } = await withMutedConsole(() => createChromeStorageAdapter().create(DRAFT));
    expect(result).toMatchObject({ body: DRAFT.body });
  });

  it("reports the degrade exactly once, not once per operation (NFR-14)", async () => {
    // A store that logs on every failed write turns into a log stream on a page where it can never
    // succeed. The single-report rule is what stops that.
    useOrigin(undefined);
    const onFallback = vi.fn();
    const adapter = createChromeStorageAdapter({ onFallback });

    for (let i = 0; i < 5; i += 1) await adapter.create({ ...DRAFT, body: `note ${i}` });

    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("honours an explicit null area instead of falling back to the global", async () => {
    // An explicit `null` is a decision, not an absence: the service worker passes its own handle, and
    // a caller that passes null must not have the global silently picked up instead.
    const fake = fakeChromeStorage();
    useOrigin({ local: fake.area });

    const onFallback = vi.fn();
    const adapter = createChromeStorageAdapter({ area: null, onFallback });
    await adapter.create(DRAFT);

    expect(fake.data.size).toBe(0);
    expect(onFallback).toHaveBeenCalled();
  });
});

describe("chromeStorage — a hostile or corrupt stored blob", () => {
  function useStored(value: unknown): FakeStorage {
    const fake = fakeChromeStorage();
    // The productive path reads the per-origin key; a corrupt *legacy* blob is a different store
    // and must not influence it (AC-B41, "never the legacy key").
    fake.data.set(T_KEY, value);
    useOrigin({ local: fake.area });
    return fake;
  }

  it("starts clean when the stored value is not a string", async () => {
    // The blob is whatever an older version, a devtools edit or a partial write left behind. A
    // non-string must read as "no notes yet", never as a crash on startup.
    for (const junk of [42, null, true, { notes: [] }, ["x"], undefined]) {
      useStored(junk);
      await expect(createChromeStorageAdapter().list()).resolves.toEqual([]);
      restorers.length = 0;
    }
  });

  it("starts clean when the stored string is not valid JSON", async () => {
    // The degrade message is muted for the same reason as above: this case provokes it on purpose.
    useStored("{not json");
    const { result } = await withMutedConsole(() => createChromeStorageAdapter().list());
    expect(result).toEqual([]);
  });

  it("keeps working after a corrupt blob, rather than wedging permanently", async () => {
    // The one that matters: if a corrupt read poisoned the in-memory state, every later write would
    // fail too and the user could never take another note without reinstalling the extension.
    useStored("{{{ corrupt");
    const adapter = createChromeStorageAdapter();
    const { result } = await withMutedConsole(async () => {
      const listed = await adapter.list();
      const created = await adapter.create(DRAFT);
      return { listed, created, after: await adapter.list() };
    });

    expect(result.listed).toEqual([]);
    expect(result.after).toHaveLength(1);
    expect(result.created).toMatchObject({ body: DRAFT.body });
  });

  it("rejects when the write itself fails under writeFailure: reject", async () => {
    // `writeFailure` governs the *write*, not the read. A corrupt blob on disk is a different thing:
    // `load()` degrades on it and the next write replaces it, which is the recovery path. To test
    // the reject policy the write has to fail on its own — which is what a storage area that rejects
    // does.
    const fake = fakeChromeStorage();
    fake.area.set = () => Promise.reject(new Error("QUOTA_BYTES quota exceeded"));
    useOrigin({ local: fake.area });

    const adapter = createChromeStorageAdapter({ writeFailure: "reject" });
    const { said } = await withMutedConsole(async () => {
      await expect(adapter.create(DRAFT)).rejects.toThrow(/quota/i);
      return null;
    });
    // The rejection is the contract; the message is not, but it must be there exactly once.
    expect(said.length, "degrade reported once").toBeLessThanOrEqual(1);
  });

  it("replaces the corrupt blob on the next create, so a fresh adapter reads the note back", async () => {
    // Regression for issue #39: a failed read used to latch the *same* degrade flag that also gated
    // writes, so nothing was ever written again for the session and the bad blob on disk stayed
    // there. A corrupt read must degrade reads only: the in-memory set is authoritative and writing
    // it back is exactly the recovery that replaces the blob.
    const fake = useStored("{{{ corrupt");
    const adapter = createChromeStorageAdapter();

    const { result } = await withMutedConsole(async () => {
      const created = await adapter.create(DRAFT);
      return {
        created,
        listed: await adapter.list(),
        onDisk: fake.data.get(T_KEY),
        fresh: await createChromeStorageAdapter().list(),
      };
    });

    // The note is in memory and reachable…
    expect(result.listed).toHaveLength(1);
    // …and the corrupt blob was replaced, so the damage does not outlive this session.
    expect(result.onDisk).not.toBe("{{{ corrupt");
    // A fresh adapter — the next tab, the next session — reads the note back.
    expect(result.fresh).toHaveLength(1);
    expect(result.fresh[0]?.id).toBe(result.created.id);
    // The recovery wrote the per-origin key, never the legacy blob.
    expect(fake.data.has(LEGACY_STORAGE_KEY)).toBe(false);
  });
});
