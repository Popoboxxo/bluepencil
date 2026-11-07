/**
 * @vitest-environment node — binds a real viewer socket and stubs the network boundary; jsdom can
 * stand in for neither.
 *
 * Task 13 of the viewer-origin plan (W3-A): proxy, injection and SSRF **integration**.
 *
 * What this file proves, and where the seam sits:
 *   - IT-15 goes through a real `startHub()` listener pair (launcher → ticket → cookie → `/view`)
 *     with an **explicit** viewer origin, so the absolute `endpoint`/`src` can only come from the
 *     resolved viewer origin, never from the request `Host`. The target fetch is stub-patched on
 *     `globalThis.fetch`, so no packet leaves the machine.
 *   - IT-29/30/31/32 and RT-01/RT-02 cross `handleViewer()` + `proxyTarget()` + `checkTarget()` +
 *     `buildViewDocument()` with the harness' injected `resolver`/`fetchImpl`. A real target
 *     hostname cannot be used through the socket: `startHub()` has no seam for a stub resolver,
 *     which is why the DNS-dependent paths stay at the handler boundary (plan gap, reported).
 *   - IT-16/17/18/34/42 use the stub resolver as the only source of addresses: loopback, metadata,
 *     link-local and private targets must all end as a named `403`, never a `500`, and a refusal
 *     before the first fetch must leave the fetch counter at zero.
 *
 * No test in this file reaches a real external network: every hostname is answered by
 * `stubResolver()` and every target request by `stubFetch()` (or the patched global `fetch`).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as nodeRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HostResolver } from "../../src/federation/net-policy";
import type { ServerResponse } from "../../server/handler";
import { startHub, type RunningServer } from "../../server/hub";
import {
  VIEWER_FETCH_TIMEOUT_MS,
  VIEWER_HEADER,
  handleViewer,
} from "../../server/viewer";
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
const PUBLIC = "93.184.216.34";

/** A second public address for the explicit-origin socket test (AC-5.16 uses example.com). */
const PUBLIC_IP_TARGET = "93.184.216.34";

const OPERATOR_SECRET = "viewer-proxy-operator-secret";

/* ------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

/** The token of a fresh session in this fixture's store. */
function tokenOf(context: ViewerFixture): string {
  return context.viewer.sessions.mint().token;
}

/** The named code of a refusal body, or `undefined` for a non-JSON answer. */
function codeOf(response: ServerResponse | null): string | undefined {
  if (response === null) return undefined;
  try {
    const parsed = JSON.parse(response.body) as { error?: { code?: string } };
    return parsed.error?.code;
  } catch {
    return undefined;
  }
}

/** One `/view` call with a valid session and the injected network boundary. */
function proxy(
  context: ViewerFixture,
  target: string,
  deps: { resolver?: HostResolver; fetchImpl?: typeof fetch } = {},
): Promise<ServerResponse | null> {
  const headers = { [VIEWER_HEADER]: tokenOf(context) };
  return handleViewer(request(`${BASE}/view?url=${encodeURIComponent(target)}`, headers), context, deps);
}

