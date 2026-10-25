import { describe, expect, it } from 'vitest'
import { columnLengthError, columnMaxLength } from './column-length'

describe('column length', () => {
  it('reads a positive column limit and ignores (max) / missing', () => {
    expect(columnMaxLength({ max_length: 255 })).toBe(255)
    expect(columnMaxLength({ max_length: null })).toBeNull()
    expect(columnMaxLength({ max_length: -1 })).toBeNull()
    expect(columnMaxLength({})).toBeNull()
  })

  it('names the field when a value is past the limit', () => {
    expect(columnLengthError({ max_length: 5 }, 'abcdef', 'Vendor Contact')).toBe(
      'Vendor Contact is too long — 5 characters at most (it has 6)'
    )
    expect(columnLengthError({ max_length: 5 }, 'abcde', 'Vendor Contact')).toBeNull()
    expect(columnLengthError({}, 'x'.repeat(10_000), 'Description')).toBeNull()
    expect(columnLengthError({ max_length: 5 }, 123456, 'Qty')).toBeNull()
  })
})
