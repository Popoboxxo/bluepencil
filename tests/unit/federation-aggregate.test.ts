/**
 * Unit tests for the federation read aggregate (plan §6, FR-16.12, Rev. 4): source selection,
 * bounded fan-out, per-instance timeout, partial results, deterministic review order, id
 * qualification, limit/truncation and the all-fail contract (T17–T20, T25, T68, T74, T87).
 */

import { describe, expect, it } from "vitest";

import type { Environment, Note, NoteIntent, NoteStatus } from "../../src/core/model";
import { createNote } from "../../src/core/model";
import { compareForReview, reviewPriority } from "../../src/data/order";
import {
  DEFAULT_AGGREGATE_LIMIT,
  MAX_AGGREGATE_LIMIT,
  aggregateList,
  clampLimit,
  withTimeout,
  type AggregateOptions,
  type FederatedNote,
  type ReadSource,
} from "../../src/federation/aggregate";
import { FederationError } from "../../src/federation/errors";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:10:00.000Z";
const T2 = "2026-01-01T00:20:00.000Z";
const T3 = "2026-01-01T00:30:00.000Z";

interface NoteSpec {
  id: string;
  now?: string;
  intent?: NoteIntent;
  status?: NoteStatus;
  environment?: Environment;
}

function makeNote(spec: NoteSpec): Note {
  return createNote({
    id: spec.id,
    now: spec.now ?? T0,
    type: "text",
    body: `body of ${spec.id}`,
    intent: spec.intent,
    status: spec.status,
    environment: spec.environment,
    anchor: { hook: `#${spec.id}` },
  });
}

interface SourceSpec {
  app?: string;
  environment?: Environment;
  mode?: "read" | "write";
}

function sourceOf(id: string, notes: readonly Note[], spec: SourceSpec = {}): ReadSource {
  return {
    id,
    ...(spec.app === undefined ? {} : { app: spec.app }),
    ...(spec.environment === undefined ? {} : { environment: spec.environment }),
    ...(spec.mode === undefined ? {} : { mode: spec.mode }),
    list: async () => [...notes],
  };
}

function options(overrides: Partial<AggregateOptions> = {}): AggregateOptions {
  return { limit: 200, timeoutMs: 1000, includeSelf: true, ...overrides };
}

/** A promise that never settles — the source "hangs". */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {
    /* intentionally empty */
  });
}

describe("compareForReview", () => {
  it("orders by FR-4.6 priority class: needs_decision, feedback, open, done", () => {
    const done = makeNote({ id: "n-done", status: "done" });
    const open = makeNote({ id: "n-open", status: "open" });
    const feedback = makeNote({ id: "n-feedback", intent: "feedback" });
    const decision = makeNote({ id: "n-decision", status: "needs_decision" });

    expect([done, open, feedback, decision].map(reviewPriority)).toEqual([3, 2, 1, 0]);
    const sorted = [done, open, feedback, decision].sort(compareForReview);
    expect(sorted.map((note) => note.id)).toEqual(["n-decision", "n-feedback", "n-open", "n-done"]);
  });

  it("breaks priority ties by createdAt, then by id, using code-unit order", () => {
    const later = makeNote({ id: "n-a", status: "open", now: T2 });
    const earlier = makeNote({ id: "n-z", status: "open", now: T1 });
    const sameTimeB = makeNote({ id: "n-b", status: "open", now: T0 });
    const sameTimeA = makeNote({ id: "n-a", status: "open", now: T0 });

    expect([later, earlier].sort(compareForReview).map((note) => note.id)).toEqual(["n-z", "n-a"]);
    expect([sameTimeB, sameTimeA].sort(compareForReview).map((note) => note.id)).toEqual([
      "n-a",
      "n-b",
    ]);
  });
});

