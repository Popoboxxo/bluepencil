# Origin im Note-Kontext und per-Origin-Storage — Design

> spec-id: SPEC-origin-note-context
> Status: Entwurf (Spec-Input für `concept-specifier`)
> Bezug: SEC-13 (high), SEC-14, SEC-15, SEC-20; G5 = B, G6 = A, G9 = A — SEC-19/G8 nur als Abgrenzung (**S2**, nicht S1)
> Zielrelease: 0.12.0 (0.x-Minor, Breaking erlaubt)

## 1. Problem und Scope

Die Extension hält die Notizen aller Websites in einem Blob (`bluepencil:default:v1`). Der
Bridge-Relay erlaubt `get` für beliebige Keys sowie `set`/`remove` für diesen Blob; jedes
Page-Skript — auch Third-Party — kann nach einer Aktivierung die Notizen aller Origins lesen,
überschreiben und löschen (SEC-13). Dazu kommt der Credential im Page-Kontext (SEC-14).

**S1** macht `origin` zum Note-Scope, partitioniert den Extension-Storage pro Origin, erhält
Legacy-Notizen als `origin: null` und ergänzt eine Cross-Site-Review-Seite (Legacy read-only; die
Seite schreibt ausschließlich den `v2`-Store für Assign/Undo). Enthalten
ist außerdem die Relay-Verweigerung für `bluepencil:settings` (Voraussetzung für G6 = A).
SEC-14 (vollständige Credential-Entfernung), SEC-15 (Tab-Bindung) und SEC-20/G9
(`optional_host_permissions`) sind Companion-Stages, die **S1 ebenfalls umsetzt**; ihre Verträge
stehen in `docs/specs/2026-11-02-s1-extension-trust-boundary.md`.

**Nicht S1:** SEC-19/G8 (Route-/Query-Semantik, `route="url"` = Pfad-only,
`url-with-query`/`readRoute`/`settings.includeQuery`) gehört nach Decisions §7 zu **S2**. Dieses
Design beschreibt diese Semantik nicht; S1 pinnt nur, dass die Extension `route="url"` schreibt.

## 2. Datenmodell

### 2.1 Feldplatzierung

DECISION D1 — Feldplatzierung
context: `origin` muss für jede Note existieren, auch für Text-Notes ohne `context`.
choice: `Note.origin?: string | null`, ausschließlich auf `Note`.
alternatives: nur `CapturedContext.origin` (fehlt bei `context: null`); beide (doppelte Kanonisierung/Validierung, Drift).
consequences: ein Feld, ein Pfad; `NotePatch` bleibt ohne `origin`; CLI/MCP/Agent tragen `null`.
```ts
// src/core/model.ts
export type NoteOrigin = string | null;
export interface Note { /* ... */ origin?: string | null; }
export interface NoteDraft { origin?: string | null; }   // create, Default null
export interface NoteFilter { origin?: string | null; }  // undefined = kein Filter, null = unassigned
// NotePatch: bewusst KEIN origin — Scope ist unveränderlich.
```

Der Typ ist optional, damit 0.11-Dokumente weiter validieren; die kanonische Form emittiert
`origin` **immer** (`null` inklusive). `originOf(note) = note.origin ?? null` ist der einzige
Lesezugriff. `createNote` defaultet auf `null`, `migrateNote` füllt fehlende Werte mit `null`.

**CLI/MCP/Agent:** `origin: null`. MCP `create_note`/`list_notes` akzeptieren `origin` optional;
ein Agent kann eine Ziel-App benennen, muss aber nicht. **Patch:** `origin` fehlt in
`PATCH_FIELDS`; ein PATCH damit antwortet `400 invalid_payload`. **Create:** `origin` ist in
`NOTE_DRAFT_FIELDS` erlaubt und wird normalisiert. **Merge:** `divergingFields` meldet `origin`;
`mergeNoteInto` setzt `origin = existing.origin ?? incoming.origin` — eine zugewiesene Note
wechselt den Scope nie, eine unassigned Note kann per Upsert nachträglich zugewiesen werden.

