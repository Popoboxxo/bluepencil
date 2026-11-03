/// <reference path="../../extension/src/bluepencil-element.d.ts" />
/**
 * `bootstrap.ts` lifecycle (B.6, AC-B39).
 *
 * The bootstrap is a MAIN-world script with two side effects that matter to the worker:
 *
 *  - it publishes `__bluepencilTryMount` so the worker can wake it after writing the configuration
 *    (the binding mount order is bridge → bootstrap → config), and it removes that hook once a
 *    mount succeeds — a mounted document is final, and the extension must not leave a live entry
 *    point behind (#G9);
 *  - it reports a *memory-only* mount as `{kind:"mounted", ok:false, error:"memory-only: …"}`.
 *    An opaque origin (`file://`, a sandboxed frame) has no storage bucket; the notes stay in the
 *    tab and are gone after a reload. `badgeForReport` is what makes that visible, so this suite
 *    feeds the captured report through it as well (RVW-16).
 *
 * The module imports the *built* element bundle, so the build-only modules are mocked here. That
 * keeps the test on the bootstrap's own logic and away from `dist/` freshness — the element bundle
 * has its own suites.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { badgeForReport } from "../../extension/src/bridge-messages";
import { DEFAULT_SETTINGS, type ExtensionSettings } from "../../extension/src/settings";

const HOOK_KEY = "__bluepencilTryMount";
const CONFIG_KEY = "__bluepencilConfig__";
const MOUNTED_KEY = "__bluepencilMounted";

interface MountConfigLike {
  settings: ExtensionSettings;
  tabUrl: string;
}

interface Report {
  source?: unknown;
  kind?: unknown;
  ok?: unknown;
  error?: unknown;
  host?: unknown;
}

/** What the mocked build modules observe, shared across `vi.resetModules()` runs. */
const built = vi.hoisted(() => ({
  adapters: [] as { onFallback?: (reason: unknown) => void }[],
  factories: [] as (() => unknown)[],
  defined: 0,
  throwOnDefine: false,
}));

vi.mock("../../dist/bluepencil.element.js", () => ({
  defineBluepencilElement: () => {
    if (built.throwOnDefine) throw new Error("the element refused to register");
    built.defined += 1;
  },
  registerAdapter: (_name: string, factory: () => unknown) => {
    built.factories.push(factory);
  },
  registerHttpTransport: () => () => undefined,
}));

vi.mock("../../dist/adapters/chrome-storage.js", () => ({
  createChromeStorageAdapter: (options: { onFallback?: (reason: unknown) => void }) => {
    built.adapters.push(options);
    return {};
  },
}));

const globals = globalThis as Record<string, unknown>;
let posted: Report[] = [];

function config(overrides: Partial<ExtensionSettings> = {}): MountConfigLike {
  return {
    settings: { ...DEFAULT_SETTINGS, ...overrides },
    tabUrl: "https://page.example/review",
  };
}

async function loadBootstrap(
  options: { config?: MountConfigLike; hostEmbed?: boolean; throwOnDefine?: boolean } = {},
): Promise<void> {
  vi.resetModules();
  built.adapters.length = 0;
  built.factories.length = 0;
  built.defined = 0;
  built.throwOnDefine = options.throwOnDefine === true;
  posted = [];
  delete globals[HOOK_KEY];
  delete globals[MOUNTED_KEY];
  delete globals[CONFIG_KEY];
  document.body.innerHTML = options.hostEmbed ? "<bluepencil-notes></bluepencil-notes>" : "";
  if (options.config !== undefined) globals[CONFIG_KEY] = options.config;
  await import("../../extension/src/bootstrap");
}

/** Only the reports this file sends are interesting; the channel is shared with the bridge. */
function bootstrapReports(): Report[] {
  return posted.filter((message) => message?.source === "bluepencil-extension");
}

function hook(): unknown {
  return globals[HOOK_KEY];
}

beforeEach(() => {
  posted = [];
  vi.spyOn(window, "postMessage").mockImplementation(((message: unknown) => {
    posted.push(message as Report);
  }) as typeof window.postMessage);
});

afterEach(() => {
  document.body.innerHTML = "";
  delete globals[HOOK_KEY];
  delete globals[MOUNTED_KEY];
  delete globals[CONFIG_KEY];
  vi.restoreAllMocks();
});

