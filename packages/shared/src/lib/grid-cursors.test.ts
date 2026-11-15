import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CURSOR_LEAVE_MS, CURSOR_SETTLE_MS, createCellAnnouncer, cursorColor } from './grid-cursors'

describe('createCellAnnouncer (throttled grid cursors)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('arrowing across cells announces only the cell the person stops on', () => {
    const emit = vi.fn()
    const a = createCellAnnouncer(emit)
    a.focus('c:1:a')
    vi.advanceTimersByTime(40)
    a.focus('c:1:b')
    vi.advanceTimersByTime(40)
    a.focus('c:1:c')
    vi.advanceTimersByTime(CURSOR_SETTLE_MS)
    expect(emit.mock.calls).toEqual([['c:1:c', 'start']])
  })

  it('moving on ends the old cell before starting the new one', () => {
    const emit = vi.fn()
    const a = createCellAnnouncer(emit)
    a.focus('c:1:a')
    vi.advanceTimersByTime(CURSOR_SETTLE_MS)
    a.focus('c:2:a')
    vi.advanceTimersByTime(CURSOR_SETTLE_MS)
    expect(emit.mock.calls).toEqual([
      ['c:1:a', 'start'],
      ['c:1:a', 'end'],
      ['c:2:a', 'start']
    ])
  })

  it('a quick hop out and back never flickers the mark', () => {
    const emit = vi.fn()
    const a = createCellAnnouncer(emit)
    a.focus('c:1:a')
    vi.advanceTimersByTime(CURSOR_SETTLE_MS)
    a.blur()
    vi.advanceTimersByTime(CURSOR_LEAVE_MS / 2)
    a.focus('c:1:a')
    vi.advanceTimersByTime(CURSOR_LEAVE_MS)
    expect(emit.mock.calls).toEqual([['c:1:a', 'start']])
  })

  it('leaving the grid ends the cell once; flush ends it at unmount', () => {
    const emit = vi.fn()
    const a = createCellAnnouncer(emit)
    a.focus('c:1:a')
    vi.advanceTimersByTime(CURSOR_SETTLE_MS)
    a.blur()
    vi.advanceTimersByTime(CURSOR_LEAVE_MS)
    expect(emit.mock.calls.at(-1)).toEqual(['c:1:a', 'end'])
    const b = createCellAnnouncer(emit)
    emit.mockClear()
    b.focus('c:9:z')
    vi.advanceTimersByTime(CURSOR_SETTLE_MS)
    b.flush()
    expect(emit.mock.calls).toEqual([
      ['c:9:z', 'start'],
      ['c:9:z', 'end']
    ])
  })
})

describe('cursorColor', () => {
  it('is the same colour for the same person, whatever the case of the id', () => {
    expect(cursorColor('abc-DEF')).toBe(cursorColor('ABC-def'))
  })
  it('spreads people over several colours', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `user-${i}`)
    expect(new Set(ids.map(cursorColor)).size).toBeGreaterThan(4)
  })
})
