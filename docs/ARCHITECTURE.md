# Architecture — bluepencil

> Planned structure for M1–M3. Requirement references: [REQUIREMENTS.md](REQUIREMENTS.md).
> Rationale: [CONCEPT.md](CONCEPT.md).

---

## 1. Repository layout (planned)

```
bluepencil/
├─ src/
│  ├─ core/
│  │  ├─ model.ts          # Note, Message, Anchor, Context, enums, schema version
│  │  ├─ store.ts          # in-memory store + change events (single source of truth)
│  │  ├─ anchor.ts         # resolve/derive anchors (hook → css path → quote)
│  │  ├─ capture.ts        # context capture (computed styles subset, box, theme, viewport)
│  │  ├─ export/
│  │  │  ├─ markdown.ts    # agent-facing export, deterministic ordering
│  │  │  └─ json.ts        # schema-versioned full export/import
│  │  └─ protocol.ts       # intent/status/thread rules (agent collaboration)
│  ├─ data/                # HEADLESS (no DOM): schema, validate, merge, canonicalise,
│  │  │                    # migrate, bundle read/write — used by UI, server, CLI, MCP
│  │  ├─ schema.ts         #   types + JSON schema + migration table
│  │  ├─ bundle.ts         #   export/import a portable bundle (FR-14.2)
│  │  ├─ merge.ts          #   merge/upsert/replace-session + conflict report (FR-14.3/14.4)
│  │  └─ canonical.ts      #   deterministic serialization (NFR-17)
│  ├─ cli/                 # `bluepencil inspect|validate|merge|export|import` (FR-15.2)
│  ├─ mcp/                 # MCP tool layer over a transport-neutral backend (backend.ts)
│  ├─ federation/          # agent-side multi-hub layer (FR-16.10–16.15)
│  │  ├─ registry.ts       #   registry shape, validation, resolution (file, mode 0600)
│  │  ├─ ids.ts            #   qualified ids (`instance/noteId`), reserved names
│  │  ├─ net-policy.ts     #   base-URL + SSRF policy (`--allow-insecure`, link-local always blocked)
│  │  ├─ client.ts         #   one instance over HTTP (no redirects, timeout, redaction)
│  │  ├─ aggregate.ts      #   read fan-out, per-instance failures, deterministic order
│  │  ├─ backend.ts        #   `McpBackend` over N instances; routing + the two write locks
│  │  ├─ errors.ts         #   one error taxonomy → MCP result, exit code, log line
│  │  └─ index.ts          #   internal module barrel, bundled into the bins (no package export)
│  ├─ adapters/
│  │  ├─ memory.ts         # ephemeral
│  │  ├─ local-storage.ts  # survives reload, bookmarklet default
│  │  ├─ file.ts           # import/export a JSON file
│  │  └─ http.ts           # REST client against the documented contract
│  ├─ ui/
│  │  ├─ layer.ts          # mount/unmount, bar, handle, settings popover
│  │  ├─ modes.ts          # the single capture-preset table (FR-1.13/1.14)
│  │  ├─ composer.ts       # note input (mode, checkbox "feedback only")
│  │  ├─ panel.ts          # list, filters, thread, reply, orphan markers
│  │  ├─ legend.ts         # shortcut overlay
│  │  ├─ voice.ts          # dictation adapter: browser Web Speech API or a host engine (FR-21)
│  │  └─ styles.ts         # token-driven CSS string (prefix .bp-, no global resets)
│  ├─ i18n/                # en.ts, de.ts (strings only)
│  ├─ react/               # optional wrapper (peer dependency)
│  ├─ element/             # custom-element build (<bluepencil-notes>) for hosts w/o a bundler
│  └─ index.ts             # public API: init(), mount(), enable(), disable(), destroy()
├─ server/                 # reference hosts: hub.ts (HTTP) + federator.ts (stdio), thin over src/
├─ bookmarklet/            # loader generator + usage docs
├─ examples/
│  ├─ vanilla/             # plain HTML fixture app (all FR groups)
│  ├─ react/               # React fixture
│  ├─ home-assistant/      # custom card/panel loading the element build as a resource (FR-12.5/12.7)
│  └─ round-trip/          # dev → bundle → live → bundle → dev exchange (FR-14.5/14.8)
├─ tests/
│  ├─ unit/                # model, anchor, adapters, export (vitest)
│  └─ e2e/                 # the fixture app in a real browser (CDP harness, NFR-11)
└─ docs/
   ├─ CONCEPT.md  REQUIREMENTS.md  ARCHITECTURE.md
   ├─ PROTOCOL.md          # agent collaboration protocol (implement/feedback/decision)
   └─ INTEGRATION.md       # host guide incl. admin debug mode
```

