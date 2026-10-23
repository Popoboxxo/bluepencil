/**
 * @vitest-environment node — real loopback `node:http` peers and a real combined hub.
 *
 * NFR-22 security regressions from plan §8 (T35, T36, T81). Every case checks the *serialised*
 * surface a client, a log or a terminal would see, not the internal object graph:
 *
 *  - T35: tool output from an authenticated instance never carries the token or an auth field;
 *  - T36: a 401 and a non-object answer produce a redacted error, never the credential;
 *  - T81: two instances with different tokens never receive each other's credential.
 *
 * Dummy tokens only, loopback only, no real network.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  request as nodeRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNote } from "../../src/core/model";
import { createHttpInstanceClient } from "../../src/federation/client";
import { FederationError, Redactor } from "../../src/federation/errors";
import { startHub, type RunningServer } from "../../server/hub";

const NOW = "2026-04-01T00:00:00.000Z";

type Json = Record<string, unknown>;

let tempDir: string | undefined;
let registryCounter = 0;
const hubs: RunningServer[] = [];
const peers: Server[] = [];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "bp-federation-security-"));
  registryCounter = 0;
});

afterEach(async () => {
  for (const hub of hubs.splice(0)) {
    await hub.close();
  }
  await Promise.all(
    peers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  for (const name of [
    "BP_SEC_35_TOKEN",
    "BP_SEC_81_TOKEN_A",
    "BP_SEC_81_TOKEN_B",
  ] as const) {
    delete process.env[name];
  }
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

/* ------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

function storePath(name = "notes.bluepencil.json"): string {
  if (tempDir === undefined) throw new Error("temp dir not initialised");
  return join(tempDir, name);
}

function writeRegistry(
  instances: Array<Record<string, unknown>>,
  defaults?: Record<string, unknown>,
): string {
  if (tempDir === undefined) throw new Error("temp dir not initialised");
  registryCounter += 1;
  const path = join(tempDir, `registry-${registryCounter}.json`);
  writeFileSync(
    path,
    JSON.stringify({ schemaVersion: 1, ...(defaults === undefined ? {} : { defaults }), instances }),
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
  return path;
}

async function serve(options: Parameters<typeof startHub>[0]): Promise<RunningServer> {
  const hub = await startHub({ port: 0, quiet: true, journal: "none", ...options });
  hubs.push(hub);
  return hub;
}

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = nodeRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers:
          payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () =>
          resolvePromise({ status: response.statusCode ?? 0, text }),
        );
      },
    );
    req.on("error", rejectPromise);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function tool(
  hub: RunningServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Json> {
  const base = new URL(hub.url).pathname.replace(/\/+$/u, "");
  const answered = await request(hub.port, "POST", `${base}/mcp`, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  expect(answered.status).toBe(200);
  const envelope = JSON.parse(answered.text) as Json;
  const error = envelope["error"] as Json | undefined;
  if (error !== undefined) throw new Error(`JSON-RPC error: ${JSON.stringify(error)}`);
  return envelope["result"] as Json;
}

function toolText(result: Json): string {
  const content = result["content"] as Array<{ text: string }>;
  return content[0]!.text;
}

/** Full serialised error, including the non-enumerable `message` and `stack`. */
function serializeError(error: unknown): string {
  if (!(error instanceof Error)) return JSON.stringify(error);
  const federation = error instanceof FederationError ? error : undefined;
  return JSON.stringify({
    name: error.name,
    message: error.message,
    stack: error.stack ?? "",
    ...(federation === undefined
      ? {}
      : { code: federation.code, instance: federation.instance, status: federation.status }),
  });
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to reject");
}

interface Captured {
  url: string;
  headers: IncomingHttpHeaders;
}

/** Starts an in-process peer and records every inbound request's headers. */
async function startPeer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const server = createHttpServer(handler);
  peers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function tokenModeConfig(app: string): Json {
  return {
    name: app,
    version: "0.10.0",
    base: "/",
    auth: "token",
    readOnly: false,
    environment: "dev",
    app,
    federates: false,
  };
}

