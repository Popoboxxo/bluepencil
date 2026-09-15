/**
 * Unit tests for the MCP tool layer (FR-16, defect list B2/F5/F6/F7/F9/F10/F12b).
 *
 * Everything here runs without a process: the session uses the file adapter's own engine over an
 * in-memory medium, which is exactly what the server wires up over `node:fs` — so the environment
 * guard, the import fidelity and the persisted-write check are tested on the real code path
 * (`createStorePersistence` + `callTool`), only the medium is a string.
 */
import { describe, expect, it } from "vitest";
import { createStorePersistence, callTool, compareNoteSets, validateStoredNoteSet, type McpPersistence, type ToolContext } from "../../src/mcp/tools";
import { createStore, type Store } from "../../src/core/store";
import { serializeNoteSet } from "../../src/adapters/memory";
import { createBundle, bundleToJson } from "../../src/data/bundle";
import { canonicalNote } from "../../src/data/canonical";
import {
  createNote,
  type DebugContext,
  type Environment,
  type Message,
  type Note,
  type NoteIntent,
  type NoteStatus,
} from "../../src/core/model";

const CREATED = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";
const NOW = "2026-02-01T00:00:00.000Z";

function message(id: string, ts: string, text: string, kind: Message["kind"] = "note"): Message {
  return { id, ts, author: "human", authorType: "human", kind, text };
}

function makeNote(input: {
  id: string;
  body: string;
  environment: Environment;
  createdAt?: string;
  updatedAt?: string;
  intent?: NoteIntent;
  status?: NoteStatus;
  sessionRef?: string;
  ticketRef?: string;
  debug?: DebugContext;
  messages?: Message[];
}): Note {
  const createdAt = input.createdAt ?? CREATED;
  const note = createNote({
    id: input.id,
    type: "text",
    body: input.body,
    anchor: { hook: input.id },
    intent: input.intent ?? "implement",
    status: input.status ?? "open",
    context: null,
    messages: input.messages ?? [],
    author: "human",
    authorType: "human",
    source: "ui:human",
    environment: input.environment,
    now: createdAt,
    ...(input.sessionRef !== undefined ? { sessionRef: input.sessionRef } : {}),
    ...(input.ticketRef !== undefined ? { ticketRef: input.ticketRef } : {}),
    ...(input.debug !== undefined ? { debug: input.debug } : {}),
  });
  return { ...note, updatedAt: input.updatedAt ?? createdAt };
}

interface TestSession {
  file: { text: string | null };
  store: Store;
  persistence: McpPersistence;
  context: ToolContext;
}

/** Opens a session exactly like the server does — only the medium is a string instead of a file. */
async function openSession(
  options: { environment?: Environment; allowWrite?: boolean; seed?: Note[]; text?: string | null; readOnly?: boolean } = {},
): Promise<TestSession> {
  const file = { text: options.text ?? (options.seed ? serializeNoteSet(options.seed) : null) };
  const { adapter, persistence } = createStorePersistence({
    read: async () => file.text,
    write: async (text: string) => {
      if (options.readOnly === true) {
        throw Object.assign(new Error("EACCES: permission denied, open 'store.json'"), { code: "EACCES" });
      }
      file.text = text;
    },
  });
  const store = createStore({ environment: options.environment ?? "dev", adapter });
  await store.reload();
  return {
    file,
    store,
    persistence,
    context: {
      store,
      allowWrite: options.allowWrite !== false,
      environment: options.environment ?? "dev",
      appName: "test-app",
      clientName: "vitest",
      sessionId: "s-test",
      now: () => NOW,
      persistence,
    },
  };
}

/** Calls a tool and hands back the readable parts of the response. */
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

/** The persisted note set, parsed through the adapter's own codec. */
function persistedNotes(session: TestSession): Note[] {
  const raw = session.file.text === null ? [] : (JSON.parse(session.file.text) as { notes?: Note[] }).notes ?? [];
  return raw;
}

