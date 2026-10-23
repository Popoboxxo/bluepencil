/**
 * `bluepencil instances validate|list|health` (FR-16.15, plan §6/§7).
 *
 * Kept out of `bin.ts` so the command logic is testable without spawning a process. The three
 * subcommands answer three different questions and keep those answers apart:
 *
 *  - `validate` and `list` are **offline file checks**. They run the same 0600/permission gate and
 *    the same `validateRegistry` pass as start-up, but inject no DNS resolver (FR-16.15). A
 *    hostname that rebinds to link-local space is therefore a start-up finding, not a CLI finding.
 *  - `health` is the online probe: `/config` (identity, `federates`) plus `/health` per instance.
 *    It is the command an operator runs when the registry may have drifted (R7) and it follows the
 *    canonical exit table exactly: misconfiguration/identity = 4, unreachable/unhealthy = 5,
 *    all healthy = 0.
 *
 * Secret hygiene is structural: `list` publishes only id/app/base/mode, `health` publishes only
 * id/app/environment/ok/unverified/version/code, and every client shares one {@link Redactor} built
 * from the resolved credential values. No code path prints `auth`, an environment value or a token
 * (NFR-22/T42–T44, T30/T70).
 */

import { booleanFlag } from "../argv";
import { InstanceClient } from "../federation/client";
import { FederationError, Redactor, toExitCode } from "../federation/errors";
import type { Environment } from "../core/model";
import {
  REGISTRY_DEFAULT_TIMEOUT_MS,
  REGISTRY_MAX_TIMEOUT_MS,
  RegistryError,
  loadRegistry,
  loadRegistryFile,
  registryStartupError,
  type ResolvedInstance,
  type ResolvedRegistry,
} from "../federation/registry";

export interface InstancesIo {
  out(text: string): void;
  err(text: string): void;
}

const PROCESS_IO: InstancesIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

export const INSTANCES_USAGE = `bluepencil instances — inspect a federation registry.

Usage:
  bluepencil instances validate --registry <file> [--json] [--allow-insecure]
  bluepencil instances list     --registry <file> [--json] [--allow-insecure]
  bluepencil instances health   --registry <file> [--json] [--check] [--timeout <ms>] [--allow-insecure]
      env: BLUEPENCIL_REGISTRY

  validate  offline: file permissions, JSON shape and every registry rule; prints issue
            paths/codes/messages. Nothing is contacted.
  list      offline: prints id, app, base and mode of every instance. Never auth/env values.
  health    online: probes /config and /health of every instance (DNS/HTTP). health always
            probes; --check is accepted for compatibility. Exit 0 all healthy, 4 misconfigured,
            5 unreachable/unhealthy.

  --allow-insecure admits http and private IPs in the registry (link-local and metadata stay
  blocked). validate and list remain offline — the flag only changes the URL policy, it never
  triggers DNS.

Exit codes: 0 ok, 1 usage, 4 invalid registry, 5 degraded.`;

type Command = "validate" | "list" | "health";

interface InstanceFlags {
  registryPath: string;
  json: boolean;
  check: boolean;
  allowInsecure: boolean;
  timeoutMs?: number;
}

