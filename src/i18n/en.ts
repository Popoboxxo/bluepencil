/**
 * English message table — the default language and the single source of truth for message keys
 * (FR-11.1).
 *
 * Rules:
 *  - every user-visible string of the review layer lives here (no literals in `src/ui/*`);
 *  - `de.ts` is typed as `Messages`, so a missing translation is a **compile error**, never a raw
 *    key in the UI;
 *  - placeholders use `{name}` and are substituted by `t(key, vars)`;
 *  - dependency-free: this module is a plain object, nothing else.
 */

export const en = {
  /* -- accessibility labels (FR-11.4) ------------------------------------- */
  "a11y.layerLabel": "Annotation layer",
  "a11y.barLabel": "Annotation bar",
  "a11y.handleLabel": "Annotation handle",
  "a11y.markerLabel": "Note marker",
  "a11y.markerCount": "{count} notes here",
  "a11y.panelLabel": "Note list",
  "a11y.composerLabel": "Note input",
  "a11y.legendLabel": "Shortcut legend",
  "a11y.settingsLabel": "Layer settings",
  "a11y.liveSaved": "Note saved",
  "a11y.selected": "Selected",

  /* -- bar ----------------------------------------------------------------- */
  "bar.title": "Review notes",
  "bar.mode.text": "Text note",
  "bar.mode.design": "Design note",
  "bar.panel": "Notes",
  "bar.feedbackOnly": "Feedback only",
  "bar.showDone": "Show done",
  "bar.settings": "Settings",
  "bar.legend": "Shortcuts",
  "bar.collapse": "Hide bar",
  "bar.expand": "Show bar",

  /* -- counters (FR-4.8) --------------------------------------------------- */
  "counters.total": "Total",
  "counters.open": "Open",
  "counters.decisions": "Decisions",
  "counters.feedback": "Assessments",

  /* -- mode hint ----------------------------------------------------------- */
  "mode.text.hint": "Click a text element to add a note — Esc stops",
  "mode.design.hint": "Click any element to capture its state — Esc stops",

  /* -- composer ------------------------------------------------------------ */
  "composer.title.text": "New text note",
  "composer.title.design": "New design note",
  "composer.bodyLabel": "Your note",
  "composer.bodyPlaceholder": "What should change here?",
  "composer.typeLabel": "Topic",
  "composer.type.text": "Text and wording",
  "composer.type.design": "Design and layout",
  "composer.intentLabel": "Intent",
  "composer.intent.implement": "Change it",
  "composer.intent.feedback": "Assess it only",
  "composer.feedbackOnlyActive":
    "Feedback-only mode: new notes ask for an assessment, nothing is changed.",
  "composer.capturedSummary": "Show the captured state",
  "composer.capturedTag": "Element type",
  "composer.capturedClasses": "Classes",
  "composer.capturedStyles": "Styles",
  "composer.capturedBox": "Size",
  "composer.capturedScheme": "Colour scheme",
  "composer.capturedScheme.light": "light",
  "composer.capturedScheme.dark": "dark",
  "composer.capturedViewport": "Visible area",
  "composer.capturedBuild": "Build reference",
  "composer.quoteLabel": "Quote",
  "composer.anchorLabel": "Anchor",
  "composer.target": "Selected element",
  "composer.save": "Save note",
  "composer.cancel": "Cancel",
  "composer.saveHint": "Ctrl/⌘ + Enter saves the note",
  "composer.error.empty": "Please write something first.",
  "composer.error.vanished": "The element is gone — the note was not saved.",
  "composer.error.save": "The note could not be saved.",

  /* -- panel --------------------------------------------------------------- */
  "panel.title": "Notes",
  "panel.close": "Close the note list",
  "panel.empty": "No notes yet.",
  "panel.filter.type": "Type",
  "panel.filter.intent": "Intent",
  "panel.filter.status": "State",
  "panel.filter.all": "All",
  "panel.showDone": "Show done notes",
  "panel.hideDone": "Hide done notes",
  "panel.doneHidden": "Done notes are hidden.",
  "panel.type.text": "Wording",
  "panel.type.design": "Design",
  "panel.intent.implement": "Implement",
  "panel.intent.feedback": "Assessment only",
  "panel.status.open": "OPEN",
  "panel.status.needs_decision": "DECISION",
  "panel.status.done": "DONE",
  "panel.orphaned": "orphaned",
  "panel.orphanedHint": "The element cannot be found — jumping is not possible.",
  "panel.orphanedRevealHint":
    "The element sits in a dialog, popover or tab that is currently closed — jumping will open it.",
  "panel.degraded": "partly unresolvable",
  "panel.route": "Page",
  "panel.author": "Author",
  "panel.created": "Created",
  "panel.source": "Source",
  "panel.thread": "Thread",
  "panel.thread.empty": "No replies yet.",
  "panel.reply.placeholder": "Write a reply",
  "panel.reply.send": "Send reply",
  "panel.reply.answerDecision": "Answer the decision",
  "panel.reply.decisionHint": "Your answer reopens this note.",
  "panel.reply.empty": "Please write a reply first.",
  "panel.reply.error": "The reply could not be saved.",
  "panel.action.markDone": "Mark done",
  "panel.action.reopen": "Reopen",
  "panel.action.switchIntent": "Switch intent",
  "panel.action.delete": "Delete note",
  "panel.action.confirmDelete": "Confirm delete",
  "panel.action.exportMarkdown": "Export Markdown",
  "panel.action.exportJson": "Export JSON",
  "panel.jump": "Jump to element",
  "panel.visible": "{count} shown",
  "panel.author.human": "human",
  "panel.author.agent": "agent",
  "panel.message.note": "note",
  "panel.message.decision_request": "decision request",
  "panel.message.decision": "decision",
  "panel.message.feedback": "assessment",
  "panel.message.reply": "reply",
  "panel.error.action": "The action could not be saved.",
  "panel.error.export": "The export failed — nothing was downloaded.",

  /* -- settings (FR-4.5) --------------------------------------------------- */
  "settings.title": "Settings",
  "settings.showDone": "Show done notes by default",
  "settings.feedbackOnly": "Feedback-only mode",
  "settings.feedbackOnlyHint": "New notes ask for an assessment only.",
  "settings.author": "Author name",
  "settings.authorPlaceholder": "Your name",
  "settings.authorHint": "Used as the author of new notes and replies.",
  "settings.language": "Language",
  "settings.language.en": "English",
  "settings.language.de": "German",
  "settings.reset": "Reset to defaults",
  "settings.close": "Close settings",
  "settings.persistNote": "Settings are kept in this browser.",

  /* -- legend (FR-1.7) ----------------------------------------------------- */
  "legend.title": "Keyboard shortcuts",
  "legend.group.capture": "Capture",
  "legend.group.view": "View",
  "legend.group.navigate": "Navigate",
  "legend.group.edit": "Editing",
  "legend.key.text": "Text mode on/off",
  "legend.key.design": "Design mode on/off",
  "legend.key.panel": "Open/close the note list",
  "legend.key.feedbackOnly": "Feedback-only mode on/off",
  "legend.key.bar": "Show/hide the bar",
  "legend.key.chrome": "Cycle chrome: full / quiet / off",
  "legend.key.legend": "Show this legend",
  "legend.key.cancel": "Cancel / close",
  "legend.key.next": "Next note",
  "legend.key.previous": "Previous note",
  "legend.key.jump": "Jump to note 1–9",
  "legend.key.save": "Save the note (Ctrl/⌘ + Enter)",
  "legend.key.passthrough": "Links and form fields always stay usable",
  "legend.close": "Close legend",
  "legend.backdrop": "Close",

  /* -- generic status ------------------------------------------------------ */
  "status.error": "Something went wrong.",
  "status.degraded":
    "This host is missing browser APIs — the layer runs in a reduced mode.",
} as const;

/** Every message key of the layer — derived from the English table (no duplicated key lists). */
export type MessageKey = keyof typeof en;

/** Shape a complete language table must satisfy (see `de.ts`). */
export type Messages = Record<MessageKey, string>;
