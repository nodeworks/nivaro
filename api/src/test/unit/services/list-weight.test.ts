import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeQuery } from '../../fake-sql.js'

// Production 2026-11-13: the Unit Types list opened on its Units column (230,336 units over
// 101 unit types) and froze web processes. The list-weight read measures each O2M / M2M
// field and says whether the list's default columns show a heavy one.
const h = vi.hoisted(() => ({
  seen: [] as FakeQuery[],
  views: [] as Array<Record<string, unknown>>,
  roles: [] as Array<Record<string, unknown>>,
  fields: [] as Array<Record<string, unknown>>,
  relations: [] as unknown[]
}))
vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  const fake = makeFakeDb((q) => {
    h.seen.push(q)
    if (q.sql.includes('nivaro_saved_views')) return h.views
    if (q.sql.includes('nivaro_roles')) return h.roles
    if (q.sql.includes('nivaro_fields')) return h.fields
    return []
  })
  return { db: fake, resolveDb: () => fake }
})
vi.mock('../../../services/collections.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/collections.js')>()),
  getFields: vi.fn(async (c: string) => h.fields.filter((f) => f.collection === c)),
  getRelations: vi.fn(async () => h.relations)
}))

import { StatementCancelled } from '../../../services/bounded-sql.js'
import {
  BASELINE_COLUMN_COUNT,
  buildReport,
  defaultColumnSets,
  getHeavyListFlags,
  getListWeight,
  HEAVY_AVG_CHILDREN,
  HEAVY_MAX_CHILDREN,
  isHeavy,
  type Measure,
  manyFieldsOf,
  measureFromRow,
  measureRelation,
  measureSql,
  resetListWeightCache,
  type StatementRunner
} from '../../../services/list-weight.js'
import type { CMSRelation } from '../../../types.js'

const rel = (r: Partial<CMSRelation>): CMSRelation =>
  ({
    id: 1,
    many_collection: '',
    many_field: '',
    one_collection: null,
    one_field: null,
    one_collection_field: null,
    one_allowed_collections: null,
    junction_field: null,
    sort_field: null,
    one_deselect_action: 'nullify',
    ...r
  }) as CMSRelation

// Unit types: Units (O2M), Inventory requests (O2M), Tags (M2M through a junction).
const RELATIONS = [
  rel({
    many_collection: 'units',
    many_field: 'unit_type',
    one_collection: 'unit_types',
    one_field: 'units'
  }),
  rel({
    many_collection: 'inventory_requests',
    many_field: 'unit_type',
    one_collection: 'unit_types',
    one_field: 'inventory_requests'
  }),
  rel({
    many_collection: 'unit_types_tags',
    many_field: 'unit_types_id',
    one_collection: 'unit_types',
    one_field: 'tags',
    junction_field: 'tags_id'
  }),
  rel({
    many_collection: 'unit_types_tags',
    many_field: 'tags_id',
    one_collection: 'tags',
    junction_field: 'unit_types_id'
  }),
  // A claim for a field the collection does not have: never a column.
  rel({
    many_collection: 'ghosts',
    many_field: 'unit_type',
    one_collection: 'unit_types',
    one_field: 'ghosts'
  }),
  // M2O out of unit_types: not a many field.
  rel({ many_collection: 'unit_types', many_field: 'category', one_collection: 'categories' })
]

const FIELDS = [
  { collection: 'unit_types', field: 'id', hidden: false },
  { collection: 'unit_types', field: 'name', hidden: false },
  { collection: 'unit_types', field: 'secret', hidden: true },
  { collection: 'unit_types', field: 'category', hidden: false },
  { collection: 'unit_types', field: 'units', hidden: false },
  { collection: 'unit_types', field: 'inventory_requests', hidden: false },
  { collection: 'unit_types', field: 'tags', hidden: false },
  { collection: 'unit_types', field: 'code', hidden: false },
  { collection: 'unit_types', field: 'notes', hidden: false }
]

const ok = (avg: number, max: number): Measure => ({
  status: 'ok',
  parent_rows: 101,
  parents_with_links: 101,
  links: Math.round(avg * 101),
  max,
  avg,
  measured_at: '2026-11-13T00:00:00.000Z'
})

beforeEach(() => {
  resetListWeightCache()
  h.seen = []
  h.views = []
  h.roles = []
  h.fields = FIELDS
  h.relations = RELATIONS
})

