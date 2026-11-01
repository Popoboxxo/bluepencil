/**
 * CORS metadata for the hub's doors — the notes API, the MCP route and the optional admin surface.
 *
 * One vocabulary rather than one per route: a browser sends the same preflight for all of them, and
 * two lists that drift apart turn into "the notes API works but the admin route does not" for a
 * reason nobody can see in the network tab.
 *
 * This module imports nothing on purpose. `server/handler.ts` re-exports it, `server/hub.ts` and
 * `server/mcp.ts` import it from there, and `server/admin.ts` imports it directly — keeping the
 * function dependency-free is what makes that last edge safe instead of a runtime cycle.
 *
 * `preflightResponse` is the one implementation of an `OPTIONS` answer, used by every door that can
 * be reached cross-origin: the notes router, the MCP route, the admin surface and the static site
 * (#102). Each caller names the methods *it* documents, and that list is the preflight's answer —
 * `/mcp` advertises `POST, OPTIONS`, `/health` advertises `GET, HEAD, OPTIONS`. Routing still
 * happens in the caller, so a path that is not part of the API keeps its 404 rather than becoming
 * an empty preflight answer.
 */

/**
 * Every header any caller of this API actually sends, or the browser drops it before the request
 * leaves: `Authorization` (signed token), `x-bluepencil-auth` (shared secret, #99 — without it an
 * authenticated cross-origin pairing fails after the preflight passes), and the identity/session
 * pair both MCP and the notes API record (`x-bluepencil-client`, `mcp-session-id`,
 * `x-bluepencil-actor` for the journal). Header names match case-insensitively.
 */
const ALLOW_HEADERS: readonly string[] = [
  "Content-Type",
  "Authorization",
  "X-Bluepencil-Auth",
  "X-Bluepencil-Client",
  "X-Bluepencil-Actor",
  "Mcp-Session-Id",
  "MCP-Protocol-Version",
];

/**
 * The method list a preflight advertises: the caller's documented methods *are* the answer, plus
 * `OPTIONS`, deduped case-insensitively. The global list is deliberately not merged in here — a door
 * that only answers `POST` must not advertise `PATCH` (#102).
 */
function preflightMethods(documented: readonly string[]): string {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [...documented, "OPTIONS"]) {
    const trimmed = candidate.trim().toUpperCase();
    if (trimmed === "") continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(trimmed);
  }
  return names.join(", ");
}

/**
 * CORS headers for one deployment; the default (no `--cors`) sends none at all.
 *
 * `access-control-allow-methods` is deliberately absent: the header is only meaningful on a
 * preflight, and `preflightResponse` is the one place that names a door's documented methods. An
 * ordinary answer carrying the global vocabulary would contradict the preflight for the same door
 * (#102) — and every caller passed no list, so it always did.
 *
 * `extraAllowHeaders` is for a door that speaks a header of its own (the admin surface's
 * `x-bluepencil-admin`). Duplicates are dropped case-insensitively and the first spelling wins, so
 * the answer never lists one header twice in two casings.
 */
export function corsHeaders(
  cors: string | undefined,
  extraAllowHeaders: readonly string[] = [],
): Record<string, string> {
  if (cors === undefined || cors === "") return {};
  const names: string[] = [...ALLOW_HEADERS];
  const seen = new Set(names.map((name) => name.toLowerCase()));
  for (const extra of extraAllowHeaders) {
    const trimmed = extra.trim();
    if (trimmed === "") continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(trimmed);
  }
  return {
    "access-control-allow-origin": cors,
    "access-control-allow-headers": names.join(", "),
    "access-control-max-age": "600",
    ...(cors === "*" ? {} : { vary: "Origin" }),
  };
}

/** The shape a preflight answer has; structurally compatible with the handler's `ServerResponse`. */
export interface PreflightAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * The one CORS preflight implementation (#98, #99, #102).
 *
 * A browser sends `OPTIONS` without a credential — it cannot know one yet — so a credential check
 * on it could only refuse the pairing, never protect a note. `null` means "this is not a preflight
 * on a CORS-enabled hub": either the method is not OPTIONS, or `--cors` is off and the caller keeps
 * its ordinary route refusal.
 *
 * `allowMethods` names the methods the door documents and is authoritative for the preflight answer
 * (`OPTIONS` is appended, duplicates are dropped); `extraAllowHeaders` is for a door that speaks a
 * header of its own (the admin surface's `x-bluepencil-admin`). The shared header list is never
 * repeated per route — that is what makes it one vocabulary rather than five.
 */
export function preflightResponse(
  method: string | undefined,
  context: { readonly cors?: string | undefined },
  allowMethods: readonly string[] = [],
  extraAllowHeaders: readonly string[] = [],
): PreflightAnswer | null {
  if ((method ?? "GET").toUpperCase() !== "OPTIONS") return null;
  if (context.cors === undefined || context.cors === "") return null;
  return {
    status: 204,
    headers: {
      ...corsHeaders(context.cors, extraAllowHeaders),
      "access-control-allow-methods": preflightMethods(allowMethods),
    },
    body: "",
  };
}
