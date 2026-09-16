/**
 * Unit tests of the attach loader (FR-17 §2): script-tag discovery, manifest-driven runtime
 * updates, integrity checks, teardown and the failure contract (an error becomes an event, never a
 * throw into the host page).
 *
 * The DOM is the real jsdom document; `fetch`, the module loader and the timers are injected, so
 * the whole update path is exercised without a browser, a server or a network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { attach, attachFromDocument, start, type AttachDeps } from "../../src/embed/attach";
import { BluepencilNotesElement } from "../../src/element/index";

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

interface Harness {
  deps: Partial<AttachDeps>;
  manifest: { version: string; element: string; sha256?: string };
  fetchCalls: string[];
  timers: Array<{ fn: () => void; ms: number }>;
  loaded: string[];
  runTimers(): void;
}

function harness(options: { element?: string; integrity?: boolean } = {}): Harness {
  const state: Harness = {
    manifest: { version: "0.2.0", element: options.element ?? "/bp/0.2.0/bluepencil.element.min.js" },
    fetchCalls: [],
    timers: [],
    loaded: [],
    runTimers() {
      const pending = [...state.timers];
      state.timers.length = 0;
      for (const timer of pending) timer.fn();
    },
    deps: {},
  };
  state.deps = {
    fetchImpl: (async (input: RequestInfo | URL) => {
      state.fetchCalls.push(String(input));
      if (String(input).includes("latest.json")) {
        return new Response(JSON.stringify(state.manifest), { status: 200 });
      }
      return new Response("export const nothing = true;", { status: 200 });
    }) as unknown as typeof fetch,
    importModule: async (url: string) => {
      state.loaded.push(url);
    },
    setTimeoutImpl: (fn, ms) => {
      state.timers.push({ fn, ms });
      return state.timers.length;
    },
    clearTimeoutImpl: () => undefined,
    moduleTimeoutMs: 200,
  };
  return state;
}

function attachedElements(): BluepencilNotesElement[] {
  return [...document.querySelectorAll("bluepencil-notes")] as BluepencilNotesElement[];
}

afterEach(() => {
  for (const element of attachedElements()) {
    element.destroy();
    element.remove();
  }
  document.body.innerHTML = "";
  document.head.querySelectorAll("script, style").forEach((node) => node.remove());
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/* attach()                                                                    */
/* -------------------------------------------------------------------------- */

