import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

process.env.MCP_PUBLIC_URL = 'https://nivaro.example'

const state = vi.hoisted(() => ({
  /** Every DELETE the fake database ran (SQL + bindings). */
  deletes: [] as Array<{ sql: string; bindings: unknown[] }>,
  activity: [] as Array<Record<string, unknown>>
}))

vi.mock('../db/index.js', async () => {
  const { makeFakeDb } = await import('../test/fake-sql.js')
  const db = makeFakeDb((q) => {
    if (q.method === 'del') {
      state.deletes.push({ sql: q.sql, bindings: q.bindings })
      return 1
    }
    return q.method === 'first' ? undefined : []
  })
  return { db }
})
vi.mock('../services/activity.js', () => ({
  logActivity: vi.fn(async (a: Record<string, unknown>) => {
    state.activity.push(a)
    return 1
  })
}))
vi.mock('../admin-base.js', async (orig) => ({
  ...(await orig<object>()),
  servesAdminSpa: false
}))
vi.mock('../middleware/authenticate.js', () => {
  type Req = {
    headers: Record<string, string | undefined>
    user?: unknown
    isAdmin?: boolean
    deviceGrantId?: string
  }
  const sign = async (req: Req) => {
    const id = req.headers['x-user']
    if (!id) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = { id, status: 'active' }
    req.isAdmin = req.headers['x-admin'] === '1'
    if (req.headers['x-grant']) req.deviceGrantId = req.headers['x-grant']
  }
  return {
    authenticate: vi.fn(sign),
    requireAuth: vi.fn(sign),
    requireAdmin: vi.fn(
      async (req: Req, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
        await sign(req)
        if (!req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })
      }
    )
  }
})

const { deviceRoutes } = await import('./devices.js')
const { oauthConnectionRoutes, oauthPublicRoutes } = await import('./oauth.js')
const store = await import('../services/oauth-store.js')
const { endDeviceGrant } = await import('../services/device-grants.js')

const PAT = 'AAAAAAAA-0000-4000-8000-000000000001'
const SAM = 'BBBBBBBB-0000-4000-8000-000000000002'
const ADMIN = 'CCCCCCCC-0000-4000-8000-000000000003'

