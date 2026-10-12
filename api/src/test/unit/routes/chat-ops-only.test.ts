import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #1967 review: an assistant ops post (chat_messages.ops_only) does not exist
// for a viewer who is not an administrator — not through a single-message
// route (copy to notes, reactions, pin, save) and not as a quote / thread target.

const who = vi.hoisted(() => ({ admin: false }))
const OPS_POST = { id: 7, room: 'ch:ops', message: 'Server errors rising: 40', ops_only: true }

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: who.admin ? 'ANA' : 'BOB', role: 'R' }
    req.isAdmin = who.admin
  },
  requireAdmin: async () => undefined
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/chat.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/chat.js')>()),
  canSeeRoom: vi.fn(async () => true)
}))
vi.mock('../../../services/chat-records.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/chat-records.js')>()),
  resolveRoomRecord: vi.fn(async () => null)
}))

import { db } from '../../../db/index.js'
import { chatRoutes } from '../../../routes/chat.js'
import { ChatSendError, postChatMessage } from '../../../services/chat-send.js'
import { loadVisibleMessage } from '../../../services/ops-room-guard.js'

/** chat_messages honours the ops_only filter; users are admins only when who.admin. */
function fakeDb() {
  vi.mocked(db).mockImplementation(((name: string) => {
    const table = String(name).split(' ')[0]
    let hidesOps = false
    const b = Object.assign(Promise.resolve([]), {}) as Promise<unknown> & Record<string, unknown>
    const self = () => b
    b.where = vi.fn((a: unknown) => {
      if (typeof a === 'function') (a as (x: unknown) => void)(b)
      return b
    })
    b.whereNull = vi.fn((col: string) => {
      if (String(col).endsWith('ops_only')) hidesOps = true
      return b
    })
    for (const m of ['orWhere', 'orWhereNull', 'join', 'whereIn', 'orderBy', 'select'])
      b[m] = vi.fn(self)
    b.first = vi.fn(async () => {
      if (table === 'chat_messages') return hidesOps ? undefined : OPS_POST
      if (table === 'nivaro_users') return undefined
      return undefined
    })
    return b
  }) as never)
}

async function toNotes() {
  const a = Fastify()
  await a.register(chatRoutes, { prefix: '/api/chat' })
  return a.inject({ method: 'POST', url: '/api/chat/messages/7/to-notes', payload: {} })
}

beforeEach(() => fakeDb())

describe('ops posts through single-message routes', () => {
  it('a non-admin cannot copy an ops post to notes — it is not found', async () => {
    who.admin = false
    const r = await toNotes()
    expect(r.statusCode).toBe(404)
  })
  it('an admin gets past the lookup (here: not a record room → 400, not 404)', async () => {
    who.admin = true
    const r = await toNotes()
    expect(r.statusCode).toBe(400)
  })
  it('reactions, pin and save answer 404 to a non-admin too', async () => {
    who.admin = false
    const a = Fastify()
    await a.register(chatRoutes, { prefix: '/api/chat' })
    for (const url of ['/messages/7/reactions', '/messages/7/pin', '/messages/7/save']) {
      const r = await a.inject({ method: 'POST', url: `/api/chat${url}`, payload: { emoji: '👍' } })
      expect(r.statusCode, url).toBe(404)
    }
  })
  it('the one rule: hidden for a non-admin, present for an admin', async () => {
    expect(await loadVisibleMessage(7, false)).toBeUndefined()
    expect(await loadVisibleMessage(7, true)).toEqual(OPS_POST)
  })
})

describe('ops posts as quote / thread targets', () => {
  const bob = { id: 'BOB', role: 'R' } as never
  it('a non-admin cannot quote an ops post', async () => {
    const err = await postChatMessage(
      {} as never,
      { user: bob, skipVisibility: true },
      { room: 'ch:ops', message: 'look at this', quoteId: 7 }
    ).catch((e) => e)
    expect(err).toBeInstanceOf(ChatSendError)
    expect(err.message).toMatch(/only quote a message from this conversation/)
  })
  it('a non-admin cannot reply in an ops post’s thread', async () => {
    const err = await postChatMessage(
      {} as never,
      { user: bob, skipVisibility: true },
      { room: 'ch:ops', message: 'me too', parentId: 7 }
    ).catch((e) => e)
    expect(err).toBeInstanceOf(ChatSendError)
    expect(err.message).toMatch(/thread is not in this conversation/)
  })
})
