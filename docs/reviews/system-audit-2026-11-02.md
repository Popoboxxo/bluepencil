# System Audit — bluepencil (2026-11-02)

- **Scope:** repository `bluepencil` at version `0.11.6` (`package.json`, `extension/manifest.json`), branch `chore/system-audit`. Covers `src/`, `server/`, `extension/src/`, `scripts/`, `docs/`, `spec/`, CI workflows.
- **Method:** audit only, no code changes. Static reading of source and docs, cross-checks against `CLAUDE.md`, `docs/ARCHITECTURE.md` and `docs/REQUIREMENTS.md`, grep-based dependency/caller analysis, and a read-only run of `node scripts/size-guard.mjs` against the existing `dist/`. Each finding was verified against the code; claims are reproducible by re-reading the cited lines.
- **Severity scale:**
  - **critical** — data loss, security breach or broken release; fix before any merge.
  - **high** — violates a normative project rule or requirement; fix in the current cycle.
  - **medium** — real drift or defect with limited impact; schedule a fix.
  - **low** — hygiene / maintainability; fix opportunistically.
- **Finding ID scheme:** `BP-nn` Best Practices, `SEC-nn` Security, `CQ-nn` Code Quality. IDs are stable once published.

---

## 1. Best Practices

### Findings

#### BP-01 — FR-17 … FR-20 are cited in code and docs but not defined in REQUIREMENTS.md
- **Severity:** high
- **Location:** `docs/REQUIREMENTS.md` (sections jump from `## FR-16` at line 227 to `## FR-21` at line 250); citations e.g. `src/embed/version.ts:2` (FR-17), `docs/EMBED.md:388` (FR-18), `docs/EMBED.md:455` (FR-19), `src/data/canonical.ts:119,154` (FR-20.4), `scripts/size-guard.mjs:17` (FR-20)
- **Description:** The code base cites FR-17 (attach loader, 27 references in `src/`/`server/`/`extension/src`), FR-18 (store journal, 35), FR-19 (version reporting, 6) and FR-20 plus FR-20.4–20.8 (presentation mode, 28). None of these IDs has a row in `docs/REQUIREMENTS.md`, so `spec/` (generated from it) has none either. `CLAUDE.md` says all requirements live in `docs/REQUIREMENTS.md`. Shipped features therefore have no acceptance criteria, and reqmd cannot trace them. The CI spec-sync gate (`.github/workflows/ci.yml` job `spec`) cannot catch this because the source table itself is incomplete.
- **Recommendation:** Add FR-17 … FR-20 sections, with acceptance criteria and milestones, to `docs/REQUIREMENTS.md` and regenerate `spec/` (`npm run spec`). Optionally add a check that fails when the code cites an ID the table does not define.

#### BP-02 — ARCHITECTURE.md headless example uses an API that does not exist
- **Severity:** medium
- **Location:** `docs/ARCHITECTURE.md:114`
- **Description:** The example `import { createStore, createNote, toMarkdown, mergeBundles } from "bluepencil/data"` fails. `src/data/index.ts:10-15` only re-exports `schema`, `canonical`, `bundle`, `merge`, `migrate` and `order`. `createStore` (`src/core/store.ts`), `createNote` (`src/core/model.ts`) and `toMarkdown` (`src/core/export/markdown.ts`) are not exported from that subpath. `mergeBundles` does not exist anywhere (the function is `mergeNotes`, `src/data/merge.ts:192`). Anyone who copies the example gets import errors.
- **Recommendation:** Rewrite the example against the real `bluepencil/data` surface (`mergeNotes`, `createBundle`, `serializeCanonical`, …), or export the intended symbols, and record that decision.

#### BP-03 — ARCHITECTURE.md repository layout is labelled "planned" and has drifted from reality
- **Severity:** medium
- **Location:** `docs/ARCHITECTURE.md:3`, `:8`, `:53`, `:57`, `:60`, `:61`
- **Description:** The layout still lists `src/react/`, `bookmarklet/`, `examples/react/` and `examples/home-assistant/`. None of them exist (`ls` verified). It leaves out modules that do exist: `src/embed/`, `src/ui/present.ts`, `src/ui/keymap.ts`, `extension/`, and the examples `attach`, `parity`, `presentation`, `voice`, `federation`. `CLAUDE.md` has the correct, current structure, so the two sources now disagree.
- **Recommendation:** Replace the "planned" tree with the current layout, taken from `CLAUDE.md` or generated. Move unbuilt items (React wrapper, HA example) to a roadmap note.

#### BP-04 — NFR-3 headline and size-guard header still state the 33 kB budget; core budget is non-binding
- **Severity:** medium
- **Location:** `docs/REQUIREMENTS.md:276`; `scripts/size-guard.mjs:5`, `:49-55`
- **Description:** NFR-3 opens with "target ≤ 33 kB min+gzip", and the size-guard header says the core is budgeted at "≤ 33 kB". The enforced core budget is actually 100 kB. A measured run gives: core 40.6 kB / 100 kB, IIFE 44.2 kB / 45 kB, element 47.0 kB / 48 kB. The IIFE contains the core plus adapters and locales, so the IIFE ceiling hits first and the 100 kB core ceiling can never fail on its own. The "core without adapters" check has stopped guarding anything, and the headline number contradicts the recorded decisions. The IIFE and element bundles are at about 98% of budget, so the next feature will force another budget raise.
- **Recommendation:** Update the NFR-3 headline and the size-guard header to the enforced numbers. Tighten the core budget so it bites again (for example measured + ~10%), or remove it and state that the IIFE is the binding gate. Plan headroom work before the next UI feature.

#### BP-05 — BUILD-SYNC.md carries a stale release version copy
- **Severity:** low
- **Location:** `docs/BUILD-SYNC.md:100`
- **Description:** The doc says "`package.json` and `extension/manifest.json` carry the release version (currently `0.10.3`)". Both are `0.11.6`, and so is `CHANGELOG.md:1`. The project rule is that version lives only in `package.json` / `extension/manifest.json`, with no copies elsewhere. (The `0.10.3` pins in `docs/DOCKER.md:235-260` are intentional and explained there, so they are not a finding.)
- **Recommendation:** Remove the hard-coded version from the sentence. Do not swap it for the current number.

#### BP-06 — Headless CLI bundles the full UI layer through the `src/index` facade
- **Severity:** low
- **Location:** `src/cli/bin.ts:52`, `:685-699`
- **Description:** The CLI imports `createBlueprint` from `../index`, which pulls in `src/ui/layer.ts`, the panel and the composer. The only consumer is the `demo` subcommand. `dist/cli.js` (453 kB) contains `createLayer`, `createPanel` and `createComposer`. This goes against the architecture rule that the CLI is a headless consumer of `src/data`/`src/core` (`docs/ARCHITECTURE.md:25-28`), and it makes the CLI bundle larger and more coupled than it needs to be.
- **Recommendation:** Implement `demo` with `createStore` + `createMemoryAdapter` + `toMarkdown`, which the CLI already imports. Import `VERSION` from `../version`.

#### BP-07 — Review-priority and string-compare logic duplicated between `data/canonical` and `data/order`
- **Severity:** low
- **Location:** `src/data/canonical.ts:22-37` vs `src/data/order.ts:21-38`
- **Description:** `priorityOf` and `compareStrings` in `canonical.ts` re-implement `reviewPriority` and `compareText` from `order.ts`, which calls itself "the single implementation every surface shares". `order.ts:9-11` explains why the two *orderings* differ (canonical sorts by route first). The priority class itself is identical, though, and if the FR-4.6 classes change, one copy can drift silently. That conflicts with the FR-15.3 single-implementation goal.
- **Recommendation:** Have `canonical.ts` import `reviewPriority` (and a shared code-unit comparator) from `order.ts`, and keep only the route-first composition local.

#### BP-08 — `bluepencil notes` prints non-canonical JSON
- **Severity:** low
- **Location:** `src/cli/bin.ts:526-529`
- **Description:** `notes` writes `JSON.stringify(set.notes, null, 2)`, so key and list order follow the input file. Every other CLI path that emits notes uses the canonical form (`canonicalBundle`, `bin.ts:626`), and so do the hub and MCP (`canonicalNote`). The same note set can print differently depending on where it came from, which goes against the NFR-17 determinism goal for agent-facing output.
- **Recommendation:** Print `serializeCanonical(set.notes)` (from `src/data/canonical.ts`), optionally after `sortForReview`.

#### BP-09 — `Blueprint.layer` / `Blueprint.store` lazy proxies bypass the gate and resurrect after `destroy()`
- **Severity:** low (judgment)
- **Location:** `src/index.ts:84-95`, `:191-192`
- **Description:** `blueprint.layer` is a proxy over `ensureLayer()`, so `blueprint.layer.enable()` mounts the layer without evaluating the host `enabled` gate. FR-1.1 requires fail-closed behaviour on every enable. After `destroy()`, any access to `blueprint.store` or `blueprint.layer` silently builds a new store or layer, even though the header says the instance "can be discarded". This is a judgment call: the handle is a deliberate escape hatch. Still, the contract is not stated, and a host can break FR-1.1 by accident.
- **Recommendation:** Document that `layer.enable()` skips the gate, or route it through the facade's `enable()`. After `destroy()`, have the proxies throw or return inert handles.

#### BP-10 — "Public types only in `src/core/model.ts`" convention does not match the public API
- **Severity:** low (judgment)
- **Location:** `src/index.ts:256-291`; `CLAUDE.md` (Code-Konventionen)
- **Description:** The public entry re-exports types defined outside `model.ts`: `Adapter`/`AdapterLike`/`AdapterName` (`core/adapter`), `LayerHandle`/`LayerOptions` (`ui/layer`), `Store`/`StoreOptions` (`core/store`) and `HttpTransport` (`adapters/transport`). The convention as written is not followed. Either the rule or the code is wrong.
- **Recommendation:** Narrow the convention to "public *data-model* types live in `model.ts`", which matches practice, or move the interface types there.

