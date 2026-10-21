/**
 * Chat tools (#2492): the rooms the key's user is in, recent messages and
 * posting. Registered only for a connection allowed chat — an OAuth connection
 * whose person ticked chat on the consent page, or an API key with a `$chat`
 * scope — and posting only when that allowance includes it.
 *
 * Every read and the post go through the chat API, so canSeeRoom decides what
 * is visible exactly as it does in the app; a post goes through the one send
 * path and carries the connected app's name (`via_app`).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  type ChatMessage,
  listChatMessages,
  listChatRooms,
  type NivaroClient,
  sendChatMessage
} from '@nivaro/sdk'
import { z } from 'zod'
import { READ, WRITE } from '../annotations.js'
import { clip, pageOf } from '../compact.js'
import { fail, ok, refuse } from '../result.js'
import { clampTo, uuid } from '../schema.js'

type Row = Record<string, unknown>

export type ChatAccess = 'none' | 'read' | 'post'

// Room keys ride in a query string and a body, never a path; this keeps them to
// the characters a key holds (global, dm:<a>:<b>, ch:<key>, <prefix>:<token>).
const roomKey = z
  .string()
  .regex(/^[A-Za-z0-9_.:@-]{1,200}$/, 'A room key from list_chat_rooms')
  .describe('The room key from list_chat_rooms, e.g. "global", "ch:ops" or "dm:<id>:<id>".')

/** One message, as a model needs it. */
export function summarizeMessage(m: ChatMessage & Row): Row {
  const deleted = !!m.deleted_at
  const out: Row = {
    id: m.id,
    sender: m.sender_name ?? (m.is_system ? 'Nivaro' : null),
    at: m.date_created,
    text: deleted ? null : clip(m.message, 2000)
  }
  if (m.via_app) out.via_app = m.via_app
  if (deleted) out.deleted = true
  if (m.edited_at && !deleted) out.edited = true
  if (m.parent_id) out.thread_id = m.parent_id
  const thread = m.thread as { count?: number } | null | undefined
  if (thread?.count) out.replies = thread.count
  if (m.urgent) out.urgent = true
  if (m.is_system) out.system = true
  const files = Array.isArray(m.attachments) ? m.attachments.length : 0
  if (files) out.attachments = files
  const reactions = Array.isArray(m.reactions) ? m.reactions : []
  if (reactions.length) {
    const counts = new Map<string, number>()
    for (const r of reactions) counts.set(r.emoji, (counts.get(r.emoji) ?? 0) + 1)
    out.reactions = [...counts].map(([emoji, count]) => ({ emoji, count }))
  }
  const quote = m.quote as { sender_name?: string | null; message?: string } | null | undefined
  if (quote) out.quotes = { sender: quote.sender_name ?? null, text: clip(quote.message, 200) }
  return out
}

