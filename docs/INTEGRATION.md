# Integration guide

> How to put bluepencil on a page, in an app, or behind an admin role.
> API sketch: [ARCHITECTURE.md §2](ARCHITECTURE.md#2-public-api-sketch).
> Requirements: FR-10.x, FR-9.x.

---

## 1. Choosing a mode

| Mode | Effort | Use when |
|---|---|---|
| **Embedded** (library + your adapter) | ~10 lines | You own the app and have (or want) an endpoint |
| **Embedded, local only** (`localStorage`) | ~5 lines | A quick review round, no backend wanted |
| **Bookmarklet** | none (drag a link) | The page is not yours / you cannot deploy |
| **Self-hosted hub** | one command | Static sites, presentations, team reviews |

### Deployment shapes at a glance

These are the five topologies from [FEDERATION.md §14](FEDERATION.md#14-deployment-shapes). The
README's [`Deployment shapes`](../README.md#deployment-shapes) section tells the same story from the
user's side; the two lists line up as follows:

* **1** = README shape 1 (*solo* — one store, no HTTP fan-out);
* **2** = README shape 3 (*self-hosted hub*);
* **3** and **4** = README shape 4 (*hub of hubs*, once through a registry and once through the
  stdio federator);
* **5** = README shape 4 written out concretely (two leaves plus an aggregator).

README shapes 2 (*embedded with your own backend*) and 5 (*offline exchange*) are host and CLI
patterns, not federation topologies, so they have no row here. The registry, write locks and threat
model are in [FEDERATION.md](FEDERATION.md).

| # | Shape | One line |
|---|---|---|
| 1 | **Single store, stdio MCP** | One JSON file and an agent; no HTTP server at all. |
| 2 | **Single hub + browser** | One hub is the store of record; the browser writes through `/notes`. |
| 3 | **Hub with a registry** (read-only aggregate) | `/mcp` reads several hubs; `/notes` stays on the local store. |
| 4 | **Federator + several hubs** | A stdio agent session over several leaf hubs; no local store, no HTTP. |
| 5 | **Compose: two leaves + aggregator** | Two independent stores of record plus one aggregating hub for an agent. |

Every shape has an agent side, including shape 2: its hub exposes `/mcp` with the same 9 tools as a
single store, and shapes 3–5 add the federation surface (10 tools, including `list_instances`). What
none of them changes is the browser: it **always writes to exactly one hub** — no shape adds an
`instance` attribute or a multi-hub browser profile.

## 2. Embedded (HTTP adapter)

```ts
import { init } from "bluepencil";
import { createHttpAdapter } from "bluepencil/adapters/http";

const bp = init({
  enabled: () => currentUser.roles.includes("admin"),
  adapter: createHttpAdapter({
    endpoint: "/api/v1/bluepencil",
    headers: () => ({ Authorization: `Bearer ${getToken()}` }),
  }),
  identity: { getUser: () => ({ id: currentUser.id, name: currentUser.displayName }) },
  getRoute: () => location.pathname + location.search,
  language: navigator.language.startsWith("de") ? "de" : "en",
});
```

The adapter speaks the contract in [ARCHITECTURE.md §5](ARCHITECTURE.md#5-http-contract-reference-server)
(list, create, update, thread message, bulk delete, sessions, health — the endpoints are listed in
`src/adapters/http.ts`). The reference implementation is the hub in §5; any backend that implements
the documented endpoints works.

Under a strict Content-Security-Policy the page has to allow the hub origin in `connect-src`;
`script-src` does not govern `fetch()`. When no `connect-src` is declared, `default-src` is the
fallback, so `default-src 'self'` alone blocks every hub call. Recipes and the loader's own
manifest/asset directives are in
[EMBED.md — CSP: `script-src` and `connect-src`](EMBED.md#csp-script-src-and-connect-src).

## 3. Embedded, local only

```ts
init({ adapter: "localStorage", identity: { getUser: () => ({ name: "Daniel" }) } });
```

Notes survive reloads in that browser, can be exported to a file, and are removed when the
user clears site data. Good for a single reviewer; not for a team.

## 4. Bookmarklet (no deploy)

1. Host the IIFE build somewhere reachable (`https://your-host/bluepencil.iife.js`).
2. Put the loader (see [ARCHITECTURE.md §6](ARCHITECTURE.md#6-bookmarklet)) in a bookmark.
3. Click it on any page → the layer attaches, notes go to `localStorage`, export writes a file.

Limits worth knowing: strict `script-src` CSP blocks external loaders, and nothing is shared
between browsers. A page that reaches a hub needs `connect-src` for the hub origin as well — a
`default-src 'self'` policy with no `connect-src` blocks the request after the layer mounts; see
[EMBED.md](EMBED.md#csp-script-src-and-connect-src). Note that a browser extension does **not** remove
the CSP problem: the element layer has to run in the page's MAIN world (Chromium's isolated
content-script world reports a null `customElements`, so the element cannot register there), and a
MAIN-world inline `<style>` is still governed by the page's `style-src`. The element layer therefore
verifies the stylesheet it inserted and falls back to a constructable `CSSStyleSheet` on
`document.adoptedStyleSheets`, which a page CSP does not govern. Under a strict `style-src` you will
see the layer mount unstyled if that fallback is unavailable; everything else works. The extension
(0.11.6+) is the one exception, and only for hub traffic: it relays the layer's hub calls through
its service worker, so the page's `connect-src` no longer applies to them — see
[EXTENSION.md](EXTENSION.md#an-extension-does-not-bypass-a-csp).

## 5. Self-hosted hub

`server/` serves a static site **and** the API on one port, with the note store as a JSON file plus an
optional generated Markdown mirror. It is built to `dist/server.js`:

```sh
npm run build
node dist/server.js --store notes.json --root examples/vanilla --port 8787
```

Flags: `--store <json>` (required), `--port 8787`, `--host 127.0.0.1`, `--base /api/v1/bluepencil`,
`--root <static dir>`, `--environment dev|staging|live`, `--read-only`, `--allow-env-mismatch`,
`--mirror notes.md`, `--cors <origin|*>`, `--quiet`. The HTTP contract is ARCHITECTURE §5.

**The hub remains the store of record.** `/notes` reads and writes exactly one JSON file in one
environment. Federation does not move, mirror or merge that store; it only widens the agent door
(`/mcp`). A browser client that points at a hub sees that hub's notes and nothing else.

### The aggregating hub — what it is, and what it is not

Adding `--registry <file>` turns `/mcp` into an aggregate over the listed instances. It is for an
**agent** that must read (and, with both write locks, write) several environments in one MCP
session: the tool results carry `instance`/`app` and qualified ids.

It is **not** a second store of record and not a browser backend. `/notes`, `/sessions`, `/bundle`
and `/health` keep operating on the hub's own local store; only `/mcp` fans out. With `--no-self`
that store is deliberately empty, so `/notes` on the aggregator returns nothing — which is the
point: the browser must talk to the leaf hubs directly. The aggregate is read-only unless the
session has `--allow-write` *and* a target has `mode: "write"`; there is no write fan-out.

`/config` reports `federates: true` whenever a registry is configured, even if a peer started
degraded. The registry `base` values must include the API path
(`http://hub-dev:8787/api/v1/bluepencil`), and the file must be mode `0600`. See
[FEDERATION.md](FEDERATION.md) for the registry contract.

### Authentication — and when it is needed

A hub on loopback needs none: it is as protected as the file it writes to. The moment `--host`
leaves loopback, one of the two **client** credentials has to be configured, and **every request
that reads or writes note data under the base** must then carry it. The read-only probes
`GET {base}/health` and `GET {base}/config` are exempt because they carry no note and no secret;
`GET {base}/journal` is exempt too, but it is an audit read, not a probe — its entries name the
audited `noteId`, the `actor` and a `summary`, so a hub on an untrusted network exposes its audit
trail. The CORS `OPTIONS` preflight is unauthenticated **on the API routes** when `--cors` is
configured (a browser cannot carry a credential yet); `OPTIONS {base}/journal` is not a preflight —
the journal answers `GET` only and refuses `OPTIONS` with `405`. Gated routes: `/notes*`,
`/sessions`, `/bundle` and `/mcp`.

| Credential | Flag / environment | Header | Properties |
|---|---|---|---|
| Shared secret | `--auth-secret` / `BLUEPENCIL_AUTH_SECRET` | `x-bluepencil-auth: <secret>` | one string for every client, no expiry, no per-device revocation |
| Signed token | `--token-key` / `BLUEPENCIL_TOKEN_KEY` | `Authorization: Bearer <token>` | HS256, one per device (`jti`), expires, revocable by id |
| Admin secret (operator) | `--admin-secret` / `BLUEPENCIL_ADMIN_SECRET` | `x-bluepencil-admin: <secret>` | at least 16 characters; a **notes-route-only** bridge, never `/mcp`; rate-limited; **not a client credential** |

**The admin secret is not a client credential.** It belongs to the operator and unlocks the optional
admin page at `{base}/admin`; the hub admits it as a second credential only on the notes routes
(`{base}/notes*`), never on `/mcp`, `/sessions` or `/bundle`, and its presence does **not** turn
authentication on — a hub with no `x-bluepencil-auth`/token gate stays ungated. Admin
authentication is rate-limited: 10 failures per remote in 5 minutes answer `429` with
`Retry-After: 300`. The page keeps the secret in memory by default; **Remember in this tab** is
opt-in and warns about the tab's storage. The page is served with `cache-control: no-store`,
`x-frame-options: DENY`, `content-security-policy: frame-ancestors 'none'` and
`referrer-policy: no-referrer`.

**What the admin surface can see.** It shows note writes, the client credentials it issued (one
record per token, not one per connected browser) and the last time each credential kind was accepted
on either door — `presence: { "token": …, "secret": … }` in `{base}/admin/status`, ISO-8601 or
`null`, throttled to one write per kind per minute and kept in memory only. Readers are not tracked
as individual clients: a shared secret makes two browsers indistinguishable, and a hub with no client
credential has no gate to observe.

Prefer the environment variable over the flag in every case: a value on a command line is visible in
the process list to every other user on the machine.

```sh
# phase 1 — one shared secret
BLUEPENCIL_AUTH_SECRET=… node dist/server.js --store notes.json --host 0.0.0.0

# phase 2 — per-device signed tokens
export BLUEPENCIL_TOKEN_KEY=…
node dist/server.js --store notes.json --host 0.0.0.0 \
  --token-ttl 86400 --revoked-tokens revoked.json
bluepencil token --device work-laptop --scope read write --ttl 43200
```

`bluepencil token` mints locally and prints the token on stdout (context on stderr), so
`export TOKEN=$(bluepencil token --device laptop)` works. The id it prints is what a revocation file
lists; with the admin surface a revocation is live at once and, when `--revoked-tokens` is
configured, durable across restarts. Without the admin surface the file is read at startup, so a
revocation means adding the id and restarting the hub.

Clients authenticate the same way the extension does — over HTTP the adapter sets the header:

```ts
adapter: createHttpAdapter({
  endpoint: "https://notes.example.test/api/v1/bluepencil",
  headers: () => ({ Authorization: `Bearer ${getToken()}` }),
}),
```

and the element path uses the same contract through attributes: `data-token="…"
data-token-header="authorization" data-token-scheme="Bearer"` (or `data-token-header="x-bluepencil-auth"`
for the shared secret). [EMBED.md](EMBED.md) lists the attributes.

Refusals are meant to be actionable: `401 unauthorized` (missing or wrong secret), `401 token_expired`
(mint a new one), `401 token_revoked` (do *not* — the device was deliberately cut off), `403
insufficient_scope` (the token is good but read-only). `GET` requires `read`, every mutation
`write`, and `write` implies `read`.

Deploy it as a container behind your usual proxy, and make sure the port is actually published (a
listening process inside a container is not automatically reachable from the network).

## 6. Admin debug mode in a product (FR-10.4)

This is the pattern the library was designed around.

```ts
init({
  enabled: () => me.roles.includes("admin") && featureFlag("uiDebugNotes"),
  adapter: createHttpAdapter({ endpoint: "/api/v1/debug-notes", headers: authHeaders }),
  identity: { getUser: () => ({ id: me.id, name: me.email }) },
  getRoute: () => router.currentRoute.value.fullPath,
  defaultShowDone: false,
});
```

Host-side checklist:

1. **Gate on the server, not only in the UI.** Only admins may read/write/delete notes;
   unauthorized callers get 403/404 without leaking existence (FR-9.2).
2. **Scope by tenancy.** Notes belong to a workspace/tenant; cross-tenant reads must be
   impossible.
3. **Audit every deletion** with actor, filter and count (FR-8.5).
4. **Purge by session** after a debug round, and offer retention (done notes older than N days).
5. **Expose an agent interface** so an agent can work the notes off — see [PROTOCOL.md](PROTOCOL.md).
   What exists in M1 is the MCP server (`dist/mcp.js`): read-only by default with `list_notes`,
   `get_note`, `export_bundle` and `inspect_bundle`; `create_note`, `reply`, `set_status`,
   `set_intent` and `import_bundle` only in a session started with `--allow-write`. There is no
   bulk-delete tool — filtered deletion is M2 (FR-8.2). Registration and environment binding are in
   [MCP.md](MCP.md#client-recipes); [HERMES.md](HERMES.md) is one worked example among several.
6. **Never load the layer for end users**: build-time flag *and* the role gate. Prove it with a
   test that asserts the layer is absent when the flag is off.

## 7. Host hooks

| Hook | Purpose | Default |
|---|---|---|
| `enabled()` | Decide whether the layer exists at all; re-evaluated on every `enable()` | unset → the host's `init()` call is the opt-in; pass `() => false` to fail closed |
| `adapter` | Where notes live | `memory` |
| `identity` | Author identity: `{ getUser() }`, `"prompt"` (author field in the settings surface) or `"anonymous"` (D3) | `"prompt"`; a note is written as `anonymous` when no name is entered |
| `getRoute()` | SPA-aware route stored on the anchor | unset → no route is stored |
| `canAnnotate(el)` | Which elements may be annotated | all except layer internals |
| `language` | UI language (`en`, `de`; region/separator agnostic, anything else → `en`) | `en` |
| `theme` | Token overrides (`accent`, `surface`, `ink`, …) | neutral defaults |
| `defaultShowDone` | Start with done notes visible | `false` |
| `voice` | Composer dictation opt-in (FR-21.1): `true` shows a mic button in the composer; unset or `false` means no mic button, no recognition listener and no permission prompt | `false` |
| `voiceEngine` | Host-supplied recogniser factory (FR-21.6), used instead of the browser engine | unset → the browser's `SpeechRecognition`/`webkitSpeechRecognition` |
| `onError(err)` | Error reporting | `console.debug` |

### Voice dictation (FR-21)

Dictation is **off by default** and opted into per host — programmatically with `voice: true`, or in
markup with the `voice` attribute (the loader form is `data-voice="true"`). With the opt-in the
composer gains a mic button (`data-bp-action="composer-voice"`): interim results are announced in a
`role="status"` live region, and the **final transcript is appended to the body textarea** and saved
only by the human's save action — there is no auto-save (FR-21.3). `Esc`, closing the composer,
`disable()` and `destroy()` all stop recognition, and a second activation toggles it off; teardown is
idempotent (FR-21.4).

The feature is detected through `SpeechRecognition || webkitSpeechRecognition`, so no button appears
and nothing throws on a platform without it (FR-21.2). When a host explicitly requests `voice` on
such a platform, the reason is reported through `element.issues` instead of failing silently. A host
that wants to stay offline, or use its own recogniser, injects an engine through `voiceEngine` /
`voice-engine="myApp.whisperEngine"` — a global path to a factory that must resolve to a function
(FR-21.6); the core stays dependency-free.

**Privacy (FR-21.5):** only the final transcript text is kept — no audio is stored and the core makes
no network request of its own. Chromium's Web Speech API may itself send audio to a browser service,
which is outside the library's control; the host opts in deliberately.

## 8. Theming

The layer is styled exclusively through CSS custom properties with fallbacks:

```css
:root {
  --bp-accent:  #8c3b2e;
  --bp-surface: #f6f4ef;
  --bp-ink:     #1c1b19;
  --bp-muted:   #7b756c;
  --bp-line:    #d8d2c7;
}
```

No colours, radii or sizes are hardcoded in the layer's own rules, so it can adopt any design
system — including reduced motion.

### The full token list

The table above shows the five that matter most. The stylesheet consumes 18; the rest are
`--bp-surface-alt`, `--bp-accent-ink`, `--bp-danger`, `--bp-decision`, `--bp-feedback`,
`--bp-highlight`, `--bp-backdrop`, `--bp-shadow`, `--bp-font`, `--bp-font-size`, `--bp-radius`,
`--bp-space` and `--bp-z`.

### Dark mode

`@media (prefers-color-scheme: dark)` supplies a dark palette for every one of these tokens, and
it is applied as a **fallback** (`--bp-accent: var(--bp-accent, #7ba2ff)`), not as an override.
That distinction is what makes the recipe above work in both schemes: a value you set on `:root`
or on any ancestor keeps winning, while a host that sets no token at all still gets the dark
palette. (Before, the media block re-declared the tokens on the layer root, and a custom property
set on an element beats an inherited one — so a host following the recipe above lost its palette
the moment the OS turned dark.)

Dark mode follows the **operating system**; the library ships no switch for it. To force a scheme,
pin the tokens on the layer root yourself — through the `theme` option or the `theme-accent` /
`theme-surface` attributes, which are written as inline custom properties and therefore win:

```js
init({ theme: { surface: "#ffffff", ink: "#14161c", muted: "#5a6072", line: "#d7dae2" } });
```

Pin the whole set, not a part of it. Mixing a pinned `--bp-surface` with an unpinned dark
`--bp-ink` produces an unreadable layer (measured contrast 1.13:1).

### What the layer does not inherit

`--bp-font` and `--bp-font-size` are *not* `inherit` by default: the layer uses
`system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` at 13px unless you set the token
explicitly. To follow the host's typography, pass the host's values:

```js
init({ theme: { font: "inherit", "font-size": "inherit" } });
```

## 9. Security & privacy notes

* The library stores no credentials and performs no request that the host has not configured.
* The page's own CSP is the boundary for network access: the layer only requests the configured
  endpoint, and that request needs the hub origin in `connect-src` (or in `default-src`, when
  `connect-src` is absent). `script-src` does not cover `fetch()`. See
  [EMBED.md](EMBED.md#csp-script-src-and-connect-src).
* All user-provided text is rendered as **text**; HTML in a note is displayed literally (FR-9.3).
* Notes are artefacts of a review, not a data store: assume they may contain internal wording.
  Keep the policy "no personal data in notes", purge after the round, and prefer local mode when
  in doubt.
* **Dictation is opt-in and text-only (FR-21).** Only the transcript text from the composer is kept;
  no audio is stored and the core makes no request of its own. When the browser's own Web Speech API
  is used, Chromium may send audio to a browser service — a host that must avoid that injects its own
  engine through `voiceEngine` (FR-21.6).
* The layer is invisible in print and in host exports.

## 10. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Nothing appears | `enabled()` returned false, or the script loaded before the app's root element exists |
| Clicks do nothing | Buttons disabled because the adapter failed on first load (check `onError`) |
| Notes lose their element | Anchor resolved to an unstable path; add a `data-bluepencil`/`data-testid` hook to that element |
| Marker drifts | Host CSS repositions the element after capture; re-check the note or switch to the hook-based anchor |
| Bookmarklet blocked | CSP without external script allowance — self-host the loader, or run the layer in the page's MAIN world (an extension content script cannot: its isolated world has no usable `customElements`) |
| Layer mounts, but nothing reaches the hub | The page's `connect-src` does not allow the hub origin (`default-src 'self'` without `connect-src` does not). Confirm in DevTools: the console names the blocked URL and directive — `Refused to connect … violates the following Content Security Policy directive: "connect-src …"` (or `"default-src …"`) — and Network shows the request as blocked. Allow the hub origin in `connect-src`, or run the layer through the extension, whose hub traffic leaves through the service worker |
| Layer mounts but looks unstyled | Page CSP forbids inline styles. The layer should have fallen back to a constructable stylesheet; if the engine offers neither path, the unstyled mount is the visible symptom |

## 11. Embed / attach reference

For the one-script-tag attach pattern (with or without a backend), the
full attribute table, the manifest-driven runtime update API, the store
contract endpoint table, the gate recipe, and troubleshooting, see:

**[EMBED.md](EMBED.md)**

## 12. Capture modes and note types (FR-1.13/1.14/4.10)

A capture mode decides what a click means and which payload the composer carries:

| Mode | Key | Note `type` | Capture |
|---|---|---|---|
| Text | `c` | `text` | selection quote |
| Design | `d` | `design` | design snapshot (computed styles, box, theme, viewport) |
| Bug | `i` | `bug` | design snapshot, always — even on a text element — plus `severity` |
| Feature | `n` | `feature` | hybrid: text with a quote when a text target is found, otherwise a design snapshot; plus `priority` |

`priority` (`high`, `medium`, `low`) is optional and only exists on a `feature` note. `severity`
(`blocker`, `major`, `minor`) likewise only exists on a `bug`. Both are additive: `schemaVersion`
stays `1`, and an older reader degrades a `feature` note to `text` and drops the field.

### Host ceiling and read-only

The host sets the upper bound of what it wants to collect, either at `init()` or through the
element's `modes` attribute:

```ts
init({
  adapter: "localStorage",
  modes: ["text", "design", "bug"],   // no feature capture on this page
});
```

```html
<bluepencil-notes modes="text,design,bug" …></bluepencil-notes>
<!-- loader form: data-modes="text,design,bug" -->
```

An absent `modes` means all four. `modes="none"` mounts a **read-only** layer: the bar, note list,
filters, legend and settings stay available, but there is no capture and the feedback-only control is
hidden. Inside the host ceiling the reviewer can switch individual modes off in the settings popover;
a disabled mode hides its bar button, leaves its shortcut inert and is omitted from the legend.
Disabling the currently active mode falls back to `off`, and turning every mode off produces the same
read-only state. Existing notes are never removed by a mode change.

### Alt+click on interactive elements

While a capture mode is active, **Alt+click** opens the composer for a button, link, form field or
element with an interactive ARIA role. A normal click is left to the host, so navigation and form
behaviour are unchanged; `preventDefault()` stops the host action when the composer opens.
`[data-bp-ignore]` and a host `canAnnotate` veto still apply (FR-1.15, FR-12.6).

### Grading in the panel

The panel shows a type badge and, where present, a severity (bug) or priority (feature) badge.
Severity and priority are editable inline as compact dropdowns that include `none` (clearing the
field through `NotePatch.severity` / `NotePatch.priority` set to `null`). The note type itself is
immutable after capture; the filters cover `all` plus every type and every grading value, with
`none` matching notes that carry no severity or priority.

### Version

The settings popover carries a static `Version` row reading `bluepencil <VERSION>` (`dev` when
running straight from source), and the layer root exposes the same value as `data-bp-version`. See
[EMBED.md §4](EMBED.md#which-version-is-running-fr-19) for every surface that reports the version.
