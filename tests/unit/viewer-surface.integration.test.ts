/**
 * @vitest-environment node — this suite binds real listeners and talks to them over `node:http`;
 * jsdom cannot do either.
 *
 * Task 14 of the viewer-origin plan (issue #140): the surface, CORS, host-gate and `--root`
 * integration — IT-02, IT-09, IT-10, IT-11, IT-19, IT-20, IT-21, IT-22, IT-28, IT-33 and the
 * regression legs RT-03…RT-06.
 *
 * What is asserted here is the *wiring*, not the pure functions (those live in
 * `viewer-surface.test.ts` and `viewer-cors.test.ts`):
 *
 *   - the hub listener answers every viewer content route with `404 not_found` — with and without
 *     `--root`, and regardless of a valid viewer session;
 *   - the viewer listener answers admin/MCP/journal/config/launcher and every `--root` path with
 *     `404`, while the same `--root` keeps serving `other.html` and its `index.html` fallback on
 *     the hub;
 *   - the viewer origin is fail-closed without a client credential (AC-5.10) but the hub stays
 *     open; a viewer session never authorizes a hub request (AC-5.11);
 *   - the bookmarklet preflight/reflection shape of AC-5.21, including the negative `405`s and the
 *     rule that no viewer `OPTIONS` is ever a `401`;
 *   - `cors_viewer_origin` is reachable through both the CLI parser and (post-`listen()`)
 *     `startHub()`; `viewer_origin_conflict` is a parse refusal and the deprecated alias still
 *     warns on stderr;
 *   - the host gate trusts loopback names and the configured viewer alias only, while a
 *     non-loopback bind is ungated (injected, never a real non-loopback socket);
 *   - `X-Forwarded-Proto` is trusted from a loopback peer only, and an explicit origin wins;
 *   - the hub's existing routes and its `--cors` vocabulary are unchanged.
 *
 * Hermetic: no request escapes the loopback listeners, and the two non-loopback cases are pure
 * function calls with an injected `bind`/`remote` — never a real non-loopback bind.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as nodeRequest, type IncomingHttpHeaders } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_BASE_PATH,
  hostRefusal,
  type HandlerContext,
  type ServerRequest,
} from "../../server/handler";
import { corsHeaders, preflightResponse } from "../../server/cors";
import {
  HubStartupError,
  parseHubArgs,
  startHub,
  type HubOptions,
  type RunningServer,
} from "../../server/hub";
import {
  createViewerSessions,
  publicOrigin,
  viewerSessionRefusalMessage,
  type ViewerOptions,
} from "../../server/viewer";

/** `{base}` in the ACs. */
const BASE = DEFAULT_BASE_PATH;
/** Operator credential for the admin surface and the viewer launcher. */
const OPERATOR = "viewer-surface-operator-secret";
/** Client credential for the hub, used only where the AC configures one. */
const AUTH = "viewer-surface-shared-secret";
/** The bookmarklet's calling origin. */
const ORIGIN = "https://app.example";
/** A valid create body — the model's anchor rules are shared, not re-implemented here. */
const NOTE_BODY = JSON.stringify({
  type: "bug",
  body: "the cart badge is off by one",
  anchor: { selector: "#cart" },
});
/** The four viewer content routes, relative to `{base}` (AC-5.2 / AC-5.29). */
const VIEWER_CONTENT_ROUTES = [
  "/viewer",
  "/view",
  "/viewer/assets/bluepencil.element.min.js",
  "/viewer/bookmarklet.txt",
] as const;

interface Answer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
}

interface RequestInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

const servers: RunningServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A `dist`-shaped directory: the parser and the assets route only need the bundle to exist. */
function assetsDir(): string {
  const dir = tempDir("bp-surface-assets-");
  writeFileSync(join(dir, "bluepencil.element.min.js"), "/* stub */\n");
  return dir;
}

/** A store path in its own directory, so starts cannot share a journal location. */
function storePath(): string {
  return join(tempDir("bp-surface-store-"), "notes.bluepencil.json");
}

/** The viewer half of `HubOptions`, on an ephemeral loopback port by default. */
function viewerConfig(
  overrides: Partial<NonNullable<HubOptions["viewer"]>> = {},
): NonNullable<HubOptions["viewer"]> {
  return {
    host: "127.0.0.1",
    port: 0,
    assetsDir: assetsDir(),
    allow: ["example.com"],
    ttlSeconds: 3_600,
    ...overrides,
  };
}

