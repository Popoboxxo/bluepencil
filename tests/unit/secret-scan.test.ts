/**
 * @vitest-environment node — drives the real scanner module, not a re-implementation of its regexes.
 *
 * The scanner must stay noisy-free (identifier names are not credentials) without losing its teeth
 * (a real credential is still a finding). The module is plain, untyped ESM resolved by URL, the
 * same pattern `ci-pins.test.ts` uses for `scripts/`.
 *
 * Every secret-shaped fixture below is assembled from fragments: this file is itself scanned, and
 * a test that ships the secret it tests for would be the very bug it guards against.
 */
import { describe, expect, it } from "vitest";

interface Finding {
  line: number;
  name: string;
}

interface ScanModule {
  scanText(text: string): Finding[];
  NON_SECRET_LITERALS: Map<string, string>;
}

const scanModuleUrl: string = new URL("../../scripts/secret-scan.mjs", import.meta.url).href;
const { scanText, NON_SECRET_LITERALS } = (await import(scanModuleUrl)) as ScanModule;

/** Concatenates fragments so no single line in this file contains a complete secret shape. */
const s = (...parts: string[]): string => parts.join("");
const names = (text: string): string[] => scanText(text).map((finding) => finding.name);

const FALSE_POSITIVES: Array<[string, string]> = [
  [
    "protocol header name (source)",
    'export const AUTH_HEADER_SECRET = "x-bluepencil-auth";',
  ],
  [
    "environment-variable name",
    '  clientSecret: "WEBSTORE_CLIENT_SECRET",',
  ],
  [
    "test fixture secret name",
    'const response = call("GET", "/notes", { host: "evil.example" }, { authSecret: "hub-host-check-secret" });',
  ],
  [
    "CLI flag name, deliberately empty value",
    'expect(String(parse(["--auth-secret="]))).toContain("must not be empty");',
  ],
  [
    "CLI flag name in a longer assertion",
    'expect(String(parse(["--auth-secret="]))).not.toContain("secret_too_short");',
  ],
  [
    "same header name in the spec document",
    'export const AUTH_HEADER_SECRET = "x-bluepencil-auth";',
  ],
];

const REAL_SECRETS: Array<[string, string, string]> = [
  ["password assignment", s('pass', 'word = "hunt', 'er2-real-value"'), "password literal"],
  [
    "env-style database secret",
    s('DATABASE_SECRET = "prod-', 'z9Qx7Lm2Np4R"'),
    "password literal",
  ],
  [
    "screaming-snake value that is not allowlisted",
    s('pass', 'word = "PROD', '_DB_PASSWORD"'),
    "password literal",
  ],
  ["AWS access key", s('const key = "AKIA', 'IOSFODNN7EXAMPLE";'), "AWS access key"],
  ["GitHub token", s('token: "ghp_', "A".repeat(36), '"'), "GitHub token"],
  [
    "private key block",
    s("-----BEGIN ", "RSA PRIVATE KEY-----", "\\nMIIE..."),
    "private key block",
  ],
  [
    "connection string",
    s('url = "postgres://', "user:hunter2@", 'db.internal/app"'),
    "connection string",
  ],
];

describe("secret scan: identifier names are not findings", () => {
  it.each(FALSE_POSITIVES)("passes the %s", (_label, line) => {
    expect(names(line)).toEqual([]);
  });

  it("keeps a reason for every allowlisted literal", () => {
    expect(NON_SECRET_LITERALS.size).toBeGreaterThan(0);
    for (const [value, reason] of NON_SECRET_LITERALS) {
      expect(value.length).toBeGreaterThan(0);
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("does not extend the allowlist to a near-miss value", () => {
    const nearMiss = s('AUTH_HEADER_SECRET = "', "x-bluepencil-auth", '-typo"');
    expect(names(nearMiss)).toEqual(["password literal"]);
  });

  it("does not extend the fixture allowlist to a near-miss value", () => {
    const nearMiss = s('authSecret: "hub', "-host-check-secret", '-2"');
    expect(names(nearMiss)).toEqual(["password literal"]);
  });
});

describe("secret scan: real credentials still fail", () => {
  it.each(REAL_SECRETS)("flags a %s", (_label, text, expected) => {
    expect(names(text)).toContain(expected);
  });

  it("reports the correct line for a multi-line file", () => {
    const text = ["const a = 1;", "// nothing here", s('pass', 'word = "hunt', 'er2-real-value"')].join(
      "\n",
    );
    expect(scanText(text)).toEqual([{ line: 3, name: "password literal" }]);
  });
});
