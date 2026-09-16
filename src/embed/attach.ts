/**
 * The attach loader (FR-17) — one script tag, no build step in the host, updatable at runtime.
 *
 *   <script src="https://notes.example/bluepencil/attach.js"
 *           data-endpoint="/api/v1/bluepencil" data-environment="dev" data-language="de"
 *           data-gate="myApp.features.reviewNotes"></script>
 *
 * The loader reads **its own** `data-*` attributes (they are the element vocabulary of
 * `src/embed/attributes.ts`, 1:1), loads the element build at runtime, mounts one
 * `<bluepencil-notes>` and hands the host an API on `window.bluepencilAttach`.
 *
 * Runtime updates (optional feature, see docs/EMBED.md): with `data-manifest` the loader reads a
 * pointer (`{"version","element","sha256"}`), compares it with the version it mounted and swaps
 * the layer when it changed — `data-watch` seconds polls it, `reload()` does it on demand. Nothing
 * about the host has to be rebuilt for that; the host only has to give it one script slot and, if
 * it uses a strict `script-src` CSP, an allowlist entry.
 *
 * This module never throws into the host page: every failure becomes a `bp-attach-error` event on
 * `document` plus one `console.debug` line. It has no dependencies beyond the DOM and `fetch`.
 */
import {
  ALL_ATTRIBUTES,
  LOADER_KEYS,
  collectDataAttributes,
  parseLoaderOptions,
  type LoaderOptions,
} from "./attributes";
import {
  absoluteUrl,
  parseManifestText,
  resolveElementUrl,
  shouldReload,
  verifyIntegrity,
  type AttachManifest,
} from "./version";

/** Everything the loader needs from the outside world — injectable so it is testable headlessly. */
export interface AttachDeps {
  document: Document;
  fetchImpl: typeof fetch;
  /** Loads the element module; defaults to a dynamic `import()` with a script-tag fallback. */
  importModule: (url: string) => Promise<void>;
  cryptoImpl?: Crypto;
  setTimeoutImpl: (fn: () => void, ms: number) => number;
  clearTimeoutImpl: (handle: number) => void;
  /** Milliseconds to wait for the element definition to appear. */
  moduleTimeoutMs: number;
}

export interface AttachOptions extends LoaderOptions {
  /** Absolute URL of the loader script; needed to resolve relative defaults. */
  scriptUrl: string;
  /** Explicit mount target (wins over the `mount` attribute). */
  mountTarget?: Element;
  deps?: Partial<AttachDeps>;
}

export interface AttachHandle {
  /** Version the loader believes it mounted (`unknown` when it used the sibling build). */
  readonly version: string;
  /** URL the element module was loaded from. */
  readonly src: string;
  /** The mounted element, or `null` when `auto: false` or the mount failed. */
  readonly element: Element | null;
  /** Reads the manifest again and swaps the layer when the version changed. */
  check(): Promise<boolean>;
  /** Tears the layer down and mounts the resolved version again (alias of `check()`). */
  reload(): Promise<void>;
  /** Removes the element, the layer and the watch timer. */
  destroy(): void;
}

const ATTACH_READY = "bp-attach-ready";
const ATTACH_ERROR = "bp-attach-error";
const ATTACH_UPDATED = "bp-attach-updated";

/**
 * The host's `fetch`, bound to its global: `fetch` is a window operation, so calling it as a method
 * of another object is an "Illegal invocation" in every real browser. A host without `fetch` gets a
 * function that fails at the call site with a clear message instead of a `TypeError`.
 */
function bindToGlobal(fetchImpl: typeof fetch | undefined): typeof fetch {
  if (fetchImpl === undefined) {
    return (() => {
      throw new Error("the attach loader needs fetch() — this host has none");
    }) as unknown as typeof fetch;
  }
  return fetchImpl.bind(globalThis);
}

