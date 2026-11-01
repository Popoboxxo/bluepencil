/**
 * The bridge's forward-to-worker helper (#116).
 *
 * The isolated-world bridge is the hop between the page's relay (`page-relay.ts`) and the service
 * worker. It deliberately holds no policy — the worker is the trust boundary (`hub-fetch.ts`) — but
 * it does own one guarantee: **every request leaves with an answer**. The page waits 35 s for one
 * (`PAGE_RELAY_TIMEOUT_MS`) and treats silence as a network failure, so a bridge that drops a request
 * on the floor turns a broken channel into a 35-second hang.
 *
 * `chrome.runtime.sendMessage` is not guaranteed to answer:
 *
 *   - it throws **synchronously** when the extension context has been invalidated (extension
 *     updated, reloaded or disabled while the page stayed open);
 *   - it throws when the worker can no longer be reached at all;
 *   - on a callback-style runtime it returns `undefined` instead of a promise;
 *   - and a promise it does return can reject when the message channel closes before `sendResponse`.
 *
 * Each of those is an answer here, not an exception in a listener that no one sees. Kept free of
 * `chrome.*` and the DOM so the paths are unit-testable (the pattern is `storage-relay.ts`).
 */

/** The slice of `chrome.runtime` the bridge uses. */
export interface BridgeRuntime {
  sendMessage(message: unknown): Promise<unknown> | unknown;
}

/** Posts the reply back to the page, exactly once. */
export type BridgeAnswer = (reply: unknown) => void;

/**
 * A reply the page already understands (`HubFetchReply` with `ok: false`). The message is the
 * runtime's own error text — it never carries a header value or a request URL, because this path
 * does not read the request at all.
 */
function channelFailure(error: unknown): { ok: false; error: { code: "network"; message: string } } {
  return {
    ok: false,
    error: { code: "network", message: error instanceof Error ? error.message : String(error) },
  };
}

/**
 * Forward one hub request to the worker and answer the page exactly once.
 *
 * The answer is whatever the worker replied with, or a `network` refusal when the channel itself
 * failed. A runtime that returns nothing is a failure too: `undefined` is not a `HubFetchReply`, and
 * handing it to the page would surface as "unreadable reply" instead of what actually happened.
 */
export function relayHubRequest(
  runtime: BridgeRuntime,
  envelope: { requestId: string; request: unknown },
  answer: BridgeAnswer,
): void {
  let pending: unknown;
  try {
    pending = runtime.sendMessage({
      type: "bluepencil:fetch",
      requestId: envelope.requestId,
      request: envelope.request,
    });
  } catch (error) {
    // The channel is gone (context invalidated, worker unreachable). The page gets the reason now
    // instead of waiting out its own budget.
    answer(channelFailure(error));
    return;
  }

  Promise.resolve(pending).then(
    (reply) =>
      answer(
        reply === undefined || reply === null
          ? channelFailure(new Error("the extension runtime returned no answer"))
          : reply,
      ),
    (error: unknown) => answer(channelFailure(error)),
  );
}
