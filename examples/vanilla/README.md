# Vanilla fixture — `examples/vanilla`

A small, deliberately ordinary dashboard that carries **every FR group of
[`docs/REQUIREMENTS.md`](../../docs/REQUIREMENTS.md) on one page**: headings, paragraphs, a list, a
table with cells, a form, links, a KPI/card grid, an element marked `[data-bp-ignore]` and one
element inside a web component with a shadow root.

It is the reproducible target for the unit/E2E suites (NFR-11) and the demo page: anything the
library claims has to be observable here, in a plain browser, without a build step of its own.

## What the fixture proves

| Area | Where to look | Requirements |
|---|---|---|
| Capture | click heading / paragraph / list item / table cell → composer | FR-1.3, FR-1.4 |
| Quote capture | select a few words, then annotate → the quote is stored | FR-1.5 |
| Anchoring | every annotatable element has a `data-bluepencil` hook; the shadow-DOM card needs `>>` | FR-2.1, FR-2.2, FR-12.4 |
| Presentation | panel list, counters, filters, markers | FR-4.1–4.8 |
| Collaboration | feedback-only mode, decision request/answer, threads | FR-5.1–5.6 |
| Export | the two export buttons in the strip use the public `export({ format })` | FR-7.1, FR-7.2 |
| Lifecycle | `enable()`/`disable()` via the switch, `destroy()` via the identity switch | FR-12.1, FR-12.2 |
| No host interference | links, form fields and the `[data-bp-ignore]` regions keep working while a mode is active | FR-2.7, FR-12.6 |
| Integration & theming | `enabled`, `identity`, `getRoute`, `canAnnotate`, `anchorHooks`, `theme`, `defaultShowDone`, `onError` are all set by the page | FR-10.2, FR-10.3, FR-12.8 |
| Local-first | the page makes no request except its own seed bundle | FR-9.4, NFR-7 |
| Size / footprint | the long-lived page is the manual check for "no polling, no residue" | NFR-1, NFR-2, NFR-15 |

## Files

| File | Purpose |
|---|---|
| `index.html` | the fixture page: design tokens (incl. `--bp-*` overrides) + dark mode, the app markup, the inline bootstrap |
| `app.js` | demo app logic, plain ES2022: KPI grid, table, shadow-DOM component, seed import, export, status/notice |
| `data/seed.bluepencil.json` | a small portable bundle (6 notes) that can be loaded into the store |
| `../../scripts/serve-example.mjs` | dependency-free static server for the repository root (port **9283**) |

No runtime dependency, no framework, no bundler, no inline event handler attributes (NFR-4,
NFR-6). All text is written with `textContent`, never `innerHTML` (FR-9.3).

## Smoke test — build, serve, open

```bash
# 1. build the library once (writes dist/ — the fixture loads dist/bluepencil.iife.js)
npm run build

# 2. serve the repository root on http://localhost:9283
node scripts/serve-example.mjs

# 3. open the fixture
#    http://localhost:9283/examples/vanilla/
```

The server has no dependencies and only serves the repository root — that is what makes
`/dist/bluepencil.iife.js` and `/examples/vanilla/` reachable from the same origin, which is the
whole reason the fixture needs no bundler.

Useful flags:

```bash
node scripts/serve-example.mjs --port 8080     # another port
node scripts/serve-example.mjs --root /srv/www # serve a different tree
node scripts/serve-example.mjs --once          # serve exactly one request, then exit (CI smoke)
node scripts/serve-example.mjs --help
```

A one-request smoke check looks like this:

```bash
node scripts/serve-example.mjs --once --quiet &
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9283/examples/vanilla/
wait   # --once exits by itself after that single request
```

## How the page loads bluepencil

```html
<script src="/dist/bluepencil.iife.js"></script>   <!-- classic IIFE build → window.bluepencil -->
<script> /* inline bootstrap: window.bluepencil.init({ … }) */ </script>
<script type="module" src="./app.js"></script>
```

The inline bootstrap is the **only** place the fixture configures the layer. It uses exactly the
public API of [`docs/INTERNAL-API.md`](../../docs/INTERNAL-API.md) §9:

```js
const blueprint = window.bluepencil.init({
  enabled: () => document.getElementById("demo-enable-flag").checked, // re-checked on every enable()
  adapter: "localStorage",
  sessionRef: "review-2026-09",
  environment: "dev",
  language: "en",
  buildRef: "demo-abc1234",
  mount: document.body,
  identity: { getUser: () => ({ name: authorName() }) },
  getRoute: () => location.pathname + location.search,
  canAnnotate: (node) => !node.closest("[data-bp-ignore]"),
  anchorHooks: ["data-bluepencil", "data-testid"],
  markerStrategy: "overlay",
  defaultShowDone: false,
  theme: { accent: "var(--demo-accent)", surface: "var(--demo-surface)", line: "var(--demo-line)" },
  onError: (err) => console.debug("[bluepencil-fixture]", err),
});
```

Two things are worth calling out:

