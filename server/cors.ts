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
];

/**
 * CORS headers for one deployment; the default (no `--cors`) sends none at all.
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
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
    "access-control-allow-headers": names.join(", "),
    "access-control-max-age": "600",
    ...(cors === "*" ? {} : { vary: "Origin" }),
  };
}
