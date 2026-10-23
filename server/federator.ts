#!/usr/bin/env node
/**
 * bluepencil federator — MCP over stdio aggregated over a registry (FR-16.12–16.15, plan §6/§7).
 *
 * A pure federator has **no store and no HTTP endpoint**: it reads the registry once, verifies
 * every peer's identity before the first protocol frame, and then serves the shared stdio loop
 * (`src/mcp/stdio.ts`) over a federation backend. That shape is the whole safety argument:
 *
 *  - stdout belongs to the protocol. Every diagnostic, warning and startup line goes to stderr
 *    with the `bluepencil-federator: ` prefix, so a client that parses stdout never sees prose.
 *  - The registry is a start-up gate, not a hint. An unreadable/unsafe file, a reserved `self`
 *    id, a duplicate id, an identity mismatch, a peer that federates itself or a pre-0.10 peer
 *    without `federates` all refuse the start (exit 4). Only an unreachable/timeout peer starts
 *    degraded — a dead staging hub must not stop an agent from reading dev (R6/R17).
 *  - There is exactly one write authority: `createFederatedBackend` owns the two locks
 *    (`--allow-write` and the registry's `mode:"write"`); `--read-only` wins over both. This
 *    module never writes on its own.
 *  - `--include-self`/`--no-self` are usage errors: a federator has no local store, so the flag
 *    would advertise a mode that cannot exist (FR-16.14).
 *
 * Credentials never leave the process: the registry only names environment variables, the clients
 * receive one shared {@link Redactor} built from every resolved value, and no log line here names
 * a credential (NFR-22).
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { booleanFlag } from "../src/argv";
import { newId } from "../src/core/model";
import { createFederatedBackend } from "../src/federation/backend";
import { InstanceClient } from "../src/federation/client";
import {
  FederationError,
  Redactor,
  federationStartupExitCode,
  isDegradable,
} from "../src/federation/errors";
import {
  REGISTRY_DEFAULT_CONCURRENCY,
  REGISTRY_DEFAULT_LIMIT,
  REGISTRY_DEFAULT_TIMEOUT_MS,
  REGISTRY_MAX_CONCURRENCY,
  REGISTRY_MAX_LIMIT,
  REGISTRY_MAX_TIMEOUT_MS,
  loadRegistry,
  registryStartupError,
} from "../src/federation/registry";
import { runStdioServer } from "../src/mcp/stdio";
import { VERSION } from "../src/version";

/* ------------------------------------------------------------------------------------------------
 * Contract
 * ---------------------------------------------------------------------------------------------- */

/** Default identity of a pure federator (`/config` does not exist; it is the MCP app label). */
const FEDERATOR_APP_NAME = "bluepencil federator";
const LOG_PREFIX = "bluepencil-federator: ";

export interface FederatorOptions {
  registryPath: string;
  readOnly: boolean;
  /** The second write lock for federated writes (default false). */
  allowWrite?: boolean;
  /** Per-source timeout; absent means the registry default. */
  timeoutMs?: number;
  /** Bounded fan-out width; absent means the registry default. */
  concurrency?: number;
  /** Aggregate limit; absent means the registry default. */
  limit?: number;
  /** MCP app label; default "bluepencil federator". */
  appName?: string;
  sessionId?: string;
  /** Provenance name sent to peers; defaults to the app label. */
  clientName?: string;
  /** Admits plain http and RFC1918/ULA registry targets; link-local/metadata stay blocked. */
  allowInsecure?: boolean;
}

export interface RunningFederator {
  close(): Promise<void>;
}

/* ------------------------------------------------------------------------------------------------
 * Argument parsing (same F5 contract as the hub)
 * ---------------------------------------------------------------------------------------------- */

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const VALUED_FLAGS = [
  "--registry",
  "--timeout",
  "--concurrency",
  "--limit",
  "--client-name",
  "--session-id",
  "--app",
] as const;

const BOOLEAN_FLAGS = ["--read-only", "--allow-write", "--allow-insecure"] as const;

/* `--no-self` is accepted as a no-op (a federator never has self); only `--include-self` would
 * promise a mode that cannot exist and is a usage error. */
const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  ...VALUED_FLAGS,
  ...BOOLEAN_FLAGS,
  "--no-self",
]);

/**
 * Parses the documented command line. Returns the options, or a one-line usage error as a string —
 * the same contract as `parseHubArgs`, so `main()` stays thin and tests can check the parse
 * without spawning a process.
 *
 * `env` is a parameter so a test can pass a registry path through the environment without
 * touching `process.env`.
 */
