/**
 * Documentation truth for the extension end state — the editorial tail (B.7.7).
 *
 * These assertions observe prose, not behaviour. Each one pins a *fact* a reader relies on after
 * 0.12.0 — worker-only credentials, optional host access and its grant timing, legacy notes that are
 * invisible in the overlay, the path-only route default, the download check, and the manual release
 * checklist — without freezing whole files. Section markers and stable phrases are used on purpose,
 * so an unrelated edit elsewhere in a document stays green.
 *
 * The behavioural halves live in their own suites (`extension-*`, `embed`, `store`, `webstore-rules`);
 * this file owns the documentation half:
 *   - AC-B40 — CHANGELOG + EXTENSION + EMBED name the visible/security-relevant changes
 *   - AC-B50 — RC-1…RC-3 are named and the grant path is honestly not automated
 *   - AC-B58 — WEBSTORE carries the optional host patterns and the grant timing
 *   - AC-B59 — RELEASING carries the checklist and release.yml declares the protected environment
 *   - AC-C04 — the documented route default is path-only
 *   - AC-C05 — the host-code attributes are named as host code, never as untrusted input
 *   - AC-C09 — the embed docs say "download check", not a browser integrity mechanism
 *   - AC-C11 — file:// is documented as memory-only with a local/hub alternative
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function doc(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

const changelog = (): string => doc("CHANGELOG.md");
const embed = (): string => doc("docs/EMBED.md");
const extension = (): string => doc("docs/EXTENSION.md");
const webstore = (): string => doc("docs/WEBSTORE.md");
const releasing = (): string => doc("docs/RELEASING.md");
const releaseWorkflow = (): string => doc(".github/workflows/release.yml");

/* ------------------------------------------------------------------------------------------------
 * AC-B40 — the shared docs name the end state
 * ---------------------------------------------------------------------------------------------- */

