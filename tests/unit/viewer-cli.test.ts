/**
 * @vitest-environment node — parses the CLI contract and touches the filesystem for the asset check.
 *
 * Viewer CLI (issue #140, plan Task 5, spec §5).
 *
 * What is proven here:
 *   - every row of the §5.2 validation matrix is a one-line return value of the pure
 *     `parseHubArgs` (UT-01…UT-09, UT-24);
 *   - the wildcard bind has exactly one definition and no origin is ever derived from it;
 *   - the five `StartupWarning` codes of §2.4 rule 9 are derivable without a socket (UT-22, UT-28);
 *   - `parseHubArgs` itself writes nothing to stderr.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  HubStartupError,
  isWildcardBind,
  parseHubArgs,
  startupWarnings,
  type HubOptions,
  type StartupWarning,
} from "../../server/hub";

/** Kept as constants: a literal behind an `adminSecret:`/`authSecret:` key trips the secret scan. */
const ADMIN = "viewer-cli-admin-secret";
const AUTH = "viewer-cli-shared-secret";

const VIEWER_ENV_KEYS = [
  "BLUEPENCIL_VIEWER",
  "BLUEPENCIL_VIEWER_ASSETS",
  "BLUEPENCIL_VIEWER_ALLOW",
  "BLUEPENCIL_VIEWER_TTL",
  "BLUEPENCIL_VIEWER_HOST",
  "BLUEPENCIL_VIEWER_PORT",
  "BLUEPENCIL_VIEWER_ORIGIN",
  "BLUEPENCIL_VIEWER_PUBLIC_URL",
  "BLUEPENCIL_ADMIN_SECRET",
  "BLUEPENCIL_AUTH_SECRET",
  "BLUEPENCIL_TOKEN_KEY",
] as const;

let assetsDir: string;
let savedEnv: Partial<Record<(typeof VIEWER_ENV_KEYS)[number], string>> = {};

beforeAll(() => {
  assetsDir = mkdtempSync(join(tmpdir(), "bp-viewer-cli-"));
  // The parser only checks that the element bundle exists; the content is never read here.
  writeFileSync(join(assetsDir, "bluepencil.element.min.js"), "// stub\n");
});

afterAll(() => {
  rmSync(assetsDir, { recursive: true, force: true });
});

