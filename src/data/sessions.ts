/**
 * Session derivation — the one rule every surface shares (CQ-01, FR-15.3).
 *
 * A note may carry a `sessionRef`; the session header of a bundle lists each referenced ref
 * exactly once, labelled with the ref itself and dated with the *earliest* `createdAt` among
 * the notes that mention it. Bundle creation, schema migration and the CLI's bare `Note[]`
 * reader all need that header — they now share this implementation instead of keeping three
 * identical private copies, so a change to the rule cannot reach one reader and miss another.
 *
 * Dom-free and dependency-free like the rest of `src/data`.
 */
import type { Note, Session } from "../core/model";

/**
 * Sessions that are only referenced by notes, without a caller-supplied label. Empty and absent
 * refs are skipped; order is first appearance, which the canonical bundle form re-sorts.
 */
export function deriveSessions(notes: readonly Note[]): Session[] {
  const earliest = new Map<string, string>();
  for (const note of notes) {
    const ref = note.sessionRef;
    if (ref === undefined || ref === "") continue;
    const current = earliest.get(ref);
    if (current === undefined || note.createdAt < current) earliest.set(ref, note.createdAt);
  }
  return [...earliest.entries()].map(([ref, createdAt]) => ({ ref, label: ref, createdAt }));
}
