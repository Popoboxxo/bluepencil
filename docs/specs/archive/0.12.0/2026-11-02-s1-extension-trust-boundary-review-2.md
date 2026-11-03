# Zweitreview — S1 Extension Trust Boundary 0.12.0

> **Reviewt:** `docs/specs/2026-11-02-s1-extension-trust-boundary.md` (514 Zeilen, 7 Contracts, 59 ACs, `Status: Entwurf`)
> **Verbindlich geprüft gegen:** `docs/specs/2026-11-02-origin-note-context-design.md` (D1–D7), `docs/plans/audit-remediation-decisions.md` (G4=A, G5=B korr. 2026-11-02, G6=A, G8=A, G9=A, G13=A; RVW-01/14/15/16)
> **Erstreview:** `docs/specs/2026-11-02-s1-extension-trust-boundary-review.md` (RVW-01…RVW-26)
> **Evidenz:** `docs/reviews/system-audit-2026-11-02.md` (SEC-13/14/15/19/20/21, CQ-05/06)
> **Rolle:** concept-reviewer, Pre-Implementation-Gate
> **Datum:** 2026-11-02
> **Verdict:** **CHANGES_REQUESTED**
> **Befunde:** 2 Blocker, 7 Major, 9 Minor, 2 Info

## 1. Scope und Methode

Geprüft wurden ausschließlich die revidierte Spec, der Erstreview, das bindende Design, das
Entscheidungsprotokoll und der Audit. Der Quellcode wurde read-only gegengelesen, um die
AC-Testbarkeit, die Datei-Eigentümerschaft, die Merge-Reihenfolge und die behaupteten
Sicherheitseigenschaften zu verifizieren; es wurden keine Quell-, Design- oder Spec-Dateien
geändert.

Mechanisch geprüft wurden insbesondere:

- der Abgleich `RVW-01…RVW-26` gegen die jeweils zitierte Sektion/AC,
- jede AC-Testdatei gegen die Testliste in §6 und die Datei-Eigentümerschaft in §7,
- die neue Merge-Reihenfolge `C1 → C2 → C6 → C7 → C4a → C5 → C4b → C3`,
- `src/adapters/http.ts` (`toQuery`), `src/adapters/chrome-storage.ts` (Default-Key),
  `src/data/{canonical,merge,schema,bundle}.ts`, `src/core/{model,adapter}.ts`,
  `extension/src/{bootstrap,sw,handoff,connection,options,storage-relay,bridge}.ts`,
  `extension/manifest.json` und `extension/options.html`.

## 2. Befunde

