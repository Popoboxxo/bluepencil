/**
 * Documentation truth — K (AC-K01–K04, K06), plus the tail blocks
 * E (AC-E06), G (AC-G06) and J (AC-J07).
 *
 * These ACs observe prose, not behaviour: each assertion pins a *fact* that a reader relies on
 * (the tree matches the repository, the security comment is honest, the removed feature is really
 * gone, the container guide carries its warnings) without freezing whole files. The checks are
 * token- and section-based so unrelated edits elsewhere in a document stay green.
 *
 * The source half of AC-E06 lives in `tests/unit/federation-security.test.ts`; the source half of
 * AC-G06 lives in `tests/unit/voice-removal.test.ts`. This file owns the documentation half.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import * as data from "../../src/data/index";

const ROOT = process.cwd();

function doc(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/** The contents of the first fenced code block after `heading` (fence markers stripped). */
function codeBlockAfter(markdown: string, heading: string): string {
  const headingAt = markdown.indexOf(heading);
  if (headingAt < 0) throw new Error(`missing heading: ${heading}`);
  const fenceStart = markdown.indexOf("```", headingAt);
  if (fenceStart < 0) throw new Error(`missing code block after: ${heading}`);
  const fenceEnd = markdown.indexOf("```", fenceStart + 3);
  if (fenceEnd < 0) throw new Error(`unterminated code block after: ${heading}`);
  return markdown.slice(fenceStart + 3, fenceEnd);
}

/* ------------------------------------------------------------------------------------------------
 * K — AC-K02: the layout is the repository
 * ---------------------------------------------------------------------------------------------- */

describe("docs.architecture_layout (AC-K02)", () => {
  const architecture = doc("docs/ARCHITECTURE.md");

  /** Only the tree itself is compared; the roadmap note is allowed to name unbuilt ideas. */
  const tree = codeBlockAfter(architecture, "## 1. Repository layout");

  it("lists the modules that actually exist", () => {
    // The tree is nested, so a path like `src/ui/present.ts` is two levels (`ui/` then
    // `present.ts`); assert the tokens that carry the fact instead of a flattened path string.
    for (const expected of ["├─ embed/", "present.ts", "keymap.ts", "├─ extension/"]) {
      expect(tree, `layout is missing ${expected}`).toContain(expected);
    }

    const examples = tree.slice(tree.indexOf("├─ examples/"), tree.indexOf("├─ scripts/"));
    expect(examples).not.toBe("");
    for (const example of ["attach/", "parity/", "presentation/", "federation/"]) {
      expect(examples, `layout is missing examples/${example}`).toContain(example);
    }
  });

  it("drops the directories that were never built", () => {
    for (const gone of [
      "src/react/",
      "bookmarklet/",
      "examples/react/",
      "examples/home-assistant/",
    ]) {
      expect(tree, `layout still claims ${gone}`).not.toContain(gone);
    }
  });

  it("no longer calls the layout planned", () => {
    expect(architecture).not.toMatch(/^#{1,6}[^\n]*\bplanned\b/im);
  });

  it("moves the unbuilt ideas into a roadmap note", () => {
    expect(architecture).toMatch(/Roadmap note/i);
    expect(architecture).toMatch(/React wrapper/);
    expect(architecture).toMatch(/Home-Assistant/);
  });

  /* AC-K01 — the docs-truth half: the example names symbols that `bluepencil/data` really has.
   * `smoke:pack` owns the execution half (T-K4); this check fails the moment a fix reverts it. */
  it("keeps the headless example on the real data surface", () => {
    const example = codeBlockAfter(architecture, "### Headless use");
    const imports = [...example.matchAll(/import\s*\{([^}]*)\}\s*from\s*"bluepencil\/data"/gu)]
      .flatMap((match) => (match[1] ?? "").split(","))
      .map((name) => name.trim())
      .filter((name) => name !== "");

    expect(imports.length).toBeGreaterThan(0);
    const exported = new Set(Object.keys(data));
    for (const name of imports) {
      expect(exported.has(name), `${name} is not exported by bluepencil/data`).toBe(true);
    }
    expect(example).not.toContain("mergeBundles");
    expect(example).not.toContain("createStore");
  });
});

