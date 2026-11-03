/**
 * @vitest-environment node — starts real sockets and reads real files, which jsdom cannot.
 *
 * Hub options, the `/config` contract and the local `/notes` boundary (FR-6.15, FR-16.3/16.14).
 *
 * What is proven here:
 *   - `parseHubArgs` accepts the 0.10 flags and their environment fallbacks, with the flag winning;
 *   - the mutually exclusive self flags and the numeric ranges are usage errors, not silent defaults;
 *   - a hub without a registry reports `app` (default, `--app`, `BLUEPENCIL_APP`) and `federates:false`
 *     (T21, T82), and `/config` carries no credential (T53);
 *   - `/notes` stays the local single-environment contract without `instance` fields (T22, T54).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { request as nodeRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BASE_PATH, HUB_APP_NAME } from "../../server/handler";
import {
  SECRET_MIN_LENGTH,
  TOKEN_KEY_MIN_LENGTH,
  isLoopbackBind,
  parseHubArgs,
  startHub,
  startupWarnings,
  type HubOptions,
  type RunningServer,
} from "../../server/hub";

const BASE = DEFAULT_BASE_PATH;
/** Kept as a constant: a literal after `authSecret:` trips the secret scan for the wrong reason. */
const SHARED = "hub-options-shared-value";
const ENV_KEYS = [
  "BLUEPENCIL_APP",
  "BLUEPENCIL_REGISTRY",
  /* The credential variables are cleared too: a floor test that inherited one from the shell would
   * pass or fail for the wrong reason. */
  "BLUEPENCIL_AUTH_SECRET",
  "BLUEPENCIL_ADMIN_SECRET",
  "BLUEPENCIL_TOKEN_KEY",
] as const;

type Json = Record<string, unknown>;

let tempDir: string | undefined;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
const servers: RunningServer[] = [];

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv = {};
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function tempStorePath(): string {
  tempDir = mkdtempSync(join(tmpdir(), "bp-hub-options-"));
  return join(tempDir, "notes.bluepencil.json");
}

function optionsOf(result: HubOptions | string): HubOptions {
  if (typeof result === "string") throw new Error(`expected options, got usage error: ${result}`);
  return result;
}

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Json }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = nodeRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers:
          payload === undefined
            ? {}
            : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () =>
          resolvePromise({
            status: response.statusCode ?? 0,
            body: text === "" ? {} : (JSON.parse(text) as Json),
          }),
        );
      },
    );
    req.on("error", rejectPromise);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function serve(options: HubOptions): Promise<{ server: RunningServer; config: Json }> {
  const server = await startHub({ port: 0, quiet: true, ...options });
  servers.push(server);
  const config = await request(server.port, "GET", `${BASE}/config`);
  return { server, config: config.body };
}

