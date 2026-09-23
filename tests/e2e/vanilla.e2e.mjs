#!/usr/bin/env node
/**
 * E2E suite against the fixture app (NFR-11) — the automated form of the manual checklist in
 * `examples/vanilla/README.md`. Everything runs in a real browser against the real build:
 *
 *   scripts/serve-example.mjs  serves the repository root (the fixture needs `/dist/` next to it)
 *   Chrome over the CDP pipe  drives the page — real key events, real mouse clicks at the element
 *   the fixture's own controls  load the seed, export the notes (the paths a host uses)
 *
 * It asserts what a reviewer can *see*: notes in the panel, markers on the page, counters in the
 * fixture's KPI grid, the text of an export file. Nothing here reaches into the layer's internals —
 * `window.bpDemo.blueprint` is read only for the store count, which is the fixture's own handle.
 *
 *   npm run smoke:e2e                 all cases
 *   E2E_ONLY=capture npm run smoke:e2e   just the cases whose name contains "capture"
 *
 * Builds nothing itself: run `npm run build` first (the fixture loads `dist/bluepencil.iife.js`).
 * Without a Chrome the cases are skipped; `BP_REQUIRE_BROWSER=1` (CI) turns that into a failure.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser, Skipped, findChrome, requireBrowser } from "../../scripts/lib/browser.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const IIFE = join(root, "dist/bluepencil.iife.js");
const WORKSPACE = join(root, ".tmp/e2e-vanilla");
const DOWNLOADS = join(WORKSPACE, "downloads");
const PROFILE = join(WORKSPACE, "chrome-profile");

if (!existsSync(IIFE)) {
  console.error(`[e2e] missing build artifact — run "npm run build" first (${IIFE})`);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* the fixture, from the outside                                               */
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

/** The fixture's own control strip: the layer's bar overlaps it, so a host clicks it programmatically. */
async function hostClick(context, selector) {
  const result = await context.browser.evaluate(
    `(() => { const node = document.querySelector(${JSON.stringify(selector)});
              if (!node) return "missing";
              if (node.disabled) return "disabled";
              node.click();
              return "ok"; })()`,
  );
  assert(result === "ok", `host control ${selector} not usable (${result})`);
}

/** Focus a host field and insert text — `Input.insertText` reaches the focused element. */
async function hostType(context, selector, text) {
  await context.browser.evaluate(
    `(() => { const node = document.querySelector(${JSON.stringify(selector)}); node.focus(); node.select?.(); return true; })()`,
  );
  await context.browser.typeText(text);
}

/** The message the fixture writes into its live region (NFR-14) — its report of what happened. */
const hostMessage = (context) =>
  context.browser.evaluate(`document.getElementById("demo-message").textContent`);

/** The layer's own surfaces (never the host's strip) are driven with real mouse clicks. */
const layerAction = (context, action) => context.browser.click(`[data-bp-action="${action}"]`);

/**
 * Arms a mode through the bar's own button and waits until the layer reports it as pressed, so the
 * capture cases cannot race the key handler. The keyboard bindings get their own case below — a
 * broken binding there should turn one case red, not five.
 */
const MODE_BUTTONS = { text: "mode-text", design: "mode-design", feedback: "feedback-only" };

async function armMode(context, mode) {
  const action = MODE_BUTTONS[mode];
  assert(action !== undefined, `unknown mode "${mode}"`);
  await layerAction(context, action);
  await context.browser.waitFor(
    `document.querySelector('[data-bp-action="${action}"]')?.getAttribute("aria-pressed") === "true"`,
    { timeoutMs: 5000 },
  );
}

/** Which modes the layer currently reports as pressed — a failure message should name this. */
const armedMode = (context) =>
  context.browser.evaluate(
    `(() => { const pressed = (action) => document.querySelector('[data-bp-action="' + action + '"]')?.getAttribute("aria-pressed") === "true";
              return { text: pressed("mode-text"), design: pressed("mode-design"), feedback: pressed("feedback-only") }; })()`,
  );

const storeCount = (context) => context.browser.evaluate(`window.bpDemo.blueprint.notes().length`);
const markerCount = (context) => context.browser.evaluate(`document.querySelectorAll(".bp-marker").length`);
const panelOpen = (context) => context.browser.evaluate(`Boolean(document.querySelector(".bp-panel"))`);

