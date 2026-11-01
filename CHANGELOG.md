## [0.11.6] - 2026-11-01

### Documentation

- **The integration docs now name `connect-src`, not only `script-src`.** A page that reaches a hub
  must allow the hub origin in `connect-src` (or in `default-src` when `connect-src` is absent);
  the loader's manifest and SRI fetches are `connect-src` too, while the element script stays under
  `script-src`. The extension's worker relay is scoped to hub traffic only, and a page without the
  extension still needs `connect-src` (#117).

### Fixed

- **The extension's hub traffic leaves through the service worker.** A page with
  `default-src 'self'` and no `connect-src` no longer blocks note sync: the layer's HTTP adapter is
  routed page → bridge → worker, and the worker is outside the document's CSP. The worker only
  contacts the configured endpoint (origin and base path; every `{base}/admin` spelling is refused,
  percent-encoded forms included), forwards the two credential headers, sends no cookies, follows
  no redirects and rejects an oversized body (#116).
- **The page-side storage relay is scoped to the layer's own keys.** A page can write only
  `bluepencil:<instance>:v1`, never `bluepencil:settings` — rewriting that object would have
  repointed the hub relay at any origin and turned the worker into a CSP bypass. Reading the
  settings stays possible (a pre-existing page-world exposure, documented in `docs/EXTENSION.md`)
  (#116).
- **The HTTP adapter accepts a process-wide transport.** `registerHttpTransport(fetchImpl)` is
  additive: with no registration the adapter uses `globalThis.fetch` exactly as before, and the
  registration survives `disable()`/`enable()`/`destroy()` (#116).

## [0.11.5] - 2026-11-01

### Added

- **The admin surface reports credential presence.** The hub records the last accepted
  authentication per credential kind (`token`, `secret`), at most once a minute, in memory only,
  and never carrying a credential value. Both doors stamp it — the notes API and `POST {base}/mcp`
  — so a client that only reads notes becomes visible (#113).
- **An upgrade path is documented in `docs/DOCKER.md`.** Keep the volume (it holds the notes and
  the generated shared secret), `pull` and `up -d`, recreate only for an added bind mount, and
  accept the update on `/config` (version) and `/health` (#111).

### Fixed

- **The device list no longer implies a list of connected clients.** The label is "issued client
  credentials" (en/de), the page states that one shared secret makes two clients indistinguishable,
  and the `devices` field in `/admin/status` keeps its name for compatibility (#113).

## [0.11.4] - 2026-11-01

### Added

- **The extension options page probes the hub.** A *Test connection* button calls
  `GET {endpoint}/config` with a 5 s timeout and distinguishes an unreachable host, a timeout, a
  wrong base path (404), a redirect, an invalid URL and a broken response, then shows name,
  version, auth, readOnly, environment and federates (#110).
- **Credential acceptance is reported.** With a credential configured the probe follows with a
  status-only `GET {endpoint}/notes` using the header the layer sends: accepted on 200, rejected on
  401/403, inconclusive when that second request fails after `/config` answered (#105).

### Fixed

- **The endpoint field names the full API base.** The placeholder showed only the origin, so the
  obvious value 404ed; it now explains that the adapter appends `/notes` and still stores exactly
  what was typed (#110).

## [0.11.3] - 2026-11-01

### Fixed

- **`GET {base}/health` answers before the credential gate** (GET and HEAD), like `/config`: it
  carries no note and no secret, so a liveness probe no longer needs a credential (#109).
- **The CORS preflight is answered first.** `OPTIONS {base}/mcp` fell into the POST-only rule and
  answered 405 even with `--cors`; the preflight now goes through one shared helper in
  `server/cors.ts` used by the API, admin and static doors, and `OPTIONS {base}/config` and
  `/health` are fixed with it (#102).
- **The image `HEALTHCHECK` probes `/health`** instead of the gated route.

## [0.11.2] - 2026-11-01

### Fixed

- **The shared secret is persisted beside the token.** The entrypoint skipped
  `BLUEPENCIL_AUTH_SECRET` whenever `BLUEPENCIL_TOKEN_KEY` was set, so a token-configured hub ran
  without the secret and `x-bluepencil-auth` clients stopped working; it is now read or generated
  independently of the token key, written `0600`, and an empty secret file counts as absent
  (#108).
- **Both credentials are reported.** `/admin/status` shows `auth: "token+secret"` plus an additive
  `credentials` array instead of only the strongest credential; `/config` keeps its three-value
  vocabulary because the federation client only understands `none|secret|token` (#112).

## [0.11.1] - 2026-11-01

### Fixed

**The admin surface now behaves like a surface an operator can trust: its token panel survives a
refresh, its credential reaches only the notes it is meant to reach, and every route answers with
the headers and limits it claims.** The 0.11.0 page was usable; these are the defects that showed
up once it was driven against a running hub.

- **The minted-token panel no longer disappears.** A devices refresh used to rebuild the table and
  drop the once-only token with it. The token now stays until the operator dismisses it, reloads,
  or mints again, and **Copy** works through the Clipboard API with an `execCommand` fallback for a
  page that is not served over a secure context.
- **The admin secret bridges to the notes routes on a token-only hub.** `authorize()` accepts it as
  a second credential with one explicitly allowed route scope — `/notes*` — and never on `/mcp`.
  The bridge does not turn authentication on: a hub with no client credential still has no gate.
- **The admin secret is not stored in `sessionStorage` by default.** The page keeps it in the tab's
  JavaScript memory; the former write is now an opt-in **Remember in this tab** with a warning.
- **The admin page is served defensively.** Its response carries `cache-control: no-store`,
  `x-frame-options: DENY`, `content-security-policy: frame-ancestors 'none'` and
  `referrer-policy: no-referrer`.
- **Every admin response carries CORS metadata, and `OPTIONS` is answered.** The preflight
  advertises `x-bluepencil-admin` alongside `Content-Type` and `Authorization`, so a scripted admin
  route from the configured origin passes the browser's preflight.
- **Persistence is atomic where the admin surface writes.** The store, `devices.json` and the
  revocation file are written through a temporary file and a rename. A corrupt `devices.json` is
  reported as **500 `registry_unreadable`** and surfaced as `devicesError` on the status route —
  never silently read as an empty list, and never overwritten by the next mint.
- **Revocation reporting matches what revocation actually does.** The page says *durable* only when
  `--revoked-tokens` is configured and *live only — lost on restart* otherwise. Ids minted with the
  CLI (which never entered `devices.json`) can still be revoked by jti and land in the revocation
  file, so the cut-off survives a restart.
- **The journal records the verified device, not a spoofable header.** On a token-authenticated
  request the token's device name is the actor; `X-Bluepencil-Actor` is only the fallback when no
  token proved an identity.
- **Input limits are enforced at the route.** Device names are capped at 200 characters, `jti` at
  256, and token TTLs at 365 days. The admin secret must be at least 16 characters at startup.
  Repeated admin failures are throttled: 10 failures per remote in 5 minutes answer **429** with
  `Retry-After: 300`.
- **Admin paths are normalised.** `/admin/` serves the same page as `/admin`, `..` segments are
  normalised before the route check, and an unknown path under the surface still answers **404**.
- **The page is translated and accessible.** The embedded HTML carries `en`/`de` copy, the device
  table follows tablist keyboard semantics, and every value is rendered as text — an operator name
  or a device string cannot become markup.
- **The device list tells the truth about CLI-minted tokens.** It lists only ids this hub issued
  (`devices.json`); a token minted with `bluepencil token` is not listed, but it can still be
  revoked by its jti, which the page states instead of implying the list is complete.

### Verified

Against **running hubs** (`server-admin.test.ts`) and the **jsdom page tests**:

- on a token-only hub the admin secret edits notes while `/mcp` refuses it — the bridge is
  notes-route only;
- a hub with no client credential stays open: the admin secret does not switch authentication on;
- CORS and `OPTIONS` advertise `x-bluepencil-admin`, and refusals carry the same headers;
- a corrupt `devices.json` answers `500 registry_unreadable`, reports `devicesError`, is not
  overwritten, and revocation still applies;
- revoking an unknown jti with a revocation file configured is accepted and **durable**: the id is
  written to `--revoked-tokens` and the answer does not claim the revocation was live-only;
- `/admin/` serves the page, an unknown admin path is 404, a short admin secret refuses startup;
- 10 failures in 5 minutes answer 429 with `Retry-After`;
- mint and revoke still work under `--read-only` while a note write answers 403;
- the journal records the verified token device;
- the 200/256/365-day limits are enforced.

The page tests assert that the minted token stays visible after a devices refresh, that copy works
through the Clipboard API and its fallback, and that a note body containing markup (`<img …>`) is
rendered as text, not HTML.

---

## [0.11.0] - 2026-11-01

### Added

**An optional admin surface for the hub: `{base}/admin` — page and routes, switched off unless it
is configured.** With `--admin-secret` (or `BLUEPENCIL_ADMIN_SECRET`) the hub serves a small
operator page and the routes behind it; without the flag none of it exists — the paths answer the
router's ordinary 404 rather than a locked page that advertises itself.

What it does, and why each piece is where it is:

- **Its own credential, its own header** (`x-bluepencil-admin`). The hub's `x-bluepencil-auth` is
  the value every browser using the extension holds; this one belongs to the operator and unlocks
  issuing and revoking, so the two never leak into each other.
- **Notes are edited through the existing notes API** with the admin secret, which
  `authorize()` now accepts as a second credential. Note handling stays implemented exactly once,
  and the page only ever asks for one value.
- **Per-device tokens: issue and revoke.** Minting reuses `server/tokens.ts`'s issuer (present only
  with `--token-key` — the page says so plainly otherwise), and the token is shown exactly once:
  the hub keeps the id, not the token. Issued ids are recorded in `devices.json` next to the store.
- **Revocation is live *and* durable.** A revoked id joins the in-memory set the verifier reads on
  every request **and** the `--revoked-tokens` file, so a cut-off device stays cut off after a
  restart. Without that file the revocation is live until restart, and the page reports that rather
  than pretending.
- **Overview and activity**: version, environment, which credential the hub speaks, note/device
  counts, whether token issuing and durable revocation are available — plus every journal entry
  (who, what, when) through the journal route the hub already had.

No client dependency was added: the page is one embedded string of vanilla HTML/JS in
`server/admin-html.ts`, the same shape the extension's options page already has — the hub's runtime
image ships `dist/server.js` and nothing else, and a bundled UI framework would have been its first
client dependency on a page that sits behind a secret.

### Verified

Eleven cases against running hubs (`server-admin.test.ts`): no `--admin-secret` → 404 everywhere;
the page answers without a credential; routes refuse a missing or wrong `x-bluepencil-admin`; the
admin secret edits notes while the client secret alone still gates the door; minting without a
signing key → 409 naming `--token-key`; a minted token is accepted immediately and recorded;
revocation takes effect at once and lands in the file; empty device names and unknown scopes are
refused; an empty `--admin-secret` is a startup error; the environment feeds the parser.

### Known gaps

- **#102 stays open** (`OPTIONS /mcp` → 405): cross-origin MCP remains impossible; the admin page is
  same-origin by construction, so it is unaffected.
- The page issues and revokes tokens but does not rotate the hub's own secrets — those live in the
  process environment, and rotating them means restarting the hub with the new value.
- Device activity is derived from the journal, which records mutations; a device that only *reads*
  leaves no entry.

---

## [0.10.4] - 2026-11-01

### Fixed

**An authenticated hub now answers the CORS preflight, and allows the header the extension sends
(#98, #99).** The two defects made the cross-origin pairing unusable whenever the hub ran with a
credential — which the container's entrypoint guarantees by generating a secret on first start, so
this was the *default* deployment, not an exotic one.

`authorize()` ran before the OPTIONS branch, so a preflight — which by design carries no credential,
because the browser cannot know one yet — was refused with 401. The credential check can only ever
refuse that pairing, never protect a note: the answer is CORS metadata only, and an unauthenticated
caller already learns that the path exists from the 401 it gets for a real request (a refusal is
never a 404). The preflight branch now stands in front of the gate; everything carrying data still
passes `authorize`.

`access-control-allow-headers` named only `Content-Type, Authorization`, so after the preflight
passed the browser still dropped `x-bluepencil-auth` — the header the extension carries the shared
secret in. The list now names the full vocabulary any caller sends: `X-Bluepencil-Auth`,
`X-Bluepencil-Client`, `X-Bluepencil-Actor`, `Mcp-Session-Id`.

### Verified

Against a *running* hub (`server-token-wiring.test.ts`, five new cases): preflight with
`--auth-secret` + `--cors '*'` → **204** with `access-control-allow-origin: *` (was 401);
`access-control-allow-headers` contains `x-bluepencil-auth`, `x-bluepencil-client`,
`mcp-session-id`; the data-carrying requests keep the gate (no credential → 401, credential → 200);
an unauthenticated hub answers the same 204; without `--cors` nothing changes (401, no CORS header).
Measured end-to-end on the live v0.10.3 hub before the fix: `OPTIONS /notes` → 401.

### Known gaps

- **#102 stays open:** `OPTIONS` on `/mcp` still answers 405 (the POST-only rule runs before any
  CORS handling), so the extension cannot use the MCP door cross-origin — the REST door
  (`{base}/notes`) is the one this release unblocks, and it is the one the extension speaks.
- The preflight exemption applies only when `--cors` is configured; without the flag an OPTIONS is
  answered as before (credential check, then 405).

---

## [0.10.3] - 2026-10-31
## [0.10.3] - 2026-11-01

### Fixed

**A client's protocol-version proposal is answered instead of refused, and the handshake never
promises a revision the hub does not speak (#100).** Two coupled defects, found while wiring a
Hermes session directly to a running hub:

The `MCP-Protocol-Version` header gate rejected **every** value but `2024-11-05` — including the
value carried by the `initialize` request itself. That request is where the revision is agreed: the
header names the client's *proposal*, and the hub's answer settles it. Refusing the proposal refused
the negotiation, so a client speaking a newer revision could never reach the door at all (a Hermes
session proposing `2025-11-25` was answered `400 … this hub speaks 2024-11-05`, #100).

`initialize` was also answered by echoing whatever the client asked for. The hub thus *promised*
revisions it does not implement — and a client that takes that promise seriously carries the echoed
version into the header of every later request, where the same gate then refuses it. The handshake
now always answers `2024-11-05`, the revision this implementation speaks; per MCP the client
continues with it or disconnects.

The gate still applies to everything after the handshake, unchanged: `tools/list` and every other
request with a foreign claimed revision are refused as before.

### Changed

**The stdio door changed with the HTTP door, because both run the same code.** `src/mcp/protocol.ts`
is shared by `bluepencil mcp` (stdio) and `POST {base}/mcp` on the hub, so the stdio server now also
answers `initialize` with `2024-11-05` instead of echoing the client's proposal. That is a
wire-visible change for a stdio client that proposed another revision; no tool, resource or prompt
changed.

**Documentation moved to `0.10.3` and was checked against the code.** The image and install pins
moved from `0.10.0` to `0.10.3` in `README.md`, `docs/DOCKER.md`, `docs/FEDERATION.md`, `docs/MCP.md`
and `examples/federation/*`; `docs/BUILD-SYNC.md` and `docs/RELEASING.md` now name the current
version. The public-API listings were corrected against `src/index.ts` (`docs/INTERNAL-API.md` and
the directory tree in `docs/ARCHITECTURE.md`), and the non-existent CLI flags
`--adapter`/`--endpoint` in `docs/ARCHITECTURE.md` were replaced by the real file-based CLI plus an
explicit "Not implemented" note.

### Verified

The handshake behaviour is covered in `tests/unit/server-mcp.test.ts`: `initialize` with
`2025-11-25` in header *and* body is accepted and answered `2024-11-05`; `tools/list` carrying
`2025-11-25` after the handshake is still refused; `ping` with the negotiated revision passes; and
the existing foreign-revision gate test (`1999-01-01` → `400`) is unchanged. The committed smoke
scripts (`scripts/mcp-smoke.mjs`, `scripts/hermes-wrapper-smoke.mjs`) propose `2024-11-05`
themselves, so they exercise the normal path, not the foreign-version one.

Gates on Node **22.17.0** (below the declared engine range; the gates still ran): `npm run
typecheck` and `npm run typecheck:ext` green; **1228 unit tests in 53 files** (`npm test`). `npm run
build` and `npm run build:ext` green; `npm run verify:sync` OK at version `0.10.3`, element bundle
sha256 `37050467…`; the size guard is within every budget (core 40.5 kB gzip of 100, attach loader
3.3 of 8, IIFE 44.1 of 45, custom element 46.9 of 48); `npm run secret-scan` OK (2063 files, no
credentials or review data); `npm run smoke:mcp` 23/23 checks passed; `npm run smoke:docker` 20/20
cases passed; the component matrix reports **15 passed, 0 failed, 1 skipped** (`docker` skipped
because it ran with `--no-docker`; `smoke:docker` covered that leg separately);
`node scripts/release-preflight.mjs --tag v0.10.3` exits `0`.

### Known gaps

- **The two CORS findings stay open (#98, #99).** A cross-origin extension against a hub with
  `--auth-secret`/`--token-key` still fails the preflight, and `x-bluepencil-auth` is still absent
  from `Access-Control-Allow-Headers`. This release only removes the transport-level blocker; it
  does not make the authenticated cross-origin pairing work.
- **The MCP door is stateless and single-revision (`2024-11-05`).** Post-handshake requests with the
  `MCP-Protocol-Version` header *absent* are still accepted — only a foreign *claimed* revision is
  refused. Accepting a proposal the hub could actually serve in a future revision is a feature, not
  part of this fix.
- **A literal `null` JSON-RPC body answers `500`, not `400`.** `parseRpcPayload` treats
  `JSON.parse("null")` as a parse success with a `null` request, and the first member access then
  throws. The root cause is pre-existing in `src/mcp/protocol.ts` and affects both doors (stdio and
  HTTP); it is not fixed in this release.
- **`src/federation/client.ts` keeps its own `MCP_PROTOCOL_VERSION` constant** (`"2024-11-05"`)
  instead of importing `PROTOCOL_VERSION` from `src/mcp/protocol.ts` — a drift risk if the revision
  ever moves.
- **Environment limits of this release run.** `reqmd` is not installed, so `npm run spec:check`
  could not run (the `npm run spec` generator did run and left `spec/` byte-identical). Every other
  gate ran — the component browser legs included, through the Chrome in the local Playwright cache.

## [0.10.2] - 2026-10-25

### Fixed

**The declared Node engine now matches the dev toolchain.** `package.json` declared
`"engines": { "node": ">=20" }`, but the dev toolchain does not run there: `jsdom` 30.1.3 declares
`"node": "^22.22.2 || ^24.15.0 || >=26.0.0"` (the same range is declared by
`@asamuzakjp/dom-selector` 10.0.4 and `@asamuzakjp/css-color` 7.1.3), and `undici` 8.12.3 declares
`"node": ">=22.19.0"`.
Installing on Node 22.17.0 therefore produced `EBADENGINE` warnings even though `>=20` claimed the
tree was supported. The declaration is now `^22.22.2 || ^24.15.0 || >=26.0.0`.

No runtime dependency, no runtime code and no shipped behaviour changed: `dependencies` stays
empty and `src/**` is untouched by this release. Only the engine declaration, the release version
and the documentation moved.

**Apart from this correction, `0.10.2` is `0.10.1`.** `0.10.1` was the dev-dependency-only bump
(`jsdom` 30.1.2 → 30.1.3, `vitest` 5.0.4 → 5.0.5, `undici` 8.11.2 → 8.12.3, `rolldown`
1.2.13 → 1.2.14, `postcss` 8.5.29 → 8.5.31, `@oxc-project/types` 0.153.0 → 0.154.0, and the
transitive `@asamuzakjp/dom-selector` 9.2.4 → 10.0.4). Its one flake was a 3 s timeout in
`federation-client.test.ts` under parallel load; that file passes in isolation (42/42) and was
green on the repeated full run — no new signal, so `0.10.2` does not chase it.

### Verified

All gates ran on Node **22.23.4** / npm **10.9.9** with the new range in place. `npm ci` completed with
**no `EBADENGINE` warnings** (zero occurrences) — the concrete proof that the declaration now matches
the tree. `npm run typecheck` and `npm run typecheck:ext` green; **1227 unit tests in 53 files**
(`npm test`). `npm run build` and `npm run build:ext` green; `npm run verify:sync` OK at version
`0.10.2`, element bundle sha256 `5b71f76b…`; the size guard is within every budget (core 40.5 kB gzip
of 100, attach loader 3.3 of 8, IIFE 44.1 of 45, custom element 46.9 of 48); `npm run secret-scan`
OK (2062 files, no credentials or review data). `npm run verify` exits `0`; the component E2E matrix
reports **15 passed, 0 failed, 1 skipped** (`docker` skipped because `verify` runs
`smoke:components -- --no-docker`).

### Known gaps

- **`reqmd` is not installed locally.** `npm run spec:check` cannot run in this environment (the
  binary is installed in CI). `spec/` is unchanged by this release.

## [0.10.1] - 2026-10-24

### Changed

**Maintenance release: dev-dependency bumps only.** There is no runtime dependency (`dependencies`
stays empty) and no user-facing behaviour changed; the shipped library, CLI, MCP server, hub,
federator and extension are the same code as `0.10.0`.

**`@asamuzakjp/dom-selector` 9.2.4 → 10.0.4 (transitive MAJOR).** This is jsdom's CSS selector
engine, exercised by the `getComputedStyle` and selector-matching paths in the anchor tests. It is
dev-only: `jsdom` is a devDependency, so consumers of the package are unaffected and no runtime code
resolves it.

**The other bumps.** `jsdom` 30.1.2 → 30.1.3, `vitest` 5.0.4 → 5.0.5, `undici` 8.11.2 → 8.12.3,
`rolldown` 1.2.13 → 1.2.14, `postcss` 8.5.29 → 8.5.31 and `@oxc-project/types` 0.153.0 → 0.154.0.
`package-lock.json` was updated by Dependabot in the same change.

### Verified

`npm run typecheck` and `npm run typecheck:ext` green; **1227 unit tests** in **53 files**
(`npm test`). `npm run build` and `npm run build:ext` green; `npm run verify:sync` OK at version
`0.10.1`, element bundle sha256 `bfc46325…`; the size guard is within every budget (core 40.5 kB
gzip of 100, attach loader 3.3 of 8, IIFE 44.1 of 45, custom element 46.9 of 48); `npm run
secret-scan` OK (2062 files, no credentials or review data). `npm run verify` exits `0`; the
component E2E matrix reports **15 passed, 0 failed, 1 skipped** (`docker` skipped because `verify`
runs `smoke:components -- --no-docker`). One earlier full run hit a 3 s timeout in
`federation-client.test.ts` under parallel load; that file passes in isolation (42/42) and the
repeated full run is green.

### Known gaps

- **Node engine mismatch for contributors.** `jsdom` 30.1.3 declares
  `"node": "^22.22.2 || ^24.15.0 || >=26.0.0"` and `undici` 8.12.3 declares `"node": ">=22.19.0"`.
  The same `^22.22.2 || ^24.15.0 || >=26.0.0` range is declared by `@asamuzakjp/dom-selector` 10.0.4
  and `@asamuzakjp/css-color` 7.1.3, so the cause of the `EBADENGINE` warnings is unambiguous; the
  warnings also name `jsdom` 30.1.3 and `undici` 8.12.3. Both top-level engine ranges are unchanged
  from their previous versions (`jsdom` 30.1.2, `undici` 8.11.2) — only the versions moved. Meanwhile
  `package.json` still declares `"engines": { "node": ">=20" }`, so contributors on older Node 22.x
  (e.g. Node 22.17.0) see the warnings during install/verify.
- **`reqmd` is not installed locally.** `npm run spec:check` cannot run in this environment (the
  binary is installed in CI). `spec/` is unchanged by this release.

## [0.10.0] - 2026-10-23

### Added

**Federation as an agent-side layer (`src/federation/`).** A registry is resolved to instances and
exposed as an aggregate: qualified `instance/noteId` identifiers, the SSRF target policy for
outbound hub URLs, the aggregate envelope, and a federated MCP backend. The browser stays a
single-hub client; there is still exactly one note implementation in `src/core/**` + `src/data/**`.

**`bluepencil-hub --registry` — the aggregating hub.** `/notes` stays bound to the hub's own
environment, while `/mcp` aggregates the registered peers; `/config` reports `federates` so a
peer's federation capability can be checked before it is registered. The example compose starts
the aggregator as `--registry … --no-self --read-only --allow-insecure`; the write locks
(`--allow-write` plus `mode: "write"` per peer) are unchanged.

**`bluepencil-federator` (stdio, no own store) and `dist/federator.js`.** The federator reads a
registry, aggregates the peers over MCP and never persists a note itself.

**`bluepencil instances validate|list|health`.** `validate` and `list` are offline and never print a
secret; `health` probes the registered peers and exits `5` when one is degraded.

**`smoke:components` — a 16-component E2E binding matrix.** `scripts/components-e2e.mjs` is the
single manifest of E2E surfaces: 16 runner components, 21 coverage IDs checked bidirectionally
against `docs/E2E-COVERAGE.md`, per-component `requires` and hard timeouts. The new suites are
`smoke:auth` (17 checks: signed tokens, revocation, the shared secret and the token-gated HTTP
`/mcp` door), `smoke:hermes` (16: the documented wrapper path), `smoke:voice` (7: opt-in dictation)
and `smoke:docker` (20: the image and the Compose federation shape). CI runs the matrix's `--list`
coverage gate in the `verify` job; `docker-smoke` is an optional `workflow_dispatch` job.

**`docs/E2E-COVERAGE.md` — the documented side of the matrix.** It maps each coverage ID to its
public surface, suite, prerequisites and skip policy.

**Docs and examples.** `docs/MCP.md`, `docs/FEDERATION.md` and
`docs/images/federation-overview.svg`; the README sections `## The pieces`,
`## Deployment shapes` and `## Connecting an agent`; `examples/federation/` with a registry
example, an aggregating compose file and `.env.example`.

**The Docker image ships both entry points.** `dist/federator.js` plus the `bluepencil-hub` and
`bluepencil-federator` wrappers are in the image. The entrypoint gained a dispatch block for those
two bins; the hub arguments and behaviour are unchanged.

**`smoke:federation` (26 checks) and a CI federation step.** The CI `image` job also asserts that
both bins start from the built image.

### Changed

**The federator is stdio-only in Docker.** It is not a compose daemon and has no port or `/config`;
it is attached per client with `docker run -i --rm … bluepencil-federator`.

**`npm run verify` now ends in `smoke:components -- --no-docker`.** The component matrix replaces
the hand-listed smoke chain as the final step; the component suites (including auth, Hermes and
voice) run through it, and Docker is excluded from the default chain because a missing daemon must
not fail verification.

**Every fatal federation start failure exits `4`.** They previously exited `1`, which disagreed
with the federator and the CLI. That covers the enumerated start-refusal codes (`invalid_registry`,
`invalid_base_url`, `missing_credential`, `id_collision`, `self_reference`, `identity_mismatch`,
`federates_missing`, `nested_federation`) plus a fatal `invalid_response` or `unverified` at
startup; `5` is runtime degradation only.

**A registry `base` must include the API path** (`/api/v1/bluepencil`), because it addresses the
hub API root rather than the site root.

**Docs follow the implemented shape.** Hermes is now a worked example instead of the primary path,
and the extension environment value `prod` is folded into `live`.

### Fixed

**`bluepencil mcp --allow-write false` no longer enables writes.** `--allow-write` is parsed as a
strict boolean (`--allow-write`, `=true`, or `BLUEPENCIL_ALLOW_WRITE=1` only); an unparseable value
is a usage error. The option parsing moved to `src/mcp/options.ts` and is unit-tested.

**The extension no longer requests the `tabs` permission.** `extension/manifest.json` declares only
`scripting`, `storage` and `activeTab`; the URL the extension needs is covered by the http/https
host permission, and re-adding `tabs` fails `smoke:webstore`.

**A stale README claim was removed.** "Settings do not reach the layer" was superseded by
`handoff.ts` and no longer described the code.

### Verified

`npm run typecheck` and `npm run typecheck:ext` green; **1227 unit tests** in **53 files**
(`npm test`). `npm run smoke:federation` 26/26, `smoke:mcp` 23/23, `smoke:cli` 20/20.
`npm run build` and `npm run build:ext` green; `npm run verify:sync` OK at version `0.10.0`, element
bundle sha256 `a4eb2e6b…`; the size guard is within every budget (core 40.5 kB gzip of 100, attach
loader 3.3 of 8, IIFE 44.1 of 45, custom element 46.9 of 48); `npm run secret-scan` OK (2055 files,
no credentials or review data). `npm run spec` regenerated **161 requirements** in **18 documents**
(139 functional, 22 non-functional; 103 P0 / 48 P1 / 10 P2) with no change to `spec/`. `npm run
verify` exits `0` with the **1227 unit tests**; the component E2E matrix is **16/16 PASS with
Docker**, and the new suites report `smoke:auth` 17 checks, `smoke:hermes` 16, `smoke:voice` 7 and
`smoke:docker` 20.

### Known gaps

- **`reqmd` is not installed locally.** `npm run spec:check` fails with `reqmd: not found`; the
  binary is installed in CI. `spec/` was regenerated by `npm run spec` and is unchanged.
- **DNS check-to-connect TOCTOU.** The resolved IP is not pinned between the pre-flight check and
  `fetch`; this is a documented residual risk in `docs/FEDERATION.md`.
- **The browser extension has exactly one hub profile.** There is no multi-hub or
  multi-federation profile.
- **No cross-instance session merge.** The aggregate is a bounded projection over already
  persisted notes, capped by `limit`.
- **Hubs older than 0.10 are not federatable.** They do not report `federates` at all; a missing or
  non-boolean `federates` is rejected with `federates_missing`. `federates: false` is the normal
  leaf value, and `federates: true` is rejected as `nested_federation`.
- **No npm registry publish as part of this release.**
- **The npm tarball ships `docs/`.** Because `files` includes `docs`, `docs/plans/` is currently
  inside the published package.

## [0.8.0] - 2026-10-20

### Added

**Two more capture presets: `bug` and `feature` (FR-1.13/1.14).** A bug is always captured with
design semantics — its state and context matter even when the click lands on text — and shows its
severity; it defaults to `intent=implement`, which the feedback-only toggle overrides. A feature is
hybrid: a text capture with a quote when a text target is found, otherwise a design snapshot, and it
shows its priority. The bar reads `Text | Design | Bug | Feature`; the shortcuts are `c`, `d`, `i`
and `n`, while `l`, `f`, `b`, `h`, `?`, `Esc`, `j`/`k` and `1…9` are unchanged.

**Optional feature priority (FR-3.7).** `priority` is `high`, `medium` or `low`, meaningful only for
`type: "feature"` and omitted on every other type. Like severity it is orthogonal to `type` and
`intent`, optional, and additive.

**Mode visibility and a host ceiling (FR-4.10).** The host bounds what may be captured with
`init({ modes: ["text", "design", "bug"] })` or the element attribute `modes="text,design,bug"`
(loader form `data-modes`); `modes="none"` mounts a read-only layer. Within that ceiling the settings
popover has one checkbox per mode. A disabled mode hides its button, leaves its shortcut inert and is
omitted from the legend; disabling the active mode falls back to `off`, and all modes off is the
read-only state, which keeps bar, list, filters, legend and settings and hides the feedback-only
control. Existing notes are untouched.

**Alt+click on interactive elements (FR-1.15).** While a capture mode is active, Alt+click opens the
composer for buttons, links, form fields and interactive ARIA roles. A normal click stays the host's
behaviour; `preventDefault()` stops navigation when the composer opens, and `[data-bp-ignore]` /
`canAnnotate` still veto (FR-12.6).

**Version line (FR-4.9).** The settings popover shows a static `Version` row (`bluepencil <VERSION>`,
`dev` from source); the layer root carries `data-bp-version`, and the extension options page shows
the bluepencil version plus the build info (`version`, `gitSha`, `elementSha256`).

**Panel grading for priority.** A feature shows a type badge and a priority badge, with a priority
filter (`all | high | medium | low | none`) and an inline compact dropdown that can also clear the
value. Severity (bug) is editable the same way.

### Changed

**The `type` enum includes `feature`.** `text | design | bug | feature`; panel type and priority
filters cover the new values. The settings surface now holds the mode checkboxes and the version row.
The CLI and MCP surfaces carry the extended enum, and `NotePatch.severity` / `NotePatch.priority`
accept `null` to clear a value.

**No `schemaVersion` bump — it stays `1`.** `feature` and `priority` are additive. Old readers
degrade a `feature` note to `text` and drop `priority`; new readers import old data unchanged, and an
unknown priority is dropped on import.

**Options-page provenance without a network API.** The options page now reads a classic build-time
script (`build-info.js`, setting `globalThis.BLUEPENCIL_BUILD_INFO`) instead of fetching
`build-info.json`; the extension's own code makes no network request at all, so the hard
Webstore-compliance scan passes without an exception. `build-info.json` stays for tooling and
`verify:sync`.

**Custom-element budget 45 → 48 kB (NFR-3).** The capture presets, feature priority, mode visibility
and version line measured 46.9 kB gzip against the old 45 kB ceiling; the IIFE stays at 44.1 kB of
45 kB. The raise is recorded in NFR-3 and `scripts/size-guard.mjs`.

**Docs updated.** README (capture modes), PROTOCOL (vocabulary and agent guidance), ARCHITECTURE
(data model and `src/ui/modes.ts`), INTEGRATION §12 (modes, ceiling, Alt+click, grading, version),
EMBED (`modes`, settings version row) and the spec coverage counts.

### Verified

`npm run spec` green at **153 requirements** in **18 documents** (132 functional, 21 non-functional;
95 P0 / 48 P1 / 10 P2); `reqmd check spec/` was not available locally because `reqmd` is a CI-side
tool. `npm run typecheck` + `npm run typecheck:ext` green; **865 unit tests** in **37 files**;
`npm run build` + `npm run build:ext`; `npm run verify:sync` OK (version 0.8.0, element bundle
sha256 `2e22d7f9…`); the size guard within every budget (core 40.5 kB gzip of 100, attach loader 3.3
of 8, IIFE 44.1 of 45, custom element 46.9 of 48); `npm run smoke:pack` (12 required artefacts, 109
files) and `npm run smoke:install` 15/15 (every documented export path plus `bluepencil --help`).
Every browser and smoke leg in `npm run verify` is green end to end: **embed 14/14**,
**bookmarklet 2/2**, **e2e 13/13**, **round-trip 11/11**, **parity 13/13**, **ext 119/119** (0 failed),
**webstore 38/38** (four `ADVICE`, no failures), **CLI 15/15** and **MCP 23/23**.

### Known gaps

- **`reqmd` is not installed locally.** The spec is regenerated with `npm run spec`; `reqmd check
  spec/` runs in CI.
- **The size budgets are close to their ceilings.** The custom element sits at 46.9 kB of 48 kB
  (97.7%) and the IIFE at 44.1 kB of 45 kB (97.9%), so the next feature of this shape must move or
  shrink a budget deliberately rather than assume headroom.

## [0.7.0] - 2026-10-17

### Added

**Composer dictation: speak a note instead of typing it (FR-21.1–21.8, #90).** The composer gains a
mic button that starts the browser's speech recognition, announces interim results in a `role="status"`
live region and **appends only the final transcript to the body textarea** — the note is saved by the
human's own save action, there is no auto-save (FR-21.3). The whole surface is **opt-in and off by
default**: without `voice` (`data-voice` in the loader form) there is no mic button in the DOM, no
recognition listener and no permission prompt (FR-21.1). The new module `src/ui/voice.ts` wraps the Web
Speech API behind a minimal `VoiceEngine` interface and owns the start/stop/destroy state machine, so
teardown is idempotent and `Esc`, closing the composer, `disable()` and `destroy()` all stop
recognition (FR-21.4). Feature-detected through `SpeechRecognition || webkitSpeechRecognition`: no
recogniser means no button and no throw, and an explicitly requested `voice` on such a platform is
reported through `element.issues` instead of failing silently (FR-21.2). A host that wants to stay
offline — or use its own recogniser — injects an engine through `voiceEngine` / `voice-engine="…"`, a
global path to a factory that must resolve to a function, keeping the core dependency-free (FR-21.6).
Six new `en`/`de` keys cover the label and every status message (FR-21.7), and the button is labelled,
keyboard-operable and carries `aria-pressed`, with status and errors announced in the live region
(FR-21.8). New requirements `FR-21.1`–`FR-21.8` and the generated `spec/21-voice/` projection.

### Changed

**The IIFE size budget moves from 40 kB to 45 kB (NFR-3, #90).** The measured pre-change IIFE sat at
39.9 kB gzip against the 40 kB ceiling — 0.1 kB of headroom — so *any* feature overflowed it rather
than a specific regression. The dictation surface (adapter module, composer wiring, six i18n keys,
styles) measured 1.4 kB gzip, landing the IIFE at 41.3 kB; 45 kB aligns it with the custom-element
budget and leaves ~3.7 kB headroom. It is a recorded decision, not drift: NFR-3 and
`scripts/size-guard.mjs` carry the numbers.

**Version single source of truth: `package.json` and `extension/manifest.json` are `0.7.0` (NFR-21).**
`0.6.1` was bumped on the feature branch but never tagged; this release goes straight to `0.7.0`.
`npm run build:ext` regenerates `extension/dist/build-info.json` from the manifest, so a forgotten bump
is a red build (`verify:sync`), not a stale download.

**Docs carry the dictation contract.** `docs/ARCHITECTURE.md` lists `src/ui/voice.ts`; `docs/EMBED.md`
documents the `voice` and `voice-engine` attributes and their privacy note; `docs/INTEGRATION.md` gains
§7 *Voice dictation (FR-21)* with the opt-in, feature-detection, teardown, engine-injection and privacy
behaviour; the README states that dictation is opt-in and text-only.

### Fixed

No user-visible fixes in this release — the work is the dictation feature and the two enablers above.

### Verified

`npm run typecheck` + `npm run typecheck:ext` green; **813 unit tests** in **36 files**; `npm run build`
+ `npm run build:ext`; `npm run verify:sync` OK (version 0.7.0, element bundle sha256 `aad461d4…`); the
size guard within every budget (core 37.7 kB gzip of 100, attach loader 3.3 of 8, IIFE 41.3 of 45,
custom element 44.0 of 45); `npm run smoke:pack` (12 required artefacts, 108 files), `npm run
smoke:install` (every documented subpath resolves by package specifier, `bluepencil --help` exit 0),
`npm run secret-scan` clean (2009 files), and `npm run spec` **147/147 valid** in 18 documents — 126
functional, 21 non-functional, no requirement without a verify method. The browser legs in `npm run
verify` are green end to end: **embed 14/14**, **e2e 13/13**, **bookmarklet 2/2**, **parity 5/5**,
**round-trip 11/11**, **ext 116/116** (0 failed) and **webstore 38/38** (four `ADVICE`, no failures).

### Known gaps

- **The Web Speech API's network policy is a browser decision, not the library's.** The core makes no
  request of its own (NFR-7) and the feature is off by default, but Chromium's own recognition may send
  audio to a browser service — outside the library's control. A host that must avoid that injects its
  own engine through `voiceEngine` (FR-21.6).
- **No Firefox support for the browser engine.** `SpeechRecognition`/`webkitSpeechRecognition` is
  Chromium/Safari only; on Firefox the mic button does not appear, and an explicitly requested `voice`
  surfaces in `element.issues` (FR-21.2) rather than working. The injected-engine path is the only
  offline/Firefox-capable route today.
- **`spec:check` (`reqmd check spec/`) is CI-verified, not locally.** `reqmd` is a CI-side tool; the
  regeneration is deterministic (`npm run spec` leaves `git status spec/` empty) and CI fails on drift.
- **Carried forward from 0.6.0, not new:** the extension still does not survive a navigation
  (FR-6.11/6.12) and is injected on demand; the README's honest gaps stand (hand-rolled E2E over CDP
  rather than Playwright, manual token refresh, no import/merge surface in the UI, no bulk delete or
  retention control, i18n only `en`/`de`, no npm publish — install from the tag).

## [0.6.0] - 2026-10-16

### Added

**A third note type, `bug` (FR-3.2, #75).** `type` was `text | design`; a reviewer looking at
something that is *wrong* rather than merely improvable had to file it as a text note and say so in
prose. `NOTE_TYPES` now carries `bug` alongside them, the composer offers the three categories (the
default stays `text`), and the panel gets a badge and a `type` filter, with the copy in `en`/`de`.
Back-compat is untouched: an unknown type in an old store or bundle still falls back to `text`,
there is no schema change and no third layer mode.

**Severity on bug notes — `blocker | major | minor` (FR-3.6, #79).** A bug is not made more urgent by
being a bug, so severity is a **category-orthogonal, optional** dimension next to `type` and
`intent`: it adds no note types (`type` stays `text | design | bug`, `intent` stays
`implement | feedback`), it is meaningful only for `type: "bug"`, and it is omitted for every other
type. Backward compatibility was the constraint — a note without severity stays valid, there is no
`schemaVersion` bump, and old stores and bundles import unchanged. On the import/migration path an
unknown severity degrades safely (dropped, treated as absent), mirroring the unknown-type → `text`
fallback, while the strict write/validate paths reject an unknown value. Markdown export, the MCP tool
surface and the hub handler carry the field through.

**The web and extension strands must agree: a functional parity suite (NFR-11, #77).** The one-tag
embed loader and the MV3 extension mount the same layer — but nothing proved they *behaved* the same,
so a divergence could ship as a silent difference between the two arrival paths. `tests/e2e/parity.e2e.mjs`
(`npm run smoke:parity`) drives both against a shared fixture (`examples/parity/page.html`,
`tests/e2e/parity-cases.mjs`) and compares their observations; a behavioural difference is a red
test. It runs as a dedicated CI `parity` job, which `docs/BUILD-SYNC.md` lists among the jobs that
should stay required status checks.

**The MV3 smoke now exercises the hub and persistence (extension scope, #80).** `extension/smoke.mjs`
gained the cases that were still missing at the edges: a live hub round-trip (the built
`dist/server.js` on a loopback port, a real-UI capture through the `http` adapter, `GET /notes` on the
hub, then a reload and remount), a `chromeStorage` reload-persistence check (note and marker), a
same-origin navigation check (a fresh document has no layer; a remount yields exactly one
`<bluepencil-notes>`), an unforced double-mount no-op, an in-browser one-tag loader detection (the
extension steps aside and the badge names the source), and a `localStorage` adapter-selection case.
The shared note/UI drivers were extracted and reused across the existing checks, and a missing browser
now fails red under `BP_REQUIRE_BROWSER=1` instead of passing quietly.

**The installation is tested, not assumed (NFR-16, #81).** `scripts/install-smoke.mjs`
(`npm run smoke:install`) packs the package, installs the tarball into a scratch project, imports
every documented exports subpath by package specifier (root, `data`, the adapters, `i18n`, `attach`,
`server`; `element` is syntax-checked as browser-only) and runs the `bluepencil` bin — so a documented
entry point that fails to resolve after a real install fails the build. A second, non-blocking
diagnostic leg (`smoke:install:git`) installs `github:Popoboxxo/bluepencil#<ref>` to prove `prepare`
builds `dist/` during a git install; a fork PR's head SHA is not on the base repo, so only the tarball
leg is the gate.

**The bookmarklet path is smoke-tested in a real browser (NFR-1, NFR-6, NFR-15, #81).**
`scripts/bookmarklet-smoke.mjs` (`npm run smoke:bookmarklet`) runs the built `dist/bluepencil.iife.js`
the way a bookmarklet arrives — injected *after* load into a page the code does not own — and asserts
the layer surfaces, a note captured through the real UI (panel + marker), the markdown export, and
that `disable()` leaves no residue while `enable()` restores the layer. A second fixture pins the
documented strict-CSP limitation: under `script-src 'self'` the post-load injection does not mount.

**The closed loop is one observed run: end-to-end round-trip smoke (FR-16.8, FR-16.9, NFR-11, #85).**
`tests/e2e/round-trip.e2e.mjs` (`npm run smoke:round-trip`) drives both browser strands (the one-tag
embed loader and the built MV3 extension) to write a note to the hub, has an agent read it and reply
over the hub's MCP door, and checks the reply returns to the browser on the next reload. This is the
only leg that proves the two arrival paths share one store end to end; it is wired into
`npm run verify` and the CI verify job.

**A build-sync guard turns the library ↔ extension identity into a gate, not a hope (NFR-21, #87).**
The extension ships the library's element bundle verbatim
(`extension/dist/bluepencil.element.iife.js`), so a library build the extension never picked up
installs, passes a shallow check, and quietly lacks the fix. `npm run verify:sync`
(`scripts/verify-sync.mjs`) now reports every inconsistency in one run: the
`sha256(dist/bluepencil.element.iife.js)` must equal `extension/dist/build-info.json.elementSha256`,
and both `extension/manifest.json.version` and `build-info.json.version` must equal
`package.json.version` — the version single source of truth. The version-bump gate
(`npm run check-version-bump`, CI `bump` job, pull-request-only with `fetch-depth: 0`) fails a
behavioural-surface diff (`src/`, `src/element/`, `extension/src/`, `extension/manifest.json`,
`extension/options.html`, `server/`) without a `package.json` bump; an unresolvable base ref is a
warning and exit 0, never a false red. Under `--watch` the element builds now auto-rebuild the
extension (debounced), `npm run build:ext` writes `{ version, elementSha256, gitSha }` provenance, and
the opt-in `.githooks/pre-push` hook (a convention boundary, enabled with
`node scripts/install-hooks.mjs`) rebuilds and rechecks before a push leaves the machine.
`docs/BUILD-SYNC.md` documents the guard surface and the changed-path → CI-leg matrix.

### Changed

**The HTTP adapter export is `createHttpAdapter`, and the extension permission copy describes the real
injection path (#86).** The README, `docs/ARCHITECTURE.md` and `docs/INTEGRATION.md` snippets named a
non-existent `httpAdapter`; they now import `createHttpAdapter`, so a copy-paste out of the docs
resolves. `docs/EXTENSION.md` and `docs/WEBSTORE.md` no longer justify the `http(s)://*/*` host
permission by navigation survival: the overlay is injected on demand after an explicit user gesture
and does **not** survive a navigation in this release, and the copy now says so.

**The README lists every smoke/verify script and its scope (#86).** The verify chain's smokes were
previously only implied; a table now maps each script to its file and what it proves, and states that
CI runs the whole set as five jobs (`spec`, `verify`, `parity`, `install`, `image`).

**Dependency and action bumps.** Dev: `vitest` 5.0.3 → 5.0.4 (#84), `typescript` 5.9.3 → 7.0.2 with an
explicit `rootDir` for TS7 declaration emit (#66), and `@types/node` (#67, #72). CI / GitHub Actions:
`docker/build-push-action` v6 → v7 (#82), `docker/setup-buildx-action` v3 → v4 (#83),
`docker/login-action` v3 → v4 (#68), `actions/checkout` v4 → v7 (#69), and
`actions/attest-build-provenance` v2 → v4 (#65).

### Fixed

**A corrupt stored blob no longer latches storage off for the whole session (#73).** The single
`degraded` latch conflated a failed *read* with a failed *write*: a failed read below the write layer
latched storage off, so a corrupt stored blob could never be replaced and every later mutation stayed
unpersisted even though the host was healthy again. It is split into `readFailed` and `writeDegraded`
— a read failure makes the in-memory set authoritative without blocking `persist()`, so the next write
reaches the host and replaces the corrupt blob, which is exactly the recovery the old latch prevented;
a write failure under `writeFailure: "degrade"` still stops further writes, because there is no other
copy to fall back to. Both causes share one `reported` flag, so `onFallback` still fires at most once
per session (NFR-14); the `writeFailure: "reject"` path is unchanged.

**A transient worker-probe failure is retried instead of latching out (#74).** The extension's name
probe recorded a failed probe as a permanent verdict, which excluded the real worker for the rest of
the 20 s budget. The bookkeeping moved into `extension/probe.mjs`'s `selectWorker`: transient probe
failures are now retried with backoff, no target is permanently excluded, the selection stays
fail-closed, and per-candidate attempt counts are reported.

### Verified

`npm run typecheck` + `npm run typecheck:ext` green; **784 unit tests** in **34 files**; `npm run build`
+ `npm run build:ext`; `npm run verify:sync` OK (version 0.6.0, element bundle sha256 `6a92e37e…`); the
size guard within every budget (core 36.3 kB gzip of 100, attach loader 3.3 of 8, IIFE 39.9 of 40,
custom element 42.4 of 45); `npm run smoke:pack` (12 required artefacts, 107 files), `npm run smoke:install`
(every documented subpath resolves by package specifier, `bluepencil --help` exit 0), `npm run smoke:cli`
14/14, `npm run smoke:mcp` 23/23, `npm run secret-scan` clean (2004 files), and `npm run spec`
**139/139 valid** in 17 documents — 118 functional, 21 non-functional, no requirement without a verify
method. `BP_REQUIRE_BROWSER=1 npm run verify` green end to end in a real Chrome (found automatically at
the Playwright cache): **embed 14/14**, **e2e 13/13**, **bookmarklet 2/2**, **parity 5/5**,
**ext 102/102** (0 failed), **webstore 38/38** (four `ADVICE`, no failures) and **round-trip 11/11**,
all on one tree.

### Known gaps

- **The new gates are enforced in CI / the local chain, not by branch protection.** `verify:sync` runs
  inside `npm run verify`; `check-version-bump` is the pull-request-only `bump` job. `docs/BUILD-SYNC.md`
  *recommends* which jobs should be required status checks, but branch protection is repository
  configuration a maintainer sets in GitHub — no file in the tree changes it.
- **`spec:check` (`reqmd check spec/`) is CI-verified.** The regeneration is deterministic — `npm run
  spec` leaves `git status spec/` empty — and CI fails on drift, but `reqmd` itself is a CI-side tool.
- **The extension still does not survive a navigation (FR-6.11/6.12).** The overlay is injected on
  demand and a fresh document has no `<bluepencil-notes>` until the user invokes the extension again;
  the readable hub picker, the override checkbox and the live status line from 0.5.0's gaps remain
  unimplemented. Carried forward, not new.

## [0.5.0] - 2026-10-03

### Added

**The hub describes itself before it asks for anything: `GET {base}/config` (FR-6.10).** A client has
to be able to learn *which* credential to bring — otherwise picking the wrong one is a `401` that
reads like a dead server. The answer carries the name the hub was given, its version and base,
`auth: none | secret | token` (**never** the value), whether it runs read-only, and **the binding the
process actually has**: the address comes from the listening socket, not from `--host`, so `--host
localhost` binding `::1` is reported as what it is. It is the one route in front of the authentication
gate, on purpose, and `/notes` behind it stays `401`. Measured live: loopback → `loopbackOnly: true`,
`--host 0.0.0.0` → `false` with the secret still enforced.

**The same notes, reachable by an agent over HTTP: `POST {base}/mcp` (FR-16.8/16.9).** The stdio MCP
server an agent starts as a child process could only ever see the file it was pointed at — notes the
browser wrote were invisible to it. The hub now speaks MCP itself, over the store the browser writes
to: **two doors, one store.** Both run the same protocol handling (`src/mcp/protocol.ts`) through the
same atomic write path behind the same gate (the gate moved into `authorize()`; its tests are
unchanged). POST only — the hub sends nothing on its own, so a GET is `405`; no sessions; JSON instead
of SSE; `MCP-Protocol-Version` checked when a client claims one; `exit` refused, because a caller must
not be able to stop the service it is talking to. Identity is checked first, then the write privilege,
so a read-scoped device keeps its read tools and only a writing `tools/call` demands `write`.
Measured both ways: an agent's `create_note` appeared in `GET /notes`, and a note POSTed by the
browser appeared in the agent's next `list_notes`.

**The hub runs as a container (FR-6.14).** `docker compose up -d`, one volume, and the release
publishes the image to GHCR (`:0.5.0`, `:hub`, `:latest` for stable tags) with provenance and an SBOM.
Inside a container loopback would make the hub unreachable, so the entrypoint binds beyond it *and*
generates the credential that binding requires — kept in the data volume, because a restart that
changes the secret silently invalidates every client that saved it. The first start prints one line to
paste; later starts only name the file. The runtime stage carries the bundle and nothing else: measured
by running `dist/server.js` from a directory holding that one file and no `node_modules`.
[`docs/DOCKER.md`](docs/DOCKER.md) has the environment variables and the honest limits (no TLS in the
image, bind-mount ownership, one writer per store).

### Changed

**"Sidecar" is gone: the service is called a hub wherever a person reads it.** The name made people
expect something they had to run *somewhere* and administer; it is one command from this package, and
on a single machine it never leaves loopback. 297 occurrences in 44 files — the options page, the docs,
`--help`, the warnings — plus the identifiers `SIDECAR_APP_NAME`/`SIDECAR_EXPORTED_BY` →
`HUB_APP_NAME`/`HUB_EXPORTED_BY` and `tests/unit/sidecar-tokens.test.ts` → `hub-tokens.test.ts`.
Deliberately untouched: `CHANGELOG.md` (past releases describe what it was called then), the
agent-meta infrastructure and the generated `spec/`. Bundle compatibility was checked rather than
assumed: `HUB_EXPORTED_BY` keeps the value `server:bluepencil`, and a bundle whose header still says
`app.name: "bluepencil sidecar"` validates and imports unchanged — the name travels as data, it is not
a gate.

**The hub can be named: `--name "Unraid"`** (default: the machine's hostname). It is what `{base}/config`
reports, so a client can offer a name a human recognises instead of a container id. An empty value is
refused rather than treated as "off".

### Fixed

**The store leg starts now (#62).** 0.4.0 shipped the store workflow wired to the `release: published`
event, and `release.yml` publishes with `GITHUB_TOKEN` — events raised by that token do not start
workflow runs, so the listener never fired and 0.4.0's extension reached no store at all. The release
job now dispatches the store workflow itself (an ordinary API call, which does start a run) and the
step is deliberately not `continue-on-error`. The correction is also written into the 0.4.0 section
above, where the wrong claim was made.

### Verified

`npm run verify` green on this tree — `typecheck` + `typecheck:ext`, **697 unit tests** in 32 files,
`build` + `build:ext`, the size guard, the pack smoke, **embed-smoke 14/14**, **e2e-vanilla 13/13**,
**ext-smoke 47/47** in a real Chrome and **webstore-compliance 38/38** (four `ADVICE`, no failures).
`npm run smoke:cli` 14/14, `npm run smoke:mcp` 23/23, `npm run secret-scan` clean (394 files), and
`npm run spec` **137/137 valid** — 117 functional, 20 non-functional, no requirement without a verify
method. The container was exercised without a Docker daemon: the bundle ran alone, and the entrypoint
was driven through three starts (credential generated `0600`, enforced, `loopbackOnly: false`, nine
tools over `POST {base}/mcp`, and the same credential still valid afterwards).

### Known gaps

- **The store credentials still do not work (#58).** Unchanged from 0.4.1: `action: check-credentials`
  gets `401 unauthorized_client` from Google's token endpoint until the refresh token is regenerated.
- **The image build is proven by CI, not by hand.** There is no Docker daemon in the environment this
  was written in, so `Dockerfile` + `docker/entrypoint.sh` are verified by the new CI job, which builds
  the image and then *starts* it, checks `{base}/config`, and requires the generated credential to be
  enforced. The first run of that job is the real verdict; a claim from here would be a guess.
- **The extension still asks for an address (FR-6.11/6.12).** The requirements exist and the data
  source does too (`{base}/config` reports name, credential kind and live binding), but the readable
  picker, the override checkbox and the live status line are not implemented in this release. The
  free-text field stays for now.
- Token refresh is still manual, and revocation is read at hub start.

## [0.4.0] - 2026-10-03

### Added

**The store submission is a build artefact now, not a form someone fills in from memory (#59).**
`scripts/webstore-compliance.mjs` (`npm run smoke:webstore`) checks the three things that drift apart
silently — the manifest, the shipped code and the dashboard copy in `docs/WEBSTORE.md` — against the
program policies: MV3, no string evaluation, no remote import, no obfuscation, no `code:` injection, no
hardcoded remote origin, the permission set, and that every permission the manifest requests has a
justification block in the copy that names it. **38 checks**, of which four are judgement calls
(permission breadth, the in-product disclosure, the plain-http sidecar endpoint) and print as `ADVICE`:
they never fail the build. It runs inside `npm run verify` and as its own CI step after `build:ext`, so
a permission added to the manifest without a justification fails the build instead of the review.

**The dashboard copy lives in one place, written to be pasted verbatim** (`docs/WEBSTORE.md`): the
single purpose, the five permission justifications, the remote-code answer, the data-usage
disclosures, the privacy-policy URL, the listing copy — and the five decisions with the evidence behind
them, because the next person to touch the manifest has to know *why* it looks the way it does.

**The privacy policy is published from one source** (`docs/PRIVACY.md` → `scripts/build-site.mjs` →
`site/`, gitignored artefact → `gh-pages` via `.github/workflows/pages.yml`). The workflow greps the
rendered page for the *Limited Use* sentence and the User Data Policy before it publishes, so a
renderer that loses either stops instead of serving a policy that no longer says what the store
requires. Live at **https://popoboxxo.github.io/bluepencil/privacy/** — checked from here: `200`,
7,446 bytes, the sentence present twice. The README links the policy, so the statement is one click
from the project homepage.

**Publishing a release now hands the extension to the Chrome Web Store** (#57,
`.github/workflows/chrome-webstore.yml`). It takes the release's **own** zip — nothing is rebuilt, so
the bytes the store serves are the bytes `npm run smoke:ext` tested — verifies its digest against the
release's `SHA256SUMS` and its `manifest.json` version against the tag, skips prereleases, and only
then calls the store. `workflow_dispatch` offers `check-credentials`, `upload` (stages a version
without publishing it) and `publish`.

> **Correction (0.4.1).** This paragraph is what 0.4.0 shipped, and the first half of it was wrong:
> the workflow listened for `release: published`, and a release published with `GITHUB_TOKEN` does not
> start workflow runs, so that listener never fired and 0.4.0's extension reached no store at all. The
> wiring itself (the download, the digest and version checks, the store call) was correct — only
> nothing started it. The release job now dispatches the store workflow explicitly, which is why the
> claim above is true from 0.4.1 on.

### Changed

**The extension asks for one permission less: `tabs` is gone (D2).** Nothing needed it. `chrome.tabs.query`
and `tab.id` never required a permission; `tab.url` fed only the `tabUrl` field of the mount
configuration, and nothing reads that field — the page a note belongs to comes from the element's own
`route="url"`, which reads the page's `location.href` in the page itself; and the http/https host
permission covers a tab's URL anyway. `scripts/webstore-compliance.mjs` fails the build if `tabs` ever
comes back, and `extension/src/sw.ts` carries that reasoning right above the `chrome` declaration.

**The options page discloses what is stored, before any field (D3).** It names the categories that
actually exist — the notes you create, the settings, and the sidecar URL and credential if you enter
them — and links the policy. Checked twice over: statically in the compliance script, and in
`smoke:ext` on the **rendered** page (present, the heading, at least three bullets, a policy link),
including its contrast in both colour schemes, the same guard the other fields carry. The grep for
the markup is deliberately not the test: what the User Data FAQ asks for is a disclosure in the
product's own UI, and the markup existing in the source is not that.

**Two decisions recorded so a well-meaning cleanup does not undo them.** D1: the broad
`http(s)://*/*` host permission **stays** — it exists for the registered MAIN-world content script,
which is what keeps the overlay alive when the user navigates — and the form justifies it by exactly
that behaviour and by nothing else. That testability is also true, and is not a justification the
store accepts, which is why the copy does not mention it. D4: a non-loopback plain-http sidecar
endpoint is **justified, not a gap** — the endpoint is user-specified and no developer server is
involved (User Data FAQ §15), loopback additionally exempt (§16).

**CI runs both new checks**, and the policy site is built there too, so a broken renderer fails before
anything is published.

### Verified

`npm run verify` green on this branch: `typecheck` + `typecheck:ext`, **675 unit tests** in 30 files,
`build` + `build:ext`, the size guard, the pack/embed/e2e smokes, **47 extension smoke checks** in a
real Chrome (46 in 0.3.2; the disclosure case is new) and the new **38-check** store compliance smoke.
`npm run secret-scan` clean, `npm run spec` **130/130 valid**, and
`scripts/release-preflight.mjs --tag v0.4.0` accepts the tag against `package.json`,
`extension/manifest.json` and this section.

The extension smoke's attach probe has a fixed 20 s budget and no retry, and one local run on this
commit lost that race — `no extension service worker matching /bluepencil/i`, with a worker whose URL
ends in `/sw.js` (the file the manifest registers) probed once, recorded as `no manifest` and skipped
for the rest of the budget. The same commit then passed twice in a row and passed in CI, so it is a
false negative in the harness, not a regression here. Filed as #60.

### Known gaps

- **The store credentials do not work yet (#58).** `action: check-credentials` gets
  `401 unauthorized_client` from Google's token endpoint: the refresh token is not accepted for the
  client id in the secrets (a token minted for another client, or one expired — the documented setup
  keeps the consent screen in *Testing*, where Google expires refresh tokens after 7 days). Until it
  is regenerated, the store leg starts on every release and fails there: the release itself is
  unaffected, and nothing is uploaded or staged. #58 has the fix and the command that re-tests it.
- **The first submission and the listing stay manual.** The API can publish a new version of an item;
  it cannot create one, so the artefact and the form go in by hand once (icon, screenshots, the
  privacy-practices fields from `docs/WEBSTORE.md`).
- **The broad host permission costs review time** — the accepted price of D1. The narrower
  `activeTab`-only shape is written up in `docs/WEBSTORE.md` as the alternative, not as work in flight.
- Publishing to the npm registry is still not part of the release (no token set): install from the tag
  (`npm i github:Popoboxxo/bluepencil#v0.4.0`) or take the `.tgz` from the GitHub release.

## [0.3.2] - 2026-10-02

### Fixed

**The extension's settings reach the layer — and its rounds survive a reload (#53, #55).** The worker
wrote its configuration onto `<bluepencil-notes>` in the *loader's* spelling (`data-store`,
`data-adapter`, …), which only `dist/attach.js` translates. The element reads the plain names, so it
read nothing and used its default `memory` store while the attribute readback still said
`chromeStorage`: the settings page looked connected and every round died with the tab. Measured against
the built bundle before the fix — `adapter="localStorage"` → `localStorage`, but
`data-store="chromeStorage"` → `memory`.

The translation now lives in one place, `extension/src/handoff.ts` (unit-tested), and the worker builds
the element's attributes from it. The vocabulary that comes with it: the environment is
`dev|staging|live` (the page offered `prod`, which the element rejects, and a stored `prod` is read as
`live`), `identity` is `prompt|anonymous` (`page` was never a mode the element had), a note's route
comes from `route="url"` instead of the `data-bluepencil-url` that nothing read, and a sidecar store
without a URL is refused when it is saved rather than failing on the first note.

**The store the extension ships with can now persist.** The layer runs in the page's own world, and
that world has no `chrome.storage` at all — the page's `chrome` object carries `loadTimes`, `csi` and
`app`. So the configured store degraded to `memory` even once the settings arrived. The isolated-world
bridge now relays `get`/`set`/`remove`, and the element bundle re-exports `registerAdapter` so the page
can point `chromeStorage` at that relay before the element is defined. A relay that never answers does
not hang the store: it rejects after 8 s and the adapter's documented degrade path takes over.

### Changed

**The README describes every way in, and the extension itself (#54).** Eight integration modes — npm
subpaths, the classic `<script>`/IIFE build, the one-tag attach loader, the element alone, a
bookmarklet, a self-hosted sidecar, the Chromium extension and the headless CLI/MCP/`bluepencil/data`
surfaces — each checked against the code rather than paraphrased, plus the extension's requirements
(Chrome 116+, `npm run build` → `build:ext`, *Load unpacked* from `extension/dist`, or the release
zip), its settings and the credential it sends — `x-bluepencil-auth` for a shared secret,
`Authorization: Bearer …` for a token.

### Verified

`npm run verify` green on this branch — 675 unit tests (30 files), the packaging, embed and e2e
smokes, and **46 extension smoke checks** in a real Chrome. The extension smoke now asserts the
effect instead of the attribute it used to read: the layer's `adapter` is `chromeStorage`, no `data-*`
configuration attribute is left on the element, and a sentinel written from the page comes back out of
`chrome.storage.local` in the worker — a page → bridge → storage → page round trip with an independent
readback. `npm run secret-scan` clean, and `scripts/release-preflight.mjs --tag v0.3.2` accepts the tag
against `package.json`, `extension/manifest.json` and this section.

The options-page check also stops racing the page it checks. It gated on `#auth`, which is in the
parsed HTML before `options.js` — a deferred module — has run at all, so filling the form first let the
page's own `load()` → `fill()` overwrite the values, the save stored the defaults, and the storage poll
timed out after 20 s. It hit CI on this branch — the same commit ran green once and red once on exactly
that poll, while 0.3.1 was green twice — so the race is older than the checks added here, which changed
the timing that exposed it. The gate is now `#credential-hint`, empty in the markup and written only by
`describeCredential()`, the last thing `load()` does, and a refused save reports the page's own
sentence instead of looking like a slow one.

### Known gaps

- The bridge relays over the page's own message channel, so a page that blocks `postMessage` on its
  window (a hostile CSP, a script that stops the event) keeps the layer on `memory`. The smoke covers
  the normal path, and the relay fails loudly rather than silently — but it is a dependency on the
  host page that was not there before.
- Two traps found while verifying are fixed, and worth knowing as a class: `postMessage` delivers a
  message to the listener of the window that sent it (so matching `source` + `requestId` alone matches
  the *request*, not the answer), and a backtick inside a comment inside a template literal ends the
  literal. Both bit the extension's page-side probes before they bit anything else.
- Publishing to the npm registry is still not part of the release (no token set): install from the tag
  (`npm i github:Popoboxxo/bluepencil#v0.3.2`) or take the `.tgz` from the GitHub release.

## [0.3.1] - 2026-10-01

### Changed

**The test suite runs on Vitest 5, which needs Node 22.12 or newer.** The version bump alone was not
enough: three things in the harness stopped working with it.

- `environmentMatchGlobs` is gone. Each Node-facing suite now says what it needs itself, with a
  `@vitest-environment node` docblock in its header — the same reason, in the file that has the
  requirement, instead of a list in the config that can drift from it.
- jsdom exposes `localStorage` and `customElements` as getters with no setter, so the tests that
  install their own version of either need a property descriptor: a plain assignment throws
  `Cannot set property … which has only a getter`. Where a case used `delete` to simulate "no
  `customElements` at all", that deletion was a silent no-op on jsdom's getter — it now goes through
  the descriptor, so the case tests the guard rather than re-testing the happy path.
- jsdom's selector engine installs a `click`/`keydown` pair on the document the first time it
  queries. The "a disabled layer attaches no listener" case therefore measures the delta around
  `createLayer` instead of assuming a silent document, which is what it always meant.

### Fixed

**The settings page is readable in either colour scheme.** It inherited the browser's text colour for
everything it did not paint itself — which is exactly the text the browser paints. In dark mode the
sidecar warning and the options of the open dropdown were white on white; on the shipped 0.3.0 page the
warning measured **1.04:1**, rendered but unreadable, and the option row vanished completely.

Native controls now carry the browser's own `Field`/`FieldText` pair, so the closed field *and* the
popup it opens get a background and a text colour that belong together, and the page's palette (muted
text, borders, warning, status) is defined per scheme instead of being inherited. `npm run smoke:ext`
measures the contrast of every field in both schemes and fails below 4.5:1, so the next palette change
has to keep the page readable rather than merely keeping it pretty.

### Verified

`npm run verify` green on this branch — 666 unit tests on Vitest 5 (Node 22.23), the packaging,
embed and e2e smokes, and 41 extension smoke checks including the contrast cases in both colour
schemes. `npm run secret-scan` clean, and `scripts/release-preflight.mjs --tag v0.3.1` accepts the
tag against `package.json`, `extension/manifest.json` and this section.

### Known gaps

- The open `<select>` dropdown is a platform window, so the smoke measures the `Field`/`FieldText`
  pair the browser paints for the control *and* that window — not the popup's pixels. It still
  wants one look from a human in a real Chrome.
- Publishing to the npm registry is not part of the release (no token set): install from the tag
  (`npm i github:Popoboxxo/bluepencil#v0.3.1`) or take the `.tgz` from the GitHub release.
- Vitest 5 needs Node ≥ 22.12 for the *toolchain*; the library itself is unchanged and still
  declares `engines: node >= 20`.

## [0.3.0] - 2026-10-01

### Added

**A sidecar can require a shared secret (`--auth-secret`, #36 phase 1).** A sidecar bound to
loopback needs no authentication — it is as protected as the file it writes to — but the moment it
binds beyond loopback to be reachable from another device, nothing stood between the network and the
notes. Every request under the base must now present the secret in `x-bluepencil-auth`; anything else
is answered `401 {"error":{"code":"unauthorized"}}`. Prefer `BLUEPENCIL_AUTH_SECRET` over the flag: a
secret on a command line is visible in the process list to every other user on the machine.

The check runs *before* routing, so no route can forget it and an unauthenticated caller cannot learn
which paths exist by watching 405s turn into 404s. It sits after the "not under the base" 404 on
purpose — answering 401 to a request that could not be the API at all would make a sidecar on a
shared host 401 every unrelated request.

**The extension can reach that sidecar.** `endpoint` and `token` existed in the settings since #34 and
were used nowhere, so choosing the `http` store silently stayed local. The bootstrap now passes
`data-endpoint`, `data-token` and `data-token-header` on to the element, which already understood them.

**The layer can be switched on and off.** The toolbar button mounts; the options page and a page can
now turn the layer off again. Switching off sets the element's `enabled` attribute rather than
removing it, so open notes survive and the layer comes back without a second injection. A page drives
it over `postMessage`:

```js
window.postMessage({ source: "bluepencil-page", kind: "toggle", enabled: false, requestId: "1" },
                    window.location.origin);
```

Wiring this up exposed a bridge that was deaf to the page: it listened on
`chrome.runtime.onMessage`, which never fires for a page's `postMessage`. The mount worked only
because it went through the worker. The bridge now listens on `window.message`, and the dead
`onMessage` branch is gone.

**A GitHub workflow builds the packaged extension.** `.github/workflows/extension.yml` builds the
library, builds the extension, re-runs the smoke test on the CI machine, zips `extension/dist` and
attaches it as an artefact. On a `v*` tag it also creates a release and attaches the zip there. This
is separate from the existing CI, which already runs `build:ext` and `smoke:ext` — this one produces
the packaged thing rather than testing it.

**A Chromium extension that ships the review layer (#34).** `extension/` builds an installable MV3
extension that mounts the same element on any page. Mounting into an arbitrary third-party page
turned out to be the hard part, and every assumption about it was wrong until Chrome 151 was
measured:

- the element cannot run in the isolated content-script world — `customElements` is `null` there
  (`typeof` still reports `"object"`), which is the #32 defect, fixed in this release;
- it cannot `import()` a `chrome-extension://` URL: *"Failed to fetch dynamically imported module"* —
  a page may not load the extension's origin;
- the worker cannot `import()` itself: *"import() is disallowed on ServiceWorkerGlobalScope"*;
- no source text may be evaluated anywhere in the page's world: *"Evaluating a string as JavaScript
  violates the following Content Security Policy directive because 'unsafe-eval' is not an allowed
  source of script: script-src 'self'"* — and that holds regardless of how the string arrives, so
  passing the bundle in as an argument does not help either.

What works is a content script registered with `world: "MAIN"`: Chrome loads a **packaged file** into
the page's own world even under a strict CSP. So the element bundle is compiled *into*
`extension/src/bootstrap.ts` and the whole thing ships as one static classic script. Runtime delivery
across the boundary is data only — the worker hands over the settings as a plain object. The layer's
own constructable-stylesheet fallback (#33) is what keeps it styled on those pages, so an extension
does not bypass a CSP, it works inside one.

Also new: a `chromeStorage` store adapter (`src/adapters/chrome-storage.ts`) putting notes in
`chrome.storage.local` through the existing JSON-adapter abstraction, an options page, and
`npm run smoke:ext` — 32 checks covering the static packaging plus a real round trip through Chrome
against a `script-src 'self'` host.

Host access is `http://*/*` and `https://*/*` plus `activeTab`. `file:///*` is deliberately absent,
and so is `<all_urls>`.

**A sidecar can hand out signed, per-device tokens (`--token-key`, #36 phase 2).** The shared secret
has no expiry, no scope and no revocation: every client holds the same string, so withdrawing it
means rotating it everywhere at once, and a lost laptop keeps working until somebody notices. With
`BLUEPENCIL_TOKEN_KEY` (or `--token-key`) set, the sidecar signs an HS256 token per device instead
and clients present it as `Authorization: Bearer …`. Verification runs before routing, exactly like
the secret check, and the verdicts stay apart because the advice differs: `401 token_expired`
(replace it) is not `401 token_revoked` (do not replace it — that device was cut off on purpose), and
a valid token missing the required scope is `403 insufficient_scope`, because re-authenticating
cannot help. `GET` needs `read`, every mutation needs `write`, and `write` implies `read`. Tokens
carry a `jti`; `--revoked-tokens <file>` (a JSON array of ids, read once at startup — a revocation
list kept in memory would be undone by the next restart) refuses them by id. A corrupt or unreadable
file is a startup failure rather than a silently empty list.

`bluepencil token --device <name> [--scope read|write] [--ttl <seconds>]` mints one — a local
command, not an HTTP endpoint, because issuing credentials must not require an unauthenticated route
on the thing those credentials protect. The token is the only thing on stdout and the context goes to
stderr, so `export BLUEPENCIL_TOKEN=$(bluepencil token --device work-laptop)` works, and the printed
id is what goes into the revocation file.

**The extension can carry either credential.** The options page asks *which* credential the sidecar
expects instead of guessing a header: *None*, *Shared secret* (`x-bluepencil-auth`, phase 1) or
*Signed token* (`Authorization: Bearer`, phase 2). The value is not a free-form header name on
purpose — the right secret under the wrong header is a 401 that reads like a dead server. A signed
token also brings a device name (a revocation list is read by a human) and a status line: the
extension reads `exp` out of the token when it is saved and says "expires in about 6 h 12 min", or
"this token has expired", or plainly that the expiry could not be read. It is a warning and never a
decision — the sidecar is the only party that decides whether a token is good.

**The extension smoke now covers the options page.** Six cases open `options.html` in the running
extension, assert the three credential modes, save a token mode with a device name, and read back
what actually landed in `chrome.storage`: the mode, the device name and an expiry derived from the
token rather than typed. The page is where a credential is entered and it had no test at all — the
suite covered mounting and nothing else. 39 checks now (was 34).

**A signed token is accepted before the shared secret.** Both credentials can be configured at once:
the token is checked first (it is the stronger one) and the shared secret is still honoured, so a CLI
without a token flow keeps working. A *configured* credential is then required — and a sidecar with
no credential configured stays exactly as it was: it serves anyone who asks, and does not judge an
`Authorization` header it never asked for (a page may well be sending one for its own API on the
same origin).

**A tag is the only thing that publishes, and one workflow owns it.** `.github/workflows/release.yml`
runs the full `verify`, the secret scan and the spec check *on the tagged commit* — a tag used to be
the one revision no workflow checked, because `ci.yml` listens to branches — then builds all five
assets, writes **one** `SHA256SUMS` over them, verifies the set against it, and publishes the release
with the changelog section as its body. `scripts/release-preflight.mjs` refuses a tag whose version
does not match `package.json`, `extension/manifest.json` and a non-empty `CHANGELOG.md` section, and it
is runnable before the tag exists (`node scripts/release-preflight.mjs --tag v0.3.0`). Re-running a
release updates it instead of failing, so a half-written release is recoverable. The extension
workflow no longer creates releases: two workflows publishing the same release was a race over its
body.

**The MV3 extension is a release asset.** `bluepencil-extension-<version>.zip` — unpack the folder and
load it as an unpacked extension — is built and smoke-tested in the same job that publishes it, and it
is covered by the same `SHA256SUMS` as the loader, the layer and the tarball.


- `GET {base}/notes/{id}` — one note, canonically (`?environment=` gates the read, NFR-18). The MCP
  server already exposed this as `get_note`; over HTTP a tool had to fetch the whole set and pick the
  entry out of it.

- **E2E suite against the fixture app (NFR-11).** `tests/e2e/vanilla.e2e.mjs` walks the manual
  checklist of `examples/vanilla/README.md` in a real browser: mount and surfaces, the four
  shortcuts, the seed import (counters, markers, idempotence), text/design/quote capture with a
  reload, panel order and filters, done-hidden default, feedback-only, the decision thread on the
  shadow-DOM card, byte-identical exports and enable/disable cycles without residue. Wired into
  `npm run verify` and CI.
- `scripts/lib/browser.mjs` — the CDP browser layer the embed smoke used internally, now shared and
  extended with real input (mouse clicks at an element, key events, downloads). It activates the
  page target before synthesizing input (a headless target is otherwise not focused and clicks land
  nowhere) and types with key events, because `Input.insertText` is missing from some Chrome builds.

### Fixed

**The documented install from a tag did not work.** The README has offered
`npm i github:Popoboxxo/bluepencil#v0.2.0` since 0.2.0, but there was no `prepare` script and `dist/`
is not committed: the install produced a package whose every `exports` entry pointed at nothing, so the
only path that worked was the attached tarball. The build now runs during install (`prepare`), which is
what that instruction always assumed.

**`--auth-secret` never reached the handler, so a real sidecar with a shared secret served every
request unauthenticated.** It was parsed, validated, resolved into the options — and then not passed
into the `HandlerContext` the routes read. The unit tests could not see it, because they build the
context themselves: they proved the *check* worked, not that it was *installed*. Found while wiring
phase 2 through the same object. Three cases that start a real server
(`tests/unit/server-token-wiring.test.ts`) now cover that level.

**The extension was not typechecked anywhere.** The root `tsconfig.json` includes `src/`, `server/`,
`tests/` and `vitest.config.ts` — not `extension/` — so `tsc --noEmit` stayed green while
`extension/src/settings.ts` held a possibly-undefined index access (`parts[1]` under
`noUncheckedIndexedAccess`) and `sw.ts` carried a constant nothing read. The extension has its own
config now (browser libraries, no Node types, `chrome.*` still declared per file) wired in as
`npm run typecheck:ext`, and the built element bundle it imports is described by an ambient
declaration so the check does not depend on `npm run build` having run first.

**The declaration build silently depended on nothing in `src/` importing `server/`.**
`tsconfig.types.json` maps `src/` one-to-one onto `dist/types/`, and that only holds while every file
in that program lives under `src/`. The new `bluepencil token` dispatch imports `server/mint-cli.ts`
from `src/cli/bin.ts` — the first such import — which widened the inferred `rootDir` to the
repository root, moved every declaration to `dist/types/src/…`, and failed the packaging smoke with
twelve missing paths. `src/cli/**` is excluded from the declaration emit (its `bin` has no `types`
entry in `exports`); `npm run typecheck` still covers it, because the root config includes `src/` and
`server/`.

**CI did not run the extension it claimed to.** The 0.2.0 entry below says the extension is covered
by CI. It was not: `build:ext` and `smoke:ext` lived only in `npm run verify`, which CI never calls,
so the extension was built and smoke-tested locally and nowhere else. Both are steps of the `verify`
job now.

**The extension smoke could not run in CI on the runner's Chrome, and silently said nothing.** It
loaded the unpacked extension with `--load-extension`, which branded Chrome removed in 137: the
runner's `google-chrome-stable` accepts the flag and ignores it, so the extension's own worker never
appeared and the suite failed at the attach with `no extension service worker matching /bluepencil/i`
— the only worker on the wire belonged to a component extension. It now uses the supported route,
`Extensions.loadUnpacked` (which needs `--enable-unsafe-extension-debugging`, and the pipe transport
this launcher already uses), and keeps `--load-extension` as the fallback for builds that predate the
command. The worker is also identified by its own `chrome.runtime.getManifest().name` instead of by
its URL, because this browser ships other extensions with workers of their own and the first
`chrome-extension://` target is not necessarily ours. The suite reports which route it took, so a
future removal shows up in the output rather than as "nothing was injected".

**The `chromeStorage` adapter was not emitted by the build, while `package.json` exported it.** The
adapters build lists its entry points explicitly and the new adapter was missing from that list, so
`./dist/adapters/chrome-storage.js` did not exist while `"./adapters/chrome-storage"` pointed at it.
The packaging smoke test caught it in CI; a plain `npm run build` did not, because the build itself
had nothing to complain about.

The size guard carried the same list, hard-coded in a filter regex, and would have silently counted
the new adapter into the "core without adapters" figure instead of stubbing it out — making the
budget look tighter than it was, with nothing failing. Both lists now derive from one constant, so
adding an adapter can no longer leave one of them behind. Measured effect: the core figure went from
37.0 kB to 35.4 kB gzip, which is the fifth adapter no longer inflating it.

**The layer rendered unstyled under a page CSP that forbids inline styles (#33).** `acquireStyles()`
inserted a `<style>` element and assumed it had taken effect. A content security policy without
`'unsafe-inline'` in `style-src` changes that silently: the node stays in the document, but the
engine never applies it, so `node.sheet` is `null` and the sheet has no `CSSStyleSheet` behind it
at all. That is worse than a missing stylesheet, because everything *looks* mounted — the root and
the bar are there, unstyled and unpositioned. The failure was also documented backwards: the
bookmarklet and troubleshooting sections recommended a browser extension as the way around a strict
CSP, while the element layer was in fact the component that broke under it.

The layer now verifies the inline node instead of trusting it, and falls back to a constructable
`CSSStyleSheet` on `document.adoptedStyleSheets`, which a page CSP does not govern. Teardown
restores whatever the document had adopted before, so a host's own sheets survive a layer that
mounts and unmounts. If the engine supports neither path, the unverified node is kept: a document
with a present-but-unapplied sheet is still better than an unstyled one.

Scope, measured rather than assumed: under the common policy shape — `style-src 'self'
'unsafe-inline'` with a strict `script-src` — the inline sheet is applied normally (93 rules,
`position: fixed`, `z-index: 2147483000`, no violations), so this is hardening, not a fix for a
broad breakage. The silent case is the strict one.

**`defineBluepencilElement()` threw on import wherever `customElements` is null, taking the whole
element bundle with it (#32).** The guard tested `typeof customElements === "undefined"`, which is
not the same question. An environment that shadows or stubs the global can expose
`customElements` as `null`, and `typeof null` is `"object"` — so the guard passed and `get()`
threw `TypeError: Cannot read properties of null (reading 'get')`. Because the call runs at module
top level, the exception aborted the evaluation of the bundle: a consumer that merely imported it
got a crash instead of an import, and the element never registered. Chromium's isolated
content-script world is one such environment (measured: `typeof customElements === "object"`,
value `null`); a host that stubs the global hits it too, so this was never extension-specific. The
guard now tests the value rather than its type, making a missing registry a quiet no-op.

The six defects below were found by a review round against a real embedded deployment (0.2.0). All
of them were reproduced against the shipped builds before the fix and carry a regression test.

- **A mistyped filter field deleted every note.** `POST {base}/notes/bulk-delete` ignored unknown
  keys in its `filter` object, so `{"filter": {"statuz": "open"}, "confirm": true}` became an
  *empty* filter — and an empty filter matches every note. Measured: `200 {"removed": 4}` of 4
  notes, no warning. An unknown field is now refused with `400 invalid_payload` and the list of
  allowed names, and an empty `filter` object is refused instead of meaning "remove everything".
- **The Markdown export could carry live HTML.** User text in the *inline* fields (the note id in
  the heading, the author, captured style keys and values) was not escaped for `&`, `<` and `>`.
  A note id of `n-<script>alert(1)</script>` rendered as six live `<script>` elements in a
  conforming Markdown viewer (measured with mistune). Those fields are escaped now, and a value
  containing a backtick keeps its code span instead of falling back to plain text.
- **A failed runtime update removed the review layer.** The loader tore the old layer down *before*
  importing the new build, so a 404, a CSP block or a corrupt file left the page with no layer and
  no way back without a reload. The new build is loaded first now; the old one is only replaced
  once the new one is known to import.
- **One failed manifest poll disabled updating for the rest of the page's life.** `check()` re-armed
  the watch only on its two success paths; a transient 500, a refused digest or a manifest without a
  version cancelled the timer and nothing re-armed it. The watch is now re-armed on every exit.
- **`destroy()` could be undone by an in-flight `check()`.** A check that was already past its
  awaits re-mounted the layer after `destroy()` had run. A destroyed flag is now checked at every
  await boundary.
- **Dark mode overrode the host's design tokens.** The `@media (prefers-color-scheme: dark)` block
  re-declared thirteen `--bp-*` tokens on the layer root, and a custom property set on the element
  beats an inherited one — so a host following the documented `:root { --bp-accent: … }` recipe lost
  its palette the moment the OS turned dark (measured: the library's `#7ba2ff` instead of the
  host's `#8c3b2e`). The dark palette is now a `var()` fallback, so a host value always wins.

### Changed

- The extension's credential is a **mode** (`none` / `secret` / `token`) instead of a bare token
  field, and the token's expiry is derived from the token at save time rather than typed by the user.
  The options page can therefore tell a shared secret from a signed token, which no amount of
  guessing a header name would have made reliable.
- The two per-file test environments the new token suites need are declared in `vitest.config.ts`. A
  suite that runs in the wrong environment fails for a reason that says nothing about the code
  (eleven `createHmac is not a function` errors under jsdom) — and a suite that is not collected at
  all is worse: it is a silent green.
- The CLI derives the export environment from the notes instead of inventing `dev`, and only
  re-tags when `--environment` is given explicitly. A bare `Note[]` carrying a `live` note was
  silently rewritten to `dev`; a mixed set is now refused with exit code 3, the same rule the
  Blueprint/UI path already applied (FR-14.1, NFR-18).
- The CLI export and merge paths pass the bundle's `sessions` through, so a human label
  (`"Fixture smoke review"`) and a session without notes survive an export instead of being
  replaced by the session ref or dropped.
- `app.name` of a CLI export is the input file's basename, not its full path.
- `docs/INTEGRATION.md` §8 documents all 18 theme tokens, the dark-mode precedence, how to force a
  scheme, the partial-pin hazard, and the fact that font and font size are not inherited by default.
- CI runs on Node 22. The extension workflow packages `bluepencil-extension-<version>.zip` named after
  the version in `package.json` instead of the git ref, and both workflows cancel a superseded run of
  the same branch. Dependabot watches the npm and the GitHub Actions ecosystems, weekly and grouped.
- `docs/RELEASING.md` documents the order (bump → changelog → preflight → PR → tag), what the release
  workflow checks, and what is deliberately not automated.



- `POST {base}/notes` refuses an unknown body field with `400 invalid_payload` instead of silently
  dropping it. `{"route": "/cart"}` (or `"session": "s1"`) used to answer `200` while storing
  nothing — the page belongs to `anchor.route`, the review round is `sessionRef` — and the note was
  then invisible to the very `?route=` filter the caller believed it had set. The refusal names the
  right place for the common near-misses.
- The embed smoke now drives the browser through the shared `scripts/lib/browser.mjs` instead of a
  private copy of the CDP client; its 14 cases are unchanged and still green.
- The store journal records **who** asked for a change (FR-18): `X-Bluepencil-Actor`, otherwise the
  payload's `author`. The `file` backend writes it into the entry, the `git` backend into an
  `Actor:` commit trailer and `{actor}` in `--journal-subject`, and `GET {base}/journal` reports it.
  Before, every entry carried no actor at all — the trail could say *what* changed, never *who*.

### Known gaps

- There is no token **refresh**: an expired token is replaced by hand (mint a new one, paste it into
  the options page). Nothing hands out credentials automatically — deliberately, since that would
  need an unauthenticated route on the sidecar the token protects. The options page says when the
  token expires, which is as much warning as this release offers.
- The revocation list is read **once at startup**. Revoking a device means editing the file and
  restarting the sidecar; the list is not watched, so a running sidecar does not notice an edit.
- `--token-ttl` applies to newly issued tokens only. A token already in the wild keeps the lifetime
  it was minted with, which is what makes the value safe to change on a running deployment.
- `F` arms the feedback flag only; an element is picked while a mode (`C`/`D`) is armed. The fixture
  checklist claimed otherwise and now says so — the layer behaviour is unchanged, the documentation
  was one step short.

## [0.2.0] - 2026-09-21

The first release without an alpha suffix. Both changes come from a real review round against an
embedded deployment rather than from reading the code: a reviewer's notes were reported as
*orphaned* although nothing was wrong with them, and the exported bundle could not say which app
it had come from. Neither change alters an existing contract — an anchor of an element that is
always visible serialises byte-identically, and the bundle defaults stay `"unknown"`.

### Added
- **Transient container reveal (issue #20).** A target that only exists in a transient UI state
  (a closed dialog or popover, an inactive tab, a collapsed menu) used to be unreachable: hook,
  CSS path *and* quote all fail in the default state of the very route it was captured on, so the
  panel said "not findable". `captureReveal` now records the container's kind and the element that
  opens it — the host's explicit `data-bluepencil-reveal`, a native `popovertarget`, the
  `role="tab"` of a tabpanel, or any element with `aria-controls` — and
  `revealAnchor`/`revealAnchorDetailed(anchor)` activates that trigger, waits for the host to
  settle and resolves again. Two attempts, because the first click can *close* a container that
  happened to be open; a resolution is still never invented, and the panel distinguishes "behind a
  closed container" from "unreachable". The hint travels as the new `reveal` field on the anchor
  (validated, canonically ordered, migrated for older documents).
- **Resolution strategy reported (FR-2.1).** `resolveAnchorDetailed` returns which fallback matched
  (`hook`, `selector` or `quote`), so a host can measure how much of its anchor set still resolves
  through the intended hook instead of the text fallback.
- **Bundle metadata from a tag-embedded host (issue #21).** `app`, `build-ref` and `exported-by`
  are element and loader attributes now and fill `app.name`, `app.buildRef` and `exportedBy` of an
  exported bundle; `build-ref` doubles as `context.buildRef` for design notes, so a host declares
  its build once. The layer also stamps the environment it was configured with into the export, so
  a `live` deployment no longer exports `"dev"`.

### Changed
- **Core bundle budget raised from 31 kB to 33 kB (NFR-3)**, measured at 31.9 kB gzip for the
  reveal capability and the bundle metadata. The reason is recorded in the guard header and in the
  requirement row, as before, so the number reads as a decision and not as drift.

### Fixed
- Notes anchored to elements inside a closed dialog, popover or inactive tab are no longer reported
  as orphaned. Measured on the real review round: 4 of 7 anchors of one session were unresolvable
  in the default DOM state of their own route (issue #20).

### Verified
- 503 unit tests in 20 files, typecheck, build, size guard, CLI/MCP/packaging smoke and the
  browser legs of the embed smoke (14 cases, real Chrome).

### Known gaps
- Not on npm yet: install from the tag (`npm i github:Popoboxxo/bluepencil#v0.2.0`) or use the
  attached build artefacts.
- The sidecar data-access work (`GET {base}/notes/{id}`, refusing unknown create fields, the actor
  in the journal) is **not** part of this release — it is still on `feat/sidecar-data-access`
  (PR #23).
- No Playwright E2E suite against the fixture; the browser round is covered by the embed smoke and
  the manual checklist in `examples/vanilla/README.md`.
- Still pre-1.0: the adapter wire formats and the journal file layout may change between minor
  releases; the API freezes at 1.0.0.

## [0.1.0-alpha.2] - 2026-09-17

The alpha that makes the documented paths true. Everything here was found by running the library
against a real host application rather than by reading it — including three bugs that only showed up
there. Nothing in this release changes an existing contract: `prompt`/`anonymous` identity, the
existing attributes and the layer API behave as before.

### Fixed
- **The documented one-tag embedding actually embeds (issue #11).** `<script src="…/attach.js">` with no
  `data-*` attribute at all never attached: script discovery required at least one known key, so the
  path the guide recommends was silently inert — no error, no console note. Scripts are now recognised
  by their source as well, and `bluepencilAttach.check()` re-scans the document, so a tag injected
  after `DOMContentLoaded` (SPA bootstrap, nginx, CMS) is picked up without a reload.
- **`identity` accepts a global path (issue #12).** A host wired through the tag can now pass its real
  user: `identity="myApp.identity"` resolving to `{ getUser() }`, exactly like `gate`, `route-from` and
  `headers-from`. Every note used to be attributed to `prompt` because the tag could not express this.
- **Links stay links while annotating.** Not a new behaviour, but it had no test: a click on `a[href]`
  follows its target in every mode instead of opening the composer. It is pinned now, with a
  falsification, so it cannot regress quietly.

### Added
- **The host's own target vocabulary (FR-1.12, issue #3).** `annotate-selectors=".card, .tile"` makes
  the nearest match in the click path the annotation target — in text *and* design mode, so the anchor
  is the component and not the heading inside it. `can-annotate="myApp.canAnnotate"` is the per-element
  veto. A component whose text lives in children is no longer silently inert.
- **One shortcut registry (FR-1.11, issue #4 finding 3).** The key handler dispatches from it, the help
  legend renders from it; a shortcut cannot exist in one and not the other, and a divergence fails a
  test. The prototype accepted `0–6` while nine chapters were reachable and its legend advertised `0–6`.
- **Configurable keymap (FR-12.11, issue #4 finding 8).** `keymap="bar=g, panel=p"` remaps shortcuts;
  the legend follows. Conflicts, unknown ids and keys that cannot be remapped (the `1…9` range, the
  composer-scoped save) are reported through `element.issues` instead of "last one wins".
- **Runtime chrome levels (FR-12.9, issue #4 finding 1).** `full` / `quiet` / `off` via
  `setChrome()`, the `h` shortcut or the host attribute; the choice is persisted, and `off` is
  deliberately not `disable()` — annotations and markers stay, only the layer's own controls go.
- **Addressable chrome state (FR-12.12, issue #4 finding 9).** `?bp-chrome=quiet` sets the level for one
  load and is never written back — for screenshots, QA runs and handovers.
- **Chrome slots, docking and the narrow rule (FR-12.10, FR-12.13, NFR-20, issue #4 findings 2/4/10).**
  Every surface declares its slot, so "no two surfaces overlap" is a property of the stylesheet;
  `dock="top"|"bottom"` moves the strip and its handle to the chosen edge and the mode hint to the
  opposite one; below 720 px the strip yields to its handle on its own and returns when the viewport
  grows. Verified by a new mandatory browser leg that measures boxes, overlap area and `scrollWidth`
  across 360/390/768/1024/1280/1440 px — in real windows, one Chrome per viewport.

### Changed
- **Core bundle budget raised from 30 kB to 31 kB (NFR-3).** The host-facing capability set above added
  real code (measured 30.5 kB gzip, 101.7 % of the old line). The reason is recorded in the guard
  header and in the requirement row, so the number reads as a decision and not as drift.
- **CI: the browser leg retries the Chrome launch** (three attempts, fresh profile each, still
  fail-closed) and reports an unusable browser as `BROWSER-UNAVAILABLE` instead of looking like a
  failed assertion (issue #18). A runner hiccup used to fail a run for an unchanged commit.

### Known gaps in this alpha
- No npm publish: install from the tag (`npm i github:Popoboxxo/bluepencil#v0.1.0-alpha.2`) or use the
  attached build artefacts.
- The geometry leg needs a Chrome that can be *started*; if the environment cannot provide one, the run
  fails with `BROWSER-UNAVAILABLE` and says so — it skips nothing.
- Still an alpha: the adapter wire formats and the journal file layout may change between alphas.

## [0.1.0-alpha.1] - 2026-09-17

First release. Everything listed here is built, tested and green; the known gaps are listed with it
rather than left to be discovered.

### Added
- **One-tag embedding (FR-17):** `attach.js` plus `<bluepencil-notes>` — no build step in the host and
  no JavaScript to write. Configuration lives in attributes: remote store (`endpoint`, `headers`,
  `headers-from`, `token`, `token-header`, `token-scheme`), routing (`route`, `route-from`), host gate
  (`gate`), theming (`theme`, `theme-accent`, `theme-surface`), manifest-driven runtime updates
  (`data-manifest`, `data-integrity`, `data-watch`) and the `window.bluepencilAttach` surface.
- **Store journal (FR-18):** every accepted mutation is recorded — as a coalesced commit inside the
  git work tree, as a hash-chained `journal.jsonl` without git, or not at all (`--journal none`).
  `GET {base}/journal?since=<seq>` answers "what changed since my last round" for agents. The commit
  identity is configurable (`--journal-author`, `BLUEPENCIL_JOURNAL_AUTHOR`) and reported in the
  journal status.
- **The version is visible everywhere (FR-19):** `data-bp-version` on the element,
  `window.bluepencilAttach.version`, `attach-version`, the sidecar's `/health` and `--version`, the
  CLI and the MCP handshake — one source, `package.json`.
- Examples for both embedding paths (`examples/presentation`, `examples/attach` with a self-test
  probe) and the sidecar's static mode, so one origin serves the page and the API.

### Changed
- `route-from` calls the host function with the annotated element (`fn(element)`), so a note's route
  belongs to that note instead of to whatever happens to be scrolled into view. `route="url"` and
  zero-parameter hosts behave exactly as before.
- The journal's commit is path-limited (`git add -- <paths>`, `git commit --only -- <paths>`): work
  somebody else staged in the same work tree can no longer ride along in a notes commit.

### Verified
- 444 unit tests in 18 files, typecheck, build, size guard, CLI/MCP/packaging smoke, secret scan.
- Embed smoke in a real browser: 13 cases, and the browser leg is mandatory in CI — a missing browser
  fails the job instead of skipping silently.
- Run against a real third-party SPA (ReqogniLoom, React 18 + Vite build): layer mounted, note
  round-trip against the sidecar answered 200, zero console errors, zero long tasks. That run is also
  where the two gaps below were found.

### Not in this alpha
- PR #10 (configurable `anchor-hooks` attribute) is not merged yet, so it is not part of this tag.
  The release commit is cut from `main` and reaches it through the release PR — only what is on `main`
  is released, which is exactly why the unmerged feature is absent.
- `can-annotate` is a library-only option without an attribute — the same class as issue #12.

### Known gaps (documented, not hidden)
- [#11](https://github.com/Popoboxxo/bluepencil/issues/11) — a loader tag injected after
  `DOMContentLoaded` stays silent, even after `check()`; the module path works.
- [#12](https://github.com/Popoboxxo/bluepencil/issues/12) — `identity` accepts no global path, so a
  tag-wired host cannot hand over its user and notes fall back to `"prompt"`.

## [Unreleased]

### Added
- `docs/CONCEPT.md` — problem statement, users, use cases, core concepts (note, anchor,
  context, intent, status, thread, session), anchoring strategy, deployment modes, agent
  collaboration model, non-goals, risks, roadmap M0–M6.
- `docs/REQUIREMENTS.md` — 60 functional requirements in eleven groups plus 14 non-functional
  requirements, each with priority (MoSCoW), target milestone and acceptance criteria, and a
  traceability table separating proven behaviour, known gaps and product-driven needs.
- `docs/ARCHITECTURE.md` — planned repository layout, public API sketch, TypeScript data model,
  adapter contract, HTTP contract for the reference server, bookmarklet design, theming rules,
  test strategy, release plan.
- `docs/PROTOCOL.md` — normative human/agent collaboration rules: how to implement, how to ask
  for a decision (with options and a recommendation), how to report, definition of done, hard
  prohibitions.
- `docs/INTEGRATION.md` — integration modes (embedded, local-only, bookmarklet, self-hosted,
  admin debug mode), host hooks, theming tokens, security and privacy notes, troubleshooting.
- `README.md` — project summary, name origin, non-negotiables, documentation index.

### Changed
- All eight open decisions resolved (recorded in `docs/REQUIREMENTS.md` § *Decisions* and
  `docs/ARCHITECTURE.md` §10b): one package, overlay markers, config-driven identity,
  configurable done-note default, retention server-side only, `data-bluepencil` +
  `data-testid`, retention defaults 90/180 days, **runtime activation as the primary use**.

### Added
- `FR-12` — runtime lifecycle and host variety: `enable()`/`disable()` with complete, idempotent
  teardown, mount scope and multiple instances, shadow-DOM-aware capture and anchoring,
  custom-element packaging, non-interference with host events, documented host variety.
- `NFR-15` (runtime parity) and `NFR-16` (three packaging forms: ESM dependency, standalone ES
  module resource, single-file IIFE/bookmarklet).
- `docs/ARCHITECTURE.md` §6b (lifecycle, shadow DOM, instances) and §6c (packaging matrix),
  custom-element build and Home Assistant example in the planned layout.
- `docs/CONCEPT.md` UC-9 (switching the layer on inside a product at runtime).

### Added (second review round)
- **FR-13** dev systems: the layer reads *and* writes during debugging — headless write API,
  note origin/source (`ui:human`, `agent`, `tool:test-runner`, …), optional dev auto-attach,
  debug context (stack trace, failing test, commit) and optional `file:line` references.
- **FR-14** live systems and exchange: environment tagging (`dev`/`staging`/`live`), portable
  export bundles, import with `merge`/`upsert`/`replace-session`, dry-run with
  added/updated/skipped/conflicts, round-trip fidelity, admin-only + audited in live systems,
  deliberate promotion between environments.
- **FR-15** headless data library and CLI (`bluepencil/data`, `bluepencil/cli`): read, write,
  merge, validate and inspect note sets without a browser; single source of truth for UI,
  server, CLI and MCP.
- **NFR-17** canonical diffable bundles · **NFR-18** environment isolation by default ·
  **NFR-19** interoperability without the tool.
- `docs/ARCHITECTURE.md` §5b (bundle format, merge semantics, environment rules) and §5c
  (headless library and CLI); planned `src/data/`, `src/cli/`, `examples/round-trip/`.
- `docs/CONCEPT.md` UC-10 (debugging with tool-written notes), UC-11 (notes travel between
  environments) and §5b “How notes travel”.
- `docs/PROTOCOL.md` §8: environment and exchange rules for humans and agents.
- Decisions D9 (dev systems read/write) and D10 (live integration + headless exchange library)
  recorded.

The documents above are the concept and requirements baseline for milestone M1; implementation
status per milestone is tracked in the version sections below.

## [0.1.0] — 2026-09-15

M1 implementation baseline on `feat/m1-core-ui-adapters`: model, anchoring, capture, store and
adapters, the headless data library, the exports, the collaboration protocol, the review layer, the
public API and the custom element, the CLI, the MCP server and the vanilla fixture are all in this
branch. What is *not* in it is listed under **Not yet**.

### Added
- `src/core/model.ts` — the frozen data model: note, message, anchor and captured-context types,
  the vocabulary (`text`/`design`, `implement`/`feedback`, `open`/`done`/`needs_decision`),
  note sources, debug context, schema version, bundle shape and the validation error class.
- `src/core/anchor.ts`, `src/core/capture.ts`, `src/core/adapter.ts`, `src/core/store.ts` — anchor
  resolution (host hook → CSS path → text quote, shadow boundaries encoded in the path), the curated
  element capture for design notes, the adapter contract and the store that owns sessions,
  environment and validation.
- `src/adapters/` — the four built-in adapters (`memory`, `localStorage`, `file`, `http`) behind one
  contract, covered by a single parameterised conformance suite (`tests/unit/adapters.test.ts`).
- `src/data/` — the DOM-free data library (`bluepencil/data`): schema and validators, canonical
  (diffable) bundles, the merge modes `merge` / `upsert` / `replace-session` with dry-run conflict
  reporting, and migrations for older documents.
- `src/core/export/` — the Markdown export (exception sections first, grouped by route, full
  threads) and the schema-versioned JSON export.
- `src/core/protocol.ts` — the collaboration protocol as code: intents, statuses, message kinds and
  the guards that keep a pending decision from being marked done.
- `src/ui/` — the review layer: bar, handle, markers, panel with filters, composer, settings and
  legend, all switchable at runtime with complete, idempotent teardown.
- `src/i18n/` — the `en`/`de` message tables and the lookup every surface uses.
- `src/index.ts` — the public API (`init`, `mount`, `createBlueprint`, `VERSION`) plus the
  `enable()` / `disable()` / `setEnabled()` / `export()` / `destroy()` handle.
- `src/element/index.ts` — the `<bluepencil-notes>` custom element (attributes and events) for hosts
  that load one ES module resource and have no build step (FR-12.5).
- `src/cli/bin.ts` — the CLI: `inspect`, `validate`, `notes`, `export`, `merge`, `import`, `mcp`,
  `demo`, with pipeline-meaningful exit codes (0 ok, 1 usage, 2 conflicts, 3 environment mismatch,
  4 invalid input).
- `src/mcp/tools.ts`, `src/mcp/server.ts` — the MCP server over stdio: nine tools, three resources
  and two prompts, **read-only by default**, bound to one store, one app and one environment.
- `scripts/build.mjs` — one source tree, several artifacts (NFR-16): `dist/bluepencil.js` (the ESM
  package entry), `dist/bluepencil.iife.js` (classic script / bookmarklet, global `bluepencil`),
  `dist/bluepencil.element.js` (custom element), `dist/cli.js`, `dist/mcp.js`, the subpath entries
  `dist/data.js`, `dist/adapters/*.js`, `dist/i18n/*.js` and the declarations in `dist/types/**`.
- `tests/unit/` — the unit suite: model, anchoring, capture, adapters (shared conformance suite),
  store, bundles and migrations, merge, exports, protocol and the UI layer.
- `docs/HERMES.md` — the MCP/Hermes integration: the wrapper registration, environment binding, the
  read-only default and the CLI paths.
- `examples/vanilla/` — the fixture app: a small dashboard that carries **every requirement group
  on one page** (headings, paragraphs, list, table with cells, form, links, KPI/card grid, one
  element inside a web component with a shadow root), a stable `data-bluepencil` hook on every
  annotatable element, a design-token style block with `--bp-*` overrides and a dark-mode media
  query, and a runtime on/off switch calling `enable()`/`disable()` without a reload. It degrades
  with an on-page notice instead of a broken page when the build has not run
  (`dist/bluepencil.iife.js`, with the module fallback on `dist/bluepencil.js`).
- `examples/vanilla/app.js` — the fixture's demo logic, plain ES2022, no dependencies: KPI grid,
  table, shadow-DOM component, seed import through the documented store API, and Markdown/JSON
  export through `bp.export({ format })`.
- `examples/vanilla/data/seed.bluepencil.json` — a portable 6-note bundle for the fixture: one
  `needs_decision` with a decision thread, one feedback-only note, one design note with captured
  context, one `done` note, one note written by tooling (source + debug context) and one plain
  open note; anchored to hooks that exist on the fixture page.
- `examples/vanilla/README.md` — smoke commands, the hook inventory, the seed-bundle table and the
  manual checklist for a review round (annotate text/design, quote, filter, done-hidden default,
  settings, feedback-only mode, decision thread, export Markdown/JSON).
- `scripts/serve-example.mjs` — dependency-free static server for the repository root on port
  9283, so `/dist/bluepencil.iife.js` and `/examples/vanilla/` share one origin. Flags: `--port`,
  `--root`, `--once` (serve one request and exit, for CI smoke tests), `--quiet`, `--help`.
- `README.md` — *Quick start*: build, serve, open the fixture, plus the one-line host integration
  and the runtime `enable()`/`disable()`/`export()`/`destroy()` handle.

### Changed
- `README.md` status line and documentation index: M1 is in progress instead of "no code yet";
  `docs/INTERNAL-API.md` and the fixture README are indexed.

### Not yet

- A Playwright E2E suite against the fixture (NFR-11, M1) — the browser round is covered by the
  manual checklist in `examples/vanilla/README.md` until it lands.
- A reference server implementing the documented HTTP contract (ARCHITECTURE §5, M2). The HTTP
  adapter speaks that contract and its endpoints are listed in `src/adapters/http.ts`; there is no
  server in this repository to speak to.
- An import surface in the UI (FR-14.7, M2). The merge modes themselves (FR-14.3) exist in the data
  library, the CLI and MCP; the browser layer exports but does not import yet.
- Bulk delete by filter with a confirm step (FR-8.2, M2) and a one-action session purge
  (FR-8.3, M2); the store already exposes `bulkRemove(filter)`, no UI control is wired to it.
- Retention of done notes (FR-8.4, M4) — server-side only by decision D5; the browser library never
  deletes on its own.
- i18n beyond `en`/`de` (FR-11.1, M6).
