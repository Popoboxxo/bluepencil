/**
 * `<bluepencil-notes>` — the no-bundler build (FR-12.5, NFR-16) and the attach surface of FR-17.
 *
 * Load the module as a resource (static page, CMS, Home Assistant frontend resource, a loader
 * script) and drop the element anywhere; attributes map to config, events carry everything the
 * host needs. It is a thin wrapper around the same core — no second implementation.
 *
 *   <script type="module" src="/bluepencil.element.min.js"></script>
 *   <bluepencil-notes adapter="localStorage" language="de" theme-accent="#8c3b2e"></bluepencil-notes>
 *   <bluepencil-notes endpoint="/api/v1/bluepencil" token="…" environment="dev"></bluepencil-notes>
 *
 * Attributes (single source of truth: `src/embed/attributes.ts`): enabled, adapter, endpoint,
 *   headers, headers-from, token, token-header, token-scheme, language, identity, session,
 *   environment, show-done, theme, theme-accent, theme-surface, route, route-from, gate, mount.
 * Events:  bp-enabled, bp-disabled, bp-notes-changed, bp-export, bp-error
 * API:     blueprint, issues, exportNotes(), destroy()
 *
 * A misconfigured attribute (bad JSON, an unresolvable global path, an unknown environment) never
 * throws into the host page: it is reported as a `bp-error` event (queued as a microtask, so
 * listeners attached right after `appendChild` still see it) and collected in `element.issues`.
 */
import type { AdapterLike } from "../core/adapter";
import type { Note } from "../core/model";
import { createHttpAdapter } from "../adapters/http";
import {
  ALL_ATTRIBUTES,
  readAnchorHooks,
  readAnnotateSelectors,
  readAppInfo,
  readAttribute,
  readCanAnnotate,
  readDock,
  readEnvironment,
  readGate,
  readHeaders,
  readKeymap,
  readRoute,
  readStore,
  readTheme,
  resolveGlobalPath,
  type GlobalResolver,
} from "../embed/attributes";
import { createBlueprint, type Blueprint, type BlueprintConfig } from "../index";
import { VERSION } from "../version";

const OBSERVED = ALL_ATTRIBUTES;

/** The host's global scope, used to resolve `headers-from`, `route-from` and `gate`. */
function globalScope(): unknown {
  return globalThis;
}

export class BluepencilNotesElement extends HTMLElement {
  static readonly tagName = "bluepencil-notes";

  /** The bluepencil build this element comes from (same string in every artifact, FR-19). */
  static readonly version: string = VERSION;

  #blueprint: Blueprint | null = null;
  #unsubscribe: (() => void) | null = null;
  #issues: string[] = [];

  static get observedAttributes(): readonly string[] {
    return OBSERVED;
  }

  connectedCallback(): void {
    let blueprint = this.#blueprint;
    if (!blueprint) {
      this.#start();
      blueprint = this.#blueprint;
    }
    // Which build is on this page — readable in the DOM, which is where a host looks first.
    if (this.getAttribute("data-bp-version") !== VERSION) {
      this.setAttribute("data-bp-version", VERSION);
    }
    if (blueprint && this.getAttribute("enabled") !== "false") {
      const started = this.#guard("enable", () => blueprint.enable()) ?? false;
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
        const started = this.#guard("enable", () => this.#blueprint?.enable() ?? false) ?? false;
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

  /** Configuration problems seen while building this instance (also reported as `bp-error`). */
  get issues(): readonly string[] {
    return [...this.#issues];
  }

  /** Export the current set as a string and announce it as an event (host hook). */
  exportNotes(format: "markdown" | "json" = "markdown"): string {
    const text = this.#blueprint?.export({ format }) ?? "";
    this.dispatchEvent(new CustomEvent("bp-export", { detail: { format, text } }));
    return text;
  }

  /**
   * Full teardown: the layer, its listeners and the store. Unlike removing the element (which only
   * disables the layer and keeps the data), this releases everything — the attach loader uses it
   * before it swaps in another bluepencil version.
   */
  destroy(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    const blueprint = this.#blueprint;
    this.#blueprint = null;
    if (blueprint) {
      void blueprint.destroy();
    }
    this.dispatchEvent(new CustomEvent("bp-disabled"));
  }

  #start(): void {
    try {
      this.#blueprint = createBlueprint(this.#config());
      this.#unsubscribe = this.#blueprint.store.subscribe((notes) => this.#emitNotes(notes));
    } catch (error) {
      this.#blueprint = null;
      this.#report(error);
    }
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
      this.#guard("enable", () => blueprint.enable());
    }
  }

  #emitNotes(notes: Note[]): void {
    this.dispatchEvent(new CustomEvent("bp-notes-changed", { detail: { count: notes.length, notes } }));
  }

