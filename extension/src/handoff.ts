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
import type { ExtensionSettings } from "./settings";

/** The subset of settings that decides the element's attributes. */
export type AttributeSource = Pick<
  ExtensionSettings,
  "environment" | "appName" | "language" | "identity" | "store" | "endpoint" | "auth" | "token"
>;

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
 *   what the tab URL was recorded for.
 * - **the credential** keeps its two modes, because they are two different headers: the shared secret
 *   goes in `x-bluepencil-auth`, the signed token in `Authorization: Bearer <token>`. Choosing one is
 *   a decision, never an inference.
 */
export function elementAttributesFor(
  settings: AttributeSource,
  browserLanguage: string = "",
): Record<string, string> {
  const attributes: Record<string, string> = {
    environment: settings.environment,
    language: settings.language === "auto" ? autoLanguage(browserLanguage) : settings.language,
    identity: settings.identity,
    // A review note belongs to the page it was taken on; the element stores the route itself.
    route: "url",
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
      attributes.token = credential;
      const spec = credentialHeaderFor(settings.auth);
      // The element's attribute vocabulary spells header names lower case.
      attributes["token-header"] = spec.header.toLowerCase();
      if (spec.scheme !== null) {
        // A bare token has to be turned into `Bearer <token>` by the element's own contract.
        attributes["token-scheme"] = spec.scheme;
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

/**
 * The header a credential mode means — the single mapping the layer and the connection probe share.
 *
 * Two headers, because they are two different credentials: a shared secret every client holds, and a
 * per-device signed token. Choosing the wrong one produces a `401` that reads like a dead server, so
 * the mapping lives in one place rather than being spelled out once per caller.
 */
export interface CredentialHeader {
  /** Canonical header name; the element's `token-header` attribute wants the lower-case form. */
  header: "Authorization" | "x-bluepencil-auth";
  /** `Bearer` for a signed token, `null` for a shared secret. */
  scheme: string | null;
}

/** The header for `secret` or `token`. Callers handle `none` themselves; there is no header for it. */
export function credentialHeaderFor(auth: "secret" | "token"): CredentialHeader {
  return auth === "token"
    ? { header: "Authorization", scheme: "Bearer" }
    : { header: "x-bluepencil-auth", scheme: null };
}

/**
 * The credential as it should be carried, or `null` when none is configured.
 *
 * Whitespace-only is *not* configured: sending it would turn a harmless probe into a guaranteed 401
 * and hand the element a header value no hub can match. The value is trimmed, so a token pasted with
 * a trailing newline travels without it. Both the layer and the probe read this one rule, so the URL
 * the options page tests is the URL the layer would actually use (#105).
 */
export function configuredCredential(token: string): string | null {
  const value = token.trim();
  return value.length === 0 ? null : value;
}
