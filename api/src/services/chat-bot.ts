import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import type { BotToolDef } from '@nivaro/extension-kit'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import { getAiClient } from './ai-client.js'
import { parseRoom } from './chat.js'
import type { BotCall, Verdict, VerifyContext } from './chat-bot-audience.js'
import type { RoomRecord } from './chat-records.js'
import { BOT_EMAIL } from './machine-accounts.js'
import { tenantScopedRoom } from './tenant-rooms.js'

export type { BotToolDef } from '@nivaro/extension-kit'

/**
 * Chat AI bot — "@bot what state is REQ-1234".
 *
 * The bot NAME is instance config (`nivaro_settings.chat_bot_name`, null =
 * disabled) — each install picks its own. Questions
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
    status: 'suspended',
    account_kind: 'bot'
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
 *
 * The answer streams into the room as it is written (#1810) and is posted
 * there only while everything behind it is readable by every room reader
 * (chat-bot-audience.ts); otherwise it moves to the asker's conversation with
 * the assistant and the room gets a one-line notice.
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

  // #1967 — ops tools (and ops posts as context) only for an administrator
  // in an admin-only channel, judged now and again by executeOpsTool.
  const ops = await import('./ops-assistant.js')
  const opsOn = await ops.opsToolsAllowed(asker, room).catch(() => false)
  const botId = await botUserId().catch(() => null)

  // Everything below is what every reader of the room already sees: its
  // messages, the channel's description and pins (#1854), and for a record's
  // room the record's header facts (#954) — read AS THE ASKER (#1852); an
  // asker who cannot read the record gets no record context and no scoping.
  const blocks: string[] = []
  let record: RoomRecord | null = null
  try {
    const { roomRecordFacts } = await import('./chat-records.js')
    const rec = await roomRecordFacts(asker, room)
    if (rec) {
      record = rec
      blocks.push(
        [
          `This conversation is the chat room of the record ${rec.label} (collection "${rec.collection}", id ${rec.id}).`,
          rec.state ? `Its workflow state is ${rec.state.label} (key ${rec.state.key}).` : null,
          rec.sla
            ? `SLA: ${rec.sla.status}${rec.sla.elapsed_hours != null ? `, ${Math.round(rec.sla.elapsed_hours)}h in this state` : ''}${rec.sla.due_hours != null ? ` of ${rec.sla.due_hours}h allowed` : ''}.`
            : null,
          rec.owners.length ? `Current owners: ${rec.owners.map((o) => o.name).join(', ')}.` : null,
          `Your tools default to this record: when the question says "this", "it" or "this record", or names no record, look it up with collection "${rec.collection}" and id "${rec.id}" (for query_items, filter {"id": {"_eq": "${rec.id}"}}).`
        ]
          .filter(Boolean)
          .join(' ')
      )
    }
  } catch {
    /* record context is optional */
  }
  try {
    const { channelFacts, channelContextBlock } = await import('./chat-bot-context.js')
    const block = channelContextBlock(await channelFacts(room, opsOn))
    if (block) blocks.push(block)
  } catch {
    /* channel context is optional */
  }
  let posters: string[] = []
  try {
    const { opsOnlyHider } = await import('./ops-room-guard.js')
    const { recentMessagesBlock } = await import('./chat-bot-context.js')
    const hideOps = await opsOnlyHider(opsOn)
    const recent = (await hideOps(db('chat_messages').where({ room }))
      .whereNull('deleted_at')
      .orderBy('id', 'desc')
      .limit(40)
      .select('sender', 'sender_name', 'message')) as Array<{
      sender: string | null
      sender_name: string | null
      message: string
    }>
    posters = recent.map((m) => String(m.sender ?? '')).filter(Boolean)
    const block = recentMessagesBlock(recent.reverse())
    if (block) blocks.push(block)
  } catch {
    /* context is optional */
  }

  const { roomAudience } = await import('./chat-bot-audience.js')
  const audience = await roomAudience(room, String(asker.id), botId).catch(
    () => ({ kind: 'open' }) as const
  )
  const roomPeople = record
    ? [
        ...posters,
        ...(((await db('nivaro_chat_memberships')
          .where({ room })
          .limit(200)
          .pluck('user')
          .catch(() => [])) as string[]) ?? [])
      ]
    : []

  const { BotStream } = await import('./chat-bot-stream.js')
  const stream = new BotStream(app, room, String(asker.id))
  stream.start()
  let outcome: BotAnswer
  try {
    outcome = await answerQuestion(app, asker, question, {
      context: blocks.join('\n\n'),
      room,
      record,
      opsOn,
      stream,
      verify: {
        room,
        audience,
        record,
        opsRoom: opsOn,
        roomPeople,
        budget: { left: (await import('./chat-bot-audience.js')).REPLAY_BUDGET }
      },
      quietStatus: !(audience.kind === 'people' && audience.ids.length === 0)
    })
  } catch (err) {
    app.log.warn({ err }, 'chat bot failed')
    outcome = {
      text: "Sorry — I couldn't answer that right now.",
      verdict: stream.isPrivate ? 'private' : 'room',
      stopped: false
    }
  }

  let reply = stripAskBlocks(outcome.text)
  if (outcome.stopped) reply = reply ? `${reply} … (stopped)` : ''
  if (!reply) {
    stream.end({ stopped: true, message_id: null })
    return
  }

  let id: number | null = null
  if (outcome.verdict === 'room') {
    id = await postBotMessage(app, room, reply)
    // An answer in an ops room may carry ops facts: an ops post, admins only.
    if (id != null && opsOn) {
      const { markOpsOnly } = await import('./ops-room-guard.js')
      await markOpsOnly(id, room).catch(() => undefined)
    }
    stream.end({ message_id: id, stopped: outcome.stopped })
  } else {
    const dm = botId ? botDmRoom(String(asker.id), botId) : null
    const where = await roomPlace(room, record)
    id = dm
      ? await postBotMessage(
          app,
          dm,
          `You asked in ${where}: \u201c${question.slice(0, 200)}\u201d\n\n${reply}`
        )
      : null
    const who = String(asker.first_name ?? '').trim() || 'you'
    await postBotMessage(
      app,
      room,
      `I answered ${who} privately — the answer uses data not everyone in this room can see.`
    )
    stream.end({ message_id: id, private_room: dm, text: reply, stopped: outcome.stopped })
  }
  if (id != null) {
    void logActivity({
      action: 'chat-bot-reply',
      user: botId ?? undefined,
      collection: 'chat_messages',
      item: String(id),
      comment: `room ${room} · asked by ${asker.email ?? asker.id}${outcome.verdict === 'private' ? ' · answered privately' : ''}`
    })
  }
}

