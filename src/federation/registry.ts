/**
 * Federation registry: file shape, validation and resolution (FR-16.10, plan §6, Rev. 4).
 *
 * The registry is the only place an operator declares which bluepencil instances a session may
 * talk to. It is therefore a security boundary, not a convenience file, and this module is built
 * around three rules:
 *
 * - **Credentials are references.** A registry may name an environment variable (`auth.env`), never
 *   hold a token. A literal `token`/`secret`/… key is rejected as `literal_secret`, and such a file
 *   is not allowed to trigger any network call at all (T34).
 * - **No partial load.** Validation collects every issue and returns them together. A registry with
 *   one broken instance is rejected as a whole, because a silently dropped instance turns a fan-out
 *   into a partial answer that nobody notices (FR-16.10).
 * - **Fail closed on the network side.** Base URLs go through `checkBaseUrl`, so link-local and
 *   metadata targets stay blocked even with `allowInsecure`; the stored value is the normalised
 *   form, so downstream code never re-parses the URL differently.
 *
 * Validation is async because host checks may resolve DNS. There is a deliberate asymmetry between
 * the two entry points:
 *
 * - {@link validateRegistry} is **offline by default**. Without an injected resolver only literal
 *   addresses are classified, because `instances validate`/`instances list` must work without
 *   network access (FR-16.15).
 * - {@link loadRegistry} is a **start-up gate** and therefore resolves DNS by default
 *   (`createDnsResolver`). A hostname that rebinds to link-local/metadata has to be rejected before
 *   the session talks to anyone, so an offline-by-default loader would reopen the DNS-rebinding
 *   hole (T80/F-01).
 *
 * Node-only: the loader reads a file and checks its permissions. `validateRegistry` itself touches
 * only `process.env` and never the filesystem.
 */

import { readFile, stat as statFile } from "node:fs/promises";

import { FederationError, type FederationErrorCode } from "./errors";
import { INSTANCE_ID_PATTERN, isReservedInstance } from "./ids";
import {
  UrlPolicyError,
  checkBaseUrl,
  createDnsResolver,
  type HostResolver,
} from "./net-policy";

/* ------------------------------------------------------------------------------------------------
 * Shapes
 * ---------------------------------------------------------------------------------------------- */

/** Where the token for an instance comes from. A reference only — never a value. */
export interface RegistryAuth {
  env: string;
}

/** One instance as written in the file. */
export interface RegistryInstance {
  id: string;
  base: string;
  app?: string;
  mode?: "read" | "write";
  auth?: RegistryAuth;
  tokenHeader?: string;
  tokenScheme?: string;
}

/** Repository-wide defaults as written in the file. */
export interface RegistryDefaults {
  includeSelf?: boolean;
  mode?: "read" | "write";
  timeoutMs?: number;
  concurrency?: number;
  limit?: number;
  allowedHosts?: string[];
}

/** The exact shape a registry file has on disk. */
export interface RegistryFile {
  schemaVersion: 1;
  defaults?: RegistryDefaults;
  instances: RegistryInstance[];
}

/** Alias kept for callers that think in "the registry document" rather than "the file". */
export type Registry = RegistryFile;

/** Validation diagnoses. Stable by contract — tests and the CLI both key on them. */
export type RegistryErrorCode =
  | "invalid_json"
  | "invalid_shape"
  | "unknown_field"
  | "unsupported_schema"
  | "duplicate_id"
  | "reserved_id"
  | "invalid_id"
  | "invalid_base_url"
  | "literal_secret"
  | "missing_auth_env"
  | "missing_env_var";

/** A single validation finding. `path` is JSON-pointer-ish (`instances[0].base`). */
export interface RegistryIssue {
  path: string;
  code: RegistryErrorCode;
  message: string;
}

/**
 * Thrown by {@link loadRegistry} when the document is readable JSON but not a valid registry.
 * The message aggregates the issues but never quotes a credential value (NFR-22).
 */
export class RegistryError extends Error {
  readonly issues: readonly RegistryIssue[];

  constructor(issues: RegistryIssue[]) {
    /* Defensive copy: the caller's array must not be able to change the error afterwards. */
    const collected = issues.map((entry) => ({ ...entry }));
    super(formatRegistryErrorMessage(collected));
    this.name = "RegistryError";
    this.issues = collected;
  }
}

