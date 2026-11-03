/**
 * Optional host permissions (G9, SEC-20) — the pure half of the save flow and the worker refusal.
 *
 * The values under test are the ones that fail silently in a browser: a pattern carrying a port that
 * `chrome.permissions.request` rejects, a `false` from `contains` that cannot distinguish "never
 * asked" from "refused", and a save that proceeds without a grant. Each case is pinned here with
 * plain strings and injected repositories, so the suite needs no browser and no `chrome.*`.
 *
 * The worker wiring (`runHubRequest` → `permissionRefusal` before `fetch`) is B.3b; the options-page
 * save flow consumes `saveInGesture` below and is exercised in the "save in the click context" block.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { saveInGesture } from "../../extension/src/options";
import {
  decideSave,
  hubOriginPattern,
  permissionRefusal,
  permissionState,
  type PermissionState,
} from "../../extension/src/permissions";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OPTIONS_HTML = readFileSync(join(ROOT, "extension/options.html"), "utf8");
const OPTIONS_SOURCE = readFileSync(join(ROOT, "extension/src/options.ts"), "utf8");

/**
 * A stand-in for the two `chrome.permissions` seams, recording the exact strings a real extension
 * would hand to Chrome. `request` and `contains` are separate arrays on purpose: the contract says
 * they receive the **same** string, which is only observable if both sides are recorded.
 */
function permissionHarness(answer: boolean): {
  request(pattern: string): Promise<boolean>;
  contains(pattern: string): Promise<boolean>;
  requested: string[];
  contained: string[];
} {
  const requested: string[] = [];
  const contained: string[] = [];
  return {
    requested,
    contained,
    async request(pattern: string) {
      requested.push(pattern);
      return answer;
    },
    async contains(pattern: string) {
      contained.push(pattern);
      return answer;
    },
  };
}

/** The pattern as a non-null string, so a regression is a clear failure rather than a `null` cast. */
function patternOf(endpoint: string): string {
  const pattern = hubOriginPattern(endpoint);
  if (pattern === null) throw new Error(`expected an origin pattern for ${JSON.stringify(endpoint)}`);
  return pattern;
}

describe("hubOriginPattern", () => {
  it.each([
    ["https://hub.example/api", "https://hub.example/*"],
    ["https://hub.example/api/v1/bluepencil", "https://hub.example/*"],
    ["https://hub.example", "https://hub.example/*"],
    ["http://127.0.0.1:8787/api", "http://127.0.0.1/*"],
    ["http://127.0.0.1:8787/api/v1/bluepencil", "http://127.0.0.1/*"],
    ["http://[::1]:8787/api", "http://[::1]/*"],
    ["https://hub.example:9443/api", "https://hub.example/*"],
    ["http://localhost:3000/", "http://localhost/*"],
    ["https://HUB.Example/API", "https://hub.example/*"],
    ["  http://127.0.0.1:8787/api  ", "http://127.0.0.1/*"],
  ])("maps %s to %s", (endpoint, expected) => {
    expect(hubOriginPattern(endpoint)).toBe(expected);
  });

  it.each([
    ["", "an empty endpoint"],
    ["   ", "a whitespace-only endpoint"],
    ["file:///x", "a file URL"],
    ["ftp://hub.example/api", "a non-HTTP scheme"],
    ["not a url", "an unparsable value"],
    ["https://", "a scheme without a host"],
  ])("returns null for %s (%s)", (endpoint) => {
    expect(hubOriginPattern(endpoint)).toBeNull();
  });

  it("gives a portful endpoint the same pattern as its portless form", () => {
    // Chrome rejects a port inside a match pattern, so the port must not influence the result at
    // all. Comparing against the portless spelling is stronger than scanning for `:<digits>`, which
    // would also match the colons in a bracketed IPv6 host.
    expect(patternOf("http://127.0.0.1:8787/api")).toBe(patternOf("http://127.0.0.1/api"));
    expect(patternOf("https://hub.example:9443/api")).toBe(patternOf("https://hub.example/api"));
    expect(patternOf("http://[::1]:8787/api")).toBe(patternOf("http://[::1]/api"));
  });
});

