/**
 * Pure logic for the version-bump gate (BUILD_SYNC_GUARD Baustein 2).
 *
 * `package.json` is the version single source of truth (SSOT), but it is easy to touch shippable
 * code — the library sources, the element build, the shipped extension sources and static files or
 * the reference server — without bumping it, leaving the manifest, the extension bundle and the
 * store release describing a different binary than the one under review. This gate blocks such a
 * change: any behavioural diff must come with a changed `package.json` version.
 *
 * Side-effect-free by design: the vitest suite imports these functions, and
 * `scripts/check-version-bump.mjs` is only the thin CLI that shells out to `git`.
 */

/**
 * Directory roots whose contents end up in a shipped artifact. Every entry ends with `/` — the
 * prefix loop in `isBehaviouralPath` only accepts a trailing slash, so a bare `startsWith` cannot
 * treat `srcfoo/` as `src/`. Standalone shipped files that share no such root are listed in
 * `SHIPPED_EXACT_FILES` instead.
 */
export const BEHAVIOURAL_PREFIXES = [
  "src/",
  // Listed for spec traceability — already subsumed by the "src/" prefix.
  "src/element/",
  "extension/src/",
  "server/",
];

/**
 * Individual files that ship verbatim in an artifact and are not covered by a
 * `BEHAVIOURAL_PREFIXES` directory root. `extension/build.mjs` copies both the MV3 manifest and the
 * options page as-is, so touching either ships a new build and must bump the version. Exact-match
 * only — the extension's build tooling (`build.mjs`, `smoke.mjs`, `probe.mjs`, `tsconfig.json`) is
 * deliberately absent.
 */
export const SHIPPED_EXACT_FILES = ["extension/manifest.json", "extension/options.html"];

/**
 * Decide whether a single changed path is behavioural (i.e. ships in a build artifact).
 *
 * A leading `./` (as some git/diff producers emit) is stripped before matching. Exact shipped files
 * are matched against `SHIPPED_EXACT_FILES`; directory roots against `BEHAVIOURAL_PREFIXES`.
 * Non-string input — e.g. an `undefined` slot in a sparse diff array — is not behavioural rather
 * than a crash.
 *
 * @param {string|undefined|null} file
 * @returns {boolean}
 */
export function isBehaviouralPath(file) {
  if (typeof file !== "string") return false;
  const normalized = file.startsWith("./") ? file.slice(2) : file;
  if (SHIPPED_EXACT_FILES.includes(normalized)) return true;
  return BEHAVIOURAL_PREFIXES.some(
    (prefix) => prefix.endsWith("/") && normalized.startsWith(prefix),
  );
}

/**
 * Filter a diff's changed-file list down to the behavioural paths, preserving input order.
 * Tolerates `null`/`undefined` (no diff) and stray non-string entries.
 *
 * @param {Array<string|undefined|null>|null|undefined} files
 * @returns {string[]}
 */
export function behaviouralFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.filter((file) => isBehaviouralPath(file));
}

/**
 * Evaluate the gate for one merge-base..HEAD diff.
 *
 * Rules: no behavioural change is always fine; a behavioural change is fine only when the version
 * moved. Equal versions (including two `undefined`s from an unreadable base) on a behavioural diff
 * are the failure the gate exists to catch.
 *
 * @param {object} [input]
 * @param {Array<string|undefined|null>|null|undefined} [input.changedFiles]
 * @param {string} [input.baseVersion] version at the merge base
 * @param {string} [input.headVersion] version at HEAD
 * @returns {{ ok: boolean, behavioural: string[], reason: string }}
 */
export function evaluateVersionBump({ changedFiles, baseVersion, headVersion } = {}) {
  const behavioural = behaviouralFiles(changedFiles);

  if (behavioural.length === 0) {
    return { ok: true, behavioural: [], reason: "no behavioural files changed" };
  }

  if (headVersion !== baseVersion) {
    return {
      ok: true,
      behavioural,
      reason:
        `behavioural files changed (${behavioural.length}) and version bumped ` +
        `${baseVersion} → ${headVersion}`,
    };
  }

  return {
    ok: false,
    behavioural,
    reason:
      `${behavioural.length} behavioural file(s) changed but package.json version is unchanged ` +
      `(${headVersion}) — bump the "version" in package.json`,
  };
}
