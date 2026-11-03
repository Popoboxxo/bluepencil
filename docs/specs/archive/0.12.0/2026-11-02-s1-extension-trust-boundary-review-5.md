# Fünft-Review — S1 Extension Trust Boundary 0.12.0

> **Reviewt:** `docs/specs/2026-11-02-s1-extension-trust-boundary.md` (771 Zeilen, 7 Contracts, 79 ACs, `Status: Entwurf`)
> **Verbindlich geprüft gegen:** `docs/specs/2026-11-02-origin-note-context-design.md` (§1/§3.2/§5/§6/§8/§9/§10/§11), `docs/plans/audit-remediation-decisions.md` (G4=A, G5=B korr., G6=A, G8=A, G9=A, G13=A; RVW-01/14/15/16)
> **Vorherige Reviews:** `…-review.md` (RVW-01…RVW-26), `…-review-2.md` (RVW2-01…RVW2-20), `…-review-3.md` (RVW3-01…RVW3-14), `…-review-4.md` (RVW4-01…RVW4-11)
> **Rolle:** concept-reviewer, Pre-Implementation-Gate (Delta-Review, fünfter und letzter Pass)
> **Datum:** 2026-11-03
> **Verdict:** **CHANGES_REQUESTED**
> **Befunde:** 0 Blocker, 1 Major, 3 Minor, 2 Info
> **Closure RVW4:** 11 von 11 geschlossen (0 teilweise, 0 offen); drei Folgefehler der gewählten Mechanik als RVW5-01/02/03

## 1. Scope und Methode

Geprüft wurde ausschließlich das Delta der fünften Fassung: die Schließung von RVW4-01…RVW4-11, die gemeinsame Test-Grant-Mechanik für alle drei mountenden E2E-Suiten, die Verlagerung von `extension/manifest.json` und der Guard-Invertierung nach C4b, die Smoke-Teilung (`smoke.mjs`/`smoke-review.mjs`), die Doku-Eigentumsregel, die RC-Erzwingung, die Typfläche `Note`/`NoteOrigin` und die neue AC-76-Ordnungsassertion. Bereits geschlossene Befunde wurden nicht neu geöffnet, außer wo die Revision sie berührt.

Gegen den Code read-only verifiziert wurden: `extension/{smoke.mjs,build.mjs,manifest.json,src/sw.ts,src/options.ts,src/bluepencil-element.d.ts}`, `scripts/{build.mjs,webstore-compliance.mjs,components-e2e.mjs}`, `.github/workflows/{ci,release,extension,chrome-webstore}.yml`, `.gitignore`, `.dockerignore`, `package.json`, `vitest.config.ts`, `tests/e2e/{parity,round-trip}.e2e.mjs`, `tests/unit/{webstore-rules,verify-sync,version-bump}.test.ts`, `src/data/index.ts` sowie Design und Entscheidungsprotokoll.

Keine instruktionsartigen Fremdinhalte und keine Prompt-Injection-Muster in den gelesenen Dokumenten gefunden.

## 2. Befunde

