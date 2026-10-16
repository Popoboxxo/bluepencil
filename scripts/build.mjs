#!/usr/bin/env node
/**
 * Build script for bluepencil.
 *
 * Produces, from one source tree (NFR-16):
 *   1. dist/bluepencil.js         ESM library build for bundler hosts (code-split, adapters lazy)
 *   2. dist/bluepencil.iife.js    single-file IIFE for plain <script> / bookmarklet, global `bluepencil`
 *   3. dist/bluepencil.element.js single-file ES module registering <bluepencil-notes>
 *   4. dist/cli.js                Node CLI (inspect | validate | merge | export | import)
 *   5. dist/mcp.js                MCP server over stdio (read-only by default)
 *   6. dist/types/**              .d.ts declarations for every entry point
 *
 * No runtime dependencies are bundled: everything in dist/ is built from src/ only.
 */
import { build } from "esbuild";
import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
  target: ["es2022"],
  legalComments: "none",
  define: { __BLUEPENCIL_VERSION__: JSON.stringify(pkg.version) },
};

const banner = `/*! ${pkg.name} v${pkg.version} — ${pkg.description} | ${pkg.license} */`;

/**
 * Replaces the built-in adapters with a stub so the core size can be measured (NFR-3).
 *
 * The filter has to name every built-in adapter. It listed four while a fifth existed, which did not
 * fail — it silently counted the new adapter into the "core" number, making the budget look tighter
 * than it was. Deriving the list keeps that from happening again.
 */
const BUILTIN_ADAPTERS = ["memory", "local-storage", "file", "http", "chrome-storage"];
const adapterStubPlugin = {
  name: "adapter-stub",
  setup(pluginBuild) {
    const filter = new RegExp(`^\\.\\./adapters/(${BUILTIN_ADAPTERS.join("|")})$`);
    pluginBuild.onResolve({ filter }, () => ({
      path: join(root, "scripts/adapter-stub.js"),
    }));
  },
};

const jobs = [
  {
    name: "esm",
    options: {
      ...shared,
      // The library entry is emitted under the name the package manifest advertises.
      entryPoints: [{ in: join(root, "src/index.ts"), out: "bluepencil" }],
      outdir: join(root, "dist"),
      format: "esm",
      splitting: true,
      minify: false,
      banner: { js: banner },
    },
  },
  {
    name: "data",
    options: {
      ...shared,
      entryPoints: [join(root, "src/data/index.ts")],
      outfile: join(root, "dist/data.js"),
      format: "esm",
      minify: false,
      banner: { js: banner },
    },
  },
  {
    name: "adapters",
    options: {
      ...shared,
      entryPoints: {
        memory: join(root, "src/adapters/memory.ts"),
        "local-storage": join(root, "src/adapters/local-storage.ts"),
        file: join(root, "src/adapters/file.ts"),
        http: join(root, "src/adapters/http.ts"),
        // The extension's own store. Listed here, not forgotten: a subpath export that the build
        // does not emit fails the package smoke test ("was not emitted by the build"), which is
        // exactly the check that caught its absence.
        "chrome-storage": join(root, "src/adapters/chrome-storage.ts"),
      },
      outdir: join(root, "dist/adapters"),
      format: "esm",
      minify: false,
      banner: { js: banner },
    },
  },
  {
    name: "i18n",
    options: {
      ...shared,
      entryPoints: { en: join(root, "src/i18n/en.ts"), de: join(root, "src/i18n/de.ts") },
      outdir: join(root, "dist/i18n"),
      format: "esm",
      minify: false,
      banner: { js: banner },
    },
  },
  {
    name: "iife",
    options: {
      ...shared,
      entryPoints: [join(root, "src/index.ts")],
      outfile: join(root, "dist/bluepencil.iife.js"),
      format: "iife",
      globalName: "bluepencil",
      minify: true,
      banner: { js: banner },
    },
  },
  {
    // NFR-3 measures the core without the built-in adapters, so this build aliases them away.
    name: "core",
    options: {
      ...shared,
      entryPoints: [join(root, "src/index.ts")],
      outfile: join(root, "dist/bluepencil.core.js"),
      format: "iife",
      globalName: "bluepencil",
      minify: true,
      banner: { js: banner },
      plugins: [adapterStubPlugin],
    },
  },
  {
    name: "element",
    options: {
      ...shared,
      entryPoints: [join(root, "src/element/index.ts")],
      outfile: join(root, "dist/bluepencil.element.js"),
      format: "esm",
      minify: true,
      banner: { js: banner },
    },
  },
  {
    // The element as a classic script, for the one host that cannot use a module: a browser
    // extension's MAIN world. Measured: a page cannot `import()` a `chrome-extension://` URL ("Failed
    // to fetch dynamically imported module"), so the worker reads this file and evaluates it as a
    // string. That evaluation has to be a function body, and the ESM build ends in a real
    // `export{…}` — which `new Function` rejects with "Invalid or unexpected token". An IIFE with a
    // global name is the shape that survives being turned into source text.
    name: "element-iife",
    options: {
      ...shared,
      entryPoints: [join(root, "src/element/index.ts")],
      outfile: join(root, "dist/bluepencil.element.iife.js"),
      format: "iife",
      globalName: "bluepencilElement",
      minify: true,
      banner: { js: banner },
    },
  },
  {
    // FR-17: the attach loader — a classic script for hosts that must not build anything.
    name: "attach",
    options: {
      ...shared,
      entryPoints: [join(root, "src/embed/attach.ts")],
      outfile: join(root, "dist/attach.js"),
      format: "iife",
      platform: "browser",
      minify: true,
      banner: { js: banner },
    },
  },
  {
    // The same loader for hosts that import it from a bundler.
    name: "attach-esm",
    options: {
      ...shared,
      entryPoints: [join(root, "src/embed/attach.ts")],
      outfile: join(root, "dist/attach.esm.js"),
      format: "esm",
      platform: "browser",
      minify: false,
      banner: { js: banner },
    },
  },
  {
    name: "cli",
    options: {
      ...shared,
      entryPoints: [join(root, "src/cli/bin.ts")],
      outfile: join(root, "dist/cli.js"),
      format: "esm",
      platform: "node",
      target: ["node20"],
      minify: false,
      banner: { js: banner },
    },
  },
  {
    name: "mcp",
    options: {
      ...shared,
      entryPoints: [join(root, "src/mcp/server.ts")],
      outfile: join(root, "dist/mcp.js"),
      format: "esm",
      platform: "node",
      target: ["node20"],
      minify: false,
      banner: { js: banner },
    },
  },
  {
    // FR-17 §3: the hub store — one command, dependency-free, serves API + static files.
    name: "server",
    entry: join(root, "server/index.ts"),
    options: {
      ...shared,
      entryPoints: [join(root, "server/index.ts")],
      outfile: join(root, "dist/server.js"),
      format: "esm",
      platform: "node",
      target: ["node20"],
      minify: false,
      banner: { js: banner },
    },
  },
];

