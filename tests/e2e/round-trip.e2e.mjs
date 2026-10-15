#!/usr/bin/env node
/**
 * Round-trip harness — the whole bluepencil system in ONE flow, both browser strands.
 *
 * This is the only automated test that proves the *closed loop* end to end:
 *
 *   browser → hub → agent (MCP) → hub → browser
 *
 * in a single, observed run, for BOTH ways the layer can arrive on a page:
 *
 *   strand "embed"      a page that loads the layer through the one-tag loader (`dist/attach.js`),
 *                       served by the reference hub itself, with a root-relative `data-endpoint`,
 *                       so the layer writes to and reads from the hub on its own origin;
 *   strand "extension"  a plain page with no embed, served on a SEPARATE static origin; the built
 *                       MV3 extension mounts the layer, whose `http` adapter talks to the hub
 *                       cross-origin (hence the hub runs with `--cors "*"`).
 *
 * Requirements pinned (docs/REQUIREMENTS.md):
 *   FR-16.8  the same MCP is reachable over HTTP    — the hub answers `POST {base}/mcp`, the same
 *            tools and the same validators as the stdio server, read-by-default, writable when the
 *            hub is not `--read-only`.
 *   FR-16.9  two doors, one store                   — a note written by the browser through the
 *            notes API is visible to the agent over MCP of the SAME process, and a write the agent
 *            makes over MCP is visible in the browser's next reload — no second file handle, no
 *            second truth.
 *   NFR-11   testability                            — a fixture app in-repo, driven in a real
 *            browser over the dependency-free CDP harness (no Playwright, NFR-4).
 *   PROTOCOL §6 (hard prohibitions)                 — an `intent=feedback` note is never set to
 *            `done` by an agent; the authority check at the end asserts the refusal.
 *
 * Run it from the repository root after BOTH builds exist:
 *   npm run build && npm run build:ext
 *   npm run smoke:round-trip
 *   BP_REQUIRE_BROWSER=1 npm run smoke:round-trip    # CI: a missing Chrome is a failure
 *
 * It is deterministic: every assertion polls real, observed state (`waitFor`/bounded loops), never
 * a fixed sleep for correctness. On any failure it prints the step matrix plus the failing step's
 * page snapshot and exits non-zero. Node reads the hub's `GET /notes` directly for the
 * browser→hub half, so a note that only ever reached the page's own store cannot pass.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser, findChrome } from "../../scripts/lib/browser.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const EMBED_PAGE = join(root, "examples/round-trip/embed.html");
const EXT_PAGE = join(root, "examples/round-trip/extension.html");
const ELEMENT = join(root, "dist/bluepencil.element.min.js");
const ATTACH = join(root, "dist/attach.js");
const EXT_DIST = join(root, "extension/dist");
const SERVER_ENTRY = join(root, "dist/server.js");
const WORKSPACE = join(root, ".tmp/round-trip");
const PROFILE_EMBED = join(WORKSPACE, "chrome-embed");
const PROFILE_EXT = join(WORKSPACE, "chrome-extension");
const HUB_BASE_PATH = "/api/v1/bluepencil";

/**
 * Fixed sentinels. A fresh temp store is created on every run, so these never have to be unique —
 * which keeps the assertions (and the failure messages) readable and byte-stable.
 */
const EMBED_BODY = "round-trip: embed note (browser to hub)";
const EXT_BODY = "round-trip: extension note (browser to hub)";
const REPLY_TEXT = "agent: shipped (round-trip)";
const FEEDBACK_BODY = "round-trip: assess only, change nothing (feedback)";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function freePort() {
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

/* -------------------------------------------------------------------------- */
/* the hub — built reference server, serving the embed fixture AND the API     */
/* -------------------------------------------------------------------------- */

/**
 * Start `dist/server.js` with `--root <repo root>` so the SAME origin serves the EMBED fixture and
 * `/dist/**`. `--cors "*"` is required for the extension strand (its page is a different origin).
 * `--journal none` keeps the smoke out of the work tree's git history. The hub is writable —
 * only `--read-only` would refuse the MCP reply/status writes this test needs.
 */
async function startHub(storePath) {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      SERVER_ENTRY,
      "--store", storePath,
      "--host", "127.0.0.1",
      "--port", String(port),
      "--root", root,
      "--environment", "dev",
      "--cors", "*",
      "--journal", "none",
      "--quiet",
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const origin = `http://127.0.0.1:${port}`;
  const base = `${origin}${HUB_BASE_PATH}`;
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
    await pause(50);
  }
  return {
    port,
    origin,
    base,
    /** Bounded shutdown: SIGTERM, then SIGKILL after a grace period, resolved on `exit`. */
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        const forceKill = setTimeout(() => child.kill("SIGKILL"), 5000);
        child.once("exit", () => {
          clearTimeout(forceKill);
          resolve();
        });
        child.kill("SIGTERM");
      }),
  };
}

