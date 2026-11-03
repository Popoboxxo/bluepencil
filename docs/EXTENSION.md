# The browser extension

bluepencil ships as an installable Chromium extension (MV3). It mounts the same review layer you get
from the embed snippet, on any page, without editing that page.

## Build and install

```sh
npm run build:ext     # writes extension/dist/
```

Then load it: `chrome://extensions` → enable *Developer mode* → *Load unpacked* → pick
`extension/dist`.

`npm run smoke:ext` verifies the build: 133 checks — static artefact checks, the host-embed detection
pinned against fake documents without a browser, and a real Chrome run. The browser run mounts the
layer against a host page with `script-src 'self'`, asserts it actually mounted, and drives a second
page that already carries `<bluepencil-notes>` to prove the extension steps aside there. The options
page has its own cases in that suite — the credential mode, the header it means, the expiry line, the
full API base in the URL field, the *Test connection* probe against both a closed port and a
reachable fixture, and the contrast of every status colour in both schemes — because the settings UI
is the only place a credential is entered and it was otherwise untested.

### From a release

Every push to `main` builds the packaged extension and attaches it as a workflow artefact
(`.github/workflows/extension.yml`). A `v*` tag additionally creates a GitHub release with the zip
attached, so a Chrome Web Store upload is a download of that artefact — no local build needed. The
artefact is the content of `extension/dist` zipped, which is also what *Load unpacked* takes.

That upload is automated. Publishing the release runs `.github/workflows/chrome-webstore.yml`, which
takes the release's own zip — nothing is rebuilt, so the bytes the store serves are the bytes
`npm run smoke:ext` tested — and hands it to the store. It needs the five store secrets, and it is the
one step that requires the extension to exist in the store already: the API can publish new versions
of an item, never create one.

## What it looks for on a page

Nothing. The extension injects only when you ask it to, and only into the tab you are looking at.

### A page that already embeds Bluepencil

Before it mounts, the extension checks whether the page carries the layer on its own (`#70`). A page
can do that in three ways, and the check is a plain read of the page's own markup — never a guess
about intent:

| What the page has | Reported as |
| --- | --- |
| A `<bluepencil-notes>` element | `element` |
| The one-tag loader — a `script[src*="attach.js"]`, or the `bluepencilAttach` global it installs | `loader` |
| An element carrying `[data-endpoint]` | `hub` |

The first match wins, in that order: the element is unambiguous, the loader is the documented way to
create one, and a bare `[data-endpoint]` is the loosest signal. When any of them is found the
extension **steps aside by default** — mounting would put a second overlay over the same notes, with
its own store, and no way for a reviewer to tell which note went where.

A stepped-aside tab is not a silent no-op: the toolbar badge shows `host` and its tooltip names the
source that was found (element, loader or hub), so a click that appears to do nothing says why.

To run your own layer on such a page anyway, tick **Also load the layer on pages that already embed
Bluepencil** in the options page (off by default). The same override is available per call as
`bluepencil:mount { force: true }`. Stepping aside does not latch: a later explicit activation brings
the layer up in the same document, even though the page still embeds its own.

## How it gets in, and why it is built that way

This is the part worth reading before changing anything, because all of it is measurement, not
preference. Chrome 151 was asked each question directly:

