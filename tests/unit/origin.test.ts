/**
 * Unit tests for origin normalisation and parsing (FR-2.2, G5; AC-A01, AC-A02, AC-A14).
 *
 * The normalisation table from the contract is asserted case by case, including the opacity
 * rules and the 512-character cap. `parseOriginInput` gets its strictness table (unassigned vs
 * invalid) plus the location helpers.
 */
import { describe, expect, it } from "vitest";
import { currentOrigin, normaliseOrigin, originOf, parseOriginInput } from "../../src/core/origin";
import type { Note, NoteOrigin } from "../../src/core/model";

/** Build a long but otherwise valid origin whose raw length is exactly `length`. */
function originOfLength(length: number): string {
  return `https://${"a".repeat(length - "https://".length)}`;
}

describe("normaliseOrigin (AC-A01, AC-A02)", () => {
  it("canonicalises scheme, host, default port, path, query and fragment", () => {
    const table: ReadonlyArray<readonly [unknown, NoteOrigin]> = [
      ["https://Example.COM:443/app?x=1", "https://example.com"],
      ["http://example.com:80", "http://example.com"],
      ["http://example.com:8080", "http://example.com:8080"],
      ["https://example.com:80", "https://example.com:80"],
      ["https://bücher.example", "https://xn--bcher-kva.example"],
      ["http://[::1]:8787", "http://[::1]:8787"],
      ["blob:https://example.com/u", "https://example.com"],
    ];
    for (const [input, expected] of table) {
      expect(normaliseOrigin(input), String(input)).toBe(expected);
    }
  });

  it("lowercases both scheme and host, whatever their input casing", () => {
    expect(normaliseOrigin("HTTPS://EXAMPLE.COM")).toBe("https://example.com");
    expect(normaliseOrigin("Http://A.Example/Path")).toBe("http://a.example");
    expect(normaliseOrigin("blob:HTTPS://Example.COM/uuid")).toBe("https://example.com");
  });

  it("elides exactly the default port and keeps every other one", () => {
    expect(normaliseOrigin("https://a.example:443")).toBe("https://a.example");
    expect(normaliseOrigin("http://a.example:80")).toBe("http://a.example");
    expect(normaliseOrigin("https://a.example:80")).toBe("https://a.example:80");
    expect(normaliseOrigin("http://a.example:443")).toBe("http://a.example:443");
    expect(normaliseOrigin("http://a.example:8080")).toBe("http://a.example:8080");
  });

  it("keeps a trailing root label — the URL Standard has no strip rule", () => {
    // WHATWG keeps `example.com.` and `normaliseOrigin(v) === v` then holds, so the schema
    // accepts it. Stripping would be an extra, unspecified rule; the page origin reads the same.
    expect(normaliseOrigin("https://Example.COM.:443/x")).toBe("https://example.com.");
    expect(normaliseOrigin("https://example.com.")).toBe("https://example.com.");
  });

  it("drops userinfo, path, query and fragment", () => {
    expect(normaliseOrigin("https://user:pw@Example.com:443/path?q=1#frag")).toBe("https://example.com");
    expect(normaliseOrigin("http://user@a.example/")).toBe("http://a.example");
  });

  it("maps opaque schemes and non-strings to null, without throwing (AC-A02)", () => {
    const opaque: readonly unknown[] = [
      "file:///tmp/x",
      "data:text/html,x",
      "about:blank",
      "chrome-extension://abc",
      "javascript:alert(1)",
      "blob:null/uuid",
      "blob:file:///tmp/x",
      "null",
      "",
      "   ",
      "42",
      "not a url",
      undefined,
      null,
      42,
      true,
      {},
      [],
    ];
    for (const value of opaque) {
      expect(normaliseOrigin(value), String(value)).toBeNull();
    }
  });

  it("is total for every primitive, including symbols and bigints", () => {
    for (const value of [Symbol("x"), 10n, Number.NaN, () => "x"]) {
      expect(() => normaliseOrigin(value)).not.toThrow();
      expect(normaliseOrigin(value)).toBeNull();
    }
  });

  it("accepts 512 characters and refuses 513", () => {
    const max = originOfLength(512);
    expect(max).toHaveLength(512);
    expect(normaliseOrigin(max)).toBe(max);
    expect(normaliseOrigin(originOfLength(513))).toBeNull();
  });
});

describe("parseOriginInput (AC-A14)", () => {
  it("treats the four unassigned spellings as null", () => {
    for (const value of ["", "null", null, undefined]) {
      expect(parseOriginInput(value), String(value)).toEqual({ ok: true, origin: null });
    }
  });

  it("normalises a valid origin instead of rejecting it", () => {
    expect(parseOriginInput("https://A.example:443/x")).toEqual({ ok: true, origin: "https://a.example" });
    expect(parseOriginInput("https://A.example")).toEqual({ ok: true, origin: "https://a.example" });
    expect(parseOriginInput("https://a.example:443")).toEqual({ ok: true, origin: "https://a.example" });
    expect(parseOriginInput("HTTPS://EXAMPLE.COM")).toEqual({ ok: true, origin: "https://example.com" });
    expect(parseOriginInput("blob:https://a.example/u")).toEqual({ ok: true, origin: "https://a.example" });
  });

  it("rejects every other value with invalid_origin", () => {
    const invalid: readonly unknown[] = [
      42,
      "42",
      {},
      [],
      true,
      "file:///x",
      "data:text/html,x",
      "about:blank",
      "chrome-extension://abc",
      "javascript:alert(1)",
      "   ",
      "null ",
      originOfLength(513),
    ];
    for (const value of invalid) {
      expect(parseOriginInput(value), String(value)).toEqual({ ok: false, code: "invalid_origin" });
    }
  });
});

describe("originOf", () => {
  it("reads a canonical origin and defaults a missing field to null", () => {
    expect(originOf({ origin: "https://a.example" })).toBe("https://a.example");
    expect(originOf({ origin: null })).toBeNull();
    expect(originOf({} as Pick<Note, "origin">)).toBeNull();
  });
});

describe("currentOrigin", () => {
  it("normalises a location origin", () => {
    expect(currentOrigin({ origin: "https://A.example:443" })).toBe("https://a.example");
    expect(currentOrigin({ origin: "http://[::1]:8787" })).toBe("http://[::1]:8787");
  });

  it("returns null for opaque, missing or malformed locations", () => {
    expect(currentOrigin(undefined)).toBeNull();
    expect(currentOrigin(null)).toBeNull();
    expect(currentOrigin({})).toBeNull();
    expect(currentOrigin({ origin: undefined })).toBeNull();
    expect(currentOrigin({ origin: null })).toBeNull();
    expect(currentOrigin({ origin: "null" })).toBeNull();
    expect(currentOrigin({ origin: 42 })).toBeNull();
    expect(currentOrigin({ origin: "file:///tmp/x" })).toBeNull();
  });
});
