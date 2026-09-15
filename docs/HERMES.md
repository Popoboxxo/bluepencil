# Using bluepencil with Hermes Agent

> How the review layer feeds an agent runtime. The library itself is host-agnostic; this document
> describes the two integration points we actually run: the **MCP server** (an agent reads and
> answers notes) and the **CLI** (CI, scripts, offline exchange).
>
> Rules the agent side must follow: [PROTOCOL.md](PROTOCOL.md). Requirements: FR-15.x (headless
> data + CLI), FR-16.x (MCP).

---

## 1. Three ways to get notes into an agent

| Path | When | Command |
|---|---|---|
| **MCP server (stdio)** | An agent runtime works the notes live and answers in the thread | `bluepencil mcp --store notes.bluepencil.json --environment dev` |
| **Markdown export** | A human or agent reads the set once (paste, e-mail, ticket) | `bluepencil export notes.bluepencil.json --format md` |
| **Bundle (JSON)** | Exchange between machines/environments, commit to a repo, hand to CI | `bluepencil export … --format json --out live.bluepencil.json` |

The Markdown export always opens with the two **exception sections** (`⚠ open decisions`,
`💬 feedback only`) — read them first, they constrain everything else (PROTOCOL §7).

## 2. MCP server

```bash
npm run build
node dist/mcp.js --store ./notes.bluepencil.json --environment dev --app "my-web-tool" [--allow-write]
```

* **Read-only by default** (FR-16.2): `list_notes`, `get_note`, `export_bundle`, `inspect_bundle`
  work; `create_note`, `reply`, `set_status`, `set_intent`, `import_bundle` return a refusal until
  `--allow-write` (or `BLUEPENCIL_ALLOW_WRITE=1`) is set for the session.
* **One store, one app, one environment** (FR-16.3): a `dev`-bound session refuses to touch a
  `live` bundle, and imports from another environment are refused unless explicitly overridden.
* Agent writes carry `source=agent` plus the MCP client name and session id (FR-16.4), so machine
  notes stay distinguishable from human ones.

| Tool | Purpose |
|---|---|
| `list_notes` | Notes in review order (open decisions first), `include_done` to see history |
| `get_note` | One note with anchor, captured state and full thread |
| `create_note` | Write a note (source `agent`), anchored by hook, CSS path or quote |
| `reply` | Append to a thread — `reply`, `feedback`, `decision_request` |
| `set_status` / `set_intent` | Move a note; refuses `done` on pending decisions and feedback notes |
| `export_bundle` | Markdown (agent-facing) or JSON bundle |
| `inspect_bundle` | Summaries a bundle without writing anything |
| `import_bundle` | `merge` / `upsert` / `replace-session`, dry-run by default, conflicts reported |

Resources: `bluepencil://notes` (Markdown), `bluepencil://notes.json`, `bluepencil://bundle`.
Prompts: `work-off-open-notes`, `summarise-decisions`.

### Registering it in Hermes

Hermes cannot write a YAML list for `args`, so use the wrapper shipped in this repository; it
passes everything through the environment:

```bash
hermes config set mcp_servers.bluepencil.command "/opt/data/repos/bluepencil/scripts/hermes-mcp-wrapper.sh"
hermes config set mcp_servers.bluepencil.env.BLUEPENCIL_STORE "/opt/data/reviews/my-tool.bluepencil.json"
hermes config set mcp_servers.bluepencil.env.BLUEPENCIL_ENVIRONMENT "dev"
hermes config set mcp_servers.bluepencil.env.BLUEPENCIL_APP "my-web-tool"
hermes config set mcp_servers.bluepencil.env.BLUEPENCIL_ALLOW_WRITE "0"   # 1 = writes enabled
hermes config set mcp_servers.bluepencil.sampling.enabled false
hermes config set mcp_servers.bluepencil.timeout 60
hermes mcp test bluepencil
```

Tools appear in a session as `mcp_bluepencil_<tool>` after a restart (no hot reload). For a live
round with writes, either flip `BLUEPENCIL_ALLOW_WRITE` to `1` or start a second server entry
(e.g. `bluepencil_dev`) bound to a dev store.

## 3. CLI (no runtime involved)

```bash
bluepencil inspect  live.bluepencil.json                       # summary, writes nothing
bluepencil validate live.bluepencil.json                       # schema check, exit 4 when invalid
bluepencil export   live.bluepencil.json --format md           # agent-facing Markdown
bluepencil merge    dev.bluepencil.json live.bluepencil.json --dry-run --json
bluepencil import   live.bluepencil.json dev.bluepencil.json --mode merge
```

Exit codes are meaningful for pipelines: `0` ok, `1` usage, `2` refused (unresolved conflicts),
`3` environment mismatch, `4` invalid input.

## 4. The loop an agent runs

1. Read `bluepencil://notes` (or `bluepencil export … --format md`).
2. Read the exception sections first; never implement `intent=feedback`.
3. Implement `intent=implement` + `status=open` notes, one page/route at a time.
4. Per note: `reply` with what changed (and any deviation), then `set_status done`.
5. Unclear → `reply` with `kind=decision_request` (options + a recommendation) and stop; the human
   answers with `kind=decision` and the note returns to `open`.
6. Re-export and check the new state before reporting.

Hard prohibitions from PROTOCOL §6 apply unchanged: never invent a human decision, never implement
`intent=feedback`, never mark a pending decision as done, never delete notes you did not create.

## 5. Suggested Hermes skill / profile shape

A thin Hermes skill is enough — the server holds the logic:

* trigger: "work off the bluepencil notes for <app>" / "review notes";
* steps: `mcp_bluepencil_list_notes` → group by route → implement → `mcp_bluepencil_reply` +
  `mcp_bluepencil_set_status`;
* guardrails: read-only unless writes were opted in; environment must match the store; report
  conflicts instead of resolving them.

## 6. Pitfalls

| Symptom | Cause |
|---|---|
| Every write tool answers "Read-only session" | `BLUEPENCIL_ALLOW_WRITE` is not `1` (FR-16.2) |
| Tool call fails with an environment message | Session bound to another environment than the bundle (FR-16.3) |
| `bluepencil merge` exits 2 | A conflict was reported — resolve it with `--on-conflict` or by hand, never silently |
| MCP tool list is empty | Build missing (`npm run build`) or the store path in the wrapper is wrong |
| Notes vanish after a reload | Adapter is `memory`; use a file/HTTP adapter behind the store |
