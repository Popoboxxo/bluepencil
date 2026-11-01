/**
 * Transport seam — the process-wide `fetch` a configured HTTP adapter falls back to.
 *
 * Why a registry and not an option: the extension's layer is built inside the page's own world by
 * `src/element/index.ts`, which constructs the HTTP adapter from the element's attributes alone. A
 * page cannot hand an instance to that code path without inventing a second configuration channel,
 * so the transport has to be reachable from the module the element already imports.
 *
 * Resolution order, evaluated **per request** so a late registration still takes effect:
 *
 *   `createHttpAdapter({ fetchImpl })` → the registered transport → `globalThis.fetch`
 *
 * Without a registration the adapter behaves exactly as it always has. That is the back-compat
 * guarantee for embeds, bookmarklets and Node users: this module is inert until someone registers.
 *
 * The registration is **process-/bundle-scoped, not instance-scoped**. It is deliberately *not*
 * undone by a blueprint's `disable()`/`destroy()`: the transport belongs to the host that registered
 * it, a second element on the same page (#FR-12.3) must keep it, and a later `enable()` must not
 * silently lose it (FR-12.1). The returned disposer belongs to whoever registered; calling it twice
 * is a no-op, so an idempotent teardown cannot unregister someone else's transport.
 *
 * Caveat for hosts that import two bundles (e.g. `bluepencil` and `bluepencil/adapters/http`): the
 * registry is module-local, so the registration must be imported from the same entry point that
 * builds the adapter. `src/index.ts` re-exports it for exactly that reason.
 */
import { BluepencilValidationError } from "../core/model";

/** A `fetch`-compatible function. The alias keeps the public surface readable. */
export type HttpTransport = typeof fetch;

let current: HttpTransport | null = null;

/** The registered transport, or `null` when none is set. Read by the HTTP adapter per request. */
export function currentHttpTransport(): HttpTransport | null {
  return current;
}

/**
 * Register the transport the HTTP adapter uses when it was not given a `fetchImpl`.
 *
 * Returns the disposer that restores the previous registration (`null` when there was none). It is
 * idempotent: a second call restores nothing and cannot clear a transport registered afterwards.
 */
export function registerHttpTransport(fetchImpl: HttpTransport): () => void {
  if (typeof fetchImpl !== "function") {
    throw new BluepencilValidationError([
      "registerHttpTransport needs a fetch-compatible function",
    ]);
  }
  const previous = current;
  current = fetchImpl;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    current = previous;
  };
}