### 2.2 Normalisierung

DECISION D2 — Normalisierung
context: Origin kommt aus Browser, Import, Hub und MCP und muss überall identisch aussehen.
choice: eine headless `normaliseOrigin`: nur http(s), WHATWG-`URL`, Default-Port elidiert, Opakes → `null`.
alternatives: Rohstring speichern (Case-/Port-Duplikate, instabile Keys); Host separat normalisieren (zweite Wahrheit).
consequences: stabile Keys und Vergleiche; `file:`/Extension-Pages sind bewusst unassigned.
Regeln: Scheme/Host kleingeschrieben; Default-Port 80/443 elidiert, andere Ports bleiben; IPv6 in
Klammern; IDN → Punycode; Userinfo/Pfad/Query/Fragment verworfen; Länge ≤ 512 Zeichen.
`blob:` wird akzeptiert, wenn der geparste Origin http(s) ist. `file:`, `data:`, `about:`,
`chrome-extension:`, `javascript:`, `""`, `"null"` und falsche Typen → `null`.

| Eingabe | Gespeichert |
|---|---|
| `https://Example.COM:443/app?x=1` | `https://example.com` |
| `http://example.com:80` | `http://example.com` |
| `http://example.com:8080` | `http://example.com:8080` |
| `https://example.com:80` | `https://example.com:80` |
| `https://bücher.example` | `https://xn--bcher-kva.example` |
| `http://[::1]:8787` | `http://[::1]:8787` |
| `blob:https://example.com/uuid` | `https://example.com` |
| `file:///tmp/x`, `data:…`, `chrome-extension://…` | `null` |
| `"null"`, `""`, `undefined`, `42` | `null` |

**Asymmetrie:** Hub-Create ist Trust-Boundary und verweigert einen nicht-nullbaren String mit
`400 invalid_origin`; `migrateNote`/`migrateBundle` degradieren ihn zu `null` (wie unbekannte
Enums). **Privacy:** Der Origin benennt interne Hostnamen, ist aber weniger sensibel als die
Query. Er gehört in JSON (Round-Trip/Scope), als `Origin:`-Bullet in Markdown und in die
agent-facing Ausgabe. Redaktion ist nicht Teil von S1; `anchor.route` exponiert bereits Pfade.

### 2.3 Kanonische Ordnung

DECISION D3 — Kanonische Ordnung
context: `origin` braucht eine feste Key-Position und eine Sortierung im Bundle.
choice: Key nach `updatedAt`, vor `sessionRef`; Sortierung origin → route → priority → createdAt → id; `origin: null` immer emittiert.
alternatives: route-first beibehalten (Multi-Site-Bundles mischen Sites); origin ans Ende (Provenienz zerrissen).
consequences: ein Hunk pro Site; `hashBundle` ändert sich für jedes Bundle; Review-Order bleibt unberührt.
`compareNotes` nutzt `originOf(a)` (null als `""`), dann die bestehende Route-first-Komposition.
`order.ts` bleibt priority-first (needs_decision → feedback → open → done); Origin ist dort Filter,
kein Sortierschlüssel. **BP-07/CQ-02 im selben Change:** `canonical.ts` importiert
`reviewPriority` und einen neuen exportierten `compareCodeUnits` aus `order.ts`; die lokalen
Kopien entfallen, nur die origin-/route-first-Komposition bleibt lokal.

## 3. Storage-Modell

### 3.1 Key-Layout

