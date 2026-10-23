# Federation

> Federation is an **agent-side** layer over hubs. A browser client still writes to exactly one
> hub; an agent can read and write several hubs through one MCP session. This document is the
> canonical reference for the registry, the two write locks, the aggregate contract and the
> deployment shapes. The tool-level MCP contract lives in [MCP.md](MCP.md); requirements are
> `FR-6.15`, `FR-16.10`–`FR-16.15` and `NFR-22` in [REQUIREMENTS.md](REQUIREMENTS.md).
>
> The illustration at [`images/federation-overview.svg`](images/federation-overview.svg) shows the
> three operating modes. The ASCII diagrams in this document are canonical; the SVG only illustrates
> them.

`<base>` below always means the hub's API base, `/api/v1/bluepencil` by default.

## 1. Roles

| Role | Process | Store | HTTP surface | May be a registry member? |
|---|---|---|---|---|
| **Leaf hub** | `bluepencil-hub` | Yes, one environment | `/notes`, `/config`, `/health`, `/mcp` | Yes, when it reports `federates:false` |
| **Aggregating hub** | `bluepencil-hub --registry` | Yes, still local | `/notes` stays local; `/mcp` aggregates | No — it reports `federates:true` |
| **Federator** | `bluepencil-federator` | No | None; stdio MCP only | Not applicable |
| **MCP client / agent** | Any MCP client | No | Attaches to one hub `/mcp` or to the federator's stdio | No |
| **Browser client** | Element, loader, bookmarklet, extension | No | `/notes` on one hub | Never |

**Leaf hub.** A hub is the store of record for **one** environment. Its `/notes` door reads and
writes that store and nothing else. Without `--registry`, `/mcp` is the same single-store door with
the nine normal tools. `/config` always reports `app` and `federates`; `federates` is `false`.

**Aggregating hub.** `--registry <file>` turns `/mcp` into the aggregate, and only `/mcp`. The
browser-facing `/notes`, `/sessions`, `/bundle` and `/health` routes keep operating on the hub's own
store (FR-16.3). A combined hub can include that store in the aggregate as `self` (see §7). Its
`/config` reports `federates:true` — even when a peer started degraded, because the flag describes
the process configuration, not peer health.

**Federator.** `bluepencil-federator` is a separate stdio process. It has no store, no HTTP
endpoint, no `/config` and no `/notes`; it reads the registry once, verifies every peer before the
first protocol frame, and serves the ten-tool aggregate over stdio. Because it has no local store,
`self` cannot exist there. It is the local process an agent starts; it is not a service.

**MCP client / agent.** The agent speaks MCP to one of two doors: `POST <base>/mcp` on an
aggregating hub, or stdin/stdout on a federator. It never receives a registry and never talks to a
peer directly.

**Browser client.** The element, the `attach.js` loader, the bookmarklet and the MV3 extension all
write to exactly one hub. There is no `instance` attribute, no registry attribute and no multi-hub
profile in v1: `instance` is absent from the embed vocabulary (`src/embed/attributes.ts`), and
`federates:true` does not change where the browser writes. The extension keeps one global hub
profile. Use the federator when one agent must see several environments.

Flag availability follows from the roles:

| Flag | Leaf hub | Aggregating hub | Federator | `instances` |
|---|---|---|---|---|
| `--registry` | turns it into an aggregating hub | required | required (or `BLUEPENCIL_REGISTRY`) | required |
| `--include-self` / `--no-self` | accepted, only meaningful with `--registry` | yes | `--no-self` is a no-op; `--include-self` is a usage error | no |
| `--allow-write` | accepted; no effect without `--registry` | yes (second lock) | yes (second lock) | no |
| `--read-only` | yes (refuses all writes) | yes (wins over `--allow-write`) | yes (wins over `--allow-write`) | no |
| `--allow-insecure` | yes | yes | yes | yes |
| `--timeout`, `--concurrency`, `--limit` | accepted; used by the aggregate only | yes | yes | `--timeout` is used by `health` |

## 2. Topology

There is exactly **one federation level**. A registry lists hubs; a hub that itself aggregates is
not a valid peer.

```
   browser ──/notes──▶ leaf hub (dev) ─────┐
   browser ──/notes──▶ leaf hub (staging) ─┤
                                           ├──▶ aggregating hub ──/mcp──▶ agent
   instances.json ──read once──────────────┤
                                           └──▶ federator ──stdio──▶ agent
```

* The registry is a flat list. It has no `registry` field and no way to point at another
  registry; an unknown field is rejected with `unknown_field`.
* A peer that reports `federates:true` is rejected with `nested_federation` before the session
  starts. The same applies to a peer that is another federating hub. There is no recursive fan-out.
* The instance id `self` is reserved. `all` and `*` are read selectors, not concrete instances.
  A registry that uses any of them is rejected with `reserved_id`; the federator maps that finding to
  `self_reference` and exits 4 (the hub's loader collapses it to `invalid_registry`; both refuse the
  start — see §11).
