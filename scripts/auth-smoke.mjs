#!/usr/bin/env node
/**
 * Authentication smoke test (FR-6.7/6.8, #36 phase 2): the built `dist/cli.js` token minter and the
 * built `dist/server.js` auth gate against **real processes** over **real HTTP**.
 *
 * A unit test calls `authorize()` with a hand-built context; this proves the parts that only exist
 * once the binary runs: that `BLUEPENCIL_TOKEN_KEY` reaches the minter, that the token lands on
 * stdout as exactly one line with the id on stderr, that a hub started with a token key in its
 * environment actually enforces it, and that the token/secret/revocation paths answer the
 * documented codes on the wire.
 *
 * Cases:
 *   1  mint a read token (one stdout line, id on stderr, token never echoed)
 *   2  a token-configured hub starts and answers /config
 *   3  a valid read token reads /notes → 200
 *   4  a read token cannot write → 403 insufficient_scope
 *   5  a write token writes, a read token sees the note
 *   6  an expired token → 401 token_expired
 *   7  a revoked id in --revoked-tokens → 401 token_revoked
 *   8  --auth-secret: missing/wrong/right header → 401/401/200
 *   9  /config reports "token" vs "secret" and never contains a credential
 *   10 the /mcp door: initialize, tools/list, tools/call (read + write), 401 without a token,
 *      401 with a wrong token, and 403 when a read token calls a writing tool
 *   11 secret hygiene across every captured hub/CLI stream
 *
 * Run it after a build:
 *   npm run build && node scripts/auth-smoke.mjs
 *
 * Fixtures live in `.tmp/auth-smoke/<pid>/` (left behind for post-mortem). The per-run directory
 * keeps two concurrent runs from deleting each other's stores. Every child is killed in `finally`
 * (SIGTERM, then SIGKILL) and every wait has a hard timeout, so CI cannot hang. The smoke never
 * prints a credential: all details go through `redact()`.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const serverEntry = join(root, "dist", "server.js");
const cliEntry = join(root, "dist", "cli.js");
// Per-run directory: a second concurrent smoke must not delete this run's stores.
const workspace = join(root, ".tmp", "auth-smoke", String(process.pid));
const BASE = "/api/v1/bluepencil";
const STARTUP_TIMEOUT_MS = 10_000;
const PROCESS_TIMEOUT_MS = 20_000;
/** Every HTTP call is bounded: a hung request must fail a case, not stall the smoke. */
const REQUEST_TIMEOUT_MS = 15_000;
const EXPIRY_WAIT_MS = 2_100;

/* ------------------------------------------------------------------------------------------------
 * Credentials — generated per run, never printed
 * ---------------------------------------------------------------------------------------------- */

/** The HMAC key the minter signs with and the hub verifies with. */
const TOKEN_KEY = `auth-smoke-key-${randomBytes(12).toString("hex")}`;
/** The shared secret for the `--auth-secret` hub. Different credential, different hub. */
const SHARED_SECRET = `auth-smoke-secret-${randomBytes(12).toString("hex")}`;

/** Every token this run mints, so the hygiene case can look for all of them in captured output. */
const mintedTokens = [];

/** Removes every credential from a string before it is printed or composed into a message. */
function redact(text) {
  let out = String(text);
  for (const value of [TOKEN_KEY, SHARED_SECRET, ...mintedTokens]) {
    if (typeof value === "string" && value.length > 0) out = out.split(value).join("<redacted>");
  }
  return out;
}

/** A short, redacted one-liner for a failure detail. */
function detail(text, limit = 200) {
  return redact(text).replace(/\s+/g, " ").trim().slice(0, limit);
}

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
    // Bounded as well: an unkillable child must not turn the signal path into a hang.
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
  }
}

/**
 * Idempotent abort path: SIGINT/SIGTERM stop every tracked child and exit 130/143. `finally` only
 * runs on the normal path, so an interrupted smoke would otherwise orphan hub processes.
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
      console.log(`\nauth-smoke: ${signal} received — stopping ${children.size} child process(es)`);
      void (async () => {
        for (const child of [...children]) await stopChild(child);
        process.exit(exitCode);
      })();
    });
  }
}

/* ------------------------------------------------------------------------------------------------
 * Environment and files
 * ---------------------------------------------------------------------------------------------- */

/**
 * The parent environment minus every `BLUEPENCIL_*` variable: this smoke controls the credentials
 * explicitly, and an inherited key must not silently arm token auth on the secret hub.
 */
function isolatedEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("BLUEPENCIL_")) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

