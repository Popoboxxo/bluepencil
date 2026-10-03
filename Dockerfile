# The hub as a container: one volume, one port, nothing to install.
#
# The runtime stage deliberately has no `node_modules`. `dist/server.js` is a bundle of the whole
# service (the build calls it dependency-free), so "does the image start" is answered by node alone —
# which is also why this image stays small and needs no install step at container start.
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

# The image ships the bundle and the entrypoint, nothing else.
COPY --from=build /app/dist/server.js /app/server.js
COPY docker/entrypoint.sh /usr/local/bin/bluepencil-entrypoint
RUN chmod 0755 /usr/local/bin/bluepencil-entrypoint \
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

ENTRYPOINT ["/usr/local/bin/bluepencil-entrypoint"]
