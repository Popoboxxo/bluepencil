/**
 * The worker's hub relay (#116) — every security rule, one test each.
 *
 * The relay is the extension's trust boundary: any page script can post a `kind:"fetch"` envelope,
 * so what matters is not "it forwards" but "it refuses". Each refusal is asserted by its named code
 * (not by prose) so a caller and this suite agree on *why*. The forged-envelope cases are the same
 * ones `extension/smoke.mjs` drives in a real Chromium.
 *
 * The module is DOM- and `chrome.*`-free by design; `fetch` is injected here, which is what makes
 * the transport options (`credentials`, `cache`, `redirect`, `referrerPolicy`) assertable at all.
 */
import { describe, expect, it } from "vitest";

import {
  HUB_FETCH_HEADERS,
  HUB_FETCH_LIMITS,
  HUB_FETCH_METHODS,
  PAGE_FETCH_KIND,
  hubFetchPolicy,
  replyToResponse,
  runHubRequest,
  validateHubRequest,
  type HubFetchPolicy,
  type HubFetchRequest,
  type HubFetchReply,
} from "../../extension/src/hub-fetch";

const BASE = "http://127.0.0.1:8787/api/v1/bluepencil";
const POLICY = hubFetchPolicy(BASE);

interface Call {
  url: string;
  init: RequestInit;
}

/** A `fetch` whose calls are recorded and whose answer is supplied per test. */
function stubFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    const requestInit = init ?? {};
    calls.push({ url, init: requestInit });
    return handler(url, requestInit);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Validate a minimal request and fail the test with the code when it was refused. */
function request(overrides: Partial<Record<string, unknown>> = {}): HubFetchRequest {
  const result = validateHubRequest({ method: "GET", url: `${BASE}/notes`, headers: {}, ...overrides }, POLICY);
  if (!result.ok) {
    throw new Error(`expected a valid request, got ${result.error.code}: ${result.error.message}`);
  }
  return result.request;
}

function refusal(raw: unknown, policy: HubFetchPolicy = POLICY) {
  const result = validateHubRequest(raw, policy);
  if (result.ok) throw new Error("expected the relay to refuse the request");
  return result.error;
}

/* ------------------------------------------------------------------------------------------------
 * Target: the configured origin and base path, and two explicit denies
 * ---------------------------------------------------------------------------------------------- */

