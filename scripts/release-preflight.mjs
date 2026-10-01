/**
 * Release preflight: prove the tag, the version and the changelog agree, and write the release notes.
 *
 * Why a script rather than a handful of shell lines inside the workflow: the same checks have to run
 * *before* the tag exists. The failure this prevents is a release whose assets carry a version that
 * does not match its tag, or whose notes are empty because the changelog section was never written —
 * a minute of work before pushing the tag, an afternoon after.
 *
 * Usage:
 *   node scripts/release-preflight.mjs --tag v0.3.0 [--notes <file>] [--assets <dir>]
 *
 *   --tag     the tag being released; the version is the tag without its leading `v`
 *   --notes   write the release notes here (default: stdout)
 *   --assets  a directory of built assets to verify: the four expected files must be there and
 *             `SHA256SUMS` must list exactly them with matching digests
 *
 * Exit codes, like the CLI: 0 ok · 1 usage · 2 the release does not add up.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "usage: node scripts/release-preflight.mjs --tag v<version> [--notes <file>] [--assets <dir>]";

function fail(message, code = 2) {
  console.error(`release preflight: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = {};
  const known = ["--tag", "--notes", "--assets"];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (!known.includes(name)) fail(`unknown option ${arg}\n${USAGE}`, 1);
    const value = inline ?? argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`${name} needs a value\n${USAGE}`, 1);
    if (inline === undefined) i += 1;
    args[name.slice(2)] = value;
  }
  if (args.tag === undefined) fail(`--tag is required\n${USAGE}`, 1);
  return args;
}

/** The changelog section for one version: `## [0.2.0] - 2026-09-21` up to the next `## [`. */
function changelogSection(lines, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^## \\[${escaped}\\]`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## \[/.test(line));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return { heading: lines[start].trim(), body };
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const args = parseArgs(process.argv.slice(2));
const tag = args.tag;
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  fail(`tag ${tag} is not v<major>.<minor>.<patch>[-prerelease]`);
}
const version = tag.slice(1);

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "extension", "manifest.json"), "utf8"));
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8").split("\n");

const problems = [];
if (pkg.version !== version) {
  problems.push(`package.json says ${pkg.version}, the tag says ${version}`);
}
if (manifest.version !== version) {
  problems.push(`extension/manifest.json says ${manifest.version}, the tag says ${version}`);
}
const section = changelogSection(changelog, version);
if (section === undefined) {
  problems.push(`CHANGELOG.md has no "## [${version}]" section`);
} else if (section.body.length === 0) {
  problems.push(`the CHANGELOG.md section for ${version} is empty`);
}
if (problems.length > 0) {
  for (const problem of problems) console.error(`  - ${problem}`);
  fail(`the release does not add up; nothing was written`);
}

const assets = [
  "attach.js",
  "bluepencil.element.min.js",
  `bluepencil-${version}.tgz`,
  `bluepencil-extension-${version}.zip`,
];

if (args.assets !== undefined) {
  const dir = resolve(root, args.assets);
  const assetProblems = assets.filter((name) => !existsSync(join(dir, name)));
  const sumsPath = join(dir, "SHA256SUMS");
  if (!existsSync(sumsPath)) {
    assetProblems.push("SHA256SUMS");
  } else {
    const listed = new Map(
      readFileSync(sumsPath, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const [hash, ...rest] = line.split(/\s+/);
          return [rest.join(" ").replace(/^\*/, ""), hash];
        }),
    );
    for (const name of assets) {
      const hash = listed.get(name);
      if (hash === undefined) {
        assetProblems.push(`${name} is missing from SHA256SUMS`);
      } else if (existsSync(join(dir, name)) && hash !== digest(join(dir, name))) {
        assetProblems.push(`${name} does not match its SHA256SUMS digest`);
      }
    }
    for (const name of listed.keys()) {
      if (!assets.includes(name)) assetProblems.push(`SHA256SUMS lists ${name}, which is not an asset`);
    }
  }
  if (assetProblems.length > 0) {
    for (const problem of assetProblems) console.error(`  - ${problem}`);
    fail(`${args.assets} is not a complete set of release assets`);
  }
}

const notes = [
  section.body,
  "",
  "---",
  "",
  "### Assets",
  "",
  "| Asset | What it is |",
  "| --- | --- |",
  "| `attach.js` | the loader as one script tag — `<script src=\"…/attach.js\" data-store=\"…\">` |",
  "| `bluepencil.element.min.js` | the annotation layer as a single file, if you load it yourself |",
  `| \`bluepencil-${version}.tgz\` | the package — \`npm i ./bluepencil-${version}.tgz\` |`,
  `| \`bluepencil-extension-${version}.zip\` | the MV3 browser extension; unpack it and load the folder unpacked |`,
  "| `SHA256SUMS` | digests for all four above |",
  "",
  `Installing straight from the tag works too: \`npm i github:Popoboxxo/bluepencil#${tag}\` — the`,
  "`prepare` script builds `dist/` during install. There is no npm registry release.",
  "",
].join("\n");

if (args.notes === undefined) {
  process.stdout.write(notes);
} else {
  writeFileSync(resolve(root, args.notes), notes);
}

const sizes =
  args.assets === undefined
    ? ""
    : ` · ${assets
        .map((name) => `${name} (${(statSync(join(resolve(root, args.assets), name)).size / 1024).toFixed(0)} kB)`)
        .join(", ")} · SHA256SUMS verified`;
console.log(
  `release preflight: OK — ${tag} matches package.json, extension/manifest.json and CHANGELOG.md${
    args.assets === undefined ? "" : sizes
  }`,
);
