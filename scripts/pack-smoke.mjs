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
  const [result] = JSON.parse(raw);
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
} catch (error) {
  fail(`npm pack --dry-run failed: ${error.message}`);
}

console.log(failures === 0 ? "packaging smoke: OK" : `packaging smoke: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
