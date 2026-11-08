/**
 * @vitest-environment node — the viewer reads bundles from disk and the proxy follows redirects;
 * neither is a jsdom concern.
 *
 * Viewer door order and the hub launcher (issue #140, plan Task 7): UT-20, UT-23, UT-32.
 *
 * The contract under test is the *order*, not only the answers: assets before the session check, a
 * valid `?ticket` before `?k=`, `?k=` before the session (and never compared), and the launcher's
 * origin check before the operator secret is verified.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  VIEWER_HEADER,
  createViewerTickets,
  handleViewer,
  handleViewerStart,
  isViewerStartRequest,
  viewerStartPath,
} from "../../server/viewer";
import { BOOKMARKLET_TOKEN_MARKER } from "../../server/viewer-bookmarklet";
import {
  BASE,
  HUB_ORIGIN,
  VIEWER_ORIGIN,
  request,
  stubFetch,
  stubResolver,
  viewerContext,
  type ViewerFixture,
} from "./helpers/viewer-harness";

const SECRET = "operator-secret-123456";
const PUBLIC = "93.184.216.34";

/** A viewer fixture with a shared ticket store, so the hub can mint what the viewer redeems. */
function sharedTickets(overrides: Parameters<typeof viewerContext>[0] = {}): {
  hub: ViewerFixture;
  viewer: ViewerFixture;
  tickets: ReturnType<typeof createViewerTickets>;
} {
  const tickets = createViewerTickets();
  const hub = viewerContext({ ...overrides, surface: "hub", tickets });
  const viewer = viewerContext({ ...overrides, tickets });
  return { hub, viewer, tickets };
}

function mintTicket(hub: ViewerFixture, headers: Record<string, string> = { "x-bluepencil-admin": SECRET }): string {
  const started = handleViewerStart(request(`${BASE}/viewer/start`, headers), hub);
  expect(started?.status).toBe(302);
  const location = new URL(String(started?.headers.location));
  const ticket = location.searchParams.get("ticket");
  expect(ticket).toMatch(/^[0-9a-f]{48}$/);
  return String(ticket);
}

describe("isViewerStartRequest (UT-20)", () => {
  it("matches only {base}/viewer/start on the path, regardless of query and trailing slash", () => {
    const context = viewerContext({ surface: "hub" });
    expect(viewerStartPath(BASE)).toBe(`${BASE}/viewer/start`);
    expect(viewerStartPath(`${BASE}/`)).toBe(`${BASE}/viewer/start`);

    expect(isViewerStartRequest(`${BASE}/viewer/start`, context)).toBe(true);
    expect(isViewerStartRequest(`${BASE}/viewer/start?k=secret`, context)).toBe(true);
    expect(isViewerStartRequest(`${BASE}/viewer/start/`, context)).toBe(true);
    expect(isViewerStartRequest(`${BASE}/viewer`, context)).toBe(false);
    expect(isViewerStartRequest(`${BASE}/viewer/startle`, context)).toBe(false);
    expect(isViewerStartRequest(`${BASE}/viewer/start`, viewerContext({ base: "/other" }))).toBe(false);
    expect(isViewerStartRequest(`${BASE}/viewer/start`, { ...context, viewer: undefined })).toBe(false);
  });
});

