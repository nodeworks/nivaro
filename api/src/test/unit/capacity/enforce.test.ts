import Fastify, { type FastifyRequest } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub capacity, idea 15: per-app limits enforced in the shared process — requests per minute
// (429 APP_RATE_LIMITED, Redis-counted, process-counted when Redis does not answer), job slots
// per app (never held while waiting) and the storage quota (413 APP_STORAGE_FULL; presign off).

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
  it('an app with no limit runs every turn at once; counts are kept', () => {
    const t = tenant('a')
    expect(enforce.tryAcquireAppJobSlot(t)).toBe(true)
    expect(enforce.tryAcquireAppJobSlot(t)).toBe(true)
    expect(enforce.appJobCounts('a')).toEqual({ running: 2, waiting: 0 })
    enforce.releaseAppJobSlot('a')
    enforce.releaseAppJobSlot('a')
    expect(enforce.appJobCounts('a')).toEqual({ running: 0, waiting: 0 })
  })

  it('past its limit a turn is refused at once (it never waits holding anything)', () => {
    const t = tenant('b', { jobs: 1 })
    expect(enforce.tryAcquireAppJobSlot(t)).toBe(true)
    expect(enforce.tryAcquireAppJobSlot(t)).toBe(false)
    enforce.noteSlotWait('b', 1)
    expect(enforce.appJobCounts('b')).toEqual({ running: 1, waiting: 1 })
    enforce.releaseAppJobSlot('b')
    expect(enforce.tryAcquireAppJobSlot(t)).toBe(true)
    enforce.noteSlotWait('b', -1)
    expect(enforce.appJobCounts('b')).toEqual({ running: 1, waiting: 0 })
    // Another app is never held by this one's limit.
    expect(enforce.tryAcquireAppJobSlot(tenant('c', { jobs: 1 }))).toBe(true)
  })
})

