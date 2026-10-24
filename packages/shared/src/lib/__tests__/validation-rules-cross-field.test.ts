import { describe, expect, it } from 'vitest'
import { applyValidationRule } from '../validation-rules'

// Twin of api/src/test/unit/services/validation-rules-cross-field.test.ts —
// the form must answer exactly what the save will.
describe('gte_field / lte_field (client)', () => {
  const END = { type: 'gte_field', field: 'service_start_date' }
  it('reads the other field from the draft', () => {
    expect(
      applyValidationRule(END, '2020-01-01', 'Service End', { service_start_date: '2026-05-01' })
    ).toBe('Service End must be on or after service start date')
    expect(
      applyValidationRule(END, '2026-05-01', 'Service End', { service_start_date: '2026-05-01' })
    ).toBeNull()
    expect(
      applyValidationRule(END, '2020-01-01', 'Service End', { service_start_date: '' })
    ).toBeNull()
    expect(applyValidationRule(END, '2020-01-01', 'Service End')).toBeNull()
  })
  it('compares numbers numerically and has an lte twin', () => {
    expect(applyValidationRule({ type: 'gte_field', field: 'a' }, '9', 'B', { a: 10 })).toMatch(
      /on or after/
    )
    expect(applyValidationRule({ type: 'lte_field', field: 'a' }, 9, 'B', { a: '10' })).toBeNull()
  })
})
