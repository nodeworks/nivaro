import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

process.env.MCP_PUBLIC_URL = 'https://nivaro.example'

const state = vi.hoisted(() => ({
  /** Every DELETE the fake database ran (SQL + bindings). */
  deletes: [] as Array<{ sql: string; bindings: unknown[] }>,
  activity: [] as Array<Record<string, unknown>>,
  /** The phone push row ids a SELECT on nivaro_push_subscriptions finds (IN lists honoured). */
  pushRows: [] as number[],
  /** Account status per user id (default active) and their static tokens. */
  status: {} as Record<string, string>,
  staticTokens: {} as Record<string, string>,
  policy: null as Record<string, unknown> | null,
  /** nivaro_api_keys rows by id. */
  /** The database refusing DELETEs. */
  delFails: false,
  /** Owner of a push row (default Pat). */
  rowUser: {} as Record<number, string>,
  apiKeys: {} as Record<
    string,
    { id: number; user: string; is_active: boolean; expires_at: string | null }
  >
}))

const PAT_ID = 'AAAAAAAA-0000-4000-8000-000000000001'
vi.mock('../db/index.js', async () => {
  const { makeFakeDb } = await import('../test/fake-sql.js')
  const db = makeFakeDb((q) => {
    if (q.method === 'del') {
      if (state.delFails) throw new Error('database refused')
      state.deletes.push({ sql: q.sql, bindings: q.bindings })
      return 1
    }
    if (q.sql.includes('nivaro_users') && (q.method === 'first' || q.method === 'select')) {
      const id = q.bindings.find((b) => typeof b === 'string' && /^[0-9A-F]{8}-/i.test(b)) as
        | string
        | undefined
      const status = id ? (state.status[id.toUpperCase()] ?? 'active') : 'active'
      const wantsActive = q.bindings.includes('active')
      const row =
        id && (!wantsActive || status === 'active')
          ? { id, status, role: null, static_token: state.staticTokens[id.toUpperCase()] ?? null }
          : undefined
      return q.method === 'first' ? row : row ? [row] : []
    }
    if (q.sql.includes('nivaro_api_keys') && q.method === 'first') {
      // `select top (?) … where [id] = ?`: the id is the last binding.
      const id = q.bindings[q.bindings.length - 1]
      return id != null ? state.apiKeys[String(id)] : undefined
    }
    if (q.method === 'select' && q.sql.includes('nivaro_push_subscriptions')) {
      const inList = /\bin \(/i.test(q.sql)
      return state.pushRows
        .filter((id) => !inList || q.bindings.includes(id))
        .map((id) => ({ id, user: state.rowUser[id] ?? PAT_ID }))
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
vi.mock('../services/session-policy.js', async (orig) => ({
  ...(await orig<object>()),
  getSessionPolicy: vi.fn(async () => state.policy)
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
        getdel(k: string) {
          ops.push(() => r.getdel(k))
          return m
        },
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
  state.pushRows = []
  state.status = {}
  state.staticTokens = {}
  state.policy = null
  state.apiKeys = {}
  state.delFails = false
  state.rowUser = {}
  delete process.env.MOBILE_SIGNIN
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
    state.pushRows = [3, 4]
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

  it('a retried sign-out never silences the same install signed in again (row 50 kept)', async () => {
    state.pushRows = [50, 51]
    const old = await phone(PAT, 'Phone', [50])
    const { db } = await import('../db/index.js')
    const spy = vi
      .spyOn(db.client as never, '_query' as never)
      .mockRejectedValueOnce(new Error('down') as never)
    await endDeviceGrant(redis as never, old.grant.id, 'removed') // outage → leftover [50]
    spy.mockRestore()
    expect([...(redis.sets.get('nvr:device-push-leftover:') ?? [])]).toHaveLength(1)
    // The person signs in again on that install: row 50 is registered on the new sign-in.
    // (No registration stamp here: the live sign-in's push set alone must keep it.)
    const again = await phone(PAT, 'Phone', [50])
    // An unrelated sign-out runs the retry.
    const other = await phone(SAM, "Sam's Pixel", [51])
    await endDeviceGrant(redis as never, other.grant.id, 'removed')
    const deleted = pushDeletes().flatMap((d) => d.bindings)
    expect(deleted).not.toContain(50)
    expect(deleted).toContain(51)
    expect([...(redis.sets.get('nvr:device-push-leftover:') ?? [])]).toEqual([])
    expect(await store.getGrant(redis as never, again.grant.id)).not.toBeNull()
  })

  it('a retried sign-out keeps a row the person registered again from a browser session', async () => {
    const { notePhoneRegistered } = await import('../services/device-grants.js')
    state.pushRows = [52]
    const old = await phone(PAT, 'Phone', [52])
    const { db } = await import('../db/index.js')
    const spy = vi
      .spyOn(db.client as never, '_query' as never)
      .mockRejectedValueOnce(new Error('down') as never)
    await endDeviceGrant(redis as never, old.grant.id, 'removed')
    spy.mockRestore()
    // Registered again from a browser session that is still signed in: no grant holds it, so the
    // stamp (later than the failed sign-out, by a live credential) keeps it.
    redis.kv.set('sess:live-web', JSON.stringify({ userId: PAT }))
    const t = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000)
    await notePhoneRegistered(redis as never, 52, 'sid:live-web')
    t.mockRestore()
    const other = await phone(SAM, 'Other', [])
    await endDeviceGrant(redis as never, other.grant.id, 'removed')
    expect(pushDeletes().flatMap((d) => d.bindings)).not.toContain(52)
  })

  it('a damaged leftover entry is dropped', async () => {
    const { retryLeftoverPushRows } = await import('../services/device-grants.js')
    await redis.sadd('nvr:device-push-leftover:', 'not json')
    await redis.sadd('nvr:device-push-leftover:', JSON.stringify({ u: PAT }))
    await retryLeftoverPushRows(redis as never)
    expect([...(redis.sets.get('nvr:device-push-leftover:') ?? [])]).toEqual([])
    expect(pushDeletes()).toEqual([])
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
  /** Phone A (a grant, row 1), phone B (row 2, registered under session sB), web session C
   *  (row 3, registered under session sC) — all Pat's. */
  async function three() {
    const { notePhoneRegistered } = await import('../services/device-grants.js')
    const { revokeUserSessions } = await import('../auth/session.js')
    state.pushRows = [1, 2, 3]
    for (const sid of ['sB', 'sC']) redis.kv.set(`sess:${sid}`, JSON.stringify({ userId: PAT }))
    const a = await phone(PAT, 'Phone A', [1])
    await notePhoneRegistered(redis as never, 1, `grant:${a.grant.id}`)
    await notePhoneRegistered(redis as never, 2, 'sid:sB')
    await notePhoneRegistered(redis as never, 3, 'sid:sC')
    const deleted = () => pushDeletes().flatMap((d) => d.bindings)
    return { a, revokeUserSessions, deleted }
  }

  it('everywhere else from web session C: B’s row goes, C’s own row stays', async () => {
    const { revokeUserSessions, deleted } = await three()
    await revokeUserSessions(redis as never, PAT, { except: 'sC' })
    expect(deleted()).toEqual(expect.arrayContaining([1, 2]))
    expect(deleted()).not.toContain(3)
    expect(redis.kv.has('sess:sC')).toBe(true)
  })

  it('everywhere else from phone A: B’s and C’s rows go, A’s row stays', async () => {
    const { a, revokeUserSessions, deleted } = await three()
    await revokeUserSessions(redis as never, PAT, { exceptDeviceGrant: a.grant.id })
    expect(deleted()).toEqual(expect.arrayContaining([2, 3]))
    expect(deleted()).not.toContain(1)
    expect(await store.getGrant(redis as never, a.grant.id)).not.toBeNull()
  })

  it('a full sign-out deletes every phone row, whatever its stamp', async () => {
    const { revokeUserSessions, deleted } = await three()
    state.pushRows = [1, 2, 3, 4] // 4: no stamp, no grant recorded it
    await revokeUserSessions(redis as never, PAT)
    expect(deleted()).toEqual(expect.arrayContaining([1, 2, 3, 4]))
  })

  it('a row a grant registers mid-sweep goes when that grant is ended in the same sweep', async () => {
    const { endUserDeviceGrants, notePhoneRegistered } = await import(
      '../services/device-grants.js'
    )
    state.pushRows = [9]
    const g = await phone(PAT, 'Phone')
    // While the sweep ends the grant, the phone registers row 9 under it (not yet in its set).
    redis.beforeExec = () => notePhoneRegistered(redis as never, 9, `grant:${g.grant.id}`)
    expect(await endUserDeviceGrants(redis as never, PAT)).toBe(1)
    expect(pushDeletes().flatMap((d) => d.bindings)).toContain(9)
  })

  describe('rows a static token or API key registered (the EFP app signs in with these)', () => {
    async function lasting() {
      const { notePhoneRegistered, staticTokenStamp } = await import('../services/device-grants.js')
      const { revokeUserSessions } = await import('../auth/session.js')
      state.pushRows = [21, 22]
      state.staticTokens[PAT] = 'pat-static-token-abc'
      state.apiKeys['7'] = { id: 7, user: PAT, is_active: true, expires_at: null }
      redis.kv.set('sess:sC', JSON.stringify({ userId: PAT }))
      await notePhoneRegistered(redis as never, 21, staticTokenStamp('pat-static-token-abc'))
      await notePhoneRegistered(redis as never, 22, 'key:7')
      return { revokeUserSessions, deleted: () => pushDeletes().flatMap((d) => d.bindings) }
    }

    it('survive sign-out-others and an admin session sign-out', async () => {
      const { revokeUserSessions, deleted } = await lasting()
      await revokeUserSessions(redis as never, PAT, { except: 'sC', full: false })
      await revokeUserSessions(redis as never, PAT, { full: false })
      expect(deleted()).not.toContain(21)
      expect(deleted()).not.toContain(22)
    })

    it('go once that token or key is revoked', async () => {
      const { revokeUserSessions, deleted } = await lasting()
      state.staticTokens[PAT] = 'a-new-token-after-regenerate'
      state.apiKeys['7'].is_active = false
      await revokeUserSessions(redis as never, PAT, { except: 'sC', full: false })
      expect(deleted()).toEqual(expect.arrayContaining([21, 22]))
    })

    it('an expired key is not live either', async () => {
      const { revokeUserSessions, deleted } = await lasting()
      state.apiKeys['7'].expires_at = new Date(Date.now() - 1000).toISOString()
      await revokeUserSessions(redis as never, PAT, { full: false })
      expect(deleted()).toContain(22)
      expect(deleted()).not.toContain(21)
    })

    it('the hourly sweep removes rows whose token or key stopped working', async () => {
      const { sweepEndedCredentialRows } = await import('../services/device-grants.js')
      const { deleted } = await lasting()
      state.staticTokens[PAT] = 'regenerated'
      expect(await sweepEndedCredentialRows(redis as never)).toBe(1)
      expect(deleted()).toContain(21)
      expect(deleted()).not.toContain(22)
    })

    it('a full "sign out everywhere" takes them too', async () => {
      const { revokeUserSessions, deleted } = await lasting()
      await revokeUserSessions(redis as never, PAT)
      expect(deleted()).toEqual(expect.arrayContaining([21, 22]))
    })
  })

  it('a stamp after the sweep keeps a row only while its credential is signed in', async () => {
    const { notePhoneRegistered, retryLeftoverPushRows } = await import(
      '../services/device-grants.js'
    )
    state.pushRows = [7, 8]
    const live = await phone(PAT, 'Live phone') // signed in; its set does not hold row 8
    const at = Date.now()
    const t = vi.spyOn(Date, 'now').mockReturnValue(at + 5000)
    await notePhoneRegistered(redis as never, 8, `grant:${live.grant.id}`)
    await notePhoneRegistered(redis as never, 7, 'grant:00000000-0000-4000-8000-00000000dead')
    t.mockRestore()
    await redis.sadd('nvr:device-push-leftover:', JSON.stringify({ u: PAT, at }))
    await retryLeftoverPushRows(redis as never)
    const deleted = pushDeletes().flatMap((d) => d.bindings)
    expect(deleted).toContain(7)
    expect(deleted).not.toContain(8)
  })

  it('a row stamped after the sweep by a session that was revoked since goes', async () => {
    const { notePhoneRegistered, retryLeftoverPushRows } = await import(
      '../services/device-grants.js'
    )
    state.pushRows = [11]
    // The session still has its row, but `sess:revoked:` is set: it is signed out.
    redis.kv.set('sess:sR', JSON.stringify({ userId: PAT }))
    redis.kv.set('sess:revoked:sR', '1')
    const at = Date.now()
    const t = vi.spyOn(Date, 'now').mockReturnValue(at + 5000)
    await notePhoneRegistered(redis as never, 11, 'sid:sR')
    t.mockRestore()
    await redis.sadd('nvr:device-push-leftover:', JSON.stringify({ u: PAT, at }))
    await retryLeftoverPushRows(redis as never)
    expect(pushDeletes().flatMap((d) => d.bindings)).toContain(11)
  })

  it('a stamp is checked against its credential once', async () => {
    const { notePhoneRegistered, retryLeftoverPushRows } = await import(
      '../services/device-grants.js'
    )
    state.pushRows = [14]
    const gone = 'grant:00000000-0000-4000-8000-0000000000aa'
    const at = Date.now()
    const t = vi.spyOn(Date, 'now').mockReturnValue(at + 5000)
    await notePhoneRegistered(redis as never, 14, gone)
    t.mockRestore()
    let checks = 0
    const exists = redis.exists
    redis.exists = async (k: string) => {
      if (k.endsWith('0000000000aa')) checks++
      return exists(k)
    }
    // Kept AND stamped after `at`: both rules would ask.
    await redis.sadd('nvr:device-push-leftover:', JSON.stringify({ u: PAT, at, keep: [gone] }))
    await retryLeftoverPushRows(redis as never)
    expect(checks).toBe(1)
    expect(pushDeletes().flatMap((d) => d.bindings)).toContain(14)
  })

  it('a kept credential keeps its row only while it is still signed in', async () => {
    const { notePhoneRegistered, retryLeftoverPushRows } = await import(
      '../services/device-grants.js'
    )
    state.pushRows = [12, 13]
    redis.kv.set('sess:sLive', JSON.stringify({ userId: PAT }))
    await notePhoneRegistered(redis as never, 12, 'sid:sLive')
    await notePhoneRegistered(redis as never, 13, 'sid:sGone') // no session any more
    const at = Date.now() + 5000
    await redis.sadd(
      'nvr:device-push-leftover:',
      JSON.stringify({ u: PAT, at, keep: ['sid:sLive', 'sid:sGone'] })
    )
    await retryLeftoverPushRows(redis as never)
    const deleted = pushDeletes().flatMap((d) => d.bindings)
    expect(deleted).toContain(13)
    expect(deleted).not.toContain(12)
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
    expect(first.statusCode).toBe(200)
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

describe('a replayed phone refresh token, the database refusing', () => {
  it('keeps the push rows for a retry (deleteOrKeep)', async () => {
    const a = await phone(PAT, 'Phone', [42])
    const refresh = () =>
      app.inject({
        method: 'POST',
        url: '/oauth/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: a.refresh_token,
          client_id: 'nivaro-mobile'
        }).toString()
      })
    expect((await refresh()).statusCode).toBe(200)
    for (const [k, v] of redis.kv)
      if (k.includes(':rt-spent:')) redis.kv.set(k, JSON.stringify({ ...JSON.parse(v), at: 0 }))
    state.delFails = true
    expect((await refresh()).json().error_description).toMatch(/already used/)
    expect(await store.getGrant(redis as never, a.grant.id)).toBeNull()
    const kept = [...(redis.sets.get('nvr:device-push-leftover:') ?? [])].map((x) => JSON.parse(x))
    expect(kept).toEqual([expect.objectContaining({ u: PAT, ids: [42] })])
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

describe('a phone sign-in that ends with no action (credential lifecycle)', () => {
  const listed = async (userId = PAT) =>
    ((await app.inject({ url: '/api/auth/devices', ...as(userId) })).json().data ?? []).map(
      (d: { id: string }) => d.id
    )
  /** device-revoked entries saying `sign-in expired`. */
  const expiredLogs = () =>
    state.activity.filter(
      (a) => a.action === 'device-revoked' && String(a.comment).includes('sign-in expired')
    )
  const hashOf = async (t: string) => (await import('../lib/oauth.js')).hashToken(t)

  it('a refresh token that lapsed: off the list, its push rows go, logged as expired', async () => {
    const p = await phone(PAT, 'Lapsed', [61])
    const live = await phone(PAT, 'Live', [62])
    // The 30-day refresh token expired (its key is gone) and no rotation is under way.
    redis.kv.delete(`nvr:oauth:rt:${await hashOf(p.refresh_token)}`)
    expect(await listed()).toEqual([live.grant.id])
    expect(await store.getGrant(redis as never, p.grant.id)).toBeNull()
    expect(pushDeletes().flatMap((d) => d.bindings)).toContain(61)
    expect(pushDeletes().flatMap((d) => d.bindings)).not.toContain(62)
    expect(expiredLogs()).toHaveLength(1)
  })

  it('idle past the role’s policy without being used: ended on the next list', async () => {
    const p = await phone(PAT, 'Idle', [63])
    const g = JSON.parse(redis.kv.get(`nvr:oauth:grant:${p.grant.id}`) as string)
    g.created_at = new Date(Date.now() - 3 * 3_600_000).toISOString()
    redis.kv.set(`nvr:oauth:grant:${p.grant.id}`, JSON.stringify(g))
    state.policy = { idle_minutes: 60 }
    expect(await listed()).toEqual([])
    expect(await store.getGrant(redis as never, p.grant.id)).toBeNull()
    expect(pushDeletes().flatMap((d) => d.bindings)).toContain(63)
  })

  it('an account that is no longer active: its phones end (admin list)', async () => {
    const p = await phone(SAM, 'Sam phone', [64])
    state.status[SAM] = 'suspended'
    const res = await app.inject({
      url: `/api/users/${SAM}/devices`,
      ...as(ADMIN, { 'x-admin': '1' })
    })
    expect(res.json().data).toEqual([])
    expect(await store.getGrant(redis as never, p.grant.id)).toBeNull()
    expect(pushDeletes().flatMap((d) => d.bindings)).toContain(64)
  })

  it('MOBILE_SIGNIN=off: every phone sign-in ends, with its alerts', async () => {
    const p = await phone(PAT, 'Phone', [65])
    process.env.MOBILE_SIGNIN = 'off'
    expect(await listed()).toEqual([])
    expect(await store.getGrant(redis as never, p.grant.id)).toBeNull()
    expect(pushDeletes().flatMap((d) => d.bindings)).toContain(65)
  })

  it('the sweep (where crons tick) ends them without anyone listing', async () => {
    const { sweepDeviceGrants } = await import('../services/device-grants.js')
    const p = await phone(SAM, 'Sam phone', [66])
    const keep = await phone(PAT, 'Pat phone', [67])
    state.status[SAM] = 'suspended'
    expect(await sweepDeviceGrants(redis as never)).toBe(1)
    expect(await store.getGrant(redis as never, p.grant.id)).toBeNull()
    expect(await store.getGrant(redis as never, keep.grant.id)).not.toBeNull()
    expect(pushDeletes().flatMap((d) => d.bindings)).toContain(66)
  })

  it('a grant mid-rotation (refresh just spent) is not taken for lapsed', async () => {
    const p = await phone(PAT, 'Rotating')
    await store.consumeRefreshChecked(redis as never, p.refresh_token)
    expect(await listed()).toEqual([p.grant.id])
  })

  it('a refresh refused because the account is inactive ends the grant', async () => {
    const p = await phone(PAT, 'Phone', [68])
    state.status[PAT] = 'suspended'
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: p.refresh_token,
        client_id: 'nivaro-mobile'
      }).toString()
    })
    expect(res.statusCode).toBe(400)
    expect(await store.getGrant(redis as never, p.grant.id)).toBeNull()
    expect(pushDeletes().flatMap((d) => d.bindings)).toContain(68)
  })

  it('grant keys live as long as the refresh token (plus a margin), renewed on refresh', async () => {
    const ttls = new Map<string, number>()
    const expire = redis.expire
    ;(redis as unknown as { expire: (k: string, s: number) => Promise<number> }).expire = async (
      k: string,
      s: number
    ) => {
      ttls.set(k, s)
      return expire()
    }
    const p = await phone(PAT, 'Phone', [69])
    const { DEVICE_GRANT_MARGIN_S, REFRESH_TTL_S } = store
    expect(ttls.get(`nvr:oauth:grant:${p.grant.id}`)).toBe(REFRESH_TTL_S + DEVICE_GRANT_MARGIN_S)
    expect(ttls.get(`nvr:oauth:grant-push:${p.grant.id}`)).toBe(
      REFRESH_TTL_S + DEVICE_GRANT_MARGIN_S
    )
    await store.setDeviceGrantLife(redis as never, p.grant.id, 3600)
    expect(ttls.get(`nvr:oauth:grant:${p.grant.id}`)).toBe(3600 + DEVICE_GRANT_MARGIN_S)
    expect(ttls.get(`nvr:oauth:grant-push:${p.grant.id}`)).toBe(3600 + DEVICE_GRANT_MARGIN_S)
  })
})
