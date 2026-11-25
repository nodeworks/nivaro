import Fastify from 'fastify'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub capacity, idea 9 (app side): per-app request counts in one-minute buckets, every replica's
// snapshot summed, and the usage routes beside each link with the link's own bearer.

const ctx = vi.hoisted(() => ({ tenant: '' }))
vi.mock('../../../services/tenant-rooms.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/tenant-rooms.js')>()),
  currentTenantKey: () => ctx.tenant
}))

const usage = await import('../../../services/capacity/app-usage.js')

import type { ProcessSnapshot } from '../../../services/capacity/app-usage.js'

const { hubLinkUsageRoutes } = await import('../../../routes/hub-capacity-link.js')

const T0 = Date.UTC(2026, 10, 24, 12, 0, 0)

beforeEach(() => {
  usage._resetUsageForTests()
  usage._setUsageRedisForTests(null)
  ctx.tenant = ''
})
afterAll(() => usage._setUsageRedisForTests(undefined))

describe('per-app request buckets', () => {
  it('sums the last complete minute and the last 15 complete minutes, per app', () => {
    ctx.tenant = 'a'
    for (let m = 0; m < 20; m++) usage.noteAppRequest(100, 200, T0 + m * 60_000)
    usage.noteAppRequest(50, 503, T0 + 19 * 60_000)
    ctx.tenant = 'b'
    usage.noteAppRequest(10, 200, T0 + 19 * 60_000)
    const now = T0 + 20 * 60_000 + 5_000
    // Minutes 5..19 are the last 15 complete minutes; minute 19 is the last complete one.
    expect(usage.windowOf(usage._ringForTests('a'), now)).toEqual({
      req1: 2,
      req15: 16,
      ms15: 1550,
      err15: 1
    })
    expect(usage.windowOf(usage._ringForTests('b'), now)).toEqual({
      req1: 1,
      req15: 1,
      ms15: 10,
      err15: 0
    })
    // The minute under way is never counted.
    expect(usage.windowOf(usage._ringForTests('a'), T0 + 19 * 60_000 + 1).req1).toBe(1)
  })

  it('aggregates every replica: requests summed, pool size per process, CPU summed', () => {
    const snap = (instance: string, req15: number, used: number): ProcessSnapshot => ({
      instance,
      role: null,
      at: T0,
      cpu_pct: 25,
      memory_mb: 300,
      uptime_s: 10,
      apps: {
        a: { req1: 2, req15, ms15: req15 * 10, err15: 0, db: [used, 0, 5], jobs_waiting: 1 },
        b: { req1: 0, req15: 15, ms15: 150, err15: 15, db: null, jobs_waiting: 0 }
      }
    })
    const agg = usage.aggregate([snap('p1', 30, 2), snap('p2', 60, 1)], ['a', 'b', 'c'])
    expect(agg.totals).toEqual({
      cpu_pct: 50,
      memory_mb: 600,
      requests_per_min: 8,
      busy_ms_per_min: 80
    })
    const a = agg.apps.get('a')
    expect(a?.requests_per_min).toBe(6)
    expect(a?.requests_last_min).toBe(4)
    expect(a?.db).toEqual({ in_use: 3, waiting: 0, pool_max: 5, processes: 2 })
    expect(agg.apps.get('b')?.errors_per_min).toBe(2)
    // An app no replica has served yet still shows, at zero.
    expect(agg.apps.get('c')?.requests_per_min).toBe(0)
    expect(agg.processes).toHaveLength(2)
  })
})

describe('dedicated app snapshot and answer', () => {
  it('counts the one app and answers partial without Redis', async () => {
    const now = Date.now()
    usage.noteAppRequest(40, 200, now - 120_000)
    usage.noteAppRequest(60, 500, now - 120_000)
    const snap = await usage.buildSnapshot(now)
    expect(snap.apps[usage.DEDICATED_APP].req15).toBe(2)
    expect(snap.apps[usage.DEDICATED_APP].ms15).toBe(100)
    expect(snap.apps[usage.DEDICATED_APP].err15).toBe(1)
  })

  it('reads every fresh replica snapshot from Redis', async () => {
    const now = Date.now()
    const other: ProcessSnapshot = {
      instance: 'other',
      role: 'worker',
      at: now - 10_000,
      cpu_pct: 10,
      memory_mb: 200,
      uptime_s: 5,
      apps: { app: { req1: 30, req15: 450, ms15: 4500, err15: 0, db: [1, 0, 10], jobs_waiting: 0 } }
    }
    const stale = { ...other, instance: 'gone', at: now - 10 * 60_000 }
    usage._setUsageRedisForTests({
      set: async () => 'OK',
      zadd: async () => 1,
      zremrangebyscore: async () => 0,
      expire: async () => 1,
      zrangebyscore: async () => ['other', 'gone'],
      mget: async () => [JSON.stringify(other), JSON.stringify(stale)]
    })
    process.env.HUB_TOKEN = 'x'.repeat(40)
    const out = await usage.readUsage(now)
    delete process.env.HUB_TOKEN
    expect(out.partial).toBe(false)
    expect(out.processes.map((p) => p.instance)).toContain('other')
    expect(out.processes.map((p) => p.instance)).not.toContain('gone')
    expect(out.apps[0].id).toBe('app')
    expect(out.apps[0].requests_per_min).toBeGreaterThanOrEqual(30)
  })
})

describe('GET /api/hub-link/usage', () => {
  it('needs the hub token and answers figures only', async () => {
    process.env.HUB_TOKEN = 't'.repeat(40)
    const app = Fastify()
    await app.register(hubLinkUsageRoutes, { prefix: '/api/hub-link' })
    expect((await app.inject({ url: '/api/hub-link/usage' })).statusCode).toBe(401)
    const ok = await app.inject({
      url: '/api/hub-link/usage',
      headers: { authorization: `Bearer ${'t'.repeat(40)}` }
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.headers['cache-control']).toBe('no-store')
    const b = ok.json()
    expect(Object.keys(b).sort()).toEqual(
      ['apps', 'at', 'partial', 'processes', 'totals', 'version'].sort()
    )
    expect(b.apps[0].id).toBe('app')
    await app.close()
    delete process.env.HUB_TOKEN
  })

  it('is not mounted without a hub token', async () => {
    delete process.env.HUB_TOKEN
    const app = Fastify()
    await app.register(hubLinkUsageRoutes, { prefix: '/api/hub-link' })
    expect((await app.inject({ url: '/api/hub-link/usage' })).statusCode).toBe(404)
    await app.close()
  })
})