* A registry entry whose base addresses the current hub is rejected with `self_reference`. For a
  fixed port that check runs before any peer request; for `--port 0` it runs immediately after the
  bind and closes the socket. `127.0.0.1`, `localhost` and `::1` on the same port and path are
  treated as the same instance. A wildcard bind (`0.0.0.0`, `::`) cannot always prove which
  interface address a registry used; that remains a documented limitation, not a guess.
* The registry is read once at start-up. There is no hot reload and no SIGHUP reload; run
  `bluepencil instances health` to re-read the file and probe the peers.

## 3. Registry schema

The registry is a single JSON file. It is a security boundary, not a convenience list: credentials
are references, validation never loads a document partially, and the file's permissions are checked
before its content is read.

```json
{
  "schemaVersion": 1,
  "defaults": {
    "includeSelf": true,
    "mode": "read",
    "timeoutMs": 3000,
    "concurrency": 8,
    "limit": 200,
    "allowedHosts": ["127.0.0.1", "staging.example.com", "*.internal.example.com"]
  },
  "instances": [
    {
      "id": "dev-web",
      "base": "http://127.0.0.1:8787/api/v1/bluepencil",
      "app": "my-web-tool",
      "mode": "write",
      "auth": { "env": "BP_DEV_TOKEN" },
      "tokenHeader": "Authorization",
      "tokenScheme": "Bearer"
    },
    {
      "id": "staging-web",
      "base": "https://staging.example.com/api/v1/bluepencil",
      "app": "my-web-tool",
      "mode": "read",
      "auth": { "env": "BP_STAGING_TOKEN" }
    }
  ]
}
```

Top level: `schemaVersion` (required, must be `1`), `defaults` (optional), `instances` (required,
non-empty array). Any other key is `unknown_field`; a key that reads like a credential (`token`,
`secret`, `password`, `headers`, `bearer`, `credentials`, …) is reported more precisely as
`literal_secret`.

### Defaults and limits

All values are resolved once and apply to every instance unless the instance overrides them.

| Key | Default | Accepted value | Source |
|---|---:|---|---|
| `defaults.includeSelf` | `true` | boolean | `src/federation/registry.ts:359` |
| `defaults.mode` | `"read"` | `"read"` or `"write"` | `src/federation/registry.ts:360` |
| `defaults.timeoutMs` | `3000` | integer `1`–`60000` | `src/federation/registry.ts:168`, `:177`, `:389` |
| `defaults.concurrency` | `8` | integer `1`–`16` | `src/federation/registry.ts:171`–`:172`, `:402` |
| `defaults.limit` | `200` | integer `1`–`5000`, clamped to `1000` | `src/federation/registry.ts:169`–`:170`, `:175`, `:414`–`:418` |
| `defaults.allowedHosts` | `[]` (no allowlist) | non-empty strings, exact host or `*.suffix` | `src/federation/registry.ts:364`, `:429`–`:444` |

There are two related upper bounds: a per-source timeout may not exceed `60000` ms
(`REGISTRY_MAX_TIMEOUT_MS`), and the aggregate window is capped at `1000` notes
(`REGISTRY_MAX_LIMIT`). A registry may write a larger `limit` (up to `5000`) and it is **clamped**,
not rejected; the hub and federator CLI `--limit` flags reject values above `1000` instead. CLI
precedence is: command line, then `registry.defaults`, then the built-in constant.

### Instance fields

| Field | Required | Rules |
|---|---|---|
| `id` | yes | `^[a-z0-9][a-z0-9._-]{0,63}$`; unique; not `self`, `all` or `*` |
| `base` | yes | absolute `http`/`https` URL; no userinfo, query or fragment; trailing slashes removed |
| `app` | no | non-empty string; the expected `/config.app`. A mismatch is `identity_mismatch` at start-up |
| `mode` | no | `"read"` or `"write"`; defaults to `defaults.mode` |
| `auth` | no | `{ "env": "NAME" }` — a reference, never a value |
| `tokenHeader` | no | RFC 7230 token; wins over the header derived from `/config.auth` |
| `tokenScheme` | no | `^[A-Za-z][A-Za-z0-9-]*$`; used as `"<scheme> <token>"` |

`app` is optional, but omitting it weakens the identity check: the hub's own `/config.app` is not
compared against an expectation, and a peer that reports no `app` at all becomes `unverified`
(§5). Registering the expected `app` is the recommended configuration.

### Credentials are references

A credential is written as `auth: { "env": "BP_STAGING_TOKEN" }` — the `{env:NAME}` form. The file
never contains a literal token. A `token`, `secret`, `password`, `headers`, `bearer`,
`credentials` or similar key is rejected as `literal_secret`, and such a document causes no network
call at all. If the named variable is unset or empty, start-up fails with `missing_credential`; a
referenced but unset credential is a configuration error, not a later 401.

