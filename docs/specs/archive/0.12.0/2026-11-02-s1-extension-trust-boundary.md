# S1 — Extension Trust Boundary 0.12.0 — Spec

> Status: Entwurf
> spec-id: SPEC-s1-extension-trust-boundary
> Upstream-Anker (unverändert): SPEC-origin-note-context
> Verbindlich: `docs/specs/2026-11-02-origin-note-context-design.md` (D1–D7, §6 revidiert 2026-11-02), `docs/plans/audit-remediation-decisions.md` (G4=A, G5=B korr. 2026-11-02, G6=A, G8=A, G9=A, G13=A; RVW-01/14/15/16)
> Voraussetzung: S4 / WP 0.1 — ohne diese Baseline ist nur der Finding-/Gate-Anker gültig (§1.3)
> Findings: SEC-13 (high), SEC-14, SEC-15, SEC-20, CQ-05, CQ-06 — SEC-19 nur als Randbedingung, SEC-21 nicht in S1 (§7)
> Revision 2026-11-02a: zweite Fassung nach `…-review.md` (RVW-01…RVW-26)
> Revision 2026-11-02b: dritte Fassung nach `…-review-2.md` (RVW2-01…RVW2-20); Design §6 korrigiert; **Produktentscheid 2026-11-02: Legacy-Notizen (`origin: null`) sind im Page-Overlay unsichtbar, nur read-only auf der Review-Seite** (§5.2, AC-59)
> Revision 2026-11-02c: vierte Fassung nach `…-review-3.md` (RVW3-01…RVW3-11, Info RVW3-12/13/14); G9-Teststrategie bindend festgelegt (§2 C5), Test-Grant-Manifest statt roter Smoke-Checks; Design §1/§6/§10 auf die S1/S2-Teilung gezogen (SEC-19 → S2)
> Revision 2026-11-02d: fünfte Fassung nach `…-review-4.md` (RVW4-01…RVW4-11); **ein** Test-Grant-Build für alle drei mountenden E2E-Suiten, Manifest-/Guard-Invertierung in C4b statt C5 (Boundary-Commit), `smoke-review.mjs` für C3, RC-1…RC-3 als erzwungener Release-Schritt
> Revision 2026-11-02e: sechste Fassung nach `…-review-5.md` (RVW5-01…RVW5-06); Ordnungsassertion **zweigeteilt** (Quelle = Unit-Test ohne `dist`; Build = `smoke:webstore` hinter `Build extension (MV3)`, fehlende Datei = benannter Fehler), `extension/smoke.mjs` als **dritte benannte Ausnahme** mit Abschnitts-Eigentum, C7 getrennt in `C7-code` (vor C6) und `C7-docs` (letzter Commit)

## 1. Problem / Ziel / Nicht-Ziele

### 1.1 Problem

Die Extension hält die Notizen aller Websites in einem Blob (`bluepencil:default:v1`), der Page-Relay erlaubt `get` auf beliebige Keys sowie `set`/`remove` auf diesen Blob (SEC-13). Zusätzlich liegt der Hub-Credential in drei page-lesbaren Stellen (SEC-14), `runtime.onMessage` adressiert den aktiven Tab statt den sendenden (SEC-15), und die All-Sites-Permission plus persistente MAIN-World-Registrierung sind breiter als nötig (SEC-20).

### 1.2 Ziel und Nicht-Ziele

**Ziel.** `origin` wird Note-Scope, der Extension-Storage wird pro Origin geschlüsselt, Legacy-Notizen bleiben als `origin: null` erhalten — **sichtbar nur read-only auf der Review-Seite, nicht im Page-Overlay** (§5.2). Das Credential verlässt die Page nie, Seitenzugriff läuft über `activeTab` und optionale Host-Permissions. Danach kann kein Page-Skript Notizen einer anderen Site lesen, schreiben oder löschen und keinen Hub-Request an ein fremdes Ziel fälschen. `origin` ist dabei **Provenienz, keine Autorisierung**: eine Page kann das `origin`-Feld ihrer eigenen Notiz behaupten; die Grenze ist der Storage-Key.

**Nicht-Ziele.** Keine Verschlüsselung, kein Cross-Origin-Sync, keine automatische Legacy-Zuordnung, **kein Schreiben des Legacy-Blobs** (auch nicht durch Assign, §2 C3), kein page-lesbarer Legacy-Zugriff (bewusst: er wäre nicht filterbar), keine Origin-basierte Hub-Autorisierung, kein Schema-/Bundle-Bump, keine Runtime-Dependency, keine Route-/Query-Semantik (S2), keine Hub-Auth-Mechanik (S3).

### 1.3 Harte Voraussetzung: S4 / WP 0.1

Die Requirement-Baseline **S4 / WP 0.1** (`FR-6.9` neu gefasst, `FR-14.2`/`FR-14.3`, `FR-16.1`, `FR-17…FR-20`, `FR-21` withdrawal, NFR-3-Budget; Entscheidungsprotokoll §5) muss `APPROVED` sein, bevor S1 implementiert wird. `docs/REQUIREMENTS.md` führt FR-6.9 heute noch als „The extension carries either credential …“ und FR-16.1 ohne `origin`; ein Trace auf diesen Wortlaut wäre falsch.

**Bis S4 landet** binden alle ACs ausschließlich an die Gates `G5`/`G6`/`G9` und an Finding-IDs (`SEC-13`, `SEC-14`, `SEC-15`, `SEC-20`, `CQ-05`, `CQ-06`). Die FR-Spalte in §1.4 ist eine Zielangabe, keine Behauptung über den heutigen Requirement-Text.

### 1.4 Betroffene Anforderungen

| ID | Bezug in S1 | Status |
|---|---|---|
| FR-2.2 | `origin` ist die Site-Dimension neben `anchor.route` (Pfad); beide bleiben getrennt | unverändert |
| FR-6.9 | Ziel: die Extension legt den Credential nie in die Page; der Service Worker setzt den Header | neu gefasst in S4 |
| FR-9.4 | Keine Netzwerkziele außer dem konfigurierten Endpoint; Host-Zugriff nur per Grant | unverändert |
| FR-14.2/14.3 | Bundle-Import erhält `origin`; Merge-Regel `existing ?? incoming` | in S4 ergänzt |
| FR-15.3 | Genau eine Note-Logik in `src/data`; die Extension komponiert nur | unverändert |
| FR-16.1 | `create_note`/`list_notes` akzeptieren `origin` optional | in S4 ergänzt |
| NFR-3 | Budget unverändert (G4 = A); **C1 und C2** landen im Element- und IIFE-Bundle (`chrome-storage.ts` wird über `bootstrap.ts` und `src/core/store.ts` gebündelt), die Schätzung +0,3–0,6 kB gzip ist nur für C1 belegt | Messung beider Contracts mit `npm run size` vor dem Release-Cut, keine präventive Erhöhung (RVW3-09) |
| NFR-4 | Keine neuen Dependencies; kein `crypto.subtle` | unverändert |
| NFR-8/NFR-9 | Kein Datenverlust; additives optionales Feld, `SCHEMA_VERSION = 1` | unverändert |
| NFR-17 | `origin` an fester Key-Position; Sortierung deterministisch | unverändert |

`§19` existiert weder in `docs/REQUIREMENTS.md` noch in `docs/ARCHITECTURE.md` (geprüft) — kein Bezug.

## 2. Interface Contracts

Typen und Signaturen sind bindend; Rümpfe sind Implementierung. Alle neuen Module sind DOM-frei, außer den ausdrücklich als Extension-Page benannten. **Ein File, ein Contract** (RVW-07): jedes unten genannte Modul steht in genau einem Eigentümerset (§7); C4a/C4b sind zwei Schritte desselben Contracts C4.

### C1 — `origin`-Datenmodell

```ts
// src/core/model.ts
export type NoteOrigin = string | null;
export interface Note { /* … */ origin?: NoteOrigin; }        // additiv, optional
export interface NoteDraft { /* … */ origin?: NoteOrigin; }   // Default null
export interface NoteFilter { /* … */ origin?: NoteOrigin; }  // undefined = kein Filter, null = unassigned

// src/core/origin.ts (neu) — Normalisierung; importiert NoteOrigin nur als `import type` (kein Laufzeit-Zyklus)
export function normaliseOrigin(value: unknown): NoteOrigin;                 // total, nie ein Fehler
export function parseOriginInput(value: unknown):
  | { ok: true; origin: NoteOrigin }
  | { ok: false; code: "invalid_origin" };                                   // strikt für Hub/MCP-Grenzen
export function originOf(note: Pick<Note, "origin">): NoteOrigin;
export function currentOrigin(location?: { origin?: unknown } | null): NoteOrigin;

// src/data/order.ts
export function compareCodeUnits(a: string, b: string): number;               // ersetzt die lokale Kopie in canonical.ts

// src/data/bundle.ts
export interface BundleSummary { /* … */ origins: string[]; unassigned: number; }

// src/adapters/http.ts (nur `toQuery`) — interner Vertrag, nicht exportiert
// origin === undefined → kein Parameter; origin === null → `origin=null`; String → kanonisch verbatim
function toQuery(filter?: NoteFilter): URLSearchParams;
```

`normaliseOrigin`-Regeln: nur `http(s)` (plus `blob:` mit http(s)-Innenorigin), Scheme/Host lowercase, Default-Port 80/443 elidiert, IDN → Punycode, Userinfo/Pfad/Query/Fragment verworfen, Länge ≤ 512, sonst `null`.

`parseOriginInput`-Regeln: `undefined`/`null`/`""`/`"null"` → `{ok:true, origin:null}`; jeder String, den `normaliseOrigin` auf einen nicht-null-Wert abbildet, → `{ok:true, origin:<normalisiert>}`; jeder **weitere** String, den `normaliseOrigin` auf `null` abbildet (`"42"`, `"file:///x"`, `"data:…"`, `"about:blank"`, `"chrome-extension://…"`, `"javascript:…"`, Whitespace-only, > 512 Zeichen), sowie jeder andere Typ (`42`, `{}`, `true`, `[]`) → `{ok:false, code:"invalid_origin"}`. Damit ist „ungültig“ von „unassigned“ unterscheidbar (RVW-08). `validateNote` akzeptiert **fehlendes/`undefined`**, `null` und jeden String, für den `normaliseOrigin(v) === v` gilt; jeder andere Wert ist ein Issue (RVW2-13).

`PATCH_FIELDS` bleibt ohne `origin` (Scope unveränderlich) → `400 invalid_payload`. `NOTE_DRAFT_FIELDS` und `FILTER_KEYS` erhalten `origin`. Kanonische Key-Position: **nach `updatedAt`, vor `sessionRef`**, immer emittiert (`null` inklusive). Sortierung: `origin` (null als `""`) → `route` → `priority` → `createdAt` → `id`.

**Drei dokumentierte Konsequenzen.** (1) Der kanonische Hash **jedes** Bundles ändert sich, weil `origin: null` immer emittiert wird (RVW-02, CHANGELOG-Pflicht). (2) `canonical.ts` importiert `reviewPriority` und `compareCodeUnits` aus `order.ts`; die lokalen Kopien (`compareStrings`, `priorityOf`) entfallen. Damit nutzt **die kanonische Ordnung** eine Comparator-Quelle; die übrigen Code-Unit-Vergleiche in `bundle.ts`, `core/export/markdown.ts` und `federation/aggregate.ts` bleiben und sind ausdrücklich **Wave 4 / WP 4.2** (RVW2-10). (3) `cloneNote` (`src/core/adapter.ts`) kopiert `timing` tief (`{ ...note.timing }`), damit eine Assign-Kopie kein Timing-Objekt mit der Quelle teilt (RVW2-19).

### C2 — Per-Origin-Extension-Storage

```ts
// src/data/origin.ts (neu, C2) — Storage-Key-Helfer; importiert normaliseOrigin/currentOrigin aus src/core/origin.ts
export const LEGACY_STORAGE_KEY = "bluepencil:default:v1";
export const NOTES_STORAGE_PREFIX = "bluepencil:v2:";
export const ASSIGN_PROVENANCE_PREFIX = "bluepencil:assign:";
export function chromeStorageKeyForOrigin(origin: NoteOrigin): string | null;
export type ParsedNotesKey = { kind: "origin"; origin: string } | { kind: "legacy" };
export function parseNotesStorageKey(key: string): ParsedNotesKey | null;
export function storageKeyForLocation(location: { origin?: unknown } | null | undefined): string | null;

// src/adapters/chrome-storage.ts (C2, geändert)
export interface ChromeStorageAdapterOptions { key?: string; area?: ChromeStorageArea | null; /* … bestehend */ }
export function createChromeStorageAdapter(options?: ChromeStorageAdapterOptions): Adapter;

// extension/src/storage-relay.ts
export type PageStorageErrorCode =
  | "opaque_origin" | "foreign_key" | "invalid_envelope" | "unavailable" | "storage_failure";
export type PageStorageReply =
  | { ok: true; value?: Record<string, unknown> }
  | { ok: false; code: PageStorageErrorCode; error: string };
export async function relayPageStorage(
  area: PageStorageArea | undefined,
  envelope: PageStorageEnvelope,
  location: { origin?: unknown } | null | undefined,
): Promise<PageStorageReply>;
```

`PageStorageEnvelope` behält `op/keys/items`; ein mitgeschicktes `origin` oder `key` ist **kein** Feld: der Bridge-Check (`checkPageEnvelope`, C7-code) lehnt es als `foreign_field` ab, der Relay lehnt es bei direktem Aufruf als `invalid_envelope` ab. Ein `keys`-Wert, der weder String noch String-Array ist (`null`, Objekt, Zahl), ist `invalid_envelope`; eine wohlgeformte Key-Liste, die nicht exakt `[derivedKey]` ist (leer, mehrere, Wildcard), ist `foreign_key`.

**Key-Ableitung (RVW-17).** Der Relay nimmt **keinen** Origin-Parameter. Er ruft intern `storageKeyForLocation(location)` auf, das seinerseits `chromeStorageKeyForOrigin(currentOrigin(location))` ist. Der Key entsteht damit ausschließlich aus dem übergebenen `location`-Like des isolated world; ein gespoofter `envelope.origin`, ein `envelope.key` oder ein abweichender Parameter kann keinen Fremd-Key erzeugen. `origin === null` (opak) → jeder `op` antwortet `opaque_origin`, kein Storage-Aufruf; es gibt keinen Catch-All-Bucket.

**Produktiver Adapter (RVW2-01).** `createChromeStorageAdapter` löst den Key in dieser Reihenfolge auf: explizites `options.key` (gewinnt immer) → `storageKeyForLocation(globalThis.location)` → `null`. Bei `null` berührt der Adapter `chrome.storage.local` **nicht**: `readText`/`writeText` schlagen fehl, `createJsonAdapter` degradiert nach Memory und ruft `onFallback` genau einmal; der Grund ist `{ code: "opaque_origin" }` (kein String), damit der Bootstrap die `memory-only`-Meldung ohne Parsing formatiert. `chromeStorageKey()`/`bluepencil:default:v1` wird vom Extension-Pfad **nie** gelesen oder geschrieben. Der von der Page an den Adapter gereichte Key ist ein Hinweis: weicht er vom abgeleiteten Key des isolated world ab, antwortet der Relay `foreign_key` und der Adapter degradiert (Design §3.2).

**Default-Key (RVW3-10).** Der Default ändert sich von `chromeStorageKey()` auf `storageKeyForLocation(globalThis.location)`; das ist keine Signaturänderung, aber eine Verhaltensänderung des öffentlichen Adapters (`./adapters/chrome-storage`). Ein Host, der den gemeinsamen Blob bisher über den Default nutzte, sieht seine Notizen nach dem Upgrade nicht mehr (kein Datenverlust, aber Sichtbarkeit). CHANGELOG und `docs/EXTENSION.md` nennen deshalb: „hosts that relied on the shared default must pass `key: chromeStorageKey()` explicitly“ (AC-59(g)); `chromeStorageKey()` bleibt für **explizit benannte Instanzen und Hosts** unverändert (CLI, Tests, bewusster Shared-Blob).

**Deklaration (RVW3-03).** `extension/src/bluepencil-element.d.ts` bleibt Eigentum von C2, ist aber **nicht mehr unverändert**: die Deklaration von `createChromeStorageAdapter` erhält `onFallback?: (reason: unknown) => void` und `writeFailure?: "reject" | "degrade"`. Beide existieren bereits zur Laufzeit (`src/adapters/chrome-storage.ts`, `ChromeStorageAdapterOptions`); die Deklaration wird nur vollständig. Die **öffentliche Runtime-Signatur** ist unverändert. Ohne die Ergänzung wäre der Bootstrap-Aufruf `createChromeStorageAdapter({ area, onFallback })` ein Excess-Property-Fehler und `npm run typecheck:ext` rot.

`parseNotesStorageKey` validiert den Rest **mit `normaliseOrigin` und auf kanonische Gleichheit**: `bluepencil:v2:https://A.example` oder `bluepencil:v2:https://a.example:443` liefern `null`, nicht einen Pseudo-Origin-Bucket. `LEGACY_STORAGE_KEY` → `{kind:"legacy"}`; alles andere (auch `bluepencil:assign:*`) → `null` (RVW-23).

### C3 — Legacy-Behandlung, Assign (copy-only) und Undo (provenienzbasiert)

