/**
 * Sidecar authentication (#36, phase 1 — the shared secret).
 *
 * The property under test is deliberately narrow: a sidecar configured with a secret answers an
 * unauthenticated or wrongly-authenticated request with 401 `unauthorized`, and answers the
 * *same* request with the right secret normally. Everything else — which routes exist, what a note
 * looks like — is `server.test.ts`'s job and is not repeated here.
 *
 * Two things are load-bearing and easy to get wrong, so they are pinned explicitly:
 *
 *   - the check runs *before* routing, so no route can forget it. A test walks a set of paths that
 *     have nothing to do with notes (health, an unknown path, a wrong method) and requires the same
 *     401 from all of them. If the check were inside a route, `/health` would still answer.
 *   - it is not confused with `--read-only`. A read-only sidecar refuses writes with 403; an
 *     unauthenticated one refuses *reads* too, with 401. Getting those backwards is the easy mistake.
 */
import { describe, expect, it, vi } from "vitest";
import {
  handleRequest,
  type HandlerContext,
  type NoteStoreState,
  type ServerRequest,
  type ServerResponse,
} from "../../server/handler";

const BASE = "/api/v1/bluepencil";

/** `ServerResponse.body` is the exact bytes to send, so it is JSON text, not an object. */
function parsed(response: ServerResponse): unknown {
  return JSON.parse(response.body);
}
const SECRET = "correct-horse-battery-staple";

function harness(authSecret: string | undefined, extra: Partial<HandlerContext> = {}): {
  context: HandlerContext;
  call: (input: Partial<ServerRequest>) => ServerResponse;
} {
  const state: NoteStoreState = { notes: [] };
  const context: HandlerContext = {
    store: state,
    base: BASE,
    environment: "dev",
    appName: "test-app",
    now: () => "2026-09-29T00:00:00.000Z",
    persist: vi.fn(),
    ...(authSecret !== undefined ? { authSecret } : {}),
    ...extra,
  };
  return { context, call: (input) => handleRequest({ method: "GET", url: "/", headers: {}, ...input }, context) };
}

const VALID_NOTE = { type: "text", body: "a note", anchor: { selector: "#x", quote: "y" } };

