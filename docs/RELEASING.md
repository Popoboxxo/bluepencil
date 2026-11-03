# Releasing

A release is a tag. Pushing `v<version>` runs `.github/workflows/release.yml`, which verifies the
tagged commit, builds the assets and publishes them on the GitHub release. There are no manual upload
steps — the order below is the whole procedure.

## What it needs

**Node 22.22.2+, 24.15+ or 26+** for everything below — that is the range `jsdom` 30 declares
(`^22.22.2 || ^24.15.0 || >=26.0.0`). On an older release `npm ci` prints `EBADENGINE` warnings and
the suite may fail inside a transitive dependency, so the error names neither Node nor Vitest. CI
uses Node 22.

## The five minutes before the tag

1. On a branch (`chore/release-<version>`, never on `main`): bump `package.json`. It is the single
   source of truth. `extension/manifest.json` has to match it, and `npm run build:ext` fails on a
   mismatch instead of shipping a stale bundle — so a forgotten bump is a red build, not a wrong
   download.
2. Write the `## [<version>] - <date>` section in `CHANGELOG.md`: Added / Changed / Fixed / Verified /
   **Known gaps**. Name what is *not* in the release. The release notes *are* this section — it is
   copied verbatim, and there is no second place to write them.
3. Update the README status line, and the demo screenshot when the UI changed.
4. `npm run verify`, `npm run secret-scan`, then `npm run spec` and `npm run spec:check`.
5. `node scripts/release-preflight.mjs --tag v<version> --notes /tmp/notes.md` — the same check CI
   runs: tag ↔ `package.json` ↔ `extension/manifest.json` ↔ a non-empty changelog section. It costs a
   second and catches the one mistake that is invisible until the tag exists.
6. PR against `main`, wait for CI, merge.

## Cutting it

```bash
git checkout main && git pull
git tag -a v<version> -m "<version> — see CHANGELOG.md"
git push origin v<version>
```

The workflow then:

- runs `npm run verify` (typecheck, unit tests, build, size guard, then `smoke:components --
  --no-docker` — the component matrix, including the MV3 extension in a real Chrome) with
  `BP_REQUIRE_BROWSER=1`, so a missing browser fails instead of skipping; then `npm run secret-scan`
  and the spec check **on the tagged commit**. Docker is not in that chain; the container/Compose
  shape is verified separately by the `docker-smoke` job (`workflow_dispatch`). A tag is the one
  revision `ci.yml` never sees, because it listens to branches;
- re-runs the preflight, so a tag that disagrees with the versions, or has no changelog section,
  stops before anything is published;
- builds the assets, writes **one** `SHA256SUMS` over all five and verifies the set against it — a
  missing asset or a digest that no longer matches stops the release;
- publishes the release with the changelog section as its body, then attests build provenance. The
  release is published before the attestation, and an attestation failure is reported without costing
  the release;
