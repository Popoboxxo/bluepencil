/**
 * Review-page smoke — load the built `extension/dist-test` into a real Chrome and drive `review.html`.
 *
 * The unit suite proves the review model (`aggregateOriginStores`, the assign/undo plans) and the
 * two source properties (text-only rendering, no network API). What it cannot prove is that the
 * **built page** actually loads: `review.js` inlines the built `dist/data.js`, and an export that
 * disappeared from that artefact would leave a page that parses, mounts and then renders nothing.
 * This suite closes exactly that gap (AC-B52, build level) and keeps the review cases out of the
 * main extension smoke (AC-B57).
 *
 * It loads `extension/dist-test` and nothing else. That directory is a build artefact produced by
 * `buildTestGrant()` (`extension/test-manifest.mjs`, contract B.7.4) — normally by `npm run
 * smoke:ext`, which calls it immediately before loading. A missing artefact is a **named failure**
 * that names the path and the command, never a silent skip: a review page that never loaded must
 * not report green.
 *
 * The launcher and CDP plumbing are the same as `extension/smoke.mjs` (`scripts/lib/browser.mjs`,
 * `./probe.mjs`), so a browser-side regression surfaces in one place rather than two.
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Browser, findChrome, requireBrowser } from "../scripts/lib/browser.mjs";
import { selectWorker } from "./probe.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** The only directory this suite may load (contract B.7.4). Never `extension/dist`. */
const extDist = join(here, "dist-test");

/** Everything a loadable review page needs; the build must have produced all of it. */
const REQUIRED = ["manifest.json", "sw.js", "review.html", "review.js"];

const ORIGIN = "https://a.example";
const KEY_LEGACY = "bluepencil:default:v1";
const KEY_TARGET = `bluepencil:v2:${ORIGIN}`;
const KEY_PROVENANCE = `bluepencil:assign:${ORIGIN}`;
const KEY_SETTINGS = "bluepencil:settings";
const KEY_UI = "bluepencil:ui:panel";

/**
 * A note body that *is* markup. It must arrive on the page as text, never as an element — the
 * unit suite scans the source for `innerHTML`; this proves the rendered result.
 */
const HOSTILE_BODY = '<img src=x onerror="globalThis.__bpReviewPwned = true">';

let passed = 0;
let failed = 0;

