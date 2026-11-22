/**
 * OIDC bearer tokens from an external identity provider (Zitadel, Keycloak, …).
 *
 * This is deliberately NOT a general OAuth library. It answers one question: given a bearer token
 * and a required scope, is this request allowed in? Everything else — users, passwords, 2FA,
 * password reset, locking accounts, audit — stays with the identity provider.
 *
 * Verification is synchronous by design. `handleRequest()` is a pure, synchronous handler, so the
 * asynchronous work (JWKS discovery/fetch) happens once at startup and on a refresh timer. A request
 * only imports the cached public key and calls `node:crypto.verify`, which keeps the hub's
 * dependency-free runtime (NFR-4) intact: no `jose`, no `openid-client`, no node_modules in the image.
 *
 * Device tokens (`server/tokens.ts`) remain a separate credential. They are HMAC-signed by this hub
 * and are what agents/MCP/CLI use. An OIDC token is RS256-signed by the identity provider and is
 * what a human's own UI uses. The two never share a signing key or a revocation list.
 */
import { createPublicKey, verify as verifySignature } from "node:crypto";
import type { webcrypto } from "node:crypto";

/** Configuration for one external OIDC provider. */
export interface OidcOptions {
  /** Issuer identifier, e.g. `https://login.example.com`. Must match the token's `iss` exactly. */
  readonly issuer: string;
  /** Expected audience; must be among the token's `aud` values. */
  readonly audience: string;
  /** Explicit JWKS URL. When omitted, discovery via `{issuer}/.well-known/openid-configuration` is used. */
  readonly jwksUrl?: string;
  /** Claim carrying the user's roles. Defaults to Zitadel's roles claim, with `roles` as fallback. */
  readonly rolesClaim?: string;
  readonly adminRole?: string;
  readonly reviewerRole?: string;
  readonly viewerRole?: string;
  /** How often cached keys are refreshed (ms). Default 10 minutes. */
  readonly refreshIntervalMs?: number;
  /** Injectable clock (ms), so tests are deterministic. */
  readonly now?: () => number;
}

export type OidcFailure =
  | "malformed"
  | "unsupported-alg"
  | "unknown-kid"
  | "bad-signature"
  | "invalid-claims"
  | "insufficient-role";

export interface OidcVerdict {
  readonly ok: boolean;
  readonly reason?: OidcFailure;
  /** Stable subject id, used as the journal actor when the token is accepted. */
  readonly subject?: string;
  readonly roles: readonly string[];
}

export interface OidcVerifier {
  /** Synchronous verdict for one bearer token and one required scope. */
  verify(token: string, required: "read" | "write"): OidcVerdict;
  /** Re-fetch the JWKS. Called at startup and by the refresh timer. */
  refresh(): Promise<void>;
  /** Stop the refresh timer. */
  close(): void;
  /** The resolved JWKS URL (after discovery), useful for `/config`-style diagnostics. */
  readonly jwksUrl: string | undefined;
}

interface FetchDeps {
  readonly fetch?: typeof globalThis.fetch;
}

const DEFAULT_ROLES_CLAIM = "urn:zitadel:iam:user:roles";
const DEFAULT_ADMIN_ROLE = "bp-admin";
const DEFAULT_REVIEWER_ROLE = "bp-reviewer";
const DEFAULT_VIEWER_ROLE = "bp-viewer";
/** Small clock skew (seconds) so a token issued on another host is not refused at the boundary. */
const CLOCK_SKEW_SECONDS = 30;
const DEFAULT_REFRESH_MS = 10 * 60 * 1000;

function failure(reason: OidcFailure, subject?: string, roles: readonly string[] = []): OidcVerdict {
  return { ok: false, reason, ...(subject === undefined ? {} : { subject }), roles };
}

/** Roles arrive as an array, a string, or (Zitadel) an object keyed by project id. */
function collectRoles(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    into.add(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectRoles(entry, into);
  } else if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) collectRoles(entry, into);
  }
}

