/**
 * @vitest-environment node — the comparison and budget logic is pure, but `node` keeps this suite
 * in the same environment as the other server unit tests (no DOM globals leak in by accident).
 *
 * UT-16 (spec §2.3, AC-5.4/AC-5.12): the ONE operator-secret check.
 *
 * Contract under test:
 * - `ok` — the constant-time comparison matched; the peer's `admin` budget was reset.
 * - `invalid` / `missing: false` — a wrong value; exactly one budget failure was recorded.
 * - `invalid` / `missing: true` — no secret configured or no value presented; **no** budget is
 *   consumed, because a missing value is not a guess (Änderung 2.1, §4.5, §5.3).
 * - `throttled` — the `admin` budget is already exhausted; the comparison is not even attempted,
 *   so a correct secret cannot bypass the brake.
 *
 * `adminGate()` and (from Task 7 on) `handleViewerStart()` call this function and nothing else;
 * UT-16 pins the function, RT-04 in `server-admin.test.ts` pins the wire behaviour and the shared
 * budget between `/admin/*` and the launcher.
 */
import { describe, expect, it } from "vitest";

import { verifyOperatorSecret } from "../../server/admin";
import type { AdminThrottle, HandlerContext, ThrottleKind } from "../../server/handler";

const SECRET = "operator-fixture-secret-1";
const REMOTE = "192.0.2.10";

function context(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    store: { notes: [] },
    base: "/api/v1/bluepencil",
    environment: "dev",
    adminSecret: SECRET,
    ...overrides,
  };
}

/** A throttle double that records every call and can pretend the budget is exhausted. */
function fakeThrottle(initial: { allowed?: boolean } = {}): {
  throttle: AdminThrottle;
  calls: string[];
  state: { allowed: boolean };
} {
  const state = { allowed: initial.allowed ?? true };
  const calls: string[] = [];
  const throttle: AdminThrottle = {
    allow(_remote: string | undefined, kind: ThrottleKind = "admin"): boolean {
      calls.push(`allow:${kind}`);
      return state.allowed;
    },
    failure(_remote: string | undefined, kind: ThrottleKind = "admin"): void {
      calls.push(`failure:${kind}`);
    },
    success(_remote: string | undefined, kind: ThrottleKind = "admin"): void {
      calls.push(`success:${kind}`);
    },
  };
  return { throttle, calls, state };
}

describe("verifyOperatorSecret: the four verdicts (UT-16)", () => {
  it("returns ok for the matching secret and resets that peer's admin budget", () => {
    const { throttle, calls } = fakeThrottle();

    const verdict = verifyOperatorSecret({ remote: REMOTE }, context({ adminThrottle: throttle }), SECRET);

    expect(verdict).toEqual({ kind: "ok" });
    // Budget is consulted before the comparison, success only after it.
    expect(calls).toEqual(["allow:admin", "success:admin"]);
  });

  it("returns invalid (missing: false) for a wrong value and spends one failure", () => {
    const { throttle, calls } = fakeThrottle();

    const verdict = verifyOperatorSecret({ remote: REMOTE }, context({ adminThrottle: throttle }), "not-the-secret");

    expect(verdict).toEqual({ kind: "invalid", missing: false });
    expect(calls).toEqual(["allow:admin", "failure:admin"]);
  });

  it("returns invalid (missing: true) for no presented value, without touching the budget", () => {
    const { throttle, calls } = fakeThrottle();

    const verdict = verifyOperatorSecret({ remote: REMOTE }, context({ adminThrottle: throttle }), undefined);

    expect(verdict).toEqual({ kind: "invalid", missing: true });
    // A missing value is not a guess: no allow read needed, no failure recorded, no success.
    expect(calls).toEqual([]);
  });

  it("returns invalid (missing: true) when the hub has no admin secret, without touching the budget", () => {
    const { throttle, calls } = fakeThrottle();

    const verdict = verifyOperatorSecret(
      { remote: REMOTE },
      context({ adminThrottle: throttle, adminSecret: undefined }),
      SECRET,
    );

    expect(verdict).toEqual({ kind: "invalid", missing: true });
    expect(calls).toEqual([]);
  });

  it("returns throttled for an exhausted budget and never compares, even the correct secret", () => {
    const { throttle, calls, state } = fakeThrottle();
    state.allowed = false;

    const correct = verifyOperatorSecret({ remote: REMOTE }, context({ adminThrottle: throttle }), SECRET);
    const wrong = verifyOperatorSecret({ remote: REMOTE }, context({ adminThrottle: throttle }), "not-the-secret");

    expect(correct).toEqual({ kind: "throttled", retryAfterSeconds: 300 });
    expect(wrong).toEqual({ kind: "throttled", retryAfterSeconds: 300 });
    // Only the read; no comparison, no success, no extra failure.
    expect(calls).toEqual(["allow:admin", "allow:admin"]);
  });

  it("does not treat a missing value as throttled even when the budget is exhausted", () => {
    // Missing is checked before the throttle read (spec §2.3 rule 2 before rule 3): it stays the
    // same 401 it always was and cannot push a peer further into the brake.
    const { throttle, calls, state } = fakeThrottle();
    state.allowed = false;

    const verdict = verifyOperatorSecret({ remote: REMOTE }, context({ adminThrottle: throttle }), undefined);

    expect(verdict).toEqual({ kind: "invalid", missing: true });
    expect(calls).toEqual([]);
  });
});

