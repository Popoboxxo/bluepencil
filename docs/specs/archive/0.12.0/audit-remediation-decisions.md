---
type: Plan
status: draft
topic: audit-remediation-decisions
target_version: 0.12.0
source: docs/reviews/system-audit-2026-11-02.md
updated: 2026-11-02
---

# Audit-Remediation 0.12.0 — Entscheidungsprotokoll

**Status: DRAFT — pending spec approval**

**Quelle:** `docs/reviews/system-audit-2026-11-02.md` (47 Findings: 10 BP / 28 SEC / 9 CQ; 0 critical, 2 high = BP-01 + SEC-13).
**Basis:** Repository-Stand 0.11.6, Branch `chore/system-audit`. Read-only-Verifikation: 16/18 high+medium bestätigt, 0 widerlegt, 0 bereits behoben, alle low bestätigt.
**Ziel:** 0.12.0 — alle Findings in **einem** Minor, einschließlich CQ-03.
**Charakter:** internes Entscheidungsprotokoll. Keine Implementierung, keine Spec, keine Freigabe.

## 1. Zweck und Umfang

Dieses Dokument hält die abschließenden Entscheidungen zu den Gates G1–G13 fest, die der Product Owner für die Audit-Remediation getroffen hat. Es begründet je Gate die Konsequenz und das verbleibende Restrisiko; Alternativen werden nicht mehr zur Diskussion gestellt. Grundlage sind der Audit vom 2026-11-02 und der Arbeitsentwurf `.tmp/audit-remediation-plan-draft.md`, dessen Wave-/WP-Struktur hier fortgeschrieben wird.

**Scope.** Alle 47 Findings werden in einem Minor bearbeitet. 0.x-Minor ist der Breaking-Slot des Projekts; deshalb sind die Vertragsbrüche aus G6 (Embed-Token-Attribut, FR-6.9) und G13 (FR-21) in 0.12.0 zulässig und werden im CHANGELOG als `Changed` bzw. `Removed` ausgewiesen. CQ-03 (`createLayer`-Split) ist enthalten, läuft aber als eigenes Epic am Ende der Linie.

**Nicht Inhalt.** (1) Die Specs S1–S5 sind eigene Dokumente (Status `draft`, §7). (2) Dieses Protokoll enthält keine PR- und Dateiplanung im Detail. (3) Die drei Follow-ups aus §4 sind ausdrücklich nicht Teil von 0.12.0. Der Plan-Gate bleibt geschlossen, bis die betroffenen Specs `APPROVED` sind; WPs ohne Vertragsänderung dürfen nach Annahme dieses Protokolls starten.

**Verbindlichkeit.** Die Entscheidungsspalte in §2 ist bindend. Begründung und Konsequenz sind die Grundlage für die Akzeptanzkriterien der Specs. Widerspricht eine Spec diesem Dokument, wird das Dokument revidiert — es wird nicht still umgedeutet.

## 2. Entscheidungstabelle

