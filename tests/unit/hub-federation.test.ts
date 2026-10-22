/**
 * @vitest-environment node — real `node:http` sockets on loopback, real registry files with 0600.
 *
 * Combined hub + federation (PR 5b; FR-6.15, FR-16.12–16.14). The suite proves the wiring the
 * plan §6 start sequence describes:
 *
 *   - `/config` publishes `app` + `federates`, never a credential (T21, T53, T82);
 *   - `/notes` stays the local single-environment door even with a registry (T22, T54);
 *   - `/mcp` without a registry is the unchanged 0.8 store path (T26, T56); with a registry it
 *     aggregates self + peers and honours `includeSelf` (T29, T55, T57, T76);
 *   - the two write locks are enforced at the hub, with no POST to the target on refusal
 *     (T50, T93, T94);
 *   - start-up is fail-fast for nested federation, identity mismatch and missing `federates`
 *     (T46, T48, T90), allows a missing `app` as `unverified` (T49) and degrades only for an
 *     unreachable peer (T72);
 *   - a registry that points at the hub itself is `self_reference` (T47).
 *
 * No network beyond loopback; fake peers are plain in-process `node:http` servers.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as nodeRequest, createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNote } from "../../src/core/model";
import { FederationError } from "../../src/federation/errors";
import { DEFAULT_BASE_PATH, HUB_APP_NAME } from "../../server/handler";
import {
  parseHubArgs,
  sameInstanceBase,
  startHub,
  type HubOptions,
  type RunningServer,
} from "../../server/hub";

const BASE = DEFAULT_BASE_PATH;
const NOW = "2026-03-01T00:00:00.000Z";
const TOKEN_ENV = "BP_HUB_FEDERATION_TOKEN";
const TOKEN_VALUE = "federation-test-credential-value";

type Json = Record<string, unknown>;

let tempDir: string | undefined;
let registryCounter = 0;
const servers: RunningServer[] = [];
const extraServers: Server[] = [];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "bp-hub-federation-"));
  registryCounter = 0;
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  await Promise.all(
    extraServers.splice(0).map(
      (server) =>
        new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise());
        }),
    ),
  );
  delete process.env[TOKEN_ENV];
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
  // Explicit: the process umask must not be able to make the file look unsafe to `loadRegistry`.
  chmodSync(path, 0o600);
  return path;
}

function instance(id: string, base: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, base, ...extra };
}

function baseOf(server: RunningServer): string {
  return `http://127.0.0.1:${server.port}${BASE}`;
}

async function serve(options: HubOptions): Promise<RunningServer> {
  const server = await startHub({ port: 0, quiet: true, ...options });
  servers.push(server);
  return server;
}

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Json; text: string }> {
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
            ? headers
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
                ...headers,
              },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () =>
          resolvePromise({
            status: response.statusCode ?? 0,
            text,
            body: text === "" ? {} : (JSON.parse(text) as Json),
          }),
        );
      },
    );
    req.on("error", rejectPromise);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function rpc(
  server: RunningServer,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; response: Json }> {
  const answered = await request(
    server.port,
    "POST",
    `${BASE}/mcp`,
    { jsonrpc: "2.0", id: 1, method, params },
    headers,
  );
  return { status: answered.status, response: answered.body };
}

async function tool(
  server: RunningServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Json> {
  const { status, response } = await rpc(server, "tools/call", { name, arguments: args });
  expect(status).toBe(200);
  const error = response["error"] as Json | undefined;
  if (error !== undefined) throw new Error(`JSON-RPC error: ${JSON.stringify(error)}`);
  return response["result"] as Json;
}

function toolJson<T = Json>(result: Json): T {
  const content = result["content"] as Array<{ text: string }>;
  return JSON.parse(content[0]!.text) as T;
}

function toolText(result: Json): string {
  const content = result["content"] as Array<{ text: string }>;
  return content[0]!.text;
}

function createdNoteId(result: Json): string {
  const created = toolJson(result)["created"] as Json;
  return String(created["id"]);
}

/** Adds one note through the local `/notes` door (the browser path). */
async function addLocalNote(server: RunningServer, body: string): Promise<void> {
  const answer = await request(server.port, "POST", `${BASE}/notes`, {
    type: "text",
    body,
    anchor: { route: "/cart", selector: "#total" },
  });
  expect(answer.status).toBe(200);
}

