/**
 * @vitest-environment node — bundles the hub entry and runs it as a real child process.
 *
 * The hub's documented exit codes (plan §7) live at the process boundary in `server/index.ts`, so
 * they cannot be observed by calling `startHub()`: that function throws, it does not exit. This
 * suite therefore bundles the real entry point with esbuild into a temp directory and spawns it —
 * no `dist/` build is required (CI runs `npm test` before `npm run build`).
 *
 * The contract under test:
 *   - a federation start refusal (`invalid_registry`, `federates_missing`, …) exits **4**, the same
 *     code the federator reports, instead of the generic failure `1`;
 *   - a usage error stays `1` and an unreadable/corrupt store stays `2` (the MCP server's codes);
 *   - `startupExitCode()` is the single mapping used by `main()`.
 *
 * No network beyond loopback: the one fake peer is an in-process `node:http` server.
 */
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { FederationError } from "../../src/federation/errors";
import {
  StoreFileError,
  parseServerArgs,
  startupExitCode,
} from "../../server/index";

const ENTRY = fileURLToPath(new URL("../../server/index.ts", import.meta.url));

let tempDir: string | undefined;
let hub: string | undefined;
const peers: Server[] = [];

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "bp-server-start-"));
  hub = join(tempDir, "hub.mjs");
  await build({
    entryPoints: [ENTRY],
    outfile: hub,
    bundle: true,
    platform: "node",
    format: "esm",
    target: ["node20"],
    /* `scripts/build.mjs` replaces this at build time; the value is irrelevant to the exit code. */
    define: { __BLUEPENCIL_VERSION__: JSON.stringify("0.0.0-test") },
    logLevel: "silent",
  });
}, 30_000);

afterEach(async () => {
  await Promise.all(
    peers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

afterAll(() => {
  if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  hub = undefined;
});

function path(name: string): string {
  if (tempDir === undefined) throw new Error("temp dir not initialised");
  return join(tempDir, name);
}

/** Writes a registry with the requested mode; the loader demands 0600. */
function writeRegistry(name: string, document: unknown, mode = 0o600): string {
  const target = path(name);
  writeFileSync(target, JSON.stringify(document), "utf8");
  chmodSync(target, mode);
  return target;
}

interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the bundled hub to completion. Every case here exits before `listen()`. */
function runHub(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<Outcome> {
  if (hub === undefined) throw new Error("hub bundle not built");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hub as string, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`hub did not exit: stderr=${stderr.slice(0, 200)}`));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Runs the bundled hub until `pattern` appears on stderr, then stops it.
 *
 * A start-up warning is only observable on a process that is *running*: it proves nothing to parse
 * argv and look at a returned array, because the claim is "the operator sees this line". The child
 * is asked to exit with SIGTERM once the line arrives, and every wait is bounded so a regression that
 * removes the warning fails as a timeout rather than hanging the suite.
 */
function runHubUntil(
  args: string[],
  pattern: RegExp,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Outcome> {
  if (hub === undefined) throw new Error("hub bundle not built");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hub as string, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    /* Exactly one SIGTERM. Two signals in one event-loop turn race the `once("SIGTERM")` handler
     * inside `main()`: the second arrives after the handler was consumed and takes the default
     * disposition, so the child dies by signal instead of exiting 0. The poll below and the stderr
     * listener both watch for the pattern, and only one of them may stop the process. */
    let stopping = false;
    const stop = (): void => {
      if (stopping || settled) return;
      stopping = true;
      child.kill("SIGTERM");
    };
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
      resolve({ code, stdout, stderr });
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      child.kill("SIGKILL");
      reject(
        new Error(
          `hub did not report ${String(pattern)} within 10 s: stderr=${stderr.slice(0, 400)}`,
        ),
      );
    }, 10_000);
    /* The server never exits on its own, so the pattern is the only completion signal. Polling the
     * accumulated buffer (rather than the last chunk) also covers a warning split across writes. */
    const poll = setInterval(() => {
      if (pattern.test(stderr)) stop();
    }, 25);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (pattern.test(stderr)) stop();
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
      reject(error);
    });
    child.once("close", (code) => finish(code));
  });
}

/** A peer whose `/config` is valid JSON but omits the boolean `federates` (a pre-0.10 hub). */
async function preFederatedPeer(): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        name: "legacy peer",
        version: "0.9.0",
        base: "/",
        auth: "none",
        readOnly: false,
        environment: "dev",
        app: "legacy-app",
      }),
    );
  });
  peers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no peer port");
  return `http://127.0.0.1:${address.port}`;
}