| Gate | Entscheidung | Begründung | Konsequenz | Findings | Restrisiko |
|---|---|---|---|---|---|
| **G1** | **B** — Nicht-Loopback-Bind ohne Credential bleibt erlaubt, die Warnung ist nicht unterdrückbar (auch nicht mit `--quiet`) | Ein Refusal bräche bestehende LAN-/Lab-Setups ohne Migrationspfad; die Warnung macht den Zustand sichtbar, ohne den Betrieb zu verweigern | Startwarnung auf stderr; FR-6.7 Titel und Akzeptanz angepasst; Journal behält `location` + `author`; SEC-10 wird dokumentations-only | SEC-01, SEC-10 | Bediener ignoriert die Warnung; Notes, Journal-Pfad und Autor-Identität bleiben auf einem unauthentifizierten Hub lesbar — akzeptiert und dokumentiert |
| **G2** | **A** — ein gemeinsamer Throttle-Mechanismus für jeden Secret-Vergleich; getrennte Budgets je Credential-Art; 16-Zeichen-Floor auch für `--auth-secret` | Der `AdminThrottle` existiert bereits und deckt die Lücke auf `/notes`; ein zweiter Mechanismus wäre eine zweite Wahrheit | `authorize()` nutzt den Admin-Throttle, Budget pro Peer und Credential-Art, 429 nach N Fehlversuchen; Floor in `parseHubArgs` + Doku | SEC-03, SEC-07 | Online-Rate bleibt pro Peer begrenzt, nicht global; bestehende kurze `--auth-secret`-Werte brechen den Start (CHANGELOG-Hinweis) |
| **G3** | **A** — FR-17…FR-20 dokumentieren das heute ausgelieferte Verhalten mit testbaren Akzeptanzkriterien; FR-20-AC kommen aus den CQ-04-Tests; **kein** Requirement-ID-Check-Skript in `verify` | Die Features sind ausgeliefert; die Spec soll den Ist-Stand abbilden, nicht neue Features erfinden. Ein ID-Check wäre ein zusätzliches Gate ohne eigenen Nutzen, solange die Tabelle vollständig ist | `docs/REQUIREMENTS.md` + `npm run spec`; das bestehende spec-Sync-Gate bleibt; ID-Abdeckung wird im Review geprüft | BP-01, CQ-04 | Ohne automatischen Check kann eine künftige Lücke wie BP-01 erneut entstehen; abgedeckt durch Review-Pflicht |
| **G4** | **A** — IIFE + Element sind die bindenden Gates. Core-Gate = gemessen + 10 % (gemessen **nach** dem Voice-Rückbau). IIFE/Element = gemessen + 1,0–1,5 kB. NFR-3-Headline wird durch die realen Zahlen inkl. Messdatum ersetzt | Die IIFE-Grenze greift zuerst; ein 100-kB-Core-Budget kann nie fehlschlagen. Der Voice-Rückbau schafft Platz, der nicht als stiller Puffer dienen soll | `scripts/size-guard.mjs`: Header + Schwellen; Messung bei Release-Cut nach Wave 1; Erhöhung nur mit Begründung im PR | BP-04 | „gemessen + 10 %“ ist eine Momentaufnahme; das nächste UI-Feature kann erneut eine Erhöhung erzwingen — Headroom bleibt eigenes Ticket |
| **G5** | **B** (korr. 2026-11-02, RVW-02) — `origin` wird Teil des Note-Kontexts **und** der Extension-Storage wird pro Origin geschlüsselt. Legacy-Notes lesen als `origin: null` und sind nach dem Upgrade **nicht** im Page-Overlay sichtbar; read-only sichtbar bleiben sie nur auf der Extension-Review-Seite, wo Copy-only Assign eine Kopie in einen per-Origin-`v2`-Store legt (korr. 2026-11-02, RVW2-09); kein Import-Dialog, keine Datenlöschung | Der Cross-Site-Read ist der Kern des High-Findings; Per-Origin-Scoping schließt ihn, ohne Note-Daten zu verlieren. Der Legacy-Blob hat kein `origin`-Feld, jeder Page-Kontext-Read wäre also nicht auf die aktuelle Site filterbar und würde Notes aller Sites zeigen (SEC-13); der Blob bleibt unangetastet — das erhält die Daten | **Kein Schema-/Bundle-Bump** (`SCHEMA_VERSION = 1`); Canonical emittiert `origin` immer (`null` inkl.), daher ändert sich der Hash jedes Bundles (CHANGELOG); Key `bluepencil:v2:<origin>` (**plain**); Bridge leitet den Key aus `location.origin` ab und ignoriert den Page-Key; `get` nur auf den eigenen Key; Cross-Site-Ansicht nur auf Extension-Seiten; **sichtbare Regression** für Vor-0.12-Notes (sie verschwinden aus dem Overlay), zu nennen in CHANGELOG und `docs/EXTENSION.md` | SEC-13 | Legacy-Notes bleiben ohne Origin und ohne automatische Zuordnung; Backfill ist Follow-up. Die Review-Seite bleibt ein breiter Lesezugriff innerhalb der Extension |
| **G6** | **A** — der Service Worker setzt den Auth-Header selbst; der Page-Relay empfängt/strippt keinen Auth-Header; `token*`-Attribute und `__bluepencilConfig__.token` entfallen; Page-`get("bluepencil:settings")` wird verweigert. Shared Secret wird im Options-UI als legacy/deprecated markiert, per-Gerät signed tokens empfohlen. Bricht den Embed-Token-Attribut-Vertrag (FR-6.9) in 0.12.0 | Das Credential im Page-Kontext ist die Ursache (DOM-Attribut, Window-Global, Storage-Relay); der SW ist bereits der einzige Hub-Client | FR-6.9 neu gefasst; CHANGELOG `Changed`/`Breaking`; `docs/EXTENSION.md` und `docs/EMBED.md` angepasst | SEC-14 | Hosts mit Token-Attribut verlieren die Hub-Auth ohne Migrationspfad (bewusst, minor = Breaking-Slot); ein verteiltes Shared Secret bleibt bis zur Rotation gültig |
| **G7** | **B** — fehlendes `sha256` ist ein Fehler, wenn `data-integrity="true"`; host-pinnbares `data-sha256` ist optional; Ausführung bleibt ein normaler Modul-Import; die Doku nennt es nicht mehr SRI und sagt, dass echte Assurance den Host-Pin braucht. `manifest.element` muss **nicht** same-origin sein (CDN erlaubt, Warnung ohne Host-Pin) | Fail-open bei Opt-in ist falsch; TOCTOU-freie Ausführung ist ein eigener Umbau (Follow-up), der Host-Pin ist der einzige echte Trust-Anchor | `attach.ts`/`version.ts`: Fehlerpfad + Warnung; `docs/EMBED.md`: Begriff und Vertrag; bestehende Hosts mit `data-integrity="true"` und Manifest ohne `sha256` brechen sichtbar | SEC-16 | Der Digest bleibt ein Download-Check, keine Ausführungsgarantie; ohne Host-Pin ist er durch eine kompromittierte Manifest-Quelle aushebelbar; CDN ohne Pin wird nur gewarnt |
| **G8** | **A** — `route="url"` speichert nur den PATH; `route="url-with-query"` ist das explizite Opt-in für den vollen Query; Allow-/Deny-Konfiguration erlaubt Hosts, ausgewählte Parameter zu behalten, ohne auf Full-Query zu gehen. Die Extension folgt dem neuen Default | Query-Strings tragen regelmäßig Secrets; Path-only ist der sichere Default, ohne Deep-Link-Kontext vollständig zu opfern | `src/embed/attributes.ts`, Element, Loader-Forwarding, `extension/src/handoff.ts`; Doku `EMBED.md`/`EXTENSION.md`; Tests für Path, Full-Query, Allow/Deny | SEC-19 | Bestehende Notes behalten ihre gespeicherten Query-Strings; keine rückwirkende Bereinigung. Hosts ohne Allow/Deny verlieren Parameter |
| **G9** | **A** — `optional_host_permissions`; die Hub-Origin wird beim Speichern des Endpoints angefragt; Seiten nutzen `activeTab` + `executeScript` zur Klickzeit; keine persistente MAIN-World-Registrierung; `__bluepencilTryMount` existiert nur bei vorhandener Konfiguration | Least Privilege; die All-Sites-Permission ist nur für Hub und annotierte Seiten nötig und macht SEC-15 erst möglich | Manifest-Wechsel = Web-Store-Review; `sw.ts`/`bootstrap.ts`/`options.ts`; `smoke:ext` deckt Background-Tab und fehlenden Grant ab; `webstore-rules.test.ts` prüft die Manifestfelder | SEC-20, SEC-15 | Nutzer müssen die Hub-Origin einmal bestätigen; ohne Grant schlägt der Hub-Modus fehl (klare Fehlermeldung nötig). Programmatisches Mounten aus der Page entfällt |
| **G10** | **A** — jede Action wird auf Commit-SHA gepinnt (Tag als Kommentar, Dependabot hebt an). `wdzeng/chrome-extension` wird durch ein In-Repo-Web-Store-API-Skript ersetzt (Upload + Publish); erster Lauf **upload-only** + manuelle Freigabe | Ein Single-Maintainer-Action erhält Client-Secret und Refresh-Token; ein gepinntes In-Repo-Skript ist reviewbar und hat keinen Drittanbieter-Lieferanten | alle `uses:` in fünf Workflows; neues Skript + npm-Script; `chrome-webstore.yml` umgebaut; erste Veröffentlichung manuell; Dependabot für Actions/Docker | SEC-22 | Der Refresh-Token bleibt ein High-Value-Secret in den Repo-Secrets; ein kompromittierter Commit am Skript hat volle Publish-Rechte (normaler Code-Review-Radius); SHA-Pins müssen gepflegt werden |
| **G11** | **A** — veröffentlichter Port default `127.0.0.1`; Image auf die exakte Version gepinnt (nicht `:latest`); `read_only: true`, `tmpfs: /tmp`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`. Digest-Pinning ist für Produktions-Deploys dokumentiert, nicht Compose-Default | Ein Default, der ein Klartext-Credential ins LAN publiziert, ist die falsche Voreinstellung; das Hardening ist ohne Funktionsverlust möglich | beide Compose-Dateien; `docs/DOCKER.md` mit Widening- und TLS-Proxy-Anleitung; `smoke:docker`; `docker compose config` | SEC-24 | Deployments, die auf `:latest` und LAN-Erreichbarkeit setzen, brechen sichtbar; `read_only` erfordert alle Schreibpfade unter `/data` und `/tmp` |
| **G12** | **A** — IP-Klassifikation härten (6to4 `2002::/16` entpacken; `198.18.0.0/15`, `240.0.0.0/4`, `255.255.255.255` als nicht-öffentlich), Kommentar auf „pre-check, not pinning“ umformulieren, Tests ergänzen. Connection-Pinning bleibt **offen** und dokumentiert. Docker-Entrypoint gibt das Secret nicht mehr aus; zeigt Pfad + Abrufkommando; `BLUEPENCIL_SHOW_SECRET_ONCE=1` als Opt-in | Die Klassifikationslücken sind eng und testbar; echtes Pinning braucht einen Agent-/Dispatcher-Umbau. Secret-Echo in Logs ist unnötig, der Dateipfad genügt | `net-policy.ts` + Tests; Kommentar in `client.ts`; `docker/entrypoint.sh` + Doku + Test | SEC-11, SEC-12 | Das Re-Resolution-Fenster (TOCTOU) bleibt offen; Registry-Einträge sind operator-kontrolliert, was die Exposition begrenzt. Skripte, die das Secret aus den Logs lesen, brechen |
| **G13** | **A** — Voice-Diktat wird vollständig entfernt: `src/ui/voice.ts`, Composer-/Layer-Verdrahtung, `voice`/`voice-engine`-Attribute, i18n-Keys, `examples/voice/`, `scripts/voice-smoke.mjs`, Components-Matrix-Eintrag, npm-Script, alle Doku. Alte Attribute werden still ignoriert. FR-21.1–21.8 werden als *withdrawn in 0.12.0* markiert (IDs nicht wiederverwendet), `spec/21-voice/` gelöscht. CHANGELOG erhält `Removed`. Doku nennt es nirgends mehr | Das Feature ist der größte Bundle- und Wartungsposten ohne Kernnutzen; der Rückbau schafft Budget für G4 und entfernt einen Gadget-Pfad (`voice-engine`) | Dateien/Skripte/Beispiele entfallen; `attributes.ts`/`layer.ts`/`composer.ts` schrumpfen; Budget-Messung für G4 danach; `spec/` neu generiert | keine Finding-Nummer (Produktentscheidung); berührt SEC-21 und CQ-02/CQ-07 | Hosts verlieren die Diktatfunktion ohne Ersatz in 0.12.0; alte Attribute bleiben wirkungslos, ohne Fehler zu erzeugen; externe Integrationen außerhalb des Repos werden nicht automatisch angepasst |

## 3. Gate-Details

Nur die Gates mit nicht offensichtlicher Konsequenz werden hier ausgeführt. G2, G3, G4, G7, G9 und G11 sind durch die Tabellenzeile vollständig beschrieben. Die vier Nachträge aus dem S1-Review stehen am Ende des Abschnitts.

### G1 — Nicht-Loopback-Bind ohne Credential

Die Entscheidung ist **B (warnen, nicht verweigern)**. `--quiet` bleibt für den übrigen Start-Banner wirksam; die neue Warnung ist davon ausgenommen und erscheint bei jedem Start.

| Bind | Credential | Verhalten in 0.12.0 |
|---|---|---|
| Loopback | egal | unverändert |
| Nicht-Loopback | vorhanden | unverändert |
| Nicht-Loopback | fehlt | Hub startet; nicht unterdrückbare Warnung auf stderr |

Das Journal behält `location` und `author`. Beide Felder werden in FR-6.7 als akzeptiertes Risiko dokumentiert; SEC-10 ist damit dokumentations-only und erzeugt keine Code-Änderung. Konsequenz: Ein unauthentifizierter Hub exponiert weiterhin die Notes und zusätzlich den Journal-Pfad sowie `Name <E-Mail>` des Git-Autors. Das ist bewusst akzeptiert, weil der Hub in diesem Modus ohnehin ungeschützt ist. Umsetzung: WP 2.1 (Warnung) und WP 2.7 (FR-6.7-Text).

### G5 — Per-Origin-Storage und `origin` im Note-Kontext

> **Korrektur 2026-11-02 (RVW-02).** Tabellenzeile und Detail fassten `origin` zuvor als Schema-/Migrationsbump und den Storage-Key als Hash auf. Das widersprach dem bindenden Design (D4/D6) und der S1-Spec; die folgenden Fassungen ersetzen diese Aussagen.

- **Datenmodell:** `origin` (String oder `null`) ist additiv-optional wie `severity`/`priority` (`Note.origin?: string | null`; `NotePatch` ohne `origin`). Canonical emittiert `origin` deterministisch immer (`null` inklusive). **Kein Schema-Version-Bump, kein Bundle-Version-Bump** (`SCHEMA_VERSION = 1`); `migrate.ts` setzt für 0.11-Input `origin: null`. Konsequenz: der kanonische Hash **jedes** Bundles ändert sich in 0.12.0; das CHANGELOG weist es aus.
- **Extension-Storage:** Key ist der **plain** `bluepencil:v2:<origin>`, kein Hash. Begründung: ein FNV-Hash ist offline auf eine Ziel-ID grindbar, `crypto.subtle` fehlt auf `http:`-Seiten (kein Secure Context); der Key-Name ist kein Secret, die Grenze kommt aus der Key-Ableitung, nicht aus Key-Obscurity. Der Bridge leitet den Key aus `location.origin` ab und ignoriert den Page-Key; `get` nur auf den eigenen Key. Der Legacy-Blob `bluepencil:default:v1` wird nicht gelöscht.
- **Legacy-Notes (`origin: null`):** nach dem Upgrade **nicht** im Page-Overlay sichtbar; read-only sichtbar nur auf der Extension-Review-Seite, wo Copy-only Assign eine Kopie in den per-Origin-`v2`-Store legt. Begründung: der Legacy-Blob hält Notes **aller** Sites und hat kein `origin`-Feld — ein Page-Kontext-Read wäre nicht auf die aktuelle Site filterbar und würde SEC-13 wieder öffnen. Der Blob bleibt unverändert; genau das erhält die Daten. Kein Import-Dialog, keine Datenlöschung. Sichtbare Regression für Vor-0.12-Notes: im CHANGELOG und in `docs/EXTENSION.md` zu nennen. *(korr. 2026-11-02, RVW2-09)*
- **Cross-Site-Ansicht:** existiert nur auf Extension-Seiten (Options/Review), nie im Page-Kontext.

Restrisiko: Alte Notes werden nicht automatisch zugeordnet; ein Backfill ist Follow-up (§4). Die Review-Seite bleibt ein bewusst breiter Lesezugriff, aber innerhalb der Extension und nicht im Page-Kontext.

### G6 — Credential verlässt die Page

| Oberfläche | Heute | 0.12.0 |
|---|---|---|
| DOM-Attribut `token*` auf `<bluepencil-notes>` | vom Bootstrap geschrieben | entfällt |
| `window.__bluepencilConfig__` | enthält das ganze Settings-Objekt inkl. Token | Token entfällt |
| Page-`get("bluepencil:settings")` über das Storage-Relay | erlaubt | verweigert |
| Auth-Header auf dem Page-Relay | von der Page gesetzt | SW setzt `authorization`/`x-bluepencil-auth` selbst; das Relay strippt bzw. filtert sie |

Die Umstellung ist ein Commit-Verbund: erst SW-Injection, dann Attribut-/Global-Entfernung, damit kein Zwischenstand mit gebrochener Hub-Auth entsteht. FR-6.9 wird neu gefasst. Der Bruch ist in 0.12.0 zulässig, weil 0.x-Minor der Breaking-Slot ist. Das Shared Secret wird im Options-UI als legacy/deprecated markiert; per-Gerät signed tokens werden empfohlen. Restrisiko: Hosts mit Token-Attribut verlieren die Hub-Auth ohne Migrationspfad; ein einmal verteiltes Shared Secret bleibt bis zur Rotation für alle annotierten Seiten gültig.

### G8 — Route-Semantik

| `route` | gespeicherter Wert | Default |
|---|---|---|
| `url` | nur `pathname` | ja |
| `url-with-query` | `pathname` + `search` | opt-in |
| Allow-/Deny-Konfiguration | `pathname` + ausgewählte Query-Parameter | opt-in |

Die Extension setzt künftig den Path-Default (`handoff.ts` schreibt heute hart `route:"url"`). Bestehende Notes werden nicht umgeschrieben. Die konkreten Allow-/Deny-Schlüssel sind Spec-Detail (S2); entschieden ist nur, dass beide Richtungen möglich sind. Restrisiko: gespeicherte Alt-Notes behalten Query-Strings inklusive möglicher Secrets; es gibt keine rückwirkende Bereinigung. Der volle Query bleibt eine bewusste Opt-in-Exposition.

### G10 — Supply Chain und Web-Store-Pfad

Pin-Regel: `uses: owner/action@<40-hex>` plus `# vX.Y.Z` als Kommentar. Dependabot hebt SHA und Kommentar gemeinsam. Betroffen sind `ci.yml`, `release.yml`, `extension.yml`, `pages.yml` und `chrome-webstore.yml`.

