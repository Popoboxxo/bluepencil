/**
 * The page-side `chrome.storage.local` relay — one key, derived from the bridge's own location.
 *
 * The layer runs in the page's MAIN world, where `chrome.storage` does not exist; the isolated-world
 * bridge does have it, so the store's `chromeStorage` adapter asks the bridge to perform one storage
 * call (#53). That channel is reachable by **any** page script, not only the layer.
 *
 * Since 0.12 the extension partitions `chrome.storage.local` per origin (`bluepencil:v2:<origin>`,
 * G5). A page may therefore reach exactly **one** key: the one the bridge derives from its own
 * `window.location` (`storageKeyForLocation`). There is no origin/key parameter on the envelope and
 * no catch-all bucket — a spoofed field cannot select a foreign store, and an opaque origin
 * (`file:`, `"null"`) has no bucket at all (SEC-13).
 *
 * The relay also refuses everything that is not note data: `bluepencil:settings` (hub endpoint and
 * credential, SEC-14), the legacy shared blob `bluepencil:default:v1`, `bluepencil:ui:*` and the
 * assign sidecar `bluepencil:assign:<origin>`. They are not the derived key, so they are refused as
 * `foreign_key` before any `chrome.storage` call happens.
 *
 * Every answer is a named code, never a silent drop: `opaque_origin`, `foreign_key`,
 * `invalid_envelope`, `unavailable`, `storage_failure`. Kept free of `chrome.*` and the DOM so the
 * allow and the deny paths are unit-testable; the bridge only supplies the area handle and location.
 */
import { storageKeyForLocation } from "../../src/data/origin";

/** The slice of `chrome.storage.local` the relay uses. */
export interface PageStorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

/** What a page posts on the bridge channel for a storage call. Untrusted. */
export interface PageStorageEnvelope {
  op?: unknown;
  keys?: unknown;
  items?: unknown;
}

/** Named refusals of the page storage relay (B.1). */
export type PageStorageErrorCode =
  | "opaque_origin"
  | "foreign_key"
  | "invalid_envelope"
  | "unavailable"
  | "storage_failure";

/** The bridge's answer shape; the page-side adapter keeps its existing unwrap path. */
export type PageStorageReply =
  | { ok: true; value?: Record<string, unknown> }
  | { ok: false; code: PageStorageErrorCode; error: string };

/** The only fields a storage envelope may carry. Anything else is `invalid_envelope` (B.1). */
const ALLOWED_FIELDS: readonly string[] = ["op", "keys", "items"];

const STORAGE_OPS: readonly string[] = ["get", "set", "remove"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalise a `keys` payload to a string list, or `null` when it is not one. */
function keyList(raw: unknown): string[] | null {
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw) && raw.every((key) => typeof key === "string")) return raw as string[];
  return null;
}

/** The one key a page may name: exactly the key the bridge derived from its own location. */
function isDerivedKey(keys: readonly string[], derivedKey: string): boolean {
  return keys.length === 1 && keys[0] === derivedKey;
}

function refused(code: PageStorageErrorCode, error: string): PageStorageReply {
  return { ok: false, code, error };
}

function foreignKey(): PageStorageReply {
  return refused(
    "foreign_key",
    "a page may only reach the note store of its own origin (bluepencil:v2:<origin>)",
  );
}

function invalidEnvelope(error: string): PageStorageReply {
  return refused("invalid_envelope", error);
}

function unavailable(): PageStorageReply {
  return refused("unavailable", "chrome.storage.local is unavailable in this extension world");
}

/** A throwing area is an answer, not an escape: the caller never sees a rejection. */
function storageFailure(error: unknown): PageStorageReply {
  return refused("storage_failure", error instanceof Error ? error.message : String(error));
}

/**
 * Perform one storage call on behalf of the page, scoped to the derived per-origin key.
 *
 * Decision order: opaque origin → envelope shape → key match → area availability → the call.
 * A refusal performs **no** storage access at all; a partial write would leave the per-origin blob
 * in a state the next read cannot explain.
 */
export async function relayPageStorage(
  area: PageStorageArea | undefined,
  envelope: PageStorageEnvelope,
  location: { origin?: unknown } | null | undefined,
): Promise<PageStorageReply> {
  // The key is derived only from the isolated world's location. No envelope field takes part.
  const derivedKey = storageKeyForLocation(location);
  if (derivedKey === null) {
    return refused("opaque_origin", "this page has an opaque origin and therefore no note store");
  }

  if (!isRecord(envelope)) {
    return invalidEnvelope("a page storage request must be an object");
  }
  if (Object.keys(envelope).some((field) => !ALLOWED_FIELDS.includes(field))) {
    return invalidEnvelope("a storage envelope may only carry op, keys and items");
  }
  const op = envelope.op;
  if (typeof op !== "string" || !STORAGE_OPS.includes(op)) {
    return invalidEnvelope("a storage request needs the operation get, set or remove");
  }

  if (op === "get" || op === "remove") {
    const keys = keyList(envelope.keys);
    if (keys === null) {
      return invalidEnvelope("a storage read or remove needs a key or a list of keys");
    }
    // Empty, wildcard or multi-key lists are well-formed but foreign — including the legacy blob,
    // settings, UI state and the assign sidecar, which are all "not this origin's key".
    if (!isDerivedKey(keys, derivedKey)) return foreignKey();
    if (area === undefined) return unavailable();
    try {
      if (op === "get") {
        return { ok: true, value: await area.get(derivedKey) };
      }
      await area.remove(derivedKey);
      return { ok: true };
    } catch (error) {
      return storageFailure(error);
    }
  }

  // `set`: the item keys are the write footprint, so they are the key check.
  const items = envelope.items;
  if (!isRecord(items)) {
    return invalidEnvelope("a storage write needs an items object");
  }
  if (!isDerivedKey(Object.keys(items), derivedKey)) return foreignKey();
  if (area === undefined) return unavailable();
  try {
    await area.set(items);
    return { ok: true };
  } catch (error) {
    return storageFailure(error);
  }
}
