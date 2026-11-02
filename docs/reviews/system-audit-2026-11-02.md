# System Audit — bluepencil (2026-11-02)

- **Scope:** repository `bluepencil` at version `0.11.6` (`package.json`, `extension/manifest.json`), branch `chore/system-audit`. Covers `src/`, `server/`, `extension/src/`, `scripts/`, `docs/`, `spec/`, CI workflows.
- **Method:** audit only, no code changes. Static reading of source and docs, cross-checks against `CLAUDE.md`, `docs/ARCHITECTURE.md` and `docs/REQUIREMENTS.md`, grep-based dependency/caller analysis, and a read-only run of `node scripts/size-guard.mjs` against the existing `dist/`. Each finding was verified against the code; claims are reproducible by re-reading the cited lines.
- **Severity scale:**
  - **critical** — data loss, security breach or broken release; fix before any merge.
  - **high** — violates a normative project rule or requirement; fix in the current cycle.
  - **medium** — real drift or defect with limited impact; schedule a fix.
  - **low** — hygiene / maintainability; fix opportunistically.
- **Finding ID scheme:** `BP-nn` Best Practices, `SEC-nn` Security, `CQ-nn` Code Quality. IDs are stable once published.

---

## 1. Best Practices

### Findings

#### BP-01 — FR-17 … FR-20 are cited in code and docs but not defined in REQUIREMENTS.md
- **Severity:** high
- **Location:** `docs/REQUIREMENTS.md` (sections jump from `## FR-16` at line 227 to `## FR-21` at line 250); citations e.g. `src/embed/version.ts:2` (FR-17), `docs/EMBED.md:388` (FR-18), `docs/EMBED.md:455` (FR-19), `src/data/canonical.ts:119,154` (FR-20.4), `scripts/size-guard.mjs:17` (FR-20)
- **Description:** The code base cites FR-17 (attach loader, 27 references in `src/`/`server/`/`extension/src`), FR-18 (store journal, 35), FR-19 (version reporting, 6) and FR-20 plus FR-20.4–20.8 (presentation mode, 28). None of these IDs has a row in `docs/REQUIREMENTS.md`, so `spec/` (generated from it) has none either. `CLAUDE.md` says all requirements live in `docs/REQUIREMENTS.md`. Shipped features therefore have no acceptance criteria, and reqmd cannot trace them. The CI spec-sync gate (`.github/workflows/ci.yml` job `spec`) cannot catch this because the source table itself is incomplete.
- **Recommendation:** Add FR-17 … FR-20 sections, with acceptance criteria and milestones, to `docs/REQUIREMENTS.md` and regenerate `spec/` (`npm run spec`). Optionally add a check that fails when the code cites an ID the table does not define.

#### BP-02 — ARCHITECTURE.md headless example uses an API that does not exist
- **Severity:** medium
- **Location:** `docs/ARCHITECTURE.md:114`
- **Description:** The example `import { createStore, createNote, toMarkdown, mergeBundles } from "bluepencil/data"` fails. `src/data/index.ts:10-15` only re-exports `schema`, `canonical`, `bundle`, `merge`, `migrate` and `order`. `createStore` (`src/core/store.ts`), `createNote` (`src/core/model.ts`) and `toMarkdown` (`src/core/export/markdown.ts`) are not exported from that subpath. `mergeBundles` does not exist anywhere (the function is `mergeNotes`, `src/data/merge.ts:192`). Anyone who copies the example gets import errors.
- **Recommendation:** Rewrite the example against the real `bluepencil/data` surface (`mergeNotes`, `createBundle`, `serializeCanonical`, …), or export the intended symbols, and record that decision.

#### BP-03 — ARCHITECTURE.md repository layout is labelled "planned" and has drifted from reality
- **Severity:** medium
- **Location:** `docs/ARCHITECTURE.md:3`, `:8`, `:53`, `:57`, `:60`, `:61`
- **Description:** The layout still lists `src/react/`, `bookmarklet/`, `examples/react/` and `examples/home-assistant/`. None of them exist (`ls` verified). It leaves out modules that do exist: `src/embed/`, `src/ui/present.ts`, `src/ui/keymap.ts`, `extension/`, and the examples `attach`, `parity`, `presentation`, `voice`, `federation`. `CLAUDE.md` has the correct, current structure, so the two sources now disagree.
- **Recommendation:** Replace the "planned" tree with the current layout, taken from `CLAUDE.md` or generated. Move unbuilt items (React wrapper, HA example) to a roadmap note.