function writeJson(name, value) {
  const path = join(workspace, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

/** An empty canonical store: a hub starts without a pre-existing note set, but a file is honest. */
function emptyStore(name) {
  return writeJson(name, { version: 1, notes: [] });
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
 * Plain process runner (CLI)
 * ---------------------------------------------------------------------------------------------- */

function runNode(entry, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? isolatedEnv(),
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
        rejectPromise(
          new Error(`process timed out after ${options.timeoutMs ?? PROCESS_TIMEOUT_MS}ms`),
        );
      }, options.timeoutMs ?? PROCESS_TIMEOUT_MS);
    });
    const exited = new Promise((resolveExit) => {
      // `close`, not `exit`: Node may fire `exit` before the pipes drain, which would truncate the
      // captured output these cases assert on.
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
 * Token minting
 * ---------------------------------------------------------------------------------------------- */

/**
 * Runs `bluepencil token` and returns the parsed result. The token is on stdout (one non-empty
 * line) and the context — including the id a revocation list needs — is on stderr, exactly as
 * documented. Throws on a non-zero exit, so a broken minter fails the runner, not a later case.
 */
async function mint(device, scope, ttlSeconds) {
  const outcome = await runNode(
    cliEntry,
    [
      "token",
      "--device",
      device,
      "--scope",
      scope,
      "--ttl",
      String(ttlSeconds),
    ],
    { env: isolatedEnv({ BLUEPENCIL_TOKEN_KEY: TOKEN_KEY }) },
  );
  const lines = outcome.stdout.split("\n").filter((line) => line.trim() !== "");
  const token = lines.length === 1 ? lines[0].trim() : "";
  const id = /^id:\s+(\S+)/m.exec(outcome.stderr)?.[1] ?? "";
  return { ...outcome, lines, token, id };
}

/* ------------------------------------------------------------------------------------------------
 * Hub processes
 * ---------------------------------------------------------------------------------------------- */

async function startHub(label, options) {
  const port = await freePort();
  const args = [
    "--store",
    options.store,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--base",
    BASE,
    "--name",
    "auth-smoke",
    "--app",
    "auth-smoke",
    // The store lives inside the repository's work tree; the smoke must never create journal
    // commits there.
    "--journal",
    "none",
  ];
  // Credentials are handed in through the environment, never argv: `/proc/<pid>/cmdline` (and
  // `ps`) is world-readable on many hosts, so `--token-key`/`--auth-secret` would leak them.
  const secretEnv = {};
  if (options.tokenKey !== undefined) secretEnv.BLUEPENCIL_TOKEN_KEY = options.tokenKey;
  if (options.authSecret !== undefined) secretEnv.BLUEPENCIL_AUTH_SECRET = options.authSecret;
  if (options.revokedTokens !== undefined) args.push("--revoked-tokens", options.revokedTokens);

  const child = track(
    spawn(process.execPath, [serverEntry, ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: isolatedEnv(secretEnv),
    }),
  );
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

  const url = baseUrl(port);
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let last = "no attempt";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `${label}: hub exited ${child.exitCode} before /config answered — ${detail(stderr, 300)}`,
      );
    }
    try {
      const response = await fetch(`${url}/config`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const config = await response.json();
        return { label, child, port, url, config, output: () => `${stdout}\n${stderr}` };
      }
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(50);
  }
  throw new Error(
    `${label}: hub did not answer /config within ${STARTUP_TIMEOUT_MS}ms (${last}) — ${detail(stderr, 300)}`,
  );
}

/* ------------------------------------------------------------------------------------------------
 * HTTP helpers
 * ---------------------------------------------------------------------------------------------- */

