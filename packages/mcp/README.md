# @nivaro/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Nivaro CMS](https://nivaro.dev). It wraps the typed `@nivaro/sdk` so Claude Code, Claude Desktop, Cursor and any other MCP client can read and write a Nivaro instance directly — collection schemas, records, aggregates, pipeline state and transitions, My Work, queues, tasks, comments, notifications, history, files, saved queries, search, and the instance's own ask-your-data assistant. An administrator's key also gets read-only ops tools (health, runtime, database, traffic, jobs).

Every tool calls the instance's REST API as the user behind the configured API key. Role permissions, row-level security, user scopes, validation and change-reason rules apply exactly as they do to any other API caller. Nothing is cached or reimplemented on the server side; the API decides.

## Hosted endpoint — no install

Every Nivaro instance (0.2.59+) serves the same tools itself at `https://<your-nivaro>/api/mcp` (Streamable HTTP). Clients that support remote MCP servers connect there and sign you in through Nivaro with OAuth — or send an API key as a Bearer token. ChatGPT and claude.ai connect from their own cloud, so they need an instance reachable from the internet; on a private network use Claude Code, Codex or this npm package while you are on that network.

| Client | How |
| --- | --- |
| ChatGPT | Settings → Apps & Connectors → Advanced → Developer mode → create a connector with the URL above, authentication OAuth |
| claude.ai / Claude Desktop | Settings → Connectors → Add custom connector → the URL above |
| Claude Code | `claude mcp add --transport http nivaro https://<your-nivaro>/api/mcp`, then `/mcp` to sign in (or add `--header "Authorization: Bearer nvk_…"`) |
| Codex | `codex mcp add nivaro --url https://<your-nivaro>/api/mcp` then `codex mcp login nivaro` (or `bearer_token_env_var` in `~/.codex/config.toml`) |

An OAuth-connected app acts as the person who allowed it, with their permissions; its token works only on `/api/mcp` (never on the rest of the API, and never to mint keys or tokens), and the person can disconnect it at any time.

## Install

```bash
npm install -g @nivaro/mcp     # or run it ad hoc with npx -y @nivaro/mcp
```

Requires Node.js 18 or newer.

## Credentials

| Variable | Flag | Meaning |
| --- | --- | --- |
| `NIVARO_URL` | `--url` | The API origin, e.g. `https://cms.example.com` (no trailing `/api`) |
| `NIVARO_TOKEN` | `--token` | An `nvk_` API key (Settings → API Keys) or a user's static token |

The server refuses to start without a token. The token is masked in every diagnostic line and request bodies are never logged; stdout is the protocol channel, so only stderr carries diagnostics.

Which key you hand it decides what the assistant can do:

- a key with **narrowed scopes** is held to those scopes — a write outside them answers `API_KEY_SCOPE_MISSING`;
- a key with **row restrictions** sees only the rows its scope allows;
- a **sandbox** key is read-only by construction: the API rehearses its creates and refuses every other write, so an assistant on a sandbox key can explore freely and never change anything.

## Client configuration

### Claude Code

```bash
claude mcp add nivaro \
  -e NIVARO_URL=https://cms.example.com \
  -e NIVARO_TOKEN=nvk_your_key \
  -- npx -y @nivaro/mcp
```

Or, in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "nivaro": {
      "command": "npx",
      "args": ["-y", "@nivaro/mcp"],
      "env": {
        "NIVARO_URL": "https://cms.example.com",
        "NIVARO_TOKEN": "nvk_your_key"
      }
    }
  }
}
```

### Claude Desktop

Add the same block to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows: `%APPDATA%\Claude\claude_desktop_config.json`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "nivaro": {
      "command": "npx",
      "args": ["-y", "@nivaro/mcp"],
      "env": {
        "NIVARO_URL": "https://cms.example.com",
        "NIVARO_TOKEN": "nvk_your_key"
      }
    }
  }
}
```

### Cursor

Cursor Settings → MCP → Add new server, or `.cursor/mcp.json` in the project:

```json
{
  "mcpServers": {
    "nivaro": {
      "command": "npx",
      "args": ["-y", "@nivaro/mcp"],
      "env": {
        "NIVARO_URL": "https://cms.example.com",
        "NIVARO_TOKEN": "nvk_your_key"
      }
    }
  }
}
```

## Tools

Every tool answers JSON text. A refusal answers `isError: true` with the API's own message, HTTP status and code (`CHANGE_REASON_REQUIRED`, `MIDAIR_COLLISION`, `API_KEY_SCOPE_MISSING`, `DUPLICATE_ROW`, …) plus the actionable details the API attached — never a stack trace.

