import { describe, expect, it } from 'vitest'
import { compactStat, fmtStat, statCoverage, statValue, sumField } from './query-stats'

const rows = [
  { budget: 1000, remaining: 250, other: 400 },
  { budget: 3000, remaining: 750, other: null },
  { budget: 'x', remaining: null, other: null }
]

describe('sumField', () => {
  it('skips non-numeric and null values', () => {
    expect(sumField(rows, 'budget')).toBe(4000)
    expect(sumField(rows, 'remaining')).toBe(1000)
    expect(sumField(rows, 'missing')).toBe(0)
  })
})

describe('statValue', () => {
  it('sums a field, minus field_subtract', () => {
    expect(statValue({ field: 'budget' }, rows, null)).toBe(4000)
    expect(statValue({ field: 'budget', field_subtract: 'remaining' }, rows, null)).toBe(3000)
  })
  it('evaluates a formula over the summed fields', () => {
    const v = statValue({ formula: '{{remaining}} / {{budget}} * 100' }, rows, null)
    expect(v).toBe(25)
  })
  it('a formula whose operand has no numeric rows is null, never NaN or 0', () => {
    expect(statValue({ formula: '{{nothing}} / {{budget}} * 100' }, rows, null)).toBeNull()
    expect(statValue({ formula: '{{remaining}} / {{nothing}}' }, rows, null)).toBeNull()
  })
  it('a formula sums only rows where every operand is present', () => {
    // partial coverage: the numerator exists on one row, the denominator on three
    const r = [
      { left: 80, pub: 100 },
      { left: null, pub: 900 },
      { left: null, pub: 1000 },
      { left: 50, pub: null }
    ]
    expect(statValue({ formula: '{{left}} / {{pub}} * 100' }, r, null)).toBe(80)
  })
  it('narrows by row_match before summing', () => {
    const r = [
      { k: 'a', v: 1 },
      { k: 'b', v: 2 },
      { k: 'a', v: 4 }
    ]
    expect(statValue({ field: 'v', row_match: { k: 'a' } }, r, null)).toBe(5)
  })
  it('a date/text tile without a query is null, never a summed number', () => {
    expect(statValue({ field: 'budget', format: 'date' }, rows, null)).toBeNull()
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
  it('an unparseable date renders the empty label instead of throwing', () => {
    expect(fmtStat('not a date', 'date', 'n/a')).toBe('n/a')
  })
})

describe('statCoverage', () => {
  const r = [
    { left: 80, pub: 100 },
    { left: null, pub: 900 },
    { left: 0, pub: 1000 }
  ]
  it('counts rows holding the field, out of all rows', () => {
    expect(statCoverage({ field: 'left' }, r)).toEqual({ reporting: 2, total: 3 })
    expect(statCoverage({ formula: '{{left}} / {{pub}}' }, r)).toEqual({ reporting: 2, total: 3 })
  })
  it('query and date tiles have no row coverage', () => {
    expect(statCoverage({ query: { value_field: 'n' } }, r)).toBeNull()
    expect(statCoverage({ field: 'left', format: 'date' }, r)).toBeNull()
  })
})

describe('compactStat', () => {
  it('shortens large money, keeps small values exact', () => {
    expect(compactStat(637_056_259.98, 'currency')).toBe('$637.1M')
    expect(compactStat(13_532_127.82)).toBe('$13.5M')
    expect(compactStat(-2_400_000)).toBe('-$2.4M')
    expect(compactStat(45_300)).toBe('$45K')
    expect(compactStat(9_500.5)).toBe('$9,500.50')
    expect(compactStat(1_250_000, 'number')).toBe('1.3M')
  })
})