  /** Runs a host-visible operation without ever letting it throw into the host page. */
  #guard<T>(label: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (error) {
      this.#report(error, label);
      return undefined;
    }
  }

  /** Queued as a microtask so a host that attaches its listener right after mounting sees it. */
  #report(error: unknown, label?: string): void {
    const message = label === undefined ? String((error as Error)?.message ?? error) : `${label}: ${String((error as Error)?.message ?? error)}`;
    this.#issues = [...this.#issues, message];
    queueMicrotask(() => this.dispatchEvent(new CustomEvent("bp-error", { detail: error })));
  }

  /** Configuration issues are reported, never thrown (FR-17: a typo must not break the host). */
  #collect(issues: readonly string[]): void {
    if (issues.length === 0) {
      return;
    }
    this.#issues = [...this.#issues, ...issues];
    queueMicrotask(() => {
      for (const issue of issues) {
        this.dispatchEvent(new CustomEvent("bp-error", { detail: new Error(`bluepencil: ${issue}`) }));
      }
    });
  }

  #config(): BlueprintConfig {
    this.#issues = [];
    const resolve: GlobalResolver = (path) => resolveGlobalPath(globalScope(), path);

    const headers = readHeaders(this, resolve);
    const theme = readTheme(this);
    const store = readStore(this);
    const env = readEnvironment(this, resolve);
    const route = readRoute(this, resolve, locationOrUndefined());
    const gate = readGate(this, resolve);
    const hooks = readAnchorHooks(this);
    const annotatable = readCanAnnotate(this, resolve);
    const registered = readAnnotateSelectors(this);
    const keyboard = readKeymap(this);
    const docking = readDock(this);
    const appInfo = readAppInfo(this);
    this.#collect([
      ...headers.issues,
      ...theme.issues,
      ...env.issues,
      ...route.issues,
      ...gate.issues,
      ...hooks.issues,
      ...annotatable.issues,
      ...registered.issues,
      ...keyboard.issues,
      ...docking.issues,
    ]);

    const mountAttr = readAttribute(this, "mount");
    const root = this.getRootNode() as Document | ShadowRoot;
    const mountTarget = mountAttr ? (root.querySelector?.(mountAttr) as Element | null) : null;

    const adapter = store.endpoint === undefined
      ? store.adapterName === undefined
        ? undefined
        : (store.adapterName as AdapterLike)
      : (): ReturnType<typeof createHttpAdapter> =>
          createHttpAdapter({
            endpoint: store.endpoint as string,
            ...(headers.headers === undefined ? {} : { headers: headers.headers }),
          });

    const config: BlueprintConfig = {
      enabled: () => this.getAttribute("enabled") !== "false" && (gate.gate ? gate.gate() : true),
      autoEnable: false,
      defaultShowDone: env.showDone === true,
      ...(adapter === undefined ? {} : { adapter }),
      ...(readAttribute(this, "language") === undefined ? {} : { language: readAttribute(this, "language") as string }),
      ...(Object.keys(theme.theme).length > 0 ? { theme: theme.theme } : {}),
      ...(env.sessionRef === undefined ? {} : { sessionRef: env.sessionRef }),
      ...(env.environment === undefined ? {} : { environment: env.environment }),
      ...(route.getRoute === undefined ? {} : { getRoute: route.getRoute }),
      ...(hooks.hooks === undefined ? {} : { anchorHooks: hooks.hooks }),
      ...(annotatable.canAnnotate === undefined ? {} : { canAnnotate: annotatable.canAnnotate }),
      ...(registered.annotateSelectors === undefined ? {} : { annotateSelectors: registered.annotateSelectors }),
      ...(keyboard.keymap === undefined ? {} : { keymap: keyboard.keymap }),
      ...(docking.dock === undefined ? {} : { dock: docking.dock }),
      ...(appInfo.app === undefined ? {} : { app: appInfo.app }),
      ...(appInfo.app?.buildRef === undefined ? {} : { buildRef: appInfo.app.buildRef }),
      ...(appInfo.exportedBy === undefined ? {} : { exportedBy: appInfo.exportedBy }),
      ...(env.environment === undefined ? {} : { environment: env.environment }),
      ...(mountTarget ? { mount: mountTarget } : {}),
      onError: (error: unknown) => this.dispatchEvent(new CustomEvent("bp-error", { detail: error })),
    };
    if (env.identity !== undefined) {
      config.identity = env.identity;
    }
    return config;
  }
}

/** The element may live in a document without a `location` (jsdom, SSR) — never assume one. */
function locationOrUndefined(): { pathname: string; search: string } | undefined {
  const location = (globalThis as { location?: { pathname: string; search: string } }).location;
  return location === undefined ? undefined : { pathname: location.pathname, search: location.search };
}

/** Register the element once (idempotent — safe even if several hosts import this module). */
export function defineBluepencilElement(tagName: string = BluepencilNotesElement.tagName): void {
  if (typeof customElements === "undefined" || customElements.get(tagName)) {
    return;
  }
  customElements.define(tagName, BluepencilNotesElement);
}

defineBluepencilElement();
