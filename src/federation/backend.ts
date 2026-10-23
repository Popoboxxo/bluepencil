/**
 * Federated MCP backend (plan §6/§7, FR-16.11–16.14, PR 4).
 *
 * Reads are an aggregate over N already-persisted note sets; writes are routed to exactly one
 * target. This module owns **routing and the two write locks**, nothing else:
 *
 * - The note semantics (filtering, ordering, validation, merge, canonicalisation) stay in
 *   `src/core/**` + `src/data/**` (FR-15.3). The aggregate module owns the fan-out.
 * - A returned note is a **copy** with a qualified id (`instance/noteId`) and `instance`/`app`
 *   metadata. The source object is never mutated.
 * - Reads may span environments; writes never rewrite `environment` and never forward
 *   `allow_env_mismatch` (NFR-18).
 * - A write needs **two locks**: `allowWrite` on this session *and*, for registry peers,
 *   `mode: "write"`. A global `readOnly` wins over both. Without `allowWrite` even `self` is
 *   `mode_denied` (FR-16.13/16.14, Rev. 4 decision 3).
 * - No retry, no fan-out, no second implementation path.
 *
 * The module imports the MCP contract and tool response type **type-only**, so the runtime edge is
 * `federation -> core/data`, never `federation -> mcp/tools`.
 */

import { matchesFilter } from "../core/adapter";
import type {
  Environment,
  Message,
  Note,
  NoteDraft,
  NoteFilter,
  NotePatch,
  Session,
} from "../core/model";
import type {
  BackendList,
  ImportOptions,
  ListOptions,
  McpBackend,
} from "../mcp/backend";
import type { ToolResponse } from "../mcp/tools";
import {
  DEFAULT_AGGREGATE_CONCURRENCY,
  DEFAULT_AGGREGATE_LIMIT,
  DEFAULT_AGGREGATE_TIMEOUT_MS,
  aggregateList,
  withTimeout,
  type FederatedNote,
  type InstanceStatus,
  type ReadSource,
} from "./aggregate";
import { FederationError } from "./errors";
import {
  assertFederatableNoteId,
  formatQualifiedId,
  isSelectorInstance,
  parseQualifiedId,
  SELF_INSTANCE,
} from "./ids";

/* ------------------------------------------------------------------------------------------------
 * Shapes
 * ---------------------------------------------------------------------------------------------- */

export interface ExportOptions {
  format: "json" | "markdown";
  includeDone: boolean;
}

/** Health information an {@link InstanceClient} already knows how to fetch. */
export interface PeerHealth {
  ok: boolean;
  app?: string;
  environment?: Environment;
  version?: string;
  unverified?: boolean;
}

/**
 * The narrow contract the federation backend needs from a remote instance. `InstanceClient`
 * satisfies it structurally; tests use plain objects with call counters.
 */
export interface PeerSource extends ReadSource {
  readonly version?: string;
  readonly unverified?: boolean;
  /**
   * Mutable provenance name. The backend writes the current `clientName` here before every call
   * (FR-16.4). Clients that keep it private simply ignore the assignment.
   */
  clientName?: string;
  health?(): Promise<PeerHealth>;
  getNote(id: string): Promise<Note>;
  createNote(draft: NoteDraft): Promise<Note>;
  updateNote(id: string, patch: NotePatch): Promise<Note>;
  addMessage(id: string, message: Message): Promise<Note>;
  bulkRemove(ids: string[]): Promise<{ removed: number }>;
  sessions(): Promise<Session[]>;
  exportBundle(options: ExportOptions): Promise<ToolResponse>;
  /* `Record<string, unknown>` as well: the HTTP client's documented signature is wider than the
   * typed `ImportOptions`, and it must stay structurally assignable to this contract. */
  importBundle(
    bundle: unknown,
    options: ImportOptions | Record<string, unknown>,
  ): Promise<ToolResponse>;
  close?(): Promise<void>;
}

/**
 * The local (`self`) instance of a combined hub. It is in-process — no HTTP, no credentials — and
 * delegates to the same store backend a single-store session uses.
 */
