/**
 * SHA pin check for GitHub Actions (SEC-22, AC-I01).
 *
 * A tag is a movable pointer. `uses: actions/checkout@v7` is whatever the action's authors decide
 * that ref means today, so a workflow is only as reproducible as the ref it names — and a hijacked
 * or force-pushed tag runs new code with this repository's token and secrets. A 40-hex commit SHA
 * cannot move. The tag stays as a trailing comment, because a bare hash is unreadable and
 * unreviewable; Dependabot bumps the SHA and the comment together (`.github/dependabot.yml`).
 *
 * Rule, applied to every `uses:` line in `.github/workflows/`:
 *
 *   uses: owner/action@<40 lowercase hex>   # vX.Y.Z
 *
 * Local actions (`uses: ./path`) need no pin — they are the repository. Container actions
 * (`uses: docker://…`) would need a digest pin instead and are reported as violations rather than
 * silently accepted; none are used today.
 *
 * No dependencies (NFR-4). Exits 1 with one line per offending ref.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

export const DEFAULT_DIR = join(root, ".github", "workflows");

/** `owner/repo@<40 hex>` and nothing else after it. */
const PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/;
/** The tag comment must name a version, so a reader can tell what the hash is. */
const TAG_COMMENT = /#\s*v\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.]+)?\s*$/;
const USES = /^(\s*-?\s*uses:\s*)(.+?)\s*$/;

/**
 * @typedef {{ file: string, line: number, reason: string, text: string }} Violation
 */

/**
 * Inspect one workflow document. Pure so the negative test does not need a fixture tree.
 * @param {string} source
 * @param {string} file label for the report
 * @returns {Violation[]}
 */
export function checkSource(source, file) {
  /** @type {Violation[]} */
  const violations = [];
  source.split("\n").forEach((raw, index) => {
    const match = USES.exec(raw);
    if (!match) return;
    const [, prefix, rest] = match;

    // Split the trailing comment off before judging the ref: `@v7 # v7.0.1` must not look pinned.
    const hash = rest.indexOf("#");
    const ref = (hash === -1 ? rest : rest.slice(0, hash)).trim();
    const comment = hash === -1 ? "" : rest.slice(hash);

    const record = (reason) =>
      violations.push({ file, line: index + 1, reason, text: `${prefix}${rest}` });

    if (ref.startsWith("./") || ref.startsWith(".\\")) return; // a local action is this repository
    if (ref.startsWith("docker://")) {
      record("container action must be pinned by digest, not by tag or nothing");
      return;
    }
    const at = ref.lastIndexOf("@");
    if (at <= 0) {
      record("no ref at all — pin the action to a 40-hex commit SHA");
      return;
    }
    const sha = ref.slice(at + 1);
    // A commit SHA can begin with a digit, so the SHA test has to come before the tag test — a
    // version tag is `v7`/`v7.1.0`, never 40 hex characters.
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      // A version tag or a branch is exactly the movable ref this check exists for; say so instead of
      // lumping it in with a typo.
      if (/^v?\d+(?:\.\d+)*$/.test(sha) || /^(main|master|latest|HEAD)$/.test(sha)) {
        record(`mutable ref "${sha}" — pin the commit SHA instead`);
      } else {
        record(`"${ref}" is not owner/repo@<40 lowercase hex>`);
      }
      return;
    }
    if (!PINNED.test(ref)) {
      record(`"${ref}" is not owner/repo@<40 lowercase hex>`);
      return;
    }
    if (!TAG_COMMENT.test(comment)) {
      record("missing `# vX.Y.Z` comment naming the release the SHA belongs to");
    }
  });
  return violations;
}

/**
 * Check every `*.yml`/`*.yaml` under a directory.
 * @param {string} dir
 * @returns {Promise<{ files: string[], violations: Violation[] }>}
 */
export async function checkDirectory(dir) {
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  /** @type {Violation[]} */
  const violations = [];
  for (const name of entries) {
    const path = join(dir, name);
    violations.push(...checkSource(await readFile(path, "utf8"), relative(root, path) || name));
  }
  return { files: entries, violations };
}

/* -------------------------------------------------------------------------- */

function usage() {
  return `usage: node scripts/ci-pins.mjs [--dir <workflow-dir>]\n\nEvery \`uses:\` must be owner/action@<40-hex> with a "# vX.Y.Z" comment.`;
}

async function main(argv) {
  let dir = DEFAULT_DIR;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dir") {
      const value = argv[index + 1];
      if (!value) {
        console.error(usage());
        return 1;
      }
      dir = resolve(value);
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      console.log(usage());
      return 0;
    } else {
      console.error(`unknown argument: ${argument}\n\n${usage()}`);
      return 1;
    }
  }

  /** @type {{ files: string[], violations: Violation[] }} */
  let result;
  try {
    result = await checkDirectory(dir);
  } catch (error) {
    console.error(`ci-pins: cannot read ${dir}: ${error instanceof Error ? error.message : error}`);
    return 1;
  }

  if (result.files.length === 0) {
    console.error(`ci-pins: no workflow files under ${dir}`);
    return 1;
  }

  for (const violation of result.violations) {
    console.error(`${violation.file}:${violation.line}: ${violation.reason}`);
    console.error(`  ${violation.text}`);
  }

  const pinned = `ci-pins: ${result.files.length} workflow file(s), ${result.violations.length} unpinned ref(s)`;
  if (result.violations.length > 0) {
    console.error(`\n${pinned} — every \`uses:\` needs a 40-hex SHA and a \`# vX.Y.Z\` comment`);
    return 1;
  }
  console.log(`${pinned} — every action is pinned`);
  return 0;
}

/* v8 ignore next 3 — the CLI entry is exercised through the npm script, not imported. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