/** Defaults after fallbacks and clamping — every field present, `limit`/`concurrency` bounded. */
export interface ResolvedDefaults {
  includeSelf: boolean;
  mode: "read" | "write";
  timeoutMs: number;
  concurrency: number;
  limit: number;
  allowedHosts: readonly string[];
}

/**
 * A resolved credential. `value` is the environment value itself: never log it, never serialise
 * it and never put it into an error message (NFR-22).
 */
export interface ResolvedCredential {
  env: string;
  value: string;
}

/**
 * One instance with defaults applied and the base URL normalised.
 *
 * `credential` is deliberately **non-enumerable** at runtime (F-02): it must be reachable through
 * direct property access so the client can send the token, but it must never show up in
 * `JSON.stringify`, `Object.keys` or an object spread. `toJSON` adds a second guard for callers that
 * serialise the instance explicitly.
 */
export interface ResolvedInstance extends Omit<RegistryInstance, "mode" | "auth"> {
  mode: "read" | "write";
  /** Normalised, no trailing slash (a root base stays the origin only). */
  base: string;
  credential?: ResolvedCredential;
  /** Serialisation guard: returns the instance without `credential` and without any value field. */
  toJSON?(): Record<string, unknown>;
}

/** The value consumers see after a successful validation. */
export interface ResolvedRegistry {
  schemaVersion: 1;
  defaults: ResolvedDefaults;
  instances: ResolvedInstance[];
}

/* ------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

export const REGISTRY_DEFAULT_TIMEOUT_MS = 3000;
export const REGISTRY_DEFAULT_LIMIT = 200;
export const REGISTRY_MAX_LIMIT = 1000;
export const REGISTRY_DEFAULT_CONCURRENCY = 8;
export const REGISTRY_MAX_CONCURRENCY = 16;

/** Upper bound the file may *name* for `limit`; above {@link REGISTRY_MAX_LIMIT} it is clamped. */
const REGISTRY_MAX_LIMIT_INPUT = 5000;
/** Upper bound for a per-source timeout, shared by the registry file and the hub CLI (F6). */
export const REGISTRY_MAX_TIMEOUT_MS = 60_000;

/* RFC 7230 token characters, plus the environment-name and scheme grammars. */
const TOKEN_HEADER_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;
const TOKEN_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/u;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * Object-prototype keys that must never be used as an environment or header name (F-23). They all
 * match the grammar above, so `env[rawEnv]` would silently return `Object.prototype` machinery
 * instead of a string. Rejecting them explicitly keeps `credential.value` from becoming `{}`.
 */
const FORBIDDEN_PROPERTY_NAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(["schemaVersion", "defaults", "instances"]);
const DEFAULTS_KEYS: ReadonlySet<string> = new Set([
  "includeSelf",
  "mode",
  "timeoutMs",
  "concurrency",
  "limit",
  "allowedHosts",
]);
const INSTANCE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "base",
  "app",
  "mode",
  "auth",
  "tokenHeader",
  "tokenScheme",
]);
const AUTH_KEYS: ReadonlySet<string> = new Set(["env"]);

/**
 * Field names that read as "a credential is written here". A hit is `literal_secret` rather than
 * `unknown_field`, because that is the more precise diagnosis an operator can act on.
 */
const SECRET_KEY_NAMES: ReadonlySet<string> = new Set([
  "token",
  "secret",
  "password",
  "authorization",
  "headers",
  "tokenvalue",
  "authtoken",
  "apikey",
  "api_key",
  "accesstoken",
  "access_token",
  "clientsecret",
  "client_secret",
  "bearer",
  "credential",
  "credentials",
]);

/* ------------------------------------------------------------------------------------------------
 * Small helpers
 * ---------------------------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSecretKeyName(key: string): boolean {
  return SECRET_KEY_NAMES.has(key.toLowerCase());
}

function issue(
  issues: RegistryIssue[],
  path: string,
  code: RegistryErrorCode,
  message: string,
): void {
  issues.push({ path, code, message });
}

function childPath(parent: string, key: string): string {
  return parent === "" ? key : `${parent}.${key}`;
}

/** True for a finite integer inside the inclusive range. */
function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

/**
 * Reports every key that is not in `allowed`. Secret-looking names are reported as
 * `literal_secret` instead of `unknown_field` — same finding, better diagnosis.
 */
function checkKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  issues: RegistryIssue[],
): void {
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    const target = childPath(path, key);
    if (isSecretKeyName(key)) {
      issue(
        issues,
        target,
        "literal_secret",
        `Field "${key}" must not carry a literal credential; name an environment variable in auth.env instead`,
      );
      continue;
    }
    issue(issues, target, "unknown_field", `Unknown field "${key}"`);
  }
}

/**
 * Pre-scan for literal credentials anywhere in the document. When one is present the base-URL
 * checks run without a resolver, so a misconfigured file can never cause a DNS lookup (T34).
 * This is deliberately a shallow, structural scan: it must not interpret untrusted values.
 */
function hasLiteralSecret(value: Record<string, unknown>): boolean {
  if (Object.keys(value).some(isSecretKeyName)) return true;

  const defaults = value["defaults"];
  if (isRecord(defaults) && Object.keys(defaults).some(isSecretKeyName)) return true;

  const instances = value["instances"];
  if (!Array.isArray(instances)) return false;
  for (const entry of instances) {
    if (!isRecord(entry)) continue;
    if (Object.keys(entry).some(isSecretKeyName)) return true;
    const auth = entry["auth"];
    if (isRecord(auth) && Object.keys(auth).some(isSecretKeyName)) return true;
  }
  return false;
}

/**
 * Renders a `UrlPolicyError` for a `RegistryIssue`. The reason and the host/address are the part an
 * operator needs; the raw URL is never echoed, so a userinfo URL cannot leak its password here.
 */
function describeBaseUrlError(error: unknown): string {
  if (!(error instanceof UrlPolicyError)) return "Base URL could not be validated";

  const details: string[] = [];
  if (error.host !== undefined) details.push(`host ${error.host}`);
  if (error.address !== undefined) details.push(`address ${error.address}`);
  const suffix = details.length === 0 ? "" : ` (${details.join(", ")})`;
  return `${error.reason}: ${error.message}${suffix}`;
}

