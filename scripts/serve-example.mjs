#!/usr/bin/env node
/**
 * Dependency-free static server for the bluepencil examples (NFR-4: no runtime dependencies).
 *
 * It serves the *repository root* so that both artifacts of a build are reachable from one
 * origin: the library build under `/dist/` and the fixture app under `/examples/vanilla/`.
 * That is the whole point of this script — the fixture needs no bundler, no dev server and
 * no network access beyond `localhost`.
 *
 * Usage:
 *   node scripts/serve-example.mjs                    # http://localhost:9283/examples/vanilla/
 *   node scripts/serve-example.mjs --port 8080
 *   node scripts/serve-example.mjs --root /srv/site   # serve another directory tree
 *   node scripts/serve-example.mjs --once             # serve exactly one request, then exit
 *   node scripts/serve-example.mjs --quiet            # do not log every request
 *   node scripts/serve-example.mjs --help
 *
 * `--once` exists for smoke tests and CI: start it, make one request, and the process exits
 * on its own (no stray long-running server, no port to clean up).
 *
 * Exit codes: 0 clean, 1 bad usage, 1 root not readable, 1 port already in use.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 9283;
const HOST = "127.0.0.1";

/** Extension → content type. Everything served here is text or a small image. */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

const args = new Set(process.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
  printUsage();
  process.exit(0);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const port = readPort();
const root = resolve(readOption("--root") ?? repoRoot);
const once = args.has("--once");
const quiet = args.has("--quiet");

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  fail(`--port must be an integer between 0 and 65535, got "${readOption("--port")}"`);
}

try {
  const info = await stat(root);
  if (!info.isDirectory()) fail(`--root is not a directory: ${root}`);
} catch (err) {
  fail(`cannot read --root ${root}: ${err.message}`);
}

const server = createServer((req, res) => {
  handle(req, res)
    .catch((err) => {
      // A response is already on the wire in most cases; the header guard keeps this safe.
      if (!res.headersSent) sendText(res, 500, `internal error: ${err.message}\n`);
      else res.end();
    })
    .finally(() => {
      if (once) {
        // Smoke mode: one request, then a clean, self-terminating exit.
        server.close(() => process.exit(0));
      }
    });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    fail(
      `port ${port} is already in use — another example server is probably running.\n` +
        `Stop it or start this one with a free port: node scripts/serve-example.mjs --port ${port + 1}`,
    );
  }
  fail(err.message);
});

server.listen(port, HOST, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://localhost:${actualPort}/examples/vanilla/`;
  process.stdout.write(
    [
      "",
      "  bluepencil — example server (dependency-free, no network access required)",
      "",
      `  fixture app    ${url}`,
      `  repository     http://localhost:${actualPort}/`,
      `  root           ${root}`,
      "",
      `  library build  ${join(root, "dist")}`,
      "                 if /dist/bluepencil.js is missing, the fixture shows a notice —",
      "                 run `npm run build` once and reload the page.",
      "",
      `  stop with Ctrl+C${once ? " (--once: exits after the first request)" : ""}`,
      "",
    ].join("\n"),
  );
});

/** Route one request to a file below `root`. */
async function handle(req, res) {
  const method = req.method ?? "GET";
  const requestUrl = new URL(req.url ?? "/", `http://${HOST}:${port}`);

  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
    res.end(`method ${method} is not supported by this static server\n`);
    log(method, requestUrl.pathname, 405);
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch {
    sendText(res, 400, "malformed URL encoding\n");
    log(method, requestUrl.pathname, 400);
    return;
  }

  if (pathname.includes("\0")) {
    sendText(res, 400, "malformed path\n");
    log(method, pathname, 400);
    return;
  }

  const target = resolvePath(pathname);
  if (target === null) {
    sendText(res, 403, "path escapes the served root\n");
    log(method, pathname, 403);
    return;
  }

  // The repository root has no index.html; offer a deterministic landing page instead.
  if (pathname === "/" || pathname === "") {
    sendHtml(res, 200, landingPage());
    log(method, pathname, 200, "landing page");
    return;
  }

  let filePath = target;
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) {
      filePath = join(filePath, "index.html");
      await stat(filePath);
    }
  } catch {
    sendHtml(res, 404, notFoundPage(pathname));
    log(method, pathname, 404);
    return;
  }

  const type = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  const info = await stat(filePath);

  res.writeHead(200, {
    "content-type": type,
    "content-length": info.size,
    // A dev server: never let a stale build hide a change.
    "cache-control": "no-store",
  });

  if (method === "HEAD") {
    res.end();
    log(method, pathname, 200, "head");
    return;
  }

  log(method, pathname, 200, filePath.slice(root.length + 1));
  await new Promise((resolveStream, rejectStream) => {
    const stream = createReadStream(filePath);
    stream.on("error", rejectStream);
    stream.on("end", resolveStream);
    stream.pipe(res);
  });
}

