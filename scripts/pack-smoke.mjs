#!/usr/bin/env node
/**
 * Packaging smoke test.
 *
 * A library is only as good as its published entry points: this script proves that every path in
 * the `exports` map exists on disk after a build, that each one can actually be imported by Node,
 * and that `npm pack` ships them. It exists because the first M1 build emitted `dist/index.js`
 * while the manifest advertised `dist/bluepencil.js`, which made every documented import fail with
 * ERR_MODULE_NOT_FOUND (FR-10.2/FR-15.1, NFR-16).
 *
 * It also guards the published surface itself (SEC-23, AC-K01/AC-K06): the tarball must not
 * contain internal working material, and the headless example in `docs/ARCHITECTURE.md` must
 * really execute against the built `bluepencil/data` entry point.
 *
 * Usage: node scripts/pack-smoke.mjs      (requires `npm run build` first)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

let failures = 0;
const pass = (message) => console.log(`PASS ${message}`);
const fail = (message) => {
  failures += 1;
  console.log(`FAIL ${message}`);
};

const entries = Object.entries(pkg.exports ?? {}).filter(([key]) => key !== "./package.json");

/** Entries that need a DOM at import time — checked for syntax instead of being imported. */
const BROWSER_ONLY = ["./element"];

if (entries.length === 0) {
  fail("package.json has no exports map");
}

for (const [subpath, target] of entries) {
  const spec = typeof target === "string" ? target : target.import ?? target.default;
  const types = typeof target === "string" ? null : target.types;

  if (!spec) {
    fail(`${subpath}: no import target`);
    continue;
  }
  const entryFile = resolve(root, spec);
  if (!existsSync(entryFile) || !statSync(entryFile).isFile()) {
    fail(`${subpath}: ${spec} was not emitted by the build`);
    continue;
  }
  if (types) {
    const typesFile = resolve(root, types);
    if (!existsSync(typesFile)) {
      fail(`${subpath}: type declaration ${types} is missing`);
      continue;
    }
  }

  if (spec.endsWith(".js")) {
    if (BROWSER_ONLY.includes(subpath)) {
      // Browser-only entries cannot be imported in Node (no HTMLElement/customElements); prove
      // instead that the file is emitted and syntactically valid.
      try {
        execFileSync(process.execPath, ["--check", entryFile], { stdio: "pipe" });
        pass(`${subpath} -> ${spec} (browser-only, syntax ok)`);
      } catch (error) {
        fail(`${subpath}: ${spec} failed the syntax check: ${String(error.stderr ?? error.message).slice(0, 200)}`);
      }
      continue;
    }
    try {
      const module = await import(pathToFileURL(entryFile).href);
      const exported = Object.keys(module);
      if (exported.length === 0) {
        fail(`${subpath}: ${spec} exports nothing`);
        continue;
      }
      pass(`${subpath} -> ${spec} (${exported.length} export(s))`);
    } catch (error) {
      fail(`${subpath}: importing ${spec} threw ${error.message}`);
    }
  } else {
    pass(`${subpath} -> ${spec}`);
  }
}

// The declared main/module/types and bin must resolve as well.
for (const field of ["main", "module", "types"]) {
  const value = pkg[field];
  if (value && !existsSync(resolve(root, value))) {
    fail(`package.json ${field} -> ${value} does not exist`);
  }
}
for (const [name, bin] of Object.entries(pkg.bin ?? {})) {
  if (!existsSync(resolve(root, bin))) {
    fail(`bin ${name} -> ${bin} does not exist`);
  } else {
    pass(`bin ${name} -> ${bin}`);
  }
}

