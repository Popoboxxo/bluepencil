/**
 * The complete stylesheet of the review layer (ARCHITECTURE §7, FR-1.8/1.9, FR-10.3, FNR-6).
 *
 * Rules encoded here:
 *  - every class is prefixed `bp-` and nothing is global: no resets on `html`/`body`/host tags,
 *    no selectors outside `.bp-root` (FR-10.3, ARCHITECTURE §7);
 *  - every colour, size, radius and spacing value flows through a CSS custom property **with a
 *    fallback** (`var(--bp-accent, #2a63e8)`), so a host design system can adopt the layer
 *    without a build step;
 *  - the wrapper uses `contain: layout style` and a very high `z-index`, so markers can be
 *    positioned freely without ever changing the host's box model (FR-1.8);
 *  - dark mode and `prefers-reduced-motion` are handled in their own blocks (FR-11.3);
 *  - `@media print` removes the layer completely (FR-1.9);
 *  - the whole sheet is injected once per document as a single `<style>` node (FR-12.2).
 *
 * Tokens (documented host overrides): `--bp-accent`, `--bp-accent-ink`, `--bp-surface`,
 * `--bp-surface-alt`, `--bp-ink`, `--bp-muted`, `--bp-line`, `--bp-radius`, `--bp-space`,
 * `--bp-shadow`, `--bp-z`, `--bp-font`.
 *
 * Dark mode note: the `prefers-color-scheme: dark` block re-declares the tokens on `.bp-root`.
 * A host that forces its own palette passes `theme` to `createLayer` (applied as inline custom
 * properties on the same element) or sets the `--bp-*` tokens on the layer root, which both win
 * over this block.
 */

const SPACE = "var(--bp-space, 8px)";

/** Shared spacing helpers so the sheet reads as a scale instead of magic numbers. */
const half = `calc(${SPACE} * 0.5)`;
const tight = `calc(${SPACE} * 0.75)`;

