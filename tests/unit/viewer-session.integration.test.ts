/**
 * @vitest-environment node — this suite binds real sockets and compares real `Set-Cookie` lines on
 * the wire; jsdom cannot do either.
 *
 * Task 11 of the viewer-origin plan (issue #140): launcher, ticket and session integration —
 * IT-03, IT-04, IT-05, IT-12, IT-13, IT-14, IT-41.
 *
 * Every case starts a real hub with `startHub()` and talks to both listeners over `node:http`.
 * Nothing here is mocked: the point is the wiring between `startHub()`, the hub-side launcher
 * (`{base}/viewer/start`), the viewer door (`handleViewer()`) and the session cookie. The one
 * assembly that is not real is the clock used for the 60-second launcher-ticket TTL: faking only
 * `Date` moves the ticket store past its deadline without waiting a minute, while sockets and
 * timers stay real.
 *
 * Hermetic: no request in this file reaches another host. The `/view` calls carry no session, so
 * the viewer refuses them before `fetch()` is ever considered (spec §2.2 rule 5).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as nodeRequest } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_BASE_PATH, type HandlerContext } from "../../server/handler";
import { startHub } from "../../server/hub";
import type { HubOptions, RunningServer } from "../../server/hub";
import { VIEWER_COOKIE, viewerSessionRefusalMessage } from "../../server/viewer";

/** The API base this suite starts the hub with; `{base}` in the ACs. */
const BASE = DEFAULT_BASE_PATH;
/** The operator credential the launcher verifies; it must never surface on the viewer origin. */
const OPERATOR_SECRET = "viewer-session-integration-operator";
/** Session lifetime, so `Max-Age` can be asserted verbatim. */
const TTL_SECONDS = 3_600;
/** The launcher ticket's own lifetime (spec §2.2); a fake clock moves past it. */
const TICKET_TTL_SECONDS = 60;
/** Body of the stub layer bundle; the assets route only needs bytes on disk. */
const ASSET_BODY = "/* bluepencil.element.min.js — integration stub */\n";

interface Answer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
}

interface RequestInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

const servers: RunningServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  // Restore the clock before closing: `close()` waits on real callbacks.
  vi.useRealTimers();
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

/** A `dist`-shaped directory holding the one bundle the assets route serves. */
function assetsDir(): string {
  const dir = tempDir("bp-viewer-session-assets-");
  writeFileSync(join(dir, "bluepencil.element.min.js"), ASSET_BODY);
  return dir;
}

/** A store path in its own directory, so parallel starts cannot share a journal location. */
function storePath(): string {
  return join(tempDir("bp-viewer-session-store-"), "notes.bluepencil.json");
}

/** The viewer half of `HubOptions`, on ephemeral loopback ports by default. */
function viewerConfig(
  overrides: Partial<NonNullable<HubOptions["viewer"]>> = {},
): NonNullable<HubOptions["viewer"]> {
  return {
    host: "127.0.0.1",
    port: 0,
    assetsDir: assetsDir(),
    allow: ["example.com"],
    ttlSeconds: TTL_SECONDS,
    ...overrides,
  };
}

/** Starts a tracked hub on ephemeral loopback ports; `afterEach` guarantees no leaked listener. */
async function serve(overrides: Partial<HubOptions> = {}): Promise<RunningServer> {
  const server = await startHub({
    storePath: storePath(),
    port: 0,
    host: "127.0.0.1",
    base: BASE,
    quiet: true,
    journal: "none",
    ...overrides,
  });
  servers.push(server);
  return server;
}

function viewerOf(server: RunningServer): NonNullable<RunningServer["viewer"]> {
  if (server.viewer === undefined) throw new Error("expected a viewer listener");
  return server.viewer;
}

/** The public hub origin the launcher hint is built from (the loopback *bind* origin). */
function hubOriginOf(server: RunningServer): string {
  return new URL(server.url).origin;
}

/** One HTTP round trip against a real listener; no client-side cookie jar on purpose. */
function request(port: number, path: string, init: RequestInit = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = nodeRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: init.method ?? "GET",
        headers: init.headers ?? {},
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text });
        });
      },
    );
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/**
 * The exact string `viewerSessionRefusalMessage()` produces for `hubOrigin`, computed with the
 * function under test (not copied). `undefined` models "no publicly reachable hub origin".
 */
