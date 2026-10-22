import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../middleware/authenticate.js', () => ({
  // requireChaosOperator (#2862) authenticates, then lets administrators through.
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: '11111111-1111-1111-1111-111111111111', first_name: 'Ada', email: 'ada@x' }
    req.isAdmin = true
  },
  requireAuth: async (req: { user?: unknown }) => {
    req.user = { id: '11111111-1111-1111-1111-111111111111', first_name: 'Ada', email: 'ada@x' }
  },
  requireAdmin: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: '11111111-1111-1111-1111-111111111111', first_name: 'Ada', email: 'ada@x' }
    req.isAdmin = true
  }
}))
vi.mock('../services/activity.js', () => ({ logActivity: vi.fn().mockResolvedValue(null) }))
vi.mock('../services/job-runs.js', () => ({
  startJobRun: vi.fn().mockResolvedValue({
    id: 7,
    progress: vi.fn(),
    log: vi.fn(),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined)
  })
}))

import { _resetDrillForTests } from '../services/chaos/drill.js'
import { _resetRegistryForTests, chaosNumber, chaosPoint } from '../services/chaos/registry.js'
import { _setRunStoreForTests } from '../services/chaos/runs.js'
import { chaosRoutes } from './chaos.js'

const saved = { ...process.env }

async function build() {
  const app = Fastify()
  await app.register(chaosRoutes)
  await app.ready()
  return app
}

beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  process.env.NODE_ENV = 'test'
  _setRunStoreForTests('memory')
})
afterEach(async () => {
  await _resetRegistryForTests()
  _resetDrillForTests()
  _setRunStoreForTests(null)
  process.env = { ...saved }
})

describe('chaos routes', () => {
  it('answers the fixed status shape, the catalog and the public armed list', async () => {
    const app = await build()
    const status = await app.inject({ method: 'GET', url: '/status' })
    expect(status.statusCode).toBe(200)
    expect(status.json().data).toEqual({
      allowed: true,
      reason: null,
      armed: [],
      nodes: expect.arrayContaining([expect.any(String)])
    })
    const catalog = await app.inject({ method: 'GET', url: '/catalog' })
    const keys = catalog.json().data.faults.map((f: { key: string }) => f.key)
    expect(keys).toEqual(
      expect.arrayContaining(['slow_requests', 'mail_down', 'redis_pause', 'socket_drill'])
    )
    expect(catalog.json().data.store).toBe('memory')
    const armed = await app.inject({ method: 'GET', url: '/armed' })
    expect(armed.json().data).toEqual({ allowed: true, armed: [] })
    await app.close()
  })

  it('starts a drill, arms the fault, lists it, stops it and closes the run', async () => {
    const app = await build()
    const start = await app.inject({
      method: 'POST',
      url: '/runs',
      payload: { fault_key: 'slow_requests', params: { delay_ms: 250 }, seconds: 60, note: 'test' }
    })
    expect(start.statusCode).toBe(201)
    const { run, fault } = start.json().data
    expect(run.status).toBe('running')
    expect(run.fault_key).toBe('slow_requests')
    expect(run.meta.job_run_id).toBe(7)
    expect(run.hypothesis).toEqual([{ sampler: 'http.5xx_pct', op: '<', limit: 1, tolerance: 0.5 }])
    expect(chaosNumber('http.request', 'delay_ms', { route: '/api/x' })).toBe(250)

    const armed = await app.inject({ method: 'GET', url: '/armed' })
    expect(armed.json().data.armed).toEqual([
      expect.objectContaining({
        id: fault.id,
        label: 'Slow requests',
        started_by_name: 'Ada',
        target: 'everything'
      })
    ])
    // Never the raw params or a person id on the public list.
    expect(armed.json().data.armed[0]).not.toHaveProperty('params')
    expect(armed.json().data.armed[0]).not.toHaveProperty('started_by')

    const detail = await app.inject({ method: 'GET', url: `/runs/${run.id}` })
    expect(detail.json().data.events.map((e: { kind: string }) => e.kind)).toEqual(['armed'])

    const stop = await app.inject({ method: 'POST', url: `/runs/${run.id}/stop`, payload: {} })
    expect(stop.statusCode).toBe(200)
    expect(stop.json().data.status).toBe('stopped')
    expect(stop.json().data.verdict).toBe('held')
    expect(chaosPoint('http.request')).toBeNull()
    const again = await app.inject({ method: 'POST', url: `/runs/${run.id}/stop`, payload: {} })
    expect(again.statusCode).toBe(409)

    const list = await app.inject({ method: 'GET', url: '/runs?status=stopped' })
    expect(list.json().data.map((r: { id: string }) => r.id)).toEqual([run.id])
    await app.close()
  })

  it('stop-all clears every fault and closes every open run', async () => {
    const app = await build()
    const a = await app.inject({
      method: 'POST',
      url: '/runs',
      payload: { fault_key: 'slow_requests' }
    })
    const b = await app.inject({
      method: 'POST',
      url: '/runs',
      payload: { fault_key: 'mail_down' }
    })
    expect(a.statusCode).toBe(201)
    expect(b.statusCode).toBe(201)
    expect(chaosPoint('mail.send')).not.toBeNull()
    const r = await app.inject({
      method: 'POST',
      url: '/stop-all',
      payload: { reason: 'drill over' }
    })
    expect(r.json().data.stopped).toHaveLength(2)
    expect(r.json().data.runs.sort()).toEqual([a.json().data.run.id, b.json().data.run.id].sort())
    expect(chaosPoint('mail.send')).toBeNull()
    expect((await app.inject({ method: 'GET', url: '/status' })).json().data.armed).toEqual([])
    await app.close()
  })

  it('records a run from outside the registry and refuses bad verdicts', async () => {
    const app = await build()
    const ok = await app.inject({
      method: 'POST',
      url: '/runs/record',
      payload: {
        kind: 'ci',
        fault_key: 'db_latency',
        label: 'toxiproxy latency',
        verdict: 'held',
        metrics: { p95_ms: 300 }
      }
    })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().data).toMatchObject({
      kind: 'ci',
      status: 'completed',
      verdict: 'held',
      verdict_detail: { p95_ms: 300 }
    })
    const bad = await app.inject({
      method: 'POST',
      url: '/runs/record',
      payload: { kind: 'ci', label: 'x', verdict: 'meh' }
    })
    expect(bad.statusCode).toBe(400)
    await app.close()
  })

  it('keeps the #333 alias working and names the faults on a bad one', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'POST',
      url: '/run',
      payload: { fault: 'slow_requests', seconds: 10, delay_ms: 300 }
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toMatchObject({ fault: 'slow_requests', seconds: 10, delay_ms: 300 })
    const bad = await app.inject({ method: 'POST', url: '/run', payload: { fault: 'nope' } })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toMatch(/slow_requests/)
    await app.close()
  })

  it('refuses writes with the gate reason in cloud mode while reads still answer', async () => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    const app = await build()
    const status = await app.inject({ method: 'GET', url: '/status' })
    expect(status.json().data).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/cloud/)
    })
    const start = await app.inject({
      method: 'POST',
      url: '/runs',
      payload: { fault_key: 'slow_requests' }
    })
    expect(start.statusCode).toBe(403)
    expect(start.json()).toMatchObject({ code: 'CHAOS_GATE' })
    const armed = await app.inject({ method: 'GET', url: '/armed' })
    expect(armed.json().data).toEqual({ allowed: false, armed: [] })
    await app.close()
  })
})
