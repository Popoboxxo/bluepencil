/**
 * @vitest-environment node — the federator entry point imports `node:url` and the stdio loop.
 *
 * Unit coverage for the federator start-up contract (plan §6/§7, T45/T47/T72). The interesting
 * surface is not "the process starts": it is that the argument parser refuses every half-configured
 * invocation with a usage error (exit 1), and that a registry finding is mapped onto exactly one
 * canonical start-up code — a reserved id is `self_reference`, a duplicate id is `id_collision`, an
 * unset credential is `missing_credential`.
 *
 * `startFederator()` blocks on stdio, so this suite deliberately tests the parser and the mapping
 * only. The wiring over real hubs is covered by `scripts/federation-smoke.mjs`.
 */
import { describe, expect, it } from "vitest";

import {
  FEDERATION_ERROR_CODES,
  FederationError,
  isDegradable,
} from "../../src/federation/errors";
import {
  RegistryError,
  registryStartupError,
  type RegistryErrorCode,
  type RegistryIssue,
} from "../../src/federation/registry";
import { HELP, parseFederatorArgs, type FederatorOptions } from "../../server/federator";

/* ------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

function optionsOf(argv: string[], env: NodeJS.ProcessEnv = {}): FederatorOptions {
  const parsed = parseFederatorArgs(argv, env);
  if (typeof parsed === "string") throw new Error(`expected parsed options, got usage: ${parsed}`);
  return parsed;
}

function usageOf(argv: string[], env: NodeJS.ProcessEnv = {}): string {
  const parsed = parseFederatorArgs(argv, env);
  if (typeof parsed !== "string") throw new Error("expected a usage error, got parsed options");
  return parsed;
}

function registryError(
  code: RegistryErrorCode,
  path = "instances[0]",
): RegistryError {
  const issue: RegistryIssue = {
    path,
    code,
    message: `synthetic ${code} issue`,
  };
  return new RegistryError([issue]);
}

/* ------------------------------------------------------------------------------------------------
 * T45 — argument parsing (usage errors are exit 1)
 * ---------------------------------------------------------------------------------------------- */

