/**
 * @vitest-environment node — binds two real sockets and reads real files; jsdom cannot.
 *
 * Task 12 of the viewer-origin plan: **one store, one journal, one revocation set**.
 *
 * What is proven here (plan Task 12, spec §2.4, §6 R2):
 *   - IT-06/AC-5.6 — a note written through the viewer origin (with a real viewer session obtained
 *     from the hub launcher) is visible on hub `GET {base}/notes` and `GET {base}/bundle` without a
 *     restart: the two listeners share the one `store` and the one `persist` closure (C2);
 *   - IT-07/AC-5.7 — the same note id appears in the hub MCP door's `tools/call list_notes`;
 *   - IT-08/AC-5.8 — with `journal: "file"` (and `journalCoalesceMs: 0`) exactly one journal entry
 *     exists for the write, it carries the note id and `actor === "viewer-test"` from
 *     `X-Bluepencil-Actor`, and there is exactly one journal file;
 *   - IT-43/AC-5.32 — a device token accepted by both surfaces before a hub-side revocation is
 *     `401 token_revoked` on `{viewer}/notes`, `/bundle` and `/sessions` **and** on the hub after
 *     `POST {hub}{base}/admin/devices/revoke`, without a restart (the shared `revokedTokens` set, no
 *     copy) and without falling back to `x-bluepencil-auth`;
 *   - IT-44/AC-5.33 — hub and viewer `/bundle` are status-, content-type- and body-identical for the
 *     same store with injected `now`/`appName`/`exportedBy`; application headers differ only by the
 *     hub's CORS set, which the comparison removes first.
 *
 * The launcher/ticket flow is exercised as the real session source on purpose: a hand-minted session
 * would not prove the viewer origin can write with the credential its page is served under.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_BASE_PATH } from "../../server/handler";
import { startHub, type HubOptions, type RunningServer } from "../../server/hub";

const BASE = DEFAULT_BASE_PATH;
const ADMIN = "viewer-shared-operator-secret";
const CLIENT = "viewer-shared-client-secret";
const TOKEN_KEY = "viewer-shared-signing-key";
const FIXED_NOW = "2026-11-06T12:00:00.000Z";
const EXPORTED_BY = "bp-test <bp@example.com>";
const CORS_ORIGIN = "https://app.example";

/** A valid create body; every IT starts from an empty store, so no id collides. */
const NOTE_DRAFT = {
  type: "text",
  body: "written on the viewer origin",
  anchor: { selector: "main", route: "/cart" },
} as const;

type Json = Record<string, unknown>;

interface HttpAnswer {
  status: number;
  headers: Headers;
  text: string;
  json: Json;
}

const servers: RunningServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A store path in its own directory, so journal files and device registries never collide. */
function storePath(): string {
  return join(tempDir("bp-shared-store-"), "notes.bluepencil.json");
}

/** A `dist`-shaped directory; the viewer start only requires the bundle to be addressable. */
function assetsDir(): string {
  const dir = tempDir("bp-shared-assets-");
  writeFileSync(join(dir, "bluepencil.element.min.js"), "// stub\n");
  return dir;
}

/** Starts a tracked hub + viewer; `afterEach` closes both so a failing assertion leaks no socket. */
async function startViewerHub(overrides: Partial<HubOptions> = {}): Promise<RunningServer> {
  const server = await startHub({
    host: "127.0.0.1",
    port: 0,
    quiet: true,
    storePath: storePath(),
    environment: "dev",
    journal: "none",
    viewer: {
      host: "127.0.0.1",
      port: 0,
      assetsDir: assetsDir(),
      allow: ["example.com"],
      ttlSeconds: 28_800,
    },
    ...overrides,
  });
  servers.push(server);
  return server;
}

function hubBase(server: RunningServer): string {
  return `http://${server.host}:${server.port}${BASE}`;
}

function viewerBase(server: RunningServer): string {
  if (server.viewer === undefined) throw new Error("the viewer is not running — startHub() returned no viewer");
  return `http://${server.viewer.host}:${server.viewer.port}${BASE}`;
}

interface HttpInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: "follow" | "manual" | "error";
}

