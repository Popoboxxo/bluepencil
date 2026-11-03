/**
 * The types of the *built* headless data bundle `extension/src/review.ts` imports.
 *
 * ## Why a declaration instead of the real module
 *
 * The review page must not re-implement note parsing, key classification or the assign plan: the
 * data layer in `src/data` is the one implementation every surface shares (FR-15.3). But the page
 * is also an extension page, so it imports the **artefact** a host gets too — `dist/data.js`,
 * bundled into `review.js` by `extension/build.mjs`. Bundling the source instead would give the
 * page a second copy of the layer that can drift from the published subpath.
 *
 * That artefact is generated and not committed, which leaves the same three options the element
 * declaration (`bluepencil-element.d.ts`) already describes: a typecheck that depends on build
 * order, no typecheck at all, or one declaration of the surface the page actually uses. This file
 * is the third option.
 *
 * ## What it covers
 *
 * Exactly contract B.2's review-page import surface (§3.2 B.2): the note-set codec, the storage-key
 * helpers, the origin parser and the copy-only assign/undo functions. The assign half is declared
 * here although it lands with T-B5 — `review-data.d.ts` is not in T-B5's write set, so a page that
 * adds `planAssignToOrigin` later must not have to grow a declaration file in the same commit (and
 * the type surface is part of this task's contract, not the implementation's).
 *
 * The wildcard keeps the declaration attached to the path `review.ts` writes. A wildcard
 * declaration is used because a relative ambient module name is not allowed; it matches
 * `"../../dist/data.js"` the same way `bluepencil-element.d.ts` matches
 * `"../../dist/bluepencil.element.js"`.
 */
declare module "*/dist/data.js" {
  // Types are imported through `import(...)` rather than a top-level `import`: a top-level import
  // would turn this file into a module, and `declare module` would then be an augmentation of a
  // module that does not exist as a file name.
  export type NoteOrigin = import("../../src/core/model").NoteOrigin;
  export type Note = import("../../src/core/model").Note;

  /** The pre-0.12 shared blob. Read-only for the extension; never written by the review page. */
  export const LEGACY_STORAGE_KEY: string;

  /** What a `chrome.storage` key means: a per-origin note set, or the legacy shared blob. */
  export type ParsedNotesKey =
    | { kind: "origin"; origin: string }
    | { kind: "legacy" };

  /** Classify a storage key; `null` for settings, UI state and the assign sidecar. */
  export function parseNotesStorageKey(key: string): ParsedNotesKey | null;

  /** The key for a canonical origin, or `null` when there is no bucket. */
  export function chromeStorageKeyForOrigin(origin: NoteOrigin): string | null;

  /** Reads a stored note set. Throws `BluepencilValidationError` for a corrupt blob. */
  export function parseNoteSet(text: string | null): Note[];

  /** Upgrade one stored document to the current note schema (never mutates its input). */
  export function migrateNote(value: unknown): Note;

  /** Normalise any value to a canonical origin or `null` (FR-2.2). */
  export function normaliseOrigin(value: unknown): NoteOrigin;

  /** Strict parser for the boundary: a canonical origin or a named refusal (G5). */
  export function parseOriginInput(
    value: unknown,
  ): { ok: true; origin: NoteOrigin } | { ok: false; code: "invalid_origin" };

  // --- Copy-only assign and provenance-based undo (B.2; implementation lands with T-B5) --------

  /** Note id → ISO timestamp of the copy that was made into this origin's store. */
  export type AssignProvenance = Record<string, string>;

  /** The sidecar key for one origin: `bluepencil:assign:<origin>`. */
  export function assignProvenanceKey(origin: string): string;

  /** Parse the sidecar value. Total: a non-object yields `{}` instead of throwing. */
  export function parseAssignProvenance(raw: unknown): AssignProvenance;

  export interface AssignPlan {
    targetKey: string;
    targetOrigin: string;
    provenanceKey: string;
    baseText: string;
    baseProvenance: AssignProvenance;
    notes: Note[];
    moved: string[];
    skipped: string[];
  }

  export type AssignErrorCode =
    | "invalid_origin"
    | "empty_selection"
    | "unknown_note"
    | "conflict"
    | "corrupt_source";

  export type AssignToOriginResult =
    | { ok: true; plan: AssignPlan }
    | { ok: false; code: AssignErrorCode; message: string };

  export function planAssignToOrigin(
    entries: Record<string, unknown>,
    request: { ids: readonly string[]; origin: unknown; now?: string },
  ): AssignToOriginResult;

  export interface AssignState {
    plan: AssignPlan | null;
    confirmed: boolean;
  }

  export function beginAssign(
    entries: Record<string, unknown>,
    request: { ids: readonly string[]; origin: unknown; now?: string },
  ): AssignState;

  export interface AssignIo {
    get(keys: string | string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, string>): Promise<void>;
  }

  export type AssignCommitResult =
    | { ok: true; added: string[]; skipped: string[] }
    | { ok: false; code: "not_confirmed" | "stale_plan" | "storage_failure" };

  export function commitAssign(state: AssignState, io: AssignIo): Promise<AssignCommitResult>;

  export interface UndoPlan {
    targetKey: string;
    targetOrigin: string;
    provenanceKey: string;
    baseText: string;
    remainingText: string;
    baseProvenance: AssignProvenance;
    remainingProvenance: AssignProvenance;
    removed: string[];
    skipped: string[];
  }

  export interface UndoState {
    plan: UndoPlan | null;
    confirmed: boolean;
  }

  export function planUndoAssign(
    entries: Record<string, unknown>,
    request: { ids: readonly string[]; origin: unknown },
  ):
    | { ok: true; plan: UndoPlan }
    | { ok: false; code: "invalid_origin" | "unknown_note" | "corrupt_source"; message: string };

  export type UndoCommitResult =
    | { ok: true; removed: string[]; skipped: string[] }
    | { ok: false; code: "not_confirmed" | "stale_plan" | "storage_failure" };

  export function commitUndoAssign(state: UndoState, io: AssignIo): Promise<UndoCommitResult>;
}
