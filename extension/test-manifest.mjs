/**
 * Test-only extension build — `extension/dist-test`.
 *
 * The real rider of this file is one sentence from contract B.7.4: the extension needs broad host
 * access *to be mountable in a headless browser*, but the shipped manifest must not ask for it
 * (B.3b turns it into an optional permission). The three suites that load the extension and then
 * mount it on a fixture tab — `smoke:ext`, `smoke:parity`, `smoke:round-trip` — therefore load a
 * *second* build whose manifest differs from production in exactly one field: a `host_permissions`
 * grant covering http and https for every host (see `TEST_GRANT_HOST_PERMISSIONS` below).
 *
 * `buildTestGrant()` is the single implementation of that build (AC-B49, AC-B55). It:
 *
 *   1. refuses with a **named** error when `extension/dist/manifest.json` is missing — a missing
 *      build is a build error, never a skip (a suite that silently loads nothing reports green);
 *   2. deletes `extension/dist-test` **before** copying, so no file from an older build survives;
 *   3. copies `extension/dist` verbatim;
 *   4. rewrites **only** `host_permissions` in the copy.
 *
 * It is idempotent: calling it again after another suite already built the grant simply rebuilds the
 * same directory. `dist-test` is a build artefact — ignored by git and Docker, never in `build:ext`,
 * never in a release zip, and never in `npm pack` (`package.json.files` does not list `extension/`).
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The exact grant every mounting suite needs; the production manifest never carries it. */
export const TEST_GRANT_HOST_PERMISSIONS = Object.freeze(["http://*/*", "https://*/*"]);

/** The production build; its manifest is the source of truth for everything but the grant. */
export const DEFAULT_SOURCE = join(here, "dist");

/** The loadable test build. Never loaded by the product, never shipped. */
export const DEFAULT_TARGET = join(here, "dist-test");

/** Base error for this module. `code` is stable so a caller can branch without matching text. */
export class TestGrantError extends Error {
  constructor(message, { code = "test_grant_error", path } = {}) {
    super(message);
    this.name = "TestGrantError";
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

/**
 * The named failure for a checkout without a built extension: names the missing file *and* the
 * command that produces it, because "ENOENT" alone reads like a test bug.
 */
export class MissingExtensionBuildError extends TestGrantError {
  constructor(manifestPath) {
    super(
      `extension/dist/manifest.json is missing (${manifestPath}) — run \`npm run build:ext\` first; ` +
        "buildTestGrant() copies extension/dist and never builds it.",
      { code: "missing_build", path: manifestPath },
    );
    this.name = "MissingExtensionBuildError";
  }
}

/**
 * Build `extension/dist-test` from `extension/dist`.
 *
 * `source`/`target` exist for the unit suite only (it builds into a temp directory); callers pass
 * nothing. Returns the paths and the manifest that was written.
 */
export function buildTestGrant({ source = DEFAULT_SOURCE, target = DEFAULT_TARGET } = {}) {
  const manifestPath = join(source, "manifest.json");
  if (!existsSync(manifestPath)) throw new MissingExtensionBuildError(manifestPath);

  let production;
  try {
    production = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new TestGrantError(
      `${manifestPath} is not valid JSON: ${error.message} — run \`npm run build:ext\` again`,
      { code: "invalid_build_manifest", path: manifestPath },
    );
  }
  if (production === null || typeof production !== "object" || Array.isArray(production)) {
    throw new TestGrantError(
      `${manifestPath} is not a JSON object — run \`npm run build:ext\` again`,
      { code: "invalid_build_manifest", path: manifestPath },
    );
  }

  // Delete first: a copy on top of a stale directory is how a removed file keeps passing a smoke.
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });

  const manifest = { ...production, host_permissions: [...TEST_GRANT_HOST_PERMISSIONS] };
  writeFileSync(join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  return { source, target, manifest };
}
