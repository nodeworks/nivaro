import { describe, expect, it } from 'vitest'
import { softRuleWarning } from './soft-rules'

const daysAgo = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

const field = {
  field: 'date_required',
  type: 'datetime',
  label: 'Date Required',
  validation_rules: JSON.stringify([
    { type: 'min_days_from_today', value: -10957, message: 'within 30 years' },
    {
      type: 'min_days_from_today',
      value: -30,
      soft: true,
      message: 'More than 30 days in the past'
    }
  ])
}

describe('softRuleWarning (army4 a01-5)', () => {
  it('warns on a date more than 30 days back, only from the soft rule', () => {
    expect(softRuleWarning(field, { date_required: daysAgo(400) })).toBe(
      'More than 30 days in the past'
    )
    expect(softRuleWarning(field, { date_required: daysAgo(3) })).toBeNull()
  })

  it('says nothing for an empty value, hard-only rules or unreadable rules', () => {
    expect(softRuleWarning(field, { date_required: null })).toBeNull()
    expect(
      softRuleWarning({ field: 'q', validation_rules: [{ type: 'min', value: 5 }] }, { q: 1 })
    ).toBeNull()
    expect(softRuleWarning({ field: 'q', validation_rules: 'nope' }, { q: 1 })).toBeNull()
  })

  it('judges a typed number as a number', () => {
    const qty = {
      field: 'q',
      type: 'integer',
      validation_rules: [{ type: 'min', value: 5, soft: true }]
    }
    expect(softRuleWarning(qty, { q: '2' })).toMatch(/5/)
    expect(softRuleWarning(qty, { q: '9' })).toBeNull()
  })
})
