import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The usage beacon (#2597): per-person rate limit, role-restricted layouts and record refs
// the sender cannot read are dropped one event at a time; the batch always answers 204.

const m = vi.hoisted(() => ({
  layouts: new Map<number, { collection: string; conditions: unknown }>(),
  readable: new Set<string>(),
  stored: [] as Array<{ layout_id: number; item: string | null }>,
  redisCount: 0,
  redisDown: false
}))

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'u1', role: 'r1' }
    req.isAdmin = false
  }),
  requireAdmin: vi.fn()
}))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../services/items.js', () => ({
  readItems: vi.fn(async (_u: unknown, _c: string, q: { filter: { id: { _in: string[] } } }) => ({
    data: q.filter.id._in.filter((id) => m.readable.has(id)).map((id) => ({ id: Number(id) }))
  })),
  readOne: vi.fn(async (_u: unknown, _c: string, id: string) =>
    m.readable.has(id) ? { id: 99 } : null
  )
}))
vi.mock('../../../services/layout-usage.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    usageTablesReady: vi.fn(async () => true),
    layoutUsageInfo: vi.fn(async (id: number) => m.layouts.get(id) ?? null),
    recordUsage: vi.fn(async (ev: { layout_id: number; item: string | null }) => {
      m.stored.push({ layout_id: ev.layout_id, item: ev.item })
    })
  }
})
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/layout-ab.js', () => ({
  abTestsForCollection: vi.fn(async () => []),
  abArmOf: vi.fn(() => null)
}))

const { layoutUsageRoutes } = await import('../../../routes/layout-usage.js')
const { resetWindowedMemory } = await import('../../../services/windowed-limit.js')

async function build() {
  const app = Fastify()
  app.decorate('redis', {
    eval: async (_s: string, _nk: number, _k: string, n: number) => {
      if (m.redisDown) throw new Error('down')
      m.redisCount += n
      return m.redisCount
    }
  } as never)
  await app.register(layoutUsageRoutes, { prefix: '/layout-usage' })
  await app.ready()
  return app
}

const ev = (layout_id: number, item: string | null = null) => ({
  layout_id,
  collection: 'orders',
  item,
  open: true,
  saved: false,
  steps: { __form__: 1000 }
})

beforeEach(() => {
  m.layouts = new Map([
    [1, { collection: 'orders', conditions: null }],
    [2, { collection: 'orders', conditions: JSON.stringify({ role_ids: ['other'] }) }]
  ])
  m.readable = new Set(['10', 'REQ-7'])
  m.stored = []
  m.redisCount = 0
  m.redisDown = false
  resetWindowedMemory()
})

describe('usage beacon', () => {
  it('drops events for a layout not open to the sender’s role', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'POST',
      url: '/layout-usage/beacon',
      payload: { events: [ev(1), ev(2)] }
    })
    expect(r.statusCode).toBe(204)
    expect(m.stored).toEqual([{ layout_id: 1, item: null }])
  })
  it('keeps readable record refs and drops unreadable ones, event by event', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'POST',
      url: '/layout-usage/beacon',
      payload: { events: [ev(1, '10'), ev(1, '11'), ev(1, 'REQ-7'), ev(1, 'REQ-8')] }
    })
    expect(r.statusCode).toBe(204)
    expect(m.stored.map((s) => s.item)).toEqual(['10', 'REQ-7'])
  })
  it('stores at most 20 events per request and 60 a minute per person', async () => {
    const app = await build()
    const batch = Array.from({ length: 25 }, () => ev(1))
    for (let i = 0; i < 4; i++)
      await app.inject({ method: 'POST', url: '/layout-usage/beacon', payload: { events: batch } })
    expect(m.stored).toHaveLength(60)
  })
  it('falls back to an in-process limit when Redis is down', async () => {
    m.redisDown = true
    const app = await build()
    const batch = Array.from({ length: 20 }, () => ev(1))
    for (let i = 0; i < 4; i++)
      await app.inject({ method: 'POST', url: '/layout-usage/beacon', payload: { events: batch } })
    expect(m.stored).toHaveLength(60)
  })
})
