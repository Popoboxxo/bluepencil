/**
 * @vitest-environment node
 *
 * Issue #135, part 2: the client-configured session strategy. The exact ref composition and the
 * glob rules are a contract shared by the element, the extension and the store; every rule gets its
 * own assertion here so a later refactor cannot quietly change a stored sessionRef.
 */
import { describe, expect, it } from "vitest";
import {
  globMatches,
  parseGlobRule,
  parseSessionStrategy,
  resolveSessionRef,
  type SessionPlace,
} from "../../src/core/session-strategy";

const place: SessionPlace = {
  label: "relaunch-2026-11",
  origin: "https://shop-a.de",
  route: "/produkt",
};

describe("session strategy composition", () => {
  it("given keeps the label byte-for-byte (the default, unchanged behaviour)", () => {
    const strategy = parseSessionStrategy(undefined).strategy;
    expect(resolveSessionRef(strategy, place)).toBe("relaunch-2026-11");
    expect(resolveSessionRef([{ kind: "given" }], {})).toBeUndefined();
  });

  it("origin appends the site, or uses the bare site when there is no label", () => {
    const strategy = parseSessionStrategy("origin").strategy;
    expect(resolveSessionRef(strategy, place)).toBe("relaunch-2026-11@https://shop-a.de");
    expect(resolveSessionRef(strategy, { origin: "https://shop-a.de" })).toBe("https://shop-a.de");
  });

  it("route appends the site and the path", () => {
    expect(
      resolveSessionRef(parseSessionStrategy("route").strategy, place),
    ).toBe("relaunch-2026-11@https://shop-a.de/produkt");
  });

  it("none leaves the note without any sessionRef", () => {
    expect(resolveSessionRef(parseSessionStrategy("none").strategy, place)).toBeUndefined();
  });

  it("pins the federated format label@instance/origin/key", () => {
    const federated: SessionPlace = {
      label: "relaunch-2026-11",
      origin: "dev-web/https://shop-a.de",
      route: "/shop/produkt/7",
    };
    expect(resolveSessionRef(parseSessionStrategy("glob:/shop/**").strategy, federated)).toBe(
      "relaunch-2026-11@dev-web/https://shop-a.de/shop",
    );
    expect(
      resolveSessionRef(parseSessionStrategy("glob:/shop/**").strategy, {
        ...federated,
        origin: "https://shop-a.de",
      }),
    ).toBe("relaunch-2026-11@https://shop-a.de/shop");
  });

  it("does not invent an origin for an origin-based strategy", () => {
    expect(resolveSessionRef(parseSessionStrategy("origin").strategy, { label: "r" })).toBe("r");
  });
});

describe("glob matching", () => {
  it("* matches exactly one segment, ** matches any number including none", () => {
    expect(globMatches("/shop/*", "/shop/a")).toBe(true);
    expect(globMatches("/shop/*", "/shop/a/b")).toBe(false);
    expect(globMatches("/shop/**", "/shop")).toBe(true);
    expect(globMatches("/shop/**", "/shop/a")).toBe(true);
    expect(globMatches("/shop/**", "/shop/a/b")).toBe(true);
    expect(globMatches("/a/**/z", "/a/z")).toBe(true);
    expect(globMatches("/a/**/z", "/a/b/c/z")).toBe(true);
  });

  it("does not match a neighbouring path or another section", () => {
    expect(globMatches("/shop/**", "/shopping")).toBe(false);
    expect(globMatches("/shop/**", "/blog/a")).toBe(false);
    expect(globMatches("/shop/*", "/shop")).toBe(false);
  });

  it("uses the longest fixed prefix before the first placeholder as the key", () => {
    expect(parseGlobRule("glob:/shop/**")).toMatchObject({
      rule: { kind: "glob", key: "/shop" },
    });
    expect(parseGlobRule("glob:/a/b/*/c")).toMatchObject({
      rule: { kind: "glob", key: "/a/b" },
    });
    expect(parseGlobRule("glob:/fixed")).toMatchObject({
      rule: { kind: "glob", key: "/fixed" },
    });
  });

  it("takes a list, first match wins, last entry is the fallback", () => {
    const strategy = parseSessionStrategy("glob:/shop/** , glob:/blog/** , origin").strategy;
    expect(resolveSessionRef(strategy, { ...place, route: "/shop/a/b" })).toBe(
      "relaunch-2026-11@https://shop-a.de/shop",
    );
    expect(resolveSessionRef(strategy, { ...place, route: "/blog/post" })).toBe(
      "relaunch-2026-11@https://shop-a.de/blog",
    );
    expect(resolveSessionRef(strategy, { ...place, route: "/checkout" })).toBe(
      "relaunch-2026-11@https://shop-a.de",
    );
  });

  it("reports a non-matching glob without fallback as ungrouped, never as a guess", () => {
    expect(
      resolveSessionRef(parseSessionStrategy("glob:/shop/**").strategy, {
        ...place,
        route: "/checkout",
      }),
    ).toBeUndefined();
  });
});

describe("session-strategy validation", () => {
  it("rejects an unknown strategy as an issue, not a silent no-match", () => {
    const parsed = parseSessionStrategy("by-origin");
    expect(parsed.strategy).toBeUndefined();
    expect(parsed.issues.join(" ")).toContain("by-origin");
  });

  it("keeps the valid entries of a list and reports each invalid one", () => {
    const parsed = parseSessionStrategy("glob:/shop/** , nonsense , route");
    expect(parsed.strategy).toHaveLength(2);
    expect(parsed.issues).toHaveLength(1);
    expect(resolveSessionRef(parsed.strategy, { ...place, route: "/shop/a" })).toBe(
      "relaunch-2026-11@https://shop-a.de/shop",
    );
  });

  it("refuses paths outside the path grammar: query, fragment, regex and stray stars", () => {
    for (const token of ["glob:shop/**", "glob:/shop/**?x=1", "glob:/shop/**#x", "glob:/shop/[ab]", "glob:/shop/***"]) {
      expect("issue" in parseGlobRule(token)).toBe(true);
    }
  });
});
