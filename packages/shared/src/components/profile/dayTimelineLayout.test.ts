import { describe, expect, it } from 'vitest'
import {
  activeSpan,
  binRequests,
  HOUR_MS,
  hourTicks,
  isSafeAdminPath,
  MINUTE_MS,
  packRows,
  pct,
  recordingAt,
  segmentBox,
  shiftDate
} from './dayTimelineLayout'

// A UTC+2 viewer's 10 Oct 2026: 9 Oct 22:00Z → 10 Oct 22:00Z.
const DAY = {
  start: Date.parse('2026-10-09T22:00:00Z'),
  end: Date.parse('2026-10-10T22:00:00Z')
}
const at = (localHour: number, min = 0) => DAY.start + localHour * HOUR_MS + min * MINUTE_MS

describe('one day of one person — layout (#1367)', () => {
  it('places instants as a clamped percentage of the view', () => {
    expect(pct(DAY.start, DAY)).toBe(0)
    expect(pct(at(12), DAY)).toBe(50)
    expect(pct(at(30), DAY)).toBe(100)
    expect(pct(DAY.start - HOUR_MS, DAY)).toBe(0)
    expect(pct(at(1), { start: 5, end: 5 })).toBe(0)
  })

  it('clips spans to the view, keeps a minimum width, and skips spans outside it', () => {
    expect(segmentBox(at(6), at(12), DAY)).toEqual({ left: 25, width: 25 })
    // A five-second page is still something to hover.
    expect(segmentBox(at(6), at(6) + 5000, DAY, 0.5)?.width).toBe(0.5)
    // A recording that began yesterday starts at the left edge.
    expect(segmentBox(DAY.start - HOUR_MS, at(6), DAY)).toEqual({ left: 0, width: 25 })
    // Pinned at the right edge, a minimum-width mark grows leftward.
    expect(segmentBox(DAY.end - 1000, DAY.end - 500, DAY, 1)).toEqual({ left: 99, width: 1 })
    expect(segmentBox(DAY.end, DAY.end + HOUR_MS, DAY)).toBeNull()
    expect(segmentBox(DAY.start - 2 * HOUR_MS, DAY.start - HOUR_MS, DAY)).toBeNull()
  })

  it('stacks overlapping spans into rows, reusing a row once it is free', () => {
    const { rows, count } = packRows([
      { start: 0, end: 10 },
      { start: 5, end: 15 },
      { start: 12, end: 20 },
      { start: 16, end: 18 }
    ])
    expect(rows).toEqual([0, 1, 0, 1])
    expect(count).toBe(2)
    // Rows come back in input order even when input is unsorted.
    expect(
      packRows([
        { start: 10, end: 20 },
        { start: 0, end: 15 }
      ]).rows
    ).toEqual([1, 0])
    // Touching spans share a row unless a gap is asked for.
    expect(
      packRows([
        { start: 0, end: 10 },
        { start: 10, end: 20 }
      ]).count
    ).toBe(1)
    expect(
      packRows(
        [
          { start: 0, end: 10 },
          { start: 10, end: 20 }
        ],
        1
      ).count
    ).toBe(2)
    expect(packRows([]).count).toBe(1)
  })

  it('zooms to the active hours of the day, at least two hours wide, never past its edges', () => {
    expect(activeSpan([at(9, 15), at(11, 40)], DAY)).toEqual({ start: at(9), end: at(12) })
    // One moment grows to two hours around it.
    expect(activeSpan([at(9, 15)], DAY)).toEqual({ start: at(8), end: at(10) })
    // …but not before midnight or past the day's end.
    expect(activeSpan([at(0, 5)], DAY)).toEqual({ start: at(0), end: at(2) })
    expect(activeSpan([at(23, 50)], DAY)).toEqual({ start: at(22), end: at(24) })
    // Nothing at all: the whole day. Instants outside the day are ignored.
    expect(activeSpan([], DAY)).toEqual(DAY)
    expect(activeSpan([DAY.end + HOUR_MS], DAY)).toEqual(DAY)
  })

  it('labels whole hours of the viewer’s day, thinning them on a wide view', () => {
    const narrow = hourTicks({ start: at(9), end: at(12) }, DAY.start)
    expect(narrow).toEqual([at(9), at(10), at(11), at(12)])
    const whole = hourTicks(DAY, DAY.start)
    expect(whole.length).toBeLessThanOrEqual(13)
    expect(whole[0]).toBe(at(0))
    expect(whole[1]).toBe(at(2))
    // A view starting mid-hour ticks from the next whole hour.
    expect(hourTicks({ start: at(9, 30), end: at(11) }, DAY.start)).toEqual([at(10), at(11)])
  })

  it('folds per-minute counts into bins wide enough to see', () => {
    const minutes = [
      { minute: new Date(at(9, 0)).toISOString(), count: 3, errors: 0 },
      { minute: new Date(at(9, 4)).toISOString(), count: 2, errors: 1 },
      { minute: new Date(at(9, 7)).toISOString(), count: 1, errors: 0 },
      { minute: new Date(at(30)).toISOString(), count: 9, errors: 9 }
    ]
    // A whole day over 240 bins is six minutes a bin.
    const whole = binRequests(minutes, DAY)
    expect(whole.binMinutes).toBe(6)
    expect(whole.bins).toEqual([
      { start: at(9, 0), end: at(9, 6), count: 5, errors: 1 },
      { start: at(9, 6), end: at(9, 12), count: 1, errors: 0 }
    ])
    // Zoomed to two hours, every minute is its own bar.
    const zoomed = binRequests(minutes, { start: at(9), end: at(11) })
    expect(zoomed.binMinutes).toBe(1)
    expect(zoomed.bins.map((b) => b.count)).toEqual([3, 2, 1])
  })

  it('finds the recording covering a moment and the replay offset into it', () => {
    const recs = [
      { id: 'A', start: new Date(at(9)).toISOString(), end: new Date(at(10)).toISOString() },
      { id: 'B', start: new Date(at(9, 30)).toISOString(), end: new Date(at(9, 45)).toISOString() }
    ]
    expect(recordingAt(recs, at(9, 10))).toEqual({ recording: recs[0], offsetMs: 10 * MINUTE_MS })
    // Overlapping recordings: the later-starting one is the closer view.
    expect(recordingAt(recs, at(9, 40))?.recording.id).toBe('B')
    expect(recordingAt(recs, at(11))).toBeNull()
    // A minute bucket that starts just before the recording still finds it.
    expect(recordingAt(recs, at(8, 59), 60_000)?.offsetMs).toBe(0)
  })

  it('only follows rooted admin paths', () => {
    expect(isSafeAdminPath('/collections/orders/7')).toBe(true)
    expect(isSafeAdminPath('//evil.example')).toBe(false)
    expect(isSafeAdminPath('javascript:alert(1)')).toBe(false)
    expect(isSafeAdminPath('/x?u=https://a')).toBe(false)
  })

  it('steps calendar days across month ends', () => {
    expect(shiftDate('2026-10-31', 1)).toBe('2026-11-01')
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28')
  })
})