Build outputs: **ESM** (`import { init } from "bluepencil"`), **IIFE** (`window.bluepencil`),
and the **bookmarklet** loader. Subpath exports for adapters so tree-shaking keeps the core
small (`bluepencil/adapters/http`). The Node entry points are built separately: `dist/server.js`
(hub), `dist/federator.js` (stdio federator), `dist/cli.js` and `dist/mcp.js`; `server.js` and
`federator.js` are also the `bluepencil-hub` / `bluepencil-federator` bins.

## 2. Public API (sketch)

```ts
import { init } from "bluepencil";
import { createHttpAdapter } from "bluepencil/adapters/http";

const bp = init({
  // D8: the layer can be switched on and off at runtime, inside any product
  enabled: () => me.roles.includes("admin") && flags.uiNotes,   // evaluated on every enable()
  mount: document.body,                    // or a container / card element (multi-instance safe)
  adapter: createHttpAdapter({ endpoint: "/api/v1/bluepencil", headers: authHeaders }),
  identity: { getUser: () => ({ id: me.id, name: me.name }) },   // D3: hook | "prompt" | "anonymous"
  getRoute: () => router.currentRoute.value.fullPath,           // SPA-aware
  canAnnotate: (el) => !el.closest("[data-bp-ignore]"),
  markerStrategy: "overlay",               // D2: "overlay" (default) | "sibling"
  anchorHooks: ["data-bluepencil", "data-testid"],               // D6
  language: "de",
  theme: { accent: "var(--color-primary)", surface: "var(--color-surface)" },
  defaultShowDone: false,                  // D4
  retention: null,                         // D5: never deletes in the browser build
  onError: (err) => console.debug("[bluepencil]", err),
});

bp.enable();               // runtime activation (idempotent)
bp.disable();              // full teardown: nodes, listeners, styles, observers
bp.export({ format: "markdown" });
await bp.destroy();        // final cleanup; the instance can be discarded
```

`enable()` / `disable()` are the D8 core: a product can hand the layer to an admin for one
session and take it away again without reloading, and repeated cycles must leave no residue
(FR-12.2, NFR-15).

### Headless use (dev tooling, CI, agents) — FR-13.2, FR-15.x

```ts
import { createStore, createNote, toMarkdown, mergeBundles } from "bluepencil/data";

// A test runner or build script writes a note into the same store the UI reads:
const store = createStore({ adapter: "localStorage" });     // or createHttpAdapter / memory
await store.create(createNote({
  type: "text",
  body: "Test `checkout.spec.ts` failed at this element",
  source: "tool:test-runner",
  anchor: { hook: "checkout-submit" },
  debug: { test: "checkout.spec.ts", stack: "…", commit: "abc1234" },
}));
```

```bash
# CLI: exchange and inspection without any UI (FR-15.2) — file based today; the `--adapter http`
# form is the M2 extension (adapter selection in the CLI), the HTTP surface is used through the library.
bluepencil export --adapter http --endpoint … --env live --out live.bluepencil.json   # M2
bluepencil inspect live.bluepencil.json
bluepencil merge dev.bluepencil.json live.bluepencil.json --dry-run --json
bluepencil import live.bluepencil.json --adapter http --endpoint … --mode merge       # M2
```

Everything the UI does is also available headlessly through `bp.store` and the export
functions, so an integration can render the notes in its own UI (FR-10.4).

## 3. Data model

