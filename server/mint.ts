/**
 * The token minting a client needs before it can talk to a token-configured hub (#36, phase 2).
 *
 * ## Why this exists
 *
 * Phase 2 added the hub half — a signing key, signed tokens, a revocation list. That is half a
 * feature: without a way to *obtain* a token, the only clients that can authenticate are ones that
 * already hold one. So this is the other half, and it is a local command rather than an HTTP
 * endpoint, for one reason: issuing a token over HTTP would mean the hub accepts unauthenticated
 * requests that create credentials. The key is an operator secret, so the operator mints tokens.
 *
 * ## Why the device name is asked for
 *
 * Because a revocation list is a list of ids, and an id says nothing. `"a1b2c3…"` in a revocation
 * file is a list nobody can audit; `"work-laptop"` next to it is a list someone can check. The name
 * goes into the claims, is shown on issue, and is what an operator greps for when someone reports a
 * lost device. It is a label, not a security property — the signature is.
 *
 * ## What this deliberately does not do
 *
 * It does not store anything, call anything, or read the revocation file. It prints a token to
 * stdout and nothing else, so it composes with a shell and never leaves a credential in a file the
 * user did not choose. Putting it in the history of a shell is the operator's call to make, and
 * `bluepencil help token` says so.
 */
import { createTokenIssuer, type TokenIssuerOptions } from "./tokens";

/** What `bluepencil token` needs to know. Kept separate from `parseServerArgs` on purpose. */
export interface TokenRequest {
  /** The signing key, exactly as the hub has it. */
  key: string;
  /** A human-readable name for the device, recorded in the claims. */
  device: string;
  /** `read` for a viewer, `read write` for a full client; defaults to `read write`. */
  scope?: readonly ("read" | "write")[];
  /** Lifetime in seconds; the issuer's default applies when unset. */
  ttlSeconds?: number;
}

/** What the command prints. The token is the point; the rest is context for the operator. */
export interface TokenResult {
  readonly token: string;
  readonly device: string;
  readonly scope: readonly ("read" | "write")[];
  readonly expiresAt: string;
  /** The handle a revocation list records. Printed so nobody has to decode a JWT to find it. */
  readonly id: string;
}

/**
 * Parses the scope words a human typed.
 *
 * Only `read` and `write` are accepted, and an unknown word is an error rather than something
 * ignored. A typo that quietly drops `write` would produce a token that reads fine and cannot save —
 * and the person would only find out when a note was lost.
 */
export function parseScope(text: string | undefined): ("read" | "write")[] | string {
  if (text === undefined || text.trim() === "") return ["read", "write"];
  const words = text.split(/[\s,]+/).filter((word) => word.length > 0);
  const allowed = new Set(["read", "write"]);
  const unknown = words.filter((word) => !allowed.has(word));
  if (unknown.length > 0) {
    return `unknown scope ${unknown.join(", ")} — expected read, write, or both`;
  }
  // `read write` and `write read` are the same request; order is not a preference.
  return words.includes("write") ? ["read", "write"] : ["read"];
}

/**
 * Mints one token.
 *
 * Pure and synchronous, so it is testable without a process, a port or a clock of its own — the
 * caller supplies `now` and `newId` through `TokenIssuerOptions` when it needs determinism.
 */
export function mintToken(request: TokenRequest, options: Omit<TokenIssuerOptions, "key"> = {}): TokenResult {
  if (request.key.length === 0) {
    throw new Error(
      "a signing key is required — it is the same value the hub has under --token-key",
    );
  }
  if (request.device.trim().length === 0) {
    throw new Error("a device name is required — it is what a revocation list is read by");
  }
  const issuer = createTokenIssuer({ key: request.key, ...options });
  const scope = request.scope ?? ["read", "write"];
  const issued = issuer.issue({ device: request.device.trim(), scope, ...(request.ttlSeconds !== undefined ? { ttlSeconds: request.ttlSeconds } : {}) });
  return {
    token: issued.token,
    device: issued.claims.device,
    scope: issued.claims.scope,
    expiresAt: issued.claims.exp,
    id: issued.claims.jti,
  };
}
