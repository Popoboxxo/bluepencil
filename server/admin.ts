/**
 * The hub's admin surface (`{base}/admin`) — a page and the routes behind it, all optional.
 *
 * Design, and why it sits where it does:
 *
 * - **Off unless configured.** Without `--admin-secret` (or `BLUEPENCIL_ADMIN_SECRET`) the routes do
 *   not exist: the handler below returns `null` and the request falls through to the normal 404. An
 *   admin surface that can be forgotten into existence is the wrong default for a hub whose whole
 *   point is that every door is closed unless it was opened.
 * - **Its own gate, its own header** (`x-bluepencil-admin`). The hub's `x-bluepencil-auth` is the
 *   credential a *client* carries — the extension has it in every browser on the machine. The admin
 *   secret is the operator's, so the two never leak into each other. The notes routes opt into the
 *   admin secret as a second credential (`authorize(..., { allowAdminSecret })`) so the page edits
 *   notes with the one value it holds; the MCP door never does.
 * - **The page itself is not gated.** It carries no notes and no settings, and the operator types
 *   the credential into it. Gating it would make "open the admin page" require curl. Its responses
 *   are still hardened: no store, no framing, no referrer.
 * - **No framework, no client dependency.** The page is one embedded string of vanilla HTML/JS —
 *   the same shape the extension's options page already has. A hub runtime image ships
 *   `dist/server.js` and nothing else; a bundled UI framework would be its first client dependency
 *   and its largest unreviewed payload, on a page that sits behind a secret.
 * - **Token issuing needs the hub's signing key.** Minting reuses `server/tokens.ts`'s issuer, which
 *   only exists when the hub runs with `--token-key`. Without it the page says so and offers the
 *   shared secret, which is the other credential this hub speaks.
 * - **Revocation is durable.** A revoked id joins the live set *and* the `--revoked-tokens` file, so
 *   the cut-off device stays cut off after a restart (a memory-only revocation would be a speed
 *   bump, not a revocation). Without that file the revocation is live until restart and the answer
 *   says so, rather than pretending.
 * - **A corrupt registry is never overwritten.** Every route reads `devices.json` first and reports
 *   `registry_unreadable` instead of replacing a file it could not parse — losing the record of
 *   which devices exist is worse than a 500 on one route.
 * - **Credential management survives `--read-only`.** Minting and revoking are not note writes;
 *   a presentation hub still needs to be able to cut a device off. Note writes stay 403.
 * - **Limits and a brake.** Device names, token ids and TTLs are bounded, and failed secret checks
 *   are throttled by the injected `AdminThrottle` (10 per 5 minutes per peer, then 429).
 *
 * The notes themselves are edited through the *existing* notes API with the admin secret, so there
 * is exactly one implementation of note handling in this repository.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { HandlerContext, ServerErrorCode, ServerRequest, ServerResponse } from "./handler";
import { corsHeaders, preflightResponse } from "./cors";
import { writeAtomic } from "./atomic-write";
import { renderAdminHtml } from "./admin-html";
import { ADMIN_STRINGS, adminLanguage } from "./admin-i18n";
import { presenceOf } from "./presence";
import { acceptedCredentials, credentialMode } from "./credentials";

/** The header an admin request carries; matched case-insensitively by the caller. */
export const ADMIN_HEADER = "x-bluepencil-admin";

/** Longest accepted device name — enough for "caro's laptop (firefox)" and short enough to render. */
const DEVICE_NAME_MAX_LENGTH = 200;
/** Longest accepted token id — the issuer's ids are short; this only bounds a hostile body. */
const JTI_MAX_LENGTH = 256;
/** Longest accepted token lifetime: 365 days. */
const MAX_TTL_SECONDS = 365 * 24 * 60 * 60;

/** The shape of a token this hub issues — a structural type, so this file never imports the issuer. */
interface IssuedShape {
  token: string;
  claims: { jti: string; device: string; scope: readonly string[]; exp: string };
}

/** What the devices registry records per issued token. */
export interface DeviceRecord {
  jti: string;
  device: string;
  scope: readonly string[];
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
}

