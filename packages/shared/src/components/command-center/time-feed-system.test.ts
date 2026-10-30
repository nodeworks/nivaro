import { describe, expect, it } from 'vitest'
import { sparkPointTime, spikeIndex } from '../monitoring/TrafficMiniMap'
import { bannerLines } from './panels/Banner'
import { newSince, pulseMatters } from './panels/FeedPanel'
import { systemIssues } from './panels/SystemPanel'
import { hourOfDay, niceMax, throughputSummary } from './panels/ThroughputPanel'
import { clampRewind, rewindDays } from './panels/TimeBar'
import { commandCenterUrl, trafficMapUrl } from './time'
import type { FeedEntry, SystemHealth, ThroughputSeries } from './types'

process.env.TZ = 'America/New_York'

const healthy: SystemHealth = {
  db_ok: true,
  redis_ok: true,
  errors_1h: 0,
  requests_1h: 5000,
  jobs_running: 1,
  jobs_failed_1h: 0,
  runtime: { rss_mb: 400, event_loop_lag_ms: { max_1m: 20 } },
  instances: 2
}

describe('system pill issue rules', () => {
  it('a healthy system has no issues', () => {
    expect(systemIssues(healthy)).toEqual([])
  })
  it('database / Redis down are critical, listed first', () => {
    const i = systemIssues({ ...healthy, db_ok: false, redis_ok: false, jobs_failed_1h: 2 })
    expect(i.map((x) => [x.key, x.severity])).toEqual([
      ['db', 'critical'],
      ['redis', 'critical'],
      ['jobs', 'warning']
    ])
  })
  it('errors need both a count and a share — or a large count', () => {
    expect(systemIssues({ ...healthy, errors_1h: 9, requests_1h: 100 })).toEqual([])
    expect(systemIssues({ ...healthy, errors_1h: 20, requests_1h: 100_000 })).toEqual([])
    expect(systemIssues({ ...healthy, errors_1h: 20, requests_1h: 1000 })[0].key).toBe('errors')
    expect(systemIssues({ ...healthy, errors_1h: 50, requests_1h: 10_000_000 })[0].key).toBe(
      'errors'
    )
  })
  it('loop lag past the line is an issue', () => {
    const i = systemIssues({
      ...healthy,
      runtime: { rss_mb: 1, event_loop_lag_ms: { max_1m: 900 } }
    })
    expect(i[0].key).toBe('lag')
    expect(i[0].text).toContain('900 ms')
  })
})

describe('feed', () => {
  it('only feed actions on business collections nudge a refetch', () => {
    expect(pulseMatters({ action: 'update', collection: 'orders' }, 'all')).toBe(true)
    expect(pulseMatters({ action: 'read', collection: 'orders' }, 'all')).toBe(false)
    expect(pulseMatters({ action: 'update', collection: 'nivaro_fields' }, 'all')).toBe(false)
    expect(pulseMatters({ action: 'pipeline-transition', collection: 'orders' }, 'records')).toBe(
      false
    )
    expect(
      pulseMatters({ action: 'pipeline-transition', collection: 'orders' }, 'transitions')
    ).toBe(true)
  })
  it('counts entries that arrived while paused', () => {
    const e = (id: number) => ({ id }) as FeedEntry
    expect(newSince([e(5), e(4)], [e(7), e(6), e(5), e(4)])).toBe(2)
    expect(newSince([e(5)], [e(5)])).toBe(0)
  })
})

describe('rewind cursor', () => {
  const now = Date.parse('2026-10-30T18:20:00Z') // 2:20 PM in New York
  it('offers today and seven days back, local midnights', () => {
    const days = rewindDays(now)
    expect(days).toHaveLength(8)
    expect(new Date(days[0]).toISOString()).toBe('2026-10-30T04:00:00.000Z')
    expect(new Date(days[7]).toISOString()).toBe('2026-10-23T04:00:00.000Z')
  })
  it('clamps to the day and never past now, on a 5-minute grid', () => {
    const today = rewindDays(now)[0]
    expect(clampRewind(now + 3600_000, today, now)).toBeLessThan(now)
    expect(clampRewind(today - 1, today, now)).toBe(today)
    expect(clampRewind(Date.parse('2026-10-30T15:07:00Z'), today, now)).toBe(
      Date.parse('2026-10-30T15:05:00Z')
    )
  })
})

describe('throughput chart helpers', () => {
  it('places markers by the series time zone', () => {
    expect(hourOfDay('2026-10-30T18:30:00Z', 'America/New_York')).toBe(14.5)
    expect(hourOfDay('2026-10-30T18:30:00Z', 'UTC')).toBe(18.5)
  })
  it('rounds the axis top', () => {
    expect(niceMax(3)).toBe(4)
    expect(niceMax(37)).toBe(50)
    expect(niceMax(120)).toBe(200)
  })
  it('summarises in one sentence', () => {
    const s: ThroughputSeries = {
      hours: Array.from({ length: 24 }, (_, hour) => ({
        hour,
        today: hour > 14 ? null : hour === 10 ? 31 : 1,
        yesterday: 1,
        avg7: 1
      })),
      markers: [],
      today_total: 45,
      yesterday_same_time: 40
    }
    expect(throughputSummary(s)).toBe(
      '45 transitions today by 2 PM, 5 more than yesterday by this time, busiest hour 10 AM (31).'
    )
  })
})

describe('traffic mini map pick', () => {
  it('maps a sparkline point to its minute', () => {
    const end = Date.parse('2026-10-30T18:20:30Z')
    // 300 s window, 60 points: point 59 is the last 5 s
    expect(new Date(sparkPointTime(59, 60, 300, end)).toISOString()).toBe(
      '2026-10-30T18:20:00.000Z'
    )
    expect(new Date(sparkPointTime(0, 60, 300, end)).toISOString()).toBe('2026-10-30T18:15:00.000Z')
  })
  it('finds the spike (latest on ties)', () => {
    expect(spikeIndex([1, 5, 2, 5, 0])).toBe(3)
  })
})

describe('two-way links', () => {
  it('Command Center → Traffic Map node', () => {
    expect(trafficMapUrl('orders')).toBe('/traffic-map?sel=entity%3Aitems%2Forders')
    expect(trafficMapUrl('nivaro_fields')).toBeNull()
    expect(trafficMapUrl('a b')).toBeNull()
  })
  it('board URL parameters', () => {
    expect(
      commandCenterUrl({
        map: 'orders',
        region: '4',
        at: Date.parse('2026-10-30T18:10:00Z'),
        peek: { collection: 'orders', id: '9' }
      })
    ).toBe('/command?region=4&at=2026-10-30T18%3A10%3A00.000Z&map=orders&peek=orders%3A9')
  })
})

describe('board banner', () => {
  it('lists incident, maintenance and drill, most serious first', () => {
    const lines = bannerLines(
      {
        maintenance: { on: true, message: 'Upgrading.', until: null },
        incident: {
          title: 'Fusion pushes failing',
          started_at: '2026-10-30T17:00:00Z',
          href: '/ops-console'
        }
      },
      [
        {
          label: 'Slow database',
          target: 'everything',
          ends_at: Date.parse('2026-10-30T19:00:00Z')
        }
      ]
    )
    expect(lines.map((l) => l.key)).toEqual(['incident', 'maintenance', 'drill'])
    expect(lines[1].text).toContain('saving changes is paused')
    expect(lines[2].text).toContain('Slow database on everything')
  })
  it('says nothing in the normal state', () => {
    expect(bannerLines({ maintenance: null, incident: null }, [])).toEqual([])
    expect(bannerLines(undefined, [])).toEqual([])
  })
})