Der Web-Store-Teil wird durch ein In-Repo-Skript gegen die Chrome-Web-Store-API ersetzt (Upload + Publish). Der erste Lauf ist **upload-only** mit manueller Freigabe im Dashboard, damit der neue Pfad nicht sofort veröffentlicht. Restrisiko: Der Refresh-Token bleibt ein High-Value-Secret; SHA-Pins müssen aktuell gehalten werden. `wdzeng/chrome-extension` verschwindet als Lieferant, nicht als Risikoklasse — eigener Code ist reviewbar, aber ebenfalls angreifbar.

### G12 — IP-Klassifikation und Secret-Echo

| Fall | Klassifikation heute | 0.12.0 |
|---|---|---|
| `2002::/16` (6to4) | public | eingebettete IPv4 entpacken und klassifizieren |
| `198.18.0.0/15` | public | nicht-öffentlich |
| `240.0.0.0/4` | public | nicht-öffentlich |
| `255.255.255.255` | public | nicht-öffentlich |
| Re-Resolution Check → Connect | offen | offen (Follow-up) |

Der Kommentar in `client.ts` wird auf „pre-check, not pinning“ umformuliert; die Tests decken 6to4, Benchmarking, Reserved und Broadcast ab. Connection-Pinning (im Connect ausschließlich die validierte Adresse verwenden) bleibt offen und dokumentiert.

