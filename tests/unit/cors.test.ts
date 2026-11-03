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
} from "../../server/cors";
import {
  DEFAULT_BASE_PATH,
  handleRequest,
  type HandlerContext,
  type ServerResponse,
} from "../../server/handler";

const BASE = DEFAULT_BASE_PATH;
const SHARED = "cors-test-shared-value";

function handlerContext(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    store: { notes: [] },
    base: BASE,
    environment: "dev",
    readOnly: false,
    persist: () => undefined,
    ...overrides,
  };
}

function options(path: string, overrides: Partial<HandlerContext> = {}): ServerResponse {
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
