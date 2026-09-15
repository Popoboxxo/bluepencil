/**
 * Note input popover — the composer (FR-1.3/1.4/1.5, FR-5.1/5.2, FR-9.3, FR-11.1/11.2).
 *
 * Responsibilities:
 *  - render the note form: body, topic (text/design), intent switch (implement is the default),
 *    a feedback-only indicator, the captured state of a design note and the quote;
 *  - never talk to the store: it receives the anchor/captured context from the layer and reports
 *    the save through `options.onSave`, which the layer answers with `{ ok }` (so a refused save
 *    — FR-2.3 — keeps the composer open and shows the reason);
 *  - own no listeners and no timers: the layer routes its delegated events into `handleKey()` and
 *    `save()`/`close()`, which keeps teardown provable (FR-12.2, NFR-2, NFR-15);
 *  - render every user value as **text** (FR-9.3): `textContent` only, no HTML anywhere.
 */

import type { Anchor, CapturedContext, NoteIntent, NoteType } from "../core/model";
import { applyTranslations, type Translate } from "../i18n";
import type { MessageKey } from "../i18n/en";

/** What the layer hands over when a click opened the composer. */
export interface ComposerTarget {
  type: NoteType;
  anchor: Anchor;
  quote?: string;
  context: CapturedContext | null;
  /** The annotated element — also the focus target when the composer closes (FR-11.2). */
  element: Element | null;
  /** Human label of the element (`describeElement`), rendered as text. */
  label: string;
}

export interface ComposerSaveInput {
  body: string;
  type: NoteType;
  intent: NoteIntent;
}

/** `{ ok: false }` means "the layer refused" — the composer stays open and shows `reasonKey`. */
export type ComposerSaveResult = { ok: true } | { ok: false; reasonKey?: MessageKey };

export interface ComposerOptions {
  document: Document;
  t: Translate;
  instanceId: string;
  /** Current author name (host identity or the settings field). */
  author: () => string;
  /** Feedback-only mode (FR-5.2): pre-selects `intent=feedback`. */
  feedbackOnly: () => boolean;
  onSave: (input: ComposerSaveInput) => ComposerSaveResult | Promise<ComposerSaveResult>;
  onCancel?: () => void;
  onError?: (err: unknown) => void;
}

export interface Composer {
  readonly element: HTMLElement;
  open(target: ComposerTarget): void;
  close(): void;
  isOpen(): boolean;
  /** Current form state (used by the layer to build the draft). */
  readonly type: () => NoteType;
  readonly intent: () => NoteIntent;
  readonly body: () => string;
  /** Save the current form; used by the button and by Ctrl/Cmd+Enter. */
  save(): void;
  /** Route a key event while the composer is open; `true` when it consumed the event. */
  handleKey(event: KeyboardEvent): boolean;
  /** Show a translated message inline (empty key clears it). */
  reportError(reasonKey?: MessageKey): void;
  /** Route a delegated click of the layer into the form state (topic/intent switches). */
  handleClick(event: Event): boolean;
}

/** Element factory that keeps the markup declarative and free of string HTML. */
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

