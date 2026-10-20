/**
 * Options page logic (#34).
 *
 * Deliberately thin: the settings object is validated in `settings.ts` (the module the service
 * worker also uses), so the page cannot save a value the worker would later reject. Reading and
 * writing go through `chrome.storage.local` directly — the same key the worker reads, so there is
 * one source of truth rather than a page-local copy that can drift.
 */
import { DEFAULT_SETTINGS, expiryOfToken, normalizeSettings, type ExtensionSettings } from "./settings";

declare const chrome: {
  runtime: {
    /** The worker's on/off path. Available to every extension page, so no permission is needed. */
    sendMessage(message: unknown): Promise<unknown>;
  };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
};

const SETTINGS_KEY = "bluepencil:settings";

/**
 * The text/select fields the form owns, in the shape the settings object uses.
 *
 * Split from the checkboxes (#70) because the two kinds do not read or write alike: a text field
 * exposes its value as a *string*, a checkbox as a *boolean*. Listing them in one array would force
 * `settings[field]` to `string | boolean` and lose exactly the distinction that keeps a hand-edited
 * `mountAlongsideHost: "false"` from being read as on.
 */
const FIELDS = [
  "environment",
  "appName",
  "language",
  "identity",
  "store",
  "endpoint",
  "auth",
  "token",
  "deviceName",
] as const satisfies readonly (keyof ExtensionSettings)[];

/** The checkbox fields — booleans, read from `.checked` rather than `.value`. */
const CHECKBOXES = [
  "mountAlongsideHost",
] as const satisfies readonly (keyof ExtensionSettings)[];

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`options: #${id} is missing`);
  return node as T;
}

const form = byId<HTMLFormElement>("form");
const status = byId<HTMLElement>("status");
const hub = byId<HTMLElement>("hub");
const save = byId<HTMLButtonElement>("save");

function say(message: string, kind: "ok" | "error" | "" = ""): void {
  status.textContent = message;
  if (kind === "") delete status.dataset.kind;
  else status.dataset.kind = kind;
}

function showSidecar(store: string): void {
  hub.hidden = store !== "http";
}

function fill(settings: ExtensionSettings): void {
  for (const field of FIELDS) {
    const node = byId<HTMLInputElement | HTMLSelectElement>(field);
    node.value = settings[field];
  }
  for (const field of CHECKBOXES) {
    byId<HTMLInputElement>(field).checked = settings[field];
  }
  showSidecar(settings.store);
}

async function load(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    // normalizeSettings, not a cast: a hand-edited or older blob must not reach the form as-is.
    const settings = normalizeSettings(stored[SETTINGS_KEY]);
    fill(settings);
    // Described on load, not only on save: opening the options page is how someone checks whether
    // their token is still alive, so leaving the state blank until they press Save would defeat it.
    describeCredential(settings);
  } catch (error) {
    fill({ ...DEFAULT_SETTINGS });
    describeCredential({ ...DEFAULT_SETTINGS });
    say(`Could not read the stored settings: ${String(error)}`, "error");
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void save_();
});

async function save_(): Promise<void> {
  save.disabled = true;
  try {
    const settings = normalizeSettings(readForm());
    // A hub store without a URL is a store that cannot be reached: the element would fall back to
    // its default `memory` and the notes would be gone on reload. Refusing to save says so instead.
    if (settings.store === "http" && settings.endpoint.trim().length === 0) {
      say("A hub needs a URL — without one the notes would be kept in this tab only.", "error");
      return;
    }
    // Save the normalized form, not the raw input: what is stored is exactly what the worker will
    // read back, so a bad value cannot sit in storage until the next mount fails.
    // The expiry is derived from the token rather than typed, so the user cannot state a wrong one.
    await chrome.storage.local.set({
      [SETTINGS_KEY]: { ...settings, tokenExpiresAt: expiryOfToken(settings.token) },
    });
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const current = normalizeSettings(stored[SETTINGS_KEY]);
    fill(current);
    describeCredential(current);
    say("Saved.", "ok");
  } catch (error) {
    say(`Could not save: ${String(error)}`, "error");
  } finally {
    save.disabled = false;
  }
}

byId<HTMLSelectElement>("store").addEventListener("change", (event) => {
  showSidecar((event.target as HTMLSelectElement).value);
});

/**
 * The form's current values, in the shape the settings object uses.
 *
 * Shared between saving and the live description of the credential, so the two cannot disagree about
 * what is on screen. Reading the form in two places is how a field ends up shown but not stored.
 */
function readForm(): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const field of FIELDS) raw[field] = byId<HTMLInputElement | HTMLSelectElement>(field).value;
  // `.checked`, not `.value`: the checkbox's value string is always "on" and says nothing about
  // whether it is ticked. `normalizeSettings` then keeps the result strictly boolean (#70).
  for (const field of CHECKBOXES) raw[field] = byId<HTMLInputElement>(field).checked;
  return raw;
}

/**
 * Says what the selected credential actually is, and how long it lasts.
 *
 * Two things a user cannot otherwise find out, both of which end in lost notes: a token that is
 * already expired, and a token whose expiry could not be read. The first is a warning; the second is
 * stated plainly rather than hidden, because "unknown" and "never expires" must not look alike.
 */
