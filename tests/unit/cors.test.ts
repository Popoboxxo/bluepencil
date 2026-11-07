/**
 * @vitest-environment node — the hub's CORS rules are server policy, not a DOM concern.
 *
 * `--cors` resolution (SEC-06, ADR-0.12-S1, AC-D09).
 *
 * The audit finding was not "CORS exists"; it was that a **bare** `--cors` meant `*`, so an operator
 * who thought they had allowed one origin had allowed every website on the internet to read and
 * write every note. The fix has two halves and this suite pins both:
 *
 *   - the value is required (`cors_value_missing`), so `*` has to be spelled out;
 *   - `*` is only admitted behind a real client credential (`cors_wildcard_unauthenticated`
 *     otherwise), because the wildcard removes the browser's origin boundary and leaves the gate.
 *
 * The `corsHeaders`/`preflightResponse` cases below are the *no silent wildcard* half: nothing in
 * the answer path may invent an origin when the policy said `null`.
 */
import { describe, expect, it } from "vitest";
import {
  CORS_WILDCARD_WARNING,
  corsHeaders,
  corsOriginPolicy,
  preflightResponse,
  responseCorsHeaders,
  viewerBookmarkletCors,
  viewerBookmarkletPreflight,
} from "../../server/cors";
import {
  DEFAULT_BASE_PATH,
  handleRequest,
  type HandlerContext,
  type ServerResponse,
} from "../../server/handler";

const BASE = DEFAULT_BASE_PATH;
const SHARED = "cors-test-shared-value";

/**
 * The viewer surface switch of 0.14.0 (`surfaceOf()` lands with Task 6). Declared locally so this
 * suite can pin `responseCorsHeaders()` before `HandlerContext` grows the field.
 */
type CorsContext = HandlerContext & { surface?: "hub" | "viewer" };

function handlerContext(overrides: Partial<CorsContext> = {}): CorsContext {
  return {
    store: { notes: [] },
    base: BASE,
    environment: "dev",
    readOnly: false,
    persist: () => undefined,
    ...overrides,
  };
}

function options(path: string, overrides: Partial<CorsContext> = {}): ServerResponse {
  return handleRequest(
    {
      method: "OPTIONS",
      url: `${BASE}${path}`,
      headers: { origin: "https://app.example", "access-control-request-method": "GET" },
      body: "",
    },
    handlerContext(overrides),
  );
}

/** The two deployment shapes the policy distinguishes: a real client gate, or none at all. */
const GATED = true;
const UNGATED = false;

describe("corsOriginPolicy — ADR-0.12-S1 (SEC-06)", () => {
  it("treats an absent --cors as 'no CORS at all'", () => {
    expect(corsOriginPolicy(undefined, GATED)).toEqual({
      ok: true,
      origin: null,
    });
  });

  it("refuses a bare or empty --cors instead of inventing the wildcard", () => {
    // `--cors` with no value, `--cors=` and `--cors ''` all arrive as an empty string here. Every
    // one of them used to become `*` — that is exactly the finding.
    for (const raw of ["", "   "]) {
      expect(corsOriginPolicy(raw, GATED), JSON.stringify(raw)).toEqual({
        ok: false,
        code: "cors_value_missing",
      });
    }
  });

  it("refuses '*' when no client credential is configured", () => {
    expect(corsOriginPolicy("*", UNGATED)).toEqual({
      ok: false,
      code: "cors_wildcard_unauthenticated",
    });
  });

  it("admits '*' behind a credential and names the remaining risk", () => {
    const policy = corsOriginPolicy("*", GATED);

    expect(policy.ok).toBe(true);
    if (!policy.ok) return;
    expect(policy.origin).toBe("*");
    expect(policy.warning).toEqual(CORS_WILDCARD_WARNING);
    // The message has to say what the wildcard actually did — "every origin" is not an abstraction.
    expect(policy.warning?.message).toContain("--cors '*'");
    expect(policy.warning?.message).toContain("every origin");
  });

  it("passes an explicit origin through unchanged, with no warning", () => {
    const policy = corsOriginPolicy("https://app.example", UNGATED);

    expect(policy).toEqual({ ok: true, origin: "https://app.example" });
  });

  it("trims surrounding whitespace instead of emitting a header with a trailing space", () => {
    // A value copied out of a shell or a compose file carries whitespace; `allow-origin` with a
    // trailing space matches no origin at all, which looks like "CORS is broken" in a browser.
    expect(corsOriginPolicy(" http://localhost:9283 ", false)).toEqual({
      ok: true,
      origin: "http://localhost:9283",
    });
  });

  it("keeps an origin that merely contains a star as an explicit value", () => {
    // `*` is special only as the whole value; anything else is an origin the operator wrote.
    expect(corsOriginPolicy("https://*.example", true)).toEqual({
      ok: true,
      origin: "https://*.example",
    });
  });
});

