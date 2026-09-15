/**
 * Unit tests for `src/core/anchor.ts` — anchoring and shadow-aware path resolution (FR-2.x, §6b).
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  composePath,
  cssPath,
  deriveAnchor,
  describeElement,
  findQuote,
  hookValue,
  resolveAnchor,
  resolveAnchorDetailed,
  resolvePath,
} from "../../src/core/anchor";
import { BluepencilValidationError, type Anchor } from "../../src/core/model";

class BpCardElement extends HTMLElement {
  build(mode: ShadowRootMode = "open"): ShadowRoot {
    const root = this.attachShadow({ mode });
    root.innerHTML = `<div class="value"><span class="unit" data-testid="unit">42</span></div>`;
    return root;
  }
}

if (!customElements.get("bp-card")) customElements.define("bp-card", BpCardElement);

function mount(html: string): void {
  document.body.innerHTML = html;
}

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`fixture element #${id} missing`);
  return el;
}

function first<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`fixture element ${selector} missing`);
  return el;
}

beforeEach(() => {
  mount("");
});

describe("hookValue", () => {
  it("returns the first hook value in priority order", () => {
    mount(`<div id="only" data-testid="single"></div><div id="both" data-bluepencil="primary" data-testid="secondary"></div>`);
    expect(hookValue(byId("only"))).toBe("single");
    expect(hookValue(byId("both"))).toBe("primary");
  });

  it("skips empty attributes and missing hooks", () => {
    mount(`<div id="empty" data-bluepencil="" data-testid="real"></div>`);
    expect(hookValue(byId("empty"))).toBe("real");
    expect(hookValue(document.createElement("span"))).toBeUndefined();
    expect(hookValue(null as unknown as Element)).toBeUndefined();
  });

  it("honours a custom hook list", () => {
    mount(`<div id="custom" data-bp="hero" data-testid="ignored"></div>`);
    expect(hookValue(byId("custom"), ["data-bp"])).toBe("hero");
    expect(hookValue(byId("custom"), ["data-absent"])).toBeUndefined();
  });
});

describe("cssPath / composePath", () => {
  it("falls back to nth-of-type segments when no hook is present", () => {
    mount(`<div><span>a</span><span>b</span></div>`);
    const spans = document.querySelectorAll("span");
    expect(cssPath(spans[1] as Element)).toBe(
      "html > body:nth-of-type(1) > div:nth-of-type(1) > span:nth-of-type(2)",
    );
  });

  it("anchors the path on an ancestor hook and stays structural below it", () => {
    mount(`<ul data-testid="list"><li>one</li><li>two</li><li>three</li></ul>`);
    const third = document.querySelectorAll("li")[2] as Element;
    expect(cssPath(third)).toBe('ul[data-testid="list"] > li:nth-of-type(3)');
  });

  it("never describes the annotated element by its own hook (FR-2.1 fallback)", () => {
    mount(`<div id="wrap"><span data-testid="leaf">x</span></div>`);
    const span = first("span");
    expect(cssPath(span)).not.toContain('data-testid="leaf"');
    expect(cssPath(span)).toBe(
      "html > body:nth-of-type(1) > div:nth-of-type(1) > span:nth-of-type(1)",
    );
  });

  it("respects custom hooks and is tolerant about invalid input", () => {
    mount(`<section data-bp="hero"><span>x</span></section>`);
    expect(cssPath(first("span"), ["data-bp"])).toBe(
      'section[data-bp="hero"] > span:nth-of-type(1)',
    );
    expect(cssPath(null as unknown as Element)).toBe("");
    expect(composePath(null as unknown as Element)).toBe("");
  });

  it("composes shadow boundaries as ' >> ' and keeps the host hook", () => {
    mount(`<bp-card data-testid="card"></bp-card>`);
    const card = first<BpCardElement>("bp-card");
    const root = card.build();
    const unit = root.querySelector(".unit") as Element;

    const path = composePath(unit);
    const segments = path.split(" >> ");
    expect(segments).toHaveLength(2);
    expect(segments[0]).toBe('bp-card[data-testid="card"]');
    expect(segments[1]).toBe("div:nth-of-type(1) > span:nth-of-type(1)");
    expect(cssPath(unit)).toBe(path);
  });
});

describe("deriveAnchor", () => {
  it("stores hook, selector, quote and route", () => {
    mount(`<main><ul data-testid="list"><li>one</li><li data-testid="item-2">two</li><li>three</li></ul></main>`);
    const li = first<HTMLElement>('[data-testid="item-2"]');
    const anchor = deriveAnchor(li, { route: "/orders", quote: "  two  " });

    expect(anchor.hook).toBe("item-2");
    expect(anchor.selector).toBe('ul[data-testid="list"] > li:nth-of-type(2)');
    expect(anchor.quote).toBe("two");
    expect(anchor.route).toBe("/orders");
    expect(anchor.degraded).toBeUndefined();
    expect(anchor.orphaned).toBeUndefined();
    expect(anchor.selector && resolvePath(anchor.selector)).toBe(li);
  });

  it("omits the optional fields that are not available", () => {
    mount(`<div><span>x</span></div>`);
    const anchor = deriveAnchor(first("span"));
    expect(anchor.hook).toBeUndefined();
    expect(anchor.quote).toBeUndefined();
    expect(anchor.route).toBeUndefined();
    expect(anchor.degraded).toBeUndefined();
    expect(anchor.selector).toBe(
      "html > body:nth-of-type(1) > div:nth-of-type(1) > span:nth-of-type(1)",
    );
  });

  it("rejects anything that is not an element-like input (FR-2.3)", () => {
    expect(() => deriveAnchor(null as unknown as Element)).toThrow(BluepencilValidationError);
    expect(() => deriveAnchor({} as unknown as Element)).toThrow(BluepencilValidationError);
  });
});

describe("resolveAnchor", () => {
  it("resolves through the hook", () => {
    mount(`<button data-testid="save">Save</button>`);
    const button = first("button");
    expect(resolveAnchor({ hook: "save" })).toBe(button);
  });

  it("falls back to the selector after the hook was removed (FR-2.1)", () => {
    mount(`<ul data-testid="list"><li>one</li><li data-testid="item-2">two</li></ul>`);
    const li = first<HTMLElement>('[data-testid="item-2"]');
    const anchor = deriveAnchor(li);

    li.removeAttribute("data-testid");
    expect(resolveAnchor(anchor)).toBe(li);
    expect(anchor.degraded).toBeUndefined();
  });

  it("falls back to the quote when hook and path are gone (FR-2.1)", () => {
    mount(`<main><p>Save changes</p></main>`);
    const paragraph = first("p");
    const anchor = deriveAnchor(paragraph, { quote: "Save changes" });

    const stale = { ...anchor, hook: "removed-on-rerender", selector: "div#gone" };
    expect(resolveAnchor(stale)).toBe(paragraph);
  });

  it("keeps a note resolvable when hooks survive a re-render (FR-2.6)", () => {
    mount(`<ul data-testid="list"><li data-testid="item-1">one</li><li data-testid="item-2">two</li></ul>`);
    const target = first<HTMLElement>('[data-testid="item-2"]');
    const anchor = deriveAnchor(target);
    expect(anchor.selector).toBe('ul[data-testid="list"] > li:nth-of-type(2)');

    first("ul").insertAdjacentHTML("afterbegin", `<li data-testid="item-0">zero</li>`);
    expect(resolveAnchor(anchor)).toBe(target);
  });

  it("returns null for an orphan and leaves the orphan mark to the caller (FR-2.4)", () => {
    mount(`<div id="kept">only element</div>`);
    const anchor: Anchor = { hook: "vanished", selector: "div#gone", quote: "text that is not there" };

    expect(resolveAnchor(anchor)).toBeNull();
    expect(anchor.orphaned).toBeUndefined();
    anchor.orphaned = true; // the caller marks it, the note is never dropped
    expect(anchor.orphaned).toBe(true);
  });

  it("returns null for an empty or invalid anchor", () => {
    expect(resolveAnchor({})).toBeNull();
    expect(resolveAnchor(null as unknown as { hook?: string })).toBeNull();
  });

  it("resolves hooks and paths inside an open shadow root (§6b)", () => {
    mount(`<bp-card data-testid="card"></bp-card>`);
    const card = first<BpCardElement>("bp-card");
    const root = card.build();
    const unit = root.querySelector(".unit") as Element;

    expect(resolveAnchor({ hook: "unit" })).toBe(unit);
    expect(resolveAnchor({ hook: "unit" }, { root })).toBe(unit);

    const anchor = deriveAnchor(unit);
    expect(anchor.selector).toContain(" >> ");
    expect(resolveAnchor(anchor)).toBe(unit);
    expect(resolveAnchor({ selector: anchor.selector })).toBe(unit);
  });

  it("flags a closed shadow boundary as degraded and still reports the note as orphaned (§6b)", () => {
    mount(`<div id="host"></div>`);
    const host = byId("host");
    const closed = host.attachShadow({ mode: "closed" });
    closed.innerHTML = `<span class="secret">hidden</span>`;
    const secret = closed.querySelector(".secret") as Element;

    const anchor = deriveAnchor(secret);
    const innerSegment = anchor.selector?.split(" >> ")[1];
    expect(anchor.selector).toContain(" >> ");
    expect(anchor.degraded).toBe(innerSegment);
    expect(anchor.degraded).toBe("span:nth-of-type(1)");

    expect(resolveAnchor(anchor)).toBeNull();
    expect(anchor.degraded).toBe("span:nth-of-type(1)");
    anchor.orphaned = true;
    expect(anchor.orphaned).toBe(true);
  });

  it("never mutates the anchor it is given (no hidden side effect on a note)", () => {
    mount(`<div id="host"></div>`);
    const closed = byId("host").attachShadow({ mode: "closed" });
    closed.innerHTML = `<span class="secret">hidden</span>`;

    // The stored anchor of a note is the caller's data: resolution must not write into it.
    const anchor: Anchor = { selector: "div#host:nth-of-type(1) >> span:nth-of-type(1)" };
    const before = JSON.stringify(anchor);

    expect(resolveAnchor(anchor)).toBeNull();
    expect(resolveAnchorDetailed(anchor)).toEqual({
      element: null,
      degraded: "span:nth-of-type(1)",
    });
    expect(JSON.stringify(anchor)).toBe(before);
    expect(anchor.degraded).toBeUndefined();
    expect(anchor.orphaned).toBeUndefined();
  });

  it("reports the degradation of a failed boundary through resolveAnchorDetailed (§6b)", () => {
    mount(`<main id="host"><p>Save changes</p></main>`);
    const paragraph = first("p");
    const closed = byId("host").attachShadow({ mode: "closed" });
    closed.innerHTML = `<span>closed content</span>`;

    // hook and quote resolve the element, while the (blocked) path still reports the degradation
    const resolved = resolveAnchorDetailed({
      selector: "main#host:nth-of-type(1) >> span:nth-of-type(1)",
      quote: "Save changes",
    });
    expect(resolved.element).toBe(paragraph);
    expect(resolved.degraded).toBe("span:nth-of-type(1)");

    expect(resolveAnchorDetailed({ hook: "unit" })).toEqual({ element: null });
    expect(resolveAnchorDetailed(null as unknown as Anchor)).toEqual({ element: null });
  });
});

describe("resolvePath", () => {
  it("resolves a composed path segment by segment", () => {
    mount(`<bp-card data-testid="card"></bp-card>`);
    const card = first<BpCardElement>("bp-card");
    const root = card.build();
    const unit = root.querySelector(".unit") as Element;
    expect(resolvePath(composePath(unit))).toBe(unit);
  });

  it("accepts an explicit search root", () => {
    mount(`<div id="scope"><span>x</span></div>`);
    const scope = byId("scope");
    expect(resolvePath("span:nth-of-type(1)", scope)).toBe(scope.querySelector("span"));
  });

  it("degrades to null for unknown or malformed selectors", () => {
    mount(`<div><span>x</span></div>`);
    expect(resolvePath("div#missing")).toBeNull();
    expect(resolvePath("div >> ")).toBeNull();
    expect(resolvePath("!!!not a selector!!!")).toBeNull();
    expect(resolvePath("")).toBeNull();
  });
});

describe("findQuote", () => {
  it("returns the deepest element containing the quote", () => {
    mount(`<div id="outer">alpha <b>beta</b> gamma</div>`);
    expect(findQuote("beta")).toBe(first("b"));
    expect(findQuote("alpha")).toBe(byId("outer"));
  });

  it("normalises whitespace before matching and ignores empty quotes", () => {
    mount(`<p id="p">Save   the   changes</p>`);
    expect(findQuote("Save the changes")).toBe(byId("p"));
    expect(findQuote("   ")).toBeNull();
    expect(findQuote("not present")).toBeNull();
  });

  it("looks through open shadow roots", () => {
    mount(`<bp-card></bp-card>`);
    const root = first<BpCardElement>("bp-card").build();
    const unit = root.querySelector(".unit") as Element;
    expect(findQuote("42")).toBe(unit);
  });
});

describe("describeElement", () => {
  it("labels an element by hook, id or class plus its text", () => {
    mount(`<button class="btn primary" data-testid="save" aria-label="Save changes"></button>`);
    expect(describeElement(first("button"))).toBe('button[data-testid="save"] "Save changes"');

    mount(`<p class="lead">Hello   world</p>`);
    expect(describeElement(first("p"))).toBe('p.lead "Hello world"');

    mount(`<div id="main">content</div>`);
    expect(describeElement(byId("main"))).toBe('div#main "content"');
  });

  it("truncates long labels and tolerates invalid input", () => {
    mount(`<p>${"x".repeat(60)}</p>`);
    const label = describeElement(first("p"));
    expect(label.startsWith('p "')).toBe(true);
    expect(label.endsWith('…"')).toBe(true);
    expect(label.length).toBeLessThan(60);
    expect(describeElement(null as unknown as Element)).toBe("");
  });
});
