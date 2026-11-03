/**
 * Voice-dictation removal (G13) — AC-G01, AC-G02, AC-G04, AC-G05 and the element half of AC-G03.
 *
 * These assertions describe what must *not* exist after 0.12.0: the `src/ui/voice.ts` module, every
 * import of it, the composer mic button/live region, the `composer.voice.*` messages, the
 * `voice`/`voice-engine` attribute vocabulary and every runnable surface (example, smoke script,
 * npm script, components matrix). The attribute point is deliberately different from the removed
 * `token*` attributes: an old `voice` attribute is **silently ignored** — no throw, no layout change
 * and, above all, no `element.issues` entry (ADR-0.12-S3 vs G13).
 *
 * The loader-forwarding half of AC-G03 lives with the loader suite (`tests/unit/embed.test.ts`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryAdapter } from "../../src/adapters/memory";
import { createStore } from "../../src/core/store";
import {
  ALL_ATTRIBUTES,
  type AttributeName,
} from "../../src/embed/attributes";
import { BluepencilNotesElement } from "../../src/element/index";
import { de } from "../../src/i18n/de";
import { en, type MessageKey } from "../../src/i18n/en";
import { createLayer, type LayerHandle, type LayerOptions } from "../../src/ui/layer";

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

const ROOT = process.cwd();

/** Every `.ts` file below the given repository-relative directory. */
function sources(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.endsWith(".ts")) files.push(path);
    }
  };
  walk(join(ROOT, dir));
  return files;
}

/** jsdom has no `ResizeObserver`; the layer must degrade — this double keeps it happy. */
class FakeResizeObserver {
  observe(): void {
    // geometry tracking is irrelevant for these assertions
  }
  unobserve(): void {
    // nothing to do
  }
  disconnect(): void {
    // nothing to do
  }
}

/** A constructor that records every construction; the removed feature must never reach it. */
class CountingRecognition {
  static constructed = 0;
  constructor() {
    CountingRecognition.constructed += 1;
  }
}

function query<T extends Element = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

function fixture(): void {
  document.body.innerHTML = `<main id="host"><h1 data-bluepencil="target">Host</h1></main>`;
}

