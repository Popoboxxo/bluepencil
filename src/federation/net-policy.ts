/**
 * Base-URL and SSRF policy for federation instances (FR-16.10, plan §4/§6, decision 15).
 *
 * The policy is deliberately split in two layers:
 *
 * - `normalizeBaseUrl` is synchronous and only looks at the URL itself: scheme, userinfo,
 *   query, fragment and a normalised path. It never touches the network.
 * - `checkBaseUrl` adds host allowlisting and address checks. Address checks run against
 *   literal IPs immediately and against every DNS answer when the caller injects a resolver
 *   — a hostname that resolves to a link-local or metadata address is rejected exactly like
 *   a literal one (DNS rebinding, T80).
 *
 * One flag, `allowInsecure`, is the single lab override: it admits `http` and RFC1918/ULA
 * addresses. It never admits link-local, metadata, unspecified or multicast targets
 * (T92). Without a resolver the check is offline-safe and only literal IPs are classified.
 *
 * This module must stay importable from a browser bundle: no top-level `node:*` import.
 * `createDnsResolver` performs its dynamic import inside the returned function.
 *
 * All IP parsing is pure TypeScript (`classifyIp` never uses `node:net`), so the same code
 * runs in Node, the browser and in tests.
 */

/** Why a URL was rejected. Stable by contract — callers map these to registry error codes. */
export type UrlPolicyReason =
  | "invalid_url"
  | "non_http_scheme"
  | "userinfo"
  | "query"
  | "fragment"
  | "host_not_allowed"
  | "http_non_loopback"
  | "private_without_allow_insecure"
  | "link_local"
  | "metadata"
  | "unspecified"
  | "multicast"
  | "unresolvable_host";

/** Error thrown by `normalizeBaseUrl`/`checkBaseUrl`. Carries a machine-readable reason. */
export class UrlPolicyError extends Error {
  readonly reason: UrlPolicyReason;
  readonly host?: string;
  readonly address?: string;

  constructor(
    reason: UrlPolicyReason,
    message: string,
    details?: { host?: string; address?: string },
  ) {
    super(message);
    this.name = "UrlPolicyError";
    this.reason = reason;
    this.host = details?.host;
    this.address = details?.address;
  }
}

/** Resolves a hostname to every address the platform knows about. */
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

export interface BaseUrlPolicyOptions {
  /**
   * The single lab flag: admits `http` and RFC1918/ULA addresses. Link-local, metadata,
   * unspecified and multicast targets stay blocked.
   */
  allowInsecure?: boolean;
  /** Optional allowlist. Exact hosts (case-insensitive) or `*.example.com` wildcards. */
  allowedHosts?: readonly string[];
  /** When absent only literal-IP checks run; no network access happens. */
  resolver?: HostResolver;
}

export interface CheckedBase {
  url: URL;
  hostname: string;
  addresses: readonly string[];
}

export type IpClass =
  | "loopback"
  | "private"
  | "link_local"
  | "unspecified"
  | "multicast"
  | "public";

/** Cloud metadata host names, always blocked regardless of `allowInsecure`. */
export const METADATA_HOSTNAMES: readonly string[] = [
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
  "metadata.azure.internal",
  "metadata.tencentyun.com",
];

/**
 * Metadata addresses of the known cloud providers. Checked before the generic classification:
 * `169.254.169.254` is link-local, `100.100.100.200` is CGNAT-ish and `fd00:ec2::254` is ULA,
 * so without this list they would only be blocked by accident (or admitted by `allowInsecure`).
 */
export const METADATA_ADDRESSES: readonly string[] = [
  "169.254.169.254",
  "100.100.100.200",
  "fd00:ec2::254",
];

/** Default deadline for one `dns.lookup`; a resolver must never hang a request forever. */
export const DEFAULT_DNS_TIMEOUT_MS = 2000;

/** Parses an IPv4 dotted quad, rejecting bad arity, non-digits, leading zeros and octets > 255. */
function parseIpv4(value: string): readonly [number, number, number, number] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return null;
    // Leading zeros are ambiguous (octal in some stacks); reject instead of guessing.
    if (part.length > 1 && part.startsWith("0")) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }

  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

