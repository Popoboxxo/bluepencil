/**
 * Unit tests for the federation error taxonomy (plan §6/§7, FR-16.10/NFR-22).
 *
 * The interesting parts are not "a class exists": they are the invariants every caller relies on —
 * an alias never survives construction, the exit table has a row for every code (and only the
 * documented values), and a secret cannot reach an MCP payload even when the message quotes only a
 * slice of it (T62).
 */
import { describe, expect, it } from "vitest";

import {
  EXIT_CODES,
  FEDERATION_ERROR_CODES,
  FederationError,
  REDACTED,
  Redactor,
  canonicalErrorCode,
  toExitCode,
  toMcpError,
  type CanonicalFederationErrorCode,
  type FederationErrorCode,
  type FederationExitCodeRow,
} from "../../src/federation/errors";

/** Narrows an arbitrary string from `Object.entries` to an indexable error code. */
function isFederationErrorCode(value: string): value is FederationErrorCode {
  return canonicalErrorCode(value) !== undefined;
}

/* ------------------------------------------------------------------------------------------------
 * T62 — redaction.multiple_secrets_and_partial
 * ---------------------------------------------------------------------------------------------- */

describe("Redactor (T62)", () => {
  const longValue = "sk-abc123secret";
  const encodedValue = "p@ss/w0rd+token";
  const jsonValue = 'quote"back\\slash';
  const substringValue = "abc123secret"; // strict substring of `longValue`
  const partialValue = "zzTOPSECRETzz9";
  const partialWindow = "TOPSECRE"; // 8-character window inside `partialValue`

  const message = [
    `full=${longValue}`,
    `encoded=${encodeURIComponent(encodedValue)}`,
    `json=${JSON.stringify(jsonValue).slice(1, -1)}`,
    `substring=${substringValue}`,
    `partial=${partialWindow}`,
    "unrelated=keep-this-text",
  ].join(" | ");

  it("masks full, URL-encoded, JSON-escaped, substring and 8-character partial occurrences", () => {
    const redactor = new Redactor([
      longValue,
      encodedValue,
      jsonValue,
      substringValue,
      partialValue,
      substringValue, // duplicate on purpose
    ]);

    const redacted = redactor.redact(message);

    expect(redacted).not.toContain(longValue);
    expect(redacted).not.toContain(encodeURIComponent(encodedValue));
    expect(redacted).not.toContain(JSON.stringify(jsonValue).slice(1, -1));
    expect(redacted).not.toContain(substringValue);
    expect(redacted).not.toContain(partialWindow);
    expect(redacted).toContain("unrelated=keep-this-text");
    expect(redacted).toContain(REDACTED);
    // Five distinct values; the duplicated substring secret is registered only once.
    expect(redactor.size).toBe(5);
  });

  it("is idempotent and never masks an empty string", () => {
    const redactor = new Redactor([longValue, encodedValue]);
    const once = redactor.redact(message);
    expect(redactor.redact(once)).toBe(once);
    expect(redactor.redact("")).toBe("");
  });

  it("ignores empty secrets and does not mask short partial windows", () => {
    const redactor = new Redactor(["", "ab"]);
    expect(redactor.size).toBe(1);
    // A short secret is still masked in full, but no partial window of it is derived.
    expect(redactor.redact("ab")).toBe(REDACTED);
    expect(redactor.redact("xyz")).toBe("xyz");
  });
});

/* ------------------------------------------------------------------------------------------------
 * Aliases and code normalisation
 * ---------------------------------------------------------------------------------------------- */

