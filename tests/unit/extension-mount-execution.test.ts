/**
 * The mount sequence — what a click actually injects, and what happens when a page refuses (B.5).
 *
 * The worker used to own this sequence, and it owned it in the way that hides failures: the bridge
 * and the bootstrap injections swallowed their errors (`.catch(() => {})`), the config injection did
 * not, and the whole thing ran outside any `try/catch`. The result was a mount on `chrome://settings`
 * that left an unhandled rejection in the worker and told the user nothing (CQ-06).
 *
 * Two observations pin the contract here:
 *
 *  - **Order and shape (AC-B21).** `mountOnTab` with recorded `MountDeps` must inject
 *    `bridge.js` (isolated world) → `bootstrap.js` (MAIN) → the config function (MAIN), each call
 *    carrying exactly one target, and the config carrying `force === true` only when the caller
 *    asked for it. No `registerContentScripts` is part of the sequence.
 *  - **No throw (AC-B25).** A refusing page must produce `{ ok: false, error }` at *each* of the
 *    three steps, from both call sites (toolbar click and keyboard command), with nothing left
 *    unhandled.
 *
 * The source-level block pins the ownership rewiring (AC-B54): `readSettings` is defined once, in
 * `mount.ts`, and the import graph is `sw → mount → settings` — never back.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  mainWorldHandoff,
  mountOnTab,
  readSettings,
  runMountStep,
  type MountDeps,
  type MountInjection,
} from "../../extension/src/mount";
import { planMount, type MountStep, type PageConfig } from "../../extension/src/mount-plan";
import { DEFAULT_SETTINGS, type ExtensionSettings } from "../../extension/src/settings";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relative: string): string => readFileSync(join(ROOT, relative), "utf8");

const SW_SOURCE = source("extension/src/sw.ts");
const MOUNT_SOURCE = source("extension/src/mount.ts");
const MOUNT_PLAN_SOURCE = source("extension/src/mount-plan.ts");

const SETTINGS: ExtensionSettings = {
  ...DEFAULT_SETTINGS,
  environment: "staging",
  appName: "ReqogniLoom",
  endpoint: "https://hub.example/api",
};

/**
 * A `MountDeps` recorder.
 *
 * `failOn` counts the `executeScript` calls and rejects the n-th one — which is how a `chrome://`
 * tab behaves: the page refuses the injection, whatever the payload. The rejection is raised *after*
 * recording, because the interesting question is which step was attempted, not whether a failed call
 * is remembered.
 */
interface Recorder {
  injections: MountInjection[];
  configs: PageConfig[];
  deps: Partial<MountDeps>;
}

function recorder(options: { failOn?: number } = {}): Recorder {
  const injections: MountInjection[] = [];
  const configs: PageConfig[] = [];
  let call = 0;
  return {
    injections,
    configs,
    deps: {
      readSettings: async () => SETTINGS,
      executeScript: async (injection) => {
        call += 1;
        injections.push(injection);
        if (options.failOn === call) {
          throw new Error("Cannot access a chrome:// URL");
        }
        return [];
      },
      handoff: (config) => {
        configs.push(config);
      },
    },
  };
}

/** What a recorded injection asks for: a file name, or `"config"` for the function injection. */
function stepName(injection: MountInjection): string {
  return "files" in injection ? (injection.files[0] ?? "") : "config";
}

describe("planMount — the sequence is the contract (AC-B21)", () => {
  it("returns exactly bridge, bootstrap, config, in that order", () => {
    const plan = planMount({ settings: SETTINGS, tabUrl: "https://a.example/x", force: false });
    expect(plan.steps.map((step) => step.kind)).toEqual(["bridge", "bootstrap", "config"]);
  });

  it("hands out a fresh array, so one mount cannot edit the next one's plan", () => {
    const first = planMount({ settings: SETTINGS, tabUrl: "", force: false });
    first.steps.pop();
    const second = planMount({ settings: SETTINGS, tabUrl: "", force: false });
    expect(second.steps).toHaveLength(3);
  });

  it("carries the tab URL, the settings and the force flag into the page config", () => {
    const plan = planMount({ settings: SETTINGS, tabUrl: "https://a.example/x", force: true });
    expect(plan.config.tabUrl).toBe("https://a.example/x");
    expect(plan.config.force).toBe(true);
    expect(plan.config.settings.environment).toBe("staging");
    expect(plan.config.settings.appName).toBe("ReqogniLoom");
  });

  it("treats anything but a literal true as no force", () => {
    // #70's step-aside is the safe default; a truthy string must not turn it off.
    const notBoolean = "true" as unknown as boolean;
    expect(planMount({ settings: SETTINGS, tabUrl: "", force: notBoolean }).config.force).toBe(false);
    expect(planMount({ settings: SETTINGS, tabUrl: "", force: true }).config.force).toBe(true);
  });
});

