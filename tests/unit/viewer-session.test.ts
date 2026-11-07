/**
 * @vitest-environment node — pure functions over `ServerRequest`/`HandlerContext`, no DOM needed.
 *
 * Viewer session primitives (spec §2.2 rules 2/3/7, AC-5.13, AC-5.24, AC-5.3, UT-10, UT-21, UT-35):
 * the cookie's exact attribute string, the public-origin derivation with its narrow
 * `X-Forwarded-Proto` trust, the launcher path, and the one refusal message every session rejection
 * uses.
 */
import { describe, expect, it } from "vitest";

import type { HandlerContext } from "../../server/handler";
import {
  publicOrigin,
  sessionCookie,
  viewerSessionRefusalMessage,
  viewerStartPath,
  type ViewerOptions,
} from "../../server/viewer";
import {
  BASE,
  HUB_ORIGIN,
  VIEWER_ORIGIN,
  request,
  viewerContext,
} from "./helpers/viewer-harness";

/** Viewer options without an explicit origin, for the derived-origin matrix. */
function derivedViewer(overrides: Partial<ViewerOptions> = {}): ViewerOptions {
  const { viewer } = viewerContext();
  return { ...viewer, origin: undefined, publicBaseUrl: undefined, ...overrides };
}

/** A viewer context with `hubOrigin` removed (the "no public hub origin" case). */
function withoutHubOrigin(): HandlerContext {
  const context = viewerContext();
  return { ...context, viewer: { ...context.viewer, hubOrigin: undefined } };
}

/** `request()` plus the peer address; the shared harness helper deliberately has no peer field. */
function peerRequest(
  url: string,
  headers: Record<string, string>,
  remote: string,
): ReturnType<typeof request> {
  return { ...request(url, headers), remote };
}

describe("sessionCookie", () => {
  it("renders the exact attribute string without Secure", () => {
    expect(sessionCookie("abc123", { ttlSeconds: 3600, base: BASE, secure: false })).toBe(
      `bp_viewer=abc123; HttpOnly; SameSite=Lax; Path=${BASE}; Max-Age=3600`,
    );
  });

  it("appends Secure exactly when the flag is true", () => {
    const secure = sessionCookie("abc123", { ttlSeconds: 60, base: BASE, secure: true });
    expect(secure).toBe(
      `bp_viewer=abc123; HttpOnly; SameSite=Lax; Path=${BASE}; Max-Age=60; Secure`,
    );
    expect(secure.endsWith("; Secure")).toBe(true);
  });

  it("normalises the path to `/` for an empty or root base", () => {
    expect(sessionCookie("t", { ttlSeconds: 60, base: "", secure: false })).toContain("Path=/;");
    expect(sessionCookie("t", { ttlSeconds: 60, base: "/", secure: false })).toContain("Path=/;");
  });

  it("strips trailing slashes from the path", () => {
    expect(sessionCookie("t", { ttlSeconds: 60, base: `${BASE}/`, secure: false })).toContain(
      `Path=${BASE};`,
    );
  });

  it("never sets Domain and never sets Expires", () => {
    const cookie = sessionCookie("t", { ttlSeconds: 60, base: BASE, secure: true }).toLowerCase();
    expect(cookie).not.toContain("domain");
    expect(cookie).not.toContain("expires");
  });

  it("becomes Secure when the resolved origin is https (publicOrigin → sessionCookie)", () => {
    const origin = publicOrigin(
      request(`${BASE}/viewer`),
      derivedViewer({ origin: "https://view.example.com/" }),
    );
    expect(origin).toBe("https://view.example.com");
    const cookie = sessionCookie("tok", {
      ttlSeconds: 60,
      base: BASE,
      secure: origin.startsWith("https:"),
    });
    expect(cookie.endsWith("; Secure")).toBe(true);
  });
});

describe("viewerStartPath", () => {
  it("appends the launcher path to the normalised base", () => {
    expect(viewerStartPath(BASE)).toBe(`${BASE}/viewer/start`);
    expect(viewerStartPath(`${BASE}/`)).toBe(`${BASE}/viewer/start`);
  });

  it("handles empty and root bases without a double slash", () => {
    expect(viewerStartPath("")).toBe("/viewer/start");
    expect(viewerStartPath("/")).toBe("/viewer/start");
  });
});

