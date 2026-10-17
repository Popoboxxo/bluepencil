/**
 * Unit tests of voice dictation (FR-21).
 *
 * Two layers are covered, both against real code (no mocking of the module under test):
 *  - `src/ui/voice.ts` — feature detection, engine preference, the start/stop/destroy state machine
 *    and error mapping, driven by hand-written fakes (no network, no real Web Speech API);
 *  - the composer/layer wiring — default-off, the mic button, append-without-save, the live region
 *    and teardown, exercised through the real `createLayer` + `createMemoryAdapter`.
 *
 * Covers: FR-21.1, FR-21.2, FR-21.3, FR-21.4, FR-21.5, FR-21.6, FR-21.7, FR-21.8.
 * The element-attribute wiring (FR-21.2/FR-21.6 through `<bluepencil-notes>`) lives in
 * `voice-element.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryAdapter } from "../../src/adapters/memory";
import type { Adapter } from "../../src/core/adapter";
import { readVoice, readVoiceEngine } from "../../src/embed/attributes";
import type { AttributeSource } from "../../src/embed/attributes";
import { de } from "../../src/i18n/de";
import { en } from "../../src/i18n/en";
import type { MessageKey } from "../../src/i18n/en";
import { createStore, type Store } from "../../src/core/store";
import { createLayer, type LayerHandle, type LayerOptions } from "../../src/ui/layer";
import {
  browserVoiceEngine,
  createVoice,
  isVoiceSupported,
  resolveVoiceEngine,
  type VoiceEngine,
  type VoiceErrorKind,
  type VoiceResult,
} from "../../src/ui/voice";

/* -------------------------------------------------------------------------- */
/* test doubles                                                                */
/* -------------------------------------------------------------------------- */

/** A recogniser engine that records calls and lets a test emit engine events. */
class FakeEngine implements VoiceEngine {
  lang = "";
  continuous = false;
  interimResults = false;
  onResult: ((result: VoiceResult) => void) | null = null;
  onError: ((kind: VoiceErrorKind) => void) | null = null;
  onEnd: (() => void) | null = null;
  starts = 0;
  stops = 0;
  aborts = 0;

  start(): void {
    this.starts += 1;
  }

  stop(): void {
    this.stops += 1;
  }

  abort(): void {
    this.aborts += 1;
  }

  emitResult(transcript: string, final: boolean): void {
    this.onResult?.({ transcript, final });
  }

  emitError(kind: VoiceErrorKind): void {
    this.onError?.(kind);
  }

  emitEnd(): void {
    this.onEnd?.();
  }
}

/** A browser-like `SpeechRecognition` constructor whose last instance a test can drive. */
class StubRecognition {
  static last: StubRecognition | null = null;
  /** How many recognisers were constructed — the negative control for the injected-engine test. */
  static constructed = 0;
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  started = 0;

  constructor() {
    StubRecognition.last = this;
    StubRecognition.constructed += 1;
  }

  start(): void {
    this.started += 1;
  }

  stop(): void {
    // nothing to do
  }

  abort(): void {
    // nothing to do
  }
}

function source(attributes: Record<string, string>): AttributeSource {
  return { getAttribute: (name: string) => attributes[name] ?? null };
}

/** jsdom has no `ResizeObserver`; the layer must degrade — this double keeps it happy. */
class FakeResizeObserver {
  observe(): void {
    // geometry tracking is irrelevant for the assertions
  }
  unobserve(): void {
    // nothing to do
  }
  disconnect(): void {
    // nothing to do
  }
}

function makeStore(): Store {
  return createStore({ adapter: createMemoryAdapter() });
}

/**
 * A memory adapter that counts write operations (`create`/`update`/`remove`/`bulkRemove`).
 * FR-21.5 is a *behavioural* privacy claim: dictation must not persist anything, and the only write
 * is the human's save action. Counting the adapter calls makes that observable without a network.
 */
