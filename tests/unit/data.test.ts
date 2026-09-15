/**
 * Unit tests for the headless data layer (FR-15.1/15.3): schema validation, canonical
 * serialisation, hashing, bundle I/O, inspection and migrations.
 */
import { describe, expect, it } from "vitest";
import {
  BUNDLE_KIND,
  BluepencilValidationError,
  SCHEMA_VERSION,
  createNote,
} from "../../src/core/model";
import type {
  Environment,
  Message,
  Note,
  NoteDraft,
  NoteIntent,
  NoteStatus,
  NoteType,
} from "../../src/core/model";
import {
  assertBundle,
  assertNote,
  bundleToJson,
  canonicalBundle,
  canonicalNote,
  createBundle,
  hashBundle,
  inspectBundle,
  migrateBundle,
  migrateNote,
  parseBundle,
  serializeCanonical,
  validateBundle,
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

function msg(id: string, ts: string, text?: string): Message {
  return { id, ts, author: "daniel", authorType: "human", kind: "note", text: text ?? `text of ${id}` };
}

interface NoteInput {
  id: string;
  route?: string;
  status?: NoteStatus;
  intent?: NoteIntent;
  type?: NoteType;
  body?: string;
  environment?: Environment;
  sessionRef?: string;
  messages?: Message[];
  now?: string;
}

function makeNote(input: NoteInput): Note {
  const draft: NoteDraft = {
    id: input.id,
    type: input.type ?? "text",
    body: input.body ?? `body of ${input.id}`,
    anchor: { hook: `hook-${input.id}`, ...(input.route !== undefined ? { route: input.route } : {}) },
    now: input.now ?? T,
    status: input.status,
    intent: input.intent,
    environment: input.environment,
    sessionRef: input.sessionRef,
    messages: input.messages,
  };
  return createNote(draft);
}

function without(source: object, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(source as Record<string, unknown>) };
  delete copy[key];
  return copy;
}

const BUNDLE_OPTIONS = {
  now: T,
  exportedBy: "daniel@dev",
  app: { name: "demo", buildRef: "abc1234" },
};

const validNote = makeNote({ id: "n-1", route: "/a" });

