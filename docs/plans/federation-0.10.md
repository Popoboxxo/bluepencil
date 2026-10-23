---
type: Plan
status: rev-6
topic: federation-0.10
milestone: M5b
target_version: 0.10.0
review: docs/plans/federation-0.10-review.md
---

# Föderation / Hub-of-Hubs — Umsetzungsplan bluepencil 0.10.0

**Status: Rev. 6 — Shape (e) korrigiert: der Federator ist stdio-only und kein Compose-Dauerdienst; die Docker-Shape ist ein aggregierender Hub plus zwei Leaf-Hubs (2026-10-23).**
**Review: `docs/plans/federation-0.10-review.md`** (Durchlauf 1: CHANGES_REQUESTED → umgesetzt; Durchlauf 2: CHANGES_REQUESTED → in Rev. 3/4 umgesetzt; Rev.-4-Entscheidungen siehe §12).

### Änderungslog

| Rev. | Datum | Änderung |
|---|---|---|
| 1 | 2026-10-22 | Erstfassung: drei Betriebsarten, 14 Entscheidungen, 8 PRs, 70 Tests (T01–T70) |
| 2 | 2026-10-22 | Erster Review-Durchlauf (RVW-01…RVW-21) eingearbeitet: Export/Import über `/mcp`, Redirect-Policy, Threat Model, `ReadSource`, MCP-Resources, kanonische Exit-Code-Tabelle, `Redactor`-Signatur, Tests T71–T89 |
| 3 | 2026-10-22 | ID-Normalisierung auf `FR-6.15`/`NFR-22`; zweiter Review-Durchlauf (RVW2-01…RVW2-19, T71–T89 + Traceability + Wirksamkeit der Rev.-2-Fixes) vollständig eingearbeitet; §12 führt beide Durchläufe |
| 4 | 2026-10-22 | Drei Nutzerentscheidungen: (1) fehlendes `federates` ist immer ein `federates_missing`-Startfehler; (2) ein einziges `--allow-insecure` ersetzt `--allow-plain-http`/`--allow-private-network` (Link-Local/Metadata bleiben immer blockiert); (3) Write-Opt-in mit zwei Schlössern (`mode:"write"` **und** `--allow-write`); Tests T90–T94. Zusätzlich Requirements-Schritt ausgeführt: `FR-6.15`, `FR-16.10`–`FR-16.15` und `NFR-22` in `docs/REQUIREMENTS.md` aufgenommen, `spec/` mit `npm run spec` regeneriert |
| 5 | 2026-10-22 | Synchronisation mit dem implementierten Wave-1-Kern (`src/federation/{errors,registry,aggregate,client}.ts`): (1) `invalid_base_url` als kanonischer Code in §6-Union und §7-Exit-Tabelle (Start verweigert, Exit 4); (2) vier deprecated Alias-Schreibweisen in §6 dokumentiert (nicht kanonisch, Entfall in PR 4); (3) Aggregat-Reihenfolge auf den implementierten, globalen Review-Sort (`compareForReview`, `instance`-, qualifizierter `id`-Tie-Break) umgestellt — §6/§7/T18 konsistent; (4) `loadRegistry`-Overloads inkl. `allowInsecure`/`resolver`/`stat`, DNS-Auflösung standardmäßig beim Start, `defaults.concurrency`/`defaults.limit` mit Clamp und Konstanten; (5) DNS-Check-to-Connect-Restrisiko (TOCTOU/Rebinding) in §11 als dokumentiertes Restrisiko aufgenommen. Keine Code-, Test-, REQUIREMENTS- oder `spec/`-Änderung |
| 6 | 2026-10-23 | Shape (e) korrigiert: der Federator ist stdio-only und kein Compose-Dauerdienst; Docker-Shape ist ein aggregierender Hub (`bluepencil-hub --store aggregator.json --registry … --no-self`) plus zwei Leaf-Hubs. Der Federator bleibt lokaler stdio-Modus am Agenten (`docker run -i --rm … bluepencil-federator` nur als Beispiel eines angehängten Clients). §9/§10: Federator-only ist kein HTTP-Dienst und hat kein `/config`; `includeSelf` ist dort No-op. Keine Code-/Test-/Requirements-Änderung. |

> **Charakter:** interner Umsetzungsplan, keine Implementierung. Dieses Dokument enthält keinen
> Code und ändert `README.md` nicht; der zugehörige Requirements-Schritt wurde ausgeführt
> (`docs/REQUIREMENTS.md` um `FR-6.15`, `FR-16.10`–`FR-16.15`, `NFR-22` ergänzt, `spec/` mit
> `npm run spec` regeneriert). Es ist **kein** `plan-driven`-
> Pipeline-Input; `pipeline_stages` ist deshalb bewusst nicht gesetzt (Begründung in §10).
>
> **Sprache:** Prosa Deutsch, Code-/Config-Beispiele Englisch. Der Ist-Stand wurde gegen den Baum
> geprüft (package.json 0.8.0, `server/index.ts`, `server/handler.ts`, `server/mcp.ts`,
> `src/mcp/*`, `src/core/model.ts:166–202`, `src/core/store.ts:59–81`,
> `src/adapters/http.ts`, `src/embed/attributes.ts`, `extension/src/settings.ts`). Wo etwas
> nicht verifizierbar war, steht „zu verifizieren“ statt einer Erfindung.
## 1. Zielbild

bluepencil 0.10.0 ergänzt die bestehende Einzel-Hub-Welt um **Föderation**: ein Agent liest
mehrere Hubs (Instanzen) in einem Aggregat und schreibt gezielt in genau eine Instanz. Browser
bleiben unverändert Einzel-Hub-Clients. Es gibt weiterhin genau eine Note-Logik
(`src/core/**` + `src/data/**`); die Föderation ist Transport- und Routing-Schicht, keine zweite
Datenimplementierung.
### Drei Betriebsarten

| Betriebsart | Prozess | Eigener Store | Registry | Primärer Vertrag |
|---|---|---|---|---|
| **Single Store** | `bluepencil mcp --store …` | ja (Datei) | nein | MCP stdio, ein Store, eine Env |
| **Hub** | `bluepencil-hub` / `dist/server.js` | ja (Datei) | optional (`--registry`) | HTTP `/notes` (UI) + `/mcp` (Agent) |
| **Federator** | `bluepencil-federator` / `dist/federator.js` | nein | ja (`--registry`) | MCP stdio, Aggregat über N Hubs |
### Datenfluss

```
(a) MCP client ──stdio──> bluepencil mcp ──> notes.json
(b) Browser ──/notes (one env)──> Hub (leaf) ──> notes.json
    MCP client ──/mcp──────────> same process, same store
(c) MCP client ──stdio──> federator ──> registry.json
                              ├──/config,/notes──> Hub dev     ──> store-dev.json
                              └──/config,/notes──> Hub staging ──> store-staging.json
    Browser ──/notes──> Hub dev OR Hub staging      (never registry/federator)
(d) Browser ──/notes──> Hub with --registry ──> own store only
    MCP client ──/mcp──> same Hub ──> self + registered hubs (aggregate)
```
**Datenfluss-Regeln.** Der Browser kennt genau einen `endpoint` und schreibt in genau einen Hub.
Die Registry wird ausschließlich vom Federator (oder vom kombinierten Hub) gelesen. Der Federator
hat keinen eigenen Store und keinen Browser-Endpunkt. Ein Aggregat ist eine **Projektion** über
bereits persistierte Notes; es entsteht kein neuer Speicher und keine stille Zusammenführung.
## 2. Entscheidungen

Die 15 Entscheidungen sind übernommen; die Tabelle dokumentiert sie samt Begründung und
Konsequenz, nicht als Diskussionsangebot. Entscheidung 15 ist in Rev. 4 neu hinzugekommen;
die Entscheidungen 7 und 10 wurden durch Nutzerentscheidung präzisiert, nicht umgedeutet.

| Nr. | Entscheidung | Begründung | Konsequenz | Alternativ verworfen |
|---|---|---|---|---|
| 1 | Ein Repo, kein separates Federator-Repo; Module in `src/federation/`, später extrahierbar | Eine Version, ein Build, ein Testlauf; die Föderation nutzt dieselben Modelle | Neue Subpfade/Bins, aber keine neue Versionsquelle | Eigenes Repo/Submodul (Versionsdrift, doppelte CI) |
| 2 | Drei Betriebsarten: `bluepencil mcp` (Single Store), `bluepencil-hub`/`dist/server.js` (Hub, optional `--registry`), `bluepencil-federator`/`dist/federator.js` (Föderation ohne eigenen Store) | Klare Prozessgrenzen; ein Federator darf nie versehentlich lokal speichern | Drei Startpfade, ein gemeinsamer MCP-Kern | Ein Prozess mit Modus-Flags (zu viele Kombinationen) |
| 3 | Registry ist eine JSON-Datei über `--registry`/`BLUEPENCIL_REGISTRY`; kein Remote-Load; Credentials nur `{ "env": "NAME" }`; die Datei ist trust-äquivalent zu Credentials (0600, Eigentümer, kein World-Writable; optional Host-Allowlist) | Kleine, prüfbare Konfiguration; keine Secrets im Repo; Tampering = Token-Exfiltration | Startfehler bei literalem Secret/fehlender Env; Tampering-Schutz gehört zum Threat Model | Remote-Registry, Secrets als Klartext, `headers`-Map |
| 4 | IDs: `instance/noteId`, Parsing am ersten `/`; `self` ist gültiger Read-Alias und formatierbar; `all`/`*` sind nur Selektoren, keine Format-Instanz; Note-IDs mit `/` sind ungültig | Eindeutig ohne neue ID-Spalte; menschenlesbar; keine Escaping-Erfindung | Qualifizierte IDs nur an der Föderationsgrenze; Note-ID bleibt flach | Eigene UUID-Namespaces, Base64, Präfix `bp:` |
| 5 | `list_notes` ohne `instance` = Aggregat; Writes immer mit `instance` | Lesen über Hubs ist der Hauptnutzen; Schreiben muss eindeutig sein | Kein Fan-out, kein „irgendwohin“-Write | Default-Instance für Writes (zu leicht falsch) |
| 6 | Env-Mix im Aggregat erlaubt; jede Note mit `instance`/`app`/`environment` etikettiert; optionaler `environment`-Filter | Ein Agent soll Dev+Staging sehen können, aber nicht raten müssen | Herkunft ist an jeder Note sichtbar; Filter bleibt explizit; Aggregat-Reads sind die benannte FR-16.3-Ausnahme (§4) | Aggregat auf eine Env beschränken (verliert den Use-Case) |
| 7 | Pro Registry-Instanz `mode: "read"\|"write"`, Default `read`; `mode:"write"` ist nur die **Obergrenze**; zusätzlich muss die Föderations-Session `--allow-write` setzen; globales `--read-only` gewinnt; `mode` gilt **nicht** für `self` | Least Privilege mit zwei Schlössern: ein Registry-Opt-in allein darf nie schreiben; self ist lokal und folgt der Hub-Bindung | Writes brauchen `mode:"write"` **und** `--allow-write` **und** kein globales `--read-only`; ohne `--allow-write` sind ALLE föderierten Writes (auch `self`) read-only; `--read-only` bleibt stärker als `--allow-write`; self schreibbar gdw. `allowWrite && !readOnly && !self.readOnly && includeSelf` | Default `write` (zu gefährlich) |
| 8 | Eigener Store im Aggregat via `defaults.includeSelf` (Default `true`), CLI `--include-self`/`--no-self`; eigene Instanz heißt `self` | Kombinierter Hub soll standardmäßig auch die eigenen Notes zeigen | `self` ist keine Registry-ID; kein HTTP-Selbstaufruf; `instance:'self'` bei `--no-self` → `self_unavailable`; `list_instances` zeigt `self` nur bei `includeSelf:true` | Selbst als Registry-Eintrag (Loop, Credentials) |
| 9 | Identitätsabgleich beim Start über `GET {base}/config`; `/config` wird um `app` und `federates` erweitert; Mismatch = Startfehler; ältere Hubs ohne `app` = Warnung (`unverified`; ausschließlich fehlendes `app`, nie fehlendes `federates`) | Ein falsch verdrahteter Hub ist schlimmer als ein Startfehler | Start ist fail-closed bei nachweisbarem Mismatch; `--app`/`BLUEPENCIL_APP` sind der Identitätsanker des Hubs | Kein Abgleich (stille Fehlzuordnung) |
| 10 | Eine Föderationsebene: registrierte Instanzen müssen Leaf-Hubs sein (`federates:false`); `self_reference` und `nested_federation` = Startfehler | Verhindert Doppelzählung, Loops und uneindeutige Aggregate | Kombinierter Hub meldet `federates:true` und ist selbst nicht registrierbar; jede registrierte Instanz **muss** `federates` in `/config` melden — fehlt das Feld, bricht der Start mit `federates_missing` ab (kein `unverified`); Kinder < 0.10 sind damit nicht föderierbar | Rekursive Föderation (v1 nicht beherrschbar) |
| 11 | Version 0.10.0, Milestone M5b | Ein Release, ein Milestone | Versionsbump in `package.json` + Extension-Manifest | Eigenes 0.9.x (kollidiert mit laufender Linie) |
| 12 | Cross-Instance-Review-Session nicht in v1; Sessions bleiben instanzlokal und werden qualifiziert | Sessions sind aus `sessionRef` abgeleitet, kein CRUD; ein Cross-Hub-Merge wäre eine neue Semantik | `instance/sessionRef` nur als Label/Filter; kein Session-Merge | Globale Session-IDs (Kollisionen, unklare Ownership) |
| 13 | Hermes ist nur ein Beispiel; Doku/Code agent-agnostisch („any MCP client“) | Der MCP-Vertrag ist hostunabhängig | `docs/MCP.md` als primäre Agenten-Doku; Hermes nur Anhang | Hermes-spezifische Tool-Beschreibungen |
| 14 | User-facing Docs Englisch; dieser Plan Deutsch; Code-/Config-Beispiele Englisch | Projektsprachregel | Neue Docs englisch, Plan deutsch | Gemischte Doku |
| 15 | Ein einziges Lab-Flag `--allow-insecure` erlaubt HTTP **und** private IPs (RFC1918/ULA) für Docker/Lab; Default aus mit Warnung im Log; Link-Local (`169.254.0.0/16`, `fe80::/10`) und Metadata-Ziele bleiben **immer** blockiert, auch mit Flag; DNS wird vor dem Request aufgelöst; Redirects bleiben `manual` | Ein Schalter statt zwei, die sich gegenseitig implizit öffnen; Lab-Netze brauchen Schema- und Netzfreigabe gleichzeitig; Link-Local/Metadata sind nie ein legitimes Föderationsziel | `--allow-insecure` ersetzt `--allow-plain-http`/`--allow-private-network`; `http` nur Loopback oder mit Flag; private Bereiche nur mit Flag; Link-Local/Metadata literal **und** nach DNS-Auflösung immer `invalid_base_url`; `redirect:"manual"` bleibt | Zwei getrennte Flags (Kopplungs-/Missbrauchsrisiko) |
## 3. Requirements (Plan-Sicht; Quelle ist `docs/REQUIREMENTS.md`)

