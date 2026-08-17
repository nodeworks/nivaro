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

async function botUserId(): Promise<string> {
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
  const question = stripBotMention(text, botName)
  if (!question) return

  let reply: string
  try {
    reply = await answerQuestion(asker, question)
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

async function answerQuestion(asker: User, question: string): Promise<string> {
  const client = await getAiClient()
  if (!client) return 'AI is not configured on this instance — an admin can add a key in Settings.'

  const { CHAT_SYSTEM_PROMPT, CHAT_TOOLS, MAX_ROUNDS, executeChatTool } = await import(
    './ai-chat.js'
  )
  const modelRow = await db('nivaro_settings').orderBy('id', 'asc').first('ai_model').catch(() => null)
  const model = String(modelRow?.ai_model ?? '') || 'claude-haiku-4-5-20251001'

  const convo: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `${question}\n\n(You are answering inside a chat room — keep it to a few sentences of plain text, no markdown headers or tables.)`
    }
  ]
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await client.messages.create({
      model,
      max_tokens: 700,
      system: CHAT_SYSTEM_PROMPT,
      tools: CHAT_TOOLS,
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
