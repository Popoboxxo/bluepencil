/**
 * MCP tool implementations (FR-16.1–16.7).
 *
 * These are **thin wrappers** over the headless data library and the store — no separate
 * merge, validation or canonicalisation logic (FR-15.3/16.7). The same functions back the CLI,
 * so `bluepencil merge` and `import_bundle` behave identically.
 *
 * Safety model:
 *  - **read-only by default**: every write tool returns a clear refusal unless the session was
 *    started with an explicit opt-in (FR-16.2);
 *  - a session is bound to **one store, one app and one environment**; anything that would
 *    touch another environment is refused (FR-16.3/NFR-18);
 *  - agent writes carry `source=agent` plus the MCP client name and session id (FR-16.4).
 */
import { canonicalNote, canonicalBundle } from "../data/canonical";
import { createBundle, inspectBundle, parseBundle, bundleToJson, type BundleSummary } from "../data/bundle";
import { mergeNotes, type MergeMode, type MergeResult } from "../data/merge";
import { validateNote } from "../data/schema";
import type { Store } from "../core/store";
import {
  BluepencilValidationError,
  createMessage,
  isNoteIntent,
  isNoteStatus,
  systemClock,
  type Anchor,
  type Environment,
  type Note,
  type NoteFilter,
  type NoteStatus,
  type NoteType,
} from "../core/model";

export interface ToolContext {
  store: Store;
  /** Explicit write opt-in for this session (FR-16.2). */
  allowWrite: boolean;
  /** Environment this session is bound to (FR-16.3). */
  environment: Environment;
  appName: string;
  clientName: string;
  sessionId: string;
  now?: () => string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Read-only tools are always available; write tools need the opt-in. */
  write: boolean;
}

export interface ToolContent {
  type: "text";
  text: string;
}

export interface ToolResponse {
  content: ToolContent[];
  isError?: boolean;
}

const READ_ONLY_NOTE = "Read-only session: writes are disabled (FR-16.2).";

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "list_notes",
    description:
      "List the notes of this session's store, newest review order (open decisions first, then " +
      "feedback-only, then the rest). Done notes are hidden unless include_done is true.",
    write: false,
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "done", "needs_decision"] },
        intent: { type: "string", enum: ["implement", "feedback"] },
        type: { type: "string", enum: ["text", "design"] },
        route: { type: "string" },
        session: { type: "string" },
        include_done: { type: "boolean", default: false },
        format: { type: "string", enum: ["json", "markdown"], default: "json" },
      },
    },
  },
  {
    name: "get_note",
    description: "Fetch exactly one note with its anchor, captured context and full thread.",
    write: false,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "create_note",
    description:
      "Create a note in the bound store (source=agent). Anchors may use a host hook " +
      "(data-bluepencil/data-testid), a CSS path or a text quote.",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string" },
        type: { type: "string", enum: ["text", "design"], default: "text" },
        intent: { type: "string", enum: ["implement", "feedback"], default: "implement" },
        hook: { type: "string" },
        selector: { type: "string" },
        quote: { type: "string" },
        route: { type: "string" },
        session: { type: "string" },
        ticket_ref: { type: "string" },
      },
      required: ["body"],
    },
  },
  {
    name: "reply",
    description:
      "Append a message to a note's thread (append-only). kind=reply reports work that was " +
      "actually done; kind=decision_request asks the human and sets status=needs_decision; " +
      "kind=feedback answers an intent=feedback note without changing anything.",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        text: { type: "string" },
        kind: {
          type: "string",
          enum: ["reply", "feedback", "decision_request", "decision", "note"],
          default: "reply",
        },
        set_done: { type: "boolean", default: false },
      },
      required: ["id", "text"],
    },
  },
  {
    name: "set_status",
    description:
      "Set a note's status. Refused for `done` while the note waits for a decision; refused for " +
      "`done` on intent=feedback notes (PROTOCOL §6) — the human decides those.",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: ["open", "done", "needs_decision"] },
      },
      required: ["id", "status"],
    },
  },
  {
    name: "set_intent",
    description: "Switch a note between implement and feedback.",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        intent: { type: "string", enum: ["implement", "feedback"] },
      },
      required: ["id", "intent"],
    },
  },
  {
    name: "export_bundle",
    description:
      "Export the current set as a portable bundle (JSON) or as the agent-facing Markdown export " +
      "whose exception sections come first.",
    write: false,
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["json", "markdown"], default: "markdown" },
        include_done: { type: "boolean", default: true },
      },
    },
  },
  {
    name: "inspect_bundle",
    description: "Summarise a bundle (sessions, counts, environments, routes) without writing anything.",
    write: false,
    inputSchema: {
      type: "object",
      properties: { bundle: { type: ["string", "object"] } },
      required: ["bundle"],
    },
  },
  {
    name: "import_bundle",
    description:
      "Import a bundle with mode merge (idempotent, default), upsert or replace-session. Conflicts " +
      "are reported and never resolved silently; an environment mismatch is refused unless " +
      "allow_env_mismatch is set.",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        bundle: { type: ["string", "object"] },
        mode: { type: "string", enum: ["merge", "upsert", "replace-session"], default: "merge" },
        dry_run: { type: "boolean", default: true },
        on_conflict: { type: "string", enum: ["fail", "keep-incoming", "keep-existing"] },
        allow_env_mismatch: { type: "boolean", default: false },
      },
      required: ["bundle"],
    },
  },
];

