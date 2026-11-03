/**
 * The options page's credential copy (AC-B17, AC-B43).
 *
 * The form has to say two things the user cannot see: that the shared secret is the legacy mode and
 * a per-device signed token is the one to prefer, and when the stored token expires. The copy is
 * pure (`extension/src/credential-copy.ts`), so every branch is pinned here without a browser — and
 * every case also proves the credential itself never ends up in the copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { credentialCopy } from "../../extension/src/credential-copy";

/** Fixed clock, so "expires in about 6 h" is a statement and not a flaky race against the runner. */
const NOW = "2026-11-03T10:00:00.000Z";
const SIX_HOURS_LATER = "2026-11-03T16:00:00.000Z";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("credentialCopy", () => {
  describe("the shared secret mode (AC-B17)", () => {
    it("names the shared secret as deprecated and recommends a signed token", () => {
      const copy = credentialCopy({ auth: "secret", token: "shared-secret-xyz", tokenExpiresAt: "" });

      expect(copy.label).toBe("Shared secret");
      expect(copy.hint.toLowerCase()).toContain("shared secret");
      expect(copy.hint.toLowerCase()).toContain("deprecated");
      expect(copy.hint.toLowerCase()).toContain("signed token");
      // Nothing to say about an expiry: a secret does not have one.
      expect(copy.state).toBeNull();
    });

    it("does not echo the secret into any field", () => {
      const copy = credentialCopy({ auth: "secret", token: "TOPSECRET-shared", tokenExpiresAt: "" });

      for (const value of [copy.label, copy.hint, copy.state ?? ""]) {
        expect(value).not.toContain("TOPSECRET");
      }
    });
  });

  describe("the signed-token mode (AC-B17, AC-B43)", () => {
    it("labels the token as signed and recommends a per-device token", () => {
      const copy = credentialCopy({ auth: "token", token: "a.b.c", tokenExpiresAt: "" });

      expect(copy.label.toLowerCase()).toContain("signed token");
      expect(copy.hint.toLowerCase()).toContain("per-device");
      expect(copy.hint).toContain("--device");
    });

    it("has no state without an expiry", () => {
      const copy = credentialCopy({ auth: "token", token: "a.b.c", tokenExpiresAt: "" });

      expect(copy.state).toBeNull();
    });

    it("names the expiry date and the time left when an expiry is stored", () => {
      const copy = credentialCopy({
        auth: "token",
        token: "a.b.c",
        tokenExpiresAt: SIX_HOURS_LATER,
      });

      expect(copy.state).not.toBeNull();
      // The stored ISO instant is named, so the line can be checked against the hub's deadline.
      expect(copy.state).toContain(SIX_HOURS_LATER);
      expect(copy.state).toMatch(/^Expires /);
      expect(copy.state).toContain("6 h 0 min");
    });

    it("says a token with an expiry in the past has expired", () => {
      const copy = credentialCopy({
        auth: "token",
        token: "a.b.c",
        tokenExpiresAt: "2026-11-03T09:00:00.000Z",
      });

      expect(copy.state).not.toBeNull();
      expect(copy.state).toMatch(/^Expired /);
      expect(copy.state).toContain("2026-11-03T09:00:00.000Z");
      expect(copy.state).toMatch(/new token/i);
    });

    it("treats an unreadable expiry as unknown rather than inventing a deadline", () => {
      const copy = credentialCopy({ auth: "token", token: "a.b.c", tokenExpiresAt: "not-a-date" });

      expect(copy.state).toBeNull();
    });

    it("says the token is missing when only whitespace is stored", () => {
      const copy = credentialCopy({ auth: "token", token: "   ", tokenExpiresAt: "" });

      expect(copy.state).not.toBeNull();
      expect(copy.state).toMatch(/No token stored/i);
    });

    it("does not echo the token into any field", () => {
      const copy = credentialCopy({
        auth: "token",
        token: "TOPSECRET-token",
        tokenExpiresAt: SIX_HOURS_LATER,
      });

      for (const value of [copy.label, copy.hint, copy.state ?? ""]) {
        expect(value).not.toContain("TOPSECRET");
      }
    });
  });

  describe("the none mode with a leftover token (AC-B43)", () => {
    it("explains that the credential is disabled and reports no state", () => {
      const copy = credentialCopy({
        auth: "none",
        token: "left-over-from-before",
        tokenExpiresAt: SIX_HOURS_LATER,
      });

      expect(copy.label).toBe("Credential");
      expect(copy.hint.toLowerCase()).toContain("disabled");
      // `none` wins over the stale value, exactly as it does in the probe and the handoff.
      expect(copy.state).toBeNull();
      expect(copy.hint).not.toContain("left-over");
    });
  });
});