function note(id: string, body: string): ReturnType<typeof createNote> {
  return createNote({
    id,
    now: NOW,
    type: "text",
    body,
    anchor: { hook: id },
    author: "human",
    authorType: "human",
    source: "ui:human",
    environment: "dev",
  });
}

/* ------------------------------------------------------------------------------------------------
 * T35 — tool output never serialises a credential
 * ---------------------------------------------------------------------------------------------- */

describe("security.tool_output_no_secret (T35)", () => {
  it("keeps the token and auth fields out of list_instances and list_notes", async () => {
    const token = "bp-sec35-token-7f31a9";
    process.env["BP_SEC_35_TOKEN"] = token;

    /* A real authenticated hub as the peer: the combined hub must authenticate to read it. */
    const peer = await serve({
      storePath: storePath("peer.json"),
      appName: "peer-app",
      environment: "dev",
      authSecret: token,
    });
    const registry = writeRegistry(
      [{ id: "dev", base: peer.url, app: "peer-app", auth: { env: "BP_SEC_35_TOKEN" } }],
      { includeSelf: false },
    );
    const hub = await serve({
      storePath: storePath("hub.json"),
      appName: "hub-app",
      environment: "dev",
      registry,
    });

    const instances = toolText(await tool(hub, "list_instances"));
    const notes = toolText(await tool(hub, "list_notes"));
    const serialized = `${instances}\n${notes}`;

    /* The peer really was authenticated: a token that never reached it would surface as
     * `ok:false`/`missing_credential`, making the no-leak assertion meaningless. */
    const rows = JSON.parse(instances) as Array<{ id: string; ok: boolean }>;
    expect(rows.find((row) => row.id === "dev")?.ok).toBe(true);
    const aggregate = JSON.parse(notes) as { partial: boolean; errors: unknown[] };
    expect(aggregate.partial).toBe(false);
    expect(aggregate.errors).toEqual([]);

    expect(serialized).not.toContain(token);
    expect(serialized).not.toMatch(/\bauthorization\b/iu);
    /* `\bauth\b` matches an `auth` key/value but deliberately not `author`. */
    expect(serialized).not.toMatch(/\bauth\b/iu);
  });
});

/* ------------------------------------------------------------------------------------------------
 * T36 — an error surface never serialises a credential
 * ---------------------------------------------------------------------------------------------- */

describe("security.error_no_secret (T36)", () => {
  it("redacts the token from a 401 answer", async () => {
    const token = "bp-sec36-token-2d8c44";
    const base = await startPeer((req, res) => {
      const url = req.url ?? "/";
      if (req.method === "GET" && url === "/config") {
        json(res, tokenModeConfig("denied-app"));
        return;
      }
      if (req.method === "GET" && url.startsWith("/notes")) {
        /* Deliberately echo the token in the server message: the client must redact it. */
        json(
          res,
          { error: { code: "unauthorized", message: `token ${token} was rejected` } },
          401,
        );
        return;
      }
      json(res, { error: { code: "not_found", message: url } }, 404);
    });

    const client = createHttpInstanceClient({
      id: "denied",
      base,
      auth: { value: token },
      timeoutMs: 1000,
      redactor: new Redactor([token]),
    });

    const error = await rejectionOf(client.list({}));
    expect(error).toBeInstanceOf(FederationError);
    expect((error as FederationError).code).toBe("missing_credential");
    const serialized = serializeError(error);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(token.slice(0, 8));
  });

  it("redacts the token from a non-object /config answer", async () => {
    const token = "bp-sec36-html-9a1e02";
    const base = await startPeer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>this is not a config</html>");
    });

    const client = createHttpInstanceClient({
      id: "broken",
      base,
      auth: { value: token },
      timeoutMs: 1000,
      redactor: new Redactor([token]),
    });

    const error = await rejectionOf(client.health());
    expect(error).toBeInstanceOf(FederationError);
    expect((error as FederationError).code).toBe("invalid_response");
    const serialized = serializeError(error);
    expect(serialized).not.toContain(token);
  });
});

