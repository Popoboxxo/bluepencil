# Hub-Viewer auf eigenem Origin — Design

> Status: Entwurf (Freigabe durch den Nutzer ausstehend)
> spec-id: SPEC-viewer-origin
> Datum: 2026-11-06
> Issue: #140 — offenes Acceptance Criterion **AC 5**: „Viewer läuft auf eigenem Origin, nicht auf dem Hub-Port“.
> Zielrelease: nächstes 0.x-Minor (Breaking-Slot des Projekts); die konkrete Version setzt `release`.
> Bezug: `docs/VIEWER.md` (Ist-Stand 0.13.0), `docs/specs/0.12.0-audit-remediation-spec.md` (Spec-Konventionen), `.opencode/skills/spec-plan-workflow/SKILL.md`.
> Rolle: Systemdesign vor der Spec. Dieses Dokument ist **Spec-Input**; `concept-specifier` leitet daraus die Spec ab und übernimmt den Trace-Anker unverändert.

## 1. Problem / Ziel / Nicht-Ziele

### 1.1 Problem

Der 0.13.0-Viewer liefert Shell, Proxy, Assets und Bookmarklet auf **demselben Listener** wie die Notiz-API (`server/hub.ts:1435-1445`). Ein proxied Dokument läuft damit auf der Hub-Origin: sein JavaScript teilt die Origin mit `/notes`, `/mcp`, `/admin` und dem statischen `--root`-Baum. Das ist der in `docs/VIEWER.md` dokumentierte Restrisiko-Satz („The proxied page is trusted with the store“) und der Grund, warum AC 5 offen ist.

Zusätzlich sind zwei Eigenschaften des Ist-Stands heute nicht belastbar:

1. **Viewer-Session ist nicht surface-spezifisch.** `authorize()` akzeptiert `bp_viewer` für **jede** Route, die es erreicht (also außer dem Admin-Gate und `/mcp`; `server/handler.ts:1443-1445`). Auf dem Hub-Port ist die Viewer-Session damit ein zweiter Notiz-Schlüssel, obwohl sie aus einer Proxy-Seite stammt.
2. **Der Session-Austausch ist ungedrosselt.** `handleViewer` vergleicht `--admin-secret` direkt (`server/viewer.ts:360-376`), während `adminGate` denselben Vergleich mit `adminThrottle` und konstantzeitiger Prüfung ausführt (`server/admin.ts:324-430`).

### 1.2 Ziel

Der Viewer bekommt einen **zweiten HTTP-Listener im selben Prozess** mit eigener Origin. Beide Listener teilen sich genau einen Store, genau ein Journal und genau eine In-Memory-Session-/Ticket-Verwaltung. Damit gilt:

- Viewer-Inhalt (Shell, `/view`, Assets, Bookmarklet) ist auf dem Hub-Port **nicht** erreichbar (404).
- Notizen, die über die Viewer-Origin geschrieben werden, sind für Hub-`/notes`, Hub-`/bundle`, Hub-`/journal` und Hub-`/mcp` sofort sichtbar.
- Die Viewer-Origin bietet **keine** Admin-, MCP-, Journal-, `/config`- oder statische `--root`-Fläche.
- Die Viewer-Fläche ist **fail-closed**: Notiz-Routen verlangen dort immer eine Viewer-Session, auch ohne `--auth-secret`.
- Der Admin-Secret-Vergleich passiert ausschließlich auf der Hub-Origin und läuft durch denselben `adminThrottle` wie `/admin/*`.
- SSRF-Schutz wird um DNS-Auflösung, IP-Klassifikation und Prüfung jedes Redirect-Hops gehärtet.

### 1.3 Nicht-Ziele

- Keine neue Runtime-Dependency (NFR-4); nur `node:http`, `node:dns` über die bestehende `net-policy`-Abstraktion.
- Kein Schema-/Bundle-Bump, keine Änderung an `src/data/**`, keine Änderung am Element-Bundle (NFR-3 bleibt unberührt).
- Kein Multi-Prozess-Betrieb, kein File-Lock, kein Cluster-Modus. Der Viewer-Listener ist **kein** zweiter Hub.
- Keine Änderung an MCP-Protokoll, Federator, Extension oder CLI außerhalb der in §8 genannten Flags.
- Kein generelles CORS für die Viewer-Origin; keine `Access-Control-Allow-Credentials`-Antwort.
- Keine automatische Migration alter Bookmarklets; sie werden neu ausgestellt.
- Keine Verschlüsselung des Stores; TLS bleibt externe Reverse-Proxy-Aufgabe.

### 1.4 Explizite Annahmen

1. Von Issue #140 ist in diesem Auftrag nur **AC 5** bekannt. Die übrigen ACs werden nicht neu erfunden; sie bleiben unverändert und werden hier nicht umnummeriert.
2. Das nächste 0.x-Minor ist der Breaking-Slot (Projektkonvention). Die konkrete Versionsnummer ist Release-Prozess, nicht Design.
3. TLS wird extern terminiert. Der Hub und der Viewer-Listener sprechen plain HTTP; die öffentliche Origin wird über `--viewer-origin` (und optional `X-Forwarded-Proto` von einem Loopback-Proxy) beschrieben.
4. Der Store ist eine einzige Datei, die in der unterstützten Topologie von **einem** Prozess beschrieben wird. Fremde Schreiber (Editor, zweiter Prozess) bleiben last-writer-wins; das ist ein dokumentiertes Restrisiko, kein Designziel.
5. `--admin-secret` bleibt für `--viewer` verpflichtend. Ein Viewer ohne Operator-Credential existiert nicht.
6. Die Viewer-Origin darf dieselbe Hostname mit anderem Port sein (dann ist sie eine andere Origin im Sinne der Same-Origin-Policy). **Cookie-Isolation** verlangt zusätzlich einen anderen Hostnamen; das wird diagnostiziert, nicht erzwungen (§7.5).

## 2. Komponentenkarte

| Komponente | Verantwortung | Grenze |
|---|---|---|
| **Hub-Listener** | Bestehende Fläche: `/notes*`, `/sessions`, `/bundle`, `/mcp`, `/journal`, `/admin*`, `/config`, `/health`, `--root`-Static, `--cors`. Zusätzlich `GET {base}/viewer/start` als Launcher. | Bindet `--host:--port`; sieht den Viewer-Inhalt nie. |
| **Viewer-Listener** | Shell, Ticket-Einlösung, `/view`-Proxy, Assets, Bookmarklet-Artefakt, Notiz-/Session-/Bundle-/Health-Routen. | Bindet `--viewer-host:--viewer-port`; sieht `/admin`, `/mcp`, `/journal`, `/config`, `--root` nie. |
| **Shared Handler-Context** | Ein `NoteStoreState`-Objekt, ein `persist`-Closure, ein `Journal`, ein `adminThrottle`, eine `Presence`, eine `ViewerSessions`, eine `ViewerTickets`. Zwei Context-Views mit `surface: "hub" \| "viewer"` und je eigenem `bind`. | Ein Prozess, eine Wahrheit. Kein zweiter `createFileStore`-Aufruf. |
| **Viewer-Door** (`server/viewer.ts`) | Ticket-Erzeugung/-Einlösung, Session-Cookie, Routen der Viewer-Fläche, Injection, Proxy, SSRF-Prüfung. | Kennt keine Admin-Routen und keinen MCP-Door. |
| **Notes-Router** (`server/handler.ts`) | Bestehende Notiz-Routen; `surface`-abhängige Autorisierung und Routen-Sichtbarkeit. | Eine Implementierung; die Surface-Prüfung ist eine Verzweigung, keine Kopie. |
| **Store/Journal** (`server/hub.ts`) | `createFileStore`, `store.persist`, `journal.record`, `loadNotes` pro Request. | Genau eine Instanz; von beiden Listenern referenziert. |
| **CLI-Parser** (`parseHubArgs`) | Neue Flags, Validierung, Env-Variablen, Fehlercodes. | Reine Funktion, ohne Socket. |
| **SSRF-Policy** (`src/federation/net-policy.ts`) | Wiederverwendung von `classifyAddress`, `createDnsResolver`, `HostResolver`, `AddressClass`. | Keine neue Kopie der IP-Arithmetik. |
| **Admin-Secret-Verify** (`server/admin.ts`) | Eine Implementierung für `x-bluepencil-admin` und den Launcher; `adminThrottle` + konstantzeitiger Vergleich. | Wird auf der Viewer-Fläche **nie** aufgerufen. |
| **CORS** (`server/cors.ts`) | Hub-CORS unverändert; Viewer-Fläche nur Header-Token-Preflight für das Bookmarklet. | Keine `Allow-Credentials`-Antwort. |

### 2.1 Prozessbild

```
                    ┌──────────────────────────────────────────────┐
                    │              ein Node-Prozess                │
                    │                                              │
  --host:--port ───▶│  Hub-Listener  ──┐                           │
                    │                  ├──▶ shared HandlerContext  │
  --viewer-host:    │                  │      ├─ store.state       │
  --viewer-port ───▶│  Viewer-Listener ┘      ├─ persist/journal  │
                    │                         ├─ adminThrottle    │
                    │                         ├─ ViewerSessions   │
                    │                         └─ ViewerTickets    │
                    └──────────────────────────────────────────────┘
```

Der Hub-Listener bleibt der einzige Ort mit `/mcp`, `/admin*`, `/journal` und `--root`. Der Viewer-Listener ist der einzige Ort mit Shell, Proxy und Assets. Beide rufen denselben `handleRequest`-Router, aber mit unterschiedlichem `surface`.

## 3. Interface Contracts

Alle Signaturen sind Ziel-Contracts; bestehende Symbole bleiben, sofern nicht ausdrücklich ersetzt.

### 3.1 `server/handler.ts` — Surface und Autorisierung

