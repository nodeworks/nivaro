import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// M19 (security audit 2026-10-27): a public dashboard link computes its widgets at most once
// per PUBLIC_LINK_CACHE_S per link; concurrent anonymous misses share one gated run.

vi.mock('../../../middleware/authenticate.js', () => ({ requireAuth: vi.fn(async () => {}) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
const widgets = vi.hoisted(() => ({
  compute: vi.fn(async () => ({ data: { value: 42 } }))
}))
vi.mock('../../../services/dashboard-widgets.js', () => ({ computeWidgetData: widgets.compute }))

const TOKEN = 'b'.repeat(48)
const tables: Record<string, unknown> = {
  nivaro_dashboard_links: {
    id: 9,
    dashboard: 'D1',
    token: TOKEN,
    expires_at: null,
    is_active: true,
    view_count: 0,
    created_by: 'U1'
  },
  nivaro_dashboards: { id: 'D1', name: 'Ops', user: 'U1' },
  nivaro_users: { id: 'U1', status: 'active', role: 'R' },
  nivaro_dashboard_widgets: [
    { id: 'W1', type: 'kpi', title: 'Open', col: 0, row: 0, width: 2, height: 1 }
  ]
}
vi.mock('../../../db/index.js', () => ({
  db: vi.fn((table: string) => {
    const value = tables[table]
    const c: Record<string, unknown> = {}
    c.where = vi.fn(() => c)
    c.orderBy = vi.fn(() => c)
    c.first = vi.fn(async () => value)
    c.increment = vi.fn(() => Promise.resolve(1))
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenables
    c.then = (resolve: (v: unknown) => unknown) => resolve(value)
    return c
  })
}))

import { dashboardLinkRoutes, publicLinkCacheKey } from '../../../routes/dashboard-links.js'
import { resetReadGate } from '../../../services/read-gate.js'
import { resetSingleFlight } from '../../../services/single-flight.js'

function fakeRedis() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    setex: vi.fn(async (k: string, _t: number, v: string) => {
      store.set(k, v)
      return 'OK'
    })
  }
}

async function app() {
  const a = Fastify({ logger: false })
  const redis = fakeRedis()
  a.decorate('redis', redis as never)
  a.register(dashboardLinkRoutes, { prefix: '/dashboard-links' })
  await a.ready()
  return { a, redis }
}

beforeEach(() => {
  resetSingleFlight()
  resetReadGate({ global: 20, perUser: 4, maxWaitMs: 30_000 })
})
afterEach(() => {
  vi.clearAllMocks()
  delete process.env.PUBLIC_LINK_CACHE_S
})

describe('public dashboard link cache', () => {
  it('keys by tenant + link', () => {
    expect(publicLinkCacheKey(9, '')).toBe('dlpub:-:9')
    expect(publicLinkCacheKey(9, 'acme')).toBe('dlpub:acme:9')
  })

  it('computes once for repeated and concurrent anonymous views', async () => {
    const { a, redis } = await app()
    const views = await Promise.all(
      Array.from({ length: 5 }, () => a.inject({ url: `/dashboard-links/public/${TOKEN}` }))
    )
    const again = await a.inject({ url: `/dashboard-links/public/${TOKEN}` })
    expect(views.every((v) => v.statusCode === 200)).toBe(true)
    expect(again.json().data.widgets[0].data).toEqual({ value: 42 })
    expect(widgets.compute).toHaveBeenCalledTimes(1)
    expect(redis.store.has('dlpub:-:9')).toBe(true)
    await a.close()
  })

  it('PUBLIC_LINK_CACHE_S=0 computes every view (still single-flight)', async () => {
    process.env.PUBLIC_LINK_CACHE_S = '0'
    const { a } = await app()
    await a.inject({ url: `/dashboard-links/public/${TOKEN}` })
    await a.inject({ url: `/dashboard-links/public/${TOKEN}` })
    expect(widgets.compute).toHaveBeenCalledTimes(2)
    await a.close()
  })
})
