/**
 * Session derivation — the one rule every surface shares (CQ-01, FR-15.3, issue #135).
 *
 * `deriveSessions` keeps the original three-field shape for compatibility (bundles written before
 * #135 stay byte-identical). `summariseSessions` adds the *derived* overview the hub's
 * `GET /sessions` and the admin view need: every value comes from notes already in the store, so
 * there is no second store and no write path.
 */

import type { Note, Session } from "../core/model";
import { placeOriginOf } from "../core/origin";

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

interface Summary {
  firstSeen: string;
  lastSeen: string;
  origins: Set<string>;
  total: number;
  open: number;
  done: number;
}

/**
 * Enriched session overview, derived from the notes only (issue #135, UC-5).
 *
 * `firstSeen` is the earliest `createdAt`, `lastSeen` the latest `updatedAt` (the answer to "what
 * is running right now?"), `origins` the sorted canonical origins of all notes in the session —
 * an absent origin is *not* reported as an empty string — and counts by status. A note in
 * `needs_decision` is still open; only `done` closes it.
 */
export function summariseSessions(notes: readonly Note[]): Session[] {
  const byRef = new Map<string, Summary>();
  for (const note of notes) {
    const ref = note.sessionRef;
    if (ref === undefined || ref === "") continue;
    let summary = byRef.get(ref);
    if (summary === undefined) {
      summary = {
        firstSeen: note.createdAt,
        lastSeen: note.updatedAt,
        origins: new Set<string>(),
        total: 0,
        open: 0,
        done: 0,
      };
      byRef.set(ref, summary);
    }
    if (note.createdAt < summary.firstSeen) summary.firstSeen = note.createdAt;
    if (note.updatedAt > summary.lastSeen) summary.lastSeen = note.updatedAt;
    const origin = placeOriginOf(note);
    if (origin !== null) summary.origins.add(origin);
    summary.total += 1;
    if (note.status === "done") summary.done += 1;
    else summary.open += 1;
  }
  return [...byRef.entries()].map(([ref, summary]) => ({
    ref,
    label: ref,
    createdAt: summary.firstSeen,
    origins: [...summary.origins].sort(),
    firstSeen: summary.firstSeen,
    lastSeen: summary.lastSeen,
    notes: { total: summary.total, open: summary.open, done: summary.done },
  }));
}
