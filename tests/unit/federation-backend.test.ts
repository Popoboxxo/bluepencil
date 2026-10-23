/**
 * Federation backend + tool semantics (PR 4; T23, T38–T40, T50–T52, T58–T61, T69, T71, T75–T77,
 * T83–T84, T88–T89).
 *
 * Every test is in-process: peers and `self` are fakes with call counters, so "exactly one tools/call
 * to the target", "no POST when mode_denied" and "self runs locally" are observable facts instead of
 * assumptions. The tool cases drive the real `callTool` path, not a parallel implementation.
 */
import { describe, expect, it } from "vitest";

import {
  createFederatedBackend,
  type PeerSource,
  type SelfSource,
} from "../../src/federation/backend";
import { FederationError } from "../../src/federation/errors";
import { createStoreBackend } from "../../src/mcp/backend";
import { handleRpcExchange, PROTOCOL_VERSION } from "../../src/mcp/protocol";
import {
  callTool,
  createStorePersistence,
  type ToolContext,
} from "../../src/mcp/tools";
import { appendMessage, createNote, type Environment, type Message, type Note, type NoteDraft, type NoteFilter, type NotePatch, type Session } from "../../src/core/model";
import { applyPatch, matchesFilter } from "../../src/core/adapter";
import { createStore } from "../../src/core/store";
import { serializeNoteSet } from "../../src/adapters/memory";
import { createBundle, bundleToJson } from "../../src/data/bundle";
import type { InstanceClient } from "../../src/federation/client";
import type { FederatedNote } from "../../src/federation/aggregate";
import type { ImportOptions } from "../../src/mcp/backend";

const NOW = "2026-02-01T00:00:00.000Z";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function note(id: string, environment: Environment = "dev", extra: Partial<NoteDraft> = {}): Note {
  return createNote({
    id,
    now: NOW,
    type: "text",
    body: `body of ${id}`,
    anchor: { hook: id },
    author: "human",
    authorType: "human",
    source: "ui:human",
    environment,
    ...extra,
  });
}

interface Counters {
  list: number;
  get: number;
  create: number;
  update: number;
  message: number;
  bulk: number;
  sessions: number;
  export: number;
  import: number;
  health: number;
  close: number;
}

function emptyCounters(): Counters {
  return {
    list: 0,
    get: 0,
    create: 0,
    update: 0,
    message: 0,
    bulk: 0,
    sessions: 0,
    export: 0,
    import: 0,
    health: 0,
    close: 0,
  };
}

interface PeerInit {
  id: string;
  app?: string;
  environment?: Environment;
  mode?: "read" | "write";
  notes?: Note[];
  sessions?: Session[];
  healthError?: FederationError;
}

class FakePeer implements PeerSource {
  readonly id: string;
  app?: string;
  environment?: Environment;
  mode: "read" | "write";
  version = "0.10.0";
  unverified = false;
  clientName?: string;
  notes: Note[];
  sessionsList: Session[];
  healthError?: FederationError;
  readonly calls = emptyCounters();

  constructor(init: PeerInit) {
    this.id = init.id;
    if (init.app !== undefined) this.app = init.app;
    if (init.environment !== undefined) this.environment = init.environment;
    this.mode = init.mode ?? "read";
    this.notes = clone(init.notes ?? []);
    this.sessionsList = clone(init.sessions ?? []);
    if (init.healthError !== undefined) this.healthError = init.healthError;
  }

  async list(filter: NoteFilter): Promise<Note[]> {
    this.calls.list += 1;
    return this.notes.filter((candidate) => matchesFilter(candidate, filter)).map(clone);
  }

  async getNote(id: string): Promise<Note> {
    this.calls.get += 1;
    const found = this.notes.find((candidate) => candidate.id === id);
    if (found === undefined) {
      throw new FederationError("not_found", `note ${id} not found`, { instance: this.id });
    }
    return clone(found);
  }

  async createNote(draft: NoteDraft): Promise<Note> {
    this.calls.create += 1;
    const created = createNote({
      ...draft,
      id: draft.id ?? `n-${this.id}-${this.calls.create}`,
      now: draft.now ?? NOW,
      environment: draft.environment ?? this.environment ?? "dev",
    });
    this.notes.push(created);
    return clone(created);
  }

  async updateNote(id: string, patch: NotePatch): Promise<Note> {
    this.calls.update += 1;
    const index = this.notes.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new FederationError("not_found", `note ${id} not found`, { instance: this.id });
    const updated = applyPatch(this.notes[index] as Note, patch, NOW);
    this.notes[index] = updated;
    return clone(updated);
  }

  async addMessage(id: string, message: Message): Promise<Note> {
    this.calls.message += 1;
    const index = this.notes.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new FederationError("not_found", `note ${id} not found`, { instance: this.id });
    const updated = appendMessage(this.notes[index] as Note, message);
    this.notes[index] = updated;
    return clone(updated);
  }

  async bulkRemove(ids: string[]): Promise<{ removed: number }> {
    this.calls.bulk += 1;
    const before = this.notes.length;
    this.notes = this.notes.filter((candidate) => !ids.includes(candidate.id));
    return { removed: before - this.notes.length };
  }

  async sessions(): Promise<Session[]> {
    this.calls.sessions += 1;
    return clone(this.sessionsList);
  }