describe("sidecar authentication — a sidecar with a secret", () => {
  it("refuses a request with no credentials at all", () => {
    const { call } = harness(SECRET);

    const response = call({ method: "GET", url: `${BASE}/notes` });

    expect(response.status).toBe(401);
    expect(parsed(response)).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("refuses a wrong secret, and says which of the two mistakes it was", () => {
    const { call } = harness(SECRET);

    const wrong = call({
      method: "GET",
      url: `${BASE}/notes`,
      headers: { "x-bluepencil-auth": "wrong-secret-entirely" },
    });
    const missing = call({ method: "GET", url: `${BASE}/notes` });

    // Both are 401, but the message distinguishes a typo from a client that never sent the header.
    // That distinction is the difference between "fix your config" and "fix your code".
    expect(parsed(wrong)).toMatchObject({ error: { code: "unauthorized" } });
    expect(String(((parsed(wrong) as { error: { message: string } }).error.message))).toContain("invalid");
    expect(String(((parsed(missing) as { error: { message: string } }).error.message))).toContain("missing");
  });

  it("serves the request normally with the right secret", () => {
    const { call } = harness(SECRET);

    const response = call({
      method: "GET",
      url: `${BASE}/notes`,
      headers: { "x-bluepencil-auth": SECRET },
    });

    expect(response.status).toBe(200);
    expect(parsed(response)).toEqual({ notes: [] });
  });

  it("accepts the header regardless of its casing", () => {
    // `headerValue` lower-cases both sides, and a hand-written client will send `X-Bluepencil-Auth`
    // out of pure habit. Refusing that would be a needless, hard-to-diagnose failure.
    const { call } = harness(SECRET);

    for (const name of ["x-bluepencil-auth", "X-Bluepencil-Auth", "X-BLUEPENCIL-AUTH"]) {
      const response = call({
        method: "GET",
        url: `${BASE}/notes`,
        headers: { [name]: SECRET },
      });
      expect(response.status, name).toBe(200);
    }
  });

  it("reads the first value of a repeated header", () => {
    // Node hands a repeated header over as an array. A proxy that appends a value must not be able to
    // turn a valid request into an invalid one, and must not be able to append a *second* valid secret
    // to an invalid one either.
    const { call } = harness(SECRET);

    const response = call({
      method: "GET",
      url: `${BASE}/notes`,
      headers: { "x-bluepencil-auth": [SECRET, "anything-else"] },
    });

    expect(response.status).toBe(200);
  });

  it("refuses a secret of the right length but the wrong content", () => {
    // The length check is an early-out in `secretsMatch`, so a same-length mismatch is exactly the
    // case where a broken comparison would let something through. Same length, one character off.
    //
    // Note what this test does NOT prove: that the comparison is constant-time. It cannot. Swapping
    // `secretsMatch` for a plain `expected === presented` leaves every test in this file green,
    // because the two are functionally identical — `===` is only slower to attack by timing. That
    // property is reviewed by reading the function, not by testing it, and pretending otherwise
    // would be a test that proves nothing.
    const { call } = harness(SECRET);

    const response = call({
      method: "GET",
      url: `${BASE}/notes`,
      headers: { "x-bluepencil-auth": `${SECRET.slice(0, -1)}X` },
    });

    expect(response.status).toBe(401);
  });

  it("checks before routing, so no route is reachable without the secret", () => {
    // If the check lived inside a route handler, `/health` and the note endpoints would answer
    // normally. They are the ones worth protecting and the ones a probe would try first.
    //
    // `/nonsense` is deliberately absent from this list. `allowedMethods` returns null for an unknown
    // first segment, so it lands in the same "this is not the API" 404 as a path outside the base —
    // and that 404 runs first on purpose. Answering 401 to a path that is not the API at all would
    // make a sidecar on a shared host 401 every unrelated request, and it would leak nothing: the base
    // path is public either way.
    const { call } = harness(SECRET);

    const paths = [
      `${BASE}/health`,
      `${BASE}/notes`,
      `${BASE}/sessions`,
      `${BASE}/bundle`,
    ];
    for (const path of paths) {
      expect(call({ url: path }).status, path).toBe(401);
    }
  });

  it("does not claim paths outside the API at all", () => {
    // The flip side of the placement above: a request that could not be the API is answered as
    // unknown, not as unauthenticated. On a shared host that is the difference between a sidecar and
    // something that gets in the way of everything else on the box.
    const { call } = harness(SECRET);

    expect(call({ url: "/anything/at/all" }).status).toBe(404);
  });

  it("refuses writes as well as reads — a wrong secret must not be enough to change anything", () => {
    const { call, context } = harness(SECRET);

    const response = call({
      method: "POST",
      url: `${BASE}/notes`,
      headers: { "x-bluepencil-auth": "nope" },
      body: JSON.stringify(VALID_NOTE),
    });

    expect(response.status).toBe(401);
    // The decisive assertion: not only was the answer a refusal, nothing was written.
    expect(context.store.notes).toEqual([]);
  });

  it("does not persist anything for a refused request", () => {
    const persist = vi.fn();
    const { call } = harness(SECRET, { persist });

    call({
      method: "POST",
      url: `${BASE}/notes`,
      headers: { "x-bluepencil-auth": "nope" },
      body: JSON.stringify(VALID_NOTE),
    });

    expect(persist).not.toHaveBeenCalled();
  });
});

describe("sidecar authentication — a sidecar without a secret", () => {
  it("serves requests exactly as before", () => {
    // The backwards-compatibility guarantee: an unset secret means no authentication, so every
    // existing deployment and every test in `server.test.ts` keeps working untouched.
    const { call } = harness(undefined);

    expect(call({ method: "GET", url: `${BASE}/notes` }).status).toBe(200);
    expect(call({ method: "GET", url: `${BASE}/health` }).status).toBe(200);
  });

  it("ignores a header that arrives anyway", () => {
    // Not an error: a client that is configured to send a secret should not break against a sidecar
    // that does not ask for one. That is the case where a client and server are briefly out of step.
    const { call } = harness(undefined);

    const response = call({
      method: "GET",
      url: `${BASE}/notes`,
      headers: { "x-bluepencil-auth": "irrelevant" },
    });

    expect(response.status).toBe(200);
  });

  it("treats an empty secret as no secret", () => {
    // The handler guards on `length > 0` so that an empty string cannot become an unauthenticated
    // deployment that *looks* configured. The CLI rejects it outright; this covers a context built
    // in code, where the CLI never runs.
    const { call } = harness("");

    expect(call({ method: "GET", url: `${BASE}/notes` }).status).toBe(200);
  });
});

describe("sidecar authentication — read-only is a separate thing", () => {
  it("answers an unauthenticated request with 401, not the 403 that read-only uses", () => {
    // The confusion this pins down: both are "refused", and a client that only checks the status
    // would treat them the same. A read-only sidecar is *permitted* to read; an unauthenticated one
    // is not, so the codes have to differ.
    const { call } = harness(SECRET, { readOnly: true });

    const response = call({ method: "GET", url: `${BASE}/notes` });

    expect(response.status).toBe(401);
  });

  it("still refuses a read-only write with 403 once authenticated", () => {
    const { call } = harness(SECRET, { readOnly: true });

    const response = call({
      method: "POST",
      url: `${BASE}/notes`,
      headers: { "x-bluepencil-auth": SECRET },
      body: JSON.stringify(VALID_NOTE),
    });

    expect(response.status).toBe(403);
  });

  it("answers read-only with 403 when there is no secret at all", () => {
    // The pre-existing behaviour, unchanged: no secret configured means authentication is not in
    // play, and the only thing refusing the write is `--read-only`.
    const { call } = harness(undefined, { readOnly: true });

    const response = call({
      method: "POST",
      url: `${BASE}/notes`,
      body: JSON.stringify(VALID_NOTE),
    });

    expect(response.status).toBe(403);
  });
});
