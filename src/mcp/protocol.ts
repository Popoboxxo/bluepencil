/**
 * The MCP request handling itself, without a transport (FR-16.7/16.8).
 *
 * Both doors into the same note set run *this* code: the stdio server an agent starts as a child
 * process (`src/mcp/server.ts`) and `POST {base}/mcp` on the hub. Only the framing differs — one line
 * of JSON per message on a pipe, one request body per POST — so a tool cannot behave differently
 * depending on which door the agent came through.
 *
 * Protocol errors (JSON-RPC codes) stay reserved for the protocol itself: unparsable input
 * (-32700), unknown method (-32601), unknown tool/resource/prompt (-32602 — their names are
 * parameters of the call). Everything that is a *refusal* of a tool rather than a malformed request
 * is an `isError` tool result and comes back from `callTool` unchanged.
 */
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
import { VERSION } from "../version";

/** The revision this implementation speaks; `initialize` echoes the client's when it names one. */
export const PROTOCOL_VERSION = "2024-11-05";

/** Unparsable input: the id cannot be recovered, so its response carries `id: null`. */
export const PARSE_ERROR = -32700;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;

export interface RpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Where a transport puts its answers. `close` is stdio-only: `exit` means "end the process" when an
 * agent owns that process, and over HTTP there is nothing to end — a caller must never be able to
 * stop the hub it is talking to.
 */
export interface RpcTransport {
  reply(id: unknown, result: unknown): void;
  fail(id: unknown, code: number, message: string): void;
  close?(): void;
}

/** True for a request without a usable id — a notification, which must never be answered. */
export function isNotificationId(id: unknown): boolean {
  return id === undefined || id === null;
}

/** Parses one message; a parse failure is reported as such rather than guessed at. */
export function parseRpcPayload(text: string): { ok: true; request: RpcRequest } | { ok: false; message: string } {
  try {
    return { ok: true, request: JSON.parse(text) as RpcRequest };
  } catch {
    return { ok: false, message: "parse error" };
  }
}

/**
 * Handles one request and answers it through `transport`. Never throws for a bad request: an
 * unexpected failure inside a tool becomes an `isError` tool result (via `callTool`), and anything
 * else surfaces as an error response for a request that has an id.
 */
export async function handleRpc(
  request: RpcRequest,
  context: ToolContext,
  transport: RpcTransport,
): Promise<void> {
  const { id, method } = request;
  const params = request.params ?? {};
  const notification = isNotificationId(id);

  try {
    switch (method) {
      case "initialize": {
        const requested = params.protocolVersion;
        context.clientName =
          ((params.clientInfo as { name?: string } | undefined)?.name as string) ?? "mcp-client";
        transport.reply(id, {
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
        transport.reply(id, {});
        return;
      case "tools/list":
        transport.reply(id, {
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
          transport.fail(
            id,
            INVALID_PARAMS,
            `unknown tool "${name}" — known tools: ${TOOL_DEFINITIONS.map((tool) => tool.name).join(", ")}`,
          );
          return;
        }
        transport.reply(id, await callTool(context, name, args));
        return;
      }
      case "resources/list":
        transport.reply(id, { resources: listResources() });
        return;
      case "resources/read": {
        const uri = String(params.uri ?? "");
        const resource = await readResource(context, uri);
        if (!resource) {
          transport.fail(
            id,
            INVALID_PARAMS,
            `unknown resource "${uri}" — known resources: ${listResources().map((entry) => entry.uri).join(", ")}`,
          );
          return;
        }
        transport.reply(id, { contents: [resource] });
        return;
      }
      case "prompts/list":
        transport.reply(id, { prompts: listPrompts() });
        return;
      case "prompts/get": {
        const name = String(params.name ?? "");
        const prompt = listPrompts().find((entry) => entry.name === name);
        if (!prompt) {
          // F13: an unknown prompt is a protocol error, not ordinary prompt content.
          transport.fail(
            id,
            INVALID_PARAMS,
            `unknown prompt "${name}" — known prompts: ${listPrompts().map((entry) => entry.name).join(", ")}`,
          );
          return;
        }
        const result = getPrompt(name);
        transport.reply(id, {
          description: prompt.description,
          messages: result.content.map((content) => ({ role: "user", content })),
        });
        return;
      }
      case "shutdown":
        transport.reply(id, {});
        return;
      case "exit":
        // stdio only: an agent owns that process. Over HTTP the hub outlives the caller.
        if (transport.close !== undefined) {
          transport.close();
          return;
        }
        transport.fail(id, METHOD_NOT_FOUND, "exit is not available over HTTP — the hub keeps running");
        return;
      default:
        if (!notification) {
          transport.fail(id, METHOD_NOT_FOUND, `method not found: ${method}`);
        }
        return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (notification) {
      transport.fail(id, METHOD_NOT_FOUND, message);
    } else {
      transport.reply(id, errorResponse(message));
    }
  }
}

/**
 * One request in, one answer out — the shape `POST {base}/mcp` needs, where the caller sends a single
 * message and gets a single response (`null` for a notification, which is never answered).
 */
export async function handleRpcExchange(
  request: RpcRequest,
  context: ToolContext,
  onDiagnostic?: (message: string) => void,
): Promise<RpcResponse | null> {
  let response: RpcResponse | null = null;
  await handleRpc(request, context, {
    reply: (id, result) => {
      if (isNotificationId(id)) {
        return;
      }
      response = { jsonrpc: "2.0", id, result };
    },
    fail: (id, code, message) => {
      if (isNotificationId(id)) {
        onDiagnostic?.(`not answering a notification (${code} ${message})`);
        return;
      }
      response = { jsonrpc: "2.0", id, error: { code, message } };
    },
  });
  return response;
}
