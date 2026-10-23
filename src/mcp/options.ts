/**
 * Command-line parsing for the standalone `bluepencil mcp` entry point (FR-16.2).
 *
 * Split out of `server.ts` so the parse is testable without importing a module whose top level
 * starts the stdio loop. The write lock is a security-relevant default: a malformed value must be
 * a usage error, never a silent `true` (see {@link booleanFlag}), and the environment fallback is
 * fail-closed on everything except an explicit `"1"`.
 */
import { booleanFlag } from "../argv";
import { DEFAULT_ENVIRONMENT, isEnvironment, newId, type Environment } from "../core/model";

export interface McpServerOptions {
  storePath: string;
  environment: Environment;
  appName: string;
  allowWrite: boolean;
  sessionId: string;
}

/**
 * Environment fallback for `--allow-write`.
 *
 * Explicit and fail-closed: only `"1"` enables writes. `undefined`, `""`, `"0"` and `"false"`
 * disable them, and any other value (including `"true"`, `"yes"` or a typo) also stays disabled —
 * the write lock must never be opened by an unrecognised string. The docs (`docs/HERMES.md`) use
 * `BLUEPENCIL_ALLOW_WRITE=1`, so that is the only accepted spelling.
 */
export function allowWriteFromEnv(raw: string | undefined): boolean {
  if (raw === undefined || raw === "") return false;
  return raw === "1";
}

/**
 * Parses the MCP entry arguments.
 *
 * Returns the resolved options on success and a usage string on failure — the same
 * `options | string` contract as `parseHubArgs` and `parseFederatorArgs`.
 *
 * Precedence: an explicit flag always wins over the environment, including an explicit
 * `--allow-write=false` while `BLUEPENCIL_ALLOW_WRITE=1` is set (the narrow answer is the safe
 * one). `env` is injectable for tests; production passes `process.env`.
 */
export function parseMcpArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): McpServerOptions | string {
  const get = (flag: string): string | undefined => {
    const withEquals = argv.find((arg) => arg.startsWith(`${flag}=`));
    if (withEquals !== undefined) return withEquals.slice(flag.length + 1);
    const index = argv.indexOf(flag);
    if (index < 0) return undefined;
    const next = argv[index + 1];
    return next !== undefined && !next.startsWith("--") ? next : undefined;
  };

  const VALUED_FLAGS = ["--store", "--environment", "--app", "--session-id"] as const;

  /* F5, same contract as `parseHubArgs`/`parseFederatorArgs`: a value flag followed by another
   * flag is a usage error, never "the next flag is the value". `--store --allow-write` used to
   * yield `storePath: "--allow-write"` *and* enable writes — a wrong store plus an open write
   * lock. An empty `--flag=` value is refused for the same reason. */
  for (const flag of VALUED_FLAGS) {
    const withEquals = argv.find((arg) => arg.startsWith(`${flag}=`));
    if (withEquals !== undefined) {
      if (withEquals.length === flag.length + 1) {
        return `${flag} requires a value (got "")`;
      }
      continue;
    }
    const index = argv.indexOf(flag);
    if (index < 0) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--") || next === "") {
      return `${flag} requires a value (got ${next === undefined ? "nothing" : JSON.stringify(next)})`;
    }
  }

  const storePath = get("--store") ?? env["BLUEPENCIL_STORE"] ?? "";
  if (!storePath) {
    return "--store <path> is required (a .bluepencil.json bundle or a bare notes array)";
  }
  const environment = (get("--environment") ?? env["BLUEPENCIL_ENVIRONMENT"] ?? DEFAULT_ENVIRONMENT) as string;
  if (!isEnvironment(environment)) {
    return `--environment must be one of dev, staging, live (got "${environment}")`;
  }

  /* F-04 parity: parse the flag, never probe it with `includes`. `--allow-write false` used to
   * evaluate true because only presence was checked, which is a fail-open on the write lock. */
  const allowWriteFlag = booleanFlag(argv, "--allow-write");
  if (typeof allowWriteFlag === "string") return allowWriteFlag;
  const allowWrite = allowWriteFlag ?? allowWriteFromEnv(env["BLUEPENCIL_ALLOW_WRITE"]);

  return {
    storePath,
    environment,
    appName: get("--app") ?? env["BLUEPENCIL_APP"] ?? "unknown-app",
    allowWrite,
    sessionId: get("--session-id") ?? env["BLUEPENCIL_SESSION"] ?? newId("s"),
  };
}
