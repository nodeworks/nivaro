import { describe, expect, it } from 'vitest'
import { renderActivitySentence } from '../../../services/activity-sentence.js'
import {
  keepVisible,
  limitChangedFields,
  parseFeedFilter
} from '../../../services/command-center/activity.js'
import {
  type BriefInput,
  briefCacheKey,
  briefFacts
} from '../../../services/command-center/brief.js'
import { partnerRows, partnerStatus } from '../../../services/command-center/partners.js'
import {
  foldConfigMarkers,
  foldHours,
  previousLocalDay,
  startOfLocalDay,
  zonedParts
} from '../../../services/command-center/throughput.js'

const NY = 'America/New_York'
const T = (iso: string) => Date.parse(iso)

describe('command center — the person’s day (UTC timestamps, America/New_York day)', () => {
  it('reads wall-clock parts in the zone, not in UTC', () => {
    // 03:30 UTC on Oct 30 is 11:30 PM on Oct 29 in New York (EDT, UTC-4).
    expect(zonedParts(T('2026-10-30T03:30:00Z'), NY)).toMatchObject({
      y: 2026,
      m: 10,
      d: 29,
      h: 23
    })
    expect(zonedParts(T('2026-10-30T04:00:00Z'), NY)).toMatchObject({ d: 30, h: 0 })
  })

  it('local midnight is 04:00 UTC in EDT and 05:00 UTC in EST', () => {
    expect(new Date(startOfLocalDay(T('2026-10-30T15:00:00Z'), NY)).toISOString()).toBe(
      '2026-10-30T04:00:00.000Z'
    )
    expect(new Date(startOfLocalDay(T('2026-11-03T15:00:00Z'), NY)).toISOString()).toBe(
      '2026-11-03T05:00:00.000Z'
    )
    // Just after UTC midnight it is still the previous local day.
    expect(new Date(startOfLocalDay(T('2026-10-30T01:00:00Z'), NY)).toISOString()).toBe(
      '2026-10-29T04:00:00.000Z'
    )
  })

  it('steps back over the fall-back day (25 local hours)', () => {
    const nov2 = startOfLocalDay(T('2026-11-02T15:00:00Z'), NY)
    expect(new Date(nov2).toISOString()).toBe('2026-11-02T05:00:00.000Z')
    expect(new Date(previousLocalDay(nov2, NY)).toISOString()).toBe('2026-11-01T04:00:00.000Z')
  })
})

describe('command center — hourly bucketing', () => {
  const cut = T('2026-10-30T18:20:00Z') // 2:20 PM EDT
  it('splits today and yesterday at New York midnight, not UTC midnight', () => {
    const r = foldHours(
      [
        { at: T('2026-10-30T02:00:00Z'), n: 3 }, // 10 PM Oct 29 local → yesterday hour 22
        { at: T('2026-10-30T04:00:00Z'), n: 5 }, // midnight local → today hour 0
        { at: T('2026-10-30T17:00:00Z'), n: 7 } // 1 PM local → today hour 13
      ],
      cut,
      NY
    )
    expect(r.hours[22].yesterday).toBe(3)
    expect(r.hours[22].today).toBeNull() // later than now
    expect(r.hours[0].today).toBe(5)
    expect(r.hours[13].today).toBe(7)
    expect(r.today_total).toBe(12)
    expect(r.hours).toHaveLength(24)
  })

  it('hours after the cut are null, the cut hour counts', () => {
    const r = foldHours([{ at: T('2026-10-30T18:00:00Z'), n: 2 }], cut, NY)
    expect(r.hours[14].today).toBe(2)
    expect(r.hours[15].today).toBeNull()
  })

  it('avg7 = the seven local days before today, per hour, over 7', () => {
    const buckets = []
    for (let d = 1; d <= 7; d++)
      buckets.push({ at: T('2026-10-30T13:00:00Z') - d * 86_400_000, n: 7 }) // 9 AM local each day
    buckets.push({ at: T('2026-10-30T13:00:00Z') - 8 * 86_400_000, n: 700 }) // outside the week
    const r = foldHours(buckets, cut, NY)
    expect(r.hours[9].avg7).toBe(7)
    expect(r.hours[9].yesterday).toBe(7)
  })

  it('yesterday by this time stops at the same wall-clock point', () => {
    const r = foldHours(
      [
        { at: T('2026-10-29T17:00:00Z'), n: 4 }, // yesterday 1 PM — before 2:20 PM
        { at: T('2026-10-29T19:00:00Z'), n: 9 } // yesterday 3 PM — after
      ],
      cut,
      NY,
      0
    )
    expect(r.yesterday_same_time).toBe(4)
    // the exact partial-hour count is added on top of the whole hours before it
    expect(
      foldHours([{ at: T('2026-10-29T17:00:00Z'), n: 4 }], cut, NY, 2).yesterday_same_time
    ).toBe(6)
  })

  it('rewind: buckets at or after the rewound instant are not counted', () => {
    const at = T('2026-10-30T15:00:00Z') // 11 AM local
    const r = foldHours(
      [
        { at: T('2026-10-30T14:00:00Z'), n: 1 },
        { at: T('2026-10-30T15:00:00Z'), n: 50 },
        { at: T('2026-10-30T17:00:00Z'), n: 50 }
      ],
      at,
      NY
    )
    expect(r.today_total).toBe(1)
    expect(r.hours[11].today).toBe(0)
    expect(r.hours[12].today).toBeNull()
  })

  it('a different zone gives a different day for the same UTC instants', () => {
    const b = [{ at: T('2026-10-30T02:00:00Z'), n: 3 }]
    expect(foldHours(b, cut, 'UTC').hours[2].today).toBe(3)
    expect(foldHours(b, cut, NY).hours[22].yesterday).toBe(3)
  })
})

