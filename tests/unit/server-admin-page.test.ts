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
  // The local Window slice omits `eval`; the harness uses it to dispatch a realm-local event.
  window: Window & { eval(source: string): unknown };
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
  presence: { token: "2026-10-31T09:05:00.000Z", secret: null, devices: [{ device: "caro-laptop", lastSeenAt: "2026-10-31T09:05:00.000Z", sessionRef: "session-42" }] },
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
  /** Make only the note-creation POST fail with this status; GETs still succeed (#133). */
  notesFailStatus?: number;
  /** A draft left in sessionStorage by an earlier page load (#133). */
  draft?: { body: string; route: string };
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
    if (url.includes('/notes')) {
      if (method === 'POST' && options.notesFailStatus !== undefined) {
        return reply(options.notesFailStatus, {
          error: { code: 'unauthorized', message: 'invalid x-bluepencil-auth — sign in again' },
        });
      }
      return reply(200, { notes: [NOTE] });
    }
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
      if (options.draft) {
        window.sessionStorage.setItem(
          "bluepencil-admin-note-draft",
          JSON.stringify(options.draft),
        );
      }
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

describe("the admin page's presence card", () => {
  it("[#113] renders the last-accepted stamp per credential kind next to the credential rows", async () => {
    const h = mount();
    await connect(h);

    const rows = node(h, "presence-rows");
    // The stamp comes from /admin/status and is rendered in the same local format as the table dates.
    expect(rows.textContent).toContain("2026-10-31 09:05:00");
    // A kind that was never accepted says so instead of showing an empty cell.
    expect(rows.textContent).toContain("not seen since this hub started");
  });

  it("[#113] states the honest limit instead of implying a client list", async () => {
    const h = mount();
    await connect(h);

    const card = node(h, "presence-card");
    expect(card.textContent).toContain("Last accepted credential");
    // #132: the panel explains purpose in the row labels instead of a 512-character paragraph.
    expect(card.textContent).toContain("per device, revocable");
    expect(card.textContent).toContain("one value for all clients");
    expect(ADMIN_STRINGS.en.presenceHelp.length).toBeLessThan(160);
  });
});

/* ------------------------------------------------------------------------------------------------
 * #134 — presence per credential and the drill-down into a session's notes
 * ---------------------------------------------------------------------------------------------- */
describe("the admin page's connected devices", () => {
  it("shows the last-seen stamp and offers the notes of the device's session", async () => {
    const h = mount();
    await connect(h);

    const rows = node(h, "devices-rows");
    expect(rows.textContent).toContain("2026-10-31 09:05:00");
    const button = h.dom.window.document.querySelector("[data-notes-session]");
    expect(button, "a device with a verified token has a session drill-down").not.toBeNull();
    expect(button?.getAttribute("data-notes-session")).toBe("session-42");
    expect(button?.textContent).toContain("notes");

    (button as HTMLElement).click();
    await vi.waitFor(() => {
      expect(node(h, "notes-status").textContent).toContain("session-42");
    });
    expect(
      h.requests.filter((r) => r.url.includes("sessionRef=session-42")),
    ).toHaveLength(1);
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
      "presence-card",
      "presence-rows",
      "mint-result",
      "token-value",
      "copy-token",
      "dismiss-token",
      "token-status",
      "devices-status",
      "notes-body-rows",
      "notes-status",
      "viewer-row",
      "open-viewer",
      "viewer-status",
      "viewer-note",
    ];
    const missing = ids.filter((id) => h.dom.window.document.getElementById(id) === null);
    expect(missing).toEqual([]);
  });

  /**
   * The viewer control's initial state is part of the security story: the static markup ships it
   * `disabled`, so it cannot be clicked before `renderOverview()` decided about readiness (CR-8).
   */
  it("[AC-L23] ships the viewer control disabled in the static markup", () => {
    const markup = renderAdminHtml(englishStrings());
    const button = /<button[^>]*id="open-viewer"[^>]*>/.exec(markup)?.[0] ?? "";
    expect(button).not.toBe("");
    expect(button).toContain("disabled");
  });

  /**
   * `admin-viewer-control.test.ts` cannot stub the navigation — JSDOM makes `Location.assign` and
   * `window.location` non-configurable — so the destination expression is pinned here as a string.
   * Swapping it for `location.href = …` or `window.open(…)` fails this check; the mocked launcher
   * answer alone would not notice.
   */
  it("[AC-L24] navigates with exactly location.assign(body.url)", () => {
    const html = renderAdminHtml(englishStrings());
    expect(html).toContain("location.assign(body.url)");
    expect(html).not.toContain("location.href = body.url");
    expect(html).not.toContain("window.open(body.url");
  });
});

