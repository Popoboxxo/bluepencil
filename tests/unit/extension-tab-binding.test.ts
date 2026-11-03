/**
 * Tab binding (SEC-15, B.5): which tab a worker message may act on, and that it is exactly one.
 *
 * Two properties are observed here, both pure:
 *
 * - **`resolveTabTarget` is the whole rule.** A content script's `sender.tab.id` wins because the
 *   browser sets it and a page cannot. A message that names another tab is not a second target
 *   (AC-B22/AC-B23); only an own extension page may name one explicitly (AC-B27).
 * - **`dispatchTabMessage` has no way to look up "the active tab".** The module is pure, so the
 *   background-tab attack is not a policy in the dispatcher but an absent capability (AC-B23).
 *
 * Named refusals — `no_tab`, `invalid_tab_id`, `foreign_sender` — are values, not throws.
 */
import { describe, expect, it } from "vitest";

import type { WorkerOutcome } from "../../extension/src/bridge-messages";
import {
  dispatchTabMessage,
  resolveTabTarget,
  type DispatchHooks,
} from "../../extension/src/tab-binding";

const OWN = "own-extension-id";
const URL_A = "https://a.example/x";
const URL_B = "https://b.example/y";

interface MountCall {
  tabId: number;
  tabUrl: string;
  options: { force?: boolean };
}

interface ToggleCall {
  tabId: number;
  enabled: boolean;
}

/**
 * Record the hooks a dispatch may call.
 *
 * `outcome` overrides what the hook returns, which is how a page that refuses injection is
 * simulated without a browser: the dispatcher only ever sees the `WorkerOutcome`.
 */
function recorder(outcome?: WorkerOutcome): {
  hooks: DispatchHooks;
  mounts: MountCall[];
  toggles: ToggleCall[];
} {
  const mounts: MountCall[] = [];
  const toggles: ToggleCall[] = [];
  const hooks: DispatchHooks = {
    async mount(tabId, tabUrl, options) {
      mounts.push({ tabId, tabUrl, options });
      if (outcome?.kind === "mount") return outcome;
      return { kind: "mount", ok: true, tabUrl };
    },
    async toggle(tabId, enabled) {
      toggles.push({ tabId, enabled });
      if (outcome?.kind === "toggle") return outcome;
      return { kind: "toggle", ok: true, enabled };
    },
  };
  return { hooks, mounts, toggles };
}

describe("resolveTabTarget — the sender's own tab always wins (AC-B22/AC-B23)", () => {
  it("uses sender.tab.id and its URL", () => {
    expect(
      resolveTabTarget(
        { id: OWN, tab: { id: 7, url: URL_A } },
        { type: "bluepencil:mount" },
        OWN,
      ),
    ).toEqual({ kind: "sender", tabId: 7, tabUrl: URL_A });
  });

  it("ignores a tab the message names when the sender already has one", () => {
    // The background-tab attack: tab A asks, tab B is active. `sender.tab.id` is A, so the message
    // cannot retarget the effect to B.
    expect(
      resolveTabTarget(
        { id: OWN, tab: { id: 7, url: URL_A } },
        { type: "bluepencil:mount", tabId: 99 },
        OWN,
      ),
    ).toEqual({ kind: "sender", tabId: 7, tabUrl: URL_A });
  });

  it("keeps the URL empty when the sender's tab has none", () => {
    expect(resolveTabTarget({ tab: { id: 7 } }, { type: "bluepencil:mount" }, OWN)).toEqual({
      kind: "sender",
      tabId: 7,
      tabUrl: "",
    });
  });

  it("refuses a sender tab that has no usable id instead of re-reading it as an extension page", () => {
    for (const id of [0, -1, 1.5]) {
      expect(resolveTabTarget({ tab: { id } }, { type: "bluepencil:mount", tabId: 7 }, OWN)).toEqual(
        { kind: "none", code: "invalid_tab_id" },
      );
    }
  });
});

describe("resolveTabTarget — extension pages may name a tab, strangers may not (AC-B27)", () => {
  it("accepts an explicit tab from an own extension page", () => {
    expect(resolveTabTarget({ id: OWN }, { type: "bluepencil:toggle", tabId: 7 }, OWN)).toEqual({
      kind: "explicit",
      tabId: 7,
    });
  });

  it("refuses a foreign sender even when it names a plausible tab", () => {
    for (const id of ["some-other-extension", ""]) {
      expect(resolveTabTarget({ id }, { type: "bluepencil:mount", tabId: 7 }, OWN)).toEqual({
        kind: "none",
        code: "foreign_sender",
      });
    }
  });

  it("refuses a sender without an id — missing is as foreign as wrong", () => {
    expect(resolveTabTarget({}, { type: "bluepencil:mount", tabId: 7 }, OWN)).toEqual({
      kind: "none",
      code: "foreign_sender",
    });
    expect(resolveTabTarget(undefined, { type: "bluepencil:mount", tabId: 7 }, OWN)).toEqual({
      kind: "none",
      code: "foreign_sender",
    });
  });

  it("names no_tab when an own extension page names nothing", () => {
    expect(resolveTabTarget({ id: OWN }, { type: "bluepencil:toggle" }, OWN)).toEqual({
      kind: "none",
      code: "no_tab",
    });
  });

  it("rejects every non-positive or non-integer tabId with invalid_tab_id", () => {
    for (const tabId of [0, -1, "7", 1.5, Number.NaN, Number.POSITIVE_INFINITY, null]) {
      expect(resolveTabTarget({ id: OWN }, { type: "bluepencil:toggle", tabId }, OWN)).toEqual({
        kind: "none",
        code: "invalid_tab_id",
      });
    }
  });
});

