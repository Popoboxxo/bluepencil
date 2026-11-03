/**
 * Unit tests of the public facade (`src/index.ts`): one filter implementation (FR-15.3), no
 * silently empty reads before the layer was ever enabled (FR-1.2 gate, NFR-2) and the `ready()`
 * promise a deterministic host awaits (NFR-8).
 *
 * The facade is exercised against the real store and the real memory adapter — the same wiring a
 * host gets from `init()`.
 */

import { describe, expect, it } from "vitest";

import { createHttpAdapter } from "../../src/adapters/http";
import { createMemoryAdapter } from "../../src/adapters/memory";
import { currentHttpTransport, registerHttpTransport } from "../../src/adapters/transport";
import { matchesFilter, type Adapter } from "../../src/core/adapter";
import { createNote, type Note } from "../../src/core/model";
import { BlueprintDestroyedError, createBlueprint, init, type Blueprint } from "../../src/index";

const T0 = "2026-09-15T10:00:00.000Z";

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    ...createNote({
      id: "n-base",
      type: "text",
      body: "note body",
      anchor: { hook: "seed" },
      now: T0,
    }),
    ...overrides,
  };
}

/** Memory adapter that counts `list()` calls, so "one load path" is measurable (NFR-2). */
function countingAdapter(seed: Note[]): { adapter: Adapter; lists: () => number } {
  const inner = createMemoryAdapter({ seed });
  let lists = 0;
  const adapter: Adapter = {
    ...inner,
    name: "counting",
    list: (filter) => {
      lists += 1;
      return inner.list(filter);
    },
  };
  return { adapter, lists: () => lists };
}

/** Microtask flush — the suite never waits on the clock (NFR-2 discipline). */
async function flush(): Promise<void> {
  for (let index = 0; index < 16; index += 1) {
    await Promise.resolve();
  }
}

describe("createBlueprint — filter semantics (FR-15.3)", () => {
  it("uses the authoritative filter of core/adapter, not a local copy", async () => {
    const done = makeNote({ id: "n-done", status: "done" });
    const open = makeNote({ id: "n-open" });
    const blueprint = init({ adapter: createMemoryAdapter({ seed: [done, open] }), autoEnable: false });
    await blueprint.ready();

    // The reported defect: `includeDone` was applied *before* an explicit status filter, so an
    // explicit `{ status: "done", includeDone: false }` returned nothing.
    const doneOnly = blueprint.notes({ status: "done", includeDone: false });
    expect(doneOnly.map((note) => note.id)).toEqual(["n-done"]);
    expect(doneOnly.map((note) => note.id)).toEqual(
      blueprint.store
        .notes()
        .filter((note) => matchesFilter(note, { status: "done", includeDone: false }))
        .map((note) => note.id),
    );

    // `since` is compared as a timestamp, not as a raw string: 12:00+02:00 is 10:00Z, i.e. exactly
    // the note's `updatedAt`, which a raw string comparison got wrong.
    const since = "2026-09-15T12:00:00+02:00";
    expect(blueprint.notes({ since }).map((note) => note.id)).toEqual(["n-done", "n-open"]);

    // the narrowing rule of the bar/list/export is available through the same facade
    expect(blueprint.notes({ includeDone: false }).map((note) => note.id)).toEqual(["n-open"]);
    expect(blueprint.export({ includeDone: false })).not.toContain("n-done");

    await blueprint.destroy();
  });
});

