/**
 * Unit tests for qualified federation ids (FR-16.11, plan §6): first-slash parsing, the reserved
 * names `self`/`all`/`*`, the no-slash-in-note-id rule and path-traversal rejection (T01–T04, T40).
 */

import { describe, expect, it } from "vitest";

import { FederationError } from "../../src/federation/errors";
import {
  INSTANCE_ID_PATTERN,
  RESERVED_IDS,
  RESERVED_INSTANCES,
  SELECTOR_INSTANCES,
  SELF_INSTANCE,
  assertFederatableNoteId,
  assertInstanceId,
  formatQualifiedId,
  isReservedInstance,
  isSelectorInstance,
  isValidInstanceId,
  parseQualifiedId,
  parseRef,
  qualify,
} from "../../src/federation/ids";

/** Runs `run` and asserts it throws `FederationError("invalid_id")`; returns the error. */
function expectInvalidId(run: () => unknown): FederationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(FederationError);
    const federationError = error as FederationError;
    expect(federationError.code).toBe("invalid_id");
    return federationError;
  }
  throw new Error("expected FederationError('invalid_id')");
}

describe("ids.parse.first_slash_only", () => {
  it("splits at the first slash and keeps the rest in the note id", () => {
    expect(parseQualifiedId("dev/n-1/x")).toEqual({ instance: "dev", noteId: "n-1/x" });
  });

  it("keeps a note id with a slash unfederatable", () => {
    expectInvalidId(() => assertFederatableNoteId("n-1/x"));
  });

  it("returns null for unqualified ids", () => {
    expect(parseQualifiedId("n-1")).toBeNull();
    expect(parseQualifiedId("")).toBeNull();
  });

  it("exports parseRef as an alias of parseQualifiedId", () => {
    expect(parseRef).toBe(parseQualifiedId);
  });
});

describe("ids.reject_slash_in_note_id", () => {
  it("throws invalid_id and never truncates the note id", () => {
    const error = expectInvalidId(() => formatQualifiedId("dev", "a/b"));
    expect(error.message).toContain("a/b");
  });

  it("accepts a note id without a slash", () => {
    expect(formatQualifiedId("dev", "a-b")).toBe("dev/a-b");
  });
});

describe("ids.reserved_instances", () => {
  it("rejects selectors as format targets", () => {
    expectInvalidId(() => formatQualifiedId("all", "n-1"));
    expectInvalidId(() => formatQualifiedId("*", "n-1"));
  });

  it("allows self as a read alias and a format target", () => {
    expect(formatQualifiedId("self", "n-1")).toBe("self/n-1");
  });

  it("classifies reserved names", () => {
    expect(isReservedInstance("self")).toBe(true);
    expect(isReservedInstance("all")).toBe(true);
    expect(isReservedInstance("*")).toBe(true);
    expect(isReservedInstance("dev")).toBe(false);
    expect(isSelectorInstance("all")).toBe(true);
    expect(isSelectorInstance("*")).toBe(true);
    expect(isSelectorInstance("self")).toBe(false);
    expect(isSelectorInstance("dev")).toBe(false);
  });

  it("still parses selectors deliberately (permissive parse, strict format)", () => {
    expect(parseQualifiedId("all/n-1")).toEqual({ instance: "all", noteId: "n-1" });
    expect(parseQualifiedId("*/n-1")).toEqual({ instance: "*", noteId: "n-1" });
  });

  it("rejects selectors in assertInstanceId while allowing self", () => {
    expect(() => assertInstanceId("self")).not.toThrow();
    expectInvalidId(() => assertInstanceId("all"));
    expectInvalidId(() => assertInstanceId("*"));
    expect(isValidInstanceId("self")).toBe(true);
    expect(isValidInstanceId("all")).toBe(false);
  });

  it("exposes the reserved constants", () => {
    expect(SELF_INSTANCE).toBe("self");
    expect(SELECTOR_INSTANCES).toEqual(["all", "*"]);
    expect(RESERVED_INSTANCES).toEqual(["self", "all", "*"]);
    expect(RESERVED_IDS).toBe(RESERVED_INSTANCES);
    expect(INSTANCE_ID_PATTERN.test("staging-web")).toBe(true);
    expect(INSTANCE_ID_PATTERN.test("Dev")).toBe(false);
  });
});

