import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The caller: an administrator (Ada) unless `x-operator: 1` — then a non-admin member of the
// chaos operator role (#2862) with no display name, only an email.
vi.mock('../middleware/authenticate.js', () => {
  type Req = { headers: Record<string, string>; user?: unknown; isAdmin?: boolean }
  const sign = (req: Req) => {
    if (req.headers['x-operator'] === '1') {
      req.user = {
        id: '22222222-2222-2222-2222-222222222222',
        first_name: null,
        email: 'op@x',
        role: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      }
      req.isAdmin = false
    } else {
      req.user = { id: '11111111-1111-1111-1111-111111111111', first_name: 'Ada', email: 'ada@x' }
      req.isAdmin = true
    }
  }
  return {
    authenticate: async (req: Req) => sign(req),
    requireAuth: async (req: Req) => sign(req),
    requireAdmin: async (req: Req) => {
      sign(req)
      if (!req.isAdmin) throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
    }
  }
})
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
import { _setPresetStoreForTests, MAX_SAVED } from '../services/chaos/presets.js'
import { _resetRegistryForTests, armedFaults } from '../services/chaos/registry.js'
import { _setRunStoreForTests, getRun } from '../services/chaos/runs.js'
import { _setChaosSettingsForTests, CHAOS_SETTINGS_DEFAULTS } from '../services/chaos/settings.js'
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
  _setChaosSettingsForTests({
    ...CHAOS_SETTINGS_DEFAULTS,
    operator_roles: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc']
  })
})
afterEach(async () => {
  _setChaosSettingsForTests(null)
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

  it('only an administrator may override the working-hours check on a preset run (F6)', async () => {
    const app = await build()
    const override = { working_hours: true }
    const op = await app.inject({
      method: 'POST',
      url: '/chaos/presets/slow-answers-stay-honest/run',
      headers: { 'x-operator': '1' },
      payload: { seconds: 10, override }
    })
    expect(op.statusCode).toBe(201)
    const opRun = await getRun(op.json().data.run.id)
    expect(opRun?.meta.override).toBeNull()
    // The display name never falls back to the email.
    expect(opRun?.meta.started_by_name).toBeNull()
    await _resetRegistryForTests()
    const admin = await app.inject({
      method: 'POST',
      url: '/chaos/presets/slow-answers-stay-honest/run',
      payload: { seconds: 10, override }
    })
    expect(admin.statusCode).toBe(201)
    expect((await getRun(admin.json().data.run.id))?.meta.override).toEqual(override)
  })

  it('refuses a new saved preset once the instance holds the maximum (F10)', async () => {
    const app = await build()
    const spec = { fault_key: 'slow_requests', target: { kind: 'all' }, seconds: 20 }
    for (let i = 0; i < MAX_SAVED; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/chaos/presets',
        payload: { key: `p-${i}`, label: `P ${i}`, spec }
      })
      expect(res.statusCode).toBe(201)
    }
    const over = await app.inject({
      method: 'POST',
      url: '/chaos/presets',
      payload: { key: 'one-too-many', label: 'One too many', spec }
    })
    expect(over.statusCode).toBe(409)
    expect(over.json().code).toBe('CHAOS_PRESET_LIMIT')
    // Editing an existing saved preset still works at the limit.
    const edit = await app.inject({
      method: 'PATCH',
      url: '/chaos/presets/p-0',
      payload: { label: 'P zero' }
    })
    expect(edit.statusCode).toBe(200)
  })
})
