/**
 * Unit tests for `src/core/capture.ts` — curated context capture and degraded environments
 * (FR-1.4, FR-1.5, FR-13.5).
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  STYLE_SUBSET,
  captureContext,
  detectScheme,
  selectionQuote,
} from "../../src/core/capture";
import { BluepencilValidationError } from "../../src/core/model";

interface WindowStub {
  matchMedia?: (query: string) => { matches: boolean };
  innerWidth?: number;
  innerHeight?: number;
  getComputedStyle?: Window["getComputedStyle"];
  getSelection?: () => Selection | null;
  document?: Document;
}

function asWindow(stub: WindowStub): Window {
  return stub as unknown as Window;
}

/** Element-like object without any layout/style APIs — stands in for a stripped-down host. */
function bareElement(): Element {
  return { tagName: "DIV", getAttribute: () => null } as unknown as Element;
}

beforeEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

describe("STYLE_SUBSET", () => {
  it("is a frozen, curated list covering the contract's properties", () => {
    expect(Object.isFrozen(STYLE_SUBSET)).toBe(true);
    for (const property of [
      "display",
      "font-family",
      "font-size",
      "font-weight",
      "line-height",
      "color",
      "background-color",
      "margin-top",
      "padding-top",
      "border-top-width",
      "border-radius",
      "gap",
    ]) {
      expect(STYLE_SUBSET).toContain(property);
    }
    expect(STYLE_SUBSET).not.toContain("all");
  });
});

describe("captureContext", () => {
  it("captures tag, classes, the curated style subset, box, scheme and viewport", () => {
    document.body.innerHTML = `<div class="card one two"><span>x</span></div>`;
    const el = document.querySelector<HTMLElement>(".card") as HTMLElement;
    const context = captureContext(el, { buildRef: "build-42" });

    expect(context.tag).toBe("div");
    expect(context.classes).toEqual(["card", "one", "two"]);
    expect(Object.keys(context.styles).sort()).toEqual([...STYLE_SUBSET].sort());
    expect(context.styles.display).toBe("block");
    expect(context.scheme).toBe("light");
    expect(context.viewport).toEqual({ w: window.innerWidth, h: window.innerHeight });
    expect(context.buildRef).toBe("build-42");
  });

  it("returns a zero box in an environment without layout (jsdom)", () => {
    document.body.innerHTML = `<div class="card">x</div>`;
    const context = captureContext(document.querySelector(".card") as Element);
    expect(context.box).toEqual({ w: 0, h: 0, x: 0, y: 0 });
    expect(context.buildRef).toBeUndefined();
  });

  it("reads scheme and viewport from an injected view", () => {
    document.body.innerHTML = `<div class="card">x</div>`;
    const context = captureContext(document.querySelector(".card") as Element, {
      view: asWindow({ innerWidth: 1280, innerHeight: 720, matchMedia: () => ({ matches: true }) }),
    });
    expect(context.scheme).toBe("dark");
    expect(context.viewport).toEqual({ w: 1280, h: 720 });
  });

  it("degrades instead of throwing when element APIs are missing", () => {
    const context = captureContext(bareElement());
    expect(context.tag).toBe("div");
    expect(context.classes).toEqual([]);
    expect(context.box).toEqual({ w: 0, h: 0, x: 0, y: 0 });
    expect(context.styles["font-size"]).toBe("");
    expect(Object.keys(context.styles)).toHaveLength(STYLE_SUBSET.length);
  });

  it("degrades to zero viewport values when the view is incomplete", () => {
    document.body.innerHTML = `<div class="card">x</div>`;
    const context = captureContext(document.querySelector(".card") as Element, {
      view: asWindow({}),
    });
    expect(context.viewport).toEqual({ w: 0, h: 0 });
    expect(Number.isFinite(context.box.w)).toBe(true);
  });

  it("rejects input that is not element-like", () => {
    expect(() => captureContext(null as unknown as Element)).toThrow(BluepencilValidationError);
    expect(() => captureContext(42 as unknown as Element)).toThrow(BluepencilValidationError);
  });
});

describe("detectScheme", () => {
  it("defaults to light when prefers-color-scheme is unavailable", () => {
    expect(detectScheme()).toBe("light");
    expect(detectScheme(asWindow({}))).toBe("light");
  });

  it("reads prefers-color-scheme when the API exists", () => {
    expect(detectScheme(asWindow({ matchMedia: () => ({ matches: true }) }))).toBe("dark");
    expect(detectScheme(asWindow({ matchMedia: () => ({ matches: false }) }))).toBe("light");
  });

  it("degrades to light when matchMedia throws", () => {
    const throwing = asWindow({
      matchMedia: () => {
        throw new Error("blocked by the host");
      },
    });
    expect(detectScheme(throwing)).toBe("light");
  });
});

describe("selectionQuote", () => {
  it("stores the current selection verbatim (FR-1.5)", () => {
    document.body.innerHTML = `<p id="p">Save <b>the changes</b> now</p>`;
    const bold = document.querySelector("b") as Element;
    const range = document.createRange();
    range.selectNodeContents(bold);

    const selection = window.getSelection();
    expect(selection).not.toBeNull();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(selectionQuote()).toBe("the changes");
    expect(selectionQuote(window)).toBe("the changes");
  });

  it("trims surrounding whitespace and returns undefined for an empty selection", () => {
    document.body.innerHTML = `<p id="p">   padded   </p>`;
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("#p") as Element);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(selectionQuote(window)).toBe("padded");

    selection?.removeAllRanges();
    expect(selectionQuote(window)).toBeUndefined();
  });

  it("returns undefined when the selection API is missing or throwing", () => {
    expect(selectionQuote(asWindow({}))).toBeUndefined();
    expect(selectionQuote()).toBeUndefined();
    expect(
      selectionQuote(
        asWindow({
          getSelection: () => {
            throw new Error("blocked by the host");
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("reads the text through the range as a fallback", () => {
    const stub = asWindow({
      getSelection: () =>
        ({
          rangeCount: 1,
          getRangeAt: () => ({ toString: () => " chosen " }),
        }) as unknown as Selection,
    });
    expect(selectionQuote(stub)).toBe("chosen");
  });
});
