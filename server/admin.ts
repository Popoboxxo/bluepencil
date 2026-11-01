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
 *   secret is the operator's, so the two never leak into each other. `authorize()` accepts the admin
 *   secret as a *notes* credential on purpose (the page edits notes), which is why the page keeps
 *   exactly one secret and never asks for the hub's.
 * - **No framework, no client dependency.** The page is one embedded string of vanilla HTML/JS —
 *   the same shape the extension's options page already has. A hub runtime image ships
 *   `dist/server.js` and nothing else; a bundled UI framework would be its first client dependency
 *   and its largest unreviewed payload, on a page that sits behind a secret.
 * - **Token issuing needs the hub's signing key.** Minting reuses `server/tokens.ts`'s issuer, which
 *   only exists when the hub runs with `--token-key`. Without it the page says so and offers the
 *   shared secret, which is the other credential this hub speaks.
 * - **Revocation is durable.** A revoked id joins the live set *and* the `--revoked-tokens` file, so
 *   the cut-off device stays cut off after a restart (a memory-only revocation would be a speed
 *   bump, not a revocation). Without that file the revocation is live until restart and the page
 *   says so, rather than pretending.
 *
 * The notes themselves are edited through the *existing* notes API with the admin secret, so there
 * is exactly one implementation of note handling in this repository.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { HandlerContext, ServerRequest, ServerResponse } from "./handler";
import { ADMIN_HTML } from "./admin-html";

/** The header an admin request carries; matched case-insensitively by the caller. */
export const ADMIN_HEADER = "x-bluepencil-admin";

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

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

function json(status: number, payload: unknown): ServerResponse {
  return { status, headers: { "content-type": JSON_CONTENT_TYPE }, body: JSON.stringify(payload) };
}

function html(body: string): ServerResponse {
  return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body };
}

/** A refused admin request — the same four shapes the notes door answers with. */
function refusal(context: HandlerContext, status: number, code: string, message: string): ServerResponse {
  const response = json(status, { error: { code, message } });
  if (context.cors !== undefined && context.cors !== "") {
    Object.assign(response.headers, corsForAdmin(context));
  }
  return response;
}

/**
 * CORS metadata for the admin routes. The page is same-origin (it is served from this hub), so these
 * headers are only about a client scripting the routes from elsewhere — kept identical to the API's
 * so a hub operator sees one vocabulary, not two.
 */
function corsForAdmin(context: HandlerContext): Record<string, string> {
  if (context.cors === undefined || context.cors === "") return {};
  return {
    "access-control-allow-origin": context.cors,
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
    "access-control-allow-headers": `Content-Type, Authorization, ${ADMIN_HEADER}`,
  };
}

function headerOf(request: ServerRequest, name: string): string | undefined {
  const raw = request.headers?.[name];
  if (Array.isArray(raw)) return raw[0];
  return raw;
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

/** The registry lives next to the store: one JSON file, written atomically like the store itself. */
function readRegistry(path: string | undefined): DeviceRecord[] {
  if (path === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is DeviceRecord =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as DeviceRecord).jti === "string" &&
        typeof (entry as DeviceRecord).device === "string",
    );
  } catch {
    // A missing file is a hub that has issued nothing yet; an unreadable one would have been a
    // startup failure had it been configured. Both answer as "no devices" rather than failing the
    // page — the operator sees an empty list, not a stack trace.
    return [];
  }
}

function writeRegistry(path: string | undefined, records: DeviceRecord[]): void {
  if (path === undefined) return;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(records, null, 2), "utf8");
  try {
    renameSync(tmp, path);
  } catch (error) {
    throw new Error(`could not write the device registry ${path}: ${String(error)}`);
  }
}

/** What the status route reports — the page's whole idea of "connected". */
function statusPayload(context: HandlerContext, records: DeviceRecord[]): Record<string, unknown> {
  const revoked = context.revokedTokens;
  return {
    version: context.version,
    name: context.hubName,
    environment: context.environment,
    readOnly: context.readOnly === true,
    federates: context.federates === true,
    notes: context.store.notes.length,
    auth: context.verifyToken !== undefined ? "token" : context.authSecret !== undefined ? "secret" : "none",
    admin: true,
    tokenIssuing: context.tokenIssuer !== undefined,
    revocationDurable: context.revocationPath !== undefined,
    devices: records.length,
    revoked: revoked === undefined ? 0 : revoked.size,
  };
}

