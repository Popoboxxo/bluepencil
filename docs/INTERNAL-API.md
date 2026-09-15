# Internal API contract — bluepencil M1

> Frozen module boundaries for the first implementation (M1, `0.1.0`).
> Normative sources: [REQUIREMENTS.md](REQUIREMENTS.md), [ARCHITECTURE.md](ARCHITECTURE.md),
> [PROTOCOL.md](PROTOCOL.md). Types: `src/core/model.ts` — **import, never redeclare.**
>
> Rule: every module below imports its types from `src/core/model.ts`. Nothing in `src/data`
> may touch the DOM; nothing in `src/core` may import from `src/ui`. The UI talks to the
> `Store`, never to an adapter (ARCHITECTURE §4).

---

## 0. Ground rules for every module

* TypeScript strict, ESM, **no runtime dependencies** (NFR-4), no `any` in exported signatures.
* All user-visible strings come from `src/i18n`; all user text is rendered as **text** (FR-9.3).
* Nothing may call `eval`/`new Function` (NFR-6); no timers/polling (NFR-2).
* Errors are surfaced through the caller's `onError`/`console.debug`, never thrown into the page.
* Every module ships unit tests under `tests/unit/<module>.test.ts` (vitest, jsdom).

## 1. `src/core/adapter.ts` — transport contract

```ts
import type { Note, NoteDraft, NotePatch, NoteFilter } from "./model";

export interface Adapter {
  readonly name: string;
  list(filter?: NoteFilter): Promise<Note[]>;
  create(draft: NoteDraft): Promise<Note>;
  update(id: string, patch: NotePatch): Promise<Note>;
  remove(id: string): Promise<void>;
  bulkRemove(filter: NoteFilter): Promise<{ removed: number }>;
  exportSession(sessionRef: string): Promise<Note[]>;
  subscribe?(cb: (notes: Note[]) => void): () => void;
}

export type AdapterName = "memory" | "localStorage" | "file" | "http";
export type AdapterLike = Adapter | AdapterName;
```

## 2. `src/core/store.ts` — single source of truth (FR-6.1, FR-13.1)

```ts
export interface StoreOptions {
  adapter?: AdapterLike | (() => Adapter);
  sessionRef?: string;
  environment?: Environment;
  now?: () => string;
}

export interface Store {
  readonly adapterName: string;
  /** Synchronous snapshot of the in-memory list (the authoritative set). */
  notes(): Note[];
  list(filter?: NoteFilter): Promise<Note[]>;
  get(id: string): Promise<Note | undefined>;
  create(draft: NoteDraft): Promise<Note>;
  update(id: string, patch: NotePatch): Promise<Note>;
  remove(id: string): Promise<void>;
  bulkRemove(filter: NoteFilter): Promise<{ removed: number }>;
  exportSession(sessionRef: string): Promise<Note[]>;
  /** Append a protocol message (thread is append-only). */
  addMessage(id: string, message: Message): Promise<Note>;
  reply(id: string, input: { text: string; author?: string; authorType?: AuthorType; kind?: MessageKind; }): Promise<Note>;
  setStatus(id: string, status: NoteStatus): Promise<Note>;
  setIntent(id: string, intent: NoteIntent): Promise<Note>;
  subscribe(cb: (notes: Note[]) => void): () => void;
  reload(): Promise<void>;
  destroy(): Promise<void>;
}

export function createStore(options?: StoreOptions): Store;
```

Rules: the store holds the authoritative list, applies all mutations optimistically to memory and
then to the adapter; a failing adapter must never lose the in-memory change silently — it reports
through the returned promise. `subscribe` fires immediately with the current list and again after
every change. Adapter names resolve to the built-in adapters (`memory`, `localStorage`, `file`,
`http`); `localStorage`/`file` fall back to `memory` when the environment cannot provide them
(NFR-8) and report it once through `console.debug`.

## 3. `src/adapters/*.ts`

| File | Factory | Notes |
|---|---|---|
| `memory.ts` | `createMemoryAdapter(options?: { seed?: Note[] })` | ephemeral, `name = "memory"` |
| `local-storage.ts` | `createLocalStorageAdapter(options?: { key?: string; storage?: Storage })` | key `bluepencil:<host>:<instance>:v1`, atomic write, falls back to memory (FR-6.2) |
| `file.ts` | `createFileAdapter(options: { read(): Promise<string\|null>; write(text: string): Promise<void>; })` | host provides I/O; used by the CLI and by browser import/export (FR-14.7) |
| `http.ts` | `createHttpAdapter(options: { endpoint: string; headers?: () => Record<string,string>; fetchImpl?: typeof fetch })` | **thin** REST client for ARCHITECTURE §5, no business logic |

All four must pass the same conformance suite (`tests/unit/adapters.test.ts`) — that suite is part
of the deliverable (FR-6.1).

