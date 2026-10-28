import { describe, expect, it } from 'vitest'
import { boundsChanged, fitScale, viewportBounds } from './viewport'

const meta = (width: number, height: number) => ({ type: 4, timestamp: 1, data: { width, height } })
const resize = (width: number, height: number) => ({
  type: 3,
  timestamp: 2,
  data: { source: 4, width, height }
})

describe('viewportBounds', () => {
  it('takes the largest width and height of every Meta and ViewportResize event', () => {
    // CA916B8A on staging: 1920×911, then the window went to a laptop screen (1280×551) and back.
    const events = [
      meta(1920, 911),
      { type: 2, timestamp: 3, data: {} },
      resize(1436, 659),
      resize(1280, 551),
      meta(1280, 551),
      resize(638, 214),
      resize(1920, 911)
    ]
    expect(viewportBounds(events)).toEqual({ width: 1920, height: 911 })
  })

  it('combines width and height from different events', () => {
    expect(viewportBounds([meta(1280, 900), resize(1600, 700)])).toEqual({
      width: 1600,
      height: 900
    })
  })

  it('grows from what the player already holds (live follow)', () => {
    const prev = { width: 1280, height: 551 }
    expect(viewportBounds([resize(1024, 500)], prev)).toEqual(prev)
    expect(viewportBounds([resize(1920, 911)], prev)).toEqual({ width: 1920, height: 911 })
    // prev is not mutated
    expect(prev).toEqual({ width: 1280, height: 551 })
  })

  it('ignores other events and bad sizes', () => {
    expect(viewportBounds([])).toBeNull()
    expect(
      viewportBounds([
        null,
        { type: 3, data: { source: 0, width: 5000, height: 5000 } },
        { type: 5, data: { width: 9999, height: 9999 } },
        meta(0, 0),
        resize(Number.NaN, 400)
      ])
    ).toBeNull()
  })
})

describe('boundsChanged', () => {
  it('compares boxes by size', () => {
    expect(boundsChanged(null, null)).toBe(false)
    expect(boundsChanged(null, { width: 1, height: 1 })).toBe(true)
    expect(boundsChanged({ width: 1, height: 1 }, { width: 1, height: 1 })).toBe(false)
    expect(boundsChanged({ width: 1, height: 1 }, { width: 1, height: 2 })).toBe(true)
  })
})

describe('fitScale', () => {
  it('fits by the tighter of width and height, up as well as down', () => {
    expect(fitScale({ width: 1920, height: 911 }, 960, 1000)).toBe(0.5)
    expect(fitScale({ width: 1000, height: 500 }, 3000, 1000)).toBe(2)
  })

  it('one box gives one scale whatever the current viewport', () => {
    const box = viewportBounds([meta(1920, 911), resize(1280, 551)])
    expect(box).not.toBeNull()
    if (box) expect(fitScale(box, 898, 690)).toBeCloseTo(898 / 1920)
  })
})
