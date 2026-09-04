import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import {
  bustRollupContributorCache,
  getRollupContributors,
  type RollupContributorEntry,
  recalcAffectedRollups,
  recalcRollupsForParent
} from '../../../services/rollups.js'

function fieldsChain(rows: unknown[]) {
  return {
    where: vi.fn().mockReturnThis(),
    whereNotNull: vi.fn().mockReturnThis(),
    select: vi.fn().mockResolvedValue(rows)
  }
}

function throwingFieldsChain() {
  return {
    where: vi.fn().mockReturnThis(),
    whereNotNull: vi.fn().mockReturnThis(),
    select: vi.fn().mockRejectedValue(new Error('no such column: computed_store'))
  }
}

// Chain for the aggregate query against a related (child) collection —
// covers .count()/.sum()/.avg()/.min()/.max() then .first().
function aggregateChain(value: number | null) {
  return {
    where: vi.fn().mockReturnThis(),
    // The filter hook (#rollup source filter) runs through .modify — the chain
    // must honor it or the whole aggregate falls into the null catch.
    modify: vi.fn(function (this: unknown, cb: (q: unknown) => void) {
      cb(this)
      return this
    }),
    count: vi.fn().mockReturnThis(),
    sum: vi.fn().mockReturnThis(),
    avg: vi.fn().mockReturnThis(),
    min: vi.fn().mockReturnThis(),
    max: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue({ v: value })
  }
}

// Chain for the parent-row read + raw update. Captures every `where` id arg
// passed in, so tests can assert which parent ids were touched.
function parentChain(
  currentValue: number | null,
  rollupField: string,
  update: ReturnType<typeof vi.fn>,
  whereIds: unknown[]
) {
  const chain = {
    where: vi.fn((cond: Record<string, unknown>) => {
      whereIds.push(cond.id)
      return chain
    }),
    select: vi.fn().mockReturnThis(),
    first: vi
      .fn()
      .mockResolvedValue(currentValue == null ? undefined : { [rollupField]: currentValue }),
    update
  }
  return chain
}

function rollupSource(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    related_collection: 'unit_workflows',
    fk_field: 'unit',
    aggregate: 'sum' as const,
    value_field: 'allocated_amount',
    ...overrides
  }
}

afterEach(() => {
  vi.clearAllMocks()
  bustRollupContributorCache()
})

describe('getRollupContributors', () => {
  it('derives one entry per source matching the child collection, across multiple parent fields', async () => {
    const rows = [
      {
        collection: 'units',
        field: 'total_cost',
        computed_type: 'rollup',
        computed_store: 1,
        computed_formula: JSON.stringify({
          sources: [
            rollupSource(),
            {
              related_collection: 'unit_materials',
              fk_field: 'unit',
              aggregate: 'sum',
              value_field: 'total'
            }
          ]
        })
      },
      {
        collection: 'projects',
        field: 'workflow_count',
        computed_type: 'rollup',
        computed_store: true,
        computed_formula: JSON.stringify({
          related_collection: 'unit_workflows',
          fk_field: 'project',
          aggregate: 'count',
          value_field: ''
        })
      }
    ]

    vi.mocked(db).mockImplementation((table: unknown) => {
      if (table === 'nivaro_fields') return fieldsChain(rows) as never
      throw new Error(`unexpected table ${String(table)}`)
    })

    const unitWorkflowEntries = await getRollupContributors('unit_workflows')
    expect(unitWorkflowEntries).toHaveLength(2)
    expect(unitWorkflowEntries.map((e) => e.parentCollection).sort()).toEqual(['projects', 'units'])
    const unitsEntry = unitWorkflowEntries.find((e) => e.parentCollection === 'units')
    expect(unitsEntry).toMatchObject({ parentFk: 'unit', rollupField: 'total_cost' })
    expect(unitsEntry?.sources).toHaveLength(2)

    const materialsEntries = await getRollupContributors('unit_materials')
    expect(materialsEntries).toHaveLength(1)
    expect(materialsEntries[0]).toMatchObject({ parentCollection: 'units', parentFk: 'unit' })
  })

  it('skips rollup fields that are not computed_store', async () => {
    const rows = [
      {
        collection: 'units',
        field: 'total_cost',
        computed_type: 'rollup',
        computed_store: 0,
        computed_formula: JSON.stringify(rollupSource())
      }
    ]
    vi.mocked(db).mockImplementation((table: unknown) => {
      if (table === 'nivaro_fields') return fieldsChain(rows) as never
      throw new Error(`unexpected table ${String(table)}`)
    })

    expect(await getRollupContributors('unit_workflows')).toEqual([])
  })

  it('tolerates a nivaro_fields query failure (e.g. missing columns pre-migration) as an empty map', async () => {
    vi.mocked(db).mockImplementation((table: unknown) => {
      if (table === 'nivaro_fields') return throwingFieldsChain() as never
      throw new Error(`unexpected table ${String(table)}`)
    })

    expect(await getRollupContributors('unit_workflows')).toEqual([])
  })

  it('caches the map — nivaro_fields is only queried once until bust', async () => {
    const select = vi.fn().mockResolvedValue([])
    vi.mocked(db).mockImplementation((table: unknown) => {
      if (table === 'nivaro_fields') {
        return {
          where: vi.fn().mockReturnThis(),
          whereNotNull: vi.fn().mockReturnThis(),
          select
        } as never
      }
      throw new Error(`unexpected table ${String(table)}`)
    })

    await getRollupContributors('unit_workflows')
    await getRollupContributors('unit_workflows')
    expect(select).toHaveBeenCalledTimes(1)

    bustRollupContributorCache()
    await getRollupContributors('unit_workflows')
    expect(select).toHaveBeenCalledTimes(2)
  })
})

