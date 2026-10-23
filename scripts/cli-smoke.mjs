#!/usr/bin/env node
/**
 * CLI smoke test — exercises the *built* binary `dist/cli.js` end to end (FR-14.3/14.4/14.8/14.9,
 * FR-15.2, NFR-18). Like `size-guard.mjs` it builds nothing itself: run `npm run build` first, the
 * script fails fast when the artefact is missing.
 *
 * Everything happens in a throw-away workspace under `.tmp/cli-smoke/` (git-ignored), so the repo
 * and the example fixtures are never touched. Each case prints `PASS <case>` or
 * `FAIL <case>: <detail>`; the summary line counts them and the exit code is non-zero when any
 * case failed.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(root, "dist/cli.js");
const WORKSPACE = join(root, ".tmp/cli-smoke");

if (!existsSync(CLI)) {
  console.error(`[cli-smoke] missing build artifact: ${CLI} — run "npm run build" first`);
  process.exit(1);
}

// ---------------------------------------------------------------- workspace & fixtures

const ISO = "2026-09-15T08:00:00.000Z";
/** Credential fixture value for the federation registry — must never appear in CLI output (NFR-22). */
const REGISTRY_FIXTURE_VALUE = "cli-smoke-registry-secret-7f3a1";
/** A body that only the `done` note carries, so "is it hidden?" is unambiguous. */
const DONE_MARKER = "SMOKE-DONE-MARKER must be hidden by --include-done=false";
const KEEP_MARKER = "SMOKE-INCOMING-CONTENT applied by --on-conflict keep-incoming";

/** The shortest shape that passes `validateNote` — one factory for every fixture. */
function note(id, body, status, environment, extra = {}) {
  return {
    id,
    schemaVersion: 1,
    createdAt: ISO,
    updatedAt: ISO,
    type: "text",
    intent: "implement",
    status,
    body,
    author: "cli-smoke",
    authorType: "human",
    anchor: { hook: `smoke-${id}`, route: "/smoke" },
    context: null,
    messages: [],
    source: "ui:human",
    environment,
    ...extra,
  };
}

function bundle(notes, environment) {
  return {
    kind: "bluepencil.bundle",
    schemaVersion: 1,
    exportedAt: ISO,
    exportedBy: "cli-smoke",
    environment,
    app: { name: "smoke" },
    sessions: [],
    notes,
  };
}

/** Six dev notes, exactly one of them done. */
function devNotes() {
  const open = [1, 2, 3, 4, 5].map((i) => note(`n-00${i}`, `smoke body ${i}`, "open", "dev"));
  return [...open, note("n-006", DONE_MARKER, "done", "dev")];
}

/** The same six notes in `live`, plus one note that only exists there. */
function liveNotes() {
  return [
    ...devNotes().map((entry) => ({ ...entry, environment: "live" })),
    note("n-live-001", "smoke live-only note", "open", "live"),
  ];
}

