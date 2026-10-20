import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

// GET /widgets-internal/:id/placements — the layouts that place a widget, named by the
// layout editor before a change to the widget's own config (it changes every one of them).
const auth = vi.hoisted(() => ({ admin: true }))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'u1', role: 'R' }
    req.isAdmin = auth.admin
  }),
  requireAdmin: vi.fn(async (req: { isAdmin?: boolean }, reply: any) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Admin only' })
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))

const seen = vi.hoisted(() => ({ table: '', where: [] as unknown[] }))
vi.mock('../../../db/index.js', () => ({
  db: vi.fn((table: string) => {
    seen.table = table
    const c: Record<string, any> = {}
    c.join = vi.fn(() => c)
    c.where = vi.fn((...a: unknown[]) => {
      seen.where.push(a)
      return c
    })
    c.distinct = vi.fn(() => c)
    c.orderBy = vi.fn(async () => [
      { id: 4, name: 'Order form', collection: 'orders' },
      { id: 9, name: 'Quick view', collection: 'invoices' }
    ])
    return c
  })
}))

import { widgetsInternalRoutes } from '../../../routes/widgets-internal.js'

async function get(path: string) {
  const app = Fastify({ logger: false })
  app.register(widgetsInternalRoutes, { prefix: '/widgets-internal' })
  await app.ready()
  const res = await app.inject({ method: 'GET', url: path })
  await app.close()
  return res
}

describe('GET /widgets-internal/:id/placements', () => {
  it('lists the layouts that place the widget', async () => {
    auth.admin = true
    const res = await get('/widgets-internal/5/placements')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      data: [
        { layout_id: 4, name: 'Order form', collection: 'orders' },
        { layout_id: 9, name: 'Quick view', collection: 'invoices' }
      ]
    })
    expect(seen.table).toBe('nivaro_layout_field_assignments as a')
    expect(seen.where).toContainEqual(['a.widget_id', 5])
  })

  it('is admin only', async () => {
    auth.admin = false
    const res = await get('/widgets-internal/5/placements')
    expect(res.statusCode).toBe(403)
  })
})