Docker: Der Entrypoint zeigt standardmäßig nur den Pfad und das Abrufkommando (`docker exec … cat /data/.bluepencil-auth`); das vollständige Secret erscheint nur mit `BLUEPENCIL_SHOW_SECRET_ONCE=1`. Restrisiko: Das TOCTOU-Fenster bleibt; Secret-Ausgabe in Logs ist als Opt-in weiter möglich; bestehende Skripte, die das Secret aus den Logs lesen, brechen.

### G13 — Voice-Rückbau

- **Code:** `src/ui/voice.ts`, die Verdrahtung in `src/ui/layer.ts` und `src/ui/composer.ts`.
- **Öffentliche Oberfläche:** Attribute `voice` und `voice-engine` (Element, Loader, `ALL_ATTRIBUTES`), i18n-Keys in `src/i18n/{en,de}.ts`.
- **Beispiele/Skripte:** `examples/voice/`, `scripts/voice-smoke.mjs`, npm-Script, Eintrag in der Components-Matrix.
- **Doku:** alle Erwähnungen, u. a. `docs/EMBED.md`, `docs/INTEGRATION.md`, README.
- **Requirements:** FR-21.1–21.8 werden als *withdrawn in 0.12.0* markiert; die IDs werden nicht wiederverwendet. `spec/21-voice/` wird gelöscht, `spec/` neu generiert.
- **CHANGELOG:** eigener `Removed`-Abschnitt; danach nennt keine Doku das Feature mehr.