/** The document and platform defaults, with every piece overridable for tests. */
function resolveDeps(deps: Partial<AttachDeps> | undefined, doc: Document): AttachDeps {
  const globals = globalThis as unknown as {
    fetch?: typeof fetch;
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
  const resolved: AttachDeps = {
    document: doc,
    // Bound to its own global: `fetch` is a window operation, so calling it as a method of this
    // options object is an "Illegal invocation" in every real browser — while Node's fetch does not
    // care, which is why only a real-browser round catches it.
    fetchImpl: deps?.fetchImpl ?? bindToGlobal(globals.fetch),
    importModule: deps?.importModule ?? defaultImportModule(() => resolved),
    setTimeoutImpl:
      deps?.setTimeoutImpl ?? ((fn, ms) => globals.setTimeout(fn, ms) as unknown as number),
    clearTimeoutImpl:
      deps?.clearTimeoutImpl ??
      ((handle) => globals.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)),
    moduleTimeoutMs: deps?.moduleTimeoutMs ?? 5000,
  };
  if (deps?.cryptoImpl !== undefined) {
    resolved.cryptoImpl = deps.cryptoImpl;
  }
  return resolved;
}

/** Dynamic `import()` first; a module script tag as the fallback for engines/CSP setups without it. */
function defaultImportModule(getDeps: () => AttachDeps): (url: string) => Promise<void> {
  return async (url: string) => {
    try {
      await import(/* @vite-ignore */ url);
      return;
    } catch {
      const deps = getDeps();
      const { document } = deps;
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        const guard = deps.setTimeoutImpl(() => reject(new Error(`could not load ${url} within ${deps.moduleTimeoutMs} ms`)), deps.moduleTimeoutMs);
        script.type = "module";
        script.src = url;
        script.onload = () => {
          deps.clearTimeoutImpl(guard);
          resolve();
        };
        script.onerror = () => {
          deps.clearTimeoutImpl(guard);
          reject(new Error(`could not load ${url}`));
        };
        (document.head ?? document.documentElement).append(script);
      });
    }
  };
}

function elementRegistry(doc: Document): CustomElementRegistry | undefined {
  return (
    (doc.defaultView as unknown as { customElements?: CustomElementRegistry } | null)?.customElements ??
    (globalThis as { customElements?: CustomElementRegistry }).customElements
  );
}

/** Waits until the element is registered, so a script-tag fallback cannot race the mount. */
async function waitForDefinition(deps: AttachDeps, tag: string): Promise<void> {
  const registry = elementRegistry(deps.document);
  if (!registry || registry.get(tag)) {
    return;
  }
  const deadline = Date.now() + deps.moduleTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => deps.setTimeoutImpl(() => resolve(), 25));
    if (registry.get(tag)) {
      return;
    }
  }
  throw new Error(`the element <${tag}> was not defined within ${deps.moduleTimeoutMs} ms`);
}

interface ResolvedTarget {
  elementUrl: string;
  version: string;
  sha256?: string;
}

/** Manifest first (`data-manifest`), then `data-src`/`data-version`, then the sibling build. */
async function resolveTarget(options: AttachOptions, deps: AttachDeps): Promise<ResolvedTarget> {
  if (options.manifest !== undefined) {
    const manifestUrl = absoluteUrl(options.scriptUrl, options.manifest);
    const response = await deps.fetchImpl(manifestUrl, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`manifest ${manifestUrl} → HTTP ${response.status}`);
    }
    const parsed = parseManifestText(await response.text());
    if (parsed.manifest === undefined) {
      throw new Error(`manifest ${manifestUrl}: ${parsed.issue ?? "unreadable"}`);
    }
    const manifest: AttachManifest = parsed.manifest;
    return {
      elementUrl: absoluteUrl(manifestUrl, manifest.element),
      version: manifest.version,
      ...(manifest.sha256 === undefined ? {} : { sha256: manifest.sha256 }),
    };
  }
  return {
    elementUrl: resolveElementUrl({
      scriptUrl: options.scriptUrl,
      ...(options.src === undefined ? {} : { src: options.src }),
      ...(options.version === undefined ? {} : { version: options.version }),
    }),
    version: options.version ?? "unknown",
  };
}

/** Creates the element from the forwarded attribute map. */
function mountElement(options: AttachOptions, target: ResolvedTarget, deps: AttachDeps): Element {
  const element = deps.document.createElement(options.tag);
  for (const [name, value] of Object.entries(options.attributes)) {
    element.setAttribute(name, value);
  }
  // Read-only breadcrumbs for debugging and for host-side diagnostics.
  element.setAttribute("attach-version", target.version);
  element.setAttribute("attach-src", target.elementUrl);

  const selector = options.attributes.mount;
  const container =
    options.mountTarget ??
    (selector === undefined ? deps.document.body : deps.document.querySelector(selector) ?? deps.document.body);
  container.append(element);
  return element;
}