  async exportBundle(options: { format: "json" | "markdown"; includeDone: boolean }) {
    this.calls.export += 1;
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ instance: this.id, ...options }) }],
    };
  }

  async importBundle(bundle: unknown, options: ImportOptions) {
    this.calls.import += 1;
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ instance: this.id, bundle, dryRun: options.dryRun }),
        },
      ],
    };
  }

  async health() {
    this.calls.health += 1;
    if (this.healthError !== undefined) throw this.healthError;
    return {
      ok: true,
      ...(this.app === undefined ? {} : { app: this.app }),
      ...(this.environment === undefined ? {} : { environment: this.environment }),
      version: this.version,
      ...(this.unverified ? { unverified: true } : {}),
    };
  }

  async close(): Promise<void> {
    this.calls.close += 1;
  }
}

interface SelfInit {
  notes?: Note[];
  sessions?: Session[];
  readOnly?: boolean;
  app?: string;
  environment?: Environment;
}

class FakeSelf implements SelfSource {
  readonly id = "self";
  app: string;
  environment: Environment;
  /** Deliberately kept "read": `mode` never applies to self. */
  readonly mode = "read" as const;
  readOnly: boolean;
  notes: Note[];
  sessionsList: Session[];
  readonly calls = emptyCounters();
  confirmCalls = 0;
  lastConfirmAction?: string;

  constructor(init: SelfInit = {}) {
    this.app = init.app ?? "self-app";
    this.environment = init.environment ?? "dev";
    this.readOnly = init.readOnly === true;
    this.notes = clone(init.notes ?? []);
    this.sessionsList = clone(init.sessions ?? []);
  }

  async list(filter: NoteFilter): Promise<Note[]> {
    this.calls.list += 1;
    return this.notes.filter((candidate) => matchesFilter(candidate, filter)).map(clone);
  }

  async get(id: string): Promise<Note | undefined> {
    this.calls.get += 1;
    const found = this.notes.find((candidate) => candidate.id === id);
    return found === undefined ? undefined : clone(found);
  }

  async create(draft: NoteDraft): Promise<Note> {
    this.calls.create += 1;
    const created = createNote({
      ...draft,
      id: draft.id ?? `n-self-${this.calls.create}`,
      now: draft.now ?? NOW,
      environment: draft.environment ?? this.environment,
    });
    this.notes.push(created);
    return clone(created);
  }

  async update(id: string, patch: NotePatch): Promise<Note> {
    this.calls.update += 1;
    const index = this.notes.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new FederationError("not_found", `note ${id} not found`, { instance: "self" });
    const updated = applyPatch(this.notes[index] as Note, patch, NOW);
    this.notes[index] = updated;
    return clone(updated);
  }

  async addMessage(id: string, message: Message): Promise<Note> {
    this.calls.message += 1;
    const index = this.notes.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new FederationError("not_found", `note ${id} not found`, { instance: "self" });
    const updated = appendMessage(this.notes[index] as Note, message);
    this.notes[index] = updated;
    return clone(updated);
  }

  async remove(id: string): Promise<void> {
    this.calls.bulk += 1;
    this.notes = this.notes.filter((candidate) => candidate.id !== id);
  }

  async bulkRemove(filter: NoteFilter): Promise<{ removed: number }> {
    this.calls.bulk += 1;
    const before = this.notes.length;
    this.notes = this.notes.filter((candidate) => !matchesFilter(candidate, filter));
    return { removed: before - this.notes.length };
  }

  async sessions(): Promise<Session[]> {
    this.calls.sessions += 1;
    return clone(this.sessionsList);
  }

  async exportBundle(options: { format: "json" | "markdown"; includeDone: boolean }) {
    this.calls.export += 1;
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ instance: "self", ...options }) }],
    };
  }

  async importBundle(bundle: unknown, options: ImportOptions) {
    this.calls.import += 1;
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ instance: "self", bundle, dryRun: options.dryRun }),
        },
      ],
    };
  }

  async confirmWrite(expected: readonly Note[], action: string) {
    this.confirmCalls += 1;
    this.lastConfirmAction = action;
    void expected;
    return null;
  }
}

interface BackendInit {
  sources?: PeerSource[];
  self?: SelfSource;
  allowWrite?: boolean;
  readOnly?: boolean;
  includeSelf?: boolean;
  timeoutMs?: number;
}

function createBackend(init: BackendInit = {}) {
  return createFederatedBackend({
    sources: init.sources ?? [],
    ...(init.self === undefined ? {} : { self: init.self }),
    allowWrite: init.allowWrite ?? true,
    readOnly: init.readOnly ?? false,
    appName: "fed",
    clientName: "vitest",
    defaults: {
      includeSelf: init.includeSelf ?? true,
      timeoutMs: init.timeoutMs ?? 200,
      limit: 200,
      concurrency: 4,
    },
  });
}

function contextFor(backend: ReturnType<typeof createBackend>, allowWrite = true): ToolContext {
  return {
    backend,
    allowWrite,
    appName: "fed",
    clientName: "vitest",
    sessionId: "s-fed",
  };
}

async function call(
  context: ToolContext,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; text: string; value: <T = Record<string, unknown>>() => T }> {
  const response = await callTool(context, name, args);
  const text = response.content.map((entry) => entry.text).join("\n");
  return {
    isError: response.isError === true,
    text,
    value: <T,>() => JSON.parse(text) as T,
  };
}

function toolError(text: string): { code: string; message: string; instance?: string } {
  return (JSON.parse(text) as { error: { code: string; message: string; instance?: string } }).error;
}

async function rejection(promise: Promise<unknown>): Promise<FederationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FederationError) return error;
    throw error;
  }
  throw new Error("expected a FederationError, but the call resolved");
}

