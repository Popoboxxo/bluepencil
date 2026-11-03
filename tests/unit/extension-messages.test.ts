/**
 * The page-facing message vocabulary — what the bridge accepts and what the worker answers with.
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
 * `extension-storage-relay.test.ts`. The worker half of the file pins the reply vocabulary:
 * `toWorkerReply` turns outcomes into named refusals and never throws (AC-B38), and
 * `badgeForReport` only marks the memory-only mount (AC-B39).
 */
import { describe, expect, it } from "vitest";

import {
  badgeForReport,
  checkPageEnvelope,
  toWorkerReply,
  type WorkerOutcome,
  type WorkerReply,
} from "../../extension/src/bridge-messages";
import { PAGE_FETCH_KIND } from "../../extension/src/hub-fetch";

const KEY = "bluepencil:v2:https://a.example";

function message(fields: Record<string, unknown>): Record<string, unknown> {
  return { source: "bluepencil-page", ...fields };
}

describe("checkPageEnvelope — envelope validity", () => {
  it("accepts a well-formed storage request for each operation", () => {
    expect(checkPageEnvelope(message({ kind: "storage", op: "get", keys: KEY }))).toEqual({
      ok: true,
      envelope: { source: "bluepencil-page", kind: "storage", op: "get", keys: KEY },
    });
    expect(
      checkPageEnvelope(message({ kind: "storage", op: "set", items: { [KEY]: "x" } })),
    ).toEqual({
      ok: true,
      envelope: {
        source: "bluepencil-page",
        kind: "storage",
        op: "set",
        items: { [KEY]: "x" },
      },
    });
    expect(checkPageEnvelope(message({ kind: "storage", op: "remove", keys: [KEY] }))).toEqual({
      ok: true,
      envelope: { source: "bluepencil-page", kind: "storage", op: "remove", keys: [KEY] },
    });
  });

  it("accepts the mount, toggle and fetch kinds", () => {
    expect(checkPageEnvelope(message({ kind: "request-mount", force: true }))).toEqual({
      ok: true,
      envelope: { source: "bluepencil-page", kind: "request-mount", force: true },
    });
    expect(checkPageEnvelope(message({ kind: "toggle", enabled: false }))).toEqual({
      ok: true,
      envelope: { source: "bluepencil-page", kind: "toggle", enabled: false },
    });
    expect(checkPageEnvelope(message({ kind: PAGE_FETCH_KIND, requestId: "r1" }))).toEqual({
      ok: true,
      envelope: { source: "bluepencil-page", kind: PAGE_FETCH_KIND, requestId: "r1" },
    });
  });

  it("returns only the validated fields, not the raw message", () => {
    // The bridge forwards from `envelope`, so an unvalidated extra field must not survive the check
    // even on a branch that tolerates unknown fields: only what this module typed is visible later.
    expect(
      checkPageEnvelope(message({ kind: "request-mount", requestId: 7, force: "yes", extra: true })),
    ).toEqual({
      ok: true,
      envelope: { source: "bluepencil-page", kind: "request-mount" },
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
      message: "a page storage message may not carry origin or key",
    });
  });

  it("refuses a page-supplied key", () => {
    expect(
      checkPageEnvelope(
        message({
          kind: "storage",
          op: "set",
          items: { [KEY]: "x" },
          key: "bluepencil:v2:https://b.example",
        }),
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
    expect(
      checkPageEnvelope(message({ kind: "storage", op: "remove", keys: [KEY, 7] })),
    ).toMatchObject({ ok: false, code: "invalid_envelope" });
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
      envelope: { source: "bluepencil-page", kind: "storage", op: "get", keys: [] },
    });
  });
});

describe("checkPageEnvelope — the fetch branch ignores unknown fields (AC-B26)", () => {
  it("does not reject origin/key on a fetch request", () => {
    const request = { url: "http://127.0.0.1:8787/api", method: "GET", headers: {} };
    expect(
      checkPageEnvelope(
        message({
          kind: PAGE_FETCH_KIND,
          requestId: "r1",
          request,
          origin: "https://b.example",
          key: "irrelevant",
        }),
      ),
    ).toEqual({
      ok: true,
      envelope: { source: "bluepencil-page", kind: PAGE_FETCH_KIND, requestId: "r1", request },
    });
  });

  it("tolerates the documented optional fields on mount and toggle", () => {
    expect(
      checkPageEnvelope(message({ kind: "request-mount", requestId: "m1", force: true })),
    ).toEqual({
      ok: true,
      envelope: { source: "bluepencil-page", kind: "request-mount", requestId: "m1", force: true },
    });
    expect(checkPageEnvelope(message({ kind: "toggle", requestId: "t1", enabled: true }))).toEqual({
      ok: true,
      envelope: { source: "bluepencil-page", kind: "toggle", requestId: "t1", enabled: true },
    });
  });

  it("keeps the request opaque: it is forwarded, not validated here", () => {
    // The worker is the trust boundary (`hub-fetch.ts`); a malformed request body still passes the
    // envelope hop unchanged, so the refusal is named once, by the party that decides it.
    expect(
      checkPageEnvelope(message({ kind: PAGE_FETCH_KIND, requestId: "r2", request: "not-an-object" })),
    ).toEqual({
      ok: true,
      envelope: {
        source: "bluepencil-page",
        kind: PAGE_FETCH_KIND,
        requestId: "r2",
        request: "not-an-object",
      },
    });
  });
});