describe("mountOnTab — the executed mount (AC-B21)", () => {
  it("injects bridge → bootstrap → config, each with exactly one target", async () => {
    const recorded = recorder();
    const result = await mountOnTab(
      7,
      "https://a.example/x",
      { force: true },
      recorded.deps,
    );

    expect(result).toEqual({ ok: true, tabUrl: "https://a.example/x" });
    expect(recorded.injections.map(stepName)).toEqual(["bridge.js", "bootstrap.js", "config"]);
    // One target per call, and nothing else in it: a second target would be a second tab.
    for (const injection of recorded.injections) {
      expect(injection.target).toEqual({ tabId: 7 });
      expect(Object.keys(injection.target)).toEqual(["tabId"]);
    }
  });

  it("injects the bridge in the isolated world and the bootstrap in the page's MAIN world", async () => {
    const recorded = recorder();
    await mountOnTab(7, "", {}, recorded.deps);

    const [bridge, bootstrap, config] = recorded.injections;
    expect(bridge).toEqual({ target: { tabId: 7 }, files: ["bridge.js"], injectImmediately: true });
    expect(bootstrap).toEqual({
      target: { tabId: 7 },
      files: ["bootstrap.js"],
      world: "MAIN",
      injectImmediately: true,
    });
    // The config is the one function injection: the settings travel as arguments, never as a string
    // of code, which MV3's no-remote-code rule and the page's CSP both require.
    expect(config).toMatchObject({ target: { tabId: 7 }, world: "MAIN", injectImmediately: true });
    expect(config !== undefined && "func" in config ? config.func : undefined).toBe(
      mainWorldHandoff,
    );
  });

  it("puts the same config into the injection arguments and the handoff seam", async () => {
    const recorded = recorder();
    await mountOnTab(7, "https://a.example/x", { force: true }, recorded.deps);

    const config = recorded.configs[0];
    expect(config).toBeDefined();
    expect(config?.force).toBe(true);
    expect(config?.tabUrl).toBe("https://a.example/x");

    const injection = recorded.injections[2];
    const args = injection !== undefined && "args" in injection ? injection.args : [];
    expect(args).toEqual([config]);
    expect((args[0] as PageConfig).force).toBe(true);
  });

  it("defaults to no force when the caller does not set it", async () => {
    const recorded = recorder();
    await mountOnTab(7, "", {}, recorded.deps);
    expect(recorded.configs[0]?.force).toBe(false);
  });

  it("runs exactly one step per plan entry (runMountStep is one injection, not a loop)", async () => {
    const recorded = recorder();
    const config = planMount({ settings: SETTINGS, tabUrl: "", force: false }).config;
    const steps: MountStep[] = [{ kind: "bridge" }, { kind: "bootstrap" }, { kind: "config" }];
    for (const step of steps) {
      expect(await runMountStep(step, 4, config, recorded.deps as MountDeps)).toEqual({
        ok: true,
      });
    }
    expect(recorded.injections).toHaveLength(3);
    expect(recorded.configs).toHaveLength(1);
  });
});

