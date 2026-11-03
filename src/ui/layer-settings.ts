/**
 * The settings unit of the review layer (CQ-03 split, spec §3.13 L).
 *
 * It owns the UI preferences and everything derived from them: the stored/initial merge
 * (FR-4.5/10.3), the `?bp-chrome=` one-load override (FR-12.12), the narrow-viewport fact
 * (FR-12.13), the host mode ceiling (FR-4.10), persistence and the translator that follows a
 * language switch (FR-11.1).
 *
 * It owns no DOM node and no listener: the composition root renders from it. `dispose()` must not
 * clear the stored preference — a setting survives `disable()`/`enable()` by contract (FR-4.5).
 */

import { createTranslator, normalizeLanguage, type Translate } from "../i18n";
import { CAPTURE_MODES, isCaptureMode, type CaptureMode } from "./modes";
import { DEFAULT_SETTINGS, type LayerSettings } from "./panel";
import type { LayerUnit } from "./layer-unit";

/** Structural copy of the layer's public `ChromeLevel` — importing it would close a cycle. */
export type LayerChromeLevel = "full" | "quiet" | "off";

/** Below this width the strip yields to its handle on its own (FR-12.13). */
const NARROW_WIDTH = 720;

/** UI preferences key — namespaced like the storage keys of the adapters (ARCHITECTURE §6b). */
function settingsKey(view: Window | undefined): string {
  const host = view?.location?.host !== undefined && view.location.host !== "" ? view.location.host : "local";
  return `bluepencil:ui:${host}:v1`;
}

function readStoredSettings(view: Window | undefined): Partial<LayerSettings> {
  try {
    const raw = view?.localStorage?.getItem(settingsKey(view));
    if (typeof raw !== "string") return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const source = parsed as Record<string, unknown>;
    const result: Partial<LayerSettings> = {};
    if (typeof source.showDone === "boolean") result.showDone = source.showDone;
    if (typeof source.feedbackOnly === "boolean") result.feedbackOnly = source.feedbackOnly;
    if (typeof source.author === "string") result.author = source.author;
    if (typeof source.language === "string") result.language = source.language;
    if (typeof source.barCollapsed === "boolean") result.barCollapsed = source.barCollapsed;
    if (source.chromeLevel === "full" || source.chromeLevel === "quiet" || source.chromeLevel === "off") {
      result.chromeLevel = source.chromeLevel;
    }
    // FR-4.10: a partial/corrupt modes object degrades to the defaults per mode instead of
    // discarding the whole preference.
    if (typeof source.modes === "object" && source.modes !== null) {
      const modes = { ...DEFAULT_SETTINGS.modes };
      const storedModes = source.modes as Record<string, unknown>;
      for (const mode of CAPTURE_MODES) {
        const value = storedModes[mode];
        if (typeof value === "boolean") modes[mode] = value;
      }
      result.modes = modes;
    }
    return result;
  } catch {
    // Private mode / disabled storage must degrade, never break (NFR-5).
    return {};
  }
}

/**
 * `?bp-chrome=quiet|full|off` — the level for one load, never persisted (FR-12.12). For screenshots,
 * QA runs and handovers: whoever takes over can set the state without touching a stored preference.
 */
function chromeFromUrl(view: Window | undefined): LayerChromeLevel | null {
  const search = view?.location?.search ?? "";
  const match = /[?&]bp-chrome=(quiet|full|off)(&|$)/.exec(search);
  return match === null ? null : (match[1] as LayerChromeLevel);
}

/**
 * The host ceiling (FR-4.10), normalised once: absent means every mode, `"none"` means none,
 * and an explicit list is filtered against the known modes and deduplicated. An embed attribute
 * can carry anything, so an unknown value is dropped here instead of reaching the bar.
 */
function normaliseHostModes(value: readonly CaptureMode[] | "none" | undefined): CaptureMode[] {
  if (value === "none") return [];
  if (value === undefined) return [...CAPTURE_MODES];
  const result: CaptureMode[] = [];
  for (const entry of value) {
    if (isCaptureMode(entry) && !result.includes(entry)) result.push(entry);
  }
  return result;
}

export interface LayerSettingsDeps {
  view?: Window;
  /** Explicit host language; wins over the persisted one (FR-10.3). */
  language?: string;
  /** Initial chrome level; the user's persisted choice applies on top (FR-12.9). */
  chrome?: LayerChromeLevel;
  /** Host default for the done filter (D4). */
  defaultShowDone?: boolean;
  /** Host ceiling (FR-4.10); `"none"` mounts a read-only layer. */
  modes?: readonly CaptureMode[] | "none";
}

