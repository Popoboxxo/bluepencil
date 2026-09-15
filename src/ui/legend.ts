/**
 * Shortcut legend overlay (FR-1.7, FR-1.6).
 *
 * A pure DOM builder: it owns no listeners and no timers — the layer routes clicks (backdrop,
 * close button) and `Esc` into `close()`, so teardown stays provable (FR-12.2, NFR-15).
 * Every label comes from `src/i18n` via `data-bp-i18n` markers; the content is re-rendered on
 * every `open()`, so a language switch is picked up without rebuilding the layer.
 */

import type { MessageKey } from "../i18n/en";
import { applyTranslations, type Translate } from "../i18n";

/**
 * One shortcut row. `keys` are *keyboard identifiers* (not copy) and therefore are not
 * translated — they read the same on a German keyboard.
 */
export interface LegendRow {
  readonly keys: readonly string[];
  readonly label: MessageKey;
}

export interface LegendGroup {
  readonly title: MessageKey;
  readonly rows: readonly LegendRow[];
}

/** All shortcuts the layer implements, grouped for the overlay (FR-1.7). */
export const LEGEND_GROUPS: readonly LegendGroup[] = Object.freeze([
  {
    title: "legend.group.capture",
    rows: [
      { keys: ["C"], label: "legend.key.text" },
      { keys: ["D"], label: "legend.key.design" },
    ],
  },
  {
    title: "legend.group.view",
    rows: [
      { keys: ["L"], label: "legend.key.panel" },
      { keys: ["F"], label: "legend.key.feedbackOnly" },
      { keys: ["B"], label: "legend.key.bar" },
      { keys: ["?"], label: "legend.key.legend" },
      { keys: ["Esc"], label: "legend.key.cancel" },
    ],
  },
  {
    title: "legend.group.navigate",
    rows: [
      { keys: ["J"], label: "legend.key.next" },
      { keys: ["K"], label: "legend.key.previous" },
      { keys: ["1…9"], label: "legend.key.jump" },
    ],
  },
  {
    title: "legend.group.edit",
    rows: [{ keys: ["Ctrl/⌘", "Enter"], label: "legend.key.save" }],
  },
]);

export interface LegendOptions {
  document: Document;
  t: Translate;
  /** Instance namespace for element ids (`bp-<instanceId>-legend`). */
  instanceId: string;
  /** Called after the overlay closed (used to return focus, FR-11.2). */
  onClose?: () => void;
}

export interface Legend {
  readonly element: HTMLElement;
  readonly backdrop: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
}

export function createLegend(options: LegendOptions): Legend {
  const doc = options.document;
  const backdrop = doc.createElement("div");
  backdrop.className = "bp-legend-backdrop";
  backdrop.setAttribute("data-bp-part", "legend-backdrop");
  backdrop.setAttribute("data-bp-action", "legend-backdrop");
  backdrop.setAttribute("data-bp-i18n-title", "legend.backdrop");
  backdrop.hidden = true;

  const element = doc.createElement("div");
  element.className = "bp-legend";
  element.id = `bp-${options.instanceId}-legend`;
  element.setAttribute("data-bp-part", "legend");
  element.setAttribute("data-bp-i18n-aria", "a11y.legendLabel");
  element.setAttribute("role", "dialog");
  element.setAttribute("aria-modal", "true");
  element.hidden = true;

  const header = doc.createElement("header");
  header.className = "bp-panel-header";

  const title = doc.createElement("h2");
  title.className = "bp-panel-title";
  title.setAttribute("data-bp-i18n", "legend.title");

  const closeButton = doc.createElement("button");
  closeButton.type = "button";
  closeButton.className = "bp-btn";
  closeButton.setAttribute("data-bp-action", "legend-close");
  closeButton.setAttribute("data-bp-i18n", "legend.close");

  header.append(title, closeButton);

  const body = doc.createElement("div");
  body.className = "bp-legend-body";
  body.setAttribute("data-bp-part", "legend-body");

  const note = doc.createElement("p");
  note.className = "bp-hint";
  note.setAttribute("data-bp-i18n", "legend.key.passthrough");

  element.append(header, body, note);

  /** Build the grouped shortcut rows from the static table above. */
  function render(): void {
    body.textContent = "";
    for (const group of LEGEND_GROUPS) {
      const groupElement = doc.createElement("section");
      groupElement.className = "bp-legend-group";
      groupElement.setAttribute("data-bp-part", "legend-group");

      const groupTitle = doc.createElement("span");
      groupTitle.className = "bp-legend-group-title";
      groupTitle.setAttribute("data-bp-i18n", group.title);

      groupElement.append(groupTitle);

      for (const row of group.rows) {
        const rowElement = doc.createElement("div");
        rowElement.className = "bp-legend-row";
        rowElement.setAttribute("data-bp-part", "legend-row");

        const label = doc.createElement("span");
        label.className = "bp-legend-label";
        label.setAttribute("data-bp-i18n", row.label);

        const keys = doc.createElement("span");
        keys.className = "bp-legend-keys";
        for (const key of row.keys) {
          const kbd = doc.createElement("kbd");
          kbd.className = "bp-kbd";
          kbd.textContent = key;
          keys.append(kbd);
        }

        rowElement.append(label, keys);
        groupElement.append(rowElement);
      }

      body.append(groupElement);
    }
    applyTranslations(element, options.t);
  }

  let open = false;

  return {
    element,
    backdrop,
    open(): void {
      render();
      open = true;
      backdrop.hidden = false;
      element.hidden = false;
      // Move focus into the dialog so `Esc` and Tab behave (FR-11.2).
      if (typeof closeButton.focus === "function") closeButton.focus({ preventScroll: true });
    },
    close(): void {
      if (!open) return;
      open = false;
      backdrop.hidden = true;
      element.hidden = true;
      options.onClose?.();
    },
    isOpen(): boolean {
      return open;
    },
  };
}
