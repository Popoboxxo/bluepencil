/**
 * `bluepencil token` — the argument parsing and output around `mint.ts` (#36, phase 2).
 *
 * Split from the minting itself so `mint.ts` stays pure and testable, and this file stays the only
 * place that touches a process stream.
 *
 * The key is read from `BLUEPENCIL_TOKEN_KEY` or `--key`, never from a positional argument, and the
 * output is one token on stdout with everything else on stderr. That split is what makes
 * `TOKEN=$(bluepencil token --device laptop)` work without dragging the explanatory lines into the
 * variable — and it is the difference between a command that is usable in a script and one that is
 * only usable by reading it.
 */
import { mintToken, parseScope } from "./mint";

const HELP = `bluepencil token — mint a signed device token for a hub (#36, phase 2).

  Usage: bluepencil token --device <name> [--scope read|write|read,write] [--ttl <seconds>]

  The signing key must match the hub's --token-key / BLUEPENCIL_TOKEN_KEY. It is read from the
  environment or from --key, never from a positional argument, so it stays out of the process list
  and out of shell history as far as the environment allows.

  Options:
    --device <name>   Required. Recorded in the token so a revocation list can be read by a human.
    --scope <list>    read, write, or both. Default: both.
    --ttl <seconds>   Lifetime. Default: 24 hours.
    --key <value>     The signing key. Prefer BLUEPENCIL_TOKEN_KEY over this.
    --help            This text.

  The token goes to stdout and nothing else does, so it can be captured:
      export BLUEPENCIL_TOKEN=$(bluepencil token --device work-laptop)

  To revoke it later, put the printed id in the hub's --revoked-tokens file and restart it.
  Tokens are short-lived, so rotating the key also invalidates every one of them at once.
`;

function flag(argv: readonly string[], name: string): string | undefined {
  const withEquals = argv.find((arg) => arg.startsWith(`${name}=`));
  if (withEquals !== undefined) return withEquals.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const next = argv[index + 1];
  return next !== undefined && !next.startsWith("--") ? next : undefined;
}

/** Runs the command. Returns a process exit code instead of calling `process.exit`, so it is testable. */
export async function runTokenCommand(argv: readonly string[]): Promise<number> {
  const out = (line: string): void => void process.stdout.write(`${line}\n`);
  const err = (line: string): void => void process.stderr.write(`${line}\n`);

  if (argv.includes("--help") || argv.includes("-h")) {
    out(HELP);
    return 0;
  }

  const device = flag(argv, "--device");
  if (device === undefined) {
    err("token: --device <name> is required — it is what a revocation list is read by");
    err("token: run `bluepencil token --help` for the rest.");
    return 2;
  }

  const key = flag(argv, "--key") ?? process.env.BLUEPENCIL_TOKEN_KEY;
  if (key === undefined) {
    // Naming both sources matters more than it looks: an operator who set the key on the hub and
    // not here should be told where it is called, not left guessing.
    err("token: no signing key — set BLUEPENCIL_TOKEN_KEY or pass --key");
    err("token: the key must match the hub's --token-key; they are different from --auth-secret.");
    return 2;
  }
  if (key.length === 0) {
    err("token: the signing key is empty — an empty key would sign with nothing");
    return 2;
  }

  const scope = parseScope(flag(argv, "--scope"));
  if (typeof scope === "string") {
    err(`token: ${scope}`);
    return 2;
  }

  const ttlRaw = flag(argv, "--ttl");
  let ttlSeconds: number | undefined;
  if (ttlRaw !== undefined) {
    const parsed = Number.parseInt(ttlRaw, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      err(`token: --ttl must be a positive number of seconds, got ${ttlRaw}`);
      return 2;
    }
    ttlSeconds = parsed;
  }

  try {
    const result = mintToken({ key, device, scope, ...(ttlSeconds !== undefined ? { ttlSeconds } : {}) });
    // stdout carries the token and nothing else, so `export X=$(bluepencil token …)` is safe. The
    // context goes to stderr, where it is read by the person and ignored by the shell.
    out(result.token);
    err(`device:  ${result.device}`);
    err(`scope:   ${result.scope.join(" + ")}`);
    err(`expires: ${result.expiresAt}`);
    err(`id:      ${result.id}   ← this is what goes in --revoked-tokens`);
    return 0;
  } catch (error) {
    err(`token: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}
