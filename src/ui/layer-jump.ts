/**
 * The highlight/jump unit of the review layer (CQ-03 split, spec §3.13 L; FR-4.7).
 *
 * It owns the selection (`selectedId`), the highlight overlay node and its `animationend`
 * listener — nothing of the host is ever written (FR-1.8). Jumping to a note may need a transient
 * container to be revealed (issue #20); the resolved element is handed back to the layer through
 * `onRevealed`, because the resolution map belongs to the composition root.
 *
 * The overlay node is created per `attach(doc)` and removed in `dispose()`.
 */

import { revealAnchor } from "../core/anchor";
import type { Note } from "../core/model";
import type { Panel } from "./panel";
import type { LayerUnit } from "./layer-unit";

export interface LayerJumpDeps {
  panel: () => Panel | null;
  /** Element the note resolves to right now (the layer's resolution map). */
  elementFor: (note: Note) => Element | null;
  /** Called when a reveal produced an element the layer should remember (issue #20). */
  onRevealed: (note: Note, element: Element) => void;
  /** Notes the panel currently shows, in list order (`j`/`k`, `1`–`9`). */
  visibleNotes: () => Note[];
  /** Re-renders the marker layer after the selection changed. */
  renderMarkers: () => void;
  anchorHooks?: string[];
  onError: (error: unknown) => void;
}

export interface LayerJumpUnit extends LayerUnit {
  /** The highlight overlay; append it to the layer root. `null` before `attach()`. */
  element(): HTMLElement | null;
  /** Creates the overlay for one `enable()` cycle and returns it for the root append. */
  attach(doc: Document, instanceId: string): HTMLElement;
  selectedId(): string | null;
  clearSelection(): void;
  jumpTo(note: Note, element: Element | null): void;
  moveSelection(delta: number): void;
  jumpToIndex(index: number): void;
}

export function createLayerJump(deps: LayerJumpDeps): LayerJumpUnit {
  let selectedId: string | null = null;
  let highlight: HTMLElement | null = null;
  let onAnimationEnd: (() => void) | null = null;

  function anchorOptions(): { hooks?: string[] } {
    return deps.anchorHooks ? { hooks: deps.anchorHooks } : {};
  }

  /** Highlight overlay instead of touching host styles — the host box stays untouched (FR-1.8). */
  function showHighlight(element: Element): void {
    if (!highlight || typeof element.getBoundingClientRect !== "function") return;
    const rect = element.getBoundingClientRect();
    highlight.hidden = true;
    highlight.style.top = `${Math.round(rect.top)}px`;
    highlight.style.left = `${Math.round(rect.left)}px`;
    highlight.style.width = `${Math.round(rect.width)}px`;
    highlight.style.height = `${Math.round(rect.height)}px`;
    highlight.hidden = false;
    // Restart the CSS animation without a timer (NFR-2): a synchronous reflow read is enough.
    highlight.style.animation = "none";
    void highlight.offsetWidth;
    highlight.style.animation = "";
  }

  function jumpTo(note: Note, element: Element | null): void {
    selectedId = note.id;
    if (element !== null) {
      try {
        const scroll = (element as { scrollIntoView?: (options?: ScrollIntoViewOptions) => void })
          .scrollIntoView;
        if (typeof scroll === "function") scroll.call(element, { block: "center", inline: "nearest" });
      } catch {
        // Scrolling is best effort; an unresolvable layout must not break the jump.
      }
      showHighlight(element);
    }
    deps.panel()?.render();
    deps.renderMarkers();

    if (element !== null || note.anchor.reveal === undefined) return;

    // Issue #20: the target may only exist inside a transient container (closed dialog/popover,
    // inactive tab). Activate the trigger the anchor was captured with and jump to whatever the
    // container then reveals — a note is never left unreachable while a way in is known.
    void revealAnchor(note.anchor, anchorOptions())
      .then((revealed) => {
        if (revealed === null) return;
        deps.onRevealed(note, revealed);
        jumpTo(note, revealed);
      })
      .catch((error: unknown) => {
        deps.onError(error);
      });
  }

  function moveSelection(delta: number): void {
    const list = deps.visibleNotes();
    if (list.length === 0) return;
    const current = selectedId === null ? -1 : list.findIndex((note) => note.id === selectedId);
    const nextIndex =
      current === -1
        ? delta > 0
          ? 0
          : list.length - 1
        : Math.min(Math.max(current + delta, 0), list.length - 1);
    const note = list[nextIndex];
    if (!note) return;
    if (!deps.panel()?.isOpen()) deps.panel()?.open();
    jumpTo(note, deps.elementFor(note));
  }

  function jumpToIndex(index: number): void {
    const note = deps.visibleNotes()[index];
    if (!note) return;
    if (!deps.panel()?.isOpen()) deps.panel()?.open();
    jumpTo(note, deps.elementFor(note));
  }

  return {
    element(): HTMLElement | null {
      return highlight;
    },

    attach(doc: Document, instanceId: string): HTMLElement {
      // Defensive: re-attaching without dispose must not leak the previous listener.
      if (highlight !== null && onAnimationEnd !== null) {
        highlight.removeEventListener("animationend", onAnimationEnd);
      }
      highlight = doc.createElement("div");
      highlight.className = "bp-highlight";
      highlight.id = `bp-${instanceId}-highlight`;
      highlight.setAttribute("data-bp-part", "highlight");
      highlight.setAttribute("aria-hidden", "true");
      highlight.hidden = true;
      // No timer for UI state (NFR-2): the highlight removes itself when its CSS animation ends.
      onAnimationEnd = () => {
        if (!highlight) return;
        highlight.hidden = true;
        highlight.removeAttribute("style");
      };
      highlight.addEventListener("animationend", onAnimationEnd);
      return highlight;
    },

    selectedId(): string | null {
      return selectedId;
    },

    clearSelection(): void {
      selectedId = null;
    },

    jumpTo,
    moveSelection,
    jumpToIndex,

    dispose(): void {
      if (highlight !== null && onAnimationEnd !== null) {
        highlight.removeEventListener("animationend", onAnimationEnd);
      }
      highlight?.remove();
      highlight = null;
      onAnimationEnd = null;
      selectedId = null;
    },
  };
}
