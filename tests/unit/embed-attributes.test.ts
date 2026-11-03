/**
 * Route/query contract (G8, ADR-0.12-S5; AC-C01…AC-C03).
 *
 * A stored route is part of the hand-off artifact between reviewer and agent, so a query string
 * that reached it is a secret that left the page. These tests pin the three documented modes:
 *
 *   - `url` (the default): pathname only — no query, no fragment, ever;
 *   - `url-with-query` without allow/deny: the full, verbatim opt-in;
 *   - `url-with-query` with allow/deny: filtered, deterministic, deny winning over allow and the
 *     default deny list unless a name is explicitly allowed.
 *
 * `routeFor` is pure, so no DOM and no stubbing is needed. `tests/unit/embed.test.ts` keeps the
 * element/attribute wiring (`readRoute`), which is a separate contract (T-C2).
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_QUERY_DENY,
  routeFor,
  type QueryPolicy,
  type RouteMode,
} from "../../src/embed/attributes";

/** The AC-C01 page: a deep-link token next to an innocuous parameter. */
const PAGE = { pathname: "/p", search: "?token=secret&x=1" };

/** An opt-in policy with no lists; individual tests override only what they exercise. */
function policy(overrides: Partial<QueryPolicy> = {}): QueryPolicy {
  return { mode: "url-with-query", allow: [], deny: [], ...overrides };
}

describe("routeFor — path-only default (AC-C01)", () => {
  it('stores only the pathname for mode "url"', () => {
    expect(routeFor(PAGE, policy({ mode: "url" }))).toBe("/p");
  });

  it("drops the query even when no parameter name looks sensitive", () => {
    expect(routeFor({ pathname: "/p", search: "?x=1&y=2" }, policy({ mode: "url" }))).toBe("/p");
  });

  it('never emits a fragment for mode "url", even if the caller passed one in search', () => {
    expect(routeFor({ pathname: "/p", search: "?token=secret#section-2" }, policy({ mode: "url" }))).toBe(
      "/p",
    );
  });

  it("treats an unknown mode as the secure path-only default", () => {
    const typo = "hash" as RouteMode;
    expect(routeFor(PAGE, policy({ mode: typo }))).toBe("/p");
  });

  it('ignores allow/deny in mode "url" — the query is not kept for a named parameter', () => {
    expect(routeFor(PAGE, policy({ mode: "url", allow: ["token", "x"], deny: [] }))).toBe("/p");
  });
});

describe("routeFor — full opt-in without allow/deny (AC-C02)", () => {
  it("keeps pathname + search verbatim", () => {
    expect(routeFor(PAGE, policy())).toBe("/p?token=secret&x=1");
  });

  it('emits no "?" for an empty query', () => {
    expect(routeFor({ pathname: "/p", search: "" }, policy())).toBe("/p");
    expect(routeFor({ pathname: "/p", search: "?" }, policy())).toBe("/p");
  });

  it("keeps the URL order and duplicate parameter names", () => {
    expect(routeFor({ pathname: "/p", search: "?z=1&a=2&z=3" }, policy())).toBe("/p?z=1&a=2&z=3");
  });

  it("strips a fragment even in the verbatim opt-in", () => {
    expect(routeFor({ pathname: "/p", search: "?a=1#frag" }, policy())).toBe("/p?a=1");
  });
});

