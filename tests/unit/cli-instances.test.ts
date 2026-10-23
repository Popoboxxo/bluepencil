/**
 * @vitest-environment node — real registry files with 0600 and real in-process hubs on loopback.
 *
 * Unit/contract coverage for `bluepencil instances validate|list|health` (FR-16.15, plan §7/§8;
 * T30, T42–T45). The suite keeps the two halves apart on purpose:
 *
 *  - `validate`/`list` are offline file checks. A hostname that would need DNS proves that no
 *    resolver runs; a missing env reference still makes the registry invalid.
 *  - `health` is the online probe against two real hubs. One dead peer is exit 5 (degraded), an
 *    identity mismatch is exit 4 (misconfigured), and no credential value may reach stdout or
 *    stderr.
 *
 * No network beyond loopback and no fixed ports (`startHub({ port: 0 })`).
 */
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInstances } from "../../src/cli/instances";
import { startHub, type RunningServer } from "../../server/hub";

/* ------------------------------------------------------------------------------------------------
 * Fixtures and helpers
 * ---------------------------------------------------------------------------------------------- */

const SECRET_VALUE = "secret-value-fe30a91c";
const TOKEN_ENV = "BP_TOKEN";

interface RegistryRow {
  id: string;
  app: string | null;
  base: string;
  mode: "read" | "write";
}

interface RegistryIssueRow {
  path: string;
  code: string;
  message: string;
}

interface ErrorBlock {
  code: string;
  message: string;
}

interface ValidatePayload {
  path: string;
  valid: boolean;
  instances?: RegistryRow[];
  issues?: RegistryIssueRow[];
  error?: ErrorBlock;
}

interface ListFailurePayload {
  path: string;
  instances: RegistryRow[];
  error: ErrorBlock;
}

interface HealthRow {
  id: string;
  app?: string;
  environment?: string;
  ok: boolean;
  unverified?: boolean;
  version?: string;
  code?: string;
}

interface HealthPayload {
  ok: boolean;
  instances: HealthRow[];
  error?: ErrorBlock;
}

interface Capture {
  out: string[];
  err: string[];
  io: { out(text: string): void; err(text: string): void };
}

let tempDir: string | undefined;
let counter = 0;
const servers: RunningServer[] = [];

function makeIo(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (text) => out.push(text), err: (text) => err.push(text) } };
}

function combined(capture: Capture): string {
  return [...capture.out, ...capture.err].join("");
}

function writeRaw(text: string, mode = 0o600): string {
  if (tempDir === undefined) throw new Error("temp dir not initialised");
  counter += 1;
  const path = join(tempDir, `registry-${counter}.json`);
  writeFileSync(path, text, { mode });
  // Explicit: the process umask must not decide whether the file looks unsafe to the loader.
  chmodSync(path, mode);
  return path;
}

function writeRegistry(
  instances: Array<Record<string, unknown>>,
  defaults?: Record<string, unknown>,
): string {
  return writeRaw(
    `${JSON.stringify({
      schemaVersion: 1,
      ...(defaults === undefined ? {} : { defaults }),
      instances,
    })}\n`,
  );
}

function storePath(name: string): string {
  if (tempDir === undefined) throw new Error("temp dir not initialised");
  return join(tempDir, name);
}

async function serve(options: Parameters<typeof startHub>[0]): Promise<RunningServer> {
  const server = await startHub({ port: 0, quiet: true, journal: "none", ...options });
  servers.push(server);
  return server;
}

async function stop(server: RunningServer): Promise<void> {
  const index = servers.indexOf(server);
  if (index >= 0) servers.splice(index, 1);
  await server.close();
}

function baseOf(server: RunningServer): string {
  return server.url;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    try {
      await server.close();
    } catch {
      /* A test may already have closed it; the socket is gone either way. */
    }
  }
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

/* Create the per-test temp directory lazily, so a failing import cannot leak one. */
function ensureTempDir(): void {
  tempDir ??= mkdtempSync(join(tmpdir(), "bp-instances-"));
}

