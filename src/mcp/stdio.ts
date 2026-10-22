/**
 * The shared stdio loop (FR-16, PR 1).
 *
 * Both `bluepencil mcp` and (0.10, PR 6) the federator speak newline-delimited JSON-RPC 2.0 over
 * stdin/stdout. Only the backend differs; the framing, the notification rule, the sequential
 * processing and the shutdown path must not. This module owns them once (FR-15.3).
 *
 * stdio hygiene:
 *   - MCP messages are newline-delimited JSON on stdout — diagnostics go to stderr;
 *   - a request without an `id` is a notification: it is executed, but a response frame is never
 *     written for it (JSON-RPC 2.0 forbids the id-less response such a frame would be);
 *   - requests are handled in arrival order: one response at a time, and no two tool calls (each of
 *     which may write the whole store file) run against each other;
 *   - `end` on stdin closes the backend and exits 0.
 */
import type { McpBackend } from "./backend";
import {
  PARSE_ERROR,
  handleRpc,
  isNotificationId,
  parseRpcPayload,
  type RpcTransport,
} from "./protocol";
import type { McpPersistence, ToolContext } from "./tools";

export interface StdioOptions {
  backend: McpBackend;
  appName: string;
  allowWrite: boolean;
  sessionId: string;
  /** Identity shown by clients; the protocol core currently speaks as `bluepencil`. */
  serverName?: string;
  /**
   * Host hook for the write-failure diagnostic (F7). The store backend already owns it; a
   * federation backend has no local medium and may omit it.
   */
  persistence?: McpPersistence;
}

// stdout belongs to the protocol — everything else goes to stderr. This has to be in effect from
// module load, not only from `runStdioServer`: startup diagnostics (store validation, an adapter
// warning during the first reload) happen before the loop starts and must never reach stdout.
for (const level of ["debug", "info", "log", "warn"] as const) {
  console[level] = (...args: unknown[]) => {
    process.stderr.write(`${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
  };
}

/**
 * Builds the tool context of a stdio session.
 *
 * The client name lives on the backend (it is part of the {@link McpBackend} contract), so
 * `initialize` and the tools observe the same identity: provenance on writes and `exportedBy` in
 * bundles stay consistent (FR-16.4, F1/F6).
 */
export function createStdioToolContext(options: StdioOptions): ToolContext {
  return {
    backend: options.backend,
    allowWrite: options.allowWrite,
    ...(options.backend.environment === undefined ? {} : { environment: options.backend.environment }),
    appName: options.appName,
    get clientName(): string {
      return options.backend.clientName;
    },
    set clientName(value: string) {
      options.backend.clientName = value;
    },
    sessionId: options.sessionId,
    ...(options.persistence === undefined ? {} : { persistence: options.persistence }),
  };
}

export async function runStdioServer(options: StdioOptions): Promise<void> {
  const send = (message: unknown): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  const context = createStdioToolContext(options);

  const transport: RpcTransport = {
    reply: (id, result) => {
      if (isNotificationId(id)) {
        return;
      }
      send({ jsonrpc: "2.0", id, result });
    },
    fail: (id, code, message) => {
      if (isNotificationId(id)) {
        // F13: an id-less error frame is not a valid JSON-RPC message.
        process.stderr.write(`bluepencil mcp: not answering a notification (${code} ${message})\n`);
        return;
      }
      send({ jsonrpc: "2.0", id, error: { code, message } });
    },
    close: () => process.exit(0),
  };

  async function handleLine(line: string): Promise<void> {
    const parsed = parseRpcPayload(line);
    if (!parsed.ok) {
      // An id cannot be recovered from unparsable input; a parse-error response carries id null.
      send({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: parsed.message } });
      return;
    }
    await handleRpc(parsed.request, context, transport);
  }

  let buffer = "";
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

  process.stdin.on("end", () => {
    void options.backend.close().finally(() => process.exit(0));
  });
}