export function parseFederatorArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): FederatorOptions | string {
  const get = (flag: string): string | undefined => {
    const withEquals = argv.find((arg) => arg.startsWith(`${flag}=`));
    if (withEquals !== undefined) return withEquals.slice(flag.length + 1);
    const index = argv.indexOf(flag);
    if (index < 0) return undefined;
    const next = argv[index + 1];
    return next !== undefined && !next.startsWith("--") ? next : undefined;
  };

  /**
   * `--include-self`/`--no-self` are handled below; the shared {@link booleanFlag} owns the
   * true/false parsing for the remaining flags (same contract as the hub and the CLI, F-04).
   */
  /* F5: a present flag without a value must be a usage error. Treating it as absent would let a
   * default (or a registry default) silently stand in for the caller's typo. */
  for (const flag of VALUED_FLAGS) {
    if (argv.some((arg) => arg.startsWith(`${flag}=`))) continue;
    const index = argv.indexOf(flag);
    if (index < 0) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      return `${flag} requires a value (got ${next === undefined ? "nothing" : JSON.stringify(next)})`;
    }
  }

  /* A pure federator has no store. `--include-self` would promise a mode that cannot exist; it is
   * checked before the unknown-flag gate so the diagnosis names the real reason. `--no-self`
   * describes the only state a federator has and is accepted as a no-op (smoke case d). */
  const includeSelfFlag = argv.find(
    (arg) => arg === "--include-self" || arg.startsWith("--include-self="),
  );
  if (includeSelfFlag !== undefined) {
    return "--include-self is not available: a federator has no local store (use bluepencil-hub --registry for a combined aggregate)";
  }

  /* `--no-self` is a bare no-op; there is no boolean to set, so a value is meaningless and a typo
   * must not look like a supported spelling. */
  const assignedNoSelf = argv.find((arg) => arg.startsWith("--no-self="));
  if (assignedNoSelf !== undefined) {
    return `--no-self takes no value (got ${JSON.stringify(assignedNoSelf.slice("--no-self=".length))})`;
  }

  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (!KNOWN_FLAGS.has(name)) {
      return `unknown option ${JSON.stringify(name)} — run with --help for the documented flags`;
    }
  }

  const registryPath = (get("--registry") ?? env.BLUEPENCIL_REGISTRY ?? "").trim();
  if (registryPath === "") {
    return "--registry <path> is required (or set BLUEPENCIL_REGISTRY)";
  }

  const integerFlag = (
    flag: string,
    min: number,
    max: number,
  ): number | string | undefined => {
    const raw = get(flag);
    /* Absent means "let the registry decide"; precedence is CLI > registry defaults > constants. */
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      return `${flag} must be an integer between ${min} and ${max} (got ${JSON.stringify(raw)})`;
    }
    return parsed;
  };

  /* F6: the same cap the registry enforces, so the CLI cannot configure a request that outlives
   * the documented start-up budget. */
  const timeoutMs = integerFlag("--timeout", 1, REGISTRY_MAX_TIMEOUT_MS);
  if (typeof timeoutMs === "string") return timeoutMs;
  const concurrency = integerFlag("--concurrency", 1, REGISTRY_MAX_CONCURRENCY);
  if (typeof concurrency === "string") return concurrency;
  const limit = integerFlag("--limit", 1, REGISTRY_MAX_LIMIT);
  if (typeof limit === "string") return limit;

  const appRaw = get("--app");
  if (appRaw !== undefined && appRaw.trim().length === 0) {
    return "--app must not be empty — omit it to use the default federator name";
  }
  const clientRaw = get("--client-name");
  if (clientRaw !== undefined && clientRaw.trim().length === 0) {
    return "--client-name must not be empty — omit it to use the app label";
  }
  const sessionRaw = get("--session-id");
  if (sessionRaw !== undefined && sessionRaw.trim().length === 0) {
    return "--session-id must not be empty — omit it to generate one";
  }

  const readOnly = booleanFlag(argv, "--read-only");
  if (typeof readOnly === "string") return readOnly;
  const allowWrite = booleanFlag(argv, "--allow-write");
  if (typeof allowWrite === "string") return allowWrite;
  const allowInsecure = booleanFlag(argv, "--allow-insecure");
  if (typeof allowInsecure === "string") return allowInsecure;

  return {
    registryPath,
    readOnly: readOnly ?? false,
    allowWrite: allowWrite ?? false,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(limit === undefined ? {} : { limit }),
    appName: appRaw ?? FEDERATOR_APP_NAME,
    ...(sessionRaw === undefined ? {} : { sessionId: sessionRaw }),
    ...(clientRaw === undefined ? {} : { clientName: clientRaw }),
    allowInsecure: allowInsecure ?? false,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Startup
 * ---------------------------------------------------------------------------------------------- */

/**
 * Loads the registry, builds one client per instance and verifies every peer **before** the stdio
 * loop starts. Fail-fast and degraded-start follow plan §6/§7 exactly:
 *
 *  - fail-fast: `invalid_registry`, `invalid_base_url`, `identity_mismatch`, `federates_missing`,
 *    `nested_federation`, `self_reference`, `id_collision`, `missing_credential`;
 *  - degraded: `instance_unreachable` and `timeout` (logged once, the row stays `ok:false`);
 *  - `unverified` (a peer without `app`) is one warning line and does not block the start.
 */
export async function startFederator(options: FederatorOptions): Promise<RunningFederator> {
  const allowInsecure = options.allowInsecure === true;
  if (allowInsecure) {
    /* O3: the lab flag weakens the URL policy, so the operator must see it once. Link-local and
     * metadata targets stay blocked — the warning says so rather than implying a full bypass. */
    process.stderr.write(
      `${LOG_PREFIX}--allow-insecure is active — plain http and private addresses are admitted for registry peers (link-local and metadata stay blocked)\n`,
    );
  }

  let registry;
  try {
    registry = await loadRegistry(options.registryPath, process.env, { allowInsecure });
  } catch (error) {
    throw registryStartupError(error);
  }

  const appName = options.appName ?? FEDERATOR_APP_NAME;
  const sessionId = options.sessionId ?? newId("s");
  const clientName = options.clientName ?? appName;

  /* Precedence: CLI > registry defaults > the documented constants (the loader already resolved
   * the defaults, so the constants are only a defensive fallback). */
  const timeoutMs = options.timeoutMs ?? registry.defaults.timeoutMs ?? REGISTRY_DEFAULT_TIMEOUT_MS;
  const concurrency =
    options.concurrency ?? registry.defaults.concurrency ?? REGISTRY_DEFAULT_CONCURRENCY;
  const limit = options.limit ?? registry.defaults.limit ?? REGISTRY_DEFAULT_LIMIT;

  /* One redactor for every resolved credential, shared by every client. Built from the values
   * directly — a client's own defensive redactor is per instance, but a cross-instance message
   * (an aggregate error) must also mask all of them (NFR-22/T62). */
  const secrets = registry.instances
    .map((instance) => instance.credential?.value)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const redactor = new Redactor(secrets);

  const clients = registry.instances.map((instance) => {
    const credential = instance.credential;
    return new InstanceClient({
      id: instance.id,
      base: instance.base,
      mode: instance.mode,
      allowInsecure,
      timeoutMs,
      redactor,
      clientName,
      sessionId,
      ...(instance.app === undefined ? {} : { app: instance.app }),
      ...(credential === undefined
        ? {}
        : {
            auth: {
              value: credential.value,
              ...(instance.tokenHeader === undefined ? {} : { header: instance.tokenHeader }),
              ...(instance.tokenScheme === undefined ? {} : { scheme: instance.tokenScheme }),
            },
          }),
    });
  });

  for (const client of clients) {
    try {
      const health = await client.health();
      /* A hub that answers `/health` with ok:false is degraded, not unusable: the identity check
       * above already passed. Log it once so the operator sees it, but do not abort the start. */
      if (health.ok === false) {
        process.stderr.write(
          `${LOG_PREFIX}instance "${client.id}" reports /health ok:false — starting degraded\n`,
        );
      }
      /* T49: an older hub without `app` is usable, but its identity is unverified. A missing
       * `federates` is NOT this case — `health()` raises `federates_missing` (T90). */
      if (health.unverified === true) {
        process.stderr.write(
          `${LOG_PREFIX}instance "${client.id}" does not report "app" in /config — identity unverified\n`,
        );
      }
    } catch (error) {
      const failure =
        error instanceof FederationError
          ? error
          : new FederationError(
              "instance_unreachable",
              `instance "${client.id}" could not be verified at start-up`,
              { instance: client.id },
            );
      /* T72/R6: a peer that is not up yet must not take the whole session down. It stays visible
       * in `list_instances` with `ok:false` and makes aggregates `partial`. */
      if (isDegradable(failure.code)) {
        process.stderr.write(
          `${LOG_PREFIX}instance "${client.id}" is not reachable at start-up (${failure.code}) — starting degraded\n`,
        );
        continue;
      }
      throw failure;
    }
  }

  /* No self, no HTTP server, no `/config`. `includeSelf: false` is the documented no-op of a pure
   * federator; `createFederatedBackend` ignores it when `self` is undefined. */
  const backend = createFederatedBackend({
    sources: clients,
    self: undefined,
    allowWrite: options.allowWrite === true,
    readOnly: options.readOnly === true,
    appName,
    clientName,
    defaults: { includeSelf: false, timeoutMs, concurrency, limit },
  });

  const writes = options.readOnly !== true && options.allowWrite === true ? "enabled" : "read-only";
  process.stderr.write(
    `${LOG_PREFIX}v${VERSION} — registry=${options.registryPath} instances=${clients.length} ` +
      `writes=${writes} session=${sessionId}\n`,
  );

  /* `runStdioServer` installs the stdin/stdout listeners and returns; the process stays alive on
   * stdin and exits 0 on EOF. stdout carries protocol frames only (stdio.ts guards console). */
  await runStdioServer({
    backend,
    appName,
    allowWrite: options.allowWrite === true,
    sessionId,
    serverName: "bluepencil-federator",
  });

  return {
    close: async () => {
      await backend.close();
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * Help and entry point
 * ---------------------------------------------------------------------------------------------- */

export const HELP = `bluepencil federator ${VERSION} — MCP over stdio, aggregated over a registry.

Usage:
  node dist/federator.js --registry <file> [--read-only] [--allow-write] [--allow-insecure]
    [--timeout <ms>] [--concurrency <1..16>] [--limit <1..1000>]
    [--app "<text>"] [--client-name "<text>"] [--session-id "<id>"]
      env: BLUEPENCIL_REGISTRY

A federator has no store, no HTTP endpoint and no /config: it reads every instance through the
registry and serves the aggregate over stdio. stdout is protocol-only; diagnostics go to stderr.

Federation (FR-16.12–16.15):
  --registry <path>              registry file; required (or BLUEPENCIL_REGISTRY)
  --read-only                    refuse every write, even with --allow-write (wins)
  --allow-write                  second lock for federated writes; a target still needs mode:"write"
  --allow-insecure               allow http and private IPs in the registry (link-local stays blocked)
  --timeout <ms>                 per-source timeout (default 3000, registry default wins if unset)
  --concurrency <1..16>          parallel instance reads (default 8)
  --limit <1..1000>              maximum notes in an aggregate (default 200)
  --app "<text>"                 MCP app label (default "bluepencil federator")
  --client-name "<text>"         provenance name sent to peers (default: the app label)
  --session-id <id>              session id recorded on writes (default: generated)

--include-self is a usage error here: a federator has no local store. --no-self is accepted as a
no-op (that is already the only mode). Use a hub with --registry for a combined aggregate.

Exit codes: 0 normal EOF, 1 usage, 4 invalid registry / identity failure, 5 partial runtime.
See plan §7 for the canonical error → exit mapping.`;

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (argv.includes("--version")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const parsed = parseFederatorArgs(argv);
  if (typeof parsed === "string") {
    process.stderr.write(`${LOG_PREFIX}${oneLine(parsed)}\n`);
    process.exit(1);
  }

  try {
    await startFederator(parsed);
  } catch (error) {
    const failure =
      error instanceof FederationError
        ? error
        : new FederationError("invalid_registry", oneLine(errorText(error)));
    /* Exactly one line, already redacted by the registry/client layer; never a stack trace. The
     * canonical code is prefixed so an operator (and the smoke test) can key on `federates_missing`
     * rather than parse prose. */
    process.stderr.write(`${LOG_PREFIX}${failure.code}: ${oneLine(failure.message)}\n`);
    process.exit(federationStartupExitCode(failure));
  }
}

/**
 * True when this module is the process entry point.
 *
 * npm installs `node_modules/.bin/<bin>` as a symlink, so `argv[1]` is the symlink while
 * `import.meta.url` is Node's realpath of the target. Comparing the URL strings would therefore
 * be false and the bin would exit 0 without doing anything — a silent no-op. Compare real paths
 * instead; a failed resolution (missing file, broken link) means "not the entry point".
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // Only the real entry point starts a session; importing this module (tests) never does.
  void main(process.argv.slice(2));
}