/** Just enough Redis for the store (SET honours XX, as the store relies on it). */
function fakeRedis() {
  const kv = new Map<string, string>()
  const sets = new Map<string, Set<string>>()
  const r = {
    kv,
    sets,
    /** Runs once before the next MULTI's commands (to interleave another request). */
    beforeExec: null as null | (() => Promise<unknown>),
    get: async (k: string) => kv.get(k) ?? null,
    mget: async (...ks: string[]) => ks.map((k) => kv.get(k) ?? null),
    set: async (k: string, v: string, ...flags: string[]) => {
      if (flags.includes('XX') && !kv.has(k)) return null
      kv.set(k, v)
      return 'OK'
    },
    setex: async (k: string, _t: number, v: string) => {
      kv.set(k, v)
      return 'OK'
    },
    getdel: async (k: string) => {
      const v = kv.get(k) ?? null
      kv.delete(k)
      return v
    },
    del: async (...ks: string[]) => ks.filter((k) => kv.delete(k) || sets.delete(k)).length,
    exists: async (k: string) => (kv.has(k) ? 1 : 0),
    expire: async () => 1,
    incr: async (k: string) => {
      const n = Number(kv.get(k) ?? 0) + 1
      kv.set(k, String(n))
      return n
    },
    scan: async (_c: string, _m: string, pattern: string) => {
      const re = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`)
      return ['0', [...kv.keys()].filter((k) => re.test(k))]
    },
    smembers: async (k: string) => [...(sets.get(k) ?? [])],
    sadd: async (k: string, m: string) => {
      const s = sets.get(k) ?? new Set()
      s.add(m)
      sets.set(k, s)
      return 1
    },
    srem: async (k: string, m: string) => (sets.get(k)?.delete(m) ? 1 : 0),
    multi: () => {
      const ops: Array<() => Promise<unknown>> = []
      const m = {
        set(k: string, v: string, ...flags: string[]) {
          ops.push(() => r.set(k, v, ...flags))
          return m
        },
        setex(k: string, t: number, v: string) {
          ops.push(() => r.setex(k, t, v))
          return m
        },
        sadd(k: string, v: string) {
          ops.push(() => r.sadd(k, v))
          return m
        },
        srem(k: string, v: string) {
          ops.push(() => r.srem(k, v))
          return m
        },
        del(k: string) {
          ops.push(() => r.del(k))
          return m
        },
        smembers(k: string) {
          ops.push(() => r.smembers(k))
          return m
        },
        exec: async () => {
          const hook = r.beforeExec
          r.beforeExec = null
          if (hook) await hook()
          const out: unknown[] = []
          for (const o of ops) out.push(await o())
          return out
        }
      }
      return m
    }
  }
  return r
}

let app: FastifyInstance
let redis = fakeRedis()

beforeAll(async () => {
  app = Fastify()
  app.decorate('redis', new Proxy({}, { get: (_t, p) => (redis as never)[p] }) as never)
  app.decorateRequest('session', null as never)
  await app.register(oauthPublicRoutes)
  await app.register(
    async (api) => {
      await api.register(deviceRoutes)
      await api.register(oauthConnectionRoutes)
    },
    { prefix: '/api' }
  )
  await app.ready()
})
afterAll(() => app.close())
beforeEach(() => {
  redis = fakeRedis()
  state.deletes = []
  state.activity = []
})

const mobile = { client_id: 'nivaro-mobile', client_name: 'Nivaro' }

/** A phone signed in: its grant (with push rows) and tokens. */
async function phone(userId: string, device_name: string, push_ids: number[] = []) {
  const grant = await store.createDeviceGrant(redis as never, userId, mobile, {
    device_name,
    platform: 'ios'
  })
  for (const id of push_ids) await store.addGrantPushId(redis as never, grant.id, id)
  const tokens = await store.issueTokens(
    redis as never,
    { grant_id: grant.id, user_id: userId, client_id: mobile.client_id, resource: null },
    'device'
  )
  return { grant, ...tokens }
}
const as = (userId: string, extra: Record<string, string> = {}) => ({
  headers: { 'x-user': userId, ...extra }
})
const pushDeletes = () => state.deletes.filter((d) => d.sql.includes('nivaro_push_subscriptions'))

describe('Signed-in phones', () => {
  it('lists only the caller’s phones (never an MCP connection), marking the calling one', async () => {
    const a = await phone(PAT, "Pat's iPhone")
    const b = await phone(PAT, "Pat's iPad")
    await phone(SAM, "Sam's Pixel")
    await store.upsertGrant(redis as never, PAT, { client_id: 'nvc_x', client_name: 'Claude' })
    const res = await app.inject({
      url: '/api/auth/devices',
      ...as(PAT, { 'x-grant': a.grant.id })
    })
    expect(res.statusCode).toBe(200)
    const rows = res.json().data as Array<Record<string, unknown>>
    expect(rows.map((r) => r.id).sort()).toEqual([a.grant.id, b.grant.id].sort())
    expect(rows.find((r) => r.id === a.grant.id)).toEqual({
      id: a.grant.id,
      client_name: 'Nivaro',
      device_name: "Pat's iPhone",
      platform: 'ios',
      created_at: a.grant.created_at,
      last_used_at: null,
      current: true
    })
    expect(rows.find((r) => r.id === b.grant.id)?.current).toBe(false)
  })

  it('last_used_at follows the grant’s use', async () => {
    const a = await phone(PAT, 'Phone')
    await store.resolveAccessToken(redis as never, a.access_token, 'device')
    const res = await app.inject({ url: '/api/auth/devices', ...as(PAT) })
    expect(res.json().data[0].last_used_at).toEqual(expect.any(String))
  })

  it('another person’s phone id through the self route → 404, and it stays signed in', async () => {
    const sam = await phone(SAM, "Sam's Pixel", [5])
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/auth/devices/${sam.grant.id}`,
      ...as(PAT)
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('DEVICE_NOT_FOUND')
    expect(
      await store.resolveAccessToken(redis as never, sam.access_token, 'device')
    ).not.toBeNull()
    expect(pushDeletes()).toEqual([])
  })

  it('an MCP connection id through the self route → 404', async () => {
    const g = await store.upsertGrant(redis as never, PAT, { client_id: 'nvc_x', client_name: 'X' })
    const res = await app.inject({ method: 'DELETE', url: `/api/auth/devices/${g.id}`, ...as(PAT) })
    expect(res.statusCode).toBe(404)
    expect(await store.getGrant(redis as never, g.id)).not.toBeNull()
  })

  it('signing out my phone ends its tokens and deletes its push rows (mine, phone rows only)', async () => {
    const a = await phone(PAT, "Pat's iPhone", [11, 12])
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/auth/devices/${a.grant.id}`,
      ...as(PAT)
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    // The next call with that token is refused (authenticate answers 401 on a null record).
    expect(await store.resolveAccessToken(redis as never, a.access_token, 'device')).toBeNull()
    expect(await store.consumeRefresh(redis as never, a.refresh_token)).toBeNull()
    const [del] = pushDeletes()
    expect(del.bindings).toEqual(expect.arrayContaining([11, 12, PAT]))
    expect(del.sql).toMatch(/endpoint.*like/i)
    expect(state.activity[0]).toMatchObject({ action: 'device-revoked', user: PAT, item: PAT })
    const list = await app.inject({ url: '/api/auth/devices', ...as(PAT) })
    expect(list.json().data).toEqual([])
  })

  it('a database error still ends the credential; the push rows are retried on the next sign-out', async () => {
    const a = await phone(PAT, 'Phone', [3])
    const b = await phone(PAT, 'Tablet', [4])
    const { db } = await import('../db/index.js')
    const spy = vi
      .spyOn(db.client as never, '_query' as never)
      .mockRejectedValueOnce(new Error('down') as never)
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/auth/devices/${a.grant.id}`,
      ...as(PAT)
    })
    spy.mockRestore()
    expect(res.statusCode).toBe(200)
    expect(await store.resolveAccessToken(redis as never, a.access_token, 'device')).toBeNull()
    expect(pushDeletes()).toEqual([])
    expect([...(redis.sets.get('nvr:device-push-leftover:') ?? [])]).toHaveLength(1)
    // The next phone sign-out deletes its own rows and the kept ones.
    await endDeviceGrant(redis as never, b.grant.id, 'removed')
    const ids = pushDeletes().flatMap((d) => d.bindings)
    expect(ids).toEqual(expect.arrayContaining([3, 4]))
    expect([...(redis.sets.get('nvr:device-push-leftover:') ?? [])]).toEqual([])
  })

  it('a push id noted while the grant is touched for use is never lost (no read-modify-write)', async () => {
    const a = await phone(PAT, 'Phone')
    // Make the next use rewrite the grant JSON (last use > 1 minute ago)…
    const key = `nvr:oauth:grant:${a.grant.id}`
    redis.kv.set(
      key,
      JSON.stringify({
        ...JSON.parse(redis.kv.get(key) as string),
        last_used_at: '2020-01-01T00:00:00Z'
      })
    )
    // …and register a push row between its read and its write.
    redis.beforeExec = () => store.addGrantPushId(redis as never, a.grant.id, 77)
    await store.resolveAccessToken(redis as never, a.access_token, 'device')
    expect(JSON.parse(redis.kv.get(key) as string).last_used_at).not.toBe('2020-01-01T00:00:00Z')
    await endDeviceGrant(redis as never, a.grant.id, 'removed')
    expect(pushDeletes()[0].bindings).toEqual(expect.arrayContaining([77, PAT]))
  })

  it('one install’s row belongs to its latest sign-in: ending the stale one keeps it', async () => {
    const stale = await phone(PAT, 'Phone (old sign-in)', [50])
    const live = await phone(PAT, 'Phone', [50])
    await endDeviceGrant(redis as never, stale.grant.id, 'removed')
    expect(pushDeletes()).toEqual([])
    await endDeviceGrant(redis as never, live.grant.id, 'removed')
    expect(pushDeletes()[0].bindings).toEqual(expect.arrayContaining([50, PAT]))
  })

  it('a push id noted after the grant ended says so (the caller deletes the row)', async () => {
    const a = await phone(PAT, 'Phone')
    redis.beforeExec = () => store.takeGrant(redis as never, PAT, a.grant.id)
    expect(await store.addGrantPushId(redis as never, a.grant.id, 88)).toBe(false)
    expect(redis.sets.get(`nvr:oauth:grant-push:${a.grant.id}`)?.size ?? 0).toBe(0)
  })
})