async function cleanDist() {
  const abs = join(root, "dist");
  if (!existsSync(abs)) {
    return;
  }
  for (const entry of await readdir(abs)) {
    try {
      await rm(join(abs, entry), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // On fuse-backed shares (Unraid shfs) a file that is still open by a running server or a
      // browser is renamed to `.fuse_hidden*` and keeps the directory non-empty; the build
      // continues and esbuild overwrites the artefacts it produces.
    }
  }
}

/** The jobs whose output the extension loads verbatim; only they trigger an extension rebuild. */
const ELEMENT_JOBS = new Set(["element", "element-iife"]);

/**
 * Watch-time hook: rebuild `extension/dist/` whenever the element bundles change.
 *
 * The extension loads `dist/bluepencil.element.iife.js` verbatim (see extension/build.mjs), so a
 * stale extension/dist is the failure mode this closes: under `--watch` the library is always
 * fresh while the extension silently stays behind, and the extension smoke test then runs against
 * yesterday's artefact.
 *
 * The hook is a plugin, attached only in the watch branch: `context()` consumes the same option
 * objects as the one-shot `build()`, so putting the hook into `job.options` would make a plain
 * `npm run build` shell out to the extension build as well.
 *
 * One shared controller backs both element contexts — separate per-context timers would let two
 * extension builds race, and only one is ever needed.
 */
function createExtensionSync() {
  // A single save can retrigger several contexts; coalesce the burst into one extension build.
  const DEBOUNCE_MS = 200;
  let timer = null;
  let running = false;
  let pending = false;

  const run = () => {
    if (running) {
      // One follow-up run picks up every change seen since the current run started — never queue more.
      pending = true;
      return;
    }
    running = true;
    pending = false;
    const child = spawn(process.execPath, ["extension/build.mjs"], { cwd: root, stdio: "inherit" });
    let settled = false;
    const finish = (ok, detail) => {
      // `error` and `exit` can both fire for a failed spawn; settle once so `running` cannot stick.
      if (settled) {
        return;
      }
      settled = true;
      if (ok) {
        console.log("[build] extension/dist rebuilt (triggered by the element bundle)");
      } else {
        console.warn(`[build] extension auto-build failed (${detail}) — run: npm run build:ext`);
      }
      running = false;
      if (pending) {
        schedule();
      }
    };
    // A spawn failure or a non-zero exit must never break the watch loop; log and keep watching.
    child.on("error", (error) => finish(false, error.message));
    child.on("exit", (code) => finish(code === 0, `exit ${code}`));
  };

  const schedule = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      run();
    }, DEBOUNCE_MS);
  };

  return () => ({
    name: "extension-sync",
    setup(pluginBuild) {
      pluginBuild.onEnd(() => schedule());
    },
  });
}

async function main() {
  await cleanDist();
  await mkdir(join(root, "dist"), { recursive: true });

  // A job may declare an `entry` to be skipped while its source does not exist yet (the hub
  // lives in server/ and is optional for a browser-only checkout) — never skip silently.
  const runnable = jobs.filter((job) => {
    if (!job.entry || existsSync(job.entry)) {
      return true;
    }
    console.warn(`[build] ${job.name} skipped — ${job.entry} does not exist`);
    return false;
  });

  if (watch) {
    const { context } = await import("esbuild");
    const makeExtensionSyncPlugin = createExtensionSync();
    for (const job of runnable) {
      // Only the two element contexts trigger the extension rebuild; other jobs keep their own
      // plugins (e.g. the core job's adapterStubPlugin) untouched.
      const plugin = ELEMENT_JOBS.has(job.name) ? makeExtensionSyncPlugin() : null;
      const options = plugin
        ? { ...job.options, plugins: [...(job.options.plugins ?? []), plugin] }
        : job.options;
      const ctx = await context(options);
      await ctx.watch();
      console.log(`[build] watching ${job.name}`);
    }
    return;
  }

  for (const job of runnable) {
    await build(job.options);
    console.log(`[build] ${job.name} ok`);
  }

  // Declarations (types only) — tsc is used for types, esbuild for code.
  execFileSync("npx", ["tsc", "-p", "tsconfig.types.json"], { cwd: root, stdio: "inherit" });

  // The element build is also shipped under a stable, documented name.
  await cp(
    join(root, "dist/bluepencil.element.js"),
    join(root, "dist/bluepencil.element.min.js"),
  ).catch(() => {});
}

await main();
