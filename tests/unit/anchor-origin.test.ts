/**
 * @vitest-environment node
 *
 * Issue #135, part 1: the automatic `anchor.origin`, its transport-wide carry, validation and the
 * `?origin=` filter. Part 3's derived session overview is covered in session-overview.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { deriveAnchor } from "../../src/core/anchor";
import { matchesFilter } from "../../src/core/adapter";
import { createNote, type Note, type NoteDraft } from "../../src/core/model";
import { createStore } from "../../src/core/store";
import { createMemoryAdapter } from "../../src/adapters/memory";
import { createBundle } from "../../src/data/bundle";
import { migrateBundle } from "../../src/data/migrate";
import { validateNote } from "../../src/data/schema";
import { createBlueprint } from "../../src/index";
import { aggregateList } from "../../src/federation/aggregate";
import {
  DEFAULT_BASE_PATH,
  handleRequest,
  type HandlerContext,
  type NoteStoreState,
  type ServerRequest,
  type ServerResponse,
} from "../../server/handler";

const ORIGIN = "https://shop-a.de";

function fakeElement(): Element {
  return { tagName: "div", getAttribute: () => null } as unknown as Element;
}

function note(overrides: Partial<NoteDraft> = {}): Note {
  return createNote({
    type: "text",
    body: "body",
    anchor: { hook: "cta", route: "/produkt", origin: ORIGIN },
    now: "2026-11-20T10:00:00.000Z",
    ...overrides,
  });
}

function request(method: string, url: string, body?: unknown): ServerRequest {
  return {
    method,
    url: `${DEFAULT_BASE_PATH}${url}`,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? "" : JSON.stringify(body),
  };
}

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
  return { state, call: (req: ServerRequest): ServerResponse => handleRequest(req, context) };
}

function bodyOf(response: ServerResponse): Record<string, any> {
  return JSON.parse(response.body) as Record<string, any>;
}

describe("anchor.origin at capture time", () => {
  it("is filled from location.origin and never carries a path, query or fragment", () => {
    const anchor = deriveAnchor(fakeElement(), {
      route: "/produkt?token=secret",
      origin: "https://shop-a.de/produkt?access_token=abc#/oauth",
    });
    expect(anchor.origin).toBe(ORIGIN);
    expect(anchor.route).toBe("/produkt?token=secret");
    expect(JSON.stringify(anchor)).not.toContain("access_token");
    expect(JSON.stringify(anchor)).not.toContain("oauth");
  });

  it("keeps old notes readable: no origin means unknown, never an empty string", () => {
    const legacy = createNote({
      type: "text",
      body: "old",
      anchor: { hook: "cta" },
      now: "2026-01-01T00:00:00.000Z",
    });
    expect(legacy.anchor.origin).toBeUndefined();
    expect(validateNote(legacy)).toEqual([]);
    expect(matchesFilter(legacy, { origin: null })).toBe(true);
    expect(matchesFilter(legacy, { origin: ORIGIN })).toBe(false);
  });
});

describe("session strategy through the store", () => {
  it("uses the exact ref for route and leaves the default unchanged", async () => {
    const store = createStore({ adapter: createMemoryAdapter(), sessionRef: "relaunch" });
    const before = await store.create({
      type: "text",
      body: "legacy strategy",
      anchor: { hook: "cta", route: "/produkt", origin: ORIGIN },
    });
    expect(before.sessionRef).toBe("relaunch");

    const composed = createStore({
      adapter: createMemoryAdapter(),
      sessionRef: "relaunch",
      sessionRefFor: (anchor) =>
        `${"relaunch"}@${anchor.origin ?? ""}${anchor.route ?? ""}`,
    });
    const after = await composed.create({
      type: "text",
      body: "new strategy",
      anchor: { hook: "cta", route: "/produkt", origin: ORIGIN },
    });
    expect(after.sessionRef).toBe("relaunch@https://shop-a.de/produkt");
  });

  it("keeps an explicit draft sessionRef under the default strategy", async () => {
    const blueprint = createBlueprint({
      adapter: createMemoryAdapter(),
      sessionStrategy: [{ kind: "given" }],
    });
    const created = await blueprint.store.create({
      type: "text",
      body: "host-supplied round",
      anchor: { hook: "cta", route: "/produkt" },
      sessionRef: "case-6",
    });
    expect(created.sessionRef).toBe("case-6");
    await blueprint.destroy();
  });

  it("createBlueprint wires the parsed strategy and suppresses the label for none", async () => {
    const origin = createBlueprint({ adapter: createMemoryAdapter(), sessionRef: "round" });
    const none = createBlueprint({
      adapter: createMemoryAdapter(),
      sessionRef: "round",
      sessionStrategy: [{ kind: "none" }],
    });
    const draft: NoteDraft = {
      type: "text",
      body: "wired",
      anchor: { hook: "cta", route: "/shop/a", origin: ORIGIN },
    };
    const withRef = await origin.store.create(draft);
    const withoutRef = await none.store.create({ ...draft, anchor: { ...draft.anchor } });
    expect(withRef.sessionRef).toBe("round");
    expect(withoutRef.sessionRef).toBeUndefined();
    await origin.destroy();
    await none.destroy();
  });
});

describe("REST origin validation and filter", () => {
  it("accepts a canonical anchor.origin on create and patch", () => {
    const h = harness([]);
    const created = h.call(
      request("POST", "/notes", {
        type: "text",
        body: "from a shop",
        origin: ORIGIN,
        anchor: { hook: "cta", route: "/produkt", origin: ORIGIN },
      }),
    );
    expect(created.status).toBe(200);
    expect(bodyOf(created).note.anchor.origin).toBe(ORIGIN);

    const id = bodyOf(created).note.id as string;
    const patched = h.call(
      request("PATCH", `/notes/${id}`, { anchor: { hook: "cta", origin: "https://shop-b.de" } }),
    );
    expect(patched.status).toBe(200);
    expect(bodyOf(patched).note.anchor.origin).toBe("https://shop-b.de");
  });

  it("refuses a path, query or fragment in anchor.origin with a named error", () => {
    const h = harness([]);
    for (const origin of [`${ORIGIN}/produkt`, `${ORIGIN}?x=1`, `${ORIGIN}#frag`]) {
      const response = h.call(
        request("POST", "/notes", {
          type: "text",
          body: "bad place",
          anchor: { hook: "cta", origin },
        }),
      );
      expect(response.status).toBe(400);
      expect(bodyOf(response).error.code).toBe("invalid_origin");
    }
    expect(h.state.notes).toHaveLength(0);
  });

  it("filters by origin alone and combined with route and session", () => {
    const notes = [
      note({ id: "n1", sessionRef: "round", anchor: { hook: "a", route: "/produkt", origin: ORIGIN } }),
      note({ id: "n2", sessionRef: "round", anchor: { hook: "b", route: "/produkt", origin: "https://shop-b.de" } }),
      note({ id: "n3", sessionRef: "other", anchor: { hook: "c", route: "/cart", origin: ORIGIN } }),
    ];
    const h = harness(notes);
    const ids = (query: string): string[] =>
      (bodyOf(h.call(request("GET", `/notes?${query}`))).notes as { id: string }[]).map((n) => n.id).sort();
    expect(ids(`origin=${encodeURIComponent(ORIGIN)}`)).toEqual(["n1", "n3"]);
    expect(ids(`origin=${encodeURIComponent(ORIGIN)}&route=%2Fprodukt`)).toEqual(["n1"]);
    expect(ids(`origin=${encodeURIComponent(ORIGIN)}&route=%2Fprodukt&session=round`)).toEqual(["n1"]);
    expect(ids("origin=null")).toEqual([]);
  });
});

describe("origin across transports", () => {
  it("travels through a canonical bundle and an old-bundle migration unchanged", () => {
    const source = note({ sessionRef: "round", origin: ORIGIN });
    const bundle = createBundle([source], { environment: "dev" });
    expect(bundle.notes[0]?.anchor.origin).toBe(ORIGIN);
    const migrated = migrateBundle(JSON.parse(JSON.stringify(bundle)) as unknown);
    expect(migrated.notes[0]?.anchor.origin).toBe(ORIGIN);
  });

  it("stays attached to its instance in a federated aggregate", async () => {
    const result = await aggregateList(
      [{ id: "dev-web", list: async () => [note({ origin: ORIGIN })] }],
      undefined,
      {},
      { includeSelf: false, limit: 10, timeoutMs: 1000 },
    );
    const federated = result.notes[0] as Note & { instance: string };
    expect(federated.instance).toBe("dev-web");
    expect(federated.anchor.origin).toBe(`dev-web/${ORIGIN}`);

    // The federated spelling also survives export/import unchanged.
    const bundle = createBundle([federated], { environment: "dev" });
    expect(validateNote(bundle.notes[0] as Note)).toEqual([]);
    expect(migrateBundle(JSON.parse(JSON.stringify(bundle)) as unknown).notes[0]?.anchor.origin).toBe(
      `dev-web/${ORIGIN}`,
    );
  });
});
