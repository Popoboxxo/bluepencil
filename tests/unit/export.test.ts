/**
 * Unit tests for the Markdown and JSON exports (FR-5.6, FR-7.1/7.2/7.3, NFR-10).
 *
 * The JSON half is an integration test against `src/data/bundle.ts` and `src/data/schema.ts`,
 * which own the bundle format and its validation.
 */

import { describe, expect, it } from "vitest";

import type {
  CapturedContext,
  DebugContext,
  Message,
  Note,
  NoteDraft,
  NoteIntent,
  NoteStatus,
} from "../../src/core/model";
import { BluepencilValidationError, createNote } from "../../src/core/model";
import { excludeDone, filterNotes } from "../../src/core/adapter";
import { noteToMarkdown, toMarkdown } from "../../src/core/export/markdown";
import { fromJson, toJson } from "../../src/core/export/json";
import { parseBundle } from "../../src/data/bundle";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:10:00.000Z";
const T2 = "2026-01-01T00:20:00.000Z";

interface NoteSpec {
  id: string;
  now?: string;
  body?: string;
  status?: NoteStatus;
  intent?: NoteIntent;
  route?: string | null;
  hook?: string | null;
  selector?: string | null;
  quote?: string | null;
  author?: string;
  context?: CapturedContext | null;
  debug?: DebugContext;
  messages?: Message[];
  source?: NoteDraft["source"];
}

function makeNote(spec: NoteSpec): Note {
  const anchor: NoteDraft["anchor"] = {};
  if (spec.hook !== null) {
    anchor.hook = spec.hook ?? `#${spec.id}`;
  }
  if (spec.selector !== null && spec.selector !== undefined) {
    anchor.selector = spec.selector;
  }
  if (spec.quote !== null && spec.quote !== undefined) {
    anchor.quote = spec.quote;
  }
  if (spec.route !== null) {
    anchor.route = spec.route ?? "/checkout";
  }
  if (anchor.hook === undefined && anchor.selector === undefined && anchor.quote === undefined) {
    anchor.quote = spec.id;
  }
  return createNote({
    id: spec.id,
    now: spec.now ?? T0,
    type: "text",
    body: spec.body ?? `body of ${spec.id}`,
    status: spec.status,
    intent: spec.intent,
    author: spec.author ?? "Ada",
    source: spec.source,
    anchor,
    context: spec.context ?? null,
    debug: spec.debug,
    messages: spec.messages,
  });
}

/** No-op canonicalisation: re-read the note from its serialised form, styles keys reversed. */
function recanonicalise(note: Note): Note {
  const clone = JSON.parse(JSON.stringify(note)) as Note;
  if (clone.context !== null) {
    const styles = clone.context.styles;
    const reversed: Record<string, string> = {};
    for (const key of Object.keys(styles).reverse()) {
      reversed[key] = styles[key] as string;
    }
    clone.context.styles = reversed;
  }
  return clone;
}

const captured: CapturedContext = {
  tag: "button",
  classes: ["bp-btn", "primary"],
  styles: { color: "rgb(0, 0, 0)", "font-size": "14px", display: "inline-flex" },
  box: { w: 120, h: 32, x: 10, y: 20 },
  scheme: "dark",
  viewport: { w: 1280, h: 720 },
  buildRef: "build-7",
};

const debug: DebugContext = {
  test: "checkout.spec.ts > save button",
  commit: "abc1234",
  file: "src/pages/Checkout.tsx:88",
  stack: "at renderBundle (src/app.ts:12:5)\nat mount (src/main.ts:3:1)",
};

const thread: Message[] = [
  { id: "m-1", ts: T0, author: "Ada", authorType: "human", kind: "note", text: "the save button sits too low" },
  { id: "m-2", ts: T1, author: "agent", authorType: "agent", kind: "reply", text: "raised it by 8px" },
];

