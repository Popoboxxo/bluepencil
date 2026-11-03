/**
 * `exactOptionalPropertyTypes` — recording a decision, not a default (CQ-08, AC-H07).
 *
 * The flag was measured on the branch, not guessed: `tsc --noEmit --exactOptionalPropertyTypes`
 * reported 67 errors in the root project (34 files: 12 under `src/`/`server/`, 22 under
 * `tests/`) and 1 in the extension (`extension/src/sw.ts`). Almost every touched file
 * belongs to another wave of 0.12.0, so enabling the flag here would mean editing files outside
 * Welle 8's write-set or silencing the errors with casts — the opposite of what the audit asked
 * for. The flag therefore stays **off**, explicitly and with a one-line reason in
 * `tsconfig.json`; a silent default is the state this test exists to prevent.
 *
 * If the owners of those files later enable it, the first test branch becomes the active
 * contract: both configs on and both typechecks green.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/** The flag's value in raw JSONC, or `undefined` when the config does not state it. */
function setting(raw: string): boolean | undefined {
  const match = /"exactOptionalPropertyTypes"\s*:\s*(true|false)/u.exec(raw);
  return match === null ? undefined : match[1] === "true";
}

const rootConfig = readFileSync(join(ROOT, "tsconfig.json"), "utf8");
const extensionConfig = readFileSync(join(ROOT, "extension/tsconfig.json"), "utf8");

describe("exactOptionalPropertyTypes — explicit decision", () => {
  it("states the flag explicitly in the root config", () => {
    expect(setting(rootConfig)).not.toBeUndefined();
  });

  it("never leaves the root and the extension disagreeing", () => {
    // Enabling for one project but not the other would typecheck half the shipped code under a
    // different contract; unset is only acceptable while the root documents the off decision.
    if (setting(rootConfig) === true) {
      expect(setting(extensionConfig)).toBe(true);
      return;
    }
    expect(setting(extensionConfig)).not.toBe(true);
  });

  it("justifies the off state on exactly one comment line", () => {
    if (setting(rootConfig) !== false) {
      // The enabled branch owes a green typecheck, not a justification.
      return;
    }

    const reasons = rootConfig
      .split("\n")
      .filter((line) => /^\s*\/\//u.test(line) && line.includes("exactOptionalPropertyTypes"));

    expect(reasons).toHaveLength(1);
    // A reason names the measurement, not just the value.
    expect(reasons[0]).toMatch(/trial|error/iu);
  });
});