function asAudience(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  return [];
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Builds a verifier and performs the first JWKS fetch. A provider that cannot be reached is a
 * startup failure: a hub that silently accepted no OIDC tokens would look configured and be broken.
 */
export async function createOidcVerifier(
  options: OidcOptions,
  deps: FetchDeps = {},
): Promise<OidcVerifier> {
  const issuer = options.issuer.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(issuer)) {
    throw new Error(`OIDC issuer must be an absolute http(s) URL (got ${JSON.stringify(issuer)})`);
  }
  if (options.audience.length === 0) {
    throw new Error("OIDC audience must not be empty");
  }

  const rolesClaim = options.rolesClaim ?? DEFAULT_ROLES_CLAIM;
  const adminRole = options.adminRole ?? DEFAULT_ADMIN_ROLE;
  const reviewerRole = options.reviewerRole ?? DEFAULT_REVIEWER_ROLE;
  const viewerRole = options.viewerRole ?? DEFAULT_VIEWER_ROLE;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const keys = new Map<string, ReturnType<typeof createPublicKey>>();
  let resolvedJwksUrl: string | undefined = options.jwksUrl;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function refresh(): Promise<void> {
    let jwksUrl = resolvedJwksUrl;
    if (jwksUrl === undefined) {
      const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
      const discovery = await fetchImpl(discoveryUrl, { headers: { accept: "application/json" } });
      if (!discovery.ok) {
        throw new Error(`OIDC discovery ${discoveryUrl} answered ${discovery.status}`);
      }
      const document = (await discovery.json()) as { jwks_uri?: unknown };
      if (typeof document.jwks_uri !== "string" || !/^https?:\/\//i.test(document.jwks_uri)) {
        throw new Error(`OIDC discovery ${discoveryUrl} has no absolute jwks_uri`);
      }
      jwksUrl = document.jwks_uri;
    }

    const response = await fetchImpl(jwksUrl, { headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`OIDC JWKS ${jwksUrl} answered ${response.status}`);
    }
    const body = (await response.json()) as { keys?: unknown };
    if (!Array.isArray(body.keys)) {
      throw new Error(`OIDC JWKS ${jwksUrl} has no keys array`);
    }
    const next = new Map<string, ReturnType<typeof createPublicKey>>();
    for (const candidate of body.keys) {
      if (candidate === null || typeof candidate !== "object") continue;
      const jwk = candidate as Record<string, unknown>;
      if (jwk.kty !== "RSA" || typeof jwk.kid !== "string" || jwk.n === undefined || jwk.e === undefined) {
        continue; // only RS256-capable keys are useful here
      }
      next.set(
        jwk.kid,
        createPublicKey({
          key: jwk as unknown as webcrypto.JsonWebKey,
          format: "jwk",
        }),
      );
    }
    if (next.size === 0) {
      throw new Error(`OIDC JWKS ${jwksUrl} contains no usable RSA keys`);
    }
    // Replace only after a complete, valid result: a failed refresh must not drop working keys.
    keys.clear();
    for (const [kid, key] of next) keys.set(kid, key);
    resolvedJwksUrl = jwksUrl;
  }

  const verifier: OidcVerifier = {
    get jwksUrl() {
      return resolvedJwksUrl;
    },
    refresh,
    close() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
    verify(token, required) {
      const parts = token.split(".");
      if (parts.length !== 3) return failure("malformed");
      const [encodedHeader, encodedPayload, encodedSignature] = parts;
      if (
        encodedHeader === undefined ||
        encodedPayload === undefined ||
        encodedSignature === undefined
      ) {
        return failure("malformed");
      }
      let header: Record<string, unknown>;
      let claims: Record<string, unknown>;
      try {
        header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as Record<string, unknown>;
        claims = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>;
      } catch {
        return failure("malformed");
      }
      if (header.alg !== "RS256" || typeof header.kid !== "string") {
        return failure("unsupported-alg");
      }
      const key = keys.get(header.kid);
      if (key === undefined) return failure("unknown-kid");

      let signature: Buffer;
      try {
        signature = Buffer.from(encodedSignature, "base64url");
      } catch {
        return failure("malformed");
      }
      const signed = Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii");
      if (!verifySignature("sha256", signed, key, signature)) return failure("bad-signature");

      const subject = typeof claims.sub === "string" ? claims.sub : undefined;
      const roles = new Set<string>();
      for (const claim of [rolesClaim, "roles"]) {
        if (claims[claim] !== undefined) collectRoles(claims[claim], roles);
      }
      const roleList = [...roles];
      const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);
      const exp = claims.exp;
      const nbf = claims.nbf;
      const audienceOk = asAudience(claims.aud).includes(options.audience);
      if (
        claims.iss !== issuer ||
        !audienceOk ||
        !isPositiveNumber(exp) ||
        exp + CLOCK_SKEW_SECONDS <= nowSeconds ||
        (nbf !== undefined && (!isPositiveNumber(nbf) || nbf > nowSeconds + CLOCK_SKEW_SECONDS))
      ) {
        return failure("invalid-claims", subject, roleList);
      }

      const mayWrite = roles.has(adminRole) || roles.has(reviewerRole);
      const mayRead = mayWrite || roles.has(viewerRole);
      if (!mayRead || (required === "write" && !mayWrite)) {
        return failure("insufficient-role", subject, roleList);
      }
      return { ok: true, ...(subject === undefined ? {} : { subject }), roles: roleList };
    },
  };

  await refresh();
  const interval = options.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
  if (interval > 0) {
    timer = setInterval(() => {
      void refresh().catch(() => {
        // A refresh failure is logged by the caller's diagnostics on the next probe; the cached
        // keys stay valid and the hub keeps serving. The next scheduled refresh tries again.
      });
    }, interval);
    timer.unref();
  }
  return verifier;
}
