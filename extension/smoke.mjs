/**
 * Extension smoke test — load the built MV3 extension into a real Chrome and mount the layer (#34).
 *
 * This is the only test that can prove the three things the extension depends on, because all of
 * them are browser behaviour and none is reproducible in jsdom:
 *
 *   1. `chrome.scripting.executeScript({ world: "MAIN" })` really runs in the page's world, where
 *      `customElements` is a usable registry. Measured in the isolated world it is `null` (#32), so
 *      an extension that injected the wrong world would pass every unit test and fail exactly here.
 *   2. The layer survives a page CSP. The host below sets `script-src 'self'; style-src 'self'` with
 *      no `'unsafe-inline'`, the case that used to leave the layer mounted but unstyled (#33).
 *   3. The service worker actually starts and the element loads from the extension's own origin,
 *      which is what keeps the extension free of remote code.
 *
 * The launcher and CDP plumbing come from `scripts/lib/browser.mjs` — the same one the other smoke
 * tests use, so a browser-side regression surfaces in one place rather than three.
 *
 * The extended cases (§8) go past "it mounted": a live hub round-trip (`dist/server.js` as a child
 * process), persistence across a real reload, same-origin navigation, the double-mount guard, the
 * one-tag loader, and adapter selection. They reuse the same browser, worker and fixture host, and
 * reset `chrome.storage` settings before each, so one case cannot colour the next.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Browser, findChrome, requireBrowser } from "../scripts/lib/browser.mjs";
import { selectWorker } from "./probe.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const extDist = join(here, "dist");
const HOST_PORT = 9431;

/** The repository root; the new cases serve built artefacts (`dist/server.js`, `dist/attach.js`). */
const repoRoot = join(here, "..");
/** The built reference hub. The live round-trip case starts it as a child process. */
const SERVER_ENTRY = join(repoRoot, "dist", "server.js");
/** The built one-tag loader the loader-detection fixture serves. */
const ATTACH_ENTRY = join(repoRoot, "dist", "attach.js");
/** The hub's documented base path — the default of the built-in `http` adapter (contract §3). */
const HUB_BASE = "/api/v1/bluepencil";

/**
 * A page with a strict CSP: no inline scripts, no inline styles, no inline evaluation.
 *
 * The host's own styling comes from a *linked* stylesheet, not an inline `<style>`: under
 * `style-src 'self'` an inline sheet is discarded by design, so an inline rule would prove nothing
 * and would also make the "the host's styles are unaffected" check meaningless.
 */
const HOST_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'">
<title>extension smoke host</title>
<link rel="stylesheet" href="/host.css"></head>
<body><main id="host"><h1 id="target">Annotate me</h1><p id="para">Body text.</p></main></body></html>`;

/**
 * The host's own stylesheet, served same-origin so the CSP permits it.
 *
 * `main` starts below the bar for the same reason the parity fixture does: the layer's bar is fixed to
 * the top (FR-12.10) and would otherwise swallow a real pointer click aimed at `#target`, so the
 * composer could never open from the fixture's own markup. This is the host's styling, not the
 * layer's — the CSP check below still reads the `#target` colour it always did.
 */
const HOST_CSS = `body { margin: 0; }
main { padding: 5rem 1.5rem 1.5rem; }
#target { color: rgb(34, 34, 34); }`;

/**
 * A second host fixture: a page that already carries the layer itself (#70).
 *
 * The `<bluepencil-notes>` element is the page's own — in a real embed the one-tag loader would
 * define and connect it. Here the bare tag is enough, because detection reads the page's markup and
 * nothing else. The extension must recognise it and step aside rather than stack a second element
 * on top of it.
 */
const EMBED_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>extension smoke host — already embedded</title></head>
<body>
  <main id="host"><h1 id="target">Already annotated</h1><p id="para">This page owns the layer.</p></main>
  <bluepencil-notes id="host-layer"></bluepencil-notes>
</body></html>`;

/**
 * The hub fixture: the same annotatable markup as `HOST_HTML`, but **without** the CSP meta.
 *
 * The strict page's `default-src 'self'` also governs `connect-src`, so a page on it cannot fetch the
 * hub on a *different port* — the browser would block the request before the layer could ever make
 * it. A second fixture keeps the strict-CSP assertions above honest and still gives the round-trip a
 * document that is allowed to talk to the hub cross-origin.
 */
const HUB_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>extension smoke host — hub</title>
<link rel="stylesheet" href="/host.css"></head>
<body><main id="host"><h1 id="target">Annotate me</h1><p id="para">Body text.</p></main></body></html>`;

/**
 * The one-tag-loader fixture (#70): no CSP, and the documented loader tag itself.
 *
 * The loader is served from this same host at `/dist/attach.js`. Its *element* sibling is deliberately
 * not served: `detect.ts` keys on the loader's traces (the script tag and the `bluepencilAttach`
 * global), and if the loader also mounted a real `<bluepencil-notes>` the detection would — by its
 * documented precedence — report "element" instead. The "element" shape is already covered by the
 * `/embed` fixture, so this page pins the "loader" shape specifically.
 */
const LOADER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>extension smoke host — loader</title></head>
<body>
  <main id="host"><h1 id="target">Loaded by the one-tag loader</h1><p id="para">Body text.</p></main>
  <script src="/dist/attach.js" data-adapter="memory" data-environment="dev" data-language="en" data-route="url" data-identity="anonymous"></script>
