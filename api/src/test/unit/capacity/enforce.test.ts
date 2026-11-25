import Fastify from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub capacity, idea 15: per-app limits enforced in the shared process — requests per minute
// (429 APP_RATE_LIMITED, Redis-counted, process-counted when Redis does not answer), job slots
// per app (FIFO wait, then skipped) and the storage quota on upload (413 APP_STORAGE_FULL).

const ctx = vi.hoisted(() => ({ tenant: undefined as string | undefined }))

vi.mock('../../../db/index.js', async () => {
  const knex = (await import('knex')).default
  const { sqliteAfterCreate, sqliteCompat } = await import('../../../db/sqlite.js')
  sqliteCompat()
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
  })
  return { db }
})
vi.mock('../../../services/deployment-mode.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/deployment-mode.js')>()),
  tenantSource: () => 'hub'
}))
vi.mock('../../../db/tenant-context.js', async (orig) => ({
  ...(await orig<typeof import('../../../db/tenant-context.js')>()),
  getTenantId: () => ctx.tenant
}))

const { db } = await import('../../../db/index.js')
const enforce = await import('../../../services/capacity/enforce.js')
const { setTenantRegistryForTests } = await import('../../../services/tenancy/registry.js')

import type { TenantRecord } from '../../../services/tenancy/types.js'

const tenant = (id: string, limits?: TenantRecord['limits']): TenantRecord => ({
  id,
  slug: id,
  name: id,
  status: 'active',
  dbClient: 'pg',
  dbConnection: `postgres://x/${id}`,
  poolMax: null,
  hostnames: [`${id}.example.com`],
  ...(limits ? { limits } : {})
})

const tenants = new Map<string, TenantRecord>()

beforeAll(async () => {
  await db.schema.createTable('nivaro_files', (t) => {
    t.string('id').primary()
    t.bigInteger('filesize')
  })
  setTenantRegistryForTests({
    source: 'hub',
    resolve: async () => null,
    listActive: async () => [...tenants.values()],
    byId: async (id) => tenants.get(id) ?? null,
    status: () => ({ source: 'hub', count: 0, loadedAt: null, stale: false, lastError: null })
  })
})

afterAll(async () => {
  setTenantRegistryForTests(null)
  await db.destroy()
})

beforeEach(() => {
  enforce._resetEnforceForTests()
  enforce._setLimitRedisForTests(null)
  tenants.clear()
  ctx.tenant = undefined
})

describe('job slots per app', () => {
  it('an app with no limit runs every turn at once; counts are kept', async () => {
    const t = tenant('a')
    expect(await enforce.acquireAppJobSlot(t)).toBe(true)
    expect(await enforce.acquireAppJobSlot(t)).toBe(true)
    expect(enforce.appJobCounts('a')).toEqual({ running: 2, waiting: 0 })
    enforce.releaseAppJobSlot('a')
    enforce.releaseAppJobSlot('a')
    expect(enforce.appJobCounts('a')).toEqual({ running: 0, waiting: 0 })
  })

  it('past its limit a turn waits for a slot, first come first served', async () => {
    const t = tenant('b', { jobs: 1 })
    expect(await enforce.acquireAppJobSlot(t, 1000)).toBe(true)
    const order: string[] = []
    const w1 = enforce.acquireAppJobSlot(t, 1000).then((g) => order.push(`w1:${g}`))
    const w2 = enforce.acquireAppJobSlot(t, 1000).then((g) => order.push(`w2:${g}`))
    expect(enforce.appJobCounts('b')).toEqual({ running: 1, waiting: 2 })
    enforce.releaseAppJobSlot('b')
    await w1
    enforce.releaseAppJobSlot('b')
    await w2
    expect(order).toEqual(['w1:true', 'w2:true'])
    // Another app is never held by this one's limit.
    expect(await enforce.acquireAppJobSlot(tenant('c', { jobs: 1 }), 10)).toBe(true)
  })

  it('a turn that waits too long is refused (skipped by the fan-out)', async () => {
    const t = tenant('d', { jobs: 1 })
    await enforce.acquireAppJobSlot(t, 1000)
    expect(await enforce.acquireAppJobSlot(t, 20)).toBe(false)
    expect(enforce.appJobCounts('d').waiting).toBe(0)
  })
})