/**
 * Handles `{base}/admin…`; returns `null` when the request is not an admin request (or when this hub
 * runs without `--admin-secret`, so the caller answers the ordinary 404 and the surface stays
 * invisible rather than merely guarded).
 */
export function handleAdmin(request: ServerRequest, context: HandlerContext): ServerResponse | null {
  const method = (request.method ?? "GET").toUpperCase();
  const path = request.url.split("?")[0] ?? "";
  const base = context.base.replace(/\/+$/, "");
  const prefix = `${base}/admin`;
  if (path !== prefix && !path.startsWith(`${prefix}/`)) return null;

  // Not configured: this hub has no admin surface at all — the router's ordinary 404, not a locked
  // page that advertises itself. Checked before everything below, including the page itself.
  if (context.adminSecret === undefined) {
    return null;
  }

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
    return html(ADMIN_HTML);
  }

  const presented = headerOf(request, ADMIN_HEADER);
  if (!matches(context.adminSecret, presented)) {
    return refusal(
      context,
      401,
      "unauthorized",
      presented === undefined
        ? `missing ${ADMIN_HEADER} — this hub's admin surface is enabled (--admin-secret)`
        : `invalid ${ADMIN_HEADER}`,
    );
  }

  if (path === `${prefix}/status` && method === "GET") {
    return json(200, statusPayload(context, readRegistry(context.devicesPath)));
  }

  if (path === `${prefix}/devices` && method === "GET") {
    const records = readRegistry(context.devicesPath);
    return json(200, {
      devices: records,
      tokenIssuing: context.tokenIssuer !== undefined,
      revocationDurable: context.revocationPath !== undefined,
    });
  }

  if (path === `${prefix}/devices` && method === "POST") {
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
    if (device.length === 0) {
      return refusal(context, 400, "invalid_payload", "device must be a non-empty name");
    }
    const scope = Array.isArray(body.scope) ? body.scope : ["read", "write"];
    if (!scope.every((entry) => entry === "read" || entry === "write") || scope.length === 0) {
      return refusal(context, 400, "invalid_payload", "scope must be a non-empty list of read and/or write");
    }
    const ttlSeconds = body.ttlSeconds;
    if (ttlSeconds !== undefined && (typeof ttlSeconds !== "number" || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0)) {
      return refusal(context, 400, "invalid_payload", "ttlSeconds must be a positive integer");
    }
    let issued: IssuedShape;
    try {
      issued = issuer.issue({
        device,
        scope: scope as ("read" | "write")[],
        ...(typeof ttlSeconds === "number" ? { ttlSeconds } : {}),
      });
    } catch (error) {
      return refusal(context, 400, "invalid_payload", error instanceof Error ? error.message : String(error));
    }
    const record: DeviceRecord = {
      jti: issued.claims.jti,
      device: issued.claims.device,
      scope: issued.claims.scope,
      createdAt: new Date().toISOString(),
      expiresAt: issued.claims.exp,
      revoked: false,
    };
    const records = readRegistry(context.devicesPath);
    try {
      writeRegistry(context.devicesPath, [...records, record]);
    } catch (error) {
      return refusal(context, 500, "internal_error", error instanceof Error ? error.message : String(error));
    }
    // The token is shown exactly once, here: the hub keeps no copy, only the id.
    return json(201, {
      token: issued.token,
      jti: record.jti,
      device: record.device,
      scope: record.scope,
      expiresAt: record.expiresAt,
      note: "copy it now — the hub stores the id, not the token",
    });
  }

  if (path === `${prefix}/devices/revoke` && method === "POST") {
    const body = bodyOf(request);
    const jti = typeof body.jti === "string" ? body.jti.trim() : "";
    if (jti.length === 0) {
      return refusal(context, 400, "invalid_payload", "jti must be the id of the token to revoke");
    }
    context.revokeToken?.(jti);
    const records = readRegistry(context.devicesPath);
    const known = records.some((record) => record.jti === jti);
    writeRegistry(
      context.devicesPath,
      known ? records.map((record) => (record.jti === jti ? { ...record, revoked: true } : record)) : records,
    );
    return json(200, {
      revoked: jti,
      known,
      durable: context.revocationPath !== undefined,
      ...(known ? {} : { note: "the id was not in the registry — revoked live only, listed for audit" }),
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
