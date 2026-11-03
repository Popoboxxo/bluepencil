/**
 * @vitest-environment node — reads the real `vitest.config.ts` and `package.json` from disk.
 *
 * AC-F09 asks for coverage to be *informational*: a number a reviewer can look at, never a gate.
 * That promise is easy to state and easy to break later — a well-meaning `thresholds` block turns
 * every commit into a budget negotiation, and an `enabled: true` default makes the plain `npm test`
 * gate pay for a report nobody asked for. Both regressions are visible in the config text, so this
 * suite asserts on the source rather than running coverage inside a test (a nested coverage run
 * would roughly double the gate and report on the reporter itself).
 *
 * The version pairing check is the other half: `@vitest/coverage-v8` is a companion package that
 * must track `vitest`'s major.minor. A drifted pin fails at run time with an unhelpful error, so it
 * is cheaper to catch it here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const readRepoFile = (relativePath: string): string => readFileSync(new URL(relativePath, root), "utf8");

const configSource = readRepoFile("vitest.config.ts");
const pkg = JSON.parse(readRepoFile("package.json")) as {
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies: Record<string, string>;
};

/**
 * The `coverage: { ... }` object literal, from its opening brace to the matching close. The config
 * has no nested braces inside that block today; the scan still tracks depth so a future nested
 * object does not silently truncate what we assert on.
 */
function coverageBlock(source: string): string {
  const start = source.indexOf("coverage:");
  expect(start).toBeGreaterThan(-1);
  const open = source.indexOf("{", start);
  expect(open).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error("unbalanced coverage block in vitest.config.ts");
}

const block = coverageBlock(configSource);

describe("coverage config is informational only (AC-F09)", () => {
  it("uses the v8 provider", () => {
    expect(block).toMatch(/provider:\s*"v8"/);
  });

  it("is disabled by default, so `npm test` does not pay for a report", () => {
    expect(block).toMatch(/enabled:\s*false/);
    // No stray `enabled: true` anywhere in the coverage block.
    expect(block).not.toMatch(/enabled:\s*true/);
  });

  it("emits the text table and the machine-readable summary", () => {
    // Vitest 5 spells this key `reporter` (singular) for coverage; `reporters` is the *test* key
    // and is silently ignored here, which once produced the default html/clover/json set instead.
    expect(block).toMatch(/reporter:\s*\[[^\]]*"text"/);
    expect(block).toMatch(/reporter:\s*\[[^\]]*"json-summary"/);
  });

  it("declares no thresholds and no per-file budget", () => {
    expect(block).not.toMatch(/thresholds\s*:/);
    expect(block).not.toMatch(/perFile\s*:/);
    // A bare `statements: 80` style threshold is also a gate, even without the `thresholds` wrapper.
    // Only `reportsDirectory`/`reporter`/`provider`-shaped keys belong in this block.
    expect(block).not.toMatch(/\b(statements|branches|functions|lines)\s*:\s*\d/);
  });
});

describe("the coverage script and its dependency", () => {
  it("exposes `npm run test:coverage` as an opt-in run", () => {
    expect(pkg.scripts["test:coverage"]).toBe("vitest run --coverage");
    // The default gate stays coverage-free.
    expect(pkg.scripts.test).toBe("vitest run");
  });

  it("keeps the coverage provider as a devDependency and runtime dependencies empty", () => {
    const vitestRange = pkg.devDependencies.vitest ?? "";
    const coverageRange = pkg.devDependencies["@vitest/coverage-v8"] ?? "";
    expect(vitestRange).not.toBe("");
    expect(coverageRange).not.toBe("");
    expect(pkg.dependencies ?? {}).toEqual({});

    // Companion package: same major.minor as `vitest` (patch may differ).
    const majorMinor = (range: string): string => (range.match(/\d+\.\d+/) ?? [""])[0];
    expect(majorMinor(coverageRange)).toBe(majorMinor(vitestRange));
  });
});
