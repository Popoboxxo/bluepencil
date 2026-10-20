/**
 * Note input popover — the composer (FR-1.3/1.4/1.5, FR-5.1/5.2, FR-9.3, FR-11.1/11.2).
 *
 * Responsibilities:
 *  - render the note form: body, topic (text/design/bug), intent switch (implement is the default),
 *    a feedback-only indicator, the captured state of a design note and the quote;
 *  - never talk to the store: it receives the anchor/captured context from the layer and reports
 *    the save through `options.onSave`, which the layer answers with `{ ok }` (so a refused save
 *    — FR-2.3 — keeps the composer open and shows the reason);
 *  - own no listeners and no timers: the layer routes its delegated events into `handleKey()` and
 *    `save()`/`close()`, which keeps teardown provable (FR-12.2, NFR-2, NFR-15);
 *  - render every user value as **text** (FR-9.3): `textContent` only, no HTML anywhere.
 */

import type {
  Anchor,
  CapturedContext,
  NoteIntent,
  NotePriority,
  NoteSeverity,
  NoteType,
} from "../core/model";
import { applyTranslations, type Translate } from "../i18n";
import type { MessageKey } from "../i18n/en";
import { createVoice, resolveVoiceEngine, type Voice, type VoiceEngineFactory, type VoiceErrorKind } from "./voice";

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
  /** FR-3.6: only set for `type: "bug"`; omitted for every other type. */
  severity?: NoteSeverity;
  /** FR-3.7: only set for `type: "feature"`; omitted for every other type. */
  priority?: NotePriority;
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
  /** Dictation opt-in (FR-21.1): false/absent means no mic button and no listener. */
  voice?: () => boolean;
  /** Host-injected recogniser factory (FR-21.6); wins over the browser Web Speech API. */
  voiceEngine?: VoiceEngineFactory;
  /** Current composer/layer language tag (e.g. "de"), used as the engine `lang` (FR-21.3). */
  language?: () => string;
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

/** Composer heading per note category (FR-3.2); keeps the category switch exhaustive. */
const COMPOSER_TITLE_KEYS: Record<NoteType, MessageKey> = {
  text: "composer.title.text",
  design: "composer.title.design",
  bug: "composer.title.bug",
  feature: "composer.title.feature",
};

/** FR-21.8: the inline alert key per engine error kind. */
const VOICE_ERROR_KEYS: Record<VoiceErrorKind, MessageKey> = {
  permission: "composer.voice.permission",
  unsupported: "composer.voice.unsupported",
  "no-speech": "composer.voice.error",
  error: "composer.voice.error",
};

