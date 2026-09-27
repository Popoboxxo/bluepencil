# Spec — bluepencil

This directory is a [reqmd](https://reqmd.dev) spec tree. It is **generated from
[`docs/REQUIREMENTS.md`](../docs/REQUIREMENTS.md)** — do not hand-edit the files here.

```sh
npm run spec            # regenerate spec/ from docs/REQUIREMENTS.md
npm run spec:check      # reqmd check spec/ (exit 0 = valid)
npm run spec:ls         # table of every node
npm run spec:stats      # attribute-value breakdown
```

`npm run spec:check` is part of `npm run verify` and runs in CI, so a broken
requirement block fails the build instead of waiting for a human to notice.

## What reqmd is

A single Go binary that validates a directory of `.md` files against a per-directory JSON
Schema (YAML) with bidirectional trace checks. Exit codes: **0** clean, **1** validation
errors, **2** parse error.

## Layout

| Directory | ID range | Content |
|---|---|---|
| `01-capture/` | FR-1.x | layer activation, text/design mode, keyboard, no-host-interference |
| `02-anchoring/` | FR-2.x | resolution order, routes, orphans, shadow DOM |
| `03-note-model/` | FR-3.x | note fields, enums, thread, sessions, schema version |
| `04-presentation/` | FR-4.x | markers, list panel, done-note visibility, counters |
| `05-collaboration/` | FR-5.x | intent, feedback-only mode, decision protocol |
| `06-storage/` | FR-6.x | adapter interface, built-in adapters, atomicity, MCP tool group |
| `07-export/` | FR-7.x | Markdown/JSON export, diffability |
| `08-lifecycle/` | FR-8.x | single and bulk deletion, sessions, retention, audit |
| `09-permissions/` | FR-9.x | host decides, admin-only in live systems, XSS, no telemetry |
| `10-integration/` | FR-10.x | framework-agnostic, one-line path, host hooks, admin path |
| `11-i18n-a11y/` | FR-11.x | i18n table, keyboard operation, reduced motion, screen reader |
| `12-runtime/` | FR-12.x | enable/disable, teardown, mount scope, shadow DOM, chrome levels, docking |
| `13-devsystems/` | FR-13.x | bidirectional read/write, headless API, origin, debug context |
| `14-live-systems/` | FR-14.x | environment tag, bundle export/import, promotion, modes |
| `15-headless/` | FR-15.x | `bluepencil/data`, `bluepencil/cli`, single source of truth |
| `16-mcp/` | FR-16.x | MCP tools, read-only default, environment binding, resources, prompts |
| `99-non-functional/` | NFR-1…20 | footprint, size budget, determinism, CSP, environment isolation |

Each directory holds a `schema.yaml` (the contract for that document) and
`requirements.md` (the requirements themselves).

## Attributes

Declared per document in `schema.yaml`, all with `additionalProperties: false`:

| Attribute | Meaning |
|---|---|
| `prio` | MoSCoW: `P0` must, `P1` should, `P2` could |
| `origin` | `P` proven in prototype · `G` prototype gap · `N` product need |
| `milestone` | from CONCEPT.md §12 (`M1`, `M2`, …) |

Built in, recognised automatically: `status` (`draft`/`approved` — only `approved`
counts as coverage), `disposition` (`implemented`/`deferred`/`rejected`), `version`,
`verify` (`Test`/`Review`/`Inspection`/`Analysis`/`Demonstration`), `trace`,
`requires-trace-from`, `reqmd-suppress`, `external`.

Every requirement carries `verify:` — the method is derived from the acceptance criteria in
the source table, not guessed. A requirement whose criteria are measurable in a test gets
`Test`; criteria that need a demonstration or a reading get `Demonstration`/`Inspection`.

## Two decisions worth knowing

**`id-prefix` is `FR-<group>.`, not `FR-`.** reqmd requires the prefix to be globally unique
(`prefix already used … collision`). The bluepencil IDs are two-level (`FR-1.3`, `FR-12.11`),
so each document declares the prefix of the group it actually contains.

**`requires-trace-from: []` on every requirement.** reqmd rule 5: use an explicit empty list
to opt out of a coverage check, never a missing `trace:`. A missing attribute is ambiguous, an
explicit contract is not. The source table has no upstream/downstream derivation between
requirements — the traceability that *does* exist (origin P/G/N, and the PROTOCOL.md
references) is carried as attributes and prose. When a real derivation appears, add
`trace:` to this file rather than removing the empty list.

## Why generated and not hand-maintained

`docs/REQUIREMENTS.md` is the human source of truth: it is what the README, the review rounds
and the design conversations point at. This tree is the machine-checkable projection of it.

The generator (`scripts/build-reqmd-spec.py`) fails loudly rather than silently dropping a
requirement: if the source table gains a column or a row that the parser does not understand,
it aborts instead of producing a spec that is quietly incomplete while `reqmd check` stays
green. That failure mode — a check that passes because it never saw the missing requirement —
is the one worth engineering against.

## Coverage today

127 requirements (107 functional, 20 non-functional), all `status: approved`, all with a
verification method. Priority split: 83 P0, 35 P1, 9 P2.