```ts
export const SCHEMA_VERSION = 1;

export type NoteType = "text" | "design" | "bug" | "feature";
export type NoteIntent = "implement" | "feedback";                 // FR-5.1
export type NotePriority = "high" | "medium" | "low";              // FR-3.7, only for feature
export type NoteStatus = "open" | "done" | "needs_decision";       // FR-3.2
export type AuthorType = "human" | "agent";
export type MessageKind = "note" | "decision_request" | "decision" | "feedback" | "reply";

export interface Anchor {
  hook?: string;        // value of data-bluepencil / data-testid      (FR-2.1)
  selector?: string;    // CSS path fallback; shadow boundaries as " >> " (FR-12.4)
  quote?: string;       // text excerpt — survives rewording
  route?: string;       // page/SPA route at capture time              (FR-2.2)
  orphaned?: boolean;   // set when resolution fails at read time      (FR-2.4)
}

export interface CapturedContext {
  tag: string;
  classes: string[];
  styles: Record<string, string>;   // curated subset: font-*, color, background, spacing, border
  box: { w: number; h: number; x: number; y: number };
  scheme: "light" | "dark";
  viewport: { w: number; h: number };
  buildRef?: string;                // app/build identifier            (FR-2.5)
}

export interface Message {
  id: string;
  ts: string;                       // ISO 8601
  author: string;
  authorType: AuthorType;
  kind: MessageKind;
  text: string;
}

export interface Note {
  id: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  sessionRef?: string;              // review round                     (FR-3.4)
  type: NoteType;                   // text | design | bug | feature
  severity?: NoteSeverity;          // blocker | major | minor, only for a bug (FR-3.6)
  priority?: NotePriority;          // high | medium | low, only for a feature (FR-3.7)
  intent: NoteIntent;
  status: NoteStatus;
  body: string;
  anchor: Anchor;
  context: CapturedContext | null;
  messages: Message[];
  ticketRef?: string;               // optional external reference      (FR-5.8)
}
```

`context` stays `null` for text notes unless the host asks for it. `severity` and `priority` are
additive fields: `SCHEMA_VERSION` stays `1` (NFR-9), and canonical serialization keeps their key
order as `type, severity, priority` so a diff stays stable (NFR-17).

## 4. Store and adapters

```ts
export interface Adapter {
  list(filter?: NoteFilter): Promise<Note[]>;
  create(draft: NoteDraft): Promise<Note>;
  update(id: string, patch: NotePatch): Promise<Note>;
  remove(id: string): Promise<void>;
  bulkRemove(filter: NoteFilter): Promise<{ removed: number }>;   // FR-8.2
  exportSession(sessionRef: string): Promise<Note[]>;             // FR-8.3
  subscribe?(cb: (notes: Note[]) => void): () => void;            // optional live updates
}
```

Implementation rules:

* The **store** holds the authoritative in-memory list and emits change events; the UI never
  talks to an adapter directly (FR-6.1).
* `localStorage` adapter namespaces its key (`bluepencil:<host>:v1`), writes atomically, and
  falls back to memory when storage is unavailable (private mode, quota).
* The `http` adapter is a thin REST client against §5 — no business logic.
* Adapters are interchangeable; the same conformance test suite runs against all of them
  (FR-6.1, NFR-11).

### The MCP backend abstraction (FR-16.9)

The MCP tools do not talk to a `Store` directly. They talk to `McpBackend` in
`src/mcp/backend.ts` — a transport-neutral interface for list/get/create/update/message/remove,
sessions, export/import and `list_instances`. There are exactly two implementations:

| Implementation | `kind` / `scope` | Used by |
|---|---|---|
| `createStoreBackend` | `store` / `single` | `bluepencil mcp` over stdio, and a hub without `--registry` |
| `createFederatedBackend` | `federation` / `aggregate` | an aggregating hub (`/mcp`) and the stdio federator |

The same tool handlers and the same response shapes serve all three hosts, so a tool behaves
identically whether it is reached over stdio, over a hub's `POST /mcp`, or through a federated
aggregate. Note logic still lives once in `src/core/**` + `src/data/**`; the backend only decides
*where* a call goes (FR-15.3).

## 5. HTTP contract (reference server)

```
GET    /api/v1/bluepencil/notes?route=&status=&intent=&session=&since=
POST   /api/v1/bluepencil/notes                 # create
GET    /api/v1/bluepencil/notes/{id}            # read one note (?environment= gates it)
PATCH  /api/v1/bluepencil/notes/{id}            # status, intent, body
POST   /api/v1/bluepencil/notes/{id}/messages   # append thread message (author_type, kind)
POST   /api/v1/bluepencil/notes/bulk-delete     # filter + confirm token
GET    /api/v1/bluepencil/bundle                # canonical bundle JSON (agents/exports)
GET    /api/v1/bluepencil/sessions
GET    /api/v1/bluepencil/health
```

