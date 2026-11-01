# bluepencil MCP

> How an agent reads and writes bluepencil notes as structured data instead of scraping a page.
> The MCP layer is a thin wrapper over the headless library (`src/data`); validation, filtering,
> merge, canonicalisation and bundle I/O stay in one implementation (FR-15.3). There is no
> browser required on the agent side.
>
> This document covers the stdio server, the hub's HTTP door and the federation surfaces. For
> topology, the registry schema and the security model, see [FEDERATION.md](FEDERATION.md). For a
> worked Hermes example, see [HERMES.md](HERMES.md).

## What MCP gives you

A note is not a screenshot and not a paragraph in a chat. It is a record with an id, an anchor
(hook, CSS selector or text quote), the captured context, an append-only thread, a status, an
intent, an environment and a schema version. MCP exposes that record as JSON-RPC tools:

* an agent can **list, read, create and answer** notes without a browser session;
* every agent write carries `source=agent`, the MCP client name and the session id, so machine
  notes stay distinguishable from human notes (FR-16.4);
* the same functions back the UI, the CLI, the hub and MCP, so `bluepencil merge` and
  `import_bundle` behave identically for the same input;
* the session is bound to one store, one app and one environment, and it cannot read or mutate
  another environment's notes (FR-16.3).

### Which surface do I need?

| Surface | Transport | Own store | Aggregates peers | Tools |
|---|---|---|---|---|
| `bluepencil mcp` | stdio | one file | no | 9 |
| `bluepencil-hub` (`/mcp`) | HTTP | one file | only with `--registry` | 9, or 10 with a registry |
| `bluepencil-federator` | stdio | none | yes | 10 |
| `bluepencil-hub --registry` | HTTP | one file, optionally included | yes | 10 |