export interface SelfSource extends ReadSource {
  readonly readOnly: boolean;
  get(id: string): Promise<Note | undefined>;
  create(draft: NoteDraft): Promise<Note>;
  update(id: string, patch: NotePatch): Promise<Note>;
  addMessage(id: string, message: Message): Promise<Note>;
  remove(id: string): Promise<void>;
  bulkRemove(filter: NoteFilter): Promise<{ removed: number }>;
  sessions(): Promise<Session[]>;
  exportBundle(options: ExportOptions): Promise<ToolResponse>;
  importBundle(bundle: unknown, options: ImportOptions): Promise<ToolResponse>;
  /** Optional store-level confirmation (F7); the backend calls it after every self write. */
  confirmWrite?(expected: readonly Note[], action: string): Promise<ToolResponse | null>;
}

export interface FederatedDefaults {
  /** Per-source timeout; default 3000 ms. */
  timeoutMs?: number;
  /** Aggregate window; default 200, clamped to 1000 by the aggregate. */
  limit?: number;
  /** Bounded fan-out width; default 8. */
  concurrency?: number;
  /** Include the local instance; default `true`. */
  includeSelf?: boolean;
}

export interface FederatedBackendOptions {
  /** Registry peers, in registry order. */
  sources: readonly PeerSource[];
  /** Combined hub only: the in-process local instance. A pure federator has no store. */
  self?: SelfSource;
  /** Session-level write opt-in (the second lock). Default `false`. */
  allowWrite?: boolean;
  /** Global read-only switch; wins over `allowWrite` and `mode: "write"`. */
  readOnly?: boolean;
  appName: string;
  /** Local environment of a combined hub; never a binding for the aggregate. */
  environment?: Environment;
  /** Mutable provenance name forwarded to peers on every request (FR-16.4). */
  clientName?: string;
  defaults?: FederatedDefaults;
}

const UNKNOWN_APP = "unknown";

type WriteTarget =
  | { kind: "self"; instance: typeof SELF_INSTANCE }
  | { kind: "peer"; instance: string; peer: PeerSource };

/* ------------------------------------------------------------------------------------------------
 * Factory
 * ---------------------------------------------------------------------------------------------- */

