/**
 * Chrome Web Store upload/publish (SEC-22, G10, AC-I02, AC-I03).
 *
 * This replaces the marketplace action the store leg used to call. The reason is the refresh token: an
 * action receives it as an input and runs inside the action's own code, which this repository neither
 * reviews nor pins beyond a tag. Here the token stays in the job's environment, is exchanged for an
 * access token, and is used by code in this repository — readable, reviewable, and rehearsable
 * locally with `--dry-run` before it can touch the store.
 *
 * Three modes, and the default is deliberately the one that cannot publish:
 *
 *   (no flag)          upload the zip as the next version and stop. The item stays a draft; a human
 *                      releases it in the dashboard. This is release-checklist point RC-4: the first
 *                      run of this path stages, it does not ship.
 *   --publish          upload, then exactly one publish request. A release dispatch uses this.
 *   --check-credentials  read the item's status; touches nothing. Proves the token, the publisher id
 *                      and the item id belong together before a release needs them.
 *
 * Authentication is an OAuth2 refresh-token exchange — the documented Chrome Web Store API flow
 * (`https://developer.chrome.com/docs/webstore/using-api`). Nothing is read from argv except paths and
 * flags: a credential on the command line ends up in the process table and in the run log.
 *
 * Exit codes are stable, so the workflow and a human can tell the failures apart without reading logs:
 *
 *   0  ok
 *   1  usage or configuration (missing env var, unreadable or non-zip file, bad flag)
 *   2  token exchange refused
 *   3  upload refused
 *   4  publish refused
 *   5  credential check refused
 *
 * No dependencies (NFR-4); Node >= 22 for global `fetch`.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** Documented v2 endpoints. Constants so the tests can assert the exact call shape. */
export const ENDPOINTS = {
  token: "https://oauth2.googleapis.com/token",
  upload: (publisherId, extensionId) =>
    `https://chromewebstore.googleapis.com/upload/v2/publishers/${publisherId}/items/${extensionId}:upload`,
  publish: (publisherId, extensionId) =>
    `https://chromewebstore.googleapis.com/v2/publishers/${publisherId}/items/${extensionId}:publish`,
  status: (publisherId, extensionId) =>
    `https://chromewebstore.googleapis.com/v2/publishers/${publisherId}/items/${extensionId}:fetchStatus`,
};

/** Stable, documented exit codes (see the header). */
export const EXIT = { ok: 0, usage: 1, token: 2, upload: 3, publish: 4, check: 5 };

/** The environment variable names. Values, never flags. */
export const ENV = {
  clientId: "WEBSTORE_CLIENT_ID",
  clientSecret: "WEBSTORE_CLIENT_SECRET",
  refreshToken: "WEBSTORE_REFRESH_TOKEN",
  extensionId: "WEBSTORE_EXTENSION_ID",
  publisherId: "WEBSTORE_PUBLISHER_ID",
};

const TIMEOUT_MS = 120_000;
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04"

export class WebstoreError extends Error {
  /**
   * @param {string} message
   * @param {number} code one of EXIT
   */
  constructor(message, code) {
    super(message);
    this.name = "WebstoreError";
    this.code = code;
  }
}

function usage() {
  return [
    "usage: node scripts/chrome-webstore.mjs --zip <extension.zip> [--publish]",
    "       node scripts/chrome-webstore.mjs --check-credentials",
    "       node scripts/chrome-webstore.mjs --zip <extension.zip> --dry-run",
    "",
    "  (no flag)            upload only — stages the version, publishes nothing (RC-4)",
    "  --publish            upload, then one publish request (review + release)",
    "  --check-credentials  read the item status; touches nothing",
    "  --dry-run            print the plan, make no request",
    "",
    `credentials come from ${ENV.clientId}, ${ENV.clientSecret}, ${ENV.refreshToken},`,
    `${ENV.extensionId} and ${ENV.publisherId} — never from argv`,
  ].join("\n");
}

