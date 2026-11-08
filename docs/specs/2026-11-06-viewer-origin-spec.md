# Hub-Viewer auf eigenem Origin — Spec

> Status: APPROVED (2026-11-07)
> Approval: APPROVED (2026-11-07, user) — E1–E5/S1–S3 as recommended
> Revision: 2.4 (2026-11-07) — Korrektur des Widerspruchs AC-F21 ↔ §2.4 Regel 5 (scheme-sensitiver Origin-Vergleich); keine andere AC geändert; E1–E5/S1–S3 unverändert (§11.6)
> Revision: 2.3 (2026-11-07) — Korrektur des internen Widerspruchs AC-5.24 ↔ A3/RR-11; Entscheidungen E1–E5/S1–S3 unverändert, kein Scope-Wechsel (§11.5)
> Revision: 2.2 (2026-11-06) — behebt die Review-Befunde RR-01…RR-11 (§11.4)
> spec-id: SPEC-viewer-origin
> Datum: 2026-11-06
> Zielrelease: 0.14.0 (nächstes 0.x-Minor = Breaking-Slot des Projekts; die tatsächliche Version setzt `release`)
> Issue: #140 — sechs Acceptance Criteria (AC 1–6). AC 5 („Viewer läuft auf eigenem Origin, nicht auf dem Hub-Port“) ist der Anker dieser Spec; AC 1–4 und 6 werden mitgetragen. Verbindliche Fassung und Trace: §1.6 und §7.3.
> Design (Spec-Input, nicht normativ): `docs/specs/2026-11-06-viewer-origin-design.md` — 12 Entscheidungen D1–D12, 5 offene Fragen, Größenklasse XL.
> Voraussetzung: `spec-plan-required: true` in `.meta-config/project.yaml`; ohne `Status: APPROVED` entsteht weder ein Plan noch Code.
> Sprache: interne Doku Deutsch; Identifier, Flags, Pfade, Fehlercodes und Commands Englisch.

## 0. Dokumentstatus, Normativität und Abgrenzung

- **Normativ** ist ausschließlich dieses Dokument, sobald der Kopf `Status: APPROVED (<Datum>)` trägt. Das Design bleibt Begründungs- und Entscheidungsbeleg; bei Widerspruch gilt die Spec, und die Spec wird korrigiert statt still umgedeutet.
- **Nicht normativ:** das Design, `docs/VIEWER.md` (Ist-Stand 0.13.0), `CHANGELOG.md` und der Code. Sie sind verifizierte Evidenz für den Ist-Zustand.
- **Nicht Gegenstand:** Implementierung, Planung, Release-Versionierung, Vergabe von Requirement-IDs. Die Requirement-Texte in §6 sind Vorschlag; die IDs und den Milestone vergibt `requirements`.
- **Verhältnis zu Issue #140:** Alle sechs Acceptance Criteria sind bekannt und in §1.6 auf Spec-ACs und Tests abgebildet. AC 5 ist der Anker dieser Änderung; AC 1–4 und 6 werden nicht neu erfunden, sondern als bestehende bzw. mitgetragene Verträge abgesichert.
- **Eine Wahrheit:** Der Viewer-Listener ist **kein** zweiter Hub. Es gibt genau eine `createFileStore`-Instanz, ein `persist`-Closure, ein Journal und je eine In-Memory-Map für Viewer-Sessions und -Tickets.

## 1. Problem / Ziel / Nicht-Ziele

### 1.1 Problem

Der 0.13.0-Viewer liefert Shell, Proxy, Assets und Bookmarklet auf **demselben Listener** wie die Notiz-API. Ein proxied Dokument läuft damit auf der Hub-Origin; sein JavaScript teilt die Origin mit `/notes`, `/mcp`, `/admin` und dem statischen `--root`-Baum. Zusätzlich ist die Viewer-Session heute nicht surface-spezifisch (`authorize()` akzeptiert `bp_viewer` auf jeder Route außer Admin-Gate und `/mcp`) und der Session-Austausch ist ungedrosselt (`handleViewer` vergleicht `--admin-secret` direkt). Mit `--root` kann der statische Fallback außerdem `index.html` für Viewer-Pfade ausliefern; die heutige 404-Zusage gilt nur ohne `--root`.

### 1.2 Ziel

Ein **zweiter `node:http`-Listener im selben Prozess** mit eigener Origin, gemeinsamem Store, gemeinsamem Journal und gemeinsamer Session-/Ticket-Verwaltung:

1. Viewer-Inhalt ist auf dem Hub-Port **nicht** erreichbar (404), **auch mit `--root`**.
2. Über die Viewer-Origin geschriebene Notizen sind sofort über Hub-`/notes`, `/bundle`, `/journal` und `/mcp` sichtbar.
3. Die Viewer-Origin bietet **keine** Admin-, MCP-, Journal-, `/config`- oder `--root`-Fläche.
4. Die Viewer-Fläche ist **fail-closed**: Notiz-Routen verlangen dort eine Viewer-Session **oder** ein Client-Credential; ohne beides antworten sie `401`, auch ohne `--auth-secret`.
5. Der Operator-Secret-Vergleich passiert ausschließlich auf der Hub-Origin und läuft durch denselben `adminThrottle` wie `/admin/*`.
6. SSRF-Schutz wird um DNS-Auflösung, IP-Klassifikation, Metadata-Hostnamen und Prüfung jedes Redirect-Hops gehärtet.

### 1.3 Nicht-Ziele

- Keine neue Runtime-Dependency (NFR-4); nur `node:http` und `node:dns` über die bestehende `net-policy`-Abstraktion.
- Kein Schema-/Bundle-Bump, keine Änderung an `src/data/**`, keine Änderung am Element-Bundle (NFR-3).
- Kein Multi-Prozess-Betrieb, kein File-Lock, kein Cluster-Modus.
- Keine Änderung an MCP-Protokoll, Federator, Extension oder CLI außerhalb der in §5 genannten Flags.
- Kein allgemeines CORS für die Viewer-Origin; keine `Access-Control-Allow-Credentials`-Antwort.
- Keine automatische Migration alter Bookmarklets; sie werden neu ausgestellt.
- Keine Verschlüsselung des Stores; TLS bleibt externe Reverse-Proxy-Aufgabe.
- Keine Sandbox: proxied JavaScript läuft weiterhin mit der Viewer-Origin und kann die Viewer-Session same-origin nutzen.

### 1.4 Explizite Annahmen

| ID | Annahme | Konsequenz bei Verletzung |
|---|---|---|
| **A1** | Issue #140 hat sechs Acceptance Criteria: (1) `/view` liefert die Seite mit injizierter Layer und absolutem `endpoint`; (2) Allowlist, Loopback und Metadata werden abgelehnt, nicht erlaubte Viewer-Routen antworten `401`/`404`; (3) CSP-Kopfzeile **und** `<meta>`-CSP werden entfernt; (4) eine über den Viewer geschriebene Notiz ist in `/notes` und `list_notes` sichtbar; (5) der Viewer läuft auf eigener Origin, nicht auf dem Hub-Port; (6) Tests decken statische Seite, SPA, fehlendes `</head>` und Meta-CSP ab. | Keine: §1.6 bildet alle sechs ACs auf Spec-ACs und Tests ab. |
| **A2** | 0.x-Minor ist der Breaking-Slot; 0.14.0 ist Zielrelease, die konkrete Version setzt `release`. | Kein AC hängt an der Versionsnummer. |
| **A3** | TLS wird extern terminiert; beide Listener sprechen plain HTTP. Die öffentliche Origin kommt aus `--viewer-origin`; nur in einem eingebetteten/programmatischen Kontext **ohne** gesetzte Origin wertet `publicOrigin()` zusätzlich eine Loopback-`X-Forwarded-Proto`-Angabe aus. `startHub()` setzt vor dem ersten bedienten Request immer eine Origin (explizit oder abgeleitet). | Ohne explizite Origin hinter TLS sind Links/Cookies `http`, auch bei Loopback-`X-Forwarded-Proto: https`; `--viewer-origin` ist dort Pflicht (§2.4 Regel 6, RR-11, RK-21). |
| **A4** | Der Store ist eine Datei, die in der unterstützten Topologie von **einem** Prozess beschrieben wird. Fremde Schreiber bleiben last-writer-wins. | File-Lock ist Follow-up, kein Designziel. |
| **A5** | `--admin-secret` bleibt für `--viewer` verpflichtend; ein Viewer ohne Operator-Credential existiert nicht. | Startfehler (bestehendes Verhalten). |
| **A6** | Gleicher Hostname mit anderem Port ist eine andere Origin im Sinne der Same-Origin-Policy, aber **keine** Cookie-Isolation. | Warnung `viewer_cookie_shared_host`; kein harter Fehler (E4). |
| **A7** | `--viewer-port 0` ist ein gültiger Test-/Ephemeral-Port; `--port 0 --viewer-port 0` ist zulässig, solange die tatsächlichen Origins nach `listen()` differieren. | `RunningServer.viewer.port` meldet den tatsächlichen Port; Post-`listen()`-Prüfung §2.4 Regel 5. |
| **A8** | AC 1–4 und 6 sind im 0.13.0-Viewer teilweise vorhanden; diese Spec sichert sie gegen die Origin-/Surface-Umbauten regressiv ab. | Die ACs bleiben unverändert; die Spec behauptet nicht, sie neu zu erfinden. |

### 1.5 Entscheidungen (ADR-Kurzform)

Die Design-Entscheidungen D1–D12 werden übernommen; diejenigen, die der Review geschärft hat (D5, D6, D7, D8, D10, D11), sind hier präzisiert. **S2 (`publicBaseUrl` als programmatischer Alias) ist eine ausdrückliche Spec-Ergänzung zum Design, kein übernommener Design-Contract.** Jede Zeile ist eine ADR: Kontext → Entscheidung → Konsequenz. Die fünf im Design offenen Fragen sind in §10.1 als **bestätigte Entscheidungen** mit Status „im Freigabe-Gate am 2026-11-07 bestätigt“ geführt (E1–E5).

| Ref | Kontext | Entscheidung | Konsequenz |
|---|---|---|---|
| **D1** | Andere Origin, gleicher Store | Zweiter Listener im selben Prozess; zwei `HandlerContext`-Views mit `surface`; gemeinsame `store.state`/`persist`/Journal/Sessions/Tickets | Ein `close()`; `server/hub.ts` wächst; Surface-Verzweigung wird sicherheitskritisch |
| **D2** | Operator-Secret darf die Viewer-Origin nie erreichen | Hub-Launcher prüft Secret (`adminThrottle`) und mintet ein 60-s-Einmal-Ticket; Viewer löst es gegen Cookie ein | Zusätzlicher Launcher-Pfad; alte `{base}/viewer?k=`-Links ziehen um |
| **D3** | Viewer-Session darf Hub-Port nicht öffnen; Viewer-Fläche darf ohne `--auth-secret` nicht offen sein | `authorize()` verzweigt auf `surface`: Hub ignoriert Viewer-Sessions, Viewer fail-closed ohne Client-Credential | Jede Surface-Änderung ist eine Sicherheitsänderung (AC-5.10/5.11) |
| **D4** | Auf der Viewer-Origin läuft fremder Code | Viewer-Fläche serviert nur Shell, `/view`, Assets, Bookmarklet, `notes*`, `sessions`, `bundle`, `health`; Hub-Fläche serviert **keinen** Viewer-Inhalt, auch nicht über `--root` | `viewerSurfaceRefusal()` und `hubViewerPathRefusal()` sind die zwei Durchsetzungen; Route-Matrix §2.8 |
| **D5** | Bookmarklet lädt das Element-Bundle per `<script src>` von fremder Seite | `/viewer/assets/*` wird **vor** der Session-Prüfung bedient, ist session-frei, nur für `VIEWER_ASSET_FILES`, mit `ACAO: *`, `CORP: cross-origin`, `no-cache` | Statisches, versionsgestempeltes Bundle ohne Notizen/Secrets ist lesbar |
| **D6** | Allowlisteter Host kann auf interne IPs zeigen | `checkTarget()`: Metadata-Hostnamen vor DNS; DNS auflösen; `classifyAddress()`; private nur bei exaktem Allowlist-Eintrag; Resolver-Fehler/leer → fail-closed; jeder Redirect-Hop erneut; Funktion ist total | Interne Ziele brauchen exakten Eintrag; TOCTOU bleibt Restrisiko |
| **D7** | `--viewer` ohne Port würde Viewer wieder auf dem Hub-Port servieren | `--viewer` ohne `--viewer-port` ist ein harter Nutzungsfehler; `0` erlaubt; Port-Gleichheit nur bei gleicher Bind-Adresse und beiden Ports ≠ 0 ein Fehler | Breaking Change für 0.13.0-Deployments |
| **D8** | `--viewer-public-url` bezeichnete bisher die Hub-Origin | Neuer Name `--viewer-origin`; alter Name bleibt eine Release-Periode als validierter Alias; Alias, der die Hub-Origin bezeichnet, wird abgelehnt | Eine Wahrheit; Alias wird im nächsten Minor entfernt; Semantikwechsel in `CHANGELOG`/`docs/VIEWER.md` |
| **D9** | Cookies sind nicht port-isoliert | `bp_viewer` bleibt `HttpOnly`, `SameSite=Lax`, `Path=<base>`, `Secure` bei https; gleicher Hostname warnt | Echte Isolation braucht anderen Hostnamen |
| **D10** | Hub-CORS darf Viewer-Origin nicht vertrauen; Bookmarklet braucht Schreibpfad | Mit `--viewer` sind `--cors <viewer-origin>` **und** `--cors '*'` Nutzungsfehler; nach `listen()` wird die tatsächliche Viewer-Origin erneut geprüft; Viewer beantwortet nur `/notes*` mit Header-Token, ohne Credentials | Enge, dokumentierte CORS-Ausnahme; kein Journal-/`/config`-/`/health`-Abfluss über Wildcard |
| **D11** | Zwei Listener müssen atomar starten/schließen | `RunningServer.viewer` optional; zweiter Bind-Fehler schließt den ersten; `close()` schließt beide; Post-`listen()`-Validierung schließt beide bei Origin-Konflikt; `viewer.origin` ist **vor dem ersten bedienten Request** aufgelöst (feste Ports synchron, `port 0` nach beiden Binds) | Kein halber Start, kein Listener-Leak, kein Launcher-Redirect auf eine undefinierte Origin |
| **D12** | Reverse Proxy und Loopback-Bind | Viewer-Context hat eigenes `bind`/`hostAliases`; `X-Forwarded-Proto` nur von Loopback-Peers oder bei expliziter Origin | Proxy-Setups brauchen `--viewer-origin` und Loopback-Proxy |

### 1.6 Traceability Issue #140 (AC 1–6)

Die linke Spalte ist die verbindliche Fassung der sechs öffentlichen Issue-ACs (Quelle: Issue-Body, wiedergegeben im Review-Report §CR-01); sie ersetzt die frühere Annahme, nur ein AC sei bekannt.

| #140 AC | Verbindlicher Text | Spec-AC | Tests |
|---|---|---|---|
| **AC 1** | `/view` liefert das Ziel mit injizierter Layer und **absolutem** `endpoint` (und absolutem Element-`src`). | AC-5.16, AC-5.26 | IT-15, IT-30, RT-01 |
| **AC 2** | Allowlist, Loopback und Metadata werden abgelehnt; nicht erlaubte Viewer-Routen antworten `401`/`404`. | AC-5.3, AC-5.9, AC-5.17, AC-5.19, AC-5.30, AC-5.31, AC-5.32 | IT-03, IT-09, IT-16, IT-18, IT-34, IT-43 |
| **AC 3** | CSP-Kopfzeile **und** `<meta>`-CSP werden entfernt, damit die injizierte Layer läuft. | AC-5.25, RT-01 | IT-29, RT-01 |
| **AC 4** | Eine über die Viewer-Origin geschriebene Notiz ist in Hub-`/notes` und `list_notes` sichtbar. | AC-5.6, AC-5.7, AC-5.33 | IT-06, IT-07, IT-44 |
| **AC 5** | Der Viewer läuft auf eigener Origin, nicht auf dem Hub-Port; Viewer-Inhalt ist dort nicht erreichbar. | AC-5.1, AC-5.2, AC-5.11, AC-5.29, AC-F22 | IT-01, IT-02, IT-11, IT-33, IT-45 |
| **AC 6** | Tests decken statische Seite, SPA, fehlendes `</head>` und Meta-CSP ab. | AC-5.26, AC-5.27, AC-5.28, RT-01 | IT-30, IT-31, IT-32, RT-01 |

## 2. Interface Contracts

Alle Signaturen sind Ziel-Contracts. Bestehende Symbole bleiben, sofern nicht ausdrücklich ersetzt. Dateipfade sind relativ zum Repo-Root; `SERVER_VERSION` und bestehende Konstanten bleiben unverändert.

### 2.1 `server/handler.ts` — Surface und Autorisierung

```ts
/** Welche Fläche diesen Request bedient. Default ist "hub" (rückwärtskompatibel). */
export type HubSurface = "hub" | "viewer";

export interface HandlerContext {
  // … bestehende Felder unverändert (store, base, environment, readOnly, authSecret,
  // verifyToken, adminSecret, viewer, adminThrottle, presence, cors, bind, hostAliases, persist, …)
  /**
   * Token-Ids, die auch bei gültiger Signatur abgelehnt werden. Auf der Viewer-Fläche ist das
   * **dieselbe Set-Referenz** wie auf der Hub-Fläche (keine Kopie), damit eine Live-Revocation
   * sofort auf beiden Flächen greift.
   */
  revokedTokens?: ReadonlySet<string>;
  /** Gesetzt von `startHub`; fehlt bei eingebetteten Hosts und in reinen Unit-Tests. */
  surface?: HubSurface;
}

/** Total: fehlendes `surface` bedeutet "hub". */
export function surfaceOf(context: HandlerContext): HubSurface;

/**
 * Eine Normalisierung für beide Surface-Sperren. Parst mit `new URL(url, "http://hub.invalid")`,
 * dekodiert `pathname` genau einmal, löst `.`/`..` auf, entfernt doppelte und trailing Slashes.
 * Das Ergebnis enthält nie ein `.`- oder `..`-Segment; Prozentkodierung wird vor der Auflösung
 * dekodiert. `null` nur, wenn der URL-Anteil nicht parsebar ist.
 */
export function normalizeSurfacePath(url: string): string | null;

/**
 * 404 auf der Hub-Fläche für die Viewer-Inhaltsrouten, auch wenn `--root` konfiguriert ist:
 * `{base}/viewer`, `{base}/view`, `{base}/viewer/assets/*`, `{base}/viewer/bookmarklet.txt`
 * sowie die unpräfigierten Formen `/viewer`, `/view`, `/viewer/assets/*`,
 * `/viewer/bookmarklet.txt`. `{base}/viewer/start` ist NICHT gesperrt (Launcher).
 * `null` auf der Viewer-Fläche und für jeden anderen Pfad.
 */
export function hubViewerPathRefusal(
  request: Pick<ServerRequest, "url">,
  context: HandlerContext,
): ServerResponse | null;

/**
 * Erweitert um die Surface-Semantik (D3):
 * - surface === "viewer": `viewerAuthorized()` ist der Primärschlüssel; ohne konfiguriertes
 *   Client-Credential ist ein fehlender Viewer-Session-Cookie ein 401 (fail-closed).
 *   Das Credential-Verfahren prüft `context.revokedTokens` (derselbe Live-Set wie auf der
 *   Hub-Fläche) und `context.requiredScope`; ein widerrufenes `jti` ist `401 token_revoked`.
 * - surface === "hub": `viewerAuthorized()` wird NICHT konsultiert. Eine `bp_viewer`-Cookie
 *   oder ein `x-bluepencil-viewer`-Header autorisiert auf dem Hub-Port nichts.
 */
export function authorize(
  request: ServerRequest,
  context: HandlerContext,
  scope?: "read" | "write",
  options?: { allowAdminSecret?: boolean },
): ServerResponse | null;

/**
 * 404 auf der Viewer-Fläche für /admin*, /mcp*, /journal*, /config, /viewer/start und jeden
 * Pfad außerhalb der Viewer-API. `null` auf der Hub-Fläche und für erlaubte Viewer-Pfade.
 */
export function viewerSurfaceRefusal(
  request: Pick<ServerRequest, "url">,
  context: HandlerContext,
): ServerResponse | null;
```

**Normative Regeln**

1. `surfaceOf()` ist total und zustandslos: `context.surface === "viewer"` → `"viewer"`, alles andere (inkl. `undefined`) → `"hub"`.
2. `authorize()` auf `surface === "viewer"`:
   1. `viewerAuthorized(request, context)` → `null` (erlaubt). Gilt für Cookie **und** `x-bluepencil-viewer`.
   2. Sonst, wenn **kein** Client-Credential konfiguriert ist (`context.verifyToken === undefined` **und** `context.authSecret` fehlt oder leer) → `401 unauthorized`, Code `unauthorized`, Message aus `viewerSessionRefusalMessage(context)` (§2.2 Regel 7). Das ist die Fail-closed-Regel; sie greift **vor** dem heutigen Early-Return „kein Credential → offen“.
   3. Sonst das bestehende Credential-Verfahren (`Authorization: Bearer` / `x-bluepencil-auth`) inklusive `adminThrottle` und Scope. Die Token-Prüfung verwendet `context.revokedTokens` (dieselbe Set-Referenz wie auf der Hub-Fläche); ein widerrufenes `jti` → `401 token_revoked`, kein Fallback auf ein Secret. `context.requiredScope` gilt auf beiden Flächen identisch.
   4. `options.allowAdminSecret` wird auf der Viewer-Fläche **nie** wahr; das Admin-Secret ist dort kein Notiz-Credential.
3. `authorize()` auf `surface === "hub"`: `viewerAuthorized()` wird nicht aufgerufen. Ohne konfiguriertes Client-Credential bleibt der Hub offen (bestehendes Verhalten, G1). `allowAdminSecret` bleibt für `segments[0] === "notes"` wie heute.
4. `normalizeSurfacePath()` ist die einzige Pfadnormalisierung der beiden Sperren. `..`-Segmente und Prozentkodierung dürfen eine Sperre nicht umgehen; ein Pfad, der nach der Normalisierung außerhalb von `{base}` liegt, wird von `viewerSurfaceRefusal()` gesperrt. Doppelte Dekodierung ist verboten.
5. **Aufrufstellen `respond()` (verbindlich, in dieser Reihenfolge):** `hostRefusal()` → Launcher-Prüfung `isViewerStartRequest()` (nur `surface === "hub"`) → `hubViewerPathRefusal()` (nur Hub) → `viewerSurfaceRefusal()` (nur Viewer) → Viewer-Door (**nur** `surface === "viewer"` **und** `isViewerRequest(url, context)`) → Journal → `--root`-Static → `earlyRefusal()`. Damit liegt `hubViewerPathRefusal()` **vor** dem statischen Fallback, und `viewerSurfaceRefusal()` liegt vor Journal/Static/MCP. Die zusätzliche `isViewerRequest()`-Bedingung verhindert, dass die Viewer-Door auf der Viewer-Fläche `/health`, `{base}/notes*`, `{base}/sessions` oder `{base}/bundle` verschluckt; diese Pfade laufen in `gateRequest()`.
6. **Aufrufstellen `gateRequest()` (verbindlich, in dieser Reihenfolge):** `hostRefusal()` → `hubViewerPathRefusal()` (nur `surface === "hub"`) → `viewerSurfaceRefusal()` (nur `surface === "viewer"`; auf dem Hub immer `null`) → `adminGate()` (nur `surface === "hub"` und nur innerhalb `{base}`) → Unknown-Path-`404` (Pfad außerhalb `{base}` oder unbekannte Route) → Preflight (Hub: `preflightResponse()` gemäß `--cors`; Viewer: Regel 11) → `configResponse()` → `health()` → `authorize()` → Route. `/health` steht damit auf **beiden** Flächen vor `authorize()` und ist ohne Credential erreichbar (AC-5.23); `/config` ist auf der Viewer-Fläche bereits durch `viewerSurfaceRefusal()` `404`; `/admin` erreicht `adminGate()` auf der Viewer-Fläche nie.
7. **Viewer-Door nur auf der Viewer-Fläche und nur für Viewer-Pfade:** `respond()` dispatcht zu `handleViewer()` nur, wenn `surfaceOf(context) === "viewer"` **und** `isViewerRequest(url, context)` gilt. `handleViewer()` gibt auf einer Nicht-Viewer-Surface, ohne `context.viewer` **oder** für eine URL, die `isViewerRequest()` nicht erfüllt, zusätzlich `null` zurück (Defense in Depth). Der Viewer-Early-Return in `earlyRefusal()` (`context.viewer !== undefined && isViewerRequest(...)`) wird ebenfalls auf `surfaceOf(context) === "viewer"` **und** `isViewerRequest(url, context)` gegated; auf der Hub-Fläche liest ein Viewer-Pfad deshalb keinen Body und lädt keinen Store, bevor `hubViewerPathRefusal()` mit 404 antwortet.
8. **Launcher nur auf der Hub-Fläche:** `respond()` prüft `isViewerStartRequest(url, context)` nach `hostRefusal()` und vor `gateRequest()` nur dann, wenn `surfaceOf(context) === "hub"` ist. Auf der Viewer-Fläche fällt `/viewer/start` durch `viewerSurfaceRefusal()` auf 404.
9. `hubViewerPathRefusal()` ist auf der Hub-Fläche idempotent und ohne Body-/Store-Zugriff; es sperrt ausschließlich die Viewer-Inhaltsrouten (nicht `/viewer/start`) in **beiden** Schreibweisen — `{base}/viewer…` und unpräfigiert `/viewer…` — damit `--root` kein `index.html` für Viewer-Pfade ausliefern kann. Andere statische Pfade bleiben unberührt.
10. `viewerSurfaceRefusal()` liefert auf `"hub"` immer `null`. Auf `"viewer"` liefert es `404 not_found` für:
    - `{base}/admin` und `{base}/admin/*`
    - `{base}/mcp` und `{base}/mcp/`
    - `{base}/journal`
    - `{base}/config`
    - `{base}/viewer/start`
    - jeden Pfad außerhalb von `{base}` (damit auch `--root`-Static)
    und `null` für: `{base}/viewer`, `{base}/view`, `{base}/viewer/assets/*`, `{base}/viewer/bookmarklet.txt`, `{base}/notes*`, `{base}/sessions`, `{base}/bundle`, `{base}/health`. Präfix-Matches immer mit Segmentgrenze.
11. **`OPTIONS` auf der Viewer-Fläche erreicht nie `authorize()`.** Nach `viewerSurfaceRefusal()` und vor `configResponse()`/`health()`/`authorize()` gilt:
    - `OPTIONS {base}/notes*` mit gültigem absolutem `Origin` **und** `Access-Control-Request-Headers`-Wert, der `x-bluepencil-viewer` case-insensitiv enthält → `204` aus `viewerBookmarkletPreflight()` (§2.5 Regel 1).
    - `OPTIONS {base}/notes*` ohne eines der beiden → `405 method_not_allowed`; `Allow` ist die dokumentierte Methodenliste der jeweiligen Route aus `allowedMethods()` (`GET, POST` für `{base}/notes`; `GET, PATCH` für `{base}/notes/{id}`; `POST` für `{base}/notes/{id}/messages` und `{base}/notes/bulk-delete`). Kein `Access-Control-Allow-Origin`, kein `Set-Cookie`, kein `401`. Ein Preflight trägt keinen Credential; ein `401` würde den Browser-Preflight und damit die Bookmarklet-Anfrage ohne Sicherheitsgewinn blockieren.
    - `OPTIONS` auf jeder anderen bekannten Viewer-Route (`{base}/bundle`, `{base}/sessions`, `{base}/health`) → `405 method_not_allowed` mit `Allow` aus `allowedMethods()`; `{base}/health` antwortet `Allow: GET, HEAD`.
    - `OPTIONS` auf einem unbekannten Pfad → `404 not_found` (Unknown-Path-Regel oben).
    - `OPTIONS` auf `/viewer`, `/view` und `/viewer/assets/*` beantwortet bereits `handleViewer()` (Regel 5.1) mit `405` + `Allow: GET`, bevor `gateRequest()` läuft.

### 2.2 `server/viewer.ts` — Tickets, Cookie, Routen, SSRF

```ts
export const VIEWER_TICKET_TTL_SECONDS = 60;
export const VIEWER_MAX_TICKETS = 1024;

/** Einmal-Tickets: 24 Byte Zufall, hex, kurzlebig, single-use, nur im Speicher. */
export interface ViewerTickets {
  mint(): { ticket: string; expiresAt: number };
  /** Atomar: true genau beim ersten Aufruf für ein gültiges, nicht abgelaufenes Ticket. */
  consume(ticket: string | undefined): boolean;
  size(): number;
}

