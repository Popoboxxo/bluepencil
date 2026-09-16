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
 * Everything in this module is pure (except `verifyIntegrity`, which takes the fetch function
 * injected) so the contract is unit-testable without a browser.
 */
import { isRecord } from "../core/adapter";

/** The pointer file a host publishes next to the versioned artifacts. */
export interface AttachManifest {
  version: string;
  /** Absolute or relative URL of the element build for that version. */
  element: string;
  /** Optional hex SHA-256 of the element build; verified when `data-integrity` is set. */
  sha256?: string;
}

/** Fallback element file name, used when neither `data-src` nor a manifest is given. */
export const ELEMENT_FILE = "bluepencil.element.min.js";

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
 * Downloads and hashes the element build before it is executed. Returns a failure when the digest
 * does not match; a missing WebCrypto implementation is reported as "could not verify" so a host
 * never believes an unverified script was checked.
 */
export async function verifyIntegrity(options: {
  url: string;
  sha256: string;
  fetchImpl: typeof fetch;
  cryptoImpl?: Crypto;
}): Promise<{ ok: boolean; issue?: string }> {
  let response: Response;
  try {
    // Called with the global as receiver: an unbound `fetch` extracted from the window is an
    // "Illegal invocation" in a real browser, and this check must never fail for that reason.
    response = await (options.fetchImpl as typeof fetch).call(globalThis, options.url, { cache: "no-store" });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, issue: `integrity check could not fetch ${options.url}: ${reason}` };
  }
  if (!response.ok) {
    return { ok: false, issue: `integrity check: ${options.url} → HTTP ${response.status}` };
  }
  const buffer = await response.arrayBuffer();
  const digest = await sha256Hex(buffer, options.cryptoImpl);
  if (digest === undefined) {
    return { ok: false, issue: "integrity check needs WebCrypto (crypto.subtle) — not available here" };
  }
  if (digest !== options.sha256.toLowerCase()) {
    return {
      ok: false,
      issue: `integrity check failed for ${options.url}: expected ${options.sha256.toLowerCase()}, got ${digest}`,
    };
  }
  return { ok: true };
}