| RVW2 | Severity | Sektion/AC | Befund | Erforderliche Korrektur |
|---|---|---|---|---|
| RVW2-01 | **blocker** | §2 C2, §3 C2(6), §7 | Der per-Origin-Key erreicht den produktiven Adapter nicht. `createChromeStorageAdapter()` bleibt ohne `key` auf `chromeStorageKey()` = `bluepencil:default:v1` (`src/adapters/chrome-storage.ts:28-31,69-73`); `bootstrap.ts` ruft `createChromeStorageAdapter({ area })` ohne Key (`extension/src/bootstrap.ts:136-139`). Die einzige in der Spec genannte Integration ist „Bootstrap registriert den Adapter nur bei non-null Key“ (§3 C2(6)) — `bootstrap.ts` gehört aber C7 (später), nicht C2. AC-19 kann mit expliziten Keys im Unit-Test grün sein, während die Produktion den Legacy-Key adressiert und der Relay jeden Schreibvorgang als `foreign_key` ablehnt (Memory-Degrade, kein Persistieren). | Die Key-Ableitung in eine C2-eigene Datei legen: entweder `createChromeStorageAdapter` selbst aus `storageKeyForLocation(globalThis.location)` ableiten (explizites `key` gewinnt weiterhin), oder `bootstrap.ts` C2 zuordnen und die Merge-Reihenfolge anpassen. AC ergänzen: produktiver Adapter liest/schreibt nie `bluepencil:default:v1`, sondern `bluepencil:v2:<origin>`; Page auf A schreibt nicht in den Bucket von B. |
| RVW2-02 | **blocker** | §2 C6, §3 C5/C6, §7, AC-34/37/38 | `mount.ts` (C6) ist „einziger Eigentümer von `mountOnTab`“, aber die Mount-Sequenz benötigt `mainWorldHandoff` und `ensureBootstrapRegistered` (aktuell `extension/src/sw.ts:55-70,110-126` = C4) und `planMount`/`PageConfig` (§2 C5, `mount-plan.ts`). C6 landet **vor** C5 und C4. Ein Import aus `sw.ts` erzeugt den Zyklus `sw → mount → sw`; ein Nachbau wäre eine zweite Implementierung. AC-34/37/38 sind unter dieser Reihenfolge nicht umsetzbar. | Die gesamte Mount-Sequenz (inkl. Handoff/Registration) C6 zuordnen und die Helper aus `sw.ts` dorthin verschieben; `C5` vor `C6` ziehen oder `planMount` nach C6 legen. §7 um jede bewegte Datei/Helper ergänzen. AC-34 muss den ausgeführten Mount (`mountOnTab`/Worker) beobachten, nicht nur `planMount`. |
| RVW2-03 | major | §7 C1, AC-58 | `src/adapters/http.ts` fehlt in jedem Eigentümerset. `toQuery` (`src/adapters/http.ts:325-360`) forwarded kein `origin`; AC-58 verlangt aber `GET /notes?origin=<wert>`. Der Create-Body trägt `origin` nur, weil der Draft durchgereicht wird — die Liste kann den Filter nicht senden. | `src/adapters/http.ts` (nur `toQuery`/Origin-Feld) C1 zuordnen oder einen eigenen kleinen Contract dafür ausweisen; AC-58 um den tatsächlichen Query-String und den Create-Body erweitern. |
| RVW2-04 | major | §2 C3, AC-53 | Undo ist ID-basiert und hat keine Provenienz. Ein Duplikat, das beim Assign **übersprungen** wurde (ID lag bereits im Ziel-Store), ist nach einem Reload nicht von einer echten Kopie unterscheidbar; `planUndoAssign({ids:[…]})` würde die vorbestehende Ziel-Notiz löschen. Zusätzlich hat Undo — anders als `commitAssign` — keinen `baseText`/CAS-Vergleich: ein konkurrierender Ziel-Schreibvorgang zwischen Plan und Write kann verloren gehen. | Assign-Provenienz persistieren (z. B. Sidecar-Key `bluepencil:assign:<origin>` mit ID→Zeitstempel oder ein `assignedAt`-Marker ohne Schema-Bump) und Undo nur für nachweislich kopierte IDs anbieten; Undo ebenfalls als Compare-and-Set auf den Ziel-Blob auslegen (`stale_plan`). ACs ergänzen: „ID war vor Assign im Ziel → Undo löscht nichts“ und „konkurrierender Ziel-Write → `stale_plan`, kein Datenverlust“. |
| RVW2-05 | major | §2 C5, §7, §8 Q1 | Q1 („Buttons entfernen“) ist die richtige Entscheidung — ohne `tabs`-Permission und ohne `sender.tab` liefert C6 für einen Options-Page-Toggle `no_tab` —, aber die Buttons stehen in `extension/options.html:264-265`, das C3 gehört („Link“), während C5 (Eigentümer von `options.ts`) **vor** C3 landet. C5 kann die HTML-Buttons nicht entfernen; bliebe die HTML stehen, wären sie tote UI. | `options.html` für die Button-Entfernung C5 geben und C3 nur den Review-Link; oder die Entfernung C3 zuordnen und dort als letzten Schritt führen. AC ergänzen, dass die Buttons nicht mehr existieren und kein `toggle`-Pfad ohne `tabId` übrig bleibt. |
| RVW2-06 | major | §2 C4a/C4b, §7 | `connection.ts` (C4) importiert `configuredCredential`/`credentialHeaderFor` aus `handoff.ts` (`extension/src/connection.ts:22`), `options.ts` (C5) importiert `configuredCredential` aus `handoff.ts` (`extension/src/options.ts:10`). C4a ist aber nur als `credential.ts`/`handoff.ts`/`credential-copy.ts` definiert; `connection.ts` fehlt in C4a und C4b. Entfernt `handoff.ts` die Exporte (der Contract nennt sie nicht mehr), bricht C4a den Typecheck; `options.ts` bricht bis C5. | `connection.ts` in C4a aufnehmen (es ist DOM-/`chrome`-frei) **oder** `handoff.ts` in C4a die beiden Funktionen aus `credential.ts` re-exportieren lassen und den Re-Export in C4b entfernen. Die Merge-Reihenfolge in §7 entsprechend präzisieren. |
| RVW2-07 | major | §7 „Hinweis zur Design-Datei“, Design §6 | Das bindende Design §6 nennt weiterhin `relayPageStorage(area, envelope, origin)`, ein einziges `src/data/origin.ts` und ein `OriginGroup` ohne `key`/`mismatched`/`error`/`duplicate`; die Spec verschiebt das in einen „Folge-Pass“. Die Spec erklärt das Design in ihrem Header für verbindlich. Damit stünden bei einer Freigabe zwei widersprüchliche Upstream-Dokumente nebeneinander; der Hinweis ist eine Ankündigung, kein Ersatz. | Design §6 vor der Freigabe korrigieren (Relay-Signatur, Dateitrennung, `OriginGroup`/`OriginNoteView`) und eine datierte Revision (`RVW-07/09/10/13/17`) in Design §11 ergänzen — oder eine datierte Errata-Entscheidung aufnehmen, die §6 ausdrücklich ersetzt. Ein „wird später nachgezogen“ ist kein Approval-Grund. |
| RVW2-08 | major | AC-34/35/56/57, §6 Eigenschaften 9/10 | Mehrere ACs behaupten Worker-/Bootstrap-Verhalten, benennen aber reine Modultests: AC-34 (`no registerContentScripts`, `__bluepencilTryMount`-Lebensdauer) → `extension-mount-plan.test.ts` (C5, `planMount` ist rein); AC-35 (`onMessage` ruft kein `tabs.query`) → `extension-tab-binding.test.ts` (C6, `resolveTabTarget` ist rein); AC-56 (`WorkerReply`-Codes `mount_failed`/`toggle_failed`) → `extension-mount-errors.test.ts` (C6, `mountOnTab` liefert `MountResult`, nicht `WorkerReply`); AC-57 („memory-only im UI-Status/`element.issues` sichtbar“) → `extension-storage-relay.test.ts`/`extension-mount-plan.test.ts`, die den Bootstrap-Status nicht beobachten. `sw.ts`/`bootstrap.ts` bleiben damit ungetestet (CQ-05). | Reine Seams einführen (`toWorkerReply`, `planMountStep`-Executor, `mountOnTab`-Adapter) und diese teste; die Bootstrap-Hook-Lebensdauer und den Memory-Status über `smoke:ext` oder einen neuen Bootstrap-Test prüfen. Die AC-Tabelle auf die tatsächlich beobachtende Datei umstellen. |
| RVW2-09 | major | §5.2, AC-59, Decisions G5 vs. Design D5 | §5.2 markiert „Extension 0.11 → 0.12“ als „ok“, ohne die sichtbare Regression zu nennen: 0.12 liest `bluepencil:default:v1` nicht mehr (C2 verweigert den Key), Legacy-Notizen erscheinen nur noch auf der Review-Seite. Decisions G5 sagt „im Page-Kontext read-only“, Design D5 sagt „in der Page unsichtbar“ — die Spec löst den Widerspruch nicht und AC-59 fordert keine Doku dazu. | Verhalten entscheiden und dokumentieren: entweder Legacy im Page-Kontext bewusst unsichtbar (D5) und G5-Wortlaut korrigieren, oder einen read-only-Legacy-Lesezugriff im Page-Kontext vorsehen. In beiden Fällen §5.2 und AC-59 um den Satz „Legacy-Notizen erscheinen nach dem Upgrade nicht mehr im Page-Overlay“ ergänzen. |
| RVW2-10 | minor | §2 C1, §6 Eigenschaft 11, AC-45 | RVW-26 ist für BP-07 geschlossen (`compareCodeUnits`/`reviewPriority` in `canonical.ts`), aber §6 Eigenschaft 11 behauptet „eine Comparator-Quelle“. `src/data/bundle.ts:46-50`, `src/core/export/markdown.ts:266` und `src/federation/aggregate.ts:413` behalten eigene Code-Unit-Vergleiche; C1 entfernt nur die `canonical.ts`-Kopie. Die partielle Dedupe ist als Wave 4/WP 4.2 vertretbar, die Behauptung nicht. | §6/§2 auf „kanonische Ordnung nutzt eine Comparator-Quelle“ präzisieren; die verbleibenden Kopien ausdrücklich Wave 4/WP 4.2 zuordnen. |
| RVW2-11 | minor | §10 RVW-15, AC-58 | RVW-15 ist nur teilweise geschlossen: §5.2 dokumentiert „breaking“ korrekt, aber AC-58 testet einen generischen Hub, nicht den 0.11-Hub. Der im Erstreview verlangte AC für `POST /notes` (400 unknown field) und `GET /notes?origin=` (Filter ignoriert) fehlt. | 0.11-Hub-Fixture/Test ergänzen oder AC-58 ausdrücklich als „nur No-Shaping, 0.11-Kombination ist Doku“ abgrenzen. |
| RVW2-12 | minor | §10 RVW-25, AC-30/54 | RVW-25 ist nur teilweise geschlossen: die eine Header-Abbildung und `auth:"none"` sind abgedeckt, aber `credentialCopy` wird nur für `auth:"secret"` getestet (AC-30); der Token-Modus (Label, Hint, `state` mit/ohne Ablauf) hat keinen AC. | AC-30/54 um `auth:"token"` und `credentialCopy`-Token-Zustände erweitern. |
| RVW2-13 | minor | §2 C1, AC-06 | Der Prosa-Satz zu `validateNote` sagt „nur `null` oder ein String …“, AC-06 verlangt aber auch für **fehlendes** `origin` ein leeres Issue-Array. `undefined` ist nicht genannt; eine Implementierung könnte das optionale Feld ablehnen. | `validateNote` akzeptiert `undefined`/fehlend, `null` und kanonische Strings; Prosa an AC-06 angleichen. |
| RVW2-14 | minor | AC-08, §2 C1 Merge | `mergeNotes` im Modus `upsert` liefert bei abweichendem `origin` einen unaufgelösten Konflikt und wirft ohne `onConflict` (`src/data/merge.ts:276-296`). AC-08 sagt nur „mergeNotes upsert“; „bestehender Origin bleibt“ bzw. „Origin wird übernommen“ ist damit nicht beobachtbar. | AC-08 um `onConflict: "keep-existing"` (erster Fall) bzw. `"keep-incoming"` (zweiter Fall) oder `dryRun` und die erwarteten `conflicts` ergänzen. |
| RVW2-15 | minor | AC-05 | `fixtures/bundle-0.11.hash` existiert im Repo nicht; die AC nennt eine Testdatei, die erst erzeugt werden müsste. | Fixture anlegen (0.11-Bundle + gepinnter Hash) oder die Erzeugung im Test dokumentieren; C1 zuordnen. |
| RVW2-16 | minor | §2 C3 `planAssignToOrigin`, AC-49/51 | Die Konfliktprüfung liest „andere v2-Stores“; ist ein solcher Store korrupt, kann sie die ID dort nicht erkennen und übersieht den Konflikt. AC-51 deckt nur Legacy- und Ziel-Blob ab. | Entweder alle v2-Gruppen parsen und bei korrupter Fremdgruppe `corrupt_source` liefern oder die Review-Page den Assign bei jeder korrupten Gruppe sperren lassen; AC ergänzen. |
| RVW2-17 | minor | §2 C5 `planMount` | `planMount` nimmt `force`, aber `MountStep`/`PageConfig` transportieren es nicht. Der Config-Schritt kann nicht wissen, ob `force` gesetzt war; `mountOnTab` müsste es erneut durchreichen. | `force` in den Config-Schritt oder `PageConfig` aufnehmen und in AC-34 prüfen. |
| RVW2-18 | minor | §2 C3 `planUndoAssign` | Die Fehlercodes `invalid_origin`, `unknown_note`, `corrupt_source` sind im Vertrag deklariert, aber kein AC deckt sie ab; `AssignCommitResult.storage_failure` ist ebenfalls ungetestet. | Je einen AC für die drei Plan-Fehler und für einen werfenden `io.set` in `commitAssign` ergänzen. |
| RVW2-19 | info | §2 C4 `cloneNote`/C3 | `cloneNote` (`src/core/adapter.ts:81-89`) kopiert `timing` nicht tief; die Assign-Kopie teilt das Timing-Objekt mit der Legacy-Notiz. Heute mutiert niemand Timing, aber die „vollständige Note-Gleichheit“ ist nur lesend belastbar. | `timing` in `cloneNote` deep-copien oder im Contract ausdrücklich als unveränderlich markieren. |
| RVW2-20 | info | §7 Datei-Eigentum | `extension/src/bluepencil-element.d.ts` steht in keinem Eigentümerset. Wenn C2 `onFallback`/`writeFailure` in den Adapter-Optionen ergänzt (für AC-57 sichtbar), muss die Deklaration mitziehen. | Datei einem Contract zuordnen oder bestätigen, dass die öffentliche Options-Signatur unverändert bleibt. |