describe("federation.read_source_include_self (T74)", () => {
  const peerNotes = [makeNote({ id: "peer-1" })];
  const selfNotes = [makeNote({ id: "self-1" })];

  it("includes the self source and marks its status when includeSelf is true", async () => {
    const peer = sourceOf("peer", peerNotes, { app: "peer-app" });
    const self = sourceOf("self", selfNotes, { app: "own-app", mode: "write" });

    const result = await aggregateList([peer], self, {}, options({ includeSelf: true }));

    expect(result.notes.map((note) => note.id)).toEqual(["peer/peer-1", "self/self-1"]);
    const selfStatus = result.instances.find((entry) => entry.id === "self");
    expect(selfStatus).toMatchObject({ ok: true, count: 1, includeSelf: true, mode: "write" });
    expect(result.partial).toBe(false);
  });

  it("leaves self out when includeSelf is false", async () => {
    const result = await aggregateList(
      [sourceOf("peer", peerNotes)],
      sourceOf("self", selfNotes),
      {},
      options({ includeSelf: false }),
    );

    expect(result.notes.map((note) => note.id)).toEqual(["peer/peer-1"]);
    expect(result.instances.map((entry) => entry.id)).toEqual(["peer"]);
  });

  it("throws self_unavailable for instance=self when self is excluded or missing", async () => {
    await expect(
      aggregateList([], sourceOf("self", selfNotes), {}, options({ instance: "self", includeSelf: false })),
    ).rejects.toMatchObject({ code: "self_unavailable", instance: "self" });

    await expect(
      aggregateList([], undefined, {}, options({ instance: "self", includeSelf: true })),
    ).rejects.toMatchObject({ code: "self_unavailable", instance: "self" });
  });

  it("returns only the self source for instance=self", async () => {
    const result = await aggregateList(
      [sourceOf("peer", peerNotes)],
      sourceOf("self", selfNotes),
      {},
      options({ instance: "self", includeSelf: true }),
    );

    expect(result.notes.map((note) => note.id)).toEqual(["self/self-1"]);
    expect(result.instances.map((entry) => entry.id)).toEqual(["self"]);
  });

  it("never reads a registry entry named self twice when a self source exists", async () => {
    const result = await aggregateList(
      [sourceOf("self", selfNotes), sourceOf("peer", peerNotes)],
      sourceOf("self", selfNotes),
      {},
      options({ includeSelf: true }),
    );

    expect(result.notes.map((note) => note.id)).toEqual(["peer/peer-1", "self/self-1"]);
    expect(result.instances.filter((entry) => entry.id === "self")).toHaveLength(1);
  });

  it("returns an empty result when nothing is selected", async () => {
    const result = await aggregateList([], undefined, {}, options({ includeSelf: false }));

    expect(result).toEqual({
      notes: [],
      instances: [],
      partial: false,
      truncated: false,
      errors: [],
    });
  });
});

describe("aggregate.partial_timeout_envelope (T17)", () => {
  it("keeps the healthy notes and reports exactly one timeout error", async () => {
    const healthy = sourceOf("healthy", [makeNote({ id: "n-1" })]);
    const slow: ReadSource = {
      id: "slow",
      list: () => new Promise<Note[]>((resolve) => setTimeout(() => resolve([]), 100)),
    };

    const result = await aggregateList([healthy, slow], undefined, {}, options({ timeoutMs: 20 }));

    expect(result.partial).toBe(true);
    expect(result.notes.map((note) => note.id)).toEqual(["healthy/n-1"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ code: "timeout", instance: "slow" });
    expect(result.instances.find((entry) => entry.id === "slow")).toMatchObject({
      ok: false,
      code: "timeout",
    });
  });

  it("clears its timer and races a fast promise (withTimeout)", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000, "fast")).resolves.toBe("ok");
    await expect(withTimeout(never<string>(), 10, "hang")).rejects.toMatchObject({
      code: "timeout",
      instance: "hang",
    });
  });
});

/*
 * Wave-1 order is the global review order with an instance tiebreak. This deliberately differs
 * from plan §6's per-instance/registry-outer wording and is recorded as a deviation to be
 * reconciled in the plan, not silently changed.
 */
describe("aggregate.deterministic_order (T18)", () => {
  it("merges sources into the global FR-4.6 order, not registry order", async () => {
    const zeta = sourceOf("zeta", [makeNote({ id: "z-done", status: "done" })]);
    const alpha = sourceOf("alpha", [
      makeNote({ id: "a-open", status: "open", now: T1 }),
      makeNote({ id: "a-decision", status: "needs_decision", now: T2 }),
      makeNote({ id: "a-feedback", intent: "feedback", now: T3 }),
    ]);

    const first = await aggregateList([zeta, alpha], undefined, {}, options());
    const second = await aggregateList([zeta, alpha], undefined, {}, options());

    expect(first.notes.map((note) => note.id)).toEqual([
      "alpha/a-decision",
      "alpha/a-feedback",
      "alpha/a-open",
      "zeta/z-done",
    ]);
    expect(second.notes.map((note) => note.id)).toEqual(first.notes.map((note) => note.id));
  });

  it("uses the instance id as tie-break for otherwise identical notes", async () => {
    const note = makeNote({ id: "n-1", status: "open", now: T0 });
    const result = await aggregateList(
      [sourceOf("zeta", [note]), sourceOf("alpha", [note])],
      undefined,
      {},
      options(),
    );

    expect(result.notes.map((entry) => entry.id)).toEqual(["alpha/n-1", "zeta/n-1"]);
  });
});

