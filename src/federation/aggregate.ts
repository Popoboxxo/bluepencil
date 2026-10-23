/**
 * Fan-out aggregate over several bluepencil instances (plan §6, FR-16.12, Rev. 4).
 *
 * One read against N instances looks simple but has three properties the tool layer relies on:
 *
 * - **Partial is a value, not an exception.** A slow or broken instance must not hide the notes
 *   the healthy ones returned. {@link aggregateList} therefore resolves with `partial: true` and
 *   one error entry per failed instance. It throws only for a caller mistake that makes the
 *   request meaningless (unknown instance, `self` requested but not available).
 * - **The order is global and deterministic.** Notes are merged and then sorted by
 *   {@link compareForReview} with an instance tie-break, never by registry order, so two runs
 *   over the same set are byte-identical (FR-4.6).
 * - **IDs are qualified, never rewritten.** A returned note is copied and its id becomes
 *   `instance/noteId`. A note id that cannot be qualified is reported as `invalid_id` and skipped
 *   — it is never silently dropped and never truncated (FR-16.11).
 *
 * Failures are per instance, so the healthy instance's notes survive; when *every* instance
 * fails the result is still a normal return value (`notes: []`, `partial: false`, one error per
 * source). Turning that into an MCP `isError` is the tool layer's job (PR 4), not this module's.
 *
 * No persistence, no retries, no polling: each selected source is read exactly once.
 */

import type { Environment, Note, NoteFilter } from "../core/model";
import { compareForReview } from "../data/order";
import { FederationError, type FederationErrorCode } from "./errors";
import { formatQualifiedId, SELF_INSTANCE } from "./ids";

/* ------------------------------------------------------------------------------------------------
 * Shapes
 * ---------------------------------------------------------------------------------------------- */

/**
 * The narrow contract the aggregate needs from a peer. The federation HTTP client implements it;
 * tests use plain objects. `list` must not mutate the filter it receives.
 */
export interface ReadSource {
  readonly id: string;
  readonly app?: string;
  readonly environment?: Environment;
  readonly mode?: "read" | "write";
  list(filter: NoteFilter): Promise<Note[]>;
}

/** A note as it appears in an aggregate: the qualified id plus the instance it came from. */
export interface FederatedNote extends Note {
  instance: string;
  app: string;
}

/** Per-instance health row for the tool result, in selection/registry order. */
export interface InstanceStatus {
  id: string;
  app?: string;
  environment?: Environment;
  ok: boolean;
  /**
   * Filled by the federation backend from `InstanceClient.health()` (PR 4); the aggregate never
   * verifies identity itself and deliberately does not guess this flag.
   */
  unverified?: boolean;
  /** Notes the instance returned, counted before the global limit is applied. */
  count?: number;
  code?: FederationErrorCode;
  /**
   * Populated by the federation backend from `InstanceClient.health()` (PR 4), not by this
   * aggregate: the aggregate only knows the registry view and never guesses an instance's version.
   */
  version?: string;
  mode?: "read" | "write";
  includeSelf?: boolean;
}

export interface AggregateOptions {
  limit: number;
  timeoutMs: number;
  /** `undefined`/`"all"`/`"*"` = every source, `"self"` = own instance, else one source id. */
  instance?: string;
  includeSelf: boolean;
  /** Worker-pool width across sources; clamped to 1..16. Defaults to 8. */
  concurrency?: number;
}

export interface AggregateResult {
  notes: FederatedNote[];
  instances: InstanceStatus[];
  /** `true` when at least one source succeeded and at least one failed. */
  partial: boolean;
  truncated: boolean;
  /**
   * One entry per failed source or unusable note id. Safe to log and serialise: entries never
   * carry a `cause` chain, so a raw source error (which may contain a token or payload) cannot leak.
   */
  errors: FederationError[];
}

/* ------------------------------------------------------------------------------------------------
 * Bounds
 * ---------------------------------------------------------------------------------------------- */

export const DEFAULT_AGGREGATE_LIMIT = 200;
export const MAX_AGGREGATE_LIMIT = 1000;
export const DEFAULT_AGGREGATE_TIMEOUT_MS = 3000;
export const DEFAULT_AGGREGATE_CONCURRENCY = 8;

/** Upper bound on parallel reads; the registry uses the same ceiling. */
const MAX_AGGREGATE_CONCURRENCY = 16;

/** App label for a note whose source did not declare one — never the note's own (unknown) app. */
const UNKNOWN_APP = "unknown";

/**
 * Clamp a caller-supplied limit to the bounded read window (T87). `undefined`, `NaN` and values
 * below 1 fall back to {@link DEFAULT_AGGREGATE_LIMIT}; anything above {@link MAX_AGGREGATE_LIMIT}
 * is capped; fractions are floored.
 */
