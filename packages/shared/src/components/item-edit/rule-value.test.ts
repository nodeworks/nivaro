import { describe, expect, it } from 'vitest'
import { applyValidationRule } from '../../lib/validation-rules'
import { ruleValueFor } from './line-qty'

describe('ruleValueFor', () => {
  it('judges a typed number as the number it saves as', () => {
    expect(ruleValueFor('decimal', '-7')).toBe(-7)
    expect(ruleValueFor('integer', ' 5 ')).toBe(5)
    // A min:0 rule used to read "-7" as a 2-character string and pass it.
    expect(
      applyValidationRule({ type: 'min', value: 0 }, ruleValueFor('decimal', '-7'), 'Price')
    ).toBe('Price must be at least 0')
  })

  it('leaves text, empty and non-number columns as they are', () => {
    expect(ruleValueFor('string', '-7')).toBe('-7')
    expect(ruleValueFor('decimal', '')).toBe('')
    expect(ruleValueFor('decimal', 'abc')).toBe('abc')
    expect(ruleValueFor('decimal', 3)).toBe(3)
    expect(ruleValueFor(null, '4')).toBe('4')
  })
})

describe('days-from-today rules on calendar dates', () => {
  const ymd = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  it('counts a stored UTC-midnight date as its own day', () => {
    const in3 = new Date()
    in3.setDate(in3.getDate() + 3)
    const rule = { type: 'min_days_from_today', value: 3 }
    expect(applyValidationRule(rule, ymd(in3), 'Date')).toBeNull()
    expect(applyValidationRule(rule, `${ymd(in3)}T00:00:00.000Z`, 'Date')).toBeNull()
  })

  it('refuses a far-future date under max_days_from_today', () => {
    expect(
      applyValidationRule(
        { type: 'max_days_from_today', value: 730 },
        '9999-12-31',
        'Requested Delivery Date'
      )
    ).toBe('Requested Delivery Date must be within 730 days of today')
  })
})
