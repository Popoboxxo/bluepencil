/**
 * The worker's settings → the element's attributes (#53).
 *
 * The layer and the embed loader speak the *same* vocabulary: the element reads plain attribute
 * names (`adapter`, `environment`, `app`, `identity`, `endpoint`), and `data-*` is the **loader's**
 * spelling, which `dist/attach.js` translates when
 * it creates the element. The extension used to write the `data-*` spelling straight onto the
 * element, so nothing arrived: measured in the extension smoke, the layer fell back to its default
 * `memory` store while the attribute readback said `chromeStorage` — a green assertion over a broken
 * round.
 *
 * This module is the one place that translation happens, and it is pure: settings + the browser's
 * language in, attributes out. It is unit-tested without a browser, which the wiring never was.
 */
import type { ExtensionSettings } from "./settings";

/**
 * The settings that may cross into a page, and the type is final as of B.3a (CSR-17).
 *
 * A credential, its expiry and a device name belong to the extension only. They are omitted here at
 * the type level *and* stripped at runtime: the page never receives a value it could read out of
 * `__bluepencilConfig__` (SEC-14, AC-B15).
 */
export type PageSettings = Omit<ExtensionSettings, "token" | "tokenExpiresAt" | "deviceName">;

/**
 * The page-facing projection of the settings.
 *
 * The three extension-only fields are **removed**, not merely unnamed by the type: an object spread
 * would carry them into `__bluepencilConfig__`, where any page script could read the hub credential.
 * The credential is attached by the worker only, after validation (AC-B13, AC-B15).
 */
export function pageSettingsFor(settings: ExtensionSettings): PageSettings {
  const page: Record<string, unknown> = { ...settings };
  delete page.token;
  delete page.tokenExpiresAt;
  delete page.deviceName;
  return page as unknown as PageSettings;
}

/**
 * The subset of settings that decides the element's attributes.
 *
 * No `auth`, no `token`: from 0.12.0 the page has no credential attribute at all. The hub request is
 * authenticated by the service worker, and the element only needs the endpoint to select the HTTP
 * adapter (AC-B15, AC-B36).
 */
export type ExtensionAttributeSource = Pick<
  ExtensionSettings,
  "environment" | "appName" | "language" | "identity" | "store" | "endpoint"
>;

/**
 * The route the extension writes, always the path-only mode (G8, AC-C04).
 *
 * `route="url"` means "store the page's pathname"; the query is never part of an extension note.
 * The extension offers **no** query opt-in in 0.12.0: writing `route="url-with-query"` (or a
 * `query-allow` list) would silently turn a deep-link token into a stored note field.
 */
const EXTENSION_ROUTE = "url" as const;

/**
 * The attributes the element should be given, in its own vocabulary.
 *
 * Deliberate choices, each of which was a mismatch before:
 *
 * - **`environment`** is always set: the model's vocabulary is `dev|staging|live` (`src/core/model.ts`),
 *   so the options page offers those and an environment is never silently absent from a note.
 * - **`app`** only when a name was given — the element's own default then applies.
 * - **`language`**: the extension offers `auto`, the element does not. `auto` is resolved here, from
 *   the browser, because this code runs where the browser is and the element's default is `en`.
 * - **`store` becomes `adapter`**, except for the hub: there `endpoint` alone selects the HTTP
 *   adapter (the documented rule is that its presence implies `http`). Writing `adapter="http"`
 *   *without* a URL would pick an adapter that has no endpoint to talk to.
 * - **`identity`** is `prompt` or `anonymous`, the two values the element accepts. The options page
 *   used to offer "take it from the page", which has no counterpart in the element contract at all.
 * - **`route: "url"`** gives the tab's own URL a home. The worker used to write `data-bluepencil-url`,
 *   which no attribute reads; `route="url"` makes every note carry the page it was taken on, which is
 *   what the tab URL was recorded for. Since G8 the value is path-only: the query is never stored,
 *   and the extension deliberately writes neither `url-with-query` nor `query-allow` (AC-C04).
 * - **no credential attribute.** `token`, `token-header` and `token-scheme` are gone from the
 *   element contract as the extension writes it: the worker attaches the header to each relayed hub
 *   request instead (`credential.ts` + `hub-fetch.ts`), so no page value ever reaches the page
 *   (SEC-14, AC-B15).
 */
export function elementAttributesFor(
  settings: ExtensionAttributeSource,
  browserLanguage: string = "",
): Record<string, string> {
  const attributes: Record<string, string> = {
    environment: settings.environment,
    language: settings.language === "auto" ? autoLanguage(browserLanguage) : settings.language,
    identity: settings.identity,
    // A review note belongs to the page it was taken on; the element stores the path only — the
    // extension never opts into the query (G8, AC-C04).
    route: EXTENSION_ROUTE,
  };

  if (settings.appName.trim().length > 0) {
    attributes.app = settings.appName;
  }

  if (settings.store === "http") {
    // Only the URL: its presence is what selects the HTTP adapter. Without one there is nowhere to
    // send a note, and the options page refuses to save that combination.
    if (settings.endpoint.length > 0) {
      attributes.endpoint = settings.endpoint;
    }
    return attributes;
  }

  attributes.adapter = settings.store;
  return attributes;
}

/** `auto` follows the browser, which is where this code runs. Anything but German is the default. */
function autoLanguage(browserLanguage: string): "en" | "de" {
  return browserLanguage.toLowerCase().startsWith("de") ? "de" : "en";
}
