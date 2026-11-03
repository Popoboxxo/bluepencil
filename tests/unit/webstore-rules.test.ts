/**
 * @vitest-environment node — imports the untyped `.mjs` rule by file URL, which only the Node ESM
 * loader resolves (under jsdom `import.meta.url` is an http URL and the dynamic import fails).
 *
 * Unit tests for the Web Store scan's code-injection rule (CR-116-04).
 *
 * The rule exists to catch `chrome.scripting.executeScript({ code: "…" })` — string evaluation
 * wearing an API's clothes — without flagging an unrelated protocol field that happens to be called
 * `code` (the relay's `error.code`). A gate whose only exercise is "the current tree passes" cannot
 * tell a working rule from a rule that matches nothing, so both directions are pinned here.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

interface WebstoreRules {
  injectsCodeString(source: string): boolean;
}

// The rule ships as plain, untyped ESM next to the CLI. Resolving it by URL at run time keeps this
// suite honest without a hand-maintained `.d.mts` that would drift from the implementation.
const rulesModuleUrl: string = new URL("../../scripts/lib/webstore-rules.mjs", import.meta.url).href;
const { injectsCodeString } = (await import(rulesModuleUrl)) as WebstoreRules;

describe("webstore rules — executeScript code injection", () => {
  it("flags an inline code string", () => {
    expect(
      injectsCodeString('chrome.scripting.executeScript({ target: { tabId }, code: "document.title" });'),
    ).toBe(true);
  });

  it("flags a code property after a nested call", () => {
    expect(
      injectsCodeString(
        "chrome.scripting.executeScript({ target: { tabId: pick(tab) }, code, injectImmediately: true });",
      ),
    ).toBe(true);
  });

  it("does not flag files or func injections", () => {
    expect(
      injectsCodeString(
        'chrome.scripting.executeScript({ target: { tabId }, files: ["bridge.js"], injectImmediately: true });',
      ),
    ).toBe(false);
    expect(
      injectsCodeString(
        "chrome.scripting.executeScript({ target: { tabId }, func: mainWorldHandoff, args: [1] });",
      ),
    ).toBe(false);
  });

  it("does not flag an ordinary protocol field named code", () => {
    // The exact false positive that forced the computed-key workaround: a refusal object's field.
    expect(injectsCodeString('return { ok: false, error: { code, message } };')).toBe(false);
    expect(injectsCodeString('return { ok: false, error: { code: "network", message } };')).toBe(false);
  });

  it("is defensive about its input", () => {
    expect(injectsCodeString("")).toBe(false);
    expect(injectsCodeString(undefined as unknown as string)).toBe(false);
  });
});

/* ------------------------------------------------------------------------------------------------
 * The boundary shape of the source manifest (AC-B12, AC-B18, AC-B56(a))
 *
 * Read from `extension/`, never from `dist`: a clean checkout has no build, and the ordering
 * assertion is deliberately two-part (source here, artefact in `smoke:webstore`).
 * ---------------------------------------------------------------------------------------------- */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relative: string): string => readFileSync(join(ROOT, relative), "utf8");

const MANIFEST_SOURCE = JSON.parse(source("extension/manifest.json")) as {
  host_permissions?: string[];
  optional_host_permissions?: string[];
  content_scripts?: unknown[];
  web_accessible_resources?: unknown[];
};
const WORKER_SOURCE = source("extension/src/sw.ts");

describe("manifest — host access is optional, never pre-granted (AC-B18, AC-B56)", () => {
  it("carries no host_permissions", () => {
    expect(MANIFEST_SOURCE.host_permissions ?? []).toEqual([]);
  });

  it("declares exactly the documented optional http/https patterns", () => {
    expect(MANIFEST_SOURCE.optional_host_permissions).toEqual(["http://*/*", "https://*/*"]);
  });

  it("never asks for <all_urls>", () => {
    const all = [
      ...(MANIFEST_SOURCE.host_permissions ?? []),
      ...(MANIFEST_SOURCE.optional_host_permissions ?? []),
    ];
    expect(all).not.toContain("<all_urls>");
  });

  it("declares no content script and no web-accessible resource", () => {
    expect(MANIFEST_SOURCE.content_scripts ?? []).toEqual([]);
    expect(MANIFEST_SOURCE.web_accessible_resources ?? []).toEqual([]);
  });
});

describe("worker — no persistent MAIN-world registration (AC-B54, AC-B56(a))", () => {
  it("does not register or unregister content scripts", () => {
    expect(WORKER_SOURCE).not.toContain("registerContentScripts");
    expect(WORKER_SOURCE).not.toContain("unregisterContentScripts");
    expect(WORKER_SOURCE).not.toContain("ensureBootstrapRegistered");
  });
});
