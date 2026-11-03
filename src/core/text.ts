/**
 * The one implementation of the shared text helpers (CQ-02, AC-H05).
 *
 * The same two one-liners were copied into six server modules and the federation client. They live
 * in `src/core` rather than in `server/` because `src/federation/client.ts` uses them too, and
 * `tsconfig.types.json` pins the declaration emit's `rootDir` to `src/` — a `src/` module may not
 * reach into `server/`. `server/text.ts` re-exports these two symbols, so the server half still has
 * exactly one import site.
 *
 * This module imports nothing: no `node:` builtin, no `src/core` module. That is what lets every
 * caller use it without creating a cycle.
 */

/** The message of a thrown value, whatever shape it has — a thrown string included. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Collapses any text to a single line. Error bodies, log lines and git subjects are never
 * multi-line blobs, and a newline in a header value is a protocol error.
 */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
