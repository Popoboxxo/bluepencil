/**
 * @vitest-environment node — binds real sockets and reads real files; jsdom cannot.
 *
 * Task 9 of the viewer-origin plan: the **dual listener** and its lifecycle.
 *
 * What is proven here (plan Task 9, spec §2.4/§5.4):
 *   - `resolveOptions()` bounds the viewer TTL programmatically (`viewer_ttl_invalid`, AC-F20) and
 *     refuses a wildcard bind without an explicit origin *before any bind* (AC-F23);
 *   - a wildcard is one semantic question (`isWildcardBind`, F-04), so `--viewer-port` conflicts do
 *     not depend on the spelling of the unspecified address;
 *   - `startHub()` binds hub then viewer, resolves the viewer origin before the first served
 *     request, and exposes both listeners through `RunningServer.viewer` (AC-5.1, AC-F11, AC-F22);
 *   - a failed viewer bind closes the hub (AC-F12); a failed post-`listen()` validation closes both
 *     and leaves `activeJournalForTests()` `null` (AC-F16, UT-36);
 *   - `close()` closes both listeners and waits for both (AC-F10);
 *   - the resolved viewer fields (`origin`, `host`, `port`, host-gate aliases) reach the second
 *     listener (F-07).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { request as nodeRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_BASE_PATH } from "../../server/handler";
import {
  HubStartupError,
  activeJournalForTests,
  isWildcardBind,
  parseHubArgs,
  startHub,
  type HubOptions,
  type RunningServer,
} from "../../server/hub";
import * as serverIndex from "../../server/index";

const BASE = DEFAULT_BASE_PATH;
/** The operator credential; the programmatic path does not enforce the CLI floors, but a real one. */
const OPERATOR_SECRET = "viewer-lifecycle-operator";

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

/** A `dist`-shaped directory: the parser and the assets route only need the bundle to exist. */
function assetsDir(): string {
  const dir = tempDir("bp-lifecycle-assets-");
  writeFileSync(join(dir, "bluepencil.element.min.js"), "// stub\n");
  return dir;
}

