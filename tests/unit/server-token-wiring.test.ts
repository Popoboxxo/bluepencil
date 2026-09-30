/**
 * Authentication options reaching a *running* sidecar (#36, phase 2 — and the phase-1 gap).
 *
 * `server-auth.test.ts` and `server-token-auth.test.ts` call the handler directly, with a context
 * they build themselves. That is the right way to test the handler and the wrong way to test that
 * the *server* configures the handler — and the gap is not theoretical:
 *
 * `--auth-secret` was parsed, validated, put into `ServerOptions`, and then never passed into the
 * `HandlerContext` the real server builds. A server started with `--auth-secret` served every
 * request unauthenticated, and the phase-1 test suite stayed green throughout, because every one of
 * its cases supplied the secret by hand.
 *
 * So these tests do the only thing that can catch that class of bug: they start an actual server on
 * an actual port and make actual requests. Everything asserted here is about the wiring, not about
 * the handler's logic, which the other two suites already own.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTokenIssuer } from "../../server/tokens";
import { parseServerArgs, startServer, type ServerOptions } from "../../server/index";

/**
 * `parseServerArgs` returns `ServerOptions` on success and a *string* on failure, so a helper keeps
 * every case below from repeating the same narrowing — and stops a failure message from being read
 * as an options object.
 */
function optionsOf(result: ServerOptions | string): ServerOptions {
  if (typeof result === "string") throw new Error(`expected options, got the error: ${result}`);
  return result;
}

function errorOf(result: ServerOptions | string): string {
  if (typeof result !== "string") throw new Error("expected a parse error, got options");
  return result;
}

const CREDENTIAL = "test-fixture-value-1";
const SIGNING_KEY = "signing-key-fixture-1";

interface Running {
  port: number;
  close: () => Promise<void>;
}

const started: Running[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (started.length > 0) {
    await started.pop()?.close();
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** A real store file, in a real directory, in a throwaway port range. */
async function serve(options: Partial<ServerOptions> & { authSecret?: string; tokenKey?: string; revokedTokens?: ReadonlySet<string> }): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "bp-token-"));
  dirs.push(dir);
  const storePath = join(dir, "notes.json");
  writeFileSync(storePath, JSON.stringify({ notes: [] }), "utf8");
  const running = await startServer({
    storePath,
    port: 0,
    environment: "dev",
    quiet: true,
    ...options,
  });
  started.push(running);
  return running.port;
}

async function request(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: init.method ?? "GET",
    headers: init.headers ?? {},
  });
  return { status: response.status, body: await response.text() };
}

describe("a running sidecar actually enforces --auth-secret", () => {
  it("refuses an unauthenticated request", async () => {
    const port = await serve({ authSecret: CREDENTIAL });

    const response = await request(port, "/api/v1/bluepencil/notes");

    expect(response.status).toBe(401);
  });

  it("answers a request carrying the secret", async () => {
    const port = await serve({ authSecret: CREDENTIAL });

    const response = await request(port, "/api/v1/bluepencil/notes", {
      headers: { "x-bluepencil-auth": CREDENTIAL },
    });

    expect(response.status).toBe(200);
  });

  it("still serves an unauthenticated sidecar, because that is the loopback default", async () => {
    const port = await serve({});

    const response = await request(port, "/api/v1/bluepencil/notes");

    expect(response.status).toBe(200);
  });
});