describe("parseHubArgs — federation flags", () => {
  it("accepts the new flags and stores them", () => {
    const parsed = optionsOf(
      parseHubArgs([
        "--store",
        "notes.json",
        "--app",
        "Review Pad",
        "--registry",
        "/etc/bluepencil/registry.json",
        "--include-self",
        "--allow-write",
        "--allow-insecure",
        "--timeout",
        "5000",
        "--concurrency",
        "4",
        "--limit",
        "100",
      ]),
    );

    expect(parsed).toMatchObject({
      appName: "Review Pad",
      registry: "/etc/bluepencil/registry.json",
      includeSelf: true,
      allowWrite: true,
      allowInsecure: true,
      timeoutMs: 5000,
      concurrency: 4,
      limit: 100,
    });
  });

  it("reads BLUEPENCIL_APP and BLUEPENCIL_REGISTRY, with the flag winning", () => {
    process.env.BLUEPENCIL_APP = "Env Pad";
    process.env.BLUEPENCIL_REGISTRY = "/env/registry.json";

    expect(optionsOf(parseHubArgs(["--store", "notes.json"]))).toMatchObject({
      appName: "Env Pad",
      registry: "/env/registry.json",
    });

    expect(
      optionsOf(
        parseHubArgs([
          "--store",
          "notes.json",
          "--app",
          "Flag Pad",
          "--registry",
          "/flag/registry.json",
        ]),
      ),
    ).toMatchObject({ appName: "Flag Pad", registry: "/flag/registry.json" });
  });

  it("treats --no-self as an explicit false and rejects both self flags", () => {
    const noSelf = optionsOf(parseHubArgs(["--store", "notes.json", "--no-self"]));
    expect(noSelf.includeSelf).toBe(false);

    const neither = optionsOf(parseHubArgs(["--store", "notes.json"]));
    expect(neither.includeSelf).toBeUndefined();

    expect(String(parseHubArgs(["--store", "notes.json", "--include-self", "--no-self"]))).toContain(
      "--include-self and --no-self are mutually exclusive",
    );
  });

  it("rejects empty --app and empty --registry values instead of falling back", () => {
    expect(String(parseHubArgs(["--store", "notes.json", "--app="]))).toContain(
      "--app must not be empty",
    );
    expect(String(parseHubArgs(["--store", "notes.json", "--app", "   "]))).toContain(
      "--app must not be empty",
    );
    expect(String(parseHubArgs(["--store", "notes.json", "--registry="]))).toContain(
      "--registry must not be empty",
    );

    process.env.BLUEPENCIL_APP = "";
    expect(String(parseHubArgs(["--store", "notes.json"]))).toContain("--app must not be empty");
  });

  it("rejects a present flag without a value instead of treating it as absent (F5)", () => {
    expect(String(parseHubArgs(["--store", "x", "--registry"]))).toContain(
      "--registry requires a value",
    );
    expect(String(parseHubArgs(["--store", "x", "--app"]))).toContain("--app requires a value");
    expect(String(parseHubArgs(["--store", "x", "--timeout"]))).toContain(
      "--timeout requires a value",
    );
  });

  it("leaves aggregate defaults unset when the flags are absent, so the registry can supply them", () => {
    const parsed = optionsOf(parseHubArgs(["--store", "notes.json"]));
    // Absent must stay absent: `startHub` then applies registry.defaults > built-in constants
    // (CLI > registry > constant). A hard-coded default here would silently win over the registry.
    expect(parsed.timeoutMs).toBeUndefined();
    expect(parsed.concurrency).toBeUndefined();
    expect(parsed.limit).toBeUndefined();

    const explicit = optionsOf(parseHubArgs(["--store", "notes.json", "--timeout", "250"]));
    expect(explicit.timeoutMs).toBe(250);
    expect(explicit.concurrency).toBeUndefined();
    expect(explicit.limit).toBeUndefined();
  });

  it("rejects out-of-range timeout, concurrency and limit values", () => {
    // F6: the timeout is capped at the same 60 s the registry file accepts.
    for (const value of ["0", "-1", "abc", "1.5", "60001"]) {
      expect(String(parseHubArgs(["--store", "n.json", "--timeout", value]))).toContain(
        "--timeout must be an integer between 1 and 60000",
      );
    }
    for (const value of ["0", "17", "-1", "abc"]) {
      expect(String(parseHubArgs(["--store", "n.json", "--concurrency", value]))).toContain(
        "--concurrency must be an integer between 1 and 16",
      );
    }
    for (const value of ["0", "1001", "-1", "abc"]) {
      expect(String(parseHubArgs(["--store", "n.json", "--limit", value]))).toContain(
        "--limit must be an integer between 1 and 1000",
      );
    }
  });
});

