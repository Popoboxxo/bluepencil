/**
 * The page-side half of the hub relay (#116).
 *
 * Route the HTTP adapter's `fetch` through the bridge into the service worker. The layer runs in the
 * page's MAIN world, so its `fetch` obeys the document's CSP; a page with `default-src 'self'` and no
 * `connect-src` blocks every hub call. The worker is outside that policy and already holds the host
 * permission. The bridge only relays — the worker validates the target, the method and the headers
 * (`hub-fetch.ts`).
 *
 * This module exists apart from `bootstrap.ts` so the failure paths are testable without a bundled
 * MAIN-world script: a missing bridge (the request times out), an abort, and a reply that is not a
 * `HubFetchReply` all have to *reject*, never hang or fabricate a success. The timeout is deliberately
 * above the worker's own 30 s budget (`HUB_FETCH_LIMITS.timeoutMs`), so the worker's error message
 * wins. There is no cancel channel in v1: an aborted page request lets the worker's request run to
 * its own timeout, and if the extension is disabled or updated without a page reload the bridge is
 * gone, so each hub call waits the full budget before it fails (documented in `docs/EXTENSION.md`).
 *
 * The window is injectable (`PageRelayWindow`) so the tests can drive timer, abort and reply without
 * a browser; production always uses the global `window`.
 */
import { PAGE_FETCH_KIND, replyToResponse, type HubFetchReply } from "./hub-fetch";

/** Global key holding the once-per-document install flag. */
export const PAGE_TRANSPORT_KEY = "__bluepencilTransport";
/** Global key holding the in-flight request map, shared by every adapter in this document. */
export const PAGE_TRANSPORT_PENDING_KEY = "__bluepencilTransportPending";

/** How long the page waits for the bridge's answer: above the worker's 30 s, so its error wins. */
export const PAGE_RELAY_TIMEOUT_MS = 35_000;

export interface PageRelayRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** In-flight requests, keyed by `requestId`; the reply listener resolves them. */
export type PageRelayPending = Map<string, (reply: HubFetchReply) => void>;

/** The slice of `Window` the relay uses, injectable so tests can drive the failure paths. */
export interface PageRelayWindow {
  location: { origin: string };
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown, targetOrigin: string): void;
  setTimeout(handler: () => void, timeoutMs: number): number;
  clearTimeout(handle: number): void;
}

function pageWindow(): PageRelayWindow {
  return window as unknown as PageRelayWindow;
}

/** `window.location.origin` is the literal string `"null"` for a sandboxed/opaque document. */
function postTargetOrigin(target: PageRelayWindow): string {
  return target.location.origin === "null" ? "*" : target.location.origin;
}

/**
 * Resolve the pending request a bridge answer belongs to.
 *
 * Only an answer carries `reply`; the request itself is echoed to this same listener and must not
 * resolve anything (measured for the storage relay — a request and its answer share the channel and
 * the `requestId`). A reply that is not an object is reported as a failure instead of being cast:
 * `replyToResponse` would otherwise throw on fields the bridge never sent.
 */
export function handleRelayMessage(data: unknown, pending: PageRelayPending): void {
  if (typeof data !== "object" || data === null) return;
  const record = data as { source?: unknown; requestId?: unknown; reply?: unknown };
  if (record.source !== "bluepencil-page" || typeof record.requestId !== "string") return;
  if (!("reply" in record)) return;
  const resolve = pending.get(record.requestId);
  if (resolve === undefined) return;
  pending.delete(record.requestId);
  const reply = record.reply;
  resolve(
    typeof reply === "object" && reply !== null
      ? (reply as HubFetchReply)
      : { ok: false, error: { code: "network", message: "the extension sent an unreadable reply" } },
  );
}

/** The relay's in-flight map plus the one message listener that resolves it. */
export function createPendingReplies(target: PageRelayWindow = pageWindow()): PageRelayPending {
  const pending: PageRelayPending = new Map();
  target.addEventListener("message", (event: MessageEvent) => {
    // `postMessage` reaches every listener of this window; a message from another window is not ours.
    if ((event as { source?: unknown }).source !== (target as unknown)) return;
    handleRelayMessage(event.data, pending);
  });
  return pending;
}

/** The error an aborted request surfaces locally. The worker's request keeps running (no cancel). */
export function abortReason(signal: AbortSignal | null | undefined): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("the hub request was aborted");
  error.name = "AbortError";
  return error;
}