| ID | Titel | Kernaussage / Akzeptanz | Milestone | Betroffene Module | ID-Status | Test-IDs |
|---|---|---|---|---|---|---|
| **FR-6.15 (neu)** | `/config` meldet `app` + `federates`, ohne Secrets | `GET {base}/config` liefert zusätzlich `app` (String) und `federates` (Boolean); `federates:true` genau dann, wenn der Prozess eine Registry aggregiert; **jede registrierte Instanz muss `federates` melden — fehlt das Feld, bricht der Start mit `federates_missing` ab**; keine Tokens/Secrets/Env-Werte im Body; ältere Clients ignorieren die Felder; Hub-`--app` setzt `app` | M5b | `server/handler.ts`, `server/hub.ts`, Extension (Toleranz) | kanonisch (normalisiert) | T21, T53, T64, T82, T90 |
| **FR-16.10 (neu)** | Registry-Validierung | `loadRegistry` lehnt literale Secrets, unbekannte Felder, doppelte/reservierte IDs, Nicht-http(s)-URLs, Userinfo-/Query-/Fragment-URLs, Link-Local-Ziele und fehlende Auth-Env ab; `http` nur für Loopback oder mit `--allow-insecure`; private IPs (RFC1918/ULA) nur mit `--allow-insecure`; Link-Local (`169.254.0.0/16`, `fe80::/10`) und Metadata-Ziele sind **immer** verboten, auch mit `--allow-insecure`; kein Teil-Load; Fehlercodes stabil | M5b | `src/federation/registry.ts`, `errors.ts`, CLI `instances` | kanonisch (neu) | T05–T13, T34, T41, T79, T80, T85, T86, T91, T92 |
| **FR-16.11 (neu)** | `list_instances`, `instance`-Parameter, qualifizierte IDs | Neues Read-Tool `list_instances`; `instance` filtert `list_notes`; `instance/noteId` wird am ersten `/` geparst; `self` ist formatierbarer Read-Alias, `all`/`*` nur Selektoren; `format`/`parse` roundtrip; keine Auth-Daten in der Ausgabe | M5b | `src/federation/ids.ts`, `src/mcp/tools.ts`, `src/mcp/backend.ts` | kanonisch (neu) | T01–T04, T23, T40, T60, T61, T77, T88 |
| **FR-16.12 (neu)** | Aggregat-Reads mit Timeout, Teilfehler-Envelope, `limit`/`truncated` | `list_notes` ohne `instance` liest alle Instanzen parallel; pro Instanz Timeout; eine tote Instanz erzeugt einen Fehlereintrag, keine leere Gesamtantwort; `partial`/`errors`; `limit` (Default 200, max 1000) und `truncated`; deterministische Reihenfolge; `defaults.timeoutMs`/Limit-Clamp getestet | M5b | `aggregate.ts`, `client.ts`, `backend.ts`, `tools.ts` | kanonisch (neu) | T14, T15, T17–T20, T24, T25, T27, T28, T58, T66–T68, T87 |
| **FR-16.13 (neu)** | Write-Routing, kein Fan-out, `mode`, `--allow-write`, `--read-only` | Jeder Write nennt genau eine Instanz; **zwei Schlösser:** `mode:"write"` ist nur die Obergrenze, zusätzlich braucht die Föderations-Session `--allow-write`; ohne `--allow-write` sind alle föderierten Writes (auch `self`) `mode_denied`; globales `--read-only` gewinnt; `all`/`*` als Write-Ziel = `fanout_denied`; **`bulk_remove` ist ein Backend-Vertrag, kein MCP-Tool** (nur `remove` und Backend-Tests nutzen die Methode); ohne Instanz = `instance_required`; die Tool-Oberfläche ist **9 (Single) / 10 (Föderation inkl. `list_instances`)**; `environment` wird nie umgeschrieben; keine Env-Promotion; `allow_env_mismatch` im Föderationsmodus abgelehnt; Write-Antwort qualifiziert | M5b | `federation/backend.ts`, `client.ts`, `tools.ts`, `errors.ts` | kanonisch (neu) | T38, T39, T50–T52, T59, T71, T83, T84, T93, T94 |
| **FR-16.14 (neu)** | Kombinierter Hub, federate-only, `includeSelf`, `--allow-write`/`--allow-insecure` | Hub mit `--registry` aggregiert in `/mcp` (self + Registry), `/notes` bleibt lokal; `/config` meldet immer `federates`; Federator hat keinen `/notes`-Endpunkt; `defaults.includeSelf` Default `true`; `--no-self` schließt self aus; `--include-self` beim reinen Federator = Usage-Fehler; `list_instances` enthält `self` nur bei `includeSelf`; self schreibbar gdw. `allowWrite && !readOnly && !self.readOnly && includeSelf`; ohne `--allow-write` ist auch `self` read-only; `--allow-insecure` ist das einzige Lab-Flag (HTTP + private IPs) | M5b | `server/hub.ts`, `server/federator.ts`, `server/mcp.ts` | kanonisch (neu) | T29, T32, T33, T46–T49, T55, T57, T63, T69, T74–T76 |
| **FR-16.15 (neu)** | `bluepencil instances validate\|list\|health` | Drei Subcommands; `validate`/`list` ohne Netz; `health` prüft `/config` + `/health`; stabile Exit-Codes (kanonisch §7); `--json` stabil; keine Secrets; Startup-Unreachable degradiert, Health-Exit 5 | M5b | `src/cli/bin.ts`, `registry.ts`, `client.ts` | kanonisch (neu) | T30, T42–T45, T70, T72 |
| **NFR-22 (neu)** | Keine Secrets in Registry/Logs/Tool-Ausgaben | Registry transportiert nur Env-Referenzen; `list_instances`, Fehler, Logs und CLI-Ausgaben enthalten keine Tokenwerte, Authorization-Header oder Env-Werte; `secret-scan` bleibt grün; Redaction ist mit mehreren Secrets/Teiltreffern getestet | M5b | `registry.ts`, `errors.ts`, `client.ts`, `tools.ts`, `server/*` | kanonisch (neu) | T16, T35–T37, T62, T78, T81 |
| **FR-16.3 (Bestand)** | Eine App, eine Env pro Session | Gilt unverändert für Writes und `/notes`; Aggregat-Reads sind eine benannte Ausnahme (§4) | M5b | `server/handler.ts`, `federation/aggregate.ts` | Bestand | T22, T31, T54 |
| **NFR-18 (Bestand)** | Kein Env-Mix beim Import | Ein Bundle bleibt eine Env; Aggregat-Export wird verweigert; `environment` wird nie umgeschrieben | M5b | `federation/backend.ts`, `tools.ts` | Bestand | T89 |
| **FR-16.5 (Bestand, Einschränkung für Föderation)** | MCP-Resources | Single Store behält alle drei `bluepencil://`-URIs; der Federator bietet **keine** Resources (`resources/list=[]`, `resources/read=resource_unsupported`); Einschränkung dokumentiert | M5b | `src/mcp/backend.ts`, `protocol.ts`, `tools.ts` | Bestand, eingeschränkt | T73 |
| **FR-16.9 (Bestand)** | Two doors, one store | Gilt pro Instanz: `/notes` und `/mcp` teilen den Store der Instanz; keine Mengengleichheit über Instanzen | M5b | `server/hub.ts`, `federation/backend.ts` | Bestand | T26, T56, T65 |

> **Fußnote zur ID-Normalisierung (erledigt):** Die Auftrags-IDs `FR-6.11`/`NFR-21` waren bereits
> vergeben (Extension-Hub-Discovery bzw. Build-Parity); kanonisch sind `FR-6.15`/`NFR-22`. Alle
> Vorkommen in diesem Plan (Requirements-Tabelle, Traceability, PR-Gates, Risiken, Testnamen,
> Review-Abschnitt) verwenden die kanonischen IDs. Der Requirements-Schritt ist ausgeführt:
> `docs/REQUIREMENTS.md` enthält `FR-6.15`, `FR-16.10`–`FR-16.15` und `NFR-22`; `spec/` wurde mit
> `npm run spec` regeneriert. `npm run spec:check` ist in dieser Umgebung nur wegen fehlendem
> `reqmd` nicht ausführbar.
## 4. Architektur und Trennlinien
### Module und Rollen

| Modul | Rolle | Darf schreiben? |
|---|---|---|
| `src/mcp/backend.ts` | Transportneutrales `McpBackend`-Interface + `createStoreBackend` (bestehendes Verhalten) | ja, über den Store |
| `src/federation/registry.ts` | Registry laden, validieren, Env-Referenzen auflösen; keine Netzwerkzugriffe | nein |
| `src/federation/ids.ts` | `instance/noteId` parsen/formatieren; reservierte IDs; `/`-Regel | nein |
| `src/federation/client.ts` | HTTP-Client für genau eine Instanz (`/config`, `/notes`, `/sessions`, `/health`, `/mcp` für export/import) | ja, nur mit `mode:"write"` **und** `--allow-write` |
| `src/federation/aggregate.ts` | `ReadSource`-Interface; parallele Reads, Timeout, Teilfehler, `limit`/`truncated`, deterministische Sortierung | nein |
| `src/federation/backend.ts` | `createFederationBackend`: Read-Aggregat + Write-Routing + Export/Import + Resource-Policy | ja, geroutet |
| `src/federation/errors.ts` | Fehlercodes, MCP-/CLI-Mapping, `Redactor` | nein |
| `server/hub.ts` | Hub-Start, optional Registry, self-Client, `/mcp`-Backendwahl | ja, lokal |
| `server/federator.ts` | Federator-CLI + stdio-MCP ohne eigenen Store | nur an Instanzen |
| `src/mcp/stdio.ts` | Gemeinsame stdio-Schleife für `mcp` und `federator` | nein |
| `src/mcp/tools.ts` | 10 Tools inkl. `list_instances`, `instance`-Parameter | über Backend |
| `server/mcp.ts` | `POST {base}/mcp`: Auth, Protokoll, Backend | über Backend |
| `server/handler.ts` | `/config` um `app`/`federates`; `/notes` bleibt lokal | ja, lokal |
### `/notes` vs. `/mcp` — die Spannung, ausdrücklich

| Aspekt | `/notes` (HTTP, Browser) | `/mcp` ohne Registry | `/mcp` mit Registry / Federator |
|---|---|---|---|
| Datenquelle | genau ein Store, genau eine Env | derselbe Store, dieselbe Env | Projektion über `self` + registrierte Instanzen |
| Umfang | lokal | lokal | Aggregat (Multi-Env möglich) |
| Schreibt | lokal, env-gebunden | lokal, env-gebunden | genau eine Ziel-Instanz, env-gebunden dort |
| Qualifizierte IDs | **nein** | **nein** | **ja** (`instance/noteId`) |
| `instance`-Parameter | **nein** | **nein** | **ja** |
| Garantie | FR-16.3/NFR-18 unverändert | FR-16.9 („two doors, one store“) unverändert | FR-16.9 gilt **pro Instanz**, nicht als Mengengleichheit |

**Auflösung.** `/notes` bleibt der UI-Vertrag: eine Env, ein Store, keine Aggregation, keine
qualifizierten IDs, keine Registry. `/mcp` ist der Agenten-Vertrag. Ohne Registry ist `/mcp`
exakt der bestehende Ein-Store-Pfad (T26, T56). Mit Registry ist `/mcp` ein ausdrücklich
etikettiertes Aggregat; es gibt keinen zweiten Schreibpfad, sondern nur Weiterleitungen an den
einen Store der Ziel-Instanz. Die Notes werden für die Ausgabe kopiert und mit `instance`/`app`
ergänzt; die persistierte Note wird nie verändert.

**Was NICHT erlaubt ist:**

- Browser → Registry oder Browser → Federator (keine solchen Endpunkte; T32, T63).
- Write ohne `instance`/qualifizierte ID (`instance_required`; T52).
- Write an `all`/`*` oder Fan-out an mehrere Instanzen (`fanout_denied`; T59).
- Aggregat-Export als ein Bundle mit gemischten Envs (Refusal; §7).
- Stille Env-Promotion oder Umschreiben von `environment` (T39).
- Verschachtelte Föderation (`federates:true` als Registry-Ziel; T46).
- Start gegen eine Instanz ohne `federates`-Feld (`federates_missing`; T90).
- Registry-Eintrag `self` oder Selbstreferenz per URL (T47).
- Secrets in Registry, Logs, Tool-Ausgaben (T34–T37, T62).
### Requirement-Klarstellung (FR-16.2/16.3) — vor REQUIREMENTS-Änderung entscheiden

FR-16.3 sagt heute „eine App und eine Env“ pro Session. Der Plan hält das **für Writes und für
den Single-Store-Pfad** unverändert; das Aggregat ist eine **benannte, etikettierte Ausnahme**:

| Kontext | FR-16.3 / NFR-18 | Regel im Plan |
|---|---|---|
| Single Store / `/notes` / `/mcp` ohne Registry | unverändert bindend | eine Env, eine App; fremde Env wird abgelehnt |
| Aggregat-Read (`list_notes` ohne `instance`) | Ausnahme, ausdrücklich benannt | Multi-Env/Multi-App erlaubt; jede Note trägt `instance`/`app`/`environment`; kein stiller Mix |
| Write | unverändert bindend, pro Instanz | Ziel-Instanz prüft ihre eigene Bindung; `environment` wird nie umgeschrieben; `allow_env_mismatch` wird nicht forwardiert |
| `list_notes.environment?` im Single-Scope | Bindung gilt | Wert muss der Session-Bindung entsprechen, sonst `environment_mismatch`; nie überschreiben |
| `list_notes.environment?` im Aggregat | Filter, keine Bindung | schränkt ein, erweitert nie; keine Env-Promotion |

**FR-16.2:** Writes brauchen **zwei Schlösser**: `mode:"write"` in der Registry ist nur die
Obergrenze, die Föderations-Session muss zusätzlich `--allow-write` setzen. Ohne `--allow-write`
sind alle föderierten Writes — auch `self` — read-only (`mode_denied`); `--read-only` bleibt
stärker. Damit ist FR-16.2 wörtlich erfüllt: kein Agent schreibt ohne explizites Session-Opt-in.
Das Hub-`/notes`-Verhalten bleibt unverändert (kein Föderationspfad, keine `instance`). (T39,
T50, T51, T84, T93, T94)

### Export/Import über die Föderationsgrenze

**Gewählter Transport: die `/mcp`-Door des Ziel-Hubs** (`tools/call export_bundle` bzw.
`import_bundle`), **nicht** ein neuer `POST /notes/import`. Begründung: Die Door existiert seit
0.8 (FR-16.8), nutzt dieselben Validatoren/Merge-Regeln (FR-16.7) und dieselbe Auth-Grenze; ein
neuer `/notes`-Endpunkt würde den UI-Vertrag erweitern und Import-Logik ein zweites Mal
exponieren. `GET {base}/bundle` bleibt für Menschen/Tools lesbar, ist aber nicht der
Föderationstransport.

| Operation | Transport | Auth-Scope | Selbst | Remote |
|---|---|---|---|---|
| `export_bundle(instance, options)` | `POST {base}/mcp` + `tools/call export_bundle` | read | lokaler Store/Export | MCP-Content-Text der Instanz |
| `import_bundle(bundle, options, instance)` | `POST {base}/mcp` + `tools/call import_bundle` | write | lokaler Store/Merge | MCP-Report der Instanz |
| Fehler | JSON-RPC-Fehler oder `isError` | — | `FederationError` | `FederationError` mit Code-Mapping (§7) |

`allow_env_mismatch` wird im Föderationsmodus **vor** dem Aufruf mit `invalid_argument`
abgelehnt (RVW-18); Single-Store bleibt unverändert. Ein Aggregat-Export ohne `instance` bleibt
`instance_required` (kein Mixed-Env-Bundle). (T71, T84)

### MCP-Resources

**Entscheidung:** Der Federator bietet **keine** MCP-Resources an. `resources/list` liefert
`{ resources: [] }`; `resources/read` antwortet mit `INVALID_PARAMS` und dem Hinweis
`resource_unsupported`. Begründung: `bluepencil://notes`/`notes.json`/`bundle` sind
Single-Store-Artefakte; ein aggregiertes Bundle wäre ein Mixed-Env-Bundle und damit ein Bruch von
NFR-18. Die Einschränkung von FR-16.5 wird in `docs/MCP.md`/`docs/FEDERATION.md` dokumentiert;
der Single-Store-Pfad behält alle drei Resources unverändert. (T73)

### Threat Model (4 Fragen)

| Frage | Antwort / Risiko | Gegenmaßnahme im Plan | Test |
|---|---|---|---|
| **1. Was baust du?** | Ein Federator hält N Env-Referenzen/Tokens, liest eine lokale Registry und schreibt gezielt in eine Instanz; Browser bleiben Einzel-Hub-Clients | Drei Betriebsarten, `{env}`-Only, `mode` Default `read`, zweites Schloss `--allow-write`, `--read-only`, keine Browser-Registry | T34, T63 |
| **2. Was könnte schiefgehen?** | Registry-Tampering → `base` auf Angreifer-Host → Token-Exfiltration; Redirect auf fremden Host; DNS-Rebinding auf Link-Local; kompromittierter Federator = alle Write-Tokens; SSRF auf Link-Local/Metadata; Log-/Tool-Leak; falscher Hub; Cross-Env-Verwechslung; Alt-Hub ohne `federates` | Registry 0600/Eigentümer/kein World-Writable; `redirect:'manual'`; Link-Local-/Metadata-Block literal und nach DNS-Auflösung **immer**, auch mit `--allow-insecure`; private Netze nur mit `--allow-insecure` (Default aus); Host-Allowlist optional; Identitätscheck inkl. `federates_missing`; `partial`/`errors`; `Redactor` | T78–T81, T90 |
| **3. Was tust du dagegen?** | Least Privilege, fail-closed bei Identitätsmismatch, keine stillen Writes, keine Secrets in Ausgaben | `mode` Default `read` + `--allow-write` als zweites Schloss; globales `--read-only`; `literal_secret`/`missing_env_var`; `list_instances` ohne `base`/`auth`; `Redactor` mit aufgelösten Secrets | T34–T37, T62 |
| **4. Was sind die Konsequenzen?** | Datenverlust/‑korruption in einem Hub durch Fehl-Write; Credential-Kompromittierung über mehrere Hubs; ein „leeres“ Aggregat wirkt wie „keine Notes“ | `instance`-Pflicht, kein Fan-out, `partial`/`errors`, `isError` bei Totalausfall, Health-Exit 5, `not_persisted` | T17, T28, T68 |

**Registry-Trust:** Die Registry-Datei ist trust-äquivalent zu allen referenzierten Credentials.
Sie muss `0600` gehören dem Dienstnutzer, darf nicht world-writable sein und wird beim Start auf
offensichtliche Tampering-Spuren (fremder Eigentümer, zu offene Rechte) geprüft. Optional:
`defaults.allowedHosts` als Allowlist. **SSRF-Policy:** `169.254.0.0/16`, `fe80::/10`, `169.254.169.254` und Metadata-Hostnamen werden
**immer** abgelehnt — literal **und** nach DNS-Auflösung vor dem Request (Rebinding); auch
`--allow-insecure` hebt diesen Block nicht auf. `--allow-insecure` (Default aus, Warnung im Log)
erlaubt das `http`-Schema **und** private Bereiche (RFC1918/ULA) für Docker/Lab; ohne das Flag
bleibt `http` auf Loopback beschränkt und private Ziele sind verboten. Redirects bleiben
`redirect:"manual"`. **Alt-Hubs:** fehlt `federates` in `/config`, ist das ein Startfehler
(`federates_missing`), kein `unverified`; `unverified` bleibt ausschließlich fehlendem `app`
vorbehalten. **Blast-Radius:** Ein Federator mit N
`mode:"write"`-Instanzen hält N Tokens; pro Instanz minimale Scopes vergeben, keine
Allzweck-Tokens. (T78–T81)

### Env-Isolation (FR-16.3, NFR-18) im Aggregat