interface ParsedInstances {
  command: Command;
  flags: InstanceFlags;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------------------------------------
 * Argument parsing
 * ---------------------------------------------------------------------------------------------- */

function valueOf(argv: string[], index: number): string | undefined {
  const arg = argv[index] as string;
  const equals = arg.indexOf("=");
  if (equals >= 0) return arg.slice(equals + 1);
  const next = argv[index + 1];
  return next !== undefined && !next.startsWith("--") ? next : undefined;
}

function parseInstancesArgv(
  argv: string[],
  env: NodeJS.ProcessEnv,
): ParsedInstances | string {
  const [rawCommand, ...rest] = argv;
  if (rawCommand === undefined || rawCommand === "") {
    return "instances needs a subcommand: validate, list or health";
  }
  if (rawCommand === "--help" || rawCommand === "-h" || rawCommand === "help") {
    return INSTANCES_USAGE;
  }
  if (rawCommand !== "validate" && rawCommand !== "list" && rawCommand !== "health") {
    return `unknown instances subcommand ${JSON.stringify(rawCommand)} — use validate, list or health`;
  }
  const command: Command = rawCommand;

  let registry: string | undefined;
  let json = false;
  let check = false;
  let timeoutMs: number | undefined;

  /* F-06: strict boolean, same helper as the hub/federator. Without it a lab registry using
   * `http://hub-dev:8787/...` cannot be inspected or probed at all. */
  const allowInsecure = booleanFlag(rest, "--allow-insecure");
  if (typeof allowInsecure === "string") return allowInsecure;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (!arg.startsWith("--")) {
      return `unexpected argument ${JSON.stringify(arg)}`;
    }
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;

    switch (name) {
      case "--registry": {
        const value = valueOf(rest, index);
        if (value === undefined || value.trim() === "") {
          return "--registry requires a file path";
        }
        registry = value;
        if (!arg.includes("=")) index += 1;
        break;
      }
      case "--timeout": {
        const value = valueOf(rest, index);
        if (value === undefined) return "--timeout requires a value in milliseconds";
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > REGISTRY_MAX_TIMEOUT_MS) {
          return `--timeout must be an integer between 1 and ${REGISTRY_MAX_TIMEOUT_MS} (got ${JSON.stringify(value)})`;
        }
        timeoutMs = parsed;
        if (!arg.includes("=")) index += 1;
        break;
      }
      case "--json": {
        json = arg.includes("=") ? valueOf(rest, index) !== "false" : true;
        break;
      }
      case "--check": {
        check = arg.includes("=") ? valueOf(rest, index) !== "false" : true;
        break;
      }
      case "--allow-insecure": {
        /* The shared parser validated the value before the loop; here only the space-separated
         * form needs its value token consumed so it is not read as a positional. */
        if (!arg.includes("=") && (rest[index + 1] === "true" || rest[index + 1] === "false")) {
          index += 1;
        }
        break;
      }
      default:
        return `unknown option ${JSON.stringify(name)} — use --registry, --json, --check, --timeout or --allow-insecure`;
    }
  }

  const registryPath = (registry ?? env.BLUEPENCIL_REGISTRY ?? "").trim();
  if (registryPath === "") {
    return "--registry <file> is required (or set BLUEPENCIL_REGISTRY)";
  }

  return {
    command,
    flags: {
      registryPath,
      json,
      check,
      allowInsecure: allowInsecure === true,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * Shared projections
 * ---------------------------------------------------------------------------------------------- */

/** The only instance fields `list` may publish — never `auth`, an env value or a credential. */
function listRows(
  registry: ResolvedRegistry,
): Array<{ id: string; app: string | null; base: string; mode: "read" | "write" }> {
  return registry.instances.map((instance) => ({
    id: instance.id,
    app: instance.app ?? null,
    base: instance.base,
    mode: instance.mode,
  }));
}

function listLine(instance: ResolvedInstance): string {
  return `${instance.id}\t${instance.app ?? "-"}\t${instance.base}\t${instance.mode}`;
}

function printIssues(io: InstancesIo, path: string, error: RegistryError): void {
  io.out(`${path}: ${error.issues.length} issue(s)\n`);
  for (const issue of error.issues) {
    const where = issue.path === "" ? "<root>" : issue.path;
    io.out(`  - ${where}: ${issue.code}: ${issue.message}\n`);
  }
}

/** The `issues` projection of a validation failure; keeps the public shape stable. */
function issueRows(
  error: RegistryError,
): Array<{ path: string; code: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path === "" ? "<root>" : issue.path,
    code: issue.code,
    message: issue.message,
  }));
}

/** The canonical `{ code, message }` block every `--json` failure carries. */
function errorBlock(failure: FederationError): { code: string; message: string } {
  return { code: failure.code, message: failure.message };
}

