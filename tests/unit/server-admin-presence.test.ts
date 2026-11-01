/**
 * Client presence (#113) — the honest half of "who is connected".
 *
 * The hub has no client registry: a browser that only reads leaves no trace in the store or the
 * journal. What it *can* observe is the gate, so `server/presence.ts` records when each credential
 * kind (signed token / shared secret) was last accepted. These tests pin the properties that make
 * that signal honest rather than decorative:
 *
 *   - one value per kind, at most one write per minute, memory only;
 *   - stamped on *both* doors (notes API via `authorize`, MCP via the same call) and only on success;
 *   - the admin secret never stamps — it is the operator's bridge, not a client credential;
 *   - the payload carries timestamps, never a credential value;
 *   - the admin page no longer calls the issued-credential registry a list of devices.
 *
 * Everything is asserted against an injected clock: no fake timers, no sleeps, and no state shared
 * between tests (the tracker is per context object, see `presenceOf`).
 */
import { describe, expect, it } from "vitest";
import { renderAdminHtml } from "../../server/admin-html";
import { ADMIN_STRINGS } from "../../server/admin-i18n";
import { handleAdmin } from "../../server/admin";
import {
  handleRequest,
  type HandlerContext,
  type ServerResponse,
  type TokenVerifier,
} from "../../server/handler";
import { handleMcpRoute } from "../../server/mcp";
import { createPresence, presenceOf, PRESENCE_THROTTLE_MS } from "../../server/presence";
import type { StoreFileIo } from "../../src/mcp/tools";

const BASE = "/api/v1/bluepencil";
const START = Date.parse("2026-01-01T00:00:00.000Z");
const CLIENT_CREDENTIAL = "hub-presence-fixture-1";
const ADMIN_CREDENTIAL = "admin-presence-fixture-1";

/** A hand-cranked clock: `advance()` is the only thing that moves time. */
function clock(start: number = START): { now: () => number; advance: (ms: number) => void; set: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    set: (ms: number) => {
      current = ms;
    },
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function hub(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    store: { notes: [] },
    base: BASE,
    environment: "dev",
    now: () => iso(START),
    persist: () => undefined,
    ...overrides,
  };
}

function get(context: HandlerContext, path: string, headers: Record<string, string> = {}): ServerResponse {
  return handleRequest({ method: "GET", url: `${BASE}${path}`, headers }, context);
}

