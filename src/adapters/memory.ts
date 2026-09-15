/**
 * In-memory adapter — the reference implementation of the transport contract (FR-6.2).
 *
 * The module also hosts the JSON-blob engine (`createJsonAdapter`) that the `localStorage` and
 * `file` adapters are built on: one implementation of the read-modify-write cycle, one place
 * where persistence can break, and one fallback path (NFR-8, FR-15.3).
 *
 * Everything here is environment-free: no DOM, no `node:fs`, no timers. Adapters that need a
 * host environment take it injected (see `local-storage.ts`, `file.ts`).
 */
import {
  BluepencilValidationError,
  createNote,
  type Note,
  type NoteFilter,
} from "../core/model";
import {
  applyPatch,
  cloneNote,
  cloneNotes,
  coerceNote,
  isRecord,
  matchesFilter,
  type Adapter,
  type AdapterPatch,
} from "../core/adapter";

/** Adapter name reported to the store and to hosts. */
export const MEMORY_ADAPTER_NAME = "memory";

/**
 * Ephemeral adapter: the notes live in this closure until the page goes away. Also the fallback
 * target of the persistent adapters when their environment cannot provide storage (NFR-8).
 */
export function createMemoryAdapter(options: { seed?: Note[] } = {}): Adapter {
  let notes: Note[] = cloneNotes(options.seed ?? []);
  const subscribers = new Set<(notes: Note[]) => void>();

  const notify = (): void => {
    for (const callback of [...subscribers]) {
      callback(cloneNotes(notes));
    }
  };

  const require = (id: string): Note => {
    const note = notes.find((candidate) => candidate.id === id);
    if (!note) {
      throw new Error(`bluepencil: note not found: ${id}`);
    }
    return note;
  };

  const adapter: Adapter = {
    name: MEMORY_ADAPTER_NAME,
    async list(filter?: NoteFilter): Promise<Note[]> {
      return cloneNotes(notes.filter((note) => matchesFilter(note, filter)));
    },
    async create(draft): Promise<Note> {
      const note = createNote(draft);
      notes = [...notes, note];
      notify();
      return cloneNote(note);
    },
    async update(id: string, patch: AdapterPatch): Promise<Note> {
      const next = applyPatch(require(id), patch);
      notes = notes.map((note) => (note.id === id ? next : note));
      notify();
      return cloneNote(next);
    },
    async remove(id: string): Promise<void> {
      require(id);
      notes = notes.filter((note) => note.id !== id);
      notify();
    },
    async bulkRemove(filter: NoteFilter): Promise<{ removed: number }> {
      const kept = notes.filter((note) => !matchesFilter(note, filter));
      const removed = notes.length - kept.length;
      notes = kept;
      if (removed > 0) {
        notify();
      }
      return { removed };
    },
    async exportSession(sessionRef: string): Promise<Note[]> {
      return cloneNotes(notes.filter((note) => note.sessionRef === sessionRef));
    },
    subscribe(callback: (list: Note[]) => void): () => void {
      subscribers.add(callback);
      callback(cloneNotes(notes));
      return () => {
        subscribers.delete(callback);
      };
    },
  };
  return adapter;
}

/* ------------------------------------------------------------------------------------------------
 * JSON blob codec (FR-6.5: one blob, written as a whole)
 * ---------------------------------------------------------------------------------------------- */

/** The persisted shape: a version tag plus the note set, readable by any 20-line script (NFR-19). */
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

/* ------------------------------------------------------------------------------------------------
 * JSON blob engine — the shared body of the localStorage and file adapters
 * ---------------------------------------------------------------------------------------------- */

/** Host-provided persistence for `createJsonAdapter`; both calls may fail (quota, disk, policy). */
export interface JsonAdapterIo {
  /** Reads the stored blob; `null` when nothing has been stored yet. */
  readText(): Promise<string | null>;
  /** Writes the whole blob at once (atomic per key/file, FR-6.5). */
  writeText(text: string): Promise<void>;
  /** Called once when the adapter degrades to memory; the caller reports it (NFR-14). */
  onFallback(reason: unknown): void;
}

/**
 * Adapter over a single JSON blob. Every mutation is a read-modify-write cycle that is serialized
 * through one queue, so concurrent calls can never overwrite each other (NFR-8). When the I/O
 * fails — storage unavailable, quota exceeded, unreadable blob — the adapter degrades to memory
 * **with the change already applied** and reports it exactly once: the change is never lost, it
 * is only no longer persisted.
 */
export function createJsonAdapter(name: string, io: JsonAdapterIo): Adapter {
  let known: Note[] = [];
  let degraded = false;
  let queue: Promise<unknown> = Promise.resolve();
  const subscribers = new Set<(notes: Note[]) => void>();

  const notify = (): void => {
    for (const callback of [...subscribers]) {
      callback(cloneNotes(known));
    }
  };

  const degrade = (reason: unknown): void => {
    if (degraded) {
      return;
    }
    degraded = true;
    io.onFallback(reason);
  };

  const run = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const load = async (): Promise<Note[]> => {
    if (degraded) {
      return known;
    }
    try {
      const notes = parseNoteSet(await io.readText());
      known = notes;
      return notes;
    } catch (error) {
      degrade(error);
      return known;
    }
  };

  const persist = async (notes: Note[]): Promise<void> => {
    known = notes;
    if (degraded) {
      return;
    }
    try {
      await io.writeText(serializeNoteSet(notes));
    } catch (error) {
      degrade(error);
    }
  };

  const mutate = <T>(apply: (notes: Note[]) => { notes: Note[]; result: T }): Promise<T> =>
    run(async () => {
      const { notes, result } = apply(await load());
      await persist(notes);
      notify();
      return result;
    });

  const adapter: Adapter = {
    name,
    list(filter?: NoteFilter): Promise<Note[]> {
      return run(async () => cloneNotes((await load()).filter((note) => matchesFilter(note, filter))));
    },
    create(draft): Promise<Note> {
      return mutate((notes) => {
        const note = createNote(draft);
        return { notes: [...notes, note], result: cloneNote(note) };
      });
    },
    update(id: string, patch: AdapterPatch): Promise<Note> {
      return mutate((notes) => {
        const existing = notes.find((note) => note.id === id);
        if (!existing) {
          throw new Error(`bluepencil: note not found: ${id}`);
        }
        const next = applyPatch(existing, patch);
        return { notes: notes.map((note) => (note.id === id ? next : note)), result: cloneNote(next) };
      });
    },
    remove(id: string): Promise<void> {
      return mutate<void>((notes) => {
        if (!notes.some((note) => note.id === id)) {
          throw new Error(`bluepencil: note not found: ${id}`);
        }
        return { notes: notes.filter((note) => note.id !== id), result: undefined };
      });
    },
    bulkRemove(filter: NoteFilter): Promise<{ removed: number }> {
      return mutate((notes) => {
        const kept = notes.filter((note) => !matchesFilter(note, filter));
        return { notes: kept, result: { removed: notes.length - kept.length } };
      });
    },
    exportSession(sessionRef: string): Promise<Note[]> {
      return run(async () => cloneNotes((await load()).filter((note) => note.sessionRef === sessionRef)));
    },
    subscribe(callback: (list: Note[]) => void): () => void {
      subscribers.add(callback);
      callback(cloneNotes(known));
      return () => {
        subscribers.delete(callback);
      };
    },
  };
  return adapter;
}