/**
 * Expands an embedded IPv4 tail (`::ffff:1.2.3.4`) into two hex groups so the rest of the
 * IPv6 parser only has to deal with hex.
 */
function expandEmbeddedIpv4(value: string): string | null {
  if (!value.includes(".")) return value;

  const colon = value.lastIndexOf(":");
  if (colon < 0) return null;

  const ipv4 = parseIpv4(value.slice(colon + 1));
  if (ipv4 === null) return null;

  const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
  const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
  return `${value.slice(0, colon + 1)}${high}:${low}`;
}

/** Parses an IPv6 address into eight 16-bit groups. Returns `null` for malformed input. */
function parseIpv6(value: string): readonly number[] | null {
  // Zone identifiers are not part of a URL host and not supported here.
  if (value.includes("%")) return null;
  if (!value.includes(":")) return null;

  const expanded = expandEmbeddedIpv4(value);
  if (expanded === null) return null;

  const halves = expanded.split("::");
  if (halves.length > 2) return null;

  const splitGroups = (text: string): string[] => (text === "" ? [] : text.split(":"));

  const toGroups = (texts: readonly string[]): number[] | null => {
    const groups: number[] = [];
    for (const text of texts) {
      if (!/^[0-9a-fA-F]{1,4}$/u.test(text)) return null;
      groups.push(Number.parseInt(text, 16));
    }
    return groups;
  };

  let groups: number[];
  if (halves.length === 2) {
    const head = toGroups(splitGroups(halves[0]!));
    const tail = toGroups(splitGroups(halves[1]!));
    if (head === null || tail === null) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  } else {
    const parsed = toGroups(splitGroups(expanded));
    if (parsed === null || parsed.length !== 8) return null;
    groups = parsed;
  }

  return groups;
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** Formats the low 32 bits of an IPv6 address (groups 6 and 7) as a dotted IPv4 quad. */
function ipv4FromTail(high: number, low: number): string {
  return `${(high >>> 8) & 0xff}.${high & 0xff}.${(low >>> 8) & 0xff}.${low & 0xff}`;
}

/**
 * Unwraps the IPv4 address embedded in one of the IPv4-embedded IPv6 forms, or `undefined`
 * when the groups describe no such form.
 *
 * Working on the parsed 32-bit groups makes this independent of the spelling: `::ffff:100.100.100.200`
 * and `::ffff:6464:64c8` are the same address and must be treated identically (N-01).
 *
 * Covered forms:
 * - IPv4-mapped      `::ffff:a.b.c.d`     (`::ffff:0:0/96`)
 * - IPv4-translated  `::ffff:0:a.b.c.d`   (`::ffff:0:0:0/96`)
 * - IPv4-compatible  `::a.b.c.d`          (`::/96`, but never `::` or `::1`)
 * - NAT64 well-known `64:ff9b::a.b.c.d`   (`64:ff9b::/96`)
 *
 * The NAT64 local-use prefix `64:ff9b:1::/48` is deliberately not unwrapped: RFC 6052 places
 * the IPv4 bits at a prefix-length-dependent offset, so a fixed 32-bit tail is not well-defined.
 */
function embeddedIpv4FromGroups(groups: readonly number[]): string | undefined {
  // IPv4-mapped `::ffff:a.b.c.d`.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return ipv4FromTail(groups[6]!, groups[7]!);
  }

  // IPv4-translated `::ffff:0:a.b.c.d` — a distinct prefix from the mapped form above.
  if (
    groups.slice(0, 4).every((group) => group === 0) &&
    groups[4] === 0xffff &&
    groups[5] === 0
  ) {
    return ipv4FromTail(groups[6]!, groups[7]!);
  }

  // IPv4-compatible `::a.b.c.d`; `::` and `::1` keep their unspecified/loopback meaning.
  if (groups.slice(0, 6).every((group) => group === 0)) {
    const unspecified = groups[6] === 0 && groups[7] === 0;
    const loopback = groups[6] === 0 && groups[7] === 1;
    if (!unspecified && !loopback) return ipv4FromTail(groups[6]!, groups[7]!);
  }

  // NAT64 well-known prefix `64:ff9b::/96`.
  if (
    groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0)
  ) {
    return ipv4FromTail(groups[6]!, groups[7]!);
  }

  return undefined;
}

