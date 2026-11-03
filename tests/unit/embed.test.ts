/**
 * Unit tests of the embed vocabulary and the attach surface of the element (FR-17).
 *
 * Covers: `src/embed/attributes.ts` (attribute → configuration mapping, issue reporting),
 * `src/embed/version.ts` (manifest, version resolution, integrity) and the element attributes
 * (`endpoint`, `headers`, `route*`, `gate`, `theme`, `modes`, `destroy()`) — including the removal
 * of the `token*` credential attributes (ADR-0.12-S3, AC-C10).
 *
 * Everything runs against the real modules and a real jsdom document — no stubs of other agents'
 * modules. The HTTP store is exercised through a stubbed `fetch`, so the wiring from an HTML
 * attribute to an outgoing request is proven without a server.
 */

import vm from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ALL_ATTRIBUTES,
  EMBED_ATTRIBUTES,
  LEGACY_TOKEN_ATTRIBUTES,
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
  readLegacyTokenAttributes,
  readModes,
  readRoute,
  readStore,
  readTheme,
  resolveGlobalPath,
  type EmbedAttributeSource,
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

function source(attributes: Record<string, string>): EmbedAttributeSource {
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
  it("merges static headers and the dynamic function (function wins)", () => {
    const resolve = (path: string) =>
      path === "host.headers" ? () => ({ "X-Dynamic": "yes", "X-Workspace": "from-fn" }) : undefined;
    const result = readHeaders(
      source({
        headers: '{"X-Workspace":"from-json","X-Static":"1"}',
        "headers-from": "host.headers",
      }),
      resolve,
    );
    expect(result.issues).toEqual([]);
    expect(result.headers?.()).toEqual({
      "X-Workspace": "from-fn",
      "X-Static": "1",
      "X-Dynamic": "yes",
    });
  });

  it("never builds a credential header from a removed token attribute (AC-C10)", () => {
    const result = readHeaders(
      source({ token: "t0ken", "token-header": "X-Api-Key", "token-scheme": "Bearer" }),
      noGlobals,
    );
    // No header function at all: the http adapter then sends only `Accept`, and the host is told why.
    expect(result.headers).toBeUndefined();
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain("token attributes are no longer supported in 0.12.0");
    expect(result.issues[0]).toContain("worker-only");
    expect(result.issues[0]).toContain("options page");
  });

  it("keeps the configured headers and still reports a legacy token attribute", () => {
    const result = readHeaders(source({ headers: '{"A":"1"}', token: "s3cret" }), noGlobals);
    expect(result.headers?.()).toEqual({ A: "1" });
    expect(result.issues[0]).toContain("token attributes are no longer supported");
    expect(JSON.stringify(result.headers?.())).not.toContain("s3cret");
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

describe("embed attributes — the removed token vocabulary (AC-C10, ADR-0.12-S3)", () => {
  it("removes token, token-header and token-scheme from the vocabulary and observations", () => {
    expect(LEGACY_TOKEN_ATTRIBUTES).toEqual(["token", "token-header", "token-scheme"]);
    for (const name of LEGACY_TOKEN_ATTRIBUTES) {
      expect(EMBED_ATTRIBUTES).not.toContain(name);
      expect(ALL_ATTRIBUTES).not.toContain(name);
      expect(BluepencilNotesElement.observedAttributes).not.toContain(name);
    }
  });

  it("names exactly the attributes the host set and says where the credential lives now", () => {
    expect(readLegacyTokenAttributes(source({}))).toEqual({ issues: [] });

    const read = readLegacyTokenAttributes(
      source({ token: "abc", "token-scheme": "Bearer", endpoint: "/api" }),
    );
    expect(read.issues).toHaveLength(1);
    expect(read.issues[0]).toContain("`token`");
    expect(read.issues[0]).toContain("`token-scheme`");
    expect(read.issues[0]).not.toContain("`token-header`");
    // Actionable: worker-only credential + the place it is configured now.
    expect(read.issues[0]).toContain("worker-only");
    expect(read.issues[0]).toContain("service worker");
    expect(read.issues[0]).toContain("extension options page");
  });

  it("detects an empty token attribute too — presence is the signal, not the value", () => {
    expect(readLegacyTokenAttributes(source({ token: "" })).issues).toHaveLength(1);
  });

  it("reports a legacy data-token* key on the loader tag and never forwards the value", () => {
    const options = parseLoaderOptions({
      endpoint: "/api",
      token: "s3cret",
      "token-header": "X-Api-Key",
    });
    // No credential reaches the element (which would put it back into the page's DOM).
    expect(options.attributes).toEqual({ endpoint: "/api" });
    expect(JSON.stringify(options.attributes)).not.toContain("s3cret");
    expect(options.issues).toHaveLength(1);
    expect(options.issues?.[0]).toContain("token attributes are no longer supported");
    // Nothing to report when the tag is clean.
    expect(parseLoaderOptions({ endpoint: "/api" }).issues).toBeUndefined();
  });
});

describe("embed attributes — route and gate", () => {
  it("defaults to the path-only route when the element has no `route` (AC-C04)", () => {
    // G8: the safe default does not cost the deep-link context — the path stays, the query goes.
    const implicit = readRoute(source({}), noGlobals, { pathname: "/p", search: "?token=secret&x=1" });
    expect(implicit.issues).toEqual([]);
    expect(implicit.getRoute?.()).toBe("/p");

    // An explicit `route="url"` means exactly the same thing.
    const explicit = readRoute(source({ route: "url" }), noGlobals, { pathname: "/p", search: "?x=1" });
    expect(explicit.getRoute?.()).toBe("/p");
  });

  it('route="url-with-query" keeps the query, filtered by query-allow/query-deny (AC-C02, AC-C03)', () => {
    const full = readRoute(source({ route: "url-with-query" }), noGlobals, {
      pathname: "/p",
      search: "?token=secret&x=1",
    });
    expect(full.getRoute?.()).toBe("/p?token=secret&x=1");

    const filtered = readRoute(
      source({ route: "url-with-query", "query-allow": "utm_*", "query-deny": "utm_source" }),
      noGlobals,
      { pathname: "/p", search: "?utm_source=a&utm_medium=b&ref=c" },
    );
    expect(filtered.issues).toEqual([]);
    expect(filtered.getRoute?.()).toBe("/p?utm_medium=b");
  });

  it("accepts a complete policy as an override, and route-from still delegates to the host", () => {
    const overridden = readRoute(source({ route: "url-with-query" }), noGlobals, { pathname: "/p", search: "?a=1" }, {
      query: { mode: "url", allow: [], deny: [] },
    });
    expect(overridden.getRoute?.()).toBe("/p");

    const host = readRoute(source({ "route-from": "router.current" }), () => () => "/spa/route", undefined);
    expect(host.getRoute?.()).toBe("/spa/route");
    expect(host.issues).toEqual([]);

    // route-from wins over `route`: it returns the whole string, unfiltered (host responsibility).
    const wins = readRoute(
      source({ route: "url", "route-from": "router.current" }),
      () => () => "/spa/route?a=1",
      { pathname: "/ignored", search: "" },
    );
    expect(wins.getRoute?.()).toBe("/spa/route?a=1");

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
    const unknown = readRoute(source({ route: "hash" }), noGlobals, { pathname: "/", search: "?a=1" });
    expect(unknown.issues[0]).toContain('route must be "url" or "url-with-query"');
    // Unknown values keep the safe default: the path survives, the query does not.
    expect(unknown.getRoute?.()).toBe("/");
    expect(readRoute(source({ route: "url" }), noGlobals, undefined).issues[0]).toContain("needs a location");
    expect(readRoute(source({ "route-from": "gone" }), noGlobals, undefined).issues[0]).toContain(
      "does not resolve to a function",
    );
    // The implicit default in a host without a location (SSR) is simply unavailable — no issue.
    const implicit = readRoute(source({}), noGlobals, undefined);
    expect(implicit).toEqual({ issues: [] });
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

  it("forwards the modes ceiling to the element like any other element attribute", () => {
    expect(ALL_ATTRIBUTES).toContain("modes");
    expect(parseLoaderOptions({ modes: "text,design" }).attributes.modes).toBe("text,design");
  });

  it("forwards the route vocabulary — data-route, data-query-allow, data-query-deny (AC-C04)", () => {
    for (const name of ["route", "query-allow", "query-deny"]) {
      expect(ALL_ATTRIBUTES).toContain(name);
    }
    const forwarded = parseLoaderOptions({
      route: "url-with-query",
      "query-allow": "utm_*",
      "query-deny": "token",
    }).attributes;
    expect(forwarded).toEqual({
      route: "url-with-query",
      "query-allow": "utm_*",
      "query-deny": "token",
    });
    // The loader translates nothing: the element reads the very same vocabulary.
    expect(source(forwarded).getAttribute("query-allow")).toBe("utm_*");
  });
});

/* -------------------------------------------------------------------------- */
/* withdrawn voice vocabulary (AC-G03, G13)                                    */
/* -------------------------------------------------------------------------- */

describe("embed attributes — the withdrawn voice vocabulary is silently ignored", () => {
  it("does not forward data-voice or data-voice-engine from the loader", () => {
    expect(ALL_ATTRIBUTES).not.toContain("voice");
    expect(ALL_ATTRIBUTES).not.toContain("voice-engine");

    const script = document.createElement("script");
    script.setAttribute("data-voice", "");
    script.setAttribute("data-voice-engine", "hostVoice.engine");
    script.setAttribute("data-modes", "text");
    document.head.append(script);

    const data = collectDataAttributes(script);
    // The old keys are still read off the tag, but they are not part of the vocabulary any more.
    expect(data.voice).toBe("");
    expect(data["voice-engine"]).toBe("hostVoice.engine");

    const options = parseLoaderOptions(data);
    expect(options.attributes).toEqual({ modes: "text" });
    expect(Object.keys(options.attributes)).not.toContain("voice");
    expect(Object.keys(options.attributes)).not.toContain("voice-engine");
  });

  it("mounts an element that still carries voice attributes without an issue or a mic", () => {
    const element = mount({
      adapter: "memory",
      voice: "true",
      "voice-engine": "hostVoice.engine",
    });

    // Silent ignore, deliberately unlike the removed `token*` attributes: no config error at all.
    expect(element.issues).toEqual([]);
    expect(document.querySelector(".bp-voice")).toBeNull();
    expect(document.querySelector('[data-bp-action="composer-voice"]')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* host capture-mode ceiling (FR-4.10)                                        */
/* -------------------------------------------------------------------------- */

describe("embed attributes — host mode ceiling", () => {
  it("leaves the ceiling open when the attribute is absent or empty", () => {
    expect(readModes(source({}))).toEqual({ issues: [] });
    expect(readModes(source({ modes: "" }))).toEqual({ issues: [] });
  });

  it("accepts the explicit read-only value", () => {
    expect(readModes(source({ modes: "none" }))).toEqual({ modes: "none", issues: [] });
    expect(readModes(source({ modes: "  none  " }))).toEqual({ modes: "none", issues: [] });
  });

  it("reads a comma-separated list in the host's order", () => {
    expect(readModes(source({ modes: "text, design,bug" }))).toEqual({
      modes: ["text", "design", "bug"],
      issues: [],
    });
  });

  it("drops duplicates and empty entries while keeping the first occurrence", () => {
    expect(readModes(source({ modes: "design, text,,design" }))).toEqual({
      modes: ["design", "text"],
      issues: [],
    });
  });

  it("keeps the valid entries and reports each unknown one", () => {
    const result = readModes(source({ modes: "text,video,bug" }));
    expect(result.modes).toEqual(["text", "bug"]);
    expect(result.issues).toEqual(['modes "video" is not one of text, design, bug, feature']);
  });

  it("fails closed when no value is a known mode — a typo never widens the ceiling", () => {
    const result = readModes(source({ modes: "txet" }));
    expect(result.modes).toBe("none");
    expect(result.issues).toEqual(['modes "txet" is not one of text, design, bug, feature']);
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
    expect([...BluepencilNotesElement.observedAttributes]).toContain("modes");
    expect([...BluepencilNotesElement.observedAttributes]).toContain("query-allow");
    expect([...BluepencilNotesElement.observedAttributes]).toContain("query-deny");
  });

  it("stores the path by default, without any `route` attribute (AC-C04)", async () => {
    document.body.innerHTML = `
      <main id="host">
        <p data-bluepencil="intro">Text</p>
      </main>`;
    const element = mount({ adapter: "memory" });
    try {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
      const paragraph = document.querySelector("p");
      if (paragraph === null) throw new Error("fixture missing");
      paragraph.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));

      const textarea = document.querySelector('[data-bp-part="composer"] textarea') as HTMLTextAreaElement | null;
      if (textarea === null) throw new Error("composer did not open");
      textarea.value = "Pfad prüfen";
      document
        .querySelector('[data-bp-part="composer"] [data-bp-action="composer-save"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const note = element.blueprint?.store.notes()[0];
      if (note === undefined) throw new Error("note was not stored");
      // jsdom's location is http://localhost:3000/ — the path is stored, the query is not.
      expect(note.anchor.route).toBe("/");
      expect(element.issues).toEqual([]);
    } finally {
      element.destroy();
      element.remove();
    }
  });

  it("passes the modes ceiling into the layer's bar", () => {
    mount({ adapter: "memory", modes: "text,bug" });
    const hidden = (action: string) =>
      document.querySelector(`[data-bp-action="${action}"]`)?.hasAttribute("hidden") ?? null;
    // The two modes the host offered stay available, the other two disappear from the bar.
    expect(hidden("mode-text")).toBe(false);
    expect(hidden("mode-bug")).toBe(false);
    expect(hidden("mode-design")).toBe(true);
    expect(hidden("mode-feature")).toBe(true);
  });

  it("fails closed on an unrecognised modes value and reports it", () => {
    const element = mount({ adapter: "memory", modes: "txet" });
    expect(element.issues.join(" | ")).toContain(
      'modes "txet" is not one of text, design, bug, feature',
    );
    const hidden = (action: string) =>
      document.querySelector(`[data-bp-action="${action}"]`)?.hasAttribute("hidden") ?? null;
    // No mode survived the typo, so the layer is read-only rather than offering all four.
    for (const mode of ["mode-text", "mode-design", "mode-bug", "mode-feature"]) {
      expect(hidden(mode)).toBe(true);
    }
  });

  it("builds an HTTP store from endpoint and headers", async () => {
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
    });
    // The layer's own enable() already hydrates the store; asking for `ready()` must not add a read.
    await element.blueprint?.ready();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/v1/bluepencil/notes");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["X-Workspace"]).toBe("7");
    expect(headers.Authorization).toBeUndefined();
    expect(element.issues).toEqual([]);
  });

  it("does not send silently unauthenticated when a host still passes token attributes (AC-C10)", async () => {
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
      token: "page-secret",
      "token-header": "X-Api-Key",
      "token-scheme": "Bearer",
    });
    await element.blueprint?.ready();

    // The request still happens (the layer keeps working) — but it carries no credential and the
    // host hears about the removal instead of debugging a mysterious 401.
    expect(calls).toHaveLength(1);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(JSON.stringify(headers)).not.toContain("page-secret");
    expect(headers["X-Api-Key"]).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
    expect(element.issues.join(" | ")).toContain("token attributes are no longer supported in 0.12.0");
    expect(element.issues.join(" | ")).toContain("worker-only");

    // The element never copies the credential into a DOM attribute of its own.
    const written = [...element.attributes].map((attribute) => `${attribute.name}=${attribute.value}`);
    expect(written.join(" ")).not.toContain("data-bp-token");
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