DECISION D4 — Key-Layout
context: per-Origin-Storage braucht adressierbare, kollisionsfreie Keys.
choice: `bluepencil:v2:<origin>` (plain, lesbar); `origin === null` → kein Key.
alternatives: `bluepencil:<fnv64(origin)>:v1` (nicht kollisionsresistent, offline grindbar); SubtleCrypto-Hash (auf `http:` kein Secure Context).
consequences: Hostname steht im Key (nur Extension/DevTools sichtbar); keine Kollision, keine Truncation.
`chromeStorageKey(instance?)` bleibt für explizit benannte Instanzen unverändert und wird von der
Extension nicht mehr verwendet. Es gibt **keinen Catch-All-Bucket** für `null`.

### 3.2 Wer leitet den Key ab

Der **isolated-world Bridge** ist autoritativ: er liest `window.location` und ruft
`relayPageStorage(area, envelope, location)`. Ein vom Page-Skript mitgeschickter `origin` oder Key
wird nie übernommen; es gibt **keinen** Origin-Parameter mehr. Die Page-Seite (Bootstrap) darf
denselben Key nur als Hinweis an den Adapter geben; der Relay leitet den Key selbst über
`storageKeyForLocation(location)` ab und verweigert Abweichungen (`foreign_key`).

Relay-Vertrag: `get` nur mit `keys === [derivedKey]` (String oder Ein-Element-Array); `get(null)`,
`get([])` und Wildcards werden verweigert. `set` nur mit genau einem Key = `derivedKey`;
`remove` nur mit genau `[derivedKey]`. `bluepencil:settings`, `bluepencil:ui:*`,
`bluepencil:default:v1` und der Assign-Sidecar `bluepencil:assign:<origin>` sind nie `derivedKey`
und damit unerreichbar. Fehlertexte nennen die Namespace-Regel, nie den Key-Wert. Opaker Origin →
`{ok:false, code:"opaque_origin"}`; der Adapter degradiert in den Memory-Store.

### 3.3 Legacy-Blob

DECISION D5 — Legacy
context: `bluepencil:default:v1` enthält Notizen vieler Sites ohne Origin.
choice: unverändert liegen lassen; nur die Review-Seite liest; Seiten weder lesen noch schreiben; `origin: null`.
alternatives: beim ersten Start aufteilen (Origin unbekannt → falsche Zuordnung); löschen (Datenverlust); Import-Dialog (G5 verbietet).
consequences: Legacy-Notizen sind im Page-Overlay **unsichtbar** (auch nicht read-only) und nur auf
der Review-Seite sichtbar; kein Datenverlust. Grund für die Unsichtbarkeit: der Legacy-Blob hat kein
`origin` und enthält alle Sites — ein Page-Kontext-Lesezugriff wäre nicht filterbar und würde SEC-13
wieder öffnen. Diese sichtbare Regression ist in CHANGELOG und `docs/EXTENSION.md` zu nennen.
Beim ersten 0.12-Start sieht die Layer einen leeren Per-Origin-Store. Eine Legacy-Note gewinnt
einen Origin auf genau drei Wegen: (1) einen Upsert mit explizitem Origin
(`existing.origin ?? incoming.origin`), (2) Neuanlage auf einer Seite, (3) **copy-only Assign** auf
der Review-Seite — eine Kopie unter derselben Note-ID im Ziel-`v2`-Store; der Legacy-Blob
`bluepencil:default:v1` wird dabei nie geschrieben, die Review-Seite dedupliziert nach ID, Undo
löscht die `v2`-Kopie (RVW-01). Bundle-Import erhält `origin`; fehlt es, wird es `null` —
kein Re-Homing auf den importierenden Origin.

## 4. Migration und Kompatibilität

DECISION D6 — Kein Schema-Bump
context: 0.11- und 0.12-Dokumente müssen sich gegenseitig lesen können.
choice: `SCHEMA_VERSION = 1`; additives optionales Feld; `migrateNote` füllt `null`.
alternatives: Version 2 (0.11 verweigert dann das ganze Bundle); Pflichtfeld (alte Bundles/`parseBundle` brechen).
consequences: 0.11 verwirft `origin` beim Re-Export; 0.12 liest 0.11 verlustfrei als `null`.
`migrate.ts` bleibt bei Version 1; `upgradeNote` kopiert `origin` über `normaliseOrigin(doc.origin)`
und schreibt `null`, wenn es fehlt. Kein neuer Migrationsschritt.

