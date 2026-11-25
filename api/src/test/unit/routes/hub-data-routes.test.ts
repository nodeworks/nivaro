import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub data care routes (routes/hub-data.ts): administrators only, every start logged, a service
// refusal answered as {code, message} (+ plan), junk ids 404.

vi.mock('../../../middleware/authenticate.js', () => {
  const sign = async (req: {
    headers: Record<string, string | undefined>
    user?: unknown
    isAdmin?: boolean
  }) => {
    const id = req.headers['x-user']
    if (!id) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = { id, status: 'active' }
    req.isAdmin = req.headers['x-admin'] === '1'
  }
  const admin = async (req: Parameters<typeof sign>[0]) => {
    await sign(req)
    if (!req.isAdmin) throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
  }
  return { requireAuth: vi.fn(sign), requireAdmin: vi.fn(admin), authenticate: vi.fn(sign) }
})
const m = vi.hoisted(() => ({
  log: vi.fn(async () => null),
  backup: vi.fn(),
  refresh: vi.fn(),
  updates: [] as unknown[],
  env: { key: 'staging', reasons: [] as string[] }
}))
vi.mock('../../../db/index.js', () => ({
  db: () => ({ where: () => ({ update: async (v: unknown) => m.updates.push(v) }) })
}))
vi.mock('../../../services/hub/data/env-db.js', () => ({
  envData: async () => ({
    env: { id: 2, key: m.env.key, position: 2 },
    app: { id: 1, key: 'efp', name: 'EFP' },
    production_reasons: m.env.reasons
  }),
  serverAccessOf: () => ({})
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: m.log }))
vi.mock('../../../services/hub/data/backup.js', () => ({
  startDbBackup: m.backup,
  backupChecklist: () => [],
  lastBackupSeen: async () => null,
  recordBackupSeen: async () => 5
}))
vi.mock('../../../services/hub/data/refresh.js', () => ({
  planRefresh: vi.fn(),
  startRefresh: m.refresh,
  resumeRefresh: vi.fn(),
  rollbackRefusal: () => null,
  startRefreshRollback: vi.fn(),
  resumeRefreshRollback: vi.fn(),
  newestRefreshRun: vi.fn(async () => null),
  abandonRun: vi.fn(),
  abandonConfirm: () => ''
}))
vi.mock('../../../services/hub/data/schedule.js', () => ({
  DATA_TICK_CRON: '*/5 * * * *',
  dataTick: vi.fn()
}))

const { hubDataRoutes } = await import('../../../routes/hub-data.js')
const { DataError } = await import('../../../services/hub/data/types.js')

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(async (f) => hubDataRoutes(f), { prefix: '/api/hub' })
  await app.ready()
})
afterAll(async () => {
  await app.close()
})
beforeEach(() => {
  m.log.mockClear()
  m.backup.mockReset()
  m.refresh.mockReset()
})

const admin = { 'x-user': '11111111-1111-1111-1111-111111111111', 'x-admin': '1' }

describe('hub data routes', () => {
  it('refuses a person who is not an administrator', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/hub/environments/2/data/backup',
      headers: { 'x-user': 'u' }
    })
    expect(r.statusCode).toBe(403)
    expect(m.backup).not.toHaveBeenCalled()
  })

  it('starts a backup, answers 202 with the run and logs it', async () => {
    m.backup.mockResolvedValue(41)
    const r = await app.inject({
      method: 'POST',
      url: '/api/hub/environments/2/data/backup',
      headers: admin
    })
    expect(r.statusCode).toBe(202)
    expect(r.json()).toEqual({ data: { run_id: 41 } })
    expect(m.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'hub-data-backup',
        collection: 'nivaro_hub_data_runs',
        item: '41'
      })
    )
  })

  it('answers a refusal with its code, message and plan', async () => {
    m.refresh.mockRejectedValue(
      new DataError('PLAN_BLOCKED', 'The plan has refusals', 409, { plan: { blocked: true } })
    )
    const r = await app.inject({
      method: 'POST',
      url: '/api/hub/environments/2/data/refresh',
      headers: admin,
      payload: { source_env_id: 3 }
    })
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({
      code: 'PLAN_BLOCKED',
      message: 'The plan has refusals',
      plan: { blocked: true }
    })
    expect(m.log).not.toHaveBeenCalled()
  })

  it('opts a target in only with the typed app/env and never a production one', async () => {
    const put = (payload: unknown) =>
      app.inject({
        method: 'PUT',
        url: '/api/hub/environments/2/data/refresh-target',
        headers: admin,
        payload: payload as Record<string, unknown>
      })
    expect((await put({ on: true, confirm: 'staging' })).json()).toMatchObject({
      code: 'CONFIRM_MISMATCH'
    })
    m.env = { key: 'prod-eu', reasons: ['its key names production'] }
    expect((await put({ on: true, confirm: 'efp/prod-eu' })).json()).toMatchObject({
      code: 'PRODUCTION_TARGET'
    })
    expect(m.updates).toEqual([])
    m.env = { key: 'staging', reasons: [] }
    const ok = await put({ on: true, confirm: 'efp/staging' })
    expect(ok.statusCode).toBe(200)
    expect(m.updates).toHaveLength(1)
    expect(m.log).toHaveBeenCalledWith(
      expect.objectContaining({ changed_fields: ['refresh_target'] })
    )
  })

  it('answers 404 for a junk id', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/hub/environments/abc/data/backup',
      headers: admin
    })
    expect(r.statusCode).toBe(404)
  })
})