describe("canonicalErrorCode", () => {
  it("returns canonical codes unchanged and unknown spellings as undefined", () => {
    for (const code of FEDERATION_ERROR_CODES) {
      expect(canonicalErrorCode(code), code).toBe(code);
    }
    expect(canonicalErrorCode("timeout")).toBe("timeout");
    expect(canonicalErrorCode("not_a_code")).toBeUndefined();
    expect(canonicalErrorCode("")).toBeUndefined();
    // The deprecated wave-1 spellings are gone: they are unknown strings now.
    expect(canonicalErrorCode("instance_unknown")).toBeUndefined();
    expect(canonicalErrorCode("instance_read_only")).toBeUndefined();
    expect(canonicalErrorCode("read_only_session")).toBeUndefined();
    expect(canonicalErrorCode("aggregate_export_refused")).toBeUndefined();
  });

  it("constructs canonical errors for every code", () => {
    for (const code of FEDERATION_ERROR_CODES) {
      const error = new FederationError(code, "canonical");
      expect(error.code).toBe(code);
      expect(error.name).toBe("FederationError");
      expect(error).toBeInstanceOf(Error);
    }
  });

  it("falls back to invalid_argument for an unknown string", () => {
    expect(new FederationError("instance_unknown").code).toBe("invalid_argument");
    expect(new FederationError("not_a_code").code).toBe("invalid_argument");
  });

  it("covers the full canonical list, including invalid_base_url", () => {
    expect(FEDERATION_ERROR_CODES).toContain("invalid_base_url");
    expect(new Set(FEDERATION_ERROR_CODES).size).toBe(FEDERATION_ERROR_CODES.length);
    expect(FEDERATION_ERROR_CODES).not.toContain("instance_unknown");
    expect(FEDERATION_ERROR_CODES).not.toContain("instance_read_only");
    expect(FEDERATION_ERROR_CODES).not.toContain("read_only_session");
    expect(FEDERATION_ERROR_CODES).not.toContain("aggregate_export_refused");
  });
});

