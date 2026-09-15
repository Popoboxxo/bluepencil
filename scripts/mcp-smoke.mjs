#!/usr/bin/env node
/**
 * MCP smoke test for bluepencil (FR-16, defect list B2/F5/F6/F7/F9/F10/F12b/F13).
 *
 * A dependency-free Node driver: it spawns `dist/mcp.js` with the documented argv, speaks
 * newline-delimited JSON-RPC 2.0 over stdio, waits for the answer to **every** request by id and
 * checks the answers against the documented behaviour — including the two properties that are easy
 * to fake and easy to lose: a write must be on disk afterwards (checked with sha256 over the store
 * file) and a session must never touch another environment's notes.
 *
 * Run it from the repository root after a build:
 *   npm run build && node scripts/mcp-smoke.mjs
 *
 * Fixtures live in `.tmp/mcp-smoke/` and are left there on purpose, so a failing run can be
 * inspected afterwards. Exit code is 0 when every case passed, 1 otherwise.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, "dist", "mcp.js");
const fixtureDir = join(root, ".tmp", "mcp-smoke");
const RESPONSE_TIMEOUT_MS = 10_000;

/* ------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";
const T2 = "2026-01-03T00:00:00.000Z";
const T3 = "2026-01-04T00:00:00.000Z";

/** One note in the shape the model documents (src/core/model.ts). */
function note(input) {
  return {
    id: input.id,
    schemaVersion: 1,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
    type: "text",
    intent: input.intent ?? "implement",
    status: input.status ?? "open",
    body: input.body,
    author: "human",
    authorType: "human",
    anchor: { hook: input.id },
    context: null,
    messages: input.messages ?? [],
    source: "ui:human",
    environment: input.environment,
    ...(input.sessionRef !== undefined ? { sessionRef: input.sessionRef } : {}),
    ...(input.ticketRef !== undefined ? { ticketRef: input.ticketRef } : {}),
    ...(input.debug !== undefined ? { debug: input.debug } : {}),
  };
}

function message(id, ts, text, kind = "note") {
  return { id, ts, author: "human", authorType: "human", kind, text };
}

/** The store file the adapter writes: one blob with a version tag (src/adapters/memory.ts). */
function noteSet(notes) {
  return `${JSON.stringify({ version: 1, notes })}\n`;
}

function bundleText(notes, environment) {
  return `${JSON.stringify(
    {
      kind: "bluepencil.bundle",
      schemaVersion: 1,
      exportedAt: T3,
      exportedBy: "mcp-smoke",
      environment,
      app: { name: "smoke-app" },
      sessions: [],
      notes,
    },
    null,
    2,
  )}\n`;
}

async function writeFixture(name, text) {
  const path = join(fixtureDir, name);
  await writeFile(path, text, "utf8");
  return path;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function fileSha256(path) {
  return sha256(await readFile(path, "utf8"));
}

async function readNotes(path) {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  return Array.isArray(parsed) ? parsed : parsed.notes;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------------------------------
 * stdio driver
 * ---------------------------------------------------------------------------------------------- */

class McpSession {
  #child;
  #buffer = "";
  #nextId = 0;
  #pending = new Map();
  #orphans = [];
  #stderr = "";
  #exited;

  constructor(args) {
    this.#child = spawn(process.execPath, [entry, ...args], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk) => this.#consume(chunk));
    this.#child.stderr.on("data", (chunk) => {
      this.#stderr += chunk;
    });
    this.#exited = new Promise((resolve) => {
      this.#child.once("exit", (code, signal) => resolve({ code, signal }));
    });
  }

  /** Every frame that could not be matched to a request — an unsolicited frame is a defect. */
  get orphans() {
    return this.#orphans;
  }

  get stderr() {
    return this.#stderr;
  }

  get exit() {
    return this.#exited;
  }

  send(frame) {
    this.#child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  /** A request: returns the response frame for its own id. */
  request(method, params) {
    this.#nextId += 1;
    const id = this.#nextId;
    const answered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`timeout after ${RESPONSE_TIMEOUT_MS}ms waiting for ${method} (id ${id})`));
      }, RESPONSE_TIMEOUT_MS);
      this.#pending.set(id, (frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return answered;
  }

  /** A notification: no id, so no answer may ever come back. */
  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  callTool(name, args = {}) {
    return this.request("tools/call", { name, arguments: args });
  }

  async initialize() {
    return this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mcp-smoke", version: "1.0.0" },
    });
  }

  /** Ends the session and waits for the server to exit on its own. */
  async close() {
    this.#child.stdin.end();
    const outcome = await Promise.race([
      this.#exited,
      new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    if (outcome === null) {
      this.#child.kill("SIGKILL");
      await this.#exited;
    }
    return outcome ?? { code: null, signal: "SIGKILL" };
  }

  #consume(chunk) {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      index = this.#buffer.indexOf("\n");
      if (line === "") continue;
      let frame = null;
      try {
        frame = JSON.parse(line);
      } catch {
        frame = null;
      }
      const resolver = frame !== null ? this.#pending.get(frame.id) : undefined;
      if (resolver !== undefined) {
        this.#pending.delete(frame.id);
        resolver(frame);
      } else {
        this.#orphans.push(frame ?? line);
      }
    }
  }
}

