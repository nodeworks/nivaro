import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Staged layout edits (#2589): my draft is mine alone, others show as names and counts,
// bodies are validated, and the writes mark themselves config reads.

type Row = {
  id: number
  user: string
  collection: string
  item_key: string
  payload: string
  saved_at: Date
}

const m = vi.hoisted(() => ({
  rows: [] as Row[],
  nextId: 1,
  user: 'admin',
  hasTable: true,
  layoutExists: true,
  marked: [] as unknown[]
}))

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: m.user, role: 'admin-role' }
    req.isAdmin = true
  })
}))
vi.mock('../../../services/config-live.js', () => ({
  markConfigRead: vi.fn((req: unknown) => {
    m.marked.push(req)
  })
}))
vi.mock('../../../db/index.js', () => {
  const chain = (table: string) => {
    const where: Record<string, unknown> = {}
    let not: [string, unknown] | null = null
    const matches = (r: Row) =>
      Object.entries(where).every(
        ([k, v]) => (r as Record<string, unknown>)[k.replace(/^d\./, '')] === v
      ) &&
      (!not || (r as Record<string, unknown>)[not[0].replace(/^d\./, '')] !== not[1])
    const api: Record<string, unknown> = {
      leftJoin: () => api,
      orderBy: () => api,
      where: (w: Record<string, unknown>) => {
        Object.assign(where, w)
        return api
      },
      whereNot: (k: string, v: unknown) => {
        not = [k, v]
        return api
      },
      first: async () => {
        if (table === 'nivaro_collection_layouts') return m.layoutExists ? { id: 5 } : undefined
        return m.rows.find(matches)
      },
      select: async () =>
        m.rows.filter(matches).map((r) => ({
          user_id: r.user,
          payload: r.payload,
          saved_at: r.saved_at,
          first_name: r.user === 'ana' ? 'Ana' : null,
          last_name: r.user === 'ana' ? 'Ruiz' : null
        })),
      update: async (patch: Partial<Row>) => {
        for (const r of m.rows) if (matches(r)) Object.assign(r, patch)
        return 1
      },
      insert: async (row: Omit<Row, 'id'>) => {
        m.rows.push({ id: m.nextId++, ...row })
        return [m.nextId - 1]
      },
      delete: async () => {
        const before = m.rows.length
        m.rows = m.rows.filter((r) => !matches(r))
        return before - m.rows.length
      }
    }
    return api
  }
  return {
    db: Object.assign((t: string) => chain(t), {
      raw: vi.fn(),
      schema: { hasTable: async () => m.hasTable }
    })
  }
})

const { layoutStagedRoutes } = await import('../../../routes/layout-staged.js')
const { resetStagedTableCheck, STAGED_COLLECTION } = await import(
  '../../../services/layout-staged.js'
)

async function build() {
  const app = Fastify()
  await app.register(layoutStagedRoutes, { prefix: '/collection-layouts' })
  await app.ready()
  return app
}

const step = {
  label: 'Move Status',
  ops: [
    { op: 'move', from: { field: 'status', group_key: 'main' }, to_group_key: 'main', index: 0 }
  ]
}

beforeEach(() => {
  m.rows = []
  m.nextId = 1
  m.user = 'admin'
  m.hasTable = true
  m.layoutExists = true
  m.marked = []
  resetStagedTableCheck()
})

describe('staged layout edits', () => {
  it('keeps a draft and reads it back, under the layout-editor pseudo collection', async () => {
    const app = await build()
    const put = await app.inject({
      method: 'POST',
      url: '/collection-layouts/5/staged',
      payload: { steps: [step], base_rev: 'r1' }
    })
    expect(put.statusCode).toBe(200)
    expect(m.rows).toHaveLength(1)
    expect(m.rows[0]).toMatchObject({ user: 'admin', collection: STAGED_COLLECTION, item_key: '5' })
    expect(m.marked).toHaveLength(1)

    const get = await app.inject({ method: 'GET', url: '/collection-layouts/5/staged' })
    expect(get.statusCode).toBe(200)
    const body = get.json()
    expect(body.available).toBe(true)
    expect(body.data.base_rev).toBe('r1')
    expect(body.data.steps).toEqual([step])
    expect(body.others).toEqual([])
  })

  it('a second write replaces the row instead of adding one', async () => {
    const app = await build()
    for (const rev of ['r1', 'r2'])
      await app.inject({
        method: 'POST',
        url: '/collection-layouts/5/staged',
        payload: { steps: [step, step], base_rev: rev }
      })
    expect(m.rows).toHaveLength(1)
    const get = await app.inject({ method: 'GET', url: '/collection-layouts/5/staged' })
    expect(get.json().data.base_rev).toBe('r2')
    expect(get.json().data.steps).toHaveLength(2)
  })

  it('shows other people as names and counts only, never their changes', async () => {
    const app = await build()
    m.user = 'ana'
    await app.inject({
      method: 'POST',
      url: '/collection-layouts/5/staged',
      payload: { steps: [step, step, step], base_rev: 'r1' }
    })
    m.user = 'admin'
    const get = await app.inject({ method: 'GET', url: '/collection-layouts/5/staged' })
    const body = get.json()
    expect(body.data).toBeNull()
    expect(body.others).toHaveLength(1)
    expect(body.others[0]).toMatchObject({
      user_id: 'ana',
      name: 'Ana Ruiz',
      step_count: 3,
      op_count: 3
    })
    expect(JSON.stringify(body.others)).not.toContain('"ops"')
  })

  it('refuses a body without base_rev, empty steps or a malformed step', async () => {
    const app = await build()
    const cases = [
      { steps: [step] },
      { steps: [], base_rev: 'r1' },
      { steps: [{ label: 'x' }], base_rev: 'r1' },
      { steps: [{ label: 'x', ops: [] }], base_rev: 'r1' }
    ]
    for (const payload of cases) {
      const r = await app.inject({ method: 'POST', url: '/collection-layouts/5/staged', payload })
      expect(r.statusCode).toBe(400)
    }
    expect(m.rows).toHaveLength(0)
  })

  it('is 404 for a layout that does not exist', async () => {
    m.layoutExists = false
    const app = await build()
    const r = await app.inject({
      method: 'POST',
      url: '/collection-layouts/5/staged',
      payload: { steps: [step], base_rev: 'r1' }
    })
    expect(r.statusCode).toBe(404)
  })

  it('clear drops only my row', async () => {
    const app = await build()
    m.user = 'ana'
    await app.inject({
      method: 'POST',
      url: '/collection-layouts/5/staged',
      payload: { steps: [step], base_rev: 'r1' }
    })
    m.user = 'admin'
    await app.inject({
      method: 'POST',
      url: '/collection-layouts/5/staged',
      payload: { steps: [step], base_rev: 'r1' }
    })
    const r = await app.inject({ method: 'POST', url: '/collection-layouts/5/staged/clear' })
    expect(r.statusCode).toBe(200)
    expect(m.rows.map((x) => x.user)).toEqual(['ana'])
  })

  it('degrades without the drafts table: GET says unavailable, POST is 503', async () => {
    m.hasTable = false
    const app = await build()
    const get = await app.inject({ method: 'GET', url: '/collection-layouts/5/staged' })
    expect(get.json()).toEqual({ data: null, others: [], available: false })
    const put = await app.inject({
      method: 'POST',
      url: '/collection-layouts/5/staged',
      payload: { steps: [step], base_rev: 'r1' }
    })
    expect(put.statusCode).toBe(503)
  })
})
