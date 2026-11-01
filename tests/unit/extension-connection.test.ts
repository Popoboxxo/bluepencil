/**
 * "Test connection" — the options page's only network probe (#105).
 *
 * The probe is deliberately DOM- and `chrome.*`-free (`extension/src/connection.ts`), so every
 * branch that matters can be pinned here with an injected `fetch`: the wrong-base-path 404, a
 * refused connection, a timeout, a non-JSON answer, every credential outcome (accepted, rejected,
 * invalid header value, inconclusive), and the status-only `/notes` check. The browser side (button,
 * rendering, storage untouched) is covered by `extension/smoke.mjs`.
 *
 * The credential is the part these tests guard hardest. It must go out in exactly the header the
 * layer would send — `Authorization: Bearer …` for a token, `x-bluepencil-auth` for a secret — and
 * it must never come back in a message, a result, or a log line.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { probeConnection } from "../../extension/src/connection";

const BASE = "http://127.0.0.1:8787/api/v1/bluepencil";
const OPTIONS_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../extension/src/options.ts"),
  "utf8",
);

/** The `/config` payload the reference hub sends (server/handler.ts, `configResponse`). */
const CONFIG = {
  name: "bluepencil hub",
  app: "bluepencil hub",
  federates: false,
  version: "0.11.2",
  base: "/api/v1/bluepencil",
  auth: "token",
  readOnly: false,
  environment: "dev",
  bind: { host: "127.0.0.1", port: 8787, loopbackOnly: true },
};

interface Call {
  url: string;
  init: RequestInit;
}

/** A `fetch` whose calls can be inspected, and whose answers are supplied per test. */
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

/** A `Response`-shaped stub: the probe only reads `status` and `text()`. */
function response(status: number, body: unknown, raw?: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return raw ?? JSON.stringify(body);
    },
  } as unknown as Response;
}

function headersOf(call: Call | undefined): Record<string, string> {
  return (call?.init.headers ?? {}) as Record<string, string>;
}

