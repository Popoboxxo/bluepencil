/**
 * Transport-neutral backend of the MCP layer (FR-16.9, PR 1).
 *
 * The tools, the stdio loop and the hub's `/mcp` door all talk to this interface instead of a
 * `Store` directly. In this release there is exactly one implementation — `createStoreBackend` —
 * which is a thin wrapper over the existing store and the existing export/import/resource logic.
 * The federation backend (0.10, PR 4) will implement the same contract over N instances.
 *
 * Deliberately **not** a second note implementation: filtering, ordering, merge, validation and
 * canonicalisation stay in `src/core/**` + `src/data/**` (FR-15.3). The store backend delegates to
 * that code and returns exactly the tool responses of 0.8 (T65).
 *
 * Import direction: this module imports `tools.ts` at runtime (response helpers, `compareNoteSets`,
 * the bundle parser and the static resource list); `tools.ts` imports this module **type-only**, so
 * there is no runtime cycle.
 */
import { canonicalNote } from "../data/canonical";
import { bundleToJson, createBundle } from "../data/bundle";
import { mergeNotes, type MergeMode, type MergeResult } from "../data/merge";
import { excludeDone, filterNotes } from "../core/adapter";
import { sortForReview } from "../core/protocol";
import type { Store } from "../core/store";
import {
  systemClock,
  type Environment,
  type Message,
  type Note,
  type NoteDraft,
  type NoteFilter,
  type NotePatch,
  type Session,
} from "../core/model";
import {
  compareNoteSets,
  errorResponse,
  errorText,
  jsonResponse,
  listResources,
  notPersistedResponse,
  parseBundleInput,
  type McpPersistence,
  type ToolResponse,
} from "./tools";
import type { InstanceStatus } from "../federation/aggregate";
import type { FederationError } from "../federation/errors";

export type BackendKind = "store" | "federation";
export type BackendScope = "single" | "aggregate";

export interface ListOptions {
  instance?: string;
  limit?: number;
  environment?: Environment;
}

/** Re-exported so callers of the backend contract do not import the federation layer directly. */
export type { FederationError, InstanceStatus };

export interface BackendList {
  notes: Note[];
  instances: InstanceStatus[];
  partial: boolean;
  truncated: boolean;
  errors: FederationError[];
}

export interface ImportOptions {
  mode: MergeMode;
  dryRun: boolean;
  onConflict?: "fail" | "keep-incoming" | "keep-existing";
  /** Rejected by the federation backend (PR 4); the store backend keeps the 0.8 behaviour. */
  allowEnvMismatch?: boolean;
}

export interface McpBackend {
  readonly kind: BackendKind;
  readonly scope: BackendScope;
  readonly appName: string;
  /** Only set for `scope: "single"` — an aggregate has no single environment binding. */
  readonly environment?: Environment;
  /**
   * Identity recorded on agent writes and exports (FR-16.4). `initialize` may change it after the
   * backend was built, so it is mutable and part of the contract — a federation backend must not
   * silently lose the name (F1).
   */
  clientName: string;
  /**
   * Notes in the shared review order (FR-4.6/M2) — the tool layer relies on this and never sorts a
   * second time (F5).
   */
  list(filter: NoteFilter, options?: ListOptions): Promise<BackendList>;
  get(id: string, instance?: string): Promise<Note | undefined>;
  create(draft: NoteDraft, instance?: string): Promise<Note>;
  update(id: string, patch: NotePatch, instance?: string): Promise<Note>;
  addMessage(id: string, message: Message, instance?: string): Promise<Note>;
  remove(id: string, instance?: string): Promise<void>;
  bulkRemove(filter: NoteFilter, instance?: string): Promise<{ removed: number }>;
  sessions(instance?: string): Promise<Session[]>;
  instances(): Promise<InstanceStatus[]>;
  exportBundle(
    instance: string,
    options: { format: "json" | "markdown"; includeDone: boolean },
  ): Promise<ToolResponse>;
  importBundle(bundle: unknown, options: ImportOptions, instance: string): Promise<ToolResponse>;
  resources(): Array<{ uri: string; name: string; mimeType: string }>;
  readResource(uri: string): Promise<{ uri: string; mimeType: string; text: string } | null>;
  confirmWrite(expected: readonly Note[], action: string): Promise<ToolResponse | null>;
  close(): Promise<void>;
}

