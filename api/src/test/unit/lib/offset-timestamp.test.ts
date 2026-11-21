import { describe, expect, it } from 'vitest'
import { fitOffsetTimestamps, utcFromOffsetTimestamp } from '../../../lib/offset-timestamp.js'

describe('utcFromOffsetTimestamp', () => {
  it('turns an offset timestamp into its UTC instant', () => {
    expect(utcFromOffsetTimestamp('2026-11-20T10:00:00+02:00')).toBe('2026-11-20T08:00:00Z')
    expect(utcFromOffsetTimestamp('2026-11-20T23:30:00-05:00')).toBe('2026-11-21T04:30:00Z')
    expect(utcFromOffsetTimestamp('2026-11-20T01:00:00-0500')).toBe('2026-11-20T06:00:00Z')
    expect(utcFromOffsetTimestamp('2026-11-20T10:00+05:30')).toBe('2026-11-20T04:30:00Z')
    expect(utcFromOffsetTimestamp('2026-11-20 10:00:00.1234567+01')).toBe(
      '2026-11-20T09:00:00.1234567Z'
    )
  })

  it('leaves every other value exactly as given', () => {
    for (const v of [
      '2026-11-20T10:00:00Z',
      '2026-11-20T10:00:00.000Z',
      '2026-11-20T10:00:00',
      '2026-11-20',
      'meeting at 10:00+02:00',
      '2026-02-30T10:00:00+02:00',
      '2026-11-20T10:00:00+25:00',
      12,
      null
    ])
      expect(utcFromOffsetTimestamp(v)).toBe(v)
  })
})

describe('fitOffsetTimestamps', () => {
  const shapes = new Map<string, { type: string }>([
    ['seen_at', { type: 'datetime2' }],
    ['legacy_at', { type: 'datetime' }],
    ['zoned_at', { type: 'datetimeoffset' }],
    ['due', { type: 'date' }],
    ['note', { type: 'nvarchar' }]
  ])

  it('converts only values bound for a column that keeps no offset', () => {
    const v = '2026-11-20T10:00:00+02:00'
    const payload: Record<string, unknown> = {
      seen_at: v,
      Legacy_At: v,
      zoned_at: v,
      due: v,
      note: v,
      unknown: v
    }
    fitOffsetTimestamps(payload, shapes)
    expect(payload).toEqual({
      seen_at: '2026-11-20T08:00:00Z',
      Legacy_At: '2026-11-20T08:00:00Z',
      zoned_at: v,
      due: v,
      note: v,
      unknown: v
    })
  })
})
