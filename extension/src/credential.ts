/**
 * The one credential mapping (FR-15.3, #105).
 *
 * A hub accepts two kinds of credential and they are *different headers*, not a cosmetic choice:
 * the shared secret travels in `x-bluepencil-auth`, a per-device signed token in
 * `Authorization: Bearer <token>`. Getting the pair wrong produces a `401` that reads like a dead
 * server, so the mapping lives here exactly once — the service worker, the connection probe, the
 * page handoff and the options copy all read this module instead of spelling the table out again.
 *
 * Nothing here touches storage, the DOM or `chrome.*`: it is pure, and every caller may import it
 * without pulling in a runtime side effect. No function returns the credential to a page; callers
 * decide where a header may be attached.
 */

/** Canonical name of the signed-token header; HTTP header names are case-insensitive. */
export const AUTHORIZATION_HEADER = "Authorization" as const;

/** Canonical name of the shared-secret header (`--auth-secret` on the hub). */
export const BLUEPENCIL_AUTH_HEADER = "x-bluepencil-auth" as const;

/** Which credential a hub expects. `none` means the hub is reachable without one. */
export type CredentialMode = "none" | "secret" | "token";

/** How one credential mode travels: the header name and, for a token, its scheme. */
export interface CredentialHeader {
  /** Canonical header name; the element's `token-header` attribute wants the lower-case form. */
  header: typeof AUTHORIZATION_HEADER | typeof BLUEPENCIL_AUTH_HEADER;
  /** `Bearer` for a signed token, `null` for a shared secret. */
  scheme: string | null;
}

/**
 * The only header table. Indexed by the two modes a header exists for — `none` has no entry, which
 * is why {@link credentialHeaderFor} returns `null` rather than inventing one.
 */
const CREDENTIAL_HEADERS: Readonly<Record<"secret" | "token", CredentialHeader>> = {
  secret: { header: BLUEPENCIL_AUTH_HEADER, scheme: null },
  token: { header: AUTHORIZATION_HEADER, scheme: "Bearer" },
};

/**
 * The header `secret` or `token` means, and `null` for `none`.
 *
 * Returning `null` instead of an empty header keeps the "there is no credential" case visible to
 * the type system: a caller that ignores it cannot silently build `Authorization: Bearer ` with a
 * blank value.
 */
export function credentialHeaderFor(auth: CredentialMode): CredentialHeader | null {
  return auth === "none" ? null : CREDENTIAL_HEADERS[auth];
}

/**
 * The credential as it should be carried, or `null` when none is configured.
 *
 * Whitespace-only is *not* configured: sending it would turn a harmless probe into a guaranteed 401
 * and hand the element a header value no hub can match. The value is trimmed, so a token pasted with
 * a trailing newline travels without it. Both the layer and the probe read this one rule, so the URL
 * the options page tests is the URL the layer would actually use (#105).
 */
export function configuredCredential(token: string): string | null {
  const value = token.trim();
  return value.length === 0 ? null : value;
}

/**
 * The headers a request carries for a credential mode — the single construction used by the worker
 * and the connection probe, so a request cannot be sent with a different header than the one the
 * options page called "accepted".
 *
 * An unset (`none`, empty or whitespace-only) credential produces `{}`: no header at all, never an
 * empty one. The returned names are canonical; `fetch` matches them case-insensitively.
 */
export function authHeadersFor(auth: CredentialMode, token: string): Record<string, string> {
  const spec = credentialHeaderFor(auth);
  const value = configuredCredential(token);
  if (spec === null || value === null) return {};
  return { [spec.header]: spec.scheme === null ? value : `${spec.scheme} ${value}` };
}
