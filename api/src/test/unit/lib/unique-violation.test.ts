import { describe, expect, it } from 'vitest'
import { isUniqueViolation } from '../../../lib/unique-violation.js'

describe('isUniqueViolation', () => {
  it('knows every database the API runs on', () => {
    expect(isUniqueViolation({ number: 2627 })).toBe(true)
    expect(isUniqueViolation({ number: 2601 })).toBe(true)
    expect(isUniqueViolation({ originalError: { info: { number: 2627 } } })).toBe(true)
    expect(isUniqueViolation({ errors: [{ number: 2601 }] })).toBe(true)
    expect(isUniqueViolation({ code: '23505' })).toBe(true)
    expect(isUniqueViolation({ code: 'ER_DUP_ENTRY', errno: 1062 })).toBe(true)
    expect(isUniqueViolation({ errno: 1062 })).toBe(true)
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_UNIQUE' })).toBe(true)
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' })).toBe(true)
  })
  it('is false for other refusals and non-errors', () => {
    expect(isUniqueViolation({ number: 547 })).toBe(false)
    expect(isUniqueViolation({ code: '23503' })).toBe(false)
    expect(isUniqueViolation({ errno: 1452 })).toBe(false)
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' })).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
    expect(isUniqueViolation('2627')).toBe(false)
  })
})
