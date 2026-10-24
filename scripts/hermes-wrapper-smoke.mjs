#!/usr/bin/env node
/**
 * End-to-end smoke test for the documented Hermes MCP path (docs/HERMES.md §2).
 *
 * `scripts/mcp-smoke.mjs` proves the server argv contract; this driver proves the **wrapper**
 * around it: `scripts/hermes-mcp-wrapper.sh` passes the store, environment, app and write opt-in
 * through environment variables, exactly as a Hermes `mcp_servers.bluepencil.env` block does.
 *
 * Real processes only: every case spawns `bash scripts/hermes-mcp-wrapper.sh`, speaks
 * newline-delimited JSON-RPC 2.0 over stdio and waits for the answer to its own request id. The
 * write case additionally parses the store file on disk, so an RPC success that never reached the
 * medium cannot pass.
 *
 * Run it from the repository root after a build:
 *   node scripts/hermes-wrapper-smoke.mjs
 *
 * Fixtures live in `.tmp/hermes-wrapper-smoke/<pid>/` (git-ignored, unique per run so concurrent
 * runs cannot collide) and are left behind on purpose, so a failing run can be inspected. Exit code
 * is 0 when every case passed, 1 otherwise.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const wrapper = join(root, "scripts", "hermes-mcp-wrapper.sh");
// Per-run directory: a second concurrent smoke must not delete this run's store.
const fixtureDir = join(root, ".tmp", "hermes-wrapper-smoke", String(process.pid));
const storePath = join(fixtureDir, "store.bluepencil.json");
const RESPONSE_TIMEOUT_MS = 10_000;

/** Every live wrapper process, so the signal path can close them all (idempotently). */
const liveSessions = new Set();

/* ------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

const T0 = "2026-01-01T00:00:00.000Z";

/** One note in the shape the model documents (src/core/model.ts). */
function note(input) {
  return {
    id: input.id,
    schemaVersion: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    type: "text",
    intent: "implement",
    status: "open",
    body: input.body,
    author: "human",
    authorType: "human",
    anchor: { hook: input.id },
    context: null,
    messages: [],
    source: "ui:human",
    environment: input.environment,
  };
}

/** A valid bundle (the export shape), with exactly one `dev` note. */
function bundleText(notes) {
  return `${JSON.stringify(
    {
      kind: "bluepencil.bundle",
      schemaVersion: 1,
      exportedAt: T0,
      exportedBy: "hermes-wrapper-smoke",
      environment: "dev",
      app: { name: "hermes-smoke" },
      sessions: [],
      notes,
    },
    null,
    2,
  )}\n`;
}

/** The adapter writes `{ version, notes }`; a bare `Note[]` is accepted as well. */
function storedNotes(text) {
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed.notes ?? []);
}

/**
 * A deliberately small environment: no `BLUEPENCIL_*` value can leak in from the caller, so each
 * case proves the wrapper sets the session up itself.
 */
function wrapperEnv(extra = {}) {
  const base = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "",
  };
  if (process.env.TMPDIR !== undefined) base.TMPDIR = process.env.TMPDIR;
  return { ...base, ...extra };
}

/* ------------------------------------------------------------------------------------------------
 * stdio driver
 * ---------------------------------------------------------------------------------------------- */

class WrapperSession {
  #child;
  #buffer = "";
  #nextId = 0;
  #pending = new Map();
  #orphans = [];
  #stderr = "";
  #exitInfo = null;
  #closed = false;
  #exited;
  #resolveExit;
  #closedEvent;
  #resolveClosed;