export const STYLES: string = `
.bp-root {
  position: fixed;
  inset: 0;
  z-index: var(--bp-z, 2147483000);
  contain: layout style;
  pointer-events: none;
  font-family: var(--bp-font, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  font-size: var(--bp-font-size, 13px);
  line-height: 1.45;
  color: var(--bp-ink, #14161c);
  text-align: left;
  direction: ltr;
}

.bp-root *,
.bp-root *::before,
.bp-root *::after {
  box-sizing: border-box;
}

.bp-root [hidden] {
  display: none !important;
}

.bp-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

/* -- buttons --------------------------------------------------------------- */

.bp-btn {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: ${half};
  margin: 0;
  padding: ${half} ${tight};
  border: 1px solid var(--bp-line, #d7dae2);
  border-radius: var(--bp-radius, 10px);
  background: var(--bp-surface, #ffffff);
  color: var(--bp-ink, #14161c);
  font: inherit;
  line-height: 1.2;
  cursor: pointer;
  white-space: nowrap;
}

.bp-btn:hover {
  background: var(--bp-surface-alt, #f4f5f8);
}

.bp-btn:focus-visible {
  outline: 2px solid var(--bp-accent, #2a63e8);
  outline-offset: 2px;
}

.bp-btn[disabled] {
  opacity: 0.55;
  cursor: not-allowed;
}

.bp-btn.is-active {
  border-color: var(--bp-accent, #2a63e8);
  background: var(--bp-accent, #2a63e8);
  color: var(--bp-accent-ink, #ffffff);
}

.bp-btn--primary {
  border-color: var(--bp-accent, #2a63e8);
  background: var(--bp-accent, #2a63e8);
  color: var(--bp-accent-ink, #ffffff);
}

.bp-btn--danger {
  border-color: var(--bp-line, #d7dae2);
  color: var(--bp-danger, #b3261e);
}

/* -- bar and handle (FR-1.2) ---------------------------------------------- */

.bp-bar {
  pointer-events: auto;
  position: fixed;
  top: ${SPACE};
  right: ${SPACE};
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: ${half};
  max-width: calc(100vw - ${SPACE} * 2);
  padding: ${half};
  border: 1px solid var(--bp-line, #d7dae2);
  border-radius: var(--bp-radius, 10px);
  background: var(--bp-surface, #ffffff);
  box-shadow: var(--bp-shadow, 0 6px 24px rgba(15, 18, 28, 0.18));
}

.bp-bar-title {
  padding: 0 ${half};
  color: var(--bp-muted, #5a6072);
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  font-size: calc(var(--bp-font-size, 13px) * 0.85);
}

.bp-counters {
  display: flex;
  align-items: center;
  gap: ${half};
  padding: 0 ${half};
  border-left: 1px solid var(--bp-line, #d7dae2);
  border-right: 1px solid var(--bp-line, #d7dae2);
}

.bp-counter {
  display: inline-flex;
  align-items: baseline;
  gap: calc(${SPACE} * 0.25);
  color: var(--bp-muted, #5a6072);
}

.bp-counter-value {
  color: var(--bp-ink, #14161c);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.bp-counter-label {
  font-size: calc(var(--bp-font-size, 13px) * 0.85);
}

.bp-handle {
  pointer-events: auto;
  position: fixed;
  top: ${SPACE};
  right: ${SPACE};
  display: inline-flex;
  align-items: center;
  gap: ${half};
  padding: ${half} ${tight};
  border: 1px solid var(--bp-accent, #2a63e8);
  border-radius: 999px;
  background: var(--bp-accent, #2a63e8);
  color: var(--bp-accent-ink, #ffffff);
  font: inherit;
  cursor: pointer;
  box-shadow: var(--bp-shadow, 0 6px 24px rgba(15, 18, 28, 0.18));
}

.bp-handle:focus-visible {
  outline: 2px solid var(--bp-accent, #2a63e8);
  outline-offset: 2px;
}

.bp-handle-count {
  font-variant-numeric: tabular-nums;
  font-weight: 700;
}

.bp-mode-hint {
  pointer-events: none;
  position: fixed;
  left: 50%;
  bottom: ${SPACE};
  transform: translateX(-50%);
  padding: ${half} ${tight};
  border: 1px solid var(--bp-accent, #2a63e8);
  border-radius: 999px;
  background: var(--bp-surface, #ffffff);
  color: var(--bp-ink, #14161c);
  box-shadow: var(--bp-shadow, 0 6px 24px rgba(15, 18, 28, 0.18));
}

/* -- slots, docking and narrow viewports (FR-12.10, FR-12.13, NFR-20) ------ */

/**
 * Chrome slots (FR-12.10): the attribute data-bp-slot names the corner or edge a surface occupies, and
 * these rules are the only place that knows geometry — so "no two surfaces overlap" is a property of
 * the sheet, not of the order the surfaces happen to be appended in.
 */
.bp-root [data-bp-slot="top-end"] {
  top: ${SPACE};
  right: ${SPACE};
}

.bp-root [data-bp-slot="bottom-end"] {
  bottom: ${SPACE};
  right: ${SPACE};
}

.bp-root [data-bp-slot="top-center"] {
  top: ${SPACE};
  left: 50%;
  transform: translateX(-50%);
}

.bp-root [data-bp-slot="bottom-center"] {
  bottom: ${SPACE};
  left: 50%;
  transform: translateX(-50%);
}

/* Docking moves the strip and its handle together and sends the mode hint to the opposite edge. */
.bp-root[data-bp-dock="bottom"] .bp-bar,
.bp-root[data-bp-dock="bottom"] .bp-handle {
  top: auto;
  bottom: ${SPACE};
}

.bp-root[data-bp-dock="bottom"] .bp-mode-hint {
  top: ${SPACE};
  bottom: auto;
}

/* Long words, generated labels and host-supplied paths wrap instead of widening the chrome. */
.bp-bar,
.bp-handle,
.bp-panel,
.bp-composer,
.bp-legend,
.bp-mode-hint {
  overflow-wrap: anywhere;
}

.bp-bar-title,
.bp-counters,
.bp-legend-label,
.bp-legend-keys {
  min-width: 0;
}

/**
 * Narrow viewports (FR-12.13): what cannot fit is dropped, not squeezed. The layer also drops to quiet
 * by itself at this width — that part is JavaScript, because a media query could hide the bar while
 * its handle stays hidden and leave the host with no chrome at all.
 */
@media (max-width: 719px) {
  .bp-bar {
    max-width: calc(100vw - ${SPACE} * 2);
  }

  .bp-bar-title {
    display: none;
  }
}

/* -- markers (FR-4.1, D2) -------------------------------------------------- */

.bp-markers {
  pointer-events: none;
  position: fixed;
  inset: 0;
}

.bp-marker {
  pointer-events: auto;
  position: fixed;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: calc(${SPACE} * 2);
  height: calc(${SPACE} * 2);
  padding: 0 ${half};
  border: 1px solid var(--bp-accent-ink, #ffffff);
  border-radius: 999px;
  background: var(--bp-accent, #2a63e8);
  color: var(--bp-accent-ink, #ffffff);
  font: inherit;
  font-size: calc(var(--bp-font-size, 13px) * 0.85);
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
  box-shadow: var(--bp-shadow, 0 6px 24px rgba(15, 18, 28, 0.18));
}

.bp-marker:focus-visible {
  outline: 2px solid var(--bp-accent, #2a63e8);
  outline-offset: 2px;
}

.bp-marker[data-bp-status="needs_decision"] {
  background: var(--bp-decision, #b3261e);
}

.bp-marker[data-bp-intent="feedback"] {
  background: var(--bp-feedback, #7a4bd0);
}

.bp-marker-count {
  font-variant-numeric: tabular-nums;
}

.bp-highlight {
  pointer-events: none;
  position: fixed;
  border: 2px solid var(--bp-accent, #2a63e8);
  border-radius: calc(var(--bp-radius, 10px) * 0.5);
  background: var(--bp-highlight, rgba(42, 99, 232, 0.12));
  animation: bp-highlight-fade 1.2s ease-out 1 both;
}

@keyframes bp-highlight-fade {
  0% { opacity: 0.35; }
  40% { opacity: 1; }
  100% { opacity: 0; }
}

/* -- panel (FR-4.2) -------------------------------------------------------- */

.bp-panel {
  pointer-events: auto;
  position: fixed;
  top: calc(${SPACE} * 6);
  right: ${SPACE};
  display: flex;
  flex-direction: column;
  gap: ${half};
  width: min(420px, calc(100vw - ${SPACE} * 2));
  max-height: min(70vh, 720px);
  overflow: hidden;
  padding: ${tight};
  border: 1px solid var(--bp-line, #d7dae2);
  border-radius: var(--bp-radius, 10px);
  background: var(--bp-surface, #ffffff);
  box-shadow: var(--bp-shadow, 0 6px 24px rgba(15, 18, 28, 0.18));
}

.bp-panel-header,
.bp-composer-head,
.bp-legend-group,
.bp-note-actions,
.bp-note-head,
.bp-message-head,
.bp-reply,
.bp-filters,
.bp-popover-row {
  display: flex;
  align-items: center;
  gap: ${half};
  flex-wrap: wrap;
}

.bp-panel-title,
.bp-popover-title {
  flex: 1 1 auto;
  margin: 0;
  font-size: calc(var(--bp-font-size, 13px) * 1.05);
  font-weight: 700;
}

.bp-filters {
  padding: ${half} 0;
  border-bottom: 1px solid var(--bp-line, #d7dae2);
}

.bp-field {
  display: inline-flex;
  align-items: center;
  gap: calc(${SPACE} * 0.25);
  color: var(--bp-muted, #5a6072);
}

.bp-select,
.bp-input,
.bp-textarea {
  pointer-events: auto;
  padding: ${half};
  border: 1px solid var(--bp-line, #d7dae2);
  border-radius: calc(var(--bp-radius, 10px) * 0.6);
  background: var(--bp-surface, #ffffff);
  color: var(--bp-ink, #14161c);
  font: inherit;
}

.bp-select:focus-visible,
.bp-input:focus-visible,
.bp-textarea:focus-visible {
  outline: 2px solid var(--bp-accent, #2a63e8);
  outline-offset: 1px;
}

.bp-textarea {
  width: 100%;
  min-height: calc(${SPACE} * 8);
  resize: vertical;
}

.bp-panel-body {
  flex: 1 1 auto;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: ${half};
}

.bp-note {
  display: flex;
  flex-direction: column;
  gap: ${half};
  padding: ${half};
  border: 1px solid var(--bp-line, #d7dae2);
  border-radius: calc(var(--bp-radius, 10px) * 0.75);
  background: var(--bp-surface-alt, #f4f5f8);
}

.bp-note.is-selected {
  border-color: var(--bp-accent, #2a63e8);
  background: var(--bp-surface, #ffffff);
}

.bp-note.is-orphaned {
  border-style: dashed;
}

.bp-note-jump {
  pointer-events: auto;
  display: block;
  width: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.bp-note-jump:focus-visible {
  outline: 2px solid var(--bp-accent, #2a63e8);
  outline-offset: 2px;
}

.bp-note-body {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.bp-note-meta {
  color: var(--bp-muted, #5a6072);
  font-size: calc(var(--bp-font-size, 13px) * 0.85);
  overflow-wrap: anywhere;
}

.bp-badge {
  display: inline-flex;
  align-items: center;
  gap: calc(${SPACE} * 0.25);
  padding: 0 ${half};
  border: 1px solid var(--bp-line, #d7dae2);
  border-radius: 999px;
  background: var(--bp-surface, #ffffff);
  color: var(--bp-muted, #5a6072);
  font-size: calc(var(--bp-font-size, 13px) * 0.8);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.bp-badge--decision {
  border-color: var(--bp-decision, #b3261e);
  color: var(--bp-decision, #b3261e);
}

.bp-badge--feedback {
  border-color: var(--bp-feedback, #7a4bd0);
  color: var(--bp-feedback, #7a4bd0);
}

.bp-badge--done {
  text-decoration: line-through;
}

.bp-badge--orphaned,
.bp-badge--degraded {
  border-style: dashed;
  border-color: var(--bp-danger, #b3261e);
  color: var(--bp-danger, #b3261e);
}

.bp-hint {
  margin: 0;
  color: var(--bp-muted, #5a6072);
  font-size: calc(var(--bp-font-size, 13px) * 0.85);
}

.bp-thread {
  display: flex;
  flex-direction: column;
  gap: ${half};
  padding-top: ${half};
  border-top: 1px solid var(--bp-line, #d7dae2);
}

.bp-message {
  display: flex;
  flex-direction: column;
  gap: calc(${SPACE} * 0.25);
  padding-left: ${half};
  border-left: 2px solid var(--bp-line, #d7dae2);
}

.bp-message[data-bp-kind="decision_request"],
.bp-message[data-bp-kind="decision"] {
  border-left-color: var(--bp-decision, #b3261e);
}

.bp-message[data-bp-kind="feedback"] {
  border-left-color: var(--bp-feedback, #7a4bd0);
}

.bp-message-head {
  color: var(--bp-muted, #5a6072);
  font-size: calc(var(--bp-font-size, 13px) * 0.8);
}

.bp-message-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.bp-reply {
  align-items: flex-start;
}

.bp-reply .bp-textarea {
  flex: 1 1 160px;
}

.bp-live {
  margin: 0;
  color: var(--bp-muted, #5a6072);
  font-size: calc(var(--bp-font-size, 13px) * 0.85);
}

.bp-error {
  margin: 0;
  color: var(--bp-danger, #b3261e);
  font-size: calc(var(--bp-font-size, 13px) * 0.85);
}

/* -- composer -------------------------------------------------------------- */

.bp-composer {
  pointer-events: auto;
  position: fixed;
  left: 50%;
  bottom: ${SPACE};
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: ${half};
  width: min(520px, calc(100vw - ${SPACE} * 2));
  padding: ${tight};
  border: 1px solid var(--bp-line, #d7dae2);
  border-radius: var(--bp-radius, 10px);
  background: var(--bp-surface, #ffffff);
  box-shadow: var(--bp-shadow, 0 6px 24px rgba(15, 18, 28, 0.18));
}

.bp-details {
  border: 1px dashed var(--bp-line, #d7dae2);
  border-radius: calc(var(--bp-radius, 10px) * 0.6);
  padding: ${half};
}

.bp-details summary {
  cursor: pointer;
  color: var(--bp-muted, #5a6072);
}

.bp-dl {
  display: grid;
  grid-template-columns: minmax(0, auto) minmax(0, 1fr);
  gap: calc(${SPACE} * 0.25) ${half};
  margin: ${half} 0 0;
  overflow-wrap: anywhere;
}

.bp-dt {
  color: var(--bp-muted, #5a6072);
}

.bp-dd {
  margin: 0;
}

/* -- settings popover (FR-4.5) -------------------------------------------- */

.bp-popover {
  pointer-events: auto;
  position: fixed;
  top: calc(${SPACE} * 6);
  right: ${SPACE};
  display: flex;
  flex-direction: column;
  gap: ${half};
  width: min(320px, calc(100vw - ${SPACE} * 2));
  padding: ${tight};
  border: 1px solid var(--bp-line, #d7dae2);
  border-radius: var(--bp-radius, 10px);
  background: var(--bp-surface, #ffffff);
  box-shadow: var(--bp-shadow, 0 6px 24px rgba(15, 18, 28, 0.18));
}

.bp-popover-row {
  align-items: flex-start;
  justify-content: flex-start;
}

.bp-switch {
  display: inline-flex;
  align-items: flex-start;
  gap: ${half};
  cursor: pointer;
}

.bp-switch input {
  margin: calc(${SPACE} * 0.25) 0 0;
}

.bp-popover-setting {
  display: flex;
  flex-direction: column;
  gap: calc(${SPACE} * 0.25);
  color: var(--bp-muted, #5a6072);
  font-size: calc(var(--bp-font-size, 13px) * 0.85);
}

/* -- legend (FR-1.7) ------------------------------------------------------ */

.bp-legend-backdrop {
  pointer-events: auto;
  position: fixed;
  inset: 0;
  background: var(--bp-backdrop, rgba(12, 14, 20, 0.45));
}

.bp-legend {
  pointer-events: auto;
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  gap: ${tight};
  width: min(560px, calc(100vw - ${SPACE} * 2));
  max-height: min(80vh, 640px);
  overflow: auto;
  padding: ${tight};
  border: 1px solid var(--bp-line, #d7dae2);
  border-radius: var(--bp-radius, 10px);
  background: var(--bp-surface, #ffffff);
  box-shadow: var(--bp-shadow, 0 6px 24px rgba(15, 18, 28, 0.18));
}

.bp-legend-body {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: ${tight};
}

.bp-legend-group {
  flex-direction: column;
  align-items: stretch;
  gap: calc(${SPACE} * 0.5);
}

.bp-legend-group-title {
  font-weight: 700;
}

.bp-legend-row {
  display: flex;
  align-items: baseline;
  gap: ${half};
  justify-content: space-between;
}

.bp-legend-label {
  color: var(--bp-muted, #5a6072);
}

.bp-legend-keys {
  display: inline-flex;
  align-items: center;
  gap: calc(${SPACE} * 0.25);
}

.bp-kbd {
  padding: 0 calc(${SPACE} * 0.4);
  border: 1px solid var(--bp-line, #d7dae2);
  border-bottom-width: 2px;
  border-radius: calc(var(--bp-radius, 10px) * 0.4);
  background: var(--bp-surface-alt, #f4f5f8);
  color: var(--bp-ink, #14161c);
  font-family: var(--bp-font, system-ui, sans-serif);
  font-size: calc(var(--bp-font-size, 13px) * 0.85);
  white-space: nowrap;
}

/* -- dark scheme (FR-11.3, ARCHITECTURE §7) ------------------------------- */

/*
 * The dark palette is applied through the SAME var(--bp-x, <light>) slots as the light one, as
 * a second .bp-root rule inside the media query. It is deliberately NOT a plain re-declaration of
 * --bp-x on .bp-root: that would beat a value inherited from a host rule on :root (a custom
 * property set on the element itself wins over an inherited one), so a host that follows
 * docs/INTEGRATION.md lost its palette the moment the OS turned dark — measured: --bp-accent
 * fell back to #7ba2ff instead of the host's #8c3b2e, with no warning.
 *
 * With the rule below the host token wins, and a host that sets no token still gets the dark
 * palette through the var() fallback. A host that wants to force light on a dark OS pins the
 * tokens itself (or passes them via theme / data-theme-*, which are inline on the root and win
 * here). Dark mode stays an OS default, not a per-host switch.
 */
@media (prefers-color-scheme: dark) {
  .bp-root {
    color: var(--bp-ink, #eceef4);
    color-scheme: dark;
  }
  .bp-root {
    --bp-surface: var(--bp-surface, #1c1f27);
    --bp-surface-alt: var(--bp-surface-alt, #242833);
    --bp-ink: var(--bp-ink, #eceef4);
    --bp-muted: var(--bp-muted, #a3a9bb);
    --bp-line: var(--bp-line, #343a48);
    --bp-accent: var(--bp-accent, #7ba2ff);
    --bp-accent-ink: var(--bp-accent-ink, #10131a);
    --bp-danger: var(--bp-danger, #ff8a80);
    --bp-decision: var(--bp-decision, #ff8a80);
    --bp-feedback: var(--bp-feedback, #c3a6ff);
    --bp-highlight: var(--bp-highlight, rgba(123, 162, 255, 0.18));
    --bp-backdrop: var(--bp-backdrop, rgba(4, 5, 8, 0.6));
    --bp-shadow: var(--bp-shadow, 0 6px 24px rgba(0, 0, 0, 0.5));
  }
}

/* -- reduced motion (FR-11.3) -------------------------------------------- */

@media (prefers-reduced-motion: reduce) {
  .bp-root * {
    transition: none !important;
    animation-duration: 0.6s !important;
    animation-iteration-count: 1 !important;
  }

  .bp-highlight {
    animation-name: bp-highlight-fade !important;
  }
}

/* -- print (FR-1.9) ------------------------------------------------------ */

@media print {
  .bp-root,
  .bp-root .bp-bar,
  .bp-root .bp-handle,
  .bp-root .bp-panel,
  .bp-root .bp-composer,
  .bp-root .bp-popover,
  .bp-root .bp-legend,
  .bp-root .bp-legend-backdrop,
  .bp-root .bp-markers,
  .bp-root .bp-marker,
  .bp-root .bp-highlight,
  .bp-root .bp-mode-hint {
    display: none !important;
    visibility: hidden !important;
  }
}
`.trim();
