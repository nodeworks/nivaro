import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 6 Task 9 — what a move needs from a dedicated hub-linked app: the Hub's strict
// maintenance (no admin exempt), retire (503 APP_MOVED everywhere but the hub link, the file
// transfer and the probes; no cron ticks), and boot maintenance once per move id. Real
// security.ts + maintenance-freeze.ts + retire.ts over an in-memory Redis; the database answers
// "maintenance off" from the settings row.

type Caller = { isAdmin?: boolean; authMethod?: string; account_kind?: string | null }
const st = vi.hoisted(() => ({
  store: new Map<string, string>(),
  caller: null as null | { isAdmin?: boolean; authMethod?: string; account_kind?: string | null },
  startLeaderElection: null as null | ((...a: unknown[]) => unknown),
  redisDown: false
}))

const redis = {
  get: async (k: string) => {
    if (st.redisDown) throw new Error('redis down')
    return st.store.get(k) ?? null
  },
  set: async (k: string, v: string) => {
    if (st.redisDown) throw new Error('redis down')
    st.store.set(k, v)
    return 'OK'
  },
  del: async (k: string) => {
    if (st.redisDown) throw new Error('redis down')
    return st.store.delete(k) ? 1 : 0
  }
}

vi.mock('../../../db/index.js', () => {
  const db = () => {
    const chain = {
      where: () => chain,
      first: async () => ({ maintenance_mode: false, maintenance_message: null }),
      catch: () => chain
    }
    return chain
  }
  return { db, _backgroundDb: null, _staticDb: null, resolveDb: () => db }
})
vi.mock('../../../services/io-holder.js', () => ({
  getApp: () => ({
    redis,
    cron: { startLeaderElection: (...a: unknown[]) => st.startLeaderElection?.(...a) }
  }),
  getIo: () => null
}))
vi.mock('../../../services/record-events.js', () => ({ announceToTenant: () => {} }))
vi.mock('../../../config.js', () => ({ config: { NODE_ENV: 'production' } }))
vi.mock('../../../routes/preflight.js', () => ({
  runPreflight: async () => ({ status: 'ok', checks: [] })
}))
vi.mock('../../../services/readiness.js', () => ({ readReadiness: async () => ({ score: 90 }) }))
vi.mock('../../../services/pool-attribution.js', () => ({ poolCounters: () => null }))
vi.mock('../../../services/instance-key.js', () => ({ instanceKey: () => 'production' }))
vi.mock('../../../services/hub-link/shared-readiness.js', () => ({
  computeSharedReadiness: async () => ({ codes: [], key_fp: null })
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: FastifyRequest) => {
    const c = st.caller
    if (!c) return
    req.user = { id: 'U1', role: 'R', account_kind: c.account_kind ?? null } as never
    req.isAdmin = c.isAdmin ?? false
    req.authMethod = c.authMethod as never
  })
}))

const { hubLinkRoutes, _resetHubLinkForTests } = await import('../../../routes/hub-link.js')
const { maintenanceFreezeHook } = await import('../../../services/maintenance-freeze.js')
const security = await import('../../../services/security.js')
const retire = await import('../../../services/hub-link/retire.js')
const { cronTicksEnabled } = await import('../../../services/cron-ticks.js')
const live = await import('../../../services/maintenance-live.js')

const TOKEN = 'k'.repeat(40)
const HUMAN_ADMIN: Caller = { isAdmin: true, authMethod: 'session' }
const auth = { authorization: `Bearer ${TOKEN}` }
const saved = { ...process.env }
let app: FastifyInstance | null = null

async function build(): Promise<FastifyInstance> {
  const a = Fastify()
  a.addHook('preHandler', maintenanceFreezeHook)
  await a.register(
    async (f) => {
      await f.register(hubLinkRoutes, { prefix: '/hub-link' })
      f.get('/version', async () => ({ version: 'x' }))
      f.get('/items/:c', async () => ({ data: [] }))
      f.patch('/items/:c/:id', async () => ({ ok: true }))
      f.get('/hub-transfer/files/:id', async () => ({ file: true }))
      f.post('/hub-transfer/files/ticket', async () => ({ ticket: true }))
    },
    { prefix: '/api' }
  )
  await a.ready()
  app = a
  return a
}