describe('requests per minute', () => {
  it('counts only API paths that are not probes, sign-in or Hub links', () => {
    expect(enforce.rateLimitCounts('/api/items/x')).toBe(true)
    expect(enforce.rateLimitCounts('/api/health')).toBe(false)
    expect(enforce.rateLimitCounts('/api/version?x=1')).toBe(false)
    expect(enforce.rateLimitCounts('/api/auth/login')).toBe(false)
    expect(enforce.rateLimitCounts('/api/hub-deployment/usage')).toBe(false)
    expect(enforce.rateLimitCounts('/assets/app.js')).toBe(false)
  })

  it('counts in Redis when it answers, alone (and for a while) when it does not', async () => {
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
    expect(await enforce.countAppRequest('a', 1, 'anon:10.0.0.1')).toBe(1)
    expect(counts.get('nvr:applimit:rpm:a:app:1')).toBe(2)
    let calls = 0
    const down = {
      incr: () => down,
      pexpire: () => down,
      exec: async (): Promise<Array<[Error | null, unknown]>> => {
        calls++
        throw new Error('down')
      }
    }
    enforce._setLimitRedisForTests({ multi: () => down })
    expect(await enforce.countAppRequest('a', 1)).toBe(1)
    expect(await enforce.countAppRequest('a', 1)).toBe(2)
    expect(await enforce.countAppRequest('b', 1)).toBe(1)
    // After one failure Redis is left alone for a while (no wait on every request).
    expect(calls).toBe(1)
  })

  describe('the limiter, after the route’s authentication', () => {
    const app = Fastify()
    // A route's own authentication, as the real ones do it: `Bearer good-<id>` is a verified
    // user, `Bearer key-<n>` a verified API key; anything else verifies as nobody.
    const auth = async (req: FastifyRequest) => {
      const h = String(req.headers.authorization ?? '')
      const user = /^Bearer good-(\w+)$/.exec(h)
      if (user) (req as { user?: unknown }).user = { id: user[1] }
      const key = /^Bearer key-(\d+)$/.exec(h)
      if (key) {
        ;(req as { user?: unknown }).user = { id: 'svc' }
        ;(req as { apiKeyId?: number }).apiKeyId = Number(key[1])
      }
    }
    beforeAll(async () => {
      app.addHook('onRequest', async (req) => {
        ctx.tenant = String(req.headers['x-tenant'] ?? '')
        // A verified session, as the session plugin leaves it.
        const sid = req.headers['x-session-user']
        if (typeof sid === 'string') (req as { session?: unknown }).session = { userId: sid }
      })
      enforce.registerAppRateLimit(app)
      app.get('/api/items/x', { preHandler: auth }, async () => ({ ok: true }))
      // A route that requires sign-in: an unverified caller stops here with 401.
      app.get(
        '/api/secure',
        {
          preHandler: [
            auth,
            async (req, reply) => {
              const r = req as { user?: unknown; session?: { userId?: string } }
              if (!r.user && !r.session?.userId)
                return reply.code(401).send({ code: 'UNAUTHORIZED' })
            }
          ]
        },
        async () => ({ ok: true })
      )
      app.get('/api/forbidden', { preHandler: auth }, async (_req, reply) =>
        reply.code(403).send({ code: 'FORBIDDEN' })
      )
      app.get('/api/health', async () => ({ ok: true }))
      app.get('/api/auth/login', async () => ({ ok: true }))
      await app.ready()
    })
    afterAll(async () => {
      enforce._countInjectedForTests(false)
      await app.close()
    })
    beforeEach(() => enforce._countInjectedForTests(true))

    const get = (url: string, headers: Record<string, string>, ip = '10.0.0.1') =>
      app.inject({ url, headers, remoteAddress: ip })
    const as = (tenant: string, who?: string) => ({
      'x-tenant': tenant,
      ...(who ? { authorization: `Bearer ${who}` } : {})
    })

    it('answers 429 APP_RATE_LIMITED past one caller’s limit, with Retry-After', async () => {
      tenants.set('shop', tenant('shop', { requests_per_minute: 10 }))
      tenants.set('free', tenant('free'))
      const codes: number[] = []
      for (let i = 0; i < 12; i++)
        codes.push((await get('/api/items/x', as('shop', 'good-ann'))).statusCode)
      expect(codes.filter((c) => c === 200)).toHaveLength(10)
      const refused = await get('/api/items/x', as('shop', 'good-ann'))
      expect(refused.statusCode).toBe(429)
      expect(refused.json().code).toBe('APP_RATE_LIMITED')
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0)
      // Probes and sign-in still answer; an app without a limit is never counted.
      expect((await get('/api/health', as('shop'))).statusCode).toBe(200)
      expect((await get('/api/auth/login', as('shop'))).statusCode).toBe(200)
      for (let i = 0; i < 15; i++)
        expect((await get('/api/items/x', as('free', 'good-ann'))).statusCode).toBe(200)
    })

    it('one verified caller cannot exhaust another’s budget (users and API keys alike)', async () => {
      tenants.set('pair', tenant('pair', { requests_per_minute: 10 }))
      for (let i = 0; i < 15; i++) await get('/api/items/x', as('pair', 'good-ann'))
      for (let i = 0; i < 15; i++) await get('/api/items/x', as('pair', 'key-7'))
      expect((await get('/api/items/x', as('pair', 'good-ann'))).statusCode).toBe(429)
      expect((await get('/api/items/x', as('pair', 'key-7'))).statusCode).toBe(429)
      expect((await get('/api/items/x', as('pair', 'good-bob'))).statusCode).toBe(200)
      expect((await get('/api/items/x', as('pair', 'key-8'))).statusCode).toBe(200)
    })

    it('a bogus credential counts as anonymous, per address, and never spends signed-in budgets', async () => {
      tenants.set('pub', tenant('pub', { requests_per_minute: 10 }))
      for (let i = 0; i < 40; i++)
        await get('/api/items/x', as('pub', 'forged-token-that-does-not-verify'), '10.9.9.9')
      expect(
        (await get('/api/items/x', as('pub', 'forged-token-that-does-not-verify'), '10.9.9.9'))
          .statusCode
      ).toBe(429)
      // Without a credential from the same address: the same anonymous bucket.
      expect((await get('/api/items/x', as('pub'), '10.9.9.9')).statusCode).toBe(429)
      // Another address, and every verified caller on the flooded address, still pass.
      expect((await get('/api/items/x', as('pub'), '10.8.8.8')).statusCode).toBe(200)
      expect((await get('/api/items/x', as('pub', 'good-cat'), '10.9.9.9')).statusCode).toBe(200)
    })

    it('verified callers together share an app-wide ceiling well above one caller', async () => {
      tenants.set('busy', tenant('busy', { requests_per_minute: 10 }))
      const ceiling = 10 * enforce.APP_CEILING_FACTOR
      let ok = 0
      for (let u = 0; u < 12; u++)
        for (let i = 0; i < 10; i++)
          if ((await get('/api/items/x', as('busy', `good-u${u}`))).statusCode === 200) ok++
      expect(ok).toBe(ceiling)
      // Anonymous requests never count toward it (nor are they held by it).
      expect((await get('/api/items/x', as('busy'), '10.7.7.7')).statusCode).toBe(200)
    })

    it('a flood of failed credentials is counted and refused per address (they never reach the limiter)', async () => {
      tenants.set('lock', tenant('lock', { requests_per_minute: 10 }))
      const ip = '10.6.6.6'
      for (let i = 0; i < 10; i++)
        expect((await get('/api/secure', as('lock', 'forged'), ip)).statusCode).toBe(401)
      // Over its failed-credential budget: refused before the route's own check.
      const refused = await get('/api/secure', as('lock', 'forged'), ip)
      expect(refused.statusCode).toBe(429)
      expect(refused.json().code).toBe('APP_RATE_LIMITED')
      expect((await get('/api/items/x', as('lock'), ip)).statusCode).toBe(429)
      // A verified session from that address, and every other address, still pass.
      expect(
        (await get('/api/secure', { ...as('lock'), 'x-session-user': 'u-1' }, ip)).statusCode
      ).toBe(200)
      expect((await get('/api/secure', as('lock', 'good-ann'), '10.6.6.7')).statusCode).toBe(200)
      // A verified caller's 403 is a permission answer: it never fills the bucket.
      tenants.set('perm', tenant('perm', { requests_per_minute: 10 }))
      for (let i = 0; i < 10; i++)
        expect((await get('/api/forbidden', as('perm', 'good-dan'), '10.5.5.5')).statusCode).toBe(
          403
        )
      expect((await get('/api/items/x', as('perm'), '10.5.5.5')).statusCode).toBe(200)
    })

    it('in-process re-entries (inject, batch-get, MCP tool calls) are never counted', async () => {
      enforce._countInjectedForTests(false)
      tenants.set('inner', tenant('inner', { requests_per_minute: 10 }))
      for (let i = 0; i < 30; i++)
        expect((await get('/api/items/x', as('inner', 'good-ann'))).statusCode).toBe(200)
    })
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
    // A replacement that shrinks a file (negative delta) always fits.
    await expect(enforce.assertAppStorageRoom(-500 * 1024)).resolves.toBeUndefined()
    // Presigned (direct) uploads are off for an app with a storage limit.
    await expect(enforce.assertNoDirectUploadUnderLimit()).rejects.toMatchObject({
      statusCode: 409,
      code: 'DIRECT_UPLOAD_OFF_WITH_STORAGE_LIMIT'
    })
  })

  it('no limit, no check (and nothing outside an app)', async () => {
    tenants.set('n', tenant('n'))
    ctx.tenant = 'n'
    await expect(enforce.assertAppStorageRoom(10 ** 12)).resolves.toBeUndefined()
    await expect(enforce.assertNoDirectUploadUnderLimit()).resolves.toBeUndefined()
    ctx.tenant = undefined
    await expect(enforce.assertAppStorageRoom(10 ** 12)).resolves.toBeUndefined()
  })
})
