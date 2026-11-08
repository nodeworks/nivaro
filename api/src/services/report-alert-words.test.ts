import { describe, expect, it } from 'vitest'
import { reportConditionText } from './report-alert-words.js'

// Army 9 b16: report alerts read "row_count ≥ 40", "value ≥ 1000000".
describe('reportConditionText', () => {
  it('names the metric and formats the number', () => {
    expect(reportConditionText({ field: 'row_count', op: 'gte', value: 40 })).toBe('Rows ≥ 40')
    expect(reportConditionText({ field: 'value', op: 'lt', value: 100000000 })).toBe(
      'Value < 100,000,000'
    )
    expect(reportConditionText({ field: 'sum:open_amount', op: 'gt', value: 5 })).toBe(
      'Total of open amount > 5'
    )
    expect(reportConditionText({ field: 'tile:Past due', op: 'gte', value: 1 })).toBe(
      'Past due ≥ 1'
    )
  })
})
