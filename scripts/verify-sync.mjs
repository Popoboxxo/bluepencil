#!/usr/bin/env node
/**
 * CLI for the build-sync identity gate (BUILD_SYNC_GUARD Baustein 1, `npm run verify:sync`).
 *
 * Reads the four build inputs, delegates the comparison to the pure `scripts/lib/verify-sync.mjs`
 * logic, and turns the result into an exit code for CI. The element bundle is hashed here (not in
 * the lib) so the pure module stays filesystem-free and unit-testable.
 *
 * Read failures degrade to `null` rather than throwing: a missing input is reported as a specific
 * gate error instead of an unhandled stack trace. Exit 0 = lockstep intact, exit 1 = violation.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256File, verifySyncState } from "./lib/verify-sync.mjs";

// Repo root = parent of scripts/ (this file lives in scripts/), same anchor as size-guard.mjs.
const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Parse a JSON file, or return `null` when it is missing/unreadable/invalid. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Run the gate and return the process exit code (0 = ok, 1 = violation).
 * @returns {number}
 */
export function run() {
  const elementPath = join(root, "dist/bluepencil.element.iife.js");
  const present = existsSync(elementPath);

  let sha256 = null;
  if (present) {
    try {
      sha256 = sha256File(elementPath);
    } catch {
      // Present but unreadable — keep going; the comparison below still needs a `null` hash.
      sha256 = null;
    }
  }

  const element = { present, sha256 };
  const buildInfo = readJson(join(root, "extension/dist/build-info.json"));
  const manifest = readJson(join(root, "extension/manifest.json"));
  const pkg = readJson(join(root, "package.json"));

  const { ok, errors } = verifySyncState({ element, buildInfo, manifest, pkg });

  if (!ok) {
    for (const error of errors) console.error(`[verify-sync] ${error}`);
    return 1;
  }

  // On success all three versions agree, so any present source is the version to report.
  const version = pkg?.version ?? manifest?.version ?? buildInfo?.version ?? "unknown";
  const shortSha = (sha256 ?? "").slice(0, 8);
  console.log(
    `[verify-sync] OK — dist bundle matches extension/dist (version ${version}, sha256 ${shortSha}…)`,
  );
  return 0;
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

// Only execute when invoked directly (`node scripts/verify-sync.mjs`); importing the wrapper (e.g.
// from a future test) must stay side-effect-free.
if (isDirectRun()) {
  try {
    process.exit(run());
  } catch (error) {
    console.error(`[verify-sync] unexpected error: ${error?.message ?? error}`);
    process.exit(1);
  }
}
