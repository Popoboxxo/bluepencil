/**
 * Build the little website the Chrome Web Store privacy-policy field points at.
 *
 * `docs/PRIVACY.md` is the single source. Rendering it here rather than keeping a second copy of the
 * policy in HTML is the whole point: the store treats a disagreement between the dashboard fields, the
 * privacy policy and the extension's behaviour as a violation, and two prose copies of the same policy
 * is the easiest way to produce exactly that disagreement. One source, one render.
 *
 * Output (`site/`, a build artefact — `site/` is gitignored; the `pages` workflow publishes it to the
 * `gh-pages` branch):
 *
 *   site/index.html          a plain landing page: what bluepencil is, and the link to the policy
 *   site/privacy/index.html  the policy, rendered from docs/PRIVACY.md
 *   site/.nojekyll           stops GitHub Pages from swallowing anything it thinks is a Jekyll file
 *
 * The Markdown subset here is deliberately small and matched to the policy's own shape: headings,
 * paragraphs, `-` bullets, **bold**, `code` and links. It is not a Markdown implementation, and it
 * fails loudly (see `assertRendered`) rather than emitting a page that quietly lost a paragraph.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = join(root, "site");

const POLICY_SOURCE = join(root, "docs", "PRIVACY.md");

/** The wording the store's Limited Use policy requires on a page belonging to the extension. */
const LIMITED_USE = "Chrome Web Store User Data Policy";

const STYLE = `
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      font: 16px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif;
      margin: 0 auto; padding: 3rem 1.5rem 5rem; max-width: 44rem;
      background: Canvas; color: CanvasText;
    }
    h1 { font-size: 1.7rem; margin: 0 0 .3rem; letter-spacing: -.01em; }
    h2 { font-size: 1.15rem; margin: 2.2rem 0 .5rem; }
    p, li { color: CanvasText; }
    a { color: LinkText; }
    .lede { color: GrayText; margin: 0 0 2rem; }
    code {
      font: .9em/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
      background: color-mix(in srgb, CanvasText 8%, Canvas); padding: .1em .35em; border-radius: 4px;
    }
    footer {
      margin-top: 3rem; padding-top: 1rem; border-top: 1px solid color-mix(in srgb, CanvasText 18%, Canvas);
      font-size: .9rem; color: GrayText;
    }
`;

function page(title, description, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<style>${STYLE}  </style>
</head>
<body>
${body}
<footer>bluepencil — MIT licensed. <a href="https://github.com/Popoboxxo/bluepencil">Source</a>.</footer>
</body>
</html>
`;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Inline spans, applied to already-escaped text. Order matters: the autolink must see `&lt;…&gt;`. */
function inline(text) {
  return escapeHtml(text)
    .replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (_, url) => `<a href="${url}">${url}</a>`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => `<a href="${url}">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

/** The block subset the policy uses. Anything unrecognised is a paragraph, never dropped. */
function renderMarkdown(markdown) {
  const out = [];
  let paragraph = [];
  let bullets = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) out.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushBullets = () => {
    if (bullets.length > 0) {
      out.push(`<ul>\n${bullets.map((b) => `  <li>${inline(b)}</li>`).join("\n")}\n</ul>`);
    }
    bullets = [];
  };
  const flush = () => {
    flushParagraph();
    flushBullets();
  };

  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      flush();
      continue;
    }
    // A continuation line belongs to whatever block is open: bullets wrap in the source, and so do
    // paragraphs. Starting a new block on a wrapped line would split a sentence in the output.
    if (line.startsWith("- ")) {
      flushParagraph();
      bullets.push(line.slice(2).trim());
      continue;
    }
    if (bullets.length > 0 && /^\s{2,}\S/.test(raw)) {
      bullets[bullets.length - 1] += " " + line.trim();
      continue;
    }
    if (line.startsWith("## ")) {
      flush();
      out.push(`<h2>${inline(line.slice(3))}</h2>`);
      continue;
    }
    if (line.startsWith("# ")) {
      flush();
      out.push(`<h1>${inline(line.slice(2))}</h1>`);
      continue;
    }
    if (paragraph.length > 0 && /^\s{2,}\S/.test(raw)) {
      paragraph[paragraph.length - 1] += " " + line.trim();
      continue;
    }
    flushBullets();
    paragraph.push(line.trim());
  }
  flush();
  return out.join("\n");
}

/**
 * A render that lost the required sentence must not be published: the whole reason this page exists is
 * that sentence, and "the build succeeded, the policy is just missing a paragraph" is precisely the
 * silent failure that turns into a store rejection.
 */
function assertRendered(html) {
  const required = [LIMITED_USE, "Limited Use", "Privacy policy", "<a href="];
  const missing = required.filter((needle) => !html.includes(needle));
  if (missing.length > 0) throw new Error(`privacy page is missing: ${missing.join(", ")}`);
  if (!/<h1>/.test(html) || !/<h2>/.test(html) || !/<p>/.test(html)) {
    throw new Error("privacy page has no rendered heading/paragraph — the Markdown subset broke");
  }
}

const start = Date.now();

const policyMarkdown = await readFile(POLICY_SOURCE, "utf8");
// The `# ` line is rendered, not stripped: it becomes the page's own `<h1>`, so the document outline
// starts where the reader expects and the renderer has a heading to be checked for.
const policyHtml = page(
  "Privacy policy — bluepencil",
  "What the bluepencil browser extension and library store, how they use it, and what they never do.",
  renderMarkdown(policyMarkdown),
);
assertRendered(policyHtml);

const landingHtml = page(
  "bluepencil",
  "A review layer for any web page: annotate an element, keep the note, hand the set to a developer or an agent.",
  `<h1>bluepencil</h1>
<p class="lede">A review layer for any web page.</p>
<p>Click the toolbar button on a page, click the element you want to talk about, and leave a note about
its wording or its appearance. The note is anchored to that element, so it survives a later edit
elsewhere on the page. A set of notes exports as Markdown or JSON and can be handed to a developer or
an AI agent to work off.</p>
<p>Everything stays in your own browser profile: no account, no analytics, no ads, and no browsing
history. Notes leave your machine only if you point bluepencil at a hub URL of your own.</p>
<ul>
  <li><a href="./privacy/">Privacy policy</a> — what is stored, how it is used, what is never done with it</li>
  <li><a href="https://github.com/Popoboxxo/bluepencil">Source code</a> and issue tracker</li>
</ul>`,
);

await mkdir(join(out, "privacy"), { recursive: true });
await writeFile(join(out, "privacy", "index.html"), policyHtml);
await writeFile(join(out, "index.html"), landingHtml);
// GitHub Pages runs Jekyll unless told not to; without this, a path it dislikes is silently dropped.
await writeFile(join(out, ".nojekyll"), "");

console.log(`[site] built -> ${out}`);
console.log(`[site] index.html ${landingHtml.length} B, privacy/index.html ${policyHtml.length} B ` +
  `(from docs/PRIVACY.md, ${policyMarkdown.length} B) in ${Date.now() - start} ms`);
