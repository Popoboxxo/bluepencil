/**
 * @vitest-environment node — the env fallback reads `process.env`, which jsdom does not shape.
 *
 * `bluepencil mcp` write lock (FR-16.2). The regression under test: `--allow-write false` used to
 * evaluate `true` because the entry only probed presence with `Array.includes`. Every spelling the
 * parser accepts (and every spelling it must refuse) is pinned here, including the env fallback and
 * its fail-closed behaviour.
 */
import { afterEach, describe, expect, it } from "vitest";

import { allowWriteFromEnv, parseMcpArgs } from "../../src/mcp/options";

const STORE = ["--store", "notes.bluepencil.json"] as const;

/** Parses with an isolated environment so the host's variables cannot leak into a case. */
function parse(args: readonly string[], env: NodeJS.ProcessEnv = {}): boolean {
  const parsed = parseMcpArgs([...STORE, ...args], env);
  if (typeof parsed === "string") throw new Error(`Expected options, got usage: ${parsed}`);
  return parsed.allowWrite;
}

/** Parses a case that must fail and returns the usage string. */
function usage(args: readonly string[], env: NodeJS.ProcessEnv = {}): string {
  const parsed = parseMcpArgs([...STORE, ...args], env);
  if (typeof parsed !== "string") throw new Error("Expected a usage error, got valid options");
  return parsed;
}

const savedAllowWrite = process.env["BLUEPENCIL_ALLOW_WRITE"];

afterEach(() => {
  /* Restore the one variable this file writes through the default-arg path. */
  if (savedAllowWrite === undefined) delete process.env["BLUEPENCIL_ALLOW_WRITE"];
  else process.env["BLUEPENCIL_ALLOW_WRITE"] = savedAllowWrite;
});

describe("parseMcpArgs — --allow-write is parsed, not probed", () => {
  it("enables writes with the bare flag", () => {
    expect(parse(["--allow-write"])).toBe(true);
  });

  it("enables writes with --allow-write=true", () => {
    expect(parse(["--allow-write=true"])).toBe(true);
  });

  it("enables writes with BLUEPENCIL_ALLOW_WRITE=1", () => {
    expect(parse([], { BLUEPENCIL_ALLOW_WRITE: "1" })).toBe(true);
  });

  it("disables writes with --allow-write=false", () => {
    expect(parse(["--allow-write=false"])).toBe(false);
  });

  it("disables writes with --allow-write false (the old fail-open regression)", () => {
    expect(parse(["--allow-write", "false"])).toBe(false);
  });

  it("disables writes for BLUEPENCIL_ALLOW_WRITE=0, false and empty", () => {
    expect(parse([], { BLUEPENCIL_ALLOW_WRITE: "0" })).toBe(false);
    expect(parse([], { BLUEPENCIL_ALLOW_WRITE: "false" })).toBe(false);
    expect(parse([], { BLUEPENCIL_ALLOW_WRITE: "" })).toBe(false);
  });

  it("disables writes when neither the flag nor the variable is present", () => {
    expect(parse([], {})).toBe(false);
  });

  it("treats an unparseable flag value as a usage error", () => {
    expect(usage(["--allow-write=maybe"])).toBe(
      '--allow-write must be true or false (got "maybe")',
    );
    expect(usage(["--allow-write", "maybe"])).toBe(
      '--allow-write must be true or false (got "maybe")',
    );
    /* `booleanFlag` only knows `true`/`false`; the shell-numeric form is not silently accepted. */
    expect(usage(["--allow-write=1"])).toBe('--allow-write must be true or false (got "1")');
  });

  it("lets an explicit flag win over the environment", () => {
    expect(parse(["--allow-write=false"], { BLUEPENCIL_ALLOW_WRITE: "1" })).toBe(false);
    expect(parse(["--allow-write=true"], { BLUEPENCIL_ALLOW_WRITE: "0" })).toBe(true);
  });

  it("keeps the env fallback fail-closed for unrecognised values", () => {
    /* Only "1" opens the write lock; `true`/`yes`/a typo stays read-only. */
    expect(allowWriteFromEnv("true")).toBe(false);
    expect(allowWriteFromEnv("yes")).toBe(false);
    expect(allowWriteFromEnv(" 1")).toBe(false);
    expect(allowWriteFromEnv(undefined)).toBe(false);
  });

  it("reads process.env when no environment is injected", () => {
    process.env["BLUEPENCIL_ALLOW_WRITE"] = "1";
    const parsed = parseMcpArgs([...STORE]);
    expect(parsed).not.toBeTypeOf("string");
    expect((parsed as { allowWrite: boolean }).allowWrite).toBe(true);
  });
});

describe("parseMcpArgs — a value flag never consumes the next flag (CR-02)", () => {
  it("refuses `--store --allow-write` instead of storing the flag and enabling writes", () => {
    const parsed = parseMcpArgs(["--store", "--allow-write"], {
      BLUEPENCIL_ALLOW_WRITE: "1",
    });

    expect(parsed).toBe('--store requires a value (got "--allow-write")');
    /* Proven separately: the parse is a usage error, so no options object with `allowWrite:true`
     * can escape — writes stay OFF even though the env would enable them. */
    expect(typeof parsed).toBe("string");
  });

  it("refuses `--store --environment dev` naming --store", () => {
    expect(parseMcpArgs(["--store", "--environment", "dev"], {})).toBe(
      '--store requires a value (got "--environment")',
    );
  });

  it("refuses a bare `--store` with no value", () => {
    expect(parseMcpArgs(["--store"], {})).toBe("--store requires a value (got nothing)");
  });

  it("refuses an empty `--store=` value", () => {
    expect(parseMcpArgs(["--store="], {})).toBe('--store requires a value (got "")');
  });

  it("refuses a value flag whose value is another flag for every valued flag", () => {
    for (const flag of ["--environment", "--app", "--session-id"] as const) {
      expect(parseMcpArgs(["--store", "notes.json", flag, "--allow-write"], {})).toBe(
        `${flag} requires a value (got "--allow-write")`,
      );
    }
  });
});

describe("parseMcpArgs — the other entry options", () => {
  it("still requires --store", () => {
    const parsed = parseMcpArgs([], {});
    expect(parsed).toBe(
      "--store <path> is required (a .bluepencil.json bundle or a bare notes array)",
    );
  });

  it("reads --store/--environment/--app/--session-id", () => {
    const parsed = parseMcpArgs(
      [
        "--store",
        "notes.json",
        "--environment",
        "staging",
        "--app",
        "Review Pad",
        "--session-id",
        "s-7",
      ],
      {},
    );
    expect(parsed).toEqual({
      storePath: "notes.json",
      environment: "staging",
      appName: "Review Pad",
      allowWrite: false,
      sessionId: "s-7",
    });
  });
});