/** The asker's DM with the assistant — where private answers are kept. */
export function botDmRoom(userId: string, botId: string): string {
  return `dm:${[userId.toUpperCase(), botId.toUpperCase()].sort().join(':')}`
}

/** How a private answer names the room it was asked in. */
async function roomPlace(room: string, record: RoomRecord | null): Promise<string> {
  const parsed = parseRoom(room)
  if (parsed.kind === 'global') return 'General'
  if (parsed.kind === 'dm') return 'a direct message'
  if (parsed.kind === 'entity') return record?.label ?? parsed.token ?? room
  if (parsed.kind === 'channel') {
    const { channels } = await import('./chat.js')
    const ch = (await channels().catch(() => null))?.get(parsed.channelKey ?? '')
    if (ch?.is_direct) return 'a group conversation'
    return `#${ch?.name ?? parsed.channelKey}`
  }
  return room
}

/** Post a message into a room as the assistant and push it to the room's
 *  sockets (and both DM participants). Returns the new message id, or null
 *  when the bot is off or the insert failed. */
export async function postBotMessage(
  app: FastifyInstance,
  room: string,
  text: string
): Promise<number | null> {
  const botName = await chatBotName()
  if (!botName) return null
  try {
    const sender = await botUserId()
    const senderName = botName
    const [inserted] = await db('chat_messages')
      .insert({
        room,
        message: text.slice(0, 4000),
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
      message: text.slice(0, 4000),
      sender,
      sender_name: senderName,
      date_created: new Date().toISOString()
    }
    app.io?.to(tenantScopedRoom(`chat:${room}`)).emit('chat:message', row)
    const parsed = parseRoom(room)
    if (parsed.kind === 'dm') {
      for (const p of parsed.participants ?? []) {
        app.io?.to(`user:${p}`).emit('chat:message', row)
      }
    }
    return id
  } catch (err) {
    app.log.warn({ err }, 'chat bot message insert failed')
    return null
  }
}

const extensionBotTools = new Map<string, BotToolDef>()
export function registerBotTool(def: BotToolDef): void {
  if (!/^[a-z][a-z0-9_]{2,40}$/.test(def.name)) return
  extensionBotTools.set(def.name, def)
}

/** Watch command (#223): "@bot watch REQ-1234" — subscribes the asker via
 *  the entity-room registry (token → collection/record), same per-record
 *  subscription shape as the record bell. */
const WATCH_TOOL: Anthropic.Tool = {
  name: 'watch_record',
  description:
    'Subscribe the asking user to a record so every change notifies them. Use when they say "watch <record id>" or "follow <record id>". Pass the human record id exactly as they wrote it (e.g. REQ-1234).',
  input_schema: {
    type: 'object',
    properties: { record_token: { type: 'string', description: 'The record id/token to watch' } },
    required: ['record_token']
  }
}

async function executeWatch(asker: User, token: string): Promise<string> {
  const { roomTypes } = await import('./chat-records.js')
  const { readItems } = await import('./items.js')
  for (const t of await roomTypes()) {
    try {
      // AS THE ASKER: a record they cannot read is a record that is not there.
      const res = (await readItems(asker, t.collection, {
        filter: { [t.match_field || 'id']: { _eq: token } },
        fields: ['id'],
        limit: 1
      })) as { data?: Array<{ id?: unknown }> }
      const row = res.data?.[0]
      if (row?.id == null) continue
      const existing = await db('nivaro_notification_subscriptions')
        .where({
          user: asker.id,
          collection: t.collection,
          filter_field: 'id',
          filter_value: String(row.id)
        })
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
  {
    match: /subscri|watch|follow.*record|notif.*record/i,
    answer:
      'Open the record and click the bell in its header — "State changes only" or "All changes". You can also tell me "watch <record id>". Mute a record from the same dialog.'
  },
  {
    match: /saved view|save.*filter|default view/i,
    answer:
      'Set your filters/columns in the collection browser, then Columns → "Save as preset…". Admins can star one view as the collection-wide default.'
  },
  {
    match: /import|upload.*csv|spreadsheet/i,
    answer:
      'Imports live under Monitoring → Imports. The CSV wizard maps columns (with an AI "Suggest mapping" button), previews changes, and failed rows can be repaired inline afterward.'
  },
  {
    match: /export|excel|csv/i,
    answer:
      'Any collection browser exports CSV from the Export menu (current filters apply). Admins can define server export presets (xlsx, with child sheets) in the same menu.'
  },
  {
    match: /delegate|out of office|ooo|vacation/i,
    answer:
      'Profile → delegation card: set your delegate and OOO window. Owned work routes to the delegate while you\u2019re out; open tasks move to them automatically.'
  },
  {
    match: /queue|worklist|claim/i,
    answer:
      'Queues (left nav) are cross-collection worklists. "Work Next" claims and opens the highest-priority unclaimed item; saved views keep your scope/filters.'
  },
  {
    match: /report|dashboard|chart/i,
    answer:
      'Report Studio (Reports nav) builds widget grids over any collection — filters, snapshots, alerts, subscriptions. "Build with AI" drafts one from a sentence.'
  },
  {
    match: /digest|too many email|email.*settings/i,
    answer:
      'Profile → Email delivery: switch to the daily action digest (pick your hour — it follows your timezone), or compact layout. Notification rules on the same page control quiet hours and sounds.'
  }
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
 *  about the REQ-1234 order" needs no date-picker UI. */
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

export interface BotAnswer {
  text: string
  /** Where the answer may go — decided before any of it streamed. */
  verdict: Verdict
  /** The asker pressed Stop; `text` is what had arrived. */
  stopped: boolean
}

interface AnswerOptions {
  context: string
  room: string
  record: RoomRecord | null
  opsOn: boolean
  stream: BotStreamLike
  verify: VerifyContext
  /** Others read the room: tool steps show as a plain "Looking that up…". */
  quietStatus: boolean
}

/** What the loop needs of the stream (chat-bot-stream.ts BotStream). */
export interface BotStreamLike {
  readonly isPrivate: boolean
  stopped(): boolean
  delta(text: string, round: number): void
  status(text: string): void
  goPrivate(): void
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/** The shared prompt asks for ```followups / ```chart blocks the Ask AI page
 *  renders; a chat message cannot, so they are dropped from the reply. */
export function stripAskBlocks(text: string): string {
  return text
    .replace(/```(?:followups|chart)[^\n]*\n[\s\S]*?(?:```|$)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function answerQuestion(
  app: FastifyInstance,
  asker: User,
  question: string,
  opts: AnswerOptions
): Promise<BotAnswer> {
  const { room, record, opsOn, stream } = opts
  const { getAiModelSettings } = await import('./ai-client.js')
  const { chatModel: model } = await getAiModelSettings()
  const client = await getAiClient({ model })
  if (!client)
    return {
      text: 'AI is not configured on this instance — an admin can add a key in Settings.',
      verdict: 'room',
      stopped: false
    }

  const { buildChatSystemPrompt, CHAT_TOOLS, MAX_ROUNDS, executeChatTool } = await import(
    './ai-chat.js'
  )
  const ops = await import('./ops-assistant.js')
  const { describeToolCall } = await import('./ai-chat-loop.js')
  const { consumeText, isAbortError, streamMessage } = await import('./ai-stream.js')
  const { hashToolResult, toolResultText } = await import('./ai-result-hash.js')
  const { isRecordScopedCall, scopeToRecord, verifyCall } = await import('./chat-bot-audience.js')
  // In a room others read, none of the asker's own catalogues: round
  // one streams before any tool, and the room check only covers tool calls.
  const alone = opts.verify.audience.kind === 'people' && opts.verify.audience.ids.length === 0
  const systemPrompt = `${await buildChatSystemPrompt(asker, { catalogues: alone })}${opsOn ? `\n\n${ops.OPS_PROMPT}` : ''}`
  const { userTimeZone, formatForPerson } = await import('./user-time.js')
  const zone = await userTimeZone(asker)

  const contextBlock = opts.context ? `${opts.context}\n\n` : ''
  const convo: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `${contextBlock}Current time: ${new Date().toISOString()} (UTC) — ${formatForPerson(new Date(), zone)} for this person (${zone}). Resolve relative times like "in 5 minutes" or "Friday 9am" in their zone.\n\n${question}\n\n(You are answering inside a chat room — keep it to a few sentences of plain text, no markdown headers or tables. Your answer is shown to everyone in the room only when everything it uses is readable by all of them, otherwise it goes privately to the person asking — so read only the fields you need. You may use set_reminder when asked to remind the user of something.)`
    }
  ]
  const tools: Anthropic.Tool[] = [
    ...CHAT_TOOLS,
    SET_REMINDER_TOOL,
    WATCH_TOOL,
    HELP_TOOL,
    ...(opsOn ? [ops.OPS_STATUS_TOOL, ops.OPS_PROPOSE_TOOL] : []),
    ...[...extensionBotTools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool['input_schema']
    }))
  ]
  let verdict: Verdict = 'room'
  const answer = (text: string, stopped = false): BotAnswer => ({ text, verdict, stopped })

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (stream.stopped()) return answer('', true)
    const controller = new AbortController()
    let partial = ''
    let halted = false
    let response: Anthropic.Message
    try {
      const s = await streamMessage(
        client,
        { model, max_tokens: 700, system: systemPrompt, tools, messages: convo },
        { signal: controller.signal }
      )
      response = await consumeText(s, (t) => {
        partial += t
        stream.delta(t, round)
        if (!halted && stream.stopped()) {
          halted = true
          controller.abort()
          s.abort()
        }
      })
    } catch (err) {
      if (halted || isAbortError(err)) return answer(partial, true)
      throw err
    }
    if (halted) return answer(partial, true)
    if (response.stop_reason !== 'tool_use') {
      return answer(stripAskBlocks(textOf(response)) || "I couldn't find an answer to that.")
    }
    convo.push({ role: 'assistant', content: response.content })
    const results: Anthropic.ToolResultBlockParam[] = []
    const calls: BotCall[] = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      // #1852 — in a record's room the record is the default subject.
      let input = scopeToRecord(block.name, (block.input ?? {}) as Record<string, unknown>, record)
      // In a room too big to replay for, a read of the room's own record can
      // still reach the room — but only bare: a link label is another record.
      if (
        opts.verify.audience.kind === 'open' &&
        !stream.isPrivate &&
        block.name === 'query_items' &&
        isRecordScopedCall({ tool: block.name, input, hash: '', failed: false }, record)
      ) {
        input = { ...input, link_labels: false }
      }
      stream.status(
        opts.quietStatus && !stream.isPrivate
          ? 'Looking that up…'
          : describeToolCall(block.name, input)
      )
      const put = (content: string, result: unknown, failed = false) => {
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content,
          ...(failed ? { is_error: true } : {})
        })
        calls.push({ tool: block.name, input, hash: hashToolResult(result), failed })
      }
      try {
        if (block.name === 'set_reminder') {
          const when = new Date(String(input.when_iso ?? ''))
          const note = String(input.note ?? '')
            .trim()
            .slice(0, 500)
          if (Number.isNaN(when.getTime()) || !note) throw new Error('Invalid reminder')
          if (when.getTime() < Date.now()) throw new Error('That time is in the past')
          const { createReminder } = await import('./reminders.js')
          await createReminder(app, {
            user: String(asker.id),
            note,
            remindAt: when,
            room: room ?? null
          })
          // The person-facing time is handed over ready to quote, so the
          // reply never falls back to the UTC ISO string.
          const out = { scheduled_for: formatForPerson(when, zone), time_zone: zone, note }
          put(JSON.stringify(out), out)
          continue
        }
        if (block.name === 'watch_record') {
          const msg = await executeWatch(asker, String(input.record_token ?? '').trim())
          put(msg, msg)
          continue
        }
        if (block.name === 'product_help') {
          const q = String(input.question ?? '')
          const hit = HELP_TOPICS.find((h) => h.match.test(q))
          const msg = hit
            ? hit.answer
            : 'No curated answer for that — suggest they check the in-app Docs page (left nav).'
          put(msg, msg)
          continue
        }
        if (ops.OPS_TOOL_NAMES.has(block.name)) {
          const out = await ops.executeOpsTool(app, asker, room, block.name, input)
          put(JSON.stringify(out ?? null).slice(0, 30_000), out ?? null)
          continue
        }
        const extTool = extensionBotTools.get(block.name)
        if (extTool) {
          const out = await extTool.handler(asker, input)
          put(JSON.stringify(out ?? null).slice(0, 30_000), out ?? null)
          continue
        }
        // AS THE ASKER — RBAC/RLS/scopes apply to every tool call. The model
        // gets exactly the text the fingerprint covers (toolResultText), so a
        // replay that matches proves the reader could have seen all of it.
        const { result } = await executeChatTool(asker, block.name, input)
        put(toolResultText(result), result)
      } catch (err) {
        const msg = `Error: ${err instanceof Error ? err.message : 'Tool failed'}`
        put(msg, msg, true)
      }
    }
    convo.push({ role: 'user', content: results })
    // Decide where the next round may stream BEFORE it writes a word.
    if (verdict === 'room') {
      for (const call of calls) {
        if ((await verifyCall(call, opts.verify).catch(() => 'private' as const)) === 'private') {
          verdict = 'private'
          stream.goPrivate()
          break
        }
      }
    }
  }
  return answer('That question needed more digging than I can do in chat — try the Ask AI page.')
}
