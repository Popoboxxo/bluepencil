/**
 * @vitest-environment node — the script is imported by URL and driven with an injected `fetch`, so the
 * assertions are about the requests themselves, not about a mocked module surface.
 *
 * Two things are being protected here:
 *
 *   - the upload path must be the default and must *not* publish (RC-4, AC-I03). A release job that
 *     accidentally publishes is not recoverable by re-running — the store only takes a version once.
 *   - the credentials must flow through the environment only (AC-I02). The refresh token used to be an
 *     input of a marketplace action; a test that pinned the workflow text would not notice a token
 *     reappearing in argv or in a `with:` block, so both the script and the workflow are read.
 *
 * The module is plain, untyped ESM, resolved by URL so no hand-written `.d.mts` can drift from it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface FakeRequest {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

interface FakeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

interface RunOptions {
  argv?: string[];
  env?: Record<string, string | undefined>;
  fetchImpl?: unknown;
  readFileImpl?: (path: string) => Promise<Buffer>;
  log?: (line: string) => void;
  report?: (line: string) => void;
}

interface WebstoreModule {
  EXIT: { ok: number; usage: number; token: number; upload: number; publish: number; check: number };
  ENV: Record<string, string>;
  ENDPOINTS: {
    token: string;
    upload(publisherId: string, extensionId: string): string;
    publish(publisherId: string, extensionId: string): string;
    status(publisherId: string, extensionId: string): string;
  };
  assertZipBytes(zip: Buffer, path: string): Buffer;
  parseArgs(argv: string[]): {
    zip?: string;
    publish: boolean;
    checkCredentials: boolean;
    dryRun: boolean;
    help: boolean;
  };
  run(options?: RunOptions): Promise<number>;
}

// Plain, untyped ESM: resolved by URL at run time so no hand-written `.d.mts` can drift from it.
const scriptModuleUrl: string = new URL("../../scripts/chrome-webstore.mjs", import.meta.url).href;
const webstore = (await import(scriptModuleUrl)) as WebstoreModule;
const { ENDPOINTS, EXIT, ENV, assertZipBytes, parseArgs, run } = webstore;

const root = new URL("../../", import.meta.url);
const readRepoFile = (relativePath: string): string => readFileSync(new URL(relativePath, root), "utf8");

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);

const ENVIRONMENT: Record<string, string> = {
  [ENV.clientId as string]: "fixture-client-id",
  [ENV.clientSecret as string]: "fixture-client-secret-value",
  [ENV.refreshToken as string]: "fixture-refresh-token-value",
  [ENV.extensionId as string]: "abcdefghijklmnopabcdefghijklmnop",
  [ENV.publisherId as string]: "fixture-publisher-id",
};

interface Harness {
  requests: FakeRequest[];
  lines: string[];
  errors: string[];
  options: RunOptions;
}

/** Replies by URL: the token endpoint first, then each store endpoint in turn. */
function harness(replies: Partial<Record<string, FakeResponse>> = {}): Harness {
  const requests: FakeRequest[] = [];
  const lines: string[] = [];
  const errors: string[] = [];

  const fetchImpl = async (url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
    requests.push({ url, method: init.method ?? "GET", body: init.body, headers: init.headers ?? {} });
    const reply =
      url === ENDPOINTS.token
        ? replies.token
        : url.includes(":publish")
          ? replies.publish
          : url.includes(":upload")
            ? replies.upload
            : url.includes(":fetchStatus")
              ? replies.status
              : undefined;
    if (reply) return reply;
    if (url === ENDPOINTS.token) return json({ access_token: "fixture-access-token" });
    return json({});
  };

  return {
    requests,
    lines,
    errors,
    options: {
      env: { ...ENVIRONMENT },
      fetchImpl,
      readFileImpl: async () => ZIP,
      log: (line) => lines.push(line),
      report: (line) => errors.push(line),
    },
  };
}

function json(body: unknown, status = 200): FakeResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

const publishes = (requests: FakeRequest[]): FakeRequest[] =>
  requests.filter((request) => request.url.includes(":publish"));
const uploads = (requests: FakeRequest[]): FakeRequest[] =>
  requests.filter((request) => request.url.includes(":upload"));

