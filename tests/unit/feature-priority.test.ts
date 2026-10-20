/**
 * Unit tests for the additive `feature` note type and its optional `priority` (FR-3.2/FR-3.7).
 *
 * Priority mirrors severity (FR-3.6): it is meaningful only for `type: "feature"`, stays
 * optional, carries no `schemaVersion` bump and degrades to "absent" when a document carries an
 * unknown value. Older readers drop the field instead of refusing the note.
 */
import { describe, expect, it } from "vitest";
import {
  NOTE_PRIORITIES,
  NOTE_TYPES,
  SCHEMA_VERSION,
  createNote,
  isNotePriority,
} from "../../src/core/model";
import type {
  Note,
  NotePriority,
  NoteSeverity,
  NoteType,
} from "../../src/core/model";
import { applyPatch, coerceNote, filterNotes, matchesFilter } from "../../src/core/adapter";
import { noteToMarkdown } from "../../src/core/export/markdown";
import {
  bundleToJson,
  canonicalNote,
  createBundle,
  hashBundle,
  inspectBundle,
  mergeNotes,
  migrateBundle,
  migrateNote,
  parseBundle,
  serializeCanonical,
  validateNote,
} from "../../src/data/index";

const T = "2026-09-14T18:20:00.000Z";
const LATER = "2026-09-14T19:00:00.000Z";

/** Fixture accessor that keeps `noUncheckedIndexedAccess` happy without casts. */
function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`fixture has no entry at ${index}`);
  return value;
}

interface NoteSpec {
  id: string;
  type?: NoteType;
  severity?: NoteSeverity;
  priority?: NotePriority;
  body?: string;
  route?: string;
  now?: string;
}

function makeNote(spec: NoteSpec): Note {
  return createNote({
    id: spec.id,
    type: spec.type ?? "text",
    severity: spec.severity,
    priority: spec.priority,
    body: spec.body ?? `body of ${spec.id}`,
    anchor: { hook: `hook-${spec.id}`, ...(spec.route !== undefined ? { route: spec.route } : {}) },
    now: spec.now ?? T,
  });
}

const BUNDLE_OPTIONS = { now: T, exportedBy: "daniel@dev", app: { name: "demo" } };

const feature = makeNote({ id: "n-feature", type: "feature", priority: "high" });
const plainText = makeNote({ id: "n-text" });

describe("feature vocabulary (FR-3.2)", () => {
  it("adds `feature` to the note types and exposes the priority vocabulary", () => {
    expect(NOTE_TYPES).toEqual(["text", "design", "bug", "feature"]);
    expect(NOTE_PRIORITIES).toEqual(["high", "medium", "low"]);
    expect(isNotePriority("high")).toBe(true);
    expect(isNotePriority("medium")).toBe(true);
    expect(isNotePriority("low")).toBe(true);
    expect(isNotePriority("urgent")).toBe(false);
    expect(isNotePriority(7)).toBe(false);
  });

  it("createNote keeps a priority on a feature and silently omits it on every other type", () => {
    expect(feature.type).toBe("feature");
    expect(feature.priority).toBe("high");

    for (const type of ["text", "design", "bug"] as const) {
      const note = makeNote({ id: `n-${type}`, type, priority: "medium" });
      expect(note.priority).toBeUndefined();
      expect(Object.keys(note)).not.toContain("priority");
    }
  });

  it("createNote rejects an unknown priority and accepts an absent one", () => {
    expect(() =>
      createNote({
        id: "n-bad",
        type: "feature",
        priority: "urgent" as NotePriority,
        body: "x",
        anchor: { hook: "h" },
        now: T,
      }),
    ).toThrowError(/priority must be one of high, medium, low/);

    const ungraded = makeNote({ id: "n-unfeature", type: "feature" });
    expect(ungraded.priority).toBeUndefined();
    expect(validateNote(ungraded)).toEqual([]);
  });

  it("createNote does not copy a severity onto a feature note", () => {
    const note = makeNote({ id: "n-feature-bug", type: "feature", severity: "blocker" });
    expect(note.severity).toBeUndefined();
  });
});

describe("priority validation (FR-3.7)", () => {
  it("accepts a feature with a known priority or without one", () => {
    expect(validateNote(feature)).toEqual([]);
    expect(validateNote(makeNote({ id: "n-feature-plain", type: "feature" }))).toEqual([]);
  });

  it("rejects a priority on a non-feature note", () => {
    expect(validateNote({ ...plainText, priority: "high" }).join("|")).toContain(
      'note.priority is only allowed when type is "feature" (got type "text")',
    );
  });

  it("rejects an unknown priority value", () => {
    expect(validateNote({ ...feature, priority: "urgent" }).join("|")).toContain(
      "note.priority must be one of high, medium, low",
    );
  });

  it("keeps rejecting a severity on a feature note", () => {
    expect(validateNote({ ...feature, severity: "major" }).join("|")).toContain(
      'note.severity is only allowed when type is "bug"',
    );
  });
});

