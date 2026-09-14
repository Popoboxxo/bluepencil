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

## FR-2 Anchoring

| ID | Requirement | Prio | Ms | Origin | Acceptance criteria |
|---|---|---|---|---|---|
| FR-2.1 | Resolution order: host hook (`data-bluepencil`, `data-testid`) → stored CSS path → text quote | P0 | M1 | P | Removing the hook falls back to the path; rewording falls back to the quote |
| FR-2.2 | The note stores route/path and (if present) the SPA route at capture time | P0 | M1 | G | Two notes on the same selector on different routes stay distinct |
| FR-2.3 | Each anchor is resolved *before* save so invalid anchors cannot be stored | P0 | M1 | P | Saving a note whose element vanished is rejected with feedback |
| FR-2.4 | Unresolvable notes appear as **orphaned** in the list, never silently dropped | P0 | M1 | G | Element removed → note shown with "orphaned" marker and a jump-not-possible hint |
| FR-2.5 | A build/app reference is stored per note; stale references are flaggable | P1 | M2 | G | Notes from an older build can be filtered/marked |
| FR-2.6 | Anchors are stable across re-render of a list (key-based hooks preferred) | P1 | M2 | G | Note on list item 3 still resolves after the list is reordered by insertion |

## FR-3 Note model

| ID | Requirement | Prio | Ms | Origin | Acceptance criteria |
|---|---|---|---|---|---|
| FR-3.1 | A note has: `id`, `created_at`, author (+`author_type`), `type`, `intent`, `status`, `body`, `quote`, `anchor`, `context`, `route`, `session_ref` | P0 | M1 | P | All fields present in the JSON export and validated |
| FR-3.2 | `type` ∈ {`text`, `design`}; `intent` ∈ {`implement`, `feedback`}; `status` ∈ {`open`, `done`, `needs_decision`} | P0 | M1 | P | Invalid values rejected by the API/adapter |
| FR-3.3 | Notes carry an append-only **thread** of messages with `author_type` (`human`/`agent`) and `kind` (`note`/`decision_request`/`decision`/`feedback`/`reply`) | P0 | M1 | P | Agent and human replies appear in order, each with author and timestamp |
| FR-3.4 | Notes can be grouped into a **session** and exported/purged per session | P1 | M2 | G | Purge removes exactly the session's notes, count reported |
| FR-3.5 | The schema is versioned and documented; migrations from older data are defined | P0 | M1 | G | A v1 file loads in a v2 build; migration is documented and tested |

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

---

## NFR — non-functional

| ID | Requirement | Prio | Ms | Acceptance criteria |
|---|---|---|---|---|
| NFR-1 | **Zero footprint when disabled**: no DOM, no fetch, no listener, no timer | P0 | M1 | Bundle loaded but unused → no network requests, no nodes, no measurable CPU |
| NFR-2 | No polling. Data is fetched on demand (open/refresh/write) | P0 | M1 | Idle page produces no repeated requests over 10 minutes |
| NFR-3 | Core bundle small enough to embed casually (target ≤ 30 kB min+gzip, excluding adapters) | P1 | M1 | Build report shows size; CI fails on regression beyond budget |
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

---

## Traceability summary

| Origin | Meaning | Requirement groups |
|---|---|---|
| **P** (prototype) | Behaviour already proven in the reference implementation — must be preserved 1:1 | FR-1.2–1.5, 1.8–1.9, FR-2.1, 2.3, FR-3.1–3.3, FR-4.1–4.7, FR-6.3–6.5, FR-7.1–7.2, 7.4, FR-8.1 |
| **G** (gap) | Missing in the prototype — the reason a library exists at all | FR-1.1, 1.10, FR-2.2, 2.4–2.6, FR-3.4–3.5, FR-6.1–6.2, FR-7.3, FR-9.1, 9.4, FR-10.1–10.3, NFR-3, 6, 11 |
| **N** (product need) | Driven by the admin debug-mode requirement of a downstream ALM product | FR-5.x (all), FR-8.2–8.5, FR-9.2, FR-10.4, FR-6.6 |

## Open questions (to decide before M1 closes)

1. **Distribution shape**: one package with subpath exports, or `@bluepencil/core` +
   `@bluepencil/react` + `@bluepencil/server`? (Recommendation: single package, subpaths,
   framework wrapper as optional peer.)
2. **Marker rendering**: injected DOM sibling vs. absolutely positioned overlay vs. CSS
   pseudo-element — trade-off between host-CSS interference and simplicity?
3. **Default author identity**: ask the host (`getUser()` hook) or a free-text field?
4. **Done-note default**: hidden for everyone, or configurable default per host?
5. **Retention**: does the library ever delete data on its own, or only on explicit action?
6. **Naming in code**: `bluepencil` as the global and the `data-bluepencil` hook, or a shorter
   hook (`data-bp`)? (Recommendation: `data-bluepencil` for clarity, `window.bluepencil` global.)
