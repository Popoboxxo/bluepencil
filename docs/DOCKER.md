# The hub in Docker (FR-6.14)

The hub binds beyond loopback inside a container — loopback would make it unreachable, which is the
one thing a container must not be. That is exactly the case that needs a credential, so the image
generates one on the first start and keeps it in the data volume: a restart must not invalidate the
clients that already saved it.

## Three lines

```sh
docker compose up -d                                  # image + named volume, from docker-compose.yml
docker compose logs hub | head -20                    # the address and the credential
# paste address + credential into the extension (or an MCP client)
```

Without compose:

```sh
docker run -d --name bluepencil-hub -p 8787:8787 -v bluepencil-notes:/data \
  ghcr.io/popoboxxo/bluepencil:latest
docker logs bluepencil-hub | head -20
```

Then, from your machine:

```sh
curl -s http://localhost:8787/api/v1/bluepencil/config | jq .
```

`{base}/config` needs no credential (FR-6.10), which is what makes it usable as a probe: it reports
the name, the version, **which** credential the hub asks for and the binding the process actually has.
That is also the image's `HEALTHCHECK`.

## What the container does on start

`docker/entrypoint.sh` is the entrypoint, and it does three things a plain `CMD node server.js` cannot:

1. **It binds `0.0.0.0`** — reachable from outside, which is the point of a container.
2. **It generates a credential when none was handed in**, stores it in `/data/.bluepencil-auth`
   (mode `0600`) and reuses it afterwards. The first start prints it in one line so it can be pasted
   into the extension; later starts only name the file, because a secret in every log line is a secret
   on every laptop that ever ran `docker logs`.
3. **It prints the address and the MCP endpoint** (`POST {base}/mcp`).

Hand a credential in and it is used instead:

```sh
BLUEPENCIL_AUTH_SECRET="$(openssl rand -hex 32)" docker compose up -d
```

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `BLUEPENCIL_NAME` | container hostname | How the hub introduces itself in `{base}/config` — a readable entry beats a container id |
| `BLUEPENCIL_PORT` | `8787` (inside) | Port the hub listens on; map it with `-p <outside>:8787` |
| `BLUEPENCIL_BASE` | `/api/v1/bluepencil` | Base path of the API |
| `BLUEPENCIL_STORE` | `/data/notes.bluepencil.json` | Where the note set lives — keep it inside `/data` |
| `BLUEPENCIL_AUTH_SECRET` | generated | Shared secret; every client sends it in `x-bluepencil-auth` |
| `BLUEPENCIL_TOKEN_KEY` | – | Signed per-device tokens instead (`Authorization: Bearer …`), individually revocable |
| `BLUEPENCIL_SECRET_FILE` | `/data/.bluepencil-auth` | Where the generated secret is kept |

Extra arguments go straight to the hub, e.g. a read-only hub with a Markdown mirror:

```yaml
command: ["--read-only", "--mirror", "/data/notes.md"]
```

## The honest limits

- **No TLS in the image.** A hub on your own network is comparable to the file it writes; anything
  beyond that belongs behind a reverse proxy (Traefik, Caddy, nginx) that terminates TLS. The
  credential is not a substitute for transport encryption on an untrusted path.
- **A bind mount ignores the image's ownership.** The image prepares `/data` for uid 1000 (`node`),
  and a *named* volume inherits that. A host bind mount does not, so it needs `chown 1000:1000` on the
  host first — otherwise the hub cannot write its store.
- **One writer per store file.** Two hubs on the same file is two truths fighting; run one container
  per store.
- **`latest` tracks the newest stable release.** Prerelease tags publish `<version>` and `hub` only.

## Which image tags exist

| Tag | Meaning |
|---|---|
| `:<version>` | Exactly the released version, e.g. `:0.5.0` |
| `:hub` | The same image under its role name |
| `:latest` | The newest stable release (never a prerelease) |

The image is built and started by CI on every change, so a broken Dockerfile fails the pull request
that caused it instead of the release. Provenance and an SBOM are attached by the release workflow
(`docker buildx imagetools inspect ghcr.io/popoboxxo/bluepencil:<version>`).