describe("hub relay — target allowlist", () => {
  it("allows the configured base and the paths below it", () => {
    for (const url of [`${BASE}`, `${BASE}/notes`, `${BASE}/notes/n-1/messages`, `${BASE}/health`]) {
      expect(validateHubRequest({ method: "GET", url, headers: {} }, POLICY).ok).toBe(true);
    }
  });

  it("rejects a cross-origin target", () => {
    expect(refusal({ method: "GET", url: "http://127.0.0.1:9999/api/v1/bluepencil/notes", headers: {} }))
      .toMatchObject({ code: "disallowed_target" });
    expect(refusal({ method: "GET", url: "https://example.com/api/v1/bluepencil/notes", headers: {} }))
      .toMatchObject({ code: "disallowed_target" });
  });

  it("rejects a path outside the configured base", () => {
    expect(refusal({ method: "GET", url: "http://127.0.0.1:8787/", headers: {} }))
      .toMatchObject({ code: "disallowed_target" });
    expect(refusal({ method: "GET", url: "http://127.0.0.1:8787/notes", headers: {} }))
      .toMatchObject({ code: "disallowed_target" });
  });

  it("rejects a prefix look-alike", () => {
    expect(refusal({ method: "GET", url: `${BASE}X/notes`, headers: {} }))
      .toMatchObject({ code: "disallowed_target" });
  });

  it("rejects the admin surface under the base", () => {
    for (const url of [`${BASE}/admin`, `${BASE}/admin/`, `${BASE}/admin/devices`]) {
      expect(refusal({ method: "GET", url, headers: {} })).toMatchObject({ code: "disallowed_target" });
    }
  });

  it("rejects an encoded separator or dot that could normalise into another path", () => {
    for (const path of ["%2e%2e/admin", "notes%2f..%2fadmin", "notes%5c..%5cadmin"]) {
      expect(refusal({ method: "GET", url: `${BASE}/${path}`, headers: {} }))
        .toMatchObject({ code: "disallowed_target" });
    }
  });

  it("rejects any percent-encoded admin spelling (CR-116-02)", () => {
    // The hub decodes the path, so `%61dmin` is `/admin` to it while a literal segment check only
    // sees `%61dmin`. Every `%` is refused, which is what makes the deny rule say what it means.
    for (const path of [
      "%61dmin",
      "ad%6din",
      "adm%69n",
      "%EF%BD%81dmin",
      "%61dmin/devices",
      "%252e%252e/admin",
      "notes%00",
    ]) {
      expect(refusal({ method: "GET", url: `${BASE}/${path}`, headers: {} }))
        .toMatchObject({ code: "disallowed_target" });
    }
  });

  it("rejects URL forms that must stay fail-closed", () => {
    for (const url of [
      "//127.0.0.1:8787/api/v1/bluepencil/notes", // scheme-relative
      "http://127.0.0.1:8787\\.evil.example/api/v1/bluepencil/notes", // backslash normalisation
      "http://[::1]:8787/api/v1/bluepencil/notes", // IPv6 literal against an IPv4 base
      "http://hub.example/api/v1/bluepencil/notes", // different host
    ]) {
      expect(refusal({ method: "GET", url, headers: {} })).toMatchObject({
        code: "disallowed_target",
      });
    }
  });

  it("rejects file:, javascript:, data: and chrome-extension: targets", () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/plain,hi",
      "chrome-extension://abcdef/notes",
    ]) {
      expect(refusal({ method: "GET", url, headers: {} })).toMatchObject({ code: "disallowed_target" });
    }
  });

  it("rejects userinfo in the URL", () => {
    expect(
      refusal({ method: "GET", url: "http://user:pass@127.0.0.1:8787/api/v1/bluepencil/notes", headers: {} }),
    ).toMatchObject({ code: "disallowed_target" });
  });

  it("rejects a fragment", () => {
    expect(refusal({ method: "GET", url: `${BASE}/notes#admin`, headers: {} }))
      .toMatchObject({ code: "disallowed_target" });
  });

  it("treats a bare-origin endpoint as the whole origin but still denies /admin", () => {
    const originPolicy = hubFetchPolicy("http://127.0.0.1:8787");
    expect(validateHubRequest({ method: "GET", url: "http://127.0.0.1:8787/notes", headers: {} }, originPolicy).ok)
      .toBe(true);
    expect(refusal({ method: "GET", url: "http://127.0.0.1:8787/admin", headers: {} }, originPolicy))
      .toMatchObject({ code: "disallowed_target" });
  });

  it("reports an unusable configured endpoint instead of guessing", () => {
    const broken = hubFetchPolicy("not a url");
    expect(refusal({ method: "GET", url: `${BASE}/notes`, headers: {} }, broken))
      .toMatchObject({ code: "disallowed_target" });
  });
});

/* ------------------------------------------------------------------------------------------------
 * Methods: GET, POST, PATCH only
 * ---------------------------------------------------------------------------------------------- */

describe("hub relay — method allowlist", () => {
  it("allows GET, POST and PATCH", () => {
    expect([...HUB_FETCH_METHODS]).toEqual(["GET", "POST", "PATCH"]);
    for (const method of HUB_FETCH_METHODS) {
      const body = method === "GET" ? {} : { body: "{}" };
      expect(validateHubRequest({ method, url: `${BASE}/notes`, headers: {}, ...body }, POLICY).ok).toBe(true);
    }
  });

  it("rejects DELETE, HEAD, OPTIONS, TRACE and CONNECT", () => {
    for (const method of ["DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT", "get", "PUT"]) {
      expect(refusal({ method, url: `${BASE}/notes`, headers: {} }))
        .toMatchObject({ code: "disallowed_method" });
    }
  });

  it("rejects a request without a method", () => {
    expect(refusal({ url: `${BASE}/notes`, headers: {} })).toMatchObject({ code: "invalid_request" });
  });
});

/* ------------------------------------------------------------------------------------------------
 * Headers: four names, no CR/LF, bounded
 * ---------------------------------------------------------------------------------------------- */

