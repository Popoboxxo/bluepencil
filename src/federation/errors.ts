/**
 * Federation error taxonomy, redaction and exit-code mapping (plan §6/§7, FR-16.10/NFR-22).
 *
 * A federated session touches several processes, so a failure has to answer three different
 * consumers at once: the MCP client (an `isError` tool result), the CLI (a process exit code) and
 * the human reading a log. This module is the one place where those three views are derived from a
 * single canonical error code — no caller invents its own mapping.
 *
 * Two rules shape the API:
 *  - there is exactly one canonical code union; an unknown spelling falls back to
 *    `invalid_argument` instead of introducing a second vocabulary;
 *  - every message that leaves the process passes through a {@link Redactor} built from the
 *    resolved environment values, so a token cannot reach a log, a tool result or a terminal
 *    (NFR-22). Partial matches are masked too, because an error message may quote only a slice.
 */

/* The import is type-only on purpose: it creates no runtime edge from `federation/` into `mcp/`.
 * `mcp/tools` itself imports `mcp/backend` type-only, so the type graph stays acyclic. */
import type { ToolResponse } from "../mcp/tools";

/* ------------------------------------------------------------------------------------------------
 * Codes
 * ---------------------------------------------------------------------------------------------- */

/** Codes the federation code actually emits (plan §6). */
export const FEDERATION_ERROR_CODES = [
  "invalid_registry",
  "invalid_base_url",
  "unknown_instance",
  "self_unavailable",
  "mode_denied",
  "read_only",
  "timeout",
  "partial",
  "identity_mismatch",
  "federates_missing",
  "unverified",
  "nested_federation",
  "self_reference",
  "id_collision",
  "invalid_id",
  "instance_required",
  "fanout_denied",
  "invalid_argument",
  "environment_mismatch",
  "usage",
  "missing_credential",
  "instance_unreachable",
  "invalid_response",
  "not_found",
  "not_persisted",
] as const;

/** The canonical code union. There are no aliases: every code in this list is emitted as-is. */
export type CanonicalFederationErrorCode = (typeof FEDERATION_ERROR_CODES)[number];
export type FederationErrorCode = CanonicalFederationErrorCode;

const CANONICAL_CODES: ReadonlySet<string> = new Set(FEDERATION_ERROR_CODES);

/**
 * Resolve a spelling to a canonical code. Canonical codes map to themselves and anything unknown is
 * `undefined` — this function never throws.
 */
export function canonicalErrorCode(code: string): FederationErrorCode | undefined {
  if (typeof code !== "string") return undefined;
  return CANONICAL_CODES.has(code) ? (code as FederationErrorCode) : undefined;
}

/* ------------------------------------------------------------------------------------------------
 * Error class
 * ---------------------------------------------------------------------------------------------- */

export interface FederationErrorDetails {
  instance?: string;
  status?: number;
  cause?: unknown;
}

/** The single error type the federation layer throws and serialises. */
export class FederationError extends Error {
  /** Always canonical after construction; an unknown spelling becomes `invalid_argument`. */
  readonly code: FederationErrorCode;
  readonly instance?: string;
  readonly status?: number;