| Leser \ Schreiber | 0.11 ohne `origin` | 0.12 mit `origin` |
|---|---|---|
| **0.11** | ok | akzeptiert; `migrateNote` kopiert nur bekannte Felder, `origin` geht beim Re-Export verloren |
| **0.12** | ok; `origin` = `null` | ok |
| **Hub 0.11 + Client 0.12** | ok | Create mit `origin` → `400 unknown field`; `GET /notes?origin=` wird ignoriert — gemischte Versionen sind **breaking** (RVW-15), kein Field-Shaping im Transport |
| **Hub 0.12 + Client 0.11** | ok; `null` | ok |
| **Extension-Downgrade** | — | **Nicht unterstützt** (RVW-14): 0.11 erlaubt im Relay `get` auf jeden Key und kann `bluepencil:v2:<origin>` lesen — Confidentiality-Regression für migrierte `v2`-Daten, kein Datenverlust; Mitigation nur Doku (CHANGELOG + `docs/EXTENSION.md`: vor dem Downgrade den Extension-Storage leeren), kein Lock |

Der Hub akzeptiert Notizen ohne `origin` (→ `null`), verweigert `origin` im PATCH und filtert
`GET /notes?origin=` (`null`/leer = unassigned).

## 5. Cross-Site-Review-Seite

DECISION D7 — Review-Ansicht
context: G5 verlangt eine Cross-Site-Ansicht, ohne den Shared-Blob wieder einzuführen.
choice: eigene Extension-Page liest `chrome.storage.local` direkt und aggregiert im Speicher.
alternatives: Page-Overlay mit Relay-Enumeration (öffnet genau das SEC-13-Loch); kombinierter Blob (neue Kopie aller Notizen).
consequences: keine Page-Skripte erreichen die Aggregation; Legacy read-only, die Review-Seite
schreibt ausschließlich den `v2`-Store (Assign kopiert, Undo löscht die `v2`-Kopie).
Neu: `extension/review.html` + `extension/src/review.ts`, verlinkt aus der Options-Seite. Die Page
liest `chrome.storage.local.get(null)`, filtert mit `parseNotesStorageKey` und nimmt den Legacy-Key
dazu. `aggregateOriginStores(entries)` ist pure und unit-testbar: Gruppen
`{origin, legacy, key, notes, mismatched, error?}`, echte Origins aufsteigend, Legacy zuletzt;
jede Note als `{note, keyOrigin, mismatch, duplicate}`. `bluepencil:assign:*` ist kein Bestandteil
der Aggregation (Assign-Provenienz, siehe §6). Notizen werden über `migrateNote` gelesen, aber nicht
zurückgeschrieben. Eine unlesbare Gruppe bleibt als Gruppe mit `error.code === "corrupt_blob"`
sichtbar, die übrigen bleiben lesbar. Kein Netzwerk, keine Page-Relay-Nutzung, Rendering nur über
`textContent` (FR-9.3), CSP bleibt `script-src 'self'`. Weicht `note.origin` vom Key-Origin ab,
gewinnt der Key und die Abweichung wird über `mismatch`/`mismatched` markiert.

## 6. Interfaces