const files = {
  dev: join(WORKSPACE, "dev.json"),
  registry: join(WORKSPACE, "registry.json"),
  registryInsecure: join(WORKSPACE, "registry-insecure.json"),
  registryBad: join(WORKSPACE, "registry-bad.json"),
  registryShape: join(WORKSPACE, "registry-shape.json"),
  target: join(WORKSPACE, "target.json"),
  conflict: join(WORKSPACE, "conflict.json"),
  live: join(WORKSPACE, "live.json"),
  add: join(WORKSPACE, "add.json"),
  truncated: join(WORKSPACE, "truncated.json"),
  newer: join(WORKSPACE, "newer.json"),
  badEnum: join(WORKSPACE, "bad-enum.json"),
  feature: join(WORKSPACE, "feature.json"),
  selfOut: join(WORKSPACE, "self-out.json"),
  dir: join(WORKSPACE, "a-directory"),
};

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function setUpWorkspace() {
  rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });

  const dev = bundle(devNotes(), "dev");
  writeJson(files.dev, dev);
  writeJson(files.conflict, bundle([{ ...devNotes()[0], body: KEEP_MARKER }], "dev"));
  writeJson(files.live, bundle(liveNotes(), "live"));
  writeJson(files.add, bundle([note("n-add-001", "smoke added note", "open", "dev")], "dev"));
  writeJson(files.newer, { ...dev, schemaVersion: 99 });
  writeJson(files.feature, bundle([
    note("n-feat-001", "smoke feature note", "open", "dev", { type: "feature", priority: "high" }),
    note("n-plain-001", "smoke plain note", "open", "dev"),
  ], "dev"));
  writeJson(files.badEnum, {
    ...dev,
    notes: dev.notes.map((entry, index) => (index === 0 ? { ...entry, intent: "bogus-intent" } : entry)),
  });

  // Truncated JSON: a valid document cut in half, so the parser reports a real syntax error.
  const text = `${JSON.stringify(dev, null, 2)}\n`;
  writeFileSync(files.truncated, text.slice(0, Math.floor(text.length / 2)), "utf8");

  mkdirSync(files.dir, { recursive: true });

  /* Federation registry fixtures. `auth.env` is a reference; the value comes from the child's
   * environment, and no `instances` command may ever print it (FR-16.15/NFR-22). */
  writeJson(files.registry, {
    schemaVersion: 1,
    instances: [
      {
        id: "dev",
        base: "http://127.0.0.1:1/api/v1/bluepencil",
        app: "dev-app",
        mode: "read",
        auth: { env: "BP_CLI_SMOKE_SECRET" },
      },
    ],
  });
  chmodSync(files.registry, 0o600);
  /* The documented Compose/lab shape: plain http on a private network (F-06). Offline the
   * registry is only valid with --allow-insecure. */
  writeJson(files.registryInsecure, {
    schemaVersion: 1,
    instances: [
      { id: "hub-dev", base: "http://hub-dev:8787/api/v1/bluepencil", app: "dev-app" },
    ],
  });
  chmodSync(files.registryInsecure, 0o600);
  writeFileSync(files.registryBad, "{ this is not a registry", "utf8");
  chmodSync(files.registryBad, 0o600);
  writeJson(files.registryShape, { schemaVersion: 2 });
  chmodSync(files.registryShape, 0o600);
}

/** Every case starts from the same dev baseline, so the cases stay independent. */
function resetTarget() {
  writeJson(files.target, bundle(devNotes(), "dev"));
  return sha256(files.target);
}

// ---------------------------------------------------------------- helpers

function passThrough(result) {
  return {
    status: result.status === null ? -1 : result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: "utf8",
    ...options,
    env: { ...process.env, BP_CLI_SMOKE_SECRET: REGISTRY_FIXTURE_VALUE, ...(options.env ?? {}) },
  });
  return passThrough(result);
}

/**
 * Runs the CLI with its stdout piped into a second node process, the way `cli | consumer` does.
 * `spawnSync` would buffer the whole stream for us and hide the write-after-exit truncation this
 * case exists to catch, so both children run concurrently and the pipe is genuinely consumed.
 */
