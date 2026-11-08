/**
 * @vitest-environment node — the launcher is a pure handler contract; no DOM is involved.
 *
 * Spec: `docs/specs/2026-11-08-viewer-launcher-entry.md` (rev 3, APPROVED). This file covers the
 * pure primitives (`launcherFormat`, `launcherOriginBasis`, `launcherSecretFromBody`), the
 * header-only gates (`launcherHeadRefusal`, `launcherTooLargeAnswer`) and the full
 * `handleViewerStart()` matrix for GET and POST — including the shared `admin` budget and the
 * "no secret in any answer" sweep (AC-L28).
 *
 * The wire re-observation lives in `viewer-dispatch.test.ts`; the renderer contract in
 * `viewer-launcher-page.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

import {
  VIEWER_LAUNCHER_MAX_BODY_BYTES,
  VIEWER_LAUNCHER_FIELD,
  handleViewerStart,
  launcherDeclaresBody,
  launcherFormat,
  launcherHeadRefusal,
  launcherOriginBasis,
  launcherSecretFromBody,
  launcherTooLargeAnswer,
} from "../../server/viewer";
import { adminGate } from "../../server/admin";
import type { AdminThrottle, ServerResponse } from "../../server/handler";
import {
  BASE,
  HUB_ORIGIN,
  VIEWER_ORIGIN,
  request,
  viewerContext,
  type ViewerFixture,
} from "./helpers/viewer-harness";

const SECRET = "operator-secret-123456";
const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const FORM = "application/x-www-form-urlencoded";
const LOCATION = new RegExp(`^${VIEWER_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${BASE}/viewer\\?ticket=[0-9a-f]{48}$`);

/** A hub-surface fixture: the launcher exists only here. */
function hub(overrides: Parameters<typeof viewerContext>[0] = {}): ViewerFixture {
  return viewerContext({ ...overrides, surface: "hub" });
}

/** A budget-keeping throttle stub: `allow` refuses after `maxFailures`, `success` resets. */
function budget(maxFailures = 10): AdminThrottle & {
  allow: ReturnType<typeof vi.fn>;
  failure: ReturnType<typeof vi.fn>;
  success: ReturnType<typeof vi.fn>;
} {
  let failures = 0;
  return {
    allow: vi.fn(() => failures < maxFailures),
    failure: vi.fn(() => {
      failures += 1;
    }),
    success: vi.fn(() => {
      failures = 0;
    }),
  };
}

/** A form POST as the browser sends it (host default from the fixture, form body, HTML accept). */
function formPost(
  body: string | undefined,
  headers: Record<string, string> = {},
): ReturnType<typeof request> {
  return request(`${BASE}/viewer/start`, { accept: HTML_ACCEPT, "content-type": FORM, ...headers }, "POST", body);
}

function json(responses: ServerResponse[]): void {
  expect(responses.length).toBeGreaterThan(0);
}

/* ------------------------------------------------------------------------------------------------
 * Primitives
 * ---------------------------------------------------------------------------------------------- */

describe("launcherFormat (AC-L01/L03/L07)", () => {
  it("asks for html only when text/html is explicit and not weaker than application/json", () => {
    expect(launcherFormat(HTML_ACCEPT)).toBe("html");
    expect(launcherFormat("text/html")).toBe("html");
    expect(launcherFormat("application/xhtml+xml")).toBe("html");
    // A tie wins HTML: browsers list text/html first.
    expect(launcherFormat("text/html, application/json")).toBe("html");
    expect(launcherFormat("text/html;q=1, application/json;q=1")).toBe("html");
  });

  it("stays json for */*, text/*, a missing header and a weaker html range", () => {
    expect(launcherFormat(undefined)).toBe("json");
    expect(launcherFormat("")).toBe("json");
    expect(launcherFormat("*/*")).toBe("json");
    expect(launcherFormat("text/*")).toBe("json");
    expect(launcherFormat("application/json")).toBe("json");
    expect(launcherFormat("text/html;q=0")).toBe("json");
    expect(launcherFormat("text/html;q=0.5, application/json")).toBe("json");
  });

  it("treats an unparseable q as 1 and clamps a parseable one into 0..1", () => {
    expect(launcherFormat("text/html;q=banana")).toBe("html");
    expect(launcherFormat("text/html;q=banana, application/json")).toBe("html");
    expect(launcherFormat("text/html;q=2, application/json;q=1")).toBe("html");
    expect(launcherFormat("text/html;q=-1")).toBe("json");
  });
});

