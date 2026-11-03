/**
 * Unit tests for the extracted highlight/jump unit (CQ-03 split, spec §3.13 L; FR-4.7, FR-12.2).
 *
 * The unit is the layer's selection without the layer: it owns the overlay node, its
 * `animationend` listener and `selectedId`, and reads the panel and the resolution map through
 * callbacks. These tests pin that ownership — geometry comes from the host rect, the host node is
 * never written, and `dispose()` removes both the listener and the overlay.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Note } from "../../src/core/model";
import { createLayerJump, type LayerJumpUnit } from "../../src/ui/layer-jump";
import type { Panel } from "../../src/ui/panel";

interface Harness {
  unit: LayerJumpUnit;
  overlay: HTMLElement;
  renderMarkers: ReturnType<typeof vi.fn>;
  panelRender: ReturnType<typeof vi.fn>;
  panelOpen: ReturnType<typeof vi.fn>;
  revealed: Note[];
}

function makeNote(id: string, reveal = false): Note {
  return {
    id,
    type: "text",
    body: `body of ${id}`,
    status: "open",
    intent: "implement",
    author: "tester",
    authorType: "human",
    source: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [],
    anchor: reveal ? { quote: "q", reveal: { selector: "#trigger" } } : { quote: "q" },
  } as unknown as Note;
}

function makeHarness(notes: Note[]): Harness {
  const renderMarkers = vi.fn();
  const panelRender = vi.fn();
  const panelOpen = vi.fn();
  const revealed: Note[] = [];
  const panel = {
    render: panelRender,
    isOpen: () => false,
    open: panelOpen,
    visibleNotes: () => notes,
  } as unknown as Panel;
  const unit = createLayerJump({
    panel: () => panel,
    elementFor: (note) => document.querySelector(`[data-target="${note.id}"]`),
    onRevealed: (note) => revealed.push(note),
    visibleNotes: () => notes,
    renderMarkers,
    onError: () => undefined,
  });
  const overlay = unit.attach(document, "i1");
  document.body.append(overlay);
  return { unit, overlay, renderMarkers, panelRender, panelOpen, revealed };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("layer jump unit (FR-4.7)", () => {
  it("creates the highlight overlay as an own node (FR-1.8)", () => {
    const { overlay } = makeHarness([]);
    expect(overlay.className).toBe("bp-highlight");
    expect(overlay.id).toBe("bp-i1-highlight");
    expect(overlay.getAttribute("data-bp-part")).toBe("highlight");
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    expect(overlay.hidden).toBe(true);
  });

  it("selects the note, positions the overlay from the host rect and re-renders", () => {
    const note = makeNote("n1");
    const target = document.createElement("p");
    target.setAttribute("data-target", "n1");
    document.body.append(target);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      top: 10.4,
      left: 20.6,
      width: 100.2,
      height: 30.9,
      bottom: 41.3,
      right: 120.8,
      x: 20.6,
      y: 10.4,
      toJSON: () => ({}),
    } as DOMRect);
    const harness = makeHarness([note]);

    harness.unit.jumpTo(note, target);

    expect(harness.unit.selectedId()).toBe("n1");
    expect(harness.overlay.hidden).toBe(false);
    expect(harness.overlay.style.top).toBe("10px");
    expect(harness.overlay.style.left).toBe("21px");
    expect(harness.overlay.style.width).toBe("100px");
    expect(harness.overlay.style.height).toBe("31px");
    expect(harness.panelRender).toHaveBeenCalledTimes(1);
    expect(harness.renderMarkers).toHaveBeenCalledTimes(1);
    // The host node is never written to.
    expect(target.getAttribute("style")).toBeNull();
  });

  it("moves the selection through the visible list and opens the panel", () => {
    const notes = [makeNote("a"), makeNote("b")];
    const harness = makeHarness(notes);

    harness.unit.moveSelection(1);

    expect(harness.unit.selectedId()).toBe("a");
    expect(harness.panelOpen).toHaveBeenCalled();
    harness.unit.moveSelection(1);
    expect(harness.unit.selectedId()).toBe("b");
  });

  it("jumps to a digit index and ignores an out-of-range index", () => {
    const harness = makeHarness([makeNote("a"), makeNote("b")]);

    harness.unit.jumpToIndex(1);
    expect(harness.unit.selectedId()).toBe("b");
    harness.unit.jumpToIndex(9);
    expect(harness.unit.selectedId()).toBe("b");
  });

  it("clears the animation listener and the overlay on dispose() (FR-12.2)", () => {
    const harness = makeHarness([]);
    const removeSpy = vi.spyOn(harness.overlay, "removeEventListener");

    harness.unit.dispose();

    expect(removeSpy).toHaveBeenCalledWith("animationend", expect.any(Function));
    expect(harness.overlay.isConnected).toBe(false);
    expect(harness.unit.selectedId()).toBeNull();
    expect(harness.unit.element()).toBeNull();
    expect(() => harness.unit.dispose()).not.toThrow();
  });
});
