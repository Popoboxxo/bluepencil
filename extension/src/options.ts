/**
 * Options page logic (#34).
 *
 * Deliberately thin: the settings object is validated in `settings.ts` (the module the service
 * worker also uses), so the page cannot save a value the worker would later reject. Reading and
 * writing go through `chrome.storage.local` directly — the same key the worker reads, so there is
 * one source of truth rather than a page-local copy that can drift.
 */
import { insecureEndpointRefusal, probeConnection } from "./connection";
import { configuredCredential, type CredentialMode } from "./credential";
import {
  decideSave,
  hubOriginPattern,
  permissionState,
  type PermissionState,
  type SaveDecision,
} from "./permissions";
import { DEFAULT_SETTINGS, expiryOfToken, normalizeSettings, type ExtensionSettings } from "./settings";

declare const chrome: {
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
  permissions: {
    contains(permissions: { origins: string[] }): Promise<boolean>;
    request(permissions: { origins: string[] }): Promise<boolean>;
  };
};

const SETTINGS_KEY = "bluepencil:settings";

/**
 * The seams the save flow needs, injected so the gesture rule is testable without a browser.
 *
 * `request` is the critical one: `chrome.permissions.request` only answers while the click that
 * started the save still holds the user gesture, so it is called **synchronously** from the submit
 * handler — before any `await`. Everything else (persisting, remembering a refusal) may resolve
 * later.
 */
export interface SaveGesturePorts {
  request(pattern: string): Promise<boolean>;
  persist(): Promise<void>;
  onDenied?(pattern: string): void;
}

/**
 * Runs one save, with the host-permission request still in the click context.
 *
 * The order is the contract (AC-B19): decide first (a local store never asks, an unusable URL is
 * rejected before Chrome sees anything), then — for an `unknown` hub origin — hand the pattern to
 * `request` *before returning this function's promise*, so the browser still associates it with the
 * click. Only a granted answer persists; a refusal is reported as `permission_denied` and writes
 * nothing.
 */
export function saveInGesture(
  input: { store: string; endpoint: string; permission: PermissionState },
  ports: SaveGesturePorts,
): Promise<SaveDecision> {
  const decision = decideSave(input);
  if (!decision.ok) return Promise.resolve(decision);

  if (decision.requestOrigin === null) {
    return ports.persist().then(() => decision);
  }

  const pattern = decision.requestOrigin;
  // No `await` above this line: the call below has to happen inside the submit handler's gesture.
  const granted = ports.request(pattern);
  return granted.then((ok) => {
    if (!ok) {
      ports.onDenied?.(pattern);
      // Reuse `decideSave` for the refusal so the message (and its chrome://extensions pointer) has
      // exactly one source. A "denied" permission can never produce an ok decision.
      const refused = decideSave({ ...input, permission: "denied" });
      if (refused.ok) throw new Error("a refused permission must not produce a save decision");
      return refused;
    }
    return ports.persist().then(() => decision);
  });
}

/**
 * The save-time refusal for a cleartext endpoint, or `null` when the save may run.
 *
 * A thin adapter over `insecureEndpointRefusal`: the rule itself lives in `connection.ts`, so the
 * save and the probe cannot disagree, and this gives the refusal the named code the spec records
 * (`insecure_endpoint`, AC-B60) in the same shape a `SaveDecision` uses. `save_` renders the message
 * and returns before it asks for a permission or writes anything.
 */
export function insecureSaveRefusal(input: { endpoint: string; auth: CredentialMode }):
  | { ok: false; code: "insecure_endpoint"; message: string }
  | null {
  const message = insecureEndpointRefusal(input);
  return message === null ? null : { ok: false, code: "insecure_endpoint", message };
}

/**
 * What this options session has learned about each origin.
 *
 * `contains` is the only truth for a grant. Chrome has no "denied" state, so a `request` that
 * answered `false` is remembered for this page's lifetime — deliberately not persisted: the next
 * browser session may ask again. A grant is also cached, so a later save does not need to ask (and
 * a fresh grant in `chrome://extensions` is picked up by the refresh in `load()`/after a save).
 */
const observedGrants = new Set<string>();
const deniedPatterns: string[] = [];

async function containsPattern(pattern: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    // A pattern Chrome rejects is not a grant; "unknown" is the honest answer in that case too.
    return false;
  }
}

/** The permission state for an endpoint, from the cached `contains` answer and this session's refusals. */
function permissionFor(endpoint: string): PermissionState {
  const pattern = hubOriginPattern(endpoint);
  if (pattern === null) return "unknown";
  return permissionState({
    contains: observedGrants.has(pattern),
    pattern,
    deniedPatterns,
  });
}