Aggregat-Reads sind **read-only über Envs**. Jede Note trägt ihre eigene `environment`; der
Föderator fügt keine hinzu und ändert keine. Der optionale `environment`-Filter schränkt ein,
erweitert aber nie. Writes bleiben env-gebunden, weil jede Instanz ihren eigenen
`assertEnvironment`-Pfad behält; der Föderator forwardet **kein** `--allow-env-mismatch` und
schreibt `environment` nicht um. Es gibt keine Deduplizierung und kein Last-Write-Wins über
Instanzen. Qualifizierte IDs verhindern Kollisionen; gleiche lokale IDs in zwei Hubs bleiben
zwei Notes. (T39, T41, T50)
## 5. Client-Anpassungen (wichtigster Abschnitt)
### Matrix

| # | Client | Ändert sich? | Was genau | Bewusst NICHT | Doku | Tests |
|---|---|---|---|---|---|---|
| 1 | Library `init()` (Bundler) | nein | Keine neuen Optionen; `endpoint` zeigt weiter auf einen Hub | Keine Registry, kein `instance`, kein Federator | README, INTEGRATION | T63 |
| 2 | `<bluepencil-notes>` Element | nein | Keine neuen Attribute; bestehende `endpoint`/`environment`/`app` unverändert | `instance` ist **kein** Browser-Attribut; kein Multi-Hub | EMBED, README | T63, T31 |
| 3 | `attach.js` Loader | nein | Forwardet weiterhin nur `ALL_ATTRIBUTES`; keine neue Kennung | Keine Registry-/Föderationsattribute | EMBED | T63 |
| 4 | Bookmarklet / IIFE | nein | Unverändert; schreibt in einen Hub oder lokal | Kein Federator-Zugriff, keine Registry | INTEGRATION §4 | T63 |
| 5 | MV3 Extension | nein (Struktur) | Ein globales Hub-Profil bleibt; `/config`-Zusatzfelder werden toleriert; optional nur Anzeige von `app`/`federates` | Kein Multi-Profil, kein `instance`, keine Registry | EXTENSION, README | T64 |
| 6 | CLI (`bluepencil`) | ja | Neuer Subcommand `instances validate\|list\|health`; bestehende Commands unverändert | Kein `--registry` an `mcp`; kein Fan-out | README, FEDERATION | T42–T45 |
| 7 | MCP stdio Single Store (`bluepencil mcp`) | nein (Verhalten) | Nutzt intern `createStoreBackend`; gleiche Tools/Antworten | Keine Föderation, keine Registry | MCP, HERMES | T65, T56 |
| 8 | Hub (`bluepencil-hub`/`dist/server.js`) | ja | `--app`/`BLUEPENCIL_APP`, `--registry`, `--include-self`/`--no-self`, `--allow-write`, `--allow-insecure`; `/config` + `app`/`federates` (immer gesetzt); `/mcp` aggregiert bei Registry; `/notes` bleibt lokal | `/notes` wird nie aggregiert; kein Browser-Zugriff auf Registry | DOCKER, FEDERATION | T21, T53–T57, T75–T77, T82 |
| 9 | Federator (`bluepencil-federator`/`dist/federator.js`) | neu | Eigener stdio-MCP-Prozess ohne Store; `--registry`, `--read-only`, `--allow-write`, `--allow-insecure`, `--timeout`, `--limit`; Export/Import über `/mcp` der Ziel-Hubs | Kein `/notes`, kein Browser-Endpunkt, kein eigener Store | FEDERATION, MCP | T27, T32, T45, T71, T72, T90–T94 |
| 10 | Eigenes Backend nur mit HTTP-Contract | ja (Doku) | Muss `/notes`, `/health`, `/config` mit `app` **und immer** `federates` liefern (fehlendes `federates` → `federates_missing`); `/mcp` mit `export_bundle`/`import_bundle` ist für Föderation erforderlich | Keine Registry im Backend; keine qualifizierten IDs auf `/notes` | ARCHITECTURE §5, EMBED §4 | T22, T24, T71, T90 |
### Je Client

**1. Library `init()`.** Unverändert: `BlueprintConfig` bleibt `{ adapter, storeOptions, sessionRef, environment, enabled, autoEnable }`; Föderation ist kein Library-Feature. Bewusst nicht: `registry`, `instances`, `instance`. Doku: README, INTEGRATION §1. Test: T63.

**2. `<bluepencil-notes>`.** Unverändert; `instance` wird **nicht** eingeführt. Ein Browser schreibt in genau einen Hub; `federates:true` ändert daran nichts (`/notes` bleibt lokal). Bewusst nicht: Multi-Hub-Auswahl, Registry. Doku: EMBED, README. Tests: T31, T63.

**3. `attach.js`.** Unverändert; forwardet nur `ALL_ATTRIBUTES`, also kein `instance`. Bewusst nicht: Registry-Keys. Doku: EMBED. Test: T63.

**4. Bookmarklet/IIFE.** Unverändert: lokaler/HTTP-Einzel-Hub-Weg, CSP-Grenzen bleiben. Bewusst nicht: Federator als Ziel. Doku: INTEGRATION §4. Test: T63.

**5. MV3 Extension.** Kein Umbau; **ein** Endpoint-Profil (`endpoint`, `auth`, `token`, `environment`, `appName`). `/config`-Zusatzfelder werden ignoriert (T64); optionale Anzeige von `app`/`federates` ändert das Schreibziel nicht. Bewusst nicht: Multi-Profil, `instance`, Registry. Doku: EXTENSION, README. Test: T64.

**6. CLI.** Neu `instances validate|list|health`; bestehende Subcommands und Exit-Codes 0–4 unverändert, `EXIT.federation=5` nur für `health`. `--registry` gilt für `instances`, nicht für `mcp`. Bewusst nicht: `mcp --registry`. Doku: README, FEDERATION. Tests: T42–T45.

**7. MCP stdio Single Store.** Verhalten unverändert (`--store/--environment/--app/--allow-write/--session-id`, read-only default). Intern `createStoreBackend` (T65). Bewusst nicht: Registry, Aggregat, qualifizierte IDs. Doku: MCP, HERMES. Tests: T65, T56.

**8. Hub.** Bleibt Browser-Hub. Neu `--app`/`BLUEPENCIL_APP`, `--registry`, `--include-self`/`--no-self`, `--allow-write`, `--allow-insecure`; `/notes`/`/sessions`/`/bundle`/`/health` lokal (T22, T54); `/mcp` aggregiert nur mit Registry (T55, T56); `/config` + `app`/`federates` immer gesetzt (T21, T53, T82); `--read-only` global (T51); zweites Schloss: `--allow-write` nötig, damit `mode:"write"` wirkt. Bewusst nicht: `/notes` aggregieren, Browser-Credentials an Registry. Doku: DOCKER, FEDERATION, ARCHITECTURE §5. Tests: T21, T53–T57, T82.

**9. Federator.** Neuer Prozess ohne Store und ohne `/notes`. Start nur mit gültiger Registry; `/config`-Check (`app`, `federates`) vor dem ersten MCP-Byte; fehlendes `app` → `unverified`-Warnung, fehlendes `federates` → Startfehler `federates_missing` (T49, T90); unerreichbare Instanz → degradierter Start (T72). stdio-MCP, 10 Tools; Reads aggregieren, Writes routen; Export/Import über `/mcp` der Ziel-Hubs (T71). `--read-only` blockt alles; ohne `--allow-write` sind alle föderierten Writes (auch `self`) read-only; `--allow-insecure` erlaubt HTTP + private IPs (Link-Local/Metadata immer blockiert); `--timeout`/`--limit` steuern das Aggregat. Bewusst nicht: Browser-Endpunkt, eigener Store, `--include-self`, Verschachtelung, Resources. Doku: FEDERATION, MCP. Tests: T26, T27, T32, T45–T52, T71, T72, T90–T94.

**10. Eigenes Backend.** Muss für Föderation `/notes`, `/health`, `/config` mit `app` und `federates:false` liefern; für Export/Import zusätzlich `/mcp` mit `export_bundle`/`import_bundle` (der gewählte Transport, §4). Bewusst nicht: Registry im Backend, qualifizierte IDs auf `/notes`. Doku: ARCHITECTURE §5, EMBED §4, FEDERATION. Tests: T22, T24, T71.

> **Invarianten (gelten für alle zehn Zeilen):** Browser-Clients registrieren sich **nie** in
> einer Registry; sie schreiben in **genau einen** Hub. Die Extension bleibt v1 bei **einem**
> globalen Hub-Profil (bekannte Grenze, kein Umbau). Der Federator ist **kein** Browser-Client.
> Neue/geänderte Attribute nur wo zwingend — `instance` ist **kein** Browser-Attribut.
## 6. Datei-für-Datei-Änderungen

