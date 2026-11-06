# Hub viewer — a website with the layer, without an extension

> The viewer is an **operator surface**: off unless configured, reachable only with the admin
> secret, and limited to the hosts named in `--viewer-allow`. It exists because reviewing a page
> needs the layer *on* that page, and the alternative — a browser extension — is an install.

## Why it works

The hub fetches the target and serves it **under its own origin**. The page and the notes API then
share an origin, so the layer's store calls need no CORS, no preflight and no credential in the page.
Until this door existed, that origin difference was exactly what the extension had to work around
(issues #98/#99/#102).

## Flags

| Flag | Meaning |
|---|---|
| `--viewer` | turn the door on (also `BLUEPENCIL_VIEWER=1`) |
| `--viewer-assets <dir>` | directory with the built layer bundles (`dist/`), usually `dist` |
| `--viewer-allow <host[,host]>` | hosts the hub may fetch: `app.internal`, `*.example.com`. Ports optional |
| `--viewer-ttl <seconds>` | session lifetime, default 8 h, max 7 days |
| `--viewer-public-url <url>` | public origin when it differs from the request's `Host` (reverse proxy, TLS) |

`--viewer` without `--viewer-assets`, without an allowlist or without `--admin-secret` is a startup
error. An open URL parameter on a server-side fetch is an SSRF door, so there is no "just turn it on"
spelling.

## Routes

| Route | Answer |
|---|---|
| `GET {base}/viewer?k=<admin-secret>` | exchanges the secret for a session, sets an `HttpOnly` cookie, 302 to the page |
| `GET {base}/viewer` | the page: URL bar, iframe, allowlist, bookmarklet |
| `GET {base}/view?url=<target>` | the target, fetched and injected (allowlisted, http(s) only, ≤ 5 MB, 8 s, ≤ 3 redirects — each hop re-checked) |
| `GET {base}/viewer/bookmarklet.txt` | the bookmarklet artifact, version-stamped |
| `GET {base}/viewer/assets/<bundle>` | `bluepencil.element.min.js` / `.js`, cross-origin readable, nothing else |

## What the injection does — and why each part is load-bearing

1. **Removes `<meta http-equiv="content-security-policy">`.** A page policy would block the loader
   (`script-src`) and the writes (`connect-src`). Measured need, not a precaution.
2. **Inserts `<base href="<target-origin>/">`** so relative assets keep resolving against the target
   instead of the hub.
3. **Injects `<bluepencil-notes>` with an absolute `endpoint`** and a **module** script tag. With a
   `<base>` in the document a relative endpoint resolves against the target and every write fails
   with `Failed to fetch`.

## The bookmarklet (why it is its own artifact)

Logins, single-page apps and other origins do not survive a proxy. For those, the viewer hands out a
`javascript:` bookmarklet: one click on the real page mounts the layer, which writes into this hub
with the session token. It is generated from **one** source (`server/viewer-bookmarklet.ts`) and
served as a file, so a release cannot ship a page that disagrees with the artifact a user installed.

Limits, documented rather than hidden: a page whose CSP forbids external scripts blocks the loader; a
cross-origin page needs this origin in `connect-src`; the token is readable by the page being
annotated while the session lives (it is note-scoped and dies with the session).

## Security model

- **Own session, not the shared secret.** The admin secret is exchanged once for a short-lived
  session; the secret never appears in a served page.
- **Allowlist, not a URL parameter.** Checked on the request *and* on every redirect hop; `http(s)`
  only, no credentials in the URL.
- **The proxied page is trusted with the store.** It runs on the hub origin, so its JavaScript can do
  what the layer can. Run the viewer on a separate origin/instance if the targets are not your own.
- **Admin gate.** Without `--admin-secret` the routes do not exist (404, not 401 — a surface that is
  off must not advertise itself).
