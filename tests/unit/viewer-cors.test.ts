/**
 * @vitest-environment node — the pure handler and the CORS primitives; no socket, no DOM.
 *
 * The request-threading half of AC-5.21 (spec §2.5 rule 3) and the `gateRequest()` ordering
 * (spec §2.1 rules 6/11). Two properties are pinned here, and both are regressions that a
 * green-looking implementation could still have:
 *
 *   UT-30 — every `{base}/notes*` answer on the viewer surface carries the reflected `Allow-Origin`,
 *   including the errors that only exist deeper in the stack (`400 invalid_query` out of
 *   `listNotes`, `400 invalid_payload` out of a create, a `500` out of `applyMutation`'s rollback,
 *   the fail-closed `401`). No other viewer route reflects anything, and the hub answers are
 *   byte-identical to the 0.13.0 `corsHeaders(context.cors)`.
 *
 *   UT-31 — the gate order `hostRefusal → hubViewerPathRefusal (hub) → viewerSurfaceRefusal
 *   (viewer) → adminGate (hub) → unknown-path 404 → preflight → config → health → authorize` is
 *   observable: `/health` answers without a credential, `/config` and `/admin` are `404`,
 *   `/notes` without a credential is `401`, and no viewer `OPTIONS` ever reaches `authorize()`.
 *   Every negative preflight is a `405` with `Allow` and without CORS metadata.
 *
 * The request is threaded through `json`/`errorResponse`/`toErrorResponse`/`applyMutation`/
 * `listNotes`/`readNote` precisely so that a `400` raised inside a filter, or a `500` raised inside
 * a mutation rollback, still reflects the origin — the bookmarklet has to be able to *read* its own
 * input errors. That is why the assertions below go through `handleRequest()`, not just the CORS
 * primitive.
 */
import { describe, expect, it } from "vitest";

import {
  gateRequest,
  handleRequest,
  JSON_CONTENT_TYPE,
  type GateResult,
  type HandlerContext,
  type ServerRequest,
  type ServerResponse,
} from "../../server/handler";
import { corsHeaders } from "../../server/cors";
import { handleViewer, isViewerRequest } from "../../server/viewer";
import { BASE, VIEWER_ORIGIN, request, viewerContext } from "./helpers/viewer-harness";

/** A valid bookmarklet preflight asks for its own header, not just `content-type`. */
const REQUESTED_HEADERS = "content-type, x-bluepencil-viewer";

/** The two headers a bookmarklet preflight must carry (origin + requested header). */
const PREFLIGHT_HEADERS: Record<string, string> = {
  origin: VIEWER_ORIGIN,
  "access-control-request-headers": REQUESTED_HEADERS,
};

/** A configured client secret, so an authorised request can bypass the viewer's fail-closed rule. */
const SECRET = "viewer-secret-123456";

/** A valid create body — the anchor and type rules are the shared model's, not this suite's. */
const NOTE_BODY = JSON.stringify({
  type: "bug",
  body: "the cart badge is off by one",
  anchor: { selector: "#cart" },
});