describe("handleViewerStart — surface and start window (UT-32)", () => {
  it("answers null on the viewer surface and for any other path", () => {
    const viewer = viewerContext({ surface: "viewer" });
    expect(handleViewerStart(request(`${BASE}/viewer/start`, { "x-bluepencil-admin": SECRET }), viewer)).toBeNull();

    const hub = viewerContext({ surface: "hub" });
    expect(handleViewerStart(request(`${BASE}/viewer`, { "x-bluepencil-admin": SECRET }), hub)).toBeNull();
    expect(handleViewerStart(request(`${BASE}/viewer/start`, { "x-bluepencil-admin": SECRET }), {
      ...hub,
      viewer: undefined,
    })).toBeNull();
  });

  it("answers 503 service_not_ready without Location, Set-Cookie or a minted ticket", () => {
    const base = viewerContext({ surface: "hub" });
    const hub: ViewerFixture = { ...base, viewer: { ...base.viewer, origin: undefined } };

    const answer = handleViewerStart(request(`${BASE}/viewer/start`, { "x-bluepencil-admin": SECRET }), hub);
    expect(answer?.status).toBe(503);
    expect(answer?.headers.location).toBeUndefined();
    expect(answer?.headers["set-cookie"]).toBeUndefined();
    expect(answer?.headers["cache-control"]).toBe("no-store");
    expect(answer?.headers["retry-after"]).toBe("1");
    expect(answer?.body).toContain("service_not_ready");
    expect(hub.viewer.tickets.size()).toBe(0);
  });

  it("checks the origin before verifyOperatorSecret, so the start window spends no budget", () => {
    const base = viewerContext({ surface: "hub" });
    const throttle = { allow: vi.fn(() => true), failure: vi.fn(), success: vi.fn() };
    const hub: ViewerFixture = {
      ...base,
      adminThrottle: throttle,
      viewer: { ...base.viewer, origin: undefined },
    };

    const answer = handleViewerStart(request(`${BASE}/viewer/start`, { "x-bluepencil-admin": "wrong" }), hub);
    expect(answer?.status).toBe(503);
    expect(throttle.allow).not.toHaveBeenCalled();
    expect(throttle.failure).not.toHaveBeenCalled();
    expect(hub.viewer.tickets.size()).toBe(0);
  });
});

describe("handleViewerStart — operator secret to ticket (AC-5.4)", () => {
  it("mints a ticket and redirects onto the viewer origin with the documented headers", () => {
    const hub = viewerContext({ surface: "hub" });
    const answer = handleViewerStart(request(`${BASE}/viewer/start`, { "x-bluepencil-admin": SECRET }), hub);

    expect(answer?.status).toBe(302);
    expect(answer?.headers["set-cookie"]).toBeUndefined();
    expect(answer?.headers["referrer-policy"]).toBe("no-referrer");
    expect(answer?.headers["cache-control"]).toBe("no-store");
    const location = new URL(String(answer?.headers.location));
    expect(location.origin).toBe(VIEWER_ORIGIN);
    expect(location.pathname).toBe(`${BASE}/viewer`);
    expect(location.searchParams.get("ticket")).toMatch(/^[0-9a-f]{48}$/);
    expect(hub.viewer.tickets.size()).toBe(1);
  });

  it("accepts ?k= as the second form of the same credential", () => {
    const hub = viewerContext({ surface: "hub" });
    const answer = handleViewerStart(request(`${BASE}/viewer/start?k=${SECRET}`), hub);
    expect(answer?.status).toBe(302);
    expect(String(answer?.headers.location)).toContain("?ticket=");
  });

  it("answers 401 without a credential and for a wrong one", () => {
    const hub = viewerContext({ surface: "hub" });
    const cases: Record<string, string>[] = [
      {},
      { "x-bluepencil-admin": "wrong" },
      { "x-bluepencil-admin": SECRET.slice(0, -1) },
    ];
    for (const headers of cases) {
      const answer = handleViewerStart(request(`${BASE}/viewer/start`, headers), hub);
      expect(answer?.status).toBe(401);
      expect(answer?.headers["set-cookie"]).toBeUndefined();
      expect(answer?.body).toContain("unauthorized");
    }
    expect(hub.viewer.tickets.size()).toBe(0);
  });

  it("lets x-bluepencil-admin win over ?k=, including an empty header", () => {
    const hub = viewerContext({ surface: "hub" });
    const headerWins = handleViewerStart(
      request(`${BASE}/viewer/start?k=wrong`, { "x-bluepencil-admin": SECRET }),
      hub,
    );
    expect(headerWins?.status).toBe(302);

    const noFallback = handleViewerStart(
      request(`${BASE}/viewer/start?k=${SECRET}`, { "x-bluepencil-admin": "wrong" }),
      hub,
    );
    expect(noFallback?.status).toBe(401);

    const emptyHeader = handleViewerStart(
      request(`${BASE}/viewer/start?k=${SECRET}`, { "x-bluepencil-admin": "" }),
      hub,
    );
    expect(emptyHeader?.status).toBe(401);
  });

  it("answers 429 with Retry-After when the admin budget is exhausted", () => {
    const hub = viewerContext({ surface: "hub" });
    hub.adminThrottle = { allow: () => false, failure: () => undefined, success: () => undefined };
    const answer = handleViewerStart(request(`${BASE}/viewer/start`, { "x-bluepencil-admin": SECRET }), hub);
    expect(answer?.status).toBe(429);
    expect(answer?.headers["retry-after"]).toBe("300");
    expect(answer?.body).toContain("too_many_attempts");
    expect(hub.viewer.tickets.size()).toBe(0);
  });
});