### Checked, no finding
- **NFR-4 (no runtime deps):** `package.json` `dependencies` is `{}`. No third-party imports in `src/`, `server/` or `extension/src/` (only relative and `node:` specifiers). `esbuild`/`jsdom` appear only in build and smoke scripts, as devDependencies.
- **enable()/disable() idempotency (FR-12.1/12.2, NFR-15):** `src/ui/layer.ts:2094-2189` guards both with `enabled` early returns. `disable()` tears down listeners (`unlistenAll`), the store subscription, the ResizeObserver, panel, composer, legend, settings, the presentation ticker/BroadcastChannel, the root node and ref-counted styles. The facade's `destroy()` (`src/index.ts:228-235`) is idempotent. Cycles are covered by the `tests/unit/ui.test.ts` and `tests/e2e/vanilla.e2e.mjs` NFR-15 checks.
- **Canonical serialisation (NFR-17):** `src/data/canonical.ts` covers every `Note`, `Anchor`, `CapturedContext`, `Message`, `Session` and `Bundle` field in `src/core/model.ts`. It uses a fixed key order, code-unit comparisons (no `localeCompare`), a trailing newline, and a dependency-free FNV-1a hash.
- **Single headless implementation (FR-15.3):** hub (`server/handler.ts`, `server/hub.ts`), MCP (`src/mcp/backend.ts`), federation (`src/federation/aggregate.ts`) and the CLI all import validation, merge, migration, bundle and canonical logic from `src/data`, and filtering/patching from `src/core/adapter.ts`. `extension/src` contains no note logic. `src/data` has no DOM or UI imports. The only duplication found is BP-07.
- **Version SSOT:** `package.json`, `extension/manifest.json` and the `CHANGELOG.md` head all read `0.11.6`. `src/version.ts` injects the version at build time and has no hard-coded copy. The one stale copy is BP-05.
- **REQUIREMENTS vs `spec/` staleness:** the FR/NFR IDs in `docs/REQUIREMENTS.md` and `spec/` match one-to-one. CI regenerates `spec/` and fails on drift (`.github/workflows/ci.yml`, job `spec`). The remaining gap is in the source table itself (BP-01).
- **Directory structure in CLAUDE.md:** matches the real `src/`, `server/`, `extension/`, `examples/` and `tests/` trees (only the minor files `src/argv.ts`, `src/version.ts`, `src/federation/{errors,ids}.ts` are not listed).
- **Default exports:** none in `src/`, `server/`, `extension/src/`, `scripts/` or `tests/`.
- **File naming:** all source and script files are kebab-case. No snake_case or camelCase file names.
- **Bundle size gate in CI:** `npm run size` runs in `ci.yml` (step "Bundle size guard") and in the release `verify`. All four budgets currently pass (headroom concern: BP-04).

---

## 2. Security — Hub, MCP door, credentials, CORS

Scope: `server/` (handler, hub glue, credentials, tokens, mint, admin surface, CORS/preflight, journal route, MCP door, federator), `src/mcp/` (tools, protocol, stdio, options), `src/federation/` (net-policy, client, registry, aggregate). The two docker credential lines are included because they echo a credential. No secret values appear in this section.

### Findings

#### SEC-01 — A hub bound off loopback with no credential starts silently
- **Severity:** medium
- **Location:** `server/hub.ts:1367` (`--host` parse), `:1441-1471` (credential parse), `:1252-1259` (start banner); `docs/REQUIREMENTS.md:106` (FR-6.7)
- **Description:** FR-6.7 is titled "Hub authentication, required as soon as it leaves loopback". `parseHubArgs` accepts `--host 0.0.0.0` (or any LAN address) with no `--auth-secret`, `--token-key` or `--admin-secret`, and `startHub` serves read/write notes, `/bundle` and `POST /mcp` to every reachable peer. The only signal is the informational banner text "reachable from the network", and `--quiet` suppresses even that. The docker entrypoint always generates a secret, so containers are safe. A bare `bluepencil server --host 0.0.0.0` is not. The FR-6.7 acceptance text ("a hub with no credential configured behaves exactly as before") contradicts its own title, so this is a requirement gap as much as a code gap.
- **Recommendation:** Refuse a non-loopback bind without a client credential unless the operator passes an explicit opt-out (for example `--allow-unauthenticated`). At minimum, print a warning that `--quiet` cannot suppress. Align the FR-6.7 title and acceptance criteria.

#### SEC-02 — No Host/Origin check: an unauthenticated loopback hub can be reached by DNS rebinding
- **Severity:** medium
- **Location:** `server/hub.ts:638-725` (`respond`), `server/handler.ts:1293` (`routeRequest`); `grep` finds no `headers.host` check under `server/` or `src/mcp/`
- **Description:** The default deployment is a loopback hub with no credential. In that setup the only protection is that browsers block cross-origin reads (no `--cors`) and need a preflight for `application/json` writes. Neither the router nor the glue checks the `Host` header. A page the user visits can rebind its own hostname to `127.0.0.1`. From then on it is same-origin with the hub, and it can `GET /bundle` and `POST/PATCH /notes`, `/notes/bulk-delete` and `/mcp` without any CORS involvement. A configured credential defeats this, because the attacker page cannot know it.
- **Recommendation:** When the hub is bound to loopback, reject any request whose `Host` is not a loopback name or address (`localhost`, `127.0.0.1`, `[::1]`, plus configured aliases), with 421 or 403. Apply the same rule to the MCP door, as the MCP streamable-HTTP guidance requires.

#### SEC-03 — Admin secret on the notes routes bypasses the admin brute-force throttle
- **Severity:** medium (judgment: impact limited by the 16-character floor)
- **Location:** `server/handler.ts:1236-1242` (admin secret accepted via `x-bluepencil-auth` when `allowAdminSecret`), `:1388`; compare `server/admin.ts:369-385` (throttle applied only on `/admin/*`)
- **Description:** The admin secret mints and revokes every other credential. `admin.ts` protects it with `AdminThrottle` (10 failures per 5 minutes per peer, then 429). `authorize()` also accepts the same secret on every `/notes…` request, and that path never consults the throttle and never records a failure. An attacker can make unlimited online guesses against the admin secret through `/notes`. A hit confirms the secret, which then unlocks `/admin/devices` (token minting). The control `admin.ts` documents ("failed secret checks are throttled") does not cover every path that checks the secret.
- **Recommendation:** Run the admin-secret comparison in `authorize()` through the same `adminThrottle` (`allow` before, `failure` and `success` after). Or require the admin page to present the secret only on `/admin/*`, and proxy note edits through an admin route.

#### SEC-04 — No minimum strength for `--token-key`: a weak key allows offline token forgery
- **Severity:** medium
- **Location:** `server/hub.ts:1467-1471`; `server/tokens.ts:118-121`; `server/mint-cli.ts:85-92`
- **Description:** The HMAC signing key only has to be non-empty. Every issued token contains the full signed payload (`header.body.signature`). Anyone who holds a single token, including a read-only device token or one leaked in logs or shell history, can brute-force a short or dictionary key offline with no rate limit. With the key they can mint `write`-scoped tokens with any `jti` and any expiry, and revocation cannot stop that until the key is rotated. `--admin-secret` already has a 16-character floor (`hub.ts:1458`). The stronger, offline-attackable credential has none.
- **Recommendation:** Require a minimum key length (for example ≥ 32 characters) on both the hub and the `token` CLI. Document generating the key from a CSPRNG (`openssl rand -hex 32`).