Alte Attribute werden still ignoriert (kein Throw, kein Layout-Bruch). Der Rückbau entfernt gleichzeitig den `voice-engine`-Gadget-Pfad aus SEC-21 sowie die `voice.ts`-Fundstellen aus CQ-02 und CQ-07. Er läuft vor WP 0.2, weil G4 die Budgets nach dem Rückbau messen lässt, und vor den Attribut-WPs aus G6/G8, weil alle dieselbe Datei `src/embed/attributes.ts` besitzen. Restrisiko: Hosts verlieren die Diktatfunktion ohne Ersatz in 0.12.0; externe Integrationen außerhalb des Repos werden nicht automatisch angepasst.

### Nachträgliche Entscheidungen aus dem S1-Review (2026-11-02)

Vier Befunde des S1-Reviews verlangten eine Produktentscheidung; sie sind hier verbindlich festgehalten.

| RVW | Entscheidung | Begründung | Restrisiko |
|---|---|---|---|
| RVW-01 | **Copy-only Assign.** „Assign to origin“ kopiert eine Note unter derselben Note-ID in den Ziel-Store; der Legacy-Blob `bluepencil:default:v1` wird nie geschrieben. Die Review-Seite dedupliziert nach ID. Undo = Löschen der `v2`-Kopie, **nur für nachweislich kopierte IDs** (Provenienz-Sidecar `bluepencil:assign:<origin>`, Compare-and-Set auf den Ziel-Blob). | Legacy bleibt echt read-only, kein Datenverlust, kein TOCTOU auf dem Legacy-Blob; ohne Provenienz würde Undo eine vor dem Assign vorhandene Ziel-Note löschen (RVW2-04). | Doppelte ID in Legacy und Ziel, bis die Kopie gelöscht wird; die Dedupe ist Pflicht. |
| RVW-14 | **Downgrade nicht unterstützt.** Der 0.11-Page-Relay erlaubt `get` auf jeden Key; ein Downgrade öffnet SEC-13 für `v2`-Daten erneut. CHANGELOG und `docs/EXTENSION.md` nennen „clear extension storage before downgrading“. Kein Lock-Mechanismus. | Ein Lock oder eine Umbenennung wäre ein eigener Migrationspfad ohne Datenverlust-Garantie. | Wer ohne Storage-Clear downgradet, exponiert die `v2`-Daten cross-site; es gibt keinen technischen Schutz. |
| RVW-16 | **`file://` ist memory-only.** Kein Origin, kein persistenter Bucket; der Zustand wird im UI-Status (Badge `mem`/Titel) sichtbar gemacht; `element.issues` bleibt der Attribut-Diagnose vorbehalten, ein Store→Element-Kanal wäre eine Core-Änderung außerhalb von S1 (korr. 2026-11-02, gegen `src/element/index.ts` geprüft); die Doku nennt local adapter oder Hub als Alternative. | `file:` hat keinen normalisierbaren Origin; ein separater Bucket wäre ein neuer Shared-Store. | Notizen auf `file://` überleben den Reload nicht (0.11 konnte persistieren); bewusste Regression. |
| RVW-15 | **Gemischte Versionen sind breaking.** Ein 0.12-Client gegen einen 0.11-Hub scheitert an `origin` (unknown field), und der Hub ignoriert den `origin`-Filter. Hub und Client werden gemeinsam aktualisiert; kein Field-Shaping im Transport. | Bewusste Abweichung von Design D6/§4 (»Client muss es weglassen«); stilles Feld-Shaping würde den Vertrag verwischen. | Rollout-Kopplung: kein gemischter Betrieb während des Upgrades. |

