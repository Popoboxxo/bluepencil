/**
 * The browser layer shared by the smoke and E2E suites (NFR-11): a dependency-free CDP client over
 * Chrome's **pipe** transport (`--remote-debugging-pipe`: NUL-delimited JSON on fd 3/4). No
 * WebSocket, no npm package — that is what keeps the real-browser legs inside the project's "no
 * runtime dependency" rule (NFR-4) and lets them run on the Node 20 that CI pins.
 *
 *   Browser.launch(executable, userDataDir, { width, height })  → attached page session
 *   browser.navigate(url) / evaluate(expr) / waitFor(expr)      → drive and observe the page
 *   browser.key("l") / click(selector) / type(selector, text)   → real input events, not synthetic
 *   browser.allowDownloads(dir)                                 → let the page save its exports
 *
 * A missing Chrome is *not* an error here: `findChrome()` returns `null` and `requireBrowser()` then
 * throws `Skipped`, which a suite reports as `SKIP` — unless `BP_REQUIRE_BROWSER=1` (CI), where a
 * missing browser must fail rather than silently drop the real-browser round.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * A case that cannot run here (no Chrome) — a skip, not a failure. It is only *reported* as a
 * failure when `BP_REQUIRE_BROWSER=1`, which is what CI sets: a pipeline must not silently drop
 * the real-browser round.
 */
export class Skipped {
  constructor(reason) {
    this.reason = reason;
  }
}

/** Locations worth probing, in order: explicit override, PATH, the CI images, a Playwright cache. */
export function findChrome() {
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
 * Chrome launch policy (issue #18). One attempt with a 20 s attach probe made a runner hiccup into a
 * red check for an unchanged commit; three attempts with a fresh profile each are still fail-closed.
 */
const LAUNCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

/** A key name → the CDP triple Chrome expects for a real key event. */
function keyDescription(key) {
  const named = {
    Enter: { code: "Enter", vk: 13, text: "\r" },
    Escape: { code: "Escape", vk: 27 },
    Tab: { code: "Tab", vk: 9 },
    Backspace: { code: "Backspace", vk: 8 },
    ArrowDown: { code: "ArrowDown", vk: 40 },
    ArrowUp: { code: "ArrowUp", vk: 38 },
    " ": { code: "Space", vk: 32, text: " " },
  };
  if (named[key] !== undefined) return named[key];
  const upper = key.toUpperCase();
  if (/^[A-Z]$/.test(upper)) return { code: `Key${upper}`, vk: upper.charCodeAt(0), text: key };
  if (/^[0-9]$/.test(key)) return { code: `Digit${key}`, vk: key.charCodeAt(0), text: key };
  return { code: key, vk: 0, text: key };
}

export class Browser {
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
      // Input events are routed to the *focused* target: a headless page created via
      // `Target.createTarget` is not focused on its own, so synthesized mouse events would land
      // nowhere while key events still reach the document. Activate it once, up front.
      await browser.send("Target.activateTarget", { targetId: created.targetId }, browser.#session);
      await browser.send("Runtime.enable", {}, browser.#session);
      await browser.send("Page.enable", {}, browser.#session);
      await browser.send("Page.bringToFront", {}, browser.#session).catch(() => {});
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
      `(() => { const api = window.bluepencilAttach ?? window.bluepencil;
                return { api: api ? Object.keys(api).join(",") : "missing",
                         elements: document.querySelectorAll("bluepencil-notes").length,
                         layer: Boolean(document.querySelector("[data-bp-layer], .bp-layer, .bp-bar")),
                         panel: Boolean(document.querySelector(".bp-panel")),
                         notes: document.querySelectorAll(".bp-marker").length,
                         body: document.body.innerHTML.replace(/\\s+/g, " ").slice(0, 200) }; })()`,
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

  /** Waits until `selector` exists (a light helper on top of `waitFor`). */
  async waitForSelector(selector, options = {}) {
    await this.waitFor(`document.querySelector(${JSON.stringify(selector)}) !== null`, options);
    return selector;
  }

  /** Real key events (`Input.dispatchKeyEvent`), so shortcuts and typing behave like a user's. */
  async key(key, { modifiers = 0, count = 1 } = {}) {
    const description = keyDescription(key);
    for (let i = 0; i < count; i += 1) {
      const base = {
        modifiers,
        code: description.code,
        key,
        windowsVirtualKeyCode: description.vk,
        nativeVirtualKeyCode: description.vk,
      };
      await this.send("Input.dispatchKeyEvent", { type: description.text ? "keyDown" : "rawKeyDown", ...base, ...(description.text ? { text: description.text } : {}) }, this.#session);
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, this.#session);
    }
  }

  /** The centre of an element in viewport coordinates — 0 when it is not there (→ a clear failure). */
  async centreOf(selector) {
    const box = await this.evaluate(
      `(() => { const node = document.querySelector(${JSON.stringify(selector)});
                if (!node) return null;
                // A click is only a click where the pointer can reach: bring the node into view first,
                // otherwise the centre is outside the viewport and the event lands on nothing.
                node.scrollIntoView({ block: "center", inline: "center" });
                const rect = node.getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) return { x: -1, y: -1, empty: true };
                return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, empty: false }; })()`,
    );
    if (box === null) throw new Error(`no element for ${selector}`);
    if (box.empty) throw new Error(`element ${selector} has no box (hidden?)`);
    return box;
  }

  /** A real mouse click at the element's centre (not `node.click()` — the layer listens for pointer events). */
  async click(selector, { button = "left" } = {}) {
    const { x, y } = await this.centreOf(selector);
    const base = { x, y, button, clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, this.#session);
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base }, this.#session);
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base }, this.#session);
  }

  /** Focuses a field and inserts text the way a host would (`Input.insertText`). */
  async type(selector, text, { clear = false } = {}) {
    await this.click(selector);
    if (clear) {
      await this.evaluate(
        `(() => { const node = document.querySelector(${JSON.stringify(selector)}); node.value = ""; return true; })()`,
      );
    }
    await this.send("Input.insertText", { text }, this.#session);
  }

  /**
   * Types text with real key events. `Input.insertText` is not in every Chrome build (this one
   * answers `-32601 wasn't found`), and a character dispatched as a key event is what a host user
   * produces anyway — so the fallback is also the more honest path.
   */
  async typeText(text) {
    for (const character of text) {
      if (character === "\n") await this.key("Enter");
      else await this.key(character);
    }
  }

  /** Selects a value and fires `change` — the surface a `<select>` offers to a pointer user. */
  async select(selector, value) {
    await this.evaluate(
      `(() => { const node = document.querySelector(${JSON.stringify(selector)});
                node.value = ${JSON.stringify(value)};
                node.dispatchEvent(new Event("change", { bubbles: true }));
                return node.value; })()`,
    );
  }

  /** Lets the page save its export files into `dir` (the fixture's export buttons are downloads). */
  async allowDownloads(dir) {
    mkdirSync(dir, { recursive: true });
    await this.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, eventsEnabled: true });
  }

  /** Scrolling lives in the page, not the protocol: the layer's marker strategy follows the host. */
  async scrollTo(y) {
    await this.evaluate(`window.scrollTo(0, ${Number(y)})`);
    await new Promise((resolve) => setTimeout(resolve, 120));
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
export function requireBrowser(context) {
  if (!context.browser) {
    throw new Skipped(
      `no usable Chrome (looked at PATH, /usr/bin and the Playwright caches) — set BP_CHROME to point at one`,
    );
  }
}
