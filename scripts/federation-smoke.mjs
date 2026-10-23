#!/usr/bin/env node
/**
 * Federation smoke test (plan §6/§8, PR 6): the built federator, the built hub's aggregate door and
 * the `instances` CLI against **real processes**.
 *
 * It starts two real leaf hubs (`dist/server.js`) on free loopback ports, one aggregating hub
 * (`--registry --no-self`), an authenticated hub and a fake `/config` server, then drives the
 * federator over newline-delimited JSON-RPC and the CLI with `spawn`. Nothing is mocked: the cases
 * prove the parts that a unit test cannot — that the built shebang starts, that stdout stays
 * protocol-only, that writes land in exactly one store file and that a dead peer degrades instead
 * of killing the session.
 *
 * Run it after a build:
 *   npm run build && node scripts/federation-smoke.mjs
 *
 * Fixtures live in `.tmp/federation-smoke/` (left behind on failure for inspection). Every child
 * is killed in `finally`; every wait has a hard timeout, so CI cannot hang.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const serverEntry = join(root, "dist", "server.js");
const federatorEntry = join(root, "dist", "federator.js");
const cliEntry = join(root, "dist", "cli.js");
const mcpEntry = join(root, "dist", "mcp.js");
const workspace = join(root, ".tmp", "federation-smoke");
const BASE = "/api/v1/bluepencil";
const RESPONSE_TIMEOUT_MS = 10_000;
const STARTUP_TIMEOUT_MS = 10_000;

const T0 = "2026-01-01T00:00:00.000Z";

/* ------------------------------------------------------------------------------------------------
 * Process bookkeeping
 * ---------------------------------------------------------------------------------------------- */

const children = new Set();