function storedNoteCount(path: string): number {
  // A hub that never wrote leaves no store file; that is a note set of zero, not an error.
  if (!existsSync(path)) return 0;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { notes?: unknown[] } | unknown[];
  return Array.isArray(parsed) ? parsed.length : (parsed.notes?.length ?? 0);
}

async function failureOf(promise: Promise<unknown>): Promise<FederationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FederationError);
    return error as FederationError;
  }
  throw new Error("expected the operation to reject");
}

/** A port that is free right now; used where a registry must name the hub's own fixed port. */
function freePort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createNetServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address !== null && typeof address === "object" ? address.port : 0;
      server.close((error) => (error ? rejectPromise(error) : resolvePromise(port)));
    });
  });
}

interface FakePeer {
  base: string;
  posts: () => number;
  mcpPosts: () => number;
}

/**
 * A peer that answers `/config` and `/health` and **counts** writes. Refusals must not produce a
 * write request; counting is the only way to prove "no POST" rather than "the POST failed".
 */
async function fakePeer(
  config: Record<string, unknown>,
  options: { health?: Record<string, unknown> } = {},
): Promise<FakePeer> {
  let posts = 0;
  let mcpPosts = 0;
  const server = createHttpServer((req, res) => {
    const url = req.url ?? "/";
    if (req.method === "GET" && url === "/config") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(config));
      return;
    }
    if (req.method === "GET" && url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(options.health ?? { ok: true, version: "0.10.0" }));
      return;
    }
    if (url === "/mcp") {
      mcpPosts += 1;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "internal_error", message: "not implemented" } }));
      return;
    }
    if (req.method === "POST" && url === "/notes") {
      posts += 1;
      const note = createNote({
        id: "n-remote-created",
        now: NOW,
        type: "text",
        body: "remote create",
        anchor: { hook: "remote" },
        author: "agent",
        authorType: "agent",
        source: "agent",
        environment: "dev",
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ note }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "not_found", message: url } }));
  });
  extraServers.push(server);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;
  return { base: `http://127.0.0.1:${port}`, posts: () => posts, mcpPosts: () => mcpPosts };
}

/** A `/config` body for a 0.10 leaf; fields can be removed for the negative start-up cases. */
function peerConfig(overrides: Record<string, unknown> = {}): Json {
  return {
    name: "fake peer",
    version: "0.10.0",
    base: "/",
    auth: "none",
    readOnly: false,
    environment: "dev",
    app: "peer-app",
    federates: false,
    ...overrides,
  };
}

/* ------------------------------------------------------------------------------------------------
 * T21, T53, T82 — `/config` identity and federation flag
 * ---------------------------------------------------------------------------------------------- */

describe("combined hub /config (T21, T53, T82)", () => {
  it("reports app + federates:true and never a credential", async () => {
    process.env[TOKEN_ENV] = TOKEN_VALUE;
    const peer = await fakePeer(peerConfig());
    const registry = writeRegistry(
      [instance("staging", peer.base, { mode: "read", auth: { env: TOKEN_ENV } })],
      { includeSelf: true },
    );

    const server = await serve({ storePath: storePath(), registry, appName: "Review Pad" });
    const answered = await request(server.port, "GET", `${BASE}/config`);

    expect(answered.status).toBe(200);
    expect(answered.body["app"]).toBe("Review Pad");
    expect(answered.body["federates"]).toBe(true);
    expect(answered.text).not.toContain(TOKEN_VALUE);
    expect(answered.body).not.toHaveProperty("authSecret");
    expect(answered.body).not.toHaveProperty("tokenKey");
    expect(answered.body).not.toHaveProperty("registry");
  });

  it("keeps the default app without --app, and federates:false without a registry", async () => {
    const plain = await serve({ storePath: storePath() });
    const config = await request(plain.port, "GET", `${BASE}/config`);
    expect(config.body["app"]).toBe(HUB_APP_NAME);
    expect(config.body["federates"]).toBe(false);

    const peer = await fakePeer(peerConfig());
    const combined = await serve({
      storePath: storePath(),
      registry: writeRegistry([instance("dev", peer.base)]),
    });
    const combinedConfig = await request(combined.port, "GET", `${BASE}/config`);
    expect(combinedConfig.body["app"]).toBe(HUB_APP_NAME);
    expect(combinedConfig.body["federates"]).toBe(true);
  });
});

/* ------------------------------------------------------------------------------------------------
 * T22, T54 — `/notes` stays local
 * ---------------------------------------------------------------------------------------------- */