describe("mountOnTab never throws — every injection is covered (AC-B25)", () => {
  const callers = [
    { label: "toolbar click", tabId: 11, tabUrl: "https://a.example/x" },
    { label: "keyboard command", tabId: 12, tabUrl: "" },
  ];
  const steps = [
    { index: 1, label: "bridge" },
    { index: 2, label: "bootstrap" },
    { index: 3, label: "config" },
  ];

  for (const step of steps) {
    for (const caller of callers) {
      it(`answers {ok:false,error} when the ${step.label} injection is refused (${caller.label})`, async () => {
        const recorded = recorder({ failOn: step.index });
        const unhandled: unknown[] = [];
        const onRejection = (reason: unknown): void => {
          unhandled.push(reason);
        };
        process.on("unhandledRejection", onRejection);
        try {
          const result = await mountOnTab(caller.tabId, caller.tabUrl, {}, recorded.deps);

          expect(result.ok).toBe(false);
          expect(result.error).toContain("chrome://");
          // The failing call was attempted and nothing after it ran; a config step that throws never
          // hands anything over, so a half-written page config is impossible.
          expect(recorded.injections).toHaveLength(step.index);
          expect(recorded.configs).toHaveLength(0);

          // Give the microtask/macrotask queue a turn: a stray floating rejection would land here.
          await new Promise((resolve) => setTimeout(resolve, 0));
          expect(unhandled).toEqual([]);
        } finally {
          process.off("unhandledRejection", onRejection);
        }
      });
    }
  }

  it("maps a failing settings read to a mount error instead of a rejection", async () => {
    const result = await mountOnTab(5, "", {}, {
      readSettings: async () => {
        throw new Error("storage is unavailable");
      },
      executeScript: async () => [],
      handoff: () => undefined,
    });
    expect(result).toEqual({ ok: false, error: "storage is unavailable" });
  });
});

describe("readSettings — the one reader, moved here from sw.ts", () => {
  const globals = globalThis as { chrome?: unknown };

  afterEach(() => {
    delete globals.chrome;
  });

  it("falls back to the documented defaults when nothing is stored", async () => {
    globals.chrome = { storage: { local: { get: async () => ({}) } } };
    expect(await readSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("normalizes a stored blob instead of replacing the defaults wholesale", async () => {
    globals.chrome = {
      storage: {
        local: {
          get: async (key: string) => ({
            [key]: { environment: "prod", endpoint: 42, mountAlongsideHost: "true" },
          }),
        },
      },
    };
    const settings = await readSettings();
    expect(settings.environment).toBe("live");
    expect(settings.endpoint).toBe(DEFAULT_SETTINGS.endpoint);
    expect(settings.mountAlongsideHost).toBe(false);
  });

  it("falls back to defaults when storage itself fails", async () => {
    globals.chrome = {
      storage: {
        local: {
          get: async () => {
            throw new Error("storage is unavailable");
          },
        },
      },
    };
    expect(await readSettings()).toEqual(DEFAULT_SETTINGS);
  });
});

describe("ownership — one reader, one sequence, no import back-edge (AC-B54)", () => {
  const definitions = (text: string): number =>
    (text.match(/function readSettings\s*\(/g) ?? []).length;

  it("defines readSettings exactly once, exported, in mount.ts", () => {
    expect(definitions(MOUNT_SOURCE)).toBe(1);
    expect(MOUNT_SOURCE).toContain("export async function readSettings");
    expect(definitions(SW_SOURCE)).toBe(0);
  });

  it("leaves no second settings reader or settings key in the worker", () => {
    expect(SW_SOURCE).not.toContain("SETTINGS_KEY");
    expect(SW_SOURCE).toMatch(/import \{[^}]*\breadSettings\b[^}]*\} from "\.\/mount"/);
  });

  it("keeps the graph acyclic: the mount modules never import the worker", () => {
    expect(MOUNT_SOURCE).not.toMatch(/from "\.\/sw"/);
    expect(MOUNT_PLAN_SOURCE).not.toMatch(/from "\.\/sw"/);
    expect(SW_SOURCE).toMatch(/from "\.\/mount"/);
  });

  it("keeps the mount seam the smoke and E2E suites drive", () => {
    expect(SW_SOURCE).toContain("self.__bluepencilModule = { mountOnTab }");
  });

  it("keeps persistent content-script registration out of the mount sequence", () => {
    expect(MOUNT_SOURCE).not.toMatch(/registerContentScripts\s*\(/);
    expect(MOUNT_PLAN_SOURCE).not.toMatch(/registerContentScripts\s*\(/);
  });

  it("deletes the persistent registration from the worker (AC-B54, AC-B56)", () => {
    // The boundary commit: no dynamic MAIN-world registration survives, because the manifest no
    // longer carries a host grant that could justify one.
    expect(SW_SOURCE).not.toContain("registerContentScripts");
    expect(SW_SOURCE).not.toContain("ensureBootstrapRegistered");
    expect(SW_SOURCE).not.toContain("unregisterContentScripts");
  });
});