/* ------------------------------------------------------------------------------------------------
 * T42 — validate is an offline file check with canonical exit codes
 * ---------------------------------------------------------------------------------------------- */

describe("T42 cli.instances_validate_exit_codes", () => {
  it("T42 validates a registry and lists its instances as JSON", async () => {
    ensureTempDir();
    const path = writeRegistry([
      {
        id: "venue",
        base: "https://venue.example",
        app: "venue-app",
        auth: { env: "BP_VENUE_TOKEN" },
      },
    ]);
    const capture = makeIo();

    const code = await runInstances(
      ["validate", "--registry", path, "--json"],
      capture.io,
      { ...process.env, BP_VENUE_TOKEN: SECRET_VALUE },
    );

    expect(code).toBe(0);
    const payload = JSON.parse(capture.out.join("")) as ValidatePayload;
    expect(payload.valid).toBe(true);
    expect(payload.instances).toEqual([
      { id: "venue", app: "venue-app", base: "https://venue.example", mode: "read" },
    ]);
    expect(combined(capture)).not.toContain(SECRET_VALUE);
  });

  it("T42 exits 1 when neither --registry nor BLUEPENCIL_REGISTRY is given", async () => {
    const capture = makeIo();
    const code = await runInstances(["validate"], capture.io, {});
    expect(code).toBe(1);
    expect(capture.err.join("")).toContain("--registry");
  });

  it("T42 rejects invalid JSON, unknown fields and unsupported schemas with exit 4", async () => {
    ensureTempDir();
    const cases: Array<{ label: string; path: string; code: string }> = [
      {
        label: "invalid JSON",
        path: writeRaw("{ this is not a registry"),
        code: "invalid_json",
      },
      {
        label: "unknown field",
        path: writeRaw(
          `${JSON.stringify({
            schemaVersion: 1,
            unexpected: true,
            instances: [{ id: "venue", base: "https://venue.example" }],
          })}\n`,
        ),
        code: "unknown_field",
      },
      {
        label: "unsupported schema",
        path: writeRaw(`${JSON.stringify({ schemaVersion: 2, instances: [] })}\n`),
        code: "unsupported_schema",
      },
      {
        label: "literal token",
        path: writeRaw(
          `${JSON.stringify({
            schemaVersion: 1,
            instances: [
              { id: "venue", base: "https://venue.example", token: "literal-secret-value" },
            ],
          })}\n`,
        ),
        code: "literal_secret",
      },
    ];

    for (const entry of cases) {
      const capture = makeIo();
      const code = await runInstances(
        ["validate", "--registry", entry.path, "--json"],
        capture.io,
        {},
      );
      expect(code, entry.label).toBe(4);
      const payload = JSON.parse(capture.out.join("")) as ValidatePayload;
      expect(payload.valid, entry.label).toBe(false);
      expect(
        payload.issues?.some((item) => item.code === entry.code),
        `${entry.label}: ${JSON.stringify(payload.issues)}`,
      ).toBe(true);
    }
  });

  it("T42 refuses a group-readable registry file with exit 4", async () => {
    ensureTempDir();
    const path = writeRegistry([{ id: "venue", base: "https://venue.example" }], undefined);
    chmodSync(path, 0o644);
    const capture = makeIo();

    const code = await runInstances(["validate", "--registry", path], capture.io, {});

    expect(code).toBe(4);
    expect(capture.err.join("")).toContain("must not be accessible by group or others");
  });

  it("T42 validates offline even when a hostname would need DNS (FR-16.15)", async () => {
    ensureTempDir();
    const path = writeRegistry([{ id: "remote", base: "https://does-not-resolve.invalid" }]);
    const capture = makeIo();

    const code = await runInstances(
      ["validate", "--registry", path, "--json"],
      capture.io,
      {},
    );

    // With a resolver this registry would fail as `unresolvable_host`; offline it is valid.
    expect(code).toBe(0);
    const payload = JSON.parse(capture.out.join("")) as ValidatePayload;
    expect(payload.valid).toBe(true);
    expect(payload.instances?.[0]?.base).toBe("https://does-not-resolve.invalid");
  });
});