Die Skizzen sind Signaturen und Verträge, **keine** vollständige Implementierung. Bestehende
Signaturen bleiben erhalten, wo sie nicht ausdrücklich genannt sind.
### `src/mcp/backend.ts` (neu)
```ts
export type BackendKind = "store" | "federation";
export type BackendScope = "single" | "aggregate";

export interface ListOptions {
  instance?: string; limit?: number; environment?: Environment;
}
export interface BackendList {
  notes: Note[]; instances: InstanceStatus[];
  partial: boolean; truncated: boolean; errors: FederationError[];
}
export interface McpBackend {
  readonly kind: BackendKind; readonly scope: BackendScope; readonly appName: string;
  readonly environment?: Environment;   // nur scope "single"
  list(filter: NoteFilter, options?: ListOptions): Promise<BackendList>;
  get(id: string, instance?: string): Promise<Note | undefined>;
  create(draft: NoteDraft, instance?: string): Promise<Note>;
  update(id: string, patch: NotePatch, instance?: string): Promise<Note>;
  addMessage(id: string, message: Message, instance?: string): Promise<Note>;
  remove(id: string, instance?: string): Promise<void>;
  bulkRemove(filter: NoteFilter, instance?: string): Promise<{ removed: number }>;
  sessions(instance?: string): Promise<Session[]>;
  instances(): Promise<InstanceStatus[]>;
  exportBundle(instance: string, options: { format: "json" | "markdown"; includeDone: boolean }): Promise<ToolResponse>;
  importBundle(bundle: unknown, options: ImportOptions, instance: string): Promise<ToolResponse>;
  resources(): Array<{ uri: string; name: string; mimeType: string }>;
  readResource(uri: string): Promise<{ uri: string; mimeType: string; text: string } | null>;
  confirmWrite(expected: readonly Note[], action: string): Promise<ToolResponse | null>;
  close(): Promise<void>;
}
export interface ImportOptions {
  mode: "merge" | "upsert" | "replace-session";
  dryRun: boolean;
  onConflict?: "fail" | "keep-incoming" | "keep-existing";
  allowEnvMismatch?: boolean;   // im Föderationsmodus verboten
}
export function createStoreBackend(store: Store, options: {
  allowWrite: boolean; environment: Environment; appName: string;
  persistence: McpPersistence; clientName: string; sessionId: string; now?: () => string;
}): McpBackend;
```
`createStoreBackend` ist eine dünne Hülle: `list/create/update/addMessage/remove/bulkRemove`
delegieren an den bestehenden `Store`; `confirmWrite` behält die F7-Rückleseprüfung
(`persistence.readPersisted`, `compareNoteSets`). `instances()` liefert genau einen Eintrag
`self`. `exportBundle`/`importBundle`/`resources`/`readResource` delegieren an die bestehenden
Tool-Implementierungen (`export_bundle`, `import_bundle`, `readResource`) und liefern **gleiche
Tool-Antworten** wie vor dem Refactor (T65). Damit bleibt das Verhalten von `bluepencil mcp` und
`/mcp` ohne Registry identisch (T56).
### `src/federation/registry.ts` (neu)
```ts
export interface RegistryAuth { env: string }   // NUR der Name, nie der Wert
export interface RegistryInstance {
  id: string;            // ^[a-z0-9][a-z0-9._-]{0,63}$
  base: string;          // http(s), ohne Query/Fragment/Userinfo
  app?: string;          // erwartete Identität; fehlt = unverified (nur app, nie federates)
  mode?: "read" | "write";   // Default read (auch aus defaults)
  auth?: RegistryAuth; tokenHeader?: string; tokenScheme?: string;
}
export interface Registry {
  schemaVersion: 1;
  defaults?: {
    includeSelf?: boolean; mode?: "read" | "write"; timeoutMs?: number;
    concurrency?: number;   // default 8, valid 1..16 (REGISTRY_MAX_CONCURRENCY)
    limit?: number;         // default 200, max 1000; input up to 5000 is clamped
    allowedHosts?: string[];   // optionale Host-Allowlist (SSRF-Härtung)
  };
  instances: RegistryInstance[];
}
export type RegistryErrorCode =
  | "invalid_json" | "invalid_shape" | "unknown_field" | "unsupported_schema"
  | "duplicate_id" | "reserved_id" | "invalid_id" | "invalid_base_url"
  | "literal_secret" | "missing_auth_env" | "missing_env_var";
export interface RegistryIssue { path: string; code: RegistryErrorCode; message: string }
export function validateRegistry(value: unknown,
  options?: { allowInsecure?: boolean; env?: NodeJS.ProcessEnv },
): { registry: Registry; issues: [] } | { registry?: never; issues: RegistryIssue[] };
export interface LoadRegistryOptions {
  allowInsecure?: boolean;
  resolver?: HostResolver;   // DNS check; on by default at start-up (F-01)
  stat?: (path: string) => Promise<{ mode: number; uid?: number }>;   // injectable (T79)
}
export function loadRegistry(path: string, env?: NodeJS.ProcessEnv,
  options?: LoadRegistryOptions): Promise<Registry>;   // explicit environment
export function loadRegistry(path: string,
  options?: LoadRegistryOptions): Promise<Registry>;   // env defaults to process.env
// options: allowInsecure/resolver/stat; auth.env is resolved against env (default process.env);
// DNS resolution is on by default at start-up (F-01, not offline); opens as
// RegistryError (invalid document) or FederationError("invalid_registry") (file/permissions);
// checks 0600/owner; no partial load.
```
**Validierungsregeln (jeweils mit Test):** `schemaVersion` muss `1` sein, sonst
`unsupported_schema` (T85); unbekannte Felder auf jedem Level sind Fehler (T07); `id` muss dem
Muster entsprechen, `self|all|*` sind reserviert (T08, T09); doppelte IDs sind Fehler (T08);
`base` muss `http`/`https` sein, ohne Username/Password, Query oder Fragment (T10, T11, T86);
`http` ist nur für Loopback erlaubt, sonst `https` oder explizites `allowInsecure` (T41);
`169.254.0.0/16`, `fe80::/10`, `169.254.169.254` und Metadata-Hostnamen sind **immer** verboten —
geprüft wird sowohl die literale IP als auch ein aufgelöster Hostname (DNS-Rebinding, T80), auch
mit `allowInsecure` (T92); private Bereiche (RFC1918/ULA) sind **nur** mit `allowInsecure`
erlaubt (T91); `allowInsecure` ist das einzige Lab-Flag und ersetzt `allowPlainHttp`/
`allowPrivateNetwork`; `defaults.allowedHosts` schränkt zusätzlich ein (T79). `auth` darf **nur** `{ env }` sein — jeder literale
`token`/`secret`/`password`/`authorization`/`headers`-String ist `literal_secret` (T06, T34);
`env` muss ein gültiger Variablenname sein und beim Start gesetzt sein, sonst `missing_env_var`
(T12, T13). `defaults.includeSelf` Default `true` (T69); im **reinen Federator** ist das Feld ein
dokumentierter No-op (kein `self`) und wird nicht validiert; `mode` Default `read` (T50).
`defaults.concurrency` hat den Default 8 und den gültigen Bereich 1–16 (außerhalb =
`invalid_shape`); `defaults.limit` hat den Default 200 und das Maximum 1000 — Eingaben bis 5000
werden auf 1000 **geklemmt, nicht abgelehnt**, darüber ist es ein Fehler (T87). Die Konstanten
liegen in `src/federation/registry.ts`: `REGISTRY_DEFAULT_TIMEOUT_MS` (3000),
`REGISTRY_DEFAULT_LIMIT` (200), `REGISTRY_MAX_LIMIT` (1000), `REGISTRY_DEFAULT_CONCURRENCY` (8),
`REGISTRY_MAX_CONCURRENCY` (16).
`loadRegistry` hat zwei Overloads — `(path, env?, options?)` und `(path, options?)`; die Optionen
sind `allowInsecure`, `resolver` und `stat` (`stat` ist für T79 injizierbar), während `auth.env`
gegen die übergebene Umgebung (Default `process.env`) aufgelöst wird. Anders als
`validateRegistry` löst `loadRegistry` DNS standardmäßig auf (F-01); die Startprüfung ist damit
nicht offline. `loadRegistry` prüft die Dateirechte (0600, kein World-Writable) und meldet
`invalid_registry` bei Tampering-Verdacht (T79). Die Eigentümer-Prüfung ist **best-effort**: sie läuft nur, wenn der
Prozess die Metadaten sehen darf, und ist über ein injizierbares `fs.stat` testbar; in CI ohne
`root` prüft T79 primär die Mode-Bits und die Allowlist.
### `src/federation/ids.ts` (neu)
```ts
export const SELF_INSTANCE = "self" as const;
export const SELECTOR_INSTANCES = ["all", "*"] as const;
export const RESERVED_INSTANCES = [SELF_INSTANCE, ...SELECTOR_INSTANCES] as const;

export interface QualifiedId { instance: string; noteId: string }

/** Splits at the FIRST "/" only. Returns null for an unqualified id. Accepts all selectors. */
export function parseQualifiedId(value: string): QualifiedId | null;

/**
 * Formats a qualified id. `self` is allowed (read alias); `all`/`*` are selectors and throw
 * FederationError("invalid_id"); a "/" in noteId throws.
 */
export function formatQualifiedId(instance: string, noteId: string): string;

export function isReservedInstance(value: string): boolean;   // self|all|* — Registry verbietet sie
export function assertFederatableNoteId(id: string): void;    // no "/" and not empty
```
**Escaping-Regel:** Es gibt in v1 **kein** Escaping. `parseQualifiedId` teilt am ersten `/`;
`noteId` darf danach kein weiteres `/` enthalten. Ein `/` in einer Note-ID macht die Note in der
Föderation ungültig (`invalid_id`, pro Instanz gemeldet, nicht still gedroppt). `self` ist ein
gültiger Read-Alias und wird von `formatQualifiedId` akzeptiert; `all`/`*` sind nur Selektoren
und werden von `formatQualifiedId` abgelehnt. Begründung: Percent-Encoding würde die Identität
verändern und Kollisionen erzeugen; die eingebauten IDs (`n-<uuid>`) sind unkritisch. Importierte
Fremd-IDs müssen validiert werden (T02, T40). Kein Raten, kein Trimmen, kein URL-Decoding.
### `src/federation/client.ts` (neu)
```ts
export interface InstanceClientOptions {
  id: string; base: string; app?: string; mode: "read" | "write";
  auth?: { header: string; value: string };   // value aus process.env, nie aus der Datei
  allowInsecure?: boolean;                       // private IPs erlaubt; link-local/metadata nie
  timeoutMs: number; fetchImpl?: typeof fetch;   // Tests
  redactor?: Redactor;                           // redigiert jede Fehlermeldung
}
export class InstanceClient implements ReadSource {
  readonly id: string; readonly app?: string; readonly environment?: Environment;
  readonly mode: "read" | "write";
  config(): Promise<HubConfig>; health(): Promise<HubHealth>;
  list(filter: NoteFilter): Promise<Note[]>; getNote(id: string): Promise<Note>;
  createNote(draft: NoteDraft): Promise<Note>;
  updateNote(id: string, patch: NotePatch): Promise<Note>;
  addMessage(id: string, message: Message): Promise<Note>;
  bulkRemove(ids: string[]): Promise<{ removed: number }>; sessions(): Promise<Session[]>;
  mcpCall<T>(tool: "export_bundle" | "import_bundle", args: Record<string, unknown>): Promise<T>;
  exportBundle(options: { format: "json" | "markdown"; includeDone: boolean }): Promise<ToolResponse>;
  importBundle(bundle: unknown, options: ImportOptions): Promise<ToolResponse>;
}
```
Kein Retry, kein Cache, kein Polling (NFR-2). Jeder Request hat `AbortController` +
`timeoutMs`; ein Timeout ist `timeout`, kein leerer Erfolg (T15). Der Auth-Header wird pro
Request aus der Env-Referenz gebaut; der Wert erscheint in keiner Fehlermeldung, keinem Log und
keinem `toJSON` (T14, T16). **`redirect: "manual"`:** jeder `3xx` ist `invalid_response` und wird
nicht verfolgt; damit kann ein Redirect nie einen Custom-Auth-Header auf einen fremden Host
tragen (T78). Vor jedem Request wird der Hostname aufgelöst und die resultierende IP gegen
dieselbe Policy geprüft; Link-Local/Metadata bleiben auch mit `allowInsecure` `invalid_base_url`
(T80, T92). Non-2xx wird auf `FederationError` mit Status gemappt (T67); ein HTML-Body ist
`invalid_response`, kein Parse-Fehler. `mcpCall` spricht `POST {base}/mcp` (JSON-RPC
`tools/call`); `export_bundle` läuft mit read-Scope, `import_bundle` mit write-Scope (T71).
### `src/federation/aggregate.ts` (neu)
```ts
export interface FederatedNote extends Note {
  instance: string;   // "self" oder Registry-ID; note.id ist in der Kopie "instance/noteId"
  app: string;        // aus /config oder Registry-Erwartung
}
export interface ReadSource {
  readonly id: string; readonly app?: string; readonly environment?: Environment;
  readonly mode?: "read" | "write";
  list(filter: NoteFilter): Promise<Note[]>;
}
export interface InstanceStatus {
  id: string; app?: string; environment?: Environment; ok: boolean;
  unverified?: boolean;   // only when `app` is missing; never for missing `federates`
  count?: number; code?: FederationErrorCode; version?: string;
  mode?: "read" | "write"; includeSelf?: boolean;   // self only
}
export interface AggregateOptions {
  limit: number; timeoutMs: number; instance?: string; includeSelf: boolean;
}
export async function aggregateList(
  sources: readonly ReadSource[], self: ReadSource | undefined,
  filter: NoteFilter, options: AggregateOptions,
): Promise<{ notes: FederatedNote[]; instances: InstanceStatus[];
  partial: boolean; truncated: boolean; errors: FederationError[] }>;
```
Alle ausgewählten Clients laufen parallel; jeder Fehler wird zu einem `FederationError`-Eintrag,
nie zu einem Abbruch aller. `partial = true` genau dann, wenn mindestens ein Client erfolgreich
und mindestens einer fehlgeschlagen ist; schlagen **alle** fehl, ist `notes: []`, `partial:
false`, und der Tool-Aufruf wird `isError: true` (T17, T68). Reihenfolge: Die Notes werden
zusammengeführt und danach **global** nach der gemeinsamen Review-Ordnung (`compareForReview`)
sortiert; erster Tie-Break ist `instance`, zweiter die qualifizierte `id`. Die Registry-Reihenfolge
bestimmt nur die Iteration, **nie** die Ausgabe; damit ist die Ausgabe deterministisch und
unabhängig von der Reihenfolge der Registry-Datei (T18). `limit` wird nach dem Zusammenführen angewandt;
`truncated = true`, wenn mehr Treffer vorhanden waren (T19). `FederatedNote.id` ist die
qualifizierte ID, `instance`/`app` sind gesetzt (`app` fällt auf die Registry-Erwartung oder
`"unknown"` zurück, wenn `/config.app` fehlt), `environment` bleibt die Note-Env (T20).
### `src/federation/backend.ts` (neu)
```ts
export interface SelfSource extends ReadSource {   // kombinierter Hub; In-Process, kein HTTP
  readonly readOnly: boolean;
  get(id: string): Promise<Note | undefined>;
  create(draft: NoteDraft): Promise<Note>; update(id: string, patch: NotePatch): Promise<Note>;
  addMessage(id: string, message: Message): Promise<Note>; remove(id: string): Promise<void>;
  bulkRemove(filter: NoteFilter): Promise<{ removed: number }>; sessions(): Promise<Session[]>;
  exportBundle(options: { format: "json" | "markdown"; includeDone: boolean }): Promise<ToolResponse>;
  importBundle(bundle: unknown, options: ImportOptions): Promise<ToolResponse>;
}
export interface FederationBackendOptions {
  registry: Registry; self?: SelfSource;
  readOnly: boolean; allowWrite: boolean;   // second lock; write needs allowWrite && !readOnly
  includeSelf: boolean; timeoutMs: number; limit: number; appName: string;
}
export function createFederationBackend(options: FederationBackendOptions): McpBackend;
```
Reads: `list` ruft `aggregateList(sources, self, …)`; `get(id, instance?)` parst die ID und prüft
eine zusätzlich übergebene `instance` auf Gleichheit (`invalid_argument`); bei fehlender
Qualifikation `self` (sofern vorhanden) sonst `instance_required`; `sessions` liefert
qualifizierte `Session`-Kopien (`ref: "instance/ref"`), nie einen Merge (T61). Writes:
`create(draft, instance)` verlangt eine Instanz; `update/addMessage/remove` verlangen eine
qualifizierte ID oder eine passende `instance`; `bulkRemove(filter, instance)` verlangt ebenfalls
eine Instanz (`instance_required`), `all`/`*` → `fanout_denied` — kein filterbasierter
Cross-Instance-Delete. `mode:"read"` oder fehlendes `allowWrite` → `mode_denied`; global
`readOnly` → `read_only`; `all`/`*` → `fanout_denied`; unbekannte ID → `unknown_instance`
(T50–T52, T59, T93, T94). **Self-Regeln (kanonisch, §4/§6/§7 identisch):** `self` ist schreibbar
gdw. `allowWrite && !readOnly && !self.readOnly && includeSelf`; `mode` gilt nur für
Registry-Instanzen;
`instance:"self"` bei `--no-self` → `self_unavailable`;
`list_instances` enthält `self` nur bei `includeSelf:true` und meldet `mode:"write"`/`"read"`
konsistent (T75–T77). **Write-Antworten** tragen die qualifizierte ID (`instance/noteId`) und ein
`instance`-Echo; Remote-Writes setzen `source:"agent"`, `authorType:"agent"` und die
Client-/Session-Header (T83). **Export/Import** laufen über `mcpCall` (`/mcp` der Ziel-Instanz);
`instance:"self"` läuft **lokal** über `SelfSource.exportBundle`/`importBundle` (kein HTTP,
kein neuer Endpunkt); `allow_env_mismatch` wird vorher mit `invalid_argument` abgelehnt
(T71, T84). Ein HTTP-200 der Ziel-Instanz gilt als persistiert; die Instanz ist die bestätigende
Autorität (F7 bleibt dort). Ein 5xx/Netzfehler ist ein Fehler, kein „vielleicht“.
### `src/federation/errors.ts` (neu)
```ts
export type FederationErrorCode =
  | "invalid_registry" | "invalid_base_url" | "unknown_instance" | "self_unavailable" | "mode_denied" | "read_only"
  | "timeout" | "partial" | "identity_mismatch" | "federates_missing" | "unverified"
  | "nested_federation" | "self_reference" | "id_collision"
  | "invalid_id" | "instance_required" | "fanout_denied" | "invalid_argument"
  | "environment_mismatch" | "usage"
  | "missing_credential" | "instance_unreachable" | "invalid_response"
  | "not_found" | "not_persisted";
export class FederationError extends Error {
  readonly code: FederationErrorCode; readonly instance?: string; readonly status?: number;
}
export class Redactor {
  constructor(secrets: readonly string[]);   // beim Start aufgelöste Env-Werte
  redact(message: string): string;           // entfernt alle Secrets + Teiltreffer
}
export function toMcpError(error: FederationError, redactor?: Redactor): ToolResponse;
export function toExitCode(error: FederationError, context: "health" | "runtime", redactor?: Redactor): number;
```
**Deprecated Alias-Schreibweisen (nicht kanonisch):** `instance_unknown`, `instance_read_only`,
`read_only_session` und `aggregate_export_refused` sind historische Schreibweisen aus den
Wave-1-Aufträgen; sie normalisieren auf `unknown_instance`, `mode_denied`, `read_only` bzw.
`instance_required` (`src/federation/errors.ts`, `ALIASES`/`canonicalErrorCode`). Sie sind
**keine** kanonischen Codes, werden von keinem Codepfad emittiert und nur noch von Tests
referenziert. Mit PR 4 werden sie entfernt; die Tests werden dabei auf die kanonischen Namen
umgestellt.

MCP: Tool-Fehler sind `isError`-Results mit `error.code`; nur echte Protokollfehler bleiben
JSON-RPC-Fehler. CLI/HTTP: **eine kanonische Tabelle in §7** ist die Single Source of Truth;
§6 leitet daraus nur ab. `Redactor` wird beim Start mit den aufgelösten Env-Werten gebaut,
entfernt auch Teiltreffer (T62) und wird an `toMcpError`, `toExitCode` sowie
`InstanceClientOptions.redactor` durchgereicht; jede Fehlermeldung verlässt den Prozess nur
redigiert (T16).
### `server/hub.ts` (neu) und `server/index.ts` (dünn)
```ts
export interface HubOptions extends ServerOptions {
  appName?: string;              // --app / BLUEPENCIL_APP; Identity anchor for /config.app
  registry?: string;             // --registry / BLUEPENCIL_REGISTRY
  includeSelf?: boolean;         // --include-self / --no-self (Default true)
  allowWrite?: boolean;          // --allow-write (second lock; default false)
  allowInsecure?: boolean;       // --allow-insecure (http + private IPs; link-local always blocked)
}

export async function startHub(options: HubOptions): Promise<RunningServer>;
export function parseHubArgs(argv: string[]): HubOptions | string;
```
`server/index.ts` bleibt der Build-Einstiegspunkt (`dist/server.js`) und re-exportiert
`startServer = startHub` sowie die bisherigen Typen/`parseServerArgs` für Tests und
`package.json#exports["./server"]`. `parseHubArgs`/`ServerOptions`/Hilfe nehmen **`--app` bzw.
`BLUEPENCIL_APP`** auf; ohne Flag bleibt der Default `"bluepencil hub"` (T82). `/notes`,
`/sessions`, `/bundle`, `/health` bleiben lokal (T22, T54). `/mcp` wählt: ohne Registry
`createStoreBackend` (T56), mit Registry `createFederationBackend` inkl. `self` (T55).
`/config` bekommt `app` (aus `--app`) und `federates` (`registry !== undefined`) (T21, T53).
`--allow-write` ist ausschließlich das zweite Schloss der **Föderations-Session**: es gate-t
Writes über das `/mcp`-Aggregat (auch `self`), nicht `/notes` und nicht den bestehenden
`/mcp`-Single-Store-Pfad ohne Registry; dieser bleibt byte-gleich (T56).
Der `self`-Client ist ein **In-Process**-Adapter auf den lokalen `FileNoteStore`, kein
HTTP-Loopback und ohne Credentials. **Self-Regeln (kanonische Formel, gilt überall):**
self ist im Aggregat gdw. `includeSelf`; schreibbar gdw. `allowWrite && !readOnly && !self.readOnly && includeSelf`;
`mode` gilt nur für Registry-Instanzen;
`instance:"self"` bei `--no-self` → `self_unavailable`; `list_instances` zeigt self nur bei
`includeSelf:true` (T75–T77). Ohne `--allow-write` ist auch `self` read-only.
### `server/federator.ts` (neu)
```ts
export interface FederatorOptions {
  registryPath: string;
  readOnly: boolean;
  allowWrite?: boolean;          // --allow-write (second lock; default false)
  timeoutMs?: number;            // Default 3000
  limit?: number;                // Default 200
  appName?: string;              // Default "bluepencil federator"
  sessionId?: string;
  allowInsecure?: boolean;       // --allow-insecure (http + private IPs; link-local always blocked)
}

export async function startFederator(options: FederatorOptions): Promise<{ close(): Promise<void> }>;
export function parseFederatorArgs(argv: string[]): FederatorOptions | string;
```
Start Reihenfolge: Registry laden/validieren (Dateirechte, 0600) → Env-Referenzen auflösen →
pro Instanz `GET /config` (Timeout) → `app` vergleichen (`identity_mismatch`, T48; fehlt `app` =
`unverified`-Warnung, T49) → `federates` prüfen (`false`; `true` = `nested_federation`, T46;
**fehlend = `federates_missing`**, Startfehler, T90) → `id:"self"` oder Selbst-URL =
`self_reference` (T47) → stdio-MCP starten. **Startverhalten:** fail-fast bei `invalid_registry`,
`identity_mismatch`, `federates_missing`, `nested_federation`, `self_reference`, `id_collision`,
`missing_credential`; **degraded start**
bei `instance_unreachable`/`timeout` — die Instanz bleibt in `list_instances` sichtbar
(`ok:false`, Code), `list_notes` liefert `partial`, `instances health` Exit 5 (T72). Begründung:
ein toter Staging-Hub darf das Lesen von Dev nicht verhindern; Identitätsfehler sind dagegen
gefährlich und bleiben fail-fast. `depends_on`-Races werden dadurch toleriert. `--include-self`
ist ein Usage-Fehler (kein Store); `--read-only` blockt alle Writes; ohne `--allow-write` sind
alle föderierten Writes (auch `self`) read-only (T51, T93, T94). Kein `/notes`, kein
HTTP-Server (T32).
### `src/mcp/stdio.ts` (neu) und `src/mcp/server.ts`
```ts
export interface StdioOptions {
  backend: McpBackend;
  appName: string;
  allowWrite: boolean;
  sessionId: string;
  serverName?: string;          // "bluepencil" | "bluepencil-federator"
}
export async function runStdioServer(options: StdioOptions): Promise<void>;
```
`src/mcp/server.ts` parst weiterhin `--store/--environment/--app/--allow-write/--session-id`,
baut `createStoreBackend` und ruft `runStdioServer`; das Verhalten bleibt identisch (T65).
`server/federator.ts` ruft dieselbe Schleife mit `createFederationBackend`.
### `src/mcp/tools.ts`

`ToolContext` wird von `store: Store` auf `backend: McpBackend` umgestellt; `ToolContext.environment`
bleibt optional (nur `scope:"single"`). Neue/geänderte Tool-Schemas:

| Tool | Änderung |
|---|---|
| `list_notes` | `instance?`, `limit?` (1..1000, Default 200), `environment?`; Single-Scope prüft `environment` gegen die Bindung (`environment_mismatch`), Föderation filtert nur; ohne `instance` Aggregat |
| `get_note` | `id` darf qualifiziert sein; optional `instance` (muss passen); die Prüfung liegt in `McpBackend.get(id, instance?)` |
| `create_note` | `instance` (bei Föderation Pflicht); Antwort qualifiziert (`instance/noteId`) |
| `reply` / `set_status` / `set_intent` | `id` qualifiziert oder `instance`; kein Unqualified-Write im Federator; Antwort qualifiziert |
| `export_bundle` | `instance` (bei Föderation Pflicht); Transport `/mcp` der Ziel-Instanz, `instance:"self"` lokal; kein Aggregat-Bundle |
| `import_bundle` | `instance` (bei Föderation Pflicht); Transport `/mcp`, `instance:"self"` lokal; `allow_env_mismatch` → `invalid_argument`; kein Fan-out |
| `list_instances` | **neu**, read-only, keine Argumente; liefert `id/app/environment/mode/ok/unverified/version/includeSelf`, **kein** `base`, **kein** `auth` |
| `inspect_bundle` | unverändert |

