/**
 * @vitest-environment node — the pure handler, but the sibling auth suite runs in node as well.
 *
 * The surface seam of 0.14.0 (spec §2.1): one total `surfaceOf()`, one path normalisation and the
 * two path refusals that enforce the surface split.
 *
 * What this file pins, and why each part is load-bearing:
 *
 *   - `surfaceOf()` is total. A context without a surface (embedded hosts, every 0.13.0 unit test)
 *     is the hub, and an unknown string is the hub too — a security switch must not have a third
 *     state that falls through to "allow".
 *   - `normalizeSurfacePath()` decodes exactly once, then resolves `.`/`..`, drops empty segments and
 *     the trailing slash. A second decode would let `%252e%252e` become `..` *after* the refusal
 *     looked at it; a missing resolution would let `{base}/x/../admin` slip past the viewer refusal.
 *   - `hubViewerPathRefusal()` answers 404 on the hub for the viewer content routes so `--root` can
 *     never serve an `index.html` under a viewer path; `{base}/viewer/start` stays reachable
 *     (launcher).
 *   - `viewerSurfaceRefusal()` answers 404 on the viewer for admin/MCP/journal/config/start and
 *     everything outside `{base}`, and leaves the viewer API (shell, `/view`, assets, bookmarklet,
 *     notes*, sessions, bundle, health) alone.
 *
 * The matrix is written as data because the failure that matters is "one entry in the list was
 * forgotten", not "one call answered wrong".
 */
import { describe, expect, it } from "vitest";
import {
  hubViewerPathRefusal,
  normalizeSurfacePath,
  surfaceOf,
  viewerSurfaceRefusal,
  type HandlerContext,
  type ServerResponse,
} from "../../server/handler";

const BASE = "/api/v1/bluepencil";

function context(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return { store: { notes: [] }, base: BASE, environment: "dev", ...overrides };
}

function get(url: string): { url: string } {
  return { url };
}

function parsed(response: ServerResponse): { error: { code: string; message: string } } {
  return JSON.parse(response.body) as { error: { code: string; message: string } };
}

/* ------------------------------------------------------------------------------------------------
 * surfaceOf (spec §2.1 rule 1)
 * ---------------------------------------------------------------------------------------------- */

describe("surfaceOf", () => {
  it('is "viewer" only for the explicit viewer surface', () => {
    expect(surfaceOf(context({ surface: "viewer" }))).toBe("viewer");
  });

  it('defaults every other context to "hub" — including no surface at all', () => {
    expect(surfaceOf(context())).toBe("hub");
    expect(surfaceOf(context({ surface: "hub" }))).toBe("hub");
    // A value outside the union must not become a third, ungated state.
    expect(surfaceOf(context({ surface: "elsewhere" as HandlerContext["surface"] }))).toBe("hub");
  });
});

/* ------------------------------------------------------------------------------------------------
 * normalizeSurfacePath (UT-25, spec §2.1 rule 4)
 * ---------------------------------------------------------------------------------------------- */

describe("normalizeSurfacePath", () => {
  it("keeps a plain path and strips the query", () => {
    expect(normalizeSurfacePath(`${BASE}/notes`)).toBe(`${BASE}/notes`);
    expect(normalizeSurfacePath(`${BASE}/notes?intent=x&y=1`)).toBe(`${BASE}/notes`);
  });

  it("drops duplicate and trailing slashes", () => {
    expect(normalizeSurfacePath(`${BASE}//notes//`)).toBe(`${BASE}/notes`);
    expect(normalizeSurfacePath(`${BASE}/`)).toBe(BASE);
    expect(normalizeSurfacePath("/")).toBe("/");
  });

  it('resolves "." and ".." segments', () => {
    expect(normalizeSurfacePath(`${BASE}/./notes`)).toBe(`${BASE}/notes`);
    expect(normalizeSurfacePath(`${BASE}/x/../notes`)).toBe(`${BASE}/notes`);
    // Never a "." or ".." segment in the result.
    expect(normalizeSurfacePath(`${BASE}/x/y/../../notes`)).toBe(`${BASE}/notes`);
  });

  it("decodes percent-encoded dot segments before resolving them", () => {
    expect(normalizeSurfacePath(`${BASE}/%2e%2e/admin`)).toBe("/api/v1/admin");
    expect(normalizeSurfacePath(`${BASE}/x/%2E%2E/%2e./admin`)).toBe("/api/v1/admin");
    // Enough ".." to climb out of the root stays at the root, never above it.
    expect(normalizeSurfacePath("/%2e%2e/%2e%2e/%2e%2e/admin")).toBe("/admin");
  });

  it("decodes exactly once — a double-encoded dot segment is not a dot segment", () => {
    // Percent-decoding twice would turn %252e into "." and let this escape the refusal. The single
    // decode leaves "%2e" as a literal segment name, which no rule resolves.
    expect(normalizeSurfacePath("/a/%252e%252e/b")).toBe("/a/%2e%2e/b");
  });

  it("reads only the path of an absolute request target", () => {
    expect(normalizeSurfacePath(`http://evil.example${BASE}/notes`)).toBe(`${BASE}/notes`);
  });

  it("returns null only for an unparseable URL part", () => {
    expect(normalizeSurfacePath("http://[::")).toBeNull();
    // A stray percent escape is not a path this hub can reason about.
    expect(normalizeSurfacePath("/%ZZ")).toBeNull();
  });
});

