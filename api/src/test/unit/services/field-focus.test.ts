import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fieldFocusTracker } from '../../../services/field-focus.js'

describe('fieldFocusTracker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const make = (max = 64) => {
    const lapsed: string[] = []
    const t = fieldFocusTracker({
      ttlMs: 1000,
      max,
      onLapse: (room, field) => lapsed.push(`${room}/${field}`)
    })
    return { t, lapsed }
  }

  it('leaving a room hands back every field held there, and only there', () => {
    const { t } = make()
    t.hold('record:w:1', 'justification')
    t.hold('record:w:1', 'row:lines:5')
    t.hold('record:w:2', 'name')
    expect(t.releaseRoom('record:w:1').sort()).toEqual(['justification', 'row:lines:5'])
    expect(t.releaseRoom('record:w:1')).toEqual([])
    expect(t.size()).toBe(1)
  })

  it('a mark with no focus or keystroke lapses; typing keeps it alive', () => {
    const { t, lapsed } = make()
    t.hold('r', 'a')
    t.hold('r', 'b')
    vi.advanceTimersByTime(800)
    t.touch('r', 'a')
    vi.advanceTimersByTime(300)
    expect(lapsed).toEqual(['r/b'])
    vi.advanceTimersByTime(800)
    expect(lapsed).toEqual(['r/b', 'r/a'])
    expect(t.size()).toBe(0)
  })

  it('a blur stops the clock; a keystroke in an unheld field starts nothing', () => {
    const { t, lapsed } = make()
    t.hold('r', 'a')
    expect(t.release('r', 'a')).toBe(true)
    expect(t.release('r', 'a')).toBe(false)
    t.touch('r', 'z')
    vi.advanceTimersByTime(5000)
    expect(lapsed).toEqual([])
    expect(t.size()).toBe(0)
  })

  it('holds at most `max` marks per socket', () => {
    const { t } = make(2)
    t.hold('r', 'a')
    t.hold('r', 'b')
    t.hold('r', 'c')
    t.hold('r', 'a')
    expect(t.size()).toBe(2)
  })
})
