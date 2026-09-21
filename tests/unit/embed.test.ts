/**
 * Unit tests of the embed vocabulary and the attach surface of the element (FR-17).
 *
 * Covers: `src/embed/attributes.ts` (attribute → configuration mapping, issue reporting),
 * `src/embed/version.ts` (manifest, version resolution, integrity) and the new element attributes
 * (`endpoint`, `headers`, `token*`, `route*`, `gate`, `theme`, `destroy()`).
 *
 * Everything runs against the real modules and a real jsdom document — no stubs of other agents'
 * modules. The HTTP store is exercised through a stubbed `fetch`, so the wiring from an HTML
 * attribute to an outgoing request is proven without a server.
 */

import vm from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ALL_ATTRIBUTES,
  collectDataAttributes,
  parseLoaderOptions,
  readAnnotateSelectors,
  readAppInfo,
  readAttribute,
  readCanAnnotate,
  readDock,
  readEnvironment,
  readGate,
  readHeaders,
  readKeymap,
  readJsonAttribute,
  readRoute,
  readStore,
  readTheme,
  resolveGlobalPath,
  type AttributeSource,
} from "../../src/embed/attributes";
import {
  absoluteUrl,
  parseManifest,
  parseManifestText,
  resolveElementUrl,
  shouldReload,
  sha256Hex,
  verifyIntegrity,
} from "../../src/embed/version";
import { BluepencilNotesElement } from "../../src/element/index";

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function source(attributes: Record<string, string>): AttributeSource {
  return {
    getAttribute: (name: string) => attributes[name] ?? null,
  };
}

function noGlobals(): unknown {
  return undefined;
}

function elementWith(attributes: Record<string, string>): BluepencilNotesElement {
  const element = document.createElement("bluepencil-notes") as BluepencilNotesElement;
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  return element;
}

function mount(attributes: Record<string, string>): BluepencilNotesElement {
  const element = elementWith(attributes);
  document.body.append(element);
  return element;
}