describe("aggregate.limit_truncated (T19)", () => {
  const notes = Array.from({ length: 250 }, (_value, index) =>
    makeNote({ id: `n-${String(index).padStart(3, "0")}` }),
  );

  it("caps at limit and reports truncated", async () => {
    const result = await aggregateList(
      [sourceOf("peer", notes)],
      undefined,
      {},
      options({ limit: 200 }),
    );

    expect(result.notes).toHaveLength(200);
    expect(result.truncated).toBe(true);
    expect(result.instances[0]?.count).toBe(250);
  });

  it("does not report truncated when everything fits", async () => {
    const result = await aggregateList(
      [sourceOf("peer", notes)],
      undefined,
      {},
      options({ limit: 250 }),
    );

    expect(result.notes).toHaveLength(250);
    expect(result.truncated).toBe(false);
  });
});

describe("aggregate.qualifies_ids (T20)", () => {
  it("qualifies ids and leaves the source objects untouched", async () => {
    const notes = [makeNote({ id: "n-1" }), makeNote({ id: "n-2" })];
    const before = JSON.parse(JSON.stringify(notes)) as Note[];
    const peer = sourceOf("peer", notes, { app: "peer-app" });

    const result = await aggregateList([peer], undefined, {}, options());

    expect(result.notes.map((note) => note.id)).toEqual(["peer/n-1", "peer/n-2"]);
    expect(result.notes.every((note) => note.instance === "peer")).toBe(true);
    expect(result.notes.every((note) => note.app === "peer-app")).toBe(true);
    expect(notes).toEqual(before);
  });

  it("falls back to unknown when the source declares no app", async () => {
    const result = await aggregateList(
      [sourceOf("peer", [makeNote({ id: "n-1" })])],
      undefined,
      {},
      options(),
    );

    expect(result.notes[0]?.app).toBe("unknown");
    expect(result.instances[0]?.app).toBe("unknown");
  });

  it("prefers the source app over anything the notes carry (F-05)", async () => {
    const withApp = [makeNote({ id: "known-1" })];
    const withoutApp = [makeNote({ id: "unknown-1" })];

    const result = await aggregateList(
      [sourceOf("known", withApp, { app: "from-registry" }), sourceOf("other", withoutApp)],
      undefined,
      {},
      options(),
    );

    const known = result.notes.find((note) => note.id === "known/known-1");
    const unknown = result.notes.find((note) => note.id === "other/unknown-1");
    expect(known?.app).toBe("from-registry");
    expect(unknown?.app).toBe("unknown");

    expect(result.instances.find((entry) => entry.id === "known")?.app).toBe("from-registry");
    expect(result.instances.find((entry) => entry.id === "other")?.app).toBe("unknown");
  });

  it("reports invalid_id and skips a note without a string id instead of crashing (F-22)", async () => {
    const notes = [{}, makeNote({ id: "n-ok" })] as unknown as Note[];

    const result = await aggregateList([sourceOf("peer", notes)], undefined, {}, options());

    expect(result.notes.map((note) => note.id)).toEqual(["peer/n-ok"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ code: "invalid_id", instance: "peer" });
    expect(result.partial).toBe(false);
    expect(result.instances[0]).toMatchObject({ ok: true, count: 2 });
  });

  it("reports invalid_id for an unqualifiable note id and keeps the other notes", async () => {
    const notes = [makeNote({ id: "bad/id" }), makeNote({ id: "n-ok" })];

    const result = await aggregateList([sourceOf("peer", notes)], undefined, {}, options());

    expect(result.notes.map((note) => note.id)).toEqual(["peer/n-ok"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ code: "invalid_id", instance: "peer" });
    /* A note-level finding does not make the source itself a failure. */
    expect(result.partial).toBe(false);
    expect(result.instances[0]).toMatchObject({ ok: true, count: 2 });
  });
});

describe("contract.federation_read_parity (T25)", () => {
  it("differs from the per-source notes only in id, instance and app", async () => {
    const notes = [
      makeNote({ id: "n-1", status: "open" }),
      makeNote({ id: "n-2", intent: "feedback" }),
    ];
    const peer = sourceOf("peer", notes, { app: "peer-app" });

    const result = await aggregateList([peer], undefined, {}, options());

    expect(result.notes).toHaveLength(notes.length);
    for (const original of notes) {
      const federated = result.notes.find((note) => note.id === `peer/${original.id}`);
      expect(federated).toBeDefined();
      const { id: _id, instance: _instance, app: _app, ...rest } = federated as FederatedNote;
      expect({ ...rest, id: original.id }).toEqual(original);
    }
  });
});