/** Map a URL path to a file below `root`, or null when it would escape it. */
function resolvePath(pathname) {
  const normalized = normalize(pathname).replace(/^([/\\])+/, "");
  const candidate = resolve(root, normalized);
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

function sendText(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendHtml(res, status, body) {
  res.writeHead(status, {
    "content-type": MIME[".html"],
    "cache-control": "no-store",
  });
  res.end(body);
}

function notFoundPage(pathname) {
  const hint =
    pathname.startsWith("/dist/")
      ? "<p>The library build is missing. Run <code>npm run build</code> in the repository root.</p>"
      : `<p>Nothing is served at <code>${escapeHtml(pathname)}</code>.</p>`;
  return page(
    "404 — not found",
    `<h1>404</h1>${hint}<p><a href="/examples/vanilla/">Open the fixture app</a></p>`,
  );
}

function landingPage() {
  return page(
    "bluepencil — example server",
    [
      "<h1>bluepencil example server</h1>",
      "<p>This server exposes the repository root, so the fixture app and the library build",
      " share one origin.</p>",
      "<ul>",
      '  <li><a href="/examples/vanilla/">Fixture app (examples/vanilla/)</a> — every FR group,',
      "      one page</li>",
      '  <li><a href="/dist/bluepencil.js">Library build (dist/bluepencil.js)</a> — 404 until',
      "      <code>npm run build</code> has run</li>",
      '  <li><a href="/examples/vanilla/README.md">Fixture README</a></li>',
      '  <li><a href="/CHANGELOG.md">CHANGELOG.md</a></li>',
      "</ul>",
    ].join("\n"),
  );
}

function page(title, body) {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    "<style>body{font:16px/1.5 ui-sans-serif,system-ui,sans-serif;margin:3rem auto;max-width:44rem;padding:0 1.25rem;color:#14181d;background:#f4f5f7}h1{font-size:1.5rem}code{font-family:ui-monospace,Menlo,monospace;background:#e7eaee;padding:.1em .35em;border-radius:4px}a{color:#1d4ed8}</style>",
    "</head><body>",
    body,
    "</body></html>",
    "",
  ].join("\n");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function log(method, pathname, status, detail = "") {
  if (quiet) return;
  process.stdout.write(`  ${status} ${method} ${pathname}${detail ? `  (${detail})` : ""}\n`);
}

function readOption(name) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
}

function readPort() {
  const raw = readOption("--port");
  if (raw === undefined) return DEFAULT_PORT;
  return Number(raw);
}

function printUsage() {
  process.stdout.write(
    [
      "static server for the bluepencil examples (no dependencies)",
      "",
      "usage: node scripts/serve-example.mjs [--port 9283] [--root .] [--once] [--quiet]",
      "",
      "  --port <n>   port to listen on (default 9283, 0 = a free port)",
      "  --root <dir> directory to serve (default: the repository root)",
      "  --once       serve exactly one request and exit (smoke test)",
      "  --quiet      do not log requests",
      "  --help       this text",
      "",
      "The default URL is http://localhost:9283/examples/vanilla/",
      "",
    ].join("\n"),
  );
}

function fail(message) {
  process.stderr.write(`serve-example: ${message}\n`);
  process.exit(1);
}