/* ------------------------------------------------------------------------------------------------
 * K — AC-K06: the package ships user-facing docs explicitly, never internal material
 * ---------------------------------------------------------------------------------------------- */

describe("docs.package_allowlist (AC-K06)", () => {
  const pkg = JSON.parse(doc("package.json")) as { files?: string[] };
  const files = pkg.files ?? [];

  /** Directories and files that are working material, not part of the published package. */
  const INTERNAL = ["docs/plans", "docs/reviews", "docs/spikes", "docs/specs", "docs/INDEX.md"];

  /** The user-facing guides the README links to; each is listed by name, not via `docs/`. */
  const USER_FACING = [
    "docs/ARCHITECTURE.md",
    "docs/BUILD-SYNC.md",
    "docs/CONCEPT.md",
    "docs/DOCKER.md",
    "docs/E2E-COVERAGE.md",
    "docs/EMBED.md",
    "docs/EXTENSION.md",
    "docs/FEDERATION.md",
    "docs/HERMES.md",
    "docs/INTEGRATION.md",
    "docs/INTERNAL-API.md",
    "docs/MCP.md",
    "docs/PRIVACY.md",
    "docs/PROTOCOL.md",
    "docs/RELEASING.md",
    "docs/REQUIREMENTS.md",
    "docs/WEBSTORE.md",
  ];

  it("ships the entry points the README promises", () => {
    for (const entry of ["dist", "README.md", "LICENSE"]) {
      expect(files, `files is missing ${entry}`).toContain(entry);
    }
  });

  it("lists the user-facing docs explicitly instead of the whole docs tree", () => {
    expect(files, "files must not ship the whole docs/ tree").not.toContain("docs");
    for (const entry of USER_FACING) {
      expect(files, `files is missing ${entry}`).toContain(entry);
    }
    for (const entry of files.filter((file) => file.startsWith("docs/"))) {
      expect(existsSync(join(ROOT, entry)), `${entry} is listed but does not exist`).toBe(true);
    }
  });

  it("never lists internal plans, reviews, spikes or specs", () => {
    for (const entry of files) {
      for (const internal of INTERNAL) {
        expect(entry.startsWith(internal), `${entry} is internal and must not be packed`).toBe(false);
      }
    }
  });

  /* AC-K01, execution half: the example names callables the real data surface really exposes.
   * `smoke:pack` additionally runs the block verbatim against `dist/data.js`. */
  it("resolves the headless example against callable data exports", () => {
    const example = codeBlockAfter(doc("docs/ARCHITECTURE.md"), "### Headless use");
    const imports = [...example.matchAll(/import\s*\{([^}]*)\}\s*from\s*"bluepencil\/data"/gu)]
      .flatMap((match) => (match[1] ?? "").split(","))
      .map((name) => name.trim())
      .filter((name) => name !== "");

    expect(imports.length).toBeGreaterThan(0);
    const live = data as unknown as Record<string, unknown>;
    for (const name of imports) {
      expect(typeof live[name], `${name} is not callable on bluepencil/data`).toBe("function");
    }
  });
});

/* ------------------------------------------------------------------------------------------------
 * K — AC-K03/AC-K04: the version has one home; the type convention matches the public API
 * ---------------------------------------------------------------------------------------------- */

