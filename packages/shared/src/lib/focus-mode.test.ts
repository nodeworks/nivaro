import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyHeldLiveNow,
  deliverLive,
  releaseLiveOwner,
  resetFocusModeForTests,
  setFocusMode
} from './focus-mode'

beforeEach(() => {
  vi.useFakeTimers()
  resetFocusModeForTests()
})
afterEach(() => {
  resetFocusModeForTests()
  vi.useRealTimers()
})

describe('focus mode', () => {
  it('delivers at once when focus is off', () => {
    const apply = vi.fn()
    deliverLive({}, [1, 2], apply)
    expect(apply).toHaveBeenCalledWith([1, 2])
  })

  it('holds events per owner and applies them together when the window ends', () => {
    const owner = {}
    const apply = vi.fn()
    setFocusMode(true, 3)
    deliverLive(owner, ['a'], apply)
    deliverLive(owner, ['b', 'c'], apply)
    expect(apply).not.toHaveBeenCalled()
    vi.advanceTimersByTime(3 * 60_000 - 1)
    expect(apply).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith(['a', 'b', 'c'])
  })

  it('the pill applies the backlog immediately', () => {
    const apply = vi.fn()
    setFocusMode(true, 5)
    deliverLive({}, ['x'], apply)
    applyHeldLiveNow()
    expect(apply).toHaveBeenCalledWith(['x'])
  })

  it('turning focus off flushes what was held', () => {
    const apply = vi.fn()
    setFocusMode(true)
    deliverLive({}, ['x'], apply)
    setFocusMode(false)
    expect(apply).toHaveBeenCalledWith(['x'])
  })

  it('an unmounted owner drops its backlog', () => {
    const owner = {}
    const apply = vi.fn()
    setFocusMode(true)
    deliverLive(owner, ['x'], apply)
    releaseLiveOwner(owner)
    applyHeldLiveNow()
    expect(apply).not.toHaveBeenCalled()
  })
})
