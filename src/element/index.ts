/**
 * `<bluepencil-notes>` — the no-bundler build (FR-12.5, NFR-16).
 *
 * Load the module as a resource (static page, CMS, Home Assistant frontend resource) and drop
 * the element anywhere; attributes map to config and events carry everything the host needs.
 * It is a thin wrapper around the same core — no second implementation.
 *
 *   <script type="module" src="/bluepencil.element.js"></script>
 *   <bluepencil-notes adapter="localStorage" language="de" theme-accent="#8c3b2e"></bluepencil-notes>
 *
 * Attributes: enabled, adapter, language, identity, session, environment, show-done,
 *             theme-accent, theme-surface, mount
 * Events:     bp-enabled, bp-disabled, bp-notes-changed, bp-export, bp-error
 */
import type { AdapterLike } from "../core/adapter";
import type { Environment, Note } from "../core/model";
import { createBlueprint, type Blueprint, type BlueprintConfig } from "../index";

const OBSERVED = [
  "enabled",
  "adapter",
  "language",
  "identity",
  "session",
  "environment",
  "show-done",
  "theme-accent",
  "theme-surface",
  "mount",
] as const;

export class BluepencilNotesElement extends HTMLElement {
  static readonly tagName = "bluepencil-notes";

  #blueprint: Blueprint | null = null;
  #unsubscribe: (() => void) | null = null;

  static get observedAttributes(): readonly string[] {
    return OBSERVED;
  }

  connectedCallback(): void {
    let blueprint = this.#blueprint;
    if (!blueprint) {
      this.#start();
      blueprint = this.#blueprint;
    }
    if (blueprint && this.getAttribute("enabled") !== "false") {
      const started = blueprint.enable();
      this.dispatchEvent(new CustomEvent("bp-enabled", { detail: { started } }));
    }
  }

  disconnectedCallback(): void {
    // The host may move the element around; stop the UI but keep the data set.
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#blueprint?.disable();
    this.dispatchEvent(new CustomEvent("bp-disabled"));
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue || !this.#blueprint) {
      return;
    }
    if (name === "enabled") {
      if (newValue === "false") {
        this.#blueprint.disable();
        this.dispatchEvent(new CustomEvent("bp-disabled"));
      } else {
        const started = this.#blueprint.enable();
        this.dispatchEvent(new CustomEvent("bp-enabled", { detail: { started } }));
      }
      return;
    }
    // Any other attribute is structural: rebuild the instance with the new configuration.
    this.#rebuild();
  }

  get blueprint(): Blueprint | null {
    return this.#blueprint;
  }

  /** Export the current set as a string and announce it as an event (host hook). */
  exportNotes(format: "markdown" | "json" = "markdown"): string {
    const text = this.#blueprint?.export({ format }) ?? "";
    this.dispatchEvent(new CustomEvent("bp-export", { detail: { format, text } }));
    return text;
  }

  #start(): void {
    this.#blueprint = createBlueprint(this.#config());
    this.#unsubscribe = this.#blueprint.store.subscribe((notes) => this.#emitNotes(notes));
  }

  #rebuild(): void {
    const wasEnabled = this.#blueprint?.isEnabled() ?? false;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    void this.#blueprint?.destroy();
    this.#blueprint = null;
    this.#start();
    if (wasEnabled) {
      this.#enableIfPresent();
    }
  }

  /** Separate method so TypeScript cannot carry its assignment narrowing across the call. */
  #enableIfPresent(): void {
    const blueprint = this.#blueprint;
    if (blueprint) {
      blueprint.enable();
    }
  }

  #emitNotes(notes: Note[]): void {
    this.dispatchEvent(new CustomEvent("bp-notes-changed", { detail: { count: notes.length, notes } }));
  }

  #config(): BlueprintConfig {
    const theme: Record<string, string> = {};
    const accent = this.getAttribute("theme-accent");
    const surface = this.getAttribute("theme-surface");
    if (accent) theme.accent = accent;
    if (surface) theme.surface = surface;

    const mountAttr = this.getAttribute("mount");
    const root = this.getRootNode() as Document | ShadowRoot;
    const mountTarget = mountAttr ? (root.querySelector?.(mountAttr) as Element | null) : null;

    const config: BlueprintConfig = {
      enabled: () => this.getAttribute("enabled") !== "false",
      autoEnable: false,
      defaultShowDone: this.getAttribute("show-done") === "true",
      ...(this.getAttribute("adapter") ? { adapter: this.getAttribute("adapter") as AdapterLike } : {}),
      ...(this.getAttribute("language") ? { language: this.getAttribute("language") as string } : {}),
      ...(Object.keys(theme).length > 0 ? { theme } : {}),
      ...(this.getAttribute("session") ? { sessionRef: this.getAttribute("session") as string } : {}),
      ...(this.getAttribute("environment")
        ? { environment: this.getAttribute("environment") as Environment }
        : {}),
      ...(mountTarget ? { mount: mountTarget } : {}),
      onError: (error: unknown) => this.dispatchEvent(new CustomEvent("bp-error", { detail: error })),
    };
    const identity = this.getAttribute("identity");
    if (identity === "prompt" || identity === "anonymous") {
      config.identity = identity;
    }
    return config;
  }
}

/** Register the element once (idempotent — safe even if several hosts import this module). */
export function defineBluepencilElement(tagName: string = BluepencilNotesElement.tagName): void {
  if (typeof customElements === "undefined" || customElements.get(tagName)) {
    return;
  }
  customElements.define(tagName, BluepencilNotesElement);
}

defineBluepencilElement();
