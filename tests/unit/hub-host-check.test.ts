/**
 * @vitest-environment node — one leg opens a real socket, which jsdom cannot.
 *
 * The hub's Host gate (SEC-02, contract D §3.4, AC-D03).
 *
 * The finding: a hub on loopback had no Host check, so a page at `evil.example` whose DNS answer
 * points at 127.0.0.1 could talk to the local store through the browser — the origin boundary was
 * bypassed by the *name*, not by the network. The rule that closes it is small and has to hold on
 * every door, because one route without it is the whole bypass:
 *
 *   - a hub bound to loopback answers a foreign `Host` with `403 host_not_allowed`;
 *   - accepted are `localhost`, `127.0.0.0/8`, `[::1]` and configured aliases;
 *   - a non-loopback bind is not gated (G1: it is reached by whatever name the network gave it);
 *   - `/config`, `/health`, `/journal` and `POST /mcp` are gated too, even though the probes stay
 *     credential-free.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { request as nodeRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BASE_PATH,
  handleRequest,
  hostRefusal,
  isLoopbackHostHeader,
  type HandlerContext,
  type ServerRequest,
  type ServerResponse,
} from "../../server/handler";
import { handleMcpRoute } from "../../server/mcp";
import { startServer } from "../../server/index";
import type { StoreFileIo } from "../../src/mcp/tools";

const BASE = DEFAULT_BASE_PATH;
/** What `listen()` reports for the default `--host 127.0.0.1`. */
const LOOPBACK = { host: "127.0.0.1", port: 8787 } as const;
const ALIAS = "hub.lab";

let tempDir: string | undefined;
const servers: Array<Awaited<ReturnType<typeof startServer>>> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function context(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    store: { notes: [] },
    base: BASE,
    environment: "dev",
    readOnly: false,
    persist: () => undefined,
    bind: LOOPBACK,
    ...overrides,
  };
}

function call(
  method: string,
  path: string,
  headers: Record<string, string>,
  overrides: Partial<HandlerContext> = {},
): ServerResponse {
  const request: ServerRequest = { method, url: `${BASE}${path}`, headers, body: "" };
  return handleRequest(request, context(overrides));
}

function errorCode(response: ServerResponse): string {
  return String((JSON.parse(response.body) as { error: { code: string } }).error.code);
}

/** The store medium in memory: the same `{read, write}` pair the hub hands the MCP door. */
function memoryIo(): StoreFileIo {
  let text: string | null = null;
  return {
    read: async () => text,
    write: async (next: string) => {
      text = next;
    },
  };
}

async function mcp(
  headers: Record<string, string>,
  overrides: Partial<HandlerContext> = {},
): Promise<ServerResponse> {
  const response = await handleMcpRoute(
    {
      method: "POST",
      url: `${BASE}/mcp`,
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    },
    context(overrides),
    memoryIo(),
  );
  if (response === null) throw new Error("the MCP door did not answer — this request does not belong to it");
  return response;
}

/** The API routes the router answers; `/journal` and `/mcp` are covered by their own doors below. */
const ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: "GET", path: "/notes" },
  { method: "GET", path: "/config" },
  { method: "GET", path: "/health" },
];

describe("isLoopbackHostHeader — the accepted vocabulary", () => {
  it("accepts the loopback spellings, with or without a port", () => {
    for (const host of [
      "localhost",
      "localhost:8787",
      "LOCALHOST:8787",
      "localhost.",
      "127.0.0.1",
      "127.0.0.1:8787",
      "127.42.0.9",
      "[::1]",
      "[::1]:8787",
      "::ffff:127.0.0.1",
    ]) {
      expect(isLoopbackHostHeader(host, []), host).toBe(true);
    }
  });

  it("rejects a foreign name, including one that merely starts like an address", () => {
    // `127.0.0.1.evil.example` is the trap: `isLoopbackAddress`'s `/^127\./` would accept it, and it
    // is a name somebody else owns. The literal check requires exactly four dotted groups.
    for (const host of [
      "evil.example",
      "evil.example:8787",
      "127.0.0.1.evil.example",
      "10.0.0.1",
      "[::2]",
      "hub.lab",
    ]) {
      expect(isLoopbackHostHeader(host, []), host).toBe(false);
    }
  });

  it("accepts a configured alias, port and case aside", () => {
    expect(isLoopbackHostHeader("hub.lab:8787", [ALIAS])).toBe(true);
    expect(isLoopbackHostHeader("HUB.LAB", [ALIAS])).toBe(true);
    // An alias is one name, not a wildcard: a sibling name stays refused.
    expect(isLoopbackHostHeader("other.lab", [ALIAS])).toBe(false);
  });

  it("accepts a missing Host — local tooling sends none, a browser always does", () => {
    expect(isLoopbackHostHeader(undefined, [])).toBe(true);
    expect(isLoopbackHostHeader("", [])).toBe(true);
  });
});