| Tool | What it does |
| --- | --- |
| `whoami` | The user the key acts as: id, name, role, admin flag, and the key's scopes / sandbox flag. |
| `list_collections` | Every collection the key can read — name, display name, singleton flag. |
| `describe_collection` | One collection's schema: fields with type, interface, required/readonly/hidden flags and dropdown choices; relations; display template; natural keys. |
| `read_items` | Page through records: `filter` (the SDK filter DSL), `sort`, `fields` (dotted paths follow relations), `search`, `limit` (capped at 200), `offset`. |
| `read_item` | One record by id, optionally projected to `fields`. |
| `aggregate_items` | Counts, sums, averages, min/max grouped by up to four fields, over the same rows a filtered read would return. |
| `create_item` | **Rehearses by default** (`dry_run: true`): rules, generated ids, validation and database constraints run and the report says what would be stored, nothing is written. `dry_run: false` stores the record. |
| `update_item` | Patches the named fields. `change_reason` carries the reason a collection may require; a 422 names the fields that need one. |
| `delete_item` | Deletes one record; refused unless `confirm: true`. |
| `list_pipeline_state` | Current state, the transitions the key's user may run (with ids), who owns the current state, the newest history entries. |
| `transition` | Runs one transition by id, with an optional comment; the API's role, condition and requirement checks apply. |
| `ask_data` | A plain-language question answered by the instance's own data assistant, which queries the collections as the key's user and returns the answer plus the tool trace. Needs an AI provider configured on the instance. |
| `my_work` | The key's user's inbox: owned records (SLA-first), tasks, team tasks, requested tasks, approval steps, unread notifications — each section cut to `limit`, with the totals. |
| `list_queues` | The worklists the user can open, with the collections each reads. |
| `read_queue` | One page of a queue's items (`scope` mine / unowned / claimed / all, `sort`, `page`, `limit` ≤ 100): label, state, owners, SLA status, age. |
| `list_tasks` | A record's tasks (`collection` + `id`) or the user's own open tasks; `status` narrows either. |
| `create_task` | Asks a person (`assignee`, from `find_people`) or a team (`team_id`) to do something on a record. |
| `complete_task` | Marks one task done. |
| `list_notifications` | The user's notifications, newest first; unread only unless `unread_only: false`. |
| `mark_notifications_read` | Marks the given ids read, or every unread one with `all: true`. |
| `list_comments` | A record's comment thread with authors and mentions; long threads show the newest `limit`. |
| `add_comment` | Posts a comment. Mentions: `@` + the part of an email before the `@`, `@owners`, `@watchers`, or a role name / group slug with hyphens for spaces. |
| `list_revisions` | A record's change history, newest first: who, when, the changed fields with their new values, change reasons and pipeline moves (no full snapshots). |
| `list_record_files` | Metadata of the files in a record's file fields. Never downloads content. |
| `read_file` | One file's metadata (name, type, size, uploader, date) — no storage key, no URL, no content. |
| `search` | Text search across every collection the user can read (or the ones named): collection, id and label per hit. |
| `find_people` | People by name or email: user id (for task assignees) and the `@handle` that mentions them. |
| `list_custom_queries` | The saved reporting queries the user may run, with their parameters. |
| `run_custom_query` | Runs a saved query by slug with `params`; rows cut to `limit`, long values clipped. |

Lists are paged or cut to a model-sized slice (`limit`, `offset` or `page`) and say so with `truncated` and a `total`; long text is clipped.

### Admin tools

When the key's user is an administrator, the `nivaro-mcp` command also registers these read-only tools (it calls `whoami` at startup; programmatically, pass `adminTools: true`). The API refuses them to anyone else regardless.

| Tool | What it does |
| --- | --- |
| `health` | Readiness checks (boot, migrations, extensions, database, Redis) plus latency, migration count, sockets, read-gate pressure and memory of the answering replica. |
| `preflight` | The deploy coherence check: migrations both ways, connectivity, required extensions, version pinning. |
| `runtime_stats` | Memory, event-loop lag and pool of the answering replica, every registered API process, and the scheduler lease holder. |
| `db_pool` | The connection pool: used/free/pending, wait pressure, and requests holding a connection over a second. |
| `expensive_sql` | The statements with the most database CPU since the plan cache cleared. |
| `traffic_summary` | A compact Traffic Map read over 1, 5 or 15 minutes: totals, busiest and most-erroring entities, top callers, downstream systems. |
| `list_cron_jobs` | Every scheduled job with its schedule, latest run and 7-day error count, plus what is running now (`failing_only` narrows). |
| `list_job_runs` | Background-job run history, filterable by kind, job id and status. |
| `cpu_profile` | Samples the answering replica's CPU for 1–30 seconds and summarizes where the time went. |

None of them restarts, kills, pauses, busts a cache, writes configuration or takes a heap snapshot.

### Tool annotations

Every tool carries MCP annotations so a client can decide when to ask the person first: reads are `readOnlyHint: true`; writes (`create_item`, `update_item`, `transition`, `create_task`, `complete_task`, `add_comment`, `mark_notifications_read`, and `cpu_profile`, which runs work on the server) are `readOnlyHint: false`; only `delete_item` is `destructiveHint: true`. All are `openWorldHint: false` — they talk only to the configured instance.

## Resources

| URI | Content |
| --- | --- |
| `nivaro://collections` | The collection list (same shape as `list_collections`). |
| `nivaro://collection/<name>` | One collection's schema (same shape as `describe_collection`); the template lists every readable collection. |

## Programmatic use

```ts
import { createNivaroMcpServer } from '@nivaro/mcp'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const { server } = createNivaroMcpServer({ url: process.env.NIVARO_URL!, token: process.env.NIVARO_TOKEN! })
await server.connect(new StdioServerTransport())
```

`createNivaroMcpServer` also accepts a prebuilt `@nivaro/sdk` client (`client`), a custom `fetch`, and `adminTools: true` to register the admin tools (`ADMIN_TOOL_NAMES`; `TOOL_NAMES` lists the rest). `keyIsAdmin(client)` answers whether a key's user is an administrator, and `createNivaroMcpClient({ url, token })` builds the client the server uses. The package's own tests drive every tool through a real in-process MCP client against a mocked API.

## Follow-ups

The instance's ask-your-data assistant runs a set of internal tools (`query_items`, `aggregate`, `semantic_search`, `record_event_path`, `explain_access`, `record_integrity`, `run_custom_query`, `my_tasks`, `propose_action`). The API exposes them only through the conversational `POST /api/ai/chat` endpoint, which `ask_data` wraps — there is no per-tool route yet, so they are not individual MCP tools. Adding a `/ai/tools/:name` endpoint on the API would let this package expose each one directly.

## License

MIT