describe("publicOrigin", () => {
  it("returns an explicit origin unchanged apart from its trailing slash", () => {
    expect(publicOrigin(request(`${BASE}/viewer`), derivedViewer({ origin: VIEWER_ORIGIN }))).toBe(
      VIEWER_ORIGIN,
    );
    expect(
      publicOrigin(request(`${BASE}/viewer`), derivedViewer({ origin: `${VIEWER_ORIGIN}/` })),
    ).toBe(VIEWER_ORIGIN);
  });

  it("prefers origin over the deprecated publicBaseUrl alias", () => {
    const viewer = derivedViewer({
      origin: "https://view.example.com",
      publicBaseUrl: "http://old.example.com",
    });
    expect(publicOrigin(request(`${BASE}/viewer`), viewer)).toBe("https://view.example.com");
  });

  it("falls back to the deprecated publicBaseUrl alias", () => {
    const viewer = derivedViewer({ publicBaseUrl: "https://legacy.example.com/" });
    expect(publicOrigin(request(`${BASE}/viewer`), viewer)).toBe("https://legacy.example.com");
  });

  it("derives http from the Host header when no origin is configured", () => {
    expect(publicOrigin(request(`${BASE}/viewer`, { host: "hub:8787" }), derivedViewer())).toBe(
      "http://hub:8787",
    );
  });

  it("keeps IPv6 brackets and the port of an IPv6 Host header", () => {
    expect(
      publicOrigin(request(`${BASE}/viewer`, { host: "[::1]:8788" }), derivedViewer()),
    ).toBe("http://[::1]:8788");
  });

  it("falls back to 127.0.0.1 when the request carries no Host", () => {
    expect(publicOrigin(request(`${BASE}/viewer`), derivedViewer())).toBe("http://127.0.0.1");
  });

  it("trusts X-Forwarded-Proto: https from a loopback peer", () => {
    for (const remote of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(
        publicOrigin(
          peerRequest(`${BASE}/viewer`, { host: "view.example.com", "x-forwarded-proto": "https" }, remote),
          derivedViewer(),
        ),
      ).toBe("https://view.example.com");
    }
  });

  it("ignores X-Forwarded-Proto from a non-loopback peer", () => {
    expect(
      publicOrigin(
        peerRequest(
          `${BASE}/viewer`,
          { host: "view.example.com", "x-forwarded-proto": "https" },
          "203.0.113.9",
        ),
        derivedViewer(),
      ),
    ).toBe("http://view.example.com");
  });

  it("ignores X-Forwarded-Proto when the peer is unknown", () => {
    expect(
      publicOrigin(
        request(`${BASE}/viewer`, { host: "view.example.com", "x-forwarded-proto": "https" }),
        derivedViewer(),
      ),
    ).toBe("http://view.example.com");
  });

  it("accepts a case-insensitive, comma-separated X-Forwarded-Proto from loopback", () => {
    expect(
      publicOrigin(
        peerRequest(
          `${BASE}/viewer`,
          { host: "view.example.com", "x-forwarded-proto": "HTTPS, http" },
          "127.0.0.1",
        ),
        derivedViewer(),
      ),
    ).toBe("https://view.example.com");
  });

  it("lets an explicit origin win over X-Forwarded-Proto", () => {
    expect(
      publicOrigin(
        peerRequest(
          `${BASE}/viewer`,
          { host: "view.example.com", "x-forwarded-proto": "http" },
          "127.0.0.1",
        ),
        derivedViewer({ origin: "https://view.example.com" }),
      ),
    ).toBe("https://view.example.com");
  });
});

describe("viewerSessionRefusalMessage", () => {
  it("names the launcher URL when a hubOrigin is set", () => {
    const message = viewerSessionRefusalMessage(viewerContext({ hubOrigin: HUB_ORIGIN }));
    expect(message).toContain(`${HUB_ORIGIN}${BASE}/viewer/start`);
    expect(message).not.toContain("/viewer?k=");
  });

  it("trims a trailing slash from hubOrigin", () => {
    const message = viewerSessionRefusalMessage(viewerContext({ hubOrigin: `${HUB_ORIGIN}/` }));
    expect(message).toContain(`${HUB_ORIGIN}${BASE}/viewer/start`);
    expect(message).not.toContain(`${HUB_ORIGIN}//`);
  });

  it("stays URL-less without a hubOrigin", () => {
    const message = viewerSessionRefusalMessage(withoutHubOrigin());
    expect(message).toContain("open the hub launcher");
    // No constructed http(s) URL — an internal bind address must not leak as a public link.
    expect(message).not.toMatch(/https?:\/\//);
    expect(message).not.toContain("/viewer?k=");
  });

  it("treats an empty hubOrigin as absent", () => {
    const message = viewerSessionRefusalMessage(viewerContext({ hubOrigin: "" }));
    expect(message).toContain("open the hub launcher");
    expect(message).not.toMatch(/https?:\/\//);
  });

  it("uses the normalised base in the launcher path", () => {
    const message = viewerSessionRefusalMessage(
      viewerContext({ base: `${BASE}/`, hubOrigin: HUB_ORIGIN }),
    );
    expect(message).toContain(`${HUB_ORIGIN}${BASE}/viewer/start`);
    expect(message).not.toContain(`${BASE}//viewer/start`);
  });

  it("never returns the old `{base}/viewer?k=` dead end", () => {
    for (const context of [viewerContext(), withoutHubOrigin()]) {
      expect(viewerSessionRefusalMessage(context)).not.toContain("/viewer?k=");
    }
  });

  it("is deterministic for the same context", () => {
    const context = viewerContext();
    expect(viewerSessionRefusalMessage(context)).toBe(viewerSessionRefusalMessage(context));
  });
});
