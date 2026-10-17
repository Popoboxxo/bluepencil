/**
 * Unit tests of the voice-dictation element wiring (FR-21).
 *
 * The composer-level behaviour lives in `voice.test.ts`; this file covers the path that matters for
 * a tag-embedded host: the `<bluepencil-notes>` attributes `voice` (FR-21.1) and `voice-engine`
 * (FR-21.6) reaching the layer, and the FR-21.2 rule that an explicitly requested but unsupported
 * dictation is reported through `element.issues` instead of silently rendering a dead mic button.
 *
 * Everything runs against the real custom element and a real jsdom document, with hand-written
 * engine fakes — no Web Speech API, no network. jsdom has no `SpeechRecognition`, which is exactly
 * the "unsupported platform" branch under test; the globals are cleared defensively so the suite is
 * independent of import order.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BluepencilNotesElement } from "../../src/element/index";
import type { VoiceEngine, VoiceErrorKind, VoiceResult } from "../../src/ui/voice";

/* -------------------------------------------------------------------------- */
/* test doubles                                                                */
/* -------------------------------------------------------------------------- */

class FakeEngine implements VoiceEngine {
  lang = "";
  continuous = false;
  interimResults = false;
  onResult: ((result: VoiceResult) => void) | null = null;
  onError: ((kind: VoiceErrorKind) => void) | null = null;
  onEnd: (() => void) | null = null;
  starts = 0;

  start(): void {
    this.starts += 1;
  }
  stop(): void {
    // nothing to do
  }
  abort(): void {
    // nothing to do
  }
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

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function mount(attributes: Record<string, string>): BluepencilNotesElement {
  const element = document.createElement("bluepencil-notes") as BluepencilNotesElement;
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  document.body.append(element);
  return element;
}

function query<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector(selector);
  if (found === null) throw new Error(`expected the layer to render ${selector}`);
  return found as T;
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function clearVoiceGlobals(): void {
  delete (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition;
  delete (globalThis as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
}

const UNSUPPORTED = "voice is enabled but this browser has no SpeechRecognition";

beforeEach(() => {
  document.body.innerHTML = "";
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  clearVoiceGlobals();
});

afterEach(() => {
  for (const element of [...document.querySelectorAll("bluepencil-notes")]) {
    (element as BluepencilNotesElement).destroy();
    element.remove();
  }
  delete (globalThis as { hostVoice?: unknown }).hostVoice;
  clearVoiceGlobals();
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  document.body.innerHTML = "";
});

/* -------------------------------------------------------------------------- */
/* FR-21.1 / FR-21.2 — opt-in and unsupported reporting                        */
/* -------------------------------------------------------------------------- */

describe("voice — element wiring (FR-21.1/FR-21.2)", () => {
  it("stays silent when the host explicitly disables voice", () => {
    document.body.innerHTML = `<main id="host"><p>host text</p></main>`;
    const element = mount({ adapter: "memory", voice: "false" });
    expect(element.issues).toEqual([]);
    expect(document.querySelector(".bp-voice")).toBeNull();
  });

  it("reports an explicitly requested but unsupported voice through element.issues and renders no mic", () => {
    document.body.innerHTML = `<main id="host"><p>host text</p></main>`;
    // No throw while building: the element catches its own configuration problems (FR-17).
    const element = mount({ adapter: "memory", voice: "true" });

    expect(element.blueprint).not.toBeNull();
    expect(element.issues.join(" | ")).toContain(UNSUPPORTED);
    // No dead mic button — the opt-in alone must not pretend dictation works.
    expect(document.querySelector(".bp-voice")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* FR-21.6 — voice-engine global path                                          */
/* -------------------------------------------------------------------------- */

describe("voice — element voice-engine wiring (FR-21.2/FR-21.6)", () => {
  it("uses a voice-engine factory resolved from a global path and shows the mic", () => {
    document.body.innerHTML = `<main id="host"><p>host text</p></main>`;
    const engine = new FakeEngine();
    (globalThis as { hostVoice?: unknown }).hostVoice = { engine: () => engine };
    const element = mount({ adapter: "memory", voice: "true", "voice-engine": "hostVoice.engine" });

    // The injected engine satisfies FR-21.2, so the "unsupported" issue must not appear.
    expect(element.issues.join(" | ")).not.toContain("no SpeechRecognition");
    const mic = query<HTMLButtonElement>(".bp-voice");
    click(mic);
    // Clicking the mic (the composer's own delegated action) really reaches the injected engine.
    expect(engine.starts).toBe(1);
  });

  it("reports a voice-engine path that does not resolve to a function", () => {
    document.body.innerHTML = `<main id="host"><p>host text</p></main>`;
    (globalThis as { hostVoice?: unknown }).hostVoice = { engine: "not a function" };
    const element = mount({ adapter: "memory", voice: "true", "voice-engine": "hostVoice.engine" });

    expect(element.issues.join(" | ")).toContain(
      'voice-engine "hostVoice.engine" does not resolve to a function',
    );
  });

  it("reports a voice-engine path that resolves to nothing", () => {
    document.body.innerHTML = `<main id="host"><p>host text</p></main>`;
    (globalThis as { hostVoice?: unknown }).hostVoice = {};
    const element = mount({ adapter: "memory", voice: "true", "voice-engine": "hostVoice.missing" });

    expect(element.issues.join(" | ")).toContain(
      'voice-engine "hostVoice.missing" does not resolve to a function',
    );
  });
});
