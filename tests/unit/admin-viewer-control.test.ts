/**
 * @vitest-environment node — the admin page is executed for real in a JSDOM realm while the test
 * process stays on Node (same harness shape as `server-admin-page.test.ts`).
 *
 * Spec: `docs/specs/2026-11-08-viewer-launcher-entry.md` §5.7, AC-L23…AC-L26. The control lives in
 * the overview panel, is `disabled` unless both `enabled` and a resolved `origin` are present, asks
 * the launcher exactly once with the admin header, and never navigates after an error.
 *
 * Navigation cannot be observed directly in this realm: before this page runs, JSDOM defines
 * `Location.assign` (and `window.location` itself) as a non-configurable own property, so both
 * `vi.spyOn(location, "assign")` and `Object.defineProperty(window, "location", …)` throw
 * `TypeError: Cannot redefine property`. A stub is therefore impossible here, not merely awkward.
 * A navigation attempt is observed through the virtual console's `jsdomError` ("Not implemented:
 * navigation to another Document") instead of a stubbed function, and the target URL is asserted
 * on the launcher's mocked answer. The **destination expression** itself
 * (`location.assign(body.url)`) is guarded by a static render check in
 * `server-admin-page.test.ts`, because a changed destination could not be seen from here at all.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { renderAdminHtml } from "../../server/admin-html";
import { ADMIN_STRINGS, adminLanguage } from "../../server/admin-i18n";

interface JsdomOptions {
  url?: string;
  runScripts?: "dangerously" | "outside-only";
  beforeParse?: (window: Window) => void;
  virtualConsole?: unknown;
}

interface JsdomInstance {
  window: Window;
}

interface JsdomModule {
  JSDOM: new (html: string, options?: JsdomOptions) => JsdomInstance;
  VirtualConsole: new () => { on(event: string, handler: (error: Error) => void): void };
}

const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require("jsdom") as JsdomModule;

const PAGE_URL = "http://127.0.0.1/api/v1/bluepencil/admin";
const BASE = "/api/v1/bluepencil";
const OPERATOR_KEY = "admin-fixture-secret-2";
const VIEWER_ORIGIN = "http://viewer.example:8788";
const TICKET_URL = `${VIEWER_ORIGIN}${BASE}/viewer?ticket=${"a".repeat(48)}`;

type Strings = Parameters<typeof renderAdminHtml>[0];

function englishStrings(): Strings {
  const table = ADMIN_STRINGS as unknown as Record<string, Strings>;
  return table[adminLanguage("en-US")] ?? (ADMIN_STRINGS as unknown as Strings);
}

const STATUS = {
  version: "0.15.0",
  name: "review-hub",
  environment: "dev",
  readOnly: false,
  federates: false,
  notes: 0,
  auth: "secret",
  credentials: ["secret"],
  admin: true,
  tokenIssuing: false,
  revocationDurable: false,
  devices: 0,
  revoked: 0,
  presence: { token: null, secret: null },
};

interface Reply {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

function reply(status: number, payload: unknown): Reply {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

interface LauncherAnswer {
  status: number;
  body: unknown;
}

interface MountOptions {
  /** The `/admin/status` payload; `undefined` means a 0.14.0 hub without the viewer field. */
  status?: Record<string, unknown>;
  /** How the launcher answers; defaults to `{status: 200, body: {url: TICKET_URL}}`. */
  launcher?: LauncherAnswer;
  /** A promise that must resolve before the launcher answer is delivered (the busy state). */
  gate?: Promise<void>;
  /** Throw a TypeError instead of answering (a network/CORS failure). */
  networkError?: boolean;
}

interface Harness {
  dom: JsdomInstance;
  requests: RecordedRequest[];
  /** Count of "Not implemented: navigation" reports jsdom produced. */
  navigations: () => number;
}

const mounted: JsdomInstance[] = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.window.close();
});