## 4. `src/core/anchor.ts` — anchoring (FR-2.x, FR-12.4)

```ts
export interface AnchorOptions { hooks?: string[]; root?: ParentNode; }

export function hookValue(el: Element, hooks?: string[]): string | undefined;
export function deriveAnchor(el: Element, options?: AnchorOptions & { route?: string; quote?: string }): Anchor;
export function resolveAnchor(anchor: Anchor, options?: AnchorOptions): Element | null;
export function resolvePath(path: string, root?: ParentNode): Element | null;
export function findQuote(quote: string, root?: ParentNode): Element | null;
export function cssPath(el: Element, hooks?: string[]): string;
export function composePath(el: Element): string;      // encodes shadow boundaries as " >> "
export function describeElement(el: Element): string;  // short human label for the list
```

Rules: default hooks are `["data-bluepencil", "data-testid"]` (D6). `deriveAnchor` stores hook,
selector, quote and route when available. `resolveAnchor` tries hook → selector → quote (FR-2.1)
and, when nothing resolves, returns `null` — the caller marks the note `anchor.orphaned = true`
(FR-2.4); a lost shadow root yields `anchor.degraded = "<segment>"`. Clicks must be evaluated on
`event.composedPath()` by the UI, not on `event.target`.

## 5. `src/core/capture.ts` — context capture (FR-1.4, FR-13.5)

```ts
export const STYLE_SUBSET: readonly string[];
export function captureContext(el: Element, options?: { buildRef?: string; view?: Window }): CapturedContext;
export function detectScheme(view?: Window): "light" | "dark";
export function selectionQuote(view?: Window): string | undefined;   // FR-1.5
```

The styles subset is a curated list (font-family, font-size, font-weight, line-height, color,
background-color, margin*, padding*, border*, border-radius, gap, display) — never all of
`getComputedStyle`. Missing APIs (no `ResizeObserver`, no `getComputedStyle`) must degrade, not throw.

## 6. `src/data/*` — headless library (FR-15.x, no DOM)

```ts
// schema.ts
export function validateNote(value: unknown): string[];              // [] === valid
export function validateBundle(value: unknown): string[];
export function assertNote(value: unknown): Note;                    // throws BluepencilValidationError
export function assertBundle(value: unknown): Bundle;

// canonical.ts (NFR-17)
export function canonicalNote(note: Note): Note;
export function canonicalBundle(bundle: Bundle): Bundle;
export function serializeCanonical(value: unknown): string;          // stable keys + order
export function hashBundle(bundle: Bundle): string;                  // FNV-1a hex, no deps

// bundle.ts (FR-14.2, FR-14.9)
export interface BundleOptions { exportedBy?: string; environment?: Environment; app?: { name: string; buildRef?: string }; sessions?: Session[]; now?: string; }
export function createBundle(notes: Note[], options?: BundleOptions): Bundle;
export function bundleToJson(bundle: Bundle, options?: { pretty?: boolean }): string;
export function parseBundle(text: string): Bundle;                   // throws on invalid
export function inspectBundle(bundle: Bundle): BundleSummary;
export interface BundleSummary { notes: number; sessions: Session[]; environments: Environment[]; byStatus: Record<string, number>; byIntent: Record<string, number>; byType: Record<string, number>; routes: string[]; app?: { name: string; buildRef?: string }; }

// merge.ts (FR-14.3/14.4, NFR-18)
export type MergeMode = "merge" | "upsert" | "replace-session";
export interface MergeOptions { mode?: MergeMode; dryRun?: boolean; allowEnvMismatch?: boolean; onConflict?: "fail" | "keep-incoming" | "keep-existing"; targetEnvironment?: Environment; }
export interface MergeConflict { id: string; reason: string; existingUpdatedAt: string; incomingUpdatedAt: string; }
export interface MergeResult { added: number; updated: number; skipped: number; removed: number; conflicts: MergeConflict[]; notes: Note[]; }
export function mergeNotes(existing: Note[], incoming: Note[], options?: MergeOptions): MergeResult;

// migrate.ts (FR-3.5, NFR-9)
export function migrateNote(value: unknown): Note;
export function migrateBundle(value: unknown): Bundle;

// index.ts re-exports schema/canonical/bundle/merge/migrate
```

Merge semantics: `merge` adds unknown ids and skips known ones (idempotent); `upsert` also updates
known notes whose canonical form (ignoring `updatedAt`) differs, and **concatenates** threads
(incoming messages appended, deduplicated by message id); `replace-session` removes the notes of
the sessions present in the incoming set, then applies `merge`. Conflicts (same id, divergent
content) are always **listed**, never silently resolved; without `onConflict` the write is refused
(`dryRun` still reports counts). An environment mismatch aborts with a clear error unless
`allowEnvMismatch` (NFR-18).