```ts
// src/core/origin.ts (neu) — Normalisierung; NoteOrigin nur als `import type`
export function normaliseOrigin(value: unknown): NoteOrigin;
export function parseOriginInput(value: unknown):
  | { ok: true; origin: NoteOrigin }
  | { ok: false; code: "invalid_origin" };
export function originOf(note: Pick<Note, "origin">): NoteOrigin;
export function currentOrigin(location?: { origin?: unknown } | null): NoteOrigin;
// src/data/origin.ts (neu) — Storage-Key-Helfer
export const LEGACY_STORAGE_KEY = "bluepencil:default:v1";
export const NOTES_STORAGE_PREFIX = "bluepencil:v2:";
export const ASSIGN_PROVENANCE_PREFIX = "bluepencil:assign:";
export function chromeStorageKeyForOrigin(origin: NoteOrigin): string | null;
export function parseNotesStorageKey(
  key: string,
): { kind: "origin"; origin: string } | { kind: "legacy" } | null;
export function storageKeyForLocation(
  location: { origin?: unknown } | null | undefined,
): string | null;
// src/adapters/chrome-storage.ts — Key: explizit → storageKeyForLocation(globalThis.location) → null
export function createChromeStorageAdapter(options?: {
  key?: string;
  area?: ChromeStorageArea | null;
}): Adapter;
// extension/src/storage-relay.ts
export type PageStorageReply =
  | { ok: true; value?: Record<string, unknown> }
  | { ok: false;
      code: "opaque_origin" | "foreign_key" | "invalid_envelope" | "unavailable" | "storage_failure";
      error: string };
export async function relayPageStorage(
  area: PageStorageArea | undefined,
  envelope: PageStorageEnvelope,
  location: { origin?: unknown } | null | undefined,
): Promise<PageStorageReply>;
// extension/src/review.ts (neu)
export interface OriginNoteView {
  note: Note; keyOrigin: NoteOrigin; mismatch: boolean; duplicate: boolean;
}
export interface OriginGroup {
  origin: NoteOrigin; legacy: boolean; key: string;
  notes: OriginNoteView[];
  mismatched: string[];
  error?: { code: "corrupt_blob"; message: string };
}
export function aggregateOriginStores(entries: Record<string, unknown>): OriginGroup[];
// src/data/legacy-assign.ts (neu) — copy-only Assign, Provenienz-Sidecar, CAS für Undo
export interface AssignPlan {
  targetKey: string; targetOrigin: string; provenanceKey: string;
  baseText: string; baseProvenance: Record<string, string>;
  notes: Note[]; moved: string[]; skipped: string[];
}
export function planAssignToOrigin(
  entries: Record<string, unknown>,
  request: { ids: readonly string[]; origin: unknown; now?: string },
): AssignToOriginResult;
export function commitAssign(state: AssignState, io: AssignIo): Promise<AssignCommitResult>;
export interface UndoPlan {
  targetKey: string; targetOrigin: string; provenanceKey: string;
  baseText: string; remainingText: string;
  baseProvenance: Record<string, string>; remainingProvenance: Record<string, string>;
  removed: string[]; skipped: string[];
}
export function planUndoAssign(
  entries: Record<string, unknown>,
  request: { ids: readonly string[]; origin: unknown },
): UndoResult;
export function commitUndoAssign(state: UndoState, io: AssignIo): Promise<UndoCommitResult>;
// SEC-19/G8 (Route-/Query-Semantik, `readRoute`, `settings.includeQuery`, `url-with-query`)
// ist S2 und deshalb KEIN Bestandteil dieses Interfaceblocks.
// extension/src/handoff.ts
export function elementAttributesFor(
  settings: AttributeSource,
  browserLanguage?: string,
): Record<string, string>;   // schreibt in S1 unverändert `route="url"`
```

Die vollständigen Signaturen von `planAssignToOrigin`/`commitAssign`/`planUndoAssign`/
`commitUndoAssign` stehen bindend in `docs/specs/2026-11-02-s1-extension-trust-boundary.md` §2 C3
(`AssignPlan`/`UndoPlan`, Fehlercodes, `stale_plan`, Sidecar). Hier sind nur die Namen und die
Tatsache festgehalten, dass Assign copy-only ist und Undo eine Provenienz-CAS-Basis braucht.