function runPipeline(args, consumerPath, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BP_CLI_SMOKE_SECRET: REGISTRY_FIXTURE_VALUE },
    });
    const consumer = spawn(process.execPath, [consumerPath], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let cliStderr = "";
    let consumerStdout = "";
    let consumerStderr = "";
    child.stderr.setEncoding("utf8");
    consumer.stdout.setEncoding("utf8");
    consumer.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      cliStderr += chunk;
    });
    consumer.stdout.on("data", (chunk) => {
      consumerStdout += chunk;
    });
    consumer.stderr.on("data", (chunk) => {
      consumerStderr += chunk;
    });
    child.stdout.pipe(consumer.stdin);

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      consumer.kill("SIGKILL");
      reject(new Error(`pipeline timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let cliStatus = null;
    let consumerStatus = null;
    let settled = 0;
    const done = () => {
      settled += 1;
      if (settled < 2) return;
      clearTimeout(timer);
      resolve({ cliStatus, consumerStatus, cliStderr, consumerStdout, consumerStderr });
    };
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    consumer.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    /* Resolve on `close`, not `exit`: `exit` fires while stdout may still be draining through the
     * pipe, which would compare an incomplete `consumerStdout` (F-05). `close` is emitted after the
     * stdio streams are closed. `federation-smoke.mjs` follows the same rule. */
    child.once("close", (code) => {
      cliStatus = code === null ? -1 : code;
      done();
    });
    consumer.once("close", (code) => {
      consumerStatus = code === null ? -1 : code;
      done();
    });
  });
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: stdout is not JSON (${String(error.message)})`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** The CLI contract for a failure: exactly one `bluepencil: …` line and never a stack trace. */
function assertOneLineError(result, label) {
  const lines = result.stderr.trimEnd().split("\n");
  assert(result.stderr.startsWith("bluepencil: "), `${label}: stderr does not start with "bluepencil: " (${JSON.stringify(result.stderr.slice(0, 80))})`);
  assert(lines.length === 1, `${label}: expected one stderr line, got ${lines.length}`);
  assert(!/\n\s+at /.test(result.stderr), `${label}: stderr contains a stack trace`);
}

function assertExit(result, expected, label) {
  assert(result.status === expected, `${label}: expected exit ${expected}, got ${result.status} (stderr: ${JSON.stringify(result.stderr.trim().slice(0, 160))})`);
}

function cases() {
  return {
    "inspect+validate valid bundle": () => {
      const inspect = run(["inspect", files.dev, "--json"]);
      assertExit(inspect, 0, "inspect");
      const summary = parseJson(inspect.stdout, "inspect")[0];
      assert(summary.notes === 6, `inspect: expected 6 notes, got ${summary.notes}`);
      assert(summary.byStatus.open === 5 && summary.byStatus.done === 1, `inspect: unexpected status counts ${JSON.stringify(summary.byStatus)}`);
      const validate = run(["validate", files.dev]);
      assertExit(validate, 0, "validate");
      assert(validate.stdout.includes(": valid"), `validate: stdout is ${JSON.stringify(validate.stdout.trim())}`);
      const notes = run(["notes", files.dev]);
      assertExit(notes, 0, "notes");
      assert(parseJson(notes.stdout, "notes").length === 6, "notes: expected 6 notes");
    },

    "truncated JSON -> exit 4, one line": () => {
      const result = run(["inspect", files.truncated]);
      assertExit(result, 4, "inspect truncated");
      assertOneLineError(result, "inspect truncated");
      assert(result.stderr.includes("is not valid"), `stderr does not explain the rejection: ${JSON.stringify(result.stderr.trim())}`);
    },

    "newer schemaVersion -> exit 4": () => {
      const result = run(["inspect", files.newer]);
      assertExit(result, 4, "inspect newer");
      assertOneLineError(result, "inspect newer");
      assert(/schemaVersion 99/.test(result.stderr), `stderr does not name the version: ${JSON.stringify(result.stderr.trim())}`);
    },

    "unknown enum -> exit 4": () => {
      const result = run(["inspect", files.badEnum]);
      assertExit(result, 4, "inspect bad enum");
      assertOneLineError(result, "inspect bad enum");
      assert(result.stderr.includes("bogus-intent"), `stderr does not name the value: ${JSON.stringify(result.stderr.trim())}`);
    },

    "merge of a set into itself": () => {
      const before = resetTarget();
      const result = run(["merge", files.target, files.dev, "--mode", "upsert", "--json"]);
      assertExit(result, 0, "merge self");
      const report = parseJson(result.stdout, "merge self");
      assert(report.skipped === 6, `expected 6 skipped, got ${report.skipped}`);
      assert(report.added === 0 && report.updated === 0, `expected no changes, got +${report.added} / ~${report.updated}`);
      assert(report.dry_run === true && report.applied === false, "without --out nothing is written, so dry_run must be true");
      assert(sha256(files.target) === before, "the target changed although nothing was written");

      const written = run(["merge", files.target, files.dev, "--mode", "upsert", "--out", files.selfOut, "--json"]);
      assertExit(written, 0, "merge self --out");
      const writtenReport = parseJson(written.stdout, "merge self --out");
      assert(writtenReport.applied === true && writtenReport.dry_run === false, "a written merge must report applied=true");
      const out = readJson(files.selfOut);
      assert(out.notes.length === 6, `--out file: expected 6 notes, got ${out.notes.length}`);
      assert(JSON.stringify(out.notes) === JSON.stringify(readJson(files.target).notes), "--out file does not carry the merged note set");
    },

    "conflicting upsert without --on-conflict -> exit 2, unchanged": () => {
      const before = resetTarget();
      const result = run(["merge", files.target, files.conflict, "--mode", "upsert", "--out", files.target, "--json"]);
      assertExit(result, 2, "conflicting upsert");
      assertOneLineError(result, "conflicting upsert");
      assert(sha256(files.target) === before, "the target was written although the conflict was unresolved");

      const explicitFail = run(["merge", files.target, files.conflict, "--mode", "upsert", "--on-conflict", "fail", "--out", files.target]);
      assertExit(explicitFail, 2, "--on-conflict fail");
      assertOneLineError(explicitFail, "--on-conflict fail");
      assert(sha256(files.target) === before, "--on-conflict fail wrote the target");
    },

    "--on-conflict keep-incoming -> exit 0, applied": () => {
      const before = resetTarget();
      const result = run([
        "merge", files.target, files.conflict,
        "--mode", "upsert", "--on-conflict", "keep-incoming", "--out", files.target, "--json",
      ]);
      assertExit(result, 0, "keep-incoming");
      const report = parseJson(result.stdout, "keep-incoming");
      assert(report.applied === true && report.dry_run === false, `expected applied=true, got dry_run=${report.dry_run}`);
      assert(report.updated === 1, `expected 1 updated note, got ${report.updated}`);
      assert(Array.isArray(report.resolved_conflicts) && report.resolved_conflicts.length === 1, "the resolved conflict must be reported as resolved_conflicts");
      assert(report.conflicts.length === 0, "a resolved conflict must not be listed as unresolved");
      assert(sha256(files.target) !== before, "the resolved merge did not write the target");
      const applied = readJson(files.target).notes.find((entry) => entry.id === "n-001");
      assert(applied.body === KEEP_MARKER, "the incoming content was not applied");
    },

    "live bundle into dev without override -> exit 3, no write": () => {
      const before = resetTarget();
      const result = run(["merge", files.target, files.live, "--mode", "upsert", "--out", files.target]);
      assertExit(result, 3, "live into dev");
      assert(/environment/i.test(result.stderr), `stderr does not explain the mismatch: ${JSON.stringify(result.stderr.trim())}`);
      assert(sha256(files.target) === before, "the target was written although the environment mismatched");
    },

    "--allow-env-mismatch promotes and writes": () => {
      resetTarget();
      const result = run([
        "merge", files.target, files.live,
        "--mode", "upsert", "--allow-env-mismatch", "--out", files.target, "--json",
      ]);
      assertExit(result, 0, "allow-env-mismatch");
      assert(result.stderr.includes("promoting"), `the promotion must be named on stderr: ${JSON.stringify(result.stderr.trim())}`);
      const report = parseJson(result.stdout, "allow-env-mismatch");
      assert(report.applied === true, "the promotion did not write the target");
      assert(report.promoted === 7, `expected 7 promoted notes, got ${report.promoted}`);
      assert(report.conflicts.length === 0, `expected no spurious conflicts, got ${report.conflicts.length}`);
      const merged = readJson(files.target);
      assert(merged.notes.length === 7, `expected 7 notes after the import, got ${merged.notes.length}`);
      const environments = [...new Set(merged.notes.map((entry) => entry.environment))];
      assert(environments.length === 1 && environments[0] === "dev", `notes were not re-tagged to dev: ${environments.join(", ")}`);
      const promoted = merged.notes.find((entry) => entry.id === "n-live-001");
      assert(promoted !== undefined && promoted.environment === "dev", "the promoted note is missing or still tagged live");
      assert(promoted.body === "smoke live-only note" && promoted.source === "ui:human", "the promotion changed the note's content or origin");
    },

    "import reports what it did": () => {
      resetTarget();
      const result = run(["import", files.add, files.target, "--json"]);
      assertExit(result, 0, "import");
      const report = parseJson(result.stdout, "import");
      assert(report.dry_run === false, `import wrote the file but reported dry_run=${report.dry_run}`);
      assert(report.applied === true, `import wrote the file but reported applied=${report.applied}`);
      assert(report.added === 1, `expected 1 added note, got ${report.added}`);
      const imported = readJson(files.target);
      assert(imported.notes.some((entry) => entry.id === "n-add-001"), "the imported note is not in the target");
    },

    "--include-done=false hides done notes": () => {
      resetTarget();
      const json = run(["export", files.target, "--format", "json", "--include-done=false"]);
      assertExit(json, 0, "export json");
      const exported = parseJson(json.stdout, "export json");
      assert(exported.notes.length === 5, `--include-done=false: expected 5 notes, got ${exported.notes.length}`);
      assert(!exported.notes.some((entry) => entry.status === "done"), "--include-done=false kept a done note");
      assert(!json.stdout.includes(DONE_MARKER), "--include-done=false leaked the done note's body");

      const spaced = run(["export", files.target, "--format", "json", "--include-done", "false"]);
      assertExit(spaced, 0, "export json --include-done false");
      assert(parseJson(spaced.stdout, "export json --include-done false").notes.length === 5, "--include-done false was ignored");

      const md = run(["export", files.target, "--format", "md", "--include-done=false"]);
      assertExit(md, 0, "export md");
      assert(!md.stdout.includes(DONE_MARKER), "--include-done=false leaked the done note into the markdown");

      const mdAll = run(["export", files.target, "--format", "md"]);
      assertExit(mdAll, 0, "export md (default)");
      assert(mdAll.stdout.includes(DONE_MARKER), "the default export must still contain done notes");
    },

    "feature type and priority (FR-15.2)": () => {
      const inspect = run(["inspect", files.feature, "--json"]);
      assertExit(inspect, 0, "inspect feature");
      const summary = parseJson(inspect.stdout, "inspect feature")[0];
      assert(summary.notes === 2, `inspect feature: expected 2 notes, got ${summary.notes}`);
      assert(summary.byType.feature === 1, `inspect feature: expected byType.feature === 1, got ${JSON.stringify(summary.byType)}`);
      assert(summary.byType.text === 1, `inspect feature: expected byType.text === 1, got ${JSON.stringify(summary.byType)}`);

      const exported = run(["export", files.feature, "--type", "feature", "--priority", "high", "--format", "json"]);
      assertExit(exported, 0, "export --type feature --priority high");
      const selected = parseJson(exported.stdout, "export --type feature --priority high");
      assert(selected.notes.length === 1, `export: expected 1 note, got ${selected.notes.length}`);
      const kept = selected.notes[0];
      assert(kept.id === "n-feat-001", `export: wrong note survived (${kept.id})`);
      assert(kept.type === "feature" && kept.priority === "high", `export: the note lost type/priority (${JSON.stringify({ type: kept.type, priority: kept.priority })})`);

      const invalid = run(["export", files.feature, "--priority", "urgent"]);
      assertExit(invalid, 1, "export --priority urgent");
      assertOneLineError(invalid, "export --priority urgent");
      assert(invalid.stderr.includes("--priority"), `export --priority urgent: stderr does not name the option (${JSON.stringify(invalid.stderr.trim())})`);
    },

    "invalid option values -> exit 1": () => {
      const mode = run(["merge", files.target, files.add, "--mode", "bogus"]);
      assertExit(mode, 1, "--mode bogus");
      assertOneLineError(mode, "--mode bogus");
      assert(mode.stderr.includes("--mode"), `stderr does not name the option: ${JSON.stringify(mode.stderr.trim())}`);

      const onConflict = run(["merge", files.target, files.add, "--on-conflict", "bogus"]);
      assertExit(onConflict, 1, "--on-conflict bogus");
      assertOneLineError(onConflict, "--on-conflict bogus");
      assert(onConflict.stderr.includes("--on-conflict"), `stderr does not name the option: ${JSON.stringify(onConflict.stderr.trim())}`);

      const environment = run(["export", files.target, "--format", "md", "--environment", "prod"]);
      assertExit(environment, 1, "--environment prod (markdown path)");
      assertOneLineError(environment, "--environment prod (markdown path)");
      assert(environment.stderr.includes("--environment"), `stderr does not name the option: ${JSON.stringify(environment.stderr.trim())}`);
    },

    "writing onto a directory -> exit 1, no temp file left": () => {
      const result = run(["merge", files.target, files.add, "--out", files.dir]);
      assertExit(result, 1, "write onto a directory");
      assertOneLineError(result, "write onto a directory");
      assert(result.stderr.includes("cannot write"), `stderr does not name the write failure: ${JSON.stringify(result.stderr.trim())}`);
      const leftovers = readdirSync(WORKSPACE).filter((entry) => /\.tmp-\d+$/.test(entry));
      assert(leftovers.length === 0, `temp files left behind: ${leftovers.join(", ")}`);
    },

    "write failure on stdout -> exit 1, one line": () => {
      if (!existsSync("/dev/full")) return "skipped (no /dev/full on this platform)";
      const full = openSync("/dev/full", "w");
      try {
        const result = run(["export", files.dev, "--format", "md"], { stdio: ["ignore", full, "pipe"] });
        assertExit(result, 1, "ENOSPC on stdout");
        assert(result.stderr.startsWith("bluepencil: "), `stdout failure is not reported one-line: ${JSON.stringify(result.stderr.trim().slice(0, 120))}`);
        assert(!/\n\s+at /.test(result.stderr), "stdout failure printed a stack trace");
      } finally {
        closeSync(full);
      }
      return undefined;
    },

    "instances validate/list are offline and publish no secret": () => {
      const validate = run(["instances", "validate", "--registry", files.registry]);
      assertExit(validate, 0, "instances validate");
      assert(validate.stdout.includes(": valid"), `validate: stdout is ${JSON.stringify(validate.stdout.trim())}`);

      const validateJson = run(["instances", "validate", "--registry", files.registry, "--json"]);
      assertExit(validateJson, 0, "instances validate --json");
      const validated = parseJson(validateJson.stdout, "instances validate --json");
      assert(validated.valid === true && validated.instances[0].id === "dev", `validate --json: ${JSON.stringify(validated)}`);

      const list = run(["instances", "list", "--registry", files.registry, "--json"]);
      assertExit(list, 0, "instances list --json");
      const rows = parseJson(list.stdout, "instances list --json");
      const row = rows[0];
      assert(
        rows.length === 1 &&
          row.id === "dev" &&
          row.app === "dev-app" &&
          row.base === "http://127.0.0.1:1/api/v1/bluepencil" &&
          row.mode === "read",
        `list --json: unexpected row ${JSON.stringify(row)}`,
      );
      for (const result of [validate, validateJson, list]) {
        assert(!result.stdout.includes(REGISTRY_FIXTURE_VALUE), "instances output leaked the credential value");
        assert(!result.stderr.includes(REGISTRY_FIXTURE_VALUE), "instances stderr leaked the credential value");
      }

      const human = run(["instances", "list", "--registry", files.registry]);
      assertExit(human, 0, "instances list");
      assert(human.stdout.includes("dev") && human.stdout.includes("dev-app"), `list: stdout is ${JSON.stringify(human.stdout.trim())}`);
      assert(!human.stdout.includes(REGISTRY_FIXTURE_VALUE), "instances list leaked the credential value");
    },

    "instances usage and invalid registry exit codes": () => {
      const missing = run(["instances", "validate"]);
      assertExit(missing, 1, "instances validate without --registry");
      assertOneLineError(missing, "instances validate without --registry");
      assert(missing.stderr.includes("--registry"), `stderr does not name --registry: ${JSON.stringify(missing.stderr.trim())}`);

      const unknown = run(["instances", "bogus", "--registry", files.registry]);
      assertExit(unknown, 1, "instances bogus");
      assertOneLineError(unknown, "instances bogus");

      for (const [label, path] of [
        ["invalid JSON", files.registryBad],
        ["invalid shape", files.registryShape],
      ]) {
        const result = run(["instances", "validate", "--registry", path]);
        assertExit(result, 4, `instances validate (${label})`);
        assert(!result.stdout.includes(REGISTRY_FIXTURE_VALUE), `instances validate (${label}) leaked the credential value`);
      }

      const badJson = run(["instances", "list", "--registry", files.registryBad]);
      assertExit(badJson, 4, "instances list (invalid JSON)");
      assertOneLineError(badJson, "instances list (invalid JSON)");
    },

    "instances health against a dead instance -> exit 5, no secret": () => {
      for (const extra of [[], ["--json"], ["--json", "--check"]]) {
        const label = `instances health ${extra.join(" ")}`.trim();
        const result = run(["instances", "health", "--registry", files.registry, "--timeout", "500", ...extra]);
        assertExit(result, 5, label);
        assert(!result.stdout.includes(REGISTRY_FIXTURE_VALUE), `${label}: stdout leaked the credential value`);
        assert(!result.stderr.includes(REGISTRY_FIXTURE_VALUE), `${label}: stderr leaked the credential value`);
        if (extra.includes("--json")) {
          const report = parseJson(result.stdout, label);
          assert(report.ok === false, `${label}: ok must be false`);
          assert(
            report.instances.length === 1 && report.instances[0].id === "dev" && report.instances[0].ok === false,
            `${label}: unexpected health rows ${JSON.stringify(report.instances)}`,
          );
        }
      }
    },

    "instances accepts a lab http registry only with --allow-insecure (F-06)": () => {
      const denied = run(["instances", "validate", "--registry", files.registryInsecure]);
      assertExit(denied, 4, "instances validate (lab registry, no flag)");
      assert(
        /http/i.test(denied.stdout),
        `validate: the issue does not explain the http rejection: ${JSON.stringify(denied.stdout.trim().slice(0, 160))}`,
      );

      const allowed = run([
        "instances", "validate", "--registry", files.registryInsecure, "--allow-insecure",
      ]);
      assertExit(allowed, 0, "instances validate --allow-insecure");
      assert(allowed.stdout.includes(": valid"), `validate --allow-insecure: ${JSON.stringify(allowed.stdout.trim())}`);

      const listed = run([
        "instances", "list", "--registry", files.registryInsecure, "--allow-insecure", "--json",
      ]);
      assertExit(listed, 0, "instances list --allow-insecure");
      const rows = parseJson(listed.stdout, "instances list --allow-insecure");
      assert(
        rows.length === 1 && rows[0].base === "http://hub-dev:8787/api/v1/bluepencil",
        `list --allow-insecure: unexpected rows ${JSON.stringify(rows)}`,
      );

      const invalid = run([
        "instances", "validate", "--registry", files.registryInsecure, "--allow-insecure=yes",
      ]);
      assertExit(invalid, 1, "instances validate --allow-insecure=yes");
      assertOneLineError(invalid, "instances validate --allow-insecure=yes");
      assert(
        invalid.stderr.includes("--allow-insecure must be true or false"),
        `stderr does not name the flag: ${JSON.stringify(invalid.stderr.trim())}`,
      );
    },

    "instances list --json survives a >64 KiB pipe": async () => {
      /* 700 rows of pretty-printed JSON is comfortably past the 64 KiB pipe chunk that a
       * `process.exit()` after writing truncates. The consumer is a real second process; parsing
       * its input proves the CLI did not exit before stdout was flushed. */
      const instances = Array.from({ length: 700 }, (_, index) => {
        const suffix = String(index).padStart(3, "0");
        return { id: `bulk-${suffix}`, base: `https://bulk-${suffix}.example`, app: "bulk" };
      });
      const large = join(WORKSPACE, "registry-large.json");
      writeJson(large, { schemaVersion: 1, instances });
      chmodSync(large, 0o600);

      const consumer = join(WORKSPACE, "consume-json.mjs");
      writeFileSync(
        consumer,
        [
          'let text = "";',
          'for await (const chunk of process.stdin) text += chunk;',
          "let value;",
          "try { value = JSON.parse(text); } catch (error) {",
          '  console.error(`invalid json: ${String(error.message)}`);',
          "  process.exit(1);",
          "}",
          "if (!Array.isArray(value) || value.length !== 700) {",
          "  console.error(`unexpected payload: ${Array.isArray(value) ? value.length : typeof value}`);",
          "  process.exit(1);",
          "}",
          'process.stdout.write("json ok\\n");',
          "",
        ].join("\n"),
        "utf8",
      );

      const piped = await runPipeline(
        ["instances", "list", "--registry", large, "--json"],
        consumer,
      );
      assert(piped.cliStatus === 0, `cli exited ${piped.cliStatus}: ${piped.cliStderr.trim().slice(0, 160)}`);
      assert(
        piped.consumerStatus === 0,
        `consumer exited ${piped.consumerStatus}: ${piped.consumerStderr.trim().slice(0, 160)}`,
      );
      assert(piped.consumerStdout.includes("json ok"), `consumer stdout was ${JSON.stringify(piped.consumerStdout.trim())}`);
    },
  };
}

// ---------------------------------------------------------------- run

setUpWorkspace();

let failed = 0;
let total = 0;
for (const [name, body] of Object.entries(cases())) {
  total += 1;
  try {
    const skipOrDetail = await body();
    if (typeof skipOrDetail === "string") {
      console.log(`PASS ${name} (${skipOrDetail})`);
    } else {
      console.log(`PASS ${name}`);
    }
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`cli-smoke: ${total - failed}/${total} case(s) passed in ${WORKSPACE}`);
process.exit(failed === 0 ? 0 : 1);
