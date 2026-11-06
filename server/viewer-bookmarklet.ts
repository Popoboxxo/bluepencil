/**
 * The bookmarklet — a **release artifact of its own**, not a snippet buried in a page.
 *
 * Why a separate module: the bookmarklet is the one delivery path that works on pages a proxy cannot
 * carry (logins, SPAs, other origins), so it has exactly the same lifecycle obligation as the
 * extension: one source, version-stamped, shipped with every release and never hand-edited. Keeping
 * it here means (a) the viewer page renders the *same* string the artifact file contains, and (b) a
 * unit test can assert that the paths it hard-codes are still the routes the hub serves — the drift
 * failure that otherwise only shows up when a bookmarklet silently stops writing.
 *
 * The snippet imports the **element build** and appends a `<bluepencil-notes>` element, rather than
 * calling `bluepencil.init()`: `init()` takes no `endpoint`/`headers` (those are element attributes),
 * so the element form is the documented vocabulary that actually reaches the HTTP adapter. This is
 * the arrangement measured end-to-end in issue #140 (note written from a foreign page into a hub
 * store, `adapter: http`).
 */

/**
 * The build version, stamped by esbuild (`--define:__BLUEPENCIL_VERSION__`). The guarded `typeof`
 * keeps `tsc --noEmit` and the unit tests working without that define.
 */
declare const __BLUEPENCIL_VERSION__: string | undefined;

export function viewerVersion(): string {
  return typeof __BLUEPENCIL_VERSION__ === "string" && __BLUEPENCIL_VERSION__.length > 0
    ? __BLUEPENCIL_VERSION__
    : "0.0.0-dev";
}

/** Placeholder the viewer page replaces with the live session token. */
export const BOOKMARKLET_TOKEN_MARKER = "__BP_VIEWER_TOKEN__";

/** The header the injected element sends; must match `VIEWER_HEADER` in `server/viewer.ts`. */
const TOKEN_HEADER = "x-bluepencil-viewer";

export interface BookmarkletInput {
  /** Public origin of the hub, e.g. `http://hub:8787` (no trailing slash). */
  origin: string;
  /** API base, e.g. `/bluepencil/api`. */
  base: string;
  /** Environment the layer writes into. */
  environment: string;
  /** Session token; `BOOKMARKLET_TOKEN_MARKER` when rendering the static artifact. */
  token?: string;
}

/**
 * The `javascript:` URL that mounts the layer on the page it is clicked on.
 *
 * Everything is absolute on purpose: on a foreign page there is no `<base>` and no relative
 * resolution that would find the hub. The token travels as a request header, so the write path does
 * not depend on cookies (a browser does not send a `SameSite=Lax` cookie on a cross-site fetch).
 */
export function bookmarkletSnippet(input: BookmarkletInput): string {
  const token = input.token ?? BOOKMARKLET_TOKEN_MARKER;
  const origin = input.origin.replace(/\/+$/, "");
  const base = input.base.replace(/\/+$/, "");
  const version = viewerVersion();
  const parts = [
    "javascript:(()=>{",
    `var H=${js(origin)},B=${js(base)},T=${js(token)},V=${js(version)};`,
    "var e=document.createElement('bluepencil-notes');",
    "e.setAttribute('endpoint',H+B);",
    `e.setAttribute('headers',JSON.stringify({${js(TOKEN_HEADER)}:T}));`,
    `e.setAttribute('environment',${js(input.environment)});`,
    "e.setAttribute('build-ref',V);",
    "e.setAttribute('enabled','true');",
    "e.setAttribute('language','de');",
    "var s=document.createElement('script');",
    "s.type='module';s.src=H+B+'/viewer/assets/bluepencil.element.min.js';",
    "(document.body||document.documentElement).appendChild(e);",
    "document.head.appendChild(s);",
    "})()",
  ];
  return parts.join("");
}

/** A JS string literal that survives being pasted into a `javascript:` URL. */
function js(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export interface BookmarkletArtifactInput {
  origin: string;
  base: string;
  environment: string;
}

/**
 * The standalone artifact (`{base}/viewer/bookmarklet.txt`).
 *
 * It is text, not a download of an HTML page, so an operator can `curl` it, diff it between
 * releases and paste it into a browser bookmark by hand. The version line is the reason the file
 * exists at all: a bookmarklet with no version is a bookmarklet nobody can tell apart from last
 * year's.
 */
export function bookmarkletTextArtifact(input: BookmarkletArtifactInput): string {
  const version = viewerVersion();
  const snippet = bookmarkletSnippet(input);
  return [
    `bluepencil bookmarklet ${version}`,
    "",
    "Mounts the review layer on the page you are on and writes the notes into the hub below.",
    "Use it for pages the viewer cannot proxy: logins, single-page apps, other origins.",
    "",
    `hub:         ${input.origin}${input.base}`,
    `environment: ${input.environment}`,
    "",
    "Install:",
    "  1. Open the viewer page in the hub and copy the bookmarklet from there — it carries a live",
    "     session token. The snippet below carries the placeholder instead.",
    `  2. Replace ${BOOKMARKLET_TOKEN_MARKER} with a session token, or copy the ready-made link from`,
    "     the viewer page (recommended; the token is minted per session and dies with it).",
    "  3. Drag the resulting javascript: link into the bookmarks bar.",
    "",
    "Limits (documented, not fixable here):",
    "  - a page whose Content-Security-Policy forbids external scripts blocks the loader;",
    "  - a page that reaches a hub needs this origin in connect-src, or the writes are refused;",
    "  - the token is visible to the page you annotate for as long as the session lives.",
    "",
    "snippet:",
    snippet,
    "",
  ].join("\n");
}
