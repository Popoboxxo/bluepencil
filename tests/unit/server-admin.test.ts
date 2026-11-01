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
import { handleAdmin } from "../../server/admin";
import type { HandlerContext } from "../../server/handler";

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
): Promise<{ status: number; body: string; json: Record<string, unknown>; headers: Headers }> {
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
  return { status: response.status, body: text, json: parsed, headers: response.headers };
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

/* ------------------------------------------------------------------------------------------------
 * PR #106 review fixes — the admin surface's credential bridge, CORS, input limits, throttling and
 * its behaviour around a broken device registry. These are contract claims about what goes over the
 * wire, so they are asserted against a real socket for the same reason as the tests above: a parsed
 * option that never reaches the context looks healthy in a hand-built context.
 * ---------------------------------------------------------------------------------------------- */

const API = "/api/v1/bluepencil";

describe("the admin secret is a notes credential and nothing more", () => {
  it("[FR-6.8] edits notes on a token-only hub with the admin secret alone", async () => {
    // No --auth-secret: the only client credentials are signed tokens. The admin secret is still
    // enough for the notes API, because that is the one credential the page holds.
    const { port } = await serve({ adminSecret: ADMIN, tokenKey: KEY });

    const listed = await call(port, `${API}/notes`, { headers: { "x-bluepencil-auth": ADMIN } });
    expect(listed.status).toBe(200);

    const created = await call(port, `${API}/notes`, {
      method: "POST",
      headers: { "x-bluepencil-auth": ADMIN },
      body: { type: "text", body: "from the admin page", anchor: { selector: "main", route: "/settings" } },
    });
    expect(created.status).toBe(200);
    const note = created.json.note as Record<string, unknown> | undefined;
    expect(typeof note?.id).toBe("string");

    const patched = await call(port, `${API}/notes/${String(note?.id)}`, {
      method: "PATCH",
      headers: { "x-bluepencil-auth": ADMIN },
      body: { status: "done" },
    });
    expect(patched.status).toBe(200);
    expect((patched.json.note as Record<string, unknown> | undefined)?.status).toBe("done");
  });

  it("[FR-6.8] does not open the MCP door", async () => {
    const { port } = await serve({ adminSecret: ADMIN, tokenKey: KEY });

    const refused = await call(port, `${API}/mcp`, {
      method: "POST",
      headers: { "x-bluepencil-auth": ADMIN },
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(refused.status).toBe(401);

    // The same request with the credential this door actually speaks is accepted.
    const mint = await call(port, `${API}/admin/devices`, {
      method: "POST",
      headers: { "x-bluepencil-admin": ADMIN },
      body: { device: "caro-laptop", scope: ["read"] },
    });
    const token = String(mint.json.token);
    const allowed = await call(port, `${API}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer " + token },
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toContain("tools");
  });

  it("[FR-6.8] does not switch authentication on by itself", async () => {
    // An admin secret is an operator credential, not a client one: without --auth-secret or
    // --token-key the notes API stays open, exactly as it was before the flag existed.
    const { port } = await serve({ adminSecret: ADMIN });

    const open = await call(port, `${API}/notes`);
    expect(open.status).toBe(200);
  });
});

describe("CORS on the admin surface", () => {
  it("[FR-6.8] carries CORS headers and answers a preflight when CORS is configured", async () => {
    const { port } = await serve({ adminSecret: ADMIN, cors: "*" });

    const status = await call(port, `${API}/admin/status`, { headers: { "x-bluepencil-admin": ADMIN } });
    expect(status.status).toBe(200);
    expect(status.headers.get("access-control-allow-origin")).toBe("*");

    // A refusal is still an answer from this surface: a browser script must be able to read why
    // it was refused, so the CORS vocabulary is on the error too.
    const refused = await call(port, `${API}/admin/status`);
    expect(refused.status).toBe(401);
    expect(refused.headers.get("access-control-allow-origin")).toBe("*");

    const preflight = await call(port, `${API}/admin/status`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect((preflight.headers.get("access-control-allow-headers") ?? "").toLowerCase()).toContain("x-bluepencil-admin");
    // `/admin/status` documents GET only, so the preflight must not advertise the notes API's
    // `POST`/`PATCH` (#102).
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
  });

  it("[FR-6.8] refuses OPTIONS on the admin surface when no CORS origin is configured", async () => {
    const { port } = await serve({ adminSecret: ADMIN });

    const preflight = await call(port, `${API}/admin/status`, { method: "OPTIONS" });
    expect(preflight.status).toBe(405);
  });
});

describe("a corrupt device registry is reported, not swallowed", () => {
  it("[FR-6.8] answers 500 registry_unreadable and leaves the file bytes alone", async () => {
    const { port, dir } = await serve({ adminSecret: ADMIN, tokenKey: KEY });
    const registryPath = join(dir, "devices.json");
    // Truncated on purpose: a registry the hub cannot parse must not read as "no devices yet".
    const corrupt = "{ this is not the registry";
    writeFileSync(registryPath, corrupt, "utf8");

    const listed = await call(port, `${API}/admin/devices`, { headers: { "x-bluepencil-admin": ADMIN } });
    expect(listed.status).toBe(500);
    const error = listed.json.error as Record<string, unknown> | undefined;
    expect(error?.code).toBe("registry_unreadable");

    const minted = await call(port, `${API}/admin/devices`, {
      method: "POST",
      headers: { "x-bluepencil-admin": ADMIN },
      body: { device: "caro-laptop" },
    });
    expect(minted.status).toBe(500);
    // A failed write must not turn the operator's broken file into a silently empty one.
    expect(readFileSync(registryPath, "utf8")).toBe(corrupt);
  });

  it("[FR-6.8] still answers status 200 with a devicesError", async () => {
    const { port, dir } = await serve({ adminSecret: ADMIN, tokenKey: KEY });
    writeFileSync(join(dir, "devices.json"), "not json at all", "utf8");

    const status = await call(port, `${API}/admin/status`, { headers: { "x-bluepencil-admin": ADMIN } });
    expect(status.status).toBe(200);
    expect(typeof status.json.devicesError).toBe("string");
    expect(String(status.json.devicesError).length).toBeGreaterThan(0);
  });

  it("[FR-6.8] still revokes live and durably without clobbering the registry", async () => {
    const revocationDir = freshDir();
    const revocationPath = join(revocationDir, "revoked.json");
    writeFileSync(revocationPath, "[]", "utf8");
    const { port, dir } = await serve({ adminSecret: ADMIN, tokenKey: KEY, revokedPath: revocationPath });
    const registryPath = join(dir, "devices.json");
    const corrupt = "{ broken registry";
    writeFileSync(registryPath, corrupt, "utf8");

    const jti = "jti-revoked-while-registry-broken";
    const revoked = await call(port, `${API}/admin/devices/revoke`, {
      method: "POST",
      headers: { "x-bluepencil-admin": ADMIN },
      body: { jti },
    });

    expect(revoked.status).toBe(200);
    expect(revoked.json.revoked).toBe(jti);
    expect(revoked.json.durable).toBe(true);
    expect(typeof revoked.json.registryError).toBe("string");
    expect(JSON.parse(readFileSync(revocationPath, "utf8"))).toContain(jti);
    expect(readFileSync(registryPath, "utf8")).toBe(corrupt);
  });
});

describe("revoking an id the registry has never seen", () => {
  it("[FR-6.8] revokes durably without claiming it was live only", async () => {
    const revocationDir = freshDir();
    const revocationPath = join(revocationDir, "revoked.json");
    writeFileSync(revocationPath, "[]", "utf8");
    const { port } = await serve({ adminSecret: ADMIN, tokenKey: KEY, revokedPath: revocationPath });

    const jti = "jti-unknown-9f3c";
    const revoked = await call(port, `${API}/admin/devices/revoke`, {
      method: "POST",
      headers: { "x-bluepencil-admin": ADMIN },
      body: { jti },
    });

    expect(revoked.status).toBe(200);
    expect(revoked.json.revoked).toBe(jti);
    expect(revoked.json.known).toBe(false);
    expect(revoked.json.durable).toBe(true);
    expect(JSON.parse(readFileSync(revocationPath, "utf8"))).toContain(jti);
    // The id is on disk; telling the operator "live only" would be a false statement.
    expect(String(revoked.json.note ?? "")).not.toContain("live only");
  });
});

describe("the admin page address", () => {
  it("[FR-6.8] answers at /admin and /admin/ alike", async () => {
    const { port } = await serve({ adminSecret: ADMIN });

    const bare = await call(port, `${API}/admin`);
    const slash = await call(port, `${API}/admin/`);

    expect(bare.status).toBe(200);
    expect(slash.status).toBe(200);
    expect(bare.body).toContain("Bluepencil");
    expect(slash.body).toContain("Bluepencil");
  });

  it("[FR-6.8] answers 404 for an unknown path under the surface", async () => {
    const { port } = await serve({ adminSecret: ADMIN });

    const unknown = await call(port, `${API}/admin/nope`, { headers: { "x-bluepencil-admin": ADMIN } });

    expect(unknown.status).toBe(404);
    expect((unknown.json.error as Record<string, unknown> | undefined)?.code).toBe("not_found");
  });
});

describe("the devices list reports the live revocation set", () => {
  it("[FR-6.8] marks a record revoked when the live set holds its jti", () => {
    // The record on disk says `revoked: false`, but this process holds the revocation. The list
    // must report what the hub actually does, not what a stale file says.
    const dir = freshDir();
    const devicesPath = join(dir, "devices.json");
    writeFileSync(
      devicesPath,
      JSON.stringify([
        {
          jti: "jti-live-1",
          device: "caro-laptop",
          scope: ["read"],
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2027-01-01T00:00:00.000Z",
          revoked: false,
        },
      ]),
      "utf8",
    );
    const context: HandlerContext = {
      store: { notes: [] },
      base: API,
      environment: "dev",
      adminSecret: ADMIN,
      devicesPath,
      revokedTokens: new Set(["jti-live-1"]),
    };

    const response = handleAdmin(
      { method: "GET", url: `${API}/admin/devices`, headers: { "x-bluepencil-admin": ADMIN } },
      context,
    );

    expect(response?.status).toBe(200);
    const body = JSON.parse(response?.body ?? "{}") as { devices?: Array<Record<string, unknown>> };
    expect(body.devices?.[0]?.revoked).toBe(true);
  });
});

describe("a host that wired no revoker", () => {
  it("[FR-6.8] refuses with 409 revocation_unavailable instead of claiming a revocation", () => {
    const context: HandlerContext = {
      store: { notes: [] },
      base: API,
      environment: "dev",
      adminSecret: ADMIN,
    };

    const response = handleAdmin(
      {
        method: "POST",
        url: `${API}/admin/devices/revoke`,
        headers: { "x-bluepencil-admin": ADMIN },
        body: JSON.stringify({ jti: "jti-x" }),
      },
      context,
    );

    expect(response?.status).toBe(409);
    const body = JSON.parse(response?.body ?? "{}") as {
      error?: { code?: string };
      revoked?: unknown;
      durable?: unknown;
    };
    expect(body.error?.code).toBe("revocation_unavailable");
    expect(body.revoked).toBeUndefined();
    expect(body.durable).toBeUndefined();
  });
});

describe("the admin secret's minimum length", () => {
  it("[NFR-13] refuses a secret shorter than 16 characters and names the minimum", () => {
    const parsed = parseServerArgs(["--store", join(freshDir(), "notes.json"), "--admin-secret", "a".repeat(15)]);

    expect(typeof parsed).toBe("string");
    expect(String(parsed)).toContain("16");
  });

  it("[NFR-13] accepts a 16-character secret", () => {
    const secret = "a".repeat(16);
    const parsed = parseServerArgs(["--store", join(freshDir(), "notes.json"), "--admin-secret", secret]);

    expect(typeof parsed).not.toBe("string");
    expect((parsed as ServerOptions).adminSecret).toBe(secret);
  });
});

describe("failed admin-secret checks are throttled per remote", () => {
  it("[FR-6.8] answers 429 with retry-after after ten failures", async () => {
    const { port } = await serve({ adminSecret: ADMIN });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const refused = await call(port, `${API}/admin/status`, {
        headers: { "x-bluepencil-admin": `wrong-secret-${attempt}` },
      });
      statuses.push(refused.status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 401, 401, 401, 401, 401]);

    const throttled = await call(port, `${API}/admin/status`, {
      headers: { "x-bluepencil-admin": "wrong-secret-again" },
    });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("300");
  });

  it("[FR-6.8] a successful check resets the counter", async () => {
    const { port } = await serve({ adminSecret: ADMIN });

    for (let attempt = 0; attempt < 9; attempt += 1) {
      await call(port, `${API}/admin/status`, { headers: { "x-bluepencil-admin": `wrong-secret-${attempt}` } });
    }
    const accepted = await call(port, `${API}/admin/status`, { headers: { "x-bluepencil-admin": ADMIN } });
    expect(accepted.status).toBe(200);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const refused = await call(port, `${API}/admin/status`, {
        headers: { "x-bluepencil-admin": `wrong-after-success-${attempt}` },
      });
      expect(refused.status).toBe(401);
    }
  });
});

describe("read-only still allows the admin to issue and revoke tokens", () => {
  it("[FR-16.13] mints and revokes while a note write with the admin secret is refused", async () => {
    const { port } = await serve({ adminSecret: ADMIN, tokenKey: KEY, readOnly: true });

    const mint = await call(port, `${API}/admin/devices`, {
      method: "POST",
      headers: { "x-bluepencil-admin": ADMIN },
      body: { device: "caro-laptop", scope: ["read", "write"] },
    });
    expect(mint.status).toBe(201);

    const jti = String(mint.json.jti);
    const revoked = await call(port, `${API}/admin/devices/revoke`, {
      method: "POST",
      headers: { "x-bluepencil-admin": ADMIN },
      body: { jti },
    });
    expect(revoked.status).toBe(200);

    const write = await call(port, `${API}/notes`, {
      method: "POST",
      headers: { "x-bluepencil-auth": ADMIN },
      body: { type: "text", body: "should not land", anchor: { selector: "main", route: "/settings" } },
    });
    expect(write.status).toBe(403);
    expect((write.json.error as Record<string, unknown> | undefined)?.code).toBe("read_only");
  });
});

describe("the journal records the verified device as the actor", () => {
  it("[FR-18] attributes a token-written note to the device that owns the token", async () => {
    const { port } = await serve({ adminSecret: ADMIN, tokenKey: KEY, journal: "file" });

    const mint = await call(port, `${API}/admin/devices`, {
      method: "POST",
      headers: { "x-bluepencil-admin": ADMIN },
      body: { device: "caro-laptop", scope: ["read", "write"] },
    });
    const token = String(mint.json.token);

    // No x-bluepencil-actor here: the token already names the device, and the journal must use it.
    const created = await call(port, `${API}/notes`, {
      method: "POST",
      headers: { authorization: "Bearer " + token },
      body: { type: "text", body: "written by caro", anchor: { selector: "main", route: "/settings" } },
    });
    expect(created.status).toBe(200);

    const journal = await call(port, `${API}/journal`);
    expect(journal.status).toBe(200);
    const entries = journal.json.entries as Array<Record<string, unknown>>;
    const create = entries.find((entry) => entry.op === "create");
    expect(create?.actor).toBe("caro-laptop");
  });
});

describe("admin input limits", () => {
  it("[FR-6.8] refuses a device name longer than 200 characters", async () => {
    const { port } = await serve({ adminSecret: ADMIN, tokenKey: KEY });

    const mint = await call(port, `${API}/admin/devices`, {
      method: "POST",
      headers: { "x-bluepencil-admin": ADMIN },
      body: { device: "d".repeat(201) },
    });
    expect(mint.status).toBe(400);
  });

  it("[FR-6.8] refuses a ttlSeconds beyond a year", async () => {
    const { port } = await serve({ adminSecret: ADMIN, tokenKey: KEY });

    const mint = await call(port, `${API}/admin/devices`, {
      method: "POST",
      headers: { "x-bluepencil-admin": ADMIN },
      body: { device: "caro-laptop", ttlSeconds: 31536001 },
    });
    expect(mint.status).toBe(400);
  });

  it("[FR-6.8] refuses a revoke id longer than 256 characters", async () => {
    const { port } = await serve({ adminSecret: ADMIN, tokenKey: KEY });

    const revoked = await call(port, `${API}/admin/devices/revoke`, {
      method: "POST",
      headers: { "x-bluepencil-admin": ADMIN },
      body: { jti: "j".repeat(257) },
    });
    expect(revoked.status).toBe(400);
  });
});

describe("the admin page follows Accept-Language", () => {
  it("[FR-11.1] serves the German page for de and the English page by default", async () => {
    const { port } = await serve({ adminSecret: ADMIN });

    const german = await call(port, `${API}/admin`, { headers: { "accept-language": "de" } });
    expect(german.status).toBe(200);
    expect(german.body).toContain("Verbinden");

    const fallback = await call(port, `${API}/admin`);
    expect(fallback.status).toBe(200);
    expect(fallback.body).toContain("Connect");
  });
});
