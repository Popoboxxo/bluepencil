/**
 * The mount sequence (B.5) — the worker's one owner of `mountOnTab` and of the settings reader.
 *
 * Three things live here and nowhere else:
 *
 * 1. **`readSettings`** — the single settings reader (`SETTINGS_KEY`, `normalizeSettings`,
 *    default fallback). `sw.ts` imports it; it does not keep a second copy. The graph stays
 *    `sw → mount → settings`, acyclic: this module never imports from `./sw`.
 *
 * 2. **`runMountStep`** — exactly one injection. It cannot decide the order and cannot loop; that
 *    keeps "which step failed" answerable instead of "the mount failed somewhere".
 *
 * 3. **`mountOnTab`** — `readSettings` → `planMount` → `runMountStep` for each step, with the
 *    **whole** sequence in one `try/catch`. Every one of the three `executeScript` calls therefore
 *    ends in `{ ok: false, error }` instead of a rejection: a `chrome://` tab refuses injection at
 *    each of the three steps, and a user whose toolbar click hits one must see a message, not a
 *    silent `unhandledrejection` in the worker console (CQ-06).
 *
 * The module is injectable through `MountDeps`: the worker passes the browser's own
 * `chrome.scripting.executeScript`, tests pass a recorder. The production defaults are the browser
 * APIs; nothing else about the sequence changes between the two.
 */
import { planMount, type MountStep, type PageConfig } from "./mount-plan";
import { DEFAULT_SETTINGS, normalizeSettings, type ExtensionSettings } from "./settings";

/** What a mount answers. `{ ok: false }` always carries a message a caller can show or log. */
export interface MountResult {
  ok: boolean;
  tabUrl?: string;
  error?: string;
}

/**
 * The three injection shapes, modelled separately because they are not interchangeable.
 *
 * Chrome has two overloads and they differ in more than the payload: a file injection names
 * `files`, a function injection names `func`/`args`. Collapsing them into one shape would force a
 * cast at exactly the place where the distinction is the point of the type.
 */
export type MountInjection =
  | { target: { tabId: number }; files: string[]; injectImmediately: true }
  | { target: { tabId: number }; files: string[]; world: "MAIN"; injectImmediately: true }
  | {
      target: { tabId: number };
      world: "MAIN";
      func: (...args: never[]) => void;
      args: unknown[];
      injectImmediately: boolean;
    };

/** The seams `mountOnTab` needs. Each default is the real browser path (see `resolveDeps`). */
export interface MountDeps {
  readSettings(): Promise<ExtensionSettings>;
  executeScript(injection: MountInjection): Promise<unknown[]>;
  handoff(config: PageConfig): void;
}

const SETTINGS_KEY = "bluepencil:settings";

// Declared instead of imported: the extension's sources declare the few members they use, so the
// worker can be typechecked without `@types/chrome` (see extension/tsconfig.json).
declare const chrome: {
  storage: { local: { get(key: string): Promise<Record<string, unknown>> } };
  scripting: { executeScript(injection: MountInjection): Promise<unknown[]> };
};

/**
 * Read the settings, falling back to defaults when the user has never opened the options page.
 *
 * The fallback is not an error path: `chrome.storage.local.get` answers `{}` for a key that was
 * never written, and a worker that treated that as a failure could not mount at all on a fresh
 * install. A throw (storage unavailable, a storage area that refuses) ends in the same defaults for
 * the same reason — the layer's own defaults are the documented local-first baseline.
 */
