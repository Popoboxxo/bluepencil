# Review — Hub-Viewer auf eigenem Origin (Spec)

> Reviewed document: `docs/specs/2026-11-06-viewer-origin-spec.md` (Status: DRAFT, Rev. 1.0)
> Design input: `docs/specs/2026-11-06-viewer-origin-design.md`
> Issue context: GitHub #140 (public body reviewed)
> Review date: 2026-11-06
> Reviewer: concept-reviewer
> Mode: spec review before the user approval gate
> Verdict: **CHANGES_REQUESTED**

The architecture is viable and the design is unusually thorough. The findings are
not conceptual: they are a false premise about issue #140, several normative
contradictions inside the spec, and security contracts whose call sites are not
implementable as written. No code or spec was modified by this review.

## 1. Scope

Reviewed: the full spec (882 lines), the design (838 lines), and the named code
facts (`server/hub.ts`, `server/handler.ts`, `server/viewer.ts`, `server/cors.ts`,
`server/admin.ts`, `src/adapters/http.ts`, `src/federation/net-policy.ts`,
`tests/unit/viewer.test.ts`), plus issue #140 and the current
`docs/REQUIREMENTS.md` / `docs/CONCEPT.md`.

Not reviewed: implementation plan, release versioning, requirement-ID assignment.

## 2. Findings by severity

Severity: **blocker** = fundamental, unsolvable; **major** = blocking before
approval; **minor** = improvement, not blocking; **info** = observation.

### 2.1 Major