/** Normalised base from a checked URL: root keeps only the origin, everything else drops `/`. */
function baseFromUrl(url: URL): string {
  return url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`;
}

/** Message for a `RegistryError`: every issue on one line each, no values from the file. */
function formatRegistryErrorMessage(issues: readonly RegistryIssue[]): string {
  const header = `Invalid federation registry (${issues.length} issue${issues.length === 1 ? "" : "s"})`;
  const lines = issues.map((entry) => {
    const where = entry.path === "" ? "<root>" : entry.path;
    return `${where}: ${entry.code}: ${entry.message}`;
  });
  return `${header}: ${lines.join("; ")}`;
}

/* ------------------------------------------------------------------------------------------------
 * Defaults
 * ---------------------------------------------------------------------------------------------- */

function validateDefaults(raw: unknown, issues: RegistryIssue[]): ResolvedDefaults {
  const resolved: ResolvedDefaults = {
    includeSelf: true,
    mode: "read",
    timeoutMs: REGISTRY_DEFAULT_TIMEOUT_MS,
    concurrency: REGISTRY_DEFAULT_CONCURRENCY,
    limit: REGISTRY_DEFAULT_LIMIT,
    allowedHosts: [],
  };

  if (raw === undefined) return resolved;
  if (!isRecord(raw)) {
    issue(issues, "defaults", "invalid_shape", "defaults must be an object");
    return resolved;
  }

  checkKeys(raw, DEFAULTS_KEYS, "defaults", issues);

  const includeSelf = raw["includeSelf"];
  if (includeSelf !== undefined) {
    if (typeof includeSelf === "boolean") resolved.includeSelf = includeSelf;
    else issue(issues, "defaults.includeSelf", "invalid_shape", "includeSelf must be a boolean");
  }

  const mode = raw["mode"];
  if (mode !== undefined) {
    if (mode === "read" || mode === "write") resolved.mode = mode;
    else issue(issues, "defaults.mode", "invalid_shape", 'mode must be "read" or "write"');
  }

  const timeoutMs = raw["timeoutMs"];
  if (timeoutMs !== undefined) {
    if (isIntegerInRange(timeoutMs, 1, REGISTRY_MAX_TIMEOUT_MS)) resolved.timeoutMs = timeoutMs;
    else {
      issue(
        issues,
        "defaults.timeoutMs",
        "invalid_shape",
        `timeoutMs must be an integer between 1 and ${REGISTRY_MAX_TIMEOUT_MS}`,
      );
    }
  }

  const concurrency = raw["concurrency"];
  if (concurrency !== undefined) {
    if (isIntegerInRange(concurrency, 1, REGISTRY_MAX_CONCURRENCY)) {
      resolved.concurrency = concurrency;
    } else {
      issue(
        issues,
        "defaults.concurrency",
        "invalid_shape",
        `concurrency must be an integer between 1 and ${REGISTRY_MAX_CONCURRENCY}`,
      );
    }
  }

  const limit = raw["limit"];
  if (limit !== undefined) {
    if (isIntegerInRange(limit, 1, REGISTRY_MAX_LIMIT_INPUT)) {
      /* T87: a generous limit is clamped, not rejected — 5000 means "no practical cap". */
      resolved.limit = Math.min(REGISTRY_MAX_LIMIT, limit);
    } else {
      issue(
        issues,
        "defaults.limit",
        "invalid_shape",
        `limit must be an integer between 1 and ${REGISTRY_MAX_LIMIT_INPUT}`,
      );
    }
  }

  const allowedHosts = raw["allowedHosts"];
  if (allowedHosts !== undefined) {
    if (
      Array.isArray(allowedHosts) &&
      allowedHosts.every((entry) => typeof entry === "string" && entry !== "")
    ) {
      resolved.allowedHosts = [...allowedHosts];
    } else {
      issue(
        issues,
        "defaults.allowedHosts",
        "invalid_shape",
        "allowedHosts must be an array of non-empty strings",
      );
    }
  }

  return resolved;
}

/* ------------------------------------------------------------------------------------------------
 * Instances
 * ---------------------------------------------------------------------------------------------- */

interface InstancePolicy {
  allowInsecure: boolean;
  allowedHosts: readonly string[];
  /** Absent when a literal secret was found: the document must not cause network traffic. */
  resolver: HostResolver | undefined;
}

/** Returns the accepted id, or `undefined` after reporting why it was rejected. */
function validateInstanceId(
  raw: Record<string, unknown>,
  path: string,
  seenIds: Set<string>,
  issues: RegistryIssue[],
): string | undefined {
  const rawId = raw["id"];

  if (typeof rawId !== "string") {
    issue(issues, `${path}.id`, "invalid_shape", "Instance id must be a string");
    return undefined;
  }
  if (isReservedInstance(rawId)) {
    issue(
      issues,
      `${path}.id`,
      "reserved_id",
      `Instance id "${rawId}" is reserved (self/all/* are selectors, not instances)`,
    );
    return undefined;
  }
  if (!INSTANCE_ID_PATTERN.test(rawId)) {
    issue(
      issues,
      `${path}.id`,
      "invalid_id",
      "Instance id must be 1-64 characters from [a-z0-9._-], starting with a letter or digit",
    );
    return undefined;
  }
  if (seenIds.has(rawId)) {
    issue(issues, `${path}.id`, "duplicate_id", `Duplicate instance id "${rawId}"`);
    return undefined;
  }

  seenIds.add(rawId);
  return rawId;
}

/** Validates `tokenHeader`/`tokenScheme` if present; returns the accepted value. */
function validateTokenField(
  raw: Record<string, unknown>,
  field: "tokenHeader" | "tokenScheme",
  path: string,
  pattern: RegExp,
  description: string,
  issues: RegistryIssue[],
): string | undefined {
  const value = raw[field];
  if (value === undefined) return undefined;
  if (typeof value === "string" && FORBIDDEN_PROPERTY_NAMES.has(value)) {
    issue(
      issues,
      `${path}.${field}`,
      "invalid_shape",
      `${field} must not be an object-prototype key ("__proto__", "constructor", "prototype")`,
    );
    return undefined;
  }
  if (typeof value === "string" && pattern.test(value)) return value;
  issue(issues, `${path}.${field}`, "invalid_shape", description);
  return undefined;
}

function validateAuth(
  raw: Record<string, unknown>,
  path: string,
  env: NodeJS.ProcessEnv,
  issues: RegistryIssue[],
): ResolvedCredential | undefined {
  const rawAuth = raw["auth"];
  if (rawAuth === undefined) return undefined;

  if (!isRecord(rawAuth)) {
    issue(issues, `${path}.auth`, "missing_auth_env", "auth must be an object with an env key");
    return undefined;
  }

  checkKeys(rawAuth, AUTH_KEYS, `${path}.auth`, issues);

  /* A secret-looking key is already reported as `literal_secret`; adding `missing_auth_env` on top
   * would describe the same mistake twice. */
  if (Object.keys(rawAuth).some(isSecretKeyName)) return undefined;

  const hasEnv = Object.prototype.hasOwnProperty.call(rawAuth, "env");
  const rawEnv = rawAuth["env"];

  if (!hasEnv || typeof rawEnv !== "string" || rawEnv === "") {
    issue(
      issues,
      `${path}.auth.env`,
      "missing_auth_env",
      "auth.env must name the environment variable that holds the token",
    );
    return undefined;
  }
  /* F-23: reject prototype keys before the grammar check — they match it and would otherwise read
   * inherited object machinery instead of an environment string. */
  if (FORBIDDEN_PROPERTY_NAMES.has(rawEnv)) {
    issue(
      issues,
      `${path}.auth.env`,
      "missing_auth_env",
      `"${rawEnv}" is an object-prototype key and not a valid environment variable name`,
    );
    return undefined;
  }
  if (!ENV_NAME_PATTERN.test(rawEnv)) {
    issue(
      issues,
      `${path}.auth.env`,
      "missing_auth_env",
      `"${rawEnv}" is not a valid environment variable name`,
    );
    return undefined;
  }

  /* Own properties only: an inherited `constructor`-like value must never become a credential. */
  const hasValue = Object.prototype.hasOwnProperty.call(env, rawEnv);
  const value: unknown = hasValue ? env[rawEnv] : undefined;
  if (!hasValue || typeof value !== "string" || value === "") {
    /* T13: a referenced but unset credential is a start error, not a later 401. */
    issue(
      issues,
      `${path}.auth.env`,
      "missing_env_var",
      `Environment variable "${rawEnv}" is not set or empty`,
    );
    return undefined;
  }

  return { env: rawEnv, value };
}

/**
 * Builds the resolved instance with the credential hidden from enumeration and serialisation (F-02).
 *
 * `credential` is non-enumerable, so `Object.keys`, `{ ...instance }` and `JSON.stringify(instance)`
 * never see it. `toJSON` is an explicit second guard that returns a fresh plain object, so even a
 * caller that serialises the instance through a custom replacer cannot pick up a `value` field.
 */
function createResolvedInstance(
  fields: Omit<ResolvedInstance, "credential" | "toJSON">,
  credential: ResolvedCredential | undefined,
): ResolvedInstance {
  const instance: ResolvedInstance = { ...fields };

  if (credential !== undefined) {
    Object.defineProperty(instance, "credential", {
      value: credential,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  Object.defineProperty(instance, "toJSON", {
    value: (): Record<string, unknown> => ({ ...fields }),
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return instance;
}

async function validateInstance(
  raw: unknown,
  index: number,
  defaults: ResolvedDefaults,
  env: NodeJS.ProcessEnv,
  policy: InstancePolicy,
  seenIds: Set<string>,
  issues: RegistryIssue[],
): Promise<ResolvedInstance | null> {
  const path = `instances[${index}]`;

  if (!isRecord(raw)) {
    issue(issues, path, "invalid_shape", "Instance entry must be an object");
    return null;
  }

  const issueCountBefore = issues.length;

  checkKeys(raw, INSTANCE_KEYS, path, issues);

  const id = validateInstanceId(raw, path, seenIds, issues);

  const rawBase = raw["base"];
  let base: string | undefined;
  if (typeof rawBase !== "string" || rawBase === "") {
    issue(issues, `${path}.base`, "invalid_shape", "base must be a non-empty string");
  } else {
    try {
      const checked = await checkBaseUrl(rawBase, {
        allowInsecure: policy.allowInsecure,
        allowedHosts: policy.allowedHosts,
        resolver: policy.resolver,
      });
      base = baseFromUrl(checked.url);
    } catch (error) {
      /* The message carries the reason and the host, never the raw URL (which may hold userinfo). */
      issue(issues, `${path}.base`, "invalid_base_url", describeBaseUrlError(error));
    }
  }

  const rawApp = raw["app"];
  let app: string | undefined;
  if (rawApp !== undefined) {
    if (typeof rawApp === "string" && rawApp !== "") app = rawApp;
    else issue(issues, `${path}.app`, "invalid_shape", "app must be a non-empty string");
  }

  let mode: "read" | "write" = defaults.mode;
  const rawMode = raw["mode"];
  if (rawMode !== undefined) {
    if (rawMode === "read" || rawMode === "write") mode = rawMode;
    else issue(issues, `${path}.mode`, "invalid_shape", 'mode must be "read" or "write"');
  }

  const tokenHeader = validateTokenField(
    raw,
    "tokenHeader",
    path,
    TOKEN_HEADER_PATTERN,
    "tokenHeader must be an HTTP token (RFC 7230)",
    issues,
  );
  const tokenScheme = validateTokenField(
    raw,
    "tokenScheme",
    path,
    TOKEN_SCHEME_PATTERN,
    "tokenScheme must start with a letter and contain only letters, digits and hyphens",
    issues,
  );

  const credential = validateAuth(raw, path, env, issues);

  if (issues.length !== issueCountBefore || id === undefined || base === undefined) return null;

  return createResolvedInstance(
    {
      id,
      base,
      mode,
      ...(app === undefined ? {} : { app }),
      ...(tokenHeader === undefined ? {} : { tokenHeader }),
      ...(tokenScheme === undefined ? {} : { tokenScheme }),
    },
    credential,
  );
}

/* ------------------------------------------------------------------------------------------------
 * Validation
 * ---------------------------------------------------------------------------------------------- */

export interface ValidateRegistryOptions {
  /** Admits `http` and RFC1918/ULA targets. Never admits link-local or metadata (T92). */
  allowInsecure?: boolean;
  /** Environment used to resolve `auth.env`. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injected DNS resolver. Without it the checks are offline and deterministic. */
  resolver?: HostResolver;
}

export type ValidateRegistryResult =
  | { ok: true; registry: ResolvedRegistry }
  | { ok: false; issues: RegistryIssue[] };

/**
 * Validates and resolves a parsed registry document.
 *
 * Never throws for malformed input: every finding is collected and returned. The only reasons a
 * caller has to catch anything are programming errors inside the policy modules.
 *
 * When a literal credential is present, base URLs are checked offline (no resolver call) so that a
 * file which must be rejected anyway cannot reach the network first (T34).
 */
export async function validateRegistry(
  value: unknown,
  options: ValidateRegistryOptions = {},
): Promise<ValidateRegistryResult> {
  if (!isRecord(value)) {
    return {
      ok: false,
      issues: [{ path: "", code: "invalid_shape", message: "Registry must be a JSON object" }],
    };
  }

  const issues: RegistryIssue[] = [];
  const secretDetected = hasLiteralSecret(value);

  checkKeys(value, TOP_LEVEL_KEYS, "", issues);

  if (value["schemaVersion"] !== 1) {
    issue(
      issues,
      "schemaVersion",
      "unsupported_schema",
      value["schemaVersion"] === undefined
        ? "schemaVersion is required and must be 1"
        : "Only registry schemaVersion 1 is supported",
    );
  }

  const defaults = validateDefaults(value["defaults"], issues);

  const rawInstances = value["instances"];
  const instances: ResolvedInstance[] = [];

  if (!Array.isArray(rawInstances) || rawInstances.length === 0) {
    issue(issues, "instances", "invalid_shape", "instances must be a non-empty array");
  } else {
    const env = options.env ?? process.env;
    const policy: InstancePolicy = {
      allowInsecure: options.allowInsecure === true,
      allowedHosts: defaults.allowedHosts,
      resolver: secretDetected ? undefined : options.resolver,
    };
    const seenIds = new Set<string>();

    /* Sequential on purpose: the resolver is the only slow part and the registry is small, so a
     * deterministic issue order is worth more than parallelism. */
    for (let index = 0; index < rawInstances.length; index += 1) {
      const resolved = await validateInstance(
        rawInstances[index],
        index,
        defaults,
        env,
        policy,
        seenIds,
        issues,
      );
      if (resolved !== null) instances.push(resolved);
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    registry: {
      schemaVersion: 1,
      defaults,
      instances,
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * Loading
 * ---------------------------------------------------------------------------------------------- */

/** The subset of `fs.Stats` the permission check needs. Injectable for tests (T79). */
export interface RegistryFileStat {
  mode: number;
  uid?: number;
}

export interface LoadRegistryOptions {
  allowInsecure?: boolean;
  resolver?: HostResolver;
  /** Replaces `fs.stat`; the injected function makes the permission check testable (T79). */
  stat?: (path: string) => Promise<RegistryFileStat>;
}

/** The plan requires 0600: nothing for group or others. */
function assertFilePermissions(path: string, info: RegistryFileStat): void {
  if ((info.mode & 0o077) !== 0) {
    throw new FederationError(
      "invalid_registry",
      `Registry file ${path} must not be accessible by group or others (expected 0600, got ${formatMode(info.mode)})`,
    );
  }

  /* Ownership is best effort: `uid` is unavailable on some platforms and root may read anything. */
  if (info.uid === undefined || typeof process.getuid !== "function") return;

  const currentUid = process.getuid();
  if (currentUid !== 0 && info.uid !== currentUid) {
    throw new FederationError(
      "invalid_registry",
      `Registry file ${path} must be owned by the current user (uid ${currentUid})`,
    );
  }
}

/** Keys that only occur in {@link LoadRegistryOptions}, never in an environment map. */
const LOAD_OPTION_KEYS: readonly string[] = ["allowInsecure", "resolver", "stat"];

/** Environment variables are conventionally upper-case; options are camelCase. */
const ENV_STYLE_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;

/**
 * True when `value` is an options object rather than an environment map (F-08).
 *
 * Callers written against plan §6 pass `loadRegistry(path, { allowInsecure: true })`; without this
 * shim that object would be read as an empty environment and every `auth` reference would fail with
 * `missing_env_var`. A real environment map never carries a camelCase option key, so the check is
 * unambiguous.
 */
function looksLikeLoadOptions(value: NodeJS.ProcessEnv | LoadRegistryOptions): boolean {
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  if (!LOAD_OPTION_KEYS.some((key) => Object.prototype.hasOwnProperty.call(value, key))) {
    return false;
  }
  return !keys.some((key) => ENV_STYLE_KEY_PATTERN.test(key));
}

/**
 * Reads and parses a registry file after the permission gate, without any network access.
 *
 * Split out so the start-up loader (DNS on) and the offline CLI path
 * ({@link loadRegistryFile}, DNS off) share one implementation of the parts that must never
 * differ: the stat-before-read ordering (F-19), the 0600/owner check and the JSON parse error.
 */
async function readRegistryDocument(
  path: string,
  stat?: (path: string) => Promise<RegistryFileStat>,
): Promise<unknown> {
  /* F-19: stat/permission check FIRST. A registry that group or others can read must be rejected
   * before its content is parsed or validated. */
  const statFileFn = stat ?? ((target: string) => statFile(target));
  let info: RegistryFileStat;
  try {
    info = await statFileFn(path);
  } catch (error) {
    throw new FederationError(
      "invalid_registry",
      `cannot read registry file ${path}: ${errorMessage(error)}`,
    );
  }

  assertFilePermissions(path, info);

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new FederationError(
      "invalid_registry",
      `cannot read registry file ${path}: ${errorMessage(error)}`,
    );
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new RegistryError([
      {
        path: "",
        code: "invalid_json",
        message: `Registry file is not valid JSON: ${errorMessage(error)}`,
      },
    ]);
  }
}

/**
 * Maps a loader failure onto the canonical start-up taxonomy (plan §7).
 *
 * `RegistryError` carries the precise validation findings, but a process exit code can only speak
 * the canonical codes: a reserved id is `self_reference` (T47), a duplicate id is `id_collision`
 * (T45), an unset credential is `missing_credential` and a policy-blocked URL stays
 * `invalid_base_url`. Everything else is `invalid_registry`. The message aggregates the issues but
 * never quotes a credential (NFR-22).
 *
 * A `FederationError` from the loader (unreadable file, unsafe permissions) already is canonical
 * and passes through unchanged.
 */
export function registryStartupError(error: unknown): FederationError {
  if (error instanceof FederationError) return error;
  if (error instanceof RegistryError) {
    const codes = new Set(error.issues.map((entry) => entry.code));
    const code: FederationErrorCode = codes.has("reserved_id")
      ? "self_reference"
      : codes.has("duplicate_id")
        ? "id_collision"
        : codes.has("missing_env_var")
          ? "missing_credential"
          : codes.has("invalid_base_url")
            ? "invalid_base_url"
            : "invalid_registry";
    return new FederationError(code, error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new FederationError("invalid_registry", message);
}

/**
 * Reads, validates and resolves a registry file.
 *
 * Error contract: unreadable file or unsafe permissions/ownership → `FederationError
 * ("invalid_registry")`; unparsable JSON → `RegistryError` with a single `invalid_json` issue;
 * invalid document → `RegistryError` with every issue.
 *
 * The permission check runs **before** the file is read and parsed (F-19). A group/world-accessible
 * registry must be refused without its content being consumed, so the permission verdict wins over
 * a later `invalid_json` or validation finding.
 *
 * Unlike {@link validateRegistry}, this loader resolves DNS by default ({@link createDnsResolver}):
 * start-up must not admit a hostname that rebinds to a link-local/metadata address (F-01/T80). There
 * is no offline mode here on purpose; use `validateRegistry` for offline checks.
 */
export async function loadRegistry(
  path: string,
  env?: NodeJS.ProcessEnv,
  options?: LoadRegistryOptions,
): Promise<ResolvedRegistry>;
export async function loadRegistry(
  path: string,
  options?: LoadRegistryOptions,
): Promise<ResolvedRegistry>;
export async function loadRegistry(
  path: string,
  envOrOptions?: NodeJS.ProcessEnv | LoadRegistryOptions,
  explicitOptions: LoadRegistryOptions = {},
): Promise<ResolvedRegistry> {
  let env: NodeJS.ProcessEnv | undefined;
  let options: LoadRegistryOptions;

  /* F-08 compatibility shim: an options object passed as the second argument is not an env map.
   * The environment still comes from `process.env`, because a plan §6 caller never passed one. */
  if (envOrOptions !== undefined && looksLikeLoadOptions(envOrOptions)) {
    options = { ...(envOrOptions as LoadRegistryOptions), ...explicitOptions };
    env = undefined;
  } else {
    env = envOrOptions as NodeJS.ProcessEnv | undefined;
    options = explicitOptions;
  }

  /* F-19: stat/permission check FIRST. A registry that group or others can read must be rejected
   * before its content is parsed or validated. */
  const parsed = await readRegistryDocument(path, options.stat);

  /* F-01: load-time DNS resolution closes the rebinding gap; validation stays offline otherwise.
   * The deadline keeps a hostile resolver from stalling start-up indefinitely. */
  const resolver = options.resolver ?? createDnsResolver({ timeoutMs: 2000 });

  const result = await validateRegistry(parsed, {
    allowInsecure: options.allowInsecure,
    resolver,
    env,
  });
  if (!result.ok) throw new RegistryError(result.issues);

  return result.registry;
}

export interface LoadRegistryFileOptions {
  /** Admits `http` and RFC1918/ULA targets for the offline URL check. Link-local stays blocked. */
  allowInsecure?: boolean;
}

/**
 * Offline registry loader for `bluepencil instances validate|list` (FR-16.15).
 *
 * Performs the same file permission gate, JSON parse and {@link validateRegistry} pass as
 * {@link loadRegistry}, but **deliberately injects no DNS resolver**: the check classifies literal
 * addresses only, so the command works without network access and cannot stall on a resolver. A
 * hostname that rebinds to link-local space is therefore only caught at start-up, which is the
 * documented asymmetry (the loader's job is to start a session; this one is a file check).
 *
 * The credential values are still resolved against `env` (default `process.env`), because a
 * registry that names an unset variable is invalid regardless of connectivity. Nothing from the
 * file is ever printed by this module.
 */
export async function loadRegistryFile(
  path: string,
  env?: NodeJS.ProcessEnv,
  options: LoadRegistryFileOptions = {},
): Promise<ResolvedRegistry> {
  const parsed = await readRegistryDocument(path);
  const result = await validateRegistry(parsed, {
    allowInsecure: options.allowInsecure,
    env,
  });
  if (!result.ok) throw new RegistryError(result.issues);
  return result.registry;
}
