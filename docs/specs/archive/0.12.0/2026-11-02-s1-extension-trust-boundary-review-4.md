# Viert-Review — S1 Extension Trust Boundary 0.12.0

> **Reviewt:** `docs/specs/2026-11-02-s1-extension-trust-boundary.md` (724 Zeilen, 7 Contracts, 74 ACs, `Status: Entwurf`)
> **Verbindlich geprüft gegen:** `docs/specs/2026-11-02-origin-note-context-design.md` (§1/§3.2/§5/§6/§8/§9/§10/§11, Revisionen 2026-11-02), `docs/plans/audit-remediation-decisions.md` (G4=A, G5=B korr., G6=A, G8=A, G9=A, G13=A; RVW-01/14/15/16)
> **Vorherige Reviews:** `…-review.md` (RVW-01…RVW-26), `…-review-2.md` (RVW2-01…RVW2-20), `…-review-3.md` (RVW3-01…RVW3-14)
> **Rolle:** concept-reviewer, Pre-Implementation-Gate (Delta-Review, vierter Pass)
> **Datum:** 2026-11-02
> **Verdict:** **CHANGES_REQUESTED**
> **Befunde:** 0 Blocker, 2 Major, 6 Minor, 3 Info
> **Closure RVW3:** 9 vollständig geschlossen, **2 teilweise** (RVW3-01, RVW3-06), 0 offen; Info RVW3-12/14 geschlossen, RVW3-13 akzeptiert

## 1. Scope und Methode

Geprüft wurde ausschließlich das Delta der vierten Fassung: die Schließung von RVW3-01…RVW3-11, die neue Test-Grant-Mechanik (`extension/test-manifest.mjs`, `extension/dist-test`, AC-69, RC-1…RC-3), Eigentum/Merge-Reihenfolge nach der Änderung, die Review-Page-Importfläche, die Typ-/Deklarationskonsistenz, die Sicherheitseigenschaften, die Genauigkeit des Abgleichs und die Constraints. Bereits geschlossene Befunde wurden nicht neu geöffnet, außer wo die Revision sie berührt.

Gegen den Code read-only verifiziert wurden: `extension/{smoke.mjs,build.mjs,manifest.json,tsconfig.json}`, `scripts/{build.mjs,webstore-compliance.mjs,release-preflight.mjs,size-guard.mjs}`, `.github/workflows/{ci,release,extension}.yml`, `.gitignore`, `.dockerignore`, `package.json`, `src/{data/index.ts,data/schema.ts,core/adapter.ts,adapters/chrome-storage.ts}`, `extension/src/{sw.ts,bootstrap.ts,options.ts,bluepencil-element.d.ts}`, `tests/e2e/{parity,round-trip}.e2e.mjs` sowie Design und Entscheidungsprotokoll.

Keine instruktionsartigen Fremdinhalte und keine Prompt-Injection-Muster in den gelesenen Dokumenten gefunden.

## 2. Befunde

