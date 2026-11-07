/**
 * @vitest-environment node — runs `docker/entrypoint.sh` as a real `/bin/sh` child process.
 *
 * The bug this suite pins (#108): with `BLUEPENCIL_TOKEN_KEY` set, the entrypoint skipped the
 * shared-secret block entirely, so a hub that documented both credentials accepted only the token
 * and every client that already held the secret was locked out. The fixture below therefore sets a
 * token key and proves that a secret is still generated, stored and exported.
 *
 * Hermetic on purpose: no Docker and no real hub. A stub `node` earlier on `PATH` records the
 * secret it was started with and exits, so the entrypoint's final `exec` never leaves a process
 * behind, and nothing touches the network.
 *
 * AC-J06 (SEC-12/G12) is pinned here too: the default banner names the secret file and the command
 * that reads it back, and the value itself never reaches stdout — a container log is kept, shipped
 * and pasted around, so a secret printed there outlives the container. Only the explicit opt-in
 * `BLUEPENCIL_SHOW_SECRET_ONCE=1` restores the single echo.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ENTRYPOINT = fileURLToPath(new URL("../../docker/entrypoint.sh", import.meta.url));
const TOKEN_KEY = "fixture-token-key-1";
// Named "value" rather than "secret": these are fixture strings, and a `secret = "…"` shape trips
// the repository's secret scan for the wrong reason.
const EXISTING_VALUE = "hub-fixture-secret-existing-1";
const ENV_VALUE = "hub-fixture-secret-env-1";
const DUMP_VARIABLE = "BP_TEST_ENV_DUMP";
const ARGS_VARIABLE = "BP_TEST_ARGS_DUMP";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface Workspace {
  dir: string;
  bin: string;
  secretFile: string;
  dumpFile: string;
  argsFile: string;
}

/** A tmpdir with a stub `node` that records the secret and arguments it received and exits 0. */
function workspace(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), "bp-entrypoint-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const stub = join(bin, "node");
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s' "\${BLUEPENCIL_AUTH_SECRET:-<unset>}" > "$BP_TEST_ENV_DUMP"\n` +
      `for arg in "$@"; do printf '%s\\n' "$arg"; done > "$BP_TEST_ARGS_DUMP"\nexit 0\n`,
    "utf8",
  );
  chmodSync(stub, 0o755);
  return {
    dir,
    bin,
    secretFile: join(dir, "auth"),
    dumpFile: join(dir, "env.dump"),
    argsFile: join(dir, "args.dump"),
  };
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  dump: string;
  args: string[];
}

