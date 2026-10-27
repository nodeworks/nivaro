import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// M1 (security audit 2026-10-27): record links judge every end as the
// caller — the record, the other end, the labels — never collection-level.

const st = vi.hoisted(() => ({
  visible: new Set<string>(),
  links: [] as Array<Record<string, unknown>>,
  inserted: [] as unknown[],
  deleted: 0,
  labelAsked: [] as Array<[string, string[]]>
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'U1', role: 'R1' }
    req.isAdmin = false
  }
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/revision-access.js', () => ({
  recordVisibleTo: vi.fn(async (_r: unknown, c: string, i: string) => st.visible.has(`${c}:${i}`))
}))
vi.mock('../../../services/record-access.js', () => ({
  compileAccessGates: vi.fn(async (_u: unknown, c: string) => ({ collection: c })),
  visibleIds: vi.fn(
    async (g: { collection: string }, ids: string[]) =>
      new Set(ids.filter((i) => st.visible.has(`${g.collection}:${i}`)))
  )
}))
vi.mock('../../../services/ai-link-labels.js', () => ({
  linkLabelsAsUser: vi.fn(async (_u: unknown, m: Map<string, Set<string>>) => {
    const out: Record<string, string> = {}
    for (const [c, ids] of m) {
      st.labelAsked.push([c, [...ids]])
      for (const i of ids) out[`${c}:${i}`] = `${c} #${i}`
    }
    return out
  })
}))
vi.mock('../../../db/index.js', () => ({
  db: (_table: string) => {
    let filter: Record<string, unknown> = {}
    const b: Record<string, unknown> = {}
    b.where = (f: unknown, v?: unknown) => {
      filter = typeof f === 'string' ? { [f]: v } : (f as Record<string, unknown>)
      return b
    }
    b.first = async () => ('id' in filter ? st.links.find((l) => l.id === filter.id) : undefined)
    b.insert = async (row: unknown) => {
      st.inserted.push(row)
      return [1]
    }
    b.del = async () => {
      st.deleted++
      return 1
    }
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    b.then = (res: (v: unknown) => unknown) =>
      Promise.resolve(
        st.links.filter((l) => Object.entries(filter).every(([k, v]) => String(l[k]) === String(v)))
      ).then(res)
    return b
  }
}))

import { recordLinkRoutes } from '../../../routes/record-links.js'

async function app() {
  const a = Fastify()
  await a.register(recordLinkRoutes, { prefix: '/api' })
  return a
}

beforeEach(() => {
  st.visible = new Set(['orders:1', 'orders:2'])
  st.links = [
    { id: 10, from_collection: 'orders', from_item: '1', to_collection: 'orders', to_item: '2' },
    { id: 11, from_collection: 'orders', from_item: '1', to_collection: 'salaries', to_item: '7' }
  ]
  st.inserted = []
  st.deleted = 0
  st.labelAsked = []
})

describe('GET /record-links/:collection/:id', () => {
  it('answers 404 for a record the caller cannot open', async () => {
    const r = await (await app()).inject({ method: 'GET', url: '/api/record-links/orders/9' })
    expect(r.statusCode).toBe(404)
  })

  it('leaves out links to hidden records and labels only visible ones', async () => {
    const r = await (await app()).inject({ method: 'GET', url: '/api/record-links/orders/1' })
    expect(r.statusCode).toBe(200)
    const data = r.json().data as Array<Record<string, unknown>>
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({ collection: 'orders', item: '2', label: 'orders #2' })
    expect(st.labelAsked).toEqual([['orders', ['2']]])
  })
})

describe('POST /record-links', () => {
  it('refuses a link to a record the caller cannot see', async () => {
    const r = await (await app()).inject({
      method: 'POST',
      url: '/api/record-links',
      payload: {
        from_collection: 'orders',
        from_item: '1',
        to_collection: 'salaries',
        to_item: '7'
      }
    })
    expect(r.statusCode).toBe(404)
    expect(st.inserted).toEqual([])
  })

  it('links two visible records', async () => {
    st.links = []
    const r = await (await app()).inject({
      method: 'POST',
      url: '/api/record-links',
      payload: { from_collection: 'orders', from_item: '1', to_collection: 'orders', to_item: '2' }
    })
    expect(r.statusCode).toBe(201)
    expect(st.inserted).toHaveLength(1)
  })
})

describe('DELETE /record-links/:id', () => {
  it('needs both ends visible', async () => {
    const a = await app()
    expect((await a.inject({ method: 'DELETE', url: '/api/record-links/11' })).statusCode).toBe(404)
    expect(st.deleted).toBe(0)
    expect((await a.inject({ method: 'DELETE', url: '/api/record-links/10' })).statusCode).toBe(200)
    expect(st.deleted).toBe(1)
  })
})