export function createComposer(options: ComposerOptions): Composer {
  const doc = options.document;
  const idPrefix = `bp-${options.instanceId}-composer`;

  let target: ComposerTarget | null = null;
  let open = false;
  let selectedType: NoteType = "text";
  let selectedIntent: NoteIntent = "implement";
  let previousActive: Element | null = null;

  const element = createEl(doc, "div", "bp-composer");
  element.id = `bp-${options.instanceId}-composer`;
  element.setAttribute("data-bp-part", "composer");
  element.setAttribute("data-bp-i18n-aria", "a11y.composerLabel");
  element.setAttribute("role", "dialog");
  element.setAttribute("aria-modal", "false");
  element.hidden = true;

  const header = createEl(doc, "header", "bp-composer-head");
  const title = textNode(doc, "h2", "bp-panel-title", "composer.title.text");
  title.setAttribute("data-bp-part", "composer-title");
  const cancelButton = textNode(doc, "button", "bp-btn", "composer.cancel");
  cancelButton.setAttribute("type", "button");
  cancelButton.setAttribute("data-bp-action", "composer-cancel");
  header.append(title, cancelButton);

  const targetLine = createEl(doc, "p", "bp-note-meta");
  targetLine.setAttribute("data-bp-part", "composer-target");

  const typeRow = createEl(doc, "div", "bp-field");
  const typeButton = (value: NoteType, key: MessageKey): HTMLButtonElement => {
    const node = textNode(doc, "button", "bp-btn", key);
    node.setAttribute("type", "button");
    node.setAttribute("data-bp-action", `composer-type-${value}`);
    node.setAttribute("aria-pressed", "false");
    return node as HTMLButtonElement;
  };
  const textTypeButton = typeButton("text", "composer.type.text");
  const designTypeButton = typeButton("design", "composer.type.design");
  typeRow.append(textNode(doc, "span", "bp-hint", "composer.typeLabel"), textTypeButton, designTypeButton);

  const intentRow = createEl(doc, "div", "bp-field");
  const intentButton = (value: NoteIntent, key: MessageKey): HTMLButtonElement => {
    const node = textNode(doc, "button", "bp-btn", key);
    node.setAttribute("type", "button");
    node.setAttribute("data-bp-action", `composer-intent-${value}`);
    node.setAttribute("aria-pressed", "false");
    return node as HTMLButtonElement;
  };
  const implementButton = intentButton("implement", "composer.intent.implement");
  const feedbackButton = intentButton("feedback", "composer.intent.feedback");
  intentRow.append(textNode(doc, "span", "bp-hint", "composer.intentLabel"), implementButton, feedbackButton);

  const feedbackNote = textNode(doc, "p", "bp-hint", "composer.feedbackOnlyActive");
  feedbackNote.setAttribute("data-bp-part", "composer-feedback-note");
  feedbackNote.hidden = true;

  const bodyLabel = textNode(doc, "label", "bp-hint", "composer.bodyLabel");
  bodyLabel.setAttribute("for", `${idPrefix}-body`);
  const bodyInput = createEl(doc, "textarea", "bp-textarea");
  bodyInput.id = `${idPrefix}-body`;
  bodyInput.setAttribute("data-bp-part", "composer-body");
  bodyInput.setAttribute("data-bp-i18n-placeholder", "composer.bodyPlaceholder");
  bodyInput.rows = 3;

  const quoteLine = createEl(doc, "p", "bp-note-meta");
  quoteLine.setAttribute("data-bp-part", "composer-quote");
  quoteLine.hidden = true;
  const anchorLine = createEl(doc, "p", "bp-note-meta");
  anchorLine.setAttribute("data-bp-part", "composer-anchor");
  anchorLine.hidden = true;

  const captured = createEl(doc, "details", "bp-details");
  captured.setAttribute("data-bp-part", "composer-captured");
  captured.hidden = true;
  const capturedSummary = textNode(doc, "summary", "bp-hint", "composer.capturedSummary");
  const capturedList = createEl(doc, "dl", "bp-dl");
  capturedList.setAttribute("data-bp-part", "composer-captured-list");
  captured.append(capturedSummary, capturedList);

  const footer = createEl(doc, "div", "bp-note-actions");
  const saveHint = textNode(doc, "p", "bp-hint", "composer.saveHint");
  const errorLine = createEl(doc, "p", "bp-error");
  errorLine.setAttribute("data-bp-part", "composer-error");
  errorLine.setAttribute("role", "alert");
  errorLine.hidden = true;
  const saveButton = textNode(doc, "button", "bp-btn bp-btn--primary", "composer.save");
  saveButton.setAttribute("type", "button");
  saveButton.setAttribute("data-bp-action", "composer-save");
  footer.append(saveHint, errorLine, saveButton);

  element.append(
    header,
    targetLine,
    typeRow,
    intentRow,
    feedbackNote,
    bodyLabel,
    bodyInput,
    quoteLine,
    anchorLine,
    captured,
    footer,
  );

  /* -- rendering ----------------------------------------------------------- */

  /** Human-readable target line: element label, anchor hook and quote, all as text (FR-9.3). */
  function renderTarget(): void {
    if (!target) return;
    targetLine.textContent = `${options.t("composer.target")}: ${target.label || target.anchor.selector || ""}`;
    const anchorLabel = target.anchor.hook ?? target.anchor.selector ?? "";
    if (anchorLabel !== "") {
      anchorLine.textContent = `${options.t("composer.anchorLabel")}: ${anchorLabel}`;
      anchorLine.hidden = false;
    } else {
      anchorLine.textContent = "";
      anchorLine.hidden = true;
    }

    if (target.quote !== undefined && target.quote !== "") {
      quoteLine.textContent = `${options.t("composer.quoteLabel")}: ${target.quote}`;
      quoteLine.hidden = false;
    } else {
      quoteLine.textContent = "";
      quoteLine.hidden = true;
    }
  }

  function renderCaptured(): void {
    const context = target?.context ?? null;
    capturedList.textContent = "";
    if (context === null) {
      captured.hidden = true;
      return;
    }
    const rows: [MessageKey, string][] = [
      ["composer.capturedTag", context.tag],
      ["composer.capturedClasses", context.classes.join(" ")],
      ["composer.capturedBox", `${context.box.w} × ${context.box.h} at ${context.box.x}, ${context.box.y}`],
      [
        "composer.capturedScheme",
        options.t(context.scheme === "dark" ? "composer.capturedScheme.dark" : "composer.capturedScheme.light"),
      ],
      ["composer.capturedViewport", `${context.viewport.w} × ${context.viewport.h}`],
    ];
    if (context.buildRef !== undefined && context.buildRef !== "") {
      rows.push(["composer.capturedBuild", context.buildRef]);
    }
    const styles = Object.entries(context.styles)
      .filter(([, value]) => value !== "")
      .map(([name, value]) => `${name}: ${value}`)
      .join("; ");
    if (styles !== "") rows.push(["composer.capturedStyles", styles]);

    for (const [key, value] of rows) {
      const dt = textNode(doc, "dt", "bp-dt", key);
      const dd = createEl(doc, "dd", "bp-dd");
      dd.textContent = value === "" ? "–" : value;
      capturedList.append(dt, dd);
    }
    captured.hidden = false;
  }

  function renderForm(): void {
    title.setAttribute("data-bp-i18n", selectedType === "design" ? "composer.title.design" : "composer.title.text");
    textTypeButton.setAttribute("aria-pressed", selectedType === "text" ? "true" : "false");
    designTypeButton.setAttribute("aria-pressed", selectedType === "design" ? "true" : "false");
    textTypeButton.classList.toggle("is-active", selectedType === "text");
    designTypeButton.classList.toggle("is-active", selectedType === "design");
    implementButton.setAttribute("aria-pressed", selectedIntent === "implement" ? "true" : "false");
    feedbackButton.setAttribute("aria-pressed", selectedIntent === "feedback" ? "true" : "false");
    implementButton.classList.toggle("is-active", selectedIntent === "implement");
    feedbackButton.classList.toggle("is-active", selectedIntent === "feedback");
    feedbackNote.hidden = !options.feedbackOnly();
    applyTranslations(element, options.t);
  }

  /** Focus target of the composer: the annotated element first, then whatever was focused. */
  function restoreFocus(): void {
    const candidates: Element[] = [];
    if (target?.element && target.element.isConnected) candidates.push(target.element);
    if (previousActive && previousActive.isConnected) candidates.push(previousActive);
    for (const candidate of candidates) {
      const focusable = candidate as { focus?: (options?: { preventScroll?: boolean }) => void };
      if (typeof focusable.focus !== "function") continue;
      try {
        focusable.focus({ preventScroll: true });
        return;
      } catch {
        // Focus is best-effort: a non-focusable host element must never break the layer.
      }
    }
  }

  function reportError(reasonKey?: MessageKey): void {
    if (reasonKey === undefined) {
      errorLine.textContent = "";
      errorLine.hidden = true;
      return;
    }
    errorLine.textContent = options.t(reasonKey);
    errorLine.hidden = false;
  }

  function syncPressedFromEvent(event: Event): boolean {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const node = path.find((entry) => entry instanceof Element && entry.hasAttribute("data-bp-action"));
    const action = node instanceof Element ? node.getAttribute("data-bp-action") : null;
    if (action === null) return false;
    if (action === "composer-type-text") selectType("text");
    else if (action === "composer-type-design") selectType("design");
    else if (action === "composer-intent-implement") selectIntent("implement");
    else if (action === "composer-intent-feedback") selectIntent("feedback");
    else return false;
    return true;
  }

  function selectType(value: NoteType): void {
    selectedType = value;
    renderForm();
  }

  function selectIntent(value: NoteIntent): void {
    selectedIntent = value;
    renderForm();
  }

  /* -- public API --------------------------------------------------------- */

  function close(): void {
    if (!open) return;
    open = false;
    element.hidden = true;
    bodyInput.value = "";
    reportError(undefined);
    target = null;
    restoreFocus();
  }

  function save(): void {
    if (!open) return;
    const body = bodyInput.value.trim();
    if (body === "") {
      reportError("composer.error.empty");
      return;
    }
    const input: ComposerSaveInput = { body, type: selectedType, intent: selectedIntent };
    let result: ComposerSaveResult | Promise<ComposerSaveResult>;
    try {
      result = options.onSave(input);
    } catch (error) {
      reportError("composer.error.save");
      options.onError?.(error);
      return;
    }
    void Promise.resolve(result).then(
      (settled) => {
        if (settled.ok) {
          close();
          return;
        }
        reportError(settled.reasonKey ?? "composer.error.save");
      },
      (error: unknown) => {
        reportError("composer.error.save");
        options.onError?.(error);
      },
    );
  }

  return {
    element,
    type: () => selectedType,
    intent: () => selectedIntent,
    body: () => bodyInput.value,
    isOpen: () => open,
    /**
     * Open on a target. The type comes from the mode that captured the click (FR-1.3/1.4) and the
     * intent follows the feedback-only mode (FR-5.2); `implement` stays the default.
     */
    open(next: ComposerTarget): void {
      const active = doc.activeElement;
      previousActive = active instanceof Element ? active : null;
      target = next;
      selectedType = next.type;
      selectedIntent = options.feedbackOnly() ? "feedback" : "implement";
      bodyInput.value = "";
      reportError(undefined);
      renderTarget();
      renderCaptured();
      renderForm();
      open = true;
      element.hidden = false;
      if (typeof bodyInput.focus === "function") bodyInput.focus({ preventScroll: true });
    },
    close,
    save,
    reportError,
    /**
     * Keyboard handling while the composer is open (FR-11.2):
     * `Esc` cancels and returns focus to the trigger, `Ctrl/Cmd + Enter` saves.
     */
    handleKey(event: KeyboardEvent): boolean {
      if (!open) return false;
      if (event.key === "Escape") {
        const cancelled = target;
        close();
        options.onCancel?.();
        if (cancelled !== null) restoreFocus();
        return true;
      }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        save();
        return true;
      }
      return false;
    },
    /** Route delegated clicks of the layer into the form state. */
    handleClick: syncPressedFromEvent,
  };
}