describe("probeConnection", () => {
  describe("the URL itself", () => {
    it.each([
      ["", "an empty value"],
      ["   ", "only whitespace"],
      ["127.0.0.1:8787/api/v1/bluepencil", "a missing scheme"],
      ["ftp://127.0.0.1/api/v1/bluepencil", "a scheme the adapter cannot use"],
      ["http://127.0.0.1:8787/api/v1/bluepencil?x=1", "a query string"],
      ["http://127.0.0.1:8787/api/v1/bluepencil#top", "a fragment"],
    ])("refuses %j (%s) without making a request", async (endpoint) => {
      const { fetchImpl, calls } = stubFetch(() => response(200, CONFIG));
      const result = await probeConnection({ endpoint }, { fetchImpl });

      expect(result.status).toBe("invalid-url");
      expect(result.ok).toBe(false);
      expect(result.httpStatus).toBeNull();
      expect(result.config).toBeNull();
      expect(result.message).toMatch(/full hub URL|http:\/\/127\.0\.0\.1:8787/i);
      expect(calls).toHaveLength(0);
    });

    it("asks /config under the endpoint it was given, without doubling a trailing slash", async () => {
      const { fetchImpl, calls } = stubFetch(() => response(200, CONFIG));
      await probeConnection({ endpoint: `${BASE}/` }, { fetchImpl });

      expect(calls.map((call) => call.url)).toEqual([`${BASE}/config`]);
      expect(headersOf(calls[0]).Accept).toBe("application/json");
    });
  });

  describe("a reachable hub", () => {
    it("extracts the /config summary and names every field in the message", async () => {
      const { fetchImpl, calls } = stubFetch(() => response(200, CONFIG));
      const result = await probeConnection({ endpoint: BASE }, { fetchImpl });

      expect(result.status).toBe("reachable");
      expect(result.ok).toBe(true);
      expect(result.httpStatus).toBe(200);
      expect(result.credential).toBeNull();
      // Exactly the six fields the page shows; nothing from `bind`/`base`/`app` leaks into it.
      expect(result.config).toEqual({
        name: "bluepencil hub",
        version: "0.11.2",
        auth: "token",
        readOnly: false,
        environment: "dev",
        federates: false,
      });
      for (const expected of [
        "bluepencil hub",
        "version 0.11.2",
        "auth token",
        "read-only no",
        "environment dev",
        "federates no",
      ]) {
        expect(result.message).toContain(expected);
      }
      // No credential was configured, so `/notes` is never asked.
      expect(calls).toHaveLength(1);
    });

    it("tolerates missing or differently-typed /config fields instead of inventing values", async () => {
      const { fetchImpl } = stubFetch(() => response(200, { name: "hub", auth: "weird", readOnly: "yes" }));
      const result = await probeConnection({ endpoint: BASE }, { fetchImpl });

      expect(result.status).toBe("reachable");
      expect(result.config).toEqual({
        name: "hub",
        version: null,
        auth: null,
        readOnly: null,
        environment: null,
        federates: null,
      });
    });

    it("treats a 200 that is not a JSON object as an invalid response, not a connection", async () => {
      const { fetchImpl } = stubFetch(() => response(200, null, "<!doctype html><title>not the API</title>"));
      const result = await probeConnection({ endpoint: BASE }, { fetchImpl });

      expect(result.status).toBe("invalid-response");
      expect(result.ok).toBe(false);
      expect(result.config).toBeNull();
      expect(result.message).toMatch(/JSON/i);
    });

    it("treats JSON that is not a hub configuration the same way", async () => {
      const { fetchImpl } = stubFetch(() => response(200, null, "null"));
      const result = await probeConnection({ endpoint: BASE }, { fetchImpl });

      expect(result.status).toBe("invalid-response");
      expect(result.config).toBeNull();
    });
  });

  describe("a redirect (#110)", () => {
    /** A `3xx` with a `Location`, the shape Node/undici hands back under `redirect: "manual"`. */
    function redirectResponse(status: number, location: string): Response {
      return {
        status,
        ok: false,
        type: "default",
        headers: new Headers({ location }),
        async text() {
          return "";
        },
      } as unknown as Response;
    }

    it("reports a 301 as its own outcome and never follows it", async () => {
      const target = "https://hub.example.test/api/v1/bluepencil/config";
      const { fetchImpl, calls } = stubFetch(() => redirectResponse(301, target));
      const result = await probeConnection({ endpoint: BASE }, { fetchImpl });

      expect(result.status).toBe("redirected");
      expect(result.ok).toBe(false);
      // The status is the redirect's own, not a made-up one: a response was received.
      expect(result.httpStatus).toBe(301);
      expect(result.config).toBeNull();
      expect(result.message).toMatch(/redirected/i);
      // Actionable: the target the fix should use is named (and the path is still visible).
      expect(result.message).toContain("https://hub.example.test/api/v1/bluepencil/config");
      expect(result.message).toMatch(/final URL/i);
      // Exactly one request: following the redirect is the thing this outcome exists to refuse.
      expect(calls).toHaveLength(1);
      expect(calls[0]?.init.redirect).toBe("manual");
    });

    it("reports an opaque redirect, where the browser hides the status and the target", async () => {
      const fetchImpl = (async () =>
        ({
          status: 0,
          ok: false,
          // What Chrome returns for `redirect: "manual"`: no status, no headers.
          type: "opaqueredirect",
          headers: new Headers(),
          body: null,
        }) as unknown as Response) as typeof fetch;
      const result = await probeConnection({ endpoint: BASE }, { fetchImpl });

      expect(result.status).toBe("redirected");
      expect(result.ok).toBe(false);
      // Status 0 is "no status", not a number to report.
      expect(result.httpStatus).toBeNull();
      expect(result.config).toBeNull();
      expect(result.message).toMatch(/redirected/i);
      expect(result.message).toMatch(/does not expose|hides/i);
      expect(result.message).toMatch(/final URL/i);
    });

    it("names a redirect on /notes too, keeping the /config summary", async () => {
      const { fetchImpl } = stubFetch((url) =>
        url.endsWith("/config") ? response(200, CONFIG) : redirectResponse(302, "https://hub.test/notes"),
      );
      const result = await probeConnection(
        { endpoint: BASE, credential: { auth: "token", token: "tok" } },
        { fetchImpl },
      );

      expect(result.status).toBe("redirected");
      expect(result.ok).toBe(false);
      // /config answered, so that status is the one a received response can be reported with.
      expect(result.httpStatus).toBe(200);
      expect(result.config?.version).toBe("0.11.2");
      expect(result.credential).toBeNull();
      expect(result.message).toContain("https://hub.test/notes");
      expect(result.message).toMatch(/final URL/i);
    });

    it("redacts userinfo in the redirect target, up to the last @", async () => {
      // A `Location` is a URL like any other and may carry `user:password@`; masking only the first
      // `@` would leave the password's tail in a message the user copies around.
      const { fetchImpl } = stubFetch(() => redirectResponse(301, "http://alice:p@ss@hub.example.test/api"));
      const result = await probeConnection({ endpoint: BASE }, { fetchImpl });

      expect(result.status).toBe("redirected");
      expect(result.message).toContain("***@hub.example.test");
      expect(result.message).not.toContain("alice");
      expect(result.message).not.toContain("p@ss");
      expect(result.message).not.toContain("@ss");
    });
  });

  describe("the common failure modes", () => {
    it("names a 404 as the wrong base path — the mistake this probe exists for", async () => {
      const { fetchImpl } = stubFetch(() => response(404, null, "not found"));
      const result = await probeConnection({ endpoint: "http://127.0.0.1:8787" }, { fetchImpl });

      expect(result.status).toBe("wrong-base-path");
      expect(result.ok).toBe(false);
      expect(result.httpStatus).toBe(404);
      expect(result.message).toMatch(/404/);
      expect(result.message).toMatch(/base path/i);
      expect(result.message).toMatch(/\/notes/);
    });

    it("reports a refused connection as unreachable and keeps the transport reason", async () => {
      const fetchImpl = (async () => {
        throw new Error("Failed to fetch");
      }) as typeof fetch;
      const result = await probeConnection({ endpoint: BASE }, { fetchImpl });

      expect(result.status).toBe("unreachable");
      expect(result.ok).toBe(false);
      expect(result.httpStatus).toBeNull();
      expect(result.config).toBeNull();
      expect(result.message).toMatch(/could not reach/i);
      expect(result.message).toMatch(/Failed to fetch/);
    });

    it("reports a request that outlives the timeout as timed out, not unreachable", async () => {
      const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("The operation was aborted.");
            error.name = "AbortError";
            reject(error);
          });
        })) as typeof fetch;
      const result = await probeConnection({ endpoint: BASE }, { fetchImpl, timeoutMs: 20 });

      expect(result.status).toBe("timed-out");
      expect(result.ok).toBe(false);
      expect(result.httpStatus).toBeNull();
      expect(result.message).toMatch(/did not answer/i);
      expect(result.message).toMatch(/0\.02 s|20 ms/i);
    });

    it("reports a non-2xx that is neither 404 nor 401 as an HTTP error, with the status", async () => {
      const { fetchImpl } = stubFetch(() => response(500, null, "boom"));
      const result = await probeConnection({ endpoint: BASE }, { fetchImpl });

      expect(result.status).toBe("http-error");
      expect(result.httpStatus).toBe(500);
      expect(result.message).toMatch(/500/);
    });

    it("treats a 401 or 403 on /config as an authorisation problem", async () => {
      for (const status of [401, 403]) {
        const { fetchImpl } = stubFetch(() => response(status, null, "denied"));
        const result = await probeConnection({ endpoint: BASE }, { fetchImpl });

        expect(result.status, `status ${status}`).toBe("unauthorised");
        expect(result.httpStatus).toBe(status);
        expect(result.message).toMatch(new RegExp(String(status)));
      }
    });
  });

  describe("the credential", () => {
    it("sends a signed token as Authorization: Bearer and reports it accepted on 200", async () => {
      const { fetchImpl, calls } = stubFetch((url) =>
        url.endsWith("/config") ? response(200, CONFIG) : response(200, { notes: [] }),
      );
      const result = await probeConnection(
        { endpoint: BASE, credential: { auth: "token", token: "signed-token-abc" } },
        { fetchImpl },
      );

      expect(calls.map((call) => call.url)).toEqual([`${BASE}/config`, `${BASE}/notes`]);
      expect(headersOf(calls[1]).Authorization).toBe("Bearer signed-token-abc");
      expect(headersOf(calls[0]).Authorization).toBeUndefined();
      expect(result.status).toBe("reachable");
      expect(result.ok).toBe(true);
      expect(result.credential).toBe("accepted");
      expect(result.config).not.toBeNull();
      expect(result.message).toMatch(/credential .*accepted/i);
    });

    it("sends a shared secret as x-bluepencil-auth, never as a bearer token", async () => {
      const { fetchImpl, calls } = stubFetch((url) =>
        url.endsWith("/config") ? response(200, { ...CONFIG, auth: "secret" }) : response(200, { notes: [] }),
      );
      const result = await probeConnection(
        { endpoint: BASE, credential: { auth: "secret", token: "shared-secret-xyz" } },
        { fetchImpl },
      );

      expect(headersOf(calls[1])["x-bluepencil-auth"]).toBe("shared-secret-xyz");
      expect(headersOf(calls[1]).Authorization).toBeUndefined();
      expect(result.credential).toBe("accepted");
      expect(result.status).toBe("reachable");
    });

    it("reports 401 on /notes as a rejected credential, with the hub reachable", async () => {
      const { fetchImpl } = stubFetch((url) =>
        url.endsWith("/config") ? response(200, CONFIG) : response(401, { error: "bad token" }),
      );
      const result = await probeConnection(
        { endpoint: BASE, credential: { auth: "token", token: "expired-TOPSECRET-token" } },
        { fetchImpl },
      );

      expect(result.status).toBe("unauthorised");
      expect(result.ok).toBe(false);
      expect(result.httpStatus).toBe(401);
      expect(result.credential).toBe("rejected");
      expect(result.config).not.toBeNull();
      expect(result.message).toMatch(/rejected the credential/i);
      expect(result.message).toMatch(/401/);
      expect(result.message).toMatch(/token|secret/i);
    });

    it("reports 403 on /notes as rejected too", async () => {
      const { fetchImpl } = stubFetch((url) =>
        url.endsWith("/config") ? response(200, CONFIG) : response(403, { error: "scope" }),
      );
      const result = await probeConnection(
        { endpoint: BASE, credential: { auth: "token", token: "read-only-token" } },
        { fetchImpl },
      );

      expect(result.status).toBe("unauthorised");
      expect(result.httpStatus).toBe(403);
      expect(result.credential).toBe("rejected");
    });

    it("never puts the credential into the result, the message or the console", async () => {
      const credentialValue = "NEVER-PRINT-ME-42";
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { fetchImpl } = stubFetch((url) =>
        url.endsWith("/config") ? response(200, CONFIG) : response(401, { error: "denied" }),
      );

      const result = await probeConnection(
        { endpoint: BASE, credential: { auth: "token", token: credentialValue } },
        { fetchImpl },
      );

      expect(result.message).not.toContain(credentialValue);
      expect(JSON.stringify(result)).not.toContain(credentialValue);
      for (const spy of [log, warn, error]) {
        expect(spy).not.toHaveBeenCalled();
      }
    });

    it("does not make a credential request when the credential field is empty", async () => {
      const { fetchImpl, calls } = stubFetch(() => response(200, CONFIG));
      const result = await probeConnection(
        { endpoint: BASE, credential: { auth: "token", token: "   " } },
        { fetchImpl },
      );

      expect(calls).toHaveLength(1);
      expect(result.credential).toBeNull();
      expect(result.status).toBe("reachable");
    });

    it("does not make a credential request when the mode is none, even if a stale token is stored", async () => {
      const { fetchImpl, calls } = stubFetch(() => response(200, { ...CONFIG, auth: "none" }));
      const result = await probeConnection(
        { endpoint: BASE, credential: { auth: "none", token: "left-over-token" } },
        { fetchImpl },
      );

      expect(calls).toHaveLength(1);
      expect(result.credential).toBeNull();
      expect(result.status).toBe("reachable");
    });

    it("checks /notes for its status only, cancelling a body that never finishes", async () => {
      const cancel = vi.fn(async () => undefined);
      const text = vi.fn(() => new Promise<string>(() => undefined));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const { fetchImpl, calls } = stubFetch((url) =>
        url.endsWith("/config")
          ? response(200, CONFIG)
          : ({
              status: 200,
              ok: true,
              body: { cancel },
              text,
            } as unknown as Response),
      );

      const result = await Promise.race([
        probeConnection(
          { endpoint: BASE, credential: { auth: "token", token: "tok" } },
          { fetchImpl, timeoutMs: 5_000 },
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("the probe waited for the /notes body instead of only its status")),
            1_000,
          );
        }),
      ]).finally(() => clearTimeout(timer));

      expect(calls.map((call) => call.url)).toEqual([`${BASE}/config`, `${BASE}/notes`]);
      expect(result.status).toBe("reachable");
      expect(result.credential).toBe("accepted");
      expect(cancel).toHaveBeenCalledTimes(1);
      // The body was never read — that is what keeps a huge or slow corpus off the budget.
      expect(text).not.toHaveBeenCalled();
    });

    it("handles a /notes response with no body at all (body === null)", async () => {
      // A status-only answer may legitimately carry no stream — a `204`, a stub, or a browser that
      // filtered the body. `cancelBody` must tolerate it instead of turning a working probe into a
      // failure while trying to release nothing.
      const text = vi.fn(() => Promise.resolve(""));
      const { fetchImpl } = stubFetch((url) =>
        url.endsWith("/config")
          ? response(200, CONFIG)
          : ({ status: 204, ok: true, body: null, text } as unknown as Response),
      );

      const result = await probeConnection(
        { endpoint: BASE, credential: { auth: "token", token: "tok" } },
        { fetchImpl },
      );

      expect(result.status).toBe("reachable");
      expect(result.credential).toBe("accepted");
      expect(text).not.toHaveBeenCalled();
    });

    it("ignores a cancel() that rejects, because the stream may already be closed", async () => {
      // The release is deliberately not awaited (see `cancelBody`): a rejecting cancel is not a probe
      // failure and must not surface as an unhandled rejection either.
      const cancel = vi.fn(() => Promise.reject(new Error("stream already closed")));
      const { fetchImpl } = stubFetch((url) =>
        url.endsWith("/config")
          ? response(200, CONFIG)
          : ({ status: 200, ok: true, body: { cancel }, text: vi.fn() } as unknown as Response),
      );

      const result = await probeConnection(
        { endpoint: BASE, credential: { auth: "token", token: "tok" } },
        { fetchImpl },
      );

      expect(result.status).toBe("reachable");
      expect(result.credential).toBe("accepted");
      expect(cancel).toHaveBeenCalledTimes(1);
      // Let the rejected promise's handler run before the test ends; an unhandled rejection would
      // fail the run, which is the point of this case.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it("keeps the /config summary and calls the credential unverified when /notes times out", async () => {
      const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/config")) return Promise.resolve(response(200, CONFIG));
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("The operation was aborted.");
            error.name = "AbortError";
            reject(error);
          });
        });
      }) as typeof fetch;

      const result = await probeConnection(
        { endpoint: BASE, credential: { auth: "token", token: "tok" } },
        { fetchImpl, timeoutMs: 20 },
      );

      // Not "timed-out" and not "unreachable": /config answered, so both would be false.
      expect(result.status).toBe("credential-unverified");
      expect(result.ok).toBe(false);
      expect(result.config?.version).toBe("0.11.2");
      expect(result.credential).toBeNull();
      expect(result.httpStatus).toBe(200);
      expect(result.message).toMatch(/could not be verified/i);
      expect(result.message).toMatch(/did not answer within/i);
      expect(result.message).not.toMatch(/could not reach/i);
    });

    it("keeps the /config summary and calls the credential unverified when /notes fails", async () => {
      const { fetchImpl } = stubFetch((url) => {
        if (url.endsWith("/config")) return response(200, CONFIG);
        throw new Error("socket hang up.");
      });
      const result = await probeConnection(
        { endpoint: BASE, credential: { auth: "token", token: "tok" } },
        { fetchImpl },
      );

      expect(result.status).toBe("credential-unverified");
      expect(result.config).not.toBeNull();
      expect(result.credential).toBeNull();
      expect(result.message).toMatch(/could not be verified/i);
      expect(result.message).toMatch(/socket hang up/);
      expect(result.message).not.toMatch(/could not reach/i);
      expect(result.message).not.toMatch(/\.\./);
    });

    it("reports a 5xx on /notes as an HTTP error, neither rejected nor unreachable", async () => {
      const { fetchImpl } = stubFetch((url) =>
        url.endsWith("/config") ? response(200, CONFIG) : response(500, null, "boom"),
      );
      const result = await probeConnection(
        { endpoint: BASE, credential: { auth: "token", token: "tok" } },
        { fetchImpl },
      );

      expect(result.status).toBe("http-error");
      expect(result.httpStatus).toBe(500);
      expect(result.credential).toBeNull();
      expect(result.config).not.toBeNull();
      expect(result.message).toMatch(/500/);
      expect(result.message).toMatch(/notes/i);
      expect(result.message).not.toMatch(/rejected the credential/i);
    });

    it("reports a credential that cannot be a header value as invalid, without sending it", async () => {
      for (const token of ["abc\ndef", "日本語", "token\u0000", "x\u{1f600}y"]) {
        const { fetchImpl, calls } = stubFetch(() => response(200, CONFIG));
        const result = await probeConnection(
          { endpoint: BASE, credential: { auth: "token", token } },
          { fetchImpl },
        );

        expect(result.status, JSON.stringify(token)).toBe("invalid-credential");
        expect(result.credential).toBe("invalid");
        expect(result.message).toMatch(/credential/i);
        expect(result.message).toMatch(/HTTP header/i);
        expect(result.message).not.toMatch(/could not reach/i);
        // Only /config was asked; the invalid value never became a request header.
        expect(calls).toHaveLength(1);
      }
    });
  });

  describe("hygiene", () => {
    it("sends the trimmed credential and asks fetch not to follow redirects", async () => {
      const { fetchImpl, calls } = stubFetch((url) =>
        url.endsWith("/config") ? response(200, CONFIG) : response(200, { notes: [] }),
      );
      await probeConnection(
        { endpoint: BASE, credential: { auth: "secret", token: "  s3cret  " } },
        { fetchImpl },
      );

      expect(headersOf(calls[1])["x-bluepencil-auth"]).toBe("s3cret");
      // `manual`, not `error`: a redirect must not be followed (the credential stays at the origin
      // the user typed), but it also must not be reported as a dead hub — it gets its own outcome.
      expect(calls.every((call) => call.init.redirect === "manual")).toBe(true);
    });

    it("clears its abort timer after a successful probe", async () => {
      vi.useFakeTimers();
      try {
        const { fetchImpl } = stubFetch(() => response(200, CONFIG));
        const result = await probeConnection({ endpoint: BASE }, { fetchImpl });
        expect(result.status).toBe("reachable");
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears its abort timer after a failed probe", async () => {
      vi.useFakeTimers();
      try {
        const fetchImpl = (async () => {
          throw new Error("Failed to fetch");
        }) as typeof fetch;
        const result = await probeConnection({ endpoint: BASE }, { fetchImpl });
        expect(result.status).toBe("unreachable");
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("strips userinfo and caps the length of an invalid endpoint in the message", async () => {
      const endpoint = `http://alice:super-secret@example.test/${"x".repeat(300)}?token=1`;
      const { fetchImpl, calls } = stubFetch(() => response(200, CONFIG));
      const result = await probeConnection({ endpoint }, { fetchImpl });

      expect(result.status).toBe("invalid-url");
      expect(calls).toHaveLength(0);
      expect(result.message).not.toContain("super-secret");
      expect(result.message).toContain("***@");
      expect(result.message.length).toBeLessThan(400);
    });

    it("masks userinfo up to the last @, because an unescaped password may contain one", async () => {
      // Masking only up to the *first* @ left the tail of the password readable: this used to render
      // as `***@ss@example.test` — one character from the secret, plus a plausible-looking host.
      // The query forces the invalid-url path, which is where the endpoint is rendered at all.
      const endpoint = "http://alice:p@ss@example.test/api/v1/bluepencil?x=1";
      const { fetchImpl, calls } = stubFetch(() => response(200, CONFIG));
      const result = await probeConnection({ endpoint }, { fetchImpl });

      expect(result.status).toBe("invalid-url");
      expect(calls).toHaveLength(0);
      expect(result.message).toContain("***@example.test");
      expect(result.message).not.toContain("alice");
      expect(result.message).not.toContain("p@ss");
      expect(result.message).not.toContain("@ss");
    });

    it("drops the query and fragment, which carry secrets of their own", async () => {
      const endpoint = "https://user:tok3n@example.test/api?token=QUERY-SECRET&x=1#frag-SECRET";
      const { fetchImpl } = stubFetch(() => response(200, CONFIG));
      const result = await probeConnection({ endpoint }, { fetchImpl });

      expect(result.status).toBe("invalid-url");
      expect(result.message).toContain("***@example.test");
      expect(result.message).not.toContain("tok3n");
      expect(result.message).not.toContain("QUERY-SECRET");
      expect(result.message).not.toContain("frag-SECRET");
      expect(result.message).not.toContain("?token");
      expect(result.message).not.toContain("#");
    });

    it("masks userinfo even when the paste has no scheme", async () => {
      // Scheme-less input is rejected as an invalid URL, and the rejection message rendered it raw —
      // so a pasted `user:password@host` leaked there without ever looking like a URL.
      const endpoint = "alice:p@ss@example.test/api";
      const { fetchImpl } = stubFetch(() => response(200, CONFIG));
      const result = await probeConnection({ endpoint }, { fetchImpl });

      expect(result.status).toBe("invalid-url");
      expect(result.message).toContain("***@example.test");
      expect(result.message).not.toContain("alice");
      expect(result.message).not.toContain("p@ss");
    });

    it("does not double a terminator the transport reason already carries", async () => {
      const fetchImpl = (async () => {
        throw new Error("Failed to fetch.");
      }) as typeof fetch;
      const result = await probeConnection({ endpoint: BASE }, { fetchImpl });

      expect(result.status).toBe("unreachable");
      expect(result.message).toContain("Failed to fetch.");
      expect(result.message).not.toMatch(/\.\./);
    });
  });

  describe("rendering (FR-9.3)", () => {
    it("keeps a hostile name as text in the result, never as markup", async () => {
      const hostile = `<img src=x onerror="alert(1)">`;
      const { fetchImpl } = stubFetch(() => response(200, { ...CONFIG, name: hostile }));
      const result = await probeConnection({ endpoint: BASE }, { fetchImpl });

      expect(result.config?.name).toBe(hostile);
      expect(result.message).toContain(hostile);
    });

    it("renders the probe message with textContent — options.ts never uses an HTML sink", () => {
      expect(OPTIONS_SOURCE).not.toMatch(/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
      expect(OPTIONS_SOURCE).toMatch(/status\.textContent\s*=\s*message/);
    });
  });
});