  /**
   * @param code    canonical code or arbitrary string. An unknown string falls back to
   *                `invalid_argument` instead of throwing — constructing an error must never fail,
   *                otherwise the real failure would be replaced by a `TypeError`.
   */
  constructor(
    code: FederationErrorCode | string,
    message?: string,
    details?: FederationErrorDetails,
  ) {
    const canonical = canonicalErrorCode(code) ?? "invalid_argument";
    const options: ErrorOptions | undefined =
      details != null && "cause" in details ? { cause: details.cause } : undefined;
    super(message ?? `bluepencil federation: ${canonical}`, options);
    this.name = "FederationError";
    this.code = canonical;
    /* `exactOptionalPropertyTypes` is off, so assigning `undefined` to an optional field is fine
     * and keeps the declared shape simple. */
    this.instance = details?.instance;
    this.status = details?.status;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Redaction (NFR-22)
 * ---------------------------------------------------------------------------------------------- */

/** Replacement text exposed so callers and tests can compare without hard-coding it. */
export const REDACTED = "[redacted]";

/* Internal markers made of control characters only: they cannot collide with an environment value
 * of any practical shape, and they let `redact` stay idempotent while protecting existing markers. */
const EXISTING_MARKER = "\u0000\u0001\u0002";
const MASK_MARKER = "\u0003\u0004\u0005";

const PARTIAL_WINDOW = 8;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function jsonInner(value: string): string | undefined {
  try {
    const quoted = JSON.stringify(value);
    return quoted.length >= 2 ? quoted.slice(1, -1) : undefined;
  } catch {
    return undefined;
  }
}

function urlEncoded(value: string): string | undefined {
  try {
    return encodeURIComponent(value);
  } catch {
    /* A lone surrogate makes `encodeURIComponent` throw; the raw secret is still registered. */
    return undefined;
  }
}

/**
 * Removes resolved secrets from messages before they leave the process.
 *
 * Rules:
 *  - empty and non-string secrets are ignored; duplicates are collapsed;
 *  - replacements run longest-first, so a secret that contains another secret is masked whole;
 *  - the exact value, its `encodeURIComponent` form and its JSON-escaped form are all masked;
 *  - for secrets of eight or more characters every contiguous eight-character window is masked as
 *    well, so a message quoting a slice (`abc123se` out of `sk-abc123secret`) leaks nothing.
 *    Shorter windows are not considered — they would mask ordinary words;
 *  - the operation is idempotent and never throws; an empty message stays empty.
 */
export class Redactor {
  readonly size: number;

  private readonly pattern: RegExp | null;

  constructor(secrets: readonly string[] = []) {
    const registered = new Set<string>();
    const needles = new Set<string>();

    const addNeedle = (needle: string | undefined): void => {
      if (needle !== undefined && needle.length > 0) needles.add(needle);
    };

    for (const secret of secrets) {
      if (typeof secret !== "string" || secret.length === 0) continue;
      if (registered.has(secret)) continue;
      registered.add(secret);

      addNeedle(secret);
      addNeedle(urlEncoded(secret));
      addNeedle(jsonInner(secret));

      if (secret.length >= PARTIAL_WINDOW) {
        for (let start = 0; start + PARTIAL_WINDOW <= secret.length; start += 1) {
          addNeedle(secret.slice(start, start + PARTIAL_WINDOW));
        }
      }
    }

    this.size = registered.size;
    const ordered = [...needles].sort((left, right) => right.length - left.length);
    this.pattern =
      ordered.length === 0 ? null : new RegExp(ordered.map(escapeRegExp).join("|"), "g");
  }

  redact(message: string): string {
    if (this.pattern === null || typeof message !== "string" || message.length === 0) return message;

    /* Protect markers that are already present, then mask with a sentinel and only then restore
     * both. Without this an existing `[redacted]` containing a needle would be masked again and the
     * function would not be idempotent. */
    const protectedMessage = message.split(REDACTED).join(EXISTING_MARKER);
    const masked = protectedMessage.replace(this.pattern, MASK_MARKER);
    return masked.split(MASK_MARKER).join(REDACTED).split(EXISTING_MARKER).join(REDACTED);
  }
}

/* ------------------------------------------------------------------------------------------------
 * Exit codes (plan §7)
 * ---------------------------------------------------------------------------------------------- */

export interface FederationExitCodeRow {
  mcp: "isError" | "start_refused" | "partial" | "warning";
  health: number;
  runtime: number;
}

const CANONICAL_EXIT_CODES: Record<CanonicalFederationErrorCode, FederationExitCodeRow> = {
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
};

/**
 * Single source of truth for plan §7 — keep this table in sync with the plan before changing a
 * value. Health codes answer "is this instance healthy?" (0 healthy, 4 misconfigured/refused,
 * 5 degraded); runtime codes answer "did the command succeed?" (1 usage, 4 failed, 5 partial).
 *
 * `mcp` is the shape of the tool result: `partial` means the aggregate carries the failure in a
 * partial entry, `start_refused` aborts startup, `isError` is a plain failing tool call and
 * `warning` is an advisory note that does not fail the call (see `unverified`).
 *
 * `unverified` is the one documented exception to the otherwise uniform runtime domain {1, 4, 5}:
 * §7 binds it to CLI runtime 0. An instance that answers without `app` is usable — the warning is
 * health 5 (degraded) but the command itself did not fail.
 */
export const EXIT_CODES: Readonly<Record<FederationErrorCode, FederationExitCodeRow>> =
  CANONICAL_EXIT_CODES;

/* ------------------------------------------------------------------------------------------------
 * Consumers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Render a federation failure as an MCP tool result. The payload is one JSON text block with the
 * canonical code, the (redacted) message and, when known, the instance and HTTP status.
 *
 * This helper is for codes whose §7 MCP mode is `isError` — it always sets `isError: true` and
 * therefore turns the failure into a hard tool error. Codes mapped to `partial` travel in the
 * aggregate envelope's partial entry, and `warning` codes (e.g. `unverified`) are surfaced as an
 * advisory warning; neither must ever be passed here, or a degraded-but-usable result would be
 * reported as a failure.
 */
export function toMcpError(error: FederationError, redactor?: Redactor): ToolResponse {
  const errorBody: { code: string; message: string; instance?: string; status?: number } = {
    code: error.code,
    message: redactor === undefined ? error.message : redactor.redact(error.message),
  };
  if (error.instance !== undefined) errorBody.instance = error.instance;
  if (error.status !== undefined) errorBody.status = error.status;

  return {
    content: [{ type: "text", text: JSON.stringify({ error: errorBody }) }],
    isError: true,
  };
}

/**
 * Process exit code for a federation failure. `redactor` is accepted for API symmetry with
 * {@link toMcpError} but is intentionally unused: only the number leaves this function, so there is
 * no message to redact. This never throws.
 */
export function toExitCode(
  error: FederationError,
  context: "health" | "runtime",
  redactor?: Redactor,
): number {
  void redactor;
  const row: FederationExitCodeRow | undefined = EXIT_CODES[error.code];
  /* Defensive only: the constructor guarantees a canonical code, so the row always exists. */
  if (row === undefined) return context === "runtime" ? 4 : 5;
  return row[context];
}

/**
 * True for the failures a federator tolerates at start-up (plan §6/§7, T72/R6).
 *
 * A peer that is not up yet must not take the whole session down: it stays in `list_instances`
 * with `ok:false`, makes aggregates `partial` and keeps `instances health` at exit 5. Every
 * identity failure (`identity_mismatch`, `federates_missing`, `nested_federation`, …) is
 * deliberately **not** degradable — starting against a mis-wired peer is worse than not starting.
 */
export function isDegradable(code: FederationErrorCode): boolean {
  return code === "instance_unreachable" || code === "timeout";
}