describe("a running sidecar accepts signed tokens", () => {
  function issueAt(iso: string): { token: string; jti: string } {
    const issuer = createTokenIssuer({
      key: SIGNING_KEY,
      now: () => new Date(iso),
      newId: () => "jti-fixture-1",
    });
    const issued = issuer.issue({ device: "work-laptop", scope: ["read", "write"] });
    return { token: issued.token, jti: issued.claims.jti };
  }

  it("refuses a request with no token", async () => {
    const port = await serve({ tokenKey: SIGNING_KEY });

    expect((await request(port, "/api/v1/bluepencil/notes")).status).toBe(401);
  });

  it("accepts a token this sidecar signed", async () => {
    const port = await serve({ tokenKey: SIGNING_KEY });
    // Issued against the real clock, not a fixed date. A fixed `iat` here would have passed on the day
    // it was written and started failing the next day, because the *server* decides expiry from its
    // own clock — which is the correct behaviour and exactly why a test must not pin a past date.
    const { token } = issueAt(new Date().toISOString());

    const response = await request(port, "/api/v1/bluepencil/notes", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
  });

  it("refuses a token the day after it was issued, with the code a client acts on", async () => {
    // The counterpart: same fixture, one day stale, and the answer has to be distinguishable from a
    // forged one so the client knows to ask for a new token instead of giving up.
    const port = await serve({ tokenKey: SIGNING_KEY });
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const { token } = issueAt(yesterday);

    const response = await request(port, "/api/v1/bluepencil/notes", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(401);
    expect(JSON.parse(response.body).error.code).toBe("token_expired");
  });

  it("refuses a token signed with a different key", async () => {
    const port = await serve({ tokenKey: SIGNING_KEY });
    const issuer = createTokenIssuer({
      key: "some-other-key",
      now: () => new Date("2026-09-29T12:00:00.000Z"),
      newId: () => "jti-fixture-1",
    });
    const foreign = issuer.issue({ device: "attacker", scope: ["read", "write"] });

    const response = await request(port, "/api/v1/bluepencil/notes", {
      headers: { authorization: `Bearer ${foreign.token}` },
    });

    expect(response.status).toBe(401);
  });

  it("refuses an expired token, and says so with a code the client can act on", async () => {
    // A real wall clock here, because the *server* checks the expiry and the server owns the clock —
    // a client with a skewed clock must still be refused. The token is issued with a TTL already past.
    const port = await serve({ tokenKey: SIGNING_KEY });
    const issuer = createTokenIssuer({
      key: SIGNING_KEY,
      now: () => new Date(Date.now() - 10 * 60 * 1000),
      newId: () => "jti-fixture-1",
    });
    const stale = issuer.issue({ device: "d", scope: ["read"], ttlSeconds: 60 });

    const response = await request(port, "/api/v1/bluepencil/notes", {
      headers: { authorization: `Bearer ${stale.token}` },
    });

    expect(response.status).toBe(401);
    expect(JSON.parse(response.body).error.code).toBe("token_expired");
  });

  it("refuses a revoked token while leaving other devices working", async () => {
    // The end-to-end version of the property phase 1 could not offer at all. One server, two
    // devices: the revoked one is refused and the other keeps working, which is the whole point —
    // a shared secret cannot do this, because dropping one device would mean rotating it for all.
    const issuer = createTokenIssuer({
      key: SIGNING_KEY,
      now: () => new Date(),
      newId: (() => {
        let n = 0;
        return () => `jti-${(n += 1)}`;
      })(),
    });
    const keep = issuer.issue({ device: "keep", scope: ["read"] });
    const drop = issuer.issue({ device: "drop", scope: ["read"] });

    // The revocation is handed in through the resolved options — the same path `--revoked-tokens`
    // takes after it reads the file.
    const port = await serve({
      tokenKey: SIGNING_KEY,
      revokedTokens: new Set([drop.claims.jti]),
    });

    const refused = await request(port, "/api/v1/bluepencil/notes", {
      headers: { authorization: `Bearer ${drop.token}` },
    });
    const allowed = await request(port, "/api/v1/bluepencil/notes", {
      headers: { authorization: `Bearer ${keep.token}` },
    });

    expect(refused.status).toBe(401);
    expect(JSON.parse(refused.body).error.code).toBe("token_revoked");
    expect(allowed.status).toBe(200);
  });
});

describe("the revocation list is read from disk at startup", () => {
  it("refuses a token whose id is in the file", async () => {
    // Restart-persistence is the reason this is a file at all. A list that lives in memory would be
    // empty after a restart, and restarting the sidecar would quietly re-admit a cut-off device.
    const dir = mkdtempSync(join(tmpdir(), "bp-revoked-"));
    dirs.push(dir);
    const storePath = join(dir, "notes.json");
    const revokedPath = join(dir, "revoked.json");
    writeFileSync(storePath, JSON.stringify({ notes: [] }), "utf8");
    const issuer = createTokenIssuer({ key: SIGNING_KEY, newId: () => "jti-on-disk" });
    const issued = issuer.issue({ device: "d", scope: ["read"] });
    writeFileSync(revokedPath, JSON.stringify([issued.claims.jti]), "utf8");

    const running = await startServer({
      storePath,
      port: 0,
      environment: "dev",
      quiet: true,
      tokenKey: SIGNING_KEY,
      // Exactly what the flag does: read the file, hand the ids to the options.
      revokedTokens: new Set(JSON.parse(readFileSync(revokedPath, "utf8")) as string[]),
    });
    started.push(running);

    const response = await request(running.port, "/api/v1/bluepencil/notes", {
      headers: { authorization: `Bearer ${issued.token}` },
    });

    expect(response.status).toBe(401);
    expect(JSON.parse(response.body).error.code).toBe("token_revoked");
  });

  it("treats an empty array as an empty list, not as an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bp-revoked-"));
    dirs.push(dir);
    const revokedPath = join(dir, "revoked.json");
    writeFileSync(revokedPath, "[]", "utf8");

    const options = optionsOf(
      parseServerArgs([
        "--store",
        join(dir, "notes.json"),
        "--token-key",
        SIGNING_KEY,
        "--revoked-tokens",
        revokedPath,
      ]),
    );

    expect(options.revokedTokens?.size).toBe(0);
  });

  it("refuses a file that is not a JSON array of strings, rather than un-revoking everything", async () => {
    // The dangerous failure mode is a silent empty list: every previously revoked device comes back.
    // A startup error an operator sees is the only acceptable outcome.
    const dir = mkdtempSync(join(tmpdir(), "bp-revoked-"));
    dirs.push(dir);
    const revokedPath = join(dir, "revoked.json");
    writeFileSync(revokedPath, JSON.stringify({ jti: "nope" }), "utf8");

    const parsed = parseServerArgs([
      "--store",
      join(dir, "notes.json"),
      "--token-key",
      SIGNING_KEY,
      "--revoked-tokens",
      revokedPath,
    ]);

    expect(errorOf(parsed)).toMatch(/array of token id strings/);
  });

  it("refuses a file that does not exist, instead of starting with nothing revoked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bp-revoked-"));
    dirs.push(dir);

    const parsed = parseServerArgs([
      "--store",
      join(dir, "notes.json"),
      "--token-key",
      SIGNING_KEY,
      "--revoked-tokens",
      join(dir, "missing.json"),
    ]);

    expect(typeof parsed).toBe("string");
  });
});