export interface PageRelayOptions {
  /** Where the request is posted and which timer is used. Defaults to the global `window`. */
  target?: PageRelayWindow;
  /** The page-side budget; defaults to `PAGE_RELAY_TIMEOUT_MS`. */
  timeoutMs?: number;
  nextRequestId: () => string;
}

/**
 * One hub request: post it to the bridge, wait for the correlated answer, rebuild the `Response`.
 *
 * A failure is a rejected promise — never a fabricated success. The adapter's `catch` turns it into
 * `HttpAdapterError { status: 0 }` with the message (FR-6.3), which is exactly how a network failure
 * surfaces today.
 */
export function pageRelay(
  request: PageRelayRequest,
  signal: AbortSignal | null | undefined,
  pending: PageRelayPending,
  options: PageRelayOptions,
): Promise<Response> {
  const target = options.target ?? pageWindow();
  const timeoutMs = options.timeoutMs ?? PAGE_RELAY_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal));
      return;
    }

    const requestId = options.nextRequestId();
    const onAbort = (): void => {
      pending.delete(requestId);
      target.clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = target.setTimeout(() => {
      pending.delete(requestId);
      signal?.removeEventListener("abort", onAbort);
      reject(new TypeError(`the extension did not answer the hub request within ${timeoutMs} ms`));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    pending.set(requestId, (reply) => {
      target.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (reply.ok === true) {
        try {
          resolve(replyToResponse(reply));
        } catch (error) {
          reject(error);
        }
        return;
      }
      reject(new Error(reply.error?.message ?? "the extension refused the hub request"));
    });

    target.postMessage(
      { source: "bluepencil-page", kind: PAGE_FETCH_KIND, requestId, request },
      postTargetOrigin(target),
    );
  });
}

/**
 * Turn a `fetch` call into a relay request.
 *
 * The adapter sends JSON as a string. Anything else cannot cross a `postMessage` boundary
 * unambiguously (a stream, a `FormData`), so it is refused instead of being silently dropped.
 */
export function createPageFetch(
  pending: PageRelayPending,
  options: PageRelayOptions,
): typeof fetch {
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    const method = (init?.method ?? "GET").toUpperCase();

    const headers: Record<string, string> = {};
    const source = init?.headers;
    if (source !== undefined) {
      if (Array.isArray(source)) {
        for (const [name, value] of source) headers[name] = value;
      } else if (typeof (source as Headers).forEach === "function") {
        (source as Headers).forEach((value, name) => {
          headers[name] = value;
        });
      } else {
        Object.assign(headers, source as Record<string, string>);
      }
    }

    const body = init?.body;
    if (body !== undefined && typeof body !== "string") {
      return Promise.reject(
        new TypeError("the extension relay only forwards string request bodies"),
      );
    }

    return pageRelay(
      { url, method, headers, ...(body === undefined ? {} : { body }) },
      init?.signal,
      pending,
      options,
    );
  };
  return fetchImpl as typeof fetch;
}

export interface InstallPageTransportOptions {
  /** The adapter registry's registration function (`registerHttpTransport`). */
  register: (fetchImpl: typeof fetch) => () => void;
  target?: PageRelayWindow;
  timeoutMs?: number;
  /** Where the once-per-document flag lives; injectable for tests, `globalThis` in the page. */
  state?: Record<string, unknown>;
}

/**
 * Install the relay exactly once per document.
 *
 * The global guard is what keeps a forced remount from stacking a second registration, and the
 * registry itself is deliberately never unregistered (see `src/adapters/transport.ts`): it belongs
 * to this document, not to an element instance.
 *
 * Returns `true` when this call installed the transport, `false` when one was already there.
 */
export function installPageTransport(options: InstallPageTransportOptions): boolean {
  const state = options.state ?? (globalThis as unknown as Record<string, unknown>);
  if (state[PAGE_TRANSPORT_KEY] === true) return false;
  state[PAGE_TRANSPORT_KEY] = true;

  const target = options.target ?? pageWindow();
  const pending = createPendingReplies(target);
  state[PAGE_TRANSPORT_PENDING_KEY] = pending;

  let sequence = 0;
  options.register(
    createPageFetch(pending, {
      target,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      nextRequestId: () => `bp-fetch-${++sequence}`,
    }),
  );
  return true;
}