#### BP-04 — NFR-3 headline and size-guard header still state the 33 kB budget; core budget is non-binding
- **Severity:** medium
- **Location:** `docs/REQUIREMENTS.md:276`; `scripts/size-guard.mjs:5`, `:49-55`
- **Description:** NFR-3 opens with "target ≤ 33 kB min+gzip", and the size-guard header says the core is budgeted at "≤ 33 kB". The enforced core budget is actually 100 kB. A measured run gives: core 40.6 kB / 100 kB, IIFE 44.2 kB / 45 kB, element 47.0 kB / 48 kB. The IIFE contains the core plus adapters and locales, so the IIFE ceiling hits first and the 100 kB core ceiling can never fail on its own. The "core without adapters" check has stopped guarding anything, and the headline number contradicts the recorded decisions. The IIFE and element bundles are at about 98% of budget, so the next feature will force another budget raise.
- **Recommendation:** Update the NFR-3 headline and the size-guard header to the enforced numbers. Tighten the core budget so it bites again (for example measured + ~10%), or remove it and state that the IIFE is the binding gate. Plan headroom work before the next UI feature.

#### BP-05 — BUILD-SYNC.md carries a stale release version copy
- **Severity:** low
- **Location:** `docs/BUILD-SYNC.md:100`
- **Description:** The doc says "`package.json` and `extension/manifest.json` carry the release version (currently `0.10.3`)". Both are `0.11.6`, and so is `CHANGELOG.md:1`. The project rule is that version lives only in `package.json` / `extension/manifest.json`, with no copies elsewhere. (The `0.10.3` pins in `docs/DOCKER.md:235-260` are intentional and explained there, so they are not a finding.)
- **Recommendation:** Remove the hard-coded version from the sentence. Do not swap it for the current number.

#### BP-06 — Headless CLI bundles the full UI layer through the `src/index` facade
- **Severity:** low
- **Location:** `src/cli/bin.ts:52`, `:685-699`
- **Description:** The CLI imports `createBlueprint` from `../index`, which pulls in `src/ui/layer.ts`, the panel and the composer. The only consumer is the `demo` subcommand. `dist/cli.js` (453 kB) contains `createLayer`, `createPanel` and `createComposer`. This goes against the architecture rule that the CLI is a headless consumer of `src/data`/`src/core` (`docs/ARCHITECTURE.md:25-28`), and it makes the CLI bundle larger and more coupled than it needs to be.
- **Recommendation:** Implement `demo` with `createStore` + `createMemoryAdapter` + `toMarkdown`, which the CLI already imports. Import `VERSION` from `../version`.

#### BP-07 — Review-priority and string-compare logic duplicated between `data/canonical` and `data/order`
- **Severity:** low
- **Location:** `src/data/canonical.ts:22-37` vs `src/data/order.ts:21-38`
- **Description:** `priorityOf` and `compareStrings` in `canonical.ts` re-implement `reviewPriority` and `compareText` from `order.ts`, which calls itself "the single implementation every surface shares". `order.ts:9-11` explains why the two *orderings* differ (canonical sorts by route first). The priority class itself is identical, though, and if the FR-4.6 classes change, one copy can drift silently. That conflicts with the FR-15.3 single-implementation goal.
- **Recommendation:** Have `canonical.ts` import `reviewPriority` (and a shared code-unit comparator) from `order.ts`, and keep only the route-first composition local.

#### BP-08 — `bluepencil notes` prints non-canonical JSON
- **Severity:** low
- **Location:** `src/cli/bin.ts:526-529`
- **Description:** `notes` writes `JSON.stringify(set.notes, null, 2)`, so key and list order follow the input file. Every other CLI path that emits notes uses the canonical form (`canonicalBundle`, `bin.ts:626`), and so do the hub and MCP (`canonicalNote`). The same note set can print differently depending on where it came from, which goes against the NFR-17 determinism goal for agent-facing output.
- **Recommendation:** Print `serializeCanonical(set.notes)` (from `src/data/canonical.ts`), optionally after `sortForReview`.

