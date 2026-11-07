---
type: Plan
status: DRAFT
date: 2026-11-07
topic: viewer-origin
size: XL
target_version: 0.14.0
issue: 140
spec: docs/specs/2026-11-06-viewer-origin-spec.md
spec_id: SPEC-viewer-origin
spec_revision: "2.4"
pipeline_stages:
  implement: 1
  document: 16
  validate-and-document: 21
  release: 20
---

# Viewer-Origin 0.14.0 — Umsetzungsplan

> Status: DRAFT (2026-11-07)
> **Goal:** Der Viewer läuft auf einem zweiten `node:http`-Listener mit eigener Origin, teilt Store, Journal, Sessions und Tickets mit dem Hub, ist auf der Viewer-Fläche fail-closed und bietet dort keine Admin-, MCP-, Journal-, Config- oder `--root`-Fläche.
> **Architecture:** Zwei `HandlerContext`-Views (`surface: "hub" | "viewer"`) aus einem gemeinsamen `baseContext`, zwei Bind-Policies, eine Store-Instanz, ein `persist`-Closure, eine Journal-Instanz, eine Session-/Ticket-Map. Die Surface-Verzweigung ist die eine Sicherheitsgrenze; `hubViewerPathRefusal()` und `viewerSurfaceRefusal()` sind ihre zwei Durchsetzungen.
> **Tech Stack:** TypeScript (strict, ESM), `node:http`, `node:dns` über die bestehende `src/federation/net-policy.ts`, Vitest. Keine neue Runtime-Dependency (NFR-4).
> **Spec:** `docs/specs/2026-11-06-viewer-origin-spec.md` — `spec-id: SPEC-viewer-origin`, Revision 2.4, `Status: APPROVED (2026-11-07)`.
> **Design (Begründungsbeleg, nicht normativ):** `docs/specs/2026-11-06-viewer-origin-design.md`.
> **Zielrelease:** 0.14.0 (0.x-Minor = Breaking-Slot); die konkrete Version setzt `release`.
> **Sprache:** Prosa Deutsch; Identifier, Pfade, Flags, Fehlercodes, AC-IDs und Commands verbatim aus der Spec.
> **Konfliktregel:** Bei Widerspruch zwischen Plan und Spec gewinnt die Spec. Dieser Plan fügt keine AC hinzu und benennt keinen Contract um.

> **Frontmatter-Vertrag (F6-Graph-Validator):** `pipeline_stages` ist eine Stage-ID → Schritt-Nummer (`parse_plan_ref()`/`validate_plan_ref()` lösen über die Task-Übersicht in §4.2 den Agenten auf). Die plan-driven Stage `implement` zeigt auf Schritt 1 (`developer`, in `allowed_agents`). `document`, `validate-and-document` und `release` sind die nachgelagerten Stages. Jeder Task ist in §4.2 genau einer Stage und einem Agent-Tier zugeordnet; jeder Task trägt zusätzlich `**Agent:**`, `**Stage:**`, `**Depends on:**` und `**parallel_group:**`. Die Task-Header folgen dem Muster `### Task <Nummer>: <Titel>`, damit der F6-Parser (`TASK_HEADER_RE`) Datei-Ownership und Abhängigkeiten graphisch prüfen kann.

## 1. Planungsannahmen

- **A1** Die Spec ist ab dem 2026-11-07 eingefroren. Jede inhaltliche Änderung ist ein neuer Freigabestand, kein stiller Plan-Fix.
- **A2** `docs/REQUIREMENTS.md` bekommt den neuen Block erst in Task 16; alle Implementierungs-Tasks zitieren ausschließlich AC-IDs und Spec-Abschnitte.
- **A3** Eine Aufgabe ist eine Merge-Einheit (ein PR oder eine gestapelte PR-Reihe). Gestapelte PRs werden von unten nach oben gemergt.
- **A4** Kein Task benötigt eine neue Runtime-Dependency; `node:dns` bleibt dynamisch importiert (Spec §2.6).
- **A5** `revokedTokens`, `requiredScope`, `verifyToken`, `authSecret`, `adminThrottle`, `presence` und `persist` existieren bereits im `HandlerContext` (`server/handler.ts`), `revokedTokens` wird in `startHub()` als `liveRevoked` erzeugt (`server/hub.ts`). Der Plan erweitert diese Felder additiv, er erfindet sie nicht.
- **A6** `buildViewDocument()` und der `<meta>`-CSP-Strip liegen bereits in `server/viewer.ts`; Task 1 sichert sie regressiv ab, Task 7 ergänzt nur die Origin-/SSRF-/Launcher-Semantik.
- **A7** Integrationstests beobachten Verhalten, das in den Implementierungswellen entsteht. Sie sind Verifikations-Tasks: ein roter Lauf ist ein Finding an den besitzenden Implementierungs-Task und blockiert das Wellen-Gate; er wird nicht durch eine Test-Abschwächung „grün“ gemacht.
- **A8** Die Datei-Ownership ist disjunkt innerhalb jeder Parallelgruppe. Hot Files (`server/viewer.ts`, `server/handler.ts`, `server/hub.ts`) laufen strikt gestapelt.
- **A9** `tests/unit/viewer.test.ts` gehört Task 1. Spätere Tasks legen eigene Testdateien an und ändern die Fixture nicht.
- **A10** Der Release-Cut setzt die Version; die Spec hängt an keiner Versionsnummer.

## Global Constraints

- **C1** Surface-Verzweigung ist Sicherheitscode: `surfaceOf()` ist total, `authorize()` konsultiert `viewerAuthorized()` auf der Hub-Fläche nie, die Viewer-Fläche ist ohne Client-Credential fail-closed `401` (AC-5.10/5.11).
- **C2** Genau eine Store-Instanz, ein `persist`-Closure, eine `Journal`-Instanz, eine `ViewerSessions`- und eine `ViewerTickets`-Map. Kein zweiter `createFileStore`-Aufruf (Spec §2.4 Regel 3).
- **C3** `revokedTokens` wird als **dieselbe Set-Referenz** in `hubContext` und `viewerContext` getragen, nie kopiert (AC-5.32).
- **C4** Der Viewer-Context enthält strukturell **kein** `adminSecret`, `tokenIssuer`, `revokeToken`, `devicesPath`, `revocationPath`, `root`, `registry`, `federation` (Spec §2.4 Regel 2).
- **C5** `hubViewerPathRefusal()` liegt vor dem `--root`-Static-Fallback; `viewerSurfaceRefusal()` liegt vor Journal/Static/MCP (Spec §2.1 Regel 5/6).
- **C6** Kein `OPTIONS` auf der Viewer-Fläche erreicht `authorize()`; negativer Preflight ist `405` mit `Allow`, nie `401` (Spec §2.1 Regel 11).
- **C7** `viewer.origin` ist vor dem ersten bedienten Request aufgelöst; das Startfenster antwortet `503 service_not_ready` (Spec §2.4 Regel 4/5).
- **C8** Jede Viewer-Session-Ablehnung nutzt `viewerSessionRefusalMessage()`; `{base}/viewer?k=` kommt in keiner Meldung vor (Spec §2.2 Regel 7).
- **C9** `checkTarget()` ist total, wirft nie, prüft Metadata-Hostnamen vor Allowlist/DNS und jeden Redirect-Hop erneut (Spec §4.8).
- **C10** `service_not_ready` ist kein `ERROR_CODES`-Code und wird nie über `glueError()` erzeugt (Spec §2.9).
- **C11** Kein Task schreibt `src/data/**`, `src/core/**`, das Element-Bundle oder die Extension (Spec §1.3).
- **C12** Jeder Commit: `npm run typecheck` grün, `npm test` grün, neue Tests zuerst rot beobachtet (Spec §1.3, AGENTS.md DoD).

## File Structure

### 3.1 Modify

- Modify: `server/admin.ts` — `verifyOperatorSecret()` als einzige Operator-Secret-Prüfung; `adminGate()` darauf umstellen, Antwortcodes unverändert.
- Modify: `server/cors.ts` — `viewerBookmarkletPreflight()`, `viewerBookmarkletCors()`, `responseCorsHeaders()`; Hub-CORS unverändert.
- Modify: `server/viewer.ts` — Tickets, Cookie-Signatur, `viewerSessionRefusalMessage()`, `viewerStartPath()`, `isViewerStartRequest()`, `handleViewerStart()`, `checkTarget()`, `TargetRefusal`, Assets-vor-Session, Proxy-Hop-Prüfung, `handleViewer()`-Surface-/Pfad-Gate.
- Modify: `server/handler.ts` — `HubSurface`, `surfaceOf()`, `normalizeSurfacePath()`, `hubViewerPathRefusal()`, `viewerSurfaceRefusal()`, `authorize()`-Surface-Semantik, Request-Durchreichung für `responseCorsHeaders()`, `gateRequest()`-Reihenfolge.
- Modify: `server/hub.ts` — Viewer-Flags/Env/Validierung, `isWildcardBind()`, `HubStartupError`/`HubStartupErrorCode`, `StartupWarning`-Union, `resolveOptions()`-Viewer-Validierung, `startHub()`-Doppelbind, `RunningViewer`, `RunningServer.viewer`/`close()`, `viewerContext`-Allowlist, `activeJournalForTests()`, `respond()`/`earlyRefusal()`-Dispatch-Gate, Startzeile/Warnungsemission.
- Modify: `tests/unit/viewer.test.ts` — Fixture auf die Ziel-Signaturen umstellen (Task 1).
- Modify: `tests/unit/server-admin.test.ts` — Budgetteilung und „fehlendes Secret verbraucht kein Budget“ (Task 2).
- Modify: `tests/unit/cors.test.ts` — Viewer-Preflight- und Header-Assertions (Task 3).
- Modify: `tests/unit/hub-options.test.ts` — bestehende Hub-Fälle unverändert, Viewer-Flags ergänzt (Task 5).
- Modify: `tests/unit/server-auth.test.ts` — Surface-Autorisierung (Task 6).
- Modify: `tests/unit/server-start.test.ts` — Doppelbind/Lifecycle (Task 9).
- Modify: `docs/REQUIREMENTS.md` — neuer Block FR-6.17+ (IDs/Milestone vergibt `requirements`).
- Modify: `spec/**` — ausschließlich durch `npm run spec` regeneriert, nie handeditieren.
- Modify: `docs/VIEWER.md` — Neufassung (eigene Origin, Launcher, Routen-Matrix, Cookie/TLS, Migration, `--viewer-public-url`-Semantikwechsel).
- Modify: `docs/DOCKER.md` — Viewer-Abschnitt mit zweitem Port, Reverse-Proxy-/TLS-Muster, `BLUEPENCIL_VIEWER_*`.
- Modify: `Dockerfile` — Kommentar/Doku für das Zwei-Port-Muster; `EXPOSE 8787` bleibt.
- Modify: `docker-compose.yml` — optionaler, auskommentierter zweiter Port und `command:`-Beispiel mit `--viewer-origin`.
- Modify: `docker/entrypoint.sh` — Banner-Zeile bei gesetztem `BLUEPENCIL_VIEWER_PORT`; keine Logikänderung am festen `--host 0.0.0.0`.
- Modify: `tests/unit/docker-config.test.ts` — zweiter Port und `command:`-Beispiel (Task 18).
- Modify: `tests/unit/docker-entrypoint.test.ts` — Banner-Zeile (Task 18).
- Modify: `README.md` — Viewer-Blurb auf „eigene Origin“ umstellen, AC-5-Hinweis.
- Modify: `CHANGELOG.md` — `Changed`/`Added`/`Security` für 0.14.0; Release-Kopf in Task 20.
- Modify: `package.json` — nur `version` im Release-Cut (Task 20); keine Script-Änderung.
- Modify: `extension/manifest.json` — nur `version` im Release-Cut (Task 20).

### 3.2 Create

- Create: `tests/unit/helpers/viewer-harness.ts` — gemeinsame Context-, Request-, Resolver- und Fetch-Stubs.
- Create: `tests/unit/admin-secret.test.ts` — `verifyOperatorSecret`.
- Create: `tests/unit/viewer-tickets.test.ts` — Tickets, Cap, Eviction.
- Create: `tests/unit/viewer-session.test.ts` — Cookie, `publicOrigin`, `viewerSessionRefusalMessage`.
- Create: `tests/unit/viewer-cli.test.ts` — CLI-Flags, Env, Alias, Warnungsableitung.
- Create: `tests/unit/viewer-surface.test.ts` — `surfaceOf`, `authorize`, `viewerSurfaceRefusal`, `normalizeSurfacePath`.
- Create: `tests/unit/viewer-cors.test.ts` — `responseCorsHeaders`-Durchreichung, `gateRequest`-Reihenfolge.
- Create: `tests/unit/viewer-ssrf.test.ts` — `checkTarget` (synchron, DNS, Redirect, Metadata).
- Create: `tests/unit/viewer-start.test.ts` — `handleViewerStart`, Launcher, `503`-Startfenster.
- Create: `tests/unit/viewer-lifecycle.test.ts` — `isWildcardBind`, `resolveOptions`, `activeJournalForTests`, Lifecycle-Unit.
- Create: `tests/unit/viewer-dispatch.test.ts` — `respond()`/`earlyRefusal()`-Gate, Startwarnungen, Startzeile.
- Create: `tests/unit/viewer-session.integration.test.ts` — IT-03/04/05/12/13/14/41.
- Create: `tests/unit/viewer-shared.integration.test.ts` — IT-06/07/08/43/44.
- Create: `tests/unit/viewer-proxy.integration.test.ts` — IT-15/16/17/18/29/30/31/32/34/42, RT-01/RT-02.
- Create: `tests/unit/viewer-surface.integration.test.ts` — IT-02/09/10/11/19/20/21/22/28/33, RT-03/RT-04/RT-05/RT-06.
- Create: `tests/unit/viewer-startup.integration.test.ts` — IT-01/23/24/25/26/27/35/36/37/38/39/40/45/46.

