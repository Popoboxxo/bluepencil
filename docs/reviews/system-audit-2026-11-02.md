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
