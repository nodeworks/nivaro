import { describe, expect, it } from 'vitest'
import { touchesExtraField } from '../../../services/queue-materialization-read.js'

describe('touchesExtraField', () => {
  it('returns true when sort references an extra field', () => {
    expect(touchesExtraField('extra.owner.name', {})).toBe(true)
  })

  it('returns true when a column filter key references an extra field', () => {
    expect(touchesExtraField('', { 'extra.priority': 'High' })).toBe(true)
  })

  it('returns false when neither sort nor filters reference an extra field', () => {
    expect(touchesExtraField('-aging_hours', { state: 'review' })).toBe(false)
  })

  it('returns false for empty sort and filters', () => {
    expect(touchesExtraField('', {})).toBe(false)
  })
})
