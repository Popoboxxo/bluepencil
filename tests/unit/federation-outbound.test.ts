/**
 * @vitest-environment node — `node:stream` semantics and real timers; jsdom's fetch polyfill
 * would not expose `response.body` the way the client reads it.
 *
 * Contract E, SEC-05 (spec §3.5): every peer response is bounded in time and size. The deadline
 * that started before the request stays armed until the last byte is read, the body is consumed
 * through `response.body` with a byte cap, and crossing either bound is `invalid_response` — a
 * peer that answers slowly or too much is an error source, never a partially buffered answer.
 *
 * The cases observe the client through an injected `fetch`; no socket leaves the process.
 */
import { describe, expect, it } from "vitest";

import { createHttpInstanceClient, type InstanceClientOptions } from "../../src/federation/client";
import { aggregateList } from "../../src/federation/aggregate";
import { FederationError } from "../../src/federation/errors";
import type { HostResolver } from "../../src/federation/net-policy";
import type { Note } from "../../src/core/model";

/** The pre-flight gate resolves every non-literal host, so the stub must answer DNS too. */
const publicResolver: HostResolver = async () => ["93.184.216.34"];

const JSON_HEADERS = { "content-type": "application/json" };

/* ------------------------------------------------------------------------------------------------
 * Streaming stubs
 * ---------------------------------------------------------------------------------------------- */

interface StreamProbe {
  response: Response;
  /** Bytes the underlying source actually handed out — the client must stop it at the cap. */
  produced: () => number;
  cancelled: () => boolean;
}

/**
 * A `Response` whose body is produced pull-wise. Production only happens when the consumer reads,
 * so `produced()` measures how far the client actually pulled instead of how eagerly the stub ran.
 */
function streamingResponse(options: {
  chunk: Uint8Array;
  chunks: number;
  intervalMs: number;
  status?: number;
}): StreamProbe {
  let produced = 0;
  let sent = 0;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= options.chunks) {
        controller.close();
        return;
      }
      return new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          if (cancelled) {
            resolve();
            return;
          }
          controller.enqueue(options.chunk.slice());
          produced += options.chunk.byteLength;
          sent += 1;
          resolve();
        }, options.intervalMs);
      });
    },
    cancel() {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  });

  return {
    response: new Response(stream, { status: options.status ?? 200, headers: JSON_HEADERS }),
    produced: () => produced,
    cancelled: () => cancelled,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Client helpers
 * ---------------------------------------------------------------------------------------------- */

function client(
  fetchImpl: typeof fetch,
  options: Partial<InstanceClientOptions> = {},
): ReturnType<typeof createHttpInstanceClient> {
  return createHttpInstanceClient({
    id: "hub",
    base: "https://hub.example/api/v1/bluepencil",
    resolver: publicResolver,
    fetchImpl,
    ...options,
  });
}

/** One-byte-per-interval JSON trickle with the real bytes of `body`. */
function jsonTrickle(body: string, intervalMs: number): StreamProbe {
  let index = 0;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bytes = new TextEncoder().encode(body);

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= bytes.length) {
        controller.close();
        return;
      }
      return new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          if (cancelled) {
            resolve();
            return;
          }
          controller.enqueue(bytes.subarray(index, index + 1));
          index += 1;
          resolve();
        }, intervalMs);
      });
    },
    cancel() {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  });

  return {
    response: new Response(stream, { status: 200, headers: JSON_HEADERS }),
    produced: () => index,
    cancelled: () => cancelled,
  };
}

async function failureOf(promise: Promise<unknown>): Promise<FederationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FederationError);
    return error as FederationError;
  }
  throw new Error("expected the client call to reject");
}

function note(id: string): Note {
  return {
    id,
    text: id,
    status: "open",
    intent: "review",
    createdAt: "2026-01-01T00:00:00.000Z",
  } as unknown as Note;
}

/* ------------------------------------------------------------------------------------------------
 * AC-E01 — the deadline stays armed while the body is read
 * ---------------------------------------------------------------------------------------------- */

describe("E1 outbound.deadline_during_body", () => {
  it("reads a slow body that finishes inside the budget", async () => {
    const probe = jsonTrickle(JSON.stringify({ notes: [note("n-1")] }), 2);
    const instance = client(
      (async () => probe.response) as typeof fetch,
      { timeoutMs: 2000 },
    );

    const notes = await instance.list({});
    expect(notes.map((entry) => entry.id)).toEqual(["n-1"]);
    expect(probe.cancelled()).toBe(false);
  });

  it("aborts mid-body and reports invalid_response when the deadline fires", async () => {
    /* ~40 one-byte chunks at 20 ms = ~800 ms, deadline 60 ms: the headers arrive immediately and
     * the abort must hit while the body is still being read. */
    const probe = jsonTrickle(JSON.stringify({ notes: [] }) + " ".repeat(40), 20);
    const instance = client(
      (async () => probe.response) as typeof fetch,
      { timeoutMs: 60 },
    );

    const started = Date.now();
    const error = await failureOf(instance.list({}));
    const elapsed = Date.now() - started;

    expect(error.code).toBe("invalid_response");
    expect(error.instance).toBe("hub");
    expect(error.message).toContain("not complete within 60 ms");
    expect(probe.produced()).toBeLessThan(40);
    expect(probe.cancelled()).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });
});

