#!/usr/bin/env node
/**
 * Size guard (NFR-3).
 *
 * The headline budget is the **core** bundle (`dist/bluepencil.core.js`) — the same build with the
 * four built-in adapters aliased to a stub. The full browser bundles (IIFE and the custom-element
 * module) carry the adapters and both language tables, so they are measured against their own
 * budgets. The attach loader has a separate gate (FR-17).
 *
 * The budget is a snapshot, not a target. Rule (spec G4):
 * Core = measured + 10 %, IIFE = measured + 1.5 kB, Element = measured + 1.5 kB; the attach loader
 * stays separate. Measurement date:
 * **2026-11-03** (release cut, after the voice removal in G13), minified + gzip:
 *
 *   core    40.7 kB → budget 44.7 kB
 *   IIFE    44.4 kB → budget 45.9 kB
 *   element 47.6 kB → budget 49.1 kB
 *   attach   4.1 kB → unchanged 8 kB ceiling (separate gate)
 *
 * Numbers are never raised preventively: an increase needs a decision, a reason in the PR and a
 * fresh measurement. A temporary overshoot fails.
 *
 * Exits non-zero on any violation so CI can fail.
 */
import { gzipSync } from "node:zlib";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const KB = 1024;

/** The date the budgets below were derived from (NFR-3 headline carries the same date). */
export const MEASUREMENT_DATE = "2026-11-03";

/** Minified+gzip size of each measured artifact, in bytes, on {@link MEASUREMENT_DATE}. */
export const MEASURED_GZIP_BYTES = Object.freeze({
  core: 41640,
  attach: 4227,
  iife: 45496,
  element: 48709,
});

/** The rule's headroom over a measurement: 10 % for the core, +1.5 kB for IIFE and element. */
const IIFE_ELEMENT_HEADROOM = 1.5 * KB;

const measured = MEASURED_GZIP_BYTES;

/**
 * The checks, derived mechanically from the measurement above so the rule cannot drift from the
 * numbers by hand. The attach loader keeps its own 8 kB ceiling (FR-17): it ships to hosts that
 * take no bundler, so it must stay a rounding error.
 */
export const CHECKS = Object.freeze([
  {
    file: join(root, "dist/bluepencil.core.js"),
    budget: Math.round(measured.core * 1.1),
    label: "core without adapters (NFR-3)",
  },
  {
    file: join(root, "dist/attach.js"),
    budget: 8 * KB,
    label: "attach loader (FR-17)",
  },
  {
    file: join(root, "dist/bluepencil.iife.js"),
    budget: measured.iife + IIFE_ELEMENT_HEADROOM,
    label: "IIFE incl. adapters + en/de",
  },
  {
    file: join(root, "dist/bluepencil.element.js"),
    budget: measured.element + IIFE_ELEMENT_HEADROOM,
    label: "custom element incl. adapters + en/de",
  },
]);

/**
 * Measure one check.
 *
 * @param {{ file: string, budget: number, label: string }} check
 * @returns {null | { label: string, rawBytes: number, gzipBytes: number, budget: number, over: boolean }}
 *   `null` when the artifact is missing.
 */
export function measure(check) {
  if (!existsSync(check.file)) return null;
  const raw = readFileSync(check.file);
  const gzipBytes = gzipSync(raw, { level: 9 }).length;
  return {
    label: check.label,
    rawBytes: raw.length,
    gzipBytes,
    budget: check.budget,
    over: gzipBytes > check.budget,
  };
}

/**
 * Run the guard.
 *
 * @param {ReadonlyArray<{ file: string, budget: number, label: string }>} [checks]
 * @param {(line: string) => void} [log]
 * @returns {boolean} `false` when any artifact is missing or over budget.
 */
export function run(checks = CHECKS, log = console.log) {
  let failed = false;
  for (const check of checks) {
    const result = measure(check);
    if (result === null) {
      log(`[size] missing build artifact: ${check.file} — run "npm run build" first`);
      failed = true;
      continue;
    }
    const pct = ((result.gzipBytes / result.budget) * 100).toFixed(1);
    log(
      `[size] ${result.label}: ${(result.rawBytes / KB).toFixed(1)} kB raw, ` +
        `${(result.gzipBytes / KB).toFixed(1)} kB gzip of ${(result.budget / KB).toFixed(1)} kB ` +
        `(${pct}%) — ${result.over ? "OVER BUDGET" : "ok"}`,
    );
    if (result.over) failed = true;
  }
  return !failed;
}

/**
 * True only when this file is the process entry point.
 *
 * `import.meta.url` resolves to the real path while `process.argv[1]` keeps the symlink path, so a
 * direct `===` comparison is fail-open through a symlink: the guard would silently do nothing and
 * exit 0. Compare realpaths instead; a broken link (realpath throws) is "not direct", never a false OK.
 *
 * @returns {boolean}
 */
function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

// Only execute when invoked directly (`node scripts/size-guard.mjs`); importing the module (e.g.
// from `tests/unit/size-guard.test.ts`) must stay side-effect-free.
if (isDirectRun()) {
  process.exit(run() ? 0 : 1);
}
