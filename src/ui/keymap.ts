/**
 * The single source of truth for the layer's keyboard (FR-1.11, FR-12.11): the key handler dispatches
 * from it, the legend renders from it, `keymap` overrides map onto it — so a shortcut cannot exist in
 * the help text without existing in the handler, and a conflict is reported instead of silently won.
 */

import type { MessageKey } from "../i18n/en";

/** Stable identifiers — the names a host uses in `keymap` overrides. */
export type ShortcutId =
  | "mode.text"
  | "mode.design"
  | "panel"
  | "feedback-only"
  | "bar"
  | "chrome"
  | "legend"
  | "next"
  | "previous"
  | "jump"
  | "cancel"
  | "save";

/** Where a shortcut applies: `composer` shortcuts are only ever read inside the composer surface. */
export type ShortcutScope = "document" | "composer";

export interface Shortcut {
  readonly id: ShortcutId;
  /** `KeyboardEvent.key` identifiers (single characters lower-case) this shortcut listens for. */
  readonly keys: readonly string[];
  /** How the key is printed in the legend; defaults to the upper-cased key. */
  readonly display?: readonly string[];
  /** A numbered range (`1…9`) is a predicate, not one binding — `resolveKeymap` skips it. */
  readonly range?: { readonly min: number; readonly max: number };
  /** Defaults to `document`; composer shortcuts never enter the document binding. */
  readonly scope?: ShortcutScope;
  readonly label: MessageKey;
  readonly group: MessageKey;
}

/** Group headings, shared by every legend row so the overlay needs no table of its own. */
export const SHORTCUT_GROUPS = Object.freeze({
  capture: "legend.group.capture" as MessageKey,
  view: "legend.group.view" as MessageKey,
  navigate: "legend.group.navigate" as MessageKey,
  edit: "legend.group.edit" as MessageKey,
});

/** Order matters: the legend renders in this order, grouped by `group`. */
export const SHORTCUTS: readonly Shortcut[] = Object.freeze([
  {
    id: "mode.text",
    keys: ["c"],
    label: "legend.key.text",
    group: SHORTCUT_GROUPS.capture,
  },
  {
    id: "mode.design",
    keys: ["d"],
    label: "legend.key.design",
    group: SHORTCUT_GROUPS.capture,
  },
  {
    id: "panel",
    keys: ["l"],
    label: "legend.key.panel",
    group: SHORTCUT_GROUPS.view,
  },
  {
    id: "feedback-only",
    keys: ["f"],
    label: "legend.key.feedbackOnly",
    group: SHORTCUT_GROUPS.view,
  },
  {
    id: "bar",
    keys: ["b"],
    label: "legend.key.bar",
    group: SHORTCUT_GROUPS.view,
  },
  {
    id: "chrome",
    keys: ["h"],
    label: "legend.key.chrome",
    group: SHORTCUT_GROUPS.view,
  },
  {
    id: "legend",
    keys: ["?"],
    label: "legend.key.legend",
    group: SHORTCUT_GROUPS.view,
  },
  {
    id: "cancel",
    keys: ["Escape"],
    display: ["Esc"],
    label: "legend.key.cancel",
    group: SHORTCUT_GROUPS.view,
  },
  {
    id: "next",
    keys: ["j"],
    label: "legend.key.next",
    group: SHORTCUT_GROUPS.navigate,
  },
  {
    id: "previous",
    keys: ["k"],
    label: "legend.key.previous",
    group: SHORTCUT_GROUPS.navigate,
  },
  {
    id: "jump",
    keys: [],
    display: ["1…9"],
    range: { min: 1, max: 9 },
    label: "legend.key.jump",
    group: SHORTCUT_GROUPS.navigate,
  },
  {
    id: "save",
    keys: ["Enter"],
    display: ["Ctrl/⌘", "Enter"],
    // Only ever inside the composer, and only with the modifier held (FR-1.6) — so it is not part of
    // the document binding and cannot be remapped from markup (an override is reported, not ignored).
    scope: "composer",
    label: "legend.key.save",
    group: SHORTCUT_GROUPS.edit,
  },
]);

