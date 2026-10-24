#!/usr/bin/env node
/**
 * Component-wide E2E runner — the single binding entry point over every end-to-end suite in the
 * repository. It owns the manifest instead of `package.json` wiring: each component is spawned as
 * `process.execPath <relative entry>`, so a suite can be added here without touching npm scripts,
 * and the runner never depends on a shell or on PATH.
 *
 *   node scripts/components-e2e.mjs                       run every component (browser/docker optional)
 *   node scripts/components-e2e.mjs --only=auth,voice     run a subset (manifest order)
 *   node scripts/components-e2e.mjs --only=hub-auth       run every component covering that ID
 *   node scripts/components-e2e.mjs --list                manifest + coverage gate
 *   node scripts/components-e2e.mjs --json                one machine-readable object on stdout
 *   node scripts/components-e2e.mjs --no-browser          skip browser components
 *   node scripts/components-e2e.mjs --no-docker           skip the Docker component
 *
 * `--only` accepts both namespaces: a manifest component ID selects that component, a coverage ID
 * (one of the IDs in the manifest `covers` lists) selects every component that covers it. An
 * unknown ID is a usage error that names both namespaces.
 *
 * Components run **sequentially** in manifest order, so two suites can never fight over a port or a
 * shared `.tmp` workspace. Every suite gets its own timeout; on expiry the runner sends SIGTERM and
 * SIGKILLs the process group after a short grace period (suites spawn hubs, servers and browsers).
 * SIGINT/SIGTERM are forwarded to the active child's process group so an aborted matrix does not
 * orphan hubs or Chrome; the runner then reports exit code 130/143.
 *
 * The coverage gate runs before anything is executed: `docs/E2E-COVERAGE.md` is the documented
 * promise, this manifest is the enforced reality, and a mismatch in either direction is a failure
 * (a documented but unrunnable component is a stale promise; an undocumented `covers` ID is a
 * typo). It is intentionally not graph-derived — the two lists have to agree by hand.
 *
 * Environment: `BP_REQUIRE_BROWSER=1` and `BP_REQUIRE_DOCKER=1` turn a missing prerequisite into a
 * failure instead of a skip. CI sets both. Passing `--no-browser` sets `BP_NO_BROWSER=1` in every
 * child environment, so a suite with a browser leg can suppress exactly that leg instead of being
 * skipped wholesale (the embed suite runs its jsdom legs either way). Suites keep their own
 * env-based skip behaviour; a suite that prints `SKIP <case>` lines is reported as `partial`
 * (some cases skipped) instead of `pass`, and a suite that exits with the shared skip code (77)
 * is reported as `skip` only when it also printed a `SKIP` marker (and no `FAIL` line); a bare 77
 * is a failure, not a run that executed nothing.
 *
 * Contradictory inputs are usage errors: `--no-browser` with `BP_REQUIRE_BROWSER=1` (and the
 * Docker equivalent) would otherwise turn the whole matrix green while skipping everything.
 *
 * Exit codes: 0 all non-skipped components passed (a `partial`/`skip` status is visible in the
 * summary and `--json`, but is not a failure); 1 a component failed, the coverage gate failed or a
 * build artifact/suite entry is missing; 2 usage error (unknown option, unknown `--only` id,
 * contradictory `--no-*`/`BP_REQUIRE_*`); 130/143 interrupted by SIGINT/SIGTERM.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome } from "./lib/browser.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const COVERAGE_DOC = join(root, "docs", "E2E-COVERAGE.md");
const BUILD_PROBE = join(root, "dist", "cli.js");
const EXT_PROBE = join(root, "extension", "dist", "manifest.json");
const KILL_GRACE_MS = 5000;
const DOCKER_PROBE_TIMEOUT_MS = 15000;
/** Shared with `scripts/docker-smoke.mjs`: the suite executed nothing (prerequisite missing). */
const SKIP_EXIT_CODE = 77;
const COMPONENTS_BEGIN = "<!-- components:begin -->";
const COMPONENTS_END = "<!-- components:end -->";
/**
 * A suite's self-skip line: `SKIP <case> …` (the shape every smoke suite prints), optionally
 * prefixed with a suite tag such as `[parity] SKIP — …`. The anchor at the start of the line is
 * deliberate: a banner or log line that merely *mentions* SKIP must not count as a marker.
 */