function draft(body = "new note"): NoteDraft {
  return {
    type: "text",
    body,
    anchor: { hook: "h" },
    intent: "implement",
    author: "vitest (mcp:s-fed)",
    authorType: "agent",
    source: "agent",
  };
}

/* ------------------------------------------------------------------------------------------------
 * T23 / FR-16.5 — tool list and protocol identity
 * ---------------------------------------------------------------------------------------------- */

describe("T23 tools/list and protocol identity", () => {
  it("lists 10 tools including list_instances and keeps the protocol version", async () => {
    const backend = createBackend({ sources: [new FakePeer({ id: "dev" })] });
    const context = contextFor(backend);

    const listed = await handleRpcExchange(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      context,
    );
    const tools = (
      listed?.result as {
        tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>;
      }
    ).tools;
    expect(tools).toHaveLength(10);
    expect(tools.map((tool) => tool.name)).toContain("list_instances");
    // Federation keeps the arguments a single-store session must not advertise (F1).
    const listNotes = tools.find((tool) => tool.name === "list_notes");
    expect(listNotes?.inputSchema.properties).toHaveProperty("instance");
    expect(listNotes?.inputSchema.properties).toHaveProperty("limit");
    expect(tools.find((tool) => tool.name === "create_note")?.inputSchema.properties).toHaveProperty(
      "instance",
    );
    expect(PROTOCOL_VERSION).toBe("2024-11-05");

    const initialized = await handleRpcExchange(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "agent" } },
      },
      context,
    );
    expect((initialized?.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
      "bluepencil-federator",
    );
    expect((initialized?.result as { protocolVersion: string }).protocolVersion).toBe(
      PROTOCOL_VERSION,
    );
  });

  it("offers no resources and answers resource_unsupported (FR-16.5, T73)", async () => {
    const backend = createBackend({ sources: [new FakePeer({ id: "dev" })] });
    const context = contextFor(backend);

    const listed = await handleRpcExchange(
      { jsonrpc: "2.0", id: 1, method: "resources/list" },
      context,
    );
    expect(listed?.result).toEqual({ resources: [] });

    const read = await handleRpcExchange(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "resources/read",
        params: { uri: "bluepencil://notes" },
      },
      context,
    );
    expect(read).toMatchObject({ error: { code: -32602 } });
    expect(String(read?.error?.message)).toContain("resource_unsupported");
  });
});

/* ------------------------------------------------------------------------------------------------
 * T38 / T50 / T51 / T93 / T94 — two write locks
 * ---------------------------------------------------------------------------------------------- */

describe("T38/T50/T51/T93/T94 write locks", () => {
  it("refuses a mode:read target without a POST", async () => {
    const peer = new FakePeer({ id: "dev", mode: "read" });
    const backend = createBackend({ sources: [peer], allowWrite: true });

    const error = await rejection(backend.create(draft(), "dev"));
    expect(error.code).toBe("mode_denied");
    expect(peer.calls.create).toBe(0);
  });

  it("allows mode:write only with allowWrite, and readOnly wins", async () => {
    const allowedPeer = new FakePeer({ id: "dev", mode: "write" });
    const allowed = createBackend({ sources: [allowedPeer], allowWrite: true });
    await expect(allowed.create(draft(), "dev")).resolves.toMatchObject({ id: "dev/n-dev-1" });
    expect(allowedPeer.calls.create).toBe(1);

    const deniedPeer = new FakePeer({ id: "dev", mode: "write" });
    const denied = createBackend({ sources: [deniedPeer], allowWrite: false });
    const deniedError = await rejection(denied.create(draft(), "dev"));
    expect(deniedError.code).toBe("mode_denied");
    expect(deniedPeer.calls.create).toBe(0);

    const readOnlyPeer = new FakePeer({ id: "dev", mode: "write" });
    const readOnly = createBackend({ sources: [readOnlyPeer], allowWrite: true, readOnly: true });
    const readOnlyError = await rejection(readOnly.create(draft(), "dev"));
    expect(readOnlyError.code).toBe("read_only");
    expect(readOnlyPeer.calls.create).toBe(0);
  });

  it("denies every write when allowWrite is off, including self", async () => {
    const self = new FakeSelf();
    const backend = createBackend({ self, allowWrite: false });

    const createError = await rejection(backend.create(draft(), "self"));
    expect(createError.code).toBe("mode_denied");
    expect(self.calls.create).toBe(0);

    const list = await backend.list({});
    expect(list.notes).toEqual([]);
  });
});

/* ------------------------------------------------------------------------------------------------
 * T39 / T40 — environment and id safety
 * ---------------------------------------------------------------------------------------------- */