beforeEach(() => {
  st.store.clear()
  st.caller = null
  st.redisDown = false
  st.startLeaderElection = vi.fn()
  process.env.HUB_TOKEN = TOKEN
  process.env.CRON_TICKS = 'on'
  delete process.env.CLOUD_META_DB_URL
  delete process.env.HUB_SHARED_DEPLOYMENT
  _resetHubLinkForTests()
  retire._resetRetiredForTests()
  security.bustMaintenanceCache()
  live._resetMaintenanceLive()
})

afterEach(async () => {
  await app?.close()
  app = null
  live.stopMaintenanceWatch()
  retire._resetRetiredForTests()
  process.env = { ...saved }
})

const patchAsAdmin = (a: FastifyInstance) => {
  st.caller = HUMAN_ADMIN
  return a.inject({ method: 'PATCH', url: '/api/items/workflows/1', payload: {} })
}

describe('strict maintenance over the hub link', () => {
  it('POST /maintenance {on:true} refuses even a human admin on their own session', async () => {
    const a = await build()
    const on = await a.inject({
      method: 'POST',
      url: '/api/hub-link/maintenance',
      headers: auth,
      payload: { on: true, message: 'Moving.' }
    })
    expect(on.statusCode).toBe(200)
    expect(JSON.parse(st.store.get('nvr:maintenance') as string)).toMatchObject({
      on: true,
      display: 'page',
      strict: true,
      hub: true,
      message: 'Moving.'
    })
    const res = await patchAsAdmin(a)
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ code: 'MAINTENANCE' })
  })

  it('a plain override without strict still exempts the admin (unchanged)', async () => {
    st.store.set('nvr:maintenance', JSON.stringify({ on: true, message: 'Rebuild' }))
    const a = await build()
    expect((await patchAsAdmin(a)).statusCode).toBe(200)
    st.caller = { isAdmin: true, authMethod: 'token', account_kind: 'integration' }
    const tok = await a.inject({ method: 'PATCH', url: '/api/items/workflows/1', payload: {} })
    expect(tok.statusCode).toBe(503)
  })

  it('hub-link status and the file transfer answer during it; off lifts it at once', async () => {
    const a = await build()
    await a.inject({
      method: 'POST',
      url: '/api/hub-link/maintenance',
      headers: auth,
      payload: { on: true }
    })
    const status = await a.inject({ method: 'GET', url: '/api/hub-link/status', headers: auth })
    expect(status.statusCode).toBe(200)
    expect(status.json()).toMatchObject({ maintenance: true, retired: false })
    expect((await a.inject({ method: 'GET', url: '/api/hub-transfer/files/9' })).statusCode).toBe(
      200
    )
    expect(
      (await a.inject({ method: 'POST', url: '/api/hub-transfer/files/ticket', payload: {} }))
        .statusCode
    ).toBe(200)
    // The Hub lifts it again (a write on the hub link, itself exempt from the freeze), and this
    // process forgets its cached state at once (ruling R14).
    const off = await a.inject({
      method: 'POST',
      url: '/api/hub-link/maintenance',
      headers: auth,
      payload: { on: false }
    })
    expect(off.statusCode).toBe(200)
    expect(st.store.has('nvr:maintenance')).toBe(false)
    expect((await patchAsAdmin(a)).statusCode).toBe(200)
  })

  it("off never removes an operator's own freeze", async () => {
    st.store.set('nvr:maintenance', JSON.stringify({ on: true, message: 'Rebuild' }))
    const a = await build()
    await a.inject({
      method: 'POST',
      url: '/api/hub-link/maintenance',
      headers: auth,
      payload: { on: false }
    })
    expect(st.store.has('nvr:maintenance')).toBe(true)
  })

  it("an admin's End maintenance leaves the Hub's freeze in place", async () => {
    const a = await build()
    await a.inject({
      method: 'POST',
      url: '/api/hub-link/maintenance',
      headers: auth,
      payload: { on: true }
    })
    await security.clearMaintenanceOverride()
    expect(st.store.has('nvr:maintenance')).toBe(true)
  })

  it('refuses a bad body and answers 503 when Redis refuses', async () => {
    const a = await build()
    for (const payload of [
      {},
      { on: 'yes' },
      { on: true, move_id: -1 },
      { on: true, message: 5 }
    ]) {
      const r = await a.inject({
        method: 'POST',
        url: '/api/hub-link/maintenance',
        headers: auth,
        payload
      })
      expect(r.statusCode, JSON.stringify(payload)).toBe(400)
    }
    st.redisDown = true
    const r = await a.inject({
      method: 'POST',
      url: '/api/hub-link/maintenance',
      headers: auth,
      payload: { on: true }
    })
    expect(r.statusCode).toBe(503)
    expect(r.json()).toMatchObject({ code: 'REDIS_UNAVAILABLE' })
  })
})