### 3.3 Read-only dependencies (keine Schreibrechte)

- `src/federation/net-policy.ts` — `classifyAddress`, `createDnsResolver`, `HostResolver`, `AddressClass`, `METADATA_HOSTNAMES`, `METADATA_ADDRESSES`; keine API-Änderung.
- `server/tokens.ts`, `server/credentials.ts`, `server/mcp.ts`, `server/journal.ts`, `server/presence.ts`, `server/viewer-html.ts`, `server/viewer-bookmarklet.ts` — unverändert konsumiert.
- `src/data/**`, `src/core/**`, `extension/**` — unverändert (Ausnahme: `extension/manifest.json` nur `version` in Task 20).

## 4. Ausführungsmodell

### 4.1 Wellen

| Welle | Inhalt | Tasks | Gate |
|---|---|---|---|
| W0 | Baseline-Fixture und roter Regressionslauf | Task 1 | G0: roter Lauf belegt |
| W1 | Reine Bausteine (Secret, CORS, Viewer-Primitive, CLI) | Task 2–5 | G1: `typecheck` + Unit-Suiten grün, R1 |
| W2 | Routing, Viewer-Door, Doppel-Listener | Task 6–10 | G2: `typecheck` + Unit-/Lifecycle-Suiten grün, R2 |
| W3 | Integrationstests (88 Testfälle vollständig) | Task 11–15 | G3: alle 88 Tests vorhanden und grün, R3 |
| W4 | Requirements, Doku, Docker | Task 16–19 | G4: `spec:check` grün, Doku-Assertions grün, R4 |
| W5 | Release-Cut und finaler Validator | Task 20–21 | G5: `verify`, `secret-scan`, `spec:check`, Preflight, Tag |

### 4.2 Task-Übersicht (Stage, Tier, Schritt)

Die Schritt-Nummer ist der Anker für `pipeline_stages`; die Stage-Spalte ist die Zuordnung aus dem Frontmatter, die Tier-Spalte der erlaubte Agent.

| # | Step | Agent | Stage | Depends on | Size | parallel_group |
|---|---|---|---|---|---|---|
| 1 | Task 1 — Baseline-Fixture und roter Regressionslauf | developer | implement | — | S | W0 |
| 2 | Task 2 — Eine Operator-Secret-Prüfung | developer | implement | 1 | M | W1-A |
| 3 | Task 3 — Viewer-CORS-Primitive | developer | implement | 1 | M | W1-A |
| 4 | Task 4 — Viewer-Primitive: Tickets, Cookie, Origin, Meldung | senior-developer | implement | 1 | L | W1-A |
| 5 | Task 5 — CLI-Flags, Validierung und Warnungsableitung | senior-developer | implement | 1 | L | W1-A |
| 6 | Task 6 — Surface-Autorisierung und die zwei Pfadsperren | senior-developer | implement | 3, 4 | L | W2-A |
| 7 | Task 7 — Viewer-Door: SSRF, Launcher, Assets, Proxy | senior-developer | implement | 2, 4 | XL | W2-A |
| 8 | Task 8 — CORS-Durchreichung und `gateRequest`-Reihenfolge | senior-developer | implement | 3, 6 | L | W2-B |
| 9 | Task 9 — Doppel-Listener, Kontext-Allowlist und Lifecycle | senior-developer | implement | 5, 6, 7 | XL | W2-B |
| 10 | Task 10 — Dispatch-Gate, Startwarnungen und Startzeile | senior-developer | implement | 6, 7, 9 | L | W2-C |
| 11 | Task 11 — Launcher-, Ticket- und Session-Integration | developer | implement | 7, 10 | L | W3-A |
| 12 | Task 12 — Gemeinsamer Store, Journal und Bundle-Parität | developer | implement | 10 | L | W3-A |
| 13 | Task 13 — Proxy, Injection und SSRF-Integration | developer | implement | 7, 10 | L | W3-A |
| 14 | Task 14 — Surface-, CORS-, Host- und `--root`-Integration | developer | implement | 8, 10 | L | W3-A |
| 15 | Task 15 — Startup-, Lifecycle- und CLI-Integration | developer | implement | 5, 10 | L | W3-B |
| 16 | Task 16 — Requirements-Block und Spec-Regeneration | requirements | document | 15 | M | W4-A |
| 17 | Task 17 — `docs/VIEWER.md` Neufassung | technical-writer | document | 15 | M | W4-A |
| 18 | Task 18 — Docker-, Compose- und Entrypoint-Muster | developer | document | 15 | M | W4-A |
| 19 | Task 19 — README und CHANGELOG | technical-writer | document | 15 | S | W4-A |
| 20 | Task 20 — Release-Cut 0.14.0 | release | release | 16, 17, 18, 19 | M | W5 |
| 21 | Task 21 — Finaler Validator (DoD und Traceability) | validator | validate-and-document | 20 | S | W5 |

### 4.3 Parallele Gruppen (nur dateidisjunkt, max. 4)

| Gruppe | Tasks | Bedingung |
|---|---|---|
| W0 | Task 1 | allein |
| W1-A | Task 2, 3, 4, 5 | nach Task 1; `admin.ts` / `cors.ts` / `viewer.ts` / `hub.ts` disjunkt |
| W2-A | Task 6, 7 | nach Task 3/4 bzw. 2/4; `handler.ts` vs. `viewer.ts` |
| W2-B | Task 8, 9 | nach Task 3/6 bzw. 5/6/7; `handler.ts` vs. `hub.ts` |
| W2-C | Task 10 | nach Task 9; `hub.ts` gestapelt |
| W3-A | Task 11, 12, 13, 14 | nach Task 10; vier disjunkte Integrations-Testdateien |
| W3-B | Task 15 | nach Task 10/5; eigene Integrations-Testdatei |
| W4-A | Task 16, 17, 18, 19 | nach Task 15; `REQUIREMENTS`/`VIEWER`/Docker/`README`+`CHANGELOG` disjunkt |
| W5 | Task 20, 21 | sequenziell |

**Nicht parallel:** jede Kette auf einer Hot File — `server/viewer.ts` (Task 4 → 7), `server/handler.ts` (Task 6 → 8), `server/hub.ts` (Task 5 → 9 → 10), `CHANGELOG.md` (Task 19 → 20), `package.json`/`extension/manifest.json` (nur Task 20).

### 4.4 Abhängigkeitsgraph

```
1 → 2, 3, 4, 5
3, 4 → 6
2, 4 → 7
3, 6 → 8
5, 6, 7 → 9
6, 7, 9 → 10
7, 10 → 11
10 → 12
7, 10 → 13
8, 10 → 14
5, 10 → 15
15 → 16, 17, 18, 19
16, 17, 18, 19 → 20 → 21
```

R1 hängt an Task 2–5, R2 an Task 6–10, R3 an Task 11–15, R4 an Task 16–19.

### 4.5 Kritischer Pfad

**Task-Kette:** `1 → 3 → 6 → 8 → 9 → 10 → 15 → 16 → 20 → 21`.

Zulieferer außerhalb des Linienzugs, die vor ihrem Nachfolger grün sein müssen: Task 2/4 (vor 7/9), Task 5 (vor 9), Task 7 (vor 9/10/13), Task 11–14 (vor G3), Task 17–19 (vor 20). Jede Verzögerung auf dem Linienzug verschiebt den Release-Cut; die parallelen Gruppen sind Kalenderpuffer, keine Aufwandsreduktion.

### 4.6 Verifikationsbefehle

| Zweck | Befehl |
|---|---|
| Typen | `npm run typecheck` |
| Alle Tests | `npm test` |
| Einzeldatei | `npm test -- tests/unit/<datei>.test.ts` |
| Build | `npm run build` |
| Bundle-Sync | `npm run verify:sync` |
| Bundle-Budget | `npm run size` |
| Spec erzeugen / prüfen | `npm run spec` / `npm run spec:check` |
| Secret-Scan | `npm run secret-scan` |
| Version-Bump | `npm run check-version-bump` |
| Release-Preflight | `node scripts/release-preflight.mjs --tag v0.14.0 --notes /tmp/notes.md` |
| Gesamt-Gate | `npm run verify` |

## 5. Aufgaben

### Welle 0 — Baseline (Task 1)

### Task 1: Baseline-Fixture und roter Regressionslauf

**Files:**
- Modify: `tests/unit/viewer.test.ts`
- Create: `tests/unit/helpers/viewer-harness.ts`

**Interfaces:** Produces `viewerContext()`, `request()`, `stubResolver()`, `stubFetch()`; Consumes `HandlerContext`, `ViewerOptions`, `ViewerSessions`, `ViewerTickets`, `buildViewDocument`.
**Depends on:** —
**parallel_group:** W0
**Size:** S
**Agent:** developer
**Stage:** implement
**ACs:** AC-5.16, AC-5.25, AC-5.26, AC-5.27, AC-5.28
**Tests:** task-1 — RT-01, RT-02

- [ ] Step 1 (red): `tests/unit/helpers/viewer-harness.ts` anlegen; `viewerContext()` erzeugt `tickets: createViewerTickets()`, `origin`, `hubOrigin`, `surface: "viewer"` und einen injizierbaren `resolver`; `stubResolver()` liefert konfigurierbare Adressen und zählt Aufrufe; `stubFetch()` zählt Fetches und liefert HTML, Redirect oder Fehler.
- [ ] Step 2 (red): `tests/unit/viewer.test.ts` auf die Harness umstellen; die Fixture kompiliert gegen die Ziel-Signaturen und ist bis Task 4/6 rot — der rote Lauf wird im Ledger mit Datei und Fehler festgehalten.
- [ ] Step 3: RT-01 (Allowlist, Injection, `<base>`, absoluter `endpoint`, `<meta>`-CSP-Strip, Session-Cookie) und RT-02 (5-MB-Grenze, 8-s-Timeout, 3 Redirects, Content-Type, `target_unreachable`) als bestehende Verträge unverändert übernehmen; keine Assertion abschwächen.
- [ ] Step 4 (green): `npm test -- tests/unit/viewer.test.ts` beobachtet den roten Stand; Produktionscode unverändert.
- [ ] Step 5 (refactor): Harness-Helper ohne Duplikate in den späteren Suiten konsumierbar machen; keine Produktionsdatei ändern.
- [ ] Step 6: commit `test(viewer): add surface fixture and red regression baseline`

**Verification:** `npm test -- tests/unit/viewer.test.ts`
**DoD:** Harness existiert, RT-01/RT-02 sind vollständig formuliert, der rote Lauf ist belegt, kein Produktionsfile geändert.

---

### Welle 1 — Reine Bausteine (Task 2–5)

**Barriere G1:** Task 2–5 sind gemergt; `npm run typecheck` und die vier Unit-Suiten sind grün; R1 ist abgeschlossen. Erst dann startet W2.

### Task 2: Eine Operator-Secret-Prüfung

**Files:**
- Modify: `server/admin.ts`
- Create: `tests/unit/admin-secret.test.ts`
- Modify: `tests/unit/server-admin.test.ts`

**Interfaces:** Produces `OperatorSecretVerdict`, `verifyOperatorSecret()`; Consumes `adminThrottle.allow/failure/success`, `secretsMatch`-Semantik, `context.adminSecret`.
**Depends on:** 1
**parallel_group:** W1-A
**Size:** M
**Agent:** developer
**Stage:** implement
**ACs:** AC-5.4, AC-5.12, RT-04
**Tests:** task-2 — UT-16, RT-04

- [ ] Step 1 (red): UT-16 in `tests/unit/admin-secret.test.ts` — ok/invalid/missing/throttled; ein fehlendes `presented` verbraucht kein Budget, ein falscher Wert schon; `adminGate()` antwortet weiter `401`/`429` mit `Retry-After: 300`.
- [ ] Step 2 (red): RT-04 in `tests/unit/server-admin.test.ts` ergänzen — fehlendes `x-bluepencil-admin` ist `401` ohne Budgetverbrauch, falsches ist `401` mit Verbrauch, Budgetteilung zwischen `/admin/*` und Launcher.
- [ ] Step 3: `verifyOperatorSecret()` implementieren; `adminGate()` ruft ausschließlich diese Funktion; Antwortcodes und Texte unverändert.
- [ ] Step 4 (green): beide Suiten grün; `npm run typecheck` grün.
- [ ] Step 5 (refactor): Vergleichs- und Budgetlogik in genau einer Funktion halten; keine zweite Kopie.
- [ ] Step 6: commit `fix(server): centralize operator secret verification with shared throttle`

