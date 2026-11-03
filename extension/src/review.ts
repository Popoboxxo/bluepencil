/// <reference path="./review-data.d.ts" />
/**
 * The per-origin review page: aggregate every note store of this profile, render it as text.
 *
 * Since 0.12 the extension keeps one note set per page origin (`bluepencil:v2:<origin>`, G5) plus
 * the untouched pre-0.12 blob (`bluepencil:default:v1`). A reviewer who wants to see what is
 * actually stored — and, from B.2's assign half on, to copy a legacy note into an origin — needs
 * *all* of it in one place. This module builds that view.
 *
 * Two invariants shape the code:
 *
 *   1. **The key wins.** A group's identity comes from its storage key, never from `note.origin`. A
 *      note whose own origin disagrees with its key is shown, flagged and listed in `mismatched`;
 *      `note.origin` itself is not rewritten.
 *   2. **Text only.** Every untrusted value is written with `textContent`/`dataset`. There is no
 *      `innerHTML`, no `insertAdjacentHTML`, no `document.write` and no HTML construction of any
 *      kind in this file — a note body is whatever the annotator typed, and it is never markup.
 *
 * The page also performs **no network request**: it reads `chrome.storage.local` (the extension's
 * own local area) and renders. The CSP in `review.html` states the same thing (`connect-src
 * 'none'`), and the unit suite scans both files for network APIs so the property cannot regress
 * silently.
 *
 * Note parsing and key classification are imported from the built data bundle `dist/data.js`, not
 * re-implemented here (FR-15.3); the same holds for the code-unit comparator the page sorts with.
 * The declaration in `review-data.d.ts` describes that surface; the
 * `extension/build.mjs` build bundles the artefact into `review.js`.
 */
import {
  beginAssign,
  commitAssign,
  commitUndoAssign,
  compareCodeUnits,
  migrateNote,
  parseAssignProvenance,
  parseNoteSet,
  parseNotesStorageKey,
  planAssignToOrigin,
  planUndoAssign,
  assignProvenanceKey,
} from "../../dist/data.js";
import type {
  AssignCommitResult,
  AssignErrorCode,
  AssignIo,
  Note,
  NoteOrigin,
  UndoCommitResult,
} from "../../dist/data.js";

/**
 * One note as the review page sees it.
 *
 * `keyOrigin` is the group's origin (from the storage key), `mismatch` says the note's own origin
 * disagrees with it, and `duplicate` says the same id appears in another store. The note object is
 * the stored one — the page never rewrites it (copy-only assign is a separate step, T-B5).
 */
export interface OriginNoteView {
  note: Note;
  keyOrigin: NoteOrigin;
  mismatch: boolean;
  duplicate: boolean;
}

/**
 * One storage group of the profile: a per-origin note set, or the legacy blob.
 *
 * `origin` is `null` for the legacy group (the key carries no origin). `key` is the literal
 * `chrome.storage` key. A blob that cannot be parsed keeps its group, with `notes: []` and an
 * `error`, so one broken store does not hide the readable ones.
 */
export interface OriginGroup {
  origin: NoteOrigin;
  legacy: boolean;
  key: string;
  notes: OriginNoteView[];
  mismatched: string[];
  error?: { code: "corrupt_blob"; message: string };
}

/** A classified key, derived from the parser so the two cannot disagree. */
type ParsedKey = NonNullable<ReturnType<typeof parseNotesStorageKey>>;

/**
 * The slice of `chrome.storage.local` this page uses.
 *
 * `get` is all the read-only rendering needs; `set` is optional on purpose, because a caller may
 * hand the page a read-only area (tests, a future read-only surface). Without `set` the page
 * renders the stores but offers no assign/undo action.
 */
export interface ReviewStorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set?(items: Record<string, string>): Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Origin groups ascending, the legacy blob last.
 *
 * AC-B07: two origin groups sort ascending; the pre-0.12 blob is always the last section, because
 * it is the copy source, not a peer origin.
 */