/* ------------------------------------------------------------------------------------------------
 * hubViewerPathRefusal (spec §2.1 rule 9)
 * ---------------------------------------------------------------------------------------------- */

describe("hubViewerPathRefusal", () => {
  const hub = context({ surface: "hub" });

  /** The viewer content routes, in both spellings, that `--root` must never answer. */
  const blocked = [
    `${BASE}/viewer`,
    `${BASE}/view`,
    `${BASE}/viewer/assets/bluepencil.element.min.js`,
    `${BASE}/viewer/bookmarklet.txt`,
    "/viewer",
    "/view",
    "/viewer/assets/bluepencil.element.min.js",
    "/viewer/bookmarklet.txt",
  ];

  for (const path of blocked) {
    it(`answers 404 not_found for ${path} on the hub`, () => {
      const response = hubViewerPathRefusal(get(path), hub);
      expect(response?.status).toBe(404);
      expect(parsed(response as ServerResponse).error.code).toBe("not_found");
    });
  }

  it("leaves the launcher {base}/viewer/start alone", () => {
    expect(hubViewerPathRefusal(get(`${BASE}/viewer/start`), hub)).toBeNull();
  });

  it("leaves note, health and unrelated static paths alone", () => {
    for (const path of [`${BASE}/notes`, `${BASE}/health`, "/index.html", "/assets/app.js", "/"]) {
      expect(hubViewerPathRefusal(get(path), hub), path).toBeNull();
    }
  });

  it("is idempotent", () => {
    const first = hubViewerPathRefusal(get(`${BASE}/viewer`), hub);
    const second = hubViewerPathRefusal(get(`${BASE}/viewer`), hub);
    expect(first?.status).toBe(second?.status);
    expect(first?.body).toBe(second?.body);
  });

  it("sees through dot-segment disguises", () => {
    expect(hubViewerPathRefusal(get(`${BASE}/x/../viewer`), hub)?.status).toBe(404);
    expect(hubViewerPathRefusal(get(`${BASE}/x/%2e%2e/viewer/assets/a.js`), hub)?.status).toBe(404);
  });

  it("never refuses anything on the viewer surface", () => {
    const viewer = context({ surface: "viewer" });
    for (const path of blocked) {
      expect(hubViewerPathRefusal(get(path), viewer), path).toBeNull();
    }
  });
});

/* ------------------------------------------------------------------------------------------------
 * viewerSurfaceRefusal (UT-17, spec §2.1 rule 10)
 * ---------------------------------------------------------------------------------------------- */

describe("viewerSurfaceRefusal", () => {
  const viewer = context({ surface: "viewer" });

  /** Everything the viewer origin must not serve, plus paths outside the API base. */
  const blocked = [
    `${BASE}/admin`,
    `${BASE}/admin/status`,
    `${BASE}/mcp`,
    `${BASE}/mcp/`,
    `${BASE}/journal`,
    `${BASE}/config`,
    `${BASE}/viewer/start`,
    // Outside {base}: the static `--root` fallback and anything else.
    "/",
    "/index.html",
    "/assets/app.js",
    "/other/api",
    // Same prefix, different segment: the segment boundary decides.
    `${BASE}x/admin`,
  ];

  for (const path of blocked) {
    it(`answers 404 not_found for ${path} on the viewer`, () => {
      const response = viewerSurfaceRefusal(get(path), viewer);
      expect(response?.status, path).toBe(404);
      expect(parsed(response as ServerResponse).error.code).toBe("not_found");
    });
  }

  /** The viewer API — the complete allow list from the spec. */
  const allowed = [
    `${BASE}/viewer`,
    `${BASE}/view`,
    `${BASE}/viewer/assets/bluepencil.element.js`,
    `${BASE}/viewer/bookmarklet.txt`,
    `${BASE}/notes`,
    `${BASE}/notes/n-1`,
    `${BASE}/notes/n-1/messages`,
    `${BASE}/notes/bulk-delete`,
    `${BASE}/sessions`,
    `${BASE}/bundle`,
    `${BASE}/health`,
    // {base} itself is neither a viewer route nor outside the base: the unknown-path 404 answers.
    BASE,
  ];

  for (const path of allowed) {
    it(`leaves ${path} alone on the viewer`, () => {
      expect(viewerSurfaceRefusal(get(path), viewer)).toBeNull();
    });
  }

  it("is idempotent", () => {
    const first = viewerSurfaceRefusal(get(`${BASE}/admin`), viewer);
    const second = viewerSurfaceRefusal(get(`${BASE}/admin`), viewer);
    expect(first?.status).toBe(second?.status);
    expect(first?.body).toBe(second?.body);
  });

  it("sees through dot-segment disguises", () => {
    // Without normalisation each of these would miss the admin/config rules.
    expect(viewerSurfaceRefusal(get(`${BASE}/x/../admin`), viewer)?.status).toBe(404);
    expect(viewerSurfaceRefusal(get(`${BASE}/x/%2e%2e/%2e%2e/journal`), viewer)?.status).toBe(404);
    expect(viewerSurfaceRefusal(get(`${BASE}/notes/../../config`), viewer)?.status).toBe(404);
  });

  it("fails closed on an unparseable URL part instead of guessing", () => {
    expect(viewerSurfaceRefusal(get("/%ZZ"), viewer)?.status).toBe(404);
  });

  it("never refuses anything on the hub surface", () => {
    const hub = context({ surface: "hub" });
    for (const path of blocked) {
      expect(viewerSurfaceRefusal(get(path), hub), path).toBeNull();
    }
  });
});
