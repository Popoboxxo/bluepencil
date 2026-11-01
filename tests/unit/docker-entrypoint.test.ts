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
}

/** A tmpdir with a stub `node` that writes the secret it received and exits 0. */
function workspace(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), "bp-entrypoint-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const stub = join(bin, "node");
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s' "\${BLUEPENCIL_AUTH_SECRET:-<unset>}" > "$BP_TEST_ENV_DUMP"\nexit 0\n`,
    "utf8",
  );
  chmodSync(stub, 0o755);
  return { dir, bin, secretFile: join(dir, "auth"), dumpFile: join(dir, "env.dump") };
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  dump: string;
}

function runEntrypoint(space: Workspace, extraEnv: Record<string, string> = {}): Run {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${space.bin}:${process.env.PATH ?? ""}`,
    [DUMP_VARIABLE]: space.dumpFile,
    BLUEPENCIL_SERVER_JS: join(space.dir, "server.js"),
    BLUEPENCIL_STORE: join(space.dir, "notes.json"),
    BLUEPENCIL_SECRET_FILE: space.secretFile,
  };
  // The test process may itself run inside a configured hub; the fixtures decide what is set.
  delete env.BLUEPENCIL_AUTH_SECRET;
  delete env.BLUEPENCIL_TOKEN_KEY;
  Object.assign(env, extraEnv);

  const result = spawnSync("sh", [ENTRYPOINT], { env, encoding: "utf8", timeout: 5_000 });
  expect(result.error).toBeUndefined();
  const dump = existsSync(space.dumpFile) ? readFileSync(space.dumpFile, "utf8") : "";
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", dump };
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
    // (c) both accepted credentials are named, and only the freshly generated value is printed.
    expect(run.stdout).toContain("token (Authorization: Bearer");
    expect(run.stdout).toContain("shared secret (x-bluepencil-auth)");
    expect(run.stdout).toContain(`x-bluepencil-auth: ${stored}`);
    expect(run.stdout).not.toContain(TOKEN_KEY);
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

  it("regenerates and prints a secret once when the secret file is empty", () => {
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
    // Printed exactly once, so the operator can copy it.
    expect(run.stdout.split(`x-bluepencil-auth: ${stored}`).length - 1).toBe(1);
  });
});
