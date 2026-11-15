import { describe, expect, it } from 'vitest'
import {
  buildWidgetImageLabel,
  describeDateRangeFilter,
  describeEntityFilters,
  describeGlobalFilters,
  describeWidgetOwnFilter,
  describeWidgetRules,
  formatAsOf,
  widgetImageFileName,
  widgetImageSubtitleLines
} from './widget-image'

describe('formatAsOf', () => {
  it('reads in 12-hour local time', () => {
    const when = new Date(2026, 10, 14, 21, 45)
    expect(formatAsOf(when)).toBe('As of Nov 14, 2026, 9:45 PM')
  })
  it('noon and midnight are 12, not 0', () => {
    expect(formatAsOf(new Date(2026, 10, 14, 0, 5))).toBe('As of Nov 14, 2026, 12:05 AM')
    expect(formatAsOf(new Date(2026, 10, 14, 12, 0))).toBe('As of Nov 14, 2026, 12:00 PM')
  })
  it('says nothing for a bad date', () => {
    expect(formatAsOf('nope')).toBe('')
  })
})

describe('describeDateRangeFilter', () => {
  it('names presets', () => {
    expect(describeDateRangeFilter({ preset: 'last_30_days' })).toBe('Dates: last 30 days')
    expect(describeDateRangeFilter({ preset: 'ytd' })).toBe('Dates: year to date')
  })
  it('custom ranges show both ends', () => {
    expect(
      describeDateRangeFilter({ preset: 'custom', start: '2026-01-01', end: '2026-03-31' })
    ).toBe('Dates: 2026-01-01 to 2026-03-31')
    expect(describeDateRangeFilter({ preset: 'custom', start: '2026-01-01' })).toBe(
      'Dates: from 2026-01-01'
    )
  })
  it('none → null', () => {
    expect(describeDateRangeFilter(null)).toBeNull()
    expect(describeDateRangeFilter({ preset: 'custom' })).toBeNull()
  })
})

describe('describeEntityFilters', () => {
  it('uses the display labels, not the stored values', () => {
    expect(
      describeEntityFilters([{ field: 'zone', values: ['E', 'W'], labels: ['East', 'West'] }])
    ).toEqual(['Zone is East or West'])
  })
  it('skips empty filters', () => {
    expect(describeEntityFilters([{ field: 'zone', values: [] }])).toEqual([])
  })
})

describe('describeGlobalFilters', () => {
  it('equals and contains', () => {
    expect(
      describeGlobalFilters([
        { field: 'status', op: 'eq', value: 'open' },
        { field: 'vendor_name', op: 'contains', value: 'acme' }
      ])
    ).toEqual(['Status is open', 'Vendor Name contains “acme”'])
  })
  it('blank values are not filters', () => {
    expect(describeGlobalFilters([{ field: 'status', op: 'eq', value: '' }])).toEqual([])
  })
})

describe('describeWidgetOwnFilter', () => {
  it('reads an items filter object, or its JSON text', () => {
    expect(describeWidgetOwnFilter({ status: { _neq: 'cancelled' } })).toEqual([
      'Status is not cancelled (or is empty)'
    ])
    expect(describeWidgetOwnFilter('{"zone":"E"}')).toEqual(['Zone is E'])
  })
  it('never prints JSON for what it cannot say', () => {
    expect(describeWidgetOwnFilter({ x: { _weird: 1 } })).toEqual([
      'A custom filter on this widget'
    ])
  })
  it('nothing or junk → nothing', () => {
    expect(describeWidgetOwnFilter(null)).toEqual([])
    expect(describeWidgetOwnFilter('')).toEqual([])
    expect(describeWidgetOwnFilter('{not json')).toEqual([])
    expect(describeWidgetOwnFilter({})).toEqual([])
  })
})

describe('describeWidgetRules', () => {
  it('one sentence per rule, capitalised', () => {
    expect(
      describeWidgetRules([
        { field: 'status', op: 'neq', value: 'cancelled' },
        { field: 'amount', op: 'gte', value: 100 }
      ])
    ).toEqual(['Status is not cancelled (or is empty)', 'Amount is at least 100'])
  })
  it('a rule it cannot say becomes one custom-filter line', () => {
    expect(
      describeWidgetRules([
        { field: 'a', op: 'weird', value: 1 },
        { field: 'b', op: 'weird', value: 2 }
      ])
    ).toEqual(['A custom filter on this widget'])
  })
})

describe('buildWidgetImageLabel', () => {
  it('title, as-of, then every filter once, in order', () => {
    const label = buildWidgetImageLabel({
      title: ' Open orders ',
      asOf: new Date(2026, 10, 14, 9, 5),
      dateRange: { preset: 'this_month' },
      dashboardFilters: [{ field: 'zone', op: 'eq', value: 'East' }],
      entityFilters: [{ field: 'region', values: [7], labels: ['North'] }],
      widgetFilter: { status: 'open' },
      extra: ['Zone is East']
    })
    expect(label.title).toBe('Open orders')
    expect(label.asOf).toBe('As of Nov 14, 2026, 9:05 AM')
    expect(label.filters).toEqual([
      'Dates: this month',
      'Zone is East',
      'Region is North',
      'Status is open'
    ])
  })
  it('no filters says so', () => {
    const label = buildWidgetImageLabel({ title: 'Spend', asOf: new Date(2026, 0, 2, 13, 0) })
    expect(label.filters).toEqual([])
    expect(widgetImageSubtitleLines(label)).toEqual(['As of Jan 2, 2026, 1:00 PM', 'No filters'])
  })
  it('an untitled widget still gets a name', () => {
    expect(buildWidgetImageLabel({ title: '  ' }).title).toBe('Figure')
  })
  it('subtitle joins the filters', () => {
    const label = buildWidgetImageLabel({
      title: 'A',
      asOf: new Date(2026, 0, 2, 13, 0),
      extra: ['One', 'Two']
    })
    expect(widgetImageSubtitleLines(label)[1]).toBe('Filters: One · Two')
  })
})

describe('widgetImageFileName', () => {
  it('is a safe png name with the time in it', () => {
    expect(widgetImageFileName('Open orders / East?', new Date(2026, 10, 14, 21, 45))).toBe(
      'Open-orders-East-2026-11-14-2145.png'
    )
  })
  it('an empty title still names the file', () => {
    expect(widgetImageFileName('', new Date(2026, 0, 2, 3, 4))).toBe('figure-2026-01-02-0304.png')
  })
})