`bulk_remove` ist **kein MCP-Tool**, sondern ausschließlich eine interne
`McpBackend`-Methode (genutzt von `remove` und den Backend-Tests); die Tool-Oberfläche ist
**9 (Single) / 10 (Föderation inkl. `list_instances`)**. Ein `bulk_remove`-Aufruf über `tools/call`
existiert daher nicht und wird auch nicht beworben. Die Single-Scope-Projektion entfernt
`instance` aus jedem Schema und `limit` aus `list_notes`, damit ein Store keine Argumente anbietet,
die er ignoriert (F1).

`list_notes`-Antwort im Aggregat: `{ instances, partial, truncated, errors, environment?,
count, notes }`; jede Note ist eine Kopie mit qualifizierter `id`, `instance`, `app` (T58).
Markdown-Format setzt `[instance]` vor jede Zeile. `list_instances` ist die einzige neue
Tool-Definition; `tools/list` enthält danach in einer **federierten** Session 10 Tools, in einer
Single-Store-Session 9 (T23, T60). **Resources:** `listResources`
wird backend-aware; der Federator liefert `[]`, der Store-Backend weiterhin die drei
`bluepencil://`-URIs. `readResource` im Federator `null` → `INVALID_PARAMS`
`resource_unsupported` (T73). **Write-Provenance:** Remote-Writes setzen `source:"agent"`,
`authorType:"agent"`, `sessionRef` und die MCP-Client-/Session-Header explizit; die Antwort-ID
ist qualifiziert (T83).
### `src/mcp/protocol.ts`

`initialize.instructions` und `serverInfo.name` werden aus `StdioOptions.serverName`/
`backend.kind` gespeist, damit ein Client „federator“ statt „single store“ sieht.
`resources/list`/`resources/read` fragen `backend.resources()`/`readResource()`; der Federator
liefert eine leere Liste bzw. `resource_unsupported` (T73). **Keine** Änderung an
`PROTOCOL_VERSION` (`2024-11-05`) und keine neuen JSON-RPC-Methoden (T23, T26).
### `src/cli/bin.ts`
```ts
const EXIT = { ok: 0, usage: 1, conflict: 2, envMismatch: 3, invalid: 4, federation: 5 } as const;

// bluepencil instances validate --registry <file> [--allow-insecure] [--json]
// bluepencil instances list     --registry <file> [--allow-insecure] [--json]
// bluepencil instances health   --registry <file> [--timeout 3000] [--allow-insecure] [--json]
```
`validate`/`list` lesen nur die Datei; `health` ruft `/config` und `/health`. `--registry` oder
`BLUEPENCIL_REGISTRY`; fehlt beides → Usage (1). Ungültige Registry → 4. `health`: alle ok → 0,
mindestens eine unhealthy/partial/identity mismatch/startup-unreachable → 5. Die **kanonische
Tabelle in §7** ist maßgeblich; `mode_denied`/`read_only` sind keine Health-Fälle. `--json` ist
stabil und enthält keine Env-Werte (T42–T45, T72). Die bestehenden Commands bleiben unverändert.
Alle drei Commands akzeptieren zusätzlich `--allow-insecure`; `validate`/`list` bleiben offline,
das Flag lockert nur die URL-Policy für Lab-/Compose-Registries.
### `package.json`, `scripts/build.mjs`

```json
"bin": {
  "bluepencil": "./dist/cli.js",
  "bluepencil-hub": "./dist/server.js",
  "bluepencil-federator": "./dist/federator.js"
},
"exports": {
  "./server": { "import": "./dist/server.js" },
  "./federation": {
    "types": "./dist/types/federation/index.d.ts",
    "import": "./dist/federation.js"
  }
}
```
`scripts/build.mjs` erhält zwei Jobs: `federation` (`src/federation/index.ts` →
`dist/federation.js`, ESM, Node 20) und `federator` (`server/federator.ts` →
`dist/federator.js`, ESM, Node 20, Shebang prüfen). Der bestehende `server`-Job bleibt
`server/index.ts` → `dist/server.js`. `npm run smoke:federation` und
`npm run smoke:cli` (enthält die `instances`-Fälle) werden in PR 8 in `verify` aufgenommen (T33).
## 7. Semantik-Tabelle
### Reads, Writes, Sessions

| Operation | Backend | Eingabe | Verhalten | Env-Regel | Fehler |
|---|---|---|---|---|---|
| `list_notes` | single | ohne `instance` | unverändert: ein Store, eine Env | gebunden | — |
| `list_notes` | single | `environment` | Wert muss der Bindung entsprechen | **nie überschreiben** | `environment_mismatch` |
| `list_notes` | federation | ohne `instance` | Aggregat über `self` (falls `includeSelf`) + alle Instanzen; global sortiert (`compareForReview`, Tie-Break `instance`, dann qualifizierte `id`) | Mix erlaubt, Notes etikettiert | `partial`, `timeout`, `instance_unreachable` |
| `list_notes` | federation | `instance:"self"` | nur lokaler Store (kombinierter Hub); bei `--no-self` `self_unavailable` | self-Env | `self_unavailable` |
| `list_notes` | federation | `instance:"all"\|"*"` | Aggregat wie ohne `instance` | Mix | wie oben |
| `list_notes` | federation | `instance:"<id>"` | genau eine Instanz | deren Env | `unknown_instance`, `timeout` |
| `list_notes` | federation | `environment` | Filter, keine Bindung | schränkt ein | — |
| `get_note` | federation | `id:"dev/n-…"` | Route zu `dev`, Note mit qualifizierter ID | deren Env | `unknown_instance`, `not_found` |
| `get_note` | federation | `id:"self/n-…"` | `self` (kombinierter Hub) | self-Env | `self_unavailable` |
| `get_note` | federation | `id:"n-…"` | `self` (kombinierter Hub); reiner Federator: `instance_required` | self-Env | `instance_required` |
| `create_note` | federation | `instance:"dev"` | POST an `dev` nur bei `mode:"write"` **und** `--allow-write`; sonst `mode_denied`; Antwort `dev/n-…` + `instance:"dev"` | `dev`-Env, nie umgeschrieben | `mode_denied`, `read_only`, `not_persisted` |
| `create_note` | federation | `instance:"self"` | lokaler Store; schreibbar gdw. `allowWrite && !readOnly && !self.readOnly && includeSelf` | self-Env | `self_unavailable`, `read_only`, `mode_denied` |
| `create_note` | federation | ohne `instance` | `instance_required` | — | `instance_required` |
| `reply`/`set_status`/`set_intent` | federation | `id:"dev/n-…"` oder `instance`+`id` | Route zu genau einer Instanz nur bei `mode:"write"` **und** `--allow-write`; Antwort qualifiziert | deren Env | `mode_denied`, `read_only`, `not_found` |
| `bulk_remove` (Backend-Vertrag, kein MCP-Tool) | federation | `instance:"dev"` + Filter | löscht nur in `dev` und nur bei `mode:"write"` **und** `--allow-write`; Antwort `{removed}` | `dev`-Env | `mode_denied`, `read_only`, `not_persisted` |
| `bulk_remove` (Backend-Vertrag, kein MCP-Tool) | federation | ohne `instance` / `all` / `*` | `instance_required` bzw. `fanout_denied`; kein Cross-Instance-Delete | — | `instance_required`, `fanout_denied` |
| `export_bundle` | federation | `instance:"dev"` | `mcpCall("export_bundle")`; ein Bundle, eine Env | `dev`-Env | `instance_required`, `timeout` |
| `export_bundle` | federation | `instance:"self"` | lokal über `SelfSource.exportBundle` (kein HTTP) | self-Env | `self_unavailable` |
| `export_bundle` | federation | ohne `instance` | Refusal (kein Mixed-Env-Bundle) | — | `instance_required` |
| `import_bundle` | federation | `instance:"dev"` | `mcpCall("import_bundle")` nur bei `mode:"write"` **und** `--allow-write`; genau eine Instanz | `dev`-Env | `mode_denied`, `read_only`, `invalid_argument` |
| `import_bundle` | federation | `instance:"self"` | lokal über `SelfSource.importBundle` (kein HTTP) nur bei `allowWrite`; kein HTTP | self-Env | `self_unavailable`, `read_only`, `mode_denied`, `invalid_argument` |
| `import_bundle` | federation | `allow_env_mismatch` | **abgelehnt** | — | `invalid_argument` |
| `sessions` | federation | `instance?` | `Session.ref` qualifiziert (`dev/review-1`); `Note.sessionRef` bleibt unqualifiziert | instanzlokal | `unknown_instance` |
| `session`-Filter | federation | `dev/review-1` | Prefix routet zu `dev`, Filter `review-1` | deren Env | `unknown_instance` |
| `session`-Filter | federation | `review-1` | pro Instanz lokal; keine cross-instance-Session | je Instanz | — |
| `includeSelf` | kombinierter Hub | default `true` | `self` im Aggregat; `--no-self` schließt aus | self-Env | `self_unavailable` |
| `includeSelf` | reiner Federator | `--include-self` | Usage-Fehler (kein Store) | — | `usage` |
| `--allow-write` | federation | **nicht** gesetzt | jeder föderierte Write `mode_denied`, auch `self`; Reads unverändert | — | `mode_denied` |
| `--read-only` | alle | gesetzt | jeder Write `read_only`, auch bei `mode:"write"` und `--allow-write`; stärker als `--allow-write` | — | `read_only` |
| `resources` | federation | `resources/list` | leer; `resources/read` `resource_unsupported` | — | Protocol `INVALID_PARAMS` |

### Kanonische Fehler-→-Exit-Tabelle (Single Source of Truth)

| Code | MCP | CLI `instances health` | CLI runtime | HTTP (Instanz) |
|---|---|---|---|---|
| `unknown_instance` | `isError` | 0 (kein Health-Fall) | 4 | — (lokal) |
| `self_unavailable` | `isError` | 0 | 4 | — |
| `mode_denied` | `isError` | 0 (read-only ist gesund) | 4 | 403/405 |
| `read_only` | `isError` | 0 | 4 | 403 |
| `timeout` | `partial`-Eintrag | 5 | 5 | — |
| `partial` | `partial:true` | 5 | 5 | — |
| `identity_mismatch` | Start verweigert | 4 | 4 | 200 mit fremdem `app` |
| `federates_missing` | Start verweigert | 4 | 4 | 200 ohne `federates` |
| `unverified` | Warnung | 5 | 0 | 200 ohne `app` (nur `app`, nie `federates`) |
| `nested_federation` | Start verweigert | 4 | 4 | 200 `federates:true` |
| `self_reference` | Start verweigert | 4 | 4 | — |
| `invalid_registry` | Start verweigert | 4 | 4 | — |
| `invalid_base_url` | Start verweigert | 4 | 4 | — |
| `id_collision` | Start verweigert | 4 | 4 | — |
| `invalid_id` | `partial`-Eintrag | 5 | 4 | 200 mit ungültiger ID |
| `instance_required` | `isError` | 0 | 4 | — |
| `fanout_denied` | `isError` | 0 | 4 | — |
| `invalid_argument` | `isError` | 0 | 4 | — |
| `environment_mismatch` | `isError` | 0 | 4 | 400 |
| `usage` | `isError` (Tool-Argument) | 0 | 1 | — |
| `missing_credential` | Start verweigert | 4 | 4 | — |
| `instance_unreachable` | `partial`-Eintrag | 5 | 5 | — |
| `invalid_response` | `partial`-Eintrag | 5 | 5 | — |
| `not_found` | `isError` | 0 | 4 | 404 |
| `not_persisted` | `isError` | 0 | 5 | 5xx |

**HTTP-Mapping:** Der Federator ist kein HTTP-Proxy für Notes; die HTTP-Spalte beschreibt, was
die **Instanz** antwortet. `/notes` des Hubs bleibt der unveränderte Ein-Env-Vertrag. Ein
Federator hat keinen `/notes`-Endpunkt, also auch kein HTTP-Mapping für Aggregat-Antworten.
**§6 leitet ausschließlich aus dieser Tabelle ab;** `mode_denied`/`read_only` sind keine
Health-Fälle, `invalid_response`/`not_persisted` sind explizit zugeordnet (T70). Eine fehlerhafte
oder durch die Policy blockierte Base-URL (`invalid_base_url`, z. B. Link-Local/Metadata, private
IP ohne `--allow-insecure`, Query/Fragment/Userinfo) **verweigert den Start mit Exit 4** — genau
wie `invalid_registry`; die Tabelle ist deckungsgleich mit `src/federation/errors.ts`.
## 8. Testplan

Harness: `tests/unit/*.test.ts` (Vitest, jsdom default; Node-Fälle per Docblock), Contract-Tests
gegen einen In-Process-Hub, E2E über den bestehenden CDP-freien Node-Harness (kein Playwright).
Testnamen Englisch. Die Nummern T01–T94 sind der stabile Index; in §3–§6 wird nur die Nummer
zitiert.
### Unit / Contract / E2E / Security / CLI