* **The switch is the point.** The `bluepencil enabled` checkbox calls `enable()` / `disable()` on
  the running page — no reload, same store when it comes back (FR-12.1, D8). Unticking it is also
  the manual footprint check: no bar, no markers, no panel, no listeners (NFR-1).
* **The identity switch re-initialises.** `identity` is configuration, not runtime state, so the
  `Identity` select destroys the blueprint (`destroy()`) and bootstraps again with
  `getUser` / `"prompt"` / `"anonymous"` — the three modes of D3 in one page (FR-12.8). Notes
  survive, because the `localStorage` adapter holds them.

### Missing build → notice, not a broken page

`dist/` is git-ignored and does not exist before the first `npm run build`. The fixture then shows
a notice at the top ("bluepencil is not on this page yet", with the exact command to fix it), keeps
the page itself working and disables only the three controls that need the layer.

The classic tag above loads `dist/bluepencil.iife.js`. If that artifact is missing while the rest of
the build exists, `window.bluepencil` stays undefined — but `app.js` is itself a module, so it can
still load the **ES module entry** `/dist/bluepencil.js` (the very file `npm run build` writes for
bundler hosts) and hand that namespace to the inline bootstrap. The fallback is therefore a normal
load path of the same build, not a missing file: `/dist/bluepencil.js` *is* the ES module build and
`/dist/bluepencil.iife.js` *is* the classic one. Only when neither exists does the notice appear.

## Hook inventory (D6: `data-bluepencil` first, `data-testid` honoured)

Static markup in `index.html`:

`app-title`, `app-subtitle`, `link-fixture-readme`, `link-architecture`, `link-integration`,
`link-changelog`, `link-hint`, `section-kpis`, `kpi-intro`, `kpi-grid`, `section-findings`,
`findings-intro`, `findings-list`, `finding-item-1`, `finding-item-2`, `finding-item-3`,
`finding-item-3-detail`, `section-widget`, `widget-intro`, `section-table`, `table-intro`,
`findings-table`, `table-caption`, `section-form`, `form-intro`, `form-label-title`,
`form-label-area`, `form-label-severity`, `form-hint`, `section-shadow`, `shadow-intro`,
`footer-note`, `link-footer-readme`.

Rendered by `app.js`:

`kpi-total(-value)`, `kpi-open(-value)`, `kpi-decisions(-value)`, `kpi-feedback(-value)`,
`col-severity`, `col-area`, `col-owner`, `col-age`, `col-status`, `table-row-1..3`,
`table-cell-<row>-<column>` (`severity`, `area`, `owner`, `age`, `status`), and inside the shadow
root: `insight-title`, `insight-sub`, `insight-value`, `insight-unit`, `insight-note`.

Not annotatable on purpose: the whole fixture control strip (`#demo-toolbar`) and the embedded
widget section body — both marked `[data-bp-ignore]`; and the `Recalculate` button inside the
shadow root, which has no hook because interactive controls pass through in every mode.

## The seed bundle (`data/seed.bluepencil.json`)

Six notes, all in session `review-2026-09`, environment `dev`, anchored to hooks that exist in
this page:

| Note | Type | Intent | Status | Anchor | Shows |
|---|---|---|---|---|---|
| `n-seed-001` | text | implement | open | `finding-item-1` | the normal case an agent may implement |
| `n-seed-002` | text | implement | `needs_decision` | `insight-value` (in the shadow root) | decision request with options + a recommendation, plus a human reply that does *not* answer it |
| `n-seed-003` | design | implement | open | `kpi-decisions` | captured context: tag, classes, computed-style subset, box, scheme, viewport, build ref |
| `n-seed-004` | design | implement | `done` | `finding-item-2` | a finished note — invisible until done notes are revealed (D4) |
| `n-seed-005` | text | **feedback** | open | `findings-intro` | feedback-only: assessment requested, nothing may be changed (FR-5.1) |
| `n-seed-006` | text | implement | open | `table-cell-1-age` | a note written by tooling (`source: tool:test-runner`) incl. debug context (FR-13.3/13.5) |

**Load seed notes** in the strip imports it through the documented store API: every bundle note is
mapped back to a `NoteDraft` and written with `store.create()` (FR-13.1, FR-14.2). The import skips
ids that the store already knows, so clicking the button twice adds nothing the second time — the
same idempotence the `merge` mode promises (FR-14.3). Rejected notes are counted, not swallowed.

> **Ignore rule:** `.gitignore` excludes `*.bluepencil.json` repository-wide and re-includes exactly
> this file (`!examples/vanilla/data/seed.bluepencil.json`), so the seed is tracked while real review
> data stays out of the repository (NFR-13).

## Automated against this checklist

`npm run smoke:e2e` (`tests/e2e/vanilla.e2e.mjs`) walks the checklist below in a real browser
against the real build — including the seed import, the panel order, the shadow-DOM thread and the
byte-stability of the two exports. It is the same CDP harness the embed smoke uses, so no test
framework has to be installed. The list stays here because a reviewer checks more than a script can:
the *look* of the layer, the wording of a hint, the feel of a pick.

## Manual checklist