| RVW4 | Severity | Sektion/AC | Befund | Erforderliche Korrektur |
|---|---|---|---|---|
| RVW4-01 | **major** | §2 C5 Test-Strategie Punkt 4, §6 E2E, AC-69; `tests/e2e/{parity,round-trip}.e2e.mjs`, `.github/workflows/ci.yml` | Das Test-Grant-Manifest ist nur für `smoke:ext` verdrahtet. `smoke:parity` und `smoke:round-trip` laden weiterhin `extension/dist` (`parity.e2e.mjs:43,141-152`; `round-trip.e2e.mjs:54,382-393`) und rufen `self.__bluepencilModule.mountOnTab` **ohne Geste** auf (`parity.e2e.mjs:190-207`; `round-trip.e2e.mjs:426-443`). Nach dem Entfernen von `host_permissions` scheitern beide mit „Extension manifest must request permission to access this host“ — genau der Fall, den der Smoke-Kommentar (`smoke.mjs:284-286`) beschreibt. `parity` baut zudem vor dem Laden selbst `extension/build.mjs` neu (`parity.e2e.mjs:246`) und lädt danach `extension/dist`; ein Test-Grant-Build müsste dort ebenfalls erzeugt und geladen werden. Beide Läufe sind required CI (`smoke:round-trip` im Test-Job, `ci.yml:242-248`; `parity`-Job, `ci.yml:253-280`). Die Dateien stehen in keinem Eigentümerset (§7). Damit ist RVW3-01 systematisch nur für eine von drei mountenden E2E-Suiten geschlossen. | `test-manifest.mjs` (oder einen gemeinsamen Test-Grant-Build) für **alle drei** Suiten nutzen, `tests/e2e/{parity,round-trip}.e2e.mjs` und die zugehörigen CI-Schritte einem Contract (C5) zuordnen, AC-69/§6 um beide Suiten erweitern und je eine Assertion ergänzen, dass sie gegen `dist-test` laufen. Alternativ AC-36/37/38 ausdrücklich auf Seams begrenzen und die beiden Suiten aus dem G9-Gate nehmen — dann sichtbar, nicht still. |
| RVW4-02 | **major** | §2 C5 Punkt 5, §7 Merge-Reihenfolge `C5 → C6 → C4b`, `extension/src/sw.ts:110-135` | C5 entfernt `host_permissions`, aber `sw.ts` ruft bis C4b `ensureBootstrapRegistered()` → `chrome.scripting.registerContentScripts([... http/https ...])` auf. Ohne Host-Permission wird dieser Aufruf abgelehnt; `mountOnTab` wirft, bevor injiziert wird (Toolbar-Pfad `.catch` schluckt, Command-Pfad bleibt unbehandelt). Der `dist-test`-Grant verdeckt den Bruch für `smoke:ext`; AC-69 prüft nur das Manifest, nicht die Funktionsfähigkeit der Produktions-Extension. Die Spec behauptet zugleich „kein Contract wartet auf einen späteren“ und „jeder Commit grün“. | Manifest-/Host-Permission-Entfernung und Guard-Invertierung in denselben Commit wie die Löschung von `ensureBootstrapRegistered` legen (C4b) **oder** die Registrierung bereits in C5 entfernen. Eine Ordering-AC ergänzen: „solange das gebaute `sw.js` `registerContentScripts` enthält, darf `manifest.json` `host_permissions` nicht fehlen.“ Optional ein Smoke gegen `dist` ohne Grant, der einen benannten Fehler statt eines Wurfs zeigt. |
| RVW4-03 | minor | AC-69, §2 C5 Punkt 4, `.gitignore`, `.dockerignore` | `extension/dist-test` ist ein generiertes Verzeichnis mit einem `host_permissions`-Manifest, aber weder in `.gitignore` (nur `extension/dist/`, Zeile 47) noch in `.dockerignore` (nur `extension/dist`, Zeile 10) ausgeschlossen. Es kann versehentlich committet oder in einen künftigen Docker-/Pack-Pfad aufgenommen werden. AC-69s „nicht im npm-Paket“ ist über die `files`-Allowlist strukturell wahr, aber nicht getestet. Zudem fehlt ein Cleanup vor dem Kopieren (stale Dateien in `dist-test`). | C5: `extension/dist-test/` in `.gitignore` und `.dockerignore` aufnehmen; `test-manifest.mjs` löscht `dist-test` vor dem Kopieren; AC-69 um eine konkrete Assertion ergänzen (`package.json.files` enthält kein `extension/` oder `npm pack --dry-run`). |
| RVW4-04 | minor | §6 E2E, §7 C5, AC-59/AC-69; `extension/smoke.mjs` | `extension/smoke.mjs` gehört C5, aber die in §6 E2E genannten Fälle für **C3** (Review-Seite listet A/B/Legacy, Page-Overlay zeigt Legacy nicht, Assign/Undo) können erst in C3 geschrieben werden — C3 landet **nach** C4b und besitzt die Datei nicht. Das ist die Residualstelle von RVW3-06: der Guard-Zeitpunkt ist behoben, der Datei-Eigentumskonflikt nicht. | `smoke.mjs` in getrennte Suiten/Abschnitte teilen (z. B. `smoke.mjs` für C5, `smoke-review.mjs` für C3) oder C3 ausdrücklich einen benannten Abschnitt/eine Datei zuweisen; §6 E2E je Contract zuordnen. |
| RVW4-05 | minor | §2 C3 `review.ts`, `review-data.d.ts`, AC-72 | `OriginNoteView.note: Note` und `OriginGroup.origin: NoteOrigin` brauchen die Typen `Note`/`NoteOrigin`. `src/data/index.ts` re-exportiert sie nicht (`schema.ts:25` importiert nur `type Note`), und `review-data.d.ts` (`export * from "../../src/data/index"`) liefert sie daher nicht. Die Spec nennt keine Typquelle; `review.ts` müsste direkt `../../src/core/model` importieren (Typ-only, aber außerhalb der deklarierten Importfläche). | Entweder `src/data/index.ts` um `export type { Note, NoteOrigin } from "../core/model"` erweitern (C3) oder in `review.ts` den Typ-Import explizit festhalten; AC-72 um die Typfläche ergänzen. |
| RVW4-06 | minor | §2 C5 Punkt 2, AC-70, `docs/EXTENSION.md` | RC-1…RC-3 sind benannt und AC-70 prüft ihre Texte, aber kein Release-Workflow/Checklistenschritt verlangt ihre Ausführung. Damit ist das „Release-Gate“ Dokumentation, nicht Gate; der echte Grant-Pfad bleibt der einzige ungetestete Pfad (§8/8). | RC-1…RC-3 in die Release-Checkliste/`release.yml` (oder das PR-Template) als Pflichtschritt aufnehmen und AC-70 um den Verweis ergänzen; alternativ den Grant-Pfad in einem nächtlichen manuellen Job protokollieren. |
| RVW4-07 | minor | §7 Datei-Eigentum, AC-59 | §7 behauptet „jede Datei genau einen Eigentümer“, aber `CHANGELOG.md` ist C7, `docs/EMBED.md` C4, `docs/EXTENSION.md`/`docs/WEBSTORE.md` C5 — während AC-59 Änderungen aus C1/C2/C4/C5 an genau diesen Dateien verlangt. Kein Code-Konflikt, aber die Aussage ist zu stark und erzeugt Merge-Konflikte zwischen Contracts. | Doku-Änderungen je Contract in eigene Abschnitte trennen oder in §7 eine „geteilte Doku, ein Redaktions-Commit“-Regel mit genauem Eigentümer (C7) ausweisen. |
| RVW4-08 | minor | §2 C5, `docs/WEBSTORE.md`, `scripts/webstore-compliance.mjs:186-200,387-393` | Nach der Invertierung ist `hosts = []`; `checkDashboardCopy` überspringt die Host-Justification, und `optional_host_permissions` hat keinen AC. Der Web-Store-Dashboard-Text muss die optionale Berechtigung und den Grant-Zeitpunkt erklären; C5 besitzt `docs/WEBSTORE.md`, aber keine AC prüft den Text. | AC ergänzen: `docs/WEBSTORE.md` nennt `optional_host_permissions` (`http://*/*`, `https://*/*`) und den Grant-Zeitpunkt; `webstore-compliance.mjs` prüft die optionale Liste statt der entfernten Host-Liste. |
| RVW4-09 | info | §2 C6/C4b, `extension/src/sw.ts:196`, `extension/smoke.mjs:634` | Das Seam `self.__bluepencilModule = { mountOnTab }` wird nicht genannt. Nach dem Verschieben von `mountOnTab` nach `mount.ts` muss `sw.ts` es weiter exportieren, sonst bricht der Smoke (roter Check, also nicht still). | In C4b ausdrücklich festhalten: `sw.ts` re-exportiert `mountOnTab` am bestehenden Seam; AC-37/74 um die Assertion ergänzen. |
| RVW4-10 | info | §2 C4 Permission-Prüfung, AC-33 | AC-33 beobachtet `runHubRequest` mit injizierten `endpoint`/`permissions`; dass `sw.ts` beide tatsächlich injiziert, bleibt unbeobachtet (§8/8 nennt nur den Chrome-Aufruf der Options-Page). Kein Datenleck, aber die Fail-closed-Zusage ist auf der Worker-Verdrahtung nur gelesen. | Entweder AC-33 um eine Quelltext-Assertion in `sw.ts` ergänzen oder das Restrisiko in §8/8 ausdrücklich auf die Worker-Injektion ausdehnen. |
| RVW4-11 | info | §2 C5 `hubOriginPattern` | Das Pattern elidiert den Port (Chrome-Match-Patterns können keinen Port). Für `https://hub.example:9443/api` wird `https://hub.example/*` granted — breiter als der konfigurierte Endpoint. Chrome-Grenze, keine Fehlfunktion, aber die Ausweitung sollte als akzeptiert dokumentiert sein. | Ein Satz in §2 C5/§8: der Grant umfasst alle Ports des Hosts. |

