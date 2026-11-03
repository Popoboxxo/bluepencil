/**
 * @vitest-environment node — the CLI is bundled with esbuild and spawned as a child process.
 *
 * `bluepencil notes` prints the canonical form of the note set (BP-08, AC-A22): the output is
 * `serializeCanonical(set.notes)` — fixed key order, fixed indentation, always-emitted `origin` —
 * and no longer the `JSON.stringify` of the parsed document. The difference is observable: two
 * files that carry the same note set in a different key order print the same bytes.
 *
 * The bundle is built here, from source, into `.tmp/` — independent of `dist/` and of whether
 * `npm run build` ran first.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

import { serializeCanonical } from "../../src/data/canonical";
import { BUNDLE_KIND, SCHEMA_VERSION } from "../../src/core/model";

const ROOT = process.cwd();
const WORK = join(ROOT, ".tmp", "vitest-cli");
const OUT = join(WORK, "cli-canonical.js");
const ISO = "2026-09-15T08:00:00.000Z";

/** Bundles `src/cli/bin.ts` the way `scripts/build.mjs` does (node, ESM, node20). */
async function bundleCli(): Promise<void> {
  mkdirSync(WORK, { recursive: true });
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
}

beforeAll(async () => {
  await bundleCli();
}, 60_000);

/** One fully valid note that deliberately omits `origin` (it is emitted as `null`). */
function note(id: string, body: string): Record<string, unknown> {
  return {
    id,
    schemaVersion: SCHEMA_VERSION,
    createdAt: ISO,
    updatedAt: ISO,
    type: "text",
    intent: "implement",
    status: "open",
    body,
    author: "canonical-smoke",
    authorType: "human",
    anchor: { hook: `hook-${id}`, route: "/pricing" },
    context: null,
    messages: [],
    source: "ui:human",
    environment: "dev",
  };
}

function bundleText(notes: Array<Record<string, unknown>>, reverseKeys: boolean): string {
  const reorder = (value: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(value).reverse());
  const bundle: Record<string, unknown> = {
    kind: BUNDLE_KIND,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: ISO,
    exportedBy: "canonical-smoke",
    environment: "dev",
    app: { name: "canonical-smoke" },
    sessions: [],
    notes: (reverseKeys ? notes.map(reorder) : notes),
  };
  const ordered = reverseKeys ? reorder(bundle) : bundle;
  return `${JSON.stringify(ordered, null, reverseKeys ? 4 : 2)}\n`;
}

/** Writes a bundle and returns the path plus the notes exactly as the CLI parses them. */
function writeBundle(
  name: string,
  notes: Array<Record<string, unknown>>,
  reverseKeys: boolean,
): { path: string; notes: Array<Record<string, unknown>> } {
  const path = join(WORK, name);
  writeFileSync(path, bundleText(notes, reverseKeys), "utf8");
  return { path, notes };
}

function notes(path: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [OUT, "notes", path], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("AC-A22 — notes prints the canonical form", () => {
  it("prints serializeCanonical(set.notes) instead of JSON.stringify", () => {
    const fixture = writeBundle("notes-canonical.json", [note("n-002", "second"), note("n-001", "first")], false);
    const result = notes(fixture.path);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    // The contract: canonical serialisation of the parsed notes, byte for byte.
    expect(result.stdout).toBe(serializeCanonical(fixture.notes));
    // Canonical means fixed key order and an always-emitted `origin`; the raw input has neither.
    expect(result.stdout).toContain('"origin": null');
    expect(result.stdout).not.toBe(`${JSON.stringify(fixture.notes, null, 2)}\n`);
  });

  it("is byte-identical across two runs over differently ordered input", () => {
    const first = writeBundle("notes-order-a.json", [note("n-002", "second"), note("n-001", "first")], false);
    const second = writeBundle("notes-order-b.json", [note("n-002", "second"), note("n-001", "first")], true);

    const a = notes(first.path);
    const b = notes(second.path);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    // Two different files (key order, indentation) describing the same set print the same bytes.
    expect(readFileSync(first.path, "utf8")).not.toBe(readFileSync(second.path, "utf8"));
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).toBe(serializeCanonical(first.notes));
  });
});