Run through this once per review round on `http://localhost:9283/examples/vanilla/`. Every line
names what must be observable, not what the code intends.

> **Before you start:** the layer's bar sits over this page's control strip at the top. Move or
> collapse the bar (its own control) before clicking *Load seed notes* / *Export* by hand — the
> E2E suite clicks those host buttons programmatically for exactly that reason.

1. **Annotate text** (FR-1.3) — `C` (or the bar) → click the `Release review console` heading → the
   composer opens with the anchor `app-title` → save → the note appears in the panel and as a
   marker on the heading. Repeat on a paragraph, a list item and a table cell.
2. **Annotate design** (FR-1.4) — `D` → click the `Decisions pending` card → save → open the note
   and check the captured state (tag, classes, style subset, box, scheme, viewport, build ref
   `demo-abc1234`). Then switch the OS/browser to dark mode and repeat: `scheme` records `dark`.
3. **Select a quote** (FR-1.5) — select three words inside a paragraph, then annotate the
   paragraph → the note stores exactly that text as its quote; the export prints it.
4. **Filter** (FR-4.2, FR-4.6) — `L` opens the panel; filter by type (`text`/`design`), intent
   (`implement`/`feedback`) and status. `needs_decision` sorts first, then feedback-only, then the
   rest. Counters in the KPI grid follow the store.
5. **Done notes are hidden by default** (FR-4.3, D4) — after loading the seed, `n-seed-004`
   (`finding-item-2`) has no marker and is absent from the list and the counters. Reveal it with
   the panel's one control; it must appear immediately.
6. **Settings** (FR-4.5) — open the settings surface, switch *show done notes*, change the author
   name, then hit *reset to defaults*. Reload the page: persisted values come back, reset values
   do not.
7. **Feedback-only mode** (FR-5.2) — `F` arms the flag, then create a note *in a mode* (`C` or `D`
   + pick) → it is `intent=feedback` without a second choice, is visually distinct, and lands in the
   export's `💬 feedback only` section. An agent must change nothing here (FR-5.7).
   **Note:** `F` alone does not pick anything — the layer only picks an element while a mode is
   armed (`mode === "off"` returns early), and the flag then forces the intent in the composer.
8. **Decision thread** (FR-5.4, FR-5.5) — open `n-seed-002` on the shadow-DOM card: the thread
   shows the human note, the agent's `decision_request` (options + recommendation) and a human
   reply. Answer it → the answer is stored as `kind=decision` and the status returns to `open`.
   Press `1`–`9` to jump between notes; the marker on the card must resolve inside the shadow root.
9. **Export Markdown / JSON** (FR-7.1, FR-7.2) — use both buttons in the strip. The Markdown file
   opens with `⚠ open decisions` and `💬 feedback only`, groups by route and prints quote, anchor,
   captured state and the full thread; the JSON file is a schema-versioned bundle that a script can
   parse without the library (NFR-19). Exporting twice unchanged must produce byte-identical files
   (NFR-10) — and leaving the focused element alone, identical to the previous round (NFR-17).
The checklist stops at nine: bulk delete is not in this build (see *Not in M1* below).

Two extras that are cheap to check while the page is open:

* **No host interference** (FR-2.7, FR-12.6) — with a mode active, click the nav links (they
  navigate), type in the form fields (they accept text), and click inside the `[data-bp-ignore]`
  strip and widget (nothing opens). `Recalculate` inside the shadow card still updates the number.
* **Lifecycle residue** (FR-12.2, NFR-1/NFR-15) — untick *bluepencil enabled*, inspect the DOM:
  the layer's nodes and its `<style>` are gone and there are no markers left. Tick it again, repeat
  a few times, then check that `Ctrl+P` preview shows no layer at all (FR-1.9).

## Not in M1

Nothing on this page offers these — do not go looking for a control that is not there:

* **Bulk delete** by filter with a confirm step (FR-8.2) — **M2, not implemented**. The store and
  every adapter already expose `bulkRemove(filter)`, but no UI surface is wired to it.
* **Session purge** (FR-3.4, FR-8.3) — **M2, not implemented**; the store can list a session's notes
  (`exportSession`), there is no delete path. **Retention** (FR-8.4) is **M4** and server-side only
  by decision D5: the browser layer never deletes notes on its own.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Notice "bluepencil is not on this page yet" | the build is missing — run `npm run build` and reload |
| Layer works although `/dist/bluepencil.iife.js` 404s | `app.js` loaded the ES module fallback `/dist/bluepencil.js` (see above) |
| Clicking does nothing | `enabled()` is false (untick/tick the switch) or the adapter failed on first load — check `onError` output |
| A note is marked *orphaned* | its element is gone or the hook was renamed — the hook list above is the contract |
| Nothing survives a reload | `localStorage` is unavailable (private mode) and the adapter fell back to `memory` (FR-6.2) |
| Port 9283 in use | `node scripts/serve-example.mjs --port 8080` |
| Notes you created polluting the demo | clear the site data for `localhost:9283`, or use a different port to get a fresh namespace |