/* -------------------------------------------------------------------------- */
/* the extension fixture's own static origin                                   */
/* -------------------------------------------------------------------------- */

function startStaticServer(port, pagePath) {
  const html = readFileSync(pagePath, "utf8");
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", `http://127.0.0.1:${port}`).pathname);
    if (pathname === "/" || pathname === "/extension.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });
  return new Promise((done) => server.listen(port, "127.0.0.1", () => done(server)));
}

/* -------------------------------------------------------------------------- */
/* Node-side reads/writes: the notes API and the MCP door (FR-16.8/16.9)       */
/* -------------------------------------------------------------------------- */

async function hubNotes(base) {
  const response = await fetch(`${base}/notes?includeDone=true`);
  if (!response.ok) throw new Error(`GET ${base}/notes → HTTP ${response.status}`);
  const payload = await response.json();
  return payload.notes ?? [];
}

async function hubNote(base, id) {
  const response = await fetch(`${base}/notes/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(`GET ${base}/notes/${id} → HTTP ${response.status}`);
  const payload = await response.json();
  return payload.note ?? payload;
}

/** Polls the hub (read from Node, never from the page) until a note body containing `tag` is there. */
async function waitForHubNote(base, tag, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const found = (await hubNotes(base)).find((note) => String(note.body ?? "").includes(tag));
      if (found !== undefined) return found;
    } catch {
      /* a transient miss is retried until the deadline */
    }
    if (Date.now() > deadline) return null;
    await pause(100);
  }
}

let rpcSeq = 0;
/** One JSON-RPC 2.0 request to the hub's MCP door. Returns `{ status, frame }`. */
async function mcpRequest(base, method, params) {
  const id = ++rpcSeq;
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await response.text();
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    throw new Error(`MCP ${method} → HTTP ${response.status}, non-JSON body: ${text.slice(0, 200)}`);
  }
  return { status: response.status, frame };
}

/** One `tools/call`; a protocol-level error is thrown, a tool refusal comes back as `isError`. */
async function mcpTool(base, name, args = {}) {
  const { frame } = await mcpRequest(base, "tools/call", { name, arguments: args });
  if (frame.error !== undefined) {
    throw new Error(`MCP tools/call ${name} → protocol error ${frame.error.code}: ${frame.error.message}`);
  }
  return frame.result ?? {};
}

const toolText = (result) => (result.content ?? []).map((entry) => entry.text ?? "").join("\n");

/* -------------------------------------------------------------------------- */
/* browser UI helpers — the same real-UI paths the parity suite drives          */
/* -------------------------------------------------------------------------- */

/** Waits until the layer is mounted *and* running, whichever strand put it there. */
async function layerReady(browser) {
  await browser.waitFor(`Boolean(document.querySelector('bluepencil-notes')?.blueprint)`, {
    timeoutMs: 25000,
  });
  await browser.waitFor(`Boolean(document.querySelector('.bp-root') && document.querySelector('.bp-bar'))`, {
    timeoutMs: 25000,
  });
}

const pressedExpr = (action) =>
  `document.querySelector('[data-bp-action="${action}"]')?.getAttribute('aria-pressed') === 'true'`;

/** Puts a bar toggle into the wanted state and waits until the layer reports it (idempotent arming). */
async function setPressed(browser, action, desired) {
  const expr = pressedExpr(action);
  if ((await browser.evaluate(expr)) !== desired) {
    await browser.click(`[data-bp-action="${action}"]`);
  }
  await browser.waitFor(`(${expr}) === ${desired}`, { timeoutMs: 5000 });
}

const armMode = (browser, action) => setPressed(browser, action, true);

/** The store's synchronous view of the note set — the documented element API, not internals. */
const notesOf = (browser) =>
  browser.evaluate(`document.querySelector('bluepencil-notes').blueprint.store.notes()`);

/** Types the body into the open composer and saves it (real mouse click on the save button). */
async function saveComposer(browser, target, body) {
  try {
    await browser.waitFor(
      `(() => { const n = document.querySelector('.bp-composer'); if (!n) return false;
                const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`,
      { timeoutMs: 8000 },
    );
  } catch (error) {
    const diag = await browser.evaluate(`(() => {
      const title = document.querySelector(${JSON.stringify(target)});
      const r = title ? title.getBoundingClientRect() : null;
      const at = r ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
      return {
        composerExists: Boolean(document.querySelector('.bp-composer')),
        pressed: [...document.querySelectorAll('[data-bp-action^="mode-"]')].map((b) => b.getAttribute('data-bp-action') + '=' + b.getAttribute('aria-pressed')),
        feedbackOnly: document.querySelector('[data-bp-action="feedback-only"]')?.getAttribute('aria-pressed'),
        atPoint: at ? (at.tagName + '.' + at.className) : null,
      };
    })()`);
    throw new Error(`composer never opened for ${target}: ${JSON.stringify(diag)} (${error?.message ?? error})`);
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
 * save. Polls the store for the new note (the http write is asynchronous) and returns it.
 */
async function createNote(browser, { target, body, mode = "text", feedback = false }) {
  const before = (await notesOf(browser)).length;
  await armMode(browser, `mode-${mode}`);
  // `feedback-only` is a flag armed in addition to a mode; set explicitly so a previous note's
  // intent cannot leak into this one.
  await setPressed(browser, "feedback-only", feedback);
  await browser.click(target);
  await saveComposer(browser, target, body);
  await browser.waitFor(
    `document.querySelector('bluepencil-notes').blueprint.store.notes().length === ${before + 1}`,
    { timeoutMs: 10000 },
  );
  const notes = await notesOf(browser);
  const match = notes.filter((note) => String(note.body ?? "").includes(body));
  return match[match.length - 1] ?? null;
}

/**
 * Polls the layer's own store until a note's body OR one of its thread messages contains `tag`.
 * The agent's reply is a thread message, not the note's body, so both have to be searched.
 */
async function waitForStoreNote(browser, tag, { timeoutMs = 20000 } = {}) {
  await browser.waitFor(
    `document.querySelector('bluepencil-notes')?.blueprint?.store.notes().some((n) =>
       String(n.body).includes(${JSON.stringify(tag)}) ||
       (n.messages ?? []).some((m) => String(m.text).includes(${JSON.stringify(tag)}))) === true`,
    { timeoutMs },
  );
}

/** Opens the panel through its own bar toggle and waits for the list body. */
async function openPanel(browser) {
  await setPressed(browser, "panel", true);
  await browser.waitFor(`Boolean(document.querySelector('.bp-panel-body'))`, { timeoutMs: 8000 });
}

const noteSelector = (id) => `[data-bp-note-id="${id}"]`;

/** Reads a note's rendered row: its status attribute and the text of its inline thread. */
async function readNoteRow(browser, id) {
  const selector = noteSelector(id);
  await browser.waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, { timeoutMs: 10000 });
  return browser.evaluate(`(() => {
    const row = document.querySelector(${JSON.stringify(selector)});
    if (!row) return null;
    const thread = row.querySelector('[data-bp-part="thread"]');
    return {
      status: row.getAttribute('data-bp-status'),
      thread: thread ? thread.textContent.replace(/\\s+/g, ' ').trim() : null,
    };
  })()`);
}

/* -------------------------------------------------------------------------- */
/* extension loading — the path extension/smoke.mjs and parity.e2e.mjs prove    */
/* -------------------------------------------------------------------------- */

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

/** The extension's own service worker, attached and identified by its manifest name. */
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

/** Mounts the layer the way the extension does on the active tab, unforced. */
async function mountUnforced(browser) {
  await attachToBlueprintWorker(browser);
  const result = await browser.evaluate(`(async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab || tab.id === undefined) return { ok: false, error: 'no active tab' };
      const mod = self.__bluepencilModule;
      if (mod && typeof mod.mountOnTab === 'function') {
        return await mod.mountOnTab(tab.id, tab.url ?? '');
      }
      return { ok: false, error: 'worker module not reachable (' + typeof mod + ')' };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  })()`);
  assert(result?.ok === true, `the extension's unforced mount failed: ${JSON.stringify(result)}`);
}

/** The full settings shape the worker's `normalizeSettings` validates (extension/src/settings.ts). */
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

/** Writes the extension's settings blob where the mount path reads it (copied from extension/smoke.mjs). */
async function writeExtensionSettings(browser, settings = {}) {
  await attachToBlueprintWorker(browser);
  const merged = { ...EXTENSION_SETTINGS_DEFAULTS, ...settings };
  await browser.evaluate(`(async () => {
    await chrome.storage.local.set({ "bluepencil:settings": ${JSON.stringify(merged)} });
    return true;
  })()`);
}

/* -------------------------------------------------------------------------- */
/* the matrix                                                                  */
/* -------------------------------------------------------------------------- */

const rows = [];
let fatal = null;

/**
 * Runs one step and records it. `columns` says which strand(s) the step observes; on failure the
 * error is latched so every later step is reported "not reached" rather than run on a broken state.
 */
async function row(name, columns, fn) {
  const result = { name, embed: "·", extension: "·", note: "" };
  if (fatal) {
    if (columns.embed) result.embed = "FAIL";
    if (columns.extension) result.extension = "FAIL";
    result.note = "not reached";
    rows.push(result);
    return;
  }
  try {
    const note = await fn();
    if (columns.embed) result.embed = "PASS";
    if (columns.extension) result.extension = "PASS";
    if (typeof note === "string") result.note = note;
  } catch (error) {
    fatal = { name, error };
    if (columns.embed) result.embed = "FAIL";
    if (columns.extension) result.extension = "FAIL";
  }
  rows.push(result);
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  // The element guard is required even though this harness never names ELEMENT directly: the embed
  // strand loads dist/attach.js, which fetches dist/bluepencil.element.min.js by default (see the
  // loader's `P = "bluepencil.element.min.js"`), so the embed strand cannot start without it.
  for (const [label, path] of [["dist/attach.js", ATTACH], ["dist/bluepencil.element.min.js", ELEMENT]]) {
    if (!existsSync(path)) {
      console.error(`[round-trip] missing build artifact ${label} — run "npm run build" first`);
      process.exit(1);
    }
  }
  if (!existsSync(join(EXT_DIST, "manifest.json"))) {
    console.error(`[round-trip] missing extension build ${EXT_DIST} — run "npm run build:ext" first`);
    process.exit(1);
  }

  const chrome = findChrome();
  if (chrome === null) {
    const reason = "no usable Chrome (looked at PATH, /usr/bin and the Playwright caches) — set BP_CHROME";
    if (process.env.BP_REQUIRE_BROWSER === "1") {
      console.error(`[round-trip] BP_REQUIRE_BROWSER=1 — ${reason}`);
      process.exit(1);
    }
    console.log(`[round-trip] SKIP — ${reason}`);
    process.exit(0);
  }

  rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(PROFILE_EMBED, { recursive: true });
  mkdirSync(PROFILE_EXT, { recursive: true });

  const extStaticPort = await freePort();
  const staticServer = await startStaticServer(extStaticPort, EXT_PAGE);
  const extUrl = `http://127.0.0.1:${extStaticPort}/extension.html`;

  let hub;
  let embedBrowser;
  let extBrowser;

  // Shared state between steps: the hub-side notes (with the ids the agent needs).
  const state = { embedNote: null, extNote: null };

  try {
    hub = await startHub(join(WORKSPACE, "hub-store.json"));
    const embedUrl = `${hub.origin}/examples/round-trip/embed.html`;
    console.log(`[round-trip] hub on ${hub.origin} (base ${hub.base}); embed ${embedUrl}; extension ${extUrl}`);

    /* ---- strand EMBED: load through the one-tag loader ------------------- */

    embedBrowser = await Browser.launch(chrome, PROFILE_EMBED, { width: 1280, height: 900 });
    await embedBrowser.navigate(embedUrl);

    await row("embed: layer mounts (one-tag loader)", { embed: true, extension: false }, async () => {
      await embedBrowser.waitFor(`Boolean(window.bluepencilAttach)`, { timeoutMs: 25000 });
      await embedBrowser.waitFor(`Boolean(document.querySelector('bluepencil-notes'))`, { timeoutMs: 25000 });
      await layerReady(embedBrowser);
      const adapter = await embedBrowser.evaluate(
        `document.querySelector('bluepencil-notes').blueprint.store.adapterName`,
      );
      if (adapter !== "http") throw new Error(`embed strand expected the http adapter, got ${adapter}`);
      return `adapter=${adapter}`;
    });

    await row("embed: note created via real UI", { embed: true, extension: false }, async () => {
      const note = await createNote(embedBrowser, { target: '[data-testid="rt-embed-title"]', body: EMBED_BODY });
      if (note === null) throw new Error("the embed note is not in the layer store");
      return `body="${EMBED_BODY}"`;
    });

    await row("embed: note reaches the hub (Node reads GET /notes)", { embed: true, extension: false }, async () => {
      const onHub = await waitForHubNote(hub.base, EMBED_BODY);
      if (onHub === null) throw new Error(`GET ${hub.base}/notes never held the embed note`);
      state.embedNote = onHub;
      return `id=${onHub.id}`;
    });

    /* ---- strand EXTENSION: MV3 mounts a plain page on another origin ----- */

    const launched = await launchWithExtension(PROFILE_EXT);
    extBrowser = launched.browser;
    console.log(`[round-trip] extension loaded via ${launched.how}`);

    await row("extension: layer mounts (MV3, unforced)", { embed: false, extension: true }, async () => {
      await extBrowser.navigate(extUrl);
      await extBrowser.waitFor(`document.readyState === "complete"`, { timeoutMs: 25000 });
      const pre = await extBrowser.evaluate(`document.querySelectorAll('bluepencil-notes').length`);
      if (pre !== 0) throw new Error(`the extension fixture must start without a layer, found ${pre}`);
      await writeExtensionSettings(extBrowser, {
        store: "http",
        endpoint: hub.base,
        identity: "anonymous",
        auth: "none",
        environment: "dev",
      });
      await mountUnforced(extBrowser);
      await extBrowser.attachToPageWhere((t) => t.url.includes(String(extStaticPort)));
      await layerReady(extBrowser);
      const adapter = await extBrowser.evaluate(
        `document.querySelector('bluepencil-notes').blueprint.store.adapterName`,
      );
      if (adapter !== "http") throw new Error(`extension strand expected the http adapter, got ${adapter}`);
      return `adapter=${adapter}`;
    });

    await row("extension: note created via real UI", { embed: false, extension: true }, async () => {
      const note = await createNote(extBrowser, { target: '[data-testid="rt-ext-title"]', body: EXT_BODY });
      if (note === null) throw new Error("the extension note is not in the layer store");
      return `body="${EXT_BODY}"`;
    });

    /* ---- the shared store: both browser writes are now on the hub -------- */

    await row("hub holds BOTH browser notes", { embed: true, extension: true }, async () => {
      const onHub = await waitForHubNote(hub.base, EXT_BODY);
      if (onHub === null) throw new Error(`GET ${hub.base}/notes never held the extension note`);
      state.extNote = onHub;
      const notes = await hubNotes(hub.base);
      const hasEmbed = notes.some((note) => String(note.body).includes(EMBED_BODY));
      const hasExt = notes.some((note) => String(note.body).includes(EXT_BODY));
      if (!hasEmbed || !hasExt) {
        throw new Error(`hub holds ${notes.length} note(s); embed=${hasEmbed} extension=${hasExt}`);
      }
      return `embed + extension, ${notes.length} note(s)`;
    });

    /* ---- the agent: reads both, then replies over the SAME MCP door ------ */

    await row("agent (MCP): reads BOTH notes", { embed: true, extension: true }, async () => {
      const init = await mcpRequest(hub.base, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "round-trip e2e", version: "1.0.0" },
      });
      const serverInfo = init.frame.result?.serverInfo ?? {};
      if (serverInfo.name !== "bluepencil") {
        throw new Error(`initialize → serverInfo.name=${JSON.stringify(serverInfo.name)}, expected "bluepencil"`);
      }
      const list = await mcpRequest(hub.base, "tools/list", {});
      const names = (list.frame.result?.tools ?? []).map((tool) => tool.name);
      for (const required of ["list_notes", "reply", "set_status"]) {
        if (!names.includes(required)) throw new Error(`tools/list is missing ${required}: ${names.join(", ")}`);
      }
      const result = await mcpTool(hub.base, "list_notes", { include_done: true });
      if (result.isError === true) throw new Error(`list_notes failed: ${toolText(result)}`);
      const text = toolText(result);
      if (!text.includes(EMBED_BODY) || !text.includes(EXT_BODY)) {
        throw new Error(`list_notes does not carry both browser notes (${text.length} chars)`);
      }
      return "2 notes via MCP";
    });

    await row("agent (MCP): reply stored on the hub", { embed: true, extension: true }, async () => {
      if (state.embedNote === null) throw new Error("no embed note id — the earlier step did not run");
      const result = await mcpTool(hub.base, "reply", {
        id: state.embedNote.id,
        text: REPLY_TEXT,
        kind: "reply",
        set_done: true,
      });
      if (result.isError === true) throw new Error(`agent reply was refused: ${toolText(result)}`);
      const stored = await hubNote(hub.base, state.embedNote.id);
      const thread = (stored.messages ?? []).map((message) => String(message.text ?? "")).join("\n");
      if (!thread.includes(REPLY_TEXT)) throw new Error("the reply text is not on the stored note");
      if (stored.status !== "done") throw new Error(`stored status is ${stored.status}, expected done`);
      return `status=done, thread has the reply`;
    });

    /* ---- back to the browser: BOTH strands render the agent's write ------ */

    await row("embed: shows the agent reply + status after reload", { embed: true, extension: false }, async () => {
      await embedBrowser.navigate(embedUrl);
      await embedBrowser.waitFor(`Boolean(document.querySelector('bluepencil-notes'))`, { timeoutMs: 25000 });
      await layerReady(embedBrowser);
      await waitForStoreNote(embedBrowser, REPLY_TEXT);
      await waitForStoreNote(embedBrowser, EMBED_BODY);
      await openPanel(embedBrowser);
      await setPressed(embedBrowser, "show-done", true);
      const detail = await readNoteRow(embedBrowser, state.embedNote.id);
      if (detail === null) throw new Error("the note row is not in the panel");
      if (detail.thread === null || !detail.thread.includes(REPLY_TEXT)) {
        throw new Error(`the thread does not render the agent reply: ${JSON.stringify(detail)}`);
      }
      if (detail.status !== "done") throw new Error(`the panel shows status ${detail.status}, expected done`);
      return "reply rendered, status done";
    });

    await row("extension: shows the agent reply + status after reload", { embed: false, extension: true }, async () => {
      await extBrowser.attachToPageWhere((t) => t.url.includes(String(extStaticPort)));
      await extBrowser.navigate(extUrl);
      await extBrowser.waitFor(`document.readyState === "complete"`, { timeoutMs: 25000 });
      await mountUnforced(extBrowser);
      await extBrowser.attachToPageWhere((t) => t.url.includes(String(extStaticPort)));
      await layerReady(extBrowser);
      await waitForStoreNote(extBrowser, REPLY_TEXT);
      await waitForStoreNote(extBrowser, EXT_BODY);
      await openPanel(extBrowser);
      await setPressed(extBrowser, "show-done", true);
      const detail = await readNoteRow(extBrowser, state.embedNote.id);
      if (detail === null) throw new Error("the note row is not in the panel");
      if (detail.thread === null || !detail.thread.includes(REPLY_TEXT)) {
        throw new Error(`the thread does not render the agent reply: ${JSON.stringify(detail)}`);
      }
      if (detail.status !== "done") throw new Error(`the panel shows status ${detail.status}, expected done`);
      return "reply rendered, status done";
    });

    /* ---- authority: the agent stays inside the collaboration protocol ---- */

    await row("authority: feedback note refuses agent set_status done", { embed: true, extension: false }, async () => {
      // Close the panel so it cannot swallow the capture click, then create a feedback note through
      // the real UI on the still-live embed page.
      await setPressed(embedBrowser, "panel", false);
      const note = await createNote(embedBrowser, {
        target: '[data-testid="rt-embed-body"]',
        body: FEEDBACK_BODY,
        feedback: true,
      });
      if (note === null) throw new Error("the feedback note is not in the layer store");
      const onHub = await waitForHubNote(hub.base, FEEDBACK_BODY);
      if (onHub === null) throw new Error("the feedback note never reached the hub");
      if (onHub.intent !== "feedback") throw new Error(`hub stored intent=${onHub.intent}, expected feedback`);
      const result = await mcpTool(hub.base, "set_status", { id: onHub.id, status: "done" });
      if (result.isError !== true) {
        throw new Error(`the agent's set_status done was NOT refused: ${toolText(result)}`);
      }
      // The refusal must be the protocol one, not an unrelated error (e.g. a bad id): the tool's own
      // refusal text has to name the feedback rule (PROTOCOL §6), so this cannot pass on a stray error.
      const refusal = toolText(result);
      if (!/feedback|PROTOCOL §6/i.test(refusal)) {
        throw new Error(`set_status was refused, but not for the feedback rule: ${refusal}`);
      }
      const after = await hubNote(hub.base, onHub.id);
      if (after.status === "done") throw new Error("the refused write still changed the status to done");
      return `refused (status stays ${after.status})`;
    });
  } catch (error) {
    if (fatal === null) fatal = { name: "harness", error };
  } finally {
    // Each cleanup is isolated: one failure (e.g. a browser that already died) must not skip the
    // rest. The hub child is always reaped, so a broken browser close cannot hang the event loop.
    if (embedBrowser) {
      try {
        await embedBrowser.close();
      } catch {
        /* best-effort teardown */
      }
    }
    if (extBrowser) {
      try {
        await extBrowser.close();
      } catch {
        /* best-effort teardown */
      }
    }
    try {
      await new Promise((resolve) => staticServer.close(resolve));
    } catch {
      /* best-effort teardown */
    }
    if (hub !== undefined) {
      try {
        await hub.stop();
      } catch {
        /* best-effort teardown */
      }
    }
  }

  /* ---- matrix ---------------------------------------------------------- */

  const width = Math.max(6, ...rows.map((entry) => entry.name.length));
  console.log("");
  console.log(`${"step".padEnd(width)} | ${"embed".padEnd(9)} | extension`);
  console.log(`${"-".repeat(width)}-+-${"-".repeat(9)}-+----------`);
  for (const entry of rows) {
    console.log(`${entry.name.padEnd(width)} | ${entry.embed.padEnd(9)} | ${entry.extension}`);
  }

  if (fatal !== null) {
    console.log(`\nFAIL ${fatal.name}: ${fatal.error?.message ?? fatal.error}`);
    const browser = fatal.name.startsWith("extension") ? extBrowser : embedBrowser;
    if (browser !== undefined && browser !== null) {
      console.log(`  page: ${await browser.snapshot().catch(() => "snapshot failed")}`);
    }
  }

  const failures = rows.filter((entry) => entry.embed === "FAIL" || entry.extension === "FAIL").length;
  console.log(`\nround-trip: ${rows.length - failures}/${rows.length} step(s) clean`);
  if (fatal !== null || failures > 0) process.exit(1);
}

await main();
