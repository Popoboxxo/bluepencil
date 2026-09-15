/**
 * Unit tests of the public facade (`src/index.ts`): one filter implementation (FR-15.3), no
 * silently empty reads before the layer was ever enabled (FR-1.2 gate, NFR-2) and the `ready()`
 * promise a deterministic host awaits (NFR-8).
 *
 * The facade is exercised against the real store and the real memory adapter — the same wiring a
 * host gets from `init()`.
 */

import { describe, expect, it } from "vitest";

import { createMemoryAdapter } from "../../src/adapters/memory";
import { matchesFilter, type Adapter } from "../../src/core/adapter";
import { createNote, type Note } from "../../src/core/model";
import { init, type Blueprint } from "../../src/index";

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
