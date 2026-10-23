/**
 * @vitest-environment node — the client speaks real HTTP in T24 and `node:http` semantics
 * (`redirect: "manual"`, abort signals) behave differently from jsdom's.
 *
 * Federation instance client (plan §6/§7, FR-16.12, NFR-22, Rev. 4). The tests drive the wire
 * contract through an injected `fetch` for the policy edges (timeout, redirect, SSRF, status
 * mapping) and through the real in-process hub for the CRUD roundtrip, so neither the request
 * shape nor the response handling is tested only against a mock.
 *
 * Every stub keeps its sockets inside the process: no test reaches the network.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMessage, type NoteFilter } from "../../src/core/model";
import { startServer, type RunningServer } from "../../server/index";
import { FederationError, Redactor } from "../../src/federation/errors";
import {
  createHttpInstanceClient,
  mapHttpStatus,
  type InstanceAuth,
  type InstanceClient,
} from "../../src/federation/client";
import type { HostResolver } from "../../src/federation/net-policy";

/**
 * The client resolves every non-literal host by default (F-01), so a test that stubs `fetch`
 * must also stub DNS — otherwise the pre-flight gate would reject `*.example` before the stub
 * ever runs.
 */
const publicResolver: HostResolver = async () => ["93.184.216.34"];

/* ------------------------------------------------------------------------------------------------
 * Stub transport helpers
 * ---------------------------------------------------------------------------------------------- */

interface Call {
  url: string;
  method: string;
  headers: RequestInit["headers"];
  body?: string;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Case-insensitive header lookup on whatever `HeadersInit` shape the client used. */
function headerValue(headers: RequestInit["headers"], name: string): string | undefined {
  if (headers === undefined) return undefined;
  const wanted = name.toLowerCase();
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (key.toLowerCase() === wanted) return value;
    }
    return undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function captureFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const requestInit = init ?? {};
    calls.push({
      url,
      method: requestInit.method ?? "GET",
      headers: requestInit.headers,
      ...(typeof requestInit.body === "string" ? { body: requestInit.body } : {}),
    });
    return handler(url, requestInit);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

/** A 0.10 hub config; fields can be removed to model an older hub. */
function hubConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "test hub",
    version: "0.10.0",
    base: "/api/v1/bluepencil",
    auth: "none",
    readOnly: false,
    environment: "dev",
    app: "test-app",
    federates: false,
    bind: { host: "127.0.0.1", port: 8787, loopbackOnly: true },
    ...overrides,
  };
}

/** `{/config, /health}` stub used by the identity tests. */
function identityFetch(config: Record<string, unknown>, health: Record<string, unknown>) {
  return captureFetch((url) => {
    if (url.endsWith("/config")) return jsonResponse(config);
    if (url.endsWith("/health")) return jsonResponse(health);
    return jsonResponse({ error: { code: "not_found", message: "unexpected path" } }, 404);
  });
}

/** Rejects with the thrown `FederationError` so the test can inspect the code. */
async function failureOf(promise: Promise<unknown>): Promise<FederationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FederationError);
    return error as FederationError;
  }
  throw new Error("expected the client call to reject");
}

/* ------------------------------------------------------------------------------------------------
 * T14 — auth header derivation
 * ---------------------------------------------------------------------------------------------- */

