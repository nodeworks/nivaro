import type { FastifyInstance } from 'fastify'
import type Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { getAiClient } from './ai-client.js'
import { logActivity } from './activity.js'
import { parseRoom } from './chat.js'

/**
 * Chat AI bot — "@efp what state is CR26-76773".
 *
 * The bot NAME is instance config (`nivaro_settings.chat_bot_name`, null =
 * disabled) — EFP calls it @efp, a fresh install can pick anything. Questions
 * run through the SAME permission-checked AI chat tools as /ai/ask, AS THE
 * PERSON WHO ASKED — the bot can never reveal a record the asker couldn't
 * read themselves. Replies post as a real (suspended) bot user so the message
 * row has a sender like any other; suspended keeps it out of every people
 * picker and the directory.
 */

let botNameCache: { at: number; name: string | null } | null = null

export async function chatBotName(): Promise<string | null> {
  if (botNameCache && Date.now() - botNameCache.at < 30_000) return botNameCache.name
  const row = await db('nivaro_settings')
    .orderBy('id', 'asc')
    .first('chat_bot_name')
    .catch(() => null)
  const name = String(row?.chat_bot_name ?? '').trim() || null
  botNameCache = { at: Date.now(), name }
  return name
}

export function clearChatBotCache(): void {
  botNameCache = null
}

const BOT_EMAIL = 'chat-bot@nivaro.local'

export async function botUserId(): Promise<string> {
  const existing = await db('nivaro_users').where({ email: BOT_EMAIL }).first('id')
  if (existing) return String(existing.id)
  const id = randomUUID().toUpperCase()
  await db('nivaro_users').insert({
    id,
    email: BOT_EMAIL,
    first_name: 'Assistant',
    // Suspended by design: hidden from listUsers, pickers, presence — the bot
    // exists only as a message sender.
    status: 'suspended'
  })
  return id
}

/** Does this message address the bot? Accepts '@name' and the composer's
 *  '@[name]' mention form, case-insensitively. */
export function mentionsBot(text: string, botName: string): boolean {
  const esc = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`@\\[?${esc}\\]?\\b`, 'i').test(text)
}

function stripBotMention(text: string, botName: string): string {
  const esc = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`@\\[?${esc}\\]?`, 'gi'), '').trim()
}

/**
 * Answer a bot mention. Fire-and-forget from the send route — a slow or
 * failing model must never block or fail the human's message.
 */
export async function handleBotMention(
  app: FastifyInstance,
  asker: User,
  room: string,
  text: string
): Promise<void> {
  const botName = await chatBotName()
  if (!botName) return
  const question = stripBotMention(text, botName) || text.trim()
  if (!question) return

  // The room's recent conversation rides along as context, so "summarize
  // this room" and "what did Beth decide about the vendor" work naturally.
  // The asker can already read every one of these messages — no new
  // disclosure. Deleted messages excluded.
  let roomContext = ''
  try {
    const recent = (await db('chat_messages')
      .where({ room })
      .whereNull('deleted_at')
      .orderBy('id', 'desc')
      .limit(40)
      .select('sender_name', 'message')) as Array<{
      sender_name: string | null
      message: string
    }>
    roomContext = recent
      .reverse()
      .map((m) => `${m.sender_name ?? 'Unknown'}: ${String(m.message).slice(0, 400)}`)
      .join('\n')
      .slice(-6000)
  } catch {
    /* context is optional */
  }

  let reply: string
  try {
    reply = await answerQuestion(asker, question, roomContext)
  } catch (err) {
    app.log.warn({ err }, 'chat bot failed')
    reply = "Sorry — I couldn't answer that right now."
  }

  try {
    const sender = await botUserId()
    const senderName = botName
    const [inserted] = await db('chat_messages')
      .insert({
        room,
        message: reply.slice(0, 4000),
        sender,
        sender_name: senderName,
        date_created: new Date()
      })
      .returning('id')
    const id =
      typeof inserted === 'object' && inserted !== null
        ? (inserted as { id: number }).id
        : (inserted as number)
    const row = {
      id,
      room,
      message: reply.slice(0, 4000),
      sender,
      sender_name: senderName,
      date_created: new Date().toISOString()
    }
    app.io?.to(`chat:${room}`).emit('chat:message', row)
    const parsed = parseRoom(room)
    if (parsed.kind === 'dm') {
      for (const p of parsed.participants ?? []) {
        app.io?.to(`user:${p}`).emit('chat:message', row)
      }
    }
    void logActivity({
      action: 'chat-bot-reply',
      user: sender,
      collection: 'chat_messages',
      item: String(id),
      comment: `room ${room} · asked by ${asker.email ?? asker.id}`
    })
  } catch (err) {
    app.log.warn({ err }, 'chat bot reply insert failed')
  }
}

