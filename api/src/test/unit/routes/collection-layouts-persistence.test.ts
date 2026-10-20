import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Route-harness idiom of collection-layouts-active.test.ts (mocked auth +
// activity + db). The db here is a small in-memory knex stand-in so the tests
// can assert what was stored rather than which chain was called.

type Row = Record<string, unknown>

const fake = vi.hoisted(() => {
  const tables: Record<string, Row[]> = {}
  let nextId = 1000
  const transactions = { count: 0 }

  type Pred = (r: Row) => boolean
  const eq = (a: unknown, b: unknown) =>
    b == null ? a == null : a != null && String(a) === String(b)
  const colName = (spec: string) => {
    const m = /^(\S+)\s+as\s+(\S+)$/i.exec(spec)
    return m ? { from: m[1], to: m[2] } : { from: spec, to: spec }
  }
  const project = (r: Row, cols: string[]) => {
    if (cols.length === 0 || cols.includes('*')) return { ...r }
    const out: Row = {}
    for (const c of cols) {
      const { from, to } = colName(c)
      out[to] = r[from]
    }
    return out
  }

  class Q {
    clauses: Array<{ or: boolean; pred: Pred }> = []
    orders: Array<[string, 'asc' | 'desc']> = []
    cols: string[] = []
    lim: number | undefined
    agg: { kind: 'max' | 'count'; from: string; to: string } | null = null
    constructor(readonly table: string) {}
    private add(or: boolean, pred: Pred) {
      this.clauses.push({ or, pred })
      return this
    }
    private predOf(a: unknown, b?: unknown, c?: unknown, argc = 1): Pred {
      if (typeof a === 'function') {
        const sub = new Q(this.table)
        ;(a as (this: Q, q: Q) => void).call(sub, sub)
        return (r) => sub.test(r)
      }
      if (a && typeof a === 'object') {
        const obj = a as Row
        return (r) => Object.entries(obj).every(([k, v]) => eq(r[k], v))
      }
      const col = String(a)
      if (argc === 3) {
        const op = String(b)
        if (op === '<>' || op === '!=') return (r) => !eq(r[col], c)
        return (r) => eq(r[col], c)
      }
      return (r) => eq(r[col], b)
    }
    test(r: Row) {
      let acc = true
      this.clauses.forEach((cl, i) => {
        const v = cl.pred(r)
        acc = i === 0 ? v : cl.or ? acc || v : acc && v
      })
      return acc
    }
    where(...args: unknown[]) {
      return this.add(false, this.predOf(args[0], args[1], args[2], args.length))
    }
    andWhere(...args: unknown[]) {
      return this.add(false, this.predOf(args[0], args[1], args[2], args.length))
    }
    orWhere(...args: unknown[]) {
      return this.add(true, this.predOf(args[0], args[1], args[2], args.length))
    }
    whereNot(...args: unknown[]) {
      const p = this.predOf(args[0], args[1], undefined, args.length)
      return this.add(false, (r) => !p(r))
    }
    whereNull(col: string) {
      return this.add(false, (r) => r[col] == null)
    }
    orWhereNull(col: string) {
      return this.add(true, (r) => r[col] == null)
    }
    whereNotNull(col: string) {
      return this.add(false, (r) => r[col] != null)
    }
    whereIn(col: string, vals: unknown[]) {
      return this.add(false, (r) => vals.some((v) => eq(r[col], v)))
    }
    whereNotIn(col: string, vals: unknown[]) {
      return this.add(false, (r) => !vals.some((v) => eq(r[col], v)))
    }
    orderBy(col: string, dir: 'asc' | 'desc' = 'asc') {
      this.orders.push([col, dir])
      return this
    }
    limit(n: number) {
      this.lim = n
      return this
    }
    select(...cols: Array<string | string[]>) {
      this.cols = cols.flat()
      return this
    }
    max(spec: string) {
      const { from, to } = colName(spec)
      this.agg = { kind: 'max', from, to }
      return this
    }
    count(spec: string) {
      const { from, to } = colName(spec)
      this.agg = { kind: 'count', from, to }
      return this
    }
    private rows(): Row[] {
      if (!tables[this.table]) tables[this.table] = []
      return tables[this.table]
    }
    private matched() {
      const rows = this.rows().filter((r) => this.test(r))
      for (const [col, dir] of [...this.orders].reverse()) {
        rows.sort((x, y) => {
          const a = x[col] as number
          const b = y[col] as number
          const d = a === b ? 0 : a == null ? -1 : b == null ? 1 : a < b ? -1 : 1
          return dir === 'desc' ? -d : d
        })
      }
      return this.lim != null ? rows.slice(0, this.lim) : rows
    }
    private result(): Row[] {
      const rows = this.matched()
      if (this.agg) {
        const vals = rows.map((r) => r[this.agg?.from ?? ''])
        const v =
          this.agg.kind === 'count'
            ? rows.length
            : vals.length
              ? Math.max(...vals.map((x) => Number(x)))
              : null
        return [{ [this.agg.to]: v }]
      }
      return rows.map((r) => project(r, this.cols))
    }
    async first(...cols: string[]) {
      if (cols.length) this.cols = cols
      return this.result()[0]
    }
    async pluck(col: string) {
      return this.matched().map((r) => r[col])
    }
    async insert(data: Row | Row[]) {
      const list = Array.isArray(data) ? data : [data]
      const ids: number[] = []
      for (const d of list) {
        const row: Row = { ...d }
        if (row.id == null) row.id = nextId++
        this.checkContainer(row)
        this.rows().push(row)
        ids.push(Number(row.id))
      }
      return ids
    }
    async update(patch: Row) {
      const rows = this.matched()
      for (const r of rows) this.checkContainer({ ...r, ...patch })
      for (const r of rows) Object.assign(r, patch)
      return rows.length
    }
    // nivaro_field_groups.container_id must name an existing group (FK, 547).
    checkContainer(row: Row) {
      if (this.table !== 'nivaro_field_groups' || row.container_id == null) return
      const ids = new Set([...this.rows().map((r) => String(r.id)), String(row.id)])
      if (!ids.has(String(row.container_id)))
        throw new Error(`FK conflict (547): container_id ${row.container_id} does not exist`)
    }
    async delete() {
      const rows = new Set(this.matched())
      const left = (tables[this.table] ?? []).filter((r) => !rows.has(r))
      // nivaro_field_groups.container_id is a NO ACTION self-FK (migration 096).
      if (this.table === 'nivaro_field_groups') {
        const gone = new Set([...rows].map((r) => String(r.id)))
        const blocked = left.find((r) => r.container_id != null && gone.has(String(r.container_id)))
        if (blocked)
          throw new Error(
            `FK conflict: group ${blocked.id} has container_id ${blocked.container_id}`
          )
      }
      tables[this.table] = left
      return rows.size
    }
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenables
    then<T>(ok: (rows: Row[]) => T, fail?: (e: unknown) => T) {
      return Promise.resolve(this.result()).then(ok, fail)
    }
  }

  const db = Object.assign((table: string) => new Q(table), {
    async transaction<T>(cb: (trx: unknown) => Promise<T>): Promise<T> {
      transactions.count++
      const before = JSON.parse(JSON.stringify(tables)) as Record<string, Row[]>
      try {
        return await cb(db)
      } catch (err) {
        for (const k of Object.keys(tables)) delete tables[k]
        Object.assign(tables, before)
        throw err
      }
    }
  })

  function reset(seed: Record<string, Row[]>) {
    for (const k of Object.keys(tables)) delete tables[k]
    for (const [k, rows] of Object.entries(seed)) tables[k] = rows.map((r) => ({ ...r }))
    nextId = 1000
    transactions.count = 0
  }

  return { db, tables, reset, transactions }
})

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: { id: string; role?: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-user', role: 'user' }
    req.isAdmin = false
  }),
  requireAdmin: vi.fn(async (req: { user?: { id: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-admin' }
    req.isAdmin = true
  })
}))

vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))

vi.mock('../../../db/index.js', () => ({ db: fake.db }))

import { collectionLayoutsRoutes, nextFreeSlug } from '../../../routes/collection-layouts.js'
import { restoreLayoutVersion, snapshotLayoutVersion } from '../../../services/layout-versions.js'

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(collectionLayoutsRoutes, { prefix: '/collection-layouts' })
  return app
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const app = buildApp()
  await app.ready()
  const res = await app.inject({
    method,
    url: `/collection-layouts${url}`,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {})
  })
  await app.close()
  return res
}

const layout = (over: Row): Row => ({
  collection: 'c',
  name: `Layout ${over.id}`,
  slug: null,
  layout_type: 'grouped',
  is_active: 0,
  sort: Number(over.id),
  parent_layout_id: null,
  addendum_layout_id: null,
  conditions: null,
  ...over
})

const rowOf = (id: number) =>
  fake.tables.nivaro_collection_layouts.find((r) => Number(r.id) === id) as Row

beforeEach(() => fake.reset({}))

describe('PATCH /collection-layouts/:id', () => {
  it('PATCH saves every editable column', async () => {
    fake.reset({ nivaro_collection_layouts: [layout({ id: 1 })] })
    const body = {
      disable_revisions: true,
      disable_clone: true,
      disable_delete: true,
      accordion_mode: true,
      summary_hide_empty: true,
      row_order_field: 'line_no',
      pdf_theme: 'minimal',
      pdf_template_id: 7,
      pdf_cover_enabled: false,
      pdf_cover_title_field: 'title',
      pdf_cover_subtitle: 'Prepared for review',
      pdf_show_logo: false,
      pdf_page_size: 'Letter',
      pdf_orientation: 'landscape',
      pdf_button_label: 'Print order'
    }
    const res = await call('PATCH', '/1', body)
    expect(res.statusCode).toBe(200)
    expect(rowOf(1)).toMatchObject({
      disable_revisions: 1,
      disable_clone: 1,
      disable_delete: 1,
      accordion_mode: 1,
      summary_hide_empty: 1,
      row_order_field: 'line_no',
      pdf_theme: 'minimal',
      pdf_template_id: 7,
      pdf_cover_enabled: 0,
      pdf_cover_title_field: 'title',
      pdf_cover_subtitle: 'Prepared for review',
      pdf_show_logo: 0,
      pdf_page_size: 'Letter',
      pdf_orientation: 'landscape',
      pdf_button_label: 'Print order'
    })
  })

  it('PATCH clears nullable settings and rejects bad values', async () => {
    fake.reset({
      nivaro_collection_layouts: [
        layout({ id: 1, row_order_field: 'line_no', pdf_button_label: 'x', pdf_template_id: 3 })
      ]
    })
    const res = await call('PATCH', '/1', {
      row_order_field: null,
      pdf_button_label: '',
      pdf_template_id: null
    })
    expect(res.statusCode).toBe(200)
    expect(rowOf(1)).toMatchObject({
      row_order_field: null,
      pdf_button_label: null,
      pdf_template_id: null
    })

    expect((await call('PATCH', '/1', { pdf_page_size: 'A3' })).statusCode).toBe(400)
    expect((await call('PATCH', '/1', { pdf_orientation: 'sideways' })).statusCode).toBe(400)
    expect((await call('PATCH', '/1', { pdf_theme: 'neon' })).statusCode).toBe(400)
    expect((await call('PATCH', '/1', { row_order_field: 'bad name;' })).statusCode).toBe(400)
  })

  it('PATCH ignores retired keys', async () => {
    fake.reset({ nivaro_collection_layouts: [layout({ id: 1, summary_show_all: 0 })] })
    const res = await call('PATCH', '/1', {
      summary_show_all: true,
      allow_clone: true,
      addendum_lock_fields: false
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('No fields to update')
    expect(rowOf(1).summary_show_all).toBe(0)
    expect(rowOf(1).allow_clone).toBeUndefined()
  })

  it('PATCH refuses a slug another layout of the collection already uses', async () => {
    fake.reset({
      nivaro_collection_layouts: [layout({ id: 1, slug: 'main' }), layout({ id: 2 })]
    })
    const res = await call('PATCH', '/2', { slug: 'Main' })
    expect(res.statusCode).toBe(409)
    expect(rowOf(2).slug).toBeNull()
    // Its own slug re-sent unchanged is fine.
    expect((await call('PATCH', '/1', { slug: 'main' })).statusCode).toBe(200)
  })

  it('PATCH leaves a legacy slug re-sent unchanged as stored', async () => {
    fake.reset({
      nivaro_collection_layouts: [layout({ id: 1, slug: 'Cost (Q1)/R&D' }), layout({ id: 2 })]
    })
    const res = await call('PATCH', '/1', { slug: 'Cost (Q1)/R&D', name: 'Cost form' })
    expect(res.statusCode).toBe(200)
    expect(rowOf(1).slug).toBe('Cost (Q1)/R&D')
    expect(rowOf(1).name).toBe('Cost form')
    // Changing it does normalise.
    expect((await call('PATCH', '/1', { slug: 'Cost (Q2)' })).statusCode).toBe(200)
    expect(rowOf(1).slug).toBe('cost_q2')
  })
})

describe('activate is the only way is_active changes per type', () => {
  it('PATCH {is_active:true} on a grouped layout deactivates other grouped layouts', async () => {
    fake.reset({
      nivaro_collection_layouts: [
        layout({ id: 1, is_active: 1 }),
        layout({ id: 2, layout_type: null }),
        layout({ id: 3, layout_type: 'detail', is_active: 1 }),
        layout({ id: 4, collection: 'other', is_active: 1 })
      ]
    })
    const res = await call('PATCH', '/2', { is_active: true })
    expect(res.statusCode).toBe(200)
    expect(rowOf(1).is_active).toBe(0)
    expect(rowOf(2).is_active).toBe(1)
    expect(rowOf(3).is_active).toBe(1)
    expect(rowOf(4).is_active).toBe(1)
  })

  it('activating a NULL-typed (grouped) layout turns off the grouped default', async () => {
    fake.reset({
      nivaro_collection_layouts: [
        layout({ id: 1, layout_type: null, is_active: 1 }),
        layout({ id: 2 })
      ]
    })
    const res = await call('POST', '/2/activate')
    expect(res.statusCode).toBe(200)
    expect(rowOf(1).is_active).toBe(0)
    expect(rowOf(2).is_active).toBe(1)
  })

  it('file layouts are excepted: several may be on', async () => {
    fake.reset({
      nivaro_collection_layouts: [
        layout({ id: 1, layout_type: 'file', is_active: 1 }),
        layout({ id: 2, layout_type: 'file' })
      ]
    })
    expect((await call('PATCH', '/2', { is_active: true })).statusCode).toBe(200)
    expect(rowOf(1).is_active).toBe(1)
    expect(rowOf(2).is_active).toBe(1)
  })

  it('changing an active layout to another type keeps one active per type', async () => {
    fake.reset({
      nivaro_collection_layouts: [
        layout({ id: 1, is_active: 1 }),
        layout({ id: 2, layout_type: 'detail', is_active: 1 })
      ]
    })
    expect((await call('PATCH', '/1', { layout_type: 'detail' })).statusCode).toBe(200)
    expect(rowOf(1).is_active).toBe(1)
    expect(rowOf(2).is_active).toBe(0)
  })
})

describe('POST /collection-layouts', () => {
  it('POST stores a slug', async () => {
    fake.reset({ nivaro_collection_layouts: [] })
    const first = await call('POST', '/', { collection: 'c', name: 'Unit Order' })
    expect(first.statusCode).toBe(201)
    expect(first.json().data.slug).toBe('unit_order')

    // Same slug base again (the name itself is UNIQUE per collection in the DB).
    const second = await call('POST', '/', { collection: 'c', name: 'Unit order' })
    expect(second.statusCode).toBe(201)
    expect(second.json().data.slug).toBe('unit_order_2')

    const third = await call('POST', '/', { collection: 'c', name: 'UNIT  ORDER!' })
    expect(third.json().data.slug).toBe('unit_order_3')

    // Another collection has its own slug space.
    const other = await call('POST', '/', { collection: 'd', name: 'Unit Order' })
    expect(other.json().data.slug).toBe('unit_order')
  })

  it('POST keeps an explicit slug, including the dash form older slugs use', async () => {
    fake.reset({ nivaro_collection_layouts: [layout({ id: 1, slug: 'pub-request' })] })
    const res = await call('POST', '/', { collection: 'c', name: 'Unit', slug: 'unit-form' })
    expect(res.json().data.slug).toBe('unit-form')
    const dup = await call('POST', '/', { collection: 'c', name: 'Pub', slug: 'pub-request' })
    expect(dup.json().data.slug).toBe('pub-request_2')
  })

  it('POST accepts a layout_type chosen up front and refuses unknown ones', async () => {
    fake.reset({ nivaro_collection_layouts: [] })
    const res = await call('POST', '/', { collection: 'c', name: 'Print', layout_type: 'file' })
    expect(res.statusCode).toBe(201)
    expect(res.json().data.layout_type).toBe('file')
    const bad = await call('POST', '/', { collection: 'c', name: 'X', layout_type: 'nope' })
    expect(bad.statusCode).toBe(400)
  })
})

describe('nextFreeSlug', () => {
  it('normalises the base and suffixes _2, _3 within the collection', async () => {
    fake.reset({
      nivaro_collection_layouts: [
        layout({ id: 1, slug: 'main' }),
        layout({ id: 2, slug: 'main_2' }),
        layout({ id: 3, collection: 'd', slug: 'main_3' })
      ]
    })
    expect(await nextFreeSlug('c', 'Main')).toBe('main_3')
    expect(await nextFreeSlug('c', 'Fresh Form')).toBe('fresh_form')
    expect(await nextFreeSlug('c', 'Ünit—Order')).toBe('unit_order')
    expect(await nextFreeSlug('c', '***')).toBe('layout')
  })
})

describe('POST /collection-layouts/:id/clone', () => {
  it('clone stores a fresh slug and carries parent_layout_id', async () => {
    fake.reset({
      nivaro_collection_layouts: [
        layout({ id: 1, slug: 'base', is_active: 1 }),
        layout({ id: 2, slug: 'main', parent_layout_id: 1, disable_clone: 1 })
      ],
      nivaro_field_groups: [{ id: 10, layout_id: 2, key: 'general', label: 'General', sort: 0 }],
      nivaro_layout_field_assignments: [
        { id: 20, layout_id: 2, field: 'name', group_key: 'general', sort: 0 }
      ]
    })
    const res = await call('POST', '/2/clone', { name: 'Main (copy)' })
    expect(res.statusCode).toBe(201)
    const created = res.json().data
    expect(created.slug).toBe('main_copy')
    expect(created.parent_layout_id).toBe(1)
    expect(created.disable_clone).toBe(1)
    expect(created.is_active).toBe(0)
    expect(
      fake.tables.nivaro_layout_field_assignments.filter((a) => a.layout_id === created.id)
    ).toHaveLength(1)

    // An explicit slug is honoured but kept unique.
    const again = await call('POST', '/2/clone', { name: 'Main again', slug: 'main' })
    expect(again.json().data.slug).toBe('main_2')
  })
})

describe('GET /collection-layouts', () => {
  it('list honours layout_type and returns parent_layout_id', async () => {
    fake.reset({
      nivaro_collection_layouts: [
        layout({ id: 1 }),
        layout({ id: 2, layout_type: null, parent_layout_id: 1 }),
        layout({ id: 3, layout_type: 'file' }),
        layout({ id: 4, layout_type: 'addendum' }),
        layout({ id: 5, collection: 'other' })
      ]
    })
    const grouped = await call('GET', '/?collection=c&layout_type=grouped')
    expect(grouped.statusCode).toBe(200)
    const rows = grouped.json().data as Row[]
    expect(rows.map((r) => r.id)).toEqual([1, 2])
    expect(rows[1].parent_layout_id).toBe(1)
    expect('parent_layout_id' in rows[0]).toBe(true)

    const addendum = await call('GET', '/?collection=c&layout_type=addendum')
    expect((addendum.json().data as Row[]).map((r) => r.id)).toEqual([4])

    const all = await call('GET', '/?collection=c')
    expect((all.json().data as Row[]).map((r) => r.id)).toEqual([1, 2, 3, 4])

    expect((await call('GET', '/?collection=c&layout_type=nope')).statusCode).toBe(400)
  })
})

describe('DELETE /collection-layouts/:id', () => {
  it('delete runs in one transaction and refuses with the references', async () => {
    fake.reset({
      nivaro_collection_layouts: [
        layout({ id: 1, addendum_layout_id: 2, name: 'Unit form' }),
        layout({ id: 2, layout_type: 'addendum', name: 'Unit addendum' }),
        layout({ id: 3, parent_layout_id: 2, name: 'Child' })
      ],
      nivaro_field_groups: [{ id: 10, layout_id: 2, key: 'g', sort: 0 }],
      nivaro_layout_field_assignments: [
        { id: 20, layout_id: 2, field: 'name', group_key: 'g', sort: 0 }
      ],
      nivaro_addendums: [
        {
          id: 'add-1',
          addendum_layout_id: 2,
          title: 'Scope change',
          parent_collection: 'c',
          parent_id: '5'
        }
      ]
    })
    const res = await call('DELETE', '/2')
    expect(res.statusCode).toBe(409)
    const body = res.json()
    expect(typeof body.error).toBe('string')
    expect(body.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'layout_addendum', id: 1, label: 'Unit form' }),
        expect.objectContaining({ kind: 'layout_parent', id: 3, label: 'Child' }),
        expect.objectContaining({ kind: 'addendum', id: 'add-1', label: 'Scope change' })
      ])
    )
    expect(rowOf(2)).toBeDefined()
    expect(fake.tables.nivaro_field_groups).toHaveLength(1)
    expect(fake.tables.nivaro_layout_field_assignments).toHaveLength(1)
  })

  it('deletes groups, assignments and the layout together and keeps version history', async () => {
    fake.reset({
      nivaro_collection_layouts: [
        layout({ id: 1, is_active: 1 }),
        layout({ id: 2, layout_type: null, sort: 5 })
      ],
      nivaro_field_groups: [{ id: 10, layout_id: 1, key: 'g', sort: 0 }],
      nivaro_layout_field_assignments: [
        { id: 20, layout_id: 1, field: 'name', group_key: 'g', sort: 0 }
      ],
      nivaro_addendums: [],
      nivaro_layout_versions: [{ id: 30, layout_id: 1, version: 1, snapshot: '{}' }]
    })
    const res = await call('DELETE', '/1')
    expect(res.statusCode).toBe(204)
    expect(fake.transactions.count).toBe(1)
    expect(rowOf(1)).toBeUndefined()
    expect(rowOf(2).is_active).toBe(1) // the NULL-typed grouped layout is promoted
    expect(fake.tables.nivaro_field_groups).toHaveLength(0)
    expect(fake.tables.nivaro_layout_field_assignments).toHaveLength(0)
    expect(fake.tables.nivaro_layout_versions).toHaveLength(1)
  })
})