describe("T14 client.auth_header_from_env", () => {
  async function callsFor(auth: InstanceAuth | undefined, authMode: "none" | "secret" | "token") {
    const captured = captureFetch((url) => {
      if (url.endsWith("/config")) return jsonResponse(hubConfig({ auth: authMode }));
      if (url.endsWith("/notes")) return jsonResponse({ notes: [] });
      return jsonResponse({}, 404);
    });
    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example/api/v1/bluepencil",
      resolver: publicResolver,
      fetchImpl: captured.fetchImpl,
      ...(auth === undefined ? {} : { auth }),
    });
    await client.config();
    await client.list({});
    return captured.calls;
  }

  it("uses Authorization: Bearer for a token hub", async () => {
    const token = "tok_live_abcdefgh";
    const calls = await callsFor({ value: token }, "token");
    expect(headerValue(calls[1]!.headers, "authorization")).toBe(`Bearer ${token}`);
    expect(headerValue(calls[1]!.headers, "x-bluepencil-auth")).toBeUndefined();
  });

  it("uses x-bluepencil-auth for a secret hub", async () => {
    const token = "secret_abcdefgh";
    const calls = await callsFor({ value: token }, "secret");
    expect(headerValue(calls[1]!.headers, "x-bluepencil-auth")).toBe(token);
    expect(headerValue(calls[1]!.headers, "authorization")).toBeUndefined();
  });

  it("uses x-bluepencil-auth for auth:none when a credential was configured", async () => {
    const token = "configured_abcdefgh";
    const calls = await callsFor({ value: token }, "none");
    expect(headerValue(calls[1]!.headers, "x-bluepencil-auth")).toBe(token);
  });

  it("lets an explicit header/scheme override win", async () => {
    const calls = await callsFor(
      { header: "x-custom-auth", scheme: "Token", value: "override_abcdefgh" },
      "token",
    );
    expect(headerValue(calls[0]!.headers, "x-custom-auth")).toBe("Token override_abcdefgh");
    expect(headerValue(calls[0]!.headers, "authorization")).toBeUndefined();
    expect(headerValue(calls[1]!.headers, "x-custom-auth")).toBe("Token override_abcdefgh");
  });

  it("sends no auth header without an auth option", async () => {
    const calls = await callsFor(undefined, "token");
    expect(headerValue(calls[0]!.headers, "authorization")).toBeUndefined();
    expect(headerValue(calls[0]!.headers, "x-bluepencil-auth")).toBeUndefined();
    expect(headerValue(calls[1]!.headers, "authorization")).toBeUndefined();
    expect(headerValue(calls[1]!.headers, "x-bluepencil-auth")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------------------------------
 * T15 — timeout
 * ---------------------------------------------------------------------------------------------- */

describe("T15 client.timeout_aborts", () => {
  it("aborts a hanging request and reports timeout, never an empty success", async () => {
    let observedAbort = false;
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          observedAbort = true;
          reject(new Error("aborted by signal"));
        });
      });
    }) as typeof fetch;

    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      timeoutMs: 20,
      fetchImpl,
    });

    const started = Date.now();
    const error = await failureOf(client.list({}));
    expect(error.code).toBe("timeout");
    expect(error.instance).toBe("hub");
    expect(observedAbort).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

/* ------------------------------------------------------------------------------------------------
 * T16 — no token in an error surface
 * ---------------------------------------------------------------------------------------------- */

describe("T16 client.no_token_in_error", () => {
  it("keeps the credential out of message, String() and JSON.stringify()", async () => {
    const token = "sk-abc123secret";
    const captured = captureFetch(() =>
      jsonResponse(
        {
          error: {
            code: "unauthorized",
            message: `the token ${token} was rejected (prefix ${token.slice(0, 8)})`,
          },
        },
        401,
      ),
    );

    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      auth: { value: token },
      redactor: new Redactor([token]),
      fetchImpl: captured.fetchImpl,
    });

    const error = await failureOf(client.list({}));
    expect(error.code).toBe("missing_credential");
    expect(error.status).toBe(401);

    const surface = [error.message, String(error), JSON.stringify(error)].join("\n");
    expect(surface).not.toContain(token);
    expect(surface).not.toContain(token.slice(0, 8));
    expect(surface).toContain("[redacted]");
  });
});

/* ------------------------------------------------------------------------------------------------
 * T24 — roundtrip against the real hub
 * ---------------------------------------------------------------------------------------------- */

describe("T24 contract.instance_client_roundtrip", () => {
  let server: RunningServer | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("drives config/list/get/create/update/message/bulk/sessions over HTTP", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bp-federation-client-"));
    server = await startServer({ storePath: join(tempDir, "store.json"), port: 0 });
    const client = createHttpInstanceClient({ id: "local", base: server.url });

    const config = await client.config();
    expect(config.auth).toBe("none");
    expect(config.environment).toBe("dev");
    expect(config.readOnly).toBe(false);
    expect(typeof config.version).toBe("string");
    expect(client.environment).toBe("dev");
    expect(client.version).toBe(config.version);

    expect(await client.list({})).toEqual([]);

    const created = await client.createNote({
      type: "text",
      body: "a federated note",
      anchor: { hook: "checkout-submit", route: "/checkout" },
      sessionRef: "review-1",
    });
    expect(created.id).toMatch(/^n-/u);
    expect(created.body).toBe("a federated note");

    expect((await client.list({})).map((note) => note.id)).toEqual([created.id]);

    const fetched = await client.getNote(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.body).toBe("a federated note");

    const updated = await client.updateNote(created.id, { body: "a changed note" });
    expect(updated.body).toBe("a changed note");

    const withMessage = await client.addMessage(
      created.id,
      createMessage({
        id: "m-1",
        now: "2026-10-22T10:00:00.000Z",
        text: "looks good",
        author: "reviewer",
        authorType: "agent",
      }),
    );
    expect(withMessage.messages.map((message) => message.text)).toContain("looks good");

    const sessions = await client.sessions();
    expect(sessions.map((session) => session.ref)).toContain("review-1");

    expect(await client.bulkRemove([created.id])).toEqual({ removed: 1 });
    expect(await client.list({})).toEqual([]);
  });

  it("health() accepts a 0.10 hub that names app and federates:false", async () => {
    const captured = identityFetch(hubConfig({ app: "x", federates: false }), {
      ok: true,
      status: "ok",
      version: "0.10.0",
    });
    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      fetchImpl: captured.fetchImpl,
    });

    const health = await client.health();
    expect(health).toEqual({
      ok: true,
      federates: false,
      app: "x",
      environment: "dev",
      readOnly: false,
      version: "0.10.0",
    });
  });
});