## 3. Abgleich RVW3-01 … RVW3-14

Legende: **geschlossen** = die zitierte Stelle trägt die verlangte Korrektur; **teilweise** = ein Teil fehlt oder die Korrektur ist nur für einen Teil der betroffenen Pfade wirksam.

| RVW3 | Status | Beleg / Anmerkung |
|---|---|---|
| RVW3-01 | **teilweise** | Seam + RC-1…RC-3 + Test-Grant-Manifest + invertierte Guards sind real (§2 C5 Punkte 1–5, AC-69/70, §6 E2E). Aber das Test-Grant gilt nur für `smoke:ext`; `smoke:parity` und `smoke:round-trip` mounten weiterhin `extension/dist` ohne Geste und werden rot (RVW4-01). Damit ist die verlangte „kein roter Check“-Zusage nicht systemweit erfüllt. |
| RVW3-02 | **geschlossen** | §2 C4 „Options-Import“: `options.ts` importiert `configuredCredential` ab C5 aus `./credential`; §7-Merge-Kante C5 vor C4b; AC-73; `typecheck:ext` als Gate pro Commit. `options.ts:10` bestätigt die Ausgangslage. |
| RVW3-03 | **geschlossen** | §2 C2 „Deklaration“: `.d.ts` erhält `onFallback?`/`writeFailure?`; Runtime-Signatur unverändert. `chrome-storage.ts:65-66` hat beide Optionen bereits; `bluepencil-element.d.ts:66-69` ist der Engpass. |
| RVW3-04 | **geschlossen** | §2 C6 `readSettings` zieht nach `mount.ts` (exportiert), `sw.ts` importiert in C4b; Graph `sw → mount → settings`, kein `sw ↔ mount`; AC-74. `sw.ts:73` bestätigt den heutigen privaten Reader. |
| RVW3-05 | **geschlossen** | `src/data/index.ts` ist C3 und re-exportiert `./origin`, `./note-set`, `./legacy-assign`, `../core/origin`; Importfläche der Review-Page benannt; `cloneNote` nur Quell-Import, nicht von `review.ts` genutzt; AC-72. Rest: `Note`/`NoteOrigin`-Typfläche → RVW4-05. |
| RVW3-06 | **teilweise** | Guard-Invertierung ist C5, die `registerContentScripts`-Assertion C4b (RVW3-06-Kern). Aber `smoke.mjs` bleibt C5, während C3 seine E2E-Fälle in dieselbe Datei schreiben müsste (RVW4-04). Der Datei-Eigentumskonflikt aus RVW3-06 ist nicht geteilt/aufgelöst. |
| RVW3-07 | **geschlossen** | §2 C4 „Permission-Prüfung vor dem Request“: `runHubRequest` prüft `hubOriginPattern` → `permissions.contains` → `permissionState` → `permissionRefusal` vor `fetch`; AC-33 verlangt den Schritt zwischen Validierung und `fetch`; `badgeForReport`/AC-57 für den Memory-Status. Rest: Worker-Injektion unbeobachtet → RVW4-10 (info). |
| RVW3-08 | **geschlossen** | Design §1/§6/§10 ziehen SEC-19/G8 nach S2; §6 enthält weder `readRoute` noch `includeQuery`/`url-with-query`; Revisionseintrag vorhanden. |
| RVW3-09 | **geschlossen** | §1.4 NFR-3 und §7 nennen **C1 und C2** im Element-/IIFE-Bundle und die kombinierte Messung mit `npm run size`; keine präventive Erhöhung. |
| RVW3-10 | **geschlossen** | §2 C2 „Default-Key“ + AC-59(g): Default ist per-Origin; Hosts mit gemeinsamem Blob müssen `key: chromeStorageKey()` explizit setzen. |
| RVW3-11 | **geschlossen** | AC-12 (`list_notes` mit `origin`/`null`), AC-55 (`missing_endpoint`/`invalid_origin`), AC-71 (Provenienz ohne Ziel-Datensatz). |
| RVW3-12 | **geschlossen** | AC-05 verlangt, dass C1 beide Fixtures im C1-Commit anlegt. |
| RVW3-13 | **akzeptiert** | 0.11-Hub-Stub-Scope in §5.2/AC-62 bleibt die in Review 2 zugelassene Option. |
| RVW3-14 | **geschlossen** | §7 C1 nennt `matchesFilter`; `src/core/adapter.ts:113` ist die richtige Stelle. |

