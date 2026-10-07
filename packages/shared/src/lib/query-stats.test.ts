import { describe, expect, it } from 'vitest'
import { fmtStat, statValue, sumField } from './query-stats'

const rows = [
  { pub_amount: 1000, total_remaining: 250, fusion_remaining: 400 },
  { pub_amount: 3000, total_remaining: 750, fusion_remaining: null },
  { pub_amount: 'x', total_remaining: null, fusion_remaining: null }
]

describe('sumField', () => {
  it('skips non-numeric and null values', () => {
    expect(sumField(rows, 'pub_amount')).toBe(4000)
    expect(sumField(rows, 'total_remaining')).toBe(1000)
    expect(sumField(rows, 'missing')).toBe(0)
  })
})

describe('statValue', () => {
  it('sums a field, minus field_subtract', () => {
    expect(statValue({ field: 'pub_amount' }, rows, null)).toBe(4000)
    expect(statValue({ field: 'pub_amount', field_subtract: 'total_remaining' }, rows, null)).toBe(
      3000
    )
  })
  it('evaluates a formula over the summed fields', () => {
    const v = statValue({ formula: '{{total_remaining}} / {{pub_amount}} * 100' }, rows, null)
    expect(v).toBe(25)
  })
  it('a formula whose operand has no numeric rows is null, never NaN or 0', () => {
    expect(statValue({ formula: '{{nothing}} / {{pub_amount}} * 100' }, rows, null)).toBeNull()
    expect(statValue({ formula: '{{total_remaining}} / {{nothing}}' }, rows, null)).toBeNull()
  })
  it('narrows by row_match before summing', () => {
    const r = [
      { k: 'a', v: 1 },
      { k: 'b', v: 2 },
      { k: 'a', v: 4 }
    ]
    expect(statValue({ field: 'v', row_match: { k: 'a' } }, r, null)).toBe(5)
  })
  it('a query stat sums value_field, or returns the first raw value for date/text', () => {
    const q = [
      { finished_at: '2026-10-07T12:00:00.000Z', n: 3 },
      { finished_at: '2026-10-06T12:00:00.000Z', n: 4 }
    ]
    expect(statValue({ query: { value_field: 'n' } }, rows, q)).toBe(7)
    expect(statValue({ query: { value_field: 'finished_at' }, format: 'date' }, rows, q)).toBe(
      '2026-10-07T12:00:00.000Z'
    )
    expect(
      statValue({ query: { value_field: 'finished_at' }, format: 'date' }, rows, [])
    ).toBeNull()
  })
})

describe('fmtStat', () => {
  it('currency keeps whole dollars whole and cents as a pair', () => {
    expect(fmtStat(1234, 'currency')).toBe('$1,234')
    expect(fmtStat(1234.5)).toBe('$1,234.50')
  })
  it('percent, number, text', () => {
    expect(fmtStat(25, 'percent')).toBe('25%')
    expect(fmtStat(33.333, 'percent')).toBe('33.3%')
    expect(fmtStat(1234.567, 'number')).toBe('1,234.57')
    expect(fmtStat('hello', 'text')).toBe('hello')
  })
  it('date renders through formatDate', () => {
    expect(fmtStat('2026-10-07T12:00:00.000Z', 'date')).toMatch(/2026/)
  })
  it('null and non-finite render the empty label', () => {
    expect(fmtStat(null)).toBe('—')
    expect(fmtStat(null, 'date', 'never imported')).toBe('never imported')
    expect(fmtStat(Number.NaN, 'percent', 'n/a')).toBe('n/a')
  })
})