/* ------------------------------------------------------------------------------------------------
 * Admin notes: neutral placeholders and a recoverable 401 (#131, #133)
 * ---------------------------------------------------------------------------------------------- */
describe("the admin page's note workflow regressions", () => {
  it("[#131] uses a neutral device-name example in both locales", () => {
    for (const strings of [ADMIN_STRINGS.en, ADMIN_STRINGS.de]) {
      expect(strings.deviceNamePlaceholder).toContain("laptop-1");
      expect(strings.deviceNamePlaceholder.toLowerCase()).not.toContain("caro");
    }
  });

  it("[#133] restores a draft left in this tab by an earlier page load", () => {
    const h = mount({ draft: { body: "unfiled text after a reload", route: "/settings" } });
    expect(input(h, "note-body").value).toBe("unfiled text after a reload");
    expect(input(h, "note-route").value).toBe("/settings");
  });

  it("[#133] a 401 says the session expired, reopens login and keeps the typed note", async () => {
    const h = mount({ notesFailStatus: 401 });
    await connect(h);

    const draft = "an unfiled note — the operator typed this after the session died";
    input(h, "note-body").value = draft;
    // Dispatch inside the JSDOM realm so the event is that realm's `Event`, not Node's global.
    h.dom.window.eval(
      "document.getElementById('note-body').dispatchEvent(new Event('input', { bubbles: true }))",
    );
    click(h, "note-create");

    await vi.waitFor(() => {
      expect(node(h, "notes-status").textContent).toContain(ADMIN_STRINGS.en.sessionExpired);
    });
    expect(node(h, "login").hidden, "the operator must be able to sign in again").toBe(false);
    expect(node(h, "login-status").textContent).toContain(ADMIN_STRINGS.en.sessionExpired);
    expect(input(h, "note-body").value, "never clear the textarea on a failed save").toBe(draft);
    expect(h.dom.window.sessionStorage.getItem("bluepencil-admin-note-draft")).toContain(draft);
    expect(
      h.requests.filter((r) => r.url.includes("/notes") && r.method === "POST"),
    ).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------------------------------
 * The launcher strings (FR-6.30, spec §5.8) — one table for both pages
 * ---------------------------------------------------------------------------------------------- */

/** The fourteen keys the launcher page and the admin control read. */
const LAUNCHER_KEYS = [
  "launcherTitle",
  "launcherHeading",
  "launcherHelp",
  "launcherSubmit",
  "launcherInvalidSecret",
  "launcherThrottled",
  "launcherForbidden",
  "launcherBodyTooLarge",
  "launcherUnsupportedBody",
  "launcherViewerOff",
  "launcherViewerPending",
  "launcherViewerAt",
  "launcherOpening",
  "launcherError",
] as const;

/** The page's visible text: the inline runtime script is not a user-visible string. */
function visibleMarkup(strings: Strings): string {
  return renderAdminHtml(strings).replace(/<script>[\s\S]*?<\/script>/, "");
}

describe("the launcher strings in the shared admin table", () => {
  it("ships all fourteen keys in both languages", () => {
    for (const lang of ["en", "de"] as const) {
      const table = ADMIN_STRINGS[lang] as unknown as Record<string, unknown>;
      for (const key of LAUNCHER_KEYS) {
        expect(typeof table[key], `${lang}.${key}`).toBe("string");
        expect(String(table[key]).length, `${lang}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the placeholders the two renderers substitute", () => {
    expect(ADMIN_STRINGS.en.launcherThrottled).toContain("{seconds}");
    expect(ADMIN_STRINGS.de.launcherThrottled).toContain("{seconds}");
    expect(ADMIN_STRINGS.en.launcherViewerAt).toContain("{origin}");
    expect(ADMIN_STRINGS.de.launcherViewerAt).toContain("{origin}");
    expect(ADMIN_STRINGS.en.launcherError).toContain("{message}");
    expect(ADMIN_STRINGS.de.launcherError).toContain("{message}");
  });

  it("renders no raw launcher key as visible text", () => {
    for (const lang of ["en", "de"] as const) {
      const markup = visibleMarkup(ADMIN_STRINGS[lang]);
      for (const key of LAUNCHER_KEYS) expect(markup, `${lang}: ${key}`).not.toContain(key);
    }
  });
});
