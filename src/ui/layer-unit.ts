/**
 * Shared contract of the internal layer units (CQ-03 split, spec §3.13 L).
 *
 * Each unit owns exactly the resources it creates and releases them in `dispose()`. The
 * composition root (`src/ui/layer.ts`) creates the units with explicit dependencies and runs their
 * `dispose()` in a fixed order on `disable()` (FR-12.2, NFR-15). Units never import `layer.ts`, so
 * they stay testable on their own and the import graph stays acyclic.
 */
export interface LayerUnit {
  /** Idempotent: releases only what this unit created. Never throws (NFR-14). */
  dispose(): void;
}