/** Overrides a host may pass: `{ bar: "g", panel: ["l", "p"] }`. */
export type KeymapOverrides = Readonly<Record<string, string | readonly string[]>>;

export interface KeymapResolution {
  /** Normalised key identifier → shortcut. */
  readonly binding: ReadonlyMap<string, Shortcut>;
  /** Human-readable conflicts and unknown ids; surfaced through `element.issues`. */
  readonly issues: string[];
}

/** `C` and `c` are the same key; `Escape` is reported as such and never lower-cased. */
export function normaliseKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

function asKeys(value: string | readonly string[] | undefined): readonly string[] | null {
  if (value === undefined) return null;
  const list = typeof value === "string" ? [value] : value;
  const cleaned = list.map((entry) => entry.trim()).filter((entry) => entry !== "");
  return cleaned.length === 0 ? null : cleaned;
}

/**
 * Applies overrides to the registry. A key claimed twice, an unknown shortcut id or an empty key is
 * reported — never silently resolved — so a host cannot lose a shortcut without noticing.
 */
export function resolveKeymap(overrides?: KeymapOverrides): KeymapResolution {
  const issues: string[] = [];
  const binding = new Map<string, Shortcut>();
  const known = new Set<string>(SHORTCUTS.map((shortcut) => shortcut.id));

  for (const id of Object.keys(overrides ?? {})) {
    if (!known.has(id)) issues.push(`keymap: unknown shortcut "${id}"`);
  }

  for (const shortcut of SHORTCUTS) {
    if (shortcut.range !== undefined) {
      // A range is handled as a predicate, and remapping it is not supported yet — say so.
      if (overrides?.[shortcut.id] !== undefined) {
        issues.push(`keymap: "${shortcut.id}" is a key range and cannot be remapped`);
      }
      continue;
    }
    if ((shortcut.scope ?? "document") === "composer") {
      if (overrides?.[shortcut.id] !== undefined) {
        issues.push(`keymap: "${shortcut.id}" is composer-scoped and cannot be remapped`);
      }
      continue;
    }
    const overridden = asKeys(overrides?.[shortcut.id]);
    if (overrides?.[shortcut.id] !== undefined && overridden === null) {
      issues.push(`keymap: "${shortcut.id}" was given no usable key`);
      continue;
    }
    for (const raw of overridden ?? shortcut.keys) {
      const key = normaliseKey(raw);
      const taken = binding.get(key);
      if (taken !== undefined) {
        issues.push(`keymap conflict: "${shortcut.id}" and "${taken.id}" both claim "${key}"`);
        continue;
      }
      // A range shortcut must not be shadowed by a single digit binding (e.g. `jump` is `1…9`).
      if (/^[0-9]$/.test(key) && shortcut.range === undefined) {
        issues.push(`keymap conflict: "${shortcut.id}" claims "${key}", which the 1…9 range uses`);
        continue;
      }
      binding.set(key, shortcut);
    }
  }
  return { binding, issues };
}

export interface LegendRow {
  readonly keys: readonly string[];
  readonly label: MessageKey;
}

export interface LegendGroup {
  readonly title: MessageKey;
  readonly rows: readonly LegendRow[];
}

/**
 * Derives the legend from the registry (FR-1.11). Overrides are applied, so a remapped key shows up
 * in the help text immediately — the legend can never describe a keymap the layer does not have.
 */
export function legendGroups(overrides?: KeymapOverrides): readonly LegendGroup[] {
  const groups: LegendGroup[] = [];
  for (const shortcut of SHORTCUTS) {
    const overridden = asKeys(overrides?.[shortcut.id]);
    const display =
      shortcut.display ??
      (overridden ?? shortcut.keys).map((key) =>
        key.length === 1 ? key.toUpperCase() : key,
      );
    const row: LegendRow = { keys: display, label: shortcut.label };
    const existing = groups.find((group) => group.title === shortcut.group);
    if (existing === undefined) {
      groups.push({ title: shortcut.group, rows: [row] });
    } else {
      groups[groups.length - 1] = { title: existing.title, rows: [...existing.rows, row] };
    }
  }
  return groups;
}
