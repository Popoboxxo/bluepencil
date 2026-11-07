/**
 * @vitest-environment node — the viewer fetches, reads files and mints sessions, none of which jsdom
 * can stand in for.
 *
 * Viewer door tests (issue #140): the measured failure modes become assertions, so the next change
 * cannot reintroduce them silently — the CSP `<meta>` strip, the absolute endpoint under a `<base>`,
 * the allowlist on every redirect hop, and the session that replaces the secret inside a page.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HandlerContext } from "../../server/handler";
import {
  VIEWER_FETCH_TIMEOUT_MS,
  VIEWER_HEADER,
  buildViewDocument,
  createViewerSessions,
  handleViewer,
  handleViewerStart,
  hostAllowed,
  isViewerRequest,
  sessionCookie,
  targetRefusal,
} from "../../server/viewer";
import {
  BOOKMARKLET_TOKEN_MARKER,
  bookmarkletSnippet,
  bookmarkletTextArtifact,
} from "../../server/viewer-bookmarklet";
import {
  BASE,
  VIEWER_ORIGIN,
  request,
  stubFetch,
  stubResolver,
  viewerContext,
  type ViewerFixture,
} from "./helpers/viewer-harness";

/** A public address that is neither loopback nor private: the "allowed" DNS answer. */
const PUBLIC_IP = "93.184.216.34";

describe("viewer allowlist", () => {
  it("matches an exact host and a whole zone, nothing else", () => {
    const allow = ["example.com", "*.internal.test"];
    expect(hostAllowed("example.com", allow)).toBe(true);
    expect(hostAllowed("EXAMPLE.com", allow)).toBe(true);
    expect(hostAllowed("example.com:8080", allow)).toBe(true);
    expect(hostAllowed("a.internal.test", allow)).toBe(true);
    expect(hostAllowed("internal.test", allow)).toBe(false);
    expect(hostAllowed("evil-example.com", allow)).toBe(false);
    expect(hostAllowed("", allow)).toBe(false);
  });

  it("refuses non-http targets, credentials in the URL and hosts that are not listed", () => {
    const allow = ["example.com"];
    expect(targetRefusal("file:///etc/passwd", allow)).toContain("http and https");
    expect(targetRefusal("javascript:alert(1)", allow)).toContain("http and https");
    expect(targetRefusal("https://user:pw@example.com/", allow)).toContain("credentials");
    expect(targetRefusal("https://other.test/", allow)).toContain("--viewer-allow");
    expect(targetRefusal("https://example.com/x", allow)).toBeNull();
  });
});

describe("view document injection", () => {
  const injection = {
    baseHref: "https://example.com/",
    endpoint: "http://hub:8787/bluepencil/api",
    elementSrc: "http://hub:8787/bluepencil/api/viewer/assets/bluepencil.element.min.js",
    environment: "dev",
  };

  it("strips a meta CSP in both attribute orders and keeps the rest", () => {
    const html = `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'"><meta charset="utf-8"></head><body>x</body></html>`;
    const out = buildViewDocument({ html, ...injection });
    expect(out.toLowerCase()).not.toContain("content-security-policy");
    expect(out).toContain('<meta charset="utf-8">');
    expect(out).toContain("<body>x</body>");

    const reversed = `<head><meta content="default-src 'self'" http-equiv="Content-Security-Policy"></head><body>y</body>`;
    expect(buildViewDocument({ html: reversed, ...injection }).toLowerCase()).not.toContain(
      "content-security-policy",
    );
  });

  it("puts <base> and the loader in front of everything, with an absolute endpoint", () => {
    const out = buildViewDocument({ html: "<html><head><title>t</title></head><body>b</body></html>", ...injection });
    // A relative endpoint would resolve against the target because of `<base>` (measured: writes 404).
    expect(out).toContain('endpoint="http://hub:8787/bluepencil/api"');
    expect(out).toContain('src="http://hub:8787/bluepencil/api/viewer/assets/bluepencil.element.min.js"');
    expect(out).toContain('<base href="https://example.com/">');
    expect(out).toContain('type="module"');
    expect(out.indexOf("<base")).toBeLessThan(out.indexOf("<title>"));
  });

  it("still injects when the document has no <head> at all", () => {
    const out = buildViewDocument({ html: "<body>bare</body>", ...injection });
    expect(out.startsWith("<base href=")).toBe(true);
    expect(out).toContain("<body>bare</body>");
  });
});