describe("routeFor — allow/deny precedence (AC-C03)", () => {
  it("drops explicitly denied parameters and yields no trailing ? when nothing survives", () => {
    expect(routeFor(PAGE, policy({ deny: ["token", "x"] }))).toBe("/p");
  });

  it("keeps parameters that neither list names when only deny is set", () => {
    expect(routeFor({ pathname: "/p", search: "?token=secret&x=1&y=2" }, policy({ deny: ["token", "x"] }))).toBe(
      "/p?y=2",
    );
  });

  it("treats a non-empty allow as a whitelist", () => {
    expect(
      routeFor(
        { pathname: "/p", search: "?utm_source=a&utm_medium=b&ref=other" },
        policy({ allow: ["utm_*"] }),
      ),
    ).toBe("/p?utm_source=a&utm_medium=b");
  });

  it("lets deny win over allow for the same name", () => {
    expect(
      routeFor(
        { pathname: "/p", search: "?utm_source=a&utm_medium=b" },
        policy({ allow: ["utm_*"], deny: ["utm_source"] }),
      ),
    ).toBe("/p?utm_medium=b");
  });

  it("lets an explicit allow override the default deny", () => {
    expect(
      routeFor(
        { pathname: "/p", search: "?key=k&safe=s&token=t&other=1" },
        policy({ allow: ["key", "safe"] }),
      ),
    ).toBe("/p?key=k&safe=s");
  });

  it("applies the default deny list when only deny is configured", () => {
    expect(
      routeFor(
        { pathname: "/p", search: "?token=secret&X-Amz-Signature=s&x=1&y=2" },
        policy({ deny: ["x"] }),
      ),
    ).toBe("/p?y=2");
  });

  it("drops every default deny name in a filtered query", () => {
    const search =
      "?token=1&code=2&state=3&sig=4&signature=5&key=6&password=7&secret=8&access_token=9&id_token=10&X-Amz-Signature=11&safe=12";
    // `deny` is non-empty only to enter the filtered path; the names themselves come from the
    // default list.
    expect(routeFor({ pathname: "/p", search }, policy({ deny: ["does-not-occur"] }))).toBe(
      "/p?safe=12",
    );
  });

  it("matches names case-sensitively", () => {
    expect(
      routeFor({ pathname: "/p", search: "?token=t&Token=T&TOKEN=U" }, policy({ deny: ["token"] })),
    ).toBe("/p?Token=T&TOKEN=U");
  });

  it("matches prefix entries only and never a lookalike of an exact entry", () => {
    expect(
      routeFor(
        {
          pathname: "/p",
          search: "?key=1&keyboard=2&X-Amz-Signature=3&X-Amz-Other=4&x-amz-signature=5",
        },
        policy({ deny: ["key", "X-Amz-*"] }),
      ),
    ).toBe("/p?keyboard=2&x-amz-signature=5");
  });

  it("decodes parameter names before matching", () => {
    // `to%6ben` is `token`; the default deny list has to see the decoded name.
    expect(routeFor({ pathname: "/p", search: "?to%6ben=secret&ok=1" }, policy({ deny: ["nope"] }))).toBe(
      "/p?ok=1",
    );
  });

  it("preserves order and multiple values of retained parameters", () => {
    expect(
      routeFor({ pathname: "/p", search: "?z=1&a=2&z=3&drop=4" }, policy({ allow: ["z", "a"] })),
    ).toBe("/p?z=1&a=2&z=3");
  });

  it("re-encodes retained values through URLSearchParams deterministically", () => {
    expect(
      routeFor(
        { pathname: "/p", search: "?utm_source=a%20b&utm_campaign=%C3%BC&utm_term=x%2Fy" },
        policy({ allow: ["utm_*"] }),
      ),
    ).toBe("/p?utm_source=a+b&utm_campaign=%C3%BC&utm_term=x%2Fy");
  });

  it("returns the pathname for an empty filtered parameter set", () => {
    expect(routeFor({ pathname: "/p", search: "?" }, policy({ allow: ["utm_*"] }))).toBe("/p");
    expect(routeFor({ pathname: "/p", search: "" }, policy({ deny: ["token"] }))).toBe("/p");
  });

  it("does not mutate the policy arrays", () => {
    const allow = ["utm_*"];
    const deny = ["utm_source"];
    routeFor({ pathname: "/p", search: "?utm_source=a&utm_medium=b" }, policy({ allow, deny }));
    expect(allow).toEqual(["utm_*"]);
    expect(deny).toEqual(["utm_source"]);
  });

  it("is deterministic across repeated calls (NFR-17)", () => {
    const input = { pathname: "/p", search: "?utm_source=a%20b&ref=1&token=t" };
    const first = routeFor(input, policy({ allow: ["utm_*"] }));
    expect(routeFor(input, policy({ allow: ["utm_*"] }))).toBe(first);
    expect(routeFor(input, policy({ allow: ["utm_*"] }))).toBe(first);
  });
});

describe("DEFAULT_QUERY_DENY", () => {
  it("lists exactly the documented names and is frozen", () => {
    expect(DEFAULT_QUERY_DENY).toEqual([
      "token",
      "code",
      "state",
      "sig",
      "signature",
      "key",
      "password",
      "secret",
      "access_token",
      "id_token",
      "X-Amz-*",
    ]);
    expect(Object.isFrozen(DEFAULT_QUERY_DENY)).toBe(true);
  });
});