describe('manyFieldsOf', () => {
  it('lists O2M and M2M alias fields the collection has, with what they list', () => {
    const many = manyFieldsOf('unit_types', FIELDS, RELATIONS)
    expect(
      many.map((f) => [f.field, f.kind, f.child_collection, f.child_field, f.related_collection])
    ).toEqual([
      ['units', 'o2m', 'units', 'unit_type', 'units'],
      ['inventory_requests', 'o2m', 'inventory_requests', 'unit_type', 'inventory_requests'],
      ['tags', 'm2m', 'unit_types_tags', 'unit_types_id', 'tags']
    ])
    expect(many[0].label).toBe('Units')
  })
})

describe('isHeavy', () => {
  it('is heavy above the average or the single-record threshold, never on a failed read', () => {
    expect(isHeavy(ok(HEAVY_AVG_CHILDREN, HEAVY_MAX_CHILDREN))).toBe(false)
    expect(isHeavy(ok(HEAVY_AVG_CHILDREN + 0.1, 1))).toBe(true)
    expect(isHeavy(ok(1, HEAVY_MAX_CHILDREN + 1))).toBe(true)
    expect(isHeavy({ ...ok(5000, 5000), status: 'timeout' })).toBe(false)
    expect(isHeavy(null)).toBe(false)
  })
})

describe('measureFromRow', () => {
  it('averages links over every record of the collection, not only the linked ones', () => {
    const m = measureFromRow({
      parents_with_links: '90',
      links: '230336',
      max_children: '2341',
      parent_rows: '101'
    })
    expect(m).toMatchObject({
      status: 'ok',
      parent_rows: 101,
      links: 230336,
      max: 2341,
      avg: 2280.6
    })
    expect(measureFromRow(undefined)).toMatchObject({ avg: 0, max: 0 })
  })
})

describe('defaultColumnSets', () => {
  const heavy = new Set(['units', 'inventory_requests'])

  it('without a default view, the list opens on the first 7 visible fields', () => {
    const [d] = defaultColumnSets(FIELDS, [], new Map(), heavy)
    expect(d.source).toBe('baseline')
    expect(d.columns).toHaveLength(BASELINE_COLUMN_COUNT)
    expect(d.columns).toEqual([
      'id',
      'name',
      'category',
      'units',
      'inventory_requests',
      'tags',
      'code'
    ])
    expect(d.heavy).toEqual(['units', 'inventory_requests'])
    expect(d.suggested_columns).toEqual(['id', 'name', 'category', 'tags', 'code'])
  })

  it("a default view's columns win; the suggestion keeps its stored entries (labels, pins)", () => {
    const view = {
      id: 48,
      collection: 'unit_types',
      name: 'Default',
      is_default: true,
      default_for_role: null,
      columns: [
        { key: 'name', pin: 'left' as const },
        'units',
        'gone',
        { key: '__actions__', pin: 'right' as const }
      ]
    }
    const [d] = defaultColumnSets(FIELDS, [view], new Map(), heavy)
    expect(d).toMatchObject({
      source: 'collection_view',
      view_id: 48,
      columns: ['name', 'units'],
      heavy: ['units']
    })
    expect(d.suggested_columns).toEqual([
      { key: 'name', pin: 'left' },
      'gone',
      { key: '__actions__', pin: 'right' }
    ])
  })

  it('a default view whose columns are all gone keeps the baseline', () => {
    const view = {
      id: 2,
      collection: 'unit_types',
      name: 'D',
      is_default: true,
      default_for_role: null,
      columns: ['gone']
    }
    expect(defaultColumnSets(FIELDS, [view], new Map(), heavy)[0].source).toBe('baseline')
  })

  it('when every default column is heavy, the suggestion opens on the first light fields', () => {
    const view = {
      id: 3,
      collection: 'unit_types',
      name: 'D',
      is_default: true,
      default_for_role: null,
      columns: ['units']
    }
    const [d] = defaultColumnSets(FIELDS, [view], new Map(), heavy)
    expect(d.suggested_columns).toEqual(['id', 'name', 'category', 'tags', 'code', 'notes'])
  })

  it('role default views are their own sets, named by role', () => {
    const view = {
      id: 7,
      collection: 'unit_types',
      name: 'Ops',
      is_default: false,
      default_for_role: 'abc',
      columns: ['name', 'inventory_requests']
    }
    const sets = defaultColumnSets(FIELDS, [view], new Map([['ABC', 'Operations']]), heavy)
    expect(sets).toHaveLength(2)
    expect(sets[1]).toMatchObject({
      source: 'role_view',
      role_name: 'Operations',
      heavy: ['inventory_requests']
    })
  })
})