describe("no silent wildcard on the answer path", () => {
  it("sends no CORS header when the policy resolved to null", () => {
    expect(corsHeaders(undefined)).toEqual({});
    expect(corsHeaders("")).toEqual({});
  });

  it("answers a preflight only for a configured origin", () => {
    expect(preflightResponse("OPTIONS", { cors: undefined }, ["GET"])).toBeNull();

    const answer = preflightResponse("OPTIONS", { cors: "https://a.example" }, ["GET", "POST"]);
    expect(answer?.status).toBe(204);
    expect(answer?.headers["access-control-allow-origin"]).toBe("https://a.example");
    // A named origin is cacheable per origin only — without `vary` a shared cache may hand one
    // site's answer to another.
    expect(answer?.headers["vary"]).toBe("Origin");
    expect(answer?.headers["access-control-allow-methods"]).toBe("GET, POST, OPTIONS");
  });

  it("echoes the resolved wildcard without a vary header", () => {
    const answer = preflightResponse("OPTIONS", { cors: "*" }, ["GET"]);
    expect(answer?.headers["access-control-allow-origin"]).toBe("*");
    expect(answer?.headers).not.toHaveProperty("vary");
  });
});

describe("preflightResponse — one implementation, credential-free (AC-D13)", () => {
  it("answers OPTIONS /notes without a credential on an authenticated hub", () => {
    // A browser sends OPTIONS before it can know which credential to bring. A credential check here
    // could only refuse the pairing, never protect a note — so the preflight is answered, and the
    // POST that follows it still meets the gate.
    const response = options("/notes", { cors: "*", authSecret: SHARED });

    expect(response.status).toBe(204);
    expect(response.body).toBe("");
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.headers["access-control-allow-methods"]).toBe("GET, POST, OPTIONS");

    const gated = handleRequest(
      { method: "GET", url: `${BASE}/notes`, headers: {}, body: "" },
      handlerContext({ cors: "*", authSecret: SHARED }),
    );
    expect(gated.status).toBe(401);
  });

  it("is the helper's answer, not a route-local copy", () => {
    // The same call the route makes: one status, one header set. Two implementations would drift the
    // day one of them learns a header the other does not.
    const direct = preflightResponse("OPTIONS", { cors: "*" }, ["GET", "POST"]);
    const routed = options("/notes", { cors: "*" });

    expect(routed.status).toBe(direct?.status);
    expect(routed.headers).toEqual(direct?.headers);
  });

  it("keeps the gate when there is no CORS caller to answer", () => {
    // Without `--cors` the helper returns null, so OPTIONS is just another unauthenticated request:
    // it meets the credential gate (401) rather than becoming an empty 204 that announces the API.
    const response = options("/notes", { authSecret: SHARED });
    expect(response.status).toBe(401);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["access-control-allow-methods"]).toBeUndefined();
  });
});

const VIEWER_ORIGIN = "https://app.example";
const REQUESTED_HEADERS = "content-type, x-bluepencil-viewer";

/** A request shape `responseCorsHeaders()` reads — method, target and headers only. */
function corsRequest(
  method: string,
  path: string,
  headers: Record<string, string | string[] | undefined> = {},
): { url: string; method: string; headers: Record<string, string | string[] | undefined> } {
  return { url: path, method, headers };
}

