# Whole-system attach fixture — `examples/attach`

The **host application** side of the embed story: a small analytics dashboard
(`Northwind Analytics`) that attaches bluepencil against a backend endpoint with one script tag —
and a self-test that proves the attach on the host's own terms.

Everything the layer needs is configuration on the script tag. The page itself contains no
bluepencil code: no `init()`, no adapter, no header building.

```
examples/attach/
  index.html   the host app: markup, design tokens, the one loader script tag
  host.js      host bootstrap: gate + headers-from, and the `?selftest=1` probe
```

## Two ways to run it

### 1. Bundled sidecar — page and API on one origin

```bash
npm run build     # writes dist/attach.js, dist/bluepencil.element.min.js, dist/server.js

# Serve the repository root, so the page's `../../dist/attach.js` resolves
node dist/server.js \
  --store .tmp/attach-store.json \
  --root . \
  --environment dev

# open http://127.0.0.1:8787/examples/attach/
```

Both the page and `/api/v1/bluepencil` are then served from the same origin, so nothing has to be
proxied. The page keeps repository-relative paths (`../../dist/attach.js`) on purpose: that is what
makes it work unchanged under `scripts/serve-example.mjs` (port 9283) **and** under the sidecar.

`--root .` publishes the whole checkout, which is fine for a local fixture. For a deployment, copy
just what the site needs — `examples/attach/`, `dist/` — into one directory and point `--root` at
that; that is exactly what `scripts/embed-smoke.mjs` does before it drives this page.

### 2. Your own backend

Point `data-endpoint` at any URL that implements the store contract
([EMBED.md §4](../../docs/EMBED.md#4-the-store-contract)). The page's origin must be able to reach
it — same origin, or CORS headers on the API.

## The self-test: `?selftest=1`

```bash
# against the sidecar from mode 1
open http://127.0.0.1:8787/examples/attach/?selftest=1
```

`host.js` then probes the attach from the host's side and prints a result block into the page:

```text
selftest: PASS attach-ready — version=unknown
selftest: PASS documented-api-surface — version=unknown, instances=1
selftest: PASS element-mounted — attach-version=unknown
selftest: PASS layer-styles-injected — 1 style node
selftest: PASS note-round-trip — note n-…
selftest: PASS headers-from-per-request — 3 call(s)
selftest: PASS note-visible-over-http — GET /notes?session=attach-fixture → 1 note(s)
selftest: PASS check-without-manifest — 0 swap(s)
selftest: 8/8 ok
```

and marks up the block for machines:

```html
<pre id="bp-selftest" data-status="pass" data-count="8/8">…</pre>
```

| Check | What it proves |
|---|---|
| `attach-ready` | the loader mounted and announced `{ version, src }` on `document` |
| `documented-api-surface` | `window.bluepencilAttach` exposes `version`, `src`, `instances`, `destroy`, `check`, `reload` |
| `element-mounted` | exactly one `<bluepencil-notes>`, with `endpoint`/`environment`/`session`/`language` forwarded and the `attach-version`/`attach-src` breadcrumbs set |
| `layer-styles-injected` | the layer's stylesheet is in the page exactly once |
| `note-round-trip` | a note written through the element's store comes back from the API with the same body, in the configured environment, with the anchor route from `data-route="url"` |
| `headers-from-per-request` | `hostApp.headers()` was called — the `data-headers-from` path is live, which is what keeps a rotated token current |
| `note-visible-over-http` | the same note is readable through the plain `GET {base}/notes?session=…` contract |
| `check-without-manifest` | `check()` reports `0` swaps when no manifest is configured — no surprise remount |

Without `?selftest=1` the page is just the dashboard: no probe, no output block.

## Automated: `npm run smoke:embed`

`scripts/embed-smoke.mjs` serves this page with the sidecar (`--root`), opens it in a real browser
(Chrome over the CDP pipe, no npm dependency), waits for the probe and then asserts **outside** the
page that the note it created is in the API and in the store file on disk. It also drives the
presentation deck and a live version swap of the shipped `attach.js`.

```bash
npm run build && npm run smoke:embed         # skips the browser leg without a Chrome
BP_CHROME=/path/to/chrome npm run smoke:embed # point it at a specific browser
BP_REQUIRE_BROWSER=1 npm run smoke:embed      # CI: no browser is a failure, not a skip
```

## How the page loads bluepencil

```html
<script src="./host.js"></script>          <!-- gate + headers-from, must run first -->

<script src="../../dist/attach.js"
        data-endpoint="/api/v1/bluepencil"
        data-environment="dev"
        data-language="de"
        data-session="attach-fixture"
        data-route="url"
        data-headers='{"X-Workspace":"demo-workspace"}'
        data-headers-from="hostApp.headers"
        data-token="dev-review-token"
        data-token-header="Authorization"
        data-token-scheme="Bearer"
        data-gate="hostApp.canReview"></script>
```

| Attribute | Effect in this page |
|---|---|
| `data-endpoint` | implies `adapter="http"`; the API is addressed explicitly instead of being guessed from the origin |
| `data-environment` | notes are bound to `dev`; the sidecar rejects writes from another environment |
| `data-language` | German UI |
| `data-session` | review round `attach-fixture` — the self-test and the smoke read it back by that filter |
| `data-route` | stores `location.pathname` as the anchor route |
| `data-headers` | one static header |
| `data-headers-from` | `hostApp.headers()`, evaluated on **every** request |
| `data-token*` | `Authorization: Bearer dev-review-token` (wins over the other header sources) |
| `data-gate` | `hostApp.canReview()`, ANDed with `enabled != "false"`, re-evaluated on every `enable()` |

## Documented failure mode

If the host's origin does **not** proxy the API path, the HTTP adapter gets the SPA's HTML instead
of JSON, and the page looks empty. The self-test reports it as
`note-visible-over-http — GET … → HTTP 200` with a payload that has no `notes` array, and
`attachable` failures show up as `bp-attach-error` in `hostApp.events.errors`.

Fix it by serving page and API from one origin — the sidecar with `--root` (mode 1) does that — or
by proxying `/api/v1/bluepencil` to the store backend. See EMBED.md §7 for the symptom table.
