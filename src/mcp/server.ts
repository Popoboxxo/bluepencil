#!/usr/bin/env node
/**
 * bluepencil MCP server (FR-16).
 *
 * A dependency-free JSON-RPC 2.0 server over stdio: agents read the note set, answer notes and
 * move bundles without a browser. It is a thin wrapper over `src/data` + the store, so MCP and
 * CLI behave identically for the same input (FR-15.5/16.7).
 *
 * Usage:
 *   bluepencil mcp --store notes.bluepencil.json --environment dev [--app "my-tool"] [--allow-write]
 *
 * Safety:
 *   - read-only by default — write tools return a refusal unless `--allow-write` is passed (FR-16.2);
 *   - the session is bound to one store, one app and one environment; another environment's notes
 *     are neither listed, nor read by id, nor written (FR-16.3/NFR-18);
 *   - every agent write records `source=agent` plus client name and session id (FR-16.4);
 *   - the store file is validated before the first byte is served (F9): an existing file that is
 *     not a valid note set is reported and exits 2 instead of being served as "no notes";
 *   - a write is only answered as success after it was read back from the file (F7).
 *
 * stdio hygiene:
 *   - MCP messages are newline-delimited JSON on stdout — diagnostics go to stderr;
 *   - a request without an `id` is a notification: it is executed, but a response frame is never
 *     written for it (JSON-RPC 2.0 forbids the id-less response such a frame would be).
 *
 * Protocol errors (JSON-RPC codes) are reserved for the protocol itself: unknown method
 * (-32601), unparsable input (-32700), unknown tool, resource or prompt (-32602 — the tool name
 * and the resource/prompt name are parameters of the call). Everything that is a *refusal* of a
 * tool rather than a malformed request — read-only session, environment binding, validation of an
 * argument, unresolved import conflict, a write that did not persist — is an `isError` tool result
 * with an actionable message, as the tool contract requires.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { createStore } from "../core/store";
import { DEFAULT_ENVIRONMENT, isEnvironment, newId, type Environment } from "../core/model";
import {
  TOOL_DEFINITIONS,
  callTool,
  createStorePersistence,
  errorResponse,
  getPrompt,
  listPrompts,
  listResources,
  readResource,
  validateStoredNoteSet,
  type ToolContext,
} from "./tools";
import { VERSION } from "../version";
const PROTOCOL_VERSION = "2024-11-05";

for (const level of ["debug", "info", "log", "warn"] as const) {
  // stdout belongs to the protocol — everything else goes to stderr.
  console[level] = (...args: unknown[]) => {
    process.stderr.write(`${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
  };
}

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

  const context: ToolContext = {
    store,
    allowWrite: options.allowWrite,
    environment: options.environment,
    appName: options.appName,
    clientName: "mcp-client",
    sessionId: options.sessionId,
    persistence,
  };

  process.stderr.write(
    `bluepencil mcp v${VERSION} — store=${options.storePath} env=${options.environment} ` +
      `writes=${options.allowWrite ? "enabled" : "read-only"} session=${options.sessionId}\n`,
  );

  const send = (message: unknown): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  /** True for a request without a usable id — a notification, which must never be answered. */
  const isNotification = (id: unknown): boolean => id === undefined || id === null;
  const reply = (id: unknown, result: unknown): void => {
    if (isNotification(id)) {
      return;
    }
    send({ jsonrpc: "2.0", id, result });
  };
  const fail = (id: unknown, code: number, message: string): void => {
    if (isNotification(id)) {
      // This is the F13 defect: an id-less error frame is not a valid JSON-RPC message.
      process.stderr.write(`bluepencil mcp: not answering a notification (${code} ${message})\n`);
      return;
    }
    send({ jsonrpc: "2.0", id, error: { code, message } });
  };

  let buffer = "";
  // Requests are handled in arrival order: one JSON-RPC response at a time, and no two tool calls
  // (each of which may write the whole store file) run against each other.
  let handling: Promise<void> = Promise.resolve();
  const enqueue = (line: string): void => {
    handling = handling.then(
      () => handleLine(line),
      () => handleLine(line),
    );
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line !== "") {
        enqueue(line);
      }
    }
  });

  async function handleLine(line: string): Promise<void> {
    let request: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      request = JSON.parse(line) as typeof request;
    } catch {
      // An id cannot be recovered from unparsable input; a parse-error response carries id null.
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    const { id, method } = request;
    const params = request.params ?? {};
    const notification = isNotification(id);

    try {
      switch (method) {
        case "initialize": {
          const requested = params.protocolVersion;
          context.clientName =
            ((params.clientInfo as { name?: string } | undefined)?.name as string) ?? "mcp-client";
          reply(id, {
            protocolVersion: typeof requested === "string" ? requested : PROTOCOL_VERSION,
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
              prompts: { listChanged: false },
            },
            serverInfo: { name: "bluepencil", version: VERSION },
            instructions:
              "Annotated review notes for one app in one environment. Read bluepencil://notes first: it " +
              "opens with the exception sections (open decisions, feedback only) that constrain everything " +
              "else. Writes are disabled unless the session was started with --allow-write; never invent a " +
              "human decision.",
          });
          return;
        }
        case "notifications/initialized":
        case "notifications/cancelled":
        case "logging/setLevel":
          return;
        case "ping":
          reply(id, {});
          return;
        case "tools/list":
          reply(id, {
            tools: TOOL_DEFINITIONS.map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema,
            })),
          });
          return;
        case "tools/call": {
          const name = String(params.name ?? "");
          const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
          // Unknown tool name: a protocol error (its name is an invalid parameter of the call), not
          // a tool result — every *refusal* of a known tool stays an isError tool result below.
          if (!TOOL_DEFINITIONS.some((tool) => tool.name === name)) {
            fail(id, -32602, `unknown tool "${name}" — known tools: ${TOOL_DEFINITIONS.map((tool) => tool.name).join(", ")}`);
            return;
          }
          reply(id, await callTool(context, name, args));
          return;
        }
        case "resources/list":
          reply(id, { resources: listResources() });
          return;
        case "resources/read": {
          const uri = String(params.uri ?? "");
          const resource = await readResource(context, uri);
          if (!resource) {
            fail(id, -32602, `unknown resource "${uri}" — known resources: ${listResources().map((entry) => entry.uri).join(", ")}`);
            return;
          }
          reply(id, { contents: [resource] });
          return;
        }
        case "prompts/list":
          reply(id, { prompts: listPrompts() });
          return;
        case "prompts/get": {
          const name = String(params.name ?? "");
          const prompt = listPrompts().find((entry) => entry.name === name);
          if (!prompt) {
            // F13: an unknown prompt is a protocol error, not ordinary prompt content.
            fail(id, -32602, `unknown prompt "${name}" — known prompts: ${listPrompts().map((entry) => entry.name).join(", ")}`);
            return;
          }
          const result = getPrompt(name);
          reply(id, {
            description: prompt.description,
            messages: result.content.map((content) => ({ role: "user", content })),
          });
          return;
        }
        case "shutdown":
          reply(id, {});
          return;
        case "exit":
          process.exit(0);
          return;
        default:
          if (!notification) {
            fail(id, -32601, `method not found: ${method}`);
          }
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (notification) {
        process.stderr.write(`bluepencil mcp: ${message}\n`);
      } else {
        reply(id, errorResponse(message));
      }
    }
  }

  process.stdin.on("end", () => {
    void store.destroy().finally(() => process.exit(0));
  });
}

await main();
