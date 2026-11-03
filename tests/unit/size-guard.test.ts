/**
 * @vitest-environment node — reads `scripts/size-guard.mjs` and writes a temporary artifact; no DOM.
 *
 * AC-F07: the size guard's header and thresholds follow the release-cut measurement rule, and a
 * temporary overshoot fails. The guard is plain, untyped ESM, resolved by URL so no hand-written
 * `.d.mts` can drift from it — the same pattern `ci-pins.test.ts` uses.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

interface Check {
  readonly file: string;
  readonly budget: number;
  readonly label: string;
}

interface SizeGuardModule {
  MEASUREMENT_DATE: string;
  MEASURED_GZIP_BYTES: Readonly<Record<"core" | "attach" | "iife" | "element", number>>;
  CHECKS: ReadonlyArray<Check>;
  run(checks?: ReadonlyArray<Check>, log?: (line: string) => void): boolean;
}

const moduleUrl: string = new URL("../../scripts/size-guard.mjs", import.meta.url).href;
const { MEASUREMENT_DATE, MEASURED_GZIP_BYTES, CHECKS, run } = (await import(
  moduleUrl
)) as SizeGuardModule;

const source = readFileSync(new URL("../../scripts/size-guard.mjs", import.meta.url), "utf8");
const KB = 1024;

const byLabel = (fragment: string): Check => {
  const check = CHECKS.find((entry) => entry.label.includes(fragment));
  if (check === undefined) throw new Error(`size-guard has no check labelled "${fragment}"`);
  return check;
};

const dir = mkdtempSync(join(tmpdir(), "bp-size-guard-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("size guard — the release-cut rule (AC-F07)", () => {
  it("names the measurement date and the measured values in its header", () => {
    expect(MEASUREMENT_DATE).toBe("2026-11-03");
    expect(source).toContain("2026-11-03");
    expect(source).toContain("Core = measured + 10 %");
    expect(source).toContain("IIFE = measured + 1.5 kB");
    expect(source).toContain("Element = measured + 1.5 kB");
    // The headline states the numbers the budgets were derived from.
    expect(source).toContain("40.7 kB");
    expect(source).toContain("44.4 kB");
    expect(source).toContain("47.6 kB");
  });

  it("derives the core budget as measured + 10 %", () => {
    expect(byLabel("core without adapters").budget).toBe(Math.round(MEASURED_GZIP_BYTES.core * 1.1));
  });

  it("derives the IIFE and element budgets as measured + 1.5 kB", () => {
    expect(byLabel("IIFE").budget).toBe(MEASURED_GZIP_BYTES.iife + 1.5 * KB);
    expect(byLabel("custom element").budget).toBe(MEASURED_GZIP_BYTES.element + 1.5 * KB);
  });

  it("keeps the attach loader on its separate ceiling", () => {
    expect(byLabel("attach loader").budget).toBe(8 * KB);
  });

  it("fails a temporary overshoot and passes the same artifact under a larger budget", () => {
    const artifact = join(dir, "artifact.js");
    // Random bytes do not compress; 512 of them are well over a 16-byte budget.
    writeFileSync(artifact, Buffer.from(Array.from({ length: 512 }, () => Math.random() * 256)));

    const lines: string[] = [];
    const tight = run([{ file: artifact, budget: 16, label: "overshoot fixture" }], (line) =>
      lines.push(line),
    );
    expect(tight).toBe(false);
    expect(lines.join("\n")).toContain("OVER BUDGET");

    const roomy = run([{ file: artifact, budget: KB, label: "overshoot fixture" }], () => {});
    expect(roomy).toBe(true);
  });

  it("fails when an artifact is missing", () => {
    const lines: string[] = [];
    const ok = run([{ file: join(dir, "absent.js"), budget: KB, label: "missing fixture" }], (line) =>
      lines.push(line),
    );
    expect(ok).toBe(false);
    expect(lines.join("\n")).toContain("missing build artifact");
  });
});