/**
 * Returns the IPv4 address embedded in an IPv4-embedded IPv6 literal, or `undefined` when
 * `address` is not one of the supported forms or not an IPv6 literal at all.
 *
 * Exported so callers and tests can reason about the unwrapping without duplicating the
 * group arithmetic (N-01). Classification always uses the same code path.
 */
export function embeddedIpv4(address: string): string | undefined {
  const bare = stripBrackets(address.trim());
  if (!bare.includes(":")) return undefined;

  const groups = parseIpv6(bare);
  if (groups === null) return undefined;
  return embeddedIpv4FromGroups(groups);
}

/** Canonical host form used for comparisons: lower-case, no IPv6 brackets, no trailing dot. */
function canonicalHost(value: string): string {
  let host = stripBrackets(value.trim()).toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

function classifyIpv4(octets: readonly [number, number, number, number]): IpClass {
  const [a, b] = octets;

  // The whole 0.0.0.0/8 is "this network", not a routable peer (0.0.0.1 included).
  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link_local";
  if (a >= 224 && a <= 239) return "multicast";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  // Carrier-grade NAT: not internet-routable, treated like a private range.
  if (a === 100 && b >= 64 && b <= 127) return "private";
  return "public";
}

function classifyIpv6(groups: readonly number[]): IpClass {
  const first = groups[0]!;
  const allZero = groups.every((group) => group === 0);

  if (allZero) return "unspecified";
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return "loopback";

  // IPv4-embedded forms are unwrapped by `classifyIp` before this function runs, so only
  // native IPv6 prefixes remain here.

  if ((first & 0xffc0) === 0xfe80) return "link_local";
  if ((first & 0xff00) === 0xff00) return "multicast";
  if ((first & 0xfe00) === 0xfc00) return "private";
  // Deprecated IPv6 site-local `fec0::/10` is non-public; treat it like ULA.
  if ((first & 0xffc0) === 0xfec0) return "private";
  return "public";
}

/**
 * Classifies an IPv4 or IPv6 address literal. IPv4-embedded IPv6 addresses are classified by
 * their embedded IPv4 address, so an embedded non-public target can never come out `public`
 * (N-01).
 *
 * Throws a plain `Error` (not `UrlPolicyError`) for malformed input: callers that only pass
 * validated literals should treat a throw as a programming error, not as a policy verdict.
 */
export function classifyIp(address: string): IpClass {
  const bare = stripBrackets(address.trim());

  if (bare.includes(":")) {
    const groups = parseIpv6(bare);
    if (groups === null) throw new Error(`Not an IP address: ${JSON.stringify(address)}`);

    // Whatever the embedded IPv4 spelling, it must obey the exact same rules as a literal.
    const embedded = embeddedIpv4FromGroups(groups);
    if (embedded !== undefined) {
      const octets = parseIpv4(embedded);
      if (octets === null) throw new Error(`Not an IP address: ${JSON.stringify(address)}`);
      return classifyIpv4(octets);
    }

    return classifyIpv6(groups);
  }

  const ipv4 = parseIpv4(bare);
  if (ipv4 === null) throw new Error(`Not an IP address: ${JSON.stringify(address)}`);
  return classifyIpv4(ipv4);
}

/** True when `host` is a valid IPv4 or IPv6 literal (brackets allowed). */
export function isIpLiteral(host: string): boolean {
  const bare = stripBrackets(host.trim());
  if (bare === "") return false;
  if (bare.includes(":")) return parseIpv6(bare) !== null;
  return parseIpv4(bare) !== null;
}

function isMetadataHost(host: string): boolean {
  if (METADATA_HOSTNAMES.includes(host)) return true;
  // Any `metadata.*` name is treated as a metadata service, not just the known suffixes.
  return host.startsWith("metadata.");
}

function sameGroups(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((group, index) => group === right[index]);
}

function isMetadataAddress(address: string): boolean {
  const bare = stripBrackets(address.trim());

  // An embedded IPv4 must be matched against the metadata list, not its IPv6 wrapper (N-01).
  const effective = embeddedIpv4(bare) ?? bare;

  const octets = parseIpv4(effective);
  if (octets !== null) {
    return METADATA_ADDRESSES.some((candidate) => {
      const candidateOctets = parseIpv4(candidate);
      return candidateOctets !== null && sameGroups(candidateOctets, octets);
    });
  }

  // Compare parsed groups so equivalent spellings (`fd00:ec2:0::254`) still match.
  const groups = parseIpv6(effective);
  if (groups === null) return false;
  return METADATA_ADDRESSES.some((candidate) => {
    if (!candidate.includes(":")) return false;
    const candidateGroups = parseIpv6(candidate);
    return candidateGroups !== null && sameGroups(candidateGroups, groups);
  });
}

/** Checks the host against the optional allowlist. Literal IPs match literally only. */
function hostIsAllowed(host: string, allowedHosts: readonly string[] | undefined): boolean {
  if (allowedHosts === undefined || allowedHosts.length === 0) return true;

  for (const entry of allowedHosts) {
    const allowed = canonicalHost(entry);
    if (allowed === "") continue;
    if (allowed.startsWith("*.")) {
      const suffix = allowed.slice(2);
      if (suffix !== "" && host.endsWith(`.${suffix}`)) return true;
      continue;
    }
    if (host === allowed) return true;
  }

  return false;
}

/**
 * Parses and validates the URL shape only (no address or allowlist checks).
 *
 * - only `http:`/`https:` (T86)
 * - no userinfo, query or fragment (T86)
 * - a hostname is required
 * - trailing path slashes are removed; a root base keeps `/` because WHATWG special URLs
 *   cannot represent an empty path (the serialised form stays `https://host/`)
 */
export function normalizeBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlPolicyError("invalid_url", "Base URL is not a valid absolute URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlPolicyError(
      "non_http_scheme",
      `Base URL must use http or https, got ${JSON.stringify(url.protocol)}`,
    );
  }

  const hostname = canonicalHost(url.hostname);
  if (hostname === "") {
    throw new UrlPolicyError("invalid_url", "Base URL has no hostname");
  }

  if (url.username !== "" || url.password !== "") {
    throw new UrlPolicyError("userinfo", "Base URL must not carry a username or password", {
      host: hostname,
    });
  }

  if (url.search !== "") {
    throw new UrlPolicyError("query", "Base URL must not carry a query string", {
      host: hostname,
    });
  }

  if (url.hash !== "") {
    throw new UrlPolicyError("fragment", "Base URL must not carry a fragment", {
      host: hostname,
    });
  }

  if (url.pathname !== "/") {
    url.pathname = url.pathname.replace(/\/+$/u, "");
  }

  return url;
}