// What would actually be published?
try {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" });
  // `npm pack` runs `prepare`, so stdout can carry a build log before the JSON report. Take the last
  // top-level array in the output instead of parsing it whole: a lifecycle script printing a line
  // used to fail this smoke with "Unexpected token", which reads like a packaging bug and is not one.
  const jsonStart = raw.lastIndexOf("\n[");
  const [result] = JSON.parse(jsonStart === -1 ? raw : raw.slice(jsonStart + 1));
  const packed = new Set((result.files ?? []).map((file) => file.path));
  const required = [
    "dist/bluepencil.js",
    "dist/bluepencil.iife.js",
    "dist/bluepencil.element.js",
    "dist/data.js",
    "dist/adapters/memory.js",
    "dist/adapters/http.js",
    "dist/i18n/en.js",
    "dist/i18n/de.js",
    "dist/cli.js",
    "dist/mcp.js",
    "README.md",
    "LICENSE",
  ];
  const missing = required.filter((file) => !packed.has(file));
  if (missing.length > 0) {
    fail(`npm pack would omit: ${missing.join(", ")}`);
  } else {
    pass(`npm pack ships all ${required.length} required artefacts (${result.files?.length ?? 0} files total)`);
  }

  // SEC-23 / AC-K06: `files` is an allowlist of user-facing docs, never the whole `docs/` tree.
  // Internal plans, reviews, spikes and generated specs are working material and must not ship.
  const INTERNAL_PATHS = [
    "docs/plans/",
    "docs/reviews/",
    "docs/spikes/",
    "docs/specs/",
    "docs/INDEX.md",
    ".github/",
    ".tmp/",
    "tests/",
    "src/",
    "scripts/",
    "spec/",
    "examples/",
    "extension/",
    "docker/",
    "AGENTS.md",
    "CLAUDE.md",
  ];
  const internal = [...packed].filter((file) =>
    INTERNAL_PATHS.some((prefix) => file === prefix || file.startsWith(prefix)),
  );
  if (internal.length > 0) {
    fail(`npm pack would ship internal paths: ${internal.slice(0, 10).join(", ")}`);
  } else {
    pass(`npm pack ships no internal paths (${INTERNAL_PATHS.length} deny rules, ${packed.size} files scanned)`);
  }

  const listed = pkg.files ?? [];
  const bareDocs = listed.filter((entry) => entry === "docs" || entry === "docs/");
  if (bareDocs.length > 0) {
    fail("package.json files must list user-facing docs explicitly, not the whole docs/ tree");
  }
  const internalEntries = listed.filter((entry) =>
    INTERNAL_PATHS.some((prefix) => entry === prefix.replace(/\/$/u, "") || entry.startsWith(prefix)),
  );
  if (internalEntries.length > 0) {
    fail(`package.json files lists internal paths: ${internalEntries.join(", ")}`);
  }
  const shippedDocs = listed.filter((entry) => entry.startsWith("docs/") && entry.endsWith(".md"));
  const absentDocs = shippedDocs.filter((entry) => !packed.has(entry));
  if (absentDocs.length > 0) {
    fail(`npm pack would omit listed docs: ${absentDocs.join(", ")}`);
  } else {
    pass(`npm pack ships ${shippedDocs.length} explicitly listed user-facing doc(s)`);
  }
} catch (error) {
  fail(`npm pack --dry-run failed: ${error.message}`);
}

/* ------------------------------------------------------------------------------------------------
 * AC-K01: the ARCHITECTURE headless example executes against the built data surface
 * ---------------------------------------------------------------------------------------------- */

/** The contents of the first fenced code block after `heading`, language line stripped. */
function codeBlockAfter(markdown, heading) {
  const headingAt = markdown.indexOf(heading);
  if (headingAt < 0) throw new Error(`missing heading: ${heading}`);
  const fenceStart = markdown.indexOf("```", headingAt);
  if (fenceStart < 0) throw new Error(`missing code block after: ${heading}`);
  const fenceEnd = markdown.indexOf("```", fenceStart + 3);
  if (fenceEnd < 0) throw new Error(`unterminated code block after: ${heading}`);
  return markdown.slice(fenceStart + 3, fenceEnd).replace(/^[a-zA-Z0-9_-]*\n/u, "");
}

try {
  const dataEntry = resolve(root, "dist/data.js");
  if (!existsSync(dataEntry)) {
    fail("dist/data.js is missing — run `npm run build` before smoke:pack");
  } else {
    const architecture = readFileSync(join(root, "docs/ARCHITECTURE.md"), "utf8");
    const example = codeBlockAfter(architecture, "### Headless use");
    if (!example.includes('from "bluepencil/data"')) {
      fail('the headless example no longer imports from "bluepencil/data"');
    } else {
      for (const gone of ["mergeBundles", "createStore"]) {
        if (example.includes(gone)) {
          fail(`the headless example still calls ${gone}, which bluepencil/data does not export`);
        }
      }
      const dataUrl = pathToFileURL(dataEntry).href;
      // Keep the example verbatim; only resolve the documented package subpath to the built file.
      const executable = example
        .split('"bluepencil/data"')
        .join(JSON.stringify(dataUrl));
      const encoded = Buffer.from(executable, "utf8").toString("base64");
      try {
        execFileSync(process.execPath, ["--input-type=module", "-e", `await import("data:text/javascript;base64,${encoded}")`], {
          cwd: root,
          stdio: "pipe",
        });
        pass("docs/ARCHITECTURE.md headless example runs against dist/data.js");
      } catch (error) {
        const detail = String(error.stderr ?? error.message).slice(0, 300);
        fail(`docs/ARCHITECTURE.md headless example threw: ${detail}`);
      }
    }
  }
} catch (error) {
  fail(`headless example check failed: ${error.message}`);
}

console.log(failures === 0 ? "packaging smoke: OK" : `packaging smoke: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