function compareGroups(a: OriginGroup, b: OriginGroup): number {
  if (a.legacy !== b.legacy) {
    return a.legacy ? 1 : -1;
  }
  if (!a.legacy) {
    const byOrigin = compareCodeUnits(a.origin ?? "", b.origin ?? "");
    if (byOrigin !== 0) {
      return byOrigin;
    }
  }
  return compareCodeUnits(a.key, b.key);
}

/** Turn one storage entry into a group. Total: a bad value becomes `error`, never a throw. */
function decodeGroup(key: string, parsed: ParsedKey, raw: unknown): OriginGroup {
  const legacy = parsed.kind === "legacy";
  const origin: NoteOrigin = parsed.kind === "origin" ? parsed.origin : null;
  const group: OriginGroup = { origin, legacy, key, notes: [], mismatched: [] };

  if (raw === null || raw === undefined) {
    // A key that exists but carries nothing is an empty set, not a broken one.
    return group;
  }
  if (typeof raw !== "string") {
    group.error = {
      code: "corrupt_blob",
      message: `the note set at ${key} is not stored as text`,
    };
    return group;
  }

  let stored: Note[];
  try {
    // `parseNoteSet` is the one decoder of a stored blob; `migrateNote` then carries a note
    // written by an older version forward to the current schema. Neither is re-implemented here.
    stored = parseNoteSet(raw).map((note) => migrateNote(note));
  } catch (error) {
    group.error = { code: "corrupt_blob", message: messageOf(error) };
    return group;
  }

  for (const note of stored) {
    // The key wins (B.2): compare the note's own origin against the group's, never the reverse.
    const mismatch = (note.origin ?? null) !== origin;
    if (mismatch) {
      group.mismatched.push(note.id);
    }
    group.notes.push({ note, keyOrigin: origin, mismatch, duplicate: false });
  }
  return group;
}

/**
 * Mark every id that occurs in more than one group — in *each* affected view (B.2 Dedupe).
 *
 * Legacy and origin groups both participate: a legacy note that was copied to an origin keeps its
 * id, so both rows are flagged and the renderer can show the note body once.
 */
function markDuplicates(groups: readonly OriginGroup[]): void {
  const counts = new Map<string, number>();
  for (const group of groups) {
    for (const view of group.notes) {
      counts.set(view.note.id, (counts.get(view.note.id) ?? 0) + 1);
    }
  }
  for (const group of groups) {
    for (const view of group.notes) {
      view.duplicate = (counts.get(view.note.id) ?? 0) > 1;
    }
  }
}

/**
 * Aggregate raw `chrome.storage.local` entries into the review model (AC-B07, AC-B08, AC-B33).
 *
 * Only note stores become groups: `bluepencil:v2:<origin>` and `bluepencil:default:v1`.
 * `bluepencil:settings`, `bluepencil:ui:*` and the assign sidecar `bluepencil:assign:*` are not
 * note sets and are ignored. Groups are returned origin-ascending with the legacy blob last.
 */
export function aggregateOriginStores(entries: Record<string, unknown>): OriginGroup[] {
  const groups: OriginGroup[] = [];
  for (const key of Object.keys(entries).sort(compareCodeUnits)) {
    const parsed = parseNotesStorageKey(key);
    if (parsed === null) {
      continue;
    }
    groups.push(decodeGroup(key, parsed, entries[key]));
  }
  groups.sort(compareGroups);
  markDuplicates(groups);
  return groups;
}

/** Read the profile's stores and aggregate them. The only storage access of this page. */
export async function loadReviewGroups(area: ReviewStorageArea): Promise<OriginGroup[]> {
  return aggregateOriginStores(await area.get(null));
}

/** A one-line count for the status line; no note text, so the line cannot be spoofed. */
export function reviewSummary(groups: readonly OriginGroup[]): string {
  const notes = groups.reduce((sum, group) => sum + group.notes.length, 0);
  const unreadable = groups.filter((group) => group.error !== undefined).length;
  const stores = `${groups.length} store${groups.length === 1 ? "" : "s"}`;
  const count = `${notes} note${notes === 1 ? "" : "s"}`;
  return unreadable === 0
    ? `${stores}, ${count}.`
    : `${stores}, ${count}, ${unreadable} unreadable.`;
}

