/**
 * @vitest-environment node — hashes a real temp file and reads real paths, so it needs Node's
 * `node:crypto`/`node:fs` namespaces; under jsdom those builtins carry only `default`.
 *
 * Unit tests for the build-sync identity gate (BUILD_SYNC_GUARD, Baustein 1).
 *
 * The gate exists so a stale element bundle cannot ship next to a fresh extension build: it pins the
 * bundle hash, the manifest version and the build-info version to package.json as the single source
 * of truth. The tests drive the pure `verifySyncState` with already-parsed inputs — including the
 * `null`s the CLI feeds in when a file is unreadable — and exercise `sha256File` over a real temp
 * file, so the two identities (content hash, version) are covered end to end without shelling out.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface VerifySyncModule {
  sha256File(path: string): string;
  verifySyncState(state: SyncState): { ok: boolean; errors: string[] };
}

// The gate ships as plain, untyped ESM. Resolving it by URL at run time keeps this suite honest
// without a hand-maintained `.d.mts` next to the lib (which would drift from it); `SyncState` below
// is the contract this suite holds the module to.
const verifySyncModuleUrl: string = new URL("../../scripts/lib/verify-sync.mjs", import.meta.url).href;
const { sha256File, verifySyncState } = (await import(verifySyncModuleUrl)) as VerifySyncModule;

/** Realistic 64-character lowercase SHA-256 digests. */
const ELEMENT_SHA = "b7e3a1c9d4f0e2b8a6c5d3f1e7b9a0c2d4f6e8a1b3c5d7f9e0a2b4c6d8f1e3a5";
const OTHER_SHA = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";

interface ManifestLike {
  version?: string;
}

interface BuildInfoLike {
  elementSha256?: string;
  version?: string;
}

interface SyncState {
  element?: { present: boolean; sha256: string | null };
  buildInfo?: BuildInfoLike | null;
  manifest?: ManifestLike | null;
  pkg?: ManifestLike | null;
}

/** A fully consistent state — every identity in lockstep. Individual cases override one slot. */
function state(overrides: Partial<SyncState> = {}): SyncState {
  const base: SyncState = {
    element: { present: true, sha256: ELEMENT_SHA },
    buildInfo: { elementSha256: ELEMENT_SHA, version: "0.5.0" },
    manifest: { version: "0.5.0" },
    pkg: { version: "0.5.0" },
  };
  return { ...base, ...overrides };
}

describe("verifySyncState — identity gate", () => {
  it("reports ok when the bundle hash and all three versions agree", () => {
    expect(verifySyncState(state())).toEqual({ ok: true, errors: [] });
  });

  it("reports a hash mismatch naming both hashes", () => {
    const result = verifySyncState(
      state({ element: { present: true, sha256: OTHER_SHA } }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    const message = result.errors.join("\n");
    expect(message).toContain("element bundle hash mismatch");
    expect(message).toContain(`dist=${OTHER_SHA}`);
    expect(message).toContain(`build-info=${ELEMENT_SHA}`);
    // Both hashes are strings, so the dedicated unreadable-bundle message must not appear.
    expect(message).not.toContain("could not be read");
  });

  it("reports a manifest/package version mismatch", () => {
    const result = verifySyncState(
      state({
        buildInfo: { elementSha256: ELEMENT_SHA, version: "0.6.0" },
        manifest: { version: "0.5.0" },
        pkg: { version: "0.6.0" },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("extension/manifest.json=0.5.0");
    expect(result.errors[0]).toContain("package.json=0.6.0");
  });

  it("reports a build-info/package version mismatch", () => {
    const result = verifySyncState(
      state({
        buildInfo: { elementSha256: ELEMENT_SHA, version: "0.5.0" },
        manifest: { version: "0.6.0" },
        pkg: { version: "0.6.0" },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("build-info.json version 0.5.0");
    expect(result.errors[0]).toContain("package.json 0.6.0");
  });
});

describe("verifySyncState — missing inputs", () => {
  it("reports the missing element bundle with the build hint", () => {
    const result = verifySyncState(state({ element: { present: false, sha256: null } }));

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("dist/bluepencil.element.iife.js is missing");
    expect(result.errors[0]).toContain("npm run build");
  });

  it("reports the missing build-info with the extension build hint", () => {
    const result = verifySyncState(state({ buildInfo: null }));

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("extension/dist/build-info.json is missing");
    expect(result.errors[0]).toContain("npm run build:ext");
  });

  it("reports the missing extension manifest", () => {
    const result = verifySyncState(state({ manifest: null }));

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("extension/manifest.json is missing");
  });

  it("reports the missing package.json", () => {
    const result = verifySyncState(state({ pkg: null }));

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("package.json is missing");
  });

  it("collects every error when all four inputs are missing at once (no short-circuit)", () => {
    const result = verifySyncState({
      element: { present: false, sha256: null },
      buildInfo: null,
      manifest: null,
      pkg: null,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(4);
    const message = result.errors.join("\n");
    expect(message).toContain("dist/bluepencil.element.iife.js is missing");
    expect(message).toContain("extension/dist/build-info.json is missing");
    expect(message).toContain("extension/manifest.json is missing");
    expect(message).toContain("package.json is missing");
  });

  it("calls out a present build-info that carries no elementSha256", () => {
    const result = verifySyncState(state({ buildInfo: { version: "0.5.0" } }));

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("extension/dist/build-info.json has no elementSha256");
  });

  it("reports a present-but-hashless bundle as unreadable, never as a hash mismatch", () => {
    // The element file exists but its bytes could not be hashed (unreadable), while build-info,
    // manifest and package.json are all valid. Reporting this as a mismatch would print the
    // confusing "dist=null build-info=<hash>" pair, so it must be its own error.
    const result = verifySyncState(
      state({ element: { present: true, sha256: null } }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toBe(
      "dist/bluepencil.element.iife.js could not be read (hash unavailable)",
    );
    // Regression guard: only the unreadable-bundle error, never the conflated mismatch phrasing.
    expect(result.errors.some((error) => error.includes("hash mismatch"))).toBe(false);
  });

  it("treats an empty state as four missing inputs", () => {
    const result = verifySyncState({});

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(4);
  });
});

describe("sha256File", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("returns the lowercase hex SHA-256 of the file's bytes", () => {
    dir = mkdtempSync(join(tmpdir(), "bp-verify-sync-"));
    const file = join(dir, "bluepencil.element.iife.js");
    const content = "console.log(\"bluepencil element bundle\");\n";
    writeFileSync(file, content);

    const digest = sha256File(file);
    expect(digest).toBe(createHash("sha256").update(content).digest("hex"));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws for a path that does not exist", () => {
    const missing = join(tmpdir(), `bp-verify-sync-missing-${process.pid}-${Date.now()}.js`);

    expect(() => sha256File(missing)).toThrow();
  });
});
