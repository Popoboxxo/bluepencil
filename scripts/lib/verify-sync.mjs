/**
 * Pure logic for the build-sync identity gate (BUILD_SYNC_GUARD Baustein 1).
 *
 * The built web-extension package embeds the element bundle and records its content hash in
 * `extension/dist/build-info.json`, so the two sides must stay in lockstep: a stale
 * `dist/bluepencil.element.iife.js` next to a fresh `extension/dist` would ship a bundle the
 * extension never tested. The gate pins three identities — bundle hash, manifest version and
 * package version — to `package.json` as the single source of truth (SSOT).
 *
 * This module is deliberately side-effect-free: the vitest suite imports the pure functions, while
 * `scripts/verify-sync.mjs` is only the thin CLI wrapper that reads the files and exits. Keeping
 * the `readFileSync`/`createHash` calls out of the import path is what makes the logic testable
 * without shelling out.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Hash a file at `path` with SHA-256, returned as a lowercase hex string.
 *
 * Synchronous on purpose: the CLI is a short-lived guard, and a missing file must throw so the
 * caller can decide (in `verify-sync.mjs`) whether that means "missing bundle" rather than crash.
 *
 * @param {string} path
 * @returns {string} hex digest
 */
export function sha256File(path) {
  const data = readFileSync(path);
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Compare the four build inputs and collect *every* inconsistency.
 *
 * All errors are gathered instead of short-circuiting: a broken lockstep is usually several
 * mismatches at once, and the CI log should show the full picture in one run rather than one error
 * per push. The function never reads the filesystem — inputs are already-parsed objects (or `null`
 * when the CLI could not read them), which is exactly what the unit tests feed in.
 *
 * @param {object} [state]
 * @param {{ present: boolean, sha256: string|null }} [state.element]
 * @param {object|null} [state.buildInfo] parsed extension/dist/build-info.json
 * @param {object|null} [state.manifest]  parsed extension/manifest.json
 * @param {object|null} [state.pkg]       parsed package.json
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function verifySyncState({ element, buildInfo, manifest, pkg } = {}) {
  const errors = [];

  const elementPresent = Boolean(element && element.present);
  const elementSha = element && typeof element.sha256 === "string" ? element.sha256 : null;
  const buildSha =
    buildInfo && typeof buildInfo.elementSha256 === "string" ? buildInfo.elementSha256 : null;

  // Missing inputs first — a hash comparison only makes sense when both sides exist.
  if (!elementPresent) {
    errors.push("dist/bluepencil.element.iife.js is missing — run `npm run build`");
  }
  if (!buildInfo) {
    errors.push("extension/dist/build-info.json is missing — run `npm run build:ext`");
  }
  if (!manifest) {
    errors.push("extension/manifest.json is missing");
  }
  if (!pkg) {
    errors.push("package.json is missing");
  }

  // A present-but-hashless build-info cannot pin the bundle; treat it as its own error so the
  // message points at the build step rather than showing a confusing "null != hash" mismatch.
  if (buildInfo && buildSha === null) {
    errors.push("extension/dist/build-info.json has no elementSha256");
  }

  // A present-but-hashless bundle (unreadable file) is its own error: reporting it as a hash
  // mismatch would print the confusing "dist=null build-info=<hash>".
  if (elementPresent && elementSha === null) {
    errors.push("dist/bluepencil.element.iife.js could not be read (hash unavailable)");
  }

  if (elementPresent && elementSha !== null && buildSha !== null && elementSha !== buildSha) {
    errors.push(`element bundle hash mismatch: dist=${elementSha} build-info=${buildSha}`);
  }

  if (manifest && pkg && manifest.version !== pkg.version) {
    errors.push(
      `version mismatch: extension/manifest.json=${manifest.version} package.json=${pkg.version}`,
    );
  }

  if (buildInfo && pkg && buildInfo.version !== pkg.version) {
    errors.push(`build-info.json version ${buildInfo.version} != package.json ${pkg.version}`);
  }

  return { ok: errors.length === 0, errors };
}