</body></html>`;

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

async function startHost() {
  const server = createServer(async (req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/host.css")) {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end(HOST_CSS);
      return;
    }
    // The one-tag loader the `/loader` fixture asks for, served same-origin so detection finds a real
    // `attach.js` script tag. Nothing else under `/dist/` is served: see LOADER_HTML.
    //
    // Read lazily, inside the route: eager reading used to abort the whole browser round with an
    // opaque ENOENT when `dist/attach.js` was simply not built yet. Answering 404 instead localises
    // that to the one case that needs the loader, leaving every other case unaffected.
    if (url.startsWith("/dist/attach.js")) {
      let attachSource;
      try {
        attachSource = await readFile(ATTACH_ENTRY, "utf8");
      } catch {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("dist/attach.js is missing — run `npm run build`");
        return;
      }
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(attachSource);
      return;
    }
    // The second route (#70). Kept separate from HOST_HTML so the already-embedded case is a
    // fixture of its own rather than a flag threaded through the strict-CSP page.
    if (url.startsWith("/embed")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(EMBED_HTML);
      return;
    }
    // The hub fixture drops the CSP meta so the layer may fetch the hub cross-origin (see HUB_HTML).
    if (url.startsWith("/hub")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(HUB_HTML);
      return;
    }
    if (url.startsWith("/loader")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(LOADER_HTML);
      return;
    }
    // Everything else — `/`, `/second`, and the per-case paths below — serves the strict-CSP host.
    // `/second` deliberately reuses HOST_HTML: the navigation case must show the same annotatable
    // markup on a second path of the same origin, not a different document shape.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(HOST_HTML);
  });
  return new Promise((done) => {
    server.listen(HOST_PORT, "127.0.0.1", () => done(server));
  });
}

/* -------------------------------------------------------------------------- */
/* static checks — the extension must be loadable and must not fetch remote code */
/* -------------------------------------------------------------------------- */

async function checkArtefacts() {
  for (const required of ["manifest.json", "sw.js", "bridge.js", "detect.js", "options.html", "options.js",
    "bluepencil.element.iife.js", "build-info.json"]) {
    try {
      await stat(join(extDist, required));
      ok(`build produced ${required}`, true);
    } catch {
      ok(`build produced ${required}`, false, "missing — run `npm run build:ext`");
    }
  }

  const info = JSON.parse(await readFile(join(extDist, "build-info.json"), "utf8"));
  const actual = createHash("sha256")
    .update(await readFile(join(extDist, "bluepencil.element.iife.js")))
    .digest("hex");
  ok("extension ships this build's library bundle", actual === info.elementSha256,
    `build-info says ${info.elementSha256.slice(0, 12)}, file is ${actual.slice(0, 12)}`);

  const manifest = JSON.parse(await readFile(join(extDist, "manifest.json"), "utf8"));
  ok("manifest is MV3", manifest.manifest_version === 3);
  ok("asks for activeTab", (manifest.permissions ?? []).includes("activeTab"),
    `permissions=${JSON.stringify(manifest.permissions)}`);
  // Host access is granted up front, deliberately: without it the extension can only inject after
  // a click, which is the right *product* behaviour but makes the real round trip untestable in a
  // headless browser (measured: "Extension manifest must request permission to access this host").
  // The scope is http and https only. `file:///*` was dropped deliberately: it buys nothing a web
  // user needs, and it is the permission a store reviewer objects to first. Still no <all_urls>.
  const hosts = manifest.host_permissions ?? [];
  const ALLOWED_HOSTS = new Set(["http://*/*", "https://*/*"]);
  ok("host access is narrow and explicit",
    hosts.length > 0 && hosts.every((h) => ALLOWED_HOSTS.has(h)) && !hosts.includes("<all_urls>"),
    `host_permissions=${JSON.stringify(hosts)}`);
  ok("no unrelated permissions are requested",
    (manifest.permissions ?? []).every((p) =>
      ["scripting", "storage", "activeTab", "tabs"].includes(p)),
    `permissions=${JSON.stringify(manifest.permissions)}`);
  const csp = manifest.content_security_policy?.extension_pages ?? "";
  ok("extension pages allow no remote code",
    csp.includes("script-src 'self'") && !/https?:/.test(csp), `csp=${csp}`);

  const sw = await readFile(join(extDist, "sw.js"), "utf8");
  const bootstrap = await readFile(join(extDist, "bootstrap.js"), "utf8");
  ok("worker injects in the MAIN world", /world:\s*"MAIN"/.test(sw));
  // The element code reaches the page bundled inside the registered MAIN-world script — the only
  // channel measured to survive a strict page CSP. A page may not import a chrome-extension:// URL
  // ("Failed to fetch dynamically imported module") and may not evaluate source text ("'unsafe-eval'
  // is not an allowed source of script"), so neither may appear in either file.
  ok("the element code is bundled into the registered MAIN-world script",
    /registerContentScripts/.test(sw) && /bluepencil-notes/.test(bootstrap));
  ok("neither file evaluates or imports anything at runtime",
    !/new Function/.test(bootstrap) && !/\beval\s*\(/.test(bootstrap) &&
      !/import\s*\(/.test(bootstrap) && !/new Function/.test(sw));
  // Comments and error strings legitimately mention https; the code must not import or fetch one.
  const code = sw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  ok("worker imports nothing remote", !/from\s*["']https?:/.test(code));
  // A page must never be handed a URL it is expected to resolve: that is the remote-code path MV3
  // forbids, and it is also the one that does not work (see above).
  ok("worker never asks the page to import a URL", !/elementUrl/.test(code));
  // The worker hands over data only. Runtime code delivery is what the page CSP forbids, and shipping
  // the layer as a string would be exactly that — even from the extension's own origin.
  ok("the worker hands over settings, not source text",
    /__bluepencilConfig__/.test(sw) && !/__bluepencilSource__/.test(sw));
}

/* -------------------------------------------------------------------------- */
/* probe bookkeeping — pure logic, no browser (issue #60)                       */
/* -------------------------------------------------------------------------- */

/** A fake wall clock: `sleep` advances it, so the retry/backoff logic runs instantly. */
function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
}

/**
 * The bug #60 was bookkeeping, not browser behaviour: the selection loop recorded a targetId as
 * "probed" on its first answer, so a *single* transient failure (the worker had not finished its
 * first evaluation, a 2 s attach timeout, a CDP hiccup) excluded the real worker for the rest of the
 * 20 s budget and the run failed with "no extension service worker" while the worker was there.
 *
 * These cases pin the corrected behaviour with synthetic candidates and an injected clock — no
 * Chrome needed — so the flake can never come back unnoticed.
 */
async function checkProbeBookkeeping() {
  // (a) #60 exactly: the first name read fails, the second answers. The target must still be
  //     selected — this is the case the old one-shot logic failed.
  {
    const clock = fakeClock();
    let calls = 0;
    const result = await selectWorker({
      candidates: () => [{ targetId: "ours", url: "chrome-extension://abc/sw.js" }],
      probe: async () => {
        calls += 1;
        if (calls === 1) throw new Error("Inspected target navigated or closed");
        return "Bluepencil";
      },
      expect: /bluepencil/i,
      timeoutMs: 5000,
      now: clock.now,
      sleep: clock.sleep,
      maxAttempts: 3,
      backoffMs: 50,
      settleMs: 150,
    });
    ok("a target that fails its first probe is retried and still selected",
      result.targetId === "ours" && result.name === "Bluepencil" && result.attempts === 2,
      `targetId=${result.targetId} name=${result.name} attempts=${result.attempts}`);
  }

  // (b) A candidate that never answers must not shadow a later candidate that matches.
  {
    const clock = fakeClock();
    const result = await selectWorker({
      candidates: () => [
        { targetId: "component", url: "chrome-extension://dead/sw.js" },
        { targetId: "ours", url: "chrome-extension://abc/sw.js" },
      ],
      probe: async (targetId) => {
        if (targetId === "component") throw new Error("no manifest");
        return "Bluepencil";
      },
      expect: /bluepencil/i,
      timeoutMs: 5000,
      now: clock.now,
      sleep: clock.sleep,
      maxAttempts: 2,
      backoffMs: 50,
      settleMs: 150,
    });
    ok("a never-answering candidate does not prevent a later matching one",
      result.targetId === "ours", `targetId=${result.targetId} attempts=${result.attempts}`);
  }

  // (c) With no match at all the loop must still fail closed, and the message has to name each
  //     candidate with its attempt count and whether it was still retryable.
  {
    const clock = fakeClock();
    let error;
    try {
      await selectWorker({
        candidates: () => [
          { targetId: "a", url: "chrome-extension://a/sw.js" },
          { targetId: "b", url: "chrome-extension://b/sw.js" },
        ],
        probe: async () => {
          throw new Error("nope");
        },
        expect: /bluepencil/i,
        timeoutMs: 4000,
        now: clock.now,
        sleep: clock.sleep,
        maxAttempts: 3,
        backoffMs: 50,
        settleMs: 100,
      });
    } catch (thrown) {
      error = thrown;
    }
    const message = error?.message ?? "";
    ok("a genuine miss fails closed with the per-candidate attempt counts",
      error !== undefined && /a\/sw\.js/.test(message) && /b\/sw\.js/.test(message) &&
        /attempts=3/.test(message) && /retryable=no/.test(message),
      message);
  }
}

/* -------------------------------------------------------------------------- */
/* host-embed detection — pure function, no browser (issue #70)                 */
/* -------------------------------------------------------------------------- */

/**
 * `detectHostEmbed` against fake documents.
 *
 * The detection decides whether the extension mounts or steps aside, so its three shapes and their
 * precedence deserve a case each that needs no Chrome. It also keeps the loader case honest about
 * *both* traces: the `attach.js` script tag and the `bluepencilAttach` global it installs.
 */
async function checkDetect() {
  let detectHostEmbed;
  try {
    // Built standalone by `extension/build.mjs` (the bootstrap imports the same source), so this is
    // a seam onto the one implementation, not a second copy.
    ({ detectHostEmbed } = await import("./dist/detect.js"));
  } catch {
    ok("detect.js is built", false, "missing — run `npm run build:ext`");
    return;
  }

  // A fake document that "has" exactly the selectors it is given. Detection only calls
  // `querySelector`, so a stub for that one method is the whole contract.
  const docWith = (...selectors) => ({
    querySelector: (selector) => (selectors.includes(selector) ? { selector } : null),
  });

  // `globalThis.bluepencilAttach` is process-global state: set it only for the case that needs it
  // and restore whatever was there, so the cases cannot leak into one another.
  const hadAttach = Object.prototype.hasOwnProperty.call(globalThis, "bluepencilAttach");
  const previousAttach = globalThis.bluepencilAttach;
  delete globalThis.bluepencilAttach;
  try {
    ok("a <bluepencil-notes> element detects as \"element\"",
      detectHostEmbed(docWith("bluepencil-notes")) === "element");

    ok("an attach.js script detects as \"loader\"",
      detectHostEmbed(docWith('script[src*="attach.js"]')) === "loader");

    globalThis.bluepencilAttach = {};
    ok("a bluepencilAttach global detects as \"loader\"",
      detectHostEmbed(docWith()) === "loader");
    delete globalThis.bluepencilAttach;

    ok("a [data-endpoint] element detects as \"hub\"",
      detectHostEmbed(docWith("[data-endpoint]")) === "hub");

    ok("a page with none of the three detects as null",
      detectHostEmbed(docWith()) === null);

    // Precedence: the first match wins, in the order element → loader → hub.
    ok("the element wins over the loader and the hub",
      detectHostEmbed(docWith("bluepencil-notes", 'script[src*="attach.js"]', "[data-endpoint]")) === "element");
    ok("the loader wins over the hub",
      detectHostEmbed(docWith('script[src*="attach.js"]', "[data-endpoint]")) === "loader");
  } finally {
    if (hadAttach) globalThis.bluepencilAttach = previousAttach;
    else delete globalThis.bluepencilAttach;
  }
}

/* -------------------------------------------------------------------------- */
/* browser checks — the parts that only a real browser can answer               */
/* -------------------------------------------------------------------------- */

/**
 * The extension's own background worker, attached — or an error naming what was on the wire.
 *
 * Chrome builds disagree about the *name* of an MV3 worker's CDP target: some report the file the
 * manifest registers (`…/sw.js`), others report `…/service_worker.js` for the same manifest entry.
 * Matching the file name therefore makes this suite fail on a browser it does not control — measured
 * on the CI runner, where the extension had loaded correctly and the target list showed
 * `service_worker:chrome-extension://…/service_worker.js`. Pinning one spelling is a test that fails
 * for a reason that has nothing to do with the product.
 *
 * The worker is asked instead: `chrome.runtime.getManifest().name`, evaluated in the attached
 * context. That is the extension's own answer, and it also settles the second problem with a URL
 * match — this Chrome build runs a component extension and a built-in one, each with its own worker,
 * and the first `chrome-extension://` worker in the list is not necessarily ours.
 *
 * The selection itself lives in `./probe.mjs` (`selectWorker`), where the retry bookkeeping can be
 * driven by a test without a browser. The name read stays the discriminator: a failed read is
 * retryable there, never final, which is the fix for #60 — one transient miss used to exclude the
 * real worker for the rest of the budget.
 */
async function attachToBlueprintWorker(browser, { timeoutMs = 20000, expect = /bluepencil/i } = {}) {
  let latest = [];
  const worker = await selectWorker({
    // Re-read the target list on every pass: a worker that starts late must still become a candidate.
    candidates: async () => {
      const { targetInfos } = await browser.send("Target.getTargets");
      latest = targetInfos ?? [];
      return latest
        .filter((t) => t.type === "service_worker" && String(t.url).startsWith("chrome-extension://"))
        .map((t) => ({ targetId: t.targetId, url: t.url }));
    },
    // A name string on success; a throw on a transient failure. `selectWorker` retries both — the
    // old `.catch(() => undefined)` was the bug: it made one warm-up race a permanent verdict.
    probe: async (targetId) => {
      await browser.attachTo((t) => t.targetId === targetId, { timeoutMs: 2000 });
      return await browser.evaluate("chrome.runtime.getManifest().name");
    },
    expect,
    timeoutMs,
    // Only for the failure message: everything the wire showed, so a genuine miss is diagnosable.
    seen: () =>
      latest
        .filter((t) => t.type === "service_worker")
        .map((t) => `${t.type}:${t.url}`),
  });

  // The checks that follow read `browser`'s session, so attach to the winner explicitly.
  const attached = await browser.attachTo((t) => t.targetId === worker.targetId);
  return { ...attached, name: worker.name, candidates: worker.probed };
}

/** One line per probed candidate for a check's detail string. */
function formatProbes(probes) {
  return probes.length === 0
    ? "nothing"
    : probes
      .map((p) => `"${p.last}" <${p.url}> (${p.attempts} attempt(s)${p.retryable ? ", retryable" : ""})`)
      .join(" | ");
}

/**
 * Load the unpacked extension the way the browser in front of us allows.
 *
 * Chrome 137 removed `--load-extension` in *branded* builds. The CI runner runs
 * `google-chrome-stable`, so there the flag is accepted and then ignored — it shows up as "the
 * extension's service worker never appeared", not as an error, and the eleven checks behind it never
 * ran. Locally this suite ran on Playwright's unbranded Chromium, where the flag still works, which
 * is exactly how the gap stayed invisible.
 *
 * The supported way in is the `Extensions` domain: `Extensions.loadUnpacked`, which needs
 * `--enable-unsafe-extension-debugging` and the pipe transport this launcher already uses (over
 * `--remote-debugging-port` the command is refused).
 *
 * Older builds have no such command, so the command line stays as the fallback — with the killswitch
 * that restores `--load-extension` on Chrome 137–141. Unbranded Chromium never needed either.
 */
async function launchWithExtension(profile) {
  const modern = await Browser.launch(findChrome(), profile, {
    extraArgs: ["--enable-unsafe-extension-debugging"],
  });
  try {
    const { id } = await modern.send("Extensions.loadUnpacked", { path: extDist });
    return { browser: modern, how: `Extensions.loadUnpacked (id ${id})` };
  } catch (error) {
    if (!/-32601|wasn't found|not found/.test(String(error?.message ?? error))) throw error;
    await modern.close();
  }
  const legacy = await Browser.launch(findChrome(), profile, {
    extraArgs: [
      `--disable-extensions-except=${extDist}`,
      `--load-extension=${extDist}`,
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
    ],
  });
  return { browser: legacy, how: "--load-extension on the command line" };
}

/* -------------------------------------------------------------------------- */
/* shared drivers — one implementation of the mount/UI/store paths              */
/* -------------------------------------------------------------------------- */

/**
 * Attach the CDP session to the extension's worker, re-resolving it when its target has gone.
 *
 * A MV3 service worker is torn down aggressively, so a target id captured earlier can be stale by
 * the next case. Re-resolving by the worker's own name (`attachToBlueprintWorker`) is cheap when the
 * worker is alive — it returns on its first successful probe — and correct when it is not.
 */
async function attachToWorker(browser, worker) {
  if (worker?.targetId !== undefined) {
    try {
      return await browser.attachTo((t) => t.targetId === worker.targetId, { timeoutMs: 3000 });
    } catch {
      /* the worker was restarted — fall through and look it up again */
    }
  }
  return attachToBlueprintWorker(browser);
}

/**
 * Drive the worker's own mount entry point — exactly what the toolbar click and the keyboard shortcut
 * call, not a re-implementation. `force` is the documented "also load alongside a host embed" (#70).
 */
async function mountViaWorker(browser, worker, { force = false } = {}) {
  await attachToWorker(browser, worker);
  // Passing `undefined` for the third argument is the plain mount; the worker's default then applies.
  const forceArg = force ? "{ force: true }" : "undefined";
  return browser.evaluate(`(async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab || tab.id === undefined) return { ok: false, error: 'no active tab' };
      // Reaching the worker's own module registry without import(): the module was already evaluated
      // when the worker started, so its exports live on the global scope esbuild emitted.
      const mod = self.__bluepencilModule;
      if (mod && typeof mod.mountOnTab === 'function') {
        return await mod.mountOnTab(tab.id, tab.url ?? '', ${forceArg});
      }
      return { ok: false, error: 'worker module not reachable (' + typeof mod + ')' };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  })()`);
}

/**
 * Open `path` on the fixture host in a fresh, active tab and return its id.
 *
 * The tab is opened through the worker so it is Chrome's tab model that drives it — the same shape a
 * user's new tab has, and the tab `chrome.tabs.query({active:true})` then mounts into.
 */
async function openHostTab(browser, path) {
  await attachToWorker(browser);
  return browser.evaluate(
    `(async () => {
      const tab = await chrome.tabs.create({ url: 'http://127.0.0.1:${HOST_PORT}${path}', active: true });
      return tab.id ?? null;
    })()`,
  );
}

/**
 * Attach the CDP session to the host tab at an exact same-origin pathname and wait until it loaded.
 *
 * Matched by `pathname`, never by substring: `url.includes(":9431/")` would also match `/hub`, and a
 * wrong target produces failures that look like product defects. An exact pathname also stays unique
 * across the several tabs this suite leaves open.
 */
async function attachToHostPath(browser, pathname) {
  const page = await browser.attachToPageWhere((t) => {
    try {
      return new URL(t.url).pathname === pathname;
    } catch {
      return false;
    }
  });
  await browser.waitFor(`document.readyState === "complete"`, { timeoutMs: 20000 });
  return page;
}

/** Waits until the layer is mounted and running, so a case never clicks before the bar exists. */
async function waitForLayer(browser) {
  await browser.waitFor(`Boolean(document.querySelector('bluepencil-notes')?.blueprint)`, {
    timeoutMs: 20000,
  });
  await browser.waitFor(
    `Boolean(document.querySelector('.bp-root') && document.querySelector('.bp-bar'))`,
    { timeoutMs: 20000 },
  );
}

/** The store's synchronous view of the note set, read through the element's documented handle. */
const notesInStore = (browser) =>
  browser.evaluate(`document.querySelector('bluepencil-notes')?.blueprint?.store.notes() ?? []`);

/**
 * `browser.waitFor` as a boolean: a timeout is a red check, not an abort of the cases after it.
 * The expressions passed here always reach a real assertion — this only stops one failed wait from
 * cancelling the rest of the suite.
 */
async function poll(browser, expression, timeoutMs = 10000) {
  try {
    await browser.waitFor(expression, { timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/** The layer's own report of a bar toggle's pressed state (mirrors tests/e2e/parity-cases.mjs). */
const pressedExpr = (action) =>
  `document.querySelector('[data-bp-action="${action}"]')?.getAttribute('aria-pressed') === 'true'`;

/**
 * Arms a mode through the layer's own bar button and waits until the layer reports it pressed.
 *
 * The bar's toggles are switches, so an already-armed mode is left alone rather than toggled off —
 * the same idempotent arming the parity harness uses (armMode/setPressed there). It works for the
 * `panel` toggle too, which is how a case opens the panel any way other than by a marker click.
 */
async function armMode(browser, action) {
  if ((await browser.evaluate(pressedExpr(action))) !== true) {
    await browser.click(`[data-bp-action="${action}"]`);
  }
  await browser.waitFor(`(${pressedExpr(action)}) === true`, { timeoutMs: 5000 });
}

/** Fills and saves the open composer. The caller polls the store afterwards — never a fixed sleep. */
async function openComposerAndSave(browser, body) {
  try {
    await browser.waitFor(
      `(() => { const n = document.querySelector('.bp-composer'); if (!n) return false;
                const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`,
      { timeoutMs: 8000 },
    );
  } catch (error) {
    const diag = await browser.evaluate(`(() => {
      const pressed = [...document.querySelectorAll('[data-bp-action^="mode-"]')]
        .map((b) => b.getAttribute('data-bp-action') + '=' + b.getAttribute('aria-pressed'));
      return { composerExists: Boolean(document.querySelector('.bp-composer')),
               pressed,
               layers: document.querySelectorAll('bluepencil-notes').length };
    })()`);
    throw new Error(`composer never opened: ${JSON.stringify(diag)} (${error?.message ?? error})`);
  }
  await browser.evaluate(
    `(() => { const f = document.querySelector('.bp-composer .bp-textarea');
              if (!f) return false; f.focus(); f.select?.(); return true; })()`,
  );
  await browser.typeText(body);
  await browser.click('[data-bp-action="composer-save"]');
}

/**
 * Creates one note through the real capture path: arm a mode, click the target, fill the composer,
 * save. Returns the note the store holds afterwards (matched by body), or `null`.
 *
 * The store count is polled, so the save's asynchronous adapter round trip (bridge, hub, …) is waited
 * for instead of assumed. Mirrors `createNote` in tests/e2e/parity-cases.mjs.
 */
async function createNoteViaUi(browser, { target, body, mode = "text" }) {
  const before = (await notesInStore(browser)).length;
  await armMode(browser, `mode-${mode}`);
  await browser.click(target);
  await openComposerAndSave(browser, body);
  await browser.waitFor(
    `document.querySelector('bluepencil-notes').blueprint.store.notes().length === ${before + 1}`,
    { timeoutMs: 10000 },
  );
  const notes = await notesInStore(browser);
  return notes.filter((note) => String(note.body ?? "").includes(body)).at(-1) ?? null;
}

/**
 * The full settings shape the worker's `normalizeSettings` validates (extension/src/settings.ts).
 *
 * `identity:"anonymous"` is the smoke's default on purpose: the element's other choice, `prompt`,
 * opens a blocking dialog a headless browser cannot answer, and the suite must never wait on one.
 */
const EXTENSION_SETTINGS_DEFAULTS = {
  environment: "dev",
  appName: "",
  language: "en",
  store: "chromeStorage",
  identity: "anonymous",
  endpoint: "",
  auth: "none",
  token: "",
  tokenExpiresAt: "",
  deviceName: "",
  mountAlongsideHost: false,
};

/**
 * Write the extension's settings into `chrome.storage.local` from the worker's own context.
 *
 * The page cannot write them (`chrome.storage` does not exist in the page's world) and the options
 * page would have to drive its form; writing the blob where the mount path reads it is the shortest
 * honest route to the exact contract. Every field is written, so a case never inherits a half-set
 * blob from the options-page step above it — which leaves `store:"http"` pointing at a dead port.
 * Returns the worker handle it used, so the caller can keep a live one across a restart.
 */
async function writeExtensionSettings(browser, settings = {}) {
  const worker = await attachToBlueprintWorker(browser);
  const merged = { ...EXTENSION_SETTINGS_DEFAULTS, ...settings };
  await browser.evaluate(`(async () => {
    await chrome.storage.local.set({ "bluepencil:settings": ${JSON.stringify(merged)} });
    return true;
  })()`);
  return worker;
}

/**
 * Poll the worker's own toolbar state for `text`, then read the badge and title back.
 *
 * Attaching and reading in the worker is the only way to see the badge (it is `chrome.action` state,
 * which the page cannot reach). Returns `{ text, title }` when the badge reached `text` within the
 * budget, or `null` on timeout — a red check, never a thrown abort.
 */
async function waitForToolbarBadge(browser, worker, { text, timeoutMs = 5000 } = {}) {
  await attachToWorker(browser, worker);
  try {
    await browser.waitFor(
      `(async () => {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const id = tabs[0]?.id;
        return id !== undefined && (await chrome.action.getBadgeText({ tabId: id })) === ${JSON.stringify(text)};
      })()`,
      { timeoutMs },
    );
  } catch {
    return null;
  }
  return JSON.parse(await browser.evaluate(`(async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const id = tabs[0]?.id;
    if (id === undefined) return null;
    return JSON.stringify({
      text: await chrome.action.getBadgeText({ tabId: id }),
      title: await chrome.action.getTitle({ tabId: id }),
    });
  })()`));
}

/** A free loopback port, probed by binding and releasing one (same shape as the parity harness). */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Start the BUILT reference hub as a child process and wait until its health endpoint answers.
 *
 * `--cors "*"` is not optional: the fixture page lives on a *different loopback port*, so every
 * request from the layer to the hub is cross-origin and the browser refuses to expose a response
 * without the header. `--journal none` keeps the smoke out of the work tree's git history, exactly
 * like the embed smoke. The caller must `stop()` it — the hub holds the store file open.
 */
async function startHub(dir) {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      SERVER_ENTRY,
      "--store", join(dir, "notes.json"),
      "--host", "127.0.0.1",
      "--port", String(port),
      "--cors", "*",
      "--journal", "none",
      "--quiet",
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const base = `http://127.0.0.1:${port}${HUB_BASE}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`hub exited with ${child.exitCode}: ${stderr.trim().slice(0, 200)}`);
    }
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`hub did not become healthy: ${stderr.trim().slice(0, 200)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    port,
    base,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        // Bound the graceful wait: a hub that ignores SIGTERM must not hang the whole suite. After the
        // grace period the child is SIGKILLed (uncatchable), and its `exit` then resolves this promise.
        const forceKill = setTimeout(() => {
          child.kill("SIGKILL");
        }, 5000);
        child.once("exit", () => {
          clearTimeout(forceKill);
          resolve();
        });
        child.kill("SIGTERM");
      }),
  };
}

/**
 * Poll the hub's `GET /notes` from Node until a note whose body contains `tag` is there, or `null`.
 *
 * Read from Node — not from the page — because the page's own store would show the note even if the
 * POST never reached the hub, which is the one thing this has to prove.
 */
async function waitForHubNote(base, tag) {
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      const response = await fetch(`${base}/notes`);
      const payload = await response.json();
      const found = (payload.notes ?? []).find((note) => String(note.body ?? "").includes(tag));
      if (found !== undefined) return found;
    } catch {
      /* a transient miss is retried until the deadline */
    }
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Run one extended case and, if a thrown wait aborts it, report that as a red check and move on.
 *
 * A case that cannot complete must not silently cancel the cases after it: the suite's value is the
 * whole set, and a thrown timeout is exactly the failure this must surface rather than swallow.
 */
async function runCase(name, fn) {
  try {
    await fn();
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name} — ${error?.message ?? error}`);
  }
}

async function checkInBrowser() {
  const server = await startHost();
  const profile = await mkdtemp(join(tmpdir(), "bp-ext-smoke-"));
  const launched = await launchWithExtension(profile);
  const browser = launched.browser;

  try {
    await browser.navigate(`http://127.0.0.1:${HOST_PORT}/`);
    await browser.waitFor(`document.readyState === "complete"`);

    // #70, the "without one" half of the issue's two cases: this fixture carries no embed of its own,
    // so the extension is the only possible source of the layer. Asserting the page starts clean is
    // what makes the later "the layer mounted" mean the extension put it there — on a page that had
    // one all along that assertion would pass without the worker doing anything.
    const preMount = await browser.evaluate(
      "document.querySelectorAll('bluepencil-notes').length",
    );
    ok("the plain host starts without a layer of its own", preMount === 0, `found ${preMount}`);

    // 1. The service worker must exist at all. A manifest error stops it, and every later
    //    assertion would then fail with a confusing "nothing injected" instead.
    //
    //    Which *name* it has on the CDP wire differs between Chrome builds: some report the file the
    //    manifest registers (`…/sw.js`), others `…/service_worker.js` for the same manifest entry.
    //    Matching on that file name makes the suite fail on a browser it does not control — measured
    //    on the CI runner, where the extension had loaded fine and the only difference was the name.
    //
    //    So the worker identifies itself instead: `chrome.runtime.getManifest().name`, read from the
    //    attached context. That is stronger evidence than a URL suffix, and it is immune to the other
    //    extensions the browser ships — this Chrome build runs a component extension and a built-in
    //    one, each with its own worker, and attaching to the first `chrome-extension://` worker would
    //    evaluate in a context that has neither `chrome.scripting` nor this extension's module.
    // A missing worker is a thrown error from the helper, with every worker it probed and its name —
    // failing here is clearer than eleven later failures that all say "nothing was injected".
    const worker = await attachToBlueprintWorker(browser);
    ok("the extension's own service worker is attached", /bluepencil/i.test(worker.name),
      `attached ${worker.name} via ${launched.how}; probed ${formatProbes(worker.candidates)}`);

    // 2. Drive the worker's own mount entry point.
    //
    //    `import()` is not available in a ServiceWorkerGlobalScope (measured: "import() is
    //    disallowed on ServiceWorkerGlobalScope"), and `chrome.runtime.sendMessage` from the worker
    //    reaches only *other* extension contexts — the worker does not receive its own message
    //    (measured: "Could not establish connection. Receiving end does not exist."). The bridge
    //    would relay, but it only exists after a first mount. So the mount function is invoked
    //    directly in the worker's own context: the same function the toolbar and keyboard handlers
    //    call, not a re-implementation of it.
    //
    //    The tab is resolved by `active: true`, never by matching its URL. Measured in this
    //    browser: `chrome.tabs.query` returns every field of a tab — `id`, `index`, `status`,
    //    `width`, `windowId` — and omits exactly `url` and `title`, because those need a grant the
    //    extension does not hold. A URL search would report "not found" on a working extension.
    const mountResult = await mountViaWorker(browser, worker);
    ok("the worker mounts the layer on the active tab", mountResult?.ok === true,
      `mount: ${JSON.stringify(mountResult)}`);

    // 3. Assert on the page itself, on the *host* tab specifically: a headless launch leaves an
    //    `about:blank` page open next to the one the test navigated, and asserting on whichever
    //    comes first would report a working extension as broken.
    const hostPage = await browser.attachToPageWhere((t) => t.url.includes(String(HOST_PORT)));
    ok("the assertions run against the host tab", hostPage.url.includes(String(HOST_PORT)),
      `attached to ${hostPage.url}`);
    const state = JSON.parse(await browser.evaluate(`(() => {
      const el = document.querySelector('bluepencil-notes');
      const root = document.querySelector('.bp-root');
      const cs = root ? getComputedStyle(root) : null;
      const registry = typeof customElements !== 'undefined' ? customElements : null;
      return JSON.stringify({
        csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || '',
        hasElement: !!el,
        store: el?.getAttribute('data-store') ?? null,
        // What the layer *did* with the configuration, read from its own handle. The attribute above
        // is only what the wrong vocabulary left behind — #53 lived exactly in that gap. It must stay
        // absent: the data- prefix is the loader's spelling, and the element never reads it.
        legacyDataStoreAttribute: el?.getAttribute('data-store') ?? null,
        adapterName: el?.blueprint?.store?.adapterName ?? null,
        adapterAttribute: el?.getAttribute('adapter') ?? null,
        environmentAttribute: el?.getAttribute('environment') ?? null,
        // Is the extension storage API reachable from the page's own world? The layer runs in exactly
        // this world, so this decides whether the chromeStorage adapter can persist anything here.
        pageChromeStorage: typeof chrome === 'undefined'
          ? 'no chrome object'
          : (chrome.storage ? 'chrome.storage present' : 'chrome.storage absent'),
        pageChromeKeys: typeof chrome === 'undefined' ? '(no chrome)' : Object.keys(chrome).join(','),
        hasRoot: !!root,
        position: cs?.position ?? null,
        zIndex: cs?.zIndex ?? null,
        barButtons: document.querySelectorAll('.bp-bar button').length,
        inlineSheet: !!document.querySelector('style[data-bp-styles]')?.sheet,
        adopted: (document.adoptedStyleSheets || []).length,
        registryOk: registry !== null,
        elementRegistered: registry !== null && !!registry.get('bluepencil-notes'),
      });
    })()`));

    ok("the host really has a strict CSP",
      state.csp.includes("style-src 'self'") && !state.csp.includes("unsafe-inline"),
      `csp=${state.csp}`);
    ok("the main world has a usable customElements registry", state.registryOk === true);
    ok("the element registered in the page's world", state.elementRegistered === true,
      "the custom element is missing — the injection did not run in the MAIN world");
    ok("the layer mounted", state.hasElement === true && state.hasRoot === true);
    ok("the layer uses the extension's own store", state.adapterAttribute === "chromeStorage",
      `adapter=${state.adapterAttribute}`);
    // The other half of #53: the wrong vocabulary must not come back. `data-store` was what the worker
    // wrote, what nothing read, and what the attribute readback below used to be asserted on.
    ok("no loader-vocabulary attribute is left on the element",
      state.legacyDataStoreAttribute === null,
      `data-store=${state.legacyDataStoreAttribute}`);

    // 3b. The store's own path, end to end (#53). The layer runs in the page's world, where
    //     `chrome.storage` does not exist, so its `chromeStorage` adapter relays through the
    //     isolated-world bridge. That relay is new code and asserting the adapter's *name* would not
    //     exercise it — measured: before the bridge existed the name already read `chromeStorage`
    //     while every write went nowhere. So the round trip is driven here, on the page's own
    //     channel, with a sentinel: page → bridge → chrome.storage → page. The worker reads the same
    //     key back further down, which is what proves it landed in the extension's storage rather
    //     than in something page-local.
    const sentinel = JSON.parse(await browser.evaluate(`(async () => {
      const origin = location.origin;
      const key = 'bp-smoke-bridge-sentinel';
      const replies = new Map();
      const onReply = (event) => {
        const data = event.data;
        if (!data || data.source !== 'bluepencil-page' || typeof data.requestId !== 'string') return;
        // The request this listener is waiting on is delivered here too (same window), and it carries
        // no reply field — only an answer does. Without this, the first match is always the request.
        if (!('reply' in data)) return;
        const resolve = replies.get(data.requestId);
        if (resolve) { replies.delete(data.requestId); resolve(data.reply ?? {}); }
      };
      window.addEventListener('message', onReply);
      let seq = 0;
      const call = (payload) => new Promise((resolve) => {
        const requestId = 'smoke-' + (++seq);
        const timer = setTimeout(() => {
          replies.delete(requestId);
          resolve({ ok: false, error: 'no answer within 5000 ms' });
        }, 5000);
        replies.set(requestId, (reply) => { clearTimeout(timer); resolve(reply); });
        window.postMessage({ source: 'bluepencil-page', kind: 'storage', ...payload, requestId }, origin);
      });
      const set = await call({ op: 'set', items: { [key]: 'from-the-page' } });
      const got = await call({ op: 'get', keys: [key] });
      window.removeEventListener('message', onReply);
      return JSON.stringify({
        key,
        setOk: set.ok === true,
        error: set.error ?? got.error ?? null,
        getOk: got.ok === true,
        value: got.value ? got.value[key] ?? null : null,
      });
    })()`));

    ok("a page can persist into the extension's storage over the bridge",
      sentinel.setOk === true && sentinel.getOk === true && sentinel.value === "from-the-page",
      JSON.stringify(sentinel));
    // The gap #53 was: the worker wrote the configuration, the layer never read it. Asserting the
    // attribute alone cannot fail for that reason, so this reads the store the layer actually uses.
    ok("the configured store reached the layer, not just the element",
      state.adapterName === "chromeStorage",
      `adapterName=${state.adapterName} — the element reads unprefixed attribute names (adapter, environment, app, identity, endpoint, token…)`);
    console.log(
      `INFO page world: ${state.pageChromeStorage}; chrome keys: ${state.pageChromeKeys}; ` +
      `adapter attribute: ${state.adapterAttribute}; environment attribute: ${state.environmentAttribute}`,
    );
    ok("the layer is styled under a strict CSP",
      state.position === "fixed" && state.zIndex !== null && state.zIndex !== "auto",
      `position=${state.position} zIndex=${state.zIndex} — the constructable fallback did not run`);
    ok("the bar rendered its buttons", state.barButtons >= 5, `only ${state.barButtons}`);
    ok("exactly one stylesheet path was taken",
      (state.inlineSheet ? 1 : 0) + (state.adopted > 0 ? 1 : 0) === 1,
      `inline=${state.inlineSheet} adopted=${state.adopted}`);

    // 4. The host's own styles must be untouched: the layer adds, it does not restyle the page.
    const hostColour = await browser.evaluate(
      `getComputedStyle(document.getElementById('target')).color`,
    );
    ok("the host page's own styles are unaffected", hostColour === "rgb(34, 34, 34)",
      `host h1 colour is ${hostColour}`);

    // 5. The on/off switch (#36).
    //
    //    Driven from the page through the injected bridge, not from the worker: a service worker
    //    does not receive its own `chrome.runtime.sendMessage` ("Receiving end does not exist"), and
    //    the page route is the one a real caller uses anyway.
    //
    //    The request is fired and *not* awaited. A per-request promise resolves through a
    //    `Runtime.evaluate` context that the extension's own isolated world answers from, and
    //    measured: the reply is delivered while that context is still resolving, so an `await` on it
    //    always times out even though the reply arrives — the layer really did toggle (verified by
    //    reading `enabled` back). Firing, waiting, then reading the collected replies is the shape
    //    that works, and it is also what a real page does: it never blocks on the extension.
    await browser.attachToPageWhere((t) => t.url.includes(String(HOST_PORT)));
    await browser.evaluate(`(() => {
      window.__BP_REPLIES__ = [];
      window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (event.data?.source !== 'bluepencil-page' || event.data?.reply === undefined) return;
        window.__BP_REPLIES__.push({ id: event.data.requestId ?? null, reply: event.data.reply });
      });
      window.__BP_POST__ = (enabled, id) => {
        window.postMessage({ source: 'bluepencil-page', kind: 'toggle', enabled, requestId: id },
          window.location.origin);
      };
      return 'armed';
    })()`);

    await browser.evaluate(`(() => { window.__BP_POST__(false, 'off'); window.__BP_POST__(true, 'on'); return 'gesendet'; })()`);
    await new Promise((done) => setTimeout(done, 1200));

    const replies = JSON.parse(
      await browser.evaluate("JSON.stringify(window.__BP_REPLIES__ ?? [])"),
    );
    const off = replies.find((r) => r.id === "off")?.reply ?? null;
    const on = replies.find((r) => r.id === "on")?.reply ?? null;

    ok("the on/off switch answers the page", off?.ok === true && on?.ok === true,
      `off=${JSON.stringify(off)} on=${JSON.stringify(on)} replies=${replies.length}`);

    await new Promise((done) => setTimeout(done, 300));
    const after = JSON.parse(await browser.evaluate(`(() => {
      const el = document.querySelector('bluepencil-notes');
      return JSON.stringify({
        stillThere: el !== null,
        enabled: el === null ? null : el.getAttribute('enabled'),
        barVisible: document.querySelectorAll('.bp-bar button').length,
      });
    })()`));

    // The element must survive being switched off — that is the whole point of using `enabled`
    // rather than removing it. A teardown would also pass "the bar is gone" while losing the state
    // a user has open, so the element's presence is asserted too.
    ok("switching off hides the layer without tearing it out",
      after.stillThere === true && after.enabled === "true" && after.barVisible >= 5,
      `after toggle: present=${after.stillThere} enabled=${after.enabled} buttons=${after.barVisible}`);

    // 6. The options page — the extension's own UI, and the only place a credential is entered.
    //
    //    Mounting was covered and the settings page was not, which is the wrong way round: the
    //    credential is what decides which header leaves the browser, and the whole reason the mode is
    //    a select rather than a header name is that the wrong one fails as a 401 that reads like a
    //    dead server. Nothing here needs a signing key: the page reads `exp` out of a token to tell
    //    the user when it dies and verifies nothing (the hub is the only party that decides), so
    //    a hand-built payload is enough — and asserting on it *is* the check that the page does not
    //    pretend to verify anything.
    await browser.attachTo((t) => t.targetId === worker.targetId);

    // The other half of the sentinel round trip in step 3b: the page cannot see this object, so a
    // value here is what makes that check mean "it was persisted", not "it was echoed back".
    const persisted = JSON.parse(await browser.evaluate(`(async () => {
      const key = 'bp-smoke-bridge-sentinel';
      const stored = await chrome.storage.local.get(key);
      await chrome.storage.local.remove(key);
      return JSON.stringify({ value: stored[key] ?? null });
    })()`));
    ok("the sentinel the page wrote is in the extension's own storage",
      persisted.value === "from-the-page", JSON.stringify(persisted));

    const openedTab = await browser.evaluate(`(async () => {
      const tab = await chrome.tabs.create({ url: chrome.runtime.getURL("options.html"), active: true });
      return tab.id ?? null;
    })()`);
    ok("the options page can be opened from the extension", openedTab !== null, `tab id ${openedTab}`);

    await browser.attachToPageWhere((t) => t.url.endsWith("/options.html"));
    await browser.waitFor('document.querySelector("#auth") !== null');

    const modes = JSON.parse(
      await browser.evaluate(
        'JSON.stringify(Array.from(document.querySelectorAll("#auth option"), (o) => o.value))',
      ),
    );
    ok("the options page offers every credential mode",
      modes.join(",") === "none,secret,token", modes.join(","));

    // The disclosure, and it is checked here rather than trusted from the HTML: the Chrome Web Store
    // requires a prominent disclosure *in the product's own UI* (User Data FAQ §10), so "the markup
    // exists in the source" is the wrong question — what has to be true is that the rendered page
    // says what is stored and points at the policy.
    const disclosure = JSON.parse(await browser.evaluate(`(() => {
      const el = document.querySelector(".disclosure");
      return JSON.stringify({
        present: el !== null,
        heading: el?.querySelector("h2")?.textContent ?? null,
        bullets: el?.querySelectorAll("li").length ?? 0,
        policyLink: el?.querySelector("a")?.getAttribute("href") ?? null,
      });
    })()`));
    ok("the options page discloses what is stored and links the policy",
      disclosure.present === true && /What Bluepencil stores/.test(disclosure.heading ?? "") &&
        disclosure.bullets >= 3 && /privacy/i.test(disclosure.policyLink ?? ""),
      JSON.stringify(disclosure));

    // Six hours out, in the JWT's own unit (seconds since the epoch). The signature is nonsense on
    // purpose: nothing on this page may look at it.
    const expSeconds = Math.floor(Date.now() / 1000) + 6 * 60 * 60;
    const payload = Buffer.from(JSON.stringify({ exp: expSeconds, device: "smoke-laptop" })).toString("base64url");
    const smokeToken = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${payload}.signature-nobody-checks`;

    // The page's own `load()` fills the form asynchronously: it reads `chrome.storage` first and then
    // writes every field. `#auth` is in the parsed HTML before `options.js` (a deferred module) has
    // run, so waiting for it proves nothing, and filling the form while `load()` is still in flight
    // lets that `fill()` overwrite what this check set — after which the save stores the defaults and
    // the poll below times out. Measured on CI: identical commit, one run green and one red on exactly
    // that poll. `#credential-hint` ships empty and is written only by `describeCredential()`, which is
    // the last thing `load()` does — so a non-empty hint is the page saying "I am filled".
    await browser.waitFor('document.getElementById("credential-hint").textContent.trim().length > 0');

    // Fill and save in one call, then *poll* for the effect instead of sleeping: `chrome.storage` is
    // the contract, and a fixed 400 ms is the kind of assumption that holds on a laptop and fails on
    // a loaded runner. Measured: this check died once with "Inspected target navigated or closed"
    // while the identical suite had passed minutes earlier, so the wait moved to the thing that
    // actually has to be true.
    await browser.evaluate(`(() => {
      const set = (id, value) => {
        const el = document.getElementById(id);
        el.value = value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      set("store", "http");
      set("endpoint", "http://127.0.0.1:8787/bluepencil");
      set("auth", "token");
      set("deviceName", "smoke-laptop");
      set("token", ${JSON.stringify(smokeToken)});
      document.getElementById("form").requestSubmit();
      return true;
    })()`);

    await browser.waitFor(`(async () => {
      const saved = (await chrome.storage.local.get("bluepencil:settings"))["bluepencil:settings"];
      return Boolean(saved && saved.auth === "token" && saved.deviceName === "smoke-laptop");
    })()`);

    const saved = JSON.parse(await browser.evaluate(`(async () => {
      const stored = await chrome.storage.local.get("bluepencil:settings");
      const state = document.getElementById("token-state");
      return JSON.stringify({
        settings: stored["bluepencil:settings"] ?? null,
        stateHidden: state.hidden,
        stateText: state.textContent,
        deviceVisible: document.getElementById("device-field").hidden === false,
        hint: document.getElementById("credential-hint").textContent,
        status: document.getElementById("status").textContent,
      });
    })()`));

    ok("the options page stores the credential mode, not just a token",
      saved.settings?.auth === "token" && saved.settings?.deviceName === "smoke-laptop",
      JSON.stringify(saved.settings));
    // A save that never happened must not look like a slow one: the page says so itself, and this
    // turns "timed out after 20000 ms" into the sentence that says why (a refused hub URL, a
    // validation block) — the failure mode measured on CI.
    ok("the page says it saved, rather than refusing silently",
      saved.status === "Saved.", `status=${JSON.stringify(saved.status)}`);
    ok("the stored expiry is read out of the token rather than typed",
      typeof saved.settings?.tokenExpiresAt === "string" &&
        Math.abs(Date.parse(saved.settings.tokenExpiresAt) - expSeconds * 1000) < 5000,
      `tokenExpiresAt=${saved.settings?.tokenExpiresAt} expected≈${new Date(expSeconds * 1000).toISOString()}`);
    ok("the page tells the user when the token expires, and shows the device field",
      saved.stateHidden === false && /expires in about/i.test(saved.stateText) && saved.deviceVisible === true,
      `hidden=${saved.stateHidden} text=${JSON.stringify(saved.stateText)} device=${saved.deviceVisible}`);
    ok("the token mode names the header it will send",
      /Authorization: Bearer/i.test(saved.hint),
      JSON.stringify(saved.hint));

    // Readability, in both schemes.
    //
    // The page paints its own text and the browser paints the controls and their popup, so the two
    // can disagree: on a dark-mode screenshot (2026-10-01) the option row of the open dropdown was
    // white on white — invisible — and the hub warning inherited the browser's white text onto
    // its own light background, 1.05:1. The pair is therefore the contract, and it is measured
    // rather than trusted: any field below 4.5:1 fails, in either scheme.
    const contrastProbe = `(() => {
      const probe = document.createElement("span");
      probe.style.display = "none";
      document.body.append(probe);
      // System colours ("Field", "FieldText") are valid colour values; reading them back through a
      // probe resolves whichever keyword the browser used into rgb() we can compare.
      const toRgb = (value) => {
        probe.style.color = value;
        const match = getComputedStyle(probe).color.match(/[0-9.]+/g);
        return match ? match.slice(0, 3).map(Number) : null;
      };
      const channel = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
      const lum = (rgb) => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
      const ratio = (a, b) => {
        const x = lum(a), y = lum(b);
        return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100;
      };
      const sample = (selector, label) => {
        const el = document.querySelector(selector);
        if (!el) return { label, background: null, color: null, ratio: null };
        // A transparent field paints nothing itself: the colour a reader sees is the first opaque
        // background above it, which is what the text has to contrast with. This block stays free of
        // backslashes and backticks on purpose: it is a template literal, so a single backslash
        // reaches the browser as an escape and silently broke the transparency test (a transparent
        // background was reported as opaque, which is the opposite of what this check needs).
        const alpha = (value) => {
          if (value === "transparent") return 0;
          const parts = String(value).match(/[0-9.]+/g) || [];
          return parts.length >= 4 ? Number(parts[3]) : parts.length ? 1 : 0;
        };
        const opaque = (value) => Boolean(value) && alpha(value) > 0;
        let node = el, background = null;
        while (node && !opaque(background)) {
          background = getComputedStyle(node).backgroundColor;
          node = node.parentElement;
        }
        if (!opaque(background)) background = "Canvas";
        const cs = getComputedStyle(el);
        // Keep the walk in the failure message: a contrast failure is nearly always a field that
        // never got a background of its own, and then the chain is the whole answer.
        const chain = [];
        for (let walk = el; walk; walk = walk.parentElement) {
          chain.push(walk.tagName.toLowerCase() + ":" + getComputedStyle(walk).backgroundColor);
        }
        const bg = toRgb(background), fg = toRgb(cs.color);
        return { label, background, color: cs.color, chain,
                 ratio: bg && fg ? ratio(fg, bg) : null };
      };
      return JSON.stringify([
        sample("#environment", "the environment select"),
        sample("#appName", "a text field"),
        sample("#token", "the credential field"),
        sample("#auth option", "an option in the open dropdown"),
        sample(".warn", "the hub warning"),
        sample(".hint", "a hint line"),
        sample(".disclosure", "the data disclosure"),
      ]);
    })()`;

    for (const scheme of ["light", "dark"]) {
      await browser.setColorScheme(scheme);
      const fields = JSON.parse(await browser.evaluate(contrastProbe));
      const unreadable = fields.filter((f) => typeof f.ratio !== "number" || f.ratio < 4.5);
      ok(`the options page stays readable in ${scheme} mode`, unreadable.length === 0,
        unreadable.length
          ? unreadable.map((f) => `${f.label}: ${f.color} on ${f.background} = ${f.ratio ?? "unmeasurable"} [${(f.chain ?? []).join(" < ")}]`).join("; ")
          : fields.map((f) => `${f.label} ${f.ratio}:1`).join(", "));
    }
    await browser.setColorScheme("light");

    // 7. A page that already embeds the layer (#70).
    //
    //    The extension's own `__bluepencilMounted` guard only knows about a *second injection by
    //    itself*; it says nothing about a `<bluepencil-notes>` element the page created, so the old
    //    code stacked a second overlay over the same notes. Detection now runs before every mount and,
    //    by default, steps aside — and it must say *why*, which is what the toolbar badge carries.
    //
    //    A fixture of its own (`/embed`) rather than a flag on the strict-CSP host: the case is about
    //    the page's own markup, and mixing the two would make a failure ambiguous.
    await browser.attachTo((t) => t.targetId === worker.targetId);
    const embedTabId = await browser.evaluate(
      `(async () => {
        const tab = await chrome.tabs.create({ url: 'http://127.0.0.1:${HOST_PORT}/embed', active: true });
        return tab.id ?? null;
      })()`,
    );
    ok("the already-embedded fixture opens in its own tab", embedTabId !== null, `tab id ${embedTabId}`);

    await browser.attachToPageWhere((t) => t.url.includes("/embed"));
    await browser.waitFor('document.readyState === "complete"');

    // Arm the page's own listener *before* the mount. The report is a `postMessage` from the MAIN
    // world, and a listener that arrives afterwards would miss a mount that is deliberately silent.
    // This is the page seeing, first-hand, that detection named a source — not the badge echoing it.
    await browser.evaluate(`(() => {
      window.__BP_HOST_REPORTS__ = [];
      window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (data && data.source === 'bluepencil-extension' && data.kind === 'host-embed-detected') {
          window.__BP_HOST_REPORTS__.push({ host: data.host ?? null });
        }
      });
      return 'armed';
    })()`);

    // Mount through the worker's own entry point, exactly as the toolbar click would. On this page it
    // must find the embed first and step aside rather than append a second element.
    const embedMount = await mountViaWorker(browser, worker);
    ok("the worker's mount call completes on an already-embedded page",
      embedMount?.ok === true, `mount: ${JSON.stringify(embedMount)}`);

    // The page → bridge → worker relay is asynchronous, so poll rather than sleep a fixed time.
    await browser.attachToPageWhere((t) => t.url.includes("/embed"));
    await browser.waitFor("(window.__BP_HOST_REPORTS__ || []).length > 0");
    const embedState = JSON.parse(await browser.evaluate(`(() => {
      const layers = document.querySelectorAll('bluepencil-notes');
      return JSON.stringify({
        reports: window.__BP_HOST_REPORTS__ ?? [],
        layers: layers.length,
        ownLayer: document.getElementById('host-layer') !== null,
        // The page's own element is the one with the fixture's id; anything else would be the
        // extension's. Counting by "not the page's own" avoids depending on which attributes the
        // extension writes, which change with the store the options step selected above.
        extensionLayers: document.querySelectorAll('bluepencil-notes:not(#host-layer)').length,
      });
    })()`));

    // Note: the page's *own* element legitimately renders its own `.bp-root` — loading the layer's
    // code is what defines the custom element, and the fixture's element upgrades with it. What must
    // not happen is a *second* element: that is the count below, not the presence of any UI at all.
    ok("the page's own <bluepencil-notes> is not duplicated",
      embedState.layers === 1 && embedState.ownLayer === true && embedState.extensionLayers === 0,
      `layers=${embedState.layers} own=${embedState.ownLayer} extensionLayers=${embedState.extensionLayers}`);
    ok("the extension surfaces the detected source as \"element\"",
      embedState.reports.some((r) => r.host === "element"), JSON.stringify(embedState.reports));

    // The badge is the user-facing half of the same fact: it names what was found. The chain under
    // test is the full one — MAIN world → bridge → worker → chrome.action.
    const badgeState = await waitForToolbarBadge(browser, worker, { text: "host", timeoutMs: 5000 });
    ok("the toolbar badge marks the tab as host-embedded, naming the source",
      badgeState !== null && badgeState.text === "host" &&
        /already embeds it \(element\)/.test(badgeState.title ?? ""),
      JSON.stringify(badgeState));

    // 7b. The override (#70): stepping aside must not latch. The page's own embed is the *default*
    //     reason to stay out, not a final verdict — otherwise the "also load" switch could never work,
    //     because the embed would already have decided for the tab.
    const forcedMount = await mountViaWorker(browser, worker, { force: true });
    ok("a forced mount still works on an already-embedded page",
      forcedMount?.ok === true, `mount: ${JSON.stringify(forcedMount)}`);

    await browser.attachToPageWhere((t) => t.url.includes("/embed"));
    await browser.waitFor("document.querySelectorAll('bluepencil-notes').length >= 2");
    const forcedState = JSON.parse(await browser.evaluate(`(() => {
      return JSON.stringify({
        layers: document.querySelectorAll('bluepencil-notes').length,
        // "The extension's own" is the element that is not the page's: identified by the page's id,
        // not by an adapter attribute — the options step above switched the store to a hub, so the
        // extension's element carries an endpoint instead.
        addedLayers: document.querySelectorAll('bluepencil-notes:not(#host-layer)').length,
      });
    })()`));
    ok("the forced mount adds the extension's own layer alongside the page's",
      forcedState.layers >= 2 && forcedState.addedLayers >= 1, JSON.stringify(forcedState));

    // Once the layer is up, "this page already embeds it" no longer describes the tab, so the badge
    // must go back to nothing — otherwise it would keep claiming a step-aside that was overridden.
    const badgeCleared = await waitForToolbarBadge(browser, worker, { text: "", timeoutMs: 5000 });
    ok("the host-embed badge is cleared once the layer is up", badgeCleared !== null,
      `badge=${badgeCleared !== null ? "cleared" : "still set"}`);

    // 7c. The page → bridge → worker force path (#70, F1). 7b proved the worker forwards a `force`
    //     handed *directly* to `mountOnTab`; this proves the page's documented
    //     `bluepencil:mount { force: true }` survives the bridge hop too — the hop that silently
    //     dropped the flag before. It needs a fresh tab: a successful mount is final, so the
    //     already-mounted embed tab could not mount a second time. `/embed-forced` is served by the
    //     same `/embed` fixture route (the host matches on the prefix) under a URL this test can
    //     attach to unambiguously.
    await browser.attachTo((t) => t.targetId === worker.targetId);
    const forceTabId = await browser.evaluate(
      `(async () => {
        const tab = await chrome.tabs.create({ url: 'http://127.0.0.1:${HOST_PORT}/embed-forced', active: true });
        return tab.id ?? null;
      })()`,
    );
    ok("the force-path fixture opens in its own tab", forceTabId !== null, `tab id ${forceTabId}`);

    // A plain mount first: it injects the isolated-world bridge into this tab, and — being unforced —
    // steps aside. Without the bridge the page's own `postMessage` could not reach the worker at all.
    const bridgeMount = await mountViaWorker(browser, worker);
    ok("the bridge is in place before the page's own force request",
      bridgeMount?.ok === true, `mount: ${JSON.stringify(bridgeMount)}`);

    await browser.attachToPageWhere((t) => t.url.includes("/embed-forced"));
    await browser.waitFor('document.readyState === "complete"');
    // Fire the page's documented override. It is not awaited: its answer returns over the bridge's
    // `postMessage` channel, and the observable result — the extension's own layer — is what matters.
    await browser.evaluate(`(() => {
      window.postMessage(
        { source: 'bluepencil-page', kind: 'request-mount', force: true, requestId: 'force-mount' },
        window.location.origin,
      );
      return 'posted';
    })()`);
    // The layer can only appear if `force` crossed the bridge: an unforced mount on this page steps
    // aside by default. `#host-layer` is the page's own element, so anything else is the extension's.
    await browser.waitFor(
      "document.querySelectorAll('bluepencil-notes:not(#host-layer)').length >= 1",
      { timeoutMs: 5000 },
    );
    const forceRelay = JSON.parse(await browser.evaluate(`(() => JSON.stringify({
      layers: document.querySelectorAll('bluepencil-notes').length,
      addedLayers: document.querySelectorAll('bluepencil-notes:not(#host-layer)').length,
    }))()`));
    ok("the page's request-mount { force: true } survives page → bridge → worker",
      forceRelay.layers >= 2 && forceRelay.addedLayers >= 1, JSON.stringify(forceRelay));

    // 8. The extended cases: a live hub round-trip, browser-store persistence across a reload,
    //    same-origin navigation, the double-mount guard, the one-tag loader, and adapter selection.
    //    They reuse the same browser, worker and fixture host as the cases above — `writeExtensionSettings`
    //    resets the settings before each one, so the options-page step's dead-port hub cannot leak in.
    await checkExtended(browser, worker);
  } finally {
    await browser.close();
    server.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* -------------------------------------------------------------------------- */
/* extended cases — persistence, navigation and the live hub round-trip (#34)   */
/* -------------------------------------------------------------------------- */

/**
 * Case 1 — the live hub round-trip, the highest-value claim this suite can make.
 *
 * It starts the BUILT reference hub (`dist/server.js`) as a child process, points the extension at it,
 * mounts on a CSP-free fixture and creates a note through the real UI. Then it checks the note three
 * ways: in the layer's own store, in the hub's `GET /notes` (read from Node, so the page cannot fake
 * it), and — after a reload and a toolbar-equivalent re-mount — back in the layer's store, loaded from
 * the hub. Together that is page → layer → http adapter → hub → layer in a real Chromium.
 */
async function caseHubRoundTrip(browser) {
  const dir = await mkdtemp(join(tmpdir(), "bp-ext-hub-"));
  let hub;
  try {
    // Started inside the try so a throw from `startHub` still reaches the `finally` below — an
    // mkdtemp'd directory must never leak when the hub fails to come up.
    hub = await startHub(dir);
    // `identity:"anonymous"` is required: `prompt` (the default) opens a blocking dialog the headless
    // browser cannot answer, and the case would hang instead of failing.
    await writeExtensionSettings(browser, {
      store: "http",
      endpoint: hub.base,
      identity: "anonymous",
      auth: "none",
    });

    const tabId = await openHostTab(browser, "/hub");
    ok("the hub fixture opens in its own tab", tabId !== null, `tab id ${tabId}`);
    await attachToHostPath(browser, "/hub");

    const tag = `hub round-trip ${Date.now()}`;
    const mount = await mountViaWorker(browser);
    ok("the worker mounts the layer against the live hub", mount?.ok === true,
      `mount: ${JSON.stringify(mount)}`);
    await attachToHostPath(browser, "/hub");
    await waitForLayer(browser);

    // The real-UI create. Wrapped so a failed capture is reported as this case's red check rather than
    // aborting the hub assertions behind it.
    let captured = false;
    try {
      await createNoteViaUi(browser, { target: "#target", body: tag });
      captured = true;
    } catch {
      captured = false;
    }
    ok("the note is in the layer's store after the real-UI create", captured,
      `store: ${JSON.stringify(await notesInStore(browser))}`);

    // The panel is the user-facing half: the note has to render, not only exist in the store. Opening
    // the panel with its own button is the same toggle a user clicks.
    await armMode(browser, "panel");
    const panelShows = await poll(
      browser,
      `[...document.querySelectorAll('.bp-panel-body [data-bp-note-id]')]
        .some((n) => n.textContent.includes(${JSON.stringify(tag)}))`,
      8000,
    );
    ok("the panel shows the note it just saved", panelShows);

    const onHub = await waitForHubNote(hub.base, tag);
    ok("the hub itself persists the note, read from Node", onHub !== null,
      `GET ${hub.base}/notes → ${onHub === null ? "note missing" : "found"}`);

    // Reload the same tab and re-mount the way the toolbar would: a fresh document has no layer (the
    // config does not survive navigation — see case 3), so the note can only come back from the hub.
    await attachToHostPath(browser, "/hub");
    await browser.navigate(`http://127.0.0.1:${HOST_PORT}/hub`);
    await attachToHostPath(browser, "/hub");
    const remount = await mountViaWorker(browser);
    ok("the layer re-mounts on the reloaded hub page", remount?.ok === true,
      `mount: ${JSON.stringify(remount)}`);
    await attachToHostPath(browser, "/hub");
    const backFromHub = await poll(
      browser,
      `document.querySelector('bluepencil-notes')?.blueprint?.store.notes()
        .some((n) => String(n.body).includes(${JSON.stringify(tag)})) === true`,
      15000,
    );
    ok("the note is loaded back from the hub into the layer's store", backFromHub);
  } finally {
    // The hub holds the store file open: stop it before the temp dir is removed. `hub` is undefined
    // when `startHub` itself threw, and the temp dir is still removed.
    if (hub !== undefined) await hub.stop();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Case 2 — `chromeStorage` persistence across a reload.
 *
 * The existing bridge check round-trips a raw sentinel; this drives the whole path a user takes. The
 * note is created through the real UI, the document is reloaded (a fresh page with no layer), the
 * layer is re-mounted, and the note must be back in the store *and* re-anchored as a marker.
 */
async function caseChromeStorageReload(browser) {
  await writeExtensionSettings(browser, { store: "chromeStorage", identity: "anonymous" });
  const tabId = await openHostTab(browser, "/persist");
  ok("the persistence fixture opens in its own tab", tabId !== null, `tab id ${tabId}`);
  await attachToHostPath(browser, "/persist");

  const mount = await mountViaWorker(browser);
  ok("the layer mounts with the chromeStorage adapter", mount?.ok === true,
    `mount: ${JSON.stringify(mount)}`);
  await attachToHostPath(browser, "/persist");
  await waitForLayer(browser);
  const adapterName = await browser.evaluate(
    `document.querySelector('bluepencil-notes')?.blueprint?.store?.adapterName ?? null`,
  );
  ok("the chromeStorage adapter reached the layer", adapterName === "chromeStorage",
    `adapterName=${adapterName}`);

  const tag = `chromeStorage persistence ${Date.now()}`;
  await createNoteViaUi(browser, { target: "#target", body: tag });

  // The capture is optimistic: the store count grows before the bridge relay finishes the write, and
  // a reload inside that window would abort it (measured as a flake). Wait until the note is really in
  // `chrome.storage.local` — read from the worker, which owns that API — before reloading; that is
  // also the precondition this case is actually about.
  await attachToWorker(browser);
  const storedBeforeReload = await poll(
    browser,
    `(async () => {
      const all = await chrome.storage.local.get(null);
      return Object.values(all).some((v) => typeof v === 'string' && v.includes(${JSON.stringify(tag)}));
    })()`,
    10000,
  );
  ok("the note reached chrome.storage.local before the reload", storedBeforeReload);

  await attachToHostPath(browser, "/persist");
  await browser.navigate(`http://127.0.0.1:${HOST_PORT}/persist`);
  await attachToHostPath(browser, "/persist");
  const remount = await mountViaWorker(browser);
  ok("the layer re-mounts on the reloaded page", remount?.ok === true,
    `mount: ${JSON.stringify(remount)}`);
  await attachToHostPath(browser, "/persist");
  const persisted = await poll(
    browser,
    `document.querySelector('bluepencil-notes')?.blueprint?.store.notes()
      .some((n) => String(n.body).includes(${JSON.stringify(tag)})) === true`,
    15000,
  );
  ok("the note survives the reload in chrome.storage.local", persisted);
  const marker = await poll(browser, `document.querySelectorAll('.bp-marker').length >= 1`, 10000);
  ok("the note is re-anchored as a marker after the reload", marker);
}

/**
 * Case 3 — same-origin navigation and the single-layer invariant.
 *
 * GROUND TRUTH (measured against this build with a `.tmp/` probe, matching the shipped source):
 * the layer does **not** re-mount by itself after a same-origin navigation. `mainWorldHandoff` in
 * `extension/src/sw.ts` writes the page global `__bluepencilConfig__` onto the *current* document
 * only; the registered MAIN-world `bootstrap.js` is in place at `document_start` on the next document
 * but finds no config there, and there is no `chrome.tabs.onUpdated` / `webNavigation` listener to
 * re-hand it one. So a fresh document has `__bluepencilTryMount` but zero configuration, and the
 * layer only comes up when the worker is asked again — exactly what a toolbar click does. That
 * explicit mount is the "toolbar-equivalent" this case drives.
 *
 * The assertion is that doing so on a new same-origin document never *duplicates* the layer: the
 * registered content script is present at `document_start` and the explicit mount is the toolbar
 * path, so a bug in the `__bluepencilMounted` guard would show up here as a second element.
 */
async function caseNavigationPersistence(browser) {
  await writeExtensionSettings(browser, { store: "memory", identity: "anonymous" });
  const tabId = await openHostTab(browser, "/nav-a");
  ok("the navigation fixture opens in its own tab", tabId !== null, `tab id ${tabId}`);
  await attachToHostPath(browser, "/nav-a");

  const first = await mountViaWorker(browser);
  ok("the layer mounts on the first path", first?.ok === true, `mount: ${JSON.stringify(first)}`);
  await attachToHostPath(browser, "/nav-a");
  await waitForLayer(browser);

  // Same tab, same origin, a second path serving the same annotatable markup.
  await browser.navigate(`http://127.0.0.1:${HOST_PORT}/nav-b`);
  await attachToHostPath(browser, "/nav-b");

  // The fresh document must come up with no layer of its own, and no re-handed config: navigation
  // does not carry `__bluepencilConfig__` over (see the ground truth above), so nothing can mount it.
  // Asserting this *before* the explicit mount is what makes the next check mean "the toolbar path
  // mounted it" — without it the case would also pass if the layer had auto-remounted.
  const freshState = JSON.parse(await browser.evaluate(`JSON.stringify({
    layers: document.querySelectorAll('bluepencil-notes').length,
    config: typeof window.__bluepencilConfig__ !== 'undefined',
  })`));
  ok("the fresh same-origin document starts with no layer of its own",
    freshState.layers === 0 && freshState.config === false,
    `layers=${freshState.layers} config=${freshState.config}`);

  const second = await mountViaWorker(browser);
  ok("the toolbar-equivalent mount comes up on the second path", second?.ok === true,
    `mount: ${JSON.stringify(second)}`);
  await attachToHostPath(browser, "/nav-b");
  const mounted = await poll(
    browser,
    `Boolean(document.querySelector('bluepencil-notes')?.blueprint)`,
    15000,
  );
  ok("the layer is mounted on the new document", mounted);
  const layers = await browser.evaluate(`document.querySelectorAll('bluepencil-notes').length`);
  ok("re-mounting on a new same-origin document never duplicates the layer", layers === 1,
    `found ${layers} <bluepencil-notes>`);
}

/**
 * Case 4 — an unforced double mount is a no-op.
 *
 * The `__bluepencilMounted` guard makes a second injection in the same document a no-op; this proves
 * it on the real path (two `mountOnTab` calls on one tab) rather than by reading the guard.
 */
async function caseDoubleMount(browser) {
  await writeExtensionSettings(browser, { store: "memory", identity: "anonymous" });
  const tabId = await openHostTab(browser, "/double");
  ok("the double-mount fixture opens in its own tab", tabId !== null, `tab id ${tabId}`);
  await attachToHostPath(browser, "/double");

  const first = await mountViaWorker(browser);
  ok("the first unforced mount succeeds", first?.ok === true, `mount: ${JSON.stringify(first)}`);
  await attachToHostPath(browser, "/double");
  await waitForLayer(browser);

  const second = await mountViaWorker(browser);
  ok("the second unforced mount also answers ok", second?.ok === true,
    `mount: ${JSON.stringify(second)}`);
  await attachToHostPath(browser, "/double");
  const layers = await browser.evaluate(`document.querySelectorAll('bluepencil-notes').length`);
  ok("a second unforced mount is a no-op, not a second layer", layers === 1,
    `found ${layers} <bluepencil-notes>`);
}

/**
 * Case 5 — the one-tag loader is detected and the extension steps aside.
 *
 * `/loader` carries the documented loader tag and no restrictive CSP; only `/dist/attach.js` is
 * served (see LOADER_HTML). `detect.ts` reads the loader's *trace* — its script tag, and the
 * `bluepencilAttach` global it installs — so the extension must name "loader", add no element of its
 * own, and say so on the toolbar badge.
 */
async function caseLoaderDetection(browser) {
  await writeExtensionSettings(browser, { store: "memory", identity: "anonymous" });
  const tabId = await openHostTab(browser, "/loader");
  ok("the loader fixture opens in its own tab", tabId !== null, `tab id ${tabId}`);
  await attachToHostPath(browser, "/loader");

  // Arm the page's own listener *before* the mount: the detection report is a `postMessage` from the
  // MAIN world, and a listener that arrives afterwards would miss a deliberately silent step-aside.
  await browser.evaluate(`(() => {
    window.__BP_HOST_REPORTS__ = [];
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (data && data.source === 'bluepencil-extension' && data.kind === 'host-embed-detected') {
        window.__BP_HOST_REPORTS__.push({ host: data.host ?? null });
      }
    });
    return 'armed';
  })()`);

  const mount = await mountViaWorker(browser);
  ok("the worker's mount call completes on the loader page", mount?.ok === true,
    `mount: ${JSON.stringify(mount)}`);
  await attachToHostPath(browser, "/loader");
  const reported = await poll(
    browser,
    `(window.__BP_HOST_REPORTS__ || []).some((r) => r.host === 'loader')`,
    8000,
  );
  ok("the extension detects the source as \"loader\"", reported,
    `reports: ${JSON.stringify(await browser.evaluate("window.__BP_HOST_REPORTS__ ?? []"))}`);

  const ownLayers = await browser.evaluate(`document.querySelectorAll('bluepencil-notes').length`);
  ok("the extension adds no second element and steps aside", ownLayers === 0,
    `found ${ownLayers} <bluepencil-notes>`);

  const badge = await waitForToolbarBadge(browser, null, { text: "host", timeoutMs: 5000 });
  ok("the toolbar badge marks the tab as host-embedded, naming the loader",
    badge !== null && badge.text === "host" && /already embeds it \(loader\)/.test(badge.title ?? ""),
    JSON.stringify(badge));
}

/**
 * Case 6 — a settings-selected adapter reaches the layer.
 *
 * `store:"localStorage"` must become `adapter="localStorage"` on the element (handoff.ts). The layer
 * reports its own adapter name, so this reads the store's answer rather than the attribute the worker
 * wrote — the same distinction the #53 checks make for `chromeStorage`.
 */
async function caseLocalStorageAdapter(browser) {
  await writeExtensionSettings(browser, { store: "localStorage", identity: "anonymous" });
  const tabId = await openHostTab(browser, "/local");
  ok("the localStorage fixture opens in its own tab", tabId !== null, `tab id ${tabId}`);
  await attachToHostPath(browser, "/local");

  const mount = await mountViaWorker(browser);
  ok("the layer mounts with a settings-selected adapter", mount?.ok === true,
    `mount: ${JSON.stringify(mount)}`);
  await attachToHostPath(browser, "/local");
  const chosen = await poll(
    browser,
    `document.querySelector('bluepencil-notes')?.blueprint?.store?.adapterName === 'localStorage'`,
    10000,
  );
  ok("the configured localStorage adapter reached the layer", chosen,
    `adapterName=${await browser.evaluate(
      "document.querySelector('bluepencil-notes')?.blueprint?.store?.adapterName ?? null")}`);
}

/** Runs every extended case; `runCase` keeps one failure from cancelling the rest. */
async function checkExtended(browser) {
  // Each case starts with `writeExtensionSettings`, which writes a complete blob — so the
  // options-page step above (which leaves `store:"http"` on a dead port 8787) can never leak in.
  await runCase("live hub round-trip", () => caseHubRoundTrip(browser));
  await runCase("chromeStorage reload persistence", () => caseChromeStorageReload(browser));
  await runCase("same-origin navigation", () => caseNavigationPersistence(browser));
  await runCase("unforced double mount is a no-op", () => caseDoubleMount(browser));
  await runCase("one-tag loader detection", () => caseLoaderDetection(browser));
  await runCase("localStorage adapter selection", () => caseLocalStorageAdapter(browser));
}

try {
  await checkArtefacts();
  // Runs before (and independently of) the browser checks: it needs no Chrome, so a regression in
  // the retry bookkeeping is caught even on a machine with no usable browser.
  await checkProbeBookkeeping();
  // Same reason: the detection that decides mount-or-step-aside is a pure function, so it is pinned
  // without a browser too (#70).
  await checkDetect();
  requireBrowser({ browser: findChrome() });
  await checkInBrowser();
} catch (error) {
  if (error?.constructor?.name === "Skipped") {
    // The documented contract (scripts/lib/browser.mjs): a missing browser is a SKIP locally, but a
    // hard FAILURE in CI, where `BP_REQUIRE_BROWSER=1`. Dropping the whole real-browser round while
    // exiting 0 is exactly what that env var exists to prevent, so it is honoured here (only "1",
    // so a stray non-empty value can never silently turn a skip into a failure).
    // `Skipped` carries its text on `reason`, not `message` (scripts/lib/browser.mjs); the other
    // suites already read `.reason`, so this stops the message from printing as "undefined".
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

console.log(`\next-smoke: ${passed + failed} case(s), ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