describe("priority in the shared note rules (FR-3.7)", () => {
  it("coerceNote keeps a known priority on a feature and drops unknown or foreign values", () => {
    expect(coerceNote({ ...feature, priority: "low" })?.priority).toBe("low");
    expect(coerceNote({ ...feature, priority: "urgent" })?.priority).toBeUndefined();
    expect(coerceNote({ ...plainText, priority: "high" })?.priority).toBeUndefined();
    // an unknown type degrades to `text`, which also drops the (now foreign) priority
    expect(coerceNote({ ...feature, type: "sketch" })?.priority).toBeUndefined();
  });

  it("coerceNote drops a severity that comes with a feature note", () => {
    const coerced = coerceNote({ ...feature, severity: "blocker" });
    expect(coerced?.severity).toBeUndefined();
    expect(coerced?.priority).toBe("high");
  });

  it("applyPatch sets and clears a feature priority and drops it on a non-feature", () => {
    expect(applyPatch(feature, { priority: "low" }).priority).toBe("low");

    const cleared = applyPatch(feature, { priority: null });
    expect(cleared.priority).toBeUndefined();
    expect("priority" in cleared).toBe(false);

    const foreign = applyPatch(plainText, { priority: "high" });
    expect(foreign.priority).toBeUndefined();
    expect("priority" in foreign).toBe(false);

    expect(() =>
      applyPatch(feature, { priority: "urgent" as NotePriority }),
    ).toThrowError(/priority must be high, medium or low/);
  });

  it("applyPatch supports clearing severity with null (FR-3.6)", () => {
    const bug = makeNote({ id: "n-bug", type: "bug", severity: "blocker" });
    expect(applyPatch(bug, { severity: "major" }).severity).toBe("major");

    const cleared = applyPatch(bug, { severity: null });
    expect(cleared.severity).toBeUndefined();
    expect("severity" in cleared).toBe(false);

    // null on a non-bug also leaves the key off the object
    const foreign = applyPatch(plainText, { severity: null });
    expect("severity" in foreign).toBe(false);
  });

  it("matchesFilter and filterNotes honour an exact priority", () => {
    const low = makeNote({ id: "n-low", type: "feature", priority: "low" });
    const notes = [feature, low, plainText];

    expect(matchesFilter(feature, { priority: "high" })).toBe(true);
    expect(matchesFilter(feature, { priority: "low" })).toBe(false);
    expect(matchesFilter(plainText, { priority: "high" })).toBe(false);
    expect(matchesFilter(feature, {})).toBe(true);

    expect(filterNotes(notes, { priority: "low" }).map((note) => note.id)).toEqual(["n-low"]);
    expect(filterNotes(notes, { type: "feature" }).map((note) => note.id)).toEqual([
      "n-feature",
      "n-low",
    ]);
  });
});

describe("priority migration (FR-3.7)", () => {
  const legacy = { id: "n-1", body: "x", anchor: { hook: "h" }, createdAt: T };

  it("migrateNote keeps a feature and its priority without a schema bump", () => {
    const migrated = migrateNote({ ...legacy, type: "feature", priority: "high" });
    expect(migrated.type).toBe("feature");
    expect(migrated.priority).toBe("high");
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    expect(migrated.schemaVersion).toBe(1);
    expect(validateNote(migrated)).toEqual([]);
  });

  it("migrateNote drops an unknown priority and any priority on a non-feature", () => {
    expect(migrateNote({ ...legacy, type: "feature", priority: "urgent" }).priority).toBeUndefined();
    expect(migrateNote({ ...legacy, type: "text", priority: "high" }).priority).toBeUndefined();
    expect(migrateNote({ ...legacy, type: "bug", priority: "high" }).priority).toBeUndefined();
  });

  it("migrateBundle applies the same degrade rule and keeps the version at 1", () => {
    const migrated = migrateBundle([
      { ...legacy, type: "feature", priority: "high" },
      { id: "n-2", body: "y", type: "feature", priority: "urgent", anchor: { hook: "h" }, createdAt: T },
      { id: "n-3", body: "z", type: "text", priority: "low", anchor: { hook: "h" }, createdAt: T },
    ]);
    expect(at(migrated.notes, 0).priority).toBe("high");
    expect(at(migrated.notes, 1).priority).toBeUndefined();
    expect(at(migrated.notes, 2).priority).toBeUndefined();
    expect(migrated.schemaVersion).toBe(1);
  });
});

