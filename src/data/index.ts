/**
 * `bluepencil/data` — the headless data layer (FR-15.1/15.3/15.4).
 *
 * Schema, canonical serialisation, bundle I/O, merge and migrations. DOM-free and free of
 * runtime dependencies: it runs unchanged in the browser bundle, in plain Node (CLI) and in
 * the MCP server, which are all thin layers over exactly these functions.
 *
 * No side effects — importing this module only exposes the API.
 *
 * The export surface is symmetric: every data module is star-exported, and the origin contract
 * (one normaliser, one note-set codec, one storage-key layout) is reachable from here so the
 * extension review page can bundle `dist/data.js` without importing an adapter (B.0/B.2).
 */
export * from "./schema";
export * from "./canonical";
export * from "./bundle";
export * from "./merge";
export * from "./migrate";
export * from "./order";
export * from "./origin";
export * from "./note-set";
export * from "./legacy-assign";
export { normaliseOrigin, parseOriginInput, originOf, currentOrigin } from "../core/origin";
export type { Note, NoteOrigin } from "../core/model";