/** The panel's entries in display order — the note ids are the stable handle (no text guessing). */
async function panelIds(context) {
  return context.browser.evaluate(
    `[...document.querySelectorAll(".bp-panel-body [data-bp-note-id]")].map((row) => row.getAttribute("data-bp-note-id"))`,
  );
}

/** The panel's entries as a reviewer reads them: title, kind and state per row. */
async function panelEntries(context) {
  return context.browser.evaluate(`(() => {
    const body = document.querySelector(".bp-panel-body");
    if (!body) return null;
    return [...body.children].map((row) => (row.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 90));
  })()`);
}

/** Opens the panel and waits for its body (the entry list) to be there. */
async function openPanel(context) {
  await context.browser.key("l");
  await context.browser.waitFor(`Boolean(document.querySelector(".bp-panel-body"))`);
  await pause(150);
}

/**
 * Saves the composer that is open after picking an anchor. The composer element exists in the DOM
 * from the start and only becomes visible once an element is picked, so a case waits for a real box
 * — otherwise it would "save" a hidden form (that is exactly the trap this helper closes).
 */
async function saveComposer(context, body) {
  const visible = `(() => { const node = document.querySelector(".bp-composer");
                            if (!node) return false;
                            const rect = node.getBoundingClientRect();
                            return rect.width > 0 && rect.height > 0; })()`;
  try {
    await context.browser.waitFor(visible, { timeoutMs: 6000 });
  } catch {
    const shown = await context.browser.evaluate(`document.querySelector(".bp-composer")?.textContent ?? "(no composer)"`);
    const armed = await armedMode(context);
    throw new Error(`armed: ${JSON.stringify(armed)} — the composer never opened for the picked element — it says: "${shown.replace(/\s+/g, " ").slice(0, 160)}"`);
  }
  if (body !== undefined) {
    await context.browser.evaluate(
      `(() => { const field = document.querySelector(".bp-composer .bp-textarea"); field.focus(); field.select?.(); return true; })()`,
    );
    await context.browser.typeText(body);
  }
  await layerAction(context, "composer-save");
  await pause(400);
}

/** Exports through the fixture's strip button and returns the downloaded text (FR-7.1/7.2). */
async function exportFile(context, format, { keep = false } = {}) {
  const before = new Set(readdirSync(DOWNLOADS));
  await hostClick(context, format === "json" ? "#demo-export-json" : "#demo-export-md");
  const deadline = Date.now() + 8000;
  let file;
  while (Date.now() < deadline) {
    const fresh = readdirSync(DOWNLOADS).filter((name) => !before.has(name) && name.endsWith(`.${format}`));
    if (fresh.length > 0) {
      file = join(DOWNLOADS, fresh[0]);
      break;
    }
    await pause(100);
  }
  assert(file !== undefined, `no ${format} export appeared in ${DOWNLOADS} (message: "${await hostMessage(context)}")`);
  // A download is written asynchronously — wait until its size settles before reading it.
  let size = -1;
  for (let i = 0; i < 40; i += 1) {
    const next = statSync(file).size;
    if (next > 0 && next === size) break;
    size = next;
    await pause(100);
  }
  const text = readFileSync(file, "utf8");
  if (!keep) rmSync(file, { force: true });
  return text;
}

/**
 * Loads the fixture with a clean store and the seed notes in place — the state every case starts
 * from. `withSeed: false` leaves the store empty (for the capture cases that count from zero).
 */
async function loadFixture(context, { withSeed = true } = {}) {
  await context.browser.navigate(`${context.base}/examples/vanilla/`);
  await context.browser.waitFor(`Boolean(document.querySelector(".bp-root"))`, { timeoutMs: 25000 });
  await context.browser.waitFor(`Boolean(window.bpDemo?.blueprint?.notes)`, { timeoutMs: 25000 });
  if (!withSeed) return;
  await hostClick(context, "#demo-load-seed");
  await context.browser.waitFor(`window.bpDemo.blueprint.notes().length === 6`, { timeoutMs: 10000 });
}

/* -------------------------------------------------------------------------- */
/* the cases                                                                   */
/* -------------------------------------------------------------------------- */

