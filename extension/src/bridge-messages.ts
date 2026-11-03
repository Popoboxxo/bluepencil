/**
 * The page-facing message vocabulary — what the bridge accepts, and what the worker answers with.
 *
 * The page's `postMessage` channel is open to every script on the page, so the bridge has to tell a
 * well-formed request from a spoofed one *before* a branch runs. The types and the one pure check
 * live here (not in `bridge.ts`) so they can be unit-tested without a DOM, a `chrome` object or a
 * message listener, and so the worker side can share the reply vocabulary.
 *
 * Two rules matter for the envelope:
 *
 *  - the storage branch is strict: the per-origin key comes from the bridge's own
 *    `window.location`, so a page-supplied `origin` or `key` is not a field of this message and is
 *    refused as `foreign_field` — never stripped and then silently accepted (SEC-13);
 *  - the fetch branch ignores unknown fields on purpose: the worker is its trust boundary
 *    (`hub-fetch.ts`) and this hop has no policy to apply. The request itself therefore stays
 *    `unknown` here instead of being re-typed and re-validated.
 *
 * The bridge does not require a `requestId`: an untagged mount/toggle/storage request is legal and
 * gets an untagged answer. The fetch relay is the one branch that names its refusal when the id is
 * missing (`invalid_request`), and `bridge.ts` answers that before forwarding.
 */
import { PAGE_FETCH_KIND } from "./hub-fetch";

/** Message kinds a page may post on the bridge channel. */
export const PAGE_MESSAGE_KINDS: readonly string[] = [
  "request-mount",
  "toggle",
  "storage",
  PAGE_FETCH_KIND,
];

/** The operations the page storage relay understands. */
export const STORAGE_OPS: readonly string[] = ["get", "set", "remove"];

export type PageMessageKind = "request-mount" | "toggle" | "storage" | typeof PAGE_FETCH_KIND;

/**
 * A page message after the envelope check has accepted it.
 *
 * `requestId` stays optional on every branch because the bridge never required it; only the fetch
 * relay branch answers `invalid_request` when it is absent. `request` stays `unknown` for the same
 * reason the check ignores its contents: the worker validates it.
 */
export type PageEnvelope =
  | {
      source: "bluepencil-page";
      kind: "request-mount";
      force?: boolean;
      requestId?: string;
    }
  | {
      source: "bluepencil-page";
      kind: "toggle";
      enabled?: boolean;
      requestId?: string;
    }
  | {
      source: "bluepencil-page";
      kind: "storage";
      op: "get" | "set" | "remove";
      keys?: string | string[];
      items?: Record<string, unknown>;
      requestId?: string;
    }
  | {
      source: "bluepencil-page";
      kind: typeof PAGE_FETCH_KIND;
      requestId?: string;
      request?: unknown;
    };

