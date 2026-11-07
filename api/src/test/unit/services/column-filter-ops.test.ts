import { describe, expect, it } from 'vitest'
import {
  dayOfValue,
  matchesColumnFilterOp,
  numberOfValue,
  parseColumnFilterOp
} from '../../../services/column-filter-ops.js'

describe('queue column filter operators', () => {
  const m = (raw: string, v: unknown) => {
    const op = parseColumnFilterOp(raw)
    expect(op).not.toBeNull()
    return matchesColumnFilterOp(v, op!)
  }

  it('reads every date operator the client can send', () => {
    expect(m('on:2026-09-19', '2026-09-19T08:00:00Z')).toBe(true)
    expect(m('before:2026-09-19', '2026-09-18')).toBe(true)
    expect(m('before:2026-09-19', '2026-09-19')).toBe(false)
    expect(m('after:2026-09-19', '2026-09-20')).toBe(true)
    expect(m('onbefore:2026-09-19', '2026-09-19')).toBe(true)
    expect(m('onafter:2026-09-19', '2026-09-19')).toBe(true)
    expect(m('between:2026-09-01..2026-09-30', '09/15/2026')).toBe(true)
    expect(m('r:2026-09-01..2026-09-30', '2026-10-01')).toBe(false)
  })

  it('reads the JS Date.toString() shape queue extras store', () => {
    expect(dayOfValue('Wed Dec 18 2024 10:04:03 GMT-0500 (Eastern Standard Time)')).toBe(
      '2024-12-18'
    )
    expect(m('between:2024-12-01..2024-12-31', 'Wed Dec 18 2024 10:04:03 GMT-0500')).toBe(true)
  })

  it('reads a zoned timestamp as its America/New_York day (army 6 L37)', () => {
    // 11/04 10 PM ET is 11/05 03:00 UTC: it is a 11/04 row, never "On 11/05"
    expect(dayOfValue('2026-11-05T03:00:00.000Z')).toBe('2026-11-04')
    expect(m('on:2026-11-05', '2026-11-05T03:00:00.000Z')).toBe(false)
    expect(m('on:2026-11-04', '2026-11-05T03:00:00.000Z')).toBe(true)
    expect(dayOfValue(new Date('2026-11-05T03:00:00.000Z'))).toBe('2026-11-04')
    expect(dayOfValue('2026-11-05T03:00:00+00:00')).toBe('2026-11-04')
  })

  it('keeps a date-only value on its own day', () => {
    expect(dayOfValue('2026-11-05')).toBe('2026-11-05')
    // a SQL date column arrives as a Date at UTC midnight
    expect(dayOfValue(new Date('2026-11-05T00:00:00.000Z'))).toBe('2026-11-05')
    // a zone-less timestamp keeps its date part
    expect(dayOfValue('2026-11-05 22:00')).toBe('2026-11-05')
  })

  it('compares numbers through their display formatting', () => {
    expect(numberOfValue('$1,234.50')).toBe(1234.5)
    expect(m('num:gt:1000', '$1,234.50')).toBe(true)
    expect(m('num:lte:100', '$1,234.50')).toBe(false)
    expect(m('num:between:10..20', '15')).toBe(true)
    expect(m('num:eq:2026', '2026')).toBe(true)
  })

  it('compares booleans however they were stringified', () => {
    expect(m('bool:true', 'true')).toBe(true)
    expect(m('bool:false', 'false')).toBe(true)
    expect(m('bool:true', 'false')).toBe(false)
    expect(m('bool:true', true)).toBe(true)
  })

  it('never matches a value it cannot read as that type', () => {
    expect(m('on:2026-09-19', 'BLT')).toBe(false)
    expect(m('num:gt:1', 'BLT')).toBe(false)
    expect(m('bool:true', 'BLT')).toBe(false)
    expect(m('on:2026-09-19', null)).toBe(false)
  })

  it('leaves a plain text filter alone', () => {
    for (const raw of ['BLT', 'michiganave.dc', '', 'num:sideways:1', 'on:tuesday'])
      expect(parseColumnFilterOp(raw)).toBeNull()
  })
})
