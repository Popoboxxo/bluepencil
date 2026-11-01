#!/usr/bin/env node
/**
 * Docker/Compose end-to-end smoke: the shipped image, two leaf hubs and an aggregating hub.
 *
 * `scripts/federation-smoke.mjs` proves federation against processes on this host. This script
 * proves the part that only a container can answer: that the image starts as documented, that a
 * bind-mounted store works for a non-root `user:`, that the registry file gate (0600 + owner ==
 * process uid) passes through a bind mount, and that `--registry --no-self --allow-insecure`
 * aggregates two real containers over the Compose network.
 *
 * Shape (mirrors examples/federation/docker-compose.yml):
 *
 *   hub-dev, hub-staging   leaf hubs, each with its own bind-mounted /data and published loopback
 *                          port; their shared secret is handed in, so no credential is generated.
 *   hub-aggregator         the bin wrapper (`bluepencil-hub`), `--registry --no-self --read-only
 *                          --allow-insecure`, registry mounted read-only; only its `/mcp` fans out.
 *
 * Run it after `npm run build` (the image is built from the checkout when it is not cached):
 *   node scripts/docker-smoke.mjs
 *   BP_REQUIRE_DOCKER=1 node scripts/docker-smoke.mjs   # CI: no Docker is a failure, not a skip
 *
 * Fixtures live in `.tmp/docker-smoke/` (git-ignored) and are reset on every run. Every wait has a
 * hard timeout, every container/volume/network is removed in `finally`, and generated credentials
 * are never printed — not by the run summary, not in failure logs (they are redacted).
 *
 * Constraints this proves are real, not weakened:
 *   - the registry gate compares the file's owner with the *process* uid, so the composition runs
 *     with `user: "<host uid>:<host gid>"` and asserts the file's owner up front;
 *   - `--allow-insecure` is what admits plain http to the private Compose network;
 *   - `--no-self` keeps the aggregator's own (empty) store out of the `/mcp` aggregate.
 *
 * Environment: BP_REQUIRE_DOCKER=1 turns an unavailable Docker daemon into a failure. Without it an
 * unavailable daemon exits with SKIP_EXIT_CODE (77), so a matrix runner can tell a self-skip apart
 * from a green run instead of treating "nothing executed" as a pass.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Every run owns its workspace. A fixed directory would let two concurrent runs overwrite each
 * other's registry/compose file (and quietly reuse a previous run's stores); the unique suffix also
 * keeps failure forensics possible without guessing which run produced a directory.
 */
const runId = `${process.pid}-${uniqueSuffix()}`;
const workspace = join(root, ".tmp", "docker-smoke", runId);
const composePath = join(workspace, "docker-compose.yml");
const registryPath = join(workspace, "instances.json");

const IMAGE = `bluepencil-e2e:${runId}`;
/** The only fields `list_instances` may publish for a healthy peer (see `publicInstance`). */
const INSTANCE_FIELDS = ["app", "environment", "id", "mode", "ok", "version"];
const BASE = "/api/v1/bluepencil";
const AUTH_HEADER = "x-bluepencil-auth";
const STARTUP_TIMEOUT_MS = 90_000;
const BUILD_TIMEOUT_MS = 600_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** How long a child process gets to honour SIGTERM before its process group is SIGKILLed. */
const KILL_GRACE_MS = 5_000;
/**
 * `EX_SKIP`-style exit code for a whole-run skip (no Docker daemon). It is deliberately non-zero:
 * a runner must not report "pass" for a suite that executed nothing. `BP_REQUIRE_DOCKER=1` (CI)
 * still turns the same condition into exit 1.
 */
const SKIP_EXIT_CODE = 77;

/* ------------------------------------------------------------------------------------------------
 * Bookkeeping
 * ---------------------------------------------------------------------------------------------- */

let checks = 0;
let failures = 0;

/** Credentials generated for this run. Never printed; scrubbed from every message below. */
const secrets = [];

function redact(text) {
  let result = String(text);
  for (const secret of secrets) {
    if (secret.length > 0) result = result.split(secret).join("<redacted>");
  }
  return result;
}

function check(name, ok, detail) {
  checks += 1;
  const line = `${ok ? "PASS" : "FAIL"} ${name}: ${redact(detail)}`;
  if (ok) {
    console.log(line);
  } else {
    failures += 1;
    console.log(line);
  }
}

