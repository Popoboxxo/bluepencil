/**
 * @vitest-environment node — the resolver test reaches the real `node:dns/promises`, and the
 * suite exercises Node's URL parser. No other test opens a socket.
 *
 * Base-URL/SSRF policy for federation instances (FR-16.10; plan §4/§6, decision 15,
 * T41/T80/T86/T91/T92). Every negative case asserts the stable `UrlPolicyReason` a caller
 * maps to a registry error code — the interesting part is not that a URL is refused, but
 * *which* rule refused it.
 */
import { describe, expect, it } from "vitest";

import {
  METADATA_HOSTNAMES,
  UrlPolicyError,
  checkBaseUrl,
  classifyIp,
  createDnsResolver,
  embeddedIpv4,
  isIpLiteral,
  normalizeBaseUrl,
  type BaseUrlPolicyOptions,
  type UrlPolicyReason,
} from "../../src/federation/net-policy";

/** Await a promise that must reject with a `UrlPolicyError`, and return it. */
async function rejection(promise: Promise<unknown>): Promise<UrlPolicyError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(UrlPolicyError);
    return error as UrlPolicyError;
  }
  throw new Error("Expected the URL policy to reject, but it returned");
}

/** The reason a URL is rejected with. */
async function reasonOf(
  raw: string,
  options?: BaseUrlPolicyOptions,
): Promise<UrlPolicyReason> {
  return (await rejection(checkBaseUrl(raw, options))).reason;
}

/** A fake resolver backed by a fixed host → addresses map; unknown hosts reject. */
function fakeResolver(table: Record<string, readonly string[]>): BaseUrlPolicyOptions["resolver"] {
  return (hostname: string): Promise<readonly string[]> => {
    const addresses = table[hostname];
    if (addresses === undefined) {
      return Promise.reject(new Error(`fake DNS has no entry for ${hostname}`));
    }
    return Promise.resolve(addresses);
  };
}

describe("normalizeBaseUrl — URL shape", () => {
  it("keeps a root base at / and strips other trailing path slashes only", () => {
    expect(normalizeBaseUrl("https://h.example").pathname).toBe("/");
    expect(normalizeBaseUrl("https://h.example/").pathname).toBe("/");
    expect(normalizeBaseUrl("https://h.example/api/").pathname).toBe("/api");
    expect(normalizeBaseUrl("https://h.example/api///").pathname).toBe("/api");
    expect(normalizeBaseUrl("https://h.example/api/deep/").pathname).toBe("/api/deep");
  });

  it("lower-cases scheme and host like the URL parser does", () => {
    expect(normalizeBaseUrl("HTTPS://H.Example/").href).toBe("https://h.example/");
  });

  it("does not rewrite the path beyond trailing slashes", () => {
    expect(normalizeBaseUrl("https://h.example/a/b").pathname).toBe("/a/b");
    expect(normalizeBaseUrl("https://h.example:8443/api").port).toBe("8443");
  });
});

describe("T86 registry.rejects_query_fragment_url", () => {
  it("rejects a query string", async () => {
    expect(await reasonOf("https://h.example/api?x=1")).toBe("query");
  });

  it("rejects a fragment", async () => {
    expect(await reasonOf("https://h.example/api#frag")).toBe("fragment");
  });

  it("rejects userinfo", async () => {
    expect(await reasonOf("https://user:secret@h.example/api")).toBe("userinfo");
    expect(await reasonOf("https://user@h.example/api")).toBe("userinfo");
  });

  it("rejects non-http(s) schemes", async () => {
    for (const raw of [
      "file:///etc/passwd",
      "ftp://h.example",
      "javascript:alert(1)",
      "data:text/plain,hello",
      "ws://h.example/socket",
    ]) {
      expect(await reasonOf(raw)).toBe("non_http_scheme");
    }
  });

  it("rejects unparsable input", async () => {
    expect(await reasonOf("not a URL")).toBe("invalid_url");
    expect(await reasonOf("https://h.example:99999")).toBe("invalid_url");
  });
});

