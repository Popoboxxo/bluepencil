import { describe, expect, it } from "vitest";

import { SHORTCUTS, legendGroups, normaliseKey, resolveKeymap } from "../../src/ui/keymap";

describe("keymap registry (FR-1.11)", () => {
  it("has one stable id, label and group per shortcut", () => {
    const ids = SHORTCUTS.map((shortcut) => shortcut.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const shortcut of SHORTCUTS) {
      expect(shortcut.label.startsWith("legend.key.")).toBe(true);
      expect(shortcut.group.startsWith("legend.group.")).toBe(true);
    }
  });

  it("binds every document-scoped key without a conflict", () => {
    const binding = resolveKeymap();
    expect(binding.issues).toEqual([]);
    const documentKeys = SHORTCUTS.filter(
      (shortcut) => shortcut.range === undefined && (shortcut.scope ?? "document") === "document",
    ).flatMap((shortcut) => shortcut.keys.map(normaliseKey));
    expect([...binding.binding.keys()].sort()).toEqual([...documentKeys].sort());
  });

  it("documents the range and the composer shortcut without binding them", () => {
    const binding = resolveKeymap();
    expect(binding.binding.has("1")).toBe(false);
    expect(binding.binding.has("Enter")).toBe(false);
    // …and both are still printed, so the help text cannot omit what exists (the 0–6 bug).
    const printed = legendGroups().flatMap((group) => group.rows.flatMap((row) => row.keys));
    expect(printed).toContain("1…9");
    expect(printed).toContain("Ctrl/⌘");
  });

  it("renders exactly one row per shortcut, in registry order", () => {
    const rows = legendGroups().flatMap((group) => group.rows);
    expect(rows.map((row) => row.label)).toEqual(SHORTCUTS.map((shortcut) => shortcut.label));
  });
});

describe("keymap overrides (FR-12.11)", () => {
  it("remaps a shortcut and the legend follows", () => {
    const binding = resolveKeymap({ bar: "g" });
    expect(binding.issues).toEqual([]);
    expect(binding.binding.get("g")?.id).toBe("bar");
    expect(binding.binding.has("b")).toBe(false);

    const view = legendGroups({ bar: "g" }).find((group) => group.title === "legend.group.view");
    expect(view?.rows.find((row) => row.label === "legend.key.bar")?.keys).toEqual(["G"]);
    // Neighbouring rows keep their keys: an override cannot shift the rest silently.
    expect(view?.rows.find((row) => row.label === "legend.key.panel")?.keys).toEqual(["L"]);
  });

  it("reports a conflict instead of letting the last registration win", () => {
    const binding = resolveKeymap({ bar: "l" });
    expect(binding.issues[0]).toContain('"bar" and "panel" both claim "l"');
    expect(binding.binding.get("l")?.id).toBe("panel");
  });

  it("reports unknown ids, unusable keys and keys outside the remappable set", () => {
    expect(resolveKeymap({ nope: "x" }).issues[0]).toContain('unknown shortcut "nope"');
    expect(resolveKeymap({ bar: "   " }).issues[0]).toContain('"bar" was given no usable key');
    expect(resolveKeymap({ jump: "0" }).issues[0]).toContain('"jump" is a key range');
    expect(resolveKeymap({ save: "s" }).issues[0]).toContain('"save" is composer-scoped');
    // A digit belongs to the 1…9 range: binding one would shadow chapters.
    expect(resolveKeymap({ bar: "5" }).issues[0]).toContain('"bar" claims "5"');
  });

  it("accepts several keys for one shortcut and normalises single characters", () => {
    const binding = resolveKeymap({ panel: ["l", "p"] });
    expect(binding.binding.get("l")?.id).toBe("panel");
    expect(binding.binding.get("p")?.id).toBe("panel");
    expect(resolveKeymap({ bar: "G" }).binding.get("g")?.id).toBe("bar");
    expect(normaliseKey("C")).toBe("c");
    expect(normaliseKey("Escape")).toBe("Escape");
  });
});
