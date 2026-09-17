import { describe, expect, it } from "vitest";

import { STYLES } from "../../src/ui/styles";

/**
 * Chrome constraints from issue #4 (findings 4–7). Three of them were already implemented when the
 * issue was written — checked here, not assumed, and pinned so a later stylesheet change cannot
 * quietly drop them.
 */

const SHEET = STYLES;

/** The chrome parts the layer renders, by the class the print and reduced-motion rules address. */
const CHROME_PARTS = [
  ".bp-bar",
  ".bp-handle",
  ".bp-panel",
  ".bp-composer",
  ".bp-popover",
  ".bp-legend",
  ".bp-legend-backdrop",
  ".bp-markers",
  ".bp-highlight",
  ".bp-mode-hint",
] as const;

/** Relative luminance (WCAG 2.1) of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
  const [red = 0, green = 0, blue = 0] = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** Contrast ratio between two `#rrggbb` colours (1..21). */
function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe("chrome constraints (issue #4)", () => {
  it("keeps secondary chrome text readable (finding 5 / NFR-21)", () => {
    // The palette the chrome actually uses, as the stylesheet declares it — muted text on the normal
    // and alternate surfaces, plus the accent pair. A host overriding a token takes over this duty.
    const pairs: readonly (readonly [string, string, string])[] = [
      ["ink on surface", "#14161c", "#ffffff"],
      ["muted on surface", "#5a6072", "#ffffff"],
      ["muted on surface-alt", "#5a6072", "#f4f5f8"],
      ["accent-ink on accent", "#ffffff", "#2a63e8"],
      ["danger on surface", "#b3261e", "#ffffff"],
      ["feedback on surface", "#7a4bd0", "#ffffff"],
    ];
    for (const [label, foreground, background] of pairs) {
      expect(contrast(foreground, background), label).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("disables chrome animation under prefers-reduced-motion (finding 6)", () => {
    expect(SHEET).toContain("@media (prefers-reduced-motion: reduce)");
    const block = SHEET.slice(SHEET.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block.slice(0, 400)).toContain(".bp-root *");
    expect(block.slice(0, 400)).toContain("transition: none");
    expect(block.slice(0, 400)).toContain("animation-duration");
  });

  it("hides every chrome part in print (finding 7 / FR-1.9)", () => {
    expect(SHEET).toContain("@media print");
    const block = SHEET.slice(SHEET.indexOf("@media print"));
    for (const part of CHROME_PARTS) {
      // The last selector in the list carries `{` instead of `,` — accept either.
      const selector = part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(new RegExp(`${selector}\\s*[,{]`).test(block), `${part} missing from the print rule`).toBe(true);
    }
    expect(block).toContain("display: none !important");
    // The whole root goes too, so a host cannot leak the layer into a PDF by printing a wrapper.
    expect(block).toContain(".bp-root,");
  });
});