/** Refreshes the cached `contains` answer for an endpoint; a failed probe leaves the state unknown. */
async function observePermission(endpoint: string): Promise<void> {
  const pattern = hubOriginPattern(endpoint);
  if (pattern === null) return;
  if (await containsPattern(pattern)) observedGrants.add(pattern);
  else observedGrants.delete(pattern);
}

/**
 * Asks for one origin, synchronously, and turns a rejection into an answer.
 *
 * `chrome.permissions.request` throws (as a rejected promise) when the calling context has no user
 * gesture — a synthetic `requestSubmit()`, for instance. That is not a refusal by the user: if the
 * origin is already granted, the save may proceed. Anything else is reported as not granted.
 */
function requestPattern(pattern: string): Promise<boolean> {
  // The call itself is synchronous; only its result is awaited by the caller.
  let asked: Promise<boolean>;
  try {
    asked = chrome.permissions.request({ origins: [pattern] });
  } catch {
    return containsPattern(pattern);
  }
  return asked.catch(() => containsPattern(pattern));
}

/**
 * The text/select fields the form owns, in the shape the settings object uses.
 *
 * Split from the checkboxes (#70) because the two kinds do not read or write alike: a text field
 * exposes its value as a *string*, a checkbox as a *boolean*. Listing them in one array would force
 * `settings[field]` to `string | boolean` and lose exactly the distinction that keeps a hand-edited
 * `mountAlongsideHost: "false"` from being read as on.
 */
const FIELDS = [
  "environment",
  "appName",
  "language",
  "identity",
  "store",
  "endpoint",
  "auth",
  "token",
  "deviceName",
] as const satisfies readonly (keyof ExtensionSettings)[];

/** The checkbox fields — booleans, read from `.checked` rather than `.value`. */
const CHECKBOXES = [
  "mountAlongsideHost",
] as const satisfies readonly (keyof ExtensionSettings)[];

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`options: #${id} is missing`);
  return node as T;
}

/**
 * The page's elements, bound by `wirePage()`.
 *
 * They are not resolved at module scope so that importing this file outside `options.html` (the
 * unit suite imports `saveInGesture`) does not throw on a missing `#form`. Every function that
 * touches the DOM is only reachable from a listener or `load()`, both of which run after wiring.
 */
let form: HTMLFormElement;
let status: HTMLElement;
let hub: HTMLElement;
let save: HTMLButtonElement;
let testConnection: HTMLButtonElement;

type StatusKind = "ok" | "error" | "warn" | "";

/**
 * The newest writer of the status line.
 *
 * A probe and a save can overlap: the probe is a network round trip and Save stays usable while it
 * runs. Without this counter the slower of the two would win and the user would read a stale result
 * as the answer to their last action. Every writer takes a ticket; a result is only rendered while
 * its ticket is still the newest.
 */
let statusGeneration = 0;
let testing = false;

function beginStatus(): number {
  statusGeneration += 1;
  return statusGeneration;
}

function say(message: string, kind: StatusKind = ""): void {
  status.textContent = message;
  if (kind === "") delete status.dataset.kind;
  else status.dataset.kind = kind;
}

function sayIfCurrent(generation: number, message: string, kind: StatusKind = ""): void {
  if (generation === statusGeneration) say(message, kind);
}

function showSidecar(store: string): void {
  const isHub = store === "http";
  hub.hidden = !isHub;
  // The probe is only meaningful for the hub store: with any other store there is no endpoint to
  // test, and an enabled button would invite a request the saved settings would never make.
  testConnection.hidden = !isHub;
  testConnection.disabled = !isHub || testing;
}

function fill(settings: ExtensionSettings): void {
  for (const field of FIELDS) {
    const node = byId<HTMLInputElement | HTMLSelectElement>(field);
    node.value = settings[field];
  }
  for (const field of CHECKBOXES) {
    byId<HTMLInputElement>(field).checked = settings[field];
  }
  showSidecar(settings.store);
}

async function load(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    // normalizeSettings, not a cast: a hand-edited or older blob must not reach the form as-is.
    const settings = normalizeSettings(stored[SETTINGS_KEY]);
    fill(settings);
    // Described on load, not only on save: opening the options page is how someone checks whether
    // their token is still alive, so leaving the state blank until they press Save would defeat it.
    describeCredential(settings);
    // A hub origin granted in an earlier session must not trigger a prompt on the first Save.
    void observePermission(settings.endpoint);
  } catch (error) {
    fill({ ...DEFAULT_SETTINGS });
    describeCredential({ ...DEFAULT_SETTINGS });
    say(`Could not read the stored settings: ${String(error)}`, "error");
  }
}