function json(response: ServerResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

function memoryIo(): StoreFileIo {
  return { read: async () => null, write: async () => undefined };
}

describe("the presence tracker", () => {
  it("records the first accepted credential per kind as an ISO-8601 stamp", () => {
    const time = clock();
    const presence = createPresence({ now: time.now });

    expect(presence.snapshot()).toEqual({ token: null, secret: null });

    presence.stamp("secret");
    expect(presence.snapshot()).toEqual({ token: null, secret: iso(START) });

    presence.stamp("token");
    expect(presence.snapshot()).toEqual({ token: iso(START), secret: iso(START) });
  });

  it("keeps the previous stamp while it is younger than a minute — no write, no clock churn", () => {
    const time = clock();
    const presence = createPresence({ now: time.now });

    presence.stamp("token");
    time.advance(PRESENCE_THROTTLE_MS - 1);
    presence.stamp("token");
    expect(presence.snapshot().token).toBe(iso(START));

    // At exactly one minute the window is over and the newer stamp wins.
    time.advance(1);
    presence.stamp("token");
    expect(presence.snapshot().token).toBe(iso(START + PRESENCE_THROTTLE_MS));
  });

  it("throttles per kind, not for both together", () => {
    const time = clock();
    const presence = createPresence({ now: time.now });

    presence.stamp("token");
    time.advance(1_000);
    presence.stamp("secret");

    expect(presence.snapshot()).toEqual({ token: iso(START), secret: iso(START + 1_000) });
  });

  it("keeps the previous stamp when the clock steps backwards", () => {
    const time = clock();
    const presence = createPresence({ now: time.now });

    presence.stamp("secret");
    time.set(START - 5 * PRESENCE_THROTTLE_MS);
    presence.stamp("secret");

    expect(presence.snapshot().secret).toBe(iso(START));
  });

  it("records nothing when the clock is broken (non-finite)", () => {
    const presence = createPresence({ now: () => Number.NaN });
    presence.stamp("token");
    expect(presence.snapshot()).toEqual({ token: null, secret: null });
  });

  it("hands out copies: a snapshot cannot be used to fake presence", () => {
    const presence = createPresence({ now: () => START });
    presence.stamp("token");

    const first = presence.snapshot();
    first.token = iso(START + 1);
    expect(presence.snapshot().token).toBe(iso(START));
  });

  it("keeps two hubs in one process apart (per-context tracker, no module-level state)", () => {
    const one = hub();
    const two = hub();
    presenceOf(one).stamp("token");

    expect(presenceOf(one).snapshot().token).not.toBeNull();
    expect(presenceOf(two).snapshot()).toEqual({ token: null, secret: null });
    // The same context keeps returning the same tracker.
    expect(presenceOf(one)).toBe(presenceOf(one));
  });
});

describe("the gate stamps presence on both doors", () => {
  it("stamps the shared secret on the notes API after a successful check", () => {
    const time = clock();
    const presence = createPresence({ now: time.now });
    const context = hub({ authSecret: CLIENT_CREDENTIAL, presence });

    // `/notes`, not `/health`: the liveness probe is answered before the gate (since 0.11.3, #109),
    // so it never reaches `authorize` and can therefore never stamp a credential as present.
    const allowed = get(context, "/notes", { "x-bluepencil-auth": CLIENT_CREDENTIAL });
    expect(allowed.status).toBe(200);
    expect(presence.snapshot()).toEqual({ token: null, secret: iso(START) });
  });

  it("does not stamp a refused credential", () => {
    const presence = createPresence({ now: () => START });
    const context = hub({ authSecret: CLIENT_CREDENTIAL, presence });

    const refused = get(context, "/notes", { "x-bluepencil-auth": "not-it" });
    expect(refused.status).toBe(401);
    expect(presence.snapshot()).toEqual({ token: null, secret: null });
  });

  it("stamps a verified token, not a refused one", () => {
    const time = clock();
    const presence = createPresence({ now: time.now });
    const accepting: TokenVerifier = () => ({ ok: true, device: "graph-viewer" });
    const acceptingHub = hub({ verifyToken: accepting, presence });

    expect(get(acceptingHub, "/notes", { authorization: "Bearer whatever" }).status).toBe(200);
    expect(presence.snapshot()).toEqual({ token: iso(START), secret: null });

    const other = createPresence({ now: () => START });
    const refusing: TokenVerifier = () => ({ ok: false, reason: "revoked" });
    expect(get(hub({ verifyToken: refusing, presence: other }), "/notes", { authorization: "Bearer whatever" }).status).toBe(401);
    expect(other.snapshot()).toEqual({ token: null, secret: null });
  });

  it("does not stamp on a route answered before the gate — /health stays credential-free", () => {
    const presence = createPresence({ now: () => START });
    const context = hub({ authSecret: CLIENT_CREDENTIAL, presence });

    // #109: the probe is answered before `authorize`, so a credential on it proves nothing.
    expect(get(context, "/health", { "x-bluepencil-auth": CLIENT_CREDENTIAL }).status).toBe(200);
    expect(get(context, "/health", { "x-bluepencil-auth": "not-it" }).status).toBe(200);
    expect(presence.snapshot()).toEqual({ token: null, secret: null });
  });

  it("does not stamp the admin secret — it is the operator's bridge, not a client credential", () => {
    const presence = createPresence({ now: () => START });
    const context = hub({ authSecret: CLIENT_CREDENTIAL, adminSecret: ADMIN_CREDENTIAL, presence });

    const created = handleRequest(
      {
        method: "POST",
        url: `${BASE}/notes`,
        headers: { "x-bluepencil-auth": ADMIN_CREDENTIAL, "content-type": "application/json" },
        body: JSON.stringify({ type: "text", body: "a note", anchor: { selector: "#x", quote: "y" } }),
      },
      context,
    );
    expect(created.status).toBe(200);
    expect(presence.snapshot()).toEqual({ token: null, secret: null });
  });

  it("stamps the MCP door too, so a reader-only agent becomes visible", async () => {
    const time = clock();
    const presence = createPresence({ now: time.now });
    const context = hub({ authSecret: CLIENT_CREDENTIAL, presence });

    const allowed = await handleMcpRoute(
      {
        method: "POST",
        url: `${BASE}/mcp`,
        headers: { "x-bluepencil-auth": CLIENT_CREDENTIAL, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      },
      context,
      memoryIo(),
    );
    expect(allowed?.status).toBe(200);
    expect(presence.snapshot()).toEqual({ token: null, secret: iso(START) });

    const refused = await handleMcpRoute(
      {
        method: "POST",
        url: `${BASE}/mcp`,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      },
      hub({ authSecret: CLIENT_CREDENTIAL }),
      memoryIo(),
    );
    expect(refused?.status).toBe(401);
  });
});

describe("what /admin/status reports", () => {
  function status(context: Partial<HandlerContext>): Record<string, unknown> {
    const response = handleAdmin(
      { method: "GET", url: `${BASE}/admin/status`, headers: { "x-bluepencil-admin": ADMIN_CREDENTIAL } },
      hub({ adminSecret: ADMIN_CREDENTIAL, ...context }),
    );
    if (response === null) throw new Error("the admin surface did not answer");
    expect(response.status).toBe(200);
    return json(response);
  }

  it("adds a presence field and keeps the historical devices key", () => {
    const time = clock();
    const presence = createPresence({ now: time.now });
    presence.stamp("secret");

    const body = status({ presence });
    expect(body.presence).toEqual({ token: null, secret: iso(START) });
    // The key keeps its name for compatibility; it counts issued credentials, not clients.
    expect(body.devices).toBe(0);
  });

  it("reports timestamps only — never a credential value", () => {
    const presence = createPresence({ now: () => START });
    presence.stamp("token");
    const text = JSON.stringify(status({ presence, authSecret: CLIENT_CREDENTIAL }));

    expect(text).toContain(iso(START));
    expect(text).not.toContain(CLIENT_CREDENTIAL);
    expect(text).not.toContain(ADMIN_CREDENTIAL);
  });

  it("reports nulls on a freshly started hub", () => {
    expect(status({}).presence).toEqual({ token: null, secret: null });
  });
});

describe("the admin page's wording", () => {
  const english = renderAdminHtml(ADMIN_STRINGS.en);
  const german = renderAdminHtml(ADMIN_STRINGS.de);

  it("labels the issued-credential count as such, not as devices", () => {
    expect(english).toContain("Issued client credentials");
    expect(english).not.toContain("Devices &amp; keys");
    expect(english).not.toContain("Devices & keys");
    expect(german).toContain("Ausgegebene Client-Credentials");
    expect(german).not.toContain("Geräte &amp; Schlüssel");
  });

  it("states the honest limit next to the credential rows", () => {
    expect(english).toContain('id="presence-heading"');
    expect(english).toContain('id="presence-rows"');
    expect(english).toContain("Readers are not tracked as individual clients");
    expect(german).toContain("Lesende Clients werden nicht als einzelne Clients geführt");
  });
});
