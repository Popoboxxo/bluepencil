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
2. **It generates the shared secret when none was handed in**, stores it in
   `/data/.bluepencil-auth` (mode `0600`) and reuses it afterwards. This happens **even when
   `BLUEPENCIL_TOKEN_KEY` is set** — the hub then accepts both credentials and an operator can add
   token signing without locking out clients that already hold the secret. The first start prints a
   freshly generated secret in one line so it can be pasted into the extension; later starts only
   name the file, because a secret in every log line is a secret on every laptop that ever ran
   `docker logs`. A `0`-byte secret file counts as "not present" and is regenerated; a file that
   cannot be written (read-only mount, missing directory) aborts the start with a message naming
   `BLUEPENCIL_AUTH_SECRET`/`BLUEPENCIL_SECRET_FILE` instead of continuing with an unexported
   secret.
3. **It prints the address and the MCP endpoint** (`POST {base}/mcp`).

Hand a shared secret in and it is used instead of generating one — with or without a token key.
Keep that value stable across container re-creations, otherwise every restart invalidates every
client: write it once to an `.env` file (or a Docker secret) rather than generating it per start:

```sh
printf 'BLUEPENCIL_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env   # once, not per start
docker compose up -d
```

The entrypoint always persists a shared secret unless `BLUEPENCIL_AUTH_SECRET` is handed in.
Token acceptance is additive, not a replacement: setting `BLUEPENCIL_TOKEN_KEY` does not disable
the secret, and there is no opt-out switch for it. `BLUEPENCIL_AUTH_SECRET=""` does not disable it
either — an empty value counts as unset, so the entrypoint generates or reuses the file.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `BLUEPENCIL_NAME` | container hostname | How the hub introduces itself in `{base}/config` — a readable entry beats a container id |
| `BLUEPENCIL_PORT` | `8787` (inside) | Port the hub listens on; map it with `-p <outside>:8787` |
| `BLUEPENCIL_BASE` | `/api/v1/bluepencil` | Base path of the API |
| `BLUEPENCIL_STORE` | `/data/notes.bluepencil.json` | Where the note set lives — keep it inside `/data` |
| `BLUEPENCIL_APP` | `bluepencil hub` | Identity reported as `/config.app`; a registry peer must match it |
| `BLUEPENCIL_ENVIRONMENT` | `dev` | The one environment this hub is the store of record for |
| `BLUEPENCIL_REGISTRY` | – | Registry file; makes `/mcp` an aggregate and `/config` report `federates:true` (the hub stays the store of record) |
| `BLUEPENCIL_AUTH_SECRET` | generated | Shared secret; every client sends it in `x-bluepencil-auth`. Generated into `BLUEPENCIL_SECRET_FILE` even when `BLUEPENCIL_TOKEN_KEY` is set — a hub with both accepts **both** credentials |
| `BLUEPENCIL_TOKEN_KEY` | – | Signed per-device tokens (`Authorization: Bearer …`), individually revocable. Does not replace the shared secret; configure it *in addition* to keep both doors open |
| `BLUEPENCIL_ADMIN_SECRET` | – | Opt-in admin surface at `{base}/admin`; at least 16 characters, or the hub refuses to start |
| `BLUEPENCIL_SECRET_FILE` | `/data/.bluepencil-auth` | Where the generated secret is kept (reused on the next start). A `0`-byte file counts as not present and is regenerated; if it cannot be written the container refuses to start rather than run with an unpersisted secret |

### Credentials and their headers

| Credential | Sent in | Accepted on |
|---|---|---|
| shared secret (`BLUEPENCIL_AUTH_SECRET`) | `x-bluepencil-auth: <secret>` | the notes routes (`/notes`, `/notes/{id}`, `/notes/bulk-delete`, `/notes/{id}/messages`) |
| signed token (`BLUEPENCIL_TOKEN_KEY`) | `Authorization: Bearer <token>` | the notes routes, same set |
| admin secret (`BLUEPENCIL_ADMIN_SECRET`) | `x-bluepencil-admin: <secret>` | the admin surface, plus the notes routes as a second credential — never `/mcp` |

