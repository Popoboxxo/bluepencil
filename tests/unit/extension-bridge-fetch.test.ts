/**
 * The bridge's forward-to-worker hop (#116).
 *
 * The page waits 35 s for an answer; a bridge that lets a broken channel throw, reject or return
 * nothing would turn that into a 35-second hang instead of a clear failure. These tests pin the four
 * outcomes of `chrome.runtime.sendMessage` and assert that the page is answered exactly once in each.
 */
import { describe, expect, it, vi } from "vitest";

import { relayHubRequest, type BridgeRuntime } from "../../extension/src/bridge-fetch";

const ENVELOPE = {
  requestId: "bp-fetch-1",
  request: { method: "GET", url: "http://127.0.0.1:8787/api/v1/bluepencil/notes", headers: {} },
};

const REPLY = { ok: true, status: 200, statusText: "OK", headers: {}, body: "{}" };

interface Harness {
  runtime: BridgeRuntime;
  answers: unknown[];
  messages: unknown[];
}

function harness(send: (message: unknown) => Promise<unknown> | unknown): Harness {
  const answers: unknown[] = [];
  const messages: unknown[] = [];
  return {
    answers,
    messages,
    runtime: {
      sendMessage: (message) => {
        messages.push(message);
        return send(message);
      },
    },
  };
}

describe("bridge fetch relay — every channel outcome answers the page", () => {
  it("forwards only the correlation id and the request, and passes the worker's reply through", async () => {
    const h = harness(async () => REPLY);
    relayHubRequest(h.runtime, ENVELOPE, (reply) => h.answers.push(reply));
    await vi.waitFor(() => expect(h.answers).toHaveLength(1));

    expect(h.messages).toEqual([
      { type: "bluepencil:fetch", requestId: "bp-fetch-1", request: ENVELOPE.request },
    ]);
    expect(h.answers[0]).toBe(REPLY);
  });

  it("answers with a network refusal when sendMessage throws synchronously", () => {
    // An invalidated extension context (update/reload/disable) throws instead of returning a promise.
    const h = harness(() => {
      throw new Error("Extension context invalidated.");
    });
    relayHubRequest(h.runtime, ENVELOPE, (reply) => h.answers.push(reply));

    expect(h.answers).toEqual([
      { ok: false, error: { code: "network", message: "Extension context invalidated." } },
    ]);
  });

  it("answers with a network refusal when the message channel closes before an answer", async () => {
    const h = harness(() => Promise.reject(new Error("The message port closed before a response was received.")));
    relayHubRequest(h.runtime, ENVELOPE, (reply) => h.answers.push(reply));
    await vi.waitFor(() => expect(h.answers).toHaveLength(1));

    expect(h.answers[0]).toMatchObject({
      ok: false,
      error: { code: "network", message: expect.stringMatching(/message port closed/) },
    });
  });

  it("answers instead of dropping a runtime that returns no promise at all", async () => {
    // A callback-style `chrome.runtime.sendMessage` returns `undefined`; the page would otherwise
    // receive a non-reply and report "unreadable", hiding what actually happened.
    const h = harness(() => undefined);
    relayHubRequest(h.runtime, ENVELOPE, (reply) => h.answers.push(reply));
    await vi.waitFor(() => expect(h.answers).toHaveLength(1));

    expect(h.answers[0]).toEqual({
      ok: false,
      error: { code: "network", message: "the extension runtime returned no answer" },
    });
  });

  it("answers exactly once, even when the runtime both throws and rejects", async () => {
    const h = harness(() => Promise.reject(new Error("late failure")));
    relayHubRequest(h.runtime, ENVELOPE, (reply) => h.answers.push(reply));
    await vi.waitFor(() => expect(h.answers).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.answers).toHaveLength(1);
  });
});