Responses are JSON `{ ok: boolean, ... }` with HTTP status codes; errors never return HTML.
The reference server is **small and boring** on purpose: static hosting + JSON on disk +
Markdown mirror, so notes can be committed to a repository if the host wants that
(NFR-10, FR-6.4). Authentication, tenancy and permissions belong to the host (FR-9.1).

## 6. Bookmarklet

A loader that injects the IIFE build into the current page:

```
javascript:(()=>{const s=document.createElement('script');s.src='https://<host>/bluepencil.iife.js';
s.onload=()=>bluepencil.init({adapter:bluepencil.adapters.localStorage(),
getUser:()=>({name:'reviewer'}),getRoute:()=>location.pathname});document.head.appendChild(s)})()
```

* Default adapter is `localStorage`; export writes a JSON/Markdown file (FR-6.2).
* Pages with a strict CSP that forbids external scripts will block the loader — documented
  limitation with the workaround (self-hosted mode or extension) (NFR-6).
* No `eval`, no inline handlers.

## 5b. Bundle format and exchange (FR-14)

A **bundle** is one plain JSON file — self-describing, deterministic, diffable:

```jsonc
{
  "kind": "bluepencil.bundle",
  "schemaVersion": 1,
  "exportedAt": "2026-09-14T18:20:00+02:00",
  "exportedBy": "daniel@dev",
  "environment": "dev",                    // dev | staging | live   (FR-14.1)
  "app": { "name": "my-web-tool", "buildRef": "abc1234" },
  "sessions": [
    { "ref": "review-2026-09-14", "label": "Pre-release review", "createdAt": "…" }
  ],
  "notes": [ /* Note[] — anchors, context, threads, sources, debug info */ ]
}
```

Merge semantics (FR-14.3/14.4) — always idempotent, never silent:

| Mode | Behaviour |
|---|---|
| `merge` (default) | Add notes whose `id` is unknown; skip known ids. Running it twice changes nothing. |
| `upsert` | Same, but updates known notes when their content changed; the incoming and existing threads are **concatenated** (append-only), never replaced. |
| `replace-session` | Removes the notes of a session present in the bundle, then adds the bundle's version of that session. |

Every import (except dry-run) reports `{ added, updated, skipped, conflicts[] }`. Conflicts are
notes with the same `id` but divergent content: they are **listed**, and the write is refused
unless `--on-conflict=keep-incoming|keep-existing` is given explicitly.

Environment rules (NFR-18): the bundle's `environment` must match the target's, otherwise the
import stops with an explanation; overriding requires `--allow-env-mismatch`. Promotion between
environments (FR-14.8) is therefore a deliberate act, and the note keeps its full thread and
origin while the environment tag is rewritten.

## 5c. Headless data library and CLI (FR-15)

`bluepencil/data` is a DOM-free package with the entire note logic (schema, validation, merge,
canonicalisation, migration, bundle I/O). The UI, the reference server, the CLI and the MCP tool
group are all thin layers over it — one implementation, one set of validators (FR-15.3).

```
src/data/   schema.ts  bundle.ts  merge.ts  canonical.ts  migrate.ts   # no DOM, no deps
src/cli/    bin: bluepencil  inspect | validate | merge | export | import | instances
```

`bluepencil instances list|validate|health` operates on a federation registry offline (see §5d);
`health` is the only one that probes peers.

Guarantees: no runtime dependencies (FR-15.4), runs in plain Node (NFR-… FR-15.4), canonical
output for diffing and hashing (NFR-17), and bundles readable by a 20-line script without the
library (NFR-19).

## 5d. Federation (FR-16.10–16.15)

Federation is an **agent-side** layer over hubs. A browser client still writes to exactly one hub;
an agent can read and write several hubs through one MCP session. The full registry schema, the
threat model and the deployment shapes are in [FEDERATION.md](FEDERATION.md); the tool-level
contract is in [MCP.md](MCP.md). This section records where the code lives and the invariants the
architecture depends on.

**Roles.**

| Role | Process | Store | Surface |
|---|---|---|---|
| Leaf hub | `bluepencil-hub` | one environment (store of record) | `/notes`, `/config`, `/health`, `/mcp` |
| Aggregating hub | `bluepencil-hub --registry` | still local | `/notes` local; `/mcp` aggregates |
| Federator | `bluepencil-federator` | none | stdio MCP only; no `/config` |
| MCP client / agent | any MCP client | none | one hub `/mcp` or the federator's stdio |

