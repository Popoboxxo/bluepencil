/**
 * Issue #135 part 2 + the extension options: the strategy attribute is part of the embed
 * vocabulary, an unknown value is an element issue, and the extension passes the label and the
 * grouping through to the layer markup without touching the page.
 */
import { describe, expect, it } from "vitest";
import {
  ALL_ATTRIBUTES,
  parseLoaderOptions,
  readEnvironment,
} from "../../src/embed/attributes";
import { elementAttributesFor, pageSettingsFor } from "../../extension/src/handoff.js";
import { DEFAULT_SETTINGS, normalizeSettings } from "../../extension/src/settings.js";
import { todayLabel } from "../../extension/src/options.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function source(values: Record<string, string>): { getAttribute(name: string): string | null } {
  return { getAttribute: (name) => values[name] ?? null };
}

describe("embed vocabulary", () => {
  it("knows session-strategy on both the element and the loader", () => {
    expect(ALL_ATTRIBUTES).toContain("session-strategy");
    const loader = parseLoaderOptions({
      session: "relaunch-2026-11",
      "session-strategy": "glob:/shop/** , origin",
    });
    expect(loader.attributes.session).toBe("relaunch-2026-11");
    expect(loader.attributes["session-strategy"]).toBe("glob:/shop/** , origin");
  });

  it("parses the strategy and reports an unknown value as an issue", () => {
    const good = readEnvironment(source({ "session-strategy": "origin" }));
    expect(good.sessionStrategy?.map((rule) => rule.kind)).toEqual(["origin"]);
    expect(good.issues).toEqual([]);

    const bad = readEnvironment(source({ "session-strategy": "by-host" }));
    expect(bad.issues.join(" ")).toContain("by-host");
    expect(bad.sessionStrategy).toBeUndefined();
  });

  it("defaults to given, so an existing host's session ref is byte-identical", () => {
    const parsed = readEnvironment(source({ session: "relaunch" }));
    expect(parsed.sessionRef).toBe("relaunch");
    expect(parsed.sessionStrategy?.map((rule) => rule.kind)).toEqual(["given"]);
  });
});

describe("extension options → element attributes", () => {
  it("passes the label and the strategy into the element's own vocabulary", () => {
    const attributes = elementAttributesFor({
      ...DEFAULT_SETTINGS,
      sessionLabel: "relaunch-2026-11",
      sessionStrategy: "route",
    });
    expect(attributes.session).toBe("relaunch-2026-11");
    expect(attributes["session-strategy"]).toBe("route");
  });

  it("writes neither attribute for an untouched installation", () => {
    const attributes = elementAttributesFor(DEFAULT_SETTINGS);
    expect(attributes.session).toBeUndefined();
    expect(attributes["session-strategy"]).toBeUndefined();
  });

  it("keeps both values page-facing (they are intent, not a credential)", () => {
    const page = pageSettingsFor({
      ...DEFAULT_SETTINGS,
      sessionLabel: "round-2",
      sessionStrategy: "origin",
    });
    expect(page.sessionLabel).toBe("round-2");
    expect(page.sessionStrategy).toBe("origin");
  });

  it("validates the stored strategy against the documented set", () => {
    expect(normalizeSettings({ sessionStrategy: "nonsense" }).sessionStrategy).toBe("given");
    expect(normalizeSettings({ sessionStrategy: "none" }).sessionStrategy).toBe("none");
    expect(normalizeSettings({ sessionLabel: 42 }).sessionLabel).toBe("");
  });

  it("has both fields and a one-click date suggestion on the options page", () => {
    const html = readFileSync(join(ROOT, "extension/options.html"), "utf8");
    expect(html).toContain('id="sessionLabel"');
    expect(html).toContain('id="sessionStrategy"');
    expect(html).toContain('id="session-label-today"');
    expect(todayLabel(new Date("2026-11-01T12:00:00Z"))).toBe("2026-11-01");
  });
});
