/**
 * Fixture app logic for the bluepencil vanilla example (`examples/vanilla`).
 *
 * Plain ES2022 — no framework, no runtime dependency, no bundler. Everything rendered here is
 * static demo data; the only requests the fixture ever makes are the seed bundle on the same
 * origin (`data/seed.bluepencil.json`) and whatever the annotation layer's adapter does
 * (`localStorage`, see the inline bootstrap in `index.html`).
 *
 * Repository conventions kept here:
 *   - user-visible text is written with `textContent` / text nodes, never `innerHTML` (FR-9.3);
 *   - no inline event handler attributes, every listener is added with `addEventListener` (NFR-6);
 *   - class names are prefixed `demo-` so they cannot collide with the layer's `bp-` prefix
 *     (ARCHITECTURE §7);
 *   - no timers, no polling (NFR-2).
 *
 * bluepencil integration: this module deliberately does *not* call `window.bluepencil.init()`.
 * The inline bootstrap in `index.html` owns the configuration (see `examples/vanilla/README.md`).
 * This module only uses the resulting instance — `window.bpDemo.blueprint` — to load the seed
 * bundle, export notes and render the counters. That is exactly the store/headless access an
 * integrating host has (FR-10.2, FR-13.2, FR-15.1).
 *
 * Hook contract: every annotatable element carries a stable `data-bluepencil` hook (D6). The
 * names used here are the ones the seed bundle anchors to — keep both sides in sync.
 */

/** Seed bundle: a portable bluepencil bundle, served from the fixture directory (FR-14.2). */
const SEED_URL = "./data/seed.bluepencil.json";

/** KPI cards. `key` matches the counter computed from the store (FR-4.8). */
const KPI_CARDS = [
  {
    key: "total",
    hook: "kpi-total",
    label: "Findings",
    fallback: 12,
    hint: "in this review round",
  },
  {
    key: "open",
    hook: "kpi-open",
    label: "Open",
    fallback: 7,
    hint: "ready to implement",
  },
  {
    key: "decisions",
    hook: "kpi-decisions",
    label: "Decisions pending",
    fallback: 1,
    hint: "blocked on a human answer",
    tone: "warn",
  },
  {
    key: "feedback",
    hook: "kpi-feedback",
    label: "Feedback only",
    fallback: 2,
    hint: "assessment requested",
    tone: "info",
  },
];

/** Findings table — head and body are rendered by this module, cells carry their own hooks. */
const TABLE_COLUMNS = [
  { label: "Severity", hook: "col-severity" },
  { label: "Area", hook: "col-area" },
  { label: "Owner", hook: "col-owner" },
  { label: "Age", hook: "col-age" },
  { label: "Status", hook: "col-status" },
];

const TABLE_ROWS = [
  {
    hook: "table-row-1",
    cells: [
      { hook: "table-cell-1-severity", text: "High" },
      { hook: "table-cell-1-area", text: "Export" },
      { hook: "table-cell-1-owner", text: "Unassigned" },
      { hook: "table-cell-1-age", text: "3 days" },
      { hook: "table-cell-1-status", text: "Open" },
    ],
  },
  {
    hook: "table-row-2",
    cells: [
      { hook: "table-cell-2-severity", text: "Medium" },
      { hook: "table-cell-2-area", text: "Search" },
      { hook: "table-cell-2-owner", text: "S. Ivers" },
      { hook: "table-cell-2-age", text: "2 days" },
      { hook: "table-cell-2-status", text: "In review" },
    ],
  },
  {
    hook: "table-row-3",
    cells: [
      { hook: "table-cell-3-severity", text: "Low" },
      { hook: "table-cell-3-area", text: "Reports" },
      { hook: "table-cell-3-owner", text: "M. Arendt" },
      { hook: "table-cell-3-age", text: "today" },
      { hook: "table-cell-3-status", text: "Feedback" },
    ],
  },
];

