/**
 * The MCP door on the hub (FR-16.8/16.9).
 *
 * Two things are asserted, and they are different claims:
 *   - the rules of the door: POST only, no credential no entry, a claimed protocol version has to be
 *     the one this hub speaks, a parse error is a parse error, `exit` cannot stop the service;
 *   - that both doors really share one store: a note an agent writes over MCP is what the notes API
 *     returns, and a note the notes API stores is what the agent's next `list_notes` sees. That second
 *     claim is the one worth a socket, because a wrong store wiring looks perfectly healthy in a unit
 *     test with a fake — it only fails when the two paths meet.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as nodeRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BASE_PATH, type HandlerContext, type TokenVerifier } from "../../server/handler";
import { handleMcpRoute } from "../../server/mcp";
import { startServer } from "../../server/index";
import type { StoreFileIo } from "../../src/mcp/tools";

const BASE = DEFAULT_BASE_PATH;
const SHARED = "hub-mcp-shared-value";
type Json = Record<string, unknown>;

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

function tempStorePath(): string {
  tempDir = mkdtempSync(join(tmpdir(), "bp-hub-mcp-"));
  return join(tempDir, "notes.bluepencil.json");
}

function context(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    store: { notes: [] },
    base: BASE,
    environment: "dev",
    readOnly: false,
    persist: () => undefined,
    ...overrides,
  };
}

/** The store medium, in memory: the same `{read, write}` pair the hub hands over. */
function memoryIo(initial: string | null = null): { io: StoreFileIo; text: () => string | null } {
  let text = initial;
  return {
    io: {
      read: async () => text,
      write: async (next: string) => {
        text = next;
      },
    },
    text: () => text,
  };
}

async function mcp(
  body: unknown,
  options: { method?: string; headers?: Record<string, string>; overrides?: Partial<HandlerContext>; io?: StoreFileIo } = {},
): Promise<{ status: number; body: Json; headers: Record<string, string> }> {
  const { io } = memoryIo();
  const response = await handleMcpRoute(
    {
      method: options.method ?? "POST",
      url: `${BASE}/mcp`,
      headers: options.headers ?? {},
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    context(options.overrides ?? {}),
    options.io ?? io,
  );
  if (response === null) {
    throw new Error("the MCP door did not answer — this request does not belong to it");
  }
  return {
    status: response.status,
    body: response.body === "" ? {} : (JSON.parse(response.body) as Json),
    headers: response.headers as Record<string, string>,
  };
}

describe("the MCP door: what it accepts", () => {
  it("leaves paths that are not its own to the notes API", async () => {
    const response = await handleMcpRoute(
      { method: "POST", url: `${BASE}/notes`, headers: {}, body: "{}" },
      context(),
      memoryIo().io,
    );
    expect(response).toBe(null);
  });

  it("is POST only — the hub sends nothing on its own", async () => {
    const answered = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { method: "GET" });
    expect(answered.status).toBe(405);
    expect(answered.headers["allow"]).toBe("POST");
  });

  it("refuses a claimed protocol version it does not speak", async () => {
    const good = await mcp({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { "mcp-protocol-version": "2024-11-05" } });
    expect(good.status).toBe(200);

    const bad = await mcp({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { "mcp-protocol-version": "1999-01-01" } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("1999-01-01");
  });

  it("answers a parse error as a parse error", async () => {
    const answered = await mcp("{not json");
    expect(answered.status).toBe(400);
    expect((answered.body["error"] as Json)["code"]).toBe(-32700);
  });

  it("names an unknown method and an unknown tool the way the protocol does", async () => {
    const unknownMethod = await mcp({ jsonrpc: "2.0", id: 1, method: "nope" });
    expect((unknownMethod.body["error"] as Json)["code"]).toBe(-32601);

    const unknownTool = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "no_such_tool" } });
    expect((unknownTool.body["error"] as Json)["code"]).toBe(-32602);
  });

  it("accepts a initialize and answers with its own identity", async () => {
    const answered = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", clientInfo: { name: "vitest-agent" } },
    });
    const result = answered.body["result"] as Json;
    expect(answered.status).toBe(200);
    expect(result["protocolVersion"]).toBe("2024-11-05");
    expect((result["serverInfo"] as Json)["name"]).toBe("bluepencil");
  });

  it("executes a notification without answering it", async () => {
    const { io } = memoryIo(JSON.stringify([]));
    const answered = await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, { io });
    expect(answered.status).toBe(202);
    expect(answered.body).toEqual({});
  });

  it("never lets a caller stop the hub it is talking to", async () => {
    const answered = await mcp({ jsonrpc: "2.0", id: 9, method: "exit" });
    expect(answered.status).toBe(200);
    expect((answered.body["error"] as Json)["code"]).toBe(-32601);
    expect(String((answered.body["error"] as Json)["message"])).toContain("keeps running");
  });
});

