/**
 * Non-null assertion retirement in the federation surface (CQ-07, AC-H06).
 *
 * `backend.ts` used `self!` fourteen times inside closures, where the narrowing from
 * `selfAvailable()` is lost; `net-policy.ts` asserted index accesses after a length check.
 * Both were correct at the time, but these are the two places where a silent `undefined` must
 * not be able to slip in after an unrelated edit: the self-write lock and the SSRF gate
 * (SEC-11). The narrowings now carry the proof instead of the `!`:
 *
 * - `backend.ts` narrows once (`const local = self` in `selfTarget`) and carries the source on
 *   the `self` write target, so every self write reads `target.source`.
 * - `net-policy.ts` widens length-checked arrays to fixed tuples (`toIpv4Quad`,
 *   `toIpv6Groups`), so `group[0]` is known-defined without an assertion.
 *
 * This suite is a source assertion on purpose: `typecheck` proves the code compiles today,
 * not that the escape hatch stays gone.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/**
 * A postfix non-null assertion (`value!`, `value!.prop`, `value![0]`, `values[0]!`) — not
 * `!==`/`!=` and not prefix `!` negation. The files keep operator spacing, so a word character
 * or a closing bracket/paren immediately before the bang is the reliable signal.
 */
const NON_NULL_ASSERTION = /[\w$)\]]!(?!=)/u;

/** Every line of `path` that still carries a non-null assertion, as `path:line: text`. */
function assertions(relativePath: string): string[] {
  return readFileSync(join(ROOT, relativePath), "utf8")
    .split("\n")
    .flatMap((line, index) =>
      NON_NULL_ASSERTION.test(line) ? [`${relativePath}:${index + 1}: ${line.trim()}`] : [],
    );
}

const BACKEND = "src/federation/backend.ts";
const NET_POLICY = "src/federation/net-policy.ts";

describe("type hatches — federation backend and net policy", () => {
  it("keeps the self write path free of non-null assertions", () => {
    expect(assertions(BACKEND)).toEqual([]);
  });

  it("keeps the SSRF address arithmetic free of non-null assertions", () => {
    expect(assertions(NET_POLICY)).toEqual([]);
  });

  it("narrows the local store once and carries it on the self target", () => {
    const source = readFileSync(join(ROOT, BACKEND), "utf8");

    // The guard's proof is captured, not re-asserted: `selfTarget()` narrows `self` once ...
    expect(source).toMatch(/const local = self;/u);
    // ... and the narrowed source travels with the target, so no `self!` closure is needed.
    expect(source).toContain("source: local");
    expect(source).toContain("source: SelfSource");
    expect(source).not.toMatch(/\bself!/u);
  });

  it("widens checked index arrays instead of asserting an index", () => {
    const source = readFileSync(join(ROOT, NET_POLICY), "utf8");

    expect(source).toContain("function toIpv4Quad(");
    expect(source).toContain("function toIpv6Groups(");
    // Explicit arity checks are the replacement for the index assertion — keep them.
    expect(source).toContain("octets.length !== 4");
    expect(source).toContain("groups.length !== 8");
  });
});