Resolution rules: the header is `x-bluepencil-auth` for a hub that reports `auth:"secret"`, and
`Authorization: Bearer <token>` for a hub that reports `auth:"token"`. An explicit `tokenHeader`
always wins; with a `tokenScheme` the value becomes `"<scheme> <token>"`. Use one token per peer
and minimal scopes: a federation session holds N credentials by construction (§12).

### File permissions

The registry must not be readable by group or others. The loader stats the file **before** reading
or parsing it, so a rejected file's content is never consumed:

```ts
if ((info.mode & 0o077) !== 0) {
  throw new FederationError(
    "invalid_registry",
    `Registry file ${path} must not be accessible by group or others (expected 0600, got ${formatMode(info.mode)})`,
  );
}
```

In practice: `chmod 600 instances.json` (your registry file, e.g. the shipped `instances.json`). On platforms where `uid` is available and the process is not
root, the file must also be owned by the current user; that owner check is best effort and is
skipped when `uid` is unavailable. A world-readable bind mount therefore fails start-up even if its
JSON is valid — see the container note in §14(e).

Two loaders exist on purpose. `loadRegistry` is the start-up gate and resolves DNS; `instances
validate` and `instances list` use `loadRegistryFile`, which is offline and classifies literal
addresses only. `instances health` uses the online loader. A hostname that rebinds into link-local
space is therefore caught at start-up and by `health`, not by the offline file check.

## 4. Qualified ids

A federated note id is `instance/note-id`, for example:

```
dev-web/n-7f3a
staging-web/n-7f3a
```

