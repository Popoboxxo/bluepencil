/**
 * Markdown export (FR-5.6, FR-7.1, FR-7.3, NFR-10).
 *
 * Plain Markdown only: no HTML is generated, no entity escaping is applied, every piece of
 * user text stays literal. User text is never placed where it could break the document
 * structure or turn into markup — inline fields have backticks and pipes escaped, multi-line
 * text is wrapped in a fenced block whose fence is always longer than the longest backtick
 * run inside it (so the text can never close the block and never reaches a Markdown viewer as
 * HTML).
 *
 * Layout:
 *   1. `## ⚠ open decisions` and `## 💬 feedback only` — the exception sections an agent has to
 *      read first (FR-5.6, docs/PROTOCOL.md §7). A section is omitted when it would be empty.
 *   2. `## Notes by route` with one `### Route: <route>` heading per anchor route (FR-7.1).
 *
 * `includeDone: false` uses the shared done-narrowing of `src/core/adapter.ts` (`excludeDone`), so
 * the export, the bar and the list narrow the same way (FR-15.3, FR-4.3/4.8).
 *
 * Ordering inside every section: FR-4.6 priority (needs_decision, feedback, open, done), then
 * creation time, then id. Routes are sorted by code unit, the no-route group comes last.
 * Nothing but the caller-supplied `generatedAt` is time dependent, so two exports of an
 * unchanged set are byte-identical and diffable (FR-7.3, NFR-10).
 */

import type { Note } from "../model";
import { excludeDone } from "../adapter";
import { exceptionNotes, sortForReview } from "../protocol";

export interface MarkdownOptions {
  /** Section headings and field labels; field *values* stay the raw model vocabulary. */
  language?: "en" | "de";
  /** Include `done` notes (default `true`). When `false` they are gone from the whole export. */
  includeDone?: boolean;
  /** Document title, emitted as the single level-1 heading. */
  title?: string;
  /**
   * Export timestamp. Omitted by default so the output stays deterministic; when the caller
   * supplies it, it is printed as an `Exported: …` line.
   */
  generatedAt?: string;
}

type Language = "en" | "de";

interface ExportStrings {
  readonly defaultTitle: string;
  readonly exported: string;
  readonly notesLabel: string;
  readonly decisionsCount: string;
  readonly feedbackCount: string;
  readonly doneCount: string;
  readonly decisionsSection: string;
  readonly feedbackSection: string;
  readonly byRouteSection: string;
  readonly noRoute: string;
  readonly none: string;
  readonly type: string;
  readonly intent: string;
  readonly status: string;
  readonly source: string;
  readonly author: string;
  readonly created: string;
  readonly updated: string;
  readonly environment: string;
  readonly session: string;
  readonly ticket: string;
  readonly quote: string;
  readonly anchor: string;
  readonly hook: string;
  readonly selector: string;
  readonly route: string;
  /** Lower-case variant used inside the anchor line ("hook …, selector …, route …"). */
  readonly routeField: string;
  readonly orphaned: string;
  readonly degraded: string;
  readonly body: string;
  readonly captured: string;
  readonly debug: string;
  readonly thread: string;
}

/** Section headings and field labels per language (FR-5.6); values are never translated. */
const STRINGS: Record<Language, ExportStrings> = {
  en: {
    defaultTitle: "bluepencil review notes",
    exported: "Exported",
    notesLabel: "Notes",
    decisionsCount: "open decisions",
    feedbackCount: "feedback only",
    doneCount: "done",
    decisionsSection: "⚠ open decisions",
    feedbackSection: "💬 feedback only",
    byRouteSection: "Notes by route",
    noRoute: "(no route)",
    none: "none",
    type: "Type",
    intent: "Intent",
    status: "Status",
    source: "Source",
    author: "Author",
    created: "Created",
    updated: "Updated",
    environment: "Environment",
    session: "Session",
    ticket: "Ticket",
    quote: "Quote",
    anchor: "Anchor",
    hook: "hook",
    selector: "selector",
    route: "Route",
    routeField: "route",
    orphaned: "orphaned",
    degraded: "degraded",
    body: "Body",
    captured: "Captured state",
    debug: "Debug",
    thread: "Thread",
  },
  de: {
    defaultTitle: "bluepencil Review-Notizen",
    exported: "Exportiert",
    notesLabel: "Notizen",
    decisionsCount: "offene Entscheidungen",
    feedbackCount: "nur Feedback",
    doneCount: "erledigt",
    decisionsSection: "⚠ offene Entscheidungen",
    feedbackSection: "💬 nur Feedback",
    byRouteSection: "Notizen nach Route",
    noRoute: "(ohne Route)",
    none: "keine",
    type: "Typ",
    intent: "Absicht",
    status: "Status",
    source: "Quelle",
    author: "Autor",
    created: "Erstellt",
    updated: "Geändert",
    environment: "Umgebung",
    session: "Sitzung",
    ticket: "Ticket",
    quote: "Zitat",
    anchor: "Anker",
    hook: "hook",
    selector: "Selektor",
    route: "Route",
    routeField: "Route",
    orphaned: "verwaist",
    degraded: "eingeschränkt",
    body: "Text",
    captured: "Erfasster Zustand",
    debug: "Debug",
    thread: "Verlauf",
  },
};

