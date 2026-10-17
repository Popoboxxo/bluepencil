/**
 * Voice dictation adapter (FR-21) — a thin, dependency-free, DOM-light wrapper over the Web Speech
 * API (FR-21.2) with an injectable engine so the core stays offline-capable and dependency-free
 * (FR-21.6).
 *
 * Two layers of indirection exist for a reason:
 *  - `VoiceEngine` is the *minimal* surface the composer needs. A browser `SpeechRecognition` is
 *    adapted to it, and a host may supply its own implementation (a local Whisper worker, a
 *    cloud recogniser) without the core ever knowing (FR-21.6).
 *  - `createVoice()` owns the *state machine* (start/stop/destroy, idempotent teardown — FR-21.4)
 *    and reports transcripts through callbacks only. It never touches the DOM: appending the final
 *    transcript is the caller's job (FR-21.3).
 *
 * Nothing here runs at import time (NFR-1): `createVoice` is only reached when a host opted in, and
 * the browser engine is created lazily on `start()`. A stopped `SpeechRecognition` is single-use in
 * Chromium, so a fresh engine is built for every start.
 */

/** Why dictation ended — mapped from the engine's error codes for the composer's inline alert. */
export type VoiceErrorKind = "permission" | "unsupported" | "error" | "no-speech";

/** One recognition result; `final` distinguishes an interim preview from an appendable transcript. */
export interface VoiceResult {
  readonly transcript: string;
  readonly final: boolean;
}

