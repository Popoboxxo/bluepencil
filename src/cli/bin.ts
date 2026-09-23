#!/usr/bin/env node
/**
 * bluepencil CLI (FR-15.2, FR-14.7) — the headless way to inspect, validate, merge and exchange
 * note sets in a shell pipeline or CI. Exit codes are meaningful:
 *
 *   0  success
 *   1  usage/config error
 *   2  refused because of unresolved conflicts (nothing was written)
 *   3  refused because of an environment mismatch (NFR-18)
 *   4  invalid input (unparseable JSON or schema validation failed)
 *
 * Two rules make the CLI safe to drive from a script:
 *
 *   1. Every failure leaves as a single `bluepencil: …` line on stderr and a documented exit
 *      code. A raw stack trace is only ever printed when `--debug` asks for it.
 *   2. The JSON report never contradicts the file system: `dry_run` is true exactly when nothing
 *      was written (no `--out` for `merge`, `--dry-run`, or a refusal), `applied` is its inverse
 *      and `out` names the file that was written.
 *
 * It shares schema, validation, filtering and merge logic with the UI and the MCP server
 * (FR-15.3) and has no runtime dependencies (FR-15.4).
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { bundleToJson, createBundle, inspectBundle } from "../data/bundle";
import { canonicalBundle } from "../data/canonical";
import { mergeNotes } from "../data/merge";
import type { MergeConflict, MergeMode, MergeResult } from "../data/merge";
import { migrateBundle, migrateNote } from "../data/migrate";
import { validateBundle, validateNote } from "../data/schema";
import { excludeDone, filterNotes, matchesFilter } from "../core/adapter";
import { toMarkdown } from "../core/export/markdown";
import { sortForReview } from "../core/protocol";
import {
  BUNDLE_KIND,
  BluepencilValidationError,
  DEFAULT_ENVIRONMENT,
  ENVIRONMENTS,
  NOTE_INTENTS,
  NOTE_STATUSES,
  NOTE_TYPES,
  SCHEMA_VERSION,
  isEnvironment,
  isNoteIntent,
  isNoteStatus,
  isNoteType,
  systemClock,
} from "../core/model";
import type { Bundle, Environment, Note, NoteFilter, Session } from "../core/model";
import { VERSION, createBlueprint } from "../index";
import { createMemoryAdapter } from "../adapters/memory";

const EXIT = { ok: 0, usage: 1, conflict: 2, envMismatch: 3, invalid: 4 } as const;

/** Who the CLI records as the exporter of the files it writes. */
const EXPORTED_BY = `cli:${process.env.USER ?? "user"}`;

type FlagValue = string | boolean;

interface Parsed {
  command: string;
  positionals: string[];
  flags: Record<string, FlagValue>;
}

/**
 * Flags that carry no value. Both `--include-done=false` and `--include-done false` are accepted
 * and coerced to a real boolean, so a flag can never be truthy-by-accident as the string "false"
 * (F11).
 */
const BOOLEAN_FLAGS = new Set([
  "dry-run",
  "json",
  "include-done",
  "allow-env-mismatch",
  "write",
  "allow-write",
  "debug",
]);

/** Collapses any value to a single stderr line — a message must never be a stack trace (F1/F8). */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The human-readable reason of any thrown value, without the duplicated `bluepencil:` prefix. */
function messageOf(error: unknown): string {
  const raw =
    error instanceof BluepencilValidationError
      ? error.issues.join("; ")
      : error instanceof Error
        ? error.message
        : String(error);
  return oneLine(raw.replace(/^bluepencil:\s*/, "")) || "unknown error";
}

function fail(message: string, code: number = EXIT.usage): never {
  process.stderr.write(`bluepencil: ${oneLine(message)}\n`);
  process.exit(code);
}

/** Refuses a document the strict read path could not validate (F14). */
function refuseIssues(path: string, issues: readonly string[]): void {
  if (issues.length === 0) return;
  fail(`${path} is not valid: ${issues.join("; ")}`, EXIT.invalid);
}

function parseBoolean(flag: string, value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  fail(`--${flag} must be true or false (got ${JSON.stringify(value)})`);
}