The two stdio servers are read-only by default. A hub is a browser-facing server and is
read-write unless `--read-only`; its federated `/mcp` aggregate has its own write locks. See
[Read-only by default and `--allow-write`](#read-only-by-default-and---allow-write).

## One store

### stdio: one store, one environment

`bluepencil mcp` serves exactly one note file. It is the smallest way to give an agent notes.

```bash
bluepencil mcp \
  --store ./notes.bluepencil.json \
  --environment dev \
  --app my-web-tool \
  --session-id review-2026-10-23
```

| Flag | Environment variable | Default | Meaning |
|---|---|---|---|
| `--store <path>` | `BLUEPENCIL_STORE` | required | Canonical bundle JSON or a bare note array. A missing file is an empty start. |
| `--environment <env>` | `BLUEPENCIL_ENVIRONMENT` | `dev` | `dev`, `staging` or `live`. The session's only binding. |
| `--app <name>` | `BLUEPENCIL_APP` | `unknown-app` | App label on exports and on agent writes. |
| `--session-id <id>` | `BLUEPENCIL_SESSION` | generated | Session id recorded on agent writes. |
| `--allow-write` | `BLUEPENCIL_ALLOW_WRITE=1` | off | Enables the write tools. See the strict rules below. |

The store is validated before the first byte is served. An existing file that is not a valid note
set is reported on stderr and the process exits `2`; it is never served as "no notes". stdout
carries MCP frames only; diagnostics go to stderr. Closing stdin ends the process with exit `0`.

### HTTP: a hub

A hub serves one store over HTTP on one port, through two doors under the same base path
(default `/api/v1/bluepencil`):

| Door | What it is |
|---|---|
| `{base}/notes` | The notes API the browser uses. It is local to this hub and its one environment. |
| `{base}/mcp` | MCP over HTTP: JSON-RPC 2.0, `POST` only, one JSON answer per request, no sessions, no SSE. |

```bash
bluepencil-hub \
  --store /srv/bluepencil/dev.json \
  --port 8787 \
  --host 127.0.0.1 \
  --name "Dev hub" \
  --app my-web-tool \
  --environment dev
```

`GET {base}/config` is readable before a credential. It describes the deployment:

```bash
curl -s http://127.0.0.1:8787/api/v1/bluepencil/config
```

```json
{
  "name": "Dev hub",
  "app": "my-web-tool",
  "federates": false,
  "version": "0.10.3",
  "base": "/api/v1/bluepencil",
  "auth": "none",
  "readOnly": false,
  "environment": "dev",
  "bind": { "host": "127.0.0.1", "port": 8787, "loopbackOnly": true }
}
```

`app` and `federates` always exist. `federates` is `true` exactly when the hub was started with
`--registry`; it is what a peer checks before trusting a federation member. `environment` is the
hub's one environment, not a note field. `/notes`, `/health` and `/mcp` follow the hub's
`--auth-secret` / token gate; `/config` is unauthenticated by design, and so is
`GET {base}/journal` (it is answered before any auth), plus the admin page when `--admin-secret`
is enabled.

The optional admin secret (`--admin-secret` / `BLUEPENCIL_ADMIN_SECRET`) is **not a client
credential on this door**. `POST {base}/mcp` accepts only the configured client credential — the
shared secret or a signed token. The admin secret is admitted as a second credential on the notes
routes only, never on `/mcp`, so a token-only hub can be administered without opening the MCP door
to the operator's secret.

The MCP door speaks the normal handshake:

```bash
curl -s http://127.0.0.1:8787/api/v1/bluepencil/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

A hub without a registry exposes the same 9 tools as `bluepencil mcp`. With `--registry`, the
`/mcp` door aggregates (see below) while `/notes` stays local. A corrupt store file stops the hub
with exit `2` before the socket is bound; it is never served as an empty set.

`initialize` is the one message exempt from the `MCP-Protocol-Version` header gate: the header names
the client's proposal, and the handshake answers with the revision this implementation speaks,
`2024-11-05`, rather than echoing the proposal. Every later request must claim that revision; a
different one is answered `400` naming both versions. The door is stateless and single-revision: a
post-handshake request that omits the header is still accepted.

## Several stores

Federation is an **agent-side** layer. Browser clients never join a registry and never choose an
instance; they write to exactly one hub. There are two federation surfaces.

### The federator (stdio)

`bluepencil-federator` is a separate stdio process. It has **no store, no HTTP endpoint and no
`/config`**: it reads a registry, verifies every peer before the first protocol frame, and serves
the aggregate over stdio.

```bash
bluepencil-federator --registry ./instances.json
```

Minimal registry:

```json
{
  "schemaVersion": 1,
  "defaults": { "mode": "read", "timeoutMs": 3000, "limit": 200 },
  "instances": [
    {
      "id": "dev",
      "base": "http://127.0.0.1:8787/api/v1/bluepencil",
      "app": "my-web-tool",
      "mode": "write"
    },
    {
      "id": "staging",
      "base": "https://staging.example.com/api/v1/bluepencil",
      "app": "my-web-tool",
      "auth": { "env": "BP_STAGING_TOKEN" }
    }
  ]
}
```

* The registry must not be readable by group or others. `chmod 600 instances.json` (the shipped example's name; use your own registry filename otherwise).
* `auth` is a **reference** to an environment variable, never a literal secret.
* `mode` is `read` (default) or `write`. It is one of the two write locks.
* `includeSelf` is meaningless to a pure federator: there is no local store. `--no-self` is
  accepted as a no-op; `--include-self` is a usage error (`exit 1`).
* Reads without `instance` span every instance and every environment; each note carries its own
  `instance` and `app`. Writes need exactly one `instance` (or a qualified id) and are routed to
  that one store.

| Flag | Default | Meaning |
|---|---|---|
| `--registry <path>` | `BLUEPENCIL_REGISTRY`; required | The registry file (mode `0600`). |
| `--read-only` | off | Refuse every write, even with `--allow-write`. |
| `--allow-write` | off | Second write lock; a target still needs `mode:"write"`. |
| `--allow-insecure` | off | Allow plain `http` and private addresses in registry bases. |
| `--timeout <ms>` | registry `timeoutMs`, else `3000` | Per-source timeout. |
| `--concurrency <1..16>` | registry `concurrency`, else `8` | Parallel instance reads. |
| `--limit <1..1000>` | registry `limit`, else `200` | Maximum notes in one aggregate. |
| `--app "<text>"` | `bluepencil federator` | MCP app label. |
| `--client-name "<text>"` | the app label | Provenance name sent to peers. |
| `--session-id <id>` | generated | Session id recorded on writes. |
| `--no-self` / `--include-self` | — | `--no-self` is a no-op; `--include-self` is a usage error (exit `1`). |

### The aggregating hub (`--registry`)

A hub can keep its own browser-facing store and add a registry. Then `/notes` stays local and only
`/mcp` aggregates.

```bash
bluepencil-hub \
  --store /srv/bluepencil/aggregator.json \
  --app my-web-tool \
  --environment dev \
  --registry ./instances.json \
  --no-self
```

`--include-self` / `--no-self` decide whether this hub's own store participates in the aggregate;
the default comes from the registry (`includeSelf`, default `true`). `--no-self` is how an
aggregator with an intentionally empty store stays out of the result. A browser still sees only
`aggregator.json`; an MCP client sees the registry peers. `/config.federates` is `true`.

### One federation level only

A peer that reports `federates: true` is rejected at startup with `nested_federation` (`exit 4`).
Point a registry at leaf hubs, never at another aggregator or federator. There are no nested
federations and no federation-wide session merge.

### Export and import across instances

`export_bundle` and `import_bundle` are **per instance** in a federation:

* both need exactly one `instance`; a missing one is `instance_required`, a selector (`all`/`*`)
  is `fanout_denied`;
* the federator routes the call through that target hub's `/mcp` door, so the target's own
  validation and merge code runs;
* `import_bundle` needs `--allow-write` and a target in `mode:"write"`;
* `allow_env_mismatch` is refused in federation mode (`invalid_argument`): the federator never
  rewrites an environment and never forwards that override.

## Client recipes

Every stdio client takes a `command` and an `args` array. The command is the `bluepencil` binary
(or `node` plus the absolute path to `dist/cli.js`); the first argument is the `mcp` subcommand.
The federator is a **separate binary** (`bluepencil-federator`), not an `mcp` subcommand.

If you run from a checkout instead of an installed package, replace `npx -y bluepencil` with
`node /absolute/path/to/dist/cli.js`.

### Any MCP client (stdio)

This is the normative shape; any client that can spawn a process with an argv array can run it.
Two entries are shown so the safe default and the opt-in are both visible.

```json
{
  "mcpServers": {
    "bluepencil": {
      "command": "npx",
      "args": [
        "-y", "bluepencil", "mcp",
        "--store", "/absolute/path/notes.bluepencil.json",
        "--environment", "dev",
        "--app", "my-web-tool"
      ]
    },
    "bluepencil-dev-write": {
      "command": "npx",
      "args": [
        "-y", "bluepencil", "mcp",
        "--store", "/absolute/path/notes.bluepencil.json",
        "--environment", "dev",
        "--app", "my-web-tool",
        "--allow-write"
      ]
    }
  }
}
```

Federator equivalent:

```json
{
  "mcpServers": {
    "bluepencil-federation": {
      "command": "bluepencil-federator",
      "args": ["--registry", "/absolute/path/instances.json"]
    },
    "bluepencil-federation-write": {
      "command": "bluepencil-federator",
      "args": ["--registry", "/absolute/path/instances.json", "--allow-write"]
    }
  }
}
```

### Claude Desktop

Add the entries to `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`) and restart Claude Desktop.

```json
{
  "mcpServers": {
    "bluepencil": {
      "command": "npx",
      "args": [
        "-y", "bluepencil", "mcp",
        "--store", "/absolute/path/notes.bluepencil.json",
        "--environment", "dev",
        "--app", "my-web-tool"
      ]
    },
    "bluepencil-dev-write": {
      "command": "npx",
      "args": [
        "-y", "bluepencil", "mcp",
        "--store", "/absolute/path/notes.bluepencil.json",
        "--environment", "dev",
        "--app", "my-web-tool",
        "--allow-write"
      ]
    }
  }
}
```

### opencode

Put this in `opencode.json` (project) or the global opencode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "bluepencil": {
      "type": "local",
      "command": [
        "npx", "-y", "bluepencil", "mcp",
        "--store", "/absolute/path/notes.bluepencil.json",
        "--environment", "dev",
        "--app", "my-web-tool"
      ],
      "enabled": true
    },
    "bluepencil-dev-write": {
      "type": "local",
      "command": [
        "npx", "-y", "bluepencil", "mcp",
        "--store", "/absolute/path/notes.bluepencil.json",
        "--environment", "dev",
        "--app", "my-web-tool",
        "--allow-write"
      ],
      "enabled": true
    }
  }
}
```

### Hermes

Hermes cannot reliably write a YAML list for `args`, so this repository ships a wrapper that
passes the same values through environment variables. Read-only is the default because
`BLUEPENCIL_ALLOW_WRITE` is absent.

```bash
hermes config set mcp_servers.bluepencil.command "/absolute/path/scripts/hermes-mcp-wrapper.sh"
hermes config set mcp_servers.bluepencil.env.BLUEPENCIL_STORE "/absolute/path/notes.bluepencil.json"
hermes config set mcp_servers.bluepencil.env.BLUEPENCIL_ENVIRONMENT "dev"
hermes config set mcp_servers.bluepencil.env.BLUEPENCIL_APP "my-web-tool"
hermes mcp test bluepencil
```

For a writable session, add a second entry and set the opt-in by hand in `config.yaml` as a
quoted string (Hermes stores an unquoted `1` as a YAML integer):

```yaml
mcp_servers:
  bluepencil-dev-write:
    command: /absolute/path/scripts/hermes-mcp-wrapper.sh
    env:
      BLUEPENCIL_STORE: /absolute/path/notes.bluepencil.json
      BLUEPENCIL_ENVIRONMENT: dev
      BLUEPENCIL_APP: my-web-tool
      BLUEPENCIL_ALLOW_WRITE: '1'
```

Hermes is one client among several; nothing in bluepencil requires it. More detail, including the
tool-name prefix in a Hermes session: [HERMES.md](HERMES.md).

## Tools, resources and prompts

### Tools

A single store exposes 9 tools. The federation surface exposes 10: the same set plus
`list_instances`. In the single-store schema, `instance` (and `limit` on `list_notes`) is not
advertised at all; the arguments would be ignored.

| Tool | R/W | What it does |
|---|---|---|
| `list_notes` | R | List notes in review order (open decisions first, then feedback-only). Only the session's environment in a single store; in a federation, no `instance` means every instance and each note carries `instance` and `app`. |
| `list_instances` | R | List the reachable instances (`id`, `app`, `environment`, `mode`, health). Never base URLs, tokens or credentials. **Federation only.** |
| `get_note` | R | Fetch one note with its anchor, captured context and full thread. |
| `create_note` | W | Create a note with `source=agent`; an anchor needs at least one of `hook`, `selector` or `quote`. |
| `reply` | W | Append to a thread (append-only): `reply`, `decision_request`, `feedback`. A `decision` is refused — it is a human act (PROTOCOL §6.1). |
| `set_status` | W | Set a status. Refuses `done` on a note waiting for a decision and on `intent=feedback`. |
| `set_intent` | W | Switch a note between `implement` and `feedback`. |
| `export_bundle` | R | Export as a portable JSON bundle or as agent-facing Markdown (exception sections first). |
| `inspect_bundle` | R | Summarise a bundle (sessions, counts, environments, routes) without writing. |
| `import_bundle` | W | Import with `merge`, `upsert` or `replace-session`; dry-run by default; conflicts are reported, never resolved silently. |

`import_bundle` is a write. It refuses an unresolved conflict unless `on_conflict` says which side
wins, exactly like `bluepencil merge`.

### Resources and prompts

The single-store session offers three resources:

| URI | MIME type | Content |
|---|---|---|
| `bluepencil://notes` | `text/markdown` | The agent-facing Markdown export. |
| `bluepencil://notes.json` | `application/json` | The canonical note set. |
| `bluepencil://bundle` | `application/json` | A portable bundle. |

A **federated** session has no resources: `resources/list` is empty and `resources/read` returns
`resource_unsupported` (FR-16.5). Use `list_notes` or `export_bundle` with an `instance`.

The two prompt templates (`work-off-open-notes`, `summarise-decisions`) are static instructions,
not federation data. They assume a single store; do not rely on them for multi-store work.

## Read-only by default and `--allow-write`

The write lock differs by surface. This is the whole table:

| Surface | Default | What enables a write |
|---|---|---|
| `bluepencil mcp` | read-only | `--allow-write` (or `BLUEPENCIL_ALLOW_WRITE=1`) |
| `bluepencil-federator` | read-only | `--allow-write` **and** the target's registry `mode:"write"` |
| `bluepencil-hub` `/notes`, and `/mcp` without a registry | read-write | nothing beyond not passing `--read-only`; `--allow-write` has no effect here |
| `bluepencil-hub --registry` `/mcp` (federated) | read-only for federated writes | `--allow-write` **and** the target's `mode:"write"`; `self` is included only with `--allow-write` |

`--read-only` wins over `--allow-write` and over `mode:"write"`. Without `--allow-write`, even
`self` in a combined hub is `mode_denied`. The federator has no `--include-self` mode; it also
accepts `--no-self` as a no-op.

### Strict boolean semantics

0.10.0 parses the flags that gate writes and network access; it does not probe for their presence.
The shared parser is also used by the hub, the federator and `bluepencil instances`.

| Form | Result |
|---|---|
| `--allow-write` | enabled |
| `--allow-write=true` | enabled |
| `BLUEPENCIL_ALLOW_WRITE=1` | enabled for `bluepencil mcp` (the hub and federator do not read this variable) |
| `--allow-write=false` | disabled |
| `--allow-write false` | disabled |
| `BLUEPENCIL_ALLOW_WRITE=0` | disabled |
| `--allow-write=yes`, `--allow-write 1` | usage error, exit `1` |

Before 0.10.0 the stdio server decided with a plain presence check, so `--allow-write false`
enabled writes. That fail-open is removed in 0.10.0: a present but unparsable value is a usage
error instead of a silent default. The bare `--allow-write` form is the portable one across all
surfaces.

## `--allow-insecure`

`--allow-insecure` relaxes the **registry URL policy**. It does not touch note data, authentication
or the browser.

| `--allow-insecure` unlocks | Always blocked, flag or not |
|---|---|
| Plain `http://` for a non-loopback registry base | Link-local addresses (`169.254.0.0/16`, `fe80::/10`) |
| Private addresses over http or https: RFC1918 (`10/8`, `172.16/12`, `192.168/16`), CGNAT (`100.64/10`), IPv6 ULA (`fc00::/7`) | Cloud metadata hosts and addresses (`metadata.*`, `169.254.169.254`, `fd00:ec2::254`, …) |
| | Unspecified (`0.0.0.0`, `::`) and multicast targets |

Loopback over plain `http` is allowed without the flag. A registry's optional `allowedHosts`
allowlist still applies. When the flag is active, the hub and the federator print one warning line
to stderr. Use it only on a private network; it is not a way to reach a metadata service.

`bluepencil instances validate|list|health` accepts the same flag, so a lab registry that uses
`http://hub-dev:8787/api/v1/bluepencil` can be inspected and probed.

## Environment binding and qualified ids

* A **stdio single store** is bound to one environment. `list_notes` always includes it; a filter
  naming another environment is refused (`environment_mismatch`), and reading or writing a note of
  another environment is refused with a message naming both.
* A **hub** is bound to one environment for its own store and for `/notes`; `/config.environment`
  reports it. One hub is one environment.
* A **federation** reads across environments. Every note keeps the environment it was stored with;
  the optional `environment` filter narrows the result and never rewrites a note. Writes are
  always env-bound by the target instance; the federator never adds or changes `environment` and
  never forwards `allow_env_mismatch`.
* Federation ids are **qualified**: `instance/noteId`, for example `dev/n-1`. The instance part
  matches `[a-z0-9][a-z0-9._-]{0,63}`. `self` is the local read alias and, in a combined hub, a
  write target. `all` and `*` are read selectors and are refused for writes (`fanout_denied`).
  A note id containing `/` is not federatable (`invalid_id`); it is never truncated or escaped.
* `instance` is **not** a browser attribute. Browser clients write to one hub; federation exists
  between hubs and agents, not in the page. `environment` in the browser element names the hub's
  environment; it is not a federation selector.

## Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| Startup exits `4` with `federates_missing` | The peer is older than 0.10, or a custom backend's `/config` has no boolean `federates` | Upgrade the peer; a custom backend must return `"federates": false` |
| Startup exits `4` with `nested_federation` | The peer reports `federates:true` | One level only: register leaf hubs, not another aggregator or federator |
| Startup exits `4` with `self_reference` | The registry entry addresses this hub, or uses the reserved id `self` | Remove the entry; use `--include-self` on the hub instead |
| Startup exits `4` with `invalid_registry`, `invalid_base_url`, `missing_credential` or `identity_mismatch` | File is not `0600`, shape is wrong, URL policy blocks the base, `auth.env` is unset, or `app` differs from `/config.app` | Run `bluepencil instances validate --registry …`; fix the file or the variable. Set the registry `app` to the value `/config` reports |
| One peer is down but the session starts | `instance_unreachable` / `timeout` is degradable | Expected: the row is `ok:false`, the aggregate is `partial:true`, and `instances health` exits `5`. Fix the peer or keep working |
| Write fails with `mode_denied` | No `--allow-write`, or the target registry entry is not `mode:"write"` | Add `--allow-write` **and** set `mode:"write"`; both locks are required |
| Write fails with `read_only` | The session was started with `--read-only` | `--read-only` wins over both locks; remove it deliberately |
| Write fails with `instance_required` | A federated write, export or import without `instance` | Name exactly one instance; there is no write fan-out |
| Write fails with `fanout_denied` | `instance` is `all` or `*` | Name one concrete instance |
| Write fails with `not_persisted` | The change did not reach the medium | Treat the write as failed, check disk and permissions; runtime exit is `5` |
| 401 from a peer, mapped to `missing_credential` | `auth.env` is unset or the token is wrong | Export the variable in the process environment. Values are redacted from errors and logs |
| A row is `unverified` | The peer's `/config` has no `app` | Usable; warning only (health `5`, runtime `0`). Add `--app` to the peer |
| The tool list has 9 tools, not 10 | You are on a single store (stdio, or a hub without `--registry`) | `list_instances` exists only in a federation surface. Add a registry or use the federator |
| `resources/list` is empty | The session is federated | Expected: no resources in a federation. Use `list_notes` / `export_bundle` with an `instance` |
| `environment_mismatch` | A single-store session filters, reads or imports another environment | Use a session bound to that environment; a single-store import needs `allow_env_mismatch` deliberately |
| `unknown_instance` | The instance id is not in the registry | Check `list_instances`, or `bluepencil instances list --registry …` |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. The stdio servers also exit `0` on stdin EOF. |
| `1` | Usage error: unknown flag, malformed boolean, missing `--store` or `--registry`. |
| `2` | `bluepencil mcp` and the hub: the store file is unreadable or not a valid note set. |
| `4` | Failed: invalid registry or base URL, an identity/start failure, or a refused runtime operation (`mode_denied`, `read_only`, `unknown_instance`, `instance_required`, `fanout_denied`, `environment_mismatch`, `not_found`). |
| `5` | Partial or degraded: `timeout`, `instance_unreachable`, `partial`, `invalid_response`, `not_persisted`; `instances health` also uses `5` for an unhealthy or unverified instance. |

`unverified` is the documented exception: health `5`, but runtime `0` — the instance is usable and
the warning does not fail the command.

## See also

* [FEDERATION.md](FEDERATION.md) — topology, registry schema, URL/secret policy, write semantics,
  startup and the threat model.
* [HERMES.md](HERMES.md) — a worked client example, including the wrapper and tool-name prefix.
* [PROTOCOL.md](PROTOCOL.md) — the rules an agent must follow when it answers notes.
* [INTEGRATION.md](INTEGRATION.md) — choosing between stdio, HTTP and federation.
