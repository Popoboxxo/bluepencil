/**
 * Isolated-world bridge — the relay between the page and the service worker.
 *
 * It exists for one reason: the page's MAIN world cannot call `chrome.runtime` (it is the page's
 * world, not the extension's), and the extension's own worlds cannot see the MAIN world's
 * `postMessage` traffic. This script is the only piece that sits on both sides, and it only ever
 * relays — it inspects nothing.
 *
 * It is injected by the worker, not declared in `content_scripts`, because access is granted per
 * tab through `activeTab`. A permanently declared content script would run on every page the user
 * visits, which `activeTab` exists to avoid.
 *
 * What it forwards, and why each is needed:
 * - `bluepencil:mount` — a page-side or test-side request to mount without the toolbar.
 * - `bluepencil:mounted` — the MAIN world's outcome, so a caller can learn whether the layer came
 *   up. The MAIN world cannot answer the worker directly, so the message has to pass through here.
 */
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
};

type Envelope = {
  source?: unknown;
  kind?: unknown;
  ok?: unknown;
  error?: unknown;
  /** Only on a `toggle`; absent means "switch on". */
  enabled?: unknown;
  /** Echoed back on the answer, so a page can match a reply to its request. */
  requestId?: unknown;
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
  if (data.kind !== "request-mount" && data.kind !== "toggle") return;

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
        : { type: "bluepencil:mount" },
    )
    .then((reply: unknown) => answerPage(data, reply))
    .catch((error: unknown) =>
      answerPage(data, { ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
});

// MAIN world → here → worker. Only the mount and toggle outcomes are forwarded, and only the fields
// a caller needs; nothing about the page's content travels in this direction.
window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as Envelope | null;
  if (typeof data !== "object" || data === null) return;
  if (data.source !== "bluepencil-extension") return;
  // Both outcomes are forwarded, not just the mount's: a page that switched the layer off has no
  // other way to learn that it worked, and swallowing the answer would leave it guessing.
  if (data.kind !== "mounted" && data.kind !== "toggled") return;

  void chrome.runtime
    .sendMessage({
      type: "bluepencil:mounted",
      ok: data.ok === true,
      error: typeof data.error === "string" ? data.error : undefined,
    })
    .catch(() => undefined);
});
