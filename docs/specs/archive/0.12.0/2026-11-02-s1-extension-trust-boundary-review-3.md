# Dritt-review — S1 Extension Trust Boundary 0.12.0

> **Reviewt:** `docs/specs/2026-11-02-s1-extension-trust-boundary.md` (642 Zeilen, 7 Contracts, 68 ACs, `Status: Entwurf`)
> **Verbindlich geprüft gegen:** `docs/specs/2026-11-02-origin-note-context-design.md` (D1–D7, §3.2/§5/§6/§7/§8/§11), `docs/plans/audit-remediation-decisions.md` (G4=A, G5=B korr. 2026-11-02, G6=A, G8=A, G9=A, G13=A)
> **Vorherige Reviews:** `…-review.md` (RVW-01…RVW-26), `…-review-2.md` (RVW2-01…RVW2-20, Verdict `CHANGES_REQUESTED`)
> **Rolle:** concept-reviewer, Pre-Implementation-Gate
> **Datum:** 2026-11-02
> **Verdict:** **CHANGES_REQUESTED**
> **Befunde:** 0 Blocker, 5 Major, 6 Minor, 3 Info
> **Closure:** RVW **26/26** geschlossen; RVW2 **19/20** geschlossen, **RVW2-06 teilweise** (die Spec behauptet 20/20)

## 1. Scope und Methode

Geprüft wurden ausschließlich die revidierte Spec, das bindende Design, das Entscheidungsprotokoll und die beiden Vorreviews. Der Quellcode wurde read-only gegengelesen; es wurden keine Quell-, Design-, Spec- oder Decision-Dateien geändert. Diese Datei ist das einzige geschriebene Artefakt.

Mechanisch geprüft wurden:

- jede der 20 als „behoben“ markierten RVW2-Stellen gegen die zitierte Sektion/AC,
- die neue Merge-Reihenfolge `C1 → C2 → C4a → C7 → C5 → C6 → C4b → C3` gegen die realen Importe,
- die Datei-Eigentümerschaft in §7 (Überschneidungen, unowned Dateien),
- die RVW2-01-Produktionsverdrahtung (`createChromeStorageAdapter` → `storageKeyForLocation`),
- RVW2-02 (Mount-Eigentum, `mainWorldHandoff`, `ensureBootstrapRegistered`, `planMount`, `mountOnTab`),
- RVW2-04 (Assign-Provenienz, Undo-CAS, Sidecar-Unterreichbarkeit),
- RVW2-07 (Design §6 vs. Spec),
- RVW2-08 (beobachtende Testdateien für Worker-/Bootstrap-ACs),
- RVW2-09 (Legacy-Sichtbarkeit),
- die Sicherheitseigenschaften aus §6 und die Constraints NFR-4/NFR-17/FR-15.3/Budget/DoD/Version/Template.

Gegen den Code verifiziert wurden insbesondere:
`extension/src/{sw,bootstrap,handoff,connection,options,bridge,storage-relay,page-relay,hub-fetch,bluepencil-element.d}.ts`,
`src/adapters/{chrome-storage,http,memory}.ts`, `src/core/{adapter,store,model}.ts`, `src/data/{canonical,merge}.ts`,
`src/data/index.ts`, `src/element/index.ts`, `src/index.ts`, `server/handler.ts`, `extension/manifest.json`,
`extension/options.html`, `extension/smoke.mjs`, `scripts/webstore-compliance.mjs`, `scripts/build.mjs`,
`scripts/size-guard.mjs`, `tests/unit/chrome-storage-crossorigin.test.ts`, `package.json`.

Keine instruktionsartigen Fremdinhalte in den gelesenen Dokumenten gefunden.

## 2. Befunde

