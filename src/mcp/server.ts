#!/usr/bin/env node
/**
 * bluepencil MCP server over stdio (FR-16).
 *
 * This entry point owns only the store-specific setup: parse `--store/--environment/--app/
 * --allow-write/--session-id`, validate the file before serving (F9), build the store and its
 * persistence hooks, wrap them in the store backend and hand the loop to `stdio.ts` (shared with
 * the 0.10 federator). The protocol handling — framing, notifications, sequential execution — lives
 * in `stdio.ts` + `protocol.ts`, so the two doors into a note set cannot drift (FR-16.9).
 *
 * Safety (unchanged from 0.8):
 *   - read-only by default — write tools return a refusal unless `--allow-write` is passed (FR-16.2);
 *   - the session is bound to one store, one app and one environment; another environment's notes
 *     are neither listed, nor read by id, nor written (FR-16.3/NFR-18);
 *   - every agent write records `source=agent` plus client name and session id (FR-16.4);
 *   - the store file is validated before the first byte is served (F9): an existing file that is
 *     not a valid note set is reported and exits 2 instead of being served as "no notes";
 *   - a write is only answered as success after it was read back from the file (F7).
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { createStore } from "../core/store";
import { DEFAULT_ENVIRONMENT, isEnvironment, newId, type Environment } from "../core/model";
import { createStoreBackend } from "./backend";
import { createStorePersistence, validateStoredNoteSet } from "./tools";
import { runStdioServer } from "./stdio";
import { VERSION } from "../version";

interface ServerOptions {
  storePath: string;
  environment: Environment;
  appName: string;
  allowWrite: boolean;
  sessionId: string;
}

function parseArgs(argv: string[]): ServerOptions | string {
  const get = (flag: string): string | undefined => {
    const withEquals = argv.find((arg) => arg.startsWith(`${flag}=`));
    if (withEquals) return withEquals.slice(flag.length + 1);
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const storePath = get("--store") ?? process.env.BLUEPENCIL_STORE ?? "";
  if (!storePath) {
    return "--store <path> is required (a .bluepencil.json bundle or a bare notes array)";
  }
  const environment = (get("--environment") ?? process.env.BLUEPENCIL_ENVIRONMENT ?? DEFAULT_ENVIRONMENT) as string;
  if (!isEnvironment(environment)) {
    return `--environment must be one of dev, staging, live (got "${environment}")`;
  }
  const allowWrite = argv.includes("--allow-write") || process.env.BLUEPENCIL_ALLOW_WRITE === "1";
  return {
    storePath,
    environment,
    appName: get("--app") ?? process.env.BLUEPENCIL_APP ?? "unknown-app",
    allowWrite,
    sessionId: get("--session-id") ?? process.env.BLUEPENCIL_SESSION ?? newId("s"),
  };
}

let writeCounter = 0;

/**
 * Atomic write: temp file + rename, so an interrupted write never truncates the store (FR-6.5).
 * The temp name carries a per-process counter — two writes of the same process (a client may
 * pipeline requests, and an import rewrites the whole file) must never share a temp path, or one
 * rename could publish a blob that another write is still filling in.
 */
async function atomicWrite(path: string, text: string): Promise<void> {
  writeCounter += 1;
  const tmp = `${path}.tmp-${process.pid}-${writeCounter}`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}

async function readStore(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function failStartup(message: string, code: number): never {
  process.stderr.write(`bluepencil mcp: ${message}\n`);
  process.exit(code);
}

/** Reads the store file; an unreadable file is a startup failure, never an empty note set (F9). */
async function readStoreOrFail(path: string): Promise<string | null> {
  try {
    return await readStore(path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    failStartup(`cannot read ${path}: ${reason}`, 2);
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === "string") {
    failStartup(parsed, 1);
  }
  const options = parsed;

  // F9: the file is validated *before* the store is built, so a corrupt store is never served as an
  // empty one — the two are indistinguishable for a client, and "my notes are gone" is the worst
  // possible answer to a typo. A missing file stays the documented empty start.
  const stored = await readStoreOrFail(options.storePath);
  const invalid = validateStoredNoteSet(stored);
  if (invalid !== null) {
    failStartup(`${options.storePath} is not a valid note set: ${invalid}`, 2);
  }

  const { adapter, persistence } = createStorePersistence({
    read: () => readStore(options.storePath),
    write: (text: string) => atomicWrite(options.storePath, text),
  });

  const store = createStore({ environment: options.environment, adapter });
  await store.reload();

  const backend = createStoreBackend(store, {
    allowWrite: options.allowWrite,
    environment: options.environment,
    appName: options.appName,
    persistence,
    clientName: "mcp-client",
    sessionId: options.sessionId,
  });

  process.stderr.write(
    `bluepencil mcp v${VERSION} — store=${options.storePath} env=${options.environment} ` +
      `writes=${options.allowWrite ? "enabled" : "read-only"} session=${options.sessionId}\n`,
  );

  await runStdioServer({
    backend,
    appName: options.appName,
    allowWrite: options.allowWrite,
    sessionId: options.sessionId,
    persistence,
  });
}

await main();
