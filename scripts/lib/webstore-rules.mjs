/**
 * Pure detection rules for the Chrome Web Store compliance scan (`scripts/webstore-compliance.mjs`).
 *
 * Kept side-effect-free so the vitest suite can pin them: a compliance gate that is only exercised
 * against the current tree cannot tell "the rule still catches a violation" from "the tree happens
 * to contain none". The CLI wrapper reads the files and calls these functions.
 *
 * No dependencies (NFR-4).
 */

/**
 * Does `source` inject a JavaScript **string** through `chrome.scripting.executeScript`?
 *
 * The store forbids remote/string code, and only `files` and `func` may appear in the injection
 * descriptor. The naive rule — "any `code:` anywhere in the worker" — was a false positive for a
 * protocol field that happens to be called `code` (CR-116-04), which is why the scan is scoped to
 * the argument list of each `executeScript(...)` call.
 *
 * The span is taken by counting parentheses from the opening one, so a nested call in the
 * descriptor (`target: { tabId: pick() }`) does not end it early. Parentheses inside string
 * literals are not parsed: an unbalanced one can only widen the span (a loud false positive), never
 * hide a `code:` that precedes the string it appears in.
 *
 * @param {string} source JavaScript source, comments already stripped is fine but not required
 * @returns {boolean} true when an `executeScript` call carries a `code` property
 */
export function injectsCodeString(source) {
  if (typeof source !== "string" || source.length === 0) return false;
  const call = /executeScript\s*\(/g;
  let match;
  while ((match = call.exec(source)) !== null) {
    const start = match.index + match[0].length;
    let depth = 1;
    let index = start;
    for (; index < source.length && depth > 0; index += 1) {
      const char = source[index];
      if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
    }
    const args = source.slice(start, index - 1);
    // A `code` entry, long or short form: `{ code: "…" }` and `{ code }` are the same injection.
    if (/[{,]\s*code\s*[:,}]/.test(args)) return true;
  }
  return false;
}
