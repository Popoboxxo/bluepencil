/**
 * Copy-only assignment of legacy notes to an origin store, and provenance-based undo (B.2).
 *
 * Since 0.12 the extension keeps one note set per page origin (`bluepencil:v2:<origin>`). Notes
 * written before that live in the untouched shared blob (`bluepencil:default:v1`). Assign copies a
 * legacy note into an origin store **without moving it**: the legacy blob is never written, never
 * removed and never re-serialised (RVW-01). The copy keeps the note's id, so the same note is
 * visible in both stores until the user explicitly undoes the copy.
 *
 * That is exactly why undo needs proof. A sidecar (`bluepencil:assign:<origin>`, note id → ISO
 * timestamp) records which ids this surface actually copied into an origin (RVW2-04). Undo removes
 * an id from the target store only when the sidecar proves the copy; an id that was already there
 * (or was written by another surface) is `skipped`, never deleted.
 *
 * Both commits are compare-and-set over the whole target blob *and* the sidecar: the raw text and
 * the provenance read at plan time are compared with the values read immediately before writing.
 * A mismatch is `stale_plan` and nothing is written, so a concurrent change is never clobbered.
 *
 * The module is headless: no DOM, no `chrome`, no runtime dependency. Callers pass the entries a
 * `chrome.storage.local` read returns (`get(null)`) and an `AssignIo` for the write. That keeps the
 * review page, tests and any future surface on exactly one implementation (FR-15.3).
 */
import type { Note } from "../core/model";
import { systemClock } from "../core/model";
import { cloneNote, isRecord } from "../core/adapter";
import { parseOriginInput } from "../core/origin";
import { validateNote } from "./schema";
import { parseNoteSet, serializeNoteSet } from "./note-set";
import {
  ASSIGN_PROVENANCE_PREFIX,
  chromeStorageKeyForOrigin,
  parseNotesStorageKey,
} from "./origin";

/** Note id → ISO timestamp of the copy that was made into an origin's store. */
export type AssignProvenance = Record<string, string>;

/** The sidecar key for one origin: `bluepencil:assign:<origin>`. */
export function assignProvenanceKey(origin: string): string {
  return `${ASSIGN_PROVENANCE_PREFIX}${origin}`;
}

/**
 * Parse a stored sidecar value. Total by contract: a string that is not JSON, a JSON value that is
 * not an object, or a record with non-string timestamps all degrade to `{}` instead of throwing.
 */
export function parseAssignProvenance(raw: unknown): AssignProvenance {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return {};
    }
  }
  if (!isRecord(value)) {
    return {};
  }
  const provenance: AssignProvenance = {};
  for (const [id, timestamp] of Object.entries(value)) {
    if (id !== "" && typeof timestamp === "string") {
      provenance[id] = timestamp;
    }
  }
  return provenance;
}

/** Everything a caller needs to show and then confirm an assign. */
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

export interface AssignState {
  plan: AssignPlan | null;
  confirmed: boolean;
}

/** The write seam the review page fills with `chrome.storage.local`. */
export interface AssignIo {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, string>): Promise<void>;
}

export type AssignCommitResult =
  | { ok: true; added: string[]; skipped: string[] }
  | { ok: false; code: "not_confirmed" | "stale_plan" | "storage_failure" };

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

export type UndoCommitResult =
  | { ok: true; removed: string[]; skipped: string[] }
  | { ok: false; code: "not_confirmed" | "stale_plan" | "storage_failure" };

/** One decoded note store, plus its raw text (the compare-and-set base). */
interface DecodedStore {
  text: string;
  notes: Note[];
}

/** A store that cannot be decoded. Fail-closed: the plan refuses instead of guessing. */
interface StoreError {
  key: string;
  message: string;
}

interface Stores {
  legacy: DecodedStore;
  /** Decoded origin stores by canonical origin. */
  origins: Map<string, DecodedStore>;
  errors: StoreError[];
}

/**
 * The timestamp a plan stamps its copies with.
 *
 * `AssignPlan` is contract-fixed and carries no timestamp, yet the request accepts `now` so tests
 * (and a caller that already has a clock reading) can make the sidecar deterministic. A WeakMap
 * keeps that value out of the plan's observable shape: `beginAssign` hands the same object to
 * `commitAssign`, and a plan built by hand simply uses the commit-time clock.
 */