describe("createBlueprint — loading contract (NFR-2, NFR-8)", () => {
  it("reads the adapter when the layer was never enabled instead of staying empty", async () => {
    const { adapter, lists } = countingAdapter([makeNote({ id: "n-persisted" })]);
    const blueprint = init({ adapter, autoEnable: false, enabled: () => false });

    expect(blueprint.isEnabled()).toBe(false);
    // The snapshot is synchronous (and still empty), but the read kicks the load off instead of
    // leaving the store empty forever.
    expect(blueprint.notes()).toEqual([]);
    await flush();
    expect(lists()).toBe(1);
    expect(blueprint.notes().map((note) => note.id)).toEqual(["n-persisted"]);

    // `ready()` awaits a reload of its own; two concurrent callers share that one read.
    await Promise.all([blueprint.ready(), blueprint.ready()]);
    expect(lists()).toBe(2);
    expect(blueprint.notes().map((note) => note.id)).toEqual(["n-persisted"]);

    const bundle = JSON.parse(blueprint.export({ format: "json" })) as { notes: Note[] };
    expect(bundle.notes.map((note) => note.id)).toEqual(["n-persisted"]);
    expect(blueprint.export()).toContain("n-persisted");

    await blueprint.destroy();
  });

  it("reuses the hydration of an enabled layer instead of starting a second read", async () => {
    const { adapter, lists } = countingAdapter([makeNote({ id: "n-persisted" })]);
    const blueprint: Blueprint = init({ adapter, autoEnable: false });

    blueprint.enable();
    expect(blueprint.isEnabled()).toBe(true);
    await flush();
    // the layer hydrated the store on enable() …
    expect(lists()).toBe(1);
    expect(blueprint.notes().map((note) => note.id)).toEqual(["n-persisted"]);

    // … and `notes()` / `ready()` did not add a second read
    expect(blueprint.notes().map((note) => note.id)).toEqual(["n-persisted"]);
    await blueprint.ready();
    expect(lists()).toBe(1);

    // a disable/enable cycle hydrates again (the documented lifecycle, FR-12.1/12.2)
    blueprint.disable();
    blueprint.enable();
    await blueprint.ready();
    expect(lists()).toBe(2);
    expect(blueprint.notes()).toHaveLength(1);

    await blueprint.destroy();
  });

  it("reports a failed load through onError instead of throwing at the host (NFR-14)", async () => {
    const errors: unknown[] = [];
    const failing: Adapter = {
      ...createMemoryAdapter(),
      name: "failing",
      list: async () => {
        throw new Error("EIO: read failed");
      },
    };
    const blueprint = init({
      adapter: failing,
      autoEnable: false,
      onError: (error) => errors.push(error),
    });

    await expect(blueprint.ready()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(blueprint.notes()).toEqual([]);

    await blueprint.destroy();
  });
});

/**
 * BP-09 / AC-K05 — the pinned variant, not either rejected one:
 *
 * - after `destroy()` every access to `blueprint.layer`/`blueprint.store` throws
 *   `BlueprintDestroyedError` (`code: "blueprint_destroyed"`) — the "inert handle" variant is
 *   deliberately *not* implemented, so a test that expected a callable no-op would fail here;
 * - `destroy()` is idempotent;
 * - `blueprint.layer.enable()` is routed through the facade's `enable()`, so the gate still owns
 *   the decision — the "gate bypass" variant is deliberately not implemented either.
 */
describe("createBlueprint — destroy is terminal (BP-09, AC-K05)", () => {
  it("throws BlueprintDestroyedError on layer/store/enable after destroy()", async () => {
    const blueprint = createBlueprint({ adapter: createMemoryAdapter(), autoEnable: false });
    await blueprint.destroy();

    const accesses: readonly [string, () => unknown][] = [
      ["layer", () => blueprint.layer],
      ["store", () => blueprint.store],
      ["enable", () => blueprint.enable()],
    ];
    for (const [name, access] of accesses) {
      let error: unknown;
      try {
        access();
      } catch (caught) {
        error = caught;
      }
      expect(error, name).toBeInstanceOf(BlueprintDestroyedError);
      expect((error as BlueprintDestroyedError).code, name).toBe("blueprint_destroyed");
    }

    // A destroyed instance can never be mounted again, so no second start is possible.
    expect(() => blueprint.enable()).toThrow(BlueprintDestroyedError);
  });

  it("handles repeated destroy() calls as one idempotent teardown", async () => {
    const blueprint = init({ adapter: createMemoryAdapter(), autoEnable: false });

    await expect(blueprint.destroy()).resolves.toBeUndefined();
    // Both a concurrent and a later call resolve without tearing down twice or throwing.
    await expect(Promise.all([blueprint.destroy(), blueprint.destroy()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    await expect(blueprint.destroy()).resolves.toBeUndefined();
  });

  it("routes layer.enable() through the facade gate instead of bypassing it", async () => {
    let allowed = false;
    const blueprint = init({
      adapter: createMemoryAdapter(),
      autoEnable: false,
      enabled: () => allowed,
    });

    // Closed gate: a bypass would have mounted the layer here (the rejected variant).
    blueprint.layer.enable();
    expect(blueprint.isEnabled()).toBe(false);
    expect(blueprint.layer.isEnabled()).toBe(false);

    // The same handle now goes through the facade's enable(): the gate decides.
    allowed = true;
    blueprint.layer.enable();
    expect(blueprint.isEnabled()).toBe(true);
    expect(blueprint.layer.isEnabled()).toBe(true);

    // Let the hydration started by enable() settle before teardown, so the test observes the
    // enable path only.
    await blueprint.ready();
    await blueprint.destroy();
  });
});

/**
 * #116: the transport seam is process-scoped, not instance-scoped.
 *
 * The extension registers one relay for the document and builds the element afterwards. If
 * `disable()` or `destroy()` unregistered it, a second element on the same page (FR-12.3) or a
 * re-`enable()` (FR-12.1) would silently fall back to the page's `fetch` — which is blocked by a
 * strict `connect-src`. The registration therefore belongs to whoever registered it.
 */
describe("createBlueprint — the HTTP transport seam (#116)", () => {
  it("keeps a registered transport across disable()/enable()/destroy()", async () => {
    const calls: string[] = [];
    const dispose = registerHttpTransport((async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ ok: true, notes: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);
    try {
      const blueprint = init({
        adapter: () => createHttpAdapter({ endpoint: "http://hub.test/api/v1/bluepencil" }),
        autoEnable: false,
      });

      blueprint.enable();
      await blueprint.ready();
      expect(calls.length).toBeGreaterThan(0);
      const before = calls.length;

      blueprint.disable();
      // Teardown must not unregister a transport it does not own.
      expect(currentHttpTransport()).not.toBeNull();

      blueprint.enable();
      await blueprint.ready();
      expect(calls.length).toBeGreaterThan(before);

      await blueprint.destroy();
      expect(currentHttpTransport()).not.toBeNull();
    } finally {
      dispose();
      expect(currentHttpTransport()).toBeNull();
    }
  });
});
