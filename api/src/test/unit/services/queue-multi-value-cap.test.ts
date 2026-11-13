import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeQuery } from '../../fake-sql.js'

// Production 2026-11-13 ("Server freezes"): the Unit Types list showed its Units and
// Inventory Requests columns (O2M) and resolve-paths read EVERY child row of the page —
// 230,336 units over 101 unit types — into the web process, which froze for up to 61 s
// at a time. A multi-value cell shows 3 values and "+N more", so the read keeps at most
// MULTI_VALUE_ROW_CAP children per parent in SQL and takes the total from COUNT(*) OVER.
const h = vi.hoisted(() => ({
  seen: [] as FakeQuery[],
  answer: (_q: FakeQuery): unknown => []
}))
vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  return {
    db: makeFakeDb((q) => {
      h.seen.push(q)
      return h.answer(q)
    })
  }
})
vi.mock('../../../services/collections.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/collections.js')>()),
  getCollection: vi.fn(async () => undefined),
  getRelations: vi.fn(async () => []),
  getPhysicalColumns: vi.fn(async () => null)
}))

import {
  MULTI_VALUE_ROW_CAP,
  newPathReadBatch,
  resolvePathValues
} from '../../../services/queues.js'
import type { CMSRelation } from '../../../types.js'

const RELATIONS = [
  {
    many_collection: 'units',
    many_field: 'unit_type',
    one_collection: 'deployment_part_types',
    one_field: 'units'
  },
  {
    many_collection: 'dpt_project_types',
    many_field: 'deployment_part_types_id',
    one_collection: 'deployment_part_types',
    one_field: 'project_types',
    junction_field: 'project_types_id'
  },
  {
    many_collection: 'dpt_project_types',
    many_field: 'project_types_id',
    one_collection: 'project_types',
    junction_field: 'deployment_part_types_id'
  }
].map((r, i) => ({ id: i + 1, one_field: null, junction_field: null, ...r })) as CMSRelation[]
const relCache = () => new Map<string, CMSRelation[]>([['deployment_part_types', RELATIONS]])

const readsOf = (table: string) => h.seen.filter((q) => q.sql.includes(`from [${table}]`))

/** Every read of `table` keeps at most the cap per parent, in SQL. */
function expectCapped(table: string, partition: string) {
  const reads = readsOf(table)
  expect(reads.length, `no read of ${table}`).toBeGreaterThan(0)
  for (const q of reads) {
    expect(q.sql).toContain(`ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY`)
    expect(q.sql).toContain(`COUNT(*) OVER (PARTITION BY ${partition})`)
    expect(q.sql).toMatch(/\[__rn\] <= @p\d+/)
    expect(q.bindings).toContain(MULTI_VALUE_ROW_CAP)
  }
}

/** `n` child rows of parent `pid` out of `total`, as the capped read returns them. */
const children = (
  pid: string,
  n: number,
  total: number,
  extra: (i: number) => object = () => ({})
) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${pid}-${i + 1}`,
    unit_type: pid,
    name: `Unit ${pid}-${i + 1}`,
    __rn: i + 1,
    __total: total,
    ...extra(i)
  }))

beforeEach(() => {
  h.seen.length = 0
  h.answer = () => []
})

describe('multi-value path columns read a capped set of children per row', () => {
  it('an O2M leaf column reads at most the cap per parent and counts the rest', async () => {
    h.answer = (q) =>
      q.sql.includes('from [units]')
        ? [...children('1', MULTI_VALUE_ROW_CAP, 2341), ...children('2', 2, 2)]
        : []
    const out = await resolvePathValues('deployment_part_types', ['1', '2'], ['units'], relCache())
    expectCapped('units', '[unit_type]')
    expect(out.get('1')?.value).toBe('Unit 1-1, Unit 1-2, Unit 1-3 +2338 more')
    expect(out.get('1')?.ids).toHaveLength(50)
    expect(out.get('2')?.value).toBe('Unit 2-1, Unit 2-2')
  })

  it('an O2M hop into a plain column (units.name) reads it in the same capped read', async () => {
    h.answer = (q) =>
      q.sql.includes('from [units]') ? [...children('1', MULTI_VALUE_ROW_CAP, 2341)] : []
    for (const batch of [undefined, newPathReadBatch()]) {
      h.seen.length = 0
      const out = await resolvePathValues(
        'deployment_part_types',
        ['1'],
        ['units', 'name'],
        relCache(),
        batch
      )
      expectCapped('units', '[unit_type]')
      // No other read of the child table: never every unit of the page by id or by parent.
      expect(readsOf('units')).toHaveLength(1)
      expect(out.get('1')?.value).toBe('Unit 1-1, Unit 1-2, Unit 1-3 +2338 more')
      expect(out.get('1')?.ids).toHaveLength(50)
    }
  })

  it('a parent under the cap lists distinct values exactly as before', async () => {
    h.answer = (q) =>
      q.sql.includes('from [units]')
        ? children('1', 4, 4, (i) => ({ name: i < 2 ? 'Same' : `Other ${i}` }))
        : []
    const out = await resolvePathValues(
      'deployment_part_types',
      ['1'],
      ['units', 'name'],
      relCache()
    )
    expect(out.get('1')?.value).toBe('Same, Other 2, Other 3')
  })

  it('an M2M column reads at most the cap per parent through the junction', async () => {
    h.answer = (q) =>
      q.sql.includes('from [dpt_project_types]')
        ? Array.from({ length: 5 }, (_, i) => ({
            __parent_id: '1',
            __rel_id: `p${i}`,
            id: `p${i}`,
            name: `Type ${i}`,
            __rn: i + 1,
            __total: 120
          }))
        : []
    const out = await resolvePathValues(
      'deployment_part_types',
      ['1'],
      ['project_types'],
      relCache()
    )
    expectCapped('dpt_project_types', '[_j].[deployment_part_types_id]')
    expect(out.get('1')?.value).toBe('Type 0, Type 1, Type 2 +117 more')
  })
})