## 4. Follow-ups (nicht in 0.12.0)

| Follow-up | Herkunft | Warum nicht in 0.12.0 | Auslöser |
|---|---|---|---|
| Connection-Pinning | SEC-11 | braucht einen Agent-/Dispatcher-Umbau und ein eigenes Threat Model; die Klassifikation ist der sichere Teil | nächster Föderations-Sicherheitszyklus |
| Echte SRI-Durchsetzung | SEC-16 | Ausführung verifizierter Bytes (Blob-URL oder `integrity` am Script) ändert CSP- und Bundle-Pipeline | nach Host-Pin-Adoption |
| Origin-Backfill | G5 | Werkzeug für den Altbestand, kein Blocker für den sicheren Default; Legacy bleibt read-only sichtbar | wenn das Legacy-Volumen den Aufwand rechtfertigt |

Kein weiteres Finding wird zurückgestellt; diese drei Punkte sind die einzigen bewusst offenen Reste.

## 5. Wellenmodell 0.12.0

Die Wellen sind Datei-Cluster, nicht zwingend Kalenderreihenfolge. Zwei Reihenfolgen sind bindend: **Wave 1 (Voice)** vor WP 0.2 und vor allen Attribut-WPs; **Wave 9 (CQ-03)** zuletzt. Wave 0.1 (FR-17…FR-20, FR-21 withdrawal) ist die Voraussetzung für Wave 1 und alle spec-gated WPs.

| Wave | Ziel | WPs | Findings | Reihenfolge |
|---|---|---|---|---|
| **0** | Requirement-/Spec-Wahrheit | 0.1, 0.3, 0.4, 0.5; 0.2 nach W1 | BP-01, BP-02, BP-03, BP-04, CQ-04 | 0.1 → 0.3/0.5; 0.2 nach W1 |
| **1** | Voice-Rückbau (vorgezogen) | 1.1 | G13 (berührt SEC-21, CQ-02/CQ-07) | nach 0.1, vor 0.2 und W3 |
| **2** | Hub-Gate | 2.1–2.7 | SEC-01, SEC-02, SEC-03, SEC-04, SEC-06, SEC-07, SEC-08, SEC-10 | 2.2 → 2.3 → 2.4 (Datenfluss) |
| **3** | Client-Vertrag (Extension + Embed) | 3.1–3.7 | SEC-13, SEC-14, SEC-15, SEC-16, SEC-19, SEC-20, CQ-05, CQ-06 | 3.2 vor 3.4/3.5; 3.1 + 3.2 als Verbund |
| **4** | Data-Dedup | 4.1–4.3 | CQ-01, CQ-02, BP-07 | 4.1 → 4.2 → 4.3 |
| **5** | Federation Outbound | 5.1, 5.2 | SEC-05, SEC-11 | 5.1 → 5.2 |
| **6** | CLI | 6.1 | BP-06, BP-08 | nach 4.1 |
| **7** | CI / Supply Chain | 7.1–7.3 | SEC-22, SEC-27, SEC-28 | parallel |
| **8** | Container | 8.1–8.4 | SEC-12, SEC-24, SEC-25, SEC-26 | parallel |
| **9** | CQ-03-Epic | 9.1–9.5 | CQ-03 | nach UI-Freeze, zuletzt |