const SKIP_LINE = /^(?:\[[\w-]+\]\s+)?SKIP\b.*$/gm;
/** A suite's failure line at line start, with the same optional `[tag] ` prefix (`[parity] FAIL …`). */
const FAIL_LINE = /^(?:\[[\w-]+\]\s+)?FAIL\b.*$/gm;

/**
 * The manifest. `entry` is relative to the repository root and is passed to `process.execPath`
 * verbatim; `requires` drives the skip/fail decisions, `covers` is the claim checked against
 * `docs/E2E-COVERAGE.md`, and `timeoutMs` is the hard wall for the whole suite.
 *
 * `build:ext` is a distinct prerequisite: the extension-derived suites read the built extension
 * (`extension/dist/manifest.json`), so `npm run build` alone is not enough for them.
 */
const MANIFEST = [
  {
    id: "cli",
    label: "CLI",
    entry: "scripts/cli-smoke.mjs",
    requires: ["build"],
    timeoutMs: 300000,
    covers: ["cli"],
  },
  {
    id: "mcp",
    label: "MCP stdio",
    entry: "scripts/mcp-smoke.mjs",
    requires: ["build"],
    timeoutMs: 300000,
    covers: ["mcp-stdio"],
  },
  {
    id: "federation",
    label: "Federator + aggregating hub",
    entry: "scripts/federation-smoke.mjs",
    requires: ["build"],
    timeoutMs: 300000,
    covers: ["federator", "aggregating-hub"],
  },
  {
    id: "pack",
    label: "Packaging",
    entry: "scripts/pack-smoke.mjs",
    requires: ["build"],
    timeoutMs: 300000,
    covers: ["pack-install"],
  },
  {
    id: "install",
    label: "Install from tarball",
    entry: "scripts/install-smoke.mjs",
    requires: ["build"],
    timeoutMs: 600000,
    covers: ["pack-install"],
  },
  {
    id: "embed",
    label: "Hub HTTP + Element + attach.js",
    entry: "scripts/embed-smoke.mjs",
    // The jsdom legs (element, hub-http, journal) need no browser; the suite self-skips its own
    // browser leg, and honours BP_NO_BROWSER=1 when --no-browser was passed.
    requires: ["build"],
    timeoutMs: 300000,
    covers: ["element", "attach-js", "hub-http", "journal", "presentation"],
  },
  {
    id: "e2e",
    label: "Fixture app (Library/IIFE)",
    entry: "tests/e2e/vanilla.e2e.mjs",
    requires: ["build", "browser"],
    timeoutMs: 300000,
    covers: ["library-iife"],
  },
  {
    id: "bookmarklet",
    label: "Bookmarklet IIFE",
    entry: "scripts/bookmarklet-smoke.mjs",
    requires: ["build", "browser"],
    timeoutMs: 300000,
    covers: ["bookmarklet"],
  },
  {
    id: "round-trip",
    label: "Browser → hub → MCP → browser",
    entry: "tests/e2e/round-trip.e2e.mjs",
    requires: ["build", "browser", "build:ext"],
    timeoutMs: 300000,
    covers: ["round-trip"],
  },
  {
    id: "parity",
    label: "attach.js vs MV3 extension",
    entry: "tests/e2e/parity.e2e.mjs",
    requires: ["build", "browser", "build:ext"],
    timeoutMs: 300000,
    covers: ["parity"],
  },
  {
    id: "ext",
    label: "MV3 extension",
    entry: "extension/smoke.mjs",
    requires: ["build", "browser", "build:ext"],
    timeoutMs: 300000,
    covers: ["extension"],
  },
  {
    id: "webstore",
    label: "Web Store compliance",
    entry: "scripts/webstore-compliance.mjs",
    requires: ["build", "build:ext"],
    timeoutMs: 180000,
    covers: ["webstore"],
  },
  {
    id: "auth",
    label: "Hub auth + tokens + HTTP MCP door",
    entry: "scripts/auth-smoke.mjs",
    requires: ["build"],
    timeoutMs: 300000,
    covers: ["hub-auth", "hub-mcp-door"],
  },
  {
    id: "hermes",
    label: "Hermes wrapper (stdio)",
    entry: "scripts/hermes-wrapper-smoke.mjs",
    requires: ["build"],
    timeoutMs: 300000,
    covers: ["hermes-wrapper"],
  },
  {
    id: "voice",
    label: "Voice dictation (real browser)",
    entry: "scripts/voice-smoke.mjs",
    requires: ["build", "browser"],
    // Cold Docker start-up budget for the real-browser legs on a loaded CI runner.
    timeoutMs: 300000,
    covers: ["voice"],
  },
  {
    id: "docker",
    label: "Docker Compose federation",
    entry: "scripts/docker-smoke.mjs",
    requires: ["build", "docker"],
    // Cold Docker budget: image build plus Compose up / health waits on an unprimed daemon.
    timeoutMs: 1200000,
    covers: ["docker"],
  },
];