describe("attach — mounting", () => {
  it("reads the manifest, loads that build and mounts the forwarded attributes", async () => {
    const state = harness();
    const ready: Array<Record<string, unknown>> = [];
    document.addEventListener("bp-attach-ready", (event) => ready.push((event as CustomEvent).detail));

    const handle = await attach({
      scriptUrl: "https://c.example/bluepencil/attach.js",
      manifest: "latest.json",
      integrity: false,
      watchSeconds: 0,
      tag: "bluepencil-notes",
      auto: true,
      attributes: { endpoint: "/api/v1/bluepencil", language: "de" },
      deps: state.deps,
    });

    expect(state.fetchCalls).toEqual(["https://c.example/bluepencil/latest.json"]);
    expect(state.loaded).toEqual(["https://c.example/bp/0.2.0/bluepencil.element.min.js"]);
    expect(handle.version).toBe("0.2.0");
    expect(handle.src).toBe("https://c.example/bp/0.2.0/bluepencil.element.min.js");

    const element = attachedElements()[0];
    expect(element).toBeDefined();
    expect(element?.getAttribute("endpoint")).toBe("/api/v1/bluepencil");
    expect(element?.getAttribute("language")).toBe("de");
    expect(element?.getAttribute("attach-version")).toBe("0.2.0");
    expect(ready).toEqual([{ version: "0.2.0", src: "https://c.example/bp/0.2.0/bluepencil.element.min.js" }]);
    handle.destroy();
  });

  it("falls back to the sibling build when no manifest is configured", async () => {
    const state = harness();
    const handle = await attach({
      scriptUrl: "https://c.example/bluepencil/attach.js",
      integrity: false,
      watchSeconds: 0,
      tag: "bluepencil-notes",
      auto: true,
      attributes: { adapter: "memory" },
      deps: state.deps,
    });
    expect(state.loaded).toEqual(["https://c.example/bluepencil/bluepencil.element.min.js"]);
    expect(handle.version).toBe("unknown");
    handle.destroy();
  });

  it("mounts into the selector given by the mount attribute", async () => {
    const host = document.createElement("div");
    host.id = "review-target";
    document.body.append(host);
    const state = harness();
    const handle = await attach({
      scriptUrl: "https://c.example/attach.js",
      integrity: false,
      watchSeconds: 0,
      tag: "bluepencil-notes",
      auto: true,
      attributes: { adapter: "memory", mount: "#review-target" },
      deps: state.deps,
    });
    expect(host.querySelector("bluepencil-notes")).not.toBeNull();
    handle.destroy();
  });

  it("only loads the build when auto is false (the host mounts the element itself)", async () => {
    const state = harness();
    const handle = await attach({
      scriptUrl: "https://c.example/attach.js",
      integrity: false,
      watchSeconds: 0,
      tag: "bluepencil-notes",
      auto: false,
      attributes: { adapter: "memory" },
      deps: state.deps,
    });
    expect(handle.element).toBeNull();
    expect(attachedElements()).toHaveLength(0);
    expect(state.loaded).toHaveLength(1);
    handle.destroy();
  });
});

describe("attach — runtime updates", () => {
  it("keeps the version when nothing changed and swaps the layer when it did", async () => {
    const state = harness();
    const updated: Array<{ from: string; to: string }> = [];
    document.addEventListener("bp-attach-updated", (event) => updated.push((event as CustomEvent).detail));
    const destroySpy = vi.spyOn(BluepencilNotesElement.prototype, "destroy");

    const handle = await attach({
      scriptUrl: "https://c.example/attach.js",
      manifest: "latest.json",
      integrity: false,
      watchSeconds: 0,
      tag: "bluepencil-notes",
      auto: true,
      attributes: { adapter: "memory" },
      deps: state.deps,
    });
    const first = attachedElements()[0];

    expect(await handle.check()).toBe(false);
    expect(updated).toEqual([]);
    expect(handle.version).toBe("0.2.0");

    state.manifest = { version: "0.3.0", element: "/bp/0.3.0/bluepencil.element.min.js" };
    expect(await handle.check()).toBe(true);
    expect(handle.version).toBe("0.3.0");
    expect(updated).toEqual([{ from: "0.2.0", to: "0.3.0" }]);
    expect(destroySpy).toHaveBeenCalledTimes(1);
    const elements = attachedElements();
    expect(elements).toHaveLength(1);
    expect(elements[0]).not.toBe(first);
    expect(elements[0]?.getAttribute("attach-version")).toBe("0.3.0");
    expect(state.loaded.at(-1)).toBe("https://c.example/bp/0.3.0/bluepencil.element.min.js");
    handle.destroy();
  });

  it("polls the manifest when data-watch is set and stops on destroy()", async () => {
    const state = harness();
    const handle = await attach({
      scriptUrl: "https://c.example/attach.js",
      manifest: "latest.json",
      integrity: false,
      watchSeconds: 30,
      tag: "bluepencil-notes",
      auto: true,
      attributes: { adapter: "memory" },
      deps: state.deps,
    });
    expect(state.timers.map((timer) => timer.ms)).toEqual([30000]);
    expect(state.fetchCalls).toHaveLength(1);

    state.manifest = { version: "9.9.9", element: "/bp/9.9.9/bluepencil.element.min.js" };
    state.runTimers();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handle.version).toBe("9.9.9");
    expect(state.fetchCalls).toHaveLength(2);
    // A changed version re-arms the watch; destroy() clears it.
    expect(state.timers).toHaveLength(1);
    handle.destroy();
    expect(attachedElements()).toHaveLength(0);
  });

  it("keeps the running layer when an update fails its integrity check", async () => {
    const state = harness();
    const handle = await attach({
      scriptUrl: "https://c.example/attach.js",
      manifest: "latest.json",
      integrity: true,
      watchSeconds: 0,
      tag: "bluepencil-notes",
      auto: true,
      attributes: { adapter: "memory" },
      deps: state.deps,
    });
    const mounted = attachedElements()[0];
    state.manifest = { version: "0.3.0", element: "/bp/0.3.0/e.js", sha256: "ab".repeat(32) };

    await expect(handle.check()).rejects.toThrow(/integrity check failed/);
    expect(handle.version).toBe("0.2.0");
    const after = attachedElements();
    expect(after).toHaveLength(1);
    expect(after[0]).toBe(mounted);
    expect(state.loaded).toHaveLength(1);
    handle.destroy();
  });

  it("reload() is check() and does nothing without a manifest", async () => {
    const state = harness();
    const handle = await attach({
      scriptUrl: "https://c.example/attach.js",
      integrity: false,
      watchSeconds: 0,
      tag: "bluepencil-notes",
      auto: true,
      attributes: { adapter: "memory" },
      deps: state.deps,
    });
    await handle.reload();
    expect(state.fetchCalls).toEqual([]);
    expect(handle.version).toBe("unknown");
    handle.destroy();
  });
});

