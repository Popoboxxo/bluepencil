#!/usr/bin/env node
/**
 * Install smoke test — proves the package installs from a *tarball* and that every documented
 * `exports` subpath resolves from that installed copy (FR-10.2, FR-15.1, NFR-16).
 *
 * `pack-smoke.mjs` checks the exports map **in the repo** (on disk and in `npm pack --dry-run`).
 * It cannot catch a class of bug that only appears in a consumer's tree: an `exports` target that
 * exists in the working copy but is not shipped in the tarball, or a bare specifier that resolves
 * differently once the package sits in `node_modules/bluepencil`. This smoke closes that gap by
 * packing, installing the tarball into a scratch project with its own `package.json`, and importing
 * every subpath **by package specifier** (`import "bluepencil/data"`), so Node's real resolution
 * algorithm runs against the installed copy.
 *
 * Two legs:
 *
 *   Leg 1 — deterministic tarball install (REQUIRED, fail-red).
 *     `npm pack` → scratch dir → `npm install <tarball>` → `node probe.mjs`. The package has zero
 *     runtime dependencies, so this needs no registry and no network: it is deterministic.
 *     Also asserts the `bluepencil` bin runs (`--help` exits 0).
 *
 *   Leg 2 — git install / `prepare`-on-install (NON-BLOCKING DIAGNOSTIC).
 *     `npm install github:Popoboxxo/bluepencil#<ref>` in a fresh scratch dir, then imports the root
 *     and one subpath. This proves the `prepare` script builds `dist/` during a git install.
 *
 * DECISION (git leg = diagnostic, never the gate): the required check is Leg 1 only.
 * Rationale: (a) a ref that does not exist on the remote cannot be cloned — a fork PR's head SHA is
 * absent from the base repo `Popoboxxo/bluepencil`, so `github:…#<sha>` has nothing to check out
 * (npm then misreports the failure as an SSH "Permission denied" after the https attempt falls
 * through); (b) the leg needs npm + GitHub network access and a git toolchain, so a transient outage
 * would turn a packaging change red for reasons unrelated to the package. On `main` pushes the ref
 * is present and the leg normally passes, which is why it is kept as a diagnostic rather than
 * dropped. In CI it therefore runs with `continue-on-error: true` and prints a clear reason on
 * failure (see the `install` job in .github/workflows/ci.yml).
 *
 * Usage:
 *   node scripts/install-smoke.mjs                  # Leg 1 (required); run `npm run build` first
 *   node scripts/install-smoke.mjs --git <ref>      # Leg 2 only, explicit ref
 *   node scripts/install-smoke.mjs --only-git       # Leg 2 only, ref from BP_INSTALL_GIT_REF
 *   node scripts/install-smoke.mjs --all            # both legs
 *
 * Everything happens under `.tmp/install-smoke/` (git-ignored), so the repo and its fixtures are
 * never touched. Each case prints `PASS <case>` or `FAIL <case>: <detail>`; the summary counts them
 * and the exit code is non-zero when any *executed* leg failed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKSPACE = join(root, ".tmp/install-smoke");
const DIST_ENTRY = join(root, "dist/bluepencil.js");
const DIST_BIN = join(root, "dist/cli.js");

/**
 * Expected named exports per subpath — derived from the real sources and verified against the built
 * dist. Kept explicit (not "import and expect non-empty") so a dropped export is a failure, not a
 * smaller pass.
 *
 * `bluepencil/element` is browser-only (needs `customElements`/`HTMLElement` at import time) and is
 * handled like `pack-smoke.mjs` does: syntax-checked with `node --check`, never imported.
 */