describe("aggregate.all_fail_is_error (T68)", () => {
  it("does not throw when every source fails and reports one error each", async () => {
    const failing = (id: string): ReadSource => ({
      id,
      list: async () => {
        throw new Error(`${id} is down`);
      },
    });

    const result = await aggregateList([failing("alpha"), failing("beta")], undefined, {}, options());

    expect(result.notes).toEqual([]);
    expect(result.partial).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.every((error) => error.code === "instance_unreachable")).toBe(true);
    expect(result.instances.every((entry) => entry.ok === false)).toBe(true);
  });

  it("never leaks a raw source error message or cause (F-15)", async () => {
    const leaky: ReadSource = {
      id: "leaky",
      list: async () => {
        throw new Error("token=supersecret");
      },
    };

    const result = await aggregateList([leaky], undefined, {}, options());

    expect(result.errors).toHaveLength(1);
    const error = result.errors[0] as FederationError;
    expect(error.message).not.toContain("supersecret");
    expect(error.message).toBe("leaky: request failed");
    expect(error.cause).toBeUndefined();
  });

  it("wraps a non-array answer as invalid_response", async () => {
    const broken = {
      id: "broken",
      list: async () => ({ notes: [] }) as unknown as Note[],
    } as ReadSource;

    const result = await aggregateList([broken], undefined, {}, options());

    expect(result.notes).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ code: "invalid_response", instance: "broken" });
  });
});

describe("aggregate.defaults_timeout_limit_clamp (T87)", () => {
  it("clamps the limit and falls back on missing values", () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_AGGREGATE_LIMIT);
    expect(clampLimit(Number.NaN)).toBe(DEFAULT_AGGREGATE_LIMIT);
    expect(clampLimit(0)).toBe(DEFAULT_AGGREGATE_LIMIT);
    expect(clampLimit(-5)).toBe(DEFAULT_AGGREGATE_LIMIT);
    expect(clampLimit(250.9)).toBe(250);
    expect(clampLimit(5000)).toBe(MAX_AGGREGATE_LIMIT);
    expect(MAX_AGGREGATE_LIMIT).toBe(1000);
  });

  it("applies the per-instance timeout from options", async () => {
    const slow: ReadSource = {
      id: "slow",
      list: () => new Promise<Note[]>((resolve) => setTimeout(() => resolve([]), 200)),
    };

    const result = await aggregateList([slow], undefined, {}, options({ timeoutMs: 50 }));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe("timeout");
  });

  it("caps a 5000 limit at 1000 even with more notes available", async () => {
    const many = Array.from({ length: 1001 }, (_value, index) =>
      makeNote({ id: `n-${String(index).padStart(4, "0")}` }),
    );

    const result = await aggregateList(
      [sourceOf("peer", many)],
      undefined,
      {},
      options({ limit: 5000 }),
    );

    expect(result.notes).toHaveLength(1000);
    expect(result.truncated).toBe(true);
  });
});

describe("aggregate.selection_errors", () => {
  it("throws unknown_instance for an id that is not in the registry", async () => {
    await expect(
      aggregateList([sourceOf("peer", [])], undefined, {}, options({ instance: "ghost" })),
    ).rejects.toBeInstanceOf(FederationError);

    await expect(
      aggregateList([sourceOf("peer", [])], undefined, {}, options({ instance: "ghost" })),
    ).rejects.toMatchObject({ code: "unknown_instance", instance: "ghost" });
  });

  it('selects every source for instance "*"', async () => {
    const result = await aggregateList(
      [sourceOf("alpha", [makeNote({ id: "a-1" })]), sourceOf("beta", [])],
      undefined,
      {},
      options({ instance: "*", includeSelf: false }),
    );

    expect(result.instances.map((entry) => entry.id)).toEqual(["alpha", "beta"]);
    expect(result.notes.map((note) => note.id)).toEqual(["alpha/a-1"]);
  });

  it("selects exactly one source by id", async () => {
    const result = await aggregateList(
      [sourceOf("alpha", [makeNote({ id: "a-1" })]), sourceOf("beta", [makeNote({ id: "b-1" })])],
      undefined,
      {},
      options({ instance: "beta", includeSelf: false }),
    );

    expect(result.notes.map((note) => note.id)).toEqual(["beta/b-1"]);
    expect(result.instances.map((entry) => entry.id)).toEqual(["beta"]);
  });
});