describe("handleViewerStart — method gate (spec §5.1 rule 6)", () => {
  it("answers 405 with Allow: GET, POST for every method that is neither", () => {
    const throttle = { allow: vi.fn(() => true), failure: vi.fn(), success: vi.fn() };
    const hub = viewerContext({ surface: "hub" });
    hub.adminThrottle = throttle;

    for (const method of ["PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const answer = handleViewerStart(
        request(`${BASE}/viewer/start`, { "x-bluepencil-admin": SECRET }, method),
        hub,
      );
      expect(answer?.status, method).toBe(405);
      expect(answer?.headers.allow, method).toBe("GET, POST");
      expect(answer?.headers.connection, method).toBe("close");
      expect(answer?.body, method).toContain("method_not_allowed");
    }

    // A method refusal happens before the secret: no ticket, no budget read, no budget spent.
    expect(hub.viewer.tickets.size()).toBe(0);
    expect(throttle.allow).not.toHaveBeenCalled();
    expect(throttle.failure).not.toHaveBeenCalled();
    expect(throttle.success).not.toHaveBeenCalled();
  });

  it("wins over the start window, so a PUT or DELETE during startup is 405 and not 503", () => {
    const base = viewerContext({ surface: "hub" });
    const hub: ViewerFixture = { ...base, viewer: { ...base.viewer, origin: undefined } };

    for (const method of ["PUT", "DELETE"]) {
      const answer = handleViewerStart(
        request(`${BASE}/viewer/start`, { "x-bluepencil-admin": SECRET }, method),
        hub,
      );
      expect(answer?.status, method).toBe(405);
      expect(answer?.headers.allow, method).toBe("GET, POST");
      expect(answer?.headers.location, method).toBeUndefined();
    }
    expect(hub.viewer.tickets.size()).toBe(0);
  });

  it("accepts a POST with a valid header as 303 — it is no longer a 405", () => {
    const hub = viewerContext({ surface: "hub" });
    const answer = handleViewerStart(
      request(
        `${BASE}/viewer/start`,
        { "x-bluepencil-admin": SECRET, accept: "text/html" },
        "POST",
      ),
      hub,
    );
    expect(answer?.status).toBe(303);
    expect(String(answer?.headers.location)).toContain("?ticket=");
    expect(hub.viewer.tickets.size()).toBe(1);
  });

  it("answers 503 for a POST during the start window", () => {
    const base = viewerContext({ surface: "hub" });
    const hub: ViewerFixture = { ...base, viewer: { ...base.viewer, origin: undefined } };
    const answer = handleViewerStart(
      request(`${BASE}/viewer/start`, { "x-bluepencil-admin": SECRET }, "POST"),
      hub,
    );
    expect(answer?.status).toBe(503);
    expect(answer?.body).toContain("service_not_ready");
    expect(hub.viewer.tickets.size()).toBe(0);
  });
});