/** Build the federated {@link McpBackend}. */
export function createFederatedBackend(options: FederatedBackendOptions): McpBackend {
  const sources = [...options.sources];
  const self = options.self;
  const allowWrite = options.allowWrite === true;
  const readOnly = options.readOnly === true;

  const timeoutMs = positive(options.defaults?.timeoutMs, DEFAULT_AGGREGATE_TIMEOUT_MS);
  const limit = options.defaults?.limit ?? DEFAULT_AGGREGATE_LIMIT;
  const concurrency = positive(options.defaults?.concurrency, DEFAULT_AGGREGATE_CONCURRENCY);
  const includeSelf = options.defaults?.includeSelf !== false;

  let clientName = options.clientName ?? "bluepencil-federation";
  /** Expected self-store set of the last self write; `confirmWrite` consumes it (F7). */
  let pendingSelfConfirm: { action: string; expected: readonly Note[] } | undefined;

  const selfAvailable = (): boolean => includeSelf && self !== undefined;
  const selfWritable = (): boolean => allowWrite && !readOnly && selfAvailable() && self?.readOnly !== true;

  /* ----------------------------------------------------------------------------------------------
   * Self adapter
   * -------------------------------------------------------------------------------------------- */

  /**
   * The aggregate sees `self` through the same narrow contract as a peer, with the **effective**
   * write mode (the two-lock formula) instead of a registry `mode`.
   */
  function selfReadSource(): ReadSource {
    const local = self as SelfSource;
    const environment = local.environment ?? options.environment;
    return {
      id: SELF_INSTANCE,
      app: local.app ?? options.appName,
      ...(environment === undefined ? {} : { environment }),
      mode: selfWritable() ? "write" : "read",
      list: (filter) => local.list(filter),
    };
  }

  /* ----------------------------------------------------------------------------------------------
   * Error mapping
   * -------------------------------------------------------------------------------------------- */

  /**
   * Map any peer failure to one canonical {@link FederationError}. A non-federation error (a raw
   * socket/parse failure in a test double) is reduced to a generic `instance_unreachable`: its
   * message may quote a payload and must not travel. No cause chain is attached (NFR-22).
   */
  function mapError(error: unknown, instance: string): FederationError {
    if (error instanceof FederationError) {
      if (error.instance !== undefined) return error;
      return new FederationError(error.code, error.message, {
        instance,
        ...(error.status === undefined ? {} : { status: error.status }),
      });
    }
    return new FederationError("instance_unreachable", `instance "${instance}": request failed`, {
      instance,
    });
  }

  function mapSelfError(error: unknown, action: "read" | "write"): FederationError {
    if (error instanceof FederationError) return error;
    const code = action === "write" ? "not_persisted" : "instance_unreachable";
    const message =
      error instanceof Error ? error.message : "the local instance failed without a message";
    return new FederationError(code, `self: ${message}`, { instance: SELF_INSTANCE });
  }

  /** Forward the current provenance name before a request (FR-16.4). */
  function forwardClientName(peer: PeerSource): void {
    try {
      peer.clientName = clientName;
    } catch {
      /* A client with a read-only property already received the name at construction. */
    }
  }

  async function callPeer<T>(peer: PeerSource, request: () => Promise<T>): Promise<T> {
    forwardClientName(peer);
    try {
      return await request();
    } catch (error) {
      throw mapError(error, peer.id);
    }
  }

  /**
   * Read view of a peer for the aggregate. It normalises the mode and forwards the current client
   * name before the read, so even the fan-out observes the mutable provenance name (FR-16.4).
   */
  function peerReadSource(peer: PeerSource): ReadSource {
    return {
      id: peer.id,
      ...(peer.app === undefined ? {} : { app: peer.app }),
      ...(peer.environment === undefined ? {} : { environment: peer.environment }),
      mode: peer.mode === "write" ? "write" : "read",
      list: (filter) => {
        forwardClientName(peer);
        return peer.list(filter);
      },
    };
  }

  async function callSelf<T>(action: "read" | "write", request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      throw mapSelfError(error, action);
    }
  }

  /* ----------------------------------------------------------------------------------------------
   * Selection helpers
   * -------------------------------------------------------------------------------------------- */

  function peerById(id: string): PeerSource | undefined {
    return sources.find((source) => source.id === id);
  }

  function selfTarget(): Extract<WriteTarget, { kind: "self" }> {
    if (!selfAvailable()) {
      throw new FederationError(
        "self_unavailable",
        "The local instance is not part of this session",
        { instance: SELF_INSTANCE },
      );
    }
    return { kind: "self", instance: SELF_INSTANCE };
  }

  function peerTarget(id: string): Extract<WriteTarget, { kind: "peer" }> {
    const peer = peerById(id);
    if (peer === undefined) {
      throw new FederationError("unknown_instance", `Unknown instance "${id}"`, { instance: id });
    }
    return { kind: "peer", instance: peer.id, peer };
  }

  /**
   * Resolve a single write target. Every write requires an explicit target (FR-16.13): a missing
   * instance is `instance_required`, never an implicit `self` — a caller must always say where the
   * write lands.
   */
  function resolveWriteTarget(instance: string | undefined): WriteTarget {
    const requested = instance === "" ? undefined : instance;
    if (requested !== undefined) {
      if (isSelectorInstance(requested)) {
        throw new FederationError(
          "fanout_denied",
          `A write needs exactly one instance; "${requested}" is a selector`,
          { instance: requested },
        );
      }
      if (requested === SELF_INSTANCE) return selfTarget();
      return peerTarget(requested);
    }

    throw new FederationError(
      "instance_required",
      "A write needs exactly one instance (or a qualified id)",
    );
  }

  /** The two write locks, in the documented precedence: global read-only > session opt-in > mode. */
  function assertWritable(target: WriteTarget): void {
    if (readOnly) {
      throw new FederationError(
        "read_only",
        "This federation session is read-only (--read-only)",
        { instance: target.instance },
      );
    }
    if (!allowWrite) {
      throw new FederationError(
        "mode_denied",
        "Federated writes need --allow-write on this session",
        { instance: target.instance },
      );
    }
    if (target.kind === "self") {
      if (self?.readOnly === true) {
        throw new FederationError(
          "mode_denied",
          "The local instance is read-only",
          { instance: SELF_INSTANCE },
        );
      }
      return;
    }
    if (target.peer.mode !== "write") {
      throw new FederationError(
        "mode_denied",
        `Instance "${target.instance}" is registered as read-only (mode: "read")`,
        { instance: target.instance },
      );
    }
  }

  /** Resolve a note id plus optional instance for a write. */
  function resolveNoteWrite(
    id: string,
    instance: string | undefined,
  ): { target: WriteTarget; noteId: string } {
    const requested = instance === "" ? undefined : instance;
    const parsed = parseQualifiedId(id);
    if (parsed !== null) {
      // The parse is permissive about the note part (`n-1/x` is a valid reference), but a write
      // targets exactly one note: validate it before any dispatch (F4).
      assertFederatableNoteId(parsed.noteId);
      if (requested !== undefined && requested !== parsed.instance) {
        throw new FederationError(
          "invalid_argument",
          `note id "${id}" belongs to instance "${parsed.instance}", not "${requested}"`,
          { instance: parsed.instance },
        );
      }
      if (isSelectorInstance(parsed.instance)) {
        throw new FederationError(
          "fanout_denied",
          `A write needs exactly one instance; "${parsed.instance}" is a selector`,
          { instance: parsed.instance },
        );
      }
      return {
        target:
          parsed.instance === SELF_INSTANCE ? selfTarget() : peerTarget(parsed.instance),
        noteId: parsed.noteId,
      };
    }

    if (id.includes("/")) {
      throw new FederationError("invalid_id", `Invalid note id "${id}"`, { instance: requested });
    }
    // Every write names exactly one instance (FR-16.13): a bare id is not enough.
    return { target: resolveWriteTarget(requested), noteId: id };
  }

  /* ----------------------------------------------------------------------------------------------
   * Copy helpers
   * -------------------------------------------------------------------------------------------- */

  function appOf(target: WriteTarget): string {
    if (target.kind === "self") return self?.app ?? options.appName;
    return target.peer.app ?? UNKNOWN_APP;
  }

  /** A source note copied with the qualified id and its instance metadata. */
  function qualify(note: Note, target: WriteTarget): FederatedNote {
    return {
      ...note,
      id: formatQualifiedId(target.instance, note.id),
      instance: target.instance,
      app: appOf(target),
    };
  }

  function qualifySelf(note: Note): FederatedNote {
    return {
      ...note,
      id: formatQualifiedId(SELF_INSTANCE, note.id),
      instance: SELF_INSTANCE,
      app: self?.app ?? options.appName,
    };
  }

  /* ----------------------------------------------------------------------------------------------
   * Reads
   * -------------------------------------------------------------------------------------------- */

  /**
   * Merge the tool's `environment` option into the filter without touching any note, and route a
   * qualified `session` filter (`dev/review-1`) to its instance while stripping the prefix.
   */
  function routeList(
    filter: NoteFilter,
    listOptions: ListOptions,
  ): { filter: NoteFilter; instance?: string } {
    let effective: NoteFilter = { ...filter };
    let instance = listOptions.instance;

    if (typeof effective.session === "string") {
      const parsed = parseQualifiedId(effective.session);
      if (parsed !== null) {
        if (isSelectorInstance(parsed.instance)) {
          throw new FederationError(
            "invalid_argument",
            `session "${effective.session}" cannot be routed to selector "${parsed.instance}"`,
            { instance: parsed.instance },
          );
        }
        if (instance !== undefined && instance !== parsed.instance) {
          throw new FederationError(
            "invalid_argument",
            `session "${effective.session}" belongs to instance "${parsed.instance}", not "${instance}"`,
            { instance: parsed.instance },
          );
        }
        instance = parsed.instance;
        effective = { ...effective, session: parsed.noteId };
      }
    }

    if (listOptions.environment !== undefined) {
      effective = { ...effective, environment: listOptions.environment };
    }

    return instance === undefined ? { filter: effective } : { filter: effective, instance };
  }

  /**
   * Resolve a qualified `session` filter for one already-selected target. `dev/review-1` strips to
   * `review-1`; an unqualified value stays instance-local; a foreign instance is a caller mistake.
   */
  function sessionFilterFor(filter: NoteFilter, instance: string): NoteFilter {
    if (typeof filter.session !== "string") return filter;
    const parsed = parseQualifiedId(filter.session);
    if (parsed === null) return filter;
    if (isSelectorInstance(parsed.instance) || parsed.instance !== instance) {
      throw new FederationError(
        "invalid_argument",
        `session "${filter.session}" belongs to instance "${parsed.instance}", not "${instance}"`,
        { instance: parsed.instance },
      );
    }
    return { ...filter, session: parsed.noteId };
  }

  /** Aggregate status rows always carry a mode; `self` always carries `includeSelf`. */
  function normalizeInstances(rows: readonly InstanceStatus[]): InstanceStatus[] {
    return rows.map((row) => {
      const next: InstanceStatus = { ...row, mode: row.mode ?? "read" };
      if (next.id === SELF_INSTANCE) next.includeSelf = true;
      return next;
    });
  }

  const backend: McpBackend = {
    kind: "federation",
    scope: "aggregate",
    appName: options.appName,
    environment: undefined,

    get clientName(): string {
      return clientName;
    },
    set clientName(value: string) {
      clientName = value;
    },

    async list(filter: NoteFilter, listOptions: ListOptions = {}): Promise<BackendList> {
      const routed = routeList(filter, listOptions);
      const result = await aggregateList(
        sources.map(peerReadSource),
        selfAvailable() ? selfReadSource() : undefined,
        routed.filter,
        {
          limit: listOptions.limit ?? limit,
          timeoutMs,
          concurrency,
          includeSelf,
          ...(routed.instance === undefined ? {} : { instance: routed.instance }),
        },
      );

      return {
        notes: result.notes,
        instances: normalizeInstances(result.instances),
        partial: result.partial,
        truncated: result.truncated,
        errors: result.errors,
      };
    },

    async get(id: string, instance?: string): Promise<Note | undefined> {
      const parsed = parseQualifiedId(id);
      let target: WriteTarget;
      let noteId: string;

      if (parsed !== null) {
        // A note part with a further `/` parses (it is a valid reference) but cannot identify a
        // single note: reject it here, before any request (F4).
        assertFederatableNoteId(parsed.noteId);
        if (instance !== undefined && instance !== parsed.instance) {
          throw new FederationError(
            "invalid_argument",
            `note id "${id}" belongs to instance "${parsed.instance}", not "${instance}"`,
            { instance: parsed.instance },
          );
        }
        if (isSelectorInstance(parsed.instance)) {
          throw new FederationError(
            "invalid_argument",
            `Selector "${parsed.instance}" cannot identify a single note`,
            { instance: parsed.instance },
          );
        }
        target =
          parsed.instance === SELF_INSTANCE ? selfTarget() : peerTarget(parsed.instance);
        noteId = parsed.noteId;
      } else {
        if (id.includes("/")) {
          throw new FederationError("invalid_id", `Invalid note id "${id}"`, { instance });
        }
        if (instance !== undefined) {
          if (isSelectorInstance(instance)) {
            throw new FederationError(
              "invalid_argument",
              `Selector "${instance}" cannot identify a single note`,
              { instance },
            );
          }
          target = instance === SELF_INSTANCE ? selfTarget() : peerTarget(instance);
        } else if (selfAvailable()) {
          target = { kind: "self", instance: SELF_INSTANCE };
        } else {
          throw new FederationError(
            "instance_required",
            "An unqualified note id needs an instance in a pure federator",
          );
        }
        noteId = id;
      }

      if (target.kind === "self") {
        const note = await callSelf("read", () => self!.get(noteId));
        return note === undefined ? undefined : qualifySelf(note);
      }

      try {
        const note = await callPeer(target.peer, () => target.peer.getNote(noteId));
        return note === undefined ? undefined : qualify(note, target);
      } catch (error) {
        if (error instanceof FederationError && error.code === "not_found") return undefined;
        throw error;
      }
    },

    async sessions(instance?: string): Promise<Session[]> {
      const selected: WriteTarget[] = [];
      if (instance === undefined || isSelectorInstance(instance)) {
        selected.push(...sources.map((peer) => ({ kind: "peer" as const, instance: peer.id, peer })));
        if (selfAvailable()) selected.push({ kind: "self", instance: SELF_INSTANCE });
      } else if (instance === SELF_INSTANCE) {
        selected.push(selfTarget());
      } else {
        selected.push(peerTarget(instance));
      }

      const sessions: Session[] = [];
      for (const target of selected) {
        const rows =
          target.kind === "self"
            ? await callSelf("read", () => self!.sessions())
            : await callPeer(target.peer, () => target.peer.sessions());
        for (const row of rows) {
          sessions.push({ ...row, ref: formatQualifiedId(target.instance, row.ref) });
        }
      }
      return sessions;
    },

    async instances(): Promise<InstanceStatus[]> {
      const rows = await Promise.all(
        sources.map(async (peer): Promise<InstanceStatus> => {
          const row: InstanceStatus = {
            id: peer.id,
            ok: true,
            mode: peer.mode === "write" ? "write" : "read",
          };
          const app = peer.app;
          if (app !== undefined) row.app = app;
          const environment = peer.environment;
          if (environment !== undefined) row.environment = environment;

          if (peer.health !== undefined) {
            try {
              forwardClientName(peer);
              const health = await withTimeout(peer.health(), timeoutMs, peer.id);
              row.ok = health.ok;
              if (health.app !== undefined) row.app = health.app;
              if (health.environment !== undefined) row.environment = health.environment;
              if (health.unverified === true) row.unverified = true;
              const version = health.version ?? peer.version;
              if (version !== undefined) row.version = version;
            } catch (error) {
              row.ok = false;
              row.code = mapError(error, peer.id).code;
            }
          } else {
            if (peer.unverified === true) row.unverified = true;
            if (peer.version !== undefined) row.version = peer.version;
          }
          return row;
        }),
      );

      if (selfAvailable()) {
        const environment = self?.environment ?? options.environment;
        rows.push({
          id: SELF_INSTANCE,
          app: self?.app ?? options.appName,
          ...(environment === undefined ? {} : { environment }),
          ok: true,
          mode: selfWritable() ? "write" : "read",
          includeSelf: true,
        });
      }

      return rows;
    },

    /* --------------------------------------------------------------------------------------------
     * Writes — one target, no retry, no fan-out
     * ------------------------------------------------------------------------------------------ */

    async create(draft: NoteDraft, instance?: string): Promise<Note> {
      const target = resolveWriteTarget(instance);
      assertWritable(target);

      if (target.kind === "self") {
        const before = await callSelf("read", () => self!.list({}));
        const note = await callSelf("write", () => self!.create(draft));
        pendingSelfConfirm = { action: `create_note ${note.id}`, expected: [...before, note] };
        return qualifySelf(note);
      }

      pendingSelfConfirm = undefined;
      const note = await callPeer(target.peer, () => target.peer.createNote(draft));
      return qualify(note, target);
    },

    async update(id: string, patch: NotePatch, instance?: string): Promise<Note> {
      const { target, noteId } = resolveNoteWrite(id, instance);
      assertWritable(target);

      if (target.kind === "self") {
        const before = await callSelf("read", () => self!.list({}));
        const note = await callSelf("write", () => self!.update(noteId, patch));
        pendingSelfConfirm = {
          action: `update ${noteId}`,
          expected: before.map((candidate) => (candidate.id === note.id ? note : candidate)),
        };
        return qualifySelf(note);
      }

      pendingSelfConfirm = undefined;
      const note = await callPeer(target.peer, () => target.peer.updateNote(noteId, patch));
      return qualify(note, target);
    },

    async addMessage(id: string, message: Message, instance?: string): Promise<Note> {
      const { target, noteId } = resolveNoteWrite(id, instance);
      assertWritable(target);

      if (target.kind === "self") {
        const before = await callSelf("read", () => self!.list({}));
        const note = await callSelf("write", () => self!.addMessage(noteId, message));
        pendingSelfConfirm = {
          action: `reply to ${noteId}`,
          expected: before.map((candidate) => (candidate.id === note.id ? note : candidate)),
        };
        return qualifySelf(note);
      }

      pendingSelfConfirm = undefined;
      const note = await callPeer(target.peer, () => target.peer.addMessage(noteId, message));
      return qualify(note, target);
    },

    async remove(id: string, instance?: string): Promise<void> {
      const { target, noteId } = resolveNoteWrite(id, instance);
      assertWritable(target);

      if (target.kind === "self") {
        const before = await callSelf("read", () => self!.list({}));
        await callSelf("write", () => self!.remove(noteId));
        pendingSelfConfirm = {
          action: `remove ${noteId}`,
          expected: before.filter((candidate) => candidate.id !== noteId),
        };
        return;
      }

      pendingSelfConfirm = undefined;
      // The HTTP contract has no DELETE: a single removal is a one-id bulk-delete on that target.
      await callPeer(target.peer, () => target.peer.bulkRemove([noteId]));
    },

    async bulkRemove(filter: NoteFilter, instance?: string): Promise<{ removed: number }> {
      if (instance === undefined) {
        throw new FederationError(
          "instance_required",
          "bulk_remove needs exactly one instance; no cross-instance delete",
        );
      }
      const target = resolveWriteTarget(instance);
      assertWritable(target);
      const targetFilter = sessionFilterFor(filter, target.instance);

      if (target.kind === "self") {
        const before = await callSelf("read", () => self!.list({}));
        const result = await callSelf("write", () => self!.bulkRemove(targetFilter));
        pendingSelfConfirm = {
          action: `bulk_remove (${result.removed} note(s))`,
          expected: before.filter((candidate) => !matchesFilter(candidate, targetFilter)),
        };
        return result;
      }

      pendingSelfConfirm = undefined;
      // Select on the target only, then delete exactly those ids on the same target.
      const notes = await callPeer(target.peer, () => target.peer.list(targetFilter));
      const ids = notes.map((note) => note.id);
      if (ids.length === 0) return { removed: 0 };
      return callPeer(target.peer, () => target.peer.bulkRemove(ids));
    },

    /* --------------------------------------------------------------------------------------------
     * Export / import — the target's /mcp door, never a local second implementation
     * ------------------------------------------------------------------------------------------ */

    async exportBundle(instance: string, exportOptions: ExportOptions): Promise<ToolResponse> {
      if (typeof instance !== "string" || instance === "") {
        throw new FederationError(
          "instance_required",
          "export_bundle needs exactly one instance; an aggregate would mix environments",
        );
      }
      if (isSelectorInstance(instance)) {
        throw new FederationError(
          "instance_required",
          "export_bundle needs exactly one instance; an aggregate would mix environments",
          { instance },
        );
      }

      if (instance === SELF_INSTANCE) {
        selfTarget();
        return callSelf("read", () => self!.exportBundle(exportOptions));
      }

      const target = peerTarget(instance);
      return callPeer(target.peer, () => target.peer.exportBundle(exportOptions));
    },

    async importBundle(
      bundle: unknown,
      importOptions: ImportOptions,
      instance: string,
    ): Promise<ToolResponse> {
      // NFR-18: never forward this in federation mode, and reject before any request.
      if (importOptions.allowEnvMismatch === true) {
        throw new FederationError(
          "invalid_argument",
          "allow_env_mismatch is not available in federation mode (NFR-18)",
        );
      }

      if (typeof instance !== "string" || instance === "") {
        throw new FederationError("instance_required", "import_bundle needs exactly one instance");
      }
      if (isSelectorInstance(instance)) {
        throw new FederationError(
          "fanout_denied",
          `import_bundle needs exactly one instance; "${instance}" is a selector`,
          { instance },
        );
      }

      pendingSelfConfirm = undefined;
      if (instance === SELF_INSTANCE) {
        const target = selfTarget();
        assertWritable(target);
        return callSelf("write", () => self!.importBundle(bundle, importOptions));
      }

      const target = peerTarget(instance);
      assertWritable(target);
      return callPeer(target.peer, () => target.peer.importBundle(bundle, importOptions));
    },

    /* --------------------------------------------------------------------------------------------
     * Resources, confirmation, shutdown
     * ------------------------------------------------------------------------------------------ */

    resources(): Array<{ uri: string; name: string; mimeType: string }> {
      return [];
    },

    async readResource(): Promise<{ uri: string; mimeType: string; text: string } | null> {
      return null;
    },

    async confirmWrite(): Promise<ToolResponse | null> {
      /* Peer writes are confirmed by the child's 2xx. A self write stashed its expected set and
       * delegates to the self store backend's own confirmation here (F7); a caller cannot forget
       * it because the tool always calls this after a write. */
      const pending = pendingSelfConfirm;
      pendingSelfConfirm = undefined;
      if (pending === undefined || self?.confirmWrite === undefined) return null;
      return callSelf("write", () => self.confirmWrite!(pending.expected, pending.action));
    },

    async close(): Promise<void> {
      await Promise.allSettled(
        sources.map((peer) => (peer.close === undefined ? Promise.resolve() : peer.close())),
      );
      /* The self store belongs to the hub, not to this backend: never destroy it here. */
    },
  };

  return backend;
}

/* ------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
