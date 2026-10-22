import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../middleware/authenticate.js', () => ({
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
import { _setPresetStoreForTests } from '../services/chaos/presets.js'
import { _resetRegistryForTests, armedFaults } from '../services/chaos/registry.js'
import { _setRunStoreForTests, getRun } from '../services/chaos/runs.js'
import { chaosRoutes } from './chaos.js'
import { chaosPresetRoutes } from './chaos-presets.js'

const saved = { ...process.env }

async function build() {
  const app = Fastify()
  await app.register(chaosRoutes, { prefix: '/chaos' })
  await app.register(chaosPresetRoutes, { prefix: '/chaos/presets' })
  await app.ready()
  return app
}

beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  process.env.NODE_ENV = 'test'
  _setRunStoreForTests('memory')
  _setPresetStoreForTests('memory')
})
afterEach(async () => {
  await _resetRegistryForTests()
  _resetDrillForTests()
  _setRunStoreForTests(null)
  _setPresetStoreForTests(null)
  process.env = { ...saved }
})

describe('chaos preset routes (#2855)', () => {
  it('lists shipped presets with whether this instance has their fault', async () => {
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/chaos/presets' })
    expect(res.statusCode).toBe(200)
    const { store, presets } = res.json().data
    expect(store).toBe('memory')
    const slow = presets.find((p: { key: string }) => p.key === 'slow-answers-stay-honest')
    expect(slow.fault).toMatchObject({ installed: true, label: 'Slow requests' })
    expect(slow.source).toBe('shipped')
  })

  it('creates, edits and deletes a saved preset; 404s and refusals are clear', async () => {
    const app = await build()
    const body = {
      key: 'route-slow',
      label: 'Slow item routes',
      proves: 'Item screens show loading states',
      claim_keys: ['http.slow_honest'],
      spec: {
        fault_key: 'slow_requests',
        target: { kind: 'route', pattern: '/api/items/*' },
        params: { delay_ms: 800 },
        seconds: 20
      }
    }
    const created = await app.inject({ method: 'POST', url: '/chaos/presets', payload: body })
    expect(created.statusCode).toBe(201)
    expect(
      (await app.inject({ method: 'POST', url: '/chaos/presets', payload: body })).statusCode
    ).toBe(409)
    const patched = await app.inject({
      method: 'PATCH',
      url: '/chaos/presets/route-slow',
      payload: { label: 'Renamed' }
    })
    expect(patched.json().data.label).toBe('Renamed')
    expect(patched.json().data.spec.params.delay_ms).toBe(800)
    const gone = await app.inject({ method: 'DELETE', url: '/chaos/presets/route-slow' })
    expect(gone.json().data).toEqual({ deleted: true, restored: false })
    expect((await app.inject({ method: 'GET', url: '/chaos/presets/route-slow' })).statusCode).toBe(
      404
    )
    const shipped = await app.inject({
      method: 'DELETE',
      url: '/chaos/presets/slow-answers-stay-honest'
    })
    expect(shipped.statusCode).toBe(400)
    expect(shipped.json().code).toBe('CHAOS_PRESET_SHIPPED')
  })

  it('refuses writes at the chaos gate but still answers reads', async () => {
    process.env.CLOUD_META_DB_URL = 'postgres://x'
    const app = await build()
    expect((await app.inject({ method: 'GET', url: '/chaos/presets' })).statusCode).toBe(200)
    const res = await app.inject({
      method: 'POST',
      url: '/chaos/presets',
      payload: { key: 'abc', label: 'x', spec: { fault_key: 'slow_requests' } }
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('CHAOS_GATE')
  })

  it('runs a shipped preset: arms its fault, records the preset key, the body overrides', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/chaos/presets/slow-answers-stay-honest/run',
      payload: { seconds: 10 }
    })
    expect(res.statusCode).toBe(201)
    const { run, fault } = res.json().data
    expect(fault.fault_key).toBe('slow_requests')
    expect(fault.target).toEqual({ kind: 'share', share_pct: 25 })
    expect(fault.ends_at - fault.started_at).toBe(10_000)
    expect(run.preset_id).toBeNull()
    expect((await getRun(run.id))?.meta.preset_key).toBe('slow-answers-stay-honest')
    expect(armedFaults()).toHaveLength(1)
    const missing = await app.inject({ method: 'POST', url: '/chaos/presets/nope-x/run' })
    expect(missing.statusCode).toBe(404)
  })
})