async function request(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

async function postJson(url, body, headers = {}) {
  return request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function mcp(url, method, params, headers = {}) {
  return postJson(url, { jsonrpc: "2.0", id: 1, method, params }, headers);
}

/** The JSON payload of a successful MCP tool result, or `null` when the call reported an error. */
function toolJson(frame) {
  const result = frame?.result;
  if (result === undefined || result.isError === true) return null;
  const text = (result.content ?? []).map((entry) => entry.text ?? "").join("\n");
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Assertions
 * ---------------------------------------------------------------------------------------------- */

let failures = 0;
let cases = 0;

function check(name, ok, why = "") {
  cases += 1;
  if (ok) {
    console.log(`PASS ${name}`);
    return;
  }
  failures += 1;
  console.log(`FAIL ${name}: ${redact(why)}`);
}

/* ------------------------------------------------------------------------------------------------
 * Cases
 * ---------------------------------------------------------------------------------------------- */

async function main() {
  for (const [label, entry] of [
    ["dist/server.js", serverEntry],
    ["dist/cli.js", cliEntry],
  ]) {
    if (!existsSync(entry)) {
      console.log(`FAIL setup: ${label} not found — run 'npm run build' first`);
      process.exit(1);
    }
  }

  // Installed before the first child exists: an abort at any later point still reaps it.
  installSignalHandlers();

  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });

  const tokenStore = emptyStore("token-store.json");
  const revokedStore = emptyStore("revoked-store.json");
  const secretStore = emptyStore("secret-store.json");

  let tokenHub;
  let revokedHub;
  let secretHub;
  /** Every CLI stderr this run captured, for the hygiene case. */
  const cliStreams = [];

  try {
    /* ------------------------------------------------------------------------------------------
     * 1. mint a read token
     * ---------------------------------------------------------------------------------------- */
    const read = await mint("read-device", "read", 3600);
    cliStreams.push(read.stderr);
    if (read.token !== "") mintedTokens.push(read.token);
    check(
      "1 mint read token: one non-empty stdout line, id on stderr, exit 0",
      read.code === 0 &&
        read.lines.length === 1 &&
        read.token.split(".").length === 3 &&
        read.id.length > 0 &&
        read.stderr.includes("device:  read-device") &&
        read.stderr.includes("scope:   read"),
      `exit=${read.code} stdoutLines=${read.lines.length} id=${read.id === "" ? "missing" : "present"} stderr=${detail(read.stderr)}`,
    );

    /* ------------------------------------------------------------------------------------------
     * 2. a token-configured hub starts
     * ---------------------------------------------------------------------------------------- */
    tokenHub = await startHub("token", { store: tokenStore, tokenKey: TOKEN_KEY });
    check(
      "2 token hub starts and answers /config",
      tokenHub.config.name === "auth-smoke" &&
        tokenHub.config.app === "auth-smoke" &&
        tokenHub.config.auth === "token",
      `config=${detail(JSON.stringify(tokenHub.config))}`,
    );

    /* ------------------------------------------------------------------------------------------
     * 3. a valid read token reads
     * ---------------------------------------------------------------------------------------- */
    const readNotes = await request(`${tokenHub.url}/notes`, { headers: bearer(read.token) });
    check(
      "3 valid read token reads /notes (200)",
      readNotes.status === 200 && Array.isArray(readNotes.json?.notes),
      `status=${readNotes.status} body=${detail(readNotes.text)}`,
    );

    /* ------------------------------------------------------------------------------------------
     * 4. a read token cannot write
     * ---------------------------------------------------------------------------------------- */
    const writeBody = "written by the auth smoke (write token)";
    const denied = await postJson(
      `${tokenHub.url}/notes`,
      { type: "text", intent: "implement", body: writeBody, anchor: { hook: "auth-smoke-write" } },
      bearer(read.token),
    );
    check(
      "4 read token cannot write /notes (403 insufficient_scope)",
      denied.status === 403 && denied.json?.error?.code === "insufficient_scope",
      `status=${denied.status} code=${denied.json?.error?.code ?? "none"} body=${detail(denied.text)}`,
    );

    /* ------------------------------------------------------------------------------------------
     * 5. a write token writes; the read token sees it
     * ---------------------------------------------------------------------------------------- */
    const write = await mint("write-device", "write", 3600);
    cliStreams.push(write.stderr);
    if (write.token !== "") mintedTokens.push(write.token);
    const written = await postJson(
      `${tokenHub.url}/notes`,
      { type: "text", intent: "implement", body: writeBody, anchor: { hook: "auth-smoke-write" } },
      bearer(write.token),
    );
    const afterWrite = await request(`${tokenHub.url}/notes`, { headers: bearer(read.token) });
    const seen = (afterWrite.json?.notes ?? []).some((note) => note.body === writeBody);
    check(
      "5 write token writes (2xx), read token sees the note",
      write.code === 0 &&
        written.status >= 200 &&
        written.status < 300 &&
        typeof written.json?.note?.id === "string" &&
        afterWrite.status === 200 &&
        seen,
      `writeStatus=${written.status} readStatus=${afterWrite.status} seen=${seen} body=${detail(written.text)}`,
    );

    /* ------------------------------------------------------------------------------------------
     * 6. an expired token
     * ---------------------------------------------------------------------------------------- */
    const expiring = await mint("expired-device", "read", 1);
    cliStreams.push(expiring.stderr);
    if (expiring.token !== "") mintedTokens.push(expiring.token);
    await sleep(EXPIRY_WAIT_MS);
    const expired = await request(`${tokenHub.url}/notes`, { headers: bearer(expiring.token) });
    check(
      "6 expired token is refused (401 token_expired)",
      expiring.code === 0 && expired.status === 401 && expired.json?.error?.code === "token_expired",
      `status=${expired.status} code=${expired.json?.error?.code ?? "none"} body=${detail(expired.text)}`,
    );

    /* ------------------------------------------------------------------------------------------
     * 7. a revoked token id
     * ---------------------------------------------------------------------------------------- */
    const revokable = await mint("revoked-device", "read", 3600);
    cliStreams.push(revokable.stderr);
    if (revokable.token !== "") mintedTokens.push(revokable.token);
    const revokedFile = writeJson("revoked.json", [revokable.id]);
    revokedHub = await startHub("revoked", {
      store: revokedStore,
      tokenKey: TOKEN_KEY,
      revokedTokens: revokedFile,
    });
    const revoked = await request(`${revokedHub.url}/notes`, {
      headers: bearer(revokable.token),
    });
    check(
      "7 revoked token id is refused (401 token_revoked)",
      revokable.id.length > 0 &&
        revoked.status === 401 &&
        revoked.json?.error?.code === "token_revoked",
      `id=${revokable.id === "" ? "missing" : "parsed"} status=${revoked.status} code=${revoked.json?.error?.code ?? "none"} body=${detail(revoked.text)}`,
    );

    /* ------------------------------------------------------------------------------------------
     * 8. the shared secret
     * ---------------------------------------------------------------------------------------- */
    secretHub = await startHub("secret", { store: secretStore, authSecret: SHARED_SECRET });
    const noHeader = await request(`${secretHub.url}/notes`);
    const wrongHeader = await request(`${secretHub.url}/notes`, {
      headers: { "x-bluepencil-auth": "wrong-value" },
    });
    const rightHeader = await request(`${secretHub.url}/notes`, {
      headers: { "x-bluepencil-auth": SHARED_SECRET },
    });
    check(
      "8 shared secret: missing 401, wrong 401, right 200",
      noHeader.status === 401 &&
        noHeader.json?.error?.code === "unauthorized" &&
        wrongHeader.status === 401 &&
        wrongHeader.json?.error?.code === "unauthorized" &&
        rightHeader.status === 200 &&
        Array.isArray(rightHeader.json?.notes),
      `missing=${noHeader.status}/${noHeader.json?.error?.code ?? "none"} wrong=${wrongHeader.status}/${wrongHeader.json?.error?.code ?? "none"} right=${rightHeader.status}`,
    );

    /* ------------------------------------------------------------------------------------------
     * 9. /config reports which credential, and never a value
     * ---------------------------------------------------------------------------------------- */
    const tokenConfig = await request(`${tokenHub.url}/config`);
    const secretConfig = await request(`${secretHub.url}/config`);
    const configTexts = [tokenConfig.text, secretConfig.text];
    const leaksConfig = configTexts.some((text) =>
      [TOKEN_KEY, SHARED_SECRET, ...mintedTokens].some((value) => text.includes(value)),
    );
    check(
      '9 /config reports auth "token" / "secret" and contains no credential',
      tokenConfig.status === 200 &&
        tokenConfig.json?.auth === "token" &&
        secretConfig.status === 200 &&
        secretConfig.json?.auth === "secret" &&
        !leaksConfig,
      `tokenAuth=${tokenConfig.json?.auth} secretAuth=${secretConfig.json?.auth} leaks=${leaksConfig} body=${detail(tokenConfig.text)}`,
    );

    /* ------------------------------------------------------------------------------------------
     * 10. the /mcp door shares the same gate
     * ---------------------------------------------------------------------------------------- */
    const initialized = await mcp(
      `${tokenHub.url}/mcp`,
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "auth-smoke", version: "1.0.0" },
      },
      bearer(read.token),
    );
    check(
      "10a /mcp initialize with a read token returns a result",
      initialized.status === 200 && initialized.json?.result !== undefined,
      `status=${initialized.status} body=${detail(initialized.text)}`,
    );

    const tools = await mcp(`${tokenHub.url}/mcp`, "tools/list", {}, bearer(read.token));
    const toolNames = (tools.json?.result?.tools ?? []).map((tool) => tool.name);
    check(
      "10b /mcp tools/list with a read token lists the tools",
      tools.status === 200 && toolNames.includes("list_notes") && toolNames.length > 0,
      `status=${tools.status} tools=${toolNames.length} body=${detail(tools.text)}`,
    );

    const listed = await mcp(
      `${tokenHub.url}/mcp`,
      "tools/call",
      { name: "list_notes", arguments: { include_done: true } },
      bearer(read.token),
    );
    const listedBody = toolJson(listed.json);
    check(
      "10c /mcp tools/call list_notes with a read token returns the note set",
      listed.status === 200 &&
        listed.json?.result?.isError !== true &&
        Array.isArray(listedBody?.notes) &&
        listedBody.notes.some((note) => note.body === writeBody),
      `status=${listed.status} notes=${listedBody?.notes?.length ?? "none"} body=${detail(listed.text)}`,
    );

    const unauthenticated = await mcp(`${tokenHub.url}/mcp`, "tools/list", {});
    check(
      "10d /mcp without a token is refused (401 unauthorized)",
      unauthenticated.status === 401 && unauthenticated.json?.error?.code === "unauthorized",
      `status=${unauthenticated.status} code=${unauthenticated.json?.error?.code ?? "none"} body=${detail(unauthenticated.text)}`,
    );

    // `needsWrite` reads the tool definition, so the gate demands a write-scoped token for this
    // message: case 10f proves the read token is refused here too (the same door, not just /notes),
    // and 10e proves the write token gets through the MCP write path itself.
    const created = await mcp(
      `${tokenHub.url}/mcp`,
      "tools/call",
      {
        name: "create_note",
        arguments: { body: "created through the MCP door", hook: "auth-smoke-mcp" },
      },
      bearer(write.token),
    );
    const createdBody = toolJson(created.json);
    check(
      "10e /mcp tools/call create_note with a write token creates the note",
      created.status === 200 &&
        created.json?.result?.isError !== true &&
        typeof createdBody?.created?.id === "string",
      `status=${created.status} body=${detail(created.text)}`,
    );

    // The MCP door must enforce the write scope itself: calling a writing tool with a read token is
    // a 403 at the door, not a tool-level `isError` and not a request that slips through.
    const deniedMcp = await mcp(
      `${tokenHub.url}/mcp`,
      "tools/call",
      {
        name: "create_note",
        arguments: { body: "must not be created through the MCP door", hook: "auth-smoke-mcp-denied" },
      },
      bearer(read.token),
    );
    check(
      "10f /mcp tools/call create_note with a read token is refused (403 insufficient_scope)",
      deniedMcp.status === 403 && deniedMcp.json?.error?.code === "insufficient_scope",
      `status=${deniedMcp.status} code=${deniedMcp.json?.error?.code ?? "none"} body=${detail(deniedMcp.text)}`,
    );

    // A present-but-wrong bearer token is a different case from a missing one: the verifier rejects
    // the signature and the handler answers 401 `unauthorized` (not `insufficient_scope`, which
    // would claim the credential were valid).
    const wrongToken = await mcp(
      `${tokenHub.url}/mcp`,
      "tools/list",
      {},
      bearer("not-a-token-this-hub-ever-signed"),
    );
    check(
      "10g /mcp with a wrong bearer token is refused (401 unauthorized)",
      wrongToken.status === 401 && wrongToken.json?.error?.code === "unauthorized",
      `status=${wrongToken.status} code=${wrongToken.json?.error?.code ?? "none"} body=${detail(wrongToken.text)}`,
    );

    /* ------------------------------------------------------------------------------------------
     * 11. secret hygiene
     * ---------------------------------------------------------------------------------------- */
    const hubStreams = [tokenHub.output(), revokedHub.output(), secretHub.output()];
    const haystack = [...hubStreams, ...cliStreams];
    const leaked = [TOKEN_KEY, SHARED_SECRET, ...mintedTokens].filter((value) =>
      haystack.some((text) => text.includes(value)),
    );
    check(
      "11 no hub or CLI stderr stream contains a key, the secret or a minted token",
      leaked.length === 0,
      `${leaked.length} credential(s) found in captured output`,
    );
  } catch (error) {
    failures += 1;
    cases += 1;
    console.log(`FAIL runner (threw): ${detail(error instanceof Error ? error.message : error)}`);
    if (error instanceof Error && error.stack) {
      console.log(redact(error.stack));
    }
  } finally {
    for (const child of [...children]) {
      await stopChild(child);
    }
    console.log(
      `\nauth-smoke: ${cases - failures}/${cases} case(s) passed, fixtures in ${workspace.replace(`${root}/`, "")}`,
    );
  }

  process.exit(failures === 0 ? 0 : 1);
}

await main();