export async function readSettings(): Promise<ExtensionSettings> {
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

/**
 * The MAIN-world handoff.
 *
 * This carries **data only** — the settings. It does not evaluate anything, and it cannot: the page's
 * CSP refuses string evaluation outright ("'unsafe-eval' is not an allowed source of script:
 * script-src 'self'"), and it does so regardless of how the string arrived. The element's own code
 * travels bundled inside the injected `bootstrap.js`.
 *
 * Passing a plain object is neither evaluation nor a fetch: it is the documented way to hand
 * arguments to an injected function, and MV3's no-remote-code rule is untouched because no code
 * crosses this boundary at runtime.
 *
 * The body must stay self-contained: it is serialised and evaluated in the page, where module scope
 * does not exist.
 */
export function mainWorldHandoff(config: PageConfig): void {
  const g = globalThis as Record<string, unknown>;
  g.__bluepencilConfig__ = { settings: config.settings, tabUrl: config.tabUrl };
  // The bootstrap has not necessarily seen this document (an already-open tab), so it is woken
  // through its own hook instead of being injected again. A *successful* mount is final and is
  // skipped; a stand-aside for a host embed (#70) leaves the guard unset, so a forced activation
  // still reaches the bootstrap — and the force is handed to it, not inferred here.
  if (g.__bluepencilMounted === true) return;
  const w = g as { __bluepencilTryMount?: (options?: { force?: boolean }) => void };
  if (typeof w.__bluepencilTryMount === "function") {
    w.__bluepencilTryMount(config.force ? { force: true } : undefined);
  }
}

/**
 * The production seam for the handoff.
 *
 * The real write happens **in the page**, through the function injection of the config step; this
 * local default is deliberately inert. It exists so `MountDeps.handoff` has a default at all: a test
 * supplies its own to record the `PageConfig`, and the worker must not also run the handoff in its
 * own global scope (that would write `__bluepencilConfig__` into the service worker).
 */
const noopHandoff = (): void => undefined;

/**
 * Execute exactly one step.
 *
 * Failures are returned, never thrown: the caller decides what a failed step means for the mount as
 * a whole, and it does so in one place (`mountOnTab`).
 */
export async function runMountStep(
  step: MountStep,
  tabId: number,
  config: PageConfig,
  deps: MountDeps,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    switch (step.kind) {
      case "bridge":
        // The bridge runs in the tab's isolated world and is what relays messages between the page
        // and the worker. Injected rather than declared in `content_scripts`, because access is
        // granted per tab — a declared content script would run on every page the user visits,
        // which is what `activeTab` exists to avoid.
        await deps.executeScript({
          target: { tabId },
          files: ["bridge.js"],
          injectImmediately: true,
        });
        return { ok: true };
      case "bootstrap":
        // The element can only be registered in the page's MAIN world; the isolated world's
        // `customElements` is `null` (measured, see #32). A second run in an already-mounted
        // document is a no-op because the bootstrap's own guard checks `__bluepencilMounted`.
        await deps.executeScript({
          target: { tabId },
          files: ["bootstrap.js"],
          world: "MAIN",
          injectImmediately: true,
        });
        return { ok: true };
      case "config":
        // Only now: the config is written and the bootstrap's hook woken, after the script that
        // reads both is demonstrably in the page.
        await deps.executeScript({
          target: { tabId },
          world: "MAIN",
          func: mainWorldHandoff,
          args: [config],
          injectImmediately: true,
        });
        // The observation seam (see `noopHandoff`): inert in production, recorded by tests.
        deps.handoff(config);
        return { ok: true };
    }
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/** A failure a caller can show: an `Error`'s message, or the string form of whatever was thrown. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fill the missing seams with the browser's own implementations.
 *
 * `executeScript` is read from `chrome` lazily, inside the returned closure, so importing this
 * module never touches `chrome`: a unit test that injects all three deps runs without a browser.
 */
function resolveDeps(deps: Partial<MountDeps>): MountDeps {
  return {
    readSettings: deps.readSettings ?? readSettings,
    executeScript: deps.executeScript ?? ((injection) => chrome.scripting.executeScript(injection)),
    handoff: deps.handoff ?? noopHandoff,
  };
}

/**
 * Inject the review layer into one tab.
 *
 * `tabUrl` is best-effort and may be empty, and that is not a problem: until the user has granted
 * `activeTab` by clicking, `chrome.tabs` reports every field of a tab except `url` and `title`
 * (measured: `id`, `index`, `status`, `width` … all present, `url` absent). The tab id is what this
 * function actually needs, and the click handler already has it — so the URL is used for the note's
 * provenance when it happens to be there and simply stays empty when it is not.
 *
 * **Never throws.** `readSettings`, `planMount` and every `executeScript` call are inside one
 * `try/catch`; a page that forbids injection (`chrome://settings`, the Chrome Web Store, a PDF
 * viewer) answers `{ ok: false, error }` at whichever step refuses, and both callers — the toolbar
 * button and the keyboard command — can pass that back to the user.
 */
export async function mountOnTab(
  tabId: number,
  tabUrl: string = "",
  options: { force?: boolean } = {},
  deps: Partial<MountDeps> = {},
): Promise<MountResult> {
  try {
    const resolved = resolveDeps(deps);
    const settings = await resolved.readSettings();
    const { steps, config } = planMount({ settings, tabUrl, force: options.force === true });
    for (const step of steps) {
      const result = await runMountStep(step, tabId, config, resolved);
      if (!result.ok) return { ok: false, error: result.error };
    }
    return { ok: true, tabUrl };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}