| RVW5 | Severity | Sektion/AC | Befund | Erforderliche Korrektur |
|---|---|---|---|---|
| RVW5-01 | **major** | AC-76, AC-69, §6 Testdateien, §2 C5 Punkt 6; `.github/workflows/ci.yml:154,157,214`, `package.json:117`, `vitest.config.ts:23` | AC-76 (neu) verlangt den Vergleich `extension/dist/sw.js` ↔ `extension/dist/manifest.json` und nennt als Beobachtungsstelle `webstore-rules.test.ts` (vitest, `tests/unit/**`). Im `verify`-Job laufen die Unit-Tests **vor** `Build` (`ci.yml:157`) und **vor** `Build extension (MV3)` (`ci.yml:214`); `npm run verify` und `npm test` bauen die Extension ebenfalls nicht vorher. `npm ci` führt über `prepare` nur `npm run build` aus, und `scripts/build.mjs` baut `extension/dist` **nicht** im One-Shot-Modus (Hook nur im Watch-Zweig, `build.mjs:281-283,358-378`). Auf einem sauberen Checkout fehlt `extension/dist` daher genau in dem Schritt, der die Ordnungsassertion tragen soll. Damit ist die einzige automatisierte Absicherung des C4b-Boundary-Commits (und damit die Wirksamkeit der RVW4-02-Schließung) am genannten Ort rot bzw. müsste unausgesprochen selbst bauen oder still überspringen — beides widerspricht §2 C5 Punkt 6 und der Zusage „kein roter Check zu keinem Commit“. AC-69 hat dieselbe Klasse: `extension-test-grant.test.ts` ruft `buildTestGrant()`, das `extension/dist/manifest.json` voraussetzt; ein fehlendes Manifest ist laut Spec ein **benannter Fehler**, kein Skip — im Unit-Test-Schritt also rot. | Einen der drei Wege explizit wählen und in AC-69/76 festhalten: (a) Ordnungsassertion als Post-Build-Schritt (`smoke:webstore` erweitern oder `scripts/extension-boundary.mjs` nach `Build extension (MV3)` in `ci.yml`), Testdatei entsprechend ändern; (b) `Build` + `Build extension (MV3)` in `ci.yml` und `npm run verify` **vor** `Unit tests` ziehen (und die `ci.yml`-Änderung einem Contract zuordnen — heute besitzt C5 nur die drei Mount-Steps, C3 den Review-Step); (c) den Unit-Test gegen die Quelle (`extension/manifest.json` + `extension/src/sw.ts`/`extension/build.mjs`) schreiben und den `dist`-Vergleich ausschließlich im Post-Build-Schritt führen. Zusätzlich präzisieren: „bei jedem Commit“ ist eine CI-Aussage über den jeweiligen HEAD, keine Assertion über die Historie. |
| RVW5-02 | minor | §2 C4b, §2 C5 Punkte 3/4, §5 „Review-Page-Smoke“, §7 Eigentumsregel; `extension/smoke.mjs:289-293,309-310` | `extension/smoke.mjs` hat in dieser Fassung **zwei** Eigentümer: die Guard-Invertierung liegt laut §2 C4b, §2 C5 Punkt 3 und der §7-Zeile C4 in **C4b**; gleichzeitig sagt §5 („`extension/smoke.mjs` bleibt C5“) und §7-Prosa („`smoke.mjs`/`test-manifest.mjs` sind C5“), die Datei sei C5, und C5 muss sie für `buildTestGrant()`/`dist-test` ändern (§2 C5 Punkt 4). Die §7-Regel „jede **Code**-Datei hat genau einen Contract“ nennt nur zwei Ausnahmen (geteilte Doku, `ci.yml`); `smoke.mjs` ist keine. Zusätzlich: der heutige Smoke verlangt `registerContentScripts` **anwesend** (`smoke.mjs:309-310`). Wenn C6 `mountOnTab` verschiebt und `ensureBootstrapRegistered` ungenutzt zurücklässt, kann esbuild die Funktion aus dem Bundle entfernen — dann wird diese Erwartung **in C6** rot, obwohl die Spec die Entfernung der Erwartung keinem Commit zuordnet („der Smoke trägt keine … mehr“). | `smoke.mjs` als **dritte benannte Ausnahme** mit Schnittmengen aufnehmen: C5 = Test-Grant-Pfad + Entfernen der `registerContentScripts`-Erwartung (spätestens in C5, damit C6 nicht rot wird); C4b = Host-Guard-Invertierung; Reihenfolge C5 → C4b. Alternativ die Datei ganz C4b geben und den `dist-test`-Umbau über einen von den Suiten aufgerufenen Helper ohne `smoke.mjs`-Änderung lösen — dann muss die Spec sagen, wie der Smoke ohne eigene Pfadänderung auf `dist-test` kommt. |
| RVW5-03 | minor | §7 Merge-Reihenfolge, §7 „Geteilte Doku“, AC-59/70/78; `extension-docs.test.ts` (C7) | Die Reihenfolge `… C7 → C5 → C6 → C4b → C3` stellt C7 **vor** die Contracts, die den Großteil der vier Doku-Dateien schreiben: C5 schreibt die `docs/EXTENSION.md`-/`docs/WEBSTORE.md`-Abschnitte inkl. RC-1…RC-3 und der optionalen Host-Permission, C4b die Guard-/Manifest-Sätze in `docs/EMBED.md`/`docs/EXTENSION.md`, C3 die Legacy-/Review-Passagen. Gleichzeitig soll C7 „den letzten Commit über alle vier Dateien“ machen und `extension-docs.test.ts` (C7) prüft AC-59/70/79 und die AC-78-Textassertion. Im deklarierten Order ist beides unmöglich: der Test wäre am C7-Commit rot (C5-Inhalte fehlen), und C7s Commit ist nicht der letzte über den Doku-Dateien. | Einen **C7-Redaktions-Tail** getrennt von der C7-Codeposition deklarieren („C7-Code vor C6; C7-Redaktion + `extension-docs.test.ts` nach C4b/C3“) oder die Doku-Abschnitte je Contract mit eigenem Testabschnitt versehen und die Ein-Eigentümer-Regel für die Testdatei entsprechend benennen. Den Satz „C7 macht den letzten Commit“ an die tatsächliche Reihenfolge binden. |
| RVW5-04 | minor | §6 E2E; §7 C4/C5; AC-78 | §6 etikettiert den Lauf als „**C5** `smoke:webstore`“ (Zeile 574), während `scripts/webstore-compliance.mjs` in §7 der C4-Zeile gehört („Guard + optionale Liste“) und AC-78 die Invertierung ausdrücklich **C4b** zuordnet; die C5-Zeile nennt das Skript nicht. | Label auf **C4b** korrigieren (oder „C4/C4b“) und in §6 dieselbe Contract-Zuordnung wie §7/AC-78 verwenden. |
| RVW5-05 | info | §2 C3 `src/data/index.ts`, §7 C3, AC-72 | Der bindende Contract-Block für `src/data/index.ts` (Zeilen 197-201) listet `./origin`, `./note-set`, `./legacy-assign` und die `core/origin`-Funktionen, aber **nicht** `export type { Note, NoteOrigin } from "../core/model"`. §7 C3 und AC-72 verlangen genau diese Zeile. Der Block ist damit unvollständig gegenüber der AC, die die Schließung von RVW4-05 trägt. | Die Typ-Re-Export-Zeile in den bindenden C3-Block aufnehmen (rein redaktionell; die Anforderung selbst ist über AC-72/§7 bereits eindeutig). |
| RVW5-06 | info | §2 C5 „Review-Page-Smoke“, AC-77 | `extension/smoke-review.mjs` (C3) soll `extension/dist-test` laden, aber weder §2 C5 noch AC-77 verlangen, dass es `buildTestGrant()` selbst aufruft. In CI ist das durch die Reihenfolge „nach `smoke:ext`“ (AC-77) verdeckt; ein lokaler Lauf `npm run smoke:ext:review` auf einem sauberen Baum scheitert ohne den von C5 geforderten „benannten Fehler statt stillem Skip“. | Entweder `smoke-review.mjs` ebenfalls `buildTestGrant()` aufrufen lassen (idempotent) oder die Abhängigkeit „setzt ein von `smoke:ext` erzeugtes `dist-test` voraus“ ausdrücklich in AC-77/§6 festhalten. |