describe("viewer sessions", () => {
  it("mints a token that verifies, and forgets it when it expires", () => {
    const sessions = createViewerSessions(60);
    const { token, expiresAt } = sessions.mint();
    expect(token).toHaveLength(48);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(sessions.verify(token)).toBe(true);
    expect(sessions.verify("nope")).toBe(false);
    expect(sessions.verify(undefined)).toBe(false);
    expect(sessions.size()).toBe(1);
  });

  it("sets an HttpOnly cookie scoped to the API base", () => {
    // Target signature (Task 4): the cookie carries its base and its `Secure` flag explicitly.
    const cookie = sessionCookie("tok", { ttlSeconds: 3600, base: BASE, secure: false });
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain(`Path=${BASE}`);
    expect(cookie).toContain("SameSite=Lax");
  });
});

describe("viewer door", () => {
  let context: ViewerFixture;

  beforeEach(() => {
    // Hermetic DNS (R3 F1): every `handleViewer()` fetch in this block passes this stub as
    // `deps.resolver`, so no case can fall back to the live resolver and depend on the network.
    // `example.com` is the one host the allowed cases use — including every redirect hop of RT-02,
    // which stays on that host. Refusals (unlisted host, `127.0.0.1`) still happen before DNS.
    const { resolver } = stubResolver({ "example.com": [PUBLIC_IP] });
    context = viewerContext({ resolver });
  });

  it("does not exist without --viewer", async () => {
    const plain = { ...context, viewer: undefined } as HandlerContext;
    expect(isViewerRequest(`${BASE}/viewer`, plain)).toBe(false);
    expect(await handleViewer(request(`${BASE}/viewer`), plain)).toBeNull();
  });

  it("answers 401 without a session and 404-adjacent JSON for an unknown route", async () => {
    const unauthorized = await handleViewer(request(`${BASE}/viewer`), context);
    expect(unauthorized?.status).toBe(401);
    expect(unauthorized?.body).toContain("session");
  });

  it("[RT-01] refuses the legacy ?k= exchange on the viewer surface and mints through the hub launcher", async () => {
    // R1 F-01: the viewer surface never compares the admin secret. Both a right and a wrong value
    // are the same dead end, and the message points at the hub launcher, never at {base}/viewer?k=.
    for (const value of ["operator-secret-123456", "wrong"]) {
      const legacy = await handleViewer(request(`${BASE}/viewer?k=${value}`), context);
      expect(legacy?.status).toBe(401);
      expect(legacy?.headers["set-cookie"]).toBeUndefined();
      expect(legacy?.body).toContain(`${BASE}/viewer/start`);
      expect(legacy?.body).not.toContain("/viewer?k=");
    }

    // The exchange lives on the hub surface only, and shares the fixture's ticket store.
    const hub = viewerContext({ surface: "hub", tickets: context.viewer!.tickets });
    const started = handleViewerStart(
      request(`${BASE}/viewer/start`, { "x-bluepencil-admin": "operator-secret-123456" }),
      hub,
    );
    expect(started?.status).toBe(302);
    expect(started?.headers["set-cookie"]).toBeUndefined();
    expect(started?.headers["referrer-policy"]).toBe("no-referrer");
    expect(started?.headers["cache-control"]).toBe("no-store");
    const location = new URL(String(started?.headers.location));
    expect(location.origin).toBe(VIEWER_ORIGIN);
    expect(location.pathname).toBe(`${BASE}/viewer`);
    const ticket = location.searchParams.get("ticket");
    expect(ticket).toMatch(/^[0-9a-f]{48}$/);

    const redeemed = await handleViewer(request(`${BASE}/viewer?ticket=${ticket}`), context);
    expect(redeemed?.status).toBe(302);
    expect(redeemed?.headers.location).toBe(`${BASE}/viewer`);
    expect(redeemed?.headers["referrer-policy"]).toBe("no-referrer");
    const cookie = String(redeemed?.headers["set-cookie"]);
    expect(cookie).toContain("HttpOnly");
    // Index-free extraction: `split("…")[1]` is `string | undefined` under noUncheckedIndexedAccess.
    const token = cookie.slice(cookie.indexOf("=") + 1, cookie.indexOf(";"));
    expect(context.viewer!.sessions.verify(token)).toBe(true);

    // The cookie alone is enough for the page; no secret in the URL any more.
    const page = await handleViewer(request(`${BASE}/viewer`, { cookie: `bp_viewer=${token}` }), context);
    expect(page?.status).toBe(200);
    expect(page?.headers["content-type"]).toContain("text/html");
    expect(page?.body).toContain("bluepencil viewer");
    expect(page?.body).toContain("example.com");
    expect(page?.body).toContain("/viewer/bookmarklet.txt");
  });

  it("serves the bookmarklet as its own versioned artifact", async () => {
    const token = context.viewer!.sessions.mint().token;
    const artifact = await handleViewer(request(`${BASE}/viewer/bookmarklet.txt`, { [VIEWER_HEADER]: token }), context);
    expect(artifact?.status).toBe(200);
    expect(artifact?.headers["content-type"]).toContain("text/plain");
    expect(artifact?.body).toContain("bluepencil bookmarklet");
    expect(artifact?.body).toContain(BOOKMARKLET_TOKEN_MARKER);
    expect(artifact?.body).toContain("javascript:(()=>{");
    // The drift guard: the paths this artifact hard-codes must be the routes the hub serves.
    expect(artifact?.body).toContain("/viewer/assets/bluepencil.element.min.js");
    expect(artifact?.body).toContain(`${VIEWER_HEADER}`);
  });

  it("serves only the known layer bundles from --viewer-assets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bp-assets-"));
    writeFileSync(join(dir, "bluepencil.element.min.js"), "export const x = 1;");
    const ctx = viewerContext({ assetsDir: dir });
    const token = ctx.viewer!.sessions.mint().token;

    const ok = await handleViewer(
      request(`${BASE}/viewer/assets/bluepencil.element.min.js`, { [VIEWER_HEADER]: token }),
      ctx,
    );
    expect(ok?.status).toBe(200);
    expect(ok?.headers["access-control-allow-origin"]).toBe("*");

    for (const hostile of ["../../server/hub.ts", "secret.txt", "bluepencil.iife.js"]) {
      const refused = await handleViewer(request(`${BASE}/viewer/assets/${hostile}`, { [VIEWER_HEADER]: token }), ctx);
      expect(refused?.status).toBe(404);
    }
  });

  it("refuses a target that is not on the allowlist and one without a url", async () => {
    const token = context.viewer!.sessions.mint().token;
    const headers = { [VIEWER_HEADER]: token };

    const missing = await handleViewer(request(`${BASE}/view?url=`, headers), context);
    expect(missing?.status).toBe(400);

    const { fetchImpl, seen } = stubFetch("<html></html>");
    const refused = await handleViewer(
      request(`${BASE}/view?url=${encodeURIComponent("http://127.0.0.1:9/x")}`, headers),
      context,
      { fetchImpl, resolver: context.resolver },
    );
    expect(refused?.status).toBe(403);
    expect(seen).toHaveLength(0); // refused before the hub goes anywhere near the network
  });

  it("[RT-01] proxies an allowed target with the layer injected and the target CSP gone", async () => {
    const token = context.viewer!.sessions.mint().token;
    const { fetchImpl, seen } = stubFetch(
      `<html><head><meta http-equiv="content-security-policy" content="script-src 'self'"></head><body><h1>hi</h1></body></html>`,
    );
    const answer = await handleViewer(
      request(`${BASE}/view?url=${encodeURIComponent("https://example.com/page?x=1")}`, {
        [VIEWER_HEADER]: token,
        host: "hub:8787",
      }),
      context,
      { fetchImpl, resolver: context.resolver },
    );
    expect(seen).toEqual(["https://example.com/page?x=1"]);
    expect(answer?.status).toBe(200);
    expect(answer?.body).toContain("<h1>hi</h1>");
    expect(answer?.body.toLowerCase()).not.toContain("content-security-policy");
    // The endpoint is the *viewer's* origin (AC-5.16), not the `Host` the request arrived on:
    // a distinct origin is the whole point of the second listener.
    expect(answer?.body).toContain(`endpoint="${VIEWER_ORIGIN}${BASE}"`);
    expect(answer?.body).toContain('<base href="https://example.com/">');
  });

  it("re-checks the allowlist on every redirect hop", async () => {
    const token = context.viewer!.sessions.mint().token;
    const headers = { [VIEWER_HEADER]: token };
    const hop = stubFetch("", { redirectTo: "https://evil.test/take" });

    const refused = await handleViewer(
      request(`${BASE}/view?url=${encodeURIComponent("https://example.com/")}`, headers),
      context,
      { fetchImpl: hop.fetchImpl, resolver: context.resolver },
    );
    expect(refused?.status).toBe(403);
    expect(refused?.body).toContain("evil.test");
  });

  it("refuses a non-HTML target and an oversized one", async () => {
    const token = context.viewer!.sessions.mint().token;
    const headers = { [VIEWER_HEADER]: token };

    const pdf = stubFetch("%PDF-1.7", { contentType: "application/pdf" });
    const refused = await handleViewer(
      request(`${BASE}/view?url=${encodeURIComponent("https://example.com/a.pdf")}`, headers),
      context,
      { fetchImpl: pdf.fetchImpl, resolver: context.resolver },
    );
    expect(refused?.status).toBe(415);

    const big = stubFetch("x".repeat(6 * 1024 * 1024));
    const tooBig = await handleViewer(
      request(`${BASE}/view?url=${encodeURIComponent("https://example.com/big")}`, headers),
      context,
      { fetchImpl: big.fetchImpl, resolver: context.resolver },
    );
    expect(tooBig?.status).toBe(413);
  });

  it("reports an unreachable target as 502 instead of throwing", async () => {
    const token = context.viewer!.sessions.mint().token;
    const failing = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    const answer = await handleViewer(
      request(`${BASE}/view?url=${encodeURIComponent("https://example.com/")}`, { [VIEWER_HEADER]: token }),
      context,
      { fetchImpl: failing, resolver: context.resolver },
    );
    expect(answer?.status).toBe(502);
    expect(answer?.body).toContain("could not fetch");
  });

  it("bounds every target fetch at eight seconds", async () => {
    // The timeout is a fetch bound, not a body limit: an aborted fetch is the same
    // `target_unreachable` path as a DNS failure (RT-02).
    expect(VIEWER_FETCH_TIMEOUT_MS).toBe(8000);
    const token = context.viewer!.sessions.mint().token;
    const aborted = (async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as unknown as typeof fetch;
    const answer = await handleViewer(
      request(`${BASE}/view?url=${encodeURIComponent("https://example.com/slow")}`, { [VIEWER_HEADER]: token }),
      context,
      { fetchImpl: aborted, resolver: context.resolver },
    );
    expect(answer?.status).toBe(502);
    expect(answer?.body).toContain("target_unreachable");
  });

  it("follows three redirects and refuses the fourth (RT-02)", async () => {
    const token = context.viewer!.sessions.mint().token;
    // Every answer is another redirect: the initial fetch plus three followed hops is the budget.
    const looping = stubFetch("", { redirectTo: "https://example.com/again" });
    const answer = await handleViewer(
      request(`${BASE}/view?url=${encodeURIComponent("https://example.com/")}`, { [VIEWER_HEADER]: token }),
      context,
      { fetchImpl: looping.fetchImpl, resolver: context.resolver },
    );
    expect(answer?.status).toBe(502);
    expect(answer?.body).toContain("too_many_redirects");
    expect(looping.seen).toHaveLength(4);
  });
});

