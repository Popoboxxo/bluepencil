/**
 * The protocol's header names, defined once (CQ-02, AC-H04).
 *
 * The hub, the federation client and the HTTP adapter speak the same wire protocol, so a rename
 * has to happen in exactly one place. This module imports nothing and is safe for both sides of
 * the `src/` ↔ `server/` boundary.
 *
 * **The extension is the one justified exception.** `extension/src/credential.ts` keeps its own
 * copy of the secret header because the extension bundles on its own and imports nothing from
 * `src/`; sharing this module would drag the library into a second bundle for one string.
 *
 * The spec's interface sketch (§3.8) also listed an `isAuthHeader()` predicate. No acceptance
 * criterion names a call site for it and nothing imports it, so it would be exactly the dead
 * surface AC-H08 removes; the constants are the contract, the predicate is not.
 */

/** Header an authenticated client presents its shared secret in (#36, phase 1). */
export const AUTH_HEADER_SECRET = "x-bluepencil-auth";

/** Header a client presents a signed token in (`Authorization: Bearer …`, #36, phase 2). */
export const AUTH_HEADER_TOKEN = "authorization";

/**
 * Header the operator surface carries. It is *not* a client credential: the admin secret guards
 * the admin page and is only admitted as a second credential on the notes routes by explicit opt-in
 * (`server/admin.ts`, `server/credentials.ts`).
 */
export const ADMIN_HEADER = "x-bluepencil-admin";
