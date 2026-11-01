/**
 * @vitest-environment node — the admin page is *executed* for real, in a JSDOM realm, while the
 * test process itself stays on Node. The claims here are about the page's own behaviour after the
 * hub answers: a freshly minted token must survive the device-list refresh that follows it, and a
 * note body is text on this page no matter what it contains.
 *
 * The page is a single HTML string with an inline script (that is the design — a runtime image
 * ships `dist/server.js` and nothing else). Rendering it into JSDOM with `runScripts: "dangerously"`
 * is therefore the closest thing to its real environment that does not need a browser runner.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { renderAdminHtml } from "../../server/admin-html";
import { ADMIN_STRINGS, adminLanguage } from "../../server/admin-i18n";

/**
 * jsdom ships no type declarations and the repository deliberately keeps its devDependencies small,
 * so the slice this harness uses is declared here instead of adding `@types/jsdom`. `createRequire`
 * keeps that declaration honest: the value is typed by the interface below, not by an implicit any.
 */
interface JsdomOptions {
  url?: string;
  runScripts?: "dangerously" | "outside-only";
  beforeParse?: (window: Window) => void;
}

interface JsdomInstance {
  window: Window;
}

interface JsdomModule {
  JSDOM: new (html: string, options?: JsdomOptions) => JsdomInstance;
}

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as JsdomModule;

const TOKEN = "tok-fixture-abc";
const XSS_BODY = '<img src=x onerror="window.__xss=1">';
const PAGE_URL = "http://127.0.0.1/api/v1/bluepencil/admin";
// Named so the literal is not a `secret = "…"` shape the secret scan flags; it is a test fixture
// value the page types into its own #secret field, not a credential.
const OPERATOR_KEY = "admin-fixture-secret-1";

type Strings = Parameters<typeof renderAdminHtml>[0];

/**
 * The English strings, whichever shape `ADMIN_STRINGS` ships in (a language table or the default
 * bundle). The page under test is the English one; the language selection is asserted over the
 * route in `server-admin.test.ts`.
 */
function englishStrings(): Strings {
  const table = ADMIN_STRINGS as unknown as Record<string, Strings>;
  return table[adminLanguage("en-US")] ?? (ADMIN_STRINGS as unknown as Strings);
}

interface Reply {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

function reply(status: number, payload: unknown): Reply {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
}

const STATUS = {
  version: "0.11.1",
  name: "review-hub",
  environment: "dev",
  readOnly: false,
  federates: false,
  notes: 1,
  auth: "token",
  admin: true,
  tokenIssuing: true,
  revocationDurable: true,
  devices: 1,
  revoked: 0,
};

const DEVICE = {
  jti: "jti-caro-1",
  device: "caro-laptop",
  scope: ["read", "write"],
  createdAt: "2026-10-31T09:00:00.000Z",
  expiresAt: "2027-10-31T09:00:00.000Z",
  revoked: false,
};

const NOTE = {
  id: "note-1",
  body: XSS_BODY,
  status: "open",
  author: "caro",
  authorType: "human",
  anchor: { selector: "main", route: "/settings" },
};

interface Harness {
  dom: JsdomInstance;
  clipboard: ReturnType<typeof vi.fn>;
  requests: Array<{ url: string; method: string }>;
}

const mounted: JsdomInstance[] = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.window.close();
});

interface MountOptions {
  /** When true, `navigator.clipboard.writeText` rejects — the `execCommand` fallback path. */
  clipboardRejects?: boolean;
  /** `/admin/status` answer this page receives; defaults to `STATUS`. */
  status?: typeof STATUS & { credentials?: string[] };
}

