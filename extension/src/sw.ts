/**
 * Service worker — the extension's entry point (#34).
 *
 * Three responsibilities, deliberately kept small:
 *
 * 1. **Inject the layer on demand.** The user asks for access to a page (toolbar click, keyboard
 *    shortcut) and the injection happens under `activeTab`, so the grant expires when they leave.
 *    There is **no** persistent content-script registration: the manifest asks for the http/https
 *    hosts only as *optional* permissions (`optional_host_permissions`), granted for the hub origin
 *    the user configured, and a fresh document has no config and no overlay until the user invokes
 *    the extension again (SEC-20, AC-B18, AC-B56).
 *
 * 2. **Run it in the page's MAIN world.** Chromium's isolated content-script world reports
 *    `customElements === null` (measured: `typeof` is `"object"`, the value is `null`), so
 *    `defineBluepencilElement()` cannot register the custom element there — see #32. The element
 *    therefore has to be evaluated in the page itself, where the registry is real. The isolated
 *    world stays in the picture only as the bridge that carries the response back.
 *
 * 3. **Own the store configuration.** The layer runs in the page, so it cannot read
 *    `chrome.storage` itself. The worker resolves the configuration and hands it to the page
 *    through a `postMessage` handshake; `content-bridge.js` relays it.
 *
 * 4. **Relay hub requests (#116).** A page's `connect-src` governs the layer's `fetch`, so a strict
 *    policy silently blocks note sync. The page registers a transport that sends the request here;
 *    `hub-fetch.ts` validates it (configured origin and base path only, GET/POST/PATCH, a header
 *    allowlist, no cookies, no redirects, a timeout), checks the optional host grant
 *    (`permission_missing` before any `fetch`) and attaches the credential header itself
 *    (`authHeadersFor`). The page never holds or sends a credential (SEC-14, AC-B13/14/20).
 *    The worker — not the bridge — is the trust boundary.
 *
 * The worker holds no state between events. A MV3 service worker is terminated aggressively, so
 * anything that must survive a restart has to live in `chrome.storage`, not in a module variable.
 */

import type { WorkerOutcome } from "./bridge-messages";
import { hubFetchPolicy, refuse, runHubRequest, validateHubRequest } from "./hub-fetch";
import { mountOnTab, readSettings } from "./mount";
import { dispatchTabMessage, type DispatchHooks } from "./tab-binding";

/**
 * Publish the worker's own entry points on its global scope.
 *
 * A MV3 service worker cannot `import()` its own module (measured: "import() is disallowed on
 * ServiceWorkerGlobalScope by the HTML specification"), and it does not receive messages it sends
 * itself ("Receiving end does not exist"). Without this handle, the only way to invoke `mountOnTab`
 * from a test is a real toolbar click, which a headless browser cannot produce — so the mount
 * function would be unreachable in CI while working perfectly for a user.
 *
 * It is a test seam, and it is deliberately inert: nothing in the extension reads it, and it grants
 * no capability that `chrome.scripting` does not already require a permission for.
 */
declare const self: {
  __bluepencilModule?: { mountOnTab: typeof mountOnTab };
};

self.__bluepencilModule = { mountOnTab };

/**
 * The badge text shown when the page already carries the layer itself (#70). Four characters is the
 * most Chrome will fit in a toolbar badge without trimming.
 */
const HOST_EMBED_BADGE = "host";

/**
 * Mark a tab whose page embeds Bluepencil on its own (#70).
 *
 * A click that mounts nothing must not look like a broken extension: the badge says the extension
 * stepped aside, and the title names the shape that was found and how to run alongside it anyway.
 * A failure here is swallowed — a badge is a courtesy, and a tab that can no longer be addressed must
 * not turn an otherwise-informed step-aside into an error.
 */
async function markHostEmbed(tabId: number | undefined, host: string): Promise<void> {
  if (tabId === undefined) return;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });
    await chrome.action.setBadgeText({ tabId, text: HOST_EMBED_BADGE });
    await chrome.action.setTitle({
      tabId,
      title: `Bluepencil — this page already embeds it (${host}); switch on "also load" in the options to run alongside`,
    });
  } catch {
    // Ignored on purpose: see above.
  }
}

/** Take the host-embed badge back off, once the layer is up (#70). */
async function clearHostEmbed(tabId: number | undefined): Promise<void> {
  if (tabId === undefined) return;
  try {
    await chrome.action.setBadgeText({ tabId, text: "" });
    // An empty title restores the manifest's own `default_title`.
    await chrome.action.setTitle({ tabId, title: "" });
  } catch {
    // Ignored on purpose: see markHostEmbed.
  }
}