// ── Extension bot tools (#247): extensions register tools the bot may call.
// Handlers receive the ASKER — extension code decides its own permission
// posture, same trust level as any extension route.
export interface BotToolDef {
  name: string
  description: string
  input_schema: Record<string, unknown>
  handler: (asker: User, input: Record<string, unknown>) => Promise<unknown>
}
const extensionBotTools = new Map<string, BotToolDef>()
export function registerBotTool(def: BotToolDef): void {
  if (!/^[a-z][a-z0-9_]{2,40}$/.test(def.name)) return
  extensionBotTools.set(def.name, def)
}

/** Watch command (#223): "@bot watch CR26-76773" — subscribes the asker via
 *  the entity-room registry (token → collection/record), same per-record
 *  subscription shape as the record bell. */
const WATCH_TOOL: Anthropic.Tool = {
  name: 'watch_record',
  description:
    'Subscribe the asking user to a record so every change notifies them. Use when they say "watch <record id>" or "follow <record id>". Pass the human record id exactly as they wrote it (e.g. CR26-76773).',
  input_schema: {
    type: 'object',
    properties: { record_token: { type: 'string', description: 'The record id/token to watch' } },
    required: ['record_token']
  }
}

async function executeWatch(asker: User, token: string): Promise<string> {
  const types = (await db('nivaro_chat_room_types')
    .where({ is_active: true })
    .select('prefix', 'collection', 'match_field')) as Array<{
    prefix: string
    collection: string
    match_field: string
  }>
  for (const t of types) {
    try {
      const row = (await db(t.collection)
        .where({ [t.match_field || 'id']: token })
        .first('id')) as { id?: unknown } | undefined
      if (!row?.id) continue
      const existing = await db('nivaro_notification_subscriptions')
        .where({ user: asker.id, collection: t.collection, filter_field: 'id', filter_value: String(row.id) })
        .first('id')
      if (existing) return `You're already watching ${token}.`
      await db('nivaro_notification_subscriptions').insert({
        user: asker.id,
        collection: t.collection,
        event_type: 'all',
        filter_field: 'id',
        filter_value: String(row.id),
        label: `Watch ${token} (chat)`,
        is_active: true,
        digest_frequency: 'instant',
        created_at: new Date()
      })
      return `Watching ${token} — every change will notify you. Unsubscribe from the record's bell.`
    } catch {
      /* next registry entry */
    }
  }
  return `I couldn't find a record matching "${token}".`
}

/** Help topics (#224): "how do I…" answers, curated — the doc site isn't
 *  reachable from the server, so this table IS the bot's product knowledge. */
const HELP_TOPICS: Array<{ match: RegExp; answer: string }> = [
  { match: /subscri|watch|follow.*record|notif.*record/i, answer: 'Open the record and click the bell in its header — "State changes only" or "All changes". You can also tell me "watch <record id>". Mute a record from the same dialog.' },
  { match: /saved view|save.*filter|default view/i, answer: 'Set your filters/columns in the collection browser, then Columns → "Save as preset…". Admins can star one view as the collection-wide default.' },
  { match: /import|upload.*csv|spreadsheet/i, answer: 'Imports live under Monitoring → Imports. The CSV wizard maps columns (with an AI "Suggest mapping" button), previews changes, and failed rows can be repaired inline afterward.' },
  { match: /export|excel|csv/i, answer: 'Any collection browser exports CSV from the Export menu (current filters apply). Admins can define server export presets (xlsx, with child sheets) in the same menu.' },
  { match: /delegate|out of office|ooo|vacation/i, answer: 'Profile → delegation card: set your delegate and OOO window. Owned work routes to the delegate while you\u2019re out; open tasks move to them automatically.' },
  { match: /queue|worklist|claim/i, answer: 'Queues (left nav) are cross-collection worklists. "Work Next" claims and opens the highest-priority unclaimed item; saved views keep your scope/filters.' },
  { match: /report|dashboard|chart/i, answer: 'Report Studio (Reports nav) builds widget grids over any collection — filters, snapshots, alerts, subscriptions. "Build with AI" drafts one from a sentence.' },
  { match: /digest|too many email|email.*settings/i, answer: 'Profile → Email delivery: switch to the daily action digest (pick your hour — it follows your timezone), or compact layout. Notification rules on the same page control quiet hours and sounds.' }
]