**Zählung RVW3:** 9 geschlossen, 2 teilweise (RVW3-01, RVW3-06), 0 offen; Info RVW3-12/14 geschlossen, RVW3-13 akzeptiert. Die Spec behauptet 11/0/0.

## 4. Eigentum und Merge-Reihenfolge

### 4.1 Die fünf genannten Dateien

| Datei | Contract | Befund |
|---|---|---|
| `src/data/index.ts` | C3 | genau ein Eigentümer; re-exportiert C1/C2 (früher), wird von C3/Review-Build genutzt. **ok** |
| `extension/smoke.mjs` | C5 | formal ein Eigentümer, aber C3 braucht die Review-/Assign-/Undo-Fälle (RVW4-04). **nicht sauber** |
| `scripts/webstore-compliance.mjs` | C5 | genau ein Eigentümer; Invertierung C5. **ok** |
| `extension/test-manifest.mjs` | C5 | genau ein Eigentümer; neu, nur Build-Test-Artefakt. **ok** |
| `extension/src/bluepencil-element.d.ts` | C2 | genau ein Eigentümer; Deklaration wird um `onFallback`/`writeFailure` erweitert (RVW3-03). **ok** |

Keine Datei steht in zwei Eigentümersets. Aber die Aussage „jede Datei genau einen Eigentümer“ ist für Doku (RVW4-07) und `smoke.mjs` (RVW4-04) zu stark. Die E2E-Dateien `tests/e2e/{parity,round-trip}.e2e.mjs` sind in **keinem** Set; der RVW4-01-Fix braucht sie.