**Verification:** `npm test -- tests/unit/admin-secret.test.ts tests/unit/server-admin.test.ts`
**DoD:** Genau eine Secret-Vergleichsstelle; fehlendes Secret verbraucht kein Budget; `/admin`-Antwortcodes unverändert.

### Task 3: Viewer-CORS-Primitive

**Files:**
- Modify: `server/cors.ts`
- Modify: `tests/unit/cors.test.ts`

**Interfaces:** Produces `viewerBookmarkletPreflight()`, `viewerBookmarkletCors()`, `responseCorsHeaders()`, `PreflightAnswer`; Consumes `ServerRequest`, `HandlerContext`, `surfaceOf()`.
**Depends on:** 1
**parallel_group:** W1-A
**Size:** M
**Agent:** developer
**Stage:** implement
**ACs:** AC-5.21 (Produzent)
**Tests:** task-3 — UT-19, UT-27

- [ ] Step 1 (red): UT-19 — Reflektion, `Allow-Methods` exakt `GET, POST, PATCH, OPTIONS`, `Allow-Headers` enthält `Content-Type, X-Bluepencil-Viewer`, `Max-Age: 600`, `Vary: Origin`, kein `Allow-Credentials`; ungültiger Origin und fehlender `x-bluepencil-viewer`-Requested-Header → `null`; Signatur/Arity ohne `allowMethods`.
- [ ] Step 2 (red): UT-27 — ohne Requested-Header kein Preflight; `OPTIONS` auf einer anderen Route bleibt `null`.
- [ ] Step 3: die drei Funktionen implementieren; `responseCorsHeaders()` liefert auf der Hub-Fläche `corsHeaders(context.cors)` unverändert und auf der Viewer-Fläche nur für `{base}/notes*` und `method !== "OPTIONS"` die reflektierte Kopfzeile.
- [ ] Step 4 (green): `tests/unit/cors.test.ts` grün; Hub-CORS-Assertions unverändert.
- [ ] Step 5 (refactor): Reflektion und Header-Allowlist je genau einmal definieren.
- [ ] Step 6: commit `feat(cors): add viewer bookmarklet preflight and response headers`

**Verification:** `npm test -- tests/unit/cors.test.ts`
**DoD:** Kein `Access-Control-Allow-Credentials`; Hub-CORS byte-gleich; Viewer-`OPTIONS` erhält keine Antwort aus `responseCorsHeaders()`.

### Task 4: Viewer-Primitive: Tickets, Cookie, Origin, Meldung

**Files:**
- Modify: `server/viewer.ts`
- Create: `tests/unit/viewer-tickets.test.ts`
- Create: `tests/unit/viewer-session.test.ts`

**Interfaces:** Produces `VIEWER_TICKET_TTL_SECONDS`, `VIEWER_MAX_TICKETS`, `ViewerTickets`, `createViewerTickets()`, `sessionCookie(token, { ttlSeconds, base, secure })`, `viewerStartPath()`, `viewerSessionRefusalMessage()`, `ViewerOptions.origin/publicBaseUrl/hubOrigin/tickets/hostAliases`, `publicOrigin()`; Consumes `randomBytes`, `HandlerContext`, `ServerRequest`.
**Depends on:** 1
**parallel_group:** W1-A
**Size:** L
**Agent:** senior-developer
**Stage:** implement
**ACs:** AC-5.5 (Unit), AC-5.13, AC-5.24, AC-5.3, AC-5.12 (Meldung), AC-F11 (Unit)
**Tests:** task-4 — UT-10, UT-11, UT-21, UT-35

- [ ] Step 1 (red): UT-11 — 48 Hex-Zeichen, TTL 60 s, atomarer Single-Use, Cap 1024 mit Eviction des ältesten Eintrags, `size()` bereinigt abgelaufene Einträge.
- [ ] Step 2 (red): UT-10 — exakte Cookie-Attribute, `Secure`-Matrix, `Path`-Normalisierung (`/` bei leerem base), kein `Domain`.
- [ ] Step 3 (red): UT-21/UT-35 — `publicOrigin()` liefert explizite Origin unverändert, sonst `X-Forwarded-Proto` nur bei Loopback-Peer; `viewerSessionRefusalMessage()` nennt mit öffentlich erreichbarem `hubOrigin` `{hubOrigin}{base}/viewer/start`, ohne ihn „open the hub launcher“ ohne konstruierte `http://`-URL, nie `{base}/viewer?k=`.
- [ ] Step 4: `createViewerTickets`, neue `sessionCookie`-Signatur, `viewerStartPath`, `viewerSessionRefusalMessage`, `ViewerOptions`-Felder und `publicOrigin()` implementieren; `publicBaseUrl` als deprecated Alias in `resolveOptions` normalisieren (Consumer: Task 9).
- [ ] Step 5 (green): beide Suiten grün; alle bestehenden `sessionCookie`-Aufrufer im Server kompilieren.
- [ ] Step 6 (refactor): Cookie-Bau und Origin-Ableitung je einmal zentralisieren.
- [ ] Step 7: commit `feat(viewer): add one-time tickets, secure cookie and launcher message`

**Verification:** `npm test -- tests/unit/viewer-tickets.test.ts tests/unit/viewer-session.test.ts`
**DoD:** Cookie-Vertrag exakt; Ticket-Cap und Single-Use belegt; keine Viewer-Meldung enthält `{base}/viewer?k=`.

### Task 5: CLI-Flags, Validierung und Warnungsableitung

**Files:**
- Modify: `server/hub.ts`
- Modify: `tests/unit/hub-options.test.ts`
- Create: `tests/unit/viewer-cli.test.ts`

**Interfaces:** Produces `ViewerListenOptions`, `isWildcardBind()`, `HubStartupErrorCode`, `HubStartupError`, `StartupWarning`-Union, `parseHubArgs()`-Viewer-Flags/Env, `startupWarnings()`-Viewer-Eingabe; Consumes `get()`/`VALUED_FLAGS`, `DEFAULT_HOST`, `DEFAULT_PORT`.
**Depends on:** 1
**parallel_group:** W1-A
**Size:** L
**Agent:** senior-developer
**Stage:** implement
**ACs:** AC-F1, AC-F2, AC-F3, AC-F4, AC-F5, AC-F6, AC-F7, AC-F8, AC-F9, AC-F13 (Ableitung), AC-F14, AC-F15 (CLI), AC-F17, AC-F18, AC-F19 (Parse), AC-F21, AC-5.22
**Tests:** task-5 — UT-01, UT-02, UT-03, UT-04, UT-05, UT-06, UT-07, UT-08, UT-09, UT-22, UT-24, UT-28 (Ableitung)

- [ ] Step 1 (red): UT-01…UT-09 in `tests/unit/viewer-cli.test.ts` — `viewer_port_required`, Port-Range, `viewer_port_conflict` nur bei gleicher Bind-Adresse und beiden Ports ungleich 0, Origin-Validierung, Hub-Origin-Ablehnung, `viewer_origin_required` inklusive geerbtem `--host 0.0.0.0`, `viewer_flags_without_viewer`, Alias-Normalisierung/`viewer_origin_conflict`, Env-Parität.
- [ ] Step 2 (red): UT-22/UT-24/UT-28 — `viewer_cookie_shared_host`, `viewer_non_loopback_insecure`, `viewer_public_url_deprecated`; werttragende Flags ohne Wert; fünfteilige `code`-Union.
- [ ] Step 3: `isWildcardBind()` als einzige Wildcard-Definition (`""`, `0.0.0.0`, `::`, `[::]`); `HubStartupError`/`HubStartupErrorCode`; alle sieben werttragenden Flags in `VALUED_FLAGS`; Env-Variablen; `--viewer=false`/`0` strikt als Boolean.
- [ ] Step 4: `startupWarnings()` um die Viewer-Eingabe erweitern; `parseHubArgs()` bleibt rein und emittiert keine Warnung.
- [ ] Step 5 (green): `hub-options.test.ts` (bestehende Fälle unverändert) und `viewer-cli.test.ts` grün.
- [ ] Step 6 (refactor): Origin-Normalisierung und Wildcard-Erkennung je genau einmal.
- [ ] Step 7: commit `feat(hub): add viewer flags, origin validation and startup warnings`

**Verification:** `npm test -- tests/unit/hub-options.test.ts tests/unit/viewer-cli.test.ts`
**DoD:** Jeder Fehlercode der Validierungsmatrix ist testbar; keine Origin wird aus einer unspecified Adresse abgeleitet; `--viewer` ohne Port bricht.

### Review R1: Welle 1

**Files:** keine (read-only Review)
**Interfaces:** Consumes Task 2–5; Produces Review-Verdict.
**Prüfbasis:** Task 2, 3, 4, 5
**parallel_group:** review
**Size:** S
**Reviewer:** code-reviewer
**Stage:** review
**Trace:** AC-5.4, AC-5.5, AC-5.12, AC-5.13, AC-5.21, AC-5.22, AC-5.24, AC-F1…AC-F9, AC-F13, AC-F14, AC-F15, AC-F17…AC-F19, AC-F21
**Tests:** keine neuen Tests (Review liest UT-01…UT-11, UT-16, UT-19, UT-21, UT-22, UT-24, UT-27, UT-28, UT-35)

- [ ] Step 1: Diff gegen Spec §2.2/§2.3/§2.5/§5.2 prüfen; eine Secret-Vergleichsstelle, keine zweite Throttle-Implementierung.
- [ ] Step 2: Ownership-Disjunktheit und `Files:`-Treue prüfen; keine Produktionsdatei außerhalb des Write-Sets.
- [ ] Step 3: Befunde mit Severity (critical/major/minor) melden; critical/major blockieren G1.
- [ ] Step 4: Verdict `APPROVED` oder `CHANGES_REQUESTED` in den Ledger schreiben.

**Verification:** `npm run typecheck && npm test -- tests/unit/admin-secret.test.ts tests/unit/cors.test.ts tests/unit/viewer-tickets.test.ts tests/unit/viewer-session.test.ts tests/unit/viewer-cli.test.ts`
**DoD:** 0 critical, 0 major; minor-Befunde sind als Folge-Task oder dokumentiertes Restrisiko geschlossen.

---

### Welle 2 — Routing, Viewer-Door, Doppel-Listener (Task 6–10)

**Barriere G2:** Task 6–10 sind gemergt; `npm run typecheck` und die Unit-/Lifecycle-Suiten sind grün; R2 ist abgeschlossen.

### Task 6: Surface-Autorisierung und die zwei Pfadsperren

**Files:**
- Modify: `server/handler.ts`
- Create: `tests/unit/viewer-surface.test.ts`
- Modify: `tests/unit/server-auth.test.ts`

**Interfaces:** Produces `HubSurface`, `surfaceOf()`, `normalizeSurfacePath()`, `hubViewerPathRefusal()`, `viewerSurfaceRefusal()`, erweitertes `authorize()`, `HandlerContext.surface`; Consumes `viewerAuthorized()`, `viewerSessionRefusalMessage()`, `context.revokedTokens`, `context.requiredScope`.
**Depends on:** 3, 4
**parallel_group:** W2-A
**Size:** L
**Agent:** senior-developer
**Stage:** implement
**ACs:** AC-5.9, AC-5.10, AC-5.11, AC-5.32 (Produzent)
**Tests:** task-6 — UT-17, UT-18, UT-25

- [ ] Step 1 (red): UT-17 — vollständige Erlaubt-/Gesperrt-Matrix für `viewerSurfaceRefusal()`, Hub immer `null`, Idempotenz; `/admin*`, `/mcp*`, `/journal`, `/config`, `/viewer/start`, alles außerhalb `{base}` gesperrt; `{base}/viewer`, `/view`, Assets, Bookmarklet, `notes*`, `sessions`, `bundle`, `health` erlaubt.
- [ ] Step 2 (red): UT-18 — Hub ignoriert `bp_viewer`/`x-bluepencil-viewer`; Viewer fail-closed ohne Client-Credential; `allowAdminSecret` nur Hub; ein `jti` in `revokedTokens` → `401 token_revoked` auf beiden Flächen.
- [ ] Step 3 (red): UT-25 — `normalizeSurfacePath()`: `%2e%2e`, doppelte/trailing Slashes, `..`-Escape, `.`-Segmente, nicht parsebarer URL-Anteil; eine Dekodierung, nie zwei.
- [ ] Step 4: `surfaceOf()` total; `authorize()`-Verzweigung in der verbindlichen Reihenfolge (Viewer-Session → Fail-closed → Credential-Verfahren); beide Sperren mit `normalizeSurfacePath()`; `hubViewerPathRefusal()` sperrt `{base}/viewer…` und unpräfigiert `/viewer…`, aber nicht `{base}/viewer/start`.
- [ ] Step 5 (green): `viewer-surface.test.ts` und `server-auth.test.ts` grün; bestehende Hub-Auth-Fälle unverändert.
- [ ] Step 6 (refactor): Surface-Prädikat und Pfadnormalisierung je genau einmal.
- [ ] Step 7: commit `feat(server): add surface-scoped authorization and path refusals`

