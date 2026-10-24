# End-to-end coverage

This file is the binding coverage matrix for every bluepencil component that has an end-to-end suite.
It is machine-read by `scripts/components-e2e.mjs`: the runner extracts the component IDs between the
markers below and compares them with the manifest's `covers` lists.

`npm run smoke:components` is the binding total run. Individual scripts remain runnable on their own,
but the matrix is the single place that says what "covered" means for a release.

## Components

The `Status` column is informational (a human note such as "new"); the coverage gate keys on the IDs
and the `E2E entry` column, never on the status word.

<!-- components:begin -->
| ID | Component | Public surface | E2E entry | Scenarios | Requires | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `library-iife` | IIFE build (`dist/bluepencil.iife.js`, `window.bluepencil`) | `init`, `enable`, `disable`, `export`, `notes()` | `npm run smoke:e2e` → `tests/e2e/vanilla.e2e.mjs` | Fixture mounts the bar and an empty store; `c`, `d`, `l`, `f` arm the documented modes; a seeded bundle imports once and a second import adds nothing; a text capture survives a reload and a design capture is exported with its captured context; the markdown export is byte-stable across two exports while the JSON export is parsed and shape-checked; three enable/disable cycles leave no residue and keep the notes. | build, browser | covered |
| `element` | `<bluepencil-notes>` custom element | `endpoint` and `environment` attributes, `blueprint.store`, `destroy` | `npm run smoke:embed` → `scripts/embed-smoke.mjs` | A jsdom element with `endpoint` creates and lists a note through the live hub; the note reaches the canonical store file on disk; the element emits no `bp-error`. | build | covered |
| `attach-js` | One-tag loader (`dist/attach.js`, `dist/attach.esm.js`) | `attach()`, `attachFromDocument`, script-tag attributes | `npm run smoke:embed` → `scripts/embed-smoke.mjs` | Manifest fetch checks the sha256 and refuses a wrong digest; mount honours the `mount` selector and stamps `attach-version`; a real version swap remounts exactly one element and emits one `bp-attach-updated`; an unchanged manifest does not swap; the real script tag moves 0.9.0 to 0.9.1 with no leftover layer; the browser fixture host writes through the same HTTP path. | build, browser | covered |
| `bookmarklet` | Bookmarklet arrival path (post-load inline IIFE) | Injected `<script>` plus `bluepencil.init({…})` | `npm run smoke:bookmarklet` → `scripts/bookmarklet-smoke.mjs` | The document is complete before injection; `init()` with an `enabled` gate does not auto-mount; a real-UI capture reaches the panel, marker and markdown export; `disable()` leaves no `bp-` nodes and a second `enable()` restores the markers; a strict `script-src 'self'` blocks the injection, reports a violation and mounts nothing. | build, browser | covered |
| `extension` | MV3 browser extension | Toolbar and keyboard mount, page bridge, options page, `chromeStorage` | `npm run smoke:ext` → `extension/smoke.mjs` | The unpacked MV3 extension loads and MAIN-world injection registers `bluepencil-notes` under a strict CSP; the page bridge round-trips into extension storage; a live hub round-trip survives reload; an already-embedded page is detected and not duplicated; the toolbar badge names the source; the options page offers none/secret/token and reads token expiry from the token. | build, build:ext, browser | covered |
| `cli` | `bluepencil` CLI (`dist/cli.js`) | `inspect`, `validate`, `notes`, `merge`, `import`, `export`, `instances` | `npm run smoke:cli` → `scripts/cli-smoke.mjs` | `inspect` and `notes` read a valid bundle and `validate` accepts it; merge of a set into itself is a dry run and `--out` writes; unresolved conflicts exit 2 and `keep-incoming` applies; an environment mismatch exits 3 and `--allow-env-mismatch` promotes; `--include-done=false` hides done notes; `instances validate` and `instances list` run offline and never print the credential, and `instances health` exits 5 on a dead peer; a greater-than-64 KiB JSON list survives a real pipe. | build | covered |
| `mcp-stdio` | Stdio MCP server (`dist/mcp.js`) | Newline-delimited JSON-RPC over stdio, nine tools | `npm run smoke:mcp` → `scripts/mcp-smoke.mjs` | `initialize` reports bluepencil and protocol 2024-11-05; `tools/list` exposes nine tools; a read-only session refuses every write and leaves the store hash unchanged; `create_note` persists and a fresh session reads it; PROTOCOL §6 refuses decision replies and `done` on `needs_decision`; import with `on_conflict` merges thread and timestamps; a corrupt store exits 2; notifications produce no frame; unknown method and tool return -32601 and -32602; pipelined writes both persist. | build | covered |
| `hub-http` | Reference hub HTTP API (`dist/server.js`) | `/health`, `/config`, `/notes`, `/sessions`, `/notes/:id/messages`, bulk delete, mirror | `npm run smoke:embed` → `scripts/embed-smoke.mjs` | Health, create, list, filter, patch, thread and sessions round trip; an invalid note is 400 with an error envelope and malformed JSON is 400, unknown id/path are 404, a wrong method is 405 with an `Allow` header, and a wrong content type is 415; an environment mismatch is 400 and bulk delete requires `confirm`; the canonical store and markdown mirror land on disk; a corrupt store exits non-zero with a short error (no stack trace). | build | covered |
| `hub-auth` | Token and shared-secret auth gate | `token` subcommand, `--token-key`, `--auth-secret`, `--revoked-tokens` | `npm run smoke:auth` → `scripts/auth-smoke.mjs` | The minter writes one token line to stdout and the id to stderr; a token hub reports `auth=token`; a read token reads 200 and a write is 403 `insufficient_scope`; a write token writes and a read token sees the note; an expired token is 401 `token_expired` and a revoked id is 401 `token_revoked`; the shared secret answers 401, 401, 200 for missing, wrong and right; `/config` labels the mode and leaks no credential. | build | new |
| `hub-mcp-door` | Token-authenticated `POST {base}/mcp` | JSON-RPC over HTTP on the hub | `npm run smoke:auth` → `scripts/auth-smoke.mjs` | `initialize` and `tools/list` succeed with a read token; `tools/call` `list_notes` returns the shared note set; `create_note` succeeds with a write token and is refused with a read token (403 `insufficient_scope`); a request without a token is 401 `unauthorized`; the MCP door enforces the same gate as `/notes`. | build | new |
| `journal` | Hub journal backends | `--journal`, `--journal-dir`, `--journal-coalesce`, `GET /journal` | `npm run smoke:embed` → `scripts/embed-smoke.mjs` | The file backend records a mutation as entry seq 1 with a sha256 hash and a summary naming the note; `journal.jsonl` holds exactly one line; `?since=1` does not repeat the first entry; the git backend creates exactly one commit and reports `backend=git`. | build | covered |
| `federator` | `bluepencil-federator` (`dist/federator.js`) | Stdio JSON-RPC, `--registry`, `--allow-write`, `--read-only`, `--no-self`, `--include-self` | `npm run smoke:federation` → `scripts/federation-smoke.mjs` | `initialize` reports `bluepencil-federator` with ten tools; `list_notes` aggregates dev and staging with qualified ids and `partial=false`; `create_note` changes only the targeted store and answers with a qualified id; writes are refused without `--allow-write` and under `--read-only` without touching disk; `--include-self` is exit 1; a pre-0.10 `/config` is `federates_missing` exit 4; nested federation and a reserved `self` id exit 4; a dead peer degrades to a partial aggregate; EOF exits 0. | build | covered |
| `aggregating-hub` | Hub in aggregate mode (`--registry --no-self`) | `/config` `federates:true`, local `/notes`, federated `/mcp` | `npm run smoke:federation` → `scripts/federation-smoke.mjs` | `/config` reports `federates:true`; `/notes` stays local and empty; `/mcp` `tools/list` exposes ten tools including `list_instances`; `list_notes` aggregates dev and staging; `list_instances` excludes self; a peer that itself reports `federates:true` is `nested_federation` exit 4. | build | covered |
| `voice` | Composer dictation (`voiceEngine`) | `.bp-voice` mic, interim live region, transcript append | `npm run smoke:voice` → `scripts/voice-smoke.mjs` | Opt-in shows the mic button only after the composer opens and creates no recogniser yet; the mic click creates the injected engine and calls `start()` once, setting `aria-pressed` and `is-listening`; interim text stays in the live region and not in the textarea; a final transcript is appended, the composer stays open and nothing auto-saves; Escape stops the engine and clears the state; `disable()` and `destroy()` are idempotent; opt-out has no mic and a working composer. | build, browser | new |
| `presentation` | Read-only single-file presentation deck | `attach()` without a backend, `theme-accent`, `language` | `npm run smoke:embed` → `scripts/embed-smoke.mjs` | A jsdom read-only attach mounts with exactly one `style[data-bp-styles]` and forwards `theme-accent`; the browser deck mounts one element with the `localStorage` adapter and `language=de`; the three slides are left intact; the element build is `bluepencil.element.min.js`. | build, browser | covered |
| `pack-install` | Published package and tarball install | `exports` map, `bin`, `npm pack` | `npm run smoke:pack` → `scripts/pack-smoke.mjs`; `npm run smoke:install` → `scripts/install-smoke.mjs` | Every exports entry exists and imports, with the element syntax-checked; `main`, `module`, `types` and every `bin` resolve; `npm pack` ships the twelve required artefacts; the tarball installs offline into a scratch project; every subpath imports by bare specifier with its expected named exports; the installed `bluepencil --help` exits 0. | build | covered |
| `docker` | Container image and Compose federation | `bluepencil-e2e:<runId>` (per-run tag), generated compose, healthcheck | `npm run smoke:docker` → `scripts/docker-smoke.mjs` | Every run rebuilds/refreshes the image from this checkout under its own tag, so no run reuses a stale image; two leaf hubs start with bind-mounted stores, and both leaf containers run as the host uid/gid (asserted per container); `/config` reports secret auth; `/notes` is 401 without `x-bluepencil-auth` and 200 with it; a leaf write is readable back; the aggregator reports `federates:true` and keeps `/notes` empty; `/mcp` `list_instances` reports dev and staging with exactly the allowed fields and no leaf secret; cleanup leaves no containers, volumes or networks and force-removes the per-run image (`docker rmi -f`). | build, docker | new |
| `webstore` | Chrome Web Store submission surface | Manifest, shipped extension code, dashboard copy | `npm run smoke:webstore` → `scripts/webstore-compliance.mjs` | The manifest is MV3 with only `scripting`, `storage`, `activeTab` and http/https hosts; no forbidden permission, no `<all_urls>` and no remote content script; shipped code has no `eval`, no remote import and no packing/obfuscation; the worker injects files and functions only; the options page discloses storage and links the privacy policy; `docs/WEBSTORE.md` justifies every permission and `docs/PRIVACY.md` answers collect, use and share. | build, build:ext | covered |
| `hermes-wrapper` | `scripts/hermes-mcp-wrapper.sh` | `BLUEPENCIL_STORE`, `BLUEPENCIL_ENVIRONMENT`, `BLUEPENCIL_APP`, `BLUEPENCIL_ALLOW_WRITE` | `npm run smoke:hermes` → `scripts/hermes-wrapper-smoke.mjs` | The wrapper initializes bluepencil with nine tools and no `list_instances`; the seeded note is listed; the read-only default refuses `create_note`; `BLUEPENCIL_ALLOW_WRITE=1` writes and the note is physically in `BLUEPENCIL_STORE`; a new wrapper process sees the write; a missing store exits 1; app and environment appear in `list_notes` and `export_bundle`. | build | new |
| `round-trip` | Closed loop browser → hub → MCP agent → browser | Embed and extension strands over the same hub | `npm run smoke:round-trip` → `tests/e2e/round-trip.e2e.mjs` | The embed strand mounts through `attach.js` with the http adapter and its note reaches the hub; the extension strand mounts an MV3 tab on another origin with the http adapter; both notes are on the hub; MCP `initialize`, `tools/list` and `list_notes` see both; an agent reply with `set_done` is rendered in both browsers after reload; a feedback note refuses agent `set_status done` with the protocol refusal. | build, build:ext, browser | covered |
| `parity` | Cross-arrival behavioural parity | One fixture served to the embed and extension strands | `npm run smoke:parity` → `tests/e2e/parity.e2e.mjs` | Both strands mount exactly one element and one bar; capture and anchor, note fields and design context match; the canonical JSON export matches; bug and feature presets plus Alt+click pass through identically; disabling a mode hides its button, shortcut and legend row; the version surface is identical; any observed divergence fails the run. | build, build:ext, browser | covered |
<!-- components:end -->