/**
 * The result of reading the registry: the records, or a one-line error naming the file and the
 * problem. A corrupt registry is never reported as "no devices" — the operator has to be able to
 * tell an empty hub from a broken one.
 */
export interface RegistryRead {
  records: DeviceRecord[];
  error?: string;
}

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/** Every admin answer carries the admin CORS vocabulary, including the door's own header. */
function adminCors(context: HandlerContext): Record<string, string> {
  return corsHeaders(context.cors, [ADMIN_HEADER]);
}

function json(
  context: HandlerContext,
  status: number,
  payload: unknown,
  extra: Record<string, string> = {},
): ServerResponse {
  return {
    status,
    headers: {
      "content-type": JSON_CONTENT_TYPE,
      "cache-control": "no-store",
      ...adminCors(context),
      ...extra,
    },
    body: JSON.stringify(payload),
  };
}

/** The page: no store, no framing, no referrer — and no `default-src` CSP (the inline script runs). */
function page(context: HandlerContext, request: ServerRequest): ServerResponse {
  const strings = ADMIN_STRINGS[adminLanguage(headerOf(request, "accept-language"))];
  return {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      ...adminCors(context),
    },
    body: renderAdminHtml(strings),
  };
}

/** A refused admin request — the same four shapes the notes door answers with. */
function refusal(
  context: HandlerContext,
  status: number,
  code: ServerErrorCode,
  message: string,
): ServerResponse {
  return json(context, status, { error: { code, message } });
}

/** Header lookup, matched case-insensitively like `headerValue()` in `server/handler.ts`. */
function headerOf(request: ServerRequest, name: string): string | undefined {
  const headers = request.headers;
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = headers[key];
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/**
 * Path of a request target, mirroring `parseRequestUrl()` in `server/handler.ts`: `//host/path` is a
 * path on this server, not a protocol-relative URL. `new URL` still normalises `..`.
 */
function requestPath(url: string): string {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
  const target = absolute ? url : `http://localhost${url.startsWith("/") ? "" : "/"}${url}`;
  return new URL(target).pathname;
}

/** Constant-time-ish comparison, mirroring the notes door's own secret check. */
function matches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  let diff = expected.length ^ presented.length;
  for (let i = 0; i < Math.max(expected.length, presented.length); i += 1) {
    diff |= (expected.charCodeAt(i) ?? 0) ^ (presented.charCodeAt(i) ?? 0);
  }
  return diff === 0;
}

function bodyOf(request: ServerRequest): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(request.body || "{}");
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through to the empty body the validators then refuse */
  }
  return {};
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the device registry. A missing path or a missing file is the documented empty start; every
 * other problem — unreadable file, invalid JSON, a document that is not an array, an entry that is
 * not an object with string `jti`/`device` — comes back as `error` with an empty list, never as a
 * silent "no devices". Extra fields are tolerated; the known ones are normalised so a caller never
 * has to defend against a hand-edited file.
 */
