/**
 * The viewer's page — one embedded string of vanilla HTML/JS, no framework.
 *
 * Same reasoning as `server/admin-html.ts`: the runtime image ships `dist/server.js` and nothing
 * else, so a client framework would be the hub's first client dependency and its largest unreviewed
 * payload — on a page that can proxy arbitrary sites. The page carries no store and no secret: the
 * session token lives in an HttpOnly cookie, and the bookmarklet is rendered *with* the token only
 * because a bookmarklet has to carry it somewhere (documented as a limit).
 */

export interface ViewerHtmlInput {
  /** API base, e.g. `/bluepencil/api` (no trailing slash). */
  base: string;
  /** Public origin of this hub, e.g. `http://hub:8787`. */
  origin: string;
  /** Hosts the viewer may fetch. */
  allow: readonly string[];
  /** Environment the layer writes into. */
  environment: string;
  /** The ready-to-drag bookmarklet, token already substituted when the session came from a header. */
  bookmarklet: string;
}

/** Escapes text for an HTML text node or a double-quoted attribute. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderViewerHtml(input: ViewerHtmlInput): string {
  const allow = input.allow.length === 0
    ? "<li><em>none — set --viewer-allow</em></li>"
    : input.allow.map((entry) => `<li><code>${esc(entry)}</code></li>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bluepencil viewer</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { padding: .6rem .8rem; border-bottom: 1px solid GrayText; display: flex; flex-wrap: wrap;
           gap: .6rem; align-items: center; }
  h1 { font-size: 1rem; margin: 0; font-weight: 600; }
  .meta { color: GrayText; font-size: .85rem; }
  form { display: flex; gap: .4rem; flex: 1 1 22rem; }
  input[type=url] { flex: 1; min-width: 12rem; padding: .35rem .5rem; font: inherit; }
  button { padding: .35rem .7rem; font: inherit; cursor: pointer; }
  main { display: grid; grid-template-rows: 1fr; height: calc(100vh - 3.3rem); }
  iframe { width: 100%; height: 100%; border: 0; background: Canvas; }
  aside { padding: .8rem; overflow: auto; }
  details { margin-top: .8rem; border: 1px solid GrayText; border-radius: 6px; padding: .6rem .8rem; }
  summary { cursor: pointer; font-weight: 600; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; }
  pre { overflow: auto; padding: .6rem; border: 1px solid GrayText; border-radius: 6px; }
  .warn { border-left: 3px solid #b58900; padding-left: .6rem; }
  .row { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
  a.bookmarklet { display: inline-block; padding: .4rem .8rem; border: 1px dashed GrayText;
                  border-radius: 6px; text-decoration: none; font-weight: 600; }
  .hidden { display: none; }
</style>
</head>
<body>
<header>
  <h1>bluepencil viewer</h1>
  <span class="meta">${esc(input.environment)} · ${esc(input.base)}</span>
  <form id="open" autocomplete="off">
    <input id="url" type="url" placeholder="https://…" required>
    <button type="submit">Open</button>
  </form>
</header>
<main>
  <iframe id="view" title="viewer target" src="about:blank"></iframe>
</main>
<aside>
  <details open>
    <summary>Allowed targets</summary>
    <p class="meta">The hub fetches these hosts server-side. Anything else is refused (403) — an open
    URL parameter would be a server-side request forgery door.</p>
    <ul>${allow}</ul>
  </details>

  <details>
    <summary>Bookmarklet — for pages the viewer cannot proxy</summary>
    <p class="meta">Logins, single-page apps and other origins do not survive a proxy. For those, drag
    this link into the bookmarks bar, open the page normally and click it: the layer mounts on the
    real page and writes into this hub.</p>
    <p class="row"><a class="bookmarklet" id="bm" href="${esc(input.bookmarklet)}">bluepencil on this page</a>
      <button type="button" id="copy">Copy</button>
      <span class="meta" id="copied"></span></p>
    <p class="warn">The link carries a session token. It dies with this session, and the page you
    annotate can read it while the session lives — use it on pages you trust.</p>
    <p class="meta">The same artifact without a token: <a href="${esc(input.base)}/viewer/bookmarklet.txt">${esc(input.base)}/viewer/bookmarklet.txt</a></p>
  </details>

  <details>
    <summary>Why some pages look broken</summary>
    <p class="meta">A proxied page runs under this origin, so relative API calls of a foreign app hit
      the hub, logins stay behind, and its own scripts may not find their endpoints. That is the
      documented limit of the proxy path, not a bug of the viewer.</p>
  </details>
</aside>

<script type="module">
  const base = ${JSON.stringify(input.base)};
  const frame = document.getElementById("view");
  const field = document.getElementById("url");
  document.getElementById("open").addEventListener("submit", (event) => {
    event.preventDefault();
    const target = field.value.trim();
    if (target === "") return;
    frame.src = base + "/view?url=" + encodeURIComponent(target);
  });
  document.getElementById("copy").addEventListener("click", async () => {
    const href = document.getElementById("bm").getAttribute("href");
    try {
      await navigator.clipboard.writeText(href);
      document.getElementById("copied").textContent = "copied";
    } catch {
      document.getElementById("copied").textContent = "copy failed — select the link manually";
    }
  });
</script>
</body>
</html>`;
}
