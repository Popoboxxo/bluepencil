/**
 * Named replies at the worker boundary (AC-B38, SEC-15).
 *
 * The worker must answer a caller even when the target is nonsense or the page refuses injection.
 * Every case here observes a `WorkerReply` value from `dispatchTabMessage`; a rejection would be the
 * bug (a `chrome://settings` tab is the concrete case, and the toolbar/command paths have no
 * `catch` for it).
 *
 * The three failure shapes are:
 *
 * - a non-positive/non-integer `tabId` → `invalid_tab_id`;
 * - a toggle that cannot be injected (`chrome://settings`) → `toggle_failed`;
 * - a mount whose injection throws → `mount_failed`.
 */
import { describe, expect, it } from "vitest";

import type { WorkerOutcome, WorkerReply } from "../../extension/src/bridge-messages";
import { dispatchTabMessage, type DispatchHooks } from "../../extension/src/tab-binding";

const OWN = "own-extension-id";

function hooks(outcome: WorkerOutcome): DispatchHooks {
  return {
    mount: async () => outcome,
    toggle: async () => outcome,
  };
}

function failingToggle(error: string): DispatchHooks {
  return {
    mount: async () => ({ kind: "mount", ok: true }),
    toggle: async () => ({ kind: "toggle", ok: false, error }),
  };
}

describe("invalid tab ids are a named reply, not an injection (AC-B38)", () => {
  it.each([0, -1, "1", 1.5])("answers tabId %s with invalid_tab_id", async (tabId) => {
    const reply = await dispatchTabMessage(
      {
        message: { type: "bluepencil:mount", tabId },
        sender: { id: OWN },
        ownExtensionId: OWN,
      },
      hooks({ kind: "mount", ok: true }),
    );

    expect(reply).toMatchObject({ ok: false, code: "invalid_tab_id" });
    expect(reply.ok === false && reply.error.length > 0).toBe(true);
  });
});

describe("a page that refuses injection becomes a named failure (AC-B38)", () => {
  it("maps a refused toggle on chrome://settings to toggle_failed", async () => {
    const reply = await dispatchTabMessage(
      {
        message: { type: "bluepencil:toggle" },
        sender: { tab: { id: 7 } },
        ownExtensionId: OWN,
      },
      failingToggle("Cannot access a chrome:// URL"),
    );

    expect(reply).toEqual({
      ok: false,
      code: "toggle_failed",
      error: "Cannot access a chrome:// URL",
    });
  });

  it("maps a mount whose executeScript rejects to mount_failed", async () => {
    const reply = await dispatchTabMessage(
      {
        message: { type: "bluepencil:mount" },
        sender: { tab: { id: 7 } },
        ownExtensionId: OWN,
      },
      {
        mount: async () => {
          throw new Error("Cannot access a chrome:// URL");
        },
        toggle: async () => ({ kind: "toggle", ok: true }),
      },
    );

    expect(reply).toEqual({
      ok: false,
      code: "mount_failed",
      error: "Cannot access a chrome:// URL",
    });
  });

  it("maps a throwing toggle to toggle_failed instead of rejecting", async () => {
    const reply = await dispatchTabMessage(
      {
        message: { type: "bluepencil:toggle", enabled: false },
        sender: { tab: { id: 7 } },
        ownExtensionId: OWN,
      },
      {
        mount: async () => ({ kind: "mount", ok: true }),
        toggle: async () => {
          throw new Error("the message port closed");
        },
      },
    );

    expect(reply).toEqual({
      ok: false,
      code: "toggle_failed",
      error: "the message port closed",
    });
  });
});

describe("the dispatch boundary resolves for every input (AC-B38)", () => {
  it("never rejects, whatever the message or sender looks like", async () => {
    const inputs: {
      message: unknown;
      sender: { id?: string; tab?: { id?: number; url?: string } } | undefined;
    }[] = [
      { message: null, sender: undefined },
      { message: 42, sender: { id: OWN } },
      { message: [], sender: { id: OWN } },
      { message: { type: "bluepencil:mount" }, sender: { id: "foreign" } },
      { message: { type: "bluepencil:toggle", tabId: 0 }, sender: { id: OWN } },
      { message: { type: "bluepencil:mount" }, sender: { tab: { id: 7 } } },
      { message: { type: "bluepencil:toggle" }, sender: { tab: { id: Number.NaN } } },
    ];

    for (const input of inputs) {
      let reply: WorkerReply | undefined;
      await expect(
        (async () => {
          reply = await dispatchTabMessage({ ...input, ownExtensionId: OWN }, hooks({
            kind: "mount",
            ok: false,
            error: "refused",
          }));
        })(),
      ).resolves.toBeUndefined();
      expect(reply).toBeDefined();
      expect(typeof reply === "object" && reply !== null && "ok" in reply).toBe(true);
    }
  });
});
