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

type Envelope = { source?: unknown; kind?: unknown; ok?: unknown; error?: unknown };

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message !== "object" || message === null) return false;
  const envelope = message as Envelope;

  // Page → worker: a mount request that did not come through the toolbar.
  if (envelope.source === "bluepencil-page" && envelope.kind === "request-mount") {
    void chrome.runtime
      .sendMessage({ type: "bluepencil:mount" })
      .then(sendResponse)
      .catch((error: unknown) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    return true;
  }
  return false;
});

// Main world → here → worker. Only the mount outcome is forwarded, and only the fields a caller
// needs; nothing about the page's content travels in this direction.
window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as Envelope | null;
  if (typeof data !== "object" || data === null) return;
  if (data.source !== "bluepencil-extension" || data.kind !== "mounted") return;

  void chrome.runtime
    .sendMessage({
      type: "bluepencil:mounted",
      ok: data.ok === true,
      error: typeof data.error === "string" ? data.error : undefined,
    })
    .catch(() => undefined);
});
