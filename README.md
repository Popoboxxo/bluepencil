# bluepencil

> **Annotate any web app — text and design notes, anchored to the element, readable by humans *and* agents.**

A drop-in overlay that lets a reviewer (or an admin in debug mode) click any element of a
running web application, leave a note about its **content** or its **appearance**, and hand
the whole set of notes to a developer or an AI agent — no screenshots, no prose descriptions,
no "the second badge in the header".

```
┌─ your web app ───────────────────────────────────────────────┐
│  …                    ⚠ note anchored here                   │
│  [ element ]   ◇ design note: spacing is off   ✎ text note   │
└──────────────────────────────────────────────────────────────┘
        │
        ├─ export → Markdown / JSON  →  a developer or an agent works it off
        └─ thread → intent: implement | feedback   status: open | done | needs_decision
```

**Status:** concept & requirements (no code yet).
This repository is the home of the library; the interaction model itself is already
proven in a production-used prototype (see [docs/CONCEPT.md](docs/CONCEPT.md#7-proven-prior-art)).

## Why the name

To *blue-pencil* something means to edit it — marking up a draft with corrections and
suggestions. That is exactly what this overlay does: it is the blue pencil you hold against
a running application instead of a screenshot.

## Documentation

| Document | Content |
|---|---|
| [docs/CONCEPT.md](docs/CONCEPT.md) | Problem, users, use cases, core concepts, anchoring, deployment modes, non-goals, roadmap |
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | Functional and non-functional requirements with priorities and acceptance criteria |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module layout, data model, storage adapters, HTTP contract, bookmarklet, test strategy |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | Normative rules for human + agent collaboration (implement / feedback / decision requests) |
| [docs/INTEGRATION.md](docs/INTEGRATION.md) | Integration modes, host hooks, theming, security notes, admin debug mode |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) §8 | Environment tagging, bundle exchange rules, promotion between dev and live |

## What it will be, in one paragraph

`bluepencil` is a small, framework-agnostic library (TypeScript, no runtime dependencies) that
injects a review layer into any web page. It resolves a stable anchor for every note
(`data-*` hook → CSS path → text quote), captures the element's *current* state for design
notes (computed styles, box, theme, viewport, build reference), and stores notes behind a
swappable transport adapter (in-memory, `localStorage`, file, HTTP API, MCP). Notes carry an
**intent** (`implement` or `feedback`) and a **status** (`open`, `done`, `needs_decision`) plus
a **thread** of human and agent messages — so an AI agent can read the set, implement what is
unambiguous, ask for a decision where it is not, and report back in the same thread.

## Two more things it must do

**Work where the code runs.** On a developer system the layer reads *and* writes: a test runner,
build script or agent can drop notes into the running app (with their origin attached), while a
human reads them in the UI. In a live system it is admin-only and invisible to everyone else.

**Be readable by agents.** An **MCP interface** is a required part of the final tool (not a
nice-to-have): an agent can list open notes, answer one, mark it done, and move bundles —
read-only by default, writes on explicit opt-in, always bound to one app *and* one environment.

**Let notes travel.** Sets of notes move between environments as portable bundles —
`schema`-versioned JSON with an environment tag, importable with `merge` / `upsert` /
`replace-session`, a dry run that reports conflicts instead of overwriting, and a deliberate
*promotion* path from `dev` to `live` and back. The reading and writing logic lives in a
DOM-free data library with a CLI (`bluepencil/data`, `bluepencil/cli`) so CI, scripts and agents
use exactly the same data and validators as the UI.

## Non-negotiables

* **Zero layout impact** when disabled — no payload, no listeners, no polling.
* **Never enabled for normal end users.** The host decides via `enabled()` (admin role, flag) —
  and that decision is re-checked on every runtime activation.
* **Switchable at runtime.** `enable()` / `disable()` work in a running product; disabling leaves
  no DOM, no listeners, no data behind.
* **The anchor survives a text edit** — otherwise the notes are worthless after the first revision.
* **Agent-readable by design**: the Markdown export *is* the interface; the headless data
  library lets agents and CI read and write the same note sets without a browser.
* **No lock-in**: no hosted service, no account, self-hostable in a few lines.

## License

MIT — see [LICENSE](LICENSE).
