/**
 * The version every bluepencil artifact reports.
 *
 * One source: `package.json`. esbuild (`scripts/build.mjs`) replaces `__BLUEPENCIL_VERSION__` with it
 * while bundling, so library, element build, loader, CLI, MCP server and sidecar all report the same
 * string instead of each keeping its own literal (they did).
 *
 * `typeof` keeps this module working when the sources are used directly — unit tests, `tsx`, a REPL —
 * where nothing was substituted; that case reports `"dev"`, which is honest: there is no release.
 */
declare const __BLUEPENCIL_VERSION__: string | undefined;

export const VERSION: string = typeof __BLUEPENCIL_VERSION__ === "string" ? __BLUEPENCIL_VERSION__ : "dev";