/**
 * Switch the layer in one tab, as a `WorkerOutcome` instead of a raw reply.
 *
 * A `chrome://` page refuses the injection, and that must reach the caller as `toggle_failed`
 * rather than as a rejection in the worker console (AC-B38). Anything else is a success: whether the
 * page actually carried the element is reported by `mainWorldToggle` through the bridge, which is
 * the channel that can observe the page.
 */
async function toggleOnTab(tabId: number, enabled: boolean): Promise<WorkerOutcome> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: mainWorldToggle,
      args: [enabled],
      injectImmediately: true,
    });
    return { kind: "toggle", ok: true, enabled };
  } catch (error) {
    return {
      kind: "toggle",
      ok: false,
      enabled,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The two effects the dispatcher may trigger.
 *
 * They live here because the browser APIs do; `tab-binding.ts` stays pure and cannot look up a tab
 * on its own. `mount` is the same `mountOnTab` the toolbar and command paths call — there is no
 * registration in front of it any more (SEC-20).
 */
const dispatchHooks: DispatchHooks = {
  async mount(tabId, tabUrl, options) {
    const result = await mountOnTab(tabId, tabUrl, options);
    return { kind: "mount", ok: result.ok, tabUrl: result.tabUrl, error: result.error };
  },
  toggle: toggleOnTab,
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (typeof message !== "object" || message === null) return false;
  const { type } = message as { type?: unknown };

  // The page's MAIN world reports, through the bridge, that it already embeds the layer and did not
  // mount (#70). The badge is how the user learns why the click did nothing. It arrives from a content
  // script, so `sender.tab` is the tab the report is about.
  if (type === "bluepencil:host-embed") {
    const host =
      typeof (message as { host?: unknown }).host === "string"
        ? (message as { host: string }).host
        : "host embed";
    void markHostEmbed(sender?.tab?.id, host);
    return false;
  }
  // A mount or toggle that *succeeded* means any host-embed badge is stale: the layer is up now, or
  // the user switched it, and the "step aside" state no longer describes the tab. The message shape
  // the bridge sends carries the outcome in `ok`; a failure (`ok: false` — a mount error, or a toggle
  // on a page with no layer) must leave the badge in place, because it still says why nothing is up.
  // Only a reported success clears it.
  if (type === "bluepencil:mounted") {
    if ((message as { ok?: unknown }).ok === true) void clearHostEmbed(sender?.tab?.id);
    return false;
  }

  // The hub relay (#116). The layer's `fetch` runs in the page and is therefore subject to the
  // document's CSP; a strict `connect-src` blocks every hub call. This worker is outside that policy
  // and already holds the host permission, so the page's request is performed here instead.
  //
  // This is the trust boundary: the bridge is unauthenticated and any page script can post the
  // envelope, so *every* rule (target, method, headers, sizes) is enforced by `validateHubRequest`.
  // The settings are read per message, never cached: an endpoint changed in the options page must
  // take effect on the next request, and a MV3 worker is torn down between events anyway.
  if (type === "bluepencil:fetch") {
    if (sender?.tab?.id === undefined) {
      sendResponse(refuse("invalid_request", "the relay request did not come from a tab"));
      return false;
    }
    const request = (message as { request?: unknown }).request;
    void (async () => {
      try {
        const settings = await readSettings();
        const policy = hubFetchPolicy(settings.endpoint);
        const validated = validateHubRequest(request, policy);
        if (!validated.ok) {
          sendResponse(validated);
          return;
        }
        // Both deps are real, and the credential is attached here — the page never saw it. The
        // endpoint is the settings value read for this message; `contains` is Chrome's own check.
        sendResponse(
          await runHubRequest(validated.request, policy, {
            endpoint: () => settings.endpoint,
            permissions: {
              contains: (pattern) => chrome.permissions.contains({ origins: [pattern] }),
            },
            credential: () => ({ auth: settings.auth, token: settings.token }),
          }),
        );
      } catch (error) {
        sendResponse(
          refuse("network", error instanceof Error ? error.message : "the relay request failed"),
        );
      }
    })();
    // The answer is asynchronous; keep the message channel open.
    return true;
  }

  // `bluepencil:mount` and `bluepencil:toggle` are the one dispatch path (B.5). The sender's own tab
  // wins; the lookup of "the active tab" is deliberately absent here, because it would let a
  // background tab act on whichever tab is in front (SEC-15). Only a gesture may address the
  // active tab: the toolbar click already receives it from the browser, and the keyboard command
  // looks it up in its own handler below.
  if (type !== "bluepencil:mount" && type !== "bluepencil:toggle") return false;

  void dispatchTabMessage(
    { message, sender, ownExtensionId: chrome.runtime.id },
    dispatchHooks,
  )
    .then(sendResponse)
    .catch(() => undefined);
  // Keeps the message channel open for the async response.
  return true;
});

// The toolbar button is the primary entry point: one click grants access to this tab and mounts.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  // The click is what grants `activeTab`, so `tab.url` is readable here even though it is not
  // before. Passing it through means the notes carry their source page.
  // The result is the answer: a refused injection resolves to `{ ok: false, error }` instead of
  // rejecting, so there is no promise to catch here. The visible failure path is the page's report
  // and badge (#70), not the gesture.
  void mountOnTab(tab.id, tab.url ?? "");
});

