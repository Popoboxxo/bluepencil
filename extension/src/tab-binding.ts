/**
 * Which tab a worker message is allowed to act on, and the one dispatch that acts on it (B.5).
 *
 * The bridge channel is open to every script on a page, so a page can ask the worker to mount or
 * toggle — but it must only ever reach **its own** tab. The rule that makes that true is structural,
 * not a check the page could win: `sender.tab.id` is filled in by the browser for a content-script
 * sender and cannot be forged from the page, so it always wins. A message that names some other tab
 * in `tabId` is not a second target; it is ignored on every sender that already has a tab.
 *
 * `chrome.tabs.query({active, currentWindow})` is deliberately **absent** here. Looking up "the
 * active tab" is only correct immediately after a gesture (toolbar click, keyboard command), because
 * the gesture is what grants `activeTab` for that tab. A message handler that used the query would
 * act on whichever tab happens to be in front — which is exactly the background-tab attack: tab A
 * asks, tab B gets mounted. The two gesture sites keep the query; this module never needs it.
 *
 * Extension pages (the options page, the review page) have no `sender.tab`. They may name a target
 * explicitly, but only while `sender.id` is this extension's own id — a foreign sender has no tab to
 * act on and is refused by name (`foreign_sender`), never silently mapped to a tab.
 *
 * The module is pure: it imports types and the reply mapper, and touches no browser API. That is
 * what lets the dispatch be unit-tested without a worker and what makes "the dispatch cannot call
 * `chrome.tabs.query`" a property of the module rather than a convention.
 */
import { toWorkerReply, type WorkerOutcome, type WorkerReply } from "./bridge-messages";

/** The shape of a `chrome.runtime.onMessage` sender that this module needs. */
export interface MessageSenderLike {
  id?: string;
  tab?: { id?: number; url?: string };
}

/**
 * The resolved target of a mount/toggle message.
 *
 * - `sender` — a content script's own tab; `tabUrl` comes from `sender.tab.url` and may be empty.
 * - `explicit` — an extension page named a tab and is allowed to.
 * - `none` — nothing may be acted on; the code says why.
 */
export type TabTarget =
  | { kind: "sender"; tabId: number; tabUrl: string }
  | { kind: "explicit"; tabId: number }
  | { kind: "none"; code: "no_tab" | "invalid_tab_id" | "foreign_sender" };

/** The effects `dispatchTabMessage` may trigger. It knows nothing about how they are carried out. */
export interface DispatchHooks {
  mount(tabId: number, tabUrl: string, options: { force?: boolean }): Promise<WorkerOutcome>;
  toggle(tabId: number, enabled: boolean): Promise<WorkerOutcome>;
}

const MOUNT_TYPE = "bluepencil:mount";
const TOGGLE_TYPE = "bluepencil:toggle";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A usable tab id is a positive whole number.
 *
 * Chrome ids start at 1. `0`, `-1`, a numeric string (`"1"`) and a fraction (`1.5`) are all
 * "something was sent", not "a tab exists"; treating them as truthy is how a caller lands on a
 * tab-less injection instead of a named refusal (AC-B38).
 */
function isTabId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Resolve which tab a message is allowed to act on (SEC-15, AC-B27).
 *
 * Order matters and is the security property:
 *
 * 1. a sender with a `tab` acts on that tab, whatever the message names — the browser set the id,
 *    the page cannot;
 * 2. a sender without a `tab` is only trusted when `sender.id` is this extension's own id; a
 *    foreign or anonymous sender is `foreign_sender` even when it names a plausible tab;
 * 3. an own extension page without `tabId` has no target (`no_tab`);
 * 4. an own extension page with a non-positive/non-integer `tabId` has an invalid target
 *    (`invalid_tab_id`).
 *
 * A `tab` present but without a usable id cannot be addressed either; it is `invalid_tab_id`
 * rather than a fall-through to the explicit path, so a browser-provided sender is never
 * reinterpreted as an extension page.
 */
export function resolveTabTarget(
  sender: MessageSenderLike | undefined,
  message: { type?: unknown; tabId?: unknown },
  ownExtensionId: string,
): TabTarget {
  const tab = sender?.tab;
  if (tab !== undefined) {
    if (!isTabId(tab.id)) return { kind: "none", code: "invalid_tab_id" };
    return {
      kind: "sender",
      tabId: tab.id,
      tabUrl: typeof tab.url === "string" ? tab.url : "",
    };
  }

  // No tab: only our own extension pages may name one. A missing id is as foreign as a wrong one.
  if (sender?.id !== ownExtensionId) return { kind: "none", code: "foreign_sender" };

  const tabId = message.tabId;
  if (tabId === undefined) return { kind: "none", code: "no_tab" };
  if (!isTabId(tabId)) return { kind: "none", code: "invalid_tab_id" };
  return { kind: "explicit", tabId };
}

const REFUSAL_TEXT: Record<"no_tab" | "invalid_tab_id" | "foreign_sender", string> = {
  no_tab: "the request does not name a tab",
  invalid_tab_id: "tabId must be a positive integer",
  foreign_sender: "the message did not come from this extension",
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The single translation from a mount/toggle message to an effect (AC-B22/AC-B23/AC-B48).
 *
 * It resolves the target once and calls exactly one hook. A refusal and a hook failure both leave
 * as a `WorkerReply` — never as a rejection — so the worker can answer a caller even when the page
 * refuses injection (`chrome://settings`) or the hook itself throws (AC-B38).
 *
 * The worker's listener routes only the two control kinds here; any other shape is answered as a
 * refusal so this function stays total, but that path is unreachable from `sw.ts`.
 */
export async function dispatchTabMessage(
  input: { message: unknown; sender: MessageSenderLike | undefined; ownExtensionId: string },
  hooks: DispatchHooks,
): Promise<WorkerReply> {
  const message = isRecord(input.message) ? input.message : {};
  const target = resolveTabTarget(
    input.sender,
    { type: message.type, tabId: message.tabId },
    input.ownExtensionId,
  );
  if (target.kind === "none") {
    return toWorkerReply({
      kind: "refused",
      code: target.code,
      error: REFUSAL_TEXT[target.code],
    });
  }

  if (message.type === TOGGLE_TYPE) {
    // Absent means "switch on", exactly as before: the page's `toggle` envelope allows it.
    const enabled = typeof message.enabled === "boolean" ? message.enabled : true;
    try {
      return toWorkerReply(await hooks.toggle(target.tabId, enabled));
    } catch (error) {
      return toWorkerReply({ kind: "toggle", ok: false, enabled, error: messageOf(error) });
    }
  }

  if (message.type === MOUNT_TYPE) {
    const force = message.force === true;
    // Only a content-script sender has a URL the browser vouched for; an explicit extension-page
    // request carries none, and the page's own route stays the note provenance anyway.
    const tabUrl = target.kind === "sender" ? target.tabUrl : "";
    try {
      return toWorkerReply(
        await hooks.mount(target.tabId, tabUrl, force ? { force: true } : {}),
      );
    } catch (error) {
      return toWorkerReply({ kind: "mount", ok: false, tabUrl, error: messageOf(error) });
    }
  }

  return toWorkerReply({
    kind: "refused",
    code: "no_tab",
    error: `the worker only dispatches ${MOUNT_TYPE} and ${TOGGLE_TYPE}`,
  });
}