| # | Test-ID | Beweist |
|---|---|---|
| T01 | `ids.parse.first_slash_only` | `dev/n-1/x` → `{instance:"dev", noteId:"n-1/x"}`; `assertFederatableNoteId` lehnt den Rest mit `/` ab |
| T02 | `ids.reject_slash_in_note_id` | `formatQualifiedId("dev","a/b")` wirft `invalid_id`; keine stille Kürzung |
| T03 | `ids.reserved_instances` | `all`/`*` sind Format-/Write-Verboten; `self` ist Read-Alias und `isReservedInstance` bleibt für Registry-IDs true |
| T04 | `ids.format_roundtrip` | `parse(format(i,n))` liefert `{i,n}` für gültige IDs **inkl. `self`**; `format("all",…)` wirft |
| T05 | `registry.loads_minimal` | minimale Registry mit einer Instanz lädt; Defaults `mode:"read"`, `includeSelf:true` |
| T06 | `registry.rejects_literal_token` | `token`/`secret`/`password`/`authorization`/`headers` als String → `literal_secret` |
| T07 | `registry.rejects_unknown_field` | unbekanntes Feld auf Top-Level, `defaults` oder Instanz → `unknown_field` |
| T08 | `registry.rejects_duplicate_id` | zwei Instanzen mit `id:"dev"` → `duplicate_id` |
| T09 | `registry.rejects_reserved_id` | `id:"self"`/`"all"`/`"*"` → `reserved_id` |
| T10 | `registry.rejects_non_http_url` | `file:`, `ftp:`, `javascript:`, `data:` → `invalid_base_url` |
| T11 | `registry.rejects_userinfo_url` | `https://user:pass@host/...` → `invalid_base_url` |
| T12 | `registry.requires_env_for_auth` | `auth:{}` oder `auth:{env:""}` → `missing_auth_env` |
| T13 | `registry.missing_env_is_start_error` | `auth.env` gesetzt, Variable fehlt → `missing_env_var`, kein Start |
| T14 | `client.auth_header_from_env` | Header wird pro Request aus der Env-Referenz gebaut; richtiger Name/Scheme |
| T15 | `client.timeout_aborts` | hängende Instanz → `timeout` nach `timeoutMs`, kein leerer Erfolg |
| T16 | `client.no_token_in_error` | Fehlermeldung/`toString` enthält keinen Tokenwert — auch über den verdrahteten `Redactor` in `InstanceClientOptions` |
| T17 | `aggregate.partial_timeout_envelope` | eine von zwei Instanzen timeoutet → `partial:true`, `errors:[timeout]`, Notes der anderen |
| T18 | `aggregate.deterministic_order` | zwei Läufe liefern dieselbe Reihenfolge; sie folgt `compareForReview` mit `instance`- und qualifiziertem `id`-Tie-Break, nicht der Registry-Reihenfolge |
| T19 | `aggregate.limit_truncated` | 250 Treffer, `limit:200` → 200 Notes, `truncated:true` |
| T20 | `aggregate.qualifies_ids` | jede Aggregat-Note hat `instance/…`, `instance`, `app`; Original unverändert |
| T21 | `contract.hub_config_v0_10` | `/config` liefert `app` + `federates`; `federates:false` ohne Registry |
| T22 | `contract.notes_single_env_unchanged` | `/notes` bleibt ein Store/eine Env; keine `instance`-Felder, keine Aggregation |
| T23 | `contract.mcp_tools_list_includes_list_instances` | `tools/list` einer **federierten** Session enthält 10 Tools inkl. `list_instances` (mit `instance`); eine Single-Store-Session behält 9 Tools ohne `instance`/`limit`; Protokollversion unverändert |
| T24 | `contract.instance_client_roundtrip` | `InstanceClient` gegen In-Process-Hub: config/health/list/get/create/update/message/bulk/sessions |
| T25 | `contract.federation_read_parity` | Aggregat-Notes entsprechen den Einzelabrufen (gleiche Note-Inhalte, nur Etiketten/ID qualifiziert) |
| T26 | `contract.mcp_http_door_unchanged` | `/mcp` ohne Registry nutzt denselben Store wie `/notes` (FR-16.9) |
| T27 | `e2e.federator_two_hubs_mixed_env` | Federator + Dev/Staging; Aggregat zeigt beide Envs, Writes nur nach Dev |
| T28 | `e2e.federator_partial_outage` | ein Hub gestoppt; Aggregat bleibt nutzbar, `partial:true`, Health-Exit 5 |
| T29 | `e2e.hub_registry_combined` | Hub mit `--registry`: `/notes` lokal, `/mcp` self+remote; `includeSelf` wirkt |
| T30 | `e2e.cli_instances_health` | `instances health` gegen zwei Hubs, einer down → Exit 5, Ausgabe ohne Secrets |
| T31 | `e2e.browser_writes_one_hub` | Browser/Element schreibt in genau einen Hub; keine Registry-Anfrage |
| T32 | `e2e.federator_no_browser_endpoint` | Federator hat keinen `/notes`/`/config`-HTTP-Endpunkt; nur stdio |
| T33 | `e2e.docker_compose_aggregator` | **bedingter CI-/Manual-Gate** (Docker-Umgebung nötig): Compose startet den aggregierenden Hub plus zwei Leaf-Hubs; `instances health` gegen die Leaf-Hubs ist grün; der Federator wird als one-shot `docker run -i --rm … bluepencil-federator` angebunden (kein Compose-Dauerdienst). |
| T34 | `security.registry_literal_secret_rejected` | literale Tokens werden vor jedem Netzaufruf abgelehnt (Secret-Scan-Fall) |
| T35 | `security.tool_output_no_secret` | `list_instances`/`list_notes`/Fehler enthalten keine Tokens/Env-Werte |
| T36 | `security.error_no_secret` | 401/403/5xx-Meldungen sind redigiert; kein Authorization-Header im Body |
| T37 | `security.logs_no_secret` | Start-/Health-/Fehlerlogs enthalten weder Token noch Env-Wert |
| T38 | `security.read_only_instance_refuses_write` | `mode:"read"` → `mode_denied`; Instanz erhält keinen POST/PATCH |
| T39 | `security.no_cross_env_write` | Föderator schreibt nie `environment` um; `--allow-env-mismatch` wird nicht forwardiert |
| T40 | `security.qualified_id_no_path_traversal` | `../`, leere Instanz, `%2F` werden abgelehnt; keine URL-Pfad-Injektion |
| T41 | `security.registry_url_policy` | non-loopback `http` und private IPs (RFC1918/ULA) werden ohne `--allow-insecure` abgelehnt; mit Flag erlaubt (T91); Link-Local/Metadata nie |
| T42 | `cli.instances_validate_exit_codes` | gültig → 0; ungültig → 4; fehlendes `--registry` → 1 |
| T43 | `cli.instances_health_exit_codes` | alle ok → 0; einer down/mismatch → 5; ungültige Registry → 4 |
| T44 | `cli.instances_list_no_secrets` | Liste zeigt id/app/base/mode, aber keine Auth-/Env-Werte |
| T45 | `cli.federator_startup_exit_codes` | ungültige Registry 4, Usage 1, Identitätsmismatch 4, `--include-self` 1; unerreichbar → degraded, Health 5 (T72) |
| T46 | `federator.rejects_nested_federation` | `/config.federates:true` → Startfehler `nested_federation` |
| T47 | `federator.rejects_self_reference` | `id:"self"` oder eigene Base → `self_reference` |
| T48 | `federator.identity_mismatch` | Registry-`app` ≠ `/config.app` → Startfehler |
| T49 | `federator.unverified_missing_app` | `/config` ohne `app` → Warnung, `unverified:true`, Start erlaubt; `federates` ist vorhanden (fehlendes `federates` ist T90) |
| T50 | `federator.mode_read_denies_write` | Default `read`; Write → `mode_denied`; mit `mode:"write"` **und** `--allow-write` erlaubt; ohne `--allow-write` → `mode_denied` (T94) |
| T51 | `federator.global_read_only_wins` | `--read-only` blockt auch `mode:"write"` + `--allow-write`; `--read-only` ist stärker |
| T52 | `federator.instance_required_for_write` | Write ohne Instanz/Qualifikation → `instance_required` |
| T53 | `hub.config_no_secrets` | `/config` enthält nie `authSecret`, `tokenKey`, Tokenwerte oder Env-Werte |
| T54 | `hub.notes_stays_local` | `/notes` eines Hubs mit Registry liefert nur den lokalen Store |
| T55 | `hub.mcp_aggregates_with_registry` | `/mcp` mit Registry liefert self + remote; `includeSelf` steuerbar |
| T56 | `hub.mcp_without_registry_unchanged` | `/mcp` ohne Registry ist byte-gleich zum 0.8-Verhalten (gleiche Tools/Antworten) |
| T57 | `hub.include_self_flag` | `--include-self`/`--no-self` und `defaults.includeSelf` wirken; Default true |
| T58 | `tools.list_notes_aggregate_envelope` | Envelope `{instances,partial,truncated,errors,count,notes}`; Markdown mit `[instance]` |
| T59 | `tools.write_routes_to_instance` | `create/reply/set_status/set_intent/import` treffen genau eine Instanz; die interne Backend-Methode `bulk_remove` (kein MCP-Tool) ohne Instanz → `instance_required`, `all`/`*` → `fanout_denied`; Export/Import via `/mcp`; kein Fan-out |
| T60 | `tools.list_instances_no_secrets` | Tool liefert id/app/env/mode/includeSelf/ok/unverified/version, aber kein `base`/`auth`; Typ bindet `mode` |
| T61 | `sessions.qualified_ids` | Aggregat-Sessions sind `instance/ref`; `Note.sessionRef` bleibt unqualifiziert |
| T62 | `redaction.multiple_secrets_and_partial` | `Redactor` entfernt mehrere aufgelöste Secrets und Teiltreffer aus Meldungen |
| T63 | `browser.no_instance_attribute` | `ALL_ATTRIBUTES` enthält kein `instance`; Loader forwardet es nicht |
| T64 | `extension.config_extra_fields_tolerated` | Extension-Settings unverändert; `/config`-Zusatzfelder brechen die Anzeige nicht |
| T65 | `backend.store_parity` | `createStoreBackend` liefert für alle 9 bestehenden Tools **dieselben Tool-Antworten** wie vor dem Refactor |
| T66 | `client.list_notes_filter_forwarded` | Filter `status/intent/type/priority/route/session/includeDone/environment` wird korrekt ge-URL-t |
| T67 | `client.http_status_mapping` | 401/403/404/409/5xx → stabile `FederationErrorCode`s |
| T68 | `aggregate.all_fail_is_error` | alle Instanzen down → `notes:[]`, `isError:true`, keine stille Leerantwort |
| T69 | `registry.include_self_default` | kombinierter Hub: `defaults.includeSelf` fehlt → true; explizit false bleibt false; reiner Federator: Feld ist No-op (kein `self`, keine Wirkung) |
| T70 | `error.mapping_mcp_cli` | jeder `FederationErrorCode` folgt der kanonischen Tabelle §7; `mode_denied`/`read_only` nicht in Health |
| T71 | `federation.export_import_via_mcp` | `export_bundle` → genau **ein** `tools/call` am Ziel, read-Scope; `import_bundle` gegen `mode:"read"` → `mode_denied` und **kein** POST; `instance:"self"` läuft lokal über `SelfSource`; kein zweiter Request an eine andere Instanz |
| T72 | `federation.startup_unreachable_degraded` | tote Instanz beim Start → degradierter Start, `list_instances` `ok:false`, `partial`, Health 5; `depends_on`-Race toleriert |
| T73 | `federation.resources_unsupported` | Federator `resources/list` = `[]`, `resources/read` = `resource_unsupported`; Single Store unverändert |
| T74 | `federation.read_source_include_self` | `ReadSource` trägt `InstanceClient` und Self-Adapter; `includeSelf:true/false` ändert Aggregat und Status |
| T75 | `federation.self_write_enabled` | self schreibbar gdw. `!readOnly && !self.readOnly && includeSelf`; `mode` gilt nicht für self |
| T76 | `federation.self_no_self_read` | `--no-self` + `instance:"self"` → `self_unavailable`; self fehlt im Aggregat |
| T77 | `tools.list_instances_includes_self` | `list_instances` enthält self nur bei `includeSelf:true`, mit konsistentem `mode` |
| T78 | `security.redirect_no_auth_leak` | `302` auf fremden Host → `invalid_response`, kein zweiter Request, kein Token |
| T79 | `security.registry_tampering` | World-Writable/zu offene Mode-Bits und Allowlist-Verstoß → Startfehler, keine Token-Exfiltration; Eigentümer-Check best-effort über injiziertes `fs.stat` (in CI ohne `root` nicht real herstellbar) |
| T80 | `security.ssrf_link_local_rejected` | `169.254.0.0/16`, `fe80::/10`, Metadata-Ziele literal **und** als Hostname, der dorthin auflöst (DNS-Rebinding), → `invalid_base_url`; private Bereiche nur mit `--allow-insecure`; Link-Local/Metadata bleiben auch mit `--allow-insecure` blockiert (T92) |
| T81 | `security.credential_blast_radius` | pro Instanz nur ihr eigenes Token; kein Auth-Header-Bleed zwischen Instanzen |
| T82 | `hub.app_flag_sets_config` | `--app`/`BLUEPENCIL_APP` setzt `/config.app`; ohne Flag Default |
| T83 | `federation.write_response_qualified` | `create_note` auf `dev` → `dev/n-…` + `instance`-Echo; `get_note` trifft `dev`; `source=agent` |
| T84 | `federation.allow_env_mismatch_rejected` | `import_bundle{allow_env_mismatch:true}` im Föderationsmodus → `invalid_argument`; Single Store unverändert |
| T85 | `registry.rejects_unsupported_schema` | `schemaVersion` ≠ 1 → `unsupported_schema` |
| T86 | `registry.rejects_query_fragment_url` | `base` mit `?query`/`#fragment` → `invalid_base_url` |
| T87 | `aggregate.defaults_timeout_limit_clamp` | `defaults.timeoutMs:50` gegen einen 200-ms-Hub → `timeout`; `limit:5000` → auf 1000 geklemmt; `truncated` korrekt |
| T88 | `sessions.filter_qualified_and_local` | `session:"dev/review-1"` routet; `session:"review-1"` filtert pro Instanz; beide dokumentiert |
| T89 | `tools.list_notes_environment_guard` | Single-Scope `environment` ≠ Bindung → `environment_mismatch`; Aggregat-Filter schreibt `environment` nie um |
| T90 | `federator.rejects_missing_federates` | `/config` ohne `federates` (auch mit `app`) → Startfehler `federates_missing`, **kein** `unverified` |
| T91 | `security.allow_insecure_http_and_private` | mit `--allow-insecure`: non-loopback `http` und RFC1918/ULA erlaubt; Default aus mit Warnung im Log |
| T92 | `security.allow_insecure_still_blocks_link_local` | Link-Local/Metadata literal und per DNS auch mit `--allow-insecure` → `invalid_base_url`, kein Request |
| T93 | `federator.allow_write_required` | ohne `--allow-write` sind alle föderierten Writes (auch `self`) `mode_denied`; Reads unverändert |
| T94 | `federator.mode_write_without_allow_write` | `mode:"write"` ohne `--allow-write` → `mode_denied`, **kein** POST an die Instanz |
### Traceability (Akzeptanz → Test)

| Test-IDs | Requirement | PR |
|---|---|---|
| T01–T04 | FR-16.11 (qualifizierte IDs, `self`) | 2 |
| T05–T13, T34, T41, T79, T80, T85, T86, T91, T92 | FR-16.10 (Registry/URL/Secret) | 2 |
| T14, T15, T17–T20, T24, T25, T66–T68, T87 | FR-16.12 (Client/Aggregat/Timeout/limit) | 3 |
| T21, T53, T82 | FR-6.15 (`/config` `app`/`federates`) | 5 |
| T90 | FR-6.15 (`federates`-Pflicht beim Start) | 6 |
| T22, T54 | FR-16.3 (Env-Isolation, `/notes`) | 5 |
| T31 | FR-16.3 (Browser schreibt einen Hub) | 7 |
| T89 | NFR-18 (Single-Scope-Env-Guard) | 4 |
| T23, T40, T60, T61, T77, T88 | FR-16.11 (`instance`, Sessions, `list_instances`) | 4 |
| T65 | FR-16.9 (two doors, one store) | 1 |
| T26, T56 | FR-16.9 (two doors, one store) | 5 |
| T27–T28 | FR-16.12 (Laufzeit-Teilausfall) | 6 |
| T29, T55, T57 | FR-16.14 (kombinierter Hub/includeSelf) | 5 |
| T32, T46–T49 | FR-16.14 (Federator-Start/Nested) | 6 |
| T69, T75 | FR-16.14 (`includeSelf`/self) | 4 |
| T74 | FR-16.14 (`ReadSource`/Self-Adapter) | 3 |
| T76 | FR-16.14 (`--no-self` + self) | 5 |
| T30, T42–T45, T70, T72 | FR-16.15 (CLI/Startup/Exit-Codes) | 6 |
| T33 | FR-16.14 (Docker, bedingter Gate) | 8 |
| T35–T37, T81 | NFR-22 (Secret-Hygiene/Blast-Radius) | 8 |
| T62 | NFR-22 (Redactor) | 2 |
| T16 | NFR-22 (Client-Fehlerpfad) | 3 |
| T38–T39, T50–T52, T59, T71, T83–T84, T93–T94 | FR-16.13 (Write/Export/Import) | 4 |
| T58 | FR-16.12 (Aggregat-Envelope) | 4 |
| T63 | FR-16.14 (Client-Grenze) | 7 |
| T64 | FR-6.15 (Extension-Toleranz) | 7 |
| T73 | FR-16.5 (Resources-Einschränkung) | 6 |
| T78 | NFR-22 (Redirect-Leak) | 3 |

**Test-Gates je PR:** Unit-Tests des jeweiligen Moduls + die in §10 genannten Suiten. Ein PR ist
erst „grün“, wenn `npm run typecheck`, `npm run test` und die betroffenen Contract-/E2E-Läufe
durch sind; Security-Tests sind ab PR 3 verpflichtend, sobald der jeweilige Code existiert
(T34 bereits in PR 2, T78 in PR 3, T35–T37/T81 spätestens in PR 8), spätestens in PR 8 vollständig.
T33 ist ein **bedingter CI-/Manual-Gate** (Docker-Umgebung); T25/T69/T70 sind oben explizit
zugeordnet. **Diese Matrix ist die Single Source of Truth für Requirement- und PR-Zuordnung;**
die §10-Gates werden daraus abgeleitet. Jede Test-ID T01–T94 kommt genau einmal vor.
## 9. Doku-Plan
### README

| Abschnitt | Aussage (englisch) |
|---|---|
| `Status` | `0.10.0`; ein Satz: federation is an **agent-side** layer over hubs; browser clients still write to one hub |
| `Ways to put it on a page` | Zeile für „Agent over several hubs“ → `bluepencil-federator`; Zeile für „Hub with a registry“ → `bluepencil-hub --registry`; Browser-Zeilen unverändert |
| **neu:** `## Federation: one agent, several hubs` | Kurzüberblick, drei Betriebsarten, Link `docs/FEDERATION.md`, ein Mini-Registry-Beispiel; ausdrücklich: no browser federation, no `instance` attribute |
| `The browser extension` | Ein Profil in v1; ein `federates:true`-Hub ändert das Schreibziel nicht; Link FEDERATION |
| `Honest Gaps` | kein Cross-Instance-Session-Merge; Aggregat liest alle Notes bis `limit`; Extension ein Hub-Profil; Hubs < 0.10 ohne `federates` sind nicht föderierbar (`federates_missing`); `unverified` nur bei fehlendem `app` |
| `Documentation` | `docs/MCP.md` und `docs/FEDERATION.md` ergänzen; `docs/HERMES.md` als Beispiel kennzeichnen |
| `prod` vs `live` | alle Beispielwerte auf `live` normalisieren (Ist: Extension migriert `prod`→`live`; Doku driftet) |
### Neue und geänderte Dokumente

| Datei | Inhalt |
|---|---|
| **neu** `docs/MCP.md` | Agenten-Vertrag: stdio, HTTP `/mcp`, 10 Tools, `list_instances`, qualifizierte IDs, Env-Bindung, read-only, Fehlercodes, Export/Import-Transport, Resource-Einschränkung im Federator, generische Client-Beispiele („any MCP client“), Troubleshooting |
| **neu** `docs/FEDERATION.md` | Drei Betriebsarten, Registry-Schema, URL-/Secret-Policy, IDs, Read-/Write-Semantik, `includeSelf`/self-Regeln, Identität/`federates_missing` (`unverified` nur bei fehlendem `app`), eine Föderationsebene, Threat Model, Export/Import über `/mcp`, Health/Startup, Deployment-Shapes, Rollback, Grenzen |
| `docs/HERMES.md` | von „Hermes-Anleitung“ zu „Beispiel: Hermes“; Abschnitt „any MCP client“ voranstellen; Federator-Registrierung als Beispiel; Tool-Tabelle um `list_instances` |
| `docs/ARCHITECTURE.md` | §4 Backend-Abstraktion; §5 `/config` app/federates; **neu §5d Federation** (Module, `/notes` vs `/mcp`, Env-Isolation); §5c CLI `instances`; §6 Bookmarklet unverändert |
| `docs/INTEGRATION.md` | „Choosing a mode“ um Föderation ergänzen; Auth pro Instanz; Security-Notes (keine Browser-Registry, ein Schreibziel) |
| `docs/DOCKER.md` | Aggregierender Hub plus zwei Leaf-Hubs, Registry-Mount, `BLUEPENCIL_REGISTRY`, one-shot `docker run -i --rm … bluepencil-federator` als angehängter MCP-Client, `--read-only`, `--allow-write`, `--allow-insecure` nur im privaten Netz (HTTP + private IPs; Link-Local/Metadata bleiben immer blockiert); Grenzen (kein TLS, ein Writer pro Store) |
| `docs/EMBED.md` | Endpoint-Tabelle: `/notes` ist und bleibt lokal; `/mcp` ist kein Browser-Endpunkt; kein `instance`-Attribut |
| `docs/RELEASING.md` | 0.10.0-Assets um `bluepencil-federator` ergänzen; Reihenfolge Build → Verify → Tag; keine Schema-/Store-Format-Änderung |
| `.github/workflows/*` | `smoke:federation` und `smoke:cli` in CI; Docker-/Compose-Job (aggregierender Hub + zwei Leaf-Hubs) als **bedingter** Gate (nicht blockierend ohne Docker); der Federator-Gate ist ein one-shot `docker run -i`. |
| `docs/BUILD-SYNC.md` | Version 0.10.0 in `package.json` + `extension/manifest.json`; Federator-Bin ist kein Element-Bundle, `verify:sync` bleibt Element-fokussiert |
### SVG