/* ------------------------------------------------------------------------------------------------
 * Assertions
 * ---------------------------------------------------------------------------------------------- */

let failures = 0;
let checks = 0;

function check(name, ok, detail) {
  checks += 1;
  if (ok) {
    console.log(`PASS ${name}: ${detail}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}: ${detail}`);
  }
}

/** The readable parts of a `tools/call` answer. */
function tool(frame) {
  const result = frame.result ?? {};
  const text = (result.content ?? []).map((entry) => entry.text ?? "").join("\n");
  return {
    isError: result.isError === true,
    text,
    json: () => JSON.parse(text),
    ids: () => {
      const parsed = JSON.parse(text);
      return (parsed.notes ?? []).map((entry) => entry.id);
    },
  };
}

function isJsonRpcError(frame, code) {
  return frame.error !== undefined && frame.error.code === code;
}

/* ------------------------------------------------------------------------------------------------
 * Cases
 * ---------------------------------------------------------------------------------------------- */

async function case01_initialize(storePath) {
  const session = new McpSession(["--store", storePath, "--environment", "dev", "--app", "smoke"]);
  try {
    const frame = await session.initialize();
    const info = frame.result?.serverInfo ?? {};
    check(
      "01 initialize → serverInfo",
      info.name === "bluepencil" && typeof info.version === "string" && frame.result.protocolVersion === "2024-11-05",
      `serverInfo=${info.name}/${info.version} protocol=${frame.result?.protocolVersion}`,
    );
  } finally {
    await session.close();
  }
}

async function case02_toolList(storePath) {
  const session = new McpSession(["--store", storePath, "--environment", "dev"]);
  try {
    await session.initialize();
    const frame = await session.request("tools/list", {});
    const names = (frame.result?.tools ?? []).map((toolEntry) => toolEntry.name);
    const expected = [
      "list_notes",
      "get_note",
      "create_note",
      "reply",
      "set_status",
      "set_intent",
      "export_bundle",
      "inspect_bundle",
      "import_bundle",
    ];
    const missing = expected.filter((name) => !names.includes(name));
    check(
      "02 tools/list → 9 tools",
      names.length === 9 && missing.length === 0,
      `${names.length} tool(s)${missing.length > 0 ? `, missing ${missing.join(", ")}` : ""}`,
    );

    // The compact Markdown list goes through the shared `summarize()` of the protocol module (M2).
    const markdown = tool(await session.callTool("list_notes", { format: "markdown" }));
    check(
      "02b list_notes markdown uses the shared summary line",
      !markdown.isError && markdown.text.includes("- [text/implement/open] — work note"),
      markdown.isError ? markdown.text.replace(/\s+/g, " ").slice(0, 90) : markdown.text.split("\n").at(-1),
    );
  } finally {
    await session.close();
  }
}