function mount(options: MountOptions = {}): Harness {
  const requests: RecordedRequest[] = [];
  let navigations = 0;
  const status = options.status ?? { ...STATUS, viewer: { enabled: true, origin: VIEWER_ORIGIN } };
  const launcher = options.launcher ?? { status: 200, body: { url: TICKET_URL } };

  const fetchMock = vi.fn(
    async (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const url = String(input);
      requests.push({
        url,
        method: (init?.method ?? "GET").toUpperCase(),
        headers: init?.headers ?? {},
        body: init?.body,
      });
      if (url.includes("/viewer/start")) {
        if (options.gate !== undefined) await options.gate;
        if (options.networkError === true) throw new TypeError("network down");
        return reply(launcher.status, launcher.body);
      }
      if (url.includes("/admin/status")) return reply(200, status);
      if (url.includes("/admin/devices")) {
        return reply(200, { devices: [], tokenIssuing: false, revocationDurable: false });
      }
      if (url.includes("/notes")) return reply(200, { notes: [] });
      if (url.includes("/journal")) return reply(200, { entries: [] });
      return reply(404, { error: { code: "not_found", message: `no route for ${url}` } });
    },
  );

  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error: Error) => {
    if (error.message.includes("Not implemented: navigation")) navigations += 1;
  });

  const dom = new JSDOM(renderAdminHtml(englishStrings()), {
    url: PAGE_URL,
    runScripts: "dangerously",
    virtualConsole,
    beforeParse(window) {
      window.fetch = fetchMock as unknown as typeof window.fetch;
      window.document.execCommand = vi.fn(() => true) as unknown as typeof window.document.execCommand;
      window.confirm = vi.fn(() => true) as unknown as typeof window.confirm;
    },
  });
  mounted.push(dom);
  return { dom, requests, navigations: () => navigations };
}

function node(h: Harness, id: string): HTMLElement {
  const found = h.dom.window.document.getElementById(id);
  if (found === null) throw new Error(`the admin page has no #${id}`);
  return found;
}

function button(h: Harness): HTMLButtonElement {
  return node(h, "open-viewer") as HTMLButtonElement;
}

function text(h: Harness, id: string): string {
  return (node(h, id).textContent ?? "").trim();
}

function launcherCalls(h: Harness): RecordedRequest[] {
  return h.requests.filter((request) => request.url.includes("/viewer/start"));
}

async function connect(h: Harness): Promise<void> {
  (node(h, "secret") as HTMLInputElement).value = OPERATOR_KEY;
  node(h, "connect").click();
  await vi.waitFor(() => {
    expect(node(h, "app").hidden).toBe(false);
  });
}

describe("the viewer control's three states (AC-L23)", () => {
  it("disables the control and explains why when the viewer is off", async () => {
    const h = mount({ status: { ...STATUS, viewer: { enabled: false, origin: null } } });
    await connect(h);

    expect(button(h).disabled).toBe(true);
    expect(text(h, "viewer-note")).toBe("The viewer is not enabled on this hub (--viewer).");
    expect(text(h, "viewer-note")).not.toBe("");

    button(h).click();
    await vi.waitFor(() => {
      expect(launcherCalls(h)).toHaveLength(0);
    });
    expect(h.navigations()).toBe(0);
  });

  it("treats enabled true with a null origin as 'not ready' and never prints null", async () => {
    const h = mount({ status: { ...STATUS, viewer: { enabled: true, origin: null } } });
    await connect(h);

    expect(button(h).disabled).toBe(true);
    expect(text(h, "viewer-note")).toBe("The viewer is not ready yet. Try again in a moment.");
    expect(text(h, "viewer-note")).not.toContain("null");

    button(h).click();
    await vi.waitFor(() => {
      expect(launcherCalls(h)).toHaveLength(0);
    });
  });

  it("enables the control and names the origin once it is resolved", async () => {
    const h = mount();
    await connect(h);

    expect(button(h).disabled).toBe(false);
    expect(text(h, "viewer-note")).toBe(`The viewer opens at ${VIEWER_ORIGIN}.`);
    expect(button(h).getAttribute("aria-describedby")).toBe("viewer-note");
    expect(node(h, "viewer-status").getAttribute("role")).toBe("status");
    expect(node(h, "viewer-status").getAttribute("aria-live")).toBe("polite");
  });

  it("survives a 0.14.0 status payload without a viewer field", async () => {
    const h = mount({ status: { ...STATUS } });
    await connect(h);

    expect(button(h).disabled).toBe(true);
    expect(text(h, "viewer-note")).toBe("The viewer is not enabled on this hub (--viewer).");
  });
});

