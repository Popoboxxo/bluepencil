import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as signNode } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { createOidcVerifier } from "../../server/oidc";

const ISSUER = "https://login.example.com";
const AUDIENCE = "bluepencil";
const KID = "test-key";

interface KeyPairFixture {
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function keyPair(): KeyPairFixture {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = pair.publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return { privateKey: pair.privateKey as KeyObject, jwk: { ...jwk, kid: KID, alg: "RS256", use: "sig" } };
}

function makeFetch(keys: readonly Record<string, unknown>[]): typeof globalThis.fetch {
  const discovery = { jwks_uri: `${ISSUER}/jwks` };
  const jwks = { keys };
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.endsWith("/openid-configuration") ? discovery : jwks;
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as Response;
  }) as typeof globalThis.fetch;
}

function bearer(
  key: KeyPairFixture["privateKey"],
  claims: Record<string, unknown>,
  overrides: { kid?: string; alg?: string } = {},
): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: overrides.alg ?? "RS256", typ: "JWT", kid: overrides.kid ?? KID });
  const payload = encode({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "user-1",
    exp: Math.floor(Date.now() / 1000) + 600,
    ...claims,
  });
  const signature = signNode("RSA-SHA256", Buffer.from(`${header}.${payload}`), key).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

describe("server/oidc", () => {
  it("accepts a viewer token for reads and refuses it for writes", async () => {
    const keys = keyPair();
    const verifier = await createOidcVerifier(
      { issuer: ISSUER, audience: AUDIENCE, refreshIntervalMs: 0 },
      { fetch: makeFetch([keys.jwk]) },
    );
    const token = bearer(keys.privateKey, { roles: ["bp-viewer"] });
    expect(verifier.verify(token, "read")).toMatchObject({ ok: true, subject: "user-1" });
    expect(verifier.verify(token, "write")).toMatchObject({ ok: false, reason: "insufficient-role" });
    verifier.close();
  });

  it("accepts write for reviewer and admin, denies an unrecognised role", async () => {
    const keys = keyPair();
    const verifier = await createOidcVerifier(
      { issuer: ISSUER, audience: AUDIENCE, refreshIntervalMs: 0 },
      { fetch: makeFetch([keys.jwk]) },
    );
    expect(verifier.verify(bearer(keys.privateKey, { roles: ["bp-reviewer"] }), "write").ok).toBe(true);
    expect(verifier.verify(bearer(keys.privateKey, { roles: ["bp-admin"] }), "write").ok).toBe(true);
    expect(
      verifier.verify(bearer(keys.privateKey, { roles: ["someone-else"] }), "read").reason,
    ).toBe("insufficient-role");
    verifier.close();
  });

  it("reads Zitadel's project-keyed roles claim", async () => {
    const keys = keyPair();
    const verifier = await createOidcVerifier(
      { issuer: ISSUER, audience: AUDIENCE, refreshIntervalMs: 0 },
      { fetch: makeFetch([keys.jwk]) },
    );
    const token = bearer(keys.privateKey, {
      "urn:zitadel:iam:user:roles": { "project-id": ["bp-reviewer"] },
    });
    expect(verifier.verify(token, "write")).toMatchObject({ ok: true, roles: ["bp-reviewer"] });
    verifier.close();
  });

  it("rejects wrong issuer, audience, expiry and signature", async () => {
    const keys = keyPair();
    const verifier = await createOidcVerifier(
      { issuer: ISSUER, audience: AUDIENCE, refreshIntervalMs: 0 },
      { fetch: makeFetch([keys.jwk]) },
    );
    const other = keyPair();
    expect(verifier.verify(bearer(keys.privateKey, { roles: ["bp-viewer"], iss: "https://evil" }), "read").reason).toBe("invalid-claims");
    expect(verifier.verify(bearer(keys.privateKey, { roles: ["bp-viewer"], aud: "other" }), "read").reason).toBe("invalid-claims");
    expect(verifier.verify(bearer(keys.privateKey, { roles: ["bp-viewer"], exp: 1 }), "read").reason).toBe("invalid-claims");
    expect(verifier.verify(bearer(other.privateKey, { roles: ["bp-viewer"] }), "read").reason).toBe("bad-signature");
    expect(verifier.verify("not.a.token", "read").reason).toBe("malformed");
    verifier.close();
  });

  it("refuses unknown kids and picks up rolled keys after refresh", async () => {
    const first = keyPair();
    const fetchImpl = makeFetch([first.jwk]);
    const verifier = await createOidcVerifier(
      { issuer: ISSUER, audience: AUDIENCE, refreshIntervalMs: 0 },
      { fetch: fetchImpl },
    );
    const second = keyPair();
    const rolledFetch = makeFetch([second.jwk]);
    // Rebuild to prove the new key is the only one accepted after a refresh.
    const rolled = await createOidcVerifier(
      { issuer: ISSUER, audience: AUDIENCE, refreshIntervalMs: 0 },
      { fetch: rolledFetch },
    );
    expect(rolled.verify(bearer(second.privateKey, { roles: ["bp-viewer"] }), "read").ok).toBe(true);
    expect(rolled.verify(bearer(first.privateKey, { roles: ["bp-viewer"] }), "read").reason).toBe("bad-signature");
    verifier.close();
    rolled.close();
  });

  it("fails to start when the provider cannot be reached", async () => {
    const failing = (async () => ({ ok: false, status: 503 })) as unknown as typeof globalThis.fetch;
    await expect(
      createOidcVerifier(
        { issuer: ISSUER, audience: AUDIENCE, refreshIntervalMs: 0 },
        { fetch: failing },
      ),
    ).rejects.toThrow(/discovery/);
  });
});
