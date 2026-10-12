import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../db/index.js'
import { openConversationTurn } from '../../../services/ai-conversation-turn.js'
import { deleteOwnConversations } from '../../../services/ai-conversations.js'
import { historyOffFromPreferences } from '../../../services/ai-memory.js'

// "Don't save my questions" (#1833 opt-out).

const ME = 'aaaaaaaa-0000-4000-8000-000000000001'
const user = { id: ME } as never
const app = {} as never

/** db mock: records every table touched and every where(); prefs come from `prefs`. */
function track(prefs: Record<string, unknown>) {
  const calls: Array<{ table: string; where: unknown[]; op?: string }> = []
  ;(db as unknown as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    const call: { table: string; where: unknown[]; op?: string } = { table, where: [] }
    calls.push(call)
    const chain: Record<string, unknown> = {}
    const self = () => chain
    for (const m of ['whereIn', 'whereNotNull', 'orderBy', 'select', 'returning']) chain[m] = self
    chain.where = (...a: unknown[]) => {
      call.where.push(a.length === 1 ? a[0] : a)
      return chain
    }
    chain.first = async () =>
      table === 'nivaro_users' ? { preferences: JSON.stringify(prefs) } : null
    chain.insert = () => {
      call.op = 'insert'
      // appendMessage chains .returning('id') onto the insert.
      return Object.assign(Promise.resolve([{ id: 1 }]), { returning: async () => [{ id: 1 }] })
    }
    chain.update = async () => {
      call.op = 'update'
      return 1
    }
    chain.del = async () => {
      call.op = 'del'
      return 3
    }
    chain.pluck = async () => []
    return chain
  })
  return calls
}

describe('history off — nothing is stored', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reads the preference strictly', () => {
    expect(historyOffFromPreferences({ ai_history_off: true })).toBe(true)
    expect(historyOffFromPreferences('{"ai_history_off":true}')).toBe(true)
    expect(historyOffFromPreferences({ ai_history_off: 'yes' })).toBe(false)
    expect(historyOffFromPreferences(null)).toBe(false)
  })

  it('a new question with save: true opens no conversation and writes no row', async () => {
    const calls = track({ ai_history_off: true })
    const turn = await openConversationTurn(app, user, { save: true, question: 'How many POs?' })
    expect(turn).toBeNull()
    expect(calls.some((c) => c.table.startsWith('nivaro_ai_conversation'))).toBe(false)
  })

  it('a question into an existing conversation is refused (it would be stored)', async () => {
    const calls = track({ ai_history_off: true })
    const turn = await openConversationTurn(app, user, {
      conversationId: '11111111-2222-4333-8444-555555555555',
      question: 'and for 2025?'
    })
    expect(turn).toMatchObject({ status: 409 })
    expect(calls.some((c) => c.op === 'insert')).toBe(false)
  })

  it('with history on, the same question does create a conversation', async () => {
    const calls = track({})
    const turn = await openConversationTurn(app, user, { save: true, question: 'How many POs?' })
    expect(turn && 'conversation' in turn).toBe(true)
    expect(calls.some((c) => c.table === 'nivaro_ai_conversations' && c.op === 'insert')).toBe(true)
  })
})

describe('Also delete my saved conversations', () => {
  beforeEach(() => vi.clearAllMocks())

  it('deletes only conversations the caller owns', async () => {
    const calls = track({})
    expect(await deleteOwnConversations(ME)).toBe(3)
    const dels = calls.filter((c) => c.op === 'del')
    expect(dels).toHaveLength(1)
    expect(dels[0].table).toBe('nivaro_ai_conversations')
    expect(dels[0].where).toEqual([{ owner: ME }])
    // Nothing else is touched — conversations shared with me stay.
    expect(calls.filter((c) => c.table === 'nivaro_ai_conversation_shares')).toHaveLength(0)
  })
})

describe('DELETE /ai/conversations/mine', () => {
  it('deletes as the caller, never a body/param-supplied owner', async () => {
    vi.resetModules()
    const seen: string[] = []
    vi.doMock('../../../middleware/authenticate.js', () => ({
      authenticate: async (req: { user?: unknown }) => {
        req.user = { id: ME }
      }
    }))
    vi.doMock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
    vi.doMock('../../../services/ai-conversations.js', async (orig) => ({
      ...(await orig<typeof import('../../../services/ai-conversations.js')>()),
      deleteOwnConversations: vi.fn(async (id: string) => {
        seen.push(id)
        return 2
      })
    }))
    const { aiConversationRoutes } = await import('../../../routes/ai-conversations.js')
    const a = Fastify()
    await a.register(aiConversationRoutes, { prefix: '/api/ai/conversations' })
    const r = await a.inject({
      method: 'DELETE',
      url: '/api/ai/conversations/mine?owner=someone-else'
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ data: { deleted: 2 } })
    expect(seen).toEqual([ME])
  })
})