describe("__bluepencilTryMount lifecycle (AC-B39)", () => {
  it("publishes the wake hook on load and keeps it dormant while no configuration arrives", async () => {
    await loadBootstrap();

    // The worker's next step is the configuration (bridge → bootstrap → config), so the hook has to
    // exist one step before that configuration does.
    expect(typeof hook()).toBe("function");
    // Dormant means dormant: nothing mounted, nothing reported.
    expect(built.defined).toBe(0);
    expect(document.querySelector("bluepencil-notes")).toBeNull();
    expect(bootstrapReports()).toEqual([]);
  });

  it("mounts when the worker hands over the configuration and wakes the hook", async () => {
    await loadBootstrap();

    globals[CONFIG_KEY] = config();
    const wake = hook() as ((options?: { force?: boolean }) => void) | undefined;
    expect(typeof wake).toBe("function");
    wake?.();

    expect(built.defined).toBe(1);
    expect(document.querySelector("bluepencil-notes")).not.toBeNull();
    // The successful mount is final: the hook is gone, so the document has no live entry point.
    expect(hook()).toBeUndefined();
    expect(bootstrapReports()).toContainEqual(
      expect.objectContaining({ kind: "mounted", ok: true }),
    );
  });

  it("mounts a document that already carries the configuration at load and then drops the hook", async () => {
    await loadBootstrap({ config: config() });

    expect(built.defined).toBe(1);
    expect(hook()).toBeUndefined();
  });

  it("never re-publishes the hook into a document that already mounted", async () => {
    await loadBootstrap({ config: config() });
    expect(hook()).toBeUndefined();

    // A second `bootstrap.js` injection into the same document, as the worker's retry path does.
    vi.resetModules();
    await import("../../extension/src/bootstrap");

    expect(built.defined).toBe(1);
    expect(hook()).toBeUndefined();
  });

  it("keeps the hook after a host-embed stand-aside, so a forced activation can still mount", async () => {
    await loadBootstrap({ config: config(), hostEmbed: true });

    // Stepping aside is not a mount: no element, and the decision stays reversible (#70).
    expect(built.defined).toBe(0);
    expect(typeof hook()).toBe("function");
    expect(bootstrapReports()).toContainEqual(
      expect.objectContaining({ kind: "host-embed-detected" }),
    );
  });

  it("keeps the hook after a failed mount and resets the mounted guard for a retry", async () => {
    await loadBootstrap({ config: config(), throwOnDefine: true });

    expect(globals[MOUNTED_KEY]).toBe(false);
    expect(typeof hook()).toBe("function");
    expect(bootstrapReports()).toContainEqual(
      expect.objectContaining({ kind: "mounted", ok: false }),
    );

    // The retry path: fix the cause, wake the same hook, and the mount goes through.
    built.throwOnDefine = false;
    (hook() as () => void)();
    expect(built.defined).toBe(1);
    expect(hook()).toBeUndefined();
  });
});

describe("memory-only report and badge (AC-B39, RVW-16)", () => {
  it("reports the opaque-origin degrade as a memory-only mount and maps it to the `mem` badge", async () => {
    await loadBootstrap({ config: config() });

    const factory = built.factories[0];
    expect(typeof factory).toBe("function");
    factory?.();
    const adapter = built.adapters[0];
    expect(typeof adapter?.onFallback).toBe("function");

    adapter?.onFallback?.({ code: "opaque_origin" });

    const report = bootstrapReports().find((message) => message.ok === false);
    expect(report).toBeDefined();
    expect(String(report?.error)).toMatch(/^memory-only: /);
    expect(String(report?.error)).toContain("opaque origin");

    const badge = badgeForReport(report as { kind: string; ok?: boolean; error?: string });
    expect(badge).toEqual({
      text: "mem",
      title: expect.stringContaining("memory-only"),
    });
    // The title repeats the cause, not just the abbreviation, so the user learns why.
    expect(String(badge?.title)).toContain("opaque origin");
  });

  it("keeps a non-opaque fallback a plain failure, with no memory-only badge", async () => {
    await loadBootstrap({ config: config() });

    built.factories[0]?.();
    built.adapters[0]?.onFallback?.(new Error("the quota is exhausted"));

    const report = bootstrapReports().find((message) => message.ok === false);
    expect(report).toBeDefined();
    expect(report?.error).toBe("the quota is exhausted");
    expect(badgeForReport(report as { kind: string; ok?: boolean; error?: string })).toBeNull();
  });

  it("does not badge a successful mount", async () => {
    await loadBootstrap({ config: config() });

    const success = bootstrapReports().find((message) => message.ok === true);
    expect(success).toBeDefined();
    expect(badgeForReport(success as { kind: string; ok?: boolean; error?: string })).toBeNull();
  });

  it("wires the fallback only for the chromeStorage adapter", async () => {
    await loadBootstrap({ config: config({ store: "memory" }) });

    expect(built.factories).toHaveLength(0);
    expect(built.defined).toBe(1);
  });
});
