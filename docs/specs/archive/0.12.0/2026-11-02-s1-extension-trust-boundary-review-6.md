# Sechst-Review — S1 Extension Trust Boundary 0.12.0

> **Reviewt:** `docs/specs/2026-11-02-s1-extension-trust-boundary.md` (795 Zeilen, 7 Contracts, 79 ACs, `Status: Entwurf`)
> **Verbindlich geprüft gegen:** `docs/specs/2026-11-02-origin-note-context-design.md` (§1/§3.2/§5/§6/§8), `docs/plans/audit-remediation-decisions.md` (G4=A, G5=B korr., G6=A, G8=A, G9=A, G13=A)
> **Vorherige Reviews:** `…-review.md` (RVW-01…RVW-26), `…-review-2.md` (RVW2-01…RVW2-20), `…-review-3.md` (RVW3-01…RVW3-14), `…-review-4.md` (RVW4-01…RVW4-11), `…-review-5.md` (RVW5-01…RVW5-06)
> **Rolle:** concept-reviewer, Verifikations-Pass (sechster Pass, Scope nur RVW5-01…RVW5-06 + Regressionen)
> **Datum:** 2026-11-03
> **Verdict:** **APPROVED**
> **Befunde:** 0 critical, 0 major, 2 minor, 2 info
> **Closure RVW5:** 6 von 6 geschlossen (0 teilweise, 0 offen)

## 1. Scope und Methode

Geprüft wurde ausschließlich das Delta der sechsten Fassung: die Schließung von
RVW5-01…RVW5-06, die Zweiteilung der Ordnungsassertion (Quelle/Build), das
Abschnitts-Eigentum an `extension/smoke.mjs`, der C7-Split (`C7-code`/`C7-docs`) und
die daraus folgenden Regressionsrisiken (Beobachtungspunkte, Merge-Reihenfolge,
Datei-Eigentum). Bereits geschlossene Befunde wurden nicht neu geöffnet.

Read-only gegen den Code verifiziert wurden: `.github/workflows/ci.yml:130-280`,
`package.json:83-121`, `vitest.config.ts`, `scripts/build.mjs`,
`scripts/webstore-compliance.mjs`, `extension/smoke.mjs`,
`extension/manifest.json`, `tests/unit/webstore-rules.test.ts`, die Existenz der
geplanten Testdateien (`extension-docs.test.ts`, `extension-review.test.ts`,
`extension/test-manifest.mjs`, `extension/smoke-review.mjs` fehlen erwartungsgemäß)
sowie die von den ACs genannten Zeilen. Keine instruktionsartigen Fremdinhalte und
keine Prompt-Injection-Muster gefunden.

## 2. Befunde

