/**
 * Isolated-world bridge — the relay between the page and the service worker.
 *
 * It exists for one reason: the page's MAIN world cannot call `chrome.runtime` (it is the page's
 * world, not the extension's), and the extension's own worlds cannot see the MAIN world's
 * `postMessage` traffic. This script is the only piece that sits on both sides, and it only ever
 * relays: it never interprets a hub request (the worker does) and never reads note content. The one
 * rule it does apply is on the storage hop — a page may write its own store, not extension state.
 *
 * It is injected by the worker, not declared in `content_scripts`, because access is granted per
 * tab through `activeTab`. A permanently declared content script would run on every page the user
 * visits, which `activeTab` exists to avoid.
 *
 * What it forwards, and why each is needed:
 * - `bluepencil:mount` — a page-side or test-side request to mount without the toolbar.
 * - `bluepencil:mounted` — the MAIN world's outcome, so a caller can learn whether the layer came
 *   up. The MAIN world cannot answer the worker directly, so the message has to pass through here.
 * - `storage` — one `chrome.storage.local` call, relayed in both directions. This hop enforces its
 *   own rule: the page may only *write* the layer's own store keys, never `bluepencil:settings`
 *   (`storage-relay.ts`, CR-116-01).
 * - `fetch` — one hub request, relayed to the worker and back (#116). This hop is **not** a trust
 *   boundary: any page script can post the envelope, so the worker validates it (`hub-fetch.ts`).
 */
import { relayHubRequest } from "./bridge-fetch";
import { PAGE_FETCH_KIND } from "./hub-fetch";
import { relayPageStorage } from "./storage-relay";