/* ------------------------------------------------------------------------------------------------
 * AC-E02 — the body cap, enforced while reading
 * ---------------------------------------------------------------------------------------------- */

describe("E2 outbound.body_cap", () => {
  it("aborts an oversized body at the limit instead of buffering it", async () => {
    const chunk = new Uint8Array(256).fill(0x20);
    const probe = streamingResponse({ chunk, chunks: 200, intervalMs: 1 });
    const instance = client(
      (async () => probe.response) as typeof fetch,
      { timeoutMs: 5000, maxBodyBytes: 1000 },
    );

    const error = await failureOf(instance.list({}));

    expect(error.code).toBe("invalid_response");
    expect(error.message).toContain("exceeded 1000 bytes");
    /* 200 * 256 = 51 200 available bytes; the read stops with at most one chunk of overshoot. */
    expect(probe.produced()).toBeLessThanOrEqual(1000 + chunk.byteLength);
    expect(probe.cancelled()).toBe(true);
  });

  it("bounds /config by the smaller discovery cap", async () => {
    const body = `{"federates":false,"pad":"${"x".repeat(70 * 1024)}"}`;
    const instance = client((async () => new Response(body, { status: 200, headers: JSON_HEADERS })) as typeof fetch);

    const error = await failureOf(instance.config());
    expect(error.code).toBe("invalid_response");
    expect(error.message).toContain("exceeded 65536 bytes");
  });

  it("lets a configured cap win when it is below the discovery cap", async () => {
    const body = JSON.stringify({ federates: false, pad: "x".repeat(300) });
    const instance = client(
      (async () => new Response(body, { status: 200, headers: JSON_HEADERS })) as typeof fetch,
      { maxBodyBytes: 128 },
    );

    const error = await failureOf(instance.config());
    expect(error.code).toBe("invalid_response");
    expect(error.message).toContain("exceeded 128 bytes");
  });

  it("still accepts a config below the cap", async () => {
    const body = JSON.stringify({ name: "hub", auth: "none", federates: false, app: "app-a" });
    const instance = client((async () => new Response(body, { status: 200, headers: JSON_HEADERS })) as typeof fetch);

    await expect(instance.config()).resolves.toMatchObject({ app: "app-a", federates: false });
  });
});

/* ------------------------------------------------------------------------------------------------
 * AC-E03 — the aggregate reports one bounded failure per peer
 * ---------------------------------------------------------------------------------------------- */

describe("E3 outbound.aggregate_error_shape", () => {
  it("fails each slow peer at its own bound while healthy peers still answer", async () => {
    const slow = ["slow-a", "slow-b", "slow-c"].map((id) => {
      const probe = streamingResponse({
        chunk: new Uint8Array(4).fill(0x20),
        chunks: 100,
        intervalMs: 2,
      });
      return {
        id,
        instance: client((async () => probe.response) as typeof fetch, {
          id,
          timeoutMs: 5000,
          maxBodyBytes: 16,
        }),
      };
    });

    const healthy = ["fast-a", "fast-b"].map((id) => {
      const payload = JSON.stringify({ notes: [note(`${id}-note`)] });
      return {
        id,
        instance: client(
          (async () => new Response(payload, { status: 200, headers: JSON_HEADERS })) as typeof fetch,
          { id },
        ),
      };
    });

    const sources = [...slow, ...healthy].map((entry) => entry.instance);
    const result = await aggregateList(sources, undefined, {}, {
      limit: 50,
      timeoutMs: 5000,
      includeSelf: false,
      concurrency: 2,
    });

    expect(result.partial).toBe(true);
    expect(result.notes.map((entry) => entry.id).sort()).toEqual([
      "fast-a/fast-a-note",
      "fast-b/fast-b-note",
    ]);
    expect(result.errors).toHaveLength(3);
    expect(result.errors.map((entry) => entry.instance).sort()).toEqual([
      "slow-a",
      "slow-b",
      "slow-c",
    ]);
    for (const error of result.errors) {
      expect(error.code).toBe("invalid_response");
      expect(error.message).toContain("exceeded 16 bytes");
    }
    const failed = result.instances.filter((entry) => !entry.ok);
    expect(failed).toHaveLength(3);
    expect(failed.every((entry) => entry.code === "invalid_response")).toBe(true);
  });
});