```ts
// src/data/note-set.ts (neu; Codec aus src/adapters/memory.ts hierher verschoben, dort re-exportiert)
export function serializeNoteSet(notes: readonly Note[]): string;
export function parseNoteSet(text: string | null): Note[];      // wirft BluepencilValidationError

// src/data/legacy-assign.ts (neu, rein)
export interface AssignToOriginRequest { ids: readonly string[]; origin: unknown; now?: string }

// Sidecar: Note-ID → ISO-Zeitstempel der Kopie; pro Ziel-Origin ein Key.
export type AssignProvenance = Record<string, string>;
export function assignProvenanceKey(origin: string): string;    // `${ASSIGN_PROVENANCE_PREFIX}${origin}`
export function parseAssignProvenance(raw: unknown): AssignProvenance;   // nie ein Wurf; Nicht-Objekt → {}

export interface AssignPlan {
  targetKey: string;
  targetOrigin: string;
  provenanceKey: string;
  baseText: string;            // aktueller Ziel-Blob-Text ("" wenn der Key fehlt) — CAS-Basis
  baseProvenance: AssignProvenance;
  notes: Note[];               // Klone der Legacy-Notizen, nur `origin` gesetzt
  moved: string[];
  skipped: string[];
}
export type AssignErrorCode =
  | "invalid_origin" | "empty_selection" | "unknown_note" | "conflict" | "corrupt_source";
export type AssignToOriginResult =
  | { ok: true; plan: AssignPlan }
  | { ok: false; code: AssignErrorCode; message: string };
export function planAssignToOrigin(
  entries: Record<string, unknown>, request: AssignToOriginRequest,
): AssignToOriginResult;

export interface AssignState { plan: AssignPlan | null; confirmed: boolean }
export function beginAssign(entries: Record<string, unknown>, request: AssignToOriginRequest): AssignState;
export interface AssignIo {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, string>): Promise<void>;
}
export type AssignCommitResult =
  | { ok: true; added: string[]; skipped: string[] }
  | { ok: false; code: "not_confirmed" | "stale_plan" | "storage_failure" };
export function commitAssign(state: AssignState, io: AssignIo): Promise<AssignCommitResult>;

export interface UndoPlan {
  targetKey: string;
  targetOrigin: string;
  provenanceKey: string;
  baseText: string;            // CAS-Basis des Ziel-Blobs
  remainingText: string;       // Ziel-Blob ohne die entfernten IDs
  baseProvenance: AssignProvenance;
  remainingProvenance: AssignProvenance;
  removed: string[];           // nur IDs mit Provenienz
  skipped: string[];           // angefragt, aber nicht nachweislich kopiert
}
export interface UndoState { plan: UndoPlan | null; confirmed: boolean }
export function planUndoAssign(
  entries: Record<string, unknown>,
  request: { ids: readonly string[]; origin: unknown },
): { ok: true; plan: UndoPlan }
  | { ok: false; code: "invalid_origin" | "unknown_note" | "corrupt_source"; message: string };
export type UndoCommitResult =
  | { ok: true; removed: string[]; skipped: string[] }
  | { ok: false; code: "not_confirmed" | "stale_plan" | "storage_failure" };
export function commitUndoAssign(state: UndoState, io: AssignIo): Promise<UndoCommitResult>;

// src/data/index.ts (C3; baut `dist/data.js` / Paket-Subpath `bluepencil/data`)
export * from "./origin";        // C2: Key-Helfer, LEGACY_STORAGE_KEY, assignProvenanceKey
export * from "./note-set";      // C3
export * from "./legacy-assign"; // C3
export { normaliseOrigin, parseOriginInput, originOf, currentOrigin } from "../core/origin"; // C1
export type { Note, NoteOrigin } from "../core/model";  // C3: Typfläche für review-data.d.ts (AC-72)

// extension/src/review-data.d.ts (neu, C3) — Wildcard-Deklaration wie bluepencil-element.d.ts;
// sie spiegelt die echten Typen aus src/data/index.ts, statt sie ein zweites Mal zu schreiben.
declare module "*/dist/data.js" {
  export * from "../../src/data/index";
}

// extension/src/review.ts (neu)
export interface OriginNoteView {
  note: Note; keyOrigin: NoteOrigin; mismatch: boolean; duplicate: boolean;
}
export interface OriginGroup {
  origin: NoteOrigin; legacy: boolean; key: string;
  notes: OriginNoteView[];
  mismatched: string[];                                  // sortierte IDs mit mismatch === true
  error?: { code: "corrupt_blob"; message: string };     // Gruppe lesbar, Inhalt unlesbar
}
export function aggregateOriginStores(entries: Record<string, unknown>): OriginGroup[];
```

**Semantik.** Assign ist **copy-only** (RVW-01): der Legacy-Key wird nie geschrieben, nie entfernt, nie neu serialisiert; `AssignPlan` enthält genau **einen** Ziel-Key (`bluepencil:v2:<origin>`) und einen Provenienz-Key. Die Kopie entsteht durch `cloneNote` aus `src/core/adapter.ts` plus Zuweisung von `origin` — **keine** zweite Notiz-Konstruktion, kein `createNote`, keine Änderung an `id`, `createdAt`, `updatedAt`, `body`, `anchor`, `messages`, `timing`; jede Ziel-Notiz muss `validateNote` bestehen (FR-15.3, RVW-12). `timing` ist danach ein eigenes Objekt (RVW2-19). `cloneNote` wird von `src/data/legacy-assign.ts` als **Quell-Import** benutzt (im selben Bundle `dist/data.js`); es wird **nicht** zusätzlich als öffentlicher Entry exportiert, und `review.ts` importiert es nicht (RVW3-05).

**Importfläche der Review-Page (RVW3-05).** `extension/review.html` lädt genau `extension/dist/review.js`; `extension/build.mjs` erzeugt diesen Entry aus `extension/src/review.ts` und bündelt dabei den gebauten `dist/data.js`. Aus `dist/data.js` nutzt die Page ausschließlich: `parseNoteSet`, `migrateNote`, `parseNotesStorageKey`, `chromeStorageKeyForOrigin`, `assignProvenanceKey`, `parseAssignProvenance`, `planAssignToOrigin`, `beginAssign`, `commitAssign`, `planUndoAssign`, `commitUndoAssign`, `LEGACY_STORAGE_KEY`, `normaliseOrigin`/`parseOriginInput` (Anzeige des Ziel-Origins). `aggregateOriginStores` liegt in `extension/src/review.ts` selbst. `scripts/build.mjs` nimmt die Jobs `data`/`adapters` in `ELEMENT_JOBS` auf, damit ein `--watch`-Lauf die Review-Page nicht mit einem veralteten Daten-Bundle zurücklässt.

Prüf-Reihenfolge und Codes: `invalid_origin` (Ziel nicht per `parseOriginInput` auflösbar oder `null`) → `empty_selection` (nach Trim/Dedupe keine ID) → `corrupt_source` (Legacy-Blob, Ziel-Blob **oder irgendeine fremde `v2`-Gruppe** nicht parsebar; RVW2-16) → `unknown_note` (ID in keiner Gruppe vorhanden) → `conflict` (ID liegt in einem **anderen** `v2`-Store; kein stilles Überspringen) → `skipped` (ID liegt bereits im **Ziel**-Store; das ist keine Kopie). Ein Fehlerfall erzeugt **keinen** Teil-Plan (RVW-10, RVW-13).

**Provenienz (RVW2-04).** Jede tatsächlich geschriebene Kopie erhält einen Eintrag im Sidecar `bluepencil:assign:<origin>` (Note-ID → `now`). Der Sidecar ist über den Page-Relay **unerreichbar**: `keys` muss exakt der abgeleitete Notiz-Key sein, und `parseNotesStorageKey("bluepencil:assign:…")` liefert `null`, sodass die Aggregation ihn ignoriert. `commitAssign` schreibt Ziel-Blob **und** Sidecar in **einem** `set`-Aufruf (zwei Keys); eine übersprungene ID bekommt keinen Eintrag. Grund: ein vor dem Assign vorhandener Ziel-Datensatz ist nach einem Reload sonst nicht von einer Kopie unterscheidbar, und Undo würde fremde Daten löschen.

**Concurrency (RVW-11, RVW2-04).** `commitAssign` und `commitUndoAssign` lesen Ziel-Key **und** Sidecar vor dem Schreiben erneut und vergleichen beide mit `baseText`/`baseProvenance` (Compare-and-Set über den ganzen Blob): Abweichung → `{ok:false, code:"stale_plan"}`, kein `set`; Gleichheit → genau ein `set`. Damit geht eine zwischen Plan und Commit angelegte Notiz nicht verloren; die Review-Page plant bei `stale_plan` neu. Ein werfendes `io.set` wird als `storage_failure` beantwortet, nie als Wurf. Restfenster zwischen Re-Read und `set` bleibt, weil `chrome.storage.local` keine Transaktion hat (§8 Risiko 5). `skipped` wird im Plan bestimmt und im Ergebnis unverändert gemeldet.

**Undo (RVW2-04).** `planUndoAssign` entfernt **nur** IDs, die im Sidecar des Ziel-Origins stehen; angefragte IDs ohne Provenienz landen in `skipped` und bleiben unangetastet (`removed: []`, kein `set`). Eine ID mit Provenienz, aber ohne Ziel-Datensatz gilt als bereits undo-ed: `skipped`, Sidecar-Eintrag wird bereinigt. Fehlercodes: `invalid_origin` (Ziel nicht auflösbar), `unknown_note` (ID weder im Ziel noch im Sidecar), `corrupt_source` (Ziel-Blob oder Sidecar nicht parsebar; fail-closed). Die Sichtbarkeit „vor dem Schreiben“ zeigt den normalisierten Ziel-Origin und die Anzahl der Kopien (Ruling Q2 aus Review 2).

**Dedupe.** `aggregateOriginStores` markiert jede ID, die in mehr als einer Gruppe liegt, in **jeder** betroffenen `OriginNoteView` mit `duplicate: true`; die Darstellung zeigt die Kopie einmal (Ziel-Gruppe gewinnt, Legacy-Zeile wird als Kopie markiert). `bluepencil:assign:*`, `bluepencil:settings` und `bluepencil:ui:*` sind keine Gruppen.

### C4 — Credential-Isolation (G6 = A)

```ts
// extension/src/credential.ts (neu, rein) — die EINE Credential-Abbildung (FR-15.3)
export type CredentialMode = "none" | "secret" | "token";
export interface CredentialHeader { header: "Authorization" | "x-bluepencil-auth"; scheme: string | null }
export function credentialHeaderFor(auth: CredentialMode): CredentialHeader | null;  // null für "none"
export function configuredCredential(token: string): string | null;                   // trim, leer → null
export function authHeadersFor(auth: CredentialMode, token: string): Record<string, string>; // {} bei none/leer

// extension/src/handoff.ts
export type PageSettings = Omit<ExtensionSettings, "token" | "tokenExpiresAt" | "deviceName">;  // C4a: Typ
export function pageSettingsFor(settings: ExtensionSettings): PageSettings;   // C4a neutral, C4b strippt
export type AttributeSource =
  Pick<ExtensionSettings, "environment" | "appName" | "language" | "identity" | "store" | "endpoint">;
export function elementAttributesFor(settings: AttributeSource, browserLanguage?: string): Record<string, string>;

// extension/src/hub-fetch.ts
export const HUB_FETCH_HEADERS = ["accept", "content-type"] as const;   // nur noch diese beiden
export type HubFetchErrorCode = /* … */ | "permission_missing";
export interface HubFetchDeps {
  fetchImpl?: typeof fetch;
  authHeaders?: () => Record<string, string>;
  endpoint?: () => string;                              // C4b: Worker-Settings; ohne sie kein Grant-Check
  permissions?: { contains(pattern: string): Promise<boolean> }; // C4b: Worker injiziert chrome.permissions
}

// extension/src/credential-copy.ts (neu, rein)
export interface CredentialCopy { label: string; hint: string; state: string | null }
export function credentialCopy(settings: Pick<ExtensionSettings, "auth" | "token" | "tokenExpiresAt">): CredentialCopy;
```

**Zwei Schritte, ein Contract.** **C4a** ist additiv und verhaltensneutral: `credential.ts` (neu), `connection.ts` importiert direkt daraus, `handoff.ts` **re-exportiert** `configuredCredential`/`credentialHeaderFor` aus `credential.ts` und führt `PageSettings` **und** `pageSettingsFor` ein (die Implementierung reicht die Felder in C4a noch durch; sie strippt erst in C4b), `credential-copy.ts` (neu), `settings.ts` unverändert. **C4b** ist der Commit-Verbund aus G6 und entfernt die page-lesbaren Stellen: `sw.ts` injiziert `authHeadersFor`, `handoff.ts` strippt `token`/`tokenExpiresAt`/`deviceName` in `pageSettingsFor`, entfernt die Token-Attribute aus `elementAttributesFor` und löscht den Re-Export, `hub-fetch.ts` verengt `HUB_FETCH_HEADERS` und liefert `permission_missing`, `page-relay.ts` strippt `authorization`/`x-bluepencil-auth`, `docs/EMBED.md` dokumentiert den Bruch. Zwischen C4a und C4b bleibt der Typecheck grün, weil `handoff.ts` die beiden Funktionen weiter exportiert (RVW2-06) und `planMount` (C5) `pageSettingsFor` bereits ab C4a aufrufen kann.

**C4b ist der Boundary-Commit (RVW4-02).** `extension/manifest.json` gehört **C4b**, nicht C5: `host_permissions` wird entfernt und `optional_host_permissions` ergänzt in **demselben** Commit, der `ensureBootstrapRegistered`/`registerContentScripts` aus `sw.ts` löscht, der die Guards in `extension/smoke.mjs` (nur Host-Guard-Abschnitt, RVW5-02) und `scripts/webstore-compliance.mjs` invertiert und der die Quelltext-Assertionen in `tests/unit/webstore-rules.test.ts` schreibt. Jede Trennung dieser Teile erzeugt entweder einen roten Check (Manifest ohne Host-Permission, Worker registriert noch) oder eine funktional kaputte Produktion (Registrierung ohne Host-Permission wirft vor der Injektion). Der invertierte Host-Guard in `smoke.mjs` liest dabei **`extension/dist/manifest.json`** (Produktionsmanifest), nicht das geladene `extension/dist-test` — sonst prüfte er sein eigenes Test-Grant-Manifest.

**Die Ordnungsassertion ist zweigeteilt (RVW5-01).** `extension/dist` existiert im Unit-Test-Schritt nicht (`ci.yml` führt `Unit tests` vor `Build extension (MV3)`; `npm test`/`verify` bauen die Extension nicht vorher, und `npm run build` baut `extension/dist` im One-Shot-Modus nicht). Deshalb beobachtet **jede Ebene das, was in ihrer Umgebung existiert**:

- **Quelltext-Ebene (Unit-Test, ohne `dist`, sauberer Checkout):** `tests/unit/webstore-rules.test.ts` (C4b) prüft `extension/manifest.json` (kein `host_permissions`; `optional_host_permissions === ["http://*/*","https://*/*"]`; kein `<all_urls>`) und `extension/src/sw.ts` (kein `registerContentScripts`, kein `ensureBootstrapRegistered` nach C4b). Beide Dateien liegen im Repo, der Lauf braucht keinen Build.
- **Build-Ebene (nach `Build extension (MV3)`):** der Vergleich `extension/dist/sw.js` ↔ `extension/dist/manifest.json` liegt in `scripts/webstore-compliance.mjs` und läuft als `smoke:webstore` (`ci.yml:223-227`, nach `npm run build:ext` in `ci.yml:214`). Fehlt eine der beiden Dateien, ist das ein **benannter Fehler** (FAIL mit Dateinamen, Exit 1) — kein Skip und kein Rückfall auf `extension/src`. Damit ist keine Umordnung von `ci.yml` nötig; die Build-Assertion gehört C4b (dieselbe Datei, derselbe Boundary-Commit).

Der Seam `self.__bluepencilModule = { mountOnTab }` (heute `sw.ts:196`) bleibt dabei **unverändert**: Smoke und beide E2E-Suiten rufen `mountOnTab` ausschließlich über diesen Handle auf (RVW4-09, AC-74).

**Options-Import (RVW3-02).** `options.ts` importiert `configuredCredential` ab **C5** aus `./credential` statt aus `./handoff`. C4b löscht den Re-Export erst danach; damit gibt es keinen Commit, in dem `typecheck:ext` bricht. Die Kante ist in §7 als Merge-Bedingung eingetragen. **`npm run typecheck:ext` ist ein Gate pro Commit** (nicht nur vor dem Release): C5, C6, C4b und C3 dürfen keinen roten Extension-Typecheck hinterlassen.

**Permission-Prüfung vor dem Request (RVW3-07).** Ab C4b prüft `runHubRequest` nach `validateHubRequest` und **vor** `fetch`: `hubOriginPattern(deps.endpoint())` → `deps.permissions.contains(pattern)` → `permissionState({ contains, pattern, deniedPatterns: [] })` → `permissionRefusal(endpoint, state)`. Bei `permission_missing` wird kein `fetch` ausgeführt und der Code unverändert nach außen gegeben. `permissions.ts` (C5) liegt vor C4b, der Import ist azyklisch. Ohne injizierte `endpoint`/`permissions` bleibt der bisherige Pfad unverändert (nur der Worker injiziert beide; `denied` ist Options-Session-Zustand und im Worker immer leer — der Browser erzwingt den Grant ohnehin beim `fetch`). **Der Worker injiziert beide wirklich** (RVW4-10): der `runHubRequest`-Aufruf in `sw.ts` übergibt ein Deps-Objekt, dessen `endpoint` den frisch gelesenen `settings.endpoint` liefert und dessen `permissions.contains` auf `chrome.permissions.contains` zeigt; AC-33 prüft das als Quelltext-Assertion im gebauten `sw.js`. Damit ist die Fail-closed-Zusage nicht nur an der puren Funktion, sondern an der Worker-Verdrahtung beobachtet.

`credentialHeaderFor`, `configuredCredential` und `authHeadersFor` liegen in **einem** Modul; `handoff.ts`, `hub-fetch.ts`/`sw.ts` und `connection.ts` importieren daraus. Es gibt keine zweite Header-Tabelle (RVW-25). `AttributeSource` enthält `auth`/`token` nach C4b nicht mehr — `elementAttributesFor` kann Token-Attribute daher **nicht** emittieren; `pageSettingsFor` entfernt `token`, `tokenExpiresAt`, `deviceName` aus `__bluepencilConfig__.settings`.

Die Page-Seite sendet **nie** `authorization`/`x-bluepencil-auth`: `createPageFetch` entfernt beide Namen (case-insensitiv) aus den ausgehenden Headern, `validateHubRequest` weist sie als `disallowed_header` zurück, der Worker hängt sie nach der Validierung über `authHeadersFor` aus dem gespeicherten Settings-Objekt an. Die Host-Attribute für eigene Embeds bleiben S2-Eigentum; S1 ändert nur, was die **Extension** schreibt.

### C5 — Optionale Host-Permissions (G9 = A), Mount-Plan und Options-Page

```ts
// extension/src/permissions.ts (neu, rein)
export function hubOriginPattern(endpoint: string): string | null;   // url.hostname, Port elidiert
export type PermissionState = "unknown" | "granted" | "denied";
export function permissionState(input: {
  contains: boolean; pattern: string; deniedPatterns: readonly string[];
}): PermissionState;
export type SaveDecision =
  | { ok: true; requestOrigin: string | null }                        // null = kein Grant nötig
  | { ok: false; code: "missing_endpoint" | "invalid_origin" | "permission_denied"; message: string };
export function decideSave(input: {
  store: string; endpoint: string; permission: PermissionState;
}): SaveDecision;
export function permissionRefusal(
  endpoint: string, permission: PermissionState,
): { code: "permission_missing"; message: string } | null;

// extension/src/mount-plan.ts (neu, rein)
export type MountStep = { kind: "bridge" } | { kind: "bootstrap" } | { kind: "config" };
export interface PageConfig { settings: PageSettings; tabUrl: string; force: boolean }
export function planMount(input: { settings: ExtensionSettings; tabUrl: string; force: boolean }):
  { steps: MountStep[]; config: PageConfig };
```

**Pattern (RVW-03).** `hubOriginPattern` baut aus `url.protocol` + `url.hostname` (nicht `url.host`) plus `/*`: `https://hub.example/api` → `https://hub.example/*`, `http://127.0.0.1:8787/api` → `http://127.0.0.1/*`, `http://[::1]:8787/api` → `http://[::1]/*`. Chrome-Match-Patterns kennen keinen Port; der Default-Hub `http://127.0.0.1:8787` wäre mit `url.host` ein ungültiges Pattern. `chrome.permissions.request` und `chrome.permissions.contains` erhalten **denselben** String.