/** Shadow-root styles. Kept inside the component so the fixture also shows style encapsulation. */
const INSIGHT_CSS = `
:host { display: block; }
.demo-insight {
  display: grid;
  gap: 6px;
  padding: 16px;
  border: 1px solid var(--demo-line);
  border-left: 4px solid var(--demo-accent);
  border-radius: var(--demo-radius);
  background: var(--demo-surface);
  font-family: var(--demo-font);
  color: var(--demo-ink);
}
.demo-insight-title { margin: 0; font-size: 1rem; }
.demo-insight-sub { margin: 0; color: var(--demo-muted); font-size: .8125rem; }
.demo-insight-value { margin: 0; font-size: 2rem; font-weight: 600; }
.demo-insight-unit { margin: 0; color: var(--demo-muted); font-size: .875rem; }
.demo-insight-action {
  justify-self: start;
  font: inherit;
  font-size: .875rem;
  padding: .375rem .75rem;
  border: 1px solid var(--demo-line);
  border-radius: calc(var(--demo-radius) - 4px);
  background: var(--demo-surface-alt);
  color: var(--demo-ink);
  cursor: pointer;
}
.demo-insight-action:focus-visible { outline: 2px solid var(--demo-accent); outline-offset: 2px; }
.demo-insight-note { margin: 0; color: var(--demo-muted); font-size: .75rem; }
`;

/** Live state of the fixture (the blueprint instance comes from the inline bootstrap). */
const state = {
  blueprint: null,
  status: null,
  counters: new Map(),
  subscribed: false,
};

/* ------------------------------------------------------------------ DOM helpers ------------ */

/**
 * Create an element. Text is always passed as text, never parsed as HTML (FR-9.3).
 * @param {string} tag
 * @param {Record<string, unknown>} [attributes] `class`/`text`/`dataset` are handled specially.
 * @param {Array<Node|string>|Node|string} [children]
 * @returns {HTMLElement}
 */
function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key === "dataset") {
      for (const [dataKey, dataValue] of Object.entries(value)) {
        if (dataValue !== undefined && dataValue !== null) node.dataset[dataKey] = String(dataValue);
      }
    } else node.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === undefined || child === null || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/** `document.getElementById` with a clear failure instead of a null dereference. */
function pick(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`fixture markup is missing #${id}`);
  return node;
}

/* ------------------------------------------------------------------ rendering --------------- */

/** KPI/card grid (FR-10.3 — a realistic host layout the layer must not disturb). */
function renderKpiGrid() {
  const grid = pick("demo-kpi-grid");
  state.counters.clear();

  const cards = KPI_CARDS.map((card) => {
    const value = el("p", {
      class: "demo-kpi-value",
      text: String(card.fallback),
      "data-bluepencil": `${card.hook}-value`,
    });
    state.counters.set(card.key, value);
    return el(
      "article",
      {
        class: card.tone ? `demo-kpi demo-kpi--${card.tone}` : "demo-kpi",
        "data-bluepencil": card.hook,
      },
      [
        el("p", { class: "demo-kpi-label", text: card.label }),
        value,
        el("p", { class: "demo-kpi-hint", text: card.hint }),
      ],
    );
  });

  grid.replaceChildren(...cards);
}

/** Findings table — one hook per row and per cell, so anchoring can be exercised precisely. */
function renderFindingsTable() {
  const head = pick("demo-findings-head");
  const body = pick("demo-findings-body");

  head.replaceChildren(
    el(
      "tr",
      {},
      TABLE_COLUMNS.map((column) =>
        el("th", { scope: "col", "data-bluepencil": column.hook, text: column.label }),
      ),
    ),
  );

  body.replaceChildren(
    ...TABLE_ROWS.map((row) =>
      el(
        "tr",
        { "data-bluepencil": row.hook },
        row.cells.map((cell) =>
          el("td", { "data-bluepencil": cell.hook, text: cell.text }),
        ),
      ),
    ),
  );
}

/**
 * The insight card: a custom element with an **open shadow root**. The annotatable elements
 * live inside that shadow root, which is what FR-12.4 is about — the layer has to evaluate
 * clicks on `event.composedPath()` and encode the shadow boundary in the anchor path.
 * The button intentionally carries no hook: interactive controls pass through in every mode
 * (FR-1.9, FR-12.6), and it keeps working while an annotation mode is active.
 */
