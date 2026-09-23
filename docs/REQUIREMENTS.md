# Requirements — bluepencil

> Derived from [CONCEPT.md](CONCEPT.md). Technical design: [ARCHITECTURE.md](ARCHITECTURE.md).
>
> **ID scheme:** `FR-<group>.<n>` functional, `NFR-<n>` non-functional.
> **Priority (MoSCoW):** `P0` must, `P1` should, `P2` could.
> **Milestone:** see [CONCEPT.md §12](CONCEPT.md#12-roadmap).
> **Origin:** `P` = proven in the reference prototype · `G` = gap the prototype left ·
> `N` = concrete product need (admin debug mode in an ALM system).

---

## FR-1 Capture

| ID | Requirement | Prio | Ms | Origin | Acceptance criteria |
|---|---|---|---|---|---|
| FR-1.1 | The layer activates only when the host allows it (`enabled()` returns true); otherwise nothing is rendered, bound or fetched | P0 | M1 | G | With `enabled()` false: no DOM node added, no request, no listener; bundle can still be loaded |
| FR-1.2 | A collapsible control bar with a handle that stays visible; hiding the bar never makes annotation impossible | P0 | M1 | P | Bar hidden, handle visible, mode still toggles; state survives reload |
| FR-1.3 | **Text mode:** clicking a text element (heading, paragraph, list item, table cell, label) opens a composer | P0 | M1 | P | Click on each listed element type opens the composer with the correct anchor |
| FR-1.4 | **Design mode:** clicking *any* element opens a composer and captures its state | P0 | M1 | P | Click on element captures tag, classes, computed styles subset, box, scheme, viewport, build ref |
| FR-1.5 | A text selection inside the clicked element is stored as the note's quote | P0 | M1 | P | Select three words, note stores exactly that text |
| FR-1.6 | Keyboard equivalents for every core action (`C`, `D`, `L`, `F`, `B`, `?`, `Esc`, `J/K`, digits) | P1 | M1 | P | All actions reachable without a mouse |
| FR-1.7 | A shortcut legend is reachable from the UI and by keyboard | P2 | M1 | P | Legend lists all shortcuts grouped, closes with `Esc`/backdrop |
| FR-1.8 | The layer never changes the host layout (no reflow, no shifted elements) | P0 | M1 | P | Host content boxes identical with layer on/off (measured) |
| FR-1.9 | Printing and host exports exclude the layer | P0 | M1 | P | `@media print` hides bar, handle, panel, composer, settings, markers |
| FR-1.10 | Annotating works inside dialogs, drawers and overlays of the host | P1 | M2 | G | Note can be created on an element inside a modal |
| FR-1.11 | **One shortcut registry**: shortcuts are registered once and the legend is generated from that registry — a divergence between help text and handler is a test failure | P0 | M2 | P | A remapped key updates the legend; a test walks every registered key and fails if the handler ignores it; the `0–6`-vs-nine-chapters bug cannot recur |
| FR-1.12 | **Extensible target resolution**: a host registers selectors (or a resolver function) for text and design annotation, and a component the layer does not know is still an annotatable block instead of silently inert | P0 | M2 | P | `annotate-selectors=".card, .tile"` makes the nearest match the anchor in both modes; `can-annotate` lets the host veto per element; a component whose text lives in children opens the composer; links inside stay operable |

## FR-2 Anchoring

| ID | Requirement | Prio | Ms | Origin | Acceptance criteria |
|---|---|---|---|---|---|
| FR-2.1 | Resolution order: host hook (`data-bluepencil`, `data-testid`) → stored CSS path → text quote | P0 | M1 | P | Removing the hook falls back to the path; rewording falls back to the quote |
| FR-2.2 | The note stores route/path and (if present) the SPA route at capture time | P0 | M1 | G | Two notes on the same selector on different routes stay distinct |
| FR-2.3 | Each anchor is resolved *before* save so invalid anchors cannot be stored | P0 | M1 | P | Saving a note whose element vanished is rejected with feedback |
| FR-2.4 | Unresolvable notes appear as **orphaned** in the list, never silently dropped | P0 | M1 | G | Element removed → note shown with "orphaned" marker and a jump-not-possible hint |
| FR-2.5 | A build/app reference is stored per note; stale references are flaggable | P1 | M2 | G | Notes from an older build can be filtered/marked |
| FR-2.6 | Anchors are stable across re-render of a list (key-based hooks preferred) | P1 | M2 | G | Note on list item 3 still resolves after the list is reordered by insertion |
| FR-2.7 | **Verweise bleiben bedienbar**: Links im kommentierbaren Inhalt werden in *jedem* Kommentarmodus durchgereicht (Ausnahmeliste `a[href]`, Formularfelder, `[data-bp-ignore]`); der Composer öffnet dann nicht | P0 | M1 | P | Bei aktivem Modus folgt ein Klick auf einen Link dem Ziel und öffnet keinen Composer; ein Klick auf den umgebenden Text öffnet ihn wie gewohnt |

## FR-3 Note model

| ID | Requirement | Prio | Ms | Origin | Acceptance criteria |
|---|---|---|---|---|---|
| FR-3.1 | A note has: `id`, `created_at`, author (+`author_type`), `type`, `intent`, `status`, `body`, `quote`, `anchor`, `context`, `route`, `session_ref` | P0 | M1 | P | All fields present in the JSON export and validated |
| FR-3.2 | `type` ∈ {`text`, `design`}; `intent` ∈ {`implement`, `feedback`}; `status` ∈ {`open`, `done`, `needs_decision`} | P0 | M1 | P | Invalid values rejected by the API/adapter |
| FR-3.3 | Notes carry an append-only **thread** of messages with `author_type` (`human`/`agent`) and `kind` (`note`/`decision_request`/`decision`/`feedback`/`reply`) | P0 | M1 | P | Agent and human replies appear in order, each with author and timestamp |
| FR-3.4 | Notes can be grouped into a **session** and exported/purged per session | P1 | M2 | G | Purge removes exactly the session's notes, count reported |
| FR-3.5 | The schema is versioned and documented; migrations from older data are defined | P0 | M1 | G | A v1 file loads in a v2 build; migration is documented and tested |

> **Field names as implemented:** the note JSON uses camelCase — `createdAt`, `updatedAt`,
> `authorType`, `sessionRef`, `schemaVersion`, `messages` (the thread) — and `quote` / `route` sit on
> the anchor (`anchor.quote`, `anchor.route`); `context` is `null` for text notes. Names are declared in
> `src/core/model.ts`, so every acceptance criterion above is checked by literal key name in the
> exported JSON.

## FR-4 Presentation

| ID | Requirement | Prio | Ms | Origin | Acceptance criteria |
|---|---|---|---|---|---|
| FR-4.1 | Annotated elements show a marker; multiple notes collapse into one marker with a count | P1 | M1 | P | Two notes on one element → one marker showing "2" |
| FR-4.2 | A list panel shows all notes with filters for type, intent and status | P0 | M1 | P | Each filter combination yields the expected subset |
| FR-4.3 | **Done notes are hidden by default** — in the list *and* as markers | P0 | M1 | P | Fresh load: done notes invisible; counters exclude them |
| FR-4.4 | Done notes can be revealed temporarily (one control) and permanently (settings) | P0 | M1 | P | Both paths show them immediately; the status filter follows the toggle |
| FR-4.5 | A settings surface holds: show done notes, feedback-only mode, author name, reset to defaults | P1 | M1 | P | Values persist across reload; reset restores defaults |
| FR-4.6 | Filtering/sorting puts `needs_decision` first, then feedback-requested, then the rest | P1 | M1 | G | Order verified with a mixed set |
| FR-4.7 | Clicking a list entry scrolls to and highlights the element when resolvable | P1 | M1 | P | Element flashes and is scrolled into view |
| FR-4.8 | Counters in the bar reflect total, open, decisions pending and feedback-only | P2 | M1 | P | After any change the numbers match the store |

## FR-5 Collaboration

| ID | Requirement | Prio | Ms | Origin | Acceptance criteria |
|---|---|---|---|---|---|
| FR-5.1 | Every note has an **intent**; `implement` is the default, `feedback` means "assessment only, do not change anything" | P0 | M1 | N | Feedback note is visibly distinct in UI and export; agent protocol documented |
| FR-5.2 | A **feedback-only mode** makes all new notes `intent=feedback` | P1 | M1 | N | Mode on → next note has `intent=feedback` without further action; mode is persisted |
| FR-5.3 | The intent of an existing note can be switched both ways | P1 | M1 | N | Toggle updates store and list immediately |
| FR-5.4 | The system can post a message **as the system** (`author_type=agent`) with `kind=decision_request` and set `status=needs_decision` | P0 | M1 | N | Such a note is marked in the list, in the export and shown first |
| FR-5.5 | The human can answer in the thread; the answer is stored as `kind=decision` and reopens the note (`status=open`) | P0 | M1 | N | Answer appears in thread; status returns to open |
| FR-5.6 | The export separates **open decisions** and **feedback-only notes** from the rest | P0 | M1 | N | Both sections exist at the top of the Markdown export |
| FR-5.7 | The protocol forbids the agent from inventing a human decision — only the human decides | P0 | M1 | N | Documented in README/protocol; reference agent flow shown in docs |
| FR-5.8 | Optional: notes can reference an external ticket/requirement ID | P2 | M5 | N | Field present in schema and export |

## FR-6 Storage & transport

| ID | Requirement | Prio | Ms | Origin | Acceptance criteria |
|---|---|---|---|---|---|
| FR-6.1 | Pluggable adapter interface (`list`, `create`, `update`, `remove`, `bulkRemove`, `subscribe?`) | P0 | M1 | G | Two adapters implemented against the same contract pass the same test suite |
| FR-6.2 | Built-in adapters: in-memory, `localStorage`, file (import/export), HTTP API | P0 | M1 | G | Bookmarklet works with localStorage only; HTTP adapter works against the reference server |
| FR-6.3 | The HTTP adapter contract is documented (endpoints, payloads, error shapes) | P0 | M2 | P | Contract tests against a reference implementation |
| FR-6.4 | A reference server exists (small, single dependency budget) for self-hosting | P1 | M2 | P | Serves the page *and* the API; runs from a single command |
| FR-6.5 | Notes are persisted atomically and never half-written | P0 | M2 | P | Write is atomic (temp + rename or transaction); no truncated file after interruption |
| FR-6.6 | An MCP tool group exposes list/create/update/export/bulk-delete to agents | P1 | M4 | N | Tools callable from an agent runtime; documented in ARCHITECTURE |

## FR-7 Export

| ID | Requirement | Prio | Ms | Origin | Acceptance criteria |
|---|---|---|---|---|---|
| FR-7.1 | Markdown export grouped by route/page, with quote, anchor, captured state and full thread | P0 | M1 | P | Export renders in a plain Markdown viewer without HTML |
| FR-7.2 | JSON export contains the complete data (schema-versioned) | P0 | M1 | P | Round-trip: import(export(x)) equals x |
| FR-7.3 | The Markdown export is stable enough to diff between review rounds | P1 | M2 | G | Same store → identical file; changes produce readable diffs |
| FR-7.4 | Optional: PDF export (print) and self-contained HTML export | P2 | M3 | P | Both produce a file that needs no network access |

## FR-8 Lifecycle & deletion

| ID | Requirement | Prio | Ms | Origin | Acceptance criteria |
|---|---|---|---|---|---|
| FR-8.1 | Single note deletion | P0 | M1 | P | Deleted note disappears from list and markers |
| FR-8.2 | Bulk deletion by filter (type, author, session, status, age) with confirm step | P0 | M2 | N | Filtered delete removes exactly the matching notes; count returned |
| FR-8.3 | Purge a whole session in one action | P1 | M2 | N | Session's notes are gone; other sessions untouched |
| FR-8.4 | Optional retention: automatic purge of done notes after N days, configurable | P2 | M4 | G | Retention task removes exactly the eligible notes and logs the count |
| FR-8.5 | Deletions are logged with actor, filter and count where a host provides audit | P1 | M5 | N | Audit entry exists per deletion including the filter used |

## FR-9 Permissions & safety

| ID | Requirement | Prio | Ms | Origin | Acceptance criteria |
|---|---|---|---|---|---|
| FR-9.1 | The host decides who may annotate; the library only asks (`enabled()`) and never builds its own auth | P0 | M1 | G | No credentials stored or transmitted by the library |
| FR-9.2 | Notes must never be visible to unauthorized users when a host API is used | P0 | M5 | N | Product integration test: non-admin sees nothing and gets no data |
| FR-9.3 | All user-provided text is rendered as text, never as HTML | P0 | M1 | P | XSS payload in a note body is displayed literally |
| FR-9.4 | No telemetry, no external calls unless the host configures an endpoint | P0 | M1 | G | Network log shows only host-configured requests |

## FR-10 Integration

| ID | Requirement | Prio | Ms | Origin | Acceptance criteria |
|---|---|---|---|---|---|
| FR-10.1 | Framework-agnostic: plain DOM API, plus first-class React wrapper | P0 | M1/M3 | G | Works on a vanilla fixture page; React wrapper mounts/unmounts cleanly |
| FR-10.2 | One-line integration path (`bluepencil.init({...})`) documented in README | P0 | M1 | G | A new host is annotating within 5 minutes following the README |
| FR-10.3 | Host hooks: element predicate (`canAnnotate`), language, theme tokens, route provider | P1 | M1 | G | Each hook demonstrably changes behaviour on the fixture app |
| FR-10.4 | Product integration path for an admin debug mode (RBAC + audit + purge) | P1 | M5 | N | Documented end-to-end example with role check and audit entry |

## FR-11 i18n & accessibility

| ID | Requirement | Prio | Ms | Origin | Acceptance criteria |
|---|---|---|---|---|---|
| FR-11.1 | All user-visible strings via an i18n table; at least `en` and `de` shipped | P1 | M6 | P | Language switch changes every label, including the legend |
| FR-11.2 | Full keyboard operation, visible focus, `Esc` cancels, focus returns to the trigger | P0 | M6 | P | Keyboard-only smoke test passes |
| FR-11.3 | `prefers-reduced-motion` respected; contrast of all layer surfaces meets WCAG AA | P1 | M6 | G | Audit report; no animation when reduced motion is set |
| FR-11.4 | Screen-reader-friendly semantics (roles, labels, live region for save feedback) | P1 | M6 | G | Notes list and composer are usable with a screen reader |

## FR-12 Runtime lifecycle & host variety  *(driven by D8)*

| ID | Requirement | Prio | Ms | Origin | Acceptance criteria |
|---|---|---|---|---|---|
| FR-12.1 | **Runtime activation**: `enable()`, `disable()`, `setEnabled(fn)` change the layer's presence without a reload | P0 | M1 | N | Disable removes bar, panel, composer, markers and styles; enable brings them back with the same store |
| FR-12.2 | **Teardown is complete and idempotent**: 100 enable/disable cycles leave no extra DOM nodes, listeners, timers or observers | P0 | M1 | N | DOM node count, listener count and heap after cycles equal the starting state (measured) |
| FR-12.3 | **Mount scope**: `mount(target?)` mounts globally (`document`) or inside a given container; several instances coexist without cross-talk | P1 | M2 | N | Two instances with different adapters on one page keep separate note sets and UIs |
| FR-12.4 | **Shadow DOM support**: click capture and anchoring work across shadow roots (`composedPath()`, `getRootNode()`); the stored path encodes the shadow boundary | P0 | M2 | N | Note created on an element inside a shadow root resolves after reload |
| FR-12.5 | **Web-component packaging**: a custom-element build (`<bluepencil-notes>` or equivalent) plus attribute/event mapping, so the layer can be loaded as a resource in hosts like Home Assistant | P1 | M3 | N | Element loads from a single ES module resource, opens the panel, stores notes through the configured adapter |
| FR-12.6 | **No host interference**: listeners work in the capture phase and never call `stopPropagation()` unless an annotation mode is active; interactive elements (`a[href]`, form fields, `[data-bp-ignore]`) are passed through even then; original behaviour is restored on teardown | P0 | M1 | N | Host's own click handlers fire normally with the layer enabled but idle; links and fields stay operable while a mode is active (FR-2.7) |
| FR-12.7 | **Documented host variety**: worked examples for at least a static page, a framework SPA, a micro-frontend/web-component host and a Home Assistant custom card | P1 | M3 | N | Each example in `examples/` runs and is covered by an E2E smoke test |
| FR-12.8 | **Config-driven identity** (D3): `identity` accepts a hook, `"prompt"` or `"anonymous"`; unset falls back to `"prompt"` | P0 | M1 | N | All three modes verified in the fixture app |
| NFR-20 | **No sideways scrolling inside the chrome**: nothing the layer draws ever creates a horizontal scrollbar, on any viewport | P0 | M2 | P | The browser leg measures `scrollWidth <= clientWidth` for every visible chrome surface across the six-viewport matrix |
| FR-12.11 | **Configurable keymap**: shortcuts are overridable, conflicts are detectable, and host shortcuts are only overridden while the layer owns the keyboard | P0 | M2 | P | `keymap="bar=g"` remaps and the legend follows; a conflict is reported through `element.issues` instead of last-one-wins; typing in a host field never triggers layer shortcuts |
| FR-12.9 | **Runtime chrome levels**: the layer's own chrome can be switched between *full*, *quiet* and *off* at runtime, the choice is persisted per user, and `disable()`/`destroy()` removes it regardless of the level | P0 | M2 | P | `setChrome()`/`handle.chrome()` plus the `h` shortcut cycle full→quiet→off→full; the level survives a reload; *off* leaves annotations and markers but no chrome, `disable()` removes the nodes |
| FR-12.12 | **Addressable chrome state**: the chrome level is settable per load through a documented URL parameter, read-only — it is never written back | P1 | M2 | P | `?bp-chrome=off` sets the level for that load only; automated tests and handovers can rely on it; an explicit change at runtime wins and is the only thing persisted |
| FR-12.10 | **Chrome slots**: every chrome surface occupies a declared slot (edge/corner registry); two surfaces never overlap, and where space is short an element yields instead of stacking | P0 | M2 | P | `data-bp-slot` on bar, handle and mode hint; the browser leg measures the six-viewport matrix (360/390/768/1024/1280/1440) and fails on any intersecting pair |
| FR-12.13 | **Responsive docking**: the chrome docks to a configurable edge and yields on narrow viewports | P1 | M2 | P | `dock="top"|"bottom"`; below 720 px the strip yields to its handle on its own (never persisted), and the matrix asserts exactly that at 360/390 px |

## FR-13 Developer systems: read *and* write during debugging

Debugging happens where the code runs. On a developer system the layer must not only display
notes — the surrounding tooling (test runner, build script, dev server, an agent) must be able
to **write notes into the running system and read them back**.

| ID | Requirement | Prio | Ms | Origin | Acceptance criteria |
|---|---|---|---|---|---|
| FR-13.1 | **Bidirectional during debugging**: the layer reads notes from the running system and writes new/updated notes back, including status and thread messages | P0 | M1 | N | A test runner creates a note programmatically; the running UI shows it; a human reply in the UI is visible to the tool on its next read |
| FR-13.2 | **Headless write API**: notes can be created/updated without any UI (same model, same validation) | P0 | M1 | N | Note created by a script (no DOM) appears in the UI and in the export |
| FR-13.3 | Every note records its **origin/source**: `ui:human`, `agent`, `tool:test-runner`, `tool:build`, `cli:import` | P0 | M1 | N | Source visible in list, export and MCP output; affects nothing else |
| FR-13.4 | Optional **auto-attach in development**: on a dev system the layer can enable itself without a manual click | P2 | M2 | N | With the flag set the layer is present after load; off in production builds by default |
| FR-13.5 | Dev notes can carry debug context: stack trace, failing test name, log excerpt, commit SHA | P1 | M2 | N | Fields present in schema and shown collapsed in the UI |
| FR-13.6 | Notes can reference a source location (`file:line`) in addition to a DOM anchor | P1 | M2 | N | Clicking a note with a file reference reveals it as text (no editor integration required) |

## FR-14 Live systems: integration and exchange via import/export

The same mechanism must work in a live system — admin-only, invisible to end users — and note
sets must **travel** between environments through portable export/import.

| ID | Requirement | Prio | Ms | Origin | Acceptance criteria |
|---|---|---|---|---|---|
| FR-14.1 | Every note and every bundle carries an **environment tag** (`dev`, `staging`, `live`) plus build reference | P0 | M2 | N | Bundles and notes can be filtered by environment; mismatches are visible |
| FR-14.2 | **Export bundle**: one schema-versioned JSON file containing sessions, notes, threads, anchors, context and metadata (exported_at, exported_by, environment, app/build, schema) | P0 | M2 | N | File validates against the published schema; contains everything needed for a full import |
| FR-14.3 | **Import with modes** — `merge` (default, idempotent), `upsert` (update changed notes), `replace-session` | P0 | M2 | N | Importing the same bundle twice changes nothing the second time |
| FR-14.4 | **Import never silently overwrites**: dry-run reports `added` / `updated` / `skipped` / `conflicts`; conflicts are listed, resolution is explicit | P0 | M2 | N | A conflicting note is reported, not overwritten; the original thread survives |
| FR-14.5 | **Round-trip fidelity**: export → import into an empty store → identical set (canonical form) | P0 | M2 | N | Byte-identical canonical JSON after round-trip |
| FR-14.6 | In a live system the layer is admin-only and invisible to end users; import/export is an explicit, audited admin action | P0 | M2 | N | Non-admin sees nothing; every import writes an audit entry with counts and actor |
| FR-14.7 | Import/export works in **all deployment modes**: bookmarklet (file download/upload), server (upload/download endpoint), CLI (offline) | P0 | M2 | N | Each mode verified in the fixture/example setups |
| FR-14.8 | Notes can be **promoted** deliberately between environments (dev → live, live → dev) without losing anchors, threads or origin | P1 | M3 | N | Promoted bundle keeps ids, threads and sources; environment tag is updated, history preserved |
| FR-14.9 | Bundle size and content are inspectable before import (list of sessions, counts, environments) | P2 | M3 | N | `inspect` prints a summary without writing anything |

## FR-15 Headless data library and CLI  *(the "extra library" for reading/writing the data)*

Not every consumer has a browser: CI jobs, migration scripts, agents, and the dev/live exchange
need to read and write note sets without any UI.

| ID | Requirement | Prio | Ms | Origin | Acceptance criteria |
|---|---|---|---|---|---|
| FR-15.1 | `bluepencil/data` — headless API for note sets: parse, validate, filter, merge, canonicalise, migrate, export (no DOM access) | P0 | M2 | N | Runs in plain Node without a DOM shim; same validators as the UI |
| FR-15.2 | `bluepencil/cli` — `bluepencil inspect \| validate \| merge \| export \| import` with `--file`, `--mode`, `--dry-run`, `--json` | P0 | M2 | N | Commands usable in a shell pipeline; exit codes meaningful for CI |
| FR-15.3 | **Single source of truth**: UI, server, CLI and MCP use the same schema, validators and merge logic — no second implementation | P0 | M2 | N | A schema change breaks exactly one place; conformance tests shared |
| FR-15.4 | Data and CLI packages are **DOM-free** and have no runtime dependencies | P0 | M2 | N | Node-only install works; `dependencies` empty |
| FR-15.5 | The MCP tool group is a thin wrapper over this API (no separate logic) | P1 | M4 | N | MCP and CLI behave identically for the same input |

## FR-16 MCP interface — required for the final tool

The final tool must be usable by agents directly, not only through the HTTP API and the Markdown
export. The MCP interface is therefore **not optional** (Daniel, 2026-09-14).

| ID | Requirement | Prio | Ms | Origin | Acceptance criteria |
|---|---|---|---|---|---|
| FR-16.1 | MCP server exposing the note set — tools: `list_notes`, `get_note`, `create_note`, `reply`, `set_status`, `set_intent`, `export_bundle`, `import_bundle` | P0 | M4 | N | An MCP client can list open notes, answer one and mark it done, using the same model and validators as the UI |
| FR-16.2 | **Read-only by default**; write tools need an explicit opt-in per session | P0 | M4 | N | With default settings the client can read but every write tool returns a clear refusal |
| FR-16.3 | A session is bound to **one app and one environment**; cross-environment access is refused (ties NFR-18) | P0 | M4 | N | A `dev`-bound session cannot list or write `live` notes |
| FR-16.4 | Agent writes record `source=agent` plus the MCP client name and session id | P0 | M4 | N | Origin visible in export and UI; human writes stay distinguishable |
| FR-16.5 | Notes are exposed as **resources** too (Markdown + JSON), so a host can read without tools | P1 | M4 | N | Resource returns the same content as `GET /api/comments.md` |
| FR-16.6 | Prompts/templates for the loop (“work off the open notes”, “summarise decisions needed”) | P2 | M4 | N | Prompt produces a correct work list with no additional context |
| FR-16.7 | The MCP server is a thin wrapper over `bluepencil/data` — no separate logic (FR-15.5) | P0 | M4 | N | Same merge/validation results via CLI and via MCP for the same input |

---

## NFR — non-functional

| ID | Requirement | Prio | Ms | Acceptance criteria |
|---|---|---|---|---|
| NFR-1 | **Zero footprint when disabled**: no DOM, no fetch, no listener, no timer — **both** when never enabled and after a runtime `disable()` | P0 | M1 | Bundle loaded but unused / after disable → no network requests, no nodes, no measurable CPU |
| NFR-2 | No polling. Data is fetched on demand (open/refresh/write) | P0 | M1 | Idle page produces no repeated requests over 10 minutes |
| NFR-3 | Core bundle small enough to embed casually (target ≤ 33 kB min+gzip, excluding adapters) | P1 | M1 | Build report shows size; CI fails on regression beyond budget. Raised from 30 kB to 31 kB for the host-facing capability set (FR-1.11/1.12, FR-12.9/12.10/12.13), measured at 30.5 kB. Raised again to 33 kB for the transient container reveal feature (issue #20) and app/build-ref/exportedBy (issue #21), measured at 31.9 kB — a decision, recorded here so it cannot look like drift |
| NFR-4 | No runtime dependencies (peer deps only for framework wrappers) | P0 | M1 | `dependencies` empty in the core package |
| NFR-5 | Evergreen browsers (Chromium/Firefox/Safari current + previous); graceful degradation otherwise | P1 | M1 | Feature detection; layer self-disables with a console note instead of throwing |
| NFR-6 | CSP-safe: no `eval`, no `new Function`, no inline script injection | P0 | M3 | Works on a page with `script-src 'self'` (bookmarklet documented with limits) |
| NFR-7 | Local-first: nothing leaves the browser unless an endpoint is configured | P0 | M1 | Verified with network inspection |
| NFR-8 | Data survives reload and crash (adapter-dependent); no silent data loss | P0 | M1 | Reload after 20 notes keeps all 20; interrupted write leaves the previous state intact |
| NFR-9 | Schema stability: additive changes within a major version; documented migration | P0 | M1 | Old export imports into a newer build |
| NFR-10 | Deterministic exports (stable ordering) so exports can be diffed/committed | P1 | M2 | Two exports of an unchanged store are byte-identical |
| NFR-11 | Testability: unit tests for model/anchor/adapters; Playwright E2E against a fixture app | P0 | M1 | CI runs both; a fixture app in-repo exercises every FR group |
| NFR-12 | Versioning: semver, changelog per release, one release per milestone | P1 | M1+ | Tag + changelog present per release |
| NFR-13 | No secrets in the repository or in stored notes; documented "no personal data" policy for debug use | P0 | M1 | Secret scan in CI; policy section in README |
| NFR-14 | Observability: a debug flag writes to `console.debug` only; no user-visible errors on failure | P2 | M2 | Adapter failure shows one inline message, never a broken page |
| NFR-15 | **Runtime parity**: every guarantee (footprint, no interference, determinism) holds identically after enable/disable cycles, not only on first load | P0 | M1 | Test matrix: N cycles × (footprint, host events, export determinism) all pass |
| NFR-16 | **Host-agnostic packaging**: consumable three ways — bundled dependency (ESM), standalone ES module resource (no build step, e.g. Home Assistant), single-file IIFE/bookmarklet | P0 | M3 | All three consume the same build in CI fixtures |
| NFR-17 | **Canonical, diffable bundles**: deterministic serialization (stable key and list order), so bundles can be committed and hashed | P0 | M2 | Two exports of the same set are byte-identical; a one-note change produces a one-hunk diff |
| NFR-18 | **Environment isolation by default**: an import never mixes environments unless explicitly asked (`--allow-env-mismatch`) | P0 | M2 | Importing a `live` bundle into a `dev` store is refused by default and explains why |
| NFR-19 | **Interoperability without the tool**: bundles are plain, documented JSON that any script can read; no proprietary encoding, no binary blobs | P0 | M2 | A 20-line script parses and filters a bundle using only the schema doc |

---

## Traceability summary

| Origin | Meaning | Requirement groups |
|---|---|---|
| **P** (prototype) | Behaviour already proven in the reference implementation — must be preserved 1:1 | FR-1.2–1.5, 1.8–1.9, FR-2.1, 2.3, 2.7, FR-3.1–3.3, FR-4.1–4.7, FR-6.3–6.5, FR-7.1–7.2, 7.4, FR-8.1 |
| **G** (gap) | Missing in the prototype — the reason a library exists at all | FR-1.1, 1.10, FR-2.2, 2.4–2.6, FR-3.4–3.5, FR-6.1–6.2, FR-7.3, FR-9.1, 9.4, FR-10.1–10.3, NFR-3, 6, 11 |
| **N** (product need) | Driven by the admin debug-mode requirement of a downstream ALM product | FR-5.x (all), FR-8.2–8.5, FR-9.2, FR-10.4, FR-6.6 |

## Decisions (resolved)

| # | Decision | Outcome |
|---|---|---|
| D1 | Package shape | **One package** with subpath exports (`bluepencil/adapters/http`, `bluepencil/react`). Split into scoped packages only if the server part later drags dependencies. |
| D2 | Marker rendering | **Overlay layer** that tracks element geometry; host DOM stays untouched. Sibling-injection fallback documented for hosts where tracking breaks (virtualised lists, transformed containers). |
| D3 | Author identity | **Config-driven, three modes**: `identity: { getUser }` (host auth), `identity: "prompt"` (free text field, persisted locally), `identity: "anonymous"`. Fallback when nothing is configured: `"prompt"`. |
| D4 | Default visibility of done notes | **Configurable per host** (`defaultShowDone`, default `false`). |
| D5 | Self-deletion | **Optional retention exists, off by default — and only in the server package.** The browser library never deletes anything on its own. |
| D6 | DOM hook for anchors | **`data-bluepencil`**, with `data-testid` honoured as an equal second hook. |
| D7 | Retention defaults | Configurable; defaults 90 days (done) / 180 days (all). Low priority — this is a review/debug layer, not a data store. |
| D8 | Primary use | **A library that can be activated and deactivated at runtime inside arbitrary products** — from a simple website to a complex web tool to a Home Assistant custom card/panel. Drives FR-12. |
| D9 | Developer systems | During debugging the layer **reads and writes**: tooling (tests, build, agent) can create and update notes in the running system via the headless API. Drives FR-13. |
| D10 | Live systems & exchange | Integration into live systems is admin-only; note sets travel via **portable export/import bundles**. The read/write logic lives in a **headless data library + CLI** (`bluepencil/data`, `bluepencil/cli`) that the UI and server reuse. Drives FR-14 and FR-15. |
| D11 | Agent access | The final tool needs an **MCP interface** (not optional): agents read, write, answer and move bundles over MCP. Drives FR-16. |

### Still open (before/while M1)

0. **File extension for export bundles**: `.bluepencil.json` is the proposal (self-describing,
   still plain JSON); a shorter `.bpnotes` would need its own tooling everywhere. Recommendation:
   `.bluepencil.json`.
1. **Web-component naming** for the custom-element build (`<bluepencil-notes>`? `<bp-layer>`?).
2. **Home Assistant delivery**: ship the integration in this repository
   (`examples/home-assistant/`, a frontend resource + custom card) or as a separate HACS
   repository that depends on the npm package?
3. **Multiple instances**: do we need cross-instance aggregation (one review session spanning
   several mounted instances), or is instance-local storage sufficient for v1?