  constructor(env) {
    this.#exited = new Promise((resolveExit) => {
      this.#resolveExit = resolveExit;
    });
    // `exit` fires before the stdout pipes are drained; `close` fires after. The purity assertion
    // must run on the drained stream, otherwise a trailing banner line can still be in flight.
    this.#closedEvent = new Promise((resolveClosed) => {
      this.#resolveClosed = resolveClosed;
    });
    this.#child = spawn("bash", [wrapper], {
      cwd: root,
      env: wrapperEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    liveSessions.add(this);
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk) => this.#consume(chunk));
    this.#child.stderr.on("data", (chunk) => {
      this.#stderr += chunk;
    });
    // `exit` is not the only way a session ends. A spawn error fires no `exit`, and `close` can
    // arrive without one; settling on all three keeps `close()` from awaiting SIGKILL forever.
    this.#child.once("exit", (code, signal) => this.#settleExit({ code, signal }));
    this.#child.once("error", (error) => {
      this.#stderr += `spawn error: ${error.message}\n`;
      this.#rejectPending(new Error(`wrapper spawn error: ${error.message}`));
      this.#settleExit({ code: null, signal: null, error: error.message });
    });
    this.#child.once("close", (code, signal) => {
      // `close` runs after the stdio pipes drained, so a pending request that never got an answer
      // is genuinely unanswered here — reject it instead of waiting for the per-request timeout.
      this.#settleExit({ code, signal });
      this.#rejectPending(new Error(`wrapper closed before answering (exit ${code ?? signal})`));
      this.#resolveClosed();
    });
  }

  #settleExit(info) {
    if (this.#exitInfo !== null) return;
    this.#exitInfo = info;
    liveSessions.delete(this);
    this.#resolveExit(info);
  }

  #rejectPending(error) {
    for (const waiter of this.#pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#pending.clear();
  }

  get stderr() {
    return this.#stderr;
  }

  get orphans() {
    return this.#orphans;
  }

  get hasExited() {
    return this.#exitInfo !== null;
  }

  send(frame) {
    if (this.#child.stdin.writable) {
      this.#child.stdin.write(`${JSON.stringify(frame)}\n`);
    }
  }

  /** A request: returns the response frame for its own id (401-style id matching). */
  request(method, params) {
    this.#nextId += 1;
    const id = this.#nextId;
    const answered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`timeout after ${RESPONSE_TIMEOUT_MS}ms waiting for ${method} (id ${id})`));
      }, RESPONSE_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return answered;
  }

  callTool(name, args = {}) {
    return this.request("tools/call", { name, arguments: args });
  }

  initialize() {
    return this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "hermes-wrapper-smoke", version: "1.0.0" },
    });
  }

  /** Waits for the process to end on its own; `null` when it is still running. */
  async waitForExit(timeoutMs) {
    return Promise.race([
      this.#exited,
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  }

  /**
   * Waits until the child's stdio pipes are drained (`close`); `false` on timeout. Bounded, so a
   * wrapper that never reports `close` cannot hang the runner.
   */
  async waitForClose(timeoutMs) {
    return Promise.race([
      this.#closedEvent.then(() => true),
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), timeoutMs)),
    ]);
  }

  /** Ends the session: stdin close, then SIGTERM, then SIGKILL — never a hanging stdio child. */
  async close() {
    // Idempotent, but always hand back a session whose stdout is drained: a second `close()` after
    // the first must not let `checkStdoutPurity()` observe a half-read stream.
    if (this.#closed) {
      await this.waitForClose(2000);
      return this.#exitInfo;
    }
    this.#closed = true;
    try {
      this.#child.stdin.end();
    } catch {
      // stdin may already be gone; the kill path below still applies.
    }
    // Every return path drains `close` first (bounded), so the caller's purity check sees the
    // complete stdout, including a line the wrapper printed just before exiting.
    const settled = async () => {
      await this.waitForClose(2000);
      return this.#exitInfo;
    };
    if ((await this.waitForExit(1000)) !== null) return settled();
    this.#child.kill("SIGTERM");
    if ((await this.waitForExit(1500)) !== null) return settled();
    this.#child.kill("SIGKILL");
    // Bounded even after SIGKILL: a wrapper that never reports `exit`/`close` must not hang the
    // runner (the promise now also settles on `error`/`close`, but the guard stays).
    await Promise.race([
      this.#exited,
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2000)),
    ]);
    return settled();
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
      const waiter = frame !== null ? this.#pending.get(frame.id) : undefined;
      if (waiter !== undefined) {
        this.#pending.delete(frame.id);
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
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
    summary: () => text.replace(/\s+/g, " ").slice(0, 140),
  };
}

function short(value) {
  return String(value ?? "").replace(/\s+/g, " ").slice(0, 140);
}

/**
 * The stdio contract is JSON-RPC only: every stdout line must belong to a request. A banner or a
 * stray log line arrives as an orphan. Checked at the end of *every* session, not just the first
 * one — a later case must not be able to pass while printing noise.
 */
function checkStdoutPurity(name, session) {
  const orphans = session.orphans;
  check(
    name,
    orphans.length === 0,
    orphans.length === 0
      ? "0 orphaned line(s)"
      : `${orphans.length} orphaned line(s): ${orphans.slice(0, 5).map(short).join(" | ")}`,
  );
}

/* ------------------------------------------------------------------------------------------------
 * Cases
 * ---------------------------------------------------------------------------------------------- */