afterEach(() => {
  for (const element of [...document.querySelectorAll("bluepencil-notes")]) {
    (element as BluepencilNotesElement).destroy();
    element.remove();
  }
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */
/* attributes.ts                                                               */
/* -------------------------------------------------------------------------- */

describe("embed attributes — parsing", () => {
  it("treats an empty attribute like an unset one", () => {
    expect(readAttribute(source({ endpoint: "" }), "endpoint")).toBeUndefined();
    expect(readAttribute(source({ endpoint: "/api" }), "endpoint")).toBe("/api");
    expect(readAttribute(source({}), "endpoint")).toBeUndefined();
  });

  it("reports malformed JSON instead of silently dropping it", () => {
    expect(readJsonAttribute(source({ headers: '{"a":"b"}' }), "headers").value).toEqual({ a: "b" });
    const broken = readJsonAttribute(source({ headers: "{oops" }), "headers");
    expect(broken.value).toBeUndefined();
    expect(broken.issue).toContain("not valid JSON");
    const array = readJsonAttribute(source({ headers: "[1,2]" }), "headers");
    expect(array.issue).toContain("must be a JSON object");
  });

  it("resolves dotted global paths and rejects everything unreachable", () => {
    const scope = { myApp: { flags: { review: true }, headers: () => ({ A: "1" }) } };
    expect(resolveGlobalPath(scope, "myApp.flags.review")).toBe(true);
    expect(resolveGlobalPath(scope, "window.myApp.flags")).toEqual({ review: true });
    expect(resolveGlobalPath(scope, "myApp.missing.deeper")).toBeUndefined();
    expect(resolveGlobalPath(scope, "")).toBeUndefined();
    expect(resolveGlobalPath(null, "a")).toBeUndefined();
  });
});

describe("embed attributes — headers, theme, store, environment", () => {
  it("merges static headers, the dynamic function and the token (token wins)", () => {
    const resolve = (path: string) =>
      path === "host.headers" ? () => ({ "X-Dynamic": "yes", "X-Workspace": "from-fn" }) : undefined;
    const result = readHeaders(
      source({
        headers: '{"X-Workspace":"from-json","X-Static":"1"}',
        "headers-from": "host.headers",
        token: "t0ken",
        "token-header": "X-Api-Key",
      }),
      resolve,
    );
    expect(result.issues).toEqual([]);
    expect(result.headers?.()).toEqual({
      "X-Workspace": "from-fn",
      "X-Static": "1",
      "X-Dynamic": "yes",
      "X-Api-Key": "t0ken",
    });
  });

  it("prefixes the token with token-scheme only when it is set", () => {
    expect(readHeaders(source({ token: "abc" }), noGlobals).headers?.()).toEqual({ Authorization: "abc" });
    expect(
      readHeaders(source({ token: "abc", "token-scheme": "Bearer" }), noGlobals).headers?.(),
    ).toEqual({ Authorization: "Bearer abc" });
  });

  it("reports an unresolvable headers-from and keeps the static headers working", () => {
    const result = readHeaders(source({ headers: '{"A":"1"}', "headers-from": "nope.gone" }), noGlobals);
    expect(result.issues).toEqual(['headers-from "nope.gone" does not resolve to a function']);
    expect(result.headers?.()).toEqual({ A: "1" });
  });

  it("has no header function when nothing is configured", () => {
    expect(readHeaders(source({}), noGlobals).headers).toBeUndefined();
  });

  it("reads theme tokens, letting the dedicated attributes win", () => {
    const result = readTheme(source({ theme: '{"accent":"#111","ink":"#222"}', "theme-accent": "#999" }));
    expect(result.issues).toEqual([]);
    expect(result.theme).toEqual({ accent: "#999", ink: "#222" });
  });

  it("maps endpoint to the http store and falls back to an adapter name", () => {
    expect(readStore(source({ endpoint: "/api/v1/bluepencil" }))).toEqual({ endpoint: "/api/v1/bluepencil" });
    expect(readStore(source({ adapter: "localStorage" }))).toEqual({ adapterName: "localStorage" });
    expect(readStore(source({ endpoint: "/x", adapter: "localStorage" }))).toEqual({
      endpoint: "/x",
      adapterName: "localStorage",
    });
  });

  it("validates environment, identity and show-done", () => {
    const good = readEnvironment(source({ environment: "live", identity: "anonymous", "show-done": "true" }));
    expect(good.issues).toEqual([]);
    expect(good.environment).toBe("live");
    expect(good.identity).toBe("anonymous");
    expect(good.showDone).toBe(true);

    const bad = readEnvironment(source({ environment: "prod", identity: "robot" }));
    expect(bad.environment).toBeUndefined();
    expect(bad.identity).toBeUndefined();
    expect(bad.issues).toHaveLength(2);
  });
});

describe("embed attributes — route and gate", () => {
  it('route="url" stores the location, route-from delegates to the host', () => {
    const url = readRoute(source({ route: "url" }), noGlobals, { pathname: "/a", search: "?b=1" });
    expect(url.getRoute?.()).toBe("/a?b=1");

    const host = readRoute(source({ "route-from": "router.current" }), () => () => "/spa/route", undefined);
    expect(host.getRoute?.()).toBe("/spa/route");
    expect(host.issues).toEqual([]);

    // The host function receives the annotated element, so it can answer for *that* note instead of
    // for whatever is on screen when the composer opens (FR-2.4). Measured on the AI-Extremismus
    // one-pager: a `nav a.is-active` hook lags a chapter behind, this one cannot.
    const perElement = readRoute(
      source({ "route-from": "router.forElement" }),
      () => (element?: Element) => (element ? element.getAttribute("data-chapter") : null) ?? "",
      undefined,
    );
    expect(perElement.getRoute?.({ getAttribute: () => "kapitel-05" } as unknown as Element)).toBe("kapitel-05");
    // A zero-parameter host keeps working: it simply ignores the argument it now receives.
    expect(perElement.getRoute?.()).toBe("");
  });

  it("reports an unknown route mode, a missing function and a missing location", () => {
    expect(readRoute(source({ route: "hash" }), noGlobals, { pathname: "/", search: "" }).issues[0]).toContain(
      'route must be "url"',
    );
    expect(readRoute(source({ route: "url" }), noGlobals, undefined).issues[0]).toContain("needs a location");
    expect(readRoute(source({ "route-from": "gone" }), noGlobals, undefined).issues[0]).toContain(
      "does not resolve to a function",
    );
  });

  it("reads the gate as a re-evaluated function and reports the other shapes", () => {
    let allowed = false;
    const gate = readGate(source({ gate: "flag" }), () => () => allowed);
    expect(gate.gate?.()).toBe(false);
    allowed = true;
    expect(gate.gate?.()).toBe(true);

    // A boolean path is documented as legal and has to be re-evaluated too: no issue, and flipping
    // the host flag must reach the next `enable()` (FR-17 §1).
    let flag = true;
    const booleanGate = readGate(source({ gate: "flag" }), () => flag);
    expect(booleanGate.issues).toEqual([]);
    expect(booleanGate.gate?.()).toBe(true);
    flag = false;
    expect(booleanGate.gate?.()).toBe(false);

    expect(readGate(source({ gate: "flag" }), noGlobals).issues[0]).toContain("does not resolve to a function");
  });
});

describe("embed attributes — loader options", () => {
  it("splits the script tag's data-* into loader keys and element attributes", () => {
    // A real script element, so the DOM path (`element.attributes`) is what gets tested.
    const script = document.createElement("script");
    for (const [name, value] of Object.entries({
      "data-endpoint": "/api/v1/bluepencil",
      "data-language": "de",
      "data-manifest": "/bluepencil/latest.json",
      "data-watch": "30",
      "data-integrity": "true",
      "data-auto": "false",
      "data-tag": "bp-notes",
      "data-unknown": "ignored",
      "data-empty": "",
    })) {
      script.setAttribute(name, value);
    }
    script.setAttribute("id", "not-data");
    document.head.append(script);

    const data = collectDataAttributes(script);
    const options = parseLoaderOptions(data);
    expect(options.attributes).toEqual({ endpoint: "/api/v1/bluepencil", language: "de" });
    expect(options.manifest).toBe("/bluepencil/latest.json");
    expect(options.watchSeconds).toBe(30);
    expect(options.integrity).toBe(true);
    expect(options.auto).toBe(false);
    expect(options.tag).toBe("bp-notes");
    expect(data.id).toBeUndefined();
  });

  it("defaults to the element tag, no watch and auto-mount", () => {
    const options = parseLoaderOptions({});
    expect(options.tag).toBe("bluepencil-notes");
    expect(options.watchSeconds).toBe(0);
    expect(options.auto).toBe(true);
    expect(options.attributes).toEqual({});
    expect(ALL_ATTRIBUTES).toContain("endpoint");
  });
});

/* -------------------------------------------------------------------------- */
/* version.ts                                                                  */
/* -------------------------------------------------------------------------- */

describe("runtime update contract — manifest and versions", () => {
  it("parses a manifest and rejects damaged ones", () => {
    expect(parseManifest({ version: "0.2.1", element: "/bp/0.2.1/element.js" })).toEqual({
      manifest: { version: "0.2.1", element: "/bp/0.2.1/element.js" },
    });
    expect(parseManifest({ version: "0.2.1", element: "/x", sha256: "ab".repeat(32) }).manifest?.sha256).toBe(
      "ab".repeat(32),
    );
    expect(parseManifest({ element: "/x" }).issue).toContain("manifest.version");
    expect(parseManifest({ version: "1", element: "" }).issue).toContain("manifest.element");
    expect(parseManifest({ version: "1", element: "/x", sha256: "nope" }).issue).toContain("manifest.sha256");
    expect(parseManifest("nope").issue).toContain("must be a JSON object");
    expect(parseManifestText("{oops").issue).toContain("not valid JSON");
  });

  it("resolves the element URL from the manifest, data-src or the sibling build", () => {
    expect(resolveElementUrl({ scriptUrl: "https://c.example/bp/attach.js" })).toBe(
      "https://c.example/bp/bluepencil.element.min.js",
    );
    expect(
      resolveElementUrl({ scriptUrl: "https://c.example/bp/attach.js", src: "0.2.1/element.js" }),
    ).toBe("https://c.example/bp/0.2.1/element.js");
    expect(
      resolveElementUrl({ scriptUrl: "https://c.example/bp/attach.js", src: "/bp/{version}/e.js", version: "9.9.9" }),
    ).toBe("https://c.example/bp/9.9.9/e.js");
    expect(absoluteUrl("not-a-url", "/abs").length).toBeGreaterThan(0);
  });

  it("reloads only for a different, known version", () => {
    expect(shouldReload("0.1.0", "0.2.0")).toBe(true);
    expect(shouldReload("0.2.0", "0.2.0")).toBe(false);
    expect(shouldReload("unknown", "0.2.0")).toBe(true);
    expect(shouldReload("0.1.0", undefined)).toBe(false);
    expect(shouldReload("0.1.0", "")).toBe(false);
  });

  it("verifies an integrity digest against a served build", async () => {
    const body = new TextEncoder().encode("element build").buffer;
    const digest = await sha256Hex(body);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    expect((await verifyIntegrity({ url: "/e.js", sha256: digest as string, fetchImpl })).ok).toBe(true);
    const mismatch = await verifyIntegrity({ url: "/e.js", sha256: "ab".repeat(32), fetchImpl });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.issue).toContain("integrity check failed");
    const missing = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    expect((await verifyIntegrity({ url: "/e.js", sha256: digest as string, fetchImpl: missing })).ok).toBe(false);
  });

  it("digests bytes that come from another realm", async () => {
    // Node 20's `subtle.digest` brand-checks its argument with `instanceof`, and that check is
    // realm-bound: an ArrayBuffer from a jsdom document, an iframe, a worker or a VM context is
    // rejected with "2nd argument is not instance of ArrayBuffer". Node 26 accepts it, so only the
    // CI runtime shows the difference — the bytes are re-wrapped before they are handed over.
    const foreign = vm.runInNewContext("new Uint8Array([1, 2, 3]).buffer") as ArrayBuffer;
    expect(foreign instanceof ArrayBuffer).toBe(false);
    expect(await sha256Hex(foreign)).toBe(await sha256Hex(new Uint8Array([1, 2, 3]).buffer));

    const handed: unknown[] = [];
    const cryptoImpl = {
      subtle: {
        digest: async (_algorithm: string, bytes: unknown) => {
          handed.push(bytes);
          return new Uint8Array(32).buffer;
        },
      },
    } as unknown as Crypto;
    await sha256Hex(foreign, cryptoImpl);
    expect(handed).toHaveLength(1);
    expect(handed[0]).not.toBe(foreign);
    expect(handed[0]).toBeInstanceOf(Uint8Array);
  });
});

/* -------------------------------------------------------------------------- */
/* the element                                                                 */
/* -------------------------------------------------------------------------- */

describe("element — the attach surface", () => {
  it("observes every documented attribute", () => {
    expect([...BluepencilNotesElement.observedAttributes]).toEqual([...ALL_ATTRIBUTES]);
  });

  it("builds an HTTP store from endpoint, headers and token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ notes: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);

    const element = mount({
      endpoint: "/api/v1/bluepencil",
      headers: '{"X-Workspace":"7"}',
      token: "abc",
      "token-scheme": "Bearer",
    });
    // The layer's own enable() already hydrates the store; asking for `ready()` must not add a read.
    await element.blueprint?.ready();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/v1/bluepencil/notes");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer abc");
    expect(headers["X-Workspace"]).toBe("7");
    expect(element.issues).toEqual([]);
  });

  it("keeps the adapter name path when no endpoint is given", () => {
    const element = mount({ adapter: "localStorage", language: "de" });
    expect(element.blueprint).not.toBeNull();
    expect(element.blueprint?.store).toBeDefined();
  });

  it("gates on a host function and never enables when it says no", () => {
    (globalThis as { __bpGate?: () => boolean }).__bpGate = () => false;
    try {
      const element = mount({ adapter: "memory", gate: "__bpGate" });
      expect(element.blueprint?.enable()).toBe(false);
      expect(element.blueprint?.isEnabled()).toBe(false);
    } finally {
      delete (globalThis as { __bpGate?: () => boolean }).__bpGate;
    }
  });

  it("reports configuration mistakes as issues and as bp-error, never as a throw", async () => {
    const errors: unknown[] = [];
    const element = elementWith({
      adapter: "memory",
      headers: "{oops",
      environment: "prod",
      route: "hash",
    });
    element.addEventListener("bp-error", (event) => errors.push((event as CustomEvent).detail));
    document.body.append(element);
    await Promise.resolve();
    await Promise.resolve();

    expect(element.issues.join(" | ")).toContain("headers is not valid JSON");
    expect(element.issues.join(" | ")).toContain("environment must be dev, staging or live");
    expect(element.issues.join(" | ")).toContain('route must be "url"');
    expect(errors.length).toBe(3);
    expect(element.blueprint).not.toBeNull();
  });

  it("accepts a valid URL route without complaining", () => {
    const element = mount({ adapter: "memory", route: "url" });
    expect(element.issues).toEqual([]);
  });

  it("destroy() releases the layer, the element keeps no blueprint and the styles go away", () => {
    const element = mount({ adapter: "memory" });
    expect(document.querySelectorAll("style[data-bp-styles]").length).toBe(1);
    element.destroy();
    element.remove();
    expect(element.blueprint).toBeNull();
    expect(document.querySelectorAll("style[data-bp-styles]").length).toBe(0);
    expect(document.querySelectorAll("[data-bp-part]").length).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* host paths for identity and target resolution (issue #12, FR-1.10)          */
/* -------------------------------------------------------------------------- */

describe("identity and can-annotate as host paths", () => {
  it("accepts a global path for identity that resolves to { getUser() }", () => {
    const host = { getUser: () => ({ id: "u-1", name: "Anna" }) };
    const resolved = readEnvironment(source({ identity: "hostApp.identity" }), (path) =>
      path === "hostApp.identity" ? host : undefined,
    );
    // The object is handed through untouched — the layer asks it for the author per note.
    expect(resolved.identity).toBe(host);
    expect(resolved.issues).toEqual([]);
  });

  it("keeps the documented shorthands and still reports a value that resolves to nothing", () => {
    expect(readEnvironment(source({ identity: "prompt" })).identity).toBe("prompt");
    expect(readEnvironment(source({ identity: "anonymous" })).identity).toBe("anonymous");
    const broken = readEnvironment(source({ identity: "hostApp.gone" }), () => undefined);
    expect(broken.identity).toBeUndefined();
    expect(broken.issues[0]).toContain('identity must be "prompt" or "anonymous"');
    expect(broken.issues[0]).toContain("{ getUser() }");
  });

  it("reads can-annotate as a re-usable decision function", () => {
    expect(ALL_ATTRIBUTES).toContain("can-annotate");
    const decisions: string[] = [];
    const read = readCanAnnotate(source({ "can-annotate": "hostApp.canAnnotate" }), () => (el: Element) => {
      decisions.push(el.tagName);
      return el.tagName !== "ASIDE";
    });
    const main = document.createElement("main");
    const aside = document.createElement("aside");
    expect(read.canAnnotate?.(main)).toBe(true);
    expect(read.canAnnotate?.(aside)).toBe(false);
    expect(decisions).toEqual(["MAIN", "ASIDE"]);
    expect(read.issues).toEqual([]);
  });

  it("reports a can-annotate path that is not a function", () => {
    const read = readCanAnnotate(source({ "can-annotate": "hostApp.missing" }), () => "kein function");
    expect(read.canAnnotate).toBeUndefined();
    expect(read.issues[0]).toContain('can-annotate "hostApp.missing" does not resolve to a function');
  });

  it("reaches the element: a broken can-annotate is reported, a valid identity is not", () => {
    (globalThis as { hostApp?: unknown }).hostApp = {
      identity: { getUser: () => ({ id: "u-1", name: "Anna" }) },
    };
    try {
      const broken = mount({ adapter: "memory", "can-annotate": "hostApp.missing" });
      expect(broken.issues.join(" | ")).toContain("can-annotate");
      broken.destroy();
      broken.remove();

      const accepted = mount({ adapter: "memory", identity: "hostApp.identity" });
      expect(accepted.issues).toEqual([]);
      accepted.destroy();
      accepted.remove();
    } finally {
      delete (globalThis as { hostApp?: unknown }).hostApp;
    }
  });

  it("reads dock and reports an edge it cannot honour", () => {
    expect(ALL_ATTRIBUTES).toContain("dock");
    expect(readDock(source({ dock: "bottom" })).dock).toBe("bottom");
    expect(readDock(source({ dock: "top" })).dock).toBe("top");
    expect(readDock(source({})).dock).toBeUndefined();
    expect(readDock(source({ dock: "left" })).issues[0]).toContain('dock must be "top" or "bottom"');
  });

  it("reaches the layer through the element: the layer docks where the host says", () => {
    document.body.innerHTML = `<main id="host"><p data-bluepencil="a">Text</p></main>`;
    const element = mount({ adapter: "memory", dock: "bottom" });
    try {
      expect(element.issues).toEqual([]);
      expect(document.querySelector(".bp-root")?.getAttribute("data-bp-dock")).toBe("bottom");
    } finally {
      element.destroy();
      element.remove();
    }
  });

  it("reads a keymap from markup and reports what it cannot honour (FR-12.11)", () => {
    expect(ALL_ATTRIBUTES).toContain("keymap");

    const read = readKeymap(source({ keymap: "bar=g, panel=p" }));
    expect(read.keymap).toEqual({ bar: ["g"], panel: ["p"] });
    expect(read.issues).toEqual([]);

    expect(readKeymap(source({ keymap: "bar" })).issues[0]).toContain('keymap "bar" is missing a key');
    expect(readKeymap(source({ keymap: "bar=l" })).issues[0]).toContain('"bar" and "panel" both claim "l"');
    expect(readKeymap(source({ keymap: "nope=x" })).issues[0]).toContain('unknown shortcut "nope"');
    expect(readKeymap(source({})).keymap).toBeUndefined();
  });

  it("reaches the layer through the element: a remapped key acts (FR-12.11)", () => {
    document.body.innerHTML = `<main id="host"><p data-bluepencil="a">Text</p></main>`;
    const element = mount({ adapter: "memory", keymap: "bar=g" });
    try {
      expect(element.issues).toEqual([]);
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
      const bar = document.querySelector('[data-bp-part="bar"]') as HTMLElement | null;
      expect(bar?.hidden).toBe(false);

      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "g", bubbles: true }));
      expect(bar?.hidden).toBe(true);
    } finally {
      element.destroy();
      element.remove();
    }
  });

  it("reads annotate-selectors and reports a selector the DOM refuses", () => {
    expect(ALL_ATTRIBUTES).toContain("annotate-selectors");

    const read = readAnnotateSelectors(source({ "annotate-selectors": ".card, .tile" }));
    expect(read.annotateSelectors).toEqual([".card", ".tile"]);
    expect(read.issues).toEqual([]);

    // One bad entry does not cost the good ones — and the host hears about it up front.
    const partial = readAnnotateSelectors(source({ "annotate-selectors": ".card, >>nope" }));
    expect(partial.annotateSelectors).toEqual([".card"]);
    expect(partial.issues[0]).toContain('annotate-selectors ">>nope" is not a valid CSS selector');

    expect(readAnnotateSelectors(source({})).annotateSelectors).toBeUndefined();
  });

  it("reaches the layer through the element: the registered card becomes the anchor (FR-1.12)", async () => {
    document.body.innerHTML = `
      <main id="host">
        <article class="card" data-bluepencil="card-1"><h3 class="card-title">Umsatz 42</h3></article>
      </main>`;
    const element = mount({ adapter: "memory", "annotate-selectors": ".card" });
    try {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
      const title = document.querySelector(".card-title");
      if (title === null) throw new Error("fixture missing");
      title.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));

      const textarea = document.querySelector('[data-bp-part="composer"] textarea') as HTMLTextAreaElement | null;
      if (textarea === null) throw new Error("composer did not open");
      textarea.value = "Karte prüfen";
      document
        .querySelector('[data-bp-part="composer"] [data-bp-action="composer-save"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const notes = element.blueprint?.store.notes() ?? [];
      expect(notes).toHaveLength(1);
      const note = notes[0];
      if (note === undefined) throw new Error("note was not stored");
      expect(JSON.stringify(note.anchor)).toContain("card");
      expect(JSON.stringify(note.anchor)).not.toContain("h3");
    } finally {
      element.destroy();
      element.remove();
    }
  });

  it("reaches the layer: the host decides which element may be annotated (FR-1.10)", async () => {
    document.body.innerHTML = `
      <main id="host">
        <p data-bluepencil="a">Yes</p>
        <aside data-bluepencil="b">No</aside>
      </main>`;
    (globalThis as { hostApp?: unknown }).hostApp = {
      canAnnotate: (element: Element) => element.tagName !== "ASIDE",
    };
    const element = mount({ adapter: "memory", "can-annotate": "hostApp.canAnnotate" });
    const composerVisible = (): boolean => {
      const node = document.querySelector('[data-bp-part="composer"]') as HTMLElement | null;
      return node !== null && node.hidden === false;
    };
    try {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
      const aside = document.querySelector("aside");
      const paragraph = document.querySelector("p");
      if (aside === null || paragraph === null) throw new Error("fixture missing");

      aside.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
      expect(composerVisible()).toBe(false);

      // The accepted element still opens it, so the rejection is the host's decision, not a dead mode.
      paragraph.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
      expect(composerVisible()).toBe(true);
    } finally {
      element.destroy();
      element.remove();
      delete (globalThis as { hostApp?: unknown }).hostApp;
    }
  });
});

/* Issue #21: a bundle exported from a tag-embedded deployment must be able to name its app and its
   exporter — before, every export said `app.name: "unknown"` / `exportedBy: "unknown"`. */

describe("embed attributes — bundle metadata (issue #21)", () => {
  it("reads app, build-ref and exported-by together", () => {
    const info = readAppInfo(
      source({ app: "ReqogniLoom", "build-ref": "1.8.0-beta.12", "exported-by": "dduchrow" }),
    );

    expect(info.app).toEqual({ name: "ReqogniLoom", buildRef: "1.8.0-beta.12" });
    expect(info.exportedBy).toBe("dduchrow");
  });

  it("keeps a build reference without an app name and stays empty without configuration", () => {
    expect(readAppInfo(source({ "build-ref": "abc1234" })).app).toEqual({
      name: "unknown",
      buildRef: "abc1234",
    });
    expect(readAppInfo(source({ app: "" })).app).toBeUndefined();
    expect(readAppInfo(source({})).exportedBy).toBeUndefined();
  });

  it("documents every bundle-metadata attribute the element observes", () => {
    for (const name of ["app", "build-ref", "exported-by"]) {
      expect(ALL_ATTRIBUTES).toContain(name);
    }
  });
});