`docs/images/federation.svg` — drei Panels nebeneinander: „Single Store“, „Hub + Browser“,
„Federator + Registry + 2 Hubs“. Durchgezogene Pfeile: Browser → Hub, MCP-Client → Federator,
Federator → `/config`/`/notes` je Hub. Gestrichelte rote Pfeile mit „not allowed“: Browser →
Registry, Browser → Federator, Federator → Federator (nested), Write-Fan-out. Jede Box mit
`role="img"`/`<title>`; Farbe nur als Sekundärinformation, Text ist die Aussage. Keine
Screenshots, keine Marketing-Grafik.
### Fünf Deployment-Shapes (vollständige Beispiele, Englisch)

**(a) Single Store, stdio**

```bash
bluepencil mcp \
  --store ./notes.bluepencil.json \
  --environment dev \
  --app my-web-tool \
  --allow-write
```
```json
{"mcpServers":{"bluepencil":{"command":"bluepencil",
 "args":["mcp","--store","./notes.bluepencil.json","--environment","dev","--app","my-web-tool"]}}}
```
**(b) Single Hub + Browser**

```bash
bluepencil-hub \
  --store /srv/bluepencil/notes.json \
  --port 8787 \
  --host 127.0.0.1 \
  --name "Dev hub" \
  --app my-web-tool \
  --environment dev
```
```html
<bluepencil-notes
  endpoint="http://127.0.0.1:8787/api/v1/bluepencil"
  environment="dev"
  app="my-web-tool"
  session="review-2026-10-22"></bluepencil-notes>
```
**(c) Hub mit Registry, nur lesend**

`registry.json`:

```json
{"schemaVersion":1,
 "defaults":{"includeSelf":true,"mode":"read","timeoutMs":3000},
 "instances":[{"id":"staging-web","base":"https://staging.example.com/api/v1/bluepencil",
   "app":"my-web-tool","mode":"read","auth":{"env":"BP_STAGING_TOKEN"}}]}
```
```bash
BLUEPENCIL_REGISTRY=./registry.json \
bluepencil-hub \
  --store /srv/bluepencil/dev.json \
  --app my-web-tool \
  --environment dev \
  --read-only
```
The browser still calls `/notes` on this hub and sees only `dev.json`. An MCP client calls
`/mcp` and sees `self` (read-only) plus `staging-web` (read-only).

**(d) Federator + zwei Hubs (Dev/Staging-Mix, Dev schreibbar)**

`federation.json`:

```json
{"schemaVersion":1,
 "defaults":{"mode":"read","timeoutMs":3000},
 "instances":[
  {"id":"dev-web","base":"http://127.0.0.1:8787/api/v1/bluepencil",
   "app":"my-web-tool","mode":"write","auth":{"env":"BP_DEV_TOKEN"}},
  {"id":"staging-web","base":"https://staging.example.com/api/v1/bluepencil",
   "app":"my-web-tool","mode":"read","auth":{"env":"BP_STAGING_TOKEN"}}]}
```
```bash
bluepencil-federator --registry ./federation.json --allow-write
```
```json
{"mcpServers":{"bluepencil-federation":{"command":"bluepencil-federator",
 "args":["--registry","./federation.json","--allow-write"],
 "env":{"BP_DEV_TOKEN":"set-in-your-shell","BP_STAGING_TOKEN":"set-in-your-shell"}}}}
```
Read: `list_notes` without `instance` returns both environments, each note tagged. Write:
`create_note { "instance": "dev-web", "body": "…", "type": "bug" }` — `staging-web` receives
nothing. Writes need **two locks**: `mode:"write"` in the registry **and** `--allow-write` on the
session; without `--allow-write` even a `mode:"write"` entry is read-only. `--read-only` would
block even the dev write and is stronger than `--allow-write`. `includeSelf` is deliberately
absent here: it only applies to a **combined hub**, not to a pure federator. `--allow-insecure`
would be needed only for non-loopback `http` or private IPs and never unlocks link-local/metadata.

**(e) Docker Compose: aggregierender Hub + zwei Leaf-Hubs, read-only**

```yaml
services:
  hub-dev:
    image: ghcr.io/popoboxxo/bluepencil:0.10.0
    command: ["--store", "/data/dev.json", "--app", "my-web-tool",
              "--environment", "dev", "--name", "dev-web", "--auth-secret", "${DEV_SECRET}"]
    volumes: ["dev-data:/data"]
    ports: ["8787:8787"]

  hub-staging:
    image: ghcr.io/popoboxxo/bluepencil:0.10.0
    command: ["--store", "/data/staging.json", "--app", "my-web-tool",
              "--environment", "staging", "--name", "staging-web", "--auth-secret", "${STAGING_SECRET}"]
    volumes: ["staging-data:/data"]

  hub-aggregator:
    image: ghcr.io/popoboxxo/bluepencil:0.10.0
    entrypoint: ["bluepencil-hub"]
    command: ["--store", "/data/aggregator.json",
              "--registry", "/etc/bluepencil/federation.json",
              "--no-self", "--read-only", "--allow-insecure"]   # http + private Docker net; link-local/metadata stay blocked
    volumes: ["./federation.json:/etc/bluepencil/federation.json:ro"]
    depends_on: [hub-dev, hub-staging]

volumes:
  dev-data: {}
  staging-data: {}
```
`federation.json` for the aggregator uses `http://hub-dev:8787/api/v1/bluepencil` and
`http://hub-staging:8787/api/v1/bluepencil`; `--allow-insecure` is required because these are
non-loopback `http` targets in a private network. The aggregator's own store is intentionally
empty, so `--no-self` keeps `self` out of the aggregate; `/notes` on the aggregator stays local
(empty) — **only `/mcp` aggregates**. No port is published for `hub-aggregator` in this shape; an
MCP client attaches to `http://hub-aggregator:8787/api/v1/bluepencil/mcp` from inside the private
Docker network (publish `8788:8787` only if a client outside that network must attach). It must
not be exposed outside the private Docker network; link-local (`169.254.0.0/16`, `fe80::/10`) and
metadata targets remain blocked even with the flag. Hubs < 0.10 without `federates` are not
federable (`federates_missing`). The leaf hubs still accept browser writes on their own `/notes`
(the browser never talks to the aggregator).

**The pure federator is not a Compose service.** It is the local stdio process the agent starts;
Compose cannot keep it alive without an attached MCP client. An attached-client example:

```bash
docker run -i --rm --network bluepencil_default \
  -v ./federation.json:/etc/bluepencil/federation.json:ro \
  ghcr.io/popoboxxo/bluepencil:0.10.0 bluepencil-federator \
  --registry /etc/bluepencil/federation.json --read-only --allow-insecure
```

`-i` keeps stdin open; without an attached client the process exits on stdin EOF. A federator-only
process is **not** an HTTP service and has **no `/config`**; `includeSelf` is a documented no-op
there. The image must contain both the `bluepencil-hub` and `bluepencil-federator` bins; PR 8
verifies the Dockerfile/entrypoint (currently hub-only, **zu verifizieren**).
## 10. PR-Reihenfolge, Aufwand, DoD
### PRs

| PR | Inhalt | Abhängig von | Risiko | Test-Gate |
|---|---|---|---|---|
| 1 | **Backend-Fundament:** `src/mcp/backend.ts` inkl. export/import/resources, `createStoreBackend`, `ToolContext.store` → `backend`, `src/mcp/stdio.ts`; kein Föderationscode | — | hoch (MCP-Kern) | T65, bestehende 37 Unit-Suiten |
| 2 | **Registry + IDs + Fehler:** `src/federation/{registry,ids,errors}.ts` inkl. Redactor, Host-/SSRF-Policy (`--allow-insecure`: HTTP + private, Link-Local/Metadata immer blockiert) | PR 1 | niedrig–mittel | T01–T13, T34, T41, T62, T79, T80, T85, T86, T91, T92 |
| 3 | **Client + Aggregat:** `client.ts` (redirect manual, DNS-Check, mcpCall), `aggregate.ts` (ReadSource) | PR 2 | mittel (Timeout/HTTP) | T14–T20, T24, T25, T66–T68, T74, T78, T87 |
| 4 | **Federation-Backend + Tools:** `federation/backend.ts`, `list_instances`, `instance`-Parameter, export/import, Self-Regeln, zwei Write-Schlösser (`--allow-write`) | PR 3 | hoch (Tool-Semantik) | T23, T38–T39, T40, T50–T52, T58–T61, T69, T71, T75, T77, T83–T84, T88–T89, T93–T94 |
| 5 | **Hub:** `server/hub.ts`-Extraktion, `--app`, `--allow-write`, `--allow-insecure`, `/config` `app`/`federates`, `/mcp`-Backendwahl; `/notes` unverändert | PR 4 | hoch (Hub-Verhalten) | T21, T22, T26, T29, T53–T57, T76, T82 |
| 6 | **Federator + CLI:** `server/federator.ts`, `dist/federator.js`, `bluepencil-federator`, `instances`, `federates_missing`-Startfehler, Startup-Degraded | PR 5 | mittel–hoch | T27, T28, T30, T32, T42–T49, T70, T72, T73, T90 |
| 7 | **Doku:** README, MCP/FEDERATION, HERMES/ARCHITECTURE/INTEGRATION/DOCKER/RELEASING/BUILD-SYNC, CI, SVG, fünf Shapes | PR 6 | niedrig | T31, T63, T64; Link-/SVG-Review |
| 8 | **Härtung + Release:** Security-Suite, Redaction, Docker-Compose, Version 0.10.0, CHANGELOG, `verify`-Kette | PR 7 | mittel | T33 (bedingt), T35–T37, T81; `secret-scan`, `verify` |

**Federator-only ist kein HTTP-Dienst und hat kein `/config`; `includeSelf` ist dort ein No-op.**

### Aufwand (Referenz: `effort-estimator`, Textverweis — keine eigene Schätzung)
| PR | PT |
|---|---:|
| 1 Backend-Fundament | 2,0 |
| 2 Registry/IDs/Fehler | 2,0 |
| 3 Client/Aggregat | 1,0 |
| 4 Federation-Backend/Tools | 1,5 |
| 5 Hub | 1,5 |
| 6 Federator/CLI | 1,0 |
| 7 Doku | 0,5 |
| 8 Härtung/Release | 1,5 |
| **Summe** | **11,0** |

**Schätzunsicherheit: +1,5 PT** (Referenzrahmen des Auftrags: ~11 PT; Erhöhung nur nach
Freigabe, keine eigenmächtige Gesamtsumme).

### Rollback

Die 0.10.0-Änderungen sind **additiv**: keine Schema- oder Store-Format-Änderung, die Registry
ist optional, der Federator ist ein separater Bin, und die neuen MCP-Felder/Tools sind
rückwärtskompatibel. Ein Rollback nimmt die 0.10.0-Bins/Doku/Version zurück (Extension-Manifest
zurückbumpen), lässt die Registry-Datei liegen (0.9 ignoriert sie) und lässt alle
`*.bluepencil.json`-Stores unverändert. Es gibt keine Migration und keinen Datenverlust-Pfad.
Dieser Plan ist **kein** `plan-driven`-Input: `pipeline_stages` bleibt bewusst leer, weil die
Stage-IDs der `feature-lifecycle`-Pipeline nicht Teil dieses Auftrags sind. Eine Übergabe an die
Pipeline erfolgt nur durch den Orchestrator/User, nicht automatisch.

### DoD-Checkliste

- [ ] `npm run typecheck` und `npm run typecheck:ext` grün.
- [ ] `npm run test` grün; alle T01–T94 vorhanden und mindestens einmal ausgeführt.
- [ ] `npm run build`, `npm run build:ext`, `npm run verify:sync`, `npm run size` grün.
- [ ] `npm run secret-scan` grün; keine literalen Credentials in Registry/Doku/Beispielen.
- [ ] `npm run spec:check` grün (in dieser Umgebung nur wegen fehlendem `reqmd` offen); `spec/` ist aus der um `FR-6.15`, `FR-16.10`–`FR-16.15`, `NFR-22` ergänzten `docs/REQUIREMENTS.md` mit `npm run spec` regeneriert.
- [ ] `docs/MCP.md`, `docs/FEDERATION.md`, `docs/RELEASING.md`, `docs/BUILD-SYNC.md` und CI-Workflows aktualisiert; SVG valide.
- [ ] Version 0.10.0 in `package.json` und `extension/manifest.json`; CHANGELOG-Eintrag.
- [ ] `/notes` unverändert single-env (T22, T54); `/mcp` ohne Registry unverändert (T26, T56).
- [ ] Kein neues Browser-Attribut (T63); Extension-Schema unverändert (T64).
- [ ] Threat-Model-Maßnahmen umgesetzt: Redirect-Manual (T78), Registry-0600 (T79), SSRF-Policy (T80), Blast-Radius (T81), `--allow-insecure`-Grenzen (T91, T92).
- [ ] `federates`-Pflicht: fehlendes Feld → Startfehler `federates_missing`, kein `unverified` (T90); `unverified` nur bei fehlendem `app` (T49).
- [ ] Zwei Write-Schlösser: `mode:"write"` **und** `--allow-write`; ohne `--allow-write` auch `self` read-only (T93, T94); `--read-only` stärker.
- [ ] Export/Import über `/mcp` (T71); `allow_env_mismatch` abgelehnt (T84); self-Regeln (T75–T77).
- [ ] Fünf Deployment-Shapes einmal manuell/CI durchgespielt (a–e); T33 als bedingter Gate dokumentiert.
- [ ] Rollback-Pfad in `docs/FEDERATION.md` dokumentiert; keine Schema-/Store-Format-Änderung.
- [ ] Konventionen: Conventional Commits, max. 72 Zeichen, Englisch; keine Regression.
- [ ] Kein Auto-Hand-off an `feature-lifecycle`; Plan wird bewusst übergeben.
## 11. Risiken und Gegenmaßnahmen

| # | Risiko | Eintritt | Impact | Mitigation | Frühindikator |
|---|---|---|---|---|---|
| R1 | Backend-Refactor bricht Single-Store-Parität | hoch | hoch | PR 1 ohne Verhaltensänderung; T65/T56 als Golden-Tests; bestehende Suiten vor Föderationscode | `mcp-tools`/`server-mcp` rot ohne neue Tests |
| R2 | `/mcp`-Aggregat wird als Bruch von FR-16.9 gelesen | mittel | hoch | Garantie pro Instanz explizit in §4/§9; T26/T55/T56; REQUIREMENTS-Klarstellung als offener Punkt | Review-Finding „two doors“; widersprüchliche Doku |
| R3 | Env-Isolation wird durch Aggregat/Writes verletzt | niedrig | hoch | kein Env-Rewrite, kein `--allow-env-mismatch`-Forward, keine Dedupe; T39/T41/T54 | Note mit falscher Env im Aggregat; Write in fremde Env |
| R4 | Secret-Leak über Registry/Logs/Tools | mittel | hoch | nur `{env}`, `Redactor`, `list_instances` ohne `base`/`auth`, Secret-Scan; T34–T37/T62 | Token im Log/Tool-Output; Secret-Scan rot |
| R5 | Aggregat liest zu viele Notes (kein `/notes`-Limit) | hoch | mittel | `limit`/`truncated`, Timeout, Doku; später `/notes` limit/offset | Latenz > Timeout; `truncated` dauerhaft true |
| R6 | Teilausfall wirkt wie „keine Notes“ | mittel | hoch | `partial`/`errors`, `isError` bei Totalausfall, Health-Exit 5; T17/T28/T68 | Agent sieht 0 Notes trotz laufender Hubs |
| R7 | Registry driftet / Einträge veralten | hoch | mittel | `instances health`, Identitätscheck beim Start, `federates_missing`; T30/T43/T48/T49/T90 | Health-Exit 5; `federates_missing`/`unverified`-Häufung |
| R8 | Verschachtelung/Selbstreferenz erzeugt Loops | niedrig | hoch | `federates:false`-Zwang, `self`-Reservierung, Startfehler; T46/T47 | Doppelte Notes im Aggregat; Startloop |
| R9 | ID-Kollision oder `/` in Note-ID | niedrig | mittel | qualifizierte IDs, `invalid_id`, doppelte Instanz-IDs verboten; T01–T04/T40 | `invalid_id`-Einträge; doppelte Anzeige |
| R10 | Browser-Nutzer erwarten Föderation | mittel | mittel | Matrix §5, kein `instance`-Attribut, README/FEDERATION; T63/T31 | Issue „why don’t I see staging?“ |
| R11 | `--allow-insecure` wird zu weit geöffnet | mittel | mittel | Default aus + Warnung im Log; ein Flag für HTTP **und** private IPs; Link-Local/Metadata bleiben **immer** blockiert; Docker nur privates Netz; T41/T80/T91/T92 | Registry mit öffentlichem `http://` oder Link-Local-Ziel |
| R12 | Docker-Image enthält Federator-Bin nicht | mittel | mittel | PR 8 prüft Dockerfile/Entrypoint; Compose-Smoke T33 (bedingt) | `exec: bluepencil-federator: not found` |
| R13 | Redirect leitet Custom-Auth-Header auf fremden Host | mittel | hoch | `redirect:"manual"`, 3xx = `invalid_response`; T78 | 3xx in Client-Logs; fremder Host im Request |
| R14 | Registry-Tampering/SSRF auf Metadata | mittel | hoch | 0600/Eigentümer, Host-Allowlist, Link-Local-Block; T79/T80 | fremder Eigentümer; `169.254.*` in Registry |
| R15 | Export/Import über `/mcp` bricht bei Backend ohne Door | mittel | mittel | Dokumentierte Voraussetzung; `GET /bundle` bleibt lesbar; T71 | Import-Fehler bei reinem `/notes`-Backend |
| R16 | Degradierter Start wird als „alle Instanzen ok“ missverstanden | mittel | mittel | `ok:false`/`partial`/Health 5; T72 | Agent ignoriert `partial` |
| R17 | Alt-Hubs < 0.10 sind nicht föderierbar | mittel | mittel | harte `federates`-Pflicht (`federates_missing`), klare Fehlermeldung, Upgrade-Hinweis in `docs/FEDERATION.md`; T90 | Startfehler beim ersten Rollout; gemischte Flotte |
| R18 | **DNS-Check-to-Connect-Restrisiko (TOCTOU/Rebinding):** zwischen der Pre-Flight-Auflösung in `checkBaseUrl` und der eigenen DNS-Auflösung des `fetch` kann sich die Antwort ändern; ein Angreifer mit kontrolliertem DNS kann nach dem Check auf Link-Local/Metadata umbiegen | niedrig–mittel (kontrolliertes DNS + kurze TTL nötig) | hoch (SSRF/Metadata, falls der Check umgangen wird) | Der Code **pinnt die aufgelöste IP in v1 nicht** (`checkBaseUrl` prüft, `fetch` verbindet erneut); das ist ein **dokumentiertes Restrisiko**, keine stille Mitigation. Begrenzend wirken: Check vor **jedem** Request, `redirect:"manual"`, `allowedHosts`-Allowlist, Link-Local/Metadata-Block literal und aufgelöst. Für ein späteres Release: gepinnter Dispatcher/Agent (Verbindung auf die geprüfte IP), strikte Allowlist, optional Proxy mit eigener Auflösung | DNS-Antwort wechselt zwischen Check und Verbindung; Registry-Hosts ohne Allowlist; ungewöhnliche TTLs |
## 12. Review-Ergebnis