| RVW6 | Severity | Sektion/AC | Befund | Erforderliche Korrektur |
|---|---|---|---|---|
| RVW6-01 | **minor** | AC-72 (Zeile 523), §6 Testdateien | AC-72 nennt als Gegeben „`extension/dist/review.js` nach `npm run build:ext`“ und als Beobachtungsstelle `extension-review.test.ts` (C3, Unit). In `ci.yml` laufen die Unit-Tests (`:154`) vor `Build extension (MV3)` (`:214`); `npm test` ist `vitest run` (`package.json:89`), `verify` testet vor `build:ext` (`:117`). `dist/data.js`/`dist/types` entstehen über `prepare` (`npm ci` → `npm run build`, `package.json:86`), `extension/dist` nicht (`scripts/build.mjs:358-378` baut die Extension im One-Shot nicht). Die Clause „`review.js` baut ohne fehlenden Export“ hat damit keinen CI-Schritt, der sie vor dem Build beobachtet; sie funktioniert nur, wenn der Test selbst baut (dann ist der Build implizit) oder still skippt. **Kein Sicherheits- oder Datenverlustbezug; nicht Teil des RVW5-Deltas (verwandt mit RVW3-05/RVW4-05, dort geschlossen).** | Den Beobachtungspunkt wie bei AC-76 zweiteilen: Quelltext-Assertionen in `extension-review.test.ts` (`src/data/index.ts`-Exportzeile, `review-data.d.ts`, kein `cloneNote`-Import in `review.ts`, Review-Entry/`ELEMENT_JOBS` in `extension/build.mjs`) und die Clause „`review.js` baut“ in `smoke:ext:review` (C3, nach dem Build) verschieben — oder im Test einen expliziten Temp-Build von `extension/build.mjs` deklarieren, nie einen stillen Skip. |
| RVW6-02 | **minor** | AC-76(c) (Zeile 527), AC-68 (Zeile 519) | AC-76(c) sagt „`mountOnTab` **gegen `dist`**“; die genannten Beobachter sind `webstore-rules.test.ts` (Quelle), `smoke:webstore` (lädt die Extension nicht) und `extension-mount-execution.test.ts` (Unit/Quelle). Für (c) gibt es damit keinen Build-Beobachter; inhaltlich deckt AC-38 (Zeile 489) denselben Wurf-Pfad auf Quelltextebene bereits ab. AC-68 sagt „gebaute Options-Page“, prüft aber über `extension-options-page.test.ts`; `extension/options.html` ist statisch und wird von `extension/build.mjs:120` unverändert kopiert, ein Quelltext-Lesen ist äquivalent. **Kein Sicherheits- oder Datenverlustbezug.** | (c) entweder als redundant zu AC-38 streichen oder auf „`mountOnTab` mit injizierter `executeScript`-Ablehnung (`…must request permission…`) liefert `{ok:false,error}`“ umformulieren und beim Unit-Test belassen; falls ein Build-Beleg gewollt ist, `smoke:ext` (lädt `dist-test`) ausdrücklich als Beobachter nennen. AC-68: „gebaute Options-Page“ → „`extension/options.html`“. |
| RVW6-03 | **info** | AC-33 (Zeile 484), §2 C4 „Permission-Prüfung“ (Zeile 283) | AC-33 verlangt „das gebaute `sw.js` übergibt …“, die Beobachter sind zwei Unit-Tests (`extension-hub-fetch.test.ts`, `extension-credential-isolation.test.ts`). Dieselbe Zeitpunktklasse wie RVW6-01; der Ursprung ist RVW4-10 (info, geschlossen), die Substanz (Worker injiziert `endpoint`/`permissions`) ist quelltextlich prüfbar. | Keine Blockade; bei Gelegenheit „gebautes `sw.js`“ → „`extension/src/sw.ts`“ (Quelltext-Assertion) oder `smoke:ext`/`smoke:webstore` als Beobachter ergänzen. Kein Wiederaufmachen von RVW4-10. |
| RVW6-04 | **info** | AC-76(a) (Zeile 527) | „bei jedem Commit von C1 bis C4b“ überzeichnet die Beobachtung: die Assertions werden erst in C4b in `webstore-rules.test.ts` geschrieben (§7 Zeile 576: Testdatei gehört C4b), können C1…C4a also nicht prüfen. Der Zustand vor C4b („beides vorhanden“) bleibt durch den atomaren Boundary-Commit erhalten; harmlos, aber als Abdeckungsaussage zu stark. | Formulierung auf „im Boundary-Commit C4b“ bzw. „ab C4b“ ziehen. |

**Zählung:** 0 critical, 0 major, 2 minor, 2 info. Keiner der vier Befunde öffnet eine
Datenleck-, Datenverlust- oder Budgetklasse; RVW6-01/02 sind Beobachtungs-/Wortlaut-
Präzisierungen, RVW6-03/04 sind Info. Sie blockieren die Freigabe nicht.

## 3. Abgleich RVW5-01 … RVW5-06