// --- Copy-only assign and provenance-based undo (B.2) ------------------------------------------

/** What the page can tell the user before an assign writes anything. */
export type ReviewAssignPreview =
  | { ok: true; origin: string; copies: number; skipped: string[]; label: string }
  | { ok: false; code: AssignErrorCode; message: string };

/** What the page can tell the user before an undo writes anything. */
export type ReviewUndoPreview =
  | {
      ok: true;
      origin: string;
      copies: number;
      removed: string[];
      skipped: string[];
      label: string;
    }
  | { ok: false; code: "invalid_origin" | "unknown_note" | "corrupt_source"; message: string };

/**
 * The confirm-before-write sentence for an assign.
 *
 * It names the **normalised** target origin and the number of copies, so the confirmation shows
 * exactly which store gains notes — never the raw input the user typed.
 */
export function assignConfirmation(origin: string, copies: number): string {
  return copies === 1 ? `Copy 1 note to ${origin}` : `Copy ${copies} notes to ${origin}`;
}

/** The confirm-before-write sentence for an undo (only proven copies are counted). */
export function undoConfirmation(origin: string, copies: number): string {
  return copies === 1
    ? `Remove 1 copied note from ${origin}`
    : `Remove ${copies} copied notes from ${origin}`;
}

/** Plan an assign for the page; a refusal is rendered instead of a commit button (AC-B44). */
export function previewAssign(
  entries: Record<string, unknown>,
  request: { ids: readonly string[]; origin: unknown },
): ReviewAssignPreview {
  const planned = planAssignToOrigin(entries, request);
  if (!planned.ok) {
    return { ok: false, code: planned.code, message: planned.message };
  }
  const copies = planned.plan.moved.length;
  return {
    ok: true,
    origin: planned.plan.targetOrigin,
    copies,
    skipped: planned.plan.skipped,
    label: assignConfirmation(planned.plan.targetOrigin, copies),
  };
}

/**
 * Plan an undo for the page. The caller passes the sidecar's ids, so an undo button only ever
 * offers proven copies (RVW2-04).
 */
export function previewUndo(
  entries: Record<string, unknown>,
  request: { ids: readonly string[]; origin: unknown },
): ReviewUndoPreview {
  const planned = planUndoAssign(entries, request);
  if (!planned.ok) {
    return { ok: false, code: planned.code, message: planned.message };
  }
  const copies = planned.plan.removed.length;
  return {
    ok: true,
    origin: planned.plan.targetOrigin,
    copies,
    removed: planned.plan.removed,
    skipped: planned.plan.skipped,
    label: undoConfirmation(planned.plan.targetOrigin, copies),
  };
}

/** One action the page renders as a button: assign legacy notes, or undo proven copies. */
export interface ReviewAction {
  kind: "assign" | "undo";
  origin: string;
  copies: number;
  ids: string[];
  label: string;
}

/**
 * The actions the page may offer for this profile.
 *
 * Assign ids come from the legacy group (copy source). Undo ids come **only** from the origin's
 * assign sidecar — the page never offers to delete a note it cannot prove it copied. A corrupt
 * note store makes `planAssignToOrigin` fail, so no assign button appears for any target.
 */
export function reviewActions(entries: Record<string, unknown>): ReviewAction[] {
  const groups = aggregateOriginStores(entries);
  const legacy = groups.find((group) => group.legacy);
  const legacyIds = legacy === undefined ? [] : legacy.notes.map((view) => view.note.id);
  const actions: ReviewAction[] = [];

  for (const group of groups) {
    if (group.legacy || group.origin === null) {
      continue;
    }
    const origin = group.origin;
    const assign = previewAssign(entries, { ids: legacyIds, origin });
    if (assign.ok && assign.copies > 0) {
      actions.push({
        kind: "assign",
        origin: assign.origin,
        copies: assign.copies,
        ids: legacyIds,
        label: assign.label,
      });
    }

    const provenance = parseAssignProvenance(entries[assignProvenanceKey(origin)]);
    const provenIds = Object.keys(provenance);
    const undo = previewUndo(entries, { ids: provenIds, origin });
    if (undo.ok && undo.copies > 0) {
      actions.push({
        kind: "undo",
        origin: undo.origin,
        copies: undo.copies,
        ids: provenIds,
        label: undo.label,
      });
    }
  }
  return actions;
}