/** A peer whose `/config` is HTML, not a JSON object (`invalid_response` at start-up). */
async function nonObjectConfigPeer(): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html>not a config</html>");
  });
  peers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no peer port");
  return `http://127.0.0.1:${address.port}`;
}

/* ------------------------------------------------------------------------------------------------
 * Process boundary — the exit codes an operator and CI see
 * ---------------------------------------------------------------------------------------------- */

describe("hub start-up exit codes", () => {
  it("keeps a usage error at exit 1", async () => {
    /* No `--store`: `parseHubArgs` returns the message before `startHub` is called. */
    expect(typeof parseServerArgs([])).toBe("string");

    const outcome = await runHub([]);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("--store <path> is required");
  });

  it("keeps an unreadable/corrupt store at exit 2", async () => {
    const store = path("corrupt-store.json");
    writeFileSync(store, "not json", "utf8");

    const outcome = await runHub(["--store", store, "--port", "0", "--quiet"]);
    expect(outcome.code).toBe(2);
    expect(outcome.stderr).toContain("not a valid note set");
  });

  it("exits 4 for an invalid registry (reserved id `self`)", async () => {
    const registry = writeRegistry("registry-reserved.json", {
      schemaVersion: 1,
      instances: [{ id: "self", base: "http://127.0.0.1:9" }],
    });

    const outcome = await runHub([
      "--store",
      path("reserved-store.json"),
      "--registry",
      registry,
      "--port",
      "0",
      "--quiet",
    ]);
    expect(outcome.code).toBe(4);
    expect(outcome.stderr).toContain("Invalid federation registry");
    expect(outcome.stderr).toContain("reserved_id");
  });

  it("exits 4 for a registry file git left at 0644", async () => {
    const registry = writeRegistry(
      "registry-insecure.json",
      { schemaVersion: 1, instances: [{ id: "dev", base: "http://127.0.0.1:9" }] },
      0o644,
    );

    const outcome = await runHub([
      "--store",
      path("insecure-store.json"),
      "--registry",
      registry,
      "--port",
      "0",
      "--quiet",
    ]);
    expect(outcome.code).toBe(4);
    expect(outcome.stderr).toContain("Registry file");
    expect(outcome.stderr).toContain("must not be accessible by group or others");
  });

  it("exits 4 when a peer does not report `federates` (federates_missing)", async () => {
    const base = await preFederatedPeer();
    const registry = writeRegistry("registry-legacy.json", {
      schemaVersion: 1,
      instances: [{ id: "legacy", base }],
    });

    const outcome = await runHub([
      "--store",
      path("legacy-store.json"),
      "--registry",
      registry,
      "--port",
      "0",
      "--quiet",
    ]);
    expect(outcome.code).toBe(4);
    expect(outcome.stderr).toContain('does not report a boolean "federates"');
  });

  it("exits 4 (not 5) when a peer returns a non-object /config (invalid_response)", async () => {
    const base = await nonObjectConfigPeer();
    const registry = writeRegistry("registry-non-object.json", {
      schemaVersion: 1,
      instances: [{ id: "broken", base }],
    });

    const outcome = await runHub([
      "--store",
      path("non-object-store.json"),
      "--registry",
      registry,
      "--port",
      "0",
      "--quiet",
    ]);
    /* The canonical code is invalid_response (pinned in the mapping matrix below); the hub's
     * message is the client's `GET /config: expected JSON` diagnostic. The exit code is what an
     * operator and CI see, and it must be a refusal (4), never a degraded runtime (5). */
    expect(outcome.code).toBe(4);
    expect(outcome.stderr).toContain("expected JSON");
  });
});

/* ------------------------------------------------------------------------------------------------
 * NFR-22 — a start refusal never echoes a credential
 * ---------------------------------------------------------------------------------------------- */