`src/federation/` is split by concern: `registry.ts` (file shape, validation, resolution, the 0600
gate), `ids.ts` (qualified ids and reserved names), `net-policy.ts` (base-URL and SSRF policy),
`client.ts` (one peer over HTTP), `aggregate.ts` (read fan-out), `backend.ts` (the federated
`McpBackend`), `errors.ts` (one error taxonomy → MCP result, exit code, log). `server/hub.ts` and
`server/federator.ts` are thin hosts: they parse the CLI, load the registry and wire the backend.

**Registry → resolved instances.** The registry is the only place an operator declares which
instances a session may talk to, so it is a security boundary. It is read once at start-up, before
the socket is bound (hub) or before the first protocol frame (federator). A `base` must include the
API path — `http://hub-dev:8787/api/v1/bluepencil`, not the bare origin. The file must be mode
`0600` (`(mode & 0o077) !== 0` is `invalid_registry`) and owned by the process user; credentials are
references (`auth.env`), never values. Validation collects every issue and refuses the whole
registry — no partial load. Each resolved instance becomes one `InstanceClient`; `self`, when
present, is an in-process source over the hub's own store.

**The aggregate envelope.** Reads fan out to the selected instances, each note is returned as a
copy tagged with `instance` (and `app`) and a qualified id `instance/noteId`, and the merged set is
ordered deterministically by the review comparator with an instance tie-break. A slow or broken
peer is a **value**, not an exception: the result carries `partial: true` and one error entry per
failed instance, so healthy notes survive. `limit` caps the aggregate, not each peer. Writes are
routed to exactly one target; there is no write fan-out.

**One level only.** The registry is a flat list. A peer that reports `federates:true` is refused
with `nested_federation`; a self-entry is `self_reference`; `self` / `all` / `*` are reserved.
On a pure federator `--no-self` is an accepted no-op and `--include-self` is a usage error (there
is no local store). A peer that does not report `federates` at all is a pre-0.10 hub and is refused
strictly with `federates_missing` (exit 4) — never a silent empty result. `federates:false` is the
normal leaf value.

**The two write locks.** A federated write needs the session lock (`--allow-write`, strict:
`--allow-write`, `--allow-write=true` or `BLUEPENCIL_ALLOW_WRITE=1`) **and** a writable target
(`mode: "write"` in the registry, or a writable `self`). Without the session lock even a
`mode: "write"` entry is read-only; `--read-only` wins over both. The backend owns this decision —
the inner store backend is always constructed writable so it cannot report the wrong authority.

**Why `/notes` stays single-environment while `/mcp` aggregates.** `/notes` is the browser-facing
store of record: one hub, one environment, unchanged semantics. Federation only widens the agent
door. On an aggregating hub `/notes`, `/sessions`, `/bundle` and `/health` keep operating on the
local store; with `--no-self` that store is deliberately empty, so `/notes` stays local and empty.
Pointing a browser at an aggregate would break the single-writer assumption, so there is no
`instance` attribute and no browser federation in v1.

## 6b. Runtime lifecycle, shadow DOM, multi-instance

**Lifecycle contract.** `enable()` attaches, `disable()` detaches — completely:

* DOM: one host container for the layer (overlay + panel + composer + legend), removed on disable.
* Listeners: attached on enable, removed on disable; capture-phase only, and `stopPropagation()`
  is called *exclusively* while an annotation mode is active (FR-12.6).
* Observers/timers: `ResizeObserver`/scroll listeners for marker geometry, nothing on a timer
  (NFR-2); all disconnected on disable.
* Styles: one `<style>` node, injected once per document, removed when the last instance goes.
* Idempotence: `enable()` twice, `disable()` twice, N cycles — same footprint as before
  (FR-12.2, NFR-15).

**Mount scope and instances.** `mount` may be `document`/`body` or any container (a card, a
panel, a dialog). Each instance keeps its own store, adapter, namespace and UI ids
(`bp-<instanceId>-…`), so two instances on one page never mix. Instance-local storage keys are
namespaced (`bluepencil:<host>:<instance>:v1`).

**Shadow DOM.** Hosts built from web components (dashboard cards, design systems, Home
Assistant) put the annotatable elements inside shadow roots. Therefore:

* clicks are evaluated on `event.composedPath()`, not `event.target`;
* the anchor path encodes shadow boundaries with `>>` (`bp-card >> div.value >> span.unit`),
  resolved segment by segment via `element.shadowRoot`;
