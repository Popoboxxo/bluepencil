/**
 * Runtime-update contract of the attach loader (FR-17) — manifest parsing, version resolution and
 * optional integrity verification.
 *
 * A host that wants to update bluepencil **without rebuilding itself** publishes two things:
 *
 *   /bluepencil/<version>/bluepencil.element.min.js   immutable, cache forever
 *   /bluepencil/latest.json                           no-store, the pointer
 *
 * `latest.json` is `{"version":"0.2.1","element":"<url>","sha256":"<hex>"}`. The loader reads the
 * pointer, compares it with the version it already mounted and swaps the layer when it changed.
 * Everything in this module is pure (except the injected `fetch` in `fetchBytes`/the compatibility
 * overload) so the contract is unit-testable without a browser.
 *
 * The digest is a **download check, not Subresource Integrity (G7)**: the loader hashes a separate
 * download and then imports the module normally, so the browser enforces nothing at execution time.
 * A digest from the manifest can be rewritten by whoever can rewrite the manifest; only the host pin
 * (`data-sha256` on the loader tag) is a trust anchor the host itself controls.
 */
import { isRecord } from "../core/adapter";

/** The pointer file a host publishes next to the versioned artifacts. */
export interface AttachManifest {
  version: string;
  /** Absolute or relative URL of the element build for that version. */
  element: string;
  /**
   * Optional hex SHA-256 of the element build; verified when `data-integrity` is set *and* no
   * `data-sha256` host pin is given (the pin wins).
   */
  sha256?: string;
}

/** Fallback element file name, used when neither `data-src` nor a manifest is given. */
const ELEMENT_FILE = "bluepencil.element.min.js";

/** Parses a manifest document; a malformed one is an issue, never a silent no-op. */
export function parseManifest(value: unknown): { manifest?: AttachManifest; issue?: string } {
  if (!isRecord(value)) {
    return { issue: "manifest must be a JSON object" };
  }
  const version = value.version;
  const element = value.element;
  if (typeof version !== "string" || version.trim() === "") {
    return { issue: "manifest.version must be a non-empty string" };
  }
  if (typeof element !== "string" || element.trim() === "") {
    return { issue: "manifest.element must be a non-empty string" };
  }
  const sha256 = value.sha256;
  if (sha256 !== undefined && (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(sha256))) {
    return { issue: "manifest.sha256 must be a 64-character hex digest" };
  }
  return {
    manifest: {
      version,
      element,
      ...(typeof sha256 === "string" ? { sha256: sha256.toLowerCase() } : {}),
    },
  };
}

/** Parses the manifest response body (text → manifest), reporting transport/shape problems. */
export function parseManifestText(text: string): { manifest?: AttachManifest; issue?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { issue: `manifest is not valid JSON (${reason})` };
  }
  return parseManifest(parsed);
}

/**
 * Resolves the element build URL:
 *  1. `data-src` (optionally containing `{version}`) resolved against the script URL,
 *  2. otherwise the file next to the loader script (`<dir>/bluepencil.element.min.js`).
 */
export function resolveElementUrl(options: {
  scriptUrl: string;
  src?: string;
  version?: string;
}): string {
  const { scriptUrl, src, version } = options;
  if (src !== undefined && src !== "") {
    const substituted = src.includes("{version}") ? src.replace(/\{version\}/g, version ?? "latest") : src;
    return absoluteUrl(scriptUrl, substituted);
  }
  return absoluteUrl(scriptUrl, ELEMENT_FILE);
}

/** Resolves `target` against `base`; falls back to the raw target when `base` is not absolute. */
export function absoluteUrl(base: string, target: string): string {
  try {
    return new URL(target, base).href;
  } catch {
    return target;
  }
}

/** True when a mounted version has to be replaced by `next` (a different, non-empty version). */
export function shouldReload(current: string | undefined, next: string | undefined): boolean {
  if (next === undefined || next === "") return false;
  return current !== next;
}

/**
 * The bytes a platform `digest` definitely accepts.
 *
 * Node 20 rejects an `ArrayBuffer` that came from another realm — a jsdom document, an iframe, a
 * worker, a VM context — with "2nd argument is not instance of ArrayBuffer", because it checks with
 * `instanceof`, which is realm-bound. Re-wrapping the bytes here goes through the internal-slot
 * conversion instead, so it works across realms and is a no-op for a same-realm buffer.
 */