const SEEDED_BODY = "hermes seeded note";
const WRITTEN_BODY = "written through the wrapper";

/** Cases 1 and 2 share one session on purpose: read-only is the wrapper's default. */
async function case01And02_readSession() {
  const session = new WrapperSession({
    BLUEPENCIL_STORE: storePath,
    BLUEPENCIL_ENVIRONMENT: "dev",
    BLUEPENCIL_APP: "hermes-smoke",
  });
  try {
    // Case 1 — initialize, tool surface, seeded note.
    const initialized = await session.initialize();
    const info = initialized.result?.serverInfo ?? {};
    check(
      "case 1a initialize",
      initialized.error === undefined &&
        info.name === "bluepencil" &&
        typeof info.version === "string" &&
        initialized.result?.protocolVersion === "2024-11-05",
      `serverInfo=${info.name}/${info.version} protocol=${initialized.result?.protocolVersion}`,
    );

    const listed = await session.request("tools/list", {});
    const names = (listed.result?.tools ?? []).map((entry) => entry.name);
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
      "case 1b tools/list",
      names.length === 9 && missing.length === 0 && !names.includes("list_instances"),
      `${names.length} tool(s)${missing.length > 0 ? `, missing ${missing.join(", ")}` : ""}` +
        `${names.includes("list_instances") ? ", list_instances unexpectedly present" : ""}`,
    );

    const notes = tool(await session.callTool("list_notes", {}));
    const bodies = notes.isError ? [] : notes.json().notes.map((entry) => entry.body);
    check(
      "case 1c list_notes shows the seeded note",
      !notes.isError && bodies.includes(SEEDED_BODY),
      notes.isError ? notes.summary() : `bodies=${JSON.stringify(bodies)}`,
    );

    // A stdout banner or a stray log line would otherwise be collected by `#consume` and silently
    // ignored. The stdio contract is JSON-RPC only: after the first handshake, tools/list and a
    // tool call, every line must have belonged to a pending request (i.e. no orphans).
    const orphans = session.orphans;
    check(
      "case 1d stdout carries only JSON-RPC frames (no orphaned line)",
      orphans.length === 0,
      orphans.length === 0
        ? "0 orphaned line(s)"
        : `${orphans.length} orphaned line(s): ${orphans.slice(0, 5).map(short).join(" | ")}`,
    );

    // Case 2 — read-only default: a valid create payload must be refused.
    const refused = tool(
      await session.callTool("create_note", { body: "should be refused", hook: "hermes-refused" }),
    );
    check(
      "case 2 create_note refused read-only",
      refused.isError && /read-only/i.test(refused.text),
      refused.isError ? refused.summary() : `not refused: ${refused.summary()}`,
    );
  } finally {
    await session.close();
    checkStdoutPurity("case 1e session-end stdout carries only JSON-RPC frames", session);
  }
}

/** Case 3 — writes opted in through the wrapper's environment. */
async function case03_writesOptIn() {
  const session = new WrapperSession({
    BLUEPENCIL_STORE: storePath,
    BLUEPENCIL_ENVIRONMENT: "dev",
    BLUEPENCIL_APP: "hermes-smoke",
    BLUEPENCIL_ALLOW_WRITE: "1",
  });
  try {
    await session.initialize();
    const created = tool(
      await session.callTool("create_note", { body: WRITTEN_BODY, hook: "hermes-written" }),
    );
    const createdId = created.isError ? "" : (created.json().created?.id ?? "");

    // The proof is the file, not the reply: parse the store on disk after the RPC answered.
    const onDisk = storedNotes(await readFile(storePath, "utf8"));
    const persisted = onDisk.find((entry) => entry.body === WRITTEN_BODY);

    check(
      "case 3a create_note succeeds with writes enabled",
      !created.isError && createdId !== "",
      created.isError ? created.summary() : `created ${createdId}`,
    );
    check(
      "case 3b the new note is physically in BLUEPENCIL_STORE",
      persisted !== undefined && persisted.id === createdId,
      persisted === undefined
        ? `body not found in ${onDisk.length} stored note(s)`
        : `stored ${persisted.id} with body ${JSON.stringify(persisted.body)}`,
    );
  } finally {
    await session.close();
    checkStdoutPurity("case 3c session-end stdout carries only JSON-RPC frames", session);
  }
}