/** Applies scheme + address rules to one literal or resolved address. */
function assertAddressAllowed(
  address: string,
  protocol: string,
  allowInsecure: boolean,
  host: string,
): void {
  if (isMetadataAddress(address)) {
    throw new UrlPolicyError("metadata", "Base URL points at a cloud metadata address", {
      host,
      address,
    });
  }

  const kind = classifyIp(address);
  if (kind === "link_local") {
    throw new UrlPolicyError("link_local", "Base URL points at a link-local address", {
      host,
      address,
    });
  }
  if (kind === "unspecified") {
    throw new UrlPolicyError("unspecified", "Base URL points at the unspecified address", {
      host,
      address,
    });
  }
  if (kind === "multicast") {
    throw new UrlPolicyError("multicast", "Base URL points at a multicast address", {
      host,
      address,
    });
  }

  const loopback = kind === "loopback";

  // `http` is only allowed for loopback unless the lab flag is on.
  if (protocol === "http:" && !loopback && !allowInsecure) {
    throw new UrlPolicyError("http_non_loopback", "Plain http is only allowed for loopback", {
      host,
      address,
    });
  }

  // RFC1918/ULA/100.64 targets need the lab flag even over https.
  if (kind === "private" && !allowInsecure) {
    throw new UrlPolicyError(
      "private_without_allow_insecure",
      "Private address requires allowInsecure",
      { host, address },
    );
  }
}