`Requires` names what the assertions need. A `browser` entry means at least one scenario needs Chrome;
whether a missing browser skips only that leg or the whole component depends on the runner entry. The
components whose manifest `requires` includes `browser` (`e2e`, `bookmarklet`, `round-trip`, `parity`,
`ext`, `voice`) are skipped wholesale without Chrome. `embed` is the mixed case: the runner requires only
`build`, so its jsdom legs still run and `BP_NO_BROWSER=1` suppresses only the browser leg.

## How to run

```bash
npm run build && npm run build:ext        # prerequisites, see below
npm run smoke:components                 # every component in this matrix, in order
npm run smoke:components -- --list       # one line per component + coverage gate
npm run smoke:components -- --only=cli,auth
npm run smoke:components -- --only=hub-auth
npm run smoke:components -- --json       # machine-readable result document
npm run smoke:components -- --no-browser # skip browser-backed suites (embed keeps its jsdom legs)
npm run smoke:components -- --no-docker  # skip the Docker suite
```

`--only` accepts **two namespaces**:

- **Manifest component IDs** — the runner entries: `cli`, `mcp`, `federation`, `pack`, `install`,
  `embed`, `e2e`, `bookmarklet`, `round-trip`, `parity`, `ext`, `webstore`, `auth`, `hermes`,
  `voice`, `docker`. `--only=cli,auth` selects exactly those two suites.