/** The outcome of a confirmed write, rendered as one status line. */
export type ReviewActionResult =
  | { ok: true; kind: "assign" | "undo"; origin: string; count: number }
  | { ok: false; code: string; message: string };

function writeRefusal(code: string): ReviewActionResult {
  const message =
    code === "stale_plan"
      ? "The store changed while you were reviewing; reload and try again."
      : code === "storage_failure"
        ? "The write did not reach the local store; nothing was changed."
        : code === "declined"
          ? "Nothing was written."
          : `The action was refused (${code}).`;
  return { ok: false, code, message };
}

function commitOutcome(
  kind: "assign" | "undo",
  origin: string,
  count: number,
): ReviewActionResult {
  return { ok: true, kind, origin, count };
}

/**
 * Confirm and perform an assign through the page's storage area.
 *
 * The plan is made from a fresh read, the confirmation names the normalised origin and the number
 * of copies, and only a confirmed plan reaches `commitAssign` (which writes the target blob and
 * the sidecar in one `set`). The legacy key is never part of that write.
 */
export async function applyAssign(
  area: ReviewStorageArea,
  request: { ids: readonly string[]; origin: unknown },
  confirm: (message: string) => boolean,
): Promise<ReviewActionResult> {
  if (area.set === undefined) {
    return writeRefusal("unavailable");
  }
  const entries = await area.get(null);
  const preview = previewAssign(entries, request);
  if (!preview.ok) {
    return writeRefusal(preview.code);
  }
  if (preview.copies === 0) {
    return commitOutcome("assign", preview.origin, 0);
  }
  if (!confirm(preview.label)) {
    return writeRefusal("declined");
  }

  const state = beginAssign(entries, request);
  state.confirmed = true;
  const io: AssignIo = {
    get: (keys) => area.get(keys),
    set: (items) => (area.set as (items: Record<string, string>) => Promise<void>)(items),
  };
  const result: AssignCommitResult = await commitAssign(state, io);
  return result.ok
    ? commitOutcome("assign", preview.origin, result.added.length)
    : writeRefusal(result.code);
}

/** Confirm and perform a provenance-based undo through the page's storage area. */
export async function applyUndo(
  area: ReviewStorageArea,
  request: { ids: readonly string[]; origin: unknown },
  confirm: (message: string) => boolean,
): Promise<ReviewActionResult> {
  if (area.set === undefined) {
    return writeRefusal("unavailable");
  }
  const entries = await area.get(null);
  const planned = planUndoAssign(entries, request);
  if (!planned.ok) {
    return writeRefusal(planned.code);
  }
  const cleanupOnly =
    planned.plan.removed.length === 0 &&
    Object.keys(planned.plan.remainingProvenance).length !==
      Object.keys(planned.plan.baseProvenance).length;
  if (planned.plan.removed.length === 0 && !cleanupOnly) {
    return commitOutcome("undo", planned.plan.targetOrigin, 0);
  }
  // Removing copies is confirmed; cleaning a stale sidecar entry deletes no note, so it is not.
  if (planned.plan.removed.length > 0 && !confirm(undoConfirmation(planned.plan.targetOrigin, planned.plan.removed.length))) {
    return writeRefusal("declined");
  }
  const io: AssignIo = {
    get: (keys) => area.get(keys),
    set: (items) => (area.set as (items: Record<string, string>) => Promise<void>)(items),
  };
  const result: UndoCommitResult = await commitUndoAssign(
    { plan: planned.plan, confirmed: true },
    io,
  );
  return result.ok
    ? commitOutcome("undo", planned.plan.targetOrigin, result.removed.length)
    : writeRefusal(result.code);
}

