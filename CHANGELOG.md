# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · Versioning: [SemVer](https://semver.org/).

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