/** A fetch stub that can answer with response headers of its own (the CSP header of IT-29). */
function fetchWithHeaders(
  html: string,
  headers: Record<string, string>,
): { fetchImpl: typeof fetch; seen: string[] } {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push(url);
    return new Response(html, { status: 200, headers });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

/* ------------------------------------------------------------------------------------------------
 * IT-15 — real listener pair: injection uses the resolved viewer origin (AC-5.16)
 * ---------------------------------------------------------------------------------------------- */

interface HttpAnswer {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

const servers: RunningServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A minimal Node HTTP client; deliberately not `fetch`, which IT-15 patches. */
function httpGet(url: string, headers: Record<string, string> = {}): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = nodeRequest(
      {
        host: target.hostname,
        port: Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("IT-15 — proxy injection uses the viewer origin, not the request Host (AC-5.16)", () => {
  it("serves shell and proxied target with absolute endpoint and element src", async () => {
    const assetsDir = tempDir("bp-proxy-assets-");
    writeFileSync(join(assetsDir, "bluepencil.element.min.js"), "// stub\n");

    const server = await startHub({
      quiet: true,
      storePath: join(tempDir("bp-proxy-store-"), "notes.bluepencil.json"),
      port: 0,
      // The harness' base: the assertions below compare the injected endpoint against it.
      base: BASE,
      adminSecret: OPERATOR_SECRET,
      viewer: {
        host: "127.0.0.1",
        port: 0,
        assetsDir,
        allow: [PUBLIC_IP_TARGET],
        ttlSeconds: 3600,
        // Distinct from the loopback bind: if the proxy ever used the `Host` header,
        // `http://127.0.0.1:<port>` would show up in `endpoint` instead of this origin.
        origin: "https://view.example.com",
      },
    });
    servers.push(server);
    const viewer = server.viewer;
    if (viewer === undefined) throw new Error("startHub() did not expose the viewer listener");
    const viewerBase = `http://127.0.0.1:${viewer.port}`;

    // Launcher on the hub origin → one-time ticket.
    const started = await httpGet(`http://127.0.0.1:${server.port}${BASE}/viewer/start`, {
      "x-bluepencil-admin": OPERATOR_SECRET,
    });
    expect(started.status).toBe(302);
    const ticket = new URL(String(started.headers.location)).searchParams.get("ticket");
    expect(ticket).toMatch(/^[0-9a-f]{48}$/);

    // Ticket → session cookie on the viewer origin.
    const redeemed = await httpGet(`${viewerBase}${BASE}/viewer?ticket=${ticket}`);
    expect(redeemed.status).toBe(302);
    const setCookie = String(redeemed.headers["set-cookie"] ?? "");
    expect(setCookie).toContain("HttpOnly");
    const cookie = setCookie.slice(0, setCookie.indexOf(";"));

    // The shell and the proxied document both answer 200 ("beide 200").
    const shell = await httpGet(`${viewerBase}${BASE}/viewer`, { cookie });
    expect(shell.status).toBe(200);

    const target = `https://${PUBLIC_IP_TARGET}/page`;
    const targetFetch = stubFetch(
      "<!doctype html><html><head><title>Target</title></head><body><h1>hi</h1></body></html>",
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = targetFetch.fetchImpl;
    let answer: HttpAnswer;
    try {
      answer = await httpGet(`${viewerBase}${BASE}/view?url=${encodeURIComponent(target)}`, { cookie });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(targetFetch.seen).toEqual([target]);
    expect(answer.status).toBe(200);
    expect(String(answer.headers["content-type"])).toContain("text/html");
    expect(answer.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(answer.headers["referrer-policy"]).toBe("no-referrer");
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(answer.headers["content-security-policy"]).toBeUndefined();
    expect(answer.text).toContain(`endpoint="https://view.example.com${BASE}"`);
    expect(answer.text).toContain(
      `src="https://view.example.com${BASE}/viewer/assets/bluepencil.element.min.js"`,
    );
    expect(answer.text).toContain(`<base href="https://${PUBLIC_IP_TARGET}/">`);
    // The bind origin must not leak into the injected attributes.
    expect(answer.text).not.toContain(`endpoint="http://127.0.0.1`);
  });
});

/* ------------------------------------------------------------------------------------------------
 * IT-16 — loopback/metadata resolutions are refused before the first fetch (AC-5.17)
 * ---------------------------------------------------------------------------------------------- */

describe("IT-16 — loopback and metadata resolutions cost zero fetches (AC-5.17)", () => {
  it("refuses loopback, link-local metadata and the IPv4-mapped form before fetching", async () => {
    for (const address of ["127.0.0.1", "169.254.169.254", "::ffff:169.254.169.254"]) {
      const context = viewerContext({ allow: ["example.com"] });
      // The allowlist host itself stays allowed; the refusal comes from the IP classification.
      const resolver = stubResolver({ "example.com": [address] });
      const targetFetch = stubFetch("<html><body>should not be fetched</body></html>");

      const answer = await proxy(context, "https://example.com/", {
        resolver: resolver.resolver,
        fetchImpl: targetFetch.fetchImpl,
      });

      expect(answer?.status, address).toBe(403);
      expect(codeOf(answer), address).toBe("target_address_forbidden");
      expect(targetFetch.seen, address).toEqual([]);
      expect(resolver.calls, address).toEqual(["example.com"]);
    }
  });

  it("refuses an allowlisted metadata IP literal without any DNS or fetch", async () => {
    const context = viewerContext({ allow: ["169.254.169.254"] });
    const resolver = stubResolver();
    const targetFetch = stubFetch("<html><body>should not be fetched</body></html>");

    const answer = await proxy(context, "http://169.254.169.254/", {
      resolver: resolver.resolver,
      fetchImpl: targetFetch.fetchImpl,
    });

    expect(answer?.status).toBe(403);
    expect(codeOf(answer)).toBe("target_address_forbidden");
    expect(answer?.body).toContain("169.254.169.254");
    expect(targetFetch.seen).toEqual([]);
    expect(resolver.calls).toEqual([]); // an IP literal is classified directly
  });
});

/* ------------------------------------------------------------------------------------------------
 * IT-17 — a redirect hop to metadata is refused with exactly one fetch (AC-5.18)
 * ---------------------------------------------------------------------------------------------- */

describe("IT-17 — the redirect hop is checked, exactly one fetch happens (AC-5.18)", () => {
  it("refuses a 302 pointing at metadata after re-checking the hop", async () => {
    const context = viewerContext({ allow: ["example.com", "169.254.169.254"] });
    const resolver = stubResolver({ "example.com": [PUBLIC] });
    const redirecting = stubFetch("", { redirectTo: "http://169.254.169.254/" });

    const answer = await proxy(context, "https://example.com/", {
      resolver: resolver.resolver,
      fetchImpl: redirecting.fetchImpl,
    });

    expect(answer?.status).toBe(403);
    expect(codeOf(answer)).toBe("target_address_forbidden");
    expect(redirecting.seen).toEqual(["https://example.com/"]);
    expect(redirecting.seen).toHaveLength(1); // no second hop was attempted
  });
});

/* ------------------------------------------------------------------------------------------------
 * IT-18 — private targets need an exact entry; wildcards never authorize them (AC-5.19)
 * ---------------------------------------------------------------------------------------------- */

describe("IT-18 — private address policy at the proxy (AC-5.19)", () => {
  it("fetches an exactly allowlisted private IP and an exact hostname resolving privately", async () => {
    const literal = viewerContext({ allow: ["10.0.0.1"] });
    const literalFetch = stubFetch("<html><head><title>p</title></head><body>private</body></html>");
    const literalAnswer = await proxy(literal, "http://10.0.0.1/", {
      resolver: stubResolver().resolver,
      fetchImpl: literalFetch.fetchImpl,
    });
    expect(literalAnswer?.status).toBe(200);
    expect(literalFetch.seen).toEqual(["http://10.0.0.1/"]);

    const named = viewerContext({ allow: ["internal.example.com"] });
    const namedResolver = stubResolver({ "internal.example.com": ["10.0.0.5"] });
    const namedFetch = stubFetch("<html><head><title>n</title></head><body>internal</body></html>");
    const namedAnswer = await proxy(named, "https://internal.example.com/", {
      resolver: namedResolver.resolver,
      fetchImpl: namedFetch.fetchImpl,
    });
    expect(namedAnswer?.status).toBe(200);
    expect(namedFetch.seen).toEqual(["https://internal.example.com/"]);
    expect(namedResolver.calls).toEqual(["internal.example.com"]);
  });

  it("never lets a wildcard authorize a private resolution", async () => {
    const context = viewerContext({ allow: ["*.example.com"] });
    const resolver = stubResolver({ "foo.example.com": ["10.0.0.5"] });
    const targetFetch = stubFetch("<html><body>should not be fetched</body></html>");

    const answer = await proxy(context, "https://foo.example.com/", {
      resolver: resolver.resolver,
      fetchImpl: targetFetch.fetchImpl,
    });

    expect(answer?.status).toBe(403);
    expect(codeOf(answer)).toBe("target_address_forbidden");
    expect(answer?.body).toContain("10.0.0.5");
    expect(targetFetch.seen).toEqual([]);
  });

  it("keeps loopback forbidden even with an exact entry", async () => {
    for (const [target, entry] of [
      ["http://127.0.0.1/", "127.0.0.1"],
      ["http://[::1]/", "::1"],
    ] as const) {
      const context = viewerContext({ allow: [entry] });
      const targetFetch = stubFetch("<html><body>should not be fetched</body></html>");
      const answer = await proxy(context, target, {
        resolver: stubResolver().resolver,
        fetchImpl: targetFetch.fetchImpl,
      });
      expect(answer?.status, target).toBe(403);
      expect(codeOf(answer), target).toBe("target_address_forbidden");
      expect(targetFetch.seen, target).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------------------------------------
 * IT-29 — the target's header CSP and <meta> CSP are both gone (AC-5.25)
 * ---------------------------------------------------------------------------------------------- */

describe("IT-29 — header CSP and <meta> CSP are stripped (AC-5.25)", () => {
  it("serves HTML without a CSP header, without a CSP meta, with the layer present", async () => {
    const context = viewerContext({ allow: ["example.com"] });
    const resolver = stubResolver({ "example.com": [PUBLIC] });
    const html =
      `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'">` +
      `<title>locked</title></head><body><p>locked</p></body></html>`;
    const targetFetch = fetchWithHeaders(html, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; script-src 'none'",
    });

    const answer = await proxy(context, "https://example.com/", {
      resolver: resolver.resolver,
      fetchImpl: targetFetch.fetchImpl,
    });

    expect(answer?.status).toBe(200);
    expect(answer?.headers["content-security-policy"]).toBeUndefined();
    expect(answer?.body.toLowerCase()).not.toContain(`<meta http-equiv="content-security-policy"`);
    expect(answer?.body.toLowerCase()).not.toContain("content-security-policy");
    expect(answer?.body).toContain("<bluepencil-notes");
    expect(answer?.body).toContain("bluepencil.element.min.js");
    expect(answer?.body).toContain("<p>locked</p>");
  });
});

/* ------------------------------------------------------------------------------------------------
 * IT-30/31/32 — the four document shapes (AC-5.26, AC-5.27, AC-5.28)
 * ---------------------------------------------------------------------------------------------- */

const ABSOLUTE_ENDPOINT = `endpoint="${VIEWER_ORIGIN}${BASE}"`;
const ABSOLUTE_SRC = `src="${VIEWER_ORIGIN}${BASE}/viewer/assets/bluepencil.element.min.js"`;

describe("IT-30 — static page: injection after <head>, absolute URLs (AC-5.26)", () => {
  it("inserts the layer directly after the opening <head>", async () => {
    const context = viewerContext({ allow: ["example.com"] });
    const html =
      "<!doctype html><html><head><title>Static</title></head><body><p>hello</p></body></html>";
    const answer = await proxy(context, "https://example.com/static.html", {
      resolver: stubResolver({ "example.com": [PUBLIC] }).resolver,
      fetchImpl: stubFetch(html).fetchImpl,
    });

    expect(answer?.status).toBe(200);
    const body = answer?.body ?? "";
    expect(body).toContain('<base href="https://example.com/">');
    expect(body).toContain(ABSOLUTE_ENDPOINT);
    expect(body).toContain(ABSOLUTE_SRC);
    expect(body.indexOf("<base href=")).toBeGreaterThan(body.indexOf("<head>"));
    expect(body.indexOf("<base href=")).toBeLessThan(body.indexOf("<title>"));
    expect(body).toContain("<p>hello</p>");
  });
});

describe("IT-31 — SPA shell without <head>: injection is prepended (AC-5.27)", () => {
  it("puts the injection before the original markup and keeps it intact", async () => {
    const context = viewerContext({ allow: ["example.com"] });
    const html = '<div id="root"></div>';
    const answer = await proxy(context, "https://example.com/spa", {
      resolver: stubResolver({ "example.com": [PUBLIC] }).resolver,
      fetchImpl: stubFetch(html).fetchImpl,
    });

    expect(answer?.status).toBe(200);
    const body = answer?.body ?? "";
    expect(body.startsWith("<base href=")).toBe(true);
    expect(body.indexOf("<base href=")).toBeLessThan(body.indexOf('<div id="root">'));
    expect(body).toContain(html);
    expect(body).toContain(ABSOLUTE_ENDPOINT);
    expect(body).toContain(ABSOLUTE_SRC);
  });
});

describe("IT-32 — missing </head> and missing <head> do not crash (AC-5.28)", () => {
  it("injects after <head> when </head> is missing", async () => {
    const context = viewerContext({ allow: ["example.com"] });
    const html = "<head><title>x</title><body><p>y";
    const answer = await proxy(context, "https://example.com/no-close", {
      resolver: stubResolver({ "example.com": [PUBLIC] }).resolver,
      fetchImpl: stubFetch(html).fetchImpl,
    });

    expect(answer?.status).toBe(200);
    const body = answer?.body ?? "";
    expect(body.indexOf("<base href=")).toBeGreaterThan(body.indexOf("<head>"));
    expect(body.indexOf("<base href=")).toBeLessThan(body.indexOf("<title>"));
    expect(body).toContain("<body><p>y");
    expect(body).toContain(ABSOLUTE_ENDPOINT);
    expect(body).toContain(ABSOLUTE_SRC);
  });

  it("prepends the injection when <head> is missing entirely", async () => {
    const context = viewerContext({ allow: ["example.com"] });
    const html = "<html><body><p>y</p></body></html>";
    const answer = await proxy(context, "https://example.com/no-head", {
      resolver: stubResolver({ "example.com": [PUBLIC] }).resolver,
      fetchImpl: stubFetch(html).fetchImpl,
    });

    expect(answer?.status).toBe(200);
    const body = answer?.body ?? "";
    expect(body.startsWith("<base href=")).toBe(true);
    expect(body).toContain("<html><body><p>y</p></body></html>");
    expect(body).toContain(ABSOLUTE_ENDPOINT);
    expect(body).toContain(ABSOLUTE_SRC);
  });
});

/* ------------------------------------------------------------------------------------------------
 * IT-34 — metadata hostnames before DNS; resolver failures are unresolvable, never 500 (AC-5.30/5.31)
 * ---------------------------------------------------------------------------------------------- */

describe("IT-34 — metadata and resolver failures (AC-5.30, AC-5.31)", () => {
  it("refuses a metadata hostname before the allowlist and before DNS", async () => {
    const context = viewerContext({ allow: ["metadata.google.internal"] });
    const resolver = stubResolver({ "metadata.google.internal": [PUBLIC] });
    const targetFetch = stubFetch("<html><body>should not be fetched</body></html>");

    const answer = await proxy(context, "http://metadata.google.internal/", {
      resolver: resolver.resolver,
      fetchImpl: targetFetch.fetchImpl,
    });

    expect(answer?.status).toBe(403);
    expect(codeOf(answer)).toBe("target_metadata_host");
    expect(resolver.calls).toEqual([]);
    expect(targetFetch.seen).toEqual([]);
  });

  it("maps a throwing, empty and non-IP resolver answer to unresolvable_host", async () => {
    const answers: readonly (readonly string[] | Error)[] = [
      new Error("ENOTFOUND"),
      [],
      ["not-an-ip"],
    ];
    for (const value of answers) {
      const context = viewerContext({ allow: ["example.com"] });
      const resolver = stubResolver({ "example.com": value });
      const targetFetch = stubFetch("<html><body>should not be fetched</body></html>");

      const answer = await proxy(context, "https://example.com/", {
        resolver: resolver.resolver,
        fetchImpl: targetFetch.fetchImpl,
      });

      expect(answer?.status).toBe(403);
      expect(codeOf(answer)).toBe("unresolvable_host");
      expect(answer?.status).not.toBe(500);
      expect(targetFetch.seen).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------------------------------------
 * IT-42 — forbidden origins (AC-5.20)
 * ---------------------------------------------------------------------------------------------- */

describe("IT-42 — a non-loopback forbidden origin is refused without a fetch (AC-5.20)", () => {
  it("answers target_forbidden_origin for the viewer's own public origin", async () => {
    const context = viewerContext({
      origin: "https://view.example.com",
      allow: ["view.example.com"],
    });
    const resolver = stubResolver({ "view.example.com": [PUBLIC] });
    const targetFetch = stubFetch("<html><body>should not be fetched</body></html>");

    const answer = await proxy(context, "https://view.example.com/x", {
      resolver: resolver.resolver,
      fetchImpl: targetFetch.fetchImpl,
    });

    expect(answer?.status).toBe(403);
    expect(codeOf(answer)).toBe("target_forbidden_origin");
    expect(targetFetch.seen).toEqual([]);
  });
});

/* ------------------------------------------------------------------------------------------------
 * RT-01 — the 0.13.0 viewer contract stays intact (regression)
 * Wire re-observation; canonical in viewer.test.ts.
 * ---------------------------------------------------------------------------------------------- */

describe("RT-01 — allowlist, injection, <base>, absolute endpoint, meta-CSP strip, session cookie", () => {
  it("answers 401 without a session and refuses an unlisted host before fetching", async () => {
    const context = viewerContext({ allow: ["example.com"] });
    const unauthorizedFetch = stubFetch("<html></html>");
    const unauthorized = await handleViewer(
      request(`${BASE}/view?url=${encodeURIComponent("https://example.com/")}`),
      context,
      { resolver: stubResolver().resolver, fetchImpl: unauthorizedFetch.fetchImpl },
    );
    expect(unauthorized?.status).toBe(401);
    expect(unauthorized?.body).toContain("session");
    expect(unauthorizedFetch.seen).toEqual([]);

    const resolver = stubResolver({ "example.com": [PUBLIC] });
    const targetFetch = stubFetch("<html></html>");
    const refused = await proxy(context, "https://other.test/", {
      resolver: resolver.resolver,
      fetchImpl: targetFetch.fetchImpl,
    });
    expect(refused?.status).toBe(403);
    expect(codeOf(refused)).toBe("target_not_allowed");
    expect(targetFetch.seen).toEqual([]);
    expect(resolver.calls).toEqual([]);
  });

  it("injects the layer with a <base>, absolute endpoint/src and no target CSP", async () => {
    const context = viewerContext({ allow: ["example.com"] });
    const resolver = stubResolver({ "example.com": [PUBLIC] });
    const html =
      `<html><head><meta http-equiv="content-security-policy" content="script-src 'self'">` +
      `<title>t</title></head><body><h1>hi</h1></body></html>`;
    const targetFetch = stubFetch(html);

    const answer = await proxy(context, "https://example.com/page?x=1", {
      resolver: resolver.resolver,
      fetchImpl: targetFetch.fetchImpl,
    });

    expect(targetFetch.seen).toEqual(["https://example.com/page?x=1"]);
    expect(answer?.status).toBe(200);
    expect(answer?.body).toContain("<h1>hi</h1>");
    expect(answer?.body.toLowerCase()).not.toContain("content-security-policy");
    expect(answer?.body).toContain(`endpoint="${VIEWER_ORIGIN}${BASE}"`);
    expect(answer?.body).toContain(
      `src="${VIEWER_ORIGIN}${BASE}/viewer/assets/bluepencil.element.min.js"`,
    );
    expect(answer?.body).toContain('<base href="https://example.com/">');
    expect(answer?.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(answer?.headers["referrer-policy"]).toBe("no-referrer");
    expect(answer?.headers["cache-control"]).toBe("no-store");
  });

  it("issues the HttpOnly session cookie at the ticket boundary", async () => {
    const context = viewerContext({ allow: ["example.com"] });
    const ticket = context.viewer.tickets.mint().ticket;

    const redeemed = await handleViewer(request(`${BASE}/viewer?ticket=${ticket}`), context);
    expect(redeemed?.status).toBe(302);
    const cookie = String(redeemed?.headers["set-cookie"]);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain(`Path=${BASE}`);
    expect(cookie).toContain("Max-Age=28800");
    expect(cookie).not.toContain("Secure"); // the fixture origin is plain http

    const token = cookie.slice(cookie.indexOf("=") + 1, cookie.indexOf(";"));
    expect(context.viewer.sessions.verify(token)).toBe(true);
    const shell = await handleViewer(request(`${BASE}/viewer`, { cookie: `bp_viewer=${token}` }), context);
    expect(shell?.status).toBe(200);
    expect(shell?.body).toContain("bluepencil viewer");
  });
});

/* ------------------------------------------------------------------------------------------------
 * RT-02 — the proxy's existing error paths stay intact (regression)
 * Wire re-observation; canonical in viewer.test.ts.
 * ---------------------------------------------------------------------------------------------- */

describe("RT-02 — 5-MB bound, 8-s timeout, 3 redirects, content type, target_unreachable", () => {
  it("bounds every target fetch at eight seconds", async () => {
    expect(VIEWER_FETCH_TIMEOUT_MS).toBe(8000);
    const context = viewerContext({ allow: ["example.com"] });
    const aborted = (async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as unknown as typeof fetch;

    const answer = await proxy(context, "https://example.com/slow", {
      resolver: stubResolver({ "example.com": [PUBLIC] }).resolver,
      fetchImpl: aborted,
    });

    expect(answer?.status).toBe(502);
    expect(codeOf(answer)).toBe("target_unreachable");
  });

  it("refuses a target larger than five megabytes instead of truncating it", async () => {
    const context = viewerContext({ allow: ["example.com"] });
    const tooBig = stubFetch("x".repeat(5 * 1024 * 1024 + 1));

    const answer = await proxy(context, "https://example.com/big", {
      resolver: stubResolver({ "example.com": [PUBLIC] }).resolver,
      fetchImpl: tooBig.fetchImpl,
    });

    expect(answer?.status).toBe(413);
    expect(codeOf(answer)).toBe("target_too_large");
  });

  it("follows three redirects and refuses the fourth", async () => {
    const context = viewerContext({ allow: ["example.com"] });
    const looping = stubFetch("", { redirectTo: "https://example.com/again" });

    const answer = await proxy(context, "https://example.com/", {
      resolver: stubResolver({ "example.com": [PUBLIC] }).resolver,
      fetchImpl: looping.fetchImpl,
    });

    expect(answer?.status).toBe(502);
    expect(codeOf(answer)).toBe("too_many_redirects");
    expect(looping.seen).toHaveLength(4);
  });

  it("refuses a non-HTML target", async () => {
    const context = viewerContext({ allow: ["example.com"] });
    const pdf = stubFetch("%PDF-1.7", { contentType: "application/pdf" });

    const answer = await proxy(context, "https://example.com/a.pdf", {
      resolver: stubResolver({ "example.com": [PUBLIC] }).resolver,
      fetchImpl: pdf.fetchImpl,
    });

    expect(answer?.status).toBe(415);
    expect(codeOf(answer)).toBe("target_not_html");
  });

  it("reports an unreachable target as 502 instead of throwing", async () => {
    const context = viewerContext({ allow: ["example.com"] });
    const failing = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;

    const answer = await proxy(context, "https://example.com/", {
      resolver: stubResolver({ "example.com": [PUBLIC] }).resolver,
      fetchImpl: failing,
    });

    expect(answer?.status).toBe(502);
    expect(codeOf(answer)).toBe("target_unreachable");
    expect(answer?.body).toContain("could not fetch");
  });
});