### 4.2 Merge-Kanten

Geprüft: `C1 → C2 → C4a → C7 → C5 → C6 → C4b → C3`.

| Kante | Erwartung | Befund |
|---|---|---|
| C1 → C2 | `data/origin.ts` → `core/origin.ts` | **ok**, azyklisch (`adapters → data → core`). |
| C2 → C7 | Bootstrap importiert `chrome-storage` (C2), `handoff` (C4a) | **ok**. |
| C4a → C5 | `mount-plan.ts` nutzt `PageSettings`; `options.ts` zieht `credential` | **ok** (RVW3-02). |
| C5 → C6 | `mount.ts` nutzt `planMount`/`PageConfig` (C5) und `WorkerReply` (C7) | **ok**. |
| C6 → C4b | `sw.ts` importiert `readSettings` aus `mount.ts`; keine Gegenkante | **ok** (RVW3-04). `mount.ts` importiert nie `sw.ts`. |
| C5 → C4b | `hub-fetch` (C4b) importiert `permissions` (C5) | **ok** für den Import — aber **nicht ok** funktional: C5 entfernt `host_permissions`, während `sw.ts` bis C4b noch `registerContentScripts` aufruft (RVW4-02). |
| C4b → C3 | C3 importiert nur C1/C2; `review.ts` liest `dist/data.js` | **ok**; aber die C3-E2E-Fälle in `smoke.mjs` (C5) sind ein Eigentumskonflikt (RVW4-04). |

**Fazit:** kein Import aus einem späteren Contract, kein `sw ↔ mount`-Zyklus. Die Merge-Reihenfolge ist topologisch für Importe korrekt, aber **funktional** nicht: C5 wartet auf C4b (RVW4-02), und C3 wartet für seine E2E-Fälle auf eine C5-eigene Datei (RVW4-04).

## 5. Neue Mechanik: Test-Grant-Manifest (RVW3-01)