describe("parseHubArgs — strict boolean flags (F-04)", () => {
  const parse = (args: string[]): HubOptions | string =>
    parseHubArgs(["--store", "notes.json", ...args]);

  it("keeps every bare flag true", () => {
    expect(optionsOf(parse(["--read-only", "--allow-write", "--allow-insecure"]))).toMatchObject({
      readOnly: true,
      allowWrite: true,
      allowInsecure: true,
    });
    expect(optionsOf(parse(["--allow-env-mismatch", "--quiet"]))).toMatchObject({
      allowEnvMismatch: true,
      quiet: true,
    });
  });

  it("parses --allow-write=false/true and rejects non-boolean values (no fail-open)", () => {
    expect(optionsOf(parse(["--allow-write", "false"])).allowWrite).toBe(false);
    expect(optionsOf(parse(["--allow-write=false"])).allowWrite).toBe(false);
    expect(optionsOf(parse(["--allow-write=true"])).allowWrite).toBe(true);

    expect(parse(["--allow-write=yes"])).toBe(
      '--allow-write must be true or false (got "yes")',
    );
    expect(parse(["--allow-write", "yes"])).toBe(
      '--allow-write must be true or false (got "yes")',
    );
  });

  it("parses --read-only=false and --allow-insecure false", () => {
    expect(optionsOf(parse(["--read-only=false"])).readOnly).toBe(false);
    expect(optionsOf(parse(["--allow-insecure", "false"])).allowInsecure).toBe(false);
  });

  it("maps --include-self/--no-self values onto includeSelf", () => {
    expect(optionsOf(parse(["--include-self=false"])).includeSelf).toBe(false);
    expect(optionsOf(parse(["--include-self=true"])).includeSelf).toBe(true);
    expect(optionsOf(parse(["--no-self=false"])).includeSelf).toBe(true);
    expect(optionsOf(parse(["--no-self=true"])).includeSelf).toBe(false);

    expect(String(parse(["--include-self=false", "--no-self=true"]))).toContain(
      "--include-self and --no-self are mutually exclusive",
    );
  });

  it("parses --allow-env-mismatch=false and --quiet=false", () => {
    expect(optionsOf(parse(["--allow-env-mismatch=false"])).allowEnvMismatch).toBe(false);
    expect(optionsOf(parse(["--quiet=false"])).quiet).toBe(false);
  });
});

describe("GET {base}/config — identity and federation flag", () => {
  it("reports the default app and federates:false without a registry (T21, T82)", async () => {
    const { config } = await serve({ storePath: tempStorePath() });

    expect(config["app"]).toBe(HUB_APP_NAME);
    expect(config["federates"]).toBe(false);
  });

  it("reports the --app value and the BLUEPENCIL_APP fallback (T82)", async () => {
    const fromFlag = await serve({ storePath: tempStorePath(), appName: "Review Pad" });
    expect(fromFlag.config["app"]).toBe("Review Pad");

    process.env.BLUEPENCIL_APP = "Env Pad";
    const parsed = optionsOf(
      parseHubArgs(["--store", tempStorePath(), "--port", "0", "--quiet"]),
    );
    const fromEnv = await serve(parsed);
    expect(fromEnv.config["app"]).toBe("Env Pad");
    expect(fromEnv.config["federates"]).toBe(false);
  });

  it("never carries the shared secret or token key (T53)", async () => {
    const { config } = await serve({
      storePath: tempStorePath(),
      authSecret: SHARED,
      tokenKey: "hub-options-token-key",
    });

    const text = JSON.stringify(config);
    expect(config["auth"]).toBe("token");
    expect(text).not.toContain(SHARED);
    expect(text).not.toContain("hub-options-token-key");
    expect(config).not.toHaveProperty("authSecret");
    expect(config).not.toHaveProperty("tokenKey");
  });
});

describe("start-up diagnostics", () => {
  it("warns once on stderr when --allow-insecure is active (O3)", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const server = await startHub({ storePath: tempStorePath(), port: 0, allowInsecure: true });
      servers.push(server);
    } finally {
      spy.mockRestore();
    }

    const warnings = writes.filter((line) => line.includes("--allow-insecure"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("link-local and metadata stay blocked");
  });
});