- and then dispatches the store leg: `chrome-webstore.yml` hands the release's own extension zip to the
  Chrome Web Store (see [The Chrome Web Store](#the-chrome-web-store)). The dispatch is explicit
  because a release published with `GITHUB_TOKEN` does not start workflow runs — the listener cannot
  hear it, which is how v0.4.0 shipped its extension nowhere.

Assets: `attach.js`, `bluepencil.element.min.js`, `bluepencil-<version>.tgz`,
`bluepencil-extension-<version>.zip` (unpack it and load the folder as an unpacked MV3 extension) and
`SHA256SUMS`.

## 0.10.3 — MCP protocol-version negotiation

A patch release: the MCP server answers a client's protocol-version proposal with the revision it
speaks (`2024-11-05`) instead of refusing the handshake, and every later HTTP request still has to
carry that revision. The assets are unchanged — the same four plus `SHA256SUMS`. The release notes
are the `## [0.10.3]` section in [CHANGELOG.md](../CHANGELOG.md).

## 0.10.0 — federation

The release still ships the **same four assets plus `SHA256SUMS`**. The federator is deliberately
**not** a release asset: it ships in two other places — inside the container image as the
`bluepencil-federator` bin, and through the installed package's bins (`dist/federator.js`, declared
as `"bluepencil-federator"` in `package.json`). Do not add a fifth artefact for it.

The image now contains **both** wrapper bins: `bluepencil-hub` (the default entrypoint target) and
`bluepencil-federator` (stdio). The `image` CI job starts both with `--version`, so a hub-only image
fails before the tag is cut.

`release-preflight` requires the version to be **identical** in three places:
`package.json`, `extension/manifest.json` and the `## [<version>]` section in `CHANGELOG.md`. A
disagreement stops the release before anything is published.

Re-running the workflow (`workflow_dispatch` with an existing tag) **updates** the release instead of
failing, so a half-written release is recoverable.

## Release checklist RC-1…RC-3

The extension's real permission grant cannot be produced headlessly: `chrome.permissions.request`
only answers inside a live user gesture, and a headless Chrome has no gesture. Every release
therefore carries three manual steps that the protected GitHub `release` environment gates. The
release job declares `environment: release`, and that environment is approved **only after** RC-1…RC-3
have been confirmed on a real Chrome profile with the release build loaded unpacked. The approval
**confirms** the steps; it cannot **prove** them. This grant path is not checked automatically.

- **RC-1 — hub origin in the options save.** Switch the notes store to *on a hub*, enter an
  `https://` endpoint, press Save, and confirm the browser asks for that origin and the save is
  accepted. A refusal names `permission_denied` and writes nothing.
- **RC-2 — toolbar mount on a real profile page.** On an ordinary web page, click the toolbar
  button and confirm the overlay mounts and a note can be taken.
- **RC-3 — Alt+Shift+B.** On the same page, press Alt+Shift+B and confirm the overlay toggles
  without a second injection prompt.

## The Chrome Web Store

The release job dispatches `.github/workflows/chrome-webstore.yml` once the release is published, and
that workflow hands `bluepencil-extension-<version>.zip` — the asset the release just published, not a
second build — to the Chrome Web Store. The dispatch is deliberate rather than a `release: published`
trigger: a release published with `GITHUB_TOKEN` does not start workflow runs at all, so that listener
would never fire (measured on v0.4.0, whose extension reached no store). The release job therefore
calls `gh workflow run chrome-webstore.yml` itself, which needs `actions: write` on its token — and a
dispatch that fails marks the release run red *after* the release is published, which is the honest
place for it: the release is out, the store leg is not started, and someone has to know.

Before it uploads, that workflow checks the digest against the release's `SHA256SUMS` and the zip's
`manifest.json` version against the tag, so the store cannot receive anything other than the artefact
`verify` smoke-tested. Prereleases are not dispatched: an `-alpha` tag is a release object too, and the
public store is not where those belong.

The upload and the publish are `scripts/chrome-webstore.mjs` in this repository, not a marketplace
action. The action it replaced received the refresh token as an input and used it inside its own code
— a second supply chain sitting exactly on the credential. The script takes the token from the
environment, exchanges it for an access token, uploads the zip, and only with `--publish` sends a
single publish request. Exit codes are stable (`1` configuration, `2` token exchange, `3` upload,
`4` publish, `5` status check), so a red run names the failing stage without reading the log.
`npm run webstore:publish -- --zip <file> --dry-run` prints the plan and makes no request; that is how
to check the wiring locally before a release needs it.

It needs five repository secrets: `EXTENSION_ID`, `PUBLISHER_ID`, and the OAuth trio `CLIENT_ID`,
`CLIENT_SECRET`, `REFRESH_TOKEN`. The dispatch mode maps one-to-one onto the script:

| `action:` | script | effect |
|---|---|---|
| `check-credentials` | `--check-credentials` | reads the item status; writes nothing |
| `upload` | `--zip <zip>` | stages the version; publishes nothing |
| `publish` | `--zip <zip> --publish` | stages it, then one publish request |

**RC-4 — the first run on this path is upload-only.** The first run after the script replaced the
action is dispatched with `action: upload`; the version is then released by hand in the dashboard,
once the listing has been checked there. `action: publish` — what a release does afterwards — is used
only after that. Like RC-1…RC-3, this point is confirmed by the approval of the protected `release`
environment; no test proves it, because it is a decision about when to publish, not a property of the
code.

## The 0.12.0 threat model at the release cut

Re-answered against the final state on **2026-11-03** (spec §4.5, §6(3)/(4)); the substance is in
spec §4.2 (properties) and §4.3 (residual risks).

1. **What is built?** A review layer injected into foreign web apps (browser + Node) with a headless
   data layer, CLI, MCP server, reference hub, federator and an MV3 Chromium extension. Notes live in
   `chrome.storage.local` per origin, optionally on a self-hosted hub, and in exportable bundles. The
   hub accepts a shared secret and/or per-device signed tokens; the page never sees a credential.
2. **What can go wrong?** A cross-site read through the page relay, a credential leak into the page
   context, mounting without a gesture, a hub gate bypass (Host header, unthrottled guessing, body
   before auth), SSRF/oversized federation answers, a downgrade that reopens the shared bucket, and
   supply-chain/container drift.
3. **What do we do about it?** Each risk has a property with a test: worker-only credential and
   sender-bound relays, optional host permissions and on-demand injection, the Host check plus one
   shared throttle and auth-before-body, bounded federation responses, path-only routes, and pinned
   actions with hardened container defaults. The remaining risks are named in spec §4.3.
4. **What are the consequences?** A residual leak would expose review notes (reputation and trust,
   no financial or health data). A hub without a credential on a non-loopback bind stays readable —
   deliberate and warned. A broken `origin` contract would be data loss, so imports are copy-only with
   a visible regression instead of a silent migration.

**Checklist status.** RC-1, RC-2, RC-3 and RC-4 are mandatory steps of the protected `release`
environment and are **not confirmed by this document**; the approver confirms them on a real Chrome
profile with the release build (the approval confirms, it does not prove). This cut records them as
required, not as performed.

## Deliberately not automated

- **npm publish.** The package is installable from the tag —
  `npm i github:Popoboxxo/bluepencil#v<version>` — because `prepare` builds `dist/` during install
  (without it, a git install has no `dist/` and every entry in `exports` points at nothing). Publishing
  to the registry is a separate decision and would need an `NPM_TOKEN` secret plus `--provenance`.
- **The first store submission, and the listing.** The Web Store API can publish a new *version* of an
  item that exists; it cannot create one. Listing copy, permission justifications and screenshots are
  dashboard work, and the review that follows is not something a workflow can hurry. Everything after
  that first submission is automated — see above.

## Failure modes worth knowing

- **`v…` tag without the version bump** → the preflight stops before publishing. Delete the tag, fix,
  retag.
- **`extension/manifest.json` left behind** → `npm run build:ext`, part of `verify`, fails; nothing is
  published.
- **An extension that no longer mounts** → `smoke:ext` runs inside the release job, on the copy that
  would be attached. There is no path that publishes an extension the smoke never saw.
- **A store upload that does not happen** → the release is already published by then, so the store leg
  is a separate job (`.github/workflows/chrome-webstore.yml`) and re-running it is safe: everything up
  to the upload is a download and a check. Read the failure for which of the three it is — the
  credentials (`action: check-credentials` says so on its own), the asset (the digest and version check
  refuses before the store sees it), or the store itself (a version that already exists, or an item
  that does not exist yet — the API cannot create one).
- **A store leg that never started** → the release run's own `Start the store leg` step fails, because
  the dispatch is what starts it and the step does not swallow that. The usual cause is a token
  without `actions: write`; without the step, a release looks entirely successful while its extension
  goes nowhere.