function track(child) {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

async function stopChild(child) {
  if (child === null || child === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const outcome = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
  ]);
  if (outcome === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

function note(input) {
  return {
    id: input.id,
    schemaVersion: 1,
    createdAt: input.createdAt ?? T0,
    updatedAt: input.updatedAt ?? input.createdAt ?? T0,
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

function noteSet(notes) {
  return `${JSON.stringify({ version: 1, notes })}\n`;
}

function writeFile(name, text) {
  const path = join(workspace, name);
  writeFileSync(path, text, "utf8");
  return path;
}

function writeJson(name, value) {
  return writeFile(name, `${JSON.stringify(value, null, 2)}\n`);
}

function writeRegistry(name, value) {
  const path = writeJson(name, value);
  // FR-16.10/T79: the loader refuses anything group or others can read.
  chmodSync(path, 0o600);
  return path;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function baseUrl(port) {
  return `http://127.0.0.1:${port}${BASE}`;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------------------------------------
 * Hub processes
 * ---------------------------------------------------------------------------------------------- */

async function startHub(label, options) {
  const port = options.port ?? (await freePort());
  const args = [
    "--store",
    options.store,
    "--port",
    String(port),
    "--host",
    "127.0.0.1",
    "--environment",
    options.environment,
    "--app",
    options.app,
    // The smoke test must never create git journal commits in the repository.
    "--journal",
    "none",
    "--quiet",
  ];
  if (options.registry !== undefined) args.push("--registry", options.registry);
  if (options.noSelf === true) args.push("--no-self");
  if (options.authSecret !== undefined) args.push("--auth-secret", options.authSecret);

  const child = track(
    spawn(process.execPath, [serverEntry, ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.resume();

  const url = baseUrl(port);
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let last = "no attempt";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${label}: hub exited ${child.exitCode} before /config answered — ${stderr.trim().slice(0, 300)}`);
    }
    try {
      const response = await fetch(`${url}/config`);
      if (response.ok) {
        const config = await response.json();
        return { label, child, port, url, config, stderr: () => stderr };
      }
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(50);
  }
  throw new Error(`${label}: hub did not answer /config within ${STARTUP_TIMEOUT_MS}ms (${last}) — ${stderr.trim().slice(0, 300)}`);
}

/* ------------------------------------------------------------------------------------------------
 * HTTP helpers
 * ---------------------------------------------------------------------------------------------- */

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${url} → ${response.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

async function mcpHttp(base, method, params) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${base}/mcp → ${response.status}: ${text.slice(0, 200)}`);
  }
  const frame = JSON.parse(text);
  if (frame.error !== undefined) {
    throw new Error(`${method} → JSON-RPC ${frame.error.code}: ${frame.error.message}`);
  }
  return frame.result;
}

function toolResult(frame) {
  /* Works for both transports: `FederatorSession` hands over the full JSON-RPC frame, while
   * `mcpHttp` returns `frame.result` directly. */
  const result = frame.result ?? frame;
  const text = (result.content ?? []).map((entry) => entry.text ?? "").join("\n");
  return {
    isError: result.isError === true,
    text,
    json() {
      if (text.trim() === "") {
        throw new Error(`empty tool result: ${JSON.stringify(frame)}`);
      }
      return JSON.parse(text);
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * Federator stdio session
 * ---------------------------------------------------------------------------------------------- */

class FederatorSession {
  #child;
  #buffer = "";
  #nextId = 0;
  #pending = new Map();
  #orphans = [];
  #stderr = "";
  #exited;

  constructor(args, env = process.env) {
    this.#child = track(
      spawn(process.execPath, [federatorEntry, ...args], {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      }),
    );
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk) => this.#consume(chunk));
    this.#child.stderr.on("data", (chunk) => {
      this.#stderr += chunk;
    });
    this.#exited = new Promise((resolve) => {
      // `close` fires after both stdio streams have drained; `exit` may fire before that, which
      // would truncate the accumulated stderr this session asserts on (F-03).
      this.#child.once("close", (code, signal) => resolve({ code, signal }));
    });
  }

  get stderr() {
    return this.#stderr;
  }

  get orphans() {
    return this.#orphans;
  }

  send(frame) {
    this.#child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

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

  async initialize() {
    return this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "federation-smoke", version: "1.0.0" },
    });
  }

  callTool(name, args = {}) {
    return this.request("tools/call", { name, arguments: args });
  }

  async close() {
    // Wait for `close`, not just the exit code: the stderr assertion consumes the drained buffer.
    if (this.#child.exitCode !== null) return this.#exited;
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
 * Plain process runner (startup failures, CLI)
 * ---------------------------------------------------------------------------------------------- */

function runNode(entry, args, options = {}) {
  return new Promise((resolve, reject) => {
    // `direct` runs the file itself (its shebang decides the interpreter), which is how npm's
    // POSIX `.bin` symlink is used; the default runs it through this Node binary.
    const command = options.direct === true ? entry : process.execPath;
    const commandArgs = options.direct === true ? args : [entry, ...args];
    const child = spawn(command, commandArgs, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let timer;
    const timeout = new Promise((_, rejectPromise) => {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        rejectPromise(new Error(`process timed out after ${options.timeoutMs ?? 15_000}ms`));
      }, options.timeoutMs ?? 15_000);
    });
    const exited = new Promise((resolveExit) => {
      // Resolve on `close`, not `exit`: Node documents that `exit` can fire before the pipes
      // drain, which would make the accumulated stdout/stderr assertions flaky (F-03).
      child.once("close", (code, signal) => resolveExit({ code, signal }));
      child.once("error", reject);
    });
    void Promise.race([exited, timeout])
      .then((outcome) => {
        clearTimeout(timer);
        resolve({ ...outcome, stdout, stderr });
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
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

/* ------------------------------------------------------------------------------------------------
 * Cases
 * ---------------------------------------------------------------------------------------------- */

async function main() {
  for (const [label, entry] of [
    ["dist/server.js", serverEntry],
    ["dist/federator.js", federatorEntry],
    ["dist/cli.js", cliEntry],
    ["dist/mcp.js", mcpEntry],
  ]) {
    if (!existsSync(entry)) {
      console.log(`FAIL setup: ${label} not found — run 'npm run build' first`);
      process.exit(1);
    }
  }

  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });

  const devStore = writeFile(
    "dev-store.json",
    noteSet([note({ id: "n-dev-1", body: "dev note", environment: "dev" })]),
  );
  const stagingStore = writeFile(
    "staging-store.json",
    noteSet([note({ id: "n-stage-1", body: "staging note", environment: "staging" })]),
  );
  const aggStore = writeFile("agg-store.json", noteSet([]));
  const authStore = writeFile(
    "auth-store.json",
    noteSet([note({ id: "n-auth-1", body: "auth note", environment: "dev" })]),
  );

  let devHub;
  let stagingHub;
  let aggHub;
  let authHub;
  let fakeServer;
  const secret = `fed-smoke-secret-${Date.now()}`;

  try {
    devHub = await startHub("dev", { store: devStore, app: "dev-app", environment: "dev" });
    stagingHub = await startHub("staging", {
      store: stagingStore,
      app: "staging-app",
      environment: "staging",
    });

    // The registry is written after both ports are bound; 0600 is applied by writeRegistry.
    const registryBoth = writeRegistry("registry-both.json", {
      schemaVersion: 1,
      instances: [
        { id: "dev", base: baseUrl(devHub.port), app: "dev-app" },
        { id: "staging", base: baseUrl(stagingHub.port), app: "staging-app" },
      ],
    });
    const registryWrite = writeRegistry("registry-write.json", {
      schemaVersion: 1,
      instances: [
        { id: "dev", base: baseUrl(devHub.port), app: "dev-app", mode: "write" },
        { id: "staging", base: baseUrl(stagingHub.port), app: "staging-app" },
      ],
    });

    /* ------------------------------------------------------------------------------------------
     * (a) aggregate over both hubs
     * ---------------------------------------------------------------------------------------- */
    {
      const session = new FederatorSession(["--registry", registryBoth]);
      let end;
      try {
        const init = await session.initialize();
        const tools = await session.request("tools/list", {});
        const names = (tools.result?.tools ?? []).map((entry) => entry.name);
        const listed = toolResult(await session.callTool("list_notes", { include_done: true }));
        const body = listed.isError ? null : listed.json();
        const ids = (body?.notes ?? []).map((entry) => entry.id);
        const noteDev = (body?.notes ?? []).find((entry) => entry.id === "dev/n-dev-1");
        const noteStage = (body?.notes ?? []).find((entry) => entry.id === "staging/n-stage-1");
        check(
          "a federator initializes as bluepencil-federator with 10 tools",
          init.result?.serverInfo?.name === "bluepencil-federator" && names.length === 10 && names.includes("list_instances"),
          `serverInfo=${init.result?.serverInfo?.name} tools=${names.length}`,
        );
        check(
          "a list_notes aggregates dev and staging with qualified ids",
          !listed.isError &&
            ids.includes("dev/n-dev-1") &&
            ids.includes("staging/n-stage-1") &&
            noteDev?.instance === "dev" &&
            noteDev?.app === "dev-app" &&
            noteStage?.instance === "staging" &&
            noteStage?.app === "staging-app" &&
            body?.partial === false,
          listed.isError ? listed.text.slice(0, 140) : `ids=${ids.join(", ")} partial=${body?.partial}`,
        );
      } finally {
        end = await session.close();
      }
      /* R11: the documented stdin-EOF contract — closing stdin ends the process cleanly, never by
       * signal and never with a non-zero code. */
      check(
        "a closing stdin ends the federator with exit 0 and no signal",
        end?.code === 0 && (end?.signal ?? null) === null,
        `exit=${end?.code} signal=${end?.signal ?? "none"}`,
      );
    }

    /* ------------------------------------------------------------------------------------------
     * (b) write routing: only the targeted store changes
     * ---------------------------------------------------------------------------------------- */
    {
      const beforeDev = sha256File(devStore);
      const beforeStaging = sha256File(stagingStore);
      const session = new FederatorSession(["--registry", registryWrite, "--allow-write"]);
      try {
        await session.initialize();
        const created = toolResult(
          await session.callTool("create_note", {
            instance: "dev",
            body: "written by the federator",
            hook: "fed-write",
          }),
        );
        const payload = created.isError ? null : created.json();
        const afterDev = sha256File(devStore);
        const afterStaging = sha256File(stagingStore);
        check(
          "b create_note routes to dev only and answers with a qualified id",
          !created.isError &&
            typeof payload?.created?.id === "string" &&
            payload.created.id.startsWith("dev/") &&
            payload.created.instance === "dev" &&
            afterDev !== beforeDev &&
            afterStaging === beforeStaging,
          created.isError
            ? created.text.slice(0, 160)
            : `id=${payload?.created?.id} dev=${afterDev === beforeDev ? "unchanged" : "changed"} staging=${afterStaging === beforeStaging ? "unchanged" : "CHANGED"}`,
        );
        const stagingList = toolResult(
          await session.callTool("list_notes", { instance: "staging", include_done: true }),
        );
        const stagingIds = stagingList.isError ? [] : stagingList.json().notes.map((entry) => entry.id);
        check(
          "b the other instance still has only its own note",
          !stagingList.isError && stagingIds.length === 1 && stagingIds[0] === "staging/n-stage-1",
          `staging ids=${stagingIds.join(", ") || "(none)"}`,
        );
      } finally {
        await session.close();
      }
    }

    /* ------------------------------------------------------------------------------------------
     * (c) the two write locks; a refusal never touches a store
     * ---------------------------------------------------------------------------------------- */
    {
      const before = sha256File(devStore);
      const session = new FederatorSession(["--registry", registryWrite]);
      try {
        await session.initialize();
        const denied = toolResult(
          await session.callTool("create_note", { instance: "dev", body: "no lock", hook: "fed-denied" }),
        );
        check(
          "c without --allow-write a mode:write peer is mode_denied",
          denied.isError && denied.text.includes("mode_denied") && sha256File(devStore) === before,
          denied.isError ? denied.text.slice(0, 120) : "write was allowed",
        );
      } finally {
        await session.close();
      }

      const readOnly = new FederatorSession([
        "--registry",
        registryWrite,
        "--read-only=true",
        "--allow-write",
      ]);
      try {
        await readOnly.initialize();
        const denied = toolResult(
          await readOnly.callTool("create_note", { instance: "dev", body: "read only", hook: "fed-ro" }),
        );
        check(
          "c --read-only=true wins over --allow-write and mode:write",
          denied.isError && denied.text.includes("read_only") && sha256File(devStore) === before,
          denied.isError ? denied.text.slice(0, 120) : "write was allowed",
        );
      } finally {
        await readOnly.close();
      }
    }

    /* ------------------------------------------------------------------------------------------
     * (d) self flags: --no-self is a no-op, --include-self is a usage error
     * ---------------------------------------------------------------------------------------- */
    {
      const noSelf = new FederatorSession(["--registry", registryBoth, "--no-self"]);
      try {
        const init = await noSelf.initialize();
        const listed = toolResult(await noSelf.callTool("list_notes", { include_done: true }));
        const body = listed.isError ? null : listed.json();
        const rows = body?.instances ?? [];
        check(
          "d --no-self is accepted and changes nothing for a pure federator",
          init.result !== undefined &&
            !listed.isError &&
            rows.every((row) => row.id !== "self") &&
            (body?.notes ?? []).some((entry) => entry.id === "dev/n-dev-1"),
          `instances=${rows.map((row) => row.id).join(", ") || "(none)"}`,
        );
      } finally {
        await noSelf.close();
      }

      const includeSelf = await runNode(federatorEntry, [
        "--registry",
        registryBoth,
        "--include-self",
      ]);
      check(
        "d --include-self is a usage error (exit 1)",
        includeSelf.code === 1 && /include-self/i.test(includeSelf.stderr),
        `exit=${includeSelf.code} stderr=${includeSelf.stderr.trim().slice(0, 120)}`,
      );
    }

    /* ------------------------------------------------------------------------------------------
     * (f) /config without `federates` → federates_missing, exit 4; healthy identity but
     *     `ok:false` /health → degraded start, exit 0 on EOF (R05)
     * ---------------------------------------------------------------------------------------- */
    {
      const fakePort = await freePort();
      fakeServer = createServer((request, response) => {
        const url = request.url ?? "";
        if (url.startsWith("/unhealthy/")) {
          if (url.endsWith("/config")) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                name: "unhealthy",
                app: "unhealthy-app",
                version: "0.10.0",
                base: "",
                auth: "none",
                readOnly: false,
                federates: false,
                environment: "dev",
                bind: null,
              }),
            );
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, status: "degraded", version: "0.10.0" }));
          return;
        }
        if (url.endsWith("/config")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              name: "fake",
              app: "fake-app",
              version: "0.9.0",
              base: "",
              auth: "none",
              readOnly: false,
              environment: "dev",
              bind: null,
            }),
          );
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, status: "ok", version: "0.9.0" }));
      });
      await new Promise((resolve, reject) => {
        fakeServer.once("error", reject);
        fakeServer.listen(fakePort, "127.0.0.1", resolve);
      });
      const registryFake = writeRegistry("registry-fake.json", {
        schemaVersion: 1,
        instances: [{ id: "fake", base: `http://127.0.0.1:${fakePort}`, app: "fake-app" }],
      });
      const outcome = await runNode(federatorEntry, ["--registry", registryFake]);
      check(
        "f a pre-0.10 /config without federates is federates_missing (exit 4)",
        outcome.code === 4 && outcome.stderr.includes("federates_missing") && outcome.stdout === "",
        `exit=${outcome.code} stderr=${outcome.stderr.trim().slice(0, 140)}`,
      );

      /* R05: a verified peer whose /health answers ok:false is degraded, not a start failure. The
       * stdio loop still starts, sees EOF immediately and exits 0; the warning is one stderr line. */
      const registryUnhealthy = writeRegistry("registry-unhealthy.json", {
        schemaVersion: 1,
        instances: [
          {
            id: "unhealthy",
            base: `http://127.0.0.1:${fakePort}/unhealthy`,
            app: "unhealthy-app",
          },
        ],
      });
      const unhealthy = await runNode(federatorEntry, ["--registry", registryUnhealthy]);
      check(
        "f an ok:false /health starts degraded, logs one line and still exits 0 on EOF",
        unhealthy.code === 0 && unhealthy.stderr.includes('instance "unhealthy" reports /health ok:false'),
        `exit=${unhealthy.code} stderr=${unhealthy.stderr.trim().replace(/\s+/g, " ").slice(0, 160)}`,
      );
    }

    /* ------------------------------------------------------------------------------------------
     * Aggregating hub (real /mcp aggregate, /notes stays local)
     * ---------------------------------------------------------------------------------------- */
    {
      aggHub = await startHub("agg", {
        store: aggStore,
        app: "agg-app",
        environment: "dev",
        registry: registryBoth,
        noSelf: true,
      });
      check(
        "hub --registry reports federates:true",
        aggHub.config.federates === true && aggHub.config.app === "agg-app",
        `federates=${aggHub.config.federates} app=${aggHub.config.app}`,
      );

      const localNotes = await getJson(`${aggHub.url}/notes`);
      check(
        "hub --registry keeps /notes local (empty local store)",
        Array.isArray(localNotes.notes) && localNotes.notes.length === 0,
        `local notes=${localNotes.notes?.length ?? "?"}`,
      );

      const tools = await mcpHttp(aggHub.url, "tools/list", {});
      const names = (tools.tools ?? []).map((entry) => entry.name);
      const listed = toolResult(await mcpHttp(aggHub.url, "tools/call", { name: "list_notes", arguments: { include_done: true } }));
      const body = listed.isError ? null : listed.json();
      const ids = (body?.notes ?? []).map((entry) => entry.id);
      const instances = toolResult(
        await mcpHttp(aggHub.url, "tools/call", { name: "list_instances", arguments: {} }),
      );
      const rows = instances.isError ? [] : instances.json();
      check(
        "hub /mcp aggregates dev + staging and lists no self (--no-self)",
        names.length === 10 &&
          names.includes("list_instances") &&
          !listed.isError &&
          ids.includes("dev/n-dev-1") &&
          ids.includes("staging/n-stage-1") &&
          rows.some((row) => row.id === "dev") &&
          rows.some((row) => row.id === "staging") &&
          !rows.some((row) => row.id === "self"),
        `tools=${names.length} ids=${ids.join(", ")} instances=${rows.map((row) => row.id).join(", ")}`,
      );

      /* ----------------------------------------------------------------------------------------
       * (g) a federating hub as a peer is nested_federation, exit 4
       * -------------------------------------------------------------------------------------- */
      const registryNested = writeRegistry("registry-nested.json", {
        schemaVersion: 1,
        instances: [{ id: "agg", base: aggHub.url, app: "agg-app" }],
      });
      const outcome = await runNode(federatorEntry, ["--registry", registryNested]);
      check(
        "g a peer with federates:true is nested_federation (exit 4)",
        outcome.code === 4 && outcome.stderr.includes("nested_federation"),
        `exit=${outcome.code} stderr=${outcome.stderr.trim().slice(0, 140)}`,
      );
    }

    /* ------------------------------------------------------------------------------------------
     * (h) reserved registry id `self` → self_reference, exit 4
     * ---------------------------------------------------------------------------------------- */
    {
      const registrySelf = writeRegistry("registry-self.json", {
        schemaVersion: 1,
        instances: [{ id: "self", base: baseUrl(devHub.port), app: "dev-app" }],
      });
      const outcome = await runNode(federatorEntry, ["--registry", registrySelf]);
      check(
        "h a registry entry id \"self\" is self_reference (exit 4)",
        outcome.code === 4 && outcome.stderr.includes("self_reference"),
        `exit=${outcome.code} stderr=${outcome.stderr.trim().slice(0, 140)}`,
      );
    }

    /* ------------------------------------------------------------------------------------------
     * (i) instances health: one live authenticated hub + one dead port → 5, no secret anywhere
     * ---------------------------------------------------------------------------------------- */
    {
      authHub = await startHub("auth", {
        store: authStore,
        app: "auth-app",
        environment: "dev",
        authSecret: secret,
      });
      const deadPort = await freePort();
      const registryHealth = writeRegistry("registry-health.json", {
        schemaVersion: 1,
        instances: [
          {
            id: "auth",
            base: baseUrl(authHub.port),
            app: "auth-app",
            auth: { env: "BP_FED_AUTH" },
          },
          { id: "dead", base: `http://127.0.0.1:${deadPort}${BASE}`, app: "dead-app" },
        ],
      });
      const env = { ...process.env, BP_FED_AUTH: secret };
      const outcome = await runNode(
        cliEntry,
        ["instances", "health", "--registry", registryHealth, "--json", "--timeout", "800"],
        { env },
      );
      let parsed = null;
      try {
        parsed = JSON.parse(outcome.stdout);
      } catch {
        parsed = null;
      }
      const ids = (parsed?.instances ?? []).map((row) => row.id);
      const noSecret =
        !outcome.stdout.includes(secret) &&
        !outcome.stderr.includes(secret) &&
        !outcome.stdout.includes("BP_FED_AUTH=");
      check(
        "i instances health: live + dead → exit 5, deterministic order, no secret",
        outcome.code === 5 &&
          ids.join(",") === "auth,dead" &&
          parsed?.instances?.[0]?.ok === true &&
          parsed?.instances?.[1]?.ok === false &&
          noSecret,
        `exit=${outcome.code} ids=${ids.join(",")} secretLeaked=${!noSecret}`,
      );

      /* R12: a start-up failure against the authenticated hub. The registry expects a different
       * app, so the federator must authenticate (otherwise it would fail unauthenticated) and then
       * refuse with identity_mismatch. Neither stream may carry the credential value. */
      const registryMismatch = writeRegistry("registry-auth-mismatch.json", {
        schemaVersion: 1,
        instances: [
          {
            id: "auth",
            base: baseUrl(authHub.port),
            app: "not-auth-app",
            auth: { env: "BP_FED_AUTH" },
          },
        ],
      });
      const mismatch = await runNode(federatorEntry, ["--registry", registryMismatch], { env });
      const mismatchLeak =
        mismatch.stdout.includes(secret) ||
        mismatch.stderr.includes(secret) ||
        mismatch.stdout.includes("BP_FED_AUTH=") ||
        mismatch.stderr.includes("BP_FED_AUTH=");
      check(
        "i federator start-up failure against an authenticated hub exits 4 without leaking the token",
        mismatch.code === 4 &&
          mismatch.stderr.includes("identity_mismatch") &&
          mismatch.stdout === "" &&
          !mismatchLeak,
        `exit=${mismatch.code} secretLeaked=${mismatchLeak} stderr=${mismatch.stderr.trim().slice(0, 140)}`,
      );
    }

    /* ------------------------------------------------------------------------------------------
     * (e) dead instance → degraded start, partial aggregate, health exit 5
     * ---------------------------------------------------------------------------------------- */
    {
      await stopChild(stagingHub.child);
      stagingHub = undefined;

      const session = new FederatorSession(["--registry", registryBoth]);
      try {
        const init = await session.initialize();
        const listed = toolResult(await session.callTool("list_notes", { include_done: true }));
        const body = listed.isError ? null : listed.json();
        const ids = (body?.notes ?? []).map((entry) => entry.id);
        const stagingRow = (body?.instances ?? []).find((row) => row.id === "staging");
        check(
          "e a dead peer starts degraded and makes the aggregate partial",
          init.result !== undefined &&
            !listed.isError &&
            body?.partial === true &&
            stagingRow?.ok === false &&
            stagingRow?.code === "instance_unreachable" &&
            ids.includes("dev/n-dev-1"),
          `partial=${body?.partial} staging=${JSON.stringify(stagingRow)} ids=${ids.join(", ")}`,
        );
        check(
          "e the degraded federator logs one line and stdout stays protocol-only",
          session.stderr.includes('instance "staging" is not reachable at start-up') &&
            session.orphans.length === 0,
          `stderr=${session.stderr.trim().split("\n")[0] ?? ""} orphans=${session.orphans.length}`,
        );
      } finally {
        await session.close();
      }

      const outcome = await runNode(cliEntry, [
        "instances",
        "health",
        "--registry",
        registryBoth,
        "--json",
        "--timeout",
        "800",
      ]);
      check(
        "e instances health against one live + one dead hub exits 5",
        outcome.code === 5,
        `exit=${outcome.code} stderr=${outcome.stderr.trim().slice(0, 120)}`,
      );
    }

    /* ------------------------------------------------------------------------------------------
     * (j) usage and invalid registry
     * ---------------------------------------------------------------------------------------- */
    {
      const missing = await runNode(federatorEntry, []);
      check(
        "j no --registry is a usage error (exit 1)",
        missing.code === 1 && /--registry/i.test(missing.stderr),
        `exit=${missing.code} stderr=${missing.stderr.trim().slice(0, 120)}`,
      );

      const invalidJson = writeFile("registry-invalid-json.json", "{ this is not json");
      chmodSync(invalidJson, 0o600);
      const broken = await runNode(federatorEntry, ["--registry", invalidJson]);
      check(
        "j invalid registry JSON exits 4",
        broken.code === 4 && broken.stdout === "",
        `exit=${broken.code} stderr=${broken.stderr.trim().slice(0, 120)}`,
      );

      const invalidShape = writeRegistry("registry-invalid-shape.json", { schemaVersion: 2 });
      const shaped = await runNode(federatorEntry, ["--registry", invalidShape]);
      check(
        "j an invalid registry shape exits 4",
        shaped.code === 4 && shaped.stdout === "",
        `exit=${shaped.code} stderr=${shaped.stderr.trim().slice(0, 120)}`,
      );
    }

    /* ------------------------------------------------------------------------------------------
     * (k) npm `.bin` shape: a symlinked entry point must not be a silent no-op
     *
     * npm installs `node_modules/.bin/<bin>` as a symlink to the package file, so `process.argv[1]`
     * is the link path while `import.meta.url` is Node's realpath. Guarding on URL equality would
     * exit 0 without printing anything; the guard must compare real paths (F-01).
     * ---------------------------------------------------------------------------------------- */
    {
      const binDir = join(workspace, "bin");
      mkdirSync(binDir, { recursive: true });
      for (const [name, target] of [
        ["bluepencil-federator", federatorEntry],
        ["bluepencil-hub", serverEntry],
      ]) {
        const link = join(binDir, name);
        rmSync(link, { force: true });
        symlinkSync(target, link);
        // Use the `.bin` shape directly when the target carries an exec bit (npm chmods it), and
        // fall back to `node <link>` otherwise. Either way argv[1] is the symlink path.
        let direct = true;
        try {
          accessSync(target, constants.X_OK);
        } catch {
          direct = false;
        }
        const outcome = await runNode(link, ["--version"], { direct });
        const version = outcome.stdout.trim();
        check(
          `k a symlinked ${name} bin prints its version (${direct ? "exec" : "node"} <link>)`,
          outcome.code === 0 && version.length > 0 && /\d+\.\d+\.\d+/.test(version),
          `exit=${outcome.code} stdout=${JSON.stringify(version)} stderr=${outcome.stderr.trim().slice(0, 120)}`,
        );
      }
    }
  } catch (error) {
    failures += 1;
    checks += 1;
    console.log(
      `FAIL runner (threw): ${error instanceof Error ? error.message : String(error)}` +
        (error instanceof Error && error.stack ? `\n${error.stack}` : ""),
    );
  } finally {
    if (fakeServer !== null && fakeServer !== undefined) {
      fakeServer.closeAllConnections?.();
      await new Promise((resolve) => fakeServer.close(resolve));
    }
    for (const child of [...children]) {
      await stopChild(child);
    }
    console.log(
      `\nfederation-smoke: ${checks - failures}/${checks} check(s) passed, fixtures in ${workspace.replace(`${root}/`, "")}`,
    );
  }

  process.exit(failures === 0 ? 0 : 1);
}

await main();