async function http(url: string, init: HttpInit = {}): Promise<HttpAnswer> {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: init.headers ?? {},
    ...(init.body === undefined ? {} : { body: init.body }),
    ...(init.redirect === undefined ? {} : { redirect: init.redirect }),
  });
  const text = await response.text();
  let json: Json = {};
  if (text !== "") {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) json = parsed;
    } catch {
      /* an HTML or empty answer: the caller asserts on `status`/`text` then */
    }
  }
  return { status: response.status, headers: response.headers, text, json };
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(answer: HttpAnswer): unknown {
  const error = answer.json["error"];
  return isRecord(error) ? error["code"] : undefined;
}

/**
 * Runs the real launcher and ticket exchange and returns the viewer cookie the shell would hold.
 *
 * The hub answers `302` onto the viewer origin; redeeming the ticket there answers `302` with
 * `Set-Cookie: bp_viewer=…`. Both hops are read with `redirect: "manual"` because Node's `fetch`
 * has no cookie jar — the test carries the cookie explicitly, exactly as a browser would after the
 * navigation completed.
 */
async function viewerCookie(server: RunningServer): Promise<string> {
  const launcher = await http(`${hubBase(server)}/viewer/start`, {
    headers: { "x-bluepencil-admin": ADMIN },
    redirect: "manual",
  });
  expect(launcher.status).toBe(302);
  const location = launcher.headers.get("location");
  if (location === null) throw new Error("the launcher returned no Location header");

  const redeemed = await http(location, { redirect: "manual" });
  expect(redeemed.status).toBe(302);
  const rawCookie = redeemed.headers.get("set-cookie") ?? "";
  const match = /bp_viewer=([^;]+)/.exec(rawCookie);
  if (match === null) throw new Error(`the ticket exchange set no bp_viewer cookie (got ${JSON.stringify(rawCookie)})`);
  return `bp_viewer=${match[1]}`;
}

/** Writes one note through the viewer origin with a valid viewer session; returns its id. */
async function writeThroughViewer(
  server: RunningServer,
  extraHeaders: Record<string, string> = {},
): Promise<string> {
  const cookie = await viewerCookie(server);
  const created = await http(`${viewerBase(server)}/notes`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, ...extraHeaders },
    body: JSON.stringify(NOTE_DRAFT),
  });
  expect(created.status).toBe(200);
  const note = created.json["note"];
  if (!isRecord(note)) throw new Error(`the create answered without a note: ${created.text}`);
  return String(note["id"]);
}

function noteIds(json: Json): string[] {
  const notes = json["notes"];
  if (!Array.isArray(notes)) return [];
  return notes.map((note) => (isRecord(note) ? String(note["id"]) : ""));
}

