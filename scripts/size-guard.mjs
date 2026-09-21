#!/usr/bin/env node
/**
 * Size guard (NFR-3).
 *
 * The requirement budgets the **core** bundle at ≤ 33 kB minified+gzipped and explicitly excludes
 * the adapters, so the hard check runs against `dist/bluepencil.core.js` — the same build with the
 * four built-in adapters aliased to a stub. The full browser bundles (IIFE and the custom-element
 * module, which carry the adapters and both language tables) are measured against a separate,
 * deliberately larger budget so a regression there still fails the build.
 *
 * Raised from 30 kB to 31 kB for the host-facing capability set (FR-1.11/1.12, FR-12.9/12.10/12.13),
 * measured at 30.5 kB. Raised again to 33 kB for the transient container reveal feature (issue #20)
 * and the app/build-ref/exportedBy bundle metadata (issue #21), measured at 31.9 kB, i.e. 96.6% of
 * the new budget — the guard is meant to catch *drift*, and this was a decision, so the number
 * moved openly instead of being worked around.
 *
 * Exits non-zero on any violation so CI can fail.
 */
import { gzipSync } from "node:zlib";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const KB = 1024;

const checks = [
  {
    file: join(root, "dist/bluepencil.core.js"),
    // Raised from 30 kB for the host-facing capability set (FR-1.11/1.12, FR-12.9/12.10/12.13) — see
    // the header. Keep this number honest: it is the line between "we decided" and "it drifted".
    budget: 33 * KB,
    label: "core without adapters (NFR-3)",
  },
  {
    // FR-17: the loader ships to hosts that take no bundler — it must stay a rounding error.
    file: join(root, "dist/attach.js"),
    budget: 8 * KB,
    label: "attach loader (FR-17)",
  },
  {
    file: join(root, "dist/bluepencil.iife.js"),
    budget: 40 * KB,
    label: "IIFE incl. adapters + en/de",
  },
  {
    file: join(root, "dist/bluepencil.element.js"),
    budget: 40 * KB,
    label: "custom element incl. adapters + en/de",
  },
];

let failed = false;
for (const check of checks) {
  if (!existsSync(check.file)) {
    console.error(`[size] missing build artifact: ${check.file} — run "npm run build" first`);
    failed = true;
    continue;
  }
  const raw = readFileSync(check.file);
  const gz = gzipSync(raw, { level: 9 });
  const pct = ((gz.length / check.budget) * 100).toFixed(1);
  const over = gz.length > check.budget;
  console.log(
    `[size] ${check.label}: ${(raw.length / KB).toFixed(1)} kB raw, ` +
      `${(gz.length / KB).toFixed(1)} kB gzip of ${(check.budget / KB).toFixed(0)} kB (${pct}%) — ` +
      `${over ? "OVER BUDGET" : "ok"}`,
  );
  if (over) failed = true;
}

process.exit(failed ? 1 : 0);
