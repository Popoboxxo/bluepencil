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
#   - **The credential stays out of the logs.** `docker logs` is kept, shipped and pasted into
#     tickets, so a secret printed there outlives the container. The first start therefore names the
#     file and the one command that reads it; `BLUEPENCIL_SHOW_SECRET_ONCE=1` opts into the old
#     copy-paste line for a single start (SEC-12/G12).
#
# Everything can be overridden with environment variables (see docs/DOCKER.md); extra arguments are
# passed straight to the hub, e.g. `docker run … bluepencil --read-only`.
set -eu

# The image also ships the stdio federator. `docker run … bluepencil-federator …` must start that
# bin rather than pass a stray positional argument to the hub, and it must do so *before* any of the
# banner/credential work below: a federator's stdout is newline-delimited JSON-RPC and nothing else.
# Only the two documented bins dispatch here, so every other first argument keeps its hub meaning
# (`--read-only`, `--store …`, …). `docker run --entrypoint bluepencil-hub …` works the same way.
if [ "$#" -gt 0 ]; then
  case "$1" in
    bluepencil-hub|bluepencil-federator) exec "$@" ;;
  esac
fi

STORE="${BLUEPENCIL_STORE:-/data/notes.bluepencil.json}"
PORT="${BLUEPENCIL_PORT:-8787}"
BASE="${BLUEPENCIL_BASE:-/api/v1/bluepencil}"
NAME="${BLUEPENCIL_NAME:-$(hostname)}"
SECRET_FILE="${BLUEPENCIL_SECRET_FILE:-/data/.bluepencil-auth}"
# Opt-in for the one-time secret echo (SEC-12). Anything but `1` keeps the default: the value is
# never written to stdout, so it cannot end up in the container log that `docker logs` reproduces.
SHOW_SECRET_ONCE="${BLUEPENCIL_SHOW_SECRET_ONCE:-}"
# Where the bundle lives inside the image. Overridable so this script can be exercised outside a
# container — one line, and it makes the credential logic testable without a Docker daemon.
SERVER_JS="${BLUEPENCIL_SERVER_JS:-/app/server.js}"

# The shared secret is set up whenever one was not handed in — *independent* of the token key. A
# hub can accept both credentials at once (server/credentials.ts), and a client that already holds
# the secret must keep working when an operator later adds `--token-key`. Skipping this block on a
# token key is what silently disabled the secret before (#108).
secret_source=""
if [ -z "${BLUEPENCIL_AUTH_SECRET:-}" ]; then
  # `-s`, not `-f`: a 0-byte file counts as "not present" and is regenerated. The hub refuses an
  # empty secret and an empty leftover (a start killed between create and write, or a hand-made
  # file) would never be replaced, so the container would fail on every restart. Self-healing here
  # is the documented behaviour — an empty file must never be exported as a usable secret.
  if [ -s "${SECRET_FILE}" ]; then
    BLUEPENCIL_AUTH_SECRET="$(cat "${SECRET_FILE}")"
    secret_source="file"
  else
    # 32 bytes of hex; `od` is busybox-provided, so this works in the alpine image without openssl.
    BLUEPENCIL_AUTH_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    # A read-only mount or a missing directory must fail loudly and actionably. Without this guard
    # the shell's bare "cannot create …: Permission denied" was the entire message and the start
    # aborted before the banner, so the operator only learned what to do from the exit code. The
    # secret is never exported when it was not persisted: no client could be told about it.
    write_error=""
    if ! write_error="$( { umask 077; printf '%s' "${BLUEPENCIL_AUTH_SECRET}" > "${SECRET_FILE}"; } 2>&1 )"; then
      echo "bluepencil hub: cannot persist the shared secret to ${SECRET_FILE}" >&2
      echo "  detail: ${write_error:-write failed}" >&2
      echo "  Set BLUEPENCIL_AUTH_SECRET to a stable value yourself, or point BLUEPENCIL_SECRET_FILE" >&2
      echo "  at a writable path. Refusing to start: a secret that was not persisted cannot be" >&2
      echo "  handed to a client." >&2
      exit 2
    fi
    # An existing 0-byte leftover keeps its old mode through `>`, so tighten it here: the banner
    # promises 0600, and a secret must not stay world-readable just because the file predates it.
    # Best effort — a filesystem without chmod support must not block an otherwise usable start.
    chmod 600 "${SECRET_FILE}" 2>/dev/null ||
      echo "  warning: could not set 0600 on ${SECRET_FILE} — check its permissions" >&2
    secret_source="generated"
  fi
  export BLUEPENCIL_AUTH_SECRET