describe("hub relay — header allowlist", () => {
  it("forwards only the allowlisted headers, lowercased", () => {
    expect([...HUB_FETCH_HEADERS]).toEqual([
      "accept",
      "content-type",
      "authorization",
      "x-bluepencil-auth",
    ]);
    const accepted = request({
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: "Bearer t",
        "X-Bluepencil-Auth": "s",
      },
    });
    expect(accepted.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      authorization: "Bearer t",
      "x-bluepencil-auth": "s",
    });
  });

  it("rejects cookie, origin, referer and x-bluepencil-admin", () => {
    for (const name of ["cookie", "origin", "referer", "x-bluepencil-admin", "x-forwarded-for"]) {
      expect(refusal({ method: "GET", url: `${BASE}/notes`, headers: { [name]: "x" } }))
        .toMatchObject({ code: "disallowed_header" });
    }
  });

  it("rejects CR or LF in a header name or value", () => {
    expect(
      refusal({ method: "GET", url: `${BASE}/notes`, headers: { authorization: "Bearer ok\r\nX-Evil: 1" } }),
    ).toMatchObject({ code: "disallowed_header" });
    expect(
      refusal({ method: "GET", url: `${BASE}/notes`, headers: { "accept\r\nX-Evil": "x" } }),
    ).toMatchObject({ code: "disallowed_header" });
  });

  it("rejects more than eight headers, a duplicate name and a non-string value", () => {
    // Case variants are distinct object keys, so nine of them really are nine entries.
    const nine: Record<string, string> = {};
    for (let index = 0; index < 9; index += 1) {
      nine[`Authorization${"a".repeat(index)}`] = "x";
    }
    expect(refusal({ method: "GET", url: `${BASE}/notes`, headers: nine })).toMatchObject({
      code: "disallowed_header",
    });
    expect(
      refusal({ method: "GET", url: `${BASE}/notes`, headers: { accept: "a", ACCEPT: "b" } }),
    ).toMatchObject({ code: "disallowed_header" });
    expect(refusal({ method: "GET", url: `${BASE}/notes`, headers: { accept: 1 } }))
      .toMatchObject({ code: "invalid_request" });
  });

  it("rejects a header value over 4 KiB", () => {
    expect(
      refusal({ method: "GET", url: `${BASE}/notes`, headers: { authorization: `Bearer ${"a".repeat(5000)}` } }),
    ).toMatchObject({ code: "disallowed_header" });
  });
});

/* ------------------------------------------------------------------------------------------------
 * Sizes and bodies
 * ---------------------------------------------------------------------------------------------- */

describe("hub relay — budgets", () => {
  it("pins the production budgets at 30 s, 1 MiB and 8 MiB", () => {
    expect(HUB_FETCH_LIMITS).toEqual({
      timeoutMs: 30_000,
      maxRequestBodyBytes: 1024 * 1024,
      maxResponseBodyBytes: 8 * 1024 * 1024,
    });
  });

  it("rejects an oversized request body with its size and without its content", () => {
    const small: HubFetchPolicy = { ...POLICY, maxRequestBodyBytes: 32 };
    const error = refusal(
      { method: "POST", url: `${BASE}/notes`, headers: {}, body: `{"body":"${"x".repeat(64)}"}` },
      small,
    );
    expect(error.code).toBe("payload_too_large");
    expect(error.message).toMatch(/\d+ bytes/);
    expect(error.message).not.toContain("xxxxxxxx");
  });

  it("rejects an oversized response by its declared length, before reading it", async () => {
    const { fetchImpl, calls } = stubFetch(
      () => new Response("[]", { headers: { "content-length": "99999999" } }),
    );
    const reply = await runHubRequest(request(), { ...POLICY, maxResponseBodyBytes: 64 }, { fetchImpl });
    expect(reply).toMatchObject({ ok: false, error: { code: "payload_too_large" } });
    expect(calls).toHaveLength(1);
  });

  it("rejects an oversized response body when no length was declared", async () => {
    const { fetchImpl } = stubFetch(() => new Response("x".repeat(200)));
    const reply = await runHubRequest(request(), { ...POLICY, maxResponseBodyBytes: 64 }, { fetchImpl });
    expect(reply).toMatchObject({ ok: false, error: { code: "payload_too_large" } });
  });

  it("rejects a body on a GET request", () => {
    expect(refusal({ method: "GET", url: `${BASE}/notes`, headers: {}, body: "{}" }))
      .toMatchObject({ code: "invalid_request" });
  });
});

/* ------------------------------------------------------------------------------------------------
 * The fetch itself: no ambient state, no redirects, a bounded wait
 * ---------------------------------------------------------------------------------------------- */

