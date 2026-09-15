#!/usr/bin/env node
/**
 * bluepencil CLI (FR-15.2, FR-14.7) — the headless way to inspect, validate, merge and exchange
 * note sets in a shell pipeline or CI. Exit codes are meaningful:
 *
 *   0  success
 *   1  usage/config error
 *   2  refused because of unresolved conflicts (nothing was written)
 *   3  refused because of an environment mismatch (NFR-18)
 *   4  invalid input (schema validation failed)
 *
 * It shares schema, validation and merge logic with the UI and the MCP server (FR-15.3) and has
 * no runtime dependencies (FR-15.4).
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createBundle, bundleToJson, inspectBundle } from "../data/bundle";
import { mergeNotes, type MergeMode } from "../data/merge";
import { migrateNote, migrateBundle } from "../data/migrate";
import { assertNote, validateBundle, validateNote } from "../data/schema";
import { canonicalBundle } from "../data/canonical";
import { toMarkdown } from "../core/export/markdown";
import {
  BluepencilValidationError,
  DEFAULT_ENVIRONMENT,
  isEnvironment,
  type Environment,
  type Note,
} from "../core/model";
import { VERSION, createBlueprint } from "../index";
import { createMemoryAdapter } from "../adapters/memory";

const EXIT = { ok: 0, usage: 1, conflict: 2, envMismatch: 3, invalid: 4 } as const;

interface Parsed {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgv(argv: string[]): Parsed {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const [key, inline] = body.split("=");
      if (inline !== undefined) {
        flags[key as string] = inline;
      } else if (key === "dry-run" || key === "json" || key === "include-done" || key === "allow-env-mismatch" || key === "write") {
        flags[key] = true;
      } else {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key as string] = next;
          i += 1;
        } else {
          flags[key as string] = true;
        }
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command, positionals, flags };
}

function fail(message: string, code: number = EXIT.usage): never {
  process.stderr.write(`bluepencil: ${message}\n`);
  process.exit(code);
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    fail(`cannot read ${path}: ${(error as Error).message}`);
  }
}

/** Accepts a bundle document or a bare Note[] — both are plain, documented JSON (NFR-19). */
function readNotes(text: string, path: string): { notes: Note[]; environment: Environment; app: { name: string; buildRef?: string } } {
  try {
    const value = JSON.parse(text) as unknown;
    if (Array.isArray(value)) {
      return {
        notes: value.map((entry) => migrateNote(entry)),
        environment: DEFAULT_ENVIRONMENT,
        app: { name: path },
      };
    }
    const bundle = migrateBundle(value);
    return { notes: bundle.notes, environment: bundle.environment, app: bundle.app };
  } catch (error) {
    const detail = error instanceof BluepencilValidationError ? error.issues.join("; ") : (error as Error).message;
    fail(`${path} is not a valid note set: ${detail}`, EXIT.invalid);
  }
}

