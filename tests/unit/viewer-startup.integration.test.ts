/**
 * @vitest-environment node — this suite binds real listeners and talks to them over `node:http`;
 * jsdom can neither bind a socket nor drive a second origin.
 *
 * Task 15 of the viewer-origin plan (issue #140): startup, lifecycle and CLI integration —
 * IT-01, IT-23, IT-24, IT-25, IT-26, IT-27, IT-35, IT-36, IT-37, IT-38, IT-39, IT-40, IT-45, IT-46.
 *
 * What is asserted here is the **start path end to end**, not the pure decision functions (those
 * live in `viewer-start.test.ts`, `viewer-lifecycle.test.ts` and `viewer-cli.test.ts`):
 *
 *   - `startHub()` binds a second listener on its own actual port and reports the derived origin,
 *     `port` and `url` (AC-5.1, AC-F11);
 *   - `close()` closes both sockets and a restart on the same fixed ports succeeds (AC-F10);
 *   - a taken viewer port closes the hub again and leaves no half `RunningServer`, and a later
 *     start on the now-free hub port succeeds (AC-F12);
 *   - the viewer warnings reach stderr even with `--quiet`, while the progress line does not
 *     (AC-F13);
 *   - the environment parses to the same viewer as the flags, and a flag wins (AC-F9);
 *   - `--cors '*'` + viewer is refused at parse time and programmatically, closing both bound
 *     listeners when the refusal only becomes visible after `listen()` (AC-F15);
 *   - the post-`listen()` origin conflicts (`viewer_origin_is_hub_origin`, `cors_viewer_origin`)
 *     close both sockets, reset `activeJournal` and leave the next start on `<dir2>` alone
 *     (AC-F16);
 *   - `--viewer` is a strict boolean and `--viewer=true` without a port is refused (AC-F17);
 *   - the viewer TTL is bounded in the CLI and programmatically (AC-F18, AC-F20);
 *   - `0/0` and one port on two bind addresses are accepted and really bind (AC-F19);
 *   - the deprecated alias may not point at the hub origin (AC-F21), and a scheme-different
 *     origin on the same host and port stays distinct because origins compare scheme-sensitively;
 *   - the start window answers only `503 service_not_ready` (or refuses the connection) and the
 *     launcher then redirects with an absolute `{viewer.origin}` location (AC-F22);
 *   - the Docker/entrypoint pattern (`--host 0.0.0.0 --viewer`) demands an explicit origin before
 *     any bind and never derives `http://0.0.0.0:<port>` (AC-F6, AC-F23).
 *
 * Hermetic: every socket is loopback (or the wildcard bind the Docker case itself prescribes on an
 * ephemeral port), every request goes to `127.0.0.1`/`127.0.0.2` and no test talks to an external
 * host. The start window of AC-F22 is widened by deferring the **second** `listen()` call, so the
 * assertion is a real observation of the production window instead of a race.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as nodeRequest, type IncomingHttpHeaders } from "node:http";
import { Server as NetServer, connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_BASE_PATH } from "../../server/handler";
import {
  HubStartupError,
  activeJournalForTests,
  parseHubArgs,
  startHub,
  type HubOptions,
  type RunningServer,
} from "../../server/hub";

/** `{base}` in the ACs — the built-in http adapter's default, which `startHub()` also uses. */
const BASE = DEFAULT_BASE_PATH;
/** The operator credential the launcher and the CLI viewer requirements demand. */
const OPERATOR = "viewer-startup-operator-secret";

interface Answer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
}

interface Attempt {
  readonly answer?: Answer;
  /** The `code` of a connection-level failure (`ECONNREFUSED`, `ECONNRESET`, …). */
  readonly error?: string;
}

interface RequestInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  /** The loopback address to connect to; the viewer of IT-39 lives on `127.0.0.2`. */
  readonly host?: string;
}

const servers: RunningServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    // A test that already closed its server removed it from the list; a double close would reject
    // with ERR_SERVER_NOT_RUNNING, so this defensive catch only protects a failing assertion.
    await server.close().catch(() => undefined);
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A `dist`-shaped directory: the parser and the assets route only need the bundle to exist. */
function assetsDir(): string {
  const dir = tempDir("bp-startup-assets-");
  writeFileSync(join(dir, "bluepencil.element.min.js"), "// stub\n");
  return dir;
}

/** A store path in its own directory, so starts cannot share a journal location. */
function storePath(): string {
  return join(tempDir("bp-startup-store-"), "notes.bluepencil.json");
}

