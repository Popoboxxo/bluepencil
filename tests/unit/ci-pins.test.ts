/**
 * @vitest-environment node — reads the real workflow files and runs the pin checker against them.
 *
 * Pins protect the pipeline from a moved tag (SEC-22, AC-I01), least privilege keeps a test run from
 * holding a write token (SEC-27, AC-I04/AC-I05), and the reqmd digest has to be a constant in the
 * workflow rather than a file downloaded beside the binary it blesses (SEC-28, AC-I06).
 *
 * The module is plain, untyped ESM, resolved by URL so no hand-written `.d.mts` can drift from it —
 * the same pattern `version-bump.test.ts` uses for `scripts/lib/`.
 */
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

interface Violation {
  file: string;
  line: number;
  reason: string;
  text: string;
}

interface PinModule {
  DEFAULT_DIR: string;
  checkSource(source: string, file: string): Violation[];
  checkDirectory(dir: string): Promise<{ files: string[]; violations: Violation[] }>;
}

// Plain, untyped ESM: resolved by URL at run time so no hand-written `.d.mts` can drift from it.
const pinModuleUrl: string = new URL("../../scripts/ci-pins.mjs", import.meta.url).href;
const { DEFAULT_DIR, checkSource, checkDirectory } = (await import(pinModuleUrl)) as PinModule;

const root = new URL("../../", import.meta.url);
const readRepoFile = (relativePath: string): string => readFileSync(new URL(relativePath, root), "utf8");

const REQMD_SHA256 = "7f9eb531b42505a4e4aa2b7e42f9978d1b3341f6a953dd0a3b6525e214f09f52";

describe("the workflows this repository actually ships", () => {
  it("pins every `uses:` to a 40-hex SHA with a tag comment", async () => {
    const { files, violations } = await checkDirectory(DEFAULT_DIR);
    expect(files).toEqual([
      "chrome-webstore.yml",
      "ci.yml",
      "extension.yml",
      "pages.yml",
      "release.yml",
    ]);
    expect(violations).toEqual([]);
  });

  it("names a version in every tag comment, so a hash stays readable", () => {
    for (const file of ["ci.yml", "release.yml", "extension.yml", "pages.yml", "chrome-webstore.yml"]) {
      const uses = readRepoFile(`.github/workflows/${file}`)
        .split("\n")
        .filter((line) => /^\s*-?\s*uses:/.test(line));
      expect(uses.length).toBeGreaterThan(0);
      for (const line of uses) {
        expect(line).toMatch(/@[0-9a-f]{40}\s+#\s+v\d+\.\d+\.\d+/);
      }
    }
  });

  // AC-I04
  it("ci.yml declares `contents: read` at workflow level and no job widens it", () => {
    const ci = readRepoFile(".github/workflows/ci.yml");
    expect(ci).toMatch(/^permissions:\n {2}contents: read$/m);
    // A job-level `permissions:` would be indented under its job; the workflow-level one is not.
    const jobLevel = ci.split("\n").filter((line) => /^ {4}permissions:/.test(line));
    expect(jobLevel).toEqual([]);
  });

  // AC-I05
  it("the release job installs without an npm cache", () => {
    const release = readRepoFile(".github/workflows/release.yml");
    const start = release.indexOf("\n  release:");
    const end = release.indexOf("\n  image:");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const releaseJob = release.slice(start, end);
    expect(releaseJob).toContain("actions/setup-node@");
    expect(releaseJob).not.toMatch(/^\s*cache:/m);
  });

  // AC-I06
  it("checks reqmd against a hard-coded SHA-256, not against a downloaded SHA256SUMS.txt", () => {
    for (const file of ["ci.yml", "release.yml"]) {
      const workflow = readRepoFile(`.github/workflows/${file}`);
      expect(workflow).toContain(REQMD_SHA256);
      expect(workflow).not.toContain("SHA256SUMS.txt");
    }
  });

  it("wires `check:pins` to the checker", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["check:pins"]).toBe("node scripts/ci-pins.mjs");
  });
});

describe("checkSource", () => {
  it("accepts a pinned action with a tag comment", () => {
    const source = [
      "steps:",
      "  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
      "  - uses: ./local/action",
    ].join("\n");
    expect(checkSource(source, "ok.yml")).toEqual([]);
  });

  it.each([
    ["a major-version tag", "      - uses: actions/checkout@v7", /mutable ref "v7"/],
    ["a full version tag", "      - uses: actions/setup-node@v7.1.0", /mutable ref "v7\.1\.0"/],
    ["a branch", "      - uses: actions/checkout@main", /mutable ref "main"/],
    ["no ref at all", "      - uses: actions/checkout", /no ref at all/],
    [
      "a truncated SHA",
      "      - uses: actions/checkout@3d3c42e # v7.0.1",
      /not owner\/repo@<40 lowercase hex>/,
    ],
    [
      "an uppercase SHA",
      "      - uses: actions/checkout@3D3C42E5AAC5BA805825DA76410C181273BA90B1 # v7.0.1",
      /not owner\/repo@<40 lowercase hex>/,
    ],
    [
      "a container action by tag",
      "      - uses: docker://alpine:3.20",
      /container action must be pinned by digest/,
    ],
  ])("fails on %s", (_label, line, reason) => {
    const violations = checkSource(`steps:\n${line}\n`, "bad.yml");
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toMatch(reason);
  });

  it("fails a pinned SHA that has no tag comment — an unreadable pin is not maintainable", () => {
    const violations = checkSource(
      "steps:\n  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n",
      "bad.yml",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toMatch(/missing `# vX\.Y\.Z` comment/);
  });

  it("reports the 1-based line number of the offending ref", () => {
    const violations = checkSource("steps:\n  - run: echo hi\n  - uses: actions/checkout@v7\n", "bad.yml");
    expect(violations[0]?.line).toBe(3);
  });

  it("does not mistake a `#` inside the ref for a comment", () => {
    const violations = checkSource("steps:\n  - uses: actions/checkout@v7 # v7.0.1\n", "bad.yml");
    expect(violations[0]?.reason).toMatch(/mutable ref "v7"/);
  });
});

describe("checkDirectory", () => {
  const dirs: string[] = [];
  afterAll(() => {
    while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  const fixture = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "bp-ci-pins-"));
    dirs.push(dir);
    for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
    return dir;
  };

  it("reads every yml and yaml file and ignores anything else", async () => {
    const dir = fixture({
      "a.yml": "steps:\n  - uses: actions/checkout@v7\n",
      "b.yaml": "steps:\n  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n",
      "notes.md": "not a workflow",
    });
    const { files, violations } = await checkDirectory(dir);
    expect(files).toEqual(["a.yml", "b.yaml"]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file.endsWith("a.yml")).toBe(true);
  });

  it("throws for a directory that does not exist, so the CLI cannot pass vacuously", async () => {
    await expect(checkDirectory(join(tmpdir(), "bp-ci-pins-does-not-exist"))).rejects.toThrow();
  });
});
