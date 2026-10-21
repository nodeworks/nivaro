import type { DocSection } from '../types.js'

export const extAssistantTools: DocSection = {
  id: 'ext-assistant-tools',
  label: 'Assistant Tools & Message Actions',
  content: [
    { type: 'h1', id: 'ext-assistant-tools', text: 'Assistant tools and message actions' },
    {
      type: 'p',
      text: 'An extension can give assistants its own tools: `ctx.mcp.registerTool` adds a tool MCP clients (Claude, ChatGPT, Codex) can call, and `ctx.ai.registerTool` adds one Ask AI may call while it answers. Both take the same declaration, so one definition can serve both. Every handler runs as the person calling — read data with `tools.readItems`, never raw SQL — and a disabled extension’s tools disappear from every assistant.'
    },
    {
      type: 'pre',
      code: `const openDeals = {
  name: 'open_deals',                       // 3–48 lower-case letters, digits, _
  description: 'Open deals for an owner. Use when someone asks what is still open.',
  input_schema: {
    type: 'object',
    properties: { owner: { type: 'string', description: 'User id' } },
    required: ['owner']
  },
  read_only: true,
  async handler(caller, input, tools) {
    const { data } = await tools.readItems('deals', {
      filter: { owner: { _eq: input.owner }, status: { _neq: 'won' } },
      fields: ['id', 'title', 'amount', 'vendor'],
      limit: 50
    })
    const labels = await tools.linkLabels(data.map((d) => ({ collection: 'vendors', id: d.vendor })))
    return { rows: data.map((d) => ({ ...d, vendor_name: labels[\`vendors:\${d.vendor}\`] ?? null })) }
  }
}
ctx.mcp?.registerTool(openDeals)
ctx.ai?.registerTool({ ...openDeals, replayable: true })

// The positional spelling works too:
ctx.mcp?.registerTool('ping_crm', { type: 'object', properties: {} }, async () => ({ ok: true }), {
  description: 'Check the CRM link is up.'
})`
    },
    { type: 'h2', id: 'ext-assistant-tools-rules', text: 'Rules' },
    {
      type: 'ul',
      items: [
        'A bad declaration (name, missing description or handler, a schema that is not an object) is logged and skipped — `registerTool` returns false and never throws.',
        'A name a built-in tool already uses is never offered; two extensions cannot share a name.',
        '`tools.assertFieldsReadable(collection, fields)` refuses a field the caller cannot read (dotted paths are walked link by link). For Ask AI tools, `field_lists: [{ fields_key, collection_key }]` makes the core run that check on the input before your handler.',
        '`tools.linkLabels(refs)` labels linked records as the caller; a record they cannot read keeps no label.',
        '`tools.api_key_scopes` holds the collection scopes of the API key the caller is using (null when nothing narrows them). `readItems` already honours them; a handler that reaches data any other way — an external API, a flow, raw SQL — must refuse what the scopes do not cover.',
        'An Ask AI answer that used an extension tool stays the asker’s, unless the tool is `read_only` and declared `replayable` — then a shared answer is re-run as each reader and shown only when their result matches.',
        'A call is cut off after 30 seconds. Calls and failures since start show on AI Quality → Extension tools and on Assistant Tools.'
      ]
    },
    { type: 'h2', id: 'ext-message-actions', text: 'Chat message actions' },
    {
      type: 'p',
      text: '`ctx.chat.registerMessageAction` adds an item to a message’s ⋯ menu. `when` limits it to room kinds (`general`, `channel`, `entity`, `dm`), record-room prefixes, messages with text or attachments, your own messages, or text matching a pattern. The handler runs as the person clicking, in a room they can see; text it returns as `post` is sent through the normal send path (as a thread reply with `in_thread`), `reply` is a private line, and `open_url` opens a link or an app path.'
    },
    {
      type: 'pre',
      code: `ctx.chat.registerMessageAction?.({
  id: 'log-to-record',
  label: 'Log to record',
  description: 'Copy this message into the record’s call log',
  when: { room_kinds: ['entity'], has_text: true },
  async handler(message, { userId, room }) {
    // … write through the items service as userId …
    return { reply: 'Logged.' }
  }
})`
    }
  ]
}