/**
 * Turn the layer off again, on the page that has it.
 *
 * The element's own contract is the `enabled` attribute (FR-12.1/12.2), so switching off is setting
 * that to `false` rather than tearing the element out: `disable()` is idempotent and leaves the note
 * set intact, and the bar can be brought back without another injection. Removing the element would
 * also work and would be simpler, but it would discard the note state a user has open.
 *
 * The MAIN world is needed because that is where the element lives — the same isolation gap #34
 * documented, and the same reason the mount path cannot use the isolated world.
 */
function mainWorldToggle(enabled: boolean): void {
  const el = document.querySelector("bluepencil-notes");
  const found = el !== null;
  if (found) el.setAttribute("enabled", enabled ? "true" : "false");
  // The same channel the mount reports on, so a caller (or the smoke test) sees both outcomes the
  // same way instead of having to know which path produced the answer.
  window.postMessage(
    {
      source: "bluepencil-extension",
      kind: "toggled",
      ok: found,
      enabled,
      error: found ? undefined : "the layer is not on this page",
    },
    window.location.origin === "null" ? "*" : window.location.origin,
  );
}

chrome.commands.onCommand.addListener((command) => {
  if (command !== "toggle-bluepencil" && command !== "_execute_action") return;
  void chrome.tabs.query({ active: true, currentWindow: true }).then(async (tabs) => {
    const tab = tabs[0];
    if (tab?.id === undefined) return;
    // A keyboard command grants `activeTab` for the current tab as well, so the same path applies.
    // The call resolves even when the mount is refused; there is nothing to catch.
    await mountOnTab(tab.id, tab.url ?? "");
  });
});

// Declared for the type checker; the object itself is provided by the extension host.
//
// `url` is declared because the calls below still read `tab.url` and pass it to
// `mountOnTab`, where it feeds the `tabUrl` field of the mount configuration. Nothing
// consumes that field: the page a note belongs to comes from the element's own `route="url"`, which
// reads the page's `location.href`. So the `tabs` permission is deliberately NOT requested — the
// active tab's URL is readable under the `activeTab` grant the click itself makes, and the query /
// `tab.id` never needed a permission at all. Re-adding `tabs` would be an extra permission for data nothing
// reads; `npm run smoke:webstore` fails if it comes back.
declare const chrome: {
  runtime: {
    /** This extension's own id; an extension page is recognised by it, a foreign sender is not. */
    id: string;
    getURL(path: string): string;
    onMessage: {
      addListener(
        cb: (
          message: unknown,
          sender: { id?: string; tab?: { id?: number; url?: string } },
          sendResponse: (r: unknown) => void,
        ) => boolean,
      ): void;
    };
  };
  action: {
    onClicked: { addListener(cb: (tab: { id?: number; url?: string }) => void): void };
    setBadgeText(details: { tabId?: number; text: string }): Promise<void>;
    setBadgeBackgroundColor(details: { color: string }): Promise<void>;
    setTitle(details: { tabId?: number; title: string }): Promise<void>;
  };
  commands: { onCommand: { addListener(cb: (command: string) => void): void } };
  tabs: { query(info: { active: boolean; currentWindow: boolean }): Promise<{ id?: number; url?: string }[]> };
  scripting: {
    // Only the function injection is still used here (the toggle); the file injections of the mount
    // sequence belong to `mount.ts`, which owns its own `MountInjection` union. A second declaration
    // of the file shapes would be a second place to keep them right.
    executeScript(injection: {
      target: { tabId: number };
      world: "MAIN";
      func: (...args: never[]) => void;
      args: unknown[];
      injectImmediately: boolean;
    }): Promise<unknown[]>;
  };
  // The optional host grant (`optional_host_permissions`). No content-script registration API is
  // declared: the boundary commit deleted the persistent registration (SEC-20, AC-B56).
  permissions: {
    contains(details: { origins: string[] }): Promise<boolean>;
  };
};
