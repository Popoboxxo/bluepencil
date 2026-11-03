/**
 * @vitest-environment node — the subject is a build step over the filesystem, plus `npm pack`.
 *
 * `extension/test-manifest.mjs` exists because the production extension must not ask for broad host
 * access (B.3b makes it optional) while the three suites that mount the extension in a headless
 * browser still need it. `buildTestGrant()` is the single implementation of that second build
 * (AC-B49, AC-B55) and `smoke-review.mjs` calls it itself (AC-B57, tail — observable only once this
 * task exists).
 *
 * What is asserted here is deliberately the part a browser run cannot show:
 *
 *   - the grant is a copy with exactly one field replaced, and a stale `dist-test` never survives;
 *   - a missing `extension/dist/manifest.json` is a **named** error, not an opaque ENOENT;
 *   - `dist-test` is not committable (`gitignore`), not buildable into an image (`dockerignore`) and
 *     not packable (`npm pack --dry-run`);
 *   - all three mounting suites load `extension/dist-test` and call `buildTestGrant()`, with parity
 *     calling it *after* its own extension rebuild.
 *
 * The module is exercised in a child Node process rather than imported: it is plain ESM without a
 * type declaration, and spawning it keeps this suite's assertions on the real artefact instead of a
 * re-typed copy. Each call writes into a fresh temp directory; the repo's own `dist-test` is not
 * touched.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const MODULE = join(root, "extension/test-manifest.mjs");
const TEST_GRANT = ["http://*/*", "https://*/*"];

const read = (path: string): string => readFileSync(join(root, path), "utf8");

interface GrantRun {
  ok: boolean;
  target?: string;
  manifest?: Record<string, unknown>;
  name?: string;
  code?: string;
  message?: string;
}

/**
 * Run `buildTestGrant({ source, target })` in a child Node process and return its report.
 *
 * A throw is reported as `{ ok: false, name, code, message }` with exit code 1, so the named-error
 * case can assert on the error's own fields rather than on output formatting.
 */
