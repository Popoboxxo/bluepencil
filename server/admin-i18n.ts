/**
 * The admin page's string table (FR-11.1) — flat, typed, and shared by the server-side markup and
 * the page's own JavaScript runtime.
 *
 * Rules:
 *  - every user-visible string of the admin page lives here; no literals in `server/admin-html.ts`
 *    markup or in its embedded script;
 *  - `de` is typed as `AdminStrings`, so a missing translation is a compile error, never a raw key
 *    on the page;
 *  - `{name}` placeholders are substituted by the page's small `fmt()` helper;
 *  - `lang` is the value for `<html lang>`, which is also what `adminLanguage()` selects;
 *  - dependency-free: this module is a plain object and one pure function.
 */

/** Every string the admin page renders, in one flat namespace. */
export interface AdminStrings {
  /** The document language, also rendered as `<html lang>`. */
  lang: "en" | "de";

  /* -- document ----------------------------------------------------------- */
  title: string;
  brandAdmin: string;
  notConnected: string;

  /* -- connect ------------------------------------------------------------ */
  connectHeading: string;
  connectHelp: string;
  secretPlaceholder: string;
  secretLabel: string;
  connectButton: string;
  rememberLabel: string;
  rememberWarning: string;
  typeSecretFirst: string;
  checking: string;
  connected: string;
  connectionLine: string;

  /* -- tabs --------------------------------------------------------------- */
  sectionsLabel: string;
  tabOverview: string;
  tabNotes: string;
  tabDevices: string;
  tabActivity: string;

  /* -- overview ----------------------------------------------------------- */
  overviewHub: string;
  overviewEnvironment: string;
  overviewNotes: string;
  overviewClientCredential: string;
  overviewAcceptedCredentials: string;
  overviewTokenIssuing: string;
  overviewRevocation: string;
  overviewIssuedCredentials: string;
  overviewReadOnly: string;
  overviewFederates: string;
  credentialToken: string;
  credentialSecret: string;
  credentialTokenAndSecret: string;
  credentialKindToken: string;
  credentialKindSecret: string;
  credentialNone: string;
  issuingAvailable: string;
  issuingUnavailable: string;
  revocationDurable: string;
  revocationLive: string;
  yes: string;
  no: string;
  federatesYes: string;
  federatesNo: string;
  issuedCredentialsSummary: string;

  /* -- presence ----------------------------------------------------------- */
  presenceHeading: string;
  presenceHelp: string;
  presenceToken: string;
  presenceSecret: string;
  presenceNever: string;

  /* -- notes -------------------------------------------------------------- */
  notesHeading: string;
  notePlaceholder: string;
  noteLabel: string;
  routePlaceholder: string;
  routeLabel: string;
  addButton: string;
  reloadButton: string;
  notesEmpty: string;
  typeNoteFirst: string;
  adding: string;
  notesCount: string;
  colBody: string;
  colRoute: string;
  colStatus: string;
  colAuthor: string;
  colActions: string;
  statusOpen: string;
  statusDone: string;
  doneButton: string;
  reopenButton: string;

  /* -- devices ------------------------------------------------------------ */
  devicesHeading: string;
  noIssuingBanner: string;
  deviceNamePlaceholder: string;
  deviceNameLabel: string;
  deviceTtlPlaceholder: string;
  deviceTtlLabel: string;
  scopeLabel: string;
  scopeReadWrite: string;
  scopeReadOnly: string;
  mintButton: string;
  nameDeviceFirst: string;
  ttlError: string;
  issuing: string;
  devicesEmpty: string;
  devicesInventoryNote: string;
  statusOk: string;
  loading: string;
  colDevice: string;
  colScope: string;
  colIssued: string;
  colExpires: string;
  colState: string;
  colJti: string;
  stateLive: string;
  stateRevoked: string;
  revokeButton: string;
  revokeConfirm: string;
  revoking: string;
  devicesErrorBanner: string;

  /* -- minted token ------------------------------------------------------- */
  tokenHeading: string;
  tokenHelp: string;
  tokenLabel: string;
  copyButton: string;
  dismissButton: string;
  copied: string;
  copyFailed: string;

  /* -- activity ----------------------------------------------------------- */
  activityHeading: string;
  activityHelp: string;
  activityEmpty: string;
  activityCount: string;
  colWhen: string;
  colWho: string;
  colWhat: string;
}

