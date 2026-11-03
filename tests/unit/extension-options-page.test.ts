/**
 * The options page after B.4/B.5 (AC-B48, SEC-15).
 *
 * The page used to offer *Turn on here* / *Turn off here*: two buttons that asked the worker to
 * switch a tab on, with no gesture behind them. A settings tab is not the page under review, and a
 * page-side toggle must not be able to reach another tab. The controls are gone; the remaining way
 * to mount is the toolbar button and the keyboard shortcut, and the options page says so and links
 * to the review page for stored notes.
 *
 * This reads `options.html` and `options.ts` as sources, which is the observation the spec asks for:
 * the absence of the two controls is a property of the page, not of a rendered DOM that a test would
 * have to mock.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relative: string): string => readFileSync(join(ROOT, relative), "utf8");

const OPTIONS_HTML = source("extension/options.html");
const OPTIONS_SOURCE = source("extension/src/options.ts");
const CREDENTIAL_COPY_SOURCE = source("extension/src/credential-copy.ts");

describe("options page — the page toggle controls are gone (AC-B48)", () => {
  it("has no turn-on or turn-off element", () => {
    expect(OPTIONS_HTML).not.toContain("turn-on");
    expect(OPTIONS_HTML).not.toContain("turn-off");
  });

  it("leaves no dead selector for them in the options script", () => {
    expect(OPTIONS_SOURCE).not.toContain("turn-on");
    expect(OPTIONS_SOURCE).not.toContain("turn-off");
    expect(OPTIONS_SOURCE).not.toContain("wireToggle");
  });

  it("names the toolbar button and the keyboard shortcut as the remaining way to mount", () => {
    expect(OPTIONS_HTML).toMatch(/toolbar button/i);
    expect(OPTIONS_HTML).toMatch(/Alt<\/kbd>\+<kbd>Shift<\/kbd>\+<kbd>B/);
  });

  it("links to the review page for stored notes", () => {
    expect(OPTIONS_HTML).toContain('href="review.html"');
    expect(OPTIONS_HTML).toContain("Open the review page");
  });
});

describe("options page — the credential comes from its one module (AC-B53)", () => {
  it("imports `configuredCredential` from ./credential", () => {
    expect(OPTIONS_SOURCE).toMatch(
      /import \{[^}]*\bconfiguredCredential\b[^}]*\} from "\.\/credential"/,
    );
    expect(CREDENTIAL_COPY_SOURCE).toMatch(
      /import \{[^}]*\bconfiguredCredential\b[^}]*\} from "\.\/credential"/,
    );
  });

  it("never imports from ./handoff, whose re-export is gone", () => {
    // The re-export was deleted in the boundary commit; an import through it would no longer
    // typecheck, and this source assertion says so before the compiler has to.
    expect(OPTIONS_SOURCE).not.toMatch(/from "\.\/handoff"/);
    expect(CREDENTIAL_COPY_SOURCE).not.toMatch(/from "\.\/handoff"/);
  });
});