function firstLine(text) {
  const line = String(text).split("\n").map((entry) => entry.trim()).find((entry) => entry !== "");
  return line ?? "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------------------------------------
 * Process runner: captured output, hard timeout, opt-in tolerance for a non-zero exit
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every child `run()` currently owns. A signal handler must be able to stop an in-flight
 * `docker build`/`compose up` before it tears the project down — otherwise the command can create a
 * container or network *after* `compose down` finished, and the cleanup proof becomes a lie.
 */
const activeChildren = new Set();

/** Signals the whole process group: `detached` children get their own group, grandchildren included. */
function killProcessTree(child, signal) {
  if (child === null || child === undefined || child.pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      /* the group is already gone — fall through to the direct child */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* already dead */
  }
}

/** Resolves `true` when the child ended within `ms`, `false` on timeout. */
function waitForChildExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => {
      child.removeListener("close", onClose);
      resolveWait(false);
    }, ms);
    const onClose = () => {
      clearTimeout(timer);
      resolveWait(true);
    };
    child.once("close", onClose);
  });
}

/** Stops every child `run()` still owns, group-wide, with a SIGKILL fallback. */
async function stopActiveChildren(signal = "SIGTERM") {
  const children = [...activeChildren];
  for (const child of children) killProcessTree(child, signal);
  const stubborn = [];
  for (const child of children) {
    if (!(await waitForChildExit(child, KILL_GRACE_MS))) stubborn.push(child);
  }
  for (const child of stubborn) killProcessTree(child, "SIGKILL");
  await Promise.all(stubborn.map((child) => waitForChildExit(child, KILL_GRACE_MS)));
}