**G8 = A (SEC-19) — S2, nicht S1.** Die Regeln (`url` = nur `location.pathname`,
`url-with-query` = `pathname` + gefilterte `search`, Allow-/Deny-Listen, `route-from` als
Host-Verantwortung) gehören zu **S2** und sind dort spezifiziert (Decisions §7). Dieses Design
legt nur fest, dass die Extension in S1 weiter `route="url"` schreibt; es definiert weder
`readRoute` noch `includeQuery`.

**Hub/MCP:** `NOTE_DRAFT_FIELDS` und `FILTER_KEYS` erhalten `origin`; `PATCH_FIELDS` nicht. MCP
`create_note`/`list_notes` erhalten `origin` optional. **Bundle:** `BundleSummary` erhält
`origins: string[]` und `unassigned: number`; Markdown erhält ein `Origin:`-Bullet, die
route-first-Gruppierung (FR-7.1) bleibt.

## 7. Sicherheitseigenschaften (Testpflicht)

1. Page-Skripte können den Storage-Origin nicht spoofen: der Relay leitet den Key ausschließlich
   aus dem `location`-Like ab, das die Bridge aus dem isolated world übergibt.
2. Fremde Keys sind unerreichbar, auch wenn der Angreifer den Ziel-Key kennt.
3. `get("bluepencil:settings")`, `get(null)`, `get([])`, `bluepencil:ui:*` und
   `bluepencil:assign:*` werden verweigert.
4. `bluepencil:default:v1` ist aus der Page weder lesbar noch schreibbar; Legacy-Notizen erscheinen
   deshalb nach dem Upgrade nicht mehr im Page-Overlay (sichtbare Regression, dokumentiert).
5. Ein opaker Origin erzeugt keinen gemeinsamen Bucket; der Store degradiert nach Memory.
6. Die Review-Seite ist nur als Extension-Page erreichbar (`externally_connectable` und
   `web_accessible_resources` bleiben leer) und rendert text-only.
7. Der Note-`origin` ist Provenienz, keine Access-Control-Entscheidung: ein falsch gelabeltes
   Note-Feld ändert den Storage-Key nicht. Der Key ist die Grenze.

## 8. Teststrategie (red-first)

1. `extension-storage-relay.test.ts`: per-Origin-Isolation; fremder Key; Settings-get;
   Legacy-get/set/remove; `get(null)`; opaker Origin. Der heutige Legacy-writable-Test wird invertiert.
2. `chrome-storage-crossorigin.test.ts`: die zentrale Eigenschaft dreht sich von „teilt über
   Origins“ auf „teilt **nicht** über Origins“; zwei Origins, ein `chrome.storage`, getrennte Keys.
3. `origin.test.ts` (neu): Normalisierungstabelle, Längenlimit, `parseNotesStorageKey`-Round-Trip,
   `chromeStorageKeyForOrigin(null) === null`.
4. `data.test.ts`/canonical: Key-Position, `origin: null` wird emittiert, origin-first → route →
   priority, byte-identisch, `hashBundle` deterministisch.
5. `migrate.test.ts`/schema: altes Bundle → `null`; unbekannter Typ → `null`; Hub-Create mit
   ungültigem String → `invalid_origin`; PATCH mit `origin` → 400.
6. `merge.test.ts`: `origin` in `divergingFields`; Upsert `existing.origin ?? incoming.origin`;
   zugewiesener Origin bleibt unverändert.
7. `adapter.test.ts`: `NoteFilter.origin` inkl. `null`-Filter.
8. *(S2, nicht S1)* `embed-attributes.test.ts`: `url` = Pfad-only; `url-with-query` = Pfad+Query;
   Deny-/Allow-Liste; `route-from` unverändert.
9. *(S1)* `extension-handoff.test.ts`: die Extension schreibt `route="url"`; kein `includeQuery`.
10. `review.test.ts` (neu): Gruppierung, Settings/UI/Sidecar ignoriert, Legacy zuletzt, Key-Origin
    gewinnt, `mismatch`/`duplicate`/`corrupt_blob`.