describe("T39/T40 write safety and id qualification", () => {
  it("never rewrites environment and rejects allow_env_mismatch before a request", async () => {
    const peer = new FakePeer({ id: "dev", mode: "write", environment: "dev" });
    const backend = createBackend({ sources: [peer] });

    const created = await backend.create(
      { ...draft(), environment: "dev" } as NoteDraft,
      "dev",
    );
    expect(created.environment).toBe("dev");

    const error = await rejection(
      backend.importBundle({}, { mode: "merge", dryRun: true, allowEnvMismatch: true }, "dev"),
    );
    expect(error.code).toBe("invalid_argument");
    expect(peer.calls.import).toBe(0);
  });

  it("rejects path traversal and percent-encoded separators without a request", async () => {
    const peer = new FakePeer({ id: "dev", notes: [note("n-1")] });
    const backend = createBackend({ sources: [peer] });

    for (const id of ["dev/../n-1", "dev/%2Fn-1", "/n-1", "dev/a\\b"]) {
      const error = await rejection(backend.get(id));
      expect(error.code, id).toBe("invalid_id");
      const writeError = await rejection(backend.update(id, { status: "done" }, "dev"));
      expect(writeError.code, id).toBe("invalid_id");
    }
    expect(peer.calls.get).toBe(0);
    expect(peer.calls.update).toBe(0);
  });

  it("rejects a note part that still contains a slash, before any request (F4)", async () => {
    const peer = new FakePeer({ id: "dev", mode: "write", notes: [note("n-1")] });
    const self = new FakeSelf({ notes: [note("n-self")] });
    const backend = createBackend({ sources: [peer], self });

    for (const id of ["self/n-1/x", "dev/n-1/x"]) {
      const error = await rejection(backend.get(id));
      expect(error.code, id).toBe("invalid_id");
      const writeError = await rejection(backend.update(id, { status: "done" }, "dev"));
      expect(writeError.code, id).toBe("invalid_id");
    }
    expect(peer.calls.get).toBe(0);
    expect(peer.calls.update).toBe(0);
    expect(self.calls.get).toBe(0);
    expect(self.calls.update).toBe(0);
  });

  it("rejects a mismatching instance argument for a qualified id", async () => {
    const backend = createBackend({
      sources: [new FakePeer({ id: "dev", notes: [note("n-1")] })],
    });
    const error = await rejection(backend.get("dev/n-1", "staging"));
    expect(error.code).toBe("invalid_argument");
  });
});

/* ------------------------------------------------------------------------------------------------
 * T52 — instance_required
 * ---------------------------------------------------------------------------------------------- */

describe("T52 instance_required for writes", () => {
  it("requires an explicit target for create, bulk_remove, export and import", async () => {
    const backend = createBackend({ sources: [new FakePeer({ id: "dev", mode: "write" })] });

    expect((await rejection(backend.create(draft()))).code).toBe("instance_required");
    expect((await rejection(backend.bulkRemove({}))).code).toBe("instance_required");
    expect(
      (await rejection(backend.exportBundle("", { format: "json", includeDone: true }))).code,
    ).toBe("instance_required");
    expect(
      (
        await rejection(
          backend.importBundle({}, { mode: "merge", dryRun: true }, ""),
        )
      ).code,
    ).toBe("instance_required");
  });

  it("requires an instance for an unqualified id — even in a combined hub", async () => {
    const pure = createBackend({
      sources: [new FakePeer({ id: "dev", mode: "write" })],
      includeSelf: false,
    });
    expect((await rejection(pure.update("n-1", { status: "done" }))).code).toBe("instance_required");

    const combined = createBackend({
      sources: [new FakePeer({ id: "dev", mode: "write" })],
      self: new FakeSelf({ notes: [note("n-self")] }),
    });
    expect((await rejection(combined.update("n-self", { status: "done" }))).code).toBe(
      "instance_required",
    );
  });
});

/* ------------------------------------------------------------------------------------------------
 * T58 — aggregate envelope
 * ---------------------------------------------------------------------------------------------- */