#### SEC-05 — Federation client reads peer response bodies without a size cap or deadline
- **Severity:** medium
- **Location:** `src/federation/client.ts:798` (timeout covers `fetch` only), `:813-815` (`clearTimeout` in `finally`), `:650-653` (`response.text()`), `:675-690`
- **Description:** `#send` races `fetch` against the abort timer and clears the timer as soon as response headers arrive. `#bodyText` then calls `response.text()` with no byte limit and no deadline. A registry peer that is slow, hostile or compromised can stream an unbounded body, or trickle it forever. The hub or federator then buffers it all in memory or hangs that aggregate call. The fan-out multiplies this by `--concurrency` (up to 16). The hub's own inbound limit (`MAX_BODY_BYTES`) has no outbound counterpart.
- **Recommendation:** Keep the abort timer armed until the body has been read, and read through `response.body` with a byte cap (for example the hub's 8 MiB, or something smaller for `/config`). Abort with `invalid_response` when the cap is exceeded.

#### SEC-06 — `--cors` with no value silently means `*`
- **Severity:** low
- **Location:** `server/hub.ts:1435-1437`; `server/cors.ts:85-108`
- **Description:** A bare `--cors` (or `--cors=` with a missing value) resolves to `access-control-allow-origin: *`. On a hub with no credential, that lets every website the user visits read and write all notes cross-origin, with the preflight approved. Auth is header-based and `Access-Control-Allow-Credentials` is never sent, so a configured credential still protects the hub. The risk is the default combination, and nothing warns about it.
- **Recommendation:** Require an explicit origin value (`--cors '*'` spelled out), or refuse `*` when no client credential is configured. Log a startup warning for `*`.

#### SEC-07 — Client shared secret has no length floor and no attempt throttle
- **Severity:** low
- **Location:** `server/hub.ts:1441-1445`; `server/handler.ts:1244-1255`
- **Description:** `--auth-secret` only has to be non-empty, and wrong `x-bluepencil-auth` guesses are never counted. The docker path generates 32 random bytes, so this only affects hand-configured hubs. There, a short secret can be guessed online at network speed. The constant-time compare is correct, so the weakness is the guess rate, not timing.
- **Recommendation:** Apply the admin floor (≥ 16 characters) to `--auth-secret`, and reuse the `AdminThrottle` mechanism for client-credential failures (per peer, separate budget).

#### SEC-08 — Unauthenticated requests trigger body buffering and a synchronous store reload
- **Severity:** low
- **Location:** `server/hub.ts:662-673` (body read before any auth), `:680` (`loadNotes` on every request), `:483-509` (`readBody`)
- **Description:** The glue reads up to 8 MiB of body and re-parses the whole store file synchronously before `handleRequest`/`authorize` runs. Every unauthenticated request, including ones that will be answered 401 or 404, costs a full store read and parse on the event loop. A body over the limit without `content-length` is drained to the end rather than cut off (the socket is never destroyed). There is no rate limiting anywhere on the hub. A cheap request flood therefore turns into CPU and disk load proportional to the store size.
- **Recommendation:** Run the credential check, which is header-only, before `readBody` and `loadNotes`. Destroy the request once `size > limit`. Consider a coarse per-peer request budget.

#### SEC-09 — 500 answers echo raw exception messages (paths, internals)
- **Severity:** low
- **Location:** `server/handler.ts:658` (`internal_error` with `errorText`), `:680-685` (`store_write_failed` with the fs error), `server/hub.ts:1217` (glue 500); `server/mcp.ts:79-82` with `:239`
- **Description:** Unexpected errors are returned verbatim in `error.message`. Node fs errors include absolute store paths. Reproducible example: an authenticated `POST /mcp` with the JSON body `null` makes `needsWrite` dereference `null.method`. That throws outside any try block, and the glue answers 500 with the raw `TypeError` text. The impact is information disclosure only, to callers who already passed the gate (or to anyone on a hub with no credential).
- **Recommendation:** Return a generic message for 500s and log the detail to stderr. In `needsWrite`/`parseRpcPayload`, reject anything that is not a JSON object with a JSON-RPC `-32600`.

#### SEC-10 — Public journal also exposes the store path and git author identity
- **Severity:** low
- **Location:** `server/hub.ts:604-635` (`journalResponse`, answered before any auth at `:651`); `server/journal.ts:315`, `:481` (`location`), `:65`/`:369` (`author`)
- **Description:** FR-6.7 documents the unauthenticated `GET {base}/journal` as a deliberate risk for `noteId`/`actor`/`summary`. The payload's `journal` status object also carries `location`, which is the absolute journal file path or repository path, and for the git backend `author`, which is `Name <email>`. FR-6.7 does not mention either field, and both are reconnaissance data on an otherwise authenticated hub.
- **Recommendation:** Omit `location` and `author` from the unauthenticated answer (keep them on `/admin/status`), or put the journal behind `authorize()` when a credential is configured.

#### SEC-11 — Federation SSRF gate: re-resolution window and IP classification gaps
- **Severity:** low
- **Location:** `src/federation/client.ts:819-835` (`#checkBase`), `:798` (`fetch(url)` re-resolves); `src/federation/net-policy.ts:214-241` (`embeddedIpv4FromGroups`), `:271-285` (`classifyIpv4`)
- **Description:** `#checkBase` resolves the host and validates the addresses, then `fetch` resolves the name again on its own. A registry hostname with a TTL-0 record can therefore answer the check with a public address and the connect with a private or link-local one. The comment calls this a "DNS-rebinding gate", which overstates what it does. Registry entries are operator-controlled, which limits exposure. On classification: `2002::/16` (6to4, embeds an IPv4) is not unwrapped, so `2002:a9fe:a9fe::` classifies as `public` while embedding the metadata address 169.254.169.254. `198.18.0.0/15`, `240.0.0.0/4` and `255.255.255.255` also classify as `public`.
- **Recommendation:** Pin the connection to a validated address (a custom `lookup` on an `http.Agent`/undici dispatcher that returns only the checked addresses). Unwrap 6to4. Classify the reserved IPv4 ranges as non-public. Reword the comment until pinning exists.

#### SEC-12 — Docker entrypoint prints a generated shared secret to stdout (container logs)
- **Severity:** low
- **Location:** `docker/entrypoint.sh:92`
- **Description:** On first start, the generated client secret is echoed in full ("shown once — copy it now"). Container stdout goes to `docker logs` and any log shipper, so the value stays as long as the logs do, and anyone with log access can read it. The file copy (`/data/.bluepencil-auth`, mode 0600) already gives the operator a retrieval path.
- **Recommendation:** Print only the file path and a retrieval command (`docker exec … cat /data/.bluepencil-auth`), or make the echo opt-in.

### Checked, no finding
- **Constant-time comparison:** the client secret uses an XOR-accumulate loop with a length early-out (`server/handler.ts:457-465`), and the admin secret uses an XOR loop over the max length (`server/admin.ts:163-170`). The token signature uses `crypto.timingSafeEqual` after a length check (`server/tokens.ts:105-108`). Only lengths leak, which the comments acknowledge.
- **Token signing and verification (`server/tokens.ts`):** HMAC-SHA256. The signature is verified before the body is parsed. The closed scope vocabulary refuses an unknown required scope. Revocation, expiry and scope are enforced on every call, and `write ⇒ read` is intended. A token that fails verification is refused outright, never retried as a secret (`handler.ts:1215-1233`). `jti` comes from `randomUUID`. Admin-minted TTLs are capped at 365 days (`admin.ts:58`).
- **Gate placement:** `authorize()` runs before the method table and every note route (`handler.ts:1387-1392`). Only the preflight, `/config` and `/health` sit in front of it, and their payloads carry no note data and no secret value (`configResponse` reports the credential *kind* only, `handler.ts:583-612`). `/admin/status` names credential kinds, never values (`admin.ts:246-279`). The MCP door authenticates for `read` first and for `write` when a write tool is called (`server/mcp.ts:233-244`), and it never accepts the admin secret.
- **CORS:** no CORS headers unless `--cors` is given. `Access-Control-Allow-Credentials` is never sent, so `*` cannot be combined with ambient credentials. `vary: Origin` is set for specific origins. Preflights answer only for known paths, with each door's own method list (`server/cors.ts`, `handler.ts:1314-1321`).
- **Request body limit:** 8 MiB, checked on both `content-length` and streamed size, answered with 413 (`server/hub.ts:97-98`, `:483-509`). The notes routes require `application/json` (415 otherwise), which also blocks simple-form CSRF (`handler.ts:702-724`).
- **JSON parse errors:** notes routes return 400 `invalid_json`. Admin routes fall back to `{}` and the validators then refuse it. MCP returns JSON-RPC `-32700` (the one exception is SEC-09).
- **Input validation:** create, patch and message go through `validateNote` from `src/data/schema` plus an unknown-field refusal (`handler.ts:907`, `:1074`, `:1096`, `:1115`). Admin device names, `jti`s and TTLs are bounded (`admin.ts:53-58`).
- **Path traversal:** static serving resolves under `--root` and checks `isInside` for every candidate, including the `index.html` fallback (`server/hub.ts:418-440`). The admin router normalises `..` through `new URL` before matching (`admin.ts:156-160`). MCP `import_bundle` takes bundle content, never a file path. Store, registry and revocation paths are operator flags only.
- **Admin surface:** off unless `--admin-secret` is set (≥ 16 characters, `hub.ts:1451-1461`), and it 404s rather than advertising itself. The page is hardened (`x-frame-options: DENY`, `frame-ancestors 'none'`, no-store). It renders without `innerHTML`, and the secret goes to `sessionStorage` only on opt-in. The throttle map is bounded at 4096 entries (`hub.ts:1015-1076`). The bypass is SEC-03.
- **Secret handling:** the token CLI reads the key from env or `--key`, never a positional argument, and prints the token alone to stdout (`server/mint-cli.ts`). The hub keeps only `jti`s in `devices.json`, never tokens (`admin.ts:487-496`). Federation registry credentials are env-var references only. Literal secret fields are refused with `literal_secret`, and `credential` is non-enumerable (`src/federation/registry.ts:8`, `:143-153`, `:216-294`). Docker writes the generated secret with `umask 077` plus `chmod 600` (`docker/entrypoint.sh:60-72`). No credential value is written to stderr by the hub, journal or MCP diagnostics.
- **MCP write gating:** stdio `bluepencil mcp` is fail-closed. `--allow-write` is parsed strictly, and only `BLUEPENCIL_ALLOW_WRITE=1` enables writes (`src/mcp/options.ts`). All five write tools call `requireWrite` (`src/mcp/tools.ts:941`, `:1008`, `:1068`, `:1106`, `:1165`). Federation enforces its two locks itself, and `--read-only` wins (`src/federation/backend.ts:166-179`, `:328-354`). The hub's MCP door is writable unless `--read-only`, which matches the hub's notes API (one gate, one policy). This is a deliberate asymmetry with stdio, not a bypass. `exit` is refused over HTTP (`src/mcp/protocol.ts:206-212`).
- **Federation transport:** schemes are limited to http/https. Userinfo, query and fragment are refused, metadata hosts and addresses are blocked, link-local, unspecified and multicast are always blocked, and http is loopback-only unless `--allow-insecure`. The check runs before every request, redirects are refused (`redirect: "manual"`), and DNS lookups have a timeout (`src/federation/net-policy.ts`, `client.ts:11-17`, `:788`). The gaps are SEC-05 and SEC-11.
- **Journal git backend:** `spawnSync` gets an argument array without a shell (`server/journal.ts:130`), so actor and summary text cannot inject commands.
- **Federator:** stdio only, no listening socket (`server/federator.ts:3-7`). Writes default to off (`:221-229`).

---

## 3. Security — Extension, client-side, network

Scope: `extension/` (manifest, service worker, isolated-world bridge, page relay, storage relay, hub fetch relay, options page, handoff), `src/ui`, `src/core` (capture, anchor, markdown export), `src/element`, `src/embed` (attach loader, attribute parsing, integrity), `src/adapters` (http, chrome-storage, local-storage, transport), presentation `BroadcastChannel`, voice dictation. Method: source reading plus `grep` for HTML/eval sinks, URL sinks and network egress. The markdown escaping claim (SEC-17) was checked by running the `inline()` regex chain from `markdown.ts:200-207` on test payloads. No secret values appear in this section.

### Findings

#### SEC-13 — Any script on any annotated page can read and overwrite notes captured on every other site
- **Severity:** high (judgment: cross-origin confidentiality and integrity loss, needs one prior activation per tab)
- **Location:** `extension/src/storage-relay.ts:80-84` (unrestricted `get`), `:44` (`PAGE_WRITABLE_KEY` accepts `bluepencil:default:v1`), `:85-106`; `extension/src/bridge.ts:112-116`, `:148-155`; `src/adapters/chrome-storage.ts:26-30` ("shared across all sites for one instance"). The extension never sets an instance, so every site uses the one key.
- **Description:** In the default `chromeStorage` mode the extension keeps the notes of every site in a single `chrome.storage.local` blob, `bluepencil:default:v1`. The bridge relays storage calls for any page script that posts `{source:"bluepencil-page", kind:"storage"}` on its own window (`event.source === window` is the only check). The relay allows `get` for any key, and allows `set`/`remove` for the shared blob. Once the user has activated the layer on a tab, every script on that page can do three things. Third-party scripts count too: ads, analytics, a compromised CDN. First, it can read the notes from every other site. Those notes include page path and query (`route`), selected quotes (FR-1.5), anchor text and comments, for example from an internal admin tool. Second, it can rewrite those notes. Third, it can delete the whole blob. `docs/EXTENSION.md:235-239` accepts that the annotated page can read the store, but it treats the store as that page's own. In fact the store holds every origin's notes.
- **Recommendation:** Scope the blob per origin in the extension. The bridge knows `location.origin` from its isolated world, so it should derive the key from it (for example `bluepencil:<origin-hash>:v1`) and ignore the key the page sends. Restrict `get` to that same key. Keep a cross-site view only on extension pages (options or a dedicated review page), which do not run inside the page.

#### SEC-14 — The hub credential is handed to the page's own world in three readable places
- **Severity:** medium (judgment: documented as accepted in `docs/EXTENSION.md:235-239`, but the attribute path also leaks to third parties)
- **Location:** `extension/src/handoff.ts:71` (`token` attribute), `extension/src/bootstrap.ts:157-158` (written onto `<bluepencil-notes>` in the page DOM); `extension/src/sw.ts:60` (whole settings object, token included, on `window.__bluepencilConfig__`); `extension/src/storage-relay.ts:80-84` (`get("bluepencil:settings")` allowed)
- **Description:** When the store is a hub, the shared secret or signed token is readable by any script on the annotated page in three ways: as a DOM attribute, as a window global, and through the storage relay. The DOM attribute is the worst of the three. Session-replay and DOM-snapshot tools (FullStory, Hotjar, Sentry Replay and others) serialise attributes and ship them to their vendors, so the credential can leave the browser without any malicious script involved. The credential grants read/write on all hub notes, plus `POST /mcp` (Section 2). With a shared secret it also cannot be revoked per device. The docs argue that "a page that must not learn the token cannot be annotated". That holds for the page's own scripts. It does not cover the attribute exposure, or the fact that a shared secret then reaches every site the user annotates.
- **Recommendation:** Keep the credential out of the page entirely. The service worker already performs every hub request (`hub-fetch.ts`), so it can add the auth header itself from `bluepencil:settings`. The page relay then sends no `authorization`/`x-bluepencil-auth`, and the worker strips them from the allowlist. Stop writing `token*` attributes and drop `token` from `__bluepencilConfig__`. Refuse page `get` for `bluepencil:settings`. Until then, warn in the options page that a shared secret reaches every annotated site, and recommend per-device signed tokens.

#### SEC-15 — A page can mount or toggle the layer on a different tab (the active one) without a user gesture
- **Severity:** medium
- **Location:** `extension/src/bridge.ts:160-178` (forwards `request-mount`/`toggle` with no tab binding); `extension/src/sw.ts:300-331` (`chrome.tabs.query({active:true,currentWindow:true})` at `:307`, ignoring `sender.tab`); `extension/manifest.json` `host_permissions: ["http://*/*","https://*/*"]`
- **Description:** The worker answers a page's `bluepencil:mount`/`bluepencil:toggle` by acting on the active tab of the focused window, not on the tab that sent the message. A script in a background tab where the bridge was injected earlier (tab A) can post `{source:"bluepencil-page", kind:"request-mount", force:true}`. The worker then injects the bridge, the bootstrap and the configured settings into whatever tab the user is looking at (tab B, any origin). The broad `host_permissions` let `executeScript` succeed there without `activeTab`. The result is that the layer runs on a site the user never chose to annotate, and SEC-13 and SEC-14 then apply to that site. `toggle` lets tab A switch tab B's layer on or off in the same way. The code comments describe this per-tab model as "access is granted per tab", which this path does not honour.
- **Recommendation:** For messages from a content script (`sender.tab` present), act only on `sender.tab.id`. Keep the active-tab lookup for the toolbar action and the keyboard command, which arrive through `chrome.action`/`chrome.commands`, not `runtime.onMessage` from a tab.

#### SEC-16 — `data-integrity="true"` fails open and does not verify the bytes that run
- **Severity:** medium (judgment: the docs call it SRI, so hosts may rely on it)
- **Location:** `src/embed/attach.ts:259-261` (silent return when the manifest has no `sha256`), `:285-288` (verify, then a separate `importModule`); `src/embed/version.ts:147` (hash fetch with `cache: "no-store"`), `:86-92` (`absoluteUrl` accepts any origin or scheme for `manifest.element`); `docs/EMBED.md:307` ("Subresource Integrity (SRI)")
- **Description:** There are three gaps. (1) If a host opts in with `data-integrity="true"` and the manifest omits `sha256`, `assertIntegrity` returns without checking and without reporting, so the module loads unverified. (2) The digest covers a separate download made with `no-store`. The module that actually runs is fetched again by `import()` or a `<script type=module>`, so a server or CDN can serve different bytes to the second request (TOCTOU), and the check proves nothing about the code that executes. (3) The expected digest comes from the manifest, which is fetched from the same mutable location. Compromising the manifest therefore defeats the check, and `manifest.element` may point at any origin. Unlike browser SRI, the hash is not pinned by the host page. The same path runs on every `watch` swap.
- **Recommendation:** Treat a missing `sha256` as an error when integrity is requested. Execute the verified bytes: import a `Blob` URL made from the hashed buffer (CSP permitting), or use a `<script type=module integrity="sha256-…">` so the browser enforces it. Let hosts pin the digest on the loader tag itself (`data-sha256`) for a real trust anchor. Optionally require `manifest.element` to be same-origin with the manifest. Stop calling the current mechanism SRI in `EMBED.md`.

#### SEC-17 — Markdown export leaves link and image syntax live in inline fields
- **Severity:** low
- **Location:** `src/core/export/markdown.ts:199-207` (`inline()`), used for author `:298`, message author `:394`, timing label `:312`, style values `:362`, export title `:408`/`:444`
- **Description:** `inline()` escapes HTML, backticks, pipes, emphasis and block markers, but it leaves `[`, `]`, `(`, `)` and `!` unchanged. Verified: the author `![x](https://e.example/leak?a=1)` comes out unchanged, and so does `[click](javascript:alert(1))`. The export is written for agents, pull requests and issue trackers. When it is rendered there, a note author (or an agent writing through MCP) can embed a remote image that fetches when the export is viewed, which acts as a tracking or exfiltration beacon, or a disguised link. Note bodies are safe, because they go into grown fences.
- **Recommendation:** Also escape `[`, `]` and `!` (or `(`) in `inline()`, and add the image/link payloads to the existing rendered-markdown test.

#### SEC-18 — The extension sends the hub credential over plaintext http to any host
- **Severity:** low
- **Location:** `extension/src/connection.ts:331`; `extension/src/hub-fetch.ts:144-153` (`baseOf`), `:178-180`; `extension/src/options.ts:172-192` (save only checks that the URL is not empty)
- **Description:** Every endpoint check accepts `http:` for any host. A LAN or remote hub configured as `http://hub.example:8787/...` gets its shared secret or bearer token on every request in cleartext. On shared Wi-Fi it can be sniffed and replayed. The federation client already enforces "http only on loopback unless `--allow-insecure`" (Section 2, "Federation transport"). The extension, which carries the same credentials, does not.
- **Recommendation:** When `auth !== "none"`, accept `http:` only for loopback hosts. Refuse anything else at save time with a clear message, or require an explicit "allow insecure" checkbox.

#### SEC-19 — `route="url"` stores the full query string, including tokens that appear in URLs
- **Severity:** low (judgment)
- **Location:** `src/embed/attributes.ts:503` (`${location.pathname}${location.search}`); `src/element/index.ts:297-299`; `extension/src/handoff.ts:54` (the extension always sets `route: "url"`)
- **Description:** Every note records the page's query string verbatim. Query strings often carry secrets: password-reset and magic-link tokens, OAuth `code`/`state`, signed storage URLs, session ids in legacy apps. These values then live in the notes, sync to the hub, appear in Markdown/JSON exports and reach MCP agents. Combined with SEC-13 they are also readable cross-site. The fragment is excluded, which correctly avoids the OAuth implicit-flow `#access_token`.
- **Recommendation:** Store only the path by default, or strip known sensitive parameters (`token`, `code`, `state`, `sig`, `signature`, `key`, `X-Amz-*`, …). Let hosts opt into the full query string (for example `route="url-with-query"`). Document the choice.

#### SEC-20 — All-sites host permission and a persistent MAIN-world script on every page
- **Severity:** low (least privilege)
- **Location:** `extension/manifest.json` (`host_permissions: ["http://*/*","https://*/*"]`); `extension/src/sw.ts:110-126` (`registerContentScripts` for all http(s) URLs, `world: "MAIN"`, `runAt: "document_start"`, `persistAcrossSessions: true`); `extension/src/bootstrap.ts:102-106` (`window.__bluepencilTryMount` set on every page)
- **Description:** The code comments justify bridge injection with "`activeTab` exists to avoid" running everywhere. However, after the first activation the bootstrap is registered for every http(s) document permanently. It runs in the page's world on every site the user visits and publishes `__bluepencilTryMount`, which any site can probe to fingerprint the extension. The all-sites host permission is also what makes SEC-15 work without `activeTab`, and it shows up as a broad install-time warning in the Web Store. It is needed only for the user-configured hub origin and for the hosts the user actually annotates.
- **Recommendation:** Move to `optional_host_permissions`. Request the hub origin when the endpoint is saved, and rely on `activeTab` plus per-click `executeScript` for pages. If the registered script must stay, limit it to origins the user has activated, and do not expose a global until a config is present.

#### SEC-21 — Attribute-driven global function lookup acts as a script gadget
- **Severity:** low (judgment: needs markup injection on the host page)
- **Location:** `src/embed/attributes.ts:117-133` (`resolveGlobalPath`), callers `:172` (`headers-from`), `:244`, `:432` (`voice-engine`), `:482` (`route-from`), `:518-533` (`gate`)
- **Description:** Several attributes on `<bluepencil-notes>` (and `data-*` on the loader) name a dotted path into `globalThis`, and the element calls whatever function it finds there. On a host with an HTML-injection flaw that a script-blocking CSP otherwise mitigates, an attacker who can inject markup but no script can still make the element call an existing global function. Examples: `headers-from="…"` can attach the return value of any global function as request headers to the hub, and `gate`/`route-from` turn arbitrary globals into a source of data. This is a known pattern for bypassing CSP with script gadgets.
- **Recommendation:** Document that these attributes execute host code and must never come from untrusted markup. Optionally, require the functions to be registered explicitly (for example `window.bluepencilHooks.<name>`) instead of resolving arbitrary paths.

### Checked, no finding
- **FR-9.3 text-only rendering:** no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, `DOMParser`, `createContextualFragment`, `srcdoc` or `on*` attribute writes in `src/` or `extension/src` (grep). The panel, composer, legend and presenter use `textContent`/`setAttribute` (`src/ui/panel.ts:9`). The only `href` assignment is a `blob:` download URL (`src/ui/layer.ts:1409-1416`).
- **Network egress (FR-9.4/NFR-7):** the only `fetch` paths are the host-configured HTTP adapter (`src/adapters/http.ts:132-144`), the attach loader's manifest, module and integrity fetches to host-chosen URLs, and the extension worker's validated relay. There is no `XMLHttpRequest`, `sendBeacon`, `WebSocket`, `EventSource` or `new Image` beacon in `src/`. The HTTP adapter uses the default `credentials` mode (same-origin cookies only) and encodes note ids in paths (`http.ts:247`).
- **Hub fetch relay (`extension/src/hub-fetch.ts`):** strict allowlists. The target must match the configured origin and base path, every `%` in the path is refused (which blocks encoded `/admin` and `..`), `{base}/admin` is denied, methods are limited to GET/POST/PATCH and headers to four names with CR/LF refused. Requests use `credentials: "omit"`, `no-store` and `no-referrer`. Redirects are refused, there is a 30 s timeout and a 1 MiB request / 8 MiB response cap (the response is measured after `text()`, which is acceptable for a user-configured hub). Error messages never echo URLs or header values. The worker reads settings per message, and a page cannot repoint the endpoint, because `bluepencil:settings` is not page-writable (`storage-relay.ts:44`).
- **postMessage hygiene:** every page-side and bridge listener requires `event.source === window` plus a `source` tag. Replies are posted to `window.location.origin` (`"*"` only for opaque `null` origins, still same window). The page relay resolves only messages that carry `reply`, so an echoed request cannot spoof an answer (`page-relay.ts:67-81`).
- **Manifest surface:** no `externally_connectable`, no `web_accessible_resources`, no declared `content_scripts`, and the extension-page CSP is `script-src 'self'; object-src 'self'`. `options.html` loads only external `self` scripts. The token field is `type="password"`, and the status texts use `textContent`.
- **Credential at rest:** stored in `chrome.storage.local` (profile-scoped, not synced). The options page validates the endpoint scheme and refuses userinfo, query and fragment (`connection.ts:322-336`, `hub-fetch.ts:144-153`). The issues are exposure to the page (SEC-14) and cleartext transport (SEC-18).
- **Presentation mode:** `BroadcastChannel` is same-origin by definition. The audience only consumes `{kind:"time", elapsed}` into `textContent` (`src/ui/present.ts:433-439`). The audience window is opened with `noopener` (`:191`).
- **Capture:** `captureContext` records the tag, classes, a fixed style subset, the box, the scheme and the viewport (`src/core/capture.ts:234-268`). It records no form values (password inputs included), no screenshots and no storage or cookies. The quote is only the user's explicit selection. The URL query is SEC-19.
- **Voice (FR-21):** opt-in per host, no audio stored, no core network call. Chromium's Web Speech API may send audio to a browser service. This is disclosed to integrators (`docs/EMBED.md:92`, `docs/INTEGRATION.md:282`, `:353`), and `voice-engine` allows an offline recogniser. End users get no in-UI notice, which is a product decision rather than a code defect.
- **Markdown bodies:** multi-line text uses a fence longer than any backtick run in the content (`markdown.ts:246-263`), and HTML is entity-escaped in inline fields. The remaining gap is SEC-17.

## 4. Security — Secrets, dependencies, Docker, CI

Scope: tracked files (including `examples/`, `docs/`, `docker/`, `tests/`, `.env*`), `.gitignore`/`.dockerignore`, `package.json` and `package-lock.json`, `Dockerfile`, `docker-compose.yml`, `examples/federation/docker-compose.yml`, `docker/entrypoint.sh` and `docker/bin/*`, `.github/workflows/*.yml`, `scripts/`, `.githooks/`, and the npm `files` field. Method: `git grep` for key/token/private-key patterns and hard-coded credential literals, `git log --all -G` over history for the same patterns, `npm run secret-scan` (OK, 2103 files), `npm audit --omit=dev` and `npm audit` (both run, 0 vulnerabilities), `npm outdated`, a license tally from the lockfile, and source reading. No secret values appear in this section.

### Findings

#### SEC-22 — GitHub Actions pinned to mutable tags; a third-party action receives the Web Store OAuth refresh token
- **Severity:** medium
- **Location:** `.github/workflows/chrome-webstore.yml:139`, `:148`, `:157` (`wdzeng/chrome-extension@v2` with `client-id`/`client-secret`/`refresh-token`); every other `uses:` in `ci.yml`, `release.yml`, `extension.yml`, `pages.yml` (`actions/*@v7`, `docker/*@v4`/`@v7`, `actions/attest-build-provenance@v4`)
- **Description:** No action is pinned to a commit SHA. A moved or compromised tag runs new code with whatever the job holds. The worst case is `wdzeng/chrome-extension`, a single-maintainer third-party action: it receives the Chrome Web Store client secret and refresh token, which are enough to publish any build to every installed user. `release.yml` jobs that hold `contents: write`, `actions: write`, `id-token: write` and `packages: write` also run tag-pinned actions (`docker/login-action`, `docker/build-push-action`).
- **Recommendation:** Pin every action to a full commit SHA (with the tag as a comment) and let Dependabot/Renovate bump them. For the Web Store leg, prefer a SHA-pinned action or a short script against the Web Store API so the refresh token never reaches third-party code.

#### SEC-23 — The npm tarball and the release `.tgz` ship all of `docs/`, including this unresolved security audit
- **Severity:** low
- **Location:** `package.json:77-79` (`"files": ["dist", "docs", …]`); no `.npmignore`; `docs/reviews/system-audit-2026-11-02.md`, `docs/plans/`, `docs/spikes/`, `docs/specs/`
- **Description:** `files` lists the whole `docs` directory. `npm pack` (run in `release.yml` "Collect the assets") therefore publishes internal plans, spikes and this audit, with exploit-level detail on findings that are still open, as a release asset with signed provenance. `scripts/pack-smoke.mjs` checks that required `dist/` files exist but does not limit what else is shipped.
- **Recommendation:** List the user-facing docs explicitly in `files` (or exclude `docs/reviews`, `docs/plans`, `docs/spikes`), and add a deny check to `pack-smoke.mjs` so internal paths fail the pack.

#### SEC-24 — Compose publishes plaintext HTTP on all host interfaces, from `:latest`, with no container hardening
- **Severity:** low
- **Location:** `docker-compose.yml:11` (`ghcr.io/popoboxxo/bluepencil:latest`), `:17` (`"${BLUEPENCIL_PORT:-8787}:8787"`, no host address); `docker/entrypoint.sh` (final `exec … --host 0.0.0.0`); no `read_only`, `cap_drop` or `security_opt: no-new-privileges` in either compose file
- **Description:** The default stack listens on every host interface over cleartext HTTP. The generated shared secret then travels in `x-bluepencil-auth` unencrypted on the LAN, the same exposure as SEC-18 on the server side. `:latest` means a `docker compose pull` silently changes the running version. The container runs as `node` (uid 1000, good) but keeps the default capability set and a writable root filesystem, although it only needs `/data`.
- **Recommendation:** Default the published port to `127.0.0.1:` and document how to widen it. Document a TLS-terminating reverse proxy for LAN or remote use. Default the image to a pinned version (the federation example already pins one). Add `read_only: true`, `tmpfs: /tmp`, `cap_drop: [ALL]` and `security_opt: [no-new-privileges:true]`. (Judgment: the binding and the tag are verifiable; how much hardening is enough is a judgment call.)

#### SEC-25 — Base image not pinned by digest
- **Severity:** low
- **Location:** `Dockerfile:23`, `:29` (`FROM node:22-alpine`)
- **Description:** Both stages use a floating tag. A release build is not reproducible, and the image that `release.yml` signs depends on whatever `node:22-alpine` pointed to on that day. Provenance attests the build, not the stability of the base.
- **Recommendation:** Pin `node:22-alpine@sha256:…` and let Dependabot (`package-ecosystem: docker`) bump it.

#### SEC-26 — Build context and root `.gitignore` do not exclude local secret files
- **Severity:** low
- **Location:** `.dockerignore` (whole file; no `.env*`, `.meta-config/secrets.local.yaml`, `.mcp.json`, `*.bluepencil.json`, `.claude/`); `Dockerfile:25` (`COPY . .`); `.gitignore` (no root `.env`/`.env.*` entry; only `examples/federation/.gitignore:3` covers `.env`)
- **Description:** `COPY . .` sends the whole checkout, including git-ignored local secret files (`.meta-config/secrets.local.yaml`, `.mcp.json`, local review stores), to the Docker daemon and into the build stage's layers and cache. The final image copies only the two bundles, so the published image is clean, but local or remote builders and their cache keep the files. The root `.gitignore` relies on the per-example `.gitignore`. A `.env` created at the repo root (the usual habit with Compose and the root `docker-compose.yml`) is not ignored and can be committed. `secret-scan` would catch known token formats, but not a random hex secret.
- **Recommendation:** Add `.env`, `.env.*` (with `!.env.example`) to the root `.gitignore`. Add the same plus the agent-meta local files, `*.bluepencil.json` and `.claude/` to `.dockerignore`, or switch the build stage to an explicit `COPY` list.

#### SEC-27 — CI workflow has no `permissions` block; release job restores the shared npm cache while holding write tokens
- **Severity:** low
- **Location:** `.github/workflows/ci.yml` (no `permissions:` key at workflow or job level); `.github/workflows/release.yml:59` (`cache: npm`) in the job with `contents: write`, `actions: write`, `id-token: write` (`:46-49`)
- **Description:** `ci.yml` runs on `push` and `pull_request` with the repository default token scope, which is `write-all` on older repositories and any repository where the setting was never changed. Fork PRs get a read-only token, but pushes to `feat/**`/`fix/**`/`chore/**` get the default. The release job restores the `setup-node` npm cache, which branch workflows also populate. Cache poisoning is a known path into a job that publishes signed artifacts, though `npm ci` integrity-checks against the lockfile, which limits it. (Judgment: the missing block is verifiable; how exploitable the cache is depends on the repository settings.)
- **Recommendation:** Add `permissions: contents: read` at the top of `ci.yml`. Drop `cache: npm` from the release job (it runs rarely, so the speed cost is negligible).

#### SEC-28 — `reqmd` binary is verified against a checksum from the same release
- **Severity:** info
- **Location:** `.github/workflows/ci.yml` "Install reqmd" step, `release.yml` "Spec is in sync" step (`curl … v0.2-alpha/reqmd-linux-amd64` and `SHA256SUMS.txt` from the same release, then `sudo mv`)
- **Description:** The checksum guards against corrupted downloads only. Anyone who can replace the release asset can replace `SHA256SUMS.txt` too. The binary then runs in the release job with write tokens.
- **Recommendation:** Hard-code the expected SHA-256 in the workflow.

### Checked, no finding

- **Secrets in tracked files and history:** no private keys, cloud keys, GitHub/npm/Slack tokens or high-entropy credential literals in tracked files. History hits are the detection regexes in `scripts/secret-scan.mjs` and `.claude/hooks/lib/hook_common.sh` only. `examples/federation/.env.example` holds names and ports, and its token lines are commented out and empty. `data-token="dev-review-token"` (`examples/attach/index.html:284`) and the `set-in-your-shell` values in `docs/FEDERATION.md:638` are visible placeholders. `npm run secret-scan` reports OK.
- **Dependencies:** `dependencies: {}` (NFR-4 holds). Five devDependencies, lockfile v3 present, `npm ci` used everywhere. `npm audit --omit=dev` and the full `npm audit` both report 0 vulnerabilities. `npm outdated` shows only a `@types/node` patch. No deprecated packages in the lockfile. Install scripts are limited to `esbuild` and the optional `fsevents`. Dev licenses: MIT, Apache-2.0, ISC, BSD, MPL-2.0, BlueOak, CC0, all compatible with an MIT package, and none ship in the bundles.
- **npm lifecycle scripts:** there is no `postinstall`. `prepare` runs `npm run build` for git-ref installs (standard behaviour, exercised by `smoke:install:git`).
- **Docker runtime:** multi-stage build, and the runtime has no `node_modules` and only the bundles plus the shell wrappers. Runs as `USER node`. `/data` is owned by `node`. `HEALTHCHECK` targets the unauthenticated `/health` on loopback. The generated secret is 32 bytes from `/dev/urandom`, written with `umask 077` and `chmod 600`, and the start refuses to continue if it cannot persist the secret. Printing it once is SEC-12. A secret supplied through `BLUEPENCIL_AUTH_SECRET` is visible to anyone with `docker inspect` rights, which is the documented trade-off and equals host-root access.
- **Entrypoint injection:** all variables are double-quoted, there is no `eval`, `"$@"` is passed through as an array, and the bin dispatch is an exact `case` match on two names. `docker/bin/*` are plain `exec node … "$@"`.
- **Federation compose example:** leaf secrets are required (`${VAR:?…}`), the aggregator is published on `127.0.0.1` only, it runs `--read-only` as a configured uid, and the registry is mounted read-only. Its default image `0.10.3` lags the current release, which is cosmetic because `.env` overrides it.
- **Workflows:** no `pull_request_target`, no `workflow_run`. User-controllable values (`inputs.tag`, release tag names) reach `run:` only through `env:` and are never interpolated into the script. `github.base_ref` in `ci.yml:126` is an existing target branch name and is not attacker-chosen. Top-level `contents: read` in `release.yml`, `extension.yml` and `chrome-webstore.yml`, with write scopes raised per job. Prereleases are kept out of the Web Store. `pages.yml` (`contents: write`) runs only on `main` pushes and dispatch, and it clears the checkout extraheader so only one credential is on the wire. Release assets get SHA-256 sums and build provenance. The image push gets provenance by digest.
- **`scripts/` and hooks:** every child process uses `execFileSync`/`spawn`/`spawnSync` with argument arrays and no `shell: true`. `scripts/hermes-mcp-wrapper.sh` quotes all expansions and builds args as a bash array. `.githooks/pre-push` runs only fixed npm scripts.

---

## 5. Code Quality

Scope: `src/`, `server/`, `extension/src/` (TypeScript only), `tests/unit/`, `tests/e2e/`, `tsconfig.json`, `tsconfig.types.json`, `extension/tsconfig.json`, `vitest.config.ts`. Method: grep counts for type escape hatches, empty/comment-only `catch` blocks, fire-and-forget promises, `JSON.parse` sites, `console.*`, TODO markers and test-timing patterns. Top-level function lengths were measured with an `awk` brace heuristic (the installed TypeScript 7 has no JS compiler API). Dead exports were found by a script that lists every `export function|const|class|type|interface` and searches all other files in `src/`, `server/`, `extension/`, `tests/`, `examples/` and `scripts/` for the name (`export *` barrels count as public). Modules were mapped to tests by import path. Read-only runs: `npm run typecheck` (exit 0), `npm run typecheck:ext` (exit 0), `npx vitest run` (63 files, 1444 tests, all passed, 43 s, one run).

### Findings

#### CQ-01 — Session derivation is implemented three times, once outside the data layer
- **Severity:** medium
- **Location:** `src/data/bundle.ts:89`, `src/data/migrate.ts:277`, `src/cli/bin.ts:298` (`deriveSessions`); `src/cli/bin.ts:169` vs. `server/atomic-write.ts:19` (`writeAtomic`)
- **Description:** The three `deriveSessions` bodies are identical. They take the earliest `createdAt` per `sessionRef`, with `label = ref`. Two copies are private to different `src/data` modules, and the CLI holds a third, with a comment saying it "mirrors" the private derivation. The project context requires exactly one implementation of note logic (FR-15.3). If the session rule changes in `bundle.ts`, legacy bare-array input through the CLI and migration through `migrate.ts` will produce different session headers for the same notes. `writeAtomic` is also duplicated: the CLI copy matches `server/atomic-write.ts`, even though the CLI already imports from `server/` (`mint-cli`, see `tsconfig.types.json`). (Verifiable: diff the cited bodies.)
- **Recommendation:** Export one `deriveSessions` from `src/data` (for example from `bundle.ts`) and use it in `migrate.ts` and `cli/bin.ts`. Have the CLI import `server/atomic-write.ts`, or move that helper to a shared location.

#### CQ-02 — Small helpers copied across modules; comparator copies affect canonical ordering
- **Severity:** low
- **Location:** `isRecord` ×8 (`src/core/adapter.ts:73` exports one; copies in `src/cli/bin.ts:285`, `src/embed/attributes.ts:80`, `src/federation/client.ts:124`, `src/federation/registry.ts:242`, `src/ui/voice.ts:59`, `extension/src/storage-relay.ts:51`, `extension/src/hub-fetch.ts:131`); `errorText` ×6 (`src/mcp/tools.ts:506` exported, `server/admin.ts:184`, `server/handler.ts:467`, `server/federator.ts:87`, `server/index.ts:33`, `server/hub.ts:458`); `oneLine` ×7 (`src/cli/instances.ts:82`, `src/cli/bin.ts:85`, `server/handler.ts:368`, `server/federator.ts:91`, `server/index.ts:29`, `server/journal.ts:138`, `server/hub.ts:462`); `isObject` ×3 (`src/data/migrate.ts:63`, `src/data/schema.ts:33`, `src/data/canonical.ts:180`); code-unit comparators ×5 (`src/data/order.ts:32`, `src/federation/aggregate.ts:413`, `src/core/export/markdown.ts:266`, `src/data/bundle.ts:46`, `src/data/canonical.ts:22`); the header literal `x-bluepencil-auth` is defined separately in `server/handler.ts:373`, `src/federation/client.ts:121`, `extension/src/handoff.ts:110`, `extension/src/hub-fetch.ts:55`
- **Description:** This extends BP-07 beyond `canonical`/`order`. Most copies are one-liners, and the duplication by itself is cosmetic. Two groups carry real risk. (1) The five comparators together define the stable order behind NFR-17 diffable output. If one copy changes (for example to `localeCompare`), bundle, canonical, Markdown and aggregate output stop agreeing, and no single test covers all five. (2) The auth header name is protocol surface and is spelled four times, so a rename on one side would fail at runtime only. The `extension/src` copies are justified: the extension imports nothing from `src/` and is bundled on its own. (Judgment: whether one-liner copies are worth consolidating is a judgment call; the comparator and header duplication is verifiable.)
- **Recommendation:** Export one `compareCodeUnits` from `src/data` and use it in all five places (this also resolves BP-07). Use the existing exported `isRecord` from `src/core/adapter.ts` in `src/`. Add a tiny `server/text.ts` for `errorText`/`oneLine`. Define the header names once in a protocol constants module shared by `src/` and `server/`. Leave the extension copies.

#### CQ-03 — `createLayer` is a 1,755-line closure; several other god functions
- **Severity:** medium
- **Location:** `src/ui/layer.ts:453` (`createLayer`, ~1,755 lines of a 2,212-line file, 69 nested functions, 27 mutable `let` bindings at closure level); `src/federation/backend.ts:163` (`createFederatedBackend`, ~712 lines); `src/ui/panel.ts:303` (`createPanel`, ~413); `src/mcp/tools.ts:816` (`dispatchTool`, ~392 lines, a 10-case `switch`); `server/hub.ts:1283` (`parseHubArgs`, ~257); `server/hub.ts:1090` (`startHub`, ~183); `server/handler.ts:1293` (`routeRequest`, ~153)
- **Description:** `createLayer` holds capture, composer wiring, presentation, note mutations, highlight/jump, settings persistence, error reporting and teardown in one scope. The concrete costs: (a) none of the 69 inner functions can be unit-tested alone, so `tests/unit/ui.test.ts` (2,591 lines, 79 cases) has to drive the whole layer through the DOM; (b) `enable()`/`disable()` must be complete and idempotent (FR-12.1/12.2, NFR-15), and checking that means confirming by hand that all 27 closure variables are reset on teardown, which a reviewer cannot do reliably; (c) every UI feature edits the same function, which is a merge-conflict and regression hotspot. `dispatchTool` grows by one `case` per MCP tool (an OCP violation: adding a tool means editing the dispatcher). (Judgment: the line counts are verifiable; how to split them is a design decision.)
- **Recommendation:** Extract cohesive units from `createLayer` as factories with explicit dependencies and a `dispose()`. Start with presentation wiring, note-mutation actions, highlight/jump and settings persistence. Teardown then becomes a list of `dispose()` calls that can be tested. Replace the `dispatchTool` switch with a `name → handler` table next to the tool definitions. This is a refactor ticket (`refactoring-specialist`), not a merge blocker.

#### CQ-04 — Presentation mode has no unit tests, and no coverage is measured
- **Severity:** medium
- **Location:** `src/ui/present.ts` (443 lines; pure exports `readCues` :96, `totalDuration` :117, `currentCue` :122, `createPresentation` :132), `src/ui/composer.ts` (645 lines), `src/ui/legend.ts` (145 lines); `vitest.config.ts` and `package.json` (no coverage provider or threshold)
- **Description:** No file in `tests/unit/` imports `present.ts` or calls `readCues`/`totalDuration`/`currentCue`. These are pure timing functions that decide which cue is active at a given elapsed time, which makes them the easiest code in the repo to unit-test and a classic source of off-by-one boundary bugs. The only coverage is one smoke case (`scripts/embed-smoke.mjs:571`, "read-only presentation mode"). `composer.ts` and `legend.ts` are reached only indirectly through `ui.test.ts`/`voice.test.ts`. Coverage is not measured anywhere (the CI "coverage gate" at `ci.yml:141` checks a component manifest, not line or branch coverage), so gaps like this cannot be seen. FR-20 is also missing from REQUIREMENTS.md (BP-01), so the feature has neither acceptance criteria nor unit tests.
- **Recommendation:** Add `tests/unit/present.test.ts` covering `readCues` ordering/route filtering, `totalDuration`, and the `currentCue` boundaries (elapsed = 0, exactly at a cue start, past the end). Enable `vitest --coverage` (the v8 provider needs no runtime dependency) as an informational report, then add a threshold once a baseline exists.

#### CQ-05 — Extension worker, bridge and bootstrap, CLI entry and MCP stdio entry have no unit tests
- **Severity:** low
- **Location:** `extension/src/sw.ts` (441 lines), `extension/src/bootstrap.ts` (286), `extension/src/bridge.ts` (210), `extension/src/detect.ts` (42); `src/cli/bin.ts` (744), `src/mcp/server.ts` (116), `src/argv.ts` (62); `server/atomic-write.ts`, `server/cors.ts`, `server/credentials.ts` (indirect only)
- **Description:** These modules are not imported by any unit test. They are covered at a coarser level: `smoke:ext` (real Chrome), `smoke:cli`, `smoke:mcp` and the server suites (which reach `cors`/`credentials` through the handler) all run in CI (`ci.yml:164-240`). The gap is speed of diagnosis, not missing coverage. Message validation in `bridge.ts` and the settings-to-injection mapping in `sw.ts` are trust-boundary logic, and they can only be tested in a full browser. The other extension modules (`hub-fetch`, `page-relay`, `storage-relay`, `connection`, `handoff`, `settings`) have unit tests, and they are good examples of what is possible.
- **Recommendation:** Move the pure parts of `sw.ts` (mount options from settings) and `bridge.ts` (envelope validation) into small modules, following the `hub-fetch.ts` pattern, and unit-test them. Leave the `chrome.*` wiring to `smoke:ext`.

#### CQ-06 — Keyboard-command mount path in the service worker leaves rejections unhandled
- **Severity:** low
- **Location:** `extension/src/sw.ts:379-385` (`chrome.commands.onCommand` → `chrome.tabs.query(...).then(async … await mountOnTab(...))`, no `.catch`); compare `extension/src/sw.ts:345` (toolbar click, `.catch(() => undefined)`); rejection source `extension/src/sw.ts:165` (`chrome.scripting.executeScript` not caught inside `mountOnTab`)
- **Description:** On a tab where injection is forbidden (for example `chrome://`, the Web Store, or a PDF viewer), `mountOnTab` rejects. The toolbar path swallows this on purpose. The keyboard-shortcut path does the same work without a handler, so it raises an "Uncaught (in promise)" on the extension's error page, and the user sees no feedback. (Verifiable: compare the two listeners.)
- **Recommendation:** Give both paths the same handling, preferably by returning `{ ok: false, error }` from `mountOnTab` when the second `executeScript` fails, so neither caller has to swallow anything.

#### CQ-07 — Type escape hatches: 24 `as unknown as` casts and 22 non-null assertions, concentrated in a few files
- **Severity:** low
- **Location:** `as unknown as`: `src/embed/attach.ts:86,93,106,109,148,427,506,529` (8), `server/handler.ts:947,1068`, `server/journal.ts:366,367`, `src/data/canonical.ts:202,203`, `src/mcp/tools.ts:465,473`, `src/federation/client.ts` (2), `extension/src/page-relay.ts` (2), `src/cli/bin.ts:339`, `src/index.ts:87`, `src/ui/voice.ts` (1). Non-null `!`: `src/federation/backend.ts:587,615,683,684,…` (14×, `self!`), `src/federation/net-policy.ts:128,174,175,217,226,233,242,288` (8×)
- **Description:** The overall discipline is good: there are 0 `any`, 0 `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck` and 0 `eslint-disable`. The remaining hatches fall into three groups. (a) Timer-handle and DOM-global shims (`attach.ts`, `journal.ts`) are harmless. (b) Casts that follow validation: `handler.ts:947` and `:1068` are safe because `validateNote` runs on the merged result (`handler.ts:1074,1096,1115`), and `cli/bin.ts:339` is followed by `validateBundle`. (c) `backend.ts` uses `self!` 14 times inside closures, where narrowing from `selfAvailable()` (`:178`) is lost. If someone edits the guard, the compiler will not notice. The `net-policy.ts` index assertions follow length checks, so they are correct, but this is the SSRF gate (SEC-11), and a silent `undefined` there would misclassify an address.
- **Recommendation:** In `backend.ts`, capture a narrowed `const local = self` after the guard (or pass `SelfSource` into the helper) so the 14 assertions go away. In `net-policy.ts`, destructure with explicit length checks (`const [a, b, c, d] = octets; if (d === undefined) return null;`). Leave groups (a) and (b).

#### CQ-08 — `exactOptionalPropertyTypes` is disabled although output depends on key presence
- **Severity:** low
- **Location:** `tsconfig.json` (`"exactOptionalPropertyTypes": false`); `extension/tsconfig.json` (not set)
- **Description:** The rest of the strictness set is on (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noUnusedLocals/Parameters`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `isolatedModules`). With `exactOptionalPropertyTypes` off, `{ field: undefined }` type-checks where `{}` is meant. Canonical serialization (NFR-17) and the strict patch/draft key checks (`server/handler.ts:938` refuses unknown keys) both care whether a key is present, not just whether it has a value, so the type system cannot catch that class of drift. The setting is explicitly `false`, so this was presumably a conscious choice, but there is no comment explaining it. (Judgment: enabling it costs some churn, and the benefit is preventive.)
- **Recommendation:** Try enabling it on a branch to measure the error count. If that is too costly, add a one-line comment in `tsconfig.json` explaining why it stays off.

#### CQ-09 — 36 exported values are never imported anywhere; one has no reference at all
- **Severity:** low
- **Location:** e.g. `server/mcp.ts:325` (`HUB_VERSION`, zero references, not even in its own file); `server/journal.ts:82,83,143` (`JOURNAL_AUTHOR_ENV`, `JOURNAL_SUBJECT_ENV`, `ACTOR_TRAILER`); `server/admin.ts:52,195` (`ADMIN_HEADER`, `readRegistry`); `server/credentials.ts:35,40` (`hasSecretCredential`, `hasTokenCredential`); `src/mcp/protocol.ts:30,31`; `src/mcp/tools.ts:61,63,65,70,383`; `src/federation/client.ts:117,118,185`; `src/i18n/index.ts:29,33,59,64`; `src/ui/present.ts:96,117,122`; `src/ui/panel.ts:108`; `src/ui/keymap.ts:62`; `src/core/anchor.ts:510`; `src/embed/attributes.ts:22,36`; `src/embed/version.ts:27`; `extension/src/page-relay.ts:84,95,172`
- **Description:** None of these modules is a package subpath or an `export *` barrel. `noUnusedLocals` does not flag exports, so dead surface builds up silently. In addition, about 113 exported *types* are not imported elsewhere. Those are mostly option/result types on exported functions and are acceptable. The value exports are misleading: they suggest an API contract or a test seam that nobody uses. `present.ts:96/117/122` are an exception and should stay exported, because they are exactly the seam that CQ-04 needs.
- **Recommendation:** Remove `HUB_VERSION` and drop `export` from the other internal constants and helpers, or use them from tests where they are meant as seams. Optionally add an unused-export check (for example a small script like the one used for this audit) to `verify`.

### Checked, no finding

- **TypeScript strictness:** `strict` plus `noUncheckedIndexedAccess`, `noImplicitOverride`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax` and `isolatedModules` in both the root and extension configs (exception: CQ-08). Extension sources are typechecked on their own (`typecheck:ext`), and both typechecks pass. `tsconfig.types.json` keeps `src/cli/**` out of the declaration emit for a documented reason.
- **`any` / suppressions:** 0 `any` annotations or casts, and 0 `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` or `eslint-disable` in `src/`, `server/`, `extension/src/` and `tests/`.
- **Swallowed errors:** no empty `catch {}`. There are 16 comment-only `catch` blocks (`src/ui/layer.ts` ×5, `src/ui/voice.ts` ×3, `src/ui/composer.ts` ×2, `extension/src/sw.ts` ×3, `src/index.ts`, `server/hub.ts`, `src/cli/bin.ts`), and each states its reason (NFR-5/NFR-14 degrade-not-break, best-effort focus or scroll, already-ended recognisers). The only bare `// ignore` is `src/ui/layer.ts:593`, which guards a `console.debug` call and is acceptable. The five `.catch(() => undefined|{})` sites are documented best-effort calls (CQ-06 covers the one that is missing a handler).
- **Fire-and-forget promises:** the 26 `void …` calls were checked. `mutate()` (`src/ui/layer.ts:1164`) catches and reports. `server/index.ts:58` and `server/federator.ts:419` `main()` wrap startup in `try/catch` with a documented exit code. The `extension/src/options.ts` promise chains end in `.catch` or call functions with an internal `try`. The only gap is CQ-06.
- **`JSON.parse` at boundaries:** all 28 sites are inside a `try` or follow a validated parse. `src/mcp/tools.ts:758` parses a second time after `parseNoteSet` has already succeeded (redundant but safe). `server/hub.ts:1182` runs inside the revocation `try`, and it refuses to overwrite a corrupt list instead of silently un-revoking ids. Storage adapters degrade to memory and report once (NFR-5/NFR-8).
- **`console` in library code:** only `console.debug`, with a `bluepencil:` prefix, for subscriber or adapter failures (`src/core/store.ts:182`, `src/adapters/*.ts`). This is documented under NFR-8/NFR-14. CLI, MCP and server write to `process.stderr`/`stdout` and contain no `console.*`.
- **TODO/FIXME/XXX/HACK:** 0 occurrences in `src/`, `server/`, `extension/src/` and `tests/`.
- **Test hygiene / flakiness:** no `.only`, `.skip` or `.todo`. Servers listen on port `0` (`tests/unit/hub-federation.test.ts:234`, `server-start.test.ts:141`). Sixteen suites use `mkdtemp`, and fake timers are used where timing is asserted. Twelve `setTimeout(resolve, 0|5)` macrotask flushes (6 in `attach.test.ts`, 1 five-ms wait at `federation-client.test.ts:891`) depend on scheduling order, but none on wall-clock duration. The one wall-clock assertion (`federation-client.test.ts:225`, a 20 ms timeout asserted below 2000 ms) has a 100× margin. The environment for each suite is declared by a docblock in the suite itself, not by a central list that could drift. Flakiness was not measured over repeated runs (see limitations).
- **Test mapping:** 63 unit suites. Every module under `src/core`, `src/data` (through the `src/data` barrel), `src/adapters`, `src/federation`, `src/element`, `src/embed`, `src/mcp` (except the `server.ts` stdio entry) and `server/` (except the three helpers in CQ-05) is imported by at least one suite. Exceptions are listed in CQ-04 and CQ-05.

---

## 6. Summary

### Finding counts (whole report)

| Severity | BP | SEC | CQ | Total |
|----------|---:|----:|---:|------:|
| critical | 0 | 0 | 0 | **0** |
| high | 1 | 1 | 0 | **2** |
| medium | 3 | 9 | 3 | **15** |
| low | 6 | 17 | 6 | **29** |
| info | 0 | 1 | 0 | **1** |
| **Total** | **10** | **28** | **9** | **47** |

### Critical and high findings

- **BP-01** (high): FR-17 … FR-20 are cited in code and docs but not defined in `docs/REQUIREMENTS.md`.
- **SEC-13** (high): any script on any annotated page can read and overwrite notes captured on every other site.
- No critical findings.

### Not audited / limitations

- **Static analysis only.** No dynamic testing of a running hub, federator, MCP server or extension, and no fuzzing of the HTTP, MCP JSON-RPC or bundle parsers.
- **No penetration test.** Security findings (sections 2–4) come from code reading. Exploitability was not demonstrated against a live deployment, and DNS-rebinding, SSRF and cross-tab scenarios were not reproduced.
- **Tests run once.** `npx vitest run` passed once (1444/1444), so flakiness was not measured over repeated or parallel runs. The e2e/smoke suites (`smoke:*`, CDP harness, real-Chrome `smoke:ext`, `smoke:docker`) were not run for this audit.
- **No coverage numbers.** The project has no coverage tooling configured (CQ-04), so the test-gap analysis is based on import mapping, not line or branch coverage.
- **Heuristic tooling.** Function lengths come from a brace heuristic on top-level functions, and the dead-export scan is name-based (a name collision can hide a dead export, and dynamic access can hide a use). Duplicate detection covered same-named functions, not semantically similar code with different names.
- **Dependencies.** `npm audit` (prod and full) and `npm outdated` were available and run in section 4. The audit relies on the npm advisory database only, with no SBOM tool or second CVE source. The supply chain of the downloaded `reqmd` binary and of the GitHub Actions was reviewed only as far as SEC-22/SEC-28.
- **Areas skipped or only skimmed:** `examples/` (beyond the secret scan), `scripts/*.mjs` code quality (only security-relevant process spawning was checked), `.claude/` and agent-meta infrastructure, generated `spec/` and `dist/` contents (beyond size-guard and the pack paths), `server/admin-html.ts` markup and styling, the i18n string catalogues (`src/i18n/en.ts`, `de.ts`) for completeness, and accessibility (FR-11 / A11y) of the UI.
- **Point in time.** Findings reflect the `chore/system-audit` working tree on 2026-11-02 (version 0.11.6). IDs are stable, but line numbers will drift.