/** Render the action buttons. Labels are `textContent`; nothing here builds markup. */
function renderActions(
  doc: Document,
  container: Element,
  actions: readonly ReviewAction[],
  onAction: (action: ReviewAction) => void,
): void {
  if (actions.length === 0) {
    return;
  }
  const section = doc.createElement("section");
  section.className = "bp-review-actions";
  const heading = doc.createElement("h2");
  heading.textContent = "Assign and undo";
  section.append(heading);

  for (const action of actions) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "bp-review-action";
    button.dataset.action = action.kind;
    button.dataset.origin = action.origin;
    button.dataset.copies = String(action.copies);
    button.textContent = action.label;
    button.addEventListener("click", () => {
      onAction(action);
    });
    section.append(button);
  }
  container.append(section);
}

/** Append a text-only paragraph. The single place that turns a string into page content. */
function paragraph(doc: Document, className: string, value: string): HTMLParagraphElement {
  const element = doc.createElement("p");
  element.className = className;
  element.textContent = value;
  return element;
}

/** The origin a duplicated id is shown under: the first non-legacy store that carries it. */
function canonicalOrigins(groups: readonly OriginGroup[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const group of groups) {
    if (group.legacy) {
      continue;
    }
    const origin = group.origin ?? "";
    for (const view of group.notes) {
      if (!map.has(view.note.id)) {
        map.set(view.note.id, origin);
      }
    }
  }
  return map;
}

/**
 * Render one note. Every field is text: id, body, type and status come from stored data and are
 * written with `textContent`. Flags are `dataset`, never attributes built from content.
 */
function renderNote(doc: Document, view: OriginNoteView): HTMLLIElement {
  const item = doc.createElement("li");
  item.className = "bp-review-note";
  item.dataset.noteId = view.note.id;
  if (view.mismatch) {
    item.dataset.mismatch = "true";
  }
  if (view.duplicate) {
    item.dataset.duplicate = "true";
  }

  item.append(paragraph(doc, "bp-review-body", view.note.body || "(empty note)"));

  const meta = doc.createElement("p");
  meta.className = "bp-review-meta";
  const ownOrigin = view.note.origin ?? "unassigned";
  meta.textContent = `${view.note.type} · ${view.note.status} · ${view.note.id} · origin ${ownOrigin}`;
  item.append(meta);

  if (view.mismatch) {
    item.append(
      paragraph(
        doc,
        "bp-review-flag",
        `origin mismatch — the key says ${view.keyOrigin ?? "no origin"}, the note says ${ownOrigin}`,
      ),
    );
  }
  if (view.duplicate) {
    item.append(paragraph(doc, "bp-review-flag", "duplicate — the same id exists in another store"));
  }
  return item;
}

/** Render a legacy row that is a copy of a note already shown in an origin store. */
function renderLegacyCopy(doc: Document, view: OriginNoteView, shownUnder: string): HTMLLIElement {
  const item = doc.createElement("li");
  item.className = "bp-review-copy";
  item.dataset.noteId = view.note.id;
  item.dataset.duplicate = "true";
  item.textContent = `Copy of note ${view.note.id} — shown under ${shownUnder}`;
  return item;
}

/**
 * Render the whole review model into `container` (text only).
 *
 * The container is cleared with `replaceChildren()` — not `innerHTML = ""` — and every section,
 * row and label is created with the `Document` API and filled with `textContent`.
 */
