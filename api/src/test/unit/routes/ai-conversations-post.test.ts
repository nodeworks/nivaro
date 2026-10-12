import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// D4: only the owner may post a conversation to a chat room (#1851).

const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001'
const CONV = '11111111-2222-4333-8444-555555555555'
const who = vi.hoisted(() => ({ id: '', access: 'owner' as 'owner' | 'shared' | 'room' }))
const sent = vi.hoisted(() => ({ n: 0 }))

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: who.id, role: 'R' }
    req.isAdmin = false
  }
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/chat.js', () => ({ canSeeRoom: vi.fn(async () => true) }))
vi.mock('../../../services/chat-send.js', () => ({
  postChatMessage: vi.fn(async () => {
    sent.n++
    return { id: 9 }
  })
}))
vi.mock('../../../services/ai-conversations.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/ai-conversations.js')>()),
  getConversation: vi.fn(async () => ({ id: CONV, owner: OWNER, title: 'Q' })),
  conversationAccess: vi.fn(async () => who.access)
}))

import { aiConversationRoutes } from '../../../routes/ai-conversations.js'

async function post() {
  const a = Fastify()
  await a.register(aiConversationRoutes, { prefix: '/api/ai/conversations' })
  return a.inject({
    method: 'POST',
    url: `/api/ai/conversations/${CONV}/post`,
    payload: { room: 'ch:general' }
  })
}

describe('POST /ai/conversations/:id/post (D4)', () => {
  beforeEach(() => {
    sent.n = 0
  })

  it('refuses a person it was shared with, and a room reader', async () => {
    for (const access of ['shared', 'room'] as const) {
      who.id = 'bbbbbbbb-0000-4000-8000-000000000002'
      who.access = access
      const r = await post()
      expect(r.statusCode).toBe(403)
    }
    expect(sent.n).toBe(0)
  })

  it('lets the owner post', async () => {
    who.id = OWNER
    who.access = 'owner'
    const r = await post()
    expect(r.statusCode).toBe(200)
    expect(sent.n).toBe(1)
  })
})
