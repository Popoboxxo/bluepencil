/**
 * bluepencil — public API.
 *
 * Annotate any web app: text and design notes, anchored to the element, readable by humans
 * and agents. This entry point wires the store, the review layer and the exports together;
 * everything below it is usable standalone (`bluepencil/data`, `bluepencil/adapters/*`).
 *
 * Lifecycle contract (FR-12.1/12.2, NFR-1/NFR-15):
 *   init(config)  → nothing is mounted, nothing is fetched while the layer is disabled
 *   enable()      → builds the layer, evaluates `enabled()` first
 *   disable()     → removes nodes, listeners, observers and styles; idempotent
 *   destroy()     → final teardown, the instance can be discarded
 *
 * `enabled` gate (FR-1.1): when the host passes `enabled`, it is evaluated on **every**
 * enable(); returning false means no DOM node, no request, no listener (fail closed).
 * When no gate is configured the host's own call to init() counts as the opt-in and the
 * layer auto-enables once (`autoEnable`, on by default) — pass `enabled: () => false` for a
 * strictly fail-closed integration, or `autoEnable: false` to mount manually.
 *
 * Loading contract (NFR-2/NFR-8): the store starts empty and is filled from its adapter by a
 * reload. There is exactly **one** load path per instance:
 *   - an enabled layer reloads on every `enable()` (src/ui/layer.ts) — that is the layer's load;
 *   - `notes()`/`export()` stay synchronous, but the first read of a store that has not loaded yet
 *     kicks off a reload instead of silently returning `[]`;
 *   - `ready()` resolves once the store has been read from its adapter, so a host can be
 *     deterministic (`await blueprint.ready()` before reading `notes()`/`export()`).
 * The promise is shared: concurrent callers, and `notes()`/`export()` racing with `ready()`, never
 * cause more than a single `store.reload()`. A failed load is reported through `onError`, never
 * thrown.
 *
 * The facade keeps the single filter implementation of `src/core/adapter.ts` (FR-15.3): `notes()`
 * uses `filterNotes` and `export()` uses `excludeDone`, exactly like the list, the bar and the
 * adapters.
 */
import type { Adapter, AdapterLike } from "./core/adapter";
import { excludeDone, filterNotes } from "./core/adapter";
import type { Environment, Note, NoteFilter } from "./core/model";
import { createStore, type Store, type StoreOptions } from "./core/store";
import { toJson } from "./core/export/json";
import { toMarkdown } from "./core/export/markdown";
import { createLayer, type LayerHandle, type LayerOptions } from "./ui/layer";

export { VERSION } from "./version";

export interface BlueprintConfig extends Omit<LayerOptions, "store"> {
  /** Adapter instance, built-in adapter name, or a factory that returns one. */
  adapter?: AdapterLike | (() => Adapter);
  /** Store overrides for advanced hosts (custom clock, session, environment). */
  storeOptions?: Omit<StoreOptions, "adapter">;
  /** Review round this instance writes into (FR-3.4). */
  sessionRef?: string;
  /** Environment this instance belongs to (FR-14.1); imports never cross it by default. */
  environment?: Environment;
  /** Host gate, evaluated on every enable() (FR-1.1). */
  enabled?: () => boolean;
  /** Mount the layer right away (default: true when no gate is configured). */
  autoEnable?: boolean;
}

export interface Blueprint {
  readonly store: Store;
  readonly layer: LayerHandle;
  /** Create the layer (idempotent). Returns false when the host gate refused. */
  enable(): boolean;
  /** Full teardown of the layer; the store and its data survive (FR-12.1). */
  disable(): void;
  isEnabled(): boolean;
  /** Replace the host gate at runtime (FR-12.1). */
  setEnabled(gate: (() => boolean) | null): void;
  /** Notes currently known to the store, synchronously (see the loading contract in the header). */
  notes(filter?: NoteFilter): Note[];
  /**
   * Resolves once the store has been read from its adapter, so `notes()`/`export()` are
   * deterministic afterwards. Never rejects: a failed load is reported through `onError`.
   */
  ready(): Promise<void>;
  /** Export the current set as Markdown (default) or JSON (FR-7.1/7.2). */
  export(options?: { format?: "markdown" | "json"; includeDone?: boolean }): string;
  /** Final teardown: layer removed and store released (FR-12.2). */
  destroy(): Promise<void>;
}

/** Lazily materialised facade — nothing is constructed until it is actually used (NFR-1). */
function lazy<T extends object>(factory: () => T): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      const instance = factory() as unknown as Record<string | symbol, unknown>;
      const value = instance[prop];
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(instance) : value;
    },
    has(_target, prop) {
      return prop in (factory() as object);
    },
  });
}

