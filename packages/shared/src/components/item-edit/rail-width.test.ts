import { describe, expect, it } from 'vitest'
import { isNarrowRecordWidth } from './rail-width'

describe('isNarrowRecordWidth (army11 phone width)', () => {
  it('folds the rail at phone and small-tablet widths', () => {
    expect(isNarrowRecordWidth(375)).toBe(true)
    expect(isNarrowRecordWidth(767)).toBe(true)
  })
  it('keeps it beside the form from 768 px, and never judges an unmeasured box', () => {
    expect(isNarrowRecordWidth(768)).toBe(false)
    expect(isNarrowRecordWidth(1280)).toBe(false)
    expect(isNarrowRecordWidth(0)).toBe(false)
  })
})