/**
 * Validates a federation base URL and returns the parsed URL plus the addresses it was
 * checked against.
 *
 * Literal hosts are checked directly. When a `resolver` is supplied, every address it
 * returns is checked with the same rules (DNS rebinding); an empty or throwing resolver is
 * `unresolvable_host`. Without a resolver, a non-literal `http` host cannot be proven to be
 * loopback and is therefore rejected unless `allowInsecure` is set.
 */
export async function checkBaseUrl(
  raw: string,
  options: BaseUrlPolicyOptions = {},
): Promise<CheckedBase> {
  const url = normalizeBaseUrl(raw);
  const hostname = canonicalHost(url.hostname);
  const allowInsecure = options.allowInsecure === true;

  // Metadata names win over the allowlist: allowing a metadata host must not unlock it.
  if (isMetadataHost(hostname)) {
    throw new UrlPolicyError("metadata", "Base URL points at a cloud metadata host", {
      host: hostname,
    });
  }

  if (!hostIsAllowed(hostname, options.allowedHosts)) {
    throw new UrlPolicyError("host_not_allowed", "Base URL host is not in the allowlist", {
      host: hostname,
    });
  }

  if (isIpLiteral(hostname)) {
    assertAddressAllowed(hostname, url.protocol, allowInsecure, hostname);
    return { url, hostname, addresses: [hostname] };
  }

  if (options.resolver !== undefined) {
    let resolved: readonly string[];
    try {
      resolved = await options.resolver(hostname);
    } catch {
      throw new UrlPolicyError("unresolvable_host", "Base URL host could not be resolved", {
        host: hostname,
      });
    }

    if (resolved.length === 0) {
      throw new UrlPolicyError("unresolvable_host", "Base URL host resolved to no addresses", {
        host: hostname,
      });
    }

    const addresses: string[] = [];
    const seen = new Set<string>();
    for (const address of resolved) {
      if (!isIpLiteral(address)) {
        throw new UrlPolicyError(
          "unresolvable_host",
          "Resolver returned a value that is not an IP address",
          { host: hostname, address },
        );
      }
      if (seen.has(address)) continue;
      seen.add(address);
      addresses.push(address);
      assertAddressAllowed(address, url.protocol, allowInsecure, hostname);
    }

    return { url, hostname, addresses };
  }

  // Offline mode: only a literal loopback host can justify plain http.
  if (url.protocol === "http:" && !allowInsecure) {
    throw new UrlPolicyError(
      "http_non_loopback",
      "Plain http is only allowed for a literal loopback host without a resolver",
      { host: hostname },
    );
  }

  return { url, hostname, addresses: [] };
}

/**
 * Creates a resolver backed by `node:dns/promises`.
 *
 * The import is dynamic so the module graph stays browser-safe. `lookup` with `all: true`
 * returns every address (both families where the platform provides them); duplicates are
 * removed while preserving order.
 *
 * `node:dns` has no cancellable lookup, so the deadline is a race: without it a broken
 * resolver could hold the request open forever, which is exactly the SSRF pre-flight a
 * hostile network wants to stall. A rejection here is mapped to `unresolvable_host`
 * (fail closed) by {@link checkBaseUrl}.
 */
export function createDnsResolver(
  options: { timeoutMs?: number } = {},
): HostResolver {
  const timeoutMs =
    typeof options.timeoutMs === "number" && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_DNS_TIMEOUT_MS;

  return async (hostname: string): Promise<readonly string[]> => {
    const dns = await import("node:dns/promises");

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`DNS lookup for ${JSON.stringify(hostname)} timed out`)),
        timeoutMs,
      );
      // The deadline must not keep the process (or a test runner) alive on its own.
      (timer as { unref?: () => void }).unref?.();
    });

    const addresses: string[] = [];
    try {
      /* `lookup` is typed with overloads; the `all: true` call always yields the array shape. */
      const lookup = dns.lookup(hostname, { all: true }) as Promise<
        ReadonlyArray<{ address: string }>
      >;
      const results = await Promise.race([lookup, deadline]);

      const seen = new Set<string>();
      for (const result of results) {
        if (seen.has(result.address)) continue;
        seen.add(result.address);
        addresses.push(result.address);
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return addresses;
  };
}
