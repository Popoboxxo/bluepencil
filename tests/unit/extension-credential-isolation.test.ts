/**
 * Credential isolation — the page never holds the hub credential (SEC-14, AC-B13/B14/B15/B20).
 *
 * Four surfaces could carry it, and each is pinned here so the boundary commit cannot regress one
 * while the other three stay green:
 *
 *  1. the page-side relay (`createPageFetch`) — drops `authorization`/`x-bluepencil-auth` in any
 *     spelling;
 *  2. the page-facing config/attributes (`pageSettingsFor`, `elementAttributesFor`) — no `token*`,
 *     no `tokenExpiresAt`, no `deviceName`, no `auth` attribute;
 *  3. the worker (`sw.ts`) — attaches the header itself and wires the permission gate's two deps;
 *  4. the hops in between (`bridge-fetch.ts`, `storage-relay.ts`) — hold no credential at all.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createPageFetch, createPendingReplies, type PageRelayWindow } from "../../extension/src/page-relay";
import { HUB_FETCH_HEADERS } from "../../extension/src/hub-fetch";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relative: string): string => readFileSync(join(ROOT, relative), "utf8");

const SW_SOURCE = source("extension/src/sw.ts");
const HANDOFF_SOURCE = source("extension/src/handoff.ts");
const BRIDGE_FETCH_SOURCE = source("extension/src/bridge-fetch.ts");
const STORAGE_RELAY_SOURCE = source("extension/src/storage-relay.ts");
const BOOTSTRAP_SOURCE = source("extension/src/bootstrap.ts");

interface Recorder extends PageRelayWindow {
  posted: unknown[];
  fire(data: unknown): void;
}

/** A window that records `postMessage` and lets a test deliver the bridge's answer. */
function recorder(): Recorder {
  const posted: unknown[] = [];
  let listener: ((event: MessageEvent) => void) | undefined;
  const target = {
    location: { origin: "https://page.example" },
    posted,
    addEventListener(_type: "message", cb: (event: MessageEvent) => void) {
      listener = cb;
    },
    postMessage(message: unknown) {
      posted.push(message);
    },
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    fire(data: unknown) {
      listener?.({ source: target, data } as unknown as MessageEvent);
    },
  };
  return target as Recorder;
}

async function relayedRequest(headers: Record<string, string>): Promise<Record<string, string>> {
  const target = recorder();
  const pending = createPendingReplies(target);
  let sequence = 0;
  const fetchImpl = createPageFetch(pending, {
    target,
    nextRequestId: () => `bp-fetch-${++sequence}`,
  });

  const promise = fetchImpl("http://127.0.0.1:8787/api/v1/bluepencil/notes", { headers });
  const envelope = target.posted[0] as { requestId: string };
  target.fire({
    source: "bluepencil-page",
    requestId: envelope.requestId,
    reply: { ok: true, status: 200, statusText: "OK", headers: {}, body: "{}" },
  });
  await promise;
  return (target.posted[0] as { request: { headers: Record<string, string> } }).request.headers;
}

describe("page relay — a page request never carries a credential (AC-B14)", () => {
  it("strips authorization and x-bluepencil-auth, case-insensitively", async () => {
    const headers = await relayedRequest({
      Accept: "application/json",
      Authorization: "Bearer page-supplied",
      "X-Bluepencil-Auth": "page-supplied",
      authorization: "Bearer lower-case",
    });
    expect(headers).toEqual({ Accept: "application/json" });
  });

  it("keeps the headers a page may legitimately send", async () => {
    expect(await relayedRequest({ accept: "application/json", "content-type": "application/json" }))
      .toEqual({ accept: "application/json", "content-type": "application/json" });
  });

  it("never allowlists a credential header in the worker (AC-B14)", () => {
    expect([...HUB_FETCH_HEADERS]).not.toContain("authorization");
    expect([...HUB_FETCH_HEADERS]).not.toContain("x-bluepencil-auth");
  });
});

describe("page-facing surfaces — no credential leaves the extension (AC-B15)", () => {
  it("has no re-export of the credential module any more", () => {
    // The boundary commit deleted `export { authHeadersFor, configuredCredential, credentialHeaderFor }`.
    expect(HANDOFF_SOURCE).not.toMatch(/export \{[^}]*credential/i);
    expect(HANDOFF_SOURCE).not.toMatch(/from "\.\/credential"/);
  });

  it("writes no token attribute from the bootstrap", () => {
    expect(BOOTSTRAP_SOURCE).not.toMatch(/token-header|token-scheme/);
    expect(BOOTSTRAP_SOURCE).toContain("elementAttributesFor(");
  });

  it("leaves the storage relay free of any credential concept", () => {
    expect(STORAGE_RELAY_SOURCE).not.toMatch(/\bauthorization\b|\bx-bluepencil-auth\b|\btoken\b/i);
  });
});

describe("worker — the credential is attached there and nowhere else (AC-B13, AC-B20)", () => {
  it("wires the credential, the endpoint and the permission check into runHubRequest", () => {
    expect(SW_SOURCE).toMatch(/credential:\s*\(\)\s*=>\s*\(\{[^}]*auth:[^}]*token:/);
    expect(SW_SOURCE).toMatch(/endpoint:\s*\(\)\s*=>\s*settings\.endpoint/);
    expect(SW_SOURCE).toMatch(/contains:\s*\(pattern\)\s*=>\s*chrome\.permissions\.contains\(/);
  });

  it("performs the relay through runHubRequest, not a second fetch path", () => {
    expect(SW_SOURCE).toMatch(/runHubRequest\(/);
    expect(SW_SOURCE).not.toMatch(/\bfetch\s*\(/);
  });

  it("the bridge hop adds no header of its own", () => {
    expect(BRIDGE_FETCH_SOURCE).not.toMatch(/authHeadersFor|authorization|x-bluepencil-auth/i);
    expect(BRIDGE_FETCH_SOURCE).toMatch(/request:\s*envelope\.request/);
  });
});
