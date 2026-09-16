/**
 * Unit tests of the version contract (FR-19).
 *
 * The point is not "a string exists" — it is that every artifact reports the *same* one. Before this,
 * the library, the MCP server and the sidecar each carried their own literal, and the element build
 * reported nothing at all, so a host could not tell which bluepencil it was running.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BluepencilNotesElement } from "../../src/element/index";
import { VERSION } from "../../src/version";
import { SERVER_VERSION } from "../../server/handler";

/** Every `.ts` under the given directories, relative to the repository root. */
function sources(dirs: string[]): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.endsWith(".ts")) files.push(path);
    }
  };
  for (const dir of dirs) walk(dir);
  return files;
}

describe("version — one source for every artifact", () => {
  it("reports the version the build was stamped with", () => {
    // `"dev"` here: unit tests run against the sources, where esbuild substituted nothing. A build
    // reports the package version instead — asserted against the artifacts in the embed smoke.
    expect(VERSION).toBe("dev");
  });

  it("uses the same string in the sidecar and in the element build", () => {
    expect(SERVER_VERSION).toBe(VERSION);
    expect(BluepencilNotesElement.version).toBe(VERSION);
  });

  it("keeps no bare semantic version literal outside src/version.ts", () => {
    const offenders = sources(["src", "server"])
      .filter((path) => !path.endsWith(join("src", "version.ts")))
      // Comment lines carry examples (a manifest in `src/embed/version.ts`, doc snippets) — the rule
      // is about literals the code would actually report.
      .filter((path) =>
        readFileSync(path, "utf8")
          .split("\n")
          .some((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && /"\d+\.\d+\.\d+"/.test(line)),
      )
      .map((path) => path.replace(`${process.cwd()}/`, ""));
    expect(offenders).toEqual([]);
  });
});