function bundleText(notes: Note[], environment: Environment): string {
  return bundleToJson(
    createBundle(notes, {
      environment,
      exportedBy: "vitest",
      app: { name: "test-app" },
      now: NOW,
    }),
  );
}

describe("environment binding (B2, FR-16.3/NFR-18)", () => {
  const live = makeNote({ id: "n-live", body: "live note", environment: "live" });
  const dev = makeNote({ id: "n-dev", body: "dev note", environment: "dev" });

  it("lists only the notes of the bound environment", async () => {
    const session = await openSession({ environment: "dev", seed: [live, dev] });
    const result = await call(session.context, "list_notes", { include_done: true });
    const value = result.value<{ count: number; notes: Array<{ id: string }> }>();
    expect(result.isError).toBe(false);
    expect(value.count).toBe(1);
    expect(value.notes.map((note) => note.id)).toEqual(["n-dev"]);
  });

  it("refuses to read a note of another environment by id", async () => {
    const session = await openSession({ environment: "dev", seed: [live, dev] });
    const refused = await call(session.context, "get_note", { id: "n-live" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("FR-16.3");
    expect(refused.text).toContain('"live"');
    expect(refused.text).toContain('"dev"');

    const allowed = await call(session.context, "get_note", { id: "n-dev" });
    expect(allowed.isError).toBe(false);
  });

  it("refuses every write tool on a note of another environment", async () => {
    const session = await openSession({ environment: "dev", seed: [live, dev] });

    for (const [name, args] of [
      ["reply", { id: "n-live", text: "hello" }],
      ["set_status", { id: "n-live", status: "done" }],
      ["set_intent", { id: "n-live", intent: "feedback" }],
    ] as const) {
      const refused = await call(session.context, name, args);
      expect(refused.isError, `${name} must be refused`).toBe(true);
      expect(refused.text).toContain("FR-16.3");
    }

    // The live note is byte-for-byte the one that was seeded.
    expect(persistedNotes(session).find((note) => note.id === "n-live")).toEqual(live);
  });

  it("keeps the other environment out of the exports too", async () => {
    const session = await openSession({ environment: "dev", seed: [live, dev] });
    const exported = await call(session.context, "export_bundle", { format: "json" });
    expect(exported.text).toContain("n-dev");
    expect(exported.text).not.toContain("n-live");
  });
});

describe("argument validation (F12b)", () => {
  it("names the allowed merge modes instead of falling back to upsert", async () => {
    const session = await openSession({ seed: [makeNote({ id: "n-dev", body: "dev note", environment: "dev" })] });
    const result = await call(session.context, "import_bundle", { mode: "nonsense", bundle: "{}" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("mode must be one of merge, upsert, replace-session");
  });

  it("names the allowed conflict policies", async () => {
    const session = await openSession({ seed: [makeNote({ id: "n-dev", body: "dev note", environment: "dev" })] });
    const result = await call(session.context, "import_bundle", {
      on_conflict: "whatever",
      bundle: bundleText([], "dev"),
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("on_conflict must be one of fail, keep-incoming, keep-existing");
  });

  it("validates the list filters", async () => {
    const session = await openSession({ seed: [makeNote({ id: "n-dev", body: "dev note", environment: "dev" })] });
    const result = await call(session.context, "list_notes", { status: "nonsense" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("status must be one of open, done, needs_decision");
  });
});

describe("import fidelity and conflicts (F5/F6/F10)", () => {
  const existingNote = makeNote({
    id: "n-existing",
    body: "old body",
    environment: "dev",
    createdAt: CREATED,
    updatedAt: CREATED,
    messages: [message("m-1", CREATED, "first")],
  });
  const untouched = makeNote({ id: "n-untouched", body: "leave me alone", environment: "dev", updatedAt: "2026-01-03T00:00:00.000Z" });
  // The incoming version differs in more than the body: the whole note has to be applied (F5).
  const incomingNote: Note = {
    ...makeNote({
      id: "n-existing",
      body: "new body",
      environment: "dev",
      createdAt: CREATED,
      updatedAt: LATER,
      messages: [message("m-2", LATER, "second")],
    }),
    type: "design",
    author: "reviewer",
    authorType: "agent",
    source: "cli:import",
    anchor: { hook: "hook-new", route: "/pricing" },
    context: {
      tag: "button",
      classes: ["primary"],
      styles: { color: "red" },
      box: { w: 10, h: 10, x: 0, y: 0 },
      scheme: "dark",
      viewport: { w: 800, h: 600 },
    },
  };
  const added = makeNote({
    id: "n-added",
    body: "added by the bundle",
    environment: "dev",
    createdAt: "2026-01-05T00:00:00.000Z",
    updatedAt: "2026-01-06T00:00:00.000Z",
    sessionRef: "s-round-1",
    ticketRef: "TICKET-42",
    debug: { commit: "abc123", file: "src/app.ts:12" },
  });

  function bundle(): string {
    return bundleText([incomingNote, added], "dev");
  }

  it("refuses a conflicting import and persists nothing (F10/CLI parity)", async () => {
    const session = await openSession({ seed: [existingNote, untouched] });
    const before = session.file.text;
    const result = await call(session.context, "import_bundle", {
      bundle: bundle(),
      mode: "upsert",
      dry_run: false,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("conflict");
    expect(session.file.text).toBe(before);
  });

  it("applies the full merged note and preserves identity, timestamps and the thread (F5/F6)", async () => {
    const session = await openSession({ seed: [existingNote, untouched] });
    const result = await call(session.context, "import_bundle", {
      bundle: bundle(),
      mode: "upsert",
      dry_run: false,
      on_conflict: "keep-incoming",
    });
    expect(result.isError).toBe(false);

    const notes = persistedNotes(session);
    const merged = notes.find((note) => note.id === "n-existing");
    expect(merged).toBeDefined();
    expect(merged?.body).toBe("new body");
    expect(merged?.createdAt).toBe(CREATED);
    expect(merged?.updatedAt).toBe(LATER);
    // The whole note is applied, not just status/intent/body (F5): type, author, source, anchor and
    // captured context travel with the incoming version.
    expect(merged?.type).toBe("design");
    expect(merged?.author).toBe("reviewer");
    expect(merged?.source).toBe("cli:import");
    expect(merged?.anchor).toEqual({ hook: "hook-new", route: "/pricing" });
    expect(merged?.context?.tag).toBe("button");
    // The thread is concatenated, never replaced (FR-3.3).
    expect(merged?.messages.map((entry) => entry.id)).toEqual(["m-1", "m-2"]);

    const incomingAdded = notes.find((note) => note.id === "n-added");
    // Everything the bundle carried survives the import exactly.
    expect(incomingAdded?.createdAt).toBe(added.createdAt);
    expect(incomingAdded?.updatedAt).toBe(added.updatedAt);
    expect(incomingAdded?.sessionRef).toBe("s-round-1");
    expect(incomingAdded?.ticketRef).toBe("TICKET-42");
    expect(incomingAdded?.debug).toEqual({ commit: "abc123", file: "src/app.ts:12" });

    // A note the import did not change keeps every field, timestamps included.
    const kept = notes.find((note) => note.id === "n-untouched");
    expect(canonicalNote(kept!)).toEqual(canonicalNote(untouched));
  });

  it("refuses a merge-mode divergence without a policy and reports it as resolved with one (F10)", async () => {
    const session = await openSession({ seed: [existingNote, untouched] });
    const before = session.file.text;
    const refused = await call(session.context, "import_bundle", { bundle: bundle(), mode: "merge", dry_run: false });
    expect(refused.isError).toBe(true);
    expect(session.file.text).toBe(before);

    const resolved = await call(session.context, "import_bundle", {
      bundle: bundle(),
      mode: "merge",
      dry_run: false,
      on_conflict: "keep-existing",
    });
    expect(resolved.isError).toBe(false);
    const report = resolved.value<{ conflicts_resolved: number; resolution: string; written: boolean }>();
    expect(report.conflicts_resolved).toBe(1);
    expect(report.resolution).toBe("keep-existing");
    // keep-existing keeps the old content and adds nothing that is not in the bundle.
    expect(persistedNotes(session).find((note) => note.id === "n-existing")?.body).toBe("old body");
  });

  it("writes nothing at all when the import changes nothing (F6)", async () => {
    const session = await openSession({ seed: [existingNote, untouched] });
    const before = session.file.text;
    const result = await call(session.context, "import_bundle", {
      bundle: bundleText([existingNote], "dev"),
      dry_run: false,
    });
    expect(result.isError).toBe(false);
    expect(session.file.text).toBe(before);
  });
});

describe("a write is only success once it is on disk (F7)", () => {
  it("reports create_note as an error when the medium cannot be written", async () => {
    const seed = makeNote({ id: "n-dev", body: "dev note", environment: "dev" });
    const session = await openSession({ seed: [seed], readOnly: true });
    const before = session.file.text;

    const result = await call(session.context, "create_note", { body: "new note", hook: "h1" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("did not persist");
    expect(result.text).toContain("EACCES");
    expect(session.file.text).toBe(before);
  });

  it("reports set_status as an error when the medium cannot be written", async () => {
    const seed = makeNote({ id: "n-dev", body: "dev note", environment: "dev" });
    const session = await openSession({ seed: [seed], readOnly: true });

    const result = await call(session.context, "set_status", { id: "n-dev", status: "done" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("did not persist");
    expect(persistedNotes(session)[0]?.status).toBe("open");
  });

  it("reports a reply as an error when the medium cannot be written", async () => {
    const seed = makeNote({ id: "n-dev", body: "dev note", environment: "dev" });
    const session = await openSession({ seed: [seed], readOnly: true });

    const result = await call(session.context, "reply", { id: "n-dev", text: "done, changed x" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("did not persist");
    expect(persistedNotes(session)[0]?.messages).toEqual([]);
  });

  it("confirms an ordinary write", async () => {
    const seed = makeNote({ id: "n-dev", body: "dev note", environment: "dev" });
    const session = await openSession({ seed: [seed] });

    const result = await call(session.context, "set_status", { id: "n-dev", status: "done" });
    expect(result.isError).toBe(false);
    expect(persistedNotes(session)[0]?.status).toBe("done");
  });
});

describe("store validation before serving (F9)", () => {
  it("accepts a missing file as the documented empty start", () => {
    expect(validateStoredNoteSet(null)).toBeNull();
  });

  it("accepts a valid note set and a bundle-shaped store", () => {
    const note = makeNote({ id: "n-dev", body: "dev note", environment: "dev" });
    expect(validateStoredNoteSet(serializeNoteSet([note]))).toBeNull();
    expect(validateStoredNoteSet(bundleText([note], "dev"))).toBeNull();
  });

  it("rejects broken JSON, a foreign shape and an invalid note", () => {
    expect(validateStoredNoteSet("{oops")).toContain("not valid JSON");
    expect(validateStoredNoteSet('{"foo":1}')).toContain("must be a JSON array or { notes: [] }");
    const broken = { ...makeNote({ id: "n-dev", body: "dev note", environment: "dev" }) } as Record<string, unknown>;
    delete broken.environment;
    expect(validateStoredNoteSet(JSON.stringify({ version: 1, notes: [broken] }))).toContain("environment must be one of");
  });
});

describe("compareNoteSets", () => {
  const note = makeNote({ id: "n-1", body: "body", environment: "dev" });

  it("is silent for identical sets", () => {
    expect(compareNoteSets([note], [note])).toEqual([]);
  });

  it("reports a missing, a diverging and an unexpected note", () => {
    expect(compareNoteSets([note], [])).toEqual(["note n-1 is missing from the persisted set"]);
    const changed = { ...note, updatedAt: LATER };
    expect(compareNoteSets([note], [changed])).toEqual([
      "note n-1 was persisted differently (updatedAt)",
    ]);
    expect(compareNoteSets([], [note])).toEqual(["note n-1 is still in the persisted set"]);
  });
});

describe("protocol rules stay enforced before the first write (PROTOCOL §6)", () => {
  it("refuses kind=decision, an unknown kind and set_done on a feedback note without writing", async () => {
    const implementable = makeNote({ id: "n-work", body: "work", environment: "dev" });
    const feedback = makeNote({ id: "n-opinion", body: "opinion", environment: "dev", intent: "feedback" });
    const session = await openSession({ seed: [implementable, feedback] });
    const before = session.file.text;

    for (const [args, expected] of [
      [{ id: "n-work", text: "x", kind: "decision" }, "PROTOCOL §6.1"],
      [{ id: "n-work", text: "x", kind: "nonsense" }, "kind must be one of"],
      [{ id: "n-opinion", text: "x", set_done: true }, "PROTOCOL §4.5/§6.2"],
    ] as const) {
      const refused = await call(session.context, "reply", args);
      expect(refused.isError, JSON.stringify(args)).toBe(true);
      expect(refused.text).toContain(expected);
    }
    expect(session.file.text).toBe(before);
  });

  it("refuses done on a pending decision and never appends the message", async () => {
    const pending = makeNote({ id: "n-pending", body: "?", environment: "dev", status: "needs_decision" });
    const session = await openSession({ seed: [pending] });

    const refusal = await call(session.context, "set_status", { id: "n-pending", status: "done" });
    expect(refusal.isError).toBe(true);
    expect(refusal.text).toContain("PROTOCOL §6.3");

    const reply = await call(session.context, "reply", { id: "n-pending", text: "worked", set_done: true });
    expect(reply.isError).toBe(true);
    expect(persistedNotes(session)[0]?.messages).toEqual([]);
  });

  it("completes an implementable note: reply + done in one call", async () => {
    const session = await openSession({ seed: [makeNote({ id: "n-work", body: "work", environment: "dev" })] });
    const result = await call(session.context, "reply", { id: "n-work", text: "done, changed x", set_done: true });
    expect(result.isError).toBe(false);
    const stored = persistedNotes(session)[0];
    expect(stored?.status).toBe("done");
    expect(stored?.messages.map((entry) => entry.kind)).toEqual(["reply"]);
    expect(stored?.messages[0]?.authorType).toBe("agent");
  });

  it("asks for a decision and blocks implementation (kind=decision_request)", async () => {
    const session = await openSession({ seed: [makeNote({ id: "n-work", body: "work", environment: "dev" })] });
    const result = await call(session.context, "reply", { id: "n-work", text: "A or B?", kind: "decision_request" });
    expect(result.isError).toBe(false);
    const stored = persistedNotes(session)[0];
    expect(stored?.status).toBe("needs_decision");
    expect(stored?.messages[0]?.kind).toBe("decision_request");
  });
});

describe("read-only sessions (FR-16.2)", () => {
  it("refuses every write tool and does not touch the medium", async () => {
    const note = makeNote({ id: "n-dev", body: "dev note", environment: "dev" });
    const session = await openSession({ seed: [note], allowWrite: false });
    const before = session.file.text;

    for (const [name, args] of [
      ["create_note", { body: "x", hook: "h" }],
      ["reply", { id: "n-dev", text: "x" }],
      ["set_status", { id: "n-dev", status: "done" }],
      ["set_intent", { id: "n-dev", intent: "feedback" }],
      ["import_bundle", { bundle: bundleText([], "dev") }],
    ] as const) {
      const refused = await call(session.context, name, args);
      expect(refused.isError, name).toBe(true);
      expect(refused.text).toContain("Read-only session");
    }
    expect(session.file.text).toBe(before);
  });
});
