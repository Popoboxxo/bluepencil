#!/usr/bin/env bash
# bluepencil MCP server — wrapper for Hermes (and any other MCP client that cannot pass argv).
#
# Why a wrapper: `hermes config set` cannot reliably write a YAML list for `args`, so the MCP
# registration points `command` at this script and passes everything through environment
# variables instead.
#
# Environment (set them in the mcp_servers.bluepencil.env block):
#   BLUEPENCIL_STORE        path to the note store (*.bluepencil.json bundle or bare Note[])
#   BLUEPENCIL_ENVIRONMENT  dev | staging | live            (default: dev)
#   BLUEPENCIL_APP          app name shown in exports        (default: unknown-app)
#   BLUEPENCIL_ALLOW_WRITE  1 = writes enabled for this session (default: read-only)
#   BLUEPENCIL_MCP_ENTRY    path to dist/mcp.js              (default: <repo>/dist/mcp.js)
#
# Read-only is the default on purpose (FR-16.2): a Hermes session may read notes, list them and
# export them, but every write tool returns a clear refusal until writes are opted in here.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
entry="${BLUEPENCIL_MCP_ENTRY:-$repo_dir/dist/mcp.js}"

if [[ ! -f "$entry" ]]; then
  echo "bluepencil-mcp: $entry not found — run 'npm run build' in $repo_dir first" >&2
  exit 1
fi

if [[ -z "${BLUEPENCIL_STORE:-}" ]]; then
  echo "bluepencil-mcp: BLUEPENCIL_STORE is required (path to a .bluepencil.json store)" >&2
  exit 1
fi

args=(--store "$BLUEPENCIL_STORE" --environment "${BLUEPENCIL_ENVIRONMENT:-dev}")
[[ -n "${BLUEPENCIL_APP:-}" ]] && args+=(--app "$BLUEPENCIL_APP")
[[ "${BLUEPENCIL_ALLOW_WRITE:-0}" == "1" ]] && args+=(--allow-write)

exec node "$entry" "${args[@]}"
