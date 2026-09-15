/**
 * Store — the authoritative in-memory note set (docs/INTERNAL-API.md §2, ARCHITECTURE §4).
 *
 * Rules (frozen contract):
 *  - The store holds the authoritative list; the UI talks to the store, never to an adapter.
 *  - Every mutation is applied to memory **first** (optimistically), then to the adapter, then the
 *    subscribers are notified. A failing adapter never loses the in-memory change silently: the
 *    change stays and the returned promise rejects (NFR-8).
 *  - `subscribe` fires immediately with the current list and again after every change.
 *  - Adapter *names* are resolved lazily through dynamic import, so importing this module never
 *    pulls browser-only code into a Node process (FR-13.2/15.4) and no request is made before the
 *    first use (NFR-2).
 *
 * Protocol transitions: `core/protocol.ts` owns the *review policy* (composed decision text, forced
 * author types, the refusals of PROTOCOL §6) over a whole note. The frozen §2 signatures of
 * `reply`/`setStatus`/`setIntent` cannot carry that policy — `reply` accepts any message kind, any
 * author and any author type, while e.g. `completeNote` always writes `status=done` and
 * `respondFeedback` always writes `authorType=agent`. The store therefore performs the state change
 * directly and leaves the choice of a protocol helper to the UI/CLI/MCP layer above it.
 */
import {
  BluepencilValidationError,
  appendMessage,
  createMessage,
  createNote,
  isNoteIntent,
  isNoteStatus,
  newId,
  systemClock,
  type AuthorType,
  type Environment,
  type Message,
  type MessageKind,
  type Note,
  type NoteDraft,
  type NoteFilter,
  type NoteIntent,
  type NotePatch,
  type NoteStatus,
} from "./model";
import {
  applyPatch,
  cloneNote,
  cloneNotes,
  matchesFilter,
  type Adapter,
  type AdapterLike,
  type AdapterName,
  type AdapterPatch,
} from "./adapter";

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
  reply(
    id: string,
    input: { text: string; author?: string; authorType?: AuthorType; kind?: MessageKind },
  ): Promise<Note>;
  setStatus(id: string, status: NoteStatus): Promise<Note>;
  setIntent(id: string, intent: NoteIntent): Promise<Note>;
  subscribe(cb: (notes: Note[]) => void): () => void;
  reload(): Promise<void>;
  destroy(): Promise<void>;
}

type Subscriber = (notes: Note[]) => void;
type AdapterLoader = () => Adapter | Promise<Adapter>;

/** Factories that can be injected (or overridden) per adapter name — the DI/test hook. */
const adapterRegistry = new Map<string, AdapterLoader>();

/**
 * Registers a factory for an adapter name, overriding the built-in loader until the returned
 * function is called. Intended for tests and for hosts that need to configure `file`/`http`
 * (which require injected I/O or an endpoint and therefore have no usable built-in instance).
 */
export function registerAdapter(name: string, factory: AdapterLoader): () => void {
  if (typeof name !== "string" || name.trim() === "") {
    throw new BluepencilValidationError(["registerAdapter needs a non-empty adapter name"]);
  }
  if (typeof factory !== "function") {
    throw new BluepencilValidationError([`registerAdapter("${name}") needs a factory function`]);
  }
  const previous = adapterRegistry.get(name);
  adapterRegistry.set(name, factory);
  return () => {
    if (previous) {
      adapterRegistry.set(name, previous);
    } else {
      adapterRegistry.delete(name);
    }
  };
}

/**
 * Built-in loaders, one per name in `AdapterName`. Imported lazily so that the browser-only parts
 * stay out of a headless process and a host pays only for the adapter it actually uses.
 */
const BUILTIN_ADAPTERS: Record<AdapterName, AdapterLoader> = {
  memory: async () => (await import("../adapters/memory")).createMemoryAdapter(),
  localStorage: async () => (await import("../adapters/local-storage")).createLocalStorageAdapter(),
  file: async () => {
    // The module is imported so the name→module mapping stays real, but the factory needs I/O
    // that only the host can provide; there is no sensible default file to write to.
    await import("../adapters/file");
    throw new BluepencilValidationError([
      'the "file" adapter needs injected I/O — build it with createFileAdapter({ read, write }) and pass the instance, or register a factory with registerAdapter("file", …)',
    ]);
  },
  http: async () => {
    const { createHttpAdapter } = await import("../adapters/http");
    return createHttpAdapter({ endpoint: defaultHttpEndpoint() });
  },
};