| RVW5 | Status | Beleg | Rest |
|---|---|---|---|
| RVW5-01 | **geschlossen** | §2 C4b „Die Ordnungsassertion ist zweigeteilt“ (Zeilen 274-277): Quelle = `extension/manifest.json` + `extension/src/sw.ts` in `tests/unit/webstore-rules.test.ts` (Datei existiert, `@vitest-environment node`, `vitest.config.ts:23` umfasst `tests/unit/**`; kein Build nötig); Build = `scripts/webstore-compliance.mjs` über `smoke:webstore`, in `ci.yml` nach `Build extension (MV3)` (`:214` → `:223-227`), fehlende Datei = benannter FAIL (AC-76(b), Zeile 527). AC-69 ist in (a) Unit/Quelltext+Hygiene und (b) Build/`smoke:ext` geteilt (Zeile 520); AC-31 ist ausdrücklich Quelle ohne `dist` (Zeile 482). `ci.yml` bleibt bei zwei Eigentümern (C5/C3), keine Umordnung. | Keine bzgl. der Ordnungsassertion. AC-72/AC-33 nennen weitere `dist`-Bezüge in Unit-ACs → RVW6-01/03 (minor/info, außerhalb des RVW5-Deltas). |
| RVW5-02 | **geschlossen** | `extension/smoke.mjs` ist dritte benannte Ausnahme mit disjunkten Abschnitten: C5 = Test-Grant-/`dist-test`-Pfad + Entfernen der `registerContentScripts`-Erwartung (§2 C5 Punkte 3/4/6, Zeilen 331-334; §2 C5 „Review-Page-Smoke“, Zeile 338; §7 Zeile 620; Tabellenzeilen 595/596); C4b = Host-Guard-Invertierung (§2 C4b Zeile 272). Reihenfolge C5 → C4b (Merge-Reihenfolge Zeile 603). Die heutigen Stellen `smoke.mjs:289-293` (Host-Guard) und `:309-310` (`registerContentScripts`) sind getrennte Statements in `checkArtefacts()`; der C4b-Guard liest `extension/dist/manifest.json`, der C5-Pfad `dist-test` — keine Überlappung. | Keine. |
| RVW5-03 | **geschlossen** | §7 trennt `C7-code` (Zeile 598) und `C7-docs` (Zeile 599); Merge-Reihenfolge `… C7-code → C5 → C6 → C4b → C3 → C7-docs` (Zeile 603), Kante „C7-docs zuletzt (nach C4b und C3)“ (Zeile 614). `extension-docs.test.ts` sitzt bei C7-docs (§7 Zeile 599, §6 Testdateien Zeile 576); die Datei existiert heute nicht, kann also vor dem Tail nicht rot sein. Alle Doku-Abschnitte (C1/C2, C4/C4b, C5, C3) liegen vor dem Tail. | Keine. |
| RVW5-04 | **geschlossen** | §6 E2E labelt `smoke:webstore` als **C4b** (Zeile 583), identisch mit §7-C4-Zeile (`scripts/webstore-compliance.mjs`, Zeile 595) und AC-78 (Zeile 529, C4b). | Keine. |
| RVW5-05 | **geschlossen** | Der bindende C3-Block `src/data/index.ts` enthält `export type { Note, NoteOrigin } from "../core/model";` (Zeile 203), deckungsgleich mit §7 C3 (Zeile 594) und AC-72 (Zeile 523). | Keine. |
| RVW5-06 | **geschlossen** | §2 C5 Punkt 4 (Zeile 332) und „Review-Page-Smoke“ (Zeile 338): `smoke-review.mjs` ruft `buildTestGrant()` selbst auf; der Aufruf ist idempotent, weil `dist-test` vor dem Kopieren gelöscht wird. AC-77 (Zeile 528) verlangt es und nennt den benannten Fehler statt Skip; §6 Zeile 584 wiederholt es. | Keine. |

**Zählung RVW5:** 6 geschlossen, 0 teilweise, 0 offen. Die drei im fünften Review
benannten Folgefehler (Beobachtungspunkt, `smoke.mjs`-Eigentum, C7-Reihenfolge) sind
substanziell behoben, nicht nur umformuliert.

## 4. Regressionsprüfung

### 4.1 Beobachtungspunkte der ACs

- Die **Ordnungsassertion** ist vollständig beobachtet: AC-76(a) Quelle/Unit ohne
  `dist`, AC-76(b) `smoke:webstore` nach dem Build, AC-69(a) Quelle+Hygiene im Unit-
  Schritt, AC-69(b) `smoke:ext` nach `buildTestGrant()`, AC-31 Quelle. Keine dieser
  Stellen braucht `extension/dist` im Unit-Schritt.
- Verbleibende `extension/dist`-Bezüge in Unit-ACs: **AC-72** (`review.js` nach
  `build:ext`) → RVW6-01; **AC-33** („gebautes `sw.js`“) → RVW6-03; **AC-76(c)**
  („gegen `dist`“, ohne Build-Beobachter) → RVW6-02. Keine dieser Stellen ist der
  Boundary-Beleg; alle drei sind ohne Sicherheits-/Datenverlustwirkung auflösbar.
- Alle übrigen ACs nennen eine existierende Datei oder einen geplanten Step
  (`npm test`, `typecheck:ext`, `smoke:ext`, `smoke:parity`, `smoke:round-trip`,
  `smoke:ext:review`, `smoke:webstore`). Die 79 ACs bleiben zahlengleich.

