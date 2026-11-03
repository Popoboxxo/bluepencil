/**
 * The presentation unit of the review layer (CQ-03 split, spec §3.13 L; FR-20).
 *
 * It owns the presentation surface created by `createPresentation` — the presenter panel, its
 * 250 ms ticker and its `BroadcastChannel` — and nothing else. The composition root supplies the
 * store snapshot, the translator and the write callbacks, so this unit never reaches into the
 * layer's closures.
 *
 * Lifecycle: `attach(doc)` builds the surface for one `enable()` cycle, `dispose()` destroys it
 * (FR-12.2: no timer or channel survives a teardown).
 */

import type { Note } from "../core/model";
import type { Translate } from "../i18n";
import { createPresentation, type PresentationHandle, type PresentMode } from "./present";
import type { LayerUnit } from "./layer-unit";

export interface LayerPresentationDeps {
  /** Translator used for the presentation surface's own labels (FR-11.1). */
  t: Translate;
  /** Live store snapshot — the same notes the review list shows (FR-15.3). */
  notes: () => Note[];
  /** A note body edited from the presenter panel. */
  onWrite: (id: string, body: string) => void;
  /** A cue retimed from the presenter panel. */
  onRetime: (id: string, at: number) => void;
  onError: (error: unknown) => void;
}

export interface LayerPresentationUnit extends LayerUnit {
  /** Builds the presentation surface for one `enable()` cycle. */
  attach(doc: Document): void;
  /** Current presentation mode; `off` before `attach()` and after `dispose()`. */
  mode(): PresentMode;
  /** Follows a store render pass (the presenter panel reads the same snapshot). */
  refresh(): void;
  toggle(): void;
  /** `edit` ⇄ `read`; a no-op before `attach()` (FR-20.4). */
  toggleMode(): void;
  /** Opens the audience tab (FR-20.6); `false` when no surface exists yet. */
  openAudience(): boolean;
  /** One key for both directions: the clock knows whether it is running (FR-20.5). */
  toggleClock(): void;
  reset(): void;
}

export function createLayerPresentation(deps: LayerPresentationDeps): LayerPresentationUnit {
  let handle: PresentationHandle | null = null;

  return {
    attach(doc: Document): void {
      // Defensive: a second attach without dispose must not leak the previous surface.
      handle?.destroy();
      handle = createPresentation(
        {
          notes: () => deps.notes(),
          routeOf: (note) => note.anchor.route,
          t: (key) => deps.t(key),
          onWrite: (id, body) => {
            deps.onWrite(id, body);
          },
          onRetime: (id, at) => {
            deps.onRetime(id, at);
          },
          onError: deps.onError,
        },
        doc,
      );
    },

    refresh(): void {
      // Optional chaining short-circuits the argument, so `notes()` is not called without a surface.
      handle?.refresh(deps.notes());
    },

    mode(): PresentMode {
      return handle?.mode ?? "off";
    },

    toggle(): void {
      handle?.toggle();
    },

    toggleMode(): void {
      if (handle === null) return;
      handle.setMode(handle.mode === "edit" ? "read" : "edit");
    },

    openAudience(): boolean {
      return handle?.openAudience() ?? false;
    },

    toggleClock(): void {
      if (handle === null) return;
      if (handle.elapsedRunning()) handle.pause();
      else handle.start();
    },

    reset(): void {
      handle?.reset();
    },

    dispose(): void {
      handle?.destroy();
      handle = null;
    },
  };
}