describe("the two listeners share one store (IT-06, IT-07)", () => {
  it("IT-06 — a viewer-origin write is visible on hub /notes and /bundle without a restart", async () => {
    // Name the store explicitly so the test can also prove the viewer write landed in the one
    // configured store file — visibility alone would also be satisfied by a second store that
    // happens to point at the same path.
    const ownStorePath = storePath();
    const server = await startViewerHub({
      adminSecret: ADMIN,
      authSecret: CLIENT,
      storePath: ownStorePath,
    });

    const noteId = await writeThroughViewer(server);

    const hubNotes = await http(`${hubBase(server)}/notes`, {
      headers: { "x-bluepencil-auth": CLIENT },
    });
    expect(hubNotes.status).toBe(200);
    expect(noteIds(hubNotes.json)).toContain(noteId);
    expect(noteIds(hubNotes.json)).toHaveLength(1);

    const hubBundle = await http(`${hubBase(server)}/bundle`, {
      headers: { "x-bluepencil-auth": CLIENT },
    });
    expect(hubBundle.status).toBe(200);
    expect(noteIds(hubBundle.json)).toContain(noteId);

    // One store on disk: the viewer's persist closure wrote the configured file, and the store's
    // directory holds no second note set.
    expect(readdirSync(dirname(ownStorePath))).toEqual(["notes.bluepencil.json"]);
    const persisted = JSON.parse(readFileSync(ownStorePath, "utf8")) as Json;
    expect(noteIds(persisted)).toContain(noteId);
  });

  it("IT-07 — the hub MCP door's list_notes sees the viewer-origin note", async () => {
    const server = await startViewerHub({ adminSecret: ADMIN, authSecret: CLIENT });

    const noteId = await writeThroughViewer(server);

    const rpc = await http(`${hubBase(server)}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bluepencil-auth": CLIENT },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_notes", arguments: {} },
      }),
    });
    expect(rpc.status).toBe(200);
    expect(rpc.json["error"]).toBeUndefined();

    const result = rpc.json["result"];
    if (!isRecord(result)) throw new Error(`the MCP door answered without a result: ${rpc.text}`);
    const content = result["content"];
    if (!Array.isArray(content)) throw new Error(`the MCP result has no content: ${rpc.text}`);
    const first = content[0];
    if (!isRecord(first) || typeof first["text"] !== "string") {
      throw new Error(`the MCP content is not text: ${rpc.text}`);
    }
    const listed = JSON.parse(first["text"]) as Json;
    expect(noteIds(listed)).toContain(noteId);
  });
});

describe("exactly one journal entry per viewer write (IT-08)", () => {
  it("records the note id and the explicit actor, and creates no second journal file", async () => {
    const journalDir = tempDir("bp-shared-journal-");
    const server = await startViewerHub({
      adminSecret: ADMIN,
      authSecret: CLIENT,
      journal: "file",
      journalCoalesceMs: 0,
      journalDir,
    });

    const noteId = await writeThroughViewer(server, { "x-bluepencil-actor": "viewer-test" });

    const journal = await http(`${hubBase(server)}/journal`);
    expect(journal.status).toBe(200);

    const entries = journal.json["entries"];
    expect(Array.isArray(entries)).toBe(true);
    const list = entries as Json[];
    expect(list).toHaveLength(1);

    const entry = list[0];
    if (entry === undefined) throw new Error("the journal answered an empty entry list");
    expect(entry["op"]).toBe("create");
    expect(entry["noteId"]).toBe(noteId);
    expect(entry["actor"]).toBe("viewer-test");

    // One backend, one file: `journalDir` holds only the file journal, never a per-surface copy.
    expect(readdirSync(journalDir)).toEqual(["journal.jsonl"]);
  });
});

describe("revocation is one live set for both surfaces (IT-43)", () => {
  const ROUTES = ["/notes", "/bundle", "/sessions"] as const;

  it("refuses a revoked device token on viewer and hub alike, without falling back to the secret", async () => {
    const server = await startViewerHub({
      adminSecret: ADMIN,
      authSecret: CLIENT,
      tokenKey: TOKEN_KEY,
    });

    const minted = await http(`${hubBase(server)}/admin/devices`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bluepencil-admin": ADMIN },
      body: JSON.stringify({ device: "viewer-test-device", scope: ["read", "write"] }),
    });
    expect(minted.status).toBe(201);
    const token = String(minted.json["token"]);
    const jti = String(minted.json["jti"]);
    expect(token.length).toBeGreaterThan(0);
    expect(jti.length).toBeGreaterThan(0);

    const bearer = { authorization: `Bearer ${token}` };

    // Before the revocation: the same token opens every read route on both surfaces.
    for (const route of ROUTES) {
      const onViewer = await http(`${viewerBase(server)}${route}`, { headers: bearer });
      expect(onViewer.status).toBe(200);
      const onHub = await http(`${hubBase(server)}${route}`, { headers: bearer });
      expect(onHub.status).toBe(200);
    }

    // Revocation through the hub's admin surface only touches the one live `revokedTokens` set.
    const revoked = await http(`${hubBase(server)}/admin/devices/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bluepencil-admin": ADMIN },
      body: JSON.stringify({ jti }),
    });
    expect(revoked.status).toBe(200);

    // After the revocation, with no restart: both surfaces say `401 token_revoked`.
    for (const route of ROUTES) {
      const onViewer = await http(`${viewerBase(server)}${route}`, { headers: bearer });
      expect(onViewer.status).toBe(401);
      expect(errorCode(onViewer)).toBe("token_revoked");

      const onHub = await http(`${hubBase(server)}${route}`, { headers: bearer });
      expect(onHub.status).toBe(401);
      expect(errorCode(onHub)).toBe("token_revoked");
    }

    // No downgrade: a valid shared secret next to the revoked token must not turn the refusal into
    // a 200 — `authorize()` never retries a presented token as `x-bluepencil-auth` (AC-5.32).
    const bothOnViewer = await http(`${viewerBase(server)}/notes`, {
      headers: { ...bearer, "x-bluepencil-auth": CLIENT },
    });
    expect(bothOnViewer.status).toBe(401);
    expect(errorCode(bothOnViewer)).toBe("token_revoked");

    const bothOnHub = await http(`${hubBase(server)}/notes`, {
      headers: { ...bearer, "x-bluepencil-auth": CLIENT },
    });
    expect(bothOnHub.status).toBe(401);
    expect(errorCode(bothOnHub)).toBe("token_revoked");
  });
});

