/**
 * Qualified federation IDs (`instance/noteId`), reserved instance names and the `/` rule
 * (FR-16.11, plan §6).
 *
 * There is no escaping and no URL decoding in v1: identity must stay byte-for-byte stable, so
 * percent-encoding a slash would create collisions. A note id containing `/` is therefore not
 * federatable — it is rejected with `invalid_id`, never silently truncated.
 */

import { FederationError } from "./errors";

/** Read alias for the local instance; also a valid format target. */
export const SELF_INSTANCE = "self" as const;
/** Selectors only: valid for reads/filtering, never a format or write target. */
export const SELECTOR_INSTANCES = ["all", "*"] as const;
/** Names a registry must not use for a concrete instance. */
export const RESERVED_INSTANCES = [SELF_INSTANCE, ...SELECTOR_INSTANCES] as const;
/** Task-spec alias of RESERVED_INSTANCES. */
export const RESERVED_IDS = RESERVED_INSTANCES;

/**
 * A concrete instance id: lowercase alphanumerics plus `.`, `_` and `-`, at most 64 characters.
 * `self` matches this pattern; `all` matches it too and is rejected separately as a selector.
 */
export const INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const PERCENT_ENCODED_SLASH = /%2f/i;

export interface QualifiedId {
  instance: string;
  noteId: string;
}

/** True for a concrete instance id: pattern-valid and not a selector. `self` is valid. */
export function isValidInstanceId(value: string): boolean {
  return INSTANCE_ID_PATTERN.test(value) && !isSelectorInstance(value);
}

/** Throws `FederationError("invalid_id")` unless `value` is a concrete instance id. */
export function assertInstanceId(value: string): void {
  if (isSelectorInstance(value)) {
    throw new FederationError(
      "invalid_id",
      `Invalid instance id "${value}": selectors are not concrete instances.`,
    );
  }
  if (!INSTANCE_ID_PATTERN.test(value)) {
    throw new FederationError(
      "invalid_id",
      `Invalid instance id "${value}": expected 1-64 characters from [a-z0-9._-], starting with a letter or digit.`,
    );
  }
}

/** True for a reserved instance name: `self`, `all` or `*`. */
export function isReservedInstance(value: string): boolean {
  return (RESERVED_INSTANCES as readonly string[]).includes(value);
}

/** True for a selector: `all` or `*`. */
export function isSelectorInstance(value: string): boolean {
  return (SELECTOR_INSTANCES as readonly string[]).includes(value);
}

/** Decodes one path segment, or `undefined` when it is not valid percent-encoding. */
function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * True when the note part is acceptable inside a qualified id: every `/`-separated segment is a
 * real name (not empty, `.` or `..`), the part neither starts nor ends with `/`, and no separator
 * is smuggled in as a backslash or percent-encoded slash.
 *
 * Percent-encoded dots are decoded before the traversal check, so `%2e%2e` is rejected exactly like
 * `..`. The decoded form is also checked for separators, closing the double-encoding gap.
 */
function isFederatableNotePart(noteId: string): boolean {
  if (noteId === "") return false;
  if (noteId.startsWith("/") || noteId.endsWith("/")) return false;
  if (noteId.includes("\\")) return false;
  if (PERCENT_ENCODED_SLASH.test(noteId)) return false;

  for (const segment of noteId.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return false;
    const decoded = decodeSegment(segment);
    if (decoded === undefined) return false;
    if (decoded === "." || decoded === "..") return false;
    if (decoded.includes("\\") || PERCENT_ENCODED_SLASH.test(decoded)) return false;
  }

  return true;
}

/**
 * Splits at the FIRST `/` only. Returns `null` for an unqualified/invalid id. Selectors are
 * accepted here because parsing is permissive; only formatting and writes reject them.
 * The note part may contain further `/` (referenced as `n-1/x` by T01), but no path traversal:
 * empty, `.` and `..` segments are rejected.
 */
export function parseQualifiedId(value: string): QualifiedId | null {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;

  const instance = value.slice(0, slash);
  const noteId = value.slice(slash + 1);

  if (!INSTANCE_ID_PATTERN.test(instance) && !isSelectorInstance(instance)) return null;
  if (!isFederatableNotePart(noteId)) return null;

  return { instance, noteId };
}

/** Task-spec alias of parseQualifiedId. */
export const parseRef = parseQualifiedId;

/**
 * Formats `instance/noteId`. `self` is allowed (read alias); `all`/`*` are selectors and throw
 * `FederationError("invalid_id")`. `noteId` must be federatable — no `/`, no traversal.
 */
export function formatQualifiedId(instance: string, noteId: string): string {
  assertInstanceId(instance);
  assertFederatableNoteId(noteId);
  return `${instance}/${noteId}`;
}

/** Task-spec alias of formatQualifiedId. */
export const qualify = formatQualifiedId;

/**
 * Throws `FederationError("invalid_id")` for a note id that cannot be used in a qualified id:
 * empty, `"."`, `".."`, any `/`, any backslash or a percent-encoded slash. Never truncates.
 */
export function assertFederatableNoteId(id: string): void {
  if (id === "") {
    throw new FederationError("invalid_id", `Invalid note id "": note id must not be empty.`);
  }
  if (id === "." || id === "..") {
    throw new FederationError(
      "invalid_id",
      `Invalid note id "${id}": path segments "." and ".." are not allowed.`,
    );
  }
  if (id.includes("/")) {
    throw new FederationError(
      "invalid_id",
      `Invalid note id "${id}": note ids must not contain "/".`,
    );
  }
  if (id.includes("\\")) {
    throw new FederationError(
      "invalid_id",
      `Invalid note id "${id}": note ids must not contain "\\".`,
    );
  }
  if (PERCENT_ENCODED_SLASH.test(id)) {
    throw new FederationError(
      "invalid_id",
      `Invalid note id "${id}": percent-encoded slashes are not allowed.`,
    );
  }

  // `parse` decodes percent escapes before applying the path rules, so `format` must reject
  // anything that would decode into a traversal or separator — otherwise format and parse
  // disagree about the same id (N-03).
  const decoded = decodeSegment(id);
  if (decoded === undefined) {
    throw new FederationError(
      "invalid_id",
      `Invalid note id "${id}": malformed percent-encoding.`,
    );
  }
  if (decoded === "." || decoded === "..") {
    throw new FederationError(
      "invalid_id",
      `Invalid note id "${id}": decoded path segments "." and ".." are not allowed.`,
    );
  }
  if (decoded.includes("/") || decoded.includes("\\")) {
    throw new FederationError(
      "invalid_id",
      `Invalid note id "${id}": decoded note ids must not contain path separators.`,
    );
  }
  if (PERCENT_ENCODED_SLASH.test(decoded)) {
    throw new FederationError(
      "invalid_id",
      `Invalid note id "${id}": percent-encoded slashes are not allowed.`,
    );
  }
}