11. Server-Handler: Create normalisiert; PATCH verweigert; Filter `origin`; Import füllt `null`.
12. `smoke:ext`: A annotieren, B aktivieren → B sieht A nicht; Page-Skript versucht Legacy-/Fremd-Key,
    `assign:*` und Settings → verweigert; Reload-Persistenz auf A; Review-Seite listet A, B, Legacy
    read-only; **das Page-Overlay zeigt keine Legacy-Notiz**; Legacy-Blob bleibt unverändert; Undo
    entfernt nur die nachweislich kopierte `v2`-Notiz.
13. `legacy-assign.test.ts` (neu): copy-only (Legacy byte-identisch), Provenienz-Sidecar, Undo nur
    für provenierte IDs, `stale_plan` für Assign und Undo, `corrupt_source` für jede korrupte
    `v2`-Gruppe.

## 9. Risiken, Größe und offene Fragen

**Bundle-Größe (Q8):** IIFE 44,2/45 kB, Element 47,0/48 kB. S1 ergänzt `normaliseOrigin`, ein Feld
in `createNote`/`canonicalNote`/`schema`/`bundle`, den Layer-Stamp und die Comparator-Dedupe —
geschätzt 0,3–0,6 kB gzip, also potenziell über dem 0,8–1,0 kB Headroom. **C1 und C2 landen beide
im Element- und IIFE-Bundle** (`chrome-storage.ts` wird über Bootstrap/Store gebündelt); die
Schätzung ist nur für C1 belegt. Empfehlung: `npm run size` mit beiden Contracts messen, Budget
**nicht präventiv** anheben; nur bei tatsächlichem Fehlschlag offen mit gemessener
Zahl erhöhen. Die NFR-3-Retune nach dem Voice-Ausbau absorbiert S1 anschließend. Die Review-Seite
ist ein eigenes Extension-Asset und braucht ein eigenes kleines Budget oder eine Größennotiz.

**Risiko 1 — Settings-Verweigerung ohne SEC-14:** Solange der Token über
`__bluepencilConfig__` und das `token`-Attribut in die Page gelangt, ist die Relay-Verweigerung
kein vollständiger Schutz, aber korrekt und fail-closed. **Default:** S1 landet sie; SEC-14 muss
vor dem 0.12-Release folgen.

**Risiko 2 — Downgrade (RVW-14):** 0.11 erlaubt im `relayPageStorage` `get` auf jeden Key;
nach einem Downgrade kann ein Page-Skript `bluepencil:v2:<origin>` lesen, SEC-13 ist für die
migrierten `v2`-Daten wieder offen. **Default:** Downgrade ist nicht unterstützt; das ist eine
Confidentiality-Regression ohne Datenverlust. Mitigation ist reine Doku (CHANGELOG +
`docs/EXTENSION.md`: „clear extension storage before downgrading“), kein Lock-Mechanismus.

**Risiko 3 — Import mit fremdem Origin:** Ein Bundle kann `origin` behaupten. **Default:** Origin
ist Provenienz; der Hub autorisiert weiterhin über Credentials, nicht über Origin.

**Entschieden 2026-11-02 (RVW-01) — „Assign to origin“ für Legacy-Notizen:** **copy-only**.
Die Note wird unter derselben Note-ID in den Ziel-Store kopiert; der Legacy-Blob
`bluepencil:default:v1` wird nie geschrieben. Die Review-Seite dedupliziert nach ID,
Undo = Löschen der `v2`-Kopie.

**Offene Fragen (max. 5, je mit Default):**

2. Origin-Redaktion in Exporten (`--redact-origin`)? **Default:** nein in S1; dokumentieren, später
   nachziehen, wenn Exporte die Organisation verlassen.
