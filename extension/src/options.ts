/**
 * Options page logic (#34).
 *
 * Deliberately thin: the settings object is validated in `settings.ts` (the module the service
 * worker also uses), so the page cannot save a value the worker would later reject. Reading and
 * writing go through `chrome.storage.local` directly — the same key the worker reads, so there is
 * one source of truth rather than a page-local copy that can drift.
 */
import { DEFAULT_SETTINGS, normalizeSettings, type ExtensionSettings } from "./settings";

declare const chrome: {
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
};

const SETTINGS_KEY = "bluepencil:settings";

/** The fields the form owns, in the shape the settings object uses. */
const FIELDS = [
  "environment",
  "appName",
  "language",
  "identity",
  "store",
  "endpoint",
  "token",
] as const satisfies readonly (keyof ExtensionSettings)[];

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`options: #${id} is missing`);
  return node as T;
}

const form = byId<HTMLFormElement>("form");
const status = byId<HTMLElement>("status");
const sidecar = byId<HTMLElement>("sidecar");
const save = byId<HTMLButtonElement>("save");

function say(message: string, kind: "ok" | "error" | "" = ""): void {
  status.textContent = message;
  if (kind === "") delete status.dataset.kind;
  else status.dataset.kind = kind;
}

function showSidecar(store: string): void {
  sidecar.hidden = store !== "http";
}

function fill(settings: ExtensionSettings): void {
  for (const field of FIELDS) {
    const node = byId<HTMLInputElement | HTMLSelectElement>(field);
    node.value = settings[field];
  }
  showSidecar(settings.store);
}

async function load(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    // normalizeSettings, not a cast: a hand-edited or older blob must not reach the form as-is.
    fill(normalizeSettings(stored[SETTINGS_KEY]));
  } catch (error) {
    fill({ ...DEFAULT_SETTINGS });
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
    const raw: Record<string, unknown> = {};
    for (const field of FIELDS) raw[field] = byId<HTMLInputElement | HTMLSelectElement>(field).value;
    const settings = normalizeSettings(raw);
    // Save the normalized form, not the raw input: what is stored is exactly what the worker will
    // read back, so a bad value cannot sit in storage until the next mount fails.
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    fill(settings);
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

void load();