describe("client rejects a slash inside a note id", () => {
  it("refuses qualified ids with invalid_id before any request", async () => {
    let fetchCalls = 0;
    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      fetchImpl: (async () => {
        fetchCalls += 1;
        return jsonResponse({});
      }) as typeof fetch,
    });

    const message = createMessage({ id: "m-1", text: "hello" });
    for (const call of [
      () => client.getNote("dev/n-1"),
      () => client.updateNote("dev/n-1", { body: "x" }),
      () => client.addMessage("dev/n-1", message),
      () => client.bulkRemove(["n-1", "dev/n-2"]),
    ]) {
      const error = await failureOf(call());
      expect(error.code).toBe("invalid_id");
    }
    expect(fetchCalls).toBe(0);
  });
});

/* ------------------------------------------------------------------------------------------------
 * T66 — filter forwarding
 * ---------------------------------------------------------------------------------------------- */

describe("T66 client.list_notes_filter_forwarded", () => {
  it("forwards every documented filter parameter, status repeated", async () => {
    const captured = captureFetch(() => jsonResponse({ notes: [] }));
    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example/api/v1/bluepencil",
      resolver: publicResolver,
      fetchImpl: captured.fetchImpl,
    });

    const filter: NoteFilter = {
      status: ["open", "needs_decision"],
      intent: "implement",
      type: "bug",
      priority: "high",
      route: "/checkout?step=2",
      session: "review-1",
      since: "2026-01-01T00:00:00.000Z",
      source: "agent",
      environment: "dev",
      includeDone: true,
    };

    await client.list(filter);

    expect(captured.calls).toHaveLength(1);
    const raw = captured.calls[0]!.url;
    const query = new URL(raw).searchParams;

    expect(query.getAll("status")).toEqual(["open", "needs_decision"]);
    expect(query.get("intent")).toBe("implement");
    expect(query.get("type")).toBe("bug");
    expect(query.get("priority")).toBe("high");
    expect(query.get("route")).toBe("/checkout?step=2");
    expect(query.get("session")).toBe("review-1");
    expect(query.get("since")).toBe("2026-01-01T00:00:00.000Z");
    expect(query.get("source")).toBe("agent");
    expect(query.get("environment")).toBe("dev");
    expect(query.get("includeDone")).toBe("true");

    // The route really is percent-encoded on the wire, not just decoded by URLSearchParams.
    expect(raw).toContain("route=%2Fcheckout%3Fstep%3D2");
  });
});

/* ------------------------------------------------------------------------------------------------
 * T67 — status mapping
 * ---------------------------------------------------------------------------------------------- */

describe("T67 client.http_status_mapping", () => {
  /** Plan §7 table; the server body in the second test names an unknown code, so it falls back. */
  const table: Array<[number, string]> = [
    [400, "environment_mismatch"],
    [401, "missing_credential"],
    [403, "read_only"],
    [404, "not_found"],
    [405, "mode_denied"],
    [408, "timeout"],
    [409, "invalid_argument"],
    [422, "invalid_argument"],
    [302, "invalid_response"],
    [500, "not_persisted"],
    [503, "not_persisted"],
    [418, "invalid_response"],
  ];

  it("maps the HTTP status table exactly", () => {
    for (const [status, code] of table) {
      expect(mapHttpStatus(status), `status ${status}`).toBe(code);
    }
  });

  it("turns the same table into thrown FederationErrors", async () => {
    for (const [status, code] of table) {
      const client = createHttpInstanceClient({
        id: "hub",
        base: "https://hub.example",
        resolver: publicResolver,
        fetchImpl: (async () =>
          status >= 300 && status < 400
            ? emptyResponse(status)
            : jsonResponse({ error: { code: "stub", message: "boom" } }, status)) as typeof fetch,
      });

      const error = await failureOf(client.list({}));
      expect(error.code, `status ${status}`).toBe(code);
      expect(error.status).toBe(status);
    }
  });

  it("lets a canonical hub error code win over the status", async () => {
    const cases: Array<[number, string, string]> = [
      [400, "invalid_payload", "invalid_argument"],
      [400, "environment_mismatch", "environment_mismatch"],
      [403, "read_only", "read_only"],
      [500, "not_found", "not_found"],
      [405, "method_not_allowed", "mode_denied"],
      [401, "unauthorized", "missing_credential"],
      [403, "forbidden", "mode_denied"],
      [409, "duplicate_id", "invalid_argument"],
      [500, "not_persisted", "not_persisted"],
    ];

    for (const [status, serverCode, code] of cases) {
      const client = createHttpInstanceClient({
        id: "hub",
        base: "https://hub.example",
        resolver: publicResolver,
        fetchImpl: (async () =>
          jsonResponse({ error: { code: serverCode, message: "boom" } }, status)) as typeof fetch,
      });

      const error = await failureOf(client.list({}));
      expect(error.code, `status ${status} code ${serverCode}`).toBe(code);
    }
  });
});

