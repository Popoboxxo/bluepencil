#!/usr/bin/env node
/**
 * Embed smoke test (FR-17) — drives the built artifacts end to end: the sidecar store
 * (`dist/server.js`), the custom element against a real HTTP API, and the attach loader with a
 * versioned manifest including a runtime version swap.
 *
 * Builds nothing itself (like `size-guard.mjs`): run `npm run build` first. Everything happens in
 * `.tmp/embed-smoke/`; the sidecar listens on a free loopback port and is stopped again.
 *
 *   Leg 1  the sidecar's HTTP contract (CRUD, filters, error codes, environment isolation,
 *          bulk-delete confirm, markdown mirror, canonical store file, corrupt store refuses)
 *   Leg 2  `<bluepencil-notes endpoint="…">` in a jsdom document against that running sidecar
 *   Leg 3  the attach loader: manifest → integrity check → mount → runtime version swap
 *   Leg 4  a real browser (Chrome over the CDP pipe, no dependency) against the *fixture website*:
 *          examples/attach served by the sidecar with `--root`, its own `?selftest=1` probe, the
 *          single-file presentation deck, and a live version swap of the shipped `attach.js`
 *
 * Leg 4 needs a Chrome/Chromium; without one those cases print `SKIP` (legs 1–3 are unaffected).
 * CI sets `BP_REQUIRE_BROWSER=1`, which turns "no browser" into a failure instead of a skip.
 *
 * Each case prints `PASS`/`FAIL`; the exit code is non-zero when any case failed.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(root, "dist/server.js");
const ELEMENT = join(root, "dist/bluepencil.element.min.js");
const WORKSPACE = join(root, ".tmp/embed-smoke");
const BASE_PATH = "/api/v1/bluepencil";

if (!existsSync(SERVER) || !existsSync(ELEMENT)) {
  console.error(`[embed-smoke] missing build artifact — run "npm run build" first (${SERVER}, ${ELEMENT})`);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
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

function blankStore(path) {
  // A valid, empty bundle — the sidecar validates its store strictly (a corrupt one must refuse
  // to start), so "empty" has to be a real document, not a stub.
  const empty = {
    kind: "bluepencil.bundle",
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    exportedBy: "embed-smoke",
    environment: "dev",
    app: { name: "embed-smoke" },
    sessions: [],
    notes: [],
  };
  writeFileSync(path, `${JSON.stringify(empty, null, 2)}\n`, "utf8");
}

/* -------------------------------------------------------------------------- */
/* browser                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A case that cannot run here (no Chrome) — a skip, not a failure. It is only *reported* as a
 * failure when `BP_REQUIRE_BROWSER=1`, which is what CI sets: a pipeline must not silently drop
 * the real-browser round.
 */
class Skipped {
  constructor(reason) {
    this.reason = reason;
  }
}

/** Locations worth probing, in order: explicit override, PATH, the CI images, a Playwright cache. */
function findChrome() {
  const candidates = [];
  if (process.env.BP_CHROME) candidates.push(process.env.BP_CHROME);
  for (const name of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]) {
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
      if (dir) candidates.push(join(dir, name));
    }
  }
  candidates.push(
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/opt/google/chrome/chrome",
  );
  // Playwright's own cache, so the browser round also runs on a dev machine or in a container that
  // already has one (CI installs google-chrome, which the PATH probe above finds first).
  const caches = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.HOME ? join(process.env.HOME, ".cache/ms-playwright") : undefined,
    "/root/.cache/ms-playwright",
    "/opt/data/.playwright",
  ].filter((cache) => cache !== undefined);
  for (const cache of caches) {
    if (!existsSync(cache)) continue;
    for (const entry of readdirSync(cache)) {
      candidates.push(
        join(cache, entry, "chrome-linux64/chrome"),
        join(cache, entry, "chrome-linux/chrome"),
        join(cache, entry, "chrome-linux/headless_shell"),
      );
    }
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * A minimal CDP client over Chrome's **pipe** transport (`--remote-debugging-pipe`: NUL-delimited
 * JSON on fd 3/4). No WebSocket, no npm dependency, works on the Node 20 that CI pins and on the
 * Node the repository is developed with — which is what keeps this leg inside the project's
 * "no runtime dependency" rule (NFR-4).
 */
/**
 * Chrome launch policy (issue #18). One attempt with a 20 s attach probe made a runner hiccup into a
 * red check for an unchanged commit; three attempts with a fresh profile each are still fail-closed.
 */
const LAUNCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

class Browser {
  #pending = new Map();
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #session = null;
  #child;
  #stderr = [];