function dispatch(doc: Document, type: string, detail: unknown): void {
  doc.dispatchEvent(new CustomEvent(type, { detail }));
}

/** One debug line — a failing attach must be visible, but it must not spam the console. */
function reportError(doc: Document, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  (globalThis as { console?: Console }).console?.debug?.(`bluepencil attach: ${message}`);
  dispatch(doc, ATTACH_ERROR, error);
}

/** The digest check is part of *every* load, not just the first one (F-embed: swaps must verify). */
async function assertIntegrity(
  options: AttachOptions,
  target: ResolvedTarget,
  deps: AttachDeps,
): Promise<void> {
  if (!options.integrity || target.sha256 === undefined) {
    return;
  }
  const verified = await verifyIntegrity({
    url: target.elementUrl,
    sha256: target.sha256,
    fetchImpl: deps.fetchImpl,
    ...(deps.cryptoImpl === undefined ? {} : { cryptoImpl: deps.cryptoImpl }),
  });
  if (!verified.ok) {
    throw new Error(verified.issue ?? "integrity check failed");
  }
}

/**
 * Attaches bluepencil. Resolves once the layer is mounted (or once the failure has been reported
 * to the caller, which is what `attachFromDocument` re-reports as `bp-attach-error`).
 */
export async function attach(options: AttachOptions): Promise<AttachHandle> {
  const doc = options.deps?.document ?? (globalThis as { document?: Document }).document;
  if (!doc) {
    throw new Error("bluepencil attach needs a document");
  }
  /** A non-optional alias: TypeScript drops the narrowing of `doc` inside hoisted closures. */
  const page: Document = doc;
  const deps = resolveDeps(options.deps, doc);
  let target = await resolveTarget(options, deps);
  let element: Element | null = null;
  let timer: number | null = null;

  await assertIntegrity(options, target, deps);
  await deps.importModule(target.elementUrl);
  await waitForDefinition(deps, options.tag);
  if (options.auto) {
    element = mountElement(options, target, deps);
  }

  function teardown(): void {
    if (timer !== null) {
      deps.clearTimeoutImpl(timer);
      timer = null;
    }
    const current = element as (Element & { destroy?: () => void }) | null;
    if (current) {
      if (typeof current.destroy === "function") {
        try {
          current.destroy();
        } catch {
          /* a failing teardown of the old version must not block the update */
        }
      }
      current.remove();
    }
    element = null;
  }

  function armWatch(): void {
    if (options.watchSeconds <= 0) {
      return;
    }
    if (timer !== null) {
      deps.clearTimeoutImpl(timer);
    }
    timer = deps.setTimeoutImpl(() => {
      timer = null;
      void handle.check().catch((error: unknown) => reportError(page, error));
    }, options.watchSeconds * 1000);
  }

  const handle: AttachHandle = {
    get version(): string {
      return target.version;
    },
    get src(): string {
      return target.elementUrl;
    },
    get element(): Element | null {
      return element;
    },
    async check(): Promise<boolean> {
      if (options.manifest === undefined) {
        return false;
      }
      const next = await resolveTarget(options, deps);
      if (!shouldReload(target.version, next.version)) {
        armWatch();
        return false;
      }
      // Verified *before* anything is torn down: a refused update leaves the running layer alone.
      await assertIntegrity(options, next, deps);
      const from = target.version;
      teardown();
      target = next;
      await deps.importModule(target.elementUrl);
      await waitForDefinition(deps, options.tag);
      if (options.auto) {
        element = mountElement(options, target, deps);
      }
      armWatch();
      dispatch(page, ATTACH_UPDATED, { from, to: target.version });
      return true;
    },
    async reload(): Promise<void> {
      await handle.check();
    },
    destroy(): void {
      teardown();
    },
  };

  armWatch();
  dispatch(page, ATTACH_READY, { version: target.version, src: target.elementUrl });
  return handle;
}

