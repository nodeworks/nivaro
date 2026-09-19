import { describe, expect, it } from 'vitest'
import {
  dateFilterBounds,
  dayOfValue,
  describeDateFilter,
  formatDateFilter,
  matchesDateFilter,
  parseDateFilter
} from './date-filter'

describe('date filter encoding', () => {
  it('round-trips every operator', () => {
    for (const raw of [
      'on:2026-09-19',
      'before:2026-09-19',
      'after:2026-09-19',
      'onbefore:2026-09-19',
      'onafter:2026-09-19',
      'between:2026-09-01..2026-09-30'
    ]) {
      const p = parseDateFilter(raw)
      expect(p).not.toBeNull()
      expect(formatDateFilter(p!)).toBe(raw)
    }
  })

  it('still reads the collection browser’s older range encoding', () => {
    expect(parseDateFilter('r:2026-09-01..2026-09-30')).toEqual({
      op: 'between',
      from: '2026-09-01',
      to: '2026-09-30'
    })
  })

  it('rejects junk rather than guessing', () => {
    for (const raw of ['', 'last7', 'on:not-a-date', 'sideways:2026-09-19', '2026-09-19'])
      expect(parseDateFilter(raw)).toBeNull()
  })

  it('turns each operator into the right day bounds', () => {
    const b = (raw: string) => dateFilterBounds(parseDateFilter(raw)!)
    expect(b('on:2026-09-19')).toEqual({ from: '2026-09-19', to: '2026-09-19' })
    expect(b('before:2026-09-19')).toEqual({ from: null, to: '2026-09-18' })
    expect(b('after:2026-09-19')).toEqual({ from: '2026-09-20', to: null })
    expect(b('onbefore:2026-09-19')).toEqual({ from: null, to: '2026-09-19' })
    expect(b('onafter:2026-09-19')).toEqual({ from: '2026-09-19', to: null })
    expect(b('between:2026-09-01..2026-09-30')).toEqual({ from: '2026-09-01', to: '2026-09-30' })
  })

  it('crosses month and year ends', () => {
    expect(dateFilterBounds(parseDateFilter('before:2026-01-01')!).to).toBe('2025-12-31')
    expect(dateFilterBounds(parseDateFilter('after:2026-02-28')!).from).toBe('2026-03-01')
  })

  it('reads the value shapes a queue column actually stores', () => {
    expect(dayOfValue('2026-09-19')).toBe('2026-09-19')
    expect(dayOfValue('2026-09-19T14:03:00.000Z')).toBe('2026-09-19')
    expect(dayOfValue('09/19/2026')).toBe('09/19/2026'.replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2'))
    expect(dayOfValue('Wed Dec 18 2024 10:04:03 GMT-0500')).toBe('2024-12-18')
    expect(dayOfValue('')).toBeNull()
    expect(dayOfValue('not a date')).toBeNull()
  })

  it('matches only values it can read as a date', () => {
    const f = parseDateFilter('between:2026-09-01..2026-09-30')!
    expect(matchesDateFilter('2026-09-15', f)).toBe(true)
    expect(matchesDateFilter('2026-10-01', f)).toBe(false)
    expect(matchesDateFilter('09/01/2026', f)).toBe(true)
    expect(matchesDateFilter('', f)).toBe(false)
    expect(matchesDateFilter('BLT', f)).toBe(false)
  })

  it('describes itself for the applied-filter chip', () => {
    expect(describeDateFilter(parseDateFilter('before:2026-09-19')!)).toBe('Before 09/19/26')
    expect(describeDateFilter(parseDateFilter('on:2026-09-19')!)).toBe('09/19/26')
  })
})