describe("toWorkerReply — named outcomes, never a throw (AC-B38)", () => {
  it("maps a successful mount, with and without a tab URL", () => {
    expect(toWorkerReply({ kind: "mount", ok: true, tabUrl: "https://a.example/x" })).toEqual({
      ok: true,
      tabUrl: "https://a.example/x",
    });
    expect(toWorkerReply({ kind: "mount", ok: true })).toEqual({ ok: true });
    // An empty URL is an absent URL, not a present-but-empty one.
    expect(toWorkerReply({ kind: "mount", ok: true, tabUrl: "" })).toEqual({ ok: true });
  });

  it("maps a failed mount to mount_failed and keeps the reason", () => {
    expect(
      toWorkerReply({ kind: "mount", ok: false, error: "Cannot access a chrome:// URL" }),
    ).toEqual({ ok: false, code: "mount_failed", error: "Cannot access a chrome:// URL" });
  });

  it("names a failed mount without a reason rather than answering an empty error", () => {
    const reply = toWorkerReply({ kind: "mount", ok: false });
    expect(reply).toMatchObject({ ok: false, code: "mount_failed" });
    expect(reply.ok === false && reply.error.length > 0).toBe(true);
  });

  it("maps a successful toggle, including the disabled state", () => {
    expect(toWorkerReply({ kind: "toggle", ok: true, enabled: false })).toEqual({
      ok: true,
      enabled: false,
    });
    expect(toWorkerReply({ kind: "toggle", ok: true, enabled: true })).toEqual({
      ok: true,
      enabled: true,
    });
    expect(toWorkerReply({ kind: "toggle", ok: true })).toEqual({ ok: true });
  });

  it("maps a failed toggle to toggle_failed, with a reason even when none was given", () => {
    expect(
      toWorkerReply({ kind: "toggle", ok: false, error: "the layer is not on this page" }),
    ).toEqual({ ok: false, code: "toggle_failed", error: "the layer is not on this page" });
    const reply = toWorkerReply({ kind: "toggle", ok: false });
    expect(reply).toMatchObject({ ok: false, code: "toggle_failed" });
    expect(reply.ok === false && reply.error.length > 0).toBe(true);
  });

  it("passes a refused dispatch through with its own code", () => {
    for (const code of ["no_tab", "invalid_tab_id", "foreign_sender"] as const) {
      expect(toWorkerReply({ kind: "refused", code, error: `refused: ${code}` })).toEqual({
        ok: false,
        code,
        error: `refused: ${code}`,
      });
    }
  });

  it("returns a value for every outcome — the boundary is the reply, not an exception", () => {
    const outcomes: WorkerOutcome[] = [
      { kind: "mount", ok: true, tabUrl: "https://a.example" },
      { kind: "mount", ok: false, error: "injection failed" },
      { kind: "toggle", ok: true, enabled: true },
      { kind: "toggle", ok: false, error: "no layer" },
      { kind: "refused", code: "no_tab", error: "no tab" },
      { kind: "refused", code: "invalid_tab_id", error: "invalid" },
      { kind: "refused", code: "foreign_sender", error: "foreign" },
    ];
    for (const outcome of outcomes) {
      let reply: WorkerReply | undefined;
      expect(() => {
        reply = toWorkerReply(outcome);
      }).not.toThrow();
      expect(reply).toBeDefined();
    }
  });

  it("answers AC-B38's three failed paths with their named code", () => {
    expect(toWorkerReply({ kind: "refused", code: "invalid_tab_id", error: "tab 0" })).toMatchObject(
      { ok: false, code: "invalid_tab_id" },
    );
    expect(
      toWorkerReply({ kind: "toggle", ok: false, error: "cannot access chrome://settings" }),
    ).toMatchObject({ ok: false, code: "toggle_failed" });
    expect(
      toWorkerReply({ kind: "mount", ok: false, error: "executeScript rejected" }),
    ).toMatchObject({ ok: false, code: "mount_failed" });
  });
});

describe("badgeForReport — only the memory-only mount gets a badge (AC-B39)", () => {
  it("marks the memory-only mount and names the cause in the title", () => {
    const badge = badgeForReport({
      kind: "mounted",
      ok: false,
      error: "memory-only: this origin has no persistent note store",
    });
    expect(badge).toEqual({
      text: "mem",
      title: expect.stringContaining("memory-only: this origin has no persistent note store"),
    });
    expect(badge?.text).toBe("mem");
    expect(badge?.title.toLowerCase()).toContain("memory-only");
  });

  it("ignores every other report", () => {
    expect(badgeForReport({ kind: "mounted", ok: true })).toBeNull();
    expect(badgeForReport({ kind: "mounted", ok: false, error: "no storage key" })).toBeNull();
    expect(badgeForReport({ kind: "mounted", ok: false })).toBeNull();
    expect(badgeForReport({ kind: "mounted" })).toBeNull();
    expect(badgeForReport({ kind: "toggled", ok: true })).toBeNull();
    expect(badgeForReport({ kind: "host-embed-detected" })).toBeNull();
    expect(badgeForReport({ kind: "mounted", ok: false, error: "Memory-only: capitalised" })).toBeNull();
  });
});
