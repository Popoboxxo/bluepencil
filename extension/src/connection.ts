/**
 * "Test connection" — ask the hub what it is before saving a URL and a credential (#105).
 *
 * The failure this exists for is not mysterious: a hub URL that names the *host* rather than the
 * **API base** (`http://127.0.0.1:8787` instead of `http://127.0.0.1:8787/api/v1/bluepencil`) answers
 * 404 on every route, and the layer's next symptom is "notes do not save". The probe says which of
 * the common cases it actually is — wrong base path, nothing listening, a timeout, a non-JSON page,
 * or a credential the hub rejected — instead of leaving the user to interpret a generic failure.
 *
 * Deliberately free of DOM and `chrome.*`: the page wires the button and renders the message
 * (`options.ts`), and this module is unit-tested with an injected `fetch`. It never writes storage,
 * never reads a token from storage, and never puts the credential into a message, a result field or
 * a log. The only place the credential appears is the request header — the same header the layer's
 * HTTP adapter would send (`credentialHeaderFor` in `handoff.ts`): `Authorization: Bearer <token>`
 * for a signed token, `x-bluepencil-auth: <secret>` for a shared secret.
 *
 * The credential check on `GET /notes` is **status-only**: it cancels the response body instead of
 * buffering it. `/notes` answers with the whole note corpus and the hub applies no limit, so reading
 * the body would let a large or slow corpus exhaust the budget and turn an accepted credential into
 * a "timed out" message — the misdiagnosis #105 exists to remove.
 */
import { configuredCredential, credentialHeaderFor } from "./handoff";

/** The credential mode and value the options page would hand to the layer. */
export interface ConnectionCredential {
  auth: "none" | "secret" | "token";
  token: string;
}

/** What the probe needs to know; read from the form, not from storage. */
export interface ConnectionInput {
  /** The full API base, base path included, e.g. `http://127.0.0.1:8787/api/v1/bluepencil`. */
  endpoint: string;
  credential?: ConnectionCredential;
}

/** Injectable seams, so the module is testable without a browser or a real network. */
export interface ConnectionDeps {
  fetchImpl?: typeof fetch;
  /** Budget for each request. Both requests get their own budget. */
  timeoutMs?: number;
}

/**
 * `reachable` is the only success. `wrong-base-path` and `unauthorised` are separate on purpose:
 * they have completely different fixes, and both used to look like "the hub is not working".
 */
export type ConnectionStatus =
  | "reachable"
  | "unreachable"
  | "timed-out"
  | "wrong-base-path"
  | "unauthorised"
  | "invalid-url"
  | "invalid-response"
  | "http-error"
  /**
   * A `30x` answer. Reported on its own rather than as "unreachable": the hub answered, but this
   * probe does not follow redirects (that would carry the credential to an origin the user never
   * entered) and cannot say anything about the URL behind it. The fix is to save the *final* URL —
   * the usual cause is a reverse proxy that upgrades http to https or normalises the path.
   */
  | "redirected"
  /**
   * The hub answered `/config`, but the credential is not a value an HTTP header can carry (a line
   * break, a control character, a non-Latin-1 character). Reported on its own because the fix is
   * "paste it again", not "check the network" — the latter is what a generic transport failure says.
   */
  | "invalid-credential"
  /**
   * The hub answered `/config`, but the `/notes` credential check was inconclusive: it timed out or
   * the connection failed. Distinct from `timed-out`/`unreachable`, which are statements about the
   * hub as a whole. Here the URL is right; only the credential is unproven, and claiming otherwise
   * is exactly the misdiagnosis #105 exists to remove.
   */
  | "credential-unverified";

/** The parsed subset of `GET {base}/config` the options page shows. `null` when not available. */
export interface HubConfigSummary {
  name: string | null;
  version: string | null;
  auth: "none" | "secret" | "token" | null;
  readOnly: boolean | null;
  environment: string | null;
  federates: boolean | null;
}

/**
 * The credential outcome of the follow-up `GET {base}/notes`, when one was configured.
 *
 * `invalid` means the value never left the browser: it is not a legal header value. `null` means
 * either "not configured" or "could not be verified" — `status` tells the two apart.
 */
export type CredentialState = "accepted" | "rejected" | "invalid" | null;