- **Coverage IDs** — the IDs in the table above: `element`, `hub-auth`, `hub-http`, `voice`, ….
  `--only=hub-auth` expands to every component whose `covers` list contains that ID (here `auth`).

An unknown ID in either namespace is a usage error (exit 2) that lists both namespaces.

`--list` prints one line per selected component with its `id`, label, `requires`, `covers` and the
exact spawn command, then runs the same coverage gate as a real run (exit 1 on a mismatch). It is
not an "IDs only" listing and it never executes a suite.

### Prerequisites

Every component needs `npm run build` (the runner probes `dist/cli.js`). The extension-derived
components — `ext` (the `extension` row), `webstore`, `round-trip` and `parity` — additionally need
`npm run build:ext` (the runner probes `extension/dist/manifest.json`). The runner models this in
`requires` and exits 1 with the missing command instead of failing later inside a suite:

```bash
npm run build && npm run build:ext
```

`npm run verify` runs the matrix with `--no-docker`: Docker is an optional, manual prerequisite and
must not make the default verification fail on a machine without a daemon. Run `npm run
smoke:components` (without `--no-docker`) before a release that touches the image or the Compose
shape.

## Coverage gate

The gate is **bidirectional** and runs before any suite:

- a documented ID that no component covers fails (`documented but not covered by any component`);
- a `covers` ID that the document does not mention fails (`covered by a component but not
  documented`);