/** Atomic write: the temp file lives in the target directory, so rename() never crosses a mount (FR-6.5). */
function writeAtomic(path: string, text: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

function print(value: unknown, asJson: boolean, fallback: string): void {
  process.stdout.write(asJson ? `${JSON.stringify(value, null, 2)}\n` : `${fallback}\n`);
}

function parseMode(flags: Record<string, string | boolean>): MergeMode {
  const mode = (flags.mode as string) ?? "merge";
  if (mode !== "merge" && mode !== "upsert" && mode !== "replace-session") {
    fail(`--mode must be merge, upsert or replace-session (got "${mode}")`);
  }
  return mode;
}

function parseEnvironment(flags: Record<string, string | boolean>, fallback: Environment): Environment {
  const value = flags.environment;
  if (value === undefined) {
    return fallback;
  }
  if (!isEnvironment(value)) {
    fail(`--environment must be one of dev, staging, live (got "${String(value)}")`);
  }
  return value;
}

const HELP = `bluepencil ${VERSION} — annotate any web app, work the notes off headlessly.

Usage:
  bluepencil inspect <file...>                 summarise a bundle or note set (nothing is written)
  bluepencil validate <file...>                schema-check a bundle or note set
  bluepencil merge <base> <incoming>           merge an incoming set into a base set
      [--mode merge|upsert|replace-session] [--dry-run] [--json]
      [--out <file>] [--on-conflict fail|keep-incoming|keep-existing]
      [--allow-env-mismatch] [--environment dev|staging|live]
  bluepencil export <input> [--format md|json] [--out <file>] [--include-done]
  bluepencil import <incoming> <target>        import a set into a target set (alias of merge --out target)
      [--mode ...] [--dry-run] [--json] [--on-conflict ...] [--allow-env-mismatch]
  bluepencil notes <file>                      print the notes of a file as JSON
  bluepencil mcp --store <file> --environment dev [--app name] [--allow-write]
  bluepencil --version | --help

Environment: BLUEPENCIL_ENVIRONMENT, BLUEPENCIL_STORE (defaults for mcp).
Exit codes: 0 ok, 1 usage, 2 conflicts (refused), 3 environment mismatch, 4 invalid input.`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv[0] === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const { command, positionals, flags } = parseArgv(argv);

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
        const text = readText(path);
        const bundle = migrateBundle(JSON.parse(text) as unknown);
        return { file: path, ...inspectBundle(bundle) };
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
          issues = [(error as Error).message];
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
      const { notes } = readNotes(readText(path), path);
      process.stdout.write(`${JSON.stringify(notes.map((note) => assertNote(note)), null, 2)}\n`);
      return;
    }

    case "export": {
      const input = positionals[0] ?? fail("export needs an input file");
      const { notes, environment, app } = readNotes(readText(input), input);
      const includeDone = flags["include-done"] !== false;
      const selected = includeDone ? notes : notes.filter((note) => note.status !== "done");
      const format = (flags.format as string) ?? "md";
      const output =
        format === "json"
          ? bundleToJson(
              createBundle(selected, {
                environment: parseEnvironment(flags, environment),
                app,
                exportedBy: `cli:${process.env.USER ?? "user"}`,
              }),
              { pretty: true },
            )
          : toMarkdown(selected, { includeDone, title: `${app.name} review notes` });
      if (typeof flags.out === "string") {
        writeAtomic(flags.out, output);
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
      if (!basePath || !incomingPath) {
        fail(`${command} needs a base file and an incoming file`);
      }
      const base = readNotes(readText(basePath), basePath);
      const incoming = readNotes(readText(incomingPath), incomingPath);
      const targetEnvironment = parseEnvironment(flags, base.environment);

      let result;
      try {
        result = mergeNotes(base.notes, incoming.notes, {
          mode: parseMode(flags),
          dryRun: flags["dry-run"] === true || command === "import",
          allowEnvMismatch: flags["allow-env-mismatch"] === true,
          targetEnvironment,
          ...(typeof flags["on-conflict"] === "string"
            ? { onConflict: flags["on-conflict"] as "fail" | "keep-incoming" | "keep-existing" }
            : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = /environment/i.test(message) ? EXIT.envMismatch : EXIT.conflict;
        fail(message, code);
      }

      const asJson = flags.json === true;
      print(
        {
          mode: parseMode(flags),
          dry_run: flags["dry-run"] === true || command === "import",
          added: result.added,
          updated: result.updated,
          skipped: result.skipped,
          removed: result.removed,
          conflicts: result.conflicts,
        },
        asJson,
        `${basePath} <- ${incomingPath}: +${result.added} added, ${result.updated} updated, ` +
          `${result.skipped} skipped, ${result.removed} removed, ${result.conflicts.length} conflict(s)`,
      );

      if (result.conflicts.length > 0) {
        process.exit(EXIT.conflict);
      }

      const writeTarget = typeof flags.out === "string" ? flags.out : command === "import" ? basePath : null;
      if (writeTarget && flags["dry-run"] !== true) {
        const bundle = canonicalBundle(
          createBundle(result.notes, {
            environment: targetEnvironment,
            app: base.app,
            exportedBy: `cli:${process.env.USER ?? "user"}`,
          }),
        );
        writeAtomic(writeTarget, bundleToJson(bundle, { pretty: true }));
        process.stderr.write(`bluepencil: wrote ${writeTarget} (${result.notes.length} note(s))\n`);
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

await main();
