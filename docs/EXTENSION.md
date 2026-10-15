# The browser extension

bluepencil ships as an installable Chromium extension (MV3). It mounts the same review layer you get
from the embed snippet, on any page, without editing that page.

## Build and install

```sh
npm run build:ext     # writes extension/dist/
```

Then load it: `chrome://extensions` → enable *Developer mode* → *Load unpacked* → pick
`extension/dist`.

`npm run smoke:ext` verifies the build: 67 checks — static artefact checks, the host-embed detection
pinned against fake documents without a browser, and a real Chrome run. The browser run mounts the
layer against a host page with `script-src 'self'`, asserts it actually mounted, and drives a second
page that already carries `<bluepencil-notes>` to prove the extension steps aside there. The options
page has its own cases in that suite — the credential mode, the header it means, and the expiry line —
because the settings UI is the only place a credential is entered and it was otherwise untested.

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

So the only channel that works is a content script **registered** with `world: "MAIN"`: Chrome loads a
packaged file into the page's own world even when the page's CSP forbids everything else. The element
bundle is therefore compiled *into* `src/bootstrap.ts` and ships as one static classic script — no
`eval`, no `new Function`, no dynamic `import()`, no network fetch, at build time or at runtime.

What crosses the boundary at runtime is data: the worker places the settings as a plain object, and
the bootstrap reads them.

## An extension does not bypass a CSP

The layer uses constructable stylesheets (`document.adoptedStyleSheets`) when a page's `style-src`
forbids inline styles (#33). That keeps it working *inside* a policy, not around it. The smoke test
runs against a strict-CSP host on purpose: it is the case that used to break.

## Storage

The default store is `chromeStorage` (`chrome.storage.local`), which needs no server and no account.
Notes stay in the browser profile.

### Using a hub instead

Switch the store to *on a hub* in the options page and give it a URL. The extension then hands the
element a `data-endpoint` and the element talks to the hub directly, which is what makes notes
shared across devices and visible to the MCP server.

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

The layer follows the toolbar button, and the options page has *Turn on here* / *Turn off here* for
the tab you are currently looking at. Turning it off sets the element's `enabled` attribute rather
than removing it, so your open notes survive and the layer can be brought back without a second
injection. A page can do the same:

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

## Permissions, and why these

| Permission | Why |
| --- | --- |
| `activeTab` | inject only into the tab you clicked on |
| `scripting` | inject the layer and the bridge |
| `storage` | `chrome.storage.local` |
| `tabs` | resolve the active tab's URL |
| `http://*/*`, `https://*/*` | host access, granted up front |

Host access is a deliberate, conservative **pre-grant**. Injection itself is on demand: the overlay only
enters a page after an explicit user gesture (toolbar click, Alt+Shift+B, the options *Turn on here*, or
the page's own `request-mount`), into the tab the user is looking at. The up-front grant is broader than
that on-demand injection strictly needs, but it is what lets the overlay be available the moment the
user asks for it on any site, without a second prompt. It also keeps the headless round trip testable —
a real benefit, though not the reason the permission is in the manifest.

The overlay does **not** survive a navigation in this release: a fresh document has no
`<bluepencil-notes>` until the user invokes the extension again. `file:///*` is deliberately **not**
requested — it buys nothing a web user needs, and it is the permission a store reviewer objects to
first. `<all_urls>` is not used.