describe("T41 security.registry_url_policy", () => {
  it("allows plain http to loopback", async () => {
    await expect(checkBaseUrl("http://127.0.0.1:8787")).resolves.toMatchObject({
      hostname: "127.0.0.1",
    });
    await expect(checkBaseUrl("http://127.4.5.6")).resolves.toMatchObject({
      hostname: "127.4.5.6",
    });
    await expect(checkBaseUrl("http://[::1]:8787")).resolves.toMatchObject({
      hostname: "::1",
    });
  });

  it("rejects plain http to a non-loopback host", async () => {
    expect(await reasonOf("http://h.example")).toBe("http_non_loopback");
    expect(await reasonOf("http://10.0.0.5:8787")).toBe("http_non_loopback");
  });

  it("rejects https to RFC1918/ULA/100.64 without the lab flag", async () => {
    for (const raw of [
      "https://10.1.2.3",
      "https://172.16.0.1",
      "https://192.168.1.4",
      "https://100.64.0.1",
      "https://[fc00::1]",
      "https://[fd00::1]",
      // Deprecated IPv6 site-local is still non-public.
      "https://[fec0::1]",
    ]) {
      expect(await reasonOf(raw)).toBe("private_without_allow_insecure");
    }
  });

  it("admits private ranges with allowInsecure", async () => {
    for (const raw of [
      "https://10.1.2.3",
      "https://192.168.1.4",
      "https://[fc00::1]",
      "https://[fec0::1]",
      "http://10.0.0.5:8787",
    ]) {
      await expect(checkBaseUrl(raw, { allowInsecure: true })).resolves.toMatchObject({
        url: expect.any(URL),
      });
    }
  });
});

describe("T80 security.ssrf_link_local_rejected", () => {
  const blocked: readonly (readonly [string, UrlPolicyReason])[] = [
    ["https://169.254.169.254", "metadata"],
    // Alibaba and AWS IPv6 metadata endpoints are blocked by address, not by host name.
    ["https://100.100.100.200", "metadata"],
    ["https://[fd00:ec2::254]", "metadata"],
    ["https://169.254.1.1", "link_local"],
    ["https://[fe80::1]", "link_local"],
    ["https://0.0.0.0", "unspecified"],
    // The whole 0.0.0.0/8 is unspecified, not just the zero address.
    ["https://0.0.0.1", "unspecified"],
    ["https://[::]", "unspecified"],
    ["https://[ff02::1]", "multicast"],
    ["https://metadata.google.internal", "metadata"],
    ["https://metadata.", "metadata"],
    ["https://instance-data.ec2.internal", "metadata"],
    ["https://metadata.azure.internal", "metadata"],
  ];

  it("rejects literal link-local/metadata/special addresses and metadata hostnames", async () => {
    for (const [raw, reason] of blocked) {
      expect(await reasonOf(raw)).toBe(reason);
    }
  });

  it("never returns for a DNS answer that points at metadata or link-local", async () => {
    const options: BaseUrlPolicyOptions = {
      resolver: fakeResolver({
        "evil.example": ["169.254.169.254"],
        "link.example": ["fe80::1"],
      }),
    };

    await expect(checkBaseUrl("https://evil.example", options)).rejects.toMatchObject({
      reason: "metadata",
    });
    await expect(checkBaseUrl("https://link.example", options)).rejects.toMatchObject({
      reason: "link_local",
    });
  });

  it("keeps the DNS answer blocked even with allowInsecure", async () => {
    const options: BaseUrlPolicyOptions = {
      allowInsecure: true,
      resolver: fakeResolver({
        "evil.example": ["169.254.169.254"],
        "mixed.example": ["93.184.216.34", "fe80::1"],
      }),
    };

    await expect(checkBaseUrl("https://evil.example", options)).rejects.toMatchObject({
      reason: "metadata",
    });
    // Every answer counts: one public address does not bless a link-local sibling.
    await expect(checkBaseUrl("https://mixed.example", options)).rejects.toMatchObject({
      reason: "link_local",
    });
  });

  it("rejects an empty or throwing resolver as unresolvable", async () => {
    expect(
      await reasonOf("https://empty.example", { resolver: fakeResolver({ "empty.example": [] }) }),
    ).toBe("unresolvable_host");
    expect(
      await reasonOf("https://missing.example", { resolver: fakeResolver({}) }),
    ).toBe("unresolvable_host");
  });
});

