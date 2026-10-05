# @nivaro/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Nivaro CMS](https://nivaro.dev). It wraps the typed `@nivaro/sdk` so Claude Code, Claude Desktop, Cursor and any other MCP client can read and write a Nivaro instance directly — collection schemas, records, aggregates, pipeline state and transitions, and the instance's own ask-your-data assistant.

Every tool calls the instance's REST API as the user behind the configured API key. Role permissions, row-level security, user scopes, validation and change-reason rules apply exactly as they do to any other API caller. Nothing is cached or reimplemented on the server side; the API decides.

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

`createNivaroMcpServer` also accepts a prebuilt `@nivaro/sdk` client (`client`) and a custom `fetch`, which is how the package's own tests drive every tool through a real in-process MCP client against a mocked API.

## Follow-ups

The instance's ask-your-data assistant runs a set of internal tools (`query_items`, `aggregate`, `semantic_search`, `record_event_path`, `explain_access`, `record_integrity`, `run_custom_query`, `my_tasks`, `propose_action`). The API exposes them only through the conversational `POST /api/ai/chat` endpoint, which `ask_data` wraps — there is no per-tool route yet, so they are not individual MCP tools. Adding a `/ai/tools/:name` endpoint on the API would let this package expose each one directly.

## License

MIT