export function registerChatTools(server: McpServer, client: NivaroClient, access: ChatAccess) {
  if (access === 'none') return

  server.registerTool(
    'list_chat_rooms',
    {
      title: 'List my chat rooms',
      description:
        "The chat rooms the key's user is in — General, channels, direct messages and record rooms — with unread counts and the latest message. read_chat_messages opens one.",
      inputSchema: {
        search: z.string().optional().describe('Case-insensitive match on the room name.'),
        unread_only: z.boolean().optional().describe('Only rooms with unread messages.'),
        limit: z.number().int().optional().describe('Rooms per page (1–100, default 25).'),
        offset: z.number().int().min(0).optional()
      },
      annotations: READ
    },
    async ({ search, unread_only, limit, offset }) => {
      try {
        const res = await client.request(listChatRooms())
        const needle = search?.trim().toLowerCase()
        const rooms = res.data.filter(
          (r) =>
            (!needle || `${r.label ?? ''} ${r.room}`.toLowerCase().includes(needle)) &&
            (!unread_only || r.unread > 0)
        )
        const page = pageOf(rooms, clampTo(limit, 25, 100), offset)
        return ok({
          rooms: page.items.map((r) => {
            const out: Row = { room: r.room, kind: r.kind, name: r.label ?? r.room }
            if (r.unread) out.unread = r.unread
            if (r.muted) out.muted = true
            if (r.channel?.topic) out.topic = clip(r.channel.topic, 200)
            if (r.last_message)
              out.last_message = {
                id: r.last_message.id,
                sender: r.last_message.sender_name,
                at: r.last_message.date_created,
                text: clip(r.last_message.message, 160)
              }
            return out
          }),
          total: page.total,
          offset: page.offset,
          truncated: page.truncated
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'read_chat_messages',
    {
      title: 'Read chat messages',
      description:
        "Recent messages in one room the key's user can open, oldest first. Pass before (a message id) for older ones, or thread_id for a thread's replies. Reading does not mark anything read.",
      inputSchema: {
        room: roomKey,
        thread_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("A message id with replies: its thread instead of the room's timeline."),
        before: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Only messages older than this id (from next_before).'),
        limit: z.number().int().optional().describe('Messages (1–100, default 30).')
      },
      annotations: READ
    },
    async ({ room, thread_id, before, limit }) => {
      try {
        const res = await client.request(
          listChatMessages(room, { limit: clampTo(limit, 30, 100), before, thread: thread_id })
        )
        const messages = res.data.map((m) => summarizeMessage(m as ChatMessage & Row))
        const out: Row = { room, messages }
        if (thread_id) out.thread_id = thread_id
        if (res.meta?.has_older && res.data.length > 0) {
          out.has_older = true
          out.next_before = res.data[0]?.id
        }
        return ok(out)
      } catch (err) {
        return fail(err)
      }
    }
  )

  if (access !== 'post') return

  server.registerTool(
    'post_chat_message',
    {
      title: 'Post a chat message',
      description:
        "Post a message in a room the key's user can open, as that person; it is labelled with this app's name. Rehearses by default — checks the room and shows what would be posted; pass dry_run: false to post. Mention people by user id (find_people).",
      inputSchema: {
        room: roomKey,
        message: z.string().min(1).max(8000).describe('The text (Markdown as the app shows it).'),
        thread_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Reply in the thread under this message id.'),
        mentions: z
          .array(uuid)
          .max(20)
          .optional()
          .describe('User ids to notify as mentioned (find_people gives ids).'),
        client_id: z
          .string()
          .regex(/^[A-Za-z0-9_-]{8,64}$/)
          .optional()
          .describe('Your own id for this message: a retry with the same id never posts twice.'),
        dry_run: z.boolean().default(true).describe('Default true: check and preview only.')
      },
      annotations: WRITE
    },
    async ({ room, message, thread_id, mentions, client_id, dry_run }) => {
      if (!message.trim()) return refuse('The message is empty.', 'EMPTY_MESSAGE')
      try {
        if (dry_run) {
          // The same visibility check the post makes: a room the person cannot open
          // refuses here exactly as it would on the real send.
          await client.request(listChatMessages(room, { limit: 1, thread: thread_id }))
          return ok({
            dry_run: true,
            would_post: {
              room,
              text: clip(message, 2000),
              ...(thread_id ? { thread_id } : {}),
              ...(mentions?.length ? { mentions } : {})
            },
            note: "Nothing was posted. Call again with dry_run: false to post it; it will show as sent by the key's user through this app."
          })
        }
        const res = await client.request(
          sendChatMessage({
            room,
            message,
            mentions,
            parent_id: thread_id ?? null,
            client_id: client_id ?? null
          })
        )
        const row = res.data as ChatMessage & Row
        return ok({
          posted: true,
          ...(row.duplicate ? { duplicate: true } : {}),
          message: summarizeMessage(row)
        })
      } catch (err) {
        return fail(err)
      }
    }
  )
}