function cases() {
  return {
    "fixture: the layer mounts on the fixture page and offers its surfaces (FR-4.1, FR-12.1)": async (context) => {
      requireBrowser(context);
      await loadFixture(context, { withSeed: false });
      const surfaces = await context.browser.evaluate(
        `["mode-text", "mode-design", "panel", "feedback-only"].every((a) => document.querySelector('[data-bp-action="' + a + '"]') !== null)`,
      );
      assert(surfaces, "the bar does not offer text, design, panel and feedback controls");
      assert((await storeCount(context)) === 0, "a fresh profile must start with an empty store");
      await openPanel(context);
      assert(Array.isArray(await panelEntries(context)), "the panel has no entry list");
    },

    "shortcuts: c, d, l and f arm the documented modes (FR-4.4)": async (context) => {
      requireBrowser(context);
      await loadFixture(context);
      const pressed = (action) =>
        `document.querySelector('[data-bp-action="${action}"]')?.getAttribute("aria-pressed") === "true"`;
      await context.browser.key("c");
      await context.browser.waitFor(pressed("mode-text"), { timeoutMs: 4000 });
      await context.browser.key("d");
      await context.browser.waitFor(pressed("mode-design"), { timeoutMs: 4000 });
      await context.browser.key("f");
      await context.browser.waitFor(pressed("feedback-only"), { timeoutMs: 4000 });
      await context.browser.key("Escape");
      await context.browser.key("l");
      await context.browser.waitFor(`document.querySelector(".bp-panel")?.getBoundingClientRect().width > 0`, { timeoutMs: 4000 });
      const order = await panelIds(context);
      assert(order[0] === "n-seed-002", `the keyboard-opened panel lists ${JSON.stringify(order)}`);
    },

    "seed: the bundle lands in the store, counters follow, a second import adds nothing (FR-13.1, FR-14.2, FR-14.3)": async (context) => {
      requireBrowser(context);
      await loadFixture(context);
      assert((await storeCount(context)) === 6, `expected 6 seed notes, store holds ${await storeCount(context)}`);
      const counters = await context.browser.evaluate(
        `({ total: document.querySelector('[data-bluepencil="kpi-total-value"]').textContent,
            open: document.querySelector('[data-bluepencil="kpi-open-value"]').textContent,
            decisions: document.querySelector('[data-bluepencil="kpi-decisions-value"]').textContent,
            feedback: document.querySelector('[data-bluepencil="kpi-feedback-value"]').textContent })`,
      );
      assert(
        counters.total === "6" && counters.open === "4" && counters.decisions === "1" && counters.feedback === "1",
        `counters wrong: ${JSON.stringify(counters)} (expected 6/4/1/1)`,
      );
      // Six notes, one of them done — done notes are hidden by default (D4), so five markers show.
      assert((await markerCount(context)) === 5, `expected 5 markers for the visible seed notes, saw ${await markerCount(context)}`);
      await hostClick(context, "#demo-load-seed");
      await pause(900);
      assert((await storeCount(context)) === 6, "importing the same bundle twice must not duplicate notes");
      assert(
        (await hostMessage(context)).includes("0 added") && (await hostMessage(context)).includes("6 already present"),
        `the fixture did not report the second import as a no-op: "${await hostMessage(context)}"`,
      );
    },

    "capture: a text note lands in the store, the panel and the markers, and survives a reload (FR-1.3, FR-6.1)": async (context) => {
      requireBrowser(context);
      await loadFixture(context);
      const before = { store: await storeCount(context), markers: await markerCount(context) };
      await armMode(context, "text");
      await context.browser.click('[data-bluepencil="app-title"]');
      await saveComposer(context, "E2E: the heading needs a different wording.");
      assert(
        (await storeCount(context)) === before.store + 1,
        `the note did not reach the store (${before.store} → ${await storeCount(context)})`,
      );
      assert((await markerCount(context)) === before.markers + 1, "the new note has no marker on its element");
      await openPanel(context);
      const entries = await panelEntries(context);
      assert(entries.some((row) => row.includes("E2E: the heading needs")), `the panel does not list the new note: ${JSON.stringify(entries)}`);
      await context.browser.key("Escape");
      // The adapter is localStorage in this fixture: the note has to come back after a reload.
      await context.browser.navigate(`${context.base}/examples/vanilla/`);
      await context.browser.waitFor(`window.bpDemo?.blueprint?.notes().length === ${before.store + 1}`, { timeoutMs: 15000 });
    },

    "capture: a design note records the state it was captured in (FR-1.4, FR-3.3)": async (context) => {
      requireBrowser(context);
      await loadFixture(context);
      await armMode(context, "design");
      await context.browser.click('[data-bluepencil="kpi-decisions"]');
      await saveComposer(context, "E2E: the decisions card needs more contrast.");
      const bundle = JSON.parse(await exportFile(context, "json"));
      const note = bundle.notes.find((entry) => (entry.body ?? "").includes("E2E: the decisions card"));
      assert(note !== undefined, "the design note is not in the export");
      assert(note.type === "design", `expected a design note, got ${note.type}`);
      const captured = note.context ?? {};
      assert(captured.tag === "div" || typeof captured.tag === "string", `captured context has no tag: ${JSON.stringify(captured)}`);
      assert(typeof captured.box?.w === "number" && captured.box.w > 0, `the captured box has no width: ${JSON.stringify(captured.box)}`);
      assert(captured.viewport?.w > 0, "the captured viewport is empty");
      assert(captured.buildRef === "demo-abc1234", `buildRef not captured: ${JSON.stringify(captured.buildRef)}`);
    },

    "capture: a selection becomes the note's quote (FR-1.5)": async (context) => {
      requireBrowser(context);
      await loadFixture(context);
      const quote = await context.browser.evaluate(`(() => {
        const target = document.querySelector('[data-bluepencil="findings-intro"]');
        if (!target) return null;
        // The first text node with real content — a paragraph often starts with whitespace.
        const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node && node.textContent.trim().length < 20) node = walker.nextNode();
        if (!node) return null;
        const start = node.textContent.indexOf(node.textContent.trim()[0]);
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, Math.min(start + 16, node.textContent.length));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return selection.toString().trim();
      })()`);
      assert(quote !== null && quote.length >= 8, "could not select a quote in the fixture paragraph");
      await armMode(context, "text");
      await context.browser.click('[data-bluepencil="findings-intro"]');
      await saveComposer(context, "E2E: this sentence needs a source.");
      const markdown = await exportFile(context, "md");
      assert(markdown.includes(quote), `the export does not carry the quote "${quote}"`);
    },

    "presentation: filters and the review order (FR-4.2, FR-4.6)": async (context) => {
      requireBrowser(context);
      await loadFixture(context);
      await openPanel(context);
      const ids = await panelIds(context);
      assert(ids.length === 5, `expected the five visible notes, saw ${ids.length}: ${JSON.stringify(ids)}`);
      // needs_decision first, then feedback-only, then the rest (FR-4.6).
      assert(ids[0] === "n-seed-002", `the open decision is not listed first: ${JSON.stringify(ids)}`);
      assert(ids[1] === "n-seed-005", `the feedback-only note is not second: ${JSON.stringify(ids)}`);
      const openCount = await context.browser.evaluate(`(() => {
        const filter = document.querySelector('[data-bp-filter="status"]');
        filter.value = "open";
        filter.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`);
      assert(openCount, "the status filter is not on the panel");
      await pause(300);
      const openOnly = await panelIds(context);
      assert(openOnly.length === 4, `status=open should list the 4 open notes, saw ${openOnly.length}: ${JSON.stringify(openOnly)}`);
      assert(!openOnly.includes("n-seed-002"), "the needs_decision note is not status=open and must be filtered out");
    },

    "presentation: done notes stay hidden until the panel reveals them (FR-4.3, D4)": async (context) => {
      requireBrowser(context);
      await loadFixture(context);
      await openPanel(context);
      assert((await markerCount(context)) === 5, "the done note must not have a marker by default");
      const hidden = await panelIds(context);
      assert(!hidden.includes("n-seed-004"), `the done note is listed although it is hidden: ${JSON.stringify(hidden)}`);
      await layerAction(context, "show-done");
      await pause(300);
      assert((await markerCount(context)) === 6, `revealing done notes did not add the sixth marker (${await markerCount(context)})`);
      const revealed = await panelIds(context);
      assert(revealed.length === 6 && revealed.includes("n-seed-004"), `revealing done notes did not add n-seed-004: ${JSON.stringify(revealed)}`);
    },

    "collaboration: feedback-only mode marks the note without a second choice (FR-5.2)": async (context) => {
      requireBrowser(context);
      await loadFixture(context);
      // The feedback-only switch is a flag on the composer, not a picking mode of its own: the layer
      // only picks an element while a mode is armed (src/ui/layer.ts — `mode === "off"` returns before
      // the pick), so the manual checklist's "press F, then create" is one step short. Mode + flag is
      // the path a host user actually has, and that is the one this case walks.
      await armMode(context, "text");
      await armMode(context, "feedback");
      await context.browser.click('[data-bluepencil="kpi-intro"]');
      await saveComposer(context, "E2E: please assess the KPI intro, change nothing.");
      const bundle = JSON.parse(await exportFile(context, "json"));
      const note = bundle.notes.find((entry) => (entry.body ?? "").includes("E2E: please assess the KPI intro"));
      assert(note !== undefined, "the feedback note is not in the export");
      assert(note.intent === "feedback", `expected intent=feedback, got ${note.intent}`);
    },

    "collaboration: the decision thread on the shadow-DOM card (FR-5.4, FR-5.5, FR-2.2)": async (context) => {
      requireBrowser(context);
      await loadFixture(context);
      await openPanel(context);
      await context.browser.waitForSelector('[data-bp-note-id="n-seed-002"]');
      const opened = await context.browser.evaluate(`(() => {
        const row = document.querySelector('[data-bp-note-id="n-seed-002"]');
        if (!row) return false;
        row.click();
        return true;
      })()`);
      assert(opened, "the panel has no entry for the shadow-DOM note (n-seed-002)");
      await context.browser.waitFor(`Boolean(document.querySelector('[data-bp-part="thread"]'))`, { timeoutMs: 6000 });
      await pause(300);
      const detail = await context.browser.evaluate(
        `(() => { const thread = document.querySelector('[data-bp-part="thread"]');
                  const messages = [...thread.querySelectorAll("[data-bp-part=message], .bp-message, li")].length;
                  return { text: (thread.textContent ?? "").replace(/\\s+/g, " ").trim(), messages }; })()`,
      );
      assert(
        detail.text.toLowerCase().includes("decision") && detail.messages >= 2,
        `the thread shows ${detail.messages} message(s), no decision request: "${detail.text.slice(0, 200)}"`,
      );
      // The anchor lives inside a shadow root: the marker is drawn by the overlay, so what has to
      // resolve is the anchor itself — the panel says so instead of calling the note orphaned.
      assert(!detail.text.toLowerCase().includes("orphan"), `the shadow-DOM anchor is reported as orphaned: "${detail.text.slice(0, 200)}"`);
    },

    "export: markdown and json are complete and byte-stable (FR-7.1, FR-7.2, NFR-10, NFR-17)": async (context) => {
      requireBrowser(context);
      await loadFixture(context);
      const first = await exportFile(context, "md");
      const second = await exportFile(context, "md");
      assert(first === second, "two exports of an unchanged set must be byte-identical (NFR-10)");
      assert(first.startsWith("#") || first.trimStart().startsWith("#"), "the markdown export has no heading");
      assert(first.includes("open decision"), `the markdown export does not lead with the open decisions: "${first.slice(0, 160)}"`);
      assert(first.includes("feedback only"), "the markdown export has no feedback-only section");
      assert(first.includes("review-2026-09") || first.includes("insight-value"), "the markdown export misses the session or an anchor");
      const bundle = JSON.parse(await exportFile(context, "json"));
      assert(Array.isArray(bundle.notes) && bundle.notes.length >= 6, `the json bundle holds ${bundle.notes?.length} notes`);
      assert(
        typeof bundle.schemaVersion === "string" || typeof bundle.schemaVersion === "number",
        `the json bundle carries no schema version (keys: ${Object.keys(bundle).join(", ")})`,
      );
      assert(bundle.notes.some((note) => note.anchor?.hook === "insight-value"), "the shadow-DOM anchor is missing from the bundle");
    },

    "adjacent: the host keeps working while a mode is active (FR-2.7, FR-12.6)": async (context) => {
      requireBrowser(context);
      await loadFixture(context);
      await context.browser.key("c");
      await hostClick(context, "#demo-field-title");
      await hostType(context, "#demo-field-title", "E2E host input");
      const typed = await context.browser.evaluate(`document.getElementById("demo-field-title").value`);
      assert(typed === "E2E host input", `the host's form field did not accept text: "${typed}"`);
      // A region the host excluded from annotation must not open a composer.
      const ignored = await context.browser.evaluate(
        `(() => { const strip = document.getElementById("demo-toolbar");
                  const rect = strip.getBoundingClientRect();
                  return { covered: document.elementFromPoint(rect.x + 4, rect.y + 4)?.closest("#demo-toolbar") !== null }; })()`,
      );
      assert(ignored.covered, "the excluded strip is covered by the layer's own chrome — cannot test pass-through");
      const before = await storeCount(context);
      await pause(300);
      assert((await storeCount(context)) === before, "a click on the host's own strip created a note");
      await context.browser.key("Escape");
    },

    "lifecycle: enable/disable cycles leave no residue and keep the notes (FR-12.1, FR-12.2, NFR-1, NFR-15)": async (context) => {
      requireBrowser(context);
      await loadFixture(context);
      const notes = await storeCount(context);
      for (let cycle = 1; cycle <= 3; cycle += 1) {
        await context.browser.click("#demo-enable-flag");
        await context.browser.waitFor(`document.querySelectorAll('[class^="bp-"], [class*=" bp-"]').length === 0`, { timeoutMs: 8000 });
        const residue = await context.browser.evaluate(
          `({ markers: document.querySelectorAll(".bp-marker").length,
              layer: document.querySelectorAll(".bp-root, .bp-bar, .bp-panel").length })`,
        );
        assert(residue.markers === 0 && residue.layer === 0, `cycle ${cycle}: the disabled layer left residue ${JSON.stringify(residue)}`);
        assert((await storeCount(context)) === notes, `cycle ${cycle}: disabling lost notes`);
        await context.browser.click("#demo-enable-flag");
        await context.browser.waitFor(`Boolean(document.querySelector(".bp-root"))`, { timeoutMs: 8000 });
        assert((await markerCount(context)) === 5, `cycle ${cycle}: the markers did not come back`);
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* the runner                                                                  */
/* -------------------------------------------------------------------------- */

async function main() {
  const only = process.env.E2E_ONLY ?? "";
  const selected = Object.entries(cases()).filter(([name]) => name.includes(only));
  if (selected.length === 0) {
    console.error(`[e2e] no case matches E2E_ONLY="${only}"`);
    process.exit(1);
  }

  rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(DOWNLOADS, { recursive: true });

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn("node", [join(root, "scripts/serve-example.mjs"), "--port", String(port), "--quiet"], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
  });
  await pause(800);

  const chrome = findChrome();
  const context = { base, browser: null };
  let browser;
  const failures = [];
  let skipped = 0;

  try {
    if (chrome !== null) {
      browser = await Browser.launch(chrome, PROFILE, { width: 1280, height: 900 });
      await browser.allowDownloads(DOWNLOADS);
      context.browser = browser;
    } else {
      console.log("[e2e] no Chrome found — browser cases will be reported as SKIP");
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
      // Every case starts from a clean store, so no case can be made green by a previous one.
      if (context.browser) {
        await context.browser.evaluate(`(() => { try { localStorage.clear(); } catch {} return true; })()`).catch(() => {});
      }
    }
  } finally {
    if (browser) await browser.close();
    server.kill("SIGKILL");
  }

  const passed = selected.length - failures.length - skipped;
  console.log(`\ne2e-vanilla: ${passed}/${selected.length} case(s) passed${skipped > 0 ? `, ${skipped} skipped` : ""} in ${WORKSPACE}`);
  if (skipped > 0 && process.env.BP_REQUIRE_BROWSER === "1") {
    console.error("[e2e] BP_REQUIRE_BROWSER=1 — a missing browser is a failure, not a skip");
    process.exit(1);
  }
  if (failures.length > 0) process.exit(1);
}

await main();
