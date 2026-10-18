import { describe, expect, it } from 'vitest'
import { barGeometry } from '@/components/traffic-map-thumb'
import { costLine, type Overhead, samplingLine } from './map-settings'
import { nearestTo } from './snapshot-compare'

const overhead = (over: Partial<Overhead['sampling']> = {}, cpu = 0.4): Overhead => ({
  window_s: 60,
  req_per_s: 40,
  cpu_ms_per_s: cpu * 10,
  cpu_pct: cpu,
  record_us_per_req: 12,
  frame_ms: 0.3,
  frames_per_s: 1,
  socket_bytes_per_s: 2048,
  redis_bytes_per_s: 0,
  events_seen_per_s: 30,
  events_sampled_per_s: 0,
  sampling: { on: false, every: 1, threshold_rps: 300, rps: 40, since: null, ...over },
  memory: {
    entities: 3,
    callers: 2,
    downs: 1,
    bytes: 3 * 1024 * 1024,
    process_rss: 1,
    process_heap_used: 1
  },
  watchers: 1
})

describe('map cost wording', () => {
  it('says the CPU share and memory in plain words', () => {
    expect(costLine(overhead())).toBe('0.4% of one core, 3.0 MB of memory')
    expect(costLine(overhead({}, 0.01))).toContain('under 0.1%')
  })
  it('says whether the ticker is thinned and why', () => {
    expect(samplingLine(overhead())).toContain('shows every event')
    expect(samplingLine(overhead({ threshold_rps: 0 }))).toContain('sampling is off')
    expect(samplingLine(overhead({ on: true, every: 4, rps: 1200, threshold_rps: 300 }))).toBe(
      'Ticker thinned to 1 event in 4 (1200 req/s is over 300)'
    )
  })
})

describe('snapshot compare helpers', () => {
  const row = (id: string, iso: string) =>
    ({ id, name: id, kind: 'manual', window_s: 60, created_at: iso }) as never
  it('finds the snapshot closest to a week earlier, never the one it is compared against', () => {
    const rows = [
      row('now', '2026-10-17T10:00:00Z'),
      row('wk', '2026-10-10T11:00:00Z'),
      row('far', '2026-09-01T10:00:00Z')
    ]
    const target = Date.parse('2026-10-17T10:00:00Z') - 7 * 86_400_000
    expect(nearestTo(rows, target, 36 * 3_600_000, 'now')?.id).toBe('wk')
    expect(nearestTo([rows[0], rows[2]], target, 36 * 3_600_000, 'now')).toBeNull()
  })
})

describe('timeline thumbnail bars', () => {
  it('scales to the busiest node and shows the error share', () => {
    const g = barGeometry([
      { req: 100, error: 0 },
      { req: 50, error: 25 },
      { req: 0, error: 0 }
    ])
    expect(g[0].h).toBeGreaterThan(g[1].h)
    expect(g[0].errH).toBe(0)
    expect(g[1].errH).toBe(Math.round(g[1].h / 2))
    expect(g[2].h).toBe(2) // an empty node still draws a hairline
  })
})