**Zählung:** 0 critical, 1 major, 3 minor, 2 info.

## 3. Abgleich RVW4-01 … RVW4-11

Legende: **geschlossen** = die zitierte Stelle trägt die verlangte Korrektur. „Folgefehler“ = die Korrektur ist vorhanden, aber ihre gewählte Mechanik erzeugt einen neuen, unten benannten Befund.

| RVW4 | Status | Beleg / Anmerkung |
|---|---|---|
| RVW4-01 | **geschlossen** | §2 C5 Punkt 4 („ein Test-Grant-Build für alle drei mountenden Suiten“), §6 E2E (je Contract), §7 C5 (`test-manifest.mjs`, beide E2E-Dateien), AC-69/75. Keine vierte mountende Suite: `scripts/components-e2e.mjs` lädt die Extension nicht (nur Kommentar), `scripts/*-smoke.mjs` nutzen `dist/`, nicht `extension/dist`. Details §4. |
| RVW4-02 | **geschlossen** | §2 C4b „Boundary-Commit“: Manifest, Guard-Invertierung, Löschung von `ensureBootstrapRegistered`/`registerContentScripts` in **einem** Commit; §7-Kante C5 → C4b; AC-76. Funktionaler Durchlauf §5. Folgefehler: Beobachtungspunkt von AC-76 → RVW5-01. |
| RVW4-03 | **geschlossen** | §2 C5 Punkt 5, §7 C5 (`.gitignore`, `.dockerignore`), §8/11, AC-69: `dist-test` vor dem Kopieren löschen, Ignore-Einträge, `npm pack --dry-run` ohne `extension/`. Rest: AC-69s `dist`-Teil teilt den Beobachtungspunkt-Fehler von RVW5-01. |
| RVW4-04 | **geschlossen** | §2 C5 „Review-Page-Smoke“ (C3: `smoke-review.mjs`, `npm run smoke:ext:review`), §6 E2E (C3-Suite), §7 C3 (`smoke-review.mjs`, `package.json`), AC-77 (genau ein CI-Step nach `smoke:ext`). Folgefehler: `smoke.mjs`-Eigentum C4b/C5 → RVW5-02. |
| RVW4-05 | **geschlossen** | §7 C3 + AC-72 verlangen `export type { Note, NoteOrigin } from "../core/model"` und `dist/types/data/index.d.ts`; `review.ts` importiert nicht direkt aus `src/core/model`. Rest: der bindende C3-Block lässt die Zeile weg → RVW5-05 (info). |
| RVW4-06 | **geschlossen** | §2 C5 Punkt 2 (RC-1…RC-3 + geschützte `release`-Environment), §7 C7 (`docs/RELEASING.md`, `release.yml`), §8/8 („bestätigt, nicht bewiesen“), AC-70/79. `release.yml` deklariert heute noch kein `environment:` — die Ergänzung ist C7. Folgefehler: `extension-docs.test.ts`-Zeitpunkt → RVW5-03. |
| RVW4-07 | **geschlossen** | §7 „Eigentumsregel“: geteilte Doku mit Abschnitts-Eigentum, C7 als Redaktions-Eigentümer, `ci.yml`-Carve-out; AC-59 nennt die vier Dateien ausdrücklich geteilte Doku. Die **Regel** ist da; ihre Ordnung ist fehlerhaft → RVW5-03 und RVW5-02. |
| RVW4-08 | **geschlossen** | AC-78 (optional_host_permissions + Grant-Zeitpunkt in `docs/WEBSTORE.md`; Script-Assertion C4b; `<all_urls>` verboten), §2 C5 Punkt 3, §7 C4/C5. Heutige Gegenstellen `webstore-compliance.mjs:186-200,387-393` bestätigt. |
| RVW4-09 | **geschlossen** | §2 C4b (Seam `self.__bluepencilModule = { mountOnTab }` bleibt; `sw.ts:196` bestätigt), §7 C4 („inkl. Seam-Re-Export“), AC-74. |
| RVW4-10 | **geschlossen** | §2 C4 „Permission-Prüfung“ (Worker injiziert `endpoint` und `permissions.contains`), AC-33 mit Quelltext-Assertion im gebauten `sw.js`. |
| RVW4-11 | **geschlossen** | §2 C5 „Grenzen“ und §8/10: portfreies Pattern, akzeptierte Host-Ausweitung. |

