/**
 * Shared command-line helpers for the bluepencil binaries (hub, federator, CLI).
 *
 * The one rule this module exists to enforce: a boolean flag is *parsed*, never probed with
 * `Array.includes`. A presence check turns `--allow-write false` into `true`, which is a
 * fail-open on exactly the flags that gate writes and network policy. Treating a present but
 * unparsable value as a usage error keeps a typo visible instead of silently applying a default.
 *
 * The module is dependency-free and side-effect-free (`src/` is also bundled for the browser),
 * so it can be shared by every entry point.
 */

/** The usage string a caller returns (and the CLI prints as exit 1) for a malformed value. */
function usage(flag: string, value: string): string {
  return `${flag} must be true or false (got ${JSON.stringify(value)})`;
}

/**
 * Parses a boolean flag in every documented spelling:
 *
 *  - absent → `undefined` (so a caller can apply its own default or a config fallback);
 *  - bare `--flag` → `true`;
 *  - `--flag=true` / `--flag=false` → that boolean;
 *  - `--flag true` / `--flag false` → that boolean (the value token is consumed semantically);
 *  - anything else → the usage string `--flag must be true or false (got "<value>")`.
 *
 * A bare flag followed by another flag (`--other`) stays `true`; the next argument is not
 * consumed. When a flag occurs more than once, the last valid value wins — but any invalid
 * occurrence is a usage error, never a silent fallback.
 */
export function booleanFlag(
  argv: readonly string[],
  flag: string,
): boolean | string | undefined {
  let value: boolean | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === flag) {
      const next = argv[index + 1];
      // The next token is another flag (or nothing): the bare form means true.
      if (next === undefined || next.startsWith("--")) {
        value = true;
        continue;
      }
      if (next === "true" || next === "false") {
        value = next === "true";
        index += 1;
        continue;
      }
      // A present non-boolean value is a usage error, never a silent `true`.
      return usage(flag, next);
    }
    if (!arg.startsWith(`${flag}=`)) continue;
    const raw = arg.slice(flag.length + 1);
    if (raw === "true" || raw === "false") {
      value = raw === "true";
      continue;
    }
    return usage(flag, raw);
  }
  return value;
}