/* ------------------------------------------------------------------------------------------------
 * R03 — loader failures stay JSON under --json
 * ---------------------------------------------------------------------------------------------- */

describe("R03 cli.instances_json_loader_failures", () => {
  it("R03 validate --json reports an unsafe registry as JSON with exit 4", async () => {
    ensureTempDir();
    const path = writeRegistry([{ id: "venue", base: "https://venue.example" }]);
    chmodSync(path, 0o644);
    const capture = makeIo();

    const code = await runInstances(["validate", "--registry", path, "--json"], capture.io, {});

    expect(code).toBe(4);
    const payload = JSON.parse(capture.out.join("")) as ValidatePayload;
    expect(payload.valid).toBe(false);
    expect(payload.error?.code).toBe("invalid_registry");
    expect(payload.error?.message).toContain("must not be accessible by group or others");
    expect(capture.err.join("")).toBe("");
  });

  it("R03 list --json reports an unsafe registry as JSON with exit 4", async () => {
    ensureTempDir();
    const path = writeRegistry([{ id: "venue", base: "https://venue.example" }]);
    chmodSync(path, 0o644);
    const capture = makeIo();

    const code = await runInstances(["list", "--registry", path, "--json"], capture.io, {});

    expect(code).toBe(4);
    const payload = JSON.parse(capture.out.join("")) as ListFailurePayload;
    expect(payload.instances).toEqual([]);
    expect(payload.error.code).toBe("invalid_registry");
    expect(payload.error.message).toContain("must not be accessible by group or others");
    expect(capture.err.join("")).toBe("");
  });

  it("R03 health --json reports an unsafe registry as JSON with exit 4", async () => {
    ensureTempDir();
    const path = writeRegistry([{ id: "venue", base: "https://venue.example" }]);
    chmodSync(path, 0o644);
    const capture = makeIo();

    const code = await runInstances(
      ["health", "--registry", path, "--json"],
      capture.io,
      {},
    );

    expect(code).toBe(4);
    const payload = JSON.parse(capture.out.join("")) as HealthPayload;
    expect(payload.ok).toBe(false);
    expect(payload.instances).toEqual([]);
    expect(payload.error?.code).toBe("invalid_registry");
    expect(capture.err.join("")).toBe("");
  });

  it("R03 a nonexistent registry path is a JSON failure for every subcommand", async () => {
    ensureTempDir();
    const path = join(tempDir as string, "does-not-exist.json");

    for (const [command, assertPayload] of [
      [
        "validate",
        (payload: Record<string, unknown>) => {
          expect(payload.valid).toBe(false);
          expect(payload.error).toMatchObject({ code: "invalid_registry" });
        },
      ],
      [
        "list",
        (payload: Record<string, unknown>) => {
          expect(payload.instances).toEqual([]);
          expect(payload.error).toMatchObject({ code: "invalid_registry" });
        },
      ],
      [
        "health",
        (payload: Record<string, unknown>) => {
          expect(payload.ok).toBe(false);
          expect(payload.instances).toEqual([]);
          expect(payload.error).toMatchObject({ code: "invalid_registry" });
        },
      ],
    ] as Array<[string, (payload: Record<string, unknown>) => void]>) {
      const capture = makeIo();
      const code = await runInstances([command, "--registry", path, "--json"], capture.io, {});
      expect(code, command).toBe(4);
      const payload = JSON.parse(capture.out.join("")) as Record<string, unknown>;
      assertPayload(payload);
      expect(capture.err.join(""), command).toBe("");
    }
  });
});

/* ------------------------------------------------------------------------------------------------
 * F-06 — the lab registry shape needs --allow-insecure
 * ---------------------------------------------------------------------------------------------- */

