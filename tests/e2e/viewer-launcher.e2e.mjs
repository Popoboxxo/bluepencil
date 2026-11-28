#!/usr/bin/env node
/**
 * Viewer-launcher browser regression (#163).
 *
 * A native HTML form POST is serialized by Chromium according to the document's Referrer-Policy.
 * `no-referrer` produces `Origin: null`, which the launcher's CSRF gate correctly refuses — and
 * therefore blocks the launcher's own form. `origin` keeps the real Origin header while stripping
 * path and query from the Referer.
 *
 * This suite starts a real hub with a real viewer listener and drives two native form submissions:
 *   1. the hub's own launcher -> the Origin gate passes and an empty secret reaches 401;
 *   2. a foreign-origin form   -> the Origin gate still refuses it with 403.
 *
 * No operator credential is entered. The generated admin secret only arms the test hub and is
 * passed through the environment, never argv or output.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser, findChrome } from "../../scripts/lib/browser.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const serverEntry = join(root, "dist", "server.js");
const elementBundle = join(root, "dist", "bluepencil.element.min.js");
const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const BASE = "/bluepencil/api";
const workspace = join(root, ".tmp", "viewer-launcher-e2e", String(process.pid));
const profile = join(workspace, "chrome-profile");
const STARTUP_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;
const secret = `viewer-launcher-e2e-${randomBytes(18).toString("hex")}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function header(headers, name) {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function detail(text) {
  return String(text).split(secret).join("<redacted>").replace(/\s+/g, " ").trim().slice(0, 400);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function isolatedEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("BLUEPENCIL_")) delete env[key];
  }
  return { ...env, NODE_ENV: "test", ...extra };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const outcome = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve(null), 3_000)),
  ]);
  if (outcome === null) {
    child.kill("SIGKILL");
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve(null), 3_000)),
    ]);
  }
}

async function startHub(hubPort, viewerPort) {
  const store = join(workspace, "notes.json");
  const args = [
    serverEntry,
    "--store", store,
    "--host", "127.0.0.1",
    "--port", String(hubPort),
    "--base", BASE,
    "--environment", "dev",
    "--journal", "none",
    "--viewer",
    "--viewer-port", String(viewerPort),
    "--viewer-origin", `http://127.0.0.1:${viewerPort}`,
    "--viewer-assets", dirname(elementBundle),
    "--viewer-allow", "127.0.0.1",
  ];
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: isolatedEnv({ BLUEPENCIL_ADMIN_SECRET: secret }),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const url = `http://127.0.0.1:${hubPort}${BASE}`;
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let last = "no attempt";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      await stopChild(child);
      throw new Error(`hub exited ${child.exitCode} before /config answered — ${detail(stderr)}`);
    }
    try {
      const response = await fetch(`${url}/config`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        const config = await response.json();
        if (config.version !== packageVersion) {
          await stopChild(child);
          throw new Error(`unexpected hub version: ${config.version}`);
        }
        return { child, url, output: () => `${stdout}\n${stderr}` };
      }
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await stopChild(child);
  throw new Error(`hub did not answer /config within ${STARTUP_TIMEOUT_MS}ms (${last}) — ${detail(stderr)}`);
}

async function startForeignForm(launcherUrl) {
  const port = await freePort();
  const body = `<!doctype html><html><body><form method="post" action="${launcherUrl}"><input name="secret"><button type="submit">Submit</button></form></body></html>`;
  const server = createHttpServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/") {
      response.writeHead(404); response.end("not found"); return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, origin: `http://127.0.0.1:${port}` };
}

async function closeHttpServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

function lastPost(browser, url) {
  return [...browser.networkRequests()].reverse().find((request) => request.method === "POST" && request.url === url);
}

function lastResponse(browser, url) {
  return [...browser.networkResponses()].reverse().find((response) => response.url === url);
}

async function submitAndWait(browser) {
  await browser.evaluate("document.querySelector('input[name=secret]').required = false");
  await browser.click("button[type=submit]");
  await browser.waitFor(
    `document.body.innerText.includes("The operator secret is not valid.") || document.body.innerText.includes("This form was submitted from another site.")`,
    { timeoutMs: 15_000 },
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  return browser.evaluate("document.body.innerText");
}

async function main() {
  if (!existsSync(serverEntry) || !existsSync(elementBundle)) {
    console.error("viewer-launcher-e2e: missing build artifact — run npm run build first");
    process.exit(1);
  }
  const chrome = findChrome();
  if (chrome === null) {
    if (process.env.BP_REQUIRE_BROWSER === "1") {
      console.error("FAIL viewer launcher: BP_REQUIRE_BROWSER=1 but no Chrome was found");
      process.exit(1);
    }
    console.log("SKIP viewer launcher: no Chrome found");
    process.exit(77);
  }

  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const hubPort = await freePort();
  const viewerPort = await freePort();
  let hub;
  let foreign;
  let browser;
  try {
    hub = await startHub(hubPort, viewerPort);
    const launcherUrl = `${hub.url}/viewer/start`;
    const hubOrigin = `http://127.0.0.1:${hubPort}`;
    const viewerOrigin = `http://127.0.0.1:${viewerPort}`;
    foreign = await startForeignForm(launcherUrl);
    browser = await Browser.launch(chrome, profile, { width: 1280, height: 800 });
    await browser.enableNetwork();

    await browser.navigate(launcherUrl);
    await browser.waitForSelector("form");
    const sameText = await submitAndWait(browser);
    const samePost = lastPost(browser, launcherUrl);
    const sameResponse = lastResponse(browser, launcherUrl);
    assert(sameText.includes("The operator secret is not valid."), `own form did not reach secret validation: ${detail(sameText)}`);
    assert(!sameText.includes("This form was submitted from another site."), "own form was refused by the Origin gate");
    assert(header(samePost?.headers, "origin") === hubOrigin, `own form sent Origin ${header(samePost?.headers, "origin") ?? "<missing>"}, expected ${hubOrigin}`);
    assert(sameResponse?.status === 401, `own form returned HTTP ${sameResponse?.status ?? "?"}, expected 401`);
    assert(header(sameResponse?.headers, "referrer-policy") === "origin", "launcher HTML did not carry Referrer-Policy: origin");
    const launcherCsp = String(sameResponse?.headers["content-security-policy"] ?? "");
    assert(launcherCsp.includes(`form-action 'self' ${viewerOrigin}`), `launcher CSP did not allow the configured viewer redirect: ${launcherCsp}`);
    assert(!launcherCsp.includes("form-action *"), "launcher CSP must not wildcard form-action");
    console.log("PASS viewer launcher: native same-origin form keeps its Origin and reaches 401");

    await browser.navigate(`${foreign.origin}/`);
    await browser.waitForSelector("form");
    const foreignText = await submitAndWait(browser);
    const foreignPost = lastPost(browser, launcherUrl);
    const foreignResponse = lastResponse(browser, launcherUrl);
    assert(foreignText.includes("This form was submitted from another site."), `foreign form was not refused: ${detail(foreignText)}`);
    assert(header(foreignPost?.headers, "origin") === foreign.origin, `foreign form sent Origin ${header(foreignPost?.headers, "origin") ?? "<missing>"}, expected ${foreign.origin}`);
    assert(foreignResponse?.status === 403, `foreign form returned HTTP ${foreignResponse?.status ?? "?"}, expected 403`);
    console.log("PASS viewer launcher: foreign-origin form remains blocked with 403");

    await browser.navigate(launcherUrl);
    await browser.waitForSelector("form");
    await browser.evaluate(`(() => { const field = document.querySelector('input[name=secret]'); field.value = ${JSON.stringify(secret)}; field.required = false; return true; })()`);
    await browser.click("button[type=submit]");
    await browser.waitFor(
      `location.origin === ${JSON.stringify(viewerOrigin)} && location.pathname === ${JSON.stringify(`${BASE}/viewer`)}`,
      { timeoutMs: 15_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    const validPost = lastPost(browser, launcherUrl);
    assert(header(validPost?.headers, "origin") === hubOrigin, `valid form sent Origin ${header(validPost?.headers, "origin") ?? "<missing>"}, expected ${hubOrigin}`);
    assert((await browser.evaluate("location.origin")) === viewerOrigin, "browser did not reach the viewer origin");
    const direct = await fetch(launcherUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html", origin: hubOrigin },
      body: `secret=${encodeURIComponent(secret)}`,
      redirect: "manual",
    });
    const directLocation = direct.headers.get("location") ?? "";
    assert(direct.status === 303, `valid form returned HTTP ${direct.status}, expected 303`);
    assert(directLocation.startsWith(`${viewerOrigin}${BASE}/viewer?ticket=`), `valid form did not redirect to the viewer ticket: ${detail(directLocation)}`);
    assert(direct.headers.get("referrer-policy") === "no-referrer", "ticket redirect lost Referrer-Policy: no-referrer");
    console.log("PASS viewer launcher: valid test secret returns 303 and opens the viewer session");

    console.log("viewer-launcher-e2e: 3/3 case(s) passed");
  } catch (error) {
    console.error(`FAIL viewer launcher: ${detail(error instanceof Error ? error.message : String(error))}`);
    if (hub) console.error(`hub output: ${detail(hub.output())}`);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await closeHttpServer(foreign?.server).catch(() => {});
    await stopChild(hub?.child).catch(() => {});
  }
}

await main();