/** Starts a tracked hub; `afterEach` guarantees no leaked listener. */
async function serve(overrides: Partial<HubOptions> = {}): Promise<RunningServer> {
  const server = await startHub({
    storePath: storePath(),
    port: 0,
    host: "127.0.0.1",
    base: BASE,
    quiet: true,
    journal: "none",
    ...overrides,
  });
  servers.push(server);
  return server;
}

function viewerOf(server: RunningServer): NonNullable<RunningServer["viewer"]> {
  if (server.viewer === undefined) throw new Error("expected a viewer listener");
  return server.viewer;
}

function hubOriginOf(server: RunningServer): string {
  return new URL(server.url).origin;
}

/** One HTTP round trip against a real listener; no client-side cookie jar on purpose. */
function request(port: number, path: string, init: RequestInit = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.body !== undefined) {
      headers["content-type"] ??= "application/json";
      headers["content-length"] = String(Buffer.byteLength(init.body));
    }
    const req = nodeRequest(
      { host: "127.0.0.1", port, path, method: init.method ?? "GET", headers },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text });
        });
      },
    );
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

function errorOf(answer: Answer): { code?: string; message?: string } {
  try {
    const payload = JSON.parse(answer.text) as { error?: { code?: string; message?: string } };
    return payload.error ?? {};
  } catch {
    return {};
  }
}

function headerOf(answer: Answer, name: string): string | undefined {
  const value = answer.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function setCookie(answer: Answer): string | undefined {
  const raw = answer.headers["set-cookie"];
  if (raw === undefined) return undefined;
  return (Array.isArray(raw) ? raw : [raw]).find((value) =>
    value.startsWith("bp_viewer="),
  );
}

function cookieToken(answer: Answer): string {
  const cookie = setCookie(answer);
  expect(cookie, "the answer must set the viewer session cookie").toBeDefined();
  return String(cookie).split(";")[0]!.slice("bp_viewer=".length);
}

function cookiePair(token: string): string {
  return `bp_viewer=${token}`;
}

/** Drives the hub-side launcher and returns the minted one-time ticket. */
async function launcherTicket(server: RunningServer): Promise<string> {
  const answer = await request(server.port, `${BASE}/viewer/start`, {
    headers: { "x-bluepencil-admin": OPERATOR },
  });
  expect(answer.status).toBe(302);
  const ticket = new URL(String(answer.headers.location)).searchParams.get("ticket") ?? "";
  expect(ticket).toMatch(/^[0-9a-f]{48}$/);
  return ticket;
}

/** Redeems a ticket on the real viewer listener and returns the session token. */
async function sessionToken(server: RunningServer): Promise<string> {
  const answer = await request(
    viewerOf(server).port,
    `${BASE}/viewer?ticket=${await launcherTicket(server)}`,
  );
  expect(answer.status).toBe(302);
  return cookieToken(answer);
}

/** The refusal message the running instance must produce (computed, not copied). */
function expectedRefusal(server: RunningServer): string {
  return viewerSessionRefusalMessage({
    base: BASE,
    viewer: { hubOrigin: hubOriginOf(server) },
  } as unknown as HandlerContext);
}

/** A port that was free a moment ago; used where a fixed port is part of the contract. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const address = probe.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Resolves only when a connection to `port` is refused — i.e. nothing is listening there. */
function expectRefused(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`port ${port} did not answer within 2s`));
    }, 2_000);
    timer.unref();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`port ${port} is still listening`));
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
  });
}

/** The CORS-relevant headers of one answer, so a full-object comparison stays readable. */
function corsHeadersOf(answer: Answer): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(answer.headers)) {
    if (value === undefined) continue;
    const plain = Array.isArray(value) ? value.join(", ") : String(value);
    if (key.startsWith("access-control-") || key === "vary") result[key] = plain;
  }
  return result;
}

function expectNotFound(answer: Answer, label: string): void {
  expect(answer.status, `${label}: status`).toBe(404);
  expect(errorOf(answer).code, `${label}: error code`).toBe("not_found");
  expect(answer.headers["set-cookie"], `${label}: no cookie`).toBeUndefined();
}

/* ------------------------------------------------------------------------------------------------
 * IT-02 — the hub never serves a viewer content route (AC-5.2)
 * ---------------------------------------------------------------------------------------------- */

describe("IT-02 — hub surface 404s every viewer content route (AC-5.2)", () => {
  it("answers all four viewer routes without auth and without --root", async () => {
    const server = await serve({ viewer: viewerConfig(), adminSecret: OPERATOR });

    for (const route of VIEWER_CONTENT_ROUTES) {
      const answer = await request(server.port, `${BASE}${route}`);
      expectNotFound(answer, `hub GET ${BASE}${route}`);
      expect(answer.text, "no injected layer marker").not.toContain("<bluepencil-notes");
      expect(answer.text, "no target HTML").not.toContain("<!doctype html");
    }
  });
});

