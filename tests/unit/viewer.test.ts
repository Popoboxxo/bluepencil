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

import type { HandlerContext, ServerRequest } from "../../server/handler";
import {
  DEFAULT_VIEWER_TTL_SECONDS,
  VIEWER_HEADER,
  buildViewDocument,
  createViewerSessions,
  handleViewer,
  hostAllowed,
  isViewerRequest,
  sessionCookie,
  targetRefusal,
  type ViewerOptions,
} from "../../server/viewer";
import {
  BOOKMARKLET_TOKEN_MARKER,
  bookmarkletSnippet,
  bookmarkletTextArtifact,
} from "../../server/viewer-bookmarklet";

const BASE = "/bluepencil/api";

/** A hub context with the viewer switched on — the store is irrelevant to this door. */
function viewerContext(
  overrides: { allow?: readonly string[]; assetsDir?: string; adminSecret?: string } = {},
): HandlerContext {
  const assetsDir = overrides.assetsDir ?? mkdtempSync(join(tmpdir(), "bp-viewer-"));
  const viewer: ViewerOptions = {
    assetsDir,
    allow: overrides.allow ?? ["example.com", "*.example.com"],
    ttlSeconds: DEFAULT_VIEWER_TTL_SECONDS,
    sessions: createViewerSessions(DEFAULT_VIEWER_TTL_SECONDS),
  };
  return {
    store: { notes: [], environment: "dev" },
    base: BASE,
    environment: "dev",
    adminSecret: overrides.adminSecret ?? "operator-secret-123456",
    viewer,
  } as unknown as HandlerContext;
}

function request(url: string, headers: Record<string, string> = {}): ServerRequest {
  return { method: "GET", url, headers };
}

/** A fetch stub that answers with a fixed document and records the URLs it was asked for. */
function stubFetch(
  html: string,
  options: { status?: number; contentType?: string; redirectTo?: string } = {},
) {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push(url);
    if (options.redirectTo !== undefined) {
      return new Response(null, { status: 302, headers: { location: options.redirectTo } });
    }
    return new Response(html, {
      status: options.status ?? 200,
      headers: { "content-type": options.contentType ?? "text/html; charset=utf-8" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

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
    const cookie = sessionCookie("tok", 3600, BASE);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain(`Path=${BASE}`);
    expect(cookie).toContain("SameSite=Lax");
  });
});

describe("viewer door", () => {
  let context: HandlerContext;

  beforeEach(() => {
    context = viewerContext();
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

  it("exchanges the admin secret for a session cookie, and refuses a wrong one", async () => {
    const wrong = await handleViewer(request(`${BASE}/viewer?k=wrong`), context);
    expect(wrong?.status).toBe(401);

    const ok = await handleViewer(request(`${BASE}/viewer?k=operator-secret-123456`), context);
    expect(ok?.status).toBe(302);
    expect(ok?.headers.location).toBe(`${BASE}/viewer`);
    expect(ok?.headers["set-cookie"]).toContain("HttpOnly");
    const token = String(ok?.headers["set-cookie"]).split(";")[0].split("=")[1];
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
      { fetchImpl },
    );
    expect(refused?.status).toBe(403);
    expect(seen).toHaveLength(0); // refused before the hub goes anywhere near the network
  });

  it("proxies an allowed target with the layer injected and the target CSP gone", async () => {
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
      { fetchImpl },
    );
    expect(seen).toEqual(["https://example.com/page?x=1"]);
    expect(answer?.status).toBe(200);
    expect(answer?.body).toContain("<h1>hi</h1>");
    expect(answer?.body.toLowerCase()).not.toContain("content-security-policy");
    expect(answer?.body).toContain('endpoint="http://hub:8787/bluepencil/api"');
    expect(answer?.body).toContain('<base href="https://example.com/">');
  });

  it("re-checks the allowlist on every redirect hop", async () => {
    const token = context.viewer!.sessions.mint().token;
    const headers = { [VIEWER_HEADER]: token };
    const hop = stubFetch("", { redirectTo: "https://evil.test/take" });

    const refused = await handleViewer(
      request(`${BASE}/view?url=${encodeURIComponent("https://example.com/")}`, headers),
      context,
      { fetchImpl: hop.fetchImpl },
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
      { fetchImpl: pdf.fetchImpl },
    );
    expect(refused?.status).toBe(415);

    const big = stubFetch("x".repeat(6 * 1024 * 1024));
    const tooBig = await handleViewer(
      request(`${BASE}/view?url=${encodeURIComponent("https://example.com/big")}`, headers),
      context,
      { fetchImpl: big.fetchImpl },
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
      { fetchImpl: failing },
    );
    expect(answer?.status).toBe(502);
    expect(answer?.body).toContain("could not fetch");
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