describe("ids.format_roundtrip", () => {
  it("round-trips concrete instances and self", () => {
    const instances = ["dev", "self", "staging-web", "a.b_c-d"];
    const noteIds = ["n-1", "n-x.y"];
    for (const instance of instances) {
      for (const noteId of noteIds) {
        expect(parseQualifiedId(formatQualifiedId(instance, noteId))).toEqual({ instance, noteId });
      }
    }
  });

  it("rejects selectors as format targets", () => {
    expectInvalidId(() => formatQualifiedId("all", "n-1"));
    expectInvalidId(() => formatQualifiedId("*", "n-1"));
  });

  it("exports qualify as an alias of formatQualifiedId", () => {
    expect(qualify).toBe(formatQualifiedId);
  });
});

describe("security.qualified_id_no_path_traversal", () => {
  it("rejects traversal and malformed qualified ids at parse time", () => {
    expect(parseQualifiedId("../etc/passwd")).toBeNull();
    expect(parseQualifiedId("dev/..")).toBeNull();
    expect(parseQualifiedId("/n-1")).toBeNull();
    expect(parseQualifiedId("dev/")).toBeNull();
    expect(parseQualifiedId("dev/a\\b")).toBeNull();
    expect(parseQualifiedId("dev/%2F")).toBeNull();
    expect(parseQualifiedId("dev/%2f")).toBeNull();
    expect(parseQualifiedId("Dev/n-1")).toBeNull();
  });

  it("rejects traversal-shaped note parts but keeps the permissive multi-segment parse (T01)", () => {
    // Empty segment, embedded `..` and percent-encoded `..` are all rejected.
    expect(parseQualifiedId("dev//x")).toBeNull();
    expect(parseQualifiedId("dev/n-1/../x")).toBeNull();
    expect(parseQualifiedId("dev/%2e%2e/x")).toBeNull();
    // A multi-segment note id that names no traversal stays valid (T01).
    expect(parseQualifiedId("dev/n-1/x")).toEqual({ instance: "dev", noteId: "n-1/x" });
  });

  it("rejects traversal and encoded separators at format time", () => {
    expectInvalidId(() => formatQualifiedId("dev", "%2F"));
    expectInvalidId(() => formatQualifiedId("dev", "%2f"));
    expectInvalidId(() => formatQualifiedId("dev", "a\\b"));
    expectInvalidId(() => formatQualifiedId("dev", ""));
    expectInvalidId(() => formatQualifiedId("dev", "."));
    expectInvalidId(() => formatQualifiedId("dev", ".."));
  });

  it("rejects invalid instance ids", () => {
    expectInvalidId(() => formatQualifiedId("Dev", "n-1"));
    expectInvalidId(() => formatQualifiedId("dev/x", "n-1"));
    expectInvalidId(() => formatQualifiedId("", "n-1"));
  });

  it("keeps valid ids working", () => {
    expect(parseQualifiedId("staging-web/n-1")).toEqual({ instance: "staging-web", noteId: "n-1" });
    expect(formatQualifiedId("a.b_c-d", "n-x.y")).toBe("a.b_c-d/n-x.y");
  });
});

describe("N-03 format/parse consistency", () => {
  it("round-trips every id that formatQualifiedId accepts", () => {
    const pairs: readonly (readonly [string, string])[] = [
      ["dev", "n-1"],
      ["self", "n-1"],
      ["staging-web", "n-x.y"],
      ["a.b_c-d", "note_1"],
      ["dev", "a%20b"],
      ["dev", "n%2E1"],
    ];
    for (const [instance, noteId] of pairs) {
      expect(parseQualifiedId(formatQualifiedId(instance, noteId)), noteId).toEqual({
        instance,
        noteId,
      });
    }
  });

  it("rejects the same traversal-shaped note ids at format and parse time", () => {
    for (const noteId of ["%2e%2e", "%2e", "a%2fb", "a%2Fb", "a//b", ".", ".."]) {
      expectInvalidId(() => formatQualifiedId("dev", noteId));
      expect(parseQualifiedId(`dev/${noteId}`), noteId).toBeNull();
    }
  });

  it("rejects percent-encoded backslashes and malformed escapes consistently", () => {
    expectInvalidId(() => formatQualifiedId("dev", "a%5cb"));
    expect(parseQualifiedId("dev/a%5cb")).toBeNull();

    expectInvalidId(() => formatQualifiedId("dev", "100%"));
    expect(parseQualifiedId("dev/100%")).toBeNull();
  });
});
