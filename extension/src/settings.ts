/**
 * Extension settings — the small set of values the layer needs before it can mount (#34).
 *
 * These map one-to-one onto the element's existing attribute contract (`data-environment`,
 * `data-store`, …) rather than inventing a second configuration channel. Anything the element
 * already understands from its attributes stays there, so the bookmarklet, the embed loader and
 * the extension all configure the same layer the same way.
 *
 * The defaults are deliberately local-first: no server, no credentials, no network. A sidecar is
 * opt-in via the `http` store, which is where #36's authentication applies.
 */

export interface ExtensionSettings {
  /**
   * `dev` | `staging` | `live` — the element's own environment switch, and the vocabulary the data
   * model and the sidecar both use (`ENVIRONMENTS` in `src/core/model.ts`). The page used to offer
   * `prod`, which the element rejects with `environment must be dev, staging or live` (#53).
   */
  environment: "dev" | "staging" | "live";
  /** App name shown in the bar; defaults to the page's own title when empty. */
  appName: string;
  /** UI language: `auto` follows the browser, `en` / `de` pin it. */
  language: "auto" | "en" | "de";
  /**
   * Which store the notes go to.
   *
   * `chromeStorage` is the default and the reason this adapter exists: one store shared across
   * every site and tab. `localStorage` is partitioned per origin, so a note taken on one site is
   * invisible on the next — fine for the bookmarklet, wrong for an extension.
   */
  store: "chromeStorage" | "localStorage" | "memory" | "http";
  /**
   * How the note's author is established.
   *
   * `prompt` asks once and remembers it; `anonymous` writes the note without a name. These are the
   * two values the element accepts — the third the page used to offer, "take it from the page", had
   * no counterpart in the element's contract at all (#53), and a page cannot hand an identity to a
   * layer that runs in its own world without the host wiring one.
   *
   * The sidecar cannot verify either — it has no authentication of its own — so the page says so
   * rather than pretending.
   */
  identity: "prompt" | "anonymous";
  /** Sidecar base URL; only used when `store` is `http`. Empty means local mode. */
  endpoint: string;
  /**
   * Which credential this sidecar expects. Not a free-form header name, because getting it wrong
   * fails in a way that looks like a network fault: a request carrying the right secret under the
   * wrong header is a 401, and the obvious guess is "the sidecar is down".
   *
   * `secret` is phase 1's `--auth-secret`; `token` is phase 2's signed token, which is short-lived,
   * revocable per device, and has to be replaced before it expires.
   */
  auth: "none" | "secret" | "token";
  /** Credential for the sidecar; only used when `store` is `http`. See #36. */
  token: string;
  /**
   * When the stored token expires, as an ISO timestamp, or empty if unknown.
   *
   * Recorded so the options page can say "expires in 6 hours" instead of leaving someone to find out
   * by watching their notes stop saving. Read from the token itself when it is stored; never used for
   * a decision — the sidecar decides expiry, this is only for telling the user what is coming.
   */
  tokenExpiresAt: string;
  /** A name for the device, so a revocation list stays readable by a human. */
  deviceName: string;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  environment: "dev",
  appName: "",
  language: "auto",
  store: "chromeStorage",
  identity: "prompt",
  endpoint: "",
  auth: "none",
  token: "",
  tokenExpiresAt: "",
  deviceName: "",
};

/**
 * The environment, with the page's old `prod` folded into `live`.
 *
 * `prod` was never a value the layer knew: writing it produced a `bp-error`
 * (`environment must be dev, staging or live`) and the note carried no environment at all. A round
 * stored as `prod` therefore means exactly what `live` means, so it is migrated rather than dropped.
 */
function pickEnvironment(value: unknown): ExtensionSettings["environment"] {
  if (value === "prod") return "live";
  return value === "dev" || value === "staging" || value === "live"
    ? value
    : DEFAULT_SETTINGS.environment;
}

/** Field-by-field validation, so a hand-edited storage blob cannot put the layer in a bad state. */
export function normalizeSettings(value: unknown): ExtensionSettings {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_SETTINGS };
  const raw = value as Partial<Record<keyof ExtensionSettings, unknown>>;
  const pick = <T>(key: keyof ExtensionSettings, allowed: readonly T[]): T | undefined => {
    const candidate = raw[key];
    return allowed.includes(candidate as T) ? (candidate as T) : undefined;
  };
  return {
    environment: pickEnvironment(raw.environment),
    appName: typeof raw.appName === "string" ? raw.appName : DEFAULT_SETTINGS.appName,
    language: pick("language", ["auto", "en", "de"] as const) ?? DEFAULT_SETTINGS.language,
    store:
      pick("store", ["chromeStorage", "localStorage", "memory", "http"] as const) ??
      DEFAULT_SETTINGS.store,
    // An older blob may say "page" (a mode the element never had); it is dropped to the documented
    // default rather than carried, so the page cannot offer a choice the layer cannot honour (#53).
    identity: pick("identity", ["prompt", "anonymous"] as const) ?? DEFAULT_SETTINGS.identity,
    endpoint: typeof raw.endpoint === "string" ? raw.endpoint : DEFAULT_SETTINGS.endpoint,
    auth: pick("auth", ["none", "secret", "token"] as const) ?? DEFAULT_SETTINGS.auth,
    token: typeof raw.token === "string" ? raw.token : DEFAULT_SETTINGS.token,
    // Only a parseable timestamp is kept. An unparseable one would be shown as "expires in NaN
    // hours" or, worse, silently treated as "never expires" — and this value exists purely to warn
    // the user, so a wrong warning is worse than no warning.
    tokenExpiresAt:
      typeof raw.tokenExpiresAt === "string" && raw.tokenExpiresAt.length > 0 &&
      Number.isFinite(Date.parse(raw.tokenExpiresAt))
        ? raw.tokenExpiresAt
        : DEFAULT_SETTINGS.tokenExpiresAt,
    deviceName: typeof raw.deviceName === "string" ? raw.deviceName : DEFAULT_SETTINGS.deviceName,
  };
}

/**
 * Reads the expiry out of a token, without verifying it.
 *
 * The payload is not trustworthy and this function does not pretend otherwise — it is a
 * `chrome.storage` reader, not a verifier, and the sidecar is the only party that gets to decide
 * whether a token is valid. What it does is avoid one specific, avoidable failure: a user who
 * pastes a token and never learns when it dies, then finds out by losing notes.
 *
 * A token that cannot be read here is not an error. The extension stores it and the sidecar decides;
 * the options page simply says the expiry is unknown.
 */
export function expiryOfToken(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) return "";
  // A length check does not narrow an indexed lookup under `noUncheckedIndexedAccess`, so the
  // payload segment is read out and checked before `atob` may see it. An empty segment is not a
  // token; that answer is the same as for the wrong number of segments, which is why it is here and
  // not inside the `try`.
  const payload = parts[1];
  if (payload === undefined || payload.length === 0) return "";
  try {
    const claims: unknown = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof claims !== "object" || claims === null) return "";
    const exp = (claims as { exp?: unknown }).exp;
    // Both spellings exist in the wild: a JWT uses seconds, and a claim set built by hand often
    // carries the ISO string. Accepting only one would silently drop the other's expiry.
    const millis =
      typeof exp === "number" ? exp * 1000 : typeof exp === "string" ? Date.parse(exp) : Number.NaN;
    return Number.isFinite(millis) ? new Date(millis).toISOString() : "";
  } catch {
    return "";
  }
}