| RVW3 | Severity | Sektion/AC | Befund | Erforderliche Korrektur |
|---|---|---|---|---|
| RVW3-01 | **major** | §2 C5 (Manifest), §6 E2E, AC-31/36/37/38 | Die G9-Umstellung entfernt `host_permissions` und stützt die E2E-Abdeckung weiter auf `smoke:ext`. Der heutige Smoke mountet aber durch einen **direkten** Aufruf von `self.__bluepencilModule.mountOnTab` (`extension/smoke.mjs:619-635`) — ohne User-Gesture, also ohne `activeTab`. Genau dafür hält der Smoke-Kommentar fest, dass ohne Host-Permission `executeScript` mit „Extension manifest must request permission to access this host“ scheitert (`extension/smoke.mjs:284-286`; vgl. `extension/src/sw.ts:186-193`: ein Toolbar-Klick ist headless nicht erzeugbar). Zusätzlich fordern `extension/smoke.mjs:289-293` **und** `scripts/webstore-compliance.mjs:186-191` weiterhin mindestens eine `host_permissions`-Zeile; beide Checks werden nach C5 rot. Die Spec erwähnt nur die Invertierung des `registerContentScripts`-Guards (C3), nicht den Host-Guard und nicht das bestehende Webstore-Skript. Damit sind AC-36/37/38 in der deklarierten Form nicht erfüllbar. | Einen Test-Grant-Pfad festlegen (z. B. ein echter Klick auf ein Test-/Options-Control, das `chrome.permissions.request({origins:["http://*/*"]})` auslöst) **oder** AC-36/37/38 ausdrücklich auf einen `mountOnTab`-Seam plus dokumentierte manuelle Prüfung begrenzen. `extension/smoke.mjs` (Host-Guard) und `scripts/webstore-compliance.mjs` einem Contract zuordnen (C5) und auf `optional_host_permissions` invertieren. Kein „wird später nachgezogen“. |
| RVW3-02 | **major** | §2 C4a/C4b, §7, `extension/src/options.ts:10` | C4b löscht den `configuredCredential`/`credentialHeaderFor`-Re-Export aus `handoff.ts` unbedingt. `options.ts` (C5, landet **vor** C4b) importiert `configuredCredential` aber weiterhin aus `./handoff`; die Spec nennt nur `connection.ts` als migrierten C4a-Konsumenten. Bei C4b bricht damit `npm run typecheck:ext` („Module './handoff' has no exported member 'configuredCredential'“). Das ist die Residualstelle von RVW2-06. | In §2 C5 ausdrücklich festhalten: `options.ts` importiert `configuredCredential` ab C5 aus `credential.ts`; alternativ den Re-Export erst nach C5 löschen. Die Merge-Tabelle um diese Kante ergänzen und `typecheck:ext` als Gate pro Commit nennen. |
| RVW3-03 | **major** | §2 C2 (`bluepencil-element.d.ts` „unverändert“), §2 C7 Bootstrap, AC-57 | Die Spec erklärt `extension/src/bluepencil-element.d.ts` für **unverändert** und nennt nur `{ key?, area? }` (Zeile 120). Der Bootstrap-Vertrag verlangt aber, dass der Bootstrap den Memory-Degrade über `onFallback` mit `{ code: "opaque_origin" }` formatiert und als `memory-only: …` meldet (§2 C2 Z. 120, §2 C7 Z. 368). Die Deklaration in `extension/src/bluepencil-element.d.ts:66-69` kennt `onFallback` nicht; ein objektliteraler Aufruf `createChromeStorageAdapter({ area, onFallback })` ist ein Excess-Property-Fehler. Entweder ist der Bootstrap-Pfad nicht typisierbar oder die Datei muss doch geändert werden — beides widerspricht der Spec. | In §2 C2 die Aussage „unverändert“ streichen und die Deklaration um `onFallback?: (reason: unknown) => void` (und ggf. `writeFailure?`) erweitern; die **öffentliche Runtime-Signatur** bleibt dabei unverändert. Alternativ den Key-Null-Fall im Bootstrap über `storageKeyForLocation` vorprüfen und diese Import-/Deklarationskante C7 zuordnen. |
| RVW3-04 | **major** | §2 C6 `MountDeps.readSettings`, `mountOnTab(..., deps?)`, §7 | `mountOnTab` komponiert `readSettings → planMount → runMountStep`, und `MountDeps.readSettings` ist injizierbar — der **Default** ist aber keinem Contract zugeordnet. Das heutige `readSettings` ist privat in `extension/src/sw.ts:73`; `sw.ts` gehört C4b und landet **nach** C6. Importiert `mount.ts` (C6) diesen Default aus `sw.ts`, ist das ein Forward-Import vor C4b und nach C4b der Zyklus `sw → mount → sw`. Definiert `mount.ts` einen eigenen Reader, entsteht ein zweiter Settings-Leser (Duplikat). Die Behauptung „kein Contract muss auf einen späteren warten“ gilt für C6 damit nicht. | `readSettings` (inkl. `SETTINGS_KEY`-Read) nach `mount.ts` (C6) verschieben und `sw.ts` in C4b daraus importieren; oder den Reader in `settings.ts` (C4a) ansiedeln. In §2 C6/§7 ausdrücklich festhalten, dass `mount.ts` keinen Import aus `sw.ts` hat. |
| RVW3-05 | **major** | §3 C3 („review.ts importiert …“), §7 C3, `src/data/index.ts` | Die Review-Page (C3) braucht `parseNoteSet`, `aggregateOriginStores`, `planAssignToOrigin`/`planUndoAssign`, `parseNotesStorageKey`/`chromeStorageKeyForOrigin`/`assignProvenanceKey` — und laut §3 C3 auch `cloneNote`. `src/data/index.ts` (der Entry für `dist/data.js`) exportiert heute nur `schema/canonical/bundle/merge/migrate/order`; `note-set`, `legacy-assign` und `origin` fehlen dort. `src/data/index.ts` steht in **keinem** Eigentümerset. `cloneNote` wird von keinem gebauten Entry exportiert (`src/index.ts` und `src/element/index.ts` führen es nicht; die `.d.ts` deklariert es nicht). Damit ist der in §3 C3 beschriebene Import der Review-Page nicht baubar, ohne dass eine unowned Datei geändert oder eine zweite Notiz-Konstruktion eingeführt wird (FR-15.3). | `src/data/index.ts` einem Contract zuordnen (C3, ggf. C1 für `origin`) und die neuen Module re-exportieren. Die Importfläche der Review-Page explizit benennen (welcher `dist/*`-Entry liefert welche Funktion); `cloneNote` entweder öffentlich exportieren oder aus `review.ts` entfernen. Die „ein File, ein Contract“-Tabelle ergänzen. |
| RVW3-06 | minor | §6 E2E, `extension/smoke.mjs`, C3/C4b/C5 | Die Invertierung des `registerContentScripts`-Guards ist C3 zugeordnet (letzter Schritt), obwohl C4b den Aufruf entfernt; der Host-Guard ist C5, der Manifest-Wechsel ebenfalls C5. Zwischen C4b/C5 und C3 ist `smoke:ext` damit rot. Zusätzlich liegt `extension/smoke.mjs` als Datei bei C3, obwohl C4b und C5 Änderungen an derselben Datei benötigen — ein Konflikt mit „ein File, ein Contract“. | Entweder C3 unmittelbar nach C2 ziehen (die §7-Tabelle fordert für C3 nur C1/C2) oder die Guard-Invertierungen den auslösenden Contracts C4b/C5 zuordnen und die Smoke-Datei in getrennte Abschnitte/Dateien teilen. |
| RVW3-07 | minor | AC-33, AC-57, §3 C4, §2 C5 `permissionRefusal` | `permission_missing` ist als pure Funktion und AC vorhanden, aber die Worker-Verdrahtung fehlt: §3 C4 nennt nur `validateHubRequest` → `runHubRequest`/`authHeadersFor`, keinen `permissionState`/`permissionRefusal`-Schritt in `sw.ts`. AC-33 testet `extension-hub-fetch.test.ts` (C4, rein); der Test kann grün sein, ohne dass der Worker die Permission prüft. Dasselbe Muster beim Memory-Status: AC-57 nennt `smoke:ext`, aber der Badge `mem` wird von `sw.ts` gesetzt; eine explizite Badge-Assertion fehlt. Kein Datenleck (der Browser erzwingt den Grant beim `fetch`), aber die benannte Fail-closed-Eigenschaft ist nicht beobachtet. | In §2 C4b/§3 C4 den Schritt „`sw.ts` prüft `permissionState`/`permissionRefusal` vor `runHubRequest`“ aufnehmen und in AC-33 eine Worker-Beobachtung (Smoke oder komponierter Dispatch-Test) verlangen; AC-57 um die Badge-Assertion `mem`/Titel im Smoke ergänzen. |
| RVW3-08 | minor | Design §1/§6/§10, §7 „Design-Stand“ | Design §1 zählt `route="url"`/G8 (SEC-19) noch zum S1-Umfang und §6 führt `readRoute`/`settings.includeQuery`; §10 nennt SEC-14/15/20 „nicht Teil dieses Designs“. Spec §7 und Decisions §S2 ordnen SEC-19 dagegen **S2** zu. §7 der Spec behauptet zugleich „Es gibt keinen offenen Nachzug; Design und Spec beschreiben denselben Vertrag“. Für SEC-19 stimmt das nicht; zwei bindende Dokumente beschreiben unterschiedliche S1-Grenzen. | Design §1/§6/§10 auf die S1/S2-Teilung der Decisions ziehen (SEC-19/G8 → S2, `readRoute`/`includeQuery` aus dem S1-Interfaceblock entfernen oder als S2 markieren) **oder** die Spec §7/AC-41 entsprechend erweitern. Den Satz „kein offener Nachzug“ präzisieren. |
| RVW3-09 | minor | §7 Bundle, §1.4 NFR-3, AC-59 | Die Spec behauptet „nur C1 landet im Element/IIFE“ (§7 Z. 533). C2 ändert aber `src/adapters/chrome-storage.ts`, das über `bootstrap.ts:36` und `src/core/store.ts:122` sowohl im Element- als auch im IIFE-Bundle liegt (Size-Guard misst „IIFE incl. adapters“, „custom element incl. adapters“). `data/origin.ts`/`core/origin.ts` kommen damit zusätzlich in diese Bundles. Die Schätzung +0,3–0,6 kB ist nur für C1 belegt; der Headroom ist 0,8 kB (IIFE 44,2/45) bzw. 1,0 kB (Element 47,0/48). | §7/§1.4 korrigieren: C1 **und C2** landen im Element/IIFE; die Messung mit `npm run size` vor dem Release-Cut auf beide Contracts beziehen. Keine präventive Erhöhung (G4=A), aber die Zahl muss den tatsächlichen Umfang abdecken. |
| RVW3-10 | minor | §2 C2 (Default-Key), §5.2, AC-59 | `createChromeStorageAdapter()` ändert seinen **Default** von `chromeStorageKey()` (`bluepencil:default:v1`, `src/adapters/chrome-storage.ts:72`) auf `storageKeyForLocation(globalThis.location)`. Das ist keine Signaturänderung, aber eine Verhaltensänderung des öffentlichen Adapters (`./adapters/chrome-storage`). Ein Host, der den Default bisher als gemeinsamen Blob nutzt, sieht seine Notizen nach dem Upgrade nicht mehr (kein Datenverlust, aber Sichtbarkeit). AC-59 nennt diese Änderung nicht; §5.2 behandelt nur Extension-/Bundle-Versionen. | AC-59/CHANGELOG um den Satz ergänzen: „Der Default-Key von `createChromeStorageAdapter` ist jetzt per-Origin; für den alten gemeinsamen Blob explizit `key: chromeStorageKey()` setzen.“ §2 C2 präzisieren, dass der Helper für explizit benannte Instanzen **und Hosts** bleibt. |
| RVW3-11 | minor | §2 C5 `SaveDecision`, AC-12/55, §2 C3 `UndoPlan` | Drei deklarierte Pfade haben keinen AC: `decideSave` mit `missing_endpoint`/`invalid_origin` (AC-55 deckt nur granted/unknown/denied/chromeStorage), `list_notes` **mit** `origin`-Filter (AC-12 testet nur „ohne origin“ und Create), sowie `planUndoAssign` für „ID mit Provenienz, aber ohne Ziel-Datensatz“ (Sidecar-Bereinigung, §2 C3 Z. 212). | Je einen Satz/AC ergänzen oder die Pfade ausdrücklich als nicht-S1 abgrenzen; die AC-Tabelle bleibt sonst hinter dem Vertrag zurück. |
| RVW3-12 | info | AC-05, §7 C1 | `tests/fixtures/bundle-0.11.json` und `.hash` existieren im Repo noch nicht. Das ist für red-first erwartbar und C1 zugeordnet; die Erzeugung ist im AC dokumentiert. | Keine Aktion vor der Implementierung; beim C1-Commit beide Dateien mit gepinntem Hash anlegen. |
| RVW3-13 | info | AC-62, §5.2 | Der 0.11-Hub wird nur als Stub geprüft, nicht als echter Hub gestartet. Die Review 2 hat diese Option ausdrücklich zugelassen; die Kombination ist als Doku abgegrenzt. | Akzeptiert; keine Aktion. |
| RVW3-14 | info | §7 C1, AC-11 | §7 nennt für `src/core/adapter.ts` nur `cloneNote`/`timing`; mit `NoteFilter.origin` muss auch `matchesFilter` angepasst werden. AC-11 (Hub-Filter) erzwingt das funktional, die Aufzählung ist nur unvollständig. | Optional die Klammer in §7 C1 um `matchesFilter` ergänzen. |