async function case03_readOnlyRefusals(storePath) {
  const session = new McpSession(["--store", storePath, "--environment", "dev"]);
  try {
    await session.initialize();
    const before = await fileSha256(storePath);
    const calls = [
      ["create_note", { body: "x", hook: "h1" }],
      ["reply", { id: "n-work", text: "x" }],
      ["set_status", { id: "n-work", status: "done" }],
      ["set_intent", { id: "n-work", intent: "feedback" }],
      ["import_bundle", { bundle: bundleText([], "dev") }],
    ];
    const refusals = [];
    for (const [name, args] of calls) {
      const result = tool(await session.callTool(name, args));
      if (!result.isError || !result.text.includes("Read-only session")) {
        refusals.push(name);
      }
    }
    const after = await fileSha256(storePath);
    check(
      "03 read-only session refuses every write tool",
      refusals.length === 0 && before === after,
      refusals.length === 0
        ? `5/5 refusals, store sha256 unchanged (${before.slice(0, 12)}…)`
        : `not refused: ${refusals.join(", ")}`,
    );
  } finally {
    await session.close();
  }
}

async function case04_writeIsPersisted(storePath) {
  const before = await fileSha256(storePath);
  const session = new McpSession(["--store", storePath, "--environment", "dev", "--allow-write"]);
  let createdId = "";
  try {
    await session.initialize();
    const created = tool(await session.callTool("create_note", { body: "smoke note", hook: "smoke-hook" }));
    createdId = created.isError ? "" : created.json().created?.id ?? "";
    const after = await fileSha256(storePath);
    check(
      "04a create_note is persisted (sha256)",
      createdId !== "" && after !== before,
      createdId === "" ? `create_note failed: ${created.text}` : `sha256 ${before.slice(0, 12)}… → ${after.slice(0, 12)}…`,
    );
  } finally {
    await session.close();
  }

  const fresh = new McpSession(["--store", storePath, "--environment", "dev"]);
  try {
    await fresh.initialize();
    const fetched = tool(await fresh.callTool("get_note", { id: createdId }));
    check(
      "04b the note is visible to a fresh session",
      !fetched.isError && fetched.json().id === createdId,
      createdId === "" ? "no id from 04a" : `fresh session read ${createdId}`,
    );
  } finally {
    await fresh.close();
  }
}

async function case05_protocolRules(storePath) {
  const session = new McpSession(["--store", storePath, "--environment", "dev", "--allow-write"]);
  try {
    await session.initialize();

    const decision = tool(await session.callTool("reply", { id: "n-work", text: "I decide", kind: "decision" }));
    check(
      "05a reply kind=decision refused",
      decision.isError && decision.text.includes("PROTOCOL §6.1"),
      decision.text.replace(/\s+/g, " ").slice(0, 90),
    );

    const pending = tool(await session.callTool("set_status", { id: "n-pending", status: "done" }));
    check(
      "05b set_status done on needs_decision refused",
      pending.isError && pending.text.includes("PROTOCOL §6.3"),
      pending.text.replace(/\s+/g, " ").slice(0, 90),
    );

    const reply = tool(await session.callTool("reply", { id: "n-work", text: "done, changed x", set_done: true }));
    const stored = reply.isError ? null : reply.json().note;
    check(
      "05c reply kind=reply + set_done on an implementable note",
      !reply.isError && stored?.status === "done" && stored?.messages?.at(-1)?.kind === "reply",
      reply.isError ? reply.text.replace(/\s+/g, " ").slice(0, 120) : `status=${stored?.status} kind=${stored?.messages?.at(-1)?.kind}`,
    );

    const stillOpen = tool(await session.callTool("get_note", { id: "n-pending" }));
    check(
      "05d the refused writes changed nothing",
      !stillOpen.isError && stillOpen.json().status === "needs_decision" && stillOpen.json().messages.length === 0,
      `n-pending status=${stillOpen.json().status} messages=${stillOpen.json().messages.length}`,
    );
  } finally {
    await session.close();
  }
}

