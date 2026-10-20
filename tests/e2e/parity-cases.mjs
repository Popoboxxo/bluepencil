/**
 * Shared cases for the functional-parity harness (tests/e2e/parity.e2e.mjs).
 *
 * One list of `CASES`, run unchanged against two *different ways of mounting the same layer on the
 * same fixture DOM* — the one-tag embed loader and the MV3 extension. Each case drives the real UI
 * or the element's documented API, returns a plain observation, and the harness compares the two
 * observations after `normalize()` has removed everything that is volatile by construction (ids,
 * timestamps, port numbers).
 *
 * A case is not a unit test of the layer: it is a claim that "however the layer arrived, it behaves
 * the same". The comparison lives in the runner; the assertions here only reject an observation that
 * is not even well-formed (so a broken side fails red instead of comparing two `null`s).
 *
 * This module has no imports and no I/O: it is pure harness code, shared by both strands.
 */

/** The fixture's stable anchor targets (see examples/parity/page.html). */
export const TITLE_TARGET = '[data-testid="parity-title"]';
export const BODY_TARGET = '[data-testid="parity-body"]';
export const CARD_TARGET = '[data-testid="parity-card"]';
/** A real host control: a plain click must stay the host's, Alt+click is the layer's (FR-1.15). */
export const BUTTON_TARGET = '[data-testid="parity-button"]';
/** A design-only target (no text content): a feature capture must fall back to design (FR-1.14). */
export const EMPTY_TARGET = '[data-testid="parity-empty"]';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------------------- */
/* normalize — strip everything that differs by construction, keep the shape    */
/* -------------------------------------------------------------------------- */

/**
 * Keys whose *value* is generated, so dropping them keeps a comparison honest while a divergence
 * in the surrounding shape still shows. `id`/`createdAt`/`updatedAt`/`ts` are the note model's own
 * volatile fields; `exportedAt` is the bundle's.
 */
const VOLATILE_KEYS = new Set(["id", "createdAt", "updatedAt", "ts", "exportedAt"]);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g;
// Note/message/session ids the model mints (`n-<uuid>` / `m-<uuid>` / `s-<uuid>`), plus the compact
// fallback form (`n-<base36>-<counter>-<rand>`).
const PREFIXED_ID = /\b([nms])-[a-z0-9][a-z0-9-]{5,}\b/gi;