  constructor(child) {
    this.#child = child;
    child.stdio[3].on("error", () => {});
    child.stdio[4].on("data", (chunk) => this.#onData(chunk));
    child.stdio[2]?.on("data", (chunk) => {
      this.#stderr.push(String(chunk).trim());
      if (this.#stderr.length > 20) this.#stderr.shift();
    });
  }

  static async launch(executable, userDataDir, options = {}) {
    return Browser.#launchWithRetry(executable, userDataDir, LAUNCH_ATTEMPTS, options);
  }

  /**
   * Chrome on a shared CI runner occasionally fails to come up — dbus noise, a leftover profile lock —
   * and the attach probe times out. That is an environment hiccup, not a defect in the layer, but a
   * single attempt turned it into a red check for a green change (issue #18). Each retry uses a fresh
   * profile directory and the whole thing stays fail-closed: after the last attempt the caller fails.
   */
  static async #launchWithRetry(executable, userDataDir, attempts, options = {}) {
    const problems = [];
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const dir = attempt === 1 ? userDataDir : `${userDataDir}-r${attempt}`;
      try {
        return await Browser.#launchOnce(executable, dir, options);
      } catch (error) {
        problems.push(`attempt ${attempt}: ${error.message}`);
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
    const failure = new Error(
      `could not attach to ${executable} after ${attempts} attempts:\n  ${problems.join("\n  ")}`,
    );
    failure.code = "BROWSER_UNAVAILABLE";
    throw failure;
  }

  static async #launchOnce(executable, userDataDir, options = {}) {
    mkdirSync(userDataDir, { recursive: true });
    const child = spawn(
      executable,
      [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        // A real window of a given size is the only way to get a viewport in builds whose pipe session
        // has no `Emulation` domain (the geometry case in issue #4 needs exactly that).
        ...(typeof options.width === "number" && typeof options.height === "number"
          ? [`--window-size=${options.width},${options.height}`]
          : []),
        `--user-data-dir=${userDataDir}`,
        "--remote-debugging-pipe",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
    );
    const browser = new Browser(child);
    try {
      // This Chrome build is single-target in headless mode: `Target.getTargets` answers with an
      // empty list until discovery is on, and `Target.createTarget` is the only way to get a page.
      await browser.send("Target.setDiscoverTargets", { discover: true });
      const created = await browser.send("Target.createTarget", { url: "about:blank" });
      const attached = await browser.send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
      browser.#session = attached.sessionId;
      await browser.send("Runtime.enable", {}, browser.#session);
      await browser.send("Page.enable", {}, browser.#session);
    } catch (error) {
      await browser.close();
      throw new Error(`could not attach to ${executable}: ${error.message}${browser.diagnose()}`);
    }
    return browser;
  }

  /** The last lines Chrome wrote to stderr — the only diagnostic a pipe-only session has. */
  diagnose() {
    return this.#stderr.length === 0 ? "" : `\n  chrome: ${this.#stderr.slice(-3).join("\n  chrome: ")}`;
  }

  #onData(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    let index = this.#buffer.indexOf(0);
    while (index !== -1) {
      const text = this.#buffer.subarray(0, index).toString("utf8");
      this.#buffer = this.#buffer.subarray(index + 1);
      index = this.#buffer.indexOf(0);
      if (text.trim() === "") continue;
      const message = JSON.parse(text);
      const waiter = message.id === undefined ? undefined : this.#pending.get(message.id);
      if (!waiter) continue;
      this.#pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${JSON.stringify(message.error)}`));
      else waiter.resolve(message.result);
    }
  }

  send(method, params = {}, sessionId) {
    const id = this.#nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.#child.stdio[3].write(`${JSON.stringify(payload)}\0`);
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method} timed out after 20 s`));
      }, 20000);
    });
  }

  async navigate(url) {
    await this.send("Page.navigate", { url }, this.#session);
  }

  /** Evaluates an expression in the page and returns its JSON value (promises are awaited). */
  async evaluate(expression) {
    const result = await this.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      this.#session,
    );
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`page exception: ${detail}`);
    }
    return result.result?.value;
  }

  /** A compact page state for a failing wait — the first thing to look at when a case times out. */
  async snapshot() {
    const state = await this.evaluate(
      `(() => { const api = window.bluepencilAttach;
                return { api: api ? Object.keys(api).join(",") : "missing",
                         elements: document.querySelectorAll("bluepencil-notes").length,
                         attach: window.bluepencilAttach ? { version: window.bluepencilAttach.version, src: window.bluepencilAttach.src } : null,
                         probe: window.__probe ?? null,
                         scripts: [...document.scripts].map((s) => s.getAttribute("src") || "inline").join(" "),
                         body: document.body.innerHTML.replace(/\\s+/g, " ").slice(0, 160) }; })()`,
    ).catch((error) => `snapshot failed: ${error.message}`);
    return JSON.stringify(state);
  }

  /** Polls `expression` until it is truthy; a timeout reports what the page last said. */
  async waitFor(expression, { timeoutMs = 20000, intervalMs = 100 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await this.evaluate(expression);
      if (last) return last;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(
      `timed out after ${timeoutMs} ms waiting for ${expression.slice(0, 70)}… (last: ${JSON.stringify(last)})\n  page: ${await this.snapshot()}`,
    );
  }

  async close() {
    try {
      await this.send("Browser.close", {});
    } catch {
      /* the browser is already gone */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    this.#child.kill("SIGKILL");
  }
}

/** The browser cases need a real engine; without one they are skipped (see `Skipped`). */
function requireBrowser(context) {
  if (!context.browser) {
    throw new Skipped(
      `no usable Chrome (looked at PATH, /usr/bin and the Playwright caches) — set BP_CHROME to point at one`,
    );
  }
}

/**
 * Mirrors just enough of the repository layout into the served site directory, so the examples keep
 * their own relative paths (`../../dist/attach.js`) while the sidecar serves page, artifacts and API
 * from one origin — the deployment the contract describes (EMBED.md §4).
 */
function prepareSite(site) {
  for (const relative of [
    "examples/attach/index.html",
    "examples/attach/host.js",
    "examples/presentation/index.html",
    "dist/attach.js",
    "dist/bluepencil.element.min.js",
  ]) {
    const target = join(site, relative);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, relative), target);
  }
}

/** Host page of the runtime-update leg: one script tag, manifest + integrity check + a 1 s poll. */
const UPDATE_PROBE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>bluepencil runtime-update probe</title></head>
<body>
<h1>runtime-update probe</h1>
<script>
  // The loader reports failures as events, never as a thrown error — record them so a failing smoke
  // run shows the reason instead of "nothing was mounted".
  window.__probe = { ready: null, updated: [], errors: [] };
  document.addEventListener("bp-attach-ready", (event) => { window.__probe.ready = event.detail; });
  document.addEventListener("bp-attach-updated", (event) => { window.__probe.updated.push(event.detail); });
  document.addEventListener("bp-attach-error", (event) => {
    window.__probe.errors.push(String((event.detail && event.detail.message) || event.detail));
  });
</script>
<script src="./attach.js"
        data-adapter="localStorage"
        data-language="en"
        data-manifest="./latest.json"
        data-integrity="true"
        data-watch="1"></script>
</body>
</html>
`;

/** Starts the sidecar and waits for its health endpoint; rejects on a non-zero early exit. */
async function startSidecar(options) {
  const port = options.port ?? (await freePort());
  const args = [
    SERVER,
    "--store", options.store,
    "--port", String(port),
    "--host", "127.0.0.1",
    "--environment", options.environment ?? "dev",
  ];
  if (options.root) args.push("--root", options.root);
  if (options.mirror) args.push("--mirror", options.mirror);
  if (options.readOnly) args.push("--read-only");
  if (options.allowEnvMismatch) args.push("--allow-env-mismatch");
  // The smoke runs inside the repository's work tree, where `auto` would commit into the project —
  // so the shared sidecar keeps its history off unless a case asks for a journal explicitly.
  args.push("--journal", options.journal ?? "none");
  for (const extra of options.extra ?? []) args.push(extra);

  const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));

  const deadline = Date.now() + 8000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`sidecar exited with ${child.exitCode}: ${(stderr || stdout).trim().slice(0, 200)}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}${BASE_PATH}/health`);
      if (response.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`sidecar did not become healthy: ${(stderr || stdout).trim().slice(0, 200)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    base: `http://127.0.0.1:${port}${BASE_PATH}`,
    stdout: () => stdout,
    stderr: () => stderr,
    stop() {
      return new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve({ code: child.exitCode, stdout, stderr });
          return;
        }
        child.once("exit", (code) => resolve({ code, stdout, stderr }));
        child.kill("SIGTERM");
      });
    },
  };
}