describe("hub relay — transport", () => {
  it("sets omit/no-store/no-referrer/manual and forwards the allowlisted request", async () => {
    const { fetchImpl, calls } = stubFetch(
      () => new Response(JSON.stringify({ notes: [] }), { status: 201, headers: { "content-type": "application/json" } }),
    );
    const reply = await runHubRequest(
      request({
        method: "POST",
        url: `${BASE}/notes`,
        headers: { "content-type": "application/json", "x-bluepencil-auth": "secret-value" },
        body: '{"body":"hi"}',
      }),
      POLICY,
      { fetchImpl },
    );

    expect(reply).toMatchObject({ ok: true, status: 201, body: '{"notes":[]}' });
    const call = calls[0];
    expect(call?.url).toBe(`${BASE}/notes`);
    expect(call?.init).toMatchObject({
      method: "POST",
      body: '{"body":"hi"}',
      credentials: "omit",
      cache: "no-store",
      redirect: "manual",
      referrerPolicy: "no-referrer",
    });
    expect(call?.init.headers).toEqual({
      "content-type": "application/json",
      "x-bluepencil-auth": "secret-value",
    });
  });

  it("aborts and reports timeout", async () => {
    const { fetchImpl } = stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    const reply = await runHubRequest(request(), { ...POLICY, timeoutMs: 10 }, { fetchImpl });
    expect(reply).toMatchObject({ ok: false, error: { code: "timeout" } });
  });

  it("rejects a redirect without a second request", async () => {
    const { fetchImpl, calls } = stubFetch(
      () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
    );
    const reply = await runHubRequest(request(), POLICY, { fetchImpl });
    expect(reply).toMatchObject({ ok: false, error: { code: "redirect_not_allowed" } });
    expect(calls).toHaveLength(1);
  });

  it("rejects an opaque redirect as well", async () => {
    const opaque = { status: 0, type: "opaqueredirect", headers: new Headers(), statusText: "" } as Response;
    const { fetchImpl } = stubFetch(() => opaque);
    const reply = await runHubRequest(request(), POLICY, { fetchImpl });
    expect(reply).toMatchObject({ ok: false, error: { code: "redirect_not_allowed" } });
  });

  it("returns a 401 or 500 as a normal response, not a transport error", async () => {
    for (const status of [401, 500]) {
      const { fetchImpl } = stubFetch(
        () => new Response(JSON.stringify({ ok: false }), { status, statusText: String(status) }),
      );
      const reply = await runHubRequest(request(), POLICY, { fetchImpl });
      expect(reply).toMatchObject({ ok: true, status, body: '{"ok":false}' });
    }
  });

  it("refuses an unvalidated request shape instead of trusting its type (CR-116-07)", async () => {
    const { fetchImpl, calls } = stubFetch(() => new Response("{}"));
    const reply = await runHubRequest(
      { method: "GET" } as unknown as HubFetchRequest,
      POLICY,
      { fetchImpl },
    );
    expect(reply).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(calls).toHaveLength(0);
  });

  it("never resolves a refused request", async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    const reply = await runHubRequest(request(), POLICY, { fetchImpl });
    expect(reply).toMatchObject({ ok: false, error: { code: "network" } });
    expect(reply.ok).toBe(false);
  });

  it("error messages never contain header values or query strings", async () => {
    const credentialValue = "s3cr3t-token-value";
    const { fetchImpl } = stubFetch(() => {
      throw new TypeError(`failed: http://127.0.0.1:8787/api/v1/bluepencil/notes?token=${credentialValue} (${credentialValue})`);
    });
    const reply = await runHubRequest(
      request({ headers: { authorization: `Bearer ${credentialValue}` }, url: `${BASE}/notes?token=${credentialValue}` }),
      POLICY,
      { fetchImpl },
    );
    const serialised = JSON.stringify(reply);
    // Only the error *name* is relayed; neither the message nor the request echo may carry a value.
    expect(serialised).not.toContain(credentialValue);
    expect(reply).toMatchObject({ ok: false, error: { code: "network" } });
  });
});

/* ------------------------------------------------------------------------------------------------
 * Rebuilding a Response in the page
 * ---------------------------------------------------------------------------------------------- */

describe("hub relay — replyToResponse", () => {
  it("rebuilds the response the adapter would have received", async () => {
    const response = replyToResponse({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: '{"notes":[]}',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe('{"notes":[]}');
  });

  it("does not throw on the null-body statuses 204, 205 and 304", () => {
    for (const status of [204, 205, 304]) {
      const response = replyToResponse({
        ok: true,
        status,
        statusText: "",
        headers: {},
        body: null,
      });
      expect(response.status).toBe(status);
    }
  });

  it("throws on an error reply instead of inventing a success", () => {
    expect(() =>
      replyToResponse({ ok: false, error: { code: "disallowed_target", message: "nope" } }),
    ).toThrow(/nope/);
  });
});

describe("hub relay — page protocol", () => {
  it("names the page-side kind the bridge forwards", () => {
    expect(PAGE_FETCH_KIND).toBe("fetch");
  });

  it("returns a HubFetchReply the bridge can post back verbatim", async () => {
    const reply: HubFetchReply = await runHubRequest(request(), POLICY, {
      fetchImpl: (async () => new Response("{}")) as typeof fetch,
    });
    expect(reply.ok).toBe(true);
  });
});