describe('an administrator signs a person’s phone out', () => {
  it('lists the person’s phones (any id case) and refuses non-admins', async () => {
    const s = await phone(SAM, "Sam's Pixel")
    const res = await app.inject({
      url: `/api/users/${SAM.toLowerCase()}/devices`,
      ...as(ADMIN, { 'x-admin': '1' })
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.map((r: { id: string }) => r.id)).toEqual([s.grant.id])
    expect((await app.inject({ url: `/api/users/${SAM}/devices`, ...as(PAT) })).statusCode).toBe(
      403
    )
    // `current` is the calling phone — never true on someone else's list.
    const odd = await app.inject({
      url: `/api/users/${SAM}/devices`,
      ...as(ADMIN, { 'x-admin': '1', 'x-grant': s.grant.id })
    })
    expect(odd.json().data[0].current).toBe(false)
  })

  it('removes it with its push rows, logged as device-revoked with admin_id', async () => {
    const s = await phone(SAM, "Sam's Pixel", [21])
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/users/${SAM}/devices/${s.grant.id}`,
      ...as(ADMIN, { 'x-admin': '1' })
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(await store.resolveAccessToken(redis as never, s.access_token, 'device')).toBeNull()
    expect(pushDeletes()[0].bindings).toEqual(expect.arrayContaining([21, SAM]))
    expect(state.activity[0]).toMatchObject({
      action: 'device-revoked',
      user: ADMIN,
      item: SAM,
      comment: expect.stringContaining(`admin_id ${ADMIN}`)
    })
  })

  it('a phone of someone else under this person’s id → 404', async () => {
    const p = await phone(PAT, 'Phone')
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/users/${SAM}/devices/${p.grant.id}`,
      ...as(ADMIN, { 'x-admin': '1' })
    })
    expect(res.statusCode).toBe(404)
    expect(await store.getGrant(redis as never, p.grant.id)).not.toBeNull()
  })
})

