// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGapRefresh } from './gap-refresh'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => vi.useRealTimers())

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible')
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useGapRefresh (My Work, cover line — realtime fixes 2026-11-19)', () => {
  it('reads at most once per gap, and a hidden tab owes one read until shown', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    let poke: () => void = () => {}
    function Probe() {
      poke = useGapRefresh(fn, 8000)
      return null
    }
    const root = createRoot(document.createElement('div'))
    act(() => root.render(createElement(Probe)))
    poke()
    poke()
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(8000)
    expect(fn).toHaveBeenCalledTimes(2)
    // Hidden: tenant-wide pokes all day cost nothing.
    setHidden(true)
    for (let i = 0; i < 20; i++) {
      poke()
      vi.advanceTimersByTime(8000)
    }
    expect(fn).toHaveBeenCalledTimes(2)
    setHidden(false)
    expect(fn).toHaveBeenCalledTimes(3)
    act(() => root.unmount())
  })
})