describe("attach — failure contract", () => {
  it("refuses a build whose digest does not match the manifest", async () => {
    const state = harness();
    state.manifest = { version: "0.2.0", element: "/bp/0.2.0/e.js", sha256: "ab".repeat(32) };
    await expect(
      attach({
        scriptUrl: "https://c.example/attach.js",
        manifest: "latest.json",
        integrity: true,
        watchSeconds: 0,
        tag: "bluepencil-notes",
        auto: true,
        attributes: { adapter: "memory" },
        deps: state.deps,
      }),
    ).rejects.toThrow(/integrity check failed/);
    expect(state.loaded).toEqual([]);
    expect(attachedElements()).toHaveLength(0);
  });

  it("reports a manifest that cannot be read", async () => {
    const state = harness();
    state.deps.fetchImpl = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    await expect(
      attach({
        scriptUrl: "https://c.example/attach.js",
        manifest: "latest.json",
        integrity: false,
        watchSeconds: 0,
        tag: "bluepencil-notes",
        auto: true,
        attributes: {},
        deps: state.deps,
      }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("times out when the element never appears", async () => {
    const state = harness();
    await expect(
      attach({
        scriptUrl: "https://c.example/attach.js",
        integrity: false,
        watchSeconds: 0,
        tag: "bp-never-defined",
        auto: true,
        attributes: {},
        // A polling loop needs a timer that actually fires; the harness only records timers.
        deps: { ...state.deps, moduleTimeoutMs: 30, setTimeoutImpl: (fn) => (fn(), 0) },
      }),
    ).rejects.toThrow(/was not defined within/);
  });
});

/* -------------------------------------------------------------------------- */
/* attachFromDocument / start                                                  */
/* -------------------------------------------------------------------------- */

function loaderScript(attributes: Record<string, string>, src = "https://c.example/bluepencil/attach.js"): HTMLScriptElement {
  const script = document.createElement("script");
  script.src = src;
  for (const [name, value] of Object.entries(attributes)) {
    script.setAttribute(name, value);
  }
  document.head.append(script);
  return script;
}

describe("attach — host globals", () => {
  it("uses the host's fetch with its own global as receiver", async () => {
    // Regression: `fetch` read off the window is a window operation. Called as a method of the
    // loader's own options object it throws "Illegal invocation" in every real browser (Node's fetch
    // does not care, so no jsdom test notices) — the receiver is the invariant to keep.
    const receivers: unknown[] = [];
    const original = (globalThis as { fetch?: typeof fetch }).fetch;
    function strictFetch(this: unknown): Promise<Response> {
      receivers.push(this);
      return Promise.resolve(
        new Response(JSON.stringify({ version: "0.3.0", element: "/bp/0.3.0/bluepencil.element.min.js" }), {
          status: 200,
        }),
      );
    }
    (globalThis as { fetch?: unknown }).fetch = strictFetch;
    try {
      const timers: number[] = [];
      const handle = await attach({
        scriptUrl: "https://c.example/bluepencil/attach.js",
        manifest: "latest.json",
        integrity: false,
        watchSeconds: 0,
        tag: "bluepencil-notes",
        auto: false,
        attributes: {},
        // No fetchImpl on purpose: the loader has to fall back to the host's global.
        deps: {
          document,
          importModule: async () => undefined,
          setTimeoutImpl: (_fn, ms) => {
            timers.push(ms);
            return timers.length;
          },
          clearTimeoutImpl: () => undefined,
          moduleTimeoutMs: 200,
        },
      });

      expect(receivers).toHaveLength(1);
      expect(receivers[0]).toBe(globalThis);
      expect(handle.version).toBe("0.3.0");
      expect(handle.src).toBe("https://c.example/bp/0.3.0/bluepencil.element.min.js");
    } finally {
      (globalThis as { fetch?: unknown }).fetch = original;
    }
  });
});

describe("attach — script tag discovery", () => {
  it("attaches every loader script it finds and publishes the API", async () => {
    const state = harness();
    loaderScript({ "data-endpoint": "/api/v1/bluepencil", "data-language": "de" });
    const errors: unknown[] = [];
    document.addEventListener("bp-attach-error", (event) => errors.push((event as CustomEvent).detail));

    const api = await attachFromDocument(document, state.deps);
    expect(errors).toEqual([]);
    expect(api.handles).toHaveLength(1);

    // The scan forwarded the script's data-* attributes and used the sibling build.
    expect(state.loaded).toEqual(["https://c.example/bluepencil/bluepencil.element.min.js"]);
    const element = attachedElements()[0];
    expect(element?.getAttribute("endpoint")).toBe("/api/v1/bluepencil");
    expect(element?.getAttribute("language")).toBe("de");

    expect(await api.check()).toBe(0);
    // The documented surface of FR-17 §2, populated without a host touching a handle.
    expect(api.version).toBe("unknown");
    expect(api.src).toBe("https://c.example/bluepencil/bluepencil.element.min.js");
    expect(api.instances).toEqual(attachedElements());
    expect(await api.reload()).toBe(0);
    api.destroy();
    expect(attachedElements()).toHaveLength(0);
    expect(api.instances).toEqual([]);
  });

  it("start() publishes window.bluepencilAttach", async () => {
    const state = harness();
    const api = await start(document, state.deps);
    expect(api.handles).toEqual([]);
    expect(api.version).toBe("unknown");
    expect(api.src).toBe("");
    expect(api.instances).toEqual([]);
    expect(await api.reload()).toBe(0);
    expect((globalThis as { bluepencilAttach?: unknown }).bluepencilAttach).toBe(api);
    expect((window as unknown as { bluepencilAttach?: unknown }).bluepencilAttach).toBe(api);
  });

  it("turns a failing script tag into a bp-attach-error event, never into a rejection loop", async () => {
    const state = harness();
    const errors: unknown[] = [];
    document.addEventListener("bp-attach-error", (event) => errors.push((event as CustomEvent).detail));
    // A manifest that is not a manifest: the failure happens before anything is loaded.
    loaderScript({ "data-manifest": "broken.json" });
    const api = await attachFromDocument(document, state.deps);
    expect(api.handles).toHaveLength(0);
    expect(state.loaded).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });
});
