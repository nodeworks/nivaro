// Form outputs (#2721 #2724): only a form the caller may open (LOW-3), and a
// linked record's label only where the caller may read that record (LOW-5).
import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
const state = vi.hoisted(() => ({
  layouts: [] as Row[],
  relations: [] as Row[],
  readable: new Set<string>(),
  visible: null as Set<string> | null,
  rows: [] as Row[],
  isAdmin: false
}))

vi.mock('../../../db/index.js', () => ({
  db: vi.fn((table: string) => {
    const wheres: Row[] = []
    const b: Record<string, unknown> = {}
    const rows = () => {
      const src =
        table === 'nivaro_collection_layouts'
          ? state.layouts
          : table === 'nivaro_relations'
            ? state.relations
            : []
      return src.filter((r) => wheres.every((w) => Object.entries(w).every(([k, v]) => r[k] === v)))
    }
    b.where = (w: Row) => {
      wheres.push(w)
      return b
    }
    for (const m of ['whereNotNull', 'whereNull', 'orderBy']) b[m] = () => b
    b.first = async () => rows()[0]
    b.select = () => b
    b.catch = () => Promise.resolve(undefined)
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is thenable
    b.then = (res: (v: Row[]) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(res, rej)
    return b
  })
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: any) => {
    req.user = { id: 'U1', role: 'R-CLERK' }
    req.isAdmin = state.isAdmin
  }),
  requireAdmin: vi.fn()
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/config-live.js', () => ({ markConfigRead: vi.fn() }))
vi.mock('../../../services/form-layout.js', () => ({
  loadFormLayout: vi.fn(async () => ({ groups: [] }))
}))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async (_u: unknown, _a: string, c: string) => state.readable.has(c)),
  getAllowedFields: vi.fn(async () => null)
}))
vi.mock('../../../services/record-access.js', () => ({
  compileAccessGates: vi.fn(async () => ({})),
  // The ids the database returns (MSSQL may upper-case them).
  visibleIds: vi.fn(async (_g: unknown, ids: string[]) =>
    state.visible
      ? new Set(
          [...state.visible].filter((v) => ids.some((i) => i.toLowerCase() === v.toLowerCase()))
        )
      : new Set(ids)
  )
}))
vi.mock('../../../services/queues.js', () => ({
  resolvePathValues: vi.fn(async (_c: string, rowIds: string[]) => {
    const m = new Map<string, { value: string }>()
    for (const id of rowIds) {
      const r = state.rows.find((x) => String(x.id) === id)
      if (r) m.set(id, { value: `Customer ${r.customer}` })
    }
    return m
  })
}))
const built = vi.hoisted(() => ({ records: null as Row[] | null }))
vi.mock('../../../services/layout-output.js', () => ({
  flattenForm: () => [{ path: 'title' }, { path: 'customer' }],
  buildSpreadsheet: (o: { records?: Row[] }) => {
    built.records = o.records ?? null
    return Buffer.from('xlsx')
  },
  blankFormHtml: () => '<html></html>',
  buildHelpSheet: vi.fn(),
  parseHelpSheet: vi.fn()
}))
vi.mock('../../../services/pdf-layout.js', () => ({
  htmlToPdf: vi.fn(async () => Buffer.from('%PDF'))
}))
vi.mock('../../../services/items.js', () => ({
  ForbiddenError: class extends Error {},
  readItems: vi.fn(async () => ({ data: state.rows.map((r) => ({ ...r })) }))
}))

import {
  mayUseLayout,
  readableLinkIds,
  registerLayoutOutputRoutes
} from '../../../routes/layout-output.js'
import type { User } from '../../../types.js'

const layout = (id: number, extra: Row = {}) => ({
  id,
  collection: 'orders',
  name: `Form ${id}`,
  layout_type: 'grouped',
  pdf_page_size: null,
  pdf_orientation: null,
  conditions: null,
  ...extra
})

let app: FastifyInstance
beforeEach(async () => {
  state.layouts = [
    layout(1),
    layout(2, { conditions: JSON.stringify({ role_ids: ['R-MANAGER'] }) }),
    layout(3, { layout_type: 'table' })
  ]
  state.relations = [
    { many_collection: 'orders', many_field: 'customer', one_collection: 'customers' }
  ]
  state.readable = new Set(['orders'])
  state.visible = null
  state.rows = [
    { id: 1, title: 'A', customer: 10 },
    { id: 2, title: 'B', customer: 20 }
  ]
  state.isAdmin = false
  built.records = null
  app = Fastify()
  await app.register(registerLayoutOutputRoutes, { prefix: '/collection-layouts' })
  await app.ready()
})

describe('mayUseLayout (LOW-3)', () => {
  it('a grouped form open to the role, or any grouped form for an admin', () => {
    const clerk = { role: 'R-CLERK' }
    expect(mayUseLayout(layout(1) as never, clerk, false)).toBe(true)
    expect(mayUseLayout(state.layouts[1] as never, clerk, false)).toBe(false)
    expect(mayUseLayout(state.layouts[1] as never, { role: 'r-manager' }, false)).toBe(true)
    expect(mayUseLayout(state.layouts[1] as never, clerk, true)).toBe(true)
    expect(mayUseLayout(state.layouts[2] as never, clerk, true)).toBe(false)
    expect(mayUseLayout(layout(4, { layout_type: null }) as never, clerk, false)).toBe(true)
  })

  it('template, blank form and export answer 404 for a form restricted to another role', async () => {
    state.readable.add('orders')
    for (const [method, url] of [
      ['GET', '/collection-layouts/2/spreadsheet-template'],
      ['GET', '/collection-layouts/2/blank-form'],
      ['POST', '/collection-layouts/2/spreadsheet-export']
    ] as const) {
      const r = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined })
      expect(r.statusCode, url).toBe(404)
    }
    const ok = await app.inject({ method: 'GET', url: '/collection-layouts/1/blank-form' })
    expect(ok.statusCode).toBe(200)
    state.isAdmin = true
    const admin = await app.inject({ method: 'GET', url: '/collection-layouts/2/blank-form' })
    expect(admin.statusCode).toBe(200)
  })
})

describe('export link labels (LOW-5)', () => {
  it('keeps the stored id when the caller may not read the linked collection', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/collection-layouts/1/spreadsheet-export',
      payload: {}
    })
    expect(r.statusCode).toBe(200)
    expect(built.records?.map((x) => x.customer)).toEqual([10, 20])
  })

  it('labels only the linked records the caller may see', async () => {
    state.readable.add('customers')
    state.visible = new Set(['10'])
    const r = await app.inject({
      method: 'POST',
      url: '/collection-layouts/1/spreadsheet-export',
      payload: {}
    })
    expect(r.statusCode).toBe(200)
    expect(built.records?.map((x) => x.customer)).toEqual(['Customer 10', 20])
  })

  it('readableLinkIds: none without permission; case-insensitive id match', async () => {
    const u = { id: 'U1', role: 'R-CLERK' } as unknown as User
    expect((await readableLinkIds(u, 'customers', ['1'], false)).size).toBe(0)
    state.readable.add('customers')
    state.visible = new Set(['ABC'])
    expect([...(await readableLinkIds(u, 'customers', ['abc', 'def'], false))]).toEqual(['abc'])
  })
})
