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
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
/** A body that only the `done` note carries, so "is it hidden?" is unambiguous. */
const DONE_MARKER = "SMOKE-DONE-MARKER must be hidden by --include-done=false";
const KEEP_MARKER = "SMOKE-INCOMING-CONTENT applied by --on-conflict keep-incoming";

/** The shortest shape that passes `validateNote` — one factory for every fixture. */
function note(id, body, status, environment) {
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
  target: join(WORKSPACE, "target.json"),
  conflict: join(WORKSPACE, "conflict.json"),
  live: join(WORKSPACE, "live.json"),
  add: join(WORKSPACE, "add.json"),
  truncated: join(WORKSPACE, "truncated.json"),
  newer: join(WORKSPACE, "newer.json"),
  badEnum: join(WORKSPACE, "bad-enum.json"),
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
  writeJson(files.badEnum, {
    ...dev,
    notes: dev.notes.map((entry, index) => (index === 0 ? { ...entry, intent: "bogus-intent" } : entry)),
  });

  // Truncated JSON: a valid document cut in half, so the parser reports a real syntax error.
  const text = `${JSON.stringify(dev, null, 2)}\n`;
  writeFileSync(files.truncated, text.slice(0, Math.floor(text.length / 2)), "utf8");

  mkdirSync(files.dir, { recursive: true });
}

/** Every case starts from the same dev baseline, so the cases stay independent. */
function resetTarget() {
  writeJson(files.target, bundle(devNotes(), "dev"));
  return sha256(files.target);
}

// ---------------------------------------------------------------- helpers

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
  return {
    status: result.status === null ? -1 : result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
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
  };
}

// ---------------------------------------------------------------- run

setUpWorkspace();

let failed = 0;
let total = 0;
for (const [name, body] of Object.entries(cases())) {
  total += 1;
  try {
    const skipOrDetail = body();
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