**Verification:** `npm test -- tests/unit/viewer-surface.test.ts tests/unit/server-auth.test.ts`
**DoD:** Hub akzeptiert keine Viewer-Session; Viewer ist ohne Client-Credential `401`; keine Pfadnormalisierung umgeht eine Sperre.

### Task 7: Viewer-Door: SSRF, Launcher, Assets, Proxy

**Files:**
- Modify: `server/viewer.ts`
- Create: `tests/unit/viewer-ssrf.test.ts`
- Create: `tests/unit/viewer-start.test.ts`

**Interfaces:** Produces `TargetRefusalCode`, `TargetRefusal`, `TargetPolicyDeps`, `checkTarget()`, `handleViewerStart()`, `handleViewer()` mit `deps.resolver`; Consumes `classifyAddress()`, `createDnsResolver()`, `METADATA_HOSTNAMES`, `verifyOperatorSecret()`, `tickets.consume()`, `sessionCookie()`, `viewerSessionRefusalMessage()`.
**Depends on:** 2, 4
**parallel_group:** W2-A
**Size:** XL
**Agent:** senior-developer
**Stage:** implement
**ACs:** AC-5.3, AC-5.4, AC-5.5, AC-5.12, AC-5.14, AC-5.15, AC-5.17, AC-5.18, AC-5.19, AC-5.20, AC-5.30, AC-5.31
**Tests:** task-7 — UT-12, UT-13, UT-14, UT-15, UT-20, UT-23, UT-26, UT-32

- [ ] Step 1 (red): UT-12/UT-13/UT-14/UT-15/UT-26 — `checkTarget()`: Protokoll/Userinfo/Allowlist synchron; DNS-Klassifikation mit Stub-Resolver; private nur bei exaktem Eintrag, Wildcard nie; `forbiddenOrigins` normalisiert; Metadata-Hostnamen vor Allowlist/DNS; Resolver wirft/`[]`/Nicht-IP → `unresolvable_host`; total, nie eine Exception.
- [ ] Step 2 (red): UT-20/UT-23/UT-32 — `handleViewerStart()` ohne `viewer.origin` → `503 service_not_ready` ohne `Location`/`Set-Cookie`, `tickets.size()` unverändert; Bookmarklet-Artefakt enthält Platzhalter und keinen 48-Hex-Token; `isViewerStartRequest()`/`viewerStartPath()`-Zusammenspiel.
- [ ] Step 3: `checkTarget()` implementieren und `targetRefusal()` auf `TargetRefusal | null` umstellen; `proxyTarget()` prüft vor jedem Fetch **und** jedem Redirect-Hop, übersetzt Refusals unverändert in `403` mit `code`.
- [ ] Step 4: `handleViewer()`-Reihenfolge: Methode → Assets (vor Session) → `?ticket=` → `?k=` ablehnen → Session → Shell/Bookmarklet/Proxy; `?ticket` + `?k` gleichzeitig: Ticket gewinnt; ungültiges Ticket `401` ohne Cookie; gültiges Ticket `302` auf `{base}/viewer` mit Cookie.
- [ ] Step 5: `handleViewerStart()` auf `surface === "hub"` begrenzen; Origin-Prüfung vor Secret-Verbrauch; `x-bluepencil-admin` gewinnt über `?k=`; `302` mit `referrer-policy: no-referrer` und `cache-control: no-store`.
- [ ] Step 6: Assets mit `ACAO: *`, `CORP: cross-origin`, `no-cache`; Proxy entfernt die Ziel-CSP-Kopfzeile und das `<meta>`-CSP; Shell/Proxy tragen `X-Frame-Options: SAMEORIGIN`.
- [ ] Step 7 (green): beide Suiten grün; RT-01/RT-02 bleiben unverändert.
- [ ] Step 8 (refactor): Zielprüfung, Redirect-Schleife und Asset-Auslieferung je genau einmal.
- [ ] Step 9: commit `feat(viewer): harden ssrf, add launcher tickets and public assets`

**Verification:** `npm test -- tests/unit/viewer-ssrf.test.ts tests/unit/viewer-start.test.ts`
**DoD:** Metadata-Hostname schlägt Allowlist; eine unzulässige Adresse lehnt das ganze Ziel ab; Assets sind ohne Session erreichbar; kein Secret erreicht die Viewer-Origin.

### Task 8: CORS-Durchreichung und `gateRequest`-Reihenfolge

**Files:**
- Modify: `server/handler.ts`
- Create: `tests/unit/viewer-cors.test.ts`

**Interfaces:** Produces `json(status, payload, context, request)`, `errorResponse(status, code, message, context, request)`, `toErrorResponse(error, context, request)`, `applyMutation(context, request, mutate, event?)`, `listNotes(query, context, request)`, `readNote(id, query, context, request)`, `gateRequest()`-Reihenfolge, Viewer-`OPTIONS`-Behandlung; Consumes `responseCorsHeaders()`, `viewerBookmarkletPreflight()`, `allowedMethods()`.
**Depends on:** 3, 6
**parallel_group:** W2-B
**Size:** L
**Agent:** senior-developer
**Stage:** implement
**ACs:** AC-5.21
**Tests:** task-8 — UT-30, UT-31

- [ ] Step 1 (red): UT-30 — `responseCorsHeaders()`: Hub unverändert; Viewer nur `{base}/notes*`, sonst `{}`; `{base}/bundle` auf dem Hub status-/content-type-/body-gleich; Request-Durchreichung trägt den reflektierten Origin bei `GET /notes` (200), `GET /notes?intent=falsch` (400 `invalid_query`), `POST /notes` (400 `invalid_payload`) und `401`.
- [ ] Step 2 (red): UT-31 — `{viewer}{base}/health` → `200` ohne Credential vor `authorize()`; `/config` und `/admin` → `404`; `/notes` ohne Credential → `401`; `OPTIONS /notes*` → `204`/`405`, nie `401`; `OPTIONS /bundle` → `405 Allow: GET`; Hub-`/health` unverändert; `isViewerRequest()` ist für `/health`, `/notes*`, `/sessions`, `/bundle` falsch; `handleViewer()` gibt für dieselben URLs `null`.
- [ ] Step 3: `json`/`errorResponse`/`toErrorResponse`/`applyMutation`/`listNotes`/`readNote` um den Request erweitern; alle Aufrufer durchreichen; `health`/`configResponse` erhalten den Request; `bundle`-Header auf `responseCorsHeaders()` umstellen.
- [ ] Step 4: `gateRequest()` in der verbindlichen Reihenfolge `hostRefusal → hubViewerPathRefusal (Hub) → viewerSurfaceRefusal (Viewer) → adminGate (Hub) → Unknown-Path-404 → Preflight → config → health → authorize → Route`; Viewer-`OPTIONS` vor `authorize()`, `405` mit `Allow` aus `allowedMethods()`.
- [ ] Step 5 (green): `viewer-cors.test.ts` grün; Hub-CORS-Assertions (RT-06-Vorläufer) unverändert.
- [ ] Step 6 (refactor): Request-Durchreichung ohne optionale Zwischenpfade; keine zweite CORS-Implementierung.
- [ ] Step 7: commit `feat(server): thread request through cors headers and fix gate order`

**Verification:** `npm test -- tests/unit/viewer-cors.test.ts`
**DoD:** Jede `{base}/notes*`-Antwort trägt den reflektierten Origin; keine andere Viewer-Route tut es; kein Viewer-`OPTIONS` erreicht `authorize()`.

### Task 9: Doppel-Listener, Kontext-Allowlist und Lifecycle

**Files:**
- Modify: `server/hub.ts`
- Modify: `tests/unit/server-start.test.ts`
- Create: `tests/unit/viewer-lifecycle.test.ts`

**Interfaces:** Produces `ViewerListenOptions`, `RunningViewer`, `RunningServer.viewer/close()`, `resolveOptions()`-Viewer-Validierung, `startHub()`-Doppelbind, `viewerContext`-Allowlist, `activeJournalForTests()`; Consumes `createFileStore()`, `createViewerSessions()`, `createViewerTickets()`, `selectJournal()`, `HubStartupError`, `isWildcardBind()`.
**Depends on:** 5, 6, 7
**parallel_group:** W2-B
**Size:** XL
**Agent:** senior-developer
**Stage:** implement
**ACs:** AC-5.1, AC-5.6, AC-5.7, AC-5.8, AC-5.32, AC-5.33, AC-F10, AC-F11, AC-F12, AC-F16, AC-F20, AC-F22, AC-F23
**Tests:** task-9 — UT-29, UT-34, UT-36

- [ ] Step 1 (red): UT-29 — `resolveOptions()` lehnt `ttlSeconds` 59/604801 mit `HubStartupError("viewer_ttl_invalid")` ab, akzeptiert 60/604800; `publicBaseUrl` wird auf `origin` normalisiert und validiert.
- [ ] Step 2 (red): UT-34 — `isWildcardBind("")`, `0.0.0.0`, `::`, `[::]` → `true`; `127.0.0.1`, `localhost`, `192.0.2.10`, `::1` → `false`; programmatischer Wildcard-Bind ohne `viewer.origin` → `viewer_origin_required` vor jedem Bind; `port 0` ändert nichts; mit expliziter Origin akzeptiert.
- [ ] Step 3 (red): UT-36 — `activeJournalForTests()` ist nach einem Fehlstart `null`, nach erfolgreichem Start nicht `null`, nicht aus `server/index.ts` re-exportiert.
- [ ] Step 4: `resolveOptions()` erzeugt `ViewerOptions` inklusive `sessions`/`tickets` genau einmal; `startHub()` bindet Hub, dann Viewer; schlägt der Viewer-Bind fehl, wird der Hub geschlossen, `activeJournal = null` gesetzt und der Fehler weitergereicht.
- [ ] Step 5: `viewerContext` als explizite Feld-Allowlist — `store`, `base`, `environment`, `readOnly`, `allowEnvMismatch`, `authSecret`, `verifyToken`, `requiredScope`, `revokedTokens` (dieselbe Set-Referenz), `adminThrottle`, `presence`, `persist`, `version`, `appName`, `exportedBy`, `now`, `viewer`, `surface: "viewer"`, `bind: viewerBind`, `hostAliases: viewerHostAliases`, `cors: undefined`; `adminSecret`, `tokenIssuer`, `revokeToken`, `devicesPath`, `revocationPath`, `root`, `registry`, `federation` fehlen strukturell.
- [ ] Step 6: feste Ports: Origins und Startvalidierung synchron vor `listen()`, echte Handler erst danach; `port 0`: beide Binds, dann tatsächliche Adressen, Origin, Post-`listen()`-Validierung, dann echte Handler; Startfenster `503 service_not_ready`.
- [ ] Step 7: `RunningViewer.host/port` aus dem Socket, `origin` explizit oder abgeleitet (nie aus Wildcard), `url = origin + base`; `close()` mit `Promise.allSettled`, erster Fehler nach beiden Closes.
- [ ] Step 8 (green): `viewer-lifecycle.test.ts` und `server-start.test.ts` grün; kein zweiter `createFileStore`-Aufruf.
- [ ] Step 9 (refactor): Bind- und Origin-Ableitung je einmal; `activeJournal`-Reset in jedem Fehlerzweig.
- [ ] Step 10: commit `feat(hub): add dual listener lifecycle and shared viewer context`

**Verification:** `npm test -- tests/unit/viewer-lifecycle.test.ts tests/unit/server-start.test.ts`
**DoD:** Genau eine Store-/Journal-/Session-/Ticket-Instanz; `viewer.origin` vor dem ersten Request; kein halber Start; `revokedTokens` ist dieselbe Referenz.

### Task 10: Dispatch-Gate, Startwarnungen und Startzeile

**Files:**
- Modify: `server/hub.ts`
- Create: `tests/unit/viewer-dispatch.test.ts`

**Interfaces:** Produces `respond()`/`earlyRefusal()`-Gate (`surface === "viewer" && isViewerRequest()`), `hubViewerPathRefusal()`-/`viewerSurfaceRefusal()`-Aufrufstellen, `startupWarnings()`-Emission auf stderr, Startzeile mit beiden Adressen; Consumes Task 6-Sperren, Task 7-Door, Task 9-Listener.
**Depends on:** 6, 7, 9
**parallel_group:** W2-C
**Size:** L
**Agent:** senior-developer
**Stage:** implement
**ACs:** AC-5.2, AC-5.23, AC-5.29, AC-F13 (Emission), AC-F15 (programmatisch)
**Tests:** task-10 — UT-28, UT-33