function hubContext(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    store: { notes: [] },
    base: BASE,
    environment: "dev",
    // A fixed clock keeps the two `/bundle` bodies comparable.
    now: () => "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A viewer context that accepts one shared secret, for the success/error paths behind the gate. */
function authorizedViewer(): HandlerContext {
  return { ...viewerContext(), authSecret: SECRET, now: () => "2026-01-01T00:00:00.000Z" };
}

/** The response of a gate answer; the gate may only answer, never route, for the cases here. */
function responded(result: GateResult): ServerResponse {
  expect(result.kind).toBe("response");
  return (result as { kind: "response"; response: ServerResponse }).response;
}

function parsed(response: ServerResponse): { error: { code: string; message: string } } {
  return JSON.parse(response.body) as { error: { code: string; message: string } };
}

/** An authorised viewer request that also carries the bookmarklet's `Origin`. */
function viewerRequest(
  url: string,
  options: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
): ServerRequest {
  const headers: Record<string, string> = {
    origin: VIEWER_ORIGIN,
    "x-bluepencil-auth": SECRET,
    ...(options.headers ?? {}),
  };
  return {
    method: options.method ?? "GET",
    url,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  };
}

function expectReflectedOrigin(response: ServerResponse, label: string): void {
  expect(response.headers["access-control-allow-origin"], label).toBe(VIEWER_ORIGIN);
  expect(response.headers["vary"], label).toBe("Origin");
}

function expectNoCors(response: ServerResponse, label: string): void {
  expect(response.headers["access-control-allow-origin"], label).toBeUndefined();
  expect(response.headers["access-control-allow-headers"], label).toBeUndefined();
  expect(response.headers["access-control-allow-methods"], label).toBeUndefined();
}

/* ------------------------------------------------------------------------------------------------
 * UT-30 — the reflected origin reaches every {base}/notes* answer (spec §2.5 rule 3)
 * ---------------------------------------------------------------------------------------------- */

describe("UT-30 — request threading carries the reflected origin", () => {
  const viewer = authorizedViewer();

  it("reflects the origin on a successful GET /notes (200)", () => {
    const response = handleRequest(request(`${BASE}/notes`), { ...viewer, store: { notes: [] } });
    // Anonymous read on the viewer surface is fail-closed; the request helper adds no credential.
    expect(response.status).toBe(401);

    const authorised = handleRequest(viewerRequest(`${BASE}/notes`), { ...viewer, store: { notes: [] } });
    expect(authorised.status).toBe(200);
    expectReflectedOrigin(authorised, "GET /notes 200");
  });

  it("reflects the origin on a 400 invalid_query from listNotes", () => {
    const response = handleRequest(viewerRequest(`${BASE}/notes?intent=falsch`), viewer);
    expect(response.status).toBe(400);
    expect(parsed(response).error.code).toBe("invalid_query");
    expectReflectedOrigin(response, "GET /notes?intent=falsch 400");
  });

  it("reflects the origin on a 400 invalid_payload from the create path", () => {
    const response = handleRequest(
      viewerRequest(`${BASE}/notes`, {
        method: "POST",
        body: JSON.stringify({ route: "/cart" }),
        headers: { "content-type": "application/json" },
      }),
      viewer,
    );
    expect(response.status).toBe(400);
    expect(parsed(response).error.code).toBe("invalid_payload");
    expectReflectedOrigin(response, "POST /notes invalid body 400");
  });

  it("reflects the origin on a successful POST /notes (200)", () => {
    const response = handleRequest(
      viewerRequest(`${BASE}/notes`, {
        method: "POST",
        body: NOTE_BODY,
        headers: { "content-type": "application/json" },
      }),
      viewer,
    );
    expect(response.status).toBe(200);
    expectReflectedOrigin(response, "POST /notes 200");
  });

  it("reflects the origin on the fail-closed 401 without a credential", () => {
    const response = handleRequest(
      { url: `${BASE}/notes`, method: "GET", headers: { origin: VIEWER_ORIGIN } },
      viewer,
    );
    expect(response.status).toBe(401);
    expect(parsed(response).error.code).toBe("unauthorized");
    expectReflectedOrigin(response, "GET /notes 401");
  });

  it("reflects the origin on an error raised inside applyMutation's rollback (500)", () => {
    // The persist hook is called *after* the store changed; a throwing persist rolls the mutation
    // back and answers through `applyMutation`'s own `errorResponse()`.
    const failing: HandlerContext = {
      ...viewer,
      persist: () => {
        throw new Error("disk full at /var/secret/store.json");
      },
    };
    const response = handleRequest(
      viewerRequest(`${BASE}/notes`, {
        method: "POST",
        body: NOTE_BODY,
        headers: { "content-type": "application/json" },
      }),
      failing,
    );
    expect(response.status).toBe(500);
    expect(parsed(response).error.code).toBe("internal_error");
    // The body is the fixed pair, never the fs detail (SEC-09), but the header is still reflected.
    expect(response.body).not.toContain("/var/secret");
    expectReflectedOrigin(response, "POST /notes persist error 500");
  });

  it("reflects the origin on the 401 for a wrong credential", () => {
    const response = handleRequest(
      viewerRequest(`${BASE}/notes`, { headers: { "x-bluepencil-auth": "wrong" } }),
      viewer,
    );
    expect(response.status).toBe(401);
    expectReflectedOrigin(response, "GET /notes wrong credential 401");
  });

  it("does not reflect the origin on any other viewer route", () => {
    for (const path of [`${BASE}/bundle`, `${BASE}/sessions`, `${BASE}/health`]) {
      const response = handleRequest(viewerRequest(path), viewer);
      expect(response.status, path).toBe(200);
      expectNoCors(response, path);
    }
  });

  it("does not reflect the origin on a viewerSurfaceRefusal answer", () => {
    // `/config` is answered by the surface refusal before the router and must stay CORS-free.
    const response = handleRequest(viewerRequest(`${BASE}/config`), viewer);
    expect(response.status).toBe(404);
    expect(parsed(response).error.code).toBe("not_found");
    expectNoCors(response, "viewer /config 404");
  });

  it("keeps the hub /bundle status, content-type and body identical with and without Origin", () => {
    const hub = hubContext({ cors: "https://hub.example" });
    const withoutOrigin = handleRequest(request(`${BASE}/bundle`), hub);
    const withOrigin = handleRequest(
      { url: `${BASE}/bundle`, method: "GET", headers: { origin: VIEWER_ORIGIN } },
      hub,
    );

    expect(withOrigin.status).toBe(withoutOrigin.status);
    expect(withOrigin.headers["content-type"]).toBe(JSON_CONTENT_TYPE);
    expect(withOrigin.headers["content-type"]).toBe(withoutOrigin.headers["content-type"]);
    expect(withOrigin.body).toBe(withoutOrigin.body);
    // Hub CORS is unchanged: the configured value, not the caller's reflection.
    expect(withOrigin.headers["access-control-allow-origin"]).toBe("https://hub.example");
    expect(withOrigin.headers).toEqual({
      "content-type": JSON_CONTENT_TYPE,
      "cache-control": "no-store",
      ...corsHeaders("https://hub.example"),
    });
  });

  it("keeps viewer /bundle body-identical to the hub while sending no CORS", () => {
    const hub = handleRequest(request(`${BASE}/bundle`), hubContext());
    const viewer = handleRequest(viewerRequest(`${BASE}/bundle`), authorizedViewer());

    expect(viewer.status).toBe(hub.status);
    expect(viewer.headers["content-type"]).toBe(hub.headers["content-type"]);
    expect(viewer.body).toBe(hub.body);
    expectNoCors(viewer, "viewer /bundle");
  });

  it("keeps hub /health byte-identical to the 0.13.0 answer", () => {
    const response = handleRequest(request(`${BASE}/health`), hubContext({ cors: "https://hub.example" }));
    expect(response.status).toBe(200);
    expect(response.headers).toEqual({
      "content-type": JSON_CONTENT_TYPE,
      "cache-control": "no-store",
      ...corsHeaders("https://hub.example"),
    });
  });
});

/* ------------------------------------------------------------------------------------------------
 * UT-31 — gateRequest order and the viewer OPTIONS contract (spec §2.1 rules 6/11)
 * ---------------------------------------------------------------------------------------------- */

describe("UT-31 — gateRequest order on the viewer surface", () => {
  const viewer = viewerContext();

  it("answers /health with 200 before authorize(), without a credential", () => {
    const response = responded(gateRequest(request(`${BASE}/health`), viewer));
    expect(response.status).toBe(200);
    expect(parsed(response as ServerResponse)).toEqual(
      expect.objectContaining({ ok: true, status: "ok" }),
    );
  });

  it("answers /config with 404 before the public config probe", () => {
    const response = responded(gateRequest(request(`${BASE}/config`), viewer));
    expect(response.status).toBe(404);
    expect(parsed(response).error.code).toBe("not_found");
  });

  it("answers /admin with 404 even though the context carries an admin secret", () => {
    // The harness viewer context sets `adminSecret`; the surface refusal must win over `adminGate`.
    expect(viewer.adminSecret).toBeDefined();
    for (const path of [`${BASE}/admin`, `${BASE}/admin/status`]) {
      const response = responded(gateRequest(request(path), viewer));
      expect(response.status, path).toBe(404);
      expect(parsed(response).error.code).toBe("not_found");
    }
  });

  it("answers /notes without a credential with the fail-closed 401", () => {
    const response = responded(gateRequest(request(`${BASE}/notes`), viewer));
    expect(response.status).toBe(401);
    expect(parsed(response).error.code).toBe("unauthorized");
  });

  it("answers the bookmarklet preflight with 204 before authorize()", () => {
    const response = responded(
      gateRequest(
        request(`${BASE}/notes`, {
          origin: VIEWER_ORIGIN,
          "access-control-request-headers": REQUESTED_HEADERS,
        }, "OPTIONS"),
        viewer,
      ),
    );
    expect(response.status).toBe(204);
    expect(response.body).toBe("");
    expect(response.headers["access-control-allow-origin"]).toBe(VIEWER_ORIGIN);
    expect(response.headers["access-control-allow-methods"]).toBe("GET, POST, PATCH, OPTIONS");
    expect(response.headers["access-control-allow-headers"]).toContain("X-Bluepencil-Viewer");
    expect(response.headers["access-control-max-age"]).toBe("600");
    expect(response.headers["vary"]).toBe("Origin");
    expect(response.headers).not.toHaveProperty("access-control-allow-credentials");
  });

  it("answers a negative preflight with 405 Allow and no CORS — never 401", () => {
    const cases: Array<{ path: string; headers: Record<string, string>; allow: string }> = [
      // Missing the requested header: not the bookmarklet's preflight.
      { path: `${BASE}/notes`, headers: { origin: VIEWER_ORIGIN }, allow: "GET, POST" },
      // Missing the origin.
      {
        path: `${BASE}/notes`,
        headers: { "access-control-request-headers": REQUESTED_HEADERS },
        allow: "GET, POST",
      },
      // An invalid origin is not reflected either.
      {
        path: `${BASE}/notes`,
        headers: {
          origin: "https://app.example/path",
          "access-control-request-headers": REQUESTED_HEADERS,
        },
        allow: "GET, POST",
      },
      { path: `${BASE}/notes/n-1`, headers: {}, allow: "GET, PATCH" },
      { path: `${BASE}/notes/n-1/messages`, headers: {}, allow: "POST" },
      { path: `${BASE}/notes/bulk-delete`, headers: {}, allow: "POST" },
      { path: `${BASE}/bundle`, headers: {}, allow: "GET" },
      { path: `${BASE}/sessions`, headers: {}, allow: "GET" },
      { path: `${BASE}/health`, headers: {}, allow: "GET, HEAD" },
      // Even a request that mimics the bookmarklet's headers is not a notes preflight.
      { path: `${BASE}/bundle`, headers: PREFLIGHT_HEADERS, allow: "GET" },
      { path: `${BASE}/sessions`, headers: PREFLIGHT_HEADERS, allow: "GET" },
      { path: `${BASE}/health`, headers: PREFLIGHT_HEADERS, allow: "GET, HEAD" },
    ];

    for (const { path, headers, allow } of cases) {
      const response = responded(gateRequest(request(path, headers, "OPTIONS"), viewer));
      expect(response.status, `${path} ${JSON.stringify(headers)}`).toBe(405);
      expect(response.headers.allow, path).toBe(allow);
      expectNoCors(response, path);
      // A preflight carries no credential; a 401 would block the browser without protecting a note.
      expect(response.status, path).not.toBe(401);
      expect(parsed(response).error.code).toBe("method_not_allowed");
    }
  });

  it("answers OPTIONS on an unknown viewer path with 404", () => {
    const response = responded(gateRequest(request(`${BASE}/does-not-exist`, {}, "OPTIONS"), viewer));
    expect(response.status).toBe(404);
    expect(parsed(response).error.code).toBe("not_found");
  });

  it("runs hostRefusal before the public health probe", () => {
    const loopback: HandlerContext = {
      ...viewer,
      bind: { host: "127.0.0.1", port: 8788 },
    };
    const response = responded(
      gateRequest(request(`${BASE}/health`, { host: "evil.example" }), loopback),
    );
    expect(response.status).toBe(403);
    expect(parsed(response).error.code).toBe("host_not_allowed");
  });

  it("keeps hub /health public and unchanged (200 without a credential)", () => {
    const response = responded(gateRequest(request(`${BASE}/health`), hubContext()));
    expect(response.status).toBe(200);
    expect(parsed(response as ServerResponse)).toEqual(
      expect.objectContaining({ ok: true, status: "ok" }),
    );
    expectNoCors(response, "hub /health");
  });

  it("does not turn the hub's ordinary OPTIONS into a viewer preflight", () => {
    // No `--cors`: the hub keeps its 405 route answer instead of a 204 that announces the API.
    // The hub's method table sits behind its credential gate, so this is the router's answer.
    const response = handleRequest(
      request(
        `${BASE}/notes`,
        {
          origin: VIEWER_ORIGIN,
          "access-control-request-headers": REQUESTED_HEADERS,
        },
        "OPTIONS",
      ),
      hubContext(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe("GET, POST");
    expectNoCors(response, "hub OPTIONS /notes");
  });
});

describe("UT-31 — the viewer door does not swallow the gate's routes", () => {
  const viewer = viewerContext();

  it("isViewerRequest() is false for /health, /notes*, /sessions and /bundle", () => {
    for (const path of [
      `${BASE}/health`,
      `${BASE}/notes`,
      `${BASE}/notes/n-1`,
      `${BASE}/notes/n-1/messages`,
      `${BASE}/notes/bulk-delete`,
      `${BASE}/sessions`,
      `${BASE}/bundle`,
    ]) {
      expect(isViewerRequest(path, viewer), path).toBe(false);
    }
    // Not trivially false: the door's own routes still belong to it.
    expect(isViewerRequest(`${BASE}/viewer`, viewer)).toBe(true);
    expect(isViewerRequest(`${BASE}/view`, viewer)).toBe(true);
  });

  it("handleViewer() returns null for the same URLs (no 404 swallowing)", async () => {
    for (const path of [
      `${BASE}/health`,
      `${BASE}/notes`,
      `${BASE}/notes/n-1`,
      `${BASE}/sessions`,
      `${BASE}/bundle`,
    ]) {
      await expect(handleViewer(request(path), viewer), path).resolves.toBeNull();
    }
  });

  it("handleViewer() still answers its own shell route", async () => {
    const response = await handleViewer(request(`${BASE}/viewer`), viewer);
    expect(response).not.toBeNull();
    // No session in the fixture: the door refuses, and the gate would have answered 404.
    expect(response?.status).toBe(401);
  });
});
