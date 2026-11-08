/**
 * @vitest-environment node — binds real sockets and reads real files; jsdom cannot.
 *
 * Task 10 of the viewer-origin plan: the **dispatch gate**, the startup warnings and the start line.
 *
 * What is proven here (plan Task 10, spec §2.1/§2.4/§5.4):
 *   - `respond()`/`earlyRefusal()` dispatch by surface: the launcher only on the hub, the two path
 *     refusals before journal/static/MCP, and the viewer door only for `surface === "viewer"` **and**
 *     `isViewerRequest()` (AC-5.2, AC-5.23);
 *   - the hub port answers `404` for every viewer content route **even with `--root`**, while other
 *     static files keep their fallback (AC-5.29);
 *   - the viewer door does not swallow `/health`, `/notes*`, `/sessions` or `/bundle`;
 *   - all five `StartupWarning` codes reach stderr; `--quiet` silences the progress line only and
 *     `parseHubArgs()` emits nothing (AC-F13, UT-28);
 *   - the start line names both addresses (spec §2.4 rule 10);
 *   - the programmatic `cors: "*"` / `cors == viewer origin` refusals with both listeners closed
 *     (AC-F15);
 *   - `hostRefusal()` with an **injected** non-loopback `bind` (no real non-loopback bind, UT-33).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as nodeRequest } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_BASE_PATH, hostRefusal, type HandlerContext } from "../../server/handler";
import {
  HubStartupError,
  parseHubArgs,
  startHub,
  type HubOptions,
  type RunningServer,
} from "../../server/hub";

const BASE = DEFAULT_BASE_PATH;
const OPERATOR_SECRET = "viewer-dispatch-operator";

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
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

/** A `dist`-shaped directory: the assets route only needs the bundle to exist. */
function assetsDir(): string {
  const dir = tempDir("bp-dispatch-assets-");
  writeFileSync(join(dir, "bluepencil.element.min.js"), "// stub\n");
  return dir;
}

function storePath(): string {
  return join(tempDir("bp-dispatch-store-"), "notes.bluepencil.json");
}

function viewerOptions(overrides: Record<string, unknown> = {}): NonNullable<HubOptions["viewer"]> {
  return {
    host: "127.0.0.1",
    port: 0,
    assetsDir: assetsDir(),
    allow: ["example.com"],
    ttlSeconds: 28_800,
    ...overrides,
  } as NonNullable<HubOptions["viewer"]>;
}

/** Starts a tracked hub; `afterEach` closes it so a failing assertion cannot leak a socket. */
async function serve(options: HubOptions): Promise<RunningServer> {
  const server = await startHub({ quiet: true, ...options });
  servers.push(server);
  return server;
}

function request(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.body !== undefined && headers["content-length"] === undefined) {
      headers["content-length"] = String(Buffer.byteLength(init.body));
    }
    const req = nodeRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: init.method ?? "GET",
        headers,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text }),
        );
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

/** A form-encoded launcher POST: `content-type` and `content-length` as a browser sends them. */
function urlencoded(
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): { headers: Record<string, string>; body: string } {
  return {
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  };
}

/**
 * Sends the headers of a request with a declared `content-length` but **no** body, and keeps the
 * write side open until the answer arrives (AC-L14: the client streams nothing and waits).
 */
function requestWithDeclaredBodyOnly(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = nodeRequest(
      { host: "127.0.0.1", port, path, method: "POST", headers },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text });
          req.destroy();
        });
      },
    );
    req.on("error", reject);
    req.flushHeaders();
  });
}

/**
 * Streams a chunked body past the launcher limit and resolves with the observed outcome: a
 * transport error code, or the status of an answer that should not exist (AC-L29).
 *
 * A **timeout is a failure**, not an outcome: AC-L29 requires a cut socket, and a request that
 * simply hangs would otherwise satisfy "no status" for the wrong reason. Only this file's single
 * caller uses the helper, so the timeout branch rejects instead of resolving a passing value.
 */