Der Quick-Win-Batch (`BP-05`, `BP-09`, `BP-10`, `SEC-09`, `SEC-17`, `SEC-18`, `SEC-21`, `SEC-23`, `CQ-07`, `CQ-08`, `CQ-09`) läuft datei-disjunkt parallel zu Wave 0. **SEC-12 wandert aus dem Quick-Win-Batch nach Wave 8**, weil es dieselbe Credential-/Log-Entscheidung wie G12 ist.

Begründung der bindenden Reihenfolgen:

- **0.1 zuerst.** Vertragsänderungen (FR-6.9, FR-21, Route-Default, Storage-Semantik) brauchen ihre REQ-Zeile und Akzeptanzkriterien vor dem Code, sonst blockiert der Spec-Gate den PR.
- **Voice vor Attribut-WPs.** `src/embed/attributes.ts` ist ein Single-Owner-File für G13, G6 und G8; drei parallele Bearbeitungen erzeugen garantiert Konflikte. Der Rückbau zuerst entfernt zudem die Messgrundlage für G4.
- **G6 als Commit-Verbund.** Die Attribut-/Global-Entfernung darf nicht vor der SW-Injection landen, sonst gibt es einen Zwischenstand mit gebrochener Hub-Auth.
- **CQ-03 zuletzt.** `createLayer` ist die Funktion, die jeder UI-Fix anfasst; ein früher Split würde die Zeilen-Assertions in `ui.test.ts` entwerten und Konflikte auf denselben 1.755 Zeilen vervielfachen.

## 6. Aufwand

| Wave | Aufwand (Personentage) | Anmerkung |
|---|---|---|
| Quick-Win-Batch | 2–3 | sofort startbar |
| 0 — Requirement/Spec-Wahrheit | 2–4 | inkl. Review der Specs S1–S5 |
| 1 — Voice-Rückbau | 3–4 | neue WP, entfernt Code und Doku |
| 2 — Hub-Gate | 6–8 | Host-Check, Throttle, Secret-Floors |
| 3 — Client-Vertrag | 11–15 | Per-Origin-Storage (ohne Schema-Migration), Credential-Isolation, Permissions |
| 4 — Data-Dedup | 2–3 | rein intern |
| 5 — Federation Outbound | 3–4 | Body-Cap/Deadline + Klassifikation |
| 6 — CLI | 1–1,5 | nach 4.1 |
| 7 — CI / Supply Chain | 2–3 | In-Repo-Web-Store-Skript |
| 8 — Container | 1–2 | Compose + Entrypoint |
| **Summe ohne CQ-03** | **33–47** | ersetzt die 28–40 aus dem Arbeitsentwurf |
| 9 — CQ-03-Epic | 8–12 | eigenes Epic, fünf gestapelte PRs |
| **Gesamt** | **41–59** | |

Der Zuwachs gegenüber dem Entwurf kommt vor allem aus dem Voice-Rückbau (+3–4) und dem größeren Extension-/Client-Vertrag (+2–4), dazu kleinere Zuschläge für Hub-Gate und CI. Die Bandbreite ist eine Vorabschätzung; eine belastbare Schätzung je WP liefert der `effort-estimator` vor dem jeweiligen Spec-Review.

## 7. Specs S1–S5

| ID | Titel | Gates | Findings | Status |
|---|---|---|---|---|
| **S1** | Extension Trust Boundary 0.12.0: per-origin storage, credential isolation, optional permissions | G5, G6 (Extension-Mechanik), G9 | SEC-13, SEC-14, SEC-15, SEC-20 — Review `RVW-01…RVW-26`, `RVW2-01…RVW2-20` | `draft` |
| **S2** | Embed- und Route-Vertrag 0.12.0: token attributes, route semantics, integrity host pin | G6 (Host-Vertrag), G7, G8 | SEC-14, SEC-16, SEC-19 | `draft` |
| **S3** | Hub-Authentifizierung 0.12.0: bind warning, shared throttle, secret floors, Host check | G1, G2 | SEC-01, SEC-02, SEC-03, SEC-04, SEC-07, SEC-10 | `draft` |
| **S4** | Requirement-Baseline 0.12.0: FR-17…FR-20, FR-21 withdrawal, NFR-3 budget | G3, G4, G13 | BP-01, BP-04, CQ-04 | `draft` |
| **S5** | Federation Outbound Policy 0.12.0: response bounds and IP classification | G12 (Föderationsteil) | SEC-05, SEC-11 | `draft` |