async function case06_environmentBinding(storePath) {
  const before = await fileSha256(storePath);
  const session = new McpSession(["--store", storePath, "--environment", "dev", "--allow-write"]);
  try {
    await session.initialize();

    const listed = tool(await session.callTool("list_notes", { include_done: true }));
    const ids = listed.ids();
    check(
      "06a list_notes hides another environment",
      ids.includes("n-dev") && !ids.includes("n-live"),
      `listed: ${ids.join(", ") || "(none)"}`,
    );

    const fetched = tool(await session.callTool("get_note", { id: "n-live" }));
    check(
      "06b get_note refuses another environment",
      fetched.isError && fetched.text.includes("FR-16.3") && fetched.text.includes('"live"') && fetched.text.includes('"dev"'),
      fetched.text.replace(/\s+/g, " ").slice(0, 120),
    );

    const written = tool(await session.callTool("set_status", { id: "n-live", status: "done" }));
    const after = await fileSha256(storePath);
    check(
      "06c writing another environment is refused",
      written.isError && written.text.includes("FR-16.3") && before === after,
      `${written.isError ? "refused" : "allowed"}, store sha256 ${before === after ? "unchanged" : "CHANGED"}`,
    );
  } finally {
    await session.close();
  }
}

async function case07_import(storePath, bundlePath) {
  const session = new McpSession(["--store", storePath, "--environment", "dev", "--allow-write"]);
  try {
    await session.initialize();
    const bundle = await readFile(bundlePath, "utf8");

    // (1) A conflicting import without on_conflict must refuse and write nothing.
    const before = await fileSha256(storePath);
    const refused = tool(
      await session.callTool("import_bundle", { bundle, mode: "upsert", dry_run: false }),
    );
    const afterRefusal = await fileSha256(storePath);
    check(
      "07a conflicting import without on_conflict → isError, file unchanged",
      refused.isError && refused.text.includes("conflict") && before === afterRefusal,
      `${refused.isError ? "isError" : "no isError"}, sha256 ${before === afterRefusal ? "unchanged" : "CHANGED"}`,
    );

    // (2) The same import with keep-incoming must apply the full note.
    const applied = tool(
      await session.callTool("import_bundle", {
        bundle,
        mode: "upsert",
        dry_run: false,
        on_conflict: "keep-incoming",
      }),
    );
    const report = applied.isError ? {} : applied.json();
    const notes = await readNotes(storePath);
    const byId = new Map(notes.map((entry) => [entry.id, entry]));
    const merged = byId.get("n-conflict");
    const added = byId.get("n-added");
    const untouched = byId.get("n-untouched");

    const appliedOk =
      !applied.isError &&
      report.written === true &&
      report.added === 1 &&
      report.updated === 1 &&
      merged?.body === "new body" &&
      merged?.createdAt === T0 &&
      merged?.updatedAt === T2 &&
      merged?.messages.map((entry) => entry.id).join(",") === "m-1,m-2" &&
      added?.createdAt === T3 &&
      added?.updatedAt === T3 &&
      added?.sessionRef === "s-round-1" &&
      added?.ticketRef === "TICKET-42" &&
      added?.debug?.commit === "abc123" &&
      untouched?.updatedAt === T1 &&
      untouched?.body === "untouched note";

    check(
      "07b on_conflict keep-incoming applies the merged note",
      Boolean(appliedOk),
      applied.isError
        ? applied.text.replace(/\s+/g, " ").slice(0, 140)
        : `added=${report.added} updated=${report.updated} written=${report.written}`,
    );
    check(
      "07c the thread is concatenated and identity/timestamps survive",
      merged?.createdAt === T0 && merged?.updatedAt === T2 && merged?.messages.map((entry) => entry.id).join(",") === "m-1,m-2",
      `createdAt=${merged?.createdAt} updatedAt=${merged?.updatedAt} messages=${merged?.messages.map((entry) => entry.id).join(",")}`,
    );
    check(
      "07d an added note keeps its own timestamps, refs and debug",
      added?.createdAt === T3 &&
        added?.updatedAt === T3 &&
        added?.sessionRef === "s-round-1" &&
        added?.ticketRef === "TICKET-42" &&
        added?.debug?.commit === "abc123",
      `createdAt=${added?.createdAt} updatedAt=${added?.updatedAt} refs=${added?.sessionRef}/${added?.ticketRef} debug=${JSON.stringify(added?.debug)}`,
    );
    check(
      "07e a note the import did not change keeps its updatedAt",
      untouched?.updatedAt === T1,
      `n-untouched updatedAt=${untouched?.updatedAt}`,
    );
  } finally {
    await session.close();
  }
}