/* ------------------------------------------------------------------------------------------------
 * T78 — redirects cannot carry the credential
 * ---------------------------------------------------------------------------------------------- */

describe("T78 security.redirect_no_auth_leak", () => {
  it("refuses a 302 without a second request", async () => {
    const captured = captureFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/steal" },
        }),
    );

    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      auth: { header: "x-bluepencil-auth", value: "secret-token-1234" },
      fetchImpl: captured.fetchImpl,
    });

    const error = await failureOf(client.list({}));
    expect(error.code).toBe("invalid_response");
    expect(error.status).toBe(302);

    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0]!.url.startsWith("https://hub.example")).toBe(true);
    expect(captured.calls.every((call) => !call.url.includes("evil.example"))).toBe(true);
  });
});

/* ------------------------------------------------------------------------------------------------
 * T90 — missing federates is a start error, never "unverified"
 * ---------------------------------------------------------------------------------------------- */

describe("T90 federator.rejects_missing_federates", () => {
  it("throws federates_missing even when app is present", async () => {
    const config = hubConfig();
    delete config["federates"];
    const captured = identityFetch(config, { ok: true, version: "0.10.0" });

    const client = createHttpInstanceClient({
      id: "legacy",
      base: "https://legacy.example",
      resolver: publicResolver,
      fetchImpl: captured.fetchImpl,
    });

    const error = await failureOf(client.health());
    expect(error.code).toBe("federates_missing");
    expect(error.instance).toBe("legacy");
    expect("unverified" in error).toBe(false);
    // The /health probe never ran: the identity handshake refused first.
    expect(captured.calls).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------------------------------
 * T49 — unverified / nested / identity mismatch
 * ---------------------------------------------------------------------------------------------- */

describe("T49 federator.unverified_missing_app", () => {
  it("marks a hub without app as unverified but usable", async () => {
    const config = hubConfig({ federates: false });
    delete config["app"];
    const captured = identityFetch(config, { ok: true, version: "0.10.0" });

    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      fetchImpl: captured.fetchImpl,
    });

    const health = await client.health();
    expect(health.unverified).toBe(true);
    expect(health.ok).toBe(true);
    expect(health.federates).toBe(false);
    expect(health.app).toBeUndefined();
  });

  it("refuses a nested federation", async () => {
    const captured = identityFetch(hubConfig({ federates: true, app: "a" }), { ok: true });

    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      fetchImpl: captured.fetchImpl,
    });

    const error = await failureOf(client.health());
    expect(error.code).toBe("nested_federation");
    expect(captured.calls).toHaveLength(1);
  });

  it("refuses an app mismatch between registry and hub", async () => {
    const captured = identityFetch(hubConfig({ federates: false, app: "b" }), { ok: true });

    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      app: "a",
      fetchImpl: captured.fetchImpl,
    });

    const error = await failureOf(client.health());
    expect(error.code).toBe("identity_mismatch");
    expect(captured.calls).toHaveLength(1);
  });

  it("accepts a matching app", async () => {
    const captured = identityFetch(hubConfig({ federates: false, app: "a" }), {
      ok: true,
      version: "0.10.0",
    });

    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      app: "a",
      fetchImpl: captured.fetchImpl,
    });

    await expect(client.health()).resolves.toMatchObject({ ok: true, app: "a" });
  });
});

/* ------------------------------------------------------------------------------------------------
 * F-05 — live identity beats the registry expectation
 * ---------------------------------------------------------------------------------------------- */