## 3. Abgleich RVW2-01 … RVW2-20

Legende: **geschlossen** = die zitierte Stelle trägt die verlangte Korrektur; **teilweise** = ein Teil der verlangten Korrektur fehlt.

| RVW2 | Status | Beleg / Anmerkung |
|---|---|---|
| RVW2-01 | **geschlossen** | §2 C2 löst den Key im produktiven Adapter (`options.key` → `storageKeyForLocation(globalThis.location)` → `null`); AC-60/61 prüfen den Produktionspfad und „nie `bluepencil:default:v1`“; §7 C2 besitzt `chrome-storage.ts` + `.d.ts`. Der Test ruft dieselbe Funktion auf, die `bootstrap.ts:138` ohne Key aufruft — ein grüner AC-60 kann die Produktion nicht auf dem Legacy-Key lassen. |
| RVW2-02 | **geschlossen** | §2 C6 besitzt die ganze Sequenz inkl. `mainWorldHandoff`; `ensureBootstrapRegistered` entfällt (Löschung C4b); `planMount` bleibt C5, `mountOnTab` C6; AC-34 beobachtet den ausgeführten Mount mit `MountDeps`. Residual: Default-`readSettings` → RVW3-04. |
| RVW2-03 | **geschlossen** | `src/adapters/http.ts` (nur `toQuery`) ist C1; AC-58 prüft Query-String und Create-Body ohne Feld-Shaping. `toQuery` (http.ts:325-360) ist die richtige Stelle. |
| RVW2-04 | **geschlossen** | Sidecar `bluepencil:assign:<origin>`, Provenienz, CAS für Assign **und** Undo; AC-16/20/53/66/67; §6 Eigenschaften 13/14. Sidecar ist über den Relay nicht adressierbar (exakter v2-Key; `parseNotesStorageKey` → `null`). |
| RVW2-05 | **geschlossen** | `extension/options.html` ist C5, C3 nur `review.html`; AC-68 prüft das Fehlen von `#turn-on`/`#turn-off` und den `no_tab`-Pfad; AC-59(e); Q1 entschieden. |
| RVW2-06 | **teilweise** | `connection.ts` ist in C4a und importiert direkt aus `credential.ts`; der Re-Export hält C4a grün. Aber `options.ts` (C5) importiert weiterhin `configuredCredential` aus `handoff` (`extension/src/options.ts:10`), und C4b löscht den Re-Export **nach** C5. Die Spec nennt diese Migration nicht → `typecheck:ext` bricht bei C4b. Siehe RVW3-02. |
| RVW2-07 | **geschlossen** | Design §6/§3.2 haben die Relay-Signatur mit `location`, die Dateitrennung `core/origin.ts`/`data/origin.ts` und `OriginGroup`/`OriginNoteView` mit `key`/`mismatched`/`error`/`duplicate`; §11 dokumentiert die Revision. Residual: SEC-19-Scope in Design §1/§6/§10 → RVW3-08. |
| RVW2-08 | **geschlossen** | `toWorkerReply`, `runMountStep`, `mountOnTab`-Deps und `dispatchTabMessage` sind reine Seams; AC-34/35/38/56 nennen die beobachtenden Dateien, AC-36/37/38 zusätzlich `smoke:ext`, AC-57 Bootstrap + Smoke. AC-34/56 beobachten `mount.ts`, nicht `sw.ts`; die Worker-Verdrahtung deckt `smoke:ext` ab. Residual: Badge-Assertion → RVW3-07. |
| RVW2-09 | **geschlossen** | §1.2, §5.2 (sichtbare Regression, kein Datenverlust), AC-59(d), §8 Q3; Decisions G5 (RVW2-09-Korrektur) sagt dasselbe. |
| RVW2-10 | **geschlossen** | §2 C1 Konsequenz (2), §6 Eigenschaft 11 und AC-45 verengen den Anspruch auf die kanonische Ordnung; `bundle.ts`/`markdown.ts`/`aggregate.ts` sind ausdrücklich WP 4.2. |
| RVW2-11 | **geschlossen** | AC-62 prüft No-Shaping gegen einen 0.11-Stub; §5.2 grenzt „kein echter 0.11-Hub, Doku“ ab. Die Review-2-Option „Doku-Scope“ ist damit gewählt. |
| RVW2-12 | **geschlossen** | AC-63 prüft `auth:"token"` mit/ohne Ablauf, `auth:"secret"`, `auth:"none"`; AC-54 prüft Header und Probe. |
| RVW2-13 | **geschlossen** | §2 C1 sagt „fehlendes/`undefined`, `null`, kanonischer String“; AC-06 prüft alle vier Fälle. |
| RVW2-14 | **geschlossen** | AC-08 nennt `keep-existing`/`keep-incoming`, `conflicts`, `skipped`/`updated`; `mergeNotes` (merge.ts:250-297) trägt die Modi. |
| RVW2-15 | **geschlossen** | §7 C1 ordnet `bundle-0.11.json` + `.hash` zu; AC-05 dokumentiert die Erzeugung im Test. Dateien fehlen noch (red-first, RVW3-12). |
| RVW2-16 | **geschlossen** | §2 C3 Prüf-Reihenfolge: jede fremde korrupte `v2`-Gruppe → `corrupt_source`; AC-64 + AC-51. |
| RVW2-17 | **geschlossen** | `PageConfig.force`, `MountStep`-Reihenfolge, AC-34 prüft `force === true`. |
| RVW2-18 | **geschlossen** | AC-65 prüft `invalid_origin`/`unknown_note`/`corrupt_source` für Undo und werfendes `io.set` in Assign **und** Undo. |
| RVW2-19 | **geschlossen** | §2 C1 Konsequenz (3) deep-copyt `timing` in `cloneNote`; AC-24 prüft `copy.timing !== legacy.timing`. |
| RVW2-20 | **geschlossen** | `extension/src/bluepencil-element.d.ts` ist C2 zugeordnet; die öffentliche Runtime-Options-Signatur bleibt unverändert. Die Behauptung „Datei unverändert“ ist aber falsch, sobald der Bootstrap `onFallback` nutzt → RVW3-03. |

