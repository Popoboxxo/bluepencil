/**
 * @vitest-environment node — `checkTarget()` may consult `node:dns` in production; every case here
 * injects a resolver through the hermetic stub, so the suite never touches the network.
 *
 * SSRF policy (issue #140, plan Task 7): UT-12/UT-13/UT-14/UT-15/UT-26.
 *
 * The point of these tests is that every refusal is a *named* `TargetRefusal`, never a thrown
 * exception and never a generic `500`: metadata names are refused before the allowlist and before
 * DNS, one forbidden address rejects the whole target, and a wildcard entry never authorizes a
 * private resolution.
 */
import { describe, expect, it } from "vitest";

import type { HostResolver } from "../../src/federation/net-policy";
import { checkTarget } from "../../server/viewer";
import { stubResolver } from "./helpers/viewer-harness";

const PUBLIC = "93.184.216.34";

describe("checkTarget — synchronous part (UT-12)", () => {
  it("refuses non-http(s), a malformed url, userinfo and hosts outside the allowlist", async () => {
    const allow = ["example.com"];
    const cases = [
      ["", "target_not_allowed"],
      ["not a url", "target_not_allowed"],
      ["file:///etc/passwd", "target_not_allowed"],
      ["javascript:alert(1)", "target_not_allowed"],
      ["ftp://example.com/", "target_not_allowed"],
      ["https://user:pw@example.com/", "target_not_allowed"],
      ["https://other.test/", "target_not_allowed"],
    ] as const;
    for (const [raw, code] of cases) {
      const verdict = await checkTarget(raw, allow);
      expect(verdict?.code, raw).toBe(code);
      expect(verdict?.message.length).toBeGreaterThan(0);
    }
  });

  it("allows an allowlisted https target and does not touch DNS for a literal IP", async () => {
    const stub = stubResolver({ "example.com": [PUBLIC] });
    expect(await checkTarget("https://example.com/x", ["example.com"], { resolver: stub.resolver })).toBeNull();
    expect(stub.calls).toEqual(["example.com"]);

    const noDns = stubResolver();
    expect(await checkTarget(`http://${PUBLIC}/`, [PUBLIC], { resolver: noDns.resolver })).toBeNull();
    expect(noDns.calls).toEqual([]); // an IP literal is classified directly
  });
});

describe("checkTarget — DNS classification (UT-13)", () => {
  it("allows a public resolution and rejects the target when any address is forbidden", async () => {
    const publicOnly = stubResolver({ "example.com": [PUBLIC] });
    expect(await checkTarget("https://example.com/", ["example.com"], { resolver: publicOnly.resolver })).toBeNull();

    const mixed = stubResolver({ "example.com": [PUBLIC, "127.0.0.1"] });
    const verdict = await checkTarget("https://example.com/", ["example.com"], { resolver: mixed.resolver });
    expect(verdict?.code).toBe("target_address_forbidden");
    expect(verdict?.message).toContain("127.0.0.1");
  });

  it("blocks loopback, link-local/metadata and reserved addresses returned by DNS", async () => {
    for (const address of ["127.0.0.1", "169.254.169.254", "::ffff:169.254.169.254", "::1", "0.0.0.0"]) {
      const stub = stubResolver({ "example.com": [address] });
      const verdict = await checkTarget("https://example.com/", ["example.com"], { resolver: stub.resolver });
      expect(verdict?.code, address).toBe("target_address_forbidden");
    }
  });
});