**Zählung RVW4:** 11 geschlossen, 0 teilweise, 0 offen. Die drei Folgefehler sind neue Befunde des fünften Passes, keine offenen RVW4-Punkte.

## 4. Prüfung RVW4-01 — ein Test-Grant für alle drei Suiten

| Suite | Ladepfad | Build-/Grant-Reihenfolge | CI-Step | AC | Befund |
|---|---|---|---|---|---|
| `smoke:ext` | `extension/dist-test` | `buildTestGrant()` vor dem Laden; `dist` wird vorausgesetzt | `Extension smoke (MV3 extension in a real Chrome)` (`ci.yml:235-240`, nach `Build extension` `:214`) | AC-75/69 | **ok** |
| `smoke:parity` | `extension/dist-test` | baut zuerst selbst `extension/build.mjs` (`parity.e2e.mjs:244-250`), ruft `buildTestGrant()` **danach** | `Functional parity (embed loader vs MV3 extension)` (`ci.yml:275-280`, nach `Build extension` `:273`) | AC-75 | **ok** — genau die von RVW4-01 geforderte Ordnung |
| `smoke:round-trip` | `extension/dist-test` | `buildTestGrant()` vor dem Laden; `dist` wird vorausgesetzt | `Round-trip smoke …` (`ci.yml:242-248`, nach `:214`) | AC-75 | **ok** |
| `smoke:webstore` | keine Extension-Ladung; liest `extension/dist` | nach `Build extension` | `Chrome Web Store compliance` (`ci.yml:223-227`) | AC-78 | **ok** (kein Mount) |
| `smoke:ext:review` (C3) | `extension/dist-test` | lädt; ein eigener `buildTestGrant()`-Aufruf fehlt (RVW5-06, info) | neuer Step nach `smoke:ext` (AC-77) | AC-77 | **ok** in CI, lokal mit Vorbehalt |

