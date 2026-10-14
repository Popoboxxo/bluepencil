#!/usr/bin/env node
/**
 * Bookmarklet smoke test — the IIFE arrival path in a real Chrome (NFR-6, NFR-11, NFR-1/NFR-15).
 *
 * A bookmarklet is a loader that is run against a page that is ALREADY loaded: it builds a
 * `<script>` element, hands it the IIFE build, appends it to the document, and calls the
 * documented `bluepencil.init({…})`. That "inject after the document is complete" step is the
 * bookmarklet's DEFINING property, so every case here navigates first, waits for
 * `document.readyState === "complete"`, and only then injects — no case uses a `<script src>` in
 * the fixture's own markup, which is the one-tag loader's (dist/attach.js) arrival path, covered
 * elsewhere (embed-smoke, parity).
 *
 * It builds nothing itself (like `size-guard.mjs`): run `npm run build` first. Everything happens
 * in `.tmp/bookmarklet-smoke/`, served by the dependency-free `scripts/serve-example.mjs`.
 *
 *   Case 1  happy path (no CSP): post-load injection → documented init → explicit enable →
 *           real-UI note capture → panel + marker + markdown export → disable with no residue →
 *           enable brings the layer and its markers back. This is the NFR-1/NFR-15 promise, on
 *           the arrival path a reviewer actually uses.
 *   Case 2  strict-CSP contrast (never a silent pass): the same post-load injection into a page
 *           with `script-src 'self'` must NOT mount — `window.bluepencil` stays undefined, no
 *           `.bp-root`, and the browser reports the inline-script violation itself. Pins the
 *           documented limitation (NFR-6, docs/ARCHITECTURE.md §6, docs/INTEGRATION.md §4).
 *
 * CSP-shape decision (binding for this file):
 *   - The happy fixture carries NO CSP and the injection is the SOURCE-CARRYING `<script>`
 *     (`script.textContent = <IIFE source>`), NOT the external-`src` variant shown in the
 *     docs/ARCHITECTURE §6 snippet.
 *   - Reason (a): the property under test is the post-load injection itself, and the
 *     source-carrying form is that step with nothing else in the way.
 *   - Reason (b): the source-carrying form is deterministic and single-origin, and under
 *     `script-src 'self'` it is a real, reliably-blocked INLINE script. A same-origin external
 *     `<script src>` would be ALLOWED by `script-src 'self'` (it is a self-origin fetch) and so
 *     could not honestly pin the limitation. Choosing the external form would let the CSP case
 *     pass-by-mounting and quietly prove nothing.
 *   - Reason (c): the README/ARCHITECTURE §6 external-`src` snippet is the DEPLOYMENT variant —
 *     the loader hosted on the reviewer's own host. Both variants are blocked by a strict
 *     `script-src` that allows neither the loader host nor `'unsafe-inline'`: the external form by
 *     `script-src` (fetching a disallowed origin), the inline form by `script-src` (no
 *     `'unsafe-inline'`/nonce/hash). Which directive blocks which mechanism is stated in the CSP
 *     case's PASS line.
 *
 * The browser plumbing comes from `scripts/lib/browser.mjs` (dependency-free CDP over the pipe,
 * NFR-4). Without a Chrome the cases print `SKIP`; CI sets `BP_REQUIRE_BROWSER=1`, which turns
 * "no browser" into a failure instead of a skip. Each case prints `PASS`/`FAIL`; the exit code is
 * non-zero when any case failed.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser, Skipped, findChrome, requireBrowser } from "./lib/browser.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const IIFE = join(root, "dist/bluepencil.iife.js");
const SERVER = join(root, "scripts/serve-example.mjs");
const WORKSPACE = join(root, ".tmp/bookmarklet-smoke");
const SITE = join(WORKSPACE, "site");
const PROFILE = join(WORKSPACE, "chrome-profile");

if (!existsSync(IIFE)) {
  console.error(`[bookmarklet-smoke] missing build artifact — run "npm run build" first (${IIFE})`);
  process.exit(1);
}

const IIFE_SOURCE = readFileSync(IIFE, "utf8");

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** A hand-built, unminified HTML string written to disk — the fixture has no build step (NFR-4). */
const HAPPY_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>bookmarklet smoke — happy path</title>
  <style>
    /* The layer's bar is fixed at the top, so the annotatable element is pushed well below it by a
       generous top padding: otherwise a real pointer click at the element's centre could land on
       the layer's own chrome and the capture case would fail for the wrong reason. */
    body { margin: 0; padding-top: 8rem; font: 16px/1.5 system-ui, sans-serif; }
    main { padding: 0 1.25rem; }
    #smoke-target { margin: 0 0 1.5rem; font-size: 1.5rem; }
    .filler { height: 60vh; }
  </style>
