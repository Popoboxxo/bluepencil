/**
 * JSON export and import (FR-7.2, FR-14.2, NFR-17).
 *
 * The export is a bundle document built and serialised by `src/data/bundle.ts` — this module
 * only wires the options through and provides the matching reader; it never re-implements the
 * format. The import accepts a bundle document or a bare `Note[]` and validates everything
 * through `src/data/schema.ts`, so an invalid payload is refused with a
 * `BluepencilValidationError` instead of entering the store.
 */

import type { Bundle, Note } from "../model";
import { BluepencilValidationError } from "../model";
import type { BundleOptions } from "../../data/bundle";
import { bundleToJson, createBundle } from "../../data/bundle";
import { assertBundle, assertNote } from "../../data/schema";

/**
 * Serialize notes as a canonical bundle document (FR-7.2, NFR-17). Bundle metadata
 * (`exportedAt`, `exportedBy`, environment, sessions, …) comes from `options`; pass `now` for
 * a file that can be compared byte for byte.
 *
 * `pretty` defaults to `true` — the canonical, diffable form, matching `bundleToJson` in the
 * data library. Pass `pretty: false` for a single-line document (transport payloads).
 */
export function toJson(notes: Note[], options: BundleOptions & { pretty?: boolean } = {}): string {
  const { pretty, ...bundleOptions } = options;
  const bundle: Bundle = createBundle(notes, bundleOptions);
  return bundleToJson(bundle, { pretty: pretty !== false });
}

/**
 * Read a bundle document or a bare `Note[]` back into validated notes. Throws
 * `BluepencilValidationError` for unparseable text and for anything the schema rejects.
 */
export function fromJson(text: string): Note[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new BluepencilValidationError([`invalid JSON: ${reason}`]);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => assertNote(entry));
  }
  if (value !== null && typeof value === "object") {
    return assertBundle(value).notes;
  }
  throw new BluepencilValidationError(["expected a bundle document or an array of notes"]);
}
