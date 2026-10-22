/**
 * `bluepencil/federation` — instance identity, registry resolution, HTTP client, errors and the
 * read aggregate (FR-16.10/16.11/16.12, plan §6).
 *
 * Only modules that carry no runtime dependency on the MCP layer are re-exported here; session
 * wiring stays in the MCP layer.
 */
export * from "./errors";
export * from "./ids";
export * from "./net-policy";
export * from "./registry";
export * from "./client";
export * from "./aggregate";
export * from "./backend";