describe("toMarkdown structure", () => {
  const decision = makeNote({ id: "n-decision", status: "needs_decision", now: T1, route: "/a" });
  const feedback = makeNote({ id: "n-feedback", intent: "feedback", now: T2, route: "/b" });
  const open = makeNote({ id: "n-open", now: T0, route: "/c" });

  it("opens with the two exception sections and only then groups by route", () => {
    const md = toMarkdown([open, decision, feedback]);
    const decisionIndex = md.indexOf("## ⚠ open decisions");
    const feedbackIndex = md.indexOf("## 💬 feedback only");
    const routeIndex = md.indexOf("## Notes by route");

    expect(decisionIndex).toBeGreaterThanOrEqual(0);
    expect(feedbackIndex).toBeGreaterThan(decisionIndex);
    expect(routeIndex).toBeGreaterThan(feedbackIndex);

    const sectionHeadings = md.split("\n").filter((line) => line.startsWith("## "));
    expect(sectionHeadings[0]).toBe("## ⚠ open decisions");
    expect(sectionHeadings[1]).toBe("## 💬 feedback only");
    expect(sectionHeadings[2]).toBe("## Notes by route");

    // the exception notes are rendered inside their sections, not in the route groups
    expect(md.indexOf("n-decision")).toBeGreaterThan(decisionIndex);
    expect(md.indexOf("n-decision")).toBeLessThan(routeIndex);
    expect(md.indexOf("n-feedback")).toBeGreaterThan(feedbackIndex);
    expect(md.indexOf("n-feedback")).toBeLessThan(routeIndex);
    expect(md.indexOf("n-open")).toBeGreaterThan(routeIndex);
  });

  it("omits an empty exception section and keeps the route section", () => {
    const md = toMarkdown([open]);
    expect(md).not.toContain("⚠ open decisions");
    expect(md).not.toContain("💬 feedback only");
    expect(md).toContain("## Notes by route");
  });

  it("omits the route section when nothing is left over", () => {
    const md = toMarkdown([decision]);
    expect(md).toContain("## ⚠ open decisions");
    expect(md).not.toContain("## Notes by route");
  });

  it("starts with a level-1 heading, the title option and the deterministic summary", () => {
    const md = toMarkdown([open, decision, feedback], { title: "Round 1", generatedAt: T0 });
    expect(md.startsWith("# Round 1\n")).toBe(true);
    expect(md).toContain("_Exported: 2026-01-01T00:00:00.000Z_");
    expect(md).toContain("_Notes: 3 · open decisions: 1 · feedback only: 1 · done: 0_");
    expect(md.endsWith("\n")).toBe(true);
  });

  it("does not print a timestamp unless generatedAt is passed", () => {
    const md = toMarkdown([open]);
    expect(md).not.toContain("Exported");
    expect(md).toContain("_Notes: 1 · open decisions: 0 · feedback only: 0 · done: 0_");
  });
});