- [ ] Step 1 (red): UT-33 — `hostRefusal()` mit injiziertem Bind: Loopback-Bind + fremder `Host` → `403 host_not_allowed`; Loopback-Bind + Alias → `null`; Nicht-Loopback-Bind `192.0.2.10` + fremder `Host` → `null`; ohne echten Nicht-Loopback-Bind.
- [ ] Step 2 (red): UT-28 — `startupWarnings()` emittiert die fünf `code`-Werte auf stderr; `--quiet` unterdrückt die Fortschrittszeile, nicht die Warnungen.
- [ ] Step 3: `respond()`: `hostRefusal → Launcher (nur Hub) → hubViewerPathRefusal (nur Hub) → viewerSurfaceRefusal (nur Viewer) → Viewer-Door (nur Viewer **und** `isViewerRequest`) → Journal → Static → earlyRefusal`; `earlyRefusal()`-Viewer-Zweig ebenfalls surface- und pfad-gated.
- [ ] Step 4: `gateRequest()`-Sperren an den Aufrufstellen verankern; `hubViewerPathRefusal()` liegt vor dem Static-Fallback; `viewerSurfaceRefusal()` vor Journal/Static/MCP.
- [ ] Step 5: Startzeile `bluepencil server: "<name>" on http://host:port<base> — viewer on <origin><base> — N note(s)`; Warnungen vor dem Serving auf stderr; `parseHubArgs` emittiert keine Warnung.
- [ ] Step 6: programmatischer `cors: "*"` mit `viewer` → `HubStartupError("cors_wildcard_with_viewer")`, beide Listener geschlossen; `cors` gleich der Viewer-Origin → `HubStartupError("cors_viewer_origin")`.
- [ ] Step 7 (green): `viewer-dispatch.test.ts` grün.
- [ ] Step 8 (refactor): Dispatch-Prädikate an genau einer Stelle definieren.
- [ ] Step 9: commit `feat(hub): gate dispatch by surface and emit viewer startup warnings`

**Verification:** `npm test -- tests/unit/viewer-dispatch.test.ts`
**DoD:** Hub-Port liefert für alle Viewer-Inhaltsrouten `404`, auch mit `--root`; Viewer-Door verschluckt `/health`, `/notes*`, `/sessions`, `/bundle` nicht; Warnungen sind nicht durch `--quiet` unterdrückbar.

### Review R2: Welle 2

**Files:** keine (read-only Review)
**Interfaces:** Consumes Task 6–10; Produces Review-Verdict.
**Prüfbasis:** Task 6, 7, 8, 9, 10
**parallel_group:** review
**Size:** M
**Reviewer:** code-reviewer
**Stage:** review
**Trace:** AC-5.1, AC-5.2, AC-5.3, AC-5.6…AC-5.11, AC-5.14, AC-5.15, AC-5.17…AC-5.21, AC-5.23, AC-5.29, AC-5.32, AC-5.33, AC-F10…AC-F13, AC-F15, AC-F16, AC-F20, AC-F22, AC-F23
**Tests:** keine neuen Tests (Review liest UT-12…UT-15, UT-17…UT-20, UT-23, UT-25…UT-36)

- [ ] Step 1: Surface-Verzweigung, die zwei Sperren und die Dispatch-Prädikate gegen Spec §2.1 Regel 5/6/7/11 prüfen.
- [ ] Step 2: `viewerContext`-Allowlist gegen §2.4 Regel 2 prüfen; `adminSecret`/`root`/`registry`/`federation` dürfen strukturell fehlen.
- [ ] Step 3: Startatomarität und `activeJournal`-Reset prüfen; kein Pfad bedient vor der Origin-Auflösung.
- [ ] Step 4: Befunde mit Severity melden; critical/major blockieren G2.

**Verification:** `npm run typecheck && npm test -- tests/unit/viewer-surface.test.ts tests/unit/viewer-ssrf.test.ts tests/unit/viewer-start.test.ts tests/unit/viewer-cors.test.ts tests/unit/viewer-lifecycle.test.ts tests/unit/viewer-dispatch.test.ts`
**DoD:** 0 critical, 0 major; jede Surface-Änderung ist als Sicherheitsänderung begründet.

---

### Welle 3 — Integrationstests (Task 11–15)

**Barriere G3:** Task 11–15 sind gemergt; alle 88 Testfälle (UT-01…UT-36, IT-01…IT-46, RT-01…RT-06) sind vorhanden und grün; R3 ist abgeschlossen.

### Task 11: Launcher-, Ticket- und Session-Integration

**Files:**
- Create: `tests/unit/viewer-session.integration.test.ts`

**Interfaces:** Consumes `startHub()`, `RunningServer.viewer`, `verifyOperatorSecret()`, `handleViewerStart()`, `handleViewer()`, `viewerSessionRefusalMessage()`; Produces IT-Belege für Launcher, Ticket, Cookie und Session-Ablehnung.
**Depends on:** 7, 10
**parallel_group:** W3-A
**Size:** L
**Agent:** developer
**Stage:** implement
**ACs:** AC-5.3, AC-5.5, AC-5.12, AC-5.13, AC-5.14, AC-5.15
**Tests:** task-11 — IT-03, IT-04, IT-05, IT-12, IT-13, IT-14, IT-41

- [ ] Step 1 (red): IT-03/IT-04 — Shell, Bookmarklet und `/view` ohne Session nennen dieselbe `viewerSessionRefusalMessage()` mit `{hubOrigin}{base}/viewer/start` und nie `{base}/viewer?k=`; Launcher mit Header/`?k=`/fehlend/falsch liefert `302`/`401`, Header gewinnt.
- [ ] Step 2 (red): IT-05 — Ticket-Einlösung, Cookie auf der Leitung, Replay `401` ohne Cookie, Ablauf `401`; `publicOrigin() → Secure` end-to-end: explizite `https://`-Origin → `Secure`, abgeleitete `http://`-Origin → kein `Secure`.
- [ ] Step 3 (red): IT-12 — Admin-Secret auf der Viewer-Origin wirkungslos, kein Oracle, kein Throttle-Verbrauch; Fall (a) öffentlicher `hubOrigin` nennt die Launcher-URL, Fall (b) nennt „open the hub launcher“ ohne konstruierte URL; die vier Session-Ablehnungen sind identisch.
- [ ] Step 4 (red): IT-13/IT-14/IT-41 — Assets ohne Session `200`, unbekanntes Asset `404`; Bookmarklet ohne Session `401`, mit Session `200 text/plain` und `__BP_VIEWER_TOKEN__`, kein 48-Hex-Token; Shell ohne Session `401`, Asset ohne Cookie `200` (Reihenfolge).
- [ ] Step 5 (green): alle sieben ITs grün; ein roter Lauf ist ein Finding an Task 4/7/10 und blockiert G3.
- [ ] Step 6 (refactor): gemeinsame Assertion-Helper für Session-Ablehnungen zentralisieren.
- [ ] Step 7: commit `test(viewer): cover launcher, ticket and session contracts`

**Verification:** `npm test -- tests/unit/viewer-session.integration.test.ts`
**DoD:** Jede Session-Ablehnung ist byte-identisch; das Secret erreicht die Viewer-Origin nie; Assets sind vor der Session-Prüfung bedient.

### Task 12: Gemeinsamer Store, Journal und Bundle-Parität

**Files:**
- Create: `tests/unit/viewer-shared.integration.test.ts`

**Interfaces:** Consumes `startHub()`, `store.state`, `persist`, `journal.record`, `loadNotes()`, `handleMcpRoute()`; Produces IT-Belege für die eine Store-/Journal-Instanz und die `/bundle`-Parität.
**Depends on:** 10
**parallel_group:** W3-A
**Size:** L
**Agent:** developer
**Stage:** implement
**ACs:** AC-5.6, AC-5.7, AC-5.8, AC-5.32, AC-5.33
**Tests:** task-12 — IT-06, IT-07, IT-08, IT-43, IT-44

- [ ] Step 1 (red): IT-06/IT-07 — ein Write über die Viewer-Origin erscheint ohne Neustart in Hub-`/notes` und `/bundle`; `POST {hub}{base}/mcp` mit `tools/call list_notes` enthält dieselbe Notiz-ID.
- [ ] Step 2 (red): IT-08 — `--journal file` oder `--journal-coalesce 0`; der Write trägt `X-Bluepencil-Actor: viewer-test`; `GET {hub}{base}/journal` enthält genau einen neuen Eintrag mit `noteId` und `actor === "viewer-test"`; keine zweite Journal-Datei.
- [ ] Step 3 (red): IT-43 — Geräte-Token über den Hub widerrufen; Viewer-`/notes`, `/bundle`, `/sessions` liefern vor der Revocation `200`, danach `401 token_revoked`; Hub verhält sich gleich; dieselbe `revokedTokens`-Referenz, keine Kopie, kein Fallback auf `x-bluepencil-auth`.
- [ ] Step 4 (red): IT-44 — injizierte Uhr `now`, `appName`, `exportedBy`; Hub- und Viewer-`/bundle` sind status-, content-type- und body-identisch; Kopfzeilen unterscheiden sich nur um Hub-CORS, die der Test vor dem Vergleich entfernt; `exportedAt`, `app.name`, `exportedBy` stimmen.
- [ ] Step 5 (green): alle fünf ITs grün; ein roter Lauf ist ein Finding an Task 9/10 und blockiert G3.
- [ ] Step 6 (refactor): Header-Vergleich der Bundle-Parität als ein Helper.
- [ ] Step 7: commit `test(viewer): prove shared store, journal and bundle parity`

**Verification:** `npm test -- tests/unit/viewer-shared.integration.test.ts`
**DoD:** Genau ein Store, ein Journal, eine Revocation-Referenz; Viewer- und Hub-`/bundle` sind bis auf Hub-CORS identisch.

### Task 13: Proxy, Injection und SSRF-Integration

**Files:**
- Create: `tests/unit/viewer-proxy.integration.test.ts`

**Interfaces:** Consumes `startHub()`, `checkTarget()`, `buildViewDocument()`, `stubResolver()`, `stubFetch()`; Produces IT-Belege für Injection, CSP-Strip und SSRF.
**Depends on:** 7, 10
**parallel_group:** W3-A
**Size:** L
**Agent:** developer
**Stage:** implement
**ACs:** AC-5.16, AC-5.17, AC-5.18, AC-5.19, AC-5.20, AC-5.25, AC-5.26, AC-5.27, AC-5.28, AC-5.30, AC-5.31
**Tests:** task-13 — IT-15, IT-16, IT-17, IT-18, IT-29, IT-30, IT-31, IT-32, IT-34, IT-42, RT-01, RT-02

- [ ] Step 1 (red): IT-15/IT-30/IT-31/IT-32 — statische Seite, SPA-Shell ohne `<head>`, fehlendes `</head>`, fehlendes `<head>`; Injection an der richtigen Stelle, `<base href>`, absoluter `endpoint` und absolutes Element-`src`, beide `200`.
- [ ] Step 2 (red): IT-29 — Ziel liefert Header-CSP und `<meta>`-CSP; die Antwort trägt keine `content-security-policy`-Kopfzeile, der Body kein `<meta http-equiv="content-security-policy"`, `<bluepencil-notes` und `bluepencil.element.min.js` sind vorhanden.
- [ ] Step 3 (red): IT-16/IT-17/IT-18/IT-34/IT-42 — Stub-Resolver loopback/metadata → `403 target_address_forbidden`, Fetch 0; Redirect-Hop auf Metadata → `403`, genau ein Fetch; exakter privater Eintrag erlaubt, Wildcard nicht, Loopback immer verboten; Metadata-Hostname vor DNS, Resolver wirft/leer/Nicht-IP → `unresolvable_host`; `forbiddenOrigins` mit nicht-loopback Origin → `target_forbidden_origin`, kein Fetch.
- [ ] Step 4 (green): RT-01/RT-02 in dieser Datei erneut beobachten; alle zwölf ITs/RTs grün; ein roter Lauf ist ein Finding an Task 7 und blockiert G3.
- [ ] Step 5 (refactor): Dokumentformen (statisch, SPA, ohne `</head>`, ohne `<head>`) als datengetriebene Fälle.
- [ ] Step 6: commit `test(viewer): cover proxy injection, csp strip and ssrf policies`

**Verification:** `npm test -- tests/unit/viewer-proxy.integration.test.ts`
**DoD:** Jeder SSRF-Pfad endet als benannter `403`-Code, nie als `500`; Injection ist für alle vier Dokumentformen belegt.

### Task 14: Surface-, CORS-, Host- und `--root`-Integration

**Files:**
- Create: `tests/unit/viewer-surface.integration.test.ts`

