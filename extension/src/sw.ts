/**
 * Service worker — the extension's entry point (#34).
 *
 * Three responsibilities, deliberately kept small:
 *
 * 1. **Inject the layer on demand.** `activeTab` rather than a permanent `<all_urls>` host
 *    permission: the user grants access to a page by asking for it (toolbar click, keyboard
 *    shortcut), and the grant expires when they leave. A permanently-installed content script with
 *    `<all_urls>` has to justify itself in the Web Store review; an on-demand injection does not.
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
 * The worker holds no state between events. A MV3 service worker is terminated aggressively, so
 * anything that must survive a restart has to live in `chrome.storage`, not in a module variable.
 */

import { DEFAULT_SETTINGS, normalizeSettings, type ExtensionSettings } from "./settings";

const SETTINGS_KEY = "bluepencil:settings";

/** Where the built element bundle lives inside the extension. */
const ELEMENT_FILE = "bluepencil.element.iife.js";

/** Id of the registered MAIN-world content script; re-registering the same id is an error. */
const BOOTSTRAP_ID = "bluepencil-bootstrap";

/**
 * The MAIN-world handoff.
 *
 * This carries **data only** — the settings. It does not evaluate anything, and it cannot: the page's
 * CSP refuses string evaluation outright ("'unsafe-eval' is not an allowed source of script:
 * script-src 'self'"), and it does so regardless of how the string arrived. The element's own code
 * travels bundled inside the registered `bootstrap.js`, which Chrome loads as a static file into the
 * MAIN world.
 *
 * Passing a plain object is neither evaluation nor a fetch: it is the documented way to hand
 * arguments to an injected function, and MV3's no-remote-code rule is untouched because no code
 * crosses this boundary at runtime.
 */
function mainWorldHandoff(config: {
  settings: ExtensionSettings;
  tabUrl: string;
}): void {
  const g = globalThis as Record<string, unknown>;
  g.__bluepencilConfig__ = { settings: config.settings, tabUrl: config.tabUrl };
  // The registered bootstrap runs at document_start, so on an already-open tab it has not seen this
  // document. Waking it through its own hook avoids re-injecting the file, and the bootstrap's
  // `__bluepencilMounted` guard keeps a double wake harmless.
  if (g.__bluepencilMounted === true) return;
  const w = g as { __bluepencilTryMount?: () => void };
  if (typeof w.__bluepencilTryMount === "function") w.__bluepencilTryMount();
}

/** Read the settings, falling back to defaults when the user has never opened the options page. */
async function readSettings(): Promise<ExtensionSettings> {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const value = stored[SETTINGS_KEY];
    if (value === undefined || value === null || typeof value !== "object") {
      return { ...DEFAULT_SETTINGS };
    }
    // Merge rather than replace: a settings object written by an older version is missing keys,
    // and a missing key must not reset the rest of the user's configuration.
    return normalizeSettings(value);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export interface MountResult {
  ok: boolean;
  tabUrl?: string;
  error?: string;
}

/**
 * Inject the review layer into one tab.
 *
 * `tabUrl` is best-effort and may be empty, and that is not a problem: until the user has granted
 * `activeTab` by clicking, `chrome.tabs` reports every field of a tab except `url` and `title`
 * (measured: `id`, `index`, `status`, `width` … all present, `url` absent). The tab id is what this
 * function actually needs, and the click handler already has it — so the URL is used for the
 * note's provenance when it happens to be there and simply stays empty when it is not.
 *
 * Exported (rather than a bare listener) so the E2E suite can drive exactly this function against
 * a real Chrome, which is the only place the MAIN-world and `customElements` behaviour is real.
 */
// The registered bootstrap has to be in place before the handoff, or the page has nothing to pick
// the source up. Registration is idempotent — re-registering an existing id is an error, so the
// worker unregisters first and the failure is swallowed: if it is already registered, that is the
// state we wanted.
async function ensureBootstrapRegistered(): Promise<void> {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [BOOTSTRAP_ID] });
  } catch {
    // Not registered yet — the normal first-run case.
  }
  await chrome.scripting.registerContentScripts([
    {
      id: BOOTSTRAP_ID,
      matches: ["http://*/*", "https://*/*"],
      js: ["bootstrap.js"],
      runAt: "document_start",
      world: "MAIN",
      persistAcrossSessions: true,
    },
  ]);
}