describe("T58 aggregate envelope", () => {
  it("returns qualified notes, the envelope and [instance] in Markdown", async () => {
    const dev = new FakePeer({
      id: "dev",
      app: "dev-app",
      environment: "dev",
      notes: [note("n-1", "dev")],
    });
    const staging = new FakePeer({
      id: "staging",
      app: "staging-app",
      environment: "staging",
      notes: [note("n-2", "staging")],
    });
    const backend = createBackend({ sources: [dev, staging], includeSelf: false });

    const listed = await backend.list({});
    expect(listed.notes.map((entry) => entry.id)).toEqual(["dev/n-1", "staging/n-2"]);
    expect(listed.notes.map((entry) => (entry as FederatedNote).instance)).toEqual(["dev", "staging"]);
    expect(listed.notes.map((entry) => (entry as FederatedNote).app)).toEqual(["dev-app", "staging-app"]);
    expect(listed.partial).toBe(false);
    expect(listed.truncated).toBe(false);
    expect(listed.errors).toEqual([]);

    const context = contextFor(backend);
    const json = await call(context, "list_notes");
    const payload = json.value<{
      instances: Array<{ id: string }>;
      partial: boolean;
      truncated: boolean;
      errors: unknown[];
      environment?: string;
      count: number;
      notes: Array<{ id: string; instance: string; app: string; environment: string }>;
    }>();
    expect(payload.instances.map((row) => row.id)).toEqual(["dev", "staging"]);
    expect(payload.partial).toBe(false);
    expect(payload.truncated).toBe(false);
    expect(payload.errors).toEqual([]);
    expect("environment" in payload).toBe(false);
    expect(payload.count).toBe(2);
    expect(payload.notes.map((entry) => entry.id)).toEqual(["dev/n-1", "staging/n-2"]);
    expect(payload.notes.map((entry) => entry.environment)).toEqual(["dev", "staging"]);

    const markdown = await call(context, "list_notes", { format: "markdown" });
    expect(markdown.text).toContain("[dev]");
    expect(markdown.text).toContain("[staging]");
  });

  it("clamps a too-large limit and reports truncation", async () => {
    const peer = new FakePeer({
      id: "dev",
      notes: [note("n-1"), note("n-2"), note("n-3")],
    });
    const backend = createBackend({ sources: [peer], includeSelf: false });

    const result = await call(contextFor(backend), "list_notes", { limit: 5000 });
    const payload = result.value<{ count: number; truncated: boolean }>();
    expect(payload.count).toBe(3);
    expect(payload.truncated).toBe(false);

    const small = await call(contextFor(backend), "list_notes", { limit: 1 });
    const smallPayload = small.value<{ count: number; truncated: boolean }>();
    expect(smallPayload.count).toBe(1);
    expect(smallPayload.truncated).toBe(true);
  });

  it("filters by environment without rewriting note environments", async () => {
    const dev = new FakePeer({ id: "dev", notes: [note("n-1", "dev")] });
    const staging = new FakePeer({ id: "staging", notes: [note("n-2", "staging")] });
    const backend = createBackend({ sources: [dev, staging], includeSelf: false });

    const filtered = await call(contextFor(backend), "list_notes", { environment: "dev" });
    const payload = filtered.value<{
      environment?: string;
      count: number;
      notes: Array<{ id: string; environment: string }>;
    }>();
    expect(payload.environment).toBe("dev");
    expect(payload.count).toBe(1);
    expect(payload.notes[0]).toMatchObject({ id: "dev/n-1", environment: "dev" });
  });

  it("times out a single selected instance and maps the failure", async () => {
    const slow = new FakePeer({ id: "slow" });
    slow.list = () => new Promise<Note[]>(() => undefined);
    const backend = createBackend({ sources: [slow], includeSelf: false, timeoutMs: 20 });

    const listed = await backend.list({}, { instance: "slow" });
    expect(listed.notes).toEqual([]);
    expect(listed.instances[0]).toMatchObject({ id: "slow", ok: false, code: "timeout" });
    expect(listed.errors.map((error) => error.code)).toEqual(["timeout"]);

    const result = await call(contextFor(backend), "list_notes", { instance: "slow" });
    expect(result.isError).toBe(true);
    expect(toolError(result.text).code).toBe("timeout");
  });

  it("makes a total failure an isError result instead of an empty list", async () => {
    const dead = new FakePeer({ id: "dead" });
    dead.list = async () => {
      throw new FederationError("instance_unreachable", "dead: request failed", { instance: "dead" });
    };
    const backend = createBackend({ sources: [dead], includeSelf: false });

    const listed = await backend.list({});
    expect(listed.notes).toEqual([]);
    expect(listed.partial).toBe(false);
    expect(listed.errors.map((error) => error.code)).toEqual(["instance_unreachable"]);

    const result = await call(contextFor(backend), "list_notes");
    expect(result.isError).toBe(true);
    expect(toolError(result.text).code).toBe("instance_unreachable");
  });
});

/* ------------------------------------------------------------------------------------------------
 * T59 — write routing, no fan-out
 * ---------------------------------------------------------------------------------------------- */

describe("T59 write routing", () => {
  it("routes every write to exactly one instance", async () => {
    const dev = new FakePeer({ id: "dev", mode: "write", environment: "dev", notes: [note("n-1", "dev")] });
    const staging = new FakePeer({ id: "staging", mode: "write", environment: "staging", notes: [note("n-2", "staging")] });
    const backend = createBackend({ sources: [dev, staging], includeSelf: false });
    const context = contextFor(backend);

    const created = await call(context, "create_note", {
      instance: "dev",
      body: "routed",
      hook: "h",
      session: "s-1",
    });
    expect(created.isError).toBe(false);
    expect(dev.calls.create).toBe(1);
    expect(staging.calls.create).toBe(0);

    const createdNote = created.value<{ created: { id: string; instance: string } }>().created;
    expect(createdNote.id).toMatch(/^dev\/n-/);
    expect(createdNote.instance).toBe("dev");

    await call(context, "reply", { instance: "dev", id: createdNote.id, text: "done" });
    await call(context, "set_status", { instance: "dev", id: createdNote.id, status: "done" });
    await call(context, "set_intent", { instance: "dev", id: createdNote.id, intent: "feedback" });
    expect(dev.calls.message).toBe(1);
    expect(dev.calls.update).toBe(2);
    expect(staging.calls.message).toBe(0);
    expect(staging.calls.update).toBe(0);

    expect((await rejection(backend.bulkRemove({}, "all"))).code).toBe("fanout_denied");
    const removed = await backend.bulkRemove({ session: "s-1" }, "dev");
    expect(removed.removed).toBe(1);
    expect(dev.calls.bulk).toBe(1);
    expect(staging.calls.bulk).toBe(0);

    await backend.exportBundle("dev", { format: "json", includeDone: true });
    await backend.importBundle({}, { mode: "merge", dryRun: true }, "dev");
    expect(dev.calls.export).toBe(1);
    expect(dev.calls.import).toBe(1);
    expect(staging.calls.export).toBe(0);
    expect(staging.calls.import).toBe(0);
  });

  it("removes a peer note through exactly one bulk-delete call (no DELETE verb)", async () => {
    const peer = new FakePeer({ id: "dev", mode: "write", notes: [note("n-1")] });
    const backend = createBackend({ sources: [peer], includeSelf: false });

    await backend.remove("dev/n-1", "dev");
    expect(peer.calls.bulk).toBe(1);
    expect(peer.notes).toEqual([]);
  });

  it("maps a selector to fanout_denied for bulk_remove and import", async () => {
    const backend = createBackend({ sources: [new FakePeer({ id: "dev", mode: "write" })] });
    expect((await rejection(backend.bulkRemove({}, "*"))).code).toBe("fanout_denied");
    expect(
      (await rejection(backend.importBundle({}, { mode: "merge", dryRun: true }, "*"))).code,
    ).toBe("fanout_denied");
  });
});