export function createBlueprint(config: BlueprintConfig = {}): Blueprint {
  const {
    adapter,
    storeOptions = {},
    sessionRef,
    environment,
    enabled: initialGate,
    autoEnable,
    ...layerOptions
  } = config;

  let gate = initialGate ?? null;
  let store: Store | null = null;
  let layer: LayerHandle | null = null;
  /** In-flight facade reload; shared so `ready()` never starts a second read (NFR-2). */
  let loading: Promise<void> | null = null;
  /** True once a facade reload completed, or once the layer (which reloads on enable) owns it. */
  let loaded = false;

  const storeConfig: StoreOptions = {
    ...(adapter !== undefined ? { adapter: adapter as AdapterLike } : {}),
    ...(sessionRef !== undefined ? { sessionRef } : {}),
    ...(environment !== undefined ? { environment } : {}),
    ...storeOptions,
  };

  const ensureStore = (): Store => {
    store ??= createStore(storeConfig);
    return store;
  };

  const ensureLayer = (): LayerHandle => {
    layer ??= createLayer({ ...layerOptions, store: ensureStore() } as LayerOptions);
    return layer;
  };

  /** Report a failed load through the host's `onError`; never escalate into the host (NFR-14). */
  const report = (error: unknown): void => {
    try {
      if (layerOptions.onError) {
        layerOptions.onError(error);
        return;
      }
      (globalThis as { console?: Console }).console?.debug?.("[bluepencil]", error);
    } catch {
      // Reporting must never become the failure itself.
    }
  };

  /**
   * The one facade load path: returns the in-flight reload or starts it. Never rejects, so a
   * fire-and-forget load cannot become an unhandled rejection in the host page (NFR-14).
   */
  const load = (): Promise<void> => {
    loading ??= ensureStore()
      .reload()
      .then(() => {
        loaded = true;
      })
      .catch((error: unknown) => {
        report(error);
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  };

  /** A synchronous read may not silently see an empty store: the first one asks the adapter. */
  const ensureLoaded = (): void => {
    if (!loaded && loading === null) void load();
  };

  const enable = (): boolean => {
    if (gate && !gate()) {
      return false;
    }
    const handle = ensureLayer();
    handle.enable();
    // The layer hydrates the store on enable() — keep that single load path: `notes()`, `export()`
    // and `ready()` reuse it instead of starting a second read (documented in the header).
    if (handle.isEnabled()) {
      loaded = true;
    }
    return true;
  };

  const blueprint: Blueprint = {
    store: lazy(ensureStore),
    layer: lazy(ensureLayer),
    enable,
    disable: () => layer?.disable(),
    isEnabled: () => layer?.isEnabled() ?? false,
    setEnabled: (next) => {
      gate = next;
      if (gate && !gate()) {
        layer?.disable();
      }
    },
    notes: (filter) => {
      ensureLoaded();
      return filterNotes(ensureStore().notes(), filter);
    },
    /** Deterministic host flow: `await ready()` once, then read/export synchronously (FR-1.2). */
    ready: () => {
      // An enabled layer is already hydrating the store: await that reload instead of starting a
      // second read (one load path per instance, documented in the header).
      if (loading === null && layer !== null && layer.isEnabled()) {
        return layer.hydrated();
      }
      return load();
    },
    export: (options = {}) => {
      ensureLoaded();
      const includeDone = options.includeDone ?? true;
      const notes = ensureStore().notes();
      const selected = includeDone ? notes : excludeDone(notes);
      if (options.format === "json") {
        return toJson(selected, environment !== undefined ? { environment } : {});
      }
      return toMarkdown(selected, {
        ...(layerOptions.language ? { language: layerOptions.language as "en" | "de" } : {}),
        includeDone,
      });
    },
    destroy: async () => {
      layer?.disable();
      await store?.destroy();
      layer = null;
      store = null;
      loading = null;
      loaded = false;
    },
  };

  const shouldAutoEnable = autoEnable ?? gate === null;
  if (shouldAutoEnable && (gate === null || gate())) {
    enable();
  }

  return blueprint;
}

/** The documented one-liner, e.g. `bluepencil.init({ adapter: "localStorage" })` (FR-10.2). */
export function init(config: BlueprintConfig = {}): Blueprint {
  return createBlueprint(config);
}

/** `mount()` is `init()` with the layer mounted unconditionally. */
export function mount(config: BlueprintConfig = {}): Blueprint {
  return createBlueprint({ ...config, autoEnable: true, enabled: () => true });
}

export type { Adapter, AdapterLike, AdapterName } from "./core/adapter";
export { filterNotes, matchesFilter, excludeDone } from "./core/adapter";
export type { LayerHandle, LayerOptions } from "./ui/layer";
export type { Store, StoreOptions } from "./core/store";
export type {
  Anchor,
  Bundle,
  CapturedContext,
  DebugContext,
  Environment,
  Message,
  MessageKind,
  Note,
  NoteDraft,
  NoteFilter,
  NoteIntent,
  NotePatch,
  NoteSource,
  NoteStatus,
  NoteType,
  Session,
} from "./core/model";
export { SCHEMA_VERSION, BluepencilValidationError } from "./core/model";
/** Register a named adapter factory, e.g. a preconfigured HTTP store (FR-6.2, FR-17). */
export { registerAdapter } from "./core/store";
