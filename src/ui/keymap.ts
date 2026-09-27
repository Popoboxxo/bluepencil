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
  | "save"
  /* Presentation mode (FR-20.8) — all `Shift` combinations, so they cannot shadow a host key. */
  | "present.toggle"
  | "present.mode"
  | "present.audience"
  | "present.timer"
  | "present.reset"
  | "present.chapter.next"
  | "present.chapter.previous";

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
  /**
   * The shortcut only fires with `Shift` held (FR-20.8). This is how the presentation keys avoid
   * shadowing a host: an unshifted `p`/`e`/`r` stays the host's, `Shift`+`P` is ours. The modifier
   * is part of the registered identifier, so the conflict check below sees `Shift+P` and a plain
   * `p` as two different keys — the legend and the handler read the same registry either way.
   */
  readonly shift?: boolean;
  readonly label: MessageKey;
  readonly group: MessageKey;
}

/** Group headings, shared by every legend row so the overlay needs no table of its own. */
export const SHORTCUT_GROUPS = Object.freeze({
  capture: "legend.group.capture" as MessageKey,
  view: "legend.group.view" as MessageKey,
  navigate: "legend.group.navigate" as MessageKey,
  edit: "legend.group.edit" as MessageKey,
  present: "legend.group.present" as MessageKey,
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

  /* -- presentation mode (FR-20.8) -------------------------------------- */
  /* Every key below is a `Shift` combination. That is the whole collision strategy: an unshifted
   * letter or digit is a navigation key on every host page we know (`j`/`k` = next/previous,
   * `0`–`9` = jump to chapter, `s` = speaker notes, `t` = print), and those stay with the host.
   * `Shift`+letter is free there, so a presentation page keeps both keymaps at once. */
  {
    id: "present.toggle",
    shift: true,
    keys: ["P"],
    display: ["Shift", "P"],
    label: "legend.key.present.toggle",
    group: SHORTCUT_GROUPS.present,
  },
  {
    id: "present.mode",
    shift: true,
    keys: ["E"],
    display: ["Shift", "E"],
    label: "legend.key.present.mode",
    group: SHORTCUT_GROUPS.present,
  },
  {
    id: "present.audience",
    shift: true,
    keys: ["O"],
    display: ["Shift", "O"],
    label: "legend.key.present.audience",
    group: SHORTCUT_GROUPS.present,
  },
  {
    id: "present.timer",
    shift: true,
    keys: [" "],
    display: ["Shift", "Space"],
    label: "legend.key.present.timer",
    group: SHORTCUT_GROUPS.present,
  },
  {
    id: "present.reset",
    shift: true,
    keys: ["R"],
    display: ["Shift", "R"],
    label: "legend.key.present.reset",
    group: SHORTCUT_GROUPS.present,
  },
  {
    // Two real key entries rather than a `range`: the arrow keys are not a digit range, and a range
    // shortcut is documented as unremappable, which would take the choice away from a host.
    id: "present.chapter.next",
    shift: true,
    keys: ["ArrowRight"],
    display: ["Shift", "→"],
    label: "legend.key.present.chapter",
    group: SHORTCUT_GROUPS.present,
  },
  {
    id: "present.chapter.previous",
    shift: true,
    keys: ["ArrowLeft"],
    display: ["Shift", "←"],
    label: "legend.key.present.chapter",
    group: SHORTCUT_GROUPS.present,
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

/**
 * The identifier a key event is looked up under: `Shift` becomes part of the name, so a `Shift`ed
 * shortcut and its bare twin can live in the same registry without either shadowing the other.
 * `Shift`+`Space` arrives as `" "` from the browser, and is named `Space` here — the same word the
 * legend prints, so the table and the handler cannot drift apart (FR-1.11).
 *
 * Multi-character keys are canonicalised too: a browser (and jsdom) may report `"ARROWLEFT"`,
 * `"ArrowLeft"` or `"arrowleft"`, and the registry names them `"ArrowLeft"`. Without that step a
 * documented arrow shortcut is registered under one spelling and looked up under another, so the
 * key silently does nothing (FR-1.11: a key cannot work without being documented).
 */
export function keyIdentifier(rawKey: string, shiftKey: boolean): string {
  if (rawKey === " ") return shiftKey ? "Shift+Space" : "Space";
  if (rawKey.length === 1) {
    const bare = normaliseKey(rawKey);
    return shiftKey ? `Shift+${bare.toUpperCase()}` : bare;
  }
  // Some engines (and jsdom) report the whole arrow block uppercase — `ARROWLEFT` — while the
  // registry names it `ArrowLeft`. Only fold when the key really is all-caps, so the spec casing
  // of `ArrowLeft` and `Escape` stays untouched.
  const canonical = /^[A-Z]+$/.test(rawKey)
    ? rawKey.charAt(0) + rawKey.slice(1).toLowerCase()
    : rawKey;
  return shiftKey ? `Shift+${canonical}` : canonical;
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
      // FR-20.8: a `shift` shortcut registers under `Shift+<key>`, so it occupies a different slot
      // than the bare key. A host that binds plain `p` and we bind `Shift+P` are two entries, not
      // a conflict — that is the whole point of the modifier living in the identifier.
      // One function builds the identifier on both sides — registering and looking up have to agree
      // by construction, or a documented key is registered under one name and pressed under another.
      const key = keyIdentifier(raw, shortcut.shift === true);
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