describe("security.logs_no_secret (T37)", () => {
  const TOKEN_ENV = "BP_SERVER_START_SECRET";
  const TOKEN_VALUE = "server-start-secret-4c1f9a";
  const envWithToken: NodeJS.ProcessEnv = { ...process.env, [TOKEN_ENV]: TOKEN_VALUE };

  it("keeps the token out of a federates_missing start refusal", async () => {
    const base = await preFederatedPeer();
    const registry = writeRegistry("registry-t37.json", {
      schemaVersion: 1,
      instances: [{ id: "legacy", base, auth: { env: TOKEN_ENV } }],
    });

    const outcome = await runHub(
      ["--store", path("t37-store.json"), "--registry", registry, "--port", "0", "--quiet"],
      envWithToken,
    );

    expect(outcome.code).toBe(4);
    expect(outcome.stderr).not.toContain(TOKEN_VALUE);
    expect(outcome.stdout).not.toContain(TOKEN_VALUE);
  });

  it("keeps the token out of an invalid-registry refusal", async () => {
    const registry = writeRegistry("registry-t37-invalid.json", {
      schemaVersion: 1,
      instances: [{ id: "self", base: "http://127.0.0.1:9", auth: { env: TOKEN_ENV } }],
    });

    const outcome = await runHub(
      ["--store", path("t37-invalid-store.json"), "--registry", registry, "--port", "0", "--quiet"],
      envWithToken,
    );

    expect(outcome.code).toBe(4);
    expect(outcome.stderr).not.toContain(TOKEN_VALUE);
    expect(outcome.stdout).not.toContain(TOKEN_VALUE);
  });

  it("keeps --help and --version clean with the token in the environment", async () => {
    for (const flag of ["--help", "--version"] as const) {
      const outcome = await runHub([flag], envWithToken);
      expect(outcome.code).toBe(0);
      expect(outcome.stdout).not.toContain(TOKEN_VALUE);
      expect(outcome.stderr).not.toContain(TOKEN_VALUE);
    }
  });
});

/* ------------------------------------------------------------------------------------------------
 * The single mapping `main()` uses — documented directly so a table regression names itself
 * ---------------------------------------------------------------------------------------------- */

describe("startupExitCode", () => {
  it.each([
    "invalid_registry",
    "invalid_base_url",
    "federates_missing",
    "self_reference",
    "nested_federation",
    "identity_mismatch",
    "missing_credential",
    /* CR-03: fatal start refusals whose runtime column is 5 or 0 must still exit 4. */
    "invalid_response",
    "unverified",
    "not_persisted",
  ] as const)("maps the start refusal %s to 4", (code) => {
    expect(startupExitCode(new FederationError(code, "start refused"))).toBe(4);
  });

  it("keeps usage at 1, store failures at 2 and unknown errors at 1", () => {
    expect(startupExitCode(new FederationError("usage", "bad flag"))).toBe(1);
    expect(startupExitCode(new StoreFileError("corrupt store"))).toBe(2);
    expect(startupExitCode(new Error("unexpected"))).toBe(1);
  });
});

/* ------------------------------------------------------------------------------------------------
 * Start-up safety at the process boundary — what an operator actually sees (G1, G2)
 * ---------------------------------------------------------------------------------------------- */

