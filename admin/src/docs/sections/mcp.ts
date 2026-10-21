import type { DocSection } from '../types.js'

export const mcpDocs: DocSection = {
  id: 'mcp',
  label: 'AI Assistants (MCP)',
  content: [
    { type: 'h1', id: 'mcp', text: 'Connect an AI assistant (MCP)' },
    {
      type: 'p',
      text: 'Nivaro speaks the Model Context Protocol, so ChatGPT, Claude (claude.ai, Claude Desktop, Claude Code), Codex and Cursor can read and work with your data in a conversation: look up records and their history, run your custom queries, check My Work and queues, comment, create tasks and move records through their pipeline. The assistant always acts as **you** — your role, row rules and User Scopes apply exactly as in the app, and everything it changes is recorded as your change.'
    },
    {
      type: 'p',
      text: 'There are two ways in. The **hosted endpoint** `https://<your-nivaro>/api/mcp` needs nothing installed: the assistant signs you in through Nivaro (OAuth) or sends an API key. The **npm server** `@nivaro/mcp` runs on your own machine over stdio with an API key — useful for desktop tools when you prefer a key to a sign-in.'
    },
    {
      type: 'note',
      text: 'ChatGPT and claude.ai connect from their own cloud, so they can only reach a Nivaro that is reachable from the internet. An instance on a private network works with the tools that run on your machine — Claude Code, Claude Desktop (npm server), Codex and Cursor — while you are on that network.'
    },
    { type: 'h2', id: 'mcp-chatgpt', text: 'ChatGPT' },
    {
      type: 'ul',
      items: [
        'Settings → Apps & Connectors → Advanced settings → turn on **Developer mode** (your workspace admin may need to allow it).',
        'Create a connector: name it Nivaro, set the MCP server URL to `https://<your-nivaro>/api/mcp`, authentication **OAuth**.',
        'ChatGPT opens Nivaro’s sign-in, then a consent page naming ChatGPT. **Allow** connects it. ChatGPT asks before running tools that change data — Nivaro marks every tool as read-only or not, and deletes as destructive.'
      ]
    },
    { type: 'h2', id: 'mcp-claude', text: 'Claude (claude.ai and Claude Desktop)' },
    {
      type: 'ul',
      items: [
        'Settings → Connectors → **Add custom connector** → URL `https://<your-nivaro>/api/mcp`. Claude signs you in through Nivaro the same way.',
        'Claude Desktop on a private network: use the npm server instead — add it to `claude_desktop_config.json` (see below) with an API key.'
      ]
    },
    { type: 'h2', id: 'mcp-claude-code', text: 'Claude Code' },
    {
      type: 'pre',
      code: '# sign in through Nivaro (run /mcp in Claude Code to finish the sign-in)\nclaude mcp add --transport http nivaro https://<your-nivaro>/api/mcp\n\n# or with an API key\nclaude mcp add --transport http nivaro https://<your-nivaro>/api/mcp \\\n  --header "Authorization: Bearer nvk_your_key"'
    },
    { type: 'h2', id: 'mcp-codex', text: 'Codex' },
    {
      type: 'pre',
      code: '# sign in through Nivaro\ncodex mcp add nivaro --url https://<your-nivaro>/api/mcp\ncodex mcp login nivaro\n\n# or ~/.codex/config.toml with an API key in the environment\n[mcp_servers.nivaro]\nurl = "https://<your-nivaro>/api/mcp"\nbearer_token_env_var = "NIVARO_TOKEN"'
    },
    { type: 'h2', id: 'mcp-npm', text: 'The npm server (stdio)' },
    {
      type: 'p',
      text: 'For any client that launches local servers (Claude Desktop, Cursor, Codex, Claude Code). It needs `NIVARO_URL` (the API origin, no `/api`) and `NIVARO_TOKEN` (an `nvk_` API key from API Keys, or a static token).'
    },
    {
      type: 'pre',
      code: '{\n  "mcpServers": {\n    "nivaro": {\n      "command": "npx",\n      "args": ["-y", "@nivaro/mcp"],\n      "env": { "NIVARO_URL": "https://<your-nivaro>", "NIVARO_TOKEN": "nvk_your_key" }\n    }\n  }\n}'
    },
    { type: 'h2', id: 'mcp-what', text: 'What an assistant can do' },
    {
      type: 'ul',
      items: [
        'Learn the data model (collections, fields, relations) and read, filter and total records.',
        'Create, update and delete records — creates rehearse first unless told to store, deletes need an explicit confirm — and move records through their pipeline.',
        'Work with My Work, queues, comments and mentions, tasks, revision history, custom queries, notifications, files (details only, never contents) and search.',
        'Ask Nivaro’s own data assistant (Ask AI) a question.',
        'Administrators also get read-only operations tools: health and readiness, runtime and database pool, Traffic Map summary, scheduled jobs and their runs, and a CPU profile of the API. Nothing restarts, pauses or reconfigures anything.',
        'Administrators also get layout tools: describe_layout (a form in plain terms, or every form of a collection), which_form (which form a record gets for a role, and why), explain_field (why a field shows, hides or is read-only for a role on a record) and propose_layout_ops. A proposal never changes a form: it waits under Proposals in the layout editor until an administrator tries it on the canvas and keeps it, or rejects it.'
      ]
    },
    { type: 'h2', id: 'mcp-instance-tools', text: 'This instance’s own tools' },
    {
      type: 'p',
      text: 'Beyond the built-in set, an instance can offer tools of its own, managed on **Developer → Assistant Tools** (`/mcp-tools`). An administrator can expose a saved query or a flow as a named tool: the query’s parameters (or the inputs you list, for a flow) become the tool’s input, and it runs as the person calling — the query’s own access level and user scopes decide what comes back, and a flow runs with the caller as the person who triggered it. Choose who may call it (administrators, or everyone signed in) and whether it only reads. Extensions add tools with `ctx.mcp.registerTool`; they are listed on the same page.'
    },
    {
      type: 'p',
      text: 'The hosted endpoint lists each of these tools by name. The npm server reaches the same tools through `list_instance_tools` and `call_instance_tool`. Both call `GET /api/mcp-tools` and `POST /api/mcp-tools/:name/call` as the key’s user; named tools are stored in `nivaro_settings.mcp_tools` (migration 473).'
    },
    { type: 'h2', id: 'mcp-keys', text: 'Sign-in or API key' },
    {
      type: 'p',
      text: 'Signing in (OAuth) connects the assistant as you, with your permissions, and needs nothing stored on your machine; access tokens last an hour and renew themselves for 30 days of use. An API key gives you finer control: a key with **narrowed scopes** is held to them, a key with **row restrictions** sees only those rows, and a **sandbox** key can explore everything and never changes anything — a safe way to try an assistant out.'
    },
    { type: 'h2', id: 'mcp-connections', text: 'Connected apps' },
    {
      type: 'p',
      text: 'Every assistant you allowed is a connection: `GET /api/oauth/connections` lists them (name, when you connected, when it was last used) and `DELETE /api/oauth/connections/:id` disconnects one — its tokens stop working at once. Connecting and disconnecting are logged in Activity (`oauth-connect`, `oauth-revoke`). Suspending an account ends its connections too: every request checks the account is still active.'
    },
    { type: 'h2', id: 'mcp-settings', text: 'Settings and how it works' },
    {
      type: 'ul',
      items: [
        '`MCP_HTTP=off` turns the hosted endpoint off (the npm server keeps working with a key); `MCP_OAUTH=off` turns sign-in off and leaves API keys working on `/api/mcp`.',
        '`MCP_PUBLIC_URL` names the address assistants reach this API on, when it is not the API’s own host — the sign-in must start and end there, and that address must be registered with your identity provider.',
        'Discovery: `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`. Clients register themselves (`/oauth/register`, public clients only), must use PKCE (S256), and may only return to https addresses or to `localhost` on your machine.',
        'Each `/api/mcp` request is answered on its own (no server-side session), so any API replica can serve it, and every tool call inside it is an ordinary API request — rate limits, the maintenance freeze and the request log apply to each call. Traffic Map counts connected assistants with people.'
      ]
    }
  ]
}
