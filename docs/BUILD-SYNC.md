# Build sync

The browser extension does not re-bundle the annotation layer. It copies
`dist/bluepencil.element.iife.js` verbatim into `extension/dist/` and loads that file from its own
origin. One implementation, two consumers — which is the point, and also the failure mode: build the
library, forget the extension, and the extension ships an element bundle that no longer matches the
code. It installs, it passes a shallow check, and it quietly lacks the fix.

Two facts make that drift detectable. `extension/dist/build-info.json` records the SHA-256 of the
bundle the extension was built against, so the extension can prove which library artefact it carries.
And `package.json` is the version single source of truth: the manifest, the build-info and the
library all derive their version from it. The guards below pin both.

## Guard surface

| Piece | npm script | Wired into |
|---|---|---|
| Identity gate | `npm run verify:sync` | local `verify` chain (after `build:ext`); CI `verify` job step **Extension/library sync gate** |
| Version-bump gate | `npm run check-version-bump` | CI `bump` job (pull requests only, `fetch-depth: 0`) |
| Watch auto-build | `scripts/build.mjs --watch` | the dev watch loop; no standalone script |
| Provenance | (written by `npm run build:ext`) | `extension/dist/build-info.json` |
| Pre-push hook | `npm run build:ext && npm run verify:sync` | local git hook, opt-in (see below) |

### Identity gate — `npm run verify:sync`

`scripts/verify-sync.mjs` compares four build inputs and reports *every* inconsistency in one run:

- `sha256(dist/bluepencil.element.iife.js)` must equal `extension/dist/build-info.json.elementSha256`
  — the extension carries exactly the bundle the library just built;
- `extension/manifest.json.version` must equal `package.json.version`;
- `extension/dist/build-info.json.version` must equal `package.json.version`.

A missing input is a named error that points at the build step — "run `npm run build`" / "run
`npm run build:ext`" — not a stack trace. It sits in the local `verify` chain immediately after
`build:ext`, so the two builds and the comparison are one command. In CI it is the
**Extension/library sync gate** step of the `verify` job, after *Build extension (MV3)* — a stale or
mismatched bundle cannot ship unnoticed.

### Version-bump gate — `npm run check-version-bump`

`scripts/check-version-bump.mjs` diffs the merge base against `HEAD` (`git diff --name-only
<merge-base>...HEAD`) and fails when a behavioural path changed without a `package.json` version
bump. The behavioural paths are `src/`, `src/element/`, `extension/src/`, `extension/manifest.json`,
`extension/options.html` and `server/` — everything that ends up inside a shipped artefact.

Used from the repository root it accepts `--base <ref>` (default `origin/main`). CI's `bump` job runs
it as `node scripts/check-version-bump.mjs --base "origin/${{ github.base_ref }}"`. The job is
pull-request-only and checks out with `fetch-depth: 0`, because a three-dot diff needs real history,
not a shallow clone.

An unresolvable base ref is a **warning and exit 0**, never a failure: a local run without an
`origin` remote, a shallow clone or a detached `HEAD` must not turn into a false red. CI has the ref,
so a real violation still fails there.

### Watch auto-build — `scripts/build.mjs --watch`

Under `--watch`, the element builds (`element`, `element-iife`) carry an esbuild `onEnd` plugin that
re-runs `extension/build.mjs` whenever the element bundle is rebuilt — coalesced by a ~200 ms
debounce and guarded so only one extension build runs at a time (a burst of saves triggers one run,
with at most one follow-up). A failed auto-build logs a warning and keeps the watch loop alive; it
never tears down the dev server. Without this, the library is always fresh under `--watch` while the
extension silently stays a version behind, and `smoke:ext` would run against yesterday's artefact.

### Provenance — `extension/dist/build-info.json`

`npm run build:ext` writes `{ version, elementSha256, gitSha }`. `gitSha` is `git rev-parse HEAD`, so
a shipped extension can be traced back to its commit. It is `null` when git is unavailable (no
`.git`, a non-repo export) — a missing commit is a metadata gap, never a build failure.

## Affected matrix

What a change touches tells you which CI legs it can invalidate. The matrix maps changed paths to the
legs or jobs that must be exercised for that change. Job and script names are the real ones from
`.github/workflows/ci.yml` and `package.json`.