**Interfaces:** Consumes `startHub()`, `hubViewerPathRefusal()`, `viewerSurfaceRefusal()`, `responseCorsHeaders()`, `hostRefusal()`; Produces IT-Belege für Routen-Minimalität, CORS, Host-Gate und `--root`.
**Depends on:** 8, 10
**parallel_group:** W3-A
**Size:** L
**Agent:** developer
**Stage:** implement
**ACs:** AC-5.2, AC-5.9, AC-5.10, AC-5.11, AC-5.21, AC-5.22, AC-5.23, AC-5.24, AC-5.29
**Tests:** task-14 — IT-02, IT-09, IT-10, IT-11, IT-19, IT-20, IT-21, IT-22, IT-28, IT-33, RT-03, RT-04, RT-05, RT-06

- [ ] Step 1 (red): IT-02/IT-09/IT-33 — Hub-Port `404` für alle Viewer-Routen ohne `--root`; Viewer-`404` für `/admin`, `/admin/status`, `/config`, `/journal`, `/viewer/start`, `POST /mcp`, `--root`-Datei; mit `--root` bleiben alle acht Viewer-Pfade `404` und `other.html` `200`; RT-05 bestätigt den unveränderten `index.html`-Fallback für Nicht-Viewer-Pfade.
- [ ] Step 2 (red): IT-10/IT-11 — Viewer ohne `--auth-secret` fail-closed `401`, danach mit Session Erfolg, Hub-`/notes` bleibt ohne Credential `200`; eine Viewer-Session öffnet Hub-`/notes` nicht, `x-bluepencil-viewer` ebenso wenig, auf der Viewer-Fläche beide `200`.
- [ ] Step 3 (red): IT-19 — gültiger Preflight `204` mit exakter Methodenliste, kein `Allow-Credentials`; tatsächliche Erfolgs- und Fehlerantwort mit reflektiertem Origin; `OPTIONS` ohne Requested-Header/Origin `405` mit `Allow`; `/bundle`/`/sessions` `405 Allow: GET`; kein Viewer-`OPTIONS` `401`; RT-06 bestätigt Hub-CORS byte-gleich.
- [ ] Step 4 (red): IT-20/IT-21/IT-22/IT-28 — `cors_viewer_origin` über den Startpfad; Host-Gate loopback/aliases/fremder Host; `X-Forwarded-Proto` nur Loopback, explizite Origin gewinnt; `viewer_origin_conflict` über den CLI-Startpfad mit Alias-Warnung.
- [ ] Step 5 (green): alle vierzehn ITs/RTs grün; ein roter Lauf ist ein Finding an Task 6/8/10 und blockiert G3.
- [ ] Step 6 (refactor): Route-Matrix als eine Tabelle im Test, nicht als duplizierte Einzelfälle.
- [ ] Step 7: commit `test(viewer): cover surface minimality, cors, host gate and root`

**Verification:** `npm test -- tests/unit/viewer-surface.integration.test.ts`
**DoD:** Viewer-Origin bietet keine Admin-/MCP-/Journal-/Config-/`--root`-Fläche; Hub-CORS unverändert; jede Sperre ist mit und ohne `--root` belegt.

### Task 15: Startup-, Lifecycle- und CLI-Integration

**Files:**
- Create: `tests/unit/viewer-startup.integration.test.ts`

**Interfaces:** Consumes `startHub()`, `parseHubArgs()`, `RunningServer.viewer`, `close()`, `activeJournalForTests()`, `startupWarnings()`; Produces IT-Belege für Start, Close, Ports, Warnungen, Fehler und Env.
**Depends on:** 5, 10
**parallel_group:** W3-B
**Size:** L
**Agent:** developer
**Stage:** implement
**ACs:** AC-5.1, AC-F10, AC-F11, AC-F12, AC-F13, AC-F15, AC-F16, AC-F17, AC-F18, AC-F19, AC-F20, AC-F22, AC-F23
**Tests:** task-15 — IT-01, IT-23, IT-24, IT-25, IT-26, IT-27, IT-35, IT-36, IT-37, IT-38, IT-39, IT-40, IT-45, IT-46

- [ ] Step 1 (red): IT-01/IT-25 — zwei Listener mit unterschiedlichen tatsächlichen Ports; `viewer.port 0` meldet den tatsächlichen Port, `viewer.origin` ist `http://<host>:<actual port>`, `viewer.url = origin + base`.
- [ ] Step 2 (red): IT-23/IT-24 — `close()` schließt beide, Neustart gelingt; ein belegter Viewer-Port lässt `startHub` werfen, der Hub-Listener ist geschlossen, ein späterer Start auf dem freien Hub-Port gelingt; kein halber `RunningServer`.
- [ ] Step 3 (red): IT-26/IT-27 — Warnungen auf stderr auch mit `--quiet`, Fortschrittszeile unterdrückt; Env-Variablen starten denselben Viewer wie die Flags, Flag gewinnt.
- [ ] Step 4 (red): IT-35/IT-37/IT-38/IT-39/IT-40 — `--cors '*'` mit `--viewer` als CLI-Fehler und programmatischer `HubStartupError`; `--viewer=false`/`0` aus, `--viewer=true` ohne Port Fehler; TTL-Grenzen CLI und programmatisch; `0/0` und gleicher Port auf unterschiedlichen Bind-Adressen akzeptiert; Alias auf die Hub-Origin abgelehnt.
- [ ] Step 5 (red): IT-36/IT-45/IT-46 — Post-`listen()`-Konflikt `viewer_origin_is_hub_origin`/`cors_viewer_origin`, beide Listener geschlossen, `activeJournalForTests()` `null`, Folgestart schreibt nur nach `<dir2>`; Startfenster liefert nur `503` oder keine Verbindung, danach Launcher-`302` mit absoluter Origin; Docker-Muster `--host 0.0.0.0 --viewer` ohne `--viewer-origin` → `viewer_origin_required`, mit expliziter Origin startet derselbe Aufruf und `viewer.origin` ist nie `http://0.0.0.0:8788`.
- [ ] Step 6 (green): alle vierzehn ITs grün; ein roter Lauf ist ein Finding an Task 5/9/10 und blockiert G3.
- [ ] Step 7 (refactor): Start-/Stop-Helper und Port-Fixture zentralisieren.
- [ ] Step 8: commit `test(viewer): cover startup, lifecycle, ports and cli end to end`

**Verification:** `npm test -- tests/unit/viewer-startup.integration.test.ts`
**DoD:** Kein Listener-Leak, kein stale Journal, keine Origin aus einer Wildcard-Adresse; alle Fehlercodes sind über den Startpfad belegt.

### Review R3: Welle 3

**Files:** keine (read-only Review)
**Interfaces:** Consumes Task 11–15; Produces Review-Verdict.
**Prüfbasis:** Task 11, 12, 13, 14, 15
**parallel_group:** review
**Size:** M
**Reviewer:** code-reviewer
**Stage:** review
**Trace:** alle 56 ACs (Integrationsteil)
**Tests:** keine neuen Tests (Review prüft IT-01…IT-46, RT-01…RT-06)

- [ ] Step 1: Vollständigkeit prüfen — jeder Testfall der Spec §8 ist genau einmal vorhanden; keine Assertion ist abgeschwächt.
- [ ] Step 2: Rote Läufe und Findings prüfen; kein Test wurde umgangen oder mit `skip` versehen.
- [ ] Step 3: `npm run typecheck && npm test` vollständig grün bestätigen.
- [ ] Step 4: Verdict schreiben; critical/major blockieren G3.

**Verification:** `npm run typecheck && npm test`
**DoD:** 88/88 Tests vorhanden und grün; 0 critical, 0 major.

---

### Welle 4 — Requirements, Doku und Betriebsflächen (Task 16–19)

**Barriere G4:** Task 16–19 sind gemergt; `npm run spec` erzeugt keinen unerwarteten Diff, `npm run spec:check` ist grün, Doku-Assertions sind grün, R4 ist abgeschlossen.

### Task 16: Requirements-Block und Spec-Regeneration

**Files:**
- Modify: `docs/REQUIREMENTS.md`
- Modify: `spec/**`

**Interfaces:** Produces FR-6.17+ für R1–R9; Consumes Spec §6, alle 56 AC-IDs.
**Depends on:** 15
**parallel_group:** W4-A
**Size:** M
**Agent:** requirements
**Stage:** document
**ACs:** R1–R9 (Spec §6)
**Tests:** task-16 — keine neuen Tests; `npm run spec:check`

- [ ] Step 1: Die neun normativen Aussagen R1–R9 aus Spec §6 in den Block „FR-6 Storage & transport“ nach FR-6.16 einsetzen; IDs und Milestone vergibt `requirements`, keine erfundene Bereichsnummer.
- [ ] Step 2: Jede Aussage mit den in Spec §6 genannten AC-IDs als Acceptance verknüpfen (R1→AC-5.1/5.2/5.29, R2→AC-5.6/5.7/5.8/5.33, R3→AC-5.9/5.14/5.15, R4→AC-5.3/5.10/5.11/5.13/5.32, R5→AC-5.4/5.5/5.12, R6→AC-5.13, R7→AC-5.17/5.18/5.19/5.20/5.30/5.31, R8→AC-F1…F9/AC-F14…F21, R9→AC-5.1/AC-F10…F12/AC-F16/AC-F22).
- [ ] Step 3: `npm run spec` ausführen; `spec/` ausschließlich generiert ändern, nie handeditieren.
- [ ] Step 4 (green): `npm run spec:check` grün; kein unerwarteter Diff außerhalb des neuen Blocks.
- [ ] Step 5 (refactor): Requirement-Text und AC-Liste gegen die Spec-§6-Tabelle abgleichen; keine doppelte Aussage.
- [ ] Step 6: commit `docs(requirements): add viewer origin requirements and regenerate spec`

**Verification:** `npm run spec && npm run spec:check`
**DoD:** FR-6.17+ existiert, jede Aussage ist einer AC-Menge zugeordnet, `spec/` ist regeneriert und geprüft.

### Task 17: `docs/VIEWER.md` Neufassung

**Files:**
- Modify: `docs/VIEWER.md`

**Interfaces:** Produces die Betriebsdoku für eigene Origin, Launcher, Routen-Matrix, Cookie/TLS, Migration; Consumes Spec §2.8/§2.9/§4.3/§4.7/§5.3/§9.
**Depends on:** 15
**parallel_group:** W4-A
**Size:** M
**Agent:** technical-writer
**Stage:** document
**ACs:** AC-5.1…AC-5.33 (Doku-Hälfte), Spec §9
**Tests:** task-17 — Doku-Review durch R4; `tests/unit/extension-docs.test.ts` unverändert

- [ ] Step 1: Ist-Stand 0.13.0 (gleicher Listener, `{base}/viewer?k=`) durch die Zielarchitektur ersetzen; die Sätze „The proxied page is trusted with the store“ durch die Origin-Grenze und die verbleibenden Restrisiken ersetzen.
- [ ] Step 2: `--viewer-host`, `--viewer-port`, `--viewer-origin`, `--viewer-public-url` (Semantikwechsel), `--viewer-assets`, `--viewer-allow`, `--viewer-ttl` und die Env-Namen dokumentieren; den Ein-Zeilen-Umzug nennen.
- [ ] Step 3: Routen-Matrix, Launcher `{base}/viewer/start`, Cookie-/TLS-Abschnitt, Reverse-Proxy-/nginx-Muster und den Bookmarklet-Neuausstellungs-Hinweis aufnehmen.
- [ ] Step 4: `--cors '*'`-Verbot mit `--viewer` und das fehlende `x-bluepencil-admin`-Budget ausdrücklich nennen.
- [ ] Step 5 (refactor): Abschnittsreihenfolge an `docs/VIEWER.md` und Spec §9 angleichen; keine erfundene Flagge.
- [ ] Step 6: commit `docs(viewer): document the dedicated viewer origin`

**Verification:** `npm test -- tests/unit/extension-docs.test.ts`
**DoD:** Keine Aussage widerspricht der Spec; jede Breaking-Änderung aus §9 ist benannt; keine erfundene Flagge.

### Task 18: Docker-, Compose- und Entrypoint-Muster

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `docker/entrypoint.sh`
- Modify: `docs/DOCKER.md`
- Modify: `tests/unit/docker-config.test.ts`
- Modify: `tests/unit/docker-entrypoint.test.ts`

**Interfaces:** Produces das Zwei-Port-Betriebsmuster und die `viewer_origin_required`-Warnung für den Container; Consumes Spec §9 (Dockerfile/compose/entrypoint), AC-F6/AC-F23.
**Depends on:** 15
**parallel_group:** W4-A
**Size:** M
**Agent:** developer
**Stage:** document
**ACs:** AC-F6, AC-F23
**Tests:** task-18 — `docker compose config`, `npm run smoke:docker`, `npm test -- tests/unit/docker-config.test.ts tests/unit/docker-entrypoint.test.ts`