/** The viewer half of `HubOptions`, on an ephemeral loopback port by default. */
function viewerOptions(
  overrides: Partial<NonNullable<HubOptions["viewer"]>> = {},
): NonNullable<HubOptions["viewer"]> {
  return {
    host: "127.0.0.1",
    port: 0,
    assetsDir: assetsDir(),
    allow: ["example.com"],
    ttlSeconds: 28_800,
    ...overrides,
  } as NonNullable<HubOptions["viewer"]>;
}

/**
 * Complete, valid CLI viewer arguments; `extra` comes first so it overrides a default flag
 * (`parseHubArgs` reads the first occurrence of a repeated flag).
 */
function cliViewerArgs(extra: string[] = []): string[] {
  return [
    ...extra,
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
    OPERATOR,
  ];
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

/** Starts a hub that must be refused; a start that does not reject is a test failure, not a leak. */
async function startRejection(options: HubOptions): Promise<unknown> {
  let started: RunningServer | undefined;
  try {
    started = await startHub(options);
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

/** One HTTP round trip against a real listener; connection failures are returned, not thrown. */
function exchange(port: number, path: string, init: RequestInit = {}): Promise<Attempt> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.body !== undefined) {
      headers["content-type"] ??= "application/json";
      headers["content-length"] = String(Buffer.byteLength(init.body));
    }
    const req = nodeRequest(
      {
        host: init.host ?? "127.0.0.1",
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
        response.on("end", () => {
          resolve({
            answer: {
              status: response.statusCode ?? 0,
              headers: response.headers,
              text,
            },
          });
        });
      },
    );
    req.on("error", (error) => {
      resolve({ error: (error as NodeJS.ErrnoException).code ?? String(error) });
    });
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

async function request(port: number, path: string, init: RequestInit = {}): Promise<Answer> {
  const attempt = await exchange(port, path, init);
  if (attempt.answer === undefined) {
    throw new Error(`request ${path} on port ${port} failed: ${attempt.error ?? "unknown error"}`);
  }
  return attempt.answer;
}

function errorCode(answer: Answer): string | undefined {
  try {
    const payload = JSON.parse(answer.text) as { error?: { code?: string } };
    return payload.error?.code;
  } catch {
    return undefined;
  }
}

/** A launcher request that presents the operator secret in the documented header. */
function launcher(port: number, path = `${BASE}/viewer/start`): Promise<Answer> {
  return request(port, path, { headers: { "x-bluepencil-admin": OPERATOR } });
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

/** True when `port` can be bound on `host` right now (used for the two-address case of AC-F19). */
function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, host, () => {
      probe.close(() => resolve(true));
    });
  });
}

/** One port that is free on both loopback addresses, so hub and viewer can share the number. */
async function freePortOnBothAddresses(): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await freePort();
    if (await canBind(port, "127.0.0.2")) return port;
  }
  throw new Error("no port free on 127.0.0.1 and 127.0.0.2");
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

interface ListenTracker {
  /** Every socket `startHub()` created, in bind order (hub first — the documented order). */
  readonly bound: NetServer[];
  /** The actual ports of those sockets, recorded when each `listening` event fired. */
  readonly ports: number[];
  /** Resolves with the first bound port; the hub binds first (AC-F12 order). */
  readonly firstBound: Promise<number>;
  /** How many `listen()` calls were made — `0` proves "before every bind" (AC-F23). */
  callCount(): number;
  restore(): void;
}

/**
 * Watches the real binds of a start without touching production code.
 *
 * `startHub()` creates its own `node:net`/`node:http` servers, so the only handle a test can get on
 * the sockets is the prototype method the start necessarily calls. `delaySecondListenMs` widens the
 * documented start window of AC-F22 (`port 0`: hub bound, viewer not yet, dispatch still the `503`
 * handler) instead of racing it.
 */
function trackListens(options: { delaySecondListenMs?: number } = {}): ListenTracker {
  const original = NetServer.prototype.listen;
  const bound: NetServer[] = [];
  const ports: number[] = [];
  let calls = 0;
  let resolveFirst: (port: number) => void = () => undefined;
  const firstBound = new Promise<number>((resolve) => {
    resolveFirst = resolve;
  });

  NetServer.prototype.listen = function (this: NetServer, ...args: unknown[]): NetServer {
    calls += 1;
    const index = calls;
    bound.push(this);
    this.once("listening", () => {
      const address = this.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      ports.push(port);
      if (index === 1) resolveFirst(port);
    });
    const real = original as unknown as (...listenArgs: unknown[]) => NetServer;
    if (options.delaySecondListenMs !== undefined && index === 2) {
      const timer = setTimeout(() => {
        real.apply(this, args);
      }, options.delaySecondListenMs);
      timer.unref();
      return this;
    }
    return real.apply(this, args);
  } as typeof NetServer.prototype.listen;

  return {
    bound,
    ports,
    firstBound,
    callCount: () => calls,
    restore: () => {
      NetServer.prototype.listen = original;
    },
  };
}

