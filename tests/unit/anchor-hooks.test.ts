/**
 * Unit tests of the `anchor-hooks` attribute (FR-17 §2) — and of the fact that made it necessary to
 * check before promising anything:
 *
 * bluepencil already anchors on `data-testid` **by default** (`DEFAULT_HOOKS` is
 * `["data-bluepencil", "data-testid"]`), so a host that puts test hooks on its markup needs no
 * configuration at all. The attribute exists for hosts with *other* stable hooks, or for a different
 * priority — and the first version of this note claimed the opposite ("a tag cannot configure hooks"),
 * which was wrong until someone read `src/core/anchor.ts`.
 */

import { describe, expect, it } from "vitest";

import { hookValue } from "../../src/core/anchor";
import { ALL_ATTRIBUTES, readAnchorHooks } from "../../src/embed/attributes";
// Importing the element registers the tag as a side effect; the type is needed for the wiring test.
import { BluepencilNotesElement } from "../../src/element/index";

/** Minimal attribute source, like an element or the loader's script tag. */
function source(attributes: Record<string, string>): { getAttribute: (name: string) => string | null } {
  return { getAttribute: (name) => (name in attributes ? (attributes[name] ?? null) : null) };
}

describe("anchor-hooks attribute", () => {
  it("is part of the documented surface, so the loader mirrors it as data-anchor-hooks", () => {
    expect(ALL_ATTRIBUTES).toContain("anchor-hooks");
  });

  it("parses a comma-separated list, trimmed, dropping empty entries", () => {
    const parsed = readAnchorHooks(source({ "anchor-hooks": " data-rf-anchor , id ,, datakey " }));
    expect(parsed.hooks).toEqual(["data-rf-anchor", "id", "datakey"]);
    expect(parsed.issues).toEqual([]);
  });

  it("reports an empty list instead of quietly anchoring on nothing", () => {
    const parsed = readAnchorHooks(source({ "anchor-hooks": "  ,  " }));
    expect(parsed.hooks).toBeUndefined();
    expect(parsed.issues[0]).toContain("anchor-hooks is empty");
  });

  it("leaves the defaults alone when the attribute is absent", () => {
    expect(readAnchorHooks(source({})).hooks).toBeUndefined();
    expect(readAnchorHooks(source({})).issues).toEqual([]);
  });

  it("anchors on data-testid out of the box — a host with test hooks needs no configuration", () => {
    const element = document.createElement("div");
    element.setAttribute("data-testid", "req-table");
    expect(hookValue(element)).toBe("req-table");
  });

  it("lets the attribute change the priority — its actual purpose", () => {
    const element = document.createElement("div");
    element.setAttribute("id", "req-1");
    element.setAttribute("data-testid", "req-table");
    // Default order prefers the test hook; a host that wants the id first says so.
    expect(hookValue(element)).toBe("req-table");
    expect(hookValue(element, ["id", "data-testid"])).toBe("req-1");
    expect(hookValue(element, ["data-rf-view", "data-testid"])).toBe("req-table");
  });

  it("reaches the element: a broken value is reported like every other attribute", async () => {
    const element = document.createElement(BluepencilNotesElement.tagName) as BluepencilNotesElement;
    element.setAttribute("anchor-hooks", " , , ");
    document.body.append(element);
    await settle();

    expect(element.issues.join(" | ")).toContain("anchor-hooks is empty");
    element.remove();
  });
});

/** Let the element's start path and the following render settle (as in `ui-hydration.test.ts`). */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}