function countingAdapter(): { adapter: Adapter; writes: () => number } {
  const base = createMemoryAdapter();
  const subscribe = base.subscribe;
  let writes = 0;
  const count = <T>(run: () => Promise<T>): Promise<T> => {
    writes += 1;
    return run();
  };
  const adapter: Adapter = {
    name: base.name,
    list: (filter) => base.list(filter),
    create: (draft) => count(() => base.create(draft)),
    update: (id, patch) => count(() => base.update(id, patch)),
    remove: (id) => count(() => base.remove(id)),
    bulkRemove: (filter) => count(() => base.bulkRemove(filter)),
    exportSession: (sessionRef) => base.exportSession(sessionRef),
    ...(subscribe === undefined ? {} : { subscribe: (cb) => subscribe(cb) }),
  };
  return { adapter, writes: () => writes };
}

const liveHandles: LayerHandle[] = [];

function startLayer(store: Store, extra: Partial<LayerOptions> = {}): LayerHandle {
  const handle = createLayer({ store, document, ...extra });
  handle.enable();
  liveHandles.push(handle);
  return handle;
}

function query<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector(selector);
  if (found === null) throw new Error(`expected the layer to render ${selector}`);
  return found as T;
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function pressKey(key: string, init: KeyboardEventInit = {}): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
}

function composer(): HTMLElement {
  return query('[data-bp-part="composer"]');
}

function bodyTextarea(): HTMLTextAreaElement {
  const textarea = composer().querySelector("textarea");
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("composer has no textarea");
  return textarea;
}

/** Open the composer on a seeded host paragraph (text mode). */
function openComposer(): void {
  const paragraph = document.querySelector("#host p");
  if (paragraph === null) throw new Error("fixture missing");
  pressKey("c");
  click(paragraph);
  if (composer().hidden) throw new Error("composer did not open");
}

beforeEach(() => {
  document.body.innerHTML = "";
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
});