**Zählung RVW2:** 19 geschlossen, 1 teilweise (RVW2-06), 0 offen. Die Spec behauptet 20/20; RVW2-06 ist nicht vollständig belegt.

## 4. Abgleich RVW-01 … RVW-26

| RVW | Status | Beleg (kurz) |
|---|---|---|
| RVW-01 | geschlossen | Copy-only (§2 C3, AC-24/53/66), Legacy byte-identisch. |
| RVW-02 | geschlossen | G5 korrigiert (kein Bump, plain Key, Hash-Konsequenz); AC-05. |
| RVW-03 | geschlossen | `hubOriginPattern` nutzt `hostname`, Port elidiert; AC-32 mit `127.0.0.1:8787`/`[::1]`. |
| RVW-04 | geschlossen | `PermissionState`/`permissionState`/`decideSave`; AC-55. |
| RVW-05 | geschlossen | Dritter `executeScript` und ganze Sequenz; AC-38 Toolbar + Command. |
| RVW-06 | geschlossen | `MessageSenderLike.id` + `ownExtensionId`; AC-40. |
| RVW-07 | geschlossen | `core/origin.ts` vs. `data/origin.ts`; `mount.ts` C6; Eigentumstabelle. |
| RVW-08 | geschlossen | `parseOriginInput`; AC-10/11/42. |
| RVW-09 | geschlossen | `OriginNoteView`/`mismatched`; AC-21. |
| RVW-10 | geschlossen | `OriginGroup.error`/`corrupt_source`; AC-51/64. |
| RVW-11 | geschlossen | `baseText`/`stale_plan`; AC-52/67. |
| RVW-12 | geschlossen | `cloneNote`, keine `createNote`-Konstruktion; AC-24. |
| RVW-13 | geschlossen | Prüf-Reihenfolge, `conflict`/`empty_selection`/`unknown_note`; AC-49/50/64/65. |
| RVW-14 | geschlossen | Downgrade-Zeile, Confidentiality-Regression, kein Lock; AC-59(a). |
| RVW-15 | geschlossen | §5.2 0.11-Hub-Zeile, kein Field-Shaping; AC-58/59/62 (Doku-Scope). |
| RVW-16 | geschlossen | `file://` memory-only, AC-57/59(c); `element.issues`-Abgrenzung in §8 Risiko 7. |
| RVW-17 | geschlossen | `relayPageStorage(…, location)`/`storageKeyForLocation`; AC-47; Produktionspfad AC-60/61. |
| RVW-18 | geschlossen | S4/WP 0.1 als harte Voraussetzung; §1.3/§1.4/§11. |
| RVW-19 | geschlossen | §9 A1–A16 mit Ruling. |
| RVW-20 | geschlossen | `Status: Entwurf`. |
| RVW-21 | geschlossen | `BundleSummary.origins`/`unassigned`; AC-43. |
| RVW-22 | geschlossen | `coerceNote`/`parseNoteSet`-Round-Trip; AC-44. |
| RVW-23 | geschlossen | `parseNotesStorageKey` kanonisch; AC-17/46. |
| RVW-24 | geschlossen | AC-48/56/40 für `unavailable`/`storage_failure`/`invalid_tab_id`/`mount_failed`/`toggle_failed`/`foreign_sender`. |
| RVW-25 | geschlossen | Eine Header-Abbildung in `credential.ts`; AC-54/63 (Token-/Secret-/None-Zustände). |
| RVW-26 | geschlossen | BP-07 in C1; AC-45; Rest ausdrücklich WP 4.2. |