```ts
/** Welche Fläche diesen Request bedient. Default ist "hub" (rückwärtskompatibel). */
export type HubSurface = "hub" | "viewer";

export interface HandlerContext {
  // … bestehende Felder unverändert …
  /** Gesetzt von `startHub`; fehlt bei eingebetteten Hosts und in reinen Unit-Tests. */
  surface?: HubSurface;
}

/** Total: fehlendes `surface` bedeutet "hub". */
export function surfaceOf(context: HandlerContext): HubSurface;

/**
 * Erweitert um die Surface-Semantik:
 * - surface === "viewer": `viewerAuthorized()` ist der Primärschlüssel; ohne konfiguriertes
 *   Client-Credential ist ein fehlender Viewer-Session-Cookie ein 401 (fail-closed).
 * - surface === "hub": `viewerAuthorized()` wird NICHT konsultiert. Eine `bp_viewer`-Cookie
 *   autorisiert auf dem Hub-Port nichts.
 */
export function authorize(
  request: ServerRequest,
  context: HandlerContext,
  scope?: "read" | "write",
  options?: { allowAdminSecret?: boolean },
): ServerResponse | null;

/** 404 auf der Viewer-Fläche für /admin*, /mcp*, /journal*, /config, /viewer/start und alles außerhalb der API. */
export function viewerSurfaceRefusal(
  request: Pick<ServerRequest, "url">,
  context: HandlerContext,
): ServerResponse | null;
```

`gateRequest` ruft `viewerSurfaceRefusal()` direkt nach dem Host-Gate und **vor** `adminGate`, `configResponse` und `authorize` auf. Damit wird `/admin` auf der Viewer-Fläche nicht einmal nach seiner Existenz gefragt.

Ebenso wird der Viewer-Kurzdurchlauf in `earlyRefusal()` und `respond()` an `surfaceOf(context) === "viewer"` gebunden. Auf der Hub-Fläche gibt es keinen Viewer-Door-Durchlauf; `/viewer`, `/view` und `/viewer/assets/*` laufen dort durch die normale 404-Behandlung des Routers und kosten keinen Body-Read und keinen Store-Load. Der Launcher (`isViewerStartRequest`) wird auf der Hub-Fläche in `respond()` und `earlyRefusal()` **vor** `gateRequest` geprüft; auf der Viewer-Fläche fällt er durch `viewerSurfaceRefusal()` auf 404.

### 3.2 `server/viewer.ts` — Tickets, Cookie, Routen, SSRF

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
   * Kein Pfad, keine Query, kein Fragment. Vor dem ersten Request gesetzt: explizit aus
   * `--viewer-origin` oder abgeleitet aus Bind-Adresse und tatsächlichem Port nach `listen()`.
   */
  origin?: string;
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

/** Pfad des Launchers auf der Hub-Fläche. */
export function viewerStartPath(base: string): string;

export function isViewerStartRequest(url: string, context: HandlerContext): boolean;

/** Hub-Fläche: Admin-Secret → Einmal-Ticket → 302 auf die Viewer-Origin. */
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

/** null = erlaubt; sonst menschenlesbarer Grund. Prüft Protokoll, Credentials, Allowlist, DNS, IP-Klasse. */
export function checkTarget(
  raw: string,
  allow: readonly string[],
  deps?: TargetPolicyDeps,
): Promise<string | null>;
```

`targetRefusal()` bleibt als synchrone Vorprüfung (Protokoll, Userinfo, Allowlist) erhalten und wird von `checkTarget()` aufgerufen; die DNS-/IP-Prüfung ist der neue asynchrone Teil. `VIEWER_MAX_BYTES`, `VIEWER_FETCH_TIMEOUT_MS`, `VIEWER_MAX_REDIRECTS`, `VIEWER_ASSET_FILES`, `VIEWER_COOKIE`, `VIEWER_HEADER` bleiben unverändert.

### 3.3 `server/admin.ts` — eine Operator-Secret-Prüfung

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

`adminGate` wird auf `verifyOperatorSecret()` umgestellt; die Antwortcodes (`401`, `429`, `Retry-After: 300`) bleiben identisch.

### 3.4 `server/hub.ts` — CLI, Listener, `RunningServer`

```ts
export interface ViewerListenOptions {
  /** Bind-Adresse; Default: `--host`. */
  host?: string;
  /** Pflicht, sobald `--viewer` gesetzt ist; 0..65535; muss sich von `--port` unterscheiden. */
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
  };
}