describe("verifyOperatorSecret: keyword collision in the comparison input (R2-F1)", () => {
  function countingThrottle(): { throttle: AdminThrottle; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      throttle: {
        allow: () => {
          calls.push("allow");
          return true;
        },
        failure: () => {
          calls.push("failure");
        },
        success: () => {
          calls.push("success");
        },
      },
    };
  }

  it("treats an empty configured secret + empty presented value as missing, not a match", () => {
    const { throttle, calls } = countingThrottle();

    const verdict = verifyOperatorSecret({ remote: REMOTE }, context({ adminThrottle: throttle, adminSecret: "" }), "");

    expect(verdict).toEqual({ kind: "invalid", missing: true });
    expect(calls).toEqual([]);
  });

  it("never authorizes a non-empty value against an empty configured secret", () => {
    const { throttle, calls } = countingThrottle();

    const verdict = verifyOperatorSecret({ remote: REMOTE }, context({ adminThrottle: throttle, adminSecret: "" }), SECRET);

    expect(verdict).toEqual({ kind: "invalid", missing: true });
    expect(calls).toEqual([]);
  });

  it("treats an empty presented value as missing even when a real secret is configured", () => {
    const { throttle, calls } = countingThrottle();

    const verdict = verifyOperatorSecret({ remote: REMOTE }, context({ adminThrottle: throttle }), "");

    expect(verdict).toEqual({ kind: "invalid", missing: true });
    // An empty value is not a guess, so it must not spend (or even read) the budget.
    expect(calls).toEqual([]);
  });
});

describe("verifyOperatorSecret: budget before and after the comparison (UT-16)", () => {
  /** A minimal real counter with the documented admin budget (10 failures / 5 minutes). */
  function budget(): { throttle: AdminThrottle; failures: () => number } {
    let count = 0;
    const throttle: AdminThrottle = {
      allow: () => count < 10,
      failure: () => {
        count += 1;
      },
      success: () => {
        count = 0;
      },
    };
    return { throttle, failures: () => count };
  }

  it("a wrong value spends the budget; the eleventh attempt is throttled", () => {
    const { throttle, failures } = budget();
    const ctx = context({ adminThrottle: throttle });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(verifyOperatorSecret({ remote: REMOTE }, ctx, `wrong-${attempt}`)).toEqual({
        kind: "invalid",
        missing: false,
      });
    }
    expect(failures()).toBe(10);
    expect(verifyOperatorSecret({ remote: REMOTE }, ctx, "wrong-after-budget")).toEqual({
      kind: "throttled",
      retryAfterSeconds: 300,
    });
    // The throttled attempt added nothing.
    expect(failures()).toBe(10);
  });

  it("a missing value never spends the budget, so probing without it cannot lock the operator out", () => {
    const { throttle, failures } = budget();
    const ctx = context({ adminThrottle: throttle });

    for (let attempt = 0; attempt < 25; attempt += 1) {
      expect(verifyOperatorSecret({ remote: REMOTE }, ctx, undefined)).toEqual({
        kind: "invalid",
        missing: true,
      });
    }
    expect(failures()).toBe(0);

    // The first real guess is therefore still the first failure, not the eleventh.
    expect(verifyOperatorSecret({ remote: REMOTE }, ctx, "wrong-first")).toEqual({
      kind: "invalid",
      missing: false,
    });
    expect(failures()).toBe(1);
  });

  it("a successful check clears the failures of that peer's admin budget", () => {
    const { throttle, failures } = budget();
    const ctx = context({ adminThrottle: throttle });

    for (let attempt = 0; attempt < 9; attempt += 1) {
      verifyOperatorSecret({ remote: REMOTE }, ctx, `wrong-${attempt}`);
    }
    expect(failures()).toBe(9);

    expect(verifyOperatorSecret({ remote: REMOTE }, ctx, SECRET)).toEqual({ kind: "ok" });
    expect(failures()).toBe(0);
  });

  it("keys the budget by peer: one address's failures do not throttle another's check", () => {
    let other = 0;
    const throttle: AdminThrottle = {
      allow: (remote) => (remote === "198.51.100.7" ? other < 10 : true),
      failure: (remote) => {
        if (remote === "198.51.100.7") other += 1;
      },
      success: () => {},
    };
    const ctx = context({ adminThrottle: throttle });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      verifyOperatorSecret({ remote: "198.51.100.7" }, ctx, `wrong-${attempt}`);
    }
    expect(verifyOperatorSecret({ remote: "198.51.100.7" }, ctx, "wrong-after")).toEqual({
      kind: "throttled",
      retryAfterSeconds: 300,
    });
    // A different peer is unaffected: the brake is per peer, never global.
    expect(verifyOperatorSecret({ remote: "203.0.113.9" }, ctx, SECRET)).toEqual({ kind: "ok" });
  });
});