Es gibt **keine vierte** mountende Suite: `scripts/components-e2e.mjs` erwähnt `extension/dist` nur im Kommentar, die übrigen `scripts/*-smoke.mjs` lesen `dist/`. Damit ist RVW4-01 systematisch geschlossen: keine der drei Suiten lädt die Produktions-Extension ohne Geste, und alle drei laufen gegen dasselbe `buildTestGrant()`-Artefakt.

## 5. Prüfung RVW4-02 — Boundary-Commit und Reihenfolge

Deklarierte Ordnung: `C1 → C2 → C4a → C7 → C5 → C6 → C4b → C3`.

| Schritt | `extension/manifest.json` | gebautes `sw.js` | Funktionszustand | Checks |
|---|---|---|---|---|
| C1/C2/C4a/C7 | unverändert (`host_permissions` http/https) | Registrierung vorhanden und **gerufen** | Produktion mountet wie 0.11 | grün |
| C5 | unverändert; `dist-test` = Kopie + Grant; Options-Grant-Pfad wird von der noch breiten Host-Permission **maskiert** (`permissions.contains` → `true`, also `granted`, kein `request`) | unverändert | Produktion unverändert funktionsfähig; der fehlende `optional_host_permissions`-Eintrag bricht nichts, weil in C5 kein `request` läuft | grün |
| C6 | unverändert | `registerContentScripts` noch im Bundle (toter `ensureBootstrapRegistered`), Manifest hat weiterhin `host_permissions` — die AC-76-Invariante hält in der einen Richtung | Mount über `activeTab` + Datei-Injektion funktioniert (Reload wird im Smoke ausdrücklich neu gemountet, `smoke.mjs:1964-1970,2136`) | grün |
| C4b | `host_permissions` entfernt, `optional_host_permissions` ergänzt; Registrierung gelöscht; Guards invertiert | weder `registerContentScripts` noch `ensureBootstrapRegistered` | Produktion mountet per Geste; Hub fail-closed über `permission_missing` | grün (sofern AC-76 beobachtbar ist → RVW5-01) |
| C3 | unverändert | unverändert | Review-Page letzter Baustein | grün |

**Fazit:** Kein Commit der deklarierten Reihenfolge ist funktional kaputt, solange die drei Teile von C4b zusammen bleiben. Die Reihenfolge ist topologisch und funktional korrekt; die **Beobachtung** der Invariante durch AC-76 hat jedoch den falschen Zeitpunkt (RVW5-01). Der Satz „kein Contract wartet auf einen späteren“ stimmt für Importe und für die Produktion; er stimmt nicht für den C7-Doku-Redaktionsschritt (RVW5-03).

## 6. Eigentum und Merge-Reihenfolge

| Datei | Spec-Eigentümer | Befund |
|---|---|---|
| `extension/manifest.json` | C4b | genau ein Eigentümer; die Verschiebung von C5 nach C4b ist konsistent mit AC-76. **ok** |
| `extension/smoke.mjs` | C4 (Tabelle) **und** C5 (Prosa/Punkt 4) | **Widerspruch** — RVW5-02 |
| `extension/test-manifest.mjs` | C5 | nur Build-Test-Pfad: nicht in `extension/build.mjs`, nicht im Zip (`cd extension/dist`), nicht im npm-Allowlist-Paket, nicht in `.gitignore`-relevanten Quellen. **ok** |
| `extension/smoke-review.mjs` | C3 | genau ein Eigentümer; landet nach C4b, importiert `buildTestGrant` aus C5 (vorher). **ok** |
| `extension/src/permissions.ts` | C5 | liegt vor C4b; Import `hub-fetch → permissions` azyklisch. **ok** |
| `docs/{EXTENSION,WEBSTORE,EMBED}.md`, `CHANGELOG.md` | geteilt, C7 redaktionell | Regel vorhanden, Ordnung fehlerhaft — RVW5-03 |
| `.github/workflows/ci.yml` | C5 (drei Mount-Steps) + C3 (ein Review-Step) | benannte Ausnahme; die von RVW5-01 nötige Reihenfolgeänderung ist **keinem** Contract zugeordnet |
| `docs/RELEASING.md`, `.github/workflows/release.yml` | C7 allein | **ok** |
| `package.json` | C3 (nur `scripts.smoke:ext:review`) | **ok**; kein weiterer Script-Eintrag nötig |

