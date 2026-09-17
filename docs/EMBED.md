# Embed / attach reference

> One script tag to drop the review layer on any page — with or without a backend.
> Store contract: [ARCHITECTURE.md §5](ARCHITECTURE.md#5-http-contract-reference-server).
> Host-side recipe: [INTEGRATION.md §6](INTEGRATION.md#6-admin-debug-mode-in-a-product-fr-104).

---

## 1. Choosing a mode

| Mode | When | Effort |
|---|---|---|
| **Whole system, own backend** | You already have (or will build) an endpoint that implements the store contract (§4 below) | Implement the 7 endpoints, then add the loader snippet |
| **Whole system, no backend** / **single-file deck** | A quick review round, no server wanted; or a self-contained presentation file | One `<script>` tag; notes persist in `localStorage` |
| **Bundled sidecar** | Static sites, quick demos, teams that want persistence without writing a backend | One command: `node dist/server.js …` (see §4) |

Pick the row that matches your host. The rest of this document covers the
details.

## 2. The one-line attachment

### Script-tag form (auto mode)

```html
<script src="../../dist/attach.js"
        data-endpoint="/api/v1/bluepencil"
        data-adapter="localStorage"
        data-language="de"
        data-environment="dev"
        data-gate="myApp.canReview"></script>
```

The loader defines the `<bluepencil-notes>` custom element and, when
`data-auto` is `true` (the default), appends the element to
`document.body`. No other code is required.

### Element form (manual mount)

```html
<bluepencil-notes adapter="localStorage"
                  language="de"
                  environment="dev"
                  enabled="true"
                  mount="#review-slot">
</bluepencil-notes>
<script src="../../dist/bluepencil.element.min.js"></script>
```

The host provides a `<div id="review-slot">` and appends the element
itself; `data-auto="false"` (or a plain element tag) gives full
control over when and where the layer mounts.

### Attribute reference

The table below lists every element attribute and its loader
equivalent (`data-*`). The loader mirrors every element attribute
1:1 — drop the attribute name, add the `data-` prefix.

#### Element attributes (on `<bluepencil-notes>`)

| Attribute | Default | Meaning |
|---|---|---|
| `enabled` | unset → the host's own `init()` call is the opt-in | `"false"` disables the layer; any other value enables it. |
| `adapter` | unset → `"memory"` | Storage backend: `"memory"`, `"localStorage"`, `"file"`, or `"http"`. Presence of `endpoint` implies `"http"`. |
| `language` | `"en"` | UI language (`"en"`, `"de"`). |
| `identity` | `"prompt"` | Author identity: `{ getUser() }`, `"prompt"` (author field), or `"anonymous"`. |
| `session` | – | Session reference string, forwarded to the store. |
| `environment` | – | Environment name; notes are scoped per environment (NFR-18). |
| `show-done` | `"false"` | `"true"` to start with done notes visible. |
| `theme-accent` | – | Accent colour override. |
| `theme-surface` | – | Surface colour override. |
| `theme` | – | JSON object of theme tokens: `{"accent":"…","surface":"…","ink":"…","muted":"…","line":"…"}`. `theme-accent`/`theme-surface` win over `theme`. |
| `mount` | – | CSS selector for the element's mount target. Absent → the host mounts the element itself. |
| `endpoint` | – | Base URL of the notes API, absolute or root-relative (e.g. `"/api/v1/bluepencil"`). Presence implies `adapter="http"`. |
| `headers` | – | JSON object with extra request headers, e.g. `{"X-Workspace":"7"}`. |
| `headers-from` | – | Global path to a function returning headers, evaluated on every request (refreshed tokens), e.g. `"window.__bpHeaders"`. Wins over `headers`. |
| `token` | – | Convenience: written into the header named by `token-header` (default `Authorization`). Verbatim unless `token-scheme` is set. |
| `token-header` | `"Authorization"` | Header name for `token`. |
| `token-scheme` | – | Prefixed scheme for `token` (e.g. `"Bearer"` → `Authorization: Bearer ***`). Default: none (verbatim). |
| `route` | – | `"url"` → store `location.pathname + location.search` as the anchor route (SPA hosts). |
| `route-from` | – | Global path to a function returning the route (router-aware hosts). It is called as `fn(element)` with the annotated element, so the route belongs to *that* note; a zero-parameter host keeps working. Wins over `route`. |
| `gate` | – | Global path to a function (or boolean) that decides whether the layer may exist; ANDed with `enabled != "false"`. Re-evaluated on every `enable()`. |

A note's route comes from the element that was annotated, not from the scroll position: with
`route-from` the host is asked as `fn(element)`. That is not a cosmetic detail — on a scroll-animated
one-pager a `nav a.is-active` style hook was **measured** to lag a whole chapter behind, while a host
that answers from the clicked element cannot. Zero-parameter hosts are unaffected, so existing
integrations keep working.

#### Loader keys (`data-*` attributes on the `<script>` tag)

Every element attribute above has a `data-*` mirror. The loader also
recognises these additional keys:

| Key | Default | Meaning |
|---|---|---|
| `data-src` | `<dir of attach.js>/bluepencil.element.min.js` | Where the element build is loaded from. May contain `{version}`, which is replaced by `data-version`. |
| `data-version` | – | Version label the loader reports (and the value substituted into `{version}` in `data-src`). With `data-manifest` the version comes from the manifest and this key is only informational. |
| `data-manifest` | – | URL of a JSON manifest for runtime updates: `{"version":"…","element":"…","sha256":"…"}`. |
| `data-integrity` | `"false"` | `"true"` to verify the `sha256` from the manifest with WebCrypto before executing. |
| `data-watch` | `"0"` | Seconds between manifest polls; `0` = off. On a version change the old layer is torn down and the new version mounted. |
| `data-tag` | `"bluepencil-notes"` | Element tag name to create. |
| `data-auto` | `"true"` | `"false"` = only define the custom element; the host mounts the element itself. |

#### Header resolution order

1. `headers` (static object) → merged
2. `headers-from()` result → merged on top
3. `token` → written last into the header named by `token-header` (wins)

## 3. Updates at runtime (optional)

Bluepencil supports a **manifest-driven update path**: the loader polls a
JSON manifest, compares versions, tears down the old layer, and mounts
the new one — all without a page reload.

### Manifest contract

The manifest is a JSON file with three required keys:

```json
{
  "version": "0.2.1",
  "element": "https://cdn.example/bluepencil/0.2.1/bluepencil.element.min.js",
  "sha256": "a1b2c3d4…"
}
```

| Field | Type | Meaning |
|---|---|---|
| `version` | string | Version label; any difference from the running version triggers the swap (it is compared for equality, never ordered). |
| `element` | string | URL of the `bluepencil.element.min.js` build for this version, resolved against the manifest URL. |
| `sha256` | string | Hex-encoded SHA-256 hash of the element file; verified whenever `data-integrity="true"` is set. |

### Loader attributes for runtime updates

| Attribute | Behaviour |
|---|---|
| `data-manifest` | URL of the manifest (enables polling). |
| `data-version` | Set to `"latest"` (the default when `data-manifest` is present) to always follow the manifest. |
| `data-watch` | Polling interval in seconds; `0` = off. |
| `data-integrity` | `"true"` to verify the manifest `sha256` against the fetched file with WebCrypto before executing it. |

### `window.bluepencilAttach` API

After the loader runs, `window.bluepencilAttach` exposes:

| Property / Method | Type | Meaning |
|---|---|---|
| `version` | `string` | Version of the element build the loader mounted last (`"unknown"` when it used the sibling build). |
| `src` | `string` | URL the element build was loaded from. |
| `instances` | `Element[]` | The `<bluepencil-notes>` elements the loader mounted, in attach order. |
| `destroy()` | `() => void` | Removes every mounted element and its layer. |
| `reload()` | `() => Promise<number>` | Explicit runtime update: re-reads the manifest and mounts the new version when it changed. Resolves with the number of swapped instances (`0` = already current). |
| `check()` | `() => Promise<number>` | The same read without the round trip — what `data-watch` calls on its interval. |

Those six keys are the documented surface. A host that needs the per-script view has two more:

| Member | Type | Meaning |
|---|---|---|
| `handles` | `AttachHandle[]` | One handle per loader script tag on the page. |
| `attach(options)` | `(options) => Promise<AttachHandle>` | Programmatic attach (for hosts that import the loader from a bundler instead of using a script tag). |

Each `AttachHandle` (also the return value of `attach()`):

| Member | Type | Meaning |
|---|---|---|
| `version` | string | Version the handle believes it mounted (`"unknown"` when it used the sibling build). |
| `src` | string | URL the element module was loaded from. |
| `element` | `Element \| null` | The mounted `<bluepencil-notes>`, or `null` with `data-auto="false"`. |
| `check()` | `() => Promise<boolean>` | Re-reads the manifest and swaps the layer when the version changed; `true` when it swapped. |
| `reload()` | `() => Promise<void>` | Explicit runtime update — an alias of `check()`. |
| `destroy()` | `() => void` | Tears down the element, the layer and the watch timer. |

```js
// Runtime update on demand, e.g. from a "check for a new review build" button:
await window.bluepencilAttach.reload();          // documented surface
await window.bluepencilAttach.handles[0]?.reload(); // same thing, per script tag
```

### Document events

| Event | `detail` | Meaning |
|---|---|---|
| `bp-attach-ready` | `{ version, src }` | Loader finished; element is mounted. |
| `bp-attach-error` | error object | Loader or element mount failed (also emitted to `console`). |
| `bp-attach-updated` | `{ from, to }` | Runtime update completed; `from`/`to` are version strings. |

### Verifying the attach in a host

The attach is observable from the host, so a host can assert it instead of trusting it:

```js
document.addEventListener("bp-attach-ready", (event) => {
  console.log(event.detail.version, event.detail.src); // what was mounted
});
document.addEventListener("bp-attach-error", (event) => console.error(event.detail));
document.addEventListener("bp-attach-updated", (event) => console.log(event.detail.from, "→", event.detail.to));
```

`examples/attach` is a fixture host app that does exactly this. Open it with `?selftest=1` and it
probes the host-visible facts — the mounted element and its breadcrumbs, the layer styles, an HTTP
round trip through the store, the per-request header function, `check()` without a manifest — and
writes a machine-readable result block into the page:

```html
<pre id="bp-selftest" data-status="pass" data-count="8/8">selftest: PASS attach-ready …</pre>
```

`npm run smoke:embed` serves that page with the sidecar and drives it in a real browser — including
a live version swap of the shipped `attach.js` — so the contract is verified end to end and not
only in unit tests. See [examples/attach/README.md](../examples/attach/README.md).

### Recommended hosting layout

```
/bluepencil/
  latest.json                         ← no-store, revalidated every request
  <version>/
    attach.js                         ← immutable, version-pinned URL
    bluepencil.element.min.js         ← immutable
```

| Path | Cache header | Rationale |
|---|---|---|
| `/bluepencil/<version>/*` | `Cache-Control: immutable` | Content-addressed by version; never changes. |
| `/bluepencil/latest.json` | `Cache-Control: no-store` | Must be revalidated every request so new versions are discovered. |

### Caveats

* **One script slot per page is the intended setup.** Several loader
  scripts are supported (one handle and one mount each), but they share
  the page — do not point them at different stores.
* **CSP `script-src` must allow the loader origin.** A strict
  `script-src` CSP needs an explicit allowlist entry for the URL of
  `attach.js`.
* **Subresource Integrity (SRI):** when `data-integrity="true"`, the
  manifest's `sha256` is verified with WebCrypto. The element file must
  be served from the **same origin** or with appropriate
  `Access-Control-Allow-Origin` headers (CORS) for the hash to be
  fetchable.

## 4. The store contract

Any backend — Django, Rails, Express, Go, Node — that implements these
endpoints can serve as the notes store for an HTTP-attached
bluepencil layer. The bundled sidecar (`dist/server.js`) implements
them out of the box.

### Endpoint table

| Method | Path | Request | Response |
|---|---|---|---|
| `GET` | `{base}/health` | – | `{ ok: true, status, version }` |
| `GET` | `{base}/notes` | Query params: `route`, `intent`, `type`, `session`, `source`, `environment`, `includeDone`, `since`, repeated `status` | `{ notes: Note[] }` |
| `POST` | `{base}/notes` | `NoteDraft` JSON | `{ note: Note }` |
| `PATCH` | `{base}/notes/{id}` | Note patch (fields only) | `{ note: Note }` |
| `POST` | `{base}/notes/{id}/messages` | `{ id, ts, text, author, author_type, kind }` | `{ note: Note }` |
| `POST` | `{base}/notes/bulk-delete` | `{ ids?: string[], filter?: NoteFilter, confirm: boolean }` | `{ removed: number }` |
| `GET` | `{base}/sessions` | – | `{ sessions: Session[] }` |
| `GET` | `{base}/bundle` | – | Canonical bundle (`src/data`) — for agents and exports. |
| `GET` | `{base}/journal` | optional `?since=<seq>` | `{ journal: { backend, location, entries, lastSeq }, entries }` — the mutation history (FR-18). |

`{base}` defaults to `/api/v1/bluepencil`. Error conventions: `confirm:
true` required for bulk-delete (else `400`); unknown note id → `404`;
malformed JSON → `400`; wrong content type → `415`; wrong method →
`405`.

Full HTTP contract reference: [ARCHITECTURE.md §5](ARCHITECTURE.md#5-http-contract-reference-server).

### What the sidecar adds

The bundled sidecar (`node dist/server.js`) implements the above
endpoints **plus**:

* **Environment isolation (NFR-18):** writing a note in another
  environment returns `400` unless `--allow-env-mismatch` is passed.
* **Persistence:** canonical bundle JSON on disk (atomic write: temp
  file + rename, temp removed in `finally`).
* **Markdown mirror:** optional `--mirror notes.md` generates a
  Markdown file alongside the JSON store.
* **Static mode:** `--root <dir>` serves files with an `index.html`
  fallback, so one origin serves both the presentation page and the
  API.
* **Store journal (FR-18):** every accepted mutation is recorded — in
  the surrounding git work tree when there is one, otherwise in a
  hash-chained file next to the store; `--journal none` switches the
  history off. See below.

```bash
node dist/server.js \
  --store notes.json \
  --port 8787 \
  --root examples/attach \
  --environment dev \
  --cors 'http://localhost:9283'
```

### The store journal (FR-18)

`--journal auto` (the default) decides from the infrastructure the deployment already has:

| Backend | Chosen when | What it writes |
|---|---|---|
| `git` | the store lives inside a git work tree | stages `--store` (and `--mirror`), skips an empty diff and commits — batched over `--journal-coalesce` ms (default 2000), so a review round is not one commit per click. `--journal-author "Name <mail>"` and `--journal-subject "…"` (`{count}`, `{op}`, `{app}`) shape the commit. |
| `file` | no work tree (the fallback) | appends one line per mutation to `journal.jsonl` next to the store: `{ seq, ts, op, noteId, actor, summary, prevHash, hash }`, every line hashing the one before it |
| `none` | `--journal none`, or a backend that cannot be created | nothing — notes are served as usual, the reason is reported |

```bash
# history inside the repository the store lives in
node dist/server.js --store notes.json --journal auto \
  --journal-author "Daniel Duchrow <Popoboxxo@users.noreply.github.com>"

# no git around: hash-chained file, still auditable
node dist/server.js --store notes.json --journal file --journal-dir /var/lib/bluepencil

# an explicitly unrecorded deployment
node dist/server.js --store notes.json --journal none
```

A journal failure never fails a request: the note is on disk before the journal is written, so a
failure is reported once on `stderr` and stays visible in `GET {base}/journal`. A backend that was
requested but cannot be provided degrades to `none` **with a reason** (`--journal git` outside a work
tree) instead of silently doing nothing.

**Careful with tests and fixtures:** inside a work tree `auto` really commits. Any suite that points
its store into the repository must pass `--journal none`, or it will write commits into the project.

**Where the commit lands — read this before pointing `--journal git` at a real repository:** the
commit goes onto **the branch that is checked out in that work tree**, whatever that branch happens
to be. The sidecar only runs `git add` and `git commit`; it never runs `git switch`, never stashes and
never rebases. Pointed at a repository whose working tree sits on a feature branch, every note edit
becomes a commit on that feature branch: inside its diff, inside its history, and absent from the
branch whose review you were preparing. That is not something to fix by guessing branches — it is a
deployment decision:

* give the sidecar its **own work tree** — a dedicated clone, or `git worktree add` for the notes
  branch — so the branch it commits to is fixed by construction instead of by whatever a human left
  checked out. Where the working tree is a coincidence rather than a decision, run `--journal file`
  and leave git out of it.
* the commit is **path-limited**: `git add -- <store> <mirror>` and `git commit --only -- <store>
  <mirror>`. Work that somebody else staged in that tree stays untouched. Before this, the sidecar
  committed the whole index, so a colleague's staged changes could ride along in a notes commit.
* the coalescing window belongs to the sidecar, not to a user: two reviewers clicking inside the same
  window produce **one** commit, and the journal keeps both mutations behind it.

**Whose name is on the commit:** without configuration the commits carry **the identity of the
repository** the work tree uses — on a shared host that is often not the identity you want, and the
result is a history that nobody recognizes as their own. Set it once per deployment:

```bash
# the flag wins over the environment
node dist/server.js --store notes.json --journal git \
  --journal-author "hermes <hermes@duchrow.local>"

# or pinned in the unit's environment (start script, systemd unit, compose file)
BLUEPENCIL_JOURNAL_AUTHOR="hermes <hermes@duchrow.local>" \
BLUEPENCIL_JOURNAL_SUBJECT="chore(notes): {count} change(s) in {app}" \
  node dist/server.js --store notes.json --journal git
```

Author **and** committer are set, so `git log` shows one identity instead of two. Which identity is in
use is reported by `GET {base}/journal` (`journal.author`) — no guessing and no reading it out of the
log afterwards.

### Which version is running (FR-19)

`package.json` is the single source. esbuild stamps it into every bundle, so the same string answers
"which build is this" everywhere a host, an operator or a bug report looks:

| Where | How |
|---|---|
| On the element | `<bluepencil-notes data-bp-version="0.1.0">` — written on connect, so devtools answers the question on the page itself |
| On the loader API | `window.bluepencilAttach.version` — the manifest's version when there is a manifest, otherwise the version of the build that was actually loaded (it used to report `unknown`) |
| On the mounting | `attach-version="…"` set by the loader, plus `event.detail.version` of `bp-attach-ready` / `bp-attach-updated` |
| On the sidecar | `GET {base}/health` and `node dist/server.js --version` |
| On CLI / MCP | `bluepencil --version`, the MCP `initialize` handshake |

The library exports the same value as `VERSION`. A unit test keeps stray version literals out of the
sources, so the numbers cannot drift apart again; running straight from the sources (unit tests,
`tsx`) reports `"dev"`, which is honest — there is no release yet.

## 5. Gate it (never load it for end users)

The review layer is a developer/admin tool. It must never appear for
end users. Two gates are required — **UI gate** and **server gate** —
and they must be enforced independently.

### Recipe (FR-10.4 pattern)

```html
<!-- Gate: only load for admins AND a feature flag -->
<script src="../../dist/attach.js"
        data-gate="myApp.reviewNotesAllowed"
        data-endpoint="/api/v1/bluepencil"
        data-token="..."
        data-environment="dev"></script>
```

```js
// The gate is a *path to a function*, evaluated on every enable() — the decision itself lives in
// the host, where flags and roles are known:
window.myApp.reviewNotesAllowed = () => myApp.features.reviewNotes && myApp.user.isAdmin;
```

`gate` resolves a dotted global path (an optional `window.` prefix is stripped) and accepts **a
function or a boolean**. An expression like `"myApp.features.reviewNotes && user.isAdmin"` is not
evaluated — it is a path, not code, and an unresolvable path is reported (`bp-error`) instead of
being ignored. The loader ANDs the gate's result with `enabled != "false"`, and the path is
re-resolved on every `enable()` — so a plain boolean flag in the host's global scope works and a
flag flipped at runtime reaches the next `enable()`.

### Server-side enforcement (mandatory)

The UI gate is not enough. The **backend must enforce the same check**:

1. **Only admins may read, write, or delete notes.** Unauthorised
   callers get `403` / `404` without leaking note existence
   ([PROTOCOL.md](PROTOCOL.md), FR-9.2).
2. **Scope by tenancy.** Notes belong to a workspace; cross-tenant
   reads must be impossible.
3. **Audit every deletion** with actor, filter, and count (FR-8.5).
4. **Purge by session** after a review round; offer retention for done
   notes older than N days.
5. **Prove the gate with a test** that asserts the layer is absent
   when the flag is off.

Full host-side checklist: [INTEGRATION.md §6](INTEGRATION.md#6-admin-debug-mode-in-a-product-fr-104).

## 6. Security & privacy

* Notes are **review artefacts**, not a data store. The rule is "no
  personal data in notes" — keep the policy explicit and enforce it.
* **Tenant scoping:** notes belong to a workspace/tenant. Cross-tenant
  reads are forbidden at the API level.
* **Audit deletions:** every `bulk-delete` carries actor, filter, and
  count (FR-8.5).
* **Purge after a round:** offer session-scoped retention, then clean
  up; notes older than N days may be archived or deleted.
* **CSP / TLS:** the loader must be served from the same origin or a
  trusted CORS origin. The API endpoint must be HTTPS in production.
  A strict `script-src` CSP needs an explicit allowlist entry for the
  loader URL.
* **Never load for production end users:** the gate is enforced in the
  UI (see §5) **and** on the server. Treat any unauthorised access to
  the API as a security incident.
* The library stores no credentials and performs no request the host has
  not configured. All user-provided text is rendered as **text**; HTML
  in a note is displayed literally (FR-9.3). Full security notes:
  [INTEGRATION.md §9](INTEGRATION.md#9-security--privacy-notes).

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Nothing appears | `gate` returned false, or `enabled="false"` was set. | Check the `gate` global path resolves to a function or a boolean. Listen for `bp-error` and read `element.issues` — an unresolvable path is reported there. |
| Clicks do nothing | Adapter failed on first load (buttons disabled). | Listen for `bp-error` events; check `window.bluepencilAttach` exists. |
| `endpoint` returned HTML instead of JSON | Wrong origin, or the SPA does not proxy the API path. | Verify the endpoint URL returns `Content-Type: application/json`. Use `curl` to test. |
| `401` / `403` from the API | Token is missing, expired, or misconfigured. | Check `data-token`, `data-token-header`, `data-token-scheme` on the script tag. |
| Notes lose their element (marker drift) | Anchor resolved to an unstable path. | Add a stable `data-testid` or `data-bluepencil` hook to the target element. |
| Version not updating (manifest cache) | Browser cached `latest.json`. | Ensure `latest.json` is served with `Cache-Control: no-store`. |
| Element unknown / not defined | The element script loaded **after** the host tried to use `<bluepencil-notes>`. | Ensure `attach.js` or `bluepencil.element.min.js` loads before the element is placed in the DOM. |

---

## Cross-references

* Store contract: [ARCHITECTURE.md §5](ARCHITECTURE.md#5-http-contract-reference-server)
* Host-side integration: [INTEGRATION.md §2](INTEGRATION.md#2-embedded-http-adapter)
* Admin debug mode recipe: [INTEGRATION.md §6](INTEGRATION.md#6-admin-debug-mode-in-a-product-fr-104)
* Security & privacy: [INTEGRATION.md §9](INTEGRATION.md#9-security--privacy-notes)
* Agent protocol: [PROTOCOL.md](PROTOCOL.md)
* Requirements: [REQUIREMENTS.md](REQUIREMENTS.md) (FR-10.4, FR-9.x, FR-14, NFR-18)