describe("handleViewerStart — empty operator secret (R2-F1)", () => {
  it("answers 401 for empty expected + empty presented, mints no ticket and spends no budget", () => {
    const throttle = { allow: vi.fn(() => true), failure: vi.fn(), success: vi.fn() };
    const hub = viewerContext({ surface: "hub", adminSecret: "" });
    hub.adminThrottle = throttle;

    const cases = [
      request(`${BASE}/viewer/start`, { "x-bluepencil-admin": "" }),
      request(`${BASE}/viewer/start?k=`),
      request(`${BASE}/viewer/start?k=${SECRET}`, { "x-bluepencil-admin": "" }),
      request(`${BASE}/viewer/start`),
    ];
    for (const req of cases) {
      const answer = handleViewerStart(req, hub);
      expect(answer?.status, req.url).toBe(401);
      expect(answer?.headers.location, req.url).toBeUndefined();
      expect(answer?.body, req.url).toContain("unauthorized");
    }

    expect(hub.viewer.tickets.size()).toBe(0);
    expect(throttle.allow).not.toHaveBeenCalled();
    expect(throttle.failure).not.toHaveBeenCalled();
    expect(throttle.success).not.toHaveBeenCalled();
  });

  it("never authorizes a non-empty value against an empty configured secret", () => {
    const throttle = { allow: vi.fn(() => true), failure: vi.fn(), success: vi.fn() };
    const hub = viewerContext({ surface: "hub", adminSecret: "" });
    hub.adminThrottle = throttle;

    for (const req of [
      request(`${BASE}/viewer/start`, { "x-bluepencil-admin": SECRET }),
      request(`${BASE}/viewer/start?k=${SECRET}`),
    ]) {
      const answer = handleViewerStart(req, hub);
      expect(answer?.status).toBe(401);
      expect(answer?.headers.location).toBeUndefined();
    }
    expect(hub.viewer.tickets.size()).toBe(0);
    expect(throttle.allow).not.toHaveBeenCalled();
  });
});

describe("ticket redemption (UT-20 / AC-5.5)", () => {
  it("redeems a ticket for a session cookie and redirects to {base}/viewer without a query", async () => {
    const { hub, viewer } = sharedTickets();
    const ticket = mintTicket(hub);

    const answer = await handleViewer(request(`${BASE}/viewer?ticket=${ticket}`), viewer);
    expect(answer?.status).toBe(302);
    expect(answer?.headers.location).toBe(`${BASE}/viewer`);
    expect(answer?.headers["referrer-policy"]).toBe("no-referrer");
    expect(answer?.headers["cache-control"]).toBe("no-store");
    const cookie = String(answer?.headers["set-cookie"]);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain(`Path=${BASE}`);
    expect(cookie).not.toContain("Secure"); // http origin

    // The minted session authorizes the shell.
    const token = cookie.slice(cookie.indexOf("=") + 1, cookie.indexOf(";"));
    expect(viewer.viewer.sessions.verify(token)).toBe(true);
    const shell = await handleViewer(request(`${BASE}/viewer`, { cookie: `bp_viewer=${token}` }), viewer);
    expect(shell?.status).toBe(200);
  });

  it("sets Secure exactly for an https viewer origin", async () => {
    const origin = "https://view.example:8788";
    const { hub, viewer } = sharedTickets({ origin });
    const ticket = mintTicket(hub);
    const answer = await handleViewer(request(`${BASE}/viewer?ticket=${ticket}`), viewer);
    expect(String(answer?.headers["set-cookie"])).toContain("Secure");
  });

  it("refuses a replay, an unknown and an expired ticket with no cookie", async () => {
    const { hub, viewer } = sharedTickets();
    const ticket = mintTicket(hub);
    const first = await handleViewer(request(`${BASE}/viewer?ticket=${ticket}`), viewer);
    expect(first?.status).toBe(302);

    const replay = await handleViewer(request(`${BASE}/viewer?ticket=${ticket}`), viewer);
    expect(replay?.status).toBe(401);
    expect(replay?.headers["set-cookie"]).toBeUndefined();

    const unknown = await handleViewer(request(`${BASE}/viewer?ticket=deadbeef`), viewer);
    expect(unknown?.status).toBe(401);
    expect(unknown?.headers["set-cookie"]).toBeUndefined();
  });

  it("lets a valid ticket win over ?k= and never compares k when the ticket is invalid", async () => {
    const { hub, viewer } = sharedTickets();
    const ticket = mintTicket(hub);

    const ticketWins = await handleViewer(request(`${BASE}/viewer?ticket=${ticket}&k=wrong`), viewer);
    expect(ticketWins?.status).toBe(302);
    expect(ticketWins?.headers["set-cookie"]).toBeDefined();

    const invalidWins = await handleViewer(request(`${BASE}/viewer?ticket=nope&k=${SECRET}`), viewer);
    expect(invalidWins?.status).toBe(401);
    expect(invalidWins?.headers["set-cookie"]).toBeUndefined();
  });
});

