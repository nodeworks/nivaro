import { describe, expect, it } from 'vitest'
import { NEGATIVE_AMOUNT_MESSAGE, sanitizeAmount } from './RecordGridEditor'

describe('Manage Forecast amount cells', () => {
  it('refuse a negative unless the grid allows it', () => {
    expect(sanitizeAmount('-7', false)).toEqual({ value: null, refused: NEGATIVE_AMOUNT_MESSAGE })
    expect(sanitizeAmount('10-5000', false).value).toBeNull()
    expect(sanitizeAmount('-7', true)).toEqual({ value: '-7', refused: null })
  })

  it('keeps one leading minus and one decimal point', () => {
    expect(sanitizeAmount('1-2', true).value).toBe('12')
    expect(sanitizeAmount('--5', true).value).toBe('-5')
    expect(sanitizeAmount('1.2.3', false).value).toBe('1.23')
    expect(sanitizeAmount('1,234.50', false).value).toBe('1234.50')
  })
})