/** Collapse every line break and run of whitespace into single spaces. */
function flatten(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim();
}

/** Literal inline text: keeps the characters, escapes the two that could open markup. */
function inline(value: string): string {
  return flatten(value).replace(/`/g, "\\`").replace(/\|/g, "\\|");
}

/**
 * Markdown code span for short machine values. A value containing a backtick cannot be put in
 * a code span unambiguously, so it falls back to escaped literal text.
 */
function code(value: string): string {
  const flat = flatten(value);
  if (flat === "") {
    return "";
  }
  if (flat.includes("`")) {
    return inline(flat);
  }
  return `\`${flat}\``;
}

/** A fence that is longer than the longest backtick run in `text`, so it can never be closed. */
function fenceFor(text: string): string {
  let longest = 0;
  let run = 0;
  for (const ch of text) {
    if (ch === "`") {
      run += 1;
      if (run > longest) {
        longest = run;
      }
    } else {
      run = 0;
    }
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Multi-line literal text as a fenced block. `indent` must match the column the block lives
 * in (list item content); CommonMark strips up to that indentation, so the rendered text is
 * the input text, unmodified.
 */
function fenced(text: string, indent: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const fence = fenceFor(normalized);
  const lines = normalized.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return [indent + fence, ...lines.map((line) => (line === "" ? "" : indent + line)), indent + fence];
}

function compareText(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

function bullet(label: string, value: string): string {
  return `- ${label}: ${value}`;
}

/** A bullet that introduces a nested block (body, captured state, debug, thread). */
function section(label: string): string {
  return `- ${label}:`;
}

function renderNote(note: Note, s: ExportStrings, headingLevel: number): string[] {
  const lines: string[] = [];
  lines.push(`${"#".repeat(headingLevel)} ${inline(note.id)} — ${note.type}/${note.intent}/${note.status}`);

  lines.push(bullet(s.type, note.type));
  lines.push(bullet(s.intent, note.intent));
  lines.push(bullet(s.status, note.status));
  lines.push(bullet(s.source, code(note.source)));
  lines.push(bullet(s.author, `${inline(note.author)} (${note.authorType})`));
  lines.push(bullet(s.created, inline(note.createdAt)));
  lines.push(bullet(s.updated, inline(note.updatedAt)));
  lines.push(bullet(s.environment, note.environment));
  if (note.sessionRef !== undefined && note.sessionRef !== "") {
    lines.push(bullet(s.session, code(note.sessionRef)));
  }
  if (note.ticketRef !== undefined && note.ticketRef !== "") {
    lines.push(bullet(s.ticket, code(note.ticketRef)));
  }

  const anchor = note.anchor;
  if (anchor.quote !== undefined && anchor.quote !== "") {
    lines.push(bullet(s.quote, code(anchor.quote)));
  }
  const anchorParts: string[] = [];
  if (anchor.hook !== undefined && anchor.hook !== "") {
    anchorParts.push(`${s.hook} ${code(anchor.hook)}`);
  }
  if (anchor.selector !== undefined && anchor.selector !== "") {
    anchorParts.push(`${s.selector} ${code(anchor.selector)}`);
  }
  if (anchor.route !== undefined && anchor.route !== "") {
    anchorParts.push(`${s.routeField} ${code(anchor.route)}`);
  }
  if (anchor.orphaned === true) {
    anchorParts.push(s.orphaned);
  }
  if (anchor.degraded !== undefined && anchor.degraded !== "") {
    anchorParts.push(`${s.degraded} ${code(anchor.degraded)}`);
  }
  if (anchorParts.length > 0) {
    lines.push(bullet(s.anchor, anchorParts.join(" · ")));
  }

  lines.push(section(s.body));
  lines.push(...fenced(note.body, "  "));

  const context = note.context;
  if (context !== null) {
    lines.push(section(s.captured));
    lines.push(`  - tag: ${code(context.tag)}`);
    if (context.classes.length > 0) {
      lines.push(`  - classes: ${code(context.classes.join(" "))}`);
    }
    lines.push(`  - scheme: ${context.scheme}`);
    lines.push(`  - viewport: ${context.viewport.w}×${context.viewport.h}`);
    lines.push(`  - box: ${context.box.w}×${context.box.h} at ${context.box.x},${context.box.y}`);
    if (context.buildRef !== undefined && context.buildRef !== "") {
      lines.push(`  - build: ${code(context.buildRef)}`);
    }
    // Sorted so the export does not depend on the insertion order of the captured styles.
    for (const key of Object.keys(context.styles).sort(compareText)) {
      const value = context.styles[key];
      if (value === undefined) {
        continue;
      }
      lines.push(`  - style.${inline(key)}: ${inline(value)}`);
    }
  }

  const debug = note.debug;
  if (debug !== undefined) {
    lines.push(section(s.debug));
    if (debug.test !== undefined && debug.test !== "") {
      lines.push(`  - test: ${code(debug.test)}`);
    }
    if (debug.commit !== undefined && debug.commit !== "") {
      lines.push(`  - commit: ${code(debug.commit)}`);
    }
    if (debug.file !== undefined && debug.file !== "") {
      lines.push(`  - file: ${code(debug.file)}`);
    }
    if (debug.stack !== undefined && debug.stack !== "") {
      lines.push("  - stack:");
      lines.push(...fenced(debug.stack, "    "));
    }
    if (debug.log !== undefined && debug.log !== "") {
      lines.push("  - log:");
      lines.push(...fenced(debug.log, "    "));
    }
  }

  lines.push(section(s.thread));
  if (note.messages.length === 0) {
    lines.push(`  - ${s.none}`);
  } else {
    note.messages.forEach((message, index) => {
      lines.push(
        `  ${index + 1}. ${inline(message.author)} (${message.authorType}) · ${message.kind} · ${inline(message.ts)}`,
      );
      lines.push(...fenced(message.text, "     "));
    });
  }

  return lines;
}

/** Render a single note on its own. The caller passes `title` to get a level-1 heading. */
export function noteToMarkdown(note: Note, options: MarkdownOptions = {}): string {
  const s = STRINGS[options.language === "de" ? "de" : "en"];
  const lines: string[] = [];
  if (options.title !== undefined && options.title !== "") {
    lines.push(`# ${inline(options.title)}`, "");
  }
  lines.push(...renderNote(note, s, 3));
  return `${lines.join("\n")}\n`;
}

function groupByRoute(notes: Note[], noRouteKey: string): Map<string, Note[]> {
  const groups = new Map<string, Note[]>();
  for (const note of notes) {
    const route = flatten(note.anchor.route ?? "");
    const key = route === "" ? noRouteKey : route;
    const bucket = groups.get(key);
    if (bucket === undefined) {
      groups.set(key, [note]);
    } else {
      bucket.push(note);
    }
  }
  return groups;
}

/**
 * Full export: exception sections first, then the notes grouped by route.
 */
export function toMarkdown(notes: Note[], options: MarkdownOptions = {}): string {
  const s = STRINGS[options.language === "de" ? "de" : "en"];
  const includeDone = options.includeDone !== false;
  const included = includeDone ? [...notes] : excludeDone([...notes]);

  const exceptions = exceptionNotes(included);
  const exceptionIds = new Set<string>([...exceptions.decisions, ...exceptions.feedback].map((note) => note.id));
  const rest = sortForReview(included.filter((note) => !exceptionIds.has(note.id)));

  const doneCount = included.filter((note) => note.status === "done").length;

  const out: string[] = [];
  out.push(`# ${inline(options.title ?? s.defaultTitle)}`, "");
  if (options.generatedAt !== undefined && options.generatedAt !== "") {
    out.push(`_${s.exported}: ${inline(options.generatedAt)}_`, "");
  }
  out.push(
    `_${s.notesLabel}: ${included.length} · ${s.decisionsCount}: ${exceptions.decisions.length} · ` +
      `${s.feedbackCount}: ${exceptions.feedback.length} · ${s.doneCount}: ${doneCount}_`,
  );

  const pushSection = (heading: string, sectionNotes: Note[]): void => {
    if (sectionNotes.length === 0) {
      return;
    }
    out.push("", `## ${heading}`);
    for (const note of sectionNotes) {
      out.push("", ...renderNote(note, s, 4));
    }
  };

  pushSection(s.decisionsSection, exceptions.decisions);
  pushSection(s.feedbackSection, exceptions.feedback);

  const groups = groupByRoute(rest, s.noRoute);
  if (groups.size > 0) {
    out.push("", `## ${s.byRouteSection}`);
    // Routes are sorted by code unit; the no-route group always comes last.
    const keys = [...groups.keys()].filter((key) => key !== s.noRoute).sort(compareText);
    if (groups.has(s.noRoute)) {
      keys.push(s.noRoute);
    }
    for (const key of keys) {
      const groupNotes = groups.get(key) ?? [];
      out.push("", key === s.noRoute ? `### ${s.noRoute}` : `### ${s.route}: ${code(key)}`);
      for (const note of groupNotes) {
        out.push("", ...renderNote(note, s, 4));
      }
    }
  }

  return `${out.join("\n")}\n`;
}
