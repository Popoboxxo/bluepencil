/**
 * Notes list panel, filters, thread view and settings surface (FR-4.2–4.8, FR-5.3/5.5, FR-8.1,
 * FR-9.3, FR-11.1/11.2).
 *
 * Design rules:
 *  - the panel is a **pure DOM builder**: it owns no store and no listeners. The layer routes its
 *    delegated clicks/changes and executes the resulting `PanelActions` against the store, which
 *    keeps the UI/store boundary of ARCHITECTURE §4 intact and teardown provable (FR-12.2);
 *  - everything is rendered with `textContent`/`setAttribute` — never `innerHTML` (FR-9.3);
 *  - ordering is delegated to `sortForReview` from `src/core/protocol.ts` (FR-4.6) and the
 *    protocol helpers decide the kind/status of a reply (§5.5);
 *  - done notes are hidden by default, in the list *and* in the markers, with a one-click reveal
 *    and the settings surface (FR-4.3/4.4/4.5).
 */

import type {
  AuthorType,
  MessageKind,
  Note,
  NoteIntent,
  NoteStatus,
  NoteType,
} from "../core/model";
import { sortForReview } from "../core/protocol";
import { applyTranslations, type Translate } from "../i18n";
import type { MessageKey } from "../i18n/en";

/* -------------------------------------------------------------------------- */
/* vocabulary mapping (no literals in the markup)                              */
/* -------------------------------------------------------------------------- */

const TYPE_KEYS: Record<NoteType, MessageKey> = {
  text: "panel.type.text",
  design: "panel.type.design",
};

const INTENT_KEYS: Record<NoteIntent, MessageKey> = {
  implement: "panel.intent.implement",
  feedback: "panel.intent.feedback",
};

const STATUS_KEYS: Record<NoteStatus, MessageKey> = {
  open: "panel.status.open",
  needs_decision: "panel.status.needs_decision",
  done: "panel.status.done",
};

const AUTHOR_TYPE_KEYS: Record<AuthorType, MessageKey> = {
  human: "panel.author.human",
  agent: "panel.author.agent",
};

const MESSAGE_KIND_KEYS: Record<MessageKind, MessageKey> = {
  note: "panel.message.note",
  decision_request: "panel.message.decision_request",
  decision: "panel.message.decision",
  feedback: "panel.message.feedback",
  reply: "panel.message.reply",
};

/** Statuses offered by the filter (FR-4.2); `done` implies revealing done notes. */
const STATUS_FILTER_VALUES: readonly (NoteStatus | "all")[] = ["all", "open", "needs_decision", "done"];
const TYPE_FILTER_VALUES: readonly (NoteType | "all")[] = ["all", "text", "design"];
const INTENT_FILTER_VALUES: readonly (NoteIntent | "all")[] = ["all", "implement", "feedback"];

export interface PanelFilters {
  type: NoteType | "all";
  intent: NoteIntent | "all";
  status: NoteStatus | "all";
}

export const DEFAULT_FILTERS: PanelFilters = { type: "all", intent: "all", status: "all" };

/* -------------------------------------------------------------------------- */
/* counters (FR-4.3, FR-4.8)                                                   */
/* -------------------------------------------------------------------------- */

export interface NoteCounters {
  /**
   * Visible work — `done` notes are excluded from `total`, `open`, `decisions` **and** `feedback`,
   * exactly as the list hides them (FR-4.3, FR-4.8).
   */
  total: number;
  open: number;
  decisions: number;
  feedback: number;
}

export function noteCounters(notes: readonly Note[]): NoteCounters {
  let total = 0;
  let open = 0;
  let decisions = 0;
  let feedback = 0;
  for (const note of notes) {
    if (note.status === "done") continue;
    total += 1;
    if (note.status === "open") open += 1;
    if (note.status === "needs_decision") decisions += 1;
    if (note.intent === "feedback") feedback += 1;
  }
  return { total, open, decisions, feedback };
}

/* -------------------------------------------------------------------------- */
/* contracts                                                                   */
/* -------------------------------------------------------------------------- */

