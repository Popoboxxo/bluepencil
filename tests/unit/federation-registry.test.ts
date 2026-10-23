/**
 * @vitest-environment node — the loader test writes real files and checks real `fs.stat` modes.
 *
 * Federation registry (FR-16.10, plan §6, Rev. 4). The registry is the security boundary of a
 * federated session, so the tests focus on the two failure modes that matter: a file that must be
 * refused (and refused as a whole, with every issue named) and a file that must never cause network
 * traffic because it carries a literal credential.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FederationError } from "../../src/federation/errors";
import type { HostResolver } from "../../src/federation/net-policy";
import {
  REGISTRY_DEFAULT_CONCURRENCY,
  REGISTRY_DEFAULT_LIMIT,
  REGISTRY_DEFAULT_TIMEOUT_MS,
  RegistryError,
  loadRegistry,
  validateRegistry,
  type RegistryIssue,
  type ValidateRegistryOptions,
} from "../../src/federation/registry";

/* ------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

/** A minimal, valid document; `overrides` replaces or adds top-level keys. */
function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    instances: [{ id: "venue", base: "https://venue.example" }],
    ...overrides,
  };
}

function instance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "venue", base: "https://venue.example", ...overrides };
}

/** Validates a document that must be rejected and returns the collected issues. */
async function issuesOf(
  value: unknown,
  options?: ValidateRegistryOptions,
): Promise<RegistryIssue[]> {
  const result = await validateRegistry(value, options ?? { env: {} });
  if (result.ok) throw new Error("Expected the registry to be rejected, but it validated");
  return result.issues;
}

type AcceptedRegistry = Extract<Awaited<ReturnType<typeof validateRegistry>>, { ok: true }>;

/** Validates a document that must be accepted and returns the registry. */
async function registryOf(
  value: unknown,
  options?: ValidateRegistryOptions,
): Promise<AcceptedRegistry> {
  const result = await validateRegistry(value, options ?? { env: {} });
  if (!result.ok) {
    throw new Error(
      `Expected the registry to validate, got: ${result.issues.map((i) => `${i.path}:${i.code}`).join(", ")}`,
    );
  }
  return result;
}

function codes(issues: readonly RegistryIssue[]): string[] {
  return issues.map((entry) => entry.code);
}

/** A fake resolver backed by a fixed host → addresses map; unknown hosts reject. */
function fakeResolver(table: Record<string, readonly string[]>): {
  resolver: HostResolver;
  calls: string[];
} {
  const calls: string[] = [];
  const resolver: HostResolver = async (hostname: string): Promise<readonly string[]> => {
    calls.push(hostname);
    const addresses = table[hostname];
    if (addresses === undefined) throw new Error(`fake DNS has no entry for ${hostname}`);
    return addresses;
  };
  return { resolver, calls };
}

/** Resolves a promise that must reject and returns whatever it rejected with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to reject, but it resolved");
}

const tempDirs: string[] = [];

/** Writes `content` to a temp file with mode 0600 and returns its path. */
function tempRegistryFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "bp-registry-"));
  tempDirs.push(dir);
  const file = join(dir, "federation.json");
  const text = typeof content === "string" ? content : JSON.stringify(content);
  writeFileSync(file, text, "utf8");
  chmodSync(file, 0o600);
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------------------------------------
 * Minimal load and defaults (T05, Rev. 4)
 * ---------------------------------------------------------------------------------------------- */