function runBuildTestGrant(source: string, target: string): GrantRun {
  const script = `
    import { buildTestGrant } from ${JSON.stringify(pathToFileURL(MODULE).href)};
    try {
      const result = buildTestGrant({
        source: ${JSON.stringify(source)},
        target: ${JSON.stringify(target)},
      });
      console.log(JSON.stringify({
        ok: true,
        target: result.target,
        manifest: result.manifest,
      }));
    } catch (error) {
      console.log(JSON.stringify({
        ok: false,
        name: error.name,
        code: error.code,
        message: error.message,
      }));
      process.exitCode = 1;
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  });
  const stdout = String(result.stdout ?? "").trim();
  const line = stdout.split("\n").at(-1) ?? "";
  return JSON.parse(line) as GrantRun;
}

/** A minimal but realistic production build: a manifest plus the files a load needs. */
function writeProductionBuild(dir: string, manifest: Record<string, unknown> = {}): string {
  const source = join(dir, "dist");
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, "manifest.json"),
    `${JSON.stringify(
      {
        manifest_version: 3,
        name: "Bluepencil Review Layer",
        version: "0.12.0",
        permissions: ["scripting", "storage", "activeTab"],
        content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
        ...manifest,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(source, "sw.js"), "// production worker\n");
  writeFileSync(join(source, "review.js"), "export const renderReview = () => {};\n");
  return source;
}

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bp-test-grant-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildTestGrant() — the test-only extension build (AC-B49)", () => {
  it("copies the production build and replaces host_permissions only", () => {
    const dir = tempDir();
    const source = writeProductionBuild(dir, { host_permissions: ["https://prod.example/*"] });
    const target = join(dir, "dist-test");

    const run = runBuildTestGrant(source, target);

    expect(run.ok).toBe(true);
    expect(run.target).toBe(target);
    expect(run.manifest?.host_permissions).toEqual(TEST_GRANT);

    // Every other field is byte-for-byte the production value; the grant is the only difference.
    const production = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")) as Record<string, unknown>;
    const { host_permissions: _productionHosts, ...productionRest } = production;
    const { host_permissions: _grant, ...testRest } = run.manifest ?? {};
    expect(testRest).toEqual(productionRest);

    // The rest of the build is a real copy, not just the manifest.
    expect(readFileSync(join(target, "sw.js"), "utf8")).toBe("// production worker\n");
    expect(readFileSync(join(target, "review.js"), "utf8")).toContain("renderReview");
  });

  it("deletes dist-test before copying, so no stale file survives", () => {
    const dir = tempDir();
    const source = writeProductionBuild(dir);
    const target = join(dir, "dist-test");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "stale.js"), "// from an older build\n");
    writeFileSync(
      join(target, "manifest.json"),
      `${JSON.stringify({ manifest_version: 3, host_permissions: ["<all_urls>"] }, null, 2)}\n`,
    );

    const run = runBuildTestGrant(source, target);

    expect(run.ok).toBe(true);
    expect(existsSync(join(target, "stale.js"))).toBe(false);
    expect(run.manifest?.host_permissions).toEqual(TEST_GRANT);
  });

  it("is idempotent — a second call rebuilds the same grant", () => {
    const dir = tempDir();
    const source = writeProductionBuild(dir);
    const target = join(dir, "dist-test");

    const first = runBuildTestGrant(source, target);
    const second = runBuildTestGrant(source, target);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.manifest).toEqual(first.manifest);
    expect(existsSync(join(target, "manifest.json"))).toBe(true);
  });

  it("fails with the named MissingExtensionBuildError when dist/manifest.json is missing", () => {
    const dir = tempDir();
    const source = join(dir, "dist");
    mkdirSync(source, { recursive: true });
    const target = join(dir, "dist-test");

    const run = runBuildTestGrant(source, target);

    expect(run.ok).toBe(false);
    expect(run.name).toBe("MissingExtensionBuildError");
    expect(run.code).toBe("missing_build");
    expect(run.message).toContain(join(source, "manifest.json"));
    expect(run.message).toContain("npm run build:ext");
    // A failed build must not leave a half-written target behind.
    expect(existsSync(target)).toBe(false);
  });
});

describe("the test grant never leaves the test path (AC-B49)", () => {
  it("extension/dist-test is ignored by git and excluded from the Docker context", () => {
    expect(read(".gitignore")).toMatch(/^extension\/dist-test\/$/m);
    expect(read(".dockerignore")).toMatch(/^extension\/dist-test\/?$/m);
    // The production build keeps its own, pre-existing entry; this task only adds the grant.
    expect(read(".gitignore")).toMatch(/^extension\/dist\/$/m);
    expect(read(".dockerignore")).toMatch(/^extension\/dist$/m);
  });

  it("build:ext does not know about dist-test", () => {
    expect(read("extension/build.mjs")).not.toContain("dist-test");
  });

  it("npm pack --dry-run ships nothing under extension/", () => {
    const raw = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: root,
      encoding: "utf8",
      timeout: 180_000,
    });
    expect(raw.status, `npm pack failed: ${String(raw.stderr ?? "")}`).toBe(0);

    // `npm pack` runs `prepare`, so the build log can precede the JSON report; take the last array.
    const output = String(raw.stdout ?? "");
    const jsonStart = output.lastIndexOf("\n[");
    const parsed = JSON.parse(jsonStart === -1 ? output : output.slice(jsonStart + 1)) as Array<{
      files?: Array<{ path: string }>;
    }>;
    const packed = (parsed[0]?.files ?? []).map((file) => file.path);

    // Guard against a silently empty report making the negative assertion vacuous.
    expect(packed).toContain("dist/bluepencil.js");
    expect(packed.filter((path) => path === "extension" || path.startsWith("extension/"))).toEqual([]);
  }, 180_000);
});