describe("client.app_identity", () => {
  it("reports the /config app when the registry has no expectation", async () => {
    const captured = identityFetch(hubConfig({ federates: false, app: "live-app" }), { ok: true });
    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      fetchImpl: captured.fetchImpl,
    });

    await client.config();
    expect(client.app).toBe("live-app");
    expect(client.unverified).toBe(false);
  });

  it("marks a hub without app as unverified and exposes no app", async () => {
    const config = hubConfig({ federates: false });
    delete config["app"];
    const captured = identityFetch(config, { ok: true });
    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      fetchImpl: captured.fetchImpl,
    });

    await client.config();
    expect(client.unverified).toBe(true);
    expect(client.app).toBeUndefined();
  });

  it('treats an empty /config app as absent (F8)', async () => {
    const captured = identityFetch(hubConfig({ federates: false, app: "" }), { ok: true });
    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      fetchImpl: captured.fetchImpl,
    });

    await client.config();
    expect(client.app).toBeUndefined();
    expect(client.unverified).toBe(true);
  });

  it("falls back to the registry expectation when /config reports an empty app (F8)", async () => {
    const captured = identityFetch(hubConfig({ federates: false, app: "" }), { ok: true });
    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      app: "expected-app",
      resolver: publicResolver,
      fetchImpl: captured.fetchImpl,
    });

    await client.config();
    expect(client.app).toBe("expected-app");
    expect(client.unverified).toBe(true);

    const health = await client.health();
    expect(health.unverified).toBe(true);
    expect(health.app).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------------------------------
 * T92 — DNS re-check on every method
 * ---------------------------------------------------------------------------------------------- */

describe("T92 security.client_ssrf_dns_recheck", () => {
  it("rejects a host that resolves to a metadata address before any fetch", async () => {
    const calls: Array<(client: InstanceClient) => Promise<unknown>> = [
      (client) => client.config(),
      (client) => client.health(),
      (client) => client.list({}),
      (client) => client.getNote("n-1"),
      (client) =>
        client.createNote({ type: "text", body: "x", anchor: { hook: "h" } }),
      (client) => client.updateNote("n-1", { body: "y" }),
      (client) =>
        client.addMessage(
          "n-1",
          createMessage({ id: "m-1", text: "hello", author: "reviewer", authorType: "agent" }),
        ),
      (client) => client.bulkRemove(["n-1"]),
      (client) => client.sessions(),
      (client) => client.resource("/notes"),
      (client) => client.mcpCall("list_notes", {}),
      (client) => client.exportBundle({ format: "json", includeDone: true }),
    ];

    for (const allowInsecure of [false, true]) {
      let fetchCalls = 0;
      const client = createHttpInstanceClient({
        id: "rebind",
        base: "https://rebind.example/api/v1/bluepencil",
        allowInsecure,
        resolver: async () => ["169.254.169.254"],
        fetchImpl: (async () => {
          fetchCalls += 1;
          return jsonResponse({});
        }) as typeof fetch,
      });

      for (const call of calls) {
        const error = await failureOf(call(client));
        expect(error.code, `allowInsecure=${String(allowInsecure)}`).toBe("invalid_base_url");
      }
      expect(fetchCalls).toBe(0);
    }
  });
});

/* ------------------------------------------------------------------------------------------------
 * F-01 — the default resolver makes DNS part of the pre-flight gate
 * ---------------------------------------------------------------------------------------------- */

describe("security.client_ssrf_no_resolver_default", () => {
  it("fails closed on a non-literal host without an injected resolver", async () => {
    let fetchCalls = 0;
    const client = createHttpInstanceClient({
      id: "ssrf",
      base: "https://169.254.169.254.nip.io",
      // Deliberately no resolver: the production default must perform the DNS check.
      fetchImpl: (async () => {
        fetchCalls += 1;
        return jsonResponse({ notes: [] });
      }) as typeof fetch,
    });

    // Resolving -> metadata address; unresolvable -> fail closed. Both are invalid_base_url.
    const error = await failureOf(client.list({}));
    expect(error.code).toBe("invalid_base_url");
    expect(fetchCalls).toBe(0);
  });
});

/* ------------------------------------------------------------------------------------------------
 * F-09 — the DNS check shares the request timeout budget
 * ---------------------------------------------------------------------------------------------- */

describe("security.client_dns_check_shares_timeout", () => {
  it("aborts a hanging resolver inside the request budget", async () => {
    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hanging.example",
      timeoutMs: 20,
      resolver: (() => new Promise<readonly string[]>(() => {})) as HostResolver,
      fetchImpl: (async () => {
        throw new Error("fetch must never run");
      }) as typeof fetch,
    });

    const started = Date.now();
    const error = await failureOf(client.list({}));
    expect(error.code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(150);
  });
});

