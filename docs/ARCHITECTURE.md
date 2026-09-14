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
│  ├─ adapters/
│  │  ├─ memory.ts         # ephemeral
│  │  ├─ local-storage.ts  # survives reload, bookmarklet default
│  │  ├─ file.ts           # import/export a JSON file
│  │  └─ http.ts           # REST client against the documented contract
│  ├─ ui/
│  │  ├─ layer.ts          # mount/unmount, bar, handle, settings popover
│  │  ├─ composer.ts       # note input (mode, checkbox "feedback only")
│  │  ├─ panel.ts          # list, filters, thread, reply, orphan markers
│  │  ├─ legend.ts         # shortcut overlay
│  │  └─ styles.css        # token-driven, prefix .bp-, no global resets
│  ├─ i18n/                # en.ts, de.ts (strings only)
│  ├─ react/               # optional wrapper (peer dependency)
│  └─ index.ts             # public API: init(), destroy(), getInstance()
├─ server/                 # reference self-hosted server (sidecar mode)
├─ bookmarklet/            # loader generator + usage docs
├─ examples/
│  ├─ vanilla/             # plain HTML fixture app (all FR groups)
│  └─ react/               # React fixture
├─ tests/
│  ├─ unit/                # model, anchor, adapters, export (vitest)
│  └─ e2e/                 # Playwright against examples/vanilla
└─ docs/
   ├─ CONCEPT.md  REQUIREMENTS.md  ARCHITECTURE.md
   ├─ PROTOCOL.md          # agent collaboration protocol (implement/feedback/decision)
   └─ INTEGRATION.md       # host guide incl. admin debug mode
```

Build outputs: **ESM** (`import { init } from "bluepencil"`), **IIFE** (`window.bluepencil`),
and the **bookmarklet** loader. Subpath exports for adapters so tree-shaking keeps the core
small (`bluepencil/adapters/http`).

## 2. Public API (sketch)

```ts
import { init } from "bluepencil";
import { httpAdapter } from "bluepencil/adapters/http";

const bp = init({
  enabled: () => user.roles.includes("admin") && import.meta.env.MODE !== "production",
  adapter: httpAdapter({ endpoint: "/api/v1/bluepencil", headers: () => authHeaders() }),
  getUser: () => ({ id: user.id, name: user.name }),
  getRoute: () => location.hash || location.pathname,     // SPA-aware
  canAnnotate: (el) => !el.closest("[data-bp-ignore]"),
  language: "de",
  theme: { accent: "var(--color-primary)", surface: "var(--color-surface)" },
  defaultShowDone: false,
  onError: (err) => console.debug("[bluepencil]", err),
});

bp.open();                 // show the layer programmatically
bp.export({ format: "markdown" });   // returns a string
await bp.destroy();        // full teardown: nodes, listeners, styles
```

Everything the UI does is also available headlessly through `bp.store` and the export
functions, so an integration can render the notes in its own UI (FR-10.4).

## 3. Data model

```ts
export const SCHEMA_VERSION = 1;

export type NoteType = "text" | "design";
export type NoteIntent = "implement" | "feedback";                 // FR-5.1
export type NoteStatus = "open" | "done" | "needs_decision";       // FR-3.2
export type AuthorType = "human" | "agent";
export type MessageKind = "note" | "decision_request" | "decision" | "feedback" | "reply";

export interface Anchor {
  hook?: string;        // value of data-bluepencil / data-testid      (FR-2.1)
  selector?: string;    // CSS path fallback (nth-of-type based)
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
  type: NoteType;
  intent: NoteIntent;
  status: NoteStatus;
  body: string;
  anchor: Anchor;
  context: CapturedContext | null;
  messages: Message[];
  ticketRef?: string;               // optional external reference      (FR-5.8)
}
```

`context` stays `null` for text notes unless the host asks for it.

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

## 5. HTTP contract (reference server)

```
GET    /api/v1/bluepencil/notes?route=&status=&intent=&session=&since=
POST   /api/v1/bluepencil/notes                 # create
PATCH  /api/v1/bluepencil/notes/{id}            # status, intent, body
POST   /api/v1/bluepencil/notes/{id}/messages   # append thread message (author_type, kind)
POST   /api/v1/bluepencil/notes/bulk-delete     # filter + confirm token
GET    /api/v1/bluepencil/export?format=md|json
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
javascript:(()=>{const s=document.createElement('script');s.src='https://<host>/bluepencil.js';
s.onload=()=>bluepencil.init({adapter:bluepencil.adapters.localStorage(),
getUser:()=>({name:'reviewer'}),getRoute:()=>location.pathname});document.head.appendChild(s)})()
```

* Default adapter is `localStorage`; export writes a JSON/Markdown file (FR-6.2).
* Pages with a strict CSP that forbids external scripts will block the loader — documented
  limitation with the workaround (self-hosted mode or extension) (NFR-6).
* No `eval`, no inline handlers.

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
| E2E | `examples/vanilla` fixture: annotate text/design, quote capture, filters, done-hidden default, settings, feedback mode, decision thread, export, bulk delete | Playwright |
| Host integration | React example: mount/unmount, no leaks, host-supplied theme | Playwright |
| Size guard | bundle budget (NFR-3) | CI check |
| A11y | keyboard-only path, contrast of layer surfaces | Playwright + axe |
| Manual round | annotate a real page with ~20 notes, export, work off, purge | checklist in `docs/` |

The fixture app exists so that every FR group has a reproducible target; it doubles as the
demo page (M3).

## 10. Mapping from the proven prototype

The reference prototype (vanilla JS + tiny stdlib server, ~700 lines) maps as follows:

| Prototype part | bluepencil destination |
|---|---|
| DOM overlay, two modes, composer, markers (`comments.js/css`) | `src/ui/*` (TS, prefixed classes, token-driven) |
| Exit/quote capture, selector derivation | `src/core/anchor.ts`, `src/core/capture.ts` |
| Comment lifecycle incl. intent/status/thread | `src/core/model.ts`, `src/core/protocol.ts` |
| Markdown mirror + JSON store | `src/core/export/*` |
| Stdlib server with API + exports | `server/` (reference implementation, mode "sidecar") |
| Auto-commit of the note store | optional host feature, documented (not a library concern) |
| Watchdog/keep-alive for the serving process | deployment concern, documented in the server README |

Everything the prototype proved is a `P`-marked requirement; everything it lacked is a `G`
gap that this architecture addresses through adapters, a published schema, packaging,
host hooks and the MCP/agent interface.

## 11. Release plan

* **M1** — `0.1.0`: core + UI + memory/localStorage adapters + Markdown/JSON export + fixture app
  + unit/E2E tests. Exit: annotate any page, reload, export, no server involved.
* **M2** — `0.2.0`: HTTP adapter + reference server + sessions + bulk/session deletion +
  deterministic exports.
* **M3** — `0.3.0`: IIFE build, bookmarklet, React wrapper, theming docs, size guard.
* **M4** — `0.4.0`: MCP tool group + protocol doc + retention option.
* **M5** — `0.5.0`: product integration guide (RBAC, audit, purge) with a worked example.
* **M6** — `1.0.0`: i18n (en/de), a11y audit, docs site, API freeze (semver commitment).

Each release: one tag, one changelog entry, one demo screenshot/GIF in the README.