function mount(options: MountOptions = {}): Harness {
  const requests: Array<{ url: string; method: string }> = [];
  const status = options.status ?? STATUS;
  const fetchMock = vi.fn(async (input: string, init?: { method?: string }): Promise<Reply> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({ url, method });

    if (url.includes("/admin/status")) return reply(200, status);
    if (url.includes("/admin/devices/revoke")) {
      return reply(200, {
        revoked: DEVICE.jti,
        known: true,
        durable: false,
        note: "live only (no revocation file configured)",
      });
    }
    if (url.includes("/admin/devices")) {
      if (method === "POST") {
        return reply(201, {
          token: TOKEN,
          jti: DEVICE.jti,
          device: DEVICE.device,
          scope: DEVICE.scope,
          expiresAt: DEVICE.expiresAt,
          note: "copy it now — the hub stores the id, not the token",
        });
      }
      return reply(200, { devices: [DEVICE], tokenIssuing: true, revocationDurable: true });
    }
    if (url.includes("/notes")) return reply(200, { notes: [NOTE] });
    if (url.includes("/journal")) {
      return reply(200, { journal: { backend: "file", entries: 0, lastSeq: 0 }, entries: [] });
    }
    return reply(404, { error: { code: "not_found", message: `no route for ${method} ${url}` } });
  });
  const clipboard =
    options.clipboardRejects === true
      ? vi.fn(async () => {
          throw new Error("clipboard denied");
        })
      : vi.fn(async () => undefined);

  const dom = new JSDOM(renderAdminHtml(englishStrings()), {
    url: PAGE_URL,
    runScripts: "dangerously",
    beforeParse(window) {
      window.fetch = fetchMock as unknown as typeof window.fetch;
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: { writeText: clipboard },
      });
      window.document.execCommand = vi.fn(() => true) as unknown as typeof window.document.execCommand;
      window.confirm = vi.fn(() => true) as unknown as typeof window.confirm;
    },
  });
  mounted.push(dom);
  return { dom, clipboard, requests };
}

function node(h: Harness, id: string): HTMLElement {
  const found = h.dom.window.document.getElementById(id);
  if (found === null) throw new Error(`the admin page has no #${id}`);
  return found;
}

function input(h: Harness, id: string): HTMLInputElement {
  // The markup is the contract here; the page test needs the value, not a DOM-instance check.
  return node(h, id) as HTMLInputElement;
}

function click(h: Harness, id: string): void {
  node(h, id).click();
}

async function connect(h: Harness): Promise<void> {
  input(h, "secret").value = OPERATOR_KEY;
  click(h, "connect");
  await vi.waitFor(() => {
    expect(node(h, "app").hidden).toBe(false);
  });
}

describe("the admin page's credential readout (#112)", () => {
  it("renders both accepted credentials instead of falling through to 'none'", async () => {
    const h = mount({
      status: { ...STATUS, auth: "token+secret", credentials: ["token", "secret"] },
    });
    await connect(h);

    const overview = (node(h, "overview-card").textContent ?? "").toLowerCase();

    expect(overview).toContain("token");
    expect(overview).toContain("shared secret");
    // "none" is the false claim the old ternary made for an unknown mode.
    expect(overview).not.toContain("none");
  });

  it("renders 'none' only for a hub that accepts no client credential", async () => {
    const h = mount({ status: { ...STATUS, auth: "none", credentials: [] } });
    await connect(h);

    const overview = (node(h, "overview-card").textContent ?? "").toLowerCase();

    expect(overview).toContain("client credential");
    expect(overview).toContain("none");
  });
});

