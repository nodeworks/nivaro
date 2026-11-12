import { describe, expect, it } from 'vitest'
import {
  hasNaiveDate,
  localDay,
  localizeDateOps,
  localizeRawFilter,
  parseNaiveDate,
  wallTimeToUtc,
  zonedWallTime
} from '../../../services/ai-local-dates.js'

const NY = 'America/New_York'
const utc = (w: Parameters<typeof wallTimeToUtc>[0], zone = NY) =>
  wallTimeToUtc(w, zone).toISOString()
const day = (y: number, m: number, d: number) => ({ y, m, d, h: 0, mi: 0, s: 0, ms: 0 })

describe('wallTimeToUtc — a clock time in a zone, as the instant it is', () => {
  it('reads local midnight in winter and in summer (the offset moves)', () => {
    expect(utc(day(2026, 11, 9))).toBe('2026-11-09T05:00:00.000Z')
    expect(utc(day(2026, 7, 1))).toBe('2026-07-01T04:00:00.000Z')
  })

  it('lands on the right side of a clock change', () => {
    // 2026-11-01 02:00 EDT → 01:00 EST: the day after is on standard time.
    expect(utc(day(2026, 11, 1))).toBe('2026-11-01T04:00:00.000Z')
    expect(utc(day(2026, 11, 2))).toBe('2026-11-02T05:00:00.000Z')
  })

  it('carries a day past the end of a month', () => {
    expect(utc({ ...day(2026, 11, 30), d: 31 })).toBe('2026-12-01T05:00:00.000Z')
  })

  it('goes back the other way', () => {
    expect(zonedWallTime(new Date('2026-11-09T22:08:53Z'), NY)).toMatchObject({
      y: 2026,
      m: 11,
      d: 9,
      h: 17,
      mi: 8
    })
    expect(zonedWallTime(new Date('2026-11-10T01:00:00Z'), NY)).toMatchObject({ d: 9, h: 20 })
  })
})

describe('parseNaiveDate — only values written without a zone', () => {
  it('reads a date and a date-time', () => {
    expect(parseNaiveDate('2026-11-09')).toMatchObject({ y: 2026, m: 11, d: 9, precision: 'day' })
    expect(parseNaiveDate('2026-11-09T23:59:59')).toMatchObject({ h: 23, precision: 'second' })
    expect(parseNaiveDate('2026-11-09 08:30')).toMatchObject({ h: 8, mi: 30, precision: 'minute' })
  })

  it('leaves a value that names its own zone, and anything that is not a date', () => {
    expect(parseNaiveDate('2026-11-09T05:00:00Z')).toBeNull()
    expect(parseNaiveDate('2026-11-09T00:00:00-05:00')).toBeNull()
    expect(parseNaiveDate('TP26-81425')).toBeNull()
    expect(parseNaiveDate(20261109)).toBeNull()
    expect(parseNaiveDate('2026-13-40')).toBeNull()
  })
})

describe('localDay — the day the person is in', () => {
  it('is still the 9th at 8 PM Eastern, when UTC is already on the 10th', () => {
    expect(localDay(new Date('2026-11-10T01:00:00Z'), NY)).toEqual({
      today: '2026-11-09',
      tomorrow: '2026-11-10'
    })
  })
})