/* ------------------------------------------------------------------------------------------------
 * IT-09 — the viewer never serves the operator/API/static surface (AC-5.9)
 * ---------------------------------------------------------------------------------------------- */

describe("IT-09 — viewer surface 404s admin, MCP, journal, config, launcher and --root (AC-5.9)", () => {
  it("refuses every non-viewer route even with a valid session and a configured --root", async () => {
    const root = tempDir("bp-surface-root-");
    writeFileSync(join(root, "index.html"), "<title>operator index</title>\n");
    writeFileSync(join(root, "other.html"), "<title>other page</title>\n");

    const server = await serve({
      viewer: viewerConfig(),
      adminSecret: OPERATOR,
      root,
    });
    const port = viewerOf(server).port;
    const cookie = cookiePair(await sessionToken(server));

    const getPaths = ["/admin", "/admin/status", "/config", "/journal", "/viewer/start"];
    for (const path of getPaths) {
      const answer = await request(port, `${BASE}${path}`, { headers: { cookie } });
      expectNotFound(answer, `viewer GET ${BASE}${path}`);
      expect(answer.text).not.toContain(OPERATOR);
      expect(answer.text).not.toContain("<title>operator index</title>");
      expect(answer.text).not.toContain("<bluepencil-notes");
    }

    const mcp = await request(port, `${BASE}/mcp`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expectNotFound(mcp, "viewer POST /mcp");
    expect(mcp.text).not.toContain(OPERATOR);

    // AC-L20 names GET **and** POST for the launcher path on the viewer surface.
    const launcherPost = await request(port, `${BASE}/viewer/start`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        "x-bluepencil-admin": OPERATOR,
      },
      body: `secret=${OPERATOR}`,
    });
    expectNotFound(launcherPost, "viewer POST /viewer/start");
    expect(launcherPost.text).not.toContain(OPERATOR);
    expect(launcherPost.headers["location"]).toBeUndefined();

    // A `--root` file lives outside `{base}`, so the viewer refusal catches it structurally.
    const staticFile = await request(port, "/other.html", { headers: { cookie } });
    expectNotFound(staticFile, "viewer GET /other.html");
    expect(staticFile.text).not.toContain("<title>other page</title>");
  });
});

/* ------------------------------------------------------------------------------------------------
 * IT-10 — fail-closed without a client credential; the hub stays open (AC-5.10)
 * ---------------------------------------------------------------------------------------------- */

describe("IT-10 — viewer is fail-closed without --auth-secret (AC-5.10)", () => {
  it("refuses an anonymous POST, accepts one with a session, and leaves the hub open", async () => {
    const server = await serve({ viewer: viewerConfig(), adminSecret: OPERATOR });
    const port = viewerOf(server).port;

    const refused = await request(port, `${BASE}/notes`, { body: NOTE_BODY });
    expect(refused.status).toBe(401);
    expect(errorOf(refused).code).toBe("unauthorized");
    expect(errorOf(refused).message).toBe(expectedRefusal(server));
    expect(refused.headers["set-cookie"]).toBeUndefined();

    // No store write happened: the (open) hub still sees an empty set.
    const hubRead = await request(server.port, `${BASE}/notes`);
    expect(hubRead.status).toBe(200);
    expect((JSON.parse(hubRead.text) as { notes: unknown[] }).notes).toHaveLength(0);

    const cookie = cookiePair(await sessionToken(server));
    const created = await request(port, `${BASE}/notes`, {
      method: "POST",
      headers: { cookie },
      body: NOTE_BODY,
    });
    expect(created.status).toBe(200);
    const noteId = (JSON.parse(created.text) as { note: { id: string } }).note.id;
    expect(noteId).toMatch(/[0-9a-f-]{8,}/);

    const hubAfter = await request(server.port, `${BASE}/notes`);
    expect(hubAfter.status).toBe(200);
    const notes = (JSON.parse(hubAfter.text) as { notes: Array<{ id: string }> }).notes;
    expect(notes.map((note) => note.id)).toEqual([noteId]);
  });
});

/* ------------------------------------------------------------------------------------------------
 * IT-11 — a viewer session is scoped to the viewer surface (AC-5.11)
 * ---------------------------------------------------------------------------------------------- */