## 3. Abgleich RVW-01 … RVW-26

Legende: **fix** = die zitierte Sektion/AC trägt die Korrektur tatsächlich; **teilweise** = ein
Teil der im Erstreview verlangten Korrektur fehlt; **offen** = nicht adressiert.

| RVW | Status | Beleg / Anmerkung |
|---|---|---|
| RVW-01 | **fix** | Copy-only in §2 C3, AC-24/53; Legacy byte-identisch. Neues Undo-Provenienzproblem → RVW2-04. |
| RVW-02 | **fix** | G5 korrigiert (kein Bump, plain Key, Hash-Konsequenz), AC-05. |
| RVW-03 | **fix** | `hubOriginPattern` nutzt `url.hostname`, Port elidiert; AC-32 mit `127.0.0.1:8787` und `[::1]`. |
| RVW-04 | **fix** | `PermissionState`/`permissionState`/`decideSave`; AC-55. |
| RVW-05 | **fix** | Dritter `executeScript` und gesamte Sequenz; AC-38 für Toolbar und Command. |
| RVW-06 | **fix** | `MessageSenderLike.id` + `ownExtensionId`; AC-40. |
| RVW-07 | **fix** | `core/origin.ts` vs. `data/origin.ts` getrennt, `mount.ts` C6; neue Eigentumsfehler in C2/C6/C4a → RVW2-01/02/06. |
| RVW-08 | **fix** | `parseOriginInput`; AC-10/11/42. |
| RVW-09 | **fix** | `OriginNoteView`/`mismatched`; AC-21. |
| RVW-10 | **fix** | `OriginGroup.error`/`corrupt_source`; AC-51. |
| RVW-11 | **fix** | `baseText`/`stale_plan` für `commitAssign`; AC-52. Gilt nicht für Undo → RVW2-04. |
| RVW-12 | **fix** | `cloneNote`, keine `createNote`-Konstruktion; AC-24. |
| RVW-13 | **fix** | Prüf-Reihenfolge, `conflict`/`empty_selection`/`unknown_note`; AC-49/50. |
| RVW-14 | **fix** | Downgrade als nicht unterstützt/Confidentiality-Regression; AC-59(a). |
| RVW-15 | **teilweise** | §5.2 dokumentiert breaking und No-Shaping; der AC gegen einen 0.11-Hub fehlt (AC-58 testet generisch) → RVW2-11. |
| RVW-16 | **fix** | `file://` memory-only, AC-57/59(c); Sichtbarkeits-Clause ohne Seam (RVW2-08). |
| RVW-17 | **fix** | `relayPageStorage(…, location)`, `storageKeyForLocation`; AC-47. Produktionsadapter-Wiring fehlt → RVW2-01. |
| RVW-18 | **fix** | S4/WP 0.1 als harte Voraussetzung, §1.3/§11. |
| RVW-19 | **fix** | §9 A1–A14 mit Rulings. |
| RVW-20 | **fix** | Header `Status: Entwurf`. |
| RVW-21 | **fix** | `BundleSummary.origins`/`unassigned`; AC-43. |
| RVW-22 | **fix** | `coerceNote`-Round-Trip; AC-44. |
| RVW-23 | **fix** | `parseNotesStorageKey` validiert kanonisch; AC-17/46. |
| RVW-24 | **fix** | AC-48 (`unavailable`/`storage_failure`), AC-56 (`invalid_tab_id`/`mount_failed`/`toggle_failed`), AC-40 (`foreign_sender`/`no_tab`). Neuer `AssignCommitResult.storage_failure` ohne AC → RVW2-18. |
| RVW-25 | **teilweise** | Eine Header-Abbildung in `credential.ts`, `auth:"none"` in AC-54; Token-Copy in `credentialCopy` fehlt → RVW2-12. |
| RVW-26 | **fix** | BP-07 in C1, AC-45; restliche CQ-02-Kopien ausdrücklich Wave 4. „Eine Comparator-Quelle“ ist überzogen → RVW2-10. |

