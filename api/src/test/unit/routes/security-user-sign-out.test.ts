import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  user: {
    id: 'AAAAAAAA-0000-4000-8000-000000000002',
    first_name: 'Jane',
    last_name: 'Roe'
  } as Record<string, unknown> | null,
  activity: [] as Array<Record<string, unknown>>,
  ended: [] as string[][],
  self: null as { id: string; deviceGrantId?: string } | null,
  pushDeletes: 0
}))
vi.mock('../../../db/index.js', () => {
  // users: .where().first(); phone push rows: .where({user}).where(fn).del() (the backstop)
  const q: Record<string, unknown> = {
    where: () => q,
    whereIn: () => q,
    first: async () => state.user,
    select: async () => [{ id: 1 }],
    del: async () => {
      state.pushDeletes++
      return 0
    }
  }
  return { db: () => q }
})
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
  authenticate: async (req: { user?: unknown; deviceGrantId?: string }) => {
    if (state.self) {
      req.user = { id: state.self.id }
      req.deviceGrantId = state.self.deviceGrantId
    }
  }
}))

import { REVOKED_PREFIX, revokeUserSessions, sessionIdsForUser } from '../../../auth/session.js'
import { securityRoutes, securitySelfRoutes } from '../../../routes/security.js'

const JANE = 'aaaaaaaa-0000-4000-8000-000000000002'

function fakeRedis(seed: Record<string, string>) {
  const kv = new Map(Object.entries(seed))
  const sets = new Map<string, Set<string>>()
  return {
    kv,
    sets,
    async get(k: string) {
      return kv.get(k) ?? null
    },
    async smembers(k: string) {
      return [...(sets.get(k) ?? [])]
    },
    async srem(k: string, m: string) {
      return sets.get(k)?.delete(m) ? 1 : 0
    },
    async sadd(k: string, m: string) {
      sets.set(k, (sets.get(k) ?? new Set()).add(m))
      return 1
    },
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
        srem: (k: string, v: string) => {
          ops.push(() => sets.get(k)?.delete(v))
          return m
        },
        smembers: (k: string) => {
          ops.push(() => [...(sets.get(k) ?? [])])
          return m
        },
        setex: (k: string, _t: number, v: string) => {
          ops.push(() => kv.set(k, v))
          return m
        },
        exec: async () => ops.map((op) => op())
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
    state.self = null
    state.pushDeletes = 0
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
      comment: 'Jane Roe: 2 sessions and phones signed out'
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

  /** A signed-in phone of `userId` (a device grant, as services/oauth-store.ts files it). */
  const addPhone = (r: ReturnType<typeof fakeRedis>, userId: string, id: string) => {
    r.kv.set(
      `nvr:oauth:grant:${id}`,
      JSON.stringify({
        id,
        user_id: userId,
        client_id: 'nivaro-mobile',
        client_name: 'Nivaro',
        kind: 'device',
        device_name: 'Phone',
        created_at: new Date().toISOString(),
        last_used_at: null,
        t: ''
      })
    )
    const key = `nvr:oauth:user:${userId}`
    r.sets.set(key, (r.sets.get(key) ?? new Set()).add(id))
  }
  const PHONE_1 = '11111111-0000-4000-8000-000000000001'
  const PHONE_2 = '22222222-0000-4000-8000-000000000002'
  const SAMS = '33333333-0000-4000-8000-000000000003'

  it("signs the person out on their phones too (any id case), and leaves others' phones", async () => {
    const r = fakeRedis(seed())
    addPhone(r, JANE.toUpperCase(), PHONE_1)
    addPhone(r, JANE.toUpperCase(), PHONE_2)
    addPhone(r, 'BBBBBBBB-0000-4000-8000-000000000003', SAMS)
    expect(await revokeUserSessions(r as never, JANE)).toBe(4)
    expect(r.kv.has(`nvr:oauth:grant:${PHONE_1}`)).toBe(false)
    expect(r.kv.has(`nvr:oauth:grant:${PHONE_2}`)).toBe(false)
    expect(r.kv.has(`nvr:oauth:grant:${SAMS}`)).toBe(true)
    // Every phone signed out: all of the person's phone push rows go too (the backstop).
    expect(state.pushDeletes).toBe(1)
  })

  it('an administrator signing someone out reaches their phones', async () => {
    const r = fakeRedis(seed())
    addPhone(r, JANE.toUpperCase(), PHONE_1)
    const app = Fastify()
    app.decorate('redis', r as never)
    await app.register(securityRoutes)
    const res = await app.inject({ method: 'POST', url: `/users/${JANE}/sign-out` })
    expect(res.json()).toEqual({ data: { revoked: 3 } })
    expect(r.kv.has(`nvr:oauth:grant:${PHONE_1}`)).toBe(false)
  })

  it('sign out everywhere else from a phone keeps that phone and ends the rest', async () => {
    const r = fakeRedis(seed())
    addPhone(r, JANE.toUpperCase(), PHONE_1)
    addPhone(r, JANE.toUpperCase(), PHONE_2)
    expect(await revokeUserSessions(r as never, JANE, { exceptDeviceGrant: PHONE_1 })).toBe(3)
    // One phone stays signed in: its rows are not swept with the backstop.
    expect(state.pushDeletes).toBe(0)
    expect(r.kv.has(`nvr:oauth:grant:${PHONE_1}`)).toBe(true)
    expect(r.kv.has(`nvr:oauth:grant:${PHONE_2}`)).toBe(false)
    // Everywhere else from a session (maybe a phone app on a cookie): no sweep either.
    addPhone(r, JANE.toUpperCase(), PHONE_2)
    expect(await revokeUserSessions(r as never, JANE, { except: 'a1' })).toBe(2)
    expect(state.pushDeletes).toBe(0)
  })

  it('POST /my/sessions/sign-out-others passes the calling phone through', async () => {
    const r = fakeRedis(seed())
    addPhone(r, JANE.toUpperCase(), PHONE_1)
    addPhone(r, JANE.toUpperCase(), PHONE_2)
    state.self = { id: JANE.toUpperCase(), deviceGrantId: PHONE_2 }
    const app = Fastify()
    app.decorate('redis', r as never)
    await app.register(securitySelfRoutes)
    const res = await app.inject({ method: 'POST', url: '/my/sessions/sign-out-others' })
    expect(res.json()).toEqual({ data: { revoked: 3 } })
    expect(r.kv.has(`nvr:oauth:grant:${PHONE_2}`)).toBe(true)
    expect(r.kv.has(`nvr:oauth:grant:${PHONE_1}`)).toBe(false)
  })

  it('fails closed when the session scan never finishes', async () => {
    const r = fakeRedis(seed())
    let calls = 0
    r.scan = async () => {
      calls++
      return ['7', []] // a store whose cursor never returns to '0'
    }
    await expect(sessionIdsForUser(r as never, JANE)).rejects.toThrow(/did not finish/)
    expect(calls).toBe(50_000)
    const app = Fastify()
    app.decorate('redis', r as never)
    await app.register(securityRoutes)
    const res = await app.inject({ method: 'POST', url: `/users/${JANE}/sign-out` })
    expect(res.statusCode).toBe(503)
    expect(state.activity).toEqual([])
  })
})
