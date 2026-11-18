import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGapRefresher } from './live-refresh'

describe('createGapRefresher (Overview sections follow the data)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('re-reads at once, then at most once per gap however many pokes arrive', () => {
    const fn = vi.fn()
    const r = createGapRefresher(fn, { gapMs: 30_000, now: () => Date.now() })
    r.poke()
    expect(fn).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(1000)
      r.poke()
    }
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_000)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('never re-reads while the tab is hidden; owes one for when it is shown', () => {
    const fn = vi.fn()
    let shown = false
    const r = createGapRefresher(fn, { gapMs: 5000, isVisible: () => shown })
    r.poke()
    r.poke()
    expect(fn).not.toHaveBeenCalled()
    shown = true
    r.resume()
    expect(fn).toHaveBeenCalledTimes(1)
    r.resume()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('cancel drops a scheduled re-read', () => {
    const fn = vi.fn()
    const r = createGapRefresher(fn, { gapMs: 5000 })
    r.poke()
    r.poke()
    r.cancel()
    vi.advanceTimersByTime(10_000)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
