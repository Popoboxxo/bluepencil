/**
 * @vitest-environment node — starts real servers on real ports, same reasoning as
 * server-token-wiring.test.ts: the class of bug this surface invites is a wiring gap (a parsed flag
 * that never reaches the context), which a hand-built context cannot see.
 *
 * The admin surface ({base}/admin and its routes): existence rules, its own gate, the notes bridge
 * it rides on, and token issuing/revocation being live *and* durable.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseServerArgs, startServer, type ServerOptions } from "../../server/index";

const ADMIN = "admin-fixture-secret-1";
const CLIENT_CREDENTIAL = "hub-fixture-secret-1";
const KEY = "signing-key-admin-1";

interface Running {
  port: number;
  close: () => Promise<void>;
}

const started: Running[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (started.length > 0) await started.pop()?.close();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bp-admin-"));
  dirs.push(dir);
  return dir;
}

async function serve(options: Partial<ServerOptions>): Promise<{ port: number; dir: string }> {
  const dir = freshDir();
  const storePath = join(dir, "notes.json");
  writeFileSync(storePath, JSON.stringify({ notes: [] }), "utf8");
  const running = await startServer({ storePath, port: 0, environment: "dev", quiet: true, ...options });
  started.push(running);
  return { port: running.port, dir };
}

async function call(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: string; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: init.method ?? "GET", headers, body });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* the HTML route answers non-JSON on purpose */
  }
  return { status: response.status, body: text, json: parsed };
}

describe("the admin surface exists only where it was switched on", () => {
  it("is not there at all without --admin-secret", async () => {
    const { port } = await serve({ authSecret: CLIENT_CREDENTIAL });

    const page = await call(port, "/api/v1/bluepencil/admin", { headers: { "x-bluepencil-admin": ADMIN } });
    const status = await call(port, "/api/v1/bluepencil/admin/status", { headers: { "x-bluepencil-admin": ADMIN } });

    // 404, not 401: an admin surface that merely looks locked still advertises itself.
    expect(page.status).toBe(404);
    expect(status.status).toBe(404);
  });

  it("answers the page without a credential — the secret is typed into it, not read from it", async () => {
    const { port } = await serve({ adminSecret: ADMIN });

    const page = await call(port, "/api/v1/bluepencil/admin");

    expect(page.status).toBe(200);
    expect(page.body).toContain("Bluepencil");
  });

  it("refuses its routes without the admin header, and with the wrong value", async () => {
    const { port } = await serve({ adminSecret: ADMIN });

    const missing = await call(port, "/api/v1/bluepencil/admin/status");
    const wrong = await call(port, "/api/v1/bluepencil/admin/status", { headers: { "x-bluepencil-admin": "not-it" } });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(JSON.stringify(missing.json)).toContain("x-bluepencil-admin");
  });

  it("describes itself to the operator who holds the secret", async () => {
    const { port } = await serve({ adminSecret: ADMIN, authSecret: CLIENT_CREDENTIAL });

    const status = await call(port, "/api/v1/bluepencil/admin/status", { headers: { "x-bluepencil-admin": ADMIN } });

    expect(status.status).toBe(200);
    expect(status.json.admin).toBe(true);
    expect(status.json.auth).toBe("secret");
    expect(status.json.tokenIssuing).toBe(false);
    expect(status.json.notes).toBe(0);
  });
});

describe("the admin secret bridges to the notes API", () => {
  it("edits notes with the one credential the page holds", async () => {
    const { port } = await serve({ adminSecret: ADMIN, authSecret: CLIENT_CREDENTIAL });

    const refused = await call(port, "/api/v1/bluepencil/notes");
    const created = await call(port, "/api/v1/bluepencil/notes", {
      method: "POST",
      headers: { "x-bluepencil-auth": ADMIN },
      body: { type: "text", body: "from the admin page", anchor: { selector: "main", route: "/probe" } },
    });

    // The hub's client credential alone still gates the door; the admin value is the second key.
    expect(refused.status).toBe(401);
    expect(created.status).toBe(200);

    const status = await call(port, "/api/v1/bluepencil/admin/status", { headers: { "x-bluepencil-admin": ADMIN } });
    expect(status.json.notes).toBe(1);
  });
});

