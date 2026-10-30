import { beforeEach, describe, expect, it, vi } from 'vitest'

// workflows-like table: a rollup that only owns workflow_type != 2 rows.
const fieldRows = [
  {
    collection: 'workflows',
    field: 'requisition_amount',
    computed_formula: JSON.stringify({
      sources: [
        {
          related_collection: 'workflow_line_items',
          fk_field: 'workflow',
          aggregate: 'sum',
          value_field: 'amount'
        }
      ],
      parent_filter: { workflow_type: { _neq: 2 } }
    })
  }
]
const sampleRows = [
  // owned by another writer: the rollup computes nothing here
  { id: 3, requisition_amount: 700000, workflow_type: 2 },
  // owned by the rollup and stale
  { id: 2, requisition_amount: 50, workflow_type: 1 },
  // owned by the rollup and current
  { id: 1, requisition_amount: 10, workflow_type: 1 }
]
const selected: string[][] = []
const inserted: Array<Record<string, unknown>> = []

function builder(table: string) {
  const b: Record<string, any> = {}
  for (const m of ['where', 'orWhere', 'orderBy', 'whereIn']) {
    b[m] = (arg: unknown) => {
      if (typeof arg === 'function') (arg as (q: unknown) => void)(b)
      return b
    }
  }
  b.select = (...cols: string[]) => {
    if (table === 'workflows') selected.push(cols)
    return b
  }
  b.limit = async () => sampleRows
  b.first = async () => undefined
  b.insert = async (row: Record<string, unknown>) => {
    inserted.push(row)
  }
  // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
  b.then = (res: (v: unknown) => unknown) =>
    Promise.resolve(table === 'nivaro_fields' ? fieldRows : []).then(res)
  return b
}

vi.mock('../../../db/index.js', () => ({
  db: Object.assign((table: string) => builder(table), { raw: (s: string) => s })
}))

vi.mock('../../../services/rollups.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    computeRollupTotal: async (_cfg: unknown, id: unknown) => (id === 1 ? 10 : id === 2 ? 20 : null)
  }
})

import { detectRollupDrift } from '../../../services/rollup-drift.js'

describe('rollup drift', () => {
  beforeEach(() => {
    selected.length = 0
    inserted.length = 0
  })

  it('skips rows outside the parent_filter and still reports real drift', async () => {
    const report = await detectRollupDrift()
    expect(selected[0]).toContain('workflow_type')
    expect(report.checked_rows).toBe(2)
    expect(report.fields[0].examples).toEqual([['2', 50, 20]])
    expect(inserted[0].title).toBe('Rollup drift: workflows.requisition_amount (1/3 rows stale)')
  })
})
