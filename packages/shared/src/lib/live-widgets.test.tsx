// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIVE_WIDGET_SAFETY_MS, liveWidgetInterval, useLiveWidget } from './live-widgets'
import { type RealtimeAdapter, RealtimeContext } from './realtime'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function adapter() {
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  const emitted: Array<[string, any]> = []
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

describe('useLiveWidget', () => {
  it('watches, turns live when accepted, takes only its own pushes, unwatches on unmount', () => {
    const { rt, emitted, fire } = adapter()
    const got: unknown[] = []
    const liveStates: boolean[] = []
    function Probe() {
      const live = useLiveWidget({
        kind: 'report',
        widget: 'w1',
        report: 'r1',
        params: { date_range: null, entity_filters: [] },
        onData: (d) => got.push(d)
      })
      liveStates.push(live)
      return null
    }
    act(() =>
      root.render(createElement(RealtimeContext.Provider, { value: rt }, createElement(Probe)))
    )
    expect(emitted).toHaveLength(1)
    const [event, payload] = emitted[0]
    expect(event).toBe('widgets:watch')
    const watch = payload.watches[0]
    expect(watch).toMatchObject({ kind: 'report', widget: 'w1', report: 'r1' })
    act(() => fire('widget:watching', { accepted: [watch.key], refused: [] }))
    expect(liveStates.at(-1)).toBe(true)
    act(() => {
      fire('widget:data', { key: 'someone-else', data: { value: 99 } })
      fire('widget:data', { key: watch.key, data: { value: 7 } })
    })
    expect(got).toEqual([{ value: 7 }])
    act(() => vi.advanceTimersByTime(60_000))
    expect(emitted.filter(([e]) => e === 'widgets:watch')).toHaveLength(2)
    act(() => fire('widget:unwatched', { key: watch.key, reason: 'forbidden' }))
    expect(liveStates.at(-1)).toBe(false)
    act(() => root.render(createElement('div')))
    expect(emitted.at(-1)).toEqual(['widgets:unwatch', { keys: [watch.key] }])
  })

  it('stays polling without a realtime host', () => {
    let live: boolean | null = null
    function Probe() {
      live = useLiveWidget({ kind: 'dashboard', widget: 'd1', onData: () => {} })
      return null
    }
    act(() => root.render(createElement(Probe)))
    expect(live).toBe(false)
  })

  it('liveWidgetInterval slows a live widget to the safety poll', () => {
    expect(liveWidgetInterval(false, 15_000)).toBe(15_000)
    expect(liveWidgetInterval(true, 15_000)).toBe(LIVE_WIDGET_SAFETY_MS)
    expect(liveWidgetInterval(true, 3_600_000)).toBe(3_600_000)
    expect(liveWidgetInterval(true, undefined)).toBeUndefined()
  })
})
