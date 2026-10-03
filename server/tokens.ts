/**
 * Signed per-device tokens — phase 2 of #36, layered on the shared secret from phase 1.
 *
 * ## Why this exists
 *
 * The shared secret works, and it is deliberately small: one string, checked on every request, no
 * expiry, no revocation. It has two properties that only matter once more than one device is
 * involved, and both are why this module exists:
 *
 *   - **no revocation.** Every client holds the same credential, so withdrawing it means rotating it
 *     and re-configuring every device at once. A lost laptop keeps working until someone notices.
 *   - **no scope and no expiry.** A client that was meant to read cannot be downgraded, and a token
 *     that was issued for a week is still valid next year.
 *
 * A signed token fixes all three: the hub signs a claim set with a signing key and hands it to a
 * device; the device presents it instead of the secret; the hub verifies the signature, the
 * expiry and the scope. Revoking one device means recording its `jti`. A token cannot be forged
 * without the key, and the client never sees the key at all.
 *
 * ## What this is deliberately not
 *
 * A general JWT library, and not a full OAuth flow. There is no issuer discovery, no refresh, no
 * scopes beyond a read/write bit, and no third-party verification — this is a hub and the
 * clients are its own extension and CLI. The format is JWT-shaped (three dot-separated base64url
 * segments) because that is what the ecosystem expects to see on the wire, and because it makes
 * `Authorization: Bearer …` interoperable with anything that already speaks it.
 *
 * `node:crypto` does the HMAC. A dependency-free core is a project non-negotiable (NFR-4), and
 * hand-rolling crypto is not what that rule asks for — it asks for no *runtime dependency*, and
 * verifying an HMAC is a one-line call to a primitive that has been audited for thirty years.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/** Claims a token carries. Kept small on purpose: this is not an identity system. */
export interface TokenClaims {
  /** Issued-at, ISO-8601. Informational — expiry is what is enforced. */
  readonly iat: string;
  /** Expiry, ISO-8601. Enforced on every verification. */
  readonly exp: string;
  /** Token id. The handle a revocation list stores, so one device can be dropped. */
  readonly jti: string;
  /** A name for the device, so a human reading the revocation list knows which entry is which. */
  readonly device: string;
  /** What the token may do. `read` covers GET; `write` covers every mutation. */
  readonly scope: readonly ("read" | "write")[];
}

/** The signing key, plus the lifetime new tokens get. */
export interface TokenIssuerOptions {
  /**
   * HMAC key.
   *
   * A shared secret is not the same thing: the key never leaves the hub, while the secret is
   * handed to every client. That is the whole difference — a key that stays here cannot be replayed
   * from a device, and rotating it does not require touching any client.
   */
  readonly key: string;
  /** Lifetime of a freshly issued token, in seconds. Default one day. */
  readonly ttlSeconds?: number;
  /** Injectable clock, so tests do not depend on the wall clock. */
  readonly now?: () => Date;
  /** Injectable id source, so tests get stable token ids. */
  readonly newId?: () => string;
}

/** An issued token and its claims — the caller stores the token, shows the id, keeps the claims. */
export interface IssuedToken {
  readonly token: string;
  readonly claims: TokenClaims;
}

/** Why a token was refused. Distinct because a client reacts differently to each. */
export type TokenFailure =
  | "malformed"
  | "bad-signature"
  | "expired"
  | "revoked"
  | "insufficient-scope";

/** A verification result. `ok: false` always carries a reason; there is no "just false". */
export type TokenVerdict =
  | { readonly ok: true; readonly claims: TokenClaims }
  | { readonly ok: false; readonly reason: TokenFailure };

/** How long a new token lives when nothing says otherwise. */
export const DEFAULT_TOKEN_TTL_SECONDS = 24 * 60 * 60;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function fromBase64url(input: string): Buffer {
  // `base64url` is strict on purpose: a token is not a place to be lenient about what arrives.
  return Buffer.from(input, "base64url");
}

/**
 * Constant-time comparison, as in the shared-secret check.
 *
 * Length is compared first, which leaks the signature's length — a fixed-length value, so that
 * reveals nothing the attacker does not already know.
 */