function requestChunkedOvershoot(
  port: number,
  path: string,
  headers: Record<string, string>,
  size: number,
): Promise<{ error?: string; status?: number }> {
  return new Promise((resolve, reject) => {
    const req = nodeRequest(
      { host: "127.0.0.1", port, path, method: "POST", headers },
      (response) => {
        response.resume();
        clearTimeout(timer);
        resolve({ status: response.statusCode ?? 0 });
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`no cut socket within 2s on ${path}: the launcher answered nothing (AC-L29)`));
    }, 2000);
    timer.unref();
    req.on("error", (error) => {
      clearTimeout(timer);
      resolve({ error: (error as NodeJS.ErrnoException).code ?? String(error) });
    });
    req.write("x".repeat(size));
    req.end();
  });
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
    }, 2000);
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

function errorCode(answer: Answer): string | undefined {
  try {
    const parsed: unknown = JSON.parse(answer.text);
    if (parsed !== null && typeof parsed === "object" && "error" in parsed) {
      const error = (parsed as { error?: unknown }).error;
      if (error !== null && typeof error === "object" && "code" in error) {
        return String((error as { code?: unknown }).code);
      }
    }
  } catch {
    /* not JSON */
  }
  return undefined;
}

/** Captures every stderr write for the duration of `run`. */
async function withStderr<T>(run: () => Promise<T>): Promise<{ result: T; writes: string[] }> {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  });
  try {
    const result = await run();
    return { result, writes };
  } finally {
    spy.mockRestore();
  }
}

/* ------------------------------------------------------------------------------------------------
 * UT-33 — the Host gate with an injected bind (no real non-loopback bind)
 * ---------------------------------------------------------------------------------------------- */

function hostContext(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    store: { notes: [] },
    base: BASE,
    environment: "dev",
    bind: { host: "127.0.0.1", port: 8787 },
    ...overrides,
  };
}

describe("UT-33 — hostRefusal with an injected bind (AC-5.23)", () => {
  it("refuses a foreign Host on a loopback bind with 403 host_not_allowed", () => {
    const refused = hostRefusal({ headers: { host: "evil.example" } }, hostContext());
    expect(refused).not.toBeNull();
    expect(refused?.status).toBe(403);
    expect(refused?.body).toContain("host_not_allowed");
  });

  it("accepts a configured alias on a loopback bind", () => {
    const context = hostContext({ hostAliases: ["view.example.com"] });
    expect(hostRefusal({ headers: { host: "view.example.com:8788" } }, context)).toBeNull();
    expect(hostRefusal({ headers: { host: "localhost:8787" } }, context)).toBeNull();
  });

  it("does not gate a non-loopback bind — injected 192.0.2.10, never a real bind", () => {
    // The point of the injection: AC-5.23's "no gate" branch needs a non-loopback bind, but the
    // test must not actually expose a listener on a public address.
    const context = hostContext({ bind: { host: "192.0.2.10", port: 8787 } });
    expect(hostRefusal({ headers: { host: "evil.example" } }, context)).toBeNull();
  });
});

/* ------------------------------------------------------------------------------------------------
 * UT-28 — startup warnings and the start line (AC-F13)
 * ---------------------------------------------------------------------------------------------- */

