#!/usr/bin/env node
/**
 * Voice smoke test (FR-21) — dictation in the composer, driven in a real browser.
 *
 * It serves only `/examples/voice/` and `/dist/` with a tiny dependency-free `node:http` server
 * (everything else in the repository, notably `.tmp/`, answers 404), opens `examples/voice/` in
 * Chrome over the CDP pipe from `scripts/lib/browser.mjs`, and asserts what a reviewer can see: the
 * mic button, its pressed state, the interim live region, the appended final transcript, the Esc
 * teardown and the host opt-out.
 *
 * The recogniser is **host-injected** (`voiceEngine` in `LayerOptions`, FR-21.6) and implemented by
 * the fixture page itself. Nothing here touches a microphone or a real SpeechRecognition; the fake
 * engine is a real implementation of the `VoiceEngine` contract, not a mock of the product.
 *
 *   node scripts/voice-smoke.mjs
 *   BP_REQUIRE_BROWSER=1 node scripts/voice-smoke.mjs   # a missing Chrome is a failure (CI)
 *
 * Builds nothing itself: run `npm run build` first. Without a Chrome (or with `BP_NO_BROWSER=1`,
 * which `components-e2e --no-browser` sets) the cases print `SKIP` and the run exits 0;
 * `BP_REQUIRE_BROWSER=1` turns that into exit 1, like the other suites.
 *
 * Each case prints `PASS`/`FAIL`; the exit code is non-zero when any case failed.
 */
import { createReadStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser, Skipped, findChrome, requireBrowser } from "./lib/browser.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const IIFE = join(root, "dist/bluepencil.iife.js");
// Per-run directory: a second concurrent smoke must not delete this run's profile or fixtures.
const WORKSPACE = join(root, ".tmp/voice-smoke", String(process.pid));
const PROFILE = join(WORKSPACE, "chrome-profile");

if (!existsSync(IIFE)) {
  console.error(`[voice-smoke] missing build artifact — run "npm run build" first (${IIFE})`);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const pause = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

/** Extension → content type. The fixture only needs HTML and the build's JS. */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Only these trees are served: the fixture page and the build artifact it loads. Nothing else in
 * the repository (notably `.tmp/`, which holds the Chrome profile and the fixture stores) may be
 * reachable over the loopback port, even though the server binds to 127.0.0.1.
 */
const SERVED_PREFIXES = ["/examples/voice/", "/dist/"];

/**
 * A static server bound to a free loopback port, serving only `SERVED_PREFIXES` read-only. Paths
 * are resolved before use so `..` cannot escape the repository (the same guard as
 * `serve-example.mjs`); dot-directories and every other repo path answer 404.
 */
function startStaticServer(rootDir) {
  const server = createServer((req, res) => {
    const fail = (status, message) => {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      res.end(`${message}\n`);
    };

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    } catch {
      fail(400, "bad request path");
      return;
    }

    // Reject traversal and dot-directories explicitly before resolving: a `..` segment or any
    // `.`-prefixed segment is never part of the two whitelisted trees.
    const segments = pathname.split("/").filter((segment) => segment !== "");
    if (segments.some((segment) => segment === ".." || segment.startsWith("."))) {
      fail(404, "not found");
      return;
    }
    if (!SERVED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
      fail(404, "not found");
      return;
    }

    if (pathname.endsWith("/")) pathname += "index.html";

    const file = resolve(join(rootDir, normalize(pathname)));
    if (file !== rootDir && !file.startsWith(rootDir + sep)) {
      fail(403, "outside the repository");
      return;
    }

    stat(file)
      .then((info) => {
        if (!info.isFile()) {
          fail(404, "not found");
          return;
        }
        res.writeHead(200, {
          "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
          "content-length": info.size,
          "cache-control": "no-store",
        });
        createReadStream(file).pipe(res);
      })
      .catch(() => fail(404, "not found"));
  });

  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen(server));
  });
}

function closeServer(server) {
  return new Promise((resolveClose) => {
    server.closeAllConnections?.();
    server.close(() => resolveClose());
  });
}

/* -------------------------------------------------------------------------- */
/* signal handling                                                             */
/* -------------------------------------------------------------------------- */