/** English — the default rendering (`ADMIN_HTML`) and the reference for every key. */
const en: AdminStrings = {
  lang: "en",

  title: "Bluepencil — admin",
  brandAdmin: "admin",
  notConnected: "not connected",

  connectHeading: "Connect",
  connectHelp:
    "The hub's admin secret (--admin-secret). Kept in memory while this page is open, sent as x-bluepencil-admin.",
  secretPlaceholder: "admin secret",
  secretLabel: "Admin secret",
  connectButton: "Connect",
  rememberLabel: "Remember in this tab",
  rememberWarning:
    "Remembering stores the secret in this tab's session storage. Any script from this origin can read it — only do this on a machine you trust.",
  typeSecretFirst: "Type the admin secret first.",
  checking: "checking…",
  connected: "connected",
  connectionLine: "{name} · v{version} · {environment} · {notes} note(s) · {issued} issued",

  sectionsLabel: "Sections",
  tabOverview: "Overview",
  tabNotes: "Notes",
  tabDevices: "Issued client credentials",
  tabActivity: "Activity",

  overviewHub: "Hub",
  overviewEnvironment: "Environment",
  overviewNotes: "Notes",
  overviewClientCredential: "Client credential",
  overviewAcceptedCredentials: "Accepted credentials",
  overviewTokenIssuing: "Token issuing",
  overviewRevocation: "Revocation",
  overviewIssuedCredentials: "Issued client credentials",
  overviewReadOnly: "Read-only",
  overviewFederates: "Federates",
  credentialToken: "signed token (--token-key)",
  credentialSecret: "shared secret (--auth-secret)",
  credentialTokenAndSecret: "signed token (--token-key) + shared secret (--auth-secret)",
  credentialKindToken: "token",
  credentialKindSecret: "shared secret",
  credentialNone: "none",
  issuingAvailable: "available",
  issuingUnavailable: "not available — this hub has no --token-key",
  revocationDurable: "durable (--revoked-tokens file)",
  revocationLive: "live only — lost on restart (no --revoked-tokens file)",
  yes: "yes",
  no: "no",
  federatesYes: "yes (registry configured)",
  federatesNo: "no",
  issuedCredentialsSummary: "{issued} issued ({revoked} revoked)",

  presenceHeading: "Last accepted credential",
  presenceHelp:
    "The honest limit: the hub records note writes and the client credentials it issued — one row per token, not one per connected browser. Readers are not tracked as individual clients. These two stamps say when each credential kind was last accepted on any door (notes API or MCP), at most once a minute, in memory only, and reset by a restart. They are captured when this page connects (as of page load) and do not update while it stays open — reload the page to see a newer value. They never contain a credential.",
  presenceToken: "Signed token (--token-key)",
  presenceSecret: "Shared secret (--auth-secret)",
  presenceNever: "not seen since this hub started",

  notesHeading: "Notes",
  notePlaceholder: "New note — what should be looked at?",
  noteLabel: "Note text",
  routePlaceholder: "route (e.g. /settings)",
  routeLabel: "Note route",
  addButton: "Add",
  reloadButton: "Reload",
  notesEmpty: "no notes yet",
  typeNoteFirst: "Type a note first.",
  adding: "adding…",
  notesCount: "{count} note(s)",
  colBody: "Body",
  colRoute: "Route",
  colStatus: "Status",
  colAuthor: "Author",
  colActions: "Actions",
  statusOpen: "open",
  statusDone: "done",
  doneButton: "done",
  reopenButton: "reopen",

  devicesHeading: "Issued client credentials",
  noIssuingBanner:
    "This hub has no --token-key, so it cannot issue tokens. Client access runs on the shared secret; restart the hub with a key to mint per-device tokens.",
  deviceNamePlaceholder: "device name (e.g. caro-laptop)",
  deviceNameLabel: "Device name",
  deviceTtlPlaceholder: "lifetime days (default: hub default)",
  deviceTtlLabel: "Lifetime in days",
  scopeLabel: "Scope",
  scopeReadWrite: "read + write",
  scopeReadOnly: "read only",
  mintButton: "Issue token",
  nameDeviceFirst: "Name the device first.",
  ttlError: "Lifetime must be a whole number of days from 1 to 365.",
  issuing: "issuing…",
  devicesEmpty: "no client credentials issued from this page yet.",
  devicesInventoryNote:
    "Tokens minted with bluepencil token are not listed here, but they can be revoked by their jti.",
  statusOk: "ok",
  loading: "loading…",
  colDevice: "Device",
  colScope: "Scope",
  colIssued: "Issued",
  colExpires: "Expires",
  colState: "State",
  colJti: "jti",
  stateLive: "live",
  stateRevoked: "revoked",
  revokeButton: "revoke",
  revokeConfirm: "Revoke this token? The device loses access at once.",
  revoking: "revoking…",
  devicesErrorBanner: "The device registry could not be read: {message}",

  tokenHeading: "Token for {device}",
  tokenHelp: "Copy it now — the hub keeps the id, not the token.",
  tokenLabel: "Issued token",
  copyButton: "Copy",
  dismissButton: "Dismiss",
  copied: "Copied",
  copyFailed: "Could not copy — select the token and copy it yourself.",

  activityHeading: "Activity",
  activityHelp: "Every recorded change, newest first — who did what, and when.",
  activityEmpty: "nothing recorded yet",
  activityCount: "{count} entry(s)",
  colWhen: "When",
  colWho: "Who",
  colWhat: "What",
};

