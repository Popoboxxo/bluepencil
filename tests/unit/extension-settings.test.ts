/**
 * Settings validation — the extension's only untrusted input path.
 *
 * A stored settings blob can be anything: written by an older version, edited by hand in
 * devtools, or half-written by a crash. `normalizeSettings` is what stands between that and the
 * layer, so the tests are about hostile input rather than the happy path — every field is checked
 * against its own allowed set, and one bad field must not take the rest down with it.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, expiryOfToken, normalizeSettings } from "../../extension/src/settings.js";

describe("normalizeSettings", () => {
  it("returns the defaults for nothing usable at all", () => {
    for (const input of [null, undefined, 42, "settings", true, [], () => {}]) {
      expect(normalizeSettings(input)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it("returns a fresh copy, so a caller cannot mutate the defaults", () => {
    const first = normalizeSettings(null);
    first.environment = "live";
    expect(normalizeSettings(null).environment).toBe("dev");
    expect(DEFAULT_SETTINGS.environment).toBe("dev");
  });

  it("keeps every value it recognises", () => {
    const input = {
      environment: "staging",
      appName: "Wolfenbütteler Zeitung",
      language: "de",
      store: "http",
      identity: "anonymous",
      endpoint: "https://notes.example.test",
      auth: "token",
      token: "shared-secret",
      tokenExpiresAt: "2026-10-01T12:00:00.000Z",
      deviceName: "work-laptop",
    };
    expect(normalizeSettings(input)).toEqual(input);
  });

  it("rejects a value outside each field's own allowed set, field by field", () => {
    // One bad value per field, each with a plausible neighbour: "devl" for an environment, "de_AT"
    // for a language. A check that passed on the wrong field would pass this, too — that is the
    // point. Nothing here may cross over into another field's territory.
    const cases: [string, unknown, keyof typeof DEFAULT_SETTINGS][] = [
      ["environment", "devl", "environment"],
      ["environment", "DEV", "environment"],
      ["environment", 1, "environment"],
      ["language", "de_AT", "language"],
      ["language", "fr", "language"],
      ["store", "chrome", "store"],
      ["store", "chrome_storage", "store"],
      // `page` was the options page's "take it from the page", a mode the element never had; it is
      // rejected like any other unknown value (#53).
      ["identity", "page", "identity"],
      // The credential mode decides which header a credential goes out in, so a value outside the
      // set is not a cosmetic problem: it is the difference between a working request and a 401 that
      // looks like a dead server.
      ["auth", "bearer", "auth"],
      ["auth", "Secret", "auth"],
      ["auth", "", "auth"],
    ];
    for (const [field, bad, expectedKey] of cases) {
      const result = normalizeSettings({ [field]: bad });
      expect(result[expectedKey], `${field}=${String(bad)}`).toBe(DEFAULT_SETTINGS[expectedKey]);
    }
  });

  it("keeps the good fields when a sibling field is corrupt", () => {
    // The failure mode that matters: one bad value must not reset everything, or a user with a
    // valid hub endpoint would silently lose it because their language was mistyped.
    const result = normalizeSettings({
      environment: "nonsense",
      language: "nonsense",
      endpoint: "https://notes.example.test",
      token: "shared-secret",
      store: "http",
    });
    expect(result.environment).toBe("dev");
    expect(result.language).toBe("auto");
    expect(result.store).toBe("http");
    expect(result.endpoint).toBe("https://notes.example.test");
    expect(result.token).toBe("shared-secret");
  });

  it("treats the free-text fields as strings or not at all", () => {
    // appName, endpoint, token and deviceName accept any string — there is no allow-list to pass.
    // But a non-string must not be coerced: `String({})` would put "[object Object]" into a URL or
    // into a display name. A name that renders as "[object Object]" in a revocation list is worse
    // than no name at all.
    for (const field of ["appName", "endpoint", "token", "deviceName"] as const) {
      for (const bad of [42, null, true, { nested: "x" }, ["a"]]) {
        const result = normalizeSettings({ [field]: bad });
        expect(result[field], `${field}=${JSON.stringify(bad)}`).toBe(DEFAULT_SETTINGS[field]);
        expect(typeof result[field]).toBe("string");
      }
    }
  });

  it("accepts an empty string, which is how 'unset' is spelled", () => {
    const result = normalizeSettings({ endpoint: "", token: "", appName: "" });
    expect(result.endpoint).toBe("");
    expect(result.token).toBe("");
    expect(result.appName).toBe("");
  });

  it("ignores unknown keys instead of passing them through", () => {
    // Forward compatibility runs the other way too: a newer version's key must not end up in the
    // object the worker hands to the page. It would be dead weight in a postMessage payload.
    const result = normalizeSettings({ environment: "live", futureFlag: true, __proto__: "x" });
    expect(result).toEqual({ ...DEFAULT_SETTINGS, environment: "live" });
    expect(Object.keys(result)).toEqual(Object.keys(DEFAULT_SETTINGS));
    expect("futureFlag" in result).toBe(false);
  });

  it("is idempotent, so normalising a normalised value changes nothing", () => {
    const once = normalizeSettings({ environment: "live", appName: "WZ", store: "http" });
    expect(normalizeSettings(once)).toEqual(once);
  });

  it("does not let a prototype-polluting key reach the result", () => {
    // A JSON-parsed blob carrying __proto__ must not end up as a real prototype edit. The result is
    // a fresh object literal, so this holds structurally; the test pins it so a future refactor
    // that spreads the input cannot break it silently.
    const result = normalizeSettings(JSON.parse('{"__proto__":{"polluted":true},"environment":"live"}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(result.environment).toBe("live");
  });

  it("defaults to local-first, so a fresh install needs no server and no credential", () => {
    // This is a product guarantee, not a default value: an install with no settings at all must not
    // reach for the network. If this ever changes, the extension starts phoning home on load.
    expect(DEFAULT_SETTINGS.store).toBe("chromeStorage");
    expect(DEFAULT_SETTINGS.endpoint).toBe("");
    expect(DEFAULT_SETTINGS.token).toBe("");
  });

  it("keeps a readable expiry and drops one that cannot be read", () => {
    // The expiry is a warning shown to the user, never a decision — the hub decides. That is
    // exactly why a wrong one is worse than none: an unparseable value would be rendered as
    // "expires in NaN h" or read as "never expires", and the user would find out by losing notes.
    for (const bad of [42, null, true, "not a date", "2026-13-45", {}]) {
      expect(normalizeSettings({ tokenExpiresAt: bad }).tokenExpiresAt).toBe("");
    }
    expect(normalizeSettings({ tokenExpiresAt: "2026-10-01T12:00:00.000Z" }).tokenExpiresAt).toBe(
      "2026-10-01T12:00:00.000Z",
    );
  });
});

/** A JWT-shaped token with the given claim set, base64url-encoded as a real one is. */
function tokenWith(claims: unknown): string {
  const payload = btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${payload}.signature-not-checked-here`;
}

describe("expiryOfToken", () => {
  it("reads a JWT expiry, which is seconds since the epoch", () => {
    // 1780000000 s = 2026-05-28T…Z. The value is only ever displayed, so what is asserted is the
    // conversion, not a policy.
    expect(expiryOfToken(tokenWith({ exp: 1780000000 }))).toBe(new Date(1780000000 * 1000).toISOString());
  });

  it("reads an ISO expiry too, because a hand-built claim set carries one", () => {
    // Both spellings are in the wild. Accepting only one would silently drop the other's expiry and
    // say "unknown" about a token whose expiry is perfectly readable.
    expect(expiryOfToken(tokenWith({ exp: "2026-10-01T12:00:00.000Z" }))).toBe("2026-10-01T12:00:00.000Z");
  });

  it("says nothing rather than guessing, for anything that is not a readable token", () => {
    // Nothing here is an error: the extension stores the token and the hub decides. What the
    // options page must not do is invent an expiry.
    const inputs = [
      "",
      "no-dots-at-all",
      "two.parts",
      "four.parts.here.now",
      "header..signature",
      tokenWith({}), // no exp at all
      tokenWith({ exp: "not a date" }),
      tokenWith({ exp: null }),
      "header.@@@not-base64@@@.signature", // atob throws
      "header.bm90LWpzb24.signature", // decodes, but is not JSON
    ];
    for (const token of inputs) {
      expect(expiryOfToken(token), token).toBe("");
    }
  });

  it("never throws, whatever is pasted into the field", () => {
    // The one guarantee the options page depends on: a paste cannot break the page that would fix
    // it. `atob` throws on malformed input and `JSON.parse` on malformed payloads, and both are
    // reached with whatever the user pasted.
    for (const token of ["\u0000.\u0000.\u0000", "a.////.c", "a..c", "…", "a.b.c"]) {
      expect(() => expiryOfToken(token)).not.toThrow();
    }
  });
});