/** How often a text contains a pattern; a warning that printed twice is a different bug. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("bind warning reaches the operator (AC-D01, AC-D02)", () => {
  it("prints the unauthenticated non-loopback warning once, even with --quiet (AC-D01)", async () => {
    // G1 = B: a non-loopback bind without a credential is allowed — refusing it would break every
    // existing LAN/lab setup — but it can never be silent. `--quiet` silences progress chatter, and
    // this line is deliberately not progress chatter.
    const outcome = await runHubUntil(
      [
        "--store",
        path("warn-store.json"),
        "--host",
        "0.0.0.0",
        "--port",
        "0",
        "--journal",
        "none",
        "--quiet",
      ],
      /unauthenticated_non_loopback/,
    );

    expect(outcome.code).toBe(0);
    expect(count(outcome.stderr, "unauthenticated_non_loopback")).toBe(1);
    expect(outcome.stderr).toContain("not suppressed by --quiet");
    // The proof that the warning is outside the gated block: the informational line is gone.
    expect(outcome.stderr).not.toContain("note(s), environment");
  });

  it("says nothing for a loopback bind without a credential (AC-D02)", async () => {
    const outcome = await runHubUntil(
      ["--store", path("quiet-store.json"), "--host", "127.0.0.1", "--port", "0", "--journal", "none"],
      /note\(s\), environment/,
    );

    expect(outcome.stderr).toContain("reachable on this machine only");
    expect(outcome.stderr).not.toContain("unauthenticated_non_loopback");
  });

  it("says nothing for a network bind that has a credential (AC-D02)", async () => {
    const outcome = await runHubUntil(
      [
        "--store",
        path("gated-store.json"),
        "--host",
        "0.0.0.0",
        "--port",
        "0",
        "--journal",
        "none",
        "--auth-secret",
        "server-start-shared-value-1",
      ],
      /note\(s\), environment/,
    );

    expect(outcome.stderr).toContain("reachable from the network");
    expect(outcome.stderr).not.toContain("unauthenticated_non_loopback");
    expect(outcome.stderr).not.toContain("server-start-shared-value-1");
  });
});

describe("credential floors and CORS rules at the process boundary (AC-D07…AC-D09)", () => {
  it("refuses a 15-character --auth-secret with exit 1 (AC-D07)", async () => {
    const outcome = await runHub([
      "--store",
      path("floor-secret-store.json"),
      "--auth-secret",
      "s".repeat(15),
      "--port",
      "0",
      "--quiet",
    ]);

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("secret_too_short");
  });

  it("refuses a 31-character --token-key with exit 1 (AC-D08)", async () => {
    const outcome = await runHub([
      "--store",
      path("floor-key-store.json"),
      "--token-key",
      "k".repeat(31),
      "--port",
      "0",
      "--quiet",
    ]);

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("token_key_too_short");
  });

  it("refuses a bare --cors with exit 1 (AC-D09)", async () => {
    const outcome = await runHub([
      "--store",
      path("cors-missing-store.json"),
      "--cors",
      "--port",
      "0",
      "--quiet",
    ]);

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("cors_value_missing");
  });

  it("refuses --cors '*' without a credential with exit 1 (AC-D09)", async () => {
    const outcome = await runHub([
      "--store",
      path("cors-wildcard-store.json"),
      "--cors",
      "*",
      "--port",
      "0",
      "--quiet",
    ]);

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("cors_wildcard_unauthenticated");
  });

  it("starts with an explicit --cors origin and no credential, unchanged (AC-D09)", async () => {
    const outcome = await runHubUntil(
      [
        "--store",
        path("cors-origin-store.json"),
        "--cors",
        "https://app.example",
        "--port",
        "0",
        "--journal",
        "none",
      ],
      /note\(s\), environment/,
    );

    expect(outcome.stderr).not.toContain("cors_value_missing");
    expect(outcome.stderr).not.toContain("cors_wildcard_unauthenticated");
    expect(outcome.stderr).not.toContain("cors_wildcard");
  });

  it("starts with --cors '*' behind a credential and warns about the wildcard (AC-D09)", async () => {
    const outcome = await runHubUntil(
      [
        "--store",
        path("cors-gated-store.json"),
        "--cors",
        "*",
        "--auth-secret",
        "server-start-shared-value-1",
        "--port",
        "0",
        "--journal",
        "none",
        "--quiet",
      ],
      /cors_wildcard/,
    );

    expect(outcome.code).toBe(0);
    expect(count(outcome.stderr, "WARNING (cors_wildcard)")).toBe(1);
    expect(outcome.stderr).toContain("every origin");
  });
});

describe("dual listener lifecycle at the process boundary (plan Task 9)", () => {
  /** A port that was free a moment ago; the child is expected to release it again. */
  async function freePort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
    const address = probe.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }

  /** True when nothing listens on `port` any more — the proof that a start left no half-open state. */
  async function isFree(port: number): Promise<boolean> {
    const probe = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(port, "127.0.0.1", () => resolve());
      });
      return true;
    } catch {
      return false;
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  }

  /** A complete, valid viewer command line; the assets stub lives in the shared temp dir. */
  function viewerArgs(
    storePath: string,
    hubPort: number,
    viewerPort: number,
    host = "127.0.0.1",
  ): string[] {
    writeFileSync(path("bluepencil.element.min.js"), "// stub\n");
    return [
      "--store",
      storePath,
      "--port",
      String(hubPort),
      "--host",
      host,
      "--journal",
      "none",
      "--viewer",
      "--viewer-port",
      String(viewerPort),
      "--viewer-assets",
      tempDir as string,
      "--viewer-allow",
      "example.com",
      "--admin-secret",
      "server-start-operator-secret",
      "--quiet",
    ];
  }

  it("exits 1 when the viewer bind fails and leaves the hub listener closed (AC-F12)", async () => {
    const hubPort = await freePort();
    const taken = createServer();
    peers.push(taken);
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", () => resolve()));
    const takenAddress = taken.address();
    const takenPort =
      typeof takenAddress === "object" && takenAddress !== null ? takenAddress.port : 0;

    const outcome = await runHub(viewerArgs(path("lifecycle-store.json"), hubPort, takenPort));

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("EADDRINUSE");
    expect(await isFree(hubPort)).toBe(true);
  });

  it("exits 1 with viewer_origin_required before any bind (AC-F23)", async () => {
    const hubPort = await freePort();
    const outcome = await runHub(
      viewerArgs(path("lifecycle-wildcard.json"), hubPort, 0, "0.0.0.0"),
    );

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("viewer_origin_required");
    expect(await isFree(hubPort)).toBe(true);
  });
});