describe("IT-11 — a viewer session opens nothing on the hub (AC-5.11)", () => {
  it("refuses the cookie and the header on hub /notes, accepts both on the viewer", async () => {
    const server = await serve({
      viewer: viewerConfig(),
      adminSecret: OPERATOR,
      authSecret: AUTH,
    });
    const token = await sessionToken(server);
    const viewerPort = viewerOf(server).port;

    const hubCookie = await request(server.port, `${BASE}/notes`, {
      headers: { cookie: cookiePair(token) },
    });
    expect(hubCookie.status).toBe(401);
    expect(errorOf(hubCookie).code).toBe("unauthorized");

    const hubHeader = await request(server.port, `${BASE}/notes`, {
      headers: { "x-bluepencil-viewer": token },
    });
    expect(hubHeader.status).toBe(401);
    expect(errorOf(hubHeader).code).toBe("unauthorized");

    const viewerCookie = await request(viewerPort, `${BASE}/notes`, {
      headers: { cookie: cookiePair(token) },
    });
    expect(viewerCookie.status).toBe(200);

    const viewerHeader = await request(viewerPort, `${BASE}/notes`, {
      headers: { "x-bluepencil-viewer": token },
    });
    expect(viewerHeader.status).toBe(200);
  });
});

/* ------------------------------------------------------------------------------------------------
 * IT-19 — bookmarklet CORS on the viewer surface (AC-5.21)
 * ---------------------------------------------------------------------------------------------- */

describe("IT-19 — bookmarklet CORS, preflights and reflected origins (AC-5.21)", () => {
  it("answers a valid preflight with exactly the documented metadata", async () => {
    const server = await serve({ viewer: viewerConfig(), adminSecret: OPERATOR });
    const port = viewerOf(server).port;

    const answer = await request(port, `${BASE}/notes`, {
      method: "OPTIONS",
      headers: {
        origin: ORIGIN,
        "access-control-request-headers": "content-type, x-bluepencil-viewer",
      },
    });

    expect(answer.status).toBe(204);
    expect(headerOf(answer, "access-control-allow-origin")).toBe(ORIGIN);
    expect(headerOf(answer, "access-control-allow-methods")).toBe("GET, POST, PATCH, OPTIONS");
    const allowHeaders = (headerOf(answer, "access-control-allow-headers") ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase());
    expect(allowHeaders).toContain("content-type");
    expect(allowHeaders).toContain("x-bluepencil-viewer");
    expect(headerOf(answer, "access-control-max-age")).toBe("600");
    expect(headerOf(answer, "vary")).toBe("Origin");
    expect(headerOf(answer, "access-control-allow-credentials")).toBeUndefined();
  });

  it("answers every negative preflight 405 with Allow and never 401", async () => {
    const server = await serve({ viewer: viewerConfig(), adminSecret: OPERATOR });
    const port = viewerOf(server).port;
    const preflightHeaders = {
      origin: ORIGIN,
      "access-control-request-headers": "content-type, x-bluepencil-viewer",
    };

    const cases: ReadonlyArray<{ label: string; path: string; headers: Record<string, string>; allow: string }> = [
      {
        label: "notes without requested header",
        path: `${BASE}/notes`,
        headers: { origin: ORIGIN },
        allow: "GET, POST",
      },
      {
        label: "notes without origin",
        path: `${BASE}/notes`,
        headers: { "access-control-request-headers": "x-bluepencil-viewer" },
        allow: "GET, POST",
      },
      {
        label: "notes with an invalid origin",
        path: `${BASE}/notes`,
        headers: { ...preflightHeaders, origin: "not-an-origin" },
        allow: "GET, POST",
      },
      {
        label: "notes/{id} without requested header",
        path: `${BASE}/notes/n1`,
        headers: { origin: ORIGIN },
        allow: "GET, PATCH",
      },
      { label: "bundle", path: `${BASE}/bundle`, headers: preflightHeaders, allow: "GET" },
      { label: "sessions", path: `${BASE}/sessions`, headers: preflightHeaders, allow: "GET" },
      { label: "health", path: `${BASE}/health`, headers: preflightHeaders, allow: "GET, HEAD" },
    ];

    for (const testCase of cases) {
      const answer = await request(port, testCase.path, {
        method: "OPTIONS",
        headers: testCase.headers,
      });
      expect(answer.status, `${testCase.label}: status`).not.toBe(401);
      expect(answer.status, `${testCase.label}: status`).toBe(405);
      expect(errorOf(answer).code, `${testCase.label}: code`).toBe("method_not_allowed");
      expect(headerOf(answer, "allow"), `${testCase.label}: Allow`).toBe(testCase.allow);
      expect(headerOf(answer, "access-control-allow-origin"), `${testCase.label}: no CORS`).toBeUndefined();
      expect(answer.headers["set-cookie"], `${testCase.label}: no cookie`).toBeUndefined();
    }
  });

  it("reflects the same origin on success and on every notes error", async () => {
    const server = await serve({ viewer: viewerConfig(), adminSecret: OPERATOR });
    const port = viewerOf(server).port;
    const token = await sessionToken(server);
    const authorized = { origin: ORIGIN, "x-bluepencil-viewer": token };

    const reflected = (answer: Answer, label: string): void => {
      expect(headerOf(answer, "access-control-allow-origin"), label).toBe(ORIGIN);
      expect(headerOf(answer, "vary"), label).toBe("Origin");
      expect(headerOf(answer, "access-control-allow-credentials"), label).toBeUndefined();
    };

    const list = await request(port, `${BASE}/notes`, { headers: authorized });
    expect(list.status).toBe(200);
    reflected(list, "GET /notes 200");

    const invalidQuery = await request(port, `${BASE}/notes?intent=falsch`, { headers: authorized });
    expect(invalidQuery.status).toBe(400);
    expect(errorOf(invalidQuery).code).toBe("invalid_query");
    reflected(invalidQuery, "GET /notes 400 invalid_query");

    const invalidPayload = await request(port, `${BASE}/notes`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ route: "/cart" }),
    });
    expect(invalidPayload.status).toBe(400);
    expect(errorOf(invalidPayload).code).toBe("invalid_payload");
    reflected(invalidPayload, "POST /notes 400 invalid_payload");

    const created = await request(port, `${BASE}/notes`, {
      method: "POST",
      headers: authorized,
      body: NOTE_BODY,
    });
    expect(created.status).toBe(200);
    reflected(created, "POST /notes 200");

    const refused = await request(port, `${BASE}/notes`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-bluepencil-viewer": "deadbeef" },
      body: NOTE_BODY,
    });
    expect(refused.status).toBe(401);
    expect(errorOf(refused).code).toBe("unauthorized");
    reflected(refused, "POST /notes 401");

    // Only `{base}/notes*` reflects: nothing else on the viewer surface carries the origin.
    for (const path of [`${BASE}/bundle`, `${BASE}/sessions`, `${BASE}/health`]) {
      const answer = await request(port, path, { headers: authorized });
      expect(
        headerOf(answer, "access-control-allow-origin"),
        `${path} must not reflect an origin`,
      ).toBeUndefined();
    }
  });
});