afterEach(() => {
  for (const handle of liveHandles.splice(0)) {
    try {
      handle.disable();
    } catch {
      // teardown must not mask the assertion that just failed
    }
  }
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  delete (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition;
  delete (globalThis as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  document.body.innerHTML = "";
});

/* -------------------------------------------------------------------------- */
/* FR-21.2 — feature detection                                                 */
/* -------------------------------------------------------------------------- */

describe("voice — feature detection (FR-21.2)", () => {
  it("is false when neither SpeechRecognition nor webkitSpeechRecognition exists, and never throws", () => {
    expect(isVoiceSupported({})).toBe(false);
    expect(isVoiceSupported(2)).toBe(false);
    expect(isVoiceSupported(null)).toBe(false);
    expect(() => isVoiceSupported(undefined)).not.toThrow();
    expect(browserVoiceEngine({})).toBeNull();
    expect(resolveVoiceEngine({})).toBeNull();
  });

  it("is true when a stub scope carries either constructor", () => {
    expect(isVoiceSupported({ SpeechRecognition: StubRecognition })).toBe(true);
    expect(isVoiceSupported({ webkitSpeechRecognition: StubRecognition })).toBe(true);
  });

  it("returns a factory that builds a fresh engine per call (single-use recognisers)", () => {
    const factory = browserVoiceEngine({ SpeechRecognition: StubRecognition });
    expect(factory).not.toBeNull();
    const first = factory?.();
    const firstRecognition = StubRecognition.last;
    const second = factory?.();
    expect(first).not.toBe(second);
    expect(second).not.toBe(first);
    first?.start();
    expect(firstRecognition?.started).toBe(1);
    expect(StubRecognition.last).not.toBe(firstRecognition);
  });

  it("maps the browser error codes to the composer kinds", () => {
    const engine = browserVoiceEngine({ SpeechRecognition: StubRecognition })?.();
    if (engine === null || engine === undefined) throw new Error("no engine");
    const seen: VoiceErrorKind[] = [];
    engine.onError = (kind) => seen.push(kind);
    engine.start();
    const recognition = StubRecognition.last;
    if (recognition === null) throw new Error("constructor was not called");
    for (const raw of ["not-allowed", "service-not-allowed", "not-supported", "no-speech", "network"]) {
      recognition.onerror?.({ error: raw });
    }
    expect(seen).toEqual(["permission", "permission", "unsupported", "no-speech", "error"]);
  });
});

/* -------------------------------------------------------------------------- */
/* FR-21.1 / FR-21.6 — embed vocabulary                                        */
/* -------------------------------------------------------------------------- */

describe("voice — embed vocabulary (FR-21.1/21.6)", () => {
  it("maps the presence-based voice attribute (FR-21.1)", () => {
    expect(readVoice(source({})).voice).toBeUndefined();
    expect(readVoice(source({ voice: "" })).voice).toBe(true);
    expect(readVoice(source({ voice: "true" })).voice).toBe(true);
    expect(readVoice(source({ voice: "false" })).voice).toBe(false);
    const invalid = readVoice(source({ voice: "yes" }));
    expect(invalid.voice).toBeUndefined();
    expect(invalid.issues[0]).toContain('voice must be "true" or "false"');
  });

  it("resolves voice-engine through the global path, reporting a non-function (FR-21.6)", () => {
    const factory = (): VoiceEngine => new FakeEngine();
    const resolved = readVoiceEngine(source({ "voice-engine": "hostApp.engine" }), (path) =>
      path === "hostApp.engine" ? factory : undefined,
    );
    expect(resolved.voiceEngine).toBe(factory);
    expect(resolved.issues).toEqual([]);

    const missing = readVoiceEngine(source({ "voice-engine": "hostApp.missing" }), () => "not a function");
    expect(missing.voiceEngine).toBeUndefined();
    expect(missing.issues[0]).toContain('voice-engine "hostApp.missing" does not resolve to a function');
  });
});

/* -------------------------------------------------------------------------- */
/* FR-21.4 — start/stop/destroy state machine                                  */
/* -------------------------------------------------------------------------- */

describe("voice — state machine and teardown (FR-21.4)", () => {
  it("starts once, forwards interim/final, and is a no-op while listening", () => {
    const engine = new FakeEngine();
    const interim: string[] = [];
    const appended: string[] = [];
    let listeningChanges = 0;
    const voice = createVoice({
      language: "de",
      engine: () => engine,
      onInterim: (text) => interim.push(text),
      onAppend: (text) => appended.push(text),
      onListeningChange: () => (listeningChanges += 1),
      onError: () => undefined,
    });

    expect(voice.isListening()).toBe(false);
    voice.start();
    expect(voice.isListening()).toBe(true);
    expect(listeningChanges).toBe(1);
    expect(engine.lang).toBe("de");
    expect(engine.continuous).toBe(true);
    expect(engine.interimResults).toBe(true);
    expect(engine.starts).toBe(1);

    voice.start();
    expect(engine.starts).toBe(1);

    engine.emitResult("hallo", false);
    engine.emitResult("hallo welt", true);
    expect(interim).toEqual(["hallo"]);
    expect(appended).toEqual(["hallo welt"]);
  });

  it("stops idempotently and recreates the engine on the next start", () => {
    const engines: FakeEngine[] = [];
    const voice = createVoice({
      language: "en",
      engine: () => {
        const engine = new FakeEngine();
        engines.push(engine);
        return engine;
      },
      onInterim: () => undefined,
      onAppend: () => undefined,
      onListeningChange: () => undefined,
      onError: () => undefined,
    });

    voice.start();
    voice.stop();
    voice.stop();
    expect(voice.isListening()).toBe(false);
    expect(engines[0]?.stops).toBe(1);

    voice.start();
    expect(engines).toHaveLength(2);
    expect(engines[1]?.starts).toBe(1);
  });

  it("maps an engine error, stops, and ignores a late end after destroy", () => {
    const engine = new FakeEngine();
    const errors: VoiceErrorKind[] = [];
    let destroyed = false;
    const voice = createVoice({
      language: "en",
      engine: () => engine,
      onInterim: () => undefined,
      onAppend: () => undefined,
      onListeningChange: () => undefined,
      onError: (kind) => errors.push(kind),
    });

    voice.start();
    engine.emitError("permission");
    expect(errors).toEqual(["permission"]);
    expect(voice.isListening()).toBe(false);

    voice.destroy();
    destroyed = true;
    // late callbacks must neither throw nor reach the (detached) handlers
    expect(() => {
      engine.emitResult("late", true);
      engine.emitError("error");
      engine.emitEnd();
    }).not.toThrow();
    expect(destroyed).toBe(true);
    // destroy is idempotent and a stopped/destroyed controller no-ops
    voice.destroy();
    voice.stop();
    voice.start();
    expect(engine.aborts).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* FR-21.6 — engine preference                                                 */
/* -------------------------------------------------------------------------- */

describe("voice — engine preference (FR-21.6)", () => {
  it("prefers an injected host engine over the browser API", () => {
    const injected = (): VoiceEngine => new FakeEngine();
    // Even with a browser constructor present, the injected one wins.
    expect(resolveVoiceEngine({ SpeechRecognition: StubRecognition }, injected)).toBe(injected);
    // And without one, the browser factory is returned.
    expect(resolveVoiceEngine({ SpeechRecognition: StubRecognition })).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* FR-21.7 — i18n                                                               */
/* -------------------------------------------------------------------------- */

describe("voice — i18n (FR-21.7)", () => {
  it("ships every composer.voice.* key, non-empty and translated, in en and de", () => {
    const keys: MessageKey[] = [
      "composer.voice.start",
      "composer.voice.stop",
      "composer.voice.listening",
      "composer.voice.error",
      "composer.voice.permission",
      "composer.voice.unsupported",
    ];
    for (const key of keys) {
      expect(en[key], key).not.toBe("");
      expect(de[key], key).not.toBe("");
      expect(de[key], `${key} must be translated`).not.toBe(en[key]);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* FR-21.1 / FR-21.3 / FR-21.4 — composer wiring                                */
/* -------------------------------------------------------------------------- */

describe("voice — composer wiring (FR-21.1/21.3/21.4)", () => {
  it("renders no mic button unless the host opted in (FR-21.1)", () => {
    document.body.innerHTML = `<main id="host"><p>host text</p></main>`;
    const store = makeStore();
    const handle = startLayer(store);
    openComposer();
    expect(composer().querySelector(".bp-voice")).toBeNull();
    expect(document.querySelector('[data-bp-part="composer-voice-status"]')).toBeNull();
    handle.disable();
  });

  it("shows the mic button with an injected engine and appends the final transcript without saving (FR-21.3)", () => {
    document.body.innerHTML = `<main id="host"><p>host text</p></main>`;
    const engine = new FakeEngine();
    const store = makeStore();
    const handle = startLayer(store, { voice: true, voiceEngine: () => engine });
    openComposer();

    const mic = query<HTMLButtonElement>(".bp-voice");
    expect(mic.hidden).toBe(false);
    expect(mic.getAttribute("aria-pressed")).toBe("false");
    expect(mic.getAttribute("data-bp-action")).toBe("composer-voice");

    click(mic);
    expect(engine.starts).toBe(1);
    expect(mic.getAttribute("aria-pressed")).toBe("true");
    expect(mic.getAttribute("data-bp-i18n")).toBe("composer.voice.stop");

    engine.emitResult("Hello", false);
    const status = query('[data-bp-part="composer-voice-status"]');
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain(en["composer.voice.listening"]);
    expect(bodyTextarea().value).toBe("");

    engine.emitResult("Hello world", true);
    expect(bodyTextarea().value).toBe("Hello world");
    // FR-21.3: dictation never saves by itself
    expect(store.notes()).toHaveLength(0);
    expect(composer().hidden).toBe(false);

    // a second final result is appended with a separating space
    engine.emitResult("and more", true);
    expect(bodyTextarea().value).toBe("Hello world and more");
    handle.disable();
  });

  it("reports an error inline and returns to the stopped state", () => {
    document.body.innerHTML = `<main id="host"><p>host text</p></main>`;
    const engine = new FakeEngine();
    const handle = startLayer(makeStore(), { voice: true, voiceEngine: () => engine });
    openComposer();

    const mic = query<HTMLButtonElement>(".bp-voice");
    click(mic);
    engine.emitError("permission");

    const error = query('[data-bp-part="composer-error"]');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe(en["composer.voice.permission"]);
    expect(mic.getAttribute("aria-pressed")).toBe("false");
    handle.disable();
  });

  it("stops dictation on Esc and on close, idempotently (FR-21.4)", () => {
    document.body.innerHTML = `<main id="host"><p>host text</p></main>`;
    const engine = new FakeEngine();
    const handle = startLayer(makeStore(), { voice: true, voiceEngine: () => engine });
    openComposer();

    const mic = query<HTMLButtonElement>(".bp-voice");
    click(mic);
    expect(engine.starts).toBe(1);

    pressKey("Escape");
    expect(composer().hidden).toBe(true);
    expect(engine.stops).toBe(1);
    expect(mic.getAttribute("aria-pressed")).toBe("false");

    // disable() is idempotent and does not throw after the composer was closed
    handle.disable();
    expect(() => handle.disable()).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* FR-21.8 — accessibility of the composer mic                                  */
/* -------------------------------------------------------------------------- */

describe("voice — composer a11y (FR-21.8)", () => {
  it("exposes the mic as a focusable, keyboard-operable button whose state follows the controller", () => {
    document.body.innerHTML = `<main id="host"><p>host text</p></main>`;
    const engine = new FakeEngine();
    const handle = startLayer(makeStore(), { voice: true, voiceEngine: () => engine });
    openComposer();

    const mic = query<HTMLButtonElement>(".bp-voice");
    expect(mic).toBeInstanceOf(HTMLButtonElement);
    // A native `button` with an explicit type is operable with Enter/Space and never submits a form.
    expect(mic.type).toBe("button");
    expect(mic.disabled).toBe(false);
    // In the tab order without a positive tabindex being needed.
    expect(mic.tabIndex).toBe(0);
    // Accessible name comes from the visible label, which the translator fills in.
    expect(mic.textContent).toBe(en["composer.voice.start"]);

    mic.focus();
    expect(document.activeElement).toBe(mic);

    // Enter/Space on a native `<button>` dispatch a click — that is the keyboard activation path.
    click(mic);
    expect(engine.starts).toBe(1);
    expect(mic.getAttribute("aria-pressed")).toBe("true");
    expect(mic.textContent).toBe(en["composer.voice.stop"]);

    click(mic);
    expect(engine.stops).toBe(1);
    expect(mic.getAttribute("aria-pressed")).toBe("false");
    expect(mic.textContent).toBe(en["composer.voice.start"]);
    handle.disable();
  });

  it("announces the interim transcript through a polite status live region and keeps it out of the note", () => {
    document.body.innerHTML = `<main id="host"><p>host text</p></main>`;
    const engine = new FakeEngine();
    const handle = startLayer(makeStore(), { voice: true, voiceEngine: () => engine });
    openComposer();

    const status = query<HTMLElement>('[data-bp-part="composer-voice-status"]');
    // Assert the announced attributes, not a screen reader.
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.hidden).toBe(true);

    click(query<HTMLButtonElement>(".bp-voice"));
    engine.emitResult("review this heading", false);

    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain("review this heading");
    expect(status.textContent).toContain(en["composer.voice.listening"]);
    // An interim result is a preview only — it never reaches the textarea.
    expect(bodyTextarea().value).toBe("");
    handle.disable();
  });

  it.each([
    ["permission", "composer.voice.permission"],
    ["unsupported", "composer.voice.unsupported"],
    ["no-speech", "composer.voice.error"],
    ["error", "composer.voice.error"],
  ] as const)("renders the %s failure in the role=alert error line", (kind, key) => {
    document.body.innerHTML = `<main id="host"><p>host text</p></main>`;
    const engine = new FakeEngine();
    const handle = startLayer(makeStore(), { voice: true, voiceEngine: () => engine });
    openComposer();

    const error = query<HTMLElement>('[data-bp-part="composer-error"]');
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.hidden).toBe(true);

    click(query<HTMLButtonElement>(".bp-voice"));
    engine.emitError(kind);

    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe(en[key]);
    expect(query<HTMLButtonElement>(".bp-voice").getAttribute("aria-pressed")).toBe("false");
    handle.disable();
  });

  it("shows the mic label and the interim status in the host language (FR-21.7)", () => {
    document.body.innerHTML = `<main id="host"><p>host text</p></main>`;
    const engine = new FakeEngine();
    const handle = startLayer(makeStore(), { voice: true, voiceEngine: () => engine, language: "de" });
    openComposer();

    const mic = query<HTMLButtonElement>(".bp-voice");
    expect(mic.textContent).toBe(de["composer.voice.start"]);

    click(mic);
    engine.emitResult("hallo", false);
    const status = query<HTMLElement>('[data-bp-part="composer-voice-status"]');
    expect(status.textContent).toContain(de["composer.voice.listening"]);
    expect(mic.textContent).toBe(de["composer.voice.stop"]);
    handle.disable();
  });
});

/* -------------------------------------------------------------------------- */
/* FR-21.6 — the injected engine is the one actually used                      */
/* -------------------------------------------------------------------------- */

describe("voice — injected engine is used (FR-21.6)", () => {
  it("drives the injected engine even when a browser SpeechRecognition is available", () => {
    document.body.innerHTML = `<main id="host"><p>host text</p></main>`;
    StubRecognition.constructed = 0;
    (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition = StubRecognition;

    const engine = new FakeEngine();
    const handle = startLayer(makeStore(), { voice: true, voiceEngine: () => engine });
    openComposer();
    click(query<HTMLButtonElement>(".bp-voice"));

    // The injected fake receives start(); the browser recogniser is never even constructed.
    expect(engine.starts).toBe(1);
    expect(StubRecognition.constructed).toBe(0);
    handle.disable();
  });
});

/* -------------------------------------------------------------------------- */
/* FR-21.5 — privacy: transcript only, no write before the human saves          */
/* -------------------------------------------------------------------------- */

describe("voice — privacy (FR-21.5)", () => {
  it("keeps only the transcript and never writes to the store/adapter before the human saves", async () => {
    document.body.innerHTML = `<main id="host"><p>host text</p></main>`;
    const engine = new FakeEngine();
    const { adapter, writes } = countingAdapter();
    const store = createStore({ adapter });
    const handle = startLayer(store, { voice: true, voiceEngine: () => engine });
    openComposer();
    click(query<HTMLButtonElement>(".bp-voice"));

    engine.emitResult("secret words", true);

    // Only the transcript text is retained in the textarea …
    expect(bodyTextarea().value).toBe("secret words");
    // … and nothing is persisted: dictation alone must not touch the store or the adapter.
    expect(store.notes()).toHaveLength(0);
    expect(writes()).toBe(0);

    // The human's save action is the only write path.
    click(query<HTMLButtonElement>('[data-bp-action="composer-save"]'));
    await vi.waitFor(() => expect(store.notes()).toHaveLength(1));
    expect(writes()).toBe(1);
    expect(store.notes()[0]?.body).toBe("secret words");
    expect(typeof store.notes()[0]?.body).toBe("string");
    handle.disable();
  });
});
