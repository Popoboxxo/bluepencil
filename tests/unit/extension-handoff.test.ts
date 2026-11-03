/**
 * The worker's settings → the element's attributes (#53).
 *
 * The extension used to write its configuration onto `<bluepencil-notes>` with a `data-` prefix,
 * which is the *loader's* vocabulary: `dist/attach.js` translates `data-store` → `adapter` when it
 * creates the element, and the element itself reads the plain names. So nothing arrived — measured
 * in the extension smoke, the layer used its default `memory` store while the attribute readback
 * said `chromeStorage`, and the suite stayed green because it only read the attribute back.
 *
 * These cases are the ones that were wrong, each one measured against `src/embed/attributes.ts`
 * (the element's single source of truth) or `src/core/model.ts`:
 */
import { describe, expect, it } from "vitest";

import {
  elementAttributesFor,
  pageSettingsFor,
  type ExtensionAttributeSource,
} from "../../extension/src/handoff";
import { planMount } from "../../extension/src/mount-plan";
import { DEFAULT_SETTINGS, normalizeSettings, type ExtensionSettings } from "../../extension/src/settings";

const base: ExtensionAttributeSource = {
  ...DEFAULT_SETTINGS,
  environment: "dev",
  appName: "",
  language: "en",
  identity: "prompt",
  store: "chromeStorage",
  endpoint: "",
};

describe("elementAttributesFor", () => {
  it("writes the element's own names, never the loader's data- spelling", () => {
    const attributes = elementAttributesFor(
      { ...base, appName: "ReqogniLoom", environment: "staging" },
      "en",
    );
    expect(attributes.adapter).toBe("chromeStorage");
    expect(attributes.environment).toBe("staging");
    expect(attributes.app).toBe("ReqogniLoom");
    expect(attributes.identity).toBe("prompt");
    // The regression this test exists for: a `data-` key reaches nothing.
    expect(Object.keys(attributes).filter((name) => name.startsWith("data-"))).toEqual([]);
  });

  it("leaves `app` unset when no name was given, so the element's own default applies", () => {
    expect(elementAttributesFor({ ...base, appName: "   " }, "en").app).toBeUndefined();
  });

  it("resolves `auto` from the browser, because the element has no `auto`", () => {
    expect(elementAttributesFor({ ...base, language: "auto" }, "de-DE").language).toBe("de");
    expect(elementAttributesFor({ ...base, language: "auto" }, "en-GB").language).toBe("en");
    expect(elementAttributesFor({ ...base, language: "de" }, "en-GB").language).toBe("de");
  });

  it("carries the page route, so a note keeps the page it was taken on", () => {
    expect(elementAttributesFor(base, "en").route).toBe("url");
  });

  it("writes the path-only route and never the query opt-in (AC-C04)", () => {
    // Every store mode, including the hub: the route sentence does not depend on where notes go.
    for (const store of ["chromeStorage", "localStorage", "http"] as const) {
      const attributes = elementAttributesFor(
        { ...base, store, endpoint: store === "http" ? "http://127.0.0.1:8787/api" : "" },
        "en",
      );
      expect(attributes.route).toBe("url");
      expect(attributes.route).not.toBe("url-with-query");
      // No implicit opt-in: without `query-allow` the element cannot keep a query parameter.
      expect(attributes["query-allow"]).toBeUndefined();
      expect(attributes["query-deny"]).toBeUndefined();
    }
  });

  it("selects the HTTP adapter by its endpoint, never by an adapter name alone", () => {
    const attributes = elementAttributesFor(
      { ...base, store: "http", endpoint: "http://127.0.0.1:8787/api/v1/bluepencil" },
      "en",
    );
    expect(attributes.endpoint).toBe("http://127.0.0.1:8787/api/v1/bluepencil");
    // `adapter="http"` with no endpoint would pick an adapter with nowhere to send a note.
    expect(attributes.adapter).toBeUndefined();
  });

  it("writes no token attribute at all, whatever credential the settings hold (AC-B15, AC-B36)", () => {
    // The page never sees a credential: the worker attaches the header per relayed request. Every
    // mode/token combination therefore has to leave the element's attribute set free of `token*`
    // and of `auth` — there is no value a page script could read back.
    for (const auth of ["none", "secret", "token"] as const) {
      for (const token of ["", "s3cret", "  a.b.c\n", "   "]) {
        const settings: ExtensionSettings = {
          ...DEFAULT_SETTINGS,
          store: "http",
          endpoint: "http://x.test",
          auth,
          token,
        };
        const attributes = elementAttributesFor(settings, "en");
        expect(Object.keys(attributes).filter((name) => name.startsWith("token"))).toEqual([]);
        expect(attributes.auth).toBeUndefined();
        // What the element does need is still there: the endpoint selects the HTTP adapter.
        expect(attributes.endpoint).toBe("http://x.test");
      }
    }
  });
});

describe("pageSettingsFor — the credential never crosses into the page (AC-B15)", () => {
  const settings: ExtensionSettings = {
    ...DEFAULT_SETTINGS,
    environment: "staging",
    appName: "ReqogniLoom",
    store: "http",
    endpoint: "http://127.0.0.1:8787/api/v1/bluepencil",
    auth: "token",
    token: "a.b.c",
    tokenExpiresAt: "2030-01-01T00:00:00.000Z",
    deviceName: "reviewer-laptop",
  };

  it("strips token, tokenExpiresAt and deviceName at runtime", () => {
    const page = pageSettingsFor(settings);
    expect("token" in page).toBe(false);
    expect("tokenExpiresAt" in page).toBe(false);
    expect("deviceName" in page).toBe(false);
    expect(JSON.stringify(page)).not.toContain("a.b.c");
    expect(JSON.stringify(page)).not.toContain("reviewer-laptop");
  });

  it("keeps every page-facing field", () => {
    expect(pageSettingsFor(settings)).toEqual({
      environment: "staging",
      appName: "ReqogniLoom",
      language: "auto",
      identity: "prompt",
      store: "http",
      endpoint: "http://127.0.0.1:8787/api/v1/bluepencil",
      auth: "token",
      mountAlongsideHost: false,
    });
  });

  it("leaves no credential in __bluepencilConfig__", () => {
    const plan = planMount({ settings, tabUrl: "https://a.example/x", force: false });
    expect(JSON.stringify(plan.config)).not.toContain("a.b.c");
    expect(plan.config.settings).not.toHaveProperty("token");
    expect(plan.config.settings).not.toHaveProperty("tokenExpiresAt");
  });
});

describe("the settings vocabulary the layer actually accepts", () => {
  it("folds the page's old `prod` into `live`, the value the model has", () => {
    expect(normalizeSettings({ environment: "prod" }).environment).toBe("live");
    expect(normalizeSettings({ environment: "staging" }).environment).toBe("staging");
    expect(normalizeSettings({ environment: "nonsense" }).environment).toBe("dev");
  });

  it("drops the author mode the element never had", () => {
    expect(normalizeSettings({ identity: "page" }).identity).toBe("prompt");
    expect(normalizeSettings({ identity: "anonymous" }).identity).toBe("anonymous");
  });
});
