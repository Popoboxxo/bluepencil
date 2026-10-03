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

import { elementAttributesFor } from "../../extension/src/handoff";
import { DEFAULT_SETTINGS, normalizeSettings } from "../../extension/src/settings";

const base = {
  ...DEFAULT_SETTINGS,
  environment: "dev" as const,
  appName: "",
  language: "en" as const,
  identity: "prompt" as const,
  store: "chromeStorage" as const,
  endpoint: "",
  auth: "none" as const,
  token: "",
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

  it("selects the HTTP adapter by its endpoint, never by an adapter name alone", () => {
    const attributes = elementAttributesFor(
      { ...base, store: "http", endpoint: "http://127.0.0.1:8787/api/v1/bluepencil" },
      "en",
    );
    expect(attributes.endpoint).toBe("http://127.0.0.1:8787/api/v1/bluepencil");
    // `adapter="http"` with no endpoint would pick an adapter with nowhere to send a note.
    expect(attributes.adapter).toBeUndefined();
  });

  it("sends each credential under the header its mode means", () => {
    const shared = elementAttributesFor(
      { ...base, store: "http", endpoint: "http://x.test", auth: "secret", token: "s3cret" },
      "en",
    );
    expect(shared.token).toBe("s3cret");
    expect(shared["token-header"]).toBe("x-bluepencil-auth");
    expect(shared["token-scheme"]).toBeUndefined();

    const signed = elementAttributesFor(
      { ...base, store: "http", endpoint: "http://x.test", auth: "token", token: "a.b.c" },
      "en",
    );
    expect(signed.token).toBe("a.b.c");
    expect(signed["token-header"]).toBe("authorization");
    expect(signed["token-scheme"]).toBe("Bearer");
  });

  it("writes no credential at all when the hub has none", () => {
    const attributes = elementAttributesFor(
      { ...base, store: "http", endpoint: "http://x.test", auth: "none", token: "" },
      "en",
    );
    expect(attributes.token).toBeUndefined();
    expect(attributes["token-header"]).toBeUndefined();
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