describe("launcherOriginBasis (AC-L33)", () => {
  it("derives scheme and host from Host and X-Forwarded-Proto", () => {
    expect(
      launcherOriginBasis({ headers: { host: "hub.example.com", "x-forwarded-proto": "https" } }),
    ).toBe("https://hub.example.com");
  });

  it("prefers X-Forwarded-Host over Host", () => {
    expect(
      launcherOriginBasis({ headers: { host: "127.0.0.1:8787", "x-forwarded-host": "hub.example.com" } }),
    ).toBe("http://hub.example.com");
  });

  it("takes the first non-empty forwarded element and falls back to Host", () => {
    expect(
      launcherOriginBasis({ headers: { "x-forwarded-host": ", hub.example.com" } }),
    ).toBe("http://hub.example.com");
    expect(
      launcherOriginBasis({ headers: { host: "hub.example.com", "x-forwarded-host": "" } }),
    ).toBe("http://hub.example.com");
    expect(
      launcherOriginBasis({ headers: { host: "hub.example.com", "x-forwarded-host": " , , " } }),
    ).toBe("http://hub.example.com");
  });

  it("answers null without a usable host and refuses host values that carry more than that", () => {
    expect(launcherOriginBasis({ headers: {} })).toBeNull();
    expect(launcherOriginBasis({ headers: { host: "   " } })).toBeNull();
    expect(launcherOriginBasis({ headers: { host: "user@hub.example.com" } })).toBeNull();
    expect(launcherOriginBasis({ headers: { host: "hub.example.com/path" } })).toBeNull();
    // Several clients and proxies normalize `\` to `/`, so a backslash never belongs in a host.
    expect(launcherOriginBasis({ headers: { host: "evil.example\\@good" } })).toBeNull();
  });

  it("normalises the origin: lowercase, default ports removed, scheme kept", () => {
    expect(launcherOriginBasis({ headers: { host: "HUB.Example.com:80" } })).toBe("http://hub.example.com");
    expect(
      launcherOriginBasis({ headers: { host: "hub.example.com:443", "x-forwarded-proto": "https" } }),
    ).toBe("https://hub.example.com");
    expect(
      launcherOriginBasis({ headers: { host: "hub.example.com:8443", "x-forwarded-proto": "https" } }),
    ).toBe("https://hub.example.com:8443");
    expect(launcherOriginBasis({ headers: { host: "hub.example.com:443" } })).toBe(
      "http://hub.example.com:443",
    );
    expect(launcherOriginBasis({ headers: { host: "hub.example.com" } })).not.toBe(
      launcherOriginBasis({ headers: { host: "hub.example.com", "x-forwarded-proto": "https" } }),
    );
  });
});

describe("launcherSecretFromBody (AC-L15/L16)", () => {
  it("decodes the form contract: + is a space, percent escapes are UTF-8", () => {
    expect(launcherSecretFromBody("secret=a+b")).toBe("a b");
    expect(launcherSecretFromBody("secret=a%20b")).toBe("a b");
    expect(launcherSecretFromBody("other=x&secret=value")).toBe("value");
  });

  it("keeps an invalid percent escape literal and never throws", () => {
    expect(() => launcherSecretFromBody("secret=%zz")).not.toThrow();
    expect(launcherSecretFromBody("secret=%zz")).toBe("%zz");
  });

  it("returns the first value of a duplicate key", () => {
    expect(launcherSecretFromBody("secret=first&secret=second")).toBe("first");
  });

  it("distinguishes absent from empty", () => {
    expect(launcherSecretFromBody(undefined)).toBeUndefined();
    expect(launcherSecretFromBody("")).toBeUndefined();
    expect(launcherSecretFromBody("secret=")).toBe("");
  });

  it("uses the documented field name", () => {
    expect(VIEWER_LAUNCHER_FIELD).toBe("secret");
    expect(launcherSecretFromBody("Secret=value")).toBeUndefined();
  });
});

describe("launcherDeclaresBody (spec §5.1 rule 6) — one predicate for the glue and the gate", () => {
  it("declares a body for a positive content-length or any transfer-encoding", () => {
    expect(launcherDeclaresBody({ headers: { "content-length": "1" } })).toBe(true);
    expect(launcherDeclaresBody({ headers: { "content-length": "9000" } })).toBe(true);
    expect(launcherDeclaresBody({ headers: { "transfer-encoding": "chunked" } })).toBe(true);
  });

  it("declares no body for a missing, zero, empty or unparseable length", () => {
    expect(launcherDeclaresBody({})).toBe(false);
    expect(launcherDeclaresBody({ headers: {} })).toBe(false);
    expect(launcherDeclaresBody({ headers: { "content-length": "0" } })).toBe(false);
    expect(launcherDeclaresBody({ headers: { "content-length": "  " } })).toBe(false);
    expect(launcherDeclaresBody({ headers: { "content-length": "many" } })).toBe(false);
  });

  it("treats content-length: 0 plus transfer-encoding as a declared body (CR-1)", () => {
    // The glue reads this body, so the gate must not answer "no body" and skip the media type.
    expect(
      launcherDeclaresBody({ headers: { "content-length": "0", "transfer-encoding": "chunked" } }),
    ).toBe(true);
  });

  it("is the predicate the media-type gate itself uses", () => {
    const answer = launcherHeadRefusal(
      formPost("", {
        "content-length": "0",
        "transfer-encoding": "chunked",
        "content-type": "application/json",
      }),
      hub(),
    );
    expect(answer?.status).toBe(415);
  });
});

