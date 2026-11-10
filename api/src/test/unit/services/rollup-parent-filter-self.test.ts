import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => {
  const db = vi.fn()
  ;(db as unknown as Record<string, unknown>).raw = vi.fn().mockResolvedValue([])
  return { db }
})

import { db } from '../../../db/index.js'
import {
  bustRollupContributorCache,
  clearDecimalScaleCache,
  cloneDerivedFields,
  ownParentFilterRollups,
  recalcOwnFilteredRollups
} from '../../../services/rollups.js'

// projects.pub_amount: a stored sum of Completed CARs, kept only while the
// project's amount follows its CARs (the flag is not false).
const PUB_FIELD = {
  collection: 'projects',
  field: 'pub_amount',
  computed_type: 'rollup',
  computed_store: 1,
  computed_formula: JSON.stringify({
    sources: [
      {
        related_collection: 'workflows',
        fk_field: 'project',
        aggregate: 'sum',
        value_field: 'requisition_amount',
        filter: { workflow_type: { _eq: 2 }, workflow_state: { _eq: 2 } }
      }
    ],
    parent_filter: { pub_amount_follows_cars: { _neq: false } }
  })
}

function fieldsChain(rows: unknown[]) {
  return {
    where: vi.fn().mockReturnThis(),
    whereNotNull: vi.fn().mockReturnThis(),
    select: vi.fn().mockResolvedValue(rows)
  }
}

function aggregateChain(value: number | null) {
  return {
    where: vi.fn().mockReturnThis(),
    modify: vi.fn(function (this: unknown, cb: (q: unknown) => void) {
      cb(this)
      return this
    }),
    whereIn: vi.fn().mockReturnThis(),
    whereNot: vi.fn().mockReturnThis(),
    whereNull: vi.fn().mockReturnThis(),
    whereNotNull: vi.fn().mockReturnThis(),
    orWhereNull: vi.fn().mockReturnThis(),
    andWhere: vi.fn().mockReturnThis(),
    sum: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue({ v: value })
  }
}

/** The project row: first read = the filter columns, second = the stored amount. */
function projectChain(flag: unknown, current: number | null, update: ReturnType<typeof vi.fn>) {
  const first = vi
    .fn()
    .mockResolvedValueOnce({ pub_amount_follows_cars: flag })
    .mockResolvedValueOnce({ pub_amount: current })
  return { where: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), first, update }
}

function wire(opts: { flag: unknown; current: number | null; carTotal: number | null }) {
  const update = vi.fn().mockResolvedValue(1)
  const project = projectChain(opts.flag, opts.current, update)
  vi.mocked(db).mockImplementation((table: unknown) => {
    if (table === 'nivaro_fields') return fieldsChain([PUB_FIELD]) as never
    if (table === 'projects') return project as never
    if (table === 'workflows') return aggregateChain(opts.carTotal) as never
    throw new Error(`unexpected table ${String(table)}`)
  })
  return update
}

afterEach(() => {
  vi.clearAllMocks()
  bustRollupContributorCache()
  clearDecimalScaleCache()
})

describe("a parent's own stored rollup and its parent_filter", () => {
  it('lists the filter fields of each stored rollup on the collection', async () => {
    wire({ flag: null, current: null, carTotal: null })
    expect(await ownParentFilterRollups('projects')).toEqual([
      { field: 'pub_amount', filterFields: ['pub_amount_follows_cars'] }
    ])
    expect(await ownParentFilterRollups('workflows')).toEqual([])
  })

  it('flipping the flag back to following recomputes the amount', async () => {
    const update = wire({ flag: null, current: 5, carTotal: 7 })
    const fields = await recalcOwnFilteredRollups('projects', 42, ['pub_amount_follows_cars'])
    expect(fields).toEqual(['pub_amount'])
    expect(update).toHaveBeenCalledWith({ pub_amount: 7 })
  })

  it('a write that does not touch a filter field does not recompute', async () => {
    const update = wire({ flag: null, current: 5, carTotal: 7 })
    expect(await recalcOwnFilteredRollups('projects', 42, ['name', 'pub_amount'])).toEqual([])
    expect(update).not.toHaveBeenCalled()
  })

  it('a project with no Completed CAR reads blank after flipping back', async () => {
    const update = wire({ flag: true, current: 5, carTotal: null })
    await recalcOwnFilteredRollups('projects', 42, ['pub_amount_follows_cars'])
    expect(update).toHaveBeenCalledWith({ pub_amount: null })
  })

  it('turning the flag off leaves the typed amount alone', async () => {
    const update = wire({ flag: false, current: 5, carTotal: 7 })
    await recalcOwnFilteredRollups('projects', 42, ['pub_amount_follows_cars'])
    expect(update).not.toHaveBeenCalled()
  })

  it('never throws', async () => {
    vi.mocked(db).mockImplementation(() => {
      throw new Error('boom')
    })
    await expect(recalcOwnFilteredRollups('projects', 42, ['x'])).resolves.toEqual([])
  })

  it('a clone starts without the stored rollups and the fields their filter reads', async () => {
    wire({ flag: null, current: null, carTotal: null })
    expect(await cloneDerivedFields('projects')).toEqual(['pub_amount', 'pub_amount_follows_cars'])
    expect(await cloneDerivedFields('workflows')).toEqual([])
  })
})
