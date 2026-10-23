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