describe("combined hub /notes stays local (T22, T54)", () => {
  it("serves only the local store even when a registry is configured", async () => {
    const leaf = await serve({ storePath: storePath("leaf.json") });
    await addLocalNote(leaf, "remote note");

    const hub = await serve({
      storePath: storePath("hub.json"),
      registry: writeRegistry([instance("dev", baseOf(leaf))]),
    });
    await addLocalNote(hub, "hub note");

    const listed = await request(hub.port, "GET", `${BASE}/notes`);
    expect(listed.status).toBe(200);
    const notes = listed.body["notes"] as Json[];
    expect(notes.map((note) => note["body"])).toEqual(["hub note"]);
    expect(notes[0]).not.toHaveProperty("instance");
    expect(new Set(notes.map((note) => note["environment"]))).toEqual(new Set(["dev"]));
  });
});

/* ------------------------------------------------------------------------------------------------
 * T26, T56 — `/mcp` without a registry is unchanged
 * ---------------------------------------------------------------------------------------------- */

describe("MCP door without a registry (T26, T56)", () => {
  it("keeps the 0.8 store backend, 9 tools and the single-scope envelope", async () => {
    const server = await serve({ storePath: storePath() });
    await addLocalNote(server, "local note");

    const listed = await rpc(server, "tools/list");
    const tools = (listed.response["result"] as Json)["tools"] as Array<{ name: string }>;
    expect(tools).toHaveLength(9);
    expect(tools.map((entry) => entry.name)).not.toContain("list_instances");

    const result = await tool(server, "list_notes");
    const body = toolJson(result);
    expect(body).not.toHaveProperty("instances");
    expect(body).not.toHaveProperty("partial");
    expect(body["environment"]).toBe("dev");
    expect(body["count"]).toBe(1);
    expect((body["notes"] as Json[])[0]?.["body"]).toBe("local note");
  });
});

/* ------------------------------------------------------------------------------------------------
 * T29, T55, T57, T76 — aggregate and includeSelf
 * ---------------------------------------------------------------------------------------------- */