* `data-*` hooks work inside shadow roots unchanged — which is why the hook is the primary
  anchor (FR-2.1);
* a *closed* shadow root cannot be resolved: the note is stored with the hook/quote and flagged
  as *degraded* rather than silently failing (FR-2.4).

## 6c. Packaging for very different hosts (FR-12.5, NFR-16)

| Consumer | Artifact | Notes |
|---|---|---|
| App with a bundler | ESM `bluepencil` (+ `bluepencil/react`) | tree-shaken, adapters as subpaths |
| Host without a build step (Home Assistant resource, static page, CMS) | single-file ES module (`bluepencil.element.js`) registering `<bluepencil-notes>` | attributes map to config, events out: `bp-note-created`, `bp-export`, `bp-enabled` |
| Third-party page, no deploy | IIFE + bookmarklet | `localStorage` adapter, export to file |
| Own backend | reference server package | serves page + API, JSON store, retention off by default |

The custom element is a thin wrapper around the same core — no second implementation. For
Home Assistant this is the integration path: load the module as a frontend resource, drop the
element into a custom card or panel, and gate it on an admin check inside the card
(FR-10.4 pattern). Whether that ships here or as a separate HACS integration is still open
(REQUIREMENTS § Still open).

## 7. Theming and host CSS safety

* All classes are prefixed `bp-`; styles live in a single stylesheet injected once.
* Colours/spacing come from CSS custom properties with fallbacks, overridable by the host
  (`--bp-accent`, `--bp-surface`, `--bp-ink`, …) so the layer can adopt a design system
  without hardcoding values (FR-10.3).
* The layer renders in a wrapper with `contain: layout style` and a high `z-index`; markers are
  positioned without affecting the host's box model (FR-1.8).
* Print and host-export styles remove the layer entirely (FR-1.9).

## 8. Agent collaboration protocol (summary; full text in docs/PROTOCOL.md)

1. Agent reads the export (Markdown) or the adapter (`list`).
2. `intent=implement` + `status=open` → implement, then reply (`kind=reply`) and set `done`.
3. `intent=feedback` → answer with an assessment (`kind=feedback`); **change nothing**; leave
   the status to the human.
4. Unclear/ambiguous → post as system (`author_type=agent`, `kind=decision_request`) with
   options **and a recommendation**, set `status=needs_decision`. Never invent the human's answer.
5. Everything is reported in the thread — including what was *not* done and why.

The Markdown export opens with the two exception sections (`⚠ open decisions`,
`💬 feedback only`) so a reader cannot miss what must not be implemented (FR-5.6).

## 9. Testing strategy

| Level | Scope | Tooling |
|---|---|---|
| Unit | model, anchor resolution (hook/path/quote, orphaning), capture, exports, adapters | vitest (jsdom) |
| Adapter conformance | one suite, all adapters | vitest |
| E2E | `examples/vanilla` fixture: annotate text/design, quote capture, filters, done-hidden default, feedback mode, decision thread, export, enable/disable cycles (bulk delete is M2 and not implemented) | dependency-free CDP harness (`scripts/lib/browser.mjs`), no test framework |
| Functional parity | `examples/parity` fixture: one document served at the same path on two loopback ports, driven once through the one-tag embed loader (`dist/attach.js`) and once through the built MV3 extension mounting the active tab (unforced); identical observations required | dependency-free CDP harness (`scripts/lib/browser.mjs`) |
| Host integration | React example: mount/unmount, no leaks, host-supplied theme | Playwright |
| Size guard | bundle budget (NFR-3) | CI check |
| A11y | keyboard-only path, contrast of layer surfaces | Playwright + axe |
| Manual round | annotate a real page with ~20 notes, export, work off, purge | checklist in `docs/` |

The fixture app exists so that every FR group has a reproducible target; it doubles as the
demo page (M3).

The **functional-parity suite** (NFR-11) proves that the *same* layer behaves identically however it
arrives on the page. One fixture document (`examples/parity/page.html`) is served twice, at the same
path, on two loopback ports; the identical case matrix — `layer-mounted`, `capture-anchor`,
`note-fields`, `design-context`, `export-canonical` — runs against both strands: strand **embed**
loads the layer through the one-tag loader (`dist/attach.js`), strand **extension** lets the built
MV3 extension mount it on the active tab, unforced (no `force: true`). `normalize()` scrubs
everything that is volatile by construction (generated ids, timestamps, loopback ports) before the
two observations are compared, so a divergence is a real behavioural difference rather than a
fixture artefact. The runner prints a `case | embed | extension | parity` matrix and exits non-zero
on any failure or divergence.

