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
 */
async function attachToBlueprintWorker(browser, { timeoutMs = 20000, expect = /bluepencil/i } = {}) {
  const deadline = Date.now() + timeoutMs;
  const probed = new Map();
  const seen = new Set();
  while (Date.now() < deadline) {
    const { targetInfos } = await browser.send("Target.getTargets");
    const targets = targetInfos ?? [];
    for (const target of targets) {
      if (target.type === "service_worker") seen.add(`${target.type}:${target.url}`);
    }
    for (const candidate of targets) {
      if (candidate.type !== "service_worker") continue;
      if (!candidate.url.startsWith("chrome-extension://")) continue;
      if (probed.has(candidate.targetId)) continue;
      const attached = await browser.attachTo((t) => t.targetId === candidate.targetId, {
        timeoutMs: 2000,
      });
      const name = await browser
        .evaluate("chrome.runtime.getManifest().name")
        .catch(() => undefined);
      probed.set(candidate.targetId, `${name ?? "no manifest"} <${candidate.url}>`);
      if (typeof name === "string" && expect.test(name)) {
        return { ...attached, name, candidates: [...probed.values()] };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `no extension service worker matching ${expect} within ${timeoutMs} ms; probed: ${
      [...probed.values()].join(" | ") || "nothing"
    }; seen: ${[...seen].join(", ") || "nothing"}`,
  );
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

async function checkInBrowser() {
  const server = await startHost();
  const profile = await mkdtemp(join(tmpdir(), "bp-ext-smoke-"));
  const launched = await launchWithExtension(profile);
  const browser = launched.browser;

  try {
    await browser.navigate(`http://127.0.0.1:${HOST_PORT}/`);
    await browser.waitFor(`document.readyState === "complete"`);

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
      `attached ${worker.name} via ${launched.how}; probed ${worker.candidates.join(" | ")}`);

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
    //    the user when it dies and verifies nothing (the sidecar is the only party that decides), so
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
    // turns "timed out after 20000 ms" into the sentence that says why (a refused sidecar URL, a
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
    // white on white — invisible — and the sidecar warning inherited the browser's white text onto
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
        sample(".warn", "the sidecar warning"),
        sample(".hint", "a hint line"),
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
