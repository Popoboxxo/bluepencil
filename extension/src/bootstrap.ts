/**
 * The registered MAIN-world content script — the layer's only way into a CSP-hard page.
 *
 * Everything else was measured and refused by Chrome 151:
 *
 *   - `import(chrome-extension://…)` from the page's world → "Failed to fetch dynamically imported
 *     module". A page may not load the extension's origin.
 *   - `new Function(source)` *anywhere* in the page's world → "Evaluating a string as JavaScript
 *     violates the following Content Security Policy directive because 'unsafe-eval' is not an
 *     allowed source of script: script-src 'self'". This includes source text handed over as a
 *     plain global, so the arrival channel does not matter — the page's CSP refuses it either way.
 *   - `import()` inside the service worker → "disallowed on ServiceWorkerGlobalScope".
 *
 * What works, and is what this file is: extension code that arrives as a **packaged file** runs in
 * the page's MAIN world even under a strict CSP. So the element bundle is not shipped as text to be
 * evaluated — it is bundled *into this file* at build time (see `extension/build.mjs`), which makes
 * the whole thing one static classic script. There is no `eval`, no `new Function`, no `import()`,
 * and no fetch of anything.
 *
 * That leaves exactly one channel for the worker, and it is deliberately a *data* channel: the
 * settings. The worker places them in the page, this file reads them, and the layer mounts. Code
 * crosses the boundary at install time, not at mount time.
 */
import { defineBluepencilElement } from "../../dist/bluepencil.element.js";

/** The settings for this mount, placed here by the worker. Absent until the user asks for the layer. */
const CONFIG_KEY = "__bluepencilConfig__";
/** Set once the layer is up, so a second injection in the same document is a no-op. */
const MOUNTED_KEY = "__bluepencilMounted";

interface MountConfig {
  settings: {
    environment: string;
    appName: string;
    language: string;
    store: string;
    identity: string;
    /** Sidecar base URL; only read when `store` is `http` (#36). */
    endpoint: string;
    /**
     * Which credential the sidecar expects. `token` is phase 2's signed token and goes out as
     * `Authorization: Bearer …`; `secret` is phase 1's shared secret in `x-bluepencil-auth`. The
     * two are different headers, so the field has to travel from settings to here rather than being
     * inferred — an inference would guess `secret` for a token and produce a 401 that looks like a
     * dead server.
     */
    auth: string;
    /** Shared secret or signed token; only read when `store` is `http` (#36). */
    token: string;
  };
  tabUrl: string;
}

type BpGlobal = typeof globalThis & {
  [CONFIG_KEY]?: MountConfig;
  [MOUNTED_KEY]?: boolean;
  /** Lets the worker wake this script on a tab that was already open. */
  __bluepencilTryMount?: () => void;
};

const g = globalThis as BpGlobal;

// A registered script runs on every matching document, whether or not the user asked for the layer.
// Doing nothing until the configuration arrives is what keeps that cheap and unobtrusive. The hook
// lets the worker wake it on an already-open tab, where the registration has not taken effect yet.
g.__bluepencilTryMount = mount;

if (g[MOUNTED_KEY] !== true && g[CONFIG_KEY] !== undefined) {
  mount();
}

function mount(): void {
  const config = g[CONFIG_KEY];
  if (config === undefined) return;
  if (g[MOUNTED_KEY] === true) return;
  g[MOUNTED_KEY] = true;

  try {
    // The element code was bundled into this file, so there is nothing left to fetch or evaluate —
    // registering it is a plain function call.
    defineBluepencilElement();

    const tag = "bluepencil-notes";
    const el = document.createElement(tag);
    // The element already understands an HTTP store through `data-endpoint`, and a credential
    // through `data-token` / `data-token-header` (docs/INTEGRATION.md). The extension's job is
    // only to hand those two across — without them the `http` store setting would silently stay
    // local, because the element has no other way to learn where the sidecar lives (#36).
    const attributes: Record<string, string> = {
      "data-environment": config.settings.environment,
      "data-app-name": config.settings.appName,
      "data-language": config.settings.language,
      "data-store": config.settings.store,
      "data-identity": config.settings.identity,
      "data-bluepencil-url": config.tabUrl,
    };
    if (config.settings.store === "http") {
      if (config.settings.endpoint.length > 0) {
        attributes["data-endpoint"] = config.settings.endpoint;
      }
      if (config.settings.token.length > 0) {
        // The two phases use different headers, and this is where it is decided — not by convention.
        // A token under `x-bluepencil-auth` is a 401 that reads like a broken sidecar, because the
        // value looks right and the header is the only thing wrong.
        if (config.settings.auth === "token") {
          attributes["data-token"] = config.settings.token;
          attributes["data-token-header"] = "authorization";
          // `token-scheme` is what turns a bare token into `Bearer <token>`; the element's
          // attribute contract already knows how to do that, so nothing is assembled by hand here.
          attributes["data-token-scheme"] = "Bearer";
        } else if (config.settings.auth === "secret") {
          attributes["data-token"] = config.settings.token;
          attributes["data-token-header"] = "x-bluepencil-auth";
        }
      }
    }
    for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
    (document.body ?? document.documentElement).append(el);

    report(true, "");
  } catch (error) {
    g[MOUNTED_KEY] = false;
    report(false, error instanceof Error ? error.message : String(error));
  }
}

function report(ok: boolean, error: string): void {
  // The bridge in the isolated world relays this to the worker. It is the only way out: this file
  // runs in the page, which has no `chrome`.
  window.postMessage(
    { source: "bluepencil-extension", kind: "mounted", ok, error: error || undefined },
    window.location.origin === "null" ? "*" : window.location.origin,
  );
}