`scripts/components-e2e.mjs` is the single manifest of E2E surfaces: 16 runner components map to 21
coverage IDs, and each entry names its suite, its `requires` (build, browser, docker) and a hard
timeout. `docs/E2E-COVERAGE.md` is the documented side of the same matrix; the runner checks both
directions and fails on a documented-but-uncovered ID, an undocumented `covers` ID, or an `E2E entry`
path that does not belong to a component covering that ID.

Browser-gated components are skipped without Chrome and Docker-gated ones without a daemon, unless
`BP_REQUIRE_BROWSER=1` / `BP_REQUIRE_DOCKER=1` turns the missing prerequisite into a failure. CI runs
`smoke:components -- --list` as the coverage gate before the individual smoke steps; `npm run verify`
runs the matrix with `--no-docker`, so the default chain never needs a Docker daemon.

## 10. Mapping from the proven prototype

The reference prototype (vanilla JS + tiny stdlib server, ~700 lines) maps as follows:

| Prototype part | bluepencil destination |
|---|---|
| DOM overlay, two modes, composer, markers (`comments.js/css`) | `src/ui/*` (TS, prefixed classes, token-driven) |
| Exit/quote capture, selector derivation | `src/core/anchor.ts`, `src/core/capture.ts` |
| Comment lifecycle incl. intent/status/thread | `src/core/model.ts`, `src/core/protocol.ts` |
| Markdown mirror + JSON store | `src/core/export/*` |
| Stdlib server with API + exports | `server/` (reference implementation, mode "hub") |
| Auto-commit of the note store | optional host feature, documented (not a library concern) |
| Watchdog/keep-alive for the serving process | deployment concern, documented in the server README |

Everything the prototype proved is a `P`-marked requirement; everything it lacked is a `G`
gap that this architecture addresses through adapters, a published schema, packaging,
host hooks and the MCP/agent interface.

## 10b. Resolved decisions (2026-09-14)

D1 one package (subpath exports) · D2 overlay markers with sibling fallback · D3 config-driven
identity (`getUser` / `"prompt"` / `"anonymous"`, fallback `"prompt"`) · D4 `defaultShowDone`
configurable, default `false` · D5 retention only in the server package, off by default ·
D6 `data-bluepencil` plus `data-testid` · D7 retention defaults 90/180 days, configurable ·
D8 **runtime activation in arbitrary products** — which is why this document now carries
§6b (lifecycle, shadow DOM, instances) and §6c (packaging for four consumer types).

## 11. Release plan

* **M1** — `0.1.0`: core + UI + memory/localStorage adapters + Markdown/JSON export + fixture app
  + unit/E2E tests. Exit: annotate any page, reload, export, no server involved.
* **M2** — `0.2.0`: HTTP adapter + reference server + sessions + bulk/session deletion +
  deterministic exports + **headless data library and CLI**, **bundle export/import with
  merge/dry-run/conflict reporting**, environment tagging, dev-system write API (FR-13.1–13.3,
  FR-14.1–14.7, FR-15.1–15.4).
* **M3** — `0.3.0`: IIFE build, **custom-element build**, bookmarklet, React wrapper, theming
  docs, size guard, host-variety examples (static, SPA, web-component/HA card).
* **M4** — `0.4.0`: MCP tool group (thin wrapper over `bluepencil/data`) + protocol doc +
  retention option.
* **M5** — `0.5.0`: product integration guide (RBAC, audit, purge) with a worked example.
* **M5b** — `0.10.0`: **delivered** — federation as an agent-side layer over hubs: the
  `src/federation/` module, a transport-neutral `McpBackend`, `/mcp` aggregates over a registry,
  the stdio `bluepencil-federator`, `/config` reports `app` and `federates`, the two write locks,
  and one federation level (FR-6.15, FR-16.10–16.15, NFR-22). `/notes` and the browser path are
  unchanged.
* **M6** — `1.0.0`: i18n (en/de), a11y audit, docs site, API freeze (semver commitment).

Each release: one tag, one changelog entry, one demo screenshot/GIF in the README.