function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd ?? root,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        // A separate process group lets the signal handler stop the whole command tree (docker CLI
        // helpers included), not just the direct child.
        detached: process.platform !== "win32",
      });
    } catch (error) {
      reject(error);
      return;
    }
    activeChildren.add(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      killProcessTree(child, "SIGKILL");
      reject(new Error(`${command} ${args.slice(0, 2).join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      activeChildren.delete(child);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = { code, signal, stdout, stderr };
      if (code !== 0 && options.allowFailure !== true) {
        const tail = firstLine(stderr) || firstLine(stdout) || "no output";
        reject(
          new Error(
            `${command} ${args.slice(0, 2).join(" ")} exited ${code === null ? signal : code}: ${tail.slice(0, 300)}`,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}

/* ------------------------------------------------------------------------------------------------
 * Docker availability
 * ---------------------------------------------------------------------------------------------- */

async function dockerUnavailableReason() {
  try {
    const info = await run("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeoutMs: 30_000,
      allowFailure: true,
    });
    if (info.code !== 0) {
      return `docker info failed (${firstLine(info.stderr) || `exit ${info.code}`})`;
    }
    const compose = await run("docker", ["compose", "version", "--short"], {
      timeoutMs: 20_000,
      allowFailure: true,
    });
    if (compose.code !== 0) {
      return `docker compose is not available (${firstLine(compose.stderr) || `exit ${compose.code}`})`;
    }
    return null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "docker is not on PATH";
    }
    return error instanceof Error ? error.message : String(error);
  }
}

/* ------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

function uniqueSuffix() {
  return randomBytes(4).toString("hex");
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function uniqueFreePorts(count) {
  const ports = new Set();
  while (ports.size < count) ports.add(await freePort());
  return [...ports];
}

/** A YAML scalar for the generated file. `JSON.stringify` produces valid double-quoted YAML. */
function yaml(value) {
  return JSON.stringify(String(value));
}

function leafService({ name, port, dataDir, store, environment, secret }) {
  return [
    `  ${name}:`,
    `    image: ${yaml(IMAGE)}`,
    `    container_name: ${yaml(containerName(name))}`,
    `    user: ${yaml(`${process.getuid()}:${process.getgid()}`)}`,
    "    ports:",
    `      - ${yaml(`127.0.0.1:${port}:8787`)}`,
    "    volumes:",
    `      - ${yaml(`./${dataDir}:/data`)}`,
    "    environment:",
    `      BLUEPENCIL_STORE: ${yaml(store)}`,
    `      BLUEPENCIL_NAME: ${yaml(`smoke-${environment}`)}`,
    `      BLUEPENCIL_APP: ${yaml("smoke")}`,
    `      BLUEPENCIL_ENVIRONMENT: ${yaml(environment)}`,
    `      BLUEPENCIL_AUTH_SECRET: ${yaml(secret)}`,
    "    healthcheck:",
    '      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8787/api/v1/bluepencil/health"]',
    "      interval: 2s",
    "      timeout: 2s",
    "      retries: 30",
    "      start_period: 2s",
  ].join("\n");
}

function containerName(service) {
  return `${project}-${service}`;
}

function composeDocument({ project, devPort, stagingPort, aggregatorPort }) {
  const lines = [
    "# Generated by scripts/docker-smoke.mjs — do not edit, do not commit (.tmp/ is git-ignored).",
    `name: ${yaml(project)}`,
    "services:",
    leafService({
      name: "hub-dev",
      port: devPort,
      dataDir: "dev-data",
      store: "/data/dev.json",
      environment: "dev",
      secret: devSecret,
    }),
    leafService({
      name: "hub-staging",
      port: stagingPort,
      dataDir: "staging-data",
      store: "/data/staging.json",
      environment: "staging",
      secret: stagingSecret,
    }),
    "  hub-aggregator:",
    `    image: ${yaml(IMAGE)}`,
    `    container_name: ${yaml(containerName("hub-aggregator"))}`,
    `    user: ${yaml(`${process.getuid()}:${process.getgid()}`)}`,
    // The bin wrapper, not the credential-bootstrapping entrypoint: the aggregator supplies its
    // own --store/--host/--port and has no volume to keep a generated secret in.
    '    entrypoint: ["/usr/local/bin/bluepencil-hub"]',
    "    command:",
    '      - "--store"',
    '      - "/tmp/aggregator.json"',
    '      - "--host"',
    '      - "0.0.0.0"',
    '      - "--port"',
    '      - "8787"',
    '      - "--base"',
    `      - ${yaml(BASE)}`,
    '      - "--name"',
    '      - "hub-aggregator"',
    '      - "--app"',
    '      - "smoke"',
    '      - "--registry"',
    '      - "/etc/bluepencil/instances.json"',
    '      - "--no-self"',
    '      - "--read-only"',
    '      - "--allow-insecure"',
    "    ports:",
    `      - ${yaml(`127.0.0.1:${aggregatorPort}:8787`)}`,
    "    volumes:",
    '      - "./instances.json:/etc/bluepencil/instances.json:ro"',
    "    environment:",
    `      BP_DEV_TOKEN: ${yaml(devSecret)}`,
    `      BP_STAGING_TOKEN: ${yaml(stagingSecret)}`,
    "    depends_on:",
    "      hub-dev:",
    "        condition: service_healthy",
    "      hub-staging:",
    "        condition: service_healthy",
    "    healthcheck:",
    '      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8787/api/v1/bluepencil/health"]',
    "      interval: 2s",
    "      timeout: 2s",
    "      retries: 30",
    "      start_period: 2s",
  ];
  return `${lines.join("\n")}\n`;
}

/* ------------------------------------------------------------------------------------------------
 * HTTP helpers
 * ---------------------------------------------------------------------------------------------- */

function baseUrl(port) {
  return `http://127.0.0.1:${port}${BASE}`;
}

async function fetchWithTimeout(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

async function waitForConfig(label, port) {
  const url = `${baseUrl(port)}/config`;
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let last = "no attempt";
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(url);
      if (response.ok) {
        return await response.json();
      }
      last = `HTTP ${response.status}`;
      await response.text();
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`${label}: /config did not answer within ${STARTUP_TIMEOUT_MS}ms (${last})`);
}

async function listNotes(base, headers = {}) {
  const response = await fetchWithTimeout(`${base}/notes?includeDone=true`, { headers });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, ok: response.ok, body, text };
}

/** One JSON-RPC exchange over the hub's `POST {base}/mcp` door. */
async function mcpRequest(base, method, params = {}) {
  const response = await fetchWithTimeout(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  let frame = null;
  try {
    frame = JSON.parse(text);
  } catch {
    frame = null;
  }
  return { status: response.status, ok: response.ok, frame, text };
}

/** The JSON payload of an MCP tool result (the tools answer with one text content block). */
function toolText(frame) {
  const result = frame?.result ?? frame;
  return (result?.content ?? []).map((entry) => entry.text ?? "").join("\n");
}

/* ------------------------------------------------------------------------------------------------
 * Compose lifecycle
 * ---------------------------------------------------------------------------------------------- */

function composeArgs(...args) {
  return ["compose", "-p", project, "-f", composePath, ...args];
}

async function composeUp() {
  await run("docker", composeArgs("up", "-d", "--remove-orphans"), { timeoutMs: 180_000 });
}

/**
 * A `docker … ls` result. `ok` is the whole point: an empty list after a *failed* listing command
 * is not evidence of an empty project, so callers must gate any "nothing is left" conclusion on
 * `ok` instead of treating non-zero as "no resources".
 */
async function dockerNameList(args) {
  let result;
  try {
    result = await run("docker", args, { timeoutMs: 30_000, allowFailure: true });
  } catch (error) {
    // `run()` rejects on a spawn failure or a timeout. `verifyCleanup()` runs in `finally`; a
    // rejection there would become an unhandled rejection instead of the named listing check, so
    // the failure is folded into the same `{ ok: false }` shape a non-zero exit produces. The
    // caller stays fail-safe: `listingsOk` is false and the cleanup checks turn red.
    return {
      ok: false,
      code: null,
      signal: null,
      stderr: error instanceof Error ? error.message : String(error),
      lines: [],
    };
  }
  const ok = result.code === 0;
  return {
    ok,
    code: result.code,
    signal: result.signal,
    stderr: result.stderr,
    lines: ok
      ? result.stdout
          .split("\n")
          .map((entry) => entry.trim())
          .filter((entry) => entry !== "")
      : [],
  };
}

/**
 * The generated files carry plaintext credentials (the compose environment block hands in both leaf
 * secrets) or peer wiring; neither may survive the run, including a failed one.
 */
function removeCredentialFiles() {
  rmSync(composePath, { force: true });
  rmSync(registryPath, { force: true });
}

async function cleanupContainers() {
  await run("docker", composeArgs("down", "-v", "--remove-orphans", "--timeout", "10"), {
    timeoutMs: 120_000,
    allowFailure: true,
  });
  for (const service of ["hub-dev", "hub-staging", "hub-aggregator"]) {
    await run("docker", ["rm", "-f", containerName(service)], {
      timeoutMs: 30_000,
      allowFailure: true,
    });
  }
  const volumes = await dockerNameList(["volume", "ls", "--format", "{{.Name}}"]);
  if (!volumes.ok) {
    console.log(
      `docker-smoke: cleanup warning: docker volume ls exited ${volumes.code ?? volumes.signal}; ` +
        "leftover volumes are still checked after cleanup",
    );
  }
  for (const name of volumes.lines.filter((name) => name.startsWith(`${project}_`))) {
    await run("docker", ["volume", "rm", "-f", name], { timeoutMs: 30_000, allowFailure: true });
  }
  const networks = await dockerNameList(["network", "ls", "--format", "{{.Name}}"]);
  if (!networks.ok) {
    console.log(
      `docker-smoke: cleanup warning: docker network ls exited ${networks.code ?? networks.signal}; ` +
        "leftover networks are still checked after cleanup",
    );
  }
  for (const name of networks.lines.filter(
    (name) => name === project || name.startsWith(`${project}_`),
  )) {
    await run("docker", ["network", "rm", name], { timeoutMs: 30_000, allowFailure: true });
  }
  // The image tag is per run (`bluepencil-e2e:<runId>`), so removing it cannot disturb a parallel
  // run and no run silently reuses a previous run's stale image.
  await run("docker", ["rmi", "-f", IMAGE], { timeoutMs: 60_000, allowFailure: true });
}

/**
 * `finally` and the signal handlers share one idempotent cleanup: whichever runs first wins, the
 * other awaits the same promise. Without that, a SIGINT arriving during `finally` would start a
 * second `docker compose down` while the first is still walking the project.
 */
let cleanupPromise = null;

function cleanup() {
  if (cleanupPromise === null) {
    cleanupPromise = (async () => {
      // `cleanup()` never throws: `finally` and the signal path must reach `removeCredentialFiles()`
      // even when `compose down` rejects or a listing command fails. A failure is logged, then the
      // credential files are scrubbed unconditionally.
      try {
        await cleanupContainers();
      } catch (error) {
        console.log(
          `docker-smoke: cleanup warning: ${redact(error instanceof Error ? error.message : String(error))}`,
        );
      } finally {
        try {
          removeCredentialFiles();
        } catch (error) {
          console.log(
            `docker-smoke: cleanup warning (credential files): ${redact(
              error instanceof Error ? error.message : String(error),
            )}`,
          );
        }
      }
    })();
  }
  return cleanupPromise;
}

/**
 * An aborted run must leave no containers, volumes or networks — and no credential files. A running
 * `docker build`/`compose up` is stopped (group-wide) and awaited *before* `cleanup()`: otherwise it
 * can still create a container or network after `compose down` already ran.
 */
let signalExitCode = null;

function installSignalHandlers() {
  for (const [signal, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    process.on(signal, () => {
      // Idempotent: a repeated Ctrl-C must not start a second teardown or hard-exit mid-cleanup.
      if (signalExitCode !== null) return;
      signalExitCode = exitCode;
      console.log(`\ndocker-smoke: ${signal} received — stopping the running command and cleaning up project ${project}`);
      void (async () => {
        try {
          await stopActiveChildren("SIGTERM");
        } catch (error) {
          console.log(
            `docker-smoke: could not stop the running command: ${redact(
              error instanceof Error ? error.message : String(error),
            )}`,
          );
        }
        await cleanup();
        // The abort path runs concurrently with `finally`, which may have started diagnostic
        // commands of its own; reap those too before exiting.
        await stopActiveChildren("SIGTERM");
        process.exit(exitCode);
      })();
    });
  }
}

/**
 * An aborted run must leave no containers, volumes or networks — and no credential files. Returns
 * whether the credential files are verifiably gone, so the kept-workspace message can be tied to
 * the observed result instead of asserting it.
 */
async function verifyCleanup() {
  const byLabel = await dockerNameList([
    "ps",
    "-a",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--format",
    "{{.Names}}",
  ]);
  const allContainers = await dockerNameList(["ps", "-a", "--format", "{{.Names}}"]);
  const volumeList = await dockerNameList(["volume", "ls", "--format", "{{.Name}}"]);
  const networkList = await dockerNameList(["network", "ls", "--format", "{{.Name}}"]);

  const listings = [
    ["containers by compose label", byLabel],
    ["all containers", allContainers],
    ["volumes", volumeList],
    ["networks", networkList],
  ];
  const failedListings = listings.filter(([, listing]) => !listing.ok);
  const listingsOk = failedListings.length === 0;
  check(
    "cleanup resource listings succeeded",
    listingsOk,
    listingsOk
      ? `${listings.length} listing(s) exit 0`
      : failedListings
          .map(
            ([label, listing]) =>
              `${label} exit ${listing.code ?? listing.signal}: ${firstLine(listing.stderr) || "no output"}`,
          )
          .join("; "),
  );

  const containers = [
    ...new Set([
      ...byLabel.lines,
      ...allContainers.lines.filter((name) => name.startsWith(`${project}-`)),
    ]),
  ];
  const volumes = volumeList.lines.filter((name) => name.startsWith(`${project}_`));
  const networks = networkList.lines.filter(
    (name) => name === project || name.startsWith(`${project}_`),
  );

  // "No resources" may only be concluded from a *successful* listing: a failed `docker ps` must
  // turn this red instead of being read as "nothing there".
  check(
    "cleanup leaves no containers for the project",
    listingsOk && containers.length === 0,
    !listingsOk
      ? "listing failed — cannot claim the project is clean"
      : containers.length === 0
        ? "none"
        : containers.join(", "),
  );
  check(
    "cleanup leaves no volumes or networks for the project",
    listingsOk && volumes.length === 0 && networks.length === 0,
    !listingsOk
      ? "listing failed — cannot claim the project is clean"
      : volumes.length === 0 && networks.length === 0
        ? "none"
        : `volumes=[${volumes.join(", ")}] networks=[${networks.join(", ")}]`,
  );

  // `removeCredentialFiles()` deliberately does not throw (the `finally` path must reach it), so a
  // failed `rmSync` would otherwise be a logged warning inside a green run — with plaintext secrets
  // still on disk. The check is the actual proof, not the removal call having been made.
  const credentialFiles = [composePath, registryPath];
  const remainingCredentials = credentialFiles.filter((path) => existsSync(path));
  const credentialsRemoved = remainingCredentials.length === 0;
  check(
    "credential files removed",
    credentialsRemoved,
    credentialsRemoved
      ? `${credentialFiles.length} file(s) absent`
      : `still present: ${remainingCredentials.map((path) => relative(root, path)).join(", ")}`,
  );
  return credentialsRemoved;
}

/** Diagnostics on failure only. Compose logs never carry the generated secrets (they were handed
 *  in), but they are redacted anyway because that invariant must not depend on the entrypoint. */
async function dumpLogs() {
  // The abort path removes the credential-bearing compose file before `finally` runs; with no
  // compose file there is nothing to read, and the errors would only add noise to an abort.
  if (!existsSync(composePath)) return;
  for (const service of ["hub-dev", "hub-staging", "hub-aggregator"]) {
    const logs = await run("docker", composeArgs("logs", "--no-color", "--tail", "40", service), {
      timeoutMs: 30_000,
      allowFailure: true,
    });
    const text = redact(`${logs.stdout}${logs.stderr}`).trim();
    if (text !== "") {
      console.log(`--- logs ${service} ---\n${text}`);
    }
  }
}

/* ------------------------------------------------------------------------------------------------
 * Cases
 * ---------------------------------------------------------------------------------------------- */

async function runCases({ devPort, stagingPort, aggregatorPort }) {
  const devBase = baseUrl(devPort);
  const stagingBase = baseUrl(stagingPort);
  const aggregatorBase = baseUrl(aggregatorPort);
  const auth = { [AUTH_HEADER]: devSecret };

  const devConfig = await waitForConfig("hub-dev", devPort);
  const stagingConfig = await waitForConfig("hub-staging", stagingPort);

  // The registry gate compares the file's owner with the *process* uid, so the documented
  // "runs as the host uid" claim has to be observed, not assumed from `user:` in the compose file.
  const devUid = (await run("docker", ["exec", containerName("hub-dev"), "id", "-u"], {
    timeoutMs: 30_000,
  })).stdout.trim();
  const devGid = (await run("docker", ["exec", containerName("hub-dev"), "id", "-g"], {
    timeoutMs: 30_000,
  })).stdout.trim();
  check(
    "hub-dev container runs as the host uid/gid",
    devUid === String(process.getuid()) && devGid === String(process.getgid()),
    `uid=${devUid} gid=${devGid}, host ${process.getuid()}:${process.getgid()}`,
  );

  // Both leaf hubs are documented to run as the host uid; asserting only the first would let a
  // half-applied `user:` (e.g. only on one service) pass unnoticed.
  const stagingUid = (await run("docker", ["exec", containerName("hub-staging"), "id", "-u"], {
    timeoutMs: 30_000,
  })).stdout.trim();
  const stagingGid = (await run("docker", ["exec", containerName("hub-staging"), "id", "-g"], {
    timeoutMs: 30_000,
  })).stdout.trim();
  check(
    "hub-staging container runs as the host uid/gid",
    stagingUid === String(process.getuid()) && stagingGid === String(process.getgid()),
    `uid=${stagingUid} gid=${stagingGid}, host ${process.getuid()}:${process.getgid()}`,
  );

  check(
    "hub-dev /config reports auth:secret and its identity",
    devConfig.auth === "secret" &&
      devConfig.app === "smoke" &&
      devConfig.environment === "dev" &&
      devConfig.name === "smoke-dev",
    `auth=${devConfig.auth} app=${devConfig.app} environment=${devConfig.environment} name=${devConfig.name}`,
  );
  check(
    "hub-staging /config reports auth:secret and its identity",
    stagingConfig.auth === "secret" &&
      stagingConfig.app === "smoke" &&
      stagingConfig.environment === "staging" &&
      stagingConfig.name === "smoke-staging",
    `auth=${stagingConfig.auth} app=${stagingConfig.app} environment=${stagingConfig.environment} name=${stagingConfig.name}`,
  );

  const unauthenticated = await listNotes(devBase);
  check(
    "leaf GET /notes without the credential is 401",
    unauthenticated.status === 401,
    `HTTP ${unauthenticated.status}`,
  );

  const authenticated = await listNotes(devBase, auth);
  check(
    "leaf GET /notes with x-bluepencil-auth is 200",
    authenticated.status === 200 && Array.isArray(authenticated.body?.notes),
    `HTTP ${authenticated.status} notes=${authenticated.body?.notes?.length ?? "?"}`,
  );

  const body = `docker-smoke: leaf write ${project}`;
  const created = await fetchWithTimeout(`${devBase}/notes`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      type: "text",
      intent: "implement",
      body,
      anchor: { hook: "docker-smoke" },
    }),
  });
  const createdText = await created.text();
  check(
    "leaf POST /notes with the credential returns 2xx",
    created.ok,
    `HTTP ${created.status}`,
  );

  const afterWrite = await listNotes(devBase, auth);
  const notes = afterWrite.body?.notes ?? [];
  check(
    "leaf GET /notes returns the written note",
    afterWrite.status === 200 && notes.some((note) => String(note.body ?? "") === body),
    `HTTP ${afterWrite.status} ids=${notes.map((note) => note.id).join(", ") || "(none)"} created=${createdText.slice(0, 80)}`,
  );

  const aggregatorConfig = await waitForConfig("hub-aggregator", aggregatorPort);
  check(
    "aggregator /config answers and reports federates:true",
    aggregatorConfig.federates === true &&
      aggregatorConfig.app === "smoke" &&
      aggregatorConfig.name === "hub-aggregator" &&
      aggregatorConfig.readOnly === true,
    `federates=${aggregatorConfig.federates} app=${aggregatorConfig.app} readOnly=${aggregatorConfig.readOnly}`,
  );

  const aggregatorNotes = await listNotes(aggregatorBase);
  check(
    "aggregator /notes stays empty (--no-self: its own store is not a source)",
    aggregatorNotes.status === 200 && (aggregatorNotes.body?.notes ?? []).length === 0,
    `HTTP ${aggregatorNotes.status} notes=${aggregatorNotes.body?.notes?.length ?? "?"}`,
  );

  const init = await mcpRequest(aggregatorBase, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "docker-smoke", version: "1.0.0" },
  });
  check(
    "aggregator POST /mcp initialize answers 200 with a federated serverInfo",
    init.status === 200 && init.frame?.result?.serverInfo?.name === "bluepencil-federator",
    `HTTP ${init.status} serverInfo=${init.frame?.result?.serverInfo?.name ?? "(none)"}`,
  );

  const tools = await mcpRequest(aggregatorBase, "tools/list", {});
  const toolNames = (tools.frame?.result?.tools ?? []).map((entry) => entry.name);
  check(
    "aggregator tools/list includes list_instances",
    tools.status === 200 && toolNames.includes("list_instances"),
    `HTTP ${tools.status} tools=${toolNames.length} hasListInstances=${toolNames.includes("list_instances")}`,
  );

  const listed = await mcpRequest(aggregatorBase, "tools/call", {
    name: "list_instances",
    arguments: {},
  });
  let rows = null;
  try {
    rows = JSON.parse(toolText(listed.frame));
  } catch {
    rows = null;
  }
  const instances = Array.isArray(rows) ? rows : [];
  const ids = instances.map((row) => row.id).sort();
  check(
    "tools/call list_instances reports exactly the two leaf peers",
    listed.status === 200 &&
      instances.length === 2 &&
      ids.join(",") === "dev,staging" &&
      instances.every((row) => row.ok === true && row.app === "smoke"),
    `HTTP ${listed.status} instances=${instances.map((row) => `${row.id}:${row.ok ? "ok" : row.code ?? "not-ok"}`).join(", ") || "(none)"}`,
  );
  const publishedFields = [
    ...new Set(instances.flatMap((row) => Object.keys(row))),
  ].sort();
  const exactFields =
    instances.length > 0 &&
    instances.every((row) => {
      const keys = Object.keys(row).sort();
      return (
        keys.length === INSTANCE_FIELDS.length &&
        keys.every((key, index) => key === INSTANCE_FIELDS[index])
      );
    });
  check(
    "list_instances publishes exactly the allowed fields",
    exactFields,
    `expected=${INSTANCE_FIELDS.join(",")} observed=${publishedFields.join(",") || "(no rows)"}`,
  );

  // An exact key set already excludes `base`/`auth`, but a value could still smuggle a credential
  // in; both leaf secrets are checked against every published value.
  const leaked = instances.some((row) =>
    Object.values(row).some((value) => {
      const text = String(value);
      return text.includes(devSecret) || text.includes(stagingSecret);
    }),
  );
  check(
    "list_instances values contain no leaf secret",
    instances.length > 0 && !leaked,
    instances.length === 0 ? "no rows" : leaked ? "a leaf secret is present" : "no secret in any value",
  );
}