describe("T91 security.allow_insecure_http_and_private", () => {
  it("admits non-loopback http and private DNS answers only with the flag", async () => {
    const resolver = fakeResolver({
      "hub-dev": ["172.17.0.2"],
      "public.example": ["93.184.216.34"],
    });

    await expect(
      checkBaseUrl("http://hub-dev:8787", { allowInsecure: true, resolver }),
    ).resolves.toMatchObject({ hostname: "hub-dev", addresses: ["172.17.0.2"] });

    expect(await reasonOf("http://hub-dev:8787", { resolver })).toBe("http_non_loopback");

    await expect(
      checkBaseUrl("https://public.example", { resolver }),
    ).resolves.toMatchObject({ addresses: ["93.184.216.34"] });
  });

  it("rejects a private DNS answer over https without the flag", async () => {
    const resolver = fakeResolver({ "private.example": ["10.0.0.5"] });

    expect(await reasonOf("https://private.example", { resolver })).toBe(
      "private_without_allow_insecure",
    );
    await expect(checkBaseUrl("https://private.example", { allowInsecure: true, resolver }))
      .resolves.toMatchObject({ addresses: ["10.0.0.5"] });
  });

  it("enforces the host allowlist, including wildcard entries", async () => {
    const options: BaseUrlPolicyOptions = { allowedHosts: ["*.example.com"] };

    await expect(checkBaseUrl("https://a.example.com", options)).resolves.toMatchObject({
      hostname: "a.example.com",
    });
    await expect(checkBaseUrl("https://deep.a.example.com", options)).resolves.toMatchObject({
      hostname: "deep.a.example.com",
    });

    expect(await reasonOf("https://example.org", options)).toBe("host_not_allowed");
    // A wildcard entry does not match the bare suffix, only a subdomain of it.
    expect(await reasonOf("https://example.com", options)).toBe("host_not_allowed");
  });

  it("matches exact allowlist entries case-insensitively and literal IPs exactly", async () => {
    await expect(
      checkBaseUrl("https://Hub.Example", { allowedHosts: ["hub.example"] }),
    ).resolves.toMatchObject({ hostname: "hub.example" });

    await expect(
      checkBaseUrl("https://127.0.0.1", { allowedHosts: ["127.0.0.1"] }),
    ).resolves.toMatchObject({ hostname: "127.0.0.1" });

    expect(
      await reasonOf("https://127.0.0.1", { allowedHosts: ["127.0.0.2"] }),
    ).toBe("host_not_allowed");
  });

  it("does not let an allowlist entry unlock a metadata host", async () => {
    expect(
      await reasonOf("https://metadata.google.internal", {
        allowInsecure: true,
        allowedHosts: ["metadata.google.internal"],
      }),
    ).toBe("metadata");
  });
});

describe("T92 security.allow_insecure_still_blocks_link_local", () => {
  it("still rejects every literal link-local/metadata/special target with the flag", async () => {
    const blocked: readonly (readonly [string, UrlPolicyReason])[] = [
      ["http://169.254.169.254", "metadata"],
      ["https://169.254.169.254", "metadata"],
      ["http://100.100.100.200", "metadata"],
      ["https://[fd00:ec2::254]", "metadata"],
      ["https://169.254.1.1", "link_local"],
      ["http://169.254.1.1", "link_local"],
      ["https://[fe80::1]", "link_local"],
      ["https://0.0.0.0", "unspecified"],
      ["https://0.0.0.1", "unspecified"],
      ["https://[::]", "unspecified"],
      ["https://[ff02::1]", "multicast"],
      ["https://metadata.google.internal", "metadata"],
    ];

    for (const [raw, reason] of blocked) {
      expect(await reasonOf(raw, { allowInsecure: true })).toBe(reason);
    }
  });

  it("still rejects hostnames resolving there with the flag", async () => {
    const options: BaseUrlPolicyOptions = {
      allowInsecure: true,
      resolver: fakeResolver({
        "metadata.example": ["169.254.169.254"],
        "link.example": ["fe80::1"],
        "zero.example": ["0.0.0.0"],
        "multi.example": ["ff02::1"],
      }),
    };

    expect(await reasonOf("https://metadata.example", options)).toBe("metadata");
    expect(await reasonOf("https://link.example", options)).toBe("link_local");
    expect(await reasonOf("https://zero.example", options)).toBe("unspecified");
    expect(await reasonOf("https://multi.example", options)).toBe("multicast");
  });
});

