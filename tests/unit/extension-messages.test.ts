/**
 * The page-facing message envelope — what the bridge accepts before it relays anything.
 *
 * The page's `postMessage` channel is open to every script on the page, so the bridge has to tell
 * a well-formed request from a spoofed one *before* a branch runs. Two rules matter here:
 *
 *  - the storage branch is strict: the per-origin key comes from the bridge's own
 *    `window.location`, so a page-supplied `origin` or `key` is not a field of this message and is
 *    refused as `foreign_field` — never stripped and then silently accepted (SEC-13);
 *  - the fetch branch ignores unknown fields on purpose: the worker is its trust boundary
 *    (`hub-fetch.ts`) and this hop has no policy to apply.
 *
 * These are pure checks on the envelope shape; the relay's own key rules live in
 * `extension-storage-relay.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { checkPageEnvelope } from "../../extension/src/bridge";
import { PAGE_FETCH_KIND } from "../../extension/src/hub-fetch";

const KEY = "bluepencil:v2:https://a.example";

function message(fields: Record<string, unknown>): Record<string, unknown> {
  return { source: "bluepencil-page", ...fields };
}

describe("checkPageEnvelope — envelope validity", () => {
  it("accepts a well-formed storage request for each operation", () => {
    expect(checkPageEnvelope(message({ kind: "storage", op: "get", keys: KEY }))).toEqual({
      ok: true,
      kind: "storage",
    });
    expect(checkPageEnvelope(message({ kind: "storage", op: "set", items: { [KEY]: "x" } }))).toEqual({
      ok: true,
      kind: "storage",
    });
    expect(checkPageEnvelope(message({ kind: "storage", op: "remove", keys: [KEY] }))).toEqual({
      ok: true,
      kind: "storage",
    });
  });

  it("accepts the mount, toggle and fetch kinds", () => {
    expect(checkPageEnvelope(message({ kind: "request-mount", force: true }))).toEqual({
      ok: true,
      kind: "request-mount",
    });
    expect(checkPageEnvelope(message({ kind: "toggle", enabled: false }))).toEqual({
      ok: true,
      kind: "toggle",
    });
    expect(checkPageEnvelope(message({ kind: PAGE_FETCH_KIND, requestId: "r1" }))).toEqual({
      ok: true,
      kind: PAGE_FETCH_KIND,
    });
  });

  it("refuses a non-object envelope", () => {
    for (const value of [null, "bluepencil", 7, [], undefined]) {
      expect(checkPageEnvelope(value)).toMatchObject({ ok: false, code: "invalid_envelope" });
    }
  });

  it("requires the bluepencil-page source tag", () => {
    expect(checkPageEnvelope({ kind: "storage", op: "get", keys: KEY })).toMatchObject({
      ok: false,
      code: "invalid_envelope",
    });
    expect(
      checkPageEnvelope({ source: "bluepencil-extension", kind: "storage", op: "get", keys: KEY }),
    ).toMatchObject({ ok: false, code: "invalid_envelope" });
  });

  it("requires a known message kind (missing and unknown)", () => {
    expect(checkPageEnvelope(message({ op: "get", keys: KEY }))).toMatchObject({
      ok: false,
      code: "invalid_envelope",
    });
    expect(checkPageEnvelope(message({ kind: "clear" }))).toMatchObject({
      ok: false,
      code: "invalid_envelope",
    });
    expect(checkPageEnvelope(message({ kind: 7 }))).toMatchObject({
      ok: false,
      code: "invalid_envelope",
    });
  });
});

describe("checkPageEnvelope — the storage branch has no origin or key field (AC-B26)", () => {
  it("refuses a page-supplied origin", () => {
    expect(
      checkPageEnvelope(
        message({ kind: "storage", op: "get", keys: KEY, origin: "https://b.example" }),
      ),
    ).toEqual({
      ok: false,
      code: "foreign_field",
      error: "a page storage message may not carry origin or key",
    });
  });

  it("refuses a page-supplied key", () => {
    expect(
      checkPageEnvelope(
        message({ kind: "storage", op: "set", items: { [KEY]: "x" }, key: "bluepencil:v2:https://b.example" }),
      ),
    ).toMatchObject({ ok: false, code: "foreign_field" });
  });

  it("requires an operation", () => {
    expect(checkPageEnvelope(message({ kind: "storage" }))).toMatchObject({
      ok: false,
      code: "invalid_envelope",
    });
    expect(checkPageEnvelope(message({ kind: "storage", op: 7 }))).toMatchObject({
      ok: false,
      code: "invalid_envelope",
    });
    expect(checkPageEnvelope(message({ kind: "storage", op: "clear" }))).toMatchObject({
      ok: false,
      code: "invalid_envelope",
    });
  });

  it("requires the payload shape the operation uses", () => {
    expect(checkPageEnvelope(message({ kind: "storage", op: "set", items: "nope" }))).toMatchObject({
      ok: false,
      code: "invalid_envelope",
    });
    expect(checkPageEnvelope(message({ kind: "storage", op: "set", items: [] }))).toMatchObject({
      ok: false,
      code: "invalid_envelope",
    });
    expect(checkPageEnvelope(message({ kind: "storage", op: "get", keys: 7 }))).toMatchObject({
      ok: false,
      code: "invalid_envelope",
    });
    expect(checkPageEnvelope(message({ kind: "storage", op: "remove", keys: [KEY, 7] }))).toMatchObject({
      ok: false,
      code: "invalid_envelope",
    });
    expect(checkPageEnvelope(message({ kind: "storage", op: "get" }))).toMatchObject({
      ok: false,
      code: "invalid_envelope",
    });
  });

  it("leaves key membership to the relay: an empty list is shape-valid here", () => {
    // `checkPageEnvelope` validates the envelope, not the derived key — the relay answers
    // `foreign_key` for an empty list (AC-B04).
    expect(checkPageEnvelope(message({ kind: "storage", op: "get", keys: [] }))).toEqual({
      ok: true,
      kind: "storage",
    });
  });
});

describe("checkPageEnvelope — the fetch branch ignores unknown fields (AC-B26)", () => {
  it("does not reject origin/key on a fetch request", () => {
    expect(
      checkPageEnvelope(
        message({
          kind: PAGE_FETCH_KIND,
          requestId: "r1",
          request: { url: "http://127.0.0.1:8787/api", method: "GET", headers: {} },
          origin: "https://b.example",
          key: "irrelevant",
        }),
      ),
    ).toEqual({ ok: true, kind: PAGE_FETCH_KIND });
  });

  it("tolerates the documented optional fields on mount and toggle", () => {
    expect(
      checkPageEnvelope(message({ kind: "request-mount", requestId: "m1", force: true })),
    ).toEqual({ ok: true, kind: "request-mount" });
    expect(
      checkPageEnvelope(message({ kind: "toggle", requestId: "t1", enabled: true })),
    ).toEqual({ ok: true, kind: "toggle" });
  });
});