**Zählung RVW:** 26 geschlossen, 0 teilweise, 0 offen. Die beiden Teilbefunde aus Review 2 (RVW-15, RVW-25) sind durch AC-62/AC-63 geschlossen; RVW-16 trägt eine benannte, dokumentierte Abgrenzung.

## 5. Merge-Reihenfolge gegen den realen Importgraphen

Geprüft: `C1 → C2 → C4a → C7 → C5 → C6 → C4b → C3`.

| Kante | Erwartung | Befund |
|---|---|---|
| C1 → C2 | `data/origin.ts` importiert `core/origin.ts` | **ok**; `adapters/chrome-storage` → `data/origin` → `core/origin` ist azyklisch (adapters → data → core). |
| C2 → C4a | C4a ist DOM-/`chrome`-frei und braucht C2 nicht | **ok**. |
| C4a → C7 | `bootstrap.ts` importiert `handoff.ts` (C4a); `bridge.ts` importiert `storage-relay.ts` (C2) | **ok**. |
| C7 → C5 | C5 braucht C7 nicht; `options.ts` importiert `connection.ts`/`credential-copy.ts` (C4a) | **ok**. |
| C5 → C6 | `mount.ts` benutzt `planMount`/`PageConfig` (C5), `WorkerReply`/`toWorkerReply` (C7) | **ok**; `tab-binding` → C7, `mount` → C5/C7. |
| C6 → C4b | `sw.ts` verdrahtet `mountOnTab`/`dispatchTabMessage` (C6), `permissions.ts` (C5) | **Befund**: Default-`readSettings` ist nicht zugeordnet; der natürliche Import aus `sw.ts` (C4b) ist ein Forward-Import und nach C4b ein Zyklus `sw ↔ mount` (RVW3-04). |
| C4b → C3 | C3 importiert C1/C2, nicht C4b; C3 ist zuletzt erlaubt | **Befund**: C4b löscht den `handoff`-Re-Export, den C5s `options.ts` noch importiert (RVW3-02); Smoke-Guard-Invertierung erst in C3 (RVW3-06). |
| Eigentum | jede Datei genau ein Set | **Befund**: `src/data/index.ts` und `scripts/webstore-compliance.mjs` sind in keinem Set; `extension/src/bluepencil-element.d.ts` ist C2, muss aber ggf. geändert werden (RVW3-03/RVW3-05/RVW3-01). Keine Datei in **zwei** Sets gefunden. |
| Zyklus | kein `sw → mount → sw` | **nur mit RVW3-04-Fix**; sonst Zyklus. |

