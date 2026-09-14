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
  getUser: () => ({ id: currentUser.id, name: currentUser.displayName }),
  getRoute: () => location.pathname + location.search,
  language: navigator.language.startsWith("de") ? "de" : "en",
});
```

The reference server expects the contract in [ARCHITECTURE.md §5](ARCHITECTURE.md#5-http-contract-reference-server);
any backend implementing those seven endpoints works.

## 3. Embedded, local only

```ts
init({ adapter: "localStorage", getUser: () => ({ name: "Daniel" }) });
```

Notes survive reloads in that browser, can be exported to a file, and are removed when the
user clears site data. Good for a single reviewer; not for a team.

## 4. Bookmarklet (no deploy)

1. Host the IIFE build somewhere reachable (`https://your-host/bluepencil.js`).
2. Put the loader (see [ARCHITECTURE.md §6](ARCHITECTURE.md#6-bookmarklet)) in a bookmark.
3. Click it on any page → the layer attaches, notes go to `localStorage`, export writes a file.

Limits worth knowing: strict `script-src` CSP blocks external loaders (use the self-hosted mode
or a browser extension instead), and nothing is shared between browsers.

## 5. Self-hosted sidecar

The `server/` package serves a static site **and** the API on one port, with the note store as
a JSON file plus a generated Markdown mirror. Deploy as a container behind your usual proxy;
make sure the port is actually published (a listening process inside a container is not
automatically reachable from the network).

## 6. Admin debug mode in a product (FR-10.4)

This is the pattern the library was designed around.

```ts
init({
  enabled: () => me.roles.includes("admin") && featureFlag("uiDebugNotes"),
  adapter: httpAdapter({ endpoint: "/api/v1/debug-notes", headers: authHeaders }),
  getUser: () => ({ id: me.id, name: me.email }),
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
5. **Expose an agent interface** (MCP tool group: list / create / update / export /
   bulk-delete) so an agent can work the notes off — see [PROTOCOL.md](PROTOCOL.md).
6. **Never load the layer for end users**: build-time flag *and* the role gate. Prove it with a
   test that asserts the layer is absent when the flag is off.

## 7. Host hooks

| Hook | Purpose | Default |
|---|---|---|
| `enabled()` | Decide whether the layer exists at all | `() => false` (fail closed) |
| `adapter` | Where notes live | `memory` |
| `getUser()` | Author identity | anonymous |
| `getRoute()` | SPA-aware route for anchoring | `location.pathname` |
| `canAnnotate(el)` | Which elements may be annotated | all except layer internals |
| `language` | UI language | `navigator.language` |
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
system — including dark mode (`prefers-color-scheme`) and reduced motion.

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
| Bookmarklet blocked | CSP without external script allowance — use self-hosted or extension mode |