class DemoInsightCard extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = INSIGHT_CSS;
    root.append(style, buildInsightCard(recalculateInsight));
  }
}

/** Counts the local recalculations across both rendering paths (shadow root and fallback). */
let insightRecalculations = 0;

/** Demo click handler — proves the host's own events still fire while the layer is attached. */
function recalculateInsight({ value, note }) {
  insightRecalculations += 1;
  value.textContent = String(128 + insightRecalculations);
  note.textContent = `Recalculated ${insightRecalculations}× locally — the host's own click handler ran while the layer was attached.`;
}

/**
 * Build the insight card markup. The same builder is used inside the shadow root and in the
 * light-DOM fallback, so the hooks stay identical in both paths. The callback is wired with
 * `addEventListener` — never with an inline handler attribute (NFR-6).
 * @param {(targets: { value: HTMLElement; note: HTMLElement }) => void} onRecalculate
 * @returns {HTMLElement}
 */
function buildInsightCard(onRecalculate) {
  const value = el("p", { class: "demo-insight-value", "data-bluepencil": "insight-value", text: "128" });
  const note = el("p", {
    class: "demo-insight-note",
    "data-bluepencil": "insight-note",
    text: 'Annotatable inside the shadow root — the stored selector encodes the boundary with " >> ".',
  });
  const button = el("button", { type: "button", class: "demo-insight-action" }, "Recalculate");
  button.addEventListener("click", () => onRecalculate({ value, note }));

  return el("article", { class: "demo-insight", part: "card" }, [
    el("h3", { class: "demo-insight-title", "data-bluepencil": "insight-title", text: "Ticket throughput" }),
    el("p", { class: "demo-insight-sub", "data-bluepencil": "insight-sub", text: "Rolling 7 days · helpdesk queue" }),
    value,
    el("p", { class: "demo-insight-unit", "data-bluepencil": "insight-unit", text: "tickets resolved" }),
    button,
    note,
  ]);
}

/** Mount the shadow-DOM card (with a graceful light-DOM fallback, NFR-5). */
function renderInsightCard() {
  const host = pick("demo-shadow-host");
  host.replaceChildren();

  const supported =
    typeof window.customElements?.define === "function" &&
    typeof Element.prototype.attachShadow === "function";

  if (!supported) {
    host.append(
      el("p", {
        class: "demo-note",
        text: "This browser has no custom elements / shadow DOM — the card is rendered in the light DOM instead, with the same hooks.",
      }),
      buildInsightCard(recalculateInsight),
    );
    return;
  }

  if (!window.customElements.get("demo-insight-card")) {
    window.customElements.define("demo-insight-card", DemoInsightCard);
  }
  host.append(el("demo-insight-card"));
}

/* ------------------------------------------------------------------ store access ------------ */

/** Counters in the card grid mirror the store after every change (FR-4.8, FR-13.2). */
function renderCounters(notes) {
  const list = Array.isArray(notes) ? notes : [];
  const counts = {
    total: list.length,
    open: list.filter((note) => note.status === "open").length,
    decisions: list.filter((note) => note.status === "needs_decision").length,
    feedback: list.filter((note) => note.intent === "feedback").length,
  };
  for (const card of KPI_CARDS) {
    const node = state.counters.get(card.key);
    if (node) node.textContent = String(counts[card.key]);
  }
}

/** Subscribe once — `subscribe` fires immediately with the current list (INTERNAL-API §2). */
function subscribeToStore(blueprint) {
  const store = blueprint?.store;
  if (state.subscribed || !store || typeof store.subscribe !== "function") return;
  store.subscribe((notes) => renderCounters(notes));
  state.subscribed = true;
}

/**
 * Map a note from the bundle back to a note draft so it can be written through the store —
 * the documented path for a host that wants to import a portable bundle (FR-14.2/FR-13.1).
 * @param {Record<string, any>} note
 * @returns {Record<string, unknown>}
 */