describe("UT-28 — startup warnings reach stderr even with --quiet (AC-F13)", () => {
  it("emits unauthenticated_non_loopback and cors_wildcard, and no progress line", async () => {
    const { writes } = await withStderr(async () => {
      const server = await startHub({
        storePath: storePath(),
        host: "0.0.0.0",
        port: 0,
        cors: "*",
        quiet: true,
      });
      servers.push(server);
    });

    const joined = writes.join("");
    expect(joined).toContain("unauthenticated_non_loopback");
    expect(joined).toContain("cors_wildcard");
    // `--quiet` suppresses the informational line, never the warnings.
    expect(joined).not.toContain("note(s), environment");
  });

  it("emits viewer_cookie_shared_host and viewer_public_url_deprecated", async () => {
    const { writes } = await withStderr(async () => {
      const server = await startHub({
        storePath: storePath(),
        host: "127.0.0.1",
        port: 0,
        quiet: true,
        viewer: viewerOptions({ publicBaseUrl: "http://127.0.0.1:2" }),
      });
      servers.push(server);
    });

    const joined = writes.join("");
    expect(joined).toContain("viewer_cookie_shared_host");
    expect(joined).toContain("viewer_public_url_deprecated");
    expect(joined).not.toContain("note(s), environment");
  });

  it("emits viewer_non_loopback_insecure for a plain-http viewer on a non-loopback bind", async () => {
    const { writes } = await withStderr(async () => {
      const server = await startHub({
        storePath: storePath(),
        host: "127.0.0.1",
        port: 0,
        quiet: true,
        viewer: viewerOptions({ host: "0.0.0.0", origin: "http://view.example.com" }),
      });
      servers.push(server);
    });

    expect(writes.join("")).toContain("viewer_non_loopback_insecure");
  });

  it("names both addresses in the start line and keeps the note count", async () => {
    const { result, writes } = await withStderr(async () => {
      const server = await startHub({
        storePath: storePath(),
        host: "127.0.0.1",
        port: 0,
        name: "bp-test",
        viewer: viewerOptions({ origin: "https://view.example.com" }),
      });
      servers.push(server);
      return server;
    });

    const startLine = writes.find((line) => line.includes('bluepencil server: "bp-test" on http://'));
    expect(startLine).toBeDefined();
    expect(startLine).toContain(`http://127.0.0.1:${result.port}${BASE || "/"}`);
    expect(startLine).toContain(` — viewer on ${result.viewer?.url} — `);
    expect(startLine).toContain("0 note(s)");
  });

  it("keeps parseHubArgs silent: it is a pure function", () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const parsed = parseHubArgs([
        "--store",
        "notes.bluepencil.json",
        "--viewer",
        "--viewer-port",
        "0",
        "--viewer-assets",
        assetsDir(),
        "--viewer-allow",
        "example.com",
        "--admin-secret",
        OPERATOR_SECRET,
      ]);
      expect(typeof parsed).toBe("object");
    } finally {
      spy.mockRestore();
    }
    expect(writes).toEqual([]);
  });
});

/* ------------------------------------------------------------------------------------------------
 * Dispatch gate — AC-5.2/AC-5.23 and AC-5.29
 * ---------------------------------------------------------------------------------------------- */

