import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/rollups.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/rollups.js')>()),
  getRollupContributors: vi.fn(async () => []),
  getAllRollupContributors: vi.fn(async () => new Map())
}))

import { rollupMoves } from '../../../services/rollup-moves.js'

const sum = (rollupField: string, value_field: string, extra: Record<string, unknown> = {}) => ({
  rollupField,
  source: {
    related_collection: 'workflow_line_items',
    fk_field: 'workflow',
    aggregate: 'sum' as const,
    value_field,
    ...extra
  }
})

describe('rollupMoves', () => {
  it('a line amount edit moves the requisition amount by the difference', () => {
    expect(
      rollupMoves([sum('requisition_amount', 'amount')], { amount: 1 }, { amount: 2060 })
    ).toEqual([{ field: 'requisition_amount', delta: 2059, source_field: 'amount' }])
  })

  it('an added line adds its amount, a removed one takes it away', () => {
    expect(rollupMoves([sum('requisition_amount', 'amount')], null, { amount: 50 })).toEqual([
      { field: 'requisition_amount', delta: 50, source_field: 'amount' }
    ])
    expect(rollupMoves([sum('requisition_amount', 'amount')], { amount: 50 }, null)).toEqual([
      { field: 'requisition_amount', delta: -50, source_field: 'amount' }
    ])
  })

  it('counts, filters and leaves out what it cannot work out alone', () => {
    const sources = [
      {
        rollupField: 'line_count',
        source: { ...sum('x', 'id').source, aggregate: 'count' as const }
      },
      sum('capital_total', 'amount', { filter: { line_type: { _eq: 'Capital' } } }),
      sum('formula_total', 'amount', { value_formula: '{{qty}} * {{price}}' })
    ]
    expect(
      rollupMoves(
        sources,
        { amount: 10, line_type: 'Expense' },
        { amount: 10, line_type: 'Capital' }
      )
    ).toEqual([{ field: 'capital_total', delta: 10, source_field: 'amount' }])
    expect(rollupMoves(sources, null, { amount: 1, line_type: 'Expense' })).toEqual([
      { field: 'line_count', delta: 1 }
    ])
  })

  it('a write that moves nothing says nothing', () => {
    expect(
      rollupMoves([sum('requisition_amount', 'amount')], { amount: 5 }, { amount: 5 })
    ).toEqual([])
  })
})