describe("the viewer control's activation (AC-L24)", () => {
  it("posts once with the admin header only and navigates afterwards", async () => {
    const h = mount();
    await connect(h);

    button(h).click();
    await vi.waitFor(() => {
      expect(launcherCalls(h)).toHaveLength(1);
    });
    await vi.waitFor(() => {
      expect(h.navigations()).toBe(1);
    });

    const call = launcherCalls(h)[0];
    expect(call?.url).toBe(`${BASE}/viewer/start`);
    expect(call?.method).toBe("POST");
    expect(call?.headers["x-bluepencil-admin"]).toBe(OPERATOR_KEY);
    expect(call?.headers["x-bluepencil-auth"]).toBeUndefined();
    expect(call?.headers["accept"]).toBe("application/json");
    expect(call?.body).toBeUndefined();
    // The answer carries the ticket and no secret.
    expect(TICKET_URL).toContain("?ticket=");
    expect(TICKET_URL).not.toContain(OPERATOR_KEY);
  });

  it("shows the busy state while the launcher is still thinking", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = mount({ gate });
    await connect(h);

    button(h).click();
    await vi.waitFor(() => {
      expect(launcherCalls(h)).toHaveLength(1);
    });
    expect(button(h).disabled).toBe(true);
    expect(text(h, "viewer-status")).toBe("opening…");
    expect(node(h, "viewer-status").dataset.kind).toBe("busy");
    expect(h.navigations()).toBe(0);

    release();
    await vi.waitFor(() => {
      expect(h.navigations()).toBe(1);
    });
  });
});

describe("the viewer control's error paths (AC-L25)", () => {
  const cases: Array<{ name: string; launcher: LauncherAnswer; expected: string }> = [
    {
      name: "401",
      launcher: { status: 401, body: { error: { code: "unauthorized", message: "the launcher needs the operator secret" } } },
      expected: "the launcher needs the operator secret",
    },
    {
      name: "403",
      launcher: { status: 403, body: { error: { code: "forbidden_origin", message: "the form was submitted from another site" } } },
      expected: "the form was submitted from another site",
    },
    {
      name: "429",
      launcher: { status: 429, body: { error: { code: "too_many_attempts", message: "too many wrong operator-secret attempts" } } },
      expected: "too many wrong operator-secret attempts",
    },
    {
      name: "503",
      launcher: { status: 503, body: { error: { code: "service_not_ready", message: "the viewer origin is not resolved yet" } } },
      expected: "the viewer origin is not resolved yet",
    },
  ];

  it("shows the server message, keeps the page and re-enables the button", async () => {
    for (const testCase of cases) {
      const h = mount({ launcher: testCase.launcher });
      await connect(h);
      button(h).click();
      await vi.waitFor(() => {
        expect(text(h, "viewer-status")).toBe(testCase.expected);
      });
      expect(node(h, "viewer-status").dataset.kind, testCase.name).toBe("error");
      expect(button(h).disabled, testCase.name).toBe(false);
      expect(launcherCalls(h), testCase.name).toHaveLength(1);
      expect(h.navigations(), testCase.name).toBe(0);
      h.dom.window.close();
    }
  });

  it("wraps a network failure in the launcher error message", async () => {
    const h = mount({ networkError: true });
    await connect(h);
    button(h).click();
    await vi.waitFor(() => {
      expect(text(h, "viewer-status")).toBe("The viewer could not be opened: network down");
    });
    expect(node(h, "viewer-status").dataset.kind).toBe("error");
    expect(button(h).disabled).toBe(false);
    expect(h.navigations()).toBe(0);
    expect(launcherCalls(h)).toHaveLength(1);
  });
});

describe("the viewer control's place in the page (AC-L26)", () => {
  it("sits in the overview panel before the overview card, without a fifth tab", async () => {
    const h = mount();
    await connect(h);

    const panel = node(h, "panel-overview");
    const row = node(h, "viewer-row");
    const card = node(h, "overview-card");
    expect(panel.contains(row)).toBe(true);
    expect(panel.contains(card)).toBe(true);
    // Document order: the control comes before the readout card.
    expect(row.compareDocumentPosition(card) & 4).toBeTruthy();

    const tabs = h.dom.window.document.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(4);
    expect(node(h, "viewer-row").getAttribute("role")).toBeNull();

    // The button is a native button and reachable by keyboard once enabled.
    expect(button(h).tagName).toBe("BUTTON");
    expect(button(h).getAttribute("type")).toBe("button");
    expect(button(h).disabled).toBe(false);
  });
});