export interface LayerSettingsUnit extends LayerUnit {
  /** The live settings object — mutate only through `patch()`/`reset()`. */
  readonly settings: LayerSettings;
  /** Host ceiling, fixed for the lifetime of the instance (FR-4.10). */
  readonly hostModes: readonly CaptureMode[];
  /** Stable translator for the components; a language switch swaps its backing table. */
  readonly t: Translate;
  /** Modes the host offers and the user kept enabled (FR-4.10). */
  availableModes(): CaptureMode[];
  modeAvailable(mode: CaptureMode): boolean;
  /** False in a read-only host (`modes: "none"`) — the feedback-only toggle has nothing to act on. */
  anyModeAvailable(): boolean;
  /** Applies a patch, persists it and follows a language switch; reports the latter. */
  patch(patch: Partial<LayerSettings>): { languageChanged: boolean };
  /** Settings -> "reset to defaults" (FR-4.5), including the host's `defaultShowDone` (D4). */
  reset(): void;
  /** Persisted/current level, without the one-off URL override and the narrow adjustment. */
  chrome(): LayerChromeLevel;
  /** Level for this render: URL override, then the narrow-viewport yield (FR-12.12/12.13). */
  chromeLevel(): LayerChromeLevel;
  /** An explicit choice wins over the one-load URL parameter. */
  setChromeOverride(level: LayerChromeLevel | null): void;
  /** Records a viewport width; `true` when the narrow state changed (FR-12.13). */
  updateWidth(width: number | undefined): boolean;
}

export function createLayerSettings(deps: LayerSettingsDeps = {}): LayerSettingsUnit {
  const view = deps.view;
  const stored = readStoredSettings(view);
  let chromeOverride = chromeFromUrl(view);
  /**
   * True while the viewport is too narrow for a strip (FR-12.13). A viewport fact, not a preference:
   * it is never persisted, and it yields to an explicit `setChrome()` on a wide screen.
   */
  let narrow =
    view !== undefined && typeof view.innerWidth === "number" && view.innerWidth > 0 && view.innerWidth <= NARROW_WIDTH;
  const settings: LayerSettings = {
    ...DEFAULT_SETTINGS,
    showDone: deps.defaultShowDone ?? false,
    ...(deps.chrome === undefined ? {} : { chromeLevel: deps.chrome }),
    ...stored,
  };
  // An explicit host language always wins over the persisted one (FR-10.3); without it the
  // persisted choice survives a reload (FR-4.5).
  settings.language = normalizeLanguage(deps.language ?? settings.language);

  /** Host ceiling (FR-4.10), fixed for the lifetime of the instance. */
  const hostModes = normaliseHostModes(deps.modes);

  let translator = createTranslator(settings.language);
  const t: Translate = (key, vars) => translator.t(key, vars);

  function persist(): void {
    try {
      view?.localStorage?.setItem(settingsKey(view), JSON.stringify(settings));
    } catch {
      // Best effort only: storage may be unavailable or full (NFR-5).
    }
  }

  function availableModes(): CaptureMode[] {
    return hostModes.filter((mode) => settings.modes[mode] !== false);
  }

  return {
    settings,
    hostModes,
    t,
    availableModes,
    modeAvailable: (mode) => hostModes.includes(mode) && settings.modes[mode] !== false,
    anyModeAvailable: () => availableModes().length > 0,

    patch(patch: Partial<LayerSettings>): { languageChanged: boolean } {
      let languageChanged = false;
      if (patch.showDone !== undefined) settings.showDone = patch.showDone;
      if (patch.feedbackOnly !== undefined) settings.feedbackOnly = patch.feedbackOnly;
      if (patch.author !== undefined) settings.author = patch.author;
      if (patch.barCollapsed !== undefined) settings.barCollapsed = patch.barCollapsed;
      if (patch.chromeLevel !== undefined) settings.chromeLevel = patch.chromeLevel;
      if (patch.modes !== undefined) settings.modes = { ...settings.modes, ...patch.modes };
      if (patch.language !== undefined) {
        const next = normalizeLanguage(patch.language);
        languageChanged = next !== settings.language;
        settings.language = next;
      }
      if (languageChanged) translator = createTranslator(settings.language);
      persist();
      return { languageChanged };
    },

    reset(): void {
      settings.showDone = deps.defaultShowDone ?? DEFAULT_SETTINGS.showDone;
      settings.feedbackOnly = DEFAULT_SETTINGS.feedbackOnly;
      settings.author = DEFAULT_SETTINGS.author;
      settings.barCollapsed = DEFAULT_SETTINGS.barCollapsed;
      settings.modes = { ...DEFAULT_SETTINGS.modes };
      settings.language = normalizeLanguage(deps.language);
      translator = createTranslator(settings.language);
      persist();
    },

    chrome: () => chromeOverride ?? settings.chromeLevel,

    chromeLevel: () =>
      chromeOverride ?? (narrow && settings.chromeLevel === "full" ? "quiet" : settings.chromeLevel),

    setChromeOverride: (level) => {
      chromeOverride = level;
    },

    updateWidth(width: number | undefined): boolean {
      if (typeof width !== "number") return false;
      const next = width > 0 && width <= NARROW_WIDTH;
      if (next === narrow) return false;
      narrow = next;
      return true;
    },

    dispose(): void {
      // Nothing to release: no node, no listener, no timer. The stored preference must survive
      // disable()/enable() (FR-4.5), so it is deliberately left in place.
    },
  };
}