function expectedRefusal(hubOrigin: string | undefined): string {
  return viewerSessionRefusalMessage({
    base: BASE,
    viewer: { hubOrigin, assetsDir: "", allow: [], ttlSeconds: TTL_SECONDS },
  } as unknown as HandlerContext);
}

function errorOf(answer: Answer): { code?: string; message?: string } {
  const payload = JSON.parse(answer.text) as { error?: { code?: string; message?: string } };
  return payload.error ?? {};
}

/** The one shape every viewer-session refusal must have (spec §2.2 rule 7). */
function expectRefusal(answer: Answer, expected: string): void {
  expect(answer.status).toBe(401);
  expect(answer.headers["set-cookie"]).toBeUndefined();
  const error = errorOf(answer);
  expect(error.code).toBe("unauthorized");
  expect(error.message).toBe(expected);
}

function setCookies(answer: Answer): string[] {
  const raw = answer.headers["set-cookie"];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

/** The `Set-Cookie` line for the viewer session, exactly as it crossed the wire. */
function viewerCookie(answer: Answer): string {
  const cookie = setCookies(answer).find((value) => value.startsWith(`${VIEWER_COOKIE}=`));
  expect(cookie, "the answer must set the viewer session cookie").toBeDefined();
  return String(cookie);
}

/** `bp_viewer=<token>` — the pair a browser would send back. */
function cookiePair(answer: Answer): string {
  return viewerCookie(answer).split(";")[0] ?? "";
}

function cookieToken(answer: Answer): string {
  return cookiePair(answer).slice(VIEWER_COOKIE.length + 1);
}

interface Launch {
  readonly answer: Answer;
  readonly location: URL;
  readonly ticket: string;
}

/** Drives the hub-side launcher with the operator secret and returns the minted ticket. */
async function launch(server: RunningServer): Promise<Launch> {
  const answer = await request(server.port, `${BASE}/viewer/start`, {
    headers: { "x-bluepencil-admin": OPERATOR_SECRET },
  });
  expect(answer.status).toBe(302);
  const location = new URL(String(answer.headers.location));
  const ticket = location.searchParams.get("ticket") ?? "";
  expect(ticket).toMatch(/^[0-9a-f]{48}$/);
  return { answer, location, ticket };
}

async function launcherTicket(server: RunningServer): Promise<string> {
  return (await launch(server)).ticket;
}

/** Redeems a ticket on the real viewer listener. */
function redeemTicket(server: RunningServer, ticket: string): Promise<Answer> {
  return request(viewerOf(server).port, `${BASE}/viewer?ticket=${ticket}`);
}

/** The exact `Set-Cookie` value the contract requires, without the `Secure` suffix. */
function plainCookie(token: string): string {
  return (
    `${VIEWER_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=${BASE}; Max-Age=${TTL_SECONDS}`
  );
}

describe("IT-03 — the session gate names one launcher URL (AC-5.3)", () => {
  it("refuses the shell, the bookmarklet and /view with the same message that names the launcher", async () => {
    const server = await serve({ viewer: viewerConfig(), adminSecret: OPERATOR_SECRET });
    const viewer = viewerOf(server);
    const hubOrigin = hubOriginOf(server);
    const expected = expectedRefusal(hubOrigin);

    const answers = await Promise.all([
      request(viewer.port, `${BASE}/viewer`),
      request(viewer.port, `${BASE}/viewer/bookmarklet.txt`),
      request(viewer.port, `${BASE}/view?url=${encodeURIComponent("https://example.com")}`),
    ]);

    for (const answer of answers) expectRefusal(answer, expected);
    // Byte-identical means one message, not three paraphrases.
    expect(new Set(answers.map((answer) => answer.text)).size).toBe(1);

    expect(expected).toContain(`${hubOrigin}${BASE}/viewer/start`);
    expect(expected).not.toContain(`${BASE}/viewer?k=`);
    expect(answers[0]?.text).not.toContain(`${BASE}/viewer?k=`);
  });

  it("serves the shell with the documented headers once a session is presented", async () => {
    const server = await serve({ viewer: viewerConfig(), adminSecret: OPERATOR_SECRET });
    const viewer = viewerOf(server);
    const redeemed = await redeemTicket(server, await launcherTicket(server));
    expect(redeemed.status).toBe(302);

    const shell = await request(viewer.port, `${BASE}/viewer`, {
      headers: { cookie: cookiePair(redeemed) },
    });
    expect(shell.status).toBe(200);
    expect(shell.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(shell.headers["cache-control"]).toBe("no-store");
    expect(shell.headers["referrer-policy"]).toBe("no-referrer");
    expect(shell.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });
});

describe("IT-04 — the launcher exchanges the operator secret for a one-time ticket (AC-5.4)", () => {
  it("answers 302 for header and ?k=, 401 for missing and wrong, and the header wins", async () => {
    const server = await serve({ viewer: viewerConfig(), adminSecret: OPERATOR_SECRET });
    const origin = viewerOf(server).origin;
    const start = `${BASE}/viewer/start`;

    const byHeader = await request(server.port, start, {
      headers: { "x-bluepencil-admin": OPERATOR_SECRET },
    });
    expect(byHeader.status).toBe(302);
    expectLauncherRedirect(byHeader, origin);

    const byQuery = await request(server.port, `${start}?k=${encodeURIComponent(OPERATOR_SECRET)}`);
    expect(byQuery.status).toBe(302);
    expectLauncherRedirect(byQuery, origin);

    // The header wins: a wrong `?k=` next to a correct header is never consulted.
    const headerWins = await request(server.port, `${start}?k=not-the-secret`, {
      headers: { "x-bluepencil-admin": OPERATOR_SECRET },
    });
    expect(headerWins.status).toBe(302);
    expectLauncherRedirect(headerWins, origin);

    const missing = await request(server.port, start);
    expect(missing.status).toBe(401);
    expect(missing.headers["set-cookie"]).toBeUndefined();
    expect(errorOf(missing).code).toBe("unauthorized");

    // …and present-but-wrong wins over a correct `?k=` in the same way.
    const wrongHeader = await request(
      server.port,
      `${start}?k=${encodeURIComponent(OPERATOR_SECRET)}`,
      { headers: { "x-bluepencil-admin": "not-the-secret" } },
    );
    expect(wrongHeader.status).toBe(401);
    expect(wrongHeader.headers["set-cookie"]).toBeUndefined();
  });
});

/** One launcher success: 302 onto the viewer origin, ticket, no cookie. */
function expectLauncherRedirect(answer: Answer, origin: string): void {
  const location = String(answer.headers.location);
  expect(location.startsWith(`${origin}${BASE}/viewer?ticket=`)).toBe(true);
  expect(new URL(location).searchParams.get("ticket")).toMatch(/^[0-9a-f]{48}$/);
  expect(answer.headers["referrer-policy"]).toBe("no-referrer");
  expect(answer.headers["cache-control"]).toBe("no-store");
  expect(answer.headers["set-cookie"]).toBeUndefined();
}

describe("IT-05 — ticket redemption, cookie on the wire, replay and expiry (AC-5.5, AC-5.13)", () => {
  it("redeems once, sets the cookie on the wire and refuses a replay without a cookie", async () => {
    const server = await serve({ viewer: viewerConfig(), adminSecret: OPERATOR_SECRET });
    const viewer = viewerOf(server);
    expect(viewer.origin).toBe(`http://127.0.0.1:${viewer.port}`);
    const expected = expectedRefusal(hubOriginOf(server));
    const ticket = await launcherTicket(server);

    const first = await redeemTicket(server, ticket);
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe(`${BASE}/viewer`);
    expect(first.headers["referrer-policy"]).toBe("no-referrer");
    expect(first.headers["cache-control"]).toBe("no-store");

    const cookie = viewerCookie(first);
    expect(cookie).toBe(plainCookie(cookieToken(first)));
    expect(cookie).not.toContain("Domain");

    // The minted session opens the shell.
    const shell = await request(viewer.port, `${BASE}/viewer`, {
      headers: { cookie: cookiePair(first) },
    });
    expect(shell.status).toBe(200);

    // Single use: the second redemption is a plain session refusal, no fresh cookie.
    const replay = await redeemTicket(server, ticket);
    expectRefusal(replay, expected);
  });

  it("refuses a ticket once the 60-second launcher TTL has passed", async () => {
    const server = await serve({ viewer: viewerConfig(), adminSecret: OPERATOR_SECRET });
    const expected = expectedRefusal(hubOriginOf(server));
    const ticket = await launcherTicket(server);

    const realNow = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(realNow + (TICKET_TTL_SECONDS + 1) * 1000));
      const expired = await redeemTicket(server, ticket);
      expectRefusal(expired, expected);
    } finally {
      vi.useRealTimers();
    }
  });

  it("derives the Secure flag end-to-end from the public origin (explicit https → Secure, derived http → none)", async () => {
    // Explicit `https://` origin: the launcher names it, the real listener still answers on loopback.
    const secureServer = await serve({
      viewer: viewerConfig({ origin: "https://view.example.com" }),
      adminSecret: OPERATOR_SECRET,
    });
    expect(viewerOf(secureServer).origin).toBe("https://view.example.com");
    const secureLaunch = await launch(secureServer);
    expect(secureLaunch.location.origin).toBe("https://view.example.com");
    expect(secureLaunch.location.pathname).toBe(`${BASE}/viewer`);

    const secureAnswer = await redeemTicket(secureServer, secureLaunch.ticket);
    expect(secureAnswer.status).toBe(302);
    expect(viewerCookie(secureAnswer)).toBe(`${plainCookie(cookieToken(secureAnswer))}; Secure`);

    // Derived `http://` origin: `publicOrigin()` has no explicit https, so no `Secure`.
    const plainServer = await serve({ viewer: viewerConfig(), adminSecret: OPERATOR_SECRET });
    expect(viewerOf(plainServer).origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const plainLaunch = await launch(plainServer);
    expect(plainLaunch.location.origin).toBe(viewerOf(plainServer).origin);

    const plainAnswer = await redeemTicket(plainServer, plainLaunch.ticket);
    expect(plainAnswer.status).toBe(302);
    expect(viewerCookie(plainAnswer)).not.toContain("Secure");
    expect(viewerCookie(plainAnswer)).toBe(plainCookie(cookieToken(plainAnswer)));
  });
});

describe("IT-12 — the admin secret is inert on the viewer origin (AC-5.12)", () => {
  it("refuses every route identically and spends no launcher budget while the hub origin is public", async () => {
    const server = await serve({ viewer: viewerConfig(), adminSecret: OPERATOR_SECRET });
    const viewer = viewerOf(server);
    const hubOrigin = hubOriginOf(server);
    const expected = expectedRefusal(hubOrigin);

    // Correct and wrong `?k=` are both refused — and indistinguishable (no oracle).
    const withSecret = await request(
      viewer.port,
      `${BASE}/viewer?k=${encodeURIComponent(OPERATOR_SECRET)}`,
    );
    const withWrong = await request(viewer.port, `${BASE}/viewer?k=not-the-secret`);
    expectRefusal(withSecret, expected);
    expectRefusal(withWrong, expected);
    expect(withWrong.text).toBe(withSecret.text);

    // The admin secret is not a viewer credential either.
    const notes = await request(viewer.port, `${BASE}/notes`, {
      method: "POST",
      headers: { "x-bluepencil-admin": OPERATOR_SECRET, "content-type": "application/json" },
    });
    expectRefusal(notes, expected);

    const anonymous = await Promise.all([
      request(viewer.port, `${BASE}/viewer`),
      request(viewer.port, `${BASE}/viewer/bookmarklet.txt`),
      request(viewer.port, `${BASE}/view?url=${encodeURIComponent("https://example.com")}`),
    ]);
    for (const answer of anonymous) expectRefusal(answer, expected);

    const bodies = new Set([
      withSecret.text,
      withWrong.text,
      notes.text,
      ...anonymous.map((answer) => answer.text),
    ]);
    expect(bodies.size).toBe(1);
    expect(expected).toContain(`${hubOrigin}${BASE}/viewer/start`);
    for (const body of bodies) {
      expect(body).not.toContain(`${BASE}/viewer?k=`);
      expect(body).not.toContain(OPERATOR_SECRET);
    }

    // The viewer-side guesses must not have spent the hub launcher's `admin` budget: more guesses
    // than the throttle allows (10), then the correct secret still mints a ticket.
    const guesses = await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        request(viewer.port, `${BASE}/viewer?k=guess-${index}`),
      ),
    );
    for (const guess of guesses) expectRefusal(guess, expected);

    const stillAllowed = await request(server.port, `${BASE}/viewer/start`, {
      headers: { "x-bluepencil-admin": OPERATOR_SECRET },
    });
    expect(stillAllowed.status).toBe(302);
  });

  it("stays URL-less when the hub bind is not loopback (wildcard), so no internal origin leaks", async () => {
    // A wildcard hub bind is `viewer.hubOrigin === undefined` in `startHub()`; the viewer still
    // binds loopback, so the listener is reachable without exposing the machine.
    const server = await serve({
      host: "0.0.0.0",
      viewer: viewerConfig(),
      adminSecret: OPERATOR_SECRET,
    });
    const viewer = viewerOf(server);
    const expected = expectedRefusal(undefined);
    expect(expected).toContain("open the hub launcher");
    expect(expected).not.toMatch(/https?:\/\//);

    const answers = await Promise.all([
      request(viewer.port, `${BASE}/viewer?k=${encodeURIComponent(OPERATOR_SECRET)}`),
      request(viewer.port, `${BASE}/viewer?k=not-the-secret`),
      request(viewer.port, `${BASE}/notes`, {
        method: "POST",
        headers: { "x-bluepencil-admin": OPERATOR_SECRET, "content-type": "application/json" },
      }),
      request(viewer.port, `${BASE}/viewer`),
      request(viewer.port, `${BASE}/viewer/bookmarklet.txt`),
      request(viewer.port, `${BASE}/view?url=${encodeURIComponent("https://example.com")}`),
    ]);

    for (const answer of answers) expectRefusal(answer, expected);
    expect(new Set(answers.map((answer) => answer.text)).size).toBe(1);
    for (const answer of answers) {
      expect(answer.text).not.toMatch(/https?:\/\//);
      expect(answer.text).not.toContain(OPERATOR_SECRET);
      expect(answer.text).not.toContain(`${BASE}/viewer?k=`);
    }
  });
});

describe("IT-13 — assets are public and answered before the session check (AC-5.14)", () => {
  it("serves the built bundle without a cookie and 404s an unknown asset", async () => {
    const server = await serve({ viewer: viewerConfig(), adminSecret: OPERATOR_SECRET });
    const viewer = viewerOf(server);

    const asset = await request(viewer.port, `${BASE}/viewer/assets/bluepencil.element.min.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(asset.headers["access-control-allow-origin"]).toBe("*");
    expect(asset.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(asset.headers["cache-control"]).toBe("no-cache");
    expect(asset.headers["set-cookie"]).toBeUndefined();
    expect(asset.text).toBe(ASSET_BODY);

    const unknown = await request(viewer.port, `${BASE}/viewer/assets/unbekannt.js`);
    expect(unknown.status).toBe(404);
    expect(errorOf(unknown).code).toBe("not_found");
    expect(unknown.headers["set-cookie"]).toBeUndefined();
  });
});

describe("IT-14 — the bookmarklet is session-protected and ships only the placeholder (AC-5.15)", () => {
  it("refuses the artifact without a session and serves it with the placeholder under a session", async () => {
    const server = await serve({ viewer: viewerConfig(), adminSecret: OPERATOR_SECRET });
    const viewer = viewerOf(server);
    const expected = expectedRefusal(hubOriginOf(server));

    const anonymous = await request(viewer.port, `${BASE}/viewer/bookmarklet.txt`);
    expectRefusal(anonymous, expected);

    const redeemed = await redeemTicket(server, await launcherTicket(server));
    const token = cookieToken(redeemed);
    expect(token).toMatch(/^[0-9a-f]{48}$/);

    const authorized = await request(viewer.port, `${BASE}/viewer/bookmarklet.txt`, {
      headers: { cookie: cookiePair(redeemed) },
    });
    expect(authorized.status).toBe(200);
    expect(authorized.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(authorized.text).toContain("__BP_VIEWER_TOKEN__");
    // The static artifact must never carry a live 48-hex session token.
    expect(authorized.text).not.toContain(token);
    expect(authorized.text).not.toMatch(/[0-9a-f]{48}/);
  });
});

describe("IT-41 — the asset is served while the shell without a session is refused (AC-5.14)", () => {
  it("answers 200 for the asset and 401 for the shell in the same instance, order included", async () => {
    const server = await serve({ viewer: viewerConfig(), adminSecret: OPERATOR_SECRET });
    const viewer = viewerOf(server);

    const asset = await request(viewer.port, `${BASE}/viewer/assets/bluepencil.element.min.js`);
    expect(asset.status).toBe(200);
    expect(asset.text).toBe(ASSET_BODY);

    const shell = await request(viewer.port, `${BASE}/viewer`);
    expect(shell.status).toBe(401);
    expect(errorOf(shell).code).toBe("unauthorized");

    // The refused shell never leaks the layer markup; the public asset obviously is the layer.
    expect(shell.text).not.toContain("<bluepencil-notes");
  });
});
