import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: async (req: { user?: unknown }) => {
    req.user = { id: 'admin-1', role_admin_access: true }
  }
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../config.js', () => ({ config: { NODE_ENV: 'development' } }))

const RUN_ID = '0f8fad5b-d9cb-469f-a165-70867728950e'

const svc = vi.hoisted(() => ({
  isAvailable: vi.fn(() => true),
  currentRun: vi.fn(async () => null),
  listRuns: vi.fn(async () => []),
  readRun: vi.fn(async (): Promise<unknown> => null),
  startRun: vi.fn(),
  runPlan: vi.fn(),
  cancelRun: vi.fn(async (): Promise<unknown> => null),
  parseEvents: (_log: string) => ({ events: [], plan: null }),
  readLogChunk: (log: string, after: number) => ({
    chunk: log.slice(after),
    next_offset: log.length
  }),
  validateStartBody: (b: Record<string, unknown>) =>
    b?.bump === 'bad'
      ? { ok: false, error: 'bump must be patch, minor or major' }
      : { ok: true, args: ['--go', '--events', '--bump', 'patch'] },
  RunLockedError: class extends Error {
    constructor(public current: unknown) {
      super('locked')
    }
  }
}))
vi.mock('../../../services/release-runs.js', () => svc)

const { releaseRunsRoutes } = await import('../../../routes/release-runs.js')

async function build() {
  const app = Fastify()
  await app.register(releaseRunsRoutes, { prefix: '/release' })
  await app.ready()
  return app
}

describe('release routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    svc.isAvailable.mockReturnValue(true)
  })

  it('status reports unavailable outside development', async () => {
    svc.isAvailable.mockReturnValue(false)
    const app = await build()
    const r = await app.inject({ url: '/release/status' })
    expect(r.json()).toEqual({ available: false, current: null, runs: [] })
  })

  it('start rejects a bad bump with 400', async () => {
    const app = await build()
    const r = await app.inject({ method: 'POST', url: '/release/runs', payload: { bump: 'bad' } })
    expect(r.statusCode).toBe(400)
    expect(svc.startRun).not.toHaveBeenCalled()
  })

  it('start answers 409 with the current run while locked', async () => {
    svc.startRun.mockRejectedValueOnce(new svc.RunLockedError({ id: 'live', state: 'running' }))
    const app = await build()
    const r = await app.inject({ method: 'POST', url: '/release/runs', payload: {} })
    expect(r.statusCode).toBe(409)
    expect(r.json().current.id).toBe('live')
  })

  it('start answers 409 with a null current while another start holds the lock', async () => {
    svc.startRun.mockRejectedValueOnce(new svc.RunLockedError(null))
    const app = await build()
    const r = await app.inject({ method: 'POST', url: '/release/runs', payload: {} })
    expect(r.statusCode).toBe(409)
    expect(r.json()).toEqual({ error: 'locked', current: null })
  })

  it('start spawns with the validated args and logs activity', async () => {
    svc.startRun.mockResolvedValueOnce({
      id: 'r1',
      pid: 1,
      mode: 'go',
      args: [],
      started_at: 'x',
      started_by: 'admin-1'
    })
    const app = await build()
    const r = await app.inject({ method: 'POST', url: '/release/runs', payload: { bump: 'patch' } })
    expect(r.statusCode).toBe(201)
    expect(svc.startRun).toHaveBeenCalledWith({
      mode: 'go',
      args: ['--go', '--events', '--bump', 'patch'],
      user: 'admin-1'
    })
    const { logActivity } = await import('../../../services/activity.js')
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'release-run-start', item: 'r1' })
    )
  })

  it('plan answers 502 with the log tail when the script fails', async () => {
    svc.runPlan.mockResolvedValueOnce({ plan: null, log: `${'x'.repeat(5000)}boom`, ok: false })
    const app = await build()
    const r = await app.inject({ method: 'POST', url: '/release/plan' })
    expect(r.statusCode).toBe(502)
    expect(r.json().log_tail.endsWith('boom')).toBe(true)
    expect(r.json().log_tail.length).toBeLessThanOrEqual(4000)
  })

  it('run read returns the chunk after the offset', async () => {
    svc.readRun.mockResolvedValueOnce({ run: { id: RUN_ID, state: 'running' }, log: 'hello world' })
    const app = await build()
    const r = await app.inject({ url: `/release/runs/${RUN_ID}?after=6` })
    expect(r.json().log_chunk).toBe('world')
    expect(r.json().next_offset).toBe(11)
  })

  it('a negative or non-numeric offset reads from the start', async () => {
    svc.readRun.mockResolvedValue({ run: { id: RUN_ID, state: 'running' }, log: 'hello world' })
    const app = await build()
    const neg = await app.inject({ url: `/release/runs/${RUN_ID}?after=-3` })
    expect(neg.json().log_chunk).toBe('hello world')
    const nan = await app.inject({ url: `/release/runs/${RUN_ID}?after=abc` })
    expect(nan.json().log_chunk).toBe('hello world')
    svc.readRun.mockReset()
  })

  it('unknown run id is 404', async () => {
    const app = await build()
    expect((await app.inject({ url: '/release/runs/nope' })).statusCode).toBe(404)
    expect(
      (await app.inject({ method: 'POST', url: '/release/runs/nope/cancel' })).statusCode
    ).toBe(404)
    expect(svc.readRun).not.toHaveBeenCalled()
    expect(svc.cancelRun).not.toHaveBeenCalled()
    expect((await app.inject({ url: `/release/runs/${RUN_ID}` })).statusCode).toBe(404)
    expect(
      (await app.inject({ method: 'POST', url: `/release/runs/${RUN_ID}/cancel` })).statusCode
    ).toBe(404)
  })
})