## 7. `src/core/export/{markdown,json}.ts`, `src/core/protocol.ts`

```ts
// export/markdown.ts (FR-5.6, FR-7.1)
export function toMarkdown(notes: Note[], options?: MarkdownOptions): string;
export function noteToMarkdown(note: Note, options?: MarkdownOptions): string;
export interface MarkdownOptions { language?: "en" | "de"; includeDone?: boolean; title?: string; generatedAt?: string; }

// export/json.ts (FR-7.2)
export function toJson(notes: Note[], options?: BundleOptions & { pretty?: boolean }): string;
export function fromJson(text: string): Note[];                       // bundle or bare Note[]

// protocol.ts (PROTOCOL.md, FR-5.4/5.5)
export function requestDecision(note: Note, input: { text: string; options?: string[]; recommendation?: string; author?: string; now?: string }): Note;
export function answerDecision(note: Note, input: { text: string; author?: string; now?: string }): Note;
export function respondFeedback(note: Note, input: { text: string; author?: string; now?: string }): Note;
export function completeNote(note: Note, input: { text: string; author?: string; source?: NoteSource; now?: string }): Note;
export function exceptionNotes(notes: Note[]): { decisions: Note[]; feedback: Note[] };
export function implementableNotes(notes: Note[]): Note[];
export function sortForReview(notes: Note[]): Note[];                 // FR-4.6
export function summarize(note: Note): string;                        // one-line list label
```

The Markdown export **opens** with `⚠ open decisions` and `💬 feedback only` (FR-5.6), then groups
by route, and prints quote, anchor, captured state and the full thread per note (FR-7.1). Ordering
is deterministic: route → status priority (needs_decision, feedback, open, done) → creation time
(NFR-10). `requestDecision` appends a `decision_request` and sets `needs_decision`; `answerDecision`
appends `decision` and returns the note to `open`; `respondFeedback` appends `feedback` and leaves
the status untouched (PROTOCOL §2/§6); `completeNote` appends `reply` **and** sets `done`.

## 8. `src/ui/*` + `src/i18n/*` — the review layer (FR-1.x, FR-4.x, FR-12.x)

```ts
export interface LayerOptions {
  store: Store;
  document?: Document;
  mount?: Element | Document;
  language?: string;
  theme?: Record<string, string>;
  anchorHooks?: string[];
  canAnnotate?: (el: Element) => boolean;
  getRoute?: () => string;
  identity?: { getUser?: () => { id?: string; name: string } } | "prompt" | "anonymous";
  markerStrategy?: "overlay" | "sibling";
  defaultShowDone?: boolean;
  buildRef?: string;
  onError?: (err: unknown) => void;
}

export interface LayerHandle {
  enable(): void;
  disable(): void;
  isEnabled(): boolean;
  refresh(): void;
  setShowDone(value: boolean): void;
}

export function createLayer(options: LayerOptions): LayerHandle;
```

* One host container per instance with `bp-`-prefixed classes; `enable()` builds it, `disable()`
  removes **everything** (nodes, listeners, observer, style node) — idempotent, N cycles, measured
  by tests (FR-12.1/12.2, NFR-15).
* Shortcuts: `C` text mode, `D` design mode, `L` panel, `F` feedback-only, `B` bar toggle,
  `?` legend, `Esc` cancel, `J`/`K` navigate the list, digits 1–9 jump to a note (FR-1.6/1.7).
* `a[href]`, form fields and `[data-bp-ignore]` are passed through **even while a mode is active**,
  and `stopPropagation()` is called only when a mode is active (FR-2.7, FR-12.6).
* Markers are overlay-positioned (`markerStrategy: "overlay"`, D2) and never change host layout
  (FR-1.8); `@media print` hides the whole layer (FR-1.9).
* Done notes are hidden by default in list **and** markers (D4, FR-4.3) with a one-click reveal.
* Styling only through `--bp-*` custom properties with fallbacks, single injected `<style>`
  (ARCHITECTURE §7, FR-10.3).

## 9. `src/index.ts` — public API (ARCHITECTURE §2)

```ts
export interface BlueprintConfig extends Omit<LayerOptions, "store"> {
  enabled?: () => boolean;      // evaluated on every enable() — fail closed
  adapter?: AdapterLike | (() => Adapter);
  sessionRef?: string;
  environment?: Environment;
  destroyOnDisable?: boolean;
}
export interface Blueprint {
  readonly store: Store;
  readonly layer: LayerHandle;
  enable(): void;
  disable(): void;
  isEnabled(): boolean;
  export(options?: { format?: "markdown" | "json"; }): string;
  destroy(): Promise<void>;
}
export function init(config?: BlueprintConfig): Blueprint;
export function mount(config?: BlueprintConfig): Blueprint;
```

`enabled()` returning false means: no DOM node, no request, no listener (FR-1.1, NFR-1).
