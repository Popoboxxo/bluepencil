/**
 * The note-mutation unit of the review layer (CQ-03 split, spec §3.13 L).
 *
 * Everything the layer *writes* lives here: the guarded `mutate()` wrapper, the author resolution,
 * saving a composer draft, replying to a note, the two-step delete and the note lookup behind a
 * delegated click. This is the only unit that turns a UI gesture into a store call (FR-15.3: one
 * source of truth — the panel, the composer and presentation mode all write through it).
 *
 * The unit owns the composer's active target. Reads (store snapshots, panel/composer handles) come
 * in as callbacks, so the unit stays free of the layer's closures and testable on its own.
 */

import { captureContext } from "../core/capture";
import { resolveAnchor } from "../core/anchor";
import type { CapturedContext, MessageKind, Note } from "../core/model";
import { answerDecision } from "../core/protocol";
import type { Store } from "../core/store";
import type { Translate } from "../i18n";
import type { MessageKey } from "../i18n/en";
import type { Composer, ComposerSaveInput, ComposerSaveResult, ComposerTarget } from "./composer";
import type { LayerSettings, Panel } from "./panel";
import type { LayerUnit } from "./layer-unit";

/** Structural copy of the host identity option — importing `LayerOptions` would close a cycle. */
export type LayerNotesIdentity =
  | { getUser?: () => { id?: string; name: string } }
  | "prompt"
  | "anonymous";

export interface LayerNotesDeps {
  store: Store;
  t: Translate;
  /** Live settings (author, language) — read on every use, never captured. */
  settings: () => LayerSettings;
  panel: () => Panel | null;
  composer: () => Composer | null;
  /** Anchor hooks, forwarded verbatim (FR-2.4). */
  anchorHooks?: string[];
  /** Build reference stamped into the captured context. */
  buildRef?: string;
  view?: Window;
  identity?: LayerNotesIdentity;
  /** Live-region announcement (FR-11.2). */
  announce: (key: MessageKey) => void;
  /** Full render pass after a write (panel, markers, counters, presentation). */
  renderAll: () => void;
  onError: (error: unknown) => void;
}

export interface LayerNotesUnit extends LayerUnit {
  /** The composer's current target; set when the composer opens, cleared on teardown. */
  setTarget(target: ComposerTarget | null): void;
  target(): ComposerTarget | null;
  /** Validate and persist a composer draft (FR-2.3, FR-9.3). */
  save(input: ComposerSaveInput): Promise<ComposerSaveResult>;
  /** Answer a note; a pending decision is reopened through `core/protocol` (FR-5.5). */
  reply(note: Note, text: string): Promise<void>;
  /** Run a store mutation; failures are reported, never thrown into the page (NFR-14). */
  mutate(action: () => Promise<unknown>, note?: Note): Promise<void>;
  /** Host context for a design/bug capture; `null` when capture failed (FR-1.4/1.13). */
  capture(element: Element): CapturedContext | null;
  /** Two-step delete for a single note (FR-8.1). */
  confirmDelete(button: Element, note: Note | null): void;
  /** The note behind a clicked node (`data-bp-note-id`). */
  noteForNode(node: Element): Note | null;
}