const KNOWN_IDS = new Set(MANIFEST.map((component) => component.id));

/** Coverage ID → component IDs that claim it, in manifest order. */
const COVERAGE_TO_COMPONENTS = new Map();
for (const component of MANIFEST) {
  for (const cover of component.covers) {
    if (!COVERAGE_TO_COMPONENTS.has(cover)) COVERAGE_TO_COMPONENTS.set(cover, []);
    COVERAGE_TO_COMPONENTS.get(cover).push(component.id);
  }
}
const ALL_COVERED = [...COVERAGE_TO_COMPONENTS.keys()];

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

const USAGE =
  "usage: node scripts/components-e2e.mjs [--only=<id[,id]>] [--list] [--json] [--no-browser] [--no-docker]";

/** Thrown by `parseArgs`; caught once at the entry point so the exit code is still awaited. */
class UsageError extends Error {}

function usageError(message) {
  throw new UsageError(message);
}

/** Expands one `--only` token: component ID first, then coverage ID. */
function expandOnlyId(id) {
  if (KNOWN_IDS.has(id)) return [id];
  const covered = COVERAGE_TO_COMPONENTS.get(id);
  if (covered !== undefined) return covered;
  usageError(
    `unknown --only id "${id}"; accepted: component IDs (${[...KNOWN_IDS].join(", ")}) ` +
      `or coverage IDs (${[...COVERAGE_TO_COMPONENTS.keys()].join(", ")})`,
  );
}

function parseArgs(argv) {
  const options = { only: new Set(), list: false, json: false, browser: true, docker: true };
  for (const arg of argv) {
    if (arg === "--list") options.list = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--no-browser") options.browser = false;
    else if (arg === "--no-docker") options.docker = false;
    else if (arg.startsWith("--only=")) {
      const ids = arg
        .slice("--only=".length)
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      if (ids.length === 0) usageError("--only needs at least one component or coverage id");
      for (const id of ids) {
        for (const componentId of expandOnlyId(id)) options.only.add(componentId);
      }
    } else {
      usageError(`unknown option "${arg}"`);
    }
  }

  // Contradictory inputs would silently turn the matrix green with everything skipped.
  if (!options.browser && process.env.BP_REQUIRE_BROWSER === "1") {
    usageError("BP_REQUIRE_BROWSER=1 conflicts with --no-browser");
  }
  if (!options.docker && process.env.BP_REQUIRE_DOCKER === "1") {
    usageError("BP_REQUIRE_DOCKER=1 conflicts with --no-docker");
  }
  return options;
}

/** The selected components, always in manifest order (never in `--only` argument order). */
function selectComponents(options) {
  if (options.only.size === 0) return MANIFEST;
  return MANIFEST.filter((component) => options.only.has(component.id));
}

/* -------------------------------------------------------------------------- */
/* Coverage gate                                                               */
/* -------------------------------------------------------------------------- */