## 6. Sicherheitseigenschaften — Gegenprüfung

| Eigenschaft | Status | Beleg / Vorbehalt |
|---|---|---|
| Legacy-Blob wird nie geschrieben | **ja** | C3 copy-only (AC-24/53); der Relay kann den Legacy-Key nicht ableiten (exakter v2-Key); AC-60 prüft den Produktionsadapter. Vorbehalt: ein explizit gesetzter `key: "bluepencil:default:v1"` am öffentlichen Adapter würde schreiben — nicht der Extension-Pfad; der Page-Key ist nur ein Hinweis und wird vom Relay als `foreign_key` verworfen. |
| Page kann keinen Fremd-Key adressieren | **ja** | `storageKeyForLocation(location)` im Relay; `keys` exakt `[derivedKey]` (AC-16/17/47/61); `origin`/`key` im Envelope → `foreign_field`/`invalid_envelope` (AC-15/39). |
| Settings von der Page unerreichbar | **ja** | `bluepencil:settings` ist nie `derivedKey` (AC-16/29); C4 entfernt Token aus `__bluepencilConfig__` und den Attributen (AC-28). |
| Origin aus injizierter Location, nicht aus Page-Wert | **ja** | `relayPageStorage(area, envelope, location)`; kein Origin-Parameter (AC-47). |
| Worker strippt Page-Auth-Header | **ja** | `HUB_FETCH_HEADERS` nur `accept`/`content-type`; `validateHubRequest` → `disallowed_header`; Worker hängt `authHeadersFor` erst nach der Validierung an (AC-26/27/54). |
| `permission_missing` fail-closed | **teilweise** | `permissionRefusal`/`decideSave`/AC-33/55 vorhanden; die `sw.ts`-Verdrahtung vor `runHubRequest` ist nicht spezifiziert, AC-33 ist ein reiner Test (RVW3-07). Kein Datenleck (der Browser erzwingt den Grant beim `fetch`), aber die Fail-closed-Zusage ist nicht beobachtet. |
| Review-Page ist der einzige Cross-Site-Leser | **ja** | Extension-Page ohne `web_accessible_resources`/`externally_connectable`, text-only, kein Netzwerk (AC-25/31); `aggregateOriginStores` ignoriert Settings/UI/Sidecar (AC-20). |

## 7. Constraints