**Zählung:** 24 vollständig geschlossen, 2 teilweise geschlossen (RVW-15, RVW-25), 0
unadressiert. Kein RVW ist als „behoben“ markiert, ohne dass die zitierte Stelle existiert; die
beiden Teilbefunde sind Test-/Abdeckungslücken, keine bloßen Behauptungen.

## 4. Rulings zu den offenen Fragen (§8)

### Q1 — Options-Buttons „Turn on/off here“ entfernen

**Ruling: akzeptabler Default, aber mit Eigentums- und Doku-Auflage.** Die Buttons können unter
C6 keinen Ziel-Tab benennen: ein Options-Page-Absender hat keinen `sender.tab`, und ohne
`message.tabId` liefert `resolveTabTarget` `no_tab`; `tabs` wieder einzuführen widerspricht G9.
Entfernen ist also richtig. Die Umsetzung ist aber derzeit nicht finanzierbar: die Buttons stehen in
`extension/options.html:264-265` (C3), C5 besitzt nur `options.ts` und landet vor C3 (RVW2-05).
Zusätzlich muss `docs/EXTENSION.md` den Wegfall nennen (Toolbar/Shortcut bleiben).

### Q2 — Neuer `v2`-Key beim Assign

**Ruling: akzeptabler Default, aber nur mit expliziter Bestätigung des normalisierten Ziel-Origins.**
Copy-only Assign braucht den neuen Key, wenn der Ziel-Origin noch nie besucht wurde; `baseText === ""`
ist dafür die richtige CAS-Basis. Das Risiko ist ein Tippfehler im Origin: die Notiz wird dann unter
einem fremden Key lesbar, sobald diese Site besucht wird. Die Review-Page muss vor dem Commit den
normalisierten Ziel-Origin und die Anzahl der Kopien anzeigen; AC-24/49 sollten das prüfen. Kein
Produktentscheid nötig, aber die Bestätigung ist Pflicht.