/* ------------------------------------------------------------------------------------------------
 * IT-20 — cors_viewer_origin through the CLI and start paths (AC-5.22)
 * ---------------------------------------------------------------------------------------------- */

/** Complete CLI viewer arguments; `extra` overrides the origin pair. */
function cliViewerArgs(extra: string[]): string[] {
  return [
    "--store",
    storePath(),
    "--quiet",
    "--viewer",
    "--viewer-port",
    "0",
    "--viewer-assets",
    assetsDir(),
    "--viewer-allow",
    "example.com",
    "--admin-secret",
    OPERATOR,
    ...extra,
  ];
}

describe("IT-20 — cors_viewer_origin over the start path (AC-5.22)", () => {
  it("is a CLI usage error when --cors names the explicit viewer origin", () => {
    const parsed = parseHubArgs(
      cliViewerArgs([
        "--viewer-origin",
        "https://view.example.com",
        "--cors",
        "https://view.example.com",
      ]),
    );
    expect(parsed).toBe("--cors must not name the viewer origin (cors_viewer_origin)");
  });

  it("accepts --viewer-port 0 without an explicit origin at parse time", () => {
    const parsed = parseHubArgs(cliViewerArgs(["--cors", "https://view.example.com"]));
    expect(typeof parsed).not.toBe("string");
    expect((parsed as HubOptions).viewer?.origin).toBeUndefined();
  });

  it("refuses at start time when the resolved viewer origin equals --cors, and closes the hub", async () => {
    const hubPort = await freePort();
    const options: HubOptions = {
      storePath: storePath(),
      port: hubPort,
      viewer: viewerConfig({ port: 0, origin: "https://view.example.com" }),
      cors: "https://view.example.com",
    };

    let started: RunningServer | undefined;
    let failure: unknown;
    try {
      started = await startHub({ ...options, quiet: true });
    } catch (error) {
      failure = error;
    }
    if (started !== undefined) {
      await started.close();
      throw new Error("expected startHub() to refuse cors_viewer_origin, but it started");
    }
    expect(failure).toBeInstanceOf(HubStartupError);
    expect((failure as HubStartupError).code).toBe("cors_viewer_origin");

    // Both listeners were closed: the fixed hub port is free again.
    await expectRefused(hubPort);
    const restarted = await serve({ port: hubPort });
    expect(restarted.port).toBe(hubPort);
  });
});

