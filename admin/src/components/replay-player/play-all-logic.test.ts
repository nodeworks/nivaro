import { describe, expect, it } from 'vitest'
import {
  crossedEnd,
  fmtLength,
  MAX_SEGMENTS,
  planSegments,
  revisionAt,
  revisionsWithin,
  SEGMENT_PAD_MS
} from './play-all-logic'

const MIN = 60_000
const T = Date.UTC(2026, 9, 9, 9, 0, 0)

const visit = (id: string, name: string | null, first: number, last: number) => ({
  id,
  user: `user-${id}`,
  user_name: name,
  first_ms: first,
  last_ms: last
})

describe('planSegments (#1398)', () => {
  it('orders visits oldest first and pads each by a minute either side', () => {
    const segs = planSegments([
      visit('R2', 'Bob', T + 60 * MIN, T + 65 * MIN),
      visit('R1', 'Jane Doe', T, T + 4 * MIN)
    ])
    expect(segs).toEqual([
      {
        recordingId: 'R1',
        person: 'Jane Doe',
        from: T - SEGMENT_PAD_MS,
        to: T + 4 * MIN + SEGMENT_PAD_MS,
        visitFrom: T,
        visitTo: T + 4 * MIN
      },
      {
        recordingId: 'R2',
        person: 'Bob',
        from: T + 59 * MIN,
        to: T + 66 * MIN,
        visitFrom: T + 60 * MIN,
        visitTo: T + 65 * MIN
      }
    ])
  })

  it('keeps two people on the record at once, in the order they arrived', () => {
    const segs = planSegments([
      visit('B', 'Bob', T + MIN, T + 3 * MIN),
      visit('A', 'Ann', T, T + 5 * MIN)
    ])
    expect(segs.map((s) => s.person)).toEqual(['Ann', 'Bob'])
  })

  it('names someone without a name by their id, drops broken spans, caps the count', () => {
    expect(planSegments([visit('R1', '  ', T, T)])[0].person).toBe('user-R1')
    expect(planSegments([visit('R1', 'X', Number.NaN, T)])).toEqual([])
    const many = Array.from({ length: MAX_SEGMENTS + 5 }, (_, i) =>
      visit(`R${i}`, 'X', T + i * MIN, T + i * MIN)
    )
    expect(planSegments(many)).toHaveLength(MAX_SEGMENTS)
    expect(planSegments(many)[0].recordingId).toBe('R0')
  })

  it('accepts an inverted span', () => {
    const [s] = planSegments([visit('R1', 'X', T + MIN, T)], 0)
    expect([s.from, s.to]).toEqual([T, T + MIN])
  })
})

describe('the record revision per segment', () => {
  const rev = (id: number, at: number | null) => ({
    id,
    activity: id * 10,
    timestamp: at == null ? null : new Date(at).toISOString()
  })
  const revisions = [rev(3, T + 10 * MIN), rev(1, T - 60 * MIN), rev(2, T + 2 * MIN), rev(4, null)]

  it('picks the revision in effect at a moment', () => {
    expect(revisionAt(revisions, T)?.id).toBe(1)
    expect(revisionAt(revisions, T + 2 * MIN)?.id).toBe(2)
    expect(revisionAt(revisions, T + 60 * MIN)?.id).toBe(3)
    expect(revisionAt(revisions, T - 120 * MIN)).toBeNull()
  })

  it('lists revisions saved inside a segment, oldest first', () => {
    expect(revisionsWithin(revisions, T, T + 11 * MIN).map((r) => r.id)).toEqual([2, 3])
    expect(revisionsWithin(revisions, T + 3 * MIN, T + 9 * MIN)).toEqual([])
  })
})

describe('segment end and lengths', () => {
  it('trips only when playback crosses the end from below', () => {
    expect(crossedEnd(9_900, 10_010, 10_000)).toBe(true)
    expect(crossedEnd(10_010, 10_050, 10_000)).toBe(false)
    expect(crossedEnd(9_000, 9_500, 10_000)).toBe(false)
  })

  it('formats lengths', () => {
    expect(fmtLength(45_000)).toBe('45s')
    expect(fmtLength(4 * MIN + 5_000)).toBe('4m 05s')
  })
})