#### BP-09 — `Blueprint.layer` / `Blueprint.store` lazy proxies bypass the gate and resurrect after `destroy()`
- **Severity:** low (judgment)
- **Location:** `src/index.ts:84-95`, `:191-192`
- **Description:** `blueprint.layer` is a proxy over `ensureLayer()`, so `blueprint.layer.enable()` mounts the layer without evaluating the host `enabled` gate. FR-1.1 requires fail-closed behaviour on every enable. After `destroy()`, any access to `blueprint.store` or `blueprint.layer` silently builds a new store or layer, even though the header says the instance "can be discarded". This is a judgment call: the handle is a deliberate escape hatch. Still, the contract is not stated, and a host can break FR-1.1 by accident.
- **Recommendation:** Document that `layer.enable()` skips the gate, or route it through the facade's `enable()`. After `destroy()`, have the proxies throw or return inert handles.

#### BP-10 — "Public types only in `src/core/model.ts`" convention does not match the public API
- **Severity:** low (judgment)
- **Location:** `src/index.ts:256-291`; `CLAUDE.md` (Code-Konventionen)
- **Description:** The public entry re-exports types defined outside `model.ts`: `Adapter`/`AdapterLike`/`AdapterName` (`core/adapter`), `LayerHandle`/`LayerOptions` (`ui/layer`), `Store`/`StoreOptions` (`core/store`) and `HttpTransport` (`adapters/transport`). The convention as written is not followed. Either the rule or the code is wrong.
- **Recommendation:** Narrow the convention to "public *data-model* types live in `model.ts`", which matches practice, or move the interface types there.

### Checked, no finding
- **NFR-4 (no runtime deps):** `package.json` `dependencies` is `{}`. No third-party imports in `src/`, `server/` or `extension/src/` (only relative and `node:` specifiers). `esbuild`/`jsdom` appear only in build and smoke scripts, as devDependencies.
- **enable()/disable() idempotency (FR-12.1/12.2, NFR-15):** `src/ui/layer.ts:2094-2189` guards both with `enabled` early returns. `disable()` tears down listeners (`unlistenAll`), the store subscription, the ResizeObserver, panel, composer, legend, settings, the presentation ticker/BroadcastChannel, the root node and ref-counted styles. The facade's `destroy()` (`src/index.ts:228-235`) is idempotent. Cycles are covered by the `tests/unit/ui.test.ts` and `tests/e2e/vanilla.e2e.mjs` NFR-15 checks.
- **Canonical serialisation (NFR-17):** `src/data/canonical.ts` covers every `Note`, `Anchor`, `CapturedContext`, `Message`, `Session` and `Bundle` field in `src/core/model.ts`. It uses a fixed key order, code-unit comparisons (no `localeCompare`), a trailing newline, and a dependency-free FNV-1a hash.
- **Single headless implementation (FR-15.3):** hub (`server/handler.ts`, `server/hub.ts`), MCP (`src/mcp/backend.ts`), federation (`src/federation/aggregate.ts`) and the CLI all import validation, merge, migration, bundle and canonical logic from `src/data`, and filtering/patching from `src/core/adapter.ts`. `extension/src` contains no note logic. `src/data` has no DOM or UI imports. The only duplication found is BP-07.
- **Version SSOT:** `package.json`, `extension/manifest.json` and the `CHANGELOG.md` head all read `0.11.6`. `src/version.ts` injects the version at build time and has no hard-coded copy. The one stale copy is BP-05.
- **REQUIREMENTS vs `spec/` staleness:** the FR/NFR IDs in `docs/REQUIREMENTS.md` and `spec/` match one-to-one. CI regenerates `spec/` and fails on drift (`.github/workflows/ci.yml`, job `spec`). The remaining gap is in the source table itself (BP-01).
- **Directory structure in CLAUDE.md:** matches the real `src/`, `server/`, `extension/`, `examples/` and `tests/` trees (only the minor files `src/argv.ts`, `src/version.ts`, `src/federation/{errors,ids}.ts` are not listed).
- **Default exports:** none in `src/`, `server/`, `extension/src/`, `scripts/` or `tests/`.
- **File naming:** all source and script files are kebab-case. No snake_case or camelCase file names.
- **Bundle size gate in CI:** `npm run size` runs in `ci.yml` (step "Bundle size guard") and in the release `verify`. All four budgets currently pass (headroom concern: BP-04).
