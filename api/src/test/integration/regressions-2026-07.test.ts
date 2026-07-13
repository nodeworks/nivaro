/**
 * Regression net for the 2026-07 bug batch:
 *  - MSSQL insert-identity: `const [id] = db(...).insert(...)` returns the row
 *    count on tedious, not the identity — create endpoints must use
 *    .returning('id') (retention, alert definitions/subscriptions, pageviews).
 *  - Retention run result shape: snake_case (affected_count/affected_ids/errors),
 *    matching the admin RunResult component.
 *  - GET /files honors the items-style ?filter={"id":{"_in":[...]}} batch shape.
 *  - GET /files/:id?download=1 serves Content-Disposition: attachment.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../config.js', () => ({
  config: {
    NODE_ENV: 'test',
    DB_DATABASE: 'testdb',
    DB_HOST: 'localhost',
    REDIS_URL: 'redis://localhost:6379',
    ENCRYPTION_KEY: null,
    STORAGE_LOCAL_ROOT: '/tmp',
  },
}))

vi.mock('../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async () => {}),
  requireAuth: vi.fn(async () => {}),
  requireAdmin: vi.fn(async () => {}),
  cidrMatch: vi.fn(() => true),
  checkApiKeyScope: vi.fn(() => true),
}))

vi.mock('../../services/activity.js', () => ({
  logActivity: vi.fn().mockResolvedValue(1),
}))

vi.mock('../../services/retention.js', () => ({
  DEFAULT_REDACT_FIELDS: ['first_name', 'last_name', 'email'],
  executeRetentionPolicy: vi.fn().mockResolvedValue({
    affectedCount: 2,
    affectedIds: ['user-a', 'user-b'],
    errors: [],
  }),
}))

vi.mock('../../services/files.js', () => ({
  listFiles: vi.fn().mockResolvedValue({ data: [], total: 0 }),
  getFile: vi.fn(),
  readFileBuffer: vi.fn(),
  reportFileBandwidth: vi.fn().mockResolvedValue(undefined),
  updateFileMeta: vi.fn(),
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
  createPresignedFile: vi.fn(),
}))

vi.mock('../../services/storage/index.js', () => ({
  getStorage: vi.fn(() => ({ get: vi.fn(), put: vi.fn(), delete: vi.fn(), getUrl: vi.fn() })),
  getStorageProviderName: vi.fn(() => 'local'),
}))

import Fastify, { type FastifyInstance } from 'fastify'
import { db } from '../../db/index.js'
import { getFile, listFiles, readFileBuffer } from '../../services/files.js'
import { makeAdminUser } from '../helpers.js'

function makeDbChain(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, unknown> = {
    select: vi.fn().mockResolvedValue([]),
    first: vi.fn().mockResolvedValue(null),
    insert: vi.fn(),
    update: vi.fn().mockResolvedValue(1),
    delete: vi.fn().mockResolvedValue(1),
    count: vi.fn().mockResolvedValue([{ total: 0 }]),
    returning: vi.fn().mockResolvedValue([{ id: 42 }]),
  }
  for (const m of ['where', 'whereIn', 'whereNull', 'orderBy', 'limit', 'offset']) {
    chain[m] = vi.fn().mockReturnValue(chain)
  }
  ;(chain.insert as ReturnType<typeof vi.fn>).mockReturnValue(chain)
  return Object.assign(chain, overrides)
}

async function buildApp(register: (app: FastifyInstance) => Promise<void>) {
  const app = Fastify({ logger: false })
  const adminUser = makeAdminUser()
  // @ts-ignore test shim
  app.decorateRequest('user', null)
  app.decorateRequest('isAdmin', true)
  app.addHook('onRequest', async (req) => {
    ;(req as unknown as { user: typeof adminUser }).user = adminUser
    ;(req as unknown as { isAdmin: boolean }).isAdmin = true
  })
  await register(app)
  await app.ready()
  return app
}

afterEach(() => vi.clearAllMocks())

describe('Retention regressions', () => {
  it('POST /retention returns the OUTPUT identity, not the row count', async () => {
    const policyRow = {
      id: 42,
      name: 'p',
      inactivity_threshold_months: 36,
      action: 'redact',
      redact_fields: '[]',
      exclusion_emails: '[]',
      exclusion_roles: '[]',
      is_active: true,
      dry_run_mode: false,
    }
    const chain = makeDbChain({ first: vi.fn().mockResolvedValue(policyRow) })
    vi.mocked(db as unknown as (t: string) => unknown).mockReturnValue(
      chain as unknown as ReturnType<typeof db>
    )

    const app = await buildApp(async (a) => {
      const { retentionRoutes } = await import('../../routes/retention.js')
      await a.register(retentionRoutes, { prefix: '/api/retention' })
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/retention/',
      payload: { name: 'p' },
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).data.id).toBe(42)
    // the identity must come from .returning('id'), not the bare insert result
    expect(chain.returning).toHaveBeenCalledWith('id')
    await app.close()
  })

  it('POST /retention/:id/run returns snake_case result shape', async () => {
    const chain = makeDbChain({
      first: vi.fn().mockResolvedValue({ id: 1, name: 'p', redact_fields: '[]', exclusion_emails: '[]', exclusion_roles: '[]' }),
    })
    vi.mocked(db as unknown as (t: string) => unknown).mockReturnValue(
      chain as unknown as ReturnType<typeof db>
    )

    const app = await buildApp(async (a) => {
      const { retentionRoutes } = await import('../../routes/retention.js')
      await a.register(retentionRoutes, { prefix: '/api/retention' })
    })
    const res = await app.inject({ method: 'POST', url: '/api/retention/1/run?dry_run=true' })

    expect(res.statusCode).toBe(200)
    const { data } = JSON.parse(res.body)
    // admin RunResult reads these exact keys — camelCase here crashes the page
    expect(data).toMatchObject({
      affected_count: 2,
      affected_ids: ['user-a', 'user-b'],
      errors: [],
      dry_run: true,
    })
    expect(data).not.toHaveProperty('affectedCount')
    await app.close()
  })
})

describe('Alert create regressions', () => {
  it('POST /alerts/definitions returns the OUTPUT identity', async () => {
    const defRow = { id: 42, name: 'a', category: 'general', collection: 'c', field: 'f', filters: null, is_active: 1 }
    const chain = makeDbChain({ first: vi.fn().mockResolvedValue(defRow) })
    vi.mocked(db as unknown as (t: string) => unknown).mockReturnValue(
      chain as unknown as ReturnType<typeof db>
    )

    const app = await buildApp(async (a) => {
      const { alertsRoutes } = await import('../../routes/alerts.js')
      await a.register(alertsRoutes, { prefix: '/api/alerts' })
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/alerts/definitions',
      payload: { name: 'a', collection: 'c', field: 'f', operator: 'gt', threshold: 1 },
    })

    expect(res.statusCode).toBe(201)
    expect(chain.returning).toHaveBeenCalledWith('id')
    await app.close()
  })
})

describe('Analytics pageview regressions', () => {
  it('POST /analytics/pageview returns the OUTPUT identity', async () => {
    const chain = makeDbChain()
    vi.mocked(db as unknown as (t: string) => unknown).mockReturnValue(
      chain as unknown as ReturnType<typeof db>
    )

    const app = await buildApp(async (a) => {
      const { analyticsRoutes } = await import('../../routes/analytics.js')
      await a.register(analyticsRoutes, { prefix: '/api/analytics' })
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/analytics/pageview',
      payload: { sessionId: 's1', pageUrl: '/home' },
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).id).toBe(42)
    expect(chain.returning).toHaveBeenCalledWith('id')
    await app.close()
  })
})

describe('Files route regressions', () => {
  it('GET /files parses items-style filter into an ids batch', async () => {
    const app = await buildApp(async (a) => {
      const { filesRoutes } = await import('../../routes/files.js')
      await a.register(filesRoutes, { prefix: '/api/files' })
    })
    const filter = JSON.stringify({ id: { _in: ['aaa', 'bbb'] } })
    const res = await app.inject({
      method: 'GET',
      url: `/api/files/?filter=${encodeURIComponent(filter)}`,
    })

    expect(res.statusCode).toBe(200)
    expect(vi.mocked(listFiles)).toHaveBeenCalledWith(
      expect.objectContaining({ ids: ['aaa', 'bbb'] })
    )
    await app.close()
  })

  it('GET /files/:id?download=1 serves an attachment disposition', async () => {
    vi.mocked(getFile).mockResolvedValue({
      id: 'f1',
      filename_disk: 'f1.pdf',
      filename_download: 'report.pdf',
      type: 'application/pdf',
    } as never)
    vi.mocked(readFileBuffer).mockResolvedValue(Buffer.from('%PDF'))

    const app = await buildApp(async (a) => {
      const { filesRoutes } = await import('../../routes/files.js')
      await a.register(filesRoutes, { prefix: '/api/files' })
    })

    const dl = await app.inject({ method: 'GET', url: '/api/files/f1?download=1' })
    expect(dl.statusCode).toBe(200)
    expect(dl.headers['content-disposition']).toContain('attachment')

    const inline = await app.inject({ method: 'GET', url: '/api/files/f1' })
    expect(inline.headers['content-disposition']).toContain('inline')
    await app.close()
  })
})