function ok(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * The named-error path: every missing artefact is a FAIL line with its full path, followed by the
 * command that builds it. Runs before the browser is even required, so a missing build cannot be
 * mistaken for "no Chrome here".
 */
function missingArtefacts() {
  return REQUIRED.filter((name) => !existsSync(join(extDist, name)));
}

function reportMissing(missing) {
  for (const name of missing) {
    console.log(`FAIL missing ${join(extDist, name)}`);
  }
  failed += missing.length;
  console.log(
    `\nreview-smoke: ${missing.length} missing artefact(s) in ${extDist}` +
      " — extension/dist-test is a build artefact, not a source directory.",
  );
  console.log(
    "Run `npm run smoke:ext` first (it calls buildTestGrant(), which copies extension/dist to " +
      "extension/dist-test), then `npm run smoke:ext:review`.",
  );
}

/** A stored note, as the page receives it. `origin === null` is the pre-0.12 legacy blob. */
function note(id, origin, body) {
  return {
    id,
    origin,
    body,
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "text",
    status: "open",
    anchor: { selector: `#${id}` },
  };
}

function blob(notes) {
  return JSON.stringify({ version: 1, notes });
}

/**
 * The seeded profile: one origin store, the legacy blob, one proven copy (n1) and the keys that are
 * explicitly not note sets. `n1` already being in the target makes the assign one copy (n2) and the
 * undo one proven copy (n1) — both buttons are therefore present, and neither is a zero-copy no-op.
 */
function seedEntries() {
  return {
    [KEY_LEGACY]: blob([note("n1", null, "already copied"), note("n2", null, HOSTILE_BODY)]),
    [KEY_TARGET]: blob([note("n1", ORIGIN, "copied note")]),
    [KEY_PROVENANCE]: JSON.stringify({ n1: "2026-01-01T00:00:00.000Z" }),
    [KEY_SETTINGS]: JSON.stringify({ endpoint: "" }),
    [KEY_UI]: "panel",
  };
}

/**
 * Installed in the loaded page before the assign click.
 *
 * Two jobs: count every network entry point the page could reach, and record uncaught errors. The
 * counters are the evidence for "no network" *at runtime*; the `connect-src 'none'` meta tag alone
 * says what the page declares, not what it did. The load itself is covered separately by Resource
 * Timing, which lists every request a document made. `confirm` is answered yes because a headless
 * browser has no user to dismiss the assign dialog — the click case needs a decision.
 */
const INSTRUMENTATION = `(() => {
  const network = [];
  globalThis.__bpReviewNetwork = network;
  const g = globalThis;
  if (typeof g.fetch === "function") {
    const original = g.fetch;
    g.fetch = (...args) => { network.push("fetch:" + String(args[0])); return original.apply(g, args); };
  }
  if (typeof g.XMLHttpRequest === "function") {
    const open = g.XMLHttpRequest.prototype.open;
    g.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      network.push("xhr:" + String(url));
      return open.call(this, method, url, ...rest);
    };
  }
  if (typeof g.WebSocket === "function") {
    const Original = g.WebSocket;
    g.WebSocket = function (...args) { network.push("websocket:" + String(args[0])); return new Original(...args); };
  }
  if (typeof g.EventSource === "function") {
    const Original = g.EventSource;
    g.EventSource = function (...args) { network.push("eventsource:" + String(args[0])); return new Original(...args); };
  }
  if (typeof g.navigator === "object" && typeof g.navigator.sendBeacon === "function") {
    const original = g.navigator.sendBeacon.bind(g.navigator);
    g.navigator.sendBeacon = (...args) => { network.push("beacon"); return original(...args); };
  }
  const errors = [];
  globalThis.__bpReviewErrors = errors;
  g.addEventListener("error", (event) => errors.push(String(event.message ?? event.error ?? "error")));
  g.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason ?? "rejection")));
  g.confirm = () => true;
})();`;

/** Load the unpacked extension the way this Chrome build allows (same policy as smoke.mjs). */
async function launchWithExtension(profile) {
  const modern = await Browser.launch(findChrome(), profile, {
    extraArgs: ["--enable-unsafe-extension-debugging"],
  });
  try {
    await modern.send("Extensions.loadUnpacked", { path: extDist });
    return modern;
  } catch (error) {
    if (!/-32601|wasn't found|not found/.test(String(error?.message ?? error))) throw error;
    await modern.close();
  }
  return Browser.launch(findChrome(), profile, {
    extraArgs: [
      `--disable-extensions-except=${extDist}`,
      `--load-extension=${extDist}`,
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
    ],
  });
}

/** Attach to the extension's own worker, identified by its manifest name (see smoke.mjs). */
async function attachToWorker(browser) {
  const worker = await selectWorker({
    candidates: async () => {
      const { targetInfos } = await browser.send("Target.getTargets");
      return (targetInfos ?? [])
        .filter((t) => t.type === "service_worker" && String(t.url).startsWith("chrome-extension://"))
        .map((t) => ({ targetId: t.targetId, url: t.url }));
    },
    probe: async (targetId) => {
      await browser.attachTo((t) => t.targetId === targetId, { timeoutMs: 2000 });
      return await browser.evaluate("chrome.runtime.getManifest().name");
    },
    expect: /bluepencil/i,
    seen: () => [],
  });
  await browser.attachTo((t) => t.targetId === worker.targetId);
  return worker;
}

async function main() {
  const profile = await mkdtemp(join(tmpdir(), "bp-review-smoke-"));
  let browser;
  try {
    browser = await launchWithExtension(profile);
    const worker = await attachToWorker(browser);
    ok("the extension's own worker is attached", /bluepencil/i.test(worker.name), worker.name);

    // Seed the profile through the worker's own storage API — the page must read what a real
    // profile would hold, not a fixture the page itself wrote.
    const reviewUrl = await browser.evaluate("chrome.runtime.getURL('review.html')");
    const entries = seedEntries();
    await browser.evaluate(
      `(async () => {
         await chrome.storage.local.clear();
         await chrome.storage.local.set(${JSON.stringify(entries)});
         return true;
       })()`,
    );

    // Create the review tab and attach to it. Nothing under the `Page` domain is needed: the tab
    // is opened at the review URL directly and driven through the same session API the other smoke
    // suites use. Load-time network is read from Resource Timing; the click-time watch is installed
    // right after the document is up.
    const { targetId } = await browser.send("Target.createTarget", { url: reviewUrl });
    await browser.attachTo((t) => t.targetId === targetId);
    await browser.waitFor('document.readyState === "complete"', { timeoutMs: 20000 });
    await browser.waitFor('document.querySelectorAll("#review-root section.bp-review-group").length > 0', {
      timeoutMs: 20000,
    });
    await browser.evaluate(INSTRUMENTATION);

    const loaded = JSON.parse(
      await browser.evaluate(`(() => {
        const root = document.getElementById("review-root");
        const groups = Array.from(root.querySelectorAll("section.bp-review-group"));
        const legacy = groups.find((section) => section.dataset.legacy === "true");
        const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? "";
        return JSON.stringify({
          url: location.href,
          protocol: location.protocol,
          groupKeys: groups.map((section) => section.dataset.key),
          legacyLast: groups.length > 0 && legacy === groups[groups.length - 1],
          legacyInteractive: legacy === undefined
            ? -1
            : legacy.querySelectorAll("button, a, input, textarea, select").length,
          images: root.querySelectorAll("img, script, iframe, object, embed").length,
          pwned: globalThis.__bpReviewPwned === true,
          bodyText: Array.from(root.querySelectorAll(".bp-review-body"), (el) => el.textContent).join("\\n"),
          assign: root.querySelector('button[data-action="assign"]')?.textContent ?? null,
          undo: root.querySelector('button[data-action="undo"]')?.textContent ?? null,
          csp,
          resources: performance.getEntriesByType("resource").map((entry) => entry.name),
        });
      })()`),
    );

    ok("the review page loads from the extension's dist-test build",
      loaded.protocol === "chrome-extension:" && loaded.url.endsWith("/review.html"), loaded.url);
    ok("the page renders the seeded origin and legacy groups",
      JSON.stringify(loaded.groupKeys) === JSON.stringify([KEY_TARGET, KEY_LEGACY]), loaded.groupKeys.join(", "));
    ok("the legacy group is the last section", loaded.legacyLast === true);
    ok("the legacy group is read-only (no button, link or field)", loaded.legacyInteractive === 0,
      `${loaded.legacyInteractive} interactive element(s)`);
    ok("a note body that looks like markup stays text",
      loaded.images === 0 && loaded.pwned === false && loaded.bodyText.includes(HOSTILE_BODY),
      `elements=${loaded.images} pwned=${loaded.pwned}`);
    ok("the assign button is present with the origin and copy count",
      loaded.assign === `Copy 1 note to ${ORIGIN}`, String(loaded.assign));
    ok("the undo button is present for the proven copy",
      loaded.undo === `Remove 1 copied note from ${ORIGIN}`, String(loaded.undo));
    ok("the page declares connect-src 'none' and default-src 'none'",
      /connect-src 'none'/.test(loaded.csp) && /default-src 'none'/.test(loaded.csp), loaded.csp);

    // Resource Timing lists every request the document made while loading. All of them must belong
    // to the extension itself; an `http(s):` or `data:` entry would be a network or remote asset.
    const foreignResources = loaded.resources.filter((name) => !name.startsWith("chrome-extension://"));
    ok("the page loaded no resource from outside its own extension origin",
      foreignResources.length === 0, foreignResources.join(", "));

    // The built module really resolves: a missing export in the inlined data bundle leaves a module
    // that evaluates but has no functions. Asking for the surface is the build-level half of AC-B52.
    const surface = JSON.parse(
      await browser.evaluate(`(async () => {
        try {
          const mod = await import("./review.js");
          return JSON.stringify({ ok: true, keys: Object.keys(mod).sort() });
        } catch (error) {
          return JSON.stringify({ ok: false, error: String(error) });
        }
      })()`),
    );
    const expectedExports = [
      "aggregateOriginStores",
      "applyAssign",
      "applyUndo",
      "renderReview",
      "reviewActions",
      "runReviewPage",
    ];
    ok("review.js resolves as a module with its review surface",
      surface.ok === true && expectedExports.every((name) => surface.keys.includes(name)),
      surface.ok === true ? surface.keys.join(",") : surface.error);

    const reviewSource = await readFile(join(extDist, "review.js"), "utf8");
    ok("review.js inlines the data bundle instead of importing it",
      !/from\s+["'][^"']*dist\/data\.js["']/.test(reviewSource) && /planAssignToOrigin/.test(reviewSource));
    // The assign path, end to end in the browser: only the target blob and the sidecar may change.
    await browser.click('button[data-action="assign"]');
    await browser.waitFor(
      `document.getElementById("review-status")?.textContent?.startsWith("Copied 1 note") === true`,
      { timeoutMs: 10000 },
    );
    const afterAssign = await browser.evaluate(`(() => ({
      status: document.getElementById("review-status")?.textContent ?? null,
      network: globalThis.__bpReviewNetwork.slice(),
      errors: globalThis.__bpReviewErrors.slice(),
    }))()`);

    await attachToWorker(browser);
    const stored = JSON.parse(
      await browser.evaluate(`(async () => {
        const all = await chrome.storage.local.get(null);
        return JSON.stringify({
          keys: Object.keys(all).sort(),
          legacy: all[${JSON.stringify(KEY_LEGACY)}],
          target: all[${JSON.stringify(KEY_TARGET)}],
          provenance: all[${JSON.stringify(KEY_PROVENANCE)}],
        });
      })()`),
    );
    const targetIds = JSON.parse(stored.target).notes.map((entry) => entry.id).sort();
    const sidecar = JSON.parse(stored.provenance);

    ok("assign reports the copy on the status line",
      afterAssign.status === `Copied 1 note to ${ORIGIN}.`, String(afterAssign.status));
    ok("assign writes only the target blob and its sidecar",
      JSON.stringify(stored.keys) ===
        JSON.stringify([KEY_PROVENANCE, KEY_SETTINGS, KEY_TARGET, KEY_UI, KEY_LEGACY].sort()),
      stored.keys.join(","));
    ok("the legacy blob is byte-identical after the assign", stored.legacy === entries[KEY_LEGACY]);
    ok("the target store gained exactly the copied note",
      JSON.stringify(targetIds) === JSON.stringify(["n1", "n2"]), targetIds.join(","));
    ok("the sidecar records both provenance entries",
      Object.keys(sidecar).sort().join(",") === "n1,n2", Object.keys(sidecar).join(","));
    ok("the assign made no network call", afterAssign.network.length === 0,
      afterAssign.network.join(","));
    ok("the assign raised no error", afterAssign.errors.length === 0, afterAssign.errors.join(" | "));
  } finally {
    if (browser !== undefined) {
      await browser.close().catch(() => {});
    }
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

try {
  const missing = missingArtefacts();
  if (missing.length > 0) {
    reportMissing(missing);
  } else {
    requireBrowser({ browser: findChrome() });
    await main();
  }
} catch (error) {
  if (error?.constructor?.name === "Skipped") {
    const reason = error.reason ?? error.message;
    if (process.env.BP_REQUIRE_BROWSER === "1") {
      failed += 1;
      console.log(`FAIL ${reason} (BP_REQUIRE_BROWSER=1)`);
    } else {
      console.log(`SKIP ${reason}`);
    }
  } else {
    failed += 1;
    console.log(`FAIL unexpected — ${error?.stack ?? error}`);
  }
}

console.log(`\nreview-smoke: ${passed + failed} case(s), ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