/** The storage branch's two named refusals; the worker branch keeps its own codes. */
export type EnvelopeCheck =
  | { ok: true; envelope: PageEnvelope }
  | { ok: false; code: "invalid_envelope" | "foreign_field"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the page-facing message envelope before anything is relayed (B.1/B.6).
 *
 * The rules are deliberately asymmetric:
 * - the source tag and the kind are required, every other branch tolerates its own optional fields
 *   (`requestId`, `force`, `enabled`, `request`);
 * - the **storage** branch is strict: `origin` and `key` are not fields of this message (the key
 *   comes from the bridge's own location, SEC-13), and `op`/`keys`/`items` must have the shape the
 *   relay will use. A page that sends the removed fields gets a named `foreign_field`, never a
 *   silent strip;
 * - the fetch branch deliberately ignores unknown fields — the worker is its trust boundary
 *   (`hub-fetch.ts`), so this hop has nothing to decide about them.
 *
 * On success the returned `envelope` contains only the fields this check validated (plus the
 * opaque `request`), so every later branch reads a typed value instead of casting the raw message.
 */
export function checkPageEnvelope(data: unknown): EnvelopeCheck {
  if (!isRecord(data)) {
    return { ok: false, code: "invalid_envelope", message: "a page message must be an object" };
  }
  if (data.source !== "bluepencil-page") {
    return {
      ok: false,
      code: "invalid_envelope",
      message: "a page message must carry the bluepencil-page source tag",
    };
  }
  const kind = data.kind;
  if (typeof kind !== "string" || !PAGE_MESSAGE_KINDS.includes(kind)) {
    return { ok: false, code: "invalid_envelope", message: "unknown page message kind" };
  }

  const requestId = typeof data.requestId === "string" ? data.requestId : undefined;

  if (kind === "request-mount") {
    return {
      ok: true,
      envelope: {
        source: "bluepencil-page",
        kind: "request-mount",
        ...(typeof data.force === "boolean" ? { force: data.force } : {}),
        ...(requestId === undefined ? {} : { requestId }),
      },
    };
  }

  if (kind === "toggle") {
    return {
      ok: true,
      envelope: {
        source: "bluepencil-page",
        kind: "toggle",
        ...(typeof data.enabled === "boolean" ? { enabled: data.enabled } : {}),
        ...(requestId === undefined ? {} : { requestId }),
      },
    };
  }

  if (kind === PAGE_FETCH_KIND) {
    return {
      ok: true,
      envelope: {
        source: "bluepencil-page",
        kind: PAGE_FETCH_KIND,
        ...(requestId === undefined ? {} : { requestId }),
        ...(data.request === undefined ? {} : { request: data.request }),
      },
    };
  }

  if ("origin" in data || "key" in data) {
    return {
      ok: false,
      code: "foreign_field",
      message: "a page storage message may not carry origin or key",
    };
  }
  const op = data.op;
  if (typeof op !== "string" || !STORAGE_OPS.includes(op)) {
    return {
      ok: false,
      code: "invalid_envelope",
      message: "a page storage message needs the operation get, set or remove",
    };
  }
  if (op === "set") {
    if (!isRecord(data.items)) {
      return { ok: false, code: "invalid_envelope", message: "a storage write needs an items object" };
    }
    return {
      ok: true,
      envelope: {
        source: "bluepencil-page",
        kind: "storage",
        op: "set",
        items: data.items,
        ...(requestId === undefined ? {} : { requestId }),
      },
    };
  }
  if (
    typeof data.keys !== "string" &&
    !(Array.isArray(data.keys) && data.keys.every((key) => typeof key === "string"))
  ) {
    return {
      ok: false,
      code: "invalid_envelope",
      message: "a storage read or remove needs a key or a list of keys",
    };
  }
  return {
    ok: true,
    envelope: {
      source: "bluepencil-page",
      kind: "storage",
      op: op as "get" | "remove",
      keys: data.keys as string | string[],
      ...(requestId === undefined ? {} : { requestId }),
    },
  };
}

/**
 * What the worker tells a caller after a mount, a toggle or a tab-binding refusal (B.5/B.6).
 *
 * A refusal is a value, never an exception: `dispatchTabMessage` returns it, `chrome.runtime`
 * forwards it, and the toolbar path logs it. `code` is the stable part a caller may branch on;
 * `error` is the human-readable reason and never carries note content.
 */
export type WorkerReply =
  | { ok: true; enabled?: boolean; tabUrl?: string }
  | {
      ok: false;
      code: "no_tab" | "invalid_tab_id" | "foreign_sender" | "mount_failed" | "toggle_failed";
      error: string;
    };

/** The internal outcome of a mount, a toggle or a refused dispatch, before it becomes a reply. */
export type WorkerOutcome =
  | { kind: "mount"; ok: boolean; tabUrl?: string; error?: string }
  | { kind: "toggle"; ok: boolean; enabled?: boolean; error?: string }
  | { kind: "refused"; code: "no_tab" | "invalid_tab_id" | "foreign_sender"; error: string };

/**
 * Map an outcome to the reply the worker sends (AC-B38).
 *
 * Failure codes are named per operation (`mount_failed`, `toggle_failed`) and both carry a message
 * even when the outcome has none — a caller should never have to invent a reason. The function
 * cannot throw: every branch returns a value.
 */
export function toWorkerReply(outcome: WorkerOutcome): WorkerReply {
  switch (outcome.kind) {
    case "refused":
      return { ok: false, code: outcome.code, error: outcome.error };
    case "mount":
      if (outcome.ok) {
        return {
          ok: true,
          ...(typeof outcome.tabUrl === "string" && outcome.tabUrl !== ""
            ? { tabUrl: outcome.tabUrl }
            : {}),
        };
      }
      return {
        ok: false,
        code: "mount_failed",
        error: outcome.error ?? "the layer did not mount",
      };
    case "toggle":
      if (outcome.ok) {
        return {
          ok: true,
          ...(typeof outcome.enabled === "boolean" ? { enabled: outcome.enabled } : {}),
        };
      }
      return {
        ok: false,
        code: "toggle_failed",
        error: outcome.error ?? "the layer could not be switched",
      };
  }
}

/** What the toolbar badge shows for a MAIN-world report, or `null` when the report needs no badge. */
export interface BadgeSpec {
  text: "mem";
  title: string;
}

/** The report `bootstrap.ts` sends when the origin has no persistent storage key (B.6, RVW-16). */
const MEMORY_ONLY_PREFIX = "memory-only";

/**
 * Turn a MAIN-world report into badge text and title, or `null` when nothing should be shown.
 *
 * Only the memory-only mount report gets a badge (`mem`). The title repeats the reported cause, so
 * the user learns *why* the notes will not survive a reload rather than just seeing an abbreviation.
 * Every other report (a successful mount, a failed mount, a toggle, a host embed) returns `null`:
 * those already have their own channel, and a badge that says nothing would only be noise.
 */
export function badgeForReport(report: {
  kind: string;
  ok?: boolean;
  error?: string;
}): BadgeSpec | null {
  if (report.kind !== "mounted" || report.ok !== false) return null;
  const error = typeof report.error === "string" ? report.error : "";
  if (!error.startsWith(MEMORY_ONLY_PREFIX)) return null;
  return {
    text: "mem",
    title: `Bluepencil — notes are memory-only on this page (${error})`,
  };
}
