/**
 * The page-side relay's failure paths (#116, CR-116-05).
 *
 * The relay's job is to *reject* — a missing bridge, an abort, a malformed answer and an expired
 * budget must never resolve as data and must never hang. The smoke suite observes the happy path in
 * a real Chromium; these tests pin the paths it cannot reach in eight seconds, including the
 * product's own 35 s budget. The transport is installed once per document, and that guard is pinned
 * too: a second mount must not stack a second registration.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { PAGE_FETCH_KIND } from "../../extension/src/hub-fetch";
import {
  PAGE_RELAY_TIMEOUT_MS,
  PAGE_TRANSPORT_KEY,
  PAGE_TRANSPORT_PENDING_KEY,
  handleRelayMessage,
  installPageTransport,
  pageRelay,
  type PageRelayPending,
  type PageRelayWindow,
} from "../../extension/src/page-relay";

const REQUEST = {
  url: "http://127.0.0.1:8787/api/v1/bluepencil/notes",
  method: "GET",
  headers: { accept: "application/json" },
};

interface TargetFixture {
  target: PageRelayWindow;
  posted: { message: Record<string, unknown>; targetOrigin: string }[];
}

function fakeTarget(origin = "https://page.example"): TargetFixture {
  const posted: { message: Record<string, unknown>; targetOrigin: string }[] = [];
  const target: PageRelayWindow = {
    location: { origin },
    addEventListener: () => undefined,
    postMessage: (message, targetOrigin) => {
      posted.push({ message: message as Record<string, unknown>, targetOrigin });
    },
    setTimeout: (handler, timeoutMs) => globalThis.setTimeout(handler, timeoutMs) as unknown as number,
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
  };
  return { target, posted };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("page relay — failures reject, they never hang or succeed", () => {
  it("rejects after the product's 35 s budget when no bridge answers", async () => {
    vi.useFakeTimers();
    const { target } = fakeTarget();
    const pending: PageRelayPending = new Map();
    const result = pageRelay(REQUEST, undefined, pending, {
      target,
      nextRequestId: () => "bp-fetch-1",
    });
    const assertion = expect(result).rejects.toThrow(
      `the extension did not answer the hub request within ${PAGE_RELAY_TIMEOUT_MS} ms`,
    );
    expect(PAGE_RELAY_TIMEOUT_MS).toBe(35_000);
    await vi.advanceTimersByTimeAsync(PAGE_RELAY_TIMEOUT_MS);
    await assertion;
    // The dead request must not stay in the map, or a later answer would resolve a stale promise.
    expect(pending.size).toBe(0);
  });

  it("rejects with the signal's reason when the caller aborts", async () => {
    const { target } = fakeTarget();
    const pending: PageRelayPending = new Map();
    const controller = new AbortController();
    const reason = new Error("the caller changed its mind");
    const result = pageRelay(REQUEST, controller.signal, pending, {
      target,
      nextRequestId: () => "bp-fetch-1",
    });
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    expect(pending.size).toBe(0);
  });

  it("rejects immediately when the signal was already aborted", async () => {
    const { target, posted } = fakeTarget();
    const controller = new AbortController();
    controller.abort();
    const result = pageRelay(REQUEST, controller.signal, new Map(), {
      target,
      nextRequestId: () => "bp-fetch-1",
    });
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(posted).toHaveLength(0);
  });

  it("rejects an unreadable reply instead of handing the adapter a non-answer", async () => {
    const { target } = fakeTarget();
    const pending: PageRelayPending = new Map();
    const result = pageRelay(REQUEST, undefined, pending, {
      target,
      nextRequestId: () => "bp-fetch-1",
    });
    handleRelayMessage({ source: "bluepencil-page", requestId: "bp-fetch-1", reply: "not-a-reply" }, pending);
    await expect(result).rejects.toThrow(/unreadable reply/);
  });

  it("ignores the echoed request and answers for another id", async () => {
    const { target } = fakeTarget();
    const pending: PageRelayPending = new Map();
    let settled = false;
    const result = pageRelay(REQUEST, undefined, pending, {
      target,
      nextRequestId: () => "bp-fetch-1",
    }).finally(() => {
      settled = true;
    });
    // The request itself is delivered to this same listener: it has no `reply` and must not settle.
    handleRelayMessage({ source: "bluepencil-page", kind: PAGE_FETCH_KIND, requestId: "bp-fetch-1" }, pending);
    await Promise.resolve();
    expect(settled).toBe(false);
    // An answer for a different request is not ours either.
    handleRelayMessage({ source: "bluepencil-page", requestId: "bp-fetch-2", reply: { ok: true } }, pending);
    await Promise.resolve();
    expect(settled).toBe(false);
    handleRelayMessage({
      source: "bluepencil-page",
      requestId: "bp-fetch-1",
      reply: { ok: false, error: { code: "disallowed_target", message: "nope" } },
    }, pending);
    await expect(result).rejects.toThrow("nope");
  });

  it("resolves a well-formed reply into a Response", async () => {
    const { target } = fakeTarget();
    const pending: PageRelayPending = new Map();
    const result = pageRelay(REQUEST, undefined, pending, {
      target,
      nextRequestId: () => "bp-fetch-1",
    });
    handleRelayMessage({
      source: "bluepencil-page",
      requestId: "bp-fetch-1",
      reply: { ok: true, status: 201, statusText: "Created", headers: {}, body: '{"ok":true}' },
    }, pending);
    const response = await result;
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('{"ok":true}');
  });
});

describe("page relay — installation", () => {
  it("installs once per document", () => {
    const state: Record<string, unknown> = {};
    const register = vi.fn(() => () => undefined);
    const { target } = fakeTarget();

    expect(installPageTransport({ register, state, target })).toBe(true);
    expect(installPageTransport({ register, state, target })).toBe(false);
    expect(register).toHaveBeenCalledTimes(1);
    expect(state[PAGE_TRANSPORT_KEY]).toBe(true);
    expect(state[PAGE_TRANSPORT_PENDING_KEY]).toBeInstanceOf(Map);
  });

  it("registers a fetch that posts the page protocol kind and rebuilds the answer", async () => {
    const state: Record<string, unknown> = {};
    const registered: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)[] = [];
    const { target, posted } = fakeTarget("null");
    installPageTransport({
      register: (fetchImpl) => {
        registered.push(fetchImpl);
        return () => undefined;
      },
      state,
      target,
    });

    const fetchImpl = registered[0];
    expect(fetchImpl).toBeTypeOf("function");
    const result = fetchImpl!(`http://127.0.0.1:8787/api/v1/bluepencil/notes`, {
      method: "post",
      headers: { Accept: "application/json" },
      body: "{}",
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.targetOrigin).toBe("*");
    expect(posted[0]?.message).toMatchObject({
      source: "bluepencil-page",
      kind: PAGE_FETCH_KIND,
      request: {
        url: "http://127.0.0.1:8787/api/v1/bluepencil/notes",
        method: "POST",
        headers: { Accept: "application/json" },
        body: "{}",
      },
    });

    const pending = state[PAGE_TRANSPORT_PENDING_KEY] as PageRelayPending;
    handleRelayMessage({
      source: "bluepencil-page",
      requestId: posted[0]?.message.requestId,
      reply: { ok: true, status: 200, statusText: "OK", headers: {}, body: "{}" },
    }, pending);
    await expect(result).resolves.toBeInstanceOf(Response);
  });

  it("refuses a non-string body instead of dropping it silently", async () => {
    const state: Record<string, unknown> = {};
    let fetchImpl: typeof fetch | undefined;
    installPageTransport({
      register: (impl) => {
        fetchImpl = impl;
        return () => undefined;
      },
      state,
      target: fakeTarget().target,
    });
    await expect(
      fetchImpl!(`http://127.0.0.1:8787/api/v1/bluepencil/notes`, {
        method: "POST",
        body: new Blob(["x"]),
      }),
    ).rejects.toThrow(/string request bodies/);
  });
});