describe("F-06 cli.instances_allow_insecure", () => {
  it("F-06 accepts an http lab registry only with --allow-insecure, still offline", async () => {
    ensureTempDir();
    const path = writeRegistry([
      { id: "hub-dev", base: "http://hub-dev:8787/api/v1/bluepencil", app: "dev-app" },
    ]);

    for (const command of ["validate", "list"] as const) {
      const denied = makeIo();
      const deniedCode = await runInstances([command, "--registry", path], denied.io, {});
      expect(deniedCode, `${command} without --allow-insecure`).toBe(4);

      const allowed = makeIo();
      const allowedCode = await runInstances(
        [command, "--registry", path, "--allow-insecure"],
        allowed.io,
        {},
      );
      expect(allowedCode, `${command} with --allow-insecure`).toBe(0);
      expect(combined(allowed)).toContain("hub-dev");
    }
  });

  it("F-06 rejects a non-boolean --allow-insecure value with exit 1", async () => {
    ensureTempDir();
    const path = writeRegistry([{ id: "venue", base: "https://venue.example" }]);
    const capture = makeIo();

    const code = await runInstances(
      ["validate", "--registry", path, "--allow-insecure=yes"],
      capture.io,
      {},
    );

    expect(code).toBe(1);
    expect(capture.err.join("")).toContain("--allow-insecure must be true or false");
  });
});

/* ------------------------------------------------------------------------------------------------
 * T44 — list publishes only id/app/base/mode, never a credential
 * ---------------------------------------------------------------------------------------------- */

describe("T44 cli.instances_list_no_secrets", () => {
  it("T44 lists id, app, base and mode without leaking the credential", async () => {
    ensureTempDir();
    const path = writeRegistry([
      {
        id: "venue",
        base: "https://venue.example",
        app: "venue-app",
        auth: { env: "BP_VENUE_TOKEN" },
      },
      { id: "plain", base: "https://plain.example" },
    ]);
    const capture = makeIo();

    const code = await runInstances(["list", "--registry", path, "--json"], capture.io, {
      ...process.env,
      BP_VENUE_TOKEN: SECRET_VALUE,
    });

    expect(code).toBe(0);
    const rows = JSON.parse(capture.out.join("")) as RegistryRow[];
    expect(rows).toEqual([
      { id: "venue", app: "venue-app", base: "https://venue.example", mode: "read" },
      { id: "plain", app: null, base: "https://plain.example", mode: "read" },
    ]);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["app", "base", "id", "mode"]);
    }
    expect(combined(capture)).not.toContain(SECRET_VALUE);
  });

  it("T44 prints the same fields in human-readable mode without a credential", async () => {
    ensureTempDir();
    const path = writeRegistry([
      {
        id: "venue",
        base: "https://venue.example",
        app: "venue-app",
        mode: "write",
        auth: { env: "BP_VENUE_TOKEN" },
      },
    ]);
    const capture = makeIo();

    const code = await runInstances(["list", "--registry", path], capture.io, {
      ...process.env,
      BP_VENUE_TOKEN: SECRET_VALUE,
    });

    expect(code).toBe(0);
    const text = capture.out.join("");
    expect(text).toContain("venue\tvenue-app\thttps://venue.example\twrite");
    expect(combined(capture)).not.toContain(SECRET_VALUE);
  });

  it("T45 maps an invalid registry to the canonical runtime exit code 4, never 2", async () => {
    ensureTempDir();
    const path = writeRaw("{ not a registry");
    const capture = makeIo();

    const code = await runInstances(["list", "--registry", path], capture.io, {});

    expect(code).toBe(4);
    expect(code).not.toBe(2);
    expect(capture.err.join("")).toContain("Invalid federation registry");
  });
});

/* ------------------------------------------------------------------------------------------------
 * T43/T30 — health probes the real hubs and follows the §7 exit table
 * ---------------------------------------------------------------------------------------------- */

