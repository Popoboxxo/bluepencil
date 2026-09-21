# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · Versioning: [SemVer](https://semver.org/).

## [0.2.0] - 2026-09-21

The first release without an alpha suffix. Both changes come from a real review round against an
embedded deployment rather than from reading the code: a reviewer's notes were reported as
*orphaned* although nothing was wrong with them, and the exported bundle could not say which app
it had come from. Neither change alters an existing contract — an anchor of an element that is
always visible serialises byte-identically, and the bundle defaults stay `"unknown"`.

### Added
- **Transient container reveal (issue #20).** A target that only exists in a transient UI state
  (a closed dialog or popover, an inactive tab, a collapsed menu) used to be unreachable: hook,
  CSS path *and* quote all fail in the default state of the very route it was captured on, so the
  panel said "not findable". `captureReveal` now records the container's kind and the element that
  opens it — the host's explicit `data-bluepencil-reveal`, a native `popovertarget`, the
  `role="tab"` of a tabpanel, or any element with `aria-controls` — and
  `revealAnchor`/`revealAnchorDetailed(anchor)` activates that trigger, waits for the host to
  settle and resolves again. Two attempts, because the first click can *close* a container that
  happened to be open; a resolution is still never invented, and the panel distinguishes "behind a
  closed container" from "unreachable". The hint travels as the new `reveal` field on the anchor
  (validated, canonically ordered, migrated for older documents).
- **Resolution strategy reported (FR-2.1).** `resolveAnchorDetailed` returns which fallback matched
  (`hook`, `selector` or `quote`), so a host can measure how much of its anchor set still resolves
  through the intended hook instead of the text fallback.
- **Bundle metadata from a tag-embedded host (issue #21).** `app`, `build-ref` and `exported-by`
  are element and loader attributes now and fill `app.name`, `app.buildRef` and `exportedBy` of an
  exported bundle; `build-ref` doubles as `context.buildRef` for design notes, so a host declares
  its build once. The layer also stamps the environment it was configured with into the export, so
  a `live` deployment no longer exports `"dev"`.

### Changed
- **Core bundle budget raised from 31 kB to 33 kB (NFR-3)**, measured at 31.9 kB gzip for the
  reveal capability and the bundle metadata. The reason is recorded in the guard header and in the
  requirement row, as before, so the number reads as a decision and not as drift.

### Fixed
- Notes anchored to elements inside a closed dialog, popover or inactive tab are no longer reported
  as orphaned. Measured on the real review round: 4 of 7 anchors of one session were unresolvable
  in the default DOM state of their own route (issue #20).

### Verified
- 503 unit tests in 20 files, typecheck, build, size guard, CLI/MCP/packaging smoke and the
  browser legs of the embed smoke (14 cases, real Chrome).

### Known gaps
- Not on npm yet: install from the tag (`npm i github:Popoboxxo/bluepencil#v0.2.0`) or use the
  attached build artefacts.
- The sidecar data-access work (`GET {base}/notes/{id}`, refusing unknown create fields, the actor
  in the journal) is **not** part of this release — it is still on `feat/sidecar-data-access`
  (PR #23).
- No Playwright E2E suite against the fixture; the browser round is covered by the embed smoke and
  the manual checklist in `examples/vanilla/README.md`.
- Still pre-1.0: the adapter wire formats and the journal file layout may change between minor
  releases; the API freezes at 1.0.0.

## [0.1.0-alpha.2] - 2026-09-17

The alpha that makes the documented paths true. Everything here was found by running the library
against a real host application rather than by reading it — including three bugs that only showed up
there. Nothing in this release changes an existing contract: `prompt`/`anonymous` identity, the
existing attributes and the layer API behave as before.

### Fixed
- **The documented one-tag embedding actually embeds (issue #11).** `<script src="…/attach.js">` with no
  `data-*` attribute at all never attached: script discovery required at least one known key, so the
  path the guide recommends was silently inert — no error, no console note. Scripts are now recognised
  by their source as well, and `bluepencilAttach.check()` re-scans the document, so a tag injected
  after `DOMContentLoaded` (SPA bootstrap, nginx, CMS) is picked up without a reload.
- **`identity` accepts a global path (issue #12).** A host wired through the tag can now pass its real
  user: `identity="myApp.identity"` resolving to `{ getUser() }`, exactly like `gate`, `route-from` and
  `headers-from`. Every note used to be attributed to `prompt` because the tag could not express this.
- **Links stay links while annotating.** Not a new behaviour, but it had no test: a click on `a[href]`
  follows its target in every mode instead of opening the composer. It is pinned now, with a
  falsification, so it cannot regress quietly.

### Added
- **The host's own target vocabulary (FR-1.12, issue #3).** `annotate-selectors=".card, .tile"` makes
  the nearest match in the click path the annotation target — in text *and* design mode, so the anchor
  is the component and not the heading inside it. `can-annotate="myApp.canAnnotate"` is the per-element
  veto. A component whose text lives in children is no longer silently inert.
- **One shortcut registry (FR-1.11, issue #4 finding 3).** The key handler dispatches from it, the help
  legend renders from it; a shortcut cannot exist in one and not the other, and a divergence fails a
  test. The prototype accepted `0–6` while nine chapters were reachable and its legend advertised `0–6`.
- **Configurable keymap (FR-12.11, issue #4 finding 8).** `keymap="bar=g, panel=p"` remaps shortcuts;
  the legend follows. Conflicts, unknown ids and keys that cannot be remapped (the `1…9` range, the
  composer-scoped save) are reported through `element.issues` instead of "last one wins".
- **Runtime chrome levels (FR-12.9, issue #4 finding 1).** `full` / `quiet` / `off` via
  `setChrome()`, the `h` shortcut or the host attribute; the choice is persisted, and `off` is
  deliberately not `disable()` — annotations and markers stay, only the layer's own controls go.
- **Addressable chrome state (FR-12.12, issue #4 finding 9).** `?bp-chrome=quiet` sets the level for one
  load and is never written back — for screenshots, QA runs and handovers.
- **Chrome slots, docking and the narrow rule (FR-12.10, FR-12.13, NFR-20, issue #4 findings 2/4/10).**
  Every surface declares its slot, so "no two surfaces overlap" is a property of the stylesheet;
  `dock="top"|"bottom"` moves the strip and its handle to the chosen edge and the mode hint to the
  opposite one; below 720 px the strip yields to its handle on its own and returns when the viewport
  grows. Verified by a new mandatory browser leg that measures boxes, overlap area and `scrollWidth`
  across 360/390/768/1024/1280/1440 px — in real windows, one Chrome per viewport.

### Changed
- **Core bundle budget raised from 30 kB to 31 kB (NFR-3).** The host-facing capability set above added
  real code (measured 30.5 kB gzip, 101.7 % of the old line). The reason is recorded in the guard
  header and in the requirement row, so the number reads as a decision and not as drift.
- **CI: the browser leg retries the Chrome launch** (three attempts, fresh profile each, still
  fail-closed) and reports an unusable browser as `BROWSER-UNAVAILABLE` instead of looking like a
  failed assertion (issue #18). A runner hiccup used to fail a run for an unchanged commit.

### Known gaps in this alpha
- No npm publish: install from the tag (`npm i github:Popoboxxo/bluepencil#v0.1.0-alpha.2`) or use the
  attached build artefacts.
- The geometry leg needs a Chrome that can be *started*; if the environment cannot provide one, the run
  fails with `BROWSER-UNAVAILABLE` and says so — it skips nothing.
- Still an alpha: the adapter wire formats and the journal file layout may change between alphas.

## [0.1.0-alpha.1] - 2026-09-17

First release. Everything listed here is built, tested and green; the known gaps are listed with it
rather than left to be discovered.

### Added
- **One-tag embedding (FR-17):** `attach.js` plus `<bluepencil-notes>` — no build step in the host and
  no JavaScript to write. Configuration lives in attributes: remote store (`endpoint`, `headers`,
  `headers-from`, `token`, `token-header`, `token-scheme`), routing (`route`, `route-from`), host gate
  (`gate`), theming (`theme`, `theme-accent`, `theme-surface`), manifest-driven runtime updates
  (`data-manifest`, `data-integrity`, `data-watch`) and the `window.bluepencilAttach` surface.
- **Store journal (FR-18):** every accepted mutation is recorded — as a coalesced commit inside the
  git work tree, as a hash-chained `journal.jsonl` without git, or not at all (`--journal none`).
  `GET {base}/journal?since=<seq>` answers "what changed since my last round" for agents. The commit
  identity is configurable (`--journal-author`, `BLUEPENCIL_JOURNAL_AUTHOR`) and reported in the
  journal status.
- **The version is visible everywhere (FR-19):** `data-bp-version` on the element,
  `window.bluepencilAttach.version`, `attach-version`, the sidecar's `/health` and `--version`, the
  CLI and the MCP handshake — one source, `package.json`.
- Examples for both embedding paths (`examples/presentation`, `examples/attach` with a self-test
  probe) and the sidecar's static mode, so one origin serves the page and the API.

### Changed
- `route-from` calls the host function with the annotated element (`fn(element)`), so a note's route
  belongs to that note instead of to whatever happens to be scrolled into view. `route="url"` and
  zero-parameter hosts behave exactly as before.
- The journal's commit is path-limited (`git add -- <paths>`, `git commit --only -- <paths>`): work
  somebody else staged in the same work tree can no longer ride along in a notes commit.

### Verified
- 444 unit tests in 18 files, typecheck, build, size guard, CLI/MCP/packaging smoke, secret scan.
- Embed smoke in a real browser: 13 cases, and the browser leg is mandatory in CI — a missing browser
  fails the job instead of skipping silently.
- Run against a real third-party SPA (ReqogniLoom, React 18 + Vite build): layer mounted, note
  round-trip against the sidecar answered 200, zero console errors, zero long tasks. That run is also
  where the two gaps below were found.

### Not in this alpha
- PR #10 (configurable `anchor-hooks` attribute) is not merged yet, so it is not part of this tag.
  The release commit is cut from `main` and reaches it through the release PR — only what is on `main`
  is released, which is exactly why the unmerged feature is absent.
- `can-annotate` is a library-only option without an attribute — the same class as issue #12.

### Known gaps (documented, not hidden)
- [#11](https://github.com/Popoboxxo/bluepencil/issues/11) — a loader tag injected after
  `DOMContentLoaded` stays silent, even after `check()`; the module path works.
- [#12](https://github.com/Popoboxxo/bluepencil/issues/12) — `identity` accepts no global path, so a
  tag-wired host cannot hand over its user and notes fall back to `"prompt"`.

## [Unreleased]

### Added
- `docs/CONCEPT.md` — problem statement, users, use cases, core concepts (note, anchor,
  context, intent, status, thread, session), anchoring strategy, deployment modes, agent
  collaboration model, non-goals, risks, roadmap M0–M6.
- `docs/REQUIREMENTS.md` — 60 functional requirements in eleven groups plus 14 non-functional
  requirements, each with priority (MoSCoW), target milestone and acceptance criteria, and a
  traceability table separating proven behaviour, known gaps and product-driven needs.
- `docs/ARCHITECTURE.md` — planned repository layout, public API sketch, TypeScript data model,
  adapter contract, HTTP contract for the reference server, bookmarklet design, theming rules,
  test strategy, release plan.
- `docs/PROTOCOL.md` — normative human/agent collaboration rules: how to implement, how to ask
  for a decision (with options and a recommendation), how to report, definition of done, hard
  prohibitions.
- `docs/INTEGRATION.md` — integration modes (embedded, local-only, bookmarklet, self-hosted,
  admin debug mode), host hooks, theming tokens, security and privacy notes, troubleshooting.
- `README.md` — project summary, name origin, non-negotiables, documentation index.

### Changed
- All eight open decisions resolved (recorded in `docs/REQUIREMENTS.md` § *Decisions* and
  `docs/ARCHITECTURE.md` §10b): one package, overlay markers, config-driven identity,
  configurable done-note default, retention server-side only, `data-bluepencil` +
  `data-testid`, retention defaults 90/180 days, **runtime activation as the primary use**.

### Added
- `FR-12` — runtime lifecycle and host variety: `enable()`/`disable()` with complete, idempotent
  teardown, mount scope and multiple instances, shadow-DOM-aware capture and anchoring,
  custom-element packaging, non-interference with host events, documented host variety.
- `NFR-15` (runtime parity) and `NFR-16` (three packaging forms: ESM dependency, standalone ES
  module resource, single-file IIFE/bookmarklet).
- `docs/ARCHITECTURE.md` §6b (lifecycle, shadow DOM, instances) and §6c (packaging matrix),
  custom-element build and Home Assistant example in the planned layout.
- `docs/CONCEPT.md` UC-9 (switching the layer on inside a product at runtime).

### Added (second review round)
- **FR-13** dev systems: the layer reads *and* writes during debugging — headless write API,
  note origin/source (`ui:human`, `agent`, `tool:test-runner`, …), optional dev auto-attach,
  debug context (stack trace, failing test, commit) and optional `file:line` references.
- **FR-14** live systems and exchange: environment tagging (`dev`/`staging`/`live`), portable
  export bundles, import with `merge`/`upsert`/`replace-session`, dry-run with
  added/updated/skipped/conflicts, round-trip fidelity, admin-only + audited in live systems,
  deliberate promotion between environments.
- **FR-15** headless data library and CLI (`bluepencil/data`, `bluepencil/cli`): read, write,
  merge, validate and inspect note sets without a browser; single source of truth for UI,
  server, CLI and MCP.
- **NFR-17** canonical diffable bundles · **NFR-18** environment isolation by default ·
  **NFR-19** interoperability without the tool.
- `docs/ARCHITECTURE.md` §5b (bundle format, merge semantics, environment rules) and §5c
  (headless library and CLI); planned `src/data/`, `src/cli/`, `examples/round-trip/`.
- `docs/CONCEPT.md` UC-10 (debugging with tool-written notes), UC-11 (notes travel between
  environments) and §5b “How notes travel”.
- `docs/PROTOCOL.md` §8: environment and exchange rules for humans and agents.
- Decisions D9 (dev systems read/write) and D10 (live integration + headless exchange library)
  recorded.

The documents above are the concept and requirements baseline for milestone M1; implementation
status per milestone is tracked in the version sections below.

## [0.1.0] — 2026-09-15

M1 implementation baseline on `feat/m1-core-ui-adapters`: model, anchoring, capture, store and
adapters, the headless data library, the exports, the collaboration protocol, the review layer, the
public API and the custom element, the CLI, the MCP server and the vanilla fixture are all in this
branch. What is *not* in it is listed under **Not yet**.

### Added
- `src/core/model.ts` — the frozen data model: note, message, anchor and captured-context types,
  the vocabulary (`text`/`design`, `implement`/`feedback`, `open`/`done`/`needs_decision`),
  note sources, debug context, schema version, bundle shape and the validation error class.
- `src/core/anchor.ts`, `src/core/capture.ts`, `src/core/adapter.ts`, `src/core/store.ts` — anchor
  resolution (host hook → CSS path → text quote, shadow boundaries encoded in the path), the curated
  element capture for design notes, the adapter contract and the store that owns sessions,
  environment and validation.
- `src/adapters/` — the four built-in adapters (`memory`, `localStorage`, `file`, `http`) behind one
  contract, covered by a single parameterised conformance suite (`tests/unit/adapters.test.ts`).
- `src/data/` — the DOM-free data library (`bluepencil/data`): schema and validators, canonical
  (diffable) bundles, the merge modes `merge` / `upsert` / `replace-session` with dry-run conflict
  reporting, and migrations for older documents.
- `src/core/export/` — the Markdown export (exception sections first, grouped by route, full
  threads) and the schema-versioned JSON export.
- `src/core/protocol.ts` — the collaboration protocol as code: intents, statuses, message kinds and
  the guards that keep a pending decision from being marked done.
- `src/ui/` — the review layer: bar, handle, markers, panel with filters, composer, settings and
  legend, all switchable at runtime with complete, idempotent teardown.
- `src/i18n/` — the `en`/`de` message tables and the lookup every surface uses.
- `src/index.ts` — the public API (`init`, `mount`, `createBlueprint`, `VERSION`) plus the
  `enable()` / `disable()` / `setEnabled()` / `export()` / `destroy()` handle.
- `src/element/index.ts` — the `<bluepencil-notes>` custom element (attributes and events) for hosts
  that load one ES module resource and have no build step (FR-12.5).
- `src/cli/bin.ts` — the CLI: `inspect`, `validate`, `notes`, `export`, `merge`, `import`, `mcp`,
  `demo`, with pipeline-meaningful exit codes (0 ok, 1 usage, 2 conflicts, 3 environment mismatch,
  4 invalid input).
- `src/mcp/tools.ts`, `src/mcp/server.ts` — the MCP server over stdio: nine tools, three resources
  and two prompts, **read-only by default**, bound to one store, one app and one environment.
- `scripts/build.mjs` — one source tree, several artifacts (NFR-16): `dist/bluepencil.js` (the ESM
  package entry), `dist/bluepencil.iife.js` (classic script / bookmarklet, global `bluepencil`),
  `dist/bluepencil.element.js` (custom element), `dist/cli.js`, `dist/mcp.js`, the subpath entries
  `dist/data.js`, `dist/adapters/*.js`, `dist/i18n/*.js` and the declarations in `dist/types/**`.
- `tests/unit/` — the unit suite: model, anchoring, capture, adapters (shared conformance suite),
  store, bundles and migrations, merge, exports, protocol and the UI layer.
- `docs/HERMES.md` — the MCP/Hermes integration: the wrapper registration, environment binding, the
  read-only default and the CLI paths.
- `examples/vanilla/` — the fixture app: a small dashboard that carries **every requirement group
  on one page** (headings, paragraphs, list, table with cells, form, links, KPI/card grid, one
  element inside a web component with a shadow root), a stable `data-bluepencil` hook on every
  annotatable element, a design-token style block with `--bp-*` overrides and a dark-mode media
  query, and a runtime on/off switch calling `enable()`/`disable()` without a reload. It degrades
  with an on-page notice instead of a broken page when the build has not run
  (`dist/bluepencil.iife.js`, with the module fallback on `dist/bluepencil.js`).
- `examples/vanilla/app.js` — the fixture's demo logic, plain ES2022, no dependencies: KPI grid,
  table, shadow-DOM component, seed import through the documented store API, and Markdown/JSON
  export through `bp.export({ format })`.
- `examples/vanilla/data/seed.bluepencil.json` — a portable 6-note bundle for the fixture: one
  `needs_decision` with a decision thread, one feedback-only note, one design note with captured
  context, one `done` note, one note written by tooling (source + debug context) and one plain
  open note; anchored to hooks that exist on the fixture page.
- `examples/vanilla/README.md` — smoke commands, the hook inventory, the seed-bundle table and the
  manual checklist for a review round (annotate text/design, quote, filter, done-hidden default,
  settings, feedback-only mode, decision thread, export Markdown/JSON).
- `scripts/serve-example.mjs` — dependency-free static server for the repository root on port
  9283, so `/dist/bluepencil.iife.js` and `/examples/vanilla/` share one origin. Flags: `--port`,
  `--root`, `--once` (serve one request and exit, for CI smoke tests), `--quiet`, `--help`.
- `README.md` — *Quick start*: build, serve, open the fixture, plus the one-line host integration
  and the runtime `enable()`/`disable()`/`export()`/`destroy()` handle.

### Changed
- `README.md` status line and documentation index: M1 is in progress instead of "no code yet";
  `docs/INTERNAL-API.md` and the fixture README are indexed.

### Not yet

- A Playwright E2E suite against the fixture (NFR-11, M1) — the browser round is covered by the
  manual checklist in `examples/vanilla/README.md` until it lands.
- A reference server implementing the documented HTTP contract (ARCHITECTURE §5, M2). The HTTP
  adapter speaks that contract and its endpoints are listed in `src/adapters/http.ts`; there is no
  server in this repository to speak to.
- An import surface in the UI (FR-14.7, M2). The merge modes themselves (FR-14.3) exist in the data
  library, the CLI and MCP; the browser layer exports but does not import yet.
- Bulk delete by filter with a confirm step (FR-8.2, M2) and a one-action session purge
  (FR-8.3, M2); the store already exposes `bulkRemove(filter)`, no UI control is wired to it.
- Retention of done notes (FR-8.4, M4) — server-side only by decision D5; the browser library never
  deletes on its own.
- i18n beyond `en`/`de` (FR-11.1, M6).
