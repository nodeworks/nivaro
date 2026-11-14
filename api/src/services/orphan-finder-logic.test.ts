import knexFactory from 'knex'
import { describe, expect, it } from 'vitest'
import {
  actionRefusal,
  buildOrphanChecks,
  type ColumnFact,
  compareMode,
  countSql,
  type FieldFact,
  planHash,
  type RelationFact,
  type SchemaFacts,
  sampleSql
} from './orphan-finder-logic.js'

function facts(
  tables: Record<string, Record<string, [string, boolean?]>>,
  extra: Partial<SchemaFacts> = {}
): SchemaFacts {
  const t = new Map<string, Map<string, ColumnFact>>()
  const pk = new Map<string, string>()
  for (const [name, cols] of Object.entries(tables)) {
    t.set(
      name,
      new Map(
        Object.entries(cols).map(([c, [type, nullable]]) => [c, { type, nullable: !!nullable }])
      )
    )
    if (cols.id) pk.set(name, 'id')
  }
  return {
    tables: t,
    pk,
    enforced: new Set(),
    referencedBy: new Map(),
    mssql: true,
    ...extra
  }
}

const rel = (r: Partial<RelationFact>): RelationFact => ({
  many_collection: null,
  many_field: null,
  one_collection: null,
  one_field: null,
  junction_field: null,
  ...r
})

const SCHEMA = facts({
  orders: {
    id: ['int'],
    customer: ['int', true],
    legacy_ref: ['nvarchar', true],
    doc: ['uniqueidentifier', true]
  },
  customers: { id: ['int'] },
  order_lines: { id: ['int'], order_id: ['int'] },
  orders_tags: { id: ['int'], orders_id: ['int', true], tags_id: ['int', true] },
  tags: { id: ['int'] },
  nivaro_files: { id: ['uniqueidentifier'] },
  nivaro_users: { id: ['uniqueidentifier'] },
  nivaro_activity: { id: ['int'], user: ['uniqueidentifier'] }
})

describe('buildOrphanChecks', () => {
  it('builds one check per real link column and names what it skipped', () => {
    const { checks, skipped } = buildOrphanChecks(
      [
        rel({ many_collection: 'orders', many_field: 'customer', one_collection: 'customers' }),
        rel({
          many_collection: 'order_lines',
          many_field: 'order_id',
          one_collection: 'orders',
          one_field: 'lines'
        }),
        rel({
          many_collection: 'orders_tags',
          many_field: 'tags_id',
          one_collection: 'tags',
          junction_field: 'orders_id'
        }),
        rel({
          many_collection: 'orders_tags',
          many_field: 'orders_id',
          one_collection: 'orders',
          junction_field: 'tags_id'
        }),
        // a claim naming a table that was never created
        rel({ many_collection: 'ghost', many_field: 'x', one_collection: 'customers' }),
        // directus_files was dropped: read as nivaro_files
        rel({ many_collection: 'orders', many_field: 'doc', one_collection: 'directus_files' }),
        // system child tables keep their own integrity
        rel({
          many_collection: 'nivaro_activity',
          many_field: 'user',
          one_collection: 'nivaro_users'
        }),
        // many-to-any
        rel({ many_collection: 'orders', many_field: 'anything' })
      ],
      [],
      SCHEMA
    )
    const byKey = Object.fromEntries(checks.map((c) => [c.key, c]))
    expect(Object.keys(byKey).sort()).toEqual([
      'order_lines.order_id>orders',
      'orders.customer>customers',
      'orders.doc>nivaro_files',
      'orders_tags.orders_id>orders',
      'orders_tags.tags_id>tags'
    ])
    expect(byKey['orders.customer>customers'].kind).toBe('m2o')
    expect(byKey['order_lines.order_id>orders'].kind).toBe('o2m')
    expect(byKey['orders_tags.tags_id>tags'].kind).toBe('junction')
    expect(byKey['orders_tags.tags_id>tags'].other_leg).toBe('orders_id')
    expect(byKey['orders.doc>nivaro_files'].kind).toBe('file')
    expect(skipped.map((s) => s.reason)).toEqual(
      expect.arrayContaining([
        'Table ghost does not exist',
        'Links to any of several tables (many-to-any) are not checked'
      ])
    )
    expect(skipped.some((s) => s.label.startsWith('nivaro_activity'))).toBe(false)
  })

  it('adds file fields with no relation row and honours db_column', () => {
    const fields: FieldFact[] = [
      {
        collection: 'orders',
        field: 'Attachment',
        interface: 'file',
        special: null,
        db_column: 'doc'
      },
      {
        collection: 'orders',
        field: 'customer',
        interface: 'select-dropdown-m2o',
        special: 'm2o',
        db_column: null
      }
    ]
    const { checks } = buildOrphanChecks([], fields, SCHEMA)
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({
      kind: 'file',
      child: 'orders',
      fk: 'doc',
      field: 'Attachment',
      parent: 'nivaro_files'
    })
  })

  it('marks database-enforced links and tables other tables point into', () => {
    const f = facts(
      {
        a: { id: ['int'], b_id: ['int', true] },
        b: { id: ['int'] },
        c: { id: ['int'], a_id: ['int'] }
      },
      { enforced: new Set(['a.b_id']), referencedBy: new Map([['a', ['c.a_id']]]) }
    )
    const { checks } = buildOrphanChecks(
      [rel({ many_collection: 'a', many_field: 'b_id', one_collection: 'b', junction_field: 'x' })],
      [],
      f
    )
    expect(checks[0].enforced).toBe(true)
    expect(checks[0].referenced_by).toEqual(['c.a_id'])
    expect(actionRefusal(checks[0], 'delete')).toMatch(/Other tables point at these rows/)
  })

  it('skips links whose types cannot be compared without casting the parent key', () => {
    const f = facts({ a: { id: ['int'], ref: ['int', true] }, b: { id: ['nvarchar'] } })
    const { checks, skipped } = buildOrphanChecks(
      [rel({ many_collection: 'a', many_field: 'ref', one_collection: 'b' })],
      [],
      f
    )
    expect(checks).toHaveLength(0)
    expect(skipped[0].reason).toMatch(/cannot be compared/)
  })
})

