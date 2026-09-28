/**
 * Settings validation — the extension's only untrusted input path.
 *
 * A stored settings blob can be anything: written by an older version, edited by hand in
 * devtools, or half-written by a crash. `normalizeSettings` is what stands between that and the
 * layer, so the tests are about hostile input rather than the happy path — every field is checked
 * against its own allowed set, and one bad field must not take the rest down with it.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, normalizeSettings } from "../../extension/src/settings.js";

describe("normalizeSettings", () => {
  it("returns the defaults for nothing usable at all", () => {
    for (const input of [null, undefined, 42, "settings", true, [], () => {}]) {
      expect(normalizeSettings(input)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it("returns a fresh copy, so a caller cannot mutate the defaults", () => {
    const first = normalizeSettings(null);
    first.environment = "prod";
    expect(normalizeSettings(null).environment).toBe("dev");
    expect(DEFAULT_SETTINGS.environment).toBe("dev");
  });

  it("keeps every value it recognises", () => {
    const input = {
      environment: "staging",
      appName: "Wolfenbütteler Zeitung",
      language: "de",
      store: "http",
      identity: "page",
      endpoint: "https://notes.example.test",
      token: "shared-secret",
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
      ["identity", "anonymous", "identity"],
    ];
    for (const [field, bad, expectedKey] of cases) {
      const result = normalizeSettings({ [field]: bad });
      expect(result[expectedKey], `${field}=${String(bad)}`).toBe(DEFAULT_SETTINGS[expectedKey]);
    }
  });

  it("keeps the good fields when a sibling field is corrupt", () => {
    // The failure mode that matters: one bad value must not reset everything, or a user with a
    // valid sidecar endpoint would silently lose it because their language was mistyped.
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
    // appName, endpoint and token accept any string — there is no allow-list to pass. But a
    // non-string must not be coerced: `String({})` would put "[object Object]" into a URL.
    for (const field of ["appName", "endpoint", "token"] as const) {
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
    const result = normalizeSettings({ environment: "prod", futureFlag: true, __proto__: "x" });
    expect(result).toEqual({ ...DEFAULT_SETTINGS, environment: "prod" });
    expect(Object.keys(result)).toEqual(Object.keys(DEFAULT_SETTINGS));
    expect("futureFlag" in result).toBe(false);
  });

  it("is idempotent, so normalising a normalised value changes nothing", () => {
    const once = normalizeSettings({ environment: "prod", appName: "WZ", store: "http" });
    expect(normalizeSettings(once)).toEqual(once);
  });

  it("does not let a prototype-polluting key reach the result", () => {
    // A JSON-parsed blob carrying __proto__ must not end up as a real prototype edit. The result is
    // a fresh object literal, so this holds structurally; the test pins it so a future refactor
    // that spreads the input cannot break it silently.
    const result = normalizeSettings(JSON.parse('{"__proto__":{"polluted":true},"environment":"prod"}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(result.environment).toBe("prod");
  });

  it("defaults to local-first, so a fresh install needs no server and no credential", () => {
    // This is a product guarantee, not a default value: an install with no settings at all must not
    // reach for the network. If this ever changes, the extension starts phoning home on load.
    expect(DEFAULT_SETTINGS.store).toBe("chromeStorage");
    expect(DEFAULT_SETTINGS.endpoint).toBe("");
    expect(DEFAULT_SETTINGS.token).toBe("");
  });
});