| Prüffrage | Befund |
|---|---|
| Produktionsmanifest bleibt das verpackte | **ja.** `extension/build.mjs` kopiert `extension/manifest.json` nach `extension/dist`; `test-manifest.mjs` schreibt nur `extension/dist-test`. Release (`release.yml:122-123`) und Extension-Workflow (`extension.yml:60`) zippen ausschließlich `extension/dist`. |
| `dist-test` gelangt nicht in `build:ext` | **ja.** `extension/build.mjs` löscht/überschreibt nur `out = extension/dist`; `dist-test` wird nicht gelesen. |
| `dist-test` gelangt nicht in den Web-Store-Upload | **ja.** Beide Zip-Schritte laufen mit `cd extension/dist`. |
| `dist-test` gelangt nicht in das npm-Tarball | **ja, strukturell.** `package.json.files` ist eine Allowlist (`dist`, `docs`, `README.md`, `LICENSE`); `extension/` fehlt vollständig. Die AC-69-Assertion dafür ist aber nicht benannt (RVW4-03). |
| AC-69 prüft Produktionsmanifest ohne `host_permissions` und die reine Differenz | **ja.** AC-69 nennt `dist/manifest.json` ohne `host_permissions`, `optional_host_permissions === ["http://*/*","https://*/*"]` und die Differenz `dist`/`dist-test` nur in `host_permissions`. |
| `smoke.mjs` und `webstore-compliance.mjs` invertiert, nicht nur übersprungen | **ja, geplant.** §2 C5 Punkt 3 verlangt in beiden: `host_permissions` fehlt, `optional_host_permissions` enthält http/https, `<all_urls>` verboten. `webstore-compliance.mjs:186-200` und `smoke.mjs:289-293` sind die heutigen Gegenstellen. |
| Manuelle Checkliste ist ein benanntes, testbares Release-Gate | **teilweise.** RC-1…RC-3 sind benannt und AC-70 textgeprüft; kein Release-Workflow verlangt ihre Ausführung (RVW4-06). |
| Alle mountenden CI-Suiten abgedeckt | **nein.** Nur `smoke:ext`; `smoke:parity` und `smoke:round-trip` bleiben auf `extension/dist` (RVW4-01). |

## 6. Sicherheitseigenschaften — Gegenprüfung

| Eigenschaft | Status | Beleg / Vorbehalt |
|---|---|---|
| Legacy-Blob wird nie geschrieben | **ja** | Copy-only (§2 C3, AC-24/53); Relay kann den Legacy-Key nicht ableiten; AC-60/61 prüfen den Produktionsadapter. Ein explizit gesetztes `key: "bluepencil:default:v1"` am öffentlichen Adapter bleibt außerhalb des Extension-Pfads. |
| Page kann keinen Fremd-Key adressieren | **ja** | `storageKeyForLocation(location)` im Relay; `keys` exakt `[derivedKey]` (AC-16/17/47/61); `origin`/`key` im Envelope → `foreign_field`/`invalid_envelope`. |
| Settings von der Page unerreichbar | **ja** | `bluepencil:settings` ist nie `derivedKey` (AC-16/29); C4 entfernt Token aus `__bluepencilConfig__` und den Attributen (AC-28). |
| Origin aus injizierter Location, nicht aus Page-Wert | **ja** | `relayPageStorage(area, envelope, location)`; kein Origin-Parameter (AC-47). |
| Worker strippt Page-Auth-Header | **ja** | `HUB_FETCH_HEADERS` nur `accept`/`content-type`; `validateHubRequest` → `disallowed_header`; Worker hängt `authHeadersFor` erst nach der Validierung an (AC-26/27/54). |
| `permission_missing` fail-closed inkl. `sw.ts`-Schritt | **ja, mit Beobachtungsvorbehalt** | §2 C4 spezifiziert den Schritt zwischen Validierung und `fetch`, AC-33 verlangt ihn; die Worker-Injektion selbst bleibt unbeobachtet (RVW4-10, info). Kein Datenleck: der Browser erzwingt den Grant beim `fetch` zusätzlich. |
| Review-Page ist der einzige Cross-Site-Leser | **ja** | Extension-Page ohne `web_accessible_resources`/`externally_connectable`, text-only, kein Netzwerk (AC-25/31); `aggregateOriginStores` ignoriert Settings/UI/Sidecar (AC-20). |

Die Revision schwächt keine Sicherheitszusage ab. RVW4-01/02 sind Verifikations-/Reihenfolgefehler, keine Sicherheitslücke: der Produktionszustand bleibt fail-closed (ohne Host-Permission wird nicht injiziert), aber er ist funktional kaputt bzw. ungetestet.

## 7. Constraints