describe("assets before session (AC-5.14)", () => {
  it("serves a known bundle without any session and with the cross-origin headers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bp-viewer-assets-"));
    writeFileSync(join(dir, "bluepencil.element.min.js"), "export const x = 1;");
    const context = viewerContext({ assetsDir: dir });

    const answer = await handleViewer(
      request(`${BASE}/viewer/assets/bluepencil.element.min.js`),
      context,
    );
    expect(answer?.status).toBe(200);
    expect(answer?.headers["content-type"]).toContain("text/javascript");
    expect(answer?.headers["access-control-allow-origin"]).toBe("*");
    expect(answer?.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(answer?.headers["cache-control"]).toBe("no-cache");
    expect(answer?.body).toContain("export const x = 1;");

    // `?k=` is ignored by the asset route: it is served before every session check.
    const withK = await handleViewer(
      request(`${BASE}/viewer/assets/bluepencil.element.min.js?k=whatever`),
      context,
    );
    expect(withK?.status).toBe(200);
  });

  it("answers 404 for an unknown bundle without a session, while the shell stays 401", async () => {
    const context = viewerContext();
    const unknown = await handleViewer(request(`${BASE}/viewer/assets/unknown.js`), context);
    expect(unknown?.status).toBe(404);
    expect(unknown?.body).toContain("not_found");

    const shell = await handleViewer(request(`${BASE}/viewer`), context);
    expect(shell?.status).toBe(401);
  });
});

describe("?k= on the viewer surface (R1 F-01 / AC-5.12)", () => {
  it("is the same 401 dead end for a right and a wrong value, on shell, bookmarklet and /view", async () => {
    const context = viewerContext();
    const tokens = [SECRET, "wrong"];
    const paths = [
      `${BASE}/viewer`,
      `${BASE}/viewer/bookmarklet.txt`,
      `${BASE}/view?url=${encodeURIComponent("https://example.com/")}`,
    ];
    for (const path of paths) {
      const bodies = new Set<string>();
      for (const token of tokens) {
        const answer = await handleViewer(request(`${path}?k=${token}`), context);
        expect(answer?.status, path).toBe(401);
        expect(answer?.headers["set-cookie"]).toBeUndefined();
        expect(answer?.body).toContain(`${HUB_ORIGIN}${BASE}/viewer/start`);
        expect(answer?.body).not.toContain(`${BASE}/viewer?k=`);
        bodies.add(String(answer?.body));
      }
      // No secret oracle: both answers are byte-identical.
      expect(bodies.size, path).toBe(1);
    }
  });

  it("falls back to the url-less launcher hint when no public hub origin is set", async () => {
    const base = viewerContext();
    const context: ViewerFixture = { ...base, viewer: { ...base.viewer, hubOrigin: undefined } };
    const answer = await handleViewer(request(`${BASE}/viewer?k=${SECRET}`), context);
    expect(answer?.status).toBe(401);
    expect(answer?.body).toContain("open the hub launcher");
    expect(answer?.body).not.toContain("http://");
    expect(answer?.body).not.toContain(`${BASE}/viewer?k=`);
  });

  it("uses the same message for a missing session on every protected route", async () => {
    const context = viewerContext();
    const paths = [
      `${BASE}/viewer`,
      `${BASE}/viewer/bookmarklet.txt`,
      `${BASE}/view?url=${encodeURIComponent("https://example.com/")}`,
    ];
    for (const path of paths) {
      const answer = await handleViewer(request(path), context);
      expect(answer?.status, path).toBe(401);
      expect(answer?.body, path).toContain(`${HUB_ORIGIN}${BASE}/viewer/start`);
      expect(answer?.body, path).not.toContain(`${BASE}/viewer?k=`);
    }
  });
});