/* ------------------------------------------------------------------------------------------------
 * T60 / T77 — list_instances
 * ---------------------------------------------------------------------------------------------- */

describe("T60/T77 list_instances", () => {
  it("never exposes base URLs or credentials and always reports a mode", async () => {
    const peer = new FakePeer({ id: "dev", app: "dev-app", environment: "dev", mode: "write" });
    // Extra fields a leaky implementation might copy.
    Object.assign(peer, { base: "https://secret.example", auth: "super-secret-token" });
    const backend = createBackend({ sources: [peer], includeSelf: false });

    const result = await call(contextFor(backend), "list_instances");
    const rows = result.value<Array<Record<string, unknown>>>();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "dev", app: "dev-app", environment: "dev", mode: "write", ok: true });
    expect(JSON.stringify(rows)).not.toContain("secret.example");
    expect(JSON.stringify(rows)).not.toContain("super-secret-token");
    expect("base" in rows[0]!).toBe(false);
    expect("auth" in rows[0]!).toBe(false);
  });

  it("includes self only with includeSelf and reports its effective mode", async () => {
    const peer = new FakePeer({ id: "dev", app: "dev-app" });
    const self = new FakeSelf();

    const writable = createBackend({ sources: [peer], self, includeSelf: true, allowWrite: true });
    const rows = (await writable.instances()).filter((row) => row.id === "self");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "self", mode: "write", ok: true, includeSelf: true });

    const readOnlySession = createBackend({
      sources: [peer],
      self,
      includeSelf: true,
      allowWrite: false,
    });
    const readRows = (await readOnlySession.instances()).filter((row) => row.id === "self");
    expect(readRows[0]).toMatchObject({ id: "self", mode: "read", includeSelf: true });

    const excluded = createBackend({ sources: [peer], self, includeSelf: false });
    expect((await excluded.instances()).some((row) => row.id === "self")).toBe(false);
    expect((await call(contextFor(excluded), "list_instances")).text).not.toContain('"self"');
  });

  it("reports an unreachable peer as ok:false with its code", async () => {
    const peer = new FakePeer({
      id: "dead",
      healthError: new FederationError("timeout", "dead timed out", { instance: "dead" }),
    });
    const backend = createBackend({ sources: [peer], includeSelf: false });
    const row = (await backend.instances())[0];
    expect(row).toMatchObject({ id: "dead", ok: false, code: "timeout" });

    // `list_instances` publishes the diagnostic too (F3): an `ok:false` row without a code says
    // nothing about why the instance is degraded.
    const rows = (await call(contextFor(backend), "list_instances")).value<Array<Record<string, unknown>>>();
    expect(rows[0]).toMatchObject({ id: "dead", ok: false, code: "timeout" });
  });
});

/* ------------------------------------------------------------------------------------------------
 * T61 / T88 — sessions and filters
 * ---------------------------------------------------------------------------------------------- */

describe("T61/T88 sessions and session filters", () => {
  const session: Session = { ref: "review-1", label: "Review 1", createdAt: NOW };

  function fakes() {
    const dev = new FakePeer({
      id: "dev",
      environment: "dev",
      notes: [note("n-1", "dev", { sessionRef: "review-1" }), note("n-9", "dev", { sessionRef: "other" })],
      sessions: [session],
    });
    const staging = new FakePeer({
      id: "staging",
      environment: "staging",
      notes: [note("n-2", "staging", { sessionRef: "review-1" })],
      sessions: [session],
    });
    return { dev, staging };
  }

  it("qualifies Session.ref but never Note.sessionRef", async () => {
    const { dev, staging } = fakes();
    const backend = createBackend({ sources: [dev, staging], includeSelf: false });

    const all = await backend.sessions();
    expect(all.map((entry) => entry.ref)).toEqual(["dev/review-1", "staging/review-1"]);

    const devOnly = await backend.sessions("dev");
    expect(devOnly.map((entry) => entry.ref)).toEqual(["dev/review-1"]);

    const listed = await backend.list({ session: "review-1" });
    expect(listed.notes.map((entry) => entry.sessionRef)).toEqual(["review-1", "review-1"]);
  });

  it("routes a qualified session filter and keeps an unqualified one instance-local", async () => {
    const routedFakes = fakes();
    const routed = createBackend({
      sources: [routedFakes.dev, routedFakes.staging],
      includeSelf: false,
    });
    const qualified = await routed.list({ session: "dev/review-1" });
    expect(qualified.notes.map((entry) => entry.id)).toEqual(["dev/n-1"]);
    expect(routedFakes.dev.calls.list).toBe(1);
    expect(routedFakes.staging.calls.list).toBe(0);

    const localFakes = fakes();
    const local = createBackend({
      sources: [localFakes.dev, localFakes.staging],
      includeSelf: false,
    });
    const perInstance = await local.list({ session: "review-1" });
    expect(perInstance.notes.map((entry) => entry.id)).toEqual(["dev/n-1", "staging/n-2"]);
    expect(localFakes.dev.calls.list).toBe(1);
    expect(localFakes.staging.calls.list).toBe(1);
  });
});

/* ------------------------------------------------------------------------------------------------
 * T69 / T75 / T76 — includeSelf and the self write formula
 * ---------------------------------------------------------------------------------------------- */