The **first** `/` splits the two parts. The instance part follows the instance-id pattern above.
The note part may not be empty, may not contain `/` or `\`, may not be `.` or `..`, and may not
smuggle in a separator as `%2f` (checked literally and after percent-decoding). There is no
escaping and no re-encoding: a note id that cannot be qualified is reported as `invalid_id` and
skipped, never truncated. A single unusable note id is a note-level finding — it does not fail the
whole source.

Plain ids remain local:

* `list_notes` without `instance` reads `self` (if included) plus every peer. `instance:"all"` and
  `instance:"*"` are selectors for the same set; `instance:"self"` reads only the local store.
* `get_note` with a plain id resolves to `self` on a combined hub when `self` is available. On a
  pure federator — or a hub with `--no-self` — a plain id is `instance_required`; the client must
  qualify it.
* Every write needs exactly one target: either a qualified id or an `id` plus `instance`. A plain id
  without an instance is `instance_required`; an unqualified `create_note` never falls back to
  `self`. A selector as a write target is `fanout_denied`.
* A `session` filter may be qualified (`dev-web/review-1`). The prefix routes the filter to that
  instance and is stripped; an unqualified session name is local to each selected instance. There is
  no cross-instance session merge. `Session.ref` in the response is qualified; `Note.sessionRef`
  stays as the instance wrote it.
* The same local note id in two hubs stays two notes. There is no deduplication and no
  last-write-wins across instances.

Every note returned by aggregation is a copy with:

```json
{
  "id": "dev-web/n-7f3a",
  "instance": "dev-web",
  "app": "my-web-tool"
}
```

`app` is the registry's `app` or the peer's `/config.app`; if neither declares one, the label is
`"unknown"`. The source object is never mutated.

## 5. Aggregate envelope

`list_notes` on an aggregate (a hub with `--registry`, or a federator) returns an envelope, not a
bare note array:

```json
{
  "instances": [
    { "id": "dev-web", "app": "my-web-tool", "environment": "dev", "ok": true, "mode": "write", "count": 12 },
    { "id": "staging-web", "app": "my-web-tool", "environment": "staging", "ok": false, "mode": "read", "code": "instance_unreachable" }
  ],
  "partial": true,
  "truncated": false,
  "errors": [
    { "code": "instance_unreachable", "message": "staging-web: request failed", "instance": "staging-web" }
  ],
  "count": 12,
  "notes": [
    { "id": "dev-web/n-7f3a", "instance": "dev-web", "app": "my-web-tool" }
  ]
}
```

| Field | Meaning |
|---|---|
| `notes` | Qualified note copies, sorted in the shared review order then by `instance` and `id`, with one **global** `limit` applied after sorting |
| `instances` | One row per selected source: `id`, `ok`, `app`, optional `environment`, `mode`, and either `count` (notes returned, before the global limit) or `code` (why it failed) |
| `partial` | `true` only when at least one source succeeded **and** at least one failed; the healthy notes are still returned |
| `truncated` | `true` when more matching notes existed than the limit allowed. The envelope does not echo the limit; `limit` is an input argument |
| `errors` | One redaction-safe entry per failed source or unusable note id (`code`, `message`, optional `instance`/`status`). No cause chain is attached |
| `environment` | Present only when the caller filtered by environment; it narrows the read, it never rewrites a note |
| `count` | Number of notes actually returned after the done-filter |

`limit` is the aggregate window, not a per-instance cap: default `200`, maximum `1000`. It applies
after all sources have been read and merged, so a single instance can return more rows than the
final `notes` array contains; `truncated` is the signal that this happened. A caller-supplied
`limit` of `0`, a negative value or `NaN` falls back to the default; fractions are floored.

`unverified` is **not** an error and is only about identity: it is set when a peer's `/config` has no
non-empty `app`. A missing or non-boolean `federates` is never `unverified`; it is
`federates_missing` and refuses the start (§8). `unverified` is advisory: CLI runtime exit `0`,
health exit `5`. The read envelope's `instances` rows describe reachability and counts; the health
view (`list_instances`, `bluepencil instances health`) additionally reports `version` and
`unverified`, because that is where the peer is actually probed.

If **every** selected source fails, `list_notes` is an MCP tool error (`isError`) rather than an
empty success. That is deliberate: a dead federation must not look like "there are no notes".

## 6. Writes and the two locks

A write is allowed only when **all** of the following are true. Once a target has been resolved,
the checks run in this order:

1. The session is not `--read-only`. Otherwise: `read_only`.
2. The session has `--allow-write`. Otherwise: `mode_denied` — even for `self`.
3. The target is writable:
   * a peer must be registered with `mode:"write"`, otherwise `mode_denied`;
   * `self` must exist (`includeSelf`, not `--no-self`) and must not be read-only, otherwise
     `self_unavailable` or `mode_denied`.

The registry's `mode:"write"` is only a **ceiling**. The session flag is the second lock. Without
`--allow-write`, every federated write — including a write to `self` — is refused. `--read-only` is
stronger than both and wins over `--allow-write` and `mode:"write"`.

On a hub **with** `--registry`, `/mcp` is a federated session, so these locks apply. On a hub
**without** a registry, `/mcp` is the ordinary single-store door: `--allow-write` is not part of that
path and only `--read-only` refuses writes. `/notes` is never governed by `--allow-write` on either
kind of hub; `--read-only` does refuse `/notes` writes as well.

Other write rules:

* Exactly one target, no fan-out, no retry. A selector target is `fanout_denied`; a missing target
  is `instance_required`.
* The federator never rewrites `environment` and never forwards `allow_env_mismatch`. In federation
  mode `allow_env_mismatch` is rejected with `invalid_argument`; each instance keeps its own
  environment guard.
* A successful peer write is confirmed by the peer's 2xx and returns the note with a qualified id
  and `instance`. A `self` write additionally goes through the store's own confirmation.
* `export_bundle` and `import_bundle` require exactly one instance. There is no aggregate export,
  because a bundle has one environment. For a peer, export/import travel over that target's `/mcp`
  door; for `self` they stay in-process and never use HTTP.
* `bulk_remove` requires exactly one instance; there is no cross-instance delete.

## 7. `self` and `--no-self`

`self` is the read alias for the local store of a combined hub. It is not a registry id.

* `defaults.includeSelf` defaults to `true`. On a hub, `--include-self` forces it on and `--no-self`
  forces it off; both flags together are a usage error, and both accept an explicit `=true|false`.
  The command line wins over the registry default.
* When included, `self` appears as a normal source in the aggregate and in `list_instances` with
  `includeSelf:true`, and `instance:"self"` reads only that store. When excluded, `instance:"self"`
  fails with `self_unavailable`, and a no-instance read covers the peers only.
* The effective write mode of `self` is the two-lock result: `--allow-write` **and** not
  `--read-only` **and** `self.readOnly` false **and** `self` included. The registry `mode` field does
  not exist for `self`.
* On a pure federator there is no local store. Internally it sets `includeSelf:false`;
  `defaults.includeSelf` in the registry has no effect there. `--no-self` is accepted and is an
  explicit no-op; `--include-self` is a usage error (exit 1); `--no-self=<value>` is a usage error
  because the flag takes no value.

## 8. Strict `federates_missing`

`/config` is part of the federatable contract. Every peer must answer with a **boolean**
`federates` field:

| Peer's `/config` | Result |
|---|---|
| `federates: false` | Federatable — the hub is a leaf, not an aggregator |
| `federates: true` | `nested_federation`; the peer is itself an aggregating hub |
| `federates` absent or not a boolean | `federates_missing`; not a 0.10 hub |

`false` is the healthy leaf value: it means "this hub does not aggregate", which is exactly what a
peer must report. It does not mean "not federatable". A hub older than 0.10 does not report
`federates` at all and is therefore **not federatable**. The failure
is explicit and refuses the start; it never degrades into "no notes" and is never downgraded to
`unverified`. `unverified` is reserved for a hub that answers `federates:false` but does not name an
`app`.

The check happens once per peer before the first protocol frame. `federates_missing` and
`nested_federation` are not degradable errors; only `instance_unreachable` and `timeout` are (§10).
Upgrade the leaf hubs before adding them to a registry.

## 9. `--allow-insecure` and the target policy

`--allow-insecure` is off by default. When it is active, the process writes one warning line to
stderr and admits:

* plain `http` to non-loopback hosts;
* private addresses: RFC 1918 (`10/8`, `172.16/12`, `192.168/16`), CGNAT (`100.64/10`), IPv6 ULA
  (`fc00::/7`) and the deprecated site-local range (`fec0::/10`).

It never admits the classes below, in any mode:

| Target | Default | With `--allow-insecure` |
|---|---|---|
| `https://` public host | allowed | allowed |
| `https://` loopback (`127.0.0.1`, `::1`, `localhost`) | allowed | allowed |
| `https://` private / ULA / CGNAT | blocked (`private_without_allow_insecure`) | allowed |
| `http://` loopback | allowed | allowed |
| `http://` private / ULA / CGNAT | blocked (`http_non_loopback`) | allowed |
| `http://` public host | blocked (`http_non_loopback`) | allowed — this is the flag's broad edge |
| Link-local `169.254.0.0/16` | blocked (`link_local`) | **blocked** |
| Link-local `fe80::/10` | blocked (`link_local`) | **blocked** |
| Cloud metadata host names (`metadata`, `metadata.google.internal`, `metadata.*`, …) | blocked (`metadata`) | **blocked** |
| Cloud metadata addresses (`169.254.169.254`, `100.100.100.200`, `fd00:ec2::254`) | blocked (`metadata`) | **blocked** |
| Unspecified (`0.0.0.0/8`, `::`) | blocked (`unspecified`) | **blocked** |
| Multicast | blocked (`multicast`) | **blocked** |

