/**
 * Unit tests for the extracted settings unit (CQ-03 split, spec §3.13 L).
 *
 * The unit owns preferences, persistence, chrome level, the host mode ceiling and the translator.
 * These tests pin the behaviour the layer relied on before the split: host values beat stored ones
 * for the language (FR-10.3), a corrupt blob degrades to defaults (NFR-5), the one-load
 * `?bp-chrome=` override wins over the stored level without being persisted (FR-12.12), and a
 * narrow viewport behaves as `quiet` without touching the preference (FR-12.13).
 */

import { describe, expect, it } from "vitest";

import { createTranslator } from "../../src/i18n";
import { createLayerSettings } from "../../src/ui/layer-settings";
import { DEFAULT_SETTINGS } from "../../src/ui/panel";

interface FakeWindow {
  location: { host: string; search: string };
  localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  innerWidth: number;
}

function makeWindow(options: {
  host?: string;
  search?: string;
  stored?: string | null;
  width?: number;
} = {}): { window: Window; writes: { key: string; value: string }[] } {
  const writes: { key: string; value: string }[] = [];
  const store = new Map<string, string>();
  if (options.stored !== undefined && options.stored !== null) {
    store.set(`bluepencil:ui:${options.host ?? "local"}:v1`, options.stored);
  }
  const fake: FakeWindow = {
    location: { host: options.host ?? "", search: options.search ?? "" },
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, value);
        writes.push({ key, value });
      },
    },
    innerWidth: options.width ?? 1280,
  };
  return { window: fake as unknown as Window, writes };
}

describe("layer settings unit (FR-4.5/4.10/12.9/12.12/12.13)", () => {
  it("merges defaults, host options and stored values with the right precedence", () => {
    const { window } = makeWindow({
      stored: JSON.stringify({ showDone: true, language: "de", author: "Stored" }),
    });
    const unit = createLayerSettings({ view: window, language: "en", defaultShowDone: false, chrome: "quiet" });

    expect(unit.settings.showDone).toBe(true);
    // An explicit host language always wins over the persisted one (FR-10.3).
    expect(unit.settings.language).toBe("en");
    expect(unit.settings.author).toBe("Stored");
    expect(unit.settings.chromeLevel).toBe("quiet");
    expect(unit.t("bar.title")).toBe(createTranslator("en").t("bar.title"));
  });

  it("degrades a corrupt stored blob to the defaults instead of throwing (NFR-5)", () => {
    const { window } = makeWindow({ stored: "{not json" });
    const unit = createLayerSettings({ view: window });
    expect(unit.settings).toEqual({ ...DEFAULT_SETTINGS, language: DEFAULT_SETTINGS.language });
  });

  it("applies the one-load `?bp-chrome=` override without persisting it (FR-12.12)", () => {
    const { window, writes } = makeWindow({ search: "?bp-chrome=off", stored: JSON.stringify({ chromeLevel: "full" }) });
    const unit = createLayerSettings({ view: window, chrome: "full" });
    expect(unit.settings.chromeLevel).toBe("full");
    expect(unit.chrome()).toBe("off");
    expect(unit.chromeLevel()).toBe("off");

    unit.setChromeOverride(null);
    expect(unit.chrome()).toBe("full");
    expect(writes).toHaveLength(0);
  });

  it("yields a full level to quiet on a narrow viewport and reports the change (FR-12.13)", () => {
    const { window } = makeWindow({ width: 1280 });
    const unit = createLayerSettings({ view: window, chrome: "full" });
    expect(unit.chromeLevel()).toBe("full");
    expect(unit.updateWidth(600)).toBe(true);
    expect(unit.chromeLevel()).toBe("quiet");
    // The stored preference is untouched — a viewport fact, not a choice.
    expect(unit.settings.chromeLevel).toBe("full");
    expect(unit.updateWidth(600)).toBe(false);
    expect(unit.updateWidth(1024)).toBe(true);
    expect(unit.chromeLevel()).toBe("full");
  });

  it("persists a patch and follows a language switch with the translator (FR-4.5, FR-11.1)", () => {
    const { window, writes } = makeWindow({ host: "app.test", width: 1280 });
    const unit = createLayerSettings({ view: window });

    const result = unit.patch({ language: "de", showDone: true });

    expect(result.languageChanged).toBe(true);
    expect(unit.t("bar.title")).toBe(createTranslator("de").t("bar.title"));
    expect(writes.at(-1)?.key).toBe("bluepencil:ui:app.test:v1");
    expect(JSON.parse(writes.at(-1)?.value ?? "{}")).toMatchObject({ language: "de", showDone: true });
    // The same language is not a switch.
    expect(unit.patch({ language: "de" }).languageChanged).toBe(false);
  });

  it("resets to defaults but deliberately keeps the chrome level (existing behaviour)", () => {
    const { window } = makeWindow({ width: 1280 });
    const unit = createLayerSettings({ view: window, language: "en", chrome: "quiet" });
    unit.patch({ language: "de", showDone: true, author: "Dana" });

    unit.reset();

    expect(unit.settings.showDone).toBe(false);
    expect(unit.settings.author).toBe(DEFAULT_SETTINGS.author);
    expect(unit.settings.language).toBe("en");
    expect(unit.settings.chromeLevel).toBe("quiet");
    expect(unit.t("bar.title")).toBe(createTranslator("en").t("bar.title"));
  });

  it("normalises the host mode ceiling, including `none` and unknown entries (FR-4.10)", () => {
    const none = createLayerSettings({ modes: "none" });
    expect(none.hostModes).toEqual([]);
    expect(none.availableModes()).toEqual([]);
    expect(none.anyModeAvailable()).toBe(false);

    const filtered = createLayerSettings({ modes: ["text", "text", "bogus" as never] });
    expect(filtered.hostModes).toEqual(["text"]);
    expect(filtered.modeAvailable("text")).toBe(true);
    expect(filtered.modeAvailable("design")).toBe(false);

    const disabled = createLayerSettings();
    disabled.patch({ modes: { ...disabled.settings.modes, design: false } });
    expect(disabled.modeAvailable("design")).toBe(false);
    expect(disabled.availableModes()).not.toContain("design");
  });

  it("leaves the stored preference in place on dispose() (FR-4.5)", () => {
    const { window, writes } = makeWindow({ width: 1280 });
    const unit = createLayerSettings({ view: window });
    unit.patch({ showDone: true });
    const afterPatch = writes.length;

    unit.dispose();

    expect(writes.length).toBe(afterPatch);
    expect(unit.settings.showDone).toBe(true);
  });
});