/** Everything the panel may ask the layer to do — the layer owns the store (ARCHITECTURE §4). */
export interface PanelActions {
  /** `kind`/status of a reply is decided by the layer through `src/core/protocol.ts` (FR-5.5). */
  reply(note: Note, text: string): void;
  setIntent(note: Note, intent: NoteIntent): void;
  setStatus(note: Note, status: NoteStatus): void;
  remove(note: Note): void;
  /** Scroll to the element and highlight it, or report that jumping is impossible (FR-4.7). */
  jump(note: Note, element: Element | null): void;
  export(format: "markdown" | "json"): void;
  setShowDone(value: boolean): void;
}

export interface PanelOptions {
  document: Document;
  t: Translate;
  instanceId: string;
  /** Synchronous store snapshot (`store.notes()`). */
  notes: () => readonly Note[];
  /** Anchor resolution of the layer (`resolveAnchor`), `null` when the note is orphaned. */
  resolve: (note: Note) => Element | null;
  showDone: () => boolean;
  selectedId: () => string | null;
  actions: PanelActions;
  onError?: (err: unknown) => void;
  /**
   * Degradation known to the layer for one note (`resolveAnchorDetailed(...).degraded`), because
   * resolution no longer writes into `note.anchor`. Falls back to the stored `anchor.degraded`.
   */
  degraded?: (note: Note) => boolean;
}

export interface Panel {
  readonly element: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Re-render list, filters and status line from the current store snapshot. */
  render(): void;
  /** Notes the list currently shows (sorted, done-filtered) — used by `J`/`K` and digits. */
  visibleNotes(): Note[];
  filters(): PanelFilters;
  setFilter(name: keyof PanelFilters, value: string): void;
  resetFilters(): void;
  /** Current text of a note's reply box ("" when the entry is not rendered). */
  replyValue(note: Note): string;
  /** Show or clear an inline message on one entry (e.g. an empty reply, a failed write). */
  reportNoteError(note: Note, key?: MessageKey): void;
  /**
   * Show or clear a translated inline message of the panel itself (a failed export, a failed
   * action) — the visible half of NFR-14, next to `onError`.
   */
  reportMessage(key?: MessageKey): void;
}

/* -------------------------------------------------------------------------- */
/* rendering helpers                                                           */
/* -------------------------------------------------------------------------- */

/** Element factory — the panel never builds markup from strings (FR-9.3, NFR-6). */
function createEl<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className !== undefined) node.className = className;
  return node;
}

function textNode(doc: Document, tag: keyof HTMLElementTagNameMap, className: string, key: MessageKey): HTMLElement {
  const node = createEl(doc, tag, className);
  node.setAttribute("data-bp-i18n", key);
  return node;
}

function buttonNode(doc: Document, className: string, key: MessageKey, action: string): HTMLButtonElement {
  const node = textNode(doc, "button", className, key) as HTMLButtonElement;
  node.setAttribute("type", "button");
  node.setAttribute("data-bp-action", action);
  return node;
}

function filterOptionKey(name: keyof PanelFilters, value: string): MessageKey {
  if (value === "all") return "panel.filter.all";
  if (name === "type") return TYPE_KEYS[value as NoteType];
  if (name === "intent") return INTENT_KEYS[value as NoteIntent];
  return STATUS_KEYS[value as NoteStatus];
}

function filterValues(name: keyof PanelFilters): readonly string[] {
  if (name === "type") return TYPE_FILTER_VALUES;
  if (name === "intent") return INTENT_FILTER_VALUES;
  return STATUS_FILTER_VALUES;
}

function filterLabelKey(name: keyof PanelFilters): MessageKey {
  if (name === "type") return "panel.filter.type";
  if (name === "intent") return "panel.filter.intent";
  return "panel.filter.status";
}

/* -------------------------------------------------------------------------- */
/* the panel                                                                   */
/* -------------------------------------------------------------------------- */