IPv4-embedded IPv6 spellings (`::ffff:…`, `::ffff:0:…`, `::…`, `64:ff9b::…`) are classified by the
embedded IPv4 address, so a wrapped link-local or metadata target cannot pass as public. Metadata
names are checked before the allowlist: an allowlist entry cannot unlock a metadata host. The
optional `defaults.allowedHosts` accepts exact hosts (case-insensitive) and `*.suffix` wildcards;
literal IPs match literally only.

Scheme shape is independent of the flag: only `http`/`https`, no userinfo, no query and no fragment.
The pre-flight address check runs before **every** request and inspects every address the resolver
returns; redirects are refused (`redirect: "manual"`, any 3xx is `invalid_response`), so a custom
auth header cannot follow a `Location` to a foreign host. `instances validate` and `instances list`
stay offline even with the flag: it changes the URL policy, not the DNS behaviour.

## 10. Startup behaviour

The registry is a start-up gate. The hub loads and verifies it before it starts serving; the
federator loads it before the first stdio frame. (The final self-reference check for `--port 0`
runs immediately after `listen()` and closes the socket.) A failure means no partial start and
nothing usable is served.

| Outcome | Codes | Behaviour |
|---|---|---|
| **Fail fast** | `invalid_registry`, `invalid_base_url`, `missing_credential`, `id_collision`, `self_reference`, `identity_mismatch`, `federates_missing`, `nested_federation` | Refuse the start before any request is served |
| **Degraded** | `instance_unreachable`, `timeout` | Start anyway; the peer stays in `list_instances` with `ok:false`, aggregates become `partial`, health is exit 5 |
| **Warning** | `unverified` (no `app`), peer `/health` answering `ok:false` | The federator logs `ok:false` once; both processes start and remain usable, and `unverified` gets one stderr line |

Only `instance_unreachable` and `timeout` are degradable. Every identity or contract failure is
fatal — including a peer that returns an unreadable `/config` (`invalid_response`) or 404s it
(`not_found`). Starting against a mis-wired peer is worse than not starting. A degraded start is visible,
not silent: the row says `ok:false`, the read envelope says `partial`, and `instances health` exits 5.
A still-serving federator exits `0` on stdin EOF even when a peer is degraded.

There is no hot reload. A registry change takes effect on the next start or the next
`instances health` invocation.

## 11. Exit codes

The canonical mapping is `EXIT_CODES` in `src/federation/errors.ts` (`errors.ts:214`–`:240`). `mcp`
describes the tool result: `start_refused` aborts start-up, `partial` travels in the aggregate
envelope, `isError` is a failing tool call and `warning` is advisory.

| Code | MCP | `instances health` | CLI runtime |
|---|---|---:|---:|
| `invalid_registry` | `start_refused` | 4 | 4 |
| `invalid_base_url` | `start_refused` | 4 | 4 |
| `unknown_instance` | `isError` | 0 | 4 |
| `self_unavailable` | `isError` | 0 | 4 |
| `mode_denied` | `isError` | 0 | 4 |
| `read_only` | `isError` | 0 | 4 |
| `timeout` | `partial` | 5 | 5 |
| `partial` | `partial` | 5 | 5 |
| `identity_mismatch` | `start_refused` | 4 | 4 |
| `federates_missing` | `start_refused` | 4 | 4 |
| `unverified` | `warning` | 5 | 0 |
| `nested_federation` | `start_refused` | 4 | 4 |
| `self_reference` | `start_refused` | 4 | 4 |
| `id_collision` | `start_refused` | 4 | 4 |
| `invalid_id` | `partial` | 5 | 4 |
| `instance_required` | `isError` | 0 | 4 |
| `fanout_denied` | `isError` | 0 | 4 |
| `invalid_argument` | `isError` | 0 | 4 |
| `environment_mismatch` | `isError` | 0 | 4 |
| `usage` | `isError` (tool argument) | 0 | 1 |
| `missing_credential` | `start_refused` | 4 | 4 |
| `instance_unreachable` | `partial` | 5 | 5 |
| `invalid_response` | `partial` | 5 | 5 |
| `not_found` | `isError` | 0 | 4 |
| `not_persisted` | `isError` | 0 | 5 |

