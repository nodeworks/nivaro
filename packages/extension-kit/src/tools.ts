import type { ExtensionUser } from './user.js'

/**
 * Tools an extension hands to assistants (#2465 MCP, #2735 Ask AI) and the
 * actions it adds to a chat message's menu (#2763).
 *
 * One declaration can serve both assistants: pass the same `ExtensionToolDef`
 * to `ctx.mcp.registerTool` and `ctx.ai.registerTool`. Every handler runs AS
 * the person calling — the MCP client's user, the person asking Ask AI —
 * so read data through `tools.readItems`, never raw SQL, and a record they
 * cannot read is a record that is not there.
 */

/** A JSON Schema object describing a tool's input: `{type: 'object', properties, required}`. */
export type ToolInputSchema = Record<string, unknown>

/** What a tool handler is handed beside the caller and the input. */
export interface ExtensionToolHelpers {
  /** Read records AS the caller through the items service (permissions, row
   *  rules and user scopes apply). Resolves `{ data, total? }`. */
  readItems(
    collection: string,
    query?: {
      fields?: string[]
      filter?: Record<string, unknown>
      sort?: string[]
      limit?: number
      search?: string
    }
  ): Promise<{ data: Array<Record<string, unknown>>; total?: number }>
  /** Throws when the caller may not read one of these fields of the
   *  collection (dotted paths are walked link by link). Call it before a
   *  tool reads, filters or groups on fields named in its input. */
  assertFieldsReadable(collection: string, fields: string[]): Promise<void>
  /** Labels for linked records, read AS the caller: `{'vendors:12': 'ACME'}`.
   *  A record they cannot read keeps no label. Never throws. */
  linkLabels(
    refs: Array<{ collection: string; id: string | number }>
  ): Promise<Record<string, string>>
}

export type ExtensionToolHandler = (
  caller: ExtensionUser,
  input: Record<string, unknown>,
  tools: ExtensionToolHelpers
) => Promise<unknown> | unknown

/**
 * A field list in the tool's input the core checks before the handler runs:
 * `fields_key` names the input property holding a field name or a list of
 * them, and the collection comes from `collection` (a literal name) or the
 * input property `collection_key`. A field the caller cannot read refuses the
 * call with a plain message.
 */
export interface ToolFieldList {
  fields_key: string
  collection?: string
  collection_key?: string
}

export interface ExtensionToolDef {
  /** Lower-case letters, digits and underscores, 3–48 characters. Must not
   *  reuse a built-in tool's name; two extensions never share one. */
  name: string
  /** What it does and when to use it — the assistant reads this. */
  description: string
  /** A short human title (MCP clients show it). Defaults to the name. */
  title?: string
  input_schema: ToolInputSchema
  /** The tool only reads: it never writes, sends, notifies or logs. */
  read_only?: boolean
  /** Ask AI only: field lists in the input the core checks first. */
  field_lists?: ToolFieldList[]
  handler: ExtensionToolHandler
}

export interface ExtensionToolOptions {
  description?: string
  title?: string
  read_only?: boolean
  field_lists?: ToolFieldList[]
}

export interface ExtensionAiToolOptions extends ExtensionToolOptions {
  /**
   * May an answer that used this tool be shown to people the asker shares a
   * conversation with? Only when it is also `read_only`: a shared answer is
   * re-run as each reader and shown only when their result matches. Default
   * false — the answer stays the asker's.
   */
  replayable?: boolean
}

/** `ctx.mcp` — tools the hosted MCP endpoint lists and the npm server reaches
 *  through its `call_instance_tool` proxy. */
export interface ExtensionMcpMembers {
  registerTool(def: ExtensionToolDef): boolean
  registerTool(
    name: string,
    inputSchema: ToolInputSchema,
    handler: ExtensionToolHandler,
    opts?: ExtensionToolOptions
  ): boolean
}

/** `ctx.ai` — tools Ask AI may call while answering. */
export interface ExtensionAiMembers {
  registerTool(def: ExtensionToolDef & { replayable?: boolean }): boolean
  registerTool(
    name: string,
    inputSchema: ToolInputSchema,
    handler: ExtensionToolHandler,
    opts?: ExtensionAiToolOptions
  ): boolean
}

// ─── Chat message actions (#2763) ───────────────────────────────────────────

/** Which messages an action is offered on. Every key narrows; none = all. */
export interface ChatMessageActionWhen {
  /** Room kinds: 'general', 'channel', 'entity' (record rooms), 'dm'. */
  room_kinds?: Array<'general' | 'channel' | 'entity' | 'dm'>
  /** Record-room prefixes (e.g. 'REQ'); implies room kind 'entity'. */
  room_prefixes?: string[]
  /** Only messages with text. */
  has_text?: boolean
  /** Only messages with an attachment. */
  has_attachments?: boolean
  /** Only the clicker's own messages. */
  own_messages?: boolean
  /** A regular expression the message text must match (case-insensitive). */
  text_pattern?: string
}

/** The message an action runs on — what the clicker can already see. */
export interface ChatActionMessage {
  id: number
  room: string
  message: string
  sender: string | null
  sender_name: string | null
  parent_id: number | null
  attachments: string[]
  date_created: string
}

export interface ChatMessageActionResult {
  /** Text to post into the room AS the clicker (a thread reply under the
   *  message when `in_thread`). Goes through the normal send path. */
  post?: string
  in_thread?: boolean
  /** A private line shown only to the clicker. */
  reply?: string
  /** A link to open for the clicker (http(s) or an app path). */
  open_url?: string
}

export interface ChatMessageActionDef {
  /** Lower-case letters, digits and dashes; unique within the extension. */
  id: string
  /** The menu item's text ('Log to record'). */
  label: string
  /** One line under the label, optional. */
  description?: string
  when?: ChatMessageActionWhen
  handler(
    message: ChatActionMessage,
    ctx: { userId: string; room: string }
  ): Promise<ChatMessageActionResult | void> | ChatMessageActionResult | void
}