describe("priority in canonical form and bundles (NFR-17)", () => {
  it("places priority directly after severity, which follows type", () => {
    // Canonicalisation is a pure shape function: it also orders a hand-built note that carries
    // both optional fields (the schema would reject that combination, see validation above).
    const both = { ...makeNote({ id: "n-bug", type: "bug", severity: "major" }), priority: "high" } as Note;
    const keys = Object.keys(canonicalNote(both));
    expect(keys.indexOf("severity")).toBe(keys.indexOf("type") + 1);
    expect(keys.indexOf("priority")).toBe(keys.indexOf("severity") + 1);

    const featureKeys = Object.keys(canonicalNote(feature));
    expect(featureKeys.indexOf("priority")).toBe(featureKeys.indexOf("type") + 1);
  });

  it("omits priority entirely when unset", () => {
    const note = makeNote({ id: "n-feature-plain", type: "feature" });
    expect(Object.keys(canonicalNote(note))).not.toContain("priority");
    expect(serializeCanonical(note)).not.toContain("priority");
  });

  it("serialises deterministically and hashes two equal notes identically", () => {
    const first = makeNote({ id: "n-same", type: "feature", priority: "medium", route: "/a" });
    const second = makeNote({ id: "n-same", type: "feature", priority: "medium", route: "/a" });

    expect(serializeCanonical(first)).toBe(serializeCanonical(second));
    expect(hashBundle(createBundle([first], BUNDLE_OPTIONS))).toBe(
      hashBundle(createBundle([second], BUNDLE_OPTIONS)),
    );

    // A different priority is a different payload, so the hash changes.
    const upgraded = makeNote({ id: "n-same", type: "feature", priority: "high", route: "/a" });
    expect(hashBundle(createBundle([upgraded], BUNDLE_OPTIONS))).not.toBe(
      hashBundle(createBundle([first], BUNDLE_OPTIONS)),
    );
  });

  it("reports feature notes in the bundle summary", () => {
    const bundle = createBundle([feature, plainText], BUNDLE_OPTIONS);
    const summary = inspectBundle(bundle);
    expect(summary.byType).toEqual({ text: 1, design: 0, bug: 0, feature: 1 });
  });

  it("round-trips a feature and its priority through the bundle JSON", () => {
    const bundle = createBundle([feature], BUNDLE_OPTIONS);
    const parsed = parseBundle(bundleToJson(bundle));

    expect(at(parsed.notes, 0).type).toBe("feature");
    expect(at(parsed.notes, 0).priority).toBe("high");
    expect(parsed).toEqual(bundle);
    expect(hashBundle(parsed)).toBe(hashBundle(bundle));
  });
});

describe("priority in merge (FR-14.3)", () => {
  it("lets an incoming priority win like severity and drops it when the incoming note has none", () => {
    const existing = makeNote({ id: "n-feature", type: "feature", priority: "low" });

    const raised = makeNote({ id: "n-feature", type: "feature", priority: "high", body: "raised" });
    const merged = mergeNotes([existing], [raised], {
      mode: "upsert",
      onConflict: "keep-incoming",
    });
    expect(at(merged.notes, 0).priority).toBe("high");

    const ungraded = makeNote({ id: "n-feature", type: "feature", body: "ungraded" });
    const dropped = mergeNotes([existing], [ungraded], {
      mode: "upsert",
      onConflict: "keep-incoming",
    });
    expect(at(dropped.notes, 0).priority).toBeUndefined();
    expect("priority" in at(dropped.notes, 0)).toBe(false);
  });

  it("names priority in the conflict reason", () => {
    const existing = makeNote({ id: "n-feature", type: "feature", priority: "low" });
    const incoming = makeNote({
      id: "n-feature",
      type: "feature",
      priority: "high",
      now: LATER,
    });
    const result = mergeNotes([existing], [incoming], { dryRun: true });
    expect(at(result.conflicts, 0).reason).toContain("priority");
  });
});

describe("priority in the Markdown export (FR-3.7)", () => {
  it("prints a localized priority bullet and keeps the raw value", () => {
    expect(noteToMarkdown(feature)).toContain("- Priority: high");
    expect(noteToMarkdown(feature, { language: "de" })).toContain("- Priorität: high");
  });

  it("prints no priority bullet for a note without one", () => {
    expect(noteToMarkdown(plainText)).not.toContain("- Priority:");
    expect(noteToMarkdown(plainText, { language: "de" })).not.toContain("- Priorität:");
  });
});