**Durchlauf 1** (`RVW-01…RVW-21`): Verdict `CHANGES_REQUESTED` (1 blocker, 10 major,
10 minor) → in Rev. 2 eingearbeitet, 19 akzeptiert, RVW-15/17 teilweise.
**Durchlauf 2** (`RVW2-01…RVW2-19`): Verdict `CHANGES_REQUESTED` (0 blocker, 6 major,
13 minor) → in Rev. 3 eingearbeitet, 18 akzeptiert, RVW2-08 teilweise.
**Keine der 14 bestehenden fixen Entscheidungen wurde umgedeutet; kein Finding wurde abgelehnt.**
Entscheidung 15 ist in Rev. 4 neu; die Entscheidungen 7 und 10 wurden auf Nutzerentscheidung
präzisiert. Die Review-Datei bleibt als Historie vollständig erhalten (beide Durchläufe).

### Nutzerentscheidungen Rev. 4

Die folgenden drei Punkte wurden vom Nutzer entschieden (nicht vom Plan-Autor) und ersetzen jede
vorherige Vorläufig-Markierung. Es gibt zu ihnen keine offenen Fragen mehr.

| # | Entscheidung | Konsequenz im Plan |
|---|---|---|
| 1 | **Alt-Hubs ohne `federates`:** immer Startfehler, kein `unverified`-Start | Neuer Fehlercode `federates_missing`; jede registrierte Instanz muss `federates` in `GET /config` melden; Kinder < 0.10 sind nicht föderierbar; `unverified` bleibt ausschließlich für fehlendes `app` (Entscheidung 9). §2 (10), §3 (FR-6.15), §4, §6 (Startsequenz), §7 (Fehlertabelle), §8 (T90), §9, §11 (R7/R17). |
| 2 | **`--allow-insecure`:** ein einziges Flag erlaubt HTTP **und** private IPs (RFC1918/ULA) für Docker/Lab; Link-Local/Metadata bleiben immer blockiert | Ersetzt `--allow-plain-http`/`--allow-private-network`; Default aus mit Warnung; DNS wird vor dem Request aufgelöst; `redirect:"manual"` bleibt. §2 (15), §3 (FR-16.10), §4, §5, §6 (Optionen/Client), §7, §8 (T41/T80/T91/T92), §9, §11 (R11). |
| 3 | **Write-Opt-in mit zwei Schlössern:** Registry-`mode:"write"` ist nur die Obergrenze; zusätzlich `--allow-write` in der Föderations-Session | Ohne `--allow-write` sind alle föderierten Writes (auch `self`) read-only; `--read-only` bleibt stärker; Hub-`/notes` unverändert; FR-16.2 bleibt wörtlich erfüllt. §2 (7), §3 (FR-16.13/16.14), §4, §5, §6, §7, §8 (T50/T51/T93/T94), §9, §10. |

### Durchlauf 1 — RVW-01…RVW-21

| ID | Severity | Status | Umgesetzt in |
|---|---|---|---|
| RVW-01 | blocker | accepted | §4, §6, §7, §8 — Export/Import über die `/mcp`-Door; `McpBackend.exportBundle/importBundle`; T71 |
| RVW-02 | major | accepted | §3, §4 — FR-16.3 pro Instanz; Aggregat als benannte Ausnahme; `environment?`-Guard; FR-16.2-Klärungsbedarf |
| RVW-03 | major | accepted | §2, §6, §7, §8 — `self` formatierbar/parsebar; `all`/`*` nur Selektoren; T03/T04 |
| RVW-04 | major | accepted | §2, §6, §7, §8 — Self-Schreibbarkeit; `--no-self` → `self_unavailable`; T75–T77 |
| RVW-05 | major | accepted | §4, §6, §8 — `redirect:"manual"`, 3xx = `invalid_response`; T78 |
| RVW-06 | major | accepted | §4 — Threat Model (4 Fragen), Registry-Tampering, SSRF/Blast-Radius; T79–T81 |
| RVW-07 | major | accepted | §4, §6, §7, §8 — fail-fast vs. degraded start; T72 |
| RVW-08 | major | accepted | §5, §6, §8, §9 — `--app`/`BLUEPENCIL_APP`; T82 |
| RVW-09 | major | accepted | §6, §7, §8 — qualifizierte Write-Antwort + Provenance; T83 |
| RVW-10 | major | accepted | §6, §8 — `ReadSource`, `aggregateList(sources, self, …)`; T74 |
| RVW-11 | major | accepted | §4, §6, §7, §8 — keine Resources im Federator; T73 |
| RVW-12 | minor | accepted | §6, §8 — `InstanceStatus.mode/includeSelf`; T60 |
| RVW-13 | minor | accepted | §6, §7, §8 — kanonische Exit-Tabelle; T70 |
| RVW-14 | minor | accepted | §8, §10 — Traceability, PR-Zuordnung, T33 bedingt, Negativtests |
| RVW-15 | minor | accepted (Rev. 3) | §3-Fußnote, §8, §12 — IDs normalisiert auf `FR-6.15`/`NFR-22` |
| RVW-16 | minor | accepted | §2, §6, §9 — beide offenen Punkte als **VORLÄUFIG** markiert |
| RVW-17 | minor | partial | §10 — Rollback ergänzt; PR 1 = 2,0 PT, PR 8 = 1,5 PT; Summe bewusst 11,0 PT |
| RVW-18 | minor | accepted | §4, §6, §7, §8 — `allow_env_mismatch` → `invalid_argument`; T84 |
| RVW-19 | minor | accepted | §6, §8 — `Redactor`-Klasse; T62 |
| RVW-20 | minor | accepted | §5, §9 — RELEASING/CI/BUILD-SYNC; `--allow-plain-http`; Shape (d) |
| RVW-21 | minor | accepted | §6, §7, §8 — `Session.ref` qualifiziert, `note.sessionRef` nicht; T88 |

### Durchlauf 2 — RVW2-01…RVW2-19

| ID | Severity | Status | Umgesetzt in |
|---|---|---|---|
| RVW2-01 | major | accepted | Kopf, Änderungslog, §12 — Rev.-3-Aussage korrigiert; beide Durchläufe dokumentiert |
| RVW2-02 | major | accepted | §3 (Testspalten), §8 (Matrix) — Testspalten aus der Matrix abgeleitet; 30 Abweichungen beseitigt |
| RVW2-03 | major | accepted | §8 (PR-Spalte), §10 (Gates) — Matrix ist Single Source; T40/T70 ergänzt, T34/T56/T44/T31 eindeutig |
| RVW2-04 | major | accepted | §6 `FederationErrorCode`, §7 Tabelle — `environment_mismatch` + `usage` ergänzt |
| RVW2-05 | major | accepted | §6 `SelfSource`, §7, T71 — Export/Import `self` lokal definiert |
| RVW2-06 | major | accepted | §5 Zeile 8, §6 `HubOptions` — `allowPlainHttp` im Hub ergänzt (VORLÄUFIG) |
| RVW2-07 | minor | accepted | §4, §6, §7 — eine kanonische Self-Formel inkl. `self.readOnly` |
| RVW2-08 | minor | partial | §6 `loadRegistry`, T79 — Mode-Bits/Allowlist real, Eigentümer-Check best-effort über injiziertes `fs.stat` |
| RVW2-09 | minor | accepted | §4, §6, T80 — DNS-Rebinding + Entkopplung `allowPlainHttp`/`allowPrivateNetwork` |
| RVW2-10 | minor | accepted | §6 `HubOptions`/`FederatorOptions`, Offene Punkte 13, §12 — `allowPrivateNetwork` als offener Punkt |
| RVW2-11 | minor | accepted | §6 Backend/Tools, §7, T59 — `bulk_remove` ohne Instanz → `instance_required` |
| RVW2-12 | minor | accepted | §6 `McpBackend.get(id, instance?)`, Tools-Tabelle — Prüfung im Backend |
| RVW2-13 | minor | accepted | §6 Registry-Defaults, §7, T69 — `includeSelf` im reinen Federator = No-op |
| RVW2-14 | minor | accepted | §8 Matrix-PR, §10 Gates — T74 → PR 3, T76 → PR 5, T75 → PR 4 |
| RVW2-15 | minor | accepted | T71 — konkrete Assertions (ein `tools/call`, kein POST bei `mode_denied`) |
| RVW2-16 | minor | accepted | §3 — neue Zeile „FR-16.5 (Bestand, Einschränkung)“ mit T73 |
| RVW2-17 | minor | accepted | §8 Matrix, §3 — je Test genau ein primäres Requirement |
| RVW2-18 | minor | accepted | §8 Test-Gates — T35–T41 ab PR 3; T34 gehört zu PR 2 |
| RVW2-19 | minor | accepted | §6 `toMcpError`/`toExitCode`/`InstanceClientOptions`, T16 — `Redactor` verdrahtet |

### Nicht umgesetzt / Einschränkungen

| ID | Entscheidung | Begründung |
|---|---|---|
| RVW-17 | **partial** | Rollback und PR-1/PR-8-Anpassung umgesetzt; die Gesamtsumme bleibt bei 11,0 PT, weil eine Erhöhung nicht vom Auftrag gedeckt ist. |
| RVW2-08 | **partial** | Der Eigentümer-Check ist ohne `root` nicht real testbar; T79 prüft Mode-Bits/Allowlist real und den Ownership-Pfad über injiziertes `fs.stat`. Kein stilles Versprechen mehr. |

### Offene Punkte

**(a) ID-Normalisierung — erledigt.** Kanonisch sind `FR-6.15` und `NFR-22`; die früheren
Auftrags-IDs waren bereits vergeben (Extension-Hub-Discovery bzw. Build-Parity, siehe Fußnote in
§3). Der Requirements-Schritt ist ausgeführt: `docs/REQUIREMENTS.md` enthält `FR-6.15`,
`FR-16.10`–`FR-16.15` und `NFR-22`; `spec/` wurde mit `npm run spec` regeneriert. In dieser
Umgebung ist `npm run spec:check` nur wegen fehlendem `reqmd` nicht ausführbar.

**(b) `federates`-fehlend — entschieden (Rev. 4).** Fehlendes `federates` ist immer ein
Startfehler (`federates_missing`); `unverified` gilt ausschließlich für fehlendes `app`. Siehe
Entscheidung 10, §6, §8 (T90), Offene Punkte 5.

**(c) `--allow-insecure` — entschieden (Rev. 4).** Ein Flag erlaubt HTTP **und** private IPs
(RFC1918/ULA); Link-Local/Metadata bleiben immer blockiert; Default aus mit Warnung. Es ersetzt
`--allow-plain-http`/`--allow-private-network`. Siehe Entscheidung 15, §4/§6, §8 (T91/T92),
Offene Punkte 13.

**(d) FR-16.2 — entschieden (Rev. 4).** Zwei Schlösser: `mode:"write"` **und** `--allow-write`;
ohne `--allow-write` sind alle föderierten Writes (auch `self`) read-only. FR-16.2 bleibt damit
wörtlich unverändert; die Datei wurde nur um die neuen IDs ergänzt.

**(e) Branch.** Aktueller Branch ist `feat/capture-modes-feature-priority-version`, nicht
`feat/federation`. Keine Aktion ausgeführt; Empfehlung: `feat/federation` von `main` schneiden,
**bevor PR 1 beginnt**.
## Offene Punkte & Empfehlungen (nicht vom Auftrag entschieden)

1. **`limit`-Default:** vorläufig 200, max 1000; ein anderer Default ändert nur die Konstante und T19/T87.
2. **Timeout-Default:** vorläufig 3000 ms pro Instanz; bei langsamen Hubs ggf. 5000 ms (T15/T87).
3. **Registry-Reload:** v1 nur beim Start; kein Hot-Reload/SIGHUP. `instances health` liest die Datei neu.
4. **ID-Escaping:** v1 kein Escaping; `/` in einer Note-ID ist `invalid_id`. Ein späteres Schema (z. B. `~1`) wäre eine eigene Anforderung.
5. **Hubs < 0.10 — entschieden (Rev. 4):** fehlendes `app` → `unverified`-Warnung; fehlendes `federates` → Startfehler `federates_missing` (T49, T90); Hubs ohne `federates` sind nicht föderierbar.
6. **`/mcp`-Aggregat vs. FR-16.9:** Plan scoped die Garantie auf „pro Instanz“. Alternative: separater Pfad `/federation/mcp`, der `/mcp` strikt single-store lässt — dann wäre FR-16.9 wörtlich unverändert, aber der Agentenvertrag komplexer.
7. **ID-Normalisierung — erledigt:** kanonisch ist **FR-6.15** (frühere Auftrags-ID war bereits vergeben, Extension-Hub-Discovery); in `REQUIREMENTS.md` aufgenommen, `spec/` regeneriert.
8. **ID-Normalisierung — erledigt:** kanonisch ist **NFR-22** (frühere Auftrags-ID war bereits vergeben, Build-Parity); in `REQUIREMENTS.md` aufgenommen, `spec/` regeneriert.
9. **Doku-Drift `GET /export` vs. `/bundle`:** `ARCHITECTURE.md` §5 nennt `/export`, der Hub liefert `/bundle`; im Doku-PR korrigieren.
10. **README/Extension `prod` vs. `live`:** Extension migriert `prod`→`live`; Beispiele im Doku-PR auf `live` normalisieren.
11. **Unqualifiziertes `get_note`:** kombinierter Hub → `self`; reiner Federator → `instance_required`. Alternative: „in allen Instanzen suchen“ (Kollisionsrisiko) — v1 bewusst nicht.
12. **`self_reference`-Erkennung:** bei Wildcard-Bind (`0.0.0.0`) ist die eigene öffentliche Base nicht sicher bekannt; v1 erkennt `id:"self"` und Loopback-Aliase, sonst Dokumentation/Warnung.
13. **`--allow-insecure` — entschieden (Rev. 4):** ein Flag für HTTP **und** private IPs (RFC1918/ULA), Default aus mit Warnung; Link-Local/Metadata immer blockiert (T41/T80/T91/T92); ersetzt die früheren Einzel-Flags.
14. **`instances health` Exit 5:** neuer Code; Alternative wäre Wiederverwendung von 4. 5 trennt „Registry kaputt“ von „Instanz kaputt“.
15. **Aggregat-Export:** `export_bundle` ohne `instance` wird verweigert (kein Mixed-Env-Bundle). Ob ein separater „federation report“-Export sinnvoll ist, ist nicht entschieden.
16. **Extension-Multi-Profil:** v1 bewusst ein Profil; zwei Hubs nur über zwei Browser-Profile oder den Federator. Kein Umbau in 0.10.0.
17. **MCP-Resources im Federator:** v1 bewusst keine (FR-16.5-Einschränkung); ein aggregiertes `bluepencil://bundle` wäre ein Mixed-Env-Bundle und ist daher ausgeschlossen.
18. **FR-16.2-Opt-in — entschieden (Rev. 4):** zwei Schlösser, `mode:"write"` **und** `--allow-write`; ohne `--allow-write` sind alle föderierten Writes (auch `self`) read-only (T93/T94).
19. **Export/Import-Transport:** `/mcp` der Ziel-Hubs ist gewählt; ein Backend ohne `/mcp` kann nicht importieren/exportieren, muss aber für reine Aggregat-Reads weiterhin `/notes`/`/config` liefern.
20. **Branch:** aktuell `feat/capture-modes-feature-priority-version`; `feat/federation` von `main` schneiden, bevor PR 1 beginnt (keine Aktion in diesem Auftrag).