describe("N-01 IPv4-embedded IPv6 forms", () => {
  const metadataLiterals = [
    "https://[::ffff:100.100.100.200]",
    "https://[::ffff:6464:64c8]",
    "https://[::ffff:0:100.100.100.200]",
    "https://[::100.100.100.200]",
    "https://[64:ff9b::100.100.100.200]",
  ];

  it("blocks embedded metadata literals with and without allowInsecure", async () => {
    for (const raw of metadataLiterals) {
      expect(await reasonOf(raw), raw).toBe("metadata");
      expect(await reasonOf(raw, { allowInsecure: true }), raw).toBe("metadata");
      // Plain http must not slip past the metadata rule either.
      expect(await reasonOf(raw.replace("https:", "http:")), raw).toBe("metadata");
    }
  });

  it("blocks the embedded link-local metadata address", async () => {
    for (const raw of ["https://[::ffff:169.254.169.254]", "https://[::ffff:a9fe:a9fe]"]) {
      expect(await reasonOf(raw), raw).toBe("metadata");
      expect(await reasonOf(raw, { allowInsecure: true }), raw).toBe("metadata");
    }
    // Other link-local addresses stay link-local, not metadata.
    expect(await reasonOf("https://[::ffff:169.254.1.1]", { allowInsecure: true })).toBe(
      "link_local",
    );
  });

  it("allows embedded loopback and gates embedded private addresses", async () => {
    await expect(checkBaseUrl("http://[::ffff:127.0.0.1]:8787")).resolves.toMatchObject({
      hostname: "::ffff:7f00:1",
    });
    expect(await reasonOf("https://[::ffff:10.0.0.5]")).toBe(
      "private_without_allow_insecure",
    );
    await expect(
      checkBaseUrl("https://[::ffff:10.0.0.5]", { allowInsecure: true }),
    ).resolves.toMatchObject({ url: expect.any(URL) });
  });

  it("applies the same rules to resolver answers", async () => {
    const hosts = [
      "mapped.example",
      "hex.example",
      "translated.example",
      "compat.example",
      "nat64.example",
      "metadata.example",
    ];
    const resolver = fakeResolver({
      "mapped.example": ["::ffff:100.100.100.200"],
      "hex.example": ["::ffff:6464:64c8"],
      "translated.example": ["::ffff:0:100.100.100.200"],
      "compat.example": ["::100.100.100.200"],
      "nat64.example": ["64:ff9b::100.100.100.200"],
      "metadata.example": ["::ffff:169.254.169.254"],
    });

    for (const host of hosts) {
      expect(await reasonOf(`https://${host}`, { resolver }), host).toBe("metadata");
      expect(await reasonOf(`https://${host}`, { allowInsecure: true, resolver }), host).toBe(
        "metadata",
      );
    }
  });

  it("never classifies an embedded non-public IPv4 as public", () => {
    for (const address of [
      "::ffff:100.100.100.200",
      "::ffff:6464:64c8",
      "::ffff:0:100.100.100.200",
      "::100.100.100.200",
      "64:ff9b::100.100.100.200",
      "::ffff:169.254.169.254",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.5",
      "::ffff:0.0.0.0",
    ]) {
      expect(classifyIp(address), address).not.toBe("public");
    }
  });

  it("unwraps every supported embedded form regardless of notation", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["::ffff:100.100.100.200", "100.100.100.200"],
      ["::ffff:6464:64c8", "100.100.100.200"],
      ["::ffff:0:100.100.100.200", "100.100.100.200"],
      ["::100.100.100.200", "100.100.100.200"],
      ["64:ff9b::100.100.100.200", "100.100.100.200"],
      ["[::ffff:127.0.0.1]", "127.0.0.1"],
      ["::ffff:169.254.169.254", "169.254.169.254"],
      ["::ffff:10.0.0.5", "10.0.0.5"],
    ];
    for (const [address, expected] of cases) {
      expect(embeddedIpv4(address), address).toBe(expected);
    }

    // Non-embedded and non-IPv6 input stays unwrapped.
    for (const address of [
      "::",
      "::1",
      "2001:4860:4860::8888",
      "127.0.0.1",
      "not-an-ip",
      "64:ff9b:1::1.2.3.4",
    ]) {
      expect(embeddedIpv4(address), address).toBeUndefined();
    }
  });
});