describe("T69/T75/T76 includeSelf and self writes", () => {
  it("defaults includeSelf to true and honours an explicit false", async () => {
    const source = new FakePeer({ id: "dev", notes: [note("n-1")] });
    const self = new FakeSelf({ notes: [note("n-self")] });

    // Omitted `defaults` entirely: `includeSelf` defaults to true.
    const byDefault = createFederatedBackend({
      sources: [source],
      self,
      appName: "fed",
      allowWrite: true,
    });
    expect((await byDefault.list({})).notes.map((entry) => entry.id)).toEqual([
      "dev/n-1",
      "self/n-self",
    ]);

    const excluded = createBackend({ sources: [source], self, includeSelf: false });
    expect((await excluded.list({})).notes.map((entry) => entry.id)).toEqual(["dev/n-1"]);

    // A pure federator has no self; the default `includeSelf` is a documented no-op.
    const pure = createBackend({ sources: [new FakePeer({ id: "dev", notes: [note("n-1")] })] });
    expect((await pure.list({})).notes.map((entry) => entry.id)).toEqual(["dev/n-1"]);
    expect((await pure.instances()).some((row) => row.id === "self")).toBe(false);
  });

  it("makes self writable only under the documented formula", async () => {
    const cases: Array<{
      label: string;
      self: FakeSelf;
      allowWrite: boolean;
      readOnly: boolean;
      includeSelf: boolean;
      code?: string;
    }> = [
      {
        label: "writable",
        self: new FakeSelf(),
        allowWrite: true,
        readOnly: false,
        includeSelf: true,
      },
      {
        label: "self read-only",
        self: new FakeSelf({ readOnly: true }),
        allowWrite: true,
        readOnly: false,
        includeSelf: true,
        code: "mode_denied",
      },
      {
        label: "no allowWrite",
        self: new FakeSelf(),
        allowWrite: false,
        readOnly: false,
        includeSelf: true,
        code: "mode_denied",
      },
      {
        label: "global read-only",
        self: new FakeSelf(),
        allowWrite: true,
        readOnly: true,
        includeSelf: true,
        code: "read_only",
      },
      {
        label: "excluded",
        self: new FakeSelf(),
        allowWrite: true,
        readOnly: false,
        includeSelf: false,
        code: "self_unavailable",
      },
    ];

    for (const entry of cases) {
      const backend = createBackend({
        self: entry.self,
        allowWrite: entry.allowWrite,
        readOnly: entry.readOnly,
        includeSelf: entry.includeSelf,
      });
      if (entry.code === undefined) {
        const created = await backend.create(draft(), "self");
        expect(created.id, entry.label).toBe("self/n-self-1");
        expect(entry.self.calls.create, entry.label).toBe(1);
        // The tool calls confirmWrite after every write; self delegates to its store confirmation.
        expect(await backend.confirmWrite([], "create_note"), entry.label).toBeNull();
        expect(entry.self.confirmCalls, entry.label).toBe(1);
      } else {
        const error = await rejection(backend.create(draft(), "self"));
        expect(error.code, entry.label).toBe(entry.code);
        expect(entry.self.calls.create, entry.label).toBe(0);
      }
    }
  });

  it("delegates a self write through the tool to the self store confirmation", async () => {
    const self = new FakeSelf();
    const backend = createBackend({ self });
    const result = await call(contextFor(backend), "create_note", {
      instance: "self",
      body: "local note",
      hook: "h",
    });
    expect(result.isError).toBe(false);
    expect(result.value<{ created: { id: string; instance: string } }>().created).toMatchObject({
      id: "self/n-self-1",
      instance: "self",
    });
    expect(self.confirmCalls).toBe(1);
    expect(self.lastConfirmAction).toContain("create_note");
  });

  it("makes instance self self_unavailable when it is excluded", async () => {
    const self = new FakeSelf({ notes: [note("n-self")] });
    const backend = createBackend({ self, includeSelf: false });

    expect((await rejection(backend.list({}, { instance: "self" }))).code).toBe("self_unavailable");
    expect((await rejection(backend.create(draft(), "self"))).code).toBe("self_unavailable");
    expect((await rejection(backend.exportBundle("self", { format: "json", includeDone: true }))).code).toBe(
      "self_unavailable",
    );
  });
});

/* ------------------------------------------------------------------------------------------------
 * T71 — export/import over /mcp vs local self
 * ---------------------------------------------------------------------------------------------- */

describe("T71 export/import transport", () => {
  it("sends exactly one tools/call to the target and none to another instance", async () => {
    const dev = new FakePeer({ id: "dev", mode: "write" });
    const staging = new FakePeer({ id: "staging", mode: "write" });
    const backend = createBackend({ sources: [dev, staging], includeSelf: false });

    const exported = await backend.exportBundle("dev", { format: "json", includeDone: true });
    expect(exported.content[0]?.text).toContain('"instance":"dev"');
    expect(dev.calls.export).toBe(1);
    expect(staging.calls.export).toBe(0);

    await backend.importBundle({}, { mode: "merge", dryRun: true }, "dev");
    expect(dev.calls.import).toBe(1);
    expect(staging.calls.import).toBe(0);
  });

  it("refuses import on a read-only target without a POST", async () => {
    const peer = new FakePeer({ id: "dev", mode: "read" });
    const backend = createBackend({ sources: [peer] });
    const error = await rejection(
      backend.importBundle({}, { mode: "merge", dryRun: false }, "dev"),
    );
    expect(error.code).toBe("mode_denied");
    expect(peer.calls.import).toBe(0);
  });

  it("runs self export/import locally", async () => {
    const peer = new FakePeer({ id: "dev", mode: "write" });
    const self = new FakeSelf();
    const backend = createBackend({ sources: [peer], self });

    await backend.exportBundle("self", { format: "json", includeDone: true });
    await backend.importBundle({}, { mode: "merge", dryRun: true }, "self");
    expect(self.calls.export).toBe(1);
    expect(self.calls.import).toBe(1);
    expect(peer.calls.export).toBe(0);
    expect(peer.calls.import).toBe(0);
  });
});