const planTimestamps = new WeakMap<AssignPlan, string>();

function planTimestamp(plan: AssignPlan): string {
  return planTimestamps.get(plan) ?? systemClock.now();
}

/** Trim, drop empties and dedupe while preserving the caller's order. */
function selectionOf(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const selection: string[] = [];
  for (const value of ids) {
    if (typeof value !== "string") {
      continue;
    }
    const id = value.trim();
    if (id === "" || seen.has(id)) {
      continue;
    }
    seen.add(id);
    selection.push(id);
  }
  return selection;
}

/** The stored text of a key; `""` for an absent one. `null` means "not text at all". */
function storedText(raw: unknown): string | null {
  if (raw === undefined || raw === null) {
    return "";
  }
  return typeof raw === "string" ? raw : null;
}

/** Decode one note set with the one codec and the one migration every surface uses. */
function decodeStore(key: string, raw: unknown): DecodedStore | StoreError {
  const text = storedText(raw);
  if (text === null) {
    return { key, message: `the note set at ${key} is not stored as text` };
  }
  if (text.trim() === "") {
    return { text, notes: [] };
  }
  try {
    return { text, notes: parseNoteSet(text) };
  } catch (error) {
    return { key, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Read every note store in the entries: the legacy blob, the target and any foreign origin. */
function decodeStores(entries: Record<string, unknown>): Stores {
  const stores: Stores = {
    legacy: { text: "", notes: [] },
    origins: new Map<string, DecodedStore>(),
    errors: [],
  };
  for (const key of Object.keys(entries)) {
    const parsed = parseNotesStorageKey(key);
    if (parsed === null) {
      continue;
    }
    const decoded = decodeStore(key, entries[key]);
    if ("message" in decoded) {
      stores.errors.push(decoded);
      continue;
    }
    if (parsed.kind === "legacy") {
      stores.legacy = decoded;
    } else {
      stores.origins.set(parsed.origin, decoded);
    }
  }
  return stores;
}

/** Index a decoded store by note id; the first occurrence wins. */
function byId(notes: readonly Note[]): Map<string, Note> {
  const map = new Map<string, Note>();
  for (const note of notes) {
    if (!map.has(note.id)) {
      map.set(note.id, note);
    }
  }
  return map;
}

/** The copy target: a deep copy that only changes `origin` (RVW-01). */
function copyForOrigin(note: Note, origin: string): Note {
  const copy = cloneNote(note);
  copy.origin = origin;
  // `cloneNote` deep-copies anchor/context/messages/debug but shares `timing`; the copy must own
  // its timing object so mutating one note cannot reach the other (AC-B11).
  if (note.timing !== undefined) {
    copy.timing = { ...note.timing };
  }
  return copy;
}

/** Compare two provenance maps regardless of key order. */
function sameProvenance(left: AssignProvenance, right: AssignProvenance): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

/**
 * Plan a copy-only assign (AC-B10, AC-B31…AC-B34, AC-B44).
 *
 * Check order is contract-fixed: `invalid_origin` → `empty_selection` → `corrupt_source` (any
 * note store, including a foreign origin group, RVW2-16) → `unknown_note` → `conflict` → `skipped`.
 * A plan never mutates `entries` and an error never produces a partial plan.
 */
export function planAssignToOrigin(
  entries: Record<string, unknown>,
  request: { ids: readonly string[]; origin: unknown; now?: string },
): AssignToOriginResult {
  const parsedOrigin = parseOriginInput(request.origin);
  if (!parsedOrigin.ok || parsedOrigin.origin === null) {
    return {
      ok: false,
      code: "invalid_origin",
      message: "the assign target is not a usable http(s) origin",
    };
  }
  const targetOrigin = parsedOrigin.origin;
  const targetKey = chromeStorageKeyForOrigin(targetOrigin);
  if (targetKey === null) {
    return { ok: false, code: "invalid_origin", message: "the assign target has no storage key" };
  }

  const selection = selectionOf(request.ids);
  if (selection.length === 0) {
    return { ok: false, code: "empty_selection", message: "no note ids were selected" };
  }

  const stores = decodeStores(entries);
  if (stores.errors.length > 0) {
    return {
      ok: false,
      code: "corrupt_source",
      message: stores.errors.map((error) => error.message).join("; "),
    };
  }

  const target = stores.origins.get(targetOrigin) ?? { text: "", notes: [] };
  const legacyById = byId(stores.legacy.notes);
  const targetById = byId(target.notes);
  const foreignById = new Map<string, string>();
  for (const [origin, store] of stores.origins) {
    if (origin === targetOrigin) {
      continue;
    }
    for (const note of store.notes) {
      if (!foreignById.has(note.id)) {
        foreignById.set(note.id, origin);
      }
    }
  }

  // Contract order: unknown ids first, then conflicts, then skipped, then copies.
  for (const id of selection) {
    if (!targetById.has(id) && !legacyById.has(id) && !foreignById.has(id)) {
      return { ok: false, code: "unknown_note", message: `no note with id ${id} exists in any store` };
    }
  }
  for (const id of selection) {
    const foreignOrigin = foreignById.get(id);
    if (foreignOrigin !== undefined) {
      return {
        ok: false,
        code: "conflict",
        message: `note ${id} already lives in the store of ${foreignOrigin}`,
      };
    }
  }

  const skipped: string[] = [];
  const moved: string[] = [];
  const notes: Note[] = [];
  for (const id of selection) {
    if (targetById.has(id)) {
      // Already in the target store: nothing to copy, and no provenance entry either.
      skipped.push(id);
      continue;
    }
    const source = legacyById.get(id);
    if (source === undefined) {
      // Unreachable after the two passes above, kept as a fail-closed guard.
      return { ok: false, code: "unknown_note", message: `no note with id ${id} exists` };
    }
    const copy = copyForOrigin(source, targetOrigin);
    const issues = validateNote(copy);
    if (issues.length > 0) {
      return { ok: false, code: "corrupt_source", message: issues.join("; ") };
    }
    moved.push(id);
    notes.push(copy);
  }

  const provenanceKey = assignProvenanceKey(targetOrigin);
  const plan: AssignPlan = {
    targetKey,
    targetOrigin,
    provenanceKey,
    baseText: target.text,
    baseProvenance: parseAssignProvenance(entries[provenanceKey]),
    notes,
    moved,
    skipped,
  };
  planTimestamps.set(plan, request.now ?? systemClock.now());
  return { ok: true, plan };
}

/** Plan and wrap in the unconfirmed state a UI has to confirm before committing. */
export function beginAssign(
  entries: Record<string, unknown>,
  request: { ids: readonly string[]; origin: unknown; now?: string },
): AssignState {
  const planned = planAssignToOrigin(entries, request);
  return planned.ok ? { plan: planned.plan, confirmed: false } : { plan: null, confirmed: false };
}

/**
 * Commit a planned assign with compare-and-set over the target blob and the sidecar (AC-B09,
 * AC-B34, AC-B45, AC-B46).
 *
 * Exactly one `io.set` writes both keys when at least one copy is added. The legacy key is never
 * part of that set — copy-only is enforced by what is written, not by a caller's promise.
 */
export async function commitAssign(
  state: AssignState,
  io: AssignIo,
): Promise<AssignCommitResult> {
  const plan = state.plan;
  if (plan === null || !state.confirmed) {
    return { ok: false, code: "not_confirmed" };
  }
  if (plan.moved.length === 0) {
    return { ok: true, added: [], skipped: plan.skipped };
  }

  try {
    const current = await io.get([plan.targetKey, plan.provenanceKey]);
    if (storedText(current[plan.targetKey]) !== plan.baseText) {
      return { ok: false, code: "stale_plan" };
    }
    if (!sameProvenance(parseAssignProvenance(current[plan.provenanceKey]), plan.baseProvenance)) {
      return { ok: false, code: "stale_plan" };
    }

    // Safe to decode: the CAS above proved the text equals the plan's base text.
    const currentTarget = decodeStore(plan.targetKey, plan.baseText);
    const existing = "message" in currentTarget ? [] : currentTarget.notes;

    const merged: AssignProvenance = { ...plan.baseProvenance };
    const when = planTimestamp(plan);
    for (const id of plan.moved) {
      merged[id] = when;
    }

    await io.set({
      [plan.targetKey]: serializeNoteSet([...existing, ...plan.notes]),
      [plan.provenanceKey]: JSON.stringify(merged),
    });
    return { ok: true, added: [...plan.moved], skipped: plan.skipped };
  } catch {
    return { ok: false, code: "storage_failure" };
  }
}

/**
 * Plan a provenance-based undo (AC-B35, AC-B45…AC-B47, AC-B51).
 *
 * Only ids the sidecar proves are removed from the target store. Every other requested id is
 * `skipped` and stays untouched; an id the sidecar lists but the target no longer has is
 * `skipped` as well, and its sidecar entry is cleaned up. A corrupt store fails closed.
 */
export function planUndoAssign(
  entries: Record<string, unknown>,
  request: { ids: readonly string[]; origin: unknown },
):
  | { ok: true; plan: UndoPlan }
  | { ok: false; code: "invalid_origin" | "unknown_note" | "corrupt_source"; message: string } {
  const parsedOrigin = parseOriginInput(request.origin);
  if (!parsedOrigin.ok || parsedOrigin.origin === null) {
    return {
      ok: false,
      code: "invalid_origin",
      message: "the undo target is not a usable http(s) origin",
    };
  }
  const targetOrigin = parsedOrigin.origin;
  const targetKey = chromeStorageKeyForOrigin(targetOrigin);
  if (targetKey === null) {
    return { ok: false, code: "invalid_origin", message: "the undo target has no storage key" };
  }

  const stores = decodeStores(entries);
  if (stores.errors.length > 0) {
    return {
      ok: false,
      code: "corrupt_source",
      message: stores.errors.map((error) => error.message).join("; "),
    };
  }

  const provenanceKey = assignProvenanceKey(targetOrigin);
  const provenance = parseAssignProvenance(entries[provenanceKey]);
  const target = stores.origins.get(targetOrigin) ?? { text: "", notes: [] };
  const targetById = byId(target.notes);

  const known = new Set<string>([
    ...stores.legacy.notes.map((note) => note.id),
    ...Object.keys(provenance),
  ]);
  for (const store of stores.origins.values()) {
    for (const note of store.notes) {
      known.add(note.id);
    }
  }

  const selection = selectionOf(request.ids);
  for (const id of selection) {
    if (!known.has(id)) {
      return { ok: false, code: "unknown_note", message: `no note with id ${id} exists in any store` };
    }
  }

  const removed: string[] = [];
  const skipped: string[] = [];
  for (const id of selection) {
    if (provenance[id] !== undefined && targetById.has(id)) {
      removed.push(id);
    } else {
      // No proof, or the copy is already gone: keep the note, clean the sidecar entry.
      skipped.push(id);
    }
  }

  const remainingProvenance: AssignProvenance = { ...provenance };
  for (const id of selection) {
    delete remainingProvenance[id];
  }
  const removedSet = new Set(removed);
  const remainingNotes = target.notes.filter((note) => !removedSet.has(note.id));

  return {
    ok: true,
    plan: {
      targetKey,
      targetOrigin,
      provenanceKey,
      baseText: target.text,
      remainingText: serializeNoteSet(remainingNotes),
      baseProvenance: provenance,
      remainingProvenance,
      removed,
      skipped,
    },
  };
}

/**
 * Commit a planned undo with the same compare-and-set as assign (AC-B45, AC-B47, AC-B51).
 *
 * A plan that removes nothing and has nothing to clean up performs no write at all. A plan that
 * only cleans a sidecar entry (an already-undone copy) writes once.
 */
export async function commitUndoAssign(
  state: UndoState,
  io: AssignIo,
): Promise<UndoCommitResult> {
  const plan = state.plan;
  if (plan === null || !state.confirmed) {
    return { ok: false, code: "not_confirmed" };
  }

  const provenanceChanged = !sameProvenance(plan.remainingProvenance, plan.baseProvenance);
  if (plan.removed.length === 0 && !provenanceChanged) {
    return { ok: true, removed: [], skipped: plan.skipped };
  }

  try {
    const current = await io.get([plan.targetKey, plan.provenanceKey]);
    if (storedText(current[plan.targetKey]) !== plan.baseText) {
      return { ok: false, code: "stale_plan" };
    }
    if (!sameProvenance(parseAssignProvenance(current[plan.provenanceKey]), plan.baseProvenance)) {
      return { ok: false, code: "stale_plan" };
    }

    await io.set({
      [plan.targetKey]: plan.remainingText,
      [plan.provenanceKey]: JSON.stringify(plan.remainingProvenance),
    });
    return { ok: true, removed: [...plan.removed], skipped: plan.skipped };
  } catch {
    return { ok: false, code: "storage_failure" };
  }
}