describe('recalcRollupsForParent', () => {
  const entry: RollupContributorEntry = {
    parentCollection: 'units',
    parentFk: 'unit',
    rollupField: 'total_cost',
    sources: [rollupSource()]
  }

  it('writes the recomputed total when it differs from the current value', async () => {
    const update = vi.fn().mockResolvedValue(1)
    const whereIds: unknown[] = []
    vi.mocked(db).mockImplementation((table: unknown) => {
      if (table === 'unit_workflows') return aggregateChain(100) as never
      if (table === 'units') return parentChain(50, 'total_cost', update, whereIds) as never
      throw new Error(`unexpected table ${String(table)}`)
    })

    await recalcRollupsForParent(entry, 'u1')

    expect(update).toHaveBeenCalledWith({ total_cost: 100 })
    expect(whereIds).toContain('u1')
  })

  it('does not write when the recomputed total matches the current value', async () => {
    const update = vi.fn().mockResolvedValue(1)
    const whereIds: unknown[] = []
    vi.mocked(db).mockImplementation((table: unknown) => {
      if (table === 'unit_workflows') return aggregateChain(100) as never
      if (table === 'units') return parentChain(100, 'total_cost', update, whereIds) as never
      throw new Error(`unexpected table ${String(table)}`)
    })

    await recalcRollupsForParent(entry, 'u1')

    expect(update).not.toHaveBeenCalled()
  })

  it('never throws — swallows errors from a failing query', async () => {
    vi.mocked(db).mockImplementation(() => {
      throw new Error('boom')
    })

    await expect(recalcRollupsForParent(entry, 'u1')).resolves.toBeUndefined()
  })

  it('no-ops when parentId is null', async () => {
    const dbFn = vi.fn()
    vi.mocked(db).mockImplementation(dbFn as never)

    await recalcRollupsForParent(entry, null)

    expect(dbFn).not.toHaveBeenCalled()
  })
})

