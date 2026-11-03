/**
 * The mount plan — which scripts are injected, in which order, and what the page is told (B.4).
 *
 * The order is a contract, not an implementation detail. The bridge runs in the tab's isolated world
 * and is what relays messages between the page and the worker; the bootstrap runs in the page's MAIN
 * world and is where the element's registry actually exists; only after both may the config write
 * `__bluepencilConfig__` and wake `__bluepencilTryMount`. Writing the config first would hand it to a
 * document that has no hook listening for it yet, and the click would silently mount nothing.
 *
 * There is no persistent registration in this plan: `chrome.scripting.registerContentScripts` is not
 * part of it (that call is removed in B.3b), so a fresh document has no layer until the user invokes
 * the extension again — which is exactly what `activeTab` is for.
 *
 * This module is pure: no `chrome.*`, no DOM, no injection. It decides the sequence; `mount.ts`
 * executes it; `tests/unit/extension-mount-execution.test.ts` observes it.
 */
import { pageSettingsFor, type PageSettings } from "./handoff";
import type { ExtensionSettings } from "./settings";

/** One step of the injection sequence. The names are the file names, minus the extension. */
export type MountStep = { kind: "bridge" } | { kind: "bootstrap" } | { kind: "config" };

/**
 * What the page is told, and what the injected function receives.
 *
 * `settings` is the page-facing projection (`PageSettings`), never the worker's own settings: the
 * credential, its expiry and the device name belong to the extension and have no business in the
 * page (SEC-14).
 */
export interface PageConfig {
  settings: PageSettings;
  tabUrl: string;
  force: boolean;
}

/** The plan for one mount: the three steps, in order, and the configuration to hand over. */
export interface MountPlan {
  steps: MountStep[];
  config: PageConfig;
}

/**
 * Build the plan for one mount.
 *
 * A fresh array is returned per call rather than a shared constant: the caller owns the sequence it
 * executes, and a mutable module-level array would let one caller's edit leak into the next mount.
 */
export function planMount(input: {
  settings: ExtensionSettings;
  tabUrl: string;
  force: boolean;
}): MountPlan {
  return {
    steps: [{ kind: "bridge" }, { kind: "bootstrap" }, { kind: "config" }],
    config: {
      settings: pageSettingsFor(input.settings),
      tabUrl: input.tabUrl,
      // A truthy-but-not-`true` value is not a force. The element's contract is a boolean, and a
      // hand-rolled `"true"` must not turn a step-aside (#70) into a double overlay.
      force: input.force === true,
    },
  };
}