const HELP_TOOL: Anthropic.Tool = {
  name: 'product_help',
  description:
    'Answer "how do I…" questions about using this application (subscriptions, views, imports, exports, delegation, queues, reports, digests). Pass the user\u2019s question.',
  input_schema: {
    type: 'object',
    properties: { question: { type: 'string' } },
    required: ['question']
  }
}

/** The bot-only reminder tool — extracts the WHEN so "remind me Friday at 9
 *  about the CR26-76773 PO" needs no date-picker UI. */
const SET_REMINDER_TOOL: Anthropic.Tool = {
  name: 'set_reminder',
  description:
    'Schedule a personal reminder for the asking user. Use when they ask to be reminded of something at a time. Resolve relative times ("tomorrow", "Friday 9am") to an ISO datetime using the current time provided in the conversation.',
  input_schema: {
    type: 'object',
    properties: {
      when_iso: { type: 'string', description: 'ISO 8601 datetime for the reminder' },
      note: { type: 'string', description: 'What to remind them about, in their words' }
    },
    required: ['when_iso', 'note']
  }
}

async function answerQuestion(
  asker: User,
  question: string,
  roomContext?: string
): Promise<string> {
  const client = await getAiClient()
  if (!client) return 'AI is not configured on this instance — an admin can add a key in Settings.'

  const { CHAT_SYSTEM_PROMPT, CHAT_TOOLS, MAX_ROUNDS, executeChatTool } = await import(
    './ai-chat.js'
  )
  const modelRow = await db('nivaro_settings').orderBy('id', 'asc').first('ai_model').catch(() => null)
  const model = String(modelRow?.ai_model ?? '') || 'claude-haiku-4-5-20251001'

  const contextBlock = roomContext
    ? `Recent messages in this chat room (oldest first):\n${roomContext}\n\n`
    : ''
  const convo: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `${contextBlock}Current time: ${new Date().toISOString()}\n\n${question}\n\n(You are answering inside a chat room — keep it to a few sentences of plain text, no markdown headers or tables. You may use set_reminder when asked to remind the user of something.)`
    }
  ]
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await client.messages.create({
      model,
      max_tokens: 700,
      system: CHAT_SYSTEM_PROMPT,
      tools: [
        ...CHAT_TOOLS,
        SET_REMINDER_TOOL,
        WATCH_TOOL,
        HELP_TOOL,
        ...[...extensionBotTools.values()].map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as Anthropic.Tool['input_schema']
        }))
      ],
      messages: convo
    })
    if (response.stop_reason !== 'tool_use') {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()
      return text || "I couldn't find an answer to that."
    }
    convo.push({ role: 'assistant', content: response.content })
    const results: Anthropic.ToolResultBlockParam[] = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      const input = (block.input ?? {}) as Record<string, unknown>
      try {
        if (block.name === 'set_reminder') {
          const when = new Date(String(input.when_iso ?? ''))
          const note = String(input.note ?? '').trim().slice(0, 500)
          if (Number.isNaN(when.getTime()) || !note) throw new Error('Invalid reminder')
          if (when.getTime() < Date.now()) throw new Error('That time is in the past')
          await db('nivaro_reminders').insert({
            user: asker.id,
            note,
            remind_at: when,
            created_at: new Date()
          })
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify({ scheduled_for: when.toISOString(), note })
          })
          continue
        }
        if (block.name === 'watch_record') {
          const msg = await executeWatch(asker, String(input.record_token ?? '').trim())
          results.push({ type: 'tool_result', tool_use_id: block.id, content: msg })
          continue
        }
        if (block.name === 'product_help') {
          const q = String(input.question ?? '')
          const hit = HELP_TOPICS.find((h) => h.match.test(q))
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: hit
              ? hit.answer
              : 'No curated answer for that — suggest they check the in-app Docs page (left nav).'
          })
          continue
        }
        const extTool = extensionBotTools.get(block.name)
        if (extTool) {
          const out = await extTool.handler(asker, input)
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(out ?? null).slice(0, 30_000)
          })
          continue
        }
        // AS THE ASKER — RBAC/RLS/scopes apply to every tool call.
        const { result } = await executeChatTool(asker, block.name, input)
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result).slice(0, 30_000)
        })
      } catch (err) {
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Error: ${err instanceof Error ? err.message : 'Tool failed'}`,
          is_error: true
        })
      }
    }
    convo.push({ role: 'user', content: results })
  }
  return 'That question needed more digging than I can do in chat — try the Ask AI page.'
}