describe('localizeDateOps — "today" is the person’s day, not the UTC day', () => {
  // The filter Ask AI wrote on production at 6:27 PM Eastern for "created today".
  const asked = { _gte: '2026-11-09T00:00:00', _lte: '2026-11-09T23:59:59' }

  it('turns the day the model wrote into the Eastern day', () => {
    expect(localizeDateOps(asked, NY)).toEqual({
      _gte: '2026-11-09T05:00:00.000',
      _lt: '2026-11-10T05:00:00.000'
    })
  })

  it('keeps yesterday evening out and this evening in', () => {
    const { _gte, _lt } = localizeDateOps(asked, NY) as { _gte: string; _lt: string }
    const inDay = (iso: string) => iso >= _gte && iso < _lt
    // 10:30 PM Eastern on the 8th: the UTC day counted it as "today".
    expect(inDay('2026-11-09T03:30:00.000')).toBe(false)
    // 8:00 PM Eastern on the 9th: the UTC day left it out.
    expect(inDay('2026-11-10T01:00:00.000')).toBe(true)
  })

  it('reads a bare date as that whole local day', () => {
    expect(localizeDateOps({ _eq: '2026-11-09' }, NY)).toEqual({
      _gte: '2026-11-09T05:00:00.000',
      _lt: '2026-11-10T05:00:00.000'
    })
    expect(localizeDateOps({ _gte: '2026-11-09', _lte: '2026-11-09' }, NY)).toEqual({
      _gte: '2026-11-09T05:00:00.000',
      _lt: '2026-11-10T05:00:00.000'
    })
    // "after the 9th" starts with the 10th; "before the 9th" ends where it starts.
    expect(localizeDateOps({ _gt: '2026-11-09' }, NY)).toEqual({ _gte: '2026-11-10T05:00:00.000' })
    expect(localizeDateOps({ _lt: '2026-11-09' }, NY)).toEqual({ _lt: '2026-11-09T05:00:00.000' })
  })

  it('moves a clock time without widening it', () => {
    expect(localizeDateOps({ _gt: '2026-11-09T17:00:00' }, NY)).toEqual({
      _gt: '2026-11-09T22:00:00.000'
    })
    expect(localizeDateOps({ _lte: '2026-11-09T17:00:00.500' }, NY)).toEqual({
      _lte: '2026-11-09T22:00:00.500'
    })
  })

  it('leaves what it does not understand exactly as written', () => {
    const zoned = { _gte: '2026-11-09T05:00:00Z' }
    expect(localizeDateOps(zoned, NY)).toEqual(zoned)
    expect(localizeDateOps({ _eq: 'open' }, NY)).toEqual({ _eq: 'open' })
    expect(localizeDateOps({ _in: ['2026-11-09'] }, NY)).toEqual({ _in: ['2026-11-09'] })
    expect(localizeDateOps({ _null: true }, NY)).toEqual({ _null: true })
    // Two bounds that would land on the same operator: nothing is guessed.
    const clash = { _gt: '2026-11-08', _gte: '2026-11-09' }
    expect(localizeDateOps(clash, NY)).toEqual(clash)
  })
})

describe('localizeRawFilter — only columns that hold a moment in time', () => {
  // created = a timestamp (an instant); date_required = a calendar date kept as written.
  const isInstant = async (path: string[]) => path[path.length - 1] === 'created'

  it('converts timestamp columns and leaves calendar dates alone', async () => {
    const out = await localizeRawFilter(
      {
        created: { _gte: '2026-11-09T00:00:00', _lte: '2026-11-09T23:59:59' },
        date_required: { _gte: '2026-11-09' },
        is_on_hold: { _eq: false }
      },
      NY,
      isInstant
    )
    expect(out).toEqual({
      created: { _gte: '2026-11-09T05:00:00.000', _lt: '2026-11-10T05:00:00.000' },
      date_required: { _gte: '2026-11-09' },
      is_on_hold: { _eq: false }
    })
  })

  it('follows dotted keys, nested objects and the bare-value shorthand', async () => {
    const seen: string[] = []
    const spy = async (path: string[]) => {
      seen.push(path.join('.'))
      return isInstant(path)
    }
    const out = await localizeRawFilter(
      {
        'project.created': { _gte: '2026-11-09' },
        vendor: { created: { _lt: '2026-11-09' } },
        created: '2026-11-09',
        $state: { _in: ['started'] }
      },
      NY,
      spy
    )
    expect(out).toEqual({
      'project.created': { _gte: '2026-11-09T05:00:00.000' },
      vendor: { created: { _lt: '2026-11-09T05:00:00.000' } },
      created: { _gte: '2026-11-09T05:00:00.000', _lt: '2026-11-10T05:00:00.000' },
      $state: { _in: ['started'] }
    })
    expect(seen.sort()).toEqual(['created', 'project.created', 'vendor.created'])
  })

  it('asks nothing about a filter with no dates in it', async () => {
    const raw = { name: { _contains: 'fuse' }, amount: { _gt: 5 } }
    expect(hasNaiveDate(raw)).toBe(false)
    expect(hasNaiveDate({ created: { _gte: '2026-11-09' } })).toBe(true)
    let asked = 0
    const out = await localizeRawFilter(raw, NY, async () => {
      asked++
      return true
    })
    expect(out).toEqual(raw)
    expect(asked).toBe(0)
  })

  it('passes anything that is not a filter object straight through', async () => {
    expect(await localizeRawFilter(null, NY, isInstant)).toBeNull()
    expect(await localizeRawFilter('x', NY, isInstant)).toBe('x')
  })
})
