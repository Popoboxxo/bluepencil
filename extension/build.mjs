/**
 * Build the loadable MV3 extension into `extension/dist/`.
 *
 * What it assembles, and the one thing that is deliberately *not* assembled:
 *
 * - `sw.js`, `bridge.js`, `options.js` — this package's extension sources, bundled with esbuild.
 * - `bluepencil.element.js` — copied verbatim from the library build. It is NOT re-bundled: the
 *   layer is the same artefact the embed loader ships, so the extension and a page embedding it
 *   run identical code. Re-bundling would let the two drift apart silently.
 * - `manifest.json`, `options.html` — copied as-is.
 *
 * The build fails when the library bundle is missing rather than producing an extension that
 * installs and then does nothing: a green CI run has to mean a loadable extension.
 */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = join(here, "dist");

/** The library artefact the extension loads. Produced by `npm run build`. */
const ELEMENT_BUNDLE = join(root, "dist", "bluepencil.element.iife.js");

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the version from the manifest and the library, and refuse to ship a mismatch.
 *
 * A stale `dist/bluepencil.element.js` is the failure mode that matters: the extension would load
 * an old layer, pass its smoke tests, and quietly lack whatever was fixed. Comparing the two
 * versions turns that into a build error.
 */
async function resolveVersion() {
  const manifestPath = join(here, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (manifest.version !== pkg.version) {
    throw new Error(
      `manifest.json version ${manifest.version} does not match package.json ${pkg.version}`,
    );
  }
  return manifest.version;
}

async function main() {
  if (!(await exists(ELEMENT_BUNDLE))) {
    throw new Error(
      `missing ${ELEMENT_BUNDLE} — run \`npm run build\` first; the extension loads the library bundle verbatim`,
    );
  }
  const version = await resolveVersion();

  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  await build({
    entryPoints: {
      sw: join(here, "src", "sw.ts"),
      bridge: join(here, "src", "bridge.ts"),
      options: join(here, "src", "options.ts"),
      // The registered MAIN-world bootstrap. Not a module: it is injected as a classic script into
      // the page's own world, so it must be self-contained and must not import anything.
      bootstrap: join(here, "src", "bootstrap.ts"),
    },
    bundle: true,
    format: "esm",
    target: "chrome116",
    platform: "browser",
    outdir: out,
    // No remote imports anywhere in the extension sources: the element bundle is loaded from the
    // extension's own origin at runtime, and MV3 forbids fetching code from the network.
    external: [],
    logLevel: "warning",
  });

  // The options page is static HTML with a module script, so it is copied, not generated.
  await cp(join(here, "options.html"), join(out, "options.html"));
  await cp(join(here, "manifest.json"), join(out, "manifest.json"));
  await cp(ELEMENT_BUNDLE, join(out, "bluepencil.element.iife.js"));

  // A build that produced no files is a broken build; catch it here rather than in a browser.
  const produced = await readdir(out);
  const required = ["manifest.json", "sw.js", "bridge.js", "bootstrap.js", "options.html", "options.js",
    "bluepencil.element.iife.js"];
  const missing = required.filter((name) => !produced.includes(name));
  if (missing.length > 0) throw new Error(`build did not produce: ${missing.join(", ")}`);

  // The integrity marker lets the E2E suite assert that the extension is running exactly the
  // library bundle from this build, rather than something left over in a profile directory.
  const digest = createHash("sha256")
    .update(await readFile(join(out, "bluepencil.element.iife.js")))
    .digest("hex");
  await writeFile(join(out, "build-info.json"), `${JSON.stringify({ version, elementSha256: digest }, null, 2)}\n`);

  console.log(`[ext] built ${version} -> ${out}`);
  console.log(`[ext] element bundle sha256 ${digest.slice(0, 16)}…`);
  console.log(`[ext] files: ${required.join(", ")}, build-info.json`);
}

await main();