describe("registry — minimal load", () => {
  it("registry.loads_minimal", async () => {
    const result = await registryOf(document());

    expect(result.registry.schemaVersion).toBe(1);
    expect(result.registry.defaults).toEqual({
      includeSelf: true,
      mode: "read",
      timeoutMs: REGISTRY_DEFAULT_TIMEOUT_MS,
      concurrency: REGISTRY_DEFAULT_CONCURRENCY,
      limit: REGISTRY_DEFAULT_LIMIT,
      allowedHosts: [],
    });
    expect(result.registry.instances).toEqual([
      { id: "venue", base: "https://venue.example", mode: "read" },
    ]);
    expect(result.registry.instances[0]?.credential).toBeUndefined();
  });

  it("keeps defaults.includeSelf:false and defaults.mode, with a per-instance mode override", async () => {
    const result = await registryOf(
      document({
        defaults: { includeSelf: false, mode: "write" },
        instances: [
          { id: "venue", base: "https://venue.example" },
          { id: "blog", base: "https://blog.example", mode: "read" },
        ],
      }),
    );

    expect(result.registry.defaults.includeSelf).toBe(false);
    expect(result.registry.defaults.mode).toBe("write");
    expect(result.registry.instances.map((entry) => entry.mode)).toEqual(["write", "read"]);
  });

  it("clamps defaults.limit to 1000 instead of rejecting 5000 (T87)", async () => {
    const result = await registryOf(document({ defaults: { limit: 5000 } }));
    expect(result.registry.defaults.limit).toBe(1000);
    expect(REGISTRY_DEFAULT_LIMIT).toBe(200);
  });

  it("normalises base URLs: trailing slashes go, a root base keeps only the origin", async () => {
    const result = await registryOf(
      document({
        instances: [
          { id: "deep", base: "https://h.example/api///" },
          { id: "root", base: "https://h.example/" },
        ],
      }),
    );

    expect(result.registry.instances.map((entry) => entry.base)).toEqual([
      "https://h.example/api",
      "https://h.example",
    ]);
  });
});

/* ------------------------------------------------------------------------------------------------
 * Literal credentials (T06, T34)
 * ---------------------------------------------------------------------------------------------- */

describe("registry — literal credentials", () => {
  const secretNames = ["token", "secret", "password", "authorization", "headers"];

  it("registry.rejects_literal_token at the top level and on an instance", async () => {
    for (const name of secretNames) {
      const topIssues = await issuesOf({ ...document(), [name]: "sk-live-abc" });
      expect(topIssues.some((entry) => entry.code === "literal_secret" && entry.path === name)).toBe(
        true,
      );

      const instanceIssues = await issuesOf(document({ instances: [instance({ [name]: "sk-live" })] }));
      expect(
        instanceIssues.some(
          (entry) => entry.code === "literal_secret" && entry.path === `instances[0].${name}`,
        ),
      ).toBe(true);
      expect(JSON.stringify(instanceIssues)).not.toContain("sk-live");
    }
  });

  it("reports auth:{token: …} as literal_secret, not as an unknown field", async () => {
    const issues = await issuesOf(document({ instances: [instance({ auth: { token: "sk-abc" } })] }));
    expect(codes(issues)).toContain("literal_secret");
    expect(
      issues.some(
        (entry) => entry.code === "literal_secret" && entry.path === "instances[0].auth.token",
      ),
    ).toBe(true);
    expect(JSON.stringify(issues)).not.toContain("sk-abc");
  });

  it("security.registry_literal_secret_rejected never calls the resolver (T34)", async () => {
    const { resolver, calls } = fakeResolver({ "venue.example": ["203.0.113.5"] });

    const issues = await issuesOf(
      document({ instances: [instance({ token: "sk-should-never-leave" })] }),
      { env: {}, resolver },
    );

    expect(codes(issues)).toContain("literal_secret");
    expect(calls).toEqual([]);
  });
});

/* ------------------------------------------------------------------------------------------------
 * Shape and schema (T07, T08, T09, T85)
 * ---------------------------------------------------------------------------------------------- */