describe("viewerBookmarkletPreflight — UT-19 (AC-5.21)", () => {
  it("reflects the exact origin and publishes the fixed notes method union", () => {
    const answer = viewerBookmarkletPreflight("OPTIONS", VIEWER_ORIGIN, REQUESTED_HEADERS);

    expect(answer?.status).toBe(204);
    expect(answer?.body).toBe("");
    expect(answer?.headers["access-control-allow-origin"]).toBe(VIEWER_ORIGIN);
    // The union the whole `/notes*` family documents — not a per-route subset (spec §2.5 Regel 1).
    expect(answer?.headers["access-control-allow-methods"]).toBe("GET, POST, PATCH, OPTIONS");
    expect(answer?.headers["access-control-allow-headers"]).toBe(
      "Content-Type, X-Bluepencil-Viewer",
    );
    expect(answer?.headers["access-control-allow-headers"]).toContain("Content-Type");
    expect(answer?.headers["access-control-allow-headers"]).toContain("X-Bluepencil-Viewer");
    expect(answer?.headers["access-control-max-age"]).toBe("600");
    expect(answer?.headers["vary"]).toBe("Origin");
    // The bookmarklet carries a header token, never a cookie — credentials must stay off.
    expect(answer?.headers).not.toHaveProperty("access-control-allow-credentials");
  });

  it("takes no allowMethods parameter — the signature is the three-argument contract", () => {
    // Arity is the contract: a fourth `allowMethods` argument would let a route advertise less than
    // the family union and make the bookmarklet's PATCH preflight fail.
    expect(viewerBookmarkletPreflight.length).toBe(3);

    const answer = viewerBookmarkletPreflight("OPTIONS", VIEWER_ORIGIN, REQUESTED_HEADERS);
    expect(answer?.headers["access-control-allow-methods"]).toBe("GET, POST, PATCH, OPTIONS");
  });

  it("returns null for anything that is not OPTIONS", () => {
    expect(viewerBookmarkletPreflight("GET", VIEWER_ORIGIN, REQUESTED_HEADERS)).toBeNull();
    expect(viewerBookmarkletPreflight("POST", VIEWER_ORIGIN, REQUESTED_HEADERS)).toBeNull();
    expect(viewerBookmarkletPreflight(undefined, VIEWER_ORIGIN, REQUESTED_HEADERS)).toBeNull();
  });

  it("returns null for a missing or invalid origin", () => {
    const invalid = [
      undefined,
      "",
      "   ",
      "null",
      "app.example",
      "https://app.example/path",
      "https://app.example/?q=1",
      "https://app.example?q=1",
      "https://app.example#fragment",
      "https://user:pass@app.example",
      "ftp://app.example",
    ];
    for (const origin of invalid) {
      expect(viewerBookmarkletPreflight("OPTIONS", origin, REQUESTED_HEADERS), String(origin)).toBeNull();
    }
  });

  it("requires x-bluepencil-viewer in the requested headers", () => {
    const withoutViewerHeader = [
      undefined,
      "",
      "content-type",
      "x-bluepencil-viewer-extra",
      "x-bluepencil-viewer-session",
    ];
    for (const requested of withoutViewerHeader) {
      expect(viewerBookmarkletPreflight("OPTIONS", VIEWER_ORIGIN, requested), String(requested)).toBeNull();
    }

    // Comma-separated and case-insensitive, as a browser sends it.
    expect(
      viewerBookmarkletPreflight("OPTIONS", VIEWER_ORIGIN, "Content-Type, X-Bluepencil-Viewer"),
    ).not.toBeNull();
  });
});

describe("viewerBookmarkletCors — UT-19 (AC-5.21)", () => {
  it("reflects the same origin on the actual response, with vary: Origin", () => {
    expect(viewerBookmarkletCors(VIEWER_ORIGIN)).toEqual({
      "access-control-allow-origin": VIEWER_ORIGIN,
      vary: "Origin",
    });
  });

  it("sends nothing for a missing or invalid origin", () => {
    for (const origin of [undefined, "", "null", "app.example", "https://app.example/path"]) {
      expect(viewerBookmarkletCors(origin), String(origin)).toEqual({});
    }
  });

  it("never advertises credentials or methods on an ordinary answer", () => {
    const headers = viewerBookmarkletCors(VIEWER_ORIGIN);
    expect(headers).not.toHaveProperty("access-control-allow-credentials");
    expect(headers).not.toHaveProperty("access-control-allow-methods");
  });
});

describe("viewerBookmarkletPreflight — UT-27 requested-header gate", () => {
  it("does not answer an OPTIONS without the requested header", () => {
    // A plain CORS preflight (no `x-bluepencil-viewer`) is not the bookmarklet's; the viewer
    // surface must not advertise itself to an arbitrary page.
    expect(viewerBookmarkletPreflight("OPTIONS", VIEWER_ORIGIN, undefined)).toBeNull();
    expect(
      viewerBookmarkletPreflight("OPTIONS", VIEWER_ORIGIN, "content-type, authorization"),
    ).toBeNull();
  });
});