/* ------------------------------------------------------------------------------------------------
 * Main
 * ---------------------------------------------------------------------------------------------- */

let project = "";
let devSecret = "";
let stagingSecret = "";

/**
 * Never trust a cached tag: a Dockerfile or entrypoint regression is only visible when the build
 * runs. Layer caching makes this cheap after the first run, and the budget stays at ten minutes.
 */
async function ensureImage() {
  console.log(`image: building/refreshing ${IMAGE} via docker build (layer cache, up to 10 min)`);
  // The check carries the observed exit code, not a literal: a failing Dockerfile has to turn this
  // named case red on its own instead of surfacing only through the generic "runner threw" path.
  const build = await run("docker", ["build", "--quiet", "-t", IMAGE, "."], {
    timeoutMs: BUILD_TIMEOUT_MS,
    allowFailure: true,
  });
  const built = build.code === 0;
  check(
    "docker image builds/refreshes from this checkout",
    built,
    built
      ? `${IMAGE} exit 0`
      : `${IMAGE} exit ${build.code ?? build.signal}: ${(firstLine(build.stderr) || firstLine(build.stdout) || "no output").slice(0, 300)}`,
  );
  return built;
}

async function main() {
  const unavailable = await dockerUnavailableReason();
  if (unavailable !== null) {
    if (process.env.BP_REQUIRE_DOCKER === "1") {
      console.log(`FAIL docker: ${unavailable}`);
      return 1;
    }
    console.log(`SKIP docker: ${unavailable}`);
    // Not a pass: nothing ran. The matrix runner maps this code to a visible `skip` status.
    return SKIP_EXIT_CODE;
  }

  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    console.log("FAIL docker: this smoke needs a POSIX host with process.getuid()/getgid()");
    return 1;
  }

  // Fresh per-run fixture directory: no run ever reuses a previous registry, store or compose file
  // (and `.tmp/` is git-ignored).
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });

  project = `bp-smoke-${runId}`;
  devSecret = randomBytes(24).toString("hex");
  stagingSecret = randomBytes(24).toString("hex");
  secrets.push(devSecret, stagingSecret);

  // Installed before anything is created: an abort at any later point still removes the project.
  installSignalHandlers();

  const [devPort, stagingPort, aggregatorPort] = await uniqueFreePorts(3);

  try {
    const imageReady = await ensureImage();
    // Nothing below can succeed without a refreshed image, and the named build case above already
    // carries the failure: stop here instead of restating it as a generic "runner threw" error.
    if (!imageReady) return 1;

    mkdirSync(join(workspace, "dev-data"), { recursive: true });
    mkdirSync(join(workspace, "staging-data"), { recursive: true });

    writeFileSync(
      registryPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          defaults: { mode: "read", timeoutMs: 3000 },
          instances: [
            {
              id: "dev",
              base: `http://hub-dev:8787${BASE}`,
              app: "smoke",
              mode: "read",
              auth: { env: "BP_DEV_TOKEN" },
            },
            {
              id: "staging",
              base: `http://hub-staging:8787${BASE}`,
              app: "smoke",
              mode: "read",
              auth: { env: "BP_STAGING_TOKEN" },
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    // The registry is a security boundary: any group/world bit is `invalid_registry`, and the
    // owner must be the process uid. The containers run as that uid, so the bind mount keeps the
    // gate satisfied without a chown.
    chmodSync(registryPath, 0o600);
    const registryStat = statSync(registryPath);
    if ((registryStat.mode & 0o777) !== 0o600) {
      throw new Error(`registry fixture mode is ${(registryStat.mode & 0o777).toString(8)}, expected 600`);
    }
    if (registryStat.uid !== process.getuid()) {
      throw new Error(
        `registry fixture owner is uid ${registryStat.uid}, expected the process uid ${process.getuid()}`,
      );
    }

    // The generated file carries both leaf secrets in its environment block. It is never printed,
    // and its mode is 0600 even though the directory is git-ignored.
    writeFileSync(
      composePath,
      composeDocument({ project, devPort, stagingPort, aggregatorPort }),
      { encoding: "utf8", mode: 0o600 },
    );
    chmodSync(composePath, 0o600);

    console.log(`docker-smoke: project ${project}, workspace .tmp/docker-smoke/${runId}`);
    await composeUp();
    await runCases({ devPort, stagingPort, aggregatorPort });
  } catch (error) {
    failures += 1;
    checks += 1;
    console.log(
      `FAIL runner (threw): ${redact(error instanceof Error ? error.message : String(error))}`,
    );
  } finally {
    if (failures > 0) await dumpLogs();
    await cleanup();
    const credentialsRemoved = await verifyCleanup();
    if (failures === 0) {
      // Nothing left to inspect on success: logs are empty and the credential check above passed.
      rmSync(workspace, { recursive: true, force: true });
    } else {
      // Keep the stores/logs for forensics. The message reports the *checked* credential state: a
      // failed removal must never be described as "removed".
      console.log(
        `docker-smoke: workspace kept at .tmp/docker-smoke/${runId} (` +
          `${credentialsRemoved ? "credential files removed" : "CREDENTIAL FILES STILL PRESENT — workspace contains secrets"})`,
      );
    }
    console.log(
      `\ndocker-smoke: ${checks - failures}/${checks} case(s) passed, project ${project}`,
    );
  }

  return failures === 0 ? 0 : 1;
}

process.exitCode = await main();