/** Splits a markdown table row into trimmed cells (or `null` when the line is not a table row). */
function tableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  return trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** The `*.mjs` entry paths named in the `E2E entry` cell (typically `` → `scripts/x.mjs` ``). */
function entryPaths(cell) {
  return [...String(cell ?? "").matchAll(/`([^`\s]+\.mjs)`/g)].map((match) => match[1]);
}

/**
 * Reads the documented component IDs and their `E2E entry` claims from the marked table in
 * `docs/E2E-COVERAGE.md`. The regex only accepts the first-column form ``| `id` |``, so prose and
 * other tables in the document cannot silently count as a component.
 *
 * The entry column is parsed, not trusted: the document's promise is the *command and file* a
 * reader is told to run, so a renamed or removed suite has to turn the gate red even when every ID
 * still matches.
 */
function readDocumentedComponents() {
  if (!existsSync(COVERAGE_DOC)) {
    return {
      documented: [],
      entries: new Map(),
      error: `coverage doc not found: ${COVERAGE_DOC}`,
    };
  }
  const text = readFileSync(COVERAGE_DOC, "utf8");
  const begin = text.indexOf(COMPONENTS_BEGIN);
  const end = text.indexOf(COMPONENTS_END);
  if (begin === -1 || end === -1 || end < begin) {
    return {
      documented: [],
      entries: new Map(),
      error: `coverage doc is missing the ${COMPONENTS_BEGIN} … ${COMPONENTS_END} markers`,
    };
  }
  const section = text.slice(begin + COMPONENTS_BEGIN.length, end);
  let header = null;
  const rows = [];
  for (const line of section.split(/\r?\n/)) {
    const cells = tableRow(line);
    if (cells === null) continue;
    // The `| --- |` alignment row is not data and not the header.
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    if (header === null) {
      header = cells;
      continue;
    }
    rows.push(cells);
  }
  if (header === null) {
    return {
      documented: [],
      entries: new Map(),
      error: `coverage doc table between the markers has no header row`,
    };
  }
  const idIndex = header.indexOf("ID");
  const entryIndex = header.findIndex((cell) => /^e2e\s+entry$/i.test(cell));
  if (idIndex === -1 || entryIndex === -1) {
    return {
      documented: [],
      entries: new Map(),
      error:
        'coverage doc table must have an "ID" column and an "E2E entry" column ' +
        `(found: ${header.join(" | ")})`,
    };
  }

  const documented = [];
  const entries = new Map();
  for (const cells of rows) {
    const match = /^`([a-z0-9-]+)`$/.exec(cells[idIndex] ?? "");
    if (match === null) continue;
    const id = match[1];
    if (!documented.includes(id)) documented.push(id);
    entries.set(id, entryPaths(cells[entryIndex]));
  }
  return { documented, entries, error: null };
}

/**
 * The gate is bidirectional on purpose: a documented ID that no component covers is a stale
 * promise, and a `covers` ID that the document does not mention is a typo nobody would notice.
 * The `E2E entry` column is checked in both directions too: every documented entry must exist and
 * belong to a component covering that ID, and every covering component's entry must be named.
 */
function coverageGate() {
  const { documented, entries, error } = readDocumentedComponents();
  const covered = new Set(ALL_COVERED);
  const documentedSet = new Set(documented);
  const missing = documented.filter((id) => !covered.has(id));
  const unknown = ALL_COVERED.filter((id) => !documentedSet.has(id));

  const byId = new Map(MANIFEST.map((component) => [component.id, component]));
  const entryProblems = [];
  for (const id of documented) {
    const claimed = entries.get(id) ?? [];
    if (claimed.length === 0) {
      entryProblems.push(`documented row ${id} names no E2E entry (*.mjs path)`);
    }
    for (const path of claimed) {
      if (!existsSync(join(root, path))) {
        entryProblems.push(`documented E2E entry for ${id} does not exist: ${path}`);
      }
    }
    const manifestEntries = (COVERAGE_TO_COMPONENTS.get(id) ?? []).map(
      (componentId) => byId.get(componentId).entry,
    );
    for (const path of claimed) {
      if (!manifestEntries.includes(path)) {
        entryProblems.push(
          `documented E2E entry for ${id} (${path}) is not the entry of a component covering it`,
        );
      }
    }
    for (const path of manifestEntries) {
      if (!claimed.includes(path)) {
        entryProblems.push(
          `manifest entry ${path} (covering ${id}) is missing from the documented row`,
        );
      }
    }
  }

  return { documented, covered: ALL_COVERED, missing, unknown, entryProblems, error };
}

function describeGateFailure(gate) {
  const problems = [];
  if (gate.error !== null) problems.push(gate.error);
  if (gate.missing.length > 0) {
    problems.push(`documented but not covered by any component: ${gate.missing.join(", ")}`);
  }
  if (gate.unknown.length > 0) {
    problems.push(`covered by a component but not documented: ${gate.unknown.join(", ")}`);
  }
  problems.push(...gate.entryProblems);
  return problems;
}

/* -------------------------------------------------------------------------- */
/* Precondition probes                                                         */
/* -------------------------------------------------------------------------- */

let chromeProbe;

/** `findChrome()` scans PATH and the Playwright caches; probe at most once per run. */
function chromeAvailable() {
  if (chromeProbe === undefined) chromeProbe = findChrome();
  return chromeProbe !== null;
}

let dockerProbe;

/** Docker is usable only when both `docker info` and the compose plugin answer. Memoized. */
function dockerAvailable() {
  if (dockerProbe !== undefined) return dockerProbe;
  const info = spawnSync("docker", ["info"], {
    stdio: "ignore",
    timeout: DOCKER_PROBE_TIMEOUT_MS,
  });
  if (info.error !== undefined || info.status !== 0) {
    dockerProbe = { ok: false, detail: "docker info failed" };
    return dockerProbe;
  }
  const compose = spawnSync("docker", ["compose", "version"], {
    stdio: "ignore",
    timeout: DOCKER_PROBE_TIMEOUT_MS,
  });
  if (compose.error !== undefined || compose.status !== 0) {
    dockerProbe = { ok: false, detail: "docker compose plugin not available" };
    return dockerProbe;
  }
  dockerProbe = { ok: true, detail: null };
  return dockerProbe;
}

/**
 * Resolves the runner-owned skip/fail decisions for one component. The suites themselves still
 * skip their own browser/docker cases; these checks exist so the runner does not spawn a suite it
 * already knows cannot run, and so CI can demand the prerequisite (`BP_REQUIRE_*`).
 */
function precondition(component, options) {
  if (component.requires.includes("browser")) {
    if (!options.browser) return { status: "skip", reason: "disabled by --no-browser" };
    if (!chromeAvailable()) {
      if (process.env.BP_REQUIRE_BROWSER === "1") {
        return { status: "fail", reason: "no usable Chrome and BP_REQUIRE_BROWSER=1" };
      }
      return { status: "skip", reason: "no usable Chrome" };
    }
  }
  if (component.requires.includes("docker")) {
    if (!options.docker) return { status: "skip", reason: "disabled by --no-docker" };
    const probe = dockerAvailable();
    if (!probe.ok) {
      if (process.env.BP_REQUIRE_DOCKER === "1") {
        return { status: "fail", reason: `${probe.detail} and BP_REQUIRE_DOCKER=1` };
      }
      return { status: "skip", reason: probe.detail };
    }
  }
  return { status: "run", reason: null };
}

/* -------------------------------------------------------------------------- */
/* Signal handling                                                             */
/* -------------------------------------------------------------------------- */

let activeChild = null;
let shuttingDown = false;
let interruptExitCode = null;
let forceKillTimer = null;

/**
 * Forwards SIGINT/SIGTERM to the active child's process group. The first signal wins, so a repeated
 * Ctrl-C cannot kill the same tree twice; a suite that ignores the forwarded signal is SIGKILLed
 * after the same grace period the timeout path uses.
 */
function installSignalHandlers() {
  const handle = (signal, exitCode) => {
    if (shuttingDown) return;
    shuttingDown = true;
    interruptExitCode = exitCode;
    console.error(`[components-e2e] ${signal} received — aborting`);
    if (activeChild !== null) {
      killTree(activeChild, signal);
      forceKillTimer = setTimeout(() => {
        if (activeChild !== null) killTree(activeChild, "SIGKILL");
      }, KILL_GRACE_MS);
    }
  };
  process.on("SIGINT", () => handle("SIGINT", 130));
  process.on("SIGTERM", () => handle("SIGTERM", 143));
}

/* -------------------------------------------------------------------------- */
/* Child execution                                                             */
/* -------------------------------------------------------------------------- */

/** Kills the whole process group: suites spawn hubs, servers and browsers of their own. */
function killTree(child, signal) {
  if (child.pid === undefined) return;
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

function combineOutput(stdout, stderr) {
  const parts = [];
  if (stdout.trim() !== "") parts.push(stdout.trim());
  if (stderr.trim() !== "") parts.push(`[stderr]\n${stderr.trim()}`);
  return parts.join("\n");
}

/** Every `SKIP <case>` line a suite printed — the marker a partial run leaves behind. */
function skippedLines(stdout) {
  return [...String(stdout).matchAll(SKIP_LINE)].map((match) => match[0].trim());
}

/** Every failure line a suite printed — a skip code is not a skip when the suite also failed. */
function failedLines(output) {
  return [...String(output).matchAll(FAIL_LINE)].map((match) => match[0].trim());
}

/**
 * Runs one suite to completion (or to its timeout). Nothing is streamed while it runs: the output
 * is only shown when the component fails (and carried in `--json`), which keeps the matrix and the
 * JSON document clean even for chatty suites.
 */
function runComponent(component, childEnv) {
  return new Promise((resolveRun) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timeoutTimer = null;
    let hardKillTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      if (hardKillTimer !== null) clearTimeout(hardKillTimer);
      if (activeChild === child) {
        activeChild = null;
        if (forceKillTimer !== null) {
          clearTimeout(forceKillTimer);
          forceKillTimer = null;
        }
      }
      resolveRun({
        ...result,
        durationMs: Date.now() - startedAt,
        output: combineOutput(stdout, stderr),
      });
    };

    let child;
    try {
      child = spawn(process.execPath, [component.entry], {
        cwd: root,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        // A separate process group lets the timeout/signal kill every descendant, not just node.
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolveRun({
        status: "fail",
        exitCode: null,
        reason: `could not spawn: ${error.message}`,
        durationMs: Date.now() - startedAt,
        output: "",
      });
      return;
    }
    activeChild = child;

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGTERM");
      hardKillTimer = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
    }, component.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      finish({
        status: "fail",
        exitCode: null,
        reason: `could not start: ${error.message}`,
      });
    });

    child.on("close", (code, signal) => {
      const skipped = skippedLines(stdout);
      if (timedOut) {
        finish({
          status: "fail",
          exitCode: code,
          skipped,
          reason: `timeout after ${component.timeoutMs} ms`,
        });
        return;
      }
      // The dedicated skip code means the suite executed nothing (e.g. no Docker daemon). Treating
      // it as a pass would let the matrix claim coverage it never ran. The exit code alone is not
      // proof, though: a crashed suite or a wrapper/shell error can produce 77 as well. A real skip
      // must print a SKIP marker and must not have printed a FAIL line; everything else is a failure.
      if (code === SKIP_EXIT_CODE) {
        const failuresInOutput = failedLines(`${stdout}\n${stderr}`);
        if (skipped.length > 0 && failuresInOutput.length === 0) {
          finish({
            status: "skip",
            exitCode: code,
            skipped,
            reason: skipped[0],
          });
          return;
        }
        finish({
          status: "fail",
          exitCode: code,
          skipped,
          reason:
            failuresInOutput.length > 0
              ? `exit ${SKIP_EXIT_CODE} with FAIL output: ${failuresInOutput.slice(0, 3).join(" | ")}`
              : `exit ${SKIP_EXIT_CODE} without SKIP marker`,
        });
        return;
      }
      if (code === 0) {
        finish({
          status: skipped.length > 0 ? "partial" : "pass",
          exitCode: 0,
          skipped,
          reason:
            skipped.length > 0
              ? `${skipped.length} case(s) skipped: ${skipped.join(" | ")}`
              : null,
        });
        return;
      }
      finish({
        status: "fail",
        exitCode: code,
        skipped,
        reason: code === null ? `terminated by ${signal}` : `exit code ${code}`,
      });
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                   */
/* -------------------------------------------------------------------------- */

/** Awaits the stdout flush: `process.exit()` after `write()` truncates a pipe at 64 KiB. */
export function writeStdout(text) {
  return new Promise((resolveWrite) => {
    process.stdout.write(text, () => resolveWrite());
  });
}

export function emitJson(payload) {
  return writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function matrixLines(results) {
  const rows = [
    ["component", "status", "duration"],
    ...results.map((result) => [result.id, result.status, formatDuration(result.durationMs)]),
  ];
  const widths = [0, 1, 2].map((column) => Math.max(...rows.map((row) => row[column].length)));
  return rows.map((row) => row.map((value, column) => value.padEnd(widths[column])).join(" | "));
}

function jsonResult(gate, results) {
  return {
    // An interrupted run is never `ok`, even when every suite that had finished before the signal
    // happened to pass: the matrix did not run to completion.
    ok: interruptExitCode === null && results.every((result) => result.status !== "fail"),
    interrupted: interruptExitCode !== null,
    interruptExitCode,
    coverage: {
      documented: gate.documented,
      covered: gate.covered,
      missing: gate.missing,
      unknown: gate.unknown,
      entryProblems: gate.entryProblems,
    },
    components: results.map((result) => {
      const entry = {
        id: result.id,
        label: result.label,
        status: result.status,
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        reason: result.reason,
      };
      if (Array.isArray(result.skipped) && result.skipped.length > 0) {
        entry.skippedCases = result.skipped;
      }
      // Passing/skipped components carry no diagnostics; only failures keep their output. This
      // keeps the machine-readable document small even for a fully chatty matrix.
      if (result.status === "fail") entry.output = result.output;
      return entry;
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

/** A selected component whose suite entry is not on disk — checked by `--list` as well. */
function missingEntries(selected) {
  const missing = selected.filter((component) => !existsSync(join(root, component.entry)));
  if (missing.length === 0) return [];
  const noun = missing.length === 1 ? "entry" : "entries";
  const list = missing.map((component) => `${component.id} (${component.entry})`).join(", ");
  return [`missing suite ${noun}: ${list}`];
}

function missingArtifacts(selected) {
  const problems = [];
  if (selected.some((component) => component.requires.includes("build")) && !existsSync(BUILD_PROBE)) {
    problems.push(`missing build artifact ${BUILD_PROBE} — run "npm run build" first`);
  }
  if (
    selected.some((component) => component.requires.includes("build:ext")) &&
    !existsSync(EXT_PROBE)
  ) {
    problems.push(`missing build artifact ${EXT_PROBE} — run "npm run build:ext" first`);
  }
  problems.push(...missingEntries(selected));
  return problems;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const selected = selectComponents(options);

  const gate = coverageGate();
  const gateProblems = describeGateFailure(gate);

  if (options.list) {
    // Entry existence is a manifest invariant, not a build product: `--list` runs in CI before
    // `npm run build`, so it must catch a renamed/removed suite even though it does not probe the
    // build artifacts (`missingArtifacts` does that on a real run).
    const listProblems = [...gateProblems, ...missingEntries(selected)];
    if (options.json) {
      await emitJson({
        ok: listProblems.length === 0,
        interrupted: false,
        interruptExitCode: null,
        list: selected.map((component) => ({
          id: component.id,
          label: component.label,
          entry: component.entry,
          requires: component.requires,
          covers: component.covers,
          command: [process.execPath, component.entry].join(" "),
        })),
        coverage: {
          documented: gate.documented,
          covered: gate.covered,
          missing: gate.missing,
          unknown: gate.unknown,
          entryProblems: gate.entryProblems,
        },
        problems: listProblems,
      });
      return listProblems.length > 0 ? 1 : 0;
    }
    const lines = selected.map((component) => {
      const command = [process.execPath, component.entry].join(" ");
      return `${component.id.padEnd(12)} ${component.label.padEnd(38)} requires=${component.requires.join(",").padEnd(22)} covers=${component.covers.join(",").padEnd(62)} command=${command}`;
    });
    await writeStdout(`${lines.join("\n")}\n`);
    if (listProblems.length > 0) {
      for (const problem of listProblems) console.error(`[components-e2e] ${problem}`);
      return 1;
    }
    return 0;
  }

  if (gateProblems.length > 0) {
    for (const problem of gateProblems) console.error(`[components-e2e] coverage gate: ${problem}`);
    if (options.json) {
      await emitJson({
        ...jsonResult(gate, []),
        ok: false,
        error: `coverage gate failed: ${gateProblems.join("; ")}`,
      });
    }
    return 1;
  }

  const artifactProblems = missingArtifacts(selected);
  if (artifactProblems.length > 0) {
    for (const problem of artifactProblems) console.error(`[components-e2e] ${problem}`);
    if (options.json) {
      await emitJson({ ...jsonResult(gate, []), ok: false, error: artifactProblems.join("; ") });
    }
    return 1;
  }

  installSignalHandlers();
  const childEnv = { ...process.env };
  if (!options.browser) childEnv.BP_NO_BROWSER = "1";

  const results = [];
  for (const component of selected) {
    if (shuttingDown) break;
    const decision = precondition(component, options);
    if (decision.status === "skip") {
      console.error(`[components-e2e] skip ${component.id}: ${decision.reason}`);
      results.push({
        id: component.id,
        label: component.label,
        status: "skip",
        durationMs: 0,
        exitCode: null,
        reason: decision.reason,
        output: "",
      });
      continue;
    }
    if (decision.status === "fail") {
      console.error(`[components-e2e] fail ${component.id}: ${decision.reason}`);
      results.push({
        id: component.id,
        label: component.label,
        status: "fail",
        durationMs: 0,
        exitCode: null,
        reason: decision.reason,
        output: "",
      });
      continue;
    }

    // A signal may have arrived while the precondition probes ran (they can take seconds): check
    // again immediately before a suite is spawned, so an aborted matrix cannot start one more.
    if (shuttingDown) break;

    console.error(`[components-e2e] run ${component.id} (${component.label})`);
    const outcome = await runComponent(component, childEnv);
    const result = {
      id: component.id,
      label: component.label,
      status: outcome.status,
      durationMs: outcome.durationMs,
      exitCode: outcome.exitCode,
      reason: outcome.reason,
      output: outcome.output,
      skipped: outcome.skipped ?? [],
    };
    results.push(result);
    console.error(
      `[components-e2e] ${result.status} ${component.id} (${formatDuration(result.durationMs)})`,
    );
    if (result.status === "fail" && !options.json) {
      await writeStdout(
        `\n--- ${component.id} output ---\n${result.output === "" ? "(no output)" : result.output}\n`,
      );
    }
  }

  if (options.json) {
    await emitJson(jsonResult(gate, results));
  } else {
    const passed = results.filter((result) => result.status === "pass").length;
    const partial = results.filter((result) => result.status === "partial").length;
    const failed = results.filter((result) => result.status === "fail").length;
    const skipped = results.filter((result) => result.status === "skip").length;
    const lines = [
      "",
      ...matrixLines(results),
      "",
      `components-e2e: ${passed} passed, ${partial} partial, ${failed} failed, ${skipped} skipped`,
    ];
    await writeStdout(`${lines.join("\n")}\n`);
  }

  if (interruptExitCode !== null) return interruptExitCode;
  return results.some((result) => result.status === "fail") ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    process.exitCode = await main();
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`[components-e2e] ${error.message}`);
      console.error(USAGE);
      process.exitCode = 2;
    } else {
      throw error;
    }
  }
}