export interface RunningViewer {
  readonly server: Server;
  readonly host: string;   // tatsächlich gebundene Adresse
  readonly port: number;   // tatsächlicher Port (auch bei `--viewer-port 0`)
  readonly url: string;    // `viewerOrigin + base`
  readonly origin: string; // öffentliche Origin, wie in Links/Cookies verwendet
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
```

`resolveOptions()` erzeugt `ViewerOptions` inklusive `createViewerSessions()` und `createViewerTickets()` **einmal**. `startHub()` baut daraus zwei Context-Views:

```ts
const hubContext: HandlerContext = { ...baseContext, surface: "hub", bind: hubBind };
const viewerContext: HandlerContext = {
  ...baseContext,
  surface: "viewer",
  bind: viewerBind,
  cors: undefined,                       // keine Hub-CORS-Vokabel auf der Viewer-Fläche
  hostAliases: viewerHostAliases,        // Loopback + Hostname aus --viewer-origin
  viewer: resolved.viewer,               // dieselbe sessions/tickets-Instanz
};
```

`baseContext.store` ist `store.state`, `baseContext.persist` ist derselbe Closure. Es gibt keinen zweiten `createFileStore`-Aufruf.

### 3.5 `server/cors.ts` — Bookmarklet-Preflight

```ts
/**
 * Nur für die Viewer-Fläche und nur für `{base}/notes*`:
 * reflektiert den `Origin` des Aufrufers, erlaubt `content-type` und `x-bluepencil-viewer`,
 * sendet NIE `access-control-allow-credentials`, setzt `Vary: Origin`.
 * null, wenn kein gültiger http(s)-Origin vorliegt.
 */
export function viewerBookmarkletPreflight(
  method: string | undefined,
  requestOrigin: string | undefined,
  allowMethods?: readonly string[],
): PreflightAnswer | null;

/** Die gleiche Reflektion für die eigentliche Antwort (nicht nur OPTIONS). */
export function viewerBookmarkletCors(
  requestOrigin: string | undefined,
): Record<string, string>;
```

Die Hub-`--cors`-Logik (`corsOriginPolicy`, `preflightResponse`) bleibt unverändert.

## 4. Routen-Matrix pro Surface

Alle Pfade relativ zu `base` (Default `/api/v1/bluepencil`).

| Route | Hub-Fläche | Viewer-Fläche | Auth auf der Viewer-Fläche | Notizen/Secrets |
|---|---|---|---|---|
| `GET /viewer/start?k=…` (oder `x-bluepencil-admin`) | **302** zur Viewer-Origin mit Ticket | **404** | `adminThrottle` (`admin`), Operator-Secret | kein Notiz-Body; Secret nur im Header/Query der Hub-Origin |
| `GET /viewer?ticket=…` | **404** | **302** + `Set-Cookie`, dann `/viewer` | Einmal-Ticket (60 s, single-use) | kein Notiz-Body |
| `GET /viewer` | **404** | **200** Shell | Viewer-Session | Shell enthält keine Notizen |
| `GET /view?url=…` | **404** | **200** proxied HTML | Viewer-Session | injizierte Layer-Endpoint zeigt auf Viewer-Origin |
| `GET /viewer/assets/<bundle>` | **404** | **200** JS | **öffentlich** (kein Cookie/Header) | statisches Bundle, keine Notizen |
| `GET /viewer/bookmarklet.txt` | **404** | **200** Text | Viewer-Session | Platzhalter, kein Live-Token |
| `GET /notes` | ja | ja | Viewer-Session **oder** Client-Credential | Notizen |
| `POST /notes` | ja | ja | Viewer-Session **oder** Client-Credential | Notizen |
| `GET/PATCH /notes/{id}` | ja | ja | Viewer-Session **oder** Client-Credential | Notizen |
| `POST /notes/{id}/messages` | ja | ja | Viewer-Session **oder** Client-Credential | Notizen |
| `POST /notes/bulk-delete` | ja | ja | Viewer-Session **oder** Client-Credential | Notizen |
| `GET /sessions` | ja | ja | Viewer-Session **oder** Client-Credential | Sitzungs-Metadaten |
| `GET /bundle` | ja | ja | Viewer-Session **oder** Client-Credential | alle Notizen |
| `GET/HEAD /health` | ja, öffentlich | ja, öffentlich | keine | drei Felder, keine Notizen |
| `GET /config` | ja, öffentlich | **404** | — | Bind/Auth-Modus/Föderation (Info-Disclosure) |
| `GET /journal` | ja | **404** | — | Audit-Metadaten |
| `POST /mcp` | ja | **404** | — | MCP-Door |
| `GET /admin`, `/admin/*` | ja (Admin-Gate) | **404** | — | Token-Minting/Revocation |
| `--root`-Static außerhalb `base` | ja | **404** | — | statische Dateien |
| `OPTIONS /notes*` | gemäß `--cors` | Header-Token-Preflight (reflektiert, ohne Credentials) | — | keine |

Begründung der Auslassungen auf der Viewer-Fläche:

- `/admin*` und `/mcp` sind credential-verwaltende bzw. client-orientierte Flächen; sie gehören nicht auf eine Origin, auf der fremder proxied Code läuft.
- `/journal` enthält Audit-Metadaten (Note-IDs, Autoren, Zusammenfassungen) und gehört zum Hub.
- `/config` nennt Bind-Adresse, Auth-Modus und Föderationsstatus; die Layer braucht es nicht (der HTTP-Adapter liest es nicht).
- `--root` ist eine beliebige statische Fläche des Betreibers; sie auf der Viewer-Origin zu spiegeln würde die Angriffsfläche ohne Nutzen verdoppeln.
- `/viewer/start` ist der einzige viewer-bezogene Pfad auf der Hub-Fläche. Er liefert keinen Viewer-Inhalt, sondern ein Ticket.

## 5. Datenfluss

### 5.1 Operator-Start (Ticket)

1. Operator öffnet `GET http://hub:8787/api/v1/bluepencil/viewer/start?k=<admin-secret>` (oder mit `x-bluepencil-admin`).
2. **Hub-Listener**: Host-Gate (`hubBind`) → `isViewerStartRequest` → `verifyOperatorSecret` (konstantzeitiger Vergleich, `admin`-Budget) → `tickets.mint()`.
3. Antwort: `302 Location: https://view.example.com/api/v1/bluepencil/viewer?ticket=<ticket>`, Header `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
4. Browser folgt zur **Viewer-Origin**.
5. **Viewer-Listener**: Host-Gate (`viewerBind` + `--viewer-origin`-Hostname) → `handleViewer` erkennt `?ticket=` → `tickets.consume(ticket)` atomar.
   - ungültig/abgelaufen/bereits verbraucht → `401 unauthorized`, **kein** Cookie.
   - gültig → `sessions.mint()`; `Set-Cookie: bp_viewer=…; HttpOnly; SameSite=Lax; Path=<base>; Max-Age=<ttl>[; Secure]`; `302 Location: <base>/viewer` (ohne Query); `Referrer-Policy: no-referrer`.
6. `GET <base>/viewer` mit Cookie → Shell.

Der Admin-Secret-Wert erreicht die Viewer-Origin **nie**. `?k=` auf der Viewer-Origin wird nicht verglichen, sondern mit `401` und dem Hinweis auf den Hub-Launcher abgelehnt.

### 5.2 Shell, Proxy, Asset

1. Shell (`GET /viewer`) rendert URL-Formular, Allowlist, Bookmarklet. Das Formular setzt `iframe.src = <viewerOrigin><base>/view?url=…`.
2. `GET /view?url=<target>` mit Viewer-Cookie:
   - `checkTarget(target, allow, { resolver, forbiddenOrigins: [viewer.origin] })` → Protokoll, Userinfo, Allowlist, DNS-Auflösung, IP-Klassifikation.
   - `fetch(current, { redirect: "manual", signal: AbortSignal.timeout(VIEWER_FETCH_TIMEOUT_MS) })`.
   - Jeder `3xx`-`Location`-Hop wird erneut durch `checkTarget()` geprüft; maximal `VIEWER_MAX_REDIRECTS`.
   - Größen-/Content-Type-/Status-Prüfung wie heute.
   - `buildViewDocument()` mit absoluter `endpoint = <viewerOrigin><base>` und `elementSrc = <viewerOrigin><base>/viewer/assets/bluepencil.element.min.js`.
   - Antwort `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
3. `GET /viewer/assets/<bundle>` ist **öffentlich** (kein Cookie, kein Header). Das ist die Korrektur für das Bookmarklet: ein `<script src>` auf einer fremden Seite kann weder Cookie (SameSite=Lax, cross-site Subresource) noch Custom-Header senden. Die Route liefert nur die zwei bekannten Bundles aus `VIEWER_ASSET_FILES`, mit `Access-Control-Allow-Origin: *`, `Cross-Origin-Resource-Policy: cross-origin`, `Cache-Control: no-cache`.
4. `GET /viewer/bookmarklet.txt` ist session-geschützt und enthält nur den Platzhalter `__BP_VIEWER_TOKEN__`.

### 5.3 Schreibpfad (Layer → Viewer-Origin → gemeinsamer Store)

1. Die in `/view` injizierte `<bluepencil-notes endpoint="<viewerOrigin><base>">` läuft auf der Viewer-Origin. `fetch` sendet den `bp_viewer`-Cookie same-origin automatisch (`credentials: "same-origin"` ist der Browser-Default).
2. **Viewer-Listener** `POST <base>/notes`:
   - Host-Gate (`viewerBind`).
   - `earlyRefusal` → `gateRequest` → `viewerSurfaceRefusal` (Pfad ist erlaubt) → `authorize`:
     - `viewerAuthorized()` prüft `x-bluepencil-viewer` oder `bp_viewer` → `null` (erlaubt).
     - ohne Session und ohne konfiguriertes Client-Credential → `401` (fail-closed).
   - Body lesen, `store.state.notes = loadNotes(options.storePath)` (frischer Stand), `handleRequest` mutiert `context.store.notes` (neues Array), `context.persist`:
     - `store.persist(state)` schreibt `options.storePath` atomar.
     - `journal.record(describeMutation(...))` schreibt in dasselbe Journal.
3. **Hub-Listener** `GET <base>/notes`: lädt `store.state.notes = loadNotes(options.storePath)` vor dem Request und liefert die Notiz.
4. **Hub-Listener** `POST <base>/mcp` mit `tools/call list_notes`: `handleMcpRoute` liest `readTextIfExists(options.storePath)` — dieselbe Datei, dieselbe Notiz.
5. **Hub-Listener** `GET <base>/bundle` und `GET <base>/journal`: dieselbe kanonische Form bzw. dasselbe Journal.

### 5.4 Kein zweiter Store — Begründung

- `startHub()` ruft `createFileStore()` **genau einmal** auf (`server/hub.ts:1323`). `hubContext.store` und `viewerContext.store` zeigen auf dasselbe `store.state`-Objekt.
- `persist` ist **ein** Closure über `store` und `journal`; beide Listener verwenden denselben `context.persist`.
- `handleMcpRoute` bekommt `read`/`write`-Callbacks, die `options.storePath` lesen/schreiben — dieselbe Datei.
- Es gibt keine zweite `Journal`-Instanz und keine zweite Session-/Ticket-Map.
- Innerhalb des Prozesses sind `loadNotes` → `handleRequest` → `persist` nach dem `await readBody` **synchron und zusammenhängend**; der Node-Event-Loop kann sie nicht mit einer zweiten Mutation verzahnen. Fremde Prozesse bleiben last-writer-wins (Restrisiko, §7.5).

## 6. Auth-Modell

### 6.1 Entscheidung: Hub-gemünztes Einmal-Ticket (Variante b)

**Vergleich der Varianten**

| Kriterium | (a) `viewer.operatorSecret` + `adminThrottle` auf der Viewer-Origin | (b) Hub-Ticket + 302 (gewählt) |
|---|---|---|
| Admin-Secret auf der Viewer-Origin | ja, wird dorthin übertragen und dort erneut verglichen | **nein**, bleibt auf der Hub-Origin |
| Secret in URL/History/Logs der Viewer-Origin | bei `?k=` ja; bei POST-Formular nein, aber Secret im Formular-Body | nein; nur kurzlebiges Einmal-Ticket |
| Proxied JS kann Secret lesen | **ja**, wenn das Secret in ein Formular auf derselben Origin getippt wird (Same-Origin-Iframe) | **nein**, Secret ist nie auf der Origin |
| Throttle-Implementierungen | zwei Aufrufstellen, zwei Budgets oder geteiltes Budget über zwei Listener | eine Aufrufstelle (`verifyOperatorSecret` auf Hub) |
| Brute-Force-Fläche | Admin-Secret auf einer Origin mit fremdem Code | 192-Bit-Ticket, 60 s, single-use; Secret nur auf Hub |
| UX | Viewer-Origin zeigt Login-Formular | Operator startet auf dem Hub, wird weitergeleitet |
| Rückwärtskompatibilität | `?k=` auf der Viewer-Origin müsste neu implementiert werden | bestehendes `?k=` auf dem Hub bleibt als Launcher erhalten (Pfad ändert sich) |

Variante (a) ist **verworfen**, weil die Viewer-Origin bewusst fremden, proxied JavaScript ausführt. Ein Secret, das auf dieser Origin in ein Formular getippt oder als Cookie gehalten wird, ist für denselben Origin-Code erreichbar. Variante (b) hält das Operator-Secret auf der Fläche, die keinen fremden Code ausführt.

**Ticket-Eigenschaften**

- 24 Byte `randomBytes` → 48 Hex-Zeichen (192 Bit); nicht erratbar.
- TTL 60 s; `consume()` ist atomar (Map-`delete` vor der Rückgabe), Replay → `401`.
- Map wird bei jedem `mint()`/`consume()` von abgelaufenen Einträgen bereinigt; Obergrenze `VIEWER_MAX_TICKETS = 1024`, danach wird der älteste Eintrag verworfen (Memory-Hygiene, keine Sicherheitsgrenze).
- Kein Peer-Binding: ein Ticket ist ein Bearer-Wert. Das ist bewusst, weil Browser und Reverse Proxy unterschiedliche Peer-Adressen sehen können; die kurze TTL und Single-Use sind die Gegenmaßnahme.
- Der Launcher nutzt dasselbe `admin`-Budget wie `/admin/*`. Ein falsches `?k=` am Launcher sperrt also auch `/admin/*` für dieses Peer (und umgekehrt) — die gewollte „ein Secret, ein Budget“-Regel aus G2.

### 6.2 Cookie-Scope

| Attribut | Wert | Begründung |
|---|---|---|
| Name | `bp_viewer` | unverändert |
| `HttpOnly` | immer | Target-JS darf den Token nicht lesen |
| `SameSite` | `Lax` | Same-Origin-Fetches der Layer senden den Cookie; cross-site POST/PATCH wird blockiert; `None` würde `Secure` erzwingen und die Angriffsfläche verbreitern |
| `Path` | `<base>` (z. B. `/api/v1/bluepencil`) | Shell, `/view`, Assets und `/notes` liegen unter `base`; kein Cookie an unrelated Pfade |
| `Secure` | genau dann, wenn die öffentliche Viewer-Origin `https:` ist | auf plain http würde `Secure` den Cookie unbrauchbar machen; die Entscheidung kommt aus `--viewer-origin`, nicht aus einem spoofbaren Header |
| `Max-Age` | `ttlSeconds` (Default 8 h, Max 7 d) | unverändert |
| `Domain` | nicht gesetzt (host-only) | kein Cookie an Subdomains |

**Port-Isolation:** Cookies sind nicht port-isoliert. Bei `viewer.example.com:8788` und `hub.example.com:8787` (gleicher Hostname) würde `bp_viewer` auch an den Hub-Port gesendet. Der Hub ignoriert ihn (surface-scoped `authorize`), aber echte Isolation gibt es nur mit unterschiedlichem Hostnamen. Deshalb:

- `--viewer-origin` mit anderem Hostnamen ist die empfohlene Konfiguration.
- Bei gleichem Hostnamen (nur anderer Port) gibt `startHub` die Warnung `viewer_cookie_shared_host` aus (nicht unterdrückbar durch `--quiet`).
- Ein harter Fehler wäre für Lab-Setups mit `localhost:8787`/`localhost:8788` zu restriktiv; AC 5 verlangt eine andere Origin, nicht zwingend einen anderen Host.

### 6.3 Fail-closed auf der Viewer-Fläche

`authorize()` mit `surface === "viewer"`:

1. `viewerAuthorized(request, context)` → `null` (erlaubt). Gilt für Cookie und `x-bluepencil-viewer`.
2. Sonst, wenn **kein** Client-Credential konfiguriert ist (`verifyToken === undefined && authSecret === undefined`) → `401 unauthorized` mit Hinweis auf den Launcher. Das ist die Fail-closed-Regel: die Viewer-Origin ist niemals offen, auch wenn der Hub ohne `--auth-secret` läuft.
3. Sonst normales Credential-Verfahren (`Authorization: Bearer` / `x-bluepencil-auth`), inklusive `adminThrottle` und Scope. Ein konfiguriertes Client-Credential bleibt also für CLI/Tooling nutzbar.

Auf der Viewer-Fläche setzt `gateRequest` **kein** `allowAdminSecret`; das Admin-Secret ist dort kein Notiz-Credential. Die zweite Credential-Rolle des Admin-Secrets bleibt auf die Hub-Fläche (`/notes*` über die Admin-Seite) beschränkt.

`authorize()` mit `surface === "hub"`:

- `viewerAuthorized()` wird **nicht** aufgerufen. Eine `bp_viewer`-Cookie oder ein `x-bluepencil-viewer`-Header autorisiert auf dem Hub-Port keine Notiz-Route.
- Ohne konfiguriertes Credential bleibt der Hub offen (bestehendes Verhalten, G1).

### 6.4 Threat Model

| Bedrohung | Analyse | Maßnahme / Restrisiko |
|---|---|---|
| **Secret in URL/History/Logs** | `?k=` auf dem Hub-Launcher landet in Browser-History und ggf. Proxy-Logs. | `Referrer-Policy: no-referrer` + `Cache-Control: no-store`; `x-bluepencil-admin`-Header als empfohlene Alternative dokumentieren; `?k=` bleibt für Kompatibilität. Restrisiko: History/Logs beim Operator. |
| **Secret auf der Viewer-Origin** | In Variante (a) von proxied JS lesbar; in (b) nie dort. | (b) gewählt; `?k=` auf der Viewer-Origin wird abgelehnt. |
| **Ticket-Leak** | Ticket in URL/History; 60 s, single-use, 192 Bit. | Kurze TTL, atomarer Verbrauch, `no-referrer`, sofortiger 302 auf saubere URL. Restrisiko: wer das Ticket vor dem Browser abgreift, erhält eine Session. |
| **Brute Force auf das Admin-Secret** | Launcher vergleicht das Secret. | `verifyOperatorSecret` mit `adminThrottle` (10 Fehlversuche / 5 min / Peer, `429` + `Retry-After: 300`), konstantzeitiger Vergleich. |
| **Brute Force auf Tickets** | 192 Bit Zufall. | Kein Throttle nötig; Obergrenze der Map verhindert Memory-DoS. |
| **Referrer-Leak** | Externe Ziele oder fremde Seiten könnten die Viewer-URL als Referer sehen. | `Referrer-Policy: no-referrer` auf Shell, Proxy und Redirects. |
| **Proxied JS liest Shell/DOM** | `/view` und `/viewer` sind same-origin; das Target kann `parent` erreichen. | Die Shell hält **kein** Secret; der Session-Cookie ist `HttpOnly`; das Admin-Secret ist nie auf der Origin. Das Target kann die Session same-origin nutzen — bewusst (Operator-Surface, Allowlist). |
| **Cookie-Sharing über Ports** | `bp_viewer` wird bei gleichem Hostnamen auch an den Hub gesendet. | Hub akzeptiert ihn nie; Warnung `viewer_cookie_shared_host`; empfohlene Konfiguration mit eigener Hostname. |
| **CSRF auf Viewer-Notiz-Routen** | `SameSite=Lax` blockiert cross-site POST/PATCH; `Content-Type: application/json` erzwingt Preflight bei simple requests. | Dokumentiert; keine `Allow-Credentials`-CORS-Antwort. |
| **XSS im Target** | Das Target läuft mit der Viewer-Origin; es kann die Session same-origin verwenden. | Allowlist, `X-Frame-Options: SAMEORIGIN`, kurze Session-TTL, keine Admin-Fläche auf der Origin. Restrisiko dokumentiert. |
| **Ticket-Map-Erschöpfung** | Viele `mint()`-Aufrufe. | 1024er-Obergrenze mit Eviction; der Launcher ist throttled. |

### 6.5 Entscheidungen (Fowler-Format)

```
DECISION D1 — Prozess-Architektur
context: Der Viewer braucht eine andere Origin, aber denselben Store wie der Hub.
choice: Zweiter node:http-Listener im selben Prozess, zwei HandlerContext-Views mit surface, gemeinsam genutzter store.state/persist/Journal/Sessions/Tickets.
alternatives:
  - Separater Prozess/Instanz: braucht File-Lock oder Koordination, doppeltes Journal, zwei Credentials, doppelter Betrieb — verworfen.
  - Externer Reverse Proxy allein: löst die Route-Trennung nicht im Code; der Hub-Port bliebe Viewer-fähig — verworfen.
consequences: Ein Prozess, eine Wahrheit, ein close(); dafür wächst server/hub.ts und die Surface-Verzweigung muss getestet werden.
```

```
DECISION D2 — Auth-Austausch
context: Der Operator muss eine Session auf der Viewer-Origin erhalten, ohne das Admin-Secret dorthin zu bringen.
choice: Hub-Launcher prüft das Admin-Secret (adminThrottle) und mintet ein 60-s-Einmal-Ticket; die Viewer-Origin löst es gegen einen Session-Cookie ein.
alternatives:
  - Operator-Secret direkt auf der Viewer-Origin: proxied JS teilt die Origin und kann das Secret im Formular lesen — verworfen.
  - Client-Credential (--auth-secret) als Viewer-Login: das ist ein Browser-Credential, kein Operator-Credential; Rollen vermischt — verworfen.
consequences: Ein zusätzlicher Launcher-Pfad auf dem Hub; alte `{base}/viewer?k=`-Links müssen auf `{base}/viewer/start?k=` umziehen.
```

```
DECISION D3 — Surface-basierte Autorisierung
context: Eine Viewer-Session darf auf dem Hub-Port keine Notiz-Route öffnen; die Viewer-Fläche darf ohne --auth-secret nicht offen sein.
choice: authorize() verzweigt auf surface: "hub" ignoriert Viewer-Sessions, "viewer" verlangt sie fail-closed, sofern kein Client-Credential konfiguriert ist.
alternatives:
  - Viewer-Session weiter global akzeptieren: AC 5 bliebe wirkungslos, weil der Hub-Port ein zweiter Notiz-Schlüssel wäre — verworfen.
  - Viewer-Fläche nur bei --auth-secret schließen: fail-open ohne Credential — verworfen.
consequences: Ein zentraler Auth-Pfad; jede Surface-Änderung ist eine Sicherheitsänderung und braucht die AC-5-Matrix.
```

```
DECISION D4 — Routen-Sichtbarkeit
context: Auf der Viewer-Origin läuft fremder Code; die Fläche muss minimal sein.
choice: Viewer-Fläche serviert Shell, /view, Assets, Bookmarklet, notes*, sessions, bundle, health; sie serviert NICHT /admin*, /mcp, /journal, /config, /viewer/start und --root.
alternatives:
  - Ganze API auf beiden Flächen: verdoppelt Admin-/MCP-Angriffsfläche — verworfen.
  - /config auf der Viewer-Fläche: nennt Bind/Auth/Föderation, von der Layer nicht gebraucht — verworfen.
consequences: Eine explizite Routen-Matrix; viewerSurfaceRefusal() ist die eine Durchsetzung.
```

```
DECISION D5 — Asset-Route öffentlich
context: Das Bookmarklet lädt das Element-Bundle per <script src> von einer fremden Seite; ein solcher Request kann weder Cookie noch Custom-Header senden.
choice: /viewer/assets/* ist auf der Viewer-Fläche session-frei, solange nur die zwei bekannten Basenames ausgeliefert werden; ACAO: *, CORP: cross-origin, no-cache.
alternatives:
  - Assets session-geschützt lassen: das Bookmarklet bricht auf fremden Seiten (Ist-Stand-Gap) — verworfen.
  - Token als Query-Parameter im script-src: Token in URL/History, kein Vorteil — verworfen.
consequences: Ein statisches, versionsgestempeltes Bundle ist ohne Login lesbar; es enthält keine Notizen und keine Secrets.
```

```
DECISION D6 — SSRF-Härtung
context: targetRefusal() prüft heute nur Protokoll, Userinfo und Allowlist; ein allowlisteter Host kann auf 127.0.0.1 oder 169.254.169.254 zeigen.
choice: checkTarget() löst DNS auf, klassifiziert jede Adresse mit classifyAddress(), blockt loopback/link-local/metadata/reserved immer, lässt private nur bei exaktem --viewer-allow-Eintrag zu und prüft jeden Redirect-Hop erneut.
alternatives:
  - Nur Allowlist: DNS-Rebinding und Metadaten-Ziele bleiben offen — verworfen.
  - Connection-Pinning: größerer Umbau (eigener Agent/Lookup), bleibt Follow-up — zurückgestellt.
consequences: Interne Ziele brauchen einen exakten Allowlist-Eintrag; Wildcards decken keine privaten Adressen ab; TOCTOU-Fenster zwischen DNS-Check und fetch bleibt (dokumentiert).
```

```
DECISION D7 — CLI-Pflicht für --viewer-port
context: --viewer ohne Port würde den Viewer wieder auf dem Hub-Port oder auf einem stillen Default servieren.
choice: --viewer ohne explizites --viewer-port ist ein Nutzungsfehler (viewer_port_required); --viewer-port 0 ist für Tests erlaubt.
alternatives:
  - Kompatibilitätsmodus mit Warnung: hält die unsichere Topologie als Default am Leben — verworfen.
  - Default 8788: ein stiller zweiter Port kann kollidieren und die Origin-Entscheidung verwässern — verworfen.
consequences: Breaking Change für 0.13.0-Deployments; CHANGELOG und docs/VIEWER.md nennen den Ein-Zeilen-Umzug.
```

```
DECISION D8 — --viewer-origin statt --viewer-public-url
context: --viewer-public-url bezeichnete bisher die öffentliche Origin des Viewers auf dem Hub-Port; jetzt ist es die Origin des zweiten Listeners.
choice: --viewer-origin ist der neue Name; --viewer-public-url bleibt für ein Release als Alias mit Warnung; ohne explizite Origin wird sie nach listen() aus Bind-Adresse und Port abgeleitet.
alternatives:
  - Beide Namen dauerhaft parallel: zwei Wahrheiten — verworfen.
  - Nur ableiten: hinter TLS/Reverse-Proxy falsch (http statt https, interner Port) — verworfen.
consequences: Ein Breaking-freier Alias für ein Release; bei Wildcard-Bind (0.0.0.0/::) ist --viewer-origin Pflicht.
```

```
DECISION D9 — Cookie-Attribute und Host-Isolation
context: Cookies sind nicht port-isoliert; SameSite=Lax ist für same-origin-Schreibvorgänge nötig, blockiert aber cross-site POST.
choice: bp_viewer bleibt HttpOnly, SameSite=Lax, Path=<base>, Secure nur bei https-Origin; gleicher Hostname wie der Hub erzeugt die Warnung viewer_cookie_shared_host.
alternatives:
  - SameSite=None: breitere Angriffsfläche und Secure-Zwang — verworfen.
  - Harter Fehler bei gleichem Hostnamen: bricht Lab-Setups, obwohl AC 5 nur eine andere Origin verlangt — verworfen.
consequences: Echte Cookie-Isolation erfordert einen anderen Hostnamen; die Doku nennt das als empfohlene Produktionskonfiguration.
```

```
DECISION D10 — CORS
context: Der Hub darf die Viewer-Origin nicht als CORS-Origin vertrauen; das Bookmarklet braucht auf fremden Seiten dennoch einen Weg zu /notes.
choice: --cors darf die Viewer-Origin nicht nennen (Nutzungsfehler); die Viewer-Fläche beantwortet nur für /notes* einen Header-Token-Preflight, reflektiert den Aufrufer-Origin, ohne Allow-Credentials, mit Vary: Origin.
alternatives:
  - Gar kein CORS auf der Viewer-Fläche: Bookmarklet-Schreibpfad bricht — verworfen.
  - --cors auf der Viewer-Fläche wiederverwenden: würde die Hub-CORS-Vokabel und Credentials vermischen — verworfen.
consequences: Eine bewusst enge, dokumentierte CORS-Ausnahme; sie autorisiert nichts, weil der Token im Header die Grenze bleibt.
```

```
DECISION D11 — RunningServer und Lifecycle
context: Zwei Listener müssen gemeinsam starten und schließen.
choice: RunningServer.viewer ist optional; startHub bindet beide, bevor es zurückkehrt; schlägt der zweite Bind fehl, wird der erste geschlossen; close() schließt beide und wirft den ersten Fehler nach dem zweiten close.
alternatives:
  - Lazy viewer start: ein halb gestarteter Hub wäre sichtbar — verworfen.
  - close() nur für den Hub: Leak eines Listeners — verworfen.
consequences: Startfehler sind atomar; Tests können beide Ports mit 0 binden.
```

```
DECISION D12 — Host-Gate, Proxy, TLS
context: Der Viewer-Listener kann loopback oder im Netz gebunden sein; hinter einem Reverse Proxy muss der öffentliche Hostname akzeptiert werden.
choice: Viewer-Context bekommt eigenes bind und hostAliases (Loopback + Hostname aus --viewer-origin); X-Forwarded-Proto wird nur von Loopback-Peers vertraut; non-loopback + http erzeugt eine Warnung.
alternatives:
  - Host-Gate auf der Viewer-Fläche abschalten: DNS-Rebinding auf den Listener — verworfen.
  - X-Forwarded-Proto immer vertrauen: ein entfernter Client könnte Secure-Cookies/Origin fälschen — verworfen.
consequences: Reverse-Proxy-Setups brauchen --viewer-origin und einen Loopback-Proxy; die Doku nennt das Muster.
```

## 7. Sicherheit

### 7.1 Was eine eigene Origin kauft — und was nicht

**Kauft:**

- Der Hub-Port liefert keinen Viewer-Inhalt mehr; ein proxied Dokument kann `/admin*`, `/mcp`, `/journal`, `/config` und `--root` nicht same-origin erreichen.
- Ein `bp_viewer`-Cookie autorisiert auf dem Hub-Port nichts; die Viewer-Session ist surface-scoped.
- Der Admin-Secret-Vergleich bleibt auf der Hub-Origin; proxied JS kann das Secret nicht aus einem Formular auf der eigenen Origin lesen.
- Ein XSS im Target läuft auf der Viewer-Origin, nicht auf der Hub-Origin; die Admin-/MCP-Fläche ist eine Origin-Grenze entfernt.

**Kauft nicht:**

- Keine Sandbox: proxied JS läuft weiterhin mit der Viewer-Origin und kann die Viewer-Session same-origin nutzen. Der Viewer bleibt eine Operator-Surface, kein Sandboxing-Mechanismus.
- Keine Cookie-Isolation bei gleichem Hostnamen (nur anderer Port); Cookies sind nicht port-isoliert.
- Keine Trennung von Netzwerk/Prozess: beide Listener teilen den Prozess und den Store. Ein Kompromittieren der Viewer-Origin über die Session ist ein Kompromittieren der Notizen, die diese Session sehen darf.
- Keine automatische TLS-Isolation: `Secure` hängt an der öffentlichen Origin, nicht an der Bind-Adresse.

### 7.2 SSRF-Härtung

`checkTarget()` ist die einzige Zielprüfung; `proxyTarget()` ruft sie vor dem Fetch **und** vor jedem Redirect-Hop auf.

Regeln:

1. Nur `http:`/`https:`; keine Userinfo; absolute URL.
2. Host muss `hostAllowed()` erfüllen (exakt oder `*.suffix`).
3. Ist der Host ein IP-Literal: `classifyAddress()`.
   - `public` → erlaubt.
   - `private` → nur erlaubt, wenn der Host **exakt** (kein `*.`) in `--viewer-allow` steht und `allowPrivateExact !== false`.
   - `loopback`, `link-local`, `metadata`, `reserved`, `invalid` → immer abgelehnt.
4. Ist der Host ein Name: `createDnsResolver()` (Timeout 2 s), **jede** aufgelöste Adresse wird nach denselben Regeln wie in Punkt 3 klassifiziert. Eine einzige unzulässige Adresse lehnt das Ziel ab (fail-closed); `private` ist auch hier nur bei exaktem Allowlist-Eintrag zulässig.
5. `forbiddenOrigins` (Viewer-Origin) wird abgelehnt, damit der Proxy sich nicht selbst als Ziel wählt.
6. Jeder Redirect-Hop durchläuft dieselbe Prüfung; `redirect: "manual"`.
7. Größe (`VIEWER_MAX_BYTES`), Timeout (`VIEWER_FETCH_TIMEOUT_MS`), Redirect-Anzahl (`VIEWER_MAX_REDIRECTS`) und Content-Type bleiben unverändert.

Nicht abgedeckt: TOCTOU zwischen DNS-Auflösung und tatsächlichem Verbindungsaufbau (DNS-Rebinding). Echtes Connection-Pinning (eigener `lookup`/Agent, der die geprüfte Adresse verwendet) ist ein Follow-up und wird hier nicht vorgetäuscht.

### 7.3 CORS

- Hub-Fläche: `--cors` unverändert. Ein expliziter `--cors`-Wert, der normalisiert der Viewer-Origin entspricht, ist ein Nutzungsfehler (`cors_viewer_origin`). `--cors '*'` bleibt an ein Client-Credential gebunden (ADR-0.12-S1).
- Viewer-Fläche: kein allgemeines CORS. Nur `OPTIONS {base}/notes*` mit `Origin` und `Access-Control-Request-Headers: x-bluepencil-viewer` wird beantwortet:
  - `Access-Control-Allow-Origin: <reflektierter Origin>`
  - `Access-Control-Allow-Methods: GET, POST, PATCH, OPTIONS`
  - `Access-Control-Allow-Headers: Content-Type, X-Bluepencil-Viewer`
  - `Access-Control-Max-Age: 600`
  - `Vary: Origin`
  - **kein** `Access-Control-Allow-Credentials`
- Die eigentliche Antwort auf eine cross-origin-Bookmarklet-Anfrage trägt dieselbe reflektierte `Allow-Origin`-Kopfzeile; sonst könnte der Browser die Antwort nicht lesen.
- Der Preflight wird — wie die Hub-CORS-Regel — **vor** `authorize()` beantwortet, aber ausschließlich für `{base}/notes*`; ein `OPTIONS` auf einer anderen Route bleibt der normale 404/405.
- Der reflektierte Origin ist keine Autorisierung: die Grenze ist der `x-bluepencil-viewer`-Token. Ein Origin ohne Token kann schreiben/lesen, soweit die Route ohne Credential überhaupt antwortet — auf der Viewer-Fläche ist das fail-closed ein 401.

### 7.4 Host-Gate, Reverse Proxy, TLS

- Der Viewer-Context hat sein eigenes `bind`. `hostRefusal()` prüft damit die Viewer-Bindung, nicht die Hub-Bindung.
- `hostAliases` des Viewer-Contexts enthält den Hostnamen aus `--viewer-origin`. Ein Loopback-Bind hinter einem Reverse Proxy akzeptiert damit `Host: view.example.com`.
- `X-Forwarded-Proto` wird nur berücksichtigt, wenn `request.remote` loopback ist **oder** `viewer.origin` explizit gesetzt ist (dann gilt die explizite Origin). Ein entfernter Client kann die Secure-Entscheidung nicht fälschen.
- `publicOrigin()` liefert `viewer.origin`, wenn gesetzt; sonst `http://<Host-Header>` (Loopback-Vertrauen wie oben).
- Warnungen beim Start:
  - `viewer_cookie_shared_host`: Viewer-Origin-Hostname == Hub-Origin-Hostname.
  - `viewer_non_loopback_insecure`: Viewer-Bind nicht loopback und `viewer.origin` beginnt mit `http:`.
  - `viewer_public_url_deprecated`: `--viewer-public-url` verwendet.
- Der Hub bleibt plain HTTP. TLS terminiert extern; die Doku nennt ein nginx-Muster (Proxy auf `127.0.0.1:<viewer-port>`, `Host` und `X-Forwarded-Proto` gesetzt).

### 7.5 Restrisiken

1. **Gleicher Hostname, anderer Port:** `bp_viewer` wird auch an den Hub gesendet; der Hub ignoriert ihn, aber echte Cookie-Isolation fehlt. Empfehlung: eigener Hostname.
2. **Proxied JS ist same-origin mit der Viewer-Session:** es kann die Session nutzen. Das ist die dokumentierte Operator-Surface-Eigenschaft; die Allowlist und die kurze TTL begrenzen sie.
3. **DNS-Rebinding/TOCTOU:** der Check ist ein Pre-Check, kein Connection-Pinning.
4. **Last-writer-wins ohne Lock:** ein externer Schreiber (Editor, zweiter Prozess) zwischen `loadNotes` und `persist` kann eine Änderung verlieren. Innerhalb des Prozesses ist der Pfad synchron; ein File-Lock ist Follow-up.
5. **Ticket-Diebstahl vor Einlösung:** 60 s, single-use, 192 Bit; kein Peer-Binding. Ein Angreifer mit dem Ticket erhält eine Session.
6. **Secret in der Hub-URL (`?k=`):** History/Proxy-Logs. Header-Variante wird empfohlen; `no-referrer`/`no-store` gesetzt.

## 8. CLI-Vertrag

### 8.1 Flags, Env, Defaults

| Flag | Env | Default | Bedeutung |
|---|---|---|---|
| `--viewer` | `BLUEPENCIL_VIEWER=1` | aus | aktiviert die Viewer-Fläche |
| `--viewer-assets <dir>` | `BLUEPENCIL_VIEWER_ASSETS` | — | Pflicht bei `--viewer`; Verzeichnis mit den Element-Bundles |
| `--viewer-allow <host[,host]>` | `BLUEPENCIL_VIEWER_ALLOW` | — | Pflicht bei `--viewer`; exakte Hosts oder `*.suffix` |
| `--viewer-ttl <seconds>` | — | 28800 (8 h), max 604800 | Session-Lebensdauer |
| `--viewer-host <host>` | `BLUEPENCIL_VIEWER_HOST` | `--host` | Bind-Adresse des zweiten Listeners |
| `--viewer-port <port>` | `BLUEPENCIL_VIEWER_PORT` | — | **Pflicht bei `--viewer`**; 0..65535; ≠ `--port` |
| `--viewer-origin <url>` | `BLUEPENCIL_VIEWER_ORIGIN` | abgeleitet aus Bind+Port | öffentliche Origin, z. B. `https://view.example.com`; keine Pfad/Query/Fragment |
| `--viewer-public-url <url>` | `BLUEPENCIL_VIEWER_PUBLIC_URL` | — | **deprecated Alias** für `--viewer-origin` (eine Release-Periode) |

`--viewer-host`, `--viewer-port`, `--viewer-origin`, `--viewer-public-url` ohne `--viewer` sind Nutzungsfehler (`viewer_flags_without_viewer`), keine stillen No-Ops.

### 8.2 Validierung

| Fall | Antwort aus `parseHubArgs` |
|---|---|
| `--viewer` ohne `--viewer-port` | `--viewer requires --viewer-port <port> (viewer_port_required) — the viewer must not share the hub port` |
| `--viewer-port` nicht ganzzahlig / außerhalb 0..65535 | `--viewer-port must be an integer between 0 and 65535 (got …)` |
| `--viewer-port` == `--port` | `--viewer-port must differ from --port (viewer_port_conflict)` |
| `--viewer-origin` kein absolutes http(s) ohne Pfad/Query/Fragment | `--viewer-origin must be an absolute http(s) origin without path, query or fragment (viewer_origin_invalid)` |
| `--viewer-origin` == Hub-Origin (normalisiert) | `--viewer-origin must differ from the hub origin (viewer_origin_is_hub_origin)` |
| `--viewer-host` ist `0.0.0.0`/`::` und `--viewer-origin` fehlt | `--viewer-origin is required when --viewer-host binds a wildcard address (viewer_origin_required)` |
| `--viewer-*` ohne `--viewer` | `--viewer-host/--viewer-port/--viewer-origin require --viewer (viewer_flags_without_viewer)` |
| `--cors <viewer-origin>` | `--cors must not name the viewer origin (cors_viewer_origin)` |
| `--viewer-public-url` gesetzt | akzeptiert, `viewer_public_url_deprecated`-Warnung auf stderr |

`--viewer-port 0` ist zulässig (Tests, ephemeral). Die tatsächliche Origin wird nach `listen()` aus der gebundenen Adresse und dem tatsächlichen Port abgeleitet, sofern `--viewer-origin` fehlt. Die `cors_viewer_origin`-Prüfung vergleicht deshalb nur dann, wenn die Viewer-Origin zum Parse-Zeitpunkt bekannt ist (explizites `--viewer-origin` oder fester `--viewer-port`); bei `--viewer-port 0` ohne explizite Origin entfällt sie.

### 8.3 Rückwärtskompatibilität

**Entscheidung: harter Fehler statt Kompatibilitätsmodus.**

- `--viewer` ohne `--viewer-port` bricht den Start sichtbar. Ein Kompatibilitätsmodus würde die unsichere Topologie (Viewer auf dem Hub-Port) als Default fortschreiben und AC 5 für Bestandsdeployments faktisch aushebeln.
- Der Umzug ist eine Zeile: `--viewer-port 8788` (oder ein anderer freier Port) ergänzen; bei TLS/Proxy zusätzlich `--viewer-origin https://view.example.com`.
- `--viewer-public-url` bleibt als Alias, damit ein vorhandenes Script nicht sofort bricht; es wird eine Release-Periode gewarnt.
- Alte Bookmarklets, die auf die Hub-Origin zeigen, schreiben nach dem Upgrade nicht mehr (der Hub akzeptiert keine Viewer-Session). Sie müssen aus der Viewer-Shell neu kopiert werden. Das ist ein bewusster Bruch und gehört in `CHANGELOG` (`Changed`/`Removed`) und `docs/VIEWER.md`.
- Der Cookie-Name `bp_viewer` und der Header `x-bluepencil-viewer` bleiben, damit die Layer- und Bookmarklet-Verträge stabil sind.

### 8.4 `RunningServer` und `close()`

- `RunningServer.viewer` ist nur gesetzt, wenn `--viewer` konfiguriert ist.
- `startHub()` bindet zuerst den Hub-Listener, dann den Viewer-Listener. Schlägt der Viewer-Bind fehl, wird der Hub-Listener geschlossen, `activeJournal` auf `null` zurückgesetzt und der Fehler weitergereicht (kein halber Start, kein verwaister Journal-Verweis).
- `close()` schließt beide Listener mit `Promise.allSettled`; nach dem Warten auf beide wird der erste Fehler geworfen. Ein Fehler beim Schließen des einen verhindert nicht das Schließen des anderen.
- Die Startzeile nennt beide Adressen (sofern `--viewer`), ohne Secrets:
  `bluepencil server: "<name>" on http://host:port<base> — viewer on https://view.example.com<base> — N note(s), …`
- `--quiet` unterdrückt die Fortschrittszeile, nicht die Warnungen aus §7.4.

## 9. Kompatibilität und Migration

| Artefakt | Änderung |
|---|---|
| `docs/VIEWER.md` | Neufassung: eigene Origin, `--viewer-host/-port/-origin`, Launcher `{base}/viewer/start`, Routen-Matrix, Cookie-/TLS-Abschnitt, Migrationshinweis für Bookmarklets. |
| `docs/DOCKER.md` | Viewer-Abschnitt: zweiter Port, `command:`-Beispiel, Reverse-Proxy-/TLS-Muster, `BLUEPENCIL_VIEWER_*`. |
| `README.md` | Viewer-Blurb: „eigene Origin“ statt „hub's own origin“; AC-5-Hinweis. |
| `CHANGELOG.md` | Nächster Minor: `Changed` (`--viewer` braucht `--viewer-port`; `/viewer?k=` → `/viewer/start?k=`), `Added` (zweiter Listener, Ticket, SSRF), `Security`. |
| `Dockerfile` | `EXPOSE 8787` bleibt; der Viewer-Port ist dynamisch und wird nicht als Default exponiert. Kommentar/Doku nennt das Zwei-Port-Muster. |
| `docker-compose.yml` | Optionaler, auskommentierter zweiter Port-Mapping-Eintrag `127.0.0.1:${BLUEPENCIL_VIEWER_PORT:-8788}:8788` und ein `command:`-Beispiel; kein Viewer-Default. |
| `docker/entrypoint.sh` | Keine Logikänderung nötig: `BLUEPENCIL_VIEWER_*` wird von Docker geerbt; Viewer-Flags kommen über `"$@"` oder Env. Optional eine Banner-Zeile, wenn `BLUEPENCIL_VIEWER_PORT` gesetzt ist. |
| `docs/REQUIREMENTS.md` | Neuer Anforderungsblock „Hub-Viewer“ (Vorschlag unten). Es gibt heute keine Viewer-FR. |
| `spec/` | Wird durch `npm run spec` aus `docs/REQUIREMENTS.md` regeneriert; nicht handeditieren. |
| `AGENTS.md` / `.meta-config/project.yaml` | Keine Strukturänderung; `server/viewer*.ts` existieren bereits. |
| Extension | Keine Änderung. Die CSP-`connect-src`-Ausnahme der Extension betrifft den Hub, nicht den Viewer. |
| Federator/MCP | Keine Änderung; die Viewer-Fläche serviert `/mcp` nicht. |

### 9.1 Vorschlag für `docs/REQUIREMENTS.md`

Die ID-Vergabe erfolgt durch `requirements`; dies ist Anforderungstext, keine vergebene FR-Nummer. Einordnung in die bestehende Kategorie „Hub-Betrieb, Auth & Extension-Relay“.

1. **Viewer-Origin:** `--viewer` startet einen zweiten HTTP-Listener auf einer eigenen Origin; die Viewer-Inhaltsrouten sind auf dem Hub-Port nicht erreichbar (404).
2. **Gemeinsamer Store:** Über die Viewer-Origin geschriebene Notizen sind ohne Neustart für Hub-`/notes`, `/bundle`, `/journal` und `/mcp` sichtbar; es gibt genau eine Store- und Journal-Instanz.
3. **Routen-Minimalität:** Die Viewer-Origin serviert Shell, `/view`, Assets, Bookmarklet, `notes*`, `sessions`, `bundle`, `health`; sie serviert nicht `admin*`, `mcp`, `journal`, `config`, `viewer/start` oder `--root`.
4. **Fail-closed-Auth:** Notiz-Routen auf der Viewer-Origin verlangen eine Viewer-Session, auch ohne `--auth-secret`; der Hub-Port akzeptiert keine Viewer-Session.
5. **Ticket-Austausch:** Das Admin-Secret wird nur auf der Hub-Origin geprüft (Throttle, konstantzeitiger Vergleich) und gegen ein kurzlebiges Einmal-Ticket getauscht; die Viewer-Origin sieht das Secret nie.
6. **Cookie-Scope:** `bp_viewer` ist `HttpOnly`, `SameSite=Lax`, `Path=<base>`, `Secure` bei https; gleicher Hostname wie der Hub wird gewarnt.
7. **SSRF:** Ziele werden per DNS aufgelöst und IP-klassifiziert; loopback/link-local/metadata/reserved sind immer blockiert, private nur bei exaktem Allowlist-Eintrag; jeder Redirect-Hop wird erneut geprüft.
8. **Startvalidierung:** `--viewer` ohne `--viewer-port`, Port-Gleichheit, ungültige Origin, Viewer-Origin == Hub-Origin und Viewer-Flags ohne `--viewer` sind Nutzungsfehler.
9. **Betrieb:** `RunningServer` meldet beide Listener und schließt beide; ein fehlgeschlagener zweiter Bind hinterlässt keinen laufenden ersten Listener.

## 10. Teststrategie (AC-5-Matrix)

Alle Tests laufen ohne neue Runtime-Dependency. Listener-Tests binden `port: 0`/`viewer.port: 0` und schließen in `afterEach`.

| ID | Gegeben | Wenn | Dann | Ebene | Bezug |
|---|---|---|---|---|---|
| T1 | `startHub({ port: 0, viewer: { port: 0, … } })` | Start | `RunningServer.server` und `.viewer.server` lauschen; Ports sind verschieden und tatsächlich | Integration | AC 5 |
| T2 | Viewer konfiguriert | `GET {hub}/viewer`, `/view`, `/viewer/assets/…`, `/viewer/bookmarklet.txt` | jeweils `404` auf dem Hub-Port, vor jeder Auth | Integration | AC 5 |
| T3 | Viewer konfiguriert, keine Session | `GET {viewer}/viewer` | `401`, kein `Set-Cookie` | Integration | AC 5, R4 |
| T4 | Launcher mit korrektem `?k=` | `GET {hub}/viewer/start?k=…` → Folge dem 302 | 302 auf `{viewerOrigin}{base}/viewer?ticket=…`; Viewer löst Ticket ein, setzt `HttpOnly; SameSite=Lax; Path=<base>`, `Secure` genau bei https; 302 auf saubere `/viewer`; Replay des Tickets → 401 | Integration | R5, R6 |
| T5 | Viewer ohne `--auth-secret` | `POST {viewer}/notes` ohne Session; mit Cookie | ohne Session `401`; mit Session `200`; Hub-`GET /notes` bleibt ohne Credential offen (kein Regress) | Integration | R4 |
| T6 | Viewer-Session | `POST {viewer}/notes` | `200`; Hub-`GET /notes`, `GET /bundle` und MCP `tools/call list_notes` enthalten die Notiz; Hub-`/journal` hat genau einen Eintrag | Integration | AC 5, R2 |
| T7 | Viewer-Session | `GET {viewer}/admin`, `/admin/status`, `POST /mcp`, `/journal`, `/config`, `/` (static), `/viewer/start` | jeweils `404`; keine Notiz-/Audit-Daten im Body | Integration | R3 |
| T8 | `parseHubArgs` | `--viewer` ohne Port; Port == Hub-Port; Port 70000; Origin mit Pfad; Origin == Hub-Origin; Viewer-Flag ohne `--viewer`; `--cors` == Viewer-Origin | jeweils der dokumentierte Usage-Error-String | Unit | R8 |
| T9 | Viewer loopback gebunden, `--viewer-origin https://view.example.com` | `GET` mit `Host: evil.example`; mit `Host: view.example.com` | ersteres `403 host_not_allowed`; letzteres akzeptiert; Hub-Listener unverändert | Integration | R6, R9 |
| T10 | Allowlist `example.com`; Stub-Resolver | Ziel löst auf `127.0.0.1`, `169.254.169.254`, `10.0.0.1`, `::ffff:169.254.169.254` | `403 target_not_allowed` **vor** jedem `fetch` (Fetch-Stub zählt 0 Aufrufe) | Unit | R7 |
| T11 | Allowlist `example.com`; erster Fetch antwortet `302` auf `http://169.254.169.254/` | `GET /view?url=https://example.com` | `403`; nur der erste Fetch ist passiert; kein zweiter Hop | Unit | R7 |
| T12 | Hub mit `--auth-secret`, Request mit `bp_viewer`-Cookie an Hub-`/notes` | `GET {hub}/notes` | `401`; dieselbe Cookie an Viewer-`/notes` → `200` | Integration | R4 |
| T13 | `close()` | nach dem Schließen erneut verbinden | beide Ports verweigern; ein neuer `startHub` auf denselben Ports gelingt | Integration | R9 |
| T14 | Hub-Port belegt, Viewer-Port frei | `startHub` | wirft; der Viewer-Listener wurde nie gebunden bzw. geschlossen; kein Prozess-Leak | Integration | R9 |
| T15 | `--viewer-port 0` | Start | `RunningServer.viewer.port` ist der tatsächliche Port; `origin` ist daraus abgeleitet, sofern nicht explizit | Integration | R1, R9 |
| T16 | Bookmarklet auf fremder Origin | `OPTIONS {viewer}/notes` mit `Origin: https://app.example` und `Access-Control-Request-Headers: x-bluepencil-viewer` | `204`; `Allow-Origin` reflektiert; **kein** `Allow-Credentials`; `Vary: Origin` | Unit | R5, R8 |
| T17 | Assets | `GET {viewer}/viewer/assets/bluepencil.element.min.js` ohne Cookie | `200`, `Content-Type: text/javascript`, `ACAO: *`; unbekannter Basename → `404` | Integration | R3, Bookmarklet |

Die Matrix deckt **AC 5** vollständig ab. Die übrigen ACs von Issue #140 sind nicht Gegenstand dieses Designs und werden hier nicht neu formuliert; die Tests T4–T7/T12 sind Regressionen für die bestehenden Viewer-Eigenschaften (Session, Proxy, Injection), nicht neue ACs.

Bestehende `tests/unit/viewer.test.ts`-Fixtures werden um `tickets` (`createViewerTickets()`) und `origin` ergänzt; die bisherigen `?k=`-Fälle auf der Viewer-Fläche werden auf den Hub-Launcher (`/viewer/start`) umgestellt. Die reine `handleViewer`-Unit-Ebene bleibt testbar, weil sie den Context ohne Socket erhält.

## 11. Alternativen

| Alternative | Vorteil | Nachteil / Ablehnungsgrund |
|---|---|---|
| **A — CORS-API auf einer Origin** | Ein Listener, kein zweiter Port | Der proxied Inhalt bliebe auf der Hub-Origin; CORS mit Credentials wäre weit und fragil; AC 5 nicht erfüllt. |
| **B — Separater Hub-Prozess/Instanz** | Harte Prozessgrenze, eigenes Netz | Zwei Schreiber auf einer Store-Datei brauchen Lock/Koordination; doppeltes Journal, zwei Credentials, doppelter Betrieb; mehr Deployment-Fläche. |
| **C — Nur externer Reverse Proxy** | Kein Codeänderung, TLS gratis | Der Hub-Port bliebe Viewer-fähig; die Route-Trennung und das surface-scoped Auth fehlen; AC 5 wäre nur zufällig erfüllt, wenn der Proxy alles blockt. Bleibt als TLS-Terminierung kompatibel, ist aber kein Ersatz. |
| **D — `iframe srcdoc`/`blob:`** | Keine zweite Origin im Netz | Keine stabile Origin, Cookies/Endpoints brechen, Layer-Schreibpfad unzuverlässig. |
| **E — Nur Extension/Bookmarklet** | Kein Proxy, kein SSRF | Erfüllt den Viewer-Anwendungsfall nicht (Seiten ohne Extension, Operator ohne Installation); AC 5 bleibt offen. |

## 12. Impact- und Risikozonen

### 12.1 Blast Radius

- `server/hub.ts`: Listener-Lifecycle, `respond()`-Surface-Verzweigung, CLI-Parser, `RunningServer`, Startbanner. Größte Änderung; die Datei ist bereits groß (`respond`/`startHub`/`parseHubArgs`).
- `server/handler.ts`: `HandlerContext.surface`, `authorize()`-Verzweigung, `gateRequest`-Reihenfolge. Sicherheitskritisch: eine falsche Verzweigung öffnet Notizen.
- `server/viewer.ts`: Tickets, Cookie, Routen, SSRF. Neue Async-Policy.
- `server/admin.ts`: `verifyOperatorSecret`-Refactor; muss das Verhalten von `adminGate` exakt erhalten (429/Retry-After, Budget).
- `server/cors.ts`: neue, enge Bookmarklet-Reflexion; Hub-CORS unverändert.
- `src/federation/net-policy.ts`: nur Wiederverwendung; keine API-Änderung.
- Tests/Docs/Docker: breit, aber mechanisch.

### 12.2 Kopplungs-Hotspots

- **`authorize()`** ist der einzige Ort, an dem Viewer-Session, Client-Credential und Surface zusammenlaufen. Jede Änderung braucht T5/T12.
- **`respond()`** ist die einzige Stelle, die Reihenfolge (Host-Gate → Launcher → Viewer-Door → Journal → Static → Auth → Body → Store → MCP → Router) festlegt. Ein falscher Einschub kann eine Route auf der falschen Fläche sichtbar machen.
- **`parseHubArgs()`** ist die einzige Quelle der CLI-Wahrheit; Validierung und HELP müssen synchron bleiben.
- **`verifyOperatorSecret()`** ist die einzige Secret-Vergleichsstelle; zwei Implementierungen wären eine zweite Wahrheit.

### 12.3 Migration

- Bestandsdeployments mit `--viewer` brechen beim Start, bis `--viewer-port` ergänzt ist. Das ist beabsichtigt und dokumentiert.
- Alte Bookmarklets müssen neu ausgestellt werden.
- Reverse-Proxy-Setups brauchen `--viewer-origin`; ohne sie leitet der Launcher auf die interne Bind-Adresse.
- Docker-Nutzer brauchen ein zweites Port-Mapping und ein `command:`/Env für die Viewer-Flags.

### 12.4 Größenklasse

**XL (Architectural).** Begründung:

- Mehr als 20 Dateien inklusive Tests, Docs, Docker und Requirements.
- Öffentlicher CLI-Contract (neue Pflicht-Flags) und ein Sicherheits-Boundary (Surface-Auth) ändern sich.
- Mehr als eine Subsystemgrenze: Listener-Lifecycle, Auth, Store/Journal, CORS, SSRF, CLI, Betrieb.
- Kein Schema-/Datenmodell-Bump; die Datenform bleibt unverändert.

Empfohlene Umsetzungsschnitte (kein Plan, nur Designhinweis):

1. **P1 — Surface, zweiter Listener, `RunningServer`, Routen-Matrix, Launcher/Ticket, Cookie.** Das ist der Kern von AC 5 und muss als zusammenhängender Schritt landen; ein Zwischenzustand mit `?k=` auf der Viewer-Origin wäre eine zusätzliche Secret-Exposition und wird vermieden.
2. **P2 — SSRF-Härtung:** `checkTarget`, DNS-Auflösung, IP-Klassifikation, Redirect-Hops.
3. **P3 — CLI-Validierung, Migration, Docs, Docker, Requirements, CHANGELOG.**

Tests reisen mit der jeweiligen Welle.

## 13. Offene Fragen (vom Nutzer zu entscheiden)

1. **Private-IP-Policy für `--viewer-allow`.** Empfehlung: private Ziele nur bei **exaktem** Allowlist-Eintrag (kein `*.`), ohne neues Flag; loopback/link-local/metadata/reserved bleiben immer blockiert. Alternative: ein explizites `--viewer-allow-private`-Flag (mehr Betriebsfläche, klarere Absicht). Bitte bestätigen, ob die exakte-Eintrag-Regel ausreicht.
2. **Breaking CLI.** Empfehlung: `--viewer` ohne `--viewer-port` ist ein harter Nutzungsfehler (kein Kompatibilitätsmodus). Das bricht 0.13.0-Deployments sichtbar, ist aber die einzige Variante, die AC 5 nicht wieder aufweicht. Bitte bestätigen.
3. **Secret-Transport am Launcher.** Empfehlung: `?k=` bleibt (Kompatibilität), `x-bluepencil-admin` wird die dokumentierte Empfehlung; optional zusätzlich ein POST-Formular auf der Hub-Origin. Soll das POST-Formular in den Scope, oder reichen `?k=` + Header?
4. **Host-Isolation.** Empfehlung: gleicher Hostname mit anderem Port ist erlaubt, erzeugt aber die Warnung `viewer_cookie_shared_host`; ein anderer Hostname wird für Produktion empfohlen. Soll ein gleicher Hostname ein harter Fehler sein (stärkere Isolation, bricht Lab-Setups)?
5. **Requirement-ID.** Der Anforderungsblock in §9.1 braucht eine FR-Nummer; die Vergabe liegt bei `requirements` (die nächste freie ID, vermutlich im Bereich 22). Bitte bestätigen, dass der Block in die Kategorie „Hub-Betrieb, Auth & Extension-Relay“ gehört.

## 14. Trace-Anker

```
spec-id: SPEC-viewer-origin
```

Dieser Wert wird von `concept-specifier` unverändert in die Spec übernommen; der Plan referenziert ihn. Das Design selbst implementiert keinen Code.

## Revision 2026-11-08 (Issue #144)

> Datiert Nachtrag. Der Text oben bleibt als Beleg des Standes vom 2026-11-06 **unverändert**; geändert wird nur, was hier ausdrücklich als entschieden benannt ist.

**Offene Frage 3 („Secret-Transport am Launcher", §13.3) ist entschieden.** Die Empfehlung vom 2026-11-06 lautete: `?k=` bleibt (Kompatibilität), `x-bluepencil-admin` wird die dokumentierte Empfehlung, „optional zusätzlich ein POST-Formular auf der Hub-Origin". Entschieden am 2026-11-08 mit Issue #144 (Varianten C + B): **das POST-Formular auf der Hub-Origin ist im Scope**; `?k=` bleibt und wird **nicht** deprecated.

Begründung in Kürze (vollständig in der neuen Spec, §2):

- Seit 0.14.0 ist `{base}/viewer/start` der **einzige** Einstieg auf der Hub-Origin — der alte Link `{base}/viewer?k=<secret>` ist `404`. `?k=` ist damit nicht mehr der Kompatibilitäts-Notbehelf, sondern der einzige Weg, den ein Browser gehen kann.
- Damit landet das Secret regelhaft in Adresszeile, History, `Referer` und Access-Logs — genau das Restrisiko, das die damalige Empfehlung als Ausnahme benannt hatte.
- Der `401`-Pfad des Launchers ist JSON („set an `x-bluepencil-admin` header"), für einen Browser also eine Sackgasse ohne Weg zur Anmeldung.
- Das Sicherheitsdelta ist neutral bis positiv: das Secret reist im Body statt in der URL, bleibt auf der Hub-Origin, wird von derselben Funktion (`verifyOperatorSecret()`) mit demselben `admin`-Budget geprüft, und die Antwort trägt weiter `referrer-policy: no-referrer` und `cache-control: no-store`. Neu hinzu kommt ein CSRF-Gate (`Origin`/`Sec-Fetch-Site`) und ein 8-KiB-Body-Limit.

Verbindlich ist `docs/specs/2026-11-08-viewer-launcher-entry.md` (`spec-id: SPEC-viewer-launcher-entry`). **Unverändert** bleiben D1–D12 sowie die offenen Fragen 1, 2, 4 und 5.