describe('command center — feed visibility', () => {
  const rows = [
    { id: 1, action: 'update', collection: 'orders', item: '10' },
    { id: 2, action: 'update', collection: 'payroll', item: '11' }, // unreadable collection
    { id: 3, action: 'update', collection: 'orders', item: '12' }, // hidden record
    { id: 4, action: 'delete', collection: 'orders', item: '13' }, // deleted record
    { id: 5, action: 'update', collection: 'nivaro_fields', item: '1' }
  ]
  const labels = { records: { 'orders:10': 'Order 10', 'orders:12': null, 'orders:13': null } }

  it('keeps only readable collections and visible records; a delete loses its link', () => {
    const kept = keepVisible(rows, new Set(['orders', 'nivaro_fields']), labels)
    expect(kept.map((r) => r.id)).toEqual([1, 4])
    expect(kept[1].item).toBeNull()
  })

  it('drops changed fields the reader may not read', () => {
    const r = limitChangedFields(
      { delta: { status: 'a', salary: 9 }, changed_fields: ['status', 'salary'] },
      ['status']
    )
    expect(r.delta).toEqual({ status: 'a' })
    expect(r.changed_fields).toEqual(['status'])
    expect(limitChangedFields({ delta: { x: 1 } }, null).delta).toEqual({ x: 1 })
  })

  it('maps entries to readable sentences', () => {
    expect(
      renderActivitySentence(
        {
          action: 'create',
          user: 'aaaaaaaa-0000-0000-0000-000000000001',
          collection: 'orders',
          item: '10',
          first_name: 'Pat',
          last_name: 'Lee'
        },
        {
          records: { 'orders:10': 'Order 10' },
          collections: { orders: { singular: 'Order', plural: 'Orders' } }
        }
      )
    ).toMatch(/^Pat Lee created Order 10/)
    expect(
      renderActivitySentence(
        { action: 'update', collection: 'orders', item: '12', first_name: 'Pat' },
        { records: { 'orders:12': null } }
      )
    ).toContain("a record you can't see")
  })

  it('parses the filter chips', () => {
    expect(parseFeedFilter('records')).toBe('records')
    expect(parseFeedFilter('transitions')).toBe('transitions')
    expect(parseFeedFilter('team')).toBe('team')
    expect(parseFeedFilter('drop table')).toBe('all')
  })
})

