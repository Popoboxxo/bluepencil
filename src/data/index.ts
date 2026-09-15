/**
 * `bluepencil/data` — the headless data layer (FR-15.1/15.3/15.4).
 *
 * Schema, canonical serialisation, bundle I/O, merge and migrations. DOM-free and free of
 * runtime dependencies: it runs unchanged in the browser bundle, in plain Node (CLI) and in
 * the MCP server, which are all thin layers over exactly these functions.
 *
 * No side effects — importing this module only exposes the API.
 */
export * from "./schema";
export * from "./canonical";
export * from "./bundle";
export * from "./merge";
export * from "./migrate";