/** A store path in its own directory, so journal dirs do not collide between starts. */
function storePath(): string {
  return join(tempDir("bp-lifecycle-store-"), "notes.bluepencil.json");
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

/** Starts a tracked hub; `close()` in `afterEach` keeps a failing assertion from leaking a socket. */
async function serve(options: HubOptions): Promise<RunningServer> {
  const server = await startHub({ quiet: true, ...options });
  servers.push(server);
  return server;
}

/** Starts a hub that must be refused, and never leaves a listener behind if it is not. */
async function startRejection(options: HubOptions): Promise<unknown> {
  let started: RunningServer | undefined;
  try {
    started = await startHub({ quiet: true, ...options });
  } catch (error) {
    return error;
  }
  await started.close();
  throw new Error("expected startHub() to reject, but it started");
}

/** The same, narrowed to the documented start refusal. */
async function startFailure(options: HubOptions): Promise<HubStartupError> {
  const error = await startRejection(options);
  expect(error).toBeInstanceOf(HubStartupError);
  return error as HubStartupError;
}

function request(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = nodeRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: init.method ?? "GET",
        headers: init.headers ?? {},
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

/** Complete, valid CLI viewer arguments; `extra` overrides individual flags. */
function cliViewerArgs(extra: string[]): string[] {
  return [
    "--store",
    "notes.bluepencil.json",
    "--viewer",
    "--viewer-port",
    "8788",
    "--viewer-assets",
    assetsDir(),
    "--viewer-allow",
    "example.com",
    "--admin-secret",
    OPERATOR_SECRET,
    "--viewer-origin",
    "https://view.example.com",
    ...extra,
  ];
}

describe("UT-29 — the viewer TTL is bounded programmatically (AC-F20)", () => {
  it("refuses 59, 604801 and a fractional value with viewer_ttl_invalid", async () => {
    for (const ttlSeconds of [59, 604_801, 60.5]) {
      const error = await startFailure({
        storePath: storePath(),
        port: 0,
        viewer: viewerOptions({ ttlSeconds }),
      });
      expect(error.code).toBe("viewer_ttl_invalid");
    }
  });

  it("accepts both boundaries and starts", async () => {
    for (const ttlSeconds of [60, 604_800]) {
      const server = await serve({
        storePath: storePath(),
        port: 0,
        viewer: viewerOptions({ ttlSeconds }),
      });
      expect(server.viewer?.server.listening).toBe(true);
    }
  });

  it("does not create a new journal when the start is refused", async () => {
    const before = activeJournalForTests();
    await startFailure({ storePath: storePath(), port: 0, viewer: viewerOptions({ ttlSeconds: 59 }) });
    expect(activeJournalForTests()).toBe(before);
  });
});

describe("UT-34 — a wildcard bind is one semantic question (AC-F23)", () => {
  it("recognises every unspecified-address spelling and nothing else", () => {
    for (const address of ["", "0.0.0.0", "::", "[::]"]) {
      expect(isWildcardBind(address)).toBe(true);
    }
    for (const address of ["127.0.0.1", "localhost", "192.0.2.10", "::1"]) {
      expect(isWildcardBind(address)).toBe(false);
    }
  });

  it("refuses a programmatic wildcard bind without an explicit origin, before any bind", async () => {
    const hubPort = await freePort();
    for (const viewer of [
      // inherited from the hub bind (`--host 0.0.0.0`) and explicit on the viewer
      { host: undefined, viewerHost: "0.0.0.0" },
      { host: "0.0.0.0", viewerHost: undefined },
      { host: "::", viewerHost: undefined },
      { host: "127.0.0.1", viewerHost: "" },
    ]) {
      const error = await startFailure({
        storePath: storePath(),
        port: hubPort,
        ...(viewer.host === undefined ? {} : { host: viewer.host }),
        viewer: viewerOptions({ host: viewer.viewerHost, port: 0 }),
      });
      expect(error.code).toBe("viewer_origin_required");
    }
    // "Before any bind": the hub port is still free.
    await expectRefused(hubPort);
  });

  it("keeps the obligation with port 0 on the hub and accepts an explicit origin", async () => {
    await startFailure({
      storePath: storePath(),
      port: 0,
      host: "0.0.0.0",
      viewer: viewerOptions({ host: undefined }),
    }).then((error) => expect(error.code).toBe("viewer_origin_required"));

    const server = await serve({
      storePath: storePath(),
      port: 0,
      host: "127.0.0.1",
      viewer: viewerOptions({ host: "0.0.0.0", origin: "https://view.example.com" }),
    });
    expect(server.viewer?.origin).toBe("https://view.example.com");
    expect(server.viewer?.origin).not.toContain("0.0.0.0");
  });
});

describe("UT-03 (supplementary) — viewer_port_conflict is semantic, not spelling-only (AC-F3, AC-F19)", () => {
  const conflict =
    "--viewer-port must differ from --port on the same bind address (viewer_port_conflict)";

  it("refuses 0.0.0.0 vs the empty string on the same port", () => {
    expect(String(parseHubArgs(cliViewerArgs(["--port", "8788", "--host", "0.0.0.0", "--viewer-host", ""])))).toBe(
      conflict,
    );
    expect(String(parseHubArgs(cliViewerArgs(["--port", "8788", "--host", "", "--viewer-host", "0.0.0.0"])))).toBe(
      conflict,
    );
    expect(String(parseHubArgs(cliViewerArgs(["--port", "8788", "--host", "::", "--viewer-host", "[::]"])))).toBe(
      conflict,
    );
  });

  it("still accepts two different concrete binds on the same port, and port 0", () => {
    const different = parseHubArgs(
      cliViewerArgs(["--port", "8788", "--host", "0.0.0.0", "--viewer-host", "127.0.0.1"]),
    );
    expect(typeof different).not.toBe("string");
    const ephemeral = parseHubArgs(cliViewerArgs(["--port", "0", "--viewer-port", "0"]));
    expect(typeof ephemeral).not.toBe("string");
  });
});

describe("AC-5.1 / AC-F11 — two listeners, two origins", () => {
  it("exposes both listeners and derives the actual viewer origin", async () => {
    const server = await serve({
      storePath: storePath(),
      port: 0,
      host: "127.0.0.1",
      viewer: viewerOptions(),
    });

    expect(server.viewer).toBeDefined();
    expect(server.viewer?.server.listening).toBe(true);
    expect(server.viewer?.port).toBeGreaterThan(0);
    expect(server.viewer?.port).not.toBe(server.port);
    expect(server.viewer?.host).toBe("127.0.0.1");
    expect(server.viewer?.origin).toBe(`http://127.0.0.1:${server.viewer?.port}`);
    expect(server.viewer?.url).toBe(`${server.viewer?.origin}${BASE}`);

    // The hub listener keeps answering next to it.
    expect((await request(server.port, `${BASE}/health`)).status).toBe(200);
    expect((await request(server.viewer!.port, `${BASE}/health`)).status).toBe(200);
  });

  it("serves no viewer on the hub and is fail-closed on the viewer surface (surface wiring)", async () => {
    const server = await serve({
      storePath: storePath(),
      port: 0,
      viewer: viewerOptions(),
    });
    // The hub surface still answers an unauthenticated `/notes` (no regression)…
    expect((await request(server.port, `${BASE}/notes`)).status).toBe(200);
    // …while the viewer surface is fail-closed without a session or client credential (AC-5.10).
    expect((await request(server.viewer!.port, `${BASE}/notes`)).status).toBe(401);
  });
});

describe("F-07 — resolved viewer fields reach the second listener", () => {
  it("normalises the deprecated publicBaseUrl alias onto origin and keeps it after resolve", async () => {
    const server = await serve({
      storePath: storePath(),
      port: 0,
      viewer: viewerOptions({ publicBaseUrl: "HTTPS://View.Example.COM:443/" }),
    });
    expect(server.viewer?.origin).toBe("https://view.example.com");
    expect(server.viewer?.url).toBe(`https://view.example.com${BASE}`);
  });

  it("wires the host-gate aliases derived from the explicit origin", async () => {
    const server = await serve({
      storePath: storePath(),
      port: 0,
      viewer: viewerOptions({ origin: "https://view.example.com" }),
    });
    const port = server.viewer!.port;

    expect((await request(port, `${BASE}/health`)).status).toBe(200);
    expect(
      (await request(port, `${BASE}/health`, { headers: { host: "view.example.com:8788" } })).status,
    ).toBe(200);
    expect(
      (await request(port, `${BASE}/health`, { headers: { host: "evil.example" } })).status,
    ).toBe(403);
  });
});

describe("AC-F10 — close() closes both listeners", () => {
  it("refuses both ports afterwards and allows a restart on the same fixed ports", async () => {
    const first = await startHub({
      quiet: true,
      storePath: storePath(),
      port: 0,
      host: "127.0.0.1",
      viewer: viewerOptions(),
    });
    const hubPort = first.port;
    const viewerPort = first.viewer!.port;

    await expect(first.close()).resolves.toBeUndefined();
    await expectRefused(hubPort);
    await expectRefused(viewerPort);

    const second = await serve({
      storePath: storePath(),
      port: hubPort,
      host: "127.0.0.1",
      viewer: viewerOptions({ port: viewerPort }),
    });
    expect(second.port).toBe(hubPort);
    expect(second.viewer?.port).toBe(viewerPort);
  });
});

describe("AC-F12 — a failed viewer bind closes the hub", () => {
  it("closes the hub listener, resets the journal and allows a later start", async () => {
    const hubPort = await freePort();
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", () => resolve()));
    const takenAddress = taken.address();
    const takenPort = typeof takenAddress === "object" && takenAddress !== null ? takenAddress.port : 0;

    try {
      const error = await startRejection({
        storePath: storePath(),
        port: hubPort,
        host: "127.0.0.1",
        viewer: viewerOptions({ port: takenPort }),
      });
      expect((error as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
      expect(activeJournalForTests()).toBeNull();
      await expectRefused(hubPort);
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()));
    }

    const restarted = await serve({
      storePath: storePath(),
      port: hubPort,
      host: "127.0.0.1",
      viewer: viewerOptions(),
    });
    expect(restarted.port).toBe(hubPort);
  });
});

describe("AC-F16 / UT-36 — no stale journal after a refused start", () => {
  it("is exported from hub.ts but not from server/index.ts", () => {
    expect(typeof activeJournalForTests).toBe("function");
    expect("activeJournalForTests" in serverIndex).toBe(false);
  });

  it("is null after a start that was refused during validation, and set after a good one", async () => {
    // A successful start proves the seam can see a journal at all.
    const good = await serve({ storePath: storePath(), port: 0, viewer: viewerOptions() });
    expect(activeJournalForTests()).not.toBeNull();
    await good.close();
    servers.splice(servers.indexOf(good), 1);

    // Fixed ports: the origin equals the hub origin, so the start is refused before `listen()`.
    const hubPort = await freePort();
    const hubOrigin = `http://127.0.0.1:${hubPort}`;
    const sameOrigin = await startFailure({
      storePath: storePath(),
      port: hubPort,
      host: "127.0.0.1",
      viewer: viewerOptions({ port: await freePort(), origin: hubOrigin }),
    });
    expect(sameOrigin.code).toBe("viewer_origin_is_hub_origin");
    expect(activeJournalForTests()).toBeNull();

    // Fixed ports: `--cors` names the viewer origin.
    const viewerPort = await freePort();
    const corsClash = await startFailure({
      storePath: storePath(),
      port: hubPort,
      host: "127.0.0.1",
      cors: `http://127.0.0.1:${viewerPort}`,
      viewer: viewerOptions({ port: viewerPort }),
    });
    expect(corsClash.code).toBe("cors_viewer_origin");
    expect(activeJournalForTests()).toBeNull();
    await expectRefused(hubPort);

    // A later start succeeds without inheriting the refused start's journal.
    const later = await serve({ storePath: storePath(), port: 0, viewer: viewerOptions() });
    expect(activeJournalForTests()).not.toBeNull();
    expect(later.viewer?.server.listening).toBe(true);
  });

  it("refuses a programmatic cors wildcard with a viewer", async () => {
    const error = await startFailure({
      storePath: storePath(),
      port: 0,
      cors: "*",
      viewer: viewerOptions(),
    });
    expect(error.code).toBe("cors_wildcard_with_viewer");
    expect(activeJournalForTests()).toBeNull();
  });
});