describe("toMarkdown route grouping", () => {
  const alpha = makeNote({ id: "n-alpha", route: "/alpha", now: T0 });
  const beta = makeNote({ id: "n-beta", route: "/beta", now: T1 });
  const noRoute = makeNote({ id: "n-none", route: null, now: T2 });

  it("groups remaining notes by route, sorts routes and puts the no-route group last", () => {
    const md = toMarkdown([beta, noRoute, alpha]);
    const alphaHeading = md.indexOf("### Route: `/alpha`");
    const betaHeading = md.indexOf("### Route: `/beta`");
    const noneHeading = md.indexOf("### (no route)");

    expect(alphaHeading).toBeGreaterThanOrEqual(0);
    expect(betaHeading).toBeGreaterThan(alphaHeading);
    expect(noneHeading).toBeGreaterThan(betaHeading);
    expect(md.indexOf("n-alpha")).toBeGreaterThan(alphaHeading);
    expect(md.indexOf("n-alpha")).toBeLessThan(betaHeading);
    expect(md.indexOf("n-beta")).toBeGreaterThan(betaHeading);
    expect(md.indexOf("n-beta")).toBeLessThan(noneHeading);
    expect(md.indexOf("n-none")).toBeGreaterThan(noneHeading);
  });

  it("orders notes inside a route by FR-4.6 priority then creation time", () => {
    const sameRoute: Note[] = [
      makeNote({ id: "n-done", route: "/alpha", status: "done", now: T0 }),
      makeNote({ id: "n-late-open", route: "/alpha", now: T2 }),
      makeNote({ id: "n-feedback", route: "/alpha", intent: "feedback", now: T0 }),
      makeNote({ id: "n-early-open", route: "/alpha", now: T1 }),
    ];
    const md = toMarkdown(sameRoute);
    const order = ["n-feedback", "n-early-open", "n-late-open", "n-done"].map((id) => md.indexOf(id));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("toMarkdown note rendering", () => {
  const full = makeNote({
    id: "n-full",
    now: T0,
    body: "the save button is too low",
    route: "/checkout",
    hook: "#save",
    selector: "body > div > button",
    quote: "the save button is wrong",
    author: "Ada",
    context: captured,
    debug,
    messages: thread,
    source: "ui:human",
  });

  it("prints type, intent, status, source and author", () => {
    const md = toMarkdown([full]);
    expect(md).toContain("- Type: text");
    expect(md).toContain("- Intent: implement");
    expect(md).toContain("- Status: open");
    expect(md).toContain("- Source: `ui:human`");
    expect(md).toContain("- Author: Ada (human)");
    expect(md).toContain(`- Created: ${T0}`);
    expect(md).toContain(`- Updated: ${T0}`);
    expect(md).toContain("- Environment: dev");
  });

  it("prints the quote, the anchor parts and the body literally", () => {
    const md = toMarkdown([full]);
    expect(md).toContain("- Quote: `the save button is wrong`");
    expect(md).toContain("- Anchor: hook `#save` · selector `body > div > button` · route `/checkout`");
    expect(md).toContain("  ```\n  the save button is too low\n  ```");
  });

  it("prints the captured state as a compact key: value list without HTML", () => {
    const md = toMarkdown([full]);
    expect(md).toContain("- Captured state:");
    expect(md).toContain("  - tag: `button`");
    expect(md).toContain("  - classes: `bp-btn primary`");
    expect(md).toContain("  - scheme: dark");
    expect(md).toContain("  - viewport: 1280×720");
    expect(md).toContain("  - box: 120×32 at 10,20");
    expect(md).toContain("  - build: `build-7`");
    expect(md).toContain("  - style.color: rgb(0, 0, 0)");
    expect(md).toContain("  - style.display: inline-flex");
    expect(md).toContain("  - style.font-size: 14px");
    expect(md).not.toMatch(/<[a-z]+[^>]*>/i);
  });

  it("prints debug info when present and nothing when it is absent", () => {
    const md = toMarkdown([full]);
    expect(md).toContain("- Debug:");
    expect(md).toContain("  - test: `checkout.spec.ts > save button`");
    expect(md).toContain("  - commit: `abc1234`");
    expect(md).toContain("  - file: `src/pages/Checkout.tsx:88`");
    expect(md).toContain("  - stack:");
    expect(md).toContain("    ```\n    at renderBundle (src/app.ts:12:5)");

    const plain = toMarkdown([makeNote({ id: "n-plain" })]);
    expect(plain).not.toContain("- Debug:");
    expect(plain).not.toContain("- Captured state:");
  });

  it("prints the full thread as an ordered list with author, author type, kind and timestamp", () => {
    const md = toMarkdown([full]);
    expect(md).toContain("- Thread:");
    expect(md).toContain(`  1. Ada (human) · note · ${T0}`);
    expect(md).toContain(`  2. agent (agent) · reply · ${T1}`);
    const threadStart = md.indexOf("- Thread:");
    expect(md.indexOf("the save button sits too low", threadStart)).toBeGreaterThan(threadStart);
    expect(md.indexOf("raised it by 8px", threadStart)).toBeGreaterThan(threadStart);
  });

  it("says so when there is no thread", () => {
    const md = toMarkdown([makeNote({ id: "n-silent" })]);
    expect(md).toContain("- Thread:\n  - none");
  });
});

describe("toMarkdown safety and language", () => {
  it("escapes HTML in the inline fields, so a note id/author/style value cannot inject markup", () => {
    // FR-9.3 requires user text to be rendered as text, never as HTML. The *body* was always
    // safe (grown fence), but note id, author and captured style values are emitted inline —
    // `#### n-<script>alert('id')</script>` produced six live <script> elements in a real
    // Markdown render (measured with mistune).
    const evil = makeNote({
      id: "n-<script>alert('id')</script>",
      author: "**bold** <img src=x onerror=alert('a')>",
      context: {
        ...captured,
        styles: { color: "</script><script>alert('style')</script>" },
      },
    });
    const md = toMarkdown([evil]);

    expect(md).toContain("#### n-&lt;script&gt;alert('id')&lt;/script&gt;");
    expect(md).toContain("- Author: \\**bold\\** &lt;img src=x onerror=alert('a')&gt; (human)");
    expect(md).toContain("  - style.color: &lt;/script&gt;&lt;script&gt;");
    // Every field that is NOT a fenced code block must be free of raw angle brackets. The two
    // places raw text survives on purpose are the fenced body (a code block renders as text) and
    // the code spans (`#n-<script>…` — a code span is escaped by the renderer), both asserted below.
    const outsideBlocks = md.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
    expect(outsideBlocks).not.toContain("<script");
    expect(outsideBlocks).not.toContain("<img");
    // The fenced body still carries the raw text — that is the point of a code block.
    expect(md).toContain("body of n-<script>alert('id')</script>");
  });

  it("keeps user text literal and cannot be closed by backticks or break tables with pipes", () => {
    const tricky = makeNote({
      id: "n-tricky",
      body: "Use `code` | table | <script>alert(1)</script>",
      quote: "a ` b | c",
      selector: "div|p",
      context: { ...captured, styles: { color: "red|blue", display: "block" } },
    });
    const md = toMarkdown([tricky]);

    // fenced body: the single backtick run cannot end the three backticks of the fence
    expect(md).toContain("  ```\n  Use `code` | table | <script>alert(1)</script>\n  ```");
    // a value with a backtick keeps its code span, now with a grown delimiter
    expect(md).toContain("- Quote: ``a ` b | c``");
    // inside a code span a pipe needs no escaping, outside one it does
    expect(md).toContain("selector `div|p`");
    expect(md).toContain("  - style.color: red\\|blue");
  });

  it("emits balanced fences so no note text can leak out of a block", () => {
    const md = toMarkdown([
      makeNote({ id: "n-f1", body: "plain" }),
      makeNote({ id: "n-f2", body: "```\nrunaway\n```", messages: thread, debug, context: captured }),
    ]);
    const fences = md.split("\n").filter((line) => /^\s*`{3,}\s*$/.test(line));
    expect(fences.length).toBeGreaterThan(0);
    expect(fences.length % 2).toBe(0);
  });

  it("grows the fence when the body contains a longer backtick run", () => {
    const md = toMarkdown([makeNote({ id: "n-fence", body: "```\nnot a fence\n```" })]);
    expect(md).toContain("  ````\n  ```\n  not a fence\n  ```\n  ````");
  });

  it("switches section headings and labels with language=de, keeping the values raw", () => {
    const md = toMarkdown([makeNote({ id: "n-1", status: "needs_decision" }), makeNote({ id: "n-2", route: "/a" })], {
      language: "de",
    });
    expect(md).toContain("## ⚠ offene Entscheidungen");
    expect(md).toContain("## Notizen nach Route");
    expect(md).toContain("- Typ: text");
    expect(md).toContain("- Absicht: implement");
    expect(md).toContain("- Status: needs_decision");
    expect(md).toContain("_Notizen: 2 · offene Entscheidungen: 1 · nur Feedback: 0 · erledigt: 0_");
    expect(md).toContain("### Route: `/a`");
    expect(md.startsWith("# bluepencil Review-Notizen\n")).toBe(true);
  });
});

describe("toMarkdown determinism", () => {
  const notes: Note[] = [
    makeNote({ id: "n-b", route: "/b", now: T1, context: captured, messages: thread, status: "done" }),
    makeNote({ id: "n-a", route: "/a", now: T0, debug, status: "needs_decision" }),
    makeNote({ id: "n-c", route: null, now: T2, intent: "feedback" }),
  ];

  it("produces byte-identical output on two calls", () => {
    expect(toMarkdown(notes)).toBe(toMarkdown(notes));
  });

  it("is unchanged by a no-op canonicalisation", () => {
    expect(toMarkdown(notes.map(recanonicalise))).toBe(toMarkdown(notes));
  });

  it("is unchanged when the input array order changes", () => {
    const md = toMarkdown(notes);
    expect(toMarkdown([...notes].reverse())).toBe(md);
    expect(toMarkdown([notes[2] as Note, notes[0] as Note, notes[1] as Note])).toBe(md);
  });

  it("excludes done notes everywhere, including the counts", () => {
    const done = makeNote({
      id: "n-done-only",
      status: "done",
      body: "COMPLETED-ITEM",
      hook: "#completed",
      route: "/secret",
    });
    const mixed = [makeNote({ id: "n-open", route: "/a" }), done];

    const complete = toMarkdown(mixed);
    expect(complete).toContain("n-done-only");
    expect(complete).toContain("_Notes: 2 · open decisions: 0 · feedback only: 0 · done: 1_");

    const withoutDone = toMarkdown(mixed, { includeDone: false });
    expect(withoutDone).not.toContain("n-done-only");
    expect(withoutDone).not.toContain("COMPLETED-ITEM");
    expect(withoutDone).not.toContain("#completed");
    expect(withoutDone).not.toContain("/secret");
    expect(withoutDone).toContain("_Notes: 1 · open decisions: 0 · feedback only: 0 · done: 0_");
  });

  it("keeps includeDone=false inside the exception sections too", () => {
    const doneFeedback = makeNote({ id: "n-done-feedback", intent: "feedback", status: "done" });
    const md = toMarkdown([doneFeedback], { includeDone: false });
    expect(md).not.toContain("💬 feedback only");
    expect(md).not.toContain("n-done-feedback");
  });

  it("narrows done notes with the shared excludeDone rule, not a local copy (FR-15.3)", () => {
    const doneFeedback = makeNote({ id: "n-done-feedback", intent: "feedback", status: "done" });
    const done = makeNote({ id: "n-done", status: "done" });
    const open = makeNote({ id: "n-open" });
    const list = [doneFeedback, done, open];

    // the export narrows exactly like the bar, the list and the adapters
    const expected = excludeDone([...list]).map((note) => note.id);
    expect(expected).toEqual(["n-open"]);
    const md = toMarkdown(list, { includeDone: false });
    for (const note of list) {
      expect(md.includes(note.id), `${note.id} in ${md}`).toBe(expected.includes(note.id));
    }
    // a second, independent signature of the same rule: matchesFilter of core/adapter
    expect(filterNotes([...list], { includeDone: false }).map((note) => note.id)).toEqual(expected);
  });
});

describe("noteToMarkdown", () => {
  const note = makeNote({ id: "n-single", body: "one note", quote: "one note quote" });

  it("renders exactly one note", () => {
    const md = noteToMarkdown(note);
    expect(md.startsWith("### n-single — text/implement/open\n")).toBe(true);
    expect(md).toContain("- Quote: `one note quote`");
    expect(md).toContain("  ```\n  one note\n  ```");
    expect(md).not.toContain("\n## ");
    expect(md.endsWith("\n")).toBe(true);
  });

  it("accepts the title and language options", () => {
    const md = noteToMarkdown(note, { title: "Single note", language: "de" });
    expect(md.startsWith("# Single note\n\n### n-single — text/implement/open\n")).toBe(true);
    expect(md).toContain("- Typ: text");
  });
});

describe("json export", () => {
  const notes: Note[] = [
    makeNote({ id: "n-json-a", route: "/a", messages: thread, context: captured, debug }),
    makeNote({ id: "n-json-b", route: "/b", status: "done", intent: "feedback" }),
  ];

  it("writes a schema-versioned bundle document, pretty by default", () => {
    const text = toJson(notes, { now: T0 });
    const parsed = JSON.parse(text) as { kind?: string; schemaVersion?: number; notes?: unknown[] };
    expect(parsed.kind).toBe("bluepencil.bundle");
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.notes).toHaveLength(2);
    expect(text).toContain("\n  ");
    expect(text.endsWith("\n")).toBe(true);

    const compact = toJson(notes, { now: T0, pretty: false });
    expect(compact.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(compact)).toEqual(parsed);
    expect(toJson(notes, { now: T0, pretty: true })).toBe(text);
  });

  it("is deterministic: same notes, same options, same bytes", () => {
    expect(toJson(notes, { now: T0, exportedBy: "agent" })).toBe(
      toJson(notes, { now: T0, exportedBy: "agent" }),
    );
    const first = toJson(notes, { now: T0 });
    const second = toJson([...notes].reverse(), { now: T0 });
    expect(second).toBe(first);
  });

  it("round-trips through fromJson", () => {
    const back = fromJson(toJson(notes, { now: T0 }));
    expect(back).toHaveLength(notes.length);
    const sortById = (list: Note[]): Note[] => [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    expect(sortById(back)).toEqual(sortById(notes));
  });

  it("accepts a bare Note[] document", () => {
    const back = fromJson(JSON.stringify(notes));
    expect(back).toHaveLength(2);
    expect(back[0]).toEqual(notes[0]);
  });

  it("refuses invalid input with a BluepencilValidationError", () => {
    expect(() => fromJson("not json")).toThrow(BluepencilValidationError);
    expect(() => fromJson("42")).toThrow(BluepencilValidationError);
    expect(() => fromJson(JSON.stringify([{ id: "n-broken" }]))).toThrow(BluepencilValidationError);
    expect(() => fromJson('{"kind":"bluepencil.bundle","schemaVersion":1}')).toThrow(BluepencilValidationError);
  });

  it("writes a bundle the data library reads back", () => {
    const bundle = parseBundle(toJson(notes, { now: T0 }));
    expect(bundle.notes).toHaveLength(2);
  });
});