export function createViewerTickets(ttlSeconds?: number): ViewerTickets;

export interface ViewerOptions {
  assetsDir: string;
  allow: readonly string[];
  ttlSeconds: number;
  /**
   * Öffentliche Origin des Viewer-Listeners, z. B. `https://view.example.com`.
   * Kein Pfad, keine Query, kein Fragment. **Vor dem ersten bedienten Request gesetzt**:
   * bei festen Ports synchron vor dem Attach des `request`-Handlers, bei `port 0` nach beiden
   * Binds und vor dem Attach (§2.4 Regel 4/5). Ein `handleViewerStart` ohne gesetzte Origin
   * antwortet `503 service_not_ready` (§2.2 Regel 4).
   */
  origin?: string;
  /** @deprecated Eingabe-Alias aus 0.13.0; wird in `resolveOptions` auf `origin` normalisiert. */
  publicBaseUrl?: string;
  /**
   * Hub-**Bind-Origin** (`http://<Bind-Adresse>:<Port>`), nur für den Launcher-Hinweis im 401-Text;
   * kein Secret und **nicht** die öffentliche Hub-Origin. **Intern von `startHub()` gesetzt, kein
   * `ServerOptions`-Eingabefeld.** `startHub()` setzt sie nur, wenn der Hub-Bind loopback ist. Die
   * Prüfung ist bind-, nicht proxy-basiert: Hinter einem Loopback-Reverse-Proxy ist die Bind-Origin
   * intern; der Hinweis nennt dort die URL-lose Meldung, und eine öffentliche Launcher-URL bräuchte
   * einen expliziten öffentlichen Hub-Origin-Input (§4.9 Nr. 9).
   */
  hubOrigin?: string;
  sessions: ViewerSessions;
  tickets: ViewerTickets;
  /** Zusätzliche Host-Namen für das Host-Gate (aus `--viewer-origin`). */
  hostAliases?: readonly string[];
}

/** Cookie: `bp_viewer=<token>; HttpOnly; SameSite=Lax; Path=<base>; Max-Age=<ttl>[; Secure]`. */
export function sessionCookie(
  token: string,
  options: { ttlSeconds: number; base: string; secure: boolean },
): string;

/** Pfad des Launchers auf der Hub-Fläche: `{base}/viewer/start`. */
export function viewerStartPath(base: string): string;

/**
 * Die eine Meldung für jede Viewer-Session-Ablehnung: Shell, Bookmarklet, `/view` und die
 * fail-closed-`401` der Notiz-Routen. Mit öffentlich erreichbarem `viewer.hubOrigin` lautet der
 * Hinweis `open the hub launcher at {hubOrigin}{base}/viewer/start`; ohne (ungesetzt oder nur die
 * interne Bind-Origin hinter einem Loopback-Reverse-Proxy)
 * `open the hub launcher on the hub origin`. Nie `{base}/viewer?k=`.
 */
export function viewerSessionRefusalMessage(context: HandlerContext): string;

export function isViewerStartRequest(url: string, context: HandlerContext): boolean;

/** Hub-Fläche: Operator-Secret → Einmal-Ticket → 302 auf die Viewer-Origin. */
export function handleViewerStart(
  request: ServerRequest,
  context: HandlerContext,
): ServerResponse | null;

/** Viewer-Fläche: Ticket-Einlösung, Shell, Bookmarklet, Assets, Proxy. */
export async function handleViewer(
  request: ServerRequest,
  context: HandlerContext,
  deps?: { fetchImpl?: typeof fetch; resolver?: HostResolver },
): Promise<ServerResponse | null>;

export interface TargetPolicyDeps {
  resolver?: HostResolver;
  /** Origins, die nie Ziel sein dürfen (Viewer-Origin, optional Hub-Origin). */
  forbiddenOrigins?: readonly string[];
  /** Default true: private Ziele nur bei exaktem `--viewer-allow`-Eintrag. */
  allowPrivateExact?: boolean;
}

/** Stabile, viewer-lokale Gründe; nicht Teil von `ERROR_CODES` (siehe §2.9). */
export type TargetRefusalCode =
  | "target_not_allowed"          // Protokoll, Userinfo, Allowlist
  | "target_metadata_host"        // METADATA_HOSTNAMES, vor DNS
  | "unresolvable_host"           // Resolver wirft, liefert [], oder keinen IP-Literal
  | "target_address_forbidden"    // IP-Klasse loopback/link-local/metadata/reserved/invalid
  | "target_forbidden_origin";    // forbiddenOrigins

export interface TargetRefusal {
  readonly code: TargetRefusalCode;
  readonly message: string;
}

/** Total: wirft nie; null = erlaubt, sonst maschinenlesbarer Grund. */
export function checkTarget(
  raw: string,
  allow: readonly string[],
  deps?: TargetPolicyDeps,
): Promise<TargetRefusal | null>;

/** Synchrone Vorprüfung (Protokoll, Userinfo, Allowlist) im selben Rückgabetyp. */
export function targetRefusal(raw: string, allow: readonly string[]): TargetRefusal | null;
```

**Normative Regeln**

1. `createViewerTickets(ttlSeconds = VIEWER_TICKET_TTL_SECONDS)`: `mint()` erzeugt 24 Byte `randomBytes` als 48 Hex-Zeichen; `consume()` löscht den Eintrag **vor** der Rückgabe und ist damit atomar; ein zweiter Aufruf mit demselben Ticket liefert `false`. `size()` bereinigt abgelaufene Einträge. Bei mehr als `VIEWER_MAX_TICKETS` wird der älteste Eintrag verworfen (Einfügereihenfolge der `Map`).
2. `sessionCookie()`: exakt `bp_viewer=<token>; HttpOnly; SameSite=Lax; Path=<normalisierter base>; Max-Age=<ttl>` und genau dann `; Secure`, wenn `secure === true`. Kein `Domain`, kein `Expires`.
3. `publicOrigin(request, viewer)`: wenn `viewer.origin` gesetzt ist, wird sie unverändert zurückgegeben (ohne trailing slash); sonst `http://<Host-Header>` bzw. `https://<Host-Header>`, wenn `X-Forwarded-Proto: https` **und** `request.remote` loopback ist. `X-Forwarded-Proto` von einem Nicht-Loopback-Peer wird ignoriert. Der XFP-Zweig existiert nur, solange `viewer.origin` **unset** ist (eingebetteter/programmatischer Kontext); `startHub()` setzt vor dem ersten bedienten Request immer eine Origin und erreicht ihn daher nie (§2.4 Regel 6).
4. `handleViewerStart()`: nur auf `surface === "hub"`; sonst `null`. **Die Origin-Prüfung steht vor `verifyOperatorSecret()` und verbraucht kein Budget.** Ist `context.viewer.origin` nicht gesetzt (Startfenster eines eingebetteten Hosts, fehlerhafte Konfiguration), antwortet der Launcher `503 service_not_ready` mit `cache-control: no-store` und `retry-after: 1` — **ohne** `Location`, ohne `Set-Cookie` und ohne `tickets.mint()`; er gibt niemals einen relativen oder leeren `Location`-Wert aus. `startHub()` löst die Origin vor dem ersten bedienten Request auf (§2.4 Regel 4), dieser Zweig ist dort Defense in Depth. Andernfalls: Secret-Extraktion — `x-bluepencil-admin` gewinnt; ist der Header vorhanden, wird **nicht** auf `?k=` zurückgefallen. Ohne Header wird `?k` verwendet. Ergebnis über `verifyOperatorSecret()` (§2.3). Der `302` trägt `referrer-policy: no-referrer` und `cache-control: no-store`, kein `Set-Cookie`.
5. `handleViewer()`: gibt auf `surface !== "viewer"`, ohne `context.viewer` **oder** für eine URL, die `isViewerRequest()` nicht erfüllt, `null` zurück. Reihenfolge (verbindlich):
   1. Methodenprüfung (`GET`; sonst `405` + `Allow: GET`)
   2. **Assets** (`{base}/viewer/assets/<basename>`) — **vor** jeder Session-Prüfung; unbekannter Basename `404`
   3. Ticket-Einlösung (`?ticket=`)
   4. `?k=` ablehnen (ohne Vergleich)
   5. Session prüfen
   6. Shell / Bookmarklet / Proxy

   Nur Shell, Bookmarklet und `/view` verlangen im Viewer-Door eine Session; `notes*` verlangen sie über `authorize()` (§2.1 Regel 2). Assets sind öffentlich (D5).
