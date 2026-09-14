# Concepts — bluepencil

> Status: concept phase. This document is the reference for *what* we build and *why*.
> Requirements derived from it: [REQUIREMENTS.md](REQUIREMENTS.md). Technical design:
> [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 1. The problem

Reviewing a web UI today produces feedback that is lossy in three ways.

**It loses the place.** A reviewer writes "the second badge in the header looks off" or
"the spacing here is wrong". The developer (or the agent) then has to *re-find* the element.
Every wrong guess costs a full iteration. In a fast-moving UI (renamed headers, reordered
toolbars) prose describes a page that no longer exists.

**It loses the state.** Design feedback is about the *current* rendering: this font size,
this colour, this spacing, this viewport, this theme. A screenshot captures pixels but not the
values; a sentence captures neither. After the fact nobody can tell whether the complaint was
about 12 px or 14 px, light or dark mode, desktop or mobile.

**It loses the machine.** Feedback arrives as an issue with prose and images. An AI agent
can act on it only by guessing at the DOM — which is exactly the step that wastes iterations.
What an agent needs is `which element + what did it look like + what should change`.

Existing channels make it worse by being separated: a design review in one tool, wording
comments in another, bugs in the tracker, and screenshots pasted into a chat.

## 2. What bluepencil is

A **review layer for arbitrary web applications**:

1. It attaches to a running page (embedded as a library, or loaded into a third-party page
   as a bookmarklet).
2. The reviewer clicks an element and writes a note — either about **content/wording**
   (*text note*) or about **appearance/layout** (*design note*).
3. Each note gets a **stable anchor** and, for design notes, a **snapshot of the element's
   state** at the moment of noticing.
4. Notes are collected, filtered, exported (Markdown/JSON), and **threaded**: humans and
   agents talk in the same note.
5. An **AI agent can consume the set**, implement what is unambiguous, explicitly ask for a
   decision where it is not, and confirm what it changed — in the same thread.

bluepencil is deliberately *not* a design tool, not a feedback widget for end users, and not a
project-management system. It is the missing **capture layer** between "I noticed something"
and "somebody acts on it".

## 3. Who uses it

| Role | Situation | What they get |
|---|---|---|
| **Frontend developer** | Dogfooding their own app; collecting nits before a release | Click-through list of concrete spots instead of a mental to-do list |
| **Designer / UX reviewer** | Reviewing spacing, hierarchy, contrast | Design notes with captured values, so the fix is unambiguous |
| **Admin / operator in debug mode** | Debugging a deployed instance | Notes on the live system, exportable, deletable after the session |
| **Product owner** | Walking through a build before sign-off | Notes expressed as "change this text / this layout", with a decision thread |
| **QA engineer** | Exploratory testing | Notes that become issue-ready artifacts with anchors and state |
| **AI agent (MCP/CLI)** | Working off a review round | A machine-readable list: `intent`, `status`, `anchor`, `context`, `thread` |
| **Documentation / training** | Recording why a UI looks the way it does | The note thread is the rationale, versioned with the repo |

## 4. Use cases

**UC-1 — Review round on a project page.**
A reviewer opens the app, presses `C`, clicks a paragraph, writes "this sentence repeats the
previous one". Presses `D`, clicks a KPI tile, writes "value too heavy, tries to outshout the
heading". After 20 notes, they export the set as Markdown and hand it to the agent. The agent
implements the unambiguous ones, asks about two, marks the rest done. *Proven end to end.*

**UC-2 — Design review with hard numbers.**
The design note stores computed `font-size`, `font-weight`, `color`, `background-color`,
`padding`, bounding box, colour scheme and viewport. The developer does not need to ask which
size was meant.

**UC-3 — Text revision, anchored.**
The reviewed text changes. The note still resolves because the anchor keeps a **quote** next
to the CSS path; if the element moved, the note is flagged as *orphaned* instead of silently
disappearing.

**UC-4 — Agent asks for a decision.**
The agent cannot decide between two variants: it writes a note as **system** (`author_type=agent`,
`kind=decision_request`) with the options and a recommendation, and sets the status to
`needs_decision`. The human answers in the thread; the note reopens; the agent implements.

**UC-5 — Feedback only.**
A stakeholder wants the agent's *opinion*, not a change. They mark the note as *feedback
requested* (or switch the whole session into "feedback only" mode). The agent must not touch
the code — it answers with an assessment.

**UC-6 — Debug session on a live deployment.**
An admin enables debug mode for their role, collects notes across several pages of a running
system, exports them, and then **deletes the whole session** with one action. Nothing stays
behind in the UI for normal users.

**UC-7 — Third-party site, no deploy.**
A reviewer drags the **bookmarklet** into a site they cannot modify and annotates it. Notes
live in the browser (localStorage) and can be exported as a file — no server required.

**UC-8 — Requirements traceability.**
A note can be linked to an external ticket (or, in an ALM system, to a requirement ID), so the
review result becomes part of the audit trail instead of a chat log.

## 5. Core concepts

**Note** — the unit of feedback. Fields: `id`, `author` (+ `author_type`), `type`
(`text`/**`design`**), `intent` (`implement`/`feedback`), `status` (`open`/`done`/`needs_decision`),
`body`, `quote`, `anchor`, `context`, `route`, `session`, timestamps, `thread`.

**Anchor** — a resolved path back to the element, in this order:
`data-bluepencil`/`data-testid` hook → stored CSS path → text quote. The quote is the buffer
that survives a rewording; a *stale* anchor is reported, never hidden.

**Context** — the captured state for design notes (computed styles subset, box, colour scheme,
viewport, app/build reference). For text notes it is reduced to `route` + viewport.

**Intent** — *what should happen*: `implement` (default) or `feedback` (assessment only).
Deliberately separate from status.

**Status** — *where it stands*: `open`, `done`, and `needs_decision` (the system has asked a
question). "Done" is the reason a note disappears from the default view.

**Thread** — an append-only list of messages with `author_type` (`human`/`agent`) and `kind`
(`note`, `decision_request`, `decision`, `feedback`, `reply`). This is what makes collaboration
auditable: who asked what, who answered, what was implemented.

**Session** — a named review round (`session_ref`) so a finished round can be exported and
purged as a unit.

**Export** — Markdown (grouped by route/page, with the thread and a top section listing
*open decisions* and *feedback-only* items) and JSON (full fidelity, for tooling).

## 6. Interaction model

* Two modes: **text** (reviews content) and **design** (reviews appearance, captures state).
* Click to annotate; a selection inside the element becomes the quote.
* Floating, collapsible control bar + a handle that never disappears; keyboard-first
  (`J/K` navigate, `?` shortcut legend, `S` speaker notes in presentation use, `C`/`D` modes,
  `L` list, `F` feedback-only mode, `B` hide bar).
* List panel with filters (type, intent, status), thread view, inline reply.
* **Settings** (gear): show/hide done notes (default: hidden), feedback-only mode, author name,
  reset to defaults.
* Invisible in print and in exports; zero visual footprint when disabled.
* "Done" notes vanish from both the list and the page markers — a finished page looks clean
  again.

## 7. Proven prior art

The interaction model is not a bet. It was built and used for a full review round on a
scrollable presentation page (six chapters, ~40 notes) and then generalised into a reusable
kit, which has since produced further decks. Everything below is derived from what that
prototype proved — and from the gaps it left.

What the prototype demonstrated:

* **Two-mode click-to-annotate** with quote capture and element-state capture.
* **Anchoring by selector + quote + route** — every note resolved, none was lost after the
  text was reworded twice.
* **Markdown as the agent interface** — the agent read the export, implemented, replied and
  marked notes done; the loop ran without a single mis-targeted edit.
* **Lifecycle**: open → done, with agent replies in the same note.
* **Native exports**: a real PDF (headless-Chrome print) and a self-contained HTML file.
* **Durability**: a watchdog keeps the serving process alive across container restarts.

What the prototype lacked and what bluepencil must solve: framework independence, no server
requirement (bookmarklet/localStorage), a stable public API and data schema, packaged
distribution (ESM/IIFE), permissions as a host concern, i18n, orphan detection in the UI,
session purge, and an agent-facing machine interface (MCP).

### Alternatives considered

| Option | Why not |
|---|---|
| **Hypothes.is** (self-hosted) | Annotation silo with a heavy stack (PostgreSQL + Elasticsearch); text anchors only, **no element state**, no intent/status/thread semantics for agents. |
| **Recogito / Annotorious** | Good text/image annotation frameworks, but they annotate *documents*, not a live application's DOM state. |
| **Giscus / Utterances** | Page-level comment threads bound to GitHub; not element-level, no design state. |
| **Isso / Remark42** | Self-hosted comment systems, page-level, no anchoring, extra service. |
| **Playwright / visual-diff tooling** | Excellent for regressions; no *human* loop that captures intent in words. |
| **Issue trackers + screenshots** | The status quo — loses place, state and machine readability (see §1). |
| **Browser devtools / "inspect" screenshots** | Developer-side, not reviewer-side; nothing is stored. |

Recent AI browser agents can *drive* a page, but they do not give a human a fast way to leave
element-anchored intent. That gap is bluepencil.

## 8. Deployment modes

| Mode | How it loads | Storage | Typical use |
|---|---|---|---|
| **Embedded** | bundled as a dependency of the app | host API or library default | dogfooding, admin debug mode in a product |
| **Bookmarklet** | dragged into any page | in-memory / `localStorage`, export to file | third-party sites, no deploy rights |
| **Self-hosted sidecar** | small server serves the page *and* the API | JSON on disk + Markdown export | presentations, static sites, team reviews |
| **Hosted API** | library + your own endpoints | your database | products with existing auth and tenancy |
| **Agent-coupled** | as above + MCP tool group | as above | AI agents read/close notes as part of a workflow |

## 9. Agent collaboration model (the reason this exists)

```
human annotates ──▶ note (intent, anchor, state)
                       │
       export / MCP ───┘
                       ▼
        agent reads the set ─┬─ intent=implement ──▶ implement, commit, reply "done"
                             ├─ intent=feedback  ──▶ assessment only, no change
                             └─ unclear          ──▶ note as SYSTEM, ask a decision,
                                                     status=needs_decision
                       ▲
      human answers ───┘  (thread, kind=decision) → status reopens → agent implements
```

Rules that keep this honest:

1. **Implement when it is unambiguous** — never ask about wording, spacing, order.
2. **Ask with options and a recommendation** — "A or B? I recommend B, because …".
3. **Never invent a human decision.** The decision is the human's; the system only asks.
4. **Report every change in the thread** — including what was *not* done and why.

## 10. Non-goals

* Not a user-facing feedback widget or feature-voting tool.
* Not a design-tool replacement (no mockups, no design system management).
* Not an analytics or session-replay product.
* Not a project tracker — it produces input for one.
* Not a screenshot annotator (element state is structured data, not pixels).
* No hosted service requirement, no mandatory account, no telemetry.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Anchors drift after refactors | `data-*` hook first (host-owned), quote fallback, build reference, orphan flagging in the UI |
| CSP / sandbox on third-party pages blocks the bookmarklet | Document limits, offer self-hosted mode, no inline eval |
| Notes containing sensitive data | Local-first defaults, explicit export, session purge, "no personal data" policy |
| Scope creep into a general design-review tool | Strict non-goals, admin/reviewer-only gating |
| Storage growth | Sessions + retention/purge; notes are artefacts, not history |
| Adoption friction | One-line integration, framework-agnostic, works with `localStorage` from minute one |

## 12. Roadmap

| Milestone | Content | Exit criterion |
|---|---|---|
| **M0 — Concept** (this repo) | concept, requirements, architecture | reviewed and merged |
| **M1 — Core** | types, anchor resolution, state capture, in-memory + `localStorage` adapters, overlay UI (text/design modes), Markdown/JSON export | annotate any page, reload, export — no server |
| **M2 — Server sidecar** | small reference server (API + static hosting), session handling, purge/retention | a full review round on a real page |
| **M3 — Distribution** | ESM + IIFE builds, bookmarklet generator, docs site/demo fixture app | "drag to your bookmarks bar" works |
| **M4 — Agent interface** | stable schema, MCP tool group, agent protocol (implement/feedback/decision) | an agent closes a review round end to end |
| **M5 — Product integration** | host adapter for an ALM tool (admin debug mode, RBAC, audit) | notes created and purged inside a real product |
| **M6 — Polish** | i18n (at least DE/EN), a11y audit, dark mode, print/PDF export | passes keyboard-only + screen-reader smoke test |

Milestones are cumulative; M1 is the first shippable artifact.
