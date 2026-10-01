# Releasing

A release is a tag. Pushing `v<version>` runs `.github/workflows/release.yml`, which verifies the
tagged commit, builds the assets and publishes them on the GitHub release. There are no manual upload
steps — the order below is the whole procedure.

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

- runs `npm run verify` (typecheck, unit tests, build, size guard, every smoke — including the MV3
  extension in a real Chrome), `npm run secret-scan` and the spec check **on the tagged commit**. A
  tag is the one revision `ci.yml` never sees, because it listens to branches;
- re-runs the preflight, so a tag that disagrees with the versions, or has no changelog section,
  stops before anything is published;
- builds the assets, writes **one** `SHA256SUMS` over all five and verifies the set against it — a
  missing asset or a digest that no longer matches stops the release;
- publishes the release with the changelog section as its body, then attests build provenance. The
  release is published before the attestation, and an attestation failure is reported without costing
  the release.

Assets: `attach.js`, `bluepencil.element.min.js`, `bluepencil-<version>.tgz`,
`bluepencil-extension-<version>.zip` (unpack it and load the folder as an unpacked MV3 extension) and
`SHA256SUMS`.

Re-running the workflow (`workflow_dispatch` with an existing tag) **updates** the release instead of
failing, so a half-written release is recoverable.

## Deliberately not automated

- **npm publish.** The package is installable from the tag —
  `npm i github:Popoboxxo/bluepencil#v<version>` — because `prepare` builds `dist/` during install
  (without it, a git install has no `dist/` and every entry in `exports` points at nothing). Publishing
  to the registry is a separate decision and would need an `NPM_TOKEN` secret plus `--provenance`.
- **Chrome Web Store.** The extension ships as a zip for `chrome://extensions` → *Load unpacked*. A
  store listing is its own project: review, permission justifications, screenshots.

## Failure modes worth knowing

- **`v…` tag without the version bump** → the preflight stops before publishing. Delete the tag, fix,
  retag.
- **`extension/manifest.json` left behind** → `npm run build:ext`, part of `verify`, fails; nothing is
  published.
- **An extension that no longer mounts** → `smoke:ext` runs inside the release job, on the copy that
  would be attached. There is no path that publishes an extension the smoke never saw.
