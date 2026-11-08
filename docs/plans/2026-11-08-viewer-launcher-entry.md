---
type: Plan
status: DONE
date: 2026-11-08
topic: viewer-launcher-entry
size: L
target_version: 0.15.0
issue: 144
spec: docs/specs/2026-11-08-viewer-launcher-entry.md
spec_id: SPEC-viewer-launcher-entry
spec_revision: "3"
pipeline_stages:
  implement: 1
  document: 9
  validate-and-document: 10
---

# Viewer launcher as the operator entry point (variants C + B) — implementation plan

> Status: **DONE (2026-11-08)** — steps 1–10 are implemented, documented and validated; the code is
> green (`npx vitest run --maxWorkers=4`, `npm run typecheck`, `npm run build`). **§7 is superseded**
> by the note at the end of this file: the twelve-commit sequence was not used and cannot be
> reproduced from the single working state.
> **Closure note:** the step list below is a plan, not a run log. The boxes were ticked at closure
> against the implemented state (every listed file, test and doc exists and passes), not as a record of
> per-step TDD runs — the change landed as one implementation pass. Authoritative for what was built is
> the code plus §1.3; authoritative for *how* the work was committed is §7.
> **Goal:** `{base}/viewer/start` becomes usable by a browser: a `GET` that asks for HTML gets a
> script-free form, a `POST` carries the secret in the body and trades it for a one-time ticket
> (`303` for HTML, `200 {"url":…}` for JSON), and `{base}/admin/status` reports
> `viewer: {enabled, origin}` so the admin page can open the viewer with the header credential
> (FR-6.17, FR-6.26–FR-6.30).
> **Architecture:** one new pure renderer (`server/launcher-html.ts`) + one shared escaper
> (`server/html.ts`); the launcher gates move into a header-only, side-effect-free
> `launcherHeadRefusal()` inside `server/viewer.ts`; the body read stays in the `node:http` glue
> (`server/hub.ts`) and reuses the existing `readBody()` with its own 8 KiB limit; the pure handler
> `handleViewerStart()` never touches a stream. Secret verification and the throttle budget remain
> exactly one implementation (`verifyOperatorSecret()`).
> **Tech Stack:** TypeScript (strict, ESM), `node:http`, `node:url` (`URLSearchParams`), Vitest,
> JSDOM (already a dev dependency, used by `tests/unit/server-admin-page.test.ts`). No new runtime
> dependency (NFR-4).
> **Spec:** `docs/specs/2026-11-08-viewer-launcher-entry.md` — `spec-id: SPEC-viewer-launcher-entry`,
> revision 3, `Status: APPROVED (2026-11-08)`.
> **Predecessor (not replaced):** `docs/specs/2026-11-06-viewer-origin-spec.md` (`SPEC-viewer-origin`,
> §13 dated addendum lists the superseded statements); `SPEC-viewer-launcher-entry` changes the
> launcher entry only.
> **Target release:** 0.15.0 (next 0.x minor); the concrete version is set by `release`, which is
> **not** part of this plan (§8).
> **Language of this artefact:** English, as requested by the delegating task. The sibling plan
> `2026-11-07-viewer-origin.md` is German prose; see §10 O-1 — this is a deliberate, reversible choice,
> not an oversight. Identifier, paths, flags, error codes, AC ids and commands are verbatim from the
> spec in either case.
> **Conflict rule:** on any contradiction between this plan and the spec, the spec wins. This plan
> adds no AC and renames no contract.

## 1. Prerequisites and baseline

### 1.1 Baseline measurement (read-only, before step 1)

| Check | Command | Expected |
|---|---|---|
| Unit/integration suite | `npm test` | green; the exact file/test counts are recorded in §1.1.1 |
| Types | `npm run typecheck` | exit 0 |
| Build | `npm run build` | exit 0, `dist/` written |
| Spec freshness | `npm run spec:check` | expected 0; it is a structural check only and was **not measured** in the baseline run — see O-3 |

**Known baseline defect (not a blocker, must be closed in step 9):** `spec/` is stale relative to
`docs/REQUIREMENTS.md`. `docs/REQUIREMENTS.md` already carries the revised FR-6.17 / FR-6.21 and the
new FR-6.26–FR-6.30, but `grep -r "FR-6.26" spec/` finds nothing and
`spec/06-storage/requirements.md:320` still shows the pre-revision FR-6.21 text. `npm run spec` has
not been run since the requirement change.

#### 1.1.1 Measured baseline (2026-11-08, branch `feat/viewer-launcher-page`)

| Check | Result |
|---|---|
| `npm test` (full run) | **118 files / 2653 tests**, `skipped 0`. Two full runs: 2651 passed / 2 failed, then 2650 / 3 failed — exit code 1 both times. **All failures are host-capacity flakes**, see below. |
| Failures in isolation | every failing file passes when re-run alone (`federation-registry` + `ui` → 121/121; `cli-instances` + `blueprint` → 2/2, exit 0) |
| `npm run typecheck` | exit 0, no diagnostics |
| `npm run build` | exit 0, all targets ok (`dist/` is gitignored, no tracked change) |

**Not a blocker, but a known property of the gate.** The full run spawns 118 workers on this host;
individual tests hit the 5 s default timeout (`federation-registry.test.ts:793`, `ui.test.ts:334`,
`blueprint.test.ts:112`) and `cli-instances.test.ts:525` collides on a port (exit 5 instead of 0).
Different files fail in each run, and each passes alone — the code is clean, the parallelism is not.
Neither failure touches `server/**` or the launcher.

Consequences for this plan:
1. The authoritative per-step gate is the **targeted** `npm test -- <files>` of the task, not the full
   run.
2. The full-suite gate in §6 is run with bounded parallelism:
   `npx vitest run --maxWorkers=4` (measured green: all 2653 tests). Changes to `testTimeout` or the
   worker count belong to `tester`, **not** to this plan (see §10 O-5).
3. If a full run is red, the failing file is re-run in isolation before it is treated as a
   regression. A failure that survives isolation is a blocker and is reported with the test name and
   first error line; no step in this plan may "carry" a pre-existing failure.

### 1.2 Frozen inputs

- `docs/specs/2026-11-08-viewer-launcher-entry.md` (revision 3, APPROVED) — normative.
- `docs/REQUIREMENTS.md` FR-6.17, FR-6.21 (revised 2026-11-08), FR-6.26–FR-6.30 — already written;
  `requirements` has **no** task in this plan.
- `docs/specs/2026-11-06-viewer-origin-spec.md` §13 — the authoritative list of superseded
  statements (`§2.2 rule 4`, `§2.8 line 582`, `AC-5.4`, `AC-5.9`, `§7`).