/* ------------------------------------------------------------------------------------------------
 * IT-21 — the host gate on the viewer surface (AC-5.23)
 * ---------------------------------------------------------------------------------------------- */

describe("IT-21 — the host gate on the viewer surface (AC-5.23)", () => {
  it("accepts loopback names and the viewer alias and refuses a foreign Host", async () => {
    const server = await serve({
      viewer: viewerConfig({ origin: "https://view.example.com" }),
    });
    const port = viewerOf(server).port;

    const foreign = await request(port, `${BASE}/health`, { headers: { host: "evil.example" } });
    expect(foreign.status).toBe(403);
    expect(errorOf(foreign).code).toBe("host_not_allowed");

    const alias = await request(port, `${BASE}/health`, {
      headers: { host: "view.example.com:8788" },
    });
    expect(alias.status).toBe(200);

    const localhost = await request(port, `${BASE}/health`, {
      headers: { host: `localhost:${port}` },
    });
    expect(localhost.status).toBe(200);

    const hub = await request(server.port, `${BASE}/health`, {
      headers: { host: `localhost:${server.port}` },
    });
    expect(hub.status).toBe(200);
  });

  it("does not gate a non-loopback bind (injected bind, never a real socket)", () => {
    const context: HandlerContext = {
      store: { notes: [] },
      base: BASE,
      environment: "dev",
      bind: { host: "192.0.2.10", port: 8788 },
    };
    expect(hostRefusal({ headers: { host: "evil.example" } }, context)).toBeNull();
  });
});

/* ------------------------------------------------------------------------------------------------
 * IT-22 — X-Forwarded-Proto and the explicit origin (AC-5.24)
 * ---------------------------------------------------------------------------------------------- */

describe("IT-22 — derived origin stays http; XFP only while the origin is unset (AC-5.24)", () => {
  it("trusts XFP https from a loopback peer only while the origin is unset, ignores it from a remote peer and lets an explicit origin win", () => {
    const viewer: ViewerOptions = {
      assetsDir: "",
      allow: [],
      ttlSeconds: 60,
      sessions: createViewerSessions(60),
    };
    const base: ServerRequest = {
      method: "GET",
      url: `${BASE}/viewer`,
      headers: { host: "viewer.internal:8788", "x-forwarded-proto": "https" },
      remote: "127.0.0.1",
    };

    // A loopback reverse proxy terminates TLS: the derived origin becomes https.
    expect(publicOrigin(base, viewer)).toBe("https://viewer.internal:8788");
    // The same header from a remote peer is not trusted — it cannot forge `Secure` or https links.
    expect(publicOrigin({ ...base, remote: "192.0.2.10" }, viewer)).toBe(
      "http://viewer.internal:8788",
    );
    // An explicit origin is authoritative regardless of what the proxy claims.
    expect(
      publicOrigin(
        { ...base, headers: { ...base.headers, "x-forwarded-proto": "http" }, remote: "192.0.2.10" },
        { ...viewer, origin: "https://view.example.com" },
      ),
    ).toBe("https://view.example.com");
  });

  it("derives a plain http origin when none is configured (documented A3)", async () => {
    const server = await serve({ viewer: viewerConfig(), adminSecret: OPERATOR });
    const port = viewerOf(server).port;

    const redeemed = await request(
      port,
      `${BASE}/viewer?ticket=${await launcherTicket(server)}`,
      { headers: { "x-forwarded-proto": "https" } },
    );
    expect(redeemed.status).toBe(302);
    // `startHub()` resolves the derived origin before the first request (§2.4 rule 6), so the
    // publicOrigin/XFP branch is not consulted for a listener that already knows its origin.
    expect(String(setCookie(redeemed))).not.toContain("; Secure");

    const shell = await request(port, `${BASE}/viewer`, {
      headers: { cookie: cookiePair(cookieToken(redeemed)), "x-forwarded-proto": "https" },
    });
    expect(shell.status).toBe(200);
    expect(shell.text).toContain(`http://127.0.0.1:${port}`);
    expect(shell.text).not.toContain(`https://127.0.0.1:${port}`);
  });

  it("lets an explicit origin win over X-Forwarded-Proto on the wire", async () => {
    const server = await serve({
      viewer: viewerConfig({ origin: "https://view.example.com" }),
      adminSecret: OPERATOR,
    });
    const port = viewerOf(server).port;

    const redeemed = await request(
      port,
      `${BASE}/viewer?ticket=${await launcherTicket(server)}`,
      { headers: { "x-forwarded-proto": "http" } },
    );
    expect(redeemed.status).toBe(302);
    expect(String(setCookie(redeemed))).toContain("; Secure");

    const shell = await request(port, `${BASE}/viewer`, {
      headers: { cookie: cookiePair(cookieToken(redeemed)), "x-forwarded-proto": "http" },
    });
    expect(shell.status).toBe(200);
    expect(shell.text).toContain("https://view.example.com");
  });
});