describe("classifyIp — pure IPv4/IPv6 parsing", () => {
  const matrix: readonly (readonly [string, ReturnType<typeof classifyIp>])[] = [
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["::1", "loopback"],
    ["10.0.0.1", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"],
    ["100.100.100.200", "private"],
    ["100.127.255.255", "private"],
    ["fc00::1", "private"],
    ["fd00::1", "private"],
    ["fd00:ec2::254", "private"],
    ["fec0::1", "private"],
    ["febf::1", "link_local"],
    ["169.254.1.1", "link_local"],
    ["169.254.169.254", "link_local"],
    ["fe80::1", "link_local"],
    ["::ffff:169.254.169.254", "link_local"],
    // IPv4-embedded forms inherit the classification of the embedded address (N-01).
    ["::ffff:169.254.1.1", "link_local"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:10.0.0.5", "private"],
    ["::ffff:100.100.100.200", "private"],
    ["::ffff:6464:64c8", "private"],
    ["::ffff:0:100.100.100.200", "private"],
    ["::100.100.100.200", "private"],
    ["64:ff9b::100.100.100.200", "private"],
    ["0.0.0.0", "unspecified"],
    ["0.0.0.1", "unspecified"],
    ["0.255.255.255", "unspecified"],
    ["::", "unspecified"],
    ["::ffff:0.0.0.0", "unspecified"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.255", "multicast"],
    ["ff02::1", "multicast"],
    ["93.184.216.34", "public"],
    ["8.8.8.8", "public"],
    ["2001:4860:4860::8888", "public"],
    ["::ffff:8.8.8.8", "public"],
  ];

  it("classifies the address matrix", () => {
    for (const [address, expected] of matrix) {
      expect(classifyIp(address), address).toBe(expected);
    }
  });

  it("throws a plain Error (not UrlPolicyError) for malformed addresses", () => {
    for (const address of ["999.1.1.1", "1.2.3", "1.2.3.4.5", "gggg::1", "fe80::1::2", ""]) {
      try {
        classifyIp(address);
        throw new Error(`Expected classifyIp(${JSON.stringify(address)}) to throw`);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(UrlPolicyError);
      }
    }
  });

  it("recognises only valid literals", () => {
    expect(isIpLiteral("127.0.0.1")).toBe(true);
    expect(isIpLiteral("[::1]")).toBe(true);
    expect(isIpLiteral("::ffff:169.254.169.254")).toBe(true);
    expect(isIpLiteral("h.example")).toBe(false);
    expect(isIpLiteral("999.1.1.1")).toBe(false);
    expect(isIpLiteral("1.2.3")).toBe(false);
  });
});

describe("metadata host list", () => {
  it("exports the documented names", () => {
    expect(METADATA_HOSTNAMES).toEqual(
      expect.arrayContaining([
        "metadata",
        "metadata.google.internal",
        "metadata.goog",
        "instance-data",
        "instance-data.ec2.internal",
        "metadata.azure.internal",
        "metadata.tencentyun.com",
      ]),
    );
  });

  it("treats any metadata.* name and trailing dots as metadata", async () => {
    expect(await reasonOf("https://metadata.anything.example")).toBe("metadata");
    expect(await reasonOf("https://METADATA.GOOGLE.INTERNAL.")).toBe("metadata");
  });
});

describe("createDnsResolver — real resolver", () => {
  it("resolves localhost to a loopback address", async () => {
    const addresses = await createDnsResolver()("localhost");
    expect(addresses.some((address) => address === "127.0.0.1" || address === "::1")).toBe(true);
  });
});