function parseArgv(argv: string[]): Parsed {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, FlagValue> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const equals = body.indexOf("=");
    const key = equals === -1 ? body : body.slice(0, equals);
    const inline = equals === -1 ? undefined : body.slice(equals + 1);
    if (inline !== undefined) {
      flags[key] = BOOLEAN_FLAGS.has(key) ? parseBoolean(key, inline) : inline;
      continue;
    }
    const next = rest[i + 1];
    if (BOOLEAN_FLAGS.has(key)) {
      // `--include-done false` is as valid as `--include-done=false`; anything else is the value.
      if (next === "true" || next === "false") {
        flags[key] = next === "true";
        i += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
      continue;
    }
    flags[key] = true;
  }
  return { command, positionals, flags };
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    fail(`cannot read ${path}: ${messageOf(error)}`);
  }
}

/**
 * Atomic write: the temp file lives in the target directory, so rename() never crosses a mount
 * (FR-6.5). The temp file is removed on *every* exit path — including a failed rename — so a
 * refused write can never leave litter behind (F8).
 */
function writeAtomic(path: string, text: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Turns a file system failure into the one-line, exit-1 contract of the CLI (F8). */
function writeFileOrFail(path: string, text: string): void {
  try {
    writeAtomic(path, text);
  } catch (error) {
    fail(`cannot write ${path}: ${messageOf(error)}`);
  }
}

function print(value: unknown, asJson: boolean, fallback: string): void {
  process.stdout.write(asJson ? `${JSON.stringify(value, null, 2)}\n` : `${fallback}\n`);
}

function parseMode(flags: Record<string, FlagValue>): MergeMode {
  const raw = flags.mode;
  if (raw === undefined) return "merge";
  if (raw === "merge" || raw === "upsert" || raw === "replace-session") return raw;
  fail(`--mode must be merge, upsert or replace-session (got ${JSON.stringify(String(raw))})`);
}

function parseOnConflict(
  flags: Record<string, FlagValue>,
): "fail" | "keep-incoming" | "keep-existing" | undefined {
  const raw = flags["on-conflict"];
  if (raw === undefined) return undefined;
  if (raw === "fail" || raw === "keep-incoming" || raw === "keep-existing") return raw;
  fail(`--on-conflict must be fail, keep-incoming or keep-existing (got ${JSON.stringify(String(raw))})`);
}

function parseEnvironmentFlag(
  flags: Record<string, FlagValue>,
  fallback: Environment | undefined,
): Environment | undefined {
  const raw = flags.environment;
  if (raw === undefined) return fallback;
  if (isEnvironment(raw)) return raw;
  fail(`--environment must be one of ${ENVIRONMENTS.join(", ")} (got ${JSON.stringify(String(raw))})`);
}

function parseFormat(flags: Record<string, FlagValue>): "md" | "json" {
  const raw = flags.format ?? "md";
  if (raw === "md" || raw === "json") return raw;
  fail(`--format must be md or json (got ${JSON.stringify(String(raw))})`);
}

/** The `--status/--intent/--type/--route` subset of the shared filter semantics (FR-15.3). */
function parseNoteFilter(flags: Record<string, FlagValue>): NoteFilter {
  const filter: NoteFilter = {};
  const status = flags.status;
  if (status !== undefined) {
    if (!isNoteStatus(status)) {
      fail(`--status must be one of ${NOTE_STATUSES.join(", ")} (got ${JSON.stringify(String(status))})`);
    }
    filter.status = status;
  }
  const intent = flags.intent;
  if (intent !== undefined) {
    if (!isNoteIntent(intent)) {
      fail(`--intent must be one of ${NOTE_INTENTS.join(", ")} (got ${JSON.stringify(String(intent))})`);
    }
    filter.intent = intent;
  }
  const type = flags.type;
  if (type !== undefined) {
    if (!isNoteType(type)) {
      fail(`--type must be one of ${NOTE_TYPES.join(", ")} (got ${JSON.stringify(String(type))})`);
    }
    filter.type = type;
  }
  const route = flags.route;
  if (route !== undefined) {
    if (typeof route !== "string" || route === "") {
      fail(`--route must be a non-empty string (got ${JSON.stringify(String(route))})`);
    }
    filter.route = route;
  }
  return filter;
}

/**
 * Option values are validated *before* any command acts on them, so an unknown value fails on
 * every code path — including `--format md`, which never touches the schema (F12).
 */
function validateOptions(flags: Record<string, FlagValue>): void {
  parseMode(flags);
  parseOnConflict(flags);
  parseEnvironmentFlag(flags, DEFAULT_ENVIRONMENT);
  parseFormat(flags);
  parseNoteFilter(flags);
}

/** A note set read from disk: the validated notes plus the document header they came with. */
interface NoteSet {
  bundle: Bundle;
  notes: Note[];
  environment: Environment;
  app: { name: string; buildRef?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Documents without a `schemaVersion` predate versioning and are the only ones migrated (F14). */
function isLegacy(doc: Record<string, unknown>): boolean {
  return doc.schemaVersion === undefined || doc.schemaVersion === null;
}

/**
 * Sessions referenced by the notes of a legacy bare `Note[]` — the readers keep this derivation
 * private, so the CLI mirrors it for the one input form that has no session header.
 */
function deriveSessions(notes: readonly Note[]): Session[] {
  const earliest = new Map<string, string>();
  for (const note of notes) {
    const ref = note.sessionRef;
    if (ref === undefined || ref === "") continue;
    const current = earliest.get(ref);
    if (current === undefined || note.createdAt < current) earliest.set(ref, note.createdAt);
  }
  return [...earliest.entries()].map(([ref, createdAt]) => ({ ref, label: ref, createdAt }));
}

/**
 * Strict read path (F14, and the CLI half of F9): plain JSON is parsed, a legacy document (one
 * without `schemaVersion`) is migrated to the current schema, and the value the CLI is about to
 * act on is then validated — an unknown enum, an empty body, a corrupt store or a document from a
 * newer schema version is refused with `is not valid: <issues>` (exit 4) instead of being silently
 * coerced. A missing file stays a usage error (exit 1).
 */
function readSet(path: string): NoteSet {
  const text = readText(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    fail(`${path} is not valid: JSON parse error: ${messageOf(error)}`, EXIT.invalid);
  }
  return Array.isArray(parsed) ? readNoteArray(path, parsed) : readBundleDocument(path, parsed);
}

function readBundleDocument(path: string, value: unknown): NoteSet {
  if (!isRecord(value)) {
    fail(`${path} is not valid: expected a bundle object or an array of notes`, EXIT.invalid);
  }
  let bundle: Bundle;
  if (isLegacy(value)) {
    try {
      bundle = migrateBundle(value);
    } catch (error) {
      fail(`${path} is not valid: ${messageOf(error)}`, EXIT.invalid);
    }
  } else {
    bundle = value as unknown as Bundle;
  }
  refuseIssues(path, validateBundle(bundle));
  return { bundle, notes: bundle.notes, environment: bundle.environment, app: bundle.app };
}

function readNoteArray(path: string, entries: readonly unknown[]): NoteSet {
  const issues: string[] = [];
  const notes: Note[] = [];
  entries.forEach((entry, index) => {
    if (isRecord(entry) && isLegacy(entry)) {
      try {
        const note = migrateNote(entry);
        issues.push(...validateNote(note).map((issue) => `notes[${index}]: ${issue}`));
        notes.push(note);
      } catch (error) {
        issues.push(`notes[${index}]: ${messageOf(error)}`);
      }
      return;
    }
    const found = validateNote(entry).map((issue) => `notes[${index}]: ${issue}`);
    if (found.length > 0) issues.push(...found);
    else notes.push(entry as Note);
  });
  refuseIssues(path, issues);
  // A bare `Note[]` carries its own environment tags; inventing `dev` for them would silently
  // re-tag a `live` note (FR-14.1/NFR-18). Derive it from the notes instead and let
  // createBundle refuse a mixed set — the same rule the UI/Blueprint path already applies.
  const found = [...new Set(notes.map((note) => note.environment))];
  const bundle: Bundle = {
    kind: BUNDLE_KIND,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: systemClock.now(),
    exportedBy: EXPORTED_BY,
    environment: found.length === 1 ? (found[0] as Environment) : DEFAULT_ENVIRONMENT,
    app: { name: basename(path) },
    sessions: deriveSessions(notes),
    notes,
  };
  return { bundle, notes, environment: bundle.environment, app: bundle.app };
}

/**
 * `--allow-env-mismatch` promotes the incoming notes to the target environment instead of
 * importing foreign ones (FR-14.8, docs/PROTOCOL.md §8): every note keeps its id, its thread and
 * its origin, only the `environment` tag moves. Without the promotion the merge would report an
 * `environment` divergence for every note and refuse to write (F3).
 */
function promoteIncoming(
  notes: Note[],
  target: Environment,
  allow: boolean,
): { notes: Note[]; promoted: number } {
  if (!allow) return { notes, promoted: 0 };
  const foreign = notes.filter((note) => note.environment !== target);
  if (foreign.length === 0) return { notes, promoted: 0 };
  const from = [...new Set(foreign.map((note) => note.environment))].sort();
  process.stderr.write(
    `bluepencil: promoting ${foreign.length} of ${notes.length} incoming note(s) ${from.join(", ")} -> ${target} (--allow-env-mismatch)\n`,
  );
  return {
    notes: notes.map((note) => (note.environment === target ? note : { ...note, environment: target })),
    promoted: foreign.length,
  };
}

const HELP = `bluepencil ${VERSION} — annotate any web app, work the notes off headlessly.

Usage:
  bluepencil inspect <file...>                 summarise a bundle or note set (nothing is written)
  bluepencil validate <file...>                schema-check a bundle or note set
  bluepencil merge <base> <incoming>           merge an incoming set into a base set
      [--mode merge|upsert|replace-session] [--dry-run] [--json]
      [--out <file>] [--on-conflict fail|keep-incoming|keep-existing]
      [--allow-env-mismatch] [--environment dev|staging|live]
  bluepencil export <input> [--format md|json] [--out <file>] [--include-done[=true|false]]
      [--status open|done|needs_decision] [--intent implement|feedback]
      [--type text|design] [--route <route>]
  bluepencil import <incoming> <target>        import a set into a target set (alias of merge --out target)
      [--mode ...] [--dry-run] [--json] [--on-conflict ...] [--allow-env-mismatch]
  bluepencil notes <file>                      print the notes of a file as JSON
  bluepencil mcp --store <file> --environment dev [--app name] [--allow-write]
  bluepencil --version | --help

Conflicts (merge/import):
  Without --on-conflict, an unresolved conflict refuses the write (exit 2, nothing is written).
  --on-conflict keep-incoming|keep-existing resolves the listed conflicts and lets the write
  happen; they are reported as "resolved_conflicts". --on-conflict fail still exits 2.

Reports (--json):
  dry_run is true exactly when nothing was written: no --out for merge, --dry-run, or a refusal.
  applied is its inverse and out names the file that was written. inspect/notes/export/validate
  never write unless --out is given.
  --allow-env-mismatch promotes the incoming notes to the target environment (id, thread and
  origin are kept) and reports the promotion on stderr.

Read path: a document without "schemaVersion" is migrated to the current schema, everything else
is validated exactly as written — invalid input is refused with exit 4.

Debugging: --debug rethrows an unexpected error with its stack trace instead of one line.

Environment: BLUEPENCIL_ENVIRONMENT, BLUEPENCIL_STORE (defaults for mcp).
Exit codes: 0 ok, 1 usage, 2 conflicts (refused), 3 environment mismatch, 4 invalid input.`;

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--version") || argv[0] === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const { command, positionals, flags } = parseArgv(argv);
  validateOptions(flags);

  switch (command) {
    case "help":
    case "--help":
    case "-h": {
      process.stdout.write(`${HELP}\n`);
      return;
    }

    case "inspect": {
      if (positionals.length === 0) fail("inspect needs at least one file");
      const summaries = positionals.map((path) => {
        const set = readSet(path);
        return { file: path, ...inspectBundle(set.bundle) };
      });
      print(
        summaries,
        flags.json === true,
        summaries
          .map(
            (s) =>
              `${s.file}: ${s.notes} note(s), ${s.sessions.length} session(s), environments: ${s.environments.join(", ")}\n` +
              `  status: ${JSON.stringify(s.byStatus)}  intent: ${JSON.stringify(s.byIntent)}  type: ${JSON.stringify(s.byType)}\n` +
              `  routes: ${s.routes.join(", ") || "(none)"}`,
          )
          .join("\n"),
      );
      return;
    }

    case "validate": {
      if (positionals.length === 0) fail("validate needs at least one file");
      let invalid = false;
      for (const path of positionals) {
        const text = readText(path);
        let issues: string[] = [];
        try {
          const value = JSON.parse(text) as unknown;
          if (Array.isArray(value)) {
            issues = value.flatMap((entry, index) =>
              validateNote(entry).map((issue) => `notes[${index}]: ${issue}`),
            );
          } else {
            issues = validateBundle(value);
          }
        } catch (error) {
          issues = [messageOf(error)];
        }
        if (issues.length === 0) {
          process.stdout.write(`${path}: valid\n`);
        } else {
          invalid = true;
          process.stdout.write(`${path}: ${issues.length} issue(s)\n${issues.map((i) => `  - ${i}`).join("\n")}\n`);
        }
      }
      process.exit(invalid ? EXIT.invalid : EXIT.ok);
    }

    case "notes": {
      const path = positionals[0] ?? fail("notes needs a file");
      const set = readSet(path);
      process.stdout.write(`${JSON.stringify(set.notes, null, 2)}\n`);
      return;
    }

    case "export": {
      const input = positionals[0] ?? fail("export needs an input file");
      const set = readSet(input);
      const includeDone = flags["include-done"] !== false;
      const format = parseFormat(flags);
      const filter = parseNoteFilter(flags);
      const effective: NoteFilter = {
        ...filter,
        ...(includeDone ? {} : { includeDone: false }),
      };
      // One predicate for UI, CLI, exports and MCP (FR-15.3) — the CLI never filters on its own.
      const selected = filterNotes(set.notes, effective);
      const dropped = set.notes.filter((note) => !matchesFilter(note, effective)).length;
      if (dropped > 0) {
        const reasons: string[] = [];
        if (!includeDone) reasons.push(`${set.notes.length - excludeDone(set.notes).length} done`);
        if (Object.keys(filter).length > 0) reasons.push("explicit filters");
        process.stderr.write(
          `bluepencil: ${selected.length} of ${set.notes.length} note(s) exported — ${dropped} hidden (${reasons.join(", ") || "filters"})\n`,
        );
      }
      const output =
        format === "json"
          ? bundleToJson(
              createBundle(selected, {
                // Only an explicit --environment re-tags the notes (a deliberate promotion,
                // FR-14.8); without the flag the notes' own tags decide, and a mixed set is
                // refused with exit 3 instead of being silently flattened to one environment.
                ...(parseEnvironmentFlag(flags, undefined) === undefined
                  ? {}
                  : { environment: parseEnvironmentFlag(flags, undefined) as Environment }),
                app: set.app,
                exportedBy: EXPORTED_BY,
                sessions: set.bundle.sessions,
              }),
              { pretty: true },
            )
          : // Selection already happened above, so the renderer must not filter again.
            toMarkdown(sortForReview(selected), { includeDone: true, title: `${set.app.name} review notes` });
      if (typeof flags.out === "string") {
        writeFileOrFail(flags.out, output);
        process.stderr.write(`bluepencil: wrote ${flags.out}\n`);
      } else {
        process.stdout.write(output);
      }
      return;
    }

    case "merge":
    case "import": {
      const [basePath, incomingPath] =
        command === "import" ? [positionals[1], positionals[0]] : [positionals[0], positionals[1]];
      if (basePath === undefined || incomingPath === undefined) {
        fail(`${command} needs a base file and an incoming file`);
      }
      const base = readSet(basePath);
      const incoming = readSet(incomingPath);
      // A merge/import always has a target, so a missing --environment falls back to the base
      // set's own environment (which readSet derived from the notes, not invented).
      const targetEnvironment = parseEnvironmentFlag(flags, base.environment) ?? DEFAULT_ENVIRONMENT;
      const mode = parseMode(flags);
      const onConflict = parseOnConflict(flags);
      const allowEnvMismatch = flags["allow-env-mismatch"] === true;
      const writeTarget =
        typeof flags.out === "string" ? flags.out : command === "import" ? basePath : null;
      const wantsWrite = writeTarget !== null && flags["dry-run"] !== true;

      const promotion = promoteIncoming(incoming.notes, targetEnvironment, allowEnvMismatch);

      let result: MergeResult;
      try {
        result = mergeNotes(base.notes, promotion.notes, {
          mode,
          // A merge that writes nothing only has to report conflicts, not refuse them here.
          dryRun: !wantsWrite,
          allowEnvMismatch,
          targetEnvironment,
          ...(onConflict !== undefined ? { onConflict } : {}),
        });
      } catch (error) {
        const message = messageOf(error);
        fail(message, /environment/i.test(message) ? EXIT.envMismatch : EXIT.conflict);
      }

      // A conflict resolved by an explicit policy no longer blocks the write (F2).
      const resolvedByPolicy = onConflict === "keep-incoming" || onConflict === "keep-existing";
      const resolvedConflicts: MergeConflict[] = resolvedByPolicy ? result.conflicts : [];
      const unresolvedConflicts: MergeConflict[] = resolvedByPolicy ? [] : result.conflicts;
      const refused = unresolvedConflicts.length > 0;

      let written = false;
      if (wantsWrite && !refused && writeTarget !== null) {
        // Built before the file system is touched, so a build error cannot follow a write report.
        const bundle = canonicalBundle(
          createBundle(result.notes, {
            environment: targetEnvironment,
            app: base.app,
            exportedBy: EXPORTED_BY,
          }),
        );
        writeFileOrFail(writeTarget, bundleToJson(bundle, { pretty: true }));
        written = true;
      }

      const report = {
        mode,
        dry_run: !written,
        applied: written,
        out: writeTarget,
        promoted: promotion.promoted,
        added: result.added,
        updated: result.updated,
        skipped: result.skipped,
        removed: result.removed,
        conflicts: unresolvedConflicts,
        resolved_conflicts: resolvedConflicts,
      };
      print(
        report,
        flags.json === true,
        `${basePath} <- ${incomingPath}: +${result.added} added, ${result.updated} updated, ` +
          `${result.skipped} skipped, ${result.removed} removed, ` +
          `${resolvedConflicts.length} resolved conflict(s), ${unresolvedConflicts.length} unresolved conflict(s)` +
          `${written ? `, wrote ${String(writeTarget)}` : ", nothing written"}`,
      );

      if (written && writeTarget !== null) {
        process.stderr.write(`bluepencil: wrote ${writeTarget} (${result.notes.length} note(s))\n`);
      }
      if (refused) {
        process.exit(EXIT.conflict);
      }
      return;
    }

    case "mcp": {
      // The MCP server owns its own argument parsing (--store, --environment, --allow-write).
      await import("../mcp/server");
      return;
    }

    case "demo": {
      // Small self-check used by the docs and CI smoke tests.
      const blueprint = createBlueprint({
        adapter: createMemoryAdapter(),
        autoEnable: false,
        enabled: () => false,
        language: "en",
      });
      await blueprint.store.create({
        type: "text",
        body: "demo note from the CLI",
        anchor: { hook: "demo" },
        author: "cli",
        source: "cli:import",
      });
      process.stdout.write(blueprint.export({ format: "markdown" }));
      await blueprint.destroy();
      return;
    }

    default:
      fail(`unknown command "${command}" — try "bluepencil --help"`);
  }
}

/**
 * Runs the CLI and turns any unexpected error into the documented one-line failure (F1).
 * `--debug` is accepted anywhere on the command line and rethrows the original error, so the
 * stack trace stays available to whoever is debugging the CLI itself.
 */
async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const debug = argv.some((arg) => arg === "--debug" || arg === "--debug=true");
  // A broken pipe (`| head`) or a full disk surfaces as an `error` *event* on the stream, not as a
  // thrown error; without these handlers Node prints a stack trace and exits instead (F1).
  process.stdout.on("error", (error: unknown) => failStream(error, debug));
  process.stderr.on("error", (error: unknown) => failStream(error, debug));
  try {
    await main(argv.filter((arg) => arg !== "--debug"));
  } catch (error) {
    if (debug) throw error;
    const message = messageOf(error);
    process.stderr.write(`bluepencil: ${message}\n`);
    // An environment refusal is a documented pipeline outcome (exit 3), not a usage error: the
    // command was well-formed, the *data* spanned two environments. Before, exporting a mixed set
    // exited 1 even though `--help` promises 3 for exactly this case.
    process.exit(/environment/i.test(message) ? EXIT.envMismatch : EXIT.usage);
  }
}

/** One-line report for a failed stream write; the message is best effort, the exit code is not. */
function failStream(error: unknown, debug: boolean): never {
  if (debug) throw error;
  try {
    process.stderr.write(`bluepencil: ${messageOf(error)}\n`);
  } catch {
    // stderr is broken as well; the exit code still has to be the documented one.
  }
  process.exit(EXIT.usage);
}

await run();
