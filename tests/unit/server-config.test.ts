/**
 * @vitest-environment node — opens a real socket, which jsdom cannot.
 *
 * `GET {base}/config` (FR-6.10): the hub describes itself **before any credential**, because a client
 * has to be able to learn *which* credential to bring — otherwise picking the wrong one is a `401`
 * that looks like a dead server. A status display reads the same answer to say whether the hub is
 * reachable on this machine only or from the network.
 *
 * Two halves are asserted here, because they can drift apart: the pure handler answer (name, version,
 * base, credential *kind*, read-only, environment) and the **live** binding of a running `node:http`
 * server — the address from the socket, not the `--host` flag. The one thing the answer must never
 * contain is the credential itself.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { request as nodeRequest } from "node:http";
import { hostname as osHostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BASE_PATH,
  SERVER_VERSION,
  handleRequest,
  isLoopbackAddress,
  type HandlerContext,
  type ServerRequest,
  type ServerResponse,
} from "../../server/handler";
import { DEFAULT_HOST, parseServerArgs, startServer } from "../../server/index";

const BASE = DEFAULT_BASE_PATH;

/** Kept as a constant: a literal after `authSecret:` trips the secret scan for the wrong reason. */
const SHARED = "hub-config-shared-value";

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
  tempDir = mkdtempSync(join(tmpdir(), "bp-hub-config-"));
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

function get(path: string): ServerResponse {
  const request: ServerRequest = {
    method: "GET",
    url: `${BASE}${path}`,
    headers: {},
    body: "",
  };
  return handleRequest(request, context({ bind: undefined }));
}

function configOf(overrides: Partial<HandlerContext> = {}): Json {
  const request: ServerRequest = { method: "GET", url: `${BASE}/config`, headers: {}, body: "" };
  return JSON.parse(handleRequest(request, context(overrides)).body) as Json;
}

function getJson(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Json }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = nodeRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
      });
      response.on("end", () =>
        resolvePromise({ status: response.statusCode ?? 0, body: JSON.parse(text) as Json }),
      );
    });
    request.on("error", rejectPromise);
    request.end();
  });
}

describe("GET {base}/config — the answer itself", () => {
  it("carries no credential and says which one it asks for", () => {
    const bare = configOf();
    expect(bare["auth"]).toBe("none");

    // The kind is reported, the value never is — that is the whole point of the route.
    const withSecret = JSON.stringify(configOf({ authSecret: SHARED }));
    expect(configOf({ authSecret: SHARED })["auth"]).toBe("secret");
    expect(withSecret).not.toContain(SHARED);

    expect(configOf({ verifyToken: () => ({ ok: false, reason: "expired" }) })["auth"]).toBe("token");
  });

  it("reports name, version, base, environment and read-only", () => {
    const body = configOf({ hubName: "Unraid", readOnly: true, environment: "staging" });
    expect(body["name"]).toBe("Unraid");
    expect(body["version"]).toBe(SERVER_VERSION);
    expect(body["base"]).toBe(BASE);
    expect(body["readOnly"]).toBe(true);
    expect(body["environment"]).toBe("staging");
  });

  it("leaves the binding unknown rather than guessing it", () => {
    expect(configOf()["bind"]).toBe(null);
  });

  it("calls a loopback binding this machine only, and 0.0.0.0 the opposite", () => {
    const loopback = configOf({ bind: { host: "127.0.0.1", port: 8787 } })["bind"] as Json;
    expect(loopback).toEqual({ host: "127.0.0.1", port: 8787, loopbackOnly: true });

    const network = configOf({ bind: { host: "0.0.0.0", port: 8787 } })["bind"] as Json;
    expect(network["loopbackOnly"]).toBe(false);

    // `--host localhost` may bind the IPv6 side, and a v4 socket can report a mapped address.
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.10")).toBe(false);
    expect(isLoopbackAddress("::")).toBe(false);
  });

  it("answers a wrong method with 405 and names the one it documents", () => {
    const request: ServerRequest = {
      method: "POST",
      url: `${BASE}/config`,
      headers: { "content-type": "application/json" },
      body: "{}",
    };
    const response = handleRequest(request, context());
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe("GET");
  });

  it("is not reachable outside the base (a foreign path stays 404)", () => {
    const request: ServerRequest = { method: "GET", url: "/config", headers: {}, body: "" };
    expect(handleRequest(request, context()).status).toBe(404);
    expect(get("/notes").status).toBe(200);
  });
});

describe("GET {base}/config — against a running hub", () => {
  it("reports the binding the socket actually has, not the one that was asked for", async () => {
    const server = await startServer({
      storePath: tempStorePath(),
      port: 0,
      host: DEFAULT_HOST,
      name: "Test-Hub",
      quiet: true,
    });
    servers.push(server);

    const answer = await getJson(server.port, `${BASE}/config`);
    expect(answer.status).toBe(200);
    expect(answer.body["name"]).toBe("Test-Hub");
    expect(answer.body["auth"]).toBe("none");
    expect(answer.body["bind"]).toEqual({
      host: DEFAULT_HOST,
      port: server.port,
      loopbackOnly: true,
    });
  });

  it("needs no credential itself while the notes stay closed", async () => {
    const server = await startServer({
      storePath: tempStorePath(),
      port: 0,
      host: DEFAULT_HOST,
      authSecret: SHARED,
      quiet: true,
    });
    servers.push(server);

    const open = await getJson(server.port, `${BASE}/config`);
    expect(open.status).toBe(200);
    expect(open.body["auth"]).toBe("secret");

    // The one door that is open is the one that names the credential; everything else is gated.
    const gated = await getJson(server.port, `${BASE}/notes`);
    expect(gated.status).toBe(401);
    expect((gated.body["error"] as Json)["code"]).toBe("unauthorized");
  });

  it("falls back to the machine's hostname when --name is absent", async () => {
    const server = await startServer({
      storePath: tempStorePath(),
      port: 0,
      host: DEFAULT_HOST,
      quiet: true,
    });
    servers.push(server);

    const answer = await getJson(server.port, `${BASE}/config`);
    expect(answer.body["name"]).toBe(osHostname());
  });
});

describe("--name", () => {
  it("parses the flag and rejects an empty value", () => {
    const parsed = parseServerArgs(["--store", "notes.json", "--name", "Unraid"]);
    expect(typeof parsed).not.toBe("string");
    expect((parsed as { name?: string }).name).toBe("Unraid");

    const empty = parseServerArgs(["--store", "notes.json", "--name", "   "]);
    expect(String(empty)).toContain("--name must not be empty");

    // Absent means "use the hostname", not "empty entry in a picker".
    const absent = parseServerArgs(["--store", "notes.json"]);
    expect((absent as { name?: string }).name).toBeUndefined();
  });
});