/**
 * @param {string[]} argv
 * @returns {{ zip?: string, publish: boolean, checkCredentials: boolean, dryRun: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  const options = { publish: false, checkCredentials: false, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--zip" || argument === "-z") {
      const value = argv[index + 1];
      if (!value) throw new WebstoreError("--zip needs a path", EXIT.usage);
      options.zip = value;
      index += 1;
    } else if (argument === "--publish") {
      options.publish = true;
    } else if (argument === "--check-credentials") {
      options.checkCredentials = true;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new WebstoreError(`unknown argument: ${argument}`, EXIT.usage);
    }
  }
  if (options.publish && options.checkCredentials) {
    throw new WebstoreError("--publish and --check-credentials are different runs", EXIT.usage);
  }
  if (!options.checkCredentials && !options.help && !options.zip) {
    throw new WebstoreError("--zip <extension.zip> is required (or --check-credentials)", EXIT.usage);
  }
  return options;
}

/**
 * All five values must be present before the first request: a run that fails halfway has already
 * spent a token exchange, and the message should name the missing variable, not the HTTP status.
 * @param {Record<string, string | undefined>} env
 */
export function readConfig(env) {
  const missing = [ENV.clientId, ENV.clientSecret, ENV.refreshToken, ENV.extensionId, ENV.publisherId]
    .filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new WebstoreError(`missing environment variable(s): ${missing.join(", ")}`, EXIT.usage);
  }
  return {
    clientId: env[ENV.clientId],
    clientSecret: env[ENV.clientSecret],
    refreshToken: env[ENV.refreshToken],
    extensionId: env[ENV.extensionId],
    publisherId: env[ENV.publisherId],
  };
}

async function readBody(response) {
  const text = await response.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** Turn an API error payload into one readable line; the payload shapes differ between endpoints. */
function describeFailure(body) {
  if (body && typeof body === "object") {
    if (typeof body.error_description === "string") return body.error_description;
    if (body.error && typeof body.error === "object" && body.error.message) return body.error.message;
    if (typeof body.error === "string") return body.error;
    if (Array.isArray(body.itemError) && body.itemError.length > 0) {
      return body.itemError
        .map((entry) => entry?.error_detail ?? entry?.error_code ?? JSON.stringify(entry))
        .join("; ");
    }
    if (typeof body.message === "string") return body.message;
    if (typeof body.raw === "string") return body.raw.slice(0, 400);
  }
  return "no detail in the response body";
}

/**
 * Exchange the refresh token for an access token.
 * @param {{ clientId: string, clientSecret: string, refreshToken: string }} config
 * @param {typeof fetch} fetchImpl
 */
export async function requestAccessToken(config, fetchImpl) {
  const form = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: "refresh_token",
  });

  let response;
  try {
    response = await fetchImpl(ENDPOINTS.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new WebstoreError(
      `token exchange failed: ${error instanceof Error ? error.message : error}`,
      EXIT.token,
    );
  }

  const body = await readBody(response);
  if (!response.ok || typeof body.access_token !== "string") {
    throw new WebstoreError(
      `token exchange refused (HTTP ${response.status}): ${describeFailure(body)}`,
      EXIT.token,
    );
  }
  return body.access_token;
}

/**
 * Upload the package. No publish request is made here — that is a separate, explicit call.
 * @param {{ extensionId: string, publisherId: string }} config
 * @param {string} token
 * @param {Buffer} zip
 * @param {typeof fetch} fetchImpl
 */
export async function uploadPackage(config, token, zip, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(ENDPOINTS.upload(config.publisherId, config.extensionId), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/zip",
        "x-goog-api-version": "4",
      },
      body: zip,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new WebstoreError(
      `upload failed: ${error instanceof Error ? error.message : error}`,
      EXIT.upload,
    );
  }

  const body = await readBody(response);
  if (!response.ok) {
    throw new WebstoreError(`upload refused (HTTP ${response.status}): ${describeFailure(body)}`, EXIT.upload);
  }
  const state = body?.uploadState;
  if (typeof state === "string" && state !== "SUCCESS" && state !== "UPLOAD_IN_PROGRESS") {
    throw new WebstoreError(`upload not accepted: ${state}`, EXIT.upload);
  }
  return { state: typeof state === "string" ? state : "SUCCESS", body };
}

/**
 * Publish the uploaded version. Exactly one request, made only when `--publish` was passed.
 * @param {{ extensionId: string, publisherId: string }} config
 * @param {string} token
 * @param {typeof fetch} fetchImpl
 */
export async function publishItem(config, token, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(ENDPOINTS.publish(config.publisherId, config.extensionId), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-goog-api-version": "4",
      },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new WebstoreError(
      `publish failed: ${error instanceof Error ? error.message : error}`,
      EXIT.publish,
    );
  }

  const body = await readBody(response);
  if (!response.ok) {
    throw new WebstoreError(
      `publish refused (HTTP ${response.status}): ${describeFailure(body)}`,
      EXIT.publish,
    );
  }
  if (Array.isArray(body?.status) && !body.status.includes("OK")) {
    throw new WebstoreError(`publish not accepted: ${body.status.join(", ")}`, EXIT.publish);
  }
  return body;
}

