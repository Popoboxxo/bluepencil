/**
 * @vitest-environment node
 *
 * Issue #135, part 3: the derived session overview and its admin view. No new store and no write
 * path — every field is computed from notes that already exist.
 */
import { describe, expect, it, vi } from "vitest";
import { createNote, type Note, type NoteDraft } from "../../src/core/model";
import { summariseSessions } from "../../src/data/sessions";
import { createBundle } from "../../src/data/bundle";
import { renderAdminHtml } from "../../server/admin-html";
import { ADMIN_STRINGS } from "../../server/admin-i18n";
import {
  DEFAULT_BASE_PATH,
  handleRequest,
  type HandlerContext,
  type NoteStoreState,
  type ServerResponse,
} from "../../server/handler";

function note(id: string, overrides: Partial<NoteDraft> = {}): Note {
  return createNote({
    id,
    type: "text",
    body: id,
    anchor: { hook: id },
    now: "2026-11-01T09:00:00.000Z",
    ...overrides,
  });
}

const NOTES: Note[] = [
  note("a", {
    sessionRef: "round@https://shop-a.de",
    origin: "https://shop-a.de",
    anchor: { hook: "a", origin: "https://shop-a.de" },
  }),
  note("b", {
    ...{ messages: [] },
    sessionRef: "round@https://shop-a.de",
    origin: "https://shop-a.de",
    anchor: { hook: "b", origin: "https://shop-a.de" },
    status: "done",
    now: "2026-11-03T12:00:00.000Z",
  }),
  note("c", {
    sessionRef: "round@https://shop-a.de",
    origin: "https://shop-b.de",
    anchor: { hook: "c", origin: "https://shop-b.de" },
    now: "2026-11-02T10:00:00.000Z",
  }),
  note("old", { now: "2026-10-01T08:00:00.000Z" }),
];

function harness(notes: Note[]) {
  const state: NoteStoreState = { notes: [...notes] };
  const context: HandlerContext = {
    store: state,
    base: DEFAULT_BASE_PATH,
    environment: "dev",
    readOnly: false,
    allowEnvMismatch: false,
    appName: "test-app",
    now: () => "2026-11-20T11:00:00.000Z",
    persist: vi.fn(),
  };
  const call = (url: string): ServerResponse =>
    handleRequest({ method: "GET", url: `${DEFAULT_BASE_PATH}${url}`, headers: {}, body: "" }, context);
  return { call };
}

describe("summariseSessions", () => {
  it("derives origins, firstSeen, lastSeen and status counts from the notes", () => {
    const [summary] = summariseSessions(NOTES);
    expect(summary).toMatchObject({
      ref: "round@https://shop-a.de",
      label: "round@https://shop-a.de",
      createdAt: "2026-11-01T09:00:00.000Z",
      firstSeen: "2026-11-01T09:00:00.000Z",
      lastSeen: "2026-11-03T12:00:00.000Z",
      origins: ["https://shop-a.de", "https://shop-b.de"],
      notes: { total: 3, open: 2, done: 1 },
    });
  });

  it("ignores notes without a session and reports unknown origins as an empty list", () => {
    expect(summariseSessions(NOTES)).toHaveLength(1);
    expect(summariseSessions([note("old")])).toEqual([]);
    expect(summariseSessions([note("x", { sessionRef: "s" })])[0]?.origins).toEqual([]);
  });

  it("is derived — it never writes to the notes it reads", () => {
    const copy = NOTES.map((n) => ({ ...n, anchor: { ...n.anchor } }));
    summariseSessions(copy);
    expect(copy).toEqual(NOTES);
  });
});

describe("GET /sessions and bundle sessions", () => {
  it("serves the enriched entries", () => {
    const response = harness(NOTES).call("/sessions");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).sessions).toEqual(summariseSessions(NOTES));
  });

  it("carries the same enriched sessions in the hub bundle", () => {
    const response = harness(NOTES).call("/bundle");
    expect(response.status).toBe(200);
    const sessions = JSON.parse(response.body).sessions;
    expect(sessions).toEqual(summariseSessions(NOTES));
  });

  it("keeps the original three-field shape for library callers and old bundles", () => {
    const bundle = createBundle([note("x", { sessionRef: "s" })], { environment: "dev" });
    expect(bundle.sessions).toEqual([
      { ref: "s", label: "s", createdAt: "2026-11-01T09:00:00.000Z" },
    ]);
  });
});

describe("admin Sessions view", () => {
  const strings = ADMIN_STRINGS.en;

  it("has a Sessions tab, a filter and the enriched table columns", () => {
    const html = renderAdminHtml(strings);
    for (const marker of [
      'data-tab="sessions"',
      'id="panel-sessions"',
      'id="session-filter"',
      'id="sessions-rows"',
      strings.colOrigins,
      strings.colFirstSeen,
      strings.colLastSeen,
      strings.purgeButton,
    ]) {
      expect(html).toContain(marker);
    }
  });

  it("shows an origin column and filter in the Notes tab", () => {
    const html = renderAdminHtml(strings);
    expect(html).toContain('id="note-origin"');
    expect(html).toContain(strings.colOrigin);
  });

  it("both shipped languages carry every Sessions string", () => {
    for (const lang of ["en", "de"] as const) {
      const table = ADMIN_STRINGS[lang];
      expect(table.tabSessions.length).toBeGreaterThan(0);
      expect(table.sessionsHelp.length).toBeGreaterThan(0);
      expect(table.purgeConfirm).toContain("{ref}");
    }
  });
});
