#!/usr/bin/env node
/**
 * CLI for the version-bump gate (BUILD_SYNC_GUARD Baustein 2).
 *
 * Diffs the merge base of a base ref against HEAD and fails when behavioural paths changed without
 * a `package.json` version bump. The comparison itself lives in the pure
 * `scripts/lib/version-bump.mjs`; this wrapper only shells out to `git`.
 *
 * The guard must never break a local run because the base ref is unavailable (shallow clone, no
 * `origin` remote, detached HEAD): every git/read failure degrades to a warning and exit 0. CI is
 * expected to have the ref, so the gate still fails there on a real violation.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateVersionBump } from "./lib/version-bump.mjs";

// Repo root = parent of scripts/ (this file lives in scripts/), same anchor as size-guard.mjs.
const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Parse `--base <ref>` / `--base=<ref>`; defaults to `origin/main`. */
function parseArgs(argv) {
  let base = "origin/main";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base") {
      if (argv[i + 1]) {
        base = argv[i + 1];
        i += 1;
      }
    } else if (arg.startsWith("--base=")) {
      const value = arg.slice("--base=".length);
      if (value) base = value;
    }
  }
  return { base };
}

/** Run git and capture stdout as a string. Throws on a non-zero exit. */
function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

/**
 * Run the gate and return the process exit code.
 * @param {string[]} [argv] CLI args after `node <script>` (defaults to `process.argv.slice(2)`).
 * @returns {number}
 */
export function run(argv = process.argv.slice(2)) {
  const { base } = parseArgs(argv);

  // Resolve the base ref to a concrete SHA. An unresolvable ref (local runs, shallow CI) is a
  // skip, not a failure — the gate has nothing to compare against.
  let mergeBase;
  try {
    mergeBase = git(["rev-parse", "--verify", "--quiet", base]).trim();
  } catch {
    console.warn(`[check-version-bump] base ref "${base}" is not resolvable — skipping`);
    return 0;
  }
  if (!mergeBase) {
    console.warn(`[check-version-bump] base ref "${base}" is not resolvable — skipping`);
    return 0;
  }

  // Three-dot diff: only what HEAD added on top of the merge base, not what the base gained.
  let changedFiles;
  try {
    changedFiles = git(["diff", "--name-only", `${mergeBase}...HEAD`])
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    console.warn(`[check-version-bump] cannot diff against "${base}" — skipping`);
    return 0;
  }

  // Base version comes from the base ref's package.json (the version the PR started from).
  let baseVersion;
  try {
    baseVersion = JSON.parse(git(["show", `${mergeBase}:package.json`])).version;
  } catch {
    console.warn(`[check-version-bump] cannot read package.json at "${base}" — skipping`);
    return 0;
  }

  // Head version comes from the working-tree package.json (the version the PR proposes).
  let headVersion;
  try {
    headVersion = JSON.parse(readFileSync(`${root}/package.json`, "utf8")).version;
  } catch {
    console.warn("[check-version-bump] cannot read package.json at HEAD — skipping");
    return 0;
  }

  const { ok, behavioural, reason } = evaluateVersionBump({
    changedFiles,
    baseVersion,
    headVersion,
  });

  if (ok) {
    console.log(`[check-version-bump] OK — ${reason}`);
    return 0;
  }

  console.error(`[check-version-bump] ${reason}`);
  console.error("[check-version-bump] behavioural files touched:");
  for (const file of behavioural) console.error(`[check-version-bump]   ${file}`);
  console.error(
    `[check-version-bump] bump the "version" in package.json (currently ${headVersion}) and re-run`,
  );
  return 1;
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

// Only execute when invoked directly; importing the wrapper must stay side-effect-free.
if (isDirectRun()) {
  try {
    process.exit(run());
  } catch (error) {
    console.error(`[check-version-bump] unexpected error: ${error?.message ?? error}`);
    process.exit(1);
  }
}
