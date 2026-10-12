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