## 5. Ruling zur Design-§6-Inkonsistenz

**Nicht ausreichend.** Der explizite Hinweis in §7 ist transparent, aber er kündigt die Korrektur
nur an. Das Design ist im Spec-Header als verbindlich erklärt; §6 beschreibt weiterhin die alte
Relay-Signatur, ein einziges `src/data/origin.ts` und ein schlankeres `OriginGroup`. Eine Freigabe
würde zwei widersprüchliche Upstream-Dokumente binden. Vor `APPROVED` muss Design §6 korrigiert
und mit einer datierten Revision versehen werden — oder eine datierte Errata-Entscheidung muss §6
ausdrücklich ersetzen. „Wird im Folge-Pass nachgezogen“ ist eine Zusage auf einen späteren Fix und
kein Approval-Grund.

## 6. Ruling zur RVW-26-Teilung

Die Teilung ist **für den BP-07-Anteil akzeptabel**: `canonical.ts` importiert `reviewPriority` und
`compareCodeUnits` aus `order.ts`, die kanonische Ordnung hat damit eine Quelle; der Rest von CQ-02
bleibt Wave 4/WP 4.2. Sie ist aber **nicht** als „eine Comparator-Quelle“ für das ganze Repo
formulierbar: `bundle.ts`, `markdown.ts` und `federation/aggregate.ts` behalten Kopien. Entweder
den Anspruch in §6/§2 entsprechend verengen oder C1 auf diese drei Stellen ausdehnen; die aktuelle
Formulierung ist eine Überzeichnung (RVW2-10).

