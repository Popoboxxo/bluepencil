/**
 * The shared text helpers of the server half (CQ-02, AC-H05).
 *
 * `errorText`/`oneLine` were private copies in six server modules and in the federation client.
 * They now live in `src/core/text.ts` (the federation client cannot import from `server/`) and
 * `server/text.ts` re-exports them, so every `server/*.ts` still has one import site.
 *
 * This suite pins three things that a green typecheck cannot: the exact behaviour (including the
 * `String()` fallback for `null`/`undefined`, which deliberately differs from `src/mcp/tools.ts`),
 * the `BluepencilValidationError` path, and the fact that `server/text.ts` is a *pure re-export*
 * rather than a second implementation. The last one is a source assertion: a copy would compile
 * and pass every behavioural test above it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BluepencilValidationError } from "../../src/core/model";
import { errorText as coreErrorText, oneLine as coreOneLine } from "../../src/core/text";
import { errorText, oneLine } from "../../server/text";

const ROOT = process.cwd();

describe("errorText", () => {
  it("returns the message of an Error and of a thrown subclass", () => {
    expect(errorText(new Error("boom"))).toBe("boom");

    const validation = new BluepencilValidationError(["missing id", "bad status"]);
    expect(errorText(validation)).toBe(
      "bluepencil: 2 validation issue(s): missing id; bad status",
    );
  });

  it("stringifies a thrown non-Error value", () => {
    expect(errorText("a bare string")).toBe("a bare string");
    expect(errorText(42)).toBe("42");
    expect(errorText(false)).toBe("false");
    expect(errorText({ code: "x" })).toBe("[object Object]");
  });

  it("uses String() for null and undefined, not a fallback label", () => {
    // Different on purpose from `src/mcp/tools.ts` (`"unknown error"`): this helper reports
    // whatever was thrown; the MCP tool surface decides what a missing cause should read like.
    expect(errorText(null)).toBe("null");
    expect(errorText(undefined)).toBe("undefined");
  });
});

describe("oneLine", () => {
  it("collapses every whitespace run to one space and trims the ends", () => {
    expect(oneLine("  a \n\t b  \r\n c ")).toBe("a b c");
    expect(oneLine("already one line")).toBe("already one line");
  });

  it("maps an empty or whitespace-only value to the empty string", () => {
    expect(oneLine("")).toBe("");
    expect(oneLine(" \n\t ")).toBe("");
  });

  it("removes a newline that would split a header value or a log line", () => {
    expect(oneLine("missing header\nsecond line")).toBe("missing header second line");
  });
});

describe("server/text.ts — one implementation site", () => {
  it("re-exports the exact same functions as src/core/text.ts", () => {
    // Identity, not just equal behaviour: a wrapper would pass a `toBe`-on-output test.
    expect(errorText).toBe(coreErrorText);
    expect(oneLine).toBe(coreOneLine);
  });

  it("contains a pure re-export and no local implementation", () => {
    const source = readFileSync(join(ROOT, "server/text.ts"), "utf8");

    expect(source).toContain('export { errorText, oneLine } from "../src/core/text";');
    expect(source).not.toContain("function errorText");
    expect(source).not.toContain("function oneLine");
  });
});