`bluepencil instances health` follows this contract:

* `0` — every instance is healthy. An `unverified` row or an `ok:false` row already escalates to 5;
* `4` — at least one instance is misconfigured or fails its identity check; 4 dominates 5;
* `5` — at least one instance is unhealthy/degraded and none is misconfigured. A probe that fails
  for a code the table marks as "not a health case" still counts as 5: an instance that answers
  `/health` with 404 is not healthy.
* `1` — usage error. `--check` is accepted for compatibility and does not change the probe.

`instances validate` and `instances list` are offline: `0` on success, `4` for an invalid registry,
`1` for usage. The federator itself uses `1` for usage, `4` for a refused start and `0` on normal
stdin EOF; the `runtime` column is shared with the CLI paths.

> **Exit codes.** Hub, federator and CLI share one contract. A refused federation start is exit `4`
> for `invalid_registry`, `invalid_base_url`, `federates_missing`, `self_reference`,
> `nested_federation`, `identity_mismatch` and `missing_credential`. A session that starts but is
> partial or degraded exits `5` (`timeout`, `partial`, `instance_unreachable`, `invalid_response`,
> `unverified`, `not_persisted`). `0` is success, `1` is usage and `2` is a store error. The hub no
> longer collapses federation failures into `1`.

## 12. Security and threat model

The registry decides which processes a session may talk to, so it is treated as a trust boundary.

**Registry tampering.** The file must be mode `0600` (no group/world bits) and, where `uid` is
available and the process is not root, owned by the current user. The stat happens before the read,
so an unsafe file is refused without its content being parsed. There is no signature and no
integrity check beyond the filesystem: review the registry like configuration, keep it in version
control with placeholders only, and do not mount it world-readable. In a container the file's uid
must match the process uid (`USER node`, typically 1000); a host-owned bind mount with another uid
is refused by the owner check.

**SSRF.** The target policy (§9) rejects non-HTTP schemes, userinfo, query and fragment, checks the
host allowlist, classifies literal and resolved addresses, and blocks link-local, metadata,
unspecified and multicast targets in every mode. Every request re-runs the check, and redirects are
refused. The target's own `/config` and `/health` are probed before `federates` is trusted.

**Residual risk: DNS check-to-connect TOCTOU.** The pre-flight resolver and `fetch` perform two
separate DNS resolutions. A hostname with a short TTL and an attacker-controlled DNS server can
answer with a public address for the check and a link-local or metadata address for the connection.
v1 does **not** pin the resolved IP; this is a documented residual risk, not a silent mitigation.
Boundaries that remain in place: the check runs before every request, redirects are refused, the
optional host allowlist narrows the set, and link-local/metadata targets are blocked both literally
and after resolution. A future release can close the gap with a pinned dispatcher/agent or a proxy
that performs its own resolution.

**Credential blast radius.** The registry holds references, never values; a literal credential key
makes the document invalid before any request. One token per peer with minimal scope limits what a
single compromised hub can reach. The resolved `credential` is non-enumerable and has a `toJSON`
guard, so it does not appear in `Object.keys`, a spread or `JSON.stringify`. All client messages
pass through a `Redactor` built from every resolved value (exact value, URL-encoded form,
JSON-escaped form, and — for secrets of at least eight characters — every eight-character window),
and each client carries its own defensive redactor. `list_instances` omits `base` and `auth`; `instances list` prints only id, app, base and
mode; registry error messages aggregate issue paths and codes without quoting values. Prefer
environment variables over command-line flags: a secret on a command line is visible in the process
list.

**Not a browser surface.** The federator is stdio only and has no HTTP listener. A browser cannot
read the registry, cannot choose an instance and cannot reach `/mcp` federation through the element.
This is a deliberate boundary, not a missing feature.

## 13. Non-goals

* **No cross-instance session merge.** Sessions are read per instance; a qualified `Session.ref` is
  routed, not merged. There is no deduplication and no last-write-wins across hubs.
* **No self-registration.** Nothing writes the registry. Browsers never register, and a hub never
  adds itself or a peer at runtime.
* **No multi-hub extension profile.** The MV3 extension keeps one global hub profile, and `instance`
  is not a browser attribute. Two hubs require two browser profiles or the federator.
* **No write fan-out or replication.** A write targets exactly one instance; there is no quorum, no
  retry loop and no replication. `all`/`*` are read selectors only.
