/**
 * The server half's shared text helpers (CQ-02, AC-H05).
 *
 * `errorText` and `oneLine` existed as private copies in six server modules. This module is their
 * one server-facing home; every `server/*.ts` imports the symbols from here.
 *
 * The bodies live in `src/core/text.ts`, not here, because `src/federation/client.ts` uses the same
 * two symbols and `tsconfig.types.json` pins the declaration emit's `rootDir` to `src/` — a `src/`
 * module cannot import from `server/` without moving every published `.d.ts` one level down. This
 * file is the single implementation *site* for the server and stays dependency-free.
 */
export { errorText, oneLine } from "../src/core/text";