describe("T45 cli.federator_startup_exit_codes — argument parsing", () => {
  it("T45 requires --registry or BLUEPENCIL_REGISTRY", () => {
    expect(usageOf([])).toContain("--registry");
    expect(usageOf(["--read-only"])).toContain("--registry");

    const fromEnv = optionsOf([], { BLUEPENCIL_REGISTRY: "/etc/bluepencil/registry.json" });
    expect(fromEnv.registryPath).toBe("/etc/bluepencil/registry.json");
  });

  it("T45 rejects a valued flag without a value (F5)", () => {
    expect(usageOf(["--registry"])).toContain("--registry");
    expect(usageOf(["--registry", "registry.json", "--timeout"])).toContain("--timeout");
    expect(usageOf(["--registry", "registry.json", "--limit"])).toContain("--limit");
  });

  it("T45 rejects --include-self and accepts --no-self as a no-op", () => {
    expect(usageOf(["--include-self"])).toContain("--include-self");
    expect(usageOf(["--registry", "registry.json", "--include-self"])).toContain("--include-self");

    const parsed = optionsOf(["--registry", "registry.json", "--no-self"]);
    expect(parsed.registryPath).toBe("registry.json");
  });

  it("T45 rejects an unknown flag", () => {
    const usage = usageOf(["--registry", "registry.json", "--bogus"]);
    expect(usage).toContain("unknown option");
    expect(usage).toContain("--bogus");
  });

  it("T45 enforces the integer bounds for timeout, concurrency and limit", () => {
    expect(usageOf(["--registry", "registry.json", "--timeout", "0"])).toContain("--timeout");
    expect(usageOf(["--registry", "registry.json", "--timeout", "60001"])).toContain("--timeout");
    expect(usageOf(["--registry", "registry.json", "--concurrency", "0"])).toContain("--concurrency");
    expect(usageOf(["--registry", "registry.json", "--concurrency", "17"])).toContain("--concurrency");
    expect(usageOf(["--registry", "registry.json", "--limit", "0"])).toContain("--limit");
    expect(usageOf(["--registry", "registry.json", "--limit", "1001"])).toContain("--limit");

    const lower = optionsOf([
      "--registry",
      "registry.json",
      "--timeout",
      "1",
      "--concurrency",
      "1",
      "--limit",
      "1",
    ]);
    expect(lower.timeoutMs).toBe(1);
    expect(lower.concurrency).toBe(1);
    expect(lower.limit).toBe(1);

    const upper = optionsOf([
      "--registry",
      "registry.json",
      "--timeout",
      "60000",
      "--concurrency",
      "16",
      "--limit",
      "1000",
    ]);
    expect(upper.timeoutMs).toBe(60_000);
    expect(upper.concurrency).toBe(16);
    expect(upper.limit).toBe(1000);
  });

  it("T45 applies the documented defaults and round-trips every flag", () => {
    const defaults = optionsOf(["--registry", "registry.json"]);
    expect(defaults.appName).toBe("bluepencil federator");
    expect(defaults.readOnly).toBe(false);
    expect(defaults.allowWrite).toBe(false);
    expect(defaults.allowInsecure).toBe(false);
    expect(defaults.clientName).toBeUndefined();
    expect(defaults.sessionId).toBeUndefined();

    const flagged = optionsOf([
      "--registry",
      "/tmp/federation-registry.json",
      "--read-only",
      "--allow-write",
      "--allow-insecure",
      "--timeout",
      "2500",
      "--concurrency",
      "4",
      "--limit",
      "50",
      "--app",
      "review aggregate",
      "--client-name",
      "reviewer-session",
      "--session-id",
      "s-42",
    ]);
    expect(flagged).toMatchObject({
      registryPath: "/tmp/federation-registry.json",
      readOnly: true,
      allowWrite: true,
      allowInsecure: true,
      timeoutMs: 2500,
      concurrency: 4,
      limit: 50,
      appName: "review aggregate",
      clientName: "reviewer-session",
      sessionId: "s-42",
    });
  });

  it("T45 documents the registry, write and self flags and the exit codes in HELP", () => {
    expect(HELP).toContain("--registry");
    expect(HELP).toContain("--allow-write");
    expect(HELP).toContain("--include-self");
    expect(HELP).toContain("--no-self");
    expect(HELP).toContain("Exit codes");
    expect(HELP).toContain("1 usage");
    expect(HELP).toContain("5 partial");
  });
});

/* ------------------------------------------------------------------------------------------------
 * R04 — boolean flags are parsed, not probed
 * ---------------------------------------------------------------------------------------------- */