describe("the three mounting suites load the grant (AC-B55)", () => {
  const smoke = read("extension/smoke.mjs");
  const parity = read("tests/e2e/parity.e2e.mjs");
  const roundTrip = read("tests/e2e/round-trip.e2e.mjs");

  it("smoke:ext builds and loads extension/dist-test", () => {
    expect(smoke).toContain('join(here, "dist-test")');
    expect(smoke).toContain("buildTestGrant()");
    // The production directory is read for the manifest diff, never loaded.
    expect(smoke).not.toMatch(/const extDist = join\(here, "dist"\);/);
  });

  it("smoke:parity builds the grant after its own extension rebuild", () => {
    expect(parity).toContain('join(root, "extension/dist-test")');
    expect(parity).toContain("buildTestGrant();");
    expect(parity).not.toMatch(/const EXT_DIST = join\(root, "extension\/dist"\);/);

    // Contract B.7.4: parity rebuilds `extension/dist` itself, then copies the fresh build.
    const rebuild = parity.indexOf('join(root, "extension/build.mjs")');
    const grant = parity.indexOf("buildTestGrant();");
    expect(rebuild).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(rebuild);
  });

  it("smoke:round-trip builds the grant before loading the extension", () => {
    expect(roundTrip).toContain('join(root, "extension/dist-test")');
    expect(roundTrip).toContain("buildTestGrant();");
    expect(roundTrip).not.toMatch(/const EXT_DIST = join\(root, "extension\/dist"\);/);

    const grant = roundTrip.indexOf("buildTestGrant();");
    const load = roundTrip.indexOf("launchWithExtension(PROFILE_EXT)");
    expect(load).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(-1);
    expect(grant).toBeLessThan(load);
  });
});

describe("smoke-review.mjs owns the grant and the review cases (AC-B57)", () => {
  const smoke = read("extension/smoke.mjs");
  const review = read("extension/smoke-review.mjs");
  const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
  const ci = read(".github/workflows/ci.yml");

  it("smoke.mjs carries no review, assign or undo case and no registerContentScripts expectation", () => {
    expect(smoke).not.toMatch(/review\.html/);
    expect(smoke).not.toMatch(/\b(?:applyAssign|applyUndo|planAssignToOrigin|planUndoAssign)\b/);
    expect(smoke).not.toContain("registerContentScripts");
  });

  it("smoke-review builds the grant itself, idempotently, before requiring a browser", () => {
    expect(review).toContain("buildTestGrant()");
    // It runs before the artefact check, which in turn runs before the browser requirement: a
    // missing build is a named FAIL even on a machine without Chrome (and even as the first step).
    expect(review.indexOf("buildTestGrant()")).toBeLessThan(
      review.indexOf("const missing = missingArtefacts();"),
    );
    expect(review.indexOf("if (!ensureTestGrant())")).toBeGreaterThan(-1);
    expect(review.indexOf("if (!ensureTestGrant())")).toBeLessThan(review.indexOf("requireBrowser("));
    expect(review).toContain("FAIL ${error.name");
    expect(review).toContain('const extDist = join(here, "dist-test");');
    // The review cases live here, not in smoke.mjs: the hostile body and the assign/undo buttons.
    expect(review).toContain("HOSTILE_BODY");
    expect(review).toContain('button[data-action="assign"]');
    expect(review).toContain('button[data-action="undo"]');
  });

  it("is reachable as npm run smoke:ext:review", () => {
    expect(pkg.scripts?.["smoke:ext:review"]).toBe("node extension/smoke-review.mjs");
  });

  it("ci.yml adds exactly one Review-page smoke step, after the extension smoke", () => {
    const steps = ci.match(/^      - name: Review-page smoke .*$/gm) ?? [];
    expect(steps).toHaveLength(1);
    expect(ci.indexOf("Review-page smoke")).toBeGreaterThan(
      ci.indexOf("Extension smoke (MV3 extension in a real Chrome)"),
    );
    expect(ci).toContain("run: npm run smoke:ext:review");
  });
});
