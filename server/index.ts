#!/usr/bin/env node
/**
 * bluepencil hub — build entry point (`dist/server.js`).
 *
 * The implementation lives in `server/hub.ts` (store, static serving, journal, CLI parsing); this
 * module keeps the process boundary thin: help/version, argv parsing, signal handlers, start, and
 * the documented exit codes. It also re-exports the public surface tests, `package.json`'s
 * `./server` entry and existing consumers rely on, so splitting the implementation changed no
 * import path.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SERVER_VERSION } from "./handler";
import { HELP, StoreFileError, flushHubJournal, parseHubArgs, startHub } from "./hub";

export type { FileNoteStore, HubOptions, RunningServer, ServerOptions } from "./hub";
export {
  DEFAULT_HOST,
  DEFAULT_PORT,
  MAX_BODY_BYTES,
  StoreFileError,
  createFileStore,
  loadNotes,
  parseNoteSet,
} from "./hub";
export { startHub as startServer, parseHubArgs as parseServerArgs } from "./hub";

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(message: string, code: number): never {
  process.stderr.write(`bluepencil server: ${oneLine(message)}\n`);
  process.exit(code);
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (argv.includes("--version")) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }
  const parsed = parseHubArgs(argv);
  if (typeof parsed === "string") {
    fail(parsed, 1);
  }
  // A coalescing journal holds a batch back; a signal must not lose it.
  const flushAndExit = (signal: string): void => {
    flushHubJournal();
    if (!argv.includes("--quiet")) {
      process.stderr.write(`bluepencil server: ${signal} — journal flushed\n`);
    }
    process.exit(0);
  };
  process.once("SIGINT", () => flushAndExit("SIGINT"));
  process.once("SIGTERM", () => flushAndExit("SIGTERM"));
  try {
    await startHub(parsed);
  } catch (error) {
    // A usage failure is exit 1, an unreadable/corrupt store file is exit 2 (as the MCP server).
    fail(errorText(error), error instanceof StoreFileError ? 2 : 1);
  }
}

/**
 * True when this module is the process entry point.
 *
 * npm installs `node_modules/.bin/<bin>` as a symlink, so `argv[1]` is the symlink while
 * `import.meta.url` is Node's realpath of the target. Comparing the URL strings would therefore
 * be false and the bin would exit 0 without doing anything — a silent no-op. Compare real paths
 * instead; a failed resolution (missing file, broken link) means "not the entry point".
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // Only the real entry point starts a server; importing this module (tests) never does.
  void main(process.argv.slice(2));
}
