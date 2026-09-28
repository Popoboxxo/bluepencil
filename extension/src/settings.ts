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
  /** `dev` | `staging` | `prod` — the element's own environment switch. */
  environment: "dev" | "staging" | "prod";
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
   * `prompt` asks once and remembers it; `page` takes it from the page. The sidecar cannot verify
   * either — it has no authentication (see #36) — so the extension says so rather than pretending.
   */
  identity: "prompt" | "page";
  /** Sidecar base URL; only used when `store` is `http`. Empty means local mode. */
  endpoint: string;
  /** Credential for the sidecar; only used when `store` is `http`. See #36. */
  token: string;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  environment: "dev",
  appName: "",
  language: "auto",
  store: "chromeStorage",
  identity: "prompt",
  endpoint: "",
  token: "",
};

/** Field-by-field validation, so a hand-edited storage blob cannot put the layer in a bad state. */
export function normalizeSettings(value: unknown): ExtensionSettings {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_SETTINGS };
  const raw = value as Partial<Record<keyof ExtensionSettings, unknown>>;
  const pick = <T>(key: keyof ExtensionSettings, allowed: readonly T[]): T | undefined => {
    const candidate = raw[key];
    return allowed.includes(candidate as T) ? (candidate as T) : undefined;
  };
  return {
    environment: pick("environment", ["dev", "staging", "prod"] as const) ?? DEFAULT_SETTINGS.environment,
    appName: typeof raw.appName === "string" ? raw.appName : DEFAULT_SETTINGS.appName,
    language: pick("language", ["auto", "en", "de"] as const) ?? DEFAULT_SETTINGS.language,
    store:
      pick("store", ["chromeStorage", "localStorage", "memory", "http"] as const) ??
      DEFAULT_SETTINGS.store,
    identity: pick("identity", ["prompt", "page"] as const) ?? DEFAULT_SETTINGS.identity,
    endpoint: typeof raw.endpoint === "string" ? raw.endpoint : DEFAULT_SETTINGS.endpoint,
    token: typeof raw.token === "string" ? raw.token : DEFAULT_SETTINGS.token,
  };
}