describe('command center — brief', () => {
  const base: BriefInput = {
    throughput: null,
    feed: [],
    partners: [],
    system: null,
    maintenance: false,
    incident: null,
    hour: 14,
    rewound: false
  }

  it('never includes unreadable data: built only from the visible feed, counts + collection names', () => {
    const raw = [
      { id: 1, action: 'create', collection: 'orders', item: '10', label: 'Orders' },
      { id: 2, action: 'update', collection: 'payroll', item: '11', label: 'Payroll' },
      { id: 3, action: 'update', collection: 'orders', item: '12', label: 'Orders' }
    ]
    const kept = keepVisible(raw, new Set(['orders']), {
      records: { 'orders:10': 'Order 10 for ACME', 'orders:12': null }
    })
    const feed = kept.map((r) => ({
      id: r.id,
      action: r.action,
      collection: r.collection,
      collection_label: r.label,
      item: r.item,
      comment: 'secret note',
      timestamp: '2026-10-30T18:00:00Z',
      user_name: 'Pat',
      sentence: 'Pat created Order 10 for ACME'
    }))
    const text = briefFacts({ ...base, feed }).join(' ')
    expect(text).toContain('1 created')
    expect(text).toContain('Orders (1)')
    expect(text).not.toMatch(/Payroll|ACME|secret|Order 10|Pat/)
    expect(text).not.toContain('updated')
  })

  it('names partners and system issues only when given (administrators)', () => {
    const text = briefFacts({
      ...base,
      partners: [
        {
          key: '1',
          label: 'Fusion',
          status: 'down',
          open_problems: 2,
          last_ok_at: null,
          href: null
        },
        { key: '2', label: 'Okay Co', status: 'ok', open_problems: 0, last_ok_at: null, href: null }
      ],
      system: {
        db_ok: true,
        redis_ok: false,
        errors_1h: 0,
        requests_1h: 10,
        jobs_running: 0,
        jobs_failed_1h: 1,
        runtime: { rss_mb: 1, event_loop_lag_ms: { max_1m: 1 } },
        instances: 1
      }
    }).join(' ')
    expect(text).toContain('Fusion (failing)')
    expect(text).not.toContain('Okay Co')
    expect(text).toContain('Redis is not answering')
    expect(text).toContain('1 background job failed')
  })

  it('compares this hour with the usual', () => {
    const hours = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      today: hour === 14 ? 30 : 0,
      yesterday: 0,
      avg7: hour === 14 ? 10 : 0
    }))
    const text = briefFacts({
      ...base,
      throughput: { hours, today_total: 30, yesterday_same_time: 20 }
    }).join(' ')
    expect(text).toContain('30 transitions so far this hour, busier than usual')
    expect(text).toContain('10 more than yesterday')
  })

  it('caches per person, region and hour', () => {
    const now = T('2026-10-30T18:20:00Z')
    const a = briefCacheKey('u1', { region: null, at: null }, now)
    expect(briefCacheKey('u1', { region: null, at: null }, now + 60_000)).toBe(a)
    expect(briefCacheKey('u2', { region: null, at: null }, now)).not.toBe(a)
    expect(briefCacheKey('u1', { region: '4', at: null }, now)).not.toBe(a)
    expect(briefCacheKey('u1', { region: null, at: null }, now + 3600_000)).not.toBe(a)
  })
})

describe('command center — markers and partners', () => {
  it('folds config writes within ten minutes into one marker', () => {
    const m = foldConfigMarkers([
      { collection: 'nivaro_fields', timestamp: '2026-10-30T14:00:00Z' },
      { collection: 'nivaro_fields', timestamp: '2026-10-30T14:05:00Z' },
      { collection: 'nivaro_collection_layouts', timestamp: '2026-10-30T14:08:00Z' },
      { collection: 'nivaro_flows', timestamp: '2026-10-30T15:00:00Z' }
    ])
    expect(m).toHaveLength(2)
    expect(m[0].label).toBe('3 configuration changes (fields, collection layouts)')
    expect(m[1].label).toBe('Configuration change (flows)')
  })

  it('maps console health to strip status, worst first, enabled only', () => {
    expect(partnerStatus('idle')).toBe('unknown')
    const rows = partnerRows(
      [
        { id: 1, name: 'A', enabled: true, health: 'healthy', last_ok_at: null },
        { id: 2, name: 'B', enabled: true, health: 'failing', last_ok_at: null },
        { id: 3, name: 'C', enabled: false, health: 'failing', last_ok_at: null }
      ],
      new Map([['b', 3]])
    )
    expect(rows.map((r) => [r.label, r.status, r.open_problems])).toEqual([
      ['B', 'down', 3],
      ['A', 'ok', 0]
    ])
  })
})