function equalConstantTime(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createTokenIssuer(options: TokenIssuerOptions): {
  issue: (input: { device: string; scope: readonly ("read" | "write")[]; ttlSeconds?: number }) => IssuedToken;
  verify: (token: string, required: "read" | "write", revoked?: ReadonlySet<string>) => TokenVerdict;
} {
  const key = options.key;
  if (key.length === 0) {
    throw new Error("a signing key is required — an empty key would sign with nothing");
  }
  const now = options.now ?? ((): Date => new Date());
  // A real id by default, because the alternative is a placeholder that throws. A token id is the
  // handle a revocation list stores, so it has to be unique across issuers and unguessable enough
  // that naming one does not let an attacker claim a token; `randomUUID` is both, and it is a
  // builtin rather than a dependency.
  const newId = options.newId ?? ((): string => randomUUID());
  const defaultTtl = options.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;

  function sign(payload: string): Buffer {
    return createHmac("sha256", key).update(payload).digest();
  }

  function issue(input: {
    device: string;
    scope: readonly ("read" | "write")[];
    ttlSeconds?: number;
  }): IssuedToken {
    const issued = now();
    const ttl = input.ttlSeconds ?? defaultTtl;
    if (!Number.isInteger(ttl) || ttl <= 0) {
      throw new Error("ttlSeconds must be a positive integer — a token that expires immediately is not a token");
    }
    const claims: TokenClaims = {
      iat: issued.toISOString(),
      exp: new Date(issued.getTime() + ttl * 1000).toISOString(),
      jti: newId(),
      device: input.device,
      scope: input.scope.length > 0 ? [...input.scope] : (["read"] as const),
    };
    const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = base64url(JSON.stringify(claims));
    const payload = `${header}.${body}`;
    return { token: `${payload}.${sign(payload).toString("base64url")}`, claims };
  }

  function verify(
    token: string,
    required: "read" | "write",
    revoked: ReadonlySet<string> = new Set(),
  ): TokenVerdict {
    // The required scope has to be one this issuer understands before anything else. Without this
    // check, a caller that passed an arbitrary string — a cast, a config typo, a future scope that
    // reached an older binary — would be granted access whenever that string happened to be in the
    // token's scope, and a token with a scope list of `["admin"]` would authorise a request for
    // `admin`. The scope vocabulary is closed, so an unknown requirement is refused, not matched.
    if (required !== "read" && required !== "write") {
      return { ok: false, reason: "insufficient-scope" };
    }
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, reason: "malformed" };
    const [header, body, signature] = parts as [string, string, string];
    if (header.length === 0 || body.length === 0 || signature.length === 0) {
      return { ok: false, reason: "malformed" };
    }
    // Verify before parsing. A token is untrusted input, and parsing it first would mean letting an
    // attacker decide what shape of object the verifier has to cope with.
    const expected = sign(`${header}.${body}`);
    if (!equalConstantTime(expected, fromBase64url(signature))) {
      return { ok: false, reason: "bad-signature" };
    }

    let claims: TokenClaims;
    try {
      claims = JSON.parse(fromBase64url(body).toString("utf8")) as TokenClaims;
    } catch {
      // Reachable only with the signing key, since the signature covers the body.
      return { ok: false, reason: "malformed" };
    }
    if (typeof claims?.jti !== "string" || typeof claims?.exp !== "string" || !Array.isArray(claims?.scope)) {
      return { ok: false, reason: "malformed" };
    }
    if (revoked.has(claims.jti)) return { ok: false, reason: "revoked" };
    if (Date.parse(claims.exp) <= now().getTime()) return { ok: false, reason: "expired" };
    // `write` implies `read`: a client that may mutate a note set can certainly read it, and
    // making that a configuration detail is a trap for whoever deploys this.
    const scope = new Set<string>(claims.scope);
    if (!(scope.has(required) || (required === "read" && scope.has("write")))) {
      return { ok: false, reason: "insufficient-scope" };
    }
    return { ok: true, claims };
  }

  return { issue, verify };
}

/**
 * Adapts this module's verdict to the narrow shape `server/handler.ts` asks for.
 *
 * The mapping is total on purpose: every failure reason becomes one of four, so the handler never
 * has to know that `malformed` and `bad-signature` exist. They collapse into `other`, which the
 * handler answers with a plain 401 and a message that says the token is not valid — true of both,
 * and useless to an attacker either way.
 */
export function asHandlerVerifier(issuer: {
  verify: (token: string, required: "read" | "write", revoked?: ReadonlySet<string>) => TokenVerdict;
}): (token: string, required: "read" | "write", revoked: ReadonlySet<string>) =>
  | { ok: true; device: string }
  | { ok: false; reason: "expired" | "revoked" | "insufficient-scope" | "other" } {
  return (token, required, revoked) => {
    const verdict = issuer.verify(token, required, revoked);
    if (verdict.ok) return { ok: true, device: verdict.claims.device };
    if (verdict.reason === "malformed" || verdict.reason === "bad-signature") {
      return { ok: false, reason: "other" };
    }
    return { ok: false, reason: verdict.reason };
  };
}
