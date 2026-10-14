#!/usr/bin/env node
/**
 * Functional-parity harness (NFR-11) — proves that the *same* layer behaves the same however it
 * arrived on the page.
 *
 * One fixture document (examples/parity/page.html) is served twice, at the same path (`/`) on two
 * loopback ports, and the identical `CASES` (tests/e2e/parity-cases.mjs) run against both:
 *
 *   strand "embed"      the page embeds bluepencil through the one-tag loader (dist/attach.js),
 *                       which mounts the layer itself with a local adapter;
 *   strand "extension"  a page with no embed at all, plus the built MV3 extension loaded into the
 *                       browser; the extension's own service worker mounts the layer on the active
 *                       tab, unforced (no `force: true`).
 *
 * The body markup is byte-identical in both variants, so an observation that diverges is a real
 * behavioural difference between the two mount paths, not a fixture artefact. The runner prints a
 * matrix `case | embed | extension | parity` and exits non-zero on any failure or divergence.
 *
 * Depends on nothing new: the CDP client is scripts/lib/browser.mjs, the extension loading path is
 * the one extension/smoke.mjs proves, and there is no Playwright.
 *
 *   npm run smoke:parity                    all cases, both strands
 *   PARITY_ONLY=anchor npm run smoke:parity just the cases whose name contains "anchor"
 *   BP_REQUIRE_BROWSER=1 npm run smoke:parity   CI: a missing Chrome is a failure, not a skip
 *
 * Builds the extension itself (`node extension/build.mjs`); the library build (`npm run build`)
 * must already exist, exactly like the other smoke suites.
 */
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser, findChrome } from "../../scripts/lib/browser.mjs";
import { CASES, normalize } from "./parity-cases.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PAGE = join(root, "examples/parity/page.html");
const ELEMENT = join(root, "dist/bluepencil.element.min.js");
const ATTACH = join(root, "dist/attach.js");
const EXT_DIST = join(root, "extension/dist");
const WORKSPACE = join(root, ".tmp/parity");
const PROFILE_EMBED = join(WORKSPACE, "chrome-embed");
const PROFILE_EXT = join(WORKSPACE, "chrome-extension");

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
};

/** Requires a browser in CI, skips elsewhere — the same contract as the other smoke suites. */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function freePort() {
  return new Promise((resolve_, reject) => {
    const probe = createNetServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve_(port));
    });
  });
}

/**
 * The one-tag loader, injected into the embed variant only. `data-adapter="memory"` keeps that
 * strand hermetic (fresh store per page); the extension strand uses its own `chromeStorage` — the
 * comparison is about the layer's behaviour, not about which adapter persists the notes.
 */
const LOADER_TAG = `<script src="/dist/attach.js"
        data-adapter="memory"
        data-environment="dev"
        data-language="en"
        data-route="url"
        data-identity="anonymous"></script>`;