/* ------------------------------------------------------------------------------------------------
 * F-06 — bulk-delete must report a real count
 * ---------------------------------------------------------------------------------------------- */

describe("client.bulk_remove_requires_count", () => {
  it("rejects a 200 without a finite removal count", async () => {
    const captured = captureFetch(() => jsonResponse({ ok: true }));
    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      fetchImpl: captured.fetchImpl,
    });

    const error = await failureOf(client.bulkRemove(["n-1"]));
    expect(error.code).toBe("invalid_response");
  });
});

/* ------------------------------------------------------------------------------------------------
 * F-14 — body read failures stay inside the error taxonomy
 * ---------------------------------------------------------------------------------------------- */

describe("client.body_read_failure_is_taxonomic", () => {
  it("maps an unreadable success body to instance_unreachable", async () => {
    const unreadable = {
      ok: true,
      status: 200,
      text: async (): Promise<string> => {
        throw new Error("stream reset");
      },
    } as unknown as Response;

    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      fetchImpl: (async () => unreadable) as typeof fetch,
    });

    const error = await failureOf(client.list({}));
    expect(error.code).toBe("instance_unreachable");
  });
});

/* ------------------------------------------------------------------------------------------------
 * F-21 — auth mode is primed from /config before the first note request
 * ---------------------------------------------------------------------------------------------- */

describe("client.primes_auth_mode", () => {
  it("sends Authorization: Bearer on a first list() against a token hub", async () => {
    const token = "tok_live_abcdefgh";
    const captured = captureFetch((url) => {
      if (url.endsWith("/config")) return jsonResponse(hubConfig({ auth: "token" }));
      if (url.endsWith("/notes")) return jsonResponse({ notes: [] });
      return jsonResponse({ error: { code: "not_found", message: "unexpected" } }, 404);
    });

    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      auth: { value: token },
      fetchImpl: captured.fetchImpl,
    });

    expect(await client.list({})).toEqual([]);
    // /config must come first so the note request already knows the header shape.
    expect(captured.calls.map((call) => (call.url.endsWith("/config") ? "config" : "notes"))).toEqual(
      ["config", "notes"],
    );

    const notesCall = captured.calls.find((call) => call.url.endsWith("/notes"));
    expect(headerValue(notesCall?.headers, "authorization")).toBe(`Bearer ${token}`);
    expect(headerValue(notesCall?.headers, "x-bluepencil-auth")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------------------------------
 * N-02 — concurrent first requests share one in-flight /config
 * ---------------------------------------------------------------------------------------------- */

describe("N-02 concurrent requests share the config load", () => {
  /** A token-hub stub whose `/config` resolves asynchronously, so requests really do overlap. */
  function tokenHubFetch() {
    return captureFetch(async (url) => {
      if (url.endsWith("/config")) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return jsonResponse(hubConfig({ auth: "token", federates: false, app: "test-app" }));
      }
      if (url.endsWith("/health")) return jsonResponse({ ok: true, version: "0.10.0" });
      if (url.endsWith("/notes")) return jsonResponse({ notes: [] });
      return jsonResponse({ error: { code: "not_found", message: "unexpected" } }, 404);
    });
  }

  it("sends Authorization on both concurrent list() calls on a token hub", async () => {
    const token = "tok_live_concurrent";
    const captured = tokenHubFetch();
    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      auth: { value: token },
      fetchImpl: captured.fetchImpl,
    });

    const [first, second] = await Promise.all([client.list({}), client.list({})]);
    expect(first).toEqual([]);
    expect(second).toEqual([]);

    // One shared /config for both first requests.
    expect(captured.calls.filter((call) => call.url.endsWith("/config"))).toHaveLength(1);

    const notesCalls = captured.calls.filter((call) => call.url.endsWith("/notes"));
    expect(notesCalls).toHaveLength(2);
    for (const call of notesCalls) {
      expect(headerValue(call.headers, "authorization")).toBe(`Bearer ${token}`);
      expect(headerValue(call.headers, "x-bluepencil-auth")).toBeUndefined();
    }
  });

  it("lets concurrent health() and list() both succeed", async () => {
    const token = "tok_live_concurrent";
    const captured = tokenHubFetch();
    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      auth: { value: token },
      fetchImpl: captured.fetchImpl,
    });

    const [health, notes] = await Promise.all([client.health(), client.list({})]);
    expect(health.federates).toBe(false);
    expect(notes).toEqual([]);

    expect(captured.calls.filter((call) => call.url.endsWith("/config"))).toHaveLength(1);
    for (const path of ["/health", "/notes"]) {
      const call = captured.calls.find((entry) => entry.url.endsWith(path));
      expect(headerValue(call?.headers, "authorization")).toBe(`Bearer ${token}`);
    }
  });

  it("still runs the request when priming /config fails (fallback path)", async () => {
    const captured = captureFetch((url) => {
      if (url.endsWith("/config")) {
        return jsonResponse({ error: { code: "not_persisted", message: "config down" } }, 500);
      }
      if (url.endsWith("/notes")) return jsonResponse({ notes: [{ id: "n-1" }] });
      return jsonResponse({ error: { code: "not_found", message: "unexpected" } }, 404);
    });
    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      auth: { value: "tok_abcdefgh" },
      fetchImpl: captured.fetchImpl,
    });

    // The /config error must not replace the operation's own outcome.
    await expect(client.list({})).resolves.toEqual([{ id: "n-1" }]);

    const notesCall = captured.calls.find((call) => call.url.endsWith("/notes"));
    // Fallback to the secret-header default because the auth mode could not be learned.
    expect(headerValue(notesCall?.headers, "x-bluepencil-auth")).toBe("tok_abcdefgh");
    expect(headerValue(notesCall?.headers, "authorization")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------------------------------
 * F-22 — malformed note payloads are invalid_response, never instance_unreachable
 * ---------------------------------------------------------------------------------------------- */

describe("client.malformed_note_payload", () => {
  it("rejects a note list whose entries have no string id", async () => {
    const captured = captureFetch(() => jsonResponse({ notes: [{ body: "x" }] }));
    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      fetchImpl: captured.fetchImpl,
    });

    const error = await failureOf(client.list({}));
    expect(error.code).toBe("invalid_response");
  });

  it("rejects a single note without a string id", async () => {
    const captured = captureFetch(() => jsonResponse({ note: { body: "x" } }));
    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      fetchImpl: captured.fetchImpl,
    });

    const error = await failureOf(client.getNote("n-1"));
    expect(error.code).toBe("invalid_response");
  });
});