describe("token issuing and revocation", () => {
  it("says plainly that it cannot mint without a signing key", async () => {
    const { port } = await serve({ adminSecret: ADMIN });

    const mint = await call(port, "/api/v1/bluepencil/admin/devices", {
      method: "POST",
      headers: { "x-bluepencil-admin": ADMIN },
      body: { device: "laptop" },
    });

    expect(mint.status).toBe(409);
    expect(JSON.stringify(mint.json)).toContain("--token-key");
  });

  it("mints a token the hub accepts at once, and records it in the registry", async () => {
    const { port, dir } = await serve({ adminSecret: ADMIN, tokenKey: KEY });

    const mint = await call(port, "/api/v1/bluepencil/admin/devices", {
      method: "POST",
      headers: { "x-bluepencil-admin": ADMIN },
      body: { device: "caro-laptop", scope: ["read", "write"] },
    });

    expect(mint.status).toBe(201);
    const token = String(mint.json.token);
    const works = await call(port, "/api/v1/bluepencil/notes", {
      headers: { authorization: "Bearer " + token },
    });
    expect(works.status).toBe(200);

    const registry = JSON.parse(readFileSync(join(dir, "devices.json"), "utf8")) as Array<Record<string, unknown>>;
    expect(registry).toHaveLength(1);
    expect(registry[0]?.device).toBe("caro-laptop");
    expect(registry[0]?.revoked).toBe(false);
  });

  it("revokes at once and durably — the file is what a restart reads", async () => {
    // `--revoked-tokens` is read at startup — a missing file would fail the start, so it exists
    // before the server does, in a directory the test owns (serve() makes its own for the store).
    const revocationDir = freshDir();
    const revocationPath = join(revocationDir, "revoked.json");
    writeFileSync(revocationPath, "[]", "utf8");
    const { port, dir } = await serve({ adminSecret: ADMIN, tokenKey: KEY, revokedPath: revocationPath });

    const mint = await call(port, "/api/v1/bluepencil/admin/devices", {
      method: "POST",
      headers: { "x-bluepencil-admin": ADMIN },
      body: { device: "tablet" },
    });
    const token = String(mint.json.token);
    const jti = String(mint.json.jti);

    const revoked = await call(port, "/api/v1/bluepencil/admin/devices/revoke", {
      method: "POST",
      headers: { "x-bluepencil-admin": ADMIN },
      body: { jti },
    });

    expect(revoked.status).toBe(200);
    expect(revoked.json.durable).toBe(true);
    const refused = await call(port, "/api/v1/bluepencil/notes", {
      headers: { authorization: "Bearer " + token },
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    // live and on disk
    expect(JSON.parse(readFileSync(revocationPath, "utf8"))).toContain(jti);
    const registry = JSON.parse(readFileSync(join(dir, "devices.json"), "utf8")) as Array<Record<string, unknown>>;
    expect(registry[0]?.revoked).toBe(true);
  });

  it("validates what it is asked to mint", async () => {
    const { port } = await serve({ adminSecret: ADMIN, tokenKey: KEY });

    const empty = await call(port, "/api/v1/bluepencil/admin/devices", {
      method: "POST",
      headers: { "x-bluepencil-admin": ADMIN },
      body: { device: "  " },
    });
    const badScope = await call(port, "/api/v1/bluepencil/admin/devices", {
      method: "POST",
      headers: { "x-bluepencil-admin": ADMIN },
      body: { device: "ok", scope: ["admin"] },
    });

    expect(empty.status).toBe(400);
    expect(badScope.status).toBe(400);
  });
});

describe("the flag itself", () => {
  it("refuses an empty value, because that reads as a typo rather than as off", () => {
    const parsed = parseServerArgs(["--store", "x.json", "--admin-secret", ""]);
    expect(typeof parsed).toBe("string");
    expect(String(parsed)).toContain("--admin-secret must not be empty");
  });

  it("reaches the options from the environment as well", () => {
    // The environment is read by the argument parser (the CLI's entry into these options), not by
    // `startServer` — so the wiring that matters is parser → ServerOptions.
    process.env.BLUEPENCIL_ADMIN_SECRET = ADMIN;
    try {
      const parsed = parseServerArgs(["--store", join(freshDir(), "notes.json")]);
      expect(typeof parsed).not.toBe("string");
      expect((parsed as ServerOptions).adminSecret).toBe(ADMIN);
    } finally {
      delete process.env.BLUEPENCIL_ADMIN_SECRET;
    }
  });
});