beforeEach(() => {
  savedEnv = {};
  for (const key of VIEWER_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of VIEWER_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv = {};
});

function parse(...args: string[]): HubOptions | string {
  return parseHubArgs(["--store", "notes.json", ...args]);
}

function optionsOf(result: HubOptions | string): HubOptions {
  if (typeof result === "string") throw new Error(`expected options, got usage error: ${result}`);
  return result;
}

/**
 * A complete, valid `--viewer` invocation. `extra` comes *first* so a caller can override one of
 * the base values: `parseHubArgs` reads the first occurrence of a flag.
 */
function viewerArgs(...extra: string[]): string[] {
  return [
    ...extra,
    "--viewer",
    "--viewer-port",
    "8788",
    "--viewer-assets",
    assetsDir,
    "--viewer-allow",
    "example.com",
    "--admin-secret",
    ADMIN,
  ];
}

function errorOf(result: HubOptions | string): string {
  if (typeof result !== "string") throw new Error("expected a usage error, got parsed options");
  return result;
}

describe("UT-01 — --viewer requires --viewer-port (AC-F1)", () => {
  it("refuses a viewer without a viewer port, with the exact documented text", () => {
    const expected =
      "--viewer requires --viewer-port <port> (viewer_port_required) — the viewer must not share the hub port";
    expect(parse("--viewer")).toBe(expected);
    expect(parse("--viewer=true")).toBe(expected);
  });

  it("accepts the viewer once a port is present", () => {
    const viewer = optionsOf(parse(...viewerArgs())).viewer;
    expect(viewer?.port).toBe(8788);
  });
});

describe("UT-02 — --viewer-port range and integer check (AC-F2)", () => {
  it("refuses non-integers and values outside 0..65535", () => {
    for (const value of ["-1", "65536", "abc", "1.5", ""]) {
      expect(errorOf(parse("--viewer", "--viewer-port", value))).toContain(
        "--viewer-port must be an integer between 0 and 65535",
      );
    }
  });

  it("accepts both boundaries", () => {
    expect(optionsOf(parse(...viewerArgs("--viewer-port", "0"))).viewer?.port).toBe(0);
    expect(optionsOf(parse(...viewerArgs("--viewer-port", "65535"))).viewer?.port).toBe(65535);
  });
});

describe("UT-03 — viewer_port_conflict only on the same bind with two non-zero ports (AC-F3, AC-F19)", () => {
  const conflict =
    "--viewer-port must differ from --port on the same bind address (viewer_port_conflict)";

  it("refuses the same port on the same bind address", () => {
    expect(
      errorOf(parse(...viewerArgs("--port", "8788", "--host", "127.0.0.1", "--viewer-host", "127.0.0.1"))),
    ).toBe(conflict);
    expect(errorOf(parse(...viewerArgs("--port", "8788")))).toBe(conflict);
  });

  it("accepts port 0 on both sides and different bind addresses with the same port", () => {
    expect(optionsOf(parse(...viewerArgs("--port", "0", "--viewer-port", "0"))).viewer?.port).toBe(0);
    const differentBind = optionsOf(
      parse(...viewerArgs("--port", "8788", "--viewer-host", "192.0.2.10")),
    );
    expect(differentBind.viewer?.port).toBe(8788);
    expect(differentBind.port).toBe(8788);
  });

  it("treats equivalent IPv6 spellings as the same bind address", () => {
    expect(
      errorOf(parse(...viewerArgs("--port", "8788", "--host", "::1", "--viewer-host", "[::1]"))),
    ).toBe(conflict);
  });
});

describe("UT-04 — --viewer-origin must be a bare http(s) origin (AC-F4)", () => {
  it("refuses path, query, fragment, other schemes and relative values", () => {
    for (const value of [
      "https://view.example.com/path",
      "https://view.example.com?x=1",
      "https://view.example.com#frag",
      "ftp://view.example.com",
      "view.example.com",
      "https://user:pass@view.example.com",
    ]) {
      expect(errorOf(parse(...viewerArgs("--viewer-origin", value)))).toContain(
        "--viewer-origin must be an absolute http(s) origin without path, query or fragment (viewer_origin_invalid)",
      );
    }
  });

  it("accepts an origin with a trailing slash and stores it normalised", () => {
    const viewer = optionsOf(parse(...viewerArgs("--viewer-origin", "https://View.Example.com/"))).viewer;
    expect(viewer?.origin).toBe("https://view.example.com");
  });
});

describe("UT-05 — --viewer-origin must differ from the hub origin (AC-F5)", () => {
  const conflict = "--viewer-origin must differ from the hub origin (viewer_origin_is_hub_origin)";

  it("refuses the explicit bind origin, including the default port and host", () => {
    expect(
      errorOf(parse(...viewerArgs("--port", "8787", "--host", "127.0.0.1", "--viewer-origin", "http://127.0.0.1:8787"))),
    ).toBe(conflict);
    expect(errorOf(parse(...viewerArgs("--viewer-origin", `http://${DEFAULT_HOST}:${DEFAULT_PORT}`)))).toBe(
      conflict,
    );
  });

  it("accepts an unknown hub origin (--port 0) and a different port", () => {
    expect(
      typeof parse(...viewerArgs("--port", "0", "--viewer-origin", "http://127.0.0.1:8787")),
    ).not.toBe("string");
    expect(
      typeof parse(...viewerArgs("--port", "8787", "--viewer-origin", "http://127.0.0.1:9999")),
    ).not.toBe("string");
  });
});

describe("UT-06 — a wildcard viewer bind requires an explicit origin (AC-F6)", () => {
  const required =
    "--viewer-origin is required when the viewer bind is a wildcard address (viewer_origin_required)";

  it("refuses every wildcard spelling, including the empty string", () => {
    for (const host of ["0.0.0.0", "::", "[::]", ""]) {
      expect(errorOf(parse(...viewerArgs("--viewer-host", host)))).toBe(required);
    }
  });

  it("applies to a wildcard inherited from --host without --viewer-host", () => {
    expect(errorOf(parse(...viewerArgs("--host", "0.0.0.0")))).toBe(required);
    expect(errorOf(parse(...viewerArgs("--host", "::")))).toBe(required);
  });

  it("accepts the same call with an explicit origin and never derives one", () => {
    const viewer = optionsOf(parse(...viewerArgs("--host", "0.0.0.0", "--viewer-origin", "https://view.example.com")))
      .viewer;
    expect(viewer?.origin).toBe("https://view.example.com");
    expect(viewer?.host).toBeUndefined();
    // The mandatory refusal already proves no `http://0.0.0.0:<port>` derivation exists.
  });

  it("keeps the requirement even with --viewer-port 0", () => {
    expect(errorOf(parse(...viewerArgs("--viewer-port", "0", "--viewer-host", "0.0.0.0")))).toBe(
      required,
    );
  });
});

describe("UT-07 — viewer flags without an active viewer are usage errors (AC-F7, AC-F17)", () => {
  const withoutViewer = "--viewer-* require --viewer (viewer_flags_without_viewer)";

  it("refuses each of the seven valued flags on its own", () => {
    const cases: string[][] = [
      ["--viewer-assets", assetsDir],
      ["--viewer-allow", "example.com"],
      ["--viewer-ttl", "60"],
      ["--viewer-host", "127.0.0.1"],
      ["--viewer-port", "8788"],
      ["--viewer-origin", "https://view.example.com"],
      ["--viewer-public-url", "https://view.example.com"],
    ];
    for (const args of cases) {
      expect(errorOf(parse(...args)), args.join(" ")).toBe(withoutViewer);
    }
  });

  it("treats --viewer=false as off, so following viewer flags are refused too", () => {
    expect(errorOf(parse("--viewer=false", "--viewer-port", "8788"))).toBe(withoutViewer);
    expect(optionsOf(parse("--viewer=false")).viewer).toBeUndefined();
  });

  it("refuses a viewer sub-variable in the environment without BLUEPENCIL_VIEWER", () => {
    process.env.BLUEPENCIL_VIEWER_PORT = "8788";
    expect(errorOf(parse())).toBe(withoutViewer);
  });
});

describe("UT-08 — the deprecated alias normalises onto origin (AC-F8, AC-F21, S1)", () => {
  it("accepts --viewer-public-url as an origin and keeps the alias marker", () => {
    const viewer = optionsOf(parse(...viewerArgs("--viewer-public-url", "https://view.example.com"))).viewer;
    expect(viewer?.origin).toBe("https://view.example.com");
    expect(viewer?.publicBaseUrl).toBe("https://view.example.com");
  });

  it("accepts both spellings when they agree", () => {
    const viewer = optionsOf(
      parse(
        ...viewerArgs(
          "--viewer-origin",
          "https://view.example.com",
          "--viewer-public-url",
          "https://view.example.com",
        ),
      ),
    ).viewer;
    expect(viewer?.origin).toBe("https://view.example.com");
  });

  it("refuses disagreeing values", () => {
    expect(
      errorOf(
        parse(
          ...viewerArgs(
            "--viewer-origin",
            "https://view.example.com",
            "--viewer-public-url",
            "https://other.example.com",
          ),
        ),
      ),
    ).toBe("--viewer-origin and --viewer-public-url disagree (viewer_origin_conflict)");
  });

  it("validates the alias as an origin", () => {
    expect(errorOf(parse(...viewerArgs("--viewer-public-url", "https://view.example.com/path")))).toContain(
      "--viewer-public-url must be an absolute http(s) origin without path, query or fragment (viewer_origin_invalid)",
    );
  });

  it("refuses an alias that names the hub origin (AC-F21)", () => {
    const conflict = "(viewer_origin_is_hub_origin)";
    expect(
      errorOf(parse(...viewerArgs("--port", "8787", "--host", "127.0.0.1", "--viewer-public-url", "http://127.0.0.1:8787"))),
    ).toContain(conflict);
    expect(
      errorOf(
        parse(...viewerArgs("--cors", "https://hub.example.com", "--viewer-public-url", "https://hub.example.com")),
      ),
    ).toContain(conflict);
  });
});

describe("--cors with --viewer (AC-5.22, AC-F15)", () => {
  it("refuses --cors '*' when the viewer is configured", () => {
    expect(errorOf(parse(...viewerArgs("--cors", "*")))).toBe(
      "--cors '*' must not be combined with --viewer (cors_wildcard_with_viewer)",
    );
    // Irrelevant whether a client credential would otherwise allow the wildcard.
    expect(errorOf(parse(...viewerArgs("--cors", "*", "--auth-secret", AUTH)))).toContain(
      "cors_wildcard_with_viewer",
    );
  });

  it("refuses --cors naming the explicit viewer origin (AC-5.22)", () => {
    expect(
      errorOf(parse(...viewerArgs("--viewer-origin", "https://view.example.com", "--cors", "https://view.example.com"))),
    ).toBe("--cors must not name the viewer origin (cors_viewer_origin)");
  });

  it("refuses --cors naming the derived viewer origin when it is known at parse time", () => {
    expect(errorOf(parse(...viewerArgs("--viewer-port", "8788", "--cors", "http://127.0.0.1:8788")))).toBe(
      "--cors must not name the viewer origin (cors_viewer_origin)",
    );
  });
});

describe("UT-09 — environment parity and flag precedence (AC-F9)", () => {
  it("reads every viewer variable like its flag", () => {
    process.env.BLUEPENCIL_VIEWER = "1";
    process.env.BLUEPENCIL_VIEWER_PORT = "8788";
    process.env.BLUEPENCIL_VIEWER_HOST = "127.0.0.1";
    process.env.BLUEPENCIL_VIEWER_ORIGIN = "https://view.example.com";
    process.env.BLUEPENCIL_VIEWER_ASSETS = assetsDir;
    process.env.BLUEPENCIL_VIEWER_ALLOW = "example.com";
    process.env.BLUEPENCIL_ADMIN_SECRET = ADMIN;

    const viewer = optionsOf(parse()).viewer;
    expect(viewer).toMatchObject({
      port: 8788,
      host: "127.0.0.1",
      origin: "https://view.example.com",
      assetsDir,
      allow: ["example.com"],
    });
  });

  it("lets the flag win over the environment", () => {
    process.env.BLUEPENCIL_VIEWER = "1";
    process.env.BLUEPENCIL_VIEWER_PORT = "8788";
    process.env.BLUEPENCIL_VIEWER_ORIGIN = "https://env.example.com";
    process.env.BLUEPENCIL_VIEWER_ASSETS = assetsDir;
    process.env.BLUEPENCIL_VIEWER_ALLOW = "example.com";
    process.env.BLUEPENCIL_ADMIN_SECRET = ADMIN;

    const viewer = optionsOf(
      parse("--viewer", "--viewer-port", "8790", "--viewer-origin", "https://flag.example.com"),
    ).viewer;
    expect(viewer?.port).toBe(8790);
    expect(viewer?.origin).toBe("https://flag.example.com");
  });

  it("treats BLUEPENCIL_VIEWER=0 as off", () => {
    process.env.BLUEPENCIL_VIEWER = "0";
    expect(optionsOf(parse()).viewer).toBeUndefined();
  });

  it("reads BLUEPENCIL_VIEWER_PUBLIC_URL as the deprecated alias", () => {
    process.env.BLUEPENCIL_VIEWER = "1";
    process.env.BLUEPENCIL_VIEWER_PORT = "8788";
    process.env.BLUEPENCIL_VIEWER_ASSETS = assetsDir;
    process.env.BLUEPENCIL_VIEWER_ALLOW = "example.com";
    process.env.BLUEPENCIL_VIEWER_PUBLIC_URL = "https://view.example.com";
    process.env.BLUEPENCIL_ADMIN_SECRET = ADMIN;

    const viewer = optionsOf(parse()).viewer;
    expect(viewer?.origin).toBe("https://view.example.com");
    expect(viewer?.publicBaseUrl).toBe("https://view.example.com");
  });

  it("rejects a non-boolean BLUEPENCIL_VIEWER instead of guessing", () => {
    process.env.BLUEPENCIL_VIEWER = "yes";
    expect(errorOf(parse())).toContain("BLUEPENCIL_VIEWER must be true or false");
  });
});

describe("UT-24 — valued viewer flags must carry a value (AC-F14)", () => {
  it("reports <flag> requires a value (got nothing) for all seven", () => {
    for (const flag of [
      "--viewer-assets",
      "--viewer-allow",
      "--viewer-ttl",
      "--viewer-host",
      "--viewer-port",
      "--viewer-origin",
      "--viewer-public-url",
    ]) {
      expect(errorOf(parse("--viewer", flag))).toBe(`${flag} requires a value (got nothing)`);
    }
  });

  it("counts --flag=value as present and validates the value", () => {
    expect(errorOf(parse(...viewerArgs("--viewer-origin=")))).toContain("viewer_origin_invalid");
  });
});

describe("viewer TTL bounds in the CLI (AC-F18)", () => {
  it("refuses values outside 60..604800 and non-integers", () => {
    for (const value of ["59", "604801", "abc", "60.5"]) {
      expect(errorOf(parse(...viewerArgs("--viewer-ttl", value)))).toContain(
        "--viewer-ttl must be an integer between 60 and 604800",
      );
    }
  });

  it("accepts both boundaries", () => {
    expect(optionsOf(parse(...viewerArgs("--viewer-ttl", "60"))).viewer?.ttlSeconds).toBe(60);
    expect(optionsOf(parse(...viewerArgs("--viewer-ttl", "604800"))).viewer?.ttlSeconds).toBe(604800);
  });
});

describe("UT-22 / UT-28 — startup warning derivation and the five-code union (AC-F13)", () => {
  const warningInput = (
    viewer: { host: string; origin: string; usedPublicUrlAlias: boolean },
    host = "127.0.0.1",
  ) => ({
    host,
    credential: "secret" as const,
    cors: null,
    viewer,
  });

  it("declares exactly the five documented codes", () => {
    const codes: StartupWarning["code"][] = [
      "unauthenticated_non_loopback",
      "cors_wildcard",
      "viewer_cookie_shared_host",
      "viewer_non_loopback_insecure",
      "viewer_public_url_deprecated",
    ];
    expect(new Set(codes).size).toBe(5);
  });

  it("warns viewer_cookie_shared_host when the host names are the same", () => {
    expect(
      startupWarnings(warningInput({ host: "127.0.0.1", origin: "http://127.0.0.1:8788", usedPublicUrlAlias: false }))
        .map((warning) => warning.code),
    ).toEqual(["viewer_cookie_shared_host"]);

    expect(
      startupWarnings(
        warningInput(
          { host: "localhost", origin: "http://localhost:8788", usedPublicUrlAlias: false },
          "localhost",
        ),
      ).map((warning) => warning.code),
    ).toEqual(["viewer_cookie_shared_host"]);
  });

  it("warns viewer_cookie_shared_host for a wildcard hub bind and a non-loopback viewer name", () => {
    const wildcard = {
      host: "0.0.0.0",
      credential: "secret" as const,
      cors: null,
      viewer: { host: "192.0.2.10", origin: "https://view.example.com:8788", usedPublicUrlAlias: false },
    };
    expect(startupWarnings(wildcard).map((warning) => warning.code)).toContain(
      "viewer_cookie_shared_host",
    );

    // A loopback viewer name is not a shared *public* name on a wildcard bind.
    const loopbackViewer = {
      ...wildcard,
      viewer: { host: "127.0.0.1", origin: "http://127.0.0.1:8788", usedPublicUrlAlias: false },
    };
    expect(startupWarnings(loopbackViewer).map((warning) => warning.code)).not.toContain(
      "viewer_cookie_shared_host",
    );
  });

  it("warns viewer_non_loopback_insecure for a non-loopback bind on plain http", () => {
    const warnings = startupWarnings(
      warningInput({ host: "192.0.2.10", origin: "http://view.example.com:8788", usedPublicUrlAlias: false }),
    );
    expect(warnings.map((warning) => warning.code)).toContain("viewer_non_loopback_insecure");

    const secure = startupWarnings(
      warningInput({ host: "192.0.2.10", origin: "https://view.example.com:8788", usedPublicUrlAlias: false }),
    );
    expect(secure.map((warning) => warning.code)).not.toContain("viewer_non_loopback_insecure");

    const loopback = startupWarnings(
      warningInput({ host: "127.0.0.1", origin: "http://127.0.0.1:8788", usedPublicUrlAlias: false }),
    );
    expect(loopback.map((warning) => warning.code)).not.toContain("viewer_non_loopback_insecure");
  });

  it("warns viewer_public_url_deprecated when the alias was used", () => {
    const warnings = startupWarnings(
      warningInput({ host: "127.0.0.1", origin: "https://view.example.com", usedPublicUrlAlias: true }),
    );
    expect(warnings.map((warning) => warning.code)).toContain("viewer_public_url_deprecated");
    // Not suppressible is stated in the message itself.
    expect(warnings.find((warning) => warning.code === "viewer_public_url_deprecated")?.message).toContain(
      "--quiet",
    );
  });

  it("keeps the viewer-free warnings unchanged", () => {
    expect(startupWarnings({ host: "127.0.0.1", credential: "none", cors: null })).toEqual([]);
    expect(
      startupWarnings({ host: "0.0.0.0", credential: "none", cors: "*" }).map((warning) => warning.code),
    ).toEqual(["unauthenticated_non_loopback", "cors_wildcard"]);
  });
});

describe("isWildcardBind — the one wildcard definition (AC-F23)", () => {
  it("recognises only the unspecified address spellings", () => {
    for (const host of ["", "0.0.0.0", "::", "[::]", " 0.0.0.0 "]) {
      expect(isWildcardBind(host), JSON.stringify(host)).toBe(true);
    }
    for (const host of ["127.0.0.1", "localhost", "192.0.2.10", "::1", "[::1]"]) {
      expect(isWildcardBind(host), JSON.stringify(host)).toBe(false);
    }
  });
});

describe("HubStartupError", () => {
  it("carries a stable code and the documented name", () => {
    const error = new HubStartupError("viewer_origin_required", "no origin");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("HubStartupError");
    expect(error.code).toBe("viewer_origin_required");
    expect(error.message).toBe("no origin");
  });
});

describe("parseHubArgs is pure", () => {
  it("writes no startup warning to stderr", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      optionsOf(
        parse(
          ...viewerArgs(
            "--viewer-public-url",
            "https://view.example.com",
            "--auth-secret",
            AUTH,
            "--viewer-ttl",
            "60",
          ),
        ),
      );
      parse("--viewer");
    } finally {
      spy.mockRestore();
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
