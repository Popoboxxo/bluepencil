#!/usr/bin/env node
/**
 * Opt-in installer for the repository's git hooks.
 *
 * WHY this exists: the pre-push guard (.githooks/pre-push) only runs once git is
 * told where the hooks live. Instead of copying hook files into .git/hooks (which
 * is invisible to version control and drifts), we point `core.hooksPath` at the
 * checked-in `.githooks/` directory. The guard is a CONVENTION boundary - it
 * fail-closed blocks accidental pushes of a stale extension bundle, but is not a
 * security boundary (see .claude/rules/branch-guard.md).
 *
 * WHY it is manual: `package.json` "prepare" deliberately does NOT call this
 * script. Auto-installing hooks on every `npm install` would silently mutate a
 * developer's git config, so enabling the guard stays an explicit choice.
 *
 * Usage:
 *   node scripts/install-hooks.mjs
 * Undo:
 *   git config --unset core.hooksPath
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True only when this file is the process entry point.
 *
 * `import.meta.url` resolves to the real path while `process.argv[1]` keeps the symlink path, so a
 * direct `===` comparison is fail-open through a symlink: importing this module would silently mutate
 * `core.hooksPath`. Compare realpaths instead; a broken link (realpath throws) is "not direct".
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

function main() {
  try {
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], {
      stdio: "inherit",
    });
  } catch (error) {
    // Fail loud: git missing or not a repository must never look like success.
    console.error(
      "[hooks] failed to set core.hooksPath - is git installed and this a git repo?",
    );
    console.error(`[hooks] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  console.log("[hooks] core.hooksPath = .githooks (pre-push guard enabled)");
  console.log("[hooks] undo with: git config --unset core.hooksPath");
}

// Only run the git-config side effect when invoked directly; importing must do nothing.
if (isDirectRun()) {
  main();
}
