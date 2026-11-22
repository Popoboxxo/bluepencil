#!/usr/bin/env node
/**
 * End-to-end smoke for the OIDC door: a real hub, a real JWKS endpoint, real RS256 tokens.
 * No vitest, no rolldown, no network beyond loopback — runnable on the minimal CPU in this lab.
 */
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign as signNode } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const AUDIENCE = "bluepencil-smoke";
const KID = "smoke-key";

function freePort() {
  return new Promise((ok, fail) => {
    const server = createTcpServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => ok(port));
    });
  });
}

function sleep(ms) {
  return new Promise((ok) => setTimeout(ok, ms));
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : ""));
}

async function main() {
  const repo = resolve(import.meta.dirname, "..");
  const dist = join(repo, "dist", "server.js");
  const dir = await mkdtemp(join(tmpdir(), "bp-oidc-smoke-"));
  const storePath = join(dir, "notes.bluepencil.json");
  // A bare empty note array is a valid canonical store (the same shape the fixtures use).
  await writeFile(storePath, "[]");

  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = Object.assign({}, pair.publicKey.export({ format: "jwk" }), { kid: KID, alg: "RS256", use: "sig" });
  const issuerPort = await freePort();
  const hubPort = await freePort();
  const issuer = "http://127.0.0.1:" + issuerPort;
  const jwksUrl = issuer + "/jwks";

  const jwksServer = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/.well-known/openid-configuration") {
      response.end(JSON.stringify({ issuer, jwks_uri: jwksUrl }));
    } else if (request.url === "/jwks") {
      response.end(JSON.stringify({ keys: [jwk] }));
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  await new Promise((ok) => jwksServer.listen(issuerPort, "127.0.0.1", ok));

  function token(claims) {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "RS256", typ: "JWT", kid: KID });
    const payload = encode(Object.assign({
      iss: issuer,
      aud: AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 600,
    }, claims));
    const signature = signNode("RSA-SHA256", Buffer.from(header + "." + payload), pair.privateKey).toString("base64url");
    return header + "." + payload + "." + signature;
  }
  const viewer = token({ sub: "user-viewer", roles: ["bp-viewer"] });
  const reviewer = token({ sub: "user-reviewer", roles: ["bp-reviewer"] });
  const wrongAudience = token({ sub: "user-wrong", aud: "someone-else", roles: ["bp-reviewer"] });
  const auth = (value) => ({ authorization: "Bearer " + value });

  const hub = spawn(process.execPath, [
    dist,
    "--store", storePath,
    "--port", String(hubPort),
    "--host", "127.0.0.1",
    "--base", "/bluepencil/api",
    "--environment", "dev",
    "--oidc-issuer", issuer,
    "--oidc-audience", AUDIENCE,
    "--oidc-jwks-url", jwksUrl,
    "--quiet",
  ], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  let hubLog = "";
  hub.stdout.on("data", (chunk) => { hubLog += String(chunk); });
  hub.stderr.on("data", (chunk) => { hubLog += String(chunk); });

  const base = "http://127.0.0.1:" + hubPort + "/bluepencil/api";
  async function request(path, options = {}) {
    const response = await fetch(base + path, options);
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body };
  }

  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const health = await request("/health");
        if (health.status === 200 && health.body && health.body.version) { ready = true; break; }
      } catch { /* not up yet */ }
      await sleep(100);
    }
    check("hub starts with OIDC configured", ready, ready ? "" : hubLog.slice(-400));
    if (!ready) throw new Error("hub did not become ready");

    const anonymous = await request("/notes");
    check("notes without a token are refused", anonymous.status === 401, "status=" + anonymous.status);

    const read = await request("/notes", { headers: auth(viewer) });
    check("viewer OIDC token reads notes", read.status === 200, "status=" + read.status);

    const writeBody = JSON.stringify({
      type: "text",
      body: "oidc-smoke-note",
      anchor: { hook: "x", value: "y" },
    });
    const forbiddenWrite = await request("/notes", {
      method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, auth(viewer)),
      body: writeBody,
    });
    check("viewer OIDC token cannot write", forbiddenWrite.status === 403, "status=" + forbiddenWrite.status);

    const write = await request("/notes", {
      method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, auth(reviewer)),
      body: writeBody,
    });
    check("reviewer OIDC token writes notes", write.status === 200, "status=" + write.status);

    const wrong = await request("/notes", { headers: auth(wrongAudience) });
    check("wrong audience is refused", wrong.status === 401, "status=" + wrong.status);

    const after = await request("/notes", { headers: auth(viewer) });
    const notes = (after.body && after.body.notes) || [];
    check("written note is readable by viewer", notes.some((note) => note.body === "oidc-smoke-note"), "notes=" + notes.length);

    const journal = await request("/journal");
    const entries = (journal.body && journal.body.entries) || [];
    check("journal attributes the write to the OIDC subject",
      entries.some((entry) => String(entry.actor || "").includes("oidc:user-reviewer")),
      "entries=" + entries.length);

    const stored = JSON.parse(await readFile(storePath, "utf8"));
    check("store persisted the note", ((stored.notes) || []).some((note) => note.body === "oidc-smoke-note"));
  } finally {
    hub.kill("SIGTERM");
    await sleep(150);
    if (hub.exitCode === null) hub.kill("SIGKILL");
    await new Promise((ok) => jwksServer.close(ok));
    await rm(dir, { recursive: true, force: true });
  }

  const passed = results.filter((result) => result.ok).length;
  console.log("oidc-smoke: " + passed + "/" + results.length + " case(s) passed");
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
