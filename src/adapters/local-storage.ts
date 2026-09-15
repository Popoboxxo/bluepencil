/**
 * `localStorage` adapter — survives a reload, the bookmarklet default (FR-6.2, ARCHITECTURE §4).
 *
 * Key namespacing: `bluepencil:<host>:<instance>:v1`. One JSON blob per instance, written as a
 * whole by the shared engine in `memory.ts` (atomic read-modify-write, FR-6.5). When the host
 * gives no usable `Storage` — private mode, disabled storage, quota exceeded, corrupt blob — the
 * adapter keeps working in memory and reports it **once** through `console.debug` (NFR-8, NFR-14).
 *
 * The module never touches `window` at import time; the global `Storage` is looked up lazily.
 */
import type { Adapter } from "../core/adapter";
import { createJsonAdapter, type JsonAdapterIo } from "./memory";

/** Adapter name reported to the store and to hosts (the name is kept when the backing degrades). */
export const LOCAL_STORAGE_ADAPTER_NAME = "localStorage";

/** Key layout version; bumped when the blob layout changes (NFR-9). */
export const STORAGE_KEY_VERSION = "v1";

/** `bluepencil:<host>:<instance>:v1` (FR-6.2). */
export function localStorageKey(host?: string, instance?: string): string {
  const resolvedHost = host ?? currentHost() ?? "unknown-host";
  const resolvedInstance = instance ?? "default";
  return ["bluepencil", resolvedHost, resolvedInstance, STORAGE_KEY_VERSION].join(":");
}

/**
 * Resolves the host for the key namespace without throwing in environments that deny access to
 * `localStorage` entirely (the property itself can throw, not only its methods).
 */
function currentHost(): string | undefined {
  try {
    const location = (globalThis as { location?: { host?: string; hostname?: string } }).location;
    return location?.host || location?.hostname || undefined;
  } catch {
    return undefined;
  }
}

function globalStorage(): Storage | null {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    return storage && typeof storage.getItem === "function" ? storage : null;
  } catch {
    return null;
  }
}

export function createLocalStorageAdapter(
  options: { key?: string; storage?: Storage } = {},
): Adapter {
  const key = options.key ?? localStorageKey();
  let reported = false;

  const report = (reason: unknown): void => {
    if (reported) {
      return;
    }
    reported = true;
    console.debug(
      `bluepencil: localStorage adapter "${key}" is not usable — notes are kept in memory for this session`,
      reason,
    );
  };

  const storage = options.storage ?? globalStorage();
  if (!storage) {
    report(new Error("Storage is not available in this environment"));
  }

  const io: JsonAdapterIo = {
    readText: () => withStorage((target) => Promise.resolve(target.getItem(key))),
    writeText: (text) => withStorage((target) => Promise.resolve(target.setItem(key, text))),
    onFallback: report,
  };

  function withStorage<T>(operation: (target: Storage) => Promise<T>): Promise<T> {
    if (!storage) {
      return Promise.reject(new Error("Storage is not available in this environment"));
    }
    try {
      return operation(storage);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return createJsonAdapter(LOCAL_STORAGE_ADAPTER_NAME, io);
}