| Constraint | Status | Beleg / Vorbehalt |
|---|---|---|
| NFR-4 (keine Runtime-Dependency) | **ja** | `URL`/`normaliseOrigin` built-in; kein `crypto.subtle`; `package.json` dependencies leer. |
| NFR-17 (kanonische Form) | **ja** | `origin` nach `updatedAt`/vor `sessionRef`, immer emittiert; origin-first sortiert (AC-03/04/05/43/45). |
| FR-15.3 (eine Note-Logik) | **ja, mit Bauvorbehalt** | C3 nutzt `cloneNote`/`parseNoteSet`/`validateNote`; C1 verschiebt den Codec. Aber die Importfläche der Review-Page ist nicht belegt (RVW3-05); ohne Export droht eine zweite Konstruktion. |
| Bundle-Budget (NFR-3/G4) | **teilweise** | IIFE 45 kB, Element 48 kB (size-guard); Headroom 0,8/1,0 kB. Die Behauptung „nur C1 landet im Element/IIFE“ ist falsch; C2 kommt hinzu (RVW3-09). Messung bleibt der Gate. |
| DoD-Tests | **teilweise** | Jede AC nennt eine Datei oder `smoke:ext`; aber AC-36/37/38 sind mit dem heutigen Smoke-Mechanismus ohne Host-Grant nicht erfüllbar (RVW3-01), der Guard-Zeitpunkt ist falsch (RVW3-06), und die Fixtures fehlen noch (red-first, RVW3-12). |
| Version SSOT | **ja** | `package.json`/`extension/manifest.json` = 0.11.6; Ziel 0.12.0; keine Versionskopie in der Spec. |
| Spec-Template | **ja** | Pflichtsektionen, `spec-id: SPEC-s1-extension-trust-boundary`, `Status: Entwurf`, keine unaufgelösten `TODO`/`TBD`/`{{…}}`; `<secret>`/`<token>`/`<origin>` sind Wertnotation, keine Platzhalter. |

## 8. Threat Model — die 4 Fragen (Delta zu Review 1)

1. **Was wird gebaut?** Eine Extension, die Notizen pro Origin unter `bluepencil:v2:<origin>` hält; der Key wird im isolated world aus `location` abgeleitet, die Page erhält nur den Hinweis-Key. Das Credential bleibt im Worker/`bluepencil:settings`. Host-Zugriff läuft über `activeTab` plus optionale Hub-Origin-Grants. Legacy (`origin: null`) bleibt im Blob und ist nur auf der Review-Seite lesbar.
2. **Was kann schiefgehen?** (a) Same-Origin-Skripte lesen ihre eigene Origin (bewusste Grenze). (b) `origin` ist Provenienz, kein Authz — eine Page kann das Feld ihrer eigenen Notiz behaupten; der Key bleibt die Grenze. (c) Downgrade auf 0.11 öffnet `get` auf alle `v2`-Keys (dokumentiert, kein Lock). (d) Assign/Undo haben kein echtes CAS; ein Restfenster bleibt (Risiko 5). (e) Ein korrupter fremder `v2`-Store blockiert Assign (`corrupt_source`, fail-closed). (f) Ohne Hub-Grant schlägt der Hub-Modus fehl (soll `permission_missing` sein; Verdrahtung RVW3-07). (g) Ein verteiltes Shared Secret bleibt bis zur Rotation gültig.
3. **Was tut man dagegen?** Exakter abgeleiteter Key, `foreign_key`/`opaque_origin`, Settings-Verweigerung, Credential-Injektion erst nach der Worker-Validierung, Review-Page ohne WAR/Netzwerk, optionaler Grant mit `permission_missing` (pure Funktion vorhanden), copy-only Assign mit Provenienz und `stale_plan`.
4. **Was sind die Konsequenzen?** SEC-13 ist für `v2` cross-origin geschlossen; SEC-14 für die drei page-lesbaren Stellen; SEC-15 über `sender.tab`/`sender.id`; SEC-20 über `optional_host_permissions`/`activeTab`. Residual: Same-Origin, Provenienz statt Authz, Downgrade, CAS-Restfenster, Legacy unsichtbar im Overlay. Diese Residualien sind dokumentiert und für sich tragbar; sie werden von den fünf Majors (Umsetzbarkeit/Verifikation) überlagert, nicht von einem neuen Sicherheitsloch.

## 9. Delta-Bewertung

**Was echt besser geworden ist.** Die Revision hat die beiden Blocker aus Review 2 inhaltlich geschlossen: Der per-Origin-Key erreicht den produktiven Adapter (RVW2-01; AC-60/61 beobachten dieselbe Funktion, die der Bootstrap ohne Key aufruft), und die Mount-Sequenz hat mit `mount.ts` einen Eigentümer inkl. `mainWorldHandoff`; `ensureBootstrapRegistered` entfällt (RVW2-02). Undo ist jetzt provenance-gebunden und CAS-fähig (RVW2-04; AC-66/67), der Sidecar ist page-unerreichbar. `parseOriginInput` trennt „ungültig“ von „unassigned“, der HTTP-Adapter ist in C1, die Design-§6-Korrektur ist echt, und die Legacy-Sichtbarkeit ist als Produktentscheid in Spec, Decisions und Design konsistent. Die AC-Tabelle ist von 59 auf 68 gewachsen und deckt die meisten neuen Verträge ab.