const EXPECTED_EXPORTS = {
  bluepencil: [
    "init",
    "mount",
    "createBlueprint",
    "registerAdapter",
    "filterNotes",
    "matchesFilter",
    "excludeDone",
    "SCHEMA_VERSION",
    "BluepencilValidationError",
    "VERSION",
  ],
  "bluepencil/data": [
    "validateNote",
    "validateBundle",
    "assertNote",
    "assertBundle",
    "canonicalNote",
    "canonicalBundle",
    "serializeCanonical",
    "hashBundle",
    "createBundle",
    "bundleToJson",
    "parseBundle",
    "inspectBundle",
    "mergeNotes",
    "migrateNote",
    "migrateBundle",
  ],
  "bluepencil/adapters/memory": [
    "createMemoryAdapter",
    "MEMORY_ADAPTER_NAME",
    "serializeNoteSet",
    "parseNoteSet",
    "createJsonAdapter",
  ],
  "bluepencil/adapters/local-storage": [
    "createLocalStorageAdapter",
    "LOCAL_STORAGE_ADAPTER_NAME",
    "localStorageKey",
    "STORAGE_KEY_VERSION",
  ],
  "bluepencil/adapters/chrome-storage": [
    "createChromeStorageAdapter",
    "CHROME_STORAGE_ADAPTER_NAME",
    "chromeStorageKey",
  ],
  "bluepencil/adapters/file": ["createFileAdapter", "FILE_ADAPTER_NAME"],
  "bluepencil/adapters/http": ["createHttpAdapter", "HTTP_ADAPTER_NAME", "HttpAdapterError"],
  "bluepencil/i18n/en": ["en"],
  "bluepencil/i18n/de": ["de"],
  "bluepencil/attach": ["attach", "attachFromDocument", "start"],
  "bluepencil/server": [
    "startServer",
    "parseServerArgs",
    "DEFAULT_PORT",
    "DEFAULT_HOST",
    "parseNoteSet",
    "loadNotes",
    "createFileStore",
    "StoreFileError",
    "MAX_BODY_BYTES",
  ],
};

/** Subpaths that cannot be imported in Node (no DOM) — checked for syntax instead. */
const BROWSER_ONLY = new Set(["bluepencil/element"]);
/** Every specifier this smoke knows about; used to flag an exports entry nothing covers. */
const KNOWN = new Set([...Object.keys(EXPECTED_EXPORTS), ...BROWSER_ONLY]);

// ---------------------------------------------------------------- CLI arguments

const args = process.argv.slice(2);
const gitFlagIndex = args.indexOf("--git");
/** `--git <ref>` supplies the ref explicitly; a bare `--git` falls back to the environment. */
const explicitGitRef =
  gitFlagIndex !== -1 && args[gitFlagIndex + 1] && !args[gitFlagIndex + 1].startsWith("--")
    ? args[gitFlagIndex + 1]
    : undefined;
const gitRef = explicitGitRef ?? process.env.BP_INSTALL_GIT_REF ?? undefined;

const onlyGit = args.includes("--only-git");
const all = args.includes("--all");
const wantGit = onlyGit || all || gitFlagIndex !== -1;
const wantTarball = !onlyGit && (gitFlagIndex === -1 || all);

// ---------------------------------------------------------------- reporting

let failures = 0;
const pass = (message) => console.log(`PASS ${message}`);
const fail = (message) => {
  failures += 1;
  console.log(`FAIL ${message}`);
};

/** Last few non-empty lines of a child's stderr, for a readable one-shot diagnostic. */
function tail(text, lines = 6) {
  const rows = String(text ?? "").trimEnd().split("\n").filter((row) => row.trim() !== "");
  return rows.slice(-lines).join("\n");
}

// ---------------------------------------------------------------- helpers

/**
 * Resolve the tarball `npm pack` produced.
 *
 * `npm pack` runs `prepare` (a build), so stdout carries build logs before the JSON report. Parse the
 * *last top-level array* in the output (the `[` on its own line) instead of the whole output; fall
 * back to scanning `--pack-destination` for the single `bluepencil-*.tgz`.
 */
function locateTarball(raw, dir) {
  try {
    const lines = raw.split("\n");
    let start = -1;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index] === "[") {
        start = index;
        break;
      }
    }
    if (start !== -1) {
      const [report] = JSON.parse(lines.slice(start).join("\n"));
      if (report?.filename) {
        const candidate = resolve(dir, report.filename);
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // Fall through to the directory scan.
  }
  const candidates = readdirSync(dir).filter((name) => /^bluepencil-.*\.tgz$/.test(name));
  return candidates.length === 1 ? join(dir, candidates[0]) : null;
}

/** Write the scratch project's own manifest — the tarball is installed into *this* tree. */
function writeScratchManifest(dir) {
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "install-smoke-probe", private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
}

/** Map an `exports` key to the specifier a consumer writes: "." → bluepencil, "./data" → bluepencil/data. */
function specifierFor(key) {
  return key === "." ? "bluepencil" : `bluepencil${key.slice(1)}`;
}