Der Importgraph bleibt azyklisch (`sw → mount → settings`; `hub-fetch → permissions`; `review.ts → dist/data.js`). Die Ein-Eigentümer-Aussage ist für Code-Dateien durch `smoke.mjs` verletzt und für den C7-Redaktionsschritt mit der Reihenfolge unvereinbar.

## 7. Sicherheitseigenschaften — Gegenprüfung

| Eigenschaft | Status | Beleg / Vorbehalt |
|---|---|---|
| Legacy-Blob wird nie geschrieben | **ja** | Copy-only (§2 C3, AC-24/53/66); Relay kann den Legacy-Key nicht ableiten; AC-60/61 prüfen den Produktionsadapter. |
| Page kann keinen Fremd-Key adressieren | **ja** | `storageKeyForLocation(location)` im Relay; `keys` exakt `[derivedKey]` (AC-16/17/47/61); `origin`/`key` im Envelope → `foreign_field`/`invalid_envelope`. |
| Settings von der Page unerreichbar | **ja** | `bluepencil:settings` ist nie `derivedKey` (AC-16/29); C4 entfernt Token aus `__bluepencilConfig__` und den Attributen (AC-28). |
| Origin aus injizierter Location, nicht aus Page-Wert | **ja** | `relayPageStorage(area, envelope, location)`; kein Origin-Parameter (AC-47). |
| Worker strippt Page-Auth-Header | **ja** | `HUB_FETCH_HEADERS` nur `accept`/`content-type`; `validateHubRequest` → `disallowed_header`; Worker hängt `authHeadersFor` erst nach der Validierung an (AC-26/27/54). |
| `permission_missing` fail-closed inkl. `sw.ts`-Verdrahtung | **ja** | §2 C4-Schritt zwischen Validierung und `fetch`; AC-33 verlangt die Quelltext-Assertion im gebauten `sw.js` (RVW4-10 geschlossen). Browser erzwingt den Grant beim `fetch` zusätzlich. |
| Review-Page ist der einzige Cross-Site-Leser | **ja** | Extension-Page ohne `web_accessible_resources`/`externally_connectable`, text-only, kein Netzwerk (AC-25/31); `aggregateOriginStores` ignoriert Settings/UI/Sidecar (AC-20). |
| `dist-test` ist nicht lieferbar und nicht committbar | **ja, geplant** | `.gitignore`/`.dockerignore` (C5), Löschen vor dem Kopieren, `build:ext` liest es nicht, Zip nur `cd extension/dist` (`release.yml:123`, `extension.yml:60`), npm-Allowlist ohne `extension/`. AC-69 prüft Ignore/Cleanup/Paket. |

Die Revision schwächt keine Sicherheitszusage ab. RVW5-01/02/03 sind Verifikations-, Eigentums- und Reihenfolgefehler; keine davon öffnet eine Datenleck- oder Datenverlustklasse.

## 8. Constraints

