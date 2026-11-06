import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// GET /revisions/latest (army4 M1): the grid's per-line mid-air baseline in
// one read. Judged as the caller — an id the caller cannot read is left out,
// never confirmed — and capped.
const s = vi.hoisted(() => ({
  isAdmin: false,
  canRead: true,
  visible: new Set<string>(),
  latest: [] as Array<{ item: string; latest: number }>,
  lastIds: [] as string[]
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'u1', role: 'R' }
    req.isAdmin = s.isAdmin
  }
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => s.canRead),
  getAllowedFields: vi.fn(async () => null)
}))
const access = vi.hoisted(() => ({
  compileAccessGates: vi.fn(async () => ({ gates: true })),
  visibleIds: vi.fn(async (_g: unknown, ids: string[]) => {
    s.lastIds = ids
    return new Set(ids.filter((i) => s.visible.has(i)))
  })
}))
vi.mock('../../../services/record-access.js', () => access)
vi.mock('../../../services/revision-access.js', () => ({
  o2mParentCollection: vi.fn(async () => null),
  o2mParentVisibleTo: vi.fn(async () => true),
  recordVisibleTo: vi.fn(async () => true)
}))
const dbCalls = vi.hoisted(() => ({ items: [] as string[][] }))
vi.mock('../../../db/index.js', () => {
  const db = vi.fn(() => {
    let ids: string[] = []
    const c: Record<string, unknown> = {}
    for (const m of ['where', 'groupBy', 'select', 'whereRaw']) c[m] = () => c
    c.whereIn = (_col: string, v: string[]) => {
      ids = v.map(String)
      dbCalls.items.push(ids)
      return c
    }
    // biome-ignore lint/suspicious/noThenProperty: knex builders are awaitable
    c.then = (res: (v: unknown) => unknown) =>
      Promise.resolve(s.latest.filter((r) => ids.includes(r.item))).then(res)
    return c
  })
  ;(db as unknown as { raw: unknown }).raw = vi.fn(() => 'raw')
  return { db }
})

import { LATEST_REVISIONS_MAX, revisionsRoutes } from '../../../routes/revisions.js'

async function get(url: string) {
  const app = Fastify({ logger: false })
  await app.register(revisionsRoutes, { prefix: '/revisions' })
  return app.inject({ method: 'GET', url: `/revisions${url}` })
}

describe('GET /revisions/latest', () => {
  beforeEach(() => {
    s.isAdmin = false
    s.canRead = true
    s.visible = new Set(['1', '2', '3'])
    s.latest = [
      { item: '1', latest: 40 },
      { item: '2', latest: 55 },
      { item: '9', latest: 99 }
    ]
    dbCalls.items = []
    access.visibleIds.mockClear()
  })

  it('answers the newest revision per readable item; no revision = null', async () => {
    const r = await get('/latest?collection=workflow_line_items&items=1,2,3')
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toEqual({ '1': 40, '2': 55, '3': null })
  })

  it('leaves out an id the caller cannot read and never queries its revisions', async () => {
    const r = await get('/latest?collection=workflow_line_items&items=1,9')
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toEqual({ '1': 40 })
    expect(dbCalls.items.flat()).not.toContain('9')
  })

  it('judges visibility as the caller (gates compiled for the collection)', async () => {
    await get('/latest?collection=workflow_line_items&items=1')
    expect(access.compileAccessGates).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }),
      'workflow_line_items',
      { actingAdmin: false }
    )
  })

  it('refuses more than the cap', async () => {
    const ids = Array.from({ length: LATEST_REVISIONS_MAX + 1 }, (_, i) => String(i + 1)).join(',')
    const r = await get(`/latest?collection=workflow_line_items&items=${ids}`)
    expect(r.statusCode).toBe(400)
    expect(r.json().code).toBe('TOO_MANY_ITEMS')
    expect(access.visibleIds).not.toHaveBeenCalled()
  })

  it('accepts exactly the cap', async () => {
    const ids = Array.from({ length: LATEST_REVISIONS_MAX }, (_, i) => String(i + 1)).join(',')
    const r = await get(`/latest?collection=workflow_line_items&items=${ids}`)
    expect(r.statusCode).toBe(200)
  })

  it('refuses system, chat and files collections', async () => {
    for (const c of ['nivaro_users', 'directus_files', 'chat_messages', 'files']) {
      const r = await get(`/latest?collection=${c}&items=1`)
      expect(r.statusCode).toBe(403)
    }
  })

  it('404 when the caller cannot read the collection at all', async () => {
    s.canRead = false
    const r = await get('/latest?collection=workflow_line_items&items=1')
    expect(r.statusCode).toBe(404)
  })

  it('400 without items or with a bad collection name', async () => {
    expect((await get('/latest?collection=workflow_line_items')).statusCode).toBe(400)
    expect((await get('/latest?collection=bad;name&items=1')).statusCode).toBe(400)
  })
})
