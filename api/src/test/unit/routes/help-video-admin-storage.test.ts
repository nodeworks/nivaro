import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// /help-videos/storage (#1531): administrators only; the report, the
// retention setting, the plan and Run now (a Background Jobs run).

const state = vi.hoisted(() => ({ admin: true }))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown }) => {
    req.user = { id: 'U1', role: 'R1' }
  },
  requireAdmin: async (
    req: { user?: unknown; isAdmin?: boolean },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } }
  ) => {
    req.user = { id: 'ADMIN', role: 'R1' }
    req.isAdmin = state.admin
    if (!state.admin) return reply.code(403).send({ error: 'Forbidden', code: 'ADMIN_ONLY' })
  }
}))
vi.mock('../../../services/help-video-encoder.js', () => ({ detectHardwareEncoders: vi.fn() }))
vi.mock('../../../services/help-video-render.js', () => ({ cancelRender: vi.fn() }))
vi.mock('../../../services/help-video-render-queue.js', () => ({ listRenderQueue: vi.fn() }))
vi.mock('../../../services/help-video-house-style.js', () => ({
  currentHouseStyle: vi.fn(),
  HOUSE_STYLE_DEFAULTS: {},
  isDefaultHouseStyle: vi.fn(),
  saveHouseStyle: vi.fn()
}))
vi.mock('../../../services/help-videos.js', () => ({ isAuthor: vi.fn(async () => true) }))
vi.mock('../../../services/job-runs.js', () => ({
  withJobRun: vi.fn(async (_k: string, _j: string, _o: unknown, fn: () => Promise<unknown>) => fn())
}))
vi.mock('../../../services/help-video-storage.js', async (orig) => ({
  ...(await orig<object>()),
  storageReport: vi.fn(async () => ({
    migrated: true,
    retention_days: 30,
    videos: [],
    totals: {}
  })),
  sweepPlan: vi.fn(async () => ({ migrated: true, retention_days: 30, removals: [], kept: [] })),
  runStorageSweep: vi.fn(async () => ({
    retention_days: 30,
    versions: 1,
    files: 2,
    bytes: 10,
    failed: 0,
    summary: 'removed 2 files'
  })),
  saveRetentionDays: vi.fn(async (v: unknown) => {
    if (v === 'bad') {
      const { HelpVideoSettingsError } = await import('../../../services/help-video-settings.js')
      throw new HelpVideoSettingsError('retention_days must be a whole number')
    }
    return v === null ? null : Number(v)
  })
}))

import { helpVideoAdminRoutes } from '../../../routes/help-video-admin.js'
import { logActivity } from '../../../services/activity.js'
import { runStorageSweep } from '../../../services/help-video-storage.js'
import { withJobRun } from '../../../services/job-runs.js'

async function app() {
  const a = Fastify()
  await a.register(helpVideoAdminRoutes, { prefix: '/api/help-videos' })
  return a
}

describe('storage routes', () => {
  beforeEach(() => {
    state.admin = true
    vi.mocked(logActivity).mockClear()
    vi.mocked(runStorageSweep).mockClear()
    vi.mocked(withJobRun).mockClear()
  })

  it.each([
    ['GET', '/storage'],
    ['PATCH', '/storage/retention'],
    ['GET', '/storage/plan'],
    ['POST', '/storage/sweep']
  ])('%s %s refuses a non-administrator', async (method, path) => {
    state.admin = false
    const res = await (await app()).inject({
      method: method as 'GET',
      url: `/api/help-videos${path}`,
      payload: method === 'PATCH' ? { retention_days: 1 } : undefined
    })
    expect(res.statusCode).toBe(403)
    expect(runStorageSweep).not.toHaveBeenCalled()
  })

  it('answers the report and the plan', async () => {
    const a = await app()
    const report = await a.inject({ method: 'GET', url: '/api/help-videos/storage' })
    expect(report.statusCode).toBe(200)
    expect(report.json().data).toMatchObject({ retention_days: 30 })
    const plan = await a.inject({ method: 'GET', url: '/api/help-videos/storage/plan' })
    expect(plan.statusCode).toBe(200)
    expect(plan.json().data).toMatchObject({ removals: [] })
  })

  it('saves retention (null = keep everything) and logs it; a bad value is 400', async () => {
    const a = await app()
    let res = await a.inject({
      method: 'PATCH',
      url: '/api/help-videos/storage/retention',
      payload: { retention_days: 14 }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ retention_days: 14, migrated: true })
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'help-video-settings', comment: 'retention_days: 14' })
    )
    res = await a.inject({
      method: 'PATCH',
      url: '/api/help-videos/storage/retention',
      payload: { retention_days: null }
    })
    expect(res.json().data).toEqual({ retention_days: null, migrated: true })
    res = await a.inject({
      method: 'PATCH',
      url: '/api/help-videos/storage/retention',
      payload: { retention_days: 'bad' }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('HELP_VIDEO_SETTINGS_INVALID')
    res = await a.inject({
      method: 'PATCH',
      url: '/api/help-videos/storage/retention',
      payload: {}
    })
    expect(res.statusCode).toBe(400)
  })

  it('runs the sweep now under a job run, as the administrator', async () => {
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/help-videos/storage/sweep'
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({ files: 2, summary: 'removed 2 files' })
    expect(withJobRun).toHaveBeenCalledWith(
      'cron',
      'help-video-storage-sweep',
      expect.objectContaining({ triggeredBy: 'ADMIN' }),
      expect.any(Function)
    )
    expect(runStorageSweep).toHaveBeenCalledWith({ user: expect.objectContaining({ id: 'ADMIN' }) })
  })
})