describe("checkTarget — private addresses need an exact entry (UT-14)", () => {
  it("allows a private literal only when the IP is listed exactly", async () => {
    expect(await checkTarget("http://10.0.0.1/", ["10.0.0.1"])).toBeNull();
    // Outside the allowlist the synchronous check already refuses — the IP policy is never reached.
    const refused = await checkTarget("http://10.0.0.1/", ["example.com"]);
    expect(refused?.code).toBe("target_not_allowed");

    const optOut = await checkTarget("http://10.0.0.1/", ["10.0.0.1"], { allowPrivateExact: false });
    expect(optOut?.code).toBe("target_address_forbidden");
  });

  it("allows a private resolution behind an exact hostname entry", async () => {
    const stub = stubResolver({ "internal.example.com": ["10.0.0.5"] });
    const verdict = await checkTarget("https://internal.example.com/", ["internal.example.com"], {
      resolver: stub.resolver,
    });
    expect(verdict).toBeNull();
  });

  it("never lets a wildcard entry authorize a private resolution", async () => {
    const stub = stubResolver({ "foo.example.com": ["10.0.0.5"] });
    const verdict = await checkTarget("https://foo.example.com/", ["*.example.com"], {
      resolver: stub.resolver,
    });
    expect(verdict?.code).toBe("target_address_forbidden");
    expect(verdict?.message).toContain("10.0.0.5");
  });

  it("keeps loopback and metadata addresses forbidden even when listed exactly", async () => {
    for (const [raw, allow] of [
      ["http://127.0.0.1/", ["127.0.0.1"]],
      ["http://[::1]/", ["::1"]],
      ["http://169.254.169.254/", ["169.254.169.254"]],
      // `new URL()` normalises the IPv4-mapped literal; the exact entry has to use that spelling.
      ["http://[::ffff:a9fe:a9fe]/", ["::ffff:a9fe:a9fe"]],
    ] as const) {
      const verdict = await checkTarget(raw, allow);
      expect(verdict?.code, raw).toBe("target_address_forbidden");
    }
  });
});

describe("checkTarget — forbidden origins (UT-15)", () => {
  it("normalises scheme, host and port before comparing", async () => {
    const stub = stubResolver({ "view.example.com": [PUBLIC] });
    const verdict = await checkTarget("https://view.example.com/x", ["view.example.com"], {
      resolver: stub.resolver,
      forbiddenOrigins: ["https://VIEW.example.com:443/some/path"],
    });
    expect(verdict?.code).toBe("target_forbidden_origin");
  });

  it("distinguishes a different scheme and ignores invalid entries", async () => {
    const stub = stubResolver({ "view.example.com": [PUBLIC] });
    expect(
      await checkTarget("https://view.example.com/x", ["view.example.com"], {
        resolver: stub.resolver,
        forbiddenOrigins: ["http://view.example.com", "not an origin"],
      }),
    ).toBeNull();
  });

  it("applies to a literal IP target as well", async () => {
    const verdict = await checkTarget("http://10.0.0.1/", ["10.0.0.1"], {
      forbiddenOrigins: ["http://10.0.0.1:80"],
    });
    expect(verdict?.code).toBe("target_forbidden_origin");
  });
});

describe("checkTarget — metadata and resolver failures (UT-26)", () => {
  it("refuses a metadata host name before the allowlist and before DNS", async () => {
    const stub = stubResolver({ "metadata.google.internal": [PUBLIC] });
    const verdict = await checkTarget("http://metadata.google.internal/", ["metadata.google.internal"], {
      resolver: stub.resolver,
    });
    expect(verdict?.code).toBe("target_metadata_host");
    expect(stub.calls).toEqual([]);
  });

  it("maps a throwing, empty or non-IP resolver answer to unresolvable_host", async () => {
    const thrown = stubResolver({ "example.com": new Error("ENOTFOUND") });
    expect((await checkTarget("https://example.com/", ["example.com"], { resolver: thrown.resolver }))?.code)
      .toBe("unresolvable_host");

    const empty = stubResolver({ "example.com": [] });
    expect((await checkTarget("https://example.com/", ["example.com"], { resolver: empty.resolver }))?.code)
      .toBe("unresolvable_host");

    const nonIp = stubResolver({ "example.com": ["not-an-ip"] });
    expect((await checkTarget("https://example.com/", ["example.com"], { resolver: nonIp.resolver }))?.code)
      .toBe("unresolvable_host");
  });

  it("is total: it never throws, whatever the resolver returns", async () => {
    const broken = (async () => undefined) as unknown as HostResolver;
    const inputs = ["", " ", "///", "http://", "http://[::1", "https://example.com/%zz"];
    for (const raw of inputs) {
      await expect(checkTarget(raw, ["example.com"], { resolver: broken })).resolves.toMatchObject(
        expect.objectContaining({ code: expect.any(String), message: expect.any(String) }),
      );
    }

    // A throwing non-Error resolver is still a refusal, not an exception.
    const throwsString = (async () => {
      throw "boom";
    }) as unknown as HostResolver;
    expect((await checkTarget("https://example.com/", ["example.com"], { resolver: throwsString }))?.code)
      .toBe("unresolvable_host");
  });
});