/* ------------------------------------------------------------------------------------------------
 * Offline commands
 * ---------------------------------------------------------------------------------------------- */

async function runValidate(
  flags: InstanceFlags,
  io: InstancesIo,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  let registry: ResolvedRegistry;
  try {
    registry = await loadRegistryFile(flags.registryPath, env, {
      allowInsecure: flags.allowInsecure,
    });
  } catch (error) {
    const failure = registryStartupError(error);
    if (flags.json) {
      /* A loader failure is a validation failure like any other: the machine-readable report must
       * stay JSON, with the canonical code in `error` and (for a document-level finding) the
       * detailed `issues` array too. */
      io.out(
        `${JSON.stringify(
          {
            path: flags.registryPath,
            valid: false,
            ...(error instanceof RegistryError ? { issues: issueRows(error) } : {}),
            error: errorBlock(failure),
          },
          null,
          2,
        )}\n`,
      );
    } else if (error instanceof RegistryError) {
      printIssues(io, flags.registryPath, error);
    } else {
      io.err(`bluepencil: ${oneLine(failure.message)}\n`);
    }
    return toExitCode(failure, "runtime");
  }

  if (flags.json) {
    io.out(
      `${JSON.stringify(
        { path: flags.registryPath, valid: true, instances: listRows(registry) },
        null,
        2,
      )}\n`,
    );
  } else {
    io.out(`${flags.registryPath}: valid (${registry.instances.length} instance(s))\n`);
    for (const instance of registry.instances) {
      io.out(`  ${listLine(instance)}\n`);
    }
  }
  return 0;
}

async function runList(
  flags: InstanceFlags,
  io: InstancesIo,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  let registry: ResolvedRegistry;
  try {
    registry = await loadRegistryFile(flags.registryPath, env, {
      allowInsecure: flags.allowInsecure,
    });
  } catch (error) {
    const failure = registryStartupError(error);
    if (flags.json) {
      io.out(
        `${JSON.stringify(
          { path: flags.registryPath, instances: [], error: errorBlock(failure) },
          null,
          2,
        )}\n`,
      );
    } else {
      io.err(`bluepencil: ${oneLine(failure.message)}\n`);
    }
    return toExitCode(failure, "runtime");
  }

  const rows = listRows(registry);
  if (flags.json) {
    io.out(`${JSON.stringify(rows, null, 2)}\n`);
  } else {
    for (const instance of registry.instances) {
      io.out(`${listLine(instance)}\n`);
    }
  }
  return 0;
}

/* ------------------------------------------------------------------------------------------------
 * Online command
 * ---------------------------------------------------------------------------------------------- */

interface HealthRow {
  id: string;
  app?: string;
  environment?: Environment;
  ok: boolean;
  unverified?: boolean;
  version?: string;
  code?: string;
}

function healthLine(row: HealthRow): string {
  const state = row.ok ? (row.unverified === true ? "unverified" : "ok") : "unhealthy";
  const details: string[] = [];
  if (row.app !== undefined) details.push(`app=${row.app}`);
  if (row.environment !== undefined) details.push(`env=${row.environment}`);
  if (row.version !== undefined) details.push(`version=${row.version}`);
  if (row.code !== undefined) details.push(`code=${row.code}`);
  return `${row.id}: ${state}${details.length === 0 ? "" : ` (${details.join(", ")})`}`;
}