| ID | Section | Finding | Required fix |
|---|---|---|---|
| **CR-01** | §0, §1.4 A1, §11.2 #1 | **A1 is factually false.** Issue #140 has six acceptance criteria, not only AC 5. ACs 1–4 and 6 are public: `/view` with mounted layer and absolute endpoint; allowlist/loopback/metadata and 401/404; CSP header **and** `<meta>` removed; note visible in `/notes` and `list_notes`; own origin; tests for static/SPA/no-`</head>`/meta-CSP. The spec declares ACs 1–4 unknown and does not trace AC 3 (header CSP) or AC 6 (static/SPA tests). | Replace A1 with the actual issue text; add a trace table `#140 AC 1–6 → spec AC / test`; add a header-CSP test; add static and SPA proxy tests. |
| **CR-02** | §2.2 rule 5, rule 8; §3.2 step 3; D5; AC-5.14 | **Normative contradiction on asset auth.** Rule 5 orders `Session prüfen` before `Shell/Bookmarklet/Assets/Proxy`; D5, §3.2 and AC-5.14 require `/viewer/assets/*` to be public (no cookie/header). As written, AC-5.14 cannot pass. Code: `server/viewer.ts:378` (session check) runs before `server/viewer.ts:416` (assets). | State explicitly: assets are served **before** the session check; only shell, bookmarklet, `/view` and notes require a session. |
| **CR-03** | §1.2 goal 1, R1, §2.8 note, AC-5.2 | **“Hub port returns 404” is false with `--root`.** `respond()` serves the static fallback for paths outside `base`; `findStaticFile()` falls back to `root/index.html` for any missing path (`server/hub.ts:845-848`, `server/hub.ts:540-552`). With `--root`, `GET {hub}/viewer` can return `200` (operator index), not `404`. AC-5.2 only tests without `--root`. | Either block the viewer paths on the hub surface even with `--root` (explicit refusal in `respond`/`gateRequest`), or weaken R1/§1.2 to “no viewer content; static fallback may answer” and add a `--root` AC. |
| **CR-04** | §4.8 point 4, §2.2 rule 12 | **SSRF fail-closed is underspecified.** The spec does not say what `checkTarget()` does when the resolver throws or returns `[]`, and it does not require the metadata-hostname check (`metadata.google.internal`, etc.) before DNS. `proxyTarget()` only maps `checkTarget`'s `string \| null`; a thrown resolver would become a 500, and an empty answer could be treated as “no disallowed address”. The existing `checkBaseUrl()` is fail-closed on both (`src/federation/net-policy.ts:657-702`). | Require: resolver throw/empty → `target_not_allowed`/`unresolvable_host` (403), no fetch; check `METADATA_HOSTNAMES` before DNS; make `checkTarget()` total (never throw). |
| **CR-05** | §2.5 rule 2, §4.6; AC-5.21 | **The actual-response CORS call site is missing.** `viewerBookmarkletCors()` is defined, but the spec says only that `gateRequest()` calls the preflight for `notes*`; it never says where the success/error response gets the reflected `Allow-Origin`. `json()`/`errorResponse()` in `server/handler.ts:776-803` only add `corsHeaders(context.cors)`, and the viewer context intentionally has `cors: undefined`. AC-5.21's “POST response carries the same `Allow-Origin`” is therefore unimplementable from the contract. | Specify the exact call sites (e.g. the viewer surface's `json`/`errorResponse` wrapper for `{base}/notes*`, on success **and** error), and that no other route gets it. |
| **CR-06** | §2.1 rule 6; design §3.1 | **`earlyRefusal()` viewer bypass is not surface-gated.** The design promises viewer paths on the hub cost no body read/store load. `earlyRefusal()` returns `null` for `context.viewer !== undefined && isViewerRequest(...)` (`server/hub.ts:796-800`); on the hub context (which must carry `viewer` for the launcher's tickets), that skips `gateRequest`, reads the body and reloads the store before the final 404. The spec only says “dispatch to handleViewer” is surface-gated, not this early return. | Bind the viewer early-return in `earlyRefusal()` (and the launcher check) to `surfaceOf(context) === "viewer"` / `"hub"`, not only the `handleViewer` dispatch. |
| **CR-07** | §2.4 rule 1; design §3.4 | **Viewer context inherits hub-only secrets.** `viewerContext = { ...baseContext, ... }` keeps `adminSecret`, `tokenIssuer`, `revokeToken`, `devicesPath`, `revocationPath` (and `options.root` is still passed to the viewer listener's `respond`). The “secret never on the viewer surface” property is then behavioural, not structural: a future viewer route can read the operator secret from its own context. | Build `viewerContext` from an explicit allowlist of shared fields (`store`, `base`, `environment`, `readOnly`, `allowEnvMismatch`, `authSecret`, `verifyToken`, `adminThrottle`, `presence`, `persist`, `viewer`, `surface`, `bind`, `hostAliases`); omit `adminSecret` and all admin-only handlers. Pass a viewer-specific `options` with `root: undefined`. |
| **CR-08** | D10, §4.6 | **`--cors '*'` still trusts the viewer origin.** D10 says the hub CORS must never name the viewer origin, but `--cors '*'` is allowed with a client credential and `journalResponse()` is public and emits `ACAO: *` (`server/hub.ts:724-756`, `server/cors.ts:119-140`). A page on the viewer origin can therefore read the hub journal (and `/config`/`/health`) even though the viewer surface itself blocks them. | Forbid `--cors '*'` when `--viewer` is configured, or explicitly document the public-endpoint exposure and add an AC that the viewer origin cannot read the hub journal. |
| **CR-09** | §5.2, AC-5.22; D10 | **`--viewer-port 0` + `cors_viewer_origin` blind spot is disclosed but not closed.** The check is skipped when the viewer origin is unknown at parse time; no runtime re-check occurs after `listen()`. The same applies to `viewer_origin_is_hub_origin` with `--port 0`. D10 is normative (“Nutzungsfehler”), but the invariant is unenforced in a supported configuration. | Add a post-`listen()` validation in `startHub()` (refuse the start if `cors` normalises to the actual viewer origin, or if the actual viewer origin equals the actual hub origin) before serving. If the residual is accepted, downgrade D10 to “best effort” and document it in §4.9 rather than presenting it as a hard rule. |
| **CR-10** | D8, §5.1, §5.3, S1 | **`--viewer-public-url` alias changes meaning silently.** In 0.13.0 the flag was the public origin of the **hub-port viewer** (i.e. usually the hub origin). In this spec it becomes an alias for the **viewer listener** origin. An old deployment that keeps `--viewer-public-url https://hub.example.com` will be accepted (it does not match the bind-derived hub origin), and the launcher will redirect to `https://hub.example.com/base/viewer?ticket=…`, which is now a 404. | Treat the old value as a migration error unless it is re-pointed: reject the alias when it equals the hub public origin (not only the bind-derived one), document the semantic change in `CHANGELOG`/`docs/VIEWER.md`, and validate the alias with the same origin rules as `--viewer-origin` (no path/query/fragment). |
| **CR-11** | AC-5.17, AC-5.19, AC-5.20 | **SSRF ACs do not isolate the behaviour they claim.** With allowlist `example.com`, direct URLs `https://169.254.169.254`, `http://10.0.0.1`, etc. are rejected by `hostAllowed()` before `classifyAddress()` runs (`server/viewer.ts:136-178`). In AC-5.19 the `*.example.com` case uses `example.com`, which the wildcard does not match, so it is rejected by the allowlist, not by the private-IP rule. In AC-5.20 a loopback viewer origin is rejected as loopback before `forbiddenOrigins` matters. | Change the ACs to keep the URL host allowlisted and let a stub resolver return the dangerous address; use `foo.example.com` for the wildcard case; use a non-loopback viewer origin for `forbiddenOrigins`; assert the exact error code/reason. |
| **CR-12** | §6, E5, §6 intro | **Requirement proposal uses an inconsistent milestone and an invented placement.** R1–R9 all carry `Ms: M6`, but M6 is “Polish / 1.0.0” (`docs/CONCEPT.md:299`, `docs/ARCHITECTURE.md:595`), while the spec targets 0.14.0. The text also mentions “Design vermutet Bereich 22”, which is not a REQUIREMENTS category; the real anchor is FR-6 (“Storage & transport”, ends at FR-6.16). | Leave milestone and ID assignment to `requirements` (or use the 0.14.0 slot), and name a concrete placement: FR-6.17+ or a new top-level section. Remove “Bereich 22”. |

### 2.2 Minor

| ID | Section | Finding | Required fix |
|---|---|---|---|
| **CR-13** | §2.2, §2.4 vs design §3.2/§3.4 | The spec adds `publicBaseUrl` to `ViewerOptions` and `ServerOptions.viewer`; the design’s contract does not contain it. This is a deliberate S2 addition, but “D1–D12 übernommen” is not literally true. | Mark S2 as an explicit spec-level addition to the design, or update the design. |
| **CR-14** | §2.9 | The viewer error codes `missing_url`, `target_not_allowed`, `target_too_large`, `target_not_html`, `target_unreachable`, `too_many_redirects` are not in `ERROR_CODES` (`server/handler.ts:114-158`). The viewer uses a local `refusal(status, code: string)`. | State that these are viewer-local codes, or extend `ERROR_CODES`; avoid presenting them as part of the handler vocabulary. |
| **CR-15** | §5.1, §5.2, AC-F7/F14 | The validation matrix omits the existing `--viewer-assets` / `--viewer-allow` missing-value errors, the `--viewer-ttl` minimum (60 s), and the fact that `--viewer-assets`/`--viewer-allow`/`--viewer-ttl` without `--viewer` are currently silent no-ops. `--viewer=false` is also treated as “on” by `present()` (`server/hub.ts:1702`). | Complete the matrix; decide whether all viewer flags (not only host/port/origin/public-url) are `viewer_flags_without_viewer`; parse `--viewer` with the strict boolean helper. |
| **CR-16** | §5.2, A7, AC-F3 | `--viewer-port == --port` is an unconditional error. With `--port 0 --viewer-port 0` (a valid ephemeral test setup) it would reject, and with different bind hosts the same port can be legitimate. | Special-case `0`, and compare the bind address too; document the rule as “same bind address and same port”. |
| **CR-17** | AC-5.8, IT-08 | With the default `git` journal and `--journal-coalesce 2000`, a write followed immediately by `GET /journal` does not yet show the entry (`server/journal.ts:370-381`). AC-5.8 says “file oder git” without this caveat. | Require `--journal file` or `--journal-coalesce 0` in the test setup. |
| **CR-18** | §4.7, AC-F13 | `viewer_cookie_shared_host` compares against the hub bind host, not the hub’s public origin. A wildcard hub bind (`0.0.0.0`) or a reverse-proxied hub (`hub.example.com` → `127.0.0.1`) can share a cookie hostname without the warning. | Define the hub public origin used for the comparison (or treat wildcard as “all names”); document the limitation. |
| **CR-19** | §2.5 rule 1 vs §4.6 | §2.5 requires only a valid `Origin` for the viewer preflight; §4.6 says `Origin` **and** `Access-Control-Request-Headers: x-bluepencil-viewer`. The function signature does not take the requested headers. | Align the prose and the signature; state explicitly whether the preflight is gated on the requested header. |
| **CR-20** | §2.2 rule 6 vs §3.1 step 5 | The ticket-exchange `302` in rule 6 does not name `Referrer-Policy: no-referrer`; §3.1 step 5 requires it. The current `?k` 302 (`server/viewer.ts:367-374`) sets only `cache-control`. | Add `referrer-policy: no-referrer` to the ticket `302` response contract. |
| **CR-21** | §2.4 rule 7, §5.4, AC-F13 | `StartupWarning.code` is a two-value union (`server/hub.ts:129-133`); the three new warnings are not added to the interface. The spec also does not say whether `viewer_public_url_deprecated` is emitted by `parseHubArgs` (a pure function returning `HubOptions \| string`) or by `startHub`. | Extend the `StartupWarning` contract and name the emission point (recommend `startHub`, with `--quiet` not suppressing it). |
| **CR-22** | Header | The spec header says `Status: DRAFT`; the spec-template gate expects `Status: Entwurf` or `Status: APPROVED (<Datum>)`. | Use `Status: Entwurf` until the separate user approval sets `APPROVED`. |
| **CR-23** | §2.1 rule 4 | The claim that `viewerSurfaceRefusal()` uses “the same normalisation as `requestPath()`” is under-specified: `requestPath()` uses `new URL` and does not percent-decode `%2e%2e` (`server/handler.ts:587-597`, `:611-622`). The protection is currently the later 404, not the refusal. | Define one normalised surface path helper (decode, reject dot segments) and test encoded/dotted variants. |
| **CR-24** | §2.2 rule 7 | The rejection message promises `{hubOrigin}{base}/viewer/start`, but no `hubOrigin` is carried into the viewer context (`ViewerOptions` has only the viewer origin; `context.bind` is the viewer bind). | Add the hub public origin to the viewer context (or wording “on the hub launcher” without a constructed URL). |
| **CR-25** | §2.7, §5.1 | `ttlSeconds` is capped at 604800 only in `parseHubArgs`; a programmatic `ServerOptions.viewer.ttlSeconds` is passed through to `createViewerSessions`/cookie without validation (`server/hub.ts:1724-1732`, `server/viewer.ts:91-123`). | Validate/clamp in `resolveOptions` or document that the cap is CLI-only. |
| **CR-26** | §5.2 | `--viewer-host ""` (unspecified bind) is not covered by the wildcard-origin requirement, which names only `0.0.0.0`/`::`. | Treat an empty host like a wildcard bind and require `--viewer-origin`. |

### 2.3 Info

| ID | Section | Observation |
|---|---|---|
| **CR-27** | §2.4 rule 5, AC-F11 | `RunningServer.url` using the configured host (existing behaviour) vs `RunningViewer.url` using the public origin is **consistent** with `server/hub.ts:1493-1497`. Keep the wording in `docs/VIEWER.md` explicit. |
| **CR-28** | §11.1 | No unresolved `TODO`/`TBD`/placeholder sections found; `spec-id` is present and matches the design. |
## 3. The 10 disclosed inconsistencies — confirm/refute

| # | Disclosed | Verdict | Reference |
|---|---|---|---|
| 1 | Issue ACs 1–4 unknown | **Refuted.** Issue #140 has ACs 1–6 (public body). A1 is false. | CR-01 |
| 2 | Category name not in REQUIREMENTS | **Confirmed.** `FR-6` ends at FR-6.16; the new block is unplaced. | CR-12 |
| 3 | 0.14.0 comes from the task, not the design | **Confirmed.** `package.json` is 0.13.0; no AC depends on the version. But `Ms: M6` contradicts it. | CR-12 |
| 4 | `--root` on the hub | **Confirmed.** Static fallback can serve `index.html` for `/viewer`; AC-5.2 tests only the no-root case. | CR-03 |
| 5 | `respond()` order vs design | **Confirmed.** Journal/static are served before `gateRequest`; the spec correctly adds `viewerSurfaceRefusal` to `respond`. The missing piece is the `earlyRefusal` viewer early-return. | CR-06 |
| 6 | Programmatic `publicBaseUrl` compatibility | **Confirmed.** Design does not regulate it; S2 decides. The spec should mark it as a spec-level addition. | CR-13 |
| 7 | Both origin flags at once | **Confirmed.** Design does not regulate it; S1 decides. The alias also needs origin validation and old-value handling. | CR-10 |
| 8 | Old `{base}/viewer?k=` links | **Confirmed.** Design only says “must move”; S3’s `404` without redirect is the right call. | — |
| 9 | `RunningServer.url` vs `RunningViewer.url` | **Confirmed consistent.** `RunningServer.url` keeps the configured host; `RunningViewer.url` uses the public origin. | CR-27 |
| 10 | `--viewer-port 0` + `cors_viewer_origin` | **Confirmed.** The check is skipped and not re-run after `listen()`; the same blind spot exists for `viewer_origin_is_hub_origin`. | CR-09 |

Missed by the specifier: the asset-order contradiction (CR-02), the `--cors '*'`
trust of the viewer origin (CR-08), the viewer-context secret inheritance
(CR-07), the `--viewer-public-url` semantic change (CR-10), and the `0 == 0`
port-conflict case (CR-16).

## 4. Decisions E1–E5 / S1–S3

| Ref | Answer | Why |
|---|---|---|
| **E1** Private IPs only on exact allowlist entry | **Agree** | Exact entry (no `*.`, no CIDR) is the right default; loopback/link-local/metadata/reserved must stay blocked unconditionally. Add the fail-closed resolver rule (CR-04) and the metadata-hostname check. |
| **E2** `--viewer` without `--viewer-port` is a hard error | **Agree with a change** | The hard error is the only variant that does not preserve the insecure default; it is acceptable in a 0.x minor. Change the unconditional `--viewer-port == --port` rule: allow `0 == 0` and compare the bind address too (CR-16). |
| **E3** Secret transport: `?k=` + `x-bluepencil-admin`, no POST form | **Agree** | The secret stays on the hub origin; a POST form adds surface without a security gain. Keep `no-referrer`/`no-store`; document `?k=` history/logs as residual. |
| **E4** Same hostname allowed, warning only | **Agree** | AC 5 asks for another origin, not another hostname. Keep the warning non-suppressible; fix its comparison basis (CR-18) and document that only a different hostname isolates the cookie. |
| **E5** New requirement block in “Hub-Betrieb, Auth & Extension-Relay” | **Agree with a change** | The category exists in `AGENTS.md`, not in `REQUIREMENTS.md`. Let `requirements` assign IDs and milestone; name a concrete anchor (FR-6.17+ or a new top-level section). Remove `M6` and “Bereich 22” (CR-12). |
| **S1** Both origin flags: equal accepted, different = usage error | **Agree** | A conflicting pair is worse than a clear error. Add the alias validation and the old-value migration check (CR-10). |
| **S2** Programmatic `publicBaseUrl` stays as deprecated input alias | **Agree** | One release is enough; `origin` wins. The design must be aligned with the spec’s extra fields (CR-13), and `resolveOptions` should validate the value. |
| **S3** Old `{base}/viewer?k=` returns `404`, no redirect | **Agree** | A redirect would put the secret into a second `Location`; `404` plus the documented `/viewer/start` successor is the correct, minimal break. |

## 5. Must fix before approval (blockers/majors)

1. **CR-01** — correct A1 and trace issue #140 ACs 1–6; add header-CSP and static/SPA tests.
2. **CR-02** — fix the `handleViewer` asset/session order.
3. **CR-03** — resolve the `--root` vs “hub port 404” contradiction (or add the missing AC).
4. **CR-04** — make `checkTarget()` fail-closed on resolver throw/empty and metadata hostnames.
5. **CR-05** — name the actual-response CORS call site (success and error, `notes*` only).
6. **CR-06** — surface-gate the `earlyRefusal` viewer early-return and launcher check.
7. **CR-07** — build the viewer context from an explicit shared-field allowlist; omit hub-only secrets.
8. **CR-08** — decide `--cors '*'` + viewer (forbid or document the journal exposure).
9. **CR-09** — add the post-`listen()` CORS/origin validation or downgrade D10 to best effort.
10. **CR-10** — handle the `--viewer-public-url` semantic change and validate the alias.
11. **CR-11** — make the SSRF ACs actually exercise DNS/IP classification and `forbiddenOrigins`.
12. **CR-12** — fix the milestone/placement of R1–R9.

No **blocker** findings: the architecture is viable; the above are correctable in one
revision cycle.

## 6. Back to `concept-specifier` (max 3 iterations)

1. **Traceability pass:** replace A1 with the real issue #140 text; add an
   `#140 AC 1–6 → spec AC → test` table; add the missing header-CSP and
   static/SPA/no-`</head>` proxy tests.
2. **Normative-contradiction pass:** asset order (CR-02), `--root` wording
   (CR-03), CORS actual-response call site (CR-05), `earlyRefusal` surface gate
   (CR-06), viewer-context field allowlist (CR-07).
3. **Security/CLI pass:** `checkTarget` fail-closed (CR-04), `--cors '*'`
   decision (CR-08), post-`listen()` validation (CR-09), alias semantics
   (CR-10), SSRF AC isolation (CR-11), milestone/placement (CR-12) and the
   minor CLI/contract gaps (CR-13–CR-26).

After revision, re-run this review; the user approval remains a separate gate.