describe('retire', () => {
  it('POST /retire → APP_MOVED everywhere but the probes and the hub link; no cron ticks', async () => {
    const a = await build()
    expect(cronTicksEnabled()).toBe(true)
    const r = await a.inject({
      method: 'POST',
      url: '/api/hub-link/retire',
      headers: auth,
      payload: { move_id: 7 }
    })
    expect(r.statusCode).toBe(200)
    expect(JSON.parse(st.store.get('nvr:hub:retired') as string)).toMatchObject({ move_id: 7 })

    const read = await a.inject({ method: 'GET', url: '/api/items/x' })
    expect(read.statusCode).toBe(503)
    expect(read.json()).toMatchObject({ code: 'APP_MOVED' })
    // An administrator is no exception.
    expect((await patchAsAdmin(a)).json()).toMatchObject({ code: 'APP_MOVED' })
    expect((await a.inject({ method: 'GET', url: '/api/version' })).statusCode).toBe(200)
    expect((await a.inject({ method: 'GET', url: '/api/hub-transfer/files/1' })).statusCode).toBe(
      200
    )
    const status = await a.inject({ method: 'GET', url: '/api/hub-link/status', headers: auth })
    expect(status.statusCode).toBe(200)
    expect(status.json().retired).toBe(true)
    expect(cronTicksEnabled()).toBe(false)
  })

  it('DELETE /retire restores both and rejoins the scheduler', async () => {
    const a = await build()
    await a.inject({
      method: 'POST',
      url: '/api/hub-link/retire',
      headers: auth,
      payload: { move_id: 7 }
    })
    const d = await a.inject({ method: 'DELETE', url: '/api/hub-link/retire', headers: auth })
    expect(d.statusCode).toBe(200)
    expect(d.json()).toEqual({ retired: false })
    expect(st.store.has('nvr:hub:retired')).toBe(false)
    expect((await a.inject({ method: 'GET', url: '/api/items/x' })).statusCode).toBe(200)
    expect(cronTicksEnabled()).toBe(true)
    expect(st.startLeaderElection).toHaveBeenCalledWith(redis)
    const status = await a.inject({ method: 'GET', url: '/api/hub-link/status', headers: auth })
    expect(status.json().retired).toBe(false)
  })

  it('another replica follows the flag from Redis (boot read and the 5 s refresh)', async () => {
    st.store.set('nvr:hub:retired', JSON.stringify({ move_id: 3 }))
    await retire.startRetiredWatch(redis as never)
    expect(retire.isRetiredSync()).toBe(true)
    expect(cronTicksEnabled()).toBe(false)
    st.store.delete('nvr:hub:retired')
    await retire.refreshRetired(redis as never)
    expect(retire.isRetiredSync()).toBe(false)
    // A Redis error keeps the last known state.
    st.store.set('nvr:hub:retired', '{}')
    await retire.refreshRetired(redis as never)
    st.redisDown = true
    await retire.refreshRetired(redis as never)
    expect(retire.isRetiredSync()).toBe(true)
  })

  it('needs a move id', async () => {
    const a = await build()
    const r = await a.inject({
      method: 'POST',
      url: '/api/hub-link/retire',
      headers: auth,
      payload: {}
    })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ code: 'BAD_MOVE_ID' })
    expect(retire.isRetiredSync()).toBe(false)
  })
})