A hub accepts as many of these as are configured; `{base}/config` names the strongest one, and
`{base}/admin/status` lists all of them (`auth: "token+secret"`, `credentials: ["token","secret"]`).
The admin secret is an operator credential, not a client one: alone it does not turn the client gate
on. No route echoes a *configured* credential value; `POST {base}/admin/devices` deliberately
returns the freshly minted token once, because the hub keeps only its id.

Extra arguments go straight to the hub, e.g. a read-only hub with a Markdown mirror:

```yaml
command: ["--read-only", "--mirror", "/data/notes.md"]
```

## The admin surface (optional)

`--admin-secret` (or `BLUEPENCIL_ADMIN_SECRET`, at least 16 characters) adds an operator page and
the routes behind it. Without it the surface does not exist: `{base}/admin` falls through to the
ordinary 404, so the container looks exactly like a hub that never had the feature.

```sh
# once: mint the operator credentials into a file, not into the run command
printf 'BLUEPENCIL_ADMIN_SECRET=%s\nBLUEPENCIL_TOKEN_KEY=%s\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > bluepencil.env
chmod 0600 bluepencil.env

docker run -d --name bluepencil-hub -p 127.0.0.1:8787:8787 -v bluepencil-notes:/data \
  --env-file bluepencil.env \
  ghcr.io/popoboxxo/bluepencil:0.11.1
```

The shared secret is deliberately absent here: the entrypoint generates it into the volume and
reuses it on every start, which is already the stable form. Inlining
`-e BLUEPENCIL_AUTH_SECRET="$(openssl rand -hex 32)"` into `docker run` instead would mint a new
secret on every container re-creation, so every client that saved the old one loses access. If you
must supply it yourself, append a stable `BLUEPENCIL_AUTH_SECRET=…` to `bluepencil.env` (or mount a
Docker secret) — never generate it inline.

At `{base}/admin` (`/admin/` is the same page) the operator:

- **mints per-device tokens** — this needs `--token-key`; without a signing key the page says so
  and offers the shared secret instead;
- **revokes by `jti`** — live at once and durable when `--revoked-tokens` names a file;
- **reads status and activity** — version, environment, credential mode, note/device counts, and
  whether token issuing and durable revocation are available.

Issued ids are recorded in `devices.json` next to the store (for example `/data/devices.json` next
to `/data/notes.bluepencil.json`). The token itself is shown once and never stored; the hub keeps
the id. A token minted with `bluepencil token` is not listed there, but it can still be revoked by
its jti.

The admin credential is its own header (`x-bluepencil-admin`) and is **not** a client credential:
it is admitted as a second credential on the notes routes only, never on `/mcp`. It also does not
turn authentication on — a hub without `--auth-secret`/`--token-key` still has no client gate.

Security caveats:

- **Keep the surface on loopback or behind a dedicated origin.** It mints and revokes the
  credentials other clients use; publishing it is publishing the key ring.
- **Terminate TLS in front of it.** The image has no TLS of its own, and the admin secret crosses
  the wire on every request.
- **The journal is public.** `GET {base}/journal` is answered without a credential (like
  `{base}/config`); do not expose a hub on an untrusted network and expect the audit trail to stay
  private.
- **The admin throttle keys on the socket peer address.** Behind a reverse proxy all operators
  share one budget (10 failures per 5 minutes), because every request arrives from the proxy's
  address. Bind the admin surface to a dedicated origin/loopback, or set a separate trust boundary
  accordingly.

## Hub of Hubs

An aggregating hub reads several leaf hubs over one `/mcp` door; the leaves stay independent stores
of record. The runnable example is
[`examples/federation/docker-compose.yml`](../examples/federation/docker-compose.yml):

| Service | Role | Port |
|---|---|---|
| `hub-dev` | leaf hub, store of record for `dev` | `8787:8787` |
| `hub-staging` | leaf hub, store of record for `staging` | `8788:8787` |
| `hub-aggregator` | hub with `--registry --no-self`; only `/mcp` aggregates | `127.0.0.1:8790:8787` |

The browser talks to `hub-dev` and `hub-staging` directly, exactly as to a single hub. The
aggregator is for an agent: `/notes` on it stays local and, with `--no-self`, empty; only `/mcp`
fans out. It has no notes volume, because it is not a store of record. Do not expose it on a public
interface — this shape gives it no credential.

**The registry mount.** The aggregator mounts the registry read-only and passes it with `--registry`:

```yaml
volumes:
  - "./instances.json:/etc/bluepencil/instances.json:ro"
command: ["--store", "/tmp/aggregator.json",
          "--host", "0.0.0.0", "--port", "8787", "--base", "/api/v1/bluepencil",
          "--name", "hub-aggregator", "--app", "my-web-tool",
          "--registry", "/etc/bluepencil/instances.json",
          "--no-self", "--read-only", "--allow-insecure"]
environment:
  BP_DEV_TOKEN: "${BP_DEV_TOKEN:?BP_DEV_TOKEN is required (see .env.example)}"
  BP_STAGING_TOKEN: "${BP_STAGING_TOKEN:?BP_STAGING_TOKEN is required (see .env.example)}"
```

Every `base` in that file must include the API path, e.g.
`http://hub-dev:8787/api/v1/bluepencil`; a bare origin is not the API base and the start fails.
The file is a security boundary and is checked **before** it is read:

```sh
chmod 0600 instances.json
```

Any group/world bit is `invalid_registry` (exit 4). The file must also be owned by the
container's process user: the image runs as uid 1000 (`node`), so either `chown 1000:1000` the
file or set `user:` / `BLUEPENCIL_UID`/`BLUEPENCIL_GID` to the host uid/gid that owns it. A file
owned by another user with the default `user: 1000` is refused the same way.

**Health and ordering.** Each leaf has a `HEALTHCHECK` against `{base}/config`, which needs no
credential; the aggregator uses `depends_on: service_healthy`, so it does not try to verify peers
before they answer. A peer that is merely unreachable at start does not take the aggregator down
(it starts degraded and reports `partial`); a registry, identity or nesting error is a start
refusal (exit 4) and `restart: on-failure:5` stops the loop after a few attempts.

**The four image variables.** In this shape the entrypoint still derives the hub; `BLUEPENCIL_STORE`
selects the leaf's file in its volume, `BLUEPENCIL_NAME` makes its `/config` entry readable,
`BLUEPENCIL_APP` is the identity a registry peer must match, and `BLUEPENCIL_ENVIRONMENT` is the one
environment that leaf is the store of record for. The aggregator overrides the default entrypoint
with the `bluepencil-hub` wrapper and supplies its own `--store`/`--host`/`--port`/`--base`; it needs
no credential *file*, because the registry resolves its `auth: { "env": … }` references from the
`BP_DEV_TOKEN`/`BP_STAGING_TOKEN` environment entries shown above.

**The federator is stdio-only.** It is never a Compose service: Compose cannot keep it alive without
an attached MCP client, and without stdin it exits at EOF. Start it per session with `-i` on the
same network:

```sh
docker run -i --rm --network bluepencil-federation \
  --user "$(id -u):$(id -g)" \
  --env-file .env \
  --no-healthcheck \
  -v ./instances.json:/etc/bluepencil/instances.json:ro \
  ghcr.io/popoboxxo/bluepencil:0.10.3 bluepencil-federator \
  --registry /etc/bluepencil/instances.json --read-only --allow-insecure
```

`--allow-insecure` is needed because the peers are plain `http` on a private Docker network; it
admits RFC1918/ULA/CGNAT addresses but never link-local or cloud-metadata targets. `--env-file .env`
supplies the registry credentials (`BP_DEV_TOKEN` and `BP_STAGING_TOKEN` — both instance entries
reference them), `--user` keeps the `0600` owner check satisfied when the host uid differs from the
image's `node` user, and `--no-healthcheck` disables the image's hub-only `/config` probe: a
federator has no HTTP endpoint and would otherwise report `unhealthy` forever.

**Both bins are in the image.** It ships `dist/server.js` and `dist/federator.js` behind the
`bluepencil-hub` and `bluepencil-federator` wrappers. The default entrypoint stays the hub: a first
positional argument that names one of those two wrappers dispatches to it (so
`docker run … bluepencil-federator …` works), and any other argument is passed to the hub as before.

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
that caused it instead of the release. The `image` job starts each wrapper bin and checks its **own**
banner (`bluepencil-hub --version`, `bluepencil-federator --version`), so an image that ships only
the hub is caught before release. Provenance and an SBOM are attached by the release workflow
(`docker buildx imagetools inspect ghcr.io/popoboxxo/bluepencil:<version>`).