/** Scrubs one string: timestamps, generated ids and the loopback port a strand happens to use. */
function normalizeString(value) {
  return value
    .replace(ISO, "<ts>")
    .replace(UUID, "<id>")
    .replace(PREFIXED_ID, "$1-<id>")
    .replace(/(https?:\/\/[^/\s"'<>]+?):\d+/g, "$1:<port>");
}

/**
 * Recursively normalise a value so two runs can be compared.
 *
 * - volatile object keys are dropped (and the rest of the object is kept — a missing field still
 *   shows as a divergence);
 * - object keys are sorted, so key order never matters;
 * - strings have timestamps, generated ids and ports scrubbed;
 * - arrays keep their order: the note set is order-independent in principle, but the harness runs
 *   the same cases in the same order, so a reordering is worth seeing.
 */
export function normalize(value) {
  if (typeof value === "string") return normalizeString(value);
  if (Array.isArray(value)) return value.map((entry) => normalize(entry));
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (VOLATILE_KEYS.has(key)) continue;
      out[key] = normalize(value[key]);
    }
    return out;
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* UI/API helpers — the real paths a host user or a host script would take      */
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

/** The layer's own report of a bar toggle's pressed state. */
const pressedExpr = (action) =>
  `document.querySelector('[data-bp-action="${action}"]')?.getAttribute('aria-pressed') === 'true'`;

/**
 * Puts a bar toggle into the wanted state and waits until the layer reports it.
 *
 * The bar's toggles are *switches*: clicking an already-pressed mode turns it off
 * (`setMode(mode === "text" ? "off" : "text")` in src/ui/layer.ts). Unlike the vanilla suite —
 * which reloads the fixture between cases — every case here shares one page, so a mode left armed
 * by an earlier case would be silently disarmed by the next one's `armMode`. Reading the state
 * first keeps the arming idempotent without weakening the assertion: after the call the layer must
 * still report the toggle in the wanted state.
 */
async function setPressed(browser, action, desired) {
  const expr = pressedExpr(action);
  if ((await browser.evaluate(expr)) !== desired) {
    await browser.click(`[data-bp-action="${action}"]`);
  }
  await browser.waitFor(`(${expr}) === ${desired}`, { timeoutMs: 5000 });
}

/** Arms a mode through the bar's own button and waits until the layer reports it pressed. */
async function armMode(browser, action) {
  await setPressed(browser, action, true);
}

/** The store's synchronous view of the note set — the documented element API, not internals. */
const notesOf = (browser) =>
  browser.evaluate(`document.querySelector('bluepencil-notes').blueprint.store.notes()`);

/** The layer's reported mode (`data-bp-mode` on its root) — `off` when nothing is armed. */
const modeOf = (browser) =>
  browser.evaluate(`document.querySelector('[data-bp-part="root"]')?.getAttribute('data-bp-mode') ?? null`);

/**
 * Leaves the page with no capture mode armed.
 *
 * Every case shares one document, so a case that toggles a mode cannot assume where the previous
 * one stopped. `Escape` is the layer's own documented cancel (and also closes its surfaces first),
 * so this stays on the public path instead of poking at internal state.
 */
async function ensureModeOff(browser) {
  const composerWasOpen = await composerIsOpen(browser);
  if (composerWasOpen || (await modeOf(browser)) !== "off") {
    await browser.key("Escape");
  }
  await browser.waitFor(
    `document.querySelector('[data-bp-part="root"]')?.getAttribute('data-bp-mode') === 'off'`,
    { timeoutMs: 5000 },
  );
}

/** Whether the composer surface is currently shown (not merely present in the DOM). */
const composerIsOpen = (browser) =>
  browser.evaluate(`(() => { const n = document.querySelector('.bp-composer'); return Boolean(n) && !n.hidden; })()`);

/** Waits until a layer surface (`settings`, `legend`, ...) is shown. */
async function surfaceOpen(browser, part) {
  await browser.waitFor(
    `(() => { const n = document.querySelector('[data-bp-part="${part}"]'); if (!n || n.hidden) return false;
              const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`,
    { timeoutMs: 8000 },
  );
}

/** Waits until a layer surface is hidden again. */
async function surfaceClosed(browser, part) {
  await browser.waitFor(`document.querySelector('[data-bp-part="${part}"]')?.hidden === true`, {
    timeoutMs: 5000,
  });
}

/** Clicks a checkbox setting until it reports the wanted state (real mouse click, native change). */
async function setCheckbox(browser, setting, desired) {
  const expr = `document.querySelector('[data-bp-setting="${setting}"]')?.checked === true`;
  if ((await browser.evaluate(expr)) !== desired) {
    await browser.click(`[data-bp-setting="${setting}"]`);
  }
  await browser.waitFor(`(${expr}) === ${desired}`, { timeoutMs: 5000 });
}

/**
 * Presses one of the composer's optional grade buttons (severity for a bug, priority for a feature)
 * while the composer is open, and waits until the layer reports it pressed.
 *
 * The row is hidden for the other note type, so this also proves the preset actually selected the
 * matching type: a hidden button has no box and cannot be clicked.
 */
async function chooseComposerGrade(browser, action) {
  await browser.waitFor(
    `(() => { const b = document.querySelector('[data-bp-action="${action}"]');
              if (!b || b.closest('[hidden]')) return false;
              const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`,
    { timeoutMs: 5000 },
  );
  await browser.click(`[data-bp-action="${action}"]`);
  await browser.waitFor(
    `document.querySelector('[data-bp-action="${action}"]')?.getAttribute('aria-pressed') === 'true'`,
    { timeoutMs: 5000 },
  );
}

/**
 * Types the body into the open composer and saves it (real mouse click on the save button).
 *
 * `choices` is additive: `priority` / `severity` are the optional grades a feature or a bug may
 * carry (FR-3.6/3.7), set while the composer is open — never for the other note type, so a wrong
 * preset fails instead of silently dropping the value.
 */
async function saveComposer(browser, body, { priority, severity } = {}) {
  try {
    await browser.waitFor(
      `(() => { const n = document.querySelector('.bp-composer'); if (!n) return false;
                const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`,
      { timeoutMs: 8000 },
    );
  } catch (error) {
    const diag = await browser.evaluate(`(() => {
      const title = document.querySelector('[data-testid="parity-title"]');
      const r = title ? title.getBoundingClientRect() : null;
      const at = r ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
      return {
        composerExists: Boolean(document.querySelector('.bp-composer')),
        mode: document.querySelector('[data-bp-part="root"]')?.getAttribute('data-bp-mode'),
        pressed: [...document.querySelectorAll('[data-bp-action^="mode-"]')].map((b) => b.getAttribute('data-bp-action') + '=' + b.getAttribute('aria-pressed')),
        titleRect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
        atPoint: at ? (at.tagName + '.' + at.className + '#' + at.id) : null,
        atClosestBp: at ? Boolean(at.closest('[data-bp-part]')) : null,
      };
    })()`);
    throw new Error(`composer never opened: ${JSON.stringify(diag)}`);
  }
  if (severity !== undefined) await chooseComposerGrade(browser, `composer-severity-${severity}`);
  if (priority !== undefined) await chooseComposerGrade(browser, `composer-priority-${priority}`);
  await browser.evaluate(
    `(() => { const f = document.querySelector('.bp-composer .bp-textarea');
              if (!f) return false; f.focus(); f.select?.(); return true; })()`,
  );
  await browser.typeText(body);
  await browser.click('[data-bp-action="composer-save"]');
  await pause(400);
}

/**
 * Creates one note through the real capture path: arm a mode, click the target, fill the composer,
 * save. Returns the note the store holds afterwards (matched by body), or `null`.
 *
 * `priority` / `severity` are optional and additive: they pick the composer's grade for the note
 * type the mode produced (feature → priority, bug → severity) right before saving.
 */
async function createNote(
  browser,
  { target, body, mode = "text", feedback = false, priority, severity },
) {
  const before = (await notesOf(browser)).length;
  await armMode(browser, `mode-${mode}`);
  // `feedback-only` is a flag armed *in addition to* a mode (there is no `mode-feedback`). It is set
  // to match this note's intent explicitly — not left however the previous case happened to leave it.
  await setPressed(browser, "feedback-only", feedback);
  if (process.env.PARITY_DEBUG) {
    const g = await browser.evaluate(`(() => {
      const bar = document.querySelector('.bp-bar');
      const t = document.querySelector('[data-testid="parity-title"]');
      const br = bar ? bar.getBoundingClientRect() : null;
      const tr = t ? t.getBoundingClientRect() : null;
      return { bar: br ? [Math.round(br.x), Math.round(br.y), Math.round(br.width), Math.round(br.height)] : null,
               title: tr ? [Math.round(tr.x), Math.round(tr.y), Math.round(tr.width), Math.round(tr.height)] : null,
               lang: document.querySelector('bluepencil-notes')?.getAttribute('language'),
               viewport: [window.innerWidth, window.innerHeight] };
    })()`);
    console.log(`    [debug ${mode}] ${JSON.stringify(g)}`);
  }
  await browser.click(target);
  await saveComposer(browser, body, { priority, severity });
  await browser.waitFor(
    `document.querySelector('bluepencil-notes').blueprint.store.notes().length === ${before + 1}`,
    { timeoutMs: 8000 },
  );
  const notes = await notesOf(browser);
  const matches = notes.filter((note) => String(note.body ?? "").includes(body));
  return matches[matches.length - 1] ?? null;
}

/* -------------------------------------------------------------------------- */
/* the cases                                                                    */
/* -------------------------------------------------------------------------- */

export const CASES = [
  {
    name: "layer-mounted",
    async probe(browser) {
      await layerReady(browser);
      const elements = await browser.evaluate(`document.querySelectorAll('bluepencil-notes').length`);
      const bars = await browser.evaluate(`document.querySelectorAll('.bp-bar').length`);
      if (elements !== 1) throw new Error(`expected exactly one <bluepencil-notes>, found ${elements}`);
      if (bars !== 1) throw new Error(`expected exactly one .bp-bar, found ${bars}`);
      return { elements, bars };
    },
  },

  {
    name: "capture-anchor",
    async probe(browser) {
      await layerReady(browser);
      const note = await createNote(browser, { target: TITLE_TARGET, body: "parity: anchor probe" });
      if (note === null) throw new Error("the captured note is not in the store");
      const anchor = note.anchor ?? {};
      if (anchor.hook !== "parity-title") {
        throw new Error(`anchor hook is ${JSON.stringify(anchor.hook)}, expected "parity-title"`);
      }
      if (typeof anchor.selector !== "string" || anchor.selector === "") {
        throw new Error(`anchor has no selector: ${JSON.stringify(anchor)}`);
      }
      return {
        kind: note.type,
        intent: note.intent,
        hook: anchor.hook,
        selector: anchor.selector,
        route: anchor.route,
        orphaned: anchor.orphaned ?? false,
      };
    },
  },

  {
    name: "note-fields",
    async probe(browser) {
      await layerReady(browser);
      const note = await createNote(browser, {
        target: BODY_TARGET,
        body: "parity: field probe",
        mode: "text",
        feedback: true,
      });
      if (note === null) throw new Error("the feedback note is not in the store");
      if (note.intent !== "feedback") throw new Error(`expected intent=feedback, got ${note.intent}`);
      return {
        type: note.type,
        intent: note.intent,
        status: note.status,
        authorType: note.authorType,
        source: note.source,
        environment: note.environment,
        schemaVersion: note.schemaVersion,
        context: note.context,
        threadLength: Array.isArray(note.messages) ? note.messages.length : null,
      };
    },
  },

  {
    name: "design-context",
    async probe(browser) {
      await layerReady(browser);
      const note = await createNote(browser, { target: CARD_TARGET, body: "parity: design probe", mode: "design" });
      if (note === null) throw new Error("the design note is not in the store");
      const ctx = note.context;
      return {
        type: note.type,
        hasContext: ctx !== null && typeof ctx === "object",
        tag: ctx?.tag ?? null,
        // Only the stable shape of the capture, never raw pixels: the layout is identical on both
        // sides, but a sub-pixel rounding difference must not be reported as a behavioural one.
        boxPositive: (ctx?.box?.w ?? 0) > 0 && (ctx?.box?.h ?? 0) > 0,
        viewportPositive: (ctx?.viewport?.w ?? 0) > 0,
        stylesIsObject: ctx != null && typeof ctx.styles === "object" && ctx.styles !== null,
      };
    },
  },

  {
    name: "export-canonical",
    async probe(browser) {
      await layerReady(browser);
      // Self-sufficient: the case creates the note it exports, so a broken earlier case cannot fail
      // it too, and the exported shape is compared to something this run built rather than to
      // whatever the shared page happened to accumulate. The export is still the real, full bundle.
      const created = await createNote(browser, { target: BODY_TARGET, body: "parity: export probe" });
      if (created === null) throw new Error("the export probe note is not in the store");
      const raw = await browser.evaluate(
        `document.querySelector('bluepencil-notes').exportNotes('json')`,
      );
      if (typeof raw !== "string" || raw.trim() === "") {
        throw new Error("exportNotes('json') returned nothing");
      }
      const bundle = JSON.parse(raw);
      if (bundle.kind !== "bluepencil.bundle") throw new Error(`bundle kind is ${JSON.stringify(bundle.kind)}`);
      if (typeof bundle.schemaVersion !== "number") throw new Error("bundle carries no schemaVersion");
      if (!Array.isArray(bundle.notes)) throw new Error("bundle carries no notes array");
      // The bundle is the store's own set, measured in the same strand: an export that dropped or
      // invented a note fails here rather than at the comparison step.
      const storeCount = await browser.evaluate(
        `document.querySelector('bluepencil-notes').blueprint.store.notes().length`,
      );
      if (bundle.notes.length !== storeCount) {
        throw new Error(`the bundle holds ${bundle.notes.length} notes, the store holds ${storeCount}`);
      }
      const exported = bundle.notes.find((entry) => String(entry.body ?? "").includes("parity: export probe"));
      if (exported === undefined) throw new Error("the note this case created is not in the bundle");
      if (exported.id !== created.id) throw new Error("the bundle's matching note is a different one");
      if (exported.type !== created.type) {
        throw new Error(`the exported note changed type: ${exported.type} vs ${created.type}`);
      }
      if (exported.anchor?.hook !== "parity-body") {
        throw new Error(`the exported note lost its anchor hook: ${JSON.stringify(exported.anchor)}`);
      }
      return {
        kind: bundle.kind,
        schemaVersion: bundle.schemaVersion,
        note: {
          type: exported.type,
          body: exported.body,
          hook: exported.anchor?.hook ?? null,
          hasSelector: typeof exported.anchor?.selector === "string" && exported.anchor.selector !== "",
        },
      };
    },
  },

  /* ------------------------------------------------------------------------ */
  /* capture modes, grades, alt-click and the version surface (FR-1.13-1.15,   */
  /* FR-3.7, FR-4.9/4.10)                                                      */
  /* ------------------------------------------------------------------------ */

  {
    name: "shortcuts-bug-feature",
    async probe(browser) {
      await layerReady(browser);
      await ensureModeOff(browser);
      const bugPressed = () => browser.evaluate(pressedExpr("mode-bug"));
      const featurePressed = () => browser.evaluate(pressedExpr("mode-feature"));

      // `i` arms the bug preset, a second `i` disarms it again (the bar's toggles are switches).
      await browser.key("i");
      await browser.waitFor(`(${pressedExpr("mode-bug")}) === true`, { timeoutMs: 5000 });
      const bugOn = await bugPressed();
      const bugMode = await modeOf(browser);
      await browser.key("i");
      await browser.waitFor(`(${pressedExpr("mode-bug")}) === false`, { timeoutMs: 5000 });
      const bugOff = await bugPressed();
      const offMode = await modeOf(browser);

      // The same contract for `n` and the feature preset.
      await browser.key("n");
      await browser.waitFor(`(${pressedExpr("mode-feature")}) === true`, { timeoutMs: 5000 });
      const featureOn = await featurePressed();
      const featureMode = await modeOf(browser);
      await browser.key("n");
      await browser.waitFor(`(${pressedExpr("mode-feature")}) === false`, { timeoutMs: 5000 });
      const featureOff = await featurePressed();
      const endMode = await modeOf(browser);

      if (bugOn !== true || bugMode !== "bug") {
        throw new Error(`"i" did not arm the bug mode: pressed=${bugOn} mode=${bugMode}`);
      }
      if (bugOff !== false || offMode !== "off") {
        throw new Error(`a second "i" did not disarm the bug mode: pressed=${bugOff} mode=${offMode}`);
      }
      if (featureOn !== true || featureMode !== "feature") {
        throw new Error(`"n" did not arm the feature mode: pressed=${featureOn} mode=${featureMode}`);
      }
      if (featureOff !== false || endMode !== "off") {
        throw new Error(`a second "n" did not disarm the feature mode: pressed=${featureOff} mode=${endMode}`);
      }
      return { bugOn, bugOff, featureOn, featureOff, endMode };
    },
  },

  {
    name: "capture-bug-preset",
    async probe(browser) {
      await layerReady(browser);
      // FR-1.13: a bug always carries the captured design state, even on a text element.
      const note = await createNote(browser, {
        target: TITLE_TARGET,
        body: "parity: bug probe",
        mode: "bug",
      });
      if (note === null) throw new Error("the bug note is not in the store");
      if (note.type !== "bug") throw new Error(`expected type=bug, got ${JSON.stringify(note.type)}`);
      if (note.context === null || typeof note.context !== "object") {
        throw new Error(`the bug note carries no captured context: ${JSON.stringify(note.context)}`);
      }
      return { type: note.type, hasContext: true, tag: note.context?.tag ?? null };
    },
  },

  {
    name: "capture-feature-hybrid-text",
    async probe(browser) {
      await layerReady(browser);
      // FR-1.14: a feature on a text target is the wording case — no captured state, plus the
      // optional priority (FR-3.7) chosen in the composer.
      const note = await createNote(browser, {
        target: TITLE_TARGET,
        body: "parity: feature text probe",
        mode: "feature",
        priority: "high",
      });
      if (note === null) throw new Error("the feature note is not in the store");
      if (note.type !== "feature") {
        throw new Error(`expected type=feature, got ${JSON.stringify(note.type)}`);
      }
      if (note.context !== null) {
        throw new Error(`a feature on text must not carry a context: ${JSON.stringify(note.context)}`);
      }
      if (note.priority !== "high") {
        throw new Error(`expected priority=high, got ${JSON.stringify(note.priority)}`);
      }
      return { type: note.type, hasContext: false, priority: note.priority };
    },
  },

  {
    name: "capture-feature-design-fallback",
    async probe(browser) {
      await layerReady(browser);
      // FR-1.14: the same mode on an element without text falls back to design semantics. No
      // priority was chosen, so the note must carry none (absent, not `null`).
      const note = await createNote(browser, {
        target: EMPTY_TARGET,
        body: "parity: feature design probe",
        mode: "feature",
      });
      if (note === null) throw new Error("the design-fallback note is not in the store");
      if (note.type !== "feature") {
        throw new Error(`expected type=feature, got ${JSON.stringify(note.type)}`);
      }
      if (note.context === null || typeof note.context !== "object") {
        throw new Error(
          `the feature fell back to text instead of design: context=${JSON.stringify(note.context)} ` +
            `anchor=${JSON.stringify(note.anchor)}`,
        );
      }
      if (note.priority !== undefined) {
        throw new Error(`no priority was chosen, but the note carries ${JSON.stringify(note.priority)}`);
      }
      return { type: note.type, hasContext: true, priority: note.priority ?? null };
    },
  },

  {
    name: "alt-click-button",
    async probe(browser) {
      await layerReady(browser);
      await ensureModeOff(browser);
      await browser.evaluate(`window.__parityClicks = 0`);
      // The fixture's text mode is armed for both halves: it must still pass a plain click through
      // to the host, while Alt+click is the documented exception (FR-1.9/1.15).
      await armMode(browser, "mode-text");
      const before = (await notesOf(browser)).length;

      await browser.click(BUTTON_TARGET);
      await pause(200);
      const normalClicks = await browser.evaluate(`window.__parityClicks`);
      const composerAfterNormal = await composerIsOpen(browser);
      if (normalClicks !== 1) {
        throw new Error(`the host click handler ran ${normalClicks} time(s), expected exactly 1`);
      }
      if (composerAfterNormal) {
        throw new Error("a plain click on the host button opened the composer");
      }

      await browser.click(BUTTON_TARGET, { modifiers: 1 });
      await saveComposer(browser, "parity: alt click probe");
      await browser.waitFor(
        `document.querySelector('bluepencil-notes').blueprint.store.notes().length === ${before + 1}`,
        { timeoutMs: 8000 },
      );
      const altClicks = await browser.evaluate(`window.__parityClicks`);
      const notes = await notesOf(browser);
      const created = notes.filter((note) => String(note.body ?? "").includes("parity: alt click probe"));
      const note = created[created.length - 1] ?? null;
      if (note === null) throw new Error("the Alt+click note is not in the store");
      if (note.type !== "text") {
        throw new Error(`expected type=text for a text-mode Alt+click, got ${JSON.stringify(note.type)}`);
      }
      if (altClicks !== 1) {
        throw new Error(`Alt+click reached the host: __parityClicks=${altClicks}, expected 1`);
      }
      return { normalClicks, altClicks, noteType: note.type, composerOpened: true };
    },
  },

  {
    name: "feature-export-round-trip",
    async probe(browser) {
      await layerReady(browser);
      // Self-sufficient like `export-canonical`: build the feature here, export the real bundle and
      // match *this* note — the optional grade must survive the canonical bundle unchanged.
      const created = await createNote(browser, {
        target: BODY_TARGET,
        body: "parity: feature export probe",
        mode: "feature",
        priority: "medium",
      });
      if (created === null) throw new Error("the feature export probe is not in the store");
      const raw = await browser.evaluate(
        `document.querySelector('bluepencil-notes').exportNotes('json')`,
      );
      if (typeof raw !== "string" || raw.trim() === "") {
        throw new Error("exportNotes('json') returned nothing");
      }
      const bundle = JSON.parse(raw);
      if (bundle.schemaVersion !== 1) {
        throw new Error(`expected bundle schemaVersion=1, got ${JSON.stringify(bundle.schemaVersion)}`);
      }
      if (!Array.isArray(bundle.notes)) throw new Error("bundle carries no notes array");
      const exported = bundle.notes.find((entry) =>
        String(entry.body ?? "").includes("parity: feature export probe"),
      );
      if (exported === undefined) throw new Error("the note this case created is not in the bundle");
      if (exported.type !== "feature") {
        throw new Error(`the exported note changed type: ${JSON.stringify(exported.type)}`);
      }
      if (exported.priority !== "medium") {
        throw new Error(`the exported note lost its priority: ${JSON.stringify(exported.priority)}`);
      }
      const sameId = exported.id === created.id;
      if (!sameId) throw new Error("the bundle's matching note is a different one");
      return {
        type: exported.type,
        priority: exported.priority,
        schemaVersion: bundle.schemaVersion,
        sameId,
      };
    },
  },

  {
    name: "mode-disabled-in-settings",
    async probe(browser) {
      await layerReady(browser);
      await ensureModeOff(browser);

      // FR-4.10: the user's mode switch removes the mode from the bar, the keymap and the legend.
      await browser.click('[data-bp-action="settings"]');
      await surfaceOpen(browser, "settings");
      await setCheckbox(browser, "mode-bug", false);
      await browser.click('[data-bp-action="settings-close"]');
      await surfaceClosed(browser, "settings");

      const buttonHidden = await browser.evaluate(
        `document.querySelector('[data-bp-action="mode-bug"]')?.hidden === true`,
      );
      if (!buttonHidden) throw new Error("the bug bar button is still visible after disabling the mode");

      await browser.key("i");
      await pause(200);
      const shortcutInert =
        (await browser.evaluate(pressedExpr("mode-bug"))) === false &&
        (await modeOf(browser)) === "off";
      if (!shortcutInert) {
        throw new Error(`"i" still activated the disabled bug mode (mode=${await modeOf(browser)})`);
      }

      await browser.click('[data-bp-action="legend"]');
      await surfaceOpen(browser, "legend");
      const bugRow = await browser.evaluate(
        `document.querySelector('[data-bp-part="legend"] [data-bp-i18n="legend.key.bug"]') !== null`,
      );
      const legendRowAbsent = bugRow === false;
      if (!legendRowAbsent) throw new Error("the legend still lists the disabled bug shortcut");
      await browser.click('[data-bp-action="legend-close"]');
      await surfaceClosed(browser, "legend");

      // Restore the default for every later case on this shared page.
      await browser.click('[data-bp-action="settings"]');
      await surfaceOpen(browser, "settings");
      await setCheckbox(browser, "mode-bug", true);
      await browser.click('[data-bp-action="settings-close"]');
      await surfaceClosed(browser, "settings");

      return { buttonHidden, shortcutInert, legendRowAbsent };
    },
  },

  {
    name: "version-surface",
    async probe(browser) {
      await layerReady(browser);
      // FR-4.9: one version, reported by the element, the layer root and the settings surface.
      const rootVersion = await browser.evaluate(
        `document.querySelector('[data-bp-part="root"]')?.getAttribute('data-bp-version') ?? null`,
      );
      const elementVersion = await browser.evaluate(
        `document.querySelector('bluepencil-notes')?.constructor?.version ?? null`,
      );
      if (typeof rootVersion !== "string" || rootVersion === "") {
        throw new Error(`the layer root reports no version: ${JSON.stringify(rootVersion)}`);
      }
      if (rootVersion !== elementVersion) {
        throw new Error(`root version ${JSON.stringify(rootVersion)} != element version ${JSON.stringify(elementVersion)}`);
      }

      await browser.click('[data-bp-action="settings"]');
      await surfaceOpen(browser, "settings");
      const settingsText = await browser.evaluate(
        `document.querySelector('[data-bp-part="settings-version"]')?.textContent?.trim() ?? null`,
      );
      if (typeof settingsText !== "string" || !settingsText.includes(`bluepencil ${elementVersion}`)) {
        throw new Error(
          `the settings surface does not show "bluepencil ${elementVersion}": ${JSON.stringify(settingsText)}`,
        );
      }
      // The label is translated, the value is not — returning the value keeps the observation
      // comparable even if the extension follows a different UI language than the embed.
      const settingsVersion = await browser.evaluate(
        `document.querySelector('[data-bp-part="settings-version"] .bp-version-value')?.textContent?.trim() ?? null`,
      );
      await browser.click('[data-bp-action="settings-close"]');
      await surfaceClosed(browser, "settings");
      return { rootVersion, elementVersion, settingsVersion };
    },
  },
];
