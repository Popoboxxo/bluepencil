/**
 * Signed per-device tokens (#36, phase 2).
 *
 * The shared secret's job was "is this the right string". A token's job is narrower and harder: a
 * client that holds one must be able to read it, be unable to change what it says, be refused after
 * it expires, be revocable on its own, and be limited to what it was issued for. Every case below is
 * one of those five, or the seam between two of them.
 *
 * Tampering tests build tokens by hand rather than by mutating a good one, because the interesting
 * attacks are not "change a character in the payload" — those fail the signature immediately. They
 * are the ones that decide *what is checked and in what order*: an expired token that is also
 * revoked, a token whose scope is empty, a signature that belongs to a different key.
 */
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  DEFAULT_TOKEN_TTL_SECONDS,
  createTokenIssuer,
  type TokenIssuerOptions,
} from "../../server/tokens";

const KEY = "signing-key-for-tests";
const OTHER_KEY = "a-different-signing-key";

/** A fixed clock, so nothing in this file depends on the wall clock. */
function at(iso: string): { now: () => Date; set: (next: string) => void } {
  let current = Date.parse(iso);
  return { now: () => new Date(current), set: (next: string) => void (current = Date.parse(next)) };
}

function harness(overrides: Partial<TokenIssuerOptions> = {}, start = "2026-09-29T12:00:00.000Z") {
  const clock = at(start);
  let counter = 0;
  const issuer = createTokenIssuer({
    key: KEY,
    now: clock.now,
    newId: () => `id-${(counter += 1)}`,
    ...overrides,
  });
  return { issuer, clock };
}

/** Builds a token by hand, so a test can sign with the wrong key or skip the signature entirely. */
function forge(payload: { claims: unknown; key?: string; tamper?: boolean }): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload.claims)).toString("base64url");
  const raw = `${header}.${body}`;
  const signature = createHmac("sha256", payload.key ?? KEY).update(raw).digest("base64url");
  return payload.tamper === true ? `${raw}.${signature.slice(0, -2)}XX` : `${raw}.${signature}`;
}

describe("signed tokens — issuing", () => {
  it("returns a token that verifies for what it was issued for", () => {
    const { issuer } = harness();

    const issued = issuer.issue({ device: "work-laptop", scope: ["read", "write"] });
    const verdict = issuer.verify(issued.token, "write");

    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.claims.device).toBe("work-laptop");
      expect(verdict.claims.jti).toBe("id-1");
    }
  });

  it("is a three-segment JWT-shaped string, so Bearer tooling can read it", () => {
    const { issuer } = harness();

    const parts = issuer.issue({ device: "d", scope: ["read"] }).token.split(".");

    expect(parts).toHaveLength(3);
    for (const part of parts) expect(part.length).toBeGreaterThan(0);
  });

  it("gives each token its own id, so devices can be revoked separately", () => {
    // The property the shared secret could not offer: revoking one device is removing one id.
    const { issuer } = harness();

    const first = issuer.issue({ device: "a", scope: ["read"] });
    const second = issuer.issue({ device: "b", scope: ["read"] });

    expect(first.claims.jti).not.toBe(second.claims.jti);
    const revoked = new Set([first.claims.jti]);
    expect(issuer.verify(first.token, "read", revoked).ok).toBe(false);
    expect(issuer.verify(second.token, "read", revoked).ok).toBe(true);
  });

  it("defaults to a read-only scope when none is asked for", () => {
    // Least privilege by default. An empty scope array would otherwise be a request for a token
    // that cannot do anything, which is a confusing thing to hand someone at configuration time.
    const { issuer } = harness();

    const verdict = issuer.verify(issuer.issue({ device: "d", scope: [] }).token, "read");

    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.claims.scope).toEqual(["read"]);
  });

  it("refuses to issue a token that expires immediately or never", () => {
    const { issuer } = harness();

    expect(() => issuer.issue({ device: "d", scope: ["read"], ttlSeconds: 0 })).toThrow();
    expect(() => issuer.issue({ device: "d", scope: ["read"], ttlSeconds: -1 })).toThrow();
    expect(() => issuer.issue({ device: "d", scope: ["read"], ttlSeconds: 1.5 })).toThrow();
  });

  it("refuses an empty signing key rather than signing with nothing", () => {
    // The failure this prevents is quiet and total: every token would verify against every other
    // token, because the "signature" would be a function of nothing.
    expect(() => createTokenIssuer({ key: "" })).toThrow();
  });

  it("uses a day as the default lifetime", () => {
    expect(DEFAULT_TOKEN_TTL_SECONDS).toBe(24 * 60 * 60);
  });
});