3. `PATCH` für Re-Homing erlauben? **Default:** nein; nur `existing.origin ?? incoming.origin`.
4. Caller-supplied `origin` auf `POST /notes` akzeptieren? **Default:** ja, normalisiert; niemals
   aus `Host`/`Origin`-Header ableiten.
5. Review-Seite in S1 editieren/löschen? **Default:** nein, Legacy read-only; die Seite schreibt
   ausschließlich den `v2`-Store (Assign kopiert, Undo löscht die `v2`-Kopie); freies Bearbeiten oder
   Löschen von Notizinhalten ist eine eigene destruktive Funktion.

## 10. Non-Goals

- Keine Verschlüsselung oder zusätzliche At-Rest-Isolation; `chrome.storage.local` bleibt
  profile-scoped und für DevTools/andere Extensions lesbar.
- Keine automatische Legacy-Migration in Per-Origin-Stores, kein Import-Dialog, keine Löschung.
- Kein Cross-Origin-Sync oder Merge in der Extension; die Review-Seite aggregiert nur.
- Keine Origin-basierte Autorisierung auf dem Hub (Auth bleibt Credential-basiert).
- Kein Entfernen von `anchor.route`; die Route bleibt der Seitenpfad.
- Keine Änderung der Review-Reihenfolge in `order.ts` (weiter priority-first).
- Kein Schema-Version-Bump und kein neuer Migrationsschritt.
- Keine neuen Runtime-Dependencies, kein `crypto.subtle`-Zwang.
- Keine Route-/Query-Semantik (SEC-19/G8): `readRoute`, `settings.includeQuery`,
  `route="url-with-query"` und Query-Allow/Deny sind **S2**, nicht Teil dieses Designs.
- SEC-14, SEC-15 und SEC-20/G9 sind Companion-Stages: nicht Teil dieses Interfaceblocks, aber
  von S1 umgesetzt (Verträge in der S1-Spec).

## Revisionen

- 2026-11-02 — RVW-14: Downgrade auf 0.11 ist nicht unterstützt und für `v2`-Daten eine Confidentiality-Regression; Mitigation nur Doku, kein Lock (Daten bleiben erhalten).
- 2026-11-02 — RVW-01: „Assign to origin“ ist copy-only (Kopie unter gleicher Note-ID, Legacy-Blob nie geschrieben, Dedupe nach ID, Undo = `v2`-Kopie löschen).
- 2026-11-02 — **RVW-07/09/10/13/17 (Review 2): §6 an die S1-Spec angeglichen** — `relayPageStorage(area, envelope, location)` statt eines Origin-Parameters; `src/core/origin.ts` (Normalisierung/`parseOriginInput`) getrennt von `src/data/origin.ts` (Storage-Key-Helfer, `LEGACY_STORAGE_KEY`); `OriginGroup`/`OriginNoteView` mit `key`, `mismatched`, `error` und `duplicate`; `createChromeStorageAdapter` leitet den Key aus `location` ab. §3.2/§5/§7/§8 nachgezogen. Kein „wird später nachgezogen“.
- 2026-11-02 — **Produktentscheid Legacy-Sichtbarkeit:** Legacy-Notizen (`origin: null`) sind im Page-Overlay unsichtbar (nicht read-only) und nur auf der Review-Seite sichtbar; Grund ist die fehlende Filterbarkeit des Legacy-Blobs (sonst SEC-13 wieder offen). D5, §7 und die Doku-Pflichten sind entsprechend geschärft.
- 2026-11-02 — **RVW3-08 (Review 3): S1/S2-Teilung nachgezogen.** SEC-19/G8 (Route-/Query-Semantik) ist **S2**, nicht S1: §1 nennt es als Nicht-S1, §6 enthält weder `readRoute` noch `settings.includeQuery`/`url-with-query`, §8 kennzeichnet die Route-Tests als S2, §10 führt es als Non-Goal. §9 präzisiert, dass **C1 und C2** im Element/IIFE-Bundle liegen. Kein offener Nachzug für die S1-Contracts.