describe("T43 cli.instances_health_exit_codes", () => {
  it("T43 reports two healthy hubs with ok:true and exit 0", async () => {
    ensureTempDir();
    const dev = await serve({
      storePath: storePath("dev.json"),
      appName: "app-a",
      environment: "dev",
    });
    const staging = await serve({
      storePath: storePath("staging.json"),
      appName: "app-b",
      environment: "staging",
    });
    const path = writeRegistry([
      { id: "dev", base: baseOf(dev), app: "app-a" },
      { id: "staging", base: baseOf(staging), app: "app-b" },
    ]);
    const capture = makeIo();

    const code = await runInstances(
      ["health", "--registry", path, "--json", "--timeout", "500"],
      capture.io,
      { ...process.env },
    );

    expect(code).toBe(0);
    const payload = JSON.parse(capture.out.join("")) as HealthPayload;
    expect(payload.ok).toBe(true);
    expect(payload.instances).toHaveLength(2);
    expect(payload.instances.every((row) => row.ok)).toBe(true);
    expect(payload.instances.map((row) => row.environment).sort()).toEqual(["dev", "staging"]);
  });

  it("T43 treats an identity mismatch as a configuration failure (exit 4)", async () => {
    ensureTempDir();
    const hub = await serve({
      storePath: storePath("mismatch.json"),
      appName: "app-a",
      environment: "dev",
    });
    const path = writeRegistry([{ id: "dev", base: baseOf(hub), app: "other" }]);
    const capture = makeIo();

    const code = await runInstances(
      ["health", "--registry", path, "--json", "--timeout", "500"],
      capture.io,
      { ...process.env },
    );

    expect(code).toBe(4);
    const payload = JSON.parse(capture.out.join("")) as HealthPayload;
    expect(payload.ok).toBe(false);
    expect(payload.instances).toHaveLength(1);
    expect(payload.instances[0]?.ok).toBe(false);
    expect(payload.instances[0]?.code).toBe("identity_mismatch");
  });

  it("T43 accepts --check for compatibility against a healthy hub", async () => {
    ensureTempDir();
    const hub = await serve({
      storePath: storePath("check.json"),
      appName: "app-a",
      environment: "dev",
    });
    const path = writeRegistry([{ id: "dev", base: baseOf(hub), app: "app-a" }]);
    const capture = makeIo();

    const code = await runInstances(
      ["health", "--registry", path, "--json", "--check", "--timeout", "500"],
      capture.io,
      { ...process.env },
    );

    expect(code).toBe(0);
    const payload = JSON.parse(capture.out.join("")) as HealthPayload;
    expect(payload.ok).toBe(true);
    expect(payload.instances).toHaveLength(1);
  });
});

describe("T30 e2e.cli_instances_health", () => {
  it("T30 exits 5 when one of two hubs is down and never exposes the token", async () => {
    ensureTempDir();
    const dev = await serve({
      storePath: storePath("dev.json"),
      appName: "app-a",
      environment: "dev",
      authSecret: SECRET_VALUE,
    });
    const staging = await serve({
      storePath: storePath("staging.json"),
      appName: "app-b",
      environment: "staging",
    });
    const path = writeRegistry([
      { id: "dev", base: baseOf(dev), app: "app-a", auth: { env: TOKEN_ENV } },
      { id: "staging", base: baseOf(staging), app: "app-b" },
    ]);
    const env = { ...process.env, [TOKEN_ENV]: SECRET_VALUE };

    const healthy = makeIo();
    const healthyCode = await runInstances(
      ["health", "--registry", path, "--json", "--timeout", "500"],
      healthy.io,
      env,
    );
    expect(healthyCode).toBe(0);
    expect(combined(healthy)).not.toContain(SECRET_VALUE);

    await stop(staging);

    const degraded = makeIo();
    const degradedCode = await runInstances(
      ["health", "--registry", path, "--json", "--timeout", "500"],
      degraded.io,
      env,
    );

    expect(degradedCode).toBe(5);
    const payload = JSON.parse(degraded.out.join("")) as HealthPayload;
    expect(payload.ok).toBe(false);
    expect(payload.instances).toHaveLength(2);

    const devRow = payload.instances.find((row) => row.id === "dev");
    const stagingRow = payload.instances.find((row) => row.id === "staging");
    expect(devRow?.ok).toBe(true);
    expect(stagingRow?.ok).toBe(false);
    expect(typeof stagingRow?.code).toBe("string");
    expect(combined(degraded)).not.toContain(SECRET_VALUE);
  });
});
