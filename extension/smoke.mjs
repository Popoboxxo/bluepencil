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
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Browser, findChrome, requireBrowser } from "../scripts/lib/browser.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const extDist = join(here, "dist");
const HOST_PORT = 9431;

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

/** The host's own stylesheet, served same-origin so the CSP permits it. */
const HOST_CSS = `#target { color: rgb(34, 34, 34); }`;

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

function startHost() {
  const server = createServer((req, res) => {
    if ((req.url ?? "").startsWith("/host.css")) {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end(HOST_CSS);
      return;
    }
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
  for (const required of ["manifest.json", "sw.js", "bridge.js", "options.html", "options.js",
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
/* browser checks — the parts that only a real browser can answer               */
/* -------------------------------------------------------------------------- */

async function checkInBrowser() {
  const server = await startHost();
  const profile = await mkdtemp(join(tmpdir(), "bp-ext-smoke-"));
  const browser = await Browser.launch(findChrome(), profile, {
    extraArgs: [`--disable-extensions-except=${extDist}`, `--load-extension=${extDist}`],
  });

  try {
    await browser.navigate(`http://127.0.0.1:${HOST_PORT}/`);
    await browser.waitFor(`document.readyState === "complete"`);

    // 1. The service worker must exist at all. A manifest error stops it, and every later
    //    assertion would then fail with a confusing "nothing injected" instead.
    //
    //    Match specifically on `/sw.js`: this Chrome build ships two other extensions (a component
    //    extension and a built-in one), each with its own worker. Attaching to the first
    //    `chrome-extension://` worker would evaluate in a context that has neither `chrome.scripting`
    //    nor this extension's module — measured as exactly that.
    const worker = await browser.attachTo(
      (t) => t.type === "service_worker" && t.url.endsWith("/sw.js"),
    );
    ok("the extension service worker starts", worker !== undefined);
    ok("the service worker is bluepencil's own",
      worker.url.startsWith("chrome-extension://") && worker.url.endsWith("/sw.js"),
      worker.url);

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
    const mountResult = await browser.evaluate(`(async () => {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = tabs[0];
        if (!tab || tab.id === undefined) return { ok: false, error: 'no active tab' };
        // Reaching the worker's own module registry without import(): the module was already
        // evaluated when the worker started, so its exports live on the global scope esbuild
        // emitted for the listener registration. Falling back to the message path keeps this honest
        // if that ever stops being true — the assertion below is on the page, not on the mechanism.
        const mod = self.__bluepencilModule;
        if (mod && typeof mod.mountOnTab === 'function') {
          return await mod.mountOnTab(tab.id, tab.url ?? '');
        }
        return { ok: false, error: 'worker module not reachable (' + typeof mod + ')' };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    })()`);
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
    ok("the layer uses the extension's own store", state.store === "chromeStorage",
      `data-store=${state.store}`);
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
  } finally {
    await browser.close();
    server.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

try {
  await checkArtefacts();
  requireBrowser({ browser: findChrome() });
  await checkInBrowser();
} catch (error) {
  if (error?.constructor?.name === "Skipped") {
    console.log(`SKIP ${error.message}`);
  } else {
    failed += 1;
    console.log(`FAIL unexpected — ${error?.stack ?? error}`);
  }
}

console.log(`\next-smoke: ${passed + failed} case(s), ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