export function createComposer(options: ComposerOptions): Composer {
  const doc = options.document;
  const idPrefix = `bp-${options.instanceId}-composer`;

  let target: ComposerTarget | null = null;
  let open = false;
  let selectedType: NoteType = "text";
  let selectedIntent: NoteIntent = "implement";
  let selectedSeverity: NoteSeverity | null = null;
  let selectedPriority: NotePriority | null = null;
  let previousActive: Element | null = null;
  /** Dictation remains off (no UI at all) unless the host opted in and an engine resolves (FR-21.1). */
  const voiceEnabled = options.voice?.() === true && resolveVoiceEngine(globalThis, options.voiceEngine) !== null;
  /** Created on the first mic toggle, released by `close()` so a restart gets a fresh engine. */
  let voice: Voice | null = null;
  let voiceButton: HTMLButtonElement | null = null;
  let voiceStatus: HTMLParagraphElement | null = null;

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
  const bugTypeButton = typeButton("bug", "composer.type.bug");
  const featureTypeButton = typeButton("feature", "composer.type.feature");
  typeRow.append(
    textNode(doc, "span", "bp-hint", "composer.typeLabel"),
    textTypeButton,
    designTypeButton,
    bugTypeButton,
    featureTypeButton,
  );

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

  // FR-3.6: the severity switch is only shown for a bug report; every other topic hides it.
  const severityRow = createEl(doc, "div", "bp-field");
  const severityButton = (value: NoteSeverity, key: MessageKey): HTMLButtonElement => {
    const node = textNode(doc, "button", "bp-btn", key);
    node.setAttribute("type", "button");
    node.setAttribute("data-bp-action", `composer-severity-${value}`);
    node.setAttribute("aria-pressed", "false");
    return node as HTMLButtonElement;
  };
  const severityButtons: [NoteSeverity, HTMLButtonElement][] = [
    ["blocker", severityButton("blocker", "composer.severity.blocker")],
    ["major", severityButton("major", "composer.severity.major")],
    ["minor", severityButton("minor", "composer.severity.minor")],
  ];
  severityRow.append(
    textNode(doc, "span", "bp-hint", "composer.severityLabel"),
    ...severityButtons.map(([, button]) => button),
  );

  // FR-3.7: the priority switch mirrors severity — it is only shown for a feature request.
  const priorityRow = createEl(doc, "div", "bp-field");
  const priorityButton = (value: NotePriority, key: MessageKey): HTMLButtonElement => {
    const node = textNode(doc, "button", "bp-btn", key);
    node.setAttribute("type", "button");
    node.setAttribute("data-bp-action", `composer-priority-${value}`);
    node.setAttribute("aria-pressed", "false");
    return node as HTMLButtonElement;
  };
  const priorityButtons: [NotePriority, HTMLButtonElement][] = [
    ["high", priorityButton("high", "composer.priority.high")],
    ["medium", priorityButton("medium", "composer.priority.medium")],
    ["low", priorityButton("low", "composer.priority.low")],
  ];
  priorityRow.append(
    textNode(doc, "span", "bp-hint", "composer.priorityLabel"),
    ...priorityButtons.map(([, button]) => button),
  );

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

  // FR-21.1/21.2: without an opt-in (or without a usable engine) there is no mic button and no live
  // region at all — neither a listener nor a permission prompt can exist for a host that stayed out.
  if (voiceEnabled) {
    voiceButton = textNode(doc, "button", "bp-btn bp-voice", "composer.voice.start") as HTMLButtonElement;
    voiceButton.setAttribute("type", "button");
    voiceButton.setAttribute("data-bp-action", "composer-voice");
    voiceButton.setAttribute("aria-pressed", "false");

    voiceStatus = createEl(doc, "p", "bp-voice-status");
    voiceStatus.setAttribute("data-bp-part", "composer-voice-status");
    voiceStatus.setAttribute("aria-live", "polite");
    voiceStatus.setAttribute("role", "status");
    voiceStatus.hidden = true;
  }

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

  const children: HTMLElement[] = [
    header,
    targetLine,
    typeRow,
    intentRow,
    severityRow,
    priorityRow,
    feedbackNote,
    bodyLabel,
    bodyInput,
  ];
  if (voiceButton !== null) children.push(voiceButton);
  if (voiceStatus !== null) children.push(voiceStatus);
  children.push(quoteLine, anchorLine, captured, footer);
  element.append(...children);

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

  /** FR-21.8: reflect the listening state on the mic button; the label key follows it. */
  function renderVoice(): void {
    if (voiceButton === null) return;
    const listening = voice?.isListening() === true;
    voiceButton.setAttribute("aria-pressed", listening ? "true" : "false");
    voiceButton.setAttribute("data-bp-i18n", listening ? "composer.voice.stop" : "composer.voice.start");
    voiceButton.classList.toggle("is-listening", listening);
  }

  function renderForm(): void {
    title.setAttribute("data-bp-i18n", COMPOSER_TITLE_KEYS[selectedType]);
    textTypeButton.setAttribute("aria-pressed", selectedType === "text" ? "true" : "false");
    designTypeButton.setAttribute("aria-pressed", selectedType === "design" ? "true" : "false");
    bugTypeButton.setAttribute("aria-pressed", selectedType === "bug" ? "true" : "false");
    featureTypeButton.setAttribute("aria-pressed", selectedType === "feature" ? "true" : "false");
    textTypeButton.classList.toggle("is-active", selectedType === "text");
    designTypeButton.classList.toggle("is-active", selectedType === "design");
    bugTypeButton.classList.toggle("is-active", selectedType === "bug");
    featureTypeButton.classList.toggle("is-active", selectedType === "feature");
    implementButton.setAttribute("aria-pressed", selectedIntent === "implement" ? "true" : "false");
    feedbackButton.setAttribute("aria-pressed", selectedIntent === "feedback" ? "true" : "false");
    implementButton.classList.toggle("is-active", selectedIntent === "implement");
    feedbackButton.classList.toggle("is-active", selectedIntent === "feedback");
    severityRow.hidden = selectedType !== "bug";
    for (const [value, button] of severityButtons) {
      button.setAttribute("aria-pressed", selectedSeverity === value ? "true" : "false");
      button.classList.toggle("is-active", selectedSeverity === value);
    }
    priorityRow.hidden = selectedType !== "feature";
    for (const [value, button] of priorityButtons) {
      button.setAttribute("aria-pressed", selectedPriority === value ? "true" : "false");
      button.classList.toggle("is-active", selectedPriority === value);
    }
    feedbackNote.hidden = !options.feedbackOnly();
    // The label key has to be set before the walk rewrites the button text (FR-21.7/21.8).
    renderVoice();
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
    else if (action === "composer-type-bug") selectType("bug");
    else if (action === "composer-type-feature") selectType("feature");
    else if (action === "composer-intent-implement") selectIntent("implement");
    else if (action === "composer-intent-feedback") selectIntent("feedback");
    else if (action === "composer-severity-blocker") selectSeverity("blocker");
    else if (action === "composer-severity-major") selectSeverity("major");
    else if (action === "composer-severity-minor") selectSeverity("minor");
    else if (action === "composer-priority-high") selectPriority("high");
    else if (action === "composer-priority-medium") selectPriority("medium");
    else if (action === "composer-priority-low") selectPriority("low");
    else if (action === "composer-voice") toggleVoice();
    else return false;
    return true;
  }

  function selectType(value: NoteType): void {
    selectedType = value;
    // FR-3.6/3.7: severity belongs to a bug, priority to a feature — leaving a topic clears its value.
    if (value !== "bug") selectedSeverity = null;
    if (value !== "feature") selectedPriority = null;
    renderForm();
  }

  function selectIntent(value: NoteIntent): void {
    selectedIntent = value;
    renderForm();
  }

  function selectSeverity(value: NoteSeverity): void {
    selectedSeverity = value;
    renderForm();
  }

  function selectPriority(value: NotePriority): void {
    selectedPriority = value;
    renderForm();
  }

  /* -- voice dictation (FR-21) -------------------------------------------- */

  /**
   * Lazily builds the controller on the first mic toggle. Never reached unless the host opted in and
   * an engine resolves (FR-21.1/21.2), so a host that stayed out owns no listener and no engine.
   */
  function ensureVoice(): Voice | null {
    if (!voiceEnabled) return null;
    if (voice !== null) return voice;
    const engine = resolveVoiceEngine(globalThis, options.voiceEngine);
    if (engine === null) return null;
    voice = createVoice({
      language: options.language?.() ?? "en",
      engine,
      // FR-21.3: interim results live only in the status region; they are never appended.
      onInterim: (text) => {
        if (voiceStatus === null) return;
        voiceStatus.hidden = false;
        voiceStatus.textContent = `${options.t("composer.voice.listening")} ${text}`.trim();
      },
      // FR-21.3: append the final transcript and put the caret at the end — the human still saves.
      onAppend: (text) => {
        const current = bodyInput.value;
        bodyInput.value = current === "" ? text : `${current} ${text}`;
        const end = bodyInput.value.length;
        try {
          bodyInput.focus({ preventScroll: true });
          bodyInput.setSelectionRange(end, end);
        } catch {
          // Focus/selection is best-effort: a readonly or detached textarea must not break dictation.
        }
      },
      onListeningChange: () => {
        renderVoice();
        applyTranslations(element, options.t);
      },
      // FR-21.8: an error is shown inline; the controller has already returned to the stopped state.
      onError: (kind) => {
        reportError(VOICE_ERROR_KEYS[kind]);
      },
    });
    return voice;
  }

  function toggleVoice(): void {
    const controller = ensureVoice();
    if (controller === null) return;
    controller.toggle();
  }

  /** Stops and releases dictation; idempotent, called from `close()` (FR-21.4). */
  function stopVoice(): void {
    const controller = voice;
    voice = null;
    if (controller !== null) {
      controller.stop();
      controller.destroy();
    }
    if (voiceButton !== null) {
      voiceButton.setAttribute("aria-pressed", "false");
      voiceButton.classList.remove("is-listening");
    }
    if (voiceStatus !== null) {
      voiceStatus.textContent = "";
      voiceStatus.hidden = true;
    }
  }

  /* -- public API --------------------------------------------------------- */

  function close(): void {
    // FR-21.4: Esc, the cancel action and `disable()` all land here — dictation stops with the form.
    stopVoice();
    if (!open) return;
    open = false;
    element.hidden = true;
    bodyInput.value = "";
    reportError(undefined);
    target = null;
    selectedSeverity = null;
    selectedPriority = null;
    restoreFocus();
  }

  function save(): void {
    if (!open) return;
    const body = bodyInput.value.trim();
    if (body === "") {
      reportError("composer.error.empty");
      return;
    }
    const input: ComposerSaveInput = {
      body,
      type: selectedType,
      intent: selectedIntent,
      // FR-3.6: only a bug carries a severity; the field is omitted otherwise.
      ...(selectedType === "bug" && selectedSeverity !== null ? { severity: selectedSeverity } : {}),
      // FR-3.7: only a feature carries a priority; the field is omitted otherwise.
      ...(selectedType === "feature" && selectedPriority !== null ? { priority: selectedPriority } : {}),
    };
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
      selectedSeverity = null;
      selectedPriority = null;
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