describe("upload vs publish (AC-I03)", () => {
  it("uploads only, and makes no publish request, when --publish is absent", async () => {
    const h = harness();
    const code = await run({ ...h.options, argv: ["--zip", "bluepencil-extension-1.2.3.zip"] });

    expect(code).toBe(EXIT.ok);
    expect(h.requests.map((request) => request.url)).toEqual([
      ENDPOINTS.token,
      ENDPOINTS.upload("fixture-publisher-id", "abcdefghijklmnopabcdefghijklmnop"),
    ]);
    expect(publishes(h.requests)).toHaveLength(0);
    expect(h.lines.join("\n")).toMatch(/upload-only/);
  });

  it("makes exactly one publish request when --publish is passed", async () => {
    const h = harness();
    const code = await run({ ...h.options, argv: ["--zip", "bluepencil-extension-1.2.3.zip", "--publish"] });

    expect(code).toBe(EXIT.ok);
    expect(uploads(h.requests)).toHaveLength(1);
    expect(publishes(h.requests)).toHaveLength(1);
    expect(publishes(h.requests)[0]?.method).toBe("POST");
  });

  it("uploads the zip bytes, not a path", async () => {
    const h = harness();
    await run({ ...h.options, argv: ["--zip", "extension.zip"] });
    expect(uploads(h.requests)[0]?.body).toBe(ZIP);
  });

  it("makes no request at all in --dry-run, and still reports the mode", async () => {
    const h = harness();
    const code = await run({ ...h.options, argv: ["--zip", "extension.zip", "--publish", "--dry-run"] });

    expect(code).toBe(EXIT.ok);
    expect(h.requests).toEqual([]);
    expect(h.lines.join("\n")).toMatch(/upload \+ publish/);
    expect(h.lines.join("\n")).toMatch(/no request made/);
  });

  it("a dry run without --publish says it would not publish", async () => {
    const h = harness();
    await run({ ...h.options, argv: ["--zip", "extension.zip", "--dry-run"] });
    expect(h.lines.join("\n")).toMatch(/RC-4: no publish request/);
  });
});

describe("check-credentials mode", () => {
  it("reads the item status and writes nothing", async () => {
    const h = harness();
    const code = await run({ ...h.options, argv: ["--check-credentials"] });

    expect(code).toBe(EXIT.ok);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]?.method).toBe("GET");
    expect(h.requests[1]?.url).toBe(
      ENDPOINTS.status("fixture-publisher-id", "abcdefghijklmnopabcdefghijklmnop"),
    );
    expect(uploads(h.requests)).toHaveLength(0);
    expect(publishes(h.requests)).toHaveLength(0);
  });

  it("fails with the credential exit code when the item is not visible", async () => {
    const h = harness({ status: json({ error: { message: "insufficient permission" } }, 403) });
    const code = await run({ ...h.options, argv: ["--check-credentials"] });

    expect(code).toBe(EXIT.check);
    expect(h.errors.join("\n")).toMatch(/insufficient permission/);
  });
});

describe("stable exit codes", () => {
  it("rejects a missing environment variable before any request", async () => {
    const h = harness();
    const env = { ...ENVIRONMENT };
    delete env[ENV.refreshToken as string];

    const code = await run({ ...h.options, env, argv: ["--zip", "extension.zip"] });
    expect(code).toBe(EXIT.usage);
    expect(h.requests).toEqual([]);
    expect(h.errors.join("\n")).toContain(ENV.refreshToken);
  });

  it("rejects a file that is not a zip", async () => {
    const h = harness();
    const code = await run({
      ...h.options,
      readFileImpl: async () => Buffer.from("not a zip at all"),
      argv: ["--zip", "fake.zip"],
    });
    expect(code).toBe(EXIT.usage);
    expect(h.requests).toEqual([]);
  });

  it("rejects an empty file", async () => {
    const h = harness();
    const code = await run({ ...h.options, readFileImpl: async () => Buffer.alloc(0), argv: ["--zip", "empty.zip"] });
    expect(code).toBe(EXIT.usage);
  });

  it("rejects a missing --zip before it reads anything", async () => {
    const h = harness();
    expect(await run({ ...h.options, argv: [] })).toBe(EXIT.usage);
    expect(await run({ ...h.options, argv: ["--zip"] })).toBe(EXIT.usage);
    expect(await run({ ...h.options, argv: ["--nonsense"] })).toBe(EXIT.usage);
    expect(await run({ ...h.options, argv: ["--publish", "--check-credentials", "--zip", "a.zip"] })).toBe(
      EXIT.usage,
    );
  });

  it("maps a refused token exchange to 2, and says why", async () => {
    const h = harness({ token: json({ error: "invalid_grant", error_description: "Token has been expired" }, 400) });
    const code = await run({ ...h.options, argv: ["--zip", "extension.zip"] });

    expect(code).toBe(EXIT.token);
    expect(h.requests).toHaveLength(1);
    expect(h.errors.join("\n")).toMatch(/Token has been expired/);
  });

  it("maps a refused upload to 3 and a refused publish to 4", async () => {
    const uploadFailure = harness({ upload: json({ itemError: [{ error_code: "ITEM_NOT_UPDATABLE" }] }, 400) });
    expect(await run({ ...uploadFailure.options, argv: ["--zip", "extension.zip"] })).toBe(EXIT.upload);
    expect(uploadFailure.errors.join("\n")).toMatch(/ITEM_NOT_UPDATABLE/);

    const publishFailure = harness({
      upload: json({ uploadState: "SUCCESS" }),
      publish: json({ status: ["ITEM_NOT_FOUND"] }),
    });
    expect(
      await run({ ...publishFailure.options, argv: ["--zip", "extension.zip", "--publish"] }),
    ).toBe(EXIT.publish);
    expect(publishFailure.errors.join("\n")).toMatch(/ITEM_NOT_FOUND/);
  });

  it("treats an upload that the store has not finished as accepted, not as a failure", async () => {
    const h = harness({ upload: json({ uploadState: "UPLOAD_IN_PROGRESS" }) });
    expect(await run({ ...h.options, argv: ["--zip", "extension.zip"] })).toBe(EXIT.ok);
    expect(h.lines.join("\n")).toMatch(/still processing/);
  });

  it("never prints the OAuth credentials — the item and publisher ids are not secrets", async () => {
    const h = harness();
    await run({ ...h.options, argv: ["--zip", "extension.zip", "--publish"] });
    const output = [...h.lines, ...h.errors].join("\n");
    for (const name of [ENV.clientId, ENV.clientSecret, ENV.refreshToken]) {
      expect(output).not.toContain(ENVIRONMENT[name as string]);
    }
  });
});

