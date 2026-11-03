/**
 * The worker's one dispatch hook (B.5, SEC-15).
 *
 * Two kinds of evidence:
 *
 * - **Behaviour (AC-B22/AC-B23).** A mount/toggle from tab A calls exactly one hook, with A — even
 *   when the message names B and B is the tab in front. There is no active-tab lookup in the path.
 * - **Source (AC-B24).** `chrome.tabs.query` appears in `sw.ts` exactly once, inside
 *   `chrome.commands.onCommand`; the toolbar handler addresses the tab the gesture hands it. Both
 *   gesture handlers mount through the same `mountOnTab` sequence, and the
 *   worker has exactly one `chrome.runtime.onMessage` listener calling the dispatcher once.
 *
 * The built-worker half of AC-B24 is `smoke:ext`; this unit file deliberately reads `extension/src`
 * so it stays green without a prior `build:ext`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { WorkerOutcome } from "../../extension/src/bridge-messages";
import { dispatchTabMessage, type DispatchHooks } from "../../extension/src/tab-binding";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relative: string): string => readFileSync(join(ROOT, relative), "utf8");

const SW_SOURCE = source("extension/src/sw.ts");
const TAB_BINDING_SOURCE = source("extension/src/tab-binding.ts");

const OWN = "own-extension-id";
const URL_A = "https://a.example/x";

function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return found;
    found.push(index);
    from = index + needle.length;
  }
}

interface Recorded {
  mounts: { tabId: number; tabUrl: string; options: { force?: boolean } }[];
  toggles: { tabId: number; enabled: boolean }[];
}

function recorder(): { hooks: DispatchHooks; recorded: Recorded } {
  const recorded: Recorded = { mounts: [], toggles: [] };
  const hooks: DispatchHooks = {
    async mount(tabId, tabUrl, options): Promise<WorkerOutcome> {
      recorded.mounts.push({ tabId, tabUrl, options });
      return { kind: "mount", ok: true, tabUrl };
    },
    async toggle(tabId, enabled): Promise<WorkerOutcome> {
      recorded.toggles.push({ tabId, enabled });
      return { kind: "toggle", ok: true, enabled };
    },
  };
  return { hooks, recorded };
}

describe("the worker has exactly one dispatch hook (AC-B24)", () => {
  it("registers one runtime.onMessage listener", () => {
    expect(occurrences(SW_SOURCE, "chrome.runtime.onMessage.addListener")).toHaveLength(1);
  });

  it("routes the two control kinds through dispatchTabMessage exactly once", () => {
    expect(occurrences(SW_SOURCE, "dispatchTabMessage(")).toHaveLength(1);
    expect(SW_SOURCE).toMatch(/import \{[^}]*\bdispatchTabMessage\b[^}]*\} from "\.\/tab-binding"/);
    expect(SW_SOURCE).toContain("ownExtensionId: chrome.runtime.id");
  });

  it("has no tabs.query in the message listener", () => {
    const listener = SW_SOURCE.indexOf("chrome.runtime.onMessage.addListener");
    const action = SW_SOURCE.indexOf("chrome.action.onClicked.addListener");
    expect(listener).toBeGreaterThan(-1);
    expect(action).toBeGreaterThan(listener);
    expect(SW_SOURCE.slice(listener, action)).not.toContain("chrome.tabs.query");
  });

  it("keeps chrome.tabs.query only inside the keyboard-command gesture handler", () => {
    const action = SW_SOURCE.indexOf("chrome.action.onClicked.addListener");
    const command = SW_SOURCE.indexOf("chrome.commands.onCommand.addListener");
    expect(action).toBeGreaterThan(-1);
    expect(command).toBeGreaterThan(action);

    const queries = occurrences(SW_SOURCE, "chrome.tabs.query");
    // The toolbar handler does not need the lookup: the click already carries the tab. The command
    // handler is the one that has to ask which tab is active.
    expect(queries).toHaveLength(1);
    expect(queries[0]).toBeGreaterThan(command);
  });

  it("mounts from both gesture handlers through the one mount sequence", () => {
    const action = SW_SOURCE.indexOf("chrome.action.onClicked.addListener");
    const command = SW_SOURCE.indexOf("chrome.commands.onCommand.addListener");
    const declarations = SW_SOURCE.indexOf("declare const chrome");

    expect(SW_SOURCE.slice(action, command)).toContain("mountOnTab(tab.id");
    expect(SW_SOURCE.slice(command, declarations)).toContain("mountOnTab(tab.id");
    // Both gestures end in the same owner of the injection sequence, never a second copy of it.
    expect(SW_SOURCE).toContain("const result = await mountOnTab(tabId, tabUrl, options)");
  });

  it("keeps the dispatch module free of browser APIs", () => {
    // The prose names the API it deliberately does not use; the code must not.
    const code = TAB_BINDING_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("chrome.");
    expect(code).not.toContain("tabs.query");
  });
});

describe("dispatchTabMessage — one hook on the sender's tab (AC-B22)", () => {
  it("calls exactly one hook with the sender's tab id and URL", async () => {
    const { hooks, recorded } = recorder();
    const reply = await dispatchTabMessage(
      {
        message: { type: "bluepencil:mount" },
        sender: { id: OWN, tab: { id: 7, url: URL_A } },
        ownExtensionId: OWN,
      },
      hooks,
    );

    expect(recorded.mounts).toEqual([{ tabId: 7, tabUrl: URL_A, options: {} }]);
    expect(recorded.toggles).toEqual([]);
    expect(reply).toEqual({ ok: true, tabUrl: URL_A });
  });
});

describe("dispatchTabMessage — a background tab never reaches the tab in front (AC-B23)", () => {
  it("acts on tab A although tab B is active", async () => {
    const globals = globalThis as { chrome?: unknown };
    const queries: unknown[] = [];
    globals.chrome = {
      tabs: {
        query: (info: unknown) => {
          queries.push(info);
          return Promise.resolve([{ id: 99 }]);
        },
      },
    };
    try {
      const { hooks, recorded } = recorder();
      const reply = await dispatchTabMessage(
        {
          // A page-side request-mount names no tab; the sender is what decides.
          message: { type: "bluepencil:mount", tabId: 99 },
          sender: { tab: { id: 7, url: URL_A } },
          ownExtensionId: OWN,
        },
        hooks,
      );

      const targets = [...recorded.mounts, ...recorded.toggles];
      expect(targets).toHaveLength(1);
      expect(recorded.mounts.map((call) => call.tabId)).toEqual([7]);
      expect(queries).toEqual([]);
      expect(reply).toEqual({ ok: true, tabUrl: URL_A });
    } finally {
      delete globals.chrome;
    }
  });
});

describe("dispatchTabMessage — the extension-page half of AC-B48", () => {
  it("answers a toggle without tabId with no_tab", async () => {
    const { hooks, recorded } = recorder();
    const reply = await dispatchTabMessage(
      {
        message: { type: "bluepencil:toggle" },
        sender: { id: OWN },
        ownExtensionId: OWN,
      },
      hooks,
    );

    expect(reply).toMatchObject({ ok: false, code: "no_tab" });
    expect(recorded.mounts).toEqual([]);
    expect(recorded.toggles).toEqual([]);
  });
});