function toBytes(buffer: ArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> {
  const source = ArrayBuffer.isView(buffer)
    ? new Uint8Array(buffer.buffer as ArrayBuffer, buffer.byteOffset, buffer.byteLength)
    : new Uint8Array(buffer as ArrayBuffer);
  // A fresh, realm-local copy: `digest` accepts it on every runtime (Node 20 included) and it stays
  // valid even when the source was a view into a buffer this realm does not own.
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

/** Hex SHA-256 of a buffer, using WebCrypto (browser and Node 20+). */
export async function sha256Hex(
  buffer: ArrayBuffer | ArrayBufferView,
  cryptoImpl?: Crypto,
): Promise<string | undefined> {
  const subtle = cryptoImpl?.subtle ?? (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) {
    return undefined;
  }
  const digest = await subtle.digest("SHA-256", toBytes(buffer));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * What an integrity check can conclude — never a silent "ok" when no digest was actually checked.
 *
 * `source` names the trust anchor that was used: the host pin (`data-sha256`) or the manifest digest.
 * `code` is part of the observable contract (AC-C06/AC-C07): a loader failure is reported as
 * `integrity_missing` / `integrity_mismatch`, not as an anonymous "check failed".
 */
export type IntegrityOutcome =
  | { ok: true; source: "host-pin" | "manifest"; issue?: undefined }
  | { ok: false; code: "integrity_missing" | "integrity_mismatch"; issue: string };

/** The bytes-based contract: the caller fetched the build, this only decides whether it may run. */
export interface IntegrityBytesInput {
  bytes: Uint8Array;
  /** `data-sha256` on the loader tag — the host pin. Takes precedence over the manifest digest. */
  expected?: string;
  /** `manifest.sha256` — a download check only, never a trust anchor. */
  manifestSha256?: string;
  /** Only used to make an issue message point at the build. */
  url?: string;
  cryptoImpl?: Crypto;
}

/** Compatibility input for callers that only have a URL (the version module's own history). */
export interface IntegrityFetchInput {
  url: string;
  sha256: string;
  fetchImpl: typeof fetch;
  cryptoImpl?: Crypto;
}

/** Downloads a build so it can be hashed; a transport failure is an issue, never a silent pass. */
export async function fetchBytes(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ bytes?: Uint8Array; issue?: string }> {
  let response: Response;
  try {
    // Called with the global as receiver: an unbound `fetch` extracted from the window is an
    // "Illegal invocation" in a real browser, and this check must never fail for that reason.
    response = await fetchImpl.call(globalThis, url, { cache: "no-store" });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { issue: `integrity check could not fetch ${url}: ${reason}` };
  }
  if (!response.ok) {
    return { issue: `integrity check: ${url} → HTTP ${response.status}` };
  }
  try {
    return { bytes: new Uint8Array(await response.arrayBuffer()) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { issue: `integrity check could not read ${url}: ${reason}` };
  }
}

const HEX_SHA256 = /^[0-9a-f]{64}$/i;

/**
 * Decides whether `bytes` may be executed (G7, AC-C06…AC-C08).
 *
 * Precedence: the host pin wins over the manifest digest. Without either digest an opt-in check is
 * an `integrity_missing` error — the old behaviour returned silently and let unverified code run.
 * A malformed digest is treated the same way: there is no usable expectation, so nothing was proven.
 */
async function verifyBytes(input: IntegrityBytesInput): Promise<IntegrityOutcome> {
  const expected = input.expected ?? input.manifestSha256;
  const label = input.url === undefined ? "the element build" : input.url;
  if (expected === undefined) {
    return {
      ok: false,
      code: "integrity_missing",
      issue: `integrity_missing: ${label} has no digest — set data-sha256 (host pin) or publish sha256 in the manifest`,
    };
  }
  if (!HEX_SHA256.test(expected)) {
    return {
      ok: false,
      code: "integrity_missing",
      issue: `integrity_missing: the expected digest for ${label} is not a 64-character hex SHA-256`,
    };
  }
  const digest = await sha256Hex(input.bytes, input.cryptoImpl);
  if (digest === undefined) {
    return {
      ok: false,
      code: "integrity_mismatch",
      issue: "integrity check needs WebCrypto (crypto.subtle) — not available here",
    };
  }
  if (digest !== expected.toLowerCase()) {
    return {
      ok: false,
      code: "integrity_mismatch",
      issue: `integrity check failed for ${label}: expected ${expected.toLowerCase()}, got ${digest}`,
    };
  }
  return { ok: true, source: input.expected === undefined ? "manifest" : "host-pin" };
}

/**
 * Verifies the element build before it is imported.
 *
 * The bytes form is the contract (G7). The URL form is a thin compatibility overload for callers
 * that already have a URL: it fetches once and then runs the exact same check.
 */
export async function verifyIntegrity(input: IntegrityBytesInput): Promise<IntegrityOutcome>;
export async function verifyIntegrity(input: IntegrityFetchInput): Promise<IntegrityOutcome>;
export async function verifyIntegrity(
  input: IntegrityBytesInput | IntegrityFetchInput,
): Promise<IntegrityOutcome> {
  if ("bytes" in input) {
    return verifyBytes(input);
  }
  const fetched = await fetchBytes(input.url, input.fetchImpl);
  if (fetched.bytes === undefined) {
    return {
      ok: false,
      code: "integrity_mismatch",
      issue: fetched.issue ?? `integrity check could not read ${input.url}`,
    };
  }
  return verifyBytes({
    bytes: fetched.bytes,
    expected: input.sha256,
    url: input.url,
    ...(input.cryptoImpl === undefined ? {} : { cryptoImpl: input.cryptoImpl }),
  });
}