export function clampLimit(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value) || value < 1) {
    return DEFAULT_AGGREGATE_LIMIT;
  }
  return Math.min(Math.floor(value), MAX_AGGREGATE_LIMIT);
}

/** Clamp the worker-pool width; a non-finite value falls back to the default. */
function clampConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_AGGREGATE_CONCURRENCY;
  }
  return Math.min(MAX_AGGREGATE_CONCURRENCY, Math.max(1, Math.floor(value)));
}

/* ------------------------------------------------------------------------------------------------
 * Timeout
 * ---------------------------------------------------------------------------------------------- */

/**
 * Reject with `FederationError("timeout")` when `promise` has not settled within `timeoutMs`.
 * The timer is always cleared on settle, so a fast answer leaves no pending handle behind (important
 * for a CLI that would otherwise stay alive). The wrapped promise keeps its handlers attached through
 * `Promise.race`, so a late rejection cannot surface as an unhandled rejection.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  instance: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new FederationError(
          "timeout",
          `Instance "${instance}" did not answer within ${timeoutMs} ms`,
          { instance },
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/* ------------------------------------------------------------------------------------------------
 * Selection
 * ---------------------------------------------------------------------------------------------- */

/**
 * Source ids that a read must not resolve to a concrete peer. `self` is handled separately; the
 * selectors would silently widen a request, so an unknown selector-like id is reported like any
 * other unknown id.
 */
function selectSources(
  sources: readonly ReadSource[],
  self: ReadSource | undefined,
  options: AggregateOptions,
): ReadSource[] {
  const requested = options.instance;

  if (requested === SELF_INSTANCE) {
    if (self === undefined || !options.includeSelf) {
      throw new FederationError(
        "self_unavailable",
        "The local instance is not part of this session",
        { instance: SELF_INSTANCE },
      );
    }
    return [self];
  }

  if (requested === undefined || requested === "all" || requested === "*") {
    /* A registry entry named `self` is a bug (the id is reserved). When a distinct self source is
     * supplied, skip such an entry so the local notes are not read twice and do not collide on
     * `self/...` ids. Without a self source it is the only self-ish source and is kept as-is. */
    const selected = sources.filter(
      (source) => !(self !== undefined && source.id === SELF_INSTANCE),
    );
    if (options.includeSelf && self !== undefined) {
      selected.push(self);
    }
    return selected;
  }

  const match = sources.find((source) => source.id === requested);
  if (match === undefined) {
    throw new FederationError(
      "unknown_instance",
      `Unknown instance "${requested}"`,
      { instance: requested },
    );
  }
  return [match];
}

/* ------------------------------------------------------------------------------------------------
 * Bounded fan-out
 * ---------------------------------------------------------------------------------------------- */

/**
 * A minimal counting semaphore: callers get a task runner that starts at most `limit` tasks at a
 * time and drains waiting tasks in arrival order. Tasks never reject through this helper — the
 * caller wraps them in `Promise.allSettled`.
 */
function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiters: Array<() => void> = [];

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      const next = waiters.shift();
      if (next !== undefined) {
        next();
      }
    }
  };
}

/* ------------------------------------------------------------------------------------------------
 * Per-source outcome
 * ---------------------------------------------------------------------------------------------- */

interface SourceSuccess {
  source: ReadSource;
  ok: true;
  notes: Note[];
}

interface SourceFailure {
  source: ReadSource;
  ok: false;
  error: FederationError;
}

type SourceOutcome = SourceSuccess | SourceFailure;

/**
 * Normalise a source failure into the error reported in {@link AggregateResult.errors}.
 *
 * The original error is deliberately NOT attached as `cause`: a raw error may quote a token, a
 * request URL or a response body in its message/stack, and the aggregate result is handed to
 * callers that log or serialise it (CLI, MCP). The message is reduced to a short, redaction-safe
 * form instead — the wrapped error's own message only when it is already a `FederationError`
 * (whose messages are authored by this layer), otherwise a generic `"request failed"`. Every
 * returned error is freshly constructed, so no cause chain can survive.
 */
function asFederationError(error: unknown, instance: string): FederationError {
  if (error instanceof FederationError) {
    return new FederationError(error.code, `${instance}: ${error.message}`, {
      instance: error.instance ?? instance,
      ...(error.status === undefined ? {} : { status: error.status }),
    });
  }
  return new FederationError("instance_unreachable", `${instance}: request failed`, {
    instance,
  });
}

/* ------------------------------------------------------------------------------------------------
 * Aggregate
 * ---------------------------------------------------------------------------------------------- */