function toDraft(note) {
  const draft = {
    id: note.id,
    type: note.type,
    body: note.body,
    anchor: note.anchor,
    context: note.context ?? null,
    now: note.createdAt,
    messages: Array.isArray(note.messages) ? note.messages : [],
  };
  for (const key of [
    "intent",
    "status",
    "author",
    "authorType",
    "sessionRef",
    "source",
    "environment",
    "ticketRef",
    "debug",
  ]) {
    if (note[key] !== undefined) draft[key] = note[key];
  }
  return draft;
}

/** Import the seed bundle. Idempotent by note id, and it reports exactly what happened. */
async function loadSeed() {
  const store = state.blueprint?.store;
  if (!store || typeof store.create !== "function") {
    say("bluepencil is not loaded — build the library first, then reload the page.", "warn");
    return;
  }

  say("Loading the seed bundle …");
  let bundle;
  try {
    const response = await fetch(SEED_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bundle = await response.json();
  } catch (err) {
    say(`Could not load ${SEED_URL} (${err.message}).`, "warn");
    return;
  }

  const notes = Array.isArray(bundle?.notes) ? bundle.notes : [];
  if (notes.length === 0) {
    say(`${SEED_URL} contains no notes.`, "warn");
    return;
  }

  const known = new Set((store.notes() ?? []).map((note) => note.id));
  let added = 0;
  let skipped = 0;
  let rejected = 0;

  for (const note of notes) {
    if (known.has(note.id)) {
      skipped += 1;
      continue;
    }
    try {
      await store.create(toDraft(note));
      known.add(note.id);
      added += 1;
    } catch (err) {
      rejected += 1;
      console.debug("[bluepencil-fixture] seed note rejected", note.id, err);
    }
  }

  const parts = [`seed: ${added} added`, `${skipped} already present`];
  if (rejected > 0) parts.push(`${rejected} rejected by the schema`);
  say(`${parts.join(", ")} — ${notes.length} note(s) from ${bundle.app?.name ?? "the bundle"}.`, rejected > 0 ? "warn" : "ok");
}

/** Export the current note set through the public API and download it (FR-7.1/7.2). */
function exportNotes(format) {
  const blueprint = state.blueprint;
  if (!blueprint || typeof blueprint.export !== "function") {
    say("bluepencil is not loaded — nothing to export yet.", "warn");
    return;
  }

  let text;
  try {
    text = blueprint.export({ format });
  } catch (err) {
    say(`Export failed: ${err.message}`, "warn");
    return;
  }

  const isJson = format === "json";
  const name = `bluepencil-fixture-${timestamp()}.${isJson ? "json" : "md"}`;
  download(name, isJson ? "application/json" : "text/markdown", text);
  say(`Downloaded ${name} (${text.length} characters).`, "ok");
}

function download(filename, type, text) {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/* ------------------------------------------------------------------ layer status ------------ */

/** Write a message into the page's live region (NFR-14: one inline message, never a broken page). */
function say(message, tone = "info") {
  const output = document.getElementById("demo-message");
  if (!output) return;
  output.textContent = message;
  output.dataset.tone = tone;
}

/** Enable or disable the controls that need the layer, with a reason in the tooltip. */
function setControlsEnabled(enabled, reason) {
  for (const id of ["demo-load-seed", "demo-export-md", "demo-export-json"]) {
    const button = document.getElementById(id);
    if (!button) continue;
    button.disabled = !enabled;
    if (enabled) button.removeAttribute("title");
    else button.setAttribute("title", reason);
  }
}

/** Explain a missing build instead of leaving a dead page (the fixture's degradation path). */
function showBuildNotice(reason) {
  const notice = pick("demo-build-notice");
  notice.hidden = false;
  notice.replaceChildren(
    el("h2", { text: "bluepencil is not on this page yet" }),
    el("p", {
      text:
        reason === "init-failed"
          ? "The library loaded but its init() call failed. The fixture page itself still works; only the annotation layer is missing."
          : "The script /dist/bluepencil.js could not be loaded and no module build was found either. The fixture page itself still works; only the annotation layer is missing.",
    }),
    el("p", {}, [
      el("span", { text: "Fix it with " }),
      el("code", { text: "npm run build" }),
      el("span", { text: " in the repository root, then reload this page — the example server serves the repository root, so " }),
      el("code", { text: "/dist/bluepencil.js" }),
      el("span", { text: " becomes reachable." }),
    ]),
    el("p", { class: "demo-note", text: "Until then the demo controls below are disabled; the layout, the table and the shadow-DOM card keep working normally." }),
  );
}

/** Render the status the inline bootstrap published (and every later enable()/disable()). */
function applyStatus(status) {
  state.status = status ?? { available: false, reason: "missing-bootstrap" };
  const available = state.status.available === true;
  state.blueprint = available ? (state.status.blueprint ?? null) : null;

  const stateLine = document.getElementById("demo-layer-state");
  if (stateLine) {
    if (!available) {
      stateLine.textContent = "layer: not loaded";
      stateLine.dataset.state = "missing";
    } else if (state.status.enabled) {
      const adapter = state.blueprint?.store?.adapterName;
      stateLine.textContent = `layer: enabled${adapter ? ` · adapter: ${adapter}` : ""} · press C for text mode, D for design mode`;
      stateLine.dataset.state = "on";
    } else {
      stateLine.textContent = "layer: disabled — tick the switch to call enable() without a reload";
      stateLine.dataset.state = "off";
    }
  }

  if (available) {
    pick("demo-build-notice").hidden = true;
    setControlsEnabled(true);
    subscribeToStore(state.blueprint);
  } else {
    setControlsEnabled(false, "bluepencil is not loaded — run npm run build and reload");
    showBuildNotice(state.status.reason);
  }
}

/**
 * The fixture loads the classic script `/dist/bluepencil.js`. If that path holds an ES module
 * (which is what `scripts/build.mjs` currently emits — the IIFE lives in
 * `dist/bluepencil.iife.js`), a classic script tag cannot parse it and `window.bluepencil`
 * stays undefined. This module is a module, so it can still load the very same file and hand
 * the namespace to the bootstrap. When the build has not run at all, both paths fail and the
 * fixture shows its notice above.
 */
async function ensureBlueprintApi() {
  if (window.bpDemo?.available) return;
  try {
    const module = await import("/dist/bluepencil.js");
    if (module && typeof module.init === "function") {
      window.bluepencil = module;
      if (typeof window.bluepencilBootstrap === "function") window.bluepencilBootstrap();
    }
  } catch (err) {
    console.debug("[bluepencil-fixture] no module build at /dist/bluepencil.js", err);
  }
}

/* ------------------------------------------------------------------ boot -------------------- */

function wireControls() {
  pick("demo-load-seed").addEventListener("click", () => {
    loadSeed().catch((err) => say(`Seed import failed: ${err.message}`, "warn"));
  });
  pick("demo-export-md").addEventListener("click", () => exportNotes("markdown"));
  pick("demo-export-json").addEventListener("click", () => exportNotes("json"));

  // The fixture form is a decoration with real controls: it never submits anywhere (NFR-7).
  const form = document.getElementById("demo-findings-form");
  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      say("Form handled locally — the fixture posts nothing, and the fields stayed operable with the layer attached.", "info");
    });
  }
}

async function boot() {
  renderKpiGrid();
  renderFindingsTable();
  renderInsightCard();
  wireControls();

  // The bootstrap re-publishes this event after every enable()/disable() and after a rescue.
  document.addEventListener("bp-demo-status", (event) => applyStatus(event.detail));

  await ensureBlueprintApi();
  applyStatus(window.bpDemo ?? { available: false, reason: "missing-bootstrap" });
}

/**
 * Small, documented test surface for the Playwright E2E suite (ARCHITECTURE §9) — the fixture
 * is the reproducible target for every FR group, so the suite needs a stable way to drive it.
 */
window.demoFixture = {
  loadSeed,
  exportNotes,
  state,
};

boot().catch((err) => {
  console.debug("[bluepencil-fixture] boot failed", err);
  say(`The fixture app could not start: ${err.message}`, "warn");
});