/** German — same keys, same placeholders; typed so a missing key cannot compile. */
const de: AdminStrings = {
  lang: "de",

  title: "Bluepencil — Admin",
  brandAdmin: "Admin",
  notConnected: "nicht verbunden",

  connectHeading: "Verbinden",
  connectHelp:
    "Das Admin-Secret des Hubs (--admin-secret). Es bleibt im Speicher, solange diese Seite offen ist, und wird als x-bluepencil-admin gesendet.",
  secretPlaceholder: "Admin-Secret",
  secretLabel: "Admin-Secret",
  connectButton: "Verbinden",
  rememberLabel: "In diesem Tab merken",
  rememberWarning:
    "Beim Merken liegt das Secret im Session-Speicher dieses Tabs. Jedes Skript dieser Origin kann es lesen — nur auf einem vertrauenswürdigen Rechner aktivieren.",
  typeSecretFirst: "Zuerst das Admin-Secret eingeben.",
  checking: "prüfe…",
  connected: "verbunden",
  connectionLine: "{name} · v{version} · {environment} · {notes} Notiz(en) · {issued} ausgegeben",

  sectionsLabel: "Bereiche",
  tabOverview: "Übersicht",
  tabNotes: "Notizen",
  tabDevices: "Ausgegebene Client-Credentials",
  tabActivity: "Aktivität",

  overviewHub: "Hub",
  overviewEnvironment: "Umgebung",
  overviewNotes: "Notizen",
  overviewClientCredential: "Client-Anmeldedaten",
  overviewAcceptedCredentials: "Akzeptierte Anmeldedaten",
  overviewTokenIssuing: "Token-Ausstellung",
  overviewRevocation: "Widerruf",
  overviewIssuedCredentials: "Ausgegebene Client-Credentials",
  overviewReadOnly: "Nur lesen",
  overviewFederates: "Föderiert",
  credentialToken: "signiertes Token (--token-key)",
  credentialSecret: "geteiltes Secret (--auth-secret)",
  credentialTokenAndSecret: "signiertes Token (--token-key) + geteiltes Secret (--auth-secret)",
  credentialKindToken: "Token",
  credentialKindSecret: "geteiltes Secret",
  credentialNone: "keine",
  issuingAvailable: "verfügbar",
  issuingUnavailable: "nicht verfügbar — dieser Hub hat keinen --token-key",
  revocationDurable: "dauerhaft (--revoked-tokens-Datei)",
  revocationLive: "nur live — geht beim Neustart verloren (keine --revoked-tokens-Datei)",
  yes: "ja",
  no: "nein",
  federatesYes: "ja (Registry konfiguriert)",
  federatesNo: "nein",
  issuedCredentialsSummary: "{issued} ausgegeben ({revoked} widerrufen)",

  presenceHeading: "Zuletzt akzeptiertes Credential",
  presenceHelp:
    "Die ehrliche Grenze: der Hub zeichnet Notiz-Schreibvorgänge und die ausgegebenen Client-Credentials auf — eine Zeile pro Token, nicht pro verbundenem Browser. Lesende Clients werden nicht als einzelne Clients geführt. Die beiden Zeitstempel nennen, wann welche Art von Credential zuletzt an einer der beiden Türen (Notiz-API oder MCP) akzeptiert wurde: höchstens einmal pro Minute, nur im Speicher und nach einem Neustart zurückgesetzt. Sie werden beim Verbinden dieser Seite erfasst (Stand beim Laden der Seite) und aktualisieren sich nicht, solange sie geöffnet bleibt — zum Aktualisieren die Seite neu laden. Sie enthalten nie ein Credential.",
  presenceToken: "Signiertes Token (--token-key)",
  presenceSecret: "Geteiltes Secret (--auth-secret)",
  presenceNever: "seit dem Start dieses Hubs nicht gesehen",

  notesHeading: "Notizen",
  notePlaceholder: "Neue Notiz — was soll geprüft werden?",
  noteLabel: "Notiztext",
  routePlaceholder: "Route (z. B. /einstellungen)",
  routeLabel: "Notiz-Route",
  addButton: "Hinzufügen",
  reloadButton: "Neu laden",
  notesEmpty: "noch keine Notizen",
  typeNoteFirst: "Zuerst eine Notiz eingeben.",
  adding: "füge hinzu…",
  notesCount: "{count} Notiz(en)",
  colBody: "Text",
  colRoute: "Route",
  colStatus: "Status",
  colAuthor: "Autor",
  colActions: "Aktionen",
  statusOpen: "offen",
  statusDone: "erledigt",
  doneButton: "erledigt",
  reopenButton: "wieder öffnen",

  devicesHeading: "Ausgegebene Client-Credentials",
  noIssuingBanner:
    "Dieser Hub hat keinen --token-key und kann daher keine Token ausstellen. Der Client-Zugang läuft über das geteilte Secret; für Token pro Gerät den Hub mit einem Schlüssel neu starten.",
  deviceNamePlaceholder: "Gerätename (z. B. caro-laptop)",
  deviceNameLabel: "Gerätename",
  deviceTtlPlaceholder: "Laufzeit in Tagen (Standard: Hub-Standard)",
  deviceTtlLabel: "Laufzeit in Tagen",
  scopeLabel: "Umfang",
  scopeReadWrite: "lesen + schreiben",
  scopeReadOnly: "nur lesen",
  mintButton: "Token ausstellen",
  nameDeviceFirst: "Zuerst das Gerät benennen.",
  ttlError: "Die Laufzeit muss eine ganze Zahl von 1 bis 365 Tagen sein.",
  issuing: "stelle aus…",
  devicesEmpty: "noch keine Client-Credentials von dieser Seite ausgegeben.",
  devicesInventoryNote:
    "Mit bluepencil token ausgestellte Token erscheinen hier nicht, lassen sich aber über ihre jti widerrufen.",
  statusOk: "ok",
  loading: "lade…",
  colDevice: "Gerät",
  colScope: "Umfang",
  colIssued: "Ausgestellt",
  colExpires: "Läuft ab",
  colState: "Zustand",
  colJti: "jti",
  stateLive: "aktiv",
  stateRevoked: "widerrufen",
  revokeButton: "widerrufen",
  revokeConfirm: "Dieses Token widerrufen? Das Gerät verliert sofort den Zugang.",
  revoking: "widerrufe…",
  devicesErrorBanner: "Die Geräte-Registry konnte nicht gelesen werden: {message}",

  tokenHeading: "Token für {device}",
  tokenHelp: "Jetzt kopieren — der Hub speichert nur die ID, nicht das Token.",
  tokenLabel: "Ausgestelltes Token",
  copyButton: "Kopieren",
  dismissButton: "Verwerfen",
  copied: "Kopiert",
  copyFailed: "Kopieren fehlgeschlagen — Token markieren und selbst kopieren.",

  activityHeading: "Aktivität",
  activityHelp: "Jede aufgezeichnete Änderung, neueste zuerst — wer was getan hat und wann.",
  activityEmpty: "noch nichts aufgezeichnet",
  activityCount: "{count} Eintrag/Einträge",
  colWhen: "Wann",
  colWho: "Wer",
  colWhat: "Was",
};

/** The two complete tables the renderer accepts. */
export const ADMIN_STRINGS: { en: AdminStrings; de: AdminStrings } = { en, de };

/**
 * Picks the page language from an `Accept-Language` header value: German when the header starts
 * with `de` (case-insensitive), English otherwise. A flat prefix test on purpose — the page has
 * exactly two translations, so full quality-value negotiation would add moving parts without
 * changing the outcome.
 */
export function adminLanguage(acceptLanguage: string | undefined): "en" | "de" {
  if (typeof acceptLanguage !== "string") return "en";
  return acceptLanguage.trim().toLowerCase().startsWith("de") ? "de" : "en";
}