/* ------------------------------------------------------------------------------------------------
 * Header-only gates
 * ---------------------------------------------------------------------------------------------- */

describe("launcherHeadRefusal — method gate (AC-L17)", () => {
  it("lets GET and POST through and answers 405 with Allow: GET, POST for everything else", () => {
    const context = hub();
    expect(launcherHeadRefusal(request(`${BASE}/viewer/start`), context)).toBeNull();
    expect(launcherHeadRefusal(request(`${BASE}/viewer/start`, {}, "POST"), context)).toBeNull();

    for (const method of ["PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const answer = launcherHeadRefusal(request(`${BASE}/viewer/start`, {}, method), context);
      expect(answer?.status, method).toBe(405);
      expect(answer?.headers.allow, method).toBe("GET, POST");
      expect(answer?.headers.connection, method).toBe("close");
      expect(answer?.body, method).toContain("method_not_allowed");
    }
  });

  it("answers 405 in HTML when the client prefers HTML", () => {
    const answer = launcherHeadRefusal(
      request(`${BASE}/viewer/start`, { accept: HTML_ACCEPT }, "PUT"),
      hub(),
    );
    expect(answer?.status).toBe(405);
    expect(answer?.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(answer?.headers["x-frame-options"]).toBe("DENY");
    expect(answer?.headers["referrer-policy"]).toBe("no-referrer");
    expect(answer?.body).toContain("<form method=\"post\"");
  });

  it("runs before the origin check: PUT on an unresolved hub is still 405", () => {
    const context = hub();
    const starting: ViewerFixture = { ...context, viewer: { ...context.viewer, origin: undefined } };
    const answer = launcherHeadRefusal(request(`${BASE}/viewer/start`, {}, "PUT"), starting);
    expect(answer?.status).toBe(405);
  });
});

describe("launcherHeadRefusal — start window (AC-L18)", () => {
  it("answers 503 service_not_ready as JSON even for an HTML Accept", () => {
    const context = hub();
    const starting: ViewerFixture = { ...context, viewer: { ...context.viewer, origin: undefined } };
    for (const method of ["GET", "POST"]) {
      const answer = launcherHeadRefusal(
        request(`${BASE}/viewer/start`, { accept: HTML_ACCEPT }, method),
        starting,
      );
      expect(answer?.status, method).toBe(503);
      expect(answer?.headers["content-type"], method).toContain("application/json");
      expect(answer?.headers["retry-after"], method).toBe("1");
      expect(answer?.headers.connection, method).toBe("close");
      expect(answer?.headers.location, method).toBeUndefined();
      expect(answer?.body, method).toContain("service_not_ready");
    }
  });

  it("answers 503 for an empty origin string as well", () => {
    const context = hub();
    const empty: ViewerFixture = { ...context, viewer: { ...context.viewer, origin: "" } };
    expect(launcherHeadRefusal(request(`${BASE}/viewer/start`), empty)?.status).toBe(503);
  });
});

describe("launcherHeadRefusal — Origin / Sec-Fetch-Site gate (AC-L10/L11/L33)", () => {
  const context = (): ViewerFixture => hub();

  it("refuses a foreign Origin with 403 forbidden_origin and never echoes the value", () => {
    const html = launcherHeadRefusal(
      formPost("secret=x", { origin: "https://evil.example" }),
      context(),
    );
    expect(html?.status).toBe(403);
    expect(html?.headers.connection).toBe("close");
    expect(html?.body).toContain("This form was submitted from another site.");
    expect(html?.body).not.toContain("evil.example");

    const jsonAnswer = launcherHeadRefusal(
      formPost("secret=x", { accept: "application/json", origin: "https://evil.example" }),
      context(),
    );
    expect(jsonAnswer?.headers["content-type"]).toContain("application/json");
    expect(jsonAnswer?.body).toContain("forbidden_origin");
    expect(jsonAnswer?.body).not.toContain("evil.example");

    // Spec §9 for this row: the 403 is settled off the headers — no budget spent, no ticket minted.
    const throttle = budget();
    const gated = hub();
    gated.adminThrottle = throttle;
    const full = handleViewerStart(formPost("secret=x", { origin: "https://evil.example" }), gated);
    expect(full?.status).toBe(403);
    expect(throttle.allow).not.toHaveBeenCalled();
    expect(throttle.failure).not.toHaveBeenCalled();
    expect(throttle.success).not.toHaveBeenCalled();
    expect(gated.viewer.tickets.size()).toBe(0);
  });

  it("refuses Origin: null and a multi-valued Origin without parsing it", () => {
    expect(launcherHeadRefusal(formPost("secret=x", { origin: "null" }), context())?.status).toBe(403);
    expect(
      launcherHeadRefusal(
        formPost("secret=x", { origin: "https://a.example, https://b.example" }),
        context(),
      )?.status,
    ).toBe(403);
  });

  it("refuses an Origin that carries a path or userinfo", () => {
    for (const origin of [`${HUB_ORIGIN}/path`, "http://user@127.0.0.1:8787"]) {
      expect(launcherHeadRefusal(formPost("secret=x", { origin }), context())?.status, origin).toBe(403);
    }
  });

  it("refuses Sec-Fetch-Site: cross-site even without an Origin", () => {
    const answer = launcherHeadRefusal(
      formPost("secret=x", { "sec-fetch-site": "cross-site" }),
      context(),
    );
    expect(answer?.status).toBe(403);

    // Spec §9 for this row: no budget, no mint.
    const throttle = budget();
    const gated = hub();
    gated.adminThrottle = throttle;
    const full = handleViewerStart(formPost("secret=x", { "sec-fetch-site": "cross-site" }), gated);
    expect(full?.status).toBe(403);
    expect(throttle.allow).not.toHaveBeenCalled();
    expect(throttle.failure).not.toHaveBeenCalled();
    expect(throttle.success).not.toHaveBeenCalled();
    expect(gated.viewer.tickets.size()).toBe(0);
  });

  it("ignores same-origin, same-site, none and unknown fetch metadata values", () => {
    for (const value of ["same-origin", "same-site", "none", "whatever"]) {
      expect(launcherHeadRefusal(formPost("secret=x", { "sec-fetch-site": value }), context()), value).toBeNull();
    }
  });

  it("matches header names case-insensitively (CR-6)", () => {
    // `node:http` lower-cases on the wire, but a hand-built request need not: the lookup walks the
    // keys instead of indexing two spellings, so every caller sees the same header.
    expect(
      launcherHeadRefusal(formPost("secret=x", { Origin: "https://evil.example" }), context())?.status,
    ).toBe(403);
    expect(
      launcherHeadRefusal(formPost("secret=x", { "Sec-Fetch-Site": "cross-site" }), context())?.status,
    ).toBe(403);
    expect(
      launcherOriginBasis({ headers: { Host: "hub.example.com", "X-Forwarded-Proto": "https" } }),
    ).toBe("https://hub.example.com");
  });

  it("accepts a POST without an Origin when a Host is present (AC-L12)", () => {
    expect(launcherHeadRefusal(formPost("secret=x"), context())).toBeNull();
  });

  it("never gates a GET (AC-L12/§5.2 rule 8)", () => {
    expect(
      launcherHeadRefusal(
        request(`${BASE}/viewer/start?k=x`, { origin: "https://evil.example" }),
        context(),
      ),
    ).toBeNull();
  });

  it("accepts the TLS-proxy topology, the loopback topology and the forwarded list (AC-L33)", () => {
    const proxy = launcherHeadRefusal(
      formPost("secret=x", {
        host: "hub.example.com",
        "x-forwarded-proto": "https",
        origin: "https://hub.example.com",
      }),
      context(),
    );
    expect(proxy).toBeNull();

    const loopback = launcherHeadRefusal(
      formPost("secret=x", { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" }),
      context(),
    );
    expect(loopback).toBeNull();

    const forwarded = launcherHeadRefusal(
      formPost("secret=x", {
        "x-forwarded-host": ", hub.example.com",
        "x-forwarded-proto": "https",
        origin: "https://hub.example.com",
      }),
      context(),
    );
    expect(forwarded).toBeNull();

    // AC-L33 asks for the end state of a full request, not only for a passing gate: the browser
    // path (HTML Accept) ends in a 303 onto the viewer, the script path (JSON Accept) in a 200.
    const topologies: Array<Record<string, string>> = [
      { host: "hub.example.com", "x-forwarded-proto": "https", origin: "https://hub.example.com" },
      { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" },
    ];
    for (const headers of topologies) {
      const browserContext = hub();
      const browser = handleViewerStart(formPost(`secret=${SECRET}`, headers), browserContext);
      expect(browser?.status, headers.origin).toBe(303);
      expect(String(browser?.headers.location), headers.origin).toMatch(LOCATION);
      expect(browser?.headers["set-cookie"], headers.origin).toBeUndefined();
      expect(browserContext.viewer.tickets.size(), headers.origin).toBe(1);

      const script = handleViewerStart(
        request(`${BASE}/viewer/start`, { accept: "application/json", ...headers }, "POST", `secret=${SECRET}`),
        hub(),
      );
      expect(script?.status, headers.origin).toBe(200);
      expect(String(script?.body), headers.origin).toContain('"url"');
    }
  });

  it("refuses both browser topologies when the proxy contract is not met", () => {
    // nginx's default `Host $proxy_host`: the basis is the upstream, the browser sends the public name.
    expect(
      launcherHeadRefusal(
        formPost("secret=x", { host: "upstream:8787", origin: "https://hub.example.com" }),
        context(),
      )?.status,
    ).toBe(403);
    // TLS in front, no X-Forwarded-Proto: the basis is http, the browser sends https.
    expect(
      launcherHeadRefusal(
        formPost("secret=x", { host: "hub.example.com", origin: "https://hub.example.com" }),
        context(),
      )?.status,
    ).toBe(403);
  });
});

describe("launcherHeadRefusal — media type and size (AC-L13/L14)", () => {
  it("answers 415 for a declared body with a non-form content-type", () => {
    const html = launcherHeadRefusal(
      formPost("", { "content-type": "application/json", "content-length": "20" }),
      hub(),
    );
    expect(html?.status).toBe(415);
    expect(html?.headers.connection).toBe("close");
    expect(html?.body).toContain("The form could not be read.");

    const jsonAnswer = launcherHeadRefusal(
      formPost("", { accept: "application/json", "content-type": "application/json", "content-length": "20" }),
      hub(),
    );
    expect(jsonAnswer?.body).toContain("unsupported_media_type");
  });

  it("answers 415 for a form type whose charset is not utf-8", () => {
    const answer = launcherHeadRefusal(
      formPost("", { "content-type": `${FORM}; charset=iso-8859-1`, "content-length": "7" }),
      hub(),
    );
    expect(answer?.status).toBe(415);
  });

  it("accepts the form type with and without charset=utf-8", () => {
    for (const type of [FORM, `${FORM}; charset=utf-8`, `${FORM};charset="UTF-8"`]) {
      expect(
        launcherHeadRefusal(formPost("secret=x", { "content-type": type, "content-length": "8" }), hub()),
        type,
      ).toBeNull();
    }
  });

  it("does not apply the media-type rule to a body-less POST (the admin button)", () => {
    // `call()` sends content-type: application/json even without a body; that must not be a 415.
    expect(
      launcherHeadRefusal(
        request(`${BASE}/viewer/start`, { "content-type": "application/json" }, "POST"),
        hub(),
      ),
    ).toBeNull();
  });

  it("answers 413 for a declared content-length above the limit, without reading", () => {
    const html = launcherHeadRefusal(
      formPost("", { "content-length": String(VIEWER_LAUNCHER_MAX_BODY_BYTES + 1) }),
      hub(),
    );
    expect(html?.status).toBe(413);
    expect(html?.headers.connection).toBe("close");
    expect(html?.body).toContain("The submission was too large.");

    const jsonAnswer = launcherHeadRefusal(
      formPost("", {
        accept: "application/json",
        "content-length": String(VIEWER_LAUNCHER_MAX_BODY_BYTES + 1),
      }),
      hub(),
    );
    expect(jsonAnswer?.body).toContain("payload_too_large");
  });

  it("lets exactly the limit through and derives the format itself", () => {
    expect(
      launcherHeadRefusal(
        formPost("", { "content-length": String(VIEWER_LAUNCHER_MAX_BODY_BYTES) }),
        hub(),
      ),
    ).toBeNull();

    const html = launcherTooLargeAnswer(
      { url: `${BASE}/viewer/start`, headers: { accept: HTML_ACCEPT } },
      hub(),
    );
    expect(html.status).toBe(413);
    expect(html.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(html.headers.connection).toBe("close");
    expect(html.body).toContain("The submission was too large.");
  });

  it("answers 415 for a transfer-encoding body without a form content-type", () => {
    const answer = launcherHeadRefusal(
      request(
        `${BASE}/viewer/start`,
        { accept: "application/json", "content-type": "text/plain", "transfer-encoding": "chunked" },
        "POST",
      ),
      hub(),
    );
    expect(answer?.status).toBe(415);
  });
});

/* ------------------------------------------------------------------------------------------------
 * handleViewerStart — GET matrix
 * ---------------------------------------------------------------------------------------------- */

describe("handleViewerStart — the form page (AC-L01/L02)", () => {
  it("answers 200 html without spending the budget", () => {
    const throttle = budget();
    const context = hub();
    context.adminThrottle = throttle;

    const answer = handleViewerStart(
      request(`${BASE}/viewer/start`, { accept: HTML_ACCEPT }),
      context,
    );
    expect(answer?.status).toBe(200);
    expect(answer?.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(answer?.headers["cache-control"]).toBe("no-store");
    expect(answer?.headers["x-frame-options"]).toBe("DENY");
    expect(answer?.headers["referrer-policy"]).toBe("no-referrer");
    expect(answer?.headers["content-security-policy"]).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(answer?.headers.connection).toBeUndefined();
    expect(answer?.body).toContain('<input type="password" name="secret"');
    expect(answer?.body).toContain(`action="${BASE}/viewer/start"`);
    expect(answer?.body).toContain('<html lang="en">');
    expect(throttle.allow).not.toHaveBeenCalled();
    expect(throttle.failure).not.toHaveBeenCalled();
    expect(throttle.success).not.toHaveBeenCalled();
  });

  it("answers the German page for Accept-Language: de", () => {
    const answer = handleViewerStart(
      request(`${BASE}/viewer/start`, { accept: HTML_ACCEPT, "accept-language": "de-DE,de;q=0.9" }),
      hub(),
    );
    expect(answer?.status).toBe(200);
    expect(answer?.body).toContain('<html lang="de">');
    expect(answer?.body).toContain("Viewer-Anmeldung");
    expect(answer?.body).toContain("Viewer öffnen");
    expect(answer?.body).not.toContain("Viewer login");
  });

  it("keeps the JSON 401 for an Accept that does not ask for html (AC-L03)", () => {
    const throttle = budget();
    const context = hub();
    context.adminThrottle = throttle;

    for (const headers of [{ accept: "*/*" }, {}] as Array<Record<string, string>>) {
      const answer = handleViewerStart(request(`${BASE}/viewer/start`, headers), context);
      expect(answer?.status).toBe(401);
      expect(answer?.headers["content-type"]).toContain("application/json");
      expect(answer?.body).toContain("unauthorized");
      expect(answer?.body).not.toContain("<form");
    }
    expect(throttle.allow).not.toHaveBeenCalled();
  });
});

describe("handleViewerStart — GET with a secret (AC-L04/L05)", () => {
  it("answers 302 with a 48-hex ticket for a valid query, and for a valid header", () => {
    for (const req of [
      request(`${BASE}/viewer/start?k=${SECRET}`, { accept: HTML_ACCEPT }),
      request(`${BASE}/viewer/start`, { accept: HTML_ACCEPT, "x-bluepencil-admin": SECRET }),
    ]) {
      const answer = handleViewerStart(req, hub());
      expect(answer?.status).toBe(302);
      expect(String(answer?.headers.location)).toMatch(LOCATION);
      expect(answer?.headers["referrer-policy"]).toBe("no-referrer");
      expect(answer?.headers["cache-control"]).toBe("no-store");
      expect(answer?.headers["set-cookie"]).toBeUndefined();
      expect(answer?.headers.connection).toBeUndefined();
      expect(answer?.body).toBe("");
    }
  });

  it("answers 401 html with the invalid message, no echo and one failure (AC-L05)", () => {
    const throttle = budget();
    const context = hub();
    context.adminThrottle = throttle;

    const answer = handleViewerStart(
      request(`${BASE}/viewer/start?k=not-the-secret`, { accept: HTML_ACCEPT }),
      context,
    );
    expect(answer?.status).toBe(401);
    expect(answer?.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(answer?.headers.location).toBeUndefined();
    expect(answer?.body).toContain("The operator secret is not valid.");
    expect(answer?.body).not.toContain("not-the-secret");
    expect(throttle.failure).toHaveBeenCalledTimes(1);
  });

  it("lets the header win over a wrong ?k=", () => {
    const throttle = budget();
    const context = hub();
    context.adminThrottle = throttle;
    const answer = handleViewerStart(
      request(`${BASE}/viewer/start?k=wrong`, { accept: HTML_ACCEPT, "x-bluepencil-admin": SECRET }),
      context,
    );
    expect(answer?.status).toBe(302);
    expect(throttle.success).toHaveBeenCalledTimes(1);
    expect(throttle.failure).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------------------------------
 * handleViewerStart — POST matrix
 * ---------------------------------------------------------------------------------------------- */

describe("handleViewerStart — a valid form body (AC-L06/L07)", () => {
  it("answers 303 with one mint and no set-cookie for html", () => {
    const context = hub();
    const answer = handleViewerStart(formPost(`secret=${SECRET}`), context);
    expect(answer?.status).toBe(303);
    expect(String(answer?.headers.location)).toMatch(LOCATION);
    expect(answer?.headers["referrer-policy"]).toBe("no-referrer");
    expect(answer?.headers["cache-control"]).toBe("no-store");
    expect(answer?.headers["set-cookie"]).toBeUndefined();
    expect(answer?.headers.connection).toBeUndefined();
    expect(answer?.body).toBe("");
    expect(context.viewer.tickets.size()).toBe(1);
  });

  it("mints exactly once per request", () => {
    const context = hub();
    const mint = vi.spyOn(context.viewer.tickets, "mint");
    handleViewerStart(formPost(`secret=${SECRET}`), context);
    expect(mint).toHaveBeenCalledTimes(1);
    mint.mockRestore();
  });

  it("answers 200 {url} for a json Accept, with no location (AC-L07)", () => {
    const context = hub();
    const answer = handleViewerStart(
      request(
        `${BASE}/viewer/start`,
        { accept: "application/json", "content-type": FORM },
        "POST",
        `secret=${SECRET}`,
      ),
      context,
    );
    expect(answer?.status).toBe(200);
    expect(answer?.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(answer?.headers.location).toBeUndefined();
    expect(answer?.headers["set-cookie"]).toBeUndefined();
    const parsed = JSON.parse(String(answer?.body)) as { url: string };
    expect(parsed).toEqual({ url: expect.stringMatching(LOCATION) });
  });

  it("keeps the ticket single-use", async () => {
    const context = hub();
    const answer = handleViewerStart(formPost(`secret=${SECRET}`), context);
    const ticket = new URL(String(answer?.headers.location)).searchParams.get("ticket") ?? "";
    expect(context.viewer.tickets.consume(ticket)).toBe(true);
    expect(context.viewer.tickets.consume(ticket)).toBe(false);
  });
});

describe("handleViewerStart — a wrong form body (AC-L08)", () => {
  it("answers 401 per format, one failure, and echoes nothing", () => {
    const htmlThrottle = budget();
    const htmlContext = hub();
    htmlContext.adminThrottle = htmlThrottle;
    const html = handleViewerStart(formPost("secret=wrong-value"), htmlContext);
    expect(html?.status).toBe(401);
    expect(html?.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(html?.body).toContain("The operator secret is not valid.");
    expect(html?.body).not.toContain("wrong-value");
    expect(htmlThrottle.failure).toHaveBeenCalledTimes(1);

    const jsonThrottle = budget();
    const jsonContext = hub();
    jsonContext.adminThrottle = jsonThrottle;
    const jsonAnswer = handleViewerStart(
      request(`${BASE}/viewer/start`, { accept: "application/json", "content-type": FORM }, "POST", "secret=wrong-value"),
      jsonContext,
    );
    expect(jsonAnswer?.status).toBe(401);
    expect(jsonAnswer?.headers["content-type"]).toContain("application/json");
    expect(jsonAnswer?.body).toContain("unauthorized");
    expect(jsonAnswer?.body).not.toContain("wrong-value");
    expect(jsonThrottle.failure).toHaveBeenCalledTimes(1);
  });
});

describe("handleViewerStart — missing / empty / query-only secret (AC-L09)", () => {
  it("answers 401 without touching the budget, for every shape", () => {
    const throttle = budget();
    const context = hub();
    context.adminThrottle = throttle;

    const cases: Array<ReturnType<typeof request>> = [
      formPost("secret="),
      formPost(""),
      formPost(undefined),
      request(`${BASE}/viewer/start?k=${SECRET}`, { accept: HTML_ACCEPT, "content-type": FORM }, "POST", ""),
      request(`${BASE}/viewer/start`, { accept: "application/json" }, "POST"),
    ];
    for (const req of cases) {
      const answer = handleViewerStart(req, context);
      expect(answer?.status, req.url + String(req.body)).toBe(401);
      expect(answer?.headers.location, req.url).toBeUndefined();
    }
    expect(throttle.allow).not.toHaveBeenCalled();
    expect(throttle.failure).not.toHaveBeenCalled();
    expect(throttle.success).not.toHaveBeenCalled();
    expect(context.viewer.tickets.size()).toBe(0);
  });
});

describe("handleViewerStart — precedence and decoding (AC-L15/L16)", () => {
  it("lets the header win over a wrong body value with exactly one success", () => {
    const throttle = budget();
    const context = hub();
    context.adminThrottle = throttle;
    const answer = handleViewerStart(
      formPost("secret=wrong-value", { "x-bluepencil-admin": SECRET }),
      context,
    );
    expect(answer?.status).toBe(303);
    expect(throttle.success).toHaveBeenCalledTimes(1);
    expect(throttle.failure).not.toHaveBeenCalled();
  });

  it("uses the first duplicate field", () => {
    const context = hub();
    expect(handleViewerStart(formPost(`secret=wrong&secret=${SECRET}`), context)?.status).toBe(401);
    expect(handleViewerStart(formPost(`secret=${SECRET}&secret=wrong`), context)?.status).toBe(303);
  });

  it("decodes + as a space and keeps %zz literal (no 500)", () => {
    const spaced = hub({ adminSecret: "a b" });
    expect(handleViewerStart(formPost("secret=a+b"), spaced)?.status).toBe(303);

    const plain = hub();
    const invalid = handleViewerStart(formPost("secret=%zz"), plain);
    expect(invalid?.status).toBe(401);
    expect(invalid?.headers.location).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------------------------------
 * Shared budget and answer headers
 * ---------------------------------------------------------------------------------------------- */

describe("handleViewerStart — one shared admin budget (AC-L30)", () => {
  it("answers 429 with retry-after and the same seconds in the HTML text", () => {
    const throttle = budget();
    const context = hub();
    context.adminThrottle = throttle;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(handleViewerStart(formPost(`secret=wrong-${attempt}`), context)?.status).toBe(401);
    }
    const throttled = handleViewerStart(formPost(`secret=${SECRET}`), context);
    expect(throttled?.status).toBe(429);
    expect(throttled?.headers["retry-after"]).toBe("300");
    expect(throttled?.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(throttled?.headers.connection).toBeUndefined();
    expect(throttled?.body).toContain("300");
    expect(throttled?.body).not.toContain("{seconds}");
    expect(context.viewer.tickets.size()).toBe(0);
  });

  it("never mints on the JSON 429 and keeps the documented Retry-After", () => {
    const context = hub();
    context.adminThrottle = { allow: () => false, failure: () => undefined, success: () => undefined };
    const answer = handleViewerStart(
      request(
        `${BASE}/viewer/start`,
        { accept: "application/json", "content-type": FORM },
        "POST",
        `secret=${SECRET}`,
      ),
      context,
    );
    expect(answer?.status).toBe(429);
    expect(answer?.headers["retry-after"]).toBe("300");
    expect(answer?.body).toContain("too_many_attempts");
    expect(context.viewer.tickets.size()).toBe(0);
  });

  it("exhausts the same budget that /admin/status uses — in both directions", () => {
    // (b) launcher first, then the admin door.
    const fromLauncher = hub();
    const launcherThrottle = budget();
    fromLauncher.adminThrottle = launcherThrottle;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      handleViewerStart(formPost(`secret=wrong-${attempt}`), fromLauncher);
    }
    const admin = adminGate(
      request(`${BASE}/admin/status`, { "x-bluepencil-admin": SECRET }),
      fromLauncher,
    );
    expect(admin.kind).toBe("response");
    expect(admin.kind === "response" ? admin.response.status : 0).toBe(429);

    // (c) admin door first, then the launcher.
    const fromAdmin = hub();
    const adminThrottle = budget();
    fromAdmin.adminThrottle = adminThrottle;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      adminGate(request(`${BASE}/admin/status`, { "x-bluepencil-admin": `wrong-${attempt}` }), fromAdmin);
    }
    expect(handleViewerStart(formPost(`secret=${SECRET}`), fromAdmin)?.status).toBe(429);
  });
});

describe("handleViewerStart — no secret in any answer (AC-L28)", () => {
  it("puts no secret into any location, response body or set-cookie", () => {
    const requests = [
      request(`${BASE}/viewer/start`, { accept: HTML_ACCEPT }),
      request(`${BASE}/viewer/start?k=${SECRET}`, { accept: HTML_ACCEPT }),
      request(`${BASE}/viewer/start?k=wrong`, { accept: HTML_ACCEPT }),
      request(`${BASE}/viewer/start`, { accept: "*/*" }),
      request(`${BASE}/viewer/start`, { accept: HTML_ACCEPT, "x-bluepencil-admin": SECRET }),
      formPost(`secret=${SECRET}`),
      formPost("secret=wrong"),
      request(`${BASE}/viewer/start`, { accept: "application/json", "content-type": FORM }, "POST", `secret=${SECRET}`),
      request(`${BASE}/viewer/start?k=${SECRET}&secret=${SECRET}`, { accept: HTML_ACCEPT, "content-type": FORM }, "POST", ""),
    ];
    const answers: ServerResponse[] = [];
    for (const req of requests) {
      const answer = handleViewerStart(req, hub());
      if (answer !== null) answers.push(answer);
    }
    json(answers);
    for (const answer of answers) {
      const location = answer.headers.location;
      if (location !== undefined) expect(location).toMatch(LOCATION);
      expect(answer.body).not.toContain(SECRET);
      expect(answer.headers["set-cookie"] ?? "").not.toContain(SECRET);
    }
  });
});

describe("handleViewerStart — hubs without a usable credential (AC-L31)", () => {
  it("answers 401 without a budget when the hub has no operator secret", () => {
    const throttle = budget();
    const base = hub();
    const context: ViewerFixture = { ...base, adminSecret: undefined, adminThrottle: throttle };

    for (const [format, accept] of [["html", HTML_ACCEPT], ["json", "application/json"]] as const) {
      const answer = handleViewerStart(
        request(`${BASE}/viewer/start`, { accept, "content-type": FORM }, "POST", "secret=anything"),
        context,
      );
      expect(answer?.status, format).toBe(401);
      expect(answer?.headers.location, format).toBeUndefined();
    }
    expect(throttle.allow).not.toHaveBeenCalled();
    expect(throttle.failure).not.toHaveBeenCalled();
    expect(context.viewer.tickets.size()).toBe(0);
  });
});

describe("handleViewerStart — German error re-render (AC-L32)", () => {
  it("answers 401 in German with role alert and autofocus", () => {
    for (const req of [
      formPost("secret=wrong", { "accept-language": "de" }),
      request(`${BASE}/viewer/start?k=wrong`, { accept: HTML_ACCEPT, "accept-language": "de" }),
    ]) {
      const answer = handleViewerStart(req, hub());
      expect(answer?.status).toBe(401);
      expect(answer?.body).toContain('<html lang="de">');
      expect(answer?.body).toContain("Viewer-Anmeldung");
      expect(answer?.body).toContain("Viewer öffnen");
      expect(answer?.body).toContain("Admin-Secret");
      expect(answer?.body).toContain("Das Operator-Secret ist nicht gültig.");
      expect(answer?.body).toContain('role="alert"');
      expect(answer?.body).toContain("autofocus");
      expect(answer?.body).not.toContain("Viewer login");
    }
  });
});