declare const chrome: {
  runtime: {
    onMessage: {
      addListener(
        cb: (
          message: unknown,
          sender: unknown,
          sendResponse: (r: unknown) => void,
        ) => boolean | void,
      ): void;
    };
    sendMessage(message: unknown): Promise<unknown>;
    lastError?: { message?: string };
  };
  /**
   * Present in this world and absent in the page's. Measured in the extension smoke: the page's
   * `chrome` object carries `loadTimes`, `csi` and `app` — and no `storage`. That asymmetry is the
   * whole reason `relayPageStorage` exists.
   */
  storage?: {
    local?: {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
  };
};

type Envelope = {
  source?: unknown;
  kind?: unknown;
  ok?: unknown;
  error?: unknown;
  /** Only on a `toggle`; absent means "switch on". */
  enabled?: unknown;
  /**
   * Only on a `request-mount`: the caller's explicit "mount anyway" (#70). Forwarded to the worker as
   * `force` so `bluepencil:mount { force: true }` reaches the layer instead of a plain mount.
   */
  force?: unknown;
  /** Only on a `host-embed-detected` report: which shape the page's own embed took (#70). */
  host?: unknown;
  /** Echoed back on the answer, so a page can match a reply to its request. */
  requestId?: unknown;
  /**
   * Only on a `fetch` relay: the untrusted request envelope (`{method,url,headers,body?}`).
   *
   * The bridge forwards it opaquely — it is **not** a trust boundary. Any page script can post this
   * shape, so every rule (target, method, headers, sizes) is enforced by the service worker in
   * `hub-fetch.ts`, which is the only party allowed to talk to the hub (#116).
   */
  request?: unknown;
  /** Only on a `storage` relay: the operation and its payload. */
  op?: unknown;
  keys?: unknown;
  items?: unknown;
};

/**
 * Relays a worker's answer back to the page that asked.
 *
 * `requestId` is echoed when the page sent one, so it can match a reply to its request. When it did
 * not, the reply still goes out — a page that just wants the layer switched on should not have to
 * invent a correlation id to get an answer. An untagged reply is marked, so a page listening for
 * several can tell it apart from an echo of its own message.
 */
function answerPage(envelope: Envelope, reply: unknown): void {
  window.postMessage(
    {
      source: "bluepencil-page",
      ...(typeof envelope.requestId === "string" ? { requestId: envelope.requestId } : { untagged: true }),
      reply,
    },
    window.location.origin === "null" ? "*" : window.location.origin,
  );
}

// Page → bridge, over `window.postMessage`.
//
// This is the *entry* point the earlier listener above is reached from, and the two are not
// interchangeable: `chrome.runtime.onMessage` fires for messages sent through the extension's own
// messaging, never for a page's `postMessage`. A bridge that only listens on `chrome.runtime` is
// deaf to the page — which is exactly what happened while wiring the on/off switch, and why it
// answered nothing.
window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as Envelope | null;
  if (typeof data !== "object" || data === null) return;
  if (data.source !== "bluepencil-page") return;
  if (data.kind !== "request-mount" && data.kind !== "toggle" && data.kind !== "storage" &&
      data.kind !== PAGE_FETCH_KIND) {
    return;
  }

  // The hub relay (#116). The page's own `fetch` is governed by the document's CSP, and a strict
  // `connect-src` blocks every hub call; the service worker is outside that policy. This hop carries
  // the envelope verbatim — validation lives in the worker, deliberately (see `hub-fetch.ts`). Only
  // the correlation id and the request are forwarded, never the whole envelope.
  if (data.kind === PAGE_FETCH_KIND) {
    const requestId = data.requestId;
    if (typeof requestId !== "string" || requestId === "") {
      answerPage(data, {
        ok: false,
        error: { code: "invalid_request", message: "the relay request needs a requestId" },
      });
      return;
    }
    // `chrome.runtime.sendMessage` can throw synchronously (an invalidated extension context) and
    // can return nothing at all. Both are answered instead of thrown: an exception here would be
    // swallowed by the event listener and the page would wait out its whole 35 s budget
    // (`bridge-fetch.ts`).
    relayHubRequest(chrome.runtime, { requestId, request: data.request }, (reply) =>
      answerPage(data, reply),
    );
    return;
  }

  // A storage relay never reaches the worker: the answer comes from this world, which is the only
  // one that has `chrome.storage`. The relay's write rule lives in `storage-relay.ts`: a page may
  // write the layer's own store blob, never `bluepencil:settings` (which would repoint the hub).
  if (data.kind === "storage") {
    void relayPageStorage(chrome.storage?.local, data)
      .then((reply) => answerPage(data, reply))
      .catch((error: unknown) =>
        answerPage(data, { ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    return;
  }

  // The page cannot hear a `sendResponse` — that channel only exists inside the extension — so the
  // answer goes back out through `postMessage` either way. A request without a `requestId` still
  // works; the page just gets an untagged reply it can recognise by shape.
  void chrome.runtime
    .sendMessage(
      data.kind === "toggle"
        ? {
            type: "bluepencil:toggle",
            ...(typeof data.enabled === "boolean" ? { enabled: data.enabled } : {}),
          }
        : {
            type: "bluepencil:mount",
            // The documented per-call override (#70) has to survive this hop: without it a page's
            // `request-mount { force: true }` arrives at the worker as a plain mount and the default
            // step-aside wins. Only a real boolean is forwarded, never a truthy string.
            ...(typeof data.force === "boolean" ? { force: data.force } : {}),
          },
    )
    .then((reply: unknown) => answerPage(data, reply))
    .catch((error: unknown) =>
      answerPage(data, { ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
});

// MAIN world → here → worker. Only the mount outcome, the toggle outcome and the "the page already
// embeds the layer" report are forwarded, and only the fields a caller needs; nothing about the
// page's content travels in this direction.
window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as Envelope | null;
  if (typeof data !== "object" || data === null) return;
  if (data.source !== "bluepencil-extension") return;
  // All three outcomes are forwarded, not just the mount's: a page that switched the layer off has
  // no other way to learn that it worked, and the worker needs the host-embed report to put up the
  // toolbar badge (#70) — the MAIN world cannot reach `chrome` to do either itself.
  if (data.kind !== "mounted" && data.kind !== "toggled" && data.kind !== "host-embed-detected") {
    return;
  }

  void chrome.runtime
    .sendMessage(
      data.kind === "host-embed-detected"
        ? {
            type: "bluepencil:host-embed",
            host: typeof data.host === "string" ? data.host : undefined,
          }
        : {
            type: "bluepencil:mounted",
            ok: data.ok === true,
            error: typeof data.error === "string" ? data.error : undefined,
          },
    )
    .catch(() => undefined);
});
