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
const m = vi.hoisted(() => ({ log: vi.fn(async () => null), backup: vi.fn(), refresh: vi.fn() }))
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
  startRefreshRollback: vi.fn()
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

  it('answers 404 for a junk id', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/hub/environments/abc/data/backup',
      headers: admin
    })
    expect(r.statusCode).toBe(404)
  })
})