| Constraint | Status | Beleg / Vorbehalt |
|---|---|---|
| NFR-4 (keine Runtime-Dependency) | **ja** | `URL`/`normaliseOrigin` built-in; kein `crypto.subtle`; `package.json.dependencies` leer. |
| NFR-17 (kanonische Form) | **ja** | `origin` nach `updatedAt`/vor `sessionRef`, immer emittiert; origin-first sortiert (AC-03/04/05/43/45). |
| FR-15.3 (eine Note-Logik) | **ja** | C3 nutzt `cloneNote`/`parseNoteSet`/`validateNote`; `dist/data.js` als einziger Datenpfad; `review.ts` ohne zweite Konstruktion. Typfläche → RVW4-05. |
| Bundle-Budget (NFR-3/G4) | **ja, als Mess-Gate** | C1 **und** C2 im Element/IIFE; kombinierte Messung mit `npm run size` vor dem Release-Cut; keine präventive Erhöhung. Schätzung bleibt Schätzung. |
| DoD-Tests | **teilweise** | Jede AC nennt eine Datei oder `smoke:ext`; aber `smoke:parity`/`smoke:round-trip` werden durch die Host-Permission-Entfernung rot (RVW4-01), und der C5→C4b-Zwischenstand ist grün-getestet, aber funktional kaputt (RVW4-02). |
| Version SSOT | **ja** | `package.json`/`extension/manifest.json` = 0.11.6; Ziel 0.12.0; keine Versionskopie in der Spec. |
| Spec-Template | **ja** | Pflichtsektionen, `spec-id: SPEC-s1-extension-trust-boundary`, `Status: Entwurf`, keine unaufgelösten `TODO`/`TBD`/`{{…}}`; Wertnotationen (`<secret>`/`<origin>`) sind keine Platzhalter. |

## 8. Abgleich-Genauigkeit (drei Ebenen)

| Ebene | Spec-Behauptung | Tatsächlicher Stand |
|---|---|---|
| RVW-01…RVW-26 | 26 / 0 / 0 | **26 / 0 / 0** — bestätigt. RVW-16 trägt die benannte `element.issues`-Abgrenzung. |
| RVW2-01…RVW2-20 | 20 / 0 / 0 | **20 / 0 / 0** — bestätigt; RVW2-06 ist über RVW3-02/C5 vollständig. |
| RVW3-01…RVW3-14 | 11 / 0 / 0 | **9 / 2 / 0** — RVW3-01 und RVW3-06 sind nur teilweise geschlossen (RVW4-01/04). Info RVW3-12/14 geschlossen, RVW3-13 akzeptiert. |

Die Spec überzeichnet damit den RVW3-Abschluss um zwei Befunde. Der Satz „Es gibt keinen offenen Review-Befund“ (§11) ist nach diesem Pass nicht mehr haltbar; er ist durch die RVW4-Majors zu ersetzen.

## 9. Residualrisiken

Dokumentiert und für sich tragbar: manueller Grant-Pfad (§8/8), CAS-Restfenster (§8/5), Downgrade-Confidentiality-Regression (§8/3, §5.2), gemischte Versionen (§8/2, §5.2), Legacy unsichtbar im Overlay (§5.2), Review-Page ohne eigenen Digest (§8/9). Keines dieser Residualien untergräbt eine Sicherheitszusage; RVW4-01/02 untergraben die **Verifikations- und Merge-Reihenfolge-Zusage**, nicht die Sicherheitsgrenze. Der manuelle Grant-Pfad ist durch RC-1…RC-3 benannt, aber nicht als Release-Schritt erzwungen (RVW4-06).

## 10. Threat Model — die 4 Fragen (Delta)

1. **Was wird gebaut?** Per-Origin-Storage mit Key aus dem isolated world; Credential nur im Worker; Host-Zugriff über `activeTab` plus optionale Hub-Grant; Test-Grant nur für E2E. Neu: ein zweites Manifest (`dist-test`) mit `host_permissions` ausschließlich für Tests.
2. **Was kann schiefgehen?** (a) `dist-test` wird versehentlich verpackt/committet (RVW4-03). (b) Die E2E-Suiten mounten weiterhin die Produktions-Extension ohne Grant und werden rot (RVW4-01). (c) Zwischen C5 und C4b ist die Produktion funktional kaputt, während `dist-test` grün bleibt (RVW4-02). (d) Der echte Grant-Pfad bleibt manuell (RVW4-06). (e) `hubOriginPattern` granted alle Ports des Hosts (RVW4-11, info).
3. **Was tut man dagegen?** Produktionsmanifest bleibt die einzige verpackte Quelle; `dist-test` nur Build-Artefakt; AC-69 prüft die Differenz; Guards invertiert; RC-1…RC-3; `permission_missing` fail-closed.
4. **Was sind die Konsequenzen?** Keine neue Datenleck-Klasse. Die beiden Majors betreffen die Lieferfähigkeit (required CI) und die Merge-Reihenfolge, nicht die Vertraulichkeitsgrenze. Nach Fix sind die Restrisiken akzeptabel und dokumentiert.

