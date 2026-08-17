import { describe, expect, it } from 'vitest'
import { applyValidationRule } from '../../../services/validation-rules.js'

/**
 * This evaluator MIRRORS packages/shared/src/lib/validation-rules.ts — a value
 * the form accepts must never be rejected by the save it triggers. These
 * cases pin the semantics both sides must agree on.
 */
describe('applyValidationRule (server)', () => {
  it('every non-required rule skips empty values — optional stays optional', () => {
    for (const type of ['min', 'max', 'regex', 'email', 'url', 'min_days_from_today']) {
      expect(applyValidationRule({ type, value: 5 }, null, 'F')).toBeNull()
      expect(applyValidationRule({ type, value: 5 }, '', 'F')).toBeNull()
      expect(applyValidationRule({ type, value: 5 }, undefined, 'F')).toBeNull()
    }
  })

  it('required fires on explicit empty', () => {
    expect(applyValidationRule({ type: 'required' }, '', 'F')).toMatch(/required/)
    expect(applyValidationRule({ type: 'required' }, null, 'F')).toMatch(/required/)
    expect(applyValidationRule({ type: 'required' }, [], 'F')).toMatch(/required/)
    expect(applyValidationRule({ type: 'required' }, 0, 'F')).toBeNull() // 0 is a value
    expect(applyValidationRule({ type: 'required' }, false, 'F')).toBeNull()
  })

  it('min/max branch on number vs string length', () => {
    expect(applyValidationRule({ type: 'min', value: 10 }, 5, 'F')).toMatch(/at least 10/)
    expect(applyValidationRule({ type: 'min', value: 10 }, 15, 'F')).toBeNull()
    expect(applyValidationRule({ type: 'min', value: 3 }, 'ab', 'F')).toMatch(/characters/)
    expect(applyValidationRule({ type: 'max', value: 3 }, 'abcd', 'F')).toMatch(/at most 3/)
  })

  it('email and regex', () => {
    expect(applyValidationRule({ type: 'email' }, 'not-an-email', 'F')).toMatch(/valid email/)
    expect(applyValidationRule({ type: 'email' }, 'a@b.co', 'F')).toBeNull()
    expect(applyValidationRule({ type: 'regex', value: '^[A-Z]{3}$' }, 'ABC', 'F')).toBeNull()
    expect(applyValidationRule({ type: 'regex', value: '^[A-Z]{3}$' }, 'abc', 'F')).toMatch(
      /invalid/
    )
  })

  it('a broken regex pattern is config error, never caller error', () => {
    expect(applyValidationRule({ type: 'regex', value: '([' }, 'anything', 'F')).toBeNull()
  })

  it('min_days_from_today rejects near dates, accepts far ones', () => {
    const near = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    const far = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
    expect(applyValidationRule({ type: 'min_days_from_today', value: 7 }, near, 'F')).toMatch(
      /at least 7 days/
    )
    expect(applyValidationRule({ type: 'min_days_from_today', value: 7 }, far, 'F')).toBeNull()
  })

  it('a custom message wins over the default', () => {
    expect(
      applyValidationRule({ type: 'required', message: 'Pick a zone first' }, null, 'F')
    ).toBe('Pick a zone first')
  })

  it('an unknown rule type never blocks the write', () => {
    expect(applyValidationRule({ type: 'future_rule_v9', value: 1 }, 'x', 'F')).toBeNull()
  })
})