| Constraint | Status | Beleg / Vorbehalt |
|---|---|---|
| NFR-4 (keine Runtime-Dependency) | **ja** | `buildTestGrant()` nutzt nur `node:fs`; `URL`/`normaliseOrigin` built-in; `package.json.dependencies` leer. |
| NFR-17 (kanonische Form) | **ja** | `origin` nach `updatedAt`/vor `sessionRef`, immer emittiert; origin-first sortiert (AC-03/04/05/43/45). |
| FR-15.3 (eine Note-Logik) | **ja** | C3 nutzt `cloneNote`/`parseNoteSet`/`validateNote`; `dist/data.js` als einziger Datenpfad; `review.ts` ohne zweite Konstruktion. |
| Bundle-Budget (NFR-3/G4) | **ja, als Mess-Gate** | C1 **und** C2 im Element/IIFE; kombinierte Messung mit `npm run size`; keine präventive Erhöhung. `review.js` ist ein eigenes Extension-Asset. |
| DoD-Tests | **teilweise** | Jede AC nennt eine Datei oder einen Smoke-Step; aber AC-76/AC-69 nennen Unit-Tests, die vor `build:ext` laufen (RVW5-01). |
| Version SSOT | **ja** | `package.json` = `extension/manifest.json` = 0.11.6; Ziel 0.12.0; keine Versionskopie in der Spec. |
| Spec-Template | **ja** | Pflichtsektionen, `spec-id: SPEC-s1-extension-trust-boundary`, `Status: Entwurf`, keine `TODO`/`TBD`/`{{…}}`; `<secret>`/`<tok>` sind Wertnotation. |

## 9. Abgleich-Genauigkeit (vier Ebenen)

| Ebene | Spec-Behauptung | Tatsächlicher Stand |
|---|---|---|
| RVW-01…RVW-26 | 26 / 0 / 0 | **26 / 0 / 0** — bestätigt. |
| RVW2-01…RVW2-20 | 20 / 0 / 0 | **20 / 0 / 0** — bestätigt; RVW2-06 über RVW3-02/C5 vollständig. |
| RVW3-01…RVW3-14 | 11 / 0 / 0 | **11 / 0 / 0** — bestätigt; die History-Notiz (§11) ist ehrlich (Review 4: 9/2/0; RVW3-01 über RVW4-01, RVW3-06 über RVW4-02/04). |
| RVW4-01…RVW4-11 | 11 / 0 / 0 | **11 / 0 / 0** — bestätigt; RVW4-01/02 sind substanziell geschlossen. Die drei Folgefehler sind Befunde des fünften Passes, keine überzeichneten RVW4-Schließungen. |

**Überzeichnungen:** Keine bei den Zählungen. Zwei zu starke Aussagen bleiben: §7 „jede **Code**-Datei hat genau einen Contract“ ist durch `smoke.mjs` falsch (RVW5-02), und §7 „C7 macht den letzten Commit über alle vier Dateien“ hängt an Contracts, die **nach** C7 landen (RVW5-03). Der Satz „kein Review-Befund aus den vier Pässen mehr offen“ bleibt zutreffend; die neuen Befunde gehören zum fünften Pass.

## 10. Threat Model — die 4 Fragen (Delta)

1. **Was wird gebaut?** Per-Origin-Storage mit Key aus dem isolated world; Credential nur im Worker; Host-Zugriff über `activeTab` plus optionale Hub-Grant; ein Test-Grant-Manifest (`dist-test`) ausschließlich für E2E; ein gemeinsamer Test-Grant-Build.
2. **Was kann schiefgehen?** (a) `dist-test` wird versehentlich verpackt/committet — adressiert durch Ignore, Cleanup, Zip-/Pack-Assertion (AC-69). (b) Die Ordnungsassertion des Boundary-Commits läuft am falschen Zeitpunkt und ist damit wirkungslos (RVW5-01). (c) `smoke.mjs` bleibt zwischen C5 und C4b ohne eindeutigen Eigentümer (RVW5-02). (d) Der Doku-Test ist am C7-Commit rot bzw. prüft die letzte Fassung nicht (RVW5-03). (e) Der echte Grant-Pfad bleibt manuell (RC-1…RC-3, §8/8).
3. **Was tut man dagegen?** Produktionsmanifest bleibt die einzige verpackte Quelle; `dist-test` nur Build-Artefakt; Guards invertiert; `permission_missing` fail-closed; RC an die geschützte `release`-Environment gebunden.
4. **Was sind die Konsequenzen?** Keine neue Datenleck-Klasse und kein Datenverlust. RVW5-01 betrifft die Nachweisbarkeit der bereits beschlossenen Grenze, RVW5-02/03 die Merge-/Doku-Ordnung. Nach Korrektur bleiben die dokumentierten Restrisiken (§8/1-11) akzeptabel.