describe('signing a person out on every phone', () => {
  it('also deletes all their phone push rows (backstop), but not when one phone stays', async () => {
    const { endUserDeviceGrants } = await import('../services/device-grants.js')
    const a = await phone(PAT, 'Phone', [61])
    const b = await phone(PAT, 'Tablet')
    expect(await endUserDeviceGrants(redis as never, PAT, { except: b.grant.id })).toBe(1)
    expect(pushDeletes()).toHaveLength(1)
    expect(pushDeletes()[0].bindings).toEqual(expect.arrayContaining([61, PAT]))
    state.deletes = []
    expect(await endUserDeviceGrants(redis as never, PAT)).toBe(1)
    const all = pushDeletes().at(-1)
    expect(all?.bindings).toContain(PAT)
    expect(all?.sql).not.toMatch(/\bin\b/i)
    expect(all?.sql).toMatch(/endpoint.*like/i)
    void a
  })
})

describe('the app signing out (POST /oauth/revoke)', () => {
  const revoke = (token: string) =>
    app.inject({
      method: 'POST',
      url: '/oauth/revoke',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ token }).toString()
    })

  it('with its access token ends the whole sign-in: refresh too, push rows, off the list', async () => {
    const a = await phone(PAT, 'Phone', [31])
    expect((await revoke(a.access_token)).statusCode).toBe(200)
    expect(await store.getGrant(redis as never, a.grant.id)).toBeNull()
    expect(await store.consumeRefresh(redis as never, a.refresh_token)).toBeNull()
    expect(pushDeletes()[0].bindings).toEqual(expect.arrayContaining([31, PAT]))
    expect((await app.inject({ url: '/api/auth/devices', ...as(PAT) })).json().data).toEqual([])
  })

  it('with its refresh token does the same', async () => {
    const a = await phone(PAT, 'Phone', [32])
    expect((await revoke(a.refresh_token)).statusCode).toBe(200)
    expect(await store.getGrant(redis as never, a.grant.id)).toBeNull()
    expect(await store.resolveAccessToken(redis as never, a.access_token, 'device')).toBeNull()
    expect(pushDeletes()).toHaveLength(1)
  })

  it('an MCP token revokes only that token, never the connection', async () => {
    const g = await store.upsertGrant(redis as never, PAT, { client_id: 'nvc_x', client_name: 'X' })
    const t = await store.issueTokens(redis as never, {
      grant_id: g.id,
      user_id: PAT,
      client_id: 'nvc_x',
      resource: null
    })
    expect((await revoke(t.access_token)).statusCode).toBe(200)
    expect(await store.getGrant(redis as never, g.id)).not.toBeNull()
    expect(pushDeletes()).toEqual([])
  })
})

