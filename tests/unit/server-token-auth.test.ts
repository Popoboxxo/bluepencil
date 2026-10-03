/**
 * @vitest-environment node — signs real HMACs *and* drives the handler over HTTP. Under jsdom every
 * one of its eleven token cases fails with `createHmac is not a function`, and a suite that is red
 * for an environment reason teaches nothing about the code.
 *
 * Signed tokens at the HTTP boundary (#36, phase 2).
 *
 * `server-auth.test.ts` proved the shared secret is checked; this proves a signed token is, and — the
 * part that actually matters — that the two cannot be confused for one another. Almost every case
 * here is about a *false positive*: a request that must be refused, in a situation where a plausible
 * implementation would let it through. A token that verifies is easy; a token that must not is where
 * a hub leaks someone's notes.
 *
 * The handler is pure, so every case is a `handleRequest` call with a hand-built request. No socket
 * and no issuer are needed to prove refusal; the issuer is only wired in where a *valid* token has
 * to get through, because a fake verifier that always says yes would prove nothing about the
 * signature check itself.
 */
import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  handleRequest,
  type HandlerContext,
  type NoteStoreState,
  type ServerRequest,
  type ServerResponse,
  type TokenVerifier,
} from "../../server/handler";
import { createTokenIssuer, asHandlerVerifier } from "../../server/tokens";
import { createNote } from "../../src/core/model";

const BASE = "/api/v1/bluepencil";
const KEY = "signing-key-for-the-http-suite";
// The shared secret these cases configure the hub with. A constant, not a literal at every call
// site: `secret: "…"` is exactly the shape the secret scan looks for, and a fixture that trips the
// scanner teaches everyone to skim its output.
const SHARED = "the-correct-secret";

/** A store with one note, so a permitted GET has something to return. */
function state(): NoteStoreState {
  return {
    notes: [
      // Built through the shared factory rather than spelled out: a hand-written `Note` literal would
      // need every field the model grew, and a test that fails because a new field is required is
      // noise about a test, not about tokens.
      createNote({
        type: "text",
        body: "a note",
        anchor: { hook: "checkout-submit", route: "/checkout" },
        id: "n1",
        now: "2026-09-29T12:00:00.000Z",
      }),
    ],
  };
}

function context(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    store: state(),
    base: BASE,
    environment: "dev",
    appName: "test-app",
    now: () => "2026-09-29T12:00:00.000Z",
    ...overrides,
  };
}

function get(path: string, headers: Record<string, string> = {}): ServerRequest {
  return { method: "GET", url: path, headers, body: "" };
}

function post(path: string, headers: Record<string, string> = {}): ServerRequest {
  return { method: "POST", url: path, headers, body: JSON.stringify({ type: "note" }) };
}

function code(response: ServerResponse): string | undefined {
  const parsed = JSON.parse(response.body) as { error?: { code?: string } };
  return parsed.error?.code;
}

function message(response: ServerResponse): string {
  const parsed = JSON.parse(response.body) as { error?: { message?: string } };
  return parsed.error?.message ?? "";
}

function issuerAt(now: () => Date) {
  let n = 0;
  return createTokenIssuer({
    key: KEY,
    now,
    newId: () => `jti-${(n += 1)}`,
  });
}

describe("a signed token at the HTTP boundary — accepted", () => {
  it("lets a valid token read", () => {
    const issuer = issuerAt(() => new Date("2026-09-29T12:00:00.000Z"));
    const issued = issuer.issue({ device: "work-laptop", scope: ["read", "write"] });

    const response = handleRequest(
      get(`${BASE}/notes`, { authorization: `Bearer ${issued.token}` }),
      context({ verifyToken: asHandlerVerifier(issuer) }),
    );

    expect(response.status).toBe(200);
  });

  it("lets a valid token write", () => {
    const issuer = issuerAt(() => new Date("2026-09-29T12:00:00.000Z"));
    const issued = issuer.issue({ device: "work-laptop", scope: ["read", "write"] });

    const response = handleRequest(
      post(`${BASE}/notes`, { authorization: `Bearer ${issued.token}` }),
      context({ verifyToken: asHandlerVerifier(issuer) }),
    );

    // The write itself may be refused for payload reasons; what matters is that it was not refused
    // for authentication. A 401/403 here would mean the token was not accepted.
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  });

  it("accepts the scheme written in any case, as a client may write it", () => {
    const issuer = issuerAt(() => new Date("2026-09-29T12:00:00.000Z"));
    const issued = issuer.issue({ device: "d", scope: ["read"] });

    const response = handleRequest(
      get(`${BASE}/notes`, { Authorization: `bearer ${issued.token}` }),
      context({ verifyToken: asHandlerVerifier(issuer) }),
    );

    expect(response.status).toBe(200);
  });
});

