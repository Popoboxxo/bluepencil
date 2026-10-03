/**
 * The MCP door on the hub: `POST {base}/mcp` (FR-16.8/16.9).
 *
 * The same note set the browser writes to, reachable by an agent without a child process:
 * `bluepencil mcp` (stdio) and this route run the *same* protocol handling (`src/mcp/protocol.ts`)
 * over the *same* store file. Two doors, one store — a note created in the browser shows up in the
 * agent's next call and vice versa, because both write through the hub's atomic write path and the
 * hub re-reads the store before each request.
 *
 * Transport decisions, and why:
 *   - **POST only.** The streamable-HTTP revision allows a GET for server-initiated messages; this
 *     hub has none (no progress notifications, no subscriptions), so a GET would only be a second
 *     way to say nothing. It is refused with 405.
 *   - **No sessions.** Every request carries everything it needs. A session id in the
 *     `mcp-session-id` header is honoured when a client sends one, because the notes record it, but
 *     nothing depends on it.
 *   - **JSON, not SSE.** One request, one JSON answer.
 *   - `exit` cannot stop the hub: a caller must never be able to shut down the service it is talking
 *     to (the protocol core refuses it over this door).
 */
import type { Store } from "../src/core/store";
import { createStore } from "../src/core/store";
import { VERSION } from "../src/version";
import {
  createStorePersistence,
  TOOL_DEFINITIONS,
  type StoreFileIo,
  type ToolContext,
} from "../src/mcp/tools";
import {
  PARSE_ERROR,
  PROTOCOL_VERSION,
  handleRpcExchange,
  isNotificationId,
  parseRpcPayload,
  type RpcResponse,
} from "../src/mcp/protocol";
import {
  JSON_CONTENT_TYPE,
  authorize,
  corsHeaders,
  normalizeBase,
  requestPath,
  type HandlerContext,
  type ServerRequest,
  type ServerResponse,
} from "./handler";

/** Name recorded for an MCP write when the client did not introduce itself over this door. */
const DEFAULT_CLIENT = "hub-mcp-client";
/** Session id recorded when a client sends no `mcp-session-id`. */
const DEFAULT_SESSION = "hub-mcp";

function answer(
  status: number,
  body: unknown,
  context: HandlerContext,
  extra: Record<string, string> = {},
): ServerResponse {
  const cors = corsHeaders(context.cors);
  return {
    status,
    headers: {
      "content-type": JSON_CONTENT_TYPE,
      "cache-control": "no-store",
      ...cors,
      ...extra,
    },
    body: body === null ? "" : JSON.stringify(body),
  };
}

/** True when the message asks for a write, so the gate can demand a write-scoped credential. */
function needsWrite(body: string): boolean {
  const parsed = parseRpcPayload(body);
  if (!parsed.ok || parsed.request.method !== "tools/call") {
    return false;
  }
  const name = String(parsed.request.params?.name ?? "");
  return TOOL_DEFINITIONS.some((tool) => tool.name === name && tool.write);
}

/** The request headers, as `node:http` hands them over. */
type RequestHeaders = Record<string, string | string[] | undefined>;

/** The client name a request carries, if any — the notes record it (FR-16.4). */
function clientNameOf(headers: RequestHeaders): string {
  const value = headers["x-bluepencil-client"];
  const name = Array.isArray(value) ? value[0] : value;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : DEFAULT_CLIENT;
}

function sessionIdOf(headers: RequestHeaders): string {
  const value = headers["mcp-session-id"];
  const session = Array.isArray(value) ? value[0] : value;
  return typeof session === "string" && session.trim() !== "" ? session.trim() : DEFAULT_SESSION;
}

/**
 * Answers a request to `{base}/mcp`, or returns `null` when the path is not the MCP door — so the
 * caller can simply fall through to the notes API.
 *
 * `io` is the store medium, handed in by the host exactly like the stdio server hands in its own:
 * the hub passes its own read/atomic-write functions, which is what makes both doors write the same
 * file in the same format (FR-16.9).
 */
export async function handleMcpRoute(
  request: ServerRequest,
  context: HandlerContext,
  io: StoreFileIo,
): Promise<ServerResponse | null> {
  const base = normalizeBase(context.base);
  const path = requestPath(request.url);
  const relative =
    base === "" ? path : path === base ? "/" : path.startsWith(`${base}/`) ? path.slice(base.length) : null;
  const headers: RequestHeaders = request.headers ?? {};
  const body = request.body ?? "";
  const method = (request.method ?? "GET").toUpperCase();
  if (relative !== "/mcp" && relative !== "/mcp/") {
    return null;
  }

  if (method !== "POST") {
    return answer(
      405,
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32600,
          message: `MCP over HTTP is POST-only on this hub (no server-initiated messages) — got ${method}`,
        },
      },
      context,
      { allow: "POST" },
    );
  }

  // The revision a client claims has to be the one this hub speaks; guessing would mean answering a
  // dialect nobody agreed on. Absent is accepted: the protocol has a default and most clients omit it.
  const claimed = headers["mcp-protocol-version"];
  const claimedVersion = Array.isArray(claimed) ? claimed[0] : claimed;
  if (typeof claimedVersion === "string" && claimedVersion !== PROTOCOL_VERSION) {
    return answer(
      400,
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32600,
          message:
            `unsupported MCP-Protocol-Version "${claimedVersion}" — this hub speaks ${PROTOCOL_VERSION}`,
        },
      },
      context,
    );
  }

  // Identity first, privilege second: a caller that cannot authenticate at all learns nothing about
  // the message, and a read-scoped device is not turned away from read tools merely because a POST
  // looks like a write.
  const identity = authorize(request, context, "read");
  if (identity !== null) {
    return identity;
  }
  if (needsWrite(body)) {
    const privilege = authorize(request, context, "write");
    if (privilege !== null) {
      return privilege;
    }
  }

  const parsed = parseRpcPayload(body);
  if (!parsed.ok) {
    return answer(
      400,
      { jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: parsed.message } },
      context,
    );
  }

  const { adapter, persistence } = createStorePersistence(io);
  const store: Store = createStore({ adapter, environment: context.environment });
  await store.reload();

  const toolContext: ToolContext = {
    store,
    // A read-only hub refuses writes here as well, and it does so the way MCP requires: as a refusal
    // of the tool (`isError`), not as a broken protocol message.
    allowWrite: context.readOnly !== true,
    environment: context.environment,
    appName: context.appName ?? "bluepencil hub",
    clientName: clientNameOf(headers),
    sessionId: sessionIdOf(headers),
    persistence,
    ...(context.now === undefined ? {} : { now: context.now }),
  };

  let response: RpcResponse | null;
  try {
    response = await handleRpcExchange(parsed.request, toolContext, (message) => {
      process.stderr.write(`bluepencil server: mcp ${message}\n`);
    });
  } finally {
    await store.destroy();
  }

  if (response === null || isNotificationId(parsed.request.id)) {
    // A notification is executed but never answered (JSON-RPC 2.0); the streamable-HTTP transport
    // says the same thing with a 202 and an empty body.
    return { status: 202, headers: { ...corsHeaders(context.cors) }, body: "" };
  }
  return answer(200, response, context);
}

/** The revision this hub speaks, as a client would have to send it. */
export const MCP_PROTOCOL_VERSION = PROTOCOL_VERSION;
export const HUB_VERSION = VERSION;