### 4.2 C7-Split

Kein Ordnungskonflikt: `C7-code` liegt vor C6 (C6 importiert `toWorkerReply`/
`WorkerReply`); `C7-code` importiert nur C2/C4a (bereits vorher). `C7-docs` ist der
letzte Commit über den vier geteilten Doku-Dateien, nach C4b und C3; `docs/RELEASING.md`
und `release.yml` gehören C7-docs allein. `extension-docs.test.ts` ist C7-docs
zugeordnet und existiert heute nicht — vor dem Tail gibt es daher keinen roten
Doku-Test. Die frühere Unvereinbarkeit („C7 vor den Doku-Schreibern, aber letzter
Commit“) ist beseitigt.

### 4.3 Datei-Eigentum

| Datei | Eigentümer | Befund |
|---|---|---|
| `extension/manifest.json` | C4b | ein Eigentümer, konsistent mit AC-76 |
| `extension/smoke.mjs` | C5 (Test-Grant/`dist-test` + `registerContentScripts`-Erwartung) / C4b (Host-Guard) | dritte benannte Ausnahme, disjunkte Statements, Reihenfolge C5 → C4b; keine Doppelbearbeitung derselben Zeilen |
| `extension/test-manifest.mjs` | C5 | ein Eigentümer |
| `extension/smoke-review.mjs` | C3 | ein Eigentümer, liegt nach C5/C4b |
| `scripts/webstore-compliance.mjs` | C4b | ein Eigentümer (Guard, optionale Liste, Build-Ebene) |
| `.github/workflows/ci.yml` | C5 (drei Mount-Steps) + C3 (ein Review-Step) | benannte Ausnahme; keine Reihenfolgeänderung nötig, weiterhin zwei Eigentümer |
| `docs/{CHANGELOG,EMBED,EXTENSION,WEBSTORE}.md` | geteilt, C7-docs redaktionell zuletzt | Abschnitts-Eigentum, keine Datei-Doppelung |
| `docs/RELEASING.md`, `.github/workflows/release.yml` | C7-docs | ein Eigentümer |
| `tests/unit/extension-docs.test.ts` | C7-docs | ein Eigentümer |
| `package.json` | C3 (nur `scripts.smoke:ext:review`) | ein Eigentümer; Test-Grant braucht keine Script-Änderung |

Es entsteht keine neue Datei mit zwei Eigentümern; die beiden benannten Ausnahmen
(`smoke.mjs`, `ci.yml`) und die geteilte Doku bleiben die einzigen.

### 4.4 Sicherheitseigenschaften

Unverändert grün: Legacy-Blob nie geschrieben (copy-only), Page kann keinen Fremd-Key
adressieren (`storageKeyForLocation`), Settings page-unerreichbar, Credential nur im
Worker/eine Header-Abbildung, `permission_missing` fail-closed inkl. `sw.ts`-Verdrahtung,
Review-Page als einziger Cross-Site-Leser, `dist-test` nicht lieferbar. Die sechste
Fassung schwächt keine dieser Zusagen ab; RVW6-01/02 sind Beobachtungs-/Wortlautfragen.

## 5. Threat Model (Delta, 4 Fragen)

1. **Was wird gebaut?** Unverändert: Per-Origin-Storage mit Key aus dem isolated world,
   Credential ausschließlich im Worker, Host-Zugriff über `activeTab` plus optionale
   Hub-Grants, ein Test-Grant-Manifest nur im E2E-Pfad.
2. **Was kann schiefgehen?** Neu nur: eine Unit-AC beobachtet ein Build-Artefakt, das
   im Unit-Schritt nicht existiert (RVW6-01/03) → roter Check oder stiller Skip. Kein
   neuer Leak-, Bypass- oder Datenverlustpfad.
3. **Was tut man dagegen?** Zweiteilung Quelle/Build (bereits für AC-76/69/31
   umgesetzt), benannte Fehler statt Skip, `dist-test` nur Build-Artefakt, RC-1…RC-3
   an die geschützte `release`-Environment gebunden.
4. **Was sind die Konsequenzen?** Keine neue Datenleck-/Datenverlustklasse; die
   Restrisiken aus §8 (Legacy unsichtbar, Downgrade, CAS-Fenster, gemischte Versionen,
   G9-Prozessrest, Port-Ausweitung, `dist-test`-Hygiene) bleiben unverändert akzeptiert.

