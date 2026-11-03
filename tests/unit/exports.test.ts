/**
 * Export-surface hygiene (CQ-09, AC-H08).
 *
 * The audit found value exports that no module imports: `noUnusedLocals` does not flag an unused
 * `export`, so the surface grows silently and every such symbol reads like an API contract or a
 * test seam that nobody uses. The cleanup drops the `export` keyword where the value is still used
 * inside its own module (or deletes it outright when it has no reference at all), rather than
 * deleting helpers a module needs.
 *
 * Two groups stay exported on purpose:
 *
 * - `src/ui/present.ts` (`readCues`, `totalDuration`, `currentCue`) — the CQ-04 seam, imported by
 *   `tests/unit/present.test.ts`.
 * - Exports that belong to a different contract's symbol set: `src/federation/client.ts` (E owns the
 *   behaviour; H only touches the header constant and `errorText`/`oneLine`, spec §3.12) and
 *   `extension/src/page-relay.ts` (T-B16 owns the file in wave 10).
 *
 * This suite is a source assertion: `typecheck` proves the code compiles today, not that the dead
 * surface stays gone (re-adding `export` keeps every behavioural test green).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/** Roots whose export surface AC-H08 covers. */
const SURFACE_ROOTS = ["src", "server", "extension/src"];

/** Every `.ts` file under `roots`, relative to the repo root. */
function surfaceFiles(roots: readonly string[]): string[] {
  return roots.flatMap((root) => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts")) out.push(path);
      }
    };
    walk(root);
    return out;
  });
}

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

/** `true` when `symbol` is declared with an `export` keyword in `relativePath`. */
function isExported(relativePath: string, symbol: string): boolean {
  const declaration = new RegExp(
    `^export\\s+(?:declare\\s+)?(?:const|let|var|function|class|enum|type|interface)\\s+${symbol}\\b`,
    "mu",
  );
  return declaration.test(read(relativePath));
}

interface RetiredExport {
  readonly file: string;
  readonly symbol: string;
  /** `false` when the symbol was deleted outright instead of only un-exported. */
  readonly stillDefined: boolean;
}

/**
 * The CQ-09 list, minus the symbols spec §3.12 assigns to another contract. Each entry was
 * verified to have no importer under `src/`, `server/`, `extension/`, `tests/`, `examples/` or
 * `scripts/` before the `export` was dropped.
 */
const RETIRED: readonly RetiredExport[] = [
  { file: "server/mcp.ts", symbol: "HUB_VERSION", stillDefined: false },
  { file: "server/mcp.ts", symbol: "MCP_PROTOCOL_VERSION", stillDefined: false },
  { file: "server/journal.ts", symbol: "JOURNAL_AUTHOR_ENV", stillDefined: true },
  { file: "server/journal.ts", symbol: "JOURNAL_SUBJECT_ENV", stillDefined: true },
  { file: "server/journal.ts", symbol: "ACTOR_TRAILER", stillDefined: true },
  { file: "server/admin.ts", symbol: "readRegistry", stillDefined: true },
  { file: "server/credentials.ts", symbol: "hasSecretCredential", stillDefined: true },
  { file: "server/credentials.ts", symbol: "hasTokenCredential", stillDefined: true },
  { file: "src/mcp/protocol.ts", symbol: "PARSE_ERROR", stillDefined: true },
  { file: "src/mcp/protocol.ts", symbol: "INVALID_REQUEST", stillDefined: true },
  { file: "src/mcp/protocol.ts", symbol: "METHOD_NOT_FOUND", stillDefined: true },
  { file: "src/mcp/protocol.ts", symbol: "INVALID_PARAMS", stillDefined: true },
  { file: "src/mcp/tools.ts", symbol: "MERGE_MODES", stillDefined: true },
  { file: "src/mcp/tools.ts", symbol: "CONFLICT_POLICIES", stillDefined: true },
  { file: "src/mcp/tools.ts", symbol: "FORMATS", stillDefined: true },
  { file: "src/mcp/tools.ts", symbol: "AGENT_MESSAGE_KINDS", stillDefined: true },
  { file: "src/mcp/tools.ts", symbol: "toolDefinitionsForScope", stillDefined: true },
  { file: "src/i18n/index.ts", symbol: "LANGUAGES", stillDefined: true },
  { file: "src/i18n/index.ts", symbol: "DEFAULT_LANGUAGE", stillDefined: true },
  { file: "src/i18n/index.ts", symbol: "isMessageKey", stillDefined: true },
  { file: "src/i18n/index.ts", symbol: "interpolate", stillDefined: true },
  { file: "src/ui/keymap.ts", symbol: "SHORTCUT_GROUPS", stillDefined: true },
  { file: "src/ui/panel.ts", symbol: "DEFAULT_FILTERS", stillDefined: true },
  { file: "src/core/anchor.ts", symbol: "containerKind", stillDefined: true },
  { file: "src/embed/attributes.ts", symbol: "CORE_ATTRIBUTES", stillDefined: true },
  { file: "src/embed/version.ts", symbol: "ELEMENT_FILE", stillDefined: true },
];

describe("dead value exports — CQ-09", () => {
  for (const { file, symbol } of RETIRED) {
    it(`does not export ${symbol} from ${file}`, () => {
      expect(isExported(file, symbol)).toBe(false);
    });
  }

  it("keeps the internal helpers that were only un-exported", () => {
    for (const { file, symbol, stillDefined } of RETIRED) {
      if (!stillDefined) continue;
      // A definition without `export` proves the helper still exists for its own module.
      expect(read(file)).toMatch(new RegExp(`\\b${symbol}\\b`, "u"));
    }
  });

  it("deletes HUB_VERSION everywhere instead of only un-exporting it", () => {
    // The audit's one export with zero references — not even in its own file.
    for (const file of surfaceFiles(SURFACE_ROOTS)) {
      expect(read(file), file).not.toMatch(/\bHUB_VERSION\b/u);
    }
  });
});

describe("present.ts — the CQ-04 seam stays exported", () => {
  it("exports the three seam functions", () => {
    for (const symbol of ["readCues", "totalDuration", "currentCue"]) {
      expect(isExported("src/ui/present.ts", symbol), symbol).toBe(true);
    }
  });

  it("is imported by the presentation suite", () => {
    const suite = read("tests/unit/present.test.ts");
    for (const symbol of ["readCues", "totalDuration", "currentCue"]) {
      expect(suite, symbol).toMatch(new RegExp(`\\b${symbol}\\b`, "u"));
    }
  });
});
