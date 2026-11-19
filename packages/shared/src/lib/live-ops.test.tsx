// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFreshIds, useLiveOps } from './live-ops'
import { type RealtimeAdapter, RealtimeContext } from './realtime'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function adapter() {
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  const emitted: Array<[string, unknown]> = []
  const rt: RealtimeAdapter = {
    subscribeCollections: () => () => {},
    on(event, cb) {
      const set = listeners.get(event) ?? new Set()
      set.add(cb)
      listeners.set(event, set)
      return () => set.delete(cb)
    },
    emit: (event, payload) => {
      emitted.push([event, payload])
    }
  }
  const fire = (event: string, payload: unknown) => {
    for (const cb of listeners.get(event) ?? []) cb(payload)
  }
  return { rt, emitted, fire }
}

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('useLiveOps', () => {
  it('joins its topic, reacts to that topic only, and leaves on unmount', () => {
    const { rt, emitted, fire } = adapter()
    const seen: Array<Record<string, unknown>> = []
    function Probe() {
      useLiveOps('support', (d) => seen.push(d))
      return null
    }
    act(() =>
      root.render(createElement(RealtimeContext.Provider, { value: rt }, createElement(Probe)))
    )
    expect(emitted).toEqual([['ops:join', { topic: 'support' }]])
    act(() => {
      fire('ops:changed', { topic: 'issues', at: 1 })
      fire('ops:changed', { topic: 'support', at: 2 })
      fire('ops:changed', { topic: 'support', at: 3 })
      vi.advanceTimersByTime(400)
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].at).toBe(3)
    act(() => root.unmount())
    expect(emitted.at(-1)).toEqual(['ops:leave', { topic: 'support' }])
    root = createRoot(host)
  })

  it('match filters before the debounce, so another person cannot hide this one', () => {
    const { rt, fire } = adapter()
    const seen: Array<Record<string, unknown>> = []
    function Probe() {
      useLiveOps('sessions', (d) => seen.push(d), {
        debounceMs: 800,
        match: (d) => d.user_id === 'U1'
      })
      return null
    }
    act(() =>
      root.render(createElement(RealtimeContext.Provider, { value: rt }, createElement(Probe)))
    )
    act(() => {
      fire('ops:changed', { topic: 'sessions', user_id: 'U1', at: 1 })
      fire('ops:changed', { topic: 'sessions', user_id: 'U2', at: 2 })
      vi.advanceTimersByTime(900)
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].user_id).toBe('U1')
  })

  it('is inert without a realtime adapter', () => {
    const seen: unknown[] = []
    function Probe() {
      useLiveOps('support', (d) => seen.push(d))
      return null
    }
    act(() => root.render(createElement(Probe)))
    expect(seen).toHaveLength(0)
  })

  it('a null topic joins nothing', () => {
    const { rt, emitted } = adapter()
    function Probe() {
      useLiveOps(null, () => {})
      return null
    }
    act(() =>
      root.render(createElement(RealtimeContext.Provider, { value: rt }, createElement(Probe)))
    )
    expect(emitted).toHaveLength(0)
  })
})

describe('useFreshIds', () => {
  it('flags ids that arrive after the first load, then lets them go', () => {
    let seen = new Set<string>()
    function Probe({ ids }: { ids: number[] }) {
      seen = useFreshIds(ids, 1000)
      return null
    }
    act(() => root.render(createElement(Probe, { ids: [] })))
    act(() => root.render(createElement(Probe, { ids: [1, 2] })))
    // first data after an empty load never flashes
    expect([...seen]).toEqual([])
    act(() => root.render(createElement(Probe, { ids: [3, 1, 2] })))
    expect([...seen]).toEqual(['3'])
    act(() => {
      vi.advanceTimersByTime(1100)
    })
    expect([...seen]).toEqual([])
  })
})

describe('useLiveOps — after a reconnect (realtime fixes 2026-11-19)', () => {
  it('pokes every held topic once, since ops pokes are not replayed', () => {
    const { rt, fire } = adapter()
    let status = { state: 'live' as 'live' | 'reconnecting', transport: null, resumed: null } as {
      state: 'live' | 'reconnecting'
      transport: null
      resumed: 'replayed' | null
    }
    const statusCbs = new Set<(s: typeof status) => void>()
    const withStatus = {
      ...rt,
      status: () => status,
      onStatus: (cb: (s: typeof status) => void) => {
        statusCbs.add(cb)
        return () => statusCbs.delete(cb)
      }
    } as unknown as RealtimeAdapter
    const set = (s: Partial<typeof status>) => {
      status = { ...status, ...s }
      for (const cb of statusCbs) cb(status)
    }
    const support: Array<Record<string, unknown>> = []
    const myWork: Array<Record<string, unknown>> = []
    function Probe() {
      useLiveOps('support', (d) => support.push(d))
      useLiveOps('my-work', (d) => myWork.push(d), { match: (d) => d.user === 'x' })
      return null
    }
    act(() =>
      root.render(
        createElement(RealtimeContext.Provider, { value: withStatus }, createElement(Probe))
      )
    )
    act(() => {
      set({ state: 'reconnecting' })
      set({ state: 'live', resumed: 'replayed' })
    })
    act(() => {
      vi.advanceTimersByTime(4500)
    })
    expect(support).toEqual([{ topic: 'support', reconnect: true }])
    expect(myWork).toEqual([{ topic: 'my-work', reconnect: true }])
    // An ordinary poke still goes through the normal path.
    act(() => {
      fire('ops:changed', { topic: 'support', at: 9 })
      vi.advanceTimersByTime(400)
    })
    expect(support).toHaveLength(2)
  })
})
