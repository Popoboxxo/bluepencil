/**
 * Unit tests of the custom-element registration guard (issue #32).
 *
 * The guard is not a defensive nicety: `defineBluepencilElement()` runs at module top level, so a
 * throw inside it aborts the evaluation of the whole element bundle. A consumer that only imports
 * the module for a side effect then gets a `TypeError` instead of a working import — and, because
 * the element never registers, it cannot fall back to anything.
 *
 * The case that broke it: an environment exposing `customElements` as `null`. `typeof null` is
 * `"object"`, so a `typeof === "undefined"` guard passes and `get()` throws. Chromium's isolated
 * content-script world is exactly such an environment, but a host that shadows the global hits
 * it too — so this is a product bug, not an extension-only one.
 *
 * A note on the fixture, because it constrains what these tests can do: a custom-elements registry
 * binds one constructor per tag *and* one tag per constructor. Registering
 * `BluepencilNotesElement` under a second name throws `NotSupportedError` — verified against jsdom,
 * matching the browser. So the positive path is only reachable through the module's own tag, and
 * the idempotency case is what really exercises the guard's early return.
 */

import { afterEach, describe, expect, it } from "vitest";

import { BluepencilNotesElement, defineBluepencilElement } from "../../src/element/index";

type MutableGlobal = { customElements?: CustomElementRegistry | null };

const mutable = globalThis as unknown as MutableGlobal;
const original = mutable.customElements;

/**
 * jsdom exposes `customElements` as a getter without a setter, so a plain assignment throws
 * ("Cannot set property customElements of [object Window] which has only a getter"). A descriptor is
 * the only way to reach the two states this suite is about: a registry that is null, and none at all.
 */
function setRegistry(value: CustomElementRegistry | null | undefined): void {
  Object.defineProperty(globalThis, "customElements", { value, configurable: true, writable: true });
}

afterEach(() => {
  setRegistry(original);
});

describe("defineBluepencilElement — a missing registry is a no-op, not a throw", () => {
  it("does not throw when customElements is null (the Chromium isolated world)", () => {
    setRegistry(null);
    expect(() => defineBluepencilElement()).not.toThrow();
  });

  it("does not throw when customElements is absent entirely", () => {
    setRegistry(undefined);
    // The descriptor above is configurable, so this really removes the property — jsdom's own
    // `customElements` is a getter and could not be deleted, which is what made this case a no-op.
    delete mutable.customElements;
    expect(() => defineBluepencilElement()).not.toThrow();
  });

  it("registered the element on import in this environment", () => {
    // This is what makes the two cases above meaningful: a working registry exists here, so a
    // passing no-op can only come from the guard, not from the element being unavailable.
    expect(customElements.get(BluepencilNotesElement.tagName)).toBe(BluepencilNotesElement);
  });

  it("stays idempotent — calling again with the tag present does not reach define()", () => {
    // The early return is the behaviour under test: a registry throws on a second `define()` of
    // the same name, so a guard that failed to return would surface as NotSupportedError.
    expect(customElements.get(BluepencilNotesElement.tagName)).toBeTruthy();
    expect(() => defineBluepencilElement()).not.toThrow();
    expect(customElements.get(BluepencilNotesElement.tagName)).toBe(BluepencilNotesElement);
  });
});
