# The browser extension

bluepencil ships as an installable Chromium extension (MV3). It mounts the same review layer you get
from the embed snippet, on any page, without editing that page.

## Build and install

```sh
npm run build:ext     # writes extension/dist/
```

Then load it: `chrome://extensions` → enable *Developer mode* → *Load unpacked* → pick
`extension/dist`.

`npm run smoke:ext` verifies the build: 32 checks, of which the last dozen drive a real Chrome
against a host page with `script-src 'self'` and assert the layer actually mounted there.

## What it looks for on a page

Nothing. The extension injects only when you ask it to, and only into the tab you are looking at.

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
Notes stay in the browser profile. Switching to a Sidecar store is a settings change; see
[issue #36](https://github.com/Popoboxxo/bluepencil/issues/36) for the authentication and sync work
that is not in this release yet.

## Permissions, and why these

| Permission | Why |
| --- | --- |
| `activeTab` | inject only into the tab you clicked on |
| `scripting` | inject the layer and the bridge |
| `storage` | `chrome.storage.local` |
| `tabs` | resolve the active tab's URL |
| `http://*/*`, `https://*/*` | host access, granted up front |

Host access is granted at install time on purpose. Without it the extension can only inject after a
real click, which is the right product behaviour but makes the round trip untestable in a headless
browser. `file:///*` is deliberately **not** requested — it buys nothing a web user needs, and it is
the permission a store reviewer objects to first. `<all_urls>` is not used.