describe("permissionState", () => {
  it("is granted when contains answers true", () => {
    expect(
      permissionState({ contains: true, pattern: "https://hub.example/*", deniedPatterns: [] }),
    ).toBe("granted");
  });

  it("is unknown when contains is false and this session never refused the pattern", () => {
    expect(
      permissionState({ contains: false, pattern: "https://hub.example/*", deniedPatterns: [] }),
    ).toBe("unknown");
  });

  it("is denied when contains is false and the pattern was refused in this session", () => {
    expect(
      permissionState({
        contains: false,
        pattern: "https://hub.example/*",
        deniedPatterns: ["https://hub.example/*"],
      }),
    ).toBe("denied");
  });

  it("is unknown for a refusal of a different pattern", () => {
    expect(
      permissionState({
        contains: false,
        pattern: "https://hub.example/*",
        deniedPatterns: ["http://127.0.0.1/*"],
      }),
    ).toBe("unknown");
  });

  it("lets a fresh grant win over a stale session refusal", () => {
    expect(
      permissionState({
        contains: true,
        pattern: "https://hub.example/*",
        deniedPatterns: ["https://hub.example/*"],
      }),
    ).toBe("granted");
  });
});

describe("decideSave", () => {
  it("keeps a granted hub origin and asks for nothing", () => {
    expect(
      decideSave({ store: "http", endpoint: "https://hub.example/api", permission: "granted" }),
    ).toEqual({ ok: true, requestOrigin: null });
  });

  it("returns the pattern to request for an unknown hub origin", () => {
    expect(
      decideSave({ store: "http", endpoint: "https://hub.example/api", permission: "unknown" }),
    ).toEqual({ ok: true, requestOrigin: "https://hub.example/*" });
  });

  it("elides the port in the pattern the page has to request", () => {
    expect(
      decideSave({
        store: "http",
        endpoint: "http://127.0.0.1:8787/api",
        permission: "unknown",
      }),
    ).toEqual({ ok: true, requestOrigin: "http://127.0.0.1/*" });
  });

  it("refuses a denied hub origin with a chrome://extensions pointer and performs no save", () => {
    const decision = decideSave({
      store: "http",
      endpoint: "https://hub.example/api",
      permission: "denied",
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("denied must not be saveable");
    expect(decision.code).toBe("permission_denied");
    expect(decision.message).toContain("https://hub.example/*");
    expect(decision.message).toContain("chrome://extensions");

    // The page may not write settings on a non-ok decision — modelled so the "kein set" part of
    // AC-B37 is an assertion, not a comment.
    const writes: unknown[] = [];
    if (decision.ok) writes.push({ endpoint: "https://hub.example/api" });
    expect(writes).toEqual([]);
  });

  it.each(["chromeStorage", "localStorage", "memory"])(
    "needs no grant for the local %s store",
    (store) => {
      for (const permission of ["unknown", "denied", "granted"] as PermissionState[]) {
        expect(decideSave({ store, endpoint: "", permission })).toEqual({
          ok: true,
          requestOrigin: null,
        });
      }
    },
  );

  it.each(["", "   "])("reports missing_endpoint for %j with the http store", (endpoint) => {
    const decision = decideSave({ store: "http", endpoint, permission: "granted" });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("missing endpoint must not be saveable");
    expect(decision.code).toBe("missing_endpoint");
  });

  it.each(["file:///x", "not a url"])("reports invalid_origin for %j", (endpoint) => {
    const decision = decideSave({ store: "http", endpoint, permission: "granted" });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("invalid origin must not be saveable");
    expect(decision.code).toBe("invalid_origin");
  });

  it("validates the endpoint before consulting the permission state", () => {
    const decision = decideSave({ store: "http", endpoint: "file:///x", permission: "denied" });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("invalid origin must not be saveable");
    expect(decision.code).toBe("invalid_origin");
  });
});

describe("permissionRefusal", () => {
  it("returns null for a granted origin, so the worker may fetch", () => {
    expect(permissionRefusal("http://127.0.0.1:8787/api", "granted")).toBeNull();
  });

  it("refuses an unknown origin and names the portless match pattern", () => {
    const refusal = permissionRefusal("http://127.0.0.1:8787/api", "unknown");
    expect(refusal?.code).toBe("permission_missing");
    expect(refusal?.message).toContain("http://127.0.0.1/*");
    expect(refusal?.message).not.toContain(":8787");
  });

  it("refuses a denied origin with the chrome://extensions pointer", () => {
    const refusal = permissionRefusal("http://[::1]:8787/api", "denied");
    expect(refusal?.code).toBe("permission_missing");
    expect(refusal?.message).toContain("http://[::1]/*");
    expect(refusal?.message).toContain("chrome://extensions");
  });

  it("still returns a message for an unparsable endpoint", () => {
    expect(permissionRefusal("", "unknown")?.code).toBe("permission_missing");
    expect(permissionRefusal("not a url", "unknown")?.message).toContain("not a url");
  });
});

describe("request and contains receive the same pattern", () => {
  it.each([
    ["https://hub.example/api", "https://hub.example/*"],
    ["http://127.0.0.1:8787/api", "http://127.0.0.1/*"],
    ["http://[::1]:8787/api", "http://[::1]/*"],
  ])("uses one string for both calls (%s)", async (endpoint, expected) => {
    const pattern = patternOf(endpoint);
    expect(pattern).toBe(expected);

    const harness = permissionHarness(true);
    const state = permissionState({
      contains: await harness.contains(pattern),
      pattern,
      deniedPatterns: [],
    });
    expect(state).toBe("granted");
    await harness.request(pattern);

    expect(harness.contained).toEqual([expected]);
    expect(harness.requested).toEqual([expected]);
  });

  it("feeds a refusal back into permissionState as denied", async () => {
    const pattern = patternOf("https://hub.example/api");
    const harness = permissionHarness(false);
    const refused = await harness.request(pattern);
    expect(refused).toBe(false);

    const state = permissionState({
      contains: await harness.contains(pattern),
      pattern,
      deniedPatterns: refused ? [] : [pattern],
    });
    expect(state).toBe("denied");
    expect(harness.contained).toEqual([pattern]);
    expect(harness.requested).toEqual([pattern]);
    expect(decideSave({ store: "http", endpoint: "https://hub.example/api", permission: state }))
      .toMatchObject({ ok: false, code: "permission_denied" });
  });
});

/**
 * The save flow's ports, as the options page injects them.
 *
 * `request` is recorded synchronously: `saveInGesture` must call it before it returns, which is the
 * only testable form of "inside the click context" without a browser. `persisted` counts writes so
 * "no save" is an assertion on the storage seam, not on a return value alone.
 */
function saveHarness(answer: boolean): {
  requested: string[];
  denied: string[];
  persisted: number;
  ports: {
    request(pattern: string): Promise<boolean>;
    persist(): Promise<void>;
    onDenied(pattern: string): void;
  };
} {
  const requested: string[] = [];
  const denied: string[] = [];
  let persisted = 0;
  return {
    requested,
    denied,
    get persisted() {
      return persisted;
    },
    ports: {
      request(pattern: string) {
        requested.push(pattern);
        return Promise.resolve(answer);
      },
      async persist() {
        persisted += 1;
      },
      onDenied(pattern: string) {
        denied.push(pattern);
      },
    },
  };
}

describe("save in the click context (AC-B19)", () => {
  it("asks for the exact hub pattern before returning, then persists after the grant", async () => {
    const harness = saveHarness(true);
    const pending = saveInGesture(
      { store: "http", endpoint: "https://hub.example/api", permission: "unknown" },
      harness.ports,
    );

    // Synchronous: the request is already recorded while the caller's promise is still pending.
    // This is what keeps `chrome.permissions.request` inside the click's user gesture.
    expect(harness.requested).toEqual(["https://hub.example/*"]);
    expect(harness.persisted).toBe(0);

    await expect(pending).resolves.toEqual({
      ok: true,
      requestOrigin: "https://hub.example/*",
    });
    expect(harness.persisted).toBe(1);
    expect(harness.denied).toEqual([]);
  });

  it.each([
    ["https://hub.example/api", "https://hub.example/*"],
    ["http://127.0.0.1:8787/api", "http://127.0.0.1/*"],
    ["http://[::1]:8787/api", "http://[::1]/*"],
  ])("requests the portless pattern for %s", async (endpoint, expected) => {
    const harness = saveHarness(true);
    await saveInGesture({ store: "http", endpoint, permission: "unknown" }, harness.ports);
    expect(harness.requested).toEqual([expected]);
    expect(harness.persisted).toBe(1);
  });

  it("needs no request and no prompt for an already granted origin", async () => {
    const harness = saveHarness(false);
    await expect(
      saveInGesture(
        { store: "http", endpoint: "https://hub.example/api", permission: "granted" },
        harness.ports,
      ),
    ).resolves.toEqual({ ok: true, requestOrigin: null });
    expect(harness.requested).toEqual([]);
    expect(harness.persisted).toBe(1);
  });

  it("asks nothing and writes nothing for a local store, even with a hub URL on screen", async () => {
    const harness = saveHarness(false);
    await expect(
      saveInGesture(
        { store: "chromeStorage", endpoint: "https://hub.example/api", permission: "unknown" },
        harness.ports,
      ),
    ).resolves.toEqual({ ok: true, requestOrigin: null });
    expect(harness.requested).toEqual([]);
    expect(harness.persisted).toBe(1);
  });

  it("turns a refusal in this click into permission_denied and does not save", async () => {
    const harness = saveHarness(false);
    const result = await saveInGesture(
      { store: "http", endpoint: "https://hub.example/api", permission: "unknown" },
      harness.ports,
    );

    expect(harness.requested).toEqual(["https://hub.example/*"]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a refused permission must not save");
    expect(result.code).toBe("permission_denied");
    expect(result.message).toContain("https://hub.example/*");
    expect(result.message).toContain("chrome://extensions");
    expect(harness.denied).toEqual(["https://hub.example/*"]);
    expect(harness.persisted, "a refused permission must not reach storage").toBe(0);
  });

  it("does not even ask when this session already refused the pattern", async () => {
    const harness = saveHarness(true);
    const result = await saveInGesture(
      { store: "http", endpoint: "https://hub.example/api", permission: "denied" },
      harness.ports,
    );
    expect(harness.requested).toEqual([]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a denied origin must not save");
    expect(result.code).toBe("permission_denied");
    expect(harness.persisted).toBe(0);
  });

  it.each([
    ["", "missing_endpoint"],
    ["   ", "missing_endpoint"],
    ["file:///x", "invalid_origin"],
    ["not a url", "invalid_origin"],
  ])("rejects %j as %s without asking Chrome", async (endpoint, code) => {
    const harness = saveHarness(true);
    const result = await saveInGesture(
      { store: "http", endpoint, permission: "unknown" },
      harness.ports,
    );
    expect(harness.requested).toEqual([]);
    expect(harness.persisted).toBe(0);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error(`${code} must not save`);
    expect(result.code).toBe(code);
  });
});

describe("the options page (B.4)", () => {
  it("no longer offers the per-tab toggle buttons", () => {
    expect(OPTIONS_HTML).not.toContain("turn-on");
    expect(OPTIONS_HTML).not.toContain("turn-off");
    expect(OPTIONS_HTML).not.toContain("toggle-status");
    expect(OPTIONS_SOURCE).not.toContain("wireToggle");
    expect(OPTIONS_SOURCE).not.toContain("bluepencil:toggle");
  });

  it("links the review page that is shipped next to it", () => {
    expect(OPTIONS_HTML).toContain('href="review.html"');
    // A relative link resolves inside the extension package; the page has to be there.
    expect(readFileSync(join(ROOT, "extension/review.html"), "utf8")).toContain("<!doctype html>");
  });

  it("keeps the page script-free beyond its own module and has no inline handlers", () => {
    expect(OPTIONS_HTML).not.toMatch(/\son[a-z]+\s*=/i);
    expect(OPTIONS_HTML).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i);
    // The manifest's extension CSP is what actually enforces `script-src 'self'`.
    const manifest = JSON.parse(readFileSync(join(ROOT, "extension/manifest.json"), "utf8")) as {
      content_security_policy?: { extension_pages?: string };
    };
    expect(manifest.content_security_policy?.extension_pages).toContain("script-src 'self'");
  });

  it("asks for the hub origin from the click path, not from a deferred callback", () => {
    // The mechanism is pinned by the save-flow tests above; this guards the wiring from drifting
    // back to an `await` before the request (which silently loses the gesture).
    expect(OPTIONS_SOURCE).toMatch(/saveInGesture\(/);
    expect(OPTIONS_SOURCE).toMatch(/requestPattern\(pattern\)/);
    // The submit handler and `save_` must not await before the request seam is reached.
    expect(OPTIONS_SOURCE).not.toMatch(/async function save_/);
  });
});