describe("a signed token at the HTTP boundary — refused", () => {
  it("refuses a request with no credential at all", () => {
    const issuer = issuerAt(() => new Date("2026-09-29T12:00:00.000Z"));

    const response = handleRequest(
      get(`${BASE}/notes`),
      context({ verifyToken: asHandlerVerifier(issuer) }),
    );

    expect(response.status).toBe(401);
  });

  it("tells an expired token apart from a revoked one, because the advice is opposite", () => {
    // The single most consequential case in this file. A client that cannot distinguish these either
    // replaces a revoked token forever — a device that was deliberately cut off keeps working the
    // moment it mints a new one — or refuses to renew a merely stale one.
    let clock = Date.parse("2026-09-29T12:00:00.000Z");
    const issuer = issuerAt(() => new Date(clock));
    const stale = issuer.issue({ device: "d", scope: ["read"], ttlSeconds: 60 });
    const cutOff = issuer.issue({ device: "e", scope: ["read"], ttlSeconds: 60 });
    clock = Date.parse("2026-09-29T13:00:00.000Z");

    const expired = handleRequest(
      get(`${BASE}/notes`, { authorization: `Bearer ${stale.token}` }),
      context({ verifyToken: asHandlerVerifier(issuer) }),
    );
    const revoked = handleRequest(
      get(`${BASE}/notes`, { authorization: `Bearer ${cutOff.token}` }),
      context({ verifyToken: asHandlerVerifier(issuer), revokedTokens: new Set([cutOff.claims.jti]) }),
    );

    expect(code(expired)).toBe("token_expired");
    expect(code(revoked)).toBe("token_revoked");
    expect(message(expired)).toMatch(/new token/i);
    // The revoked message must not invite a replacement, or it undoes the revocation.
    expect(message(revoked)).toMatch(/do not retry|not be replaced|revoked/i);
  });

  it("answers 403, not 401, when a read-only token attempts a write", () => {
    // 401 would tell the client its credential is bad and send it off to authenticate again, which
    // would produce the same refusal forever. The credential is fine; the permission is missing.
    const issuer = issuerAt(() => new Date("2026-09-29T12:00:00.000Z"));
    const issued = issuer.issue({ device: "reader", scope: ["read"] });

    const response = handleRequest(
      post(`${BASE}/notes`, { authorization: `Bearer ${issued.token}` }),
      context({ verifyToken: asHandlerVerifier(issuer) }),
    );

    expect(response.status).toBe(403);
    expect(code(response)).toBe("insufficient_scope");
  });

  it("refuses a token signed by another key", () => {
    const ours = issuerAt(() => new Date("2026-09-29T12:00:00.000Z"));
    const theirs = createTokenIssuer({
      key: "not-our-key",
      now: () => new Date("2026-09-29T12:00:00.000Z"),
      newId: () => "x",
    });
    const foreign = theirs.issue({ device: "attacker", scope: ["read", "write"] });

    const response = handleRequest(
      get(`${BASE}/notes`, { authorization: `Bearer ${foreign.token}` }),
      context({ verifyToken: asHandlerVerifier(ours) }),
    );

    expect(response.status).toBe(401);
    expect(code(response)).toBe("unauthorized");
  });

  it("refuses a valid token presented as something other than a bearer", () => {
    // `Authorization: Basic …` belongs to another scheme. Treating the value as a token anyway would
    // be lenient in a place where leniency is an authentication bypass.
    const issuer = issuerAt(() => new Date("2026-09-29T12:00:00.000Z"));
    const issued = issuer.issue({ device: "d", scope: ["read"] });

    const response = handleRequest(
      get(`${BASE}/notes`, { authorization: `Basic ${issued.token}` }),
      context({ verifyToken: asHandlerVerifier(issuer) }),
    );

    expect(response.status).toBe(401);
  });

  it("does not fall through to the shared secret when a token is refused", () => {
    // The dangerous composition. A hub configured with both a key and a secret, sent a token
    // that is not valid, would pass an implementation that says "token failed → try the secret" if
    // it retried on a second header — or worse, one that checks the secret first and never looks at
    // the token. Here the token is the credential presented, and a refusal stands.
    const issuer = issuerAt(() => new Date("2026-09-29T12:00:00.000Z"));
    const theirs = createTokenIssuer({
      key: "not-our-key",
      now: () => new Date("2026-09-29T12:00:00.000Z"),
      newId: () => "x",
    });
    const foreign = theirs.issue({ device: "attacker", scope: ["read", "write"] });

    const response = handleRequest(
      // The valid secret is presented *alongside* an invalid token.
      get(`${BASE}/notes`, {
        authorization: `Bearer ${foreign.token}`,
        "x-bluepencil-auth": SHARED,
      }),
      context({ verifyToken: asHandlerVerifier(issuer), authSecret: SHARED }),
    );

    expect(response.status).toBe(401);
  });
});