describe("MCP door with a registry aggregates self + peers (T29, T55, T57, T76)", () => {
  async function combined(
    options: { includeSelf?: boolean; defaults?: Record<string, unknown> } = {},
  ): Promise<{ hub: RunningServer; leaf: RunningServer }> {
    const leaf = await serve({ storePath: storePath("leaf.json") });
    await addLocalNote(leaf, "remote note");
    const hub = await serve({
      storePath: storePath("hub.json"),
      registry: writeRegistry([instance("dev", baseOf(leaf))], options.defaults),
      ...(options.includeSelf === undefined ? {} : { includeSelf: options.includeSelf }),
    });
    await addLocalNote(hub, "self note");
    return { hub, leaf };
  }

  it("lists 10 tools including list_instances", async () => {
    const { hub } = await combined();
    const listed = await rpc(hub, "tools/list");
    const tools = (listed.response["result"] as Json)["tools"] as Array<{ name: string }>;
    expect(tools).toHaveLength(10);
    expect(tools.map((entry) => entry.name)).toContain("list_instances");
  });

  it("aggregates self + remote with qualified ids by default", async () => {
    const { hub } = await combined();
    const body = toolJson(await tool(hub, "list_notes"));

    expect(body["partial"]).toBe(false);
    const notes = body["notes"] as Json[];
    expect(notes.map((note) => note["instance"]).sort()).toEqual(["dev", "self"]);
    expect(notes.map((note) => note["id"]).sort()).toEqual(
      expect.arrayContaining([expect.stringMatching(/^self\//u), expect.stringMatching(/^dev\//u)]),
    );

    const instances = toolJson<Json[]>(await tool(hub, "list_instances"));
    expect(instances.map((row) => row["id"]).sort()).toEqual(["dev", "self"]);
    expect(instances.find((row) => row["id"] === "self")?.["includeSelf"]).toBe(true);
  });

  it("excludes self when registry defaults say includeSelf:false, and --include-self overrides it", async () => {
    const excluded = await combined({ defaults: { includeSelf: false } });
    const excludedBody = toolJson(await tool(excluded.hub, "list_notes"));
    expect((excludedBody["notes"] as Json[]).map((note) => note["instance"])).toEqual(["dev"]);
    const excludedRows = toolJson(await tool(excluded.hub, "list_instances")) as Json[];
    expect(excludedRows.map((row) => row["id"])).not.toContain("self");

    // A second hub over the same leaf, where the CLI flag wins over the registry default.
    const includedHub = await serve({
      storePath: storePath("override.json"),
      registry: writeRegistry([instance("dev", baseOf(excluded.leaf))], { includeSelf: false }),
      includeSelf: true,
    });
    await addLocalNote(includedHub, "self note");
    const includedBody = toolJson(await tool(includedHub, "list_notes"));
    expect((includedBody["notes"] as Json[]).map((note) => note["instance"]).sort()).toEqual([
      "dev",
      "self",
    ]);
  });

  it("--no-self hides self and answers instance:self with self_unavailable (T76)", async () => {
    const { hub } = await combined({ includeSelf: false });

    const body = toolJson(await tool(hub, "list_notes"));
    expect((body["notes"] as Json[]).map((note) => note["instance"])).toEqual(["dev"]);

    const rows = toolJson<Json[]>(await tool(hub, "list_instances"));
    expect(rows.map((row) => row["id"])).not.toContain("self");

    const refused = await tool(hub, "list_notes", { instance: "self" });
    expect(refused["isError"]).toBe(true);
    expect(toolText(refused)).toContain("self_unavailable");
  });
});

/* ------------------------------------------------------------------------------------------------
 * T50, T93, T94 — the two write locks at the hub, with no POST on refusal
 * ---------------------------------------------------------------------------------------------- */

describe("hub write locks (T50, T93, T94)", () => {
  it("denies a mode:read instance even with --allow-write and sends no POST", async () => {
    const peer = await fakePeer(peerConfig());
    const hub = await serve({
      storePath: storePath(),
      registry: writeRegistry([instance("staging", peer.base, { mode: "read" })]),
      allowWrite: true,
    });

    const refused = await tool(hub, "create_note", {
      body: "must not land",
      selector: "#x",
      instance: "staging",
    });
    expect(refused["isError"]).toBe(true);
    expect(toolText(refused)).toContain("mode_denied");
    expect(peer.posts()).toBe(0);
  });

  it("denies mode:write without --allow-write and sends no POST (T94)", async () => {
    const peer = await fakePeer(peerConfig());
    const hub = await serve({
      storePath: storePath(),
      registry: writeRegistry([instance("staging", peer.base, { mode: "write" })]),
    });

    const refused = await tool(hub, "create_note", {
      body: "must not land",
      selector: "#x",
      instance: "staging",
    });
    expect(refused["isError"]).toBe(true);
    expect(toolText(refused)).toContain("mode_denied");
    expect(peer.posts()).toBe(0);
  });

  it("even self is read-only without --allow-write (T93)", async () => {
    const peer = await fakePeer(peerConfig());
    const hub = await serve({
      storePath: storePath(),
      registry: writeRegistry([instance("staging", peer.base)]),
    });

    const refused = await tool(hub, "create_note", {
      body: "must not land",
      selector: "#x",
      instance: "self",
    });
    expect(refused["isError"]).toBe(true);
    expect(toolText(refused)).toContain("mode_denied");
    expect(storedNoteCount(storePath())).toBe(0);
  });

  it("writes to a mode:write peer with --allow-write and qualifies the answer", async () => {
    const peer = await fakePeer(peerConfig());
    const hub = await serve({
      storePath: storePath(),
      registry: writeRegistry([instance("staging", peer.base, { mode: "write" })]),
      allowWrite: true,
    });

    const result = await tool(hub, "create_note", {
      body: "lands remotely",
      selector: "#x",
      instance: "staging",
    });
    expect(result["isError"]).toBeUndefined();
    expect(peer.posts()).toBe(1);
    expect(createdNoteId(result)).toBe("staging/n-remote-created");
  });

  it("writes to self with --allow-write", async () => {
    const peer = await fakePeer(peerConfig());
    const hub = await serve({
      storePath: storePath(),
      registry: writeRegistry([instance("staging", peer.base)]),
      allowWrite: true,
    });

    const result = await tool(hub, "create_note", {
      body: "lands locally",
      selector: "#x",
      instance: "self",
    });
    expect(result["isError"]).toBeUndefined();
    expect(createdNoteId(result)).toMatch(/^self\//u);
    expect(storedNoteCount(storePath())).toBe(1);
  });

  it("lets --read-only win over --allow-write and mode:write", async () => {
    const peer = await fakePeer(peerConfig());
    const hub = await serve({
      storePath: storePath(),
      registry: writeRegistry([instance("staging", peer.base, { mode: "write" })]),
      allowWrite: true,
      readOnly: true,
    });

    const refused = await tool(hub, "create_note", {
      body: "must not land",
      selector: "#x",
      instance: "staging",
    });
    expect(refused["isError"]).toBe(true);
    expect(toolText(refused)).toContain("read_only");
    expect(peer.posts()).toBe(0);
  });
});

/* ------------------------------------------------------------------------------------------------
 * T46, T47, T48, T49, T90 — start-up sequence
 * ---------------------------------------------------------------------------------------------- */

describe("start-up sequence (T46–T50, T90)", () => {
  it("refuses a nested federation (federates:true) with nested_federation (T46)", async () => {
    const peer = await fakePeer(peerConfig({ federates: true }));
    const error = await failureOf(
      startHub({
        storePath: storePath(),
        port: 0,
        quiet: true,
        registry: writeRegistry([instance("dev", peer.base)]),
      }),
    );
    expect(error.code).toBe("nested_federation");
  });

  it("refuses an identity mismatch (T48)", async () => {
    const peer = await fakePeer(peerConfig({ app: "actual-app" }));
    const error = await failureOf(
      startHub({
        storePath: storePath(),
        port: 0,
        quiet: true,
        registry: writeRegistry([instance("dev", peer.base, { app: "expected-app" })]),
      }),
    );
    expect(error.code).toBe("identity_mismatch");
  });

  it("accepts a missing app with unverified:true but refuses a missing federates (T49, T90)", async () => {
    const config = peerConfig();
    delete config["app"];
    const peer = await fakePeer(config);
    const hub = await serve({
      storePath: storePath(),
      registry: writeRegistry([instance("dev", peer.base)]),
    });
    const rows = toolJson<Json[]>(await tool(hub, "list_instances"));
    expect(rows[0]?.["ok"]).toBe(true);
    expect(rows[0]?.["unverified"]).toBe(true);
    // An accepted start is proven by the successful `list_instances` above.

    const missing = peerConfig();
    delete missing["federates"];
    const legacy = await fakePeer(missing);
    const error = await failureOf(
      startHub({
        storePath: storePath("legacy.json"),
        port: 0,
        quiet: true,
        registry: writeRegistry([instance("legacy", legacy.base)]),
      }),
    );
    expect(error.code).toBe("federates_missing");
    expect(error.message).not.toContain("unverified");
  });

  it("treats loopback aliases on the same port+path as one instance, and does not guess on wildcard binds", () => {
    expect(sameInstanceBase("http://127.0.0.1:8787/api", "http://localhost:8787/api")).toBe(true);
    expect(sameInstanceBase("http://[::1]:8787/api", "http://127.0.0.1:8787/api")).toBe(true);
    expect(sameInstanceBase("http://127.0.0.1:8787/api", "http://127.0.0.1:8788/api")).toBe(false);
    expect(sameInstanceBase("http://127.0.0.1:8787/api", "http://127.0.0.1:8787/other")).toBe(false);
    // A wildcard bind is a documented limitation (plan §12 open point 12): no guessing.
    expect(sameInstanceBase("http://127.0.0.1:8787/api", "http://0.0.0.0:8787/api")).toBe(false);
  });

  it("refuses a registry that points at the hub itself with self_reference (T47)", async () => {
    const port = await freePort();
    const registry = writeRegistry([
      instance("loop", `http://127.0.0.1:${port}${BASE}`),
    ]);
    const error = await failureOf(
      startHub({ storePath: storePath(), port, host: "127.0.0.1", quiet: true, registry }),
    );
    expect(error.code).toBe("self_reference");
  });

  it("refuses a reserved registry id and a missing credential before any request", async () => {
    const reserved = await failureOf(
      startHub({
        storePath: storePath(),
        port: 0,
        quiet: true,
        registry: writeRegistry([instance("self", "http://127.0.0.1:9")]),
      }),
    );
    expect(reserved.code).toBe("invalid_registry");

    const peer = await fakePeer(peerConfig());
    delete process.env[TOKEN_ENV];
    const missing = await failureOf(
      startHub({
        storePath: storePath("missing.json"),
        port: 0,
        quiet: true,
        registry: writeRegistry([instance("dev", peer.base, { auth: { env: TOKEN_ENV } })]),
      }),
    );
    expect(missing.code).toBe("missing_credential");
    expect(missing.message).not.toContain(TOKEN_VALUE);
  });

  it("passes --allow-insecure to registry validation, while link-local stays blocked", async () => {
    const privateRegistry = writeRegistry([instance("lab", "http://10.0.0.1:9")]);
    const denied = await failureOf(
      startHub({ storePath: storePath("private-a.json"), port: 0, quiet: true, registry: privateRegistry }),
    );
    expect(denied.code).toBe("invalid_base_url");

    // With the lab flag the private address is admitted; the peer is simply unreachable, which is
    // a degraded start rather than a policy failure.
    const allowed = await serve({
      storePath: storePath("private-b.json"),
      port: 0,
      registry: privateRegistry,
      allowInsecure: true,
      timeoutMs: 40,
    });
    const rows = toolJson<Json[]>(await tool(allowed, "list_instances"));
    expect(rows.find((row) => row["id"] === "lab")?.["ok"]).toBe(false);

    const linkLocal = await failureOf(
      startHub({
        storePath: storePath("link-local.json"),
        port: 0,
        quiet: true,
        allowInsecure: true,
        registry: writeRegistry([instance("metadata", "http://169.254.169.254")]),
      }),
    );
    expect(linkLocal.code).toBe("invalid_base_url");
  });

  it("maps an unusable base URL to invalid_base_url", async () => {
    const error = await failureOf(
      startHub({
        storePath: storePath(),
        port: 0,
        quiet: true,
        registry: writeRegistry([instance("bad", "file:///etc/passwd")]),
      }),
    );
    expect(error.code).toBe("invalid_base_url");
  });
});

/* ------------------------------------------------------------------------------------------------
 * T72 — degraded start for an unreachable peer
 * ---------------------------------------------------------------------------------------------- */

describe("degraded start (T72)", () => {
  it("keeps serving, reports ok:false and makes list_notes partial", async () => {
    const deadPort = await freePort();
    const hub = await serve({
      storePath: storePath(),
      registry: writeRegistry([instance("staging", `http://127.0.0.1:${deadPort}`)]),
    });
    await addLocalNote(hub, "self survives");

    const health = await request(hub.port, "GET", `${BASE}/health`);
    expect(health.status).toBe(200);
    expect(health.body["ok"]).toBe(true);

    const rows = toolJson<Json[]>(await tool(hub, "list_instances"));
    const staging = rows.find((row) => row["id"] === "staging");
    expect(staging?.["ok"]).toBe(false);
    // `list_instances` publishes the health status *and* the diagnostic code (F3); the aggregate
    // error envelope repeats it for the notes read.
    expect(staging?.["code"]).toBe("instance_unreachable");
    expect(staging).not.toHaveProperty("base");
    expect(staging).not.toHaveProperty("auth");

    const body = toolJson(await tool(hub, "list_notes"));
    expect(body["partial"]).toBe(true);
    expect((body["notes"] as Json[]).map((note) => note["body"])).toEqual(["self survives"]);
    expect((body["errors"] as Json[])[0]?.["code"]).toBe("instance_unreachable");
  });
});

/* ------------------------------------------------------------------------------------------------
 * Aggregat-Defaults: CLI > registry.defaults > constant (plan §6 step 2)
 * ---------------------------------------------------------------------------------------------- */

describe("aggregate defaults precedence", () => {
  it("uses registry defaults when the CLI did not name them", () => {
    const parsed = parseHubArgs(["--store", "notes.json", "--registry", "registry.json"]);
    if (typeof parsed === "string") throw new Error(parsed);
    expect(parsed.timeoutMs).toBeUndefined();
    expect(parsed.concurrency).toBeUndefined();
    expect(parsed.limit).toBeUndefined();
  });

  it("keeps CLI values when both are present", () => {
    const parsed = parseHubArgs([
      "--store",
      "notes.json",
      "--timeout",
      "500",
      "--concurrency",
      "2",
      "--limit",
      "7",
    ]);
    if (typeof parsed === "string") throw new Error(parsed);
    expect(parsed.timeoutMs).toBe(500);
    expect(parsed.concurrency).toBe(2);
    expect(parsed.limit).toBe(7);
  });

  it("clamps the aggregate to defaults.limit from the registry", async () => {
    const leaf = await serve({ storePath: storePath("leaf.json") });
    for (let index = 0; index < 3; index += 1) {
      await addLocalNote(leaf, `note ${index}`);
    }
    const hub = await serve({
      storePath: storePath("hub.json"),
      registry: writeRegistry([instance("dev", baseOf(leaf))], { limit: 1 }),
    });

    const body = toolJson(await tool(hub, "list_notes"));
    expect(body["truncated"]).toBe(true);
    expect((body["notes"] as Json[]).length).toBe(1);
  });
});