</head>
<body>
  <main>
    <h1 id="smoke-target" data-bluepencil="smoke-target">Annotate me</h1>
    <p data-bluepencil="smoke-para">A second annotatable element on the page.</p>
    <div class="filler"></div>
  </main>
</body>
</html>
`;

/**
 * The strict-CSP fixture: `script-src 'self'` with no `'unsafe-inline'` and no nonce/hash. The
 * injected `<script>` is inline (its source is carried in `textContent`), so the page's own policy
 * must block it — which is exactly the documented limitation. The `<style>` stays inline and is
 * unaffected: only `script-src` is constrained, so the fixture does not accidentally test style-src.
 */
const CSP_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="script-src 'self'">
  <title>bookmarklet smoke — strict CSP</title>
  <style>body { margin: 0; padding-top: 8rem; font: 16px/1.5 system-ui, sans-serif; }</style>
</head>
<body>
  <main>
    <h1 id="smoke-target" data-bluepencil="smoke-target">Blocked on this page</h1>
  </main>
</body>
</html>
`;

/**
 * Inject the built IIFE the way a bookmarklet does: a `<script>` element whose source is carried in
 * `textContent`, appended to the document after it is already loaded. The id is left on the node so
 * the CSP case can prove the injection *was attempted* before concluding it was blocked.
 */
const INJECT_IIFE = `(() => {
  const script = document.createElement("script");
  script.id = "bp-smoke-injected";
  script.textContent = ${JSON.stringify(IIFE_SOURCE)};
  document.head.appendChild(script);
  return document.getElementById("bp-smoke-injected") !== null;
})()`;

/** The documented init path (src/index.ts): an `enabled` gate means init() must NOT auto-mount. */
const INIT_BLUEPRINT = `(() => {
  window.__bpSmoke = window.bluepencil.init({
    enabled: () => true,
    adapter: "localStorage",
    getRoute: () => location.pathname,
  });
  return { hasInit: typeof window.bluepencil.init === "function",
           rootsBeforeEnable: document.querySelectorAll(".bp-root").length };
})()`;

const NOTE_BODY = "bookmarklet smoke: the heading needs a different wording.";
const NOTE_MARK = "bookmarklet smoke";

/** Navigate to a fixture and wait for a FULLY LOADED document carrying its hook (post-load gate). */
async function loadFixture(browser, url) {
  await browser.navigate(url);
  // Both conditions: readyState rules out the half-parsed document, the hook rules out the
  // previous page (which is already `complete` when navigate() resolves).
  await browser.waitFor(
    `document.readyState === "complete" && document.querySelector('[data-bluepencil="smoke-target"]') !== null`,
    { timeoutMs: 15000 },
  );
}

/** Arms a mode through the bar's own button and waits until the layer reports it pressed (FR-4.4). */
async function armMode(browser, action) {
  await browser.click(`[data-bp-action="${action}"]`);
  await browser.waitFor(
    `document.querySelector('[data-bp-action="${action}"]')?.getAttribute("aria-pressed") === "true"`,
    { timeoutMs: 5000 },
  );
}

/**
 * Saves the composer that opens after picking an anchor. The element exists from the start and only
 * becomes visible once an element is picked, so a case waits for a real box before "saving".
 */
async function saveComposer(browser, body) {
  await browser.waitFor(
    `(() => { const node = document.querySelector(".bp-composer");
              if (!node) return false;
              const rect = node.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0; })()`,
    { timeoutMs: 6000 },
  );
  await browser.evaluate(
    `(() => { const field = document.querySelector(".bp-composer .bp-textarea"); field.focus(); field.select?.(); return true; })()`,
  );
  await browser.typeText(body);
  await browser.click('[data-bp-action="composer-save"]');
  await pause(400);
}

/** The panel's entries as a reviewer reads them, flattened to one string (FR-4). */
async function panelText(browser) {
  return browser.evaluate(
    `(() => { const body = document.querySelector(".bp-panel-body");
              return body === null ? null : (body.textContent || "").replace(/\\s+/g, " "); })()`,
  );
}

/* -------------------------------------------------------------------------- */
/* cases                                                                       */
/* -------------------------------------------------------------------------- */