function describeCredential(settings: ExtensionSettings): void {
  const hint = byId("credential-hint");
  const label = byId("credential-label");
  const state = byId("token-state");
  // The device name only means something for a signed token; shown for a shared secret it would
  // suggest a per-device credential that does not exist.
  byId("device-field").hidden = settings.auth !== "token";
  if (settings.auth === "secret") {
    label.textContent = "Shared secret";
    hint.textContent =
      "Sent as x-bluepencil-auth. Stored in this browser only. The hub needs --auth-secret with the same value.";
    state.hidden = true;
    return;
  }
  if (settings.auth === "none") {
    label.textContent = "Credential";
    hint.textContent =
      "None. Anyone who can reach the hub URL can read and write your notes, so it must stay on loopback.";
    state.hidden = true;
    return;
  }
  label.textContent = "Signed token";
  hint.textContent =
    "Sent as Authorization: Bearer. Mint one with `bluepencil token --device <name>`; it expires, and the hub can revoke it on its own without touching your other devices.";
  if (settings.token.length === 0) {
    state.hidden = false;
    state.textContent = "No token stored yet — notes will not reach the hub until you paste one.";
    return;
  }
  if (settings.tokenExpiresAt === "") {
    state.hidden = false;
    // Not a warning about the token being bad: the extension cannot read an expiry out of a token it
    // does not understand, and pretending otherwise would be worse than saying so.
    state.textContent =
      "The expiry of this token could not be read. It may already be expired — the hub decides, not the extension.";
    return;
  }
  const remaining = Date.parse(settings.tokenExpiresAt) - Date.now();
  state.hidden = false;
  if (remaining <= 0) {
    state.textContent = "This token has expired. Mint a new one — notes are not reaching the hub until you do.";
    return;
  }
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  state.textContent =
    hours > 0 ? `Expires in about ${hours} h ${minutes} min.` : `Expires in about ${minutes} min.`;
}

byId<HTMLSelectElement>("auth").addEventListener("change", () => {
  describeCredential(normalizeSettings(readForm()));
});

/**
 * The on/off switch for the current tab (#36).
 *
 * It goes through `chrome.runtime.sendMessage`, not through a direct `chrome.tabs` call, so the
 * options page does not need the `tabs` permission to influence a tab — it asks the worker, which
 * already has it. That is also the only way to reach the MAIN world, where the element lives.
 */
function wireToggle(id: string, enabled: boolean): void {
  byId<HTMLButtonElement>(id).addEventListener("click", () => {
    const status = byId<HTMLSpanElement>("toggle-status");
    status.textContent = "Working…";
    status.className = "";
    void chrome.runtime
      .sendMessage({ type: "bluepencil:toggle", enabled })
      .then((reply: unknown) => {
        const ok = typeof reply === "object" && reply !== null && (reply as { ok?: unknown }).ok === true;
        if (ok) {
          status.textContent = enabled ? "The layer is on for this tab." : "The layer is off for this tab.";
          status.className = "ok";
        } else {
          // The most likely cause is that the layer was never mounted on this tab, and saying so is
          // more useful than the generic "not on this page" the worker reports.
          status.textContent = "The layer is not on this tab — press the toolbar button first.";
          status.className = "warn";
        }
      })
      .catch((error: unknown) => {
        status.textContent = `Could not reach the page: ${String(error)}`;
        status.className = "error";
      });
  });
}

wireToggle("turn-on", true);
wireToggle("turn-off", false);

/** What `extension/build.mjs` writes to `dist/build-info.js` as a build-time global. */
interface BuildInfo {
  version: string;
  gitSha: string | null;
  elementSha256: string;
}

const VERSION_FIELDS = ["version-bluepencil", "version-build", "version-commit", "version-element"] as const;

/** Writes plain text (never HTML) and, when given, the full value as a hover title. */
function setVersionField(id: string, text: string, title?: string): void {
  const node = document.getElementById(id);
  if (node === null) return;
  node.textContent = text;
  if (title === undefined) node.removeAttribute("title");
  else node.setAttribute("title", title);
}

/**
 * Shows the exact build this page belongs to (FR-4.9).
 *
 * The values come from `globalThis.BLUEPENCIL_BUILD_INFO`, written by the build to `build-info.js`
 * and loaded as a classic script before this module. No same-origin `fetch`, no network API, no
 * inline script and no `eval` — nothing the Webstore compliance scan or the extension CSP would
 * have to allow. A missing or malformed global is stated as "unavailable" rather than left blank or
 * thrown: the settings form has to keep working either way, so this never throws.
 */
function showVersion(): void {
  const info = (globalThis as unknown as Record<string, unknown>)["BLUEPENCIL_BUILD_INFO"];
  if (typeof info !== "object" || info === null) {
    for (const id of VERSION_FIELDS) setVersionField(id, "unavailable");
    return;
  }
  const record = info as Partial<Record<keyof BuildInfo, unknown>>;
  if (typeof record.version !== "string" || typeof record.elementSha256 !== "string") {
    for (const id of VERSION_FIELDS) setVersionField(id, "unavailable");
    return;
  }
  const version = record.version;
  const elementSha256 = record.elementSha256;
  const gitSha = typeof record.gitSha === "string" ? record.gitSha : "unknown";
  setVersionField("version-bluepencil", `bluepencil ${version}`);
  setVersionField("version-build", version);
  // The full SHA, with itself as the title: a truncated hash cannot be matched against a commit,
  // and the title keeps the row narrow without hiding the value.
  setVersionField("version-commit", gitSha, gitSha === "unknown" ? undefined : gitSha);
  setVersionField("version-element", elementSha256, elementSha256);
}

void load();
// Independent of the settings load: a missing build-info global must never block the form.
void showVersion();