* **No nested federation.** A registry lists hubs, not federators or aggregating hubs.
* **No registry hot reload.** The file is read at start-up; `instances health` is the explicit
  re-read.
* **No MCP resources in the federator.** The aggregate exposes tools only; `resources/list` is
  empty, because a single resource cannot represent a mixed-environment set.
* **No aggregate export.** `export_bundle` requires one instance; a mixed-environment bundle is
  refused.
* **`/notes` never aggregates.** It remains the single-environment browser contract on every hub.

## 14. Deployment shapes

Full configuration walkthroughs live in the [README](../README.md) and [DOCKER.md](DOCKER.md). The
shapes below are the short version: what talks to what, and the minimum that makes it run. The
ASCII is canonical.

### (a) Single store, stdio

```
  agent ──stdio──▶ bluepencil mcp
                        │
                        ▼
                notes.bluepencil.json
```

```bash
bluepencil mcp --store ./notes.bluepencil.json --environment dev \
  --app my-web-tool --allow-write
```

No registry, no HTTP. Read-only unless `--allow-write` is given. This is the 0.8 path and is
unaffected by federation.

### (b) Single hub and a browser

```
  browser ──/notes──▶ hub ──▶ notes.json
     │                  ▲
     └──/config, /health┘
  agent ────/mcp──────▶ hub (same store)
```

```bash
bluepencil-hub --store /srv/bluepencil/notes.json --port 8787 \
  --host 127.0.0.1 --name "Dev hub" --app my-web-tool --environment dev
```

```html
<bluepencil-notes endpoint="http://127.0.0.1:8787/api/v1/bluepencil"
  environment="dev" app="my-web-tool" session="review-2026-10-22"></bluepencil-notes>
```

No registry. The browser and the agent share the hub's one store.

### (c) Hub with a registry, read-only

```
  browser ──/notes──▶ aggregating hub ──▶ dev.json   (local only)
  agent ────/mcp────▶        │
                             ├──▶ staging-web        (mode: read)
                             └──▶ self               (read-only)
```

```json
{"schemaVersion":1,
 "defaults":{"includeSelf":true,"mode":"read","timeoutMs":3000},
 "instances":[{"id":"staging-web","base":"https://staging.example.com/api/v1/bluepencil",
   "app":"my-web-tool","mode":"read","auth":{"env":"BP_STAGING_TOKEN"}}]}
```

```bash
BLUEPENCIL_REGISTRY=./instances.json bluepencil-hub \
  --store /srv/bluepencil/dev.json --app my-web-tool --environment dev --read-only
```

The browser still sees only `dev.json` on `/notes`. The agent sees `self` (read-only) plus
`staging-web` on `/mcp`.

### (d) Federator with two hubs

```
  agent ──stdio──▶ federator ──/config, /notes, /mcp──▶ dev-web      (mode: write)
                        │
                        └──────────────────────────────▶ staging-web  (mode: read)
  instances.json ──read once──▶ federator
```

```json
{"schemaVersion":1,
 "defaults":{"mode":"read","timeoutMs":3000},
 "instances":[
  {"id":"dev-web","base":"http://127.0.0.1:8787/api/v1/bluepencil",
   "app":"my-web-tool","mode":"write","auth":{"env":"BP_DEV_TOKEN"}},
  {"id":"staging-web","base":"https://staging.example.com/api/v1/bluepencil",
   "app":"my-web-tool","mode":"read","auth":{"env":"BP_STAGING_TOKEN"}}]}
```

```json
{"mcpServers":{"bluepencil-federation":{"command":"bluepencil-federator",
 "args":["--registry","./instances.json","--allow-write"],
 "env":{"BP_DEV_TOKEN":"set-in-your-shell","BP_STAGING_TOKEN":"set-in-your-shell"}}}}
```

Reads return `dev-web/...` and `staging-web/...`. A write needs `instance:"dev-web"` and both locks:
`mode:"write"` in the registry **and** `--allow-write` on the session. `staging-web` receives
nothing. `includeSelf` is deliberately absent: it only applies to a combined hub. `--allow-insecure`
would be needed for non-loopback `http` or private targets, never for link-local/metadata.

### (e) Docker Compose: aggregating hub plus two leaf hubs

```
  browser ──▶ hub-dev ─────┐
  browser ──▶ hub-staging ─┤ private network
                           ├──▶ hub-aggregator ──/mcp──▶ agent
   instances.json ──ro──────┘        /mcp on 127.0.0.1:8790
```