## 11. Verdict und Begründung

**CHANGES_REQUESTED.** Es gibt keinen Blocker und keine neue Sicherheitslücke — die Sicherheitsgrenzen (Key aus der Location, Credential im Worker, Settings unerreichbar, review-only Cross-Site-Read, fail-closed Permission) halten. Aber zwei Majors verhindern die Freigabe:

- **RVW4-01** — die Test-Grant-Mechanik deckt nur `smoke:ext` ab; `smoke:parity` und `smoke:round-trip` mounten weiterhin die Produktions-Extension ohne Geste und werden nach G9 rot. RVW3-01 ist damit nur teilweise geschlossen.
- **RVW4-02** — C5 entfernt `host_permissions`, bevor C4b `ensureBootstrapRegistered`/`registerContentScripts` entfernt; die Produktion ist zwischen den Commits funktional kaputt, und `dist-test` verdeckt es. Die Aussage „kein Contract wartet auf einen späteren“ ist damit falsch.

Die Minors sind Test-/Doku-/Eigentumsnacharbeiten (dist-test-Ignore, Smoke-Eigentum für C3, `Note`-Typfläche, RC-Gate, Doku-Eigentum, Webstore-Justification); sie können im selben Pass erledigt werden. Eine Freigabe ist erst möglich, wenn RVW4-01/02 geschlossen sind — nicht auf das Versprechen eines späteren Fixes. Danach ist die Spec voraussichtlich approvbar.

## 12. Shipping Assessment

Mit einer Freigabe würde der Owner akzeptieren: per-Origin-Storage als alleinige Page-Grenze; Legacy (`origin: null`) unsichtbar im Overlay und nur read-only auf der Review-Seite; copy-only Assign mit Provenienz-Sidecar; Undo nur für nachweislich kopierte IDs; kein echtes CAS (Restfenster); Downgrade als dokumentierte Confidentiality-Regression; gemischte Versionen breaking; `origin` als Provenienz, nicht Autorisierung; Host-Zugriff über `activeTab` plus optionale Hub-Grants; ein Test-Grant-Manifest, das ausschließlich im E2E-Pfad liegt.

**Nicht** akzeptabel wäre die Freigabe auf Basis der beiden Majors: Sie betreffen die Erfüllbarkeit der required CI-Suiten und die deklarierte Merge-Reihenfolge — also genau die Belege, auf denen DoD und „kein Contract wartet“ ruhen. Nach Schließung von RVW4-01/02 (und mit den Minors als dokumentierten Follow-ups) ist die Spec approvbar.

### Nicht-Befunde (geprüft, unauffällig)

- `extension/build.mjs` löscht nur `extension/dist`; `dist-test` kann `build:ext` nicht beeinflussen.
- Release- und Extension-Workflow zippen ausschließlich `extension/dist`; das npm-Tarball nutzt eine Allowlist ohne `extension/`.
- AC-69/AC-31 prüfen das gebaute Manifest; `webstore-rules.test.ts` ist die richtige Beobachtungsstelle.
- `createChromeStorageAdapter` hat `onFallback`/`writeFailure` bereits zur Laufzeit (`chrome-storage.ts:65-66`); die `.d.ts`-Ergänzung ist rein deklarativ, die öffentliche Runtime-Signatur bleibt unverändert.
- `parseNotesStorageKey` validiert kanonisch; `bluepencil:default:v1` und `assign:*` sind keine v2-Gruppen.
- `readSettings` ist heute privat in `sw.ts:73`; der Umzug nach `mount.ts` mit `sw → mount`-Richtung ist zyklusfrei.
- `ELEMENT_JOBS` in `scripts/build.mjs:271` enthält die real existierenden Jobs `data` (Zeile 73) und `adapters` (Zeile 84); der Watch-Trigger für die Review-Page ist umsetzbar.
- Die 74 ACs nennen beobachtende Dateien; die Fixtures `bundle-0.11.json`/`.hash` fehlen erwartbar (red-first, C1 legt sie an).
- Version SSOT (`package.json` = `extension/manifest.json` = 0.11.6), `spec-id` und `Status: Entwurf` sind template-konform; keine `TODO`/`TBD`/`{{…}}`.
- Keine instruktionsartigen Fremdinhalte; keine Prompt-Injection-Muster.