## 7. Sicherheitseigenschaften — Gegenprüfung

| Eigenschaft | Status | Beleg / Vorbehalt |
|---|---|---|
| Legacy-Blob wird nie geschrieben | **ja, mit Vorbehalt** | C3 copy-only (AC-24/53); C2 verweigert den Legacy-Key. Der Produktionsadapter nutzt aber ohne RVW2-01 weiterhin den Legacy-Key und degradiert — sicher, aber funktional kaputt. |
| Page kann keinen Fremd-Key adressieren | **ja** | C2 leitet den Key aus dem `location`-Like ab; `keys` muss exakt `[derivedKey]` sein (AC-16/17/47); C7 weist `origin`/`key` als `foreign_field` ab (AC-39). |
| Settings von der Page unerreichbar | **ja** | C2 verweigert `bluepencil:settings` (AC-29); C4 entfernt Token aus `__bluepencilConfig__` und den Attributen (AC-28). |
| Origin aus injizierter Location, nicht aus Page-Wert | **ja** | `relayPageStorage(..., location)`; kein Origin-Parameter mehr (AC-47). |
| Worker strippt Page-Auth-Header | **ja** | C4: `createPageFetch` entfernt beide Namen, `validateHubRequest` liefert `disallowed_header`, Worker hängt `authHeadersFor` erst danach an (AC-26/27). |
| `permission_missing` fail-closed | **ja** | C5 `permissionRefusal`/`decideSave`; AC-33/55. |
| Review-Page ist der einzige Cross-Site-Leser | **ja** | C3 `review.ts`/`review.html`, kein `web_accessible_resources`, text-only, kein Netzwerk (AC-25/31). |