**Zustand (RVW-04).** Chrome exponiert keinen „denied“-Zustand. Die Options-Page leitet ihn so ab: `permissions.contains(pattern) === true` → `granted`; sonst, wenn in dieser Options-Session ein `permissions.request` für dasselbe Pattern `false` geliefert hat → `denied` (session-scoped, dokumentiert); sonst `unknown`. `decideSave`: `store !== "http"` → `{ok:true, requestOrigin:null}`; leerer/unbrauchbarer Endpoint → `missing_endpoint`/`invalid_origin`; `granted` → `{ok:true, requestOrigin:null}`; `unknown` → `{ok:true, requestOrigin:<pattern>}` (die Page fragt im Klick-Kontext an); `denied` → `{ok:false, code:"permission_denied"}` mit Verweis auf `chrome://extensions` (ein zweiter Request nach Ablehnung wird von Chrome ignoriert und sähe wie ein Fehler aus).

**Mount-Reihenfolge (bindend, RVW2-02).** `planMount` liefert genau `[bridge, bootstrap, config]`. `bridge.js` (isolated world) und `bootstrap.js` (MAIN) werden als Dateien injiziert; erst danach schreibt der `config`-Schritt `__bluepencilConfig__` inklusive `force` und weckt `__bluepencilTryMount`. Nur so sieht das Bootstrap die Konfiguration **und** erhält `force`; `force` wird nicht erneut aus einer globalen Variable geraten (RVW2-17). Es gibt **keine** persistente Registrierung: `chrome.scripting.registerContentScripts` wird nicht mehr aufgerufen; `ensureBootstrapRegistered` wird ersatzlos gelöscht — die Löschung liegt in `sw.ts` (C4b), die ersetzende Sequenz in `mount.ts` (C6), ein zweiter Helper wäre eine zweite Implementierung.

`manifest.json` (Eigentum **C4b**, nicht C5 — RVW4-02): `host_permissions` entfernt, `optional_host_permissions: ["http://*/*", "https://*/*"]`, kein `content_scripts`, kein `web_accessible_resources`.

**Options-Page (RVW2-05).** `extension/options.html` gehört **C5** (eine Datei, ein Eigentümer): die Buttons `#turn-on`/`#turn-off` und der `wireToggle`-Pfad in `options.ts` entfallen, dafür steht ein Link auf `review.html` (die Seite liefert C3; bis dahin ist der Link ein 404 innerhalb der Extension und kein Release-Zustand). `docs/EXTENSION.md` nennt den Wegfall ausdrücklich: Mounten läuft weiter über Toolbar-Button und Alt+Shift+B.

`request-mount` aus der Page ist **kein** Mount ohne Geste (Annahme A6): der Bridge-Kanal existiert nur in einem Tab, in dem `activeTab` bereits erteilt und injiziert wurde. Programmatisches Mounten aus der Page entfällt (G9-Restrisiko).

**Test-Strategie G9 (RVW3-01, bindend).** Headless Chromium erzeugt weder `chrome.permissions.request` noch die `activeTab`-Geste zuverlässig; ein Smoke, der `mountOnTab` ohne Geste aufruft, scheitert nach G9 mit „Extension manifest must request permission to access this host“. Deshalb gilt genau diese Kombination:

1. **Seam (automatisiert, immer grün).** AC-34/35/36/37/38 beobachten `mountOnTab`/`runMountStep`/`dispatchTabMessage` mit injizierten `MountDeps` bzw. Hooks — die Worker-Logik, nicht die Browser-Geste.
2. **Erzwungene Release-Checkliste RC-1…RC-3 (RVW4-06).** `docs/RELEASING.md` führt `RC-1` (Hub-Origin im Options-Save bestätigen), `RC-2` (Toolbar-Mount auf einer echten Profil-Seite) und `RC-3` (Alt+Shift+B) als Pflichtschritte der „five minutes before the tag“; der Release-Job in `release.yml` hängt an der geschützten GitHub-Environment `release` mit Required Reviewers, sodass ohne menschliche Freigabe nichts publiziert wird (Einrichtung: einmalige Repo-Einstellung, in `docs/RELEASING.md` dokumentiert). Die Freigabe ist an die RC-Bestätigung gebunden (AC-79); sie erzwingt die Bestätigung, nicht die Durchführung (Restrisiko §8/8). AC-70 prüft die Texte.
3. **Invertierte Guards im Boundary-Commit (C4b).** `extension/smoke.mjs` (bisher `smoke.mjs:289-293`) und `scripts/webstore-compliance.mjs` (bisher `:186-200`) verlangten mindestens eine `host_permissions`-Zeile. Beide werden **invertiert**: `host_permissions` muss **fehlen**, `optional_host_permissions` muss `http://*/*` und `https://*/*` enthalten, `<all_urls>` bleibt verboten — und zwar in **C4b**, zusammen mit `manifest.json` und der Löschung von `registerContentScripts`. Ein früherer Flip wäre rot, ein späterer ließe die Produktion kaputt (RVW4-02). Der `smoke.mjs`-Flip betrifft **nur** den Host-Guard-Abschnitt; der Test-Grant-Abschnitt derselben Datei gehört C5 (§7, Abschnitts-Eigentum, RVW5-02). `scripts/webstore-compliance.mjs` trägt zusätzlich die Build-Ebene der Ordnungsassertion (AC-76): `dist/sw.js` ↔ `dist/manifest.json`, fehlende Datei = benannter Fehler.
4. **Ein Test-Grant-Build für alle drei mountenden Suiten (RVW4-01).** `extension/test-manifest.mjs` (neu, C5) exportiert `buildTestGrant()`: löscht `extension/dist-test` **vor** dem Kopieren (kein stale Rest, RVW4-03), kopiert `extension/dist` und ersetzt **ausschließlich** `host_permissions: ["http://*/*","https://*/*"]`; fehlt `extension/dist/manifest.json`, endet der Aufruf mit einem benannten Fehler statt mit einem stillen Skip. `extension/smoke.mjs` (`smoke:ext`), `tests/e2e/parity.e2e.mjs` (`smoke:parity`) und `tests/e2e/round-trip.e2e.mjs` (`smoke:round-trip`) rufen `buildTestGrant()` unmittelbar vor dem Laden auf und laden **ausschließlich** `extension/dist-test`; ein gebautes `extension/dist` setzen sie wie bisher voraus (CI-Step `Build extension (MV3)`). `extension/smoke-review.mjs` (`smoke:ext:review`, C3) ruft `buildTestGrant()` **ebenfalls selbst** auf (der Aufruf ist idempotent, weil er `dist-test` vorher löscht) und ist damit auch lokal auf einem sauberen Baum lauffähig (RVW5-06, AC-77). `parity` baut die Extension zuerst selbst neu (`parity.e2e.mjs:244-250`) und ruft `buildTestGrant()` **danach** — sonst verglichen die Suiten ein altes `dist-test` gegen einen frischen Embed-Build. Die im Review zugelassene Alternative (AC-36/37/38 auf Seams begrenzen, `parity`/`round-trip` aus dem G9-Gate nehmen) wird **nicht** gewählt: sie löscht zwei required CI-Belege des Mount-Pfads, um ein Build-Ordnungsproblem zu umgehen. Weil die Manifest-Kopie erst zur Laufzeit entsteht, vergleicht `extension/smoke.mjs` nach `buildTestGrant()` `dist-test/manifest.json` mit `dist/manifest.json` — identisch außer `host_permissions`; fehlt eine der Dateien, ist das ein benannter Fehler (AC-69, C5).
5. **Hygiene des Test-Grants (RVW4-03).** `extension/dist-test/` steht in `.gitignore` und `.dockerignore`; `build:ext` kennt es nicht, Release- und Extension-Workflow zippen ausschließlich `extension/dist` (`cd extension/dist`), und `npm pack --dry-run` enthält es nicht (`package.json.files` ist eine Allowlist ohne `extension/`). AC-69 prüft Ignore-Einträge und Paket im Unit-Schritt und den Manifest-Vergleich/Cleanup nach dem Build (`smoke:ext`); die Zip-Pfade sind über die Workflow-Zeilen strukturell belegt.
6. **Ein roter Check ist zu keinem Commit akzeptabel.** `smoke:ext`, `smoke:parity`, `smoke:round-trip`, `smoke:webstore` und `typecheck:ext` sind an jedem Commit grün; es gibt kein „wird in C3/C4b/C5 nachgezogen“-Fenster. Der Smoke trägt **keine** `registerContentScripts`-Erwartung mehr; das Entfernen dieser Erwartung ist **C5** (damit C6, das die Funktion ungenutzt zurücklässt, sie nicht rot macht), das Entfernen des Aufrufs aus `sw.ts` ist **C4b** und wird dort als Quelltext-Assertion in `tests/unit/webstore-rules.test.ts` geprüft (RVW3-06, RVW5-02). Ein `dist`-Vergleich im Smoke oder in `smoke:webstore` ist ein benannter Fehler, wenn eine Datei fehlt; kein Check fällt still auf eine andere Quelle zurück.

**Grenzen (RVW4-11).** Chrome-Match-Patterns kennen keinen Port: `hubOriginPattern("https://hub.example:9443/api")` ergibt `https://hub.example/*`, der Grant umfasst also **alle Ports dieses Hosts**, nicht nur den konfigurierten. Das ist eine Chrome-Grenze, kein Fehler, und wird als akzeptierte Ausweitung dokumentiert (§8 Risiko 10). `dist-test` ist ein zweites Manifest mit `host_permissions`; es bleibt reines Build-Artefakt (Punkt 5) und wird nie verpackt (§8 Risiko 11).

**Review-Page-Smoke (RVW4-04).** `extension/smoke.mjs` gehört C5 in seinen Mount-, Persistenz-, Navigations-, Loader- und Composer-Fällen **sowie** im Test-Grant-/`dist-test`-Pfad und beim Entfernen der `registerContentScripts`-Erwartung; C4b gehört ausschließlich der Host-Guard-Abschnitt der Datei (§7, dritte benannte Ausnahme). Die Review-/Assign-/Undo-Fälle der Extension-Page liegen in `extension/smoke-review.mjs` (neu, **C3**), gestartet über `npm run smoke:ext:review`; die Datei lädt `extension/dist-test` und ruft `buildTestGrant()` selbst auf (idempotent, RVW5-06). C3 schreibt damit keine Zeile in eine C5-eigene Datei; die einzige geteilte Datei ist `.github/workflows/ci.yml` mit genau einem zusätzlichen Step (§7).

### C6 — Tab-Bindung (SEC-15), Mount-Ausführung (CQ-06) und Dispatch

```ts
// extension/src/tab-binding.ts (neu, rein)
export interface MessageSenderLike { id?: string; tab?: { id?: number; url?: string } }
export type TabTarget =
  | { kind: "sender"; tabId: number; tabUrl: string }
  | { kind: "explicit"; tabId: number }
  | { kind: "none"; code: "no_tab" | "invalid_tab_id" | "foreign_sender" };
export function resolveTabTarget(
  sender: MessageSenderLike | undefined,
  message: { type?: unknown; tabId?: unknown },
  ownExtensionId: string,
): TabTarget;

export interface DispatchHooks {
  mount(tabId: number, tabUrl: string, options: { force?: boolean }): Promise<WorkerOutcome>;
  toggle(tabId: number, enabled: boolean): Promise<WorkerOutcome>;
}
/** Der einzige Pfad vom `onMessage`-Event zu einer Wirkung; kennt `chrome.tabs.query` nicht. */
export function dispatchTabMessage(
  input: { message: unknown; sender: MessageSenderLike | undefined; ownExtensionId: string },
  hooks: DispatchHooks,
): Promise<WorkerReply>;   // Ergebnis läuft durch `toWorkerReply` (C7-code)

// extension/src/mount.ts (neu; einziger Eigentümer der Mount-Sequenz und von mountOnTab)
export interface MountResult { ok: boolean; tabUrl?: string; error?: string }
export type MountInjection =
  | { target: { tabId: number }; files: string[]; injectImmediately: true }
  | { target: { tabId: number }; files: string[]; world: "MAIN"; injectImmediately: true }
  | { target: { tabId: number }; world: "MAIN"; func: (...args: never[]) => void;
      args: unknown[]; injectImmediately: boolean };
export interface MountDeps {
  readSettings(): Promise<ExtensionSettings>;
  executeScript(injection: MountInjection): Promise<unknown[]>;
  handoff(config: PageConfig): void;                     // Default: mainWorldHandoff
}
/** Der EINE Default-Reader (SETTINGS_KEY + normalizeSettings + Default-Fallback); `sw.ts` importiert ihn in C4b. */
export function readSettings(): Promise<ExtensionSettings>;
export function mainWorldHandoff(config: PageConfig): void;
export function runMountStep(
  step: MountStep, tabId: number, config: PageConfig, deps: MountDeps,
): Promise<{ ok: true } | { ok: false; error: string }>;
export async function mountOnTab(
  tabId: number, tabUrl?: string, options?: { force?: boolean }, deps?: Partial<MountDeps>,
): Promise<MountResult>;   // wirft nie
```

`sender.tab.id` (browser-gesetzt, von einer Page nicht fälschbar) gewinnt immer → `{kind:"sender"}`; `chrome.tabs.query({active,currentWindow})` bleibt ausschließlich in `chrome.action.onClicked` und `chrome.commands.onCommand`. `{kind:"explicit"}` gilt nur für Absender **ohne** `sender.tab`, deren `sender.id === ownExtensionId` ist (Extension-Pages, Worker, Test-Harness). Ein Absender ohne `tab` mit fremder oder fehlender `id` → `{kind:"none", code:"foreign_sender"}`; ein `tabId`, das keine positive ganze Zahl ist (`0`, `-1`, `"1"`, `1.5`), → `{kind:"none", code:"invalid_tab_id"}`; ein Absender ohne `tab` und ohne `message.tabId` → `{kind:"none", code:"no_tab"}`.

**`readSettings` (RVW3-04).** Der bisher private Reader aus `sw.ts` (inkl. `SETTINGS_KEY`-Read, `normalizeSettings`, Default-Fallback) zieht nach `mount.ts` und ist dort exportiert; `sw.ts` importiert ihn in **C4b**. `MountDeps.readSettings` hat denselben Typ und denselben Default. `mount.ts` importiert **nie** aus `sw.ts`; der Graph bleibt `sw → mount → settings` (C4a) und damit azyklisch — sonst entstünde `sw → mount → sw`. `sw.ts` behält keinen zweiten Reader und keine eigene `SETTINGS_KEY`-Konstante.

**Seams (RVW2-08).** `dispatchTabMessage` ist die einzige Stelle, die ein `bluepencil:mount`/`bluepencil:toggle` in eine Wirkung übersetzt; es hat keinen Zugriff auf `chrome.tabs`, sodass „kein `tabs.query` auf dem Sender-Pfad“ strukturell gilt und im Test über die Hooks beobachtbar ist. `runMountStep` führt **einen** `MountStep` aus und ist mit injizierten `MountDeps` testbar; `mountOnTab` komponiert `readSettings` → `planMount` → `runMountStep` in der Plan-Reihenfolge und fasst die **gesamte** Sequenz in `try/catch`, sodass jeder der drei `executeScript`-Aufrufe (Bridge, Bootstrap, Config) zu `{ok:false, error}` führt. In 0.11.6 ist der **dritte** Aufruf (Handoff, `mainWorldHandoff`) die unbehandelte Rejection — der zweite ist bereits abgefangen; eine Korrektur nur am zweiten würde AC-38 nicht erfüllen (RVW-05). Beide Aufrufer (Toolbar, Command) behandeln das Ergebnis.

### C7 — Message-Protokoll, Worker-Antworten und Bootstrap-Vertrag (`C7-code`; Doku-Tail `C7-docs`)

```ts
// extension/src/bridge-messages.ts (neu, rein; von bridge.ts benutzt)
export type PageKind = "request-mount" | "toggle" | "storage" | "fetch";
export type PageEnvelope =
  | { source: "bluepencil-page"; kind: "request-mount"; force?: boolean; requestId?: string }
  | { source: "bluepencil-page"; kind: "toggle"; enabled?: boolean; requestId?: string }
  | { source: "bluepencil-page"; kind: "storage"; op: "get" | "set" | "remove"; keys?: string | string[];
      items?: Record<string, unknown>; requestId: string }
  | { source: "bluepencil-page"; kind: "fetch"; requestId: string; request: { method: string; url: string;
      headers?: Record<string, string>; body?: string } };
export type EnvelopeCheck =
  | { ok: true; envelope: PageEnvelope }
  | { ok: false; code: "invalid_envelope" | "foreign_field"; message: string };
export function checkPageEnvelope(data: unknown): EnvelopeCheck;

export type WorkerReply =
  | { ok: true; enabled?: boolean; tabUrl?: string }
  | { ok: false; code: "no_tab" | "invalid_tab_id" | "foreign_sender"
      | "mount_failed" | "toggle_failed"; error: string };
export type WorkerOutcome =
  | { kind: "mount"; ok: boolean; tabUrl?: string; error?: string }
  | { kind: "toggle"; ok: boolean; enabled?: boolean; error?: string }
  | { kind: "refused"; code: "no_tab" | "invalid_tab_id" | "foreign_sender"; error: string };
/** Die einzige Abbildung Outcome → Wire-Format; wirft nie. */
export function toWorkerReply(outcome: WorkerOutcome): WorkerReply;

/** Die einzige Abbildung Bootstrap-Report → Badge; `null` = bestehendes Verhalten unverändert. */
export function badgeForReport(
  report: { kind: string; ok?: boolean; error?: string },
): { text: "mem"; title: string } | null;   // nur `{kind:"mounted", ok:false, error:"memory-only: …"}`
```

Entfernte Felder und ihre Folge: `storage.origin`, `storage.key` → `foreign_field`/`invalid_envelope`; `fetch.headers.authorization`, `fetch.headers.x-bluepencil-auth` → `disallowed_header`; `__bluepencilConfig__.settings.token` → Feld existiert nicht mehr (Typ `PageSettings`). Jede Ablehnung ist ein benannter Code, nie ein stilles Verwerfen.