describe('compareMode', () => {
  it('casts only the child side, and only on SQL Server', () => {
    expect(compareMode('int', 'bigint', false)).toBe('plain')
    expect(compareMode('nvarchar', 'int', true)).toBe('cast_bigint')
    expect(compareMode('varchar', 'uniqueidentifier', true)).toBe('cast_guid')
    expect(compareMode('nvarchar', 'int', false)).toBeNull()
    expect(compareMode('int', 'nvarchar', true)).toBeNull()
    expect(compareMode('datetime', 'int', true)).toBeNull()
  })
})

describe('SQL', () => {
  const knex = knexFactory({ client: 'mssql' })
  const [check] = buildOrphanChecks(
    [rel({ many_collection: 'orders', many_field: 'legacy_ref', one_collection: 'customers' })],
    [],
    SCHEMA
  ).checks

  it('counts set-based with NOT EXISTS, ignores empty text links and casts the child side', () => {
    const q = countSql(check)
    const sql = knex.raw(q.sql, q.bindings).toQuery()
    expect(sql).toBe(
      "SELECT COUNT(*) AS n FROM [orders] c WHERE c.[legacy_ref] IS NOT NULL AND c.[legacy_ref] <> '' AND NOT EXISTS (SELECT 1 FROM [customers] p WHERE p.[id] = TRY_CAST(c.[legacy_ref] AS BIGINT))"
    )
  })

  it('samples the newest rows, capped', () => {
    const q = sampleSql(check, 10_000, true)
    const sql = knex.raw(q.sql, q.bindings).toQuery()
    expect(sql).toMatch(
      /^SELECT TOP 500 c\.\[id\] AS row_id, c\.\[legacy_ref\] AS fk_value FROM \[orders\] c WHERE/
    )
    expect(sql).toMatch(/ORDER BY c\.\[id\] DESC$/)
  })
})

describe('actions', () => {
  const { checks } = buildOrphanChecks(
    [
      rel({ many_collection: 'order_lines', many_field: 'order_id', one_collection: 'orders' }),
      rel({ many_collection: 'orders', many_field: 'customer', one_collection: 'customers' }),
      rel({
        many_collection: 'orders_tags',
        many_field: 'tags_id',
        one_collection: 'tags',
        junction_field: 'orders_id'
      })
    ],
    [],
    SCHEMA
  )
  const by = (k: string) => checks.find((c) => c.key === k)!

  it('clears only nullable non-junction links and deletes only junction rows', () => {
    expect(actionRefusal(by('orders.customer>customers'), 'clear')).toBeNull()
    expect(actionRefusal(by('order_lines.order_id>orders'), 'clear')).toMatch(/cannot be empty/)
    expect(actionRefusal(by('orders.customer>customers'), 'delete')).toMatch(/Only link-table/)
    expect(actionRefusal(by('orders_tags.tags_id>tags'), 'delete')).toBeNull()
    expect(actionRefusal(by('orders_tags.tags_id>tags'), 'clear')).toMatch(/removed, not cleared/)
  })

  it('binds a plan to its exact rows, in any order', () => {
    const a = planHash('k', 'clear', ['3', '1', '2'])
    expect(planHash('k', 'clear', ['1', '2', '3'])).toBe(a)
    expect(planHash('k', 'clear', ['1', '2'])).not.toBe(a)
    expect(planHash('k', 'delete', ['1', '2', '3'])).not.toBe(a)
  })
})
