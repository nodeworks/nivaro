import { describe, expect, it } from 'vitest'
import {
  chunkEvents,
  cutEvents,
  type ReplayEvent,
  sortEvents,
  summarizeCut
} from '../../../services/session-replay-cut.js'

const T0 = 1_760_000_000_000

const meta = (t: number, href = 'https://app.example.com/environments?x=1'): ReplayEvent => ({
  type: 4,
  timestamp: T0 + t,
  data: { href, width: 1280, height: 720 }
})
const snap = (t: number, tag = `snap@${t}`): ReplayEvent => ({
  type: 2,
  timestamp: T0 + t,
  data: { node: { id: 1, tag } }
})
const inc = (t: number): ReplayEvent => ({ type: 3, timestamp: T0 + t, data: { source: 2, t } })
const custom = (t: number, tag: string, payload: Record<string, unknown>): ReplayEvent => ({
  type: 5,
  timestamp: T0 + t,
  data: { tag, payload }
})

/** A 60 s recording with snapshots at 0 s and 30 s. */
function recording(): ReplayEvent[] {
  return [
    meta(0),
    snap(0),
    custom(100, 'route', { path: '/environments' }),
    inc(5_000),
    custom(6_000, 'console', { level: 'error', msg: 'early boom' }),
    inc(10_000),
    custom(20_000, 'route', { path: '/workflows' }),
    inc(25_000),
    meta(30_000, 'https://app.example.com/workflows'),
    snap(30_000),
    inc(35_000),
    custom(40_000, 'console', { level: 'error', msg: 'TypeError: x is undefined' }),
    custom(41_000, 'console', { level: 'warn', msg: 'slow' }),
    inc(45_000),
    inc(55_000),
    inc(60_000)
  ]
}

const offsets = (r: { events: ReplayEvent[] }) => r.events.map((e) => e.timestamp - T0)