describe('restoreLayoutVersion', () => {
  it('restore unhooks kept groups from a later container before removing it', async () => {
    fake.reset({
      nivaro_collection_layouts: [layout({ id: 1, is_active: 1 })],
      nivaro_field_groups: [
        { id: 10, layout_id: 1, key: 'general', container_id: null, sort: 0 },
        { id: 12, layout_id: 1, key: 'costs', container_id: null, sort: 1 }
      ],
      nivaro_layout_field_assignments: [],
      nivaro_layout_versions: []
    })
    await snapshotLayoutVersion(1, 'v1', 'u')
    const version = fake.tables.nivaro_layout_versions[0]

    // After the version: a tab container (11) and both sections moved into it.
    fake.tables.nivaro_field_groups.push({
      id: 11,
      layout_id: 1,
      key: 'tabs',
      type: 'tabs',
      container_id: null,
      sort: 2
    })
    for (const g of fake.tables.nivaro_field_groups) if (g.id !== 11) g.container_id = 11

    await expect(restoreLayoutVersion(1, Number(version.id), 'u')).resolves.toEqual({
      restored_assignments: 0,
      restored_groups: 2
    })
    const groups = fake.tables.nivaro_field_groups.filter((g) => g.layout_id === 1)
    expect(groups.map((g) => [g.id, g.container_id])).toEqual([
      [10, null],
      [12, null]
    ])
  })

  it('restore brings back a removed container with its tabs nested under the new id', async () => {
    fake.reset({
      nivaro_collection_layouts: [layout({ id: 1, is_active: 1 })],
      nivaro_field_groups: [
        { id: 11, layout_id: 1, key: 'tabs', type: 'container', container_id: null, sort: 0 },
        { id: 12, layout_id: 1, key: 't1', type: 'tab', container_id: 11, sort: 0 },
        { id: 13, layout_id: 1, key: 't2', type: 'tab', container_id: 11, sort: 1 }
      ],
      nivaro_layout_field_assignments: [],
      nivaro_layout_versions: []
    })
    await snapshotLayoutVersion(1, 'v1', 'u')
    const version = fake.tables.nivaro_layout_versions[0]

    // After the version: the container was removed (its tabs unhooked) and
    // one tab removed too.
    for (const g of fake.tables.nivaro_field_groups) g.container_id = null
    fake.tables.nivaro_field_groups = fake.tables.nivaro_field_groups.filter((g) => g.id === 12)

    await expect(restoreLayoutVersion(1, Number(version.id), 'u')).resolves.toEqual({
      restored_assignments: 0,
      restored_groups: 3
    })
    const groups = fake.tables.nivaro_field_groups.filter((g) => g.layout_id === 1)
    const tabs = groups.find((g) => g.key === 'tabs')
    expect(tabs?.id).not.toBe(11)
    expect(groups.find((g) => g.key === 't1')?.container_id).toBe(tabs?.id)
    expect(groups.find((g) => g.key === 't2')?.container_id).toBe(tabs?.id)
  })

  it('restore removes groups added after the version', async () => {
    fake.reset({
      nivaro_collection_layouts: [layout({ id: 1, is_active: 1 }), layout({ id: 2 })],
      nivaro_field_groups: [{ id: 10, layout_id: 1, key: 'general', label: 'General', sort: 0 }],
      nivaro_layout_field_assignments: [
        { id: 20, layout_id: 1, field: 'name', group_key: 'general', sort: 0 }
      ],
      nivaro_layout_versions: []
    })
    await snapshotLayoutVersion(1, 'v1', 'u')
    const version = fake.tables.nivaro_layout_versions[0]

    // After the version: a new group with a field, a renamed group, and
    // another layout made the default.
    fake.tables.nivaro_field_groups.push({ id: 11, layout_id: 1, key: 'extra', sort: 1 })
    fake.tables.nivaro_layout_field_assignments.push({
      id: 21,
      layout_id: 1,
      field: 'notes',
      group_key: 'extra',
      sort: 1
    })
    fake.tables.nivaro_field_groups[0].label = 'Renamed'
    rowOf(1).is_active = 0
    rowOf(2).is_active = 1

    const result = await restoreLayoutVersion(1, Number(version.id), 'u')
    expect(result).toEqual({ restored_assignments: 1, restored_groups: 1 })

    const groups = fake.tables.nivaro_field_groups.filter((g) => g.layout_id === 1)
    expect(groups.map((g) => g.id)).toEqual([10])
    expect(groups[0].label).toBe('General')
    const assignments = fake.tables.nivaro_layout_field_assignments.filter((a) => a.layout_id === 1)
    expect(assignments.map((a) => a.field)).toEqual(['name'])

    // is_active comes back through the activate rule: never two grouped defaults.
    expect(rowOf(1).is_active).toBe(1)
    expect(rowOf(2).is_active).toBe(0)
  })
})