describe("validateNote", () => {
  it("accepts a note created by the model", () => {
    expect(validateNote(validNote)).toEqual([]);
    expect(validateNote(makeNote({ id: "n-design", type: "design" }))).toEqual([]);
  });

  it("rejects non-objects", () => {
    expect(validateNote(null)).toEqual(["note must be an object"]);
    expect(validateNote("note")).toEqual(["note must be an object"]);
    expect(validateNote([])).toEqual(["note must be an object"]);
  });

  it("rejects wrong enum values", () => {
    expect(validateNote({ ...validNote, type: "sketch" }).join("|")).toContain(
      "note.type must be one of text, design",
    );
    expect(validateNote({ ...validNote, intent: "maybe" }).join("|")).toContain("note.intent must be one of implement, feedback");
    expect(validateNote({ ...validNote, status: "review" }).join("|")).toContain(
      "note.status must be one of open, done, needs_decision",
    );
    expect(validateNote({ ...validNote, authorType: "robot" }).join("|")).toContain("note.authorType");
    expect(validateNote({ ...validNote, environment: "prod" }).join("|")).toContain(
      "note.environment must be one of dev, staging, live",
    );
  });

  it("rejects a missing or empty body", () => {
    expect(validateNote(without(validNote, "body")).join("|")).toContain("note.body must be a non-empty string");
    expect(validateNote({ ...validNote, body: "   " }).join("|")).toContain("note.body");
    expect(validateNote({ ...validNote, body: 42 }).join("|")).toContain("note.body");
  });

  it("rejects a missing anchor or an anchor without a target", () => {
    expect(validateNote(without(validNote, "anchor")).join("|")).toContain("note.anchor must be an object");
    expect(validateNote({ ...validNote, anchor: {} }).join("|")).toContain("needs at least one of hook, selector or quote");
    expect(validateNote({ ...validNote, anchor: { route: "/a" } }).join("|")).toContain("needs at least one of");
    expect(validateNote({ ...validNote, anchor: { hook: "h", orphaned: "yes" } }).join("|")).toContain(
      "note.anchor.orphaned must be a boolean",
    );
    expect(validateNote({ ...validNote, anchor: { quote: "text", selector: 7 } }).join("|")).toContain(
      "note.anchor.selector must be a string",
    );
  });

  it("rejects non-ISO timestamps", () => {
    expect(validateNote({ ...validNote, createdAt: "14.09.2026" }).join("|")).toContain(
      "note.createdAt must be an ISO 8601 timestamp",
    );
    expect(validateNote({ ...validNote, updatedAt: "2026-09-14" }).join("|")).toContain(
      "note.updatedAt must be an ISO 8601 timestamp",
    );
  });

  it("rejects a missing, invalid or future schemaVersion", () => {
    expect(validateNote(without(validNote, "schemaVersion")).join("|")).toContain(
      "note.schemaVersion must be a positive integer",
    );
    expect(validateNote({ ...validNote, schemaVersion: 0 }).join("|")).toContain("must be a positive integer");
    expect(validateNote({ ...validNote, schemaVersion: 1.5 }).join("|")).toContain("must be a positive integer");
    expect(validateNote({ ...validNote, schemaVersion: SCHEMA_VERSION + 1 }).join("|")).toContain(
      "newer than the supported schema version",
    );
  });

  it("rejects malformed threads", () => {
    expect(validateNote({ ...validNote, messages: [{ ...msg("m-1", T), kind: "comment" }] }).join("|")).toContain(
      "note.messages[0].kind must be one of",
    );
    expect(validateNote({ ...validNote, messages: [{ ...msg("m-1", T), ts: "yesterday" }] }).join("|")).toContain(
      "note.messages[0].ts must be an ISO 8601 timestamp",
    );
    expect(validateNote({ ...validNote, messages: [{ ...msg("m-1", T), text: "" }] }).join("|")).toContain(
      "note.messages[0].text must be a non-empty string",
    );
    expect(validateNote({ ...validNote, messages: "none" }).join("|")).toContain("note.messages must be an array");
  });

  it("accepts a captured context and rejects a malformed one", () => {
    const context = {
      tag: "div",
      classes: ["card"],
      styles: { color: "red" },
      box: { w: 10, h: 20, x: 0, y: 0 },
      scheme: "dark",
      viewport: { w: 1280, h: 800 },
    };
    expect(validateNote({ ...validNote, context })).toEqual([]);
    expect(validateNote({ ...validNote, context: "big" }).join("|")).toContain("note.context must be null or an object");
    expect(validateNote({ ...validNote, context: { ...context, scheme: "auto" } }).join("|")).toContain(
      "note.context.scheme must be one of light, dark",
    );
    expect(validateNote({ ...validNote, context: { ...context, styles: { color: 1 } } }).join("|")).toContain(
      "note.context.styles.color must be a string",
    );
    expect(validateNote({ ...validNote, context: { ...context, box: { w: 1 } } }).join("|")).toContain(
      "note.context.box.h must be a number",
    );
  });

  it("assertNote throws with every issue and returns valid notes unchanged", () => {
    const broken = { ...validNote, body: "", status: "review" };
    const issues = validateNote(broken);
    expect(issues).toHaveLength(2);

    let caught: unknown;
    try {
      assertNote(broken);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BluepencilValidationError);
    expect((caught as BluepencilValidationError).issues).toEqual(issues);
    expect(assertNote(validNote)).toBe(validNote);
  });
});

