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
| **Self-hosted sidecar** | one command | Static sites, presentations, team reviews |

## 2. Embedded (HTTP adapter)

```ts
import { init } from "bluepencil";
import { httpAdapter } from "bluepencil/adapters/http";

const bp = init({
  enabled: () => currentUser.roles.includes("admin"),
  adapter: httpAdapter({
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
`src/adapters/http.ts`). That contract is written down but has **no reference implementation yet**:
the `server/` package is an M2 deliverable (§5). Any backend that implements the endpoints works today.

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
between browsers. Note that a browser extension does **not** remove the CSP problem: the element
layer has to run in the page's MAIN world (Chromium's isolated content-script world reports a null
`customElements`, so the element cannot register there), and a MAIN-world inline `<style>` is still
governed by the page's `style-src`. The element layer therefore verifies the stylesheet it inserted
and falls back to a constructable `CSSStyleSheet` on `document.adoptedStyleSheets`, which a page
CSP does not govern. Under a strict `style-src` you will see the layer mount unstyled if that
fallback is unavailable; everything else works.

## 5. Self-hosted sidecar

`server/` serves a static site **and** the API on one port, with the note store as a JSON file plus an
optional generated Markdown mirror. It is built to `dist/server.js`:

```sh
npm run build
node dist/server.js --store notes.json --root examples/vanilla --port 8787
```

Flags: `--store <json>` (required), `--port 8787`, `--host 127.0.0.1`, `--base /api/v1/bluepencil`,
`--root <static dir>`, `--environment dev|staging|live`, `--read-only`, `--allow-env-mismatch`,
`--mirror notes.md`, `--cors <origin|*>`, `--quiet`. The HTTP contract is ARCHITECTURE §5.

### Authentication — and when it is needed

A sidecar on loopback needs none: it is as protected as the file it writes to. The moment `--host`
leaves loopback, one of two credentials has to be configured, and **every request under the base**
must then carry it:

| Credential | Flag / environment | Header | Properties |
|---|---|---|---|
| Shared secret | `--auth-secret` / `BLUEPENCIL_AUTH_SECRET` | `x-bluepencil-auth: <secret>` | one string for every client, no expiry, no per-device revocation |
| Signed token | `--token-key` / `BLUEPENCIL_TOKEN_KEY` | `Authorization: Bearer <token>` | HS256, one per device (`jti`), expires, revocable by id |

Prefer the environment variable over the flag in both cases: a value on a command line is visible in
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
lists; the file is read once at startup, so revoking a device means restarting the sidecar.

Clients authenticate the same way the extension does — over HTTP the adapter sets the header:

```ts
adapter: httpAdapter({
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
  adapter: httpAdapter({ endpoint: "/api/v1/debug-notes", headers: authHeaders }),
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
   [HERMES.md](HERMES.md).
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
| `onError(err)` | Error reporting | `console.debug` |

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
* All user-provided text is rendered as **text**; HTML in a note is displayed literally (FR-9.3).
* Notes are artefacts of a review, not a data store: assume they may contain internal wording.
  Keep the policy "no personal data in notes", purge after the round, and prefer local mode when
  in doubt.
* The layer is invisible in print and in host exports.

## 10. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Nothing appears | `enabled()` returned false, or the script loaded before the app's root element exists |
| Clicks do nothing | Buttons disabled because the adapter failed on first load (check `onError`) |
| Notes lose their element | Anchor resolved to an unstable path; add a `data-bluepencil`/`data-testid` hook to that element |
| Marker drifts | Host CSS repositions the element after capture; re-check the note or switch to the hook-based anchor |
| Bookmarklet blocked | CSP without external script allowance — self-host the loader, or run the layer in the page's MAIN world (an extension content script cannot: its isolated world has no usable `customElements`) |
| Layer mounts but looks unstyled | Page CSP forbids inline styles. The layer should have fallen back to a constructable stylesheet; if the engine offers neither path, the unstyled mount is the visible symptom |

## 11. Embed / attach reference

For the one-script-tag attach pattern (with or without a backend), the
full attribute table, the manifest-driven runtime update API, the store
contract endpoint table, the gate recipe, and troubleshooting, see:

**[EMBED.md](EMBED.md)**