- [ ] Step 1 (red): `tests/unit/docker-config.test.ts` um den optionalen zweiten Port-Mapping-Eintrag `127.0.0.1:${BLUEPENCIL_VIEWER_PORT:-8788}:8788` und das `command:`-Beispiel mit zwingendem `--viewer-origin` erweitern.
- [ ] Step 2 (red): `tests/unit/docker-entrypoint.test.ts` um die Banner-Zeile bei gesetztem `BLUEPENCIL_VIEWER_PORT` erweitern; die feste `--host 0.0.0.0`-Zeile bleibt unverändert.
- [ ] Step 3: `docker-compose.yml` mit auskommentiertem zweiten Port und `command:`-Beispiel ergänzen; `Dockerfile`-Kommentar zum Zwei-Port-Muster; `docker/entrypoint.sh` Banner-Zeile; `docs/DOCKER.md`-Viewer-Abschnitt.
- [ ] Step 4 (green): `docker compose config` und `npm run smoke:docker` grün; kein Viewer-Default wird exponiert.
- [ ] Step 5 (refactor): Compose-Beispiel und DOCKER-Doku auf denselben Flag-Satz reduzieren.
- [ ] Step 6: commit `docs(docker): add the two-port viewer deployment pattern`

**Verification:** `docker compose config && npm run smoke:docker && npm test -- tests/unit/docker-config.test.ts tests/unit/docker-entrypoint.test.ts`
**DoD:** Container-Viewer ohne `--viewer-origin` scheitert mit `viewer_origin_required`; mit expliziter Origin startet er; kein Port wird still exponiert.

### Task 19: README und CHANGELOG

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:** Produces die Nutzer-/Release-Kommunikation für 0.14.0; Consumes Spec §9 (README/CHANGELOG), Release-Note-Vorschlag.
**Depends on:** 15
**parallel_group:** W4-A
**Size:** S
**Agent:** technical-writer
**Stage:** document
**ACs:** AC-5.1…AC-5.33 (Kommunikation), Spec §9
**Tests:** task-19 — Doku-Review durch R4

- [ ] Step 1: `README.md`-Viewer-Blurb auf „eigene Origin“ umstellen und den AC-5-Hinweis aufnehmen.
- [ ] Step 2: `CHANGELOG.md` unter `Changed` (breaking): `--viewer-port` Pflicht, Viewer-Inhalt nicht mehr auf dem Hub-Port, `{base}/viewer?k=` → `{base}/viewer/start?k=`, `--viewer-public-url` als Alias für die Viewer-Listener-Origin, `--cors '*'` mit `--viewer` verboten, fehlendes `x-bluepencil-admin` verbraucht kein Budget.
- [ ] Step 3: `Added` (zweiter Listener, Ticket, Surface-Auth, SSRF) und `Security` (Viewer-`token_revoked`, geteilte Revocation-Referenz) ergänzen; den Release-Kopf noch **nicht** schreiben.
- [ ] Step 4 (refactor): Wortlaut gegen die Release-Note-Vorschläge der Spec §9 abgleichen.
- [ ] Step 5: commit `docs: describe the dedicated viewer origin in readme and changelog`

**Verification:** `npm run secret-scan`
**DoD:** Jede Breaking-Änderung aus §9 ist unter der richtigen Kategorie; kein Release-Kopf (der entsteht in Task 20).

### Review R4: Welle 4

**Files:** keine (read-only Review)
**Interfaces:** Consumes Task 16–19; Produces Review-Verdict.
**Prüfbasis:** Task 16, 17, 18, 19
**parallel_group:** review
**Size:** S
**Reviewer:** code-reviewer
**Stage:** review
**Trace:** Spec §6, §9
**Tests:** keine neuen Tests (`npm run spec:check`)

- [ ] Step 1: Requirements-Block gegen Spec §6 prüfen; keine erfundene ID, kein erfundener Milestone, jede R-Aussage ist vorhanden.
- [ ] Step 2: Doku-Wahrheit prüfen — VIEWER/DOCKER/README/CHANGELOG widersprechen der Spec nicht; keine Flagge, kein Fehlercode fehlt.
- [ ] Step 3: `spec/` ist ausschließlich generiert; `npm run spec` erzeugt keinen Diff.
- [ ] Step 4: Verdict schreiben; critical/major blockieren G4.

**Verification:** `npm run spec && npm run spec:check`
**DoD:** 0 critical, 0 major; keine Doku-Aussage ist stärker als die Spec.

---

### Welle 5 — Release und finaler Validator (Task 20–21)

### Task 20: Release-Cut 0.14.0

**Files:**
- Modify: `package.json`
- Modify: `extension/manifest.json`
- Modify: `CHANGELOG.md`

**Interfaces:** Produces `0.14.0` in beiden SSOT-Dateien und den Release-Kopf; Consumes R4-Verdict, Task 16–19.
**Depends on:** 16, 17, 18, 19
**parallel_group:** W5
**Size:** M
**Agent:** release
**Stage:** release
**ACs:** Release-Kriterien (§7.2), Zielrelease aus dem Spec-Kopf
**Tests:** task-20 — `npm run check-version-bump`, `npm run verify`, `npm run secret-scan`, `npm run spec`, `npm run spec:check`, `node scripts/release-preflight.mjs --tag v0.14.0 --notes /tmp/notes.md`

- [ ] Step 1: Version gemäß `release` auf `0.14.0` setzen; `package.json` und `extension/manifest.json` identisch.
- [ ] Step 2: `CHANGELOG.md`-Release-Kopf `## [0.14.0] — 2026-11-07` über die Task-19-Abschnitte setzen.
- [ ] Step 3: README-, Docker-/Compose-/Entrypoint- und VIEWER-Artefakte aus W4 gegen die Spec §9 prüfen; kein Nachtrag außerhalb des Release-Kopfs.
- [ ] Step 4: `npm run check-version-bump`, `npm run verify`, `npm run secret-scan`, `npm run spec`, `npm run spec:check` und den Release-Preflight ausführen; jeder rote Schritt blockiert den Cut.
- [ ] Step 5: Bundle-Budget prüfen (`npm run size`); keine präventive Schwellenerhöhung.
- [ ] Step 6: Tag `v0.14.0` über den `git`-Agenten setzen; Commit `chore: release 0.14.0`.

**Verification:** `npm run check-version-bump && npm run verify && npm run secret-scan && npm run spec && npm run spec:check && node scripts/release-preflight.mjs --tag v0.14.0 --notes /tmp/notes.md`
**DoD:** Beide Versionen identisch, alle Gates grün, Preflight Exit 0, Tag gesetzt, kein Secret im Diff.

### Task 21: Finaler Validator (DoD und Traceability)

**Files:** keine (read-only Validator)
**Interfaces:** Consumes Task 1–20, Spec §7/§8/§11, die Trace-Tabelle in §6; Produces Abschluss-Verdict.
**Depends on:** 20
**parallel_group:** W5
**Size:** S
**Agent:** validator
**Stage:** validate-and-document
**ACs:** alle 56 ACs, 88 Tests
**Tests:** task-21 — `npm run verify`, `npm run spec:check`

- [ ] Step 1: Traceability prüfen — jede der 56 ACs hat genau eine grüne Task und mindestens einen Test; jeder der 88 Testfälle ist genau einmal zugeordnet.
- [ ] Step 2: DoD prüfen — Code komplett, Konventionen und Conventional Commits eingehalten, keine Regression, Tests vorhanden und grün.
- [ ] Step 3: `npm run verify` und `npm run spec:check` erneut ausführen; Ergebnis in den Ledger schreiben.
- [ ] Step 4: Verdict `APPROVED` oder `CHANGES_REQUESTED` mit Findings; critical/major blockieren den Abschluss.

**Verification:** `npm run verify && npm run spec:check`
**DoD:** 56/56 ACs und 88/88 Tests belegt; 0 critical, 0 major; keine offene Checkbox in den Wellen 0–5.

## 6. Traceability: AC → Task → Test

Jede AC steht in genau einer Zeile. „Grün in“ ist der Task, der das Verhalten implementiert; „IT-Beleg“ ist der Integrations-Task, der es end-to-end beobachtet.

| AC | Grün in | IT-/Unit-Beleg | Tests |
|---|---|---|---|
| AC-5.1 | Task 9 | Task 15 | IT-01 |
| AC-5.2 | Task 10 | Task 14 | IT-02 |
| AC-5.3 | Task 7 | Task 11 | UT-35, IT-03 |
| AC-5.4 | Task 7 | Task 11 | UT-16, IT-04 |
| AC-5.5 | Task 7 | Task 11 | UT-11, IT-05 |
| AC-5.6 | Task 9 | Task 12 | IT-06 |
| AC-5.7 | Task 9 | Task 12 | IT-07 |
| AC-5.8 | Task 9 | Task 12 | IT-08 |
| AC-5.9 | Task 6 | Task 14 | UT-17, IT-09 |
| AC-5.10 | Task 6 | Task 14 | UT-18, IT-10 |
| AC-5.11 | Task 6 | Task 14 | UT-18, IT-11 |
| AC-5.12 | Task 7 | Task 11 | UT-35, IT-12 |
| AC-5.13 | Task 4 | Task 11 | UT-10, IT-05 |
| AC-5.14 | Task 7 | Task 11 | IT-13, IT-41 |
| AC-5.15 | Task 7 | Task 11 | UT-23, IT-14 |
| AC-5.16 | Task 1 | Task 13 | RT-01, IT-15 |
| AC-5.17 | Task 7 | Task 13 | UT-12, UT-13, IT-16 |
| AC-5.18 | Task 7 | Task 13 | IT-17 |
| AC-5.19 | Task 7 | Task 13 | UT-14, IT-18 |
| AC-5.20 | Task 7 | Task 13 | UT-15, IT-42 |
| AC-5.21 | Task 8 | Task 14 | UT-19, UT-27, UT-30, IT-19 |
| AC-5.22 | Task 5 | Task 14 | IT-20 |
| AC-5.23 | Task 10 | Task 14 | UT-31, UT-33, IT-21 |
| AC-5.24 | Task 4 | Task 14 | UT-21, IT-22 |
| AC-5.25 | Task 1 | Task 13 | RT-01, IT-29 |
| AC-5.26 | Task 1 | Task 13 | RT-01, IT-30 |
| AC-5.27 | Task 1 | Task 13 | IT-31 |
| AC-5.28 | Task 1 | Task 13 | IT-32 |
| AC-5.29 | Task 10 | Task 14 | IT-33, RT-05 |
| AC-5.30 | Task 7 | Task 13 | UT-26, IT-34 |
| AC-5.31 | Task 7 | Task 13 | UT-26, IT-34 |
| AC-5.32 | Task 9 | Task 12 | UT-18, IT-43 |
| AC-5.33 | Task 9 | Task 12 | IT-44 |
| AC-F1 | Task 5 | Task 15 | UT-01 |
| AC-F2 | Task 5 | Task 15 | UT-02 |
| AC-F3 | Task 5 | Task 15 | UT-03 |
| AC-F4 | Task 5 | Task 15 | UT-04 |
| AC-F5 | Task 5 | Task 15 | UT-05 |
| AC-F6 | Task 5 | Task 15 | UT-06, IT-46 |
| AC-F7 | Task 5 | Task 15 | UT-07 |
| AC-F8 | Task 5 | Task 15 | UT-08, IT-28 |
| AC-F9 | Task 5 | Task 15 | UT-09, IT-27 |
| AC-F10 | Task 9 | Task 15 | IT-23 |
| AC-F11 | Task 9 | Task 15 | UT-21, IT-25 |
| AC-F12 | Task 9 | Task 15 | IT-24 |
| AC-F13 | Task 10 | Task 15 | UT-22, UT-28, IT-26 |
| AC-F14 | Task 5 | Task 15 | UT-24 |
| AC-F15 | Task 10 | Task 15 | IT-35 |
| AC-F16 | Task 9 | Task 15 | UT-36, IT-36 |
| AC-F17 | Task 5 | Task 15 | UT-07, IT-37 |
| AC-F18 | Task 5 | Task 15 | IT-38 |
| AC-F19 | Task 5 | Task 15 | UT-03, IT-39 |
| AC-F20 | Task 9 | Task 15 | UT-29, IT-38 |
| AC-F21 | Task 5 | Task 15 | UT-08, IT-40 |
| AC-F22 | Task 9 | Task 15 | UT-32, IT-45 |
| AC-F23 | Task 9 | Task 15 | UT-34, IT-46 |

**Summe:** 33 AC-5 + 23 Feature-/CLI-ACs = **56 ACs**. Testfälle: 36 UT + 46 IT + 6 RT = **88**.

### 6.1 Test-Inventar