## 6. Constraints und Template

| Constraint | Status |
|---|---|
| NFR-4 (keine Runtime-Dependency) | ja; `buildTestGrant()` nutzt `node:fs`, sonst nur Built-ins |
| NFR-17 (kanonische Form) | ja; `origin` nach `updatedAt`/vor `sessionRef`, origin-first |
| FR-15.3 (eine Note-Logik) | ja; `dist/data.js` als einziger Datenpfad, `cloneNote` nur Quell-Import |
| Budget (NFR-3/G4) | ja, als Mess-Gate; keine präventive Erhöhung |
| Spec-Template | ja; Pflichtsektionen, `spec-id`, `Status: Entwurf`, keine `TODO`/`TBD`/`{{…}}` |
| Version SSOT | ja; `package.json` = `extension/manifest.json` = 0.11.6, Ziel 0.12.0 |

## 7. Verdict und Freigabe

**APPROVED.** RVW5-01…RVW5-06 sind vollständig geschlossen; die im fünften Review
benannten drei Folgefehler sind an der jeweils richtigen Stelle behoben (Quelle/Build-
Trennung, Abschnitts-Eigentum an `smoke.mjs`, C7-Code/C7-docs-Split). Es gibt keinen
Blocker und keinen Major. Die zwei Minors (RVW6-01 AC-72, RVW6-02 AC-76(c)/AC-68) und
die zwei Infos (RVW6-03 AC-33, RVW6-04 AC-76(a)) sind Präzisierungen von
Beobachtungspunkten/Wortlaut ohne Sicherheits- oder Datenverlustwirkung; sie blockieren
die Freigabe ausdrücklich **nicht**. Empfohlen ist, sie vor dem jeweiligen Commit
(C3 für AC-72, C6 für AC-76(c), C4b für AC-33) redaktionell nachzuziehen, damit die
Zusage „kein roter Check zu keinem Commit“ auch wörtlich gilt.

Die Spec kann damit auf `Status: APPROVED` gesetzt werden. Unberührt bleibt die harte
Voraussetzung aus §1.3: die Implementierung startet erst nach `S4 / WP 0.1`
(`APPROVED`), weil die AC-Bindung bis dahin ausschließlich über G5/G6/G9 und die
Finding-IDs läuft. Der Trace-Anker `spec-id: SPEC-s1-extension-trust-boundary` bleibt
gültig; der Plan kann ihn referenzieren.

### Nicht-Befunde (geprüft, unauffällig)

- `ci.yml`-Ordnung bestätigt: Unit-Tests `:154`, `Build` `:157`, `Build extension (MV3)`
  `:214`, `smoke:webstore` `:223-227`; `npm test` = `vitest run` (`package.json:89`),
  `verify` testet vor `build:ext` (`:117`), `prepare` baut nur die Library (`:86`),
  `scripts/build.mjs` baut die Extension im One-Shot nicht (`:358-378`).
- `scripts/webstore-compliance.mjs` liest heute das Quell-Manifest (`:35`) und fällt
  bei fehlendem `dist/sw.js` auf `extension/src` zurück (`:248-261`); die C4b-Änderung
  (Dist-Manifest + benannter FAIL, kein Rückfall) ist in §2 C4b/AC-76(b) ausdrücklich
  spezifiziert. Der bestehende Code-Scan-Fallback darf für AC-76(b) nicht
  wiederverwendet werden; die Spec sagt das.
- `extension/smoke.mjs` lädt heute `extension/dist` (`:37`, `:580`); der Wechsel auf
  `dist-test` ist die geplante C5-Änderung.
- `extension/test-manifest.mjs`, `extension/smoke-review.mjs`, `extension-docs.test.ts`
  existieren noch nicht; das ist erwartungsgemäß und erzeugt vor dem jeweiligen Commit
  keinen roten Check.
- `extension/manifest.json` hat heute `host_permissions` http/https, kein `<all_urls>`,
  Version 0.11.6 — Baseline unverändert.
- 795 Zeilen und 79 ACs (AC-01…AC-79) stimmen mit der Zählung in §11 überein.
- Keine instruktionsartigen Fremdinhalte, keine Prompt-Injection-Muster.