describe("validateBundle", () => {
  const notes = [
    makeNote({ id: "n-1", route: "/a" }),
    makeNote({ id: "n-2", route: "/b", status: "done", type: "design" }),
  ];
  const bundle = createBundle(notes, BUNDLE_OPTIONS);

  it("accepts a bundle created by createBundle", () => {
    expect(validateBundle(bundle)).toEqual([]);
  });

  it("rejects a wrong kind and a wrong export header", () => {
    expect(validateBundle({ ...bundle, kind: "bluepencil" }).join("|")).toContain(
      'bundle.kind must be "bluepencil.bundle"',
    );
    expect(validateBundle(without(bundle, "exportedAt")).join("|")).toContain("bundle.exportedAt must be an ISO 8601 timestamp");
    expect(validateBundle({ ...bundle, exportedBy: "" }).join("|")).toContain("bundle.exportedBy must be a non-empty string");
    expect(validateBundle({ ...bundle, environment: "prod" }).join("|")).toContain("bundle.environment must be one of");
    expect(validateBundle({ ...bundle, schemaVersion: SCHEMA_VERSION + 1 }).join("|")).toContain(
      "newer than the supported schema version",
    );
    expect(validateBundle(null)).toEqual(["bundle must be an object"]);
  });

  it("reports the path of a broken note", () => {
    const broken = { ...bundle, notes: [{ ...at(notes, 0), body: "" }] };
    expect(validateBundle(broken).join("|")).toContain("bundle.notes[0].body must be a non-empty string");
  });

  it("rejects duplicate ids, malformed sessions and a malformed app", () => {
    expect(validateBundle({ ...bundle, notes: [at(notes, 0), at(notes, 0)] }).join("|")).toContain(
      "bundle.notes[1].id \"n-1\" is not unique",
    );
    const session = { ref: "s-1", label: "one", createdAt: T };
    expect(validateBundle({ ...bundle, sessions: [session, session] }).join("|")).toContain(
      "bundle.sessions[1].ref \"s-1\" is not unique",
    );
    expect(validateBundle({ ...bundle, sessions: {} }).join("|")).toContain("bundle.sessions must be an array");
    expect(validateBundle({ ...bundle, sessions: [{ ref: "s", label: "l", createdAt: "nope" }] }).join("|")).toContain(
      "bundle.sessions[0].createdAt must be an ISO 8601 timestamp",
    );
    expect(validateBundle({ ...bundle, app: { name: "" } }).join("|")).toContain("bundle.app.name must be a non-empty string");
    expect(validateBundle({ ...bundle, app: null }).join("|")).toContain("bundle.app must be an object");
    expect(validateBundle({ ...bundle, notes: "none" }).join("|")).toContain("bundle.notes must be an array");
  });

  it("assertBundle throws with the issues", () => {
    let caught: unknown;
    try {
      assertBundle({ ...bundle, kind: "nope" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BluepencilValidationError);
    expect((caught as BluepencilValidationError).issues.join("|")).toContain("bundle.kind");
    expect(assertBundle(bundle)).toBe(bundle);
  });
});

describe("canonical form (NFR-17)", () => {
  it("is byte-identical for the same set whatever the input order", () => {
    const first = createBundle([makeNote({ id: "n-2", route: "/b" }), makeNote({ id: "n-1", route: "/a" })], BUNDLE_OPTIONS);
    const second = createBundle([makeNote({ id: "n-1", route: "/a" }), makeNote({ id: "n-2", route: "/b" })], BUNDLE_OPTIONS);
    expect(serializeCanonical(first)).toBe(serializeCanonical(second));
    expect(canonicalBundle(first)).toEqual(canonicalBundle(second));
  });

  it("sorts messages by ts then id and keeps optional keys out when empty", () => {
    const note = canonicalNote(
      makeNote({ id: "n-1", messages: [msg("m-b", LATER), msg("m-a", T), msg("m-c", T)] }),
    );
    expect(note.messages.map((message) => message.id)).toEqual(["m-a", "m-c", "m-b"]);
    expect(Object.keys(note)).not.toContain("sessionRef");
    expect(Object.keys(note)).not.toContain("ticketRef");
    expect(Object.keys(note)).not.toContain("debug");
    const withRef = canonicalNote(makeNote({ id: "n-2", sessionRef: "s-1" }));
    expect(Object.keys(withRef)).toContain("sessionRef");
  });

  it("orders notes by route, status priority, createdAt and id", () => {
    const bundle = createBundle(
      [
        makeNote({ id: "n-open", route: "/a", status: "open" }),
        makeNote({ id: "n-done", route: "/a", status: "done", now: LATER }),
        makeNote({ id: "n-decide", route: "/a", status: "needs_decision" }),
        makeNote({ id: "n-feedback", route: "/a", intent: "feedback" }),
        makeNote({ id: "n-b", route: "/b", status: "open" }),
      ],
      BUNDLE_OPTIONS,
    );
    expect(bundle.notes.map((note) => note.id)).toEqual([
      "n-decide",
      "n-feedback",
      "n-open",
      "n-done",
      "n-b",
    ]);
  });

  it("produces a one-hunk diff for a one-note change", () => {
    const before = createBundle(
      [makeNote({ id: "n-1", route: "/a", body: "alpha" }), makeNote({ id: "n-2", route: "/b" })],
      BUNDLE_OPTIONS,
    );
    const after = createBundle(
      [makeNote({ id: "n-1", route: "/a", body: "alpha!" }), makeNote({ id: "n-2", route: "/b" })],
      BUNDLE_OPTIONS,
    );
    const beforeLines = serializeCanonical(before).split("\n");
    const afterLines = serializeCanonical(after).split("\n");
    expect(afterLines).toHaveLength(beforeLines.length);
    const changed: number[] = [];
    beforeLines.forEach((line, index) => {
      if (line !== afterLines[index]) changed.push(index);
    });
    expect(changed).toHaveLength(1);
    expect(hashBundle(after)).not.toBe(hashBundle(before));
  });

  it("serialises with two-space indentation and a trailing newline", () => {
    const text = serializeCanonical(createBundle([makeNote({ id: "n-1" })], BUNDLE_OPTIONS));
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "kind": "bluepencil.bundle",');
    expect(text).toContain('\n      "id": "n-1",');
    expect(text).toContain('\n      "schemaVersion": 1,');
    expect(JSON.parse(text)).toMatchObject({ kind: BUNDLE_KIND, schemaVersion: SCHEMA_VERSION });
  });

  it("hashes deterministically with FNV-1a 64-bit", () => {
    const bundle = createBundle([makeNote({ id: "n-1", route: "/a" })], BUNDLE_OPTIONS);
    const hash = hashBundle(bundle);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    // Golden value: FNV-1a 64 over the canonical text, cross-checked against the published
    // test vectors ('' -> cbf29ce484222325, 'a' -> af63dc4c8601ec8c, 'foobar' -> 85944171f73967e8).
    expect(hash).toBe("db9656224d8679d9");
    expect(hashBundle(bundle)).toBe(hash);
    expect(hashBundle(canonicalBundle(bundle))).toBe(hash);
    expect(hashBundle(createBundle([makeNote({ id: "n-1", route: "/a", body: "changed" })], BUNDLE_OPTIONS))).not.toBe(hash);
  });
});

describe("bundle I/O (FR-14.2/14.5/14.9)", () => {
  const notes = [
    makeNote({ id: "n-1", route: "/a", sessionRef: "s-1", messages: [msg("m-1", T)] }),
    makeNote({ id: "n-2", route: "/a", status: "done" }),
    makeNote({ id: "n-3", route: "/b", type: "design", intent: "feedback" }),
  ];
  const bundle = createBundle(notes, BUNDLE_OPTIONS);

  it("fills kind, schema, header, environment, app and sessions", () => {
    expect(bundle.kind).toBe(BUNDLE_KIND);
    expect(bundle.schemaVersion).toBe(SCHEMA_VERSION);
    expect(bundle.exportedAt).toBe(T);
    expect(bundle.exportedBy).toBe("daniel@dev");
    expect(bundle.environment).toBe("dev");
    expect(bundle.app).toEqual({ name: "demo", buildRef: "abc1234" });
    expect(bundle.sessions).toEqual([{ ref: "s-1", label: "s-1", createdAt: T }]);
    expect(bundle.notes).toHaveLength(3);
  });

  it("uses the injected clock and refuses mixed environments", () => {
    expect(createBundle([], { now: LATER }).exportedAt).toBe(LATER);
    expect(() =>
      createBundle([makeNote({ id: "n-1", environment: "dev" }), makeNote({ id: "n-2", environment: "live" })]),
    ).toThrowError(/span multiple environments/);
    const promoted = createBundle([makeNote({ id: "n-1", environment: "dev" })], { environment: "live", app: { name: "demo" } });
    expect(promoted.environment).toBe("live");
    expect(at(promoted.notes, 0).environment).toBe("live");
  });

  it("round-trips a bundle through JSON without loss (FR-14.5)", () => {
    const text = bundleToJson(bundle);
    const parsed = parseBundle(text);
    expect(parsed).toEqual(bundle);
    expect(bundleToJson(parsed)).toBe(text);
    expect(hashBundle(parsed)).toBe(hashBundle(bundle));
    expect(validateBundle(parsed)).toEqual([]);
  });

  it("offers a compact form and rejects malformed input", () => {
    const compact = bundleToJson(bundle, { pretty: false });
    expect(compact.split("\n").filter((line) => line !== "")).toHaveLength(1);
    expect(parseBundle(compact)).toEqual(bundle);
    expect(() => parseBundle("")).toThrowError(/non-empty string/);
    expect(() => parseBundle("{oops")).toThrowError(/not valid JSON/);
    expect(() => parseBundle("[]")).toThrowError(/bundle must be an object/);
    expect(() => parseBundle(JSON.stringify({ ...bundle, environment: "prod" }))).toThrowError(/bundle.environment/);
  });

  it("summarises a bundle without writing anything (FR-14.9)", () => {
    const before = JSON.stringify(bundle);
    const summary = inspectBundle(bundle);
    expect(summary.notes).toBe(3);
    expect(summary.byStatus).toEqual({ open: 2, done: 1, needs_decision: 0 });
    expect(summary.byIntent).toEqual({ implement: 2, feedback: 1 });
    expect(summary.byType).toEqual({ text: 2, design: 1 });
    expect(summary.routes).toEqual(["/a", "/b"]);
    expect(summary.environments).toEqual(["dev"]);
    expect(summary.sessions).toEqual([{ ref: "s-1", label: "s-1", createdAt: T }]);
    expect(summary.app).toEqual({ name: "demo", buildRef: "abc1234" });
    expect(JSON.stringify(bundle)).toBe(before);
    expect(inspectBundle(createBundle([], { app: { name: "empty" } })).byStatus).toEqual({
      open: 0,
      done: 0,
      needs_decision: 0,
    });
  });
});

describe("migrations (FR-3.5)", () => {
  it("upgrades a v0-ish note document and fills missing fields", () => {
    const legacy = {
      id: "n-legacy",
      body: "old note",
      type: "text",
      anchor: { selector: "#legacy" },
      createdAt: "2026-09-14T18:20:00Z",
    };
    const snapshot = JSON.parse(JSON.stringify(legacy)) as unknown;
    const note = migrateNote(legacy);

    expect(note.id).toBe("n-legacy");
    expect(note.schemaVersion).toBe(SCHEMA_VERSION);
    expect(note.type).toBe("text");
    expect(note.intent).toBe("implement");
    expect(note.status).toBe("open");
    expect(note.author).toBe("anonymous");
    expect(note.authorType).toBe("human");
    expect(note.context).toBeNull();
    expect(note.messages).toEqual([]);
    expect(note.source).toBe("cli:import");
    expect(note.environment).toBe("dev");
    expect(note.updatedAt).toBe(note.createdAt);
    expect(validateNote(note)).toEqual([]);
    expect(legacy).toEqual(snapshot);
  });

  it("repairs legacy vocabulary and normalises timestamps", () => {
    const note = migrateNote({
      id: "n-2",
      body: "x",
      type: "typography",
      status: "review",
      intent: "comment",
      authorType: "ai",
      environment: "production",
      anchor: { hook: "h" },
      createdAt: "2026-09-14T18:20:00+02:00",
      updatedAt: 1757874000000,
      messages: [{ id: "m-1", ts: "2026-09-14 18:20", kind: "chat", authorType: "bot", text: "hello" }],
    });
    expect(note.type).toBe("text");
    expect(note.status).toBe("open");
    expect(note.intent).toBe("implement");
    expect(note.authorType).toBe("human");
    expect(note.environment).toBe("dev");
    expect(note.createdAt).toBe("2026-09-14T16:20:00.000Z");
    expect(at(note.messages, 0).kind).toBe("note");
    expect(at(note.messages, 0).authorType).toBe("human");
    expect(Number.isNaN(Date.parse(at(note.messages, 0).ts))).toBe(false);
    expect(validateNote(note)).toEqual([]);
  });

  it("reports what it cannot repair instead of guessing", () => {
    expect(() => migrateNote({ id: "n-3", body: "x" })).toThrowError(/anchor/);
    expect(() => migrateNote({ id: "n-3", body: "", anchor: { hook: "h" } })).toThrowError(/body/);
    expect(() => migrateNote("nope")).toThrowError(BluepencilValidationError);
  });

  it("refuses documents from a newer schema", () => {
    expect(() => migrateNote({ ...validNote, schemaVersion: SCHEMA_VERSION + 1 })).toThrowError(
      /newer than the supported schema version/,
    );
    expect(() => migrateBundle({ notes: [], schemaVersion: SCHEMA_VERSION + 1 })).toThrowError(
      /newer than the supported schema version/,
    );
    expect(() => migrateNote({ ...validNote, schemaVersion: 0 })).toThrowError(/positive integer/);
  });

  it("upgrades a legacy bundle and lets its notes inherit the environment", () => {
    const legacy = {
      environment: "live",
      notes: [
        {
          id: "n-1",
          body: "live note",
          type: "text",
          anchor: { hook: "h1" },
          sessionRef: "s-live",
          createdAt: "2026-09-14T18:20:00Z",
        },
      ],
      sessions: [{ ref: "s-live", label: "Live review" }],
    };
    const snapshot = JSON.parse(JSON.stringify(legacy)) as unknown;
    const bundle = migrateBundle(legacy);

    expect(bundle.kind).toBe(BUNDLE_KIND);
    expect(bundle.schemaVersion).toBe(SCHEMA_VERSION);
    expect(bundle.environment).toBe("live");
    expect(at(bundle.notes, 0).environment).toBe("live");
    expect(at(bundle.notes, 0).source).toBe("cli:import");
    expect(bundle.exportedBy).toBe("unknown");
    expect(bundle.app).toEqual({ name: "unknown" });
    expect(at(bundle.sessions, 0).ref).toBe("s-live");
    expect(at(bundle.sessions, 0).label).toBe("Live review");
    expect(Number.isNaN(Date.parse(at(bundle.sessions, 0).createdAt))).toBe(false);
    expect(validateBundle(bundle)).toEqual([]);
    expect(legacy).toEqual(snapshot);
  });

  it("accepts a bare note array and derives sessions", () => {
    const bundle = migrateBundle([
      { id: "n-1", body: "x", type: "text", anchor: { hook: "h" }, sessionRef: "s-1", createdAt: T },
    ]);
    expect(bundle.kind).toBe(BUNDLE_KIND);
    expect(bundle.notes.map((note) => note.id)).toEqual(["n-1"]);
    expect(bundle.sessions).toEqual([{ ref: "s-1", label: "s-1", createdAt: T }]);
    expect(validateBundle(bundle)).toEqual([]);
  });

  it("leaves a current bundle unchanged and is idempotent", () => {
    const bundle = createBundle([makeNote({ id: "n-1", route: "/a", sessionRef: "s-1" })], BUNDLE_OPTIONS);
    const once = migrateBundle(JSON.parse(JSON.stringify(bundle)) as unknown);
    expect(once).toEqual(bundle);
    expect(migrateBundle(once)).toEqual(bundle);
  });

  it("keeps parseBundle strict — migration stays an explicit step", () => {
    expect(() => parseBundle(JSON.stringify({ environment: "dev", notes: [] }))).toThrowError(/bundle.kind/);
    const migrated = migrateBundle(JSON.parse(JSON.stringify({ environment: "dev", notes: [] })) as unknown);
    expect(inspectBundle(migrated).notes).toBe(0);
  });
});
