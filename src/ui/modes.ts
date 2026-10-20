/**
 * Capture presets — the single source of truth for the layer's capture modes (FR-1.3/1.4/1.13/1.14).
 *
 * A mode says what a click *means*; a preset maps that meaning onto two orthogonal facts:
 *  - `type`    the note category stored on the note (`text`, `design`, `bug`, `feature`);
 *  - `capture` which kind of payload the composer carries: a text quote, a captured design
 *              context, or (`hybrid`) whichever the clicked element actually affords.
 *
 * The layer, the panel, the keymap and the settings surface all read this table — adding a mode
 * means adding one row here, never a second capture branch somewhere else.
 */

import type { NoteType } from "../core/model";

/** The capture modes a host may offer, in bar/legend order. */
export const CAPTURE_MODES = ["text", "design", "bug", "feature"] as const;

/** One capture mode. */
export type CaptureMode = (typeof CAPTURE_MODES)[number];

/**
 * What the composer carries:
 *  - `text`   a selection quote and no captured state;
 *  - `design` the element's captured state and no quote;
 *  - `hybrid` quote when a text target exists, otherwise the captured state.
 */
export type CaptureSemantics = "text" | "design" | "hybrid";

export interface CapturePreset {
  readonly type: NoteType;
  readonly capture: CaptureSemantics;
}

/**
 * FR-1.13: a bug is always captured with design semantics, even on a text element — the report is
 * about the element's state, not about a wording.
 * FR-1.14: a feature is hybrid — wording when the click lands on text, design otherwise.
 */
export const CAPTURE_PRESETS: Readonly<Record<CaptureMode, CapturePreset>> = Object.freeze({
  text: { type: "text", capture: "text" },
  design: { type: "design", capture: "design" },
  bug: { type: "bug", capture: "design" },
  feature: { type: "feature", capture: "hybrid" },
});

/** Runtime guard for untrusted input (embed attributes, persisted settings). */
export function isCaptureMode(value: unknown): value is CaptureMode {
  return typeof value === "string" && (CAPTURE_MODES as readonly string[]).includes(value);
}
