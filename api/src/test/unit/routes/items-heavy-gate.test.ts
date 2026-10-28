import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Heavy /items reads hold a read-gate slot (2026-10-27): aggregate, export, distinct,
// child-summary and resolve-paths. /distinct checks its column through the column cache,
// never an INFORMATION_SCHEMA read per call.

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'U-1', role: 'R-1' }
    req.isAdmin = false
  }
}))
vi.mock('../../../middleware/workspace.js', () => ({ resolveWorkspace: async () => {} }))
vi.mock('../../../services/idempotency.js', () => ({
  idempotencyPreHandler: () => async () => {}
}))
const gate = vi.hoisted(() => ({ labels: [] as string[] }))
vi.mock('../../../services/read-gate.js', async (orig) => ({
  ...(await orig<object>()),
  withReadGate: async (_who: unknown, fn: () => Promise<unknown>, opts: { label?: string }) => {
    gate.labels.push(opts?.label ?? '')
    return fn()
  }
}))
vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<object>()),
  can: async () => true
}))
const svc = vi.hoisted(() => ({
  readItems: vi.fn(async () => ({ data: [{ id: 1 }] })),
  aggregateItems: vi.fn(async () => ({ data: [{ group: { status: 'open' } }] })),
  actualColumnName: vi.fn(async (_t: string, c: string) => (c === 'status' ? 'status' : null)),
  getActualColumns: vi.fn(async () => new Set(['id', 'status']))
}))
vi.mock('../../../services/items.js', async (orig) => ({
  ...(await orig<object>()),
  ...svc
}))
const dbRaw = vi.hoisted(() => vi.fn())
vi.mock('../../../db/index.js', async (orig) => {
  const real = await orig<{ db: object }>()
  const db = new Proxy(real.db, {
    get: (t, p) => (p === 'raw' ? dbRaw : Reflect.get(t, p))
  })
  return { ...real, db }
})

import { itemsRoutes } from '../../../routes/items.js'

async function app() {
  const a = Fastify()
  await a.register(itemsRoutes, { prefix: '/api/items' })
  return a
}

describe('heavy /items reads', () => {
  beforeEach(() => {
    gate.labels = []
    dbRaw.mockReset()
  })

  it('aggregate is gated', async () => {
    const res = await (await app()).inject({ url: '/api/items/orders/aggregate?groupBy=status' })
    expect(res.statusCode).toBe(200)
    expect(gate.labels).toEqual(['items:aggregate:orders'])
  })

  it('export is gated (one slot for the whole page loop)', async () => {
    const res = await (await app()).inject({ url: '/api/items/orders/export?format=json' })
    expect(res.statusCode).toBe(200)
    expect(gate.labels).toEqual(['items:export:orders'])
  })

  it('distinct uses the column cache and is gated', async () => {
    const res = await (await app()).inject({ url: '/api/items/orders/distinct?field=status' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: ['open'] })
    expect(dbRaw).not.toHaveBeenCalled()
    expect(svc.actualColumnName).toHaveBeenCalledWith('orders', 'status')
    expect(gate.labels).toEqual(['items:distinct:orders'])
  })

  it('distinct refuses a column the table does not have, before the gate', async () => {
    const res = await (await app()).inject({ url: '/api/items/orders/distinct?field=nope' })
    expect(res.statusCode).toBe(400)
    expect(gate.labels).toEqual([])
  })
})
