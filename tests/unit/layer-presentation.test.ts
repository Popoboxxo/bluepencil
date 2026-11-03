/**
 * Unit tests for the extracted presentation unit (CQ-03 split, spec §3.13 L; FR-20, FR-12.2).
 *
 * The unit is the layer's presentation wiring without the layer: it takes its notes, translator
 * and write callbacks as arguments and owns exactly one `PresentationHandle`. These tests pin the
 * seam the composition root relies on — `attach()` per enable cycle, no-op before attachment,
 * and a `dispose()` that really stops the clock's ticker.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Note } from "../../src/core/model";
import { createTranslator } from "../../src/i18n";
import { createLayerPresentation, type LayerPresentationUnit } from "../../src/ui/layer-presentation";

function makeUnit(notes: Note[] = []): {
  unit: LayerPresentationUnit;
  writes: { id: string; body: string }[];
  retimes: { id: string; at: number }[];
} {
  const writes: { id: string; body: string }[] = [];
  const retimes: { id: string; at: number }[] = [];
  const unit = createLayerPresentation({
    t: createTranslator("en").t,
    notes: () => notes,
    onWrite: (id, body) => writes.push({ id, body }),
    onRetime: (id, at) => retimes.push({ id, at }),
    onError: () => undefined,
  });
  return { unit, writes, retimes };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("layer presentation unit (FR-20)", () => {
  it("is inert before attach(): mode off, no-op calls, no audience", () => {
    const { unit } = makeUnit();
    expect(unit.mode()).toBe("off");
    expect(() => unit.toggle()).not.toThrow();
    expect(() => unit.toggleMode()).not.toThrow();
    expect(() => unit.toggleClock()).not.toThrow();
    expect(unit.mode()).toBe("off");
    expect(unit.openAudience()).toBe(false);
  });

  it("attaches, toggles read/edit and returns to off", () => {
    const { unit } = makeUnit();
    unit.attach(document);
    expect(unit.mode()).toBe("off");
    unit.toggle();
    expect(unit.mode()).toBe("read");
    unit.toggleMode();
    expect(unit.mode()).toBe("edit");
    unit.toggleMode();
    expect(unit.mode()).toBe("read");
    unit.toggle();
    expect(unit.mode()).toBe("off");
    unit.dispose();
  });

  it("dispose() stops the clock ticker and is idempotent (FR-12.2)", () => {
    vi.useFakeTimers();
    const { unit } = makeUnit();
    unit.attach(document);
    unit.toggle();
    unit.toggleClock();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unit.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(unit.mode()).toBe("off");
    // A second dispose must not throw and must not resurrect anything.
    expect(() => unit.dispose()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a second attach() replaces the previous surface instead of leaking it", () => {
    vi.useFakeTimers();
    const { unit } = makeUnit();
    unit.attach(document);
    unit.toggle();
    unit.toggleClock();
    unit.attach(document);
    expect(unit.mode()).toBe("off");
    expect(vi.getTimerCount()).toBe(0);
    unit.dispose();
  });
});
