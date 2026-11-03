/**
 * The worker's settings → the element's attributes (#53).
 *
 * The layer and the embed loader speak the *same* vocabulary: the element reads plain attribute
 * names (`adapter`, `environment`, `app`, `identity`, `endpoint`, `token`, `token-header`,
 * `token-scheme`), and `data-*` is the **loader's** spelling, which `dist/attach.js` translates when
 * it creates the element. The extension used to write the `data-*` spelling straight onto the
 * element, so nothing arrived: measured in the extension smoke, the layer fell back to its default
 * `memory` store while the attribute readback said `chromeStorage` — a green assertion over a broken
 * round.
 *
 * This module is the one place that translation happens, and it is pure: settings + the browser's
 * language in, attributes out. It is unit-tested without a browser, which the wiring never was.
 */
import { configuredCredential, credentialHeaderFor } from "./credential";
import type { ExtensionSettings } from "./settings";

/**
 * The credential mapping moved to `credential.ts` (FR-15.3); these re-exports keep the existing
 * importers working until B.3b removes them. `options.ts` still imports `configuredCredential` from
 * here in this step and moves to `./credential` with the options rework.
 */
export { authHeadersFor, configuredCredential, credentialHeaderFor } from "./credential";
export type { CredentialHeader, CredentialMode } from "./credential";

/**
 * The settings that may cross into a page, and the type is final as of B.3a (CSR-17).
 *
 * A credential, its expiry and a device name belong to the extension only. They are omitted here at
 * the *type* level already; the runtime of {@link pageSettingsFor} still forwards them in this step
 * (behaviour-neutral) and strips them in B.3b. Keeping the type ahead of the runtime makes the
 * intermediate state explicit instead of a silent contract change.
 */
export type PageSettings = Omit<ExtensionSettings, "token" | "tokenExpiresAt" | "deviceName">;

/**
 * The page-facing projection of the settings.
 *
 * B.3a forwards `token`/`tokenExpiresAt`/`deviceName` at runtime even though {@link PageSettings}
 * does not name them; the caller sees the final type, and B.3b turns the forwarding into stripping.
 */
export function pageSettingsFor(settings: ExtensionSettings): PageSettings {
  return { ...settings };
}

/** The subset of settings that decides the element's attributes. */
export type ExtensionAttributeSource = Pick<
  ExtensionSettings,
  "environment" | "appName" | "language" | "identity" | "store" | "endpoint" | "auth" | "token"
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
 * - **the credential** keeps its two modes, because they are two different headers: the shared secret
 *   goes in `x-bluepencil-auth`, the signed token in `Authorization: Bearer <token>`. Choosing one is
 *   a decision, never an inference.
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
    // `none` wins over a leftover token, exactly as it does in the connection probe: the saved
    // settings would not use that value, so handing it to the element would invent a credential.
    const credential = configuredCredential(settings.token);
    if (credential !== null && settings.auth !== "none") {
      const spec = credentialHeaderFor(settings.auth);
      if (spec !== null) {
        attributes.token = credential;
        // The element's attribute vocabulary spells header names lower case.
        attributes["token-header"] = spec.header.toLowerCase();
        if (spec.scheme !== null) {
          // A bare token has to be turned into `Bearer <token>` by the element's own contract.
          attributes["token-scheme"] = spec.scheme;
        }
      }
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