```yaml
services:
  hub-dev:
    image: ghcr.io/popoboxxo/bluepencil:0.10.0
    command: ["--store","/data/dev.json","--app","my-web-tool",
              "--environment","dev","--name","dev-web","--auth-secret","${DEV_SECRET}"]
    volumes: ["dev-data:/data"]
    ports: ["8787:8787"]
  hub-staging:
    image: ghcr.io/popoboxxo/bluepencil:0.10.0
    command: ["--store","/data/staging.json","--app","my-web-tool",
              "--environment","staging","--name","staging-web","--auth-secret","${STAGING_SECRET}"]
    volumes: ["staging-data:/data"]
  hub-aggregator:
    image: ghcr.io/popoboxxo/bluepencil:0.10.0
    entrypoint: ["/usr/local/bin/bluepencil-hub"]
    user: "${BLUEPENCIL_UID:-1000}:${BLUEPENCIL_GID:-1000}"
    command: ["--store","/tmp/aggregator.json",
              "--host","0.0.0.0","--port","8787","--base","/api/v1/bluepencil",
              "--name","hub-aggregator","--app","my-web-tool",
              "--registry","/etc/bluepencil/instances.json",
              "--no-self","--read-only","--allow-insecure"]
    ports: ["127.0.0.1:${BLUEPENCIL_AGGREGATOR_PORT:-8790}:8787"]
    volumes: ["./instances.json:/etc/bluepencil/instances.json:ro"]
    environment:
      BP_DEV_TOKEN: "${BP_DEV_TOKEN:?BP_DEV_TOKEN is required (see .env.example)}"
      BP_STAGING_TOKEN: "${BP_STAGING_TOKEN:?BP_STAGING_TOKEN is required (see .env.example)}"
    depends_on: [hub-dev, hub-staging]
volumes:
  dev-data: {}
  staging-data: {}
```

The aggregator's peers are `http://hub-dev:8787/api/v1/bluepencil` and the staging equivalent;
`--allow-insecure` is required for non-loopback `http` in the private Docker network. Its `/mcp`
door is published on host loopback only: the shipped compose maps container `8787` to
`127.0.0.1:8790`, so the aggregate is not reachable outside the machine. The browser still talks to
`hub-dev` and `hub-staging` directly. `/notes` on the aggregator stays local (the aggregator's store
is empty in this shape); `--no-self` affects only the aggregate, not `/notes`. Only `/mcp`
aggregates. The leaf hubs still accept browser writes on their own `/notes`.

The wrapper is used instead of the image's default entrypoint because the aggregator supplies its own
`--store`, `--host`, `--port` and `--base`; `--host 0.0.0.0 --port 8787 --base /api/v1/bluepencil`
are the values the container actually serves on. The two `environment` entries are the credential
*references* the registry resolves (`auth: { "env": "BP_DEV_TOKEN" }`), never literal tokens.

`--read-only` makes the aggregator a pure view. Federated writes already need `--allow-write` on the
session *and* `mode:"write"` in the registry, so this is defence in depth: the aggregate cannot
accept a write even if a target were registered writable and the session later gained
`--allow-write`.

The registry file is bind-mounted read-only, but that is not enough: it must also be mode `0600` and
owned by the container's `node` uid on the host, or the loader refuses it (§3). A pure federator is
not a Compose service — it is the local stdio process the agent starts:

```bash
docker run -i --rm --network bluepencil-federation \
  --user "$(id -u):$(id -g)" \
  --env-file .env \
  --no-healthcheck \
  -v ./instances.json:/etc/bluepencil/instances.json:ro \
  ghcr.io/popoboxxo/bluepencil:0.10.0 bluepencil-federator \
  --registry /etc/bluepencil/instances.json --read-only --allow-insecure
```

`--env-file .env` passes the registry's credentials (`BP_DEV_TOKEN`, `BP_STAGING_TOKEN`) into the
process instead of reading the shell environment; the token lines in `.env.example` must be
uncommented and filled. `--user` keeps the `0600` registry owner check satisfied when the host uid
differs from the image's `node` user (1000). `--no-healthcheck` disables the image's `HEALTHCHECK`:
it probes the hub's `/config`, a federator has no HTTP endpoint, and the probe would otherwise report
`unhealthy` forever. `-i` keeps stdin open; without an attached client the process exits on stdin
EOF. A federator has no `/config`, so `includeSelf` is a documented no-op there.

## 15. Rollback

Federation is additive. There is no store-format change and no schema migration: notes stay in the
same canonical bundles, and a 0.10 store is readable by 0.9. To return a hub to single-store
behaviour:

1. Remove `--registry` (and `BLUEPENCIL_REGISTRY`) from the command line or Compose service.
   `loadHubFederation` then returns `undefined`, `/config` reports `federates:false`, and `/mcp`
   falls back to the normal store backend with the nine single-store tools.
2. Stop the federator process. The leaf hubs are unaffected; they never depended on it.
3. Leave the registry file in place if you like. A 0.9 hub ignores it; it contains no notes and no
   state. Delete it when you no longer need the configuration.
4. Keep `--read-only` / `--allow-write` if they were already part of the deployment. They are
   independent flags and need no data migration.

What changes for clients: after removing the registry, `list_instances` no longer exists and the
`instance` arguments are not part of the single-store tool surface. A client that used them must
fall back to the single-store calls. No note is lost, because federation never owned a store of its
own and never rewrote one.