/* ------------------------------------------------------------------------------------------------
 * IT-28 — viewer_origin_conflict and the deprecated alias (AC-F8)
 * ---------------------------------------------------------------------------------------------- */

describe("IT-28 — viewer_origin_conflict and the alias warning (AC-F8)", () => {
  it("refuses disagreeing --viewer-origin and --viewer-public-url via the CLI path", () => {
    const parsed = parseHubArgs(
      cliViewerArgs([
        "--viewer-origin",
        "https://view.example.com",
        "--viewer-public-url",
        "https://other.example.com",
      ]),
    );
    expect(parsed).toBe(
      "--viewer-origin and --viewer-public-url disagree (viewer_origin_conflict)",
    );
  });

  it("starts the alias spelling and warns on stderr despite --quiet", async () => {
    const parsed = parseHubArgs(
      cliViewerArgs(["--viewer-public-url", "https://view.example.com"]),
    );
    expect(typeof parsed).not.toBe("string");

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // `parseHubArgs` always fills `port` with the documented default; a test wants an ephemeral one.
    const server = await serve({ ...(parsed as HubOptions), port: 0 });
    const written = stderr.mock.calls.map((call) => String(call[0])).join("");

    expect(written).toContain("viewer_public_url_deprecated");
    expect(written).toContain("will be removed in the next release");
    expect(viewerOf(server).origin).toBe("https://view.example.com");
    stderr.mockRestore();
  });
});

/* ------------------------------------------------------------------------------------------------
 * IT-33 — --root: viewer paths dark, static site alive (AC-5.29)
 * ---------------------------------------------------------------------------------------------- */

function rootDir(): string {
  const root = tempDir("bp-surface-root-");
  writeFileSync(join(root, "index.html"), "<title>operator index</title>\n");
  writeFileSync(join(root, "other.html"), "<title>other page</title>\n");
  return root;
}

describe("IT-33 — --root keeps every viewer path 404 (AC-5.29)", () => {
  it("refuses the four prefixed and the four unprefixed viewer paths, never the index", async () => {
    const server = await serve({ viewer: viewerConfig(), adminSecret: OPERATOR, root: rootDir() });

    for (const route of VIEWER_CONTENT_ROUTES) {
      const prefixed = await request(server.port, `${BASE}${route}`);
      expectNotFound(prefixed, `hub GET ${BASE}${route}`);
      expect(prefixed.text).not.toContain("operator index");

      const unprefixed = await request(server.port, route);
      expectNotFound(unprefixed, `hub GET ${route}`);
      expect(unprefixed.text).not.toContain("operator index");
    }
  });

  it("still serves other.html from --root", async () => {
    const server = await serve({ viewer: viewerConfig(), adminSecret: OPERATOR, root: rootDir() });
    const answer = await request(server.port, "/other.html");
    expect(answer.status).toBe(200);
    expect(answer.text).toContain("<title>other page</title>");
  });
});

/* ------------------------------------------------------------------------------------------------
 * RT-05 — the --root index fallback for non-viewer paths is unchanged
 * ---------------------------------------------------------------------------------------------- */

describe("RT-05 — the index.html fallback survives the viewer refusal", () => {
  it("serves the operator index for an unrelated deep path", async () => {
    const server = await serve({ viewer: viewerConfig(), adminSecret: OPERATOR, root: rootDir() });
    const answer = await request(server.port, "/some/deep/link");
    expect(answer.status).toBe(200);
    expect(answer.text).toContain("<title>operator index</title>");
  });
});

/* ------------------------------------------------------------------------------------------------
 * RT-03 — the existing hub routes are unchanged next to the viewer surface
 * ---------------------------------------------------------------------------------------------- */