describe("dispatchTabMessage — exactly one hook on the sender's tab (AC-B22)", () => {
  it("calls the mount hook once with sender.tab.id and sender.tab.url", async () => {
    const recorded = recorder();
    const reply = await dispatchTabMessage(
      {
        message: { type: "bluepencil:mount", tabId: 99 },
        sender: { id: OWN, tab: { id: 7, url: URL_A } },
        ownExtensionId: OWN,
      },
      recorded.hooks,
    );

    expect(recorded.mounts).toEqual([{ tabId: 7, tabUrl: URL_A, options: {} }]);
    expect(recorded.toggles).toEqual([]);
    expect(reply).toEqual({ ok: true, tabUrl: URL_A });
  });

  it("forwards force as an explicit option, and only when it is a literal true", async () => {
    const forced = recorder();
    await dispatchTabMessage(
      {
        message: { type: "bluepencil:mount", force: true },
        sender: { tab: { id: 7, url: URL_A } },
        ownExtensionId: OWN,
      },
      forced.hooks,
    );
    expect(forced.mounts[0]?.options).toEqual({ force: true });

    const notForced = recorder();
    await dispatchTabMessage(
      {
        message: { type: "bluepencil:mount", force: "true" },
        sender: { tab: { id: 7, url: URL_A } },
        ownExtensionId: OWN,
      },
      notForced.hooks,
    );
    expect(notForced.mounts[0]?.options).toEqual({});
  });

  it("toggles the sender's tab, defaulting to on when `enabled` is absent", async () => {
    const off = recorder();
    expect(
      await dispatchTabMessage(
        {
          message: { type: "bluepencil:toggle", enabled: false },
          sender: { tab: { id: 7, url: URL_A } },
          ownExtensionId: OWN,
        },
        off.hooks,
      ),
    ).toEqual({ ok: true, enabled: false });
    expect(off.toggles).toEqual([{ tabId: 7, enabled: false }]);

    const on = recorder();
    await dispatchTabMessage(
      {
        message: { type: "bluepencil:toggle" },
        sender: { tab: { id: 7, url: URL_A } },
        ownExtensionId: OWN,
      },
      on.hooks,
    );
    expect(on.toggles).toEqual([{ tabId: 7, enabled: true }]);
  });

  it("mounts an explicitly named tab from an own extension page, with no tab URL", async () => {
    const recorded = recorder();
    const reply = await dispatchTabMessage(
      {
        message: { type: "bluepencil:mount", tabId: 7 },
        sender: { id: OWN },
        ownExtensionId: OWN,
      },
      recorded.hooks,
    );

    expect(recorded.mounts).toEqual([{ tabId: 7, tabUrl: "", options: {} }]);
    expect(reply).toEqual({ ok: true });
  });
});

describe("dispatchTabMessage — no active-tab lookup exists in the dispatch (AC-B23)", () => {
  it("never calls chrome.tabs.query, even with another tab in front", async () => {
    const globals = globalThis as { chrome?: unknown };
    const queries: unknown[] = [];
    globals.chrome = {
      tabs: {
        query: (info: unknown) => {
          queries.push(info);
          return Promise.resolve([{ id: 99, url: URL_B }]);
        },
      },
    };
    try {
      const recorded = recorder();
      const reply = await dispatchTabMessage(
        {
          message: { type: "bluepencil:mount" },
          sender: { tab: { id: 7, url: URL_A } },
          ownExtensionId: OWN,
        },
        recorded.hooks,
      );

      expect(queries).toEqual([]);
      expect(recorded.mounts.map((call) => call.tabId)).toEqual([7]);
      expect(recorded.mounts[0]?.tabUrl).toBe(URL_A);
      expect(recorded.mounts.some((call) => call.tabId === 99)).toBe(false);
      expect(reply).toEqual({ ok: true, tabUrl: URL_A });
    } finally {
      delete globals.chrome;
    }
  });
});

describe("dispatchTabMessage — refusals are named replies, never effects (AC-B27/AC-B48)", () => {
  it("answers a toggle from an extension page without tabId with no_tab and calls nothing", async () => {
    const recorded = recorder();
    const reply = await dispatchTabMessage(
      {
        message: { type: "bluepencil:toggle" },
        sender: { id: OWN },
        ownExtensionId: OWN,
      },
      recorded.hooks,
    );

    expect(reply).toMatchObject({ ok: false, code: "no_tab" });
    expect(recorded.mounts).toEqual([]);
    expect(recorded.toggles).toEqual([]);
  });

  it("answers a foreign sender with foreign_sender and calls nothing", async () => {
    const recorded = recorder();
    const reply = await dispatchTabMessage(
      {
        message: { type: "bluepencil:mount", tabId: 7 },
        sender: { id: "not-us" },
        ownExtensionId: OWN,
      },
      recorded.hooks,
    );

    expect(reply).toMatchObject({ ok: false, code: "foreign_sender" });
    expect(recorded.mounts).toEqual([]);
    expect(recorded.toggles).toEqual([]);
  });

  it("answers an invalid explicit tabId with invalid_tab_id and calls nothing", async () => {
    const recorded = recorder();
    const reply = await dispatchTabMessage(
      {
        message: { type: "bluepencil:mount", tabId: 0 },
        sender: { id: OWN },
        ownExtensionId: OWN,
      },
      recorded.hooks,
    );

    expect(reply).toMatchObject({ ok: false, code: "invalid_tab_id" });
    expect(recorded.mounts).toEqual([]);
  });
});