**Eigentumsgrenze.** G6 erscheint in S1 und S2 mit getrenntem Eigentum: S1 besitzt die Extension-Mechanik (SW-Injection, Storage-Key, Permissions), S2 den hostseitigen Vertrag (Attribute, Route, Integrity). Kein Verhalten und keine Datei hat zwei Spec-Eigentümer.

**S1-Review.** Die Befunde `RVW-01…RVW-26` stehen in `docs/specs/2026-11-02-s1-extension-trust-boundary-review.md`, die Nachbefunde `RVW2-01…RVW2-20` in `…-review-2.md` (Verdict `CHANGES_REQUESTED`); S1 bleibt `draft`, bis Blocker und Majors geschlossen sind. RVW-02 ist durch die G5-Korrektur erledigt, RVW-01/14/15/16 durch die Entscheidungen in §3.

**Keine Spec nötig.** G10 (CI-Pinning, Web-Store-Skript) und G11 (Container-Defaults) ändern keinen öffentlichen Vertrag; sie werden durch dieses Protokoll und das PR-Review geführt.

**Gate.** Die Implementierung der spec-gated WPs startet erst bei `Status: APPROVED` der jeweiligen Spec. Eine offene Spec-Frage blockiert das WP, nicht die gesamte Release-Linie.

## 8. Traceability

`QW` = Quick-Win-Batch (parallel, datei-disjunkt). `—` heißt: keine Gate-Entscheidung nötig; die Änderung folgt bestehender Konvention.

| Finding | WP | Gate |
|---|---|---|
| BP-01 | 0.1 | G3 |
| BP-02 | 0.3 | — |
| BP-03 | 0.3 | — |
| BP-04 | 0.2 | G4 |
| BP-05 | QW | — |
| BP-06 | 6.1 | — |
| BP-07 | 4.2 | — |
| BP-08 | 6.1 | — |
| BP-09 | QW | — |
| BP-10 | QW | — |
| SEC-01 | 2.1 | G1 |
| SEC-02 | 2.2 | G1 |
| SEC-03 | 2.4 | G2 |
| SEC-04 | 2.6 | — |
| SEC-05 | 5.1 | — |
| SEC-06 | 2.5 | — |
| SEC-07 | 2.4 | G2 |
| SEC-08 | 2.3 | — |
| SEC-09 | QW | — |
| SEC-10 | 2.7 (Doku) | G1 |
| SEC-11 | 5.2 | G12 |
| SEC-12 | 8.4 | G12 |
| SEC-13 | 3.1 (Copy-only Assign, RVW-01) | G5 |
| SEC-14 | 3.2 | G6 |
| SEC-15 | 3.6 | G9 |
| SEC-16 | 3.3 | G7 |
| SEC-17 | QW | — |
| SEC-18 | QW | — |
| SEC-19 | 3.4 | G8 |
| SEC-20 | 3.5 | G9 |
| SEC-21 | QW (Doku) | — |
| SEC-22 | 7.3 | G10 |
| SEC-23 | QW | — |
| SEC-24 | 8.1 | G11 |
| SEC-25 | 8.2 | — |
| SEC-26 | 8.3 | — |
| SEC-27 | 7.1 | — |
| SEC-28 | 7.2 | — |
| CQ-01 | 4.1 | — |
| CQ-02 | 4.2, 4.3 | — |
| CQ-03 | 9.1–9.5 | — |
| CQ-04 | 0.5 | G3 |
| CQ-05 | 3.7 | — |
| CQ-06 | 3.7 | — |
| CQ-07 | QW | — |
| CQ-08 | QW | — |
| CQ-09 | QW | — |

## 9. Pflege und Re-Planung

- **Statuswechsel.** `DRAFT` → `APPROVED` erfolgt nur durch den Product Owner. Jede spätere Gate-Änderung wird als neue Revision mit Datum geführt, nicht still überschrieben.
- **Revision 2026-11-02.** G5 auf Design D4/D6 korrigiert (RVW-02); die Entscheidungen RVW-01/14/15/16 aus dem S1-Review sind in §3 aufgenommen.
- **Revision 2026-11-02 (RVW2-09).** G5-Legacy-Sichtbarkeit korrigiert: keine Anzeige im Page-Overlay, read-only nur auf der Extension-Review-Seite; die sichtbare Regression für Vor-0.12-Notes ist dokumentiert.
- **Revision 2026-11-02 (RVW2-04/16).** Undo ist an eine persistierte Assign-Provenienz gebunden (Sidecar `bluepencil:assign:<origin>`, CAS auf den Ziel-Blob); RVW-16 präzisiert die Sichtbarkeit auf den UI-Status (Badge/Titel), weil `element.issues` ausschließlich Attribut-Diagnose sammelt.

- **Messwerte.** Die NFR-3-Zahlen und das Messdatum werden bei Release-Cut nach Wave 1 eingetragen; bis dahin bleibt die Headline ein Platzhalter mit Verweis auf dieses Protokoll.
- **Nach jeder Welle.** Annahmen prüfen, WP-Reihenfolge anpassen, Traceability nachziehen. Der Plan wird nicht als eingefroren behandelt.
- **Release-Schnitt.** 0.12.0 wird erst geschnitten, wenn jedes Finding entweder geschlossen oder als Follow-up (§4) belegt ist.
