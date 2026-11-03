/**
 * The teardown registry of the review layer (CQ-03 split, spec §3.13 L; FR-12.2, NFR-15).
 *
 * `disable()` used to be one long hand-ordered block. It is now an ordered list of `dispose()`
 * calls: the composition root registers the steps in the *reverse* of their execution order and
 * `run()` walks the list forward, so the order stays exactly the one the layer always had.
 *
 * A failing step is reported and must not stop the rest — an incomplete teardown after one
 * failing `close()` would leak everything after it.
 */

export interface LayerTeardown {
  /** Appends one step; steps run in registration order. */
  add(dispose: () => void): void;
  /** Runs every step once and empties the list; `onError` receives a thrown failure. */
  run(onError: (error: unknown) => void): void;
}

export function createLayerTeardown(): LayerTeardown {
  let steps: (() => void)[] = [];

  return {
    add(dispose: () => void): void {
      steps.push(dispose);
    },

    run(onError: (error: unknown) => void): void {
      const pending = steps;
      steps = [];
      for (const dispose of pending) {
        try {
          dispose();
        } catch (error) {
          onError(error);
        }
      }
    },
  };
}
