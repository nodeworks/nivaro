import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  user: {
    id: 'AAAAAAAA-0000-4000-8000-000000000002',
    first_name: 'Jane',
    last_name: 'Roe'
  } as Record<string, unknown> | null,
  activity: [] as Array<Record<string, unknown>>,
  ended: [] as string[][]
}))
vi.mock('../../../db/index.js', () => ({
  db: () => ({ where: () => ({ first: async () => state.user }) })
}))
vi.mock('../../../services/activity.js', () => ({
  logActivity: async (a: Record<string, unknown>) => {
    state.activity.push(a)
    return 1
  }
}))
vi.mock('../../../services/socket-access.js', () => ({
  endSessionSockets: (sids: string[]) => state.ended.push(sids)
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'ADMIN000-0000-4000-8000-000000000001' }
    req.isAdmin = true
  },
  authenticate: async () => {}
}))

import { REVOKED_PREFIX, revokeUserSessions, sessionIdsForUser } from '../../../auth/session.js'
import { securityRoutes } from '../../../routes/security.js'

const JANE = 'aaaaaaaa-0000-4000-8000-000000000002'

function fakeRedis(seed: Record<string, string>) {
  const kv = new Map(Object.entries(seed))
  return {
    kv,
    async scan(cursor: string, _m: string, pattern: string) {
      const re = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`)
      const keys = [...kv.keys()].filter((k) => re.test(k))
      // two pages, to prove the cursor is followed
      const half = Math.ceil(keys.length / 2)
      return cursor === '0' ? ['1', keys.slice(0, half)] : ['0', keys.slice(half)]
    },
    async mget(...keys: string[]) {
      return keys.map((k) => kv.get(k) ?? null)
    },
    multi() {
      const ops: Array<() => void> = []
      const m = {
        del: (k: string) => {
          ops.push(() => kv.delete(k))
          return m
        },
        setex: (k: string, _t: number, v: string) => {
          ops.push(() => kv.set(k, v))
          return m
        },
        exec: async () => {
          for (const op of ops) op()
          return []
        }
      }
      return m
    }
  }
}

const seed = () => ({
  'sess:a1': JSON.stringify({ userId: 'AAAAAAAA-0000-4000-8000-000000000002' }),
  'sess:a2': JSON.stringify({ userId: JANE }),
  'sess:b1': JSON.stringify({ userId: 'bbbbbbbb-0000-4000-8000-000000000003' }),
  'sess:junk': 'not json',
  [`${REVOKED_PREFIX}old`]: '1'
})

describe('signing one person out everywhere', () => {
  beforeEach(() => {
    state.activity = []
    state.ended = []
    state.user = { id: JANE.toUpperCase(), first_name: 'Jane', last_name: 'Roe' }
  })

  it('finds every session of that person, any id case, across scan pages', async () => {
    const r = fakeRedis(seed())
    expect((await sessionIdsForUser(r as never, JANE)).sort()).toEqual(['a1', 'a2'])
    expect(await sessionIdsForUser(r as never, JANE, { except: 'a2' })).toEqual(['a1'])
  })

  it('revokes them (marker left, so a rolling save cannot bring one back) and leaves others', async () => {
    const r = fakeRedis(seed())
    expect(await revokeUserSessions(r as never, JANE)).toBe(2)
    expect(r.kv.has('sess:a1')).toBe(false)
    expect(r.kv.get(`${REVOKED_PREFIX}a1`)).toBe('1')
    expect(r.kv.has('sess:b1')).toBe(true)
  })

  it('POST /users/:id/sign-out revokes, logs who did it, and refuses yourself', async () => {
    const r = fakeRedis(seed())
    const app = Fastify()
    app.decorate('redis', r as never)
    await app.register(securityRoutes)
    const res = await app.inject({ method: 'POST', url: `/users/${JANE}/sign-out` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: { revoked: 2 } })
    expect(state.activity[0]).toMatchObject({
      action: 'sessions-revoke-user',
      collection: 'nivaro_users',
      item: JANE,
      comment: 'Jane Roe: 2 sessions signed out'
    })
    const self = await app.inject({
      method: 'POST',
      url: '/users/admin000-0000-4000-8000-000000000001/sign-out'
    })
    expect(self.statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/users/nope/sign-out' })).statusCode).toBe(400)
    state.user = null
    expect((await app.inject({ method: 'POST', url: `/users/${JANE}/sign-out` })).statusCode).toBe(
      404
    )
  })
})
