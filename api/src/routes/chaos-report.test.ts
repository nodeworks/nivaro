import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../middleware/authenticate.js', () => ({
  requireAdmin: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: '11111111-1111-1111-1111-111111111111', first_name: 'Ada', email: 'ada@x' }
    req.isAdmin = true
  }
}))
const checks: Array<{ id: string; run: () => Promise<{ status: string; detail?: string }> }> = []
vi.mock('../services/readiness.js', () => ({
  registerReadinessCheck: (c: (typeof checks)[number]) => checks.push(c)
}))
vi.mock('../services/chaos/report-data.js', async (orig) => ({
  ...(await orig<typeof import('../services/chaos/report-data.js')>()),
  errorsSeen: vi.fn().mockResolvedValue({
    server: [{ route: 'GET /api/items/:id', count: 2 }],
    server_total: 2,
    people: 1,
    client_errors: 0,
    rage_clicks: 0,
    dead_clicks: 0,
    available: true
  }),
  userNames: vi.fn().mockResolvedValue({ u2: 'Sam Lee' }),
  listPartners: vi.fn().mockResolvedValue([])
}))

import { _setRunStoreForTests, appendRunEvent, createRun } from '../services/chaos/runs.js'
import { chaosReportRoutes } from './chaos-report.js'

const saved = { ...process.env }

async function build() {
  const app = Fastify()
  await app.register(chaosReportRoutes)
  await app.ready()
  return app
}

async function seedRun(verdict: 'held' | 'broke', endedAgoMs = 60_000) {
  const end = Date.now() - endedAgoMs
  const start = end - 60_000
  const run = await createRun({
    kind: 'drill',
    status: 'completed',
    fault_key: 'redis_pause',
    label: 'Redis unreachable',
    verdict,
    started_at: new Date(start).toISOString(),
    ended_at: new Date(end).toISOString(),
    hypothesis: [{ sampler: 'http.5xx_pct', op: '<', limit: 1 }],
    baseline: { 'http.5xx_pct': { min: 0, max: 0.2 } }
  })
  await appendRunEvent(run.id, 'armed', { fault_key: 'redis_pause' })
  await appendRunEvent(run.id, 'note', { mark: 'noticed', text: 'banner up' }, 'u2')
  await appendRunEvent(run.id, 'disarmed', { verdict })
  return run
}

beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  process.env.NODE_ENV = 'test'
  _setRunStoreForTests('memory')
})
afterEach(() => {
  _setRunStoreForTests(null)
  process.env = { ...saved }
})

describe('chaos report routes', () => {
  it('answers a run report and its postmortem download', async () => {
    const app = await build()
    const run = await seedRun('held')
    const res = await app.inject({ method: 'GET', url: `/runs/${run.id}/report` })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.report.verdict).toBe('held')
    expect(d.report.notes[0]).toMatchObject({ mark: 'noticed', text: 'banner up' })
    expect(d.report.ttd_source).toBe('noticed')
    expect(d.errors.server_total).toBe(2)
    expect(d.names.u2).toBe('Sam Lee')
    const md = await app.inject({ method: 'GET', url: `/runs/${run.id}/postmortem` })
    expect(md.headers['content-type']).toMatch(/text\/markdown/)
    expect(md.headers['content-disposition']).toMatch(/attachment; filename="chaos-redis_pause-/)
    expect(md.body).toContain('Sam Lee [Noticed]: banner up')
    expect((await app.inject({ method: 'GET', url: '/runs/nope/report' })).statusCode).toBe(404)
    await app.close()
  })

  it('serves claims, matrix and trends — and reads still answer where the gate refuses', async () => {
    process.env.CLOUD_META_DB_URL = 'postgres://x'
    const app = await build()
    await seedRun('held')
    const claims = (await app.inject({ method: 'GET', url: '/claims' })).json().data
    expect(claims.refusal).toMatch(/cloud/i)
    expect(claims.claims.find((c: { key: string }) => c.key === 'redis.fails_open').status).toBe(
      'proven'
    )
    const matrix = (await app.inject({ method: 'GET', url: '/matrix' })).json().data
    expect(matrix.kinds).toEqual(['down', 'slow', 'errors', 'partitioned'])
    expect(
      matrix.cells.find(
        (c: { dependency: string; kind: string }) => c.dependency === 'redis' && c.kind === 'down'
      ).last.verdict
    ).toBe('held')
    const trends = (await app.inject({ method: 'GET', url: '/trends?months=3' })).json().data
    expect(trends.months).toHaveLength(3)
    expect(trends.months.at(-1).runs).toBe(1)
    expect(trends.never_proven.length).toBeGreaterThan(0)
    await app.close()
  })

  it('registers one cheap readiness check that skips where drills cannot run', async () => {
    await build()
    await build()
    const check = checks.filter((c) => c.id === 'chaos-claims')
    expect(check).toHaveLength(1)
    await seedRun('broke')
    expect((await check[0].run()).status).toBe('warn')
    process.env.CLOUD_META_DB_URL = 'postgres://x'
    expect((await check[0].run()).status).toBe('skip')
  })
})