export interface ConnectionResult {
  status: ConnectionStatus;
  /** True only for `reachable`; kept as its own field so a caller does not have to compare strings. */
  ok: boolean;
  /**
   * The HTTP status of the response the verdict is about, or `null` when no response was received.
   *
   * Which route it names depends on `status`, because the probe asks two of them:
   *
   * - `reachable`, `wrong-base-path`, `invalid-response`, `invalid-credential` — the `/config`
   *   answer. A credential accepted on `/notes` still reports the `/config` status: the URL verdict
   *   comes from `/config`, and `/notes` is only a credential check.
   * - `unauthorised` — the `/config` answer when `/config` itself was refused, otherwise the
   *   `/notes` answer (the hub described itself, but rejected the credential).
   * - `http-error` — whichever route answered unexpectedly: `/config` or `/notes`.
   * - `credential-unverified`, and `redirected` raised by the `/notes` check — the `/config`
   *   status, because a response was received from `/config`, just not a verdict on the credential.
   * - `unreachable`, `timed-out`, `invalid-url`, and `redirected` raised by `/config` — `null`:
   *   no response whose status could be reported (an opaque redirect has status 0 in the browser).
   */
  httpStatus: number | null;
  /** Human-readable, already safe to show; never contains the credential. */
  message: string;
  config: HubConfigSummary | null;
  credential: CredentialState;
}

const DEFAULT_TIMEOUT_MS = 5000;
const EXAMPLE_BASE = "http://127.0.0.1:8787/api/v1/bluepencil";

/**
 * Probes `GET {endpoint}/config`, then — if a credential is configured — `GET {endpoint}/notes`
 * with the same header the layer would send.
 */
export async function probeConnection(
  input: ConnectionInput,
  deps: ConnectionDeps = {},
): Promise<ConnectionResult> {
  const base = baseOf(input.endpoint);
  if (base === null) {
    return failure("invalid-url", null, invalidUrlMessage(input.endpoint));
  }

  const fetchImpl = deps.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchImpl === undefined) {
    return failure("unreachable", null, `Could not reach ${base}: this environment has no fetch().`);
  }

  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const configUrl = `${base}/config`;
  const answered = await request(configUrl, { Accept: "application/json" }, timeoutMs, fetchImpl);

  if (answered.kind === "timed-out") {
    return failure("timed-out", null, timeoutMessage(base, timeoutMs));
  }
  if (answered.kind === "network") {
    return failure("unreachable", null, unreachableMessage(base, answered.reason));
  }
  if (answered.kind === "redirected") {
    // A reverse proxy that upgrades http→https or normalises the path answers 30x. The hub behind it
    // works — note sync follows redirects — so calling it "unreachable" was the misdiagnosis this
    // outcome removes. It is not followed here: the credential must not travel to an origin the user
    // did not enter, so the fix is to save the final URL instead.
    return failure(
      "redirected",
      redirectStatus(answered.status),
      redirectedMessage(configUrl, answered.status, answered.location),
    );
  }

  const status = answered.status;
  if (status === 404) {
    // The case the probe exists for: a host URL without the API's base path answers 404 here.
    return failure("wrong-base-path", status, wrongBasePathMessage(configUrl));
  }
  if (status === 401 || status === 403) {
    return failure("unauthorised", status, configUnauthorisedMessage(status));
  }
  if (status < 200 || status >= 300) {
    return failure("http-error", status, httpErrorMessage(base, status, configUrl));
  }

  const config = summarize(parseJson(answered.body));
  if (config === null) {
    return failure(
      "invalid-response",
      status,
      `The hub answered 200 for ${configUrl} but not with a JSON hub configuration — is this the API base, and not a web page or a login screen?`,
    );
  }

  const credential = configuredCredentialOf(input.credential);
  if (credential === null) {
    return {
      status: "reachable",
      ok: true,
      httpStatus: status,
      message: describeConfig(config, base),
      config,
      credential: null,
    };
  }

  if (INVALID_HEADER_VALUE.test(credential.value)) {
    // Never send it: fetch would reject the request with an opaque TypeError, and that would be
    // reported as "could not reach" even though the hub never saw a request.
    return {
      status: "invalid-credential",
      ok: false,
      httpStatus: status,
      message: invalidCredentialMessage(config, base),
      config,
      credential: "invalid",
    };
  }

  const notesUrl = `${base}/notes`;
  const spec = credentialHeaderFor(credential.auth);
  const headers: Record<string, string> = {
    Accept: "application/json",
    [spec.header]: spec.scheme === null ? credential.value : `${spec.scheme} ${credential.value}`,
  };
  // Status only — see the module header. The body is the note corpus; the probe only needs to know
  // whether the hub accepted the credential, not what is in it.
  const checked = await request(notesUrl, headers, timeoutMs, fetchImpl, { readBody: false });

  if (checked.kind === "timed-out") {
    return {
      status: "credential-unverified",
      ok: false,
      // A response *was* received, from `/config`; `httpStatus` is not null and `config` stays set.
      httpStatus: status,
      message: unverifiedCredentialMessage(
        config,
        base,
        `${notesUrl} did not answer within ${duration(timeoutMs)}`,
      ),
      config,
      credential: null,
    };
  }
  if (checked.kind === "network") {
    // The reason is already a sentence fragment; the outer helper adds the terminator, so strip a
    // trailing one here rather than producing "(….).".
    const reason = checked.reason.trim().replace(/[.!?]+$/, "") || "the connection failed";
    return {
      status: "credential-unverified",
      ok: false,
      httpStatus: status,
      message: unverifiedCredentialMessage(
        config,
        base,
        `the request to ${notesUrl} failed (${reason})`,
      ),
      config,
      credential: null,
    };
  }
  if (checked.kind === "redirected") {
    // `/config` answered, so the base itself is right; only `/notes` is behind a redirect. Keep the
    // summary (it is still true) and name the redirect for the route that produced it.
    return {
      status: "redirected",
      ok: false,
      httpStatus: status,
      message: redirectedMessage(notesUrl, checked.status, checked.location),
      config,
      credential: null,
    };
  }
  if (checked.status === 401 || checked.status === 403) {
    return {
      status: "unauthorised",
      ok: false,
      httpStatus: checked.status,
      message: rejectedCredentialMessage(checked.status, config),
      config,
      credential: "rejected",
    };
  }
  if (checked.status < 200 || checked.status >= 300) {
    return {
      status: "http-error",
      ok: false,
      httpStatus: checked.status,
      message: `The hub answered ${checked.status} for ${notesUrl} — the hub is reachable, but that route is not answering as expected.`,
      config,
      credential: null,
    };
  }

  return {
    status: "reachable",
    ok: true,
    httpStatus: status,
    message: `${describeConfig(config, base)} The credential was accepted.`,
    config,
    credential: "accepted",
  };
}