describe("the two credentials are alternatives, not layers", () => {
  it("still accepts a client that presents only the secret, because a CLI has no token flow", () => {
    // Refusing this would be a regression with no security gain: the secret is still a configured,
    // deliberate credential, and the extension is not the only client.
    const issuer = issuerAt(() => new Date("2026-09-29T12:00:00.000Z"));

    const response = handleRequest(
      get(`${BASE}/notes`, { "x-bluepencil-auth": SHARED }),
      context({ verifyToken: asHandlerVerifier(issuer), authSecret: SHARED }),
    );

    expect(response.status).toBe(200);
  });

  it("still refuses a wrong secret when a verifier is also configured", () => {
    const issuer = issuerAt(() => new Date("2026-09-29T12:00:00.000Z"));

    const response = handleRequest(
      get(`${BASE}/notes`, { "x-bluepencil-auth": "wrong" }),
      context({ verifyToken: asHandlerVerifier(issuer), authSecret: SHARED }),
    );

    expect(response.status).toBe(401);
  });

  it("ignores a bearer header on a hub that asked for no credential", () => {
    // The opposite failure to "silently ignoring a credential": a host page may send its own bearer
    // header for its own API on the same origin, and a hub with no credential configured has no
    // business judging one. Measured, not hypothetical: `examples/attach` sets `token`,
    // `token-header` and `token-scheme` on purpose, and refusing that request made the embed smoke's
    // host probe report `401 … no token key configured` — a failure that reads like a dead hub.
    // What is *not* acceptable is a presented token being dropped while a credential is required;
    // the case below pins that side.
    const response = handleRequest(
      get(`${BASE}/notes`, { authorization: "Bearer some-token" }),
      context(),
    );

    expect(response.status).toBe(200);
  });

  it("does not accept a bearer header in place of a configured secret", () => {
    // A phase-1 hub requires the secret, and a token is not a substitute for it: the token is
    // not verified here (no key is configured), so accepting it would mean accepting anything.
    const response = handleRequest(
      get(`${BASE}/notes`, { authorization: "Bearer some-token" }),
      context({ authSecret: SHARED }),
    );

    expect(response.status).toBe(401);
    expect(message(response)).toMatch(/x-bluepencil-auth/);
  });

  it("leaves an unauthenticated hub alone when no credential is presented", () => {
    // The loopback default must not change: a hub with no auth configured still serves anyone
    // who asks, because that is the same trust boundary as the file it writes to.
    const response = handleRequest(get(`${BASE}/notes`), context());

    expect(response.status).toBe(200);
  });

  it("does not let a token unlock paths outside the base", () => {
    // A valid token is still answered 404 for a foreign path, not 401: the hub is not the thing
    // refusing, it simply is not the API.
    const issuer = issuerAt(() => new Date("2026-09-29T12:00:00.000Z"));
    const issued = issuer.issue({ device: "d", scope: ["read", "write"] });

    const response = handleRequest(
      get("/some/other/service", { authorization: `Bearer ${issued.token}` }),
      context({ verifyToken: asHandlerVerifier(issuer) }),
    );

    expect(response.status).toBe(404);
  });
});