describe('requests per minute', () => {
  it('counts only API paths that are not probes or Hub links', () => {
    expect(enforce.rateLimitCounts('/api/items/x')).toBe(true)
    expect(enforce.rateLimitCounts('/api/health')).toBe(false)
    expect(enforce.rateLimitCounts('/api/version?x=1')).toBe(false)
    expect(enforce.rateLimitCounts('/api/hub-deployment/usage')).toBe(false)
    expect(enforce.rateLimitCounts('/assets/app.js')).toBe(false)
  })

  it('counts in Redis when it answers, alone when it does not', async () => {
    const counts = new Map<string, number>()
    const chain = (key: { k: string }) => {
      const m = {
        incr: (k: string) => {
          key.k = k
          return m
        },
        pexpire: () => m,
        exec: async (): Promise<Array<[Error | null, unknown]>> => {
          const n = (counts.get(key.k) ?? 0) + 1
          counts.set(key.k, n)
          return [
            [null, n],
            [null, 1]
          ]
        }
      }
      return m
    }
    enforce._setLimitRedisForTests({ multi: () => chain({ k: '' }) })
    expect(await enforce.countAppRequest('a', 1)).toBe(1)
    expect(await enforce.countAppRequest('a', 1)).toBe(2)
    expect(counts.get('nvr:applimit:rpm:a:1')).toBe(2)
    const down = {
      incr: () => down,
      pexpire: () => down,
      exec: async (): Promise<Array<[Error | null, unknown]>> => {
        throw new Error('down')
      }
    }
    enforce._setLimitRedisForTests({ multi: () => down })
    expect(await enforce.countAppRequest('a', 1)).toBe(1)
    expect(await enforce.countAppRequest('a', 1)).toBe(2)
    expect(await enforce.countAppRequest('b', 1)).toBe(1)
  })

  it('answers 429 APP_RATE_LIMITED past the limit, with Retry-After', async () => {
    tenants.set('shop', tenant('shop', { requests_per_minute: 10 }))
    tenants.set('free', tenant('free'))
    const app = Fastify()
    app.addHook('onRequest', async (req) => {
      ctx.tenant = String(req.headers['x-tenant'] ?? '')
    })
    app.addHook('onRequest', enforce.appRateLimitHook)
    app.get('/api/items/x', async () => ({ ok: true }))
    app.get('/api/health', async () => ({ ok: true }))
    const codes: number[] = []
    for (let i = 0; i < 12; i++)
      codes.push(
        (await app.inject({ url: '/api/items/x', headers: { 'x-tenant': 'shop' } })).statusCode
      )
    expect(codes.filter((c) => c === 200)).toHaveLength(10)
    const refused = await app.inject({ url: '/api/items/x', headers: { 'x-tenant': 'shop' } })
    expect(refused.statusCode).toBe(429)
    expect(refused.json().code).toBe('APP_RATE_LIMITED')
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0)
    // Probes still answer; an app without a limit is never counted.
    expect(
      (await app.inject({ url: '/api/health', headers: { 'x-tenant': 'shop' } })).statusCode
    ).toBe(200)
    for (let i = 0; i < 15; i++)
      expect(
        (await app.inject({ url: '/api/items/x', headers: { 'x-tenant': 'free' } })).statusCode
      ).toBe(200)
    await app.close()
  })
})

describe('storage quota', () => {
  it('refuses an upload that would pass the app storage limit (413 APP_STORAGE_FULL)', async () => {
    await db('nivaro_files').insert({ id: 'f1', filesize: 900 * 1024 })
    tenants.set('s', tenant('s', { storage_mb: 1 }))
    ctx.tenant = 's'
    await expect(enforce.assertAppStorageRoom(100 * 1024)).resolves.toBeUndefined()
    // The first upload counted at once: the second no longer fits.
    await expect(enforce.assertAppStorageRoom(100 * 1024)).rejects.toMatchObject({
      statusCode: 413,
      code: 'APP_STORAGE_FULL'
    })
  })

  it('no limit, no check (and nothing outside an app)', async () => {
    tenants.set('n', tenant('n'))
    ctx.tenant = 'n'
    await expect(enforce.assertAppStorageRoom(10 ** 12)).resolves.toBeUndefined()
    ctx.tenant = undefined
    await expect(enforce.assertAppStorageRoom(10 ** 12)).resolves.toBeUndefined()
  })
})