function request(context, method, path, body, headers = {}) {
  const merged = { Accept: "application/json", ...headers };
  const hasType = Object.keys(merged).some((key) => key.toLowerCase() === "content-type");
  const init = { method, headers: merged };
  if (body !== undefined) {
    if (!hasType) {
      merged["Content-Type"] = "application/json";
    }
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return fetch(`${context.base}${path}`, init);
}

async function json(response) {
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text), text };
  } catch {
    return { status: response.status, body: null, text };
  }
}

function draft(id, overrides = {}) {
  return {
    id,
    type: "text",
    body: `smoke note ${id}`,
    anchor: { hook: `smoke-${id}`, route: "/smoke" },
    author: "embed-smoke",
    source: "tool:test-runner",
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* cases                                                                       */
/* -------------------------------------------------------------------------- */

function cases() {
  return {
    "sidecar: health, create, list, filter, patch, thread": async (ctx) => {
      const health = await json(await request(ctx, "GET", "/health"));
      assert(health.status === 200 && health.body?.ok === true, `health: ${health.status} ${health.text.slice(0, 80)}`);

      const created = await json(await request(ctx, "POST", "/notes", draft("n-case1", { sessionRef: "case-1" })));
      assert(created.status < 300, `create: HTTP ${created.status} ${created.text.slice(0, 120)}`);
      assert(created.body?.note?.id === "n-case1", `create: unexpected payload ${created.text.slice(0, 120)}`);

      const listed = await json(await request(ctx, "GET", "/notes?session=case-1"));
      assert(listed.status === 200 && Array.isArray(listed.body?.notes), `list: ${listed.text.slice(0, 80)}`);
      assert(listed.body.notes.length === 1, `list: expected 1 note, got ${listed.body.notes.length}`);
      assert(listed.body.notes[0].anchor.route === "/smoke", "list: anchor was not persisted");

      const done = await json(await request(ctx, "PATCH", "/notes/n-case1", { status: "done" }));
      assert(done.body?.note?.status === "done", `patch: status is ${done.body?.note?.status}`);

      const hidden = await json(await request(ctx, "GET", "/notes?session=case-1&includeDone=false"));
      assert(hidden.body?.notes?.length === 0, "filter: includeDone=false did not hide the done note");

      const replied = await json(
        await request(ctx, "POST", "/notes/n-case1/messages", {
          id: "m-case1",
          ts: new Date().toISOString(),
          text: "worked off by the embed smoke",
          author: "embed-smoke",
          author_type: "agent",
          kind: "reply",
        }),
      );
      assert(replied.body?.note?.messages?.length === 1, `thread: ${replied.text.slice(0, 120)}`);

      const sessions = await json(await request(ctx, "GET", "/sessions"));
      assert(sessions.status === 200 && Array.isArray(sessions.body?.sessions), `sessions: ${sessions.text.slice(0, 80)}`);
      assert(sessions.body.sessions.some((entry) => entry.ref === "case-1"), "sessions: case-1 missing");
    },

    "sidecar: error contract (422/400/404/405/415)": async (ctx) => {
      const invalid = await json(await request(ctx, "POST", "/notes", { type: "text", body: "" }));
      assert(invalid.status === 400, `invalid note: expected 400, got ${invalid.status}`);
      assert(typeof invalid.body?.error?.message === "string", "invalid note: no error envelope");

      const unknown = await request(ctx, "PATCH", "/notes/does-not-exist", { status: "done" });
      assert(unknown.status === 404, `unknown id: expected 404, got ${unknown.status}`);

      const wrongMethod = await request(ctx, "DELETE", "/notes");
      assert(wrongMethod.status === 405, `wrong method: expected 405, got ${wrongMethod.status}`);
      assert(wrongMethod.headers.get("allow") !== null, "wrong method: no Allow header");

      const wrongType = await request(ctx, "POST", "/notes", "not json at all", { "Content-Type": "text/plain" });
      assert(wrongType.status === 415, `wrong content type: expected 415, got ${wrongType.status}`);

      const broken = await request(ctx, "POST", "/notes", "{oops", { "Content-Type": "application/json" });
      assert(broken.status === 400, `malformed JSON: expected 400, got ${broken.status}`);

      const missing = await request(ctx, "GET", "/nope");
      assert(missing.status === 404, `unknown path: expected 404, got ${missing.status}`);
    },

    "sidecar: environment isolation and bulk delete": async (ctx) => {
      const foreign = await json(await request(ctx, "POST", "/notes", draft("n-live", { environment: "live" })));
      assert(foreign.status === 400, `live note into a dev store: expected 400, got ${foreign.status}`);

      const bulk = await json(await request(ctx, "POST", "/notes", draft("n-bulk", { sessionRef: "case-3" })));
      assert(bulk.status < 300, `bulk fixture: HTTP ${bulk.status}`);

      const unconfirmed = await json(
        await request(ctx, "POST", "/notes/bulk-delete", { filter: { session: "case-3" } }),
      );
      assert(unconfirmed.status === 400, `bulk-delete without confirm: expected 400, got ${unconfirmed.status}`);

      const removed = await json(
        await request(ctx, "POST", "/notes/bulk-delete", { filter: { session: "case-3" }, confirm: true }),
      );
      assert(removed.status === 200 && removed.body?.removed === 1, `bulk-delete: ${removed.text.slice(0, 120)}`);

      const gone = await json(await request(ctx, "GET", "/notes?session=case-3"));
      assert(gone.body?.notes?.length === 0, "bulk-delete: the note is still there");
    },

    "sidecar: canonical store file and markdown mirror": async (ctx) => {
      const store = JSON.parse(readFileSync(ctx.store, "utf8"));
      assert(store.kind === "bluepencil.bundle", `store: kind is ${store.kind}`);
      assert(Array.isArray(store.notes) && store.notes.length >= 1, "store: no notes persisted");
      assert(store.notes.some((note) => note.id === "n-case1"), "store: n-case1 is missing on disk");

      assert(existsSync(ctx.mirror), `mirror: ${ctx.mirror} does not exist`);
      const markdown = readFileSync(ctx.mirror, "utf8");
      assert(markdown.includes("smoke note n-case1"), "mirror: the note body is missing");
      assert(markdown.includes("case-1"), "mirror: the session is missing");
    },

    "sidecar: a corrupt store refuses to start": async () => {
      const dir = join(WORKSPACE, "corrupt");
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const store = join(dir, "broken.json");
      writeFileSync(store, "{ this is not a bundle", "utf8");
      const port = await freePort();
      const result = await new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          [SERVER, "--store", store, "--port", String(port), "--host", "127.0.0.1"],
          { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
        );
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += String(chunk)));
        setTimeout(() => child.kill("SIGKILL"), 6000);
        child.on("exit", (code) => resolve({ code, stderr }));
      });
      assert(result.code !== 0, "a corrupt store must not start (exit 0)");
      const lines = result.stderr.trimEnd().split("\n").filter((line) => line !== "");
      assert(lines.length >= 1 && lines.length <= 3, `corrupt store: expected a short error, got ${lines.length} lines`);
      assert(!/\n\s+at /.test(result.stderr), "corrupt store: the error printed a stack trace");
      assert(/not valid|unreadable|corrupt|JSON/i.test(result.stderr), `corrupt store: unclear message ${JSON.stringify(result.stderr.slice(0, 160))}`);
    },

    "sidecar: the journal records the history (file backend)": async (ctx) => {
      const dir = join(WORKSPACE, "journal-file");
      mkdirSync(dir, { recursive: true });
      const store = join(dir, "store.json");
      blankStore(store);
      const server = await startSidecar({
        store,
        environment: "dev",
        extra: ["--journal-dir", dir],
        journal: "file",
      });
      try {
        const created = await json(
          await request({ base: server.base }, "POST", "/notes", draft("n-j1", { sessionRef: "journal-1" })),
        );
        assert(created.status === 200, `POST /notes → ${created.status}: ${created.text.slice(0, 120)}`);

        const history = await json(await request({ base: server.base }, "GET", "/journal"));
        assert(history.status === 200, `GET /journal → ${history.status}: ${history.text.slice(0, 120)}`);
        assert(history.body.journal?.backend === "file", `backend is ${history.body.journal?.backend}`);
        assert(history.body.journal.entries >= 1, "the mutation was not recorded");
        const entry = history.body.entries?.[0];
        assert(entry?.seq === 1, `first entry seq is ${entry?.seq}`);
        assert(/^[0-9a-f]{64}$/.test(entry?.hash ?? ""), `entry hash is not a sha256: ${entry?.hash}`);
        assert(
          String(entry?.summary ?? "").includes("n-j1"),
          `the summary does not name the note: ${entry?.summary}`,
        );

        // The chain is verifiable on disk, and `since` is what an agent needs.
        const journalFile = readFileSync(join(dir, "journal.jsonl"), "utf8").trimEnd().split("\n");
        assert(journalFile.length === 1, `expected one journal line, got ${journalFile.length}`);
        const since = await json(await request({ base: server.base }, "GET", "/journal?since=1"));
        assert(since.body.entries.length === 0, "since=1 must not repeat the first entry");
      } finally {
        await server.stop();
      }
    },

    "sidecar: the journal commits inside a git work tree": async (ctx) => {
      const repo = join(WORKSPACE, "journal-git");
      mkdirSync(repo, { recursive: true });
      const git = (args) => {
        const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
        assert(result.status === 0, `git ${args.join(" ")} → ${result.stderr}`);
        return result.stdout;
      };
      git(["init", "-q"]);
      git(["config", "user.name", "embed smoke"]);
      git(["config", "user.email", "smoke@example.invalid"]);
      const store = join(repo, "store.json");
      blankStore(store);
      git(["add", "store.json"]);
      git(["commit", "-q", "-m", "init"]);

      const server = await startSidecar({
        store,
        environment: "dev",
        journal: "git", // the store lives in this throwaway repository
        extra: ["--journal-coalesce", "0"],
      });
      try {
        const created = await json(
          await request({ base: server.base }, "POST", "/notes", draft("n-j2", { sessionRef: "journal-2" })),
        );
        assert(created.status === 200, `POST /notes → ${created.status}`);
        const log = git(["log", "--format=%s", "-n", "2"]).trim().split("\n");
        assert(log.length === 2, `expected a new commit, the log has ${log.length} entries`);
        assert(/change\(s\)|note/i.test(log[0]), `unexpected subject: ${log[0]}`);
        const status = await json(await request({ base: server.base }, "GET", "/journal"));
        assert(status.body.journal.backend === "git", `backend is ${status.body.journal.backend}`);
        assert(status.body.journal.entries === 1, `expected one commit from this run, got ${status.body.journal.entries}`);
      } finally {
        await server.stop();
      }
    },

    "element: endpoint attribute talks to the running sidecar": async (ctx) => {
      const dom = new JSDOM(`<!doctype html><html><body><h1>host app</h1></body></html>`, {
        url: `${ctx.origin}/host`,
        pretendToBeVisual: true,
      });
      const { window } = dom;
      for (const key of [
        "window", "document", "HTMLElement", "customElements", "Node", "Element", "Event", "CustomEvent",
        "MutationObserver", "localStorage", "location", "getComputedStyle", "requestAnimationFrame",
        "cancelAnimationFrame", "CSS", "DOMParser", "ResizeObserver",
      ]) {
        if (window[key] === undefined) continue;
        try {
          Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
        } catch {
          /* read-only host global — not needed here */
        }
      }

      // A fresh module instance per jsdom window: a browser document always re-executes the
      // module, Node's module cache would keep the first window's registry otherwise.
      await import(`${pathToFileURL(ELEMENT).href}?scope=element`);
      const element = window.document.createElement("bluepencil-notes");
      element.setAttribute("endpoint", ctx.base);
      element.setAttribute("environment", "dev");
      window.document.body.append(element);
      const elementErrors = [];
      element.addEventListener("bp-error", (event) => elementErrors.push(String(event.detail?.message ?? event.detail)));

      try {
        await element.blueprint.store.create({ ...draft("n-case6", { sessionRef: "case-6" }) });
        const reloaded = await element.blueprint.store.list({ session: "case-6" });
        assert(reloaded.length === 1, `element: expected the note back from the API, got ${reloaded.length}`);
        assert(reloaded[0].body === "smoke note n-case6", `element: unexpected body ${reloaded[0].body}`);

        const onDisk = JSON.parse(readFileSync(ctx.store, "utf8"));
        assert(
          onDisk.notes.some((note) => note.id === "n-case6"),
          "element: the note did not reach the store file on disk",
        );
        assert(elementErrors.length === 0, `element: reported ${elementErrors.join(" | ")}`);
      } finally {
        element.destroy?.();
        element.remove();
        dom.window.close();
      }
    },

    "attach: manifest, integrity check and runtime version swap": async (ctx) => {
      // A versioned hosting layout served by the same sidecar: /bluepencil/<version>/… + latest.json
      const bpDir = join(ctx.site, "bluepencil");
      const v1 = join(bpDir, "0.9.0");
      const v2 = join(bpDir, "0.9.1");
      mkdirSync(v1, { recursive: true });
      mkdirSync(v2, { recursive: true });
      copyFileSync(ELEMENT, join(v1, "bluepencil.element.min.js"));
      copyFileSync(ELEMENT, join(v2, "bluepencil.element.min.js"));
      const digest = sha256(readFileSync(join(v1, "bluepencil.element.min.js")));
      writeFileSync(
        join(bpDir, "latest.json"),
        JSON.stringify({ version: "0.9.0", element: "/bluepencil/0.9.0/bluepencil.element.min.js", sha256: digest }),
        "utf8",
      );

      const dom = new JSDOM(`<!doctype html><html><body><div id="mount"></div></body></html>`, {
        url: `${ctx.origin}/deck`,
        pretendToBeVisual: true,
      });
      const { window } = dom;
      for (const key of ["window", "document", "HTMLElement", "customElements", "Event", "CustomEvent", "MutationObserver"]) {
        if (window[key] === undefined) continue;
        try {
          Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
        } catch {
          /* ignore */
        }
      }

      const { attach } = await import(pathToFileURL(join(root, "dist/attach.esm.js")).href);
      const updates = [];
      window.document.addEventListener("bp-attach-updated", (event) => updates.push(event.detail));

      // The module loader is injected (jsdom cannot execute ES modules); everything else — the
      // manifest fetch, the digest check, the mount and the swap — is the real code path.
      const importModule = async (url) => {
        const file = join(bpDir, url.includes("0.9.1") ? "0.9.1" : "0.9.0", "bluepencil.element.min.js");
        await import(pathToFileURL(file).href);
      };

      const handle = await attach({
        scriptUrl: `${ctx.origin}/bluepencil/attach.js`,
        manifest: `${ctx.base.replace(BASE_PATH, "")}/bluepencil/latest.json`,
        integrity: true,
        watchSeconds: 0,
        tag: "bluepencil-notes",
        auto: true,
        attributes: { adapter: "localStorage", language: "de", mount: "#mount" },
        deps: { document: window.document, importModule },
      });

      try {
        assert(handle.version === "0.9.0", `attach: version is ${handle.version}`);
        const first = window.document.querySelector("bluepencil-notes");
        assert(first !== null, "attach: nothing was mounted");
        assert(first.getAttribute("attach-version") === "0.9.0", "attach: attach-version is wrong");
        assert(window.document.querySelector("#mount bluepencil-notes") !== null, "attach: mount selector ignored");

        // A wrong digest must be refused before anything is executed.
        writeFileSync(
          join(bpDir, "latest.json"),
          JSON.stringify({ version: "0.9.1", element: "/bluepencil/0.9.1/bluepencil.element.min.js", sha256: "ab".repeat(32) }),
          "utf8",
        );
        let refused = false;
        try {
          await handle.check();
        } catch (error) {
          refused = true;
          assert(/integrity check failed/.test(String(error)), `attach: unexpected error ${String(error)}`);
        }
        assert(refused, "attach: a wrong digest was not refused");

        // The real update: same file, correct digest, new version.
        const digest2 = sha256(readFileSync(join(v2, "bluepencil.element.min.js")));
        writeFileSync(
          join(bpDir, "latest.json"),
          JSON.stringify({ version: "0.9.1", element: "/bluepencil/0.9.1/bluepencil.element.min.js", sha256: digest2 }),
          "utf8",
        );
        assert((await handle.check()) === true, "attach: the version change was not applied");
        assert(handle.version === "0.9.1", `attach: version is ${handle.version} after the swap`);
        assert(updates.length === 1 && updates[0].to === "0.9.1", "attach: no bp-attach-updated event");
        const elements = window.document.querySelectorAll("bluepencil-notes");
        assert(elements.length === 1, `attach: expected exactly one mounted element, got ${elements.length}`);
        assert(elements[0].getAttribute("attach-version") === "0.9.1", "attach: the swapped element is not the new version");

        assert((await handle.check()) === false, "attach: an unchanged manifest must not swap again");
      } finally {
        handle.destroy();
        dom.window.close();
      }
    },

    "attach: read-only presentation mode (no backend)": async () => {
      const dom = new JSDOM(`<!doctype html><html><body></body></html>`, {
        url: "https://deck.example/slides",
        pretendToBeVisual: true,
      });
      const { window } = dom;
      for (const key of ["window", "document", "HTMLElement", "customElements", "Event", "CustomEvent", "MutationObserver", "localStorage"]) {
        if (window[key] === undefined) continue;
        try {
          Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
        } catch {
          /* ignore */
        }
      }
      const { attach } = await import(pathToFileURL(join(root, "dist/attach.esm.js")).href);
      const handle = await attach({
        scriptUrl: "https://cdn.example/bluepencil/attach.js",
        integrity: false,
        watchSeconds: 0,
        tag: "bluepencil-notes",
        auto: true,
        attributes: { adapter: "localStorage", language: "de", "theme-accent": "#8c3b2e" },
        deps: {
          document: window.document,
          importModule: async () => import(`${pathToFileURL(ELEMENT).href}?scope=presentation`),
        },
      });
      try {
        const element = window.document.querySelector("bluepencil-notes");
        assert(element !== null, "presentation: nothing was mounted");
        assert(window.document.querySelectorAll("style[data-bp-styles]").length === 1, "presentation: the layer styles are missing");
        assert(element.getAttribute("theme-accent") === "#8c3b2e", "presentation: the theme attribute was not forwarded");
      } finally {
        handle.destroy();
        dom.window.close();
      }
    },
    // ---------------------------------------------------------------- real browser -------------

    /**
     * The fixture host app (examples/attach) served by the sidecar through `--root`: one origin for
     * the page, the artifacts and the API. The page's own probe (`?selftest=1`) asserts the host-side
     * contract; this case asserts the probe passed *and* that the note it wrote is in the API and on
     * disk, so nothing about the round trip stays inside the page.
     */
    "browser: fixture host app, attach contract end to end": async (ctx) => {
      requireBrowser(ctx);
      prepareSite(ctx.site);
      await ctx.browser.navigate(`${ctx.origin}/examples/attach/?selftest=1`);
      const probe = await ctx.browser.waitFor(
        `(() => { const pre = document.getElementById("bp-selftest");
                  return pre === null ? null : { status: pre.getAttribute("data-status"), count: pre.getAttribute("data-count"), text: pre.textContent }; })()`,
      );
      assert(
        probe.status === "pass",
        `the host probe reported "${probe.status}":\n${String(probe.text).split("\n").map((line) => `    ${line}`).join("\n")}`,
      );

      const listed = await json(await request(ctx, "GET", "/notes?session=attach-fixture"));
      assert(listed.status === 200, `GET /notes → HTTP ${listed.status}: ${listed.text.slice(0, 120)}`);
      assert(
        listed.body.notes.length >= 1,
        "the API does not list the note the page created over HTTP",
      );
      const persisted = JSON.parse(readFileSync(ctx.store, "utf8"));
      assert(
        persisted.notes.some((note) => note.sessionRef === "attach-fixture"),
        "the note never reached the store file the sidecar owns",
      );
      return `${probe.count} host probe check(s), ${listed.body.notes.length} note(s) in the API`;
    },

    /** The single-file presentation deck: no backend, no build step, still a real mount. */
    "browser: presentation deck mounts with no backend": async (ctx) => {
      requireBrowser(ctx);
      prepareSite(ctx.site);
      await ctx.browser.navigate(`${ctx.origin}/examples/presentation/`);
      const state = await ctx.browser.waitFor(
        `(() => { const api = window.bluepencilAttach; const el = document.querySelector("bluepencil-notes");
                  if (!api || !el) return null;
                  return { version: api.version, instances: api.instances.length,
                           src: el.getAttribute("attach-src"), adapter: el.getAttribute("adapter"),
                           language: el.getAttribute("language"),
                           styles: document.querySelectorAll("style[data-bp-styles]").length,
                           slides: document.querySelectorAll(".slide").length }; })()`,
      );
      assert(state.instances === 1, `expected exactly one mounted element, got ${state.instances}`);
      assert(state.styles === 1, `expected exactly one layer style node, got ${state.styles}`);
      assert(state.adapter === "localStorage", `adapter attribute not forwarded: ${state.adapter}`);
      assert(state.language === "de", `language attribute not forwarded: ${state.language}`);
      assert(state.slides === 3, `expected the deck's three slides, got ${state.slides}`);
      assert(/bluepencil\.element\.min\.js$/.test(state.src), `unexpected element build: ${state.src}`);
      return `version=${state.version}, ${state.slides} slides`;
    },

    /**
     * The layer's own chrome is geometry — and geometry cannot be asserted in jsdom, where every rect
     * is zero. This case measures the real thing across the viewport matrix from issue #4: no chrome
     * surface may scroll sideways (NFR-20), two visible surfaces may not overlap (FR-12.10), and on a
     * narrow viewport the strip yields to its handle (FR-12.13).
     */
    "browser: chrome geometry across the viewport matrix": async (ctx) => {
      requireBrowser(ctx);
      prepareSite(ctx.site);

      const viewports = [
        { width: 360, height: 740, narrow: true },
        { width: 390, height: 844, narrow: true },
        { width: 768, height: 1024, narrow: false },
        { width: 1024, height: 768, narrow: false },
        { width: 1280, height: 800, narrow: false },
        { width: 1440, height: 900, narrow: false },
      ];
      const PROBE = `(() => {
        const names = ["bar", "handle", "mode-hint"];
        const read = (name) => {
          const node = document.querySelector('[data-bp-part="' + name + '"]');
          if (node === null) return null;
          const style = getComputedStyle(node);
          if (style.display === "none" || style.visibility === "hidden") return null;
          const box = node.getBoundingClientRect();
          return { name: name, x: box.x, y: box.y, width: box.width, height: box.height,
                   scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
                   viewportWidth: window.innerWidth };
        };
        const root = document.querySelector(".bp-root");
        return { dock: root === null ? null : root.getAttribute("data-bp-dock"),
                 surfaces: names.map(read).filter((entry) => entry !== null) };
      })()`;
      const overlapArea = (a, b) => {
        const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        return width > 0 && height > 0 ? Math.round(width * height) : 0;
      };

      /**
       * One measurement = one real window of that size. This Chrome build's pipe session has no
       * `Emulation` domain at all, and a real viewport is the better measurement anyway.
       */
      const measure = async (viewport) => {
        const browser = await Browser.launch(
          ctx.browserPath,
          join(WORKSPACE, `chrome-profile-${viewport.width}`),
          { width: viewport.width, height: viewport.height },
        );
        try {
          await browser.navigate(`${ctx.origin}/examples/attach/?selftest=1`);
          await browser.waitFor(`document.querySelector('[data-bp-part="bar"]') !== null`);
          // A mode makes the third chrome surface visible, so the overlap check has something to check.
          await browser.evaluate(
            `(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true })); return true; })()`,
          );
          await new Promise((resolve) => setTimeout(resolve, 300));
          return await browser.evaluate(PROBE);
        } finally {
          await browser.close();
        }
      };

      const measurements = [];
      const problems = [];
      {
        for (const viewport of viewports) {
          const report = await measure(viewport);
          assert(report !== null && typeof report === "object", `no measurement at ${viewport.width} px`);
          const names = report.surfaces.map((surface) => surface.name);
          measurements.push(`${viewport.width}px: ${names.length === 0 ? "none" : names.join("+")}`);

          for (const surface of report.surfaces) {
            if (surface.scrollWidth > surface.clientWidth + 1) {
              problems.push(
                `${viewport.width}px: ${surface.name} scrolls sideways (${surface.scrollWidth} > ${surface.clientWidth})`,
              );
            }
            if (surface.x < -1 || surface.x + surface.width > surface.viewportWidth + 1) {
              problems.push(
                `${viewport.width}px: ${surface.name} leaves the viewport (x ${Math.round(surface.x)}, ` +
                  `w ${Math.round(surface.width)}, vw ${surface.viewportWidth})`,
              );
            }
            if (surface.width <= 0 || surface.height <= 0) {
              problems.push(
                `${viewport.width}px: ${surface.name} has no box (${Math.round(surface.width)}×${Math.round(surface.height)})`,
              );
            }
          }
          for (let i = 0; i < report.surfaces.length; i += 1) {
            for (let j = i + 1; j < report.surfaces.length; j += 1) {
              const area = overlapArea(report.surfaces[i], report.surfaces[j]);
              if (area > 0) {
                problems.push(
                  `${viewport.width}px: ${report.surfaces[i].name} and ${report.surfaces[j].name} overlap (${area} px²)`,
                );
              }
            }
          }
          if (viewport.narrow) {
            if (names.includes("bar")) {
              problems.push(`${viewport.width}px: the strip is still shown on a narrow viewport`);
            }
            if (!names.includes("handle")) {
              problems.push(`${viewport.width}px: no handle to take over from the strip`);
            }
          } else if (!names.includes("bar")) {
            problems.push(`${viewport.width}px: the strip is missing on a wide viewport`);
          }
        }
      }

      assert(
        problems.length === 0,
        `chrome geometry:\n${problems.map((line) => `    ${line}`).join("\n")}`,
      );
      return `${viewports.length} viewports — ${measurements.join(", ")}`;
    },

    /**
     * The runtime-update path with the real script tag (contract §2, verification leg 3): a versioned
     * hosting layout, a manifest pointer, an integrity check against the served build, a live version
     * change while the page stays open — and no leftover layer afterwards.
     */
    "browser: runtime version swap of the real loader": async (ctx) => {
      requireBrowser(ctx);
      const bp = join(ctx.site, "bluepencil");
      const versions = ["0.9.0", "0.9.1"];
      for (const version of versions) {
        mkdirSync(join(bp, version), { recursive: true });
        copyFileSync(ELEMENT, join(bp, version, "bluepencil.element.min.js"));
      }
      copyFileSync(join(root, "dist/attach.js"), join(bp, "attach.js"));
      writeFileSync(join(bp, "probe.html"), UPDATE_PROBE_HTML, "utf8");
      const pointer = (version) =>
        JSON.stringify({
          version,
          element: `/bluepencil/${version}/bluepencil.element.min.js`,
          sha256: sha256(readFileSync(join(bp, version, "bluepencil.element.min.js"))),
        });
      writeFileSync(join(bp, "latest.json"), pointer(versions[0]), "utf8");

      await ctx.browser.navigate(`${ctx.origin}/bluepencil/probe.html`);
      const first = await ctx.browser.waitFor(
        `(() => { const el = document.querySelector("bluepencil-notes"); return el === null ? null : el.getAttribute("attach-version"); })()`,
      );
      assert(first === versions[0], `the manifest version was not mounted first (got ${first})`);

      // Tag the node and watch the event: after the swap it has to be a *new* element (teardown +
      // remount), not the same node with a rewritten attribute.
      await ctx.browser.evaluate(
        `(() => { document.querySelector("bluepencil-notes").dataset.smokeTag = "old";
                  window.__updates = [];
                  document.addEventListener("bp-attach-updated", (event) => window.__updates.push(event.detail));
                  return true; })()`,
      );

      writeFileSync(join(bp, "latest.json"), pointer(versions[1]), "utf8");
      const state = await ctx.browser.waitFor(
        `(() => { const el = document.querySelector("bluepencil-notes");
                  if (!el || el.getAttribute("attach-version") !== "0.9.1") return null;
                  return { version: window.bluepencilAttach.version,
                           instances: window.bluepencilAttach.instances.length,
                           elements: document.querySelectorAll("bluepencil-notes").length,
                           tag: el.dataset.smokeTag ?? "", updates: window.__updates }; })()`,
      );
      assert(state.version === versions[1], `the published version is ${state.version}`);
      assert(state.instances === 1 && state.elements === 1, "the swap left a second layer behind");
      assert(state.tag === "", "the old element was re-stamped instead of torn down and remounted");
      assert(
        state.updates.length === 1 && state.updates[0].from === versions[0] && state.updates[0].to === versions[1],
        `expected exactly one bp-attach-updated event {${versions[0]} → ${versions[1]}}, got ${JSON.stringify(state.updates)}`,
      );
      return `${versions[0]} → ${state.version} (integrity checked, one event)`;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* run                                                                         */
/* -------------------------------------------------------------------------- */

function setUpWorkspace() {
  rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });
  const site = join(WORKSPACE, "site");
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, "index.html"), "<!doctype html><title>smoke</title><h1>smoke</h1>\n", "utf8");
  const store = join(WORKSPACE, "store.json");
  blankStore(store);
  return {
    site,
    store,
    mirror: join(WORKSPACE, "notes.md"),
    parent: join(WORKSPACE, "parent.json"),
  };
}

