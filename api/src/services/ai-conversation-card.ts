import type { User } from '../types.js'
import {
  answerVisibleTo,
  conversationAccess,
  getConversation,
  listMessages,
  namesFor
} from './ai-conversations.js'

/** Plain text of an answer, cut for a card line (markdown, tables and chart blocks dropped). */
export function shortAnswer(content: string, max = 220): string {
  const text = content
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .filter((l) => !/^\s*\|/.test(l))
    .join(' ')
    .replace(/[#*_`>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * The chat card for a posted conversation (#1851), as `reader` may see it:
 * the first question always, the first answer only when the sharing rule
 * admits this reader (re-run as them, same fingerprint), else a note that
 * opening it re-runs the question with their access.
 */
export async function askConversationCard(user: User, id: string) {
  const conv = await getConversation(id)
  if (!conv || !(await conversationAccess(user, conv))) return null
  const rows = await listMessages(conv.id)
  const firstQ = rows.find((r) => r.role === 'user')
  const firstA = rows.find((r) => r.role === 'assistant')
  let answer: string | null = null
  let hidden = false
  if (firstA) {
    if (await answerVisibleTo(user, firstA)) answer = shortAnswer(firstA.content) || null
    else hidden = true
  }
  const owner = await namesFor([conv.owner])
  return {
    kind: 'ask' as const,
    id: conv.id,
    name: conv.title,
    question: firstQ?.content.slice(0, 300) ?? conv.title,
    answer,
    answer_hidden: hidden,
    turns: rows.filter((r) => r.role === 'user').length,
    owner_name: owner.get(conv.owner.toUpperCase()) ?? 'Someone'
  }
}
