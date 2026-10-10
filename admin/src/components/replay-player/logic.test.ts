import { describe, expect, it } from 'vitest'
import {
  fmtClock,
  groupTip,
  markerTone,
  RAIL_COLORS,
  type RailItem,
  railMarkers,
  thinMarkers
} from './logic'

const FIRST = Date.parse('2026-10-01T12:00:00.000Z')
const at = (ms: number) => new Date(FIRST + ms).toISOString()

describe('fmtClock', () => {
  it('reads m:ss', () => {
    expect(fmtClock(0)).toBe('0:00')
    expect(fmtClock(65_400)).toBe('1:05')
    expect(fmtClock(-3)).toBe('0:00')
  })
})

describe('railMarkers', () => {
  it('turns timestamps into offsets, clamps the slack and drops the far outside', () => {
    const items: RailItem[] = [
      { kind: 'request', at: at(30_000), label: 'b', status: 200 },
      { kind: 'route', at: at(-3_000), label: 'a' },
      { kind: 'error', at: at(-60_000), label: 'too early' },
      { kind: 'transition', at: at(64_000), label: 'edge' },
      { kind: 'request', at: at(200_000), label: 'too late', status: 200 },
      { kind: 'route', at: 'nonsense', label: 'bad' }
    ]
    const m = railMarkers(items, FIRST, 60_000)
    expect(m.map((x) => [x.label, x.offset])).toEqual([
      ['a', 0],
      ['b', 30_000],
      ['edge', 60_000]
    ])
  })

  it('is empty before the length is known', () => {
    expect(railMarkers([{ kind: 'route', at: at(1), label: 'x' }], FIRST, 0)).toEqual([])
  })
})

describe('markerTone', () => {
  it('colours requests by status, other kinds by kind', () => {
    expect(markerTone({ kind: 'request', status: 204 }).color).toBe(RAIL_COLORS.ok)
    expect(markerTone({ kind: 'request', status: 302 }).color).toBe(RAIL_COLORS.ok)
    expect(markerTone({ kind: 'request', status: 404 }).color).toBe(RAIL_COLORS.clientError)
    expect(markerTone({ kind: 'request', status: 502 }).color).toBe(RAIL_COLORS.serverError)
    expect(markerTone({ kind: 'error' }).color).toBe(RAIL_COLORS.error)
    expect(markerTone({ kind: 'route' }).color).toBe(RAIL_COLORS.route)
    expect(markerTone({ kind: 'transition' }).color).toBe(RAIL_COLORS.transition)
  })
})

describe('thinMarkers', () => {
  it('merges markers that share a pixel bucket; the worst one colours the group', () => {
    const total = 100_000
    const items: RailItem[] = [
      ...Array.from({ length: 500 }, (_, i) => ({
        kind: 'request' as const,
        at: at(i * 10), // all inside the first 5 s
        label: `GET /x/${i}`,
        status: i === 250 ? 500 : 200
      })),
      { kind: 'route', at: at(90_000), label: '/far' }
    ]
    const groups = thinMarkers(railMarkers(items, FIRST, total), total, 600)
    // 600 px / 6 px buckets = 100 slots of 1 s each: the burst spans 5 slots.
    expect(groups.length).toBe(6)
    expect(groups.reduce((n, g) => n + g.markers.length, 0)).toBe(501)
    const withError = groups.find((g) => g.markers.some((m) => m.status === 500))
    expect(withError?.color).toBe(RAIL_COLORS.serverError)
    expect(groups[0].offset).toBe(0)
    expect(groups[groups.length - 1]).toMatchObject({ left: 0.9, color: RAIL_COLORS.route })
  })

  it('keeps separate markers apart on a wide rail', () => {
    const total = 10_000
    const m = railMarkers(
      [
        { kind: 'route', at: at(1_000), label: 'a' },
        { kind: 'route', at: at(5_000), label: 'b' }
      ],
      FIRST,
      total
    )
    expect(thinMarkers(m, total, 800)).toHaveLength(2)
  })
})

describe('groupTip', () => {
  it('a single marker reads as itself; a cluster summarises and lists the first few', () => {
    const total = 10_000
    const m = railMarkers(
      [
        { kind: 'request', at: at(1_000), label: 'GET /a → 200', status: 200 },
        { kind: 'request', at: at(1_001), label: 'GET /b → 404', status: 404 },
        { kind: 'error', at: at(1_002), label: 'boom' }
      ],
      FIRST,
      total
    )
    const [g] = thinMarkers(m, total, 100)
    expect(groupTip(g, 2)).toBe(
      '0:01 · 2 requests, 1 error\n0:01 GET /a → 200\n0:01 GET /b → 404\n… 1 more'
    )
    const [one] = thinMarkers(m.slice(0, 1), total, 100)
    expect(groupTip(one)).toBe('0:01 · GET /a → 200')
  })
})
