/**
 * @vitest-environment node — the module is plain ESM that shells out to git in its CLI wrapper; the
 * suite itself only needs the Node module loader, which jsdom's builtin namespace shims break.
 *
 * Unit tests for the version-bump gate (BUILD_SYNC_GUARD, Baustein 2).
 *
 * The gate blocks a behavioural diff (library sources, element build, shipped extension sources and
 * static files, reference server) that does not move the `package.json` version: package.json is the
 * version SSOT, and an
 * unbumped change would leave the manifest, bundle and store release describing a different binary.
 * All three functions are pure, so the failure modes are exercised directly rather than by shelling
 * out to git.
 */

import { describe, expect, it } from "vitest";

interface VersionBumpInput {
  changedFiles?: ReadonlyArray<string | undefined | null> | null;
  baseVersion?: string;
  headVersion?: string;
}

interface VersionBumpModule {
  BEHAVIOURAL_PREFIXES: readonly string[];
  SHIPPED_EXACT_FILES: readonly string[];
  isBehaviouralPath(file: string | undefined | null): boolean;
  behaviouralFiles(files: ReadonlyArray<string | undefined | null> | null | undefined): string[];
  evaluateVersionBump(input?: VersionBumpInput): { ok: boolean; behavioural: string[]; reason: string };
}

// Plain, untyped ESM: resolved by URL at run time so no hand-written `.d.mts` can drift from it.
const versionBumpModuleUrl: string = new URL("../../scripts/lib/version-bump.mjs", import.meta.url).href;
const { BEHAVIOURAL_PREFIXES, SHIPPED_EXACT_FILES, behaviouralFiles, evaluateVersionBump, isBehaviouralPath } =
  (await import(versionBumpModuleUrl)) as VersionBumpModule;

describe("BEHAVIOURAL_PREFIXES", () => {
  it("lists the shippable roots and includes src/ and server/", () => {
    expect(Array.isArray(BEHAVIOURAL_PREFIXES)).toBe(true);
    expect(BEHAVIOURAL_PREFIXES.length).toBeGreaterThan(0);
    expect(BEHAVIOURAL_PREFIXES).toContain("src/");
    expect(BEHAVIOURAL_PREFIXES).toContain("server/");
  });

  it("no longer lists the exact-match manifest file, keeping src/ and server/", () => {
    // The manifest is a single file, not a directory, so it is matched exactly in
    // isBehaviouralPath rather than carried as a (slash-terminated) prefix here.
    expect(BEHAVIOURAL_PREFIXES).not.toContain("extension/manifest.json");
    expect(BEHAVIOURAL_PREFIXES).toContain("src/");
    expect(BEHAVIOURAL_PREFIXES).toContain("server/");
  });
});

describe("SHIPPED_EXACT_FILES", () => {
  it("lists the shipped single files that no BEHAVIOURAL_PREFIXES root covers", () => {
    expect(SHIPPED_EXACT_FILES).toContain("extension/manifest.json");
    expect(SHIPPED_EXACT_FILES).toContain("extension/options.html");
  });

  it("does not list the extension build tooling", () => {
    // The tooling runs at build time; it never ships inside the artefact, so it must not force a bump.
    for (const file of [
      "extension/build.mjs",
      "extension/smoke.mjs",
      "extension/probe.mjs",
      "extension/tsconfig.json",
    ]) {
      expect(SHIPPED_EXACT_FILES).not.toContain(file);
    }
  });
});

