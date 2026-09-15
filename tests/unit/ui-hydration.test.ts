/**
 * Regression: the layer must hydrate the store from its adapter on enable().
 *
 * Found by a real browser run against examples/vanilla: after a reload the notes were still in
 * storage, but the bar, the markers and the panel showed nothing because the store starts empty
 * and nothing asked the adapter for the persisted set (NFR-8 "data survives reload", FR-4.2/4.3,
 * FR-4.8 counters).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryAdapter } from "../../src/adapters/memory";
import { createNote, type Note } from "../../src/core/model";
import { createStore } from "../../src/core/store";
import { createLayer, type LayerHandle } from "../../src/ui/layer";

const NOTE: Note = createNote({
  id: "n-persisted",
  type: "text",
  body: "Persisted before the reload",
  anchor: { hook: "persisted-target", route: "/fixture" },
  author: "reviewer",
  now: "2026-09-15T10:00:00.000Z",
});

function fixture(): void {
  document.body.innerHTML = `
    <main id="app">
      <h1 data-bluepencil="persisted-target">Persisted target</h1>
    </main>`;
}

/** Let the reload promise chain and the following render settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("layer hydration on enable", () => {
  let layer: LayerHandle | null = null;

  beforeEach(() => {
    layer?.disable();
    layer = null;
    fixture();
  });

  it("renders notes that were persisted by a previous session", async () => {
    const store = createStore({ adapter: createMemoryAdapter({ seed: [NOTE] }) });
    layer = createLayer({ store, document, mount: document.body, language: "en" });

    expect(document.querySelectorAll(".bp-marker").length).toBe(0);

    layer.enable();
    await settle();

    expect(store.notes().map((note) => note.id)).toContain("n-persisted");
    expect(document.querySelectorAll(".bp-marker").length).toBeGreaterThan(0);
    const bar = document.querySelector(".bp-bar");
    expect(bar?.textContent ?? "").toMatch(/1/);
  });

  it("keeps the hydrated set after a disable/enable cycle", async () => {
    const store = createStore({ adapter: createMemoryAdapter({ seed: [NOTE] }) });
    layer = createLayer({ store, document, mount: document.body, language: "en" });

    layer.enable();
    await settle();
    layer.disable();
    layer.enable();
    await settle();

    expect(store.notes()).toHaveLength(1);
    expect(document.querySelectorAll(".bp-marker").length).toBeGreaterThan(0);
  });
});
