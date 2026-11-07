import { describe, expect, it } from 'vitest'
import { groupSumPathsFor, isSummableColumn } from './group-sums'

// Army 8 b08-N5: group headers read "Funding Year: 24315".
describe('group sums', () => {
  it('never totals ids or years', () => {
    expect(isSummableColumn('funding_years.id')).toBe(false)
    expect(isSummableColumn('project.project_id')).toBe(false)
    expect(isSummableColumn('fiscal_year')).toBe(false)
    expect(isSummableColumn('requisition_amount')).toBe(true)
    expect(isSummableColumn('purchase_orders.amount')).toBe(true)
  })
  it('judges years by whole words, not by a name containing "year"', () => {
    for (const p of ['year', 'funding_year', 'fiscalYear', 'budget-year', 'funding_years.value'])
      expect(isSummableColumn(p), p).toBe(false)
    for (const p of [
      'prior_year_spend',
      'yearly_total',
      'year_to_date_amount',
      'funding_years.amount'
    ])
      expect(isSummableColumn(p), p).toBe(true)
  })
  it('keeps money columns and admin-set aggregates', () => {
    expect(
      groupSumPathsFor({
        extra_field_meta: [{ path: 'line_count', aggregate: 'sum' }],
        sources: [
          {
            column_formats: {
              requisition_amount: { type: 'number' },
              'funding_years.id': { type: 'number' },
              created: { type: 'datetime' }
            }
          }
        ]
      })
    ).toEqual(['line_count', 'requisition_amount'])
  })
})