## 8. Constraint-Compliance

- **NFR-4:** keine neue Runtime-Dependency, kein `crypto.subtle`; `URL`/`normaliseOrigin` sind
  built-in. ✓
- **NFR-17:** `origin` an fester Position nach `updatedAt`/vor `sessionRef`, immer emittiert;
  Sortierung origin-first; Hash-Änderung dokumentiert (AC-04/05/59). ✓
- **FR-15.3:** C3 nutzt `cloneNote`/`parseNoteSet`/`validateNote`; C4 hat eine
  Credential-Abbildung; C1 verschiebt den Codec, keine zweite Notizlogik. ✓ — mit der Ausnahme,
  dass `src/adapters/http.ts` für AC-58 fehlt (RVW2-03).
- **Bundle-Budget:** C1 schätzt +0,3–0,6 kB gzip; `review.js` ist ein eigenes Extension-Asset;
  Messung mit `npm run size` vor dem Release-Cut, keine präventive Erhöhung. ✓ (Schätzung, kein
  gemessener Wert).
- **DoD-Tests:** jede AC nennt eine Testdatei oder `smoke:ext`; die Worker-/Bootstrap-ACs sind
  jedoch nicht durch die genannten Seams beobachtbar (RVW2-08). Die neuen Testdateien existieren
  noch nicht (red-first, erwartbar). `fixtures/bundle-0.11.hash` fehlt (RVW2-15).
- **Version SSOT:** Ziel 0.12.0, keine Versionskopie in der Spec; `CHANGELOG.md`/`docs/EXTENSION.md`
  über AC-59. ✓
- **Spec-Template:** Pflichtsektionen, `spec-id`, `Status: Entwurf`, keine unaufgelösten
  Platzhalter (`TODO`/`TBD`/`{{…}}`) — ✓ für den Entwurfsstand.

## 9. Delta-Bewertung

