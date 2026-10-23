# The hub (and the federator) as a container: one volume, one port, nothing to install.
#
# The runtime stage deliberately has no `node_modules`. `dist/server.js` and `dist/federator.js` are
# bundles of the whole service (the build calls them dependency-free), so "does the image start" is
# answered by node alone — which is also why this image stays small and needs no install step at
# container start.
#
# Two entry points ship, because the federator is a shipped bin (FR-16.12–16.15) and a Docker image
# without it is a trap discovered by an MCP client at connect time (plan risk R12):
#
#   * `/app/server.js`     — the hub; started by the default ENTRYPOINT, which adds --store and the
#                            network flags and generates a credential on first start.
#   * `/app/federator.js`  — the stdio federator; started per session by `docker run -i --rm …
#                            bluepencil-federator`. It has no store, no port and no /config.
#
# Both bundles come from the same build stage — no second build, no extra base layer.
#
# The build stage copies the whole checkout rather than a hand-picked file list: the build reads the
# package metadata, the extension manifest and the scripts, and a file list that silently misses one
# of them fails at the worst moment. `.dockerignore` keeps node_modules, dist and the release output
# out of it.

FROM node:22-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build

FROM node:22-alpine
WORKDIR /app

# The image ships the two bundles, the entrypoint and the two bin wrappers, nothing else.
COPY --from=build /app/dist/server.js /app/server.js
COPY --from=build /app/dist/federator.js /app/federator.js
COPY docker/entrypoint.sh /usr/local/bin/bluepencil-entrypoint
# The wrappers carry the same names as `package.json`'s bins and add nothing to "$@", so an
# overridden ENTRYPOINT (`entrypoint: ["bluepencil-hub"]`) never ends up with a doubled `--store`.
COPY docker/bin/bluepencil-hub /usr/local/bin/bluepencil-hub
COPY docker/bin/bluepencil-federator /usr/local/bin/bluepencil-federator
RUN chmod 0755 /usr/local/bin/bluepencil-entrypoint \
  /usr/local/bin/bluepencil-hub /usr/local/bin/bluepencil-federator \
  # `docker run -v name:/data` copies this ownership into the fresh volume, so the unprivileged user
  # can write its store and its generated credential. A *bind* mount keeps the host's ownership
  # instead — those need `chown 1000:1000` on the host, which docs/DOCKER.md says out loud.
  && mkdir -p /data && chown node:node /data \
  # busybox wget is enough: `{base}/config` needs no credential (FR-6.10), which is what makes it
  # usable as a health probe on an authenticated hub.
  && true
USER node

ENV BLUEPENCIL_STORE=/data/notes.bluepencil.json \
    BLUEPENCIL_PORT=8787 \
    BLUEPENCIL_BASE=/api/v1/bluepencil

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${BLUEPENCIL_PORT}${BLUEPENCIL_BASE}/config" || exit 1

# The hub stays the default: it owns the credential bootstrap, so `docker run …` and Compose keep
# working unchanged. The same script dispatches `bluepencil-federator` before it prints anything (a
# federator's stdout is protocol-only), which is what makes the federator bin usable via `docker run`
# without an `--entrypoint` override.
ENTRYPOINT ["/usr/local/bin/bluepencil-entrypoint"]
