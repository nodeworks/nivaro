import { describe, expect, it } from 'vitest'
import { miniMapSummary } from './TrafficMiniMap'

const ent = (key: string, req: number, series: number[], error = 0) => ({
  key,
  lane: key.slice(0, key.indexOf('/')),
  label: key.slice(key.indexOf('/') + 1),
  req,
  error,
  series
})

describe('miniMapSummary (#1130)', () => {
  it('per-minute rate, error share, lane sparklines and the busiest entities', () => {
    const s = miniMapSummary({
      window_s: 300,
      entities: [
        ent('items/workflows', 200, [1, 2, 3], 4),
        ent('items/forecasts', 100, [1, 1, 1]),
        ent('graphql/Q', 50, [0, 5, 0]),
        ent('items/__other__', 900, [9, 9, 9]),
        ent('pages/home', 0, [0, 0, 0])
      ],
      totals: { req: 1250, error: 25, p95: 480 }
    })
    expect(s.rpm).toBe(250)
    expect(s.errPct).toBe(2)
    expect(s.lanes.map((l) => [l.label, l.req])).toEqual([
      ['Collections', 1200],
      ['GraphQL', 50]
    ])
    expect(s.lanes[0].series).toEqual([11, 12, 13])
    expect(s.top.map((e) => e.label)).toEqual(['workflows', 'forecasts', 'Q'])
  })
  it('an idle window', () => {
    const s = miniMapSummary({ window_s: 60, entities: [], totals: { req: 0, error: 0, p95: 0 } })
    expect(s).toMatchObject({ rpm: 0, errPct: 0, lanes: [], top: [] })
  })
})