function cases() {
  return {
    /**
     * The happy path: post-load IIFE injection → documented init → real-UI note → panel + marker +
     * export → disable with no residue → enable brings the layer back.
     */
    "happy: post-load IIFE inject, real-UI capture, disable/enable round (NFR-1, NFR-15)": async (ctx) => {
      requireBrowser(ctx);
      const browser = ctx.browser;
      await loadFixture(browser, `${ctx.origin}/happy.html`);

      // The document is complete before anything is injected — the bookmarklet's defining property.
      const ready = await browser.evaluate(`document.readyState`);
      assert(ready === "complete", `the document was not loaded before injection: ${ready}`);

      assert(await browser.evaluate(INJECT_IIFE), "the IIFE <script> was not appended to <head>");
      await browser.waitFor(`typeof window.bluepencil !== "undefined"`, { timeoutMs: 8000 });

      const initial = await browser.evaluate(INIT_BLUEPRINT);
      assert(initial.hasInit === true, "bluepencil.init is not a function after the IIFE arrived");
      // The `enabled` gate suppresses auto-mount (src/index.ts): nothing may be on the page yet.
      assert(
        initial.rootsBeforeEnable === 0,
        `init() with an enabled gate must not auto-mount, but ${initial.rootsBeforeEnable} .bp-root node(s) exist`,
      );

      const enabled = await browser.evaluate(`window.__bpSmoke.enable()`);
      assert(enabled === true, `bp.enable() must return truthy, got ${JSON.stringify(enabled)}`);
      await browser.waitFor(`Boolean(document.querySelector(".bp-root"))`, { timeoutMs: 8000 });
      assert(
        await browser.evaluate(`Boolean(document.querySelector(".bp-bar"))`),
        "the layer mounted but the bar is missing",
      );

      // Capture a note through the REAL UI: arm text mode, click the element, type, save.
      await armMode(browser, "mode-text");
      await browser.click('[data-bluepencil="smoke-target"]');
      await saveComposer(browser, NOTE_BODY);

      assert(
        (await browser.evaluate(`document.querySelectorAll(".bp-marker").length`)) >= 1,
        "the captured note has no marker on its element",
      );

      await browser.click('[data-bp-action="panel"]');
      await browser.waitFor(`Boolean(document.querySelector(".bp-panel-body"))`, { timeoutMs: 8000 });
      const panel = await panelText(browser);
      assert(panel !== null, "the panel has no body");
      assert(panel.includes(NOTE_MARK), `the panel does not list the captured note: "${panel.slice(0, 160)}"`);

      const markdown = await browser.evaluate(`window.__bpSmoke.export({ format: "markdown" })`);
      assert(typeof markdown === "string" && markdown.length > 0, "export() returned no markdown");
      assert(markdown.includes(NOTE_MARK), `the markdown export does not carry the note body: "${markdown.slice(0, 160)}"`);

      // disable(): the layer and its chrome are gone, and nothing bp-prefixed is left behind.
      await browser.evaluate(`window.__bpSmoke.disable()`);
      await browser.waitFor(
        `document.querySelectorAll('[class^="bp-"], [class*=" bp-"]').length === 0`,
        { timeoutMs: 5000 },
      );
      const residue = await browser.evaluate(
        `({ any: document.querySelectorAll('[class^="bp-"], [class*=" bp-"]').length,
            root: document.querySelectorAll(".bp-root").length,
            bar: document.querySelectorAll(".bp-bar").length,
            marker: document.querySelectorAll(".bp-marker").length })`,
      );
      assert(
        residue.any === 0 && residue.root === 0 && residue.bar === 0 && residue.marker === 0,
        `disable() left residue behind: ${JSON.stringify(residue)}`,
      );

      // enable(): the layer — and, from the persisted store, its markers — come back.
      const reenabled = await browser.evaluate(`window.__bpSmoke.enable()`);
      assert(reenabled === true, `a second enable() must return truthy, got ${JSON.stringify(reenabled)}`);
      await browser.waitFor(`Boolean(document.querySelector(".bp-root"))`, { timeoutMs: 8000 });
      await browser.waitFor(`document.querySelectorAll(".bp-marker").length >= 1`, { timeoutMs: 8000 });
      return `note captured via the UI, markdown ${markdown.length} chars, disable/enable clean`;
    },

    /**
     * The documented limitation (NFR-6): a strict `script-src` blocks the loader. The same post-load
     * inline injection is used, so the ONLY difference from the happy case is the page's policy —
     * and the browser itself reports the violation, so this can never be a silent pass.
     */
    "csp: strict script-src blocks the post-load IIFE injection (NFR-6)": async (ctx) => {
      requireBrowser(ctx);
      const browser = ctx.browser;
      await loadFixture(browser, `${ctx.origin}/csp.html`);

      // Record the page's own CSP report, so "no mount" is attributed to the policy, not to a
      // broken injection. Armed before the injection.
      await browser.evaluate(`(() => {
        window.__bpViolations = [];
        document.addEventListener("securitypolicyviolation", (event) => {
          window.__bpViolations.push({ directive: event.violatedDirective, blocked: event.blockedURI });
        });
        return true;
      })()`);

      assert(await browser.evaluate(INJECT_IIFE), "the IIFE <script> was not appended to <head>");
      await pause(400); // let the blocked element's violation event fire

      const state = await browser.evaluate(`(() => ({
        meta: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? "",
        api: typeof window.bluepencil,
        root: document.querySelectorAll(".bp-root").length,
        injected: document.querySelectorAll("script#bp-smoke-injected").length,
        violations: window.__bpViolations ?? [],
      }))()`);

      assert(state.meta.includes("script-src 'self'"), `the fixture has no strict CSP: "${state.meta}"`);
      assert(state.injected === 1, "the injection was not attempted — the case would pass vacuously");
      assert(state.api === "undefined", `window.bluepencil exists despite the CSP: ${state.api}`);
      assert(state.root === 0, `a .bp-root mounted despite the CSP: ${state.root}`);
      const inlineBlock = state.violations.some((entry) => /^script-src/.test(entry.directive));
      assert(
        inlineBlock,
        `no script-src violation was reported — the block is not pinned: ${JSON.stringify(state.violations)}`,
      );
      const directive = state.violations.find((entry) => /^script-src/.test(entry.directive)).directive;
      return `${directive} refused the inline IIFE injection, no layer mounted`;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* run                                                                         */
/* -------------------------------------------------------------------------- */

function setUpWorkspace() {
  rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(SITE, { recursive: true });
  writeFileSync(join(SITE, "happy.html"), HAPPY_HTML, "utf8");
  writeFileSync(join(SITE, "csp.html"), CSP_HTML, "utf8");
}

/** Starts the dependency-free static server and waits until it answers. */
async function startServer(port) {
  const child = spawn(process.execPath, [SERVER, "--root", SITE, "--port", String(port), "--quiet"], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`static server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${origin}/happy.html`);
      if (response.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("static server did not become reachable");
    }
    await pause(50);
  }
  return { origin, stop: () => child.kill("SIGKILL") };
}

async function main() {
  setUpWorkspace();

  let failed = 0;
  let total = 0;
  let browser = null;
  let server = null;

  // CI sets this: the bookmarklet arrival path is only exercised here, so a pipeline must fail when
  // it cannot run rather than skip quietly.
  const browserRequired = process.env.BP_REQUIRE_BROWSER === "1";
  const browserPath = findChrome();
  const context = { origin: null, browser: null, browserPath };

  try {
    const port = await freePort();
    server = await startServer(port);
    context.origin = server.origin;

    if (browserPath === null) {
      console.log("browser: none found — the bookmarklet cases are skipped (set BP_CHROME to point at one)");
    } else {
      try {
        browser = await Browser.launch(browserPath, PROFILE, { width: 1280, height: 900 });
        context.browser = browser;
        console.log(`browser: ${browserPath}`);
      } catch (error) {
        const code = error?.code === "BROWSER_UNAVAILABLE" ? "BROWSER-UNAVAILABLE" : "BROWSER-START-FAILED";
        console.log(`browser: ${code} — could not start ${browserPath}\n${error.message}`);
      }
    }

    if (context.browser === null && browserRequired) {
      total += 1;
      failed += 1;
      console.log(
        "FAIL BROWSER-UNAVAILABLE (no assertion ran, the environment had no usable Chrome): BP_REQUIRE_BROWSER=1",
      );
    }

    for (const [name, body] of Object.entries(cases())) {
      total += 1;
      try {
        const detail = await body(context);
        if (detail instanceof Skipped) {
          console.log(`SKIP ${name} — ${detail.reason}`);
        } else {
          console.log(typeof detail === "string" ? `PASS ${name} (${detail})` : `PASS ${name}`);
        }
      } catch (error) {
        if (error instanceof Skipped) {
          console.log(`SKIP ${name} — ${error.reason}`);
          continue;
        }
        failed += 1;
        console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    if (browser !== null) await browser.close();
    server?.stop();
  }

  console.log(`bookmarklet-smoke: ${total - failed}/${total} case(s) passed in ${WORKSPACE}`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