describe("the MCP door: who gets in", () => {
  it("needs the credential the notes API needs", async () => {
    const refused = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { overrides: { authSecret: SHARED } });
    expect(refused.status).toBe(401);

    const allowed = await mcp(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { overrides: { authSecret: SHARED }, headers: { "x-bluepencil-auth": SHARED } },
    );
    expect(allowed.status).toBe(200);
  });

  it("lets a read-scoped device read, and stops it from writing", async () => {
    // A POST looks like a write; the message decides. Otherwise a read-only device could never call a
    // read tool over HTTP, which is the whole point of the door.
    const verifier: TokenVerifier = (_token, required) =>
      required === "read" ? { ok: true, device: "graph-viewer" } : { ok: false, reason: "insufficient-scope" };
    const overrides: Partial<HandlerContext> = { verifyToken: verifier };
    const headers = { authorization: "Bearer whatever" };

    const reading = await mcp(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_notes", arguments: {} } },
      { overrides, headers },
    );
    expect(reading.status).toBe(200);
    expect((reading.body["result"] as Json)["content"]).toBeDefined();

    const writing = await mcp(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "create_note", arguments: { body: "should not land" } },
      },
      { overrides, headers },
    );
    expect(writing.status).toBe(403);
    expect(String((writing.body["error"] as Json)["message"])).toContain("insufficient-scope");
  });

  it("refuses a write on a read-only hub as a refusal of the tool, not of the protocol", async () => {
    const answered = await mcp(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_note", arguments: { body: "nope", selector: "#a" } },
      },
      { overrides: { readOnly: true } },
    );
    expect(answered.status).toBe(200);
    const result = answered.body["result"] as Json;
    expect(result["isError"]).toBe(true);
    expect(JSON.stringify(result)).toMatch(/read-only/i);
  });
});

describe("the MCP door: one store, two doors (FR-16.9)", () => {
  function post(port: number, path: string, payload: unknown, headers: Record<string, string>): Promise<{ status: number; body: Json }> {
    return new Promise((resolvePromise, rejectPromise) => {
      const text = JSON.stringify(payload);
      const request = nodeRequest(
        {
          host: "127.0.0.1",
          port,
          path,
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers },
        },
        (response) => {
          let received = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            received += chunk;
          });
          response.on("end", () =>
            resolvePromise({ status: response.statusCode ?? 0, body: JSON.parse(received) as Json }),
          );
        },
      );
      request.on("error", rejectPromise);
      request.end(text);
    });
  }

  function get(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: Json }> {
    return new Promise((resolvePromise, rejectPromise) => {
      const request = nodeRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (response) => {
        let received = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          received += chunk;
        });
        response.on("end", () =>
          resolvePromise({ status: response.statusCode ?? 0, body: JSON.parse(received) as Json }),
        );
      });
      request.on("error", rejectPromise);
      request.end();
    });
  }

  it("shows each door what the other one wrote", async () => {
    const storePath = tempStorePath();
    const auth = { "x-bluepencil-auth": SHARED };
    const server = await startServer({
      storePath,
      port: 0,
      host: "127.0.0.1",
      authSecret: SHARED,
      quiet: true,
    });
    servers.push(server);

    const agentNote = "written by the agent over MCP";
    const written = await post(
      server.port,
      `${BASE}/mcp`,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "create_note",
          arguments: { body: agentNote, type: "text", intent: "implement", route: "/checkout", selector: "#pay" },
        },
      },
      auth,
    );
    expect(written.status).toBe(200);
    expect((written.body["result"] as Json)["isError"]).toBeUndefined();

    // The browser door reads the same set — no file was opened twice, no copy was left stale.
    const notes = await get(server.port, `${BASE}/notes`, auth);
    expect(notes.status).toBe(200);
    expect((notes.body["notes"] as Json[]).map((note) => note["body"])).toContain(agentNote);

    // …and the other direction: a note stored by the notes API is what the agent's next call sees.
    const browserNote = "written by the browser";
    const created = await post(
      server.port,
      `${BASE}/notes`,
      {
        body: browserNote,
        type: "text",
        intent: "feedback",
        author: "daniel",
        authorType: "human",
        anchor: { route: "/cart", selector: "#total" },
      },
      auth,
    );
    expect(created.status).toBe(200);

    const listed = await post(
      server.port,
      `${BASE}/mcp`,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_notes", arguments: {} } },
      auth,
    );
    const text = JSON.stringify(listed.body);
    expect(text).toContain(browserNote);
    expect(text).toContain(agentNote);

    // One file, one format: the hub's own bundle, written by both doors.
    const stored = JSON.parse(readFileSync(storePath, "utf8")) as Json;
    expect(stored["kind"]).toBe("bluepencil.bundle");
    expect((stored["notes"] as Json[]).length).toBe(2);
  });
});
