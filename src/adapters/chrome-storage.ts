/**
 * `chrome.storage` adapter — the extension's local mode (ARCHITECTURE §4, #34).
 *
 * Why this exists next to the `localStorage` adapter: an extension runs on every site the user
 * visits, and each site has its OWN `localStorage`. A note taken on the intranet would be invisible
 * on the wiki, because the bookmarklet default keys the blob by host. `chrome.storage.local` is
 * partitioned by *extension*, not by page, so one store is shared across every tab and every site
 * — which is what "review a page, then follow the link and keep the thread" needs.
 *
 * It reuses `createJsonAdapter` from `memory.ts`, so the read-modify-write queue, the degrade path
 * and the single-report rule are the same ones the `localStorage` adapter already proves. Only the
 * two I/O primitives differ, and both are promise-based because the `chrome.storage` API is.
 *
 * The module never touches `chrome` at import time: the namespace is looked up lazily, so the
 * bundle stays importable in a plain page (where the element can fall back to `localStorage`)
 * instead of throwing on a missing extension API.
 *
 * ## One bucket per origin (G5, SEC-13)
 *
 * The default key is **not** the shared blob any more. An explicit `key` still wins (CLI, tests,
 * a host that wants a deliberately shared store), otherwise the key is derived from the page's
 * `location` through `storageKeyForLocation` — the same derivation the extension relay uses, so a
 * page cannot be handed a key for a different origin. When the origin is opaque (`file:`, a
 * sandboxed frame) there is no bucket: the adapter never touches `chrome.storage.local` and
 * degrades to memory, reporting `{ code: "opaque_origin" }` once (B.1, AC-B41).
 *
 * `chromeStorageKey()` stays exported and unchanged for explicitly named instances/hosts.
 */
import type { Adapter } from "../core/adapter";
import { storageKeyForLocation } from "../data/origin";
import { createJsonAdapter, type JsonAdapterIo } from "./memory";

/** Adapter name reported to the store and to hosts. */
export const CHROME_STORAGE_ADAPTER_NAME = "chromeStorage";

/** Key layout version; bumped when the blob layout changes (NFR-9). */
export const STORAGE_KEY_VERSION = "v1";

/** A default `chrome.storage` key layout: shared across all sites for one instance. */
export function chromeStorageKey(instance?: string): string {
  const scope = instance && instance.length > 0 ? instance : "default";
  return `bluepencil:${scope}:${STORAGE_KEY_VERSION}`;
}

/** The slice of the `chrome.storage.local` API this adapter uses. */
export interface ChromeStorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

interface ChromeStorageLike {
  local?: ChromeStorageArea;
}

function globalChromeStorage(): ChromeStorageArea | null {
  const runtime = (globalThis as { chrome?: ChromeStorageLike }).chrome;
  if (runtime === undefined) return null;
  return runtime.local ?? null;
}

/** `globalThis.location` without assuming a DOM — a plain Node process has none. */
function currentLocation(): { origin?: unknown } | null {
  try {
    return (globalThis as { location?: { origin?: unknown } }).location ?? null;
  } catch {
    // A host can define `location` as a throwing accessor; "no location" is the safe answer.
    return null;
  }
}

/**
 * Why no bucket exists: the page origin is opaque (`file:`, sandboxed frame) or absent.
 *
 * A named object rather than a string so the bootstrap can format the memory-only report without
 * parsing (B.1). One shared instance is fine — it is a reason, never state.
 */
const OPAQUE_ORIGIN_REASON = Object.freeze({ code: "opaque_origin" as const });

export interface ChromeStorageAdapterOptions {
  /**
   * Explicit storage key; wins over the derived per-origin key, always.
   *
   * Meant for named instances and hosts (CLI, tests, a deliberately shared blob). The default —
   * and therefore the extension's path — derives the key from `globalThis.location`, so two origins
   * never share a blob (AC-B06/AC-B41).
   */
  key?: string;
  /**
   * The area to use. Injectable for tests and for a service worker that passes its own handle.
   * When omitted the global `chrome.storage.local` is resolved lazily, on first use.
   */
  area?: ChromeStorageArea | null;
  /**
   * What a failing write means for the caller.
   *
   * `"degrade"` is the default here, matching the `localStorage` adapter: `chrome.storage` is the
   * *only* copy a note has in the extension, so keeping the change in memory and reporting it once
   * beats rejecting the promise. The write is still reported through `onFallback`.
   */
  writeFailure?: "reject" | "degrade";
  onFallback?: (reason: unknown) => void;
}

export function createChromeStorageAdapter(
  options: ChromeStorageAdapterOptions = {},
): Adapter {
  // B.1 key precedence: explicit key → derived from the page location → no bucket. It is resolved
  // once, at construction: the location cannot change without a navigation, and a stable key is
  // what keeps a read and a write of the same adapter on the same blob.
  const key =
    options.key !== undefined ? options.key : storageKeyForLocation(currentLocation());
  let warned = false;

  function withStorage<T>(
    operation: (area: ChromeStorageArea, storageKey: string) => Promise<T>,
  ): Promise<T> {
    // `null` means "no bucket", never a catch-all: the area is not touched at all (AC-B41).
    if (key === null) {
      return Promise.reject(OPAQUE_ORIGIN_REASON);
    }
    // Resolved per call, not captured: the extension API is absent in a plain page, and the store
    // must degrade to memory there rather than fail at construction.
    const area = options.area === undefined ? globalChromeStorage() : options.area;
    if (area === null || area === undefined) {
      return Promise.reject(new Error("chrome.storage.local is unavailable"));
    }
    return operation(area, key);
  }

  const io: JsonAdapterIo = {
    readText: () =>
      withStorage(async (area, storageKey) => {
        const stored = await area.get(storageKey);
        const value = stored[storageKey];
        if (typeof value !== "string") return null;
        return value;
      }),
    writeText: (text: string) =>
      withStorage((area, storageKey) => area.set({ [storageKey]: text })),
    onFallback: (reason: unknown) => {
      // Reported once per adapter instance, matching NFR-14: a degrading store must not turn into
      // a log stream, and the caller decides how to surface it.
      if (warned) return;
      warned = true;
      if (options.onFallback) options.onFallback(reason);
      else {
        console.debug(
          `[bluepencil] ${CHROME_STORAGE_ADAPTER_NAME} degraded to memory; the note lives only in this tab`,
          reason,
        );
      }
    },
    // A note in the extension has no second copy, so a failed write keeps the change in memory and
    // reports it once rather than rejecting — the same contract as the localStorage adapter.
    writeFailure: options.writeFailure ?? "degrade",
  };

  return createJsonAdapter(CHROME_STORAGE_ADAPTER_NAME, io);
}