/** Case 4 — a new process sees the write the previous process made. */
async function case04_persistenceAcrossProcesses() {
  const session = new WrapperSession({
    BLUEPENCIL_STORE: storePath,
    BLUEPENCIL_ENVIRONMENT: "dev",
    BLUEPENCIL_APP: "hermes-smoke",
  });
  try {
    await session.initialize();
    const notes = tool(await session.callTool("list_notes", { include_done: true }));
    const bodies = notes.isError ? [] : notes.json().notes.map((entry) => entry.body);
    check(
      "case 4 the written note survives a new wrapper process",
      !notes.isError && bodies.includes(WRITTEN_BODY),
      notes.isError ? notes.summary() : `bodies=${JSON.stringify(bodies)}`,
    );
  } finally {
    await session.close();
    checkStdoutPurity("case 4b session-end stdout carries only JSON-RPC frames", session);
  }
}

/** Case 5 — the wrapper's fail-fast contract when the store is missing. */
async function case05_missingStore() {
  const session = new WrapperSession({
    BLUEPENCIL_ENVIRONMENT: "dev",
    BLUEPENCIL_APP: "hermes-smoke",
  });
  try {
    const outcome = await session.waitForExit(5000);
    const code = outcome?.code ?? null;
    check(
      "case 5 missing BLUEPENCIL_STORE exits 1",
      outcome !== null &&
        code === 1 &&
        session.stderr.includes("BLUEPENCIL_STORE is required"),
      `exit=${code} stderr=${short(session.stderr)}`,
    );
  } finally {
    await session.close();
    checkStdoutPurity("case 5b session-end stdout carries only JSON-RPC frames", session);
  }
}

/** Case 6 — app and environment from the wrapper's environment reach the session. */
async function case06_appAndEnvironment() {
  const session = new WrapperSession({
    BLUEPENCIL_STORE: storePath,
    BLUEPENCIL_ENVIRONMENT: "dev",
    BLUEPENCIL_APP: "hermes-smoke",
  });
  try {
    await session.initialize();

    // `list_notes` carries the session envelope and `export_bundle` the bundle metadata; both are
    // read-only, so this also checks the metadata surface a read-only Hermes session actually has.
    const listed = tool(await session.callTool("list_notes", { include_done: true }));
    const envelope = listed.isError ? {} : listed.json();

    const exported = tool(await session.callTool("export_bundle", { format: "json" }));
    const bundle = exported.isError ? {} : exported.json();

    check(
      "case 6a list_notes reports app and environment",
      !listed.isError && envelope.app === "hermes-smoke" && envelope.environment === "dev",
      listed.isError ? listed.summary() : `app=${envelope.app} environment=${envelope.environment}`,
    );
    check(
      "case 6b export_bundle reports app and environment",
      !exported.isError && bundle.app?.name === "hermes-smoke" && bundle.environment === "dev",
      exported.isError
        ? exported.summary()
        : `app=${bundle.app?.name} environment=${bundle.environment}`,
    );
  } finally {
    await session.close();
    checkStdoutPurity("case 6c session-end stdout carries only JSON-RPC frames", session);
  }
}

/* ------------------------------------------------------------------------------------------------
 * Signal handling
 * ---------------------------------------------------------------------------------------------- */

/**
 * Idempotent abort path: SIGINT/SIGTERM close every live wrapper session and exit 130/143. Without
 * it an interrupted run would leave the stdio children (and their node grandchildren) behind.
 */
let signalExitCode = null;

function installSignalHandlers() {
  for (const [signal, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    process.on(signal, () => {
      if (signalExitCode !== null) return;
      signalExitCode = exitCode;
      console.log(`\nhermes-wrapper-smoke: ${signal} received — closing ${liveSessions.size} session(s)`);
      void (async () => {
        for (const session of [...liveSessions]) await session.close();
        process.exit(exitCode);
      })();
    });
  }
}

/* ------------------------------------------------------------------------------------------------
 * Runner
 * ---------------------------------------------------------------------------------------------- */

async function main() {
  installSignalHandlers();
  await rm(fixtureDir, { recursive: true, force: true });
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(
    storePath,
    bundleText([note({ id: "n-hermes", body: SEEDED_BODY, environment: "dev", createdAt: T0 })]),
    "utf8",
  );

  const cases = [
    ["cases 1-2", case01And02_readSession],
    ["case 3", case03_writesOptIn],
    ["case 4", case04_persistenceAcrossProcesses],
    ["case 5", case05_missingStore],
    ["case 6", case06_appAndEnvironment],
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
    `\nhermes-wrapper-smoke: ${checks - failures}/${checks} check(s) passed, ` +
      `fixtures in ${fixtureDir.replace(`${root}/`, "")}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

await main();