| Changed paths | Legs / jobs that must pass |
|---|---|
| `src/**`, `src/element/**` | `build`, `build:ext`, `verify:sync`, `size`; every browser/behaviour smoke — `smoke:pack`, `smoke:install`, `smoke:embed`, `smoke:e2e`, `smoke:parity`, `smoke:ext`, `smoke:webstore`, `smoke:round-trip`; `image` |
| `extension/src/**`, `extension/manifest.json`, `extension/options.html` | `build`, `build:ext`, `verify:sync`; `smoke:ext`, `parity`, `smoke:webstore` |
| `server/**` | `build` (`server` entry → `dist/server.js`); `smoke:cli`, `smoke:mcp`, `smoke:embed`, `smoke:round-trip` (all drive the hub); `image` (Docker build + run) |
| `scripts/**` (build tooling) | `build`, `build:ext`, `verify:sync` |
| `.github/workflows/**` | every job — a workflow change can invalidate any leg |
| `docs/REQUIREMENTS.md`, `spec/**` | `spec` job |
| `docs/**`, `README.md` (docs-only) | no code leg strictly required; a docs-only PR may skip them (see required status checks below) |
| `package.json` version / vendored deps | the affected versions flow into `verify:sync` (manifest + build-info must match `package.json`) |

**This matrix is guidance, not enforcement.** Nothing here reads it; the gate that actually blocks a
merge is branch protection. Use it to decide what to run before pushing — and treat a colour it does
not name as something to think about, not as license to skip a leg.

## Required status checks (recommendation)

Recommendation for branch protection on `main`: make **`verify`**, **`parity`** and **`image`** the
required status checks.

- `verify` is the broad gate — typecheck, unit tests, build, `size`, every smoke and the
  `verify:sync` identity check.
- `parity` is not redundant with `verify`: it is a dedicated job that builds both arrival paths
  (the one-tag embed loader and the built MV3 extension) and fails red on any behavioural divergence.
  It is the only check that proves the same layer behaves identically however it reaches the page.
- `image` is likewise non-redundant: it builds the Docker image *and runs it*, so a shipped artefact
  that secretly needs its own install step fails here rather than on release day.

The other jobs (`spec`, `bump`, `install`) stay valuable but need not be required: `spec` fails fast
on a malformed requirement block, `bump` only applies to pull requests, and `install` covers the
installed-tarball resolution that the required set does not otherwise exercise.

**Optional `paths:` filter.** A pull request that touches only `docs/**` may skip the code legs via a
workflow `paths:` filter, since no build artefact can change. The caveat is explicit and mandatory:
**`parity` must stay required regardless.** A path filter on the `parity` job (or a workflow that a
docs-only PR no longer triggers) would let a behavioural divergence merge green, which is exactly the
class of defect the check exists to catch.

This document **recommends** these settings. It does not change them — branch protection is
repository configuration, set by a maintainer in GitHub, not by a file in the tree.

## Local pre-push hook

`.githooks/pre-push` rebuilds the extension and proves lockstep before the commit leaves the machine:

```sh
npm run build:ext    # regenerates extension/dist/ (requires a prior dist build)
npm run verify:sync  # identity gate: dist sha256 + manifest version match
```

Enable it explicitly:

```sh
node scripts/install-hooks.mjs   # sets core.hooksPath = .githooks
```

Disable it:

```sh
git config --unset core.hooksPath
```

The hook is **not** installed automatically — `package.json`'s `prepare` deliberately does not call
the installer, because auto-installing hooks would silently mutate a developer's git config on every
`npm install`. Enabling it stays an explicit choice. Both legs are fail-closed: a non-zero exit from
either aborts the push.

**Nature: this is a convention boundary, not a security boundary.** It fail-closed blocks an
accidental push of a stale or unbuilt extension, but it does not defend against a deliberate bypass
(`git push --no-verify`). The terminology is defined once in
[`.claude/rules/branch-guard.md#guard-terminologie-convention-boundary-vs-security-boundary`](../.claude/rules/branch-guard.md#guard-terminologie-convention-boundary-vs-security-boundary).

## Failure modes worth knowing

- **Hash mismatch** (`element bundle hash mismatch: dist=… build-info=…`) → the extension/dist is
  stale. Re-run `npm run build` then `npm run build:ext` (or just `npm run build:ext`, which copies
  the current bundle and rewrites the recorded hash).
- **Version mismatch** (`manifest.json=… package.json=…`) → bump `package.json` and
  `extension/manifest.json` together; the identity gate and `build:ext` both refuse to ship a pair
  that disagrees.
- **Behavioural change without a bump** → the `bump` job goes red and lists the offending files.
  Bump `"version"` in `package.json` and re-run.
- **Missing bundle** (`dist/bluepencil.element.iife.js is missing`) → run `npm run build` first; the
  extension loads that file verbatim and `build:ext` refuses to produce an extension without it.
- **`gitSha: null` in build-info.json** → git was unavailable at build time. The build is valid; the
  provenance field is simply empty. Do not treat it as a failure.

## See also

- [Releasing](RELEASING.md) — the version bump and the `manifest.json` match are the release
  preflight's own checks; `npm run verify` (and therefore `verify:sync`) runs on the tagged commit.
- `.gitignore`: `dist/` and `extension/dist/` are build outputs; a fresh checkout has neither until
  you build.
