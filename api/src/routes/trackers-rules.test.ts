import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** GitLab sync rules routes: validation answers, preview days, re-validation on enable. */

vi.mock('../middleware/authenticate.js', () => ({
  authenticate: async () => {},
  requireAuth: async () => {},
  requireAdmin: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }
    req.isAdmin = true
  }
}))
vi.mock('../services/trackers/feature.js', () => ({
  FeatureLockedError: class extends Error {},
  requireFeatureOn: async () => {},
  setTrackersEnabled: async () => ({}),
  trackersEnabled: async () => true,
  trackersFeature: async () => ({ enabled: true, source: 'setting' })
}))

type Row = Record<string, any>
const store = vi.hoisted(() => ({ rules: new Map<number, Record<string, any>>() }))
vi.mock('../db/index.js', () => {
  const db: any = (table: string) => {
    let id: number | null = null
    const b: any = {
      where: (w: Row) => {
        id = w.id ?? null
        return b
      },
      first: async () =>
        table === 'nivaro_tracker_rules' && id != null ? store.rules.get(id) : undefined,
      update: async (patch: Row) => {
        if (table === 'nivaro_tracker_rules' && id != null)
          Object.assign(store.rules.get(id) ?? {}, patch)
        return 1
      }
    }
    return b
  }
  db.raw = (sql: string) => ({ __raw: sql })
  return { db }
})

const previewRule = vi.fn<(...args: any[]) => any>()
vi.mock('../services/trackers/engine.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/trackers/engine.js')>()
  return { ...real, previewRule: (...a: any[]) => previewRule(...a) }
})

import { TEMPLATE_VARS } from '../services/trackers/templates.js'
import { trackerRoutes } from './trackers.js'

async function app() {
  const f = Fastify()
  await f.register(trackerRoutes, { prefix: '/api/trackers' })
  return f
}

const validRule = { name: 'Crashes', mode: 'create', action: { connection: 1 } }

beforeEach(() => {
  store.rules.clear()
  previewRule.mockReset()
  previewRule.mockResolvedValue({ would_open: [], held: [], considered: 0, truncated: false })
})

describe('rules routes', () => {
  it('POST /rules answers 400 with the validation errors', async () => {
    const f = await app()
    const res = await f.inject({
      method: 'POST',
      url: '/api/trackers/rules',
      payload: { mode: 'x' }
    })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.code).toBe('INVALID_RULE')
    expect(body.errors.map((e: { path: string }) => e.path)).toEqual(
      expect.arrayContaining(['name', 'mode', 'action'])
    )
  })

  it('POST /rules/preview checks days and the rule, then previews read-only', async () => {
    const f = await app()
    const bad = await f.inject({
      method: 'POST',
      url: '/api/trackers/rules/preview',
      payload: { rule: validRule, days: 14 }
    })
    expect(bad.statusCode).toBe(400)
    const invalid = await f.inject({
      method: 'POST',
      url: '/api/trackers/rules/preview',
      payload: { rule: { name: '' }, days: 7 }
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().code).toBe('INVALID_RULE')
    const ok = await f.inject({
      method: 'POST',
      url: '/api/trackers/rules/preview',
      payload: { rule: validRule, days: 30 }
    })
    expect(ok.statusCode).toBe(200)
    expect(previewRule).toHaveBeenCalledWith(expect.objectContaining({ name: 'Crashes' }), 30)
  })

  it('PATCH enabling a rule that no longer validates answers 400; switching it off works', async () => {
    store.rules.set(5, {
      id: 5,
      name: 'Broken',
      enabled: false,
      mode: 'create',
      sort: 10,
      connection: 1,
      match: JSON.stringify({ severity_min: 'nonsense' }),
      threshold: '{}',
      guards: '{}',
      action: JSON.stringify({ connection: 1 })
    })
    const f = await app()
    const on = await f.inject({
      method: 'PATCH',
      url: '/api/trackers/rules/5',
      payload: { enabled: true }
    })
    expect(on.statusCode).toBe(400)
    expect(on.json().errors[0].path).toBe('match.severity_min')
    expect(store.rules.get(5)?.enabled).toBe(false)
    const off = await f.inject({
      method: 'PATCH',
      url: '/api/trackers/rules/5',
      payload: { enabled: false, name: 'Broken (off)' }
    })
    expect(off.statusCode).toBe(200)
    expect(off.json().data).toMatchObject({ name: 'Broken (off)', enabled: false, valid: false })
  })

  it('GET /rules/template-vars and GET /rules/explain without an issue', async () => {
    const f = await app()
    const vars = await f.inject({ method: 'GET', url: '/api/trackers/rules/template-vars' })
    expect(vars.json().data).toEqual(TEMPLATE_VARS)
    const explain = await f.inject({ method: 'GET', url: '/api/trackers/rules/explain' })
    expect(explain.statusCode).toBe(400)
  })
})