describe("FederationError", () => {
  it("carries code, instance, status and cause and defaults its message", () => {
    const cause = new Error("socket closed");
    const error = new FederationError("timeout", undefined, {
      instance: "dev",
      status: 504,
      cause,
    });

    expect(error.name).toBe("FederationError");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("timeout");
    expect(error.instance).toBe("dev");
    expect(error.status).toBe(504);
    expect(error.cause).toBe(cause);
    expect(error.message).toBe("bluepencil federation: timeout");
  });

  it("falls back to invalid_argument for an unknown spelling instead of throwing", () => {
    const error = new FederationError("not_a_code", "boom");
    expect(error.code).toBe("invalid_argument");
    expect(error.message).toBe("boom");
    expect(error.instance).toBeUndefined();
    expect(error.status).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------------------------------
 * EXIT_CODES completeness (plan §7)
 * ---------------------------------------------------------------------------------------------- */

describe("EXIT_CODES", () => {
  /**
   * The full plan §7 table, transcribed row by row. `invalid_base_url` is absent from the published
   * table but shares the registry/start-refusal row. Keeping the table literal (rather than only
   * re-deriving domains) is what catches a silently changed value in any single row.
   */
  const PLAN_SECTION_7 = {
    invalid_registry: { mcp: "start_refused", health: 4, runtime: 4 },
    invalid_base_url: { mcp: "start_refused", health: 4, runtime: 4 },
    unknown_instance: { mcp: "isError", health: 0, runtime: 4 },
    self_unavailable: { mcp: "isError", health: 0, runtime: 4 },
    mode_denied: { mcp: "isError", health: 0, runtime: 4 },
    read_only: { mcp: "isError", health: 0, runtime: 4 },
    timeout: { mcp: "partial", health: 5, runtime: 5 },
    partial: { mcp: "partial", health: 5, runtime: 5 },
    identity_mismatch: { mcp: "start_refused", health: 4, runtime: 4 },
    federates_missing: { mcp: "start_refused", health: 4, runtime: 4 },
    unverified: { mcp: "warning", health: 5, runtime: 0 },
    nested_federation: { mcp: "start_refused", health: 4, runtime: 4 },
    self_reference: { mcp: "start_refused", health: 4, runtime: 4 },
    id_collision: { mcp: "start_refused", health: 4, runtime: 4 },
    invalid_id: { mcp: "partial", health: 5, runtime: 4 },
    instance_required: { mcp: "isError", health: 0, runtime: 4 },
    fanout_denied: { mcp: "isError", health: 0, runtime: 4 },
    invalid_argument: { mcp: "isError", health: 0, runtime: 4 },
    environment_mismatch: { mcp: "isError", health: 0, runtime: 4 },
    usage: { mcp: "isError", health: 0, runtime: 1 },
    missing_credential: { mcp: "start_refused", health: 4, runtime: 4 },
    instance_unreachable: { mcp: "partial", health: 5, runtime: 5 },
    invalid_response: { mcp: "partial", health: 5, runtime: 5 },
    not_found: { mcp: "isError", health: 0, runtime: 4 },
    not_persisted: { mcp: "isError", health: 0, runtime: 5 },
  } as const satisfies Record<CanonicalFederationErrorCode, FederationExitCodeRow>;

  it("matches every plan §7 row exactly", () => {
    // The literal table and the canonical code list must describe the same set — a new code without
    // a §7 decision, or a stale table row, fails here.
    expect(Object.keys(PLAN_SECTION_7).sort()).toEqual([...FEDERATION_ERROR_CODES].sort());

    for (const code of FEDERATION_ERROR_CODES) {
      expect(EXIT_CODES[code], code).toEqual(PLAN_SECTION_7[code]);
    }
  });

  it("has exactly one row per canonical code and no alias rows", () => {
    expect(Object.keys(EXIT_CODES).sort()).toEqual([...FEDERATION_ERROR_CODES].sort());
    for (const code of FEDERATION_ERROR_CODES) {
      expect(isFederationErrorCode(code), code).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------------------------------------
 * Consumers
 * ---------------------------------------------------------------------------------------------- */

describe("toMcpError", () => {
  it("returns one redacted JSON text block with instance and status", () => {
    const tokenText = "sk-secret-token";
    const error = new FederationError("timeout", `request with ${tokenText} failed`, {
      instance: "dev",
      status: 504,
    });

    const response = toMcpError(error, new Redactor([tokenText]));

    expect(response.isError).toBe(true);
    expect(response.content).toHaveLength(1);
    const block = response.content[0];
    expect(block?.type).toBe("text");

    const payload = JSON.parse(block?.text ?? "") as {
      error: { code: string; message: string; instance?: string; status?: number };
    };
    expect(payload.error.code).toBe("timeout");
    expect(payload.error.message).not.toContain(tokenText);
    expect(payload.error.message).toContain(REDACTED);
    expect(payload.error.instance).toBe("dev");
    expect(payload.error.status).toBe(504);
  });

  it("omits instance and status when unset and leaves the message alone without a redactor", () => {
    const error = new FederationError("not_found", "note missing");
    const response = toMcpError(error);
    const payload = JSON.parse(response.content[0]?.text ?? "") as {
      error: { message: string; instance?: string; status?: number };
    };

    expect(payload.error.message).toBe("note missing");
    expect("instance" in payload.error).toBe(false);
    expect("status" in payload.error).toBe(false);
  });
});

describe("toExitCode", () => {
  it("returns the health and runtime code for the code", () => {
    const error = new FederationError("federates_missing");
    expect(toExitCode(error, "health")).toBe(4);
    expect(toExitCode(error, "runtime")).toBe(4);
    expect(toExitCode(new FederationError("usage"), "runtime")).toBe(1);
    expect(toExitCode(new FederationError("partial"), "runtime")).toBe(5);
    expect(toExitCode(new FederationError("not_found"), "health")).toBe(0);
    expect(toExitCode(new FederationError("unverified"), "health")).toBe(5);
    expect(toExitCode(new FederationError("unverified"), "runtime")).toBe(0);
  });

  it("uses the canonical row of the normalised code", () => {
    // An unknown spelling is normalised to invalid_argument at construction.
    const error = new FederationError("instance_unknown");
    expect(error.code).toBe("invalid_argument");
    expect(toExitCode(error, "health")).toBe(0);
    expect(toExitCode(error, "runtime")).toBe(4);
  });
});
