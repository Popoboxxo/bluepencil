/**
 * T65 `backend.store_parity` — the store backend returns exactly the 0.8 tool responses (FR-16.9).
 *
 * PR 1 moves `ToolContext` from `store` to `McpBackend` without changing what a client sees. This
 * suite pins that claim: a deterministically seeded store (fixed clock, fixed ids) is driven through
 * all nine existing tools and through `resources/list` + `resources/read`; every answer is compared
 * against the response captured from the pre-refactor implementation. "No error" is not a parity
 * proof — the full JSON/text is.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createStoreBackend, type McpBackend } from "../../src/mcp/backend";
import { createStdioToolContext } from "../../src/mcp/stdio";
import { handleRpcExchange } from "../../src/mcp/protocol";
import {
  callTool,
  createStorePersistence,
  listResources,
  readResource,
  type McpPersistence,
  type ToolContext,
} from "../../src/mcp/tools";
import { createStore, type Store } from "../../src/core/store";
import { serializeNoteSet } from "../../src/adapters/memory";
import { canonicalNote, serializeCanonical } from "../../src/data/canonical";
import { bundleToJson, createBundle } from "../../src/data/bundle";
import {
  createNote,
  systemClock,
  type Environment,
  type Message,
  type Note,
  type NoteIntent,
  type NoteStatus,
  type NoteType,
} from "../../src/core/model";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";
const NOW = "2026-02-01T00:00:00.000Z";

const originalRandomUUID = globalThis.crypto.randomUUID;
const originalNow = systemClock.now;

afterEach(() => {
  globalThis.crypto.randomUUID = originalRandomUUID;
  systemClock.now = originalNow;
});

function makeNote(input: {
  id: string;
  body: string;
  environment: Environment;
  createdAt?: string;
  type?: NoteType;
  intent?: NoteIntent;
  status?: NoteStatus;
  sessionRef?: string;
  messages?: Message[];
}): Note {
  const createdAt = input.createdAt ?? T0;
  const note = createNote({
    id: input.id,
    type: input.type ?? "text",
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
  });
  return { ...note, updatedAt: createdAt };
}

const nDecision = makeNote({
  id: "n-decision",
  body: "decision note",
  environment: "dev",
  createdAt: T1,
  type: "bug",
  status: "needs_decision",
});
const nFeedback = makeNote({
  id: "n-feedback",
  body: "feedback note",
  environment: "dev",
  type: "design",
  intent: "feedback",
});
const nOpen = makeNote({ id: "n-open", body: "open note", environment: "dev" });
const nDone = makeNote({ id: "n-done", body: "done note", environment: "dev", createdAt: T1, status: "done" });
const nLive = makeNote({ id: "n-live", body: "live note", environment: "live" });
const SEED = [nDecision, nFeedback, nOpen, nDone, nLive];

interface Session {
  context: ToolContext;
  backend: ReturnType<typeof createStoreBackend>;
  store: Store;
  file: { text: string };
  persistence: McpPersistence;
}

let uuidSequence = 0;

/** Opens a session exactly like the server does, but with a fixed clock and deterministic ids. */
async function openSession(seed: Note[] = SEED): Promise<Session> {
  uuidSequence = 0;
  globalThis.crypto.randomUUID = () =>
    `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, "0")}`;
  // The adapter's `applyPatch`/`createNote` fall back to the system clock; pin it too.
  systemClock.now = () => NOW;

  const file = { text: serializeNoteSet(seed) };
  const { adapter, persistence } = createStorePersistence({
    read: async () => file.text,
    write: async (text: string) => {
      file.text = text;
    },
  });
  const store = createStore({ environment: "dev", adapter, now: () => NOW });
  await store.reload();

  const backend = createStoreBackend(store, {
    allowWrite: true,
    environment: "dev",
    appName: "test-app",
    persistence,
    clientName: "vitest",
    sessionId: "s-test",
    now: () => NOW,
  });
  const context: ToolContext = {
    backend,
    allowWrite: true,
    environment: "dev",
    appName: "test-app",
    clientName: "vitest",
    sessionId: "s-test",
    now: () => NOW,
    persistence,
  };
  return { context, backend, store, file, persistence };
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

function bundleText(notes: Note[], environment: Environment): string {
  // Built with the shared bundle codec, exactly like the pre-refactor capture: sessions are derived
  // from the notes, which is what `inspect_bundle` reports.
  return bundleToJson(
    createBundle(notes, {
      environment,
      exportedBy: "vitest",
      app: { name: "test-app" },
      now: NOW,
    }),
  );
}

describe("T65 backend.store_parity", () => {
  it("exposes the single-store backend contract", async () => {
    const session = await openSession();
    expect(session.backend.kind).toBe("store");
    expect(session.backend.scope).toBe("single");
    expect(session.backend.appName).toBe("test-app");
    expect(session.backend.environment).toBe("dev");

    const self = {
      id: "self",
      app: "test-app",
      environment: "dev" as const,
      ok: true,
      mode: "write" as const,
      includeSelf: true,
    };
    expect(await session.backend.instances()).toEqual([self]);

    const listed = await session.backend.list({ environment: "dev" });
    expect(listed.instances).toEqual([self]);
    expect(listed.partial).toBe(false);
    expect(listed.truncated).toBe(false);
    expect(listed.errors).toEqual([]);
  });

  it("list_notes returns the same JSON (default view) and Markdown", async () => {
    const session = await openSession();

    const json = await call(session.context, "list_notes");
    expect(json.isError).toBe(false);
    const expected = {
      environment: "dev",
      app: "test-app",
      count: 3,
      notes: [canonicalNote(nDecision), canonicalNote(nFeedback), canonicalNote(nOpen)],
    };
    expect(json.value()).toEqual(expected);
    expect(json.text).toBe(JSON.stringify(expected, null, 2));

    const markdown = await call(session.context, "list_notes", { format: "markdown" });
    expect(markdown.isError).toBe(false);
    expect(markdown.text).toBe(
      [
        "# test-app — 3 note(s) [env: dev]",
        "",
        "- [bug/implement/needs_decision] — decision note",
        "- [design/feedback/open] — feedback note",
        "- [text/implement/open] — open note",
      ].join("\n"),
    );

    // The 0.8 rule is "filter first, then drop done": an explicit status=done with the default
    // include_done=false is therefore empty. Pinned because a naive `includeDone` filter would
    // change it silently.
    const done = await call(session.context, "list_notes", { status: "done" });
    expect(done.value<{ count: number; notes: Note[] }>()).toEqual({
      environment: "dev",
      app: "test-app",
      count: 0,
      notes: [],
    });
  });

  it("get_note returns the same note, including the environment guard", async () => {
    const session = await openSession();

    const found = await call(session.context, "get_note", { id: "n-open" });
    expect(found.isError).toBe(false);
    expect(found.value()).toEqual(canonicalNote(nOpen));
    expect(found.text).toBe(JSON.stringify(canonicalNote(nOpen), null, 2));

    const refused = await call(session.context, "get_note", { id: "n-live" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(
      'error: note n-live belongs to environment "live" but this session is bound to "dev": ' +
        "reading the note is refused (FR-16.3 — a session may only read and write notes of its own environment)",
    );
  });

  it("create_note persists the same note and answers with the same JSON", async () => {
    const session = await openSession();
    const result = await call(session.context, "create_note", {
      type: "bug",
      body: "new bug",
      hook: "h-new",
      severity: "blocker",
      session: "s-1",
      ticket_ref: "T-1",
    });
    expect(result.isError).toBe(false);

    const created = {
      id: "n-00000000-0000-4000-8000-000000000001",
      schemaVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
      sessionRef: "s-1",
      type: "bug",
      severity: "blocker",
      intent: "implement",
      status: "open",
      body: "new bug",
      author: "vitest (mcp:s-test)",
      authorType: "agent",
      anchor: { hook: "h-new" },
      context: null,
      messages: [],
      source: "agent",
      environment: "dev",
      ticketRef: "T-1",
    };
    expect(result.value()).toEqual({ created });
    expect(result.text).toBe(JSON.stringify({ created }, null, 2));
    expect((JSON.parse(session.file.text) as { notes: Note[] }).notes.map((note) => note.id)).toContain(
      created.id,
    );
  });

  it("reply answers with the same note, message and status transition", async () => {
    const session = await openSession();
    const result = await call(session.context, "reply", {
      id: "n-open",
      text: "did the work",
      set_done: true,
    });
    expect(result.isError).toBe(false);

    const note = {
      ...canonicalNote(nOpen),
      updatedAt: NOW,
      status: "done",
      messages: [
        {
          id: "m-00000000-0000-4000-8000-000000000001",
          ts: NOW,
          author: "vitest (mcp:s-test)",
          authorType: "agent",
          kind: "reply",
          text: "did the work",
        },
      ],
    };
    expect(result.value()).toEqual({ note });
    expect(result.text).toBe(JSON.stringify({ note }, null, 2));
  });

  it("set_status answers with the same note", async () => {
    const session = await openSession();
    const result = await call(session.context, "set_status", { id: "n-open", status: "done" });
    expect(result.isError).toBe(false);

    const note = { ...canonicalNote(nOpen), updatedAt: NOW, status: "done" };
    expect(result.value()).toEqual({ note });
    expect(result.text).toBe(JSON.stringify({ note }, null, 2));
  });

  it("set_intent answers with the same note", async () => {
    const session = await openSession();
    const result = await call(session.context, "set_intent", { id: "n-open", intent: "feedback" });
    expect(result.isError).toBe(false);

    const note = { ...canonicalNote(nOpen), updatedAt: NOW, intent: "feedback" };
    expect(result.value()).toEqual({ note });
    expect(result.text).toBe(JSON.stringify({ note }, null, 2));
  });

  it("export_bundle returns the same JSON bundle and Markdown", async () => {
    const session = await openSession([nOpen, nDone, nLive]);

    const json = await call(session.context, "export_bundle", { format: "json" });
    expect(json.isError).toBe(false);
    const bundle = {
      kind: "bluepencil.bundle",
      schemaVersion: 1,
      exportedAt: NOW,
      exportedBy: "vitest (mcp:s-test)",
      environment: "dev",
      app: { name: "test-app" },
      sessions: [],
      notes: [canonicalNote(nOpen), canonicalNote(nDone)],
    };
    expect(json.value()).toEqual(bundle);
    expect(json.text).toBe(serializeCanonical(bundle));

    const markdown = await call(session.context, "export_bundle", {
      format: "markdown",
      include_done: false,
    });
    expect(markdown.isError).toBe(false);
    expect(markdown.text).toBe(
      [
        "# test-app review notes",
        "",
        "_Notes: 1 · open decisions: 0 · feedback only: 0 · done: 0_",
        "",
        "## Notes by route",
        "",
        "### (no route)",
        "",
        "#### n-open — text/implement/open",
        "- Type: text",
        "- Intent: implement",
        "- Status: open",
        "- Source: `ui:human`",
        "- Author: human (human)",
        "- Created: 2026-01-01T00:00:00.000Z",
        "- Updated: 2026-01-01T00:00:00.000Z",
        "- Environment: dev",
        "- Anchor: hook `n-open`",
        "- Body:",
        "  ```",
        "  open note",
        "  ```",
        "- Thread:",
        "  - none",
        "",
      ].join("\n"),
    );
  });

  it("inspect_bundle returns the same summary", async () => {
    const session = await openSession();
    const imported = makeNote({
      id: "n-imported",
      body: "imported note",
      environment: "dev",
      createdAt: T1,
      sessionRef: "s-round-1",
    });
    const result = await call(session.context, "inspect_bundle", { bundle: bundleText([imported], "dev") });
    expect(result.isError).toBe(false);
    const expected = {
      notes: 1,
      sessions: [{ ref: "s-round-1", label: "s-round-1", createdAt: T1 }],
      environments: ["dev"],
      byStatus: { open: 1, done: 0, needs_decision: 0 },
      byIntent: { implement: 1, feedback: 0 },
      byType: { text: 1, design: 0, bug: 0, feature: 0 },
      routes: [],
      app: { name: "test-app" },
      targetEnvironment: "dev",
      environmentMatches: true,
    };
    expect(result.value()).toEqual(expected);
    expect(result.text).toBe(JSON.stringify(expected, null, 2));
  });

  it("import_bundle returns the same report and writes through replaceAll", async () => {
    const session = await openSession();
    const imported = makeNote({
      id: "n-imported",
      body: "imported note",
      environment: "dev",
      createdAt: T1,
      sessionRef: "s-round-1",
    });
    const result = await call(session.context, "import_bundle", {
      bundle: bundleText([imported], "dev"),
      mode: "merge",
      dry_run: false,
    });
    expect(result.isError).toBe(false);
    const expected = {
      mode: "merge",
      dry_run: false,
      added: 1,
      updated: 0,
      skipped: 0,
      removed: 0,
      conflicts: [],
      written: true,
    };
    expect(result.value()).toEqual(expected);
    expect(result.text).toBe(JSON.stringify(expected, null, 2));
    expect((JSON.parse(session.file.text) as { notes: Note[] }).notes.map((note) => note.id)).toContain(
      "n-imported",
    );
  });

  it("resources/list and resources/read return the same three resources and content", async () => {
    const session = await openSession();
    expect(session.backend.resources()).toEqual(listResources());
    expect(listResources()).toEqual([
      { uri: "bluepencil://notes", name: "Review notes (Markdown)", mimeType: "text/markdown" },
      { uri: "bluepencil://notes.json", name: "Review notes (JSON)", mimeType: "application/json" },
      { uri: "bluepencil://bundle", name: "Portable bundle", mimeType: "application/json" },
    ]);

    const notesJson = await readResource(session.context, "bluepencil://notes.json");
    expect(notesJson).not.toBeNull();
    expect(notesJson?.uri).toBe("bluepencil://notes.json");
    expect(notesJson?.mimeType).toBe("application/json");
    expect(JSON.parse(notesJson?.text ?? "")).toEqual(
      [nDecision, nFeedback, nOpen, nDone].map(canonicalNote),
    );

    const bundle = await readResource(session.context, "bluepencil://bundle");
    expect(bundle).not.toBeNull();
    const parsed = JSON.parse(bundle?.text ?? "") as Record<string, unknown>;
    expect(parsed).toEqual({
      kind: "bluepencil.bundle",
      schemaVersion: 1,
      exportedAt: NOW,
      exportedBy: "vitest (mcp:s-test)",
      environment: "dev",
      app: { name: "test-app" },
      sessions: [],
      notes: [nDecision, nFeedback, nOpen, nDone].map(canonicalNote),
    });

    const markdown = await readResource(session.context, "bluepencil://notes");
    expect(markdown?.mimeType).toBe("text/markdown");
    expect(markdown?.text).toContain("# test-app review notes");
    expect(markdown?.text).toContain("## ⚠ open decisions");
    expect(markdown?.text).toContain("## 💬 feedback only");
    expect(markdown?.text).toContain("#### n-open — text/implement/open");

    expect(await readResource(session.context, "bluepencil://nope")).toBeNull();
  });

  it("resources/list and resources/read over the protocol return the same frames", async () => {
    const session = await openSession();

    const listed = await handleRpcExchange(
      { jsonrpc: "2.0", id: 1, method: "resources/list" },
      session.context,
    );
    expect(listed).toEqual({ jsonrpc: "2.0", id: 1, result: { resources: listResources() } });

    const read = await handleRpcExchange(
      { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "bluepencil://notes.json" } },
      session.context,
    );
    expect(read).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { contents: [await readResource(session.context, "bluepencil://notes.json")] },
    });

    const unknown = await handleRpcExchange(
      { jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "bluepencil://nope" } },
      session.context,
    );
    expect(unknown).toMatchObject({ jsonrpc: "2.0", id: 3, error: { code: -32602 } });
    expect(JSON.stringify(unknown)).toContain("bluepencil://nope");
  });

  it("propagates initialize clientInfo.name into export_bundle and bluepencil://bundle (F6)", async () => {
    const session = await openSession([nOpen]);
    // Exactly the context `runStdioServer` builds: the client name lives on the backend contract,
    // so `initialize` and the export paths observe the same identity.
    const context = createStdioToolContext({
      backend: session.backend,
      appName: "test-app",
      allowWrite: true,
      sessionId: "s-test",
      persistence: session.persistence,
    });

    const initialized = await handleRpcExchange(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", clientInfo: { name: "review-agent" } },
      },
      context,
    );
    expect((initialized?.result as { serverInfo: { name: string } }).serverInfo.name).toBe("bluepencil");
    expect(session.backend.clientName).toBe("review-agent");

    const exported = await handleRpcExchange(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "export_bundle", arguments: { format: "json" } } },
      context,
    );
    const exportContent = (exported?.result as { content: Array<{ text: string }> }).content;
    const exportText = exportContent[0]?.text ?? "";
    expect((JSON.parse(exportText) as { exportedBy: string }).exportedBy).toBe(
      "review-agent (mcp:s-test)",
    );

    const resource = await handleRpcExchange(
      { jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "bluepencil://bundle" } },
      context,
    );
    const resourceContent = (resource?.result as { contents: Array<{ text: string }> }).contents;
    const resourceText = resourceContent[0]?.text ?? "";
    expect((JSON.parse(resourceText) as { exportedBy: string }).exportedBy).toBe(
      "review-agent (mcp:s-test)",
    );
  });

  it("keeps tools without a single environment binding usable (F3)", async () => {
    const session = await openSession([nOpen]);
    // An aggregate backend (planned for 0.10) has no single environment. A spread keeps the store
    // backend's own closures while removing only the `environment` property of the contract.
    const aggregate: McpBackend = { ...session.backend, environment: undefined };
    const context: ToolContext = {
      backend: aggregate,
      allowWrite: true,
      appName: "aggregate",
      clientName: "vitest",
      sessionId: "s-test",
      persistence: session.persistence,
    };

    // `export_bundle` never needed the context binding — it must not fail just because it is absent.
    const exported = await call(context, "export_bundle", { format: "json" });
    expect(exported.isError).toBe(false);
    expect(exported.value<{ environment: string; exportedBy: string }>().environment).toBe("dev");

    // `list_notes` genuinely needs the binding and keeps refusing instead of guessing one.
    await expect(callTool(context, "list_notes")).rejects.toThrow(
      "this backend has no single environment binding",
    );
  });
});