export function renderReview(
  doc: Document,
  container: Element,
  groups: readonly OriginGroup[],
): void {
  container.replaceChildren();
  if (groups.length === 0) {
    container.append(paragraph(doc, "bp-review-empty", "No notes are stored in this profile."));
    return;
  }

  const shownUnder = canonicalOrigins(groups);
  for (const group of groups) {
    const section = doc.createElement("section");
    section.className = "bp-review-group";
    section.dataset.key = group.key;
    if (group.legacy) {
      section.dataset.legacy = "true";
    }

    const heading = doc.createElement("h2");
    heading.textContent = group.legacy
      ? "Legacy notes (pre-0.12)"
      : (group.origin ?? "Unassigned");
    section.append(heading);
    section.append(paragraph(doc, "bp-review-key", group.key));

    if (group.error !== undefined) {
      section.dataset.error = group.error.code;
      section.append(
        paragraph(doc, "bp-review-error", `This store cannot be read: ${group.error.message}`),
      );
      container.append(section);
      continue;
    }

    if (group.mismatched.length > 0) {
      section.append(
        paragraph(
          doc,
          "bp-review-flag",
          `Notes whose own origin disagrees with the key: ${group.mismatched.join(", ")}`,
        ),
      );
    }

    const list = doc.createElement("ul");
    for (const view of group.notes) {
      const copyUnder = group.legacy && view.duplicate ? shownUnder.get(view.note.id) : undefined;
      list.append(
        copyUnder === undefined ? renderNote(doc, view) : renderLegacyCopy(doc, view, copyUnder),
      );
    }
    if (group.notes.length === 0) {
      list.append(paragraph(doc, "bp-review-empty", "This store is empty."));
    }
    section.append(list);
    container.append(section);
  }
}

/**
 * Read the stores and render the page. The only I/O is `area.get(null)` — no network, no write.
 */
export async function runReviewPage(
  doc: Document,
  area: ReviewStorageArea,
  container: Element,
  deps: ReviewPageDeps = {},
): Promise<void> {
  const status = doc.getElementById("review-status");
  if (status !== null) {
    status.textContent = "Reading the local stores…";
  }
  const entries = await area.get(null);
  const groups = aggregateOriginStores(entries);
  renderReview(doc, container, groups);
  if (status !== null) {
    status.textContent = reviewSummary(groups);
  }

  if (area.set === undefined) {
    // Read-only area: the groups are still shown, but no write action is offered.
    return;
  }
  const confirm = deps.confirm ?? browserConfirm;
  renderActions(doc, container, reviewActions(entries), (action) => {
    void performAction(area, action, confirm).then(async (result) => {
      await runReviewPage(doc, area, container, deps);
      if (status === null) {
        return;
      }
      if (!result.ok) {
        status.textContent = result.message;
      } else if (result.kind === "assign") {
        status.textContent = `Copied ${result.count} note${result.count === 1 ? "" : "s"} to ${result.origin}.`;
      } else {
        status.textContent = `Removed ${result.count} copied note${result.count === 1 ? "" : "s"} from ${result.origin}.`;
      }
    });
  });
}

/** The browser's confirmation dialog; no dialog available means no write. */
function browserConfirm(message: string): boolean {
  const confirm = (globalThis as { confirm?: (text: string) => boolean }).confirm;
  return typeof confirm === "function" ? confirm(message) : false;
}

function performAction(
  area: ReviewStorageArea,
  action: ReviewAction,
  confirm: (message: string) => boolean,
): Promise<ReviewActionResult> {
  const request = { ids: action.ids, origin: action.origin };
  return action.kind === "assign"
    ? applyAssign(area, request, confirm)
    : applyUndo(area, request, confirm);
}

/** Optional dependencies of the page's action wiring (a test injects its own confirmation). */
export interface ReviewPageDeps {
  confirm?: (message: string) => boolean;
}

/** The page's own `chrome` surface. Declared locally; the extension ships no `@types/chrome`. */
interface ReviewChrome {
  storage?: { local?: ReviewStorageArea };
}

/**
 * Start the page when it is loaded as `review.html`.
 *
 * Guarded three ways so importing this module in a test (or in any non-extension document) does
 * nothing: `document` must exist, `chrome.storage.local` must be there, and the page's root
 * element must be present.
 */
function autoStart(): void {
  if (typeof document === "undefined") {
    return;
  }
  const chromeApi = (globalThis as { chrome?: ReviewChrome }).chrome;
  const area = chromeApi?.storage?.local;
  const container = document.getElementById("review-root");
  if (area === undefined || container === null) {
    return;
  }
  void runReviewPage(document, area, container).catch((error: unknown) => {
    const status = document.getElementById("review-status");
    if (status !== null) {
      status.textContent = `The notes could not be read: ${messageOf(error)}`;
    }
  });
}

autoStart();