const ENV_KEYS = [
  "BLUEPENCIL_VIEWER",
  "BLUEPENCIL_VIEWER_PORT",
  "BLUEPENCIL_VIEWER_HOST",
  "BLUEPENCIL_VIEWER_ORIGIN",
  "BLUEPENCIL_VIEWER_PUBLIC_URL",
  "BLUEPENCIL_VIEWER_ASSETS",
  "BLUEPENCIL_VIEWER_ALLOW",
  "BLUEPENCIL_ADMIN_SECRET",
] as const;

/** Sets only the given BLUEPENCIL_* variables and restores every touched key afterwards. */
async function withEnv<T>(
  vars: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  body: () => Promise<T> | T,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Welle 3-B — startup and lifecycle                                                                 */
/* ------------------------------------------------------------------------------------------------ */

describe("IT-01 — two listeners with distinct actual ports (AC-5.1)", () => {
  it("exposes a listening viewer on its own port while the hub keeps serving", async () => {
    const server = await serve({ viewer: viewerOptions() });
    const viewer = viewerOf(server);

    expect(server.server.listening).toBe(true);
    expect(viewer.server.listening).toBe(true);
    expect(viewer.port).toBeGreaterThan(0);
    expect(viewer.port).not.toBe(server.port);
    expect(viewer.host).toBe("127.0.0.1");
    expect(viewer.origin).toBe(`http://127.0.0.1:${viewer.port}`);

    // Both listeners really serve: the hub on its port, the viewer on its own.
    expect((await request(server.port, `${BASE}/health`)).status).toBe(200);
    expect((await request(viewer.port, `${BASE}/health`)).status).toBe(200);
  });
});

describe("IT-25 — an ephemeral viewer port resolves to the real port and origin (AC-F11)", () => {
  it("reports the actual port, the derived origin and origin + base as the url", async () => {
    const server = await serve({ viewer: viewerOptions({ port: 0, host: "127.0.0.1" }) });
    const viewer = viewerOf(server);

    expect(viewer.port).toBeGreaterThan(0);
    expect(viewer.origin).toBe(`http://127.0.0.1:${viewer.port}`);
    expect(viewer.url).toBe(`${viewer.origin}${BASE}`);
    expect(new URL(viewer.url).port).toBe(String(viewer.port));
  });
});

describe("IT-23 — close() closes both listeners and a restart works (AC-F10)", () => {
  it("refuses both ports after close() and starts again on the same fixed ports", async () => {
    const hubPort = await freePort();
    let viewerPort = await freePort();
    while (viewerPort === hubPort) viewerPort = await freePort();

    const first = await startHub({
      storePath: storePath(),
      port: hubPort,
      host: "127.0.0.1",
      base: BASE,
      quiet: true,
      journal: "none",
      viewer: viewerOptions({ port: viewerPort }),
    });
    expect(first.port).toBe(hubPort);
    expect(viewerOf(first).port).toBe(viewerPort);

    await expect(first.close()).resolves.toBeUndefined();
    await expectRefused(hubPort);
    await expectRefused(viewerPort);

    const second = await startHub({
      storePath: storePath(),
      port: hubPort,
      host: "127.0.0.1",
      base: BASE,
      quiet: true,
      journal: "none",
      viewer: viewerOptions({ port: viewerPort }),
    });
    servers.push(second);
    expect(second.port).toBe(hubPort);
    expect(viewerOf(second).port).toBe(viewerPort);
    expect((await request(hubPort, `${BASE}/health`)).status).toBe(200);
    expect((await request(viewerPort, `${BASE}/health`)).status).toBe(200);
  });
});

describe("IT-24 — a failed second bind closes the first listener (AC-F12)", () => {
  it("rejects, leaves the hub port refused and allows a later start on that port", async () => {
    const hubPort = await freePort();
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", () => resolve()));
    const address = occupied.address();
    const occupiedPort = typeof address === "object" && address !== null ? address.port : 0;

    try {
      const error = await startRejection({
        storePath: storePath(),
        port: hubPort,
        host: "127.0.0.1",
        base: BASE,
        quiet: true,
        journal: "none",
        viewer: viewerOptions({ port: occupiedPort }),
      });

      // The raw bind error, never a half-built RunningServer.
      expect((error as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
      expect((error as { close?: unknown }).close).toBeUndefined();
      // The hub listener was closed again and no journal outlives the failed start.
      await expectRefused(hubPort);
      expect(activeJournalForTests()).toBeNull();
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }

    const later = await serve({ port: hubPort, viewer: viewerOptions() });
    expect(later.port).toBe(hubPort);
    expect(viewerOf(later).server.listening).toBe(true);
  });
});

describe("IT-26 — viewer warnings on stderr survive --quiet (AC-F13)", () => {
  it("prints the warning, suppresses the progress line, and keeps the deprecated alias warning", async () => {
    const writes: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write");
    stderr.mockImplementation((((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as unknown) as typeof process.stderr.write);

    try {
      // A loopback viewer shares its host name with the hub — the documented shared-cookie case.
      const parsed = parseHubArgs([
        "--store",
        storePath(),
        "--port",
        "0",
        "--quiet",
        "--viewer",
        "--viewer-port",
        "0",
        "--viewer-host",
        "127.0.0.1",
        "--viewer-assets",
        assetsDir(),
        "--viewer-allow",
        "example.com",
        "--admin-secret",
        OPERATOR,
      ]);
      expect(typeof parsed).not.toBe("string");
      servers.push(await startHub(parsed as HubOptions));

      const text = writes.join("");
      expect(text).toContain("WARNING (viewer_cookie_shared_host)");
      // --quiet silences progress chatter, never a safety warning.
      expect(text).not.toContain(" on http://");
      expect(text).not.toContain("note(s), environment");

      // The deprecated alias is the third warning of the same family and obeys the same rule.
      writes.length = 0;
      const alias = parseHubArgs([
        "--store",
        storePath(),
        "--port",
        "0",
        "--quiet",
        "--viewer",
        "--viewer-port",
        "0",
        "--viewer-host",
        "127.0.0.1",
        "--viewer-public-url",
        "https://view.example.com",
        "--viewer-assets",
        assetsDir(),
        "--viewer-allow",
        "example.com",
        "--admin-secret",
        OPERATOR,
      ]);
      expect(typeof alias).not.toBe("string");
      servers.push(await startHub(alias as HubOptions));
      expect(writes.join("")).toContain("WARNING (viewer_public_url_deprecated)");
      expect(writes.join("")).not.toContain(" on http://");
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("IT-27 — the environment starts the same viewer as the flags (AC-F9)", () => {
  it("parses identical options, starts the same origin, and lets a flag win", async () => {
    const store = storePath();
    const assets = assetsDir();
    const flags = parseHubArgs([
      "--store",
      store,
      "--port",
      "0",
      "--viewer",
      "--viewer-port",
      "0",
      "--viewer-host",
      "127.0.0.1",
      "--viewer-origin",
      "https://view.example.com",
      "--viewer-assets",
      assets,
      "--viewer-allow",
      "example.com",
      "--admin-secret",
      OPERATOR,
    ]);
    expect(typeof flags).not.toBe("string");

    await withEnv(
      {
        BLUEPENCIL_VIEWER: "1",
        BLUEPENCIL_VIEWER_PORT: "0",
        BLUEPENCIL_VIEWER_HOST: "127.0.0.1",
        BLUEPENCIL_VIEWER_ORIGIN: "https://view.example.com",
        BLUEPENCIL_VIEWER_ASSETS: assets,
        BLUEPENCIL_VIEWER_ALLOW: "example.com",
        BLUEPENCIL_ADMIN_SECRET: OPERATOR,
      },
      async () => {
        const fromEnv = parseHubArgs(["--store", store, "--port", "0"]);
        expect(typeof fromEnv).not.toBe("string");
        // Identical to the flag spelling, field for field.
        expect((fromEnv as HubOptions).viewer).toEqual((flags as HubOptions).viewer);

        // A flag wins over the environment for every value it names.
        const overridden = parseHubArgs([
          "--store",
          store,
          "--port",
          "0",
          "--viewer-port",
          "0",
          "--viewer-host",
          "127.0.0.1",
          "--viewer-origin",
          "https://flag.example.com",
        ]);
        expect(typeof overridden).not.toBe("string");
        expect((overridden as HubOptions).viewer?.origin).toBe("https://flag.example.com");
        expect((overridden as HubOptions).viewer?.port).toBe(0);
        expect((overridden as HubOptions).viewer?.host).toBe("127.0.0.1");

        const fromEnvServer = await startHub({
          ...(fromEnv as HubOptions),
          journal: "none",
        });
        servers.push(fromEnvServer);
        const fromFlagServer = await startHub({
          ...(flags as HubOptions),
          journal: "none",
        });
        servers.push(fromFlagServer);

        expect(viewerOf(fromEnvServer).origin).toBe("https://view.example.com");
        expect(viewerOf(fromFlagServer).origin).toBe(viewerOf(fromEnvServer).origin);
        expect(viewerOf(fromEnvServer).port).toBeGreaterThan(0);
        expect(viewerOf(fromFlagServer).port).toBeGreaterThan(0);
      },
    );
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Welle 3-B — refusals, limits and the start window                                                */
/* ------------------------------------------------------------------------------------------------ */

describe("IT-35 — cors wildcard with a viewer is refused (AC-F15)", () => {
  it("refuses --cors '*' at parse time", () => {
    expect(parseHubArgs(cliViewerArgs(["--cors", "*"]))).toBe(
      "--cors '*' must not be combined with --viewer (cors_wildcard_with_viewer)",
    );
  });

  it("refuses programmatically before binding when both ports are fixed", async () => {
    const hubPort = await freePort();
    let viewerPort = await freePort();
    while (viewerPort === hubPort) viewerPort = await freePort();

    const error = await startFailure({
      storePath: storePath(),
      port: hubPort,
      host: "127.0.0.1",
      base: BASE,
      quiet: true,
      journal: "none",
      cors: "*",
      viewer: viewerOptions({ port: viewerPort }),
    });
    expect(error.code).toBe("cors_wildcard_with_viewer");
    // Nothing was bound, so neither port may answer.
    await expectRefused(hubPort);
    await expectRefused(viewerPort);
    expect(activeJournalForTests()).toBeNull();
  });

  it("closes both bound listeners when the wildcard only surfaces after listen()", async () => {
    const tracker = trackListens();
    try {
      const error = await startFailure({
        storePath: storePath(),
        port: 0,
        host: "127.0.0.1",
        base: BASE,
        quiet: true,
        journal: "none",
        cors: "*",
        viewer: viewerOptions({ port: 0 }),
      });
      expect(error.code).toBe("cors_wildcard_with_viewer");
      expect(tracker.ports).toHaveLength(2);
      for (const socket of tracker.bound) expect(socket.listening).toBe(false);
      for (const port of tracker.ports) await expectRefused(port);
      expect(activeJournalForTests()).toBeNull();
    } finally {
      tracker.restore();
    }
  });
});

describe("IT-36 — post-listen() origin conflicts leave no listener and no journal (AC-F16)", () => {
  it("closes both sockets, resets the journal and lets the next start write only to <dir2>", async () => {
    const dir1 = tempDir("bp-startup-journal1-");
    const dir2 = tempDir("bp-startup-journal2-");

    // Leg 1 — fixed hub port, ephemeral viewer port: the origin clash is only knowable after both
    // binds, so this is the blind spot of the parse-time check.
    const hubPort = await freePort();
    const hubTracker = trackListens();
    try {
      const sameOrigin = await startFailure({
        storePath: join(dir1, "notes.json"),
        journal: "file",
        journalDir: dir1,
        port: hubPort,
        host: "127.0.0.1",
        base: BASE,
        quiet: true,
        viewer: viewerOptions({ port: 0, origin: `http://127.0.0.1:${hubPort}` }),
      });
      expect(sameOrigin.code).toBe("viewer_origin_is_hub_origin");
      expect(hubTracker.ports).toHaveLength(2);
      for (const socket of hubTracker.bound) expect(socket.listening).toBe(false);
      await expectRefused(hubPort);
      for (const port of hubTracker.ports) await expectRefused(port);
      expect(activeJournalForTests()).toBeNull();
    } finally {
      hubTracker.restore();
    }

    // Leg 2 — ephemeral on both sides: `--cors` names the explicit viewer origin, again only
    // visible after `listen()`.
    const corsTracker = trackListens();
    try {
      const corsClash = await startFailure({
        storePath: join(dir1, "notes-2.json"),
        journal: "file",
        journalDir: dir1,
        port: 0,
        host: "127.0.0.1",
        base: BASE,
        quiet: true,
        cors: "https://view.example.com",
        viewer: viewerOptions({ port: 0, origin: "https://view.example.com" }),
      });
      expect(corsClash.code).toBe("cors_viewer_origin");
      expect(corsTracker.ports).toHaveLength(2);
      for (const socket of corsTracker.bound) expect(socket.listening).toBe(false);
      for (const port of corsTracker.ports) await expectRefused(port);
      expect(activeJournalForTests()).toBeNull();
    } finally {
      corsTracker.restore();
    }

    // No journal file was written into <dir1> by either refused start.
    expect(existsSync(join(dir1, "journal.jsonl"))).toBe(false);

    // The subsequent start lives in <dir2> and writes its history only there.
    const server = await serve({
      storePath: join(dir2, "notes.json"),
      journal: "file",
      journalDir: dir2,
      viewer: viewerOptions(),
    });
    const written = await request(server.port, `${BASE}/notes`, {
      method: "POST",
      body: JSON.stringify({
        type: "bug",
        body: "the cart badge is off by one",
        anchor: { selector: "#cart" },
      }),
    });
    expect(written.status).toBe(200);
    const noteId = (JSON.parse(written.text) as { note?: { id?: string } }).note?.id;
    expect(noteId).toBeTruthy();

    const journalPath = join(dir2, "journal.jsonl");
    expect(existsSync(journalPath)).toBe(true);
    expect(readFileSync(journalPath, "utf8")).toContain(String(noteId));
    expect(existsSync(join(dir1, "journal.jsonl"))).toBe(false);
  });
});

describe("IT-37 — --viewer is a strict boolean (AC-F17)", () => {
  it("turns the viewer off for --viewer=false and BLUEPENCIL_VIEWER=0 without mandatory fields", async () => {
    const off = parseHubArgs(["--store", storePath(), "--viewer=false"]);
    expect(typeof off).not.toBe("string");
    expect((off as HubOptions).viewer).toBeUndefined();

    await withEnv({ BLUEPENCIL_VIEWER: "0" }, () => {
      const fromEnv = parseHubArgs(["--store", storePath()]);
      expect(typeof fromEnv).not.toBe("string");
      expect((fromEnv as HubOptions).viewer).toBeUndefined();
    });
  });

  it("reports viewer_port_required for --viewer=true without a port", () => {
    const required =
      "--viewer requires --viewer-port <port> (viewer_port_required) — the viewer must not share the hub port";
    expect(parseHubArgs(["--store", storePath(), "--viewer=true"])).toBe(required);
    expect(parseHubArgs(["--store", storePath(), "--viewer"])).toBe(required);
  });
});

describe("IT-38 — the viewer TTL is bounded in the CLI and programmatically (AC-F18, AC-F20)", () => {
  it("rejects 59, 604801 and abc in the CLI and accepts both boundaries", () => {
    for (const value of ["59", "604801", "abc"]) {
      const parsed = parseHubArgs(cliViewerArgs(["--viewer-ttl", value]));
      expect(typeof parsed).toBe("string");
      expect(parsed).toContain(
        `--viewer-ttl must be an integer between 60 and 604800 (got "${value}")`,
      );
      expect(parsed).toContain("viewer_ttl_invalid");
    }
    for (const [value, expected] of [
      ["60", 60],
      ["604800", 604_800],
    ] as const) {
      const parsed = parseHubArgs(cliViewerArgs(["--viewer-ttl", value]));
      expect(typeof parsed).not.toBe("string");
      expect((parsed as HubOptions).viewer?.ttlSeconds).toBe(expected);
    }
  });

  it("rejects 59 and 604801 programmatically before any bind and accepts the boundaries", async () => {
    for (const ttlSeconds of [59, 604_801]) {
      const tracker = trackListens();
      try {
        const error = await startFailure({
          storePath: storePath(),
          port: 0,
          host: "127.0.0.1",
          base: BASE,
          quiet: true,
          journal: "none",
          viewer: viewerOptions({ ttlSeconds }),
        });
        expect(error.code).toBe("viewer_ttl_invalid");
        // The TTL is validated by `resolveOptions()`, before `listen()`.
        expect(tracker.callCount()).toBe(0);
      } finally {
        tracker.restore();
      }
    }

    for (const ttlSeconds of [60, 604_800]) {
      const server = await serve({ viewer: viewerOptions({ ttlSeconds }) });
      expect(viewerOf(server).server.listening).toBe(true);
    }
  });
});

describe("IT-39 — ephemeral ports and one port on two bind addresses (AC-F19)", () => {
  it("accepts --port 0 --viewer-port 0, keeps the same-bind conflict, and accepts two binds", () => {
    expect(typeof parseHubArgs(cliViewerArgs(["--port", "0", "--viewer-port", "0"]))).not.toBe(
      "string",
    );
    expect(
      typeof parseHubArgs(
        cliViewerArgs(["--port", "8787", "--viewer-port", "8787", "--viewer-host", "192.0.2.10"]),
      ),
    ).not.toBe("string");
    // The start validation is still in force for the colliding case.
    expect(parseHubArgs(cliViewerArgs(["--port", "8787", "--viewer-port", "8787"]))).toContain(
      "viewer_port_conflict",
    );
  });

  it("starts two listeners whose actual origins differ for port 0 / viewer port 0", async () => {
    const server = await serve({ viewer: viewerOptions({ port: 0 }) });
    expect(viewerOf(server).port).not.toBe(server.port);
    expect(new URL(viewerOf(server).origin).port).not.toBe(String(server.port));
    expect(viewerOf(server).origin).not.toBe(new URL(server.url).origin);
  });

  it("binds the same port number on two different loopback addresses", async () => {
    const port = await freePortOnBothAddresses();
    const server = await serve({
      port,
      host: "127.0.0.1",
      viewer: viewerOptions({ host: "127.0.0.2", port }),
    });
    const viewer = viewerOf(server);

    expect(server.port).toBe(port);
    expect(viewer.port).toBe(port);
    expect(viewer.host).toBe("127.0.0.2");
    expect(viewer.origin).toBe(`http://127.0.0.2:${port}`);
    expect((await request(port, `${BASE}/health`)).status).toBe(200);
    expect((await request(port, `${BASE}/health`, { host: "127.0.0.2" })).status).toBe(200);
  });
});

describe("IT-40 — the deprecated alias must not name the hub origin (AC-F21)", () => {
  it("refuses an alias that is the hub's bind origin", () => {
    expect(parseHubArgs(cliViewerArgs(["--viewer-public-url", "http://127.0.0.1:8787"]))).toBe(
      "--viewer-public-url must differ from the hub origin (viewer_origin_is_hub_origin)",
    );
  });

  it("refuses an alias that names a concrete --cors hub origin", () => {
    expect(
      parseHubArgs(
        cliViewerArgs([
          "--cors",
          "https://hub.example.com",
          "--viewer-public-url",
          "https://hub.example.com",
        ]),
      ),
    ).toBe("--viewer-public-url must differ from the hub origin (viewer_origin_is_hub_origin)");
  });

  it("accepts a scheme-different origin on the hub's host and port (origins compare scheme-sensitively)", () => {
    // AC-F21 is about the *origin*, and §2.4 rule 5 normalizes origins scheme-sensitively: an
    // `https` alias is not the `http` hub bind origin, so it names a distinct, legitimate origin.
    // The corrected AC-F21 therefore pins the refusal case to `http://127.0.0.1:8787` (above).
    const parsed = parseHubArgs(cliViewerArgs(["--viewer-public-url", "https://127.0.0.1:8787"]));
    expect(typeof parsed).not.toBe("string");
    const viewer = (parsed as HubOptions).viewer;
    expect(viewer?.publicBaseUrl).toBe("https://127.0.0.1:8787");
    expect(viewer?.origin).toBe("https://127.0.0.1:8787");
    expect(viewer?.origin).not.toBe("http://127.0.0.1:8787");
  });
});

describe("IT-45 — the start window and the launcher redirect (AC-F22)", () => {
  it("answers 302 with an absolute location for fixed ports (origin resolved before listen())", async () => {
    const hubPort = await freePort();
    let viewerPort = await freePort();
    while (viewerPort === hubPort) viewerPort = await freePort();

    const tracker = trackListens();
    try {
      const inFlight = startHub({
        storePath: storePath(),
        port: hubPort,
        host: "127.0.0.1",
        base: BASE,
        quiet: true,
        journal: "none",
        adminSecret: OPERATOR,
        viewer: viewerOptions({ port: viewerPort }),
      });
      // Fixed ports: `startHub()` resolves the viewer origin before `listen()`, so the launcher
      // already answers `302` while the second bind is still running. This is *not* the strict
      // `503 service_not_ready` window — the next case drives that one (`port 0`, origin unknown).
      await tracker.firstBound;
      const duringStart = await Promise.all([1, 2, 3].map(() => exchange(hubPort, `${BASE}/viewer/start`, {
        headers: { "x-bluepencil-admin": OPERATOR },
      })));

      const server = await inFlight;
      servers.push(server);
      const viewer = viewerOf(server);

      for (const entry of duringStart) {
        expect(entry.error).toBeUndefined();
        const answer = entry.answer as Answer;
        expect(answer.status).toBe(302);
        const location = String(answer.headers.location);
        // Absolute, and on the viewer origin — never relative and never empty.
        expect(new URL(location).origin).toBe(viewer.origin);
        expect(location.startsWith(`${viewer.origin}${BASE}/viewer?ticket=`)).toBe(true);
        expect(answer.headers["cache-control"]).toBe("no-store");
        expect(answer.headers["referrer-policy"]).toBe("no-referrer");
        expect(answer.headers["set-cookie"]).toBeUndefined();
      }

      const afterStart = await launcher(hubPort);
      expect(afterStart.status).toBe(302);
      expect(String(afterStart.headers.location).startsWith(`${viewer.origin}${BASE}/viewer?ticket=`)).toBe(
        true,
      );
    } finally {
      tracker.restore();
    }
  });

  it("answers only 503 service_not_ready in the ephemeral start window, then 302 with an absolute location", async () => {
    // Widens the real window (`port 0`: hub bound, viewer not yet, dispatch still the 503 handler).
    const tracker = trackListens({ delaySecondListenMs: 200 });
    try {
      const inFlight = startHub({
        storePath: storePath(),
        port: 0,
        host: "127.0.0.1",
        base: BASE,
        quiet: true,
        journal: "none",
        adminSecret: OPERATOR,
        viewer: viewerOptions({ port: 0 }),
      });
      const hubPort = await tracker.firstBound;
      const duringStart = await Promise.all(
        [1, 2, 3, 4, 5, 6].map(() =>
          exchange(hubPort, `${BASE}/viewer/start?k=${OPERATOR}`, {}),
        ),
      );

      let answered = 0;
      for (const entry of duringStart) {
        // "503 or no connection" is the documented pair; a 302 without an origin is the failure.
        if (entry.error !== undefined) continue;
        answered += 1;
        const answer = entry.answer as Answer;
        expect(answer.status).toBe(503);
        expect(errorCode(answer)).toBe("service_not_ready");
        expect(answer.headers.location).toBeUndefined();
        expect(answer.headers["set-cookie"]).toBeUndefined();
        expect(answer.headers["cache-control"]).toBe("no-store");
        expect(answer.headers["retry-after"]).toBe("1");
      }
      // The hub was bound before the requests were sent, so at least one reached the window.
      expect(answered).toBeGreaterThan(0);

      const server = await inFlight;
      servers.push(server);
      const afterStart = await launcher(hubPort);
      expect(afterStart.status).toBe(302);
      expect(
        String(afterStart.headers.location).startsWith(
          `${viewerOf(server).origin}${BASE}/viewer?ticket=`,
        ),
      ).toBe(true);
    } finally {
      tracker.restore();
    }
  });
});

describe("IT-46 — the Docker pattern needs an explicit origin (AC-F6, AC-F23)", () => {
  function dockerArgv(extra: string[] = []): string[] {
    return [
      "--store",
      storePath(),
      "--host",
      "0.0.0.0",
      "--viewer",
      "--viewer-port",
      "8788",
      "--viewer-assets",
      assetsDir(),
      "--viewer-allow",
      "example.com",
      "--admin-secret",
      OPERATOR,
      ...extra,
    ];
  }

  it("refuses the entrypoint pattern without --viewer-origin before any bind", () => {
    const parsed = parseHubArgs(dockerArgv());
    expect(typeof parsed).toBe("string");
    expect(parsed).toContain(
      "--viewer-origin is required when the viewer bind is a wildcard address (viewer_origin_required)",
    );
  });

  it("refuses the programmatic wildcard binds before any bind and sets no journal", async () => {
    const tracker = trackListens();
    try {
      const variants: Array<Partial<HubOptions>> = [
        { host: "0.0.0.0", viewer: viewerOptions({ host: undefined, port: 0 }) },
        { host: "::", viewer: viewerOptions({ host: undefined, port: 0 }) },
        { host: "127.0.0.1", viewer: viewerOptions({ host: "0.0.0.0", port: 0 }) },
      ];
      for (const variant of variants) {
        const before = activeJournalForTests();
        const error = await startFailure({
          storePath: storePath(),
          port: 0,
          base: BASE,
          quiet: true,
          journal: "none",
          ...variant,
        });
        expect(error.code).toBe("viewer_origin_required");
        // The refusal runs in `resolveOptions()`, i.e. before `activeJournal = journal`: an earlier
        // module state (a journal left by a successful start in this worker) stays untouched. In a
        // fresh process `before` is `null` — the spec's formulation.
        expect(activeJournalForTests()).toBe(before);
      }
      expect(tracker.callCount()).toBe(0);
    } finally {
      tracker.restore();
    }
  });

  it("starts the same call with an explicit origin and never derives a wildcard origin", async () => {
    const parsed = parseHubArgs(dockerArgv(["--viewer-origin", "https://view.example.com"]));
    expect(typeof parsed).not.toBe("string");
    const options = parsed as HubOptions;
    expect(options.viewer?.origin).toBe("https://view.example.com");
    expect(options.viewer?.port).toBe(8788);
    expect(options.host).toBe("0.0.0.0");

    // Hermetic deviation: the two ports are ephemeral here so the suite cannot collide with a
    // real 8788; the Docker pattern's host, argv and explicit origin are unchanged.
    const server = await serve({
      ...options,
      port: 0,
      quiet: true,
      journal: "none",
      viewer: { ...(options.viewer as NonNullable<HubOptions["viewer"]>), port: 0 },
    });
    const viewer = viewerOf(server);

    expect(viewer.origin).toBe("https://view.example.com");
    expect(viewer.origin).not.toContain("0.0.0.0");
    expect(viewer.origin).not.toContain("[::]");
    expect(viewer.url).toBe(`https://view.example.com${BASE}`);
  });
});