describe('cutEvents', () => {
  it('starts from the latest full snapshot before from_ms, with its Meta, pinned to from_ms', () => {
    const r = cutEvents(recording(), 12_000, 26_000)!
    expect(r).not.toBeNull()
    expect(r.fromMs).toBe(12_000)
    expect(r.toMs).toBe(26_000)
    expect(r.startTs).toBe(T0 + 12_000)
    expect(r.endTs).toBe(T0 + 26_000)
    // Meta, snapshot@0, lead-in incrementals (5 s, 10 s) and the page it
    // was on (route mark at 0.1 s) all at 12 s; then the route at 20 s and
    // the incremental at 25 s. The 30 s snapshot is after the end.
    expect(r.events.map((e) => e.type)).toEqual([4, 2, 3, 3, 5, 5, 3])
    expect(offsets(r)).toEqual([12_000, 12_000, 12_000, 12_000, 12_000, 20_000, 25_000])
    expect((r.events[1].data as { node: { tag: string } }).node.tag).toBe('snap@0')
  })

  it('uses the later snapshot once from_ms is past it', () => {
    const r = cutEvents(recording(), 36_000, 50_000)!
    expect(r.events[0]).toMatchObject({
      type: 4,
      data: { href: 'https://app.example.com/workflows' }
    })
    expect((r.events[1].data as { node: { tag: string } }).node.tag).toBe('snap@30000')
    expect(offsets(r)[0]).toBe(36_000)
    // Nothing from before the 30 s snapshot survives.
    expect(offsets(r).every((t) => t >= 36_000 && t <= 50_000)).toBe(true)
  })

  it('drops lead-in console lines but keeps the latest route at the start', () => {
    const r = cutEvents(recording(), 22_000, 28_000)!
    const customs = r.events.filter((e) => e.type === 5)
    expect(customs).toHaveLength(1)
    expect(customs[0]).toMatchObject({
      timestamp: T0 + 22_000,
      data: { tag: 'route', payload: { path: '/workflows' } }
    })
    expect(JSON.stringify(r.events)).not.toContain('early boom')
  })

  it('a range starting exactly on a snapshot needs no lead-in', () => {
    const r = cutEvents(recording(), 30_000, 40_000)!
    expect(offsets(r)).toEqual([30_000, 30_000, 35_000, 40_000])
  })

  it('swaps an inverted range and clamps to the recording', () => {
    const r = cutEvents(recording(), 70_000, 50_000)!
    expect(r.fromMs).toBe(50_000)
    expect(r.toMs).toBe(60_000)
    expect(offsets(r).at(-1)).toBe(60_000)
  })

  it('starts at the first snapshot when the range opens before any', () => {
    const events = [
      inc(0),
      custom(1_000, 'console', { level: 'error', msg: 'x' }),
      meta(2_000),
      snap(2_000),
      inc(4_000)
    ]
    const r = cutEvents(events, 0, 5_000)!
    expect(r.fromMs).toBe(2_000)
    expect(r.events.map((e) => e.type)).toEqual([4, 2, 3])
  })

  it('returns null for an empty range, no events or no snapshot before the end', () => {
    expect(cutEvents(recording(), 10_000, 10_000)).toBeNull()
    expect(cutEvents([], 0, 1_000)).toBeNull()
    expect(cutEvents([inc(0), inc(5_000)], 0, 5_000)).toBeNull()
    expect(cutEvents([inc(0), meta(8_000), snap(8_000), inc(9_000)], 0, 5_000)).toBeNull()
    expect(cutEvents(recording(), Number.NaN, 5_000)).toBeNull()
  })

  it('sorts out-of-order chunks and skips junk without mutating its input', () => {
    const src = recording()
    const shuffled: unknown[] = [...src.slice(8), null, { type: 'x' }, ...src.slice(0, 8)]
    const before = JSON.stringify(shuffled)
    const r = cutEvents(shuffled, 12_000, 26_000)!
    expect(offsets(r)).toEqual([12_000, 12_000, 12_000, 12_000, 12_000, 20_000, 25_000])
    expect(JSON.stringify(shuffled)).toBe(before)
  })

  it('copies events as stored (masking included)', () => {
    const masked = { type: 3, timestamp: T0 + 33_000, data: { source: 5, text: '*****' } }
    const events = [...recording(), masked]
    const r = cutEvents(events, 31_000, 34_000)!
    expect(r.events).toContainEqual(masked)
  })
})

describe('sortEvents', () => {
  it('is stable for equal timestamps', () => {
    const a = { type: 3, timestamp: 5, data: 'a' }
    const b = { type: 3, timestamp: 5, data: 'b' }
    expect(sortEvents([a, b]).map((e) => e.data)).toEqual(['a', 'b'])
  })
})

describe('chunkEvents', () => {
  it('splits into JSON arrays under the size cap and round-trips', () => {
    const events = recording()
    const chunks = chunkEvents(events, 300)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(Array.isArray(JSON.parse(c))).toBe(true)
    expect(chunks.flatMap((c) => JSON.parse(c))).toEqual(events)
  })

  it('gives an oversized event its own chunk', () => {
    const big = { type: 2, timestamp: 1, data: 'x'.repeat(500) }
    const chunks = chunkEvents([inc(0), big, inc(1)], 100)
    expect(chunks).toHaveLength(3)
  })
})

describe('summarizeCut', () => {
  it('reads the route at the start and the console errors inside', () => {
    const r = cutEvents(recording(), 36_000, 50_000)!
    const s = summarizeCut(r)
    // No route mark since the 30 s snapshot: the Meta href names the page.
    expect(s.route).toBe('/workflows')
    expect(s.errors).toEqual([{ offset: 4_000, text: 'TypeError: x is undefined' }])
  })

  it('prefers the pinned route mark', () => {
    const s = summarizeCut(cutEvents(recording(), 22_000, 28_000)!)
    expect(s.route).toBe('/workflows')
    const s2 = summarizeCut(cutEvents(recording(), 1_000, 8_000)!)
    expect(s2.route).toBe('/environments')
    expect(s2.errors).toEqual([{ offset: 5_000, text: 'early boom' }])
  })
})
