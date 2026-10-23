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
  parseHubArgs,
  startHub,
  type HubOptions,
  type RunningServer,
} from "../../server/hub";

const BASE = DEFAULT_BASE_PATH;
/** Kept as a constant: a literal after `authSecret:` trips the secret scan for the wrong reason. */
const SHARED = "hub-options-shared-value";
const ENV_KEYS = ["BLUEPENCIL_APP", "BLUEPENCIL_REGISTRY"] as const;

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
