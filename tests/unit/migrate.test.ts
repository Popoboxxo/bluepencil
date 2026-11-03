/**
 * Migration surface of the single session rule (AC-H01, CQ-01).
 *
 * `migrate.ts` used to derive session headers from a private copy of the rule, so a legacy
 * `Note[]` migrated by the data layer could disagree with the same notes bundled by
 * `createBundle`. These cases pin the migration reader to the shared `src/data/sessions.ts`:
 * the explicit header still wins, the derived header is byte-identical to `deriveSessions()`,
 * and no private copy comes back.
 *
 * The wider migration contract (schema upgrades, idempotence, origin degradation) lives in
 * `tests/unit/data.test.ts`; this file only adds the AC-H01 observation for `migrate.ts`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createBundle } from "../../src/data/bundle";
import { migrateBundle } from "../../src/data/migrate";
import { deriveSessions } from "../../src/data/sessions";
import { createNote } from "../../src/core/model";
import type { Note } from "../../src/core/model";

const T = "2026-09-14T18:20:00.000Z";
const LATER = "2026-09-14T19:00:00.000Z";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A minimally valid legacy note document: no `schemaVersion`, no `origin`. */
function legacyNote(input: {
  id: string;
  sessionRef?: string;
  createdAt?: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    createdAt: input.createdAt ?? T,
    type: "text",
    body: `body of ${input.id}`,
    anchor: { hook: `hook-${input.id}` },
    ...(input.sessionRef !== undefined ? { sessionRef: input.sessionRef } : {}),
  };
}

function note(input: { id: string; sessionRef?: string; now?: string }): Note {
  return createNote({
    id: input.id,
    type: "text",
    body: `body of ${input.id}`,
    anchor: { hook: `hook-${input.id}` },
    now: input.now ?? T,
    sessionRef: input.sessionRef,
  });
}

describe("migration derives sessions through the one implementation (AC-H01)", () => {
  it("imports deriveSessions and keeps no private copy", () => {
    const source = readFileSync(join(ROOT, "src", "data", "migrate.ts"), "utf8");
    expect(source).toContain('import { deriveSessions } from "./sessions"');
    expect(source).not.toMatch(/function\s+deriveSessions\b/);
  });

  it("derives the header of a legacy bare Note[] exactly as the shared rule does", () => {
    const documents = [
      legacyNote({ id: "n-late", sessionRef: "s-1", createdAt: LATER }),
      legacyNote({ id: "n-early", sessionRef: "s-1", createdAt: T }),
      legacyNote({ id: "n-other", sessionRef: "s-2" }),
      legacyNote({ id: "n-noref" }),
    ];
    const migrated = migrateBundle(documents);
    const expected = deriveSessions(migrated.notes);

    expect(migrated.sessions).toEqual(expected);
    expect(migrated.sessions).toEqual([
      { ref: "s-1", label: "s-1", createdAt: T },
      { ref: "s-2", label: "s-2", createdAt: T },
    ]);
  });

  it("produces the same header as createBundle for the same note set", () => {
    const notes = [
      note({ id: "n-late", sessionRef: "s-1", now: LATER }),
      note({ id: "n-early", sessionRef: "s-1", now: T }),
      note({ id: "n-other", sessionRef: "s-2" }),
    ];
    const viaMigration = migrateBundle(JSON.parse(JSON.stringify(notes)) as unknown);
    const viaBundle = createBundle(notes, { now: T, exportedBy: "test", app: { name: "test" } });

    expect(viaMigration.sessions).toEqual(viaBundle.sessions);
    expect(viaMigration.sessions).toEqual(deriveSessions(notes));
  });

  it("keeps an explicit session header authoritative and only fills label/createdAt", () => {
    const migrated = migrateBundle({
      environment: "live",
      sessions: [{ ref: "s-1", label: "Live review" }],
      notes: [legacyNote({ id: "n-1", sessionRef: "s-1" })],
    });

    expect(migrated.sessions).toHaveLength(1);
    expect(migrated.sessions[0]).toMatchObject({ ref: "s-1", label: "Live review" });
    expect(Number.isNaN(Date.parse(migrated.sessions[0]?.createdAt ?? ""))).toBe(false);
  });
});