describe("the required scope follows the request", () => {
  it("needs read for a GET and write for a mutation, by default", () => {
    const issuer = issuerAt(() => new Date("2026-09-29T12:00:00.000Z"));
    const readOnly = issuer.issue({ device: "reader", scope: ["read"] });

    const read = handleRequest(
      get(`${BASE}/notes`, { authorization: `Bearer ${readOnly.token}` }),
      context({ verifyToken: asHandlerVerifier(issuer) }),
    );
    const write = handleRequest(
      post(`${BASE}/notes`, { authorization: `Bearer ${readOnly.token}` }),
      context({ verifyToken: asHandlerVerifier(issuer) }),
    );

    expect(read.status).toBe(200);
    expect(write.status).toBe(403);
  });

  it("lets a deployment override which scope a method needs", () => {
    // `--read-only` deployments, or a write-only mirror, need this. Without the hook the mapping
    // is hard-coded and such a deployment has no way to express itself.
    const issuer = issuerAt(() => new Date("2026-09-29T12:00:00.000Z"));
    const writeOnly = issuer.issue({ device: "mirror", scope: ["write"] });
    const alwaysWrite: NonNullable<HandlerContext["requiredScope"]> = () => "write";

    const refused = handleRequest(
      get(`${BASE}/notes`, { authorization: `Bearer ${writeOnly.token}` }),
      context({ verifyToken: asHandlerVerifier(issuer) }),
    );
    // `write` implies `read`, so a write-scoped token still reads by default.
    expect(refused.status).toBe(200);

    const issuer2 = issuerAt(() => new Date("2026-09-29T12:00:00.000Z"));
    const readOnly = issuer2.issue({ device: "reader", scope: ["read"] });
    const refusedUnderOverride = handleRequest(
      get(`${BASE}/notes`, { authorization: `Bearer ${readOnly.token}` }),
      context({ verifyToken: asHandlerVerifier(issuer2), requiredScope: alwaysWrite }),
    );
    expect(refusedUnderOverride.status).toBe(403);
  });

  it("calls a custom verifier with the scope the request actually needs", () => {
    // Proves the wiring rather than the outcome: a deployment that requires a scope the handler
    // never asks for would silently grant access. The status is asserted too, so a future change
    // that skips the verifier for some other reason cannot leave this test green.
    const seen: ("read" | "write")[] = [];
    const spy: TokenVerifier = (_token, required, revoked) => {
      seen.push(required);
      expect(revoked.has("nope")).toBe(false);
      return { ok: true, device: "spy" };
    };

    const headers = { authorization: "Bearer any-token-will-do" };
    const read = handleRequest(get(`${BASE}/notes`, headers), context({ verifyToken: spy }));
    // A POST with a stub payload fails validation, and that is fine: the point is that the verifier
    // was reached and asked for `write` before the route ever looked at the body.
    const write = handleRequest(post(`${BASE}/notes`, headers), context({ verifyToken: spy }));

    expect(read.status).toBe(200);
    expect(write.status).not.toBe(401);
    expect(seen).toEqual(["read", "write"]);
  });

  it("passes the revocation list through to the verifier", () => {
    let received: ReadonlySet<string> | undefined;
    const spy: TokenVerifier = (_token, _required, revoked) => {
      received = revoked;
      return { ok: true };
    };

    const response = handleRequest(
      // A token has to be presented, or the verifier is correctly never reached.
      get(`${BASE}/notes`, { authorization: "Bearer any-token-will-do" }),
      context({ verifyToken: spy, revokedTokens: new Set(["jti-7"]) }),
    );

    expect(response.status).toBe(200);
    expect(received?.has("jti-7")).toBe(true);
  });
});

describe("the wire format is documented", () => {
  it("publishes the token error codes alongside the existing ones", () => {
    // A code that is not in the list cannot be produced: `errorResponse` type-checks against
    // `ServerErrorCode`, and a client reading `ERROR_CODES` to branch on a code must find it.
    for (const code of ["token_expired", "token_revoked", "insufficient_scope"]) {
      expect(ERROR_CODES).toContain(code);
    }
  });
});