describe("dispatch gate — the hub never serves viewer content, even with --root (AC-5.2/AC-5.29)", () => {
  const viewerPaths = [
    `${BASE}/viewer`,
    `${BASE}/view`,
    `${BASE}/viewer/assets/bluepencil.element.min.js`,
    `${BASE}/viewer/bookmarklet.txt`,
    "/viewer",
    "/view",
    "/viewer/assets/bluepencil.element.min.js",
    "/viewer/bookmarklet.txt",
  ];

  it("answers 404 for all eight viewer paths and keeps other static files", async () => {
    const root = tempDir("bp-dispatch-root-");
    writeFileSync(join(root, "index.html"), "<!doctype html><title>root</title>");
    writeFileSync(join(root, "other.html"), "<!doctype html><title>other</title>");

    const server = await serve({
      storePath: storePath(),
      port: 0,
      root,
      viewer: viewerOptions({ origin: "https://view.example.com" }),
    });

    for (const path of viewerPaths) {
      const answer = await request(server.port, path);
      expect(answer.status, path).toBe(404);
      expect(errorCode(answer), path).toBe("not_found");
      expect(answer.text, path).not.toContain("<bluepencil-notes");
      expect(answer.headers["set-cookie"], path).toBeUndefined();
    }

    // The static fallback itself is unchanged for every other path.
    expect((await request(server.port, "/other.html")).status).toBe(200);
    expect((await request(server.port, "/")).status).toBe(200);
  });

  it("keeps the launcher reachable on the hub while refusing viewer content", async () => {
    const server = await serve({
      storePath: storePath(),
      port: 0,
      adminSecret: OPERATOR_SECRET,
      viewer: viewerOptions({ origin: "https://view.example.com" }),
    });

    const startPath = `${BASE}/viewer/start`;
    expect((await request(server.port, startPath)).status).toBe(401);

    const launched = await request(server.port, startPath, {
      headers: { "x-bluepencil-admin": OPERATOR_SECRET },
    });
    expect(launched.status).toBe(302);
    const location = launched.headers["location"];
    expect(typeof location).toBe("string");
    expect(String(location)).toMatch(
      new RegExp(`^https://view\\.example\\.com${BASE}/viewer\\?ticket=[0-9a-f]{48}$`),
    );

    // Spec §3 row 8/9: a POST with the operator header and a body-less request is the admin
    // button's shape — 303 with HTML, no 415/413 rule fires. It is no longer a 405.
    const posted = await request(server.port, startPath, {
      method: "POST",
      headers: { "x-bluepencil-admin": OPERATOR_SECRET, accept: "text/html" },
    });
    expect(posted.status).toBe(303);
    expect(String(posted.headers["location"])).toMatch(
      new RegExp(`^https://view\\.example\\.com${BASE}/viewer\\?ticket=[0-9a-f]{48}$`),
    );
    expect(posted.headers["set-cookie"]).toBeUndefined();
    expect(posted.headers["connection"]).not.toBe("close");

    // The documented method gate is now `Allow: GET, POST`; PUT is the foreign verb.
    const put = await request(server.port, startPath, { method: "PUT" });
    expect(put.status).toBe(405);
    expect(String(put.headers["allow"])).toBe("GET, POST");
    expect(put.headers["connection"]).toBe("close");
    expect(put.headers["location"]).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------------------------------
 * The launcher body over the wire (spec §3, §5.3)
 * ---------------------------------------------------------------------------------------------- */

describe("the launcher reads a form body once, gated and size-limited", () => {
  const startPath = `${BASE}/viewer/start`;

  function launcherHub(): Promise<RunningServer> {
    return serve({
      storePath: storePath(),
      port: 0,
      adminSecret: OPERATOR_SECRET,
      viewer: viewerOptions({ origin: "https://view.example.com" }),
    });
  }

  it("answers 303 for a form body and never echoes the secret", async () => {
    const server = await launcherHub();
    const answer = await request(server.port, startPath, {
      method: "POST",
      ...urlencoded({ secret: OPERATOR_SECRET }, { accept: "text/html" }),
    });
    expect(answer.status).toBe(303);
    expect(String(answer.headers["location"])).toMatch(
      new RegExp(`^https://view\\.example\\.com${BASE}/viewer\\?ticket=[0-9a-f]{48}$`),
    );
    expect(answer.headers["referrer-policy"]).toBe("no-referrer");
    expect(answer.headers["cache-control"]).toBe("no-store");
    // AC-L06/L28 hold over the wire too: the ticket is the only credential in the answer.
    expect(answer.headers["set-cookie"]).toBeUndefined();
    expect(answer.text).not.toContain(OPERATOR_SECRET);
  });

  it("answers 413 for 9000 declared bytes without reading, and the answer is fully readable", async () => {
    const server = await launcherHub();
    const answer = await requestWithDeclaredBodyOnly(server.port, startPath, {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "content-length": "9000",
    });
    expect(answer.status).toBe(413);
    expect(answer.headers["connection"]).toBe("close");
    expect(errorCode(answer)).toBe("payload_too_large");
    expect(answer.headers["location"]).toBeUndefined();
  });

  it("answers 415 for a declared body with a non-form content-type", async () => {
    const server = await launcherHub();
    const answer = await request(server.port, startPath, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: '{"secret":"x"}',
    });
    expect(answer.status).toBe(415);
    expect(answer.headers["connection"]).toBe("close");
    expect(errorCode(answer)).toBe("unsupported_media_type");
  });

  it("cuts the socket without an answer for a chunked 9000-byte body (AC-L29)", async () => {
    const server = await launcherHub();
    const outcome = await requestChunkedOvershoot(
      server.port,
      startPath,
      { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      9000,
    );
    // No 413, no 400, no 200: the socket is cut off the way readBody() does it. The helper rejects
    // on a hang, so this test is red when the request is not cut off at all.
    expect(outcome.status).toBeUndefined();
    expect(outcome.error).toBeDefined();
    expect(outcome.error).not.toBe("timeout");
  });

  it("shares the admin budget with /admin/status in both directions (AC-L30)", async () => {
    const fromLauncher = await launcherHub();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const wrong = await request(fromLauncher.port, startPath, {
        method: "POST",
        ...urlencoded({ secret: `wrong-${attempt}` }, { accept: "application/json" }),
      });
      expect(wrong.status, `attempt ${attempt}`).toBe(401);
    }
    const admin = await request(fromLauncher.port, `${BASE}/admin/status`, {
      headers: { "x-bluepencil-admin": OPERATOR_SECRET },
    });
    expect(admin.status).toBe(429);
    expect(String(admin.headers["retry-after"])).toBe("300");

    const fromAdmin = await launcherHub();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const wrong = await request(fromAdmin.port, `${BASE}/admin/status`, {
        headers: { "x-bluepencil-admin": `wrong-${attempt}` },
      });
      expect(wrong.status, `attempt ${attempt}`).toBe(401);
    }
    const throttled = await request(fromAdmin.port, startPath, {
      method: "POST",
      ...urlencoded({ secret: OPERATOR_SECRET }, { accept: "application/json" }),
    });
    expect(throttled.status).toBe(429);
    expect(String(throttled.headers["retry-after"])).toBe("300");
  });

  it("answers 404 for GET and POST on a hub without a viewer (AC-L19)", async () => {
    const server = await serve({ storePath: storePath(), port: 0, adminSecret: OPERATOR_SECRET });
    expect((await request(server.port, startPath)).status).toBe(404);
    const posted = await request(server.port, startPath, {
      method: "POST",
      ...urlencoded({ secret: OPERATOR_SECRET }, { accept: "text/html" }),
    });
    expect(posted.status).toBe(404);
    expect(posted.text).not.toContain("<form");
  });
});

describe("dispatch gate — the viewer door does not swallow the shared routes (AC-5.23)", () => {
  it("answers /health with 200 and /notes*, /sessions, /bundle through gateRequest", async () => {
    const server = await serve({
      storePath: storePath(),
      port: 0,
      viewer: viewerOptions({ origin: "https://view.example.com" }),
    });
    const port = server.viewer!.port;

    // `/health` is public on both surfaces and must not be answered by the viewer door.
    const health = await request(port, `${BASE}/health`);
    expect(health.status).toBe(200);

    // The shared note routes keep their fail-closed 401 — the viewer door would have answered its
    // own 404/401 for a path it owns, so the JSON `unauthorized` code proves the router answered.
    for (const path of [`${BASE}/notes`, `${BASE}/sessions`, `${BASE}/bundle`]) {
      const answer = await request(port, path);
      expect(answer.status, path).toBe(401);
      expect(errorCode(answer), path).toBe("unauthorized");
    }

    // The viewer surface refuses `/config` before the public config probe.
    expect((await request(port, `${BASE}/config`)).status).toBe(404);
  });
});

/* ------------------------------------------------------------------------------------------------
 * AC-F15 — programmatic CORS refusals close/never open both listeners
 * ---------------------------------------------------------------------------------------------- */

describe("AC-F15 — programmatic CORS refusals with a viewer", () => {
  it("refuses cors '*' and binds neither listener", async () => {
    const hubPort = await freePort();
    const viewerPort = await freePort();
    let error: unknown;
    try {
      const started = await startHub({
        storePath: storePath(),
        port: hubPort,
        host: "127.0.0.1",
        cors: "*",
        viewer: viewerOptions({ port: viewerPort }),
      });
      await started.close();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(HubStartupError);
    expect((error as HubStartupError).code).toBe("cors_wildcard_with_viewer");
    await expectRefused(hubPort);
    await expectRefused(viewerPort);
  });

  it("refuses cors equal to the viewer origin and binds neither listener", async () => {
    const hubPort = await freePort();
    const viewerPort = await freePort();
    let error: unknown;
    try {
      const started = await startHub({
        storePath: storePath(),
        port: hubPort,
        host: "127.0.0.1",
        cors: `http://127.0.0.1:${viewerPort}`,
        viewer: viewerOptions({ port: viewerPort }),
      });
      await started.close();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(HubStartupError);
    expect((error as HubStartupError).code).toBe("cors_viewer_origin");
    await expectRefused(hubPort);
    await expectRefused(viewerPort);
  });
});
