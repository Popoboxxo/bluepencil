/**
 * Origin normalisation and parsing (FR-2.2, G5) — the one implementation every surface shares.
 *
 * A note carries the origin it was taken on (`NoteOrigin` in `model.ts`). Origins arrive from
 * browsers, bundles, the hub, the CLI and MCP, so they have to look identical everywhere: the
 * storage key, the bundle, the filter and the comparison all read the canonical form produced
 * here. There is deliberately no second normaliser (FR-15.3).
 *
 * The rules follow the URL Standard via the built-in `URL`:
 *  - only `http:`/`https:` (plus `blob:` whose inner URL is http(s));
 *  - scheme and host are lowercased, IDN labels become punycode;
 *  - the default port (80 for http, 443 for https) is elided, any other port stays;
 *  - userinfo, path, query and fragment are dropped;
 *  - an origin longer than 512 characters is refused.
 *
 * Everything that is not a usable origin maps to `null` — this module is total and never throws
 * (a page on `file:` is "unassigned", not a crash). Callers that must tell "invalid" from
 * "unassigned" apart use `parseOriginInput`, which is the strict variant for hub/MCP boundaries.
 *
 * `Note` is imported as a type only: `model.ts` imports the runtime `normaliseOrigin`, so this
 * direction stays a type-only edge and cannot form a runtime cycle.
 */
import type { Note, NoteOrigin } from "./model";

/** Longest origin we accept — protects storage keys and logs from absurd input. */
const MAX_ORIGIN_LENGTH = 512;

/** Schemes that have a real, comparable origin. */
const HTTP_PROTOCOLS = ["http:", "https:"];

/** Parse a string as a URL; `null` for anything the URL Standard refuses. */
function toUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isHttpProtocol(protocol: string): boolean {
  return HTTP_PROTOCOLS.includes(protocol);
}

/** Canonical origin of an already-parsed http(s) URL, or `null` when it has none. */
function httpOriginOf(url: URL): NoteOrigin {
  const origin = url.origin;
  if (origin === "null" || origin.length === 0 || origin.length > MAX_ORIGIN_LENGTH) {
    return null;
  }
  return origin;
}

/**
 * Normalise any value to a canonical origin or `null` (FR-2.2).
 *
 * Total by contract: non-strings, opaque schemes, unparseable input and over-long strings all
 * become `null` instead of throwing. A `blob:` URL is reduced to the origin of its inner URL,
 * but only when that inner URL is http(s) — `blob:null/…` and nested blob URLs stay `null`.
 */
export function normaliseOrigin(value: unknown): NoteOrigin {
  if (typeof value !== "string") {
    return null;
  }
  // Check the raw length first: a >512-character input is refused even if it would parse.
  if (value.length > MAX_ORIGIN_LENGTH) {
    return null;
  }
  const url = toUrl(value);
  if (url === null) {
    return null;
  }
  if (isHttpProtocol(url.protocol)) {
    return httpOriginOf(url);
  }
  if (url.protocol === "blob:") {
    const inner = toUrl(url.pathname);
    if (inner === null || !isHttpProtocol(inner.protocol)) {
      return null;
    }
    return httpOriginOf(inner);
  }
  return null;
}

/** Strict result of `parseOriginInput`: either a canonical origin or a named refusal. */
export type OriginInput =
  | { ok: true; origin: NoteOrigin }
  | { ok: false; code: "invalid_origin" };

/**
 * Strict parser for the hub/MCP boundary (G5, RVW-08): tell "unassigned" from "invalid".
 *
 * `undefined`, `null`, `""` and the literal `"null"` mean "no origin" and succeed with `null`.
 * Any string that `normaliseOrigin` maps to a non-null value succeeds with that canonical string.
 * Every other value — a non-string, an opaque scheme, whitespace-only text, a non-canonical
 * origin such as `"https://A.example"`, anything over 512 characters — is `invalid_origin`.
 */
export function parseOriginInput(value: unknown): OriginInput {
  if (value === undefined || value === null || value === "" || value === "null") {
    return { ok: true, origin: null };
  }
  if (typeof value !== "string") {
    return { ok: false, code: "invalid_origin" };
  }
  const origin = normaliseOrigin(value);
  if (origin === null) {
    return { ok: false, code: "invalid_origin" };
  }
  return { ok: true, origin };
}

/**
 * The only read access to a note's origin: an absent field means `null` (FR-2.2).
 *
 * The stored value is already canonical (schema and adapter enforce it); this is a reader, not
 * a normaliser, so a caller that needs normalisation uses `normaliseOrigin` on the raw input.
 */
export function originOf(note: Pick<Note, "origin">): NoteOrigin {
  return note.origin ?? null;
}

/**
 * Canonical origin of a location-like object — the capture entry point (FR-2.2).
 *
 * Takes `globalThis.location` (or any `{ origin }`) without touching the DOM: an opaque origin
 * (`"null"` on `file:`) and a missing/invalid value both become `null`.
 */
export function currentOrigin(location?: { origin?: unknown } | null): NoteOrigin {
  if (location === null || location === undefined) {
    return null;
  }
  const origin = location.origin;
  if (typeof origin !== "string") {
    return null;
  }
  return normaliseOrigin(origin);
}