/**
 * "Test connection" (#105): probe the URL and credential that are on screen *now*.
 *
 * It reads the form rather than storage on purpose: someone trying to fix a broken hub has just
 * edited the field, and testing the last-saved value would report on a URL they no longer intend to
 * use. Nothing is saved and nothing is stored — the only side effects are the button's disabled
 * state and the message in `#status`.
 */
async function testConnection_(): Promise<void> {
  const generation = beginStatus();
  testing = true;
  showSidecar(byId<HTMLSelectElement>("store").value);
  say("Testing…");
  try {
    const settings = normalizeSettings(readForm());
    // The same check the save path uses (ADR-0.12-S2): testing is not a way around it. Nothing is
    // sent — there is no request whose credential could travel in cleartext.
    const refusal = insecureEndpointRefusal({ endpoint: settings.endpoint, auth: settings.auth });
    if (refusal !== null) {
      sayIfCurrent(generation, refusal, "error");
      return;
    }
    const result = await probeConnection({
      endpoint: settings.endpoint,
      credential: { auth: settings.auth, token: settings.token },
    });
    // The message is built by the probe, from the response and the URL — never from the credential.
    // `credential-unverified` is a warning, not a failure: the hub answered, only the credential
    // check was inconclusive.
    const kind: StatusKind = result.ok ? "ok" : result.status === "credential-unverified" ? "warn" : "error";
    sayIfCurrent(generation, result.message, kind);
  } catch (error) {
    // `probeConnection` reports every expected failure as a result. Reaching here is a defect in that
    // contract, and saying so is still better than a button that appears to do nothing.
    sayIfCurrent(generation, `Could not test the connection: ${String(error)}`, "error");
  } finally {
    testing = false;
    showSidecar(byId<HTMLSelectElement>("store").value);
  }
}

/**
 * Saves the form, asking for the hub origin inside the click that triggered the submit.
 *
 * This function is synchronous until `saveInGesture` hands the pattern to `chrome.permissions
 * .request`; only the persistence and the status updates are asynchronous. That split is the point
 * (AC-B19): Chrome grants a permission request only while the user gesture is live, so an `await`
 * before the request would turn a normal Save into a silent no-prompt refusal.
 */
