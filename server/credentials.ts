/**
 * "Which client credentials does this hub accept?" — one answer, in one place.
 *
 * Both `server/handler.ts` (`GET {base}/config`) and `server/admin.ts` (`GET {base}/admin/status`)
 * have to describe the hub's client gate. Before #112 they derived that independently, and the two
 * answers drifted: `/config` treated an empty secret as absent, the admin status treated any
 * defined value as present, and neither could name a hub that accepts *both* credentials.
 *
 * This module is deliberately free of imports, including `./handler`: `server/handler.ts` imports
 * `server/admin.ts` and `server/admin.ts` imports this module, so a dependency in the other
 * direction would be a runtime import cycle. Both call sites pass their context structurally; only
 * the presence of `authSecret` / `verifyToken` matters here.
 *
 * **The admin secret is not a client credential.** It guards the operator surface (and is admitted
 * as a second credential on the notes routes), but it never turns the client gate on. It is
 * therefore not part of `credentialMode()` or `acceptedCredentials()`; `server/admin-html.ts` and
 * `docs/DOCKER.md` say so explicitly.
 */

/**
 * The shortest `--auth-secret` that still counts as a credential (G2, SEC-07).
 *
 * A shared secret is the *only* gate on a hub that hands it to every browser, so a six-character one
 * turns the notes API into a brute-force target that answers 401 in microseconds. The admin secret
 * uses the same floor: both are operator-supplied strings, and two minimum lengths would only
 * produce "why does this one work and that one not". Lives here rather than in `server/hub.ts` so
 * `server/mint-cli.ts` can enforce the sibling floor without importing the whole hub.
 */
export const SECRET_MIN_LENGTH = 16;

/**
 * The shortest `--token-key` (G2, SEC-04). Higher than the secret's floor because the key is an HMAC
 * signing key: its length is the strength ceiling of every token ever issued against it, and a
 * token cannot be stronger than the key that signed it. `bluepencil token` enforces the same floor.
 */
export const TOKEN_KEY_MIN_LENGTH = 32;

/** What a client must present: a signed token, the shared secret, both, or nothing. */
export type CredentialMode = "token+secret" | "token" | "secret" | "none";

/** One accepted client credential, named as the wire protocol names it. */
export type CredentialKind = "token" | "secret";

/** The slice of a hub context this module reads — `HandlerContext` satisfies it structurally. */
export interface CredentialContext {
  /** Shared secret (`--auth-secret`); unset or empty means no secret is accepted. */
  authSecret?: string;
  /** Token verifier (`--token-key`); only its presence is relevant here. */
  verifyToken?: unknown;
}

/** True when the hub accepts the shared secret. An empty string is "not configured", not a secret. */
export function hasSecretCredential(context: CredentialContext): boolean {
  return typeof context.authSecret === "string" && context.authSecret.length > 0;
}

/** True when the hub accepts signed tokens. */
export function hasTokenCredential(context: CredentialContext): boolean {
  return context.verifyToken !== undefined;
}

/** The credential mode, with both credentials reported as `token+secret` rather than one of them. */
export function credentialMode(context: CredentialContext): CredentialMode {
  const token = hasTokenCredential(context);
  const secret = hasSecretCredential(context);
  if (token && secret) return "token+secret";
  if (token) return "token";
  if (secret) return "secret";
  return "none";
}

/**
 * The accepted credentials in preference order — token first, because it is the stronger and
 * individually revocable one. Empty when the hub has no client gate at all.
 */
export function acceptedCredentials(context: CredentialContext): CredentialKind[] {
  const accepted: CredentialKind[] = [];
  if (hasTokenCredential(context)) accepted.push("token");
  if (hasSecretCredential(context)) accepted.push("secret");
  return accepted;
}