describe("GET {base}/notes — still the local single-environment contract", () => {
  it("returns local notes without instance fields and with one environment (T22, T54)", async () => {
    const { server } = await serve({ storePath: tempStorePath() });

    const created = await request(server.port, "POST", `${BASE}/notes`, {
      type: "text",
      body: "local only",
      anchor: { route: "/cart", selector: "#total" },
    });
    expect(created.status).toBe(200);

    const listed = await request(server.port, "GET", `${BASE}/notes`);
    expect(listed.status).toBe(200);
    const notes = listed.body["notes"] as Json[];
    expect(notes).toHaveLength(1);
    expect(notes[0]?.["body"]).toBe("local only");
    expect(notes[0]).not.toHaveProperty("instance");

    const environments = new Set(notes.map((note) => note["environment"]));
    expect(environments).toEqual(new Set(["dev"]));
  });
});

/* ------------------------------------------------------------------------------------------------
 * Start-up safety: credential floors, CORS rules and the warning that --quiet cannot silence
 * (G1, G2; AC-D01, AC-D02, AC-D07…AC-D09)
 * ---------------------------------------------------------------------------------------------- */

/** A `--auth-secret` of exactly `length` characters; never a real credential. */
function secretOf(length: number): string {
  return "s".repeat(length);
}

describe("credential floors (G2, AC-D07/AC-D08)", () => {
  const parse = (args: string[]): HubOptions | string =>
    parseHubArgs(["--store", "notes.json", ...args]);

  it("refuses a 15-character --auth-secret and accepts 16 (AC-D07)", () => {
    expect(String(parse(["--auth-secret", secretOf(SECRET_MIN_LENGTH - 1)]))).toContain(
      "secret_too_short",
    );
    expect(optionsOf(parse(["--auth-secret", secretOf(SECRET_MIN_LENGTH)])).authSecret).toHaveLength(
      SECRET_MIN_LENGTH,
    );
    // The message says what to do, not only that something is wrong.
    expect(String(parse(["--auth-secret", secretOf(6)]))).toContain(
      `at least ${SECRET_MIN_LENGTH} characters`,
    );
  });

  it("refuses a 31-character --token-key and accepts 32 (AC-D08)", () => {
    expect(String(parse(["--token-key", secretOf(TOKEN_KEY_MIN_LENGTH - 1)]))).toContain(
      "token_key_too_short",
    );
    expect(optionsOf(parse(["--token-key", secretOf(TOKEN_KEY_MIN_LENGTH)])).tokenKey).toHaveLength(
      TOKEN_KEY_MIN_LENGTH,
    );
  });

  it("applies the floors to the environment variables, not only to the flags", () => {
    // A hub started from a compose file has no flag in its argv; the floor has to hold there too.
    process.env.BLUEPENCIL_AUTH_SECRET = secretOf(SECRET_MIN_LENGTH - 1);
    expect(String(parse([]))).toContain("secret_too_short");

    process.env.BLUEPENCIL_AUTH_SECRET = secretOf(SECRET_MIN_LENGTH);
    process.env.BLUEPENCIL_TOKEN_KEY = secretOf(TOKEN_KEY_MIN_LENGTH - 1);
    expect(String(parse([]))).toContain("token_key_too_short");
  });

  it("keeps 'empty' and 'too short' as different diagnoses", () => {
    // They have different fixes: one says "you meant to omit it", the other "you meant a real value".
    expect(String(parse(["--auth-secret="]))).toContain("must not be empty");
    expect(String(parse(["--auth-secret="]))).not.toContain("secret_too_short");
    expect(String(parse(["--token-key="]))).toContain("must not be empty");
    expect(String(parse(["--token-key="]))).not.toContain("token_key_too_short");
  });
});

