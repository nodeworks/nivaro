// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetLiveRefreshForTests,
  createCoalescer,
  refreshSignature,
  useLiveRefresh
} from './live-counts'
import { type RealtimeAdapter, RealtimeContext } from './realtime'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  _resetLiveRefreshForTests()
})

describe('createCoalescer', () => {
  it('turns a burst of pokes into one call after the quiet window', () => {
    const fn = vi.fn()
    const co = createCoalescer(fn, { quietMs: 2000, isVisible: () => true })
    for (let i = 0; i < 50; i++) {
      co.poke()
      vi.advanceTimersByTime(100)
    }
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1800) // 1.9 s since the last poke
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('never waits longer than maxWaitMs into a steady stream', () => {
    const fn = vi.fn()
    const co = createCoalescer(fn, { quietMs: 2000, maxWaitMs: 10_000, isVisible: () => true })
    // A poke every second for a minute never goes quiet for 2 s.
    for (let i = 0; i < 60; i++) {
      co.poke()
      vi.advanceTimersByTime(1000)
    }
    // ~one call per 10 s window, not one per poke (60).
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(5)
    expect(fn.mock.calls.length).toBeLessThanOrEqual(7)
  })

  it('never calls sooner than the quiet window after a lone poke', () => {
    const fn = vi.fn()
    const co = createCoalescer(fn, { quietMs: 2000, isVisible: () => true })
    co.poke()
    vi.advanceTimersByTime(1500)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(600)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('a hidden tab owes one call and makes it when shown again', () => {
    const fn = vi.fn()
    let visible = false
    const co = createCoalescer(fn, { quietMs: 2000, isVisible: () => visible })
    co.poke()
    co.poke()
    vi.advanceTimersByTime(5000)
    expect(fn).not.toHaveBeenCalled()
    expect(co.pending()).toBe(true)
    co.resume() // still hidden
    expect(fn).not.toHaveBeenCalled()
    visible = true
    co.resume()
    expect(fn).toHaveBeenCalledTimes(1)
    co.resume()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(co.pending()).toBe(false)
  })

  it('cancel drops what was scheduled', () => {
    const fn = vi.fn()
    const co = createCoalescer(fn, { isVisible: () => true })
    co.poke()
    co.cancel()
    vi.advanceTimersByTime(60_000)
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('refreshSignature', () => {
  it('is the same for the same client, keys and timing, and differs otherwise', () => {
    expect(refreshSignature(1, [['a']], 2000)).toBe(refreshSignature(1, [['a']], 2000))
    expect(refreshSignature(1, [['a']], 2000)).not.toBe(refreshSignature(2, [['a']], 2000))
    expect(refreshSignature(1, [['a']], 2000)).not.toBe(refreshSignature(1, [['b']], 2000))
    expect(refreshSignature(1, [['a']], 2000)).not.toBe(refreshSignature(1, [['a']], 5000))
  })
})

function adapter() {
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  const rt: RealtimeAdapter = {
    subscribeCollections: () => () => {},
    on(event, cb) {
      const set = listeners.get(event) ?? new Set()
      set.add(cb)
      listeners.set(event, set)
      return () => set.delete(cb)
    },
    emit: () => {}
  }
  const fire = (event: string, payload: unknown) => {
    for (const cb of listeners.get(event) ?? []) cb(payload)
  }
  return { rt, fire }
}

describe('useLiveRefresh', () => {
  let root: Root
  let host: HTMLDivElement
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('a burst of topic pokes is one refetch per quiet window, shared by every count that asks', () => {
    const { rt, fire } = adapter()
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue(undefined)
    function Count() {
      useLiveRefresh({ topic: 'my-work', keys: [['approval-instances']] })
      return null
    }
    act(() =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: qc },
          createElement(
            RealtimeContext.Provider,
            { value: rt },
            // Three counts that name the same reads: one shared refresher.
            createElement(Count),
            createElement(Count),
            createElement(Count)
          )
        )
      )
    )
    for (let i = 0; i < 40; i++) {
      fire('ops:changed', { topic: 'my-work', at: i })
      fire('ops:changed', { topic: 'issues', at: i }) // another topic: ignored
      act(() => {
        vi.advanceTimersByTime(200)
      })
    }
    expect(spy).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(2100)
    })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith({ queryKey: ['approval-instances'], refetchType: 'active' })
  })

  it('never goes below the 2 s floor, and stops after unmount', () => {
    const { rt, fire } = adapter()
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue(undefined)
    function Count() {
      useLiveRefresh({ topic: 'integrations', keys: [['integration-signals']], quietMs: 10 })
      return null
    }
    act(() =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: qc },
          createElement(RealtimeContext.Provider, { value: rt }, createElement(Count))
        )
      )
    )
    fire('ops:changed', { topic: 'integrations', at: 1 })
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(spy).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(spy).toHaveBeenCalledTimes(1)
    fire('ops:changed', { topic: 'integrations', at: 2 })
    act(() => root.unmount())
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(spy).toHaveBeenCalledTimes(1)
    // remount root for afterEach
    root = createRoot(host)
  })
})