describe("argv and env", () => {
  it("has no flag for a credential — the token only ever comes from the environment", () => {
    for (const flag of ["--client-id", "--client-secret", "--refresh-token", "--token", "--publisher-id"]) {
      expect(() => parseArgs(["--zip", "a.zip", flag, "value"])).toThrow(/unknown argument/);
    }
  });

  it("requires a zip unless the run is a credential check", () => {
    expect(() => parseArgs(["--publish"])).toThrow(/--zip/);
    expect(parseArgs(["--check-credentials"]).checkCredentials).toBe(true);
  });

  it("checks the zip magic instead of trusting the file name", () => {
    expect(() => assertZipBytes(Buffer.from("PK-not-really"), "x.zip")).toThrow(/not a zip/);
    expect(assertZipBytes(ZIP, "x.zip")).toBe(ZIP);
  });
});

describe("the workflow this repository ships (AC-I02)", () => {
  const workflow = readRepoFile(".github/workflows/chrome-webstore.yml");

  it("no longer hands the refresh token to a marketplace action", () => {
    expect(workflow).not.toContain("wdzeng/chrome-extension");
  });

  it("calls the in-repo script for all three modes", () => {
    expect(workflow).toContain("node scripts/chrome-webstore.mjs --check-credentials");
    expect(workflow).toContain("node scripts/chrome-webstore.mjs --zip store-asset/*.zip");
    expect(workflow).toContain("node scripts/chrome-webstore.mjs --zip store-asset/*.zip --publish");
  });

  it("passes every credential as an environment reference, never as a literal or an input", () => {
    const credentialLines = workflow
      .split("\n")
      .filter((line) => /CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN|EXTENSION_ID|PUBLISHER_ID/.test(line));
    expect(credentialLines.length).toBeGreaterThanOrEqual(5);
    for (const line of credentialLines) {
      expect(line).toMatch(/^\s+WEBSTORE_[A-Z_]+: \$\{\{ secrets\.[A-Z_]+ \}\}$/);
    }
    expect(workflow).not.toMatch(/^\s+(client-id|client-secret|refresh-token):/m);
  });

  it("states RC-4: the first run on this path is upload-only", () => {
    expect(workflow).toMatch(/RC-4/);
    expect(workflow).toMatch(/upload-only/);
  });
});

describe("docs/RELEASING.md", () => {
  const doc = readRepoFile("docs/RELEASING.md");

  it("documents the in-repo script and the credential source", () => {
    expect(doc).toContain("scripts/chrome-webstore.mjs");
    expect(doc).toContain("`REFRESH_TOKEN`");
  });

  it("carries RC-4 as a mandatory step: upload-only first, publish after the dashboard release", () => {
    expect(doc).toMatch(/\*\*RC-4[^*]*\*\*/);
    expect(doc).toMatch(/upload-only/);
    expect(doc).toMatch(/dashboard/);
    expect(doc).toMatch(/protected `release`\s+environment/);
  });

  it("wires the npm scripts the doc and the workflow name", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["webstore:publish"]).toBe("node scripts/chrome-webstore.mjs");
  });
});
