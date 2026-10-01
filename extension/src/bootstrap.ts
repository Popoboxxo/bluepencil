/**
 * The registered MAIN-world content script — the layer's only way into a CSP-hard page.
 *
 * Everything else was measured and refused by Chrome 151:
 *
 *   - `import(chrome-extension://…)` from the page's world → "Failed to fetch dynamically imported
 *     module". A page may not load the extension's origin.
 *   - `new Function(source)` *anywhere* in the page's world → "Evaluating a string as JavaScript
 *     violates the following Content Security Policy directive because 'unsafe-eval' is not an
 *     allowed source of script: script-src 'self'". This includes source text handed over as a
 *     plain global, so the arrival channel does not matter — the page's CSP refuses it either way.
 *   - `import()` inside the service worker → "disallowed on ServiceWorkerGlobalScope".
 *
 * What works, and is what this file is: extension code that arrives as a **packaged file** runs in
 * the page's MAIN world even under a strict CSP. So the element bundle is not shipped as text to be
 * evaluated — it is bundled *into this file* at build time (see `extension/build.mjs`), which makes
 * the whole thing one static classic script. There is no `eval`, no `new Function`, no `import()`,
 * and no fetch of anything.
 *
 * That leaves exactly one channel for the worker, and it is deliberately a *data* channel: the
 * settings. The worker places them in the page, this file reads them, and the layer mounts. Code
 * crosses the boundary at install time, not at mount time.
 *
 * Two things this file owns, and both were wrong before #53:
 *
 *   1. **The element's vocabulary.** Attributes are written without the `data-` prefix — `adapter`,
 *      `environment`, `app`, `identity`, `endpoint`, `token…`. `data-*` is the *loader's* spelling,
 *      which `dist/attach.js` translates when it creates the element. Writing it onto the element
 *      meant the layer read nothing: it fell back to its default `memory` store while the attribute
 *      readback still said `chromeStorage`. `handoff.ts` holds that translation, unit-tested.
 *   2. **The store's area.** The layer runs in the page's own world, where `chrome.storage` does not
 *      exist (measured: the page's `chrome` object carries `loadTimes`, `csi` and `app`, and no
 *      `storage`). The isolated-world bridge does have it, so the `chromeStorage` factory registered
 *      here relays through that bridge instead of reading a global that is not there.
 */
import { createChromeStorageAdapter } from "../../dist/adapters/chrome-storage.js";
import type { ChromeStorageArea } from "../../dist/adapters/chrome-storage.js";
import { defineBluepencilElement, registerAdapter } from "../../dist/bluepencil.element.js";
import { elementAttributesFor } from "./handoff";
import type { ExtensionSettings } from "./settings";

/** The settings for this mount, placed here by the worker. Absent until the user asks for the layer. */
const CONFIG_KEY = "__bluepencilConfig__";
/** Set once the layer is up, so a second injection in the same document is a no-op. */
const MOUNTED_KEY = "__bluepencilMounted";
/** The in-flight storage relays, shared by every adapter area this document creates. */
const STORAGE_PENDING_KEY = "__bluepencilStoragePending";

/** How long a storage relay may take before the store is told it failed. */
const BRIDGE_TIMEOUT_MS = 8_000;

interface MountConfig {
  settings: ExtensionSettings;
  /**
   * The tab's URL, recorded by the worker. It is no longer written onto the element: no attribute
   * reads it (`data-bluepencil-url` reached nothing), and the element's own `route="url"` gives every
   * note the page it was taken on — which is what the URL was kept for. The field stays because the
   * worker's handshake still carries it.
   */
  tabUrl: string;
}

interface BridgeReply {
  ok?: boolean;
  value?: unknown;
  error?: string;
}

type BpGlobal = typeof globalThis & {
  [CONFIG_KEY]?: MountConfig;
  [MOUNTED_KEY]?: boolean;
  [STORAGE_PENDING_KEY]?: Map<string, (reply: BridgeReply) => void>;
  /** Lets the worker wake this script on a tab that was already open. */
  __bluepencilTryMount?: () => void;
};

const g = globalThis as BpGlobal;

// A registered script runs on every matching document, whether or not the user asked for the layer.
// Doing nothing until the configuration arrives is what keeps that cheap and unobtrusive. The hook
// lets the worker wake it on an already-open tab, where the registration has not taken effect yet.
g.__bluepencilTryMount = mount;

if (g[MOUNTED_KEY] !== true && g[CONFIG_KEY] !== undefined) {
  mount();
}

