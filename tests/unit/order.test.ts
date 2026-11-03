/**
 * Review order (FR-4.6) and the one code-unit comparator (BP-07, AC-A17).
 *
 * The canonical bundle order and the review reads sort different things — origin/route first vs
 * priority first — but they must agree on every primitive comparison. This suite pins the shared
 * primitives in `src/data/order.ts` and proves `canonical.ts` no longer carries a private copy.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createNote } from "../../src/core/model";
import type { Note, NoteIntent, NoteStatus } from "../../src/core/model";
import { compareCodeUnits, compareForReview, reviewPriority } from "../../src/data/order";

const T = "2026-09-14T18:20:00.000Z";

interface NoteInput {
  status?: NoteStatus;
  intent?: NoteIntent;
  now?: string;
}

function note(id: string, input: NoteInput = {}): Note {
  return createNote({
    id,
    type: "text",
    body: `body of ${id}`,
    anchor: { hook: `hook-${id}` },
    now: input.now ?? T,
    status: input.status,
    intent: input.intent,
  });
}

describe("compareCodeUnits (BP-07, AC-A17)", () => {
  it("compares by code unit, so uppercase sorts before lowercase", () => {
    expect(compareCodeUnits("B", "a")).toBeLessThan(0);
    expect(compareCodeUnits("a", "B")).toBeGreaterThan(0);
    expect(compareCodeUnits("2026-09-14T18:20:00.000Z", "2026-09-14T19:00:00.000Z")).toBeLessThan(0);
  });

  it("returns 0 only for the same string and never depends on the locale", () => {
    expect(compareCodeUnits("same", "same")).toBe(0);
    expect(compareCodeUnits("", "")).toBe(0);
    // Umlauts would sort differently under `localeCompare`; code units keep it binary.
    expect(compareCodeUnits("ä", "z")).toBeGreaterThan(0);
  });
});

describe("reviewPriority (FR-4.6)", () => {
  it("ranks needs_decision, feedback, open, done", () => {
    expect(
      [
        note("n-done", { status: "done" }),
        note("n-open", { status: "open" }),
        note("n-feedback", { intent: "feedback" }),
        note("n-decide", { status: "needs_decision" }),
      ].map(reviewPriority),
    ).toEqual([3, 2, 1, 0]);
  });
});

describe("compareForReview (FR-4.6)", () => {
  it("orders by priority, then createdAt, then id", () => {
    const decide = note("n-decide", { status: "needs_decision" });
    const done = note("n-done", { status: "done" });
    expect([done, decide].sort(compareForReview).map((entry) => entry.id)).toEqual([
      "n-decide",
      "n-done",
    ]);

    const early = note("n-z", { now: "2026-09-14T17:00:00.000Z" });
    const late = note("n-a", { now: T });
    expect([late, early].sort(compareForReview).map((entry) => entry.id)).toEqual(["n-z", "n-a"]);

    const first = note("n-a");
    const second = note("n-b");
    expect([second, first].sort(compareForReview).map((entry) => entry.id)).toEqual(["n-a", "n-b"]);
  });
});

describe("one comparator source (BP-07, AC-A17)", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const CANONICAL = readFileSync(join(ROOT, "src", "data", "canonical.ts"), "utf8");

  it("imports reviewPriority and compareCodeUnits from order.ts", () => {
    expect(CANONICAL).toContain('import { compareCodeUnits, reviewPriority } from "./order";');
  });

  it("no longer carries a local priority or string-comparator copy", () => {
    expect(CANONICAL).not.toMatch(/function\s+priorityOf\b/);
    expect(CANONICAL).not.toMatch(/function\s+compareStrings\b/);
    expect(CANONICAL).not.toMatch(/localeCompare/);
  });
});