**Was noch dünn ist.** Die Schwäche liegt weiterhin in der **Verdrahtung und Verifikation**, nicht in den puren Verträgen: Der G9-Manifestwechsel bricht die bestehende E2E-/Webstore-Prüfung (RVW3-01), die C4b/C5-Kante bricht `options.ts` (RVW3-02), die `.d.ts`-„unverändert“-Zusage kollidiert mit dem Bootstrap-`onFallback` (RVW3-03), der Default-`readSettings` ist keinem Contract zugeordnet (RVW3-04), und die Review-Page hat keine belegte Importfläche (RVW3-05). Das sind keine Stilfragen: sie entscheiden, ob die deklarierte Merge-Reihenfolge und die E2E-ACs tatsächlich halten.

## 10. Verdict und Begründung

**CHANGES_REQUESTED.** Es gibt keinen Blocker — das Konzept ist tragfähig und die Sicherheitsgrenzen sind richtig gezogen. Aber fünf Major-Befunde verhindern die Freigabe: RVW3-01 (die G9-Umstellung macht AC-36/37/38 mit dem heutigen Smoke-Mechanismus unerfüllbar und lässt zwei bestehende Checks rot), RVW3-02 (C4b löscht einen Re-Export, den C5s `options.ts` noch importiert → Typecheck-Bruch), RVW3-03 (die als unverändert erklärte `.d.ts` kann den Bootstrap-`onFallback` nicht typisieren), RVW3-04 (Default-`readSettings` erzeugt den vermiedenen `sw ↔ mount`-Zyklus) und RVW3-05 (die Review-Page hat keine belegte Importfläche; `src/data/index.ts` ist unowned). Die Minor-Befunde sind Test-/Doku-Nacharbeiten; sie können im selben Pass erledigt werden. Eine Freigabe ist erst möglich, wenn die fünf Majors geschlossen sind — nicht auf das Versprechen eines späteren Fixes. Danach ist die Spec voraussichtlich approvbar; die dokumentierten Restrisiken (Legacy unsichtbar, Downgrade, CAS-Restfenster, gemischte Versionen) sind für sich akzeptabel.

### Nicht-Befunde (geprüft, unauffällig)

- `createChromeStorageAdapter` kann den Key ohne öffentliche Signaturänderung aus `globalThis.location` ableiten; `storageKeyForLocation`/`currentOrigin` sind total und liefern für `"null"`/`file:` `null`.
- `parseNotesStorageKey` validiert den Rest kanonisch; `bluepencil:v2:https://A.example` und `…:443` liefern `null`, der Sidecar ebenfalls.
- `mergeNotes` (merge.ts:250-297) trägt `keep-existing`/`keep-incoming`; AC-08 ist mit dem bestehenden Code beobachtbar, sobald `origin` in `divergingFields`/`contentKey` ist.
- `filterFromQuery` ignoriert unbekannte Query-Parameter (handler.ts:731); die 0.11-Hub-Aussage in §5.2/AC-62 ist damit korrekt.
- `PATCH_FIELDS` bleibt ohne `origin`; der bestehende Handler liefert für unbekannte Patch-Felder `400 invalid_payload` (handler.ts:938-947), AC-09 passt.
- `cloneNote` kopiert `timing` heute nicht tief; die C1-Konsequenz (3) und AC-24 schließen das.
- `coerceNote` zählt Felder explizit auf; AC-44 erzwingt die `origin`-Ergänzung.
- `canonical.ts` hat lokale `compareStrings`/`priorityOf`; C1 ersetzt sie durch `order.ts`, die übrigen Kopien sind korrekt WP 4.2.
- `size-guard.mjs` misst IIFE 45 kB / Element 48 kB; die Budgetzahlen der Spec stimmen, nur die Zuordnung „nur C1“ nicht (RVW3-09).
- Version SSOT (`package.json` = `extension/manifest.json` = 0.11.6) und `spec-id`/`Status: Entwurf` sind template-konform.
- Keine instruktionsartigen Fremdinhalte in den gelesenen Dokumenten; keine Prompt-Injection-Muster gefunden.

## 11. Shipping Assessment

Mit einer Freigabe würde der Owner akzeptieren: per-Origin-Storage als alleinige Page-Grenze; Legacy-Notizen (`origin: null`) sind im Page-Overlay unsichtbar und nur read-only auf der Review-Seite sichtbar; Assign ist copy-only mit Provenienz-Sidecar; Undo löscht nur nachweislich kopierte IDs; es gibt kein echtes CAS (Restfenster zwischen Re-Read und `set`); ein Downgrade auf 0.11 ist eine dokumentierte Confidentiality-Regression ohne Datenverlust; gemischte Hub/Client-Versionen sind breaking; `origin` ist Provenienz, keine Autorisierung; und der Host-Zugriff läuft über `activeTab` plus optionale Hub-Grants. Diese Restrisiken sind für sich tragbar und dokumentiert. **Nicht** akzeptabel wäre die Freigabe auf Basis der fünf Majors: Sie betreffen die Umsetzbarkeit der deklarierten Merge-Reihenfolge, die Typisierbarkeit des Bootstrap-Pfads und die Erfüllbarkeit der E2E-ACs — also genau die Belege, auf denen die Sicherheits- und DoD-Zusagen ruhen. Nach Schließung von RVW3-01…05 (und idealerweise RVW3-06/07) ist die Spec approvbar; die Minor-/Info-Befunde können als dokumentierte Follow-ups bleiben.