function runEntrypoint(space: Workspace, extraEnv: Record<string, string> = {}): Run {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${space.bin}:${process.env.PATH ?? ""}`,
    [DUMP_VARIABLE]: space.dumpFile,
    [ARGS_VARIABLE]: space.argsFile,
    BLUEPENCIL_SERVER_JS: join(space.dir, "server.js"),
    BLUEPENCIL_STORE: join(space.dir, "notes.json"),
    BLUEPENCIL_SECRET_FILE: space.secretFile,
  };
  // The test process may itself run inside a configured hub; the fixtures decide what is set.
  delete env.BLUEPENCIL_AUTH_SECRET;
  delete env.BLUEPENCIL_TOKEN_KEY;
  // Same for the viewer: an inherited port would make the banner test pass or fail by environment.
  for (const name of Object.keys(env)) {
    if (name.startsWith("BLUEPENCIL_VIEWER")) delete env[name];
  }
  Object.assign(env, extraEnv);

  const result = spawnSync("sh", [ENTRYPOINT], { env, encoding: "utf8", timeout: 5_000 });
  expect(result.error).toBeUndefined();
  const dump = existsSync(space.dumpFile) ? readFileSync(space.dumpFile, "utf8") : "";
  const args = existsSync(space.argsFile)
    ? readFileSync(space.argsFile, "utf8").split("\n").filter((line) => line !== "")
    : [];
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", dump, args };
}

describe("docker/entrypoint.sh — the shared secret survives BLUEPENCIL_TOKEN_KEY (#108)", () => {
  it("generates, stores (0600) and exports a secret although a token key is configured", () => {
    const space = workspace();

    const run = runEntrypoint(space, { BLUEPENCIL_TOKEN_KEY: TOKEN_KEY });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(existsSync(space.secretFile)).toBe(true);
    expect(statSync(space.secretFile).mode & 0o777).toBe(0o600);
    const stored = readFileSync(space.secretFile, "utf8");
    expect(stored.length).toBe(64); // 32 random bytes as hex
    // (b) the secret reached the process the entrypoint exec'd.
    expect(run.dump).toBe(stored);
    // (c) both accepted credentials are named, and the generated value stays out of stdout.
    expect(run.stdout).toContain("token (Authorization: Bearer");
    expect(run.stdout).toContain("shared secret (x-bluepencil-auth)");
    expect(run.stdout).toContain(`kept in ${space.secretFile}`);
    expect(run.stdout).not.toContain(stored);
    expect(run.stdout).not.toContain(TOKEN_KEY);
  });

  it("prints the retrieval command instead of the generated secret (AC-J06)", () => {
    const space = workspace();

    const run = runEntrypoint(space);

    expect(run.status).toBe(0);
    const stored = readFileSync(space.secretFile, "utf8");
    // The path and the one command that reads it are the whole default banner.
    expect(run.stdout).toContain(`docker exec <container> cat ${space.secretFile}`);
    expect(run.stdout).not.toContain("x-bluepencil-auth: ");
    expect(run.stdout).not.toContain(stored);
    // Nothing in stdout or stderr repeats any 32-byte hex string the entrypoint could have minted.
    expect(`${run.stdout}${run.stderr}`).not.toMatch(/[0-9a-f]{64}/);
  });

  it("echoes the generated secret exactly once with BLUEPENCIL_SHOW_SECRET_ONCE=1", () => {
    const space = workspace();

    const run = runEntrypoint(space, { BLUEPENCIL_SHOW_SECRET_ONCE: "1" });

    expect(run.status).toBe(0);
    const stored = readFileSync(space.secretFile, "utf8");
    expect(run.stdout.split(`x-bluepencil-auth: ${stored}`).length - 1).toBe(1);
    // The opt-in replaces the retrieval hint for that start.
    expect(run.stdout).not.toContain("docker exec <container>");
  });

  it("does not echo the secret for a non-1 opt-in value", () => {
    const space = workspace();

    const run = runEntrypoint(space, { BLUEPENCIL_SHOW_SECRET_ONCE: "true" });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain(readFileSync(space.secretFile, "utf8"));
    expect(run.stdout).toContain(`docker exec <container> cat ${space.secretFile}`);
  });

  it("reuses an existing secret file unchanged and never prints its value", () => {
    const space = workspace();
    writeFileSync(space.secretFile, EXISTING_VALUE, { mode: 0o600 });
    chmodSync(space.secretFile, 0o600);

    const run = runEntrypoint(space, { BLUEPENCIL_TOKEN_KEY: TOKEN_KEY });

    expect(run.status).toBe(0);
    expect(readFileSync(space.secretFile, "utf8")).toBe(EXISTING_VALUE);
    expect(run.dump).toBe(EXISTING_VALUE);
    expect(run.stdout).toContain(`shared secret (from ${space.secretFile})`);
    // A restart reads the file back on request rather than publishing it in the log.
    expect(run.stdout).toContain(`docker exec <container> cat ${space.secretFile}`);
    expect(run.stdout).not.toContain(EXISTING_VALUE);
  });

  it("names only the shared secret when no token key is configured", () => {
    const space = workspace();

    const run = runEntrypoint(space);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("shared secret (x-bluepencil-auth)");
    // With no token key there is no signing credential to advertise.
    expect(run.stdout).not.toContain("Authorization: Bearer");
  });

  it("uses a handed-in BLUEPENCIL_AUTH_SECRET without writing a file or echoing it", () => {
    const space = workspace();

    const run = runEntrypoint(space, { BLUEPENCIL_AUTH_SECRET: ENV_VALUE });

    expect(run.status).toBe(0);
    expect(existsSync(space.secretFile)).toBe(false);
    expect(run.dump).toBe(ENV_VALUE);
    expect(run.stdout).toContain("shared secret (from BLUEPENCIL_AUTH_SECRET)");
    expect(run.stdout).not.toContain(ENV_VALUE);
  });
});

describe("docker/entrypoint.sh — the viewer is a second listener, off by default", () => {
  it("prints no viewer line when BLUEPENCIL_VIEWER_PORT is unset", () => {
    const run = runEntrypoint(workspace());

    expect(run.status).toBe(0);
    // A default start must not advertise a port it does not serve: the viewer is off unless
    // `--viewer`/`BLUEPENCIL_VIEWER` turns it on.
    expect(run.stdout).not.toMatch(/viewer/i);
  });

  it("names the viewer port and the origin obligation when BLUEPENCIL_VIEWER_PORT is set", () => {
    const space = workspace();

    const run = runEntrypoint(space, {
      BLUEPENCIL_VIEWER: "true",
      BLUEPENCIL_VIEWER_PORT: "8788",
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^ {2}viewer:/m);
    expect(run.stdout).toContain("8788");
    // The entrypoint always binds `--host 0.0.0.0`, which is a wildcard bind: without an explicit
    // origin the hub refuses to start (viewer_origin_required). The banner says so up front.
    expect(run.stdout).toContain("--viewer-origin");
    expect(run.stdout).toContain("--host 0.0.0.0");
    // The banner stays a pointer, never a credential: the secret rules are unchanged.
    expect(run.stdout).not.toMatch(/[0-9a-f]{64}/);
  });

  it("still binds the hub on 0.0.0.0 and adds no viewer flag of its own", () => {
    const space = workspace();

    const run = runEntrypoint(space, {
      BLUEPENCIL_VIEWER: "true",
      BLUEPENCIL_VIEWER_PORT: "8788",
    });

    expect(run.status).toBe(0);
    const host = run.args.indexOf("--host");
    expect(host, "--host is passed to the hub").toBeGreaterThanOrEqual(0);
    expect(run.args[host + 1]).toBe("0.0.0.0");
    // Viewer flags come from "$@" or from the inherited BLUEPENCIL_VIEWER_* env; the entrypoint
    // itself decides nothing about the viewer (spec §9).
    expect(run.args.filter((arg) => arg.startsWith("--viewer"))).toEqual([]);
  });
});

describe("docker/entrypoint.sh — secret-file edge cases", () => {
  it("fails actionably when the secret file cannot be written, even with a token key", () => {
    const space = workspace();
    // A missing parent directory fails on every platform and for root too — unlike a chmod-based
    // read-only fixture, which root silently ignores. This is the read-only-mount failure mode.
    const unwritable = join(space.dir, "read-only-mount", "auth");

    const run = runEntrypoint(space, {
      BLUEPENCIL_TOKEN_KEY: TOKEN_KEY,
      BLUEPENCIL_SECRET_FILE: unwritable,
    });

    expect(run.status).toBe(2);
    expect(existsSync(unwritable)).toBe(false);
    // The operator is told what to do and where, not merely handed the shell's error text.
    expect(run.stderr).toContain(`cannot persist the shared secret to ${unwritable}`);
    expect(run.stderr).toContain("BLUEPENCIL_AUTH_SECRET");
    expect(run.stderr).toContain("BLUEPENCIL_SECRET_FILE");
    expect(run.stderr).toContain("Refusing to start");
    // No secret was exported, because the hub was never started.
    expect(run.dump).toBe("");
    expect(run.stdout).not.toContain("shared secret");
  });

  it("regenerates a secret when the secret file is empty and does not print it", () => {
    const space = workspace();
    // Loose mode on purpose: the regenerated file must end up 0600 regardless of the leftover's.
    writeFileSync(space.secretFile, "", { mode: 0o644 });
    chmodSync(space.secretFile, 0o644);

    const run = runEntrypoint(space, { BLUEPENCIL_TOKEN_KEY: TOKEN_KEY });

    expect(run.status).toBe(0);
    const stored = readFileSync(space.secretFile, "utf8");
    expect(stored.length).toBe(64); // the 0-byte leftover was replaced with a real secret
    expect(statSync(space.secretFile).mode & 0o777).toBe(0o600);
    expect(run.dump).toBe(stored);
    expect(run.stdout).toContain("generated now");
    // Default: path and retrieval command, never the value.
    expect(run.stdout).not.toContain(stored);
    expect(run.stdout).toContain(`docker exec <container> cat ${space.secretFile}`);
  });
});
