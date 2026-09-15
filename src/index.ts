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
 */
import type { Adapter, AdapterLike } from "./core/adapter";
import type { Environment, Note, NoteFilter } from "./core/model";
import { createStore, type Store, type StoreOptions } from "./core/store";
import { toJson } from "./core/export/json";
import { toMarkdown } from "./core/export/markdown";
import { createLayer, type LayerHandle, type LayerOptions } from "./ui/layer";

export const VERSION = "0.1.0";

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
  /** Notes currently known to the store, synchronously. */
  notes(filter?: NoteFilter): Note[];
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

  const enable = (): boolean => {
    if (gate && !gate()) {
      return false;
    }
    ensureLayer().enable();
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
      const all = store?.notes() ?? [];
      return filter ? all.filter((note) => matches(note, filter)) : all;
    },
    export: (options = {}) => {
      const notes = store?.notes() ?? [];
      const includeDone = options.includeDone ?? true;
      const selected = includeDone ? notes : notes.filter((note) => note.status !== "done");
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

function matches(note: Note, filter: NoteFilter): boolean {
  if (filter.status) {
    const wanted = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!wanted.includes(note.status)) {
      return false;
    }
  }
  if (filter.includeDone === false && note.status === "done") return false;
  if (filter.intent && note.intent !== filter.intent) return false;
  if (filter.type && note.type !== filter.type) return false;
  if (filter.route && note.anchor.route !== filter.route) return false;
  if (filter.session && note.sessionRef !== filter.session) return false;
  if (filter.environment && note.environment !== filter.environment) return false;
  if (filter.source && note.source !== filter.source) return false;
  if (filter.since && note.updatedAt < filter.since) return false;
  return true;
}

export type { Adapter, AdapterLike, AdapterName } from "./core/adapter";
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
