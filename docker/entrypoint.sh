#!/bin/sh
#
# Starts the hub in a container (FR-6.14).
#
# Why this script exists instead of a plain `CMD node server.js`:
#
#   - **A container must bind beyond loopback** or nothing outside it can reach the hub. That is
#     exactly the case the hub requires a credential for, and a container that refuses every request
#     until its operator reads a manual is not "running in Docker", it is broken. So if no credential
#     was handed in, one is generated — and kept in the data volume, because a restart that changes
#     the secret silently invalidates every client that already saved it.
#   - **One line to copy.** The first start prints the address and the credential, which is the whole
#     setup: paste it into the extension (or an MCP client) and the notes are shared.
#
# Everything can be overridden with environment variables (see docs/DOCKER.md); extra arguments are
# passed straight to the hub, e.g. `docker run … bluepencil --read-only`.
set -eu

STORE="${BLUEPENCIL_STORE:-/data/notes.bluepencil.json}"
PORT="${BLUEPENCIL_PORT:-8787}"
BASE="${BLUEPENCIL_BASE:-/api/v1/bluepencil}"
NAME="${BLUEPENCIL_NAME:-$(hostname)}"
SECRET_FILE="${BLUEPENCIL_SECRET_FILE:-/data/.bluepencil-auth}"
# Where the bundle lives inside the image. Overridable so this script can be exercised outside a
# container — one line, and it makes the credential logic testable without a Docker daemon.
SERVER_JS="${BLUEPENCIL_SERVER_JS:-/app/server.js}"

generated=""
if [ -z "${BLUEPENCIL_AUTH_SECRET:-}" ] && [ -z "${BLUEPENCIL_TOKEN_KEY:-}" ]; then
  if [ -f "${SECRET_FILE}" ]; then
    BLUEPENCIL_AUTH_SECRET="$(cat "${SECRET_FILE}")"
  else
    # 32 bytes of hex; `od` is busybox-provided, so this works in the alpine image without openssl.
    BLUEPENCIL_AUTH_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    umask 077
    printf '%s' "${BLUEPENCIL_AUTH_SECRET}" > "${SECRET_FILE}"
    generated="yes"
  fi
  export BLUEPENCIL_AUTH_SECRET
fi

echo "bluepencil hub \"${NAME}\" — store ${STORE}"
echo "  address:    http://<host>:${PORT}${BASE}"
echo "  mcp:        POST http://<host>:${PORT}${BASE}/mcp   (tools/list, tools/call, …)"
if [ -n "${BLUEPENCIL_TOKEN_KEY:-}" ]; then
  echo "  credential: signed token (--token-key) — mint one with: bluepencil token --device <name>"
elif [ -n "${BLUEPENCIL_AUTH_SECRET:-}" ]; then
  if [ -n "${generated}" ]; then
    echo "  credential: shared secret, generated now and kept in ${SECRET_FILE} (0600)"
    echo "  header:     x-bluepencil-auth: ${BLUEPENCIL_AUTH_SECRET}"
  else
    echo "  credential: shared secret, kept in ${SECRET_FILE} (0600) — set BLUEPENCIL_AUTH_SECRET to override"
  fi
else
  echo "  credential: none — every caller that can reach this port may read and write"
fi

exec node "${SERVER_JS}" --store "${STORE}" --port "${PORT}" --base "${BASE}" \
  --host 0.0.0.0 --name "${NAME}" "$@"