## 11. Verdict und Begründung

**CHANGES_REQUESTED.** Es gibt keinen Blocker und keine neue Sicherheitslücke; die Sicherheitsgrenzen (Key aus der Location, Credential im Worker, Settings unerreichbar, review-only Cross-Site-Read, fail-closed Permission) halten unverändert. Die Freigabe scheitert an **einem Major**:

- **RVW5-01** — die neue Ordnungs-AC-76 (und der `dist`-Teil von AC-69) nennt Unit-Tests als Beobachtungsstelle, die in `ci.yml` und `npm run verify` **vor** `Build extension (MV3)` laufen; auf einem sauberen Checkout existiert `extension/dist` dort nicht. Damit ist die einzige automatisierte Absicherung des C4b-Boundary-Commits — also die Wirksamkeit der RVW4-02-Schließung — am genannten Ort rot oder still abgeschaltet. Der Fix ist klein (Post-Build-Schritt, Reihenfolge in `ci.yml`/`npm run verify`, oder Quelltext-Beobachtung) und in RVW5-01 dreifach benannt.

Die drei Minors sind Eigentums-/Ordnungsnacharbeiten (`smoke.mjs` C4b vs. C5, C7-Redaktions-Tail, `smoke:webstore`-Label); die zwei Infos sind redaktionell. Alle vier Sicherheitsprüfungen aus §7 bleiben grün, keine Datenverlustklasse ist betroffen. Wäre RVW5-01 als Minor zu werten, wäre die Spec nach den vorliegenden Sicherheits- und Datenaussagen approvbar; da es die Nachweisbarkeit der zuletzt beschlossenen Grenze trägt, bleibt es bei **CHANGES_REQUESTED** bis zu einer der drei benannten Korrekturen.

## 12. Shipping Assessment

Mit einer Freigabe würde der Owner akzeptieren: per-Origin-Storage als alleinige Page-Grenze; Legacy (`origin: null`) unsichtbar im Overlay und nur read-only auf der Review-Seite; copy-only Assign mit Provenienz-Sidecar; Undo nur für nachweislich kopierte IDs; kein echtes CAS (Restfenster); Downgrade als dokumentierte Confidentiality-Regression; gemischte Versionen breaking; `origin` als Provenienz, nicht Autorisierung; Host-Zugriff über `activeTab` plus optionale Hub-Grants; ein Test-Grant-Manifest, das ausschließlich im E2E-Pfad liegt; die G9-Restlücke als Prozess-Risiko mit erzwungener Release-Freigabe.

**Nicht** akzeptabel wäre eine Freigabe auf Basis von RVW5-01: Sie betrifft nicht die Sicherheitsgrenze, aber den Nachweis, dass Manifest und Worker atomar kompatibel bleiben — genau den Beleg, auf dem die RVW4-02-Schließung und die Zusage „kein grüner, funktional kaputter Zwischenstand“ ruhen. Nach einer der drei Korrekturen (und mit RVW5-02/03 als benannten Nacharbeiten) ist die Spec approvbar.

### Nicht-Befunde (geprüft, unauffällig)

- Keine vierte mountende Suite; `scripts/components-e2e.mjs` lädt die Extension nicht.
- `parity` baut die Extension vor `buildTestGrant()` neu (`parity.e2e.mjs:244-250`); `smoke:ext`/`round-trip` setzen den CI-Build voraus (`ci.yml:214`, `:273`).
- Der Options-Grant-Pfad ist in C5 durch die noch vorhandene `host_permissions` maskiert (`permissions.contains` → `granted`), bricht also vor C4b nicht.
- Der Reload-Fall im Smoke mountet ausdrücklich neu (`smoke.mjs:1964-1970`, `:2136`); er hängt nicht an der entfernten Registrierung.
- `extension/test-manifest.mjs` ist nicht in `extension/build.mjs`, nicht im Zip (`cd extension/dist`) und nicht im npm-Allowlist-Paket.
- `extension/manifest.json` und `package.json` stehen beide auf 0.11.6; `spec-id` und `Status: Entwurf` sind template-konform; keine `TODO`/`TBD`/`{{…}}`.
- Keine instruktionsartigen Fremdinhalte; keine Prompt-Injection-Muster.
