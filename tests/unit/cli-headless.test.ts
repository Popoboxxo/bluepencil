/**
 * @vitest-environment node — the CLI is bundled with esbuild and spawned as a child process.
 *
 * CLI `demo` is headless (BP-06, AC-A21). The command used to go through the `src/index` facade
 * (`createBlueprint`), which pulled the whole DOM layer — layer, panel, composer — into
 * `dist/cli.js` even though a shell has no document. Three assertions pin that down:
 *
 *  1. the source imports the store and the memory adapter directly and never `src/index`,
 *  2. the bundle contains no `createLayer`/`createPanel`/`createComposer` code,
 *  3. `bluepencil demo` still prints a note as markdown.
 *
 * The bundle is built here, from source, into `.tmp/` — the suite is independent of whether
 * `npm run build` ran first and of `dist/` being current.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const OUT = join(ROOT, ".tmp", "vitest-cli", "cli-headless.js");

/** Bundles `src/cli/bin.ts` the way `scripts/build.mjs` does (node, ESM, node20). */
async function bundleCli(): Promise<string> {
  mkdirSync(join(ROOT, ".tmp", "vitest-cli"), { recursive: true });
  await build({
    entryPoints: [join(ROOT, "src", "cli", "bin.ts")],
    outfile: OUT,
    bundle: true,
    format: "esm",
    platform: "node",
    target: ["node20"],
    logLevel: "silent",
    define: { __BLUEPENCIL_VERSION__: JSON.stringify("0.0.0-test") },
  });
  return readFileSync(OUT, "utf8");
}

let bundleText = "";

beforeAll(async () => {
  bundleText = await bundleCli();
}, 60_000);

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [OUT, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("AC-A21 — the CLI entry is headless", () => {
  it("imports only headless modules — no src/index facade in the CLI", () => {
    const source = readFileSync(join(ROOT, "src", "cli", "bin.ts"), "utf8");
    expect(source).toMatch(/from "\.\.\/core\/store"/);
    expect(source).toMatch(/from "\.\.\/adapters\/memory"/);
    expect(source).toMatch(/from "\.\.\/core\/export\/markdown"/);
    // BP-06: neither the facade nor its blueprint factory may be imported by the CLI.
    expect(source).not.toMatch(/from "\.\.\/index"/);
    expect(source).not.toContain("createBlueprint");
  });

  it("runs demo through createStore, createMemoryAdapter and toMarkdown", () => {
    const source = readFileSync(join(ROOT, "src", "cli", "bin.ts"), "utf8");
    const demo = source.slice(source.indexOf('case "demo"'));
    const body = demo.slice(0, demo.indexOf('case "default"'));
    expect(body).toContain("createStore({ adapter: createMemoryAdapter() })");
    expect(body).toContain("toMarkdown(");
    expect(body).not.toContain("createBlueprint");
  });

  it("bundles without createLayer, createPanel or createComposer (dist/cli.js contract)", () => {
    expect(bundleText).not.toMatch(/createLayer\s*\(/);
    expect(bundleText).not.toMatch(/createPanel\s*\(/);
    expect(bundleText).not.toMatch(/createComposer\s*\(/);
  });

  it("prints the demo note as markdown", () => {
    const result = run(["demo"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.startsWith("# bluepencil review notes\n")).toBe(true);
    // Structural assertions rather than a byte snapshot: the renderer grows fields (e.g. the
    // origin bullet of AC-A13) without the demo contract changing.
    expect(result.stdout).toContain("_Notes: 1 · open decisions: 0 · feedback only: 0 · done: 0_");
    expect(result.stdout).toMatch(/#### n-[0-9a-f-]+ — text\/implement\/open/);
    expect(result.stdout).toContain("- Source: `cli:import`");
    expect(result.stdout).toContain("- Author: cli (human)");
    expect(result.stdout).toContain("- Anchor: hook `demo`");
    expect(result.stdout).toContain("  demo note from the CLI");
    expect(result.stdout.endsWith("\n")).toBe(true);
  });
});