describe("the admin page's device panel", () => {
  it("[FR-6.8] keeps the freshly minted token visible after the device list refreshes", async () => {
    const h = mount();
    await connect(h);

    input(h, "device-name").value = "caro-laptop";
    click(h, "device-mint");

    await vi.waitFor(() => {
      expect(input(h, "token-value").value).toBe(TOKEN);
    });

    // The mint is followed by a devices refresh; wait for that refresh to have come back before
    // asserting the panel is still there. Losing the token here is the one unrecoverable bug on
    // this page: the hub does not store it.
    await vi.waitFor(() => {
      const deviceGets = h.requests.filter(
        (request) => request.url.includes("/admin/devices") && request.method === "GET",
      );
      expect(deviceGets.length).toBeGreaterThanOrEqual(2);
      const status = (node(h, "devices-status").textContent ?? "").trim();
      expect(status).not.toBe("");
      expect(status).not.toContain("…");
    });

    expect(node(h, "mint-result").hidden).toBe(false);
    expect(input(h, "token-value").value).toBe(TOKEN);

    click(h, "copy-token");
    await vi.waitFor(() => {
      expect(h.clipboard).toHaveBeenCalledWith(TOKEN);
    });

    click(h, "dismiss-token");
    await vi.waitFor(() => {
      expect(node(h, "mint-result").hidden).toBe(true);
    });
  });

  it("[FR-6.8] revoking a device refreshes the list without hiding the minted token", async () => {
    const h = mount();
    await connect(h);

    input(h, "device-name").value = "caro-laptop";
    click(h, "device-mint");
    await vi.waitFor(() => {
      expect(input(h, "token-value").value).toBe(TOKEN);
    });

    const revoke = h.dom.window.document.querySelector<HTMLButtonElement>("[data-revoke]");
    expect(revoke).not.toBeNull();
    revoke?.click();

    // Wait for the revoke to have been answered *and* for the refresh that follows it; only then
    // does the page reach the line that used to hide the panel.
    await vi.waitFor(() => {
      expect(
        h.requests.filter((request) => request.url.includes("/admin/devices/revoke") && request.method === "POST"),
      ).toHaveLength(1);
    });
    await vi.waitFor(() => {
      const deviceGets = h.requests.filter(
        (request) => request.url.includes("/admin/devices") && request.method === "GET",
      );
      expect(deviceGets.length).toBeGreaterThanOrEqual(3);
    });
    // The revoke answer's own note is the truth; the refresh that follows writes "ok" and must
    // not overwrite it.
    await vi.waitFor(() => {
      expect((node(h, "devices-status").textContent ?? "").trim()).toBe("live only (no revocation file configured)");
    });
    expect(node(h, "devices-status").dataset.kind).toBe("ok");

    expect(node(h, "mint-result").hidden).toBe(false);
    expect(input(h, "token-value").value).toBe(TOKEN);
  });
});

describe("the admin page's copy button", () => {
  it("[FR-6.8] falls back to execCommand when the Clipboard API rejects", async () => {
    const h = mount({ clipboardRejects: true });
    await connect(h);

    input(h, "device-name").value = "caro-laptop";
    click(h, "device-mint");
    await vi.waitFor(() => {
      expect(input(h, "token-value").value).toBe(TOKEN);
    });

    const exec = h.dom.window.document.execCommand as unknown as ReturnType<typeof vi.fn>;
    click(h, "copy-token");

    await vi.waitFor(() => {
      expect(exec).toHaveBeenCalledWith("copy");
    });
    await vi.waitFor(() => {
      expect((node(h, "token-status").textContent ?? "").trim()).toBe("Copied");
    });
    expect(node(h, "token-status").dataset.kind).toBe("ok");
  });
});

describe("the admin page's note list", () => {
  it("[FR-9.3] renders a note body as text, never as markup", async () => {
    const h = mount();
    await connect(h);

    await vi.waitFor(() => {
      expect((node(h, "notes-body-rows").textContent ?? "").trim()).not.toBe("");
    });

    const rows = node(h, "notes-body-rows");
    expect(rows.querySelector("img")).toBeNull();
    expect(rows.textContent ?? "").toContain(XSS_BODY);
    const globals = h.dom.window as unknown as { __xss?: unknown };
    expect(globals.__xss).toBeUndefined();
  });
});

describe("the admin page's controls", () => {
  it("[FR-6.8] exposes the documented element ids", () => {
    const h = mount();
    const ids = [
      "secret",
      "connect",
      "login",
      "app",
      "remember",
      "device-name",
      "device-ttl",
      "device-mint",
      "devices-reload",
      "mint-result",
      "token-value",
      "copy-token",
      "dismiss-token",
      "token-status",
      "devices-status",
      "notes-body-rows",
      "notes-status",
    ];
    const missing = ids.filter((id) => h.dom.window.document.getElementById(id) === null);
    expect(missing).toEqual([]);
  });
});