describe("hub and viewer bundles are byte-identical (IT-44)", () => {
  /**
   * The four headers AC-5.33 names as the only allowed difference (spec §2.5: hub `--cors`).
   * `vary` is in the set because `corsHeaders()` emits it for an explicit origin.
   */
  const HUB_CORS_HEADERS = new Set([
    "access-control-allow-origin",
    "access-control-allow-headers",
    "access-control-max-age",
    "vary",
  ]);

  /**
   * Hop/transport headers `node:http` generates per response (`Date` has one-second resolution and
   * would make two sequential requests flaky). They carry no application contract, so the parity
   * assertion compares the application headers only; the CORS set above is the one allowed
   * application-level difference.
   */
  const TRANSPORT_HEADERS = new Set(["date", "connection", "keep-alive", "transfer-encoding"]);

  function headerRecord(headers: Headers): Record<string, string> {
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
      record[key.toLowerCase()] = value;
    });
    return record;
  }

  function applicationHeaders(headers: Headers): Record<string, string> {
    const record: Record<string, string> = {};
    for (const [key, value] of Object.entries(headerRecord(headers))) {
      if (HUB_CORS_HEADERS.has(key) || TRANSPORT_HEADERS.has(key)) continue;
      record[key] = value;
    }
    return record;
  }

  it("emits the same status, content-type and body for the shared store; only hub CORS differs", async () => {
    const server = await startViewerHub({
      adminSecret: ADMIN,
      authSecret: CLIENT,
      cors: CORS_ORIGIN,
      appName: "bp-test",
      exportedBy: EXPORTED_BY,
      now: () => FIXED_NOW,
    });

    // One note in the one store, written through the hub door; the bundle content is what both
    // surfaces read back.
    const created = await http(`${hubBase(server)}/notes`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bluepencil-auth": CLIENT },
      body: JSON.stringify(NOTE_DRAFT),
    });
    expect(created.status).toBe(200);
    const note = created.json["note"];
    if (!isRecord(note)) throw new Error(`the create answered without a note: ${created.text}`);
    const noteId = String(note["id"]);

    const hubBundle = await http(`${hubBase(server)}/bundle`, {
      headers: { "x-bluepencil-auth": CLIENT },
    });
    const viewerBundle = await http(`${viewerBase(server)}/bundle`, {
      headers: { "x-bluepencil-auth": CLIENT },
    });

    expect(viewerBundle.status).toBe(hubBundle.status);
    expect(hubBundle.status).toBe(200);
    expect(viewerBundle.headers.get("content-type")).toBe(hubBundle.headers.get("content-type"));

    // Status-, content-type- and body-identical: the body is the canonical bundle, fixed clock.
    expect(viewerBundle.text).toBe(hubBundle.text);

    const bundle = hubBundle.json;
    expect(bundle["exportedAt"]).toBe(FIXED_NOW);
    expect(bundle["exportedBy"]).toBe(EXPORTED_BY);
    const app = bundle["app"];
    expect(isRecord(app) ? app["name"] : undefined).toBe("bp-test");
    expect(noteIds(bundle)).toContain(noteId);

    // The headers differ only by the hub's CORS set: those are present on the hub, absent on the
    // viewer, and every application header left after removing them is equal.
    const hubHeaders = headerRecord(hubBundle.headers);
    const viewerHeaders = headerRecord(viewerBundle.headers);
    expect(hubHeaders["access-control-allow-origin"]).toBe(CORS_ORIGIN);
    expect(hubHeaders["vary"]).toBe("Origin");
    expect(viewerHeaders["access-control-allow-origin"]).toBeUndefined();
    expect(viewerHeaders["vary"]).toBeUndefined();
    expect(applicationHeaders(viewerBundle.headers)).toEqual(applicationHeaders(hubBundle.headers));
  });
});