export function createLayerNotes(deps: LayerNotesDeps): LayerNotesUnit {
  let activeTarget: ComposerTarget | null = null;

  const { store, t } = deps;

  function anchorOptions(): { hooks?: string[] } {
    return deps.anchorHooks ? { hooks: deps.anchorHooks } : {};
  }

  async function mutate(action: () => Promise<unknown>, note?: Note): Promise<void> {
    try {
      await action();
    } catch (error) {
      deps.onError(error);
      if (note) deps.panel()?.reportNoteError(note, "panel.error.action");
    }
  }

  function authorName(): string {
    const configured = deps.settings().author.trim();
    if (configured !== "") return configured;
    const identity = deps.identity;
    if (identity !== undefined && identity !== "prompt" && identity !== "anonymous") {
      try {
        const user = identity.getUser?.();
        if (user && typeof user.name === "string" && user.name.trim() !== "") return user.name.trim();
      } catch (error) {
        deps.onError(error);
      }
    }
    return "anonymous";
  }

  function capture(element: Element): CapturedContext | null {
    try {
      return captureContext(element, {
        ...(deps.buildRef !== undefined ? { buildRef: deps.buildRef } : {}),
        ...(deps.view ? { view: deps.view } : {}),
      });
    } catch (error) {
      deps.onError(error);
      return null;
    }
  }

  async function save(input: ComposerSaveInput): Promise<ComposerSaveResult> {
    const target = activeTarget;
    const element = target?.element ?? null;
    if (target === null || element === null) {
      return { ok: false, reasonKey: "composer.error.save" };
    }
    if (!element.isConnected) {
      return { ok: false, reasonKey: "composer.error.vanished" };
    }
    let resolved = true;
    try {
      resolved = resolveAnchor(target.anchor, anchorOptions()) !== null;
    } catch (error) {
      deps.onError(error);
      resolved = false;
    }
    if (!resolved) {
      return { ok: false, reasonKey: "composer.error.vanished" };
    }

    // Design semantics carry the captured state (a bug is captured that way too, FR-1.13); a text
    // quote deliberately carries none. `target.context` is what the capture mode resolved.
    const context =
      target.context ?? (input.type === "design" || input.type === "bug" ? capture(element) : null);
    try {
      await store.create({
        type: input.type,
        body: input.body,
        anchor: { ...target.anchor },
        intent: input.intent,
        // FR-3.6: only a bug carries a severity; `createNote` drops it for any other type.
        ...(input.severity !== undefined ? { severity: input.severity } : {}),
        // FR-3.7: only a feature carries a priority; `createNote` drops it for any other type.
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        author: authorName(),
        authorType: "human",
        source: "ui:human",
        context,
      });
    } catch (error) {
      deps.onError(error);
      return { ok: false, reasonKey: "composer.error.save" };
    }
    deps.announce("a11y.liveSaved");
    deps.renderAll();
    return { ok: true };
  }

  /**
   * Answer a note (FR-5.5). `src/core/protocol.ts` decides the vocabulary: an answer to a pending
   * decision is `kind=decision` and reopens the note; everything else is a human `kind=reply`.
   */
  async function reply(note: Note, text: string): Promise<void> {
    const body = text.trim();
    if (body === "") {
      deps.panel()?.reportNoteError(note, "panel.reply.empty");
      return;
    }
    const author = authorName();
    const answered = note.status === "needs_decision" ? answerDecision(note, { text: body, author }) : null;
    const lastMessage = answered?.messages[answered.messages.length - 1];
    const kind: MessageKind = lastMessage?.kind ?? "reply";
    try {
      await store.reply(note.id, { text: body, author, authorType: "human", kind });
      if (answered !== null && answered.status !== note.status) {
        await store.setStatus(note.id, answered.status);
      }
    } catch (error) {
      deps.onError(error);
      deps.panel()?.reportNoteError(note, "panel.reply.error");
      return;
    }
    deps.announce("a11y.liveSaved");
    deps.renderAll();
  }

  function confirmDelete(button: Element, note: Note | null): void {
    if (note === null) return;
    if (button.getAttribute("data-bp-confirm") !== "true") {
      button.setAttribute("data-bp-confirm", "true");
      button.setAttribute("data-bp-i18n", "panel.action.confirmDelete");
      button.textContent = t("panel.action.confirmDelete");
      return;
    }
    void mutate(() => store.remove(note.id), note);
  }

  function noteForNode(node: Element): Note | null {
    const holder = node.closest("[data-bp-note-id]") ?? node;
    const id = holder.getAttribute("data-bp-note-id");
    if (id === null || id === "") return null;
    return store.notes().find((note) => note.id === id) ?? null;
  }

  return {
    setTarget(target: ComposerTarget | null): void {
      activeTarget = target;
    },
    target(): ComposerTarget | null {
      return activeTarget;
    },
    save,
    reply,
    mutate,
    capture,
    confirmDelete,
    noteForNode,
    dispose(): void {
      // No listeners, timers or nodes of its own: the only state is the composer target.
      activeTarget = null;
    },
  };
}