/** Options of the store backend — the 0.8 session shape, unchanged in meaning (FR-16.2/16.3). */
export interface StoreBackendOptions {
  allowWrite: boolean;
  environment: Environment;
  appName: string;
  persistence: McpPersistence;
  clientName: string;
  sessionId: string;
  now?: () => string;
}

/**
 * The store-backed implementation of {@link McpBackend}.
 *
 * Every optional `instance` argument is accepted for interface parity and ignored: a single-store
 * backend serves exactly one instance, `self`. No tool passes one in this release.
 */
export function createStoreBackend(store: Store, options: StoreBackendOptions): McpBackend {
  // `initialize` may change the client name after the server was built (stdio); the property is part
  // of the backend contract, and the tool context mirrors it (see `stdio.ts`).
  let clientName = options.clientName;

  const nowIso = (): string => (options.now ?? systemClock.now)();
  const agentAuthor = (): string => `${clientName} (mcp:${options.sessionId})`;

  const notPersisted = (action: string, reason: string): ToolResponse =>
    notPersistedResponse(options.persistence.lastWriteError(), action, reason);

  /**
   * F7: reload the store from the adapter and read the set back from the medium itself. A change
   * that only lives in the adapter's fallback memory is never reported as a success.
   */
  const confirm = async (expected: readonly Note[], action: string): Promise<ToolResponse | null> => {
    try {
      await store.reload();
      const persisted = await options.persistence.readPersisted();
      const issues = compareNoteSets(expected, persisted);
      return issues.length === 0 ? null : notPersisted(action, issues.join("; "));
    } catch (error) {
      return notPersisted(action, errorText(error));
    }
  };

  const instances = async (): Promise<InstanceStatus[]> => [
    {
      id: "self",
      app: options.appName,
      environment: options.environment,
      ok: true,
      mode: options.allowWrite ? "write" : "read",
      includeSelf: true,
    },
  ];

  const backend: McpBackend = {
    kind: "store",
    scope: "single",
    appName: options.appName,
    environment: options.environment,

    get clientName(): string {
      return clientName;
    },
    set clientName(value: string) {
      clientName = value;
    },

    async list(filter: NoteFilter): Promise<BackendList> {
      const notes = sortForReview(filterNotes(await store.list(), filter));
      return {
        notes,
        instances: await instances(),
        partial: false,
        truncated: false,
        errors: [],
      };
    },

    async get(id: string): Promise<Note | undefined> {
      // Go through the adapter (like the old `loadBoundNote`), not the store's optimistic memory:
      // a note changed outside `create`/`update` must be seen with its persisted content (F5).
      const notes = await store.list();
      return notes.find((candidate) => candidate.id === id);
    },

    async create(draft: NoteDraft): Promise<Note> {
      return store.create(draft);
    },

    async update(id: string, patch: NotePatch): Promise<Note> {
      return store.update(id, patch);
    },

    async addMessage(id: string, message: Message): Promise<Note> {
      return store.addMessage(id, message);
    },

    async remove(id: string): Promise<void> {
      await store.remove(id);
    },

    async bulkRemove(filter: NoteFilter): Promise<{ removed: number }> {
      return store.bulkRemove(filter);
    },

    async sessions(): Promise<Session[]> {
      const selected = filterNotes(await store.list(), { environment: options.environment });
      // `createBundle` owns the session derivation; reusing it avoids a second implementation.
      return createBundle(selected, { environment: options.environment }).sessions;
    },

    instances,

    async exportBundle(
      _instance: string,
      exportOptions: { format: "json" | "markdown"; includeDone: boolean },
    ): Promise<ToolResponse> {
      const scoped = filterNotes(await store.list(), { environment: options.environment });
      const selected = exportOptions.includeDone ? scoped : excludeDone(scoped);
      if (exportOptions.format === "json") {
        const bundle = createBundle(selected, {
          environment: options.environment,
          exportedBy: agentAuthor(),
          app: { name: options.appName },
          now: nowIso(),
        });
        return { content: [{ type: "text", text: bundleToJson(bundle) }] };
      }
      const { toMarkdown } = await import("../core/export/markdown");
      return {
        content: [
          {
            type: "text",
            text: toMarkdown(selected, {
              includeDone: exportOptions.includeDone,
              title: `${options.appName} review notes`,
            }),
          },
        ],
      };
    },

    async importBundle(bundleInput: unknown, importOptions: ImportOptions): Promise<ToolResponse> {
      const parsed = parseBundleInput(bundleInput);
      if (typeof parsed === "string") {
        return errorResponse(parsed);
      }
      const bundle = parsed;
      const policy =
        importOptions.onConflict === "keep-incoming" || importOptions.onConflict === "keep-existing"
          ? importOptions.onConflict
          : undefined;
      const modeValue: MergeMode = importOptions.mode;
      const dryRun = importOptions.dryRun;
      const allowEnvMismatch = importOptions.allowEnvMismatch === true;

      if (bundle.environment !== options.environment && !allowEnvMismatch) {
        return errorResponse(
          `bundle is tagged "${bundle.environment}" but this session is bound to "${options.environment}" ` +
            `— pass allow_env_mismatch to override deliberately (NFR-18)`,
        );
      }

      const existing = await store.list();
      let result: MergeResult;
      try {
        result = mergeNotes(existing, bundle.notes, {
          mode: modeValue,
          dryRun,
          allowEnvMismatch,
          targetEnvironment: options.environment,
          ...(policy !== undefined ? { onConflict: policy } : {}),
        });
      } catch (error) {
        return errorResponse(errorText(error));
      }

      const report = {
        mode: modeValue,
        dry_run: dryRun,
        added: result.added,
        updated: result.updated,
        skipped: result.skipped,
        removed: result.removed,
        conflicts: result.conflicts,
      };

      // F10, CLI parity: `bluepencil merge` reports the conflicts and exits 2 without writing.
      if (result.conflicts.length > 0 && policy === undefined) {
        return jsonResponse(
          {
            ...report,
            refused:
              "unresolved conflict(s) — nothing was written; pass on_conflict keep-incoming or keep-existing to resolve them",
          },
          true,
        );
      }

      const resolution =
        policy !== undefined && result.conflicts.length > 0
          ? { conflicts_resolved: result.conflicts.length, resolution: policy }
          : {};

      if (dryRun) {
        return jsonResponse({ ...report, ...resolution });
      }

      // F6: an idempotent import leaves the store file untouched.
      if (result.added + result.updated + result.removed === 0) {
        return jsonResponse({ ...report, ...resolution, written: false });
      }

      try {
        // Removals go through the store (it owns the authoritative set); everything else is one
        // whole-set write of the exact merged notes — full notes, never partial patches (F5/F6).
        const keepIds = new Set(result.notes.map((note) => note.id));
        for (const note of existing) {
          if (!keepIds.has(note.id)) {
            await store.remove(note.id);
          }
        }
      } catch (error) {
        return notPersisted(`import of ${result.notes.length} note(s)`, errorText(error));
      }
      try {
        await options.persistence.replaceAll(result.notes);
      } catch (error) {
        return notPersisted(`import of ${result.notes.length} note(s)`, errorText(error));
      }
      const failure = await confirm(result.notes, `import of ${result.notes.length} note(s)`);
      if (failure) return failure;
      return jsonResponse({ ...report, ...resolution, written: true });
    },

    resources(): Array<{ uri: string; name: string; mimeType: string }> {
      return listResources();
    },

    async readResource(
      uri: string,
    ): Promise<{ uri: string; mimeType: string; text: string } | null> {
      // Resources obey the same environment binding as the tools (FR-16.3).
      const notes = filterNotes(await store.list(), { environment: options.environment });
      switch (uri) {
        case "bluepencil://notes": {
          const { toMarkdown } = await import("../core/export/markdown");
          return {
            uri,
            mimeType: "text/markdown",
            text: toMarkdown(notes, {
              includeDone: true,
              title: `${options.appName} review notes`,
            }),
          };
        }
        case "bluepencil://notes.json":
          return {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(notes.map(canonicalNote), null, 2),
          };
        case "bluepencil://bundle": {
          const bundle = createBundle(notes, {
            environment: options.environment,
            exportedBy: agentAuthor(),
            app: { name: options.appName },
            now: nowIso(),
          });
          return { uri, mimeType: "application/json", text: bundleToJson(bundle) };
        }
        default:
          return null;
      }
    },

    confirmWrite(expected: readonly Note[], action: string): Promise<ToolResponse | null> {
      return confirm(expected, action);
    },

    async close(): Promise<void> {
      await store.destroy();
    },
  };

  return backend;
}