describe("surface and route boundary (AC-5.9/AC-5.15)", () => {
  it("returns null on the hub surface and for URLs the viewer does not own", async () => {
    const hub = viewerContext({ surface: "hub" });
    expect(await handleViewer(request(`${BASE}/viewer`), hub)).toBeNull();
    expect(await handleViewer(request(`${BASE}/view`), hub)).toBeNull();

    const viewer = viewerContext();
    expect(await handleViewer(request(`${BASE}/health`), viewer)).toBeNull();
    expect(await handleViewer(request(`${BASE}/notes`), viewer)).toBeNull();
  });

  it("answers 404 for an unknown asset path when a session is present", async () => {
    const context = viewerContext();
    const token = context.viewer.sessions.mint().token;
    const answer = await handleViewer(
      request(`${BASE}/viewer/assets/nested/unknown.js`, { [VIEWER_HEADER]: token }),
      context,
    );
    expect(answer?.status).toBe(404);
  });
});

describe("shell, bookmarklet and proxy headers (AC-5.3/AC-5.15/§2.2 rule 9)", () => {
  it("serves the shell with no-store, no-referrer and SAMEORIGIN", async () => {
    const context = viewerContext();
    const token = context.viewer.sessions.mint().token;
    const answer = await handleViewer(request(`${BASE}/viewer`, { [VIEWER_HEADER]: token }), context);
    expect(answer?.status).toBe(200);
    expect(answer?.headers["cache-control"]).toBe("no-store");
    expect(answer?.headers["referrer-policy"]).toBe("no-referrer");
    expect(answer?.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("serves the bookmarklet with the placeholder and no live 48-hex token (UT-23)", async () => {
    const context = viewerContext();
    const token = context.viewer.sessions.mint().token;
    const answer = await handleViewer(
      request(`${BASE}/viewer/bookmarklet.txt`, { [VIEWER_HEADER]: token }),
      context,
    );
    expect(answer?.status).toBe(200);
    expect(answer?.headers["content-type"]).toContain("text/plain");
    expect(answer?.body).toContain(BOOKMARKLET_TOKEN_MARKER);
    expect(answer?.body).not.toMatch(/[0-9a-f]{48}/);
  });

  it("strips the target CSP header and <meta> CSP and frames the proxy with SAMEORIGIN", async () => {
    const context = viewerContext({ resolver: stubResolver({ "example.com": [PUBLIC] }).resolver });
    const token = context.viewer.sessions.mint().token;
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.push(url);
      return new Response(
        `<html><head><meta http-equiv="content-security-policy" content="script-src 'self'"></head><body><h1>hi</h1></body></html>`,
        {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": "default-src 'self'",
          },
        },
      );
    }) as unknown as typeof fetch;

    const answer = await handleViewer(
      request(`${BASE}/view?url=${encodeURIComponent("https://example.com/page")}`, { [VIEWER_HEADER]: token }),
      context,
      { fetchImpl, resolver: context.resolver },
    );
    expect(seen).toHaveLength(1);
    expect(answer?.status).toBe(200);
    expect(answer?.headers["content-security-policy"]).toBeUndefined();
    expect(answer?.body.toLowerCase()).not.toContain("content-security-policy");
    expect(answer?.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(answer?.headers["cache-control"]).toBe("no-store");
    expect(answer?.headers["referrer-policy"]).toBe("no-referrer");
    // The endpoint is the viewer's public origin, never the request Host.
    expect(answer?.body).toContain(`endpoint="${VIEWER_ORIGIN}${BASE}"`);
  });

  it("re-checks every redirect hop and never fetches a forbidden hop", async () => {
    const context = viewerContext({
      allow: ["example.com", "169.254.169.254"],
      resolver: stubResolver({ "example.com": [PUBLIC] }).resolver,
    });
    const token = context.viewer.sessions.mint().token;
    const { fetchImpl, seen } = stubFetch("", { redirectTo: "http://169.254.169.254/" });

    const answer = await handleViewer(
      request(`${BASE}/view?url=${encodeURIComponent("https://example.com/")}`, { [VIEWER_HEADER]: token }),
      context,
      { fetchImpl, resolver: context.resolver },
    );
    expect(answer?.status).toBe(403);
    expect(answer?.body).toContain("target_address_forbidden");
    expect(seen).toHaveLength(1); // the first hop only; the redirect target is refused before fetch
  });
});
