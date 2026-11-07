import { describe, expect, it } from 'vitest'
import { lineageSummary } from './FieldRow'

describe('lineageSummary', () => {
  it('shows an empty input as 0, never "∅" (army8 b01 LEFT TO FORECAST)', () => {
    const s = lineageSummary({
      kind: 'write',
      formula: 'item.requisition_amount - item.forecast_total',
      inputs: { requisition_amount: 301.52, forecast_total: null }
    } as never)
    expect(s).toBe('= 301.52 − 0')
    expect(s).not.toContain('∅')
  })
})