6. `?ticket=` und `?k=` gleichzeitig: das Ticket gewinnt; `k` wird nie verglichen. `?ticket` ungültig/abgelaufen/verbraucht → `401 unauthorized`, kein `Set-Cookie`. Gültig → `sessions.mint()`, `Set-Cookie`, `302` auf `{base}/viewer` (ohne Query), `referrer-policy: no-referrer`, `cache-control: no-store`.
7. **Eine Meldung für jede Viewer-Session-Ablehnung:** `handleViewer()` mit `?k=` auf einer session-geschützten Viewer-Route (Shell, Bookmarklet, `/view`) → `401 unauthorized`; der Wert wird nicht verglichen und verbraucht kein Throttle-Budget. Dieselbe `viewerSessionRefusalMessage(context)` verwenden die fehlende Session auf Shell, Bookmarklet und `/view` sowie die fail-closed-`401` aus `authorize()` (§2.1 Regel 2.2). Mit öffentlich erreichbarem `viewer.hubOrigin` nennt sie `{hubOrigin}{base}/viewer/start`; ohne (ungesetzt oder nur die interne Bind-Origin hinter einem Loopback-Reverse-Proxy) sagt sie „open the hub launcher“ ohne konstruierte URL. Die frühere Meldung `{base}/viewer?k=<admin-secret>` ist auf der Viewer-Fläche ein 401-Dead-End und entfällt vollständig. Asset-Routen werden nach Regel 5 vorher bedient und ignorieren `?k=`.
8. Assets: nur Basenames aus `VIEWER_ASSET_FILES`; Antwort `200`, `content-type: text/javascript; charset=utf-8`, `access-control-allow-origin: *`, `cross-origin-resource-policy: cross-origin`, `cache-control: no-cache`. Unbekannter Basename → `404 not_found`. Die Route ist session-frei und wird **vor** der Session-Prüfung bedient (Regel 5).
9. Shell und Proxy tragen `cache-control: no-store`, `referrer-policy: no-referrer`, `x-frame-options: SAMEORIGIN`. Proxy-Antworten kopieren **keine** `content-security-policy`-Kopfzeile des Ziels und tragen selbst keine CSP-Kopfzeile; `<meta http-equiv="content-security-policy">` wird entfernt (#140 AC 3).
10. Proxy: `checkTarget()` vor dem ersten Fetch **und** vor jedem Redirect-Hop; `redirect: "manual"`; maximal `VIEWER_MAX_REDIRECTS` Hops; Größen-, Timeout-, Content-Type-Prüfung unverändert (`VIEWER_MAX_BYTES`, `VIEWER_FETCH_TIMEOUT_MS`, `VIEWER_MAX_REDIRECTS`).
11. `targetRefusal()` bleibt als synchrone Vorprüfung (Protokoll, Userinfo, Allowlist) erhalten. `checkTarget()` parst die URL, prüft `METADATA_HOSTNAMES` **vor** Allowlist und DNS und ruft danach `targetRefusal()` auf; die DNS-/IP-Prüfung ist der neue asynchrone Teil. `VIEWER_COOKIE`, `VIEWER_HEADER`, `VIEWER_ASSET_FILES`, `VIEWER_MAX_BYTES`, `VIEWER_FETCH_TIMEOUT_MS`, `VIEWER_MAX_REDIRECTS` bleiben unverändert.
12. `checkTarget()`-Regeln (§4.8) sind verbindlich; die Funktion ist **total** und wirft nie:
    - `METADATA_HOSTNAMES` werden **vor** Allowlist und DNS geprüft → `target_metadata_host` (auch wenn der Host allowlistet ist).
    - `public` erlaubt; `private` nur bei exaktem (nicht `*.`) Allowlist-Eintrag und `allowPrivateExact !== false`; `loopback`, `link-local`, `metadata`, `reserved`, `invalid` immer abgelehnt → `target_address_forbidden`.
    - **Allowlist-Semantik (verbindlich):** Ein exakter Hostname-Eintrag (`internal.example.com`) autorisiert eine private Auflösung (`10.0.0.5`). Ein Wildcard-Eintrag (`*.example.com`) autorisiert eine private Auflösung **nie**, auch nicht für `foo.example.com`. Loopback/link-local/metadata/reserved bleiben in beiden Fällen verboten. Es gibt keinen CIDR-Eintrag und keine zweite Freigabe.
    - Resolver wirft, liefert `[]` oder einen Nicht-IP-Wert → `unresolvable_host` (fail-closed); **eine** unzulässige Adresse lehnt das ganze Ziel ab.
    - `forbiddenOrigins` wird normalisiert (Scheme + Host + Port) verglichen → `target_forbidden_origin`.
    - Jeder Fehler wird als `TargetRefusal` zurückgegeben, nie als geworfene Exception; `proxyTarget()` antwortet mit `403` und dem `code` der Refusal.
13. `proxyTarget()` übersetzt `TargetRefusal` unverändert in `{ error: { code, message } }` mit Status `403`; es gibt keinen generischen `500` für Resolver-Fehler.
14. Der Proxy prüft jeden Redirect-Hop mit demselben `checkTarget()`; die Allowlist gilt auch für den Hop.
15. `ViewerOptions.publicBaseUrl` ist eine **Spec-Ergänzung** gegenüber dem Design (S2): deprecated Eingabe-Alias, `resolveOptions` normalisiert auf `origin`, `origin` gewinnt; `resolveOptions` validiert den Wert mit denselben Origin-Regeln.

### 2.3 `server/admin.ts` — eine Operator-Secret-Prüfung

```ts
export type OperatorSecretVerdict =
  | { kind: "ok" }
  | { kind: "throttled"; retryAfterSeconds: number }
  | { kind: "invalid"; missing: boolean };

/**
 * Die EINE Prüfung des Operator-Secrets (`x-bluepencil-admin` oder `?k=`):
 * konstantzeitiger Vergleich, `adminThrottle` vor und nach dem Vergleich.
 * `adminGate` und `handleViewerStart` rufen ausschließlich diese Funktion auf.
 */
export function verifyOperatorSecret(
  request: Pick<ServerRequest, "remote">,
  context: HandlerContext,
  presented: string | undefined,
): OperatorSecretVerdict;
```

**Normative Regeln**

1. `verifyOperatorSecret()` ist die einzige Implementierung des Secret-Vergleichs; `adminGate` wird darauf umgestellt, ohne die Antwortcodes zu ändern (`401`, `429`, `Retry-After: 300`).
2. Fehlendes `context.adminSecret` → `{ kind: "invalid", missing: true }`, ohne Budgetverbrauch. Fehlender `presented`-Wert → ebenfalls `{ kind: "invalid", missing: true }`, ohne Budgetverbrauch. Das ist eine **bewusste Änderung** gegenüber 0.13.0: `adminGate()` zählte ein fehlendes `x-bluepencil-admin` bisher als Fehlversuch (§5.3, `CHANGELOG` `Changed`/`Security`); belegt durch UT-16 und RT-04.
3. Vor dem Vergleich: `adminThrottle.allow(remote, "admin") === false` → `{ kind: "throttled", retryAfterSeconds: 300 }`. Nach einem Fehlversuch: `failure(remote, "admin")`; nach Erfolg: `success(remote, "admin")`.
4. Der Vergleich ist konstantzeitige (`secretsMatch`-Semantik), loggt keinen Wert und nennt in der Antwort nie das Secret.
5. Der Launcher nutzt dasselbe `admin`-Budget wie `/admin/*`: ein falsches `?k=` am Launcher sperrt auch `/admin/*` für dieses Peer und umgekehrt (gewollte „ein Secret, ein Budget“-Regel).

### 2.4 `server/hub.ts` — CLI, Listener, `RunningServer`

```ts
export interface ViewerListenOptions {
  /**
   * Bind-Adresse; Default ist die aufgelöste Hub-Bind-Adresse (`viewer.host ?? host ?? DEFAULT_HOST`).
   * Ein daraus **geerbter** Wildcard-Bind löst dieselbe Pflicht aus wie ein expliziter.
   */
  host?: string;
  /** Pflicht, sobald `--viewer` gesetzt ist; 0..65535; 0 erlaubt. */
  port: number;
  /** Öffentliche Origin; Default: aus Bind-Adresse und tatsächlichem Port abgeleitet. */
  origin?: string;
}

export interface ServerOptions {
  // … bestehend …
  viewer?: ViewerListenOptions & {
    assetsDir: string;
    allow: readonly string[];
    ttlSeconds: number;
    /** @deprecated Eingabe-Alias aus 0.13.0; wird auf `origin` normalisiert. */
    publicBaseUrl?: string;
  };
}

export interface RunningViewer {
  readonly server: Server;
  /** Tatsächlich gebundene Adresse. */
  readonly host: string;
  /** Tatsächlicher Port (auch bei `--viewer-port 0`). */
  readonly port: number;
  /** `viewerOrigin + base`. */
  readonly url: string;
  /** Öffentliche Origin, wie in Links/Cookies verwendet. */
  readonly origin: string;
}

export interface RunningServer {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  /** Nur vorhanden, wenn `--viewer` konfiguriert ist. */
  readonly viewer?: RunningViewer;
  /** Schließt beide Listener; wartet auf beide, wirft den ersten Fehler nach dem zweiten close. */
  close(): Promise<void>;
}

/**
 * Die **eine** Definition des Wildcard-Binds: `true` für die unspecified Adresse `""`,
 * `0.0.0.0`, `::` und `[::]`, sonst `false`. Wird ausschließlich auf die **aufgelöste**
 * Viewer-Bind-Adresse angewendet (`viewer.host ?? host ?? DEFAULT_HOST`), nie auf `undefined`
 * als Abwesenheit eines Flags. Eine Origin wird aus einer `true`-Adresse nie abgeleitet.
 */
export function isWildcardBind(address: string): boolean;

/** Startfehler vor dem Serving; `code` ist stabil und testbar. */
export type HubStartupErrorCode =
  | "viewer_origin_required"
  | "viewer_origin_is_hub_origin"
  | "cors_viewer_origin"
  | "cors_wildcard_with_viewer"
  | "viewer_origin_invalid"
  | "viewer_ttl_invalid";

export class HubStartupError extends Error {
  constructor(code: HubStartupErrorCode, message: string);
  readonly code: HubStartupErrorCode;
}

/**
 * `@internal`-Testseam für AC-F16: der aktuelle Modulzustand von `activeJournal`.
 * Nicht aus `server/index.ts` re-exportiert und kein öffentlicher Vertrag; nur Tests lesen ihn.
 */
export function activeJournalForTests(): Journal | null;

export function parseHubArgs(argv: string[]): HubOptions | string;
```

**Normative Regeln**

1. `resolveOptions()` erzeugt `ViewerOptions` inklusive `createViewerSessions(ttlSeconds)` und `createViewerTickets()` **genau einmal**. `ViewerOptions.ttlSeconds` wird auch programmatisch auf `60..604800` geprüft (nicht nur im CLI); außerhalb → `HubStartupError("viewer_ttl_invalid")`. `publicBaseUrl` wird auf `origin` normalisiert und mit den Origin-Regeln validiert (S2). `resolveOptions()` löst außerdem den Viewer-Bind als `viewer.host ?? host ?? DEFAULT_HOST` auf und wirft `HubStartupError("viewer_origin_required")`, wenn `isWildcardBind(resolvedViewerHost)` gilt und weder `origin` noch `publicBaseUrl` gesetzt ist — auch im programmatischen Pfad und auch bei `viewer.port === 0`.
2. `startHub()` baut **zwei explizite Context-Views** aus einer Feld-Allowlist. `viewerContext` wird **nicht** per `...baseContext` erzeugt:

   ```ts
   const viewerContext: HandlerContext = {
     store: baseContext.store,
     base: baseContext.base,
     environment: baseContext.environment,
     readOnly: baseContext.readOnly,
     allowEnvMismatch: baseContext.allowEnvMismatch,
     authSecret: baseContext.authSecret,
     verifyToken: baseContext.verifyToken,
     requiredScope: baseContext.requiredScope,   // dieselbe Funktion, dieselbe Scope-Semantik
     revokedTokens: baseContext.revokedTokens,   // dieselbe Set-Referenz, KEINE Kopie
     adminThrottle: baseContext.adminThrottle,
     presence: baseContext.presence,
     persist: baseContext.persist,
     version: baseContext.version,
     appName: baseContext.appName,
     exportedBy: baseContext.exportedBy,
     now: baseContext.now,
     viewer: resolved.viewer,          // dieselbe sessions/tickets-Instanz, inkl. hubOrigin
     surface: "viewer",
     bind: viewerBind,
     hostAliases: viewerHostAliases,
     cors: undefined,
   };
   ```

   Nicht übernommen werden insbesondere `adminSecret`, `tokenIssuer`, `revokeToken`, `devicesPath`, `revocationPath`, `root`, `registry` und `federation`. `revokedTokens` ist die **selbe** `Set`-Referenz wie im Hub-Context (`liveRevoked`): eine Revocation über `/admin/devices/revoke` wirkt damit sofort auch auf der Viewer-Fläche (AC-5.32). `version`, `appName`, `exportedBy` und `now` sind nötig, damit Viewer-`/health` und Viewer-`/bundle` status-, content-type- und body-gleich zum Hub antworten; bei `/bundle` dürfen sich Kopfzeilen nur um Hub-CORS unterscheiden (AC-5.33). Der Viewer-Listener erhält zusätzlich eine abgeleitete `ResolvedOptions`-View mit `root: undefined` und `cors: undefined`; damit ist der statische Fallback strukturell aus, selbst wenn eine Pfadsperre einmal fehlen sollte. `hubContext` behält `surface: "hub"`, `bind: hubBind`, `cors: resolved.cors` und `root: resolved.root` **und** trägt `viewer: resolved.viewer` für den Launcher (Tickets/Origin); `authorize()` auf der Hub-Fläche konsultiert `viewerAuthorized()` trotzdem nie (§2.1 Regel 3).
3. `baseContext.store` ist `store.state`, `baseContext.persist` ist derselbe Closure. Es gibt **keinen** zweiten `createFileStore`-Aufruf und keine zweite `Journal`-Instanz. `ViewerOptions.hubOrigin` ist, wenn gesetzt, die **Bind-Origin** des Hubs und wird nach dem Hub-Bind nur dann gesetzt, wenn die gebundene Hub-Adresse loopback ist; bei nicht-loopback oder Wildcard-Bind bleibt sie ungesetzt. Die Prüfung ist bind-, nicht proxy-basiert: Hinter einem Loopback-Reverse-Proxy ist die Bind-Origin `http://127.0.0.1:<port>` und damit intern, sodass der 401-Hinweis dort die URL-lose Meldung nennt und keine interne Adresse als öffentliche Launcher-URL ausgibt. Eine öffentliche Launcher-URL würde einen expliziten öffentlichen Hub-Origin-Input voraussetzen, den diese Revision nicht einführt (§2.2 Regel 7, §4.9 Nr. 9).
4. `startHub()` bindet beide Listener (zuerst Hub, dann Viewer), bevor ein Request bedient wird, und **löst `viewer.origin` vor dem ersten bedienten Request auf**:
   - **Feste Ports** (`port !== 0` und `viewer.port !== 0` und (`viewer.origin`/`publicBaseUrl` gesetzt **oder** `!isWildcardBind(resolvedViewerHost)`)): Viewer-Origin `V` und Hub-Origin `H` sind aus expliziter Origin bzw. Bind-Adresse und festen Ports vollständig bestimmt. `startHub()` berechnet beide und führt die Prüfungen aus Regel 5 **synchron vor** `listen()` aus; erst dann werden die echten `request`-Handler attachiert und `listen()` gerufen. Ein Request kann daher weder eine undefinierte Origin noch einen ungeprüften Start sehen. `V` verwendet die konfigurierte Bind-Adresse (nicht die erst nach `listen()` aufgelöste Socket-Adresse), damit sie vor dem Bind feststeht; `context.bind` wird ebenfalls vor `listen()` aus der Konfiguration gesetzt und nach `listen()` durch die Socket-Adresse ersetzt (kein bind-loses Host-Gate im Startfenster), `RunningViewer.host` kommt aus dem Socket. Die Socket-Adresse ersetzt nach `listen()` nur `context.bind`/`RunningViewer.host`, nicht die bereits geprüfte Origin; die Grenze (`--host localhost` kann `::1` binden) steht in §4.9 Nr. 10.
   - **Wildcard-Bind:** Ist `isWildcardBind(resolvedViewerHost)` wahr und keine explizite Origin gesetzt, wirft `resolveOptions()` `HubStartupError("viewer_origin_required")` (Regel 1) — es gibt **keinen** `port 0`-Fallback und **keine** Ableitung. Eine Origin wird nie aus `""`, `0.0.0.0` oder `::` gebildet; `http://0.0.0.0:<port>` und `http://[::]:<port>` sind verbotene Ableitungen. Mit expliziter Origin ist die Origin bekannt; feste Ports validieren dann synchron vor `listen()`, `port 0` nach beiden Binds.
   - **`--viewer-port 0` (oder `--port 0`)**: beide Server werden gebunden; erst nach beiden `listen()`-Callbacks werden die tatsächlichen Adressen/Ports gelesen, `viewer.origin` und `hubOrigin` gesetzt und die Post-`listen()`-Validierung (Regel 5) ausgeführt. **Danach** werden die echten `request`-Handler installiert; `startHub()` resolved erst anschließend. Bis dahin beantwortet ein austauschbarer Start-Handler jeden Request auf beiden Listenern mit `503 service_not_ready` (`cache-control: no-store`, `retry-after: 1`, keine CORS-Kopfzeilen, kein `Location`/`Set-Cookie`) — kein Request erreicht `handleViewer()`/`handleViewerStart()` mit unbekannter Origin.
   - Schlägt der Viewer-Bind fehl, wird der Hub-Listener geschlossen, `activeJournal = null` gesetzt und der Fehler weitergereicht; es gibt keinen halben Start.

5. **Startvalidierung (verbindlich):** Sobald beide Origins bestimmt sind (feste Ports: **vor** `listen()`; `port 0`: nach beiden `listen()`-Callbacks) und **bevor** die echten `request`-Handler installiert werden bzw. `startHub()` zurückkehrt, werden die tatsächlichen Origins geprüft:
   - `isWildcardBind(resolvedViewerHost)` und keine explizite Origin → `HubStartupError("viewer_origin_required")`, bevor irgendein Listener gebunden wird. Diese Prüfung ist die Defense-in-Depth-Wiederholung von Regel 1 für programmatische Aufrufer.
   - Hub-Origin `H` aus gebundener Adresse + tatsächlichem Port (Scheme `http`).
   - Viewer-Origin `V` aus expliziter `origin` oder abgeleitet aus gebundener Adresse + tatsächlichem Port (IPv6 in `[]`); die Ableitung ist nur erlaubt, wenn `isWildcardBind(resolvedViewerHost)` falsch ist.
   - `normalizeOrigin(V) === normalizeOrigin(H)` → beide Listener schließen, `HubStartupError("viewer_origin_is_hub_origin")`.
   - `resolved.cors === "*"` → beide schließen, `HubStartupError("cors_wildcard_with_viewer")` (programmatischer Pfad; der CLI-Pfad lehnt bereits beim Parsen ab).
   - `resolved.cors` ist eine konkrete Origin und normalisiert gleich `V` → beide schließen, `HubStartupError("cors_viewer_origin")`.
   - `resolved.viewer.origin` ist gesetzt, aber ungültig (Pfad/Query/Fragment/kein http(s)) → beide schließen, `HubStartupError("viewer_origin_invalid")`.

   `normalizeOrigin(value)` ist die eine Vergleichsnormalisierung (Scheme/Host kleingeschrieben, Default-Port entfernt, keine Userinfo, kein Pfad/Query/Fragment; `null` bei ungültigem Wert). Das Scheme bleibt Bestandteil des Vergleichs: `https://host:port` und `http://host:port` sind **ungleich** und lösen keinen `viewer_origin_is_hub_origin` aus (AC-F21). **Jeder** Fehlerzweig der Origin-Vergleiche — nicht der vorgelagerte `viewer_origin_required`-Check aus Regel 1 — schließt die bereits gebundenen Listener (feste Ports: keine, die Prüfung lief vor `listen()`; `port 0`: beide), setzt `activeJournal = null` und wirft den `HubStartupError`; ein späterer `startHub()` startet ohne stale Journal (AC-F16). Der `viewer_origin_required`-Zweig läuft vor `activeJournal = journal` und lässt einen früheren Modulzustand unverändert. Diese Prüfung schließt den `--viewer-port 0`/`--port 0`-Blindfleck und läuft **vor** dem Serving. D10 bleibt damit normativ und ist nicht bloß „best effort“.
6. `RunningViewer.host`/`port` werden aus dem Socket gelesen. `viewer.origin` ist die explizite Origin oder abgeleitet als `http://<bracketed host>:<port>` — bei festen Ports aus der konfigurierten Bind-Adresse und dem festen Port (vor `listen()`), bei `port 0` aus der Socket-Adresse und dem tatsächlichen Port; die Origin trägt keinen Pfad, keine Query und kein Fragment. Eine Ableitung aus einer Wildcard-Adresse (`""`, `0.0.0.0`, `::`, `[::]`) ist verboten; in diesem Fall ist die Origin zwingend explizit (Regel 1/5). Die feste-Ports-Ableitung aus der konfigurierten Bind-Adresse ist die dokumentierte Grenze aus §4.9 Nr. 10. **Eine abgeleitete Origin bleibt `http`:** `startHub()` löst `viewer.origin` vor dem ersten bedienten Request auf (Regel 4/5), und `publicOrigin()` gibt eine gesetzte Origin unverändert zurück (§2.2 Regel 3). Ein Loopback-`X-Forwarded-Proto: https` hebt eine abgeleitete Origin daher **nicht** an. Der XFP-Zweig von `publicOrigin()` gilt nur, wenn `origin` **unset** ist (eingebetteter/programmatischer Kontext), ist keine `startHub()`-Eigenschaft und wird nicht über `startHub()` geprüft. Für TLS/Reverse-Proxy ist `--viewer-origin` Pflicht (A3, RR-11, RK-21).
7. `RunningViewer.url` ist `viewer.origin` + normalisierter `base`. `RunningServer.url` bleibt `http://<configured host>:<port><base>` (bestehendes Verhalten).
8. `close()` schließt beide Listener mit `Promise.allSettled`; nach dem Warten auf beide wird der erste Fehler geworfen. Ein Fehler beim Schließen des einen verhindert nicht das Schließen des anderen.
9. `StartupWarning.code` wird erweitert: `"unauthenticated_non_loopback" | "cors_wildcard" | "viewer_cookie_shared_host" | "viewer_non_loopback_insecure" | "viewer_public_url_deprecated"`. `startupWarnings()` ist rein und bekommt zusätzlich `viewer?: { host, origin, usedPublicUrlAlias }`; `startHub()` schreibt die Warnungen vor dem Serving auf stderr, `--quiet` unterdrückt sie nicht. `parseHubArgs` emittiert keine Warnungen (reine Funktion).
10. Die Startzeile nennt beide Adressen (sofern `--viewer`), ohne Secrets: `bluepencil server: "<name>" on http://host:port<base> — viewer on https://view.example.com<base> — N note(s), …`. `--quiet` unterdrückt die Fortschrittszeile, nicht die Warnungen aus §4.7.
11. **`activeJournal`-Reset ist normativ, aber nicht über die öffentliche API beobachtbar.** Jeder Fehlerzweig **nach** `activeJournal = journal` setzt `activeJournal = null`. Weil `--journal file` einen Flush als No-op implementiert und Koaleszenz nur das `git`-Backend betrifft, ist die frühere Behauptung „ein späterer Flush schreibt nach `<dir1>`“ kein tragfähiger Black-Box-Beleg. Für AC-F16 wird deshalb der `@internal`-Testseam `activeJournalForTests()` bereitgestellt (nicht aus `server/index.ts` re-exportiert); der Black-Box-Teil prüft nur, dass ein späterer Start ausschließlich nach `<dir2>` schreibt.

### 2.5 `server/cors.ts` — Bookmarklet-Preflight und tatsächliche Antwort

```ts
/**
 * Nur für die Viewer-Fläche und nur für `{base}/notes*`:
 * 204, wenn `method === "OPTIONS"`, `requestOrigin` ein gültiger absoluter http(s)-Origin ist
 * UND `requestedHeaders` (kommasepariert, case-insensitiv) `x-bluepencil-viewer` enthält.
 * Reflektiert den Origin, erlaubt `content-type` und `x-bluepencil-viewer`,
 * sendet NIE `access-control-allow-credentials`, setzt `Vary: Origin`.
 * null in jedem anderen Fall (auch: fehlender Requested-Header).
 */
export function viewerBookmarkletPreflight(
  method: string | undefined,
  requestOrigin: string | undefined,
  requestedHeaders: string | undefined,
): PreflightAnswer | null;

/** Die gleiche Reflektion für die eigentliche Antwort (nicht nur OPTIONS). */
export function viewerBookmarkletCors(
  requestOrigin: string | undefined,
): Record<string, string>;

/**
 * CORS-Header für `json()`/`errorResponse()`:
 * - surface "hub": `corsHeaders(context.cors)` (unverändert).
 * - surface "viewer": nur für `{base}/notes*` **und** `method !== "OPTIONS"` `viewerBookmarkletCors(origin)`, sonst `{}`.
 * - Auf der Viewer-Fläche wird `context.cors` nie gelesen; ein `OPTIONS` erhält seine CORS-Kopfzeile
 *   ausschließlich aus `viewerBookmarkletPreflight()` (204) oder gar keine (negativer 405).
 */
export function responseCorsHeaders(
  request: Pick<ServerRequest, "url" | "headers" | "method">,
  context: HandlerContext,
): Record<string, string>;
```

**Normative Regeln**

1. `viewerBookmarkletPreflight()` antwortet nur auf `OPTIONS` mit einem gültigen absoluten `http(s)`-`Origin` (kein Pfad, keine Query, kein Fragment, keine Userinfo) **und** einem `Access-Control-Request-Headers`-Wert, der `x-bluepencil-viewer` case-insensitiv enthält: `204`, `access-control-allow-origin: <reflektiert>`, `access-control-allow-methods: GET, POST, PATCH, OPTIONS`, `access-control-allow-headers: Content-Type, X-Bluepencil-Viewer`, `access-control-max-age: 600`, `vary: Origin`. **Kein** `access-control-allow-credentials`. Sonst `null`. Ein `allowMethods`-Parameter entfällt: die Preflight-Antwort ist für die gesamte `/notes*`-Familie die dokumentierte Union (jede Route-Menge ist eine Teilmenge); die routenspezifische Liste erscheint nur im `Allow` einer `405`.
2. `viewerBookmarkletCors()` liefert dieselbe reflektierte `access-control-allow-origin`-Kopfzeile plus `vary: Origin` für die eigentliche Antwort; sonst `{}`.
3. **Call Sites der tatsächlichen Antwort (verbindlich; der Request wird durchgereicht):** In `server/handler.ts` erhalten `json` und `errorResponse` einen `request`-Parameter — `json(status, payload, context, request)` und `errorResponse(status, code, message, context, request)` — und rufen statt `corsHeaders(context.cors)` die neue `responseCorsHeaders(request, context)` auf. `gateRequest(request, context)` und `routeRequest(request, context)` besitzen den Request bereits und reichen ihn an `health(request, context)`, `configResponse(request, context)`, `listNotes(query, context, request)`, `readNote(id, query, context, request)` sowie an `toErrorResponse(error, context, request)` weiter. `applyMutation(context, request, mutate, event?)` gibt den Request an `toErrorResponse` weiter. Damit tragen auch Fehler, die erst in `listNotes`, `readNote` oder einer Mutation entstehen, den reflektierten Origin. Ein alternativer per-Request-Header-Provider ist zulässig, solange er dieselbe Garantie erfüllt; verbindlich ist die genannte Durchreich-Variante. Auf der Viewer-Fläche gilt das ausschließlich für `{base}/notes*` — Erfolg (`GET /notes` → `200`) **und** jeder Fehler (`401`/`403`/`404`/`405`/`429` sowie die Validierungs-`400` aus `invalid_query` beim GET bzw. `invalid_payload` bei POST/PATCH) —, aber **nicht für `OPTIONS`**: der `204`-Preflight kommt aus `viewerBookmarkletPreflight()`, der negative `405` trägt keine CORS-Kopfzeile. Jede andere Viewer-Route und jede Antwort aus `viewerSurfaceRefusal()`/`hubViewerPathRefusal()` trägt **keinen** reflektierten Origin. Die `{base}/bundle`-Route baut ihre Header heute inline (`server/handler.ts:1768-1772`) und wird ebenfalls auf `responseCorsHeaders(request, context)` umgestellt; auf der Viewer-Fläche ergibt das `{}`, auf dem Hub bleibt die Antwort status-/content-type-/body-gleich zum Ist-Stand (Kopfzeilen dürfen sich nur um Hub-CORS unterscheiden, §4.6).
4. `gateRequest()` ruft auf der **Hub**-Fläche weiterhin `preflightResponse()` für bekannte Pfade auf. Auf der **Viewer**-Fläche gilt §2.1 Regel 11: `OPTIONS {base}/notes*` ist `204` nur mit gültigem `Origin` **und** `Access-Control-Request-Headers: x-bluepencil-viewer`; sonst `405 method_not_allowed` mit `Allow` und ohne CORS-Kopfzeilen. `OPTIONS {base}/bundle` und `{base}/sessions` sind `405` mit `Allow: GET`. Kein `OPTIONS` auf der Viewer-Fläche erreicht `authorize()` und keines antwortet `401`.
5. Die Hub-`--cors`-Logik (`corsOriginPolicy`, `preflightResponse`, `corsHeaders`) bleibt unverändert. `--cors '*'` mit `--viewer` ist ein Nutzungsfehler (D10).
6. Der reflektierte Origin ist **keine** Autorisierung: die Grenze ist der `x-bluepencil-viewer`-Token. Ein Origin ohne Token erhält auf der Viewer-Fläche fail-closed `401` — mit reflektiertem `Allow-Origin`, damit der Bookmarklet-Client den Fehler lesen kann.

### 2.6 `src/federation/net-policy.ts` — Wiederverwendung, keine API-Änderung

Verwendet werden unverändert:

```ts
export type HostResolver = (hostname: string) => Promise<readonly string[]>;
export type AddressClass = "public" | "private" | "loopback" | "link-local" | "reserved" | "metadata" | "invalid";
export function classifyAddress(address: string): AddressClass;
export const METADATA_HOSTNAMES: readonly string[];
export const METADATA_ADDRESSES: readonly string[];
export function createDnsResolver(options?: { timeoutMs?: number }): HostResolver; // Default 2000 ms
```

Es wird **keine** Kopie der IP-Arithmetik angelegt. `bluepencil` bleibt ohne neue Runtime-Dependency; `node:dns` wird weiterhin dynamisch importiert. `METADATA_HOSTNAMES` wird in `checkTarget()` vor der Allowlist und vor DNS geprüft.

### 2.7 Cookie-Contract

| Attribut | Wert | Bedingung |
|---|---|---|
| Name | `bp_viewer` | immer |
| `HttpOnly` | vorhanden | immer |
| `SameSite` | `Lax` | immer |
| `Path` | normalisierter `base` (`/` bei leerem base) | immer |
| `Max-Age` | `ttlSeconds` (Default 28800, `60..604800`) | immer |
| `Secure` | vorhanden | genau dann, wenn die aufgelöste öffentliche Viewer-Origin `https:` ist |
| `Domain` | nicht gesetzt (host-only) | immer |

### 2.8 Routen- und Statusmatrix pro Surface

Alle Pfade relativ zu `base` (Default `/api/v1/bluepencil`). `--root`-Static liegt außerhalb von `base`.

| Route | Hub-Fläche | Viewer-Fläche | Auth auf der Viewer-Fläche | Notizen/Secrets |
|---|---|---|---|---|
| `GET /viewer/start?k=…` / `x-bluepencil-admin` | **302** zur Viewer-Origin mit Ticket | **404** | `adminThrottle` (`admin`), Operator-Secret | kein Notiz-Body; Secret nur auf der Hub-Origin |
| `GET /viewer?ticket=…` | **404** | **302** + `Set-Cookie`, dann `/viewer` | Einmal-Ticket (60 s, single-use) | kein Notiz-Body |
| `GET /viewer` | **404** (auch mit `--root`) | **200** Shell | Viewer-Session | Shell enthält keine Notizen |
| `GET /view?url=…` | **404** (auch mit `--root`) | **200** proxied HTML | Viewer-Session | Endpoint zeigt auf Viewer-Origin |
| `GET /viewer/assets/<bundle>` | **404** (auch mit `--root`) | **200** JS | **öffentlich, vor der Session-Prüfung** | statisches Bundle, keine Notizen |
| `GET /viewer/bookmarklet.txt` | **404** (auch mit `--root`) | **200** Text | Viewer-Session | Platzhalter, kein Live-Token |
| `GET /notes` | ja | ja | Viewer-Session **oder** Client-Credential | Notizen |
| `POST /notes` | ja | ja | Viewer-Session **oder** Client-Credential | Notizen |
| `GET/PATCH /notes/{id}` | ja | ja | Viewer-Session **oder** Client-Credential | Notizen |
| `POST /notes/{id}/messages` | ja | ja | Viewer-Session **oder** Client-Credential | Notizen |
| `POST /notes/bulk-delete` | ja | ja | Viewer-Session **oder** Client-Credential | Notizen |
| `GET /sessions` | ja | ja | Viewer-Session **oder** Client-Credential | Sitzungs-Metadaten |
| `GET /bundle` | ja | ja | Viewer-Session **oder** Client-Credential | alle Notizen |
| `GET/HEAD /health` | ja, öffentlich (vor `authorize()`) | ja, öffentlich (vor `authorize()`) | keine | drei Felder, keine Notizen |
| `GET /config` | ja, öffentlich | **404** | — | Bind/Auth-Modus/Föderation |
| `GET /journal` | ja | **404** | — | Audit-Metadaten |
| `POST /mcp` | ja | **404** | — | MCP-Door |
| `GET /admin`, `/admin/*` | ja (Admin-Gate) | **404** | — | Token-Minting/Revocation |
| `--root`-Static (andere Pfade) | ja | **404** | — | statische Dateien |
| `OPTIONS /notes*` | gemäß `--cors` | **204** bei gültigem Header-Token-Preflight, sonst **405** mit `Allow`; kein `401` | — | keine |
| `OPTIONS /bundle`, `/sessions` | gemäß `--cors` | **405** mit `Allow: GET`; kein Preflight, kein `401` | — | keine |

**Hinweis `--root` auf der Hub-Fläche:** `hubViewerPathRefusal()` sperrt `/viewer`, `/view` und `/viewer/assets/*` auf der Hub-Fläche **vor** dem statischen Fallback — sowohl unter `{base}` als auch unpräfigiert. Ein Betreiber-`index.html` kann damit keinen Viewer-Inhalt unterschieben. Andere statische Pfade bleiben unverändert erreichbar (RT-05).

### 2.9 Fehlerformen

Alle JSON-Fehler haben die Form `{ "error": { "code": string, "message": string } }`, `content-type: application/json; charset=utf-8`, `cache-control: no-store`. `302`-Antworten haben einen leeren Body.

Die Codes `missing_url`, `target_not_allowed`, `target_metadata_host`, `unresolvable_host`, `target_address_forbidden`, `target_forbidden_origin`, `target_too_large`, `target_not_html`, `target_unreachable` und `too_many_redirects` sind **viewer-lokal** und nicht Teil von `ERROR_CODES` (`server/handler.ts`); sie werden von der lokalen `refusal(status, code, message)` in `server/viewer.ts` erzeugt. `service_not_ready` ist **kein** Viewer-Zielcode und ebenfalls **nicht** Teil von `ERROR_CODES`; er wird als lokale Antwortstruktur vom Start-Handler **beider** Listener in `server/hub.ts` (`GlueResponse`) und von `handleViewerStart()` ohne `viewer.origin` (`ServerResponse`) mit Status/Headers/Body erzeugt — nie über `glueError()`, dessen `code`-Parameter auf `ServerErrorCode` typisiert ist. Die übrigen Codes der Tabelle (`unauthorized`, `token_revoked`, `host_not_allowed`, `not_found`, `method_not_allowed`, `invalid_query`, `invalid_payload`, `too_many_attempts`) sind die gemeinsame Handler-Vokabel.

| Status | Code | Situation |
|---|---|---|
| 400 | `missing_url` | `/view` ohne `?url` |
| 400 | `invalid_query` | ungültiger Query-Filter auf `{base}/notes*` (z. B. `GET /notes?intent=falsch`); auf der Viewer-Fläche mit reflektiertem `Allow-Origin` (§2.5 Regel 3) |
| 400 | `invalid_payload` | ungültiger Body/Filter auf `{base}/notes*` (z. B. `POST /notes`); auf der Viewer-Fläche mit reflektiertem `Allow-Origin` (§2.5 Regel 3) |
| 401 | `unauthorized` | fehlende/ungültige Viewer-Session (Message aus `viewerSessionRefusalMessage()`, §2.2 Regel 7); ungültiges/abgelaufenes/verbrauchtes Ticket; fehlendes/falsches Operator-Secret am Launcher; `?k=` auf einer session-geschützten Viewer-Route |
| 401 | `token_revoked` | gültig signiertes Geräte-Token mit widerrufenem `jti` (beide Flächen; §2.1 Regel 2.3) |
| 403 | `host_not_allowed` | Host-Gate (Loopback-Bind, fremder `Host`) |
| 403 | `target_not_allowed` | Protokoll, Userinfo oder Allowlist verletzt |
| 403 | `target_metadata_host` | Hostname in `METADATA_HOSTNAMES` |
| 403 | `unresolvable_host` | Resolver wirft, liefert `[]` oder keinen IP-Literal |
| 403 | `target_address_forbidden` | IP-Klasse loopback/link-local/metadata/reserved/invalid; private ohne exakten Eintrag |
| 403 | `target_forbidden_origin` | Ziel ist in `forbiddenOrigins` |
| 404 | `not_found` | unbekannter Pfad; jede per `viewerSurfaceRefusal()`/`hubViewerPathRefusal()` gesperrte Route; unbekanntes Asset |
| 405 | `method_not_allowed` | nicht dokumentierte Methode, mit `Allow`-Header |
| 413 | `target_too_large` | Ziel größer als `VIEWER_MAX_BYTES` |
| 415 | `target_not_html` | Ziel liefert keinen HTML-Content-Type |
| 429 | `too_many_attempts` | `admin`-Budget erschöpft; `Retry-After: 300` |
| 502 | `target_unreachable` | Fetch-Fehler, fehlendes `Location`, Nicht-200-Ziel |
| 502 | `too_many_redirects` | mehr als `VIEWER_MAX_REDIRECTS` Hops |
| 503 | `service_not_ready` | Startfenster (beide Listener; `startHub` hat `viewer.origin` noch nicht aufgelöst) oder `handleViewerStart` ohne `viewer.origin`; lokale `GlueResponse`, kein `ERROR_CODES`-Code, kein `Location`, kein `Set-Cookie`, `Retry-After: 1` |

### 2.10 Geänderte und entfernte Symbole (Breaking-Liste)

| Symbol | 0.13.0 | Ziel | Kompatibilität |
|---|---|---|---|
| `ViewerOptions.publicBaseUrl` | `string?` | `origin?: string` | `publicBaseUrl` bleibt als deprecated Eingabe-Alias (S2, **Spec-Ergänzung** zum Design) |
| `ServerOptions.viewer.publicBaseUrl` | `string?` | `origin?: string` | dito |
| `ViewerOptions.hubOrigin` | — | `string?` | neu; nur für den 401-Hinweis, kein Secret; nur bei loopback Hub-Bind gesetzt (§4.9 Nr. 9) |
| `sessionCookie(token, ttlSeconds, base)` | 3 positional | `sessionCookie(token, { ttlSeconds, base, secure })` | intern; alle Aufrufer/Tests werden angepasst |
| `ServerOptions.viewer` | `{assetsDir, allow, ttlSeconds, publicBaseUrl?}` | `+ host?, port (required), origin?` | `--viewer` ohne `port` ist ein Nutzungsfehler (D7) |
| `authorize()` | Viewer-Session global akzeptiert | surface-scoped | Sicherheitsänderung; AC-5.11 |
| `isViewerRequest()` | pfadbasiert | unverändert pfadbasiert; Dispatch **surface- und pfad-gated** (`surface === "viewer"` **und** `isViewerRequest()`) | Unit-Tests bleiben gültig; schützt `/health`, `/notes*`, `/sessions`, `/bundle` vor der Viewer-Door |
| `viewerSessionRefusalMessage()` | — | neu | eine Meldung für alle Viewer-Session-Ablehnungen; kein `{base}/viewer?k=` mehr |
| `HubStartupError`/`HubStartupErrorCode` | — | neu (sechs Codes) | neues Symbol; `viewer_origin_required` ist der zusätzliche Code |
| `isWildcardBind()` | — | neu | die eine Wildcard-Bind-Definition (`""`, `0.0.0.0`, `::`, `[::]`) |
| `handleViewer()` deps | `{ fetchImpl? }` | `{ fetchImpl?, resolver? }` | additiv |
| `handleViewer()` Rückfall | unbekannter Pfad → `404` | URL außerhalb `isViewerRequest()` → `null` (Defense in Depth); der Dispatch ruft es ohnehin nur für Viewer-Pfade | intern; direkte Tests werden angepasst |
| `targetRefusal()` | `string \| null` | `TargetRefusal \| null` | interner Vertrag; `checkTarget()` nutzt denselben Typ |
| `checkTarget()` | existiert nicht | `Promise<TargetRefusal \| null>`, total | neu |
| `viewerBookmarkletPreflight()` | existiert nicht | `requestedHeaders`-Parameter; **kein** `allowMethods` | neu; Methode-Header ist die feste `/notes*`-Union |
| `StartupWarning.code` | zwei Werte | fünf Werte | additiv; `startupWarnings()` erweitert |
| `RunningServer` | ein Listener | `viewer?: RunningViewer`; `close()` schließt beide | additiv, außer `close()`-Semantik |

## 3. Datenfluss

### 3.1 Operator-Start (Ticket)

1. Operator öffnet `GET http://hub:8787/api/v1/bluepencil/viewer/start?k=<admin-secret>` (oder mit `x-bluepencil-admin`).
2. **Hub-Listener:** Host-Gate (`hubBind`) → Launcher-Prüfung `isViewerStartRequest()` → `hubViewerPathRefusal()` (greift für `/viewer/start` nicht; Reihenfolge wie §2.1 Regel 5) → `verifyOperatorSecret()` (konstantzeitiger Vergleich, `admin`-Budget) → `tickets.mint()`.
3. Antwort: `302 Location: https://view.example.com/api/v1/bluepencil/viewer?ticket=<ticket>`, Header `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. Kein `Set-Cookie`.
4. Browser folgt zur **Viewer-Origin**.
5. **Viewer-Listener:** Host-Gate (`viewerBind` + `--viewer-origin`-Hostname) → `viewerSurfaceRefusal()` (erlaubt `/viewer`) → `handleViewer` erkennt `?ticket=` → `tickets.consume(ticket)` atomar.
   - ungültig/abgelaufen/bereits verbraucht → `401 unauthorized`, **kein** Cookie.
   - gültig → `sessions.mint()`; `Set-Cookie: bp_viewer=…; HttpOnly; SameSite=Lax; Path=<base>; Max-Age=<ttl>[; Secure]`; `302 Location: <base>/viewer` (ohne Query); `Referrer-Policy: no-referrer`; `Cache-Control: no-store`.
6. `GET <base>/viewer` mit Cookie → Shell.

Der Admin-Secret-Wert erreicht die Viewer-Origin **nie**. `?k=` auf der Viewer-Origin wird nicht verglichen, sondern mit `401` und dem Hinweis auf den Hub-Launcher abgelehnt.

### 3.2 Shell, Proxy, Asset

1. Shell (`GET /viewer`) rendert URL-Formular, Allowlist, Bookmarklet. Das Formular setzt `iframe.src = <viewerOrigin><base>/view?url=…`.
2. `GET /view?url=<target>` mit Viewer-Cookie:
   - `checkTarget(target, allow, { resolver, forbiddenOrigins: [viewer.origin], allowPrivateExact: true })` → Protokoll, Userinfo, Allowlist, Metadata-Hostname, DNS-Auflösung, IP-Klassifikation.
   - `fetch(current, { redirect: "manual", signal: AbortSignal.timeout(VIEWER_FETCH_TIMEOUT_MS) })`.
   - Jeder `3xx`-`Location`-Hop wird erneut durch `checkTarget()` geprüft; maximal `VIEWER_MAX_REDIRECTS`.
   - Größen-/Content-Type-/Status-Prüfung wie heute.
   - `buildViewDocument()` mit absoluter `endpoint = <viewerOrigin><base>` und `elementSrc = <viewerOrigin><base>/viewer/assets/bluepencil.element.min.js`.
   - `<meta http-equiv="content-security-policy">` wird entfernt; die Antwort trägt keine CSP-Kopfzeile.
   - Antwort `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
3. `GET /viewer/assets/<bundle>` wird **vor** der Session-Prüfung bedient und ist **öffentlich** (kein Cookie, kein Header). Ein `<script src>` auf einer fremden Seite kann weder einen `SameSite=Lax`-Cookie (cross-site Subresource) noch einen Custom-Header senden. Die Route liefert nur die zwei bekannten Bundles aus `VIEWER_ASSET_FILES`, mit `Access-Control-Allow-Origin: *`, `Cross-Origin-Resource-Policy: cross-origin`, `Cache-Control: no-cache`. Unbekannter Basename → `404`, ebenfalls ohne Session.
4. `GET /viewer/bookmarklet.txt` ist session-geschützt und enthält nur den Platzhalter `__BP_VIEWER_TOKEN__`, keinen Live-Token.

### 3.3 Schreibpfad (Layer → Viewer-Origin → gemeinsamer Store)

1. Die in `/view` injizierte `<bluepencil-notes endpoint="<viewerOrigin><base>">` läuft auf der Viewer-Origin. `fetch` sendet den `bp_viewer`-Cookie same-origin automatisch (`credentials: "same-origin"` ist der Browser-Default).
2. **Viewer-Listener** `POST <base>/notes`:
   - Host-Gate (`viewerBind`).
   - `earlyRefusal()` (surface-gated) → `gateRequest()` → `viewerSurfaceRefusal()` (Pfad ist erlaubt) → `authorize()`:
     - `viewerAuthorized()` prüft `x-bluepencil-viewer` oder `bp_viewer` → `null` (erlaubt).
     - ohne Session und ohne konfiguriertes Client-Credential → `401` (fail-closed), mit reflektiertem `Allow-Origin`, wenn der Request einen gültigen `Origin` trägt.
   - Body lesen, `store.state.notes = loadNotes(options.storePath)` (frischer Stand), `handleRequest` mutiert `context.store.notes` (neues Array), `context.persist`:
     - `store.persist(state)` schreibt `options.storePath` atomar.
     - `journal.record(describeMutation(...))` schreibt in dasselbe Journal.
3. **Hub-Listener** `GET <base>/notes`: lädt `store.state.notes = loadNotes(options.storePath)` vor dem Request und liefert die Notiz.
4. **Hub-Listener** `POST <base>/mcp` mit `tools/call list_notes`: `handleMcpRoute` liest `readTextIfExists(options.storePath)` — dieselbe Datei, dieselbe Notiz.
5. **Hub-Listener** `GET <base>/bundle` und `GET <base>/journal`: dieselbe kanonische Form bzw. dasselbe Journal.

### 3.4 Genau ein Store, ein Journal — Begründung

- `startHub()` ruft `createFileStore()` **genau einmal** auf. `hubContext.store` und `viewerContext.store` zeigen auf dasselbe `store.state`-Objekt.
- `persist` ist **ein** Closure über `store` und `journal`; beide Listener verwenden denselben `context.persist`.
- `handleMcpRoute` bekommt `read`/`write`-Callbacks, die `options.storePath` lesen/schreiben — dieselbe Datei.
- Es gibt keine zweite `Journal`-Instanz und keine zweite Session-/Ticket-Map.
- Innerhalb des Prozesses sind `loadNotes` → `handleRequest` → `persist` nach dem `await readBody` **synchron und zusammenhängend**; der Node-Event-Loop kann sie nicht mit einer zweiten Mutation verzahnen. Fremde Prozesse bleiben last-writer-wins (Restrisiko §4.9).

## 4. Sicherheit

### 4.1 Was die eigene Origin kauft — und was nicht

**Kauft:**

- Der Hub-Port liefert keinen Viewer-Inhalt; ein proxied Dokument kann `/admin*`, `/mcp`, `/journal`, `/config` und `--root` nicht same-origin erreichen. `hubViewerPathRefusal()` gilt auch mit `--root`.
- Ein `bp_viewer`-Cookie autorisiert auf dem Hub-Port nichts; die Viewer-Session ist surface-scoped.
- Der Admin-Secret-Vergleich bleibt auf der Hub-Origin; proxied JavaScript kann das Secret nicht aus einem Formular auf der eigenen Origin lesen. Der Viewer-Context enthält `adminSecret` strukturell nicht.
- Ein XSS im Target läuft auf der Viewer-Origin, nicht auf der Hub-Origin.

**Kauft nicht:**

- Keine Sandbox: proxied JavaScript läuft weiterhin mit der Viewer-Origin und kann die Viewer-Session same-origin nutzen.
- Keine Cookie-Isolation bei gleichem Hostnamen (nur anderer Port).
- Keine Trennung von Netzwerk/Prozess: beide Listener teilen Prozess und Store.
- Keine automatische TLS-Isolation: `Secure` hängt an der öffentlichen Origin, nicht an der Bind-Adresse.

### 4.2 Fail-closed-Auth auf der Viewer-Fläche

Verbindlich ist §2.1 Regel 2: Viewer-Session → erlaubt; ohne Client-Credential → `401`; sonst normales Credential-Verfahren. Die Reihenfolge ist Teil der Sicherheitseigenschaft: die Fail-closed-Prüfung steht **vor** dem bestehenden Early-Return „kein Credential → offen“. Auf der Hub-Fläche wird `viewerAuthorized()` nicht aufgerufen.

### 4.3 Cookie-Scope

Verbindlich ist §2.7. Port-Isolation existiert nicht; bei gleichem Hostnamen wird `bp_viewer` auch an den Hub-Port gesendet, dort aber ignoriert. Empfohlene Produktionskonfiguration: eigener Hostname; Warnung `viewer_cookie_shared_host` ist nicht unterdrückbar.

### 4.4 Admin-Secret und Einmal-Ticket (D2)

- Das Admin-Secret wird ausschließlich auf der Hub-Origin geprüft (`verifyOperatorSecret()`), mit `adminThrottle` und konstantzeitigem Vergleich.
- Die Viewer-Origin erhält ein 24-Byte-/192-Bit-Ticket, TTL 60 s, single-use. Kein Peer-Binding: ein Ticket ist ein Bearer-Wert; kurze TTL und Single-Use sind die Gegenmaßnahme.
- `?k=` auf der Viewer-Origin wird **nicht** verglichen (kein Secret-Oracle, kein Throttle-Verbrauch) und mit `401` abgelehnt.
- Das Ticket erscheint nur in der `Location`-URL des 302; `Referrer-Policy: no-referrer` und `Cache-Control: no-store` begleiten die Antwort; der anschließende 302 führt auf eine saubere URL ohne Query.

### 4.5 Throttle

- Ein `admin`-Budget pro Peer, geteilt zwischen `/admin/*` und dem Launcher: 10 Fehlversuche / 5 Minuten; danach `429 too_many_attempts` + `Retry-After: 300`.
- Vor dem Vergleich wird das Budget geprüft, nach einem Fehlversuch verbraucht, nach Erfolg zurückgesetzt (`success`).
- Fehlende Werte verbrauchen kein Budget (kein Raten). **Änderung 2.1:** Das gilt jetzt auch für `/admin/*`; ein fehlendes `x-bluepencil-admin` ist `401`, aber kein Fehlversuch. Gewertet wird nur ein *falscher* Wert. Das ist bewusst (§5.3, `CHANGELOG` `Changed`/`Security`) und mit UT-16/RT-04 belegt.
- Ticket-Brute-Force braucht keinen Throttle (192 Bit); die Map-Obergrenze `VIEWER_MAX_TICKETS` verhindert Memory-DoS.

### 4.6 CORS

- Hub-Fläche: `--cors` unverändert. Mit `--viewer` sind **beide** folgenden Werte Nutzungsfehler: eine konkrete Origin, die normalisiert der Viewer-Origin entspricht (`cors_viewer_origin`), und `--cors '*'` (`cors_wildcard_with_viewer`). Damit kann eine Seite auf der Viewer-Origin weder das Hub-Journal noch `/config` oder `/health` per Wildcard lesen.
- Der CLI-Pfad lehnt beide Fälle beim Parsen ab, sofern die Viewer-Origin bekannt ist; bei `--viewer-port 0` ohne explizite Origin greift die Post-`listen()`-Prüfung in `startHub()` (§2.4 Regel 5).
- Viewer-Fläche: kein allgemeines CORS. Nur `OPTIONS {base}/notes*` mit `Origin` **und** `Access-Control-Request-Headers: x-bluepencil-viewer` wird beantwortet (§2.5).
- Die tatsächliche Antwort (Erfolg **und** Fehler) auf `{base}/notes*` trägt denselben reflektierten `Allow-Origin`; alle anderen Viewer-Routen nicht (§2.5 Regel 3). Das schließt den Erfolg (`GET /notes` → `200`) und die Validierungsfehler ein, die erst in `listNotes`/`readNote`/`applyMutation` entstehen (`400 invalid_query` bzw. `invalid_payload`); der Request wird dafür durch `json`/`errorResponse`/`toErrorResponse`/`applyMutation` durchgereicht (§2.5 Regel 3).
- **Kein** `Access-Control-Allow-Credentials`; die Autorisierung bleibt der Header-Token.
- Der Preflight wird vor `authorize()` beantwortet, aber ausschließlich für `{base}/notes*`; andere `OPTIONS` bleiben `404`/`405`.

### 4.7 Host-Gate, Reverse Proxy, TLS

- Der Viewer-Context hat sein eigenes `bind`. `hostRefusal()` prüft die Viewer-Bindung, nicht die Hub-Bindung.
- `hostAliases` des Viewer-Contexts enthält die Loopback-Schreibweisen (durch `isLoopbackHostHeader` bereits abgedeckt) und den Hostnamen aus `--viewer-origin`. Ein Loopback-Bind hinter einem Reverse Proxy akzeptiert damit `Host: view.example.com`.
- `X-Forwarded-Proto` wird nur berücksichtigt, wenn `request.remote` loopback ist **oder** `viewer.origin` explizit gesetzt ist (dann gilt ohnehin die explizite Origin). Ein entfernter Client kann die `Secure`-Entscheidung nicht fälschen.
- `publicOrigin()` liefert `viewer.origin`, wenn gesetzt; sonst `http://<Host-Header>` bzw. `https://…` nur für Loopback-Peers mit `X-Forwarded-Proto: https`.
- **Vergleichsbasis `viewer_cookie_shared_host`:** Die Hub-Origin wird aus der konfigurierten Hub-Bind-Adresse und dem Hub-Port gebildet; ein Wildcard-Bind (`0.0.0.0`, `::`, `""`) bedeutet „unter jedem Namen erreichbar“ und warnt, sobald der Viewer-Origin-Hostname kein Loopback-Name ist. Hinter einem Reverse Proxy kann die öffentliche Hub-Origin von der Bind-Adresse abweichen; die Spec kennt nur die Bind-Origin und dokumentiert diese Grenze (§4.9). Empfehlung bleibt ein eigener Hostname für den Viewer.
- Warnungen beim Start (`startHub()`, nicht durch `--quiet` unterdrückbar):
  - `viewer_cookie_shared_host`: Viewer-Origin-Hostname == Hub-Origin-Hostname (Vergleichsbasis oben).
  - `viewer_non_loopback_insecure`: Viewer-Bind nicht loopback und `viewer.origin` beginnt mit `http:`.
  - `viewer_public_url_deprecated`: `--viewer-public-url` verwendet.
- Der Hub bleibt plain HTTP. TLS terminiert extern; ein nginx-Muster proxied auf `127.0.0.1:<viewer-port>` und setzt `Host` und `X-Forwarded-Proto`.

### 4.8 SSRF-Härtung

`checkTarget()` ist die einzige Zielprüfung; `proxyTarget()` ruft sie vor dem Fetch **und** vor jedem Redirect-Hop auf. Die Funktion ist total und wirft nie.

1. Nur `http:`/`https:`; keine Userinfo; absolute URL. Sonst `target_not_allowed`.
2. `METADATA_HOSTNAMES` werden **vor** Allowlist und DNS geprüft. Ein Metadata-Name ist auch dann `target_metadata_host`, wenn er in `--viewer-allow` steht.
3. Host muss `hostAllowed()` erfüllen (exakt oder `*.suffix`), sonst `target_not_allowed`.
4. Ist der Host ein IP-Literal: `classifyAddress()`.
   - `public` → erlaubt.
   - `private` → nur erlaubt, wenn der Host **exakt** (kein `*.`, kein CIDR) in `--viewer-allow` steht und `allowPrivateExact !== false`.
   - `loopback`, `link-local`, `metadata`, `reserved`, `invalid` → `target_address_forbidden`.
5. Ist der Host ein Name: `createDnsResolver({ timeoutMs: 2000 })`; **jede** aufgelöste Adresse wird nach denselben Regeln wie in Punkt 4 klassifiziert. Eine einzige unzulässige Adresse lehnt das Ziel ab (fail-closed); `private` ist auch hier nur bei exaktem Allowlist-Eintrag zulässig. **Allowlist-Semantik:** ein exakter Hostname-Eintrag (`internal.example.com`) darf auf eine private Adresse (`10.0.0.5`) auflösen und wird dann erlaubt; ein Wildcard-Eintrag (`*.example.com`) darf das nie — `foo.example.com` mit `10.0.0.5` ist `target_address_forbidden`. Loopback/link-local/metadata/reserved bleiben in beiden Fällen verboten (AC-5.19).
6. Resolver wirft, liefert `[]` oder einen Nicht-IP-Wert → `unresolvable_host` (fail-closed), kein Fetch.
7. `forbiddenOrigins` (Viewer-Origin, optional Hub-Origin) wird normalisiert (Scheme + Host + Port) verglichen und → `target_forbidden_origin`, damit der Proxy sich nicht selbst als Ziel wählt.
8. Jeder Redirect-Hop durchläuft dieselbe Prüfung; `redirect: "manual"`.
9. Größe (`VIEWER_MAX_BYTES`), Timeout (`VIEWER_FETCH_TIMEOUT_MS`), Redirect-Anzahl (`VIEWER_MAX_REDIRECTS`) und Content-Type bleiben unverändert.

Nicht abgedeckt: TOCTOU zwischen DNS-Auflösung und Verbindungsaufbau (DNS-Rebinding). Connection-Pinning ist Follow-up (§4.9).

### 4.9 Restrisiken

1. **Gleicher Hostname, anderer Port:** `bp_viewer` wird auch an den Hub gesendet; der Hub ignoriert ihn, aber echte Cookie-Isolation fehlt.
2. **Proxied JavaScript ist same-origin mit der Viewer-Session:** es kann die Session nutzen; Allowlist und kurze TTL begrenzen das.
3. **DNS-Rebinding/TOCTOU:** der Check ist ein Pre-Check, kein Connection-Pinning.
4. **Last-writer-wins ohne Lock:** ein externer Schreiber zwischen `loadNotes` und `persist` kann eine Änderung verlieren. Innerhalb des Prozesses ist der Pfad synchron.
5. **Ticket-Diebstahl vor Einlösung:** 60 s, single-use, 192 Bit; kein Peer-Binding. Wer das Ticket vor dem Browser abgreift, erhält eine Session.
6. **Secret in der Hub-URL (`?k=`):** History/Proxy-Logs. Header-Variante wird empfohlen; `no-referrer`/`no-store` sind gesetzt.
7. **Reverse-Proxy-Hub-Origin:** `viewer_cookie_shared_host` vergleicht gegen die Bind-Origin. Eine öffentliche Hub-Origin, die nur im DNS/Proxy existiert, ist der CLI nicht bekannt; der Restfall wird nicht erkannt. Empfehlung: eigener Viewer-Hostname.
8. **`--viewer-public-url`-Alias:** Ein Bestandsdeployment, dessen alter Wert eine öffentliche Hub-Origin hinter einem Proxy bezeichnet, kann von der CLI nicht immer erkannt werden; die Ablehnung deckt die bind-basierte und jede in `--cors` genannte Hub-Origin ab. Semantikwechsel und Migrationspflicht stehen in `CHANGELOG`/`docs/VIEWER.md`.
9. **`hubOrigin` ist die Bind-Origin, nicht die öffentliche Hub-Origin:** `startHub()` setzt `viewer.hubOrigin` nur dann (auf `http://<Bind-Adresse>:<Port>`), wenn der Hub-Bind loopback ist; die Prüfung ist **bind-, nicht proxy-basiert**. Ein Loopback-Bind hinter einem Reverse Proxy erfüllt sie ebenfalls, die Bind-Origin ist dann aber `http://127.0.0.1:<port>` und damit intern — der 401-Hinweis nennt in dieser Topologie die URL-lose Meldung („open the hub launcher“) statt einer internen Adresse. Eine öffentliche Launcher-URL würde einen expliziten öffentlichen Hub-Origin-Input voraussetzen, den diese Revision nicht einführt; Betreiber dokumentieren die öffentliche Launcher-URL selbst.
10. **Feste Ports leiten die Origin aus der konfigurierten Bind-Adresse ab:** `--viewer-host localhost` kann `::1` binden; `viewer.origin`/`RunningViewer.origin` bleibt `http://localhost:<port>`, während `context.bind`/`RunningViewer.host` die Socket-Adresse tragen. `localhost` löst in derselben Umgebung auf die gebundene Adresse auf; für Reverse-Proxy-/TLS-Setups ist `--viewer-origin` Pflicht. Ein Post-`listen()`-Re-Check der Origin ist nicht Teil dieser Revision.
11. **`activeJournal`-Reset ist nur über den `@internal`-Testseam direkt prüfbar:** Black-Box-Evidenz (kein Schreiben nach `<dir1>`) ist nicht entscheidend, weil `--journal file` einen Flush als No-op implementiert und Koaleszenz nur das `git`-Backend betrifft. Der Reset bleibt normativ; AC-F16 stützt den Modulzustand auf `activeJournalForTests()`.

### 4.10 Threat Model — die vier Fragen

| Frage | Antwort |
|---|---|
| **Was wird gebaut?** | Zwei HTTP-Listener in einem Prozess, ein Datei-Store, In-Memory-Sessions/-Tickets, Operator-Auth über ein Secret auf der Hub-Origin und fail-closed Viewer-Sessions. |
| **Was kann schiefgehen?** | Surface-Verzweigung öffnet Notizen auf dem falschen Listener; Secret gelangt auf die Viewer-Origin; SSRF erreicht interne/metadata-Ziele; Cookie-Leak über gleichen Hostnamen; Ticket-Replay; `--cors '*'` lässt die Viewer-Origin das Hub-Journal lesen. |
| **Was wird dagegen getan?** | Surface-scoped `authorize()`; Launcher-Ticket statt Secret-Transfer; DNS/IP-Policy, Metadata-Hostnamen und Redirect-Prüfung; `HttpOnly`/`SameSite=Lax`/`Secure`/host-only; 60-s-single-use-Tickets; Route-Matrix + `viewerSurfaceRefusal()`/`hubViewerPathRefusal()`; `--cors '*'` mit Viewer verboten; Post-`listen()`-Validierung; Tests AC-5.9–5.12, 5.17–5.20, 5.25–5.31. |
| **Konsequenzen bei Versagen?** | Notiz-Exfiltration/-Manipulation, Admin-Fläche von proxied Code erreichbar, SSRF-Zugriff auf Cloud-Metadaten. Deshalb ist die Surface-Verzweigung sicherheitskritisch und jede Änderung braucht die AC-5-Matrix. |

## 5. CLI-Vertrag und Rückwärtskompatibilität

### 5.1 Flags, Env, Defaults

| Flag | Env | Default | Bedeutung |
|---|---|---|---|
| `--viewer[=true\|false]` | `BLUEPENCIL_VIEWER` | aus | aktiviert die Viewer-Fläche; strikt als Boolean geparst (`--viewer=false` = aus) |
| `--viewer-assets <dir>` | `BLUEPENCIL_VIEWER_ASSETS` | — | Pflicht bei `--viewer`; Verzeichnis mit den Element-Bundles |
| `--viewer-allow <host[,host]>` | `BLUEPENCIL_VIEWER_ALLOW` | — | Pflicht bei `--viewer`; exakte Hosts oder `*.suffix` |
| `--viewer-ttl <seconds>` | — | 28800 (8 h), `60..604800` | Session-Lebensdauer; auch programmatisch begrenzt |
| `--viewer-host <host>` | `BLUEPENCIL_VIEWER_HOST` | aufgelöster `--host` (Default `127.0.0.1`) | Bind-Adresse des zweiten Listeners; `""`, `0.0.0.0`, `::` sind Wildcard-Bind und lösen `viewer_origin_required` aus — auch wenn der Wert aus `--host` geerbt ist |
| `--viewer-port <port>` | `BLUEPENCIL_VIEWER_PORT` | — | **Pflicht bei `--viewer`**; 0..65535; 0 erlaubt |
| `--viewer-origin <url>` | `BLUEPENCIL_VIEWER_ORIGIN` | abgeleitet aus Bind+Port, **nie** aus einer Wildcard-Adresse | öffentliche Origin, z. B. `https://view.example.com`; keine Pfad/Query/Fragment |
| `--viewer-public-url <url>` | `BLUEPENCIL_VIEWER_PUBLIC_URL` | — | **deprecated Alias** für `--viewer-origin` (eine Release-Periode), mit denselben Origin-Regeln |

`--viewer-assets`, `--viewer-allow`, `--viewer-ttl`, `--viewer-host`, `--viewer-port`, `--viewer-origin` und `--viewer-public-url` ohne (aktives) `--viewer` sind Nutzungsfehler (`viewer_flags_without_viewer`), keine stillen No-Ops. `--viewer=false` ist „aus“; Viewer-Flags danach sind ebenfalls `viewer_flags_without_viewer`.

### 5.2 Validierungsmatrix

| Fall | Antwort aus `parseHubArgs` (einzeilig) | Fehlercode |
|---|---|---|
| `--viewer` ohne `--viewer-port` | `--viewer requires --viewer-port <port> (viewer_port_required) — the viewer must not share the hub port` | `viewer_port_required` |
| `--viewer-port` nicht ganzzahlig / außerhalb 0..65535 | `--viewer-port must be an integer between 0 and 65535 (got …)` | — |
| `--viewer-port` == `--port`, beide ≠ 0, gleiche normalisierte Bind-Adresse | `--viewer-port must differ from --port on the same bind address (viewer_port_conflict)` | `viewer_port_conflict` |
| `--port 0 --viewer-port 0` oder gleicher Port auf unterschiedlichen Bind-Adressen | akzeptiert; tatsächliche Origins werden nach `listen()` geprüft | — |
| `--viewer-origin` kein absolutes http(s) ohne Pfad/Query/Fragment | `--viewer-origin must be an absolute http(s) origin without path, query or fragment (viewer_origin_invalid)` | `viewer_origin_invalid` |
| `--viewer-origin`/`--viewer-public-url` == Hub-Origin (normalisiert **inkl. Scheme** — `normalizeOrigin` vergleicht Scheme + Host + Port; Bind-Origin oder in `--cors` genannte Origin) | `--viewer-origin must differ from the hub origin (viewer_origin_is_hub_origin)` | `viewer_origin_is_hub_origin` |
| der **aufgelöste** Viewer-Bind ist ein Wildcard-Bind (`""`, `0.0.0.0`, `::`, `[::]`) — explizit über `--viewer-host` **oder geerbt aus `--host`** — und weder `--viewer-origin` noch `--viewer-public-url` ist gesetzt | `--viewer-origin is required when the viewer bind is a wildcard address (viewer_origin_required)` | `viewer_origin_required` |
| `--viewer-assets`/`--viewer-allow`/`--viewer-ttl`/`--viewer-host`/`--viewer-port`/`--viewer-origin`/`--viewer-public-url` ohne aktives `--viewer` | `--viewer-* require --viewer (viewer_flags_without_viewer)` | `viewer_flags_without_viewer` |
| `--viewer-assets`/`--viewer-allow` fehlen bei `--viewer` | bestehende Fehlertexte (`--viewer requires --viewer-assets …`, mindestens ein Host in `--viewer-allow`) | — |
| `--viewer-ttl` nicht ganzzahlig / außerhalb 60..604800 | `--viewer-ttl must be an integer between 60 and 604800 (got …) (viewer_ttl_invalid)` | `viewer_ttl_invalid` |
| `--cors <viewer-origin>` | `--cors must not name the viewer origin (cors_viewer_origin)` | `cors_viewer_origin` |
| `--cors '*'` mit `--viewer` | `--cors '*' must not be combined with --viewer (cors_wildcard_with_viewer)` | `cors_wildcard_with_viewer` |
| `--viewer-public-url` gesetzt | akzeptiert, wenn Origin-Regeln erfüllt; Warnung `viewer_public_url_deprecated` aus `startHub()` auf stderr | — |
| `--viewer-origin` und `--viewer-public-url` gesetzt | Nutzungsfehler, sofern normalisiert ungleich: `--viewer-origin and --viewer-public-url disagree (viewer_origin_conflict)`; gleich → akzeptiert | `viewer_origin_conflict` (S1) |
| `--viewer=false` | Viewer aus; keine Viewer-Pflichtfelder | — |

Alle werttragenden Viewer-Flags (`--viewer-assets`, `--viewer-allow`, `--viewer-ttl`, `--viewer-host`, `--viewer-port`, `--viewer-origin`, `--viewer-public-url`) werden in die bestehende `VALUED_FLAGS`-Prüfung aufgenommen: ein Flag ohne Wert ist ein Nutzungsfehler `<flag> requires a value (got nothing)` und wird nicht stillschweigend als „abwesend“ behandelt (F5-Regel).

`--viewer-port 0` ist zulässig (Tests, ephemeral). Die tatsächliche Origin wird nach `listen()` aus der gebundenen Adresse und dem tatsächlichen Port abgeleitet, sofern `--viewer-origin` fehlt — **nie** aus einer Wildcard-Adresse: ein Wildcard-Bind macht `--viewer-origin` auch bei `--viewer-port 0` Pflicht (`viewer_origin_required`). Die `cors_viewer_origin`-/`viewer_origin_is_hub_origin`-Prüfung beim Parsen vergleicht nur, wenn die Viewer-Origin zum Parse-Zeitpunkt bekannt ist; andernfalls greift die Post-`listen()`-Validierung aus §2.4 Regel 5. Der Vergleich ist scheme-sensitiv: `https://127.0.0.1:8787` ist gegen einen Hub-Bind `http://127.0.0.1:8787` **kein** `viewer_origin_is_hub_origin`; für diesen Fall gilt `viewer_cookie_shared_host` (§4.7) statt eines Startfehlers (AC-F21).

### 5.3 Rückwärtskompatibilität

**Entscheidung: harter Fehler statt Kompatibilitätsmodus (D7).**

- `--viewer` ohne `--viewer-port` bricht den Start sichtbar. Ein Kompatibilitätsmodus würde die unsichere Topologie (Viewer auf dem Hub-Port) als Default fortschreiben und AC 5 für Bestandsdeployments aushebeln.
- Der Umzug ist für die Flags eine Zeile: `--viewer-port 8788` (oder ein anderer freier Port) ergänzen; bei TLS/Proxy zusätzlich `--viewer-origin https://view.example.com`.
- **`--viewer-public-url` ändert die Bedeutung:** In 0.13.0 bezeichnete der Wert die öffentliche Origin des Hub-Port-Viewers; jetzt ist er ein Alias für die Origin des zweiten Listeners. Ein Bestandsdeployment, das den alten Wert auf die Hub-Origin zeigt, wird abgelehnt (`viewer_origin_is_hub_origin`), damit der Launcher nicht auf eine 404-Origin umleitet. Der Alias wird eine Release-Periode gewarnt und dann entfernt. Der Semantikwechsel steht unter `Changed` in `CHANGELOG.md` und in `docs/VIEWER.md`.
- `--cors '*'` ist mit `--viewer` nicht mehr erlaubt; Bestandsdeployments müssen auf eine konkrete, vom Viewer verschiedene Origin oder auf „kein CORS“ wechseln. Auch das ist ein `Changed`-Eintrag.
- Alte Bookmarklets, die auf die Hub-Origin zeigen, schreiben nach dem Upgrade nicht mehr (der Hub akzeptiert keine Viewer-Session). Sie müssen aus der Viewer-Shell neu kopiert werden. Das ist ein bewusster Bruch und gehört in `CHANGELOG` (`Changed`/`Removed`) und `docs/VIEWER.md`.
- Alte Links `{base}/viewer?k=<secret>` auf der Hub-Origin laufen nach dem Upgrade auf `404`; der Nachfolger ist `{base}/viewer/start?k=<secret>` (S3, §10.1).
- **`/admin`-Throttle bei fehlendem Header:** 0.13.0 zählte ein fehlendes `x-bluepencil-admin` als Fehlversuch. 2.1 zählt nur einen *falschen* Wert; ein fehlendes Secret ist `401` ohne Budgetverbrauch. Ein Peer, der die Admin-Routen ohne Header abfragt, kann den Operator damit nicht mehr aussperren. Der 401-Text bleibt unverändert; `CHANGELOG` unter `Changed`/`Security`, Test UT-16/RT-04.
- **`/health` auf der Viewer-Fläche:** bleibt unauthentifiziert und wird wie auf dem Hub vor `authorize()` bedient (§2.1 Regel 6). Das ist kein neues Verhalten, sondern die Voraussetzung dafür, dass AC-5.23 (Host-Gate) überhaupt erreichbar ist.
- Der Cookie-Name `bp_viewer` und der Header `x-bluepencil-viewer` bleiben, damit Layer- und Bookmarklet-Verträge stabil sind.

### 5.4 Lifecycle

- `RunningServer.viewer` ist nur gesetzt, wenn `--viewer` konfiguriert ist.
- `startHub()` bindet zuerst den Hub-Listener, dann den Viewer-Listener. Schlägt der Viewer-Bind fehl, wird der Hub-Listener geschlossen, `activeJournal` auf `null` zurückgesetzt und der Fehler weitergereicht.
- Die Startvalidierung (§2.4 Regel 5) läuft, sobald beide Origins bestimmt sind — bei festen Ports **vor** `listen()`, bei `port 0` nach beiden Binds. Bei einem Origin-Konflikt wird kein Listener bedient; bei `port 0` werden beide geschlossen, `activeJournal` auf `null` gesetzt und `HubStartupError` geworfen. Die echten `request`-Handler werden erst danach installiert; `startHub()` resolved erst nach der Validierung. Ein späterer `startHub()` startet ohne stale Journal (AC-F16).
- `close()` schließt beide Listener mit `Promise.allSettled`; nach dem Warten auf beide wird der erste Fehler geworfen.
- `--quiet` unterdrückt die Fortschrittszeile, nicht `viewer_cookie_shared_host`, `viewer_non_loopback_insecure` oder `viewer_public_url_deprecated`.

## 6. Requirements-Vorschlag für `docs/REQUIREMENTS.md`

**IDs und Milestone werden hier nicht vergeben.** Die Aussagen sind normativ formuliert; `requirements` vergibt die IDs und den Milestone (E5). Die sachlich passende Platzierung ist **FR-6.17+** im bestehenden Block „FR-6 Storage & transport“ (endet heute bei FR-6.16) oder ein **neuer Top-Level-Block**; die frühere Bereichsangabe und das frühere Design-Milestone sind entfernt, weil sie nicht zur 0.14.0-Zielversion passen.

| Ref | Normative Aussage (Vorschlag) | Prio | Origin | Acceptance |
|---|---|---|---|---|
| **R1 Viewer-Origin** | `--viewer` startet einen zweiten HTTP-Listener auf einer eigenen Origin; Viewer-Inhaltsrouten sind auf dem Hub-Port nicht erreichbar (404), auch wenn `--root` konfiguriert ist. | P1 | N | AC-5.1, AC-5.2, AC-5.29 |
| **R2 Gemeinsamer Store** | Über die Viewer-Origin geschriebene Notizen sind ohne Neustart für Hub-`/notes`, `/bundle`, `/journal` und `/mcp` sichtbar; es gibt genau eine Store- und Journal-Instanz; Hub- und Viewer-`/bundle` sind status-, content-type- und body-identisch, Kopfzeilen dürfen sich nur um Hub-CORS unterscheiden. | P0 | N | AC-5.6, AC-5.7, AC-5.8, AC-5.33 |
| **R3 Routen-Minimalität** | Die Viewer-Origin serviert Shell, `/view`, Assets, Bookmarklet, `notes*`, `sessions`, `bundle`, `health`; sie serviert nicht `admin*`, `mcp`, `journal`, `config`, `viewer/start` oder `--root`. Assets sind session-frei und werden vor der Session-Prüfung bedient. | P0 | N | AC-5.9, AC-5.14, AC-5.15 |
| **R4 Fail-closed-Auth** | Notiz-Routen auf der Viewer-Origin verlangen eine Viewer-Session **oder** ein Client-Credential; ohne beides sind sie fail-closed `401`, auch ohne `--auth-secret`; der Hub-Port akzeptiert keine Viewer-Session; ein widerrufenes Geräte-Token ist auf beiden Flächen `401`. | P0 | N | AC-5.3, AC-5.10, AC-5.11, AC-5.13, AC-5.32 |
| **R5 Ticket-Austausch** | Das Admin-Secret wird nur auf der Hub-Origin geprüft (Throttle, konstantzeitiger Vergleich) und gegen ein kurzlebiges Einmal-Ticket getauscht; die Viewer-Origin sieht das Secret nie. | P0 | N | AC-5.4, AC-5.5, AC-5.12 |
| **R6 Cookie-Scope** | `bp_viewer` ist `HttpOnly`, `SameSite=Lax`, `Path=<base>`, `Secure` bei https; gleicher Hostname wie der Hub wird gewarnt. | P1 | N | AC-5.13 |
| **R7 SSRF** | Ziele werden per Metadata-Hostnamen, DNS und IP-Klassifikation geprüft; loopback/link-local/metadata/reserved sind immer blockiert, private nur bei exaktem Allowlist-Eintrag; Resolver-Fehler sind fail-closed; jeder Redirect-Hop wird erneut geprüft. | P0 | N | AC-5.17, AC-5.18, AC-5.19, AC-5.20, AC-5.30, AC-5.31 |
| **R8 Startvalidierung** | `--viewer` ohne `--viewer-port`, Port-Gleichheit auf derselben Bind-Adresse, ungültige Origin, Viewer-Origin == Hub-Origin, werttragende Flags ohne Wert, ungültige TTL, `--cors '*'`/Viewer-Origin mit `--viewer` und Viewer-Flags ohne `--viewer` sind Nutzungsfehler. | P1 | N | AC-F1…AC-F9, AC-F14…AC-F21 |
| **R9 Betrieb** | `RunningServer` meldet beide Listener und schließt beide; ein fehlgeschlagener zweiter Bind oder ein Post-`listen()`-Origin-Konflikt hinterlässt keinen laufenden Listener und kein stale Journal; `viewer.origin` ist vor dem ersten bedienten Request aufgelöst. | P1 | N | AC-5.1, AC-F10, AC-F11, AC-F12, AC-F16, AC-F22 |

## 7. Acceptance Criteria

Jedes Kriterium ist testbar und hat eine beobachtbare Antwort. `{hub}` ist `http://<hub-host>:<hub-port>`, `{viewer}` ist die Viewer-Origin. Alle Pfade relativ zu `base`.

### 7.1 AC-5-Matrix (Issue #140, AC 1–6)

| ID | Given | When | Then | Bezug |
|---|---|---|---|---|
| **AC-5.1** | `startHub({storePath, port: 0, host: "127.0.0.1", viewer: {host: "127.0.0.1", port: 0, …}})` | Start | `RunningServer.viewer` ist gesetzt; `viewer.server.listening === true`; `viewer.port !== port`; `viewer.host` ist die gebundene Adresse; der Hub-Listener lauscht weiter | R1, R9, D1, D11 |
| **AC-5.2** | Viewer konfiguriert, **kein** `--root`, frische Instanz | `GET {hub}{base}/viewer`, `GET {hub}{base}/view`, `GET {hub}{base}/viewer/assets/bluepencil.element.min.js`, `GET {hub}{base}/viewer/bookmarklet.txt` — je ohne Cookie/Header | Jeweils `404 not_found`, kein `Set-Cookie`, Body enthält weder `<bluepencil-notes` noch Ziel-HTML | R1, D4 |
| **AC-5.3** | Viewer konfiguriert, frische Instanz, öffentlich erreichbarer `viewer.hubOrigin` gesetzt | `GET {viewer}{base}/viewer` ohne Session; `GET {viewer}{base}/viewer/bookmarklet.txt` ohne Session; `GET {viewer}{base}/view?url=https://example.com` ohne Session; danach `GET {viewer}{base}/viewer` mit gültiger Session | ohne Session jeweils `401 unauthorized` mit derselben Message aus `viewerSessionRefusalMessage()`, die `{hubOrigin}{base}/viewer/start` enthält und **nicht** `{base}/viewer?k=`, kein `Set-Cookie`; mit Session `200` `text/html`, `cache-control: no-store`, `referrer-policy: no-referrer`, `x-frame-options: SAMEORIGIN` | R4, D4 |
| **AC-5.4** | Viewer + Admin-Secret `S` | `GET {hub}{base}/viewer/start` mit `x-bluepencil-admin: S`; danach mit `?k=S`; danach ohne beides; danach mit falschem Wert | Header und `?k=` jeweils `302` mit `location = {viewer.origin}{base}/viewer?ticket=<48 hex>`, `referrer-policy: no-referrer`, `cache-control: no-store`, kein `Set-Cookie`; ohne beides `401 unauthorized`; falsch `401 unauthorized`; Header gewinnt über `?k=` | R5, D2 |
| **AC-5.5** | Ticket aus AC-5.4 | `GET {viewer}{base}/viewer?ticket=<t>`; Wiederholung mit demselben Ticket; Ticket nach Ablauf der 60-s-TTL | erster Aufruf `302` auf `{base}/viewer` (ohne Query) + `Set-Cookie` + `referrer-policy: no-referrer`; Wiederholung `401` ohne Cookie; abgelaufen `401` ohne Cookie | R5, D2 |
| **AC-5.6** | Gültige Viewer-Session | `POST {viewer}{base}/notes` mit gültiger Notiz; danach `GET {hub}{base}/notes` mit Client-Credential und `GET {hub}{base}/bundle` | Write antwortet mit dem dokumentierten Erfolgsstatus; Hub-`/notes` und `/bundle` enthalten dieselbe Notiz-ID; kein Neustart | R2, D1 |
| **AC-5.7** | Notiz aus AC-5.6 | `POST {hub}{base}/mcp` mit `tools/call list_notes` | Die Antwort enthält die über die Viewer-Origin geschriebene Notiz-ID | R2, D1 |
| **AC-5.8** | Journal aktiv, aber **`--journal file` oder `--journal-coalesce 0`** (der `git`-Backend kann mit Default-Coalesce 2000 ms verzögern); der Write trägt explizit den Header `X-Bluepencil-Actor: viewer-test` | genau ein Write über die Viewer-Origin | `GET {hub}{base}/journal` enthält genau einen neuen Eintrag mit `noteId` und `actor === "viewer-test"`; ohne den Header ist die Assertion nicht erfüllt, weil `actor` dann fehlt; es existiert keine zweite Journal-Datei | R2, D1 |
| **AC-5.9** | Gültige Viewer-Session, `--root` konfiguriert | `GET {viewer}{base}/admin`, `/admin/status`, `/config`, `/journal`, `/viewer/start`; `POST {viewer}{base}/mcp`; `GET {viewer}/<root-datei>` | Jeweils `404 not_found`; Body enthält keine Notiz-, Audit-, Credential- oder Bind-Daten | R3, D4 |
| **AC-5.10** | Viewer + Admin-Secret, **kein** `--auth-secret`/`--token-key` | `POST {viewer}{base}/notes` ohne Session; danach mit Session; danach `GET {hub}{base}/notes` ohne Credential | ohne Session `401 unauthorized` mit `viewerSessionRefusalMessage()` und ohne Store-Schreibvorgang; mit Session Erfolg; Hub-`/notes` bleibt ohne Credential `200` (kein Regress) | R4, D3 |
| **AC-5.11** | Hub mit `--auth-secret` und konfiguriertem Viewer | `GET {hub}{base}/notes` mit gültigem `bp_viewer`-Cookie und mit gültigem `x-bluepencil-viewer`-Header; dieselben Werte an `{viewer}{base}/notes` | Hub: jeweils `401 unauthorized`; Viewer: jeweils `200` | R4, D3 |
| **AC-5.12** | Viewer + Admin-Secret `S`; (a) `viewer.hubOrigin` als öffentliche, erreichbare Hub-Origin gesetzt (direkter Loopback-Zugriff); (b) `viewer.hubOrigin` ungesetzt (nicht-loopback/Wildcard-Bind) oder nur als interne Bind-Origin vorhanden (Loopback-Reverse-Proxy) | `GET {viewer}{base}/viewer?k=S`; `GET {viewer}{base}/viewer?k=falsch`; `POST {viewer}{base}/notes` mit `x-bluepencil-admin: S`; `GET {viewer}{base}/viewer`, `/viewer/bookmarklet.txt` und `/view?url=https://example.com` je ohne Session | Jeweils `401 unauthorized`, kein `Set-Cookie`; die beiden `?k=`-Antworten sind byte-identisch; kein Admin-Throttle-Verbrauch (Unit-Beleg über `verifyOperatorSecret`); in Fall (a) enthält jede der vier Session-Ablehnungen `{hubOrigin}{base}/viewer/start`; in Fall (b) enthält sie „open the hub launcher“ und **keine** konstruierte `http://`-URL (insbesondere nicht die interne Bind-Origin `http://127.0.0.1:…`); in keinem Fall `{base}/viewer?k=` | R5, D2, D3 |
| **AC-5.13** | Explizite Origin `https://view.example.com`; alternativ abgeleitete Origin `http://…` | Ticket-Einlösung **über den echten Viewer-Listener** | `Set-Cookie` auf der Leitung exakt `bp_viewer=<token>; HttpOnly; SameSite=Lax; Path=<base>; Max-Age=<ttl>; Secure` und ohne `Domain`; bei abgeleiteter `http://`-Origin ohne `Secure`. Die `Secure`-Entscheidung stammt **end-to-end** aus `publicOrigin()` → `sessionCookie({secure})`, nicht nur aus einem direkten `sessionCookie`-Unit-Aufruf (UT-10 + IT-05); `Path` ist der normalisierte `base` (`/` bei leerem base) | R4, R6, D9 |
| **AC-5.14** | Viewer + gebaute Assets, **kein** Cookie/Header | `GET {viewer}{base}/viewer/assets/bluepencil.element.min.js`; `GET …/unbekannt.js` | ersteres `200`, `text/javascript`, `access-control-allow-origin: *`, `cross-origin-resource-policy: cross-origin`, `cache-control: no-cache`; unbekannt `404 not_found`; beides **ohne** Session, d. h. vor der Session-Prüfung | R3, D5 |
| **AC-5.15** | Viewer ohne/mit Session | `GET {viewer}{base}/viewer/bookmarklet.txt` ohne Session; mit Session | ohne Session `401 unauthorized`; mit Session `200 text/plain`, enthält `__BP_VIEWER_TOKEN__` und **keinen** 48-Hex-Live-Token | R3, D5 |
| **AC-5.16** | Gültige Session, allowlistetes Ziel `https://example.com` | `GET {viewer}{base}/view?url=https://example.com` | `200 text/html`; Body enthält `endpoint="{viewer.origin}{base}"` und `src="{viewer.origin}{base}/viewer/assets/bluepencil.element.min.js"`; Header `x-frame-options: SAMEORIGIN`, `referrer-policy: no-referrer`, `cache-control: no-store` | R1, D1, #140 AC 1 |

| **AC-5.17** | Allowlist `example.com`; URL `https://example.com/`; Stub-Resolver liefert `127.0.0.1`; Fetch-Stub zählt Aufrufe | `GET {viewer}{base}/view?url=https://example.com`; ebenso mit Resolver-Antwort `169.254.169.254` und `::ffff:169.254.169.254`; zusätzlich URL `http://169.254.169.254/` bei Allowlist `169.254.169.254` | Jeweils `403 target_address_forbidden`, Fetch-Aufrufe `0`; der Allowlist-Host bleibt erlaubt, die Ablehnung kommt aus der IP-Klassifikation | R7, D6 |
| **AC-5.18** | Allowlist `example.com` **und** `169.254.169.254`; Stub-Resolver liefert öffentliche Adresse; erster Fetch antwortet `302 Location: http://169.254.169.254/` | `GET {viewer}{base}/view?url=https://example.com` | `403 target_address_forbidden`; genau **ein** Fetch ist passiert; kein zweiter Hop | R7, D6 |
| **AC-5.19** | Allowlist enthält exakt `10.0.0.1`; alternativ exakt `internal.example.com` mit Stub-Resolver `10.0.0.5`; alternativ nur `*.example.com` mit Stub-Resolver `10.0.0.5`; zusätzlich exakt `127.0.0.1` bzw. `::1` | `GET /view?url=http://10.0.0.1/`; `GET /view?url=https://internal.example.com/`; `GET /view?url=https://foo.example.com/`; `GET /view?url=http://127.0.0.1/` | exakter Eintrag `10.0.0.1`: Ziel wird versucht (Fetch ≥ 1); exakter Hostname `internal.example.com` mit `10.0.0.5`: Ziel wird versucht (Fetch ≥ 1) — ein exakter Hostname autorisiert die private Auflösung; nur `*.example.com` mit `foo.example.com` und `10.0.0.5`: `403 target_address_forbidden`, Fetch 0 — ein Wildcard autorisiert nie eine private Adresse; `127.0.0.1`/`::1` bleiben auch mit exaktem Eintrag `403 target_address_forbidden` | R7, D6 |
| **AC-5.20** | `forbiddenOrigins: ["https://view.example.com"]`; Allowlist `view.example.com`; Stub-Resolver `93.184.216.34` (öffentlich, **nicht** loopback) | `GET {viewer}{base}/view?url=https://view.example.com/x` | `403 target_forbidden_origin`, kein Fetch | R7, D6 |
| **AC-5.21** | Bookmarklet auf `https://app.example`; gültige Viewer-Session/Header-Token | `OPTIONS {viewer}{base}/notes` mit `Origin: https://app.example` und `Access-Control-Request-Headers: x-bluepencil-viewer`; `OPTIONS /notes` ohne den Requested-Header; `OPTIONS /notes` ohne/ mit ungültigem `Origin`; `OPTIONS {viewer}{base}/notes/{id}` ohne Requested-Header; `OPTIONS {viewer}{base}/bundle`; `OPTIONS {viewer}{base}/sessions`; `GET /notes` mit `Origin` und gültigem Header-Token; `GET /notes?intent=falsch` mit gültigem Header-Token; `POST /notes` mit `Origin` und gültigem Header-Token; `POST /notes` mit `Origin` und **ungültigem** Token; `POST /notes` mit `Origin`, gültigem Token und ungültigem Body | gültiger Preflight `204`, `Allow-Origin` reflektiert, `Allow-Methods` **exakt** `GET, POST, PATCH, OPTIONS`, `Allow-Headers` enthält `Content-Type, X-Bluepencil-Viewer`, `Max-Age: 600`, `Vary: Origin`, **kein** `Allow-Credentials`; `OPTIONS /notes` ohne Requested-Header → `405 method_not_allowed` mit `Allow: GET, POST`, **kein** `Access-Control-Allow-Origin`, kein `Set-Cookie`; ohne/ungültigen `Origin` dasselbe; `OPTIONS /notes/{id}` ohne Header → `405` mit `Allow: GET, PATCH`; `OPTIONS /bundle` → `405` mit `Allow: GET`; `OPTIONS /sessions` → `405` mit `Allow: GET`; **kein** Viewer-`OPTIONS` antwortet `401`; `GET /notes` → `200` mit reflektierter `Allow-Origin`; `GET /notes?intent=falsch` → `400 invalid_query` mit derselben reflektierten `Allow-Origin`; `POST /notes` mit ungültigem Body → `400 invalid_payload` mit derselben reflektierten `Allow-Origin`; die POST-Erfolgsantwort **und** die `401`-Fehlerantwort tragen dieselbe reflektierte `Allow-Origin` | R7, D10 |
| **AC-5.22** | Explizite Viewer-Origin `https://view.example.com` | `parseHubArgs(["--store", …, "--viewer", …, "--cors", "https://view.example.com"])`; alternativ mit `--viewer-port 0` ohne explizite Origin | ersteres Nutzungsfehler `cors_viewer_origin`; letzteres beim Parsen akzeptiert (Prüfung erst nach `listen()`, siehe AC-F16) | R8, D10 |
| **AC-5.23** | Viewer-Bind loopback, `--viewer-origin https://view.example.com` | `GET {viewer}{base}/health` mit `Host: evil.example`; mit `Host: view.example.com:8788`; mit `Host: localhost:8788`; dazu `GET {hub}{base}/health` mit `Host: localhost:<hub-port>`; dazu `hostRefusal` als Unit-Test mit injiziertem `bind = { host: "192.0.2.10", port: … }` und fremdem `Host` | fremder Host `403 host_not_allowed`; `view.example.com` `200`; `localhost` `200`; Hub unverändert `200`; `/health` wird auf **beiden** Flächen vor `authorize()` bedient (kein Cookie/Token nötig), AC-5.23 ist damit erreichbar; der Nicht-Loopback-Fall ist **kein echter Bind**, sondern `hostRefusal(...)` mit injiziertem, nicht-loopback `bind` → `null` (kein Gate), UT-33 | R6, R9, D12 |
| **AC-5.24** | (a) Explizite Origin `https://view.example.com` und ein Request mit `X-Forwarded-Proto: http`; (b) abgeleitete Origin (kein `--viewer-origin`, Loopback-Bind `127.0.0.1`, kein Wildcard-Bind) und ein Loopback-Request mit `X-Forwarded-Proto: https`; (c) Unit: `publicOrigin(request, viewer)` mit **ungesetztem** `viewer.origin`, Loopback-Peer und `X-Forwarded-Proto: https`, danach mit Nicht-Loopback-Peer und `X-Forwarded-Proto: https` | (a)/(b) Ticket-Einlösung und Shell **über `startHub()`**; (c) reiner Unit-Aufruf ohne Listener | (a) `Set-Cookie` enthält `Secure`; Shell-`endpoint`, Element-`src` und Launcher-Links sind `https://view.example.com…`; `X-Forwarded-Proto: http` ändert das nicht. (b) `viewer.origin` ist `http://127.0.0.1:<port>`; `Set-Cookie` enthält **kein** `Secure`; Links sind `http://127.0.0.1:<port>…` — das Loopback-`X-Forwarded-Proto: https` hebt die abgeleitete Origin **nicht** an, weil `startHub()` sie vor dem ersten Request auflöst und `publicOrigin()` eine gesetzte Origin unverändert zurückgibt (§2.4 Regel 6). (c) bei ungesetztem `origin`: Loopback + `X-Forwarded-Proto: https` → `https://<Host>`; Nicht-Loopback + `X-Forwarded-Proto: https` → `http://<Host>`. Der XFP-Zweig ist **keine** `startHub()`-Eigenschaft und wird nicht über `startHub()` geprüft (A3, RR-11) | R6, A3, D12, RR-11 |
| **AC-5.25** | Gültige Session; Ziel liefert `Content-Security-Policy: default-src 'none'; script-src 'none'` **und** `<meta http-equiv="Content-Security-Policy" content="default-src 'none'">` | `GET {viewer}{base}/view?url=https://example.com` | `200 text/html`; die Antwort trägt **keine** `content-security-policy`-Kopfzeile; der Body enthält kein `<meta http-equiv="content-security-policy"`; `<bluepencil-notes` und `bluepencil.element.min.js` sind vorhanden | R1, D6, #140 AC 3 |
| **AC-5.26** | Gültige Session; Ziel `https://example.com/static.html` liefert vollständiges HTML mit `<head><title>…</title></head><body>…</body>` | `GET {viewer}{base}/view?url=https://example.com/static.html` | `200`; Injection steht **nach** `<head>`; `<base href="https://example.com/">`; `endpoint="{viewer.origin}{base}"`; `src` absolut | R1, #140 AC 1/AC 6 |
| **AC-5.27** | Gültige Session; Ziel liefert eine SPA-Shell `<div id="root"></div>` ohne `<head>`/`<body>` | `GET {viewer}{base}/view?url=https://example.com/spa` | `200`; Injection steht **vor** dem Original-Markup; Original-Markup bleibt erhalten; `endpoint` und `src` absolut | R1, #140 AC 6 |
| **AC-5.28** | Gültige Session; Fall A: `<head><title>x</title><body><p>y` (kein `</head>`); Fall B: `<html><body><p>y</p></body></html>` (kein `<head>`) | `GET {viewer}{base}/view?url=…` je Fall | Fall A: Injection nach `<head>`, Body erhalten; Fall B: Injection vorangestellt, kein Crash; beide `200`, `endpoint`/`src` absolut | R1, #140 AC 6 |
| **AC-5.29** | Viewer konfiguriert, `--root <dir>` mit `index.html` und `other.html` | `GET {hub}{base}/viewer`, `/view`, `/viewer/assets/bluepencil.element.min.js`, `/viewer/bookmarklet.txt`; zusätzlich unpräfigiert `GET {hub}/viewer`, `/view`, `/viewer/assets/bluepencil.element.min.js`, `/viewer/bookmarklet.txt`; danach `GET {hub}/other.html` | alle acht Viewer-Pfade jeweils `404 not_found` und **nicht** der Root-`index.html`; `other.html` bleibt `200` (statischer Fallback unverändert) | R1, R3, D4 |
| **AC-5.30** | Allowlist `metadata.google.internal`; Stub-Resolver liefert `93.184.216.34` und zählt Aufrufe | `GET {viewer}{base}/view?url=http://metadata.google.internal/` | `403 target_metadata_host`; Resolver-Aufrufe `0`; Fetch-Aufrufe `0` | R7, D6 |
| **AC-5.31** | Allowlist `example.com`; URL `https://example.com/`; Stub-Resolver wirft; danach liefert `[]`; danach `["not-an-ip"]` | `GET {viewer}{base}/view?url=https://example.com` je Fall | Jeweils `403 unresolvable_host`, Fetch-Aufrufe `0`; `checkTarget()` wirft in keinem Fall; die Antwort ist kein `500` | R7, D6 |
| **AC-5.32** | Hub + Viewer mit `--token-key`; ein gültiges Geräte-Token mit `jti` wird über `POST {hub}{base}/admin/devices/revoke` widerrufen; dasselbe Token wird vor und nach der Revocation verwendet | `GET {viewer}{base}/notes`, `GET {viewer}{base}/bundle`, `GET {viewer}{base}/sessions` mit `Authorization: Bearer <token>`; dazu dieselben Routen auf dem Hub | vor der Revocation jeweils `200`; nach der Revocation jeweils `401 token_revoked` auf **beiden** Flächen; der Viewer-Context nutzt dieselbe `revokedTokens`-Set-Referenz wie der Hub (keine Kopie), eine Revocation wirkt ohne Neustart; kein Fallback auf `x-bluepencil-auth` | R4, R7, D3 |
| **AC-5.33** | Hub + Viewer, injizierte Uhr `now: () => "2026-11-06T12:00:00.000Z"`, `appName: "bp-test"`, `exportedBy: "bp-test <bp@example.com>"`, identischer Store | `GET {hub}{base}/bundle` und `GET {viewer}{base}/bundle`, je mit gültigem Credential | beide Antworten sind **status-, content-type- und body-identisch**; Kopfzeilen dürfen sich ausschließlich um Hub-CORS unterscheiden (`access-control-allow-origin`, `access-control-allow-headers`, `access-control-max-age`, `vary`), und der Test entfernt diese Hub-CORS-Kopfzeilen vor dem Header-Vergleich; der Body trägt `app.name = "bp-test"`, `exportedBy = "bp-test <bp@example.com>"`, `exportedAt = "2026-11-06T12:00:00.000Z"`; der Viewer-Context trägt `appName`, `exportedBy`, `now`, `version` | R2, R3, D1 |

### 7.2 Feature- und CLI-ACs

| ID | Given | When | Then | Bezug |
|---|---|---|---|---|
| **AC-F1** | — | `parseHubArgs` mit `--viewer` ohne `--viewer-port` | exakt `--viewer requires --viewer-port <port> (viewer_port_required) — the viewer must not share the hub port` | R8, D7 |
| **AC-F2** | — | `--viewer-port -1`, `65536`, `abc` | jeweils `--viewer-port must be an integer between 0 and 65535 (got …)` | R8 |
| **AC-F3** | `--port 8787 --host 127.0.0.1` | `--viewer-port 8787` (gleicher Bind); `--port 0 --viewer-port 0`; `--port 8787 --viewer-port 8787 --viewer-host 192.0.2.10` | gleicher Bind: `--viewer-port must differ from --port on the same bind address (viewer_port_conflict)`; beide `0`: akzeptiert; unterschiedlicher Bind: akzeptiert | R8, D7 |
| **AC-F4** | — | `--viewer-origin` mit Pfad, Query, Fragment, `ftp:` oder relativem Wert | `--viewer-origin must be an absolute http(s) origin without path, query or fragment (viewer_origin_invalid)` | R8 |
| **AC-F5** | Hub auf `http://127.0.0.1:8787` | `--viewer-origin http://127.0.0.1:8787` | `--viewer-origin must differ from the hub origin (viewer_origin_is_hub_origin)` | R8 |
| **AC-F6** | `--viewer-host 0.0.0.0`, `::` oder `""`; alternativ **nur** `--host 0.0.0.0` (z. B. `docker/entrypoint.sh`, das `--host 0.0.0.0` fest setzt) ohne `--viewer-host` | ohne `--viewer-origin`/`--viewer-public-url` | jeweils `--viewer-origin is required when the viewer bind is a wildcard address (viewer_origin_required)`; kein Start, keine Ableitung `http://0.0.0.0:<port>` oder `http://[::]:<port>`; mit expliziter `--viewer-origin` startet derselbe Aufruf | R8 |
| **AC-F7** | ohne aktives `--viewer` (auch `--viewer=false`) | `--viewer-assets`, `--viewer-allow`, `--viewer-ttl`, `--viewer-host`, `--viewer-port`, `--viewer-origin` oder `--viewer-public-url` | `--viewer-* require --viewer (viewer_flags_without_viewer)` | R8 |
| **AC-F8** | — | `--viewer-public-url https://view.example.com`; danach zusätzlich `--viewer-origin https://view.example.com`; danach beide mit unterschiedlichen Werten; danach `--viewer-public-url https://view.example.com/pfad` | Alias wird akzeptiert und auf `origin` normalisiert; `startHub()` gibt `viewer_public_url_deprecated` auf stderr aus; beide gleich → akzeptiert; beide ungleich → `viewer_origin_conflict` (S1); Pfad/Query/Fragment → `viewer_origin_invalid` | R8, D8 |
| **AC-F9** | Nur Env-Variablen | `BLUEPENCIL_VIEWER=1`, `BLUEPENCIL_VIEWER_PORT`, `BLUEPENCIL_VIEWER_HOST`, `BLUEPENCIL_VIEWER_ORIGIN`, `BLUEPENCIL_VIEWER_PUBLIC_URL` | identisches Ergebnis wie die entsprechenden Flags; Flag gewinnt über Env | R8, D8 |
| **AC-F10** | Zwei laufende Listener aus AC-5.1 | `await close()`; danach erneuter Verbindungsversuch an beide Ports; danach neuer `startHub` auf denselben Ports | beide Ports verweigern; ein neuer Start gelingt; `close()` wirft nicht | R9, D11 |
| **AC-F11** | `--viewer-port 0`, keine explizite Origin, Loopback-Bind | Start | `RunningServer.viewer.port` ist der tatsächliche Port; `RunningServer.viewer.origin` ist `http://<host>:<actual port>`; `viewer.url` ist `origin + base` | R1, R9, D8 |
| **AC-F12** | Viewer-Bind schlägt fehl (Port belegt) | `startHub` | `startHub` wirft; der Hub-Listener ist geschlossen (Verbindung verweigert); kein `RunningServer` mit halbem Start; ein späterer Start auf dem freien Hub-Port gelingt | R9, D11 |
| **AC-F13** | Viewer-Origin-Hostname == Hub-Hostname (inkl. Wildcard-Hub-Bind); alternativ nicht-loopback Viewer-Bind mit `http:`-Origin; alternativ `--quiet` | Start | `viewer_cookie_shared_host` bzw. `viewer_non_loopback_insecure` wird auf stderr ausgegeben, auch mit `--quiet`; die Fortschrittszeile wird mit `--quiet` unterdrückt | R6, R9, D9, D12 |
| **AC-F14** | — | jedes werttragende Viewer-Flag (`--viewer-assets`, `--viewer-allow`, `--viewer-ttl`, `--viewer-host`, `--viewer-port`, `--viewer-origin`, `--viewer-public-url`) ohne Wert | `<flag> requires a value (got nothing)`; das Flag wird nicht als abwesend behandelt | R8, D7 |
| **AC-F15** | `--viewer` gesetzt | `--cors '*'`; danach programmatisch `startHub({viewer: …, cors: "*"})` | CLI: `--cors '*' must not be combined with --viewer (cors_wildcard_with_viewer)`; programmatisch: `HubStartupError` mit `code === "cors_wildcard_with_viewer"`, beide Listener geschlossen | R8, D10 |
| **AC-F16** | Zwei feste freie Ports `P` (Hub) und `Q` (Viewer); Journal als Datei in `<dir1>` | `startHub` mit `viewer.origin = "http://127.0.0.1:P"` (gleich der Hub-Origin); danach mit `cors = "http://127.0.0.1:Q"` (gleich der tatsächlichen Viewer-Origin); danach ein erfolgreicher `startHub` auf freien Ports mit `<dir2>` | jeweils `HubStartupError` (`viewer_origin_is_hub_origin` bzw. `cors_viewer_origin`); kein Listener bleibt offen (feste Ports: Ablehnung **vor** `listen()`, kein Bind; `port 0`: beide gebundenen Listener geschlossen); **Unit:** `activeJournalForTests()` ist direkt nach dem Fehlstart `null`; der anschließende Start gelingt und schreibt nur nach `<dir2>`; kein `RunningServer` aus dem Fehlstart. Die frühere flushed-nach-`<dir1>`-Assertion entfällt (§2.4 Regel 11, §4.9 Nr. 11) | R9, D10, D11 |
| **AC-F17** | — | `parseHubArgs` mit `--viewer=false`; danach `BLUEPENCIL_VIEWER=0`; danach `--viewer=true` | `false`/`0` → Viewer aus, keine Pflichtfelder; `true` → Viewer an, `viewer_port_required` ohne Port | R8, D7 |
| **AC-F18** | — | `--viewer-ttl 59`, `604801`, `abc`; danach `--viewer-ttl 60` und `604800` | erste drei: `--viewer-ttl must be an integer between 60 and 604800 (got …)`; die Grenzwerte werden akzeptiert | R8 |
| **AC-F19** | — | `--port 0 --viewer-port 0`; danach `--port 8787 --viewer-port 8787 --viewer-host 192.0.2.10` | beide akzeptiert; tatsächliche Origins differieren bzw. Bind-Adressen differieren; die Startvalidierung (§2.4 Regel 5) greift | R8, R9 |
| **AC-F20** | Programmatischer Aufruf | `startHub({viewer: {ttlSeconds: 59}})`; danach `604801` | `HubStartupError` mit `code === "viewer_ttl_invalid"`; kein Listener bleibt offen | R8, §2.4 Regel 1 |
| **AC-F21** | Hub-Bind `http://127.0.0.1:8787`; alternativ `--cors https://hub.example.com` | `--viewer-public-url http://127.0.0.1:8787` (Bind-Origin des Hubs); alternativ `--viewer-public-url https://hub.example.com` (in `--cors` genannte Hub-Origin) | jeweils `viewer_origin_is_hub_origin`; der Alias kann nicht stillschweigend auf die Hub-Origin zeigen. Der Vergleich ist scheme-sensitiv (`normalizeOrigin`, §2.4 Regel 5): ein `https`-Alias gegen die `http`-Bind-Origin ist **kein** Konflikt und wird hier nicht erwartet | R8, D8 |
| **AC-F22** | Feste freie Ports `P`/`Q`; alternativ `port: 0`, `viewer.port: 0`; alternativ `handleViewerStart` mit einem Viewer-Context ohne `origin` (Unit) | `startHub` starten und während des Startfensters wiederholt `GET {hub}{base}/viewer/start?k=S` senden; Unit: `handleViewerStart` direkt aufrufen | feste Ports: `viewer.origin` ist **vor** `listen()` gesetzt; jeder Launcher-Request liefert `302` mit absoluter `Location` (`{viewer.origin}{base}/viewer?ticket=…`) — nie einen relativen/leeren Wert. `port 0`: `startHub` resolved erst nach beiden Binds, gesetzter Origin und Post-`listen()`-Validierung; ein Request im Startfenster erhält `503 service_not_ready` (kein `Location`, kein `Set-Cookie`, `cache-control: no-store`, `retry-after: 1`) oder keine Verbindung — nie einen `302` ohne Origin. Unit: `handleViewerStart` ohne `origin` → `503 service_not_ready`, `tickets.size()` unverändert | R9, D11 |
| **AC-F23** | Programmatischer Aufruf `startHub({storePath, port: 0, host: "0.0.0.0", viewer: {port: 0, assetsDir, allow, ttlSeconds, sessions/tickets werden intern erzeugt}})` **ohne** `viewer.origin`; alternativ `host: "::"`; alternativ derselbe Aufruf mit `viewer.host: "0.0.0.0"` | Start | jeweils `HubStartupError` mit `code === "viewer_origin_required"` **vor** jedem Bind; kein Listener bleibt offen; kein neues Journal wird gesetzt (in einem frischen Testprozess ist `activeJournalForTests()` `null`); keine `viewer.origin` mit `0.0.0.0`/`[::]` wird je erzeugt; mit gesetztem `viewer.origin` startet derselbe Aufruf und meldet die explizite Origin | R8, R9, D7, D8 |

### 7.3 Trace-Matrix

Die vollständige `#140 AC 1–6 → Spec-AC → Test`-Abbildung steht in **§1.6**. Jede Spec-AC ist dort oder in §8 mindestens einem Test zugeordnet.

**Summe: 33 AC-5-Kriterien + 23 Feature-/CLI-Kriterien = 56 Acceptance Criteria.**

## 8. Testplan

Alle Tests laufen ohne neue Runtime-Dependency. Listener-Tests binden `port: 0` und `viewer.port: 0` und schließen in `afterEach`. Unit-Tests rufen die reinen Funktionen ohne Socket; Integrationstests nutzen `startHub({ port: 0, viewer: { port: 0, … } })`. Die bestehende `tests/unit/viewer.test.ts`-Fixture wird um `tickets: createViewerTickets()`, `origin`, `hubOrigin`, `surface: "viewer"` (die Fixture in `tests/unit/viewer.test.ts:36-53` setzt kein `surface`; `handleViewer()` liefert ohne `surface === "viewer"` `null`) und einen Stub-`resolver` ergänzt; `?k=`-Fälle auf der Viewer-Fläche wandern auf den Hub-Launcher. Proxy-Tests mit DNS-Klassifikation injizieren einen Stub-Resolver; `forbiddenOrigins`-Tests nutzen eine **nicht-loopback** Viewer-Origin. Token-Revocation-Tests injizieren `revokedTokens` in beide Contexts als **dieselbe Set-Referenz**; Bundle-Parität injiziert `now`, `appName` und `exportedBy`; der Nicht-Loopback-Host-Fall läuft als Unit-Test mit injiziertem `bind` (kein echter Nicht-Loopback-Bind); AC-5.8 sendet `X-Bluepencil-Actor: viewer-test`.

### 8.1 Unit-Tests

| ID | Prüft | AC |
|---|---|---|
| **UT-01** | `parseHubArgs`: `viewer_port_required` | AC-F1 |
| **UT-02** | `parseHubArgs`: Port-Range/Integer | AC-F2 |
| **UT-03** | `parseHubArgs`: `viewer_port_conflict` nur bei gleicher Bind-Adresse und beiden Ports ≠ 0; `0 == 0` und unterschiedliche Bind-Adressen akzeptiert | AC-F3, AC-F19 |
| **UT-04** | `parseHubArgs`: `viewer_origin_invalid` (Pfad, Query, Fragment, `ftp:`, relativ) | AC-F4 |
| **UT-05** | `parseHubArgs`: `viewer_origin_is_hub_origin` | AC-F5 |
| **UT-06** | `parseHubArgs`: `viewer_origin_required` bei Wildcard-Bind inkl. Leerstring; **geerbt** aus `--host 0.0.0.0` ohne `--viewer-host`; `--host 0.0.0.0` + expliziter `--viewer-origin` wird akzeptiert; keine `http://0.0.0.0:<port>`-Ableitung | AC-F6 |
| **UT-07** | `parseHubArgs`: `viewer_flags_without_viewer` für alle sieben Flags, auch nach `--viewer=false` | AC-F7, AC-F17 |
| **UT-08** | `parseHubArgs`: Alias-Normalisierung, Gleichheit, `viewer_origin_conflict`, Alias-Origin-Validierung, Alias == Bind-Origin/`--cors`-Origin | AC-F8, AC-F21 |
| **UT-09** | `parseHubArgs`: Env-Parität und Flag-vor-Env | AC-F9 |
| **UT-10** | `sessionCookie`: exakte Attribute, `Secure`-Matrix, `Path`-Normalisierung, kein `Domain` | AC-5.13 |
| **UT-11** | `createViewerTickets`: 48 Hex, TTL, single-use, Cap 1024 + Eviction, `size()`-Pruning | AC-5.5 |
| **UT-12** | `checkTarget`: Protokoll/Userinfo/Allowlist (synchroner Teil) | AC-5.17 |
| **UT-13** | `checkTarget`: DNS-Klassifikation mit Stub-Resolver, fail-closed bei einer unzulässigen Adresse | AC-5.17 |
| **UT-14** | `checkTarget`: private nur bei exaktem Eintrag; Wildcard deckt private nicht; loopback/metadata/reserved immer verboten; exakter `10.0.0.1` erlaubt; exakter Hostname `internal.example.com` + Resolver `10.0.0.5` erlaubt; `*.example.com` + `foo.example.com` + Resolver `10.0.0.5` → `target_address_forbidden` | AC-5.19 |
| **UT-15** | `checkTarget`: `forbiddenOrigins` normalisiert (Scheme+Host+Port); nicht-loopback-Origin | AC-5.20 |
| **UT-16** | `verifyOperatorSecret`: ok/invalid/missing/throttled, Budget vor/nach Vergleich; ein fehlendes `presented` verbraucht **kein** Budget (Änderung 2.1); ein falscher Wert verbraucht es | AC-5.4, AC-5.12 |
| **UT-17** | `viewerSurfaceRefusal`: vollständige Erlaubt-/Gesperrt-Matrix, Hub `null`, Idempotenz | AC-5.9 |
| **UT-18** | `surfaceOf` + `authorize`: Hub ignoriert Viewer-Session; Viewer fail-closed; `allowAdminSecret` nur Hub; ein in `context.revokedTokens` enthaltenes `jti` → `401 token_revoked` auf der Viewer-**und** der Hub-Fläche | AC-5.10, AC-5.11, AC-5.32 |
| **UT-19** | `viewerBookmarkletPreflight`/`viewerBookmarkletCors`: Reflexion, Header, `Allow-Methods` exakt `GET, POST, PATCH, OPTIONS`, kein `Allow-Credentials`, ungültiger Origin `null`, fehlender `x-bluepencil-viewer`-Requested-Header `null`; kein `allowMethods`-Parameter (Signatur/Arity) | AC-5.21 |
| **UT-20** | `viewerSurfaceRefusal`/`isViewerStartRequest`/`viewerStartPath` Zusammenspiel für `/viewer/start` | AC-5.9, AC-5.4 |
| **UT-21** | `publicOrigin` + `sessionCookie`: explizite Origin gewinnt und wird nie durch XFP verändert; XFP nur bei **ungesetztem** `origin` und nur Loopback-Peer; IPv6-Brackets | AC-5.24, AC-F11 |
| **UT-22** | Startup-Warnungsableitung: `viewer_cookie_shared_host` (inkl. Wildcard-Bind), `viewer_non_loopback_insecure`, `viewer_public_url_deprecated` | AC-F13 |
| **UT-23** | Bookmarklet-Artefakt: Platzhalter, kein 48-Hex-Token, Version | AC-5.15 |
| **UT-24** | `parseHubArgs`: werttragende Viewer-Flags ohne Wert | AC-F14 |
| **UT-25** | `normalizeSurfacePath`: `%2e%2e`, doppelte Slashes, trailing slash, `..`-Escape, `.`-Segmente, nicht parsebarer URL-Anteil | AC-5.9 |
| **UT-26** | `checkTarget`: `METADATA_HOSTNAMES` vor Allowlist/DNS; Resolver wirft/`[]`/Nicht-IP → `unresolvable_host`; Funktion wirft nie | AC-5.30, AC-5.31 |
| **UT-27** | `viewerBookmarkletPreflight`: Requested-Header-Gate; ohne Header kein Preflight | AC-5.21 |
| **UT-28** | `startupWarnings`: fünfteilige `code`-Union, Emission in `startHub()`, `--quiet` unterdrückt nicht | AC-F13 |
| **UT-29** | `resolveOptions`: programmatische TTL `59`/`604801` → `viewer_ttl_invalid`; `60`/`604800` akzeptiert | AC-F20 |
| **UT-30** | `responseCorsHeaders`: Hub unverändert; Viewer nur `{base}/notes*`, sonst `{}`; `viewerSurfaceRefusal`-Antworten ohne Origin; `{base}/bundle` auf dem Hub status-/content-type-/body-gleich; Request-Durchreichung durch `json`/`errorResponse`/`toErrorResponse`/`applyMutation`: `GET /notes` (200) und `GET /notes?intent=falsch` (400 `invalid_query`) sowie `POST /notes` (400 `invalid_payload`) tragen den reflektierten Origin | AC-5.21 |
| **UT-31** | `gateRequest`-Reihenfolge und Erreichbarkeit (NF-02/NF-03): `{viewer}{base}/health` → `200` ohne Credential (vor `authorize()`); `{viewer}{base}/config` → `404`; `{viewer}{base}/admin` → `404` auch mit `adminSecret`; `{viewer}{base}/notes` ohne Credential → `401`; `OPTIONS /notes*` → `204`/`405`, nie `401`; `OPTIONS /bundle` → `405` `Allow: GET`, nie `401`; Hub-`/health` unverändert `200`. **Dispatch:** `isViewerRequest()` ist `false` für `{base}/health`, `/notes*`, `/sessions`, `/bundle`; `handleViewer()` gibt für dieselben URLs `null` zurück (kein Verschlucken) | AC-5.21, AC-5.23 |
| **UT-32** | `handleViewerStart` ohne `viewer.origin` → `503 service_not_ready`, kein `Location`, kein `Set-Cookie`, `tickets.size()` unverändert (Defense in Depth, NF-04) | AC-F22 |
| **UT-33** | `hostRefusal` mit injiziertem `bind`: Loopback-Bind + fremder `Host` → `403 host_not_allowed`; Loopback-Bind + Alias → `null`; Nicht-Loopback-Bind (`192.0.2.10`) + fremder `Host` → `null` (kein Gate) — ohne echten Nicht-Loopback-Bind | AC-5.23 |
| **UT-34** | `isWildcardBind` (`""`, `0.0.0.0`, `::`, `[::]` → `true`; `127.0.0.1`, `localhost`, `192.0.2.10`, `::1` → `false`) und `resolveOptions`/`startHub`: programmatischer Wildcard-Bind ohne `viewer.origin` → `HubStartupError("viewer_origin_required")` vor jedem Bind; mit expliziter Origin akzeptiert; `port 0` ändert nichts an der Pflicht; kein neues Journal im frischen Prozess | AC-F23 |
| **UT-35** | `viewerSessionRefusalMessage`: mit öffentlich erreichbarem `hubOrigin` → `{hubOrigin}{base}/viewer/start`; ohne (ungesetzt oder nur interne Bind-Origin) → „open the hub launcher“ und **keine** `http://`-URL; nie `{base}/viewer?k=`; identische Message für Shell-, Bookmarklet-, `/view`- und fail-closed-Notiz-Ablehnung | AC-5.3, AC-5.12 |
| **UT-36** | `activeJournalForTests`: nach einem Fehlstart (`viewer_origin_is_hub_origin`/`cors_viewer_origin`) `null`; nach erfolgreichem Start nicht `null`; der Seam ist nicht aus `server/index.ts` exportiert | AC-F16 |

### 8.2 Integrationstests

| ID | Prüft | AC |
|---|---|---|
| **IT-01** | Zwei Listener, unterschiedliche tatsächliche Ports | AC-5.1 |
| **IT-02** | Hub-Port 404 für alle Viewer-Routen, ohne Auth und ohne `--root` | AC-5.2 |
| **IT-03** | Viewer-Shell 401 ohne Session, 200 mit Session + Header; Shell, Bookmarklet und `/view` ohne Session nennen dieselbe `viewerSessionRefusalMessage()` mit `{hubOrigin}{base}/viewer/start` und nie `{base}/viewer?k=` | AC-5.3 |
| **IT-04** | Launcher 302/Ticket, Header vs. `?k=`, fehlend/falsch | AC-5.4 |
| **IT-05** | Ticket-Einlösung, Cookie, Replay, Ablauf; **`publicOrigin() → Secure` end-to-end**: explizite `https://`-Origin → `Set-Cookie` enthält `Secure` auf der Leitung; abgeleitete `http://`-Origin → ohne `Secure`, auch wenn der Loopback-Peer `X-Forwarded-Proto: https` sendet | AC-5.5, AC-5.13 |
| **IT-06** | Write über Viewer, Lesen über Hub-`/notes` und `/bundle` | AC-5.6 |
| **IT-07** | MCP `list_notes` sieht die Notiz | AC-5.7 |
| **IT-08** | Genau ein Journal-Eintrag pro Write mit `--journal file` oder `--journal-coalesce 0`; der Write trägt `X-Bluepencil-Actor: viewer-test`, der Eintrag hat `actor === "viewer-test"` | AC-5.8 |
| **IT-09** | Viewer 404 für Admin/MCP/Journal/Config/Start/`--root` | AC-5.9 |
| **IT-10** | Fail-closed ohne `--auth-secret`, Hub bleibt offen | AC-5.10 |
| **IT-11** | Viewer-Session öffnet Hub-`/notes` nicht | AC-5.11 |
| **IT-12** | Admin-Secret auf der Viewer-Origin wirkungslos, kein Oracle, Launcher-Hinweis mit öffentlich erreichbarem `hubOrigin`; ohne öffentlich erreichbares `hubOrigin` (nicht-loopback/Wildcard-Bind oder Loopback-Reverse-Proxy mit interner Bind-Origin) nennt die Message „open the hub launcher“ ohne konstruierte URL; alle vier Session-Ablehnungen sind identisch | AC-5.12 |
| **IT-13** | Assets öffentlich **ohne** Session (vor der Session-Prüfung), unbekanntes Asset 404 | AC-5.14 |
| **IT-14** | Bookmarklet session-geschützt, Platzhalter | AC-5.15 |
| **IT-15** | Proxy-Injection mit Viewer-Origin-Endpoints | AC-5.16 |
| **IT-16** | SSRF: Stub-Resolver liefert loopback/metadata; Block vor jedem Fetch | AC-5.17 |
| **IT-17** | SSRF: Redirect-Hop wird geprüft, genau ein Fetch | AC-5.18 |
| **IT-18** | SSRF: exakter privater Eintrag `10.0.0.1`; exakter Host `internal.example.com` + `10.0.0.5` erlaubt; Wildcard `*.example.com` + `foo.example.com` + `10.0.0.5` verboten; loopback immer verboten | AC-5.19 |
| **IT-19** | CORS: gültiger Preflight mit `Allow-Methods` exakt `GET, POST, PATCH, OPTIONS`, tatsächliche Erfolgs- **und** Fehlerantwort, kein `Allow-Credentials`; `GET /notes` → `200` mit reflektierter `Allow-Origin`; `GET /notes?intent=falsch` → `400 invalid_query` mit derselben `Allow-Origin`; `POST /notes` mit ungültigem Body → `400 invalid_payload` mit derselben `Allow-Origin`; `OPTIONS /notes` ohne Requested-Header/ohne Origin → `405` mit `Allow` und ohne CORS; `OPTIONS /bundle` und `/sessions` → `405` `Allow: GET`; kein Viewer-`OPTIONS` → `401` | AC-5.21 |
| **IT-20** | `cors_viewer_origin` über den Startpfad | AC-5.22 |
| **IT-21** | Host-Gate auf der Viewer-Fläche (nur reale Loopback-Binds); der Nicht-Loopback-Fall ist UT-33 mit injiziertem `bind` | AC-5.23 |
| **IT-22** | Explizite `https://`-Origin (auch mit `X-Forwarded-Proto: http`) → `Secure`-Cookie und https-Links; abgeleitete Origin mit Loopback-`X-Forwarded-Proto: https` → kein `Secure`, http-Links; der XFP-Zweig ohne gesetzte Origin ist UT-21 und **kein** `startHub()`-Fall | AC-5.24 |
| **IT-23** | `close()` schließt beide, Neustart gelingt | AC-F10 |
| **IT-24** | Zweiter Bind-Fehler schließt den ersten Listener | AC-F12 |
| **IT-25** | `--viewer-port 0`: tatsächlicher Port und abgeleitete Origin | AC-F11 |
| **IT-26** | Warnungen auf stderr, auch mit `--quiet`; Fortschrittszeile unterdrückt | AC-F13 |
| **IT-27** | Env-Variablen starten denselben Viewer wie die Flags | AC-F9 |
| **IT-28** | `viewer_origin_conflict` über den CLI-Startpfad mit stderr-Warnung für den Alias | AC-F8 |
| **IT-29** | Proxy entfernt Ziel-CSP-Kopfzeile und `<meta>`-CSP | AC-5.25 |
| **IT-30** | Statische Seite: Injection nach `<head>`, absolute URLs | AC-5.26 |
| **IT-31** | SPA-Shell ohne `<head>`: Injection vorangestellt | AC-5.27 |
| **IT-32** | Fehlendes `</head>` und fehlendes `<head>`: kein Crash, Injection korrekt | AC-5.28 |
| **IT-33** | `--root`: Viewer-Pfade 404, andere statische Dateien 200 | AC-5.29 |
| **IT-34** | Metadata-Hostname vor DNS; Resolver wirft/leer/Nicht-IP → `unresolvable_host`; `forbiddenOrigins` → `target_forbidden_origin` | AC-5.30, AC-5.31, AC-5.20 |
| **IT-35** | `--cors '*'` mit `--viewer`: CLI-Fehler und programmatischer `HubStartupError` | AC-F15 |
| **IT-36** | Post-`listen()`-Konflikt: `viewer_origin_is_hub_origin` und `cors_viewer_origin`, beide Listener geschlossen; `activeJournalForTests()` ist `null` (UT-36 prüft den Modulzustand direkt); anschließender Start mit `<dir2>` gelingt und schreibt nur dorthin | AC-F16 |
| **IT-37** | `--viewer=false`: Viewer aus, keine Pflichtfelder; `--viewer=true` ohne Port: Fehler | AC-F17 |
| **IT-38** | TTL-Grenzen im CLI und programmatisch; `viewer_ttl_invalid` | AC-F18, AC-F20 |
| **IT-39** | `--port 0 --viewer-port 0` und gleicher Port auf unterschiedlichen Bind-Adressen | AC-F19 |
| **IT-40** | Alias `--viewer-public-url`, der die Hub-Origin bezeichnet, wird abgelehnt | AC-F21 |
| **IT-41** | Asset-Antwort ohne Cookie/Header ist `200`, während Shell ohne Session `401` ist (Reihenfolge) | AC-5.14 |
| **IT-42** | `forbiddenOrigins` mit nicht-loopback Viewer-Origin: `target_forbidden_origin`, kein Fetch | AC-5.20 |
| **IT-43** | Geräte-Token, über den Hub widerrufen: Viewer-`/notes`, `/bundle`, `/sessions` → `401 token_revoked`; vor der Revocation `200`; Hub verhält sich gleich; dieselbe `revokedTokens`-Referenz, keine Kopie | AC-5.32 |
| **IT-44** | Bundle-Parität: Hub- und Viewer-`/bundle` mit injiziertem `now`/`appName`/`exportedBy` status-, content-type- und body-identisch; Kopfzeilen unterscheiden sich nur um Hub-CORS (im Test vor dem Vergleich entfernt); `exportedAt`, `app.name`, `exportedBy` stimmen | AC-5.33 |
| **IT-45** | Startatomarität: `port 0`/`viewer.port 0`, Requests im Startfenster → nur `503 service_not_ready` oder keine Verbindung; nach `startHub` Launcher-`302` mit absoluter `{viewer.origin}`-`Location`; feste Ports: Origin vor `listen()` gesetzt | AC-F22 |
| **IT-46** | Docker-/Entrypoint-Muster: `parseHubArgs(["--host","0.0.0.0","--viewer","--viewer-port","8788",…])` ohne `--viewer-origin` → `viewer_origin_required`, kein `startHub`/kein Listener; mit `--viewer-origin https://view.example.com` startet derselbe Aufruf, `RunningServer.viewer.origin` ist die explizite Origin und nie `http://0.0.0.0:8788` | AC-F6, AC-F23 |

### 8.3 Regression (bestehendes Viewer-Verhalten, keine neuen Issue-ACs)

| ID | Prüft | Absichert |
|---|---|---|
| **RT-01** | `tests/unit/viewer.test.ts`: Allowlist, Injection, CSP-`<meta>`-Strip, `<base>`, absolute `endpoint`, Session-Cookie — mit neuen Fixtures (`tickets`, `origin`, `hubOrigin`, `surface: "viewer"`, Stub-`resolver`) | Bestehende Viewer-Eigenschaften aus 0.13.0; #140 AC 3/AC 6 |
| **RT-02** | Proxy: 5-MB-Grenze, 8-s-Timeout, 3 Redirects, Content-Type, `target_unreachable` | Bestehende Fehlerpfade |
| **RT-03** | Bestehende Hub-Routen (`/config`, `/health`, `/journal`, `/notes`, `/mcp`, `/admin`) unverändert auf der Hub-Fläche | Keine Regression durch `surface` |
| **RT-04** | Admin-Surface: 401/429/`Retry-After: 300` und Budgetteilung nach dem `verifyOperatorSecret`-Refactor; ein **fehlendes** `x-bluepencil-admin` verbraucht kein Budget, ein **falsches** schon (Änderung 2.1) | D2/§2.3 |
| **RT-05** | `--root`: eine Nicht-Viewer-Datei (`other.html`) und der `index.html`-Fallback bleiben auf der Hub-Fläche erreichbar | `hubViewerPathRefusal()` sperrt nur Viewer-Pfade |
| **RT-06** | Hub-`--cors` ohne Viewer: `corsHeaders`/`preflightResponse`/`journalResponse` byte-gleich zum Ist-Stand | Keine CORS-Regression durch `responseCorsHeaders()` |

**Summe: 33 AC-5 + 23 Feature-/CLI-ACs = 56 ACs; 36 Unit- + 46 Integrationstests + 6 Regressionstests = 88 Testfälle.**

## 9. Migration und Rollout

| Artefakt | Änderung |
|---|---|
| `docs/VIEWER.md` | Neufassung: eigene Origin, `--viewer-host/-port/-origin`, Launcher `{base}/viewer/start`, Routen-Matrix, Cookie-/TLS-Abschnitt, Migrationshinweis für Bookmarklets. **Semantikwechsel `--viewer-public-url`** (früher Hub-Origin, jetzt Alias für die Viewer-Listener-Origin) und `--cors '*'`-Verbot mit `--viewer` ausdrücklich nennen. Der Satz „The proxied page is trusted with the store“ wird durch die Origin-Grenze und die verbleibenden Restrisiken ersetzt. |
| `docs/DOCKER.md` | Viewer-Abschnitt: zweiter Port, `command:`-Beispiel, Reverse-Proxy-/TLS-Muster, `BLUEPENCIL_VIEWER_*`. |
| `README.md` | Viewer-Blurb: „eigene Origin“ statt „hub's own origin“; AC-5-Hinweis. |
| `CHANGELOG.md` | Nächster Minor: `Changed` (`--viewer` braucht `--viewer-port`; `/viewer?k=` → `/viewer/start?k=`; `--viewer-public-url` bezeichnet jetzt die Viewer-Listener-Origin; `--cors '*'` mit `--viewer` verboten; ein **fehlendes** `x-bluepencil-admin` verbraucht kein `admin`-Budget mehr), `Added` (zweiter Listener, Ticket, SSRF, Viewer-`revokedTokens`), `Security`. |
| `Dockerfile` | `EXPOSE 8787` bleibt; der Viewer-Port ist dynamisch und wird nicht als Default exponiert. Kommentar/Doku nennt das Zwei-Port-Muster. |
| `docker-compose.yml` | Optionaler, auskommentierter zweiter Port-Mapping-Eintrag `127.0.0.1:${BLUEPENCIL_VIEWER_PORT:-8788}:8788` und ein `command:`-Beispiel, das wegen `--host 0.0.0.0` zwingend `--viewer-origin` (oder `--viewer-host 127.0.0.1`) enthält; kein Viewer-Default. |
| `docker/entrypoint.sh` | Keine Logikänderung nötig: `BLUEPENCIL_VIEWER_*` wird von Docker geerbt; Viewer-Flags kommen über `"$@"` oder Env. **Wichtig:** Das Skript setzt fest `--host 0.0.0.0` (`docker/entrypoint.sh:119-120`); ein Container-Viewer erbt damit einen Wildcard-Bind und **muss** `--viewer-origin` (oder ein loopback `--viewer-host`) mitbringen, sonst startet er mit `viewer_origin_required`. `docs/DOCKER.md` nennt das im Zwei-Port-Beispiel. Optional eine Banner-Zeile, wenn `BLUEPENCIL_VIEWER_PORT` gesetzt ist. |
| `docs/REQUIREMENTS.md` | Neuer Block nach §6; `spec/` wird durch `npm run spec` regeneriert (nicht handeditieren). |
| Extension | Keine Änderung. Die CSP-`connect-src`-Ausnahme der Extension betrifft den Hub, nicht den Viewer. |
| Federator/MCP | Keine Änderung; die Viewer-Fläche serviert `/mcp` nicht. |

**Release-Note (Vorschlag, Englisch, für `CHANGELOG`):**

> **Changed (breaking):** `--viewer` now requires an explicit `--viewer-port` and serves on its own listener. When the resolved viewer bind is a wildcard address (`""`, `0.0.0.0`, `::`) — including an inherited `--host`, as in the Docker entrypoint — `--viewer-origin` is required (`viewer_origin_required`), and no origin is ever derived from an unspecified address. The viewer content (`/viewer`, `/view`, `/viewer/assets/*`, `/viewer/bookmarklet.txt`) is no longer available on the hub port, even with `--root`. The operator entry point moved from `{base}/viewer?k=` to the hub launcher `{base}/viewer/start?k=`. `--viewer-public-url` is now a deprecated alias for the viewer listener origin and is rejected when it names the hub origin. `--cors '*'` is rejected together with `--viewer`. Existing bookmarklets that point at the hub origin must be re-issued from the viewer shell.
> **Added:** one-time viewer tickets, surface-scoped authorization, `--viewer-origin`, post-`listen()` origin validation, and SSRF checks over metadata hostnames, DNS resolution, address classification and every redirect hop.
> **Security:** a revoked device token is now refused on the viewer surface as well (`token_revoked`); the viewer context shares the hub's live revocation set. A missing `x-bluepencil-admin` header no longer spends the `admin` brute-force budget.

## 10. Offene Fragen + Risiken

### 10.1 Die fünf offenen Fragen des Designs — als empfohlene Entscheidungen

Status aller fünf: **im Freigabe-Gate am 2026-11-07 bestätigt** (E1–E5 wie empfohlen).

| Ref | Design-Frage | Empfohlene Entscheidung | Begründung | Konsequenz |
|---|---|---|---|---|
| **E1** | Private-IP-Policy für `--viewer-allow` | Private Ziele nur bei **exaktem** Allowlist-Eintrag (kein `*.`, kein CIDR), ohne neues Flag; `loopback`/`link-local`/`metadata`/`reserved` bleiben immer blockiert; Metadata-Hostnamen vor DNS; Resolver-Fehler fail-closed | Kein zusätzliches Betriebs-Flag; die Absicht steht in der Allowlist; die gefährlichen Klassen bleiben unerreichbar | Interne Ziele brauchen einen exakten Eintrag; Wildcards decken keine privaten Adressen ab |
| **E2** | Breaking CLI | `--viewer` ohne `--viewer-port` ist ein harter Nutzungsfehler (`viewer_port_required`), kein Kompatibilitätsmodus; `0` bleibt erlaubt; Port-Gleichheit nur bei gleicher Bind-Adresse und beiden Ports ≠ 0 | Ein Kompatibilitätsmodus würde AC 5 für Bestandsdeployments aushebeln | 0.13.0-Deployments brechen sichtbar; Ein-Zeilen-Umzug in der Doku |
| **E3** | Secret-Transport am Launcher | `?k=` bleibt (Kompatibilität), `x-bluepencil-admin` wird die dokumentierte Empfehlung; **kein** POST-Formular im Scope | Das Secret bleibt auf der Hub-Origin; ein Formular wäre eine weitere Fläche ohne Sicherheitsgewinn | `?k=` bleibt in History/Logs möglich; `no-referrer`/`no-store` mitigieren |
| **E4** | Host-Isolation | Gleicher Hostname mit anderem Port ist erlaubt, erzeugt aber `viewer_cookie_shared_host`; anderer Hostname wird für Produktion empfohlen; **kein** harter Fehler. Vergleich gegen die Hub-Bind-Origin; Wildcard-Bind warnt für jeden Nicht-Loopback-Viewer-Namen | AC 5 verlangt eine andere Origin, nicht zwingend einen anderen Host; ein harter Fehler bräche Lab-Setups | Echte Cookie-Isolation nur mit anderem Hostnamen; Reverse-Proxy-Hub-Origin bleibt Restrisiko (§4.9) |
| **E5** | Requirement-ID und Kategorie | Die Aussagen aus §6 gehören zu Hub-Betrieb/Auth; **IDs und Milestone vergibt `requirements`**. Konkrete Platzierung: FR-6.17+ im Block „FR-6 Storage & transport“ (endet bei FR-6.16) oder neuer Top-Level-Block. Kein Design-Milestone, keine erfundene Bereichsnummer | Die Spec darf keine IDs/Milestones erfinden; die Kategorie „Hub-Betrieb, Auth & Extension-Relay“ existiert nur in `AGENTS.md`, nicht in `REQUIREMENTS.md` | `spec/` wird nach der ID-Vergabe regeneriert |

### 10.2 Zusätzliche Spec-Entscheidungen (S1–S3, am 2026-11-07 bestätigt)

| Ref | Frage | Entscheidung der Spec | Begründung |
|---|---|---|---|
| **S1** | `--viewer-origin` und `--viewer-public-url` gleichzeitig | Normalisiert gleich → akzeptiert; ungleich → Nutzungsfehler `viewer_origin_conflict`; beide werden mit denselben Origin-Regeln validiert | Zwei widersprüchliche Wahrheiten sind schlimmer als ein klarer Fehler; der Alias bleibt für ein Release nutzbar |
| **S2** | Programmatische Kompatibilität von `ViewerOptions.publicBaseUrl` | Bleibt als deprecated Eingabe-Alias; `resolveOptions` normalisiert auf `origin`, `origin` gewinnt und validiert den Wert. **Spec-Ergänzung zum Design**, nicht Design-Contract | Ein `ServerOptions`-Aufrufer bricht nicht sofort; Entfernung im Folge-Minor |
| **S3** | Altlink `{hub}{base}/viewer?k=<secret>` | `404 not_found`; der Nachfolger ist `{base}/viewer/start?k=`. Kein Redirect, der das Secret erneut in eine `Location` schreibt | Kein Viewer-Inhalt auf dem Hub-Port; kein zusätzlicher Secret-Transport |

### 10.3 Risiken

| ID | Risiko | Wirkung | Gegenmaßnahme / Restrisiko |
|---|---|---|---|
| **RK-1** | Surface-Verzweigung in `authorize()`/`respond()` falsch eingehängt | Notizen auf der falschen Fläche offen oder Viewer unbenutzbar | AC-5.9–5.12, UT-17/18, IT-09–11; eine Implementierung (`surfaceOf`, `viewerSurfaceRefusal`) statt Kopien |
| **RK-2** | `respond()`-Reihenfolge: Journal/Static/MCP umgehen die Sperren | `/journal`, `--root`, `/mcp` auf der Viewer-Origin erreichbar; `--root` liefert Hub-`index.html` für `/viewer` | Vertrag §2.1 Regel 5/9; IT-09, IT-33; Code-Review-Fokus |
| **RK-3** | `sessionCookie`-Signaturwechsel wird an einer Stelle vergessen | falsches/unsicheres Cookie | UT-10 + RT-01; eine Funktion, alle Aufrufer |
| **RK-4** | DNS-TOCTOU / Rebinding | SSRF trotz Pre-Check | Dokumentiert; Connection-Pinning als Follow-up; private nur per exaktem Eintrag |
| **RK-5** | Gleicher Hostname → Cookie-Leak an den Hub-Port | `bp_viewer` wird gesendet, aber vom Hub ignoriert | Warnung + Doku; echte Isolation nur mit anderem Hostnamen |
| **RK-6** | Last-writer-wins ohne Lock | externe Änderung zwischen `loadNotes` und `persist` geht verloren | Innerhalb des Prozesses synchron; File-Lock als Follow-up dokumentiert |
| **RK-7** | Bestandsdeployments brechen ohne `--viewer-port` | Startfehler nach Upgrade | CHANGELOG/`docs/VIEWER.md` mit Ein-Zeilen-Umzug; bewusster Breaking-Slot |
| **RK-8** | Alte Bookmarklets schreiben nicht mehr | stiller Funktionsverlust beim Operator | Doku-Hinweis „neu ausstellen“; Shell liefert das neue Artefakt |
| **RK-9** | `--viewer-public-url` wird als Viewer-Origin missverstanden | Launcher leitet auf die Hub-Origin (404) oder auf eine falsche Origin | Alias-Validierung, Ablehnung bei Hub-Origin, `viewer_public_url_deprecated`, Doku-Migration |
| **RK-10** | `--cors '*'` mit Viewer | Viewer-Code liest Hub-Journal/`/config`/`/health` | Verbot beim Parsen und nach `listen()`; AC-F15/IT-35 |
| **RK-11** | `--viewer-port 0`/`--port 0` umgeht die Parse-Prüfung | Viewer-Origin == Hub-Origin oder `--cors` nennt die Viewer-Origin | Post-`listen()`-Validierung §2.4 Regel 5; AC-F16/IT-36 |
| **RK-12** | `--root` liefert `index.html` für Viewer-Pfade | Hub-Port zeigt Betreiber-Index statt 404 | `hubViewerPathRefusal()` vor dem Static-Fallback; AC-5.29/IT-33 |
| **RK-13** | Viewer-Context erhält `revokedTokens` nicht (oder eine Kopie) | widerrufene Geräte-Tokens öffnen Viewer-`/notes`/`/bundle`/`/sessions` weiter | Explizite Allowlist §2.4 Regel 2 mit **derselben Set-Referenz**; AC-5.32/UT-18/IT-43 |
| **RK-14** | Server bedient vor der Origin-Auflösung | Launcher-Redirect auf `undefined`/relative Origin oder Request auf falscher Fläche | Feste Ports synchron vor `listen()`, `port 0` Handler erst nach beiden Binds und Validierung, `503 service_not_ready` im Startfenster; AC-F22/UT-32/IT-45 |
| **RK-15** | Post-`listen()`-Fehler lässt `activeJournal` stehen | eine spätere Flush-/Signal-Route greift auf das Journal des Fehlstarts zu | `activeJournal = null` in jedem Fehlerzweig; direkter Modulbeleg über `activeJournalForTests()`; AC-F16/UT-36/IT-36 |
| **RK-16** | `OPTIONS`/`/health` rutscht hinter `authorize()` | Preflight oder Health-Probe wird `401`, AC-5.23/AC-5.21 unerreichbar | Verbindliche `gateRequest`-Reihenfolge §2.1 Regel 6/11; UT-31/IT-19 |
| **RK-17** | Wildcard-Bind wird nur am expliziten `--viewer-host` geprüft, nicht am geerbten `--host` | Docker/Entrypoint (`--host 0.0.0.0`) startet mit `http://0.0.0.0:<port>` als Origin | `viewer_origin_required` auf dem **aufgelösten** Viewer-Bind (§2.4 Regel 1/5); AC-F6/AC-F23/UT-06/UT-34/IT-46 |
| **RK-18** | CORS-Reflexion erreicht die Fehlerpfade von `toErrorResponse`/`applyMutation` nicht | `400`/`401`/`404` auf `{base}/notes*` ohne `Allow-Origin`; Bookmarklet kann den Fehler nicht lesen | Request-Durchreichung §2.5 Regel 3; AC-5.21/UT-30/IT-19 |
| **RK-19** | Viewer-Door wird auf der Viewer-Fläche für alle Pfade aufgerufen | `/health`, `/notes*`, `/sessions`, `/bundle` werden von `handleViewer()` mit `404` verschluckt | Dispatch-Prädikat `surface === "viewer" && isViewerRequest()` §2.1 Regel 5/7, `null`-Rückfall in §2.2 Regel 5; UT-31 |
| **RK-20** | `hubOrigin` wird als öffentliche Hub-Origin missverstanden | 401-Hinweis zeigt hinter einem Proxy auf eine interne Bind-Adresse | `hubOrigin` ist die Bind-Origin (gesetzt nur bei Loopback-Bind); hinter einem Loopback-Reverse-Proxy ist sie intern → URL-lose Meldung; eine öffentliche URL bräuchte einen expliziten Hub-Origin-Input; AC-5.12/UT-35/IT-12, §4.9 Nr. 9 |
| **RK-21** | Feste Ports leiten die Origin aus der konfigurierten, nicht der gebundenen Adresse ab | `--viewer-host localhost` bindet `::1`, `viewer.origin` bleibt `http://localhost:<port>` | Dokumentierte Grenze §4.9 Nr. 10; für Proxy/TLS `--viewer-origin` Pflicht |

## 11. Self-Review

### 11.1 Vollständigkeitscheck

- [x] Jede Pflichtsektion des Templates vorhanden: Problem/Ziel/Nicht-Ziele, Interface Contracts, Datenfluss, Acceptance Criteria, Offene Fragen + Risiken, Trace-Anker.
- [x] Issue #140 AC 1–6 sind in §1.6 vollständig auf Spec-ACs und Tests abgebildet; AC 3 (Header-CSP) und AC 6 (statisch/SPA/kein `</head>`) haben eigene ACs und Tests.
- [x] Jede geforderte Vertragsfläche benannt: `HandlerContext.surface`, `normalizeSurfacePath`, `hubViewerPathRefusal`, `ServerOptions.viewer`, `RunningServer`/`RunningViewer`, `ViewerOptions`, CLI-Flags/Env, `ViewerTickets`, Cookie-Attribute, Route-/Statusmatrix, Fehlerformen, `TargetRefusal`.
- [x] Keine offenen Platzhalter in Verträgen; offene Punkte stehen ausschließlich als bestätigungspflichtige Entscheidungen in §10.
- [x] Jede AC ist nummeriert, hat Given/When/Then und eine beobachtbare Antwort.
- [x] Jede AC ist mindestens einem Test in §8 zugeordnet; jede Design-Entscheidung D1–D12 ist in mindestens einer AC referenziert.
- [x] Keine erfundenen Requirement-IDs und kein Milestone; §6 schreibt nur normative Aussagen und überlässt IDs/Milestone `requirements`.
- [x] Sprache konsistent: Deutsch für Prosa, Englisch für Identifier/Flags/Codes/Commands.
- [x] Genau eine Store-Instanz, ein Journal, eine Session-/Ticket-Map explizit festgeschrieben (§3.4).
- [x] Explizite und abgeleitete Origin sind getrennt: `--viewer-origin https://…` → https-Links + `Secure`; abgeleitete `http://<bind>:<port>` → http-Links ohne `Secure`, auch bei Loopback-`X-Forwarded-Proto: https`; der XFP-Zweig von `publicOrigin()` gilt nur bei ungesetztem `origin` und ist keine `startHub()`-Eigenschaft (§1.4 A3, §2.4 Regel 6, AC-5.24/UT-21/IT-05/IT-22).
- [x] Fail-closed, Cookie-Scope, Admin-Secret-Isolation, Throttle, CORS, Host-Gate, XFP-Vertrauen, `--root`-Sperre, `--cors '*'`-Verbot und SSRF sind je mit AC und Test hinterlegt.
- [x] Viewer-Context enthält `adminSecret`/`tokenIssuer`/`revokeToken`/`devicesPath`/`revocationPath`/`root` strukturell nicht (§2.4 Regel 2).
- [x] Viewer-Context enthält `revokedTokens` (dieselbe Set-Referenz), `requiredScope`, `version`, `appName`, `exportedBy`, `now`; ein widerrufenes Token ist auf der Viewer-Fläche `401 token_revoked` (AC-5.32).
- [x] `gateRequest()`-Reihenfolge ist vollständig und deckt `/health` auf beiden Flächen vor `authorize()` ab (§2.1 Regel 6, AC-5.23).
- [x] Kein `OPTIONS` auf der Viewer-Fläche erreicht `authorize()`; negative Preflights sind `405` mit `Allow`, nie `401` (§2.1 Regel 11, AC-5.21).
- [x] `viewer.origin` ist vor dem ersten bedienten Request aufgelöst; das Startfenster antwortet `503 service_not_ready` (§2.4 Regel 4/5, AC-F22).
- [x] Hub- und Viewer-`/bundle` sind für denselben Store status-, content-type- und body-identisch; Kopfzeilen unterscheiden sich nur um Hub-CORS (AC-5.33).
- [x] Die Throttle-Änderung (fehlendes Operator-Secret ohne Budgetverbrauch) ist entschieden, dokumentiert und getestet (§2.3 Regel 2, §5.3, UT-16/RT-04).
- [x] DNS-Allowlist-Semantik ist explizit: exakter Hostname darf privat auflösen, Wildcard nie (AC-5.19).
- [x] Assets werden vor der Session-Prüfung bedient (§2.2 Regel 5, AC-5.14/IT-41).
- [x] Wildcard-Bind ist **einmal** definiert (`isWildcardBind`) und wird auf den **aufgelösten** Viewer-Bind angewendet — inklusive eines aus `--host` geerbten `0.0.0.0`/`::`/`""`; `viewer_origin_required` und keine Ableitung aus einer unspecified Adresse (§2.4 Regel 1/4/5/6, AC-F6/AC-F23).
- [x] Jede `{base}/notes*`-Antwort — Erfolg und Validierungsfehler — erhält ihren reflektierten Origin über den durchgereichten Request (§2.5 Regel 3, AC-5.21).
- [x] Die Viewer-Door läuft nur bei `surface === "viewer"` **und** `isViewerRequest()`; `/health`, `/notes*`, `/sessions`, `/bundle` werden nicht verschluckt (§2.1 Regel 5/7, §2.2 Regel 5, UT-31).
- [x] Alle Viewer-Session-Ablehnungen nutzen `viewerSessionRefusalMessage()`; der 401-Hinweis zeigt auf `{base}/viewer/start`, nie auf `{base}/viewer?k=` (§2.2 Regel 7, AC-5.3/AC-5.12).
- [x] `service_not_ready` ist als lokale `GlueResponse` außerhalb von `ERROR_CODES`/`glueError()` spezifiziert (§2.9).
- [x] Der `activeJournal`-Reset ist normativ und über den `@internal`-Testseam direkt prüfbar; die nicht entscheidungsfähige Black-Box-Assertion ist ersetzt (§2.4 Regel 11, §4.9 Nr. 11, AC-F16/UT-36).
- [x] Freigabe ist gesetzt: `Status: APPROVED (2026-11-07)` und `Approval: APPROVED (2026-11-07, user) — E1–E5/S1–S3 as recommended`.
- [x] Origin-Gleichheit ist scheme-sensitiv dokumentiert (`normalizeOrigin`): AC-F21 prüft den Alias gegen die **Bind-Origin** `http://127.0.0.1:8787` und die in `--cors` genannte Hub-Origin `https://hub.example.com`; ein `https`-Alias gegen die `http`-Bind-Origin ist kein Konflikt (§2.4 Regel 5, §5.2, AC-F21).

### 11.2 Vom Reviewer zu prüfende Punkte (nicht versteckt)

1. **Issue-ACs 1–6 sind korrigiert.** Die frühere Annahme, nur ein AC sei bekannt, ist ersetzt; §1.6 ist die Trace-Matrix. Der Reviewer prüft, ob die sechs Texte die öffentliche Issue-Fassung vollständig wiedergeben.
2. **`--root` ist entschieden, nicht offen.** `hubViewerPathRefusal()` sperrt die vier Viewer-Inhaltsrouten auf der Hub-Fläche vor dem Static-Fallback; andere statische Pfade bleiben erreichbar. Der Reviewer prüft die neue Symmetrie `hubViewerPathRefusal`/`viewerSurfaceRefusal`.
3. **Zielversion 0.14.0 stammt aus dem Auftrag, nicht aus dem Design.** Kein AC hängt an 0.14.0; das frühere Design-Milestone und die frühere Bereichsangabe sind entfernt.
4. **`respond()`-Reihenfolge vs. Design:** Die Spec konkretisiert die Reihenfolge in §2.1 Regel 5 und ergänzt `hubViewerPathRefusal()`; das ist eine Konkretisierung, keine stille Designänderung.
5. **`earlyRefusal()`-Dispatch-Gate:** Der Viewer-Early-Return ist jetzt an `surfaceOf(context) === "viewer"` **und** `isViewerRequest(url, context)` gebunden (§2.1 Regel 5/7); der Reviewer prüft, dass auf der Hub-Fläche kein Body/Store gelesen und auf der Viewer-Fläche `/health`, `/notes*`, `/sessions`, `/bundle` nicht verschluckt werden.
6. **Tatsächliche CORS-Antwort:** `responseCorsHeaders()` ist der eine Helfer für Erfolg und jeden Fehler auf `{base}/notes*`; der Request wird durch `json`/`errorResponse`/`toErrorResponse`/`applyMutation`/`listNotes`/`readNote` durchgereicht, sodass auch `400 invalid_query`/`invalid_payload` den reflektierten Origin tragen. Der Reviewer prüft, dass keine andere Viewer-Route einen reflektierten Origin erhält.
7. **`--cors '*'` und Startvalidierung:** Beide Fälle sind entschieden (Verbot bzw. erneute Prüfung, sobald die Origins bestimmt sind). Der Reviewer prüft, ob die Fehlercodes (`cors_wildcard_with_viewer`, `viewer_origin_is_hub_origin`, `cors_viewer_origin`) und die Testbarkeit ausreichen.
8. **`--viewer-public-url`-Semantik:** Der Alias ist validiert, wird bei Hub-Origin abgelehnt und ist in `CHANGELOG`/`docs/VIEWER.md` als Semantikwechsel dokumentiert. Eine öffentliche Hub-Origin, die nur im Reverse Proxy existiert, bleibt als Restrisiko (§4.9) benannt.
9. **`--viewer-port 0` und Port-Gleichheit:** `0 == 0` und gleicher Port auf unterschiedlichen Bind-Adressen sind erlaubt; die Origin-Gleichheit wird geprüft, sobald beide Origins bestimmt sind (feste Ports: vor `listen()`; `port 0`: nach beiden Binds). Der Reviewer prüft die Grenze zwischen Parse- und Laufzeitprüfung.
10. **TTL:** Die Obergrenze gilt jetzt auch programmatisch (`resolveOptions`), nicht nur im CLI.
11. **Wildcard-Bind:** `isWildcardBind()` ist die einzige Definition; der geerbte `--host 0.0.0.0`-Fall (Docker-Entrypoint) ist in AC-F6/UT-06/IT-46 und der programmatische Fall in AC-F23/UT-34 abgedeckt. Der Reviewer prüft, dass nirgends eine `http://0.0.0.0:<port>`-Origin entsteht.
12. **CORS-Durchreichung:** Der Reviewer prüft, ob die benannten Funktionssignaturen (`toErrorResponse(error, context, request)`, `applyMutation(context, request, mutate, event?)`, `listNotes(query, context, request)`, `readNote(id, query, context, request)`) ausreichen, um jeden `{base}/notes*`-Fehler zu erfassen, ohne andere Routen zu verändern.
13. **Viewer-Door-Dispatch:** Der Reviewer prüft die doppelte Absicherung — Dispatch-Prädikat in `respond()` und `null`-Rückfall in `handleViewer()`.
14. **Launcher-Hinweis:** Eine Meldung (`viewerSessionRefusalMessage`) für Shell, Bookmarklet, `/view` und fail-closed-Notizrouten; ohne öffentlich erreichbares `hubOrigin` keine konstruierte URL.
15. **`service_not_ready`:** Der Reviewer prüft, dass der Code nicht in `ERROR_CODES` rutscht und nicht über `glueError()` (typisiert auf `ServerErrorCode`) erzeugt wird.

### 11.3 Änderungsprotokoll Revision 2.1 (NF-Befunde)

| NF | Schwere | Änderung | Stellen |
|---|---|---|---|
| **NF-01** | major | `revokedTokens` (dieselbe Set-Referenz) und `requiredScope` in die explizite Viewer-Context-Allowlist; widerrufenes Token → `401 token_revoked` auf Viewer-`/notes`/`/bundle`/`/sessions`; UT-18, IT-43, AC-5.32 | §2.1 Regel 2, §2.4 Regel 2, §7.1, §8 |
| **NF-02** | major | `gateRequest()`-Reihenfolge auf den realen Ablauf erweitert (`hostRefusal → hubViewerPathRefusal → viewerSurfaceRefusal → adminGate → 404 → Preflight → config → health → authorize → route`); `/health` bleibt auf beiden Flächen öffentlich; UT-31 | §2.1 Regel 6, AC-5.23 |
| **NF-03** | major | `OPTIONS` auf der Viewer-Fläche vor `authorize()`: gültiger `notes*`-Preflight `204`, sonst `405` mit `Allow`; `bundle`/`sessions` `405`; nie `401`; AC-5.21/IT-19 angepasst | §2.1 Regel 11, §2.5 Regel 4, §2.8, AC-5.21 |
| **NF-04** | major | `viewer.origin` vor dem ersten bedienten Request: feste Ports synchron vor `listen()`, `port 0` echte Handler erst nach beiden Binds + Validierung; Startfenster `503 service_not_ready`; AC-F22/UT-32/IT-45 | §2.2 Regel 4, §2.4 Regel 4/5, §2.9 |
| **NF-05** | minor | `appName`, `exportedBy`, `now`, `version` in der Viewer-Context-Allowlist; Hub/Viewer-`/bundle` byte-identisch; AC-5.33/IT-44 | §2.4 Regel 2, AC-5.33 |
| **NF-06** | minor | Fehlendes Operator-Secret verbraucht kein `admin`-Budget mehr (bewusste Änderung statt stiller Übernahme); §5.3 + `CHANGELOG`; UT-16/RT-04 | §2.3 Regel 2, §4.5, §5.3, §9 |
| **NF-07** | minor | `activeJournal = null` in jedem Post-`listen()`-Fehlerzweig; AC-F16 um stale-Journal-Assertion erweitert; IT-36 | §2.4 Regel 5, §5.4, AC-F16 |
| **NF-08** | info | §3.1 Schritt 2 an §2.1 Regel 5 angeglichen (Launcher-Prüfung vor `hubViewerPathRefusal()`) | §3.1 |
| **NF-09** | minor | DNS-Allowlist-Semantik explizit: exakter Hostname darf privat auflösen, Wildcard nie; UT-14/IT-18, AC-5.19 | §2.2 Regel 12, §4.8, AC-5.19 |
| Testlücken | minor | AC-5.8 mit explizitem `X-Bluepencil-Actor`; `publicOrigin → Secure` end-to-end (IT-05); Nicht-Loopback-Host-Gate als Unit-Test mit injiziertem `bind` (UT-33) | §7.1, §8 |

### 11.4 Änderungsprotokoll Revision 2.2 (RR-Befunde)

| RR | Schwere | Änderung | Stellen |
|---|---|---|---|
| **RR-01** | major | „Wildcard-Bind“ einmal definiert (`isWildcardBind`: `""`, `0.0.0.0`, `::`, `[::]`); `viewer_origin_required` gilt für den **aufgelösten** Viewer-Bind, auch wenn er aus `--host` geerbt ist; `HubStartupErrorCode` erweitert; keine Origin-Ableitung aus einer unspecified Adresse; AC-F6/UT-06 um den Docker-Fall erweitert, AC-F23/UT-34/IT-46 programmatisch ergänzt | §2.2, §2.4 Regel 1/4/5/6, §2.10, §5.1, §5.2, §7.2, §8, §9 |
| **RR-02** | minor | CORS-Request wird durch `json`/`errorResponse`/`toErrorResponse`/`applyMutation`/`listNotes`/`readNote` durchgereicht; `GET /notes` (200) und `400 invalid_query`/`invalid_payload` sind in AC-5.21/UT-30/IT-19 abgedeckt | §2.5 Regel 3, §4.6, AC-5.21, §8 |
| **RR-03** | minor | Toter `allowMethods?`-Parameter entfernt; `Allow-Methods` ist die feste `/notes*`-Union; UT-19 prüft Signatur/Header | §2.5 Regel 1, §2.10, UT-19 |
| **RR-04** | minor | `viewerSessionRefusalMessage()` als eine Meldung für Shell, Bookmarklet, `/view` und fail-closed-Notizrouten; `{base}/viewer?k=` entfällt; AC-5.3/AC-5.12/UT-35/IT-03/IT-12 | §2.1 Regel 2.2, §2.2 Regel 7, §2.9, §7.1, §8 |
| **RR-05** | minor | Viewer-Door nur bei `surface === "viewer"` **und** `isViewerRequest()`; `/health`, `/notes*`, `/sessions`, `/bundle` bleiben bei `gateRequest()`; `handleViewer()`-`null`-Rückfall; UT-31 | §2.1 Regel 5/7, §2.2 Regel 5, §8 |
| **RR-06** | minor | Formulierung: Notiz-Routen verlangen Viewer-Session **oder** Client-Credential; ohne beides fail-closed `401` | §1.2, §6 R4 |
| **RR-07** | minor | `/bundle`-Parität als status-/content-type-/body-identisch präzisiert; Kopfzeilen nur um Hub-CORS; Test entfernt Hub-CORS vor dem Header-Vergleich | §2.4 Regel 2, §4.6, §6 R2, AC-5.33/IT-44 |
| **RR-08** | minor | `@internal`-Testseam `activeJournalForTests()`; AC-F16/UT-36 prüfen den Modulzustand direkt; die nicht entscheidungsfähige Flush-nach-`<dir1>`-Assertion ist ersetzt und als Restrisiko benannt | §2.4 Regel 11, §4.9 Nr. 11, AC-F16, UT-36/IT-36 |
| **RR-09** | info | `hubOrigin` ist die Bind-Origin; `startHub()` setzt sie nur bei Loopback-Hub-Bind, sonst URL-lose Meldung; AC-5.12/UT-35/IT-12 und §4.9 Nr. 9 | §2.2 `hubOrigin`, §2.4 Regel 3, §4.9, §7.1, §8 |
| **RR-10** | info | `service_not_ready` ist kein `ERROR_CODES`-Code und wird als lokale `GlueResponse`/`ServerResponse` vom Start-Handler beider Listener bzw. `handleViewerStart()` erzeugt — nie über `glueError()` | §2.9 |
| **RR-11** | info | Feste-Ports-Origin aus der konfigurierten Bind-Adresse bleibt; `--host localhost` → mögliche `::1`-Bindung als Grenze in §4.9 Nr. 10 dokumentiert; `--viewer-origin` für Proxy/TLS Pflicht | §2.4 Regel 4/6, §4.9, §10.3 RK-21 |

### 11.5 Änderungsprotokoll Revision 2.3 (Korrektur AC-5.24)

| Ref | Schwere | Änderung | Stellen |
|---|---|---|---|
| **C-01** | major (Doku) | Die frühere AC-5.24 behauptete für eine über `startHub()` **abgeleitete** Origin, ein Loopback-`X-Forwarded-Proto: https` erzeuge ein `Secure`-Cookie und https-Links. Das widersprach A3/RR-11 und dem realen Ablauf: `startHub()` löst `viewer.origin` vor dem ersten bedienten Request auf `http://<bind>:<port>` auf, und `publicOrigin()` gibt eine gesetzte Origin unverändert zurück. AC-5.24 ist auf die beabsichtigte Semantik korrigiert: explizite `--viewer-origin https://…` → https-Links + `Secure`; abgeleitete Origin → http-Links, kein `Secure`; der Loopback-XFP-Zweig von `publicOrigin()` gilt nur bei **ungesetztem** `origin` (eingebettet/programmatisch) und wird als Unit geprüft, nie über `startHub()`. Keine Implementierungsänderung, keine neue AC, keine geänderte Entscheidung E1–E5/S1–S3, kein Scope-Wechsel; `viewer_origin_required` sowie RR-11/RK-21 bleiben unverändert. | §1.4 A3, §2.2 Regel 3, §2.4 Regel 6, AC-5.24, §8.1 UT-21, §8.2 IT-05/IT-22, §11.1 |

### 11.6 Änderungsprotokoll Revision 2.4 (Korrektur AC-F21)

| Ref | Schwere | Änderung | Stellen |
|---|---|---|---|
| **C-02** | major (Doku) | AC-F21 erwartete in der ersten Zeile `viewer_origin_is_hub_origin` für `--viewer-public-url https://127.0.0.1:8787` gegen einen Hub-Bind `http://127.0.0.1:8787`. Das widerspricht §2.4 Regel 5: `normalizeOrigin` vergleicht scheme-sensitiv, also ist `https` ≠ `http` und es wird kein Startfehler geworfen. Entscheidung: der scheme-sensitive Vergleich aus §2.4 Regel 5 bleibt unverändert (keine scheme-unabhängige Implementierung). AC-F21 ist auf die Hub-**Bind-Origin** `http://127.0.0.1:8787` korrigiert; die zweite Zeile (`--cors https://hub.example.com` mit Alias `https://hub.example.com`) bleibt sachlich unverändert. §2.4 Regel 5, §5.2 und AC-F21 machen die Scheme-Sensitivität jetzt explizit. Keine andere AC geändert, keine Implementierungsänderung, keine geänderte Entscheidung E1–E5/S1–S3, kein Scope-Wechsel. | §2.4 Regel 5, §5.2, AC-F21, §11.1 |

## 12. Trace-Anker

```
spec-id: SPEC-viewer-origin
```

Der Plan referenziert diesen Wert unverändert. Das Design (`docs/specs/2026-11-06-viewer-origin-design.md`) trägt denselben Anker; diese Spec ist die normative Fassung, das Design bleibt Begründungsbeleg.

## 13. Revision 2026-11-08 (Issue #144)

> Datiert Nachtrag, **kein** Umschreiben. Der Fließtext oben bleibt als Beleg des Standes vom 2026-11-07 unverändert. Verbindlich für den Launcher-Einstieg ist ab 2026-11-08 `docs/specs/2026-11-08-viewer-launcher-entry.md` (`spec-id: SPEC-viewer-launcher-entry`). Alles, was dort nicht genannt ist, gilt hier unverändert.

Hintergrund: Issue #144 (Varianten C + B) ergänzt eine Launcher-Seite (HTML-Formular) und einen Admin-Einstieg. Das revidiert die frühere Entscheidung E3 („`?k=` + Header, kein POST-Formular", Review 2026-11-06 §4). Die Begründung steht in der neuen Spec §2.

**Welche Aussagen dieser Spec dadurch überholt sind (nur diese):**

| Stelle | Bisher | Ab 2026-11-08 | Warum |
|---|---|---|---|
| **§2.2 Regel 4** (`handleViewerStart()`) | Der Launcher ist implizit `GET`; Secret aus `x-bluepencil-admin` oder `?k=`; Antwort `302` | `GET` **und** `POST`. `POST` mit `application/x-www-form-urlencoded` liest dasselbe Feld aus dem Body und antwortet `303`; mit `Accept: application/json` stattdessen `200 {"url": …}`. `?k=` bleibt für `GET`; auf einem `POST` wird `?k=` nicht gelesen. Gates in dieser Reihenfolge: `405` → `503` → `403` (CSRF) → `415` → `413` → Body → `verifyOperatorSecret()` | FR-6.17, FR-6.26, FR-6.27, FR-6.28 |
| **§2.8, Zeile 582** (`GET /viewer/start?k=…` in der Routen-Matrix) | Eine Zeile für `GET`, Status `302`, Secret „admin throttle, operator secret (hub only)" | Zwei Pfade: `GET` (`200` HTML-Seite ohne Secret / `302` mit gültigem Secret) und `POST` (`303` Formular, `200` JSON, `401`/`403`/`413`/`415`/`429`). `Allow: GET, POST` für alle anderen Verben. Übrige Spalten unverändert | dito |
| **AC-5.4** | „… danach ohne beides → `401 unauthorized`" | Eingeengt: Mit einem `Accept`, das `text/html` ausdrücklich präferiert, und **ohne** präsentiertes Secret antwortet der Launcher `200` mit dem Formular (kein Budgetverbrauch). Für jedes andere `Accept` (inkl. `*/*` und fehlendem Header) bleibt es bei `401 unauthorized`. Der Header gewinnt weiterhin über `?k=`; `302`, `referrer-policy: no-referrer`, `cache-control: no-store` und „kein `Set-Cookie`" bleiben unverändert | FR-6.26, AC-L01, AC-L03 |
| **AC-5.9** | Viewer-Fläche: `GET /viewer/start` → `404` | Unverändert `404`, gilt jetzt auch für `POST` (der Pfad bleibt auf der Viewer-Fläche gesperrt) | FR-6.17 |
| **§7** (Test-/AC-Matrix des Launchers) | UT/IT für `GET`-only | Ergänzt um die Fälle der neuen Spec §9; `UT-20` bleibt gültig | — |

**Nicht betroffen:** D1–D12, §1.4 A5 (Viewer setzt `--admin-secret` voraus), die Oberflächentrennung (§2.1), Tickets (§2.2 Regeln 1/6), SSRF (§2.2 Regeln 10–14), CLI/Listener (§2.4) und die CORS-Regeln (§2.5). E1, E2, E4, E5 und S1–S3 bleiben in Kraft; nur **E3** ist `superseded`.