/** Minimal surface the composer needs — a browser `SpeechRecognition` or a host-injected engine. */
export interface VoiceEngine {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onResult: ((result: VoiceResult) => void) | null;
  onError: ((kind: VoiceErrorKind) => void) | null;
  onEnd: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

/** Builds a fresh engine per call — a browser recogniser cannot be restarted once it ended. */
export type VoiceEngineFactory = () => VoiceEngine;

/** Structural shape of a browser `SpeechRecognition`, kept local so this module needs no DOM types. */
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The browser's own recognition constructor, or `null` when the platform has none.
 * `webkitSpeechRecognition` is the Chromium/Safari spelling; the specced name wins when both exist.
 */
function speechRecognitionCtor(scope: unknown): SpeechRecognitionCtor | null {
  try {
    const candidate = (scope ?? globalThis) as {
      SpeechRecognition?: unknown;
      webkitSpeechRecognition?: unknown;
    };
    const ctor = candidate.SpeechRecognition ?? candidate.webkitSpeechRecognition;
    return typeof ctor === "function" ? (ctor as SpeechRecognitionCtor) : null;
  } catch {
    // A locked-down global must degrade to "unsupported" (FR-21.2), never throw.
    return null;
  }
}

/** Feature detection (FR-21.2): true when a browser engine exists (never throws). */
export function isVoiceSupported(scope?: unknown): boolean {
  return speechRecognitionCtor(scope) !== null;
}

/** Maps a raw engine error code to the kind the composer reports (FR-21.8). */
function mapVoiceError(raw: unknown): VoiceErrorKind {
  switch (raw) {
    case "not-allowed":
    case "service-not-allowed":
      return "permission";
    case "not-supported":
    case "unsupported":
      return "unsupported";
    case "no-speech":
      return "no-speech";
    default:
      return "error";
  }
}

/** Reads `event.results[event.resultIndex]` into a `VoiceResult`; malformed events are ignored. */
function resultFromEvent(event: unknown): VoiceResult | null {
  if (!isRecord(event)) return null;
  const results = event.results as ArrayLike<unknown> | undefined;
  if (results === undefined || results === null) return null;
  const rawIndex = event.resultIndex;
  const index = typeof rawIndex === "number" ? rawIndex : results.length - 1;
  const result = results[index];
  if (!isRecord(result)) return null;
  const alternatives = result as unknown as ArrayLike<{ transcript?: unknown }> & { isFinal?: unknown };
  const first = alternatives[0];
  const transcript = typeof first?.transcript === "string" ? first.transcript : "";
  return { transcript, final: alternatives.isFinal === true };
}

/** Wraps one browser recognition instance in the `VoiceEngine` surface. */
function createBrowserEngine(ctor: SpeechRecognitionCtor): VoiceEngine {
  const recognition = new ctor();
  const engine: VoiceEngine = {
    lang: "",
    continuous: false,
    interimResults: false,
    onResult: null,
    onError: null,
    onEnd: null,
    start(): void {
      // Push the composer's preferences onto the recogniser, then bridge the event API to the
      // callback surface. Re-installed on every start because the handlers close over `engine`.
      recognition.lang = engine.lang;
      recognition.continuous = engine.continuous;
      recognition.interimResults = engine.interimResults;
      recognition.onresult = (event: unknown) => {
        const result = resultFromEvent(event);
        if (result !== null) engine.onResult?.(result);
      };
      recognition.onerror = (event: unknown) => {
        engine.onError?.(mapVoiceError(isRecord(event) ? event.error : undefined));
      };
      recognition.onend = () => {
        engine.onEnd?.();
      };
      recognition.start();
    },
    stop(): void {
      recognition.stop();
    },
    abort(): void {
      recognition.abort();
    },
  };
  return engine;
}

/** Browser-backed factory, or `null` when unsupported (FR-21.2). Never throws. */
export function browserVoiceEngine(scope?: unknown): VoiceEngineFactory | null {
  const ctor = speechRecognitionCtor(scope);
  if (ctor === null) return null;
  return () => createBrowserEngine(ctor);
}

/** Preference: an injected host engine wins; otherwise the browser engine (FR-21.6). */
export function resolveVoiceEngine(
  scope?: unknown,
  injected?: VoiceEngineFactory,
): VoiceEngineFactory | null {
  if (typeof injected === "function") return injected;
  return browserVoiceEngine(scope);
}

export interface VoiceOptions {
  /** Engine language tag set on `lang` (e.g. "de" / "en"). */
  language: string;
  engine: VoiceEngineFactory;
  /** Live region text (FR-21.3) — the caller decides whether an empty string is rendered. */
  onInterim(text: string): void;
  /** Final transcript to append to the textarea (FR-21.3) — the caller owns the DOM write. */
  onAppend(text: string): void;
  /** Start/stop state changed (FR-21.8): `aria-pressed` and the label follow this. */
  onListeningChange(): void;
  /** Recognition failed (FR-21.8); the caller maps the kind to an inline message. */
  onError(error: VoiceErrorKind): void;
}

export interface Voice {
  start(): void;
  stop(): void;
  toggle(): void;
  isListening(): boolean;
  destroy(): void;
}

/**
 * State machine around a (possibly host-injected) engine.
 *
 * Teardown is idempotent (FR-21.4): `stop()` on a stopped controller, a second `destroy()` and any
 * late `onResult`/`onError`/`onEnd` after `destroy()` are all no-ops. The engine is created lazily
 * on `start()` and released on `stop()`/`destroy()`, so a restarted dictation gets a fresh
 * recogniser (Chromium recognisers are single-use).
 */
export function createVoice(options: VoiceOptions): Voice {
  let engine: VoiceEngine | null = null;
  let listening = false;
  let destroyed = false;

  function notifyListeningChange(): void {
    if (!destroyed) options.onListeningChange();
  }

  /** Detaches the callbacks and aborts the current engine; safe to call twice. */
  function releaseEngine(): VoiceEngine | null {
    const current = engine;
    engine = null;
    if (current === null) return null;
    current.onResult = null;
    current.onError = null;
    current.onEnd = null;
    return current;
  }

  function start(): void {
    if (destroyed || listening) return;
    let next: VoiceEngine;
    try {
      next = options.engine();
    } catch {
      // A host factory that throws is reported, never propagated into the composer (FR-21.2/NFR-14).
      options.onError("error");
      return;
    }
    next.lang = options.language;
    next.continuous = true;
    next.interimResults = true;
    next.onResult = (result: VoiceResult) => {
      if (destroyed) return;
      if (result.final) options.onAppend(result.transcript);
      else options.onInterim(result.transcript);
    };
    next.onError = (kind: VoiceErrorKind) => {
      if (destroyed) return;
      listening = false;
      const current = releaseEngine();
      notifyListeningChange();
      // A recogniser that reported an error may still hold the microphone: abort it explicitly so a
      // subsequent start() gets a clean one (Chromium recognisers are single-use).
      if (current !== null) {
        try {
          current.abort();
        } catch {
          // Already ended — the detached callbacks mean nothing can reach the composer.
        }
      }
      options.onError(kind);
    };
    next.onEnd = () => {
      if (destroyed) return;
      listening = false;
      // The engine ended on its own (silence, remote stop): release it so the next start is fresh.
      releaseEngine();
      notifyListeningChange();
    };
    engine = next;
    listening = true;
    try {
      next.start();
    } catch {
      listening = false;
      releaseEngine();
      notifyListeningChange();
      options.onError("error");
      return;
    }
    notifyListeningChange();
  }

  function stop(): void {
    if (destroyed || !listening) return;
    listening = false;
    const current = releaseEngine();
    notifyListeningChange();
    if (current !== null) {
      try {
        current.stop();
      } catch {
        // A recogniser that already ended rejects a late stop; the state is already torn down.
      }
    }
  }

  return {
    start,
    stop,
    toggle(): void {
      if (listening) stop();
      else start();
    },
    isListening: () => listening,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      listening = false;
      const current = releaseEngine();
      if (current !== null) {
        try {
          current.abort();
        } catch {
          // Late callbacks are already detached above, so nothing can reach the composer.
        }
      }
    },
  };
}