/** The body of a level-2 `## heading`, up to the next level-2 heading. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  if (start < 0) throw new Error(`missing section: ${heading}`);
  const rest = markdown.slice(start + heading.length);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("docs.build_sync_version (AC-K03)", () => {
  const buildSync = doc("docs/BUILD-SYNC.md");

  it("carries no hard-coded release version", () => {
    // A standalone x.y.z — not an address fragment such as the `127.0.0` inside `127.0.0.1`.
    expect(buildSync).not.toMatch(/(?<![\d.])\d+\.\d+\.\d+(?![\d.])/u);
  });

  it("names package.json and extension/manifest.json as the version source", () => {
    expect(buildSync).toContain("`package.json`");
    expect(buildSync).toContain("`extension/manifest.json`");
    expect(buildSync).toMatch(/single source of truth/iu);
  });
});

describe("agent_convention_data_model_types (AC-K04)", () => {
  it.each(["CLAUDE.md", "AGENTS.md"])(
    "%s narrows the convention to public data-model types",
    (path) => {
      const convention = section(doc(path), "## Code-Konventionen");

      expect(convention).toMatch(
        /public\s+\*{0,2}data-model\*{0,2}\s+types\s+live\s+in\s+`src\/core\/model\.ts`/iu,
      );

      // The interfaces/options that really do stay outside model.ts are named as deliberate.
      for (const exception of ["adapter", "layer", "store"]) {
        expect(convention, `convention does not name the ${exception} exception`).toMatch(
          new RegExp(exception, "iu"),
        );
      }
      expect(convention).toMatch(/deliberate|bewusst/iu);
    },
  );
});

/* ------------------------------------------------------------------------------------------------
 * E — AC-E06: the federation guide tells the truth about the address check
 * ---------------------------------------------------------------------------------------------- */

describe("docs.federation_address_precheck (AC-E06)", () => {
  const federation = doc("docs/FEDERATION.md");

  it("names the check a pre-check, not pinning", () => {
    expect(federation).toContain("pre-check, not pinning");
  });

  it("keeps the re-resolution window visible", () => {
    expect(federation).toMatch(/re-resolution window/iu);
    expect(federation).toMatch(/two separate DNS resolutions/iu);
  });

  it("marks connection pinning as an open follow-up, not a mitigation", () => {
    expect(federation).toMatch(/connection pinning is explicitly \*\*not\*\* a 0\.12\.0 goal/iu);
    expect(federation).toMatch(/accepted residual risk/iu);
  });

  it("does not claim a DNS-rebinding gate", () => {
    expect(federation).not.toMatch(/DNS[-\s]rebinding\s+gate/iu);
  });
});

/* ------------------------------------------------------------------------------------------------
 * G — AC-G06: voice is gone from every user-facing doc that used to describe it
 * ---------------------------------------------------------------------------------------------- */

describe("docs.voice_is_gone (AC-G06)", () => {
  const featureDocs = [
    "README.md",
    "docs/EMBED.md",
    "docs/INTEGRATION.md",
    "docs/E2E-COVERAGE.md",
    "docs/ARCHITECTURE.md",
    "docs/BUILD-SYNC.md",
  ] as const;

  it.each(featureDocs)("%s no longer mentions the feature", (path) => {
    expect(doc(path)).not.toMatch(/\bvoice\b/iu);
  });

  it("records the removal in the changelog", () => {
    const changelog = doc("CHANGELOG.md");
    expect(changelog).toMatch(/^### Removed$/m);
    expect(changelog).toMatch(/Voice dictation is removed/iu);
  });
});

/* ------------------------------------------------------------------------------------------------
 * J — AC-J07: the container guide carries the widening, TLS and digest advice
 * ---------------------------------------------------------------------------------------------- */

describe("docs.container_guidance (AC-J07)", () => {
  const docker = doc("docs/DOCKER.md");

  it("keeps a widening section for the loopback default", () => {
    expect(docker).toMatch(/^## Widening, TLS and digest pinning/m);
    expect(docker).toContain("0.0.0.0:");
  });

  it("requires TLS in front of any non-local deployment", () => {
    expect(docker).toMatch(/TLS-terminating reverse proxy/iu);
    expect(docker).toMatch(/\b(Traefik|Caddy|nginx)\b/);
  });

  it("recommends digest pinning for production, not as the compose default", () => {
    expect(docker).toMatch(/Digest pinning is recommended for production, not the compose default/iu);
    expect(docker).toContain("@sha256:");
    expect(docker).toMatch(/keeps the version tag/iu);
  });
});