describe("responseCorsHeaders — hub surface is byte-identical", () => {
  it("returns exactly corsHeaders(context.cors) on the hub", () => {
    const context = handlerContext({ cors: "https://hub.example" });
    const requests = [
      corsRequest("GET", `${BASE}/notes`, { origin: VIEWER_ORIGIN }),
      corsRequest("POST", `${BASE}/notes`, { origin: VIEWER_ORIGIN }),
      corsRequest("GET", `${BASE}/bundle`),
      corsRequest("GET", `${BASE}/health`),
    ];
    for (const request of requests) {
      expect(responseCorsHeaders(request, context), request.url).toEqual(
        corsHeaders("https://hub.example"),
      );
    }
  });

  it("sends no header on the hub when --cors is off", () => {
    expect(
      responseCorsHeaders(corsRequest("GET", `${BASE}/notes`, { origin: VIEWER_ORIGIN }), handlerContext()),
    ).toEqual({});
  });

  it("treats an explicit surface: hub exactly like an absent one", () => {
    const request = corsRequest("GET", `${BASE}/notes`, { origin: VIEWER_ORIGIN });
    expect(responseCorsHeaders(request, handlerContext({ surface: "hub", cors: "*" }))).toEqual(
      responseCorsHeaders(request, handlerContext({ cors: "*" })),
    );
  });
});

describe("responseCorsHeaders — viewer surface only on {base}/notes*", () => {
  const viewerContext = (overrides: Partial<CorsContext> = {}): CorsContext =>
    handlerContext({ surface: "viewer", ...overrides });

  it("reflects the origin on GET /notes and its error paths' request shape", () => {
    const expected = viewerBookmarkletCors(VIEWER_ORIGIN);
    for (const [method, path] of [
      ["GET", `${BASE}/notes`],
      ["GET", `${BASE}/notes?intent=falsch`],
      ["POST", `${BASE}/notes`],
      ["GET", `${BASE}/notes/abc`],
      ["PATCH", `${BASE}/notes/abc`],
      ["POST", `${BASE}/notes/abc/messages`],
      ["POST", `${BASE}/notes/bulk-delete`],
    ] as const) {
      expect(
        responseCorsHeaders(corsRequest(method, path, { origin: VIEWER_ORIGIN }), viewerContext()),
        `${method} ${path}`,
      ).toEqual(expected);
    }
  });

  it("reads the origin header case-insensitively", () => {
    expect(
      responseCorsHeaders(
        corsRequest("GET", `${BASE}/notes`, { Origin: VIEWER_ORIGIN }),
        viewerContext(),
      ),
    ).toEqual(viewerBookmarkletCors(VIEWER_ORIGIN));
  });

  it("sends nothing on every other viewer route", () => {
    for (const path of [
      `${BASE}/bundle`,
      `${BASE}/sessions`,
      `${BASE}/health`,
      `${BASE}/config`,
      `${BASE}/viewer`,
      `${BASE}/notesx`,
      `${BASE}/notifications`,
      `/notes`,
    ]) {
      expect(
        responseCorsHeaders(corsRequest("GET", path, { origin: VIEWER_ORIGIN }), viewerContext()),
        path,
      ).toEqual({});
    }
  });

  it("never reads context.cors on the viewer surface", () => {
    // `cors` belongs to the hub; a viewer context that carries one must not leak it.
    const context = viewerContext({ cors: "https://hub.example" });
    expect(
      responseCorsHeaders(corsRequest("GET", `${BASE}/bundle`, { origin: VIEWER_ORIGIN }), context),
    ).toEqual({});
  });

  it("gives an OPTIONS no header at all, even on /notes", () => {
    // The 204 comes from `viewerBookmarkletPreflight()`; the negative 405 carries no CORS header.
    const context = viewerContext({ cors: "*" });
    expect(
      responseCorsHeaders(corsRequest("OPTIONS", `${BASE}/notes`, { origin: VIEWER_ORIGIN }), context),
    ).toEqual({});
  });

  it("sends nothing without a valid Origin", () => {
    for (const origin of [undefined, "", "null", "app.example"]) {
      expect(
        responseCorsHeaders(
          corsRequest("GET", `${BASE}/notes`, origin === undefined ? {} : { origin }),
          viewerContext(),
        ),
        String(origin),
      ).toEqual({});
    }
  });
});
