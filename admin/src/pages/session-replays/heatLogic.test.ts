import { describe, expect, it } from 'vitest'
import { cellAt, depthLabel, heatDots, lastDays, reachCurve } from './heatLogic'

describe('heatDots', () => {
  it('places 2% buckets at their centres and weights by the busiest cell', () => {
    const dots = heatDots(
      [
        { x: 0, y: 0, count: 4 },
        { x: 49, y: 25, count: 1 }
      ],
      1000,
      500
    )
    expect(dots[0]).toEqual({ cx: 10, cy: 5, weight: 1, count: 4 })
    expect(dots[1]).toMatchObject({ cx: 990, cy: 255, weight: 0.5 })
  })
  it('draws nothing on an empty map or a zero-size canvas', () => {
    expect(heatDots([], 100, 100)).toEqual([])
    expect(heatDots([{ x: 1, y: 1, count: 1 }], 0, 100)).toEqual([])
  })
})

describe('cellAt', () => {
  it('finds the cell under the pointer', () => {
    const cells = [{ x: 12, y: 25, count: 3 }]
    expect(cellAt(cells, 250, 400, 1000, 800)).toEqual(cells[0])
    expect(cellAt(cells, 10, 10, 1000, 800)).toBeNull()
  })
})

describe('reachCurve', () => {
  it('is the share of visits that reached at least each screen', () => {
    // 6 visits never scrolled (depth 4), 3 reached 2 screens, 1 reached 3.25
    const curve = reachCurve([
      { depth: 4, visits: 6 },
      { depth: 8, visits: 3 },
      { depth: 13, visits: 1 }
    ])
    expect(curve.map((c) => [c.screens, c.reached])).toEqual([
      [1, 10],
      [2, 4],
      [3, 1],
      [4, 0]
    ])
    expect(curve[1].share).toBeCloseTo(0.4)
  })
  it('is empty with no visits', () => {
    expect(reachCurve([])).toEqual([])
  })
})

describe('labels and ranges', () => {
  it('depth labels', () => {
    expect(depthLabel(4)).toBe('1 screen')
    expect(depthLabel(6)).toBe('1.5 screens')
    expect(depthLabel(5)).toBe('1.25 screens')
  })
  it('last N UTC days, inclusive', () => {
    expect(lastDays(7, Date.parse('2026-10-10T23:00:00Z'))).toEqual({
      from: '2026-10-04',
      to: '2026-10-10'
    })
  })
})