describe("docs.extension_end_state (AC-B40)", () => {
  it("warns that downgrading needs cleared storage and is a confidentiality regression", () => {
    const log = changelog();
    expect(log).toMatch(/clear extension storage before downgrading/i);
    expect(log).toMatch(/confidentiality regression/i);
    expect(extension()).toMatch(/clear extension storage before downgrading/i);
  });

  it("states that every bundle hash changes", () => {
    expect(changelog()).toMatch(/every bundle hash changes|hash of\s+each bundle/i);
  });

  it("documents file:// as memory-only with a local or hub alternative", () => {
    expect(extension()).toMatch(/memory-only/i);
    const text = embed();
    expect(text).toMatch(/file:\/\//);
    expect(text).toMatch(/memory-only/i);
    expect(text).toMatch(/localStorage/);
    expect(text).toMatch(/\bhub\b/i);
  });

  it("states that legacy notes leave the overlay and are read-only on the review page", () => {
    const text = extension();
    expect(text).toMatch(/legacy notes/i);
    expect(text).toMatch(/no longer appear\s+in the page overlay/i);
    expect(text).toMatch(/read-only on the review page/i);
    // The data survives; only visibility regressed.
    expect(text).toMatch(/data is not deleted|copied into an origin/i);
  });

  it("names the removed options buttons and the worker-only credential", () => {
    const text = extension();
    expect(text).toMatch(/Turn on here/);
    expect(text).toMatch(/worker-only/);
    expect(changelog()).toMatch(/worker-only/);
  });

  it("names the removed token attributes in all three shared docs", () => {
    for (const text of [changelog(), extension(), embed()]) {
      expect(text).toMatch(/token-header/);
      expect(text).toMatch(/token-scheme/);
    }
    expect(embed()).toMatch(/issues/);
  });

  it("warns that the default key is per origin and names the explicit override", () => {
    expect(changelog()).toMatch(/`key: chromeStorageKey\(\)` explicitly/);
    expect(extension()).toMatch(/`key: chromeStorageKey\(\)` explicitly/);
    expect(extension()).toMatch(/bluepencil:v2:<origin>/);
  });

  it("keeps the legacy read-only workflow copy-only on the review page", () => {
    const text = extension();
    expect(text).toMatch(/copied\s+into an origin/i);
    expect(text).toMatch(/undo removes\s+only the copy/i);
    expect(text).toMatch(/explicit confirm/i);
  });
});

/* ------------------------------------------------------------------------------------------------
 * AC-B50 / AC-B59 — the manual release checklist
 * ---------------------------------------------------------------------------------------------- */

describe("docs.release_checklist (AC-B50, AC-B59)", () => {
  it("names RC-1…RC-3 in EXTENSION and says the grant path is not automated", () => {
    const text = extension();
    for (const step of ["RC-1", "RC-2", "RC-3"]) {
      expect(text, `EXTENSION.md is missing ${step}`).toContain(step);
    }
    expect(text).toMatch(/not checked automatically/i);
  });

  it("carries the same steps as mandatory points in RELEASING", () => {
    const text = releasing();
    for (const step of ["RC-1", "RC-2", "RC-3"]) {
      expect(text, `RELEASING.md is missing ${step}`).toContain(step);
    }
    expect(text).toMatch(/only after\*\* RC-1…RC-3/i);
    expect(text).toMatch(/environment: release/);
  });

  it("binds the release job to the protected environment", () => {
    const workflow = releaseWorkflow();
    expect(workflow).toMatch(/^\s{4}environment:\s*release\s*$/m);
  });

  it("describes what each checklist point confirms", () => {
    const text = releasing();
    expect(text).toMatch(/hub origin/i);
    expect(text).toMatch(/toolbar/i);
    expect(text).toMatch(/Alt\+Shift\+B/);
  });
});

/* ------------------------------------------------------------------------------------------------
 * AC-B58 — optional host access and its grant timing
 * ---------------------------------------------------------------------------------------------- */

describe("docs.webstore_optional_hosts (AC-B58)", () => {
  it("names optional_host_permissions and both patterns", () => {
    const text = webstore();
    expect(text).toContain("optional_host_permissions");
    expect(text).toContain("http://*/*");
    expect(text).toContain("https://*/*");
    expect(text).toMatch(/no\s+`host_permissions`|never install-time/i);
  });

  it("names the grant timing: first save of an HTTP endpoint, in the click context", () => {
    const text = webstore();
    expect(text).toMatch(/first time an HTTP\s+endpoint is saved/i);
    expect(text).toMatch(/user gesture|click/i);
  });

  it("does not claim a content script is registered", () => {
    expect(webstore()).not.toMatch(/registerContentScripts/);
  });
});

/* ------------------------------------------------------------------------------------------------
 * AC-C04 — the documented route default is path-only
 * ---------------------------------------------------------------------------------------------- */

describe("docs.route_default (AC-C04)", () => {
  it("documents path-only as the default and the query opt-in separately", () => {
    const text = embed();
    expect(text).toMatch(/path-only/i);
    expect(text).toMatch(/url-with-query/);
    expect(text).toMatch(/query-allow/);
    expect(text).toMatch(/query-deny/);
  });

  it("states the extension writes route=\"url\" and never opts into the query", () => {
    const text = extension();
    expect(text).toMatch(/route="url"/);
    expect(text).toMatch(/never opts into the query|no query opt-in/i);
  });
});

/* ------------------------------------------------------------------------------------------------
 * AC-C05 — host-code attributes
 * ---------------------------------------------------------------------------------------------- */

describe("docs.host_code_attributes (AC-C05)", () => {
  it("names the three attributes and the untrusted-markup rule", () => {
    const text = embed();
    for (const attribute of ["headers-from", "route-from", "gate"]) {
      expect(text, `EMBED.md is missing ${attribute}`).toContain(attribute);
    }
    expect(text).toMatch(/execute host code/i);
    expect(text).toMatch(/never come from untrusted markup/i);
  });
});

/* ------------------------------------------------------------------------------------------------
 * AC-C09 — download check, not a browser integrity mechanism
 * ---------------------------------------------------------------------------------------------- */

describe("docs.download_check (AC-C09)", () => {
  it("has removed the Subresource Integrity vocabulary", () => {
    const text = embed();
    expect(text).not.toMatch(/Subresource Integrity/i);
    expect(text).not.toMatch(/\bSRI\b/);
  });

  it("calls it a download check and says assurance needs the host pin", () => {
    const text = embed();
    expect(text).toMatch(/download check/i);
    expect(text).toMatch(/host pin/i);
    expect(text).toMatch(/assurance/i);
  });
});

/* ------------------------------------------------------------------------------------------------
 * AC-C11 — file:// has no persistent bucket
 * ---------------------------------------------------------------------------------------------- */

describe("docs.file_origin_memory_only (AC-C11)", () => {
  it("names the degradation and both alternatives", () => {
    const text = embed();
    expect(text).toMatch(/file:\/\//);
    expect(text).toMatch(/memory-only/i);
    expect(text).toMatch(/\bopaque origin\b/i);
    expect(text).toMatch(/localStorage/);
    expect(text).toMatch(/\bhub\b/i);
  });
});
