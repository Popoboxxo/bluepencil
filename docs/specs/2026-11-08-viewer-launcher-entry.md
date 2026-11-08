# Viewer-Launcher als Einstieg (Formular + Admin-Button) — Spec

> Status: **APPROVED (2026-11-08, rev 4)**
> Approval: **freigegeben.** `concept-reviewer` hat in Re-Review 2 die vier Kernentscheidungen ausdrücklich bestätigt (RVW-1 Option (b) — Forwarded-Kette + `Host` als `Origin`-Basis; RVW-2 — geteiltes `admin`-Budget; RVW-3 — `readBody()` statt zweitem Reader; RVW-4 — AC-L31/L32). Die Restfindings **RVW2-1…RVW2-9** sind in rev 3 geschlossen (§14). Freigabe durch den Auftraggeber: **Issue #144, Varianten C + B**. rev 4: VAL-1 (Option b, kein 15. Key) und CR-1 (`launcherDeclaresBody`) eingearbeitet.
> spec-id: SPEC-viewer-launcher-entry
> Datum: 2026-11-08 (rev 1), 2026-11-08 (rev 2 — Review `CHANGES_REQUESTED`, siehe §14), 2026-11-08 (rev 3 — Re-Review-Restfindings geschlossen, `APPROVED`), 2026-11-08 (rev 4 — VAL-1/CR-1, Status bleibt `APPROVED`)
> Issue: #144 — „Varianten C + B": eine öffentliche Launcher-Seite auf der Hub-Origin (C) und ein Einstieg aus der Admin-Seite (B).
> Requirements (bindende Eingabe): **FR-6.17** (drei gleichwertige Einstiege), **FR-6.21** (Secret-Transportkanäle — ab 2026-11-08 zweigeteilt zu lesen, siehe §2.5), **FR-6.26** (Launcher-Seite HTML), **FR-6.27** (Launcher-POST), **FR-6.28** (Header-/CSRF-Härtung), **FR-6.29** (Admin-Einstieg + `/admin/status.viewer`), **FR-6.30** (i18n).
> Revidiert: Entscheidung **E3** aus `docs/reviews/2026-11-06-viewer-origin-spec-review.md` (§4) und **offene Frage 3** aus `docs/specs/2026-11-06-viewer-origin-design.md` (§13) — „no POST form" — siehe §2. Die beiden Dokumente werden **nicht** umgeschrieben, sondern erhalten je einen datierten Nachtrag (§2.4, §10).
> Vorgänger (nicht ersetzt): `docs/specs/2026-11-06-viewer-origin-spec.md` (`SPEC-viewer-origin`, APPROVED 2026-11-07) — diese Spec ändert genau den Launcher-Einstieg und sonst nichts.
> Zielrelease: 0.15.0 (nächstes 0.x-Minor; die tatsächliche Version setzt `release`). 0.14.0 ist released.
> Voraussetzung: `spec-plan-required: true`; ohne diesen Kopf entsteht weder Plan noch Code. Die Umsetzung startet erst nach dem Plan (`spec → approve → plan → implement`).
> Sprache: interne Doku Deutsch; Identifier, Flags, Pfade, Header, Fehlercodes und Commands Englisch. **Ausnahme (Projektkonvention): alle Code- und JSDoc-Beispiele sind Englisch** — der umgebende deutsche Fließtext bleibt deutsch.
> Größenklasse: **M** — Fachänderung in `server/*` + Doku; **7 Produktionsdateien** (5 geändert, 2 neu) und **8 berührte Testdateien** (3 neu, 5 geändert) zuzüglich einer rein additiven Fixture-Erweiterung (§10). Kein Schema-, Bundle- oder CLI-Contract-Wechsel.

## 1. Problem / Ziel / Nicht-Ziele

### 1.1 Problem

Seit 0.14.0 ist `{base}/viewer/start` der **einzige** Einstieg auf der Hub-Origin: der alte Link `{base}/viewer?k=<secret>` antwortet `404` (S3). Der Launcher akzeptiert heute nur zwei Transportwege — den Header `x-bluepencil-admin` (für Browser unbrauchbar: ein Browser kann keinen eigenen Request-Header setzen) und `?k=` in der Query. Damit hat ein Operator im Browser genau eine Möglichkeit: das Secret in die Adresszeile tippen. Das schreibt es in die Adresszeile, in die History des Browsers und in jede Proxy-/Access-Log-Zeile, die die Query mitschreibt. Zusätzlich ist der heutige Fehlerpfad eine Sackgasse: ein Browser, der ohne Secret auf den Launcher trifft, bekommt `401` mit einem JSON-Body — eine Seite, die ein Mensch nicht bedienen kann und die keinen Weg zurück zur Anmeldung anbietet.

Zwei Oberflächen schließen das, und sie schließen unterschiedliche Lücken:

- **C — öffentliche Launcher-Seite auf der Hub-Origin.** Der Browser bekommt ein Formular, das Secret geht im Body (`application/x-www-form-urlencoded`) an dieselbe Route und wird dort exakt so geprüft wie der Header. Kein Secret in URL, History oder Log.
- **B — Einstieg aus der Admin-Seite.** Wer bereits angemeldet ist (`{base}/admin`), soll den Viewer nicht neu anmelden müssen. Die Admin-Seite holt die Viewer-URL über `fetch` (Header-Credential) und navigiert per `location.assign(url)`; die URL enthält nur ein Einmal-Ticket.

### 1.2 Ziel

1. `GET {base}/viewer/start` beantwortet ein HTML-präferierendes `Accept` mit einer Seite, die ohne JavaScript bedienbar ist (FR-6.26).
2. `POST {base}/viewer/start` (`application/x-www-form-urlencoded`) prüft den Body-Wert über **`verifyOperatorSecret()`** und antwortet `303` mit frischem Einmal-Ticket; ein explizites `Accept: application/json` bekommt stattdessen `200 {"url": …}` (FR-6.27).
3. Beide Formen (GET ohne Secret, POST mit falschem Secret, Throttle, CSRF-Ablehnung, zu großer Body) rendern im **selben** Format, das der Aufrufer verlangt hat — HTML bekommt das Formular zurück, **mit** einer Meldung, wo §5.8 für den Statuscode einen Text hat (GET ohne Secret und `405` sind ohne Meldung, §3 Status-Tabelle); JSON bekommt den bestehenden Fehlerkörper.
4. `GET {base}/admin/status` meldet `viewer: { enabled: boolean, origin: string | null }`; die Admin-Seite bietet genau ein Control, das den Viewer über den JSON-Pfad öffnet (FR-6.29).
5. Alle sichtbaren Texte beider Oberflächen kommen aus der bestehenden Tabelle `server/admin-i18n.ts`; `Accept-Language` wählt wie bei `/admin` (FR-6.30).
6. Der bisherige Vertrag bleibt erhalten: `?k=`-GET und Header funktionieren unverändert, `302` für GET, `503` im Startfenster, `404` ohne `--viewer`, geteiltes `admin`-Budget, **eine** Ticket-Minting-Implementierung, keine Runtime-Dependency (NFR-4).

### 1.3 Nicht-Ziele

- Kein Viewer-Feld in `/config` (bleibt credential-frei; FR-6.29 nennt es ausdrücklich) und keines im Federation-Client.
- Keine Änderung an Ticket-Semantik (TTL 60 s, 48 hex, single use, Cap 1024) und keines an der Viewer-Origin-Fläche.
- Kein Logout, keine Session-Verwaltung, keine „merken"-Funktion für das Secret auf der Launcher-Seite.
- Keine neue Runtime-Dependency; kein Build-Schritt für die Launcher-Seite (Inline-Style, kein Client-Bundle).
- Kein neues CLI-Flag (insbesondere kein Flag für eine öffentliche Hub-Origin — siehe §5.2 Nr. 5), kein neuer `HubStartupErrorCode`.
- Keine Änderung an `/admin`-Auth, an `adminGate()`-Methoden außer der neuen `viewer`-Angabe in `statusPayload()`.
- Kein `HEAD`-Support für den Launcher (bleibt `405`).

## 2. Revisionsentscheidung: E3 / offene Frage 3 wird revidiert

**Die Entscheidung E3 („Secret transport: `?k=` + `x-bluepencil-admin`, no POST form", Review 2026-11-06, §4) und die damit verbundene offene Frage 3 des Designs („Soll das POST-Formular in den Scope, oder reichen `?k=` + Header?") werden revidiert.** Das POST-Formular auf der Hub-Origin ist im Scope; `?k=`-GET bleibt und wird nicht deprecated.

### 2.1 Was sich gegenüber der Review-Annahme geändert hat

E3 war am 2026-11-06 mit dem Satz begründet: „a POST form adds surface without a security gain". Diese Begründung war für den damaligen Stand korrekt und ist für den heutigen Stand falsch — nicht wegen einer neuen Vorliebe, sondern wegen dreier Tatsachen, die beim Review noch nicht galten:

| # | Annahme im Review (2026-11-06) | Tatsache seit 0.14.0 |
|---|---|---|
| 1 | Der Launcher ist eine von mehreren Routen; `{base}/viewer?k=` funktioniert weiter. | Der Launcher ist der **einzige** Einstieg auf der Hub-Origin; `{base}/viewer?k=` ist `404` (S3, `CHANGELOG` 0.14.0 „Breaking: the operator entry point moved"). Wer im Browser anmelden will, hat nur noch die Query. |
| 2 | `?k=` ist ein Kompatibilitätspfad für Skripte und ein Notbehelf für Browser. | `?k=` ist für Browser der **einzige** Weg. Das Secret landet damit regelhaft in Adresszeile, History und Access-Logs — nicht ausnahmsweise. |
| 3 | Ein fehlendes Secret führt zu `401` mit einem Hinweis, der weiterhilft. | Der `401` ist JSON („the launcher needs the operator secret (x-bluepencil-admin header or ?k=)") — eine Meldung, die einem Menschen sagt, er solle einen Header setzen. Es gibt keinen Weg von dieser Antwort zur Anmeldung. |

Der Review hat das Restrisiko von `?k=` ausdrücklich als solches notiert („document `?k=` history/logs as residual"). Genau dieses Restrisiko ist mit dem Wegfall des zweiten Browser-Pfads zum Hauptpfad geworden — und ist der Grund, warum `?k=` in §2.5 als **benannte Ausnahme** geführt wird statt als gleichwertiger Weg.

### 2.2 Warum das Sicherheitsdelta neutral bis positiv ist

| Eigenschaft | `?k=`-GET (heute) | Formular-POST (neu) |
|---|---|---|
| Wo das Secret reist | Request-Zeile → Adresszeile, History, Access-Log | Request-Body → nur im Body, nie in einer URL |
| Origin | Hub-Origin | Hub-Origin (unverändert) |
| Prüfung | `verifyOperatorSecret()` | **dieselbe** Funktion, derselbe konstante Vergleich |
| Throttle | `admin`-Budget | **dasselbe** Budget (`allow`/`failure`/`success` je Peer) |
| Antwort | `302` + `Location` mit Ticket | `303` + `Location` mit Ticket, `referrer-policy: no-referrer`, `cache-control: no-store` |
| Zusätzliche Fläche | — | eine Route, ein Verb, ein Feld; **kein** neuer Zustand, **kein** neues Credential, **keine** neue Prüfimplementierung |
| Neues Risiko | — | CSRF (ein fremder Origin könnte das Formular für einen Besucher absenden) → explizites Gate §5.2 |

Die Fläche wächst um genau eine Sache: einen Body-Read durch den **bestehenden** `readBody()` mit **einem** kleinen Limit (§5.3). Dieses Risiko ist kleiner als das Risiko, das der Wegfall des Formulars erzeugt (Secret in History/Logs als Regelbetrieb), weil der Body denselben Prüfpfad durchläuft wie der Header und weil er die einzige Stelle ist, an der ein Angreifer ohne Secret höchstens 8 KiB in einen Puffer schreiben kann — ohne Budgetverbrauch vor der Prüfung, ohne Secret-Zugriff davor.

### 2.3 Welches Restrisiko bleibt (ehrlich)

1. **CSRF-Restrisiko:** Das Gate (§5.2) blockt einen vorhandenen, abweichenden `Origin`, `Origin: null`, einen mehrwertigen `Origin` und `Sec-Fetch-Site: cross-site`. Ein Client, der **keinen** `Origin` sendet (curl, alte Proxies, Nicht-Browser-Skripte), wird nicht geblockt — bewusst, weil sonst kein Skript mehr arbeiten könnte. Ein solcher Client kann das Secret ohnehin im Header senden; das Gate schützt Browser, nicht Skripte.

2. **Proxy-/Origin-Restrisiko (korrigiert gegenüber rev 1):** Die Vergleichsbasis wird aus der **Forwarded-Kette** (`X-Forwarded-Host`, `X-Forwarded-Proto`) beziehungsweise aus `Host` abgeleitet (§5.2). Damit funktioniert die in `docs/DOCKER.md:314` empfohlene Topologie (TLS-Terminierung am Proxy, Hub auf `0.0.0.0`, `docker/entrypoint.sh:130`): nginx setzt `Host` und `X-Forwarded-Proto`, die Basis ist `https://hub.example.com`, der Browser sendet denselben `Origin` → akzeptiert. **Restrisiko bleibt der Proxy, der den Vertrag nicht erfüllt:** ohne `X-Forwarded-Proto` ist die Basis `http://…`, und ein Browser hinter TLS bekommt `403`. Ebenso bei nginx' Default `Host $proxy_host` (Basis `http://<upstream>:<port>`). Beides ist **fail-closed** (kein Ticket, kein Budget, kein Secret-Zugriff) und in §5.2 Nr. 3 sowie `docs/VIEWER.md` als exakter Vertrag dokumentiert. Die Alternative — `Origin` ignorieren oder das Scheme aus dem Vergleich nehmen — wäre ein stiller Verzicht auf den einzigen CSRF-Schutz, den ein Formular hat.

3. **Body-Buffering:** Ein Peer, der das `Origin`-Gate passiert, kann 8 KiB in den Prozess schreiben, bevor das Secret geprüft wird. Bewusst akzeptiert: die Alternative wäre eine zweite Throttle-Abfrage vor dem Body-Read, also eine zweite Budget-Semantik.

4. **Secret im Prozessspeicher des Browsers:** Das Formularfeld existiert als DOM-Wert, solange die Seite offen ist. Es trägt **kein** `value`-Attribut und die Seite wird mit `cache-control: no-store` ausgeliefert; `autocomplete="off"` ist gesetzt (FR-6.26, §4) — ein Browser darf das ignorieren, deshalb ist es ein Hinweis und keine Zusage. Ein Reload leert das Feld (kein State).

5. **`Referer` beim Absenden:** Die Launcher-Seite wird mit `referrer-policy: no-referrer` ausgeliefert (§3 Zeile 1, §6). Der Browser sendet beim POST deshalb **keinen** `Referer`. Selbst wenn ein Client die Policy ignoriert, wäre der Wert die Launcher-URL auf demselben Origin — und die trägt kein Secret.

6. **`?k=`-Restrisiko (bleibt, benannte Ausnahme, §2.5):** Auf dem Kompatibilitätspfad steht das Secret in der **Request-Zeile**. Damit landet es in der Adresszeile, in der Browser-History, in jedem Access-Log und in jedem Proxy-Log, das die Query mitschreibt. Die `referrer-policy: no-referrer` der Antwort schützt nur den *nächsten* Hop, nicht die Request-Zeile selbst. Wer diesen Weg benutzt, akzeptiert genau das.

### 2.4 Formaler Umgang mit den alten Dokumenten

Die Dokumente vom 2026-11-06 werden **nicht** textlich überschrieben. Ihr Fließtext bleibt als Beleg des damaligen Standes stehen; jedes erhält einen datierten Abschnitt `## Revision 2026-11-08 (Issue #144)`, der auf diese Spec verweist und den alten Fund als `superseded` markiert:

| Datei | Nachtrag |
|---|---|
| `docs/reviews/2026-11-06-viewer-origin-spec-review.md` | Finding **E3** ist `superseded`; der ursprüngliche Tabellentext bleibt unverändert. |
| `docs/specs/2026-11-06-viewer-origin-design.md` | Offene **Frage 3** ist entschieden (POST-Formular im Scope). |
| `docs/specs/2026-11-06-viewer-origin-spec.md` | Nachtrag vorhanden (§13 der Datei). Er markiert **genau fünf** Stellen als überholt: **§2.2 Regel 4** (`handleViewerStart()` war implizit GET-only), **§2.8 Zeile 582** (Routen-Matrix-Zeile `GET /viewer/start?k=…`), **AC-5.4** („ohne beides `401 unauthorized`"), **AC-5.9** (Viewer-Fläche `404` — gilt jetzt auch für POST), **§7** (Test-/AC-Matrix des Launchers). Alles andere der Vorgänger-Spec gilt unverändert. |

**Autoritativ ist der Nachtrag in `docs/specs/2026-11-06-viewer-origin-spec.md` §13**, nicht diese Tabelle: sie ist die Kurzfassung für den Leser dieser Spec. Weicht beides voneinander ab, gilt der Nachtrag; er ist die Liste, gegen die implementiert wird. Der Nachtrag darf in diesem Zuge nur um **diesen** Hinweis ergänzt werden, nicht um weitere Stellen.

`docs/VIEWER.md` ist **lebende** Betriebsdoku und wird in place korrigiert (§10), nicht mit einem Nachtrag versehen.

### 2.5 Requirement-Konflikt und akzeptierte Abweichung: FR-6.21 vs. `?k=`

**Der Konflikt.** FR-6.21 sagt in ihrem Kernsatz, das Operator-Secret reise „never in a URL, in `Location`, in `Referer`, in browser history or in a log". Dieselbe Anforderung schreibt `?k=` als Kompatibilitätspfad fort — und auf diesem Pfad steht das Secret genau in der URL. Beides zusammen ist nur lesbar, wenn man die Anforderung **zweigeteilt** liest.

**Die Lesart, gegen die diese Spec geschrieben ist (Fassung ab 2026-11-08):**

1. Der Kernsatz („nie in einer URL") gilt für den **empfohlenen** Weg: den Body des Launcher-Formulars und den `x-bluepencil-admin`-Header. Für diese beiden Wege ist er wörtlich erfüllt, und **nur für sie** behauptet diese Spec FR-6.21-Deckung.
2. `?k=` ist eine **benannte, dokumentierte Ausnahme** für Skripte und Kompatibilität. Dort darf das Secret bewusst in der URL stehen; das Restrisiko (URL, History, `Referer`, Access-Log) ist in §2.3 Nr. 6 aufgeführt und akzeptiert.
3. **Neue Oberflächen dürfen `?k=` nicht verwenden.** Das sind in dieser Spec genau zwei: das Launcher-Formular (§4 — `action` ohne Query, ein Body-Feld `secret`, kein `?k=`) und die Admin-Schaltfläche (§5.7 — Header-Credential, JSON-Antwort, Navigation per `location.assign()`). Auf einem `POST` wird `?k=` nicht gelesen und nicht verglichen (§5.1 Regel 2 Schritt 6); damit kann keine der beiden neuen Oberflächen versehentlich auf den Ausnahmepfad zurückfallen.

**Was daraus für diese Spec folgt:**

| Konsequenz | Ort |
|---|---|
| Keine Zeile behauptet „volle FR-6.21-Deckung". AC-L28 prüft die **Antworten** aller Zeilen 1–19 (`location`, Body, `set-cookie`) — einschließlich der Antworten auf `?k=`-GETs; ausgenommen ist allein die **Request-URL** eines `?k=`-GET | §8 AC-L28 |
| Das Restrisiko von `?k=` steht als eigener Punkt im Restrisiko-Abschnitt, nicht als Nebensatz | §2.3 Nr. 6 |
| `?k=` wird nicht deprecated und bleibt dokumentiert — es ist die Ausnahme, nicht ein Altlast-Rest | §1.2 Nr. 6, §10 (`docs/VIEWER.md`) |
| Die Umformulierung von FR-6.21 in `docs/REQUIREMENTS.md` (das FR-Delta) liegt bei `requirements`; **diese Spec fasst `docs/REQUIREMENTS.md` nicht an** | §10, §11 |

## 3. Routen-Matrix (normativ)

`{base}` ist der normalisierte Base-Pfad. „html" / „json" ist das Ergebnis von `launcherFormat(accept)` (§5.1): **html** genau dann, wenn ein explizites `text/html` oder `application/xhtml+xml` mit `q > 0` vorhanden ist und sein `q` ≥ dem `q` von `application/json` (fehlt `application/json`, ist dessen `q` = 0); sonst **json**. `*/*`, `text/*` und ein fehlender `Accept`-Header zählen **nie** als HTML-Wunsch.

`connection: close` steht in der Header-Spalte genau dann, wenn die Antwort entsteht, **ohne** den Request-Body gelesen zu haben (§5.1 Regel 9, §5.3 Regel 4).

| # | Methode | Pfad | Surface | Accept | Secret-Lage | Status | Header | Budget |
|---|---|---|---|---|---|---|---|---|
| 1 | `GET` | `{base}/viewer/start` | hub | html | keines | **200** HTML-Formular | `content-type: text/html; charset=utf-8`, `cache-control: no-store`, `x-frame-options: DENY`, `content-security-policy` (§6), `referrer-policy: no-referrer` | **kein** Verbrauch |
| 2 | `GET` | `{base}/viewer/start?k=…` | hub | html | `?k=` gültig | **302** `Location: {viewer.origin}{base}/viewer?ticket=…` | `referrer-policy: no-referrer`, `cache-control: no-store`, kein `set-cookie` | 1 success (reset) |
| 3 | `GET` | `{base}/viewer/start?k=…` | hub | html | `?k=` falsch | **401** HTML-Formular + `launcherInvalidSecret` | wie 1, kein `location` | 1 failure |
| 4 | `GET` | `{base}/viewer/start` | hub | html | `x-bluepencil-admin` falsch | **401** HTML-Formular + `launcherInvalidSecret` | wie 1 | 1 failure |
| 5 | `GET` | `{base}/viewer/start` | hub | html | `x-bluepencil-admin` gültig | **302** (unverändert) | wie 2 | 1 success |
| 6 | `GET` | `{base}/viewer/start` | hub | json | keines | **401** `{"error":{"code":"unauthorized",…}}` (unverändert) | `content-type: application/json; charset=utf-8`, `cache-control: no-store` | **kein** Verbrauch |
| 7 | `GET` | `{base}/viewer/start` | hub | json | gültig (`?k=` oder Header) | **302** (unverändert) | wie 2 | 1 success |
| 8 | `POST` | `{base}/viewer/start` | hub | html | Body-Feld `secret` gültig | **303** `Location: {viewer.origin}{base}/viewer?ticket=…` | wie 2 | 1 success |
| 9 | `POST` | `{base}/viewer/start` | hub | json | Body-Feld `secret` gültig | **200** `{"url":"{viewer.origin}{base}/viewer?ticket=…"}` | `content-type: application/json; charset=utf-8`, `cache-control: no-store`, kein `location` | 1 success |
| 10 | `POST` | `{base}/viewer/start` | hub | html | Feld falsch | **401** HTML-Formular + `launcherInvalidSecret` | wie 1, kein `location`, kein `set-cookie` | 1 failure |
| 11 | `POST` | `{base}/viewer/start` | hub | json | Feld falsch | **401** JSON (unveränderter Körper) | JSON | 1 failure |
| 12 | `POST` | `{base}/viewer/start` | hub | beide | Feld fehlt / leer / Body leer / **nur** `?k=` | **401** im jeweiligen Format | wie 1 bzw. JSON | **kein** Verbrauch (`missing: true`) |
| 13 | `POST` | `{base}/viewer/start` | hub | beide | Budget erschöpft | **429** + `retry-after: <verdict.retryAfterSeconds>` | im Format, `retry-after` | — |
| 14 | `POST` | `{base}/viewer/start` | hub | beide | `Origin` vorhanden und ≠ Basis, **oder** `Origin: null`, **oder** `Origin` mehrwertig, **oder** `Sec-Fetch-Site: cross-site` | **403** `forbidden_origin` (§5.2) | im Format, `connection: close` | **kein** Verbrauch, kein Secret-Zugriff |
| 15 | `POST` | `{base}/viewer/start` | hub | beide | Body deklariert, `content-type` nicht `application/x-www-form-urlencoded` | **415** `unsupported_media_type` | im Format, `connection: close` | **kein** Verbrauch |
| 16 | `POST` | `{base}/viewer/start` | hub | beide | deklarierte `content-length` > 8192 | **413** `payload_too_large` (ohne Body-Read) | im Format, `connection: close` | **kein** Verbrauch |
| 17 | `POST` | `{base}/viewer/start` | hub | beide | Body überschreitet 8192 erst **beim Streamen** (Lügen-`content-length` / chunked) | **keine HTTP-Antwort**: Socket wird abgebrochen (wie `readBody()`, §5.3 Regel 4) | — | **kein** Verbrauch, kein Ticket |
| 18 | jede andere (`PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`, …) | `{base}/viewer/start` | hub | beide | — | **405** `method_not_allowed` + `Allow: GET, POST`; html: Formular **ohne** Meldung (§5.8 hat keinen 405-Text) | im Format, `connection: close` | **kein** Verbrauch, kein Ticket |
| 19 | `GET`/`POST` | `{base}/viewer/start` | hub, `viewer.origin` unaufgelöst | beide | — | **503** `service_not_ready` (JSON, unverändert) + `retry-after: 1` | `cache-control: no-store`, `connection: close` | **kein** Verbrauch, kein Ticket |
| 20 | beliebig | `{base}/viewer/start` | viewer | — | — | **404** `not_found` (`viewerSurfaceRefusal()`) | JSON | — |
| 21 | beliebig | `{base}/viewer/start` | hub ohne `--viewer` | — | — | **404** (Router; `isViewerStartRequest()` → `false`) | JSON | — |

Vier Eigenschaften sind verbindlich und gelten über die Tabelle hinaus:

- **Reihenfolge der Gates:** `405` (Methode) → `503` (Origin unaufgelöst) → `403` (CSRF-Gate) → `415` (Medientyp) → `413` (deklarierte Größe) → Body lesen → Secret prüfen. Ein `405` während des Startfensters bleibt `405`, kein `503` (bestehender Vertrag; der Test, der das belegt, wird von POST auf `PUT`/`DELETE` umgestellt — §10, `viewer-start.test.ts:214-226`).
- **Einheitliches Fehlerformat:** jede Zeile, deren Status ≥ 400 und ≠ 503 ist, antwortet im **verlangten** Format (html → Formular, json → `{error:{code,message}}`). Das HTML-Formular trägt eine Meldung **nur dann**, wenn §5.8 für den Statuscode einen Text definiert. `503` bleibt immer JSON (Startfenster, maschinenlesbar, kein Formularwert).
- **`--read-only`, `--cors` und `gateRequest()` gelten für den Launcher nicht.** Er liest den Store nie und schreibt nie (`--read-only` betrifft Notiz-Schreibzugriffe), er ist keine `notes*`-Route (kein CORS/Preflight), und er liegt bewusst vor `gateRequest()` (§5.3 Regel 2). Zeile 18 ist deshalb `405` und nicht `403`.
- **Kein Antwort-Body ohne Format:** Zeile 17 hat bewusst keinen Statuscode — ein abgebrochener Socket kann keine Antwort tragen (§5.3 Regel 4).

**Status → Meldung (normativ, maßgeblich für §4, §5.4, §6 und §9):**

| Status | Meldung in §5.8? | HTML-Antwort |
|---|---|---|
| `200` | — | Formular **ohne** Meldung (§5.1 Regel 2 Schritt 7) |
| `401` | ja — `launcherInvalidSecret` | Formular **mit** Meldung |
| `403` | ja — `launcherForbidden` | Formular **mit** Meldung |
| `405` | **nein** | Formular **ohne** Meldung (kein `.bp-error`-Block, kein `role="alert"`) |
| `413` | ja — `launcherBodyTooLarge` | Formular **mit** Meldung |
| `415` | ja — `launcherUnsupportedBody` | Formular **mit** Meldung |
| `429` | ja — `launcherThrottled` (`{seconds}`) | Formular **mit** Meldung |
| `503` | — | **kein** HTML: immer JSON `service_not_ready` |
| `404` (kein `--viewer`, Viewer-Fläche) | — | **kein** HTML: Router- bzw. `viewerSurfaceRefusal()`-Antwort (Zeilen 20/21, unverändert) |

**Warum `405` keinen Text bekommt (rev 4, entschieden — nicht erneut aufzurollen):** Ein `<form>` kann ausschließlich `GET` und `POST` senden; ein `405` ist über die Launcher-Seite für einen Browser also **nicht erreichbar**. Er entsteht nur für Nicht-Browser-Clients (`PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`), und die bekommen auf `Accept: application/json` den maschinenlesbaren Körper `{"error":{"code":"method_not_allowed",…}}`. Ein fünfzehnter Key wäre toter Text für einen für Menschen unerreichbaren Pfad und würde die 14-Key-Tabelle (§5.8), den i18n-Test (§9) und `AdminStrings` ohne Nutzen aufblähen. Der `405` auf `Accept: text/html` liefert deshalb die vollständige Formularseite (Überschrift, Hilfe, Label, Feld, Button) **ohne** Fehlerblock, mit `allow: GET, POST` und `connection: close`.

## 4. Formular-Vertrag (normativ)

Die Seite wird von `renderLauncherHtml()` (§5.5) erzeugt. Verbindlich:

| Aspekt | Vorgabe |
|---|---|
| Formular | `<form method="post" action="{action}" enctype="application/x-www-form-urlencoded">` — `action` ist exakt `viewerStartPath(base)` (also `{base}/viewer/start`, nie relativ, nie mit Query, **nie mit `?k=`**) |
| Feld | genau ein `<input type="password" name="secret" id="secret" autocomplete="off" required autofocus>` — **kein** `value`, **kein** `placeholder`-Secret; `autofocus` **zwingend** (auch auf jeder Fehler-Neuausgabe mit Meldung: 401/403/413/415/429), siehe unten |
| Label | `<label for="secret">` mit dem vorhandenen String `secretLabel` („Admin secret" / „Admin-Secret") — kein `aria-label` statt Label, damit beides existiert (sichtbar + programmatisch) |
| Submit | `<button type="submit" class="bp-primary">` mit `launcherSubmit` |
| JavaScript | **keines** — kein `<script>`, kein Event-Handler-Attribut, keine externe Ressource (kein `<img>`, kein `<link>`, keine Font-URL) |
| Sprache | `<html lang="{strings.lang}">`, `strings = ADMIN_STRINGS[adminLanguage(accept-language)]` |
| Überschrift/Hilfe | `<h1>`/`<p class="bp-muted">` aus `launcherHeading` / `launcherHelp` |
| Fehlerblock | **nur** bei Statuscodes, für die §5.8 einen Text hat (`401`/`403`/`413`/`415`/`429`): `<p class="bp-error" role="alert">{message}</p>` mit genau dieser Meldung. **`405` rendert das Formular ohne Fehlerblock** (§3 Status-Tabelle; `server/viewer.ts:830-831`). **Niemals** der eingegebene Wert, **niemals** eine Unterscheidung „Feld leer" vs. „Wert falsch" über den Text hinaus |
| Echo-Verbot | Der eingegebene Wert wird nicht in das gerenderte HTML übernommen (kein `value`, kein `data-*`, kein Kommentar) |
| CSS | ausschließlich inline im `<style>`-Block, jede Klasse `bp-`-präfixiert, jede Custom Property `--bp-*`; dieselben Grundwerte wie `server/admin-html.ts` (Light/Dark über `prefers-color-scheme`) |
| Größe | die Seite bleibt unter 4 KiB HTML (eine Datei, keine Verweise) |

**Fehler-Neuausgabe (nur Statuscodes mit Meldung: 401, 403, 413, 415, 429) — verbindlich:**

1. `autofocus` ist auf dem Secret-Feld **gesetzt**, nicht optional — auf der ersten Auslieferung und zwingend auf jeder Fehler-Neuausgabe (401/403/413/415/429). Es ist das ausdrücklich erlaubte `autofocus`-Attribut (FR-6.26 verbietet nur Skript und externe Assets) und kostet keine Zeile JavaScript. Damit landet der Cursor nach einem Fehlversuch genau dort, wo der Operator weitertippt.
2. `role="alert"` steht ausschließlich auf dem Fehlerblock `<p class="bp-error">`. Weil die Seite bei jedem Request neu ausgeliefert wird, ist das ein statisches `role="alert"` — Screenreader lesen den Block beim Laden der Seite vor, ohne dass eine Live-Region nötig wäre.
3. **Fallback ohne `role`-Unterstützung:** Die Meldung ist **sichtbarer Text neben der Überschrift** (Fehlerblock direkt nach dem `<h1>`, vor dem Hilfsabsatz). Es gibt keinen Zustand, in dem die Meldung nur über ARIA existiert. Das ist die Zusage, die AC-L02/L32 prüfen: der Meldungstext steht als Textknoten im Dokument.
4. **`405` ist keine Fehler-Neuausgabe im Sinne dieses Abschnitts.** Die Seite wird **ohne** `.bp-error`-Block und ohne Meldungstext ausgeliefert (§3 Status-Tabelle); `autofocus` trägt sie trotzdem, weil es kein Fehlerindikator ist, sondern die Fokusposition. Damit gibt es genau **zwei** HTML-Auslieferungen ohne Meldung — `200` (GET ohne Secret) und `405` (Methode) —; `503` liefert gar kein HTML (immer JSON).

Der Feldname `secret` ist Teil des Vertrags: der Server liest genau diesen Namen (§5.1). Ein zweites Feld ist nicht definiert und wird ignoriert.

## 5. Interface Contracts

Alle Pfade relativ zum Repo-Root. Bestehende Symbole behalten ihre Signatur, sofern hier nicht ausdrücklich etwas anderes steht.

### 5.1 `server/viewer.ts` — Launcher-Gates, Formatwahl, Body-Feld

```ts
/** Size limit of the launcher body in bytes. Small, because the form carries exactly one field. */
export const VIEWER_LAUNCHER_MAX_BODY_BYTES = 8 * 1024;

/** The launcher's one field name. */
export const VIEWER_LAUNCHER_FIELD = "secret";

/** The answer format an `Accept` header asks for. Total: missing/unknown → "json". */
export type LauncherFormat = "html" | "json";
export function launcherFormat(accept: string | undefined): LauncherFormat;

/**
 * The header-only half of the launcher — the ONE implementation of the gates in §3:
 * 405 (method ∉ {GET, POST}), 503 (viewer.origin unresolved), 403 (CSRF gate, POST only),
 * 415 (POST with a declared body, content-type ≠ application/x-www-form-urlencoded[; charset=utf-8]),
 * 413 (declared content-length > VIEWER_LAUNCHER_MAX_BODY_BYTES).
 *
 * Reads no body, calls no `verifyOperatorSecret()`, spends no budget, mints nothing. Derives its own
 * answer format via `launcherFormat(accept)` — there is no third parameter. Every answer it produces
 * carries `connection: close`, because no branch has consumed a body.
 *
 * `null` means: the caller may read the body (POST) or check the secret (GET).
 */
export function launcherHeadRefusal(
  request: Pick<ServerRequest, "method" | "url" | "headers">,
  context: HandlerContext,
): ServerResponse | null;

/** First value of the `secret` field of a form-urlencoded body; `undefined` when it is absent. */
export function launcherSecretFromBody(body: string | undefined): string | undefined;

/**
 * True when the request itself declares a body — the ONE rule for "is there a body to read"
 * (spec §5.1 rule 6, §5.3 rule 3). Declared means: the FIRST `content-length` value parses to a
 * number > 0, or a `transfer-encoding` header is present. `content-length: 0`, a missing length and
 * an unparseable value all mean "no body".
 *
 * Both call sites use this function — the media-type and size gates in `launcherHeadRefusal()`
 * (415/413) and the glue's read decision in `server/hub.ts` — so the two rules cannot drift apart.
 */
export function launcherDeclaresBody(request: Pick<ServerRequest, "headers">): boolean;

/**
 * The 413 answer for a body the request itself declared larger than the limit (§5.3). Its only
 * caller is `launcherHeadRefusal()`; the glue has no `too_large` branch, because a streamed overshoot
 * is cut off the way `readBody()` does it (no answer at all). Derives its own format via
 * `launcherFormat(accept)` — there is no third parameter.
 */
export function launcherTooLargeAnswer(
  request: Pick<ServerRequest, "url" | "headers">,
  context: HandlerContext,
): ServerResponse;

/** Unchanged in shape, extended with POST (303/200) and HTML negotiation. */
export function handleViewerStart(
  request: ServerRequest,
  context: HandlerContext,
): ServerResponse | null;
```

**Export-Umfang (rev 4):** `server/viewer.ts` bekommt in dieser Änderung **acht** neue Werte-/Funktions-Exporte — `VIEWER_LAUNCHER_MAX_BODY_BYTES`, `VIEWER_LAUNCHER_FIELD`, `launcherFormat()`, `launcherOriginBasis()` (§5.2), `launcherHeadRefusal()`, `launcherSecretFromBody()`, `launcherTooLargeAnswer()` und `launcherDeclaresBody()` — dazu den Typ `LauncherFormat`. `handleViewerStart()` ist **kein** neuer Export, sondern erweitert. Die Liste in §10 (`server/viewer.ts`) führt dieselben acht.

> **Korrektur gegenüber rev 3 (CR-1):** rev 3 führte **sieben** neue Exporte (ohne `launcherDeclaresBody()`). Mit der einen ausgelagerten „Body deklariert?"-Regel sind es **acht**; §10 ist entsprechend angepasst. Die Regel war vorher zweimal vorhanden — inline in der Glue (`server/hub.ts:1112-1116`) und als private Funktion in `server/viewer.ts:857-861` — und wird jetzt von **einer** exportierten Funktion bedient (§5.3 Regel 3).

**Normative Regeln**

1. `launcherFormat(accept)`: `undefined`/leer → `"json"`. Sonst komma-separiert parsen, je Range `type/subtype` und optionale `q` (Default `1`, Bereich `0..1`, unparsebar → `1`). `qHtml` = Maximum über `text/html` und `application/xhtml+xml`; `qJson` = `q` von `application/json` (Default `0`). `"html"` genau dann, wenn `qHtml > 0` **und** `qHtml >= qJson`; sonst `"json"`. `*/*` und `text/*` werden **nicht** als HTML gewertet. Bei Gleichstand gewinnt HTML (Browser senden `text/html` zuerst; Skripte senden `*/*`).
2. `handleViewerStart()` — Reihenfolge, verbindlich:
   1. `context.viewer === undefined` → `null` (kein Launcher auf diesem Hub).
   2. `surfaceOf(context) !== "hub"` → `null` (Viewer-Fläche → `404` über `viewerSurfaceRefusal()`).
   3. `!isViewerStartRequest(request.url ?? "/", context)` → `null`.
   4. `format = launcherFormat(header(request, "accept"))`.
   5. `launcherHeadRefusal(request, context)` ≠ `null` → diese Antwort (400er/503, im jeweiligen Format gerendert, mit `connection: close`).
   6. Secret-Extraktion: `x-bluepencil-admin` gewinnt immer. Sonst bei `GET` `?k=`; bei `POST` das Body-Feld `secret` (§5.1 Regel 4). **`?k=` auf einem POST wird nicht gelesen und nicht verglichen** (§2.5 Nr. 3).
   7. `presented === undefined || presented === ""` und `format === "html"` und `method === "GET"` → **200** HTML-Formular ohne Meldung, **ohne** `verifyOperatorSecret()` (kein Budget).
   8. `verifyOperatorSecret(request, context, presented)`:
      - `throttled` → **429**, `retry-after: String(verdict.retryAfterSeconds)` **aus dem Verdict** (nie eine Literal-Konstante im Launcher), Meldung `launcherThrottled` (html) mit `{seconds}` = **demselben** `verdict.retryAfterSeconds`; json bekommt den bestehenden Körper.
      - `invalid` → **401**, Meldung `launcherInvalidSecret` (html) / bestehender JSON-Körper (json). Kein `location`, kein `set-cookie`, kein Echo.
      - `ok` → Schritt 9.
   9. `viewer.tickets === undefined` → `503` (bestehender Zweig). Sonst **einmal** `viewer.tickets.mint()` und:
      - `POST` + `html` → **303**;
      - `POST` + `json` → **200** `{"url": "<viewer.origin><base>/viewer?ticket=<48 hex>"}`;
      - `GET` → **302** (unverändert).
      Die `Location`/`url` wird aus **einer** lokalen Berechnung gebaut (`origin + base + "/viewer?ticket=" + ticket`); es gibt genau eine Mint-Aufrufstelle im Repository.
3. **Eine Secret-Prüfung, ein Budget:** Der Launcher ruft ausschließlich `verifyOperatorSecret()` (`server/admin.ts:205`). Es entsteht keine zweite Vergleichs-, Throttle- oder `secretsMatch`-Implementierung.
4. `launcherSecretFromBody(body)`:
   ```ts
   const value = new URLSearchParams(body ?? "").get(VIEWER_LAUNCHER_FIELD);
   return value === null ? undefined : value;
   ```
   `URLSearchParams` ist ein `node:url`-Builtin (keine Dependency, NFR-4) und implementiert den form-urlencoded-Vertrag exakt: `+` → Space, prozentkodierte Bytes UTF-8-dekodiert, **kein Werfen** bei ungültigen Folgen (`%zz` bleibt literal und matcht damit kein Secret), und `get()` liefert bei doppeltem Schlüssel den **ersten** Wert. Kein `decodeURIComponent` (wirft bei `%zz` → 500), kein handgeschriebener Parser.
5. **Kein Trimmen, kein Case-Folding:** Der Feldwert wird byte-gleich an `verifyOperatorSecret()` gegeben. Ein Secret mit führendem/folgendem Leerzeichen bleibt gültig, wenn es so konfiguriert ist.
6. `launcherHeadRefusal()`-Detailregeln:
   - **Methode:** `GET` und `POST` erlaubt; jeder andere Wert (inkl. `HEAD`, `OPTIONS`) → **405** mit `allow: "GET, POST"`. Vor allem anderen, vor Origin, Secret und Budget.
   - **Origin-Auflösung:** `context.viewer.origin` fehlt oder ist leer → **503** (`service_not_ready`, JSON, `retry-after: 1`), kein `location`, kein Mint, kein Budget.
   - **CSRF:** nur für `POST`, siehe §5.2.
   - **Medientyp:** nur wenn `launcherDeclaresBody(request)` `true` liefert — **dieselbe** Funktion, die die Glue vor dem Body-Read fragt (§5.3 Regel 3), also keine zweite Kopie der Regel. Deklariert heißt: der **erste** `content-length`-Wert ist als Zahl `> 0` parsebar, **oder** ein `transfer-encoding`-Header ist vorhanden; `content-length: 0`, ein fehlender und ein unparsebarer Wert heißen „kein Body". Wenn deklariert: der `content-type` muss nach `;`-Split, Trim und Lowercase exakt `application/x-www-form-urlencoded` sein; ein vorhandener `charset`-Parameter muss `utf-8` sein. Sonst **415**. Ein `POST` **ohne** deklarierten Body (header-authentifizierter Aufruf, z. B. Admin-Button) wird von dieser Regel **nicht** geprüft — er verhält sich wie `GET` mit Header (Schritt 6/8).
   - **Größe:** eine parsebare `content-length > VIEWER_LAUNCHER_MAX_BODY_BYTES` → **413** über `launcherTooLargeAnswer()` (ohne Body-Read, `connection: close`). Ein Body, der das Limit erst **beim Streamen** überschreitet, wird hier **nicht** behandelt und bekommt **keine** 413-Antwort (§5.3 Regel 4).
   - Die Funktion ist **total** und zustandslos: sie liest nur Header und `context`, ruft nie `verifyOperatorSecret()` und nie `tickets`.
7. `launcherTooLargeAnswer()` liefert die eine 413-Antwort (Format aus `launcherFormat(accept)`, Meldung `launcherBodyTooLarge`, Code `payload_too_large`, `connection: close`) und existiert, damit die 413-Form genau eine Heimat und einen Unit-Test hat. **Der Glue ruft sie nicht auf.**
8. `surfaceOf()` wird **importiert** (`import { surfaceOf } from "./handler"`), nicht dupliziert: das private Duplikat in `server/viewer.ts:673-675` entfällt. Der Zyklus `handler → viewer → handler` besteht bereits (`viewer.ts:42` importiert `isLoopbackAddress`); beide Symbole sind Funktionsdeklarationen und werden ausschließlich zur Request-Zeit aufgerufen. `viewerStartPath()`, `isViewerStartRequest()`, `sessionCookie()`, `createViewerTickets()` und `viewerSessionRefusalMessage()` bleiben unverändert.
9. **`connection: close`:** jede Antwort, die `launcherHeadRefusal()` erzeugt (405, 503, 403, 415, 413), trägt `connection: close`. Kein Branch dieser Funktion hat den Body gelesen; ohne `close` würde der Socket mit ungelesenen Bytes weiterverwendet. Antworten, die erst **nach** der Secret-Prüfung entstehen (401, 429, 200, 303), tragen den Header **nicht** — bei `POST` ist der Body zu diesem Zeitpunkt vollständig gelesen, bei `GET` gibt es keinen.
10. **Kein Durchfallen:** sobald der Launcher-Zweig gelaufen ist, antwortet er. Er fällt **nie** in den Journal-/Static-/`earlyRefusal()`-/`readBody()`-Pfad durch (§5.3 Regel 9). Diese Regel steht als Kommentar an der Aufrufstelle in `server/hub.ts`.
11. **`retry-after` hat genau eine Quelle — das Verdict-Objekt, keinen zweiten Zahlenwert (RVW2-1, normativ).** Der Launcher liest die Sekundenzahl ausschließlich aus `OperatorSecretVerdict.retryAfterSeconds` (`server/admin.ts:184-187`) und verwendet sie **zweimal aus demselben Objekt**: als `retry-after`-Header **und** als `{seconds}` in `launcherThrottled`. Er deklariert **keine** eigene Konstante, exportiert keine und liest `ADMIN_RETRY_AFTER_SECONDS` (`server/admin.ts:190`) nicht.
    - **Warum nicht injizierbar:** `AdminThrottle` (`server/handler.ts:263-270`) hat **kein** `retryAfterSeconds`-Member — der Wert entsteht ausschließlich in `verifyOperatorSecret()` (`server/admin.ts:222`) aus der modul-privaten Konstante `300`. Ein „Fake-Throttle mit 42" ist damit nicht darstellbar; ein solcher Test würde eine API-Änderung an `server/admin.ts` **und** an der `/admin`-Authentifizierung verlangen.
    - **Konsequenz für die Prüfung:** die Ein-Quellen-Eigenschaft ist über die **beobachtbare** Gleichheit von Header und Body belegt (beide `300`), nicht über eine Stub-Injektion. AC-L30 und die zugehörige §9-Zeile assertieren `retry-after === "300"` **und** `300` im gerenderten Fehlertext; die strukturelle Zusage („kein Literal im Launcher") steht als Regel hier und wird im Code-Review geprüft.
    - **Keine Änderung an `server/admin.ts`:** `statusPayload()` ist dort die einzige Änderung (§10). `ADMIN_RETRY_AFTER_SECONDS` bleibt modul-privat.

### 5.2 `Origin` / `Sec-Fetch-Site`-Gate (normativ)

Gilt **nur** für `POST` und läuft in `launcherHeadRefusal()` **vor** jedem Body-Read und vor `verifyOperatorSecret()`.

```ts
/**
 * The origin a page served by this hub reports in `Origin`: the forwarded chain first
 * (`x-forwarded-host` + `x-forwarded-proto`), `Host` as the fallback. `null` when it cannot be
 * derived — the caller refuses with 403 rather than guessing.
 */
export function launcherOriginBasis(
  request: Pick<ServerRequest, "headers">,
): string | null;
```

1. **Basis-Ableitung:** Der Wert wird als Liste gelesen (Split an `,`), jedes Element getrimmt und lower-case; verwendet wird jeweils der **erste nicht-leere** Wert. Host = erster nicht-leerer Wert von `x-forwarded-host`; gibt es keinen (Header fehlt, ist leer oder enthält nur Leer-/Komma-Elemente), der erste nicht-leere Wert von `Host`; auch der fehlt oder ist leer → `null` → **403** (fail-closed). Damit ist der Fall `X-Forwarded-Host: , hub.example.com` eindeutig definiert: `hub.example.com`. Scheme = erster nicht-leerer Wert von `x-forwarded-proto`; `https` → `https`, alles andere oder keiner → `http`. Die Basis ist eine **normalisierte Origin**: Scheme und Host lower-case, Default-Port entfernt (`:80` bei `http`, `:443` bei `https`), kein Pfad, keine Query, kein Fragment, kein Userinfo. `https://a:443` == `https://a`; `http://a` ≠ `https://a` (Scheme bleibt Bestandteil, wie in `SPEC-viewer-origin` AC-F21).
2. **Trust-Entscheidung (normativ, bewusst abweichend von `publicOrigin()`):** `x-forwarded-proto` und `x-forwarded-host` werden für **diese** Vergleichsbasis von **jedem** Peer ausgewertet, nicht nur von einem Loopback-Peer. Begründung: der abgeleitete Wert entscheidet **nichts** über ein Credential, ein Cookie oder eine URL — er entscheidet nur, ob ein **vom Browser gesetzter** `Origin` passt.
   - Ein Browser kann die Header auf dem Formularpfad nicht setzen (ein `<form>` kann keine Header setzen), und ein `fetch` mit Custom-Headern bräuchte einen Preflight, den der Launcher nie erteilt (Zeile 18 der Routen-Matrix ist `405` mit `Allow: GET, POST`; kein CORS-Grant).
   - Ein Nicht-Browser-Client kann `Origin` ohnehin frei wählen und braucht das Gate nicht; er kann das Secret im Header senden.
   - Der einzige „Gewinn" eines gefälschten `https` wäre, dass ein Browser-Request mit `Origin: https://…` akzeptiert wird — genau der Fall, den die dokumentierte TLS-Proxy-Topologie braucht. Ein Cross-Site-Browser-Request bleibt an seinem **eigenen** `Origin` und an `Sec-Fetch-Site: cross-site` hängen.
   - `publicOrigin()` (Cookie-`Secure`, absolute Links) bleibt unverändert **konservativ** (Loopback-Trust, `viewer.ts:640-654`). Die Asymmetrie ist beabsichtigt und in §12 RK-L7 als Risiko geführt.
3. **Proxy-Vertrag (verbindlich; `docs/VIEWER.md`, Abschnitt „Reverse proxy (nginx)"):**
   ```nginx
   proxy_set_header Host              $http_host;
   proxy_set_header X-Forwarded-Proto $scheme;
   ```
   - `$http_host`, **nicht** `$host`: `$host` verwirft den Port, und bei einem öffentlichen Nicht-Default-Port wäre die Basis dann portlos und der `Origin` des Browsers passte nicht. `docs/VIEWER.md:239`/`:251` zeigen heute `$host` und werden auf `$http_host` korrigiert (§10).
   - nginx' Default `Host $proxy_host` liefert `http://<upstream-name>:<port>` als Basis; der Browser sendet `https://hub.example.com` → **403**. Ohne `X-Forwarded-Proto` ist die Basis `http://…`; hinter TLS → **403**. Beides ist fail-closed und in `docs/VIEWER.md` als Betriebsbedingung zu nennen.
   - Der Vertrag ist im Repo bereits gelebte Praxis: `docs/VIEWER.md:231-255` setzt `Host` und `X-Forwarded-Proto` in beiden `server`-Blöcken; nur die `$host`-Schreibweise wird korrigiert.
4. **`Origin`-Header:**
   - **fehlt** → wird nicht verlangt (curl und Skripte senden keinen `Origin`; der Header ist kein Credential und sein Fehlen kein Angriffssignal).
   - **`null`** (sandboxed iframe, `file://`-Dokument, manche Redirect-Ketten) → **403**, ohne Auswertung. `null` ist kein Origin und kann nicht passen.
   - **mehrwertig** (mehr als ein Wert, also ein `,` im Rohwert) → **403**, **nicht** geparst. Ein Request mit mehreren `Origin`-Werten ist kein Browser-Request.
   - **nicht parsebar**, oder mit Pfad, Query, Fragment, Userinfo, Whitespace → **403**.
   - **vorhanden und normalisiert ≠ Basis** → **403** `forbidden_origin`.
5. **Keine Verwendung von `viewer.hubOrigin` als Basis (Entscheidung gegen die im Review bevorzugte Option (a)).** `hubOrigin` ist **nicht** die öffentliche Hub-Origin, sondern die **Bind**-Origin des Hubs: `viewer.ts:111-116` („The hub's **bind** origin … Never … the public hub origin: `startHub()` sets it only when the hub bind is loopback"), gesetzt in `hub.ts:2066-2068`, und `tests/unit/helpers/viewer-harness.ts:34-35` führt es entsprechend als `http://127.0.0.1:8787`. Daraus folgt zweierlei:
   - In der heute brechenden Topologie ist es **gar nicht gesetzt**: `docker/entrypoint.sh:130` startet mit `--host 0.0.0.0`, `isLoopbackAddress("0.0.0.0")` ist `false` → `hubOrigin === undefined`.
   - Wo es gesetzt ist (Loopback-Bind), wäre es `http://127.0.0.1:<port>` und würde den Fehler **erzeugen**, den es beheben soll: ein Browser hinter einem TLS-Proxy auf demselben Host sendet `Origin: https://hub.example.com`, die Basis wäre `http://127.0.0.1:8787` → 403.
   Eine explizit konfigurierbare öffentliche Hub-Origin existiert im Repo nicht (nur `--viewer-origin` für die Viewer-Fläche; `hub.ts:2064-2065`: „a public hub origin behind a proxy is not known to this process"), und ein neues Flag ist außerhalb des Scope (§1.3, §11). Die Forwarded-Kette ist deshalb die einzige Basis, die beide Topologien ohne neues Flag trägt.
6. **`Sec-Fetch-Site`:** ist der Header vorhanden und lautet sein erster Wert (getrimmt, lower-case) exakt `cross-site` → **403**, auch wenn `Origin` fehlt oder passt. `same-origin`, `same-site`, `none` und jeder unbekannte Wert werden ignoriert. `Sec-Fetch-Site` kann von Skripten nicht gesetzt werden (forbidden header) — deshalb ist er die stärkere Aussage und wird nicht durch ein passendes `Origin` überstimmt.
7. **Kein Nebeneffekt:** Die Ablehnung liest kein Secret, ruft kein `tickets.mint()`, verbraucht kein Budget und loggt keinen Header-Wert. Sie schreibt den abgelehnten `Origin`-Wert **nicht** in den Antwortkörper (nur der generische Code `forbidden_origin` + Meldung `launcherForbidden`).
8. **Kein Gate für `GET`:** Ein `GET` ist eine Navigation, ändert keinen Zustand und kann kein Secret im Body tragen. Ein Gate dort würde nur legitime Lesevorgänge brechen.

### 5.3 Body-Read und Dispatch-Reihenfolge (`server/hub.ts`, normativ)

**Anker:** `respond()` behandelt den Launcher heute in `server/hub.ts:1095-1105` — **vor** `hubViewerPathRefusal()` (`:1111`), vor Journal/Static und **vor** `earlyRefusal()` (`:1156`). Der dort gebaute `ServerRequest` hat kein `body`. Genau das ändert diese Spec.

`respond()`-Reihenfolge (verbindlich, unverändert bis auf den Launcher-Block):

```
hostRefusal()                                    // :1085 — unverändert zuerst
surface === "hub" && isViewerStartRequest(url)   // :1095 — Launcher-Block, jetzt mit POST
    ├─ launcherHeadRefusal(...)                  //   NEU: 405/503/403/415/413 ohne Body, mit connection: close
    ├─ ggf. readBody(request, 8 KiB)             //   NEU: nur wenn launcherDeclaresBody(request); der BESTEHENDE Reader, eigenes Limit
    └─ handleViewerStart({..., body}, context)   //   :1097 — dieselbe Funktion, ein Mint
hubViewerPathRefusal()                           // :1111 — unverändert
viewerSurfaceRefusal()                           // :1116 — unverändert
Viewer-Door handleViewer()                       // :1127 — unverändert
Journal → --root-Static → earlyRefusal() → readBody() → gateRequest()/handleAdmin()
```

Verbindliche Eigenschaften:

1. **`earlyRefusal()` wird nicht umgangen und nicht verändert.** Der Launcher liegt wie heute **vor** `earlyRefusal()`; das ist zulässig, weil der Launcher-Pfad selbst alle Gates in der Reihenfolge aus §5.1 Regel 2 anwendet und weil `hostRefusal()` bereits gelaufen ist. Der Launcher liest **niemals** den Store und **niemals** mehr als `VIEWER_LAUNCHER_MAX_BODY_BYTES`. Die Viewer-Bypass-Bedingung in `earlyRefusal()` (`:1063`, surface-gated) bleibt unangetastet; sie betrifft nur Viewer-Pfade, nicht den Launcher.
2. **Der Launcher bleibt vor `gateRequest()`.** `gateRequest()` würde für `/viewer/start` den Unknown-Path-`404` liefern; der Launcher ist keine Router-Route. Diese Positionierung ist bestehender Vertrag (`SPEC-viewer-origin` §2.1 Regel 8) und wird nicht verschoben. Aus demselben Grund gelten `--read-only`, `--cors` und der Preflight-Pfad für den Launcher nicht (§3).
3. **Body-Read nur wenn nötig:** gelesen wird ausschließlich für `POST`, nachdem `launcherHeadRefusal()` `null` geliefert hat, und nur wenn der Request einen Body deklariert.
   **Die Frage „deklariert dieser Request einen Body?" beantwortet an beiden Stellen dieselbe Funktion: `launcherDeclaresBody(request)` (§5.1)** — einmal in der Glue (`server/hub.ts`, vor `readBody()`) und einmal mittelbar in `launcherHeadRefusal()` für die 415-/413-Regel (§5.1 Regel 6). Es gibt **keine** zweite, inline formulierte Kopie: der heutige Ausdruck in der Glue (`hub.ts:1112-1116`, `Number(headers["content-length"]) > 0 || headers["transfer-encoding"] !== undefined`) entfällt und wird durch den Import ersetzt (§10). Die Antwort ist an beiden Stellen identisch, auch für den ersten Wert einer Header-Liste.
   - `launcherDeclaresBody(request) === true` → **lesen**;
   - `false` → **`body = ""` ohne Read**. Kein `content-length` **und** kein `transfer-encoding` heißt nach HTTP/1.1: kein Body.
   Ein `GET` liest nie einen Body. Ein `POST` mit `content-length: 0` liest nie einen Body.
4. **Kein eigener Reader — `readBody()` wird wiederverwendet.** `readBody()` (`hub.ts:858`) liegt im **selben** Modul wie der Launcher-Block, ist also ohne neuen Export erreichbar, und seine Semantik ist genau die, die hier gebraucht wird:

   | Fall | Verhalten |
   |---|---|
   | deklarierte `content-length > limit` | `launcherHeadRefusal()` hat bereits **413** geantwortet und den Body **nicht** gelesen. Der Pre-Check in `readBody()` ist damit unerreichbar (Defense in Depth) — er würde den Socket zerstören. |
   | Überschreitung **beim Streamen** (Lügen-`content-length`, `chunked`) | `readBody()` verwirft die gepufferten Chunks, ruft `request.destroy()` und rejectet mit `BodyTooLargeError`. Der Launcher antwortet **nicht** (ein zerstörter Socket kann keine Antwort tragen); es gilt dieselbe Zeile wie im Glue: `if (!response.writableEnded && !response.destroyed) response.end(); return;` (`hub.ts:1166-1171`). Kein Ticket, kein Budget. |
   | `aborted` / `error` (Transport) | ebenfalls **keine Antwort**: dieselbe Guard-Zeile, dann `return`. Der Launcher-Zweig schreibt **nie** einen `400 invalid_json`-Körper (das ist der generische `readBody()`-Pfad des API-Routers, nicht der des Launchers). Begründung: ein Body-Read scheitert nur, wenn der Client weg ist oder der Socket gebrochen ist; eine 400 auf einen toten Socket ist Rauschen. |

   Damit entfällt ein zweiter Body-Reader vollständig: kein `readLauncherBody()`, kein `LauncherBodyRead`-Typ, keine eigene `pause`/`destroy`/`finish`-Ordnung, kein `BodyTooLargeError`-Wurf aus dem Launcher-Code. Die **einzige** Zusatzregel gegenüber dem API-Pfad ist der vorverlagerte 413 für den **deklarierten** Overshoot (§5.1 Regel 6) — er ersetzt den Socket-Abbruch durch eine lesbare Formularseite, und genau dafür trägt er `connection: close`.
5. **Limit-Begründung:** `MAX_BODY_BYTES` = 8 MiB ist für Notiz-Bundles dimensioniert. Der Launcher trägt **ein** Feld; 8 KiB erlauben ein Secret von ~2700 Bytes nach worst-case 3×-Prozentkodierung (jedes Byte als `%XX`) und decken damit jedes realistisch konfigurierte `--admin-secret` ab, während ein Angreifer ohne Secret höchstens 8 KiB in den Prozess schreiben kann. 8 KiB ist damit die kleinste Zahl, die kein legitimes Secret abschneidet.
6. **`aborted`/`error` ist kein 400:** siehe Regel 4, dritte Zeile. Es gibt auf dem Launcher-Pfad genau drei Ausgänge aus dem Read: `body`, „413 vorher beantwortet" (dann kein Read) und „keine Antwort".
7. **Der Handler bleibt synchron und pur.** `handleViewerStart()` bekommt den Body über das bestehende Feld `ServerRequest.body` (`server/handler.ts:182`) — keine Signaturänderung, kein `async`, kein zweiter Mint-Pfad. Unit-Tests rufen ihn direkt mit `{method:"POST", body:"secret=…"}` auf.
8. **Doppelte Gate-Ausführung ist gewollt:** `launcherHeadRefusal()` läuft einmal in der Glue (vor dem Read) und einmal am Anfang von `handleViewerStart()` (Defense in Depth, damit ein direkter Handler-Aufruf dieselben Antworten gibt). Wie bei `adminGate()`/`handleAdmin()` ist der zweite Aufruf idempotent und ohne Budgetwirkung.
9. **Kein Durchfallen (verbindlich):** Sobald `readBody()` für den Launcher gelaufen ist — erfolgreich **oder** mit Fehler — antwortet der Branch und kehrt zurück. Er fällt **nie** in den Journal-, Static-, `earlyRefusal()`- oder `readBody()`-Pfad des API-Routers durch; ein zweiter Read auf demselben Socket wäre ein hängender Request. Diese Regel steht als Kommentar an der Aufrufstelle:
   ```ts
   // The launcher answers or consumes the body itself and returns; it never falls through to the
   // journal, the static site, earlyRefusal() or the router's readBody().
   ```

### 5.4 Antwortformen des Launchers

- **`302` (GET) / `303` (POST, html):** `location: "<viewer.origin><base>/viewer?ticket=<48 hex>"`, `referrer-policy: no-referrer`, `cache-control: no-store`, Body `""`, **kein** `set-cookie`, **kein** `connection: close` (der Body ist gelesen bzw. es gab keinen). `viewer.origin` wird mit entferntem Trailing-Slash verwendet, `base` ebenfalls (bestehende Berechnung, `viewer.ts:764-765`).
- **`200` (POST, json):** `{"url": "<dieselbe Location>"}`; Header `content-type: application/json; charset=utf-8`, `cache-control: no-store`; **kein** `location`, **kein** `set-cookie`, **kein** `referrer-policy` nötig (kein Navigationsziel).
  **Warum 200 und nicht 303:** `fetch()` folgt einem 303 automatisch; die Anfrage wechselt dabei die Origin (Hub → Viewer) und der Browser darf `Set-Cookie` aus dieser Cross-Origin-Weiterleitung nicht als Same-Origin-Cookie des Hubs behandeln; die Antwort wäre für das Skript zudem `opaque` und damit unlesbar. Der JSON-Pfad liefert deshalb die URL **als Daten** und die Navigation macht `location.assign()` — genau ein Navigationsvorgang, ein Ticket, kein Folgen durch das Skript.
- **`401`/`403`/`413`/`415`/`429` (mit Meldung):** im verlangten Format (§3 Status-Tabelle). HTML = Formular **mit** Fehlerblock aus §5.8 (`launcherInvalidSecret` / `launcherForbidden` / `launcherBodyTooLarge` / `launcherUnsupportedBody` / `launcherThrottled`). JSON-Körper unverändert `{"error":{"code":…,"message":…}}` mit den Codes `unauthorized`, `forbidden_origin`, `payload_too_large`, `unsupported_media_type`, `too_many_attempts`. `429` trägt `retry-after: String(verdict.retryAfterSeconds)` (aus dem Verdict, nicht hartkodiert — heute `300`, §5.1 Regel 11) **und** dieselbe Zahl im HTML-Fehlertext.
- **`405` (ohne Meldung):** im verlangten Format, aber HTML rendert das Formular **ohne** `.bp-error`-Block (kein `role="alert"`, kein Meldungstext — §3 Status-Tabelle, `server/viewer.ts:830-831`); der JSON-Körper ist unverändert `{"error":{"code":"method_not_allowed","message":…}}`. `405` trägt `allow: "GET, POST"` und `connection: close`; kein Ticket, kein Budget.
- **`connection: close`:** genau auf den Antworten, die **ohne** Body-Read entstehen: `405`, `503`, `403`, `415`, `413`. Diese fünf Status tragen den Header **immer**, auch wenn der Request zufällig keinen Body deklariert hat — die Regel ist absichtlich gröber als nötig, damit kein Zweig sie vergessen kann. `401`, `429`, `200`, `303` tragen ihn **nie**.
- **`413`-Umfang (präzise):** zugesagt ist **nur** der deklarierte Fall — eine parsebare `content-length > 8192`. Ein Body, der das Limit erst beim Streamen überschreitet, wird wie bei `readBody()` abgebrochen: **keine HTTP-Antwort**, kein Ticket, kein Budget (§3 Zeile 17). Wer eine lesbare 413 auch für diesen Fall will, müsste den Body weiterlesen, den der Hub gerade abgelehnt hat — genau das schließt `SEC-08` aus.
- **`503`:** unverändert JSON (`service_not_ready`), `retry-after: 1`, `connection: close`, kein `location`, kein `set-cookie`.
- **`403`-Meldung:** generisch („this form was submitted from another site"), ohne den abgelehnten `Origin`-Wert zu wiederholen.
- **`HEAD`:** fällt in das Methodengate (`405`). Status und Header werden wie bei den anderen Formen gesetzt; `node:http` verwirft den Körper einer `HEAD`-Antwort, es entsteht also nie ein Body, den ein Client als Antwort auf `HEAD` missverstehen könnte.

### 5.5 `server/launcher-html.ts` (neu) — der Renderer

```ts
import type { AdminStrings } from "./admin-i18n";

/**
 * The launcher page: one form, no script, no external resource. Every string comes from the shared
 * admin table (FR-6.30); `error` is already localised by the caller.
 */
export function renderLauncherHtml(
  strings: AdminStrings,
  options: { action: string; error?: string },
): string;

/** Substitutes `{name}` placeholders exactly like the admin page's `fmt()`. */
export function fillTemplate(template: string, vars: Record<string, string | number>): string;
```

Regeln: `escapeHtml()` wird aus `server/html.ts` importiert (neu, §5.9) — keine zweite Escaping-Implementierung (FR-9.3: Nutzertexte immer als Text). `options.action` und `options.error` werden escaped. Die Seite enthält `<meta charset="utf-8">`, `<meta name="viewport" …>`, `<title>{launcherTitle}</title>`, den `<style>`-Block mit `--bp-*`-Properties und `bp-`-Klassen, `<h1>`, den Fehlerblock (falls `error`) **direkt nach dem `<h1>`** mit `role="alert"`, den Hilfeabsatz, das Formular aus §4. Das Secret-Feld trägt immer `autofocus`. Kein `<script>`, kein `<link>`, kein `<img>`, kein `on*`-Attribut.

### 5.6 `server/admin.ts` — `/admin/status` meldet den Viewer

```ts
function statusPayload(context: HandlerContext, registry: RegistryRead): Record<string, unknown> {
  return {
    // … existing fields unchanged …
    /**
     * FR-6.29: whether this hub can open the viewer and where it lives. Never a secret, never a
     * ticket. Deliberately absent from the credential-free `/config`.
     */
    viewer: {
      enabled: context.viewer !== undefined,
      origin: context.viewer?.origin ?? null,
    },
  };
}
```

Regeln: `origin` ist die aufgelöste öffentliche Origin (ohne Trailing-Slash) oder `null`; mit `--viewer` aus ist das Feld exakt `{enabled:false, origin:null}` (kein `undefined`, kein fehlendes Feld — der Admin-Seite soll ein stabiler Typ genügen). **Ein dritter Zustand ist real und erlaubt:** im Startfenster ist `context.viewer` gesetzt, `viewer.origin` aber noch `undefined` → `{enabled:true, origin:null}`. Die Admin-Seite muss ihn als „noch nicht bereit" behandeln (§5.7), nicht als „aktiviert" — sonst schriebe sie „The viewer opens at null." **Nicht** in `/config` (`server/handler.ts` `configResponse`), **nicht** in `src/federation/client.ts`/`federator` — beide werden nicht angefasst. `statusPayload()` bleibt die einzige Stelle, die `viewer` kennt.

### 5.7 `server/admin-html.ts` — ein Control im Overview-Panel

**Platz:** Übersicht-Panel (`#panel-overview`), **nicht** ein fünfter Tab. Begründung: ein Tab ist ein Navigationsziel mit eigenem Panel, `role="tab"`, `aria-controls`, `tabindex`-Rotations- und Arrow-/Home-/End-Logik (`admin-html.ts:611-628`). Für genau einen Button wäre das die größere Änderung mit dem größeren Regressionsrisiko; das Overview-Panel ist der Ort, an dem „was ist dieser Hub" steht, und `viewer` ist eine Hub-Eigenschaft.

```html
<!-- inside #panel-overview, before #overview-card -->
<div class="bp-row" id="viewer-row">
  <button type="button" class="bp-primary" id="open-viewer" aria-describedby="viewer-note">…</button>
  <span class="bp-status" id="viewer-status" role="status" aria-live="polite"></span>
</div>
<p class="bp-muted" id="viewer-note"></p>
```

| Aspekt | Vorgabe |
|---|---|
| Payload-Zugriff | `renderOverview()` beginnt mit `var viewer = status.viewer \|\| { enabled: false, origin: null };` und greift **nur** auf `viewer.enabled`/`viewer.origin` zu. Kein unguarded `status.viewer.enabled`: ein älterer Hub (0.14.0) antwortet ohne das Feld, und die Seite darf daran nicht mit einer `TypeError`-Console-Zeile scheitern |
| Label | `launcherSubmit` („Open viewer" / „Viewer öffnen") als `textContent` des Buttons — sichtbarer Name, kein `aria-label` nötig |
| Aktiv-Kriterium | Das Control ist **nur** bedienbar, wenn `viewer.enabled === true` **und** `typeof viewer.origin === "string"` **und** `viewer.origin !== ""`. Sonst ist es `disabled` und `#viewer-note` trägt einen Text, der in **diesem** Zustand wahr ist. Das Kriterium wird **einmal** berechnet (`var ready = viewer.enabled === true && typeof viewer.origin === "string" && viewer.origin !== "";`) und für `disabled` **und** die Notiz verwendet — kein zweiter, abweichender Ausdruck. Begründung (RVW2-3): `statusPayload()` liefert im Startfenster `{enabled:true, origin:null}` (§5.6); ohne dieses Kriterium rendert `fmt(T.launcherViewerAt, { origin: null })` den Satz „The viewer opens at null." und ein Klick liefe in ein `503` |
| Deaktiviert, `enabled === false` | `#viewer-note` = `launcherViewerOff`. Begründung: `disabled` (nativ) statt `aria-disabled`, weil FR-6.29 „disabled" verlangt und weil die Information nicht verloren geht — der Grund steht als Text daneben; `aria-disabled` würde ein fokussierbares Control hinterlassen, das wie bedienbar aussieht und dessen Klick man dann zusätzlich abfangen müsste. **Zugesagte Eigenschaft (FR-6.29, AC-L23):** das Control ist `reachable when enabled`; `when disabled it is intentionally out of the tab order and the reason is exposed as text via aria-describedby` |
| Deaktiviert, `enabled === true`, `origin` fehlt/leer | `#viewer-note` = `launcherViewerPending` (neuer Key, §5.8: „The viewer is not ready yet. Try again in a moment."). **Nicht** `launcherViewerOff`: der Viewer ist konfiguriert, nur noch nicht bereit — ein falscher Grund wäre schlechter als kein Grund. Kein Polling, kein Auto-Retry; der Operator verbindet die Seite neu |
| Notiz | `#viewer-note` wird **immer** gefüllt — in allen drei Zuständen (`launcherViewerOff`, `launcherViewerPending`, `fmt(T.launcherViewerAt, { origin: viewer.origin })`). Damit zeigt `aria-describedby` nie auf ein leeres Element, und jeder Satz ist in seinem Zustand wahr. Kein Zustand lässt `#viewer-note` leer |
| Busy | während des `fetch`: `button.disabled = true`, `say('viewer-status', T.launcherOpening, 'busy')`; **Erfolgsfall: kein Restore** — `location.assign()` navigiert das Dokument weg, ein Zurücksetzen wäre toter Code und würde nur einen Frame lang einen bedienbaren Button zeigen. Nach **Fehler**: `disabled = !ready` wiederherstellen, `say(..., message, 'error')` |
| Request | `call('/viewer/start', { method: 'POST' }, 'json')` — d. h. `x-bluepencil-admin: secret()` als Header, **kein** Body, `accept: application/json`; die Route liegt außerhalb `/admin`, deshalb setzt `call()` **kein** `x-bluepencil-auth` (Zeile „`call()`-Erweiterung" in dieser Tabelle) |
| Erfolg | `location.assign(body.url)` — die URL enthält nur das Ticket; das Secret lag nur im Header |
| 401 | `call()` wirft die Server-Meldung → `say('viewer-status', message, 'error')`, kein Navigieren, Button wieder aktiviert (`disabled = !ready`) |
| 403 | dito: `call()` wirft die Server-Meldung (`forbidden_origin` → `launcherForbidden`), `say('viewer-status', message, 'error')`, **keine** Navigation, **kein** automatischer Retry, Button wieder aktiviert (`disabled = !ready`). Die Meldung nennt den abgelehnten `Origin`-Wert nicht (§5.2 Nr. 7). Dieser Fall ist das sichtbare Fehlerbild eines Proxys, der den Vertrag aus §5.2 Nr. 3 nicht erfüllt (RK-L1) — eine Meldung, kein hängender Request |
| 429 | dito; die Meldung ist die **Server**-Meldung (`too many wrong operator-secret attempts …`), `retry-after` wird **nicht** ausgewertet und es gibt **keinen** automatischen Retry. Der Button wird wieder aktiviert (`disabled = !ready`), der Operator darf es erneut versuchen — der nächste Versuch scheitert erneut am Budget und bleibt eine sichtbare Meldung |
| 503 | dito (Startfenster) |
| Netzwerk-/CORS-Fehler | `call()` wirft `TypeError` → `say('viewer-status', fmt(T.launcherError, { message: error.message }), 'error')` |
| Tastatur/ARIA | keine Änderung an Tablist, `activateTab()`, Arrow-/Home-/End-Handling, `role`/`aria-selected`/`tabindex`. Der Button ist ein natives `<button type="button">` in Dokumentreihenfolge → Tab-Reihenfolge unverändert |
| Header-Disziplin | `x-bluepencil-admin` wird ausschließlich als Request-Header gesetzt, nie in eine URL, nie in `sessionStorage` (außer der bestehenden „Remember"-Option), nie geloggt. **`?k=` wird von der Admin-Seite nicht verwendet** (§2.5 Nr. 3) |
| `call()`-Erweiterung | `call(path, init, accept)` mit optionalem drittem Argument `accept: 'json'` (setzt `accept: application/json`); die `x-bluepencil-auth`-Zeile wird zu `if (path.indexOf('/admin') === -1 && path.indexOf('/viewer/start') === -1)` — der Launcher-Request trägt damit genau **ein** Credential |

### 5.8 `server/admin-i18n.ts` — 14 neue Keys

Alle Keys kommen in `interface AdminStrings` (eine Tabelle für beide Seiten, FR-6.30); `de` ist `AdminStrings` typisiert, ein fehlender Text ist damit ein Compile-Fehler. Wieder verwendet wird `secretLabel` („Admin secret"/„Admin-Secret") als `<label>`-Text der Launcher-Seite.

| Key | `en` | `de` |
|---|---|---|
| `launcherTitle` | `Bluepencil — viewer` | `Bluepencil — Viewer` |
| `launcherHeading` | `Viewer login` | `Viewer-Anmeldung` |
| `launcherHelp` | `The hub's admin secret (--admin-secret). It is sent once to this hub and traded for a one-time ticket — it never reaches the viewer origin.` | `Das Admin-Secret des Hubs (--admin-secret). Es wird einmal an diesen Hub gesendet und gegen ein Einmal-Ticket getauscht — es erreicht die Viewer-Origin nie.` |
| `launcherSubmit` | `Open viewer` | `Viewer öffnen` |
| `launcherInvalidSecret` | `The operator secret is not valid.` | `Das Operator-Secret ist nicht gültig.` |
| `launcherThrottled` | `Too many wrong attempts. Try again in {seconds} seconds.` | `Zu viele Fehlversuche. In {seconds} Sekunden erneut versuchen.` |
| `launcherForbidden` | `This form was submitted from another site.` | `Dieses Formular wurde von einer anderen Seite gesendet.` |
| `launcherBodyTooLarge` | `The submission was too large.` | `Die Übermittlung war zu groß.` |
| `launcherUnsupportedBody` | `The form could not be read.` | `Das Formular konnte nicht gelesen werden.` |
| `launcherViewerOff` | `The viewer is not enabled on this hub (--viewer).` | `Der Viewer ist auf diesem Hub nicht aktiviert (--viewer).` |
| `launcherViewerPending` | `The viewer is not ready yet. Try again in a moment.` | `Der Viewer ist noch nicht bereit. In einem Moment erneut versuchen.` |
| `launcherViewerAt` | `The viewer opens at {origin}.` | `Der Viewer öffnet unter {origin}.` |
| `launcherOpening` | `opening…` | `öffne…` |
| `launcherError` | `The viewer could not be opened: {message}` | `Der Viewer konnte nicht geöffnet werden: {message}` |

Regeln: Deutsch bleibt informell/neutral wie im Rest der Datei (kein „Sie", Imperativ wie „erneut versuchen"). `{seconds}`, `{origin}` und `{message}` werden **serverseitig** durch `fillTemplate()` (§5.5) ersetzt — die Launcher-Seite hat kein JavaScript; die Admin-Seite ersetzt `{message}`/`{origin}` clientseitig über ihr vorhandenes `fmt()`. Keine Easter Eggs, keine Emoji, kein Marketing. `server/admin-i18n.ts` dokumentiert in seinem Kopfkommentar, dass `{name}`-Platzhalter nun auch serverseitig (Launcher) ersetzt werden.

### 5.9 `server/html.ts` (neu) — eine Escaping-Implementierung

```ts
/** Escapes a string for HTML text and quoted attributes, including the single quote. */
export function escapeHtml(value: string): string;
```

Der Körper ist der heutige Block `server/admin-html.ts:31-38` (unverändert). `admin-html.ts` importiert ihn statt ihn zu definieren; `launcher-html.ts` ebenfalls. Grund: FR-9.3 („Nutzertexte immer als Text rendern") und die Regel „eine Implementierung" — zwei Escaper driften irgendwann.

## 6. Sicherheits-Header-Matrix

| Antworttyp | `content-type` | `cache-control` | `x-frame-options` | `content-security-policy` | `referrer-policy` | `location` | `set-cookie` | sonstiges |
|---|---|---|---|---|---|---|---|---|
| HTML 200 (Formular) | `text/html; charset=utf-8` | `no-store` | `DENY` | `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` | `no-referrer` | — | — | — |
| HTML 401 / 403 / 413 / 415 / 429 (Formular **mit** Meldung) | wie 200 | `no-store` | `DENY` | wie 200 | `no-referrer` | — | — | `429`: `retry-after`; `403`/`413`/`415`: `connection: close` |
| HTML **405** (Formular **ohne** Meldung — kein `.bp-error`-Block, §3 Status-Tabelle) | wie 200 | `no-store` | `DENY` | wie 200 | `no-referrer` | — | — | `allow: GET, POST`, `connection: close` |
| Redirect 302 / 303 | — (leerer Body) | `no-store` | — | — | `no-referrer` | `{viewer.origin}{base}/viewer?ticket=…` | **nie** | kein `connection: close` |
| JSON 200 (`{"url":…}`) | `application/json; charset=utf-8` | `no-store` | — | — | — | — | **nie** | — |
| JSON 401 / 429 | `application/json; charset=utf-8` | `no-store` | — | — | — | — | — | `429`: `retry-after: <verdict>` |
| JSON 403 / 405 / 415 | `application/json; charset=utf-8` | `no-store` | — | — | — | — | — | `405`: `allow: GET, POST`; alle drei: `connection: close` |
| JSON 413 | `application/json; charset=utf-8` | `no-store` | — | — | — | — | — | `connection: close` |
| JSON 503 (Startfenster) | `application/json; charset=utf-8` | `no-store` | — | — | — | — | — | `retry-after: 1`, `connection: close` |
| 404 (kein `--viewer`, Viewer-Fläche) | Router-/`viewerSurfaceRefusal`-Antwort, **unverändert** | | | | | | | |
| Antwort auf Zeile 17 (gestreamter Overshoot) | — keine Antwort, Socket-Abbruch — | | | | | | | |

Begründung der CSP-Abweichung von `/admin`: die Admin-Seite hat bewusst **kein** `default-src`, weil ihr Inline-`<script>` laufen muss. Die Launcher-Seite hat **kein** Skript und keine externe Ressource; `default-src 'none'` kostet dort nichts. `form-action 'self'` ist die einzige Direktive mit echter Schutzwirkung (sie verhindert, dass ein manipuliertes Dokument das getippte Secret an eine fremde `action` schickt) und ist additiv. `frame-ancestors 'none'` wird zusätzlich als `x-frame-options: DENY` gespiegelt (Alt-Agenten).

## 7. Datenfluss

**C — Browser ohne Secret (`GET`, `Accept` präferiert HTML)**

1. Browser → `GET {base}/viewer/start` (kein Secret).
2. `hostRefusal()` → `surface === "hub" && isViewerStartRequest()` → `handleViewerStart()`.
3. `launcherHeadRefusal()`: Methode ok, `origin` aufgelöst, kein CSRF-Gate (GET), keine Größenregel (kein Body).
4. `launcherFormat(accept)` = `html`; kein Secret präsentiert.
5. Antwort `200` HTML (kein `verifyOperatorSecret()`, kein Budget), `referrer-policy: no-referrer`.
6. Operator tippt das Secret, Submit → `POST` mit `secret=<wert>` im Body.

**C — Formular-POST**

1. Browser → `POST {base}/viewer/start`, `content-type: application/x-www-form-urlencoded`, `origin: https://hub.example.com`, `sec-fetch-site: same-origin`, `accept: text/html,…`.
2. Glue: `launcherHeadRefusal()` (405 → 503 → 403 → 415 → 413, jede Ablehnung mit `connection: close`) → `readBody(request, 8 KiB)`.
3. `handleViewerStart()` erneut: Gates idempotent → `launcherSecretFromBody(body)` → erster `secret`-Wert.
4. `verifyOperatorSecret(request, context, wert)` → `ok` (Budget-`success`) / `invalid` (`failure` oder `missing`) / `throttled` (`retryAfterSeconds`).
5. `ok` → `tickets.mint()` (ein Aufruf) → `303` mit `location` + `referrer-policy: no-referrer` + `cache-control: no-store`.
6. Browser folgt zur Viewer-Origin, löst `?ticket` ein (bestehender Pfad), bekommt `Set-Cookie` + `302 {base}/viewer`.
7. Persistenz: **keine**. Kein Store-Zugriff, kein Journal, keine Datei; nur der In-Memory-Ticketring (Cap 1024, TTL 60 s).

**B — Admin-Seite**

1. Operator ist auf `{base}/admin` verbunden (Secret in der Closure).
2. `connect()` → `call('/admin/status')` → `status.viewer = {enabled, origin}`; `renderOverview()` setzt `#open-viewer`, `#viewer-note` und `viewer = status.viewer || {enabled:false, origin:null}`.
3. Klick → `call('/viewer/start', { method: 'POST' }, 'json')` mit `x-bluepencil-admin` + `accept: application/json`, ohne Body, **ohne** `x-bluepencil-auth`.
4. Server: `launcherHeadRefusal()` (kein deklarierter Body → keine 415/413-Regel) → Header-Secret → `verifyOperatorSecret()` → `200 {"url": …}`.
5. `location.assign(url)` → Viewer-Origin → Ticket-Einlösung → Shell. Kein State-Restore: das Dokument navigiert weg.
6. Persistenz: keine; das Secret verlässt den Hub-Request nicht.

**Fehlerfluss:** jede Ablehnung endet in §3-Zeile mit definiertem Status und Format; es gibt keinen Pfad, der ein Ticket mintet, ohne vorher `verifyOperatorSecret()` mit `ok` durchlaufen zu haben. Der einzige Pfad ohne HTTP-Antwort ist §3 Zeile 17 (gestreamter Overshoot) — dort wird auch nichts gemintet.

## 8. Acceptance Criteria

Format: Given / When / Then, jeweils mit beobachtbarem Ergebnis. „Nicht-Browser" = Request ohne `Accept`-Header (wie curl). `{base}` ist in den Tests der Fixture-Base `/bluepencil/api` (`tests/unit/helpers/viewer-harness.ts:29`).

**`Host` in Handler-Tests (RVW2-4, verbindlich):** `request()` in `tests/unit/helpers/viewer-harness.ts:138-144` setzt ab dieser Änderung per Default `host: "127.0.0.1:8787"` (der Wert von `HUB_ORIGIN`, `:35`) und behält ihn bei explizit übergebenen Headern nur dann nicht, wenn der Aufrufer `host` selbst setzt. Ohne diesen Default lieferte `launcherOriginBasis()` `null` und **jeder** POST wäre `403` statt `401`/`303`/`429` — die POST-ACs wären nicht erfüllbar. AC-L33 (a)/(d) überschreiben den Default bewusst; AC-L12 sagt explizit `Host: vorhanden, Origin: nicht vorhanden`.

| ID | Given | When | Then |
|---|---|---|---|
| **AC-L01** | Hub mit `--viewer`, `viewer.origin` aufgelöst | `GET {base}/viewer/start` mit `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8` | **200**, `content-type: text/html; charset=utf-8`, `cache-control: no-store`, `x-frame-options: DENY`, CSP aus §6, `referrer-policy: no-referrer`; Body enthält genau **ein** `<input type="password" name="secret" autocomplete="off" required autofocus>`, ein `<form method="post"`, `action="{base}/viewer/start"`, `enctype="application/x-www-form-urlencoded"`, ein `<label for="secret">`, einen Submit-Button; **kein** `<script`, **kein** `on<event>=`, **keine** absolute URL im Body (das `action` ist ein base-präfixierter Pfad); `<html lang="en">`; kein Budget verbraucht (`throttle.allow` nicht aufgerufen) |
| **AC-L02** | dito | derselbe Request mit `Accept-Language: de` | `<html lang="de">`, Überschrift/Button/Label deutsch; kein englischer Satz und kein roher Key im Body |
| **AC-L03** | dito | `GET {base}/viewer/start` mit `Accept: */*` oder ohne `Accept` | **401** JSON `unauthorized` (unverändert), `content-type: application/json`; kein Budget |
| **AC-L04** | dito | `GET {base}/viewer/start?k=<richtig>` mit HTML-`Accept`; danach mit `x-bluepencil-admin` | jeweils **302**, `location` = `{viewer.origin}{base}/viewer?ticket=<48 hex>`, `referrer-policy: no-referrer`, `cache-control: no-store`, kein `set-cookie` |
| **AC-L05** | dito | `GET {base}/viewer/start?k=falsch` mit HTML-`Accept`, Budget frei | **401** HTML-Formular mit `launcherInvalidSecret`; kein `location`; der Wert `falsch` kommt im Body **nicht** vor; genau ein `failure` |
| **AC-L06** | dito | `POST {base}/viewer/start` mit `secret=<richtig>`, `Origin` passend, `content-type: application/x-www-form-urlencoded`, HTML-`Accept` | **303**, `location` = `{viewer.origin}{base}/viewer?ticket=<48 hex>`, `referrer-policy: no-referrer`, `cache-control: no-store`, kein `set-cookie`, kein `connection: close`, leerer Body; das Ticket lässt sich genau **einmal** einlösen |
| **AC-L07** | dito | derselbe POST mit `Accept: application/json` | **200**, `content-type: application/json`, Body exakt `{"url":"{viewer.origin}{base}/viewer?ticket=<48 hex>"}`, **kein** `location`, kein `set-cookie` |
| **AC-L08** | dito, Budget frei | POST mit `secret=falsch` (html) und mit `secret=falsch` (`Accept: application/json`) | **401** im jeweiligen Format; HTML-Fall zeigt das Formular mit `launcherInvalidSecret`; kein Echo des Werts in irgendeiner Antwort; je genau ein `failure` |
| **AC-L09** | dito, Budget frei | POST ohne Feld (`secret=` leer / Body `""` / kein Body / **nur** `?k=<richtig>` im URL) | **401**; `throttle.allow`, `failure` und `success` **nicht** aufgerufen (`missing: true`); kein Ticket. Ein `?k=` auf einem POST wird nicht gelesen: derselbe Fall mit `?k=<richtig>` und leerem Body ist ebenfalls **401** |
| **AC-L10** | dito | POST mit `secret=<richtig>`, aber `Origin: https://evil.example` | **403** `forbidden_origin`, `connection: close`; `tickets.size()` unverändert; **kein** `throttle.allow`/`failure`/`success`; Body nennt `evil.example` nicht |
| **AC-L11** | dito | POST mit `secret=<richtig>` und `Sec-Fetch-Site: cross-site`, **ohne** `Origin` | **403**; kein Ticket, kein Budget |
| **AC-L12** | dito | POST mit `secret=<richtig>`, **`Host` vorhanden** (`127.0.0.1:8787`), **`Origin` nicht vorhanden**, kein `Sec-Fetch-Site` (curl) | **303** (html) bzw. **200** (json) — der fehlende `Origin` blockt nicht; die Basis ist aus `Host` ableitbar, der Request fällt also nicht in den fail-closed-`403` |
| **AC-L13** | dito | POST mit `content-type: application/json` und nicht-leerem Body | **415** `unsupported_media_type`, `connection: close`; kein Ticket, kein Budget |
| **AC-L14** | dito | POST mit **deklariertem** `content-length: 9000`, Body wird **nicht gesendet** (der Client schreibt danach nichts mehr, hält die Verbindung aber offen, bis die Antwort kommt) | **413** `payload_too_large`, `connection: close`, kein Ticket, kein `verifyOperatorSecret()`; der Status wird **geschrieben** und der Socket nach dem Flush geschlossen — kein Reset **vor** dem Schreiben. Ob der Client die Antwort noch liest, hängt davon ab, ob er zu diesem Zeitpunkt noch streamt (RK-L2) |
| **AC-L15** | dito | POST mit `secret=falsch&secret=<richtig>`; und mit `secret=<richtig>&secret=falsch`; und mit `secret=falsch` **plus** gültigem `x-bluepencil-admin` | erster Fall **401** (erster Wert gewinnt), zweiter **303**, dritter **303** mit genau einem `success` und **keinem** `failure` — der Header gewinnt gegen einen **falschen** Body-Wert |
| **AC-L16** | dito | POST mit `secret=a+b`, wenn das konfigurierte Secret `a b` ist; und mit `secret=%zz` | erster Fall **303** (`+` → Space), zweiter **401** ohne 500 (ungültige Prozentfolge bleibt literal) |
| **AC-L17** | dito | `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS` auf `{base}/viewer/start` | jeweils **405**, `allow: GET, POST`, `connection: close`; kein Ticket, kein Budget |
| **AC-L18** | Hub im Startfenster (`viewer.origin` unaufgelöst) | `GET` und `POST {base}/viewer/start` | beide **503** `service_not_ready`, `retry-after: 1`, JSON, `connection: close`, kein `location`, kein `set-cookie`, kein Mint, kein Budget |
| **AC-L19** | Hub **ohne** `--viewer` | `GET`/`POST {base}/viewer/start` | **404** (Router), JSON, kein Formular |
| **AC-L20** | Viewer-Fläche (zweiter Listener) | `GET`/`POST {viewer}{base}/viewer/start` | **404** `not_found` (unverändert) |
| **AC-L21** | Hub mit `--viewer`, angemeldeter Admin | `GET {base}/admin/status` mit `x-bluepencil-admin` | Body enthält `viewer.enabled === true` und `viewer.origin` = aufgelöste Origin; `GET {base}/config` (ohne Credential) enthält **keinen** `viewer`-Key |
| **AC-L22** | Hub ohne `--viewer`, angemeldeter Admin (nur mit `--admin-secret`) | `GET {base}/admin/status` | `viewer` exakt `{enabled:false, origin:null}` |
| **AC-L23** | Admin-Seite; (i) `viewer = {enabled:false, origin:null}`, (ii) `viewer = {enabled:true, origin:null}` (Startfenster), (iii) `viewer = {enabled:true, origin:"http://viewer.example:8788"}` | je Seite verbinden und `#open-viewer` betrachten und betätigen | (i) **`disabled`**, nicht in der Tab-Reihenfolge, `#viewer-note` = `launcherViewerOff`; (ii) **`disabled`**, `#viewer-note` = `launcherViewerPending` und enthält **nirgends** den Text `null`; (iii) fokussierbar und in der Dokumentreihenfolge des Overview-Panels, `#viewer-note` = `launcherViewerAt` mit der Origin. In (i) und (ii) löst ein Klick **keinen** `fetch` aus; in allen drei Fällen ist `#viewer-note` nicht leer und per `aria-describedby` verknüpft |
| **AC-L24** | Admin-Seite, `viewer.enabled === true` | `#open-viewer` mit der Tastatur fokussieren und aktivieren | genau ein `fetch` an `{base}/viewer/start` mit `x-bluepencil-admin`, `accept: application/json`, Methode `POST`, **ohne** `x-bluepencil-auth`, **ohne** Body; danach `location.assign(<url aus der Antwort>)`; die URL enthält `?ticket=` und **kein** Secret |
| **AC-L25** | Admin-Seite, `viewer.enabled === true`, `origin` gesetzt | Launcher antwortet `401`/`403`/`429`/`503`, alternativ schlägt `fetch` fehl | `#viewer-status` zeigt die Server- bzw. `launcherError`-Meldung mit `data-kind="error"`; keine Navigation; Button wieder aktiv; **kein** automatischer Retry — auch beim `403` (`forbidden_origin`), der auf einen falsch konfigurierten Proxy deutet (RK-L1) |
| **AC-L26** | Admin-Seite | Tablist mit Pfeilen/Home/End bedienen | Verhalten unverändert (vier Tabs, `aria-selected`, `tabindex`-Rotation wie zuvor); das neue Control ist per Tab erreichbar und liegt in der Dokumentreihenfolge des Overview-Panels |
| **AC-L27** | Repository | `npm run build`; `git diff --stat package.json` | keine neue `dependencies`-Zeile (NFR-4); kein neuer Build-Schritt, kein zusätzliches Bundle |
| **AC-L28** | alle Antworten der §3-Zeilen 1–19 — **einschließlich** der Antworten auf `?k=`-GETs | jede Antwort mit `location`, jeder Antwort-Body und jedes `set-cookie` | die `location` enthält `?ticket=<48 hex>` und sonst nichts; das Secret kommt in keiner `location`, keinem `set-cookie` und keinem Antwort-Body vor. **Einzige Ausnahme ist die Request-URL eines `?k=`-GET selbst** (dort steht das Secret als Query, §2.5); die Antwort auf denselben Request wird voll mitgeprüft. Für den empfohlenen Weg (Formular-Body, Header) ist das FR-6.21 wörtlich erfüllt; der `?k=`-Pfad ist die benannte Ausnahme und wird von dieser AC **nicht** für die Request-Zeile, wohl aber für die Antwort geprüft |
| **AC-L29** | dito | POST mit `transfer-encoding: chunked` und einem gestreamten Body von 9000 Bytes (keine `content-length`) | **keine HTTP-Antwort**: der Socket wird abgebrochen (Client sieht `ECONNRESET`/vorzeitiges Ende), wie bei `readBody()`; kein Ticket, kein `verifyOperatorSecret()`. Kein 413, kein 400 |
| **AC-L30** | dito, frisches, geleertes Budget | (a) 10 falsche Launcher-POSTs, dann ein 11. POST mit **richtigem** Secret; (b) 10 falsche Launcher-POSTs, dann `GET {base}/admin/status` mit **richtigem** Header; (c) umgekehrt: 10 falsche `/admin/status`-Versuche, dann ein POST mit **richtigem** Body | (a) **429** mit `retry-after: "300"` — der Wert aus `OperatorSecretVerdict.retryAfterSeconds` (`server/admin.ts:222`), **kein** Launcher-eigenes Literal — **und** der HTML-Body enthält `300` bei gesetztem `launcherThrottled` und kein rohes `{seconds}`; Header und Meldung stammen damit belegbar aus **einem** Verdict-Objekt (§5.1 Regel 11); (b) `/admin/status` **429** — der Launcher hat das `admin`-Budget verbraucht; (c) der Launcher-POST ist **429** — `/admin/status` hat es verbraucht. Eine Budget-Instanz, zwei Aufrufer, beide Richtungen belegt. **Kein injizierter `retryAfterSeconds`:** `AdminThrottle` (`server/handler.ts:263-270`) hat kein solches Member |
| **AC-L31** | **programmatischer** Hub: `context.viewer` gesetzt, `context.adminSecret` **nicht** (`ServerOptions.viewer` ohne `adminSecret`) | `POST {base}/viewer/start` mit `secret=<irgendetwas>` (html und json) | **401** im jeweiligen Format (`verifyOperatorSecret()` → `{kind:"invalid", missing:true}`, `admin.ts:211-218`); **kein** `throttle.allow`/`failure`/`success`, kein Ticket, keine `location` |
| **AC-L32** | dito, Budget frei | `POST` mit `secret=falsch` und `Accept-Language: de` (html) bzw. `GET` mit `?k=falsch` und `Accept-Language: de` | **401** HTML mit `lang="de"`, deutscher Überschrift/Button/Label **und** deutscher Meldung (`launcherInvalidSecret`), `role="alert"` auf dem Fehlerblock, `autofocus` auf dem Secret-Feld; kein englischer Satz, kein roher Key |
| **AC-L33** | dito | (a) `POST` mit `Host: hub.example.com`, `X-Forwarded-Proto: https`, `Origin: https://hub.example.com`; (b) `POST` mit `Origin: null`; (c) `POST` mit `Origin: https://a.example, https://b.example`; (d) `POST` mit `Host: 127.0.0.1:8787`, ohne Forwarded-Header, `Origin: http://127.0.0.1:8787`; (e) `POST` mit `X-Forwarded-Host: , hub.example.com`, `X-Forwarded-Proto: https`, `Origin: https://hub.example.com` | (a) **303** — die TLS-Proxy-Topologie aus `docs/DOCKER.md:314` funktioniert; (b) **403**; (c) **403** (nicht geparst); (d) **303** — die Topologie ohne Proxy funktioniert unverändert; (e) **303** — der erste **nicht-leere** Forwarded-Host-Wert (`hub.example.com`) wird verwendet, ein leeres Listenelement verschiebt die Basis nicht (§5.2 Nr. 1). In (a)–(e) kein Ticket bei 403, kein Budget bei 403 |

## 9. Test-Matrix

Neu: `tests/unit/viewer-launcher.test.ts` (Unit, `handleViewerStart`/`launcherHeadRefusal`/`launcherSecretFromBody`/`launcherFormat`/`launcherOriginBasis`/`launcherDeclaresBody`), `tests/unit/viewer-launcher-page.test.ts` (Renderer + i18n), `tests/unit/admin-viewer-control.test.ts` (Admin-Payload → Control-Vertrag, soweit ohne Browser prüfbar). Erweitert (5): `tests/unit/viewer-dispatch.test.ts` (Glue), `tests/unit/viewer-start.test.ts`, `tests/unit/server-admin-page.test.ts` (Strings/Control-Markup), `tests/unit/server-admin.test.ts` und `tests/unit/server-config.test.ts` (`statusPayload` / `/config` ohne `viewer`). Dazu additiv erweitert: `tests/unit/helpers/viewer-harness.ts` (Fixture, keine eigene Testdatei). Das sind **8 berührte Testdateien — 3 neu, 5 geändert** (RVW2-6).

| Fall | Datei | AC |
|---|---|---|
| `launcherFormat`: Browser-String → `html`; `*/*`, `application/json`, fehlend, `text/html;q=0` → `json`; `text/html;q=0.5, application/json` → `json`; Gleichstand → `html` | `viewer-launcher.test.ts` | AC-L01, L03, L07 |
| GET + HTML-Accept + kein Secret → 200 Formular, Budget unberührt | `viewer-launcher.test.ts` | AC-L01 |
| GET + HTML-Accept + `?k` richtig/falsch; Header gewinnt; **GET + HTML + gültiger Header → 302** | `viewer-launcher.test.ts` | AC-L04, L05 |
| POST + `body: "secret=…"` richtig → 303/200, genau ein Mint, `location`-Form | `viewer-launcher.test.ts` | AC-L06, L07 |
| POST falsch → 401, kein Echo, ein `failure` | `viewer-launcher.test.ts` | AC-L08 |
| POST leer/fehlend → 401, `allow/failure/success` nicht aufgerufen; **zusätzlich: `POST` mit `?k=<richtig>` und leerem Body → 401, kein Budget, kein Ticket** | `viewer-launcher.test.ts` | AC-L09 |
| POST `Origin`-Mismatch/Sec-Fetch-Site → 403, kein Budget; ohne `Origin` → 303; **`Origin: null` → 403; mehrwertiger `Origin` → 403** | `viewer-launcher.test.ts` | AC-L10, L11, L12, L33 |
| `launcherOriginBasis`: `Host`+`X-Forwarded-Proto: https` → `https://<Host>`; `X-Forwarded-Host` gewinnt gegen `Host`; `X-Forwarded-Host: , hub.example.com` → `hub.example.com` (erster **nicht-leerer** Wert); `X-Forwarded-Host: ""` fällt auf `Host` zurück; kein Host → `null`; Default-Ports normalisiert; `http` ≠ `https` | `viewer-launcher.test.ts` | AC-L33 |
| POST `content-type` falsch → 415; deklarierte `content-length: 9000` → 413 mit `connection: close` und ohne `verifyOperatorSecret()` | `viewer-launcher.test.ts` | AC-L13, L14 |
| Duplikate, `+`/`%20`, `%zz` in `launcherSecretFromBody`; **Header gewinnt gegen falschen Body-Wert** | `viewer-launcher.test.ts` | AC-L15, L16 |
| Methode `PUT/PATCH/DELETE/HEAD/OPTIONS` → **405** + `Allow: GET, POST` + `connection: close`, kein Ticket, kein Budget; **HTML-Accept:** gültiges Formular (genau ein `name="secret"`-Feld mit `autofocus`, `action` = base-präfixiert) **ohne `.bp-error`-Block** — kein `<p class="bp-error">`, kein `role="alert"`, kein Meldungstext aus §5.8; **JSON-Accept:** `{"error":{"code":"method_not_allowed",…}}` | `viewer-launcher.test.ts` | AC-L17 (der „kein Fehlerblock"-Teil ist §3 Status-Tabelle / §4, keine eigene AC) |
| `launcherDeclaresBody`: erster `content-length`-Wert `"0"` → `false`; `"1"`/`"9000"` → `true`; Header-Liste `["9000","9000"]` → `true` (erster Wert); unparsebar (`"abc"`, leer) und fehlend → `false`; `transfer-encoding: chunked` **ohne** `content-length` → `true`; `transfer-encoding` **mit** `content-length: 0` → `true`; **ein** Request über die Glue liest genau dann einen Body (Roundtrip: Body-Feld kommt an, bzw. bodyloser POST verhält sich wie GET mit Header) | `viewer-launcher.test.ts` | AC-L06, L13, L14, L24 (§5.1 Regel 6, §5.3 Regel 3) |
| Startfenster: GET **und** POST → 503 | `viewer-launcher.test.ts` (`handleViewerStart` mit `viewer.origin: undefined`) | AC-L18 |
| Programmatischer Hub ohne `adminSecret`: POST → 401, kein Budget, kein Ticket | `viewer-launcher.test.ts` | AC-L31 |
| **Geteiltes Budget in beide Richtungen** — Handler-Ebene mit injiziertem `AdminThrottle` (`allow`/`failure`/`success` als `vi.fn()`): (a) 10 falsche Launcher-POSTs → 11. POST `429` mit `retry-after: "300"` **und** `300` im HTML-Fehlertext, kein `{seconds}`-Rest; (b) 10 falsche Launcher-POSTs → `adminGate()` `429`; (c) 10 falsche `adminGate()`-Versuche → Launcher-POST `429`. Die Sekundenzahl stammt aus `verifyOperatorSecret()` (`300`), **nicht** aus dem Stub — `AdminThrottle` hat kein `retryAfterSeconds`-Member (RVW2-1, §5.1 Regel 11) | `viewer-launcher.test.ts` (Fake-Throttle) | AC-L30 |
| **Geteiltes Budget, Integration:** 10 falsche Launcher-POSTs, dann `GET {base}/admin/status` mit **richtigem** Header → `429`; und umgekehrt | `viewer-dispatch.test.ts` | AC-L30 |
| Renderer: genau ein Passwortfeld, `required`, `autocomplete="off"`, `autofocus` (immer, auch mit `error`), kein `value`, `<label for>`, `action` = base-präfixiert, kein `<script`, keine externe URL, `lang` je Sprache, Fehlerblock direkt nach dem `<h1>` mit `role="alert"`, `error`-Block escaped (`<script>` im Fehlertext bleibt Text) | `viewer-launcher-page.test.ts` | AC-L01, L02, L08, L32 |
| **`launcherThrottled`-Render mit eingesetzten Sekunden:** `fillTemplate(T.launcherThrottled, { seconds: 300 })` enthält `300` und keinen `{seconds}`-Rest; englisch und deutsch. `300` ist derselbe Wert, den AC-L30 im Header assertiert | `viewer-launcher-page.test.ts` | AC-L30, L32 |
| i18n: `en`/`de` enthalten alle **14** Keys und keinen rohen Key; `de` ist typisiert; `launcherViewerAt` füllt `{origin}` | `server-admin-page.test.ts` (bestehend, erweitern) | AC-L02, L23 |
| Control-Vertrag: Markup enthält `#open-viewer`, `#viewer-status`, `#viewer-note`; `renderOverview` setzt `disabled` bei `enabled:false` **und** bei `{enabled:true, origin:null}`, füllt `#viewer-note` in **allen drei** Zuständen (`launcherViewerOff` / `launcherViewerPending` / `launcherViewerAt`) und schreibt nie `null`; `viewer`-Fallback greift bei fehlendem `status.viewer`; `call()`-Erweiterung setzt `accept` und lässt `x-bluepencil-auth` für `/viewer/start` weg; die Fehlerpfade von `openViewer()` (`401`, `403`, `429`, `503`, `TypeError`) setzen `#viewer-status` mit `data-kind="error"`, navigieren nicht und stellen `disabled = !ready` wieder her | `admin-viewer-control.test.ts` (Markup-/String-Assertions; kein Browser) | AC-L23, L24, L25, L26 |
| **Bestehend, umgeschrieben:** „405 with Allow: GET for every non-GET" → „405 with `Allow: GET, POST` für alles außer GET/POST mit `connection: close`"; POST mit gültigem Header ist jetzt **303** (heute 405). Zwei Assertions-Blöcke: `viewer-start.test.ts:191-227` | `viewer-start.test.ts` | AC-L17, L06 |
| **Bestehend, umgeschrieben (§3-Ordnungsbeleg):** der Test „wins over the start window" (`viewer-start.test.ts:214-226`) läuft mit `PUT` **und** `DELETE` statt `POST` — ein `POST` im Startfenster ist jetzt **503**, ein `PUT` bleibt **405** | `viewer-start.test.ts` | AC-L17, L18 |
| **Bestehend, umgeschrieben:** `viewer-dispatch.test.ts:387-394` — der POST mit `x-bluepencil-admin` erwartet heute `405`/`Allow: GET`; neu: **303** mit `location` (Header-Secret, kein Body) und ein eigener `PUT`-Fall für `405` + `Allow: GET, POST` | `viewer-dispatch.test.ts` | AC-L06, L17 |
| **Handler-Fixture:** `request(url, headers, method)` in `tests/unit/helpers/viewer-harness.ts:138-144` um einen optionalen `body?: string` erweitern **und** `host` per Default auf `127.0.0.1:8787` setzen (nur wenn der Aufrufer keinen eigenen `host`-Header übergibt). Beides additiv; ohne den `host`-Default wäre jeder POST-Test ein `403` (RVW2-4) | `helpers/viewer-harness.ts` | AC-L12, L09, L30, L31 |
| **Glue-Roundtrip über echten `node:http`-Server:** der dortige Helper `request(port, path, init)` (`viewer-dispatch.test.ts:92-119`) bekommt `body?: string` **und** einen `urlencoded(fields)`-Helfer (setzt `content-type` und `content-length`); Fälle: Formular-Body → 303; deklarierte 9000 Bytes → 413 mit vollständig gelesener Antwort und `connection: close`; **chunked 9000 Bytes → keine Antwort, Client sieht ein vorzeitiges Ende** | `viewer-dispatch.test.ts` | AC-L06, L14, L29 |
| GET ohne `--viewer` → 404; Viewer-Fläche → 404 | `viewer-start.test.ts` (bestehend) / `viewer-surface.integration.test.ts` | AC-L19, L20 |
| `statusPayload()` mit/ohne `context.viewer` → `{enabled,origin}` / `{enabled:false,origin:null}`; `/config` ohne `viewer`-Key | `server-admin.test.ts`, `server-config.test.ts` | AC-L21, L22 |
| Secret nie in einer **Antwort:** Assertion über jede 302/303-`location` (`/^https:\/\/view\.example\.com\/bluepencil\/api\/viewer\?ticket=[0-9a-f]{48}$/`, Fixture-Base `/bluepencil/api`), über den gesamten Antwortbody und über jedes `set-cookie` — **auch für die Antworten auf `?k=`-GETs**. Ausgenommen ist ausschließlich die **Request-URL** des `?k=`-GET (§2.5); kein `referer`-Wert wird geprüft, weil `referrer-policy: no-referrer` gesetzt ist und ein Antwort-Header kein `referer` erzeugt (RVW2-8) | `viewer-launcher.test.ts` | AC-L28 |

Nicht durch Unit-Tests abgedeckt (bewusst, kein Browser-Harness im Repo): das tatsächliche Absenden durch einen Browser, `location.assign()`, `disabled`-Optik, das Fokusverhalten von `autofocus`. Belegt durch Markup-/String-Assertions und die E2E-freie Testpolitik des Repos.

## 10. Auswirkungen auf bestehende Artefakte

| Datei | Änderung | Grund |
|---|---|---|
| `server/viewer.ts` | **acht** neue Exporte: `launcherFormat`, `launcherOriginBasis`, `launcherHeadRefusal`, `launcherSecretFromBody`, `launcherTooLargeAnswer`, `launcherDeclaresBody` (rev 4, CR-1 — ersetzt die private `declaresBody()` in `:857-861`), `VIEWER_LAUNCHER_MAX_BODY_BYTES`, `VIEWER_LAUNCHER_FIELD`; dazu der Typ `LauncherFormat`. `handleViewerStart` um POST/303/200 und HTML-Aushandlung erweitert; privates `surfaceOf` (`:673-675`) entfernt, Import aus `./handler`; `json()`/`text()`/`refusal()` bleiben lokal, `json()` wird für 200-JSON mitbenutzt | Kern der Änderung; eine Mint-Stelle bleibt |
| `server/hub.ts` | Launcher-Block (`:1095-1105`): `launcherHeadRefusal()` vor dem Read; Body über den **bestehenden** `readBody(request, VIEWER_LAUNCHER_MAX_BODY_BYTES)` (`:858`) statt eines eigenen Readers; `body` in den `ServerRequest`; `BodyTooLargeError`/Transportfehler → keine Antwort (`response.end()`-Guard wie `:1166-1171`); **Import von `launcherHeadRefusal` und `launcherDeclaresBody`** (nicht `launcherTooLargeAnswer`), womit die inline formulierte Body-Deklaration (`:1112-1116`) entfällt; Kommentar „never falls through" | Body-Read gehört zur Glue (Socket-Semantik), nicht in den puren Handler; ein Reader statt zwei, **eine** Body-Deklarations-Regel statt zwei (§5.3 Regel 3) |
| `server/admin.ts` | `statusPayload()` erhält `viewer: {enabled, origin}` | FR-6.29 |
| `server/admin-html.ts` | `escapeHtml` importiert statt definiert; Overview-Panel bekommt `#viewer-row`/`#open-viewer`/`#viewer-status`/`#viewer-note`; `renderOverview()` beginnt mit dem `status.viewer`-Fallback, berechnet `ready` einmal (`enabled === true && typeof origin === "string" && origin !== ""`), setzt `disabled = !ready` und füllt `#viewer-note` immer (drei Zustände, §5.7); `call(path, init, accept)` + `x-bluepencil-auth`-Ausnahme für `/viewer/start`; Klick-Handler `openViewer()` ohne Restore im Erfolgsfall, `disabled = !ready` nach Fehler | Variante B, kleinster Eingriff ohne Tablist-Umbau |
| `server/launcher-html.ts` (neu) | `renderLauncherHtml()`, `fillTemplate()` | Variante C; eigener Renderer, kein zweiter Tabellen-Ort |
| `server/html.ts` (neu) | `escapeHtml()` | eine Escaping-Implementierung (FR-9.3) |
| `server/admin-i18n.ts` | `AdminStrings` + `en` + `de` um 14 Keys erweitert; Kopfkommentar um die serverseitige Platzhalter-Ersetzung ergänzt | FR-6.30, kein Text außerhalb der Tabelle |
| `tests/unit/viewer-start.test.ts` | Methodengate-Block (`:191-227`) neu geschrieben: `Allow: GET, POST`, POST ist kein 405 mehr; der Startfenster-Test (`:214-226`) auf `PUT`/`DELETE` umgestellt (POST ist dort jetzt 503); GET-HTML-Aushandlung ergänzt | der alte Vertrag wird bewusst ersetzt |
| `tests/unit/viewer-dispatch.test.ts` | Launcher-Block (`:366-395`): POST erwartet 303 statt 405; `Allow`-Assertion an einen `PUT`-Fall; Body-Roundtrip/413/chunked-Abbruch ergänzt; der `node:http`-Helper (`:92-119`) bekommt `body` + `urlencoded()` | dito |
| `tests/unit/helpers/viewer-harness.ts` | `request(url, headers, method)` (`:138-144`) um `body?: string` erweitern **und** `host: "127.0.0.1:8787"` als Default setzen (additiv) | Handler-POST-Tests ohne handgebaute Objekte; ohne `Host` liefert `launcherOriginBasis()` `null` → falsches `403` |
| `tests/unit/viewer-launcher.test.ts`, `viewer-launcher-page.test.ts`, `admin-viewer-control.test.ts` (neu) | §9 | neue Verträge brauchen eigene Tests |
| `docs/VIEWER.md` | `:154-155` („The launcher is `GET`-only; any other method is `405` with `Allow: GET`") ersetzt: `GET` (Seite oder `302`) und `POST` (Formular → `303`, JSON → `200`, `Allow: GET, POST`); `:156` („A missing `x-bluepencil-admin` … is `401` and spends no `admin` budget") **neu formuliert**: ein **fehlendes** Secret ist für einen HTML-präferierenden Client `200` mit dem Formular, für jeden anderen `401` JSON (`unauthorized`) — in **beiden** Fällen **kein** `admin`-Budget; nur ein falscher Wert zählt; Routen-Matrix `:101-119` bekommt eine `POST`-Zeile und die HTML/JSON-Unterscheidung; Abschnitt „The launcher and one-time tickets" nennt das Formular und das CSRF-Gate | Betriebsdoku muss stimmen |
| `docs/VIEWER.md`, Abschnitt „Reverse proxy (nginx)" (`:231-255`) | beide Blöcke von `proxy_set_header Host $host;` auf `$http_host;` umgestellt, mit einem Satz, warum (Port gehört zur Origin) und was ohne die zwei Header passiert (fail-closed `403`) | exakter Proxy-Vertrag des CSRF-Gates (§5.2 Nr. 3) |
| `docs/specs/2026-11-06-viewer-origin-design.md` | datierter Nachtrag `## Revision 2026-11-08 (Issue #144)` am Dateiende: offene Frage 3 entschieden | §2.4 |
| `docs/reviews/2026-11-06-viewer-origin-spec-review.md` | datierter Nachtrag: Finding E3 `superseded`, Originaltext unverändert | §2.4 |
| `docs/specs/2026-11-06-viewer-origin-spec.md` | Nachtrag §13 bleibt inhaltlich; ergänzt nur den Satz, dass er die autoritative Liste der überholten Stellen ist (§2.4) | §2.4 |
| `CHANGELOG.md` | neuer Minor: `Added` (Launcher-Formular, `/admin/status.viewer`, Admin-Control), `Security` (Secret im Body statt URL, CSRF-Gate über `Origin`/`Sec-Fetch-Site`, CSP/`frame-ancestors`, 8-KiB-Limit), `Changed` (`Allow: GET, POST`, `?k=` bleibt nicht deprecated) | Release-Doku |
| `README.md` | Zeile 39-40 („the operator entry point is the hub launcher `{base}/viewer/start?k=`") und Zeile 64-68: Formular als Browser-Einstieg, `?k=`/Header als Skript-Einstieg | README ist das Aushängeschild; die heutige Zeile nennt nur `?k=` |
| `docs/REQUIREMENTS.md` | **keine** Änderung in dieser Spec — das FR-6.21-Delta (§2.5) liegt bei `requirements` | Requirement-Pflege liegt bei `requirements` |
| `spec/` | nichts von Hand; nach dem Merge `npm run spec` (generiert aus `docs/REQUIREMENTS.md`) | generiertes Artefakt |

**Dateizahl (Abgleich mit dem Kopf, RVW2-6):** 7 Produktionsdateien = 5 geändert (`viewer.ts`, `hub.ts`, `admin.ts`, `admin-html.ts`, `admin-i18n.ts`) + 2 neu (`launcher-html.ts`, `html.ts`). **8 berührte Testdateien = 3 neu** (`viewer-launcher.test.ts`, `viewer-launcher-page.test.ts`, `admin-viewer-control.test.ts`) **+ 5 geändert** (`viewer-start.test.ts`, `viewer-dispatch.test.ts`, `server-admin-page.test.ts`, `server-admin.test.ts`, `server-config.test.ts`) **+ 1 additiv erweiterte Fixture** (`helpers/viewer-harness.ts`, keine eigene Testdatei). Doku zählt nicht mit. Größenklasse bleibt **M**.

## 11. Out of scope

- Viewer-Feld in `/config`.
- Änderungen an Viewer-Proxy/SSRF, an der Ticket-TTL oder am Ticket-Cap.
- Viewer-Origin-Fläche (`/viewer`, `/view`, Assets, Bookmarklet, `notes*`, `sessions`, `bundle`).
- `docker-compose.yml`-Image-Pin, `docker/entrypoint.sh`, `opencode.json`, Extension, CLI-Flags.
- Neues CLI-Flag (auch kein `--public-hub-origin`) oder neuer `HubStartupErrorCode` (auch kein `viewer_requires_admin_secret`).
- Logout/Session-Reset für die Admin-Seite; „Secret merken" auf der Launcher-Seite.
- Ein Browser-/E2E-Harness für die Admin-Seite.
- Umformulierung von FR-6.21 in `docs/REQUIREMENTS.md` (liegt bei `requirements`, §2.5).

## 12. Offene Punkte + Risiken

**Geschlossen (nicht offen):**

- **„Hub ohne `--admin-secret`, aber mit Viewer."** `--viewer` erfordert `--admin-secret` (`server/hub.ts:2532-2534`); ein Viewer-fähiger Hub hat also **immer** ein Operator-Secret. Ein Hub ohne Secret hat kein `context.viewer`, damit keinen Launcher (`isViewerStartRequest()` → `false`) und keine Viewer-Fläche — die Frage kann nicht auftreten. Für den programmatischen Pfad (`ServerOptions.viewer` ohne `adminSecret`) ist das Verhalten fail-closed definiert und **getestet** (AC-L31): `verifyOperatorSecret()` liefert `{kind:"invalid", missing:true}` (`admin.ts:211-218`), also `401` auf jede Submission, ohne Budget; `--admin` bleibt `404`. Es wird **kein** neuer Startfehler eingeführt (Out of scope) — das ist die dokumentierte Konsequenz, kein offener Punkt.
- **„`?k=` deprecaten?"** Nein — FR-6.17/FR-6.21 halten es als benannten Kompatibilitätspfad (§2.5). Es bleibt unverändert dokumentiert.
- **„Viewer-Origin in `/config`?"** Nein — FR-6.29 schließt es aus.
- **„`viewer.hubOrigin` als `Origin`-Vergleichsbasis?"** Nein, entschieden und begründet (§5.2 Nr. 5): es ist die Bind-Origin, in der Proxy-Topologie nicht gesetzt, und würde im Same-Host-Proxy-Fall den 403 erzeugen.

**Echte offene Punkte:** keine.

**Risiken:**

| ID | Risiko | Wirkung | Umgang |
|---|---|---|---|
| RK-L1 | **Proxy-Vertrag nicht erfüllt:** der Proxy setzt `Host` (nginx-Default `$proxy_host`) oder `X-Forwarded-Proto` nicht → die Vergleichsbasis ist `http://<upstream>:<port>` bzw. `http://…`, der Browser sendet `https://hub.example.com` → `403` für legitime Browser | **Beide Browser-Einstiege scheitern** hinter einem so konfigurierten Proxy: das Launcher-Formular (C) bekommt `403`, und der Admin-Button (B) ebenso — sein `fetch` sendet `Origin` wie jeder Browser und wird vom **selben** Gate abgelehnt. Fail-closed, kein Sicherheitsverlust, aber ohne Proxy-Korrektur ist die Browser-UI unbenutzbar | Exakter Zwei-Zeilen-Vertrag in §5.2 Nr. 3 und in `docs/VIEWER.md` (inkl. `$http_host` statt `$host`); Fehlerbild ist ein sichtbares `403` auf Formular **und** Admin-Control (AC-L25), kein hängender Request. Kein stiller Fallback auf „Origin ignorieren". **Wer den Proxy nicht ändern kann:** der Header-Weg (`x-bluepencil-admin`) hilft **nur Nicht-Browser-Clients** (curl, Skripte) — er stellt die Browser-UI nicht wieder her, weil auch der `fetch` des Buttons `Origin` sendet. `?k=` im Browser funktioniert weiterhin, ist aber die **benannte Ausnahme** mit URL-/History-/Log-Exposition (§2.5, §2.3 Nr. 6). **Nicht** mehr als „Loopback-Proxy nötig" beschrieben — die Loopback-Annahme war die falsche Ursache |
| RK-L2 | Ein Body, der das Limit erst **beim Streamen** überschreitet, bekommt **keine** 413-Antwort (Socket-Abbruch) | Ein Operator mit einem > 8 KiB kodierten Secret sieht einen Netzwerkfehler statt einer Meldung | Bewusst: das ist exakt das `readBody()`-Verhalten (`SEC-08`), und ein > 8 KiB Secret entspricht > 2700 Bytes Klartext (kein realistischer `--admin-secret`). Der Grenzfall ist als AC-L29 festgeschrieben, nicht als Lücke. **Für den deklarierten Fall bleibt die Aussage bewusst schmal (RVW2-5):** AC-L14 gilt für genau das Setup „`content-length: 9000`, Body wird nicht gesendet"; die Antwort wird **geschrieben**, und ob der Client sie vor dem Close noch liest, hängt davon ab, ob er zu diesem Zeitpunkt noch streamt. Es wird **kein** Drain eingebaut — das wäre genau der Body-Read, den `SEC-08` ausschließt |
| RK-L3 | `handler → viewer → handler`-Zyklus wird um `surfaceOf` erweitert | Modul-Init-Reihenfolge | Beide Symbole sind Funktionsdeklarationen, werden erst zur Request-Zeit aufgerufen; Zyklus existiert seit 0.14.0 (`isLoopbackAddress`). Falls je ein Init-Problem auftritt: `surfaceOf` nach `server/surface.ts` ziehen (dann re-exportiert `handler.ts`) — bewusst **nicht** in dieser Änderung |
| RK-L4 | Admin-Seite: `call()` setzt heute `Content-Type: application/json` auch ohne Body | Ein 415, wenn die Body-Regel fälschlich auf bodylose Requests angewendet wird | §5.1 Regel 6 knüpft 415/413 an einen **deklarierten** Body; AC-L24 prüft den bodylosen POST |
| RK-L5 | 14 neue Keys in `AdminStrings` vergrößern die Admin-Seite | wenige hundert Bytes im HTML | vernachlässigbar; kein Bundle betroffen (`server/` ist nicht Teil von `dist/`) |
| RK-L6 | `launcherFormat()`-Heuristik | Ein exotischer Client mit `Accept: text/html;q=1, application/json;q=1` bekommt HTML | dokumentiert (§5.1 Regel 1); Skripte, die JSON wollen, senden `application/json` ohne HTML |
| RK-L7 | Das CSRF-Gate vertraut `X-Forwarded-Proto`/`X-Forwarded-Host` von **jedem** Peer (§5.2 Nr. 2) — anders als `publicOrigin()` | Ein Angreifer mit Netzposition könnte die **Basis** verschieben | Kein Credential-, Cookie- oder URL-Entscheid hängt daran: die Basis entscheidet nur, ob ein **vom Browser** gesetzter `Origin` passt. Ein Browser kann die Header auf dem Formularpfad nicht setzen (Formular = keine Header; `fetch` mit Custom-Headern bräuchte einen Preflight, den der Launcher mit `405`/`Allow` verweigert). Ein Nicht-Browser-Client kann `Origin` ohnehin frei wählen. Preis eines Angriffs wäre höchstens die Annahme eines Requests, der das Secret **korrekt** im Body trägt — die Prüfung selbst bleibt unberührt |

## 13. Trace-Anker

```
spec-id: SPEC-viewer-launcher-entry
```

Der Plan referenziert diesen Wert. Vorgänger-Anker `SPEC-viewer-origin` bleibt für die Ursprungsänderung gültig; diese Spec ändert nur den Launcher-Einstieg und verweist für alles andere auf ihn.

**FR-Trace-Vermerk:**

| REQ | Wo erfüllt |
|---|---|
| FR-6.17 | §3 Zeilen 1–9 (drei gleichwertige Einstiege), §5.1 Regel 2 |
| FR-6.21 | **eingeschränkt:** Kernsatz für Formular- und Header-Weg (§3, AC-L28); `?k=` als benannte Ausnahme §2.5, Restrisiko §2.3 Nr. 6 |
| FR-6.26 | §4, §6, AC-L01/L02 |
| FR-6.27 | §5.1 Regel 2, AC-L06–L09, AC-L14, AC-L30 |
| FR-6.28 | §5.2, §6, AC-L10/L11/L33 |
| FR-6.29 | §5.6, §5.7, AC-L21–L26. **Vermerk zur Bedienbarkeit:** das Control ist `reachable when enabled`; `when disabled it is intentionally out of the tab order and the reason is exposed as text via aria-describedby` (`#viewer-note` mit `launcherViewerOff` bzw. `launcherViewerPending` bei unaufgelöster Origin). Das ist die zugesagte Auslegung von „keyboard reachable" in FR-6.29 und wird von AC-L23 geprüft |
| FR-6.30 | §5.8 (14 Keys), AC-L02, AC-L32 |

## 14. Revisionslog

| Rev | Datum | Status | Änderung |
|---|---|---|---|
| 1 | 2026-11-08 | CHANGES_REQUESTED | Erste Fassung; Entscheidung E3 / offene Frage 3 revidiert, Varianten C + B spezifiziert. Review 1 verlangte Nacharbeit (22 Findings) |
| 2 | 2026-11-08 | CHANGES_REQUESTED | Review 1 abgearbeitet (RVW-1…22): `Origin`-Vergleichsbasis auf die Forwarded-Kette + `Host` umgestellt (Option (b), `viewer.hubOrigin` als Basis verworfen — §5.2), FR-6.21 als zweigeteilte Anforderung mit benannter `?k=`-Ausnahme (§2.5), 413 nur noch für den deklarierten Fall und `readBody()` statt eines zweiten Readers (§5.3), `connection: close`-Regel (§5.1 Nr. 9), sechs neue ACs (L29–L33 inkl. geteiltem Budget in beide Richtungen, Hub ohne Secret, deutsche Fehler-Neuausgabe, Proxy-Fälle), Testmatrix korrigiert (Helper-Verortung, Startfenster-Test via `PUT`, vier fehlende Fälle), Doku-Auswirkungen ergänzt (`docs/VIEWER.md:156`, `$http_host`), Risiken RK-L1/RK-L2/RK-L7 neu gefasst. Re-Review 2 bestätigte die vier Kernentscheidungen und meldete Restfindings RVW2-1…RVW2-9 |
| 3 | 2026-11-08 | **APPROVED** | Restfindings aus Re-Review 2 geschlossen: **RVW2-1** (`retry-after` ohne Fake-Injektion: `300` aus dem Verdict, Header **und** Body aus demselben Objekt, neue §5.1 Regel 11, keine `server/admin.ts`-Änderung über `statusPayload()` hinaus), **RVW2-2** (`403`-Zeile in §5.7, `403` in AC-L25, RK-L1 korrigiert), **RVW2-3** (Aktiv-Kriterium `enabled && origin` in §5.7, neuer Key `launcherViewerPending` → 14 Keys, §5.6-Startfenster, AC-L23 (ii)), **RVW2-4** (`host`-Default der Fixture, AC-L12 präzisiert), **RVW2-5** (RK-L2/AC-L14 auf das Setup „Body wird nicht gesendet" eingegrenzt, kein Drain), **RVW2-6** (Testdatei-Zählung: 8 berührt / 3 neu), **RVW2-7** (erster **nicht-leerer** Forwarded-Wert, AC-L33 (e)), **RVW2-8** (AC-L28: nur die Request-URL des `?k=`-GET ist ausgenommen), **RVW2-9** (rev 1 auf `CHANGES_REQUESTED`). Die vier Kernentscheidungen (RVW-1 Option (b), RVW-2, RVW-3, RVW-4) sind unverändert |
| 4 | 2026-11-08 | **APPROVED** | Zwei Findings aus Validierung und Code-Review geschlossen — **reine Präzisierung, keine Anforderungsänderung**, Status bleibt `APPROVED`. **VAL-1** (interner Widerspruch zur 405-Meldung): Option **(b)** umgesetzt, **kein 15. Key**. §3 bekommt die normative Tabelle „Status → Meldung" (`401`/`403`/`413`/`415`/`429` = Formular **mit** Meldung; `405` = **ohne**) samt Begründung; §3 Zeile 18, §4 (Fehlerblock nur bei 401/403/413/415/429, neuer Punkt 4 „405 ist keine Fehler-Neuausgabe"), §5.4 (getrennte 405-Zeile), §6 (eigene HTML-405-Zeile) und §9 (405-Test sichert „no `.bp-error` block" zu) folgen der engeren Fassung, die der Code bereits hat (`server/viewer.ts:830-831`, `:948-959`). Begründung in der Spec: ein `<form>` kann nur GET/POST senden, ein 405 ist für Browser nicht erreichbar. **CR-1**: neuer Export `launcherDeclaresBody(request)` in §5.1 (Signatur + Semantik), Export-Zahl **sieben → acht** (§5.1, §10), §5.3 Regel 3 stellt klar, dass Glue (`hub.ts:1112-1116`) und Gate (§5.1 Regel 6) **dieselbe** Funktion nutzen; §9 ergänzt die zugehörige Testzeile. **Unverändert:** 33 ACs, 14 i18n-Keys, 8 berührte Testdateien, 7 Produktionsdateien, alle fixierten Entscheidungen (C+B, kein `/config`-Feld, `?k=` bleibt, 303/200, eine `verifyOperatorSecret()`, eine Mint-Stelle, Origin-Gate Option b) |