else
  secret_source="environment"
fi

echo "bluepencil hub \"${NAME}\" — store ${STORE}"
echo "  address:    http://<host>:${PORT}${BASE}"
echo "  mcp:        POST http://<host>:${PORT}${BASE}/mcp   (tools/list, tools/call, …)"
# The viewer is a second listener with its own origin (0.14.0+); this script decides nothing about
# it and appends no flag — the port and its flags arrive through "$@" or the inherited
# BLUEPENCIL_VIEWER_* environment. The one thing worth saying out loud is the obligation the
# container inherits: the fixed `--host 0.0.0.0` below is a *wildcard* bind, so a viewer without
# `--viewer-origin` (or a loopback `--viewer-host`) refuses to start with `viewer_origin_required`.
if [ -n "${BLUEPENCIL_VIEWER_PORT:-}" ]; then
  echo "  viewer:     port ${BLUEPENCIL_VIEWER_PORT} (second listener) — enabled by --viewer or BLUEPENCIL_VIEWER"
  echo "              not published unless you map it in docker-compose.yml; this container binds"
  echo "              --host 0.0.0.0, so --viewer-origin is required (or a loopback --viewer-host)"
fi
# Name every accepted credential. The token key is never printed; the shared secret is identified by
# its source. A freshly generated value is *not* echoed: the default prints the path plus the one
# command that reads it back, and `BLUEPENCIL_SHOW_SECRET_ONCE=1` restores the single echo (SEC-12).
if [ -n "${BLUEPENCIL_TOKEN_KEY:-}" ]; then
  echo "  credential: token (Authorization: Bearer …) — mint one with: bluepencil token --device <name>"
fi
if [ -n "${BLUEPENCIL_AUTH_SECRET:-}" ]; then
  case "${secret_source}" in
    generated)
      echo "  credential: shared secret (x-bluepencil-auth) — generated now and kept in ${SECRET_FILE} (0600)"
      if [ "${SHOW_SECRET_ONCE}" = "1" ]; then
        echo "  header:     x-bluepencil-auth: ${BLUEPENCIL_AUTH_SECRET}   (opt-in once — BLUEPENCIL_SHOW_SECRET_ONCE=1)"
      else
        echo "  retrieve:   docker exec <container> cat ${SECRET_FILE}"
        echo "  note:       not printed, so it stays out of \`docker logs\`; rerun with"
        echo "              BLUEPENCIL_SHOW_SECRET_ONCE=1 to echo it once instead"
      fi
      ;;
    file)
      echo "  credential: shared secret (from ${SECRET_FILE}) — sent as x-bluepencil-auth; set BLUEPENCIL_AUTH_SECRET to override"
      echo "  retrieve:   docker exec <container> cat ${SECRET_FILE}"
      ;;
    environment)
      echo "  credential: shared secret (from BLUEPENCIL_AUTH_SECRET) — sent as x-bluepencil-auth"
      ;;
  esac
fi
if [ -z "${BLUEPENCIL_TOKEN_KEY:-}" ] && [ -z "${BLUEPENCIL_AUTH_SECRET:-}" ]; then
  echo "  credential: none — every caller that can reach this port may read and write"
fi

exec node "${SERVER_JS}" --store "${STORE}" --port "${PORT}" --base "${BASE}" \
  --host 0.0.0.0 --name "${NAME}" "$@"