- The three dated addenda already exist (`2026-11-06-viewer-origin-spec.md` §13, the review's
  `E3 superseded`, the design's question 3); only one sentence has to be added to the first one
  (step 9).

### 1.3 Files touched (one line each)

**Production — 2 new**

| File | Purpose |
|---|---|
| `server/launcher-html.ts` (new) | `renderLauncherHtml(strings, {action, error?})` and `fillTemplate()` — the form page, no script, no external asset. |
| `server/html.ts` (new) | `escapeHtml()` — the single HTML escaper (FR-9.3), moved verbatim from `server/admin-html.ts:31-38`. |

**Production — 5 changed**

| File | Purpose |
|---|---|
| `server/viewer.ts` | `VIEWER_LAUNCHER_MAX_BODY_BYTES`, `VIEWER_LAUNCHER_FIELD`, `launcherFormat()`, `launcherOriginBasis()`, `launcherHeadRefusal()`, `launcherSecretFromBody()`, `launcherTooLargeAnswer()`; `handleViewerStart()` gains POST/303/200 and HTML negotiation; the private `surfaceOf()` (`:673-675`) is deleted in favour of the import. |
| `server/hub.ts` | The launcher block (`:1095-1105`): `launcherHeadRefusal()` before the read, body via the existing `readBody(request, 8 KiB)`, `body` on the `ServerRequest`, no-answer guard for `BodyTooLargeError`/transport errors, "never falls through" comment. |
| `server/admin.ts` | `statusPayload()` gains `viewer: {enabled, origin}`. Nothing else. |
| `server/admin-html.ts` | Imports `escapeHtml`; overview panel gets `#viewer-row`/`#open-viewer`/`#viewer-status`/`#viewer-note`; `renderOverview()` computes `ready` once, sets `disabled` and fills the note in all three states; `call(path, init, accept)` and the `x-bluepencil-auth` exception for `/viewer/start`; `openViewer()` with no restore on success. |
| `server/admin-i18n.ts` | `AdminStrings`, `en` and `de` gain the 14 keys of spec §5.8; the header comment records that `{name}` placeholders are now also substituted server-side. |

**Tests — 3 new**

| File | Purpose |
|---|---|
| `tests/unit/viewer-launcher.test.ts` (new) | `launcherFormat`, `launcherOriginBasis`, `launcherSecretFromBody`, `launcherHeadRefusal`, `launcherTooLargeAnswer`, `handleViewerStart` (GET/POST matrix), shared budget at handler level, secret-never-in-a-response. |
| `tests/unit/viewer-launcher-page.test.ts` (new) | The renderer contract: one password field, post form, no script/external URL, `lang`, error block, `autofocus`, `fillTemplate` seconds. |
| `tests/unit/admin-viewer-control.test.ts` (new) | The admin control contract in JSDOM: three states, `disabled`, note text, one `fetch`, no `x-bluepencil-auth`, error paths, document order. |

**Tests — 5 changed, plus the fixture and 2 disclosed additions (see §10 O-2)**

| File | Purpose |
|---|---|
| `tests/unit/viewer-start.test.ts` | The method-gate block (`:191-227`) is rewritten: `Allow: GET, POST`, POST is no longer 405; the start-window case moves to `PUT`/`DELETE`. |
| `tests/unit/viewer-dispatch.test.ts` | Launcher block (`:366-395`) migrated to 303 + a `PUT` 405 case; `request(port, path, init)` (`:92-119`) gains `body`; a `urlencoded()` helper; form-body roundtrip, declared-413, chunked abort, shared-budget-in-both-directions, POST 503. |
| `tests/unit/server-admin.test.ts` | `statusPayload().viewer` with and without `--viewer`. |
| `tests/unit/server-config.test.ts` | `/config` carries no `viewer` key. |
| `tests/unit/server-admin-page.test.ts` | 14 new keys in `en` and `de`; the new control markup ids. |
| `tests/unit/helpers/viewer-harness.ts` | `request(url, headers, method)` gains `body?: string` and the `host: "127.0.0.1:8787"` default (spec §8, RVW2-4). Additive. |
| `tests/unit/viewer-session.test.ts` *(disclosed)* | One case (`:142-144`, "carries no Host") builds its request literally instead of through the fixture — the new default would otherwise change its subject. |
| `tests/unit/viewer-surface.integration.test.ts` *(disclosed)* | One added case for `POST {viewer}{base}/viewer/start` → `404` (AC-L20 names GET **and** POST). |

**Docs — 4 changed + 1 generated**

| File | Purpose |
|---|---|
| `docs/VIEWER.md` | Routes matrix (`:101-119`) gains the POST row and the HTML/JSON split; `:154-156` loses "GET-only" and the "missing secret is 401" absolute; the launcher section names the form and the CSRF gate; nginx `$host` → `$http_host` (`:239`, `:251`) with the fail-closed consequence. |
| `README.md` | `:40` and the operator-entry paragraph: the form is the browser entry, `?k=`/header are the script entries. |
| `CHANGELOG.md` | `Added` / `Security` / `Changed` for 0.15.0 (no release head — that is `release`'s job). |
| `docs/specs/2026-11-06-viewer-origin-spec.md` | One sentence in §13: that addendum is the authoritative list of superseded statements. Nothing else. |
| `spec/**` | Regenerated only (`npm run spec`); never hand-edited. |

## 2. Global Constraints

- **C1 — One secret check, one budget.** Only `verifyOperatorSecret()` compares; no second
  comparison, no second throttle, no literal `retryAfterSeconds` in the launcher. The seconds come
  from `OperatorSecretVerdict.retryAfterSeconds` and are used twice from that one object
  (spec §5.1 rule 11).
- **C2 — One mint site.** `viewer.tickets.mint()` is called exactly once in the repository, in the
  success branch of `handleViewerStart()`; `Location` and `url` are built from one local computation.
- **C3 — No second body reader.** The glue calls the existing `readBody()`; there is no
  `readLauncherBody()`, no `LauncherBodyRead`, no `BodyTooLargeError` thrown from launcher code.
- **C4 — No fallthrough.** Once the launcher branch has run — answered, read, or failed — it writes
  or ends the response and returns. It never reaches the journal, the static tree,
  `earlyRefusal()` or the router's `readBody()`.
- **C5 — `connection: close` exactly where no body was read.** Always on `405`, `503`, `403`, `415`,
  `413` (coarser than strictly needed, on purpose); never on `401`, `429`, `200`, `303`.
- **C6 — Gates in this order:** method → origin resolved → CSRF → media type → declared size →
  body → secret. `405` beats `503`; a `405` during the start window stays `405`.
- **C7 — One escaping implementation.** `server/html.ts` is the only escaper; user text is never
  rendered as markup (FR-9.3). The renderer escapes `action` and `error`.
- **C8 — No new surface for `?k=`.** `?k=` is read on `GET` only; a `POST` never reads or compares
  it. The admin page never puts a secret in a URL.
- **C9 — `server/**` stays out of the client bundles.** No file under `src/**` may import from
  `server/**`; the launcher page is server-rendered HTML and must not reach `dist/bluepencil.iife.js`
  or `dist/bluepencil.element.js`.
- **C10 — Admin tab semantics untouched.** `activateTab()`, the `tablist` markup, arrow/Home/End
  handling and `role`/`aria-selected`/`tabindex` rotation (`server/admin-html.ts:572-650`) are not
  changed; the new control is a plain `<button type="button">` in the overview panel.
- **C11 — Status payload is stable in all three states** (`{enabled:false, origin:null}`,
  `{enabled:true, origin:null}`, `{enabled:true, origin:"…"}`). `viewer` never appears in `/config`,
  never in the federation client, never in a log line.
- **C12 — Every commit** is green on `npm run typecheck` + `npm test`; new tests are observed red
  first; Conventional Commit, English, imperative, first line ≤ 72 characters.

## 3. Step sequence

### 3.1 Overview

| # | Step | Files | ACs | Verification |
|---|---|---|---|---|
| 1 | Prepare without changing behaviour: extract the escaper, import `surfaceOf`, add the 14 strings, extend the fixture | `server/html.ts` (new), `server/admin-html.ts`, `server/viewer.ts`, `server/admin-i18n.ts`, `tests/unit/helpers/viewer-harness.ts`, `tests/unit/viewer-session.test.ts` | — (enables AC-L02, AC-L12, AC-L32) | `npm run typecheck && npm test` |
| 2 | Pure launcher primitives | `server/viewer.ts`, `tests/unit/viewer-launcher.test.ts` (new) | AC-L01, AC-L03, AC-L07 (format half), AC-L15, AC-L16, AC-L33 (basis half) | `npm test -- tests/unit/viewer-launcher.test.ts` |
| 3 | Renderer + template fill | `server/launcher-html.ts` (new), `tests/unit/viewer-launcher-page.test.ts` (new) | AC-L01, AC-L02, AC-L08 (no echo in the form), AC-L30 (text half), AC-L32 (render half) | `npm test -- tests/unit/viewer-launcher-page.test.ts` |
| 4 | Header-only gates (`405/503/403/415/413`) | `server/viewer.ts`, `tests/unit/viewer-launcher.test.ts` | AC-L10, AC-L11, AC-L12, AC-L13, AC-L14, AC-L17 (gate), AC-L18 (gate), AC-L33 (a–e) | `npm test -- tests/unit/viewer-launcher.test.ts` |
| 5 | `handleViewerStart()` accepts a form POST; migrate the pinned GET-only tests | `server/viewer.ts`, `tests/unit/viewer-launcher.test.ts`, `tests/unit/viewer-start.test.ts` | AC-L03, AC-L04, AC-L05, AC-L06, AC-L07, AC-L08, AC-L09, AC-L15, AC-L17, AC-L18, AC-L28, AC-L30 (handler), AC-L31, AC-L32 | `npm test -- tests/unit/viewer-launcher.test.ts tests/unit/viewer-start.test.ts` |
| 6 | Hub glue: gated body read, no fallthrough, migrate the wire test | `server/hub.ts`, `tests/unit/viewer-dispatch.test.ts`, `tests/unit/viewer-surface.integration.test.ts` | AC-L06 (wire), AC-L14 (wire), AC-L18 (wire), AC-L19, AC-L20, AC-L29 | `npm test -- tests/unit/viewer-dispatch.test.ts tests/unit/viewer-surface.integration.test.ts` |
| 7 | `/admin/status.viewer` | `server/admin.ts`, `tests/unit/server-admin.test.ts`, `tests/unit/server-config.test.ts` | AC-L21, AC-L22 | `npm test -- tests/unit/server-admin.test.ts tests/unit/server-config.test.ts` |
| 8 | Admin UI control | `server/admin-html.ts`, `tests/unit/admin-viewer-control.test.ts` (new), `tests/unit/server-admin-page.test.ts` | AC-L23, AC-L24, AC-L25, AC-L26 | `npm test -- tests/unit/admin-viewer-control.test.ts tests/unit/server-admin-page.test.ts` |
| 9 | Operations doc, release notes, spec regeneration | `docs/VIEWER.md`, `README.md`, `CHANGELOG.md`, `docs/specs/2026-11-06-viewer-origin-spec.md` §13, `spec/**` | doc half of all 33 ACs | `npm run spec && npm run spec:check` |
| 10 | Final gate and traceability | none (read-only) | AC-L27 + all 33 re-checked | §6 checklist |

### 3.2 Dependencies

```
1 ──► 2 ──► 4 ──► 5 ──► 6 ──┐
 └──► 3 ──► 5               ├──► 9 ──► 10
 └──► 7 ──► 8 ─────────────┘
```

- 2 → 4 (gates use `launcherFormat`/`launcherOriginBasis`), 3 → 5 (handler renders the page),
  4 → 5 (handler re-runs the gates), 5 → 6 (glue calls the handler), 6 → 7 is not strictly required
  but 7 → 8 is (`renderOverview` reads `status.viewer`).
- Steps 2 and 3 are independent of each other; 7 is independent of 2–6 and may run right after 1.
- Hot files run strictly stacked: `server/viewer.ts` 1 → 2 → 4 → 5; `server/admin-html.ts` 1 → 8;
  `server/hub.ts` 6 only; `tests/unit/viewer-launcher.test.ts` 2 → 4 → 5.

### 3.3 Critical path

`1 → 2 → 4 → 5 → 6 → 9 → 10`. Step 5 is the widest: it is the only step where a legacy contract is
deliberately replaced, and it carries 14 ACs. Step 6 is the only step that touches socket lifetime.

---

### Task 1: Preparation without a behaviour change

**Files:** Create `server/html.ts`; Modify `server/admin-html.ts`, `server/viewer.ts`,
`server/admin-i18n.ts`, `tests/unit/helpers/viewer-harness.ts`, `tests/unit/viewer-session.test.ts`.
**Interfaces:** Produces `escapeHtml(value: string): string` (from `server/html.ts`), the 14
`AdminStrings` keys, `request(url, headers?, method?, body?)` with a `host` default; Consumes
`surfaceOf()` from `server/handler.ts`.
**Depends on:** — · **Size:** M · **Agent:** developer · **Stage:** implement
**ACs:** none directly (produces the strings for AC-L02/L23/L32 and the fixture for AC-L12/L09/L30/L31).

- [x] Step 1: Create `server/html.ts` with the body of `server/admin-html.ts:31-38` unchanged
      (including the single quote) and a JSDoc line naming FR-9.3; `admin-html.ts` imports it and
      deletes the local copy.
- [x] Step 2: Delete the private `surfaceOf()` in `server/viewer.ts:673-675` (and the now-unused
      `Surface`/`SurfaceAwareContext` aliases if nothing else uses them); add `surfaceOf` to the
      existing import from `./handler` (`:42`). The cycle `handler → viewer → handler` is accepted
      (spec RK-L3) — both are function declarations called at request time only.
- [x] Step 3: Add the 14 keys of spec §5.8 to `AdminStrings` and to both `en` and `de`; `de` stays
      typed as `AdminStrings` so a missing translation is a compile error. Extend the file's header
      comment: `{name}` placeholders are now substituted by the page's `fmt()` **and** server-side by
      `fillTemplate()`.
- [x] Step 4: Extend the fixture: `request(url, headers = {}, method = "GET")` returns
      `{ method, url, headers: { host: "127.0.0.1:8787", ...headers }, ...(body === undefined ? {} : { body }) }`
      — the default must yield to an explicit `host` in `headers`.
- [x] Step 5: Re-point `tests/unit/viewer-session.test.ts:142-144` ("falls back to 127.0.0.1 when the
      request carries no Host") at a literal request object (`{ method: "GET", url, headers: {} }`)
      instead of `request()`. The test keeps its subject; only the construction changes.
- [x] Step 6 (green): `npm run typecheck && npx vitest run --maxWorkers=4` — no assertion other than
      the one in step 5 changes. A diff in `dist/` is irrelevant here (`server/` is not in the
      browser bundles).
- [x] Step 7 (refactor): `grep -rn "function escapeHtml" server/` returns exactly one hit;
      `grep -n "function surfaceOf" server/` returns exactly one hit.
- [x] Step 8: commit `refactor(server): extract escapeHtml and import surfaceOf in viewer`, then
      `feat(admin): add the fourteen launcher strings to the admin table`, then
      `test(viewer): default Host and accept a body in the fixture`.

**Verification:** `npm run typecheck && npx vitest run --maxWorkers=4`
**DoD:** One escaper, one `surfaceOf`, 14 keys in both languages, fixture extended additively,
suite green with exactly one adjusted assertion.

---

### Task 2: Pure launcher primitives

**Files:** Modify `server/viewer.ts`; Create `tests/unit/viewer-launcher.test.ts`.
**Interfaces:** Produces `VIEWER_LAUNCHER_MAX_BODY_BYTES`, `VIEWER_LAUNCHER_FIELD`, `LauncherFormat`,
`launcherFormat(accept)`, `launcherOriginBasis(request)`, `launcherSecretFromBody(body)`;
Consumes `ServerRequest`.
**Depends on:** 1 · **Size:** M · **Agent:** developer · **Stage:** implement
**ACs:** AC-L01, AC-L03, AC-L07 (format half), AC-L15, AC-L16, AC-L33 (basis half).

- [x] Step 1 (red): `launcherFormat` cases — browser string → `html`; `*/*`, `text/*`, missing,
      `application/json`, `text/html;q=0` → `json`; `text/html;q=0.5, application/json` → `json`;
      a tie → `html`; `q` unparsable → treated as `1`; `application/xhtml+xml` counts as HTML.
- [x] Step 2 (red): `launcherOriginBasis` cases — `Host` + `X-Forwarded-Proto: https` →
      `https://<host>`; `X-Forwarded-Host` beats `Host`; `X-Forwarded-Host: , hub.example.com` →
      `hub.example.com`; an empty/only-commas forwarded host falls back to `Host`; no host at all →
      `null`; default ports removed (`:80` on http, `:443` on https); `http://a` ≠ `https://a`;
      scheme lowercase; no path/query/fragment/userinfo.
- [x] Step 3 (red): `launcherSecretFromBody` — `secret=a+b` → `a b`; `secret=%zz` stays literal and
      never throws; a duplicate key returns the **first** value; absent → `undefined`; `""` → `""`.
- [x] Step 4: implement the three functions plus the two constants. `URLSearchParams` only — no
      `decodeURIComponent`, no hand-written parser, no trimming, no case folding.
- [x] Step 5 (green): `npm test -- tests/unit/viewer-launcher.test.ts`.
- [x] Step 6: commit `feat(viewer): add launcher format and origin basis helpers`.

**Verification:** `npm test -- tests/unit/viewer-launcher.test.ts`
**DoD:** All three functions total (never throw for any string input), `null` only from
`launcherOriginBasis` when no host can be derived.

---

### Task 3: Launcher page renderer

**Files:** Create `server/launcher-html.ts`; Create `tests/unit/viewer-launcher-page.test.ts`.
**Interfaces:** Produces `renderLauncherHtml(strings: AdminStrings, options: { action: string; error?: string }): string`
and `fillTemplate(template, vars)`; Consumes `AdminStrings` from `./admin-i18n`, `escapeHtml` from
`./html`.
**Depends on:** 1 · **Size:** M · **Agent:** developer · **Stage:** implement
**ACs:** AC-L01, AC-L02, AC-L08 (no echo), AC-L30 (text half), AC-L32 (render half).

- [x] Step 1 (red): structure — exactly one `<input type="password" name="secret" …>`, `autocomplete="off"`,
      `required`, `autofocus`, **no** `value`, a `<form method="post"` with
      `enctype="application/x-www-form-urlencoded"` whose `action` is the passed path (base-prefixed,
      no query), one `<label for="secret">`, one submit button `class="bp-primary"`, `<html lang>` from
      `strings.lang`, `<title>`, `<meta charset>`, `<meta name="viewport">`.
- [x] Step 2 (red): prohibitions — no `<script`, no `on<event>=`, no `<img`, no `<link`, no absolute
      URL in the body; `<style>` only inline, every class `bp-`, every custom property `--bp-*`.
- [x] Step 3 (red): error path — with `error` the block is `<p class="bp-error" role="alert">` placed
      **immediately after the `<h1>`** and before the help paragraph; `autofocus` is still present;
      `<script>` in the error text renders as text (escaped); without `error` no `bp-error` element.
- [x] Step 4 (red): `fillTemplate` — `{seconds}` and `{origin}` substituted; an unknown placeholder
      stays literal (same semantics as the page's `fmt()`); `launcherThrottled` with `{seconds: 300}`
      contains `300` and no `{seconds}` residue, in `en` and `de`.
- [x] Step 5: implement the renderer; keep the CSS block small — the page must stay under 4 KiB.
- [x] Step 6 (green): `npm test -- tests/unit/viewer-launcher-page.test.ts`; assert the rendered
      length of both languages (`< 4096`).
- [x] Step 7: commit `feat(viewer): render the launcher form page`.

**Verification:** `npm test -- tests/unit/viewer-launcher-page.test.ts`
**DoD:** One form, one field, zero JavaScript, zero external resource, every string from
`AdminStrings`, page < 4 KiB.

---

### Task 4: The header-only gates

**Files:** Modify `server/viewer.ts`; Modify `tests/unit/viewer-launcher.test.ts`.
**Interfaces:** Produces `launcherHeadRefusal(request, context): ServerResponse | null` and
`launcherTooLargeAnswer(request, context): ServerResponse`; Consumes `launcherFormat`,
`launcherOriginBasis`, `VIEWER_LAUNCHER_MAX_BODY_BYTES`, `serviceNotReady()`.
**Depends on:** 2 · **Size:** L · **Agent:** senior-developer · **Stage:** implement
**ACs:** AC-L10, AC-L11, AC-L12, AC-L13, AC-L14, AC-L17 (gate), AC-L18 (gate), AC-L33 (a–e).

- [x] Step 1 (red): method gate — `GET`/`POST` → `null`; `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`
      → `405`, `allow: "GET, POST"`, `connection: close`, format per `Accept`. Assert it runs before
      the origin check (an unresolved origin plus `PUT` is still `405`).
- [x] Step 2 (red): origin gate — `viewer.origin` undefined/empty → `503` `service_not_ready` with
      `retry-after: 1`, `connection: close`, **JSON even for an HTML `Accept`**.
- [x] Step 3 (red): CSRF gate (POST only) — `Origin` present and ≠ basis → `403 forbidden_origin`;
      `Origin: null` → `403`; `Origin: https://a.example, https://b.example` → `403` (not parsed);
      no `Origin` → `null`; `Sec-Fetch-Site: cross-site` → `403` even without `Origin`; the body and
      the headers never repeat the rejected value. GET is never gated.
- [x] Step 4 (red): media type — only when a body is declared (`content-length > 0` or
      `transfer-encoding`): `content-type` after `;`-split/trim/lowercase must be exactly
      `application/x-www-form-urlencoded`, a `charset` must be `utf-8`, else `415`; a `content-type:
      application/json` **without** a declared body passes (the admin button case).
- [x] Step 5 (red): size — a parseable `content-length > 8192` → `413 payload_too_large` from
      `launcherTooLargeAnswer()`, `connection: close`, no read, no secret check.
- [x] Step 6: implement both functions. Every returned response carries `connection: close`; the
      function reads headers and `context` only — no `verifyOperatorSecret()`, no `tickets`.
- [x] Step 7 (green): `npm test -- tests/unit/viewer-launcher.test.ts`.
- [x] Step 8: commit `feat(viewer): gate the launcher before the secret`.

**Verification:** `npm test -- tests/unit/viewer-launcher.test.ts`
**DoD:** Five statuses, each with its header set, all six cases of the `Origin` gate, total and
side-effect free.

---

### Task 5: `handleViewerStart()` accepts a form POST

**Files:** Modify `server/viewer.ts`; Modify `tests/unit/viewer-launcher.test.ts`,
`tests/unit/viewer-start.test.ts`.
**Interfaces:** Produces the extended `handleViewerStart(request, context)` (same signature; reads
`request.body`); Consumes `launcherHeadRefusal`, `launcherSecretFromBody`, `launcherFormat`,
`renderLauncherHtml`, `verifyOperatorSecret`, `tickets.mint()`, `ADMIN_STRINGS` + `adminLanguage`.
**Depends on:** 3, 4 · **Size:** L · **Agent:** senior-developer · **Stage:** implement
**ACs:** AC-L03, AC-L04, AC-L05, AC-L06, AC-L07, AC-L08, AC-L09, AC-L15, AC-L17, AC-L18, AC-L28,
AC-L30 (handler level), AC-L31, AC-L32.

- [x] Step 1 (red): GET matrix — HTML `Accept` without a secret → `200` page, `throttle.allow` never
      called; `*/*` and no `Accept` → `401` JSON unchanged; `?k=` correct and header correct → `302`,
      `referrer-policy: no-referrer`, `cache-control: no-store`, no `set-cookie`; wrong `?k=` → `401`
      HTML with `launcherInvalidSecret` and no echo of the value.
- [x] Step 2 (red): POST matrix — valid body → `303` (html) / `200 {"url": …}` (json), exactly one
      mint, no `location` on the JSON branch; wrong body → `401` per format, one `failure`; missing,
      empty, empty body, or **only** `?k=` → `401` with `allow`/`failure`/`success` never called.
- [x] Step 3 (red): precedence — the header wins over a wrong body value (`success`, no `failure`);
      a duplicate field uses the first value; `secret=a+b` vs. `a b` → `303`; `secret=%zz` → `401`,
      never `500`.
- [x] Step 4 (red): answer headers — HTML responses carry `x-frame-options: DENY`, the exact CSP of
      spec §6, `referrer-policy: no-referrer`, `cache-control: no-store`; `405` carries `allow:
      "GET, POST"`; `429` carries `retry-after` from the verdict (assert `"300"`) and the HTML body
      carries `300` with no `{seconds}` residue; `401`/`429`/`200`/`303` carry **no**
      `connection: close`.
- [x] Step 5 (red): secret-never-in-a-response sweep (AC-L28) — over every answer of steps 1–4,
      assert `location` matches `^https://view\.example\.com/bluepencil/api/viewer\?ticket=[0-9a-f]{48}$`,
      no response body and no `set-cookie` contains the secret — **including the answers to `?k=`
      GETs**; the request URL itself is out of scope.
- [x] Step 6 (red): no-operator-secret hub (AC-L31) and German error re-render (AC-L32, with
      `role="alert"` and `autofocus`).
- [x] Step 7: implement the rewritten handler in the spec §5.1 rule 2 order. `?k=` is read on `GET`
      only. Keep `json()`/`text()`/`refusal()` local; add the HTML answer helper once.
- [x] Step 8: migrate `tests/unit/viewer-start.test.ts` — the method-gate loop becomes
      `PUT`/`PATCH`/`DELETE`/`HEAD`/`OPTIONS` → `405` with `allow: "GET, POST"`, and the start-window
      case (`:214-226`) runs with `PUT` **and** `DELETE` (a `POST` there is now `503`). Add the
      rewritten "POST with a valid header is 303, no longer 405" assertion.
- [x] Step 9 (green): `npm test -- tests/unit/viewer-launcher.test.ts tests/unit/viewer-start.test.ts`
      and then `npx vitest run tests/unit/viewer-*.test.ts` (the fixture change from task 1 may
      surface in other viewer suites).
- [x] Step 10: commit `feat(viewer): accept a form POST on the launcher`.

**Verification:** `npm test -- tests/unit/viewer-launcher.test.ts tests/unit/viewer-start.test.ts`
**DoD:** 3 answer families (page / redirect / JSON), one mint, one budget, no echo, no `?k=` on POST,
handler is still synchronous and pure.

---

### Task 6: The glue reads the body — once, gated, and never falls through

**Files:** Modify `server/hub.ts`; Modify `tests/unit/viewer-dispatch.test.ts`,
`tests/unit/viewer-surface.integration.test.ts`.
**Interfaces:** Produces the launcher block in `respond()` (gates → optional `readBody()` → handler);
Consumes `launcherHeadRefusal`, `handleViewerStart`, `readBody(request, limit)`,
`BodyTooLargeError`.
**Depends on:** 5 · **Size:** L · **Agent:** senior-developer · **Stage:** implement
**ACs:** AC-L06 (wire), AC-L14 (wire), AC-L18 (wire), AC-L19, AC-L20, AC-L29.

- [x] Step 1 (red): extend the wire helper (`viewer-dispatch.test.ts:92-119`) with `body?: string`
      (sets `content-length`) and add `urlencoded(fields)` (sets `content-type` and `content-length`).
- [x] Step 2 (red): form body → `303` with the ticket location; declared `content-length: 9000` and
      **no** body written → `413` with a fully read answer and `connection: close`; `chunked` 9000
      bytes → **no answer**, the client sees a premature end (`ECONNRESET`).
- [x] Step 3 (red): POST during the start window → `503`; POST with a valid header and no body → `303`
      (the admin-button shape, no 415/413 rule fires); `GET`/`POST` without `--viewer` → `404`;
      `GET`/`POST` on the viewer surface → `404` (one added case in
      `viewer-surface.integration.test.ts`).
- [x] Step 4 (red): shared budget over the wire, both directions — ten wrong launcher POSTs then
      `GET /admin/status` with a correct header → `429`; and ten wrong `/admin/status` attempts then a
      launcher POST with a correct body → `429`. Each case starts its own hub, so the throttle state
      is fresh (the throttle is created per `startHub()`).
- [x] Step 5: implement the block in `respond()` in this exact order: build the `ServerRequest` →
      `launcherHeadRefusal()` → if non-null `write()` and **return** → if `POST` and a body is
      declared (`content-length > 0` or `transfer-encoding`) `await readBody(request, VIEWER_LAUNCHER_MAX_BODY_BYTES)`,
      on any throw `if (!response.writableEnded && !response.destroyed) response.end(); return;` →
      `handleViewerStart({ ...request, body }, context)` → `write()` and **return**. A `null` from the
      handler after a read is a programming error: end the response and return, never fall through.
      Add the mandated comment `// The launcher answers or consumes the body itself and returns; it
      never falls through to the journal, the static site, earlyRefusal() or the router's readBody().`
- [x] Step 6: migrate the legacy block `viewer-dispatch.test.ts:366-395` — the POST with
      `x-bluepencil-admin` now expects `303` + `location`, and the `Allow` assertion moves to a `PUT`
      case (`405`, `allow: "GET, POST"`, `connection: close`).
- [x] Step 7: re-run `viewer-startup.integration.test.ts` and `viewer-session.integration.test.ts`
      (they drive the launcher with a header and expect `302`) — no drift tolerated.
- [x] Step 8 (green): `npm test -- tests/unit/viewer-dispatch.test.ts tests/unit/viewer-surface.integration.test.ts`
      then `npx vitest run tests/unit/viewer-*.test.ts tests/unit/server-*.test.ts`.
- [x] Step 9: commit `feat(hub): read the launcher body with the shared reader`.

**Verification:** `npm test -- tests/unit/viewer-dispatch.test.ts tests/unit/viewer-surface.integration.test.ts`
**DoD:** Exactly one `readBody` call on the launcher path, no answer on a broken stream, no second
read on any socket, all four wire outcomes (`303`, `413`, no-answer, `404`) observed.

---

### Task 7: `/admin/status` reports the viewer

**Files:** Modify `server/admin.ts`; Modify `tests/unit/server-admin.test.ts`,
`tests/unit/server-config.test.ts`.
**Interfaces:** Produces `statusPayload().viewer: { enabled: boolean; origin: string | null }`;
Consumes `context.viewer`.
**Depends on:** 1 (independent of 2–6) · **Size:** S · **Agent:** developer · **Stage:** implement
**ACs:** AC-L21, AC-L22.

- [x] Step 1 (red): with a viewer context → `viewer.enabled === true` and `viewer.origin` equal to the
      resolved origin (no trailing slash); without `--viewer` → exactly `{enabled:false, origin:null}`
      (the key exists, it is not `undefined`); in the start window → `{enabled:true, origin:null}`.
- [x] Step 2 (red): `/config` (credential-free) has no `viewer` key at all, with and without
      `--viewer`.
- [x] Step 3: add the field to `statusPayload()` as the last key, with the spec's comment (never a
      secret, never a ticket, deliberately absent from `/config`).
- [x] Step 4 (green): `npm test -- tests/unit/server-admin.test.ts tests/unit/server-config.test.ts`.
- [x] Step 5: commit `feat(admin): report the viewer on the admin status`.

**Verification:** `npm test -- tests/unit/server-admin.test.ts tests/unit/server-config.test.ts`
**DoD:** Three states stable, `/config` untouched, no other payload key changed.

---

### Task 8: The admin control

**Files:** Modify `server/admin-html.ts`; Create `tests/unit/admin-viewer-control.test.ts`;
Modify `tests/unit/server-admin-page.test.ts`.
**Interfaces:** Produces `#viewer-row`, `#open-viewer`, `#viewer-status`, `#viewer-note`,
`renderOverview()`'s `ready` computation, `call(path, init, accept)`, `openViewer()`; Consumes
`status.viewer`, `T.launcherSubmit|launcherViewerOff|launcherViewerPending|launcherViewerAt|launcherOpening|launcherError`.
**Depends on:** 1, 7 · **Size:** L · **Agent:** senior-developer · **Stage:** implement
**ACs:** AC-L23, AC-L24, AC-L25, AC-L26.

- [x] Step 1 (red): markup — the four ids exist inside `#panel-overview`, before `#overview-card`;
      the button is `type="button"` with `class="bp-primary"` and `aria-describedby="viewer-note"`;
      `#viewer-status` is `role="status"` with `aria-live="polite"`.
- [x] Step 2 (red): `renderOverview()` — starts with `var viewer = status.viewer || { enabled: false, origin: null };`,
      computes `var ready = viewer.enabled === true && typeof viewer.origin === "string" && viewer.origin !== "";`
      exactly once, sets `disabled = !ready`, and fills `#viewer-note` in **all three** states
      (`launcherViewerOff`, `launcherViewerPending`, `fmt(T.launcherViewerAt, {origin})`). No state
      ever prints `null` and no state leaves the note empty. A missing `status.viewer` (a 0.14.0 hub)
      must not throw.
- [x] Step 3 (red): activation — one `fetch` at `{base}/viewer/start`, `POST`, header
      `x-bluepencil-admin`, `accept: application/json`, **no** body, **no** `x-bluepencil-auth`;
      then `location.assign(body.url)`. In the two disabled states a click fires **no** `fetch`.
- [x] Step 4 (red): error paths — `401`, `403`, `429`, `503` and a `TypeError` from `fetch` each set
      `#viewer-status` with `data-kind="error"` and the server/`launcherError` message, never
      navigate, and restore `disabled = !ready`; no automatic retry.
- [x] Step 5: implement `call(path, init, accept)` (the `accept` argument sets
      `accept: application/json`; `x-bluepencil-auth` is skipped when the path contains `/admin`
      **or** `/viewer/start`), the markup, the `ready` block and `openViewer()`. During the request:
      `disabled = true` and `say('viewer-status', T.launcherOpening, 'busy')`; on success there is
      **no** restore (the document navigates away).
- [x] Step 6: extend `tests/unit/server-admin-page.test.ts` — 14 keys present in `en` and `de`, no raw
      key on the page, the four new ids in the documented-id test.
- [x] Step 7: do **not** touch the tablist block (`server/admin-html.ts:572-650`); verify with
      `git diff -U0 server/admin-html.ts` that no hunk touches `activateTab`, `role="tab"` or the
      arrow/Home/End handler.
- [x] Step 8 (green): `npm test -- tests/unit/admin-viewer-control.test.ts tests/unit/server-admin-page.test.ts`.
      Note: JSDOM does not implement navigation — stub `window.location.assign` (define it on the
      window before `runScripts` executes) and assert the call, not a navigation.
- [x] Step 9: commit `feat(admin): open the viewer from the overview panel`.

**Verification:** `npm test -- tests/unit/admin-viewer-control.test.ts tests/unit/server-admin-page.test.ts`
**DoD:** Three states with a true sentence each, one request per activation, one credential per
request, no navigation on any error, tablist diff empty.

---

### Task 9: Operations doc, release notes, spec regeneration

**Files:** Modify `docs/VIEWER.md`, `README.md`, `CHANGELOG.md`,
`docs/specs/2026-11-06-viewer-origin-spec.md`; regenerate `spec/**`.
**Interfaces:** Produces the operator-facing truth for the launcher, the CSRF/proxy contract and the
admin entry; Consumes the implemented behaviour of tasks 1–8.
**Depends on:** 6, 8 · **Size:** M · **Agent:** technical-writer · **Stage:** document
**ACs:** the doc half of all 33 (spec §10); no new AC.

- [x] Step 1: `docs/VIEWER.md` routes matrix (`:101-119`) — replace row 1 with two rows (`GET`:
      `200` form without a secret, `302` with one; `POST`: `303`, or `200 {"url"}` for
      `Accept: application/json`) and a note that `405` carries `Allow: GET, POST`.
- [x] Step 2: `docs/VIEWER.md:154-156` — delete "The launcher is `GET`-only" and reformulate the
      missing-secret sentence: a **missing** secret is `200` with the form for an HTML-preferring
      client and `401` JSON for everything else; **both** spend no `admin` budget; only a wrong value
      counts. Add the 8 KiB body limit and the `Origin`/`Sec-Fetch-Site` gate to the launcher section.
- [x] Step 3: `docs/VIEWER.md:239`/`:251` — `proxy_set_header Host $host;` → `$http_host;` in both
      blocks, plus one sentence: without `Host` and `X-Forwarded-Proto` the CSRF basis is
      `http://<upstream>` and a browser behind TLS gets a fail-closed `403` on **both** the form and
      the admin button.
- [x] Step 4: `README.md:40` and the operator-entry paragraph — the form is the browser entry, the
      header and `?k=` are the script entries (`?k=` remains the named exception).
- [x] Step 5: `CHANGELOG.md` — `Added` (launcher form, `/admin/status.viewer`, admin control),
      `Security` (secret in the body instead of the URL, `Origin`/`Sec-Fetch-Site` gate,
      `frame-ancestors`/`DENY`, 8 KiB limit), `Changed` (`Allow: GET, POST`, `?k=` stays, not
      deprecated). No release head.
- [x] Step 6: one sentence in `docs/specs/2026-11-06-viewer-origin-spec.md` §13 stating that the
      addendum is the authoritative list of superseded statements. Nothing else in that file.
- [x] Step 7: `npm run spec` (regenerate from `docs/REQUIREMENTS.md`), then `npm run spec:check`.
      `spec/06-storage/requirements.md` must then contain FR-6.26–FR-6.30 and the revised FR-6.21.
      **Never** hand-edit `spec/**`.
- [x] Step 8: commit `docs: document the launcher form and the admin entry`, then
      `docs(spec): regenerate the reqmd spec`.

**Verification:** `npm run spec && npm run spec:check`
**DoD:** No sentence in `docs/VIEWER.md` or `README.md` contradicts the spec; `spec/**` is a pure
generator diff; the `$http_host` contract is stated with its failure mode.

---

### Task 10: Final gate and traceability

**Files:** none (read-only).
**Interfaces:** Consumes tasks 1–9; Produces the completion verdict.
**Depends on:** 9 · **Size:** S · **Agent:** validator · **Stage:** validate-and-document
**ACs:** AC-L27 plus a re-check of all 33.

- [x] Step 1: run the full §6 checklist and record every command's result.
- [x] Step 2: AC-L27 — `git diff --stat package.json` shows no `dependencies` line; `npm run build`
      produces no new artefact; `npm run size` shows the four budgets unchanged.
- [x] Step 3: `grep -rn "from \"\.\./server" src/` and `grep -rn "from \"\.\./\.\./server" src/`
      return nothing (C9).
- [x] Step 4: traceability — each of the 33 ACs has one green step and at least one test or a
      documented "review/CI" marking (§4.2). No open checkbox.
- [x] Step 5: verdict `APPROVED` or `CHANGES_REQUESTED`; a critical/major finding blocks the hand-off
      to `release`.

**Verification:** `npm run typecheck && npx vitest run --maxWorkers=4 && npm run build && npm run spec:check`
**DoD:** 33/33 ACs traced, every gate green, no new dependency, no bundle growth.

## 4. Test order and the AC → test mapping

### 4.1 Which test file appears in which step

| Step | File | Created/changed | Covers |
|---|---|---|---|
| 1 | `tests/unit/helpers/viewer-harness.ts` | changed (additive) | fixture for AC-L09/L12/L30/L31 |
| 1 | `tests/unit/viewer-session.test.ts` | changed (one case) | keeps the "no Host" subject |
| 2 | `tests/unit/viewer-launcher.test.ts` | **created** | AC-L01/L03/L07/L15/L16/L33 (primitives) |
| 3 | `tests/unit/viewer-launcher-page.test.ts` | **created** | AC-L01/L02/L08/L30/L32 (renderer) |
| 4 | `tests/unit/viewer-launcher.test.ts` | changed | AC-L10/L11/L12/L13/L14/L17/L18/L33 (gates) |
| 5 | `tests/unit/viewer-launcher.test.ts` | changed | AC-L03…L09/L15/L17/L18/L28/L30/L31/L32 |
| 5 | `tests/unit/viewer-start.test.ts` | changed | AC-L17/L18 (migrated contract) |
| 6 | `tests/unit/viewer-dispatch.test.ts` | changed | AC-L06/L14/L18/L19/L29/L30 (wire) |
| 6 | `tests/unit/viewer-surface.integration.test.ts` | changed (one case) | AC-L20 |
| 7 | `tests/unit/server-admin.test.ts`, `server-config.test.ts` | changed | AC-L21/L22 |
| 8 | `tests/unit/admin-viewer-control.test.ts` | **created** | AC-L23/L24/L25/L26 |
| 8 | `tests/unit/server-admin-page.test.ts` | changed | AC-L02/L23 (keys, ids) |

### 4.2 AC → test (complete, 33 rows)

| AC | Green in | Test file | Proposed test name |
|---|---|---|---|
| AC-L01 | 3 + 5 | `viewer-launcher-page.test.ts`, `viewer-launcher.test.ts` | `renders one password field, a post form and no script` / `answers 200 html without spending the budget` |
| AC-L02 | 3 + 8 | `viewer-launcher-page.test.ts`, `server-admin-page.test.ts` | `renders the German page with lang de and no raw key` / `ships the fourteen launcher strings in both languages` |
| AC-L03 | 2 + 5 | `viewer-launcher.test.ts` | `answers 401 json for an Accept that does not ask for html` |
| AC-L04 | 5 | `viewer-launcher.test.ts` | `answers 302 with a 48-hex ticket for a valid query and for a valid header` |
| AC-L05 | 5 | `viewer-launcher.test.ts` | `answers 401 html with the invalid message and no echo for a wrong query` |
| AC-L06 | 5 + 6 | `viewer-launcher.test.ts`, `viewer-dispatch.test.ts` | `answers 303 with one mint and no set-cookie for a valid form body` / `answers 303 for a form body over the wire` |
| AC-L07 | 2 + 5 | `viewer-launcher.test.ts` | `answers 200 with the url for a valid body and a json Accept` |
| AC-L08 | 3 + 5 | `viewer-launcher.test.ts`, `viewer-launcher-page.test.ts` | `answers 401 per format for a wrong body and counts one failure` / `escapes an error message instead of rendering it` |
| AC-L09 | 5 | `viewer-launcher.test.ts` | `answers 401 for a missing, empty or query-only secret without touching the budget` |
| AC-L10 | 4 | `viewer-launcher.test.ts` | `answers 403 forbidden_origin for a foreign Origin without touching ticket or budget` |
| AC-L11 | 4 | `viewer-launcher.test.ts` | `answers 403 for cross-site fetch metadata without an Origin` |
| AC-L12 | 4 | `viewer-launcher.test.ts` | `answers 303 for a POST without an Origin when a Host is present` |
| AC-L13 | 4 | `viewer-launcher.test.ts` | `answers 415 for a declared body with a json content-type` |
| AC-L14 | 4 + 6 | `viewer-launcher.test.ts`, `viewer-dispatch.test.ts` | `answers 413 for a declared content-length above the limit` / `answers 413 for 9000 declared bytes and reads the answer` |
| AC-L15 | 2 + 5 | `viewer-launcher.test.ts` | `keeps the first duplicate field and lets the header win over a wrong body` |
| AC-L16 | 2 + 5 | `viewer-launcher.test.ts` | `decodes + as space and keeps an invalid escape literal without a 500` |
| AC-L17 | 4 + 5 + 6 | `viewer-launcher.test.ts`, `viewer-start.test.ts`, `viewer-dispatch.test.ts` | `answers 405 with allow GET, POST for PUT, PATCH, DELETE, HEAD and OPTIONS` |
| AC-L18 | 4 + 5 + 6 | `viewer-launcher.test.ts`, `viewer-start.test.ts`, `viewer-dispatch.test.ts` | `answers 503 for GET and POST while the origin is unresolved` / `answers 405 for PUT and 503 for POST during the start window` |
| AC-L19 | 6 | `viewer-dispatch.test.ts` | `answers 404 for GET and POST on a hub without a viewer` |
| AC-L20 | 6 | `viewer-surface.integration.test.ts` | `refuses GET and POST on the viewer surface with 404` |
| AC-L21 | 7 | `server-admin.test.ts`, `server-config.test.ts` | `reports viewer enabled and its origin` / `carries no viewer field on the credential-free config` |
| AC-L22 | 7 | `server-admin.test.ts` | `reports the disabled viewer as enabled false and origin null` |
| AC-L23 | 8 | `admin-viewer-control.test.ts` | `disables the control and explains why in all three states` |
| AC-L24 | 8 | `admin-viewer-control.test.ts` | `posts once with the admin header only and assigns the returned url` |
| AC-L25 | 8 | `admin-viewer-control.test.ts` | `shows the server message and re-enables the button on every error` |
| AC-L26 | 8 + 10 | `admin-viewer-control.test.ts` | `keeps the new control in the overview panel's document order`; **tablist parity: no unit test — verified by review (`git diff` of `admin-html.ts:572-650` is empty)** |
| AC-L27 | 10 | — | **no unit test — verified by CI**: `npm run build`, `git diff --stat package.json`, `npm run size` |
| AC-L28 | 5 | `viewer-launcher.test.ts` | `puts no secret into any location, response body or set-cookie` |
| AC-L29 | 6 | `viewer-dispatch.test.ts` | `cuts the socket without an answer for a chunked 9000-byte body` |
| AC-L30 | 3 + 5 + 6 | `viewer-launcher.test.ts`, `viewer-launcher-page.test.ts`, `viewer-dispatch.test.ts` | `takes retry-after and the message seconds from one verdict` / `substitutes the throttle seconds in both languages` / `shares the admin budget in both directions` |
| AC-L31 | 5 | `viewer-launcher.test.ts` | `answers 401 without a budget when the hub has no operator secret` |
| AC-L32 | 3 + 5 | `viewer-launcher.test.ts`, `viewer-launcher-page.test.ts` | `answers 401 in German with role alert and autofocus` |
| AC-L33 | 2 + 4 | `viewer-launcher.test.ts` | `accepts the proxy topology, the loopback topology and the first non-empty forwarded host` |

**Summary:** 31 of 33 ACs have at least one unit/integration test; AC-L26 is partial (control
reachability tested, tablist parity by review), AC-L27 is CI-only. The spec's own exclusions
(true browser submit, `location.assign()` navigation, `disabled` optics, `autofocus` focus
behaviour) remain untested by design (spec §9, last paragraph).

## 5. Risk register

| ID | Risk | Probability | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **Double body read / fallthrough in the glue.** If the launcher block reads the body and then lets control continue, the router's `readBody()` reads a consumed socket and the request hangs. | Medium | High | C4 + the mandated comment at the call site; `readBody` appears exactly once in the block; `viewer-dispatch.test.ts` covers form body, declared 413 and chunked abort end-to-end; a review grep for `readBody(` returns two call sites only (launcher block + router). |
| R2 | **`connection: close` on the wrong answers.** Missing on a 403/415/413 keeps a socket with unread bytes alive; present on a 303 kills a connection needlessly and can drop the answer of a following request. | Medium | Medium | C5 makes the rule coarser than needed (all five statuses always, the other four never); each status is asserted in `viewer-launcher.test.ts`; the 413 case additionally asserts a fully read answer. |
| R3 | **Throttle testability without a reset API.** `AdminThrottle` has no `retryAfterSeconds` and no reset; a test cannot ask for "a fresh budget" directly. | High (certain) | Low | `startHub()` creates one throttle per hub, so every integration test starts with an empty budget (keyed by peer + kind, `maxFailures: 10`, `windowMs: 300000`). At handler level use an injected fake (`allow`/`failure`/`success` as `vi.fn()`), never a stubbed seconds value — the seconds must stay the verdict's `300`. |
| R4 | **Bundle budget.** IIFE 44.2/45 kB, element 47.0/48 kB (min+gzip). A launcher HTML helper could be dragged into a browser bundle. | Low | High | The launcher is server-only: `scripts/build.mjs` bundles `src/**` plus a **separate, ungated** `server/index.ts` bundle; `scripts/size-guard.mjs` gates only `dist/bluepencil.core.js`, `attach.js`, `bluepencil.iife.js`, `bluepencil.element.js`. C9 forbids `src/** → server/**` imports; task 10 checks it with grep and `npm run size`. Verified today: no `src/**` file imports `server/**`. |
| R5 | **Fixture `host` default changes an existing assertion.** `viewer-session.test.ts:142-144` asserts the "no Host" fallback through the fixture. | High (certain) | Low | Task 1 step 5 re-points exactly that one case at a literal request object; the spec's default (RVW2-4) is otherwise untouched. |
| R6 | **Two tests pin the old GET-only contract.** `viewer-start.test.ts:191-227` and `viewer-dispatch.test.ts:366-395` fail as soon as POST is accepted, so a step boundary would be red. | High (certain) | Medium | The migration ships in the **same** commit as the behaviour change (task 5 step 8, task 6 step 6). No interim "known red" state. |
| R7 | **CSRF gate breaks a legitimate proxy.** Without `Host`/`X-Forwarded-Proto` (or with nginx's default `$proxy_host`) the basis is `http://<upstream>` and every browser POST is `403`. | Medium | High (both browser entries unusable) | Fail-closed by design; `docs/VIEWER.md` states the two-line contract with `$http_host` and names the `403` as the symptom; the admin button surfaces the message instead of hanging (AC-L25); `?k=` remains the documented exception. |
| R8 | **The admin button trips the 415 rule.** `call()` sends `Content-Type: application/json` even with no body; a media-type rule that does not require a *declared* body would refuse the button. | Medium | Medium | Spec §5.1 rule 6 keys 415/413 to a declared body; AC-L24 asserts the body-less POST; task 4 step 4 has an explicit "json content-type without a declared body passes" case. |
| R9 | **JSDOM navigation.** `window.location.assign` is not implemented; a naive test throws `Not implemented: navigation` and hides the real assertion. | High | Low | Task 8 step 8: redefine `window.location` (or `assign`) inside `beforeParse` before the page script runs, and assert the argument instead of navigating. |
| R10 | **`?k=` creeps back onto POST.** Reusing the GET extraction (header-or-query) in the POST branch silently re-opens the exception path and fails AC-L09/§2.5. | Medium | High (requirement violation) | One extraction function with an explicit `method` branch; AC-L09's "POST with `?k=<correct>` and an empty body is 401" case; review check against spec §5.1 rule 2 step 6. |

## 6. Verification checklist

| # | Command | Expected |
|---|---|---|
| 1 | `npm run typecheck` | exit 0, no output |
| 2 | `npx vitest run --maxWorkers=4` | exit 0 (deterministic; the plain `npm test` is flaky on this host — §1.1.1). Every suite green; the new files `viewer-launcher`, `viewer-launcher-page` and `admin-viewer-control` present; no `skip`/`only` |
| 3 | `npm run build` | exit 0; `dist/` rewritten; **no** new artefact |
| 4 | `npm run size` | the four gated bundles unchanged (IIFE ≤ 45.9 kB, element ≤ 49.1 kB gzip budgets; measured values must not move) |
| 5 | `npm run spec` | exit 0; `spec/06-storage/requirements.md` now contains FR-6.26–FR-6.30 and the revised FR-6.21 |
| 6 | `npm run spec:check` | exit 0 after step 5 |
| 7 | `git diff --stat package.json` | only the version line (if any); **no** `dependencies` entry (AC-L27) |
| 8 | `grep -rn "from \"\.\./server" src/` | no output (C9) |
| 9 | `grep -n "function escapeHtml\|function surfaceOf" server/` | exactly one hit each |
| 10 | `git diff -U0 server/admin-html.ts` (tablist hunk check) | no hunk touches `activateTab`, `role="tab"` or the arrow/Home/End handler |

## 7. Commit strategy — **SUPERSEDED (2026-11-08)**

> **This section is historical and no longer reproducible.** The twelve-commit sequence below assumed
> one commit per green TDD step. The change landed as a **single working state** on
> `feat/viewer-launcher-page`, so the sequence cannot be reconstructed from it: the "red" steps left no
> red commits, and several per-step messages (`refactor(server): extract escapeHtml …`,
> `feat(admin): add the fourteen launcher strings …`) would now be artificial splits of files that
> were already staged together. Validator finding **VAL-6**. The text is kept for traceability and is
> **not** an instruction; the applicable strategy is §7.1.

<details>
<summary>Original twelve-commit table (superseded, do not execute)</summary>

Twelve commits, one per green state, stacked on `feat/viewer-launcher-page`. **No merge commit, no
commit on `main`.** Every message: Conventional Commit, English, imperative, first line ≤ 72 characters.

| # | After step | Message |
|---|---|---|
| 1 | 1 (step 1–2) | `refactor(server): extract escapeHtml and import surfaceOf in viewer` |
| 2 | 1 (step 3) | `feat(admin): add the fourteen launcher strings to the admin table` |
| 3 | 1 (step 4–5) | `test(viewer): default Host and accept a body in the fixture` |
| 4 | 2 | `feat(viewer): add launcher format and origin basis helpers` |
| 5 | 3 | `feat(viewer): render the launcher form page` |
| 6 | 4 | `feat(viewer): gate the launcher before the secret` |
| 7 | 5 | `feat(viewer): accept a form POST on the launcher` |
| 8 | 6 | `feat(hub): read the launcher body with the shared reader` |
| 9 | 7 | `feat(admin): report the viewer on the admin status` |
| 10 | 8 | `feat(admin): open the viewer from the overview panel` |
| 11 | 9 (steps 1–6) | `docs: document the launcher form and the admin entry` |
| 12 | 9 (step 7) | `docs(spec): regenerate the reqmd spec` |

Commit bodies (when needed) state the spec section that justifies a replaced contract — commit 7
is the only one that replaces a documented behaviour ("GET-only") and must say so explicitly.

</details>

### 7.1 Applicable strategy

Both options below start from the same single working state. Constraints that apply to either:
**no merge commit, no commit on `main`**, Conventional Commit, English, imperative, first line ≤ 72
characters, working tree green (`npm run typecheck`, `npx vitest run --maxWorkers=4`, `npm run build`)
at every commit.

**Option (a) — one feature commit (recommended).** The change is one coherent feature with one spec,
one issue and 33 ACs; the files are entangled (`server/viewer.ts` carries the renderer glue, the gates
and the handler; `server/admin-html.ts` carries the escaper extraction *and* the control) and cannot be
split without inventing intermediate states that never existed.

```
feat(viewer): add the browser launcher entry and the admin control (#144)
```

Body: the spec section that replaces a documented behaviour (`docs/specs/2026-11-08-viewer-launcher-entry.md`
§3: the launcher is no longer `GET`-only), the version bump to `0.15.0`, and the `spec/**` regeneration.

**Option (b) — thematic commits, if the history has to stay readable.** Every split must be a state
that actually compiles and passes; where a file belongs to two themes, it goes into the first commit
that needs it. Suggested order:

| # | Message | Content |
|---|---|---|
| 1 | `feat(viewer): accept a form POST on the launcher` | `server/viewer.ts`, `server/launcher-html.ts`, `server/html.ts`, the launcher unit tests and the migrated `viewer-start`/`viewer-dispatch` tests |
| 2 | `feat(admin): open the viewer from the overview panel` | `server/admin.ts`, `server/admin-html.ts`, `server/admin-i18n.ts`, `admin-viewer-control`/`server-admin*` tests |
| 3 | `chore(spec): regenerate the reqmd spec` | `spec/**` only (pure generator diff) |
| 4 | `docs(viewer): document the launcher form and the admin entry` | `docs/VIEWER.md`, `README.md`, `CHANGELOG.md`, `package.json` version, this plan |
| 5 | `test(viewer): cover the launcher wire path and the shared budget` | only if commit 1 had to leave test files behind — otherwise fold into 1 |

Recommendation: **Option (a)**. Option (b) is acceptable only if every intermediate commit is
verified green; a split that produces an unbuildable commit is worse than one honest feature commit.
`spec/**` and the version bump stay in their own commits in either case, so a reviewer can skip the
generated diff.

## 8. Non-goals (from the spec)

- No viewer field in `/config` (credential-free by design) and none in the federation client.
- No change to ticket semantics (TTL 60 s, 48 hex, single use, cap 1024) and none to the viewer
  origin surface (`/viewer`, `/view`, assets, bookmarklet, `notes*`, `sessions`, `bundle`).
- No viewer proxy/SSRF change.
- No `docker-compose.yml` image pin, no `docker/entrypoint.sh`, no `opencode.json`, no extension.
- No new CLI flag (including no flag for a public hub origin) and no new `HubStartupErrorCode`.
- No logout, no session management, no "remember the secret" on the launcher page.
- No `HEAD` support for the launcher (stays `405`).
- No browser/E2E harness for the admin page.
- No rewrite of FR-6.21 in `docs/REQUIREMENTS.md` (already done by `requirements`).
- **No release cut.** Target 0.15.0 is set by `release` in a separate task; this plan stops at the
  green gate in §6.

## 9. Size class and agent tier

| Basis | Count | Class by the project rule (M 3–8 → `developer`, L 9–20 → `senior-developer`) |
|---|---|---|
| Production files (spec §10) | 7 (5 changed + 2 new) | M |
| Test files (incl. the disclosed additions) | 10 (3 new + 7 changed) + 1 fixture | — |
| Doc files | 4 changed + generated `spec/**` | — |
| **Total touched** | **≈ 22** | **L (9–20 at the edge; 22 with `spec/**` counted)** |

**Recommendation: `senior-developer` for the security- and socket-relevant steps (4, 5, 6, 8);
`developer` for the mechanical steps (1, 2, 3, 7); `technical-writer` for step 9; `validator` for
step 10.**

Rationale:
1. The spec's own class is **M** and counts production files only. The project rule counts touched
   files; with tests and docs this change is **L** — one tier above "M → developer".
2. Step 6 changes *socket lifetime* in `respond()`: a wrong branch either hangs a request or serves
   a second body read. That is not a "3–8 file feature"; it is the one place in this change where a
   mistake is invisible in unit tests and visible only on the wire.
3. Step 4/5 implement a security gate (`Origin`/`Sec-Fetch-Site`) on a budgeted credential path. A
   reviewer must be able to check it against spec §5.2 line by line — a `senior-developer` produces
   that traceable diff.
4. The two steps that are genuinely mechanical (task 1 refactor + i18n, task 7 payload field) stay
   with `developer`, so the expensive tier is spent where the risk is, not on a 14-key string table.

If the work must run as one uninterrupted session, assign the whole chain to a single
`senior-developer`; no step requires a fourth tier (`principal-developer`).

## 10. Open points (decisions needed)

- **O-1 — Language of plan artefacts.** This file is English as requested; the sibling
  `2026-11-07-viewer-origin.md` is German, and `AGENTS.md` says internal docs are German. Decide once
  whether `docs/plans/**` is German or English; the file can be translated without touching content.
- **O-2 — Spec's test-file count vs. the mandated fixture change (real contradiction, not a
  preference).** Spec §10 counts **8** touched test files (3 new, 5 changed) plus the fixture.
  Two further files must change for the spec's own requirements to hold:
  (a) `tests/unit/viewer-session.test.ts:142-144` exercises "no Host" **through** the fixture, and
  RVW2-4 mandates a fixture `host` default, so that one case must stop using the fixture;
  (b) AC-L20 names `GET` **and** `POST` on the viewer surface, and the only existing coverage is a
  GET case, so one POST case must be added to `viewer-surface.integration.test.ts` (spec §9 itself
  names that file for AC-L20, §10 does not).
  The plan therefore works with **10** touched test files. This is a bookkeeping correction, no
  behavioural decision; it is reported rather than silently applied. **Recommendation:** accept the
  two additions and note the corrected count in the spec's revision log at the next edit.
- **O-3 — `spec/` is stale.** `docs/REQUIREMENTS.md` carries the revised FR-6.17/FR-6.21 and the new
  FR-6.26–FR-6.30; `spec/` does not: `grep -r "FR-6.26" spec/` finds nothing and
  `spec/06-storage/requirements.md:320-333` still holds the pre-revision FR-6.21 (version 1, text ends
  at "never sees the secret" — no body/`?k=`/new-surface sentences). Step 9 regenerates; until then
  `npm run spec:check` may pass while the content is behind. Listed so the final gate is not mistaken
  for "nothing changed".
- **O-4 — `error` key on the launcher page for `415`/`413`.** Spec §5.8 provides
  `launcherUnsupportedBody` and `launcherBodyTooLarge`; §5.1 rule 7 names `launcherBodyTooLarge`
  explicitly for 413, and the 415 message is implied but not spelled out as a bullet. The plan uses
  `launcherUnsupportedBody` for 415 and `launcherBodyTooLarge` for 413 (the only reading that makes
  both keys reachable). Confirm in review.
- **O-5 — the full test suite is flaky on this host.** 118 workers produce 5 s timeouts and one port
  collision, in different files per run; each failure passes in isolation (§1.1.1). This is not
  caused by this change, but it makes "`npm test` is green" an unreliable gate. Two options:
  (a) gate on `npx vitest run --maxWorkers=4` as documented in §6 (no config change, recommended for
  this plan), or (b) raise `testTimeout` / cap workers in `vitest.config.ts` — a test-config change
  that belongs in its own task with `tester`, not in a launcher feature commit.

Everything else is closed: no new CLI flag, no new error code, no change to `?k=` semantics, no
change to the admin tab model.

## 11. Self-review

- [x] Mandatory template sections present: `**Spec:**`, `## Global Constraints`, `## File
      Structure` (§1.3), `pipeline_stages` frontmatter, `Files:`/`Interfaces:` per task, TDD steps,
      self-review.
- [x] `pipeline_stages` maps stage → step number: `implement: 1` (task 1, `developer`, in the allowed
      set), `document: 9`, `validate-and-document: 10`. No `release` stage — out of scope (§8).
- [x] Every task uses `### Task <n>: <title>`; `Agent:`, `Depends on:` and `Files:` are present, and
      all dependencies point at existing, lower-numbered tasks (acyclic).
- [x] Every task maps to exactly one agent role. No task spans two roles.
- [x] Each of the 33 ACs appears in at least one row of §4.2 with one green step and either a test or
      an explicit "no unit test — verified by review/CI" marking (AC-L26 partial, AC-L27 CI-only).
- [x] Every acceptance criterion in the task list is observable (status, header, header value,
      element id, text content, call count) — no "works correctly".
- [x] No file overlaps inside a step; hot files are stacked (`server/viewer.ts` 1 → 2 → 4 → 5,
      `server/admin-html.ts` 1 → 8, `server/hub.ts` 6 only).
- [x] Each step can be green on its own: the two legacy-contract migrations ship inside the commit
      that changes the behaviour they pin (task 5, task 6), and the one fixture-driven assertion is
      adjusted inside task 1.
- [x] Risk register has 10 entries with probability, impact and a concrete countermeasure, including
      the four risks named in the brief (double read, `connection: close`, throttle testability,
      bundle budget — with the explicit finding that `server/**` is not part of the gated bundles).
- [x] Every commit is Conventional, English, imperative, ≤ 72 characters on the first line; no merge
      commit; no commit on `main`.
- [x] The baseline is recorded with its measured numbers **and** its one known property (a flaky
      full-suite run under 118 workers, green in isolation and under `--maxWorkers=4`); no step is
      allowed to inherit a pre-existing failure.