async function case08_corruptStore(storePath) {
  const session = new McpSession(["--store", storePath, "--environment", "dev"]);
  try {
    const outcome = await Promise.race([
      session.exit,
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    const code = outcome?.code ?? null;
    check(
      "08 corrupt store → exit 2, no serving",
      code === 2 &&
        session.stderr.includes(`${storePath} is not a valid note set`) &&
        session.orphans.length === 0,
      `exit=${code} stderr=${session.stderr.trim().split("\n")[0] ?? ""} stdout frames=${session.orphans.length}`,
    );
  } finally {
    await session.close();
  }
}

async function case09_notification(storePath) {
  const session = new McpSession(["--store", storePath, "--environment", "dev"]);
  try {
    // An id-less `initialize` is the case that used to produce a frame without an id, which a
    // JSON-RPC client cannot match to anything.
    session.notify("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "mcp-smoke" } });
    session.notify("notifications/initialized", {});
    session.notify("tools/list", {});
    const answered = await session.request("ping", {});
    check(
      "09 a notification (no id) produces no frame",
      answered.result !== undefined && session.orphans.length === 0,
      `id-less frames=${session.orphans.length}`,
    );
  } finally {
    await session.close();
  }
}

async function case10_errorCodes(storePath) {
  const session = new McpSession(["--store", storePath, "--environment", "dev"]);
  try {
    await session.initialize();
    const unknownMethod = await session.request("does/not/exist", {});
    const unknownTool = await session.callTool("no_such_tool", {});
    const unknownResource = await session.request("resources/read", { uri: "bluepencil://nope" });
    const unknownPrompt = await session.request("prompts/get", { name: "no-such-prompt" });
    const outcomes = [
      ["method -32601", isJsonRpcError(unknownMethod, -32601)],
      ["tool -32602", isJsonRpcError(unknownTool, -32602)],
      ["resource -32602", isJsonRpcError(unknownResource, -32602)],
      ["prompt -32602", isJsonRpcError(unknownPrompt, -32602)],
    ];
    const wrong = outcomes.filter(([, ok]) => !ok).map(([name]) => name);
    check(
      "10 unknown method/tool/resource/prompt → documented codes",
      wrong.length === 0,
      wrong.length === 0 ? outcomes.map(([name]) => name).join(", ") : `wrong: ${wrong.join(", ")}`,
    );
  } finally {
    await session.close();
  }
}

async function case11_writeFailure(storePath) {
  const session = new McpSession(["--store", storePath, "--environment", "dev", "--allow-write"]);
  try {
    await session.initialize();
    const created = tool(await session.callTool("create_note", { body: "cannot be written", hook: "h-fail" }));
    const fileExists = await exists(storePath);
    check(
      "11 a write that cannot persist is an error, not a success (F7)",
      created.isError && created.text.includes("did not persist") && !fileExists,
      created.isError ? created.text.replace(/\s+/g, " ").slice(0, 140) : "reported success without a store file",
    );
  } finally {
    await session.close();
  }
}

async function case12_pipelinedWrites(storePath) {
  const session = new McpSession(["--store", storePath, "--environment", "dev", "--allow-write"]);
  try {
    await session.initialize();
    // Both requests are written to stdin before either answer is read — the case that used to give
    // two writes of the same process the same temporary file.
    const [first, second] = await Promise.all([
      session.callTool("create_note", { body: "pipelined a", hook: "pipe-a" }),
      session.callTool("create_note", { body: "pipelined b", hook: "pipe-b" }),
    ]);
    const ids = [tool(first).json().created?.id, tool(second).json().created?.id];
    const notes = await readNotes(storePath);
    const stored = notes.map((entry) => entry.id);
    check(
      "12 pipelined writes both persist",
      ids.every((id) => typeof id === "string" && stored.includes(id)) && stored.length === 2,
      `${stored.length} note(s) in the store, both ids present: ${ids.every((id) => stored.includes(id))}`,
    );
  } finally {
    await session.close();
  }
}

/* ------------------------------------------------------------------------------------------------
 * Runner
 * ---------------------------------------------------------------------------------------------- */

async function main() {
  if (!(await exists(entry))) {
    console.log(`FAIL setup: ${entry} not found — run 'npm run build' first`);
    process.exit(1);
  }
  await mkdir(fixtureDir, { recursive: true });

  const storeReadOnly = await writeFixture(
    "store-readonly.bluepencil.json",
    noteSet([note({ id: "n-work", body: "work note", environment: "dev", createdAt: T0 })]),
  );
  const storeWrite = await writeFixture(
    "store-write.bluepencil.json",
    noteSet([
      note({ id: "n-work", body: "work note", environment: "dev", createdAt: T0 }),
      note({ id: "n-pending", body: "which option?", environment: "dev", createdAt: T1, status: "needs_decision" }),
    ]),
  );
  const storeEnv = await writeFixture(
    "store-env.bluepencil.json",
    noteSet([
      note({ id: "n-dev", body: "dev note", environment: "dev", createdAt: T0 }),
      note({ id: "n-live", body: "live note", environment: "live", createdAt: T1 }),
    ]),
  );
  const storeImport = await writeFixture(
    "store-import.bluepencil.json",
    noteSet([
      note({
        id: "n-conflict",
        body: "old body",
        environment: "dev",
        createdAt: T0,
        messages: [message("m-1", T0, "first")],
      }),
      note({ id: "n-untouched", body: "untouched note", environment: "dev", createdAt: T1, updatedAt: T1 }),
    ]),
  );
  const bundlePath = await writeFixture(
    "bundle-import.bluepencil.json",
    bundleText(
      [
        note({
          id: "n-conflict",
          body: "new body",
          environment: "dev",
          createdAt: T0,
          updatedAt: T2,
          messages: [message("m-2", T2, "second")],
        }),
        note({
          id: "n-added",
          body: "added by the bundle",
          environment: "dev",
          createdAt: T3,
          updatedAt: T3,
          sessionRef: "s-round-1",
          ticketRef: "TICKET-42",
          debug: { commit: "abc123", file: "src/app.ts:12" },
        }),
      ],
      "dev",
    ),
  );
  const storeCorrupt = await writeFixture("store-corrupt.bluepencil.json", "{ this is not a note set");
  const storePipeline = await writeFixture("store-pipeline.bluepencil.json", noteSet([]));
  // The parent directory does not exist on purpose: every write to this path fails (F7).
  const storeUnwritable = join(fixtureDir, "no-such-dir", "store.bluepencil.json");

  const cases = [
    ["01", () => case01_initialize(storeReadOnly)],
    ["02", () => case02_toolList(storeReadOnly)],
    ["03", () => case03_readOnlyRefusals(storeReadOnly)],
    ["04", () => case04_writeIsPersisted(storeWrite)],
    ["05", () => case05_protocolRules(storeWrite)],
    ["06", () => case06_environmentBinding(storeEnv)],
    ["07", () => case07_import(storeImport, bundlePath)],
    ["08", () => case08_corruptStore(storeCorrupt)],
    ["09", () => case09_notification(storeReadOnly)],
    ["10", () => case10_errorCodes(storeReadOnly)],
    ["11", () => case11_writeFailure(storeUnwritable)],
    ["12", () => case12_pipelinedWrites(storePipeline)],
  ];

  for (const [label, run] of cases) {
    try {
      await run();
    } catch (error) {
      failures += 1;
      checks += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`FAIL ${label} (threw): ${message}`);
    }
  }

  console.log(
    `\nmcp-smoke: ${checks - failures}/${checks} check(s) passed, fixtures in ${fixtureDir.replace(`${root}/`, "")}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

await main();