describe("isBehaviouralPath", () => {
  it.each([
    "src/core/model.ts",
    "src/element/index.ts",
    "extension/src/sw.ts",
    "extension/manifest.json",
    "extension/options.html",
    "server/index.ts",
  ])("classifies a shipped path as behavioural: %s", (file) => {
    expect(isBehaviouralPath(file)).toBe(true);
  });

  it.each([
    "docs/RELEASING.md",
    "tests/unit/foo.test.ts",
    "package.json",
    "README.md",
    ".github/workflows/ci.yml",
    "scripts/build.mjs",
    "extension/build.mjs",
    "extension/smoke.mjs",
    "extension/probe.mjs",
    "extension/tsconfig.json",
  ])("classifies a non-shipped path as not behavioural: %s", (file) => {
    expect(isBehaviouralPath(file)).toBe(false);
  });

  it("normalises a leading ./ before matching", () => {
    expect(isBehaviouralPath("./src/x.ts")).toBe(true);
    expect(isBehaviouralPath("./docs/RELEASING.md")).toBe(false);
  });

  it.each([
    "srcfoo/x.ts",
    "serverfoo/x.ts",
    "extension/manifest.json.bak",
    "extension/options.html.bak",
    "x/src/y.ts",
  ])("does not match a prefix without a path boundary: %s", (file) => {
    // A bare startsWith would treat "srcfoo/" as "src/"; the trailing slash is the boundary.
    expect(isBehaviouralPath(file)).toBe(false);
  });

  it("matches the shipped single files by exact path though they are not prefixes", () => {
    expect(BEHAVIOURAL_PREFIXES).not.toContain("extension/manifest.json");
    expect(BEHAVIOURAL_PREFIXES).not.toContain("extension/options.html");
    expect(isBehaviouralPath("extension/manifest.json")).toBe(true);
    expect(isBehaviouralPath("./extension/manifest.json")).toBe(true);
    expect(isBehaviouralPath("extension/options.html")).toBe(true);
    expect(isBehaviouralPath("./extension/options.html")).toBe(true);
  });

  it("treats undefined and null as not behavioural", () => {
    expect(isBehaviouralPath(undefined)).toBe(false);
    expect(isBehaviouralPath(null)).toBe(false);
  });
});

describe("behaviouralFiles", () => {
  it("keeps only the behavioural paths and preserves their order", () => {
    const changed = [
      "docs/RELEASING.md",
      "src/core/model.ts",
      "package.json",
      "extension/src/sw.ts",
      "README.md",
      "server/index.ts",
    ];

    expect(behaviouralFiles(changed)).toEqual([
      "src/core/model.ts",
      "extension/src/sw.ts",
      "server/index.ts",
    ]);
  });

  it("tolerates null and undefined entries", () => {
    expect(behaviouralFiles(["docs/RELEASING.md", undefined, null, "src/x.ts"])).toEqual(["src/x.ts"]);
  });

  it("treats null and undefined inputs as no behavioural change", () => {
    expect(behaviouralFiles(null)).toEqual([]);
    expect(behaviouralFiles(undefined)).toEqual([]);
  });
});

describe("evaluateVersionBump", () => {
  it("passes when no behavioural file changed", () => {
    const result = evaluateVersionBump({
      changedFiles: ["docs/RELEASING.md", "README.md", "package.json"],
      baseVersion: "0.5.0",
      headVersion: "0.5.0",
    });

    expect(result.ok).toBe(true);
    expect(result.behavioural).toEqual([]);
  });

  it("passes when a behavioural change comes with a version bump", () => {
    const result = evaluateVersionBump({
      changedFiles: ["src/core/model.ts", "package.json"],
      baseVersion: "0.5.0",
      headVersion: "0.6.0",
    });

    expect(result.ok).toBe(true);
    expect(result.behavioural).toEqual(["src/core/model.ts"]);
  });

  it("fails when only the shipped options page changed without a version bump", () => {
    const result = evaluateVersionBump({
      changedFiles: ["extension/options.html"],
      baseVersion: "0.5.0",
      headVersion: "0.5.0",
    });

    expect(result.ok).toBe(false);
    expect(result.behavioural).toEqual(["extension/options.html"]);
    expect(result.reason).toContain("package.json version is unchanged");
  });

  it("fails on a behavioural change without a version bump and names the offenders", () => {
    const result = evaluateVersionBump({
      changedFiles: ["src/core/model.ts", "server/index.ts", "docs/RELEASING.md"],
      baseVersion: "0.5.0",
      headVersion: "0.5.0",
    });

    expect(result.ok).toBe(false);
    expect(result.behavioural).toEqual(["src/core/model.ts", "server/index.ts"]);
    expect(result.reason).toContain("package.json version is unchanged");
  });

  it("fails when both versions are undefined (unresolvable base)", () => {
    const result = evaluateVersionBump({
      changedFiles: ["src/core/model.ts"],
      baseVersion: undefined,
      headVersion: undefined,
    });

    expect(result.ok).toBe(false);
    expect(result.behavioural).toEqual(["src/core/model.ts"]);
  });

  it("passes for an empty changed-file list", () => {
    const result = evaluateVersionBump({
      changedFiles: [],
      baseVersion: "0.5.0",
      headVersion: "0.5.0",
    });

    expect(result.ok).toBe(true);
    expect(result.behavioural).toEqual([]);
  });
});