describe("--cors value rules (ADR-0.12-S1, AC-D09)", () => {
  const parse = (args: string[]): HubOptions | string =>
    parseHubArgs(["--store", "notes.json", ...args]);

  it("refuses a bare --cors instead of silently meaning *", () => {
    // SEC-06: this is the whole finding. `--cors` with no value used to be `*`.
    expect(String(parse(["--cors"]))).toContain("cors_value_missing");
    expect(String(parse(["--cors="]))).toContain("cors_value_missing");
    expect(String(parse(["--cors", ""]))).toContain("cors_value_missing");
  });

  it("refuses --cors '*' without a client credential", () => {
    expect(String(parse(["--cors", "*"]))).toContain("cors_wildcard_unauthenticated");
    // The admin secret is an operator credential: it does not gate a browser, so it does not count.
    expect(
      String(parse(["--cors", "*", "--admin-secret", secretOf(SECRET_MIN_LENGTH)])),
    ).toContain("cors_wildcard_unauthenticated");
  });

  it("accepts --cors '*' behind either client credential", () => {
    expect(optionsOf(parse(["--cors", "*", "--auth-secret", secretOf(SECRET_MIN_LENGTH)])).cors).toBe(
      "*",
    );
    expect(optionsOf(parse(["--cors", "*", "--token-key", secretOf(TOKEN_KEY_MIN_LENGTH)])).cors).toBe(
      "*",
    );
  });

  it("leaves an explicit origin unchanged and needs no credential for it", () => {
    expect(optionsOf(parse(["--cors", "https://a.example"])).cors).toBe("https://a.example");
  });

  it("keeps --cors absent when the flag is absent, so no header is sent", () => {
    expect(optionsOf(parse([])).cors).toBeUndefined();
  });
});

describe("bind warnings (G1, AC-D01/AC-D02)", () => {
  it("classifies the bind spellings", () => {
    for (const loopback of ["127.0.0.1", "127.0.0.42", "localhost", "::1", "::ffff:127.0.0.1"]) {
      expect(isLoopbackBind(loopback), loopback).toBe(true);
    }
    for (const open of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.5", ""]) {
      expect(isLoopbackBind(open), JSON.stringify(open)).toBe(false);
    }
  });

  it("warns exactly once for a non-loopback bind without a credential", () => {
    const warnings = startupWarnings({
      host: "0.0.0.0",
      credential: "none",
      cors: null,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("unauthenticated_non_loopback");
    // The message has to name the consequence and the non-suppressibility, not just the state.
    expect(warnings[0]?.message).toContain("not suppressed by --quiet");
    expect(warnings[0]?.message).toContain("journal location");
  });

  it("stays silent for a loopback bind or for a non-loopback bind with a credential", () => {
    expect(startupWarnings({ host: "127.0.0.1", credential: "none", cors: null })).toEqual([]);
    for (const credential of ["secret", "token", "token+secret"] as const) {
      expect(startupWarnings({ host: "0.0.0.0", credential, cors: null }), credential).toEqual([]);
    }
  });

  it("reports the CORS wildcard as its own warning", () => {
    const warnings = startupWarnings({ host: "127.0.0.1", credential: "secret", cors: "*" });
    expect(warnings.map((warning) => warning.code)).toEqual(["cors_wildcard"]);
  });

  it("writes the warning to stderr even with quiet:true, and the hub still serves (AC-D01)", async () => {
    // G1 = B: the start is *allowed*. A refusal would break every existing LAN/lab setup without a
    // migration path; the warning is what makes the state visible — and `--quiet` must not hide it.
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const server = await startHub({
        storePath: tempStorePath(),
        host: "0.0.0.0",
        port: 0,
        quiet: true,
      });
      servers.push(server);

      expect(server.port).toBeGreaterThan(0);
      const config = await request(server.port, "GET", `${BASE}/config`);
      expect(config.status).toBe(200);
    } finally {
      spy.mockRestore();
    }

    const warnings = writes.filter((line) => line.includes("unauthenticated_non_loopback"));
    expect(warnings).toHaveLength(1);
    // `--quiet` still silences the informational start-up line: only the warning survives it.
    expect(writes.some((line) => line.includes("note(s), environment"))).toBe(false);
  });

  it("writes no bind warning for loopback without a credential or for a network bind with one (AC-D02)", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      servers.push(await startHub({ storePath: tempStorePath(), port: 0, quiet: true }));
      servers.push(
        await startHub({
          storePath: tempStorePath(),
          host: "0.0.0.0",
          port: 0,
          authSecret: SHARED,
          quiet: true,
        }),
      );
    } finally {
      spy.mockRestore();
    }

    expect(writes.filter((line) => line.includes("unauthenticated_non_loopback"))).toEqual([]);
  });
});