describe('boot maintenance (HUB_BOOT_MAINTENANCE)', () => {
  it('sets the strict override once per move id; the release stops a restart setting it again', async () => {
    const env = { HUB_BOOT_MAINTENANCE: '12' } as NodeJS.ProcessEnv
    expect(await security.applyHubBootMaintenance(redis, env)).toBe(true)
    expect(JSON.parse(st.store.get('nvr:maintenance') as string)).toMatchObject({
      on: true,
      strict: true,
      hub: true,
      move_id: 12
    })
    // A restart before the release: still in maintenance.
    expect(await security.applyHubBootMaintenance(redis, env)).toBe(true)

    const a = await build()
    expect((await patchAsAdmin(a)).statusCode).toBe(503)
    const off = await a.inject({
      method: 'POST',
      url: '/api/hub-link/maintenance',
      headers: auth,
      payload: { on: false, move_id: 12 }
    })
    expect(off.statusCode).toBe(200)
    expect(st.store.has('nvr:hub:boot-maintenance-done:12')).toBe(true)
    expect(st.store.has('nvr:maintenance')).toBe(false)

    // The restart after the release does not set it again; another move's id would.
    expect(await security.applyHubBootMaintenance(redis, env)).toBe(false)
    expect(st.store.has('nvr:maintenance')).toBe(false)
    expect(
      await security.applyHubBootMaintenance(redis, {
        HUB_BOOT_MAINTENANCE: '13'
      } as NodeJS.ProcessEnv)
    ).toBe(true)
  })

  it('ignores an unset or malformed value', async () => {
    for (const v of [undefined, '', '0', 'abc', '-4', '1.5'])
      expect(
        await security.applyHubBootMaintenance(redis, { HUB_BOOT_MAINTENANCE: v } as never)
      ).toBe(false)
    expect(st.store.size).toBe(0)
  })
})

describe('mounting and the bearer', () => {
  const ROUTES = [
    ['POST', '/api/hub-link/maintenance'],
    ['POST', '/api/hub-link/retire'],
    ['DELETE', '/api/hub-link/retire'],
    ['GET', '/api/hub-link/shared-readiness']
  ] as const

  it('without HUB_TOKEN none of the routes exist', async () => {
    delete process.env.HUB_TOKEN
    const a = await build()
    for (const [method, url] of ROUTES) {
      const r = await a.inject({ method, url, headers: auth, payload: { on: true, move_id: 1 } })
      expect(r.statusCode, `${method} ${url}`).toBe(404)
    }
    expect(st.store.size).toBe(0)
  })

  it('on a shared deployment (multi-tenant) none of the routes exist', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
    const a = await build()
    for (const [method, url] of ROUTES) {
      const r = await a.inject({ method, url, headers: auth, payload: { on: true, move_id: 1 } })
      expect(r.statusCode, `${method} ${url}`).toBe(404)
    }
  })

  it('a wrong bearer is refused before anything is written', async () => {
    const a = await build()
    for (const [method, url] of ROUTES) {
      const r = await a.inject({
        method,
        url,
        headers: { authorization: `Bearer ${'x'.repeat(40)}` },
        payload: { on: true, move_id: 1 }
      })
      expect(r.statusCode, `${method} ${url}`).toBe(401)
    }
    expect(st.store.size).toBe(0)
    expect(retire.isRetiredSync()).toBe(false)
  })

  it('GET /shared-readiness answers the report', async () => {
    const a = await build()
    const r = await a.inject({
      method: 'GET',
      url: '/api/hub-link/shared-readiness',
      headers: auth
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ codes: [], key_fp: null })
  })
})