async function runHealth(
  flags: InstanceFlags,
  io: InstancesIo,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  let registry: ResolvedRegistry;
  try {
    /* Online loader: DNS resolution is on purpose here, exactly like start-up (F-01/T80).
     * `--allow-insecure` is the same lab override start-up accepts (F-06). */
    registry = await loadRegistry(flags.registryPath, env, {
      allowInsecure: flags.allowInsecure,
    });
  } catch (error) {
    const failure = registryStartupError(error);
    if (flags.json) {
      io.out(
        `${JSON.stringify(
          { ok: false, instances: [], error: errorBlock(failure) },
          null,
          2,
        )}\n`,
      );
    } else {
      io.err(`bluepencil: ${oneLine(failure.message)}\n`);
    }
    return toExitCode(failure, "health");
  }

  const timeoutMs = flags.timeoutMs ?? registry.defaults.timeoutMs ?? REGISTRY_DEFAULT_TIMEOUT_MS;

  /* Every resolved credential value goes into one redactor. Only codes/labels leave this module,
   * but the clients build their own error messages, so the shared redactor is the backstop. */
  const secrets = registry.instances
    .map((instance) => instance.credential?.value)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const redactor = new Redactor(secrets);

  const rows: HealthRow[] = [];
  /* 0 healthy < 5 degraded < 4 misconfigured; a numeric max would rank 5 above 4, so escalate
   * explicitly. A single configuration/identity failure must dominate a merely dead peer. */
  let worst = 0;
  const escalate = (code: number): void => {
    if (code === 4) worst = 4;
    else if (code === 5 && worst !== 4) worst = 5;
  };

  for (const instance of registry.instances) {
    const credential = instance.credential;
    const client = new InstanceClient({
      id: instance.id,
      base: instance.base,
      mode: instance.mode,
      allowInsecure: flags.allowInsecure,
      timeoutMs,
      redactor,
      clientName: "bluepencil instances health",
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

    try {
      const health = await client.health();
      const row: HealthRow = { id: instance.id, ok: health.ok };
      const app = health.app ?? instance.app;
      if (app !== undefined) row.app = app;
      if (health.environment !== undefined) row.environment = health.environment;
      if (health.unverified === true) row.unverified = true;
      if (health.version !== undefined) row.version = health.version;
      /* `/health` answering ok:false is a degraded instance; the canonical code for a response
       * that cannot be trusted is `invalid_response` (health 5, §7). */
      if (!health.ok) row.code = "invalid_response";
      rows.push(row);
      if (!health.ok || health.unverified === true) escalate(5);
    } catch (error) {
      const failure =
        error instanceof FederationError
          ? error
          : new FederationError("instance_unreachable", "the instance could not be probed", {
              instance: instance.id,
            });
      const row: HealthRow = { id: instance.id, ok: false, code: failure.code };
      if (instance.app !== undefined) row.app = instance.app;
      rows.push(row);
      /* A probe that failed is unhealthy even for a code §7 marks "not a health case" (0): an
       * instance that answers /health with 404 is not healthy. Only a misconfiguration/identity
       * failure (4) outranks the degraded result. */
      escalate(toExitCode(failure, "health") === 4 ? 4 : 5);
    }
  }

  if (flags.json) {
    io.out(`${JSON.stringify({ ok: worst === 0, instances: rows }, null, 2)}\n`);
  } else {
    for (const row of rows) {
      io.out(`${healthLine(row)}\n`);
    }
  }

  return worst;
}

/* ------------------------------------------------------------------------------------------------
 * Entry
 * ---------------------------------------------------------------------------------------------- */

/**
 * Runs one `instances` invocation and returns its documented exit code. The caller (`bin.ts`)
 * performs the `process.exit`, so this function stays unit-testable with an injected IO.
 */
export async function runInstances(
  argv: string[],
  io: InstancesIo = PROCESS_IO,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const parsed = parseInstancesArgv(argv, env);
  if (typeof parsed === "string") {
    if (parsed.startsWith("bluepencil instances —")) {
      io.out(`${parsed}\n`);
      return 0;
    }
    io.err(`bluepencil: ${oneLine(parsed)}\n`);
    return 1;
  }

  switch (parsed.command) {
    case "validate":
      return runValidate(parsed.flags, io, env);
    case "list":
      return runList(parsed.flags, io, env);
    case "health":
      return runHealth(parsed.flags, io, env);
  }
}