/* ------------------------------------------------------------------------------------------------
 * MCP handshake and JSON-RPC handling
 * ---------------------------------------------------------------------------------------------- */

type ToolOutcome =
  | { result: unknown }
  | { error: { code: number; message: string } };

/** Stub of the documented `POST /mcp` door plus `/config`. */
function mcpFetch(outcomeFor: (tool: string) => ToolOutcome) {
  return captureFetch((url, init) => {
    if (url.endsWith("/config")) return jsonResponse(hubConfig({ auth: "none" }));
    if (!url.endsWith("/mcp")) return jsonResponse({}, 404);

    const body = JSON.parse(init.body as string) as {
      id?: number;
      method?: string;
      params?: { name?: string };
    };

    if (body.method === "initialize") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { protocolVersion: "2024-11-05", capabilities: {} },
      });
    }
    if (body.method === "notifications/initialized") return emptyResponse(202);
    if (body.method === "tools/call") {
      const outcome = outcomeFor(body.params?.name ?? "");
      if ("error" in outcome) {
        return jsonResponse({ jsonrpc: "2.0", id: body.id, error: outcome.error });
      }
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: outcome.result });
    }
    return jsonResponse({ error: { code: "method", message: "unexpected method" } }, 400);
  });
}

function toolCalls(calls: Call[]): Array<{ method?: string }> {
  return calls
    .filter((call) => call.url.endsWith("/mcp"))
    .map((call) => JSON.parse(call.body ?? "{}") as { method?: string });
}

