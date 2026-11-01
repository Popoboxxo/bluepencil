/**
 * The page-side `chrome.storage.local` relay — and the one write rule a page cannot talk its way out
 * of.
 *
 * The layer runs in the page's MAIN world, where `chrome.storage` does not exist; the isolated-world
 * bridge does have it, so the store's `chromeStorage` adapter asks the bridge to perform one storage
 * call (#53). That channel is what makes notes survive a reload — and it is also reachable by **any**
 * page script, not only the layer.
 *
 * `bluepencil:settings` is extension state: it carries the hub endpoint and the credential. A page
 * that could write it could repoint the hub relay at an arbitrary origin and use the service worker
 * as a CSP-bypassing egress path, which is exactly the guarantee #116 is selling (CR-116-01). So
 * writes and removes are scoped to the layer's own store blob, `bluepencil:<instance>:v1`
 * (`chromeStorageKey` in `src/adapters/chrome-storage.ts`). Everything else is extension state.
 *
 * **Reads stay available, deliberately.** The settings read exposure predates this rule (the page
 * could always `get` the blob) and the layer needs its own store back; hiding it is a separate
 * piece of work. It is documented in `docs/EXTENSION.md` rather than silently ignored.
 *
 * Kept free of `chrome.*` and the DOM so both the allow and the deny paths are unit-testable; the
 * bridge only supplies the area handle (`chrome.storage?.local`).
 */

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

/**
 * The only keys a page may write: the layer's own store blob. The instance segment is what
 * `chromeStorageKey()` produces (`default`, a host name, a team name …). `settings` and `ui` are
 * extension/UI state, not note data, so they are refused even with a version suffix —
 * `bluepencil:settings` itself has no suffix and could never match the rest of the pattern.
 */
const PAGE_WRITABLE_KEY = /^bluepencil:(?!settings:|ui:)[A-Za-z0-9._-]+:v1$/;

/** Is `key` part of the layer's own store namespace? */
export function isPageWritableStorageKey(key: string): boolean {
  return PAGE_WRITABLE_KEY.test(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The refusal text names the namespace, not a copied key value. */
const WRITE_REFUSED = "a page may only write the layer's own store keys (bluepencil:<instance>:v1)";

/** Normalise a `keys` payload to a string list, or `null` when it is not one. */
function keyList(raw: unknown): string[] | null {
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw) && raw.every((key) => typeof key === "string")) return raw;
  return null;
}

/**
 * Perform one storage call on behalf of the page, applying the write rule.
 *
 * The answer shape is the bridge's own (`{ok:true, value?}` / `{ok:false, error}`), so the page-side
 * adapter can keep its existing unwrap path. A refused write performs **no** storage call at all: a
 * partial write would leave the blob in a state the next read cannot explain.
 */
export async function relayPageStorage(
  area: PageStorageArea | undefined,
  envelope: PageStorageEnvelope,
): Promise<unknown> {
  if (area === undefined) {
    return { ok: false, error: "chrome.storage.local is unavailable in this extension world" };
  }
  try {
    if (envelope.op === "get") {
      // Deliberately unrestricted: a read cannot repoint the relay, and the layer needs its own
      // blob. The settings exposure is documented (docs/EXTENSION.md, "Page-side storage relay").
      return { ok: true, value: await area.get((envelope.keys ?? []) as string | string[]) };
    }
    if (envelope.op === "set") {
      const items = envelope.items;
      if (!isRecord(items)) {
        return { ok: false, error: "a storage write needs an items object" };
      }
      if (!Object.keys(items).every(isPageWritableStorageKey)) {
        return { ok: false, error: WRITE_REFUSED };
      }
      await area.set(items);
      return { ok: true };
    }
    if (envelope.op === "remove") {
      const keys = keyList(envelope.keys);
      if (keys === null) {
        return { ok: false, error: "a storage remove needs a key or a list of keys" };
      }
      if (!keys.every(isPageWritableStorageKey)) {
        return { ok: false, error: WRITE_REFUSED };
      }
      await area.remove(keys);
      return { ok: true };
    }
    return { ok: false, error: `unknown storage operation ${String(envelope.op)}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
