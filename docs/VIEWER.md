# Hub viewer — a website with the layer, without an extension

> The viewer is an **operator surface**: off unless configured, its content routes reachable only
> with a viewer session issued by the admin secret, and limited to the hosts named in
> `--viewer-allow`. It runs on a **second listener with its own origin**, separate from the hub. It
> exists because reviewing a page needs the layer *on* that page, and the alternative — a browser
> extension — is an install.

## Why a second origin

The viewer is a dedicated `node:http` listener. The hub fetches the target and serves it **under the
viewer's origin**, not the hub's. Both listeners share one process, one store, one journal and the
same session/ticket maps, but they expose different surfaces: the hub port carries the notes API,
the admin page, `/mcp`, `/journal`, `/config` and the `--root` static tree; the viewer port carries
the viewer routes (shell, proxy, assets, bookmarklet) plus the shared `/notes*`, `/sessions`,
`/bundle` API and the public `/health` probe, and nothing of the hub-only surface.

Two things follow from that split:

- **The page and the notes API share the viewer origin.** The layer's store calls need no CORS, no
  preflight and no credential in the page. Until this door existed, that origin difference was
  exactly what the extension had to work around (issues #98/#99/#102).
- **Proxied content cannot reach the hub surface same-origin.** A document served by the viewer
  cannot call `/admin*`, `/mcp`, `/journal`, `/config` or a `--root` file on the hub port, and a
  `bp_viewer` cookie authorizes nothing there. That origin boundary is the security property — it
  is **not** a sandbox (see [Security model](#security-model)).

## Flags

`--viewer` requires all four of `--viewer-port`, `--viewer-assets`, `--viewer-allow` and
`--admin-secret`. Every `--viewer-*` flag without an active `--viewer` is a usage error
(`viewer_flags_without_viewer`), and a valued flag without a value is diagnosed, never read as
"absent".

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--viewer[=true\|false]` | `BLUEPENCIL_VIEWER` | off | enables the viewer surface; strictly boolean (`--viewer=false` is off) |
| `--viewer-port <port>` | `BLUEPENCIL_VIEWER_PORT` | — (required) | bind port of the second listener, `0..65535`; `0` picks an ephemeral port. Must differ from `--port` on the same bind address when both are non-zero |
| `--viewer-host <host>` | `BLUEPENCIL_VIEWER_HOST` | hub bind (`--host`, default `127.0.0.1`) | bind address of the second listener. A wildcard (`""`, `0.0.0.0`, `::`, `[::]`) requires an explicit `--viewer-origin` |
| `--viewer-origin <url>` | `BLUEPENCIL_VIEWER_ORIGIN` | derived from bind + port, **never** from a wildcard address | public origin of the viewer, e.g. `https://view.example.com`. Bare `http(s)` origin, no path/query/fragment; must differ from the hub origin |
| `--viewer-public-url <url>` | `BLUEPENCIL_VIEWER_PUBLIC_URL` | — | **deprecated alias** for `--viewer-origin` (one release period); same origin rules, warns `viewer_public_url_deprecated` |
| `--viewer-assets <dir>` | `BLUEPENCIL_VIEWER_ASSETS` | — (required) | directory with the built layer bundles (`dist/`); must contain `bluepencil.element.min.js` |
| `--viewer-allow <host[,host]>` | `BLUEPENCIL_VIEWER_ALLOW` | — (required) | hosts the hub may fetch: exact `app.internal` or wildcard `*.example.com`. Ports optional |
| `--viewer-ttl <seconds>` | — | `28800` (8 h) | viewer session lifetime, `60..604800` (also enforced programmatically) |

A minimal production start:

```sh
node dist/server.js --store notes.json --port 8787 \
  --viewer --viewer-port 8788 --viewer-origin https://view.example.com \
  --viewer-assets dist --viewer-allow app.internal,*.example.com \
  --admin-secret "$BLUEPENCIL_ADMIN_SECRET"
```

## Migrating from 0.13.0

The viewer no longer shares the hub port. There is no compatibility mode: `--viewer` without
`--viewer-port` fails the start visibly (`viewer_port_required`), because the shared-port topology
is exactly what this release replaces.

The move is one line: add a free port.

```sh
# 0.13.0
--viewer --viewer-assets dist --viewer-allow app.internal --admin-secret "$SECRET"

# 0.14.0
--viewer --viewer-port 8788 --viewer-assets dist --viewer-allow app.internal \
  --admin-secret "$SECRET"
```

For TLS or a reverse proxy, also pass `--viewer-origin https://view.example.com`. A container that
inherits the entrypoint's `--host 0.0.0.0` inherits a wildcard bind and **must** pass
`--viewer-origin` (or a loopback `--viewer-host`), otherwise the start fails with
`viewer_origin_required`. See `docs/DOCKER.md` for the two-port container pattern.

Other breaking changes:

- **`--viewer-public-url` changed meaning.** In 0.13.0 it named the public origin of the hub-port
  viewer; now it is an alias for the origin of the **second listener**. An existing value that
  points at the hub origin is rejected (`viewer_origin_is_hub_origin`) so the launcher cannot
  redirect onto a 404 origin. It warns for one release period and is then removed.
- **`--cors '*'` is rejected together with `--viewer`** (`cors_wildcard_with_viewer`), and a
  `--cors` value equal to the viewer origin is rejected (`cors_viewer_origin`). A wildcard would
  let any page on the viewer origin read the hub journal, `/config` or `/health`. Use one concrete
  origin that is not the viewer, or no CORS.
- **Old links `{base}/viewer?k=<secret>` on the hub answer `404`.** The successor is the hub
  launcher `{base}/viewer/start?k=<secret>`.
- **Old bookmarklets stop writing.** A bookmarklet that points at the hub origin no longer gets a
  viewer session there; copy a new one from the viewer shell (see
  [The bookmarklet](#the-bookmarklet-and-re-issuance)).
- **A missing `x-bluepencil-admin` no longer spends the `admin` budget.** Only a *wrong* value is
  counted, so probing `/admin/*` or the launcher without the header can no longer lock the operator
  out. The `401` text is unchanged.

## Routes

All paths are relative to `base` (default `/api/v1/bluepencil`). The `--root` static tree lives
outside `base`.

| Route | Hub surface | Viewer surface | Auth on the viewer surface |
|---|---|---|---|
| `GET /viewer/start?k=…` or `x-bluepencil-admin` | **302** to the viewer origin with a ticket | **404** | admin throttle, operator secret (hub only) |
| `GET /viewer?ticket=…` | **404** | **302** + `Set-Cookie`, then `/viewer` | one-time ticket (60 s, single use) |
| `GET /viewer` | **404** (also with `--root`) | **200** shell | viewer session |
| `GET /view?url=…` | **404** (also with `--root`) | **200** proxied HTML | viewer session |
| `GET /viewer/assets/<bundle>` | **404** (also with `--root`) | **200** JS | public, **before** the session check |
| `GET /viewer/bookmarklet.txt` | **404** (also with `--root`) | **200** text | viewer session |
| `GET /notes`, `POST /notes`, `GET/PATCH /notes/{id}`, `POST /notes/{id}/messages`, `POST /notes/bulk-delete` | yes | yes | viewer session **or** client credential |
| `GET /sessions` | yes | yes | viewer session **or** client credential |
| `GET /bundle` | yes | yes | viewer session **or** client credential |
| `GET/HEAD /health` | public, before `authorize()` | public, before `authorize()` | none (three fields, no notes) |
| `GET /config` | public | **404** | — |
| `GET /journal` | yes | **404** | — |
| `POST /mcp` | yes | **404** | — |
| `GET /admin`, `/admin/*` | yes (admin gate) | **404** | — |
| `--root` static (other paths) | yes | **404** | — |
| `OPTIONS /notes*` | per `--cors` | **204** for a valid bookmarklet preflight, else **405** with `Allow`; never `401` | — |
| `OPTIONS /bundle`, `/sessions` | per `--cors` | **405** with `Allow: GET`; no preflight, never `401` | — |

On the hub surface, `/viewer`, `/view` and `/viewer/assets/*` are refused **before** the static
fallback — under `base` and unprefixed — even with `--root`, so an operator `index.html` cannot
shadow viewer content.

## The launcher and one-time tickets

The operator enters on the **hub** origin, never on the viewer origin:

```sh
# header (preferred: the secret stays out of the URL bar and proxy logs)
curl -i -H "x-bluepencil-admin: $BLUEPENCIL_ADMIN_SECRET" \
  http://hub.example.com:8787/api/v1/bluepencil/viewer/start

# or the same value as a query parameter
curl -i "http://hub.example.com:8787/api/v1/bluepencil/viewer/start?k=$BLUEPENCIL_ADMIN_SECRET"
```

1. The hub verifies the operator secret (constant-time comparison, shared `admin` throttle) and
   mints a 24-byte / 192-bit ticket, valid for 60 seconds and single use.
2. It answers `302` with `Location: <viewer-origin><base>/viewer?ticket=<ticket>`,
   `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. No `Set-Cookie` — the secret never
   reaches the viewer origin.
3. The browser follows to the **viewer** origin. The viewer redeems the ticket atomically:
   - valid → mint a session, `Set-Cookie`, and `302` to `<base>/viewer` (a clean URL without query);
   - invalid, expired or already used → `401`, **no** cookie.
4. `GET <base>/viewer` with the cookie serves the shell.

Details that matter in operation:

- The launcher exists **only** on the hub. The viewer answers `404` for `/viewer/start`.
- `?k=` on any viewer route is **not** compared: there is no secret oracle and no throttle
  consumption. It is answered `401` with a pointer to the hub launcher.
- The header wins when both `x-bluepencil-admin` and `?k=` are present.
- The launcher is `GET`-only; any other method is `405` with `Allow: GET`, before the secret is
  consulted.
- A **missing** `x-bluepencil-admin` (or missing `?k=`) is `401` and spends **no** `admin` budget.
  Only a wrong value counts. Ten wrong values from one peer within five minutes give `429`
  `too_many_attempts` with `Retry-After: 300`; `/admin/*` and the launcher share that budget.

## What the injection does — and why each part is load-bearing

1. **Removes `<meta http-equiv="content-security-policy">`.** A page policy would block the loader
   (`script-src`) and the writes (`connect-src`). The proxied response also carries no CSP header.
   Measured need, not a precaution.
2. **Inserts `<base href="<target-origin>/">`** so relative assets keep resolving against the target
   instead of the viewer.
3. **Injects `<bluepencil-notes>` with an absolute `endpoint`** (`<viewer-origin><base>`) and a
   **module** script tag with an absolute `src`. With a `<base>` in the document a relative endpoint
   resolves against the target and every write fails with `Failed to fetch`.

The proxy refuses only `http(s)` targets, no userinfo, allowlisted hosts, at most 5 MB, an 8 s
timeout and at most 3 redirects — each hop re-checked. A target whose host is a cloud metadata name
is refused before the allowlist, even if it is allowlisted. A private address needs an **exact**
`--viewer-allow` entry (never a `*.` wildcard); loopback, link-local, metadata and reserved addresses
stay forbidden.

## The bookmarklet and re-issuance

Logins, single-page apps and other origins do not survive a proxy. For those, the viewer hands out a
`javascript:` bookmarklet: one click on the real page mounts the layer, which writes into this hub
with a viewer session token. It is generated from **one** source (`server/viewer-bookmarklet.ts`)
and served as a file (`{base}/viewer/bookmarklet.txt`, session-protected), so a release cannot ship a
page that disagrees with the artifact a user installed.

- The shell offers a ready-to-drag link. The session token is substituted when the shell request
  carried the `x-bluepencil-viewer` header (the bookmarklet path); a cookie-only request gets the
  placeholder instead.
- The downloaded artifact (`{base}/viewer/bookmarklet.txt`) always contains only the placeholder
  `__BP_VIEWER_TOKEN__`, never a live token.
- **Re-issuance after the upgrade:** bookmarklets that point at the hub origin no longer write,
  because the hub does not accept a viewer session. Open the viewer shell and copy the bookmarklet
  again. This is a deliberate break; the token is minted per session and dies with it.

Limits, documented rather than hidden: a page whose CSP forbids external scripts blocks the loader;
a cross-origin page needs the viewer origin in `connect-src`; the token is readable by the page being
annotated while the session lives.

## Cookie and TLS

The session travels as an `HttpOnly` cookie on the viewer origin.

| Attribute | Value |
|---|---|
| Name | `bp_viewer` |
| `HttpOnly` | always |
| `SameSite` | `Lax` |
| `Path` | normalised `base` (`/` for an empty base) |
| `Max-Age` | `--viewer-ttl` (default 28800) |
| `Secure` | exactly when the resolved public viewer origin is `https:` |
| `Domain` | never set (host-only) |

- **There is no port isolation.** With the viewer on the same hostname as the hub (only a different
  port), the browser also sends `bp_viewer` to the hub port; the hub ignores it, but the cookie is
  not isolated. Use a **dedicated hostname** for the viewer. The warning
  `viewer_cookie_shared_host` names the case and is not suppressed by `--quiet`.
- **`Secure` follows the public origin, not the bind address.** `--viewer-origin https://…` yields
  `Secure`; a derived `http://…` origin does not. `X-Forwarded-Proto: https` is honoured only from a
  loopback peer (the reverse proxy on the same machine) or when `--viewer-origin` is set explicitly,
  so a remote client cannot fake the decision.
- **The hub stays plain HTTP.** TLS terminates externally; the viewer origin is the public HTTPS
  name. A non-loopback viewer bind with an `http:` origin warns `viewer_non_loopback_insecure`.
- **Host gate:** the viewer checks its **own** bind, and accepts the hostname from `--viewer-origin`
  in addition to the loopback spellings. A loopback bind behind a reverse proxy therefore accepts
  `Host: view.example.com`.

## Reverse proxy (nginx)

Terminate TLS at the proxy and forward each listener under its own name. Never expose the viewer
under the hub's hostname.

```nginx
# Hub: notes API, admin surface, /mcp, /journal, /config
server {
    listen 443 ssl;
    server_name hub.example.com;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# Viewer: shell, proxy, assets, bookmarklet — its own name
server {
    listen 443 ssl;
    server_name view.example.com;

    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Start the hub with `--viewer-origin https://view.example.com` so the launcher redirect, the injected
endpoint, the asset URL and the `Secure` cookie all use the public name. The `proxy_pass` port is the
`--viewer-port` of the second listener. The admin surface at `{base}/admin` lives on the hub name
only; the viewer name answers `404` for it.

## Security model

### What the origin boundary buys

- **No viewer content on the hub port.** A proxied document cannot reach `/admin*`, `/mcp`,
  `/journal`, `/config` or the `--root` tree same-origin, even with `--root`.
- **Surface-scoped sessions.** A `bp_viewer` cookie authorizes nothing on the hub port; a viewer
  session does not open hub routes, and the hub ignores the bookmarklet header.
- **The operator secret stays on the hub origin.** It is compared only there; the viewer context
  does not carry it structurally. A proxied page cannot read it from a form on its own origin.
- **XSS in a target runs on the viewer origin**, not on the hub origin.
- **Shared revocation.** A revoked device token is refused on the viewer surface too
  (`token_revoked`); both contexts read the same live revocation set.

### What it does not buy — residual risks

- **No sandbox.** Proxied JavaScript still runs with the viewer origin and can use the viewer
  session same-origin. The allowlist and the short session TTL bound the damage.
- **No cookie isolation on one hostname.** Different port is not different cookie scope; use a
  dedicated viewer hostname.
- **No process or store separation.** Both listeners share one process, one file store and one
  journal. Last-writer-wins without a file lock remains: an external writer between load and persist
  can lose a change.
- **DNS rebinding / TOCTOU.** `--viewer-allow` checking is a pre-check, not connection pinning.
- **Ticket theft before redemption.** A ticket is a bearer value with 60 s TTL, single use and no
  peer binding; whoever grabs it first gets a session.
- **Secret in the hub URL (`?k=`).** It can land in history and proxy logs. Prefer the
  `x-bluepencil-admin` header; `no-referrer` and `no-store` are set on the redirect.
- **Reverse-proxy hub origin.** The shared-host warning compares against the **bind** origin; a
  public hub name that exists only in DNS/proxy is not known to the CLI, so the case can go
  unnoticed. This is why a dedicated viewer hostname is the recommendation.
- **`--viewer-public-url` migration.** An existing value that pointed at a public hub origin behind a
  proxy cannot always be detected; the bind-based and `--cors`-named hub origins are rejected.
- **The 401 hint is best-effort.** The launcher URL in the refusal message is only filled when the
  hub origin is publicly reachable; when there is none — unset, or only the internal bind origin
  behind a loopback reverse proxy — it falls back to the URL-less "open the hub launcher" wording
  rather than naming an internal address.
- **Origin derived from a fixed bind.** `--viewer-host localhost` may bind `::1` while the origin
  stays `http://localhost:<port>`. For TLS and reverse-proxy setups, set `--viewer-origin`
  explicitly.

## Start-up checks

Usage errors (fail the start):

| Code | Condition |
|---|---|
| `viewer_port_required` | `--viewer` without `--viewer-port` |
| `viewer_port_conflict` | `--viewer-port` equals `--port` on the same bind address, both non-zero |
| `viewer_origin_invalid` | origin is not a bare `http(s)` origin (path, query, fragment or bad scheme) |
| `viewer_origin_is_hub_origin` | origin (or the deprecated alias) normalises to the hub origin |
| `viewer_origin_required` | resolved viewer bind is wildcard (explicit or inherited from `--host`) and no origin is set |
| `viewer_origin_conflict` | `--viewer-origin` and `--viewer-public-url` disagree |
| `viewer_ttl_invalid` | `--viewer-ttl` outside `60..604800` or not an integer |
| `viewer_flags_without_viewer` | any `--viewer-*` flag without an active `--viewer` |
| `cors_viewer_origin` | `--cors` names the viewer origin |
| `cors_wildcard_with_viewer` | `--cors '*'` combined with `--viewer` |

Warnings on stderr (not suppressed by `--quiet`): `viewer_cookie_shared_host`,
`viewer_non_loopback_insecure`, `viewer_public_url_deprecated`.

Until both origins are resolved (notably with `--viewer-port 0`), both listeners answer
`503 service_not_ready` with `Retry-After: 1`; the launcher only redirects once the viewer origin
is known.

Without `--viewer` the viewer routes do not exist at all (the hub answers `404`); the viewer
listener is not created. `RunningServer.viewer` is set only when the viewer is configured, and
`close()` shuts both listeners down.
