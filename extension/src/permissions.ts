/**
 * Optional host permissions — the one place that turns a hub URL into a Chrome match pattern and
 * an answer into a save decision (G9, SEC-20).
 *
 * Before 0.12.0 the extension shipped a `host_permissions` entry for every http(s) site, which asks
 * the browser for that access at install time and is why the webstore listing needed an explanation
 * for a permission the layer rarely used. From 0.12.0 the permission is optional: the options page
 * asks for exactly the hub origin the user typed, and the worker refuses to send a request when
 * that origin was never granted (fail-closed, `permission_missing`).
 *
 * Three facts shape this module:
 *
 * - **Chrome match patterns have no port.** `url.host` would produce
 *   `http://127.0.0.1:8787/*`, a pattern `chrome.permissions.request` rejects, so the default hub
 *   would not even be saveable. The pattern is built from `url.protocol` + `url.hostname`, which
 *   elides the port: `http://127.0.0.1:8787/api` → `http://127.0.0.1/*`. The grant therefore covers
 *   every port of that host — an accepted Chrome limitation, not a bug. `request` and `contains`
 *   receive this exact string.
 * - **Chrome has no "denied" state.** `contains` answers `false` both for "never asked" and for
 *   "asked and refused". The options page supplies the difference as a session-scoped list of
 *   patterns a `request` refused; it is deliberately not persisted, because the next browser session
 *   may ask again and a stale "denied" would lock the user out of a setting they can still grant.
 * - **A non-`http` store needs no grant.** `chromeStorage`, `localStorage` and `memory` never leave
 *   the browser, so asking for a hub origin there would be a permission request the feature does
 *   not use.
 *
 * Deliberately pure and free of `chrome.*` and the DOM: the options page (T-B9) and the worker
 * inject their own seams, and this module is unit-tested without a browser.
 */

/**
 * The three states the options page can observe, in the order they are resolved.
 *
 * `unknown` is the default for a host that was never asked: a save may still proceed, but it has to
 * ask first (in the click context `chrome.permissions.request` requires).
 */
export type PermissionState = "unknown" | "granted" | "denied";

/**
 * The match pattern for a hub endpoint, or `null` when the value cannot name an http(s) host.
 *
 * The port is always elided — see the module header. `new URL` normalises the hostname (lower-case,
 * punycode, bracketed IPv6), so the string returned here is the same string Chrome expects for both
 * `permissions.request` and `permissions.contains`.
 */
export function hubOriginPattern(endpoint: string): string | null {
  const raw = endpoint.trim();
  if (raw.length === 0) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // File and extension URLs have no host permission to grant; anything that is not HTTP(S) is not a
  // hub the layer could reach anyway.
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // `hostname` (not `host`): Chrome match patterns reject a port.
  return `${url.protocol}//${url.hostname}/*`;
}

/**
 * Resolves the observable permission state from a `contains` answer and the session's refusals.
 *
 * `contains` wins over a remembered refusal: a grant made in `chrome://extensions` while the options
 * page is open becomes visible here without a reload, and a stale refusal must not mask it.
 */
export function permissionState(input: {
  contains: boolean;
  pattern: string;
  deniedPatterns: readonly string[];
}): PermissionState {
  if (input.contains) return "granted";
  return input.deniedPatterns.includes(input.pattern) ? "denied" : "unknown";
}

/**
 * What the options page should do with the form values, decided without touching the browser.
 *
 * `{ok:true, requestOrigin:null}` means "save now, no grant needed"; `requestOrigin` is the pattern
 * to ask for in the click handler before saving. `{ok:false}` means "do not save" and carries the
 * named reason — the page must not call `chrome.storage.local.set` in that case.
 */
export type SaveDecision =
  | { ok: true; requestOrigin: string | null }
  | {
      ok: false;
      code: "missing_endpoint" | "invalid_origin" | "permission_denied";
      message: string;
    };

const EXAMPLE_ENDPOINT = "http://127.0.0.1:8787/api/v1/bluepencil";

/**
 * The save decision for one form submission.
 *
 * Order matters and follows the spec: a store that is not `http` never asks for a host permission,
 * so even an empty endpoint is a valid local save. Only the hub store validates the URL and consults
 * the permission state.
 *
 * A `denied` origin is a refusal, not a retry: Chrome ignores a second `permissions.request` after
 * the user said no, so asking again would look like a broken button. The message points at
 * `chrome://extensions`, where the grant can be restored deliberately.
 */
export function decideSave(input: {
  store: string;
  endpoint: string;
  permission: PermissionState;
}): SaveDecision {
  if (input.store !== "http") return { ok: true, requestOrigin: null };

  const raw = input.endpoint.trim();
  if (raw.length === 0) {
    return {
      ok: false,
      code: "missing_endpoint",
      message: `Enter the full hub URL, including its scheme and base path — for example ${EXAMPLE_ENDPOINT}.`,
    };
  }

  const pattern = hubOriginPattern(raw);
  if (pattern === null) {
    return {
      ok: false,
      code: "invalid_origin",
      // "HTTP or HTTPS" without the bare scheme literals: the options page bundles this message,
      // and a bare scheme fragment there reads to the webstore's remote-origin scan like a URL.
      message: `The hub URL must be an HTTP or HTTPS URL with a host — for example ${EXAMPLE_ENDPOINT}.`,
    };
  }

  if (input.permission === "denied") {
    return {
      ok: false,
      code: "permission_denied",
      message: `Bluepencil may not contact ${pattern}: access to this hub origin was refused. Grant it under chrome://extensions (Details → Site access) and save again.`,
    };
  }

  return input.permission === "granted"
    ? { ok: true, requestOrigin: null }
    : { ok: true, requestOrigin: pattern };
}

/**
 * The worker's fail-closed refusal before a hub request, or `null` when the origin is granted.
 *
 * This runs after `validateHubRequest` and before `fetch`; a non-`null` answer means no request is
 * made at all. `endpoint` is only used to name the origin in the message — the permission decision
 * itself is the state, so a caller that already resolved it does not have to parse the URL again.
 */
export function permissionRefusal(
  endpoint: string,
  permission: PermissionState,
): { code: "permission_missing"; message: string } | null {
  if (permission === "granted") return null;

  const trimmed = endpoint.trim();
  const origin = hubOriginPattern(trimmed) ?? (trimmed.length === 0 ? "the configured hub" : trimmed);
  const message =
    permission === "denied"
      ? `Bluepencil has no permission to contact ${origin}: access was refused. Grant it under chrome://extensions (Details → Site access) and save the hub endpoint again.`
      : `Bluepencil has no permission to contact ${origin}. Grant access to this hub origin in the extension options page and save again.`;

  return { code: "permission_missing", message };
}
