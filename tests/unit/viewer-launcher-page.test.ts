/**
 * @vitest-environment node — the renderer is a pure string function (spec §4, §5.5).
 *
 * The launcher page is the browser entry point (FR-6.26) and must stay a page a human can use with
 * scripting disabled: one password field, one POST form, zero JavaScript, zero external resource.
 * These assertions are the contract the handler-level tests and the docs rely on.
 */
import { describe, expect, it } from "vitest";

import { fillTemplate, renderLauncherHtml } from "../../server/launcher-html";
import { ADMIN_STRINGS } from "../../server/admin-i18n";
import { BASE } from "./helpers/viewer-harness";

const ACTION = `${BASE}/viewer/start`;

function render(lang: "en" | "de" = "en", error?: string): string {
  return renderLauncherHtml(ADMIN_STRINGS[lang], {
    action: ACTION,
    ...(error === undefined ? {} : { error }),
  });
}

function classesOf(html: string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(/class="([^"]*)"/g)) {
    for (const name of String(match[1]).split(/\s+/)) if (name.length > 0) found.push(name);
  }
  return found;
}

describe("launcher page — the form contract (AC-L01)", () => {
  it("renders exactly one password field with the documented attributes and no value", () => {
    const html = render();
    expect(html.match(/<input\b/g)?.length).toBe(1);
    const input = html.match(/<input\b[^>]*>/)?.[0] ?? "";
    expect(input).toContain('type="password"');
    expect(input).toContain('name="secret"');
    expect(input).toContain('id="secret"');
    expect(input).toContain('autocomplete="off"');
    expect(input).toContain("required");
    expect(input).toContain("autofocus");
    expect(input).not.toContain("value=");
    expect(input).not.toContain("placeholder=");
  });

  it("posts the form to the base-prefixed launcher path with the form enctype", () => {
    const form = render().match(/<form\b[^>]*>/)?.[0] ?? "";
    expect(form).toContain('method="post"');
    expect(form).toContain(`action="${ACTION}"`);
    expect(form).toContain('enctype="application/x-www-form-urlencoded"');
    expect(form).not.toContain("?k=");
    expect(form).not.toContain("://");
  });

  it("labels the field with the shared string and submits through a bp-primary button", () => {
    const html = render();
    expect(html).toContain('<label for="secret">Admin secret</label>');
    expect(html).toContain('<button type="submit" class="bp-primary">Open viewer</button>');
  });

  it("declares the document language, charset, viewport and title", () => {
    const html = render("en");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain("<title>Bluepencil — viewer</title>");
    expect(html).toContain("<h1>Viewer login</h1>");
    expect(html).toContain("The hub&#39;s admin secret");
  });

  it("renders the German page with lang de and no raw key (AC-L02)", () => {
    const html = render("de");
    expect(html).toContain('<html lang="de">');
    expect(html).toContain("Viewer-Anmeldung");
    expect(html).toContain("Viewer öffnen");
    expect(html).toContain("Admin-Secret");
    expect(html).not.toContain("Viewer login");
    expect(html).not.toMatch(/launcher[A-Z][A-Za-z]+/);
  });
});

describe("launcher page — prohibitions (AC-L01)", () => {
  it("ships no script, no event handler, no external asset and no absolute URL", () => {
    for (const lang of ["en", "de"] as const) {
      const html = render(lang, "anything");
      expect(html, lang).not.toContain("<script");
      expect(html, lang).not.toMatch(/\son[a-z]+=/i);
      expect(html, lang).not.toContain("<img");
      expect(html, lang).not.toContain("<link");
      expect(html, lang).not.toMatch(/https?:\/\//);
      expect(html, lang).not.toContain("<iframe");
    }
  });

  it("keeps every CSS class bp-prefixed and every custom property --bp-*", () => {
    const html = render();
    for (const name of classesOf(html)) expect(name.startsWith("bp-"), name).toBe(true);
    for (const match of html.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)) {
      expect(String(match[1]).startsWith("--bp-"), String(match[1])).toBe(true);
    }
    expect(html).toContain("<style>");
  });

  it("escapes the action instead of rendering it as markup", () => {
    const html = renderLauncherHtml(ADMIN_STRINGS.en, { action: '/x"><script>alert(1)</script>' });
    expect(html).not.toContain("<script");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("stays under 4 KiB in both languages", () => {
    expect(Buffer.byteLength(render("en"), "utf8")).toBeLessThan(4096);
    expect(Buffer.byteLength(render("de"), "utf8")).toBeLessThan(4096);
  });
});

describe("launcher page — the error block (AC-L08/L32)", () => {
  it("places the alert directly after the h1 and before the help paragraph", () => {
    const html = render("en", "The operator secret is not valid.");
    const h1 = html.indexOf("<h1>");
    const error = html.indexOf('<p class="bp-error" role="alert">');
    const help = html.indexOf('<p class="bp-muted">');
    expect(h1).toBeGreaterThanOrEqual(0);
    expect(error).toBeGreaterThan(h1);
    expect(help).toBeGreaterThan(error);
    expect(html).toContain("autofocus");
  });

  it("renders an error message as text, never as markup", () => {
    const html = render("en", "<script>window.__xss=1</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;window.__xss=1&lt;/script&gt;");
  });

  it("renders no error block without an error, and none for an empty message", () => {
    expect(render()).not.toContain('<p class="bp-error"');
    expect(render("en", "")).not.toContain('<p class="bp-error"');
  });

  it("keeps role=alert only on the error block", () => {
    const html = render("en", "message");
    expect(html.match(/role="alert"/g)?.length).toBe(1);
  });
});

describe("fillTemplate (AC-L30/L32)", () => {
  it("substitutes placeholders and leaves unknown ones literal", () => {
    expect(fillTemplate("in {seconds} s", { seconds: 300 })).toBe("in 300 s");
    expect(fillTemplate("at {origin}", { origin: "http://viewer.example:8788" })).toBe(
      "at http://viewer.example:8788",
    );
    expect(fillTemplate("keep {unknown}", { seconds: 1 })).toBe("keep {unknown}");
  });

  it("renders the throttle message with the seconds in both languages", () => {
    for (const lang of ["en", "de"] as const) {
      const rendered = fillTemplate(ADMIN_STRINGS[lang].launcherThrottled, { seconds: 300 });
      expect(rendered, lang).toContain("300");
      expect(rendered, lang).not.toContain("{seconds}");
    }
  });
});