/** The resources the abort path has to close; `finally` only runs on the normal path. */
let activeServer = null;
let activeBrowser = null;
let signalExitCode = null;

/** Idempotent abort path: close the browser and the static server, then exit 130/143. */
function installSignalHandlers() {
  for (const [signal, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    process.on(signal, () => {
      if (signalExitCode !== null) return;
      signalExitCode = exitCode;
      console.log(`\n[voice-smoke] ${signal} received — closing the browser and the fixture server`);
      void (async () => {
        if (activeBrowser !== null) await activeBrowser.close();
        if (activeServer !== null) await closeServer(activeServer);
        process.exit(exitCode);
      })();
    });
  }
}

/** Opens the composer the way a reviewer does: arm the text mode, then click the paragraph. */
async function openComposer(context) {
  await context.browser.click('[data-bp-action="mode-text"]');
  await context.browser.waitFor(
    `document.querySelector('[data-bp-action="mode-text"]')?.getAttribute("aria-pressed") === "true"`,
    { timeoutMs: 5000 },
  );
  await context.browser.click("#vf-heading");
  await context.browser.waitFor(
    `(() => { const node = document.querySelector(".bp-composer");
              if (!node) return false;
              const rect = node.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0; })()`,
    { timeoutMs: 8000 },
  );
}

/** Loads the fixture (fresh document) and waits until the layer and the host handle are there. */
async function loadFixture(context, voice) {
  await context.browser.navigate(`${context.base}/examples/voice/?voice=${voice ? 1 : 0}`);
  await context.browser.waitFor(`Boolean(window.__bp)`, { timeoutMs: 20000 });
  await context.browser.waitFor(`Boolean(document.querySelector('[data-bp-part="root"]'))`, { timeoutMs: 20000 });
}

const factoryCalls = (context) => context.browser.evaluate(`window.__voiceFactoryCalls`);
const micCount = (context) => context.browser.evaluate(`document.querySelectorAll(".bp-voice").length`);

/**
 * The microphone state before the composer is opened.
 *
 * The closed composer is built (hidden) when the layer mounts, so the `.bp-voice` node already
 * exists in the document; what must not exist is a *presented* mic. This returns both facts so the
 * case can assert the observable guarantee — no visible mic and a hidden composer — instead of a
 * vacuous absence check.
 */
const micBeforeOpen = (context) =>
  context.browser.evaluate(`(() => {
    const mic = document.querySelector(".bp-voice");
    const composer = document.querySelector(".bp-composer");
    const rect = mic === null ? null : mic.getBoundingClientRect();
    return {
      micNodes: document.querySelectorAll(".bp-voice").length,
      micVisible: rect !== null && rect.width > 0 && rect.height > 0,
      composerHidden: composer === null ? null : composer.hidden === true,
    };
  })()`);

/** The state of the newest injected engine plus the mic's ARIA/class state. */
const voiceState = (context) =>
  context.browser.evaluate(`(() => {
    const engines = window.__voiceEngines || [];
    const engine = engines[engines.length - 1];
    const mic = document.querySelector(".bp-voice");
    return {
      engines: engines.length,
      starts: engine ? engine.starts : 0,
      stops: engine ? engine.stops : 0,
      aborts: engine ? engine.aborts : 0,
      pressed: mic ? mic.getAttribute("aria-pressed") : null,
      listening: mic ? mic.classList.contains("is-listening") : false,
      composerOpen: document.querySelector(".bp-composer")?.hidden === false,
    };
  })()`);

/* -------------------------------------------------------------------------- */
/* the cases                                                                   */
/* -------------------------------------------------------------------------- */

function cases() {
  return {
    "opt-in: ?voice=1 opens the composer with a mic button and no recogniser yet (FR-21.1)": async (context) => {
      requireBrowser(context);
      await loadFixture(context, true);
      // The mic is composer chrome: with `?voice=1` it must not be offered before the composer
      // opens. The node itself is pre-built inside the closed dialog, so the assertion is on the
      // presented state (hidden composer, zero-size mic) rather than on a node count that the
      // implementation never promises to be zero.
      const beforeOpen = await micBeforeOpen(context);
      assert(
        beforeOpen.composerHidden === true,
        "the composer is not closed before the reviewer opened it",
      );
      assert(
        beforeOpen.micVisible === false,
        `a microphone button is visible before the composer opened (${beforeOpen.micNodes} node(s))`,
      );
      assert((await factoryCalls(context)) === 0, "the injected factory ran before dictation was requested");
      await openComposer(context);
      assert((await micCount(context)) === 1, "the composer has no microphone button although voice was opted in");
      assert((await factoryCalls(context)) === 0, "opening the composer must not build a recogniser (FR-21.6 laziness)");
    },

    "start: a real mic click starts the injected engine once and marks the button pressed (FR-21.3, FR-21.8)": async (context) => {
      requireBrowser(context);
      await loadFixture(context, true);
      await openComposer(context);
      await context.browser.click(".bp-voice");
      await context.browser.waitFor(
        `document.querySelector(".bp-voice")?.getAttribute("aria-pressed") === "true"`,
        { timeoutMs: 5000 },
      );
      const state = await voiceState(context);
      assert(state.engines === 1, `expected one engine, the factory created ${state.engines}`);
      assert(state.starts === 1, `engine.start() ran ${state.starts} time(s), expected 1`);
      assert(state.pressed === "true", `the mic reports aria-pressed="${state.pressed}"`);
      assert(state.listening === true, "the mic is missing the is-listening class while listening");
    },

    "interim: a live region shows the preview, the textarea stays empty (FR-21.3, FR-21.8)": async (context) => {
      requireBrowser(context);
      await loadFixture(context, true);
      await openComposer(context);
      await context.browser.click(".bp-voice");
      await context.browser.waitFor(
        `document.querySelector(".bp-voice")?.getAttribute("aria-pressed") === "true"`,
        { timeoutMs: 5000 },
      );
      const emitted = await context.browser.evaluate(`window.__emit("dictated text", false)`);
      assert(emitted === true, "the fixture could not dispatch the interim result — no engine installed onResult");
      await context.browser.waitFor(
        `(() => { const node = document.querySelector('[data-bp-part="composer-voice-status"]');
                  if (!node || node.hidden) return false;
                  const rect = node.getBoundingClientRect();
                  return rect.width > 0 && rect.height > 0 && node.textContent.includes("dictated text"); })()`,
        { timeoutMs: 5000 },
      );
      const status = await context.browser.evaluate(
        `document.querySelector('[data-bp-part="composer-voice-status"]').textContent`,
      );
      assert(status.includes("dictated text"), `the live region says "${status}" instead of the interim transcript`);
      const value = await context.browser.evaluate(`document.querySelector('[data-bp-part="composer-body"]').value`);
      assert(value === "", `an interim result leaked into the textarea: "${value}"`);
    },

    "final: the transcript is appended, the composer stays open and nothing is saved (FR-21.3)": async (context) => {
      requireBrowser(context);
      await loadFixture(context, true);
      await openComposer(context);
      await context.browser.click(".bp-voice");
      await context.browser.waitFor(
        `document.querySelector(".bp-voice")?.getAttribute("aria-pressed") === "true"`,
        { timeoutMs: 5000 },
      );
      const emitted = await context.browser.evaluate(`window.__emit("final dictated text", true)`);
      assert(emitted === true, "the fixture could not dispatch the final result — no engine installed onResult");
      await context.browser.waitFor(
        `document.querySelector('[data-bp-part="composer-body"]').value.includes("final dictated text")`,
        { timeoutMs: 5000 },
      );
      const state = await voiceState(context);
      assert(state.composerOpen, "the composer closed itself after the final transcript");
      const notes = await context.browser.evaluate(`window.__bp.notes().length`);
      assert(notes === 0, `dictation auto-saved ${notes} note(s) — the human still owns the save (FR-21.3)`);
    },

    "teardown: Escape closes the composer and stops the engine (FR-21.4)": async (context) => {
      requireBrowser(context);
      await loadFixture(context, true);
      await openComposer(context);
      await context.browser.click(".bp-voice");
      await context.browser.waitFor(
        `document.querySelector(".bp-voice")?.getAttribute("aria-pressed") === "true"`,
        { timeoutMs: 5000 },
      );
      await context.browser.key("Escape");
      await context.browser.waitFor(
        `document.querySelector(".bp-composer")?.hidden === true`,
        { timeoutMs: 5000 },
      );
      const state = await voiceState(context);
      assert(state.starts === 1, `engine.start() ran ${state.starts} time(s), expected 1`);
      // `stop()` releases the engine before `destroy()` runs, so a normal Esc teardown ends on
      // `stop()`; `abort()` is the error/destroy path. Exactly one of the two must fire — twice
      // would mean two teardown paths ran for one engine.
      assert(
        state.stops + state.aborts === 1,
        `Escape must end the engine exactly once (stops=${state.stops}, aborts=${state.aborts})`,
      );
      assert(state.pressed === "false", `the mic still reports aria-pressed="${state.pressed}" after Escape`);
      assert(state.listening === false, "the is-listening class survived the teardown");
    },

    "lifecycle: disable()/destroy() stop an active dictation and are idempotent (FR-12.2, FR-21.4)": async (context) => {
      requireBrowser(context);
      await loadFixture(context, true);
      await openComposer(context);
      // FR-21.4 is only proven if a recogniser is *running* when teardown happens: start dictation
      // first, then disable()/destroy() and assert the engine was stopped exactly once.
      await context.browser.click(".bp-voice");
      await context.browser.waitFor(
        `document.querySelector(".bp-voice")?.getAttribute("aria-pressed") === "true"`,
        { timeoutMs: 5000 },
      );
      const result = await context.browser.evaluate(`(async () => {
        const bp = window.__bp;
        const engines = window.__voiceEngines || [];
        const engine = engines[engines.length - 1];
        const mic = document.querySelector(".bp-voice");
        // Keep a handle to the (soon detached) mic button: teardown must reset its ARIA state as
        // well as remove it, and a removed node cannot be found by a selector afterwards.
        window.__lifecycleMic = mic;
        const counters = (target) => ({
          engines: engines.length,
          starts: target ? target.starts : 0,
          stops: target ? target.stops : 0,
          aborts: target ? target.aborts : 0,
        });
        const active = {
          ...counters(engine),
          pressed: mic ? mic.getAttribute("aria-pressed") : null,
          listening: mic ? mic.classList.contains("is-listening") : false,
        };
        bp.disable();
        bp.disable();
        const detached = window.__lifecycleMic;
        const afterDisable = {
          engine: counters(engine),
          micInDocument: document.querySelector(".bp-voice") !== null,
          pressed: detached ? detached.getAttribute("aria-pressed") : null,
          listening: detached ? detached.classList.contains("is-listening") : null,
        };
        const residue = {
          root: document.querySelectorAll('[data-bp-part="root"], .bp-root').length,
          legacy: document.querySelectorAll(".bp-layer").length,
          bar: document.querySelectorAll(".bp-bar").length,
          panel: document.querySelectorAll(".bp-panel").length,
        };
        // Awaiting both calls is the assertion that the repeated destroy() resolves: a rejection
        // fails this evaluate and therefore the case.
        await bp.destroy();
        await bp.destroy();
        const afterDestroyEngine = counters(engine);
        const afterDestroy = {
          root: document.querySelectorAll('[data-bp-part="root"], .bp-root').length,
          legacy: document.querySelectorAll(".bp-layer").length,
          bar: document.querySelectorAll(".bp-bar").length,
          panel: document.querySelectorAll(".bp-panel").length,
        };
        // The facade stays usable after teardown: notes() must answer with an empty store, not throw.
        const notes = bp.notes();
        return {
          active,
          afterDisable,
          afterDestroyEngine,
          residue,
          afterDestroy,
          notes: Array.isArray(notes) ? notes.length : "not-an-array",
        };
      })()`);
      assert(
        result.active.starts === 1 && result.active.pressed === "true" && result.active.listening === true,
        `dictation was not running before disable(): ${JSON.stringify(result.active)}`,
      );
      assert(
        result.afterDisable.engine.stops + result.afterDisable.engine.aborts === 1,
        `disable() must end the active recogniser exactly once (stops=${result.afterDisable.engine.stops}, aborts=${result.afterDisable.engine.aborts})`,
      );
      assert(
        result.afterDisable.micInDocument === false,
        "disable() left the microphone button in the document",
      );
      assert(
        result.afterDisable.pressed === "false" && result.afterDisable.listening === false,
        `disable() left the mic state at aria-pressed="${result.afterDisable.pressed}", is-listening=${result.afterDisable.listening}`,
      );
      assert(
        result.afterDestroyEngine.stops + result.afterDestroyEngine.aborts === 1,
        `destroy() after disable() ended the recogniser a second time (stops=${result.afterDestroyEngine.stops}, aborts=${result.afterDestroyEngine.aborts})`,
      );
      assert(
        result.residue.root === 0 && result.residue.legacy === 0 && result.residue.bar === 0 && result.residue.panel === 0,
        `a disabled layer left nodes behind: ${JSON.stringify(result.residue)}`,
      );
      assert(
        result.afterDestroy.root === 0 &&
          result.afterDestroy.legacy === 0 &&
          result.afterDestroy.bar === 0 &&
          result.afterDestroy.panel === 0,
        `destroy() left nodes behind: ${JSON.stringify(result.afterDestroy)}`,
      );
      assert(
        result.notes === 0,
        `notes() after destroy() returned ${JSON.stringify(result.notes)}, expected an empty array`,
      );
    },

    "opt-out: ?voice=0 has no mic, no recogniser and a working composer (FR-21.1)": async (context) => {
      requireBrowser(context);
      await loadFixture(context, false);
      assert((await micCount(context)) === 0, "a microphone button exists although the host did not opt in");
      await openComposer(context);
      assert((await micCount(context)) === 0, "the mic appeared after the composer opened although voice is off");
      assert(
        (await factoryCalls(context)) === 0,
        `the recogniser factory ran ${await factoryCalls(context)} time(s) without an opt-in`,
      );
      // The composer itself is unaffected: focus the body and type like a user.
      await context.browser.evaluate(
        `(() => { const field = document.querySelector('[data-bp-part="composer-body"]'); field.focus(); return true; })()`,
      );
      await context.browser.typeText("typed by hand");
      const value = await context.browser.evaluate(`document.querySelector('[data-bp-part="composer-body"]').value`);
      assert(value === "typed by hand", `the composer textarea did not accept typed text: "${value}"`);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* the runner                                                                  */
/* -------------------------------------------------------------------------- */

async function main() {
  installSignalHandlers();
  rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });

  const server = await startStaticServer(root);
  activeServer = server;
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const context = { base, browser: null };
  const selected = Object.entries(cases());
  const failures = [];
  let skipped = 0;
  let browser = null;

  try {
    // `BP_NO_BROWSER=1` (set by `components-e2e --no-browser`) suppresses the browser launch
    // instead of being ignored; the cases then report SKIP, and BP_REQUIRE_BROWSER=1 below turns
    // that into a hard failure.
    if (process.env.BP_NO_BROWSER === "1") {
      console.log("[voice-smoke] BP_NO_BROWSER=1 — the real-browser cases are skipped");
    } else {
      const chrome = findChrome();
      if (chrome !== null) {
        browser = await Browser.launch(chrome, PROFILE, { width: 1280, height: 900 });
        activeBrowser = browser;
        context.browser = browser;
      } else {
        console.log("[voice-smoke] no Chrome found — browser cases will be reported as SKIP");
      }
    }

    for (const [name, run] of selected) {
      try {
        await run(context);
        console.log(`PASS ${name}`);
      } catch (error) {
        if (error instanceof Skipped) {
          skipped += 1;
          console.log(`SKIP ${name}\n  ${error.reason}`);
        } else {
          failures.push(name);
          console.log(`FAIL ${name}\n  ${error.message}`);
        }
      }
      await pause(100);
    }
  } finally {
    if (browser) await browser.close();
    activeBrowser = null;
    await closeServer(server);
    activeServer = null;
  }

  const passed = selected.length - failures.length - skipped;
  console.log(`\nvoice-smoke: ${passed}/${selected.length} case(s) passed${skipped > 0 ? `, ${skipped} skipped` : ""} in ${WORKSPACE}`);
  if (process.env.BP_REQUIRE_BROWSER === "1" && context.browser === null) {
    console.error(
      "[voice-smoke] BP_REQUIRE_BROWSER=1 — a missing browser is a failure, not a skip",
    );
    process.exit(1);
  }
  if (failures.length > 0) process.exit(1);
}

await main();
