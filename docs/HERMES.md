# Hermes Agent — a worked example

> Hermes is **one MCP client among many**, not a requirement and not privileged in any way. The
> normative client contract — transports, tools, arguments, errors, strict flags — is
> [MCP.md](MCP.md); the topology behind several hubs is [FEDERATION.md](FEDERATION.md). This page
> shows one concrete wiring end to end because a worked example is easier to copy than an abstract
> table.
>
> The library itself is host-agnostic. The integration points below are the **MCP server** (one
> store, or several through the federator), the **federator** and the **CLI** (CI, scripts, offline
> exchange). Rules the agent side must follow: [PROTOCOL.md](PROTOCOL.md). Requirements: FR-15.x
> (headless data + CLI), FR-16.x (MCP).

---

## 1. Three ways to get notes into an agent

| Path | When | Command |
|---|---|---|
| **MCP server (stdio)** | An agent runtime works the notes live and answers in the thread | `bluepencil mcp --store notes.bluepencil.json --environment dev --app my-web-tool` |
| **Markdown export** | A human or agent reads the set once (paste, e-mail, ticket) | `bluepencil export notes.bluepencil.json --format md` |
| **Bundle (JSON)** | Exchange between machines/environments, commit to a repo, hand to CI | `bluepencil export notes.bluepencil.json --format json --out review.bluepencil.json` |

The Markdown export always opens with the two **exception sections** (*open decisions* and
*feedback only*) — read them first, they constrain everything else (PROTOCOL §7).

> There is no npm release yet: run the CLI as `node dist/cli.js <command> …` (after `npm run build`),
> or `npm link` once and use the shorter `bluepencil <command> …` form. The MCP row above is the
> same server as in §2.

## 2. MCP server, one store

The smallest useful path: one store file, one app, one environment. This is unchanged from `0.9`
except for the strict flag parsing.

```bash
npm run build
node dist/mcp.js --store ./notes.bluepencil.json --environment dev --app "my-web-tool"

# the same session with writes opted in
node dist/mcp.js --store ./notes.bluepencil.json --environment dev --app "my-web-tool" --allow-write
```

* **Read-only by default** (FR-16.2): `list_notes`, `get_note`, `export_bundle`, `inspect_bundle`
  work; `create_note`, `reply`, `set_status`, `set_intent`, `import_bundle` return a refusal until
  `--allow-write` (or `BLUEPENCIL_ALLOW_WRITE=1`) is set for the session. Only the three documented
  spellings enable it — `--allow-write`, `--allow-write=true`, or `BLUEPENCIL_ALLOW_WRITE=1`;
  `--allow-write=false` leaves writes off and `--allow-write 1` is a usage error.
* **One store, one app, one environment** (FR-16.3): a `dev`-bound session refuses to touch a
  `live` bundle, and imports from another environment are refused unless explicitly overridden.
* Agent writes carry `source=agent` plus the MCP client name and session id (FR-16.4), so machine
  notes stay distinguishable from human ones.

| Tool | R/W | Purpose |
|---|---|---|
| `list_notes` | R | Notes in review order (open decisions first), `include_done` to see history |
| `list_instances` | R | **Federation only.** Lists the reachable instances (`id`, `app`, `environment`, `mode`, health); never base URLs, tokens or credentials |
| `get_note` | R | One note with anchor, captured state and full thread |
| `create_note` | W | Write a note (source `agent`), anchored by hook, CSS path or quote |
| `reply` | W | Append to a thread — `reply`, `feedback`, `decision_request` |
| `set_status` / `set_intent` | W | Move a note; refuses `done` on pending decisions and feedback notes |
| `export_bundle` | R | Markdown (agent-facing) or JSON bundle |
| `inspect_bundle` | R | Summarises a bundle without writing anything |
| `import_bundle` | W | `merge` / `upsert` / `replace-session`, dry-run by default, conflicts reported |

A single store exposes **9** tools. `list_instances` is the tenth and exists only on a federation
surface (the federator, or a hub started with `--registry`). Resources: `bluepencil://notes`
(Markdown), `bluepencil://notes.json`, `bluepencil://bundle` — a federated session has **no
resources**. Prompts: `work-off-open-notes`, `summarise-decisions` (single-store instructions).

