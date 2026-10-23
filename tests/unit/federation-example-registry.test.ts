/**
 * @vitest-environment node — the loader stats real files and reads real permission bits.
 *
 * `examples/federation/instances.json` is the registry the aggregating hub in
 * `examples/federation/docker-compose.yml` mounts. Two claims matter:
 *
 *   - the checked-in document is a *valid* registry for exactly `dev` and `staging`, with the
 *     docker-internal bases the compose contract expects;
 *   - it carries no credential value, only `{env:...}` references.
 *
 * Repository trap: the loader refuses anything group or others can read (`(mode & 0o077) !== 0`),
 * and git only tracks the exec bit, so a checked-in fixture arrives as 0644. The test therefore
 * copies it into a fresh temp dir and chmods it to 0600 — the same path `scripts/federation-smoke.mjs`
 * uses. Nothing here touches the network: DNS is an injected resolver, not `node:dns`.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { FederationError } from "../../src/federation/errors";
import type { HostResolver } from "../../src/federation/net-policy";
import {
  loadRegistry,
  loadRegistryFile,
  validateRegistry,
} from "../../src/federation/registry";

/** Resolved from the test file, never from `process.cwd()`. */
const FIXTURE = fileURLToPath(
  new URL("../../examples/federation/instances.json", import.meta.url),
);

/** The environment the aggregator is expected to be given; values never appear in the fixture. */
const ENV: NodeJS.ProcessEnv = {
  BP_DEV_TOKEN: "dev-token-from-test-env",
  BP_STAGING_TOKEN: "staging-token-from-test-env",
};

/** Offline, deterministic and loopback-friendly: docker names never reach a real resolver. */
const LOOPBACK_RESOLVER: HostResolver = async (hostname) => {
  if (hostname === "hub-dev" || hostname === "hub-staging") return ["127.0.0.1"];
  throw new Error(`unexpected host in the example registry: ${hostname}`);
};

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

/** Copies the fixture into a fresh directory and gives it the requested mode. */
function copyFixture(mode: number): string {
  tempDir = mkdtempSync(join(tmpdir(), "bp-example-registry-"));
  const target = join(tempDir, "instances.json");
  writeFileSync(target, readFileSync(FIXTURE, "utf8"), "utf8");
  chmodSync(target, mode);
  return target;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the promise to reject, but it resolved");
}

describe("examples/federation/instances.json", () => {
  it("validates offline and loads through the 0600 copy path", async () => {
    const copy = copyFixture(0o600);

    /* Explicit "no issues" claim: the offline check with only an injected resolver. */
    const result = await validateRegistry(JSON.parse(readFileSync(copy, "utf8")), {
      env: ENV,
      resolver: LOOPBACK_RESOLVER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable: asserted ok above");

    expect(result.registry.instances.map((instance) => instance.id)).toEqual(["dev", "staging"]);

    const registry = await loadRegistry(copy, ENV, { resolver: LOOPBACK_RESOLVER });
    expect(registry.instances.map((instance) => instance.id)).toEqual(["dev", "staging"]);
    /* The hub serves under `BLUEPENCIL_BASE`; a bare origin would make the aggregator call
     * `/config` at the root and fail with 404. The loader's canonical form keeps the path and
     * drops a trailing slash, so these values are exactly what reaches the client. */
    expect(registry.instances.map((instance) => instance.base)).toEqual([
      "http://hub-dev:8787/api/v1/bluepencil",
      "http://hub-staging:8787/api/v1/bluepencil",
    ]);
    for (const instance of registry.instances) {
      expect(instance.base).not.toMatch(/\/$/u);
      expect(instance.base.slice("http://".length)).not.toContain("//");
    }

    /* The aggregator contract: both peers are read-only and resolve their token from the env. */
    expect(registry.defaults.includeSelf).toBe(false);
    expect(registry.defaults.timeoutMs).toBe(3000);
    expect(registry.defaults.concurrency).toBe(4);
    expect(registry.defaults.limit).toBe(200);
    expect(registry.instances[0]?.mode).toBe("read");
    expect(registry.instances[0]?.credential).toEqual({
      env: "BP_DEV_TOKEN",
      value: "dev-token-from-test-env",
    });
    expect(registry.instances[1]?.credential).toEqual({
      env: "BP_STAGING_TOKEN",
      value: "staging-token-from-test-env",
    });
  });

  it("rejects the same document when git leaves it at 0644 (invalid_registry)", async () => {
    const copy = copyFixture(0o644);

    /* Loader path without DNS; the permission gate must fire before the content is validated. */
    const error = await rejection(loadRegistryFile(copy, ENV, { allowInsecure: true }));

    expect(error).toBeInstanceOf(FederationError);
    expect((error as FederationError).code).toBe("invalid_registry");
    expect((error as Error).message).toContain("must not be accessible by group or others");
  });

  it("carries no literal credential — only {env:...} references", () => {
    const raw = readFileSync(FIXTURE, "utf8");
    const document = JSON.parse(raw) as {
      instances: Array<Record<string, unknown>>;
    };

    expect(document.instances).toHaveLength(2);
    for (const instance of document.instances) {
      const auth = instance["auth"] as Record<string, unknown>;
      /* Exactly one key: the env-var name. No token/secret/header field anywhere. */
      expect(Object.keys(auth)).toEqual(["env"]);
      expect(typeof auth["env"]).toBe("string");
      expect(auth["env"]).toMatch(/^[A-Z_][A-Z0-9_]*$/);
    }

    for (const secretKey of [
      "token",
      "secret",
      "password",
      "authorization",
      "headers",
      "apikey",
      "bearer",
      "credential",
    ]) {
      expect(raw.toLowerCase()).not.toContain(`"${secretKey}"`);
    }

    /* No JWT-shaped value and none of the values the test supplies. */
    expect(raw).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(raw).not.toContain("dev-token-from-test-env");
    expect(raw).not.toContain("staging-token-from-test-env");
  });
});