/** The import target of an `exports` entry (string form or the `import`/`default` condition). */
function targetFor(target) {
  return typeof target === "string" ? target : target.import ?? target.default;
}

/** Fresh scratch dir under the git-ignored workspace. */
function freshDir(name) {
  const dir = join(WORKSPACE, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The probe, run *inside* the scratch dir so bare specifiers resolve through its
 * `node_modules/bluepencil`. It writes a JSON result file; the parent does the assertions.
 */
function writeProbe(dir, specs, resultPath) {
  const source = `import { writeFileSync } from "node:fs";

const specs = ${JSON.stringify(specs)};
const results = {};
for (const { spec, expected } of specs) {
  try {
    const module = await import(spec);
    const missing = expected.filter((name) => !(name in module));
    results[spec] = { ok: missing.length === 0, keys: Object.keys(module).sort(), missing };
  } catch (error) {
    results[spec] = { ok: false, error: String(error?.message ?? error) };
  }
}
writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(results, null, 2));
`;
  writeFileSync(join(dir, "probe.mjs"), source, "utf8");
}

function runProbe(dir) {
  return spawnSync(process.execPath, ["probe.mjs"], { cwd: dir, encoding: "utf8" });
}

// ---------------------------------------------------------------- Leg 1 — tarball install

function tarballLeg() {
  const packDir = freshDir("pack");
  const scratch = freshDir("probe");

  // Pack. `npm pack` also runs `prepare`, which rebuilds dist/ — harmless, and it proves the
  // published tarball can be produced by the same lifecycle a release uses.
  const packed = spawnSync("npm", ["pack", "--pack-destination", packDir, "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  if (packed.status !== 0) {
    fail(`npm pack failed: ${tail(packed.stderr)}`);
    return;
  }
  const tarball = locateTarball(packed.stdout, packDir);
  if (tarball === null) {
    fail(`npm pack produced no single bluepencil-*.tgz in ${packDir}`);
    return;
  }
  pass(`npm pack -> ${tarball.replace(`${root}/`, "")}`);

  // Install the tarball into a scratch project. Zero dependencies means this is offline.
  writeScratchManifest(scratch);
  const installed = spawnSync("npm", ["install", tarball, "--no-audit", "--no-fund"], {
    cwd: scratch,
    encoding: "utf8",
  });
  if (installed.status !== 0) {
    fail(`npm install <tarball> failed: ${tail(installed.stderr)}`);
    return;
  }
  pass("npm install <tarball> (offline, no dependencies)");

  const installedPkgPath = join(scratch, "node_modules/bluepencil/package.json");
  if (!existsSync(installedPkgPath)) {
    fail("the installed tree has no node_modules/bluepencil/package.json");
    return;
  }
  const installedPkg = JSON.parse(readFileSync(installedPkgPath, "utf8"));

  // Every subpath of the *installed* manifest's exports map must be covered by this smoke.
  const exportKeys = Object.keys(installedPkg.exports ?? {}).filter((key) => key !== "./package.json");
  const installedSpecs = new Set(exportKeys.map(specifierFor));
  for (const spec of KNOWN) {
    if (!installedSpecs.has(spec)) fail(`${spec}: documented subpath missing from the installed exports map`);
  }
  for (const spec of installedSpecs) {
    if (!KNOWN.has(spec)) fail(`${spec}: installed exports map has a subpath this smoke does not cover`);
  }

  // Import each importable subpath by specifier.
  const importable = [...installedSpecs]
    .filter((spec) => !BROWSER_ONLY.has(spec) && spec in EXPECTED_EXPORTS)
    .map((spec) => ({ spec, expected: EXPECTED_EXPORTS[spec] }));
  const resultPath = join(scratch, "probe-result.json");
  writeProbe(scratch, importable, resultPath);
  const probed = runProbe(scratch);
  if (!existsSync(resultPath)) {
    fail(`the probe did not run: ${tail(probed.stderr)}`);
    return;
  }
  const results = JSON.parse(readFileSync(resultPath, "utf8"));
  for (const { spec } of importable) {
    const result = results[spec] ?? { ok: false, error: "not reported" };
    if (result.ok) {
      pass(`${spec} (${result.keys.length} export(s))`);
    } else if (result.error) {
      fail(`${spec}: import threw ${result.error}`);
    } else {
      fail(`${spec}: missing export(s) ${result.missing.join(", ")}`);
    }
  }

  // Browser-only subpaths: emitted and syntactically valid, not imported.
  for (const spec of BROWSER_ONLY) {
    const key = spec === "bluepencil" ? "." : `./${spec.slice("bluepencil/".length)}`;
    const entry = installedPkg.exports?.[key];
    const target = entry ? targetFor(entry) : undefined;
    if (!target) {
      fail(`${spec}: no import target in the installed exports map`);
      continue;
    }
    const file = join(scratch, "node_modules/bluepencil", target);
    if (!existsSync(file) || !statSync(file).isFile()) {
      fail(`${spec}: ${target} was not shipped in the tarball`);
      continue;
    }
    const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (check.status === 0) {
      pass(`${spec} -> ${target} (browser-only, syntax ok)`);
    } else {
      fail(`${spec}: ${target} failed the syntax check: ${tail(check.stderr, 3)}`);
    }
  }

  // The bin must resolve and run. `--help` is a documented, exit-0 path (src/cli/bin.ts).
  const binName = Object.keys(installedPkg.bin ?? { bluepencil: "bluepencil" })[0];
  const binPath = join(scratch, "node_modules/.bin", binName);
  if (!existsSync(binPath)) {
    fail(`${binName}: node_modules/.bin/${binName} was not created by the install`);
  } else {
    const run = spawnSync(binPath, ["--help"], { cwd: scratch, encoding: "utf8" });
    if (run.status === 0) {
      pass(`${binName} --help (exit 0)`);
    } else {
      fail(`${binName} --help exited ${run.status === null ? "-1" : run.status}: ${tail(run.stderr, 3)}`);
    }
  }
}

// ---------------------------------------------------------------- Leg 2 — git install (diagnostic)

function gitLeg() {
  const scratch = freshDir("git");
  writeScratchManifest(scratch);

  const specifier = `github:Popoboxxo/bluepencil${gitRef ? `#${gitRef}` : ""}`;
  console.log(`[install-smoke] git leg (diagnostic): npm install ${specifier}`);
  // Git installs run `prepare` in a clone, so this needs git + network + devDependencies (esbuild).
  const installed = spawnSync("npm", ["install", specifier, "--no-audit", "--no-fund"], {
    cwd: scratch,
    encoding: "utf8",
    timeout: 600_000,
  });
  if (installed.status !== 0) {
    fail(`git install (diagnostic, non-blocking) failed for ${specifier}: ${tail(installed.stderr)}`);
    return;
  }
  pass(`git install ${specifier} — prepare built dist/ during install`);

  const resultPath = join(scratch, "probe-result.json");
  writeProbe(
    scratch,
    [
      { spec: "bluepencil", expected: EXPECTED_EXPORTS.bluepencil },
      { spec: "bluepencil/data", expected: EXPECTED_EXPORTS["bluepencil/data"] },
    ],
    resultPath,
  );
  const probed = runProbe(scratch);
  if (!existsSync(resultPath)) {
    fail(`git leg probe did not run: ${tail(probed.stderr)}`);
    return;
  }
  const results = JSON.parse(readFileSync(resultPath, "utf8"));
  for (const spec of ["bluepencil", "bluepencil/data"]) {
    const result = results[spec] ?? { ok: false, error: "not reported" };
    if (result.ok) pass(`git ${spec} (${result.keys.length} export(s))`);
    else if (result.error) fail(`git ${spec}: import threw ${result.error}`);
    else fail(`git ${spec}: missing export(s) ${result.missing.join(", ")}`);
  }
}

// ---------------------------------------------------------------- run

mkdirSync(WORKSPACE, { recursive: true });

if (wantTarball) {
  if (!existsSync(DIST_ENTRY) || !existsSync(DIST_BIN)) {
    console.error(`[install-smoke] missing build artifact under ${join(root, "dist")} — run "npm run build" first`);
    process.exit(1);
  }
  console.log("[install-smoke] leg 1: tarball install (required)");
  tarballLeg();
}

if (wantGit) {
  console.log("[install-smoke] leg 2: git prepare-on-install (diagnostic, non-blocking)");
  gitLeg();
}

console.log(`install-smoke: ${failures === 0 ? "OK" : `${failures} failure(s)`} — workspace ${WORKSPACE}`);
process.exit(failures === 0 ? 0 : 1);
