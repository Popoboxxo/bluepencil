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

Nothing is implemented yet; this is the concept and requirements baseline for milestone M1.
