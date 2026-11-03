/**
 * Review order (FR-4.6) — the single implementation every surface shares.
 *
 * The order is total and host-independent: a pending decision first, then a note that only asks
 * for an assessment (`intent: "feedback"`), then an open work item, then everything else (done);
 * `createdAt` and finally `id` break ties. Strings are compared with plain code-unit `<`/`>`
 * rather than `localeCompare`, so two machines and two runs always agree.
 *
 * This is deliberately NOT the canonical bundle order. `data/canonical.ts` sorts origin-first,
 * then route-first, before it applies the same priority, because a canonical export is grouped
 * by page for a readable diff (NFR-17). That is a different, equally deliberate order — do not
 * merge the two. The comparator (`compareCodeUnits`) and the priority class (`reviewPriority`)
 * are shared, so the two orders can never disagree about what "smaller" means (BP-07).
 * Review reads (protocol, CLI, MCP, federation) use this module.
 */

import type { Note } from "../core/model";

/**
 * FR-4.6 priority class: `0` needs_decision, `1` feedback, `2` open, `3` everything else.
 * Lower sorts first.
 */
export function reviewPriority(note: Note): number {
  if (note.status === "needs_decision") {
    return 0;
  }
  if (note.intent === "feedback") {
    return 1;
  }
  return note.status === "open" ? 2 : 3;
}

/**
 * Code-unit string comparison: deterministic everywhere, unlike `localeCompare`.
 *
 * This is the one comparator the data layer shares (BP-07): `canonical.ts` imports it for the
 * canonical bundle order, and `bundle.ts`, `markdown.ts` and `aggregate.ts` import it from here
 * too — none of them keeps a local copy. A reviewer and an agent therefore never disagree about
 * which note comes first.
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/**
 * The FR-4.6 review order: priority class, then `createdAt`, then `id`. Negative when `a` sorts
 * before `b`, positive when it sorts after, `0` only for the same note identity.
 */
export function compareForReview(a: Note, b: Note): number {
  const byPriority = reviewPriority(a) - reviewPriority(b);
  if (byPriority !== 0) {
    return byPriority;
  }
  const byCreated = compareCodeUnits(a.createdAt, b.createdAt);
  if (byCreated !== 0) {
    return byCreated;
  }
  return compareCodeUnits(a.id, b.id);
}