- the `E2E entry` column is validated as well: a row must name at least one `*.mjs` path, every
  named path must exist on disk, it must be the entry of a component covering that ID, and every
  covering component's entry must be named in the row.

CI runs `npm run smoke:components -- --list` in the verify job, so the matrix and the manifest cannot
drift apart. The individual smokes still run in CI as their own steps (that is where the assertions
execute); the Docker Compose smoke is a separate manual `workflow_dispatch` job, not a required PR
gate.

## Skip policy

- **Browser suite, no Chrome:** the runner reports the component as `skip` and the matrix stays green.
  `BP_REQUIRE_BROWSER=1` turns a missing browser into a failure.
- **Docker suite, no daemon or no `docker compose`:** the suite prints `SKIP docker: …` and exits
  77 (its dedicated skip code, never 0), so a run that executed nothing cannot look green; the
  runner reports the component as `skip` and the matrix stays green. `BP_REQUIRE_DOCKER=1` turns a
  missing prerequisite into a failure.
- **`partial` vs `skip`:** a suite that printed `SKIP <case>` lines but exited 0 is reported as
  `partial` (some cases skipped, the rest ran), not `pass`. `partial` and `skip` stay visible in the
  summary and in `--json` but are not failures.
- **`--no-browser` / `--no-docker`** skip the matching components. `--no-browser` also exports
  `BP_NO_BROWSER=1` to every child, so a suite with a mixed shape keeps its non-browser legs.
  `embed` is no longer skipped wholesale on a browserless machine: its jsdom legs (element, hub-http,
  journal, plus the jsdom attach and presentation scenarios) run, and only the browser leg is skipped
  (no Chrome or `BP_NO_BROWSER=1`).
- **Contradiction is a usage error:** `--no-browser` with `BP_REQUIRE_BROWSER=1` (or `--no-docker`
  with `BP_REQUIRE_DOCKER=1`) exits 2 instead of turning a fully skipped matrix green.
- A suite that runs but fails an assertion always fails the matrix, regardless of these variables.

A skip means "the prerequisite was absent", never "the component is covered by something else". The
release check that requires browser or Docker coverage must set the matching `BP_REQUIRE_*` variable.

## Execution model

The runner executes the suites sequentially in **manifest order** (never in `--only` argument
order), so two suites cannot share a port or workspace. Each suite gets its own workspace under
`.tmp/<name>/`; the auth, voice and Hermes suites append a per-run `<pid>` segment, and the Docker
suite appends `<pid>-<random>` (`.tmp/docker-smoke/<pid>-<random>/`), so no run reuses a previous
store or registry. Most suites bind free loopback ports; the MV3 extension smoke is the exception and
uses its fixed `9431` port. A component is covered only by the entry (or entries) named in its row;
"the same script also touched it" is not a substitute for the assertions listed here.

## Keeping this file honest

- Add a row only for a public surface that has an executable suite.
- Name the suite that actually asserts the behaviour, not the one that happens to load the same
  build.
- Keep the ID stable: it is the coverage-gate key, not a label.
- Update the scenarios when the assertions change; a row that describes yesterday's checks is worse
  than no row.