export interface AttachApi {
  /** Version of the layer the loader mounted last (`unknown` when it used the sibling build). */
  readonly version: string;
  /** URL of the element build the loader mounted last. */
  readonly src: string;
  /** The elements the loader mounted, in attach order (`auto: false` hosts mount their own). */
  readonly instances: Element[];
  /** The handles behind `instances` — the control surface for advanced hosts and tests. */
  handles: AttachHandle[];
  attach(options: Omit<AttachOptions, "scriptUrl"> & { scriptUrl?: string }): Promise<AttachHandle>;
  /** Polls every handle; resolves with the number of swapped instances (0 = already current). */
  check(): Promise<number>;
  /** Explicit runtime update — `check()`, so the layer is replaced only when the version changed. */
  reload(): Promise<number>;
  destroy(): void;
}

/** A script tag belongs to the loader when it carries any documented attribute. */
function isAttachScript(script: Element): boolean {
  const data = collectDataAttributes(script as unknown as { getAttribute(name: string): string | null });
  return Object.keys(data).some(
    (key) =>
      (ALL_ATTRIBUTES as readonly string[]).includes(key) || (LOADER_KEYS as readonly string[]).includes(key),
  );
}

/**
 * Attaches every loader script in the document. `deps` is injectable so a host with its own
 * fetcher (or a test) can drive the auto-discovery path too.
 */
export async function attachFromDocument(
  doc?: Document,
  deps?: Partial<AttachDeps>,
): Promise<AttachApi> {
  const document_ = doc ?? (globalThis as { document?: Document }).document;
  if (!document_) {
    throw new Error("bluepencil attach needs a document");
  }
  const target: Document = document_;
  const base: Partial<AttachDeps> = { ...(deps ?? {}), document: target };
  const api: AttachApi = {
    handles: [],
    // The documented `window.bluepencilAttach` surface (FR-17 §2): a host reads `version`, `src`
    // and `instances` without ever touching a handle.
    get version(): string {
      const last = api.handles[api.handles.length - 1];
      return last === undefined ? "unknown" : last.version;
    },
    get src(): string {
      const last = api.handles[api.handles.length - 1];
      return last === undefined ? "" : last.src;
    },
    get instances(): Element[] {
      return api.handles
        .map((handle) => handle.element)
        .filter((element): element is Element => element !== null);
    },
    async attach(options) {
      const handle = await attach({
        ...options,
        scriptUrl: options.scriptUrl ?? target.baseURI,
        deps: { ...base, ...(options.deps ?? {}) },
      });
      api.handles.push(handle);
      return handle;
    },
    async check() {
      let updated = 0;
      for (const handle of api.handles) {
        if (await handle.check()) updated += 1;
      }
      return updated;
    },
    async reload() {
      return api.check();
    },
    destroy() {
      for (const handle of api.handles) {
        handle.destroy();
      }
      api.handles = [];
    },
  };

  for (const script of [...target.querySelectorAll("script")].filter(isAttachScript)) {
    const source = (script as HTMLScriptElement).src ?? "";
    try {
      await api.attach({
        ...parseLoaderOptions(
          collectDataAttributes(script as unknown as { getAttribute(name: string): string | null }),
        ),
        scriptUrl: source === "" ? target.baseURI : source,
      });
    } catch (error) {
      reportError(target, error);
    }
  }
  return api;
}

/** Attaches the document's loader scripts and publishes `window.bluepencilAttach`. */
export async function start(doc?: Document, deps?: Partial<AttachDeps>): Promise<AttachApi> {
  const document_ = doc ?? (globalThis as { document?: Document }).document;
  if (!document_) {
    throw new Error("bluepencil attach needs a document");
  }
  const api = await attachFromDocument(document_, deps);
  (globalThis as { bluepencilAttach?: AttachApi }).bluepencilAttach = api;
  const view = document_.defaultView as unknown as { bluepencilAttach?: AttachApi } | null;
  if (view) {
    view.bluepencilAttach = api;
  }
  return api;
}

/* -------------------------------------------------------------------------- */
/* auto-run: the IIFE build of `dist/attach.js` executes this                  */
/* -------------------------------------------------------------------------- */

function autoRun(): void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) {
    return;
  }
  const run = (): void => {
    void start(doc).catch((error: unknown) => reportError(doc, error));
  };
  if (doc.readyState === "loading") {
    doc.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
}

autoRun();