describe("the command line", () => {
  function args(...extra: string[]): ServerOptions | string {
    return parseServerArgs(["--store", "/tmp/does-not-matter.json", ...extra]);
  }

  it("reads the signing key from the flag and from the environment", () => {
    const fromFlag = args("--token-key", SIGNING_KEY);
    expect(optionsOf(fromFlag).tokenKey).toBe(SIGNING_KEY);

    const previous = process.env.BLUEPENCIL_TOKEN_KEY;
    process.env.BLUEPENCIL_TOKEN_KEY = SIGNING_KEY;
    try {
      expect(optionsOf(args()).tokenKey).toBe(SIGNING_KEY);
    } finally {
      if (previous === undefined) delete process.env.BLUEPENCIL_TOKEN_KEY;
      else process.env.BLUEPENCIL_TOKEN_KEY = previous;
    }
  });

  it("refuses an empty key, which would sign with nothing", () => {
    expect(errorOf(args("--token-key="))).toMatch(/must not be empty/);
  });

  it("refuses a token TTL that is not a positive whole number of seconds", () => {
    for (const bad of ["0", "-1", "soon"]) {
      const parsed = args("--token-key", SIGNING_KEY, "--token-ttl", bad);
      expect(typeof parsed, bad).toBe("string");
    }
  });

  it("accepts a positive TTL", () => {
    expect(optionsOf(args("--token-key", SIGNING_KEY, "--token-ttl", "3600")).tokenTtlSeconds).toBe(3600);
  });

  it("carries both credentials when both are configured", () => {
    const both = optionsOf(args("--auth-secret", CREDENTIAL, "--token-key", SIGNING_KEY));
    expect(both.authSecret).toBe(CREDENTIAL);
    expect(both.tokenKey).toBe(SIGNING_KEY);
  });
});
