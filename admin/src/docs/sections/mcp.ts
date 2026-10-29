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
        'Work the support desk: list and read support requests, claim one, reply and change its status. You see your own requests; desk members and administrators see the desk, exactly as in Support. Claim, reply and status changes rehearse first unless told to go ahead.',
        'See the approval steps waiting on you and approve or reject one with a note. The approval chain rules apply as in the app, and a decision rehearses first unless told to go ahead.',
        'Look up the SLA clock and the at-risk reasons for one record or a list of records. Records you cannot open are left out.',
        'Administrators can also ask why a person cannot see a record (explain_access): which gate hid it, with reasons only and no record values.',
        'Read dashboards and reports: `list_dashboards` lists the dashboards and Report Studio reports you can open, `read_dashboard` gives a dashboard’s widget figures and `run_report` a report’s. Every figure is computed as you, the same way the widget computes it for you in the app — a widget you cannot see says so instead of showing a number. The saved filter bar and date range apply unless the assistant asks for others.',
        'Chat, only when you allowed it: `list_chat_rooms`, `read_chat_messages` and `post_chat_message` reach only the rooms you can open. Posting rehearses first unless told to post, goes out as you, and every message shows **via app ·** and the app’s name beside it.',
        'Administrators also get read-only operations tools: health and readiness, runtime and database pool, Traffic Map summary, scheduled jobs and their runs, and a CPU profile of the API. Nothing restarts, pauses or reconfigures anything.',
        'Attach a file to a record (`attach_file`): the file is sent base64-encoded (at most 10 MB, or the instance’s smaller upload limit), checked like any upload and linked through the record’s own file field as you — you must be able to change that record and that field, and the file then opens for whoever can open the record. A single-file field that already holds a file is kept unless the assistant says `replace` (the earlier file stays in the record’s history); a multi-file field gains the file. The same is `POST /api/files/attach` {collection, item, field?, filename, content_base64, type?, replace?}.',
        'Propose a data model change (`propose_schema_change`): add a field (with its label, help note, dropdown choices, required), change a field’s label, note, choices or required flag, or add a collection with its fields. Nothing changes — see Schema proposals below.',
        'Administrators also get layout tools: describe_layout (a form in plain terms, or every form of a collection), which_form (which form a record gets for a role, and why), explain_field (why a field shows, hides or is read-only for a role on a record) and propose_layout_ops. A proposal never changes a form: it waits under Proposals in the layout editor until an administrator tries it on the canvas and keeps it, or rejects it.'
      ]
    },
    { type: 'h2', id: 'mcp-instance-tools', text: 'This instance’s own tools' },
    {
      type: 'p',
      text: 'Beyond the built-in set, an instance can offer tools of its own, managed on **Developer → MCP → Assistant tools** (`/mcp/tools`). An administrator can expose a saved query or a flow as a named tool: the query’s parameters (or the inputs you list, for a flow) become the tool’s input, and it runs as the person calling — the query’s own access level and user scopes decide what comes back, and a flow runs with the caller as the person who triggered it. Choose who may call it (administrators, or everyone signed in) and whether it only reads. An API key limited to named collections never gets flow tools (a flow runs as the person and would reach past the key’s collections), and an administrator on such a key is not treated as an administrator here. Extensions add tools with `ctx.mcp.registerTool`; they are listed on the same page.'
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
    { type: 'h2', id: 'mcp-chat', text: 'Chat needs its own permission' },
    {
      type: 'p',
      text: 'Chat is never part of a connection by default. When you sign in, the consent page has a box **Also let it read and post in your chat conversations** — ticked only if the app asked for chat, and yours to untick. Without it the connection gets no chat tools, is refused on every chat route, and sees chat notifications only as "a chat message", never their words. Connecting again with a different choice changes the existing connection at once. For an API key, an administrator sets **Chat for AI assistants** on the key (Off, Read, or Read and post); `*` scopes never include chat. Every chat message posted with an API key or a connected app — through MCP or not — shows **via app ·** and the key’s or app’s name (cleaned, at most 60 characters; a connected app chose its own name, so it is always shown as app text, never as a person), and its Activity entry names the OAuth client id or API key id.'
    },
    { type: 'h2', id: 'mcp-connections', text: 'Connected apps' },
    {
      type: 'p',
      text: 'Every assistant you allowed is a connection: `GET /api/oauth/connections` lists them (name, when you connected, when it was last used, and whether it may use chat) and `DELETE /api/oauth/connections/:id` disconnects one — its tokens stop working at once. Connecting and disconnecting are logged in Activity (`oauth-connect`, `oauth-revoke`). Suspending an account ends its connections too: every request checks the account is still active.'
    },
    { type: 'h2', id: 'mcp-live', text: 'Live record updates' },
    {
      type: 'p',
      text: 'Connect to `/api/mcp?live=1` instead of `/api/mcp` and the assistant can follow records. Every record is a resource, `nivaro://record/<collection>/<id>`; reading it reads the record as you. Subscribing to one tells the assistant when it changes: Nivaro sends `notifications/resources/updated` with the record’s address and the names of the fields that changed (`_meta`), never their values. The assistant reads the record again to see the new values, with your permissions.'
    },
    {
      type: 'ul',
      items: [
        'A live connection gets a session id on its first answer and listens on `GET /api/mcp` (an event stream). `DELETE /api/mcp` ends the session.',
        'You can only follow a record you can read, at most 50 at a time per connection. Access is checked again every two minutes: a record you can no longer read is dropped, with one last notice.',
        'Sessions last 24 hours after the last use. The event stream closes when your sign-in ends; the assistant reconnects with its renewed sign-in and keeps its subscriptions.',
        'A plain `/api/mcp` connection works exactly as before, with no session.'
      ]
    },
    { type: 'h2', id: 'mcp-console', text: 'MCP console' },
    {
      type: 'p',
      text: 'Developer → MCP → Console (`/mcp/console`, administrators) lists the tools an assistant connected as you would get, with a form built from each tool’s inputs (or JSON, for the raw arguments). Running a tool goes through the same MCP server the endpoint uses, as you, and shows the result as the assistant sees it, the raw JSON answer, how long it took, how large it is, and every API call the tool made.'
    },
    {
      type: 'p',
      text: 'Tools that change data start in **dry run**. A tool that can rehearse (create_item) rehearses: rules and validation run and nothing is stored. Any other tool runs but its changes are held: the console does not send them and lists each one under API calls. Turn dry run off and confirm to run it for real.'
    },
    {
      type: 'p',
      text: 'Your profile has a **What my agents did** tab (`/profile?tab=agents`). It lists each connected app with its last 14 days of tool calls (calls a day, refused and failed calls, the tools it used most, how much it read back) and a Disconnect button, then every tool call newest first: the app, the tool, the record it touched and how it ended. Open a call to see the changes it made. Each change can be undone while nothing else has changed the record since: an edit puts back the values from before, a new record is deleted. Undo runs as you, so your permissions and the record’s rules apply, and it is logged (`mcp-undo`).'
    },
    { type: 'h2', id: 'mcp-badge', text: 'The “via assistant” badge' },
    {
      type: 'p',
      text: 'Every edit and comment an assistant makes through the hosted endpoint carries a small badge beside the person’s name — in the record’s History, its comments and the Activity log, in the admin and in apps built on the shared components. By default it names the app (**via Claude**, **via Claude Code**: the name the app registered with, or the API key’s name); an administrator can switch it to one fixed label for every assistant (default **via assistant**) on **MCP → Connections**. The label is worked out when the record is read, so changing the setting relabels earlier changes too. The app’s name and the connection are stored on the Activity row (`nivaro_activity.via_app`, `mcp_conn`, migration 512) from server-known facts only — never from a header the app sends. Writes a person makes themselves, scripts using an API key directly, imports and scheduled jobs carry no badge.'
    },
    { type: 'h2', id: 'mcp-rollback', text: 'Roll back a connection’s changes' },
    {
      type: 'p',
      text: '**Roll back…** on a connection (your **What my agents did** tab for your own, **MCP → Connections** for administrators) undoes everything that connection wrote in a time window — the last hour, day, week, two weeks, or between two times (at most 90 days). First comes a preview: per record, what would happen — delete a record it created, put back the fields it changed (their names, never values) to how they were before its first change in the window, bring back a record it deleted (from the trash, while it is there), or remove a comment it posted. Records someone else changed since, or the same app changed again after the window, are **left alone** and listed with who changed them and when. Configuration changes are counted but never rolled back here.'
    },
    {
      type: 'p',
      text: 'Applying runs every step through the items service **as the person the connection acts for** — their permissions, validation and rules apply, and every step gets its own history entry — newest change first, and logs one `mcp-rollback` Activity row with the counts. If anything changed between the preview and Apply, nothing runs and the new preview is shown (409). When the person can no longer sign in, an administrator’s rollback runs as the administrator and says so. Only a person signed in to Nivaro can apply a rollback: an API key or a connected app cannot roll back (or protect) its own writes. Routes: `POST /api/mcp-connections/mine/:conn/rollback/preview` and `…/rollback` (your own), `POST /api/mcp-connections/:conn/rollback/preview` and `…/rollback` (administrators), each with `{from, to?}` and, to apply, the preview’s `plan_hash`.'
    },
    { type: 'h2', id: 'mcp-schema-proposals', text: 'Schema proposals' },
    {
      type: 'p',
      text: 'An assistant (or anyone signed in, through `POST /api/schema-proposals` {changes, note?}) can draft field and collection changes; it never changes the data model. Proposals wait on the **Data Model** page under **Proposals** (a count shows when some are waiting; `?proposals=1` opens them), each read in plain words with who proposed it, through which app and why. **Apply…** carries it out as you through the Data Model’s own steps — create the table or column, register it, set its label, choices and help note — so it is exactly what doing it by hand would do; a step that fails stops the run, the proposal stays open with what was done, and applying again skips what already exists. **Reject…** closes it with an optional note.'
    },
    {
      type: 'ul',
      items: [
        'Kinds: `add_field` {collection, field, type, label?, note?, choices?, required?, max_length?}, `update_field` {collection, field, label?, note?, choices?, required?} (choices replace the whole list) and `add_collection` {collection, display_name?, singular?, plural?, icon?, note?, fields?}. Types: string, text, integer, bigInteger, boolean, decimal, float, date, datetime, uuid. New columns are always nullable; required is the form’s rule.',
        'Renames, type changes, deletions, relations and system tables are never proposals — they stay a person’s job in the Data Model.',
        'Checked when proposed: a field that already exists, an unknown collection or an unregistered field is refused with the change’s number. People who are not administrators may only name collections they can read. At most 50 changes per proposal and 20 open proposals per person; unresolved proposals expire after 30 days.',
        'Apply and Reject need an administrator signed in to the admin — an API key, a connected app or the MCP endpoint is refused, so an assistant can never apply its own proposal. Stored in `nivaro_ai_proposals` (action type `schema_change`); proposing, applying and rejecting are logged (`schema-proposal`, `schema-proposal-apply`, `schema-proposal-reject`).'
      ]
    },
    { type: 'h2', id: 'mcp-admin', text: 'For administrators' },
    {
      type: 'ul',
      items: [
        '**MCP → Connections** (`/mcp`) lists every assistant connected to this instance across people, with the same 14-day figures, and lets you disconnect a sign-in or switch off a key.',
        'Each connection may make a set number of tool calls a minute (default 120; 0 means no limit), and you can give one connection its own limit. Over the limit the assistant gets HTTP 429 with Retry-After and a message saying why, so it can tell its person and wait.',
        'Idle review: a signed-in connection unused for 60 days is pointed out to its owner, the owner is warned seven days before 90 days, and at 90 days it is disconnected (job `mcp-idle-review`, daily on deployed instances). Both day counts are settings at the top of the page; the Idle tab shows what the next run will do.',
        'On the Traffic Map each app is its own caller, named `MCP: <app>` — the name the app registered with, or the API key’s name — grouped under AI assistants.',
        'Every request made through `/api/mcp` is marked in the request log with its connection and tool, which is where all of these figures come from; the log keeps 14 days.'
      ]
    },
    { type: 'h2', id: 'mcp-settings', text: 'Settings and how it works' },
    {
      type: 'ul',
      items: [
        '`MCP_HTTP=off` turns the hosted endpoint off (the npm server keeps working with a key); `MCP_OAUTH=off` turns sign-in off and leaves API keys working on `/api/mcp`.',
        '`MCP_SESSIONS=off` turns live sessions off: `?live=1` is ignored and every connection is answered without a session.',
        '`MCP_PUBLIC_URL` names the address assistants reach this API on, when it is not the API’s own host — the sign-in must start and end there, and that address must be registered with your identity provider.',
        'Discovery: `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`. Clients register themselves (`/oauth/register`, public clients only), must use PKCE (S256), and may only return to https addresses or to `localhost` on your machine.',
        'The npm server asks `GET /api/mcp/capabilities` at startup which optional tools the key gets (`admin_tools`, `chat`: none, read or post).',
        'Each `/api/mcp` request is answered on its own (a live session only remembers its subscriptions, in Redis), so any API replica can serve it, and every tool call inside it is an ordinary API request — rate limits, the maintenance freeze and the request log apply to each call.'
      ]
    }
  ]
}
