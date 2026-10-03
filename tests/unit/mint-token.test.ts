/**
 * @vitest-environment node — mints real tokens with `node:crypto`, exactly as the issuer does.
 *
 * Minting a token (`bluepencil token`, #36 phase 2).
 *
 * The hub half of phase 2 is covered by `hub-tokens.test.ts` and `server-token-wiring.test.ts`.
 * This covers the half in between: the command a human runs to get a token in the first place.
 *
 * The two properties that matter most here are the ones a user would hit immediately and a security
 * review would not: an unknown scope word must not be silently dropped, and the output must be
 * capturable by a shell. Both are easy to get wrong and invisible until someone loses a note or a
 * token lands in a file with a help message in it.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { mintToken, parseScope } from "../../server/mint";
import { runTokenCommand } from "../../server/mint-cli";
import { createTokenIssuer } from "../../server/tokens";

const KEY = "signing-key-fixture-1";

afterEach(() => {
  delete process.env.BLUEPENCIL_TOKEN_KEY;
});

describe("scope words", () => {
  it("defaults to both when nothing is said", () => {
    expect(parseScope(undefined)).toEqual(["read", "write"]);
    expect(parseScope("")).toEqual(["read", "write"]);
  });

  it("accepts either scope on its own", () => {
    expect(parseScope("read")).toEqual(["read"]);
    expect(parseScope("write")).toEqual(["read", "write"]);
  });

  it("treats order and separators as noise", () => {
    // Nobody should be told off for writing `write read` or `read,write`; both say the same thing.
    expect(parseScope("write read")).toEqual(["read", "write"]);
    expect(parseScope("read,write")).toEqual(["read", "write"]);
    expect(parseScope("read  write")).toEqual(["read", "write"]);
  });

  it("refuses an unknown word instead of ignoring it", () => {
    // The dangerous version of this: quietly dropping `wrte` would issue a read-only token that
    // looks fine and loses every write. An error at mint time costs a second.
    const result = parseScope("read wrte");

    expect(typeof result).toBe("string");
    if (typeof result === "string") expect(result).toMatch(/unknown scope wrte/);
  });

  it("never issues a token that can do nothing", () => {
    // There is no scope that means "no access", and there should not be one: an empty token would
    // fail every request with a 403 and read as a broken hub.
    for (const input of ["read", "write", "read write"]) {
      const result = parseScope(input);
      if (Array.isArray(result)) expect(result.length).toBeGreaterThan(0);
    }
  });
});

describe("minting", () => {
  it("produces a token the same key verifies", () => {
    const result = mintToken({ key: KEY, device: "work-laptop" });

    const verdict = createTokenIssuer({ key: KEY, newId: () => "x" }).verify(result.token, "read");

    expect(verdict.ok).toBe(true);
  });

  it("records the device name, because a revocation list has to be readable", () => {
    // An id on its own is unauditable. The name is what turns `["a1b2…"]` into `["work-laptop"]`.
    const result = mintToken({ key: KEY, device: "  work-laptop  " });

    expect(result.device).toBe("work-laptop");
  });

  it("prints the id a revocation list records", () => {
    const result = mintToken({ key: KEY, device: "d" }, { newId: () => "jti-known" });

    expect(result.id).toBe("jti-known");
  });

  it("reports when the token expires, in a form a person can read", () => {
    const result = mintToken({ key: KEY, device: "d" }, { now: () => new Date("2026-09-29T12:00:00.000Z") });

    expect(result.expiresAt).toBe("2026-09-30T12:00:00.000Z");
  });

  it("refuses without a key, rather than signing with nothing", () => {
    expect(() => mintToken({ key: "", device: "d" })).toThrow(/signing key/);
  });

  it("refuses without a device name, because the claims would be unauditable", () => {
    expect(() => mintToken({ key: KEY, device: "   " })).toThrow(/device name/);
  });

  it("mints distinct tokens for the same device, so each can be revoked alone", () => {
    let n = 0;
    const options = { newId: (): string => `jti-${(n += 1)}` };

    const first = mintToken({ key: KEY, device: "laptop" }, options);
    const second = mintToken({ key: KEY, device: "laptop" }, options);

    expect(first.token).not.toBe(second.token);
    expect(first.id).not.toBe(second.id);
  });
});

describe("the command", () => {
  function capture(): { out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });
    return { out, err };
  }

  function stdout(captured: { out: string[] }): string {
    return captured.out.join("");
  }

  it("prints the token on stdout and nothing else, so a shell can capture it", async () => {
    // The split is the whole point of the command's shape: `export X=$(bluepencil token --device …)`
    // has to produce a token and not a token followed by four lines of help.
    process.env.BLUEPENCIL_TOKEN_KEY = KEY;
    const captured = capture();

    const code = await runTokenCommand(["--device", "work-laptop"]);

    expect(code).toBe(0);
    const printed = stdout(captured);
    expect(printed.trimEnd().split("\n")).toHaveLength(1);
    expect(printed.split(".")).toHaveLength(3);
  });

  it("puts the context on stderr, where a person reads it and a shell ignores it", async () => {
    process.env.BLUEPENCIL_TOKEN_KEY = KEY;
    const captured = capture();

    await runTokenCommand(["--device", "work-laptop"]);

    const context = captured.err.join("");
    expect(context).toMatch(/expires:/);
    // The revocation id is the one thing an operator must not have to decode a JWT to find.
    expect(context).toMatch(/revoked-tokens/);
  });

  it("names both ways to supply a key when neither is set", async () => {
    const captured = capture();

    const code = await runTokenCommand(["--device", "d"]);

    expect(code).toBe(2);
    const said = captured.err.join("");
    expect(said).toMatch(/BLUEPENCIL_TOKEN_KEY/);
    // Saying this is a different secret from --auth-secret prevents the most likely wrong guess.
    expect(said).toMatch(/--auth-secret/);
  });

  it("refuses an empty key rather than minting something signed with nothing", async () => {
    process.env.BLUEPENCIL_TOKEN_KEY = "";
    capture();

    const code = await runTokenCommand(["--device", "d"]);

    expect(code).toBe(2);
  });

  it("refuses an unknown scope word, and mints nothing", async () => {
    process.env.BLUEPENCIL_TOKEN_KEY = KEY;
    const captured = capture();

    const code = await runTokenCommand(["--device", "d", "--scope", "read wrte"]);

    expect(code).toBe(2);
    // Nothing on stdout is the part that matters: a half-minted credential in a variable is worse
    // than a visible error.
    expect(stdout(captured)).toBe("");
  });

  it("refuses a missing device name, and says why it is not optional", async () => {
    process.env.BLUEPENCIL_TOKEN_KEY = KEY;
    const captured = capture();

    const code = await runTokenCommand([]);

    expect(code).toBe(2);
    expect(captured.err.join("")).toMatch(/--device/);
  });

  it("refuses a TTL that is not a positive whole number", async () => {
    process.env.BLUEPENCIL_TOKEN_KEY = KEY;
    capture();

    for (const bad of ["0", "-5", "forever"]) {
      expect(await runTokenCommand(["--device", "d", "--ttl", bad]), bad).toBe(2);
    }
  });

  it("accepts --key= as well as --key", async () => {
    const captured = capture();

    const code = await runTokenCommand(["--device", "d", `--key=${KEY}`]);

    expect(code).toBe(0);
    expect(stdout(captured).split(".")).toHaveLength(3);
  });

  it("mints a token the token-configured hub would accept", async () => {
    // End to end, with no server: the command's output goes through the real verifier, which is the
    // only assertion that ties the two halves of phase 2 together.
    process.env.BLUEPENCIL_TOKEN_KEY = KEY;
    const captured = capture();
    await runTokenCommand(["--device", "work-laptop", "--ttl", "3600"]);

    const verdict = createTokenIssuer({ key: KEY, newId: () => "x" }).verify(
      stdout(captured).trim(),
      "write",
    );

    expect(verdict.ok).toBe(true);
  });

  it("mints a read-only token when asked, and a hub refuses its writes", async () => {
    process.env.BLUEPENCIL_TOKEN_KEY = KEY;
    const captured = capture();
    await runTokenCommand(["--device", "viewer", "--scope", "read"]);

    const issuer = createTokenIssuer({ key: KEY, newId: () => "x" });
    const token = stdout(captured).trim();

    expect(issuer.verify(token, "read").ok).toBe(true);
    expect(issuer.verify(token, "write")).toEqual({
      ok: false,
      reason: "insufficient-scope",
    });
  });

  it("prints help without needing a key", async () => {
    const captured = capture();

    const code = await runTokenCommand(["--help"]);

    expect(code).toBe(0);
    expect(stdout(captured)).toMatch(/--device/);
  });
});
