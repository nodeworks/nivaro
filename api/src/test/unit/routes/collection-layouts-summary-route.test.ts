import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: { id: string; role?: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-user', role: 'r1' }
    req.isAdmin = false
  }),
  requireAdmin: vi.fn(async () => {})
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))

// A tiny knex stand-in: rows per table, `where` filters by equality, thenable.
const tables: Record<string, Record<string, unknown>[]> = {}
const orderCalls: string[] = []
vi.mock('../../../db/index.js', () => {
  const builder = (table: string) => {
    const filter: Record<string, unknown> = {}
    const match = () =>
      (tables[table] ?? []).filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v))
    const b: Record<string, unknown> = {
      where(o: Record<string, unknown>) {
        Object.assign(filter, o)
        return b
      },
      orderBy: () => b,
      select: () => b,
      orderByRaw(sql: string) {
        orderCalls.push(sql)
        return b
      },
      first: () => Promise.resolve(match()[0]),
      // biome-ignore lint/suspicious/noThenProperty: knex builders are thenables
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(match()).then(res, rej)
    }
    return b
  }
  const d = vi.fn(builder)
  return {
    db: Object.assign(d, { transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(d)) })
  }
})

import { collectionLayoutsRoutes } from '../../../routes/collection-layouts.js'
import { SUMMARY_CANDIDATE_ORDER } from '../../../services/summary-pick.js'

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(collectionLayoutsRoutes, { prefix: '/collection-layouts' })
  return app
}

const layout = (row: Record<string, unknown>) => ({
  collection: 'workflows',
  sort: 0,
  is_active: false,
  conditions: null,
  ...row
})

afterEach(() => {
  orderCalls.length = 0
  for (const k of Object.keys(tables)) delete tables[k]
  vi.clearAllMocks()
})

describe('GET /collection-layouts/summary/:collection', () => {
  it('reads Summary candidates in is_active desc, sort asc, id asc order', async () => {
    tables.nivaro_collection_layouts = [
      layout({ id: 86, layout_type: 'summary', is_active: true, name: 'Summary' })
    ]
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/collection-layouts/summary/workflows' })
    expect(res.statusCode).toBe(200)
    expect(SUMMARY_CANDIDATE_ORDER).toBe('is_active desc, sort asc, id asc')
    expect(orderCalls).toContain(SUMMARY_CANDIDATE_ORDER)
  })

  it('an A/B test version of a record form gets the Summary pinned to its control form', async () => {
    tables.nivaro_collection_layouts = [
      layout({ id: 10, layout_type: 'grouped', is_active: true, name: 'PO Request' }),
      layout({
        id: 12,
        layout_type: 'grouped',
        name: 'PO Request (test)',
        conditions: {
          ab: { control_id: 10, role_id: 'r1', salt: 'abcd1234', started_at: '2026-11-01' }
        }
      }),
      layout({ id: 86, layout_type: 'summary', is_active: true, name: 'Summary' }),
      layout({
        id: 90,
        layout_type: 'summary',
        name: 'PO Summary',
        conditions: { summary_for: [10] }
      })
    ]
    const app = buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/collection-layouts/summary/workflows?for_layout=12'
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { data: { layout: { id: number; summary_reason: string } } }
    expect(body.data.layout.id).toBe(90)
    expect(body.data.layout.summary_reason).toBe('pinned')
  })

  it("the phone version of an A/B test version maps to the control's pin", async () => {
    tables.nivaro_collection_layouts = [
      layout({ id: 10, layout_type: 'grouped', is_active: true, name: 'PO Request' }),
      layout({
        id: 12,
        layout_type: 'grouped',
        name: 'PO Request (test)',
        conditions: {
          ab: { control_id: 10, role_id: 'r1', salt: 'abcd1234', started_at: '2026-11-01' }
        }
      }),
      layout({ id: 13, layout_type: 'grouped', name: 'test phone', conditions: { phone_of: 12 } }),
      layout({ id: 86, layout_type: 'summary', is_active: true, name: 'Summary' }),
      layout({
        id: 90,
        layout_type: 'summary',
        name: 'PO Summary',
        conditions: { summary_for: [10] }
      })
    ]
    const app = buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/collection-layouts/summary/workflows?for_layout=13'
    })
    const body = res.json() as { data: { layout: { id: number } } }
    expect(body.data.layout.id).toBe(90)
  })

  it('a form whose A/B control is gone keeps its own id (an ordinary form again)', async () => {
    tables.nivaro_collection_layouts = [
      layout({
        id: 12,
        layout_type: 'grouped',
        name: 'orphan test',
        conditions: {
          ab: { control_id: 10, role_id: 'r1', salt: 'abcd1234', started_at: '2026-11-01' }
        }
      }),
      layout({ id: 86, layout_type: 'summary', is_active: true, name: 'Summary' }),
      layout({
        id: 91,
        layout_type: 'summary',
        name: 'Own Summary',
        conditions: { summary_for: [12] }
      })
    ]
    const app = buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/collection-layouts/summary/workflows?for_layout=12'
    })
    const body = res.json() as { data: { layout: { id: number } } }
    expect(body.data.layout.id).toBe(91)
  })
})

describe('Summary candidate order (guard)', () => {
  it('every Summary candidate read in collection-layouts.ts uses SUMMARY_CANDIDATE_ORDER', () => {
    const src = readFileSync(
      join(import.meta.dirname, '../../../routes/collection-layouts.ts'),
      'utf8'
    )
    const reads = src.split("layout_type: 'summary' })").slice(1)
    expect(reads.length).toBeGreaterThanOrEqual(2)
    for (const after of reads) {
      const order = after.slice(0, 200).match(/\.orderByRaw\(([^)]*)\)/)?.[1]
      expect(order).toBe('SUMMARY_CANDIDATE_ORDER')
    }
  })
})
