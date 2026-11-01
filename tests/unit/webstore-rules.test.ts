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