describe('recalcAffectedRollups', () => {
  it('is a no-op when the collection has no rollup contributors', async () => {
    const dbFn = vi.fn()
    vi.mocked(db).mockImplementation((table: unknown) => {
      dbFn(table)
      if (table === 'nivaro_fields') return fieldsChain([]) as never
      throw new Error(`unexpected table ${String(table)}`)
    })

    await recalcAffectedRollups('unit_workflows', { id: 'w1', unit: 'u1' })

    expect(dbFn).toHaveBeenCalledTimes(1)
    expect(dbFn).toHaveBeenCalledWith('nivaro_fields')
  })

  it('recalcs both the old and new parent when the FK value changes on update', async () => {
    const rows = [
      {
        collection: 'units',
        field: 'total_cost',
        computed_type: 'rollup',
        computed_store: 1,
        computed_formula: JSON.stringify(rollupSource())
      }
    ]
    const update = vi.fn().mockResolvedValue(1)
    const whereIds: unknown[] = []
    vi.mocked(db).mockImplementation((table: unknown) => {
      if (table === 'nivaro_fields') return fieldsChain(rows) as never
      if (table === 'unit_workflows') return aggregateChain(100) as never
      if (table === 'units') return parentChain(0, 'total_cost', update, whereIds) as never
      throw new Error(`unexpected table ${String(table)}`)
    })

    await recalcAffectedRollups(
      'unit_workflows',
      { id: 'w1', unit: 'new-parent' },
      { id: 'w1', unit: 'old-parent' }
    )

    expect(whereIds).toEqual(expect.arrayContaining(['new-parent', 'old-parent']))
    expect(update).toHaveBeenCalledTimes(2)
  })

  it('recalcs only the single parent on delete (row is null)', async () => {
    const rows = [
      {
        collection: 'units',
        field: 'total_cost',
        computed_type: 'rollup',
        computed_store: 1,
        computed_formula: JSON.stringify(rollupSource())
      }
    ]
    const update = vi.fn().mockResolvedValue(1)
    const whereIds: unknown[] = []
    vi.mocked(db).mockImplementation((table: unknown) => {
      if (table === 'nivaro_fields') return fieldsChain(rows) as never
      if (table === 'unit_workflows') return aggregateChain(0) as never
      if (table === 'units') return parentChain(100, 'total_cost', update, whereIds) as never
      throw new Error(`unexpected table ${String(table)}`)
    })

    await recalcAffectedRollups('unit_workflows', null, { id: 'w1', unit: 'deleted-of' })

    expect(new Set(whereIds)).toEqual(new Set(['deleted-of']))
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('never throws — swallows errors from the contributor lookup', async () => {
    vi.mocked(db).mockImplementation(() => {
      throw new Error('boom')
    })

    await expect(recalcAffectedRollups('unit_workflows', { id: 'w1' })).resolves.toBeUndefined()
  })
})

describe('parent_filter', () => {
  it('parseRollupFormula carries parent_filter for both config shapes', async () => {
    const { parseRollupFormula } = await import('../../../services/rollups.js')
    const single = parseRollupFormula(
      JSON.stringify({
        related_collection: 'lines',
        fk_field: 'wf',
        aggregate: 'sum',
        value_field: 'amount',
        parent_filter: { workflow_type: { _neq: 2 } }
      })
    )
    expect(single?.parent_filter).toEqual({ workflow_type: { _neq: 2 } })
    const multi = parseRollupFormula(
      JSON.stringify({
        sources: [{ related_collection: 'lines', fk_field: 'wf', aggregate: 'count' }],
        parent_filter: { kind: 'x' }
      })
    )
    expect(multi?.parent_filter).toEqual({ kind: 'x' })
    expect(
      parseRollupFormula(
        JSON.stringify({ related_collection: 'l', fk_field: 'f', aggregate: 'count' })
      )?.parent_filter
    ).toBeUndefined()
  })

  it('matchesParentFilter mirrors the SQL filter: _neq is null-safe, literals mean _eq', async () => {
    const { matchesParentFilter } = await import('../../../services/rollups.js')
    const f = { workflow_type: { _neq: 2 } }
    expect(matchesParentFilter({ workflow_type: 1 }, f)).toBe(true)
    expect(matchesParentFilter({ workflow_type: null }, f)).toBe(true)
    expect(matchesParentFilter({ workflow_type: 2 }, f)).toBe(false)
    expect(matchesParentFilter({ workflow_type: '2' }, f)).toBe(false)
    expect(matchesParentFilter({ status: 'open' }, { status: 'open' })).toBe(true)
    expect(matchesParentFilter({ status: 'closed' }, { status: { _in: ['open', 'draft'] } })).toBe(
      false
    )
    expect(matchesParentFilter(undefined, f)).toBe(false)
    expect(matchesParentFilter({ workflow_type: 2 }, undefined)).toBe(true)
  })
})
