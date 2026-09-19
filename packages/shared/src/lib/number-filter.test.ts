import { describe, expect, it } from 'vitest'
import {
  describeNumberFilter,
  formatNumberFilter,
  matchesNumberFilter,
  numberOfValue,
  parseNumberFilter
} from './number-filter'

describe('number filter encoding', () => {
  it('round-trips every operator', () => {
    for (const raw of [
      'num:eq:5',
      'num:neq:5',
      'num:gt:1000',
      'num:gte:1000',
      'num:lt:0',
      'num:lte:-2',
      'num:between:10..20'
    ])
      expect(formatNumberFilter(parseNumberFilter(raw)!)).toBe(raw)
  })

  it('orders a reversed between', () => {
    expect(parseNumberFilter('num:between:20..10')).toEqual({ op: 'between', a: 10, b: 20 })
  })

  it('rejects junk and plain text filters', () => {
    for (const raw of ['', 'BLT', 'num:sideways:3', 'num:gt:abc', 'gt:3'])
      expect(parseNumberFilter(raw)).toBeNull()
  })

  it('reads a formatted currency cell as a number', () => {
    expect(numberOfValue('$1,234.50')).toBe(1234.5)
    expect(numberOfValue(42)).toBe(42)
    expect(numberOfValue('')).toBeNull()
    expect(numberOfValue('n/a')).toBeNull()
  })

  it('compares', () => {
    const m = (raw: string, v: unknown) => matchesNumberFilter(v, parseNumberFilter(raw)!)
    expect(m('num:gt:1000', '$1,200.00')).toBe(true)
    expect(m('num:gt:1000', '$900.00')).toBe(false)
    expect(m('num:lte:0', 0)).toBe(true)
    expect(m('num:between:10..20', 20)).toBe(true)
    expect(m('num:between:10..20', 21)).toBe(false)
    expect(m('num:eq:5', 'five')).toBe(false)
  })

  it('describes itself for the applied-filter chip', () => {
    expect(describeNumberFilter(parseNumberFilter('num:gte:1000')!)).toBe('≥ 1,000')
    expect(describeNumberFilter(parseNumberFilter('num:between:10..20')!)).toBe('10 – 20')
  })
})