/* ------------------------------------------------------------------------------------------------
 * T83 — qualified write responses and provenance
 * ---------------------------------------------------------------------------------------------- */

describe("T83 qualified write responses", () => {
  it("echoes the qualified id and keeps agent provenance on a peer", async () => {
    const peer = new FakePeer({ id: "dev", app: "dev-app", mode: "write", environment: "dev" });
    const backend = createBackend({ sources: [peer], includeSelf: false });

    const result = await call(contextFor(backend), "create_note", {
      instance: "dev",
      body: "written by the agent",
      hook: "h",
      session: "s-round-1",
    });
    expect(result.isError).toBe(false);
    const created = result.value<{ created: { id: string; instance: string } }>().created;
    expect(created.id).toMatch(/^dev\/n-/);
    expect(created.instance).toBe("dev");

    const stored = peer.notes.find((entry) => `dev/${entry.id}` === created.id);
    expect(stored).toMatchObject({
      source: "agent",
      authorType: "agent",
      sessionRef: "s-round-1",
    });
    expect(stored?.author).toContain("vitest");
    // The mutable client name was forwarded to the peer before the request (FR-16.4).
    expect(peer.clientName).toBe("vitest");

    const fetched = await call(contextFor(backend), "get_note", { id: created.id });
    expect(fetched.isError).toBe(false);
    expect(fetched.value<{ id: string; instance: string; app: string }>()).toMatchObject({
      id: created.id,
      instance: "dev",
      app: "dev-app",
    });

    // The name is mutable and is forwarded again on the next request (FR-16.4).
    backend.clientName = "second-agent";
    await backend.list({});
    expect(peer.clientName).toBe("second-agent");
  });

  it("closes peers but leaves the self store intact", async () => {
    const peer = new FakePeer({ id: "dev" });
    const self = new FakeSelf({ notes: [note("n-self")] });
    const backend = createBackend({ sources: [peer], self });
    await backend.close();
    expect(peer.calls.close).toBe(1);
    // `self` has no close in its contract and its notes are still readable.
    expect((await backend.list({}, { instance: "self" })).notes.map((entry) => entry.id)).toEqual([
      "self/n-self",
    ]);
  });
});

/* ------------------------------------------------------------------------------------------------
 * T84 / T89 — environment rules
 * ---------------------------------------------------------------------------------------------- */

describe("T84/T89 environment rules", () => {
  async function storeSession(options: { allowWrite?: boolean } = {}) {
    const file = { text: serializeNoteSet([]) };
    const { adapter, persistence } = createStorePersistence({
      read: async () => file.text,
      write: async (text: string) => {
        file.text = text;
      },
    });
    const store = createStore({ environment: "dev", adapter, now: () => NOW });
    await store.reload();
    const backend = createStoreBackend(store, {
      allowWrite: options.allowWrite ?? true,
      environment: "dev",
      appName: "store-app",
      persistence,
      clientName: "vitest",
      sessionId: "s-store",
      now: () => NOW,
    });
    return {
      context: {
        backend,
        allowWrite: options.allowWrite ?? true,
        environment: "dev" as const,
        appName: "store-app",
        clientName: "vitest",
        sessionId: "s-store",
        now: () => NOW,
        persistence,
      } satisfies ToolContext,
    };
  }

  it("keeps the single-store environment guard (T89)", async () => {
    const { context } = await storeSession();
    const refused = await call(context, "list_notes", { environment: "live" });
    expect(refused.isError).toBe(true);
    expect(toolError(refused.text).code).toBe("environment_mismatch");

    const allowed = await call(context, "list_notes", { environment: "dev" });
    expect(allowed.isError).toBe(false);
    expect(allowed.value<{ environment: string }>().environment).toBe("dev");
  });

  it("keeps single-store allow_env_mismatch unchanged (T84)", async () => {
    const { context } = await storeSession();
    const bundle = createBundle([note("n-live", "live")], {
      environment: "live",
      exportedBy: "vitest",
      app: { name: "store-app" },
      now: NOW,
    });
    const imported = await call(context, "import_bundle", {
      bundle: bundleToJson(bundle),
      mode: "merge",
      dry_run: true,
      allow_env_mismatch: true,
    });
    expect(imported.isError).toBe(false);
  });

  it("treats environment as a filter in federation and never rewrites it (T89)", async () => {
    const dev = new FakePeer({ id: "dev", notes: [note("n-1", "dev")] });
    const staging = new FakePeer({ id: "staging", notes: [note("n-2", "staging")] });
    const backend = createBackend({ sources: [dev, staging], includeSelf: false });

    const listed = await backend.list({ environment: "staging" });
    expect(listed.notes.map((entry) => entry.id)).toEqual(["staging/n-2"]);
    expect(listed.notes[0]?.environment).toBe("staging");
  });
});

/* ------------------------------------------------------------------------------------------------
 * Structural contract — InstanceClient is a PeerSource
 * ---------------------------------------------------------------------------------------------- */

type InstanceClientIsPeerSource = InstanceClient extends PeerSource ? true : false;

describe("InstanceClient satisfies the peer contract", () => {
  it("is structurally assignable to PeerSource", () => {
    const assignable: InstanceClientIsPeerSource = true;
    expect(assignable).toBe(true);
  });
});