function mount(): void {
  const config = g[CONFIG_KEY];
  if (config === undefined) return;
  if (g[MOUNTED_KEY] === true) return;
  g[MOUNTED_KEY] = true;

  try {
    // Registered *before* the element is defined: the store consults the registry when it loads its
    // adapter, and the built-in `chromeStorage` would find no `chrome.storage` in this world.
    if (config.settings.store === "chromeStorage") {
      registerAdapter("chromeStorage", () =>
        createChromeStorageAdapter({ area: createBridgedStorageArea() }),
      );
    }

    // The element code was bundled into this file, so there is nothing left to fetch or evaluate —
    // registering it is a plain function call.
    defineBluepencilElement();

    const tag = "bluepencil-notes";
    const el = document.createElement(tag);
    // One vocabulary, translated in one place: `handoff.ts`. It answers with the element's own
    // attribute names, the credential header the chosen mode implies, and `route="url"` so a note
    // carries the page it was taken on.
    const attributes = elementAttributesFor(config.settings, navigator.language ?? "");
    for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
    (document.body ?? document.documentElement).append(el);

    report(true, "");
  } catch (error) {
    g[MOUNTED_KEY] = false;
    report(false, error instanceof Error ? error.message : String(error));
  }
}

/**
 * The relay's in-flight requests, installed once and shared by every area in this document.
 *
 * Kept on the global rather than in a closure: the adapter factory runs per mount, and a second area
 * must not lose its answers to a listener that holds a different map.
 */
function bridgePending(): Map<string, (reply: BridgeReply) => void> {
  const existing = g[STORAGE_PENDING_KEY];
  if (existing !== undefined) return existing;

  const pending = new Map<string, (reply: BridgeReply) => void>();
  g[STORAGE_PENDING_KEY] = pending;
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as { source?: unknown; requestId?: unknown; reply?: unknown } | null;
    if (typeof data !== "object" || data === null) return;
    // The bridge answers on the channel the page already uses for mount and toggle, echoing the
    // requestId it was given. Anything else on this channel is not ours to consume.
    if (data.source !== "bluepencil-page" || typeof data.requestId !== "string") return;
    // A request and its answer share this channel *and* the requestId, and `postMessage` delivers a
    // message to the listener of the window that sent it. Matching on `source` + `requestId` alone
    // therefore matches the request itself: the pending call would resolve with its own payload
    // (which has no `reply`) and the real answer would arrive after the entry was deleted. Measured
    // in the extension smoke — every storage write reported "refused" while the value was already
    // sitting in `chrome.storage.local`. Only an answer carries `reply`; only a request carries `kind`.
    if (!("reply" in data)) return;
    const resolve = pending.get(data.requestId);
    if (resolve === undefined) return;
    pending.delete(data.requestId);
    resolve((typeof data.reply === "object" && data.reply !== null ? data.reply : {}) as BridgeReply);
  });
  return pending;
}

/**
 * A `chrome.storage.local`-shaped area that relays through the isolated-world bridge.
 *
 * A relay that never answers must not hang the store: the call rejects after `BRIDGE_TIMEOUT_MS` and
 * the adapter's documented degrade path takes over — the change stays in memory and is reported once,
 * the same contract `localStorage` and `chromeStorage` already have for a full quota.
 */
function createBridgedStorageArea(): ChromeStorageArea {
  let sequence = 0;

  const call = (payload: Record<string, unknown>): Promise<BridgeReply> =>
    new Promise((resolve) => {
      const requestId = `bp-storage-${++sequence}`;
      const pending = bridgePending();
      const timer = window.setTimeout(() => {
        pending.delete(requestId);
        resolve({
          ok: false,
          error: `the extension did not answer the storage request within ${BRIDGE_TIMEOUT_MS} ms`,
        });
      }, BRIDGE_TIMEOUT_MS);
      pending.set(requestId, (reply) => {
        window.clearTimeout(timer);
        resolve(reply);
      });
      window.postMessage(
        { source: "bluepencil-page", kind: "storage", ...payload, requestId },
        window.location.origin === "null" ? "*" : window.location.origin,
      );
    });

  const unwrap = async (payload: Record<string, unknown>): Promise<BridgeReply> => {
    const reply = await call(payload);
    if (reply.ok !== true) {
      throw new Error(reply.error ?? "the extension refused the storage request");
    }
    return reply;
  };

  return {
    get: async (keys) => {
      const reply = await unwrap({ op: "get", keys });
      const value = reply.value;
      return (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    },
    set: async (items) => {
      await unwrap({ op: "set", items });
    },
    remove: async (keys) => {
      await unwrap({ op: "remove", keys });
    },
  };
}

function report(ok: boolean, error: string): void {
  // The bridge in the isolated world relays this to the worker. It is the only way out: this file
  // runs in the page, which has no `chrome`.
  window.postMessage(
    { source: "bluepencil-extension", kind: "mounted", ok, error: error || undefined },
    window.location.origin === "null" ? "*" : window.location.origin,
  );
}