### Registering it in Hermes

Hermes cannot write a YAML list for `args`, so use the wrapper shipped in this repository; it
passes everything through the environment:

```bash
hermes config set mcp_servers.bluepencil.command "/opt/data/repos/bluepencil/scripts/hermes-mcp-wrapper.sh"
hermes config set mcp_servers.bluepencil.env.BLUEPENCIL_STORE "/opt/data/reviews/my-tool.bluepencil.json"
hermes config set mcp_servers.bluepencil.env.BLUEPENCIL_ENVIRONMENT "dev"
hermes config set mcp_servers.bluepencil.env.BLUEPENCIL_APP "my-web-tool"
hermes config set mcp_servers.bluepencil.sampling.enabled false
hermes config set mcp_servers.bluepencil.timeout 60
hermes mcp test bluepencil
```

Writes stay disabled because `BLUEPENCIL_ALLOW_WRITE` is simply **absent** — that is the safe
default of the wrapper. Do not set it with `hermes config set … 1`: the value is stored as a YAML
integer and the MCP client refuses to start (`Input should be a valid string`). To enable writes,
add it to `config.yaml` by hand as a quoted string (`BLUEPENCIL_ALLOW_WRITE: '1'`), preferably on a
second server entry bound to a dev store.

Tools appear in a session as `mcp__bluepencil__<tool>` — e.g. `mcp__bluepencil__list_notes` — after
a restart (no hot reload). For a live round with writes, either flip `BLUEPENCIL_ALLOW_WRITE` to `1`
or start a second server entry (e.g. `bluepencil_dev`) bound to a dev store.

## 3. Optional: several hubs through the federator

This section is optional and entirely additive. Use it when one agent session must see more than one
hub; a single store (§2) stays the simpler and safer default. Nothing about the browser changes:
browsers still write to exactly one hub and never read a registry.

A registry names the peers (API bases include `/api/v1/bluepencil`), references credentials through
environment variables, and must be mode `0600`:

```json
{
  "schemaVersion": 1,
  "defaults": { "mode": "read", "timeoutMs": 3000, "limit": 200 },
  "instances": [
    { "id": "dev",     "base": "http://127.0.0.1:8787/api/v1/bluepencil",
      "app": "my-web-tool", "mode": "write" },
    { "id": "staging", "base": "https://staging.example.com/api/v1/bluepencil",
      "app": "my-web-tool", "auth": { "env": "BP_STAGING_TOKEN" } }
  ]
}
```

```bash
chmod 600 instances.json
bluepencil instances validate --registry ./instances.json     # offline: shape, ids, URL policy
bluepencil instances health   --registry ./instances.json     # online: /config + /health per peer

node dist/federator.js --registry ./instances.json              # read-only
node dist/federator.js --registry ./instances.json --allow-write  # federated writes, still gated
```

`bluepencil-federator` is a **separate stdio binary**, not an `mcp` subcommand. It has no store, no
HTTP endpoint and no `/config`. Reads without `instance` span every peer and every environment; each
note carries its `instance` and `app`. A write names **exactly one** instance and needs both locks:
`mode: "write"` in the registry **and** `--allow-write` on the session. `--read-only` wins over both.

Hermes can attach it without args because the federator reads `BLUEPENCIL_REGISTRY`; point
`command` at the `bluepencil-federator` bin (`npm link` makes it available):

```bash
hermes config set mcp_servers.bluepencil-federation.command "bluepencil-federator"
hermes config set mcp_servers.bluepencil-federation.env.BLUEPENCIL_REGISTRY "/absolute/path/to/instances.json"
hermes config set mcp_servers.bluepencil-federation.env.BP_STAGING_TOKEN "$BP_STAGING_TOKEN"
hermes mcp test bluepencil-federation
```

That session is read-only: the federator does **not** read `BLUEPENCIL_ALLOW_WRITE`, and Hermes
cannot pass an argv list, so `--allow-write` needs a client that can (or a wrapper of your own).
`list_instances` appears here and is how the agent discovers peer ids before naming one in a write.