/**
 * Characters an HTTP header value cannot carry: everything but horizontal tab, printable ASCII and
 * Latin-1. `fetch` rejects such a value with a `TypeError` before any byte is sent, so the probe has
 * to name it as a credential problem rather than let it look like a dead hub.
 */
const INVALID_HEADER_VALUE = /[^\t\u0020-\u007e\u0080-\u00ff]/;

/**
 * The credential to check, or `null` when none is configured.
 *
 * An empty (or whitespace-only) credential field is "not configured", not "send an empty header":
 * the latter would turn a harmless probe into a guaranteed 401. `none` wins even if an old token is
 * still in the form, so the probe cannot check a credential the saved settings would not use. The
 * trim rule is the layer's own (`configuredCredential`), so the probe and the element agree on what
 * counts as a configured credential (#105).
 */
function configuredCredentialOf(
  credential: ConnectionCredential | undefined,
): { auth: "secret" | "token"; value: string } | null {
  if (credential === undefined || credential.auth === "none") return null;
  const value = configuredCredential(credential.token);
  return value === null ? null : { auth: credential.auth, value };
}

/** The endpoint as a base URL, or `null` when it is not one the HTTP adapter could use. */
function baseOf(endpoint: string): string | null {
  const raw = endpoint.trim();
  if (raw.length === 0) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // A query or fragment on a base URL would be dropped silently by `${url.origin}${path}`; refusing
  // it here is clearer than probing a URL the user did not type.
  if (url.search.length > 0 || url.hash.length > 0) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

type TransportAnswer =
  | { kind: "answered"; status: number; body: string }
  | { kind: "timed-out" }
  | { kind: "redirected"; status: number; location: string | null }
  | { kind: "network"; reason: string };

/** How much of a response `request` reads. */
interface RequestOptions {
  /**
   * When `false`, only the status line is read and the body stream is cancelled immediately.
   *
   * Used for the `/notes` credential check: that route returns the whole note corpus, and buffering
   * it is what let a large or slow answer consume the budget after the hub had already answered 200.
   */
  readBody?: boolean;
}

/**
 * One `GET`, bounded by `AbortController`.
 *
 * The abort covers the body read as well as the headers: a server that sends headers and then
 * stalls would otherwise hold the button down indefinitely. An abort is reported as a timeout — it
 * is our timer that aborted, and "the hub is silent" is the useful statement, not "unreachable".
 *
 * `redirect: "manual"` is deliberate. Following a 30x would carry the credential to whatever origin
 * the redirect names, and this probe exists to validate one configured base URL — not to trust a
 * second one it was never given. With `manual` the browser never follows, but it does hand back a
 * response: a Node/undici caller sees the real `3xx` and its `Location`, a browser sees an
 * `opaqueredirect` whose status is 0 and whose target is hidden. Both are reported as
 * `redirected`, not as a transport failure — the hub *did* answer, and a reverse proxy that
 * redirects http→https is a common, working setup (#110).
 */
async function request(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  options: RequestOptions = {},
): Promise<TransportAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: controller.signal,
      redirect: "manual",
    });
    // A browser's manual redirect is an opaque filtered response: `type` says so and `status` is 0.
    if (response.type === "opaqueredirect") {
      return { kind: "redirected", status: 0, location: null };
    }
    if (response.status >= 300 && response.status < 400) {
      return {
        kind: "redirected",
        status: response.status,
        location: typeof response.headers?.get === "function"
          ? response.headers.get("location")
          : null,
      };
    }
    if (options.readBody === false) {
      cancelBody(response);
      return { kind: "answered", status: response.status, body: "" };
    }
    const body = await response.text();
    return { kind: "answered", status: response.status, body };
  } catch (error) {
    const aborted =
      controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
    if (aborted) return { kind: "timed-out" };
    return { kind: "network", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Releases a response body we are not going to read.
 *
 * Deliberately not awaited: `cancel()` may wait on the transport, and the whole point of status-only
 * mode is that the answer must not depend on the body's lifetime. A rejected cancel is ignored —
 * the stream may already be closed, and that is not a probe failure.
 */
function cancelBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    /* already closed or locked — nothing to release */
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * The six fields the page shows, each only when its type is the one `/config` documents.
 *
 * Unknown or mistyped fields become `null` rather than a plausible-looking default: `readOnly` is
 * `null` (unknown), never `false` (writable), because the wrong answer here is a write attempt.
 */
function summarize(value: unknown): HubConfigSummary | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return {
    name: typeof raw.name === "string" ? raw.name : null,
    version: typeof raw.version === "string" ? raw.version : null,
    auth: raw.auth === "none" || raw.auth === "secret" || raw.auth === "token" ? raw.auth : null,
    readOnly: typeof raw.readOnly === "boolean" ? raw.readOnly : null,
    environment: typeof raw.environment === "string" ? raw.environment : null,
    federates: typeof raw.federates === "boolean" ? raw.federates : null,
  };
}

/** One sentence naming the hub and every field the page wants to surface. */
function describeConfig(config: HubConfigSummary, fallback: string): string {
  const name = config.name !== null && config.name.trim().length > 0 ? config.name : fallback;
  const fields = [
    `Connected to ${name}`,
    config.version === null ? null : `version ${config.version}`,
    `auth ${config.auth ?? "unknown"}`,
    `read-only ${config.readOnly === null ? "unknown" : config.readOnly ? "yes" : "no"}`,
    `environment ${config.environment ?? "unknown"}`,
    `federates ${config.federates === null ? "unknown" : config.federates ? "yes" : "no"}`,
  ];
  return `${fields.filter((field): field is string => field !== null).join(", ")}.`;
}

function failure(status: ConnectionStatus, httpStatus: number | null, message: string): ConnectionResult {
  return { status, ok: false, httpStatus, message, config: null, credential: null };
}

function duration(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

function invalidUrlMessage(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (trimmed.length === 0) {
    return `Enter the full hub URL, including its scheme — for example ${EXAMPLE_BASE}.`;
  }
  return `"${redactEndpoint(trimmed)}" is not a hub URL. Enter the full API base, including its scheme and base path — for example ${EXAMPLE_BASE}.`;
}

/**
 * The endpoint as it may appear in a user-facing message.
 *
 * A URL can carry `user:password@`; that message is rendered and copied around, so the password
 * never belongs in it. Masking runs to the **last** `@` of the authority, because a password may
 * itself contain one (`http://alice:p@ss@host` is one credential, not two) — masking only up to the
 * first `@` left the tail of the password readable. The query and fragment are dropped entirely:
 * `?token=…` is as much a secret as the password, and neither belongs in a status line. Long values
 * are capped too: a stray paste must not flood the status line.
 */
function redactEndpoint(endpoint: string): string {
  const collapsed = endpoint.replace(/\s+/g, " ");
  // Drop everything from the first `?` or `#`: the message names a URL, not its secrets.
  const withoutQuery = collapsed.replace(/[?#].*$/, "");
  // The authority is everything after `scheme://` and before the path, query or fragment. It may
  // contain several `@` characters (an unescaped password), so mask up to the last one. A value
  // pasted without a scheme is masked too: it is rejected as an invalid URL all the same, and the
  // message must not echo the credential back.
  const withoutUserInfo = withoutQuery.replace(
    /^([a-z][a-z0-9+.-]*:\/\/)?([^/?#\s]*)/i,
    (_match: string, scheme: string | undefined, authority: string) => {
      const at = authority.lastIndexOf("@");
      const prefix = scheme ?? "";
      return at === -1 ? `${prefix}${authority}` : `${prefix}***@${authority.slice(at + 1)}`;
    },
  );
  const limit = 120;
  return withoutUserInfo.length <= limit
    ? withoutUserInfo
    : `${withoutUserInfo.slice(0, limit)}… (${withoutUserInfo.length} characters)`;
}

/** The redirect status as `ConnectionResult.httpStatus` can carry it: 0 (opaque) becomes `null`. */
function redirectStatus(status: number): number | null {
  return status >= 300 && status < 400 ? status : null;
}

/**
 * A redirect the probe refused to follow.
 *
 * Not phrased as "unreachable": the hub answered, and a proxy that upgrades http→https usually
 * serves notes correctly by following the redirect — the adapter does. The actionable fix is the
 * final URL, which Node names in `Location` and a browser hides behind `opaqueredirect`.
 */
function redirectedMessage(url: string, status: number, location: string | null): string {
  const code = status >= 300 && status < 400 ? ` (${status})` : "";
  const target =
    location === null
      ? " This browser does not expose the redirect target."
      : ` It points at ${redactEndpoint(location)}.`;
  return `The hub redirected ${url}${code}.${target} The probe does not follow redirects, so it cannot check that route — enter the final URL in the Hub URL field and test again.`;
}

/** A complete sentence from a transport reason that may or may not carry its own terminator. */
function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function unreachableMessage(base: string, reason: string): string {
  return `Could not reach ${base}: ${sentence(reason)} Check that the hub is running and that the URL is reachable from this browser.`;
}

function timeoutMessage(base: string, timeoutMs: number): string {
  return `The hub at ${base} did not answer within ${duration(timeoutMs)}. Check that the URL is right and that the hub is not overloaded.`;
}

/** `/config` answered, but the credential is not a legal header value, so nothing was sent. */
function invalidCredentialMessage(config: HubConfigSummary, base: string): string {
  const report = config.auth === null ? "" : ` The hub reports auth "${config.auth}".`;
  return `The hub answered ${base}/config, but the credential was not sent: it contains characters an HTTP header cannot carry (a line break, a control character or a non-Latin-1 character).${report} Paste the credential again on a single line.`;
}

/**
 * `/config` answered and the URL is right, but the `/notes` check did not produce a verdict.
 *
 * Never phrased as "unreachable" or "timed out" for the whole probe: both would be false, and both
 * are the misdiagnosis #105 exists to remove. `reason` is a complete statement, e.g. "… did not
 * answer within 5 s".
 */
function unverifiedCredentialMessage(config: HubConfigSummary, base: string, reason: string): string {
  return `${describeConfig(config, base)} The credential could not be verified: ${sentence(reason)} The hub's /config route answered, so the URL is right — only the credential check is inconclusive.`;
}

function wrongBasePathMessage(configUrl: string): string {
  return `The hub answered 404 for ${configUrl}. The URL must be the full API base including its base path (for example ${EXAMPLE_BASE}) and must not end in /notes.`;
}

function configUnauthorisedMessage(status: number): string {
  return `The hub answered ${status} before it described itself. Check that the URL is the API base and that any proxy in front of the hub allows GET /config without a credential.`;
}

function httpErrorMessage(base: string, status: number, configUrl: string): string {
  return `The hub at ${base} answered ${status} for ${configUrl}. The URL is reachable, but that route is not answering as expected.`;
}

function rejectedCredentialMessage(status: number, config: HubConfigSummary): string {
  const report = config.auth === null ? "" : ` The hub reports auth "${config.auth}".`;
  return `The hub is reachable, but it rejected the credential (${status}).${report} Check the credential mode: a shared secret goes in x-bluepencil-auth and a signed token in Authorization: Bearer.`;
}