/**
 * Read the item's status. The only call that proves the credentials without changing anything.
 * @param {{ extensionId: string, publisherId: string }} config
 * @param {string} token
 * @param {typeof fetch} fetchImpl
 */
export async function fetchStatus(config, token, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(ENDPOINTS.status(config.publisherId, config.extensionId), {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, "x-goog-api-version": "4" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new WebstoreError(
      `status request failed: ${error instanceof Error ? error.message : error}`,
      EXIT.check,
    );
  }

  const body = await readBody(response);
  if (!response.ok) {
    throw new WebstoreError(
      `status request refused (HTTP ${response.status}): ${describeFailure(body)}`,
      EXIT.check,
    );
  }
  return body;
}

/** A zip, not just a path: a text file here would be uploaded and rejected by the store, later. */
export function assertZipBytes(zip, path) {
  if (zip.length === 0) throw new WebstoreError(`${path} is empty`, EXIT.usage);
  const looksLikeZip = ZIP_MAGIC.every((byte, index) => zip[index] === byte);
  if (!looksLikeZip) throw new WebstoreError(`${path} is not a zip archive`, EXIT.usage);
  return zip;
}

/* -------------------------------------------------------------------------- */

/**
 * The whole run, injectable so the unit test can assert the exact requests without a network or a
 * real zip on disk.
 * @param {{
 *   argv?: string[],
 *   env?: Record<string, string | undefined>,
 *   fetchImpl?: typeof fetch,
 *   readFileImpl?: typeof readFile,
 *   log?: (line: string) => void,
 *   report?: (line: string) => void,
 * }} options
 * @returns {Promise<number>} exit code
 */
export async function run({
  argv = [],
  env = process.env,
  fetchImpl = globalThis.fetch,
  readFileImpl = readFile,
  log = console.log,
  report = console.error,
} = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    report(error instanceof WebstoreError ? error.message : String(error));
    report(usage());
    return EXIT.usage;
  }

  if (options.help) {
    log(usage());
    return EXIT.ok;
  }

  let config;
  let zip;
  try {
    config = readConfig(env);
    if (options.zip) {
      zip = assertZipBytes(await readFileImpl(options.zip), options.zip);
    }
  } catch (error) {
    report(error instanceof WebstoreError ? error.message : String(error));
    return error instanceof WebstoreError ? error.code : EXIT.usage;
  }

  const plan = options.checkCredentials
    ? `check-credentials for item ${config.extensionId} (publisher ${config.publisherId}) — no write`
    : `${options.publish ? "upload + publish" : "upload only (RC-4: no publish request)"} ${options.zip} ` +
      `(${zip.length} B) as item ${config.extensionId} (publisher ${config.publisherId})`;
  log(`chrome-webstore: ${plan}`);

  if (options.dryRun) {
    log("chrome-webstore: dry run — no request made");
    return EXIT.ok;
  }

  try {
    const token = await requestAccessToken(config, fetchImpl);

    if (options.checkCredentials) {
      const status = await fetchStatus(config, token, fetchImpl);
      const state = status?.lastAsyncUploadState ?? status?.uploadState ?? status?.state;
      log(`chrome-webstore: credentials are valid${state ? ` (item state: ${state})` : ""}`);
      return EXIT.ok;
    }

    const uploaded = await uploadPackage(config, token, zip, fetchImpl);
    log(
      uploaded.state === "UPLOAD_IN_PROGRESS"
        ? "chrome-webstore: upload accepted and still processing — the store reports the outcome in the dashboard"
        : "chrome-webstore: upload accepted",
    );

    if (!options.publish) {
      log(
        "chrome-webstore: upload-only run — the version is staged, not published. " +
          "Re-run with --publish once the dashboard release is approved (RC-4).",
      );
      return EXIT.ok;
    }

    await publishItem(config, token, fetchImpl);
    log("chrome-webstore: publish request accepted — the store submits the version for review");
    return EXIT.ok;
  } catch (error) {
    if (error instanceof WebstoreError) {
      report(`chrome-webstore: ${error.message}`);
      return error.code;
    }
    report(`chrome-webstore: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.usage;
  }
}

/* v8 ignore next 3 — exercised through `npm run webstore:publish`, not by importing the module. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run({ argv: process.argv.slice(2) });
}
