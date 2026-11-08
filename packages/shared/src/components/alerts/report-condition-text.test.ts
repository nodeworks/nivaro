import { describe, expect, it } from 'vitest'
import { categoryLabel, reportConditionText } from './types'

// Army 9 b16: "row_count ≥ 40", "value ≥ 1000000" and a catalog heading "Sla".
describe('alert wording', () => {
  it('reads conditions in words', () => {
    expect(reportConditionText({ field: 'row_count', op: 'gte', value: 40 })).toBe('Rows ≥ 40')
    expect(reportConditionText({ field: 'value', op: 'gte', value: 1000000 })).toBe(
      'Value ≥ 1,000,000'
    )
  })
  it('keeps acronyms in category headings', () => {
    expect(categoryLabel('sla')).toBe('SLA')
    expect(categoryLabel('spend')).toBe('Spend')
  })
})