describe('buildReport', () => {
  it('marks heavy fields, where they show, and the union for the warning', () => {
    const many = manyFieldsOf('unit_types', FIELDS, RELATIONS)
    const measures = new Map<string, Measure | null>([
      ['units', ok(2280, 2341)],
      ['inventory_requests', ok(3, 12)],
      ['tags', ok(2, 4)]
    ])
    const r = buildReport('unit_types', many, measures, FIELDS, [], new Map())
    expect(r.heavy_in_default).toEqual(['units'])
    expect(r.fields.find((f) => f.field === 'units')).toMatchObject({
      heavy: true,
      in_default: true
    })
    expect(r.fields.find((f) => f.field === 'inventory_requests')).toMatchObject({ heavy: false })
    expect(r.partial).toBe(false)
    expect(r.thresholds).toEqual({
      avg_children: HEAVY_AVG_CHILDREN,
      max_children: HEAVY_MAX_CHILDREN
    })
  })
})

describe('measureRelation', () => {
  const units = manyFieldsOf('unit_types', FIELDS, RELATIONS)[0]

  it('runs one GROUP BY over the child table with a deadline, and caches the answer', async () => {
    const run = vi.fn<StatementRunner>(async () => [
      { parents_with_links: 101, links: 230336, max_children: 2341, parent_rows: 101 }
    ])
    const m = await measureRelation('unit_types', units, run, true)
    expect(m).toMatchObject({ status: 'ok', max: 2341 })
    const [sql, bindings, timeout] = run.mock.calls[0]
    expect(sql).toBe(measureSql(true))
    expect(sql).toContain('GROUP BY')
    expect(sql).toContain('WITH (NOLOCK)')
    expect(bindings).toEqual(['unit_types', 'unit_type', 'units', 'unit_type', 'unit_type'])
    expect(timeout).toBeGreaterThan(0)
    await measureRelation('unit_types', units, run, true)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('a statement past its deadline is a timeout, not heavy, and is not cached', async () => {
    const run = vi.fn<StatementRunner>(async () => {
      throw new StatementCancelled('timeout')
    })
    expect((await measureRelation('unit_types', units, run, true)).status).toBe('timeout')
    await measureRelation('unit_types', units, run, true)
    expect(run).toHaveBeenCalledTimes(2)
  })
})

describe('getListWeight / getHeavyListFlags', () => {
  const run: StatementRunner = async (_sql, bindings) => {
    const child = bindings[2]
    if (child === 'units')
      return [{ parents_with_links: 101, links: 230336, max_children: 2341, parent_rows: 101 }]
    if (child === 'inventory_requests')
      return [{ parents_with_links: 50, links: 30000, max_children: 900, parent_rows: 101 }]
    return [{ parents_with_links: 10, links: 20, max_children: 3, parent_rows: 101 }]
  }

  it('reports heavy columns in the baseline defaults with a suggestion without them', async () => {
    const r = await getListWeight('unit_types', 'admin', { run, mssql: true })
    expect(r.heavy_in_default).toEqual(['units', 'inventory_requests'])
    expect(r.defaults[0]).toMatchObject({
      source: 'baseline',
      suggested_columns: ['id', 'name', 'category', 'tags', 'code']
    })
    expect(r.fields.find((f) => f.field === 'units')?.measure?.max).toBe(2341)
  })

  it('a default view without them clears the warning', async () => {
    h.views = [
      {
        id: 48,
        collection: 'unit_types',
        name: 'Default',
        is_default: true,
        default_for_role: null,
        columns: JSON.stringify(['name', 'code'])
      }
    ]
    const r = await getListWeight('unit_types', 'admin', { run, mssql: true })
    expect(r.heavy_in_default).toEqual([])
    expect(r.fields.find((f) => f.field === 'units')).toMatchObject({
      heavy: true,
      in_default: false
    })
  })

  it('the directory sweep flags only collections whose list opens on a heavy column', async () => {
    const res = await getHeavyListFlags('admin', { run, mssql: true })
    expect(Object.keys(res.data)).toEqual(['unit_types'])
    expect(res.data.unit_types.fields.map((f) => [f.field, f.max])).toEqual([
      ['units', 2341],
      ['inventory_requests', 900]
    ])
    expect(res.partial).toBe(false)
  })

  it('the sweep answers partial when its budget is spent', async () => {
    const res = await getHeavyListFlags('admin', { run, mssql: true, budgetMs: -1 })
    expect(res.partial).toBe(true)
    expect(res.data).toEqual({})
  })
})