/**
 * Read `filter` from the selected instances, qualify every note and return the merged review list.
 *
 * Selection: `instance` unset/`all`/`*` → all registry sources plus `self` when `includeSelf`;
 * `self` → only the local source (throws `self_unavailable` when unavailable or excluded); any
 * other id → that one source (throws `unknown_instance` otherwise).
 *
 * Each source is read once, under `timeoutMs`, with at most `concurrency` reads in flight. A
 * rejection, a timeout or a non-array answer becomes an error entry for that source; the other
 * sources are unaffected. Notes are copied — the source's objects are never mutated.
 */
export async function aggregateList(
  sources: readonly ReadSource[],
  self: ReadSource | undefined,
  filter: NoteFilter,
  options: AggregateOptions,
): Promise<AggregateResult> {
  const selected = selectSources(sources, self, options);
  const limit = clampLimit(options.limit);
  const concurrency = clampConcurrency(options.concurrency);

  if (selected.length === 0) {
    /* Nothing to ask: an empty window is a valid answer, not a partial failure. */
    return { notes: [], instances: [], partial: false, truncated: false, errors: [] };
  }

  const run = createLimiter(concurrency);
  const settled = await Promise.allSettled(
    selected.map((source) =>
      run(async (): Promise<SourceSuccess> => {
        /* The timeout starts when the source is actually called, not while it waits for a slot. */
        const raw: unknown = await withTimeout(source.list(filter), options.timeoutMs, source.id);
        if (!Array.isArray(raw)) {
          throw new FederationError(
            "invalid_response",
            `Instance "${source.id}" returned a non-array note list`,
            { instance: source.id },
          );
        }
        return { source, ok: true, notes: raw as Note[] };
      }),
    ),
  );

  const outcomes: SourceOutcome[] = settled.map((entry, index) => {
    const source = selected[index] as ReadSource;
    if (entry.status === "fulfilled") {
      return entry.value;
    }
    return { source, ok: false, error: asFederationError(entry.reason, source.id) };
  });

  const errors: FederationError[] = [];
  const instances: InstanceStatus[] = [];
  const qualified: FederatedNote[] = [];
  let succeeded = 0;

  for (const outcome of outcomes) {
    const { source } = outcome;
    instances.push(statusOf(outcome));

    if (!outcome.ok) {
      errors.push(outcome.error);
      continue;
    }

    succeeded += 1;

    for (const note of outcome.notes) {
      /* A malformed note (e.g. an object without an id) is a note-level finding, not a reason to
       * crash the whole aggregate: report it and move on. */
      if (typeof note?.id !== "string") {
        errors.push(
          new FederationError("invalid_id", `${source.id}: note without a string id was skipped`, {
            instance: source.id,
          }),
        );
        continue;
      }

      try {
        qualified.push({
          ...note,
          id: formatQualifiedId(source.id, note.id),
          instance: source.id,
          app: source.app ?? UNKNOWN_APP,
        });
      } catch (error) {
        /* A single unusable id is a note-level finding, not a source failure: the other notes from
         * the same instance still count as a successful read. */
        errors.push(asFederationError(error, source.id));
      }
    }
  }

  /* Wave-1 order (global review order, instance tiebreak) — deliberately differs from plan §6's
   * per-instance/registry-outer wording; recorded as a deviation to be reconciled in the plan, not
   * silently changed. */
  qualified.sort(
    (a, b) =>
      compareForReview(a, b) ||
      compareText(a.instance, b.instance) ||
      compareText(a.id, b.id),
  );

  const failed = outcomes.length - succeeded;

  return {
    notes: qualified.slice(0, limit),
    instances,
    partial: succeeded > 0 && failed > 0,
    truncated: qualified.length > limit,
    errors,
  };
}

/** Code-unit comparison for the deterministic instance/id tie-break (no locale). */
function compareText(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/** Health row for one outcome; `count` counts the raw notes, before the global limit. */
function statusOf(outcome: SourceOutcome): InstanceStatus {
  const { source } = outcome;
  const status: InstanceStatus = { id: source.id, ok: outcome.ok };

  /* Same provenance rule as `FederatedNote.app`: the registry/source view wins, and a source that
   * declares no app is reported as `unknown` rather than omitted or guessed. */
  status.app = source.app ?? UNKNOWN_APP;

  const environment =
    source.environment ?? (outcome.ok ? outcome.notes[0]?.environment : undefined);
  if (environment !== undefined) {
    status.environment = environment;
  }

  if (source.id === SELF_INSTANCE) {
    status.includeSelf = true;
    status.mode = source.mode ?? "read";
  } else if (source.mode !== undefined) {
    status.mode = source.mode;
  }

  if (outcome.ok) {
    status.count = outcome.notes.length;
  } else {
    status.code = outcome.error.code;
  }

  return status;
}