beforeEach(() => {
  fixture();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  CountingRecognition.constructed = 0;
  (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition = CountingRecognition;
  (globalThis as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = CountingRecognition;
});

afterEach(() => {
  for (const element of [...document.querySelectorAll("bluepencil-notes")]) {
    (element as BluepencilNotesElement).destroy();
    element.remove();
  }
  delete (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition;
  delete (globalThis as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  document.body.innerHTML = "";
});

/* -------------------------------------------------------------------------- */
/* AC-G01 — the module and its imports are gone                                */
/* -------------------------------------------------------------------------- */

describe("voice removal — the module is gone (AC-G01)", () => {
  it("has no src/ui/voice.ts", () => {
    expect(existsSync(join(ROOT, "src", "ui", "voice.ts"))).toBe(false);
  });

  it("leaves no production source that mentions voice or imports the removed module", () => {
    const offenders = sources("src")
      .filter((path) => /voice/i.test(readFileSync(path, "utf8")))
      .map((path) => path.replace(`${ROOT}/`, ""));
    expect(offenders).toEqual([]);
  });

  it("rejects the removed layer options at the type level", () => {
    // @ts-expect-error — `voice` is no longer part of LayerOptions (G13)
    const voiceOption: Partial<LayerOptions> = { voice: true };
    // @ts-expect-error — `voiceEngine` is no longer part of LayerOptions (G13)
    const engineOption: Partial<LayerOptions> = { voiceEngine: () => undefined };
    expect(voiceOption).toBeDefined();
    expect(engineOption).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* AC-G02 — no mic button, no recognition listener, idempotent teardown        */
/* -------------------------------------------------------------------------- */

describe("voice removal — the composer has no dictation UI (AC-G02)", () => {
  let layer: LayerHandle | null = null;

  afterEach(() => {
    layer?.disable();
    layer = null;
  });

  it("mounts without a mic button, a status region, a recogniser or a permission prompt", () => {
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    const store = createStore({ adapter: createMemoryAdapter() });
    layer = createLayer({ store, document, mount: document.body, language: "en" });
    layer.enable();

    expect(query(".bp-composer")).not.toBeNull();
    expect(query(".bp-voice")).toBeNull();
    expect(query('[data-bp-action="composer-voice"]')).toBeNull();
    expect(query('[data-bp-part="composer-voice-status"]')).toBeNull();
    // Nothing asked the platform for a recogniser, let alone a microphone.
    expect(CountingRecognition.constructed).toBe(0);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("keeps teardown idempotent and still dictation-free after a re-enable", () => {
    const store = createStore({ adapter: createMemoryAdapter() });
    layer = createLayer({ store, document, mount: document.body, language: "en" });

    layer.enable();
    expect(() => {
      layer?.disable();
      layer?.disable();
    }).not.toThrow();
    expect(query(".bp-composer")).toBeNull();

    layer.enable();
    expect(query(".bp-composer")).not.toBeNull();
    expect(query(".bp-voice")).toBeNull();
    expect(CountingRecognition.constructed).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* AC-G04 — no voice messages remain                                          */
/* -------------------------------------------------------------------------- */

describe("voice removal — no i18n keys remain (AC-G04)", () => {
  it("has no voice keys in either language table", () => {
    expect(Object.keys(en).filter((key) => /voice/i.test(key))).toEqual([]);
    expect(Object.keys(de).filter((key) => /voice/i.test(key))).toEqual([]);
  });

  it("rejects a removed message key at the type level", () => {
    // @ts-expect-error — `composer.voice.start` is not a MessageKey any more (G13)
    const removedKey: MessageKey = "composer.voice.start";
    expect(removedKey).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* AC-G05 — example, smoke script, npm script and matrix entry are gone        */
/* -------------------------------------------------------------------------- */

describe("voice removal — the example, smoke script and matrix entry are gone (AC-G05)", () => {
  it("deletes examples/voice and scripts/voice-smoke.mjs", () => {
    expect(existsSync(join(ROOT, "examples", "voice"))).toBe(false);
    expect(existsSync(join(ROOT, "scripts", "voice-smoke.mjs"))).toBe(false);
  });

  it("removes the npm script and keeps smoke:components as the binding entry", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["smoke:voice"]).toBeUndefined();
    expect(Object.keys(pkg.scripts).filter((key) => /voice/i.test(key))).toEqual([]);
    expect(pkg.scripts["smoke:components"]).toBe("node scripts/components-e2e.mjs");
  });

  it("drops the voice component from the e2e manifest and its coverage list", () => {
    const runner = readFileSync(join(ROOT, "scripts", "components-e2e.mjs"), "utf8");
    expect(runner).not.toMatch(/\bid:\s*"voice"/);
    expect(runner).not.toMatch(/covers:\s*\[[^\]]*"voice"/);
    expect(runner).not.toContain("voice-smoke.mjs");
  });

  it("leaves no voice row or script claim in the binding coverage doc", () => {
    const doc = readFileSync(join(ROOT, "docs", "E2E-COVERAGE.md"), "utf8");
    expect(doc).not.toMatch(/`voice`/);
    expect(doc).not.toContain("smoke:voice");
  });

  it("leaves no smoke:voice step in the CI workflow", () => {
    const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).not.toContain("smoke:voice");
    expect(ci).not.toContain("voice-smoke");
  });
});

/* -------------------------------------------------------------------------- */
/* AC-G03 (G1 half) — old attributes are silently ignored                      */
/* -------------------------------------------------------------------------- */

describe("voice removal — old attributes are silently ignored (AC-G03)", () => {
  it("drops voice and voice-engine from the attribute vocabulary", () => {
    expect(ALL_ATTRIBUTES).not.toContain("voice");
    expect(ALL_ATTRIBUTES).not.toContain("voice-engine");
    // @ts-expect-error — `voice` is not an AttributeName any more (G13)
    const voiceName: AttributeName = "voice";
    // @ts-expect-error — `voice-engine` is not an AttributeName any more (G13)
    const engineName: AttributeName = "voice-engine";
    expect(voiceName).toBe("voice");
    expect(engineName).toBe("voice-engine");
  });

  it("mounts a page that still carries voice attributes without an issue or a mic", () => {
    (globalThis as { hostVoice?: unknown }).hostVoice = { engine: () => undefined };
    const element = document.createElement("bluepencil-notes") as BluepencilNotesElement;
    element.setAttribute("adapter", "memory");
    element.setAttribute("voice", "true");
    element.setAttribute("voice-engine", "hostVoice.engine");
    document.body.append(element);

    // Silent ignore: no config error, no "unsupported" note, no layout change.
    expect(element.issues).toEqual([]);
    expect(query(".bp-voice")).toBeNull();
    expect(query('[data-bp-action="composer-voice"]')).toBeNull();
    delete (globalThis as { hostVoice?: unknown }).hostVoice;
  });
});
