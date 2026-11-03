/**
 * The stored note-set codec (FR-6.5) — one blob, one parser, one serialiser.
 *
 * The codec lives in the headless data layer because more than one surface reads a stored set:
 * the adapters persist it, the MCP backend validates it and the extension review page parses
 * `chrome.storage` values with it. Keeping it here means a stored blob is interpreted by exactly
 * one implementation everywhere (FR-15.3); `src/adapters/memory.ts` re-exports both functions so
 * the adapter's public API is unchanged.
 *
 * The format is deliberately boring: a version tag plus the note set, readable by any 20-line
 * script (NFR-19).
 */
import { BluepencilValidationError, type Note } from "../core/model";
import { cloneNotes, coerceNote, isRecord } from "../core/adapter";

/** The persisted shape: a version tag plus the note set. */
interface NoteSetBlob {
  version: number;
  notes: Note[];
}

export function serializeNoteSet(notes: readonly Note[]): string {
  const blob: NoteSetBlob = { version: 1, notes: cloneNotes(notes) };
  return JSON.stringify(blob);
}

/**
 * Reads a stored note set. Accepts the documented `{ notes: [] }` blob and a bare array, and
 * rejects anything else so that a broken file never silently becomes "no notes".
 */
export function parseNoteSet(text: string | null): Note[] {
  if (text === null || text.trim() === "") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new BluepencilValidationError(["the stored note set is not valid JSON"]);
  }
  const list = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.notes)
      ? parsed.notes
      : null;
  if (!list) {
    throw new BluepencilValidationError(["the stored note set must be a JSON array or { notes: [] }"]);
  }
  const notes: Note[] = [];
  for (const entry of list) {
    const note = coerceNote(entry);
    if (note) {
      notes.push(note);
    }
  }
  return notes;
}