async function main() {
  const workspace = setUpWorkspace();
  const server = await startSidecar({
    store: workspace.store,
    root: workspace.site,
    mirror: workspace.mirror,
    environment: "dev",
  });
  const context = { ...workspace, ...server, browser: null, browserPath: findChrome() };
  // CI sets this: the real-browser round is the only leg that exercises the shipped `attach.js`
  // as a script tag, so a pipeline must fail when it cannot run rather than skip quietly.
  const browserRequired = process.env.BP_REQUIRE_BROWSER === "1";

  let failed = 0;
  let total = 0;
  let browser = null;
  try {
    if (context.browserPath === null) {
      console.log(`browser: none found — the real-browser cases are skipped (set BP_CHROME to point at one)`);
    } else {
      try {
        browser = await Browser.launch(context.browserPath, join(WORKSPACE, "chrome-profile"));
        context.browser = browser;
        console.log(`browser: ${context.browserPath}`);
      } catch (error) {
        const code = error?.code === "BROWSER_UNAVAILABLE" ? "BROWSER-UNAVAILABLE" : "BROWSER-START-FAILED";
        console.log(`browser: ${code} — could not start ${context.browserPath}\n${error.message}`);
      }
    }
    if (context.browser === null && browserRequired) {
      total += 1;
      failed += 1;
      // Deliberately still a failure: the real-browser round is the only leg that loads the shipped
      // `attach.js` as a script tag. But it says so in a way a reader can tell apart from a failed
      // assertion, without opening the log (issue #18).
      console.log(
        "FAIL BROWSER-UNAVAILABLE (no assertion ran, the environment had no usable Chrome): " +
          "BP_REQUIRE_BROWSER=1",
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
    if (browser !== null) {
      await browser.close();
    }
    const stopped = await server.stop();
    if (stopped.code !== 0 && stopped.code !== null) {
      console.log(`FAIL sidecar shutdown: exit ${stopped.code} ${stopped.stderr.slice(0, 200)}`);
      failed += 1;
      total += 1;
    }
  }

  console.log(`embed-smoke: ${total - failed}/${total} case(s) passed in ${WORKSPACE}`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