/** Default endpoint of the built-in `http` adapter: the documented path on the current origin. */
function defaultHttpEndpoint(): string {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  if (!origin) {
    throw new BluepencilValidationError([
      'the "http" adapter needs an endpoint — build it with createHttpAdapter({ endpoint }), or register a factory with registerAdapter("http", …)',
    ]);
  }
  return `${origin}/api/v1/bluepencil`;
}

function isKnownAdapterName(name: string): boolean {
  return adapterRegistry.has(name) || Object.prototype.hasOwnProperty.call(BUILTIN_ADAPTERS, name);
}

export function createStore(options: StoreOptions = {}): Store {
  const configured = options.adapter;
  const clock = options.now ?? systemClock.now;

  // An adapter instance or factory is available synchronously; a name is resolved lazily.
  const injected: Adapter | null =
    configured && typeof configured === "object"
      ? configured
      : typeof configured === "function"
        ? configured()
        : null;

  if (typeof configured === "string" && !isKnownAdapterName(configured)) {
    throw new BluepencilValidationError([
      `unknown adapter "${configured}" — known adapters: ${knownAdapterNames().join(", ")}`,
    ]);
  }

  let current: Note[] = [];
  let destroyed = false;
  let pending: Promise<Adapter> | null = null;
  const subscribers = new Set<Subscriber>();

  const snapshot = (): Note[] => cloneNotes(current);

  const notify = (): void => {
    for (const subscriber of [...subscribers]) {
      try {
        subscriber(cloneNotes(current));
      } catch (error) {
        console.debug("bluepencil: a store subscriber failed", error);
      }
    }
  };

  const assertLive = (): void => {
    if (destroyed) {
      throw new Error("bluepencil: the store has been destroyed");
    }
  };

  const loadAdapter = async (): Promise<Adapter> => {
    if (injected) {
      return injected;
    }
    const name = typeof configured === "string" ? configured : "memory";
    const custom = adapterRegistry.get(name);
    if (custom) {
      return custom();
    }
    const loader = Object.prototype.hasOwnProperty.call(BUILTIN_ADAPTERS, name)
      ? BUILTIN_ADAPTERS[name as AdapterName]
      : undefined;
    if (!loader) {
      throw new BluepencilValidationError([`unknown adapter "${name}"`]);
    }
    return loader();
  };

  const adapter = (): Promise<Adapter> => {
    if (!pending) {
      pending = loadAdapter();
    }
    return pending;
  };

  const prepare = (draft: NoteDraft): NoteDraft => ({
    ...draft,
    id: draft.id ?? newId("n"),
    now: draft.now ?? clock(),
    ...(draft.sessionRef === undefined && options.sessionRef !== undefined
      ? { sessionRef: options.sessionRef }
      : {}),
    ...(draft.environment === undefined && options.environment !== undefined
      ? { environment: options.environment }
      : {}),
  });

  /** Replaces the local note with the adapter's version, keyed by id. */
  const adopt = (localId: string, saved: Note): Note => {
    const note = cloneNote(saved);
    if (current.some((candidate) => candidate.id === note.id)) {
      current = current.map((candidate) => (candidate.id === note.id ? note : candidate));
    } else if (localId !== note.id) {
      current = [...current.filter((candidate) => candidate.id !== localId), note];
    } else {
      current = [...current, note];
    }
    return note;
  };

  /** Adds unknown notes and refreshes known ones; returns whether anything changed. */
  const absorb = (incoming: readonly Note[]): boolean => {
    let changed = false;
    for (const note of incoming) {
      const existing = current.find((candidate) => candidate.id === note.id);
      if (!existing) {
        current = [...current, note];
        changed = true;
      } else if (existing.updatedAt !== note.updatedAt) {
        current = current.map((candidate) => (candidate.id === note.id ? note : candidate));
        changed = true;
      }
    }
    return changed;
  };

  const store: Store = {
    get adapterName(): string {
      if (injected) {
        return injected.name;
      }
      return typeof configured === "string" ? configured : "memory";
    },

    notes(): Note[] {
      return snapshot();
    },

    async list(filter?: NoteFilter): Promise<Note[]> {
      assertLive();
      const fetched = cloneNotes(await (await adapter()).list(filter));
      if (absorb(fetched)) {
        notify();
      }
      return fetched;
    },

    async get(id: string): Promise<Note | undefined> {
      assertLive();
      const known = current.find((note) => note.id === id);
      if (known) {
        return cloneNote(known);
      }
      const fetched = await (await adapter()).list();
      const found = fetched.find((note) => note.id === id);
      return found ? cloneNote(found) : undefined;
    },

    async create(draft: NoteDraft): Promise<Note> {
      assertLive();
      const prepared = prepare(draft);
      // Validated before anything is touched, so an invalid draft leaves the store unchanged.
      const optimistic = createNote(prepared);
      current = [...current, optimistic];
      try {
        return cloneNote(adopt(optimistic.id, await (await adapter()).create(prepared)));
      } finally {
        notify();
      }
    },

    async update(id: string, patch: NotePatch): Promise<Note> {
      assertLive();
      const existing = current.find((note) => note.id === id);
      if (existing) {
        const next = applyPatch(existing, patch, clock());
        current = current.map((note) => (note.id === id ? next : note));
      }
      try {
        return cloneNote(adopt(id, await (await adapter()).update(id, patch)));
      } finally {
        notify();
      }
    },

    async remove(id: string): Promise<void> {
      assertLive();
      current = current.filter((note) => note.id !== id);
      try {
        await (await adapter()).remove(id);
      } finally {
        notify();
      }
    },

    async bulkRemove(filter: NoteFilter): Promise<{ removed: number }> {
      assertLive();
      current = current.filter((note) => !matchesFilter(note, filter));
      try {
        const result = await (await adapter()).bulkRemove(filter);
        return { removed: result.removed };
      } finally {
        notify();
      }
    },

    async exportSession(sessionRef: string): Promise<Note[]> {
      assertLive();
      const fetched = cloneNotes(await (await adapter()).exportSession(sessionRef));
      if (absorb(fetched)) {
        notify();
      }
      return fetched;
    },

    async addMessage(id: string, message: Message): Promise<Note> {
      assertLive();
      const existing = current.find((note) => note.id === id);
      if (existing) {
        // Append-only: the existing thread is extended, never replaced (FR-3.3).
        const next = appendMessage(existing, message);
        current = current.map((note) => (note.id === id ? next : note));
      }
      const payload: AdapterPatch = { messages: [message] };
      try {
        return cloneNote(adopt(id, await (await adapter()).update(id, payload)));
      } finally {
        notify();
      }
    },

    async reply(
      id: string,
      input: { text: string; author?: string; authorType?: AuthorType; kind?: MessageKind },
    ): Promise<Note> {
      assertLive();
      if (typeof input?.text !== "string" || input.text.trim() === "") {
        throw new BluepencilValidationError(["reply text must be a non-empty string"]);
      }
      const message = createMessage({
        text: input.text,
        kind: input.kind ?? "reply",
        author: input.author,
        authorType: input.authorType,
        now: clock(),
      });
      return store.addMessage(id, message);
    },

    async setStatus(id: string, status: NoteStatus): Promise<Note> {
      assertLive();
      if (!isNoteStatus(status)) {
        throw new BluepencilValidationError(["status must be open, done or needs_decision"]);
      }
      return store.update(id, { status });
    },

    async setIntent(id: string, intent: NoteIntent): Promise<Note> {
      assertLive();
      if (!isNoteIntent(intent)) {
        throw new BluepencilValidationError(["intent must be implement or feedback"]);
      }
      return store.update(id, { intent });
    },

    subscribe(callback: (notes: Note[]) => void): () => void {
      subscribers.add(callback);
      callback(snapshot());
      return () => {
        subscribers.delete(callback);
      };
    },

    async reload(): Promise<void> {
      assertLive();
      const fetched = cloneNotes(await (await adapter()).list());
      absorb(fetched);
      notify();
    },

    async destroy(): Promise<void> {
      if (destroyed) {
        return;
      }
      destroyed = true;
      subscribers.clear();
      current = [];
    },
  };

  return store;
}

function knownAdapterNames(): string[] {
  return [...new Set([...Object.keys(BUILTIN_ADAPTERS), ...adapterRegistry.keys()])];
}
