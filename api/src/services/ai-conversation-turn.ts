import type { FastifyInstance } from 'fastify'
import type { User } from '../types.js'
import {
  appendMessage,
  type ConversationRow,
  conversationAccess,
  createConversation,
  deleteMessage,
  getConversation,
  historyFromView,
  listMessages,
  messagesForViewer,
  participantsOf,
  sameUserId
} from './ai-conversations.js'

/**
 * One question asked inside a stored Ask AI conversation (#1833, #1809).
 * POST /ai/chat calls `openConversationTurn` when the body carries
 * `conversation_id` (continue) or `save: true` (start one). The turn:
 *  - checks the asker may reach the conversation,
 *  - builds the model history from the turns THIS asker may read (another
 *    person's answer they cannot read goes in as a placeholder),
 *  - stores the question at once, so other participants see it arrive,
 *  - stores the answer (or removes the question when the answer failed),
 *  - tells the other participants — ids only; their client refetches and
 *    the server filters the answer for each of them.
 */

export interface ConversationTurn {
  conversation: ConversationRow
  /** Earlier turns for the model, as the asker may read them. */
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  questionMessageId: string
  /** Owner + the people it is shared with, the asker included (#2739 live mirror). */
  participants: string[]
  record: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>
  fail: () => Promise<void>
}

export type TurnOpenResult = ConversationTurn | { status: number; error: string } | null

function emitTo(
  app: FastifyInstance,
  userIds: string[],
  except: string,
  payload: Record<string, unknown>
) {
  const io = (
    app as FastifyInstance & {
      io?: { to: (r: string) => { emit: (event: string, payload: unknown) => void } }
    }
  ).io
  if (!io) return
  for (const id of userIds) {
    if (sameUserId(id, except)) continue
    io.to(`user:${id}`).emit('ai:conversation', payload)
  }
}

export async function openConversationTurn(
  app: FastifyInstance,
  user: User,
  opts: {
    conversationId?: unknown
    save?: unknown
    question: string
    /** The asker's history opt-out, when the caller already read it. */
    historyOff?: boolean
    /** A background run (#2456): the asker's own other tabs hear the turn too. */
    notifyAsker?: boolean
  }
): Promise<TurnOpenResult> {
  const wanted = typeof opts.conversationId === 'string' ? opts.conversationId.trim() : ''
  if (!wanted && opts.save !== true) return null
  // History off: nothing is stored. A new question answers live; a question
  // into an existing thread would store it, so it is refused.
  const off =
    opts.historyOff ?? (await import('./ai-memory.js').then((m) => m.aiHistoryOff(String(user.id))))
  if (off) {
    return wanted
      ? {
          status: 409,
          error:
            'Your Ask AI history is off, so questions are not saved and cannot be added to a conversation.'
        }
      : null
  }

  let conv: ConversationRow | null
  let history: ConversationTurn['history'] = []
  if (wanted) {
    conv = await getConversation(wanted)
    if (!conv || !(await conversationAccess(user, conv))) {
      return { status: 404, error: 'Conversation not found' }
    }
    const view = await messagesForViewer(user, await listMessages(conv.id))
    history = historyFromView(view)
  } else {
    conv = await createConversation(String(user.id), opts.question)
  }

  const questionMessageId = await appendMessage(conv.id, {
    role: 'user',
    author: String(user.id),
    content: opts.question
  })
  const participants = await participantsOf(conv).catch(() => [] as string[])
  const asker = String(user.id)
  const base = { conversation_id: conv.id, by: asker }
  // The asker is skipped unless the answer arrives outside their request.
  const except = opts.notifyAsker ? '' : asker
  const listeners = opts.notifyAsker && !participants.length ? [asker] : participants
  emitTo(app, listeners, except, { ...base, message_id: questionMessageId, state: 'asking' })

  const c = conv
  return {
    conversation: c,
    history,
    questionMessageId,
    participants,
    record: async (payload) => {
      const meta: Record<string, unknown> = {}
      for (const k of [
        'request_id',
        'truncated',
        'stopped',
        'playbooks_used',
        'cached_at',
        'routing',
        'remembered',
        'plans',
        'choices',
        'followups',
        'memory_suggestions',
        'research'
      ]) {
        const v = payload[k]
        if (v != null && v !== false && !(Array.isArray(v) && v.length === 0)) meta[k] = v
      }
      const messageId = await appendMessage(c.id, {
        role: 'assistant',
        author: asker,
        content: String(payload.reply ?? ''),
        trace: Array.isArray(payload.trace) ? payload.trace : [],
        proposals: Array.isArray(payload.proposals) ? payload.proposals : [],
        meta
      })
      emitTo(app, listeners, except, { ...base, message_id: messageId, state: 'answered' })
      return {
        conversation_id: c.id,
        message_id: messageId,
        question_message_id: questionMessageId
      }
    },
    fail: async () => {
      // A conversation this question started holds nothing else — drop it.
      if (!wanted) {
        const { db } = await import('../db/index.js')
        await db('nivaro_ai_conversations')
          .where({ id: c.id })
          .del()
          .catch(() => {})
        return
      }
      await deleteMessage(c.id, questionMessageId).catch(() => {})
      emitTo(app, listeners, except, { ...base, message_id: questionMessageId, state: 'failed' })
    }
  }
}