describe("R04 cli.federator_boolean_flags — explicit true/false values", () => {
  it("R04 reads --flag=true and --flag=false as the corresponding boolean", () => {
    const readOnlyTrue = optionsOf(["--registry", "registry.json", "--read-only=true"]);
    expect(readOnlyTrue.readOnly).toBe(true);

    const readOnlyFalse = optionsOf(["--registry", "registry.json", "--read-only=false"]);
    expect(readOnlyFalse.readOnly).toBe(false);

    const allowWriteTrue = optionsOf(["--registry", "registry.json", "--allow-write=true"]);
    expect(allowWriteTrue.allowWrite).toBe(true);

    const allowInsecureFalse = optionsOf([
      "--registry",
      "registry.json",
      "--allow-insecure=false",
    ]);
    expect(allowInsecureFalse.allowInsecure).toBe(false);
  });

  it("R04 accepts the space-separated form without fail-open (F-02)", () => {
    const allowWriteFalse = optionsOf(["--registry", "registry.json", "--allow-write", "false"]);
    expect(allowWriteFalse.allowWrite).toBe(false);

    const allowWriteTrue = optionsOf(["--registry", "registry.json", "--allow-write", "true"]);
    expect(allowWriteTrue.allowWrite).toBe(true);

    const readOnlyFalse = optionsOf(["--registry", "registry.json", "--read-only", "false"]);
    expect(readOnlyFalse.readOnly).toBe(false);

    const allowInsecureFalse = optionsOf([
      "--registry",
      "registry.json",
      "--allow-insecure",
      "false",
    ]);
    expect(allowInsecureFalse.allowInsecure).toBe(false);

    expect(usageOf(["--registry", "registry.json", "--allow-write", "yes"])).toBe(
      '--allow-write must be true or false (got "yes")',
    );
  });

  it("R04 keeps bare flags true and absent flags false", () => {
    const bare = optionsOf([
      "--registry",
      "registry.json",
      "--read-only",
      "--allow-write",
      "--allow-insecure",
    ]);
    expect(bare.readOnly).toBe(true);
    expect(bare.allowWrite).toBe(true);
    expect(bare.allowInsecure).toBe(true);
  });

  it("R04 rejects a non-boolean value instead of silently treating it as false", () => {
    expect(usageOf(["--registry", "registry.json", "--read-only=yes"])).toBe(
      '--read-only must be true or false (got "yes")',
    );
    expect(usageOf(["--registry", "registry.json", "--allow-write=1"])).toBe(
      '--allow-write must be true or false (got "1")',
    );
    expect(usageOf(["--registry", "registry.json", "--allow-insecure=TRUE"])).toBe(
      '--allow-insecure must be true or false (got "TRUE")',
    );
  });

  it("R04 rejects a value on the bare --no-self no-op", () => {
    expect(usageOf(["--registry", "registry.json", "--no-self=false"])).toContain("--no-self");
  });

  it("R04 --read-only=true still wins over --allow-write", () => {
    const parsed = optionsOf([
      "--registry",
      "registry.json",
      "--read-only=true",
      "--allow-write",
    ]);
    expect(parsed.readOnly).toBe(true);
    expect(parsed.allowWrite).toBe(true);
  });
});

/* ------------------------------------------------------------------------------------------------
 * T47/T45 — canonical mapping of registry findings
 * ---------------------------------------------------------------------------------------------- */

describe("T47 federator.rejects_self_reference — registry finding mapping", () => {
  it("T47 maps a reserved instance id to self_reference", () => {
    const mapped = registryStartupError(registryError("reserved_id", "instances[0].id"));
    expect(mapped).toBeInstanceOf(FederationError);
    expect(mapped.code).toBe("self_reference");
  });
});

describe("T45 cli.federator_startup_exit_codes — registry finding mapping", () => {
  it("T45 maps duplicate ids, unset credentials and blocked URLs to their canonical codes", () => {
    expect(registryStartupError(registryError("duplicate_id", "instances[1].id")).code).toBe(
      "id_collision",
    );
    expect(registryStartupError(registryError("missing_env_var", "instances[0].auth.env")).code).toBe(
      "missing_credential",
    );
    expect(registryStartupError(registryError("invalid_base_url", "instances[0].base")).code).toBe(
      "invalid_base_url",
    );
  });

  it("T45 maps every other registry finding to invalid_registry", () => {
    for (const code of [
      "invalid_shape",
      "invalid_json",
      "unknown_field",
      "unsupported_schema",
      "invalid_id",
      "literal_secret",
      "missing_auth_env",
    ] satisfies RegistryErrorCode[]) {
      expect(registryStartupError(registryError(code)).code).toBe("invalid_registry");
    }
  });

  it("T45 passes an already canonical FederationError through unchanged", () => {
    const original = new FederationError("federates_missing", "instance is not a 0.10 hub");
    expect(registryStartupError(original)).toBe(original);
  });
});

/* ------------------------------------------------------------------------------------------------
 * T72 — only transport failures degrade the start
 * ---------------------------------------------------------------------------------------------- */

describe("T72 federation.startup_unreachable_degraded — degradable codes", () => {
  it("T72 marks only instance_unreachable and timeout as degradable", () => {
    const degradable = FEDERATION_ERROR_CODES.filter(isDegradable).sort();
    expect(degradable).toEqual(["instance_unreachable", "timeout"]);

    for (const code of FEDERATION_ERROR_CODES) {
      expect(isDegradable(code)).toBe(code === "instance_unreachable" || code === "timeout");
    }
  });
});