describe("signed tokens — refusing a token that was not issued here", () => {
  it("refuses a token signed with a different key", () => {
    // The core of the whole idea. A stolen token cannot be re-signed by its holder, because the key
    // never leaves the sidecar.
    const { issuer } = harness();
    const foreign = forge({ claims: { iat: "2026-09-29T12:00:00.000Z", exp: "2099-01-01T00:00:00.000Z", jti: "x", device: "attacker", scope: ["read", "write"] }, key: OTHER_KEY });

    const verdict = issuer.verify(foreign, "read");

    expect(verdict).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refuses a token whose payload was edited after signing", () => {
    const { issuer } = harness();
    const issued = issuer.issue({ device: "work-laptop", scope: ["read"] });
    // Re-encode the same claims with a wider scope, keeping the original signature.
    const [header, , signature] = issued.token.split(".") as [string, string, string];
    const widened = Buffer.from(
      JSON.stringify({ ...issued.claims, scope: ["read", "write"] }),
    ).toString("base64url");

    const verdict = issuer.verify(`${header}.${widened}.${signature}`, "write");

    expect(verdict).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refuses a corrupted signature", () => {
    const { issuer } = harness();
    const issued = issuer.issue({ device: "d", scope: ["read"] });

    const verdict = issuer.verify(issued.token.slice(0, -2) + "XX", "read");

    expect(verdict).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refuses anything that is not three segments", () => {
    const { issuer } = harness();

    for (const bad of ["", "a", "a.b", "a.b.c.d", "...", "not-a-token"]) {
      expect(issuer.verify(bad, "read"), bad).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("checks the signature before it looks at the claims", () => {
    // Order matters and is easy to get wrong: parsing first would let an attacker choose the shape
    // of object the verifier has to survive. This is a token whose body is valid JSON but signed
    // wrongly — if the implementation parsed first and verified after, it would reach the claim
    // checks and could report a *scope* or *expiry* reason, which would be a lie.
    const { issuer } = harness();
    const notSignedByUs = forge({
      claims: { iat: "2026-09-29T12:00:00.000Z", exp: "2020-01-01T00:00:00.000Z", jti: "x", device: "d", scope: [] },
      key: OTHER_KEY,
    });

    expect(issuer.verify(notSignedByUs, "read")).toEqual({ ok: false, reason: "bad-signature" });
  });
});

describe("signed tokens — expiry", () => {
  it("accepts a token right up to its expiry and refuses it after", () => {
    const { issuer, clock } = harness();
    const issued = issuer.issue({ device: "d", scope: ["read"], ttlSeconds: 60 });

    clock.set("2026-09-29T12:00:59.000Z");
    expect(issuer.verify(issued.token, "read").ok).toBe(true);

    clock.set("2026-09-29T12:01:00.000Z");
    expect(issuer.verify(issued.token, "read")).toEqual({ ok: false, reason: "expired" });
  });

  it("expires on the wire, not only locally", () => {
    // A client with a skewed clock must still be refused. Only the sidecar's clock decides, which
    // is why the claims carry absolute timestamps rather than a remaining duration.
    const { issuer, clock } = harness();
    const issued = issuer.issue({ device: "d", scope: ["read"], ttlSeconds: 10 });

    clock.set("2026-09-29T13:00:00.000Z");

    expect(issuer.verify(issued.token, "read")).toEqual({ ok: false, reason: "expired" });
  });
});

describe("signed tokens — revocation", () => {
  it("refuses a revoked token while leaving the others alone", () => {
    const { issuer } = harness();
    const keep = issuer.issue({ device: "keep", scope: ["read"] });
    const drop = issuer.issue({ device: "drop", scope: ["read"] });
    const revoked = new Set([drop.claims.jti]);

    expect(issuer.verify(drop.token, "read", revoked)).toEqual({ ok: false, reason: "revoked" });
    expect(issuer.verify(keep.token, "read", revoked).ok).toBe(true);
  });

  it("reports revocation before expiry, because a revoked token is the more useful answer", () => {
    // Both are true of a token that is expired *and* revoked. Saying "expired" would suggest the
    // client should get a new one, which is exactly wrong for a device that was deliberately cut
    // off — it would keep minting replacements.
    const { issuer, clock } = harness();
    const issued = issuer.issue({ device: "d", scope: ["read"], ttlSeconds: 60 });
    clock.set("2026-09-29T13:00:00.000Z");

    const verdict = issuer.verify(issued.token, "read", new Set([issued.claims.jti]));

    expect(verdict).toEqual({ ok: false, reason: "revoked" });
  });

  it("an empty revocation set revokes nothing", () => {
    const { issuer } = harness();
    const issued = issuer.issue({ device: "d", scope: ["read"] });

    expect(issuer.verify(issued.token, "read", new Set()).ok).toBe(true);
    expect(issuer.verify(issued.token, "read").ok).toBe(true);
  });
});

describe("signed tokens — scope", () => {
  it("refuses a write with a read-only token, and says why", () => {
    const { issuer } = harness();
    const issued = issuer.issue({ device: "reader", scope: ["read"] });

    expect(issuer.verify(issued.token, "read").ok).toBe(true);
    expect(issuer.verify(issued.token, "write")).toEqual({
      ok: false,
      reason: "insufficient-scope",
    });
  });

  it("treats write as implying read", () => {
    // A client that may mutate the note set can certainly read it. Leaving that to configuration
    // would be a trap: someone would issue a write token, find reads failing, and conclude the
    // verifier was broken.
    const { issuer } = harness();
    const issued = issuer.issue({ device: "writer", scope: ["write"] });

    expect(issuer.verify(issued.token, "read").ok).toBe(true);
    expect(issuer.verify(issued.token, "write").ok).toBe(true);
  });

  it("refuses a requirement that is not a known scope, even when the token claims it", () => {
    // Found by this test failing. The scope vocabulary is closed, and a token that says
    // `["admin"]` must not authorise a request for `admin`: a cast, a config typo, or a future scope
    // that reached an older binary would otherwise be granted exactly what it named. Re-signed with
    // the real key, because a hand-crafted token cannot get this far on its own.
    const { issuer } = harness();
    const issued = issuer.issue({ device: "d", scope: ["read"] });
    const [header] = issued.token.split(".") as [string, string, string];
    const payload = `${header}.${Buffer.from(JSON.stringify({ ...issued.claims, scope: ["admin"] })).toString("base64url")}`;
    const resigned = `${payload}.${createHmac("sha256", KEY).update(payload).digest("base64url")}`;

    expect(issuer.verify(resigned, "admin" as "read")).toEqual({
      ok: false,
      reason: "insufficient-scope",
    });
  });

  it("refuses a scope value it does not know when the requirement is a real one", () => {
    // The other direction: an unknown value in the token must not widen anything. `read` is still
    // refused, so a token can never carry a scope this build would honour.
    const { issuer } = harness();
    const issued = issuer.issue({ device: "d", scope: ["read"] });
    const [header] = issued.token.split(".") as [string, string, string];
    const payload = `${header}.${Buffer.from(JSON.stringify({ ...issued.claims, scope: ["admin"] })).toString("base64url")}`;
    const resigned = `${payload}.${createHmac("sha256", KEY).update(payload).digest("base64url")}`;

    expect(issuer.verify(resigned, "read")).toEqual({ ok: false, reason: "insufficient-scope" });
  });
});

describe("signed tokens — the key is the whole security boundary", () => {
  it("two issuers with different keys accept nothing from each other", () => {
    const ours = harness().issuer;
    const theirs = harness({ key: OTHER_KEY }).issuer;
    const theirToken = theirs.issue({ device: "d", scope: ["read", "write"] });

    expect(ours.verify(theirToken.token, "read")).toEqual({ ok: false, reason: "bad-signature" });
    expect(theirs.verify(theirToken.token, "read").ok).toBe(true);
  });

  it("rotating the key invalidates every token, which is the point", () => {
    // The trade against the shared secret: rotating the signing key logs everyone out at once,
    // because tokens are not re-servable from anything but the key. That is correct — a key that
    // was leaked must not stay useful — but it is why the key is a separate secret from the one
    // clients are configured with.
    const before = harness().issuer.issue({ device: "d", scope: ["read"] });
    const after = harness({ key: "rotated-key" }).issuer;

    expect(after.verify(before.token, "read")).toEqual({ ok: false, reason: "bad-signature" });
  });
});