/** Serves the parity page at `/` (embed or plain) and the repository's static files under their paths. */
function startServer(port, { loader }) {
  const server = createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", `http://127.0.0.1:${port}`).pathname);
    if (pathname === "/" || pathname === "/index.html") {
      const html = readFileSync(PAGE, "utf8").replace("<!--BP_PARITY_LOADER_SLOT-->", loader ? LOADER_TAG : "");
      res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
      res.end(html);
      return;
    }
    const filePath = resolve(root, `.${pathname}`);
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error("not a file");
      res.writeHead(200, {
        "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((done) => server.listen(port, "127.0.0.1", () => done(server)));
}

/* -------------------------------------------------------------------------- */
/* extension loading — the path extension/smoke.mjs proves works               */
/* -------------------------------------------------------------------------- */

/**
 * `Extensions.loadUnpacked` where the browser supports it (Chrome 137 removed `--load-extension`
 * from branded builds), the command line as the fallback (unbranded Chromium). Identical to the
 * extension smoke's loader so a browser-side regression surfaces in one place.
 */
async function launchWithExtension(profile) {
  const chrome = findChrome();
  const modern = await Browser.launch(chrome, profile, {
    width: 1280,
    height: 900,
    extraArgs: ["--enable-unsafe-extension-debugging"],
  });
  try {
    const { id } = await modern.send("Extensions.loadUnpacked", { path: EXT_DIST });
    return { browser: modern, how: `Extensions.loadUnpacked (id ${id})` };
  } catch (error) {
    if (!/-32601|wasn't found|not found/.test(String(error?.message ?? error))) throw error;
    await modern.close();
  }
  const legacy = await Browser.launch(chrome, profile, {
    width: 1280,
    height: 900,
    extraArgs: [
      `--disable-extensions-except=${EXT_DIST}`,
      `--load-extension=${EXT_DIST}`,
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
    ],
  });
  return { browser: legacy, how: "--load-extension on the command line" };
}

/**
 * The extension's own service worker, attached. Chrome builds disagree about the CDP target name,
 * so the worker identifies itself: `chrome.runtime.getManifest().name` read from the attached
 * context — the same discriminator the extension smoke uses, and immune to Chrome's own workers.
 */
async function attachToBlueprintWorker(browser, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = [];
  while (Date.now() < deadline) {
    const { targetInfos } = await browser.send("Target.getTargets");
    lastSeen = targetInfos ?? [];
    for (const target of lastSeen) {
      if (target.type !== "service_worker" || !String(target.url).startsWith("chrome-extension://")) continue;
      try {
        await browser.attachTo((t) => t.targetId === target.targetId, { timeoutMs: 2000 });
        const name = await browser.evaluate("chrome.runtime.getManifest().name");
        if (/bluepencil/i.test(String(name))) return { ...target, name };
      } catch {
        /* a transient miss — keep looking, never latch */
      }
    }
    await pause(150);
  }
  throw new Error(
    `no bluepencil service worker within ${timeoutMs} ms; saw: ${
      lastSeen.filter((t) => t.type === "service_worker").map((t) => t.url).join(", ") || "nothing"
    }`,
  );
}

/** Mounts the layer the way the extension does when the user asks for it: on the active tab, unforced. */
async function mountUnforced(browser) {
  const result = await browser.evaluate(`(async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab || tab.id === undefined) return { ok: false, error: 'no active tab' };
      const mod = self.__bluepencilModule;
      if (mod && typeof mod.mountOnTab === 'function') {
        // No force:true here - the plain, user-visible mount path. On a page that embeds the layer
        // this steps aside; on this page there is no embed, so it must mount.
        return await mod.mountOnTab(tab.id, tab.url ?? '');
      }
      return { ok: false, error: 'worker module not reachable (' + typeof mod + ')' };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  })()`);
  assert(result?.ok === true, `the extension's unforced mount failed: ${JSON.stringify(result)}`);
}

/* -------------------------------------------------------------------------- */
/* strand running                                                              */
/* -------------------------------------------------------------------------- */

function stable(value) {
  return JSON.stringify(value);
}

/** Runs every case against an attached browser, collecting `{ status, observation, error }` per name. */
async function runCases(browser, label) {
  const outcomes = new Map();
  for (const testCase of CASES) {
    try {
      const observation = normalize(await testCase.probe(browser));
      outcomes.set(testCase.name, { status: "PASS", observation });
      console.log(`  [${label}] PASS ${testCase.name}`);
    } catch (error) {
      outcomes.set(testCase.name, { status: "FAIL", error: error?.message ?? String(error) });
      console.log(`  [${label}] FAIL ${testCase.name}\n    ${error?.message ?? error}`);
    }
  }
  return outcomes;
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  if (!existsSync(ELEMENT) || !existsSync(ATTACH)) {
    console.error(`[parity] missing build artifact — run "npm run build" first (${ELEMENT}, ${ATTACH})`);
    process.exit(1);
  }

  // The extension is built here, not assumed: a stale extension/dist would compare yesterday's
  // layer against today's embed build and call the drift a real difference.
  const build = spawnSync("node", [join(root, "extension/build.mjs")], { cwd: root, encoding: "utf8" });
  if (build.status !== 0) {
    console.error(`[parity] extension build failed:\n${build.stdout}${build.stderr}`);
    process.exit(1);
  }

  const only = process.env.PARITY_ONLY ?? "";
  const selected = CASES.filter((testCase) => testCase.name.includes(only));
  if (selected.length === 0) {
    console.error(`[parity] no case matches PARITY_ONLY="${only}"`);
    process.exit(1);
  }

  const chrome = findChrome();
  if (chrome === null) {
    const reason = "no usable Chrome (looked at PATH, /usr/bin and the Playwright caches) — set BP_CHROME";
    if (process.env.BP_REQUIRE_BROWSER === "1") {
      console.error(`[parity] BP_REQUIRE_BROWSER=1 — ${reason}`);
      process.exit(1);
    }
    console.log(`[parity] SKIP — ${reason}`);
    process.exit(0);
  }

  rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(PROFILE_EMBED, { recursive: true });
  mkdirSync(PROFILE_EXT, { recursive: true });

  const embedPort = await freePort();
  const extPort = await freePort();
  const embedServer = await startServer(embedPort, { loader: true });
  const extServer = await startServer(extPort, { loader: false });
  const embedBase = `http://127.0.0.1:${embedPort}/`;
  const extBase = `http://127.0.0.1:${extPort}/`;

  const results = { embed: new Map(), extension: new Map() };
  let embedBrowser;
  let extBrowser;
  let fatal = null;

  try {
    /* -- strand "embed" ---------------------------------------------------- */
    console.log(`[parity] embed strand — loader via ${embedBase}`);
    embedBrowser = await Browser.launch(chrome, PROFILE_EMBED, { width: 1280, height: 900 });
    await embedBrowser.navigate(embedBase);
    await embedBrowser.waitFor(`Boolean(window.bluepencilAttach)`, { timeoutMs: 25000 });
    await embedBrowser.waitFor(`Boolean(document.querySelector('bluepencil-notes'))`, { timeoutMs: 25000 });
    results.embed = await runCases(embedBrowser, "embed");

    /* -- strand "extension" ------------------------------------------------ */
    console.log(`[parity] extension strand — MV3 extension on ${extBase}`);
    const launched = await launchWithExtension(PROFILE_EXT);
    extBrowser = launched.browser;
    console.log(`[parity] extension loaded via ${launched.how}`);
    await extBrowser.navigate(extBase);
    await extBrowser.waitFor(`document.readyState === "complete"`, { timeoutMs: 25000 });
    const preMount = await extBrowser.evaluate(`document.querySelectorAll('bluepencil-notes').length`);
    assert(preMount === 0, `the extension fixture must start without a layer of its own, found ${preMount}`);
    const worker = await attachToBlueprintWorker(extBrowser);
    console.log(`[parity] service worker attached: ${worker.name}`);
    await mountUnforced(extBrowser);
    await extBrowser.attachToPageWhere((t) => t.url.includes(String(extPort)));
    results.extension = await runCases(extBrowser, "extension");
  } catch (error) {
    fatal = error;
  } finally {
    if (embedBrowser) await embedBrowser.close();
    if (extBrowser) await extBrowser.close();
    embedServer.close();
    extServer.close();
  }

  /* -- matrix ------------------------------------------------------------- */
  const rows = [];
  let diverged = 0;
  let failed = 0;
  for (const testCase of selected) {
    const embed = results.embed.get(testCase.name) ?? { status: "FAIL", error: "strand did not run" };
    const extension = results.extension.get(testCase.name) ?? { status: "FAIL", error: "strand did not run" };
    let parity = "PASS";
    if (embed.status !== "PASS" || extension.status !== "PASS") {
      parity = "FAIL";
    } else if (stable(embed.observation) !== stable(extension.observation)) {
      parity = "FAIL";
      diverged += 1;
    }
    if (embed.status !== "PASS") failed += 1;
    if (extension.status !== "PASS") failed += 1;
    rows.push({
      name: testCase.name,
      embed: embed.status,
      extension: extension.status,
      parity,
      embedOutcome: embed,
      extensionOutcome: extension,
    });
  }

  const width = Math.max(6, ...rows.map((row) => row.name.length));
  console.log("");
  console.log(`${"case".padEnd(width)} | ${"embed".padEnd(9)} | ${"extension".padEnd(9)} | parity`);
  console.log(`${"-".repeat(width)}-+-${"-".repeat(9)}-+-${"-".repeat(9)}-+-------`);
  for (const row of rows) {
    console.log(
      `${row.name.padEnd(width)} | ${row.embed.padEnd(9)} | ${row.extension.padEnd(9)} | ${row.parity}`,
    );
  }

  // A divergence is the interesting failure — show both observations so it is diagnosable.
  for (const row of rows) {
    if (row.parity === "FAIL" && row.embed.status === "PASS" && row.extension.status === "PASS") {
      console.log(`\nDIVERGENCE ${row.name}`);
      console.log(`  embed     : ${stable(row.embedOutcome.observation)}`);
      console.log(`  extension : ${stable(row.extensionOutcome.observation)}`);
    }
    if (row.embed.status === "FAIL") console.log(`\nembed FAIL ${row.name}: ${row.embedOutcome.error}`);
    if (row.extension.status === "FAIL") console.log(`\nextension FAIL ${row.name}: ${row.extensionOutcome.error}`);
  }

  if (fatal) {
    console.error(`\n[parity] harness error: ${fatal.message}`);
  }

  const parityFailures = rows.filter((row) => row.parity !== "PASS").length;
  console.log(
    `\nparity: ${rows.length - parityFailures}/${rows.length} case(s) parity-clean${diverged > 0 ? `, ${diverged} divergent` : ""}`,
  );
  if (fatal || failed > 0 || parityFailures > 0) process.exit(1);
}

await main();