describe("bookmarklet artifact", () => {
  it("is a javascript: URL that mounts the element with an absolute endpoint", () => {
    const snippet = bookmarkletSnippet({ origin: "http://hub:8787", base: BASE, environment: "dev" });
    expect(snippet.startsWith("javascript:(()=>{")).toBe(true);
    expect(snippet).toContain("'http://hub:8787'");
    expect(snippet).toContain("setAttribute('endpoint',H+B)");
    expect(snippet).toContain("bluepencil-notes");
    expect(snippet).toContain("type='module'");
    expect(snippet).toContain(BOOKMARKLET_TOKEN_MARKER);
  });

  it("carries the live token when the page renders it", () => {
    const snippet = bookmarkletSnippet({
      origin: "http://hub:8787",
      base: BASE,
      environment: "dev",
      token: "abc123",
    });
    expect(snippet).toContain("'abc123'");
    expect(snippet).not.toContain(BOOKMARKLET_TOKEN_MARKER);
  });

  it("names its own version and limits in the text artifact", () => {
    const text = bookmarkletTextArtifact({ origin: "http://hub:8787", base: BASE, environment: "dev" });
    expect(text).toMatch(/bluepencil bookmarklet \S+/);
    expect(text).toContain("Content-Security-Policy");
    expect(text).toContain("connect-src");
    expect(text).toContain("/viewer/assets/bluepencil.element.min.js");
  });
});
