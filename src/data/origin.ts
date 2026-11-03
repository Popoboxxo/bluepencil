/**
 * Storage-key helpers for the per-origin extension store (G5, SEC-13) — DOM-free.
 *
 * The extension partitions `chrome.storage.local` by page origin: one key per origin
 * (`bluepencil:v2:<origin>`), plus the untouched legacy blob (`bluepencil:default:v1`) and the
 * assign sidecar (`bluepencil:assign:<origin>`). This module owns that key layout, so the relay,
 * the review page and the productive adapter derive keys the same way.
 *
 * The normalisation itself is NOT implemented here: `normaliseOrigin`/`currentOrigin` come from
 * `src/core/origin.ts`, the one origin implementation every surface shares (FR-15.3). This module
 * only turns a canonical origin into a key and back — it never invents a second normaliser.
 *
 * Everything is total: an unusable input yields `null` instead of throwing. `null` means "no
 * bucket" (opaque origin), never "some catch-all store".
 */
import type { NoteOrigin } from "../core/model";
import { currentOrigin, normaliseOrigin } from "../core/origin";

/** The pre-0.12 shared blob. Read-only for the extension path: it is never written (G5). */
export const LEGACY_STORAGE_KEY = "bluepencil:default:v1";

/** Prefix of a per-origin note blob; the canonical origin follows verbatim. */
export const NOTES_STORAGE_PREFIX = "bluepencil:v2:";

/** Prefix of the assign sidecar (note id → ISO timestamp); never reachable through the relay. */
export const ASSIGN_PROVENANCE_PREFIX = "bluepencil:assign:";

/**
 * The storage key for a canonical origin, or `null` when there is no bucket (AC-B01).
 *
 * Strict on purpose: a non-canonical string (`https://A.example`, `…:443`, trailing `/`) yields
 * `null` instead of a pseudo-origin bucket, so a key can never disagree with `parseNotesStorageKey`.
 */
export function chromeStorageKeyForOrigin(origin: NoteOrigin): string | null {
  if (typeof origin !== "string" || normaliseOrigin(origin) !== origin) {
    return null;
  }
  return `${NOTES_STORAGE_PREFIX}${origin}`;
}

/** What a `chrome.storage` key means: a per-origin note set, or the legacy shared blob. */
export type ParsedNotesKey = { kind: "origin"; origin: string } | { kind: "legacy" };

/**
 * Classify a storage key (AC-B28).
 *
 * The remainder after `bluepencil:v2:` must be **exactly** the canonical origin: `…v2:`,
 * `…v2:null`, `…v2:file:///x`, `…v2:https://A.example`, `…v2:https://a.example:443` and
 * `…v2:https://a.example/` all yield `null`. `bluepencil:default:v1` is the legacy blob;
 * everything else — settings, UI state, the assign sidecar — is not a note set and yields `null`.
 */
export function parseNotesStorageKey(key: string): ParsedNotesKey | null {
  if (key === LEGACY_STORAGE_KEY) {
    return { kind: "legacy" };
  }
  if (!key.startsWith(NOTES_STORAGE_PREFIX)) {
    return null;
  }
  const origin = key.slice(NOTES_STORAGE_PREFIX.length);
  // Canonical equality, not just parseability: `""` and `"null"` normalise to `null` and fail here.
  if (normaliseOrigin(origin) !== origin) {
    return null;
  }
  return { kind: "origin", origin };
}

/**
 * The one key derivation the relay may use: key from the location-like, nothing else (B.1).
 *
 * The isolated world's `window.location` is the only input, so a spoofed envelope field cannot
 * select a foreign key. An opaque origin (`"null"` on `file:`) has no bucket and yields `null`.
 */
export function storageKeyForLocation(
  location: { origin?: unknown } | null | undefined,
): string | null {
  return chromeStorageKeyForOrigin(currentOrigin(location));
}