describe("RT-03 — existing hub routes are unchanged (surface regression)", () => {
  it("answers config, health, journal, notes and MCP on the hub while the viewer exists", async () => {
    const server = await serve({ viewer: viewerConfig(), adminSecret: OPERATOR });

    for (const path of ["/config", "/health", "/journal", "/notes"]) {
      const answer = await request(server.port, `${BASE}${path}`);
      expect(answer.status, `hub GET ${BASE}${path}`).toBe(200);
    }

    const mcp = await request(server.port, `${BASE}/mcp`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(200);
    const result = (JSON.parse(mcp.text) as { result: { tools: unknown[] } }).result;
    expect(result.tools.length).toBeGreaterThan(0);

    // The admin surface exists and is guarded exactly as before. `GET /admin` itself is the
    // deliberately public page; the guarded route is `{base}/admin/status`.
    const page = await request(server.port, `${BASE}/admin`);
    expect(page.status).toBe(200);
    expect(headerOf(page, "content-type")).toContain("text/html");

    const missing = await request(server.port, `${BASE}/admin/status`);
    expect(missing.status).toBe(401);
    expect(missing.text).toContain("x-bluepencil-admin");

    const status = await request(server.port, `${BASE}/admin/status`, {
      headers: { "x-bluepencil-admin": OPERATOR },
    });
    expect(status.status).toBe(200);
  });
});

/* ------------------------------------------------------------------------------------------------
 * RT-04 — operator-secret refactor: 401/429 and the budget rules (D2/§2.3)
 *
 * Wire re-observation of RT-04; the canonical unit definition lives in `server-admin.test.ts`.
 * ---------------------------------------------------------------------------------------------- */

describe("RT-04 — operator-secret verification and the shared admin budget", () => {
  it("does not spend budget on a missing header, spends it on a wrong one, and shares it with the launcher", async () => {
    const server = await serve({ viewer: viewerConfig(), adminSecret: OPERATOR });

    // More missing-header probes than a whole budget: none of them is a guess, so none may count.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const missing = await request(server.port, `${BASE}/admin/status`);
      expect(missing.status, `missing header attempt ${attempt + 1}`).toBe(401);
      expect(missing.text).toContain("x-bluepencil-admin");
    }

    // The budget is still intact: the correct secret succeeds.
    const allowed = await request(server.port, `${BASE}/admin/status`, {
      headers: { "x-bluepencil-admin": OPERATOR },
    });
    expect(allowed.status).toBe(200);

    // Ten wrong guesses exhaust the `admin` budget; each is a plain 401.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const wrong = await request(server.port, `${BASE}/admin/status`, {
        headers: { "x-bluepencil-admin": `wrong-${attempt}` },
      });
      expect(wrong.status, `wrong attempt ${attempt + 1}`).toBe(401);
    }

    const throttled = await request(server.port, `${BASE}/admin/status`, {
      headers: { "x-bluepencil-admin": "wrong-after-budget" },
    });
    expect(throttled.status).toBe(429);
    expect(headerOf(throttled, "retry-after")).toBe("300");
    expect(errorOf(throttled).code).toBe("too_many_attempts");

    // A missing value is still not a guess: 401, not 429, even on an exhausted budget.
    const stillMissing = await request(server.port, `${BASE}/admin/status`);
    expect(stillMissing.status).toBe(401);
    expect(stillMissing.text).toContain("x-bluepencil-admin");

    // `/admin/*` and the launcher share one `admin` budget.
    const launcher = await request(server.port, `${BASE}/viewer/start?k=wrong`, {
      headers: {},
    });
    expect(launcher.status).toBe(429);
    expect(headerOf(launcher, "retry-after")).toBe("300");
  });
});

/* ------------------------------------------------------------------------------------------------
 * RT-06 — hub CORS is byte-identical without a viewer
 * ---------------------------------------------------------------------------------------------- */

describe("RT-06 — hub --cors is unchanged without a viewer", () => {
  it("keeps response, preflight and journal CORS identical to the shared helpers", async () => {
    const cors = "https://app.example";
    const server = await serve({ cors });

    const notes = await request(server.port, `${BASE}/notes`);
    expect(notes.status).toBe(200);
    expect(corsHeadersOf(notes)).toEqual(corsHeaders(cors));
    expect(headerOf(notes, "access-control-allow-methods")).toBeUndefined();
    expect(headerOf(notes, "access-control-allow-credentials")).toBeUndefined();

    const preflight = await request(server.port, `${BASE}/notes`, {
      method: "OPTIONS",
      headers: { origin: cors },
    });
    const expectedPreflight = preflightResponse("OPTIONS", { cors }, ["GET", "POST"]);
    expect(preflight.status).toBe(204);
    expect(corsHeadersOf(preflight)).toEqual(expectedPreflight?.headers);

    const journal = await request(server.port, `${BASE}/journal`);
    expect(journal.status).toBe(200);
    expect(corsHeadersOf(journal)).toEqual(corsHeaders(cors));
  });
});