export function jsonResponse(value: unknown, isError = false): ToolResponse {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

export function errorResponse(message: string): ToolResponse {
  return { content: [{ type: "text", text: `error: ${message}` }], isError: true };
}

function requireWrite(context: ToolContext): ToolResponse | null {
  return context.allowWrite ? null : errorResponse(READ_ONLY_NOTE);
}

function nowIso(context: ToolContext): string {
  return (context.now ?? systemClock.now)();
}

function agentAuthor(context: ToolContext): string {
  return `${context.clientName} (mcp:${context.sessionId})`;
}

function toFilter(args: Record<string, unknown>): NoteFilter {
  const filter: NoteFilter = {};
  if (isNoteStatus(args.status)) filter.status = args.status;
  if (isNoteIntent(args.intent)) filter.intent = args.intent;
  if (typeof args.type === "string") filter.type = args.type as NoteType;
  if (typeof args.route === "string") filter.route = args.route;
  if (typeof args.session === "string") filter.session = args.session;
  return filter;
}

/** Ordering shared with the UI and the Markdown export (FR-4.6). */
export function sortForReview(notes: Note[]): Note[] {
  const rank: Record<NoteStatus, number> = { needs_decision: 0, open: 1, done: 3 };
  return [...notes].sort((a, b) => {
    const aRank = a.intent === "feedback" ? 1 : rank[a.status];
    const bRank = b.intent === "feedback" ? 1 : rank[b.status];
    if (aRank !== bRank) return aRank - bRank;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

export async function callTool(
  context: ToolContext,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResponse> {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name);
  if (!definition) {
    return errorResponse(`unknown tool "${name}"`);
  }

  switch (name) {
    case "list_notes": {
      const includeDone = args.include_done === true;
      const notes = await context.store.list(toFilter(args));
      const selected = includeDone ? notes : notes.filter((note) => note.status !== "done");
      const ordered = sortForReview(selected);
      if (args.format === "markdown") {
        const lines = ordered.map(
          (note) =>
            `- [${note.status}/${note.intent}] ${note.anchor.route ?? "-"} ${note.anchor.hook ?? note.anchor.selector ?? "-"}: ${note.body.split("\n")[0] ?? ""}`,
        );
        return {
          content: [
            {
              type: "text",
              text: [
                `# ${context.appName} — ${ordered.length} note(s) [env: ${context.environment}]`,
                "",
                ...(lines.length > 0 ? lines : ["(no notes)"]),
              ].join("\n"),
            },
          ],
        };
      }
      return jsonResponse({
        environment: context.environment,
        app: context.appName,
        count: ordered.length,
        notes: ordered.map(canonicalNote),
      });
    }

    case "get_note": {
      const id = String(args.id ?? "");
      const note = await context.store.get(id);
      if (!note) {
        return errorResponse(`note ${id} not found`);
      }
      return jsonResponse(canonicalNote(note));
    }

    case "create_note": {
      const refusal = requireWrite(context);
      if (refusal) return refusal;
      const body = String(args.body ?? "").trim();
      if (body === "") {
        return errorResponse("body must not be empty");
      }
      const anchor: Anchor = {};
      if (typeof args.hook === "string" && args.hook) anchor.hook = args.hook;
      if (typeof args.selector === "string" && args.selector) anchor.selector = args.selector;
      if (typeof args.quote === "string" && args.quote) anchor.quote = args.quote;
      if (typeof args.route === "string" && args.route) anchor.route = args.route;
      if (!anchor.hook && !anchor.selector && !anchor.quote) {
        return errorResponse("an anchor needs at least one of hook, selector or quote");
      }
      try {
        const note = await context.store.create({
          type: (args.type as NoteType) ?? "text",
          body,
          anchor,
          intent: isNoteIntent(args.intent) ? args.intent : "implement",
          author: agentAuthor(context),
          authorType: "agent",
          source: "agent",
          environment: context.environment,
          ...(typeof args.session === "string" ? { sessionRef: args.session } : {}),
          ...(typeof args.ticket_ref === "string" ? { ticketRef: args.ticket_ref } : {}),
        });
        return jsonResponse({ created: canonicalNote(note) });
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : String(error));
      }
    }

    case "reply": {
      const refusal = requireWrite(context);
      if (refusal) return refusal;
      const id = String(args.id ?? "");
      const note = await context.store.get(id);
      if (!note) {
        return errorResponse(`note ${id} not found`);
      }
      const kind = (args.kind as string) ?? "reply";
      if (kind === "decision") {
        return errorResponse(
          "a decision must come from a human (PROTOCOL §6.1) — use kind=decision_request and let the human answer",
        );
      }
      const text = String(args.text ?? "");
      if (text.trim() === "") {
        return errorResponse("text must not be empty");
      }
      const ts = nowIso(context);
      const message = createMessage({
        text,
        kind: kind as "reply" | "feedback" | "decision_request" | "note",
        author: agentAuthor(context),
        authorType: "agent",
        now: ts,
      });
      const updated = await context.store.addMessage(id, message);
      let final = updated;
      if (kind === "decision_request") {
        final = await context.store.setStatus(id, "needs_decision");
      } else if (args.set_done === true) {
        if (final.intent === "feedback") {
          return errorResponse(
            "intent=feedback notes are not set to done by an agent (PROTOCOL §4.5/§6.2)",
          );
        }
        if (final.status === "needs_decision") {
          return errorResponse("refusing to mark a pending decision as done (PROTOCOL §6.3)");
        }
        final = await context.store.setStatus(id, "done");
      }
      return jsonResponse({ note: canonicalNote(final) });
    }

    case "set_status": {
      const refusal = requireWrite(context);
      if (refusal) return refusal;
      const id = String(args.id ?? "");
      const status = args.status;
      if (!isNoteStatus(status)) {
        return errorResponse(`status must be one of open, done, needs_decision`);
      }
      const note = await context.store.get(id);
      if (!note) {
        return errorResponse(`note ${id} not found`);
      }
      if (status === "done") {
        if (note.status === "needs_decision") {
          return errorResponse("refusing to mark a pending decision as done (PROTOCOL §6.3)");
        }
        if (note.intent === "feedback") {
          return errorResponse("intent=feedback notes are decided by the human (PROTOCOL §6.2)");
        }
      }
      const updated = await context.store.setStatus(id, status);
      return jsonResponse({ note: canonicalNote(updated) });
    }

    case "set_intent": {
      const refusal = requireWrite(context);
      if (refusal) return refusal;
      const id = String(args.id ?? "");
      if (!isNoteIntent(args.intent)) {
        return errorResponse("intent must be implement or feedback");
      }
      const note = await context.store.get(id);
      if (!note) {
        return errorResponse(`note ${id} not found`);
      }
      const updated = await context.store.setIntent(id, args.intent);
      return jsonResponse({ note: canonicalNote(updated) });
    }

    case "export_bundle": {
      const includeDone = args.include_done !== false;
      const notes = await context.store.list();
      const selected = includeDone ? notes : notes.filter((note) => note.status !== "done");
      if (args.format === "json") {
        const bundle = createBundle(selected, {
          environment: context.environment,
          exportedBy: agentAuthor(context),
          app: { name: context.appName },
          now: nowIso(context),
        });
        return { content: [{ type: "text", text: bundleToJson(bundle) }] };
      }
      const { toMarkdown } = await import("../core/export/markdown");
      return {
        content: [
          { type: "text", text: toMarkdown(selected, { includeDone, title: `${context.appName} review notes` }) },
        ],
      };
    }

    case "inspect_bundle": {
      const parsed = parseBundleInput(args.bundle);
      if (typeof parsed === "string") {
        return errorResponse(parsed);
      }
      return jsonResponse(summaryWithEnvironment(parsed, context));
    }

    case "import_bundle": {
      const refusal = requireWrite(context);
      if (refusal) return refusal;
      const parsed = parseBundleInput(args.bundle);
      if (typeof parsed === "string") {
        return errorResponse(parsed);
      }
      const bundle = parsed;
      if (bundle.environment !== context.environment && args.allow_env_mismatch !== true) {
        return errorResponse(
          `bundle is tagged "${bundle.environment}" but this session is bound to "${context.environment}" ` +
            `— pass allow_env_mismatch to override deliberately (NFR-18)`,
        );
      }
      const existing = await context.store.list();
      const mode = (args.mode as MergeMode) ?? "merge";
      const dryRun = args.dry_run !== false;
      let result: MergeResult;
      try {
        result = mergeNotes(existing, bundle.notes, {
          mode,
          dryRun,
          allowEnvMismatch: args.allow_env_mismatch === true,
          targetEnvironment: context.environment,
          ...(typeof args.on_conflict === "string"
            ? { onConflict: args.on_conflict as "fail" | "keep-incoming" | "keep-existing" }
            : {}),
        });
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : String(error));
      }

      if (!dryRun) {
        // Apply the merge result through the store so the adapter persists it (single write path).
        const existingIds = new Set(existing.map((note) => note.id));
        const keepIds = new Set(result.notes.map((note) => note.id));
        for (const note of existing) {
          if (!keepIds.has(note.id)) {
            await context.store.remove(note.id);
          }
        }
        for (const note of result.notes) {
          if (!existingIds.has(note.id)) {
            const { id, createdAt, updatedAt, ...draft } = note;
            try {
              const created = await context.store.create({
                ...draft,
                id,
                now: updatedAt,
                messages: note.messages,
              });
              if (created.createdAt !== createdAt || created.updatedAt !== updatedAt) {
                await context.store.update(created.id, {});
              }
            } catch (error) {
              return errorResponse(error instanceof Error ? error.message : String(error));
            }
          } else if (validateNote(note).length === 0) {
            await context.store.update(note.id, {
              status: note.status,
              intent: note.intent,
              body: note.body,
            });
          }
        }
      }

      return jsonResponse({
        mode,
        dry_run: dryRun,
        added: result.added,
        updated: result.updated,
        skipped: result.skipped,
        removed: result.removed,
        conflicts: result.conflicts,
      });
    }

    default:
      return errorResponse(`tool "${name}" is not implemented`);
  }
}

function summaryWithEnvironment(bundle: ReturnType<typeof parseBundle>, context: ToolContext): BundleSummary & { targetEnvironment: string; environmentMatches: boolean } {
  const summary = inspectBundle(bundle);
  return {
    ...summary,
    targetEnvironment: context.environment,
    environmentMatches: bundle.environment === context.environment,
  };
}

function parseBundleInput(input: unknown): ReturnType<typeof parseBundle> | string {
  try {
    if (typeof input === "string") {
      return parseBundle(input);
    }
    if (input && typeof input === "object") {
      return parseBundle(JSON.stringify(input));
    }
    return "bundle must be a JSON string or an object";
  } catch (error) {
    if (error instanceof BluepencilValidationError) {
      return error.issues.join("; ");
    }
    return error instanceof Error ? error.message : String(error);
  }
}

/** Resources are read without tools so a host can fetch them directly (FR-16.5). */
export async function readResource(
  context: ToolContext,
  uri: string,
): Promise<{ uri: string; mimeType: string; text: string } | null> {
  const notes = await context.store.list();
  switch (uri) {
    case "bluepencil://notes": {
      const { toMarkdown } = await import("../core/export/markdown");
      return {
        uri,
        mimeType: "text/markdown",
        text: toMarkdown(notes, { includeDone: true, title: `${context.appName} review notes` }),
      };
    }
    case "bluepencil://notes.json":
      return { uri, mimeType: "application/json", text: JSON.stringify(notes.map(canonicalNote), null, 2) };
    case "bluepencil://bundle": {
      const bundle = createBundle(notes, {
        environment: context.environment,
        exportedBy: agentAuthor(context),
        app: { name: context.appName },
        now: nowIso(context),
      });
      return { uri, mimeType: "application/json", text: bundleToJson(bundle) };
    }
    default:
      return null;
  }
}

export function listResources(): Array<{ uri: string; name: string; mimeType: string }> {
  return [
    { uri: "bluepencil://notes", name: "Review notes (Markdown)", mimeType: "text/markdown" },
    { uri: "bluepencil://notes.json", name: "Review notes (JSON)", mimeType: "application/json" },
    { uri: "bluepencil://bundle", name: "Portable bundle", mimeType: "application/json" },
  ];
}

export function listPrompts(): Array<{ name: string; description: string }> {
  return [
    {
      name: "work-off-open-notes",
      description: "Work list of implementable notes, with the exception sections first (PROTOCOL §7).",
    },
    {
      name: "summarise-decisions",
      description: "Summarise every note that waits for a human decision, with the recommendation.",
    },
  ];
}

export function getPrompt(name: string): ToolResponse {
  switch (name) {
    case "work-off-open-notes":
      return {
        content: [
          {
            type: "text",
            text: [
              "Read the resource bluepencil://notes first.",
              "1. Read the sections '⚠ open decisions' and '💬 feedback only' before anything else — they constrain the rest.",
              "2. Implement only notes with intent=implement and status=open.",
              "3. For every note you implemented: reply in that note's thread (kind=reply: what changed, where, deviations) and set status=done.",
              "4. For intent=feedback notes: answer with kind=feedback and change nothing, leave the status alone.",
              "5. If something is unclear: kind=decision_request with lettered options and a recommendation, status=needs_decision, then stop and wait.",
              "6. Never invent a human decision and never mark a pending decision as done.",
            ].join("\n"),
          },
        ],
      };
    case "summarise-decisions":
      return {
        content: [
          {
            type: "text",
            text: "Call list_notes with status=needs_decision, then list every note with its id, body, options and recommendation in one table. Do not decide for the human.",
          },
        ],
      };
    default:
      return errorResponse(`unknown prompt "${name}"`);
  }
}

export { createBundle, canonicalBundle };