describe('a replayed phone refresh token', () => {
  it('ends the sign-in and its push rows', async () => {
    const a = await phone(PAT, 'Phone', [41])
    const first = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: a.refresh_token,
        client_id: 'nivaro-mobile'
      }).toString()
    })
    // The account read is mocked away (no users): the token is spent either way.
    expect(first.statusCode).toBe(400)
    // Move the spent stamp past the grace window, then replay.
    for (const [k, v] of redis.kv)
      if (k.includes(':rt-spent:')) redis.kv.set(k, JSON.stringify({ ...JSON.parse(v), at: 0 }))
    const replay = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: a.refresh_token,
        client_id: 'nivaro-mobile'
      }).toString()
    })
    expect(replay.json().error_description).toMatch(/already used/)
    expect(await store.getGrant(redis as never, a.grant.id)).toBeNull()
    expect(pushDeletes()[0].bindings).toEqual(expect.arrayContaining([41, PAT]))
  })
})

describe('MCP connection lists never show a phone', () => {
  it('/api/oauth/connections lists the MCP grant only, and will not remove a phone', async () => {
    const p = await phone(PAT, 'Phone')
    const g = await store.upsertGrant(redis as never, PAT, { client_id: 'nvc_x', client_name: 'X' })
    const res = await app.inject({ url: '/api/oauth/connections', ...as(PAT) })
    expect(res.json().data.map((c: { id: string }) => c.id)).toEqual([g.id])
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/oauth/connections/${p.grant.id}`,
      ...as(PAT)
    })
    expect(del.statusCode).toBe(404)
    expect(await store.getGrant(redis as never, p.grant.id)).not.toBeNull()
  })

  it('the store filters by kind (legacy grants with no kind are MCP)', async () => {
    const p = await phone(PAT, 'Phone')
    const g = await store.upsertGrant(redis as never, PAT, { client_id: 'nvc_x', client_name: 'X' })
    // A grant stored before kinds existed.
    const legacy = { ...g, id: '11111111-0000-4000-8000-000000000009' } as Record<string, unknown>
    delete legacy.kind
    redis.kv.set(`nvr:oauth:grant:${legacy.id}`, JSON.stringify(legacy))
    await redis.sadd(`nvr:oauth:user:${PAT}`, String(legacy.id))
    const mcp = (await store.listGrants(redis as never, PAT, 'mcp')).map((x) => x.id).sort()
    expect(mcp).toEqual([g.id, legacy.id].sort())
    const all = (await store.listAllGrants(redis as never, undefined, 'mcp')).map((x) => x.id)
    expect(all.sort()).toEqual([g.id, legacy.id].sort())
    expect((await store.listGrants(redis as never, PAT, 'device')).map((x) => x.id)).toEqual([
      p.grant.id
    ])
    expect(await store.getGrant(redis as never, p.grant.id, 'mcp')).toBeNull()
    expect(await store.revokeGrant(redis as never, PAT, p.grant.id, 'mcp')).toBe(false)
  })
})

describe('push ids on a device grant', () => {
  it('are noted once each, only on device grants, never recreating a revoked grant', async () => {
    const p = await phone(
      PAT,
      'Phone',
      [1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]
    )
    const g = await store.upsertGrant(redis as never, PAT, { client_id: 'nvc_x', client_name: 'X' })
    expect(await store.addGrantPushId(redis as never, g.id, 9)).toBe(true)
    expect(redis.sets.has(`nvr:oauth:grant-push:${g.id}`)).toBe(false)
    const ended = await store.takeGrant(redis as never, PAT, p.grant.id)
    // No cap: every row the sign-in made is handed back.
    expect(ended?.push_ids?.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 21 }, (_, i) => i + 1)
    )
    expect(redis.sets.has(`nvr:oauth:grant-push:${p.grant.id}`)).toBe(false)
    expect(await store.addGrantPushId(redis as never, p.grant.id, 3)).toBe(false)
    expect(redis.kv.has(`nvr:oauth:grant:${p.grant.id}`)).toBe(false)
  })
})