/* ------------------------------------------------------------------------------------------------
 * T81 — a credential never fans out to another instance
 * ---------------------------------------------------------------------------------------------- */

describe("security.credential_blast_radius (T81)", () => {
  it("sends each peer only its own instance token and never the other one", async () => {
    const tokenA = "bp-sec81-token-alpha-5c7a";
    const tokenB = "bp-sec81-token-beta-0e13";
    process.env["BP_SEC_81_TOKEN_A"] = tokenA;
    process.env["BP_SEC_81_TOKEN_B"] = tokenB;

    const capturedA: Captured[] = [];
    const capturedB: Captured[] = [];

    const peerA = await startPeer((req, res) => {
      capturedA.push({ url: req.url ?? "/", headers: { ...req.headers } });
      const url = req.url ?? "/";
      if (req.method === "GET" && url === "/config") {
        json(res, tokenModeConfig("app-a"));
        return;
      }
      if (req.method === "GET" && url === "/health") {
        json(res, { ok: true, version: "0.10.0" });
        return;
      }
      if (req.method === "GET" && url.startsWith("/notes")) {
        json(res, { notes: [note("n-a", "note from alpha")] });
        return;
      }
      json(res, { error: { code: "not_found", message: url } }, 404);
    });

    const peerB = await startPeer((req, res) => {
      capturedB.push({ url: req.url ?? "/", headers: { ...req.headers } });
      const url = req.url ?? "/";
      if (req.method === "GET" && url === "/config") {
        json(res, tokenModeConfig("app-b"));
        return;
      }
      if (req.method === "GET" && url === "/health") {
        json(res, { ok: true, version: "0.10.0" });
        return;
      }
      if (req.method === "GET" && url.startsWith("/notes")) {
        json(res, { notes: [note("n-b", "note from beta")] });
        return;
      }
      json(res, { error: { code: "not_found", message: url } }, 404);
    });

    const registry = writeRegistry(
      [
        { id: "alpha", base: peerA, app: "app-a", auth: { env: "BP_SEC_81_TOKEN_A" } },
        { id: "beta", base: peerB, app: "app-b", auth: { env: "BP_SEC_81_TOKEN_B" } },
      ],
      { includeSelf: false },
    );
    const hub = await serve({
      storePath: storePath("hub.json"),
      appName: "hub-app",
      environment: "dev",
      registry,
    });

    const listed = toolText(await tool(hub, "list_notes"));
    expect(listed).toContain("note from alpha");
    expect(listed).toContain("note from beta");

    /* Every request to a peer carries that peer's own credential only. */
    for (const [captured, ownToken, otherToken, label] of [
      [capturedA, tokenA, tokenB, "alpha"],
      [capturedB, tokenB, tokenA, "beta"],
    ] as const) {
      expect(captured.length).toBeGreaterThan(0);
      const authorizationValues = captured
        .map((entry) => entry.headers.authorization)
        .filter((value): value is string => value !== undefined);
      expect(authorizationValues.length).toBeGreaterThan(0);
      for (const value of authorizationValues) {
        expect(value).toBe(`Bearer ${ownToken}`);
      }
      for (const entry of captured) {
        const headers = JSON.stringify(entry.headers);
        expect(headers, `${label} received the other instance's token`).not.toContain(otherToken);
        const secretHeader = entry.headers["x-bluepencil-auth"];
        if (secretHeader !== undefined) expect(secretHeader).toBe(ownToken);
      }
    }

    /* The aggregate itself must not surface either credential either. */
    expect(listed).not.toContain(tokenA);
    expect(listed).not.toContain(tokenB);
  });
});