| Attempt | Result |
| --- | --- |
| Run the element in the isolated content-script world | `customElements` is `null` there, and `typeof` still says `"object"` (#32) |
| `import(chrome-extension://…/bluepencil.element.js)` from the page | *"Failed to fetch dynamically imported module"* |
| `import()` inside the service worker | *"import() is disallowed on ServiceWorkerGlobalScope"* |
| `new Function(source)` in the page, by any channel | *"Evaluating a string as JavaScript violates the following Content Security Policy directive because 'unsafe-eval' is not an allowed source of script: script-src 'self'"* |

So the only channel that works is a packaged file injected with `world: "MAIN"` through
`chrome.scripting`: Chrome loads it into the page's own world even when the page's CSP forbids
everything else. There is **no persistent content-script registration** — the mount sequence is the
isolated-world bridge, the MAIN-world bootstrap and then the configuration, each injected as a file
after the user's gesture. The element bundle is compiled *into* `src/bootstrap.ts` and ships as one
static classic script — no `eval`, no `new Function`, no dynamic `import()`, no network fetch, at
build time or at runtime.

What crosses the boundary at runtime is data: the worker places the settings as a plain object, and
the bootstrap reads them. The credential is not part of that object: it stays in the worker, which
attaches the auth header itself.

## An extension does not bypass a CSP

The layer uses constructable stylesheets (`document.adoptedStyleSheets`) when a page's `style-src`
forbids inline styles (#33). That keeps it working *inside* a policy, not around it. The smoke test
runs against a strict-CSP host on purpose: it is the case that used to break.

One part is different since 0.11.6: **hub traffic leaves through the extension's service worker**
(#116). The layer's `fetch` still runs in the page, but it is routed page → isolated-world bridge →
service worker, and the worker is outside the document's CSP. A page with `default-src 'self'` and
no `connect-src` therefore no longer blocks note sync. Since 0.12 the credential is **worker-only**:
the page settings object carries no `auth` and no token, the page never holds or sends one, and the
worker appends `Authorization: Bearer …` or `x-bluepencil-auth: …` itself. A page that tries to send
either header in a relay request is refused with `disallowed_header`.

The relay covers the hub's HTTP requests and nothing else. When the page uses the attach loader, its
own manifest (`latest.json`) and element bytes for the digest check still run as page `fetch()` calls and still need
`connect-src`; the element script itself stays under `script-src`. A page **without** the extension —
a plain embed, a bookmarklet, an IIFE build — never gets this path and always needs `connect-src`
for the hub origin. So `script-src` alone is still not enough for such a page. A blocked request
names the URL and the directive it violated:

```
Refused to connect to 'https://hub.example/api/v1/bluepencil/notes' because it violates the following Content Security Policy directive: "connect-src 'self'".
```

(`"default-src …"` appears instead when the page declares no `connect-src`, which is the fallback
directive.) Allow the origin in `connect-src`, or route the request through the extension. The full
recipe, including the loader's manifest and digest fetches, is in
[EMBED.md — CSP: `script-src` and `connect-src`](EMBED.md#csp-script-src-and-connect-src).

The overlay's own CSS remains subject to `style-src`.

The page → bridge channel carries two things, and only the second reaches the worker: one
`chrome.storage.local` call (the layer's own store, so notes survive a reload — the bridge answers
it itself) and one hub request (relayed to the worker). The storage hop is *not* the worker, but it
has its own rule; see **Page-side storage relay** below.

## Storage

The default store is `chromeStorage` (`chrome.storage.local`), which needs no server and no account.
Notes stay in the browser profile.

### Using a hub instead

Switch the store to *on a hub* in the options page and give it a URL. The extension hands the
element a `data-endpoint`; the element's HTTP adapter sends its requests through the service worker
(below), which is what makes notes shared across devices and visible to the MCP server.

The worker is the trust boundary for hub traffic, not the bridge. Any page script can post a relay
request, so the worker enforces all of it: the request must target the configured endpoint's
**origin and base path** (every `{base}/admin` spelling is refused, including a percent-encoded
one), the method must be `GET`, `POST` or `PATCH`, and only `accept`,
`content-type`, `authorization` and `x-bluepencil-auth` are forwarded. A request that arrives with
any other header is refused rather than trimmed, so a misconfiguration is visible instead of silent.
The worker sends `credentials: "omit"`, `cache: "no-store"` and `referrerPolicy: "no-referrer"`:
the layer authenticates with a header, never with a cookie. It also **refuses redirects** rather
than following them — following one would carry the credential to an origin you never configured,
and the browser hides the redirect target, so it cannot be checked first. If a reverse proxy
redirects http to https, save the **final** URL in the options page.

The URL is the **full API base**, base path included — `http://127.0.0.1:8787/api/v1/bluepencil`,
not the bare origin and not `…/notes`; the layer appends `/notes`, `/config` and the other routes
itself. The page stores exactly what you typed and never completes or normalises the URL.

**Test connection** reads the URL and credential that are **on screen**, not the saved ones, so a
value can be tested before it is committed. It stores nothing: the probe writes no settings and no
notes, and its only visible effect is the message next to the button. It asks `GET /config` first
and, when a credential is configured, `GET /notes` with the same header the layer would send. The
`/notes` request is **status-only** — it cancels the response body instead of downloading the note
corpus — so a large or slow hub cannot turn an accepted credential into a timeout. A wrong base path
(`404`), an unreachable hub, a timeout, a rejected credential (`401`/`403`) and a credential that is
not a legal header value are each named as such. A redirect (`30x`) gets its own outcome rather than
"unreachable": the probe does not follow it — that would carry the credential to an origin you never
entered — so a reverse proxy that upgrades http to https or normalises the path is reported as
*the hub redirected*, and the message asks for the final URL (the browser hides the target of an
opaque redirect, Node/undici names it). If `/config` succeeds but the `/notes` check times out or
fails, the page keeps the hub summary and says only that the credential could not be verified — it
does not report the hub as unreachable.

The credential itself is stored trimmed: a paste with a stray newline or surrounding spaces is saved
as the exact value the layer and the probe send, so what is in storage and what goes into the header
cannot drift apart.

**Binding matters more than the credential.** The default is loopback, and a loopback hub needs no
authentication at all — the process is as protected as the file it writes to. The moment you pass
`--host 0.0.0.0` to reach it from another device, the credential is the only thing standing between
the network and your notes.

The options page asks **which** credential the hub expects, because the two are different headers
and picking the wrong one produces a `401` that reads like a dead server:

| Mode | Header | Hub needs | Good for |
|---|---|---|---|
| **None** | – | nothing | loopback only |
| **Shared secret** | `x-bluepencil-auth` | `--auth-secret` / `BLUEPENCIL_AUTH_SECRET` | one string, every client |
| **Signed token** | `Authorization: Bearer …` | `--token-key` / `BLUEPENCIL_TOKEN_KEY` | one credential per device, expiring, revocable |

A shared secret has no expiry and no per-device revocation: every client holds the same string, so
withdrawing it means rotating it everywhere at once. Prefer `BLUEPENCIL_AUTH_SECRET` over the flag —
a secret on a command line is visible in the process list to every other user on the machine.

### A signed token per device

```sh
export BLUEPENCIL_TOKEN_KEY=…            # the same value the hub has
node dist/server.js --store notes.json --host 0.0.0.0   # hub
bluepencil token --device work-laptop    # prints the token on stdout, context on stderr
```

Paste the printed token into the options page, choose *Signed token*, and keep the device name — it is
recorded in the token so a revocation list stays readable by a human. The options page reads the
token's expiry when you save it and then says *"Expires in about 6 h 12 min"*, *"This token has
expired"*, or plainly that the expiry could not be read. That line is a warning, not a decision: only
the hub decides whether a token is good.

Mint with a narrower `--scope read` for a device that should only look, and `--ttl <seconds>` for a
shorter life than the default day. To cut a device off, put the id that `bluepencil token` printed
into the hub's `--revoked-tokens` file and restart it. The hub answers
`401 token_revoked` — which means *do not mint a new one* — as opposed to `401 token_expired`, which
means replace it, and `403 insufficient_scope` for a valid token that may not do what was asked.

### Switching the layer on and off

The layer follows the toolbar button and the Alt+Shift+B keyboard shortcut. The options page no
longer carries *Turn on here* / *Turn off here* buttons; it links the **review page** instead, and
mounting is done from the toolbar or the shortcut on the tab you are looking at. Toggling off sets
the element's `enabled` attribute rather than removing it, so your open notes survive and the layer
can be brought back without a second injection. A page can ask for the same toggle over the bridge:

```js
window.postMessage({ source: "bluepencil-page", kind: "toggle", enabled: false, requestId: "1" },
                    window.location.origin);
```

The answer comes back on the same channel, tagged with your `requestId`. Fire and read it later
rather than awaiting inside one turn — a reply is delivered while a promise registered in the same
tick is still resolving, so awaiting it there deadlocks into a timeout even though the toggle worked.

Both credential phases of [#36](https://github.com/Popoboxxo/bluepencil/issues/36) are in this
release. What is deliberately *not* here: there is no token refresh (an expired token is replaced by
hand) and the revocation list is read when the hub starts, so revoking a device means restarting
it. See *Known gaps* in [CHANGELOG.md](../CHANGELOG.md) for the current list.

### Page-side storage relay

The layer's default store lives in `chrome.storage.local`, which the page's own world cannot reach;
the isolated-world bridge performs that call on its behalf. Storage is partitioned per origin since
0.12: the single key is `bluepencil:v2:<origin>`, derived by the bridge from its own
`window.location` and never from a field the page supplies. The channel is reachable by any page
script, so the bridge accepts exactly that one derived key — for reads, writes and removes alike.
`bluepencil:settings` (the hub endpoint and the credential), the legacy shared blob
`bluepencil:default:v1`, `bluepencil:ui:*` and the assign sidecar `bluepencil:assign:<origin>` are
all refused as `foreign_key` before any storage call happens. A page cannot select another origin's
store by spoofing a key, and an opaque origin (`file:`, a sandboxed frame) has no bucket at all
(`opaque_origin`), so the store degrades to memory there.

This matters for the hub path above: a page that could rewrite the settings could repoint the relay
at any origin and use the worker as a CSP-bypassing egress path. The credential is no longer in the
page's settings object at all (worker-only), and the settings key is out of the page's reach, so the
page world is no longer where a credential could be read or written.

### Residual behaviour to know about

- **No rate cap.** A page can post relay requests as fast as it likes. The worker adds no capability
  the page did not already have (it can reach the hub directly when `connect-src` allows it), and
  the hub is the place to rate-limit; a page-side cap would only be a courtesy against itself.
- **Disabling the extension without a reload.** The transport is registered for the document and is
  never unregistered (a second mount must not lose it, and `disable()`/`enable()` must not either).
  If the extension is disabled or updated while a page stays open, the bridge is gone and each hub
  call waits the full 35 s page-side budget before it fails — it is a timeout, not a crash, but it
  looks like a hang. Reload the page to restore the path.
- **No cancel channel.** An aborted layer request gives up locally; the worker's request runs to its
  own 30 s timeout.

## Permissions, and why these

| Permission | Why |
| --- | --- |
| `activeTab` | inject only into the tab you clicked on |
| `scripting` | inject the layer and the bridge |
| `storage` | `chrome.storage.local` |
| `optional_host_permissions: http://*/*, https://*/*` | optional host access, granted per hub origin |

Host access is **optional**, never install-time: the manifest declares no `host_permissions`. The
options page asks for a hub's origin the first time an HTTP endpoint is saved, inside the click that
pressed Save, because `chrome.permissions.request` only answers while the user gesture is live. The
grant is per origin (`scheme://host/*`; Chrome patterns have no port), a second hub asks for its own
origin, and a granted origin is not prompted again. Injection itself is on demand under `activeTab`:
the overlay enters a page only after an explicit gesture (toolbar click or Alt+Shift+B).

The overlay does **not** survive a navigation in this release: a fresh document has no
`<bluepencil-notes>` until the user invokes the extension again. `file:///*` is deliberately **not**
requested — it buys nothing a web user needs, and it is the permission a store reviewer objects to
first. `<all_urls>` is not used.

## Release checklist RC-1…RC-3

The real grant cannot be produced headlessly — `chrome.permissions.request` needs a live gesture — so
three steps are manual and every release depends on them:

- **RC-1 — hub origin in the options save.** Save an `https://` hub endpoint and confirm the browser
  asks for that origin and accepts the save.
- **RC-2 — toolbar mount on a real profile page.** Click the toolbar button on an ordinary page and
  confirm the overlay mounts.
- **RC-3 — Alt+Shift+B.** Press the shortcut on the same page and confirm the overlay toggles.

The `release` job is bound to the protected GitHub `release` environment; that environment is
approved only after RC-1…RC-3 are confirmed, and the approval confirms the steps rather than proving
them. This grant path is not checked automatically. The same list, with the environment binding, is
in [RELEASING.md — Release checklist RC-1…RC-3](RELEASING.md#release-checklist-rc1rc3).

## Upgrading from 0.11

Read this before pointing an existing profile at 0.12. Several changes are visible and one of them
is a confidentiality regression if you downgrade.

- **Legacy notes are read-only on the review page.** Notes in the old shared blob still exist — the
  data is not deleted — but they no longer appear in the page overlay after the upgrade. They are
  visible only on the review page (`review.html`), read-only, where each legacy note can be copied
  into an origin with an explicit confirm. Undo removes only the copy; the legacy note stays.
- **The default key is per origin.** A host that relied on the shared default must pass
  `key: chromeStorageKey()` explicitly; the productive adapter otherwise writes
  `bluepencil:v2:<origin>` and never `bluepencil:default:v1`.
- **Downgrading is not supported.** 0.11 reads every key, so a `v2` note set looks like nothing to it
  and a downgrade reopens the shared-bucket problem. Clear extension storage before downgrading;
  keeping `v2` data across a downgrade is a confidentiality regression.
- **Every bundle hash changes.** `origin: null` is emitted for every note, so the canonical hash of
  each bundle changes; there is no new migration step.
- **The `token`, `token-header` and `token-scheme` attributes are gone.** The credential is
  worker-only; a page that still sets one of them gets an `issues` entry pointing at the extension
  instead of a silently unauthenticated request.
- **The options buttons are gone.** *Turn on here* / *Turn off here* no longer exist; use the toolbar
  button or Alt+Shift+B, and open the review page from the options page.
- **The route the extension writes is path-only.** The hand-off writes `route="url"`, so a note
  stores `location.pathname` and never the query; the extension offers no query opt-in in 0.12.0
  and never writes `url-with-query`.
- **`file://` is memory-only.** There is no persistent bucket for an opaque origin; the store degrades
  to memory and the tab reports it. Use the local adapter (or a hub) when notes on `file://` pages
  must survive a reload.

The full end-state list, including the route and digest changes, is in
[CHANGELOG.md](../CHANGELOG.md) under `[Unreleased]`.