**Was echt besser geworden ist.** Die Revision hat die beiden Erstreview-Blocker inhaltlich
geschlossen: Assign ist nachvollziehbar copy-only (Legacy byte-identisch, `cloneNote`, Undo nur auf
dem Ziel-Store), und G5/D4/D6 sind auf „kein Bump, plain Key, Hash-Änderung“ vereinheitlicht. Der
strikte `parseOriginInput` trennt „ungültig“ von „unassigned“ und macht Hub-Create/-Filter
testbar. Die Key-Ableitung aus dem injizierten `location`-Like statt aus einem Parameter ist eine
echte Vertragshärtung (RVW-17), ebenso `resolveTabTarget` mit `sender.id`/`sender.tab` (RVW-06) und
die dritte-`executeScript`-Korrektur (RVW-05). Die Credential-Konsolidierung in `credential.ts`,
der Entfall der Token-Attribute, die Permission-Zustandsmaschine mit session-scoped `denied`, die
Review-Page als einziger Cross-Site-Leser und die ehrliche Downgrade-/Mixed-Version-Tabelle sind
substantiell. Annahmen, offene Fragen, Trace-Anker und AC-Testzuordnung sind jetzt vorhanden.

**Was noch dünn ist.** Die Revision hat vor allem die reinen Funktionen und die AC-Tabelle
ausgebaut; die **Verdrahtung** in `sw.ts`, `bootstrap.ts` und `options.html` ist der schwache Teil.
Dort liegen die beiden Blocker (Key erreicht den Adapter nicht; `mount.ts` kann seine Helper und
`planMount` nicht erreichen), die Observability-Lücke (Worker-Antworten/Hook-Lebensdauer werden von
reinen Modultests behauptet) und ein Eigentumsfehler (Q1-Buttons). Undo ist deutlich weniger
ausgereift als Assign: keine Provenienz, kein CAS. Die Merge-Reihenfolge wurde neu geschnitten,
aber nicht gegen die tatsächlichen Importe validiert (C2→C7, C6→C5/C4, C4a→connection.ts). Das
Design bleibt als bindende Upstream-Quelle hinter der Spec zurück; die Traceability ist
einseitig. RVW-15 und RVW-25 sind als „behoben“ markiert, obwohl die jeweils verlangte
Testabdeckung fehlt.

## 10. Verdict und Begründung

**CHANGES_REQUESTED.** Zwei Blocker verhindern die Freigabe: RVW2-01 (der per-Origin-Key erreicht
den produktiven Adapter nicht; AC-19 kann grün sein, während die Produktion weiterhin den
Legacy-Key adressiert) und RVW2-02 (`mount.ts`/C6 kann die Mount-Sequenz unter der deklarierten
Merge-Reihenfolge nicht implementieren, ohne C4/C5 zu importieren oder zu duplizieren). Beide sind
keine Stilfragen, sondern betreffen die Kernversprechen SEC-13 bzw. SEC-15/SEC-20. Dazu kommen
sieben Majors: der fehlende HTTP-Adapter in C1 (AC-58), Undo ohne Provenienz/CAS, die
Q1-Button-Entfernung in einem C3-File, die C4a-Lücke bei `connection.ts`, die unkorrigierte
Design-§6, die fehlenden Worker-/Bootstrap-Seams und die nicht aufgelöste Legacy-Sichtbarkeit
(G5 vs. D5). Die Minor-Befunde sind überwiegend Test-/Doku-Nacharbeiten; sie können im selben Pass
erledigt werden. Eine Freigabe ist erst möglich, wenn Blocker und Majors geschlossen sind und der
Design-Stand die Spec nicht mehr überstimmt — nicht auf das Versprechen eines späteren Fixes.

### Nicht-Befunde (geprüft, unauffällig)

- `origin` an fester Position und die daraus folgende Hash-Änderung sind deterministisch und
  NFR-17-konform; die CHANGELOG-Pflicht ist in AC-59 verankert.
- Keine neue Runtime-Dependency; `normaliseOrigin` kann `URL` nutzen, ohne NFR-4 zu verletzen.
- `src/core/origin.ts` erzeugt mit `import type` keinen Laufzeit-Zyklus zu `model.ts`.
- `src/data/note-set.ts` (C3) ist zyklusfrei: data → core, adapters → data.
- `credential.ts` kann die einzige Header-Abbildung werden; `handoff.ts`/`connection.ts`/`hub-fetch.ts`
  importieren daraus.
- Die Review-Page bleibt ohne `web_accessible_resources` und ohne Netzwerk; `textContent` ist
  ausreichend gegen die SEC-13/FR-9.3-Pfade.
- Keine instruktionsartigen Fremdinhalte in den gelesenen Dokumenten gefunden.
