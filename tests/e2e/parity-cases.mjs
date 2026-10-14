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

/** Types the body into the open composer and saves it (real mouse click on the save button). */
async function saveComposer(browser, body) {
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
 */
async function createNote(browser, { target, body, mode = "text", feedback = false }) {
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
  await saveComposer(browser, body);
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
];