function save_(): void {
  const generation = beginStatus();
  save.disabled = true;
  const settings = normalizeSettings(readForm());
  // Save the normalized form, not the raw input: what is stored is exactly what the worker will
  // read back, so a bad value cannot sit in storage until the next mount fails.
  // The token is stored the way the layer and the probe use it — `configuredCredential` trims it
  // and maps a whitespace-only paste to "none" (#110). Storing the raw field instead meant storage
  // and the value actually sent could disagree, which is exactly the round the smoke test compares.
  settings.token = configuredCredential(settings.token) ?? "";
  // The expiry is derived from the token rather than typed, so the user cannot state a wrong one.
  const tokenExpiresAt = expiryOfToken(settings.token);
  const stored: ExtensionSettings = { ...settings, tokenExpiresAt };
  const endpoint = settings.endpoint;

  // ADR-0.12-S2 (AC-B60): a credential must not go over plain HTTP to anything but this machine.
  // Refused here — before `saveInGesture` asks Chrome for the origin and before `persist` — so a
  // refused endpoint is neither granted a permission nor written. No silent downgrade to https and
  // no "insecure" override: the user fixes the URL or sets Authentication to None.
  //
  // Only the hub store sends the credential, so only the hub store is judged: `decideSave` likewise
  // never asks for a permission for a local store. A hidden cleartext URL left in the form must not
  // block an unrelated local save — nothing would be sent.
  const refusal =
    settings.store === "http" ? insecureSaveRefusal({ endpoint, auth: settings.auth }) : null;
  if (refusal !== null) {
    sayIfCurrent(generation, refusal.message, "error");
    save.disabled = false;
    return;
  }

  /** Runs the save for an already-resolved permission state. Synchronous through the request seam. */
  const finish = (permission: PermissionState): void => {
    let outcome: Promise<SaveDecision>;
    try {
      outcome = saveInGesture(
        { store: settings.store, endpoint, permission },
        {
          request: async (pattern) => {
            // `requestPattern` is called before the first `await`, so the request still runs inside
            // the submit's user gesture. A `true` answer is authoritative for the session cache,
            // even if a `contains` probe around it was stale.
            const granted = await requestPattern(pattern);
            if (granted) observedGrants.add(pattern);
            else observedGrants.delete(pattern);
            return granted;
          },
          onDenied: (pattern) => {
            observedGrants.delete(pattern);
            if (!deniedPatterns.includes(pattern)) deniedPatterns.push(pattern);
          },
          persist: async () => {
            await chrome.storage.local.set({ [SETTINGS_KEY]: stored });
          },
        },
      );
    } catch (error) {
      // `saveInGesture` reports every expected refusal as a decision. Reaching here is a defect in
      // that contract, and saying so is still better than a button that appears to do nothing.
      sayIfCurrent(generation, `Could not save: ${String(error)}`, "error");
      save.disabled = false;
      return;
    }

    void outcome
      .then(async (result) => {
        if (!result.ok) {
          // `permission_denied` lands here for both a session refusal and a refusal in this click;
          // neither may write settings (no `set` in the rejected branch at all).
          sayIfCurrent(generation, result.message, "error");
          return;
        }
        // A probe that started before this save may finish after it. Its ticket is older, so it is
        // discarded — and a save that itself became stale must not repaint the form either.
        if (generation !== statusGeneration) return;
        const read = await chrome.storage.local.get(SETTINGS_KEY);
        // Re-check after the await: the read is another turn, and a probe started in this window
        // has a newer ticket. Repainting the form or saying "Saved." then would answer the probe
        // with a stale save, which is the mirror image of the race the first check guards.
        if (generation !== statusGeneration) return;
        const current = normalizeSettings(read[SETTINGS_KEY]);
        fill(current);
        describeCredential(current);
        sayIfCurrent(generation, "Saved.", "ok");
      })
      .catch((error: unknown) => {
        sayIfCurrent(generation, `Could not save: ${String(error)}`, "error");
      })
      .finally(() => {
        save.disabled = false;
      });
  };

  const permission = permissionFor(endpoint);
  if (permission === "denied") {
    // A grant made in `chrome://extensions` while this page is open must be usable without a
    // reload. This branch never asks for a permission, so the extra `contains` round cannot lose a
    // gesture; a still-refused origin reaches `finish("denied")` and writes nothing.
    void observePermission(endpoint)
      .then(() => finish(permissionFor(endpoint)))
      .catch((error: unknown) => {
        sayIfCurrent(generation, `Could not save: ${String(error)}`, "error");
        save.disabled = false;
      });
    return;
  }
  finish(permission);
}

/**
 * The form's current values, in the shape the settings object uses.
 *
 * Shared between saving and the live description of the credential, so the two cannot disagree about
 * what is on screen. Reading the form in two places is how a field ends up shown but not stored.
 */
function readForm(): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const field of FIELDS) raw[field] = byId<HTMLInputElement | HTMLSelectElement>(field).value;
  // `.checked`, not `.value`: the checkbox's value string is always "on" and says nothing about
  // whether it is ticked. `normalizeSettings` then keeps the result strictly boolean (#70).
  for (const field of CHECKBOXES) raw[field] = byId<HTMLInputElement>(field).checked;
  return raw;
}

/**
 * Says what the selected credential actually is, and how long it lasts.
 *
 * Two things a user cannot otherwise find out, both of which end in lost notes: a token that is
 * already expired, and a token whose expiry could not be read. The first is a warning; the second is
 * stated plainly rather than hidden, because "unknown" and "never expires" must not look alike.
 */
function describeCredential(settings: ExtensionSettings): void {
  const hint = byId("credential-hint");
  const label = byId("credential-label");
  const state = byId("token-state");
  // The device name only means something for a signed token; shown for a shared secret it would
  // suggest a per-device credential that does not exist.
  byId("device-field").hidden = settings.auth !== "token";
  if (settings.auth === "secret") {
    label.textContent = "Shared secret";
    hint.textContent =
      "Sent as x-bluepencil-auth. Stored in this browser only. The hub needs --auth-secret with the same value.";
    state.hidden = true;
    return;
  }
  if (settings.auth === "none") {
    label.textContent = "Credential";
    hint.textContent =
      "None. Anyone who can reach the hub URL can read and write your notes, so it must stay on loopback.";
    state.hidden = true;
    return;
  }
  label.textContent = "Signed token";
  hint.textContent =
    "Sent as Authorization: Bearer. Mint one with `bluepencil token --device <name>`; it expires, and the hub can revoke it on its own without touching your other devices.";
  if (settings.token.length === 0) {
    state.hidden = false;
    state.textContent = "No token stored yet — notes will not reach the hub until you paste one.";
    return;
  }
  if (settings.tokenExpiresAt === "") {
    state.hidden = false;
    // Not a warning about the token being bad: the extension cannot read an expiry out of a token it
    // does not understand, and pretending otherwise would be worse than saying so.
    state.textContent =
      "The expiry of this token could not be read. It may already be expired — the hub decides, not the extension.";
    return;
  }
  const remaining = Date.parse(settings.tokenExpiresAt) - Date.now();
  state.hidden = false;
  if (remaining <= 0) {
    state.textContent = "This token has expired. Mint a new one — notes are not reaching the hub until you do.";
    return;
  }
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  state.textContent =
    hours > 0 ? `Expires in about ${hours} h ${minutes} min.` : `Expires in about ${minutes} min.`;
}