export function readRegistry(path: string | undefined): RegistryRead {
  if (path === undefined) return { records: [] };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [] };
    return { records: [], error: `the device registry ${path} could not be read: ${errorText(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return { records: [], error: `the device registry ${path} is not valid JSON: ${errorText(error)}` };
  }
  if (!Array.isArray(parsed)) {
    return { records: [], error: `the device registry ${path} must contain a JSON array of device records` };
  }
  const records: DeviceRecord[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { records: [], error: `the device registry ${path} contains an entry that is not an object` };
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.jti !== "string" || typeof record.device !== "string") {
      return {
        records: [],
        error: `the device registry ${path} contains an entry without a string "jti" and "device"`,
      };
    }
    records.push({
      jti: record.jti,
      device: record.device,
      scope: Array.isArray(record.scope)
        ? record.scope.filter((scope): scope is string => typeof scope === "string")
        : [],
      createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
      expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : "",
      revoked: record.revoked === true,
    });
  }
  return { records };
}

/** Writes the registry atomically; a write failure is reported, never swallowed. */
function writeRegistry(path: string | undefined, records: DeviceRecord[]): void {
  if (path === undefined) return;
  writeAtomic(path, JSON.stringify(records, null, 2));
}

/** What the status route reports — the page's whole idea of "connected". */
function statusPayload(context: HandlerContext, registry: RegistryRead): Record<string, unknown> {
  const revoked = context.revokedTokens;
  return {
    version: context.version,
    name: context.hubName,
    environment: context.environment,
    readOnly: context.readOnly === true,
    federates: context.federates === true,
    notes: context.store.notes.length,
    // Both credentials are named (#112): `auth` says `token+secret` when the hub accepts both, and
    // `credentials` lists them in preference order. Both come from the one helper in
    // `server/credentials.ts`; no value ever enters this payload.
    auth: credentialMode(context),
    credentials: acceptedCredentials(context),
    admin: true,
    tokenIssuing: context.tokenIssuer !== undefined,
    revocationDurable: context.revocationPath !== undefined,
    // The number of *issued credentials* in the registry — one record per token minted here, NOT a
    // count of connected clients. The key keeps its historical name for backward compatibility; the
    // page labels it "Issued client credentials" and says what the hub cannot see.
    devices: registry.records.length,
    // Additive presence signal (see `server/presence.ts`): when a credential kind was last accepted
    // on either door. Timestamps only — never a credential value, never a client identity, never
    // persisted. `null` means "not seen since this process started".
    presence: presenceOf(context).snapshot(),
    // A broken registry must not look like an empty one; the route still answers 200 so the page
    // can render the rest of the status.
    ...(registry.error === undefined ? {} : { devicesError: registry.error }),
    revoked: revoked === undefined ? 0 : revoked.size,
  };
}

/**
 * The note the revoke answer carries: only when it has something true to add. "durable" and "live
 * only" are the distinction an operator acts on, so a successful durable revocation that was in the
 * registry needs no note at all.
 */
function revocationNote(durable: boolean, known: boolean, error: string | undefined): string | undefined {
  if (durable) {
    return known
      ? undefined
      : "the id was added to the revocation list — tokens minted with the CLI are not in devices.json";
  }
  if (!known) {
    return error === undefined
      ? "live only for this process"
      : "live only for this process — the revocation list could not be written";
  }
  return error === undefined ? "live only (no revocation file configured)" : "live only — the revocation list could not be written";
}

/**
 * Handles `{base}/admin…`; returns `null` when the request is not an admin request (or when this hub
 * runs without `--admin-secret`, so the caller answers the ordinary 404 and the surface stays
 * invisible rather than merely guarded).
 */
export function handleAdmin(request: ServerRequest, context: HandlerContext): ServerResponse | null {
  const method = (request.method ?? "GET").toUpperCase();
  // The helper normalises `..` exactly like the router does; splitting on "?" would let
  // `/admin/../admin/status` through as a different path than the one it actually resolves to.
  const rawPath = requestPath(request.url ?? "/");
  const base = context.base.replace(/\/+$/, "");
  const prefix = `${base}/admin`;
  if (rawPath !== prefix && !rawPath.startsWith(`${prefix}/`)) return null;

  // Not configured: this hub has no admin surface at all — the router's ordinary 404, not a locked
  // page that advertises itself. Checked before everything below, including the page itself.
  if (context.adminSecret === undefined) {
    return null;
  }

  // `{prefix}/` is the page as well: a browser address bar and a hand-typed URL both end up there,
  // and the documented-method table below must keep treating it as the page rather than a 404.
  const path = rawPath === `${prefix}/` ? prefix : rawPath;

  // The documented methods per path — the same contract rule as everywhere else: a known path with
  // the wrong method is 405, never a 404 that pretends the path is not there.
  const documented =
    path === prefix
      ? ["GET"]
      : path === `${prefix}/status`
        ? ["GET"]
        : path === `${prefix}/devices`
          ? ["GET", "POST"]
          : path === `${prefix}/devices/revoke`
            ? ["POST"]
            : null;
  if (documented === null) {
    return refusal(context, 404, "not_found", `unknown admin endpoint ${path.replace(base, "")}`);
  }

  // A CORS preflight carries no custom header — the browser cannot know the secret yet — so it is
  // answered before the gate. Only with `--cors`: without it there is no cross-origin caller to
  // answer, and OPTIONS keeps the ordinary 405. The shared helper supplies the CORS vocabulary (and
  // takes the door's own header); `documented` is authoritative for the advertised methods, so
  // `/admin/status` does not advertise the notes API's `PATCH`.
  const preflight = preflightResponse(method, context, documented, [ADMIN_HEADER]);
  if (preflight !== null) {
    return {
      ...preflight,
      headers: { ...preflight.headers, allow: [...documented, "OPTIONS"].join(", ") },
    };
  }

  if (!documented.includes(method)) {
    const response = refusal(
      context,
      405,
      "method_not_allowed",
      `${method} is not allowed on ${path.replace(base, "")} — documented method(s): ${documented.join(", ")}`,
    );
    response.headers.allow = documented.join(", ");
    return response;
  }

  // The page itself is not a secret — it carries no notes and no settings, and the operator types
  // the credential into it. Gating it would make "open the admin page" require curl.
  if (path === prefix && method === "GET") {
    return page(context, request);
  }

  // Brute-force brake before the comparison, never after: a wrong guess costs the peer its budget,
  // and a peer that exhausted it learns nothing from the answer except that it must wait.
  if (context.adminThrottle !== undefined && !context.adminThrottle.allow(request.remote)) {
    return json(
      context,
      429,
      {
        error: {
          code: "too_many_attempts",
          message: `too many wrong ${ADMIN_HEADER} attempts from this address — wait before trying again`,
        },
      },
      { "retry-after": "300" },
    );
  }

  const presented = headerOf(request, ADMIN_HEADER);
  if (!matches(context.adminSecret, presented)) {
    context.adminThrottle?.failure(request.remote);
    return refusal(
      context,
      401,
      "unauthorized",
      presented === undefined
        ? `missing ${ADMIN_HEADER} — this hub's admin surface is enabled (--admin-secret)`
        : `invalid ${ADMIN_HEADER}`,
    );
  }
  context.adminThrottle?.success(request.remote);

  if (path === `${prefix}/status` && method === "GET") {
    return json(context, 200, statusPayload(context, readRegistry(context.devicesPath)));
  }

  if (path === `${prefix}/devices` && method === "GET") {
    const registry = readRegistry(context.devicesPath);
    if (registry.error !== undefined) {
      return refusal(context, 500, "registry_unreadable", registry.error);
    }
    // "Currently revoked" is the live set, not the flag on disk: after a restart without a
    // `--revoked-tokens` file the record may still say `revoked: false` while the process holds a
    // revocation from earlier, or the reverse after a hand-edited registry.
    const revoked = context.revokedTokens;
    return json(context, 200, {
      devices: registry.records.map((record) => ({
        ...record,
        revoked: record.revoked || revoked?.has(record.jti) === true,
      })),
      tokenIssuing: context.tokenIssuer !== undefined,
      revocationDurable: context.revocationPath !== undefined,
    });
  }

  if (path === `${prefix}/devices` && method === "POST") {
    // Read first: a corrupt registry must stop the mint before anything is written. Appending to a
    // file we could not parse would silently replace the record of every other device.
    const registry = readRegistry(context.devicesPath);
    if (registry.error !== undefined) {
      return refusal(context, 500, "registry_unreadable", registry.error);
    }
    const issuer = context.tokenIssuer;
    if (issuer === undefined) {
      return refusal(
        context,
        409,
        "no_signing_key",
        "this hub has no --token-key, so it cannot issue tokens — use the shared secret instead",
      );
    }
    const body = bodyOf(request);
    const device = typeof body.device === "string" ? body.device.trim() : "";
    if (device.length === 0 || device.length > DEVICE_NAME_MAX_LENGTH) {
      return refusal(
        context,
        400,
        "invalid_payload",
        `device must be a name of 1..${DEVICE_NAME_MAX_LENGTH} characters`,
      );
    }
    const scope = Array.isArray(body.scope) ? body.scope : ["read", "write"];
    if (!scope.every((entry) => entry === "read" || entry === "write") || scope.length === 0) {
      return refusal(context, 400, "invalid_payload", "scope must be a non-empty list of read and/or write");
    }
    const ttlSeconds = body.ttlSeconds;
    if (
      ttlSeconds !== undefined &&
      (typeof ttlSeconds !== "number" ||
        !Number.isInteger(ttlSeconds) ||
        ttlSeconds <= 0 ||
        ttlSeconds > MAX_TTL_SECONDS)
    ) {
      return refusal(
        context,
        400,
        "invalid_payload",
        `ttlSeconds must be a positive integer of at most ${MAX_TTL_SECONDS} (365 days)`,
      );
    }
    let issued: IssuedShape;
    try {
      issued = issuer.issue({
        device,
        scope: scope as ("read" | "write")[],
        ...(typeof ttlSeconds === "number" ? { ttlSeconds } : {}),
      });
    } catch (error) {
      return refusal(context, 400, "invalid_payload", errorText(error));
    }
    const record: DeviceRecord = {
      jti: issued.claims.jti,
      device: issued.claims.device,
      scope: issued.claims.scope,
      createdAt: new Date().toISOString(),
      expiresAt: issued.claims.exp,
      revoked: false,
    };
    try {
      writeRegistry(context.devicesPath, [...registry.records, record]);
    } catch (error) {
      return refusal(context, 500, "internal_error", errorText(error));
    }
    // The token is shown exactly once, here: the hub keeps no copy, only the id.
    return json(context, 201, {
      token: issued.token,
      jti: record.jti,
      device: record.device,
      scope: record.scope,
      expiresAt: record.expiresAt,
      note: "copy it now — the hub stores the id, not the token",
    });
  }

  if (path === `${prefix}/devices/revoke` && method === "POST") {
    // No revoker wired by the host: claiming a revocation happened would be a lie. This hub's own
    // glue always injects one, so the answer is for an embedding host that did not.
    if (context.revokeToken === undefined) {
      return refusal(
        context,
        409,
        "revocation_unavailable",
        "this host wired no revocation — the token cannot be revoked through this hub",
      );
    }
    const body = bodyOf(request);
    const jti = typeof body.jti === "string" ? body.jti.trim() : "";
    if (jti.length === 0 || jti.length > JTI_MAX_LENGTH) {
      return refusal(
        context,
        400,
        "invalid_payload",
        `jti must be the id of the token to revoke (1..${JTI_MAX_LENGTH} characters)`,
      );
    }
    // Revoke first and unconditionally: cutting the device off must not depend on a file the hub
    // may not be able to read. The registry update is a record-keeping step after it.
    const revocation = context.revokeToken?.(jti) ?? { durable: false };
    const registry = readRegistry(context.devicesPath);
    const known = registry.records.some((record) => record.jti === jti);
    let registryError = registry.error;
    if (registryError === undefined && known) {
      try {
        writeRegistry(
          context.devicesPath,
          registry.records.map((record) => (record.jti === jti ? { ...record, revoked: true } : record)),
        );
      } catch (error) {
        registryError = `the device registry ${context.devicesPath ?? "devices.json"} could not be updated: ${errorText(error)}`;
      }
    }
    const note = revocationNote(revocation.durable, known, revocation.error);
    return json(context, 200, {
      revoked: jti,
      known,
      durable: revocation.durable,
      ...(note === undefined ? {} : { note }),
      ...(registryError === undefined ? {} : { registryError }),
      ...(revocation.error === undefined ? {} : { revocationError: revocation.error }),
    });
  }

  return refusal(
    context,
    404,
    "not_found",
    `unknown admin endpoint ${path.replace(base, "")} — documented: /admin, /admin/status, /admin/devices, /admin/devices/revoke`,
  );
}

/** Where the device registry lives: next to the store file, named after it. */
export function devicesPathFor(storePath: string | undefined): string | undefined {
  if (storePath === undefined) return undefined;
  return join(dirname(storePath), "devices.json");
}