Startup is fail-fast: a bad registry exits `4` (`invalid_registry`, `invalid_base_url`,
`federates_missing`, `self_reference`, `nested_federation`, `identity_mismatch`,
`missing_credential`). A peer that is merely down does not stop the session; the aggregate is
`partial: true` and `instances health` exits `5`. Hubs older than `0.10` do not report the boolean
`federates` and are refused with `federates_missing`, never shown as an empty peer. Full rules:
[FEDERATION.md](FEDERATION.md) and [MCP.md § Several stores](MCP.md#several-stores).

## 4. CLI (no runtime involved)

```bash
node dist/cli.js inspect  live.bluepencil.json                       # summary, writes nothing
node dist/cli.js validate live.bluepencil.json                       # schema check, exit 4 when invalid
node dist/cli.js export   live.bluepencil.json --format md           # agent-facing Markdown
node dist/cli.js merge    dev.bluepencil.json team.bluepencil.json --dry-run --json
node dist/cli.js import   dev.bluepencil.json team.bluepencil.json --mode merge
node dist/cli.js instances validate --registry instances.json        # registry only, no network
node dist/cli.js instances health   --registry instances.json        # exit 5 when degraded
```

Exit codes are meaningful for pipelines: `0` ok, `1` usage, `2` refused (unresolved conflicts),
`3` environment mismatch, `4` invalid input (and a refused federation start), `5` federation degraded
(`instances health`: an instance is unreachable or unverified).

`npm run build` must have produced `dist/cli.js`; `npm link` gives you the shorter `bluepencil …`
form. Two more commands exist: `bluepencil notes <file>` prints a file's notes as JSON, and
`bluepencil mcp …` starts the server of §2.

## 5. The loop an agent runs

1. Read `bluepencil://notes` (or `bluepencil export … --format md`).
2. Read the exception sections first; never implement `intent=feedback`.
3. Implement `intent=implement` + `status=open` notes, one page/route at a time.
4. Per note: `reply` with what changed (and any deviation), then `set_status done`.
5. Unclear → `reply` with `kind=decision_request` (options + a recommendation) and stop; the human
   answers with `kind=decision` and the note returns to `open`.
6. Re-export and check the new state before reporting.

In a federation, steps 1–3 work the same, but a write names exactly one `instance` and the note ids
are qualified (`dev/n-1`). There is no cross-instance session merge: treat each peer as its own
round.

Hard prohibitions from PROTOCOL §6 apply unchanged: never invent a human decision, never implement
`intent=feedback`, never mark a pending decision as done, never delete notes you did not create.

## 6. Suggested Hermes skill / profile shape

A thin Hermes skill is enough — the server holds the logic:

* trigger: "work off the bluepencil notes for <app>" / "review notes";
* steps: `mcp__bluepencil__list_notes` → group by route → implement → `mcp__bluepencil__reply` +
  `mcp__bluepencil__set_status`;
* guardrails: read-only unless writes were opted in; environment must match the store; report
  conflicts instead of resolving them. In a federation, call `list_instances` first and write to one
  named instance.

## 7. Pitfalls

| Symptom | Cause |
|---|---|
| Every write tool answers "Read-only session" | `--allow-write` is absent, or `BLUEPENCIL_ALLOW_WRITE` is not exactly `1` (FR-16.2) |
| Tool call fails with an environment message | Session bound to another environment than the bundle (FR-16.3) |
| Startup exits `4` with `federates_missing` | The peer is older than `0.10` (or its `/config` has no boolean `federates`); upgrade it or drop it from the registry |
| Startup exits `4` with `nested_federation` | The peer itself reports `federates: true`; register leaf hubs only |
| Startup exits `4` with `invalid_registry` | The registry is not mode `0600`, is not owned by the process user, or has the wrong shape |
| A peer is down but the session starts | Expected: `partial: true`, `ok: false` for that row, `instances health` exits `5` |
| `bluepencil merge` exits `2` | A conflict was reported — resolve it with `--on-conflict` or by hand, never silently |
| The tool list has 9 tools, not 10 | You are on a single store; `list_instances` needs the federator or a hub with `--registry` |
| `resources/list` is empty | The session is federated; use `list_notes` / `export_bundle` with an `instance` |
| MCP tool list is empty | Build missing (`npm run build`) or the store/registry path in the wrapper is wrong |
| Notes vanish after a reload | Adapter is `memory`; use a file/HTTP adapter behind the store |