**Bootstrap-Vertrag (RVW2-08).** `bootstrap.ts` (C7-code) setzt `__bluepencilTryMount` nur, wenn `__bluepencilConfig__` existiert oder der Hook vom Worker aufgerufen wird; nach einem **erfolgreichen** Mount ist der Hook entfernt (`delete globalThis.__bluepencilTryMount`). Ein Stand-aside für ein Host-Embed lässt ihn stehen (dokumentiertes #70-Verhalten). Ist der Storage-Key `null` (opaker Origin), meldet das Bootstrap `{kind:"mounted", ok:false, error:"memory-only: …"}` über den bestehenden `report`-Kanal; der Worker bildet den Report über `badgeForReport` auf Badge-Text `mem` und einen Titel ab (eine Abbildung, AC-57) und ruft damit `chrome.action.setBadgeText`/`setBadgeTitle` nur auf, wenn das Ergebnis nicht `null` ist. Der Zustand ist damit im UI sichtbar, ohne dass `src/core` einen neuen Store→Element-Kanal braucht (§8, Abgrenzung zu `element.issues`).

## 3. Datenfluss

**C1.** (1) Erfassung erzeugt `NoteDraft` mit `origin` aus `currentOrigin(window.location)` oder ohne → `createNote` normalisiert und schreibt `null`. (2) Hub/CLI/MCP prüfen eingehendes `origin` über `parseOriginInput`; Hub-Create verweigert `invalid_origin`, `?origin=`/`?origin=null` bedeutet unassigned. (3) `canonicalNote` emittiert `origin` an fester Position, `compareNotes` sortiert origin-first. (4) Export/Bundle/Hash konsumieren dieselbe kanonische Form; `toQuery` sendet `origin` (null als `"null"`, undefined gar nicht). (5) Merge setzt `existing.origin ?? incoming.origin`; Patch kennt das Feld nicht.

**C2.** (1) Bridge liest `window.location` im isolated world und reicht das `location`-Like an `relayPageStorage` (kein Origin-String). (2) `storageKeyForLocation` ergibt den einen erlaubten Key oder `null`. (3) Page-Envelope wird gegen `{op,keys,items}` geprüft; jede Abweichung endet vor dem Storage-Aufruf. (4) Nur `keys`/`items` mit exakt diesem Key erreichen `chrome.storage.local`. (5) Antwort `{ok,value|code,error}` geht über `postMessage` zurück. (6) Das Bootstrap registriert den Adapter auch bei non-null Key; der Adapter leitet denselben Key aus `globalThis.location` ab. Bei `null` erscheint der Memory-Status (§5).

**C3.** (1) Review-Page liest `chrome.storage.local.get(null)`. (2) `aggregateOriginStores` filtert mit `parseNotesStorageKey`, nimmt den Legacy-Key dazu, liest Notizen über `parseNoteSet`/`migrateNote` und legt pro Gruppe einen Fehlerzustand ab; `bluepencil:assign:*` wird ignoriert. (3) Nutzer wählt IDs und einen Ziel-Origin, bestätigt explizit (Anzeige: normalisierter Origin + Anzahl). (4) `planAssignToOrigin` liefert **nur** den Ziel-Text plus die Klone. (5) `commitAssign` liest Ziel und Sidecar erneut, vergleicht beide Basen und schreibt in einem `set`; der Legacy-Blob wird nie berührt. (6) Undo prüft die Provenienz, entfernt die Kopie und ihren Sidecar-Eintrag im selben `set`.

**C4.** (1) Worker liest `bluepencil:settings` pro Nachricht über `readSettings` (C6). (2) `planMount` baut `PageConfig` (C4b: ohne Credential). (3) Der Config-Schritt schreibt nur `PageConfig`; `elementAttributesFor` kann nach C4b keine Token-Attribute schreiben. (4) Page-Request geht ohne Auth-Header an den Worker. (5) `validateHubRequest` prüft Ziel/Methode/Kopfzeilen. (6) `runHubRequest` prüft `permissionRefusal` (C5) und führt bei `permission_missing` keinen `fetch` aus; sonst ergänzt es `authHeadersFor(...)`.

**C5.** (1) Options-Save validiert Store/Endpoint. (2) Options-Page baut `PermissionState` aus `contains` + Session-`denied`-Set. (3) `decideSave`; bei `requestOrigin !== null` fragt die Page im Klick-Kontext an. (4) Ablehnung → `denied`, kein `set`. (5) Mount injiziert Bridge → Bootstrap → Config per `activeTab`; keine Registrierung.

**C6.** (1) `onMessage` empfängt `{type:"bluepencil:mount"|"toggle"}`. (2) `dispatchTabMessage` ruft `resolveTabTarget` und dann genau einen Hook. (3) `mountOnTab`/Toggle läuft nur auf diesem Ziel; `mountOnTab` liest die Settings über den einen `readSettings`-Default aus `mount.ts`. (4) `toWorkerReply` formt das Ergebnis, nie ein Wurf. (5) Toolbar/Command rufen `mountOnTab` mit dem aktiven Tab.

**C7-code.** (1) Bridge prüft `source`/`kind` und die erlaubten Felder. (2) Storage-Envelope geht an `relayPageStorage` mit dem `location`-Like. (3) Fetch-Envelope geht an den Worker. (4) Mount/Toggle geht an den Worker mit `sender`. (5) Jede Ablehnung ist ein benannter Code.

## 4. Acceptance Criteria

| AC | Gegeben | Wenn | Dann | Finding | Testdatei |
|---|---|---|---|---|---|
| AC-01 | `https://Example.COM:443/app?x=1`, `http://example.com:80`, `http://example.com:8080`, `https://example.com:80`, `https://bücher.example`, `http://[::1]:8787`, `blob:https://example.com/u` | `normaliseOrigin` | `https://example.com`, `http://example.com`, `http://example.com:8080`, `https://example.com:80`, `https://xn--bcher-kva.example`, `http://[::1]:8787`, `https://example.com` | G5 | `origin.test.ts` |
| AC-02 | `file:///tmp/x`, `data:…`, `about:blank`, `chrome-extension://abc`, `"null"`, `""`, `undefined`, `42`, 513-Zeichen-String | `normaliseOrigin` | `null`, kein Wurf (total) | G5 | `origin.test.ts` |
| AC-03 | Draft ohne `origin` | `createNote` + `serializeCanonical` | `note.origin === null`; JSON enthält `"origin": null` | G5 | `data.test.ts` |
| AC-04 | Note mit allen Feldern | `canonicalNote` | `origin` steht nach `updatedAt` und vor `sessionRef` | NFR-17 | `data.test.ts` |
| AC-05 | Notizen aus zwei Origins, gleiche Route; `tests/fixtures/bundle-0.11.json` + gepinnter `tests/fixtures/bundle-0.11.hash` (0.11.6-Export; Erzeugung im Test dokumentiert: `parseBundle` → `serializeCanonical` → `hashBundle`); **C1 legt beide Fixtures im C1-Commit an** (RVW3-12) | zwei Exporte + `hashBundle` | origin-aufsteigend, `null` zuerst, dann route → priority → createdAt → id; beide 0.12-Ausgaben byte-identisch; der gepinnte 0.11-Hash weicht ab, weil `origin: null` jetzt emittiert wird | NFR-17, RVW-02/RVW2-15 | `data.test.ts` |
| AC-06 | `origin: "https://Example.com"` / `null` / `undefined` / fehlend | `validateNote` | erster Fall: Issue `origin must be a canonical origin or null`; die anderen drei: `[]`; `schemaVersion` bleibt 1 | NFR-9, RVW2-13 | `data.test.ts` |
| AC-07 | 0.11-Bundle ohne `origin`; Bundle mit `origin: 42` | `migrateNote`/`migrateBundle` | beide laden, `origin === null`, kein Wurf | NFR-8/9 | `data.test.ts` |
| AC-08 | zugewiesene Note + eingehend mit anderem Origin (`onConflict:"keep-existing"`); unassigned + eingehend mit Origin (`onConflict:"keep-incoming"`) | `mergeNotes` upsert | erster Fall: `origin` in `divergingFields`, `conflicts` enthält die ID, bestehender Origin bleibt, `skipped`; zweiter: Origin wird übernommen, `updated` | FR-14.3, RVW2-14 | `merge.test.ts` |
| AC-09 | `PATCH /notes/{id}` mit `{"origin":"https://a.example"}` | Hub-Handler | `400 invalid_payload`, Notiz unverändert | G5 | `server.test.ts` |
| AC-10 | `POST /notes` mit `origin:"https://A.example:443/x"` / `"file:///x"` / `"null"` / ohne Feld | Hub-Handler | gespeichert als `https://a.example` / `400 invalid_origin` / `null` / `null` | G5, RVW-08 | `server.test.ts` |
| AC-11 | `GET /notes?origin=` / `?origin=null` / `?origin=https://a.example` / `?origin=file:///x` / `?origin=42` | Hub-Filter | erste zwei: nur unassigned; dritte: exakt; vierte/fünfte: `400 invalid_origin` | G5, RVW-08 | `server.test.ts` |
| AC-12 | `list_notes` ohne `origin`; `list_notes` mit `origin:"https://a.example"` und mit `origin:null`; `create_note` mit `origin`; `create_note` ohne Feld; CLI-Export | MCP/CLI | Filter unverändert; **mit `origin` genau die Notizen dieses Origins, mit `null` genau die unassigned** (Filter wird durchgereicht, nicht ignoriert); Create normalisiert; ohne Feld `origin = null`; Export kanonisch mit `origin` | FR-16.1, RVW3-11 | `mcp-tools.test.ts` |
| AC-13 | Notiz mit `origin: "https://a.example"` und eine mit `null` | Markdown-Export | Bullet `Origin: https://a.example` bzw. `Origin: (unassigned)`, deterministisch | FR-7.1 | `export.test.ts` |
| AC-14 | `origin = "https://a.example"` / `null` | `chromeStorageKeyForOrigin` | `bluepencil:v2:https://a.example` / `null` | SEC-13 | `chrome-storage.test.ts` |
| AC-15 | Storage-Envelope mit `origin`- oder `key`-Feld | `relayPageStorage` | `invalid_envelope`, kein Storage-Aufruf | SEC-13 | `extension-storage-relay.test.ts` |
| AC-16 | Page ruft `get` für `bluepencil:settings`, `bluepencil:ui:x`, `bluepencil:default:v1`, `bluepencil:v2:https://b.example`, `bluepencil:assign:https://a.example` | `relayPageStorage` | jeweils `foreign_key`, kein Storage-Aufruf | SEC-13/14, RVW2-04 | `extension-storage-relay.test.ts` |
| AC-17 | `set` mit zwei Keys; `remove` mit zwei Keys; `get(derivedKey)` als String; `get([derivedKey])`; `get(null)`; `get([])`; `get([derivedKey, "bluepencil:settings"])` | `relayPageStorage` | erste zwei: `foreign_key` ohne Teil-Schreibung; String und Ein-Element-Array: erlaubt, gleicher Wert; `null`: `invalid_envelope`; leer/mehrfach: `foreign_key` | SEC-13, RVW-23 | `extension-storage-relay.test.ts` |
| AC-18 | opaker Origin (`location.origin === "null"`) | jeder `op` | `opaque_origin`; kein gemeinsamer Bucket; `storageKeyForLocation({origin:"null"}) === null` | SEC-13 | `extension-storage-relay.test.ts` |
| AC-19 | zwei Origins, ein `chrome.storage.local`, produktiver Adapter ohne expliziten Key | Schreiben auf A, Lesen auf B, Reload | getrennte Keys `bluepencil:v2:https://a.example` / `…b.example`; B unverändert; A nach Reload vollständig | SEC-13/G5 | `chrome-storage-crossorigin.test.ts` |
| AC-20 | Storage mit zwei v2-Keys, Legacy-Blob, `bluepencil:assign:https://a.example`, `bluepencil:settings`, `bluepencil:ui:x` | `aggregateOriginStores` | zwei Origin-Gruppen aufsteigend, Legacy zuletzt, Settings/UI/Sidecar ignoriert; `legacy:true` nur beim Legacy-Key; jede Gruppe hat `error === undefined` | G5 | `extension-review.test.ts` |
| AC-21 | Notiz `origin: "https://b.example"` in Key `bluepencil:v2:https://a.example` | `aggregateOriginStores` | Gruppe A, `keyOrigin === "https://a.example"`, `mismatch === true`, `mismatched` enthält die ID, `note.origin` unverändert; Key gewinnt | G5, RVW-09 | `extension-review.test.ts` |
| AC-22 | Plan vorhanden, `confirmed === false` | `commitAssign` | `{ok:false,code:"not_confirmed"}`, kein `set` | G5 | `legacy-assign.test.ts` |
| AC-23 | Assign mit `origin: "file:///x"`, `""`, `null`, `42` | `planAssignToOrigin` | `invalid_origin`, kein Plan | G5, RVW-08 | `legacy-assign.test.ts` |
| AC-24 | Legacy mit 3 Notizen, Ziel leer, Assign von 2 IDs; eine Legacy-Notiz hat `timing` | `beginAssign` + `commitAssign` | Legacy-Text **byte-identisch** vor/nach; Ziel-Store enthält exakt die 2 IDs plus Sidecar; jede Kopie ist der Legacy-Notiz gleich in allen Feldern außer `origin`; `copy.timing !== legacy.timing`; `plan.moved` = beide IDs, `plan.skipped` = `[]`, `commit.added` = beide IDs; Gesamtzahl 3 Legacy + 2 Kopien | G5, RVW-01/12, RVW2-19 | `legacy-assign.test.ts` |
| AC-25 | Review-Page im Browser | laden + Assign ausführen | kein `fetch`/Netzwerk, Rendering nur `textContent`, kein `web_accessible_resources`-Eintrag; die Page schreibt nur `v2` und den Sidecar | SEC-13, RVW-01 | `extension-review.test.ts`, `webstore-rules.test.ts` |
| AC-26 | Settings `auth: "secret"` / `"token"` | Hub-Request über den Worker | Header `x-bluepencil-auth: <secret>` / `authorization: Bearer <token>`; der Page-Envelope trägt keinen der beiden | SEC-14 | `extension-hub-fetch.test.ts` |
| AC-27 | Page-Envelope mit `authorization` oder `x-bluepencil-auth` | `validateHubRequest` | `disallowed_header`, kein `fetch` ausgeführt | SEC-14 | `extension-hub-fetch.test.ts` |
| AC-28 | gemountete Extension | `elementAttributesFor` + `__bluepencilConfig__` | keine `token*`-Attribute, kein `auth`; Settings ohne `token`, `tokenExpiresAt`, `deviceName` | SEC-14/FR-6.9 | `extension-handoff.test.ts` |
| AC-29 | Page ruft `get("bluepencil:settings")` | Relay | `foreign_key`; der Wert verlässt den isolated world nicht | SEC-14 | `extension-storage-relay.test.ts` |
| AC-30 | Options-Page, `auth: "secret"` / `auth: "token"` | `credentialCopy` | Secret: Hinweis nennt shared secret als veraltet/deprecated und empfiehlt signed token; Token: Label/Hinweis empfehlen per-Gerät-Token, `state` = Ablauf oder `null` | G6, RVW2-12 | `extension-credential-copy.test.ts` |
| AC-31 | `extension/manifest.json` (Quelle; kein `dist` nötig) | `webstore-rules.test.ts` | kein `host_permissions`, `optional_host_permissions` http/https, kein `content_scripts`, kein `web_accessible_resources` | SEC-20 | `webstore-rules.test.ts` |
| AC-32 | Endpoints `https://hub.example/api`, `http://127.0.0.1:8787/api`, `http://[::1]:8787/api`; Grant fehlt | `hubOriginPattern` + Save im Options-UI | Patterns `https://hub.example/*`, `http://127.0.0.1/*`, `http://[::1]/*`; `permissions.request` **und** `permissions.contains` erhalten genau diesen String; Ablehnung → `permission_denied`, kein `set` | SEC-20, RVW-03 | `extension-permissions.test.ts` |
| AC-33 | Grant fehlt zur Laufzeit (`permissions.contains` → `false`, `deps.endpoint` gesetzt) | `runHubRequest` im Worker-Pfad | `{ok:false,code:"permission_missing"}`, Meldung nennt den Origin, `fetchImpl` wird **nicht** aufgerufen; der Schritt liegt zwischen Validierung und `fetch` (nicht nur die pure Funktion); das gebaute `sw.js` übergibt an `runHubRequest` ein Deps-Objekt mit `endpoint` (aktueller `settings.endpoint`) und `permissions` (`chrome.permissions.contains`) | SEC-20, RVW3-07, RVW4-10 | `extension-hub-fetch.test.ts`, `extension-credential-isolation.test.ts` |
| AC-34 | Mount auf einer Seite über `mountOnTab` mit aufgezeichneten `MountDeps` | ausgeführter Mount | Aufrufe in der Reihenfolge bridge → bootstrap → config; der Config-Aufruf trägt `force === true`, wenn der Aufruf `force` setzte; kein `registerContentScripts`; jeder `executeScript`-Aufruf ist eine Datei- bzw. Funktions-Injektion mit genau einem Ziel | SEC-20, RVW2-02/17 | `extension-mount-execution.test.ts` |
| AC-35 | Mount/Toggle aus Tab A (`sender.tab.id = A`) über `dispatchTabMessage` | Hooks aufgezeichnet | genau ein Hook mit `tabId === A`; der `mount`-Hook erhält `tabUrl` aus `sender.tab`; kein anderer Tab; der Dispatch-Pfad kann `chrome.tabs.query` nicht aufrufen (kein Zugriff) | SEC-15, RVW2-08 | `extension-worker-dispatch.test.ts` |
| AC-36 | Tab A (Hintergrund) sendet `request-mount`, Tab B ist aktiv | `dispatchTabMessage` mit aufgezeichneten Hooks | genau ein Hook mit `tabId === A`, B wird nie adressiert; der Dispatch besitzt keinen `chrome.tabs`-Zugriff (kein `tabs.query`-Pfad); der echte Gesten-Grant ist RC-2/RC-3 (AC-70) | SEC-15, RVW3-01 | `extension-worker-dispatch.test.ts` |
| AC-37 | gebautes `sw.js`; Toolbar-Klick / Alt+Shift+B | Quelltext-Assertion + `dispatchTabMessage` | `chrome.tabs.query` kommt im gebauten Worker ausschließlich in `chrome.action.onClicked` und `chrome.commands.onCommand` vor; beide rufen `mountOnTab` mit dem aktiven Tab; kein anderer Codepfad ruft `tabs.query` | SEC-15, RVW3-01 | `smoke:ext`, `extension-worker-dispatch.test.ts` |
| AC-38 | `chrome://settings`-Tab (`tabUrl`), dritte Injection (Config) wirft; je ein Lauf über Toolbar- und Command-Pfad | `mountOnTab` mit injizierten `MountDeps` | beide liefern `{ok:false,error}`, keine unbehandelte Rejection (`unhandledrejection`-Spy bleibt leer); alle drei `executeScript`-Aufrufe sind abgedeckt | CQ-06, RVW-05 | `extension-mount-execution.test.ts` |
| AC-39 | Envelope mit `origin`/`key` im Storage-Zweig | `checkPageEnvelope` | `foreign_field`; der Fetch-Zweig ignoriert unbekannte Felder | SEC-13 | `extension-messages.test.ts` |
| AC-40 | Absender ohne `tab` mit `sender.id === own` + `tabId: 7`; mit fremder `id`; ohne `tabId`; mit `tabId: 0` / `"7"` | `resolveTabTarget` | `{kind:"explicit",tabId:7}` / `{kind:"none",code:"foreign_sender"}` / `no_tab` / `invalid_tab_id` | SEC-15, RVW-06 | `extension-tab-binding.test.ts` |
| AC-41 | Extension-Handoff | `elementAttributesFor` | `route` ist immer `"url"`, nie `"url-with-query"`; Query-Stripping bleibt S2 | SEC-19 | `extension-handoff.test.ts` |
| AC-42 | `''`, `'null'`, `null`, `undefined`; `'https://A.example:443/x'`; `42`, `'42'`, `{}`, `true`, `'file:///x'`, `'data:text/html,x'`, `'about:blank'`, `'chrome-extension://abc'`, `'   '`, 513 Zeichen | `parseOriginInput` | erste vier: `{ok:true,origin:null}`; fünfter: `{ok:true,origin:"https://a.example"}`; alle übrigen: `{ok:false,code:"invalid_origin"}` | G5, RVW-08 | `origin.test.ts` |
| AC-43 | Bundle mit Origins `a`, `b`, `null`, `a` | `inspectBundle` | `origins: ["https://a.example","https://b.example"]` sortiert, `unassigned: 1`, `notes: 4` | G5, RVW-21 | `data.test.ts` |
| AC-44 | gespeicherter Blob mit `origin:"https://A.example:443"` / `origin: 42` / ohne Feld | `coerceNote` + `parseNoteSet` Round-Trip | erster: `origin === "https://a.example"`; zweiter/dritter: `origin === null`; kein Feld verloren | G5, RVW-22 | `adapters.test.ts` |
| AC-45 | zwei Notizen gleicher `route`/`priority`, IDs `b`/`a`; `compareCodeUnits("B","a")` | `canonicalBundle` + `compareForReview` + `compareCodeUnits` | kanonische Reihenfolge entspricht der Priority-Komposition; `compareCodeUnits("B","a") < 0`; `canonical.ts` hat keine lokale Priority-/String-Kopie mehr (die Kopien in `bundle.ts`/`markdown.ts`/`aggregate.ts` bleiben, WP 4.2) | BP-07, RVW-26/RVW2-10 | `data.test.ts`, `order.test.ts` |
| AC-46 | `bluepencil:v2:`, `bluepencil:v2:null`, `bluepencil:v2:file:///x`, `bluepencil:v2:https://A.example`, `bluepencil:v2:https://a.example:443`, `bluepencil:v2:https://a.example/` (sechs nicht-kanonische Reste); `bluepencil:v2:https://a.example`, `bluepencil:default:v1`, `bluepencil:settings` | `parseNotesStorageKey` | die ersten sechs: `null`; `bluepencil:v2:https://a.example` → `{kind:"origin",origin:"https://a.example"}`; Legacy → `{kind:"legacy"}`; `settings` → `null` | SEC-13, RVW-23 | `chrome-storage.test.ts` |
| AC-47 | `relayPageStorage(area, {op:"get",keys:[keyB]}, {origin:"https://a.example"})`; Envelope mit `origin`/`key`; `storageKeyForLocation({origin:"https://a.example"})` | Relay + `storageKeyForLocation` | `foreign_key` ohne Storage-Aufruf; `invalid_envelope`; Key nur `bluepencil:v2:https://a.example`; kein Aufrufpfad kann einen Fremd-Key einspeisen | SEC-13, RVW-17 | `extension-storage-relay.test.ts` |
| AC-48 | `area === undefined`; `area.get`/`set` wirft | `relayPageStorage` | `{ok:false,code:"unavailable"}` / `{ok:false,code:"storage_failure"}`, kein Wurf nach außen | SEC-13, RVW-24 | `extension-storage-relay.test.ts` |
| AC-49 | ID `n1` liegt in `bluepencil:v2:https://b.example`, Ziel ist `a` | `planAssignToOrigin` | `{ok:false,code:"conflict"}`; kein Write-Plan, beide Stores unverändert | G5, RVW-13 | `legacy-assign.test.ts` |
| AC-50 | `ids: []`, `["  "]`; `ids: ["n99"]` (nirgends vorhanden) | `planAssignToOrigin` | `empty_selection` / `unknown_note`; kein Plan | G5, RVW-13 | `legacy-assign.test.ts` |
| AC-51 | Legacy-Blob ist `"{nicht json"`; Ziel-Blob ist `"{nicht json"` | `aggregateOriginStores` + `planAssignToOrigin` | Gruppe mit `error.code === "corrupt_blob"`, `notes: []`, andere Gruppen vollständig lesbar; Assign → `corrupt_source`, kein Write | NFR-8, RVW-10 | `extension-review.test.ts`, `legacy-assign.test.ts` |
| AC-52 | Plan gegen leeres Ziel; zwischen `beginAssign` und `commitAssign` wird `n7` in den Ziel-Store geschrieben | `commitAssign` | `{ok:false,code:"stale_plan"}`, kein `set`; `n7` bleibt erhalten; ein erneuter Plan basiert auf einem `baseText`, der `n7` enthält, und verliert `n7` beim Commit nicht | G5, RVW-11 | `legacy-assign.test.ts` |
| AC-53 | Zustand aus AC-24 | `aggregateOriginStores` + `planUndoAssign({ids:["n1"]})` | Legacy-Gruppe markiert `n1` mit `duplicate: true`, Ziel-Gruppe zeigt `n1` einmal; Undo entfernt `n1` nur aus dem Ziel-Store, Legacy behält `n1`; `removed: ["n1"]` | G5, RVW-01 | `extension-review.test.ts`, `legacy-assign.test.ts` |
| AC-54 | `auth:"none"` mit Token; `auth:"token"`; `auth:"secret"`; Token `"  "` | `authHeadersFor` + `elementAttributesFor` + Connection-Probe | `{}` und keine `token*`-Attribute; `Authorization: Bearer <tok>`; `x-bluepencil-auth: <secret>`; `{}`; die Probe sendet denselben Header wie der Worker (eine Implementierung) | FR-15.3, RVW-25 | `extension-handoff.test.ts`, `extension-hub-fetch.test.ts`, `extension-connection.test.ts` |
| AC-55 | `permission: "granted"` / `"unknown"` / `"denied"`, Store `http`; Store `chromeStorage`; Endpoint `""` / `"   "`; Endpoint `"file:///x"` / `"not a url"` | `decideSave` + `permissionState` | granted: `{ok:true,requestOrigin:null}`; unknown: `{ok:true,requestOrigin:"https://hub.example/*"}`; denied: `{ok:false,code:"permission_denied"}`, kein `set`; `chromeStorage`: `requestOrigin: null`; leerer Endpoint → `missing_endpoint`; nicht-http(s)-Endpoint → `invalid_origin`, je ohne `set`; `permissionState` bildet `contains`/`deniedPatterns` korrekt ab | G9, RVW-04, RVW3-11 | `extension-permissions.test.ts` |
| AC-56 | `tabId: 0` / `-1` / `"1"`; Toggle auf `chrome://settings`; `executeScript` wirft bei Mount | `toWorkerReply` + Worker-Pfad | `{ok:false,code:"invalid_tab_id"}`; `{ok:false,code:"toggle_failed"}`; `{ok:false,code:"mount_failed"}` — je als `WorkerReply`, nie als Wurf | RVW-24, RVW2-08 | `extension-worker-reply.test.ts`, `extension-mount-execution.test.ts` |
| AC-57 | Seite auf `file:///tmp/x`; Notiz anlegen, Tab neu laden; Bootstrap mit und ohne Konfiguration laden; Report `{kind:"mounted", ok:false, error:"memory-only: …"}` | Bootstrap + Layer + Relay + `badgeForReport` | Key `null` → `opaque_origin` → Memory-Store; Notiz überlebt den Reload nicht; `__bluepencilTryMount` wird beim Laden gesetzt, bleibt ohne Konfiguration bestehen und ist nach einem erfolgreichen Mount entfernt; `badgeForReport` liefert `{text:"mem", title:…}` für den Memory-Report und `null` für jeden anderen; der Memory-Status ist damit im UI sichtbar; Doku nennt local-Adapter oder Hub als Alternative | RVW-16, RVW2-08, RVW3-07 | `extension-bootstrap.test.ts`, `extension-worker-reply.test.ts` |
| AC-58 | 0.12-HTTP-Adapter gegen einen Hub; `NoteFilter` mit `origin: "https://a.example"`, `origin: null`, ohne Feld | `create` + `list` | der Create-Body enthält `origin` unverändert; die Liste sendet exakt `?origin=https%3A%2F%2Fa.example`, `?origin=null` bzw. keinen Parameter; **kein** Feld-Shaping, kein stilles Weglassen | RVW-15, RVW2-03 | `adapters.test.ts` |
| AC-59 | Repo-Doku | `CHANGELOG.md` + `docs/EXTENSION.md` + `docs/EMBED.md` | nennen (a) Downgrade-Warnung „clear extension storage before downgrading“ mit Confidentiality-Regression, (b) Hash-Änderung jedes Bundles, (c) `file://` memory-only, (d) **Legacy-Notizen (`origin: null`) erscheinen nach dem Upgrade nicht mehr im Page-Overlay und sind nur read-only auf der Review-Seite sichtbar**, (e) Wegfall der Options-Buttons (Toolbar/Kurzbefehl bleiben), (f) Wegfall der Token-Attribute, (g) der Default-Key von `createChromeStorageAdapter` ist per-Origin; „hosts that relied on the shared default must pass `key: chromeStorageKey()` explicitly“; die vier Dateien sind **geteilte Doku**: jeder Contract liefert nur seinen Abschnitt, **C7-docs** ist Redaktions-Eigentümer des letzten Commits (§7) | RVW-14/15/16, RVW2-05/09, RVW3-10, RVW4-07, RVW5-03 | `extension-docs.test.ts` |
| AC-60 | produktiver Adapter ohne `key`, `globalThis.location = "https://a.example/x"`; derselbe Aufruf mit `key:"bluepencil:custom:v1"`; `location.origin === "null"` | `createChromeStorageAdapter` + `get`/`set` über eine Fake-Area | erster Fall liest/schreibt ausschließlich `bluepencil:v2:https://a.example` und **nie** `bluepencil:default:v1`; expliziter Key gewinnt; opaker Origin berührt die Area nicht und ruft `onFallback` genau einmal mit `{code:"opaque_origin"}` | SEC-13, RVW2-01 | `chrome-storage.test.ts` |
| AC-61 | Page auf `https://a.example`, produktiver Adapter ohne expliziten Key + Relay; `set` mit `items: {"bluepencil:v2:https://b.example": "…"}`; danach Reload auf A | Adapter + `relayPageStorage` | `foreign_key`, kein Storage-Aufruf, B unverändert; der eigene `set` landet in `bluepencil:v2:https://a.example` und ist nach Reload vollständig | SEC-13, RVW2-01 | `chrome-storage-crossorigin.test.ts` |
| AC-62 | Stub-Hub im 0.11-Verhalten: `POST /notes` mit `origin` → `400 {"error":{"code":"unknown_field"}}`, `GET /notes` ignoriert `origin` | 0.12-HTTP-Adapter | genau ein Create-Request, Body trägt `origin`; der 400 wird unverändert durchgereicht (kein Retry ohne `origin`); die Liste sendet `origin` im Query; kein Feld-Shaping. Ein echter 0.11-Hub wird nicht gestartet — die Kombination ist Doku (RVW2-11) | RVW2-11 | `adapters.test.ts` |
| AC-63 | `credentialCopy` mit `auth:"token"` ohne/mit `tokenExpiresAt`; `auth:"secret"`; `auth:"none"` mit Rest-Token | `credentialCopy` | Token: Label nennt signed token, Hinweis empfiehlt per-Gerät-Token, `state` = Ablaufdatum bzw. `null`; Secret: deprecated-Hinweis; `none`: Hinweis auf deaktivierte Credential, `state === null` | RVW2-12 | `extension-credential-copy.test.ts` |
| AC-64 | fremde Gruppe `bluepencil:v2:https://c.example` ist `"{nicht json"`, `n1` liegt im Legacy-Blob, Ziel `a` | `planAssignToOrigin` + Review-Ableitung | `{ok:false,code:"corrupt_source"}`, kein Plan, alle Blobs unverändert; die Review-Page bietet für dieses Ziel keinen Commit an | RVW2-16 | `legacy-assign.test.ts`, `extension-review.test.ts` |
| AC-65 | `planUndoAssign` mit `origin:"file:///x"`; mit `ids:["n99"]`; Ziel-Blob `"{nicht json"`; `io.set` wirft in `commitAssign` und `commitUndoAssign` | `planUndoAssign`, `commitAssign`, `commitUndoAssign` | `invalid_origin` / `unknown_note` / `corrupt_source`; je `{ok:false,code:"storage_failure"}`, kein Wurf, Ziel im Speicher unverändert | RVW2-18 | `legacy-assign.test.ts` |
| AC-66 | Ziel-Store enthält `n1` bereits vor dem Assign (wird `skipped`), später Assign von `n2` | `commitAssign` + `planUndoAssign` | Sidecar `bluepencil:assign:<origin>` enthält nur `n2`; Undo von `n1` liefert `removed: []`, kein `set`, `n1` bleibt; Undo von `n2` entfernt `n2` und dessen Sidecar-Eintrag | RVW2-04 | `legacy-assign.test.ts`, `extension-review.test.ts` |
| AC-67 | Undo-Plan gegen Ziel mit `n2`; zwischen Plan und Commit wird `n9` in den Ziel-Store geschrieben | `commitUndoAssign` | `{ok:false,code:"stale_plan"}`, kein `set`; `n9` und `n2` bleiben; ein neuer Plan enthält `n9` | RVW2-04 | `legacy-assign.test.ts` |
| AC-68 | gebaute Options-Page; `toggle` aus einer Extension-Page ohne `tabId` | `options.html`-Text + `dispatchTabMessage` | keine Elemente `#turn-on`/`#turn-off`, dafür ein Link auf `review.html`; `toggle` ohne `tabId` → `{ok:false,code:"no_tab"}`; `docs/EXTENSION.md` nennt Toolbar/Kurzbefehl als verbleibenden Weg | RVW2-05 | `extension-options-page.test.ts`, `extension-worker-dispatch.test.ts` |
| AC-69 | **(a) Unit, sauberer Checkout:** `extension/test-manifest.mjs`, `.gitignore`, `.dockerignore`, `npm pack --dry-run`; **(b) Build, nach `Build extension (MV3)`:** `extension/dist` + `extension/dist-test` nach `buildTestGrant()`; ein Rest in `dist-test` aus einem früheren Lauf | **(a)** `extension-test-grant.test.ts`, **(b)** `smoke:ext` | **(a)** `.gitignore` und `.dockerignore` nennen `extension/dist-test/`; `npm pack --dry-run` enthält keinen `extension/`-Pfad; `buildTestGrant()` löscht `dist-test` **vor** dem Kopieren (Quelltext-Assertion) und wirft bei fehlendem `dist/manifest.json` einen benannten Fehler (Quelltext-Assertion); **(b)** `dist-test/manifest.json` ist mit `dist/manifest.json` identisch **außer** in `host_permissions` (dort exakt `["http://*/*","https://*/*"]`), der stale Rest fehlt nach dem Lauf; fehlt eine der beiden Manifest-Dateien, endet `smoke:ext` mit einem benannten Fehler — kein Skip | SEC-20, RVW3-01, RVW4-03, RVW5-01 | `extension-test-grant.test.ts`, `smoke:ext` |
| AC-70 | `docs/EXTENSION.md`, `docs/RELEASING.md` | Textprüfung | `docs/EXTENSION.md` enthält die benannten Schritte `RC-1` (Hub-Origin im Options-Save bestätigen), `RC-2` (Toolbar-Mount auf einer echten Profil-Seite), `RC-3` (Alt+Shift+B) und den Satz, dass dieser Grant-Pfad nicht automatisiert geprüft wird; `docs/RELEASING.md` führt dieselben drei Schritte als Pflichtpunkte und bindet sie an die Freigabe der geschützten `release`-Environment (AC-79) | SEC-20, RVW3-01, RVW4-06 | `extension-docs.test.ts` |
| AC-71 | Sidecar `bluepencil:assign:https://a.example` enthält `n3`, Ziel-Blob enthält `n3` nicht | `planUndoAssign` + `commitUndoAssign` | `{ok:true}` mit `removed: []`, `skipped: ["n3"]`, `remainingProvenance` ohne `n3`; genau ein `set`, Ziel-Text unverändert, Sidecar bereinigt | RVW3-11, RVW2-04 | `legacy-assign.test.ts` |
| AC-72 | `dist/data.js` nach `npm run build`; `extension/dist/review.js` nach `npm run build:ext` | Exportfläche + Review-Bundle | `dist/data.js` exportiert `parseNoteSet`, `migrateNote`, `parseNotesStorageKey`, `chromeStorageKeyForOrigin`, `assignProvenanceKey`, `parseAssignProvenance`, `planAssignToOrigin`, `beginAssign`, `commitAssign`, `planUndoAssign`, `commitUndoAssign`, `LEGACY_STORAGE_KEY`, `normaliseOrigin`, `parseOriginInput` **und die Typen `Note`/`NoteOrigin`** (`export type { Note, NoteOrigin } from "../core/model"`); `dist/types/data/index.d.ts` enthält beide Typen, sodass `review-data.d.ts` sie über `export *` liefert und `review.ts` **nicht** direkt aus `src/core/model` importiert; `review.js` baut ohne fehlenden Export; `review.ts` importiert **kein** `cloneNote` | FR-15.3, RVW3-05, RVW4-05 | `extension-review.test.ts` |
| AC-73 | `extension/src/options.ts` nach C5, danach C4b | Quelltextprüfung + `typecheck:ext` | `configuredCredential` wird aus `./credential` importiert, kein Import aus `./handoff`; nach dem Löschen des Re-Exports in C4b bleibt `npm run typecheck:ext` grün | RVW3-02 | `extension-options-page.test.ts` |
| AC-74 | `extension/src/sw.ts`, `extension/src/mount.ts` nach C4b | Quelltextprüfung | `readSettings` ist genau einmal definiert (`mount.ts`, exportiert); `sw.ts` importiert es und definiert keinen zweiten Reader und keine eigene `SETTINGS_KEY`-Konstante; `mount.ts` enthält keinen Import aus `./sw`; `sw.ts` setzt `self.__bluepencilModule = { mountOnTab }` weiterhin (Re-Export aus `./mount`), sodass Smoke und beide E2E-Suiten unverändert über den Handle mounten | RVW3-04, RVW4-09 | `extension-mount-execution.test.ts` |
| AC-75 | `extension/smoke.mjs`, `tests/e2e/parity.e2e.mjs`, `tests/e2e/round-trip.e2e.mjs`, `extension/test-manifest.mjs` | Quelltext-/Pfadprüfung + Lauf der drei Suiten | alle drei rufen `buildTestGrant()` auf und setzen ihren Extension-Pfad auf `extension/dist-test`; `parity` ruft `buildTestGrant()` **nach** seinem eigenen `extension/build.mjs`-Lauf; keine der drei Suiten lädt die Extension aus `extension/dist`; `smoke:ext`, `smoke:parity` und `smoke:round-trip` laufen grün (das Produktionsmanifest sichern AC-31/76) | SEC-20, RVW3-01, RVW4-01 | `extension-test-grant.test.ts`, `smoke:ext`, `smoke:parity`, `smoke:round-trip` |
| AC-76 | **(a) Quelltext-Ebene, sauberer Checkout (kein `dist`):** `extension/manifest.json`, `extension/src/sw.ts` bei jedem Commit von C1 bis C4b; **(b) Build-Ebene:** `extension/dist/sw.js` + `extension/dist/manifest.json` nach `npm run build:ext` | **(a)** `webstore-rules.test.ts` (Unit, `npm test`); **(b)** `smoke:webstore` (`scripts/webstore-compliance.mjs`, in `ci.yml` nach `Build extension (MV3)`) | **(a)** solange `sw.ts` `registerContentScripts` enthält, hat `manifest.json` `host_permissions`; nach C4b enthält `sw.ts` weder `registerContentScripts` noch `ensureBootstrapRegistered`, **und** `manifest.json` hat kein `host_permissions` sowie `optional_host_permissions === ["http://*/*","https://*/*"]`; **(b)** dieselbe Invariante am gebauten Artefakt: `dist/sw.js` enthält weder `registerContentScripts` noch `ensureBootstrapRegistered` genau dann, wenn `dist/manifest.json` kein `host_permissions` und die optionale Liste hat; fehlt `dist/sw.js` oder `dist/manifest.json`, ist das ein benannter FAIL (Dateiname im Output, Exit 1), kein Skip und kein Rückfall auf `extension/src`; **(c)** `mountOnTab` gegen `dist` liefert bei einer `executeScript`-Ablehnung mit „…must request permission to access this host“ `{ok:false, error}` statt eines Wurfs | SEC-20, RVW4-02, RVW5-01 | `webstore-rules.test.ts`, `smoke:webstore`, `extension-mount-execution.test.ts` |
| AC-77 | `extension/smoke.mjs`, `extension/smoke-review.mjs`, `package.json` | Quelltextprüfung | `smoke.mjs` enthält keinen Review-/Assign-/Undo-Fall; `smoke-review.mjs` existiert, lädt `extension/dist-test`, ruft `buildTestGrant()` **selbst** auf (idempotent, also auch lokal auf einem sauberen Baum lauffähig; ein fehlendes `extension/dist` ist der benannte Fehler aus `buildTestGrant()`, kein Skip), deckt die Review-Page-Fälle aus §6 ab und ist über `npm run smoke:ext:review` erreichbar; `.github/workflows/ci.yml` fügt im Test-Job genau einen Step (`Review-page smoke`, nach `smoke:ext`) hinzu | RVW4-04, RVW5-06 | `extension-review.test.ts` |
| AC-78 | `docs/WEBSTORE.md`, `scripts/webstore-compliance.mjs` | Dashboard-Copy + Guard | `docs/WEBSTORE.md` nennt `optional_host_permissions` mit `http://*/*` und `https://*/*` sowie den Grant-Zeitpunkt (erstes Speichern eines HTTP-Endpoints, im Klick-Kontext); `webstore-compliance.mjs` (C4b) verlangt `host_permissions` **abwesend**, prüft die **optionale** Liste auf genau diese beiden Muster und verbietet `<all_urls>`; ein fehlender Justification-Absatz für den optionalen Host-Zugriff ist rot (Script-Assertion C4b, Text-Assertion C5/C7-docs) | SEC-20, RVW4-08 | `webstore-rules.test.ts`, `extension-docs.test.ts`, `smoke:webstore` |
| AC-79 | `docs/RELEASING.md`, `.github/workflows/release.yml` | Textprüfung | `RELEASING.md` führt RC-1…RC-3 als Pflichtschritte der Release-Checkliste und nennt die Bedingung „Freigabe der `release`-Environment erst nach RC-Bestätigung“; der Release-Job in `release.yml` deklariert `environment: release`, sodass ohne Required-Reviewer-Freigabe nichts publiziert wird | RVW4-06 | `extension-docs.test.ts` |

## 5. Migration und Rollback

### 5.1 Bundle-Kompatibilität (kein Schema-/Bundle-Bump)

| Leser \ Schreiber | 0.11 ohne `origin` | 0.12 mit `origin` |
|---|---|---|
| **0.11** | ok | akzeptiert (optionales Feld); `migrateNote` kopiert nur bekannte Felder, `origin` geht beim Re-Export verloren |
| **0.12** | ok, `origin = null` | ok |

Es gibt **keinen** Schema-Bump und **keinen** neuen Migrationsschritt (`SCHEMA_VERSION = 1`, plain Key `bluepencil:v2:<origin>`). `migrateNote`/`migrateBundle` degradieren ungültige Origins zu `null`; nur der Hub-Create verweigert sie. **Dokumentierte Konsequenz:** der kanonische Hash jedes Bundles ändert sich, weil `origin: null` immer emittiert wird (CHANGELOG, AC-59).

### 5.2 Gemischte Versionen — breaking (RVW-15, RVW2-09)

| Kombination | Verhalten | Bewertung |
|---|---|---|
| Extension 0.11 → 0.12 | erster Start: `v2`-Stores leer, Legacy-Blob unverändert; **Legacy-Notizen (`origin: null`) erscheinen nach dem Upgrade nicht mehr im Page-Overlay**, nur read-only auf der Review-Seite; keine automatische Zuordnung | **sichtbare Regression** (Produktentscheid 2026-11-02). Grund: der Legacy-Blob hat kein `origin` und enthält alle Sites — ein Page-Kontext-Lesezugriff wäre nicht filterbar und würde SEC-13 wieder öffnen. Kein Datenverlust |
| Extension 0.12 → 0.11 (**Downgrade**) | **nicht unterstützt.** Der 0.11-Relay erlaubt `get` auf jeden Key; ein Page-Skript kann `bluepencil:v2:<origin>` lesen → SEC-13 ist für `v2`-Daten wieder offen. Daten bleiben erhalten | Confidentiality-Regression, kein Lock (RVW-14); Mitigation: CHANGELOG + `docs/EXTENSION.md` „clear extension storage before downgrading“ |
| Hub 0.11 + Client 0.12 | `POST /notes` mit `origin` → `400 unknown field`; `GET /notes?origin=…` wird vom 0.11-Hub **ignoriert** (unbekannte Query-Parameter sind dort erlaubt) und liefert alle Origins; der 0.12-Client formt das Feld **nicht** um | **breaking**, kein gemischter Betrieb; Hub und Client gemeinsam heben (RVW-15). Kein 0.11-Hub-Fixture-Test: die Kombination ist Doku, geprüft wird nur „kein Shaping“ (AC-62) |
| Hub 0.12 + Client 0.11 | ok; `origin = null`; kein Origin-Filter | ok |
| Permission-Rollback | Entzug des Hub-Origins lässt den Hub-Modus mit `permission_missing` fail-closed scheitern; Notizen bleiben lokal | Grant erneut erteilen |
| Assign-Rollback | copy-only: Undo entfernt die `v2`-Kopie und ihren Sidecar-Eintrag, der Legacy-Blob ist unberührt. Ohne Undo bleibt eine Doppel-ID (Dedupe zeigt sie an) | kein Datenverlust; Fehlzuordnung ist eine Nutzerentscheidung |

`file://`-Seiten sind **memory-only** (RVW-16): kein Origin, kein persistenter Bucket, kein gemeinsamer Store; der Zustand ist als `memory-only` im UI sichtbar (Badge `mem`/Titel), die Alternative ist der local-Adapter oder der Hub.

## 6. Sicherheitseigenschaften und Red-First-Tests

| # | Eigenschaft | Test (red first) |
|---|---|---|
| 1 | Page kann den Storage-Origin nicht spoofen; der Relay leitet den Key aus dem `location`-Like ab | `extension-storage-relay.test.ts`, `extension-messages.test.ts` |
| 2 | Fremde Keys sind unerreichbar, auch wenn der Angreifer sie kennt | `extension-storage-relay.test.ts` |
| 3 | `settings`, `ui:*`, `default:v1`, `assign:*`, `get(null)`, `get([])` sind verweigert | `extension-storage-relay.test.ts` |
| 4 | Zwei Origins teilen keinen Blob — auch über den produktiven Adapter ohne expliziten Key | `chrome-storage-crossorigin.test.ts` (AC-19/61) |
| 5 | Opaker Origin erzeugt keinen gemeinsamen Bucket; Memory-Degrade | `extension-storage-relay.test.ts`, `chrome-storage.test.ts` |
| 6 | Review-Page nur als Extension-Page, text-only, kein Netzwerk | `extension-review.test.ts`, `webstore-rules.test.ts` |
| 7 | `origin` ist Provenienz, keine Access-Control-Entscheidung; der Key ist die Grenze | `extension-review.test.ts` (AC-21) |
| 8 | Credential existiert in keiner page-lesbaren Stelle; eine Header-Abbildung | `extension-credential-isolation.test.ts`, `extension-handoff.test.ts`, `extension-hub-fetch.test.ts`, `extension-page-relay.test.ts`, `extension-connection.test.ts` |
| 9 | Kein Tab kann einen anderen mounten/togglen; fremde Absender werden abgewiesen; der Dispatch kennt keinen `tabs.query`-Pfad | `extension-tab-binding.test.ts`, `extension-worker-dispatch.test.ts`, `smoke:ext` |
| 10 | Kein persistenter MAIN-World-Script, keine All-Sites-Permission; Manifest und Worker sind atomar kompatibel | `extension-permissions.test.ts`, `extension-mount-execution.test.ts`, `webstore-rules.test.ts`, `extension-test-grant.test.ts`, `smoke:webstore` |
| 11 | Die **kanonische Ordnung** nutzt eine Comparator-Quelle; die übrigen Code-Unit-Kopien sind WP 4.2 | `data.test.ts`, `origin.test.ts`, `order.test.ts` |
| 12 | Der Legacy-Blob ist durch Assign unveränderlich (copy-only) | `legacy-assign.test.ts` (AC-24) |
| 13 | Assign und Undo schreiben nie über eine zwischenzeitliche Änderung hinweg | `legacy-assign.test.ts` (AC-52/67) |
| 14 | Undo löscht nur nachweislich kopierte IDs | `legacy-assign.test.ts` (AC-66) |
| 15 | Ein Test-Grant-Manifest verlässt den E2E-Pfad nicht und ist kein Ersatz für das Produktionsmanifest | `extension-test-grant.test.ts` (AC-69/75) |

Testdateien je Contract (red first, disjunkt): **C1** `origin.test.ts`, `data.test.ts`, `merge.test.ts`, `adapters.test.ts`, `server.test.ts`, `mcp-tools.test.ts`, `export.test.ts`, `order.test.ts`; **C2** `extension-storage-relay.test.ts`, `chrome-storage.test.ts`, `chrome-storage-crossorigin.test.ts`; **C3** `legacy-assign.test.ts`, `extension-review.test.ts`; **C4 (C4a/C4b)** `extension-credential-isolation.test.ts`, `extension-handoff.test.ts`, `extension-hub-fetch.test.ts`, `extension-page-relay.test.ts`, `extension-connection.test.ts`, `extension-credential-copy.test.ts`, `webstore-rules.test.ts` (C4b: Quelltext-Ebene von AC-31/76); **C5** `extension-permissions.test.ts`, `extension-mount-plan.test.ts`, `extension-options-page.test.ts`, `extension-test-grant.test.ts`; **C6** `extension-tab-binding.test.ts`, `extension-worker-dispatch.test.ts`, `extension-mount-execution.test.ts`; **C7-code** `extension-messages.test.ts`, `extension-bridge-fetch.test.ts`, `extension-worker-reply.test.ts`, `extension-bootstrap.test.ts`; **C7-docs** `extension-docs.test.ts`. Alle Pfade relativ zu `tests/unit/`.

End-to-End, je Contract zugeordnet:

- **C5 `smoke:ext`** — `extension/smoke.mjs` gegen **`extension/dist-test`** (Test-Grant, AC-69/75): A annotieren, B aktivieren → B sieht A nicht; Page versucht Legacy-/Fremd-Key, `assign:*` und Settings → verweigert; Reload-Persistenz; Loader- und Composer-Fälle; `file://`-Seite zeigt den `memory-only`-Status.
- **C5 `smoke:parity`** — `tests/e2e/parity.e2e.mjs` gegen `extension/dist-test`, `buildTestGrant()` **nach** dem eigenen Extension-Rebuild.
- **C5 `smoke:round-trip`** — `tests/e2e/round-trip.e2e.mjs` gegen `extension/dist-test`; derselbe geschlossene Loop (Browser → Hub → MCP-Agent → Browser) wie bisher.
- **C4b `smoke:webstore`** — `scripts/webstore-compliance.mjs` gegen `extension/dist`, nach `Build extension (MV3)`: `host_permissions` **abwesend**, `optional_host_permissions` vorhanden, `<all_urls>` verboten (AC-78); `dist/sw.js` ↔ `dist/manifest.json` als Build-Ebene der Ordnungsassertion (AC-76), fehlende Datei = benannter FAIL, kein Skip.
- **C3 `smoke:ext:review`** — `extension/smoke-review.mjs` ruft `buildTestGrant()` selbst auf (idempotent, RVW5-06) und lädt `extension/dist-test`: Review-Page listet A, B und Legacy read-only; **das Page-Overlay auf 0.12 zeigt Legacy-Notizen nicht**; Assign kopiert nach A und lässt den Legacy-Blob byte-identisch; Undo entfernt die Kopie und ihren Sidecar-Eintrag.

Die Abwesenheit von `registerContentScripts`/`ensureBootstrapRegistered` prüft `tests/unit/webstore-rules.test.ts` als Quelltext-Assertion auf `extension/src/sw.ts` (C4b, RVW3-06/AC-76); das gebaute `dist/sw.js` prüft `smoke:webstore` (Build-Ebene, C4b). Kein Check dieser beiden Ebenen ersetzt den anderen. Der echte `activeTab`-/Grant-Pfad ist nicht automatisierbar; er steht als RC-1…RC-3 in `docs/EXTENSION.md`/`docs/RELEASING.md` und ist über die `release`-Environment erzwungen (AC-70/79).

## 7. Aufwand und Datei-Eigentum

| Contract | Aufwand | Eigene Dateien (disjunkt) |
|---|---|---|
| C1 `origin`-Modell | M (2–3 PT) | `src/core/model.ts`, `src/core/origin.ts`, `src/core/adapter.ts` (`cloneNote`/`timing`/`matchesFilter`), `src/data/schema.ts`, `src/data/canonical.ts`, `src/data/merge.ts`, `src/data/migrate.ts`, `src/data/order.ts`, `src/data/bundle.ts`, `src/adapters/http.ts` (nur `toQuery`), `src/core/export/markdown.ts`, `server/handler.ts` (nur Origin-Felder), `src/mcp/tools.ts`, `tests/fixtures/bundle-0.11.json`, `tests/fixtures/bundle-0.11.hash` |
| C2 Per-Origin-Storage | M (2 PT) | `src/data/origin.ts`, `src/adapters/chrome-storage.ts`, `extension/src/storage-relay.ts`, `extension/src/bluepencil-element.d.ts` (nur Deklaration um `onFallback`/`writeFailure` erweitert, RVW3-03) |
| C3 Legacy + Assign/Undo | M (3 PT) | `src/data/note-set.ts`, `src/data/legacy-assign.ts`, `src/data/index.ts` (Re-Export-Fläche inkl. `./origin` und `export type { Note, NoteOrigin }`), `src/adapters/memory.ts` (Re-Export), `extension/src/review.ts`, `extension/src/review-data.d.ts`, `extension/review.html`, `extension/smoke-review.mjs`, `extension/build.mjs` (Entry `review`, `ELEMENT_JOBS` um `data`/`adapters`), `scripts/build.mjs` (nur `ELEMENT_JOBS`), `package.json` (nur `scripts.smoke:ext:review`) |
| C4 Credential-Isolation | M (3 PT) | `extension/src/credential.ts`, `extension/src/handoff.ts`, `extension/src/connection.ts`, `extension/src/credential-copy.ts`, `extension/src/settings.ts` (unverändert), `extension/src/hub-fetch.ts`, `extension/src/page-relay.ts`, `extension/src/sw.ts` (inkl. Seam-Re-Export), `extension/manifest.json` (**C4b**), `extension/smoke.mjs` (**nur** Host-Guard-Abschnitt, C4b), `scripts/webstore-compliance.mjs` (Guard + optionale Liste + Build-Ebene der Ordnungsassertion, C4b), `docs/EMBED.md` (Abschnitt) |
| C5 Host-Permissions + Options | M (2–3 PT) | `extension/src/permissions.ts`, `extension/src/mount-plan.ts`, `extension/src/options.ts`, `extension/options.html`, `extension/test-manifest.mjs`, `extension/smoke.mjs` (**nur** Test-Grant-/`dist-test`-Abschnitt + Entfernen der `registerContentScripts`-Erwartung), `tests/e2e/parity.e2e.mjs`, `tests/e2e/round-trip.e2e.mjs`, `.gitignore`, `.dockerignore`, `.github/workflows/ci.yml` (drei Mount-Steps), `docs/EXTENSION.md`/`docs/WEBSTORE.md` (Abschnitte) |
| C6 Tab-Bindung + Mount | S–M (1–2 PT) | `extension/src/tab-binding.ts`, `extension/src/mount.ts` |
| C7-code Message-Protokoll + Bootstrap | S–M (1,5–2 PT) | `extension/src/bridge-messages.ts`, `extension/src/bridge.ts`, `extension/src/bridge-fetch.ts`, `extension/src/bootstrap.ts`, `extension/src/detect.ts` (unverändert) |
| C7-docs Redaktions-Tail | S (≈0,5 PT) | `CHANGELOG.md`, `docs/EMBED.md`, `docs/EXTENSION.md`, `docs/WEBSTORE.md` (Abschnitte), `docs/RELEASING.md` (RC-Pflichtschritte), `.github/workflows/release.yml` (`environment: release`), `tests/unit/extension-docs.test.ts` |

Summe: ~13–16 PT (Wave 3 der Entscheidungsvorlage: 11–15 PT; +0,5–1 PT für Test-Grant/`dist-test`, die Umstellung beider E2E-Dateien und den Boundary-Commit). `src/core/origin.ts` (C1, Normalisierung) und `src/data/origin.ts` (C2, Storage-Key-Helfer) sind zwei Dateien mit je einem Vertrag; `mount.ts` gehört C6, `mount-plan.ts` C5, `sw.ts` C4 (C4b), `bootstrap.ts` C7-code.

**Merge-Reihenfolge (topologisch gegen die realen Importe, RVW2-02/06, RVW5-03): `C1 → C2 → C4a → C7-code → C5 → C6 → C4b → C3 → C7-docs`.**

| Reihenfolge | Warum sie erzwungen ist |
|---|---|
| C1 vor C2 | `src/data/origin.ts` importiert `core/origin`; `chrome-storage.ts`/`storage-relay.ts` importieren `data/origin` |
| C2 und C4a vor C7-code | `bootstrap.ts` importiert `dist/adapters/chrome-storage.js` (C2), `handoff.ts` (C4a) und `page-relay.ts` (C4, unverändert bis C4b); `bridge.ts` importiert `storage-relay.ts` (C2) |
| C4a vor C5 | `mount-plan.ts` benutzt `PageSettings`/`pageSettingsFor`; `options.ts` importiert `connection.ts`/`credential-copy.ts` |
| C5 und C7-code vor C6 | `mount.ts` benutzt `planMount`/`PageConfig` (C5) und `WorkerReply`/`toWorkerReply` (C7-code); `tab-binding.ts` gibt `WorkerReply` zurück |
| C5 vor C4b (Test-Grant zuerst) | `test-manifest.mjs`, `extension/dist-test` und die drei auf `dist-test` umgestellten Suiten landen in C5, solange `dist` noch `host_permissions` hat; der Build bleibt dadurch grün. Der Manifest-Wechsel folgt in C4b, ohne dass eine Suite rot wird (RVW4-01) |
| C6 und C5 vor C4b | `sw.ts` importiert `readSettings` aus `mount.ts` (C6, Richtung `sw → mount`, nie umgekehrt), verdrahtet `mountOnTab`/`dispatchTabMessage` und `permissions.ts` (C5); `hub-fetch.ts` (C4b) importiert `permissions.ts` (C5); `options.ts` (C5) importiert `configuredCredential` aus `credential.ts` (C4a), sodass C4b den `handoff`-Re-Export löschen darf. C4b ist der G6-Verbund (SW-Injektion und Attribut-/Config-Entfernung im selben Schritt) **und** der Boundary-Commit: `manifest.json`, die invertierten Guards und die Löschung von `ensureBootstrapRegistered`/`registerContentScripts` liegen gemeinsam hier (RVW4-02) |
| C1 und C2 vor C3 | `review.ts` importiert `dist/data.js`; `src/data/index.ts` (C3) re-exportiert `./origin` (C2) und `../core/origin` (C1); `legacy-assign.ts` nutzt `cloneNote` aus `src/core/adapter.ts` (C1) als Quell-Import |
| C7-docs **zuletzt** (nach C4b und C3) | Der Redaktions-Tail schreibt die vier geteilten Doku-Dateien als **letzten** Commit über ihnen und schreibt `extension-docs.test.ts`; C5 (Options-/Grant-/RC-Sätze), C4b (Guard-/Manifest-Sätze in `docs/EMBED.md`/`docs/EXTENSION.md`) und C3 (Legacy-/Review-Passagen) liefern ihre Abschnitte **vorher**. In der alten Reihenfolge wäre der Doku-Test am C7-Commit rot gewesen und C7 nicht der letzte Commit über den Dateien (RVW5-03). `docs/RELEASING.md` und `release.yml` hängen an keiner Code-Kante und reisen mit demselben Tail (AC-70/79) |

**Eigentumsregel (RVW4-07, RVW5-02).** Jede **Code**-Datei hat genau einen Contract. Drei benannte Ausnahmen ersetzen die frühere Absolutbehauptung „jede Datei genau einen Eigentümer“:

- **Geteilte Doku** — `CHANGELOG.md`, `docs/EMBED.md`, `docs/EXTENSION.md`, `docs/WEBSTORE.md`: jeder Contract schreibt ausschließlich seinen Abschnitt (C1/C2: Hash-/Default-Key-Sätze; C4/C4b: Token-Attribute und Guard-/Manifest-Sätze; C5: optionale Host-Permission, Options-Wegfall, RC-Sätze; C3: Legacy-/Review-Passagen). **C7-docs** ist Redaktions-Eigentümer und macht **den letzten Commit** über alle vier Dateien — nach C4b und C3, nicht vorher; `extension-docs.test.ts` (C7-docs) prüft die Abschnitte (AC-59/70/79). Die C7-Codeposition (`bridge-messages`, `bridge`, `bridge-fetch`, `bootstrap`) bleibt davon getrennt und landet als `C7-code` vor C6.
- **`.github/workflows/ci.yml`** — C5 besitzt die drei Mount-Steps (`smoke:ext`, `smoke:round-trip`, `parity`, textuell unverändert), C3 fügt genau einen Step (`Review-page smoke`) hinzu. **Keine** Reihenfolgeänderung ist nötig: die Build-Ebene der Ordnungsassertion reitet auf dem bestehenden `smoke:webstore`-Step (`ci.yml:223-227`), der bereits nach `Build extension (MV3)` (`ci.yml:214`) läuft; damit hat die `ci.yml`-Fläche weiterhin genau zwei Eigentümer (C5, C3) und **kein** dritter Contract schreibt in die Datei (RVW5-01). `package.json` gehört C3 (nur `scripts.smoke:ext:review`); der Test-Grant braucht keine Skript-Änderung, weil jede Suite `buildTestGrant()` selbst aufruft. `docs/RELEASING.md` und `.github/workflows/release.yml` sind **C7-docs allein** (nur RVW4-06 ändert sie).
- **`extension/smoke.mjs`** — dritte Ausnahme, mit **disjunkten Abschnitten**: **C5** besitzt den Test-Grant-/`dist-test`-Pfad (`buildTestGrant()` vor dem Laden, Manifest-Vergleich aus AC-69) **und** das Entfernen der `registerContentScripts`-Erwartung (spätestens in C5, damit C6 die Datei nicht rot macht); **C4b** besitzt die Invertierung des Host-Guard-Abschnitts (`host_permissions` abwesend, `optional_host_permissions` vorhanden, `<all_urls>` verboten). Reihenfolge **C5 → C4b**; die beiden Abschnitte schneiden sich nicht, und keine der beiden Parteien ändert den Abschnitt der anderen.

Kein Contract importiert aus einem späteren. Funktional wartet nur der Boundary-Commit: `manifest.json`, die invertierten Guards und die Löschung von `ensureBootstrapRegistered`/`registerContentScripts` liegen gemeinsam in C4b (RVW4-02). Der Default-`readSettings` liegt in C6, `src/data/index.ts` ist C3, `smoke.mjs` ist C5 (Test-Grant-/`dist-test`-Abschnitt) bzw. C4b (Host-Guard-Abschnitt), `test-manifest.mjs` ist C5, `smoke-review.mjs` ist C3. Zwischen C4a und C4b bleibt der Typecheck grün (Re-Export); **`npm run typecheck:ext` ist trotzdem ein Gate pro Commit** (RVW3-02). Die Unit-Testdateien aus §6 sind ebenfalls disjunkt. Cross-Spec: `server/handler.ts` berührt S1 nur in den Origin-Feldern (C1); die Auth-Pfade derselben Datei gehören S3.

Bundle (RVW3-09): **C1 und C2** landen im Element- und IIFE-Bundle — `src/adapters/chrome-storage.ts` wird über `extension/src/bootstrap.ts` und `src/core/store.ts` gebündelt, `src/data/origin.ts`/`src/core/origin.ts` kommen mit. Die Schätzung +0,3–0,6 kB gzip ist nur für C1 belegt; gemessen wird der **kombinierte** Zuwachs beider Contracts mit `npm run size` vor dem Release-Cut. Kein AC verlangt eine präventive Budget-Erhöhung (G4 = A), Erhöhung nur mit gemessener Zahl. `review.js` ist ein eigenes Extension-Asset und zählt nicht gegen das 44,2/45-kB- bzw. 47/48-kB-Budget.

Nicht abbildbar in S1: **SEC-19** (Route-/Query-Semantik, G8 = A) gehört S2; S1 pinnt nur `route="url"` (AC-41). **SEC-21** (Attribut-Gadget) ist QW/dokumentations-only und hat keinen S1-Contract. `CQ-02` bleibt bis auf den `canonical.ts`-Anteil (AC-45) Wave 4 (WP 4.2).

**Design-Stand:** Design §6 wurde am 2026-11-02 korrigiert (Relay-Signatur mit `location`, Dateitrennung `core/origin.ts`/`data/origin.ts`, `OriginGroup`/`OriginNoteView` mit `key`/`mismatched`/`error`/`duplicate`; Revisionen in Design §11). Es gibt keinen offenen Nachzug **für die S1-Contracts C1–C7**: SEC-19/G8 ist per Decisions **S2** und deshalb aus Design §1/§6/§10 entfernt — `readRoute`, `settings.includeQuery` und `route="url-with-query"` sind dort kein S1-Bestandteil mehr; S1 pinnt nur, dass die Extension `route="url"` schreibt (AC-41). Die frühere Formulierung „Design und Spec beschreiben denselben Vertrag“ gilt damit für S1, nicht für die Route-Semantik (RVW3-08).

## 8. Offene Fragen + Risiken

**Risiken.**

1. **Assign ist copy-only** (RVW-01) und damit keine Abweichung mehr von D5: der Legacy-Blob wird nie geschrieben, Undo löscht nur die `v2`-Kopie plus Provenienz. Restrisiko: Doppel-IDs (Legacy + Kopie) bis zum Undo; die Dedupe ist Pflicht, sonst erscheint eine Notiz zweimal. Fehlzuordnung bleibt eine Nutzerentscheidung; die Review-Page zeigt vor dem Schreiben den normalisierten Ziel-Origin und die Anzahl.
2. **Gemischte Versionen sind breaking** (RVW-15): 0.12-Client gegen 0.11-Hub scheitert an `origin` (unknown field) und der Origin-Filter wird ignoriert. Kein Field-Shaping im Transport, weil das eine zweite Note-Logik außerhalb von `src/data` wäre (FR-15.3). Rollout-Kopplung ist dokumentiert (AC-59/AC-62).
3. **Downgrade auf 0.11 öffnet `v2`** (RVW-14): kein Lock, keine Umbenennung (Datenverlust-Risiko), nur Doku.
4. **Settings-Verweigerung ohne vollständige SEC-14-Umstellung** wäre unvollständig; C4b ist deshalb ein Commit-Verbund (erst SW-Injection, dann Attribut-/Global-Entfernung).
5. **`commitAssign`/`commitUndoAssign` haben kein echtes CAS**: `chrome.storage.local` bietet keine Transaktion; zwischen Re-Read und `set` bleibt ein Fenster. Der Text-/Provenienz-Vergleich schließt den praktisch relevanten Fall und macht den Rest sichtbar (`stale_plan`), aber nicht atomar.
6. **Legacy-Volumen** bleibt ohne Backfill unzugeordnet; sichtbar ist es nur auf der Review-Seite, nicht im Page-Overlay (Follow-up der Entscheidungsvorlage).
7. **`element.issues` bleibt der Attribut-Diagnose vorbehalten.** Die ursprüngliche Fassung von RVW-16 nannte `element.issues` als Sichtbarkeitsort; das Element sammelt dort aber ausschließlich Attribut-/Konfigurations-Issues (`src/element/index.ts`), und ein Store→Element-Kanal wäre eine Core-Änderung außerhalb von S1. S1 macht den Zustand stattdessen über die `memory-only`-Meldung des Bootstraps (Badge `mem`/Titel, `badgeForReport`) sichtbar (AC-57); das Entscheidungsprotokoll ist entsprechend präzisiert. Das ist eine bewusste, benannte Abgrenzung, keine stille Umdeutung.
8. **G9-Testabdeckung (RVW3-01, Restrisiko).** `smoke:ext`, `smoke:parity` und `smoke:round-trip` mounten über `mountOnTab` gegen ein **Test-Grant-Manifest** (`extension/dist-test`, ein Build für alle drei, RVW4-01); die echte `activeTab`-/`optional_host_permissions`-Geste ist in headless Chromium nicht zuverlässig erzeugbar. Automatisiert geprüft sind Manifest, Seams und das Verhalten **mit** Grant; der Grant-Pfad selbst nur durch die Release-Checkliste RC-1…RC-3 (AC-70). Seit RVW4-06 ist diese Checkliste an die Freigabe der geschützten `release`-Environment gebunden (AC-79): der Release-Job kann ohne menschliche Freigabe nicht publizieren. Die Freigabe **bestätigt** die RC-Schritte, sie **beweist** ihre Durchführung nicht — der Rest ist Prozess-, nicht Code-Risiko. Eine Regression ausschließlich im `chrome.permissions.request`-Aufruf der Options-Page bliebe bis zur manuellen Prüfung unentdeckt; `decideSave`/`permissionState`/`permissionRefusal` sind unit-getestet, der Chrome-Aufruf nicht. Die Sicherheitseigenschaft „kein `host_permissions` im ausgelieferten Manifest“ wird davon **nicht** abgeschwächt (AC-31/AC-69/`smoke:webstore`).
9. **Review-Page-Import (RVW3-05, Restrisiko).** `review.ts` bündelt den **gebauten** `dist/data.js`; ein veraltetes Artefakt würde eine alte Aggregation ausliefern. `scripts/build.mjs` rebuildet die Extension bei `data`/`adapters`-Änderungen (`ELEMENT_JOBS`), AC-72 prüft die Exportfläche, aber nicht die Byte-Identität des gebündelten Codes. `verify:sync` deckt weiterhin nur das Element-Bundle ab; die Review-Page ist ein eigenes Asset ohne eigenen Digest.
10. **Port-Ausweitung des optionalen Host-Grants (RVW4-11).** Chrome-Match-Patterns kennen keinen Port: `https://hub.example:9443/api` grantet `https://hub.example/*`, also jeden Port dieses Hosts. Akzeptiert — Chrome-Grenze; der Default-Hub `http://127.0.0.1:8787` braucht überhaupt ein portfreies Pattern. Andere Hosts sind nicht umfasst, und der Worker prüft zusätzlich Endpoint-Origin **und** Base-Pfad (`{base}/admin` bleibt verweigert).
11. **`dist-test` ist ein zweites Manifest mit `host_permissions` (RVW4-03).** Es ist Build-Artefakt: in `.gitignore`/`.dockerignore`, wird vor jedem Kopieren gelöscht, von `build:ext` nicht gelesen, von Release- und Extension-Workflow nicht gezippt und vom npm-Tarball (Allowlist ohne `extension/`) nicht erfasst (AC-69). Restrisiko: ein künftiges Paket-/Docker-Ziel, das `extension/` pauschal einsammelt, müsste `dist-test` explizit ausschließen; die Ignore-Einträge sind die eine Stelle dafür.

**Entschieden und nicht mehr offen (keine offenen Fragen).**

- **Q1** Options-Buttons „Turn on/off here“: **entfernt** (RVW2-05). Ohne `tabs`-Permission und ohne `sender.tab` kann ein Options-Page-Toggle keinen Ziel-Tab benennen; `tabs` widerspricht G9. Toolbar und Alt+Shift+B bleiben.
- **Q2** Neuer `v2`-Key beim Assign: **ja**, genau ein neuer Key (`baseText === ""`), aber nur nach expliziter Bestätigung des normalisierten Ziel-Origins und der Anzahl der Kopien (Ruling aus Review 2).
- **Q3** Legacy im Page-Kontext: **unsichtbar** (Produktentscheid 2026-11-02). Ein read-only-Lesezugriff wäre nicht filterbar und würde SEC-13 wieder öffnen; sichtbar nur auf der Review-Seite (§5.2, AC-59).
- Merge statt Skip bei vorhandenen Ziel-IDs: **`skipped`** (RVW-01/13). Automatischer Retry ohne `origin` gegen einen 0.11-Hub: **nein** (RVW-15). `?origin=null` als unassigned: **ja**.

## 9. Annahmen

| # | Annahme | Ruling | Konsequenz im Dokument |
|---|---|---|---|
| A1 | `normaliseOrigin` kann in `src/core` liegen, ohne eine Core-zu-Data-Kante zu erzeugen | **akzeptiert** | `src/core/origin.ts`; `NoteOrigin` nur als `import type`, kein Laufzeit-Zyklus |
| A2 | `src/data/origin.ts` ist gleichzeitig Re-Export (C1) und Implementierung der Key-Helfer (C2) | **falsch → verworfen** | getrennt: `core/origin.ts` (C1) und `data/origin.ts` (C2), kein Re-Export (§2, §7) |
| A3 | Der Codec-Umzug nach `src/data/note-set.ts` mit Re-Export aus `adapters/memory.ts` ist zyklusfrei und API-stabil | **akzeptiert** | C3; setzt `coerceNote`-Origin-Unterstützung voraus (AC-44) |
| A4 | `origin` steht nach `updatedAt`/vor `sessionRef`, wird immer emittiert, origin-first sortiert; der Hash jedes Bundles ändert sich | **akzeptiert** | AC-03/04/05, §5.1, AC-59 |
| A5 | `normaliseOrigin` (invalid → `null`) genügt für die strikte Hub-Ablehnung | **falsch → verworfen** | `parseOriginInput` (AC-42) |
| A6 | Optionale Host-Permissions plus `activeTab` erlauben weiterhin einen page-initiierten Mount | **akzeptiert mit Präzisierung** | `request-mount` ist Re-Mount im bereits aktivierten Tab; ohne Injektion existiert kein Bridge-Kanal (§2 C5) |
| A7 | `sender.tab` allein unterscheidet Content-Script- und Extension-Page-Absender | **falsch → verworfen** | `MessageSenderLike.id` + `ownExtensionId` (AC-40) |
| A8 | Die Review-Page aggregiert Legacy lesend, während Assign Notizen verschiebt | **falsch → verworfen** | copy-only, Legacy nie geschrieben (AC-24/53) |
| A9 | `origin` ist Provenienz, keine Access-Control-Entscheidung; der Hub akzeptiert caller-supplied `origin` | **akzeptiert, Ziel-Satz entschärft** | §1.2: „keinen Hub-Request an ein fremdes Ziel fälschen“; `origin` bleibt Provenienz |
| A10 | Kein Schema-Bump, plain Key, Budget-Schätzung +0,3–0,6 kB | **akzeptiert** | G5 korrigiert; `npm run size` bleibt der Gate (§7) |
| A11 | Chrome-Match-Patterns unterstützen einen Port | **falsch → verworfen** | `hubOriginPattern` nutzt `hostname`, Port elidiert (AC-32) |
| A12 | `chrome.permissions.contains` unterscheidet „nie gefragt“ und „abgelehnt“ | **falsch → verworfen** | session-scoped `denied`-Set + `permissionState` (AC-55) |
| A13 | `chrome.storage.local` bietet Compare-and-Set/Transaktionen | **falsch → verworfen** | Re-Read + Textvergleich, `stale_plan`, Restfenster dokumentiert (§8 Risiko 5) |
| A14 | Die Review-Page kann copy-only-Duplikate per ID deduplizieren | **akzeptiert** | `OriginNoteView.duplicate`, `mismatched` (AC-21/53) |
| A15 | Der produktive Adapter kann seinen Key aus `globalThis.location` ableiten, ohne dass die Page ihn bestimmt | **akzeptiert** | der Key ist ein Hinweis; der Relay prüft ihn gegen den isolated-world-Key (AC-60/61) |
| A16 | Ein Sidecar `bluepencil:assign:<origin>` ist page-unerreichbar | **akzeptiert** | Relay verlangt exakt den Notiz-Key; `parseNotesStorageKey` liefert für den Sidecar `null` (AC-16/20) |

## 10. Abgleich

### 10.1 Erste Review — RVW-01 … RVW-26

| RVW | Wo behoben (Abschnitt/AC) | Status |
|---|---|---|
| RVW-01 | §2 C3 (copy-only, `AssignPlan`, Undo mit Provenienz), §3 C3, §5.2, AC-24, AC-53, AC-59, AC-66/67 | behoben |
| RVW-02 | Header, §1.2, §2 C1 (kein Bump, plain Key, Hash-Konsequenz), §5.1, AC-05 | behoben |
| RVW-03 | §2 C5 (`url.hostname`), AC-32 | behoben |
| RVW-04 | §2 C5 (`PermissionState`, `permissionState`, `decideSave`), §3 C5, AC-55 | behoben |
| RVW-05 | §2 C6 (dritter `executeScript`, ganze Sequenz), AC-38 | behoben |
| RVW-06 | §2 C6 (`id?: string`, `ownExtensionId`), AC-40 | behoben |
| RVW-07 | §2 C1/C2 (Dateitrennung), §2 C6 (`mount.ts` → C6), §7 (Tabelle + Reihenfolge C4a/C4b) | behoben |
| RVW-08 | §2 C1 (`parseOriginInput`), AC-10/11/42 | behoben |
| RVW-09 | §2 C3 (`OriginNoteView`, `mismatched`), AC-21 | behoben |
| RVW-10 | §2 C3 (`error`, `corrupt_source`), §3 C3, AC-51 | behoben |
| RVW-11 | §2 C3 (`baseText`, `stale_plan`), AC-52, AC-67 | behoben |
| RVW-12 | §2 C3 (`cloneNote`, kein `createNote`), AC-24 | behoben |
| RVW-13 | §2 C3 (Prüf-Reihenfolge, `conflict`/`empty_selection`/`unknown_note`), AC-49/50, AC-64/65 | behoben |
| RVW-14 | §5.2 (Downgrade-Zeile, Confidentiality-Regression, kein Lock), AC-59(a) | behoben |
| RVW-15 | §5.2 (0.11-Hub-Zeile, keine Feldformung), §8 Risiko 2, AC-58/59/62 (Scope: Doku) | behoben |
| RVW-16 | §5.2 (`file://` memory-only), §2 C2 (`onFallback`), AC-57/59(c), §8 Risiko 7 | behoben (Abgrenzung `element.issues`) |
| RVW-17 | §2 C2 (`relayPageStorage(…, location)`, `storageKeyForLocation`), §3 C2, AC-47 | behoben |
| RVW-18 | §1.3 (S4/WP 0.1 als harte Voraussetzung), §1.4 (Status-Spalte), AC-Spalte „Finding“ | behoben |
| RVW-19 | §9 Annahmen (A1–A16 mit Ruling) | behoben |
| RVW-20 | Header `Status: Entwurf` | behoben |
| RVW-21 | §2 C1 (`BundleSummary`), AC-43 | behoben |
| RVW-22 | AC-44 (`coerceNote`/`parseNoteSet` Round-Trip) | behoben |
| RVW-23 | §2 C2 (`parseNotesStorageKey`-Validierung), AC-17/46 | behoben |
| RVW-24 | AC-48, AC-56 (`WorkerReply`), AC-40 (`foreign_sender`) | behoben |
| RVW-25 | §2 C4 (`credential.ts` als einzige Abbildung), AC-54/63 | behoben |
| RVW-26 | §2 C1 (Dedupe in `canonical.ts`), §7 (CQ-02-Rest = WP 4.2), AC-45 | behoben (Anspruch auf die kanonische Ordnung verengt) |

### 10.2 Zweite Review — RVW2-01 … RVW2-20

| RVW2 | Wo behoben (Abschnitt/AC) | Status |
|---|---|---|
| RVW2-01 | §2 C2 (Key-Ableitung im produktiven Adapter, expliziter Key gewinnt, `null` → Memory), §3 C2(6), §7 (C2 besitzt `chrome-storage.ts` + `bluepencil-element.d.ts`), AC-60/61, Design §3.2/§6 | behoben |
| RVW2-02 | §2 C6 (C6 besitzt die ganze Sequenz inkl. `mainWorldHandoff`, `ensureBootstrapRegistered` entfällt), §7 (Reihenfolge C5→C6, Hilfsdateien), AC-34 (ausgeführter Mount) | behoben |
| RVW2-03 | §2 C1 (`src/adapters/http.ts`/`toQuery`), §7 C1, AC-58 (Query-String + Body) | behoben |
| RVW2-04 | §2 C3 (Sidecar `bluepencil:assign:<origin>`, Provenienz, CAS für Undo), §3 C3, AC-16/20/53/66/67, §6 Eigenschaften 13/14 | behoben |
| RVW2-05 | §2 C5 (Options-Page gehört C5), §7 (C5: `options.html`; C3 ohne), AC-68, AC-59(e), §8 Q1 | behoben |
| RVW2-06 | §2 C4a (`connection.ts` + Re-Export-Strategie), §2 C4 **Options-Import**, §7 (Reihenfolge C4a vor C7-code vor C5, C4b; `typecheck:ext` pro Commit), AC-73 | behoben (RVW3-02) |
| RVW2-07 | Design §6/§3.2/§5/§11 korrigiert (kein „Folge-Pass“), §7 „Design-Stand“ | behoben |
| RVW2-08 | §2 C7 (`toWorkerReply`, `WorkerReply`), §2 C6 (`runMountStep`, `mountOnTab`-Deps, `dispatchTabMessage`), §2 C7 Bootstrap-Vertrag, AC-34/35/37/38/56/57 auf beobachtende Dateien umgestellt | behoben |
| RVW2-09 | §1.2, §5.2 (sichtbare Regression), AC-59(d), §8 Q3; Entscheidungsprotokoll G5 nachgezogen | behoben |
| RVW2-10 | §2 C1 Konsequenz (2), §6 Eigenschaft 11, AC-45: Anspruch auf die kanonische Ordnung verengt; `bundle.ts`/`markdown.ts`/`aggregate.ts` = WP 4.2 | behoben |
| RVW2-11 | AC-62 (No-Shaping gegen 0.11-Stub), §5.2 (Scope: kein 0.11-Hub-Test, Doku) | behoben (gewählte Option „Doku-Scope + No-Shaping“) |
| RVW2-12 | AC-30 (Token-Copy), AC-63 (Token-/Secret-/None-Zustände), AC-54 | behoben |
| RVW2-13 | §2 C1 (`validateNote` akzeptiert `undefined`/fehlend, `null`, kanonisch), AC-06 | behoben |
| RVW2-14 | AC-08 (`onConflict:"keep-existing"`/`"keep-incoming"`, `conflicts`, `skipped`/`updated`) | behoben |
| RVW2-15 | §7 C1 (`tests/fixtures/bundle-0.11.json` + `.hash`), AC-05 (Erzeugung im Test dokumentiert) | behoben |
| RVW2-16 | §2 C3 (Prüf-Reihenfolge: jede fremde korrupte `v2`-Gruppe → `corrupt_source`), AC-64, AC-51 | behoben |
| RVW2-17 | §2 C5 (`PageConfig.force`, `MountStep`-Reihenfolge), AC-34 | behoben |
| RVW2-18 | AC-65 (drei Plan-Fehlercodes, werfendes `io.set` in Assign und Undo) | behoben |
| RVW2-19 | §2 C1 Konsequenz (3) (`cloneNote` kopiert `timing` tief), AC-24 (`copy.timing !== legacy.timing`) | behoben |
| RVW2-20 | §7 C2 (`bluepencil-element.d.ts` zugeordnet), §2 C2 Deklaration erweitert, **Runtime-Signatur unverändert**, AC-60 | behoben (Präzisierung RVW3-03) |

### 10.3 Dritte Review — RVW3-01 … RVW3-14

| RVW3 | Wo behoben (Abschnitt/AC) | Status |
|---|---|---|
| RVW3-01 | §2 C5 Test-Strategie (Seam + RC-1…RC-3 + ein Test-Grant für alle drei Suiten), §6 E2E, AC-36/37/38/69/70/75, §7 C5 (`test-manifest.mjs`, beide E2E-Dateien) | behoben (Review 4: teilweise; über RVW4-01 geschlossen) |
| RVW3-02 | §2 C4 **Options-Import** + `typecheck:ext` pro Commit, §7 Merge-Kante C5 vor C4b, AC-73 | behoben |
| RVW3-03 | §2 C2 **Deklaration** (`onFallback`/`writeFailure`), Runtime-Signatur unverändert, AC-57 | behoben |
| RVW3-04 | §2 C6 `readSettings`/`MountDeps`-Default, §3 C4/C6, §7 (`sw → mount`, nie umgekehrt), AC-74 | behoben |
| RVW3-05 | §2 C3 (`src/data/index.ts`, `review-data.d.ts`, Importfläche, `cloneNote` nur Quell-Import), §3 C3, §7, AC-72, §8/9 | behoben |
| RVW3-06 | §2 C5 Punkt 3/6 (Guard-Invertierung in C4b, `registerContentScripts`-Assertion in C4b), §6 E2E, AC-77 | behoben (Review 4: teilweise; über RVW4-02/04 geschlossen) |
| RVW3-07 | §2 C4 (`HubFetchDeps.endpoint`/`permissions`, Prüfschritt vor `fetch`), §2 C7 (`badgeForReport`), §3 C4, AC-33/57 | behoben |
| RVW3-08 | Design §1/§6/§10 + Revisionseintrag (SEC-19 → S2), §7 Design-Stand, AC-41 unverändert | behoben (Design-Diff) |
| RVW3-09 | §1.4 NFR-3, §7 Bundle (C1 **und** C2, kombinierte Messung) | behoben |
| RVW3-10 | §2 C2 **Default-Key** + Host-Hinweis, AC-59(g) | behoben |
| RVW3-11 | AC-12 (`list_notes` mit Filter), AC-55 (`missing_endpoint`/`invalid_origin`), AC-71 (Provenienz ohne Ziel) | behoben |
| RVW3-12 | AC-05 („C1 legt beide Fixtures im C1-Commit an“) | behoben (Info) |
| RVW3-13 | keine Aktion; 0.11-Hub-Stub-Scope in §5.2/AC-62 bleibt akzeptiert | geschlossen (Info, akzeptiert) |
| RVW3-14 | §7 C1 (`matchesFilter`) | behoben (Info) |

### 10.4 Vierte Review — RVW4-01 … RVW4-11

| RVW4 | Wo behoben (Abschnitt/AC) | Status |
|---|---|---|
| RVW4-01 | §2 C5 Test-Strategie Punkte 4/6 (ein `buildTestGrant()` für alle drei Suiten, `parity` nach eigenem Rebuild), §6 E2E (je Contract), §7 C5 (`test-manifest.mjs`, beide E2E-Dateien), AC-69/75 | behoben |
| RVW4-02 | §2 C4 „C4b ist der Boundary-Commit“, §2 C5 Punkt 3, §7 (C4b besitzt `manifest.json`/Guards; Kante C5 → C4b), AC-76 | behoben |
| RVW4-03 | §2 C5 Punkt 5, §7 C5 (`.gitignore`, `.dockerignore`), §8/11, AC-69 | behoben |
| RVW4-04 | §2 C5 „Review-Page-Smoke“, §6 E2E (C3-Suite), §7 (C3: `smoke-review.mjs`, `package.json`; `ci.yml`-Carve-out), AC-77 | behoben |
| RVW4-05 | §2 C3 (`src/data/index.ts` exportiert `Note`/`NoteOrigin`), §7 C3, AC-72 | behoben |
| RVW4-06 | §2 C5 Punkt 2, §6 E2E, §7 C7-docs (`docs/RELEASING.md`, `release.yml`), §8/8, AC-70/79 | behoben |
| RVW4-07 | §7 „Eigentumsregel“ (geteilte Doku + `ci.yml`-Carve-out, C7-docs-Redaktion), AC-59 | behoben |
| RVW4-08 | §2 C5 Punkt 3, §7 C4/C5 (`webstore-compliance.mjs`), AC-78 | behoben |
| RVW4-09 | §2 C4 „C4b ist der Boundary-Commit“ (Seam bleibt), §7 C4, AC-74 | behoben (Info) |
| RVW4-10 | §2 C4 „Permission-Prüfung“ (Worker injiziert beide), AC-33 | behoben (Info) |
| RVW4-11 | §2 C5 „Grenzen“, §8/10 | behoben (Info) |

### 10.5 Fünfte Review — RVW5-01 … RVW5-06

| RVW5 | Wo behoben (Abschnitt/AC) | Status |
|---|---|---|
| RVW5-01 | §2 C4b „Die Ordnungsassertion ist zweigeteilt“ (Quelltext-Ebene `webstore-rules.test.ts` ohne `dist`; Build-Ebene `smoke:webstore` nach `Build extension (MV3)`, fehlende Datei = benannter FAIL), §2 C5 Punkt 3/6, §6 E2E (`C4b smoke:webstore`), AC-31, AC-69 (a/b), AC-76 (a/b/c), §7 `ci.yml`-Carve-out (keine Umordnung nötig, weiterhin zwei Eigentümer) | behoben |
| RVW5-02 | §2 C4b (smoke-Abschnitte), §2 C5 Punkte 3/4/6, §2 C5 „Review-Page-Smoke“, §7 Eigentumsregel **dritte benannte Ausnahme** (C5 = Test-Grant/`dist-test` + Entfernen der `registerContentScripts`-Erwartung; C4b = Host-Guard-Invertierung; Reihenfolge C5 → C4b, disjunkt), §7 Tabellenzeilen C4/C5 | behoben |
| RVW5-03 | §7 Zeile `C7-code` / `C7-docs` (Redaktions-Tail **zuletzt**, nach C4b und C3: vier geteilte Docs, `docs/RELEASING.md`, `release.yml`, `extension-docs.test.ts`), §7 Merge-Reihenfolge + neue Kante, §6 Testdatei-Zuordnung, AC-59 (C7-docs) | behoben |
| RVW5-04 | §6 E2E: `smoke:webstore` von **C5** auf **C4b** gelabelt — dieselbe Zuordnung wie §7 und AC-78 | behoben |
| RVW5-05 | §2 C3 bindender Block `src/data/index.ts` enthält `export type { Note, NoteOrigin } from "../core/model"` (deckungsgleich mit §7 C3 und AC-72) | behoben (Info) |
| RVW5-06 | §2 C5 Punkt 4 und „Review-Page-Smoke“: `smoke-review.mjs` ruft `buildTestGrant()` **selbst** auf (idempotent, lokal lauffähig); AC-77 verlangt es und nennt den benannten Fehler statt Skip | behoben (Info) |

**Zählung.** RVW: **26 / 0 / 0**. RVW2: **20 / 0 / 0** (RVW2-06 vollständig über RVW3-02). RVW3: zum Stand Review 4 **9 behoben / 2 teilweise / 0 offen** (RVW3-01, RVW3-06); nach RVW4-01 (→ RVW3-01) und RVW4-02/04 (→ RVW3-06) **11 / 0 / 0** — die frühere 11/0/0-Behauptung war zum Zeitpunkt von Review 4 überzeichnet; Info **RVW3-12/14 behoben, RVW3-13 akzeptiert**. RVW4: **11 behoben / 0 / 0** (8 Major/Minor + 3 Info). RVW5: **6 behoben / 0 / 0** (1 Major, 3 Minor, 2 Info) — alle sechs in dieser Fassung geschlossen, keiner still übersprungen.
Bewusst gewählte Optionen statt der jeweils anderen Review-Alternative: RVW2-11 (Doku-Scope für den 0.11-Hub statt Spinnen eines 0.11-Hubs — die Option ist im Review ausdrücklich zugelassen) und RVW-16/`element.issues` (UI-Status statt Core-Kanal; §8 Risiko 7). Bei RVW3-01 ist die im Review **bevorzugte** Option gewählt (Seam + manuelle Checkliste + invertierte Guards), ergänzt um das Test-Grant-Manifest. Bei RVW4-01 ist die im Review **zuerst genannte** Option gewählt (ein gemeinsamer Test-Grant-Build für alle drei mountenden Suiten); die Alternative — `parity`/`round-trip` aus dem G9-Gate nehmen — ist ausdrücklich **verworfen**, nicht still. Bei RVW5-01 sind die Review-Optionen **(a) und (c) kombiniert**: die Ordnungsassertion läuft als **Quelltext-Beobachtung im Unit-Test** (c) und als **Post-Build-Vergleich in `smoke:webstore`** (a); Option (b) — `Build`/`Build extension (MV3)` vor die Unit-Tests ziehen — ist **verworfen**, weil sie jeden Unit-Test-Lauf an einen Extension-Build koppelt und die `ci.yml`-Fläche einem dritten Eigentümer öffnet. Kein Befund wurde still übersprungen.

## 11. Abgleich — Zählung und Reststatus (fünf Ebenen)

| Ebene | behoben | teilweise | offen | Bemerkung |
|---|---|---|---|---|
| RVW-01…RVW-26 | 26 | 0 | 0 | RVW-16 mit benannter Abgrenzung (`element.issues`, §8/7); Einzelnachweis §10.1 |
| RVW2-01…RVW2-20 | 20 | 0 | 0 | RVW2-06 war in Review 3 „teilweise“; über RVW3-02/C5 geschlossen; Einzelnachweis §10.2 |
| RVW3-01…RVW3-14 | 11 | 0 | 0 | **History:** Review 4 zählte 9 / 2 / 0 (RVW3-01, RVW3-06 teilweise). Erst RVW4-01 (→ RVW3-01) und RVW4-02/04 (→ RVW3-06) schließen die beiden; Info RVW3-12/14 behoben, RVW3-13 akzeptiert; Einzelnachweis §10.3 |
| RVW4-01…RVW4-11 | 11 | 0 | 0 | 01–08 behoben (2 Major, 6 Minor), 09–11 behoben (Info); Einzelnachweis §10.4 |
| RVW5-01…RVW5-06 | 6 | 0 | 0 | 01 Major, 02–04 Minor, 05/06 Info; Schließung in dieser Fassung, Verifikation durch den sechsten Review-Pass; Einzelnachweis §10.5 |

Zum Stand dieser sechsten Fassung ist **kein Review-Befund aus den fünf Pässen mehr offen**; RVW4-01…RVW4-11 sind in §10.4, RVW5-01…RVW5-06 in §10.5 einzeln belegt. Die Freigabe behauptet diese Fassung nicht — die Verifikation leistet der sechste Review-Pass (`Status: Entwurf`). Verbleibende, bewusst akzeptierte Restrisiken: Legacy unsichtbar im Overlay (§5.2), Downgrade (§8/3), CAS-Restfenster (§8/5), gemischte Versionen (§8/2), G9-Testabdeckung inkl. erzwungener RC-Freigabe (§8/8), Review-Page-Digest (§8/9), Port-Ausweitung des Grants (§8/10), `dist-test`-Hygiene (§8/11). Die AC-Tabelle umfasst **79 Kriterien** (AC-01…AC-79); jedes nennt eine beobachtende Datei oder einen Step (`npm test`/`typecheck:ext`/`smoke:ext`/`smoke:parity`/`smoke:round-trip`/`smoke:ext:review`/`smoke:webstore`).

## 12. Trace-Anker

`spec-id: SPEC-s1-extension-trust-boundary` — der Plan referenziert diesen Wert. Upstream-Design `SPEC-origin-note-context` bleibt im Anker unverändert; §6/§3.2/§5 des Designs wurden am 2026-11-02 an diese Spec angeglichen (Revisionen dort). Die Implementierung startet erst nach `Status: APPROVED` und nach S4/WP 0.1 (§1.3).