describe("registry — shape", () => {
  it("registry.rejects_unknown_field at every level", async () => {
    const topIssues = await issuesOf({ ...document(), extra: true });
    expect(topIssues).toContainEqual(
      expect.objectContaining({ path: "extra", code: "unknown_field" }),
    );

    const defaultIssues = await issuesOf(document({ defaults: { foo: 1 } }));
    expect(defaultIssues).toContainEqual(
      expect.objectContaining({ path: "defaults.foo", code: "unknown_field" }),
    );

    const instanceIssues = await issuesOf(document({ instances: [instance({ mood: "read" })] }));
    expect(instanceIssues).toContainEqual(
      expect.objectContaining({ path: "instances[0].mood", code: "unknown_field" }),
    );
  });

  it("registry.rejects_duplicate_id on the later entry", async () => {
    const issues = await issuesOf(
      document({
        instances: [
          { id: "venue", base: "https://venue.example" },
          { id: "venue", base: "https://venue2.example" },
        ],
      }),
    );

    expect(issues.filter((entry) => entry.code === "duplicate_id")).toHaveLength(1);
    expect(issues).toContainEqual(
      expect.objectContaining({ path: "instances[1].id", code: "duplicate_id" }),
    );
  });

  it("registry.rejects_reserved_id for self, all and *", async () => {
    for (const id of ["self", "all", "*"]) {
      const issues = await issuesOf(document({ instances: [{ id, base: "https://venue.example" }] }));
      expect(issues).toContainEqual(
        expect.objectContaining({ path: "instances[0].id", code: "reserved_id" }),
      );
    }
  });

  it("registry.rejects_unsupported_schema for 2 and for the string \"1\" (T85)", async () => {
    for (const schemaVersion of [2, "1", undefined]) {
      const value = document();
      delete value["schemaVersion"];
      if (schemaVersion !== undefined) value["schemaVersion"] = schemaVersion;

      const issues = await issuesOf(value);
      expect(issues).toContainEqual(
        expect.objectContaining({ path: "schemaVersion", code: "unsupported_schema" }),
      );
    }
  });

  it("rejects a non-object document, a non-array instances field and an empty list", async () => {
    for (const value of [null, 42, [], {}, { schemaVersion: 1 }, { schemaVersion: 1, instances: [] }]) {
      const issues = await issuesOf(value);
      expect(issues.some((entry) => entry.code === "invalid_shape")).toBe(true);
    }
  });

  it("rejects out-of-range defaults with invalid_shape", async () => {
    const cases: Array<Record<string, unknown>> = [
      { timeoutMs: 0 },
      { timeoutMs: 60_001 },
      { concurrency: 0 },
      { concurrency: 17 },
      { limit: 0 },
      { limit: 5001 },
      { includeSelf: "yes" },
      { mode: "admin" },
      { allowedHosts: [""] },
      { allowedHosts: "venue.example" },
    ];

    for (const defaults of cases) {
      const issues = await issuesOf(document({ defaults }));
      expect(issues.some((entry) => entry.code === "invalid_shape")).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------------------------------------
 * Base URL policy (T10, T11, T41/T91/T92, T86)
 * ---------------------------------------------------------------------------------------------- */

describe("registry — base URL policy", () => {
  it("registry.rejects_non_http_url for file, ftp, javascript and data (T10)", async () => {
    for (const base of [
      "file:///etc/passwd",
      "ftp://venue.example",
      "javascript:alert(1)",
      "data:text/plain,hi",
    ]) {
      const issues = await issuesOf(document({ instances: [{ id: "venue", base }] }));
      expect(issues).toContainEqual(
        expect.objectContaining({ path: "instances[0].base", code: "invalid_base_url" }),
      );
    }
  });

  it("registry.rejects_userinfo_url without echoing the credential (T11)", async () => {
    const issues = await issuesOf(
      document({ instances: [{ id: "venue", base: "https://user:sup3rsecret@venue.example" }] }),
    );

    expect(issues).toContainEqual(
      expect.objectContaining({ path: "instances[0].base", code: "invalid_base_url" }),
    );
    expect(issues[0]?.message).toContain("userinfo");
    expect(JSON.stringify(issues)).not.toContain("sup3rsecret");
  });

  it("registry.rejects_query_fragment_url (T86)", async () => {
    for (const [base, reason] of [
      ["https://venue.example/api?x=1", "query"],
      ["https://venue.example/api#frag", "fragment"],
    ] as const) {
      const issues = await issuesOf(document({ instances: [{ id: "venue", base }] }));
      expect(issues[0]?.code).toBe("invalid_base_url");
      expect(issues[0]?.message).toContain(reason);
    }
  });

  it("rejects plain http to a non-loopback host unless allowInsecure is set (T41/T91)", async () => {
    const base = "http://venue.example";
    const rejected = await issuesOf(document({ instances: [{ id: "venue", base }] }));
    expect(rejected[0]?.message).toContain("http_non_loopback");

    const accepted = await registryOf(
      document({ instances: [{ id: "venue", base }] }),
      { env: {}, allowInsecure: true },
    );
    expect(accepted.registry.instances[0]?.base).toBe("http://venue.example");

    // A literal loopback host needs no flag.
    const loopback = await registryOf(
      document({ instances: [{ id: "local", base: "http://127.0.0.1:8080" }] }),
      { env: {} },
    );
    expect(loopback.registry.instances[0]?.base).toBe("http://127.0.0.1:8080");
  });

  it("rejects RFC1918 and ULA addresses without allowInsecure and accepts them with it", async () => {
    for (const base of ["https://10.0.0.5", "https://192.168.1.20", "https://[fd00::1]"]) {
      const rejected = await issuesOf(document({ instances: [{ id: "venue", base }] }));
      expect(rejected[0]?.message).toContain("private_without_allow_insecure");

      const accepted = await registryOf(
        document({ instances: [{ id: "venue", base }] }),
        { env: {}, allowInsecure: true },
      );
      expect(accepted.registry.instances.length).toBe(1);
    }
  });

  it("rejects link-local and metadata targets even with allowInsecure (T92)", async () => {
    for (const [base, reason] of [
      ["https://169.254.169.254", "metadata"],
      ["https://169.254.1.1", "link_local"],
      ["https://metadata.google.internal", "metadata"],
      ["https://[fe80::1]", "link_local"],
    ] as const) {
      const issues = await issuesOf(document({ instances: [{ id: "venue", base }] }), {
        env: {},
        allowInsecure: true,
      });
      expect(issues[0]?.code).toBe("invalid_base_url");
      expect(issues[0]?.message).toContain(reason);
    }
  });

  it("rejects a hostname that resolves to a metadata address even with allowInsecure (T80)", async () => {
    const { resolver, calls } = fakeResolver({ "rebind.example": ["169.254.169.254"] });

    const issues = await issuesOf(
      document({ instances: [{ id: "venue", base: "https://rebind.example" }] }),
      { env: {}, allowInsecure: true, resolver },
    );

    expect(calls).toEqual(["rebind.example"]);
    expect(issues[0]?.code).toBe("invalid_base_url");
    expect(issues[0]?.message).toContain("metadata");
  });

  it("accepts a hostname that resolves to a public address", async () => {
    const { resolver } = fakeResolver({ "public.example": ["203.0.113.5"] });
    const result = await registryOf(
      document({ instances: [{ id: "venue", base: "https://public.example" }] }),
      { env: {}, resolver },
    );
    expect(result.registry.instances[0]?.base).toBe("https://public.example");
  });
});

/* ------------------------------------------------------------------------------------------------
 * Credentials via environment (T12, T13)
 * ---------------------------------------------------------------------------------------------- */

describe("registry — credentials", () => {
  it("registry.requires_env_for_auth for empty, blank and non-string env (T12)", async () => {
    for (const auth of [{}, { env: "" }, { env: 42 }]) {
      const issues = await issuesOf(document({ instances: [instance({ auth })] }));
      expect(issues).toContainEqual(
        expect.objectContaining({ path: "instances[0].auth.env", code: "missing_auth_env" }),
      );
    }
  });

  it("registry.missing_env_is_start_error when the variable is unset or empty (T13)", async () => {
    const value = document({ instances: [instance({ auth: { env: "BP_VENUE_TOKEN" } })] });

    const unset = await issuesOf(value, { env: {} });
    expect(unset).toContainEqual(
      expect.objectContaining({ path: "instances[0].auth.env", code: "missing_env_var" }),
    );

    const empty = await issuesOf(value, { env: { BP_VENUE_TOKEN: "" } });
    expect(empty).toContainEqual(
      expect.objectContaining({ path: "instances[0].auth.env", code: "missing_env_var" }),
    );
  });

  it("resolves credential.value from the injected environment, never from the file", async () => {
    const result = await registryOf(
      document({
        instances: [
          instance({
            auth: { env: "BP_VENUE_TOKEN" },
            tokenHeader: "X-Bluepencil-Token",
            tokenScheme: "Bearer",
          }),
        ],
      }),
      { env: { BP_VENUE_TOKEN: "tok-abc-123" } },
    );

    expect(result.registry.instances[0]?.credential).toEqual({
      env: "BP_VENUE_TOKEN",
      value: "tok-abc-123",
    });
    expect(result.registry.instances[0]?.tokenHeader).toBe("X-Bluepencil-Token");
    expect(result.registry.instances[0]?.tokenScheme).toBe("Bearer");
  });

  it("rejects object-prototype env names and never yields a prototype value (F-23)", async () => {
    for (const envName of ["__proto__", "constructor", "prototype"]) {
      const issues = await issuesOf(
        document({ instances: [instance({ auth: { env: envName } })] }),
        { env: {} },
      );

      expect(issues).toContainEqual(
        expect.objectContaining({ path: "instances[0].auth.env", code: "missing_auth_env" }),
      );
    }
  });

  it("rejects object-prototype tokenHeader names with invalid_shape (F-23)", async () => {
    for (const tokenHeader of ["__proto__", "constructor", "prototype"]) {
      const issues = await issuesOf(
        document({ instances: [instance({ tokenHeader })] }),
        { env: {} },
      );

      expect(issues).toContainEqual(
        expect.objectContaining({ path: "instances[0].tokenHeader", code: "invalid_shape" }),
      );
    }
  });

  it("rejects malformed tokenHeader and tokenScheme with invalid_shape", async () => {
    for (const overrides of [
      { tokenHeader: "bad header" },
      { tokenScheme: "1bearer" },
      { tokenScheme: "" },
    ]) {
      const issues = await issuesOf(document({ instances: [instance(overrides)] }));
      expect(issues.some((entry) => entry.code === "invalid_shape")).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------------------------------------
 * All-or-nothing validation (Rev. 4)
 * ---------------------------------------------------------------------------------------------- */

describe("registry — no partial load", () => {
  it("reports every issue of every instance together", async () => {
    const result = await validateRegistry(
      document({
        defaults: { concurrency: 99 },
        instances: [
          { id: "venue", base: "https://venue.example", auth: { env: "BP_MISSING" } },
          { id: "self", base: "ftp://broken.example", mood: "x" },
        ],
      }),
      { env: {} },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    const found = codes(result.issues);
    expect(found).toContain("invalid_shape");
    expect(found).toContain("missing_env_var");
    expect(found).toContain("reserved_id");
    expect(found).toContain("invalid_base_url");
    expect(found).toContain("unknown_field");
    // A valid instance does not rescue a document with a broken one.
    expect(result.issues.length).toBeGreaterThanOrEqual(5);
  });

  it("keeps the resolved credential value out of issue messages and the RegistryError", async () => {
    const issues = await issuesOf(
      document({
        instances: [
          instance({
            base: "ftp://broken.example",
            auth: { env: "BP_VENUE_TOKEN" },
            token: "sk-literal-secret",
          }),
        ],
      }),
      { env: { BP_VENUE_TOKEN: "tok-never-log-me" } },
    );

    const serialised = JSON.stringify(issues);
    expect(serialised).not.toContain("tok-never-log-me");
    expect(serialised).not.toContain("sk-literal-secret");

    const error = new RegistryError(issues);
    expect(error.message).not.toContain("tok-never-log-me");
    expect(error.message).not.toContain("sk-literal-secret");
    expect(error.issues).toHaveLength(issues.length);
  });
});

/* ------------------------------------------------------------------------------------------------
 * Loading from disk (T79)
 * ---------------------------------------------------------------------------------------------- */

describe("registry — loadRegistry", () => {
  it("loads a 0600 file and resolves credentials from the given environment", async () => {
    const { resolver } = fakeResolver({ "venue.example": ["203.0.113.5"] });
    const file = tempRegistryFile(
      document({ instances: [instance({ auth: { env: "BP_VENUE_TOKEN" } })] }),
    );

    const registry = await loadRegistry(file, { BP_VENUE_TOKEN: "tok-from-env" }, { resolver });

    expect(registry.instances[0]?.credential).toEqual({
      env: "BP_VENUE_TOKEN",
      value: "tok-from-env",
    });
  });

  it("security.registry_tampering rejects group/other-readable files (T79)", async () => {
    const { resolver } = fakeResolver({ "venue.example": ["203.0.113.5"] });
    const file = tempRegistryFile(document());

    chmodSync(file, 0o644);
    const groupReadable = await rejection(loadRegistry(file, {}, { resolver }));
    expect(groupReadable).toBeInstanceOf(FederationError);
    expect((groupReadable as FederationError).code).toBe("invalid_registry");

    chmodSync(file, 0o666);
    const worldWritable = await rejection(loadRegistry(file, {}, { resolver }));
    expect((worldWritable as FederationError).code).toBe("invalid_registry");

    chmodSync(file, 0o600);
    const reloaded = await loadRegistry(file, {}, { resolver });
    expect(reloaded.instances).toHaveLength(1);
  });

  it("uses an injected stat: 0666 fails, 0600 passes, a foreign uid fails (T79)", async () => {
    const { resolver } = fakeResolver({ "venue.example": ["203.0.113.5"] });
    const file = tempRegistryFile(document());

    const unsafe = await rejection(
      loadRegistry(file, {}, { stat: async () => ({ mode: 0o666 }), resolver }),
    );
    expect(unsafe).toBeInstanceOf(FederationError);
    expect((unsafe as FederationError).code).toBe("invalid_registry");

    const safe = await loadRegistry(file, {}, { stat: async () => ({ mode: 0o600 }), resolver });
    expect(safe.schemaVersion).toBe(1);

    /* The ownership branch only exists when the platform exposes getuid and we are not root. */
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      const currentUid = process.getuid();

      const foreign = await rejection(
        loadRegistry(
          file,
          {},
          { stat: async () => ({ mode: 0o600, uid: currentUid + 1 }), resolver },
        ),
      );
      expect(foreign).toBeInstanceOf(FederationError);
      expect((foreign as FederationError).code).toBe("invalid_registry");

      const owned = await loadRegistry(
        file,
        {},
        { stat: async () => ({ mode: 0o600, uid: currentUid }), resolver },
      );
      expect(owned.instances).toHaveLength(1);
    }
  });

  it("checks permissions before reading: a 0644 file with invalid JSON fails as invalid_registry (F-19)", async () => {
    const file = tempRegistryFile("{ this is not json");

    chmodSync(file, 0o644);
    const error = await rejection(loadRegistry(file, {}));

    /* If the read/parse ran first this would be a RegistryError with invalid_json. */
    expect(error).toBeInstanceOf(FederationError);
    expect(error).not.toBeInstanceOf(RegistryError);
    expect((error as FederationError).code).toBe("invalid_registry");
  });

  it("does not read a file whose injected stat is insecure (F-19)", async () => {
    /* The content is deliberately invalid: reaching the parser would produce invalid_json. */
    const file = tempRegistryFile("{ not json either");
    let statCalled = false;

    const error = await rejection(
      loadRegistry(file, {}, {
        stat: async () => {
          statCalled = true;
          return { mode: 0o666 };
        },
      }),
    );

    expect(statCalled).toBe(true);
    expect(error).toBeInstanceOf(FederationError);
    expect(error).not.toBeInstanceOf(RegistryError);
    expect((error as FederationError).code).toBe("invalid_registry");
  });

  it("rejects a base URL outside defaults.allowedHosts (T79)", async () => {
    const issues = await issuesOf(
      document({
        defaults: { allowedHosts: ["allowed.example"] },
        instances: [{ id: "venue", base: "https://other.example" }],
      }),
    );

    expect(issues[0]?.code).toBe("invalid_base_url");
    expect(issues[0]?.message).toContain("host_not_allowed");
  });

  it("security.load_registry_rejects_a_rebinding_hostname with the default resolver (F-01)", async () => {
    /* nip.io maps the embedded address; 169.254.169.254 is the metadata endpoint. Offline CI
     * fails resolution instead — either outcome must be a rejection, never a loaded registry. */
    const file = tempRegistryFile(
      document({ instances: [{ id: "venue", base: "https://169.254.169.254.nip.io" }] }),
    );

    const error = await rejection(loadRegistry(file, {}));

    expect(error).toBeInstanceOf(RegistryError);
    const issues = (error as RegistryError).issues;
    expect(issues.some((entry) => entry.code === "invalid_base_url")).toBe(true);
    expect(JSON.stringify(issues)).toMatch(/metadata|link_local|unresolvable_host/u);
  }, 15_000);

  it("security.resolved_credential_is_not_enumerable_or_serialised (F-02)", async () => {
    const { resolver } = fakeResolver({ "venue.example": ["203.0.113.5"] });
    const file = tempRegistryFile(
      document({ instances: [instance({ auth: { env: "BP_VENUE_TOKEN" } })] }),
    );

    const resolved = await loadRegistry(
      file,
      { BP_VENUE_TOKEN: "tok-json-secret" },
      { resolver },
    );
    const first = resolved.instances[0];
    expect(first).toBeDefined();

    expect(JSON.stringify(resolved)).not.toContain("tok-json-secret");
    expect(JSON.stringify(first)).not.toContain("tok-json-secret");
    expect(JSON.stringify(first)).not.toContain('"value"');
    expect(Object.keys(first!)).not.toContain("credential");
    expect({ ...first }).not.toHaveProperty("credential");

    /* The client still needs the value through direct property access. */
    expect(first?.credential?.value).toBe("tok-json-secret");
  });

  it("accepts an options object as the second argument and reads process.env (F-08)", async () => {
    const previous = process.env["BP_SHIM_TOKEN"];
    process.env["BP_SHIM_TOKEN"] = "tok-from-process-env";
    try {
      const file = tempRegistryFile(
        document({
          instances: [
            {
              id: "local",
              base: "http://127.0.0.1:4319",
              auth: { env: "BP_SHIM_TOKEN" },
            },
          ],
        }),
      );

      /* Plan §6 callers write the options object into the second slot. */
      const registry = await loadRegistry(file, { allowInsecure: true } as any);

      expect(registry.instances[0]?.credential?.value).toBe("tok-from-process-env");
      expect(
        (registry.instances[0]?.credential as { env?: string } | undefined)?.env,
      ).toBe("BP_SHIM_TOKEN");
    } finally {
      if (previous === undefined) delete process.env["BP_SHIM_TOKEN"];
      else process.env["BP_SHIM_TOKEN"] = previous;
    }
  });

  it("reports a missing file as FederationError invalid_registry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bp-registry-"));
    tempDirs.push(dir);
    const missing = join(dir, "does-not-exist.json");

    const error = await rejection(loadRegistry(missing, {}));
    expect(error).toBeInstanceOf(FederationError);
    expect((error as FederationError).code).toBe("invalid_registry");
    expect((error as Error).message).toContain("cannot read registry file");
  });

  it("reports invalid JSON as RegistryError with a single invalid_json issue", async () => {
    const file = tempRegistryFile("{ not json");

    const error = await rejection(loadRegistry(file, {}));
    expect(error).toBeInstanceOf(RegistryError);
    const registryError = error as RegistryError;
    expect(registryError.issues).toHaveLength(1);
    expect(registryError.issues[0]).toMatchObject({ path: "", code: "invalid_json" });
  });

  it("reports an invalid document as RegistryError with all issues", async () => {
    const file = tempRegistryFile(document({ schemaVersion: 2, instances: [instance({ token: "x" })] }));

    const error = await rejection(loadRegistry(file, {}));
    expect(error).toBeInstanceOf(RegistryError);
    const registryError = error as RegistryError;
    expect(codes(registryError.issues)).toContain("unsupported_schema");
    expect(codes(registryError.issues)).toContain("literal_secret");
  });
});

/* ------------------------------------------------------------------------------------------------
 * Barrel
 * ---------------------------------------------------------------------------------------------- */

describe("federation barrel", () => {
  it("re-exports the registry, id, error and net-policy surfaces", async () => {
    const barrel = await import("../../src/federation/index");

    expect(typeof barrel.loadRegistry).toBe("function");
    expect(typeof barrel.validateRegistry).toBe("function");
    expect(typeof barrel.checkBaseUrl).toBe("function");
    expect(typeof barrel.formatQualifiedId).toBe("function");
    expect(barrel.SELF_INSTANCE).toBe("self");
    expect(barrel.REGISTRY_DEFAULT_TIMEOUT_MS).toBe(3000);
    expect(typeof barrel.FederationError).toBe("function");
    expect(barrel.RegistryError).toBe(RegistryError);
  });
});