export function createPanel(options: PanelOptions): Panel {
  const doc = options.document;
  const instanceId = options.instanceId;

  const element = createEl(doc, "section", "bp-panel");
  element.id = `bp-${instanceId}-panel`;
  element.setAttribute("data-bp-part", "panel");
  element.setAttribute("data-bp-i18n-aria", "a11y.panelLabel");
  element.hidden = true;

  /* -- header: title, reveal-done, export, close --------------------------- */

  const header = createEl(doc, "header", "bp-panel-header");
  const title = textNode(doc, "h2", "bp-panel-title", "panel.title");
  const doneToggle = buttonNode(doc, "bp-btn", "panel.showDone", "show-done");
  const exportMarkdown = buttonNode(doc, "bp-btn", "panel.action.exportMarkdown", "export-markdown");
  const exportJson = buttonNode(doc, "bp-btn", "panel.action.exportJson", "export-json");
  const closeButton = buttonNode(doc, "bp-btn", "panel.close", "panel-close");
  header.append(title, doneToggle, exportMarkdown, exportJson, closeButton);

  /* -- filters (FR-4.2) --------------------------------------------------- */

  const filtersRow = createEl(doc, "div", "bp-filters");
  filtersRow.setAttribute("data-bp-part", "filters");

  const selects: Record<keyof PanelFilters, HTMLSelectElement> = {
    type: createEl(doc, "select", "bp-select"),
    intent: createEl(doc, "select", "bp-select"),
    status: createEl(doc, "select", "bp-select"),
  };

  for (const name of ["type", "intent", "status"] as const) {
    const select = selects[name];
    select.setAttribute("data-bp-filter", name);
    select.setAttribute("data-bp-i18n-aria", filterLabelKey(name));
    for (const value of filterValues(name)) {
      const option = createEl(doc, "option");
      option.value = value;
      option.setAttribute("data-bp-i18n", filterOptionKey(name, value));
      select.append(option);
    }
    // The label text lives in its own span: a translated node must never own children
    // (`applyTranslations` writes `textContent`, which would wipe an appended control).
    const label = createEl(doc, "label", "bp-field");
    label.append(textNode(doc, "span", "bp-hint", filterLabelKey(name)), select);
    filtersRow.append(label);
  }

  /* -- list and status line ------------------------------------------------ */

  const body = createEl(doc, "div", "bp-panel-body");
  body.setAttribute("data-bp-part", "notes");

  const statusLine = createEl(doc, "p", "bp-hint");
  statusLine.setAttribute("data-bp-part", "panel-status");

  /** Inline feedback of the panel itself (a failed export/action) — never markup (FR-9.3). */
  const messageLine = createEl(doc, "p", "bp-error");
  messageLine.setAttribute("data-bp-part", "panel-message");
  messageLine.setAttribute("role", "alert");
  messageLine.hidden = true;

  element.append(header, filtersRow, body, statusLine, messageLine);

  let openState = false;
  const filters: PanelFilters = { ...DEFAULT_FILTERS };

  /* -- list rendering (FR-4.2–4.8) ---------------------------------------- */

  /** Filter + review order (`needs_decision` -> feedback -> rest, FR-4.6). */
  function visibleNotes(): Note[] {
    const showDoneValue = options.showDone();
    const selected = options.notes().filter((note) => {
      if (note.status === "done" && !showDoneValue && filters.status !== "done") return false;
      if (filters.status !== "all" && note.status !== filters.status) return false;
      if (filters.type !== "all" && note.type !== filters.type) return false;
      if (filters.intent !== "all" && note.intent !== filters.intent) return false;
      return true;
    });
    return sortForReview(selected);
  }

  function metaLine(note: Note): string {
    const parts = [
      `${options.t("panel.author")}: ${note.author}`,
      `${options.t("panel.created")}: ${note.createdAt}`,
      `${options.t("panel.source")}: ${note.source}`,
    ];
    if (note.anchor.route !== undefined && note.anchor.route !== "") {
      parts.push(`${options.t("panel.route")}: ${note.anchor.route}`);
    }
    return parts.join(" · ");
  }

  function renderThread(note: Note, container: HTMLElement): void {
    const thread = createEl(doc, "div", "bp-thread");
    thread.setAttribute("data-bp-part", "thread");
    thread.setAttribute("role", "group");
    thread.setAttribute("data-bp-i18n-aria", "panel.thread");

    if (note.messages.length === 0) {
      const empty = textNode(doc, "p", "bp-hint", "panel.thread.empty");
      empty.setAttribute("data-bp-part", "thread-empty");
      thread.append(empty);
    }

    for (const message of note.messages) {
      const entry = createEl(doc, "div", "bp-message");
      entry.setAttribute("data-bp-part", "message");
      entry.setAttribute("data-bp-kind", message.kind);

      const head = createEl(doc, "div", "bp-message-head");
      head.textContent = [
        message.author,
        options.t(AUTHOR_TYPE_KEYS[message.authorType]),
        options.t(MESSAGE_KIND_KEYS[message.kind]),
        message.ts,
      ].join(" · ");

      const text = createEl(doc, "div", "bp-message-text");
      text.textContent = message.text;

      entry.append(head, text);
      thread.append(entry);
    }

    const decision = note.status === "needs_decision";
    const replyRow = createEl(doc, "div", "bp-reply");
    const replyInput = createEl(doc, "textarea", "bp-textarea");
    replyInput.setAttribute("data-bp-part", "reply-input");
    replyInput.setAttribute("data-bp-i18n-placeholder", "panel.reply.placeholder");
    replyInput.setAttribute("data-bp-i18n-aria", "panel.reply.placeholder");
    replyInput.rows = 2;
    const replyButton = buttonNode(
      doc,
      "bp-btn",
      decision ? "panel.reply.answerDecision" : "panel.reply.send",
      "reply",
    );
    replyRow.append(replyInput, replyButton);
    thread.append(replyRow);

    if (decision) {
      const hint = textNode(doc, "p", "bp-hint", "panel.reply.decisionHint");
      hint.setAttribute("data-bp-part", "reply-hint");
      thread.append(hint);
    }

    const error = createEl(doc, "p", "bp-error");
    error.setAttribute("data-bp-part", "reply-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    thread.append(error);

    container.append(thread);
  }

  function renderNote(note: Note, index: number): HTMLElement {
    const entry = createEl(doc, "article", "bp-note");
    entry.setAttribute("data-bp-part", "note");
    entry.setAttribute("data-bp-note-id", note.id);
    entry.setAttribute("data-bp-status", note.status);
    entry.setAttribute("data-bp-intent", note.intent);
    entry.setAttribute("data-bp-type", note.type);

    const elementForNote = options.resolve(note);
    const orphaned = elementForNote === null;
    if (orphaned) entry.classList.add("is-orphaned");
    if (options.selectedId() === note.id) entry.classList.add("is-selected");

    /* -- jump header: badges, body, meta (FR-4.7) -------------------------- */

    const jump = createEl(doc, "button", "bp-note-jump");
    jump.setAttribute("type", "button");
    jump.setAttribute("data-bp-action", "jump");
    jump.setAttribute("data-bp-i18n-title", "panel.jump");
    if (orphaned) jump.setAttribute("disabled", "disabled");

    const head = createEl(doc, "div", "bp-note-head");
    const statusBadge = createEl(doc, "span", "bp-badge");
    statusBadge.setAttribute("data-bp-part", "badge-status");
    statusBadge.setAttribute("data-bp-i18n", STATUS_KEYS[note.status]);
    if (note.status === "needs_decision") statusBadge.classList.add("bp-badge--decision");
    if (note.status === "done") statusBadge.classList.add("bp-badge--done");

    const typeBadge = createEl(doc, "span", "bp-badge");
    typeBadge.setAttribute("data-bp-i18n", TYPE_KEYS[note.type]);

    head.append(statusBadge, typeBadge);

    if (note.intent === "feedback") {
      const intentBadge = createEl(doc, "span", "bp-badge bp-badge--feedback");
      intentBadge.setAttribute("data-bp-i18n", INTENT_KEYS[note.intent]);
      head.append(intentBadge);
    }
    if (orphaned) {
      const orphanBadge = createEl(doc, "span", "bp-badge bp-badge--orphaned");
      orphanBadge.setAttribute("data-bp-part", "badge-orphaned");
      orphanBadge.setAttribute("data-bp-i18n", "panel.orphaned");
      head.append(orphanBadge);
    }
    if (options.degraded ? options.degraded(note) : note.anchor.degraded !== undefined) {
      const degradedBadge = createEl(doc, "span", "bp-badge bp-badge--degraded");
      degradedBadge.setAttribute("data-bp-i18n", "panel.degraded");
      head.append(degradedBadge);
    }

    const position = createEl(doc, "span", "bp-note-meta");
    position.setAttribute("data-bp-part", "position");
    position.textContent =
      `#${index + 1}` +
      (options.selectedId() === note.id ? ` · ${options.t("a11y.selected")}` : "");
    head.append(position);

    const noteBody = createEl(doc, "span", "bp-note-body");
    noteBody.setAttribute("data-bp-part", "note-body");
    noteBody.textContent = note.body;

    const meta = createEl(doc, "span", "bp-note-meta");
    meta.setAttribute("data-bp-part", "note-meta");
    meta.textContent = metaLine(note);

    jump.append(head, noteBody, meta);
    entry.append(jump);

    if (orphaned) {
      const hint = textNode(doc, "p", "bp-hint", "panel.orphanedHint");
      hint.setAttribute("data-bp-part", "orphan-hint");
      entry.append(hint);
    }

    /* -- actions: intent switch, status, delete (FR-5.3, FR-8.1) ----------- */

    const actions = createEl(doc, "div", "bp-note-actions");
    const intentSwitch = buttonNode(doc, "bp-btn", "panel.action.switchIntent", "toggle-intent");
    actions.append(intentSwitch);

    if (note.status === "open" && note.intent === "implement") {
      actions.append(buttonNode(doc, "bp-btn", "panel.action.markDone", "mark-done"));
    } else if (note.status === "done") {
      actions.append(buttonNode(doc, "bp-btn", "panel.action.reopen", "reopen"));
    }

    const remove = buttonNode(doc, "bp-btn bp-btn--danger", "panel.action.delete", "delete");
    remove.setAttribute("data-bp-confirm", "false");
    actions.append(remove);
    entry.append(actions);

    renderThread(note, entry);
    return entry;
  }

  /** Re-render list, filters and status line from the current store snapshot. */
  function render(): void {
    const showDoneValue = options.showDone();

    selects.type.value = filters.type;
    selects.intent.value = filters.intent;
    selects.status.value = filters.status;
    doneToggle.setAttribute("data-bp-i18n", showDoneValue ? "panel.hideDone" : "panel.showDone");
    doneToggle.setAttribute("aria-pressed", showDoneValue ? "true" : "false");
    doneToggle.classList.toggle("is-active", showDoneValue);

    const notes = visibleNotes();
    body.textContent = "";
    if (options.notes().length === 0) {
      const empty = textNode(doc, "p", "bp-hint", "panel.empty");
      empty.setAttribute("data-bp-part", "panel-empty");
      body.append(empty);
    } else {
      notes.forEach((note, index) => {
        body.append(renderNote(note, index));
      });
    }

    const status = [`${options.t("panel.visible", { count: notes.length })}`];
    if (!showDoneValue) status.push(options.t("panel.doneHidden"));
    statusLine.textContent = status.join(" · ");

    applyTranslations(element, options.t);
    // Re-apply an inline message so a language switch translates it with everything else.
    reportMessage(messageKey);
  }

  function open(): void {
    openState = true;
    element.hidden = false;
    render();
  }

  function close(): void {
    openState = false;
    element.hidden = true;
    reportMessage(undefined);
  }

  /** Inline message of the panel; `undefined` clears it (a closed panel shows nothing). */
  function reportMessage(key?: MessageKey): void {
    messageKey = key;
    if (key === undefined) {
      messageLine.textContent = "";
      messageLine.hidden = true;
      return;
    }
    messageLine.textContent = options.t(key);
    messageLine.hidden = false;
  }

  let messageKey: MessageKey | undefined;

  return {
    element,
    open,
    close,
    toggle(): void {
      if (openState) {
        close();
      } else {
        open();
      }
    },
    isOpen: () => openState,
    render,
    visibleNotes,
    filters: () => ({ ...filters }),
    setFilter(name: keyof PanelFilters, value: string): void {
      if (name === "type") filters.type = value as PanelFilters["type"];
      else if (name === "intent") filters.intent = value as PanelFilters["intent"];
      else if (name === "status") filters.status = value as PanelFilters["status"];
      render();
    },
    resetFilters(): void {
      filters.type = DEFAULT_FILTERS.type;
      filters.intent = DEFAULT_FILTERS.intent;
      filters.status = DEFAULT_FILTERS.status;
      render();
    },
    replyValue(note: Note): string {
      const input = entryFor(note)?.querySelector('[data-bp-part="reply-input"]');
      return input instanceof HTMLTextAreaElement ? input.value : "";
    },
    reportNoteError(note: Note, key?: MessageKey): void {
      const target = entryFor(note)?.querySelector('[data-bp-part="reply-error"]');
      if (!(target instanceof HTMLElement)) return;
      if (key === undefined) {
        target.textContent = "";
        target.hidden = true;
        return;
      }
      target.textContent = options.t(key);
      target.hidden = false;
    },
    reportMessage,
  };

  /** The rendered entry of one note, if it is currently in the list (no selector injection). */
  function entryFor(note: Note): HTMLElement | null {
    for (const child of Array.from(body.children)) {
      if (child instanceof HTMLElement && child.getAttribute("data-bp-note-id") === note.id) {
        return child;
      }
    }
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* settings surface (FR-4.3/4.4/4.5, FR-5.2, FR-11.1)                          */
/* -------------------------------------------------------------------------- */

/** UI preferences of the layer; persisted by the layer (`localStorage`, best effort). */
export interface LayerSettings {
  /** `defaultShowDone` (D4) — governs list *and* markers, FR-4.3. */
  showDone: boolean;
  /** Feedback-only mode (FR-5.2): every new note starts as `intent=feedback`. */
  feedbackOnly: boolean;
  /** Author name written into new notes and replies (D3). */
  author: string;
  /** Raw language tag; the layer normalises it (FR-11.1). */
  language: string;
  /** Bar collapsed to its handle (FR-1.2). */
  barCollapsed: boolean;
  /**
   * Chrome level (FR-12.9): how much of the layer's own chrome is shown. Spelled out here instead of
   * importing the layer's type, because the layer imports `DEFAULT_SETTINGS` from this module.
   */
  chromeLevel: "full" | "quiet" | "off";
}

export const DEFAULT_SETTINGS: LayerSettings = {
  showDone: false,
  feedbackOnly: false,
  author: "",
  language: "en",
  barCollapsed: false,
  chromeLevel: "full",
};

export interface SettingsOptions {
  document: Document;
  t: Translate;
  instanceId: string;
  state: () => LayerSettings;
  onChange: (patch: Partial<LayerSettings>) => void;
  onReset: () => void;
}

export interface SettingsPopover {
  readonly element: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  render(): void;
  /** Push the text field into the state before an action reads it (author name). */
  commitFields(): void;
  /** Mark the author field as locally edited (the layer's change handler calls this). */
  markDirty(): void;
}

export function createSettings(options: SettingsOptions): SettingsPopover {
  const doc = options.document;

  const element = createEl(doc, "div", "bp-popover");
  element.id = `bp-${options.instanceId}-settings`;
  element.setAttribute("data-bp-part", "settings");
  element.setAttribute("data-bp-i18n-aria", "a11y.settingsLabel");
  element.setAttribute("role", "dialog");
  element.setAttribute("aria-modal", "false");
  element.hidden = true;

  const header = createEl(doc, "header", "bp-panel-header");
  const title = textNode(doc, "h2", "bp-popover-title", "settings.title");
  const closeButton = buttonNode(doc, "bp-btn", "settings.close", "settings-close");
  header.append(title, closeButton);

  /** One labelled checkbox row. */
  function switchRow(setting: string, labelKey: MessageKey): { row: HTMLElement; input: HTMLInputElement } {
    const row = createEl(doc, "div", "bp-popover-row");
    const label = createEl(doc, "label", "bp-switch");
    const input = createEl(doc, "input");
    input.type = "checkbox";
    input.setAttribute("data-bp-setting", setting);
    const text = textNode(doc, "span", "bp-hint", labelKey);
    label.append(input, text);
    row.append(label);
    return { row, input };
  }

  const showDoneRow = switchRow("show-done", "settings.showDone");
  const feedbackRow = switchRow("feedback-only", "settings.feedbackOnly");
  const feedbackHint = textNode(doc, "p", "bp-hint", "settings.feedbackOnlyHint");

  const authorField = createEl(doc, "div", "bp-popover-setting");
  const authorLabel = textNode(doc, "label", "bp-hint", "settings.author");
  authorLabel.setAttribute("for", `bp-${options.instanceId}-author`);
  const authorInput = createEl(doc, "input", "bp-input");
  authorInput.id = `bp-${options.instanceId}-author`;
  authorInput.type = "text";
  authorInput.setAttribute("data-bp-setting", "author");
  authorInput.setAttribute("data-bp-i18n-placeholder", "settings.authorPlaceholder");
  const authorHint = textNode(doc, "p", "bp-hint", "settings.authorHint");
  authorField.append(authorLabel, authorInput, authorHint);

  const languageField = createEl(doc, "div", "bp-popover-setting");
  const languageLabel = textNode(doc, "label", "bp-hint", "settings.language");
  languageLabel.setAttribute("for", `bp-${options.instanceId}-language`);
  const languageSelect = createEl(doc, "select", "bp-select");
  languageSelect.id = `bp-${options.instanceId}-language`;
  languageSelect.setAttribute("data-bp-setting", "language");
  for (const [value, key] of [["en", "settings.language.en"], ["de", "settings.language.de"]] as const) {
    const option = createEl(doc, "option");
    option.value = value;
    option.setAttribute("data-bp-i18n", key);
    languageSelect.append(option);
  }
  languageField.append(languageLabel, languageSelect);

  const resetButton = buttonNode(doc, "bp-btn", "settings.reset", "settings-reset");
  const persistNote = textNode(doc, "p", "bp-hint", "settings.persistNote");

  element.append(
    header,
    showDoneRow.row,
    feedbackRow.row,
    feedbackHint,
    authorField,
    languageField,
    resetButton,
    persistNote,
  );

  let openState = false;
  let authorDirty = false;

  function render(): void {
    const state = options.state();
    showDoneRow.input.checked = state.showDone;
    feedbackRow.input.checked = state.feedbackOnly;
    if (!authorDirty) authorInput.value = state.author;
    languageSelect.value = state.language;
    applyTranslations(element, options.t);
  }

  function open(): void {
    openState = true;
    authorDirty = false;
    element.hidden = false;
    render();
  }

  function close(): void {
    openState = false;
    element.hidden = true;
  }

  return {
    element,
    open,
    close,
    toggle(): void {
      if (openState) {
        close();
      } else {
        open();
      }
    },
    isOpen: () => openState,
    render,
    /** The author field commits on change/input; this is the belt-and-braces read. */
    commitFields(): void {
      if (authorDirty) {
        options.onChange({ author: authorInput.value });
        authorDirty = false;
      }
    },
    /** Mark the author field as locally edited (called by the layer's change handler). */
    markDirty(): void {
      authorDirty = true;
    },
  };
}