describe("hostRefusal — when the gate applies (AC-D03)", () => {
  it("refuses a foreign Host on a loopback bind", () => {
    const response = hostRefusal({ headers: { host: "evil.example" } }, context());
    if (response === null) throw new Error("expected the Host gate to refuse");
    expect(response.status).toBe(403);
    expect(errorCode(response)).toBe("host_not_allowed");
  });

  it("lets the loopback names and the configured alias through", () => {
    for (const host of ["localhost:8787", "127.0.0.1", "[::1]", `${ALIAS}:8787`]) {
      expect(hostRefusal({ headers: { host } }, context({ hostAliases: [ALIAS] })), host).toBeNull();
    }
  });

  it("does not gate a non-loopback bind (G1 accepts the bind and warns instead)", () => {
    // A hub on 0.0.0.0 is reached by whatever name the network gave it; a loopback allowlist there
    // would refuse legitimate LAN traffic. G1 chose the warning, not the refusal.
    expect(
      hostRefusal({ headers: { host: "lab.example" } }, context({ bind: { host: "0.0.0.0", port: 8787 } })),
    ).toBeNull();
  });

  it("does not gate a context that has no live binding yet", () => {
    // The binding is known only after `listen()`; before that there is nothing to compare against.
    expect(hostRefusal({ headers: { host: "evil.example" } }, context({ bind: undefined }))).toBeNull();
  });
});

describe("routeRequest — the Host gate runs on every API route (AC-D03)", () => {
  it("refuses a foreign Host with 403 host_not_allowed", () => {
    for (const route of ROUTES) {
      const response = call(route.method, route.path, { host: "evil.example" });
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
      expect(errorCode(response), `${route.method} ${route.path}`).toBe("host_not_allowed");
    }
  });

  it("answers the loopback names and the configured alias", () => {
    for (const host of ["localhost:8787", "127.0.0.1", "[::1]", `${ALIAS}:8787`]) {
      for (const route of ROUTES) {
        const response = call(route.method, route.path, { host }, { hostAliases: [ALIAS] });
        expect(response.status, `${host} ${route.method} ${route.path}`).not.toBe(403);
      }
    }
  });

  it("runs before the credential check, so a foreign Host learns nothing about the gate", () => {
    // The hub asks for a secret; a foreign name is answered with the Host refusal, not a 401 that
    // would confirm a credential is required and let the caller start guessing.
    const response = call("GET", "/notes", { host: "evil.example" }, { authSecret: "hub-host-check-secret" });
    expect(response.status).toBe(403);
    expect(errorCode(response)).toBe("host_not_allowed");
  });

  it("runs before the CORS preflight, so OPTIONS is gated like every other method", () => {
    const response = call("OPTIONS", "/notes", { host: "evil.example", origin: "https://evil.example" }, { cors: "*" });
    expect(response.status).toBe(403);
    // The answer is the refusal, not the preflight: a preflight names the methods a door documents
    // (`access-control-allow-methods`), and a foreign Host must not learn them.
    expect(response.headers["access-control-allow-methods"]).toBeUndefined();
    expect(errorCode(response)).toBe("host_not_allowed");
  });
});

describe("the MCP door — the same gate, no bypass (AC-D03/AC-D12)", () => {
  it("refuses a foreign Host on POST /mcp", async () => {
    const response = await mcp({ host: "evil.example" });
    expect(response.status).toBe(403);
    expect(errorCode(response)).toBe("host_not_allowed");
  });

  it("answers a loopback Host on POST /mcp", async () => {
    const response = await mcp({ host: "localhost:8787" });
    expect(response.status).toBe(200);
  });
});

describe("the glue path — /journal is gated too (AC-D03)", () => {
  it("refuses a foreign Host and serves a loopback Host on GET /journal", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bp-hub-host-"));
    const running = await startServer({
      storePath: join(tempDir, "notes.bluepencil.json"),
      port: 0,
      quiet: true,
      environment: "dev",
      journal: "none",
    });
    servers.push(running);

    const foreign = await get(running.port, `${BASE}/journal`, "evil.example");
    expect(foreign.status).toBe(403);
    expect(JSON.parse(foreign.body).error.code).toBe("host_not_allowed");

    const allowed = await get(running.port, `${BASE}/journal`, `localhost:${running.port}`);
    expect(allowed.status).toBe(200);
    expect(JSON.parse(allowed.body).journal).toBeDefined();
  });

  it("refuses a foreign Host on a POST to the notes API through the glue", async () => {
    // The same rule that protects the journal also protects the API when it is reached through the
    // `node:http` glue rather than the pure handler.
    tempDir = mkdtempSync(join(tmpdir(), "bp-hub-host-"));
    const running = await startServer({
      storePath: join(tempDir, "notes.bluepencil.json"),
      port: 0,
      quiet: true,
      environment: "dev",
      journal: "none",
    });
    servers.push(running);

    const response = await post(running.port, `${BASE}/notes`, "evil.example");
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body).error.code).toBe("host_not_allowed");
  });
});

/** `GET` against a running hub, with an explicit `Host` header. */
function get(port: number, path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = nodeRequest({ host: "127.0.0.1", port, path, method: "GET", headers: { host } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
      });
      response.on("end", () => resolvePromise({ status: response.statusCode ?? 0, body: text }));
    });
    request.on("error", rejectPromise);
    request.end();
  });
}

/** `POST` with an explicit `Host` header — the request the store must never see. */
function post(port: number, path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const text = JSON.stringify({ type: "text", body: "rebind", anchor: { selector: "#a" } });
    const request = nodeRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { host, "content-type": "application/json", "content-length": Buffer.byteLength(text) },
      },
      (response) => {
        let received = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          received += chunk;
        });
        response.on("end", () => resolvePromise({ status: response.statusCode ?? 0, body: received }));
      },
    );
    request.on("error", rejectPromise);
    request.write(text);
    request.end();
  });
}