/** What `extension/build.mjs` writes to `dist/build-info.js` as a build-time global. */
interface BuildInfo {
  version: string;
  gitSha: string | null;
  elementSha256: string;
}

const VERSION_FIELDS = ["version-bluepencil", "version-build", "version-commit", "version-element"] as const;

/** Writes plain text (never HTML) and, when given, the full value as a hover title. */
function setVersionField(id: string, text: string, title?: string): void {
  const node = document.getElementById(id);
  if (node === null) return;
  node.textContent = text;
  if (title === undefined) node.removeAttribute("title");
  else node.setAttribute("title", title);
}

/**
 * Shows the exact build this page belongs to (FR-4.9).
 *
 * The values come from `globalThis.BLUEPENCIL_BUILD_INFO`, written by the build to `build-info.js`
 * and loaded as a classic script before this module. No same-origin `fetch`, no network API, no
 * inline script and no `eval` — nothing the Webstore compliance scan or the extension CSP would
 * have to allow. A missing or malformed global is stated as "unavailable" rather than left blank or
 * thrown: the settings form has to keep working either way, so this never throws.
 */
function showVersion(): void {
  const info = (globalThis as unknown as Record<string, unknown>)["BLUEPENCIL_BUILD_INFO"];
  if (typeof info !== "object" || info === null) {
    for (const id of VERSION_FIELDS) setVersionField(id, "unavailable");
    return;
  }
  const record = info as Partial<Record<keyof BuildInfo, unknown>>;
  if (typeof record.version !== "string" || typeof record.elementSha256 !== "string") {
    for (const id of VERSION_FIELDS) setVersionField(id, "unavailable");
    return;
  }
  const version = record.version;
  const elementSha256 = record.elementSha256;
  const gitSha = typeof record.gitSha === "string" ? record.gitSha : "unknown";
  setVersionField("version-bluepencil", `bluepencil ${version}`);
  setVersionField("version-build", version);
  // The full SHA, with itself as the title: a truncated hash cannot be matched against a commit,
  // and the title keeps the row narrow without hiding the value.
  setVersionField("version-commit", gitSha, gitSha === "unknown" ? undefined : gitSha);
  setVersionField("version-element", elementSha256, elementSha256);
}

/**
 * Binds the page's elements and starts its two independent jobs.
 *
 * Guarded by the presence of `#form` — the same shape as `review.ts`'s `autoStart()` — so importing
 * this module from the unit suite does not touch the DOM and does not throw. In the real options
 * page the element is always there.
 */
function wirePage(): void {
  form = byId<HTMLFormElement>("form");
  status = byId<HTMLElement>("status");
  hub = byId<HTMLElement>("hub");
  save = byId<HTMLButtonElement>("save");
  testConnection = byId<HTMLButtonElement>("test-connection");

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    // Not `void save_()`: the function is synchronous through the permission request, so the
    // browser still counts the submit as the gesture that authorises asking Chrome for the origin.
    save_();
  });

  testConnection.addEventListener("click", () => {
    void testConnection_();
  });

  byId<HTMLSelectElement>("store").addEventListener("change", (event) => {
    showSidecar((event.target as HTMLSelectElement).value);
  });

  // Refresh the `contains` answer when the URL changes, so an origin granted earlier needs no
  // prompt on the next Save. A fast Save can still precede this probe; `saveInGesture` then asks
  // (and `requestPattern` answers a granted origin without prompting).
  byId<HTMLInputElement>("endpoint").addEventListener("change", () => {
    void observePermission(byId<HTMLInputElement>("endpoint").value);
  });

  byId<HTMLSelectElement>("auth").addEventListener("change", () => {
    describeCredential(normalizeSettings(readForm()));
  });

  void load();
  // Independent of the settings load: a missing build-info global must never block the form.
  void showVersion();
}

if (document.getElementById("form") !== null) wirePage();