describe("mcpCall — handshake and JSON-RPC mapping", () => {
  const okResult = { content: [{ type: "text", text: "ok" }] };

  it("initializes exactly once for sequential calls", async () => {
    const captured = mcpFetch(() => ({ result: okResult }));
    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      clientName: "federator",
      sessionId: "session-1",
      fetchImpl: captured.fetchImpl,
    });

    await client.mcpCall("list_notes", {});
    await client.mcpCall("list_notes", {});

    const methods = toolCalls(captured.calls).map((entry) => entry.method);
    expect(methods.filter((method) => method === "initialize")).toHaveLength(1);
    expect(methods.filter((method) => method === "notifications/initialized")).toHaveLength(1);
    expect(methods.filter((method) => method === "tools/call")).toHaveLength(2);

    const mcpInit = captured.calls.find(
      (call) =>
        call.url.endsWith("/mcp") &&
        (JSON.parse(call.body ?? "{}") as { method?: string }).method === "initialize",
    );
    expect(headerValue(mcpInit?.headers, "x-bluepencil-client")).toBe("federator");
    expect(headerValue(mcpInit?.headers, "mcp-session-id")).toBe("session-1");
  });

  it("shares one in-flight initialize between concurrent callers", async () => {
    const captured = mcpFetch(() => ({ result: okResult }));
    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      fetchImpl: captured.fetchImpl,
    });

    await Promise.all([
      client.mcpCall("list_notes", {}),
      client.mcpCall("list_notes", {}),
      client.mcpCall("list_notes", {}),
    ]);

    const methods = toolCalls(captured.calls).map((entry) => entry.method);
    expect(methods.filter((method) => method === "initialize")).toHaveLength(1);
    expect(methods.filter((method) => method === "notifications/initialized")).toHaveLength(1);
    expect(methods.filter((method) => method === "tools/call")).toHaveLength(3);
  });

  it("maps JSON-RPC errors to federation codes", async () => {
    const cases: Array<[number, string]> = [
      [-32602, "invalid_argument"],
      [-32601, "invalid_argument"],
      [-32600, "invalid_argument"],
      [-32000, "invalid_response"],
    ];

    for (const [rpcCode, code] of cases) {
      const captured = mcpFetch(() => ({
        error: { code: rpcCode, message: "rpc failed" },
      }));
      const client = createHttpInstanceClient({
        id: "hub",
        base: "https://hub.example",
        resolver: publicResolver,
        fetchImpl: captured.fetchImpl,
      });

      const error = await failureOf(client.mcpCall("import_bundle", {}));
      expect(error.code, `rpc ${rpcCode}`).toBe(code);
    }
  });

  it("returns an isError tool result instead of throwing it", async () => {
    const captured = mcpFetch(() => ({
      result: { content: [{ type: "text", text: "refused" }], isError: true },
    }));
    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      fetchImpl: captured.fetchImpl,
    });

    const response = await client.mcpCall("import_bundle", {});
    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toBe("refused");
  });

  it("routes exportBundle/importBundle through tools/call with snake_case arguments (T71)", async () => {
    const captured = mcpFetch(() => ({ result: okResult }));
    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      fetchImpl: captured.fetchImpl,
    });

    await client.exportBundle({ format: "json", includeDone: true });
    await client.importBundle(
      { kind: "bundle" },
      { mode: "merge", dryRun: false, onConflict: "keep-incoming", allowEnvMismatch: true },
    );

    const bodies = captured.calls
      .filter((call) => call.url.endsWith("/mcp"))
      .map((call) => JSON.parse(call.body ?? "{}") as { method?: string; params?: unknown })
      .filter((body) => body.method === "tools/call");

    expect(bodies).toHaveLength(2);
    // The remote MCP tools read snake_case; the exact body is the contract (PR-3 carry-over).
    expect(bodies[0]?.params).toEqual({
      name: "export_bundle",
      arguments: { format: "json", include_done: true },
    });
    expect(bodies[1]?.params).toEqual({
      name: "import_bundle",
      arguments: {
        bundle: { kind: "bundle" },
        mode: "merge",
        dry_run: false,
        on_conflict: "keep-incoming",
        allow_env_mismatch: true,
      },
    });
  });

  it("omits absent optional import arguments instead of sending undefined", async () => {
    const captured = mcpFetch(() => ({ result: okResult }));
    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      fetchImpl: captured.fetchImpl,
    });

    await client.importBundle({ kind: "bundle" }, { mode: "upsert", dryRun: true });

    const call = captured.calls
      .filter((entry) => entry.url.endsWith("/mcp"))
      .map((entry) => JSON.parse(entry.body ?? "{}") as { method?: string; params?: unknown })
      .find((body) => body.method === "tools/call");
    expect(call?.params).toEqual({
      name: "import_bundle",
      arguments: { bundle: { kind: "bundle" }, mode: "upsert", dry_run: true },
    });
  });

  it("forwards a mutable clientName on every /mcp request (FR-16.4)", async () => {
    const captured = mcpFetch(() => ({ result: okResult }));
    const client = createHttpInstanceClient({
      id: "hub",
      base: "https://hub.example",
      resolver: publicResolver,
      clientName: "first-agent",
      fetchImpl: captured.fetchImpl,
    });

    await client.mcpCall("list_notes", {});
    client.clientName = "second-agent";
    await client.mcpCall("list_notes", {});

    const toolRequests = captured.calls.filter(
      (call) =>
        call.url.endsWith("/mcp") &&
        (JSON.parse(call.body ?? "{}") as { method?: string }).method === "tools/call",
    );
    expect(toolRequests).toHaveLength(2);
    expect(headerValue(toolRequests[0]?.headers, "x-bluepencil-client")).toBe("first-agent");
    expect(headerValue(toolRequests[1]?.headers, "x-bluepencil-client")).toBe("second-agent");
  });
});
