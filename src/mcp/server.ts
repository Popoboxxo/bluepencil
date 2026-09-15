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
 *   - the session is bound to one store, one app and one environment (FR-16.3);
 *   - every agent write records `source=agent` plus client name and session id (FR-16.4).
 *
 * stdio hygiene: MCP messages are newline-delimited JSON on stdout — diagnostics go to stderr.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { createStore } from "../core/store";
import { createFileAdapter } from "../adapters/file";
import { DEFAULT_ENVIRONMENT, isEnvironment, newId, type Environment } from "../core/model";
import {
  TOOL_DEFINITIONS,
  callTool,
  errorResponse,
  getPrompt,
  listPrompts,
  listResources,
  readResource,
  type ToolContext,
} from "./tools";

const VERSION = "0.1.0";
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

/** Atomic write: temp file + rename, so an interrupted write never truncates the store (FR-6.5). */
async function atomicWrite(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
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

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === "string") {
    process.stderr.write(`bluepencil mcp: ${parsed}\n`);
    process.exit(1);
  }
  const options = parsed;

  const store = createStore({
    environment: options.environment,
    adapter: createFileAdapter({
      read: () => readStore(options.storePath),
      write: (text: string) => atomicWrite(options.storePath, text),
    }),
  });

  await store.reload();

  const context: ToolContext = {
    store,
    allowWrite: options.allowWrite,
    environment: options.environment,
    appName: options.appName,
    clientName: "mcp-client",
    sessionId: options.sessionId,
  };

  process.stderr.write(
    `bluepencil mcp v${VERSION} — store=${options.storePath} env=${options.environment} ` +
      `writes=${options.allowWrite ? "enabled" : "read-only"} session=${options.sessionId}\n`,
  );

  const send = (message: unknown): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const reply = (id: unknown, result: unknown): void => send({ jsonrpc: "2.0", id, result });
  const fail = (id: unknown, code: number, message: string): void =>
    send({ jsonrpc: "2.0", id, error: { code, message } });

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line !== "") {
        void handleLine(line);
      }
    }
  });

  async function handleLine(line: string): Promise<void> {
    let request: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      request = JSON.parse(line) as typeof request;
    } catch {
      fail(null, -32700, "parse error");
      return;
    }
    const { id, method } = request;
    const params = request.params ?? {};
    const isNotification = id === undefined || id === null;

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
            fail(id, -32602, `unknown resource "${uri}"`);
            return;
          }
          reply(id, { contents: [resource] });
          return;
        }
        case "prompts/list":
          reply(id, { prompts: listPrompts() });
          return;
        case "prompts/get": {
          const result = getPrompt(String(params.name ?? ""));
          reply(id, {
            description: listPrompts().find((p) => p.name === params.name)?.description ?? "",
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
          if (!isNotification) {
            fail(id, -32601, `method not found: ${method}`);
          }
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isNotification) {
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