export async function mountOnTab(tabId: number, tabUrl: string = ""): Promise<MountResult> {
  const settings = await readSettings();

  await ensureBootstrapRegistered();

  // The bridge runs in the isolated world of this tab and is what relays messages between the page
  // and the worker. It is injected here rather than declared in `content_scripts`, because access is
  // granted per tab — a declared content script would run on every page the user visits, which is
  // what `activeTab` exists to avoid. Injecting it in the same call as the layer keeps the two in
  // step: no bridge means no page-side request path.
  await chrome.scripting
    .executeScript({
      target: { tabId },
      files: ["bridge.js"],
      injectImmediately: true,
    })
    .catch(() => {
      // A page that forbids injection (a chrome:// document, for instance) cannot host the bridge.
      // The layer still mounts; only the page-side request path is missing.
    });

  // The registered bootstrap only runs on the *next* document, so an already-open tab has not seen
  // it. Injecting the file here as well covers that case; the bootstrap's own `__bluepencilMounted`
  // guard makes the double run a no-op.
  await chrome.scripting
    .executeScript({
      target: { tabId },
      files: ["bootstrap.js"],
      world: "MAIN",
      injectImmediately: true,
    })
    .catch(() => undefined);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: mainWorldHandoff,
    args: [{ settings, tabUrl }],
    injectImmediately: true,
  });

  const first = results[0];
  if (first === undefined) {
    return { ok: false, error: "the injection returned no result" };
  }
  return { ok: true, tabUrl };
}

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

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message !== "object" || message === null) return false;
  const { type } = message as { type?: unknown };
  if (type !== "bluepencil:mount") return false;

  void (async () => {
    try {
      // The active tab of the focused window — never a URL search. Before the user grants
      // `activeTab`, every tab's `url` reads as undefined, so matching on it would find nothing
      // and the extension would look broken. The tab id needs no permission; the URL does.
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (tab === undefined || tab.id === undefined) {
        sendResponse({ ok: false, error: "no active tab" });
        return;
      }
      sendResponse(await mountOnTab(tab.id, tab.url ?? ""));
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();
  // Keeps the message channel open for the async response.
  return true;
});

// The toolbar button is the primary entry point: one click grants access to this tab and mounts.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  // The click is what grants `activeTab`, so `tab.url` is readable here even though it is not
  // before. Passing it through means the notes carry their source page.
  void mountOnTab(tab.id, tab.url ?? "").catch(() => undefined);
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "toggle-bluepencil" && command !== "_execute_action") return;
  void chrome.tabs.query({ active: true, currentWindow: true }).then(async (tabs) => {
    const tab = tabs[0];
    if (tab?.id === undefined) return;
    // A keyboard command grants `activeTab` for the current tab as well, so the same path applies.
    await mountOnTab(tab.id, tab.url ?? "");
  });
});

// Declared for the type checker; the object itself is provided by the extension host.
declare const chrome: {
  runtime: {
    getURL(path: string): string;
    onMessage: {
      addListener(
        cb: (message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean,
      ): void;
    };
  };
  action: { onClicked: { addListener(cb: (tab: { id?: number; url?: string }) => void): void } };
  commands: { onCommand: { addListener(cb: (command: string) => void): void } };
  storage: { local: { get(key: string): Promise<Record<string, unknown>> } };
  tabs: { query(info: { active: boolean; currentWindow: boolean }): Promise<{ id?: number; url?: string }[]> };
  scripting: {
    // Chrome has two overloads and they are not interchangeable: a file injection and a function
    // injection differ in more than the payload. Modelling them as one shape would force the caller
    // to cast away exactly the distinction that matters here.
    executeScript(injection:
      | { target: { tabId: number }; world: "MAIN"; func: (arg: never) => void; args: unknown[];
          injectImmediately: boolean }
      | { target: { tabId: number }; files: string[]; injectImmediately: boolean }
      | { target: { tabId: number }; files: string[]; world: "MAIN"; injectImmediately: boolean }
    ): Promise<unknown[]>;
    // Registered content scripts are what get extension code into a page's MAIN world under a strict
    // CSP; `js` takes file names, never `{code}` objects (Chrome: "Invalid type: expected string,
    // found object").
    registerContentScripts(scripts: {
      id: string;
      matches: string[];
      js: string[];
      runAt: "document_start" | "document_end" | "document_idle";
      world: "MAIN" | "ISOLATED";
      persistAcrossSessions: boolean;
    }[]): Promise<void>;
    unregisterContentScripts(filter: { ids: string[] }): Promise<void>;
  };
};