| Test | Task | Test | Task | Test | Task |
|---|---|---|---|---|---|
| UT-01…UT-09 | Task 5 | UT-10, UT-11 | Task 4 | UT-12…UT-15 | Task 7 |
| UT-16 | Task 2 | UT-17, UT-18 | Task 6 | UT-19, UT-27 | Task 3 |
| UT-20 | Task 7 | UT-21 | Task 4 | UT-22 | Task 5 |
| UT-23 | Task 7 | UT-24 | Task 5 | UT-25 | Task 6 |
| UT-26 | Task 7 | UT-28 | Task 5/10 | UT-29 | Task 9 |
| UT-30, UT-31 | Task 8 | UT-32 | Task 7 | UT-33 | Task 10 |
| UT-34, UT-36 | Task 9 | UT-35 | Task 4 | — | — |
| IT-01 | Task 15 | IT-02 | Task 14 | IT-03…IT-05 | Task 11 |
| IT-06…IT-08 | Task 12 | IT-09, IT-10 | Task 14 | IT-11 | Task 14 |
| IT-12…IT-14 | Task 11 | IT-15…IT-18 | Task 13 | IT-19…IT-22 | Task 14 |
| IT-23…IT-27 | Task 15 | IT-28 | Task 14 | IT-29…IT-32 | Task 13 |
| IT-33 | Task 14 | IT-34 | Task 13 | IT-35…IT-40 | Task 15 |
| IT-41 | Task 11 | IT-42 | Task 13 | IT-43, IT-44 | Task 12 |
| IT-45, IT-46 | Task 15 | RT-01, RT-02 | Task 1/13 | RT-03…RT-06 | Task 14 |

## 7. Wellen-Gates und Commit-Gates

### 7.1 Wellen-Gates

| Gate | Erfüllung | Blockiert |
|---|---|---|
| **G0** | Task 1 gemergt; roter Lauf von RT-01/RT-02 belegt | W1 |
| **G1** | Task 2–5 + R1; `npm run typecheck`, vier Unit-Suiten grün; 0 critical/major | W2 |
| **G2** | Task 6–10 + R2; Surface-/SSRF-/Start-Suiten grün; 0 critical/major | W3 |
| **G3** | Task 11–15 + R3; 88/88 Tests vorhanden und grün; 0 critical/major | W4 |
| **G4** | Task 16–19 + R4; `npm run spec`, `npm run spec:check`, Doku-Assertions grün | W5 |
| **G5** | Task 20 + Task 21; `verify`, `secret-scan`, `spec:check`, Preflight, Tag grün; 56/56 ACs, 88/88 Tests | Abschluss |

### 7.2 Release-Kriterien 0.14.0

- [ ] Jede der 56 ACs ist genau einer Task zugeordnet und im genannten Commit grün.
- [ ] Merge-Reihenfolge W0 → W5 ist eingehalten; R1–R4 sind abgeschlossen.
- [ ] Keine neue Runtime-Dependency (NFR-4); `SCHEMA_VERSION` unverändert.
- [ ] Bundle-Budget gemessen und dokumentiert; keine präventive Erhöhung.
- [ ] `CHANGELOG.md` führt `Changed`/`Added`/`Security` für die Breaking-Punkte aus Spec §9.
- [ ] `docs/VIEWER.md`, `docs/DOCKER.md`, `README.md` beschreiben die eigene Origin und den Ein-Zeilen-Umzug.
- [ ] Version in `package.json` und `extension/manifest.json` ist identisch und auf `0.14.0` gesetzt.

### 7.3 Commit-Gates (jeder Commit)

- `npm run typecheck` grün; neue Tests zuerst rot beobachtet.
- `npm test` grün; keine `skip`/`only`-Marker.
- Bei Server-Änderungen: `npm run smoke:auth` grün.
- Bei `spec/**`-Änderungen: `npm run spec` erzeugt keinen unerwarteten Diff; `npm run spec:check` grün.
- Bei Doku-/Ignore-/Release-Änderungen: `npm run secret-scan` grün.
- Conventional Commit, Englisch, Imperativ, erste Zeile ≤ 72 Zeichen.

## 8. Risiken und Hot Files

### 8.1 Hot-File-Matrix

| Datei | Reihenfolge | Tasks | Anmerkung |
|---|---|---|---|
| `server/viewer.ts` | W1 → W2 | Task 4 → 7 | gestapelt, nie parallel |
| `server/handler.ts` | W2 → W2 | Task 6 → 8 | gestapelt |
| `server/hub.ts` | W1 → W2 → W2 | Task 5 → 9 → 10 | gestapelt |
| `server/admin.ts` | W1 | Task 2 | allein |
| `server/cors.ts` | W1 | Task 3 | allein |
| `tests/unit/viewer.test.ts` | W0 | Task 1 | spätere Tasks legen eigene Dateien an |
| `CHANGELOG.md` | W4 → W5 | Task 19 → 20 | Task 19 redaktionell, Task 20 Release-Kopf |
| `package.json` | W5 | Task 20 | nur `version` |
| `extension/manifest.json` | W5 | Task 20 | nur `version` |
| `docs/REQUIREMENTS.md`, `spec/**` | W4 | Task 16 | `spec/**` nur generiert |
| `Dockerfile`, `docker-compose.yml`, `docker/entrypoint.sh` | W4 | Task 18 | disjunkt von Doku |

### 8.2 Risiken

| ID | Risiko | Wirkung | Mitigation |
|---|---|---|---|
| RK-1 | Surface-Verzweigung falsch eingehängt | Notizen auf der falschen Fläche offen oder Viewer unbenutzbar | AC-5.9–5.11, UT-17/18, IT-09–11; eine `surfaceOf`-/Sperr-Implementierung |
| RK-2 | `respond()`-Reihenfolge umgeht Journal/Static/MCP | `/journal`, `--root`, `/mcp` auf der Viewer-Origin erreichbar | Task-10-Reihenfolge, IT-09/IT-33, R2-Fokus |
| RK-3 | `sessionCookie`-Signaturwechsel an einer Stelle vergessen | falsches/unsicheres Cookie | Task 4 + UT-10 + RT-01; eine Funktion, alle Aufrufer |
| RK-4 | DNS-TOCTOU/Rebinding | SSRF trotz Pre-Check | dokumentiert, Connection-Pinning Follow-up, private nur per exaktem Eintrag |
| RK-5 | Gleicher Hostname → Cookie-Leak an den Hub-Port | `bp_viewer` wird gesendet, aber vom Hub ignoriert | Warnung `viewer_cookie_shared_host`, Doku, eigener Hostname empfohlen |
| RK-6 | Last-writer-wins ohne Lock | externe Änderung zwischen `loadNotes` und `persist` geht verloren | innerhalb des Prozesses synchron; File-Lock Follow-up |
| RK-7 | Bestandsdeployments ohne `--viewer-port` brechen | Startfehler nach Upgrade | CHANGELOG/`docs/VIEWER.md` mit Ein-Zeilen-Umzug; bewusster Breaking-Slot |
| RK-8 | `--viewer-public-url` wird als Hub-Origin missverstanden | Launcher leitet auf 404 | Alias-Validierung, `viewer_origin_is_hub_origin`, `viewer_public_url_deprecated`, Doku |
| RK-9 | `--cors '*'` mit Viewer | Viewer-Code liest Hub-Journal/`/config`/`/health` | Verbot beim Parsen und nach `listen()`; AC-F15/IT-35 |
| RK-10 | `--viewer-port 0`/`--port 0` umgeht Parse-Prüfung | Origin-Konflikt nach `listen()` | Post-`listen()`-Validierung, Task 9/IT-36 |
| RK-11 | `--root` liefert `index.html` für Viewer-Pfade | Hub-Port zeigt Betreiber-Index statt 404 | `hubViewerPathRefusal()` vor Static; AC-5.29/IT-33 |
| RK-12 | Viewer-Context erhält `revokedTokens` nicht oder als Kopie | widerrufene Tokens öffnen Viewer-Routen weiter | explizite Allowlist mit derselben Set-Referenz; AC-5.32/UT-18/IT-43 |
| RK-13 | Server bedient vor der Origin-Auflösung | Launcher-Redirect auf `undefined`/relative Origin | feste Ports synchron vor `listen()`, `port 0` nach Binds, `503 service_not_ready` |
| RK-14 | Post-`listen()`-Fehler lässt `activeJournal` stehen | späterer Flush greift auf das Fehlstart-Journal | `activeJournal = null` in jedem Fehlerzweig; `activeJournalForTests()` |
| RK-15 | `OPTIONS`/`/health` rutscht hinter `authorize()` | Preflight oder Health-Probe wird `401` | verbindliche `gateRequest`-Reihenfolge; UT-31/IT-19 |
| RK-16 | Wildcard-Bind nur am expliziten `--viewer-host` geprüft | Docker-Entrypoint startet mit `http://0.0.0.0:<port>` | `viewer_origin_required` auf dem aufgelösten Bind; AC-F6/F23/IT-46 |
| RK-17 | CORS-Reflexion erreicht Fehlerpfade nicht | `400`/`401`/`404` ohne `Allow-Origin` | Request-Durchreichung; UT-30/IT-19 |
| RK-18 | Viewer-Door verschluckt `/health`, `/notes*`, `/sessions`, `/bundle` | Routen werden `404` statt bedient | Dispatch-Prädikat `surface === "viewer" && isViewerRequest()`, `null`-Rückfall; UT-31 |

## 9. Aufwand

Referenz: `effort-estimator` (Textverweis, keine Tool-Delegation). Die Schätzung ist eine Ausführungsplanung, keine Zusage; die Spec enthält bewusst keine Personentage.

| Welle | Tasks | Punktwert (Personentage) |
|---|---|---|
| W0 Baseline | Task 1 | 1,0 |
| W1 Bausteine | Task 2–5 | 6,0 |
| W2 Routing/Listener | Task 6–10 | 12,0 |
| W3 Integration | Task 11–15 | 7,5 |
| W4 Doku/Requirements | Task 16–19 | 4,0 |
| W5 Release/Validator | Task 20–21 | 2,0 |
| **Summe** | **21 Tasks + 4 Reviews** | **32,5** |

**Skala:** S = 0,5 · M = 1,0 · L = 2,0 · XL = 4,0 PT. Task 7 und Task 9 sind XL (SSRF/Launcher bzw. Doppel-Listener/Context-Allowlist); Task 4, 5, 6, 8, 10, 11–15 sind L. Band: 32,5 ± 25 % → **24,4 bis 40,6 Personentage**. Die Unsicherheit liegt in der Surface-Verzweigung (Task 6/8/10) und der Startatomarität (Task 9).

## 10. Re-Planung

Nach jeder Welle wird geprüft:

1. Halten die Annahmen aus §1 noch?
2. Ist die Datei-Ownership durch zwischenzeitliche Merges verletzt?
3. Ist eine AC-Beobachtungsdatei in einen anderen Task gewandert?
4. Hat ein Hot File einen weiteren Schreiber bekommen?
5. Schlägt ein Wellen-Gate fehl?

In jedem Fall wird der Plan nachgezogen — nie stillschweigend ausgeführt. Ein roter Integrationstest ist ein Finding an den besitzenden Implementierungs-Task, keine Test-Abschwächung.

## 11. Self-Review

- [x] Jede Pflichtsektion des Templates ist vorhanden: Header mit `**Spec:**`, `## Global Constraints`, `## File Structure`, `pipeline_stages`, Tasks mit `Files:`/`Interfaces:`/TDD-Steps, Self-Review.
- [x] `pipeline_stages` ist ein Stage-ID → Schritt-Nummer-Mapping (`implement: 1`, `document: 16`, `validate-and-document: 21`, `release: 20`); `parse_plan_ref()`/`validate_plan_ref()` lösen über die Task-Übersicht den Agenten auf.
- [x] Jeder Task-Header folgt `### Task <Nummer>: <Titel>`; `TASK_HEADER_RE` und `_parse_plan_tasks()` erkennen `Agent:`, `Files:` und `Depends on:`; alle Abhängigkeiten zeigen auf existierende, niedrigere Task-Nummern (azyklisch).
- [x] Jede der 56 ACs ist genau einer grünen Task und mindestens einem Test zugeordnet; die Summe 33 + 23 = 56 ist gegengeprüft.
- [x] Jeder der 88 Testfälle (36 UT + 46 IT + 6 RT) ist genau einmal im Test-Inventar zugeordnet.
- [x] Jede Task-Zeile der Task-Übersicht nennt genau eine Stage und einen Agent-Tier; die `implement`-Stage zeigt auf `developer` (in `allowed_agents`).
- [x] Keine Dateiüberlappung innerhalb einer Parallelgruppe; max. 4 parallele Tasks (W1-A, W3-A, W4-A).
- [x] Hot Files (`server/viewer.ts`, `server/handler.ts`, `server/hub.ts`) laufen strikt gestapelt.
- [x] Jeder Task nennt einen exakten Verifikationsbefehl und eine messbare DoD.
- [x] Kein offener Platzhalter, keine leere `Interfaces:`-Zeile, kein unausgefüllter Task.
- [x] Die Reihenfolge folgt der Vorgabe: Baseline/rote Tests → Implementierungswellen (Surface/Context, Doppel-Listener, Route-Gates, Auth/Ticket/Cookie, CORS, SSRF, Viewer-Shell/Proxy, CLI) → Review pro Welle → Requirements/Doku/Spec → Release → finaler Validator.
- [x] Der Release-Task nennt Version, `CHANGELOG`, die W4-Doku-/Docker-Artefakte, `npm run verify`, `npm run secret-scan`, `npm run spec`, `spec:check`, Release-Preflight und Tag.
- [x] Review-Task pro Welle (R1–R4) und finaler Validator (Task 21) sind vorhanden.
