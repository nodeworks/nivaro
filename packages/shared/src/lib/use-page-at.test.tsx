// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type RealtimeAdapter, RealtimeContext } from './realtime'
import { pageAtPayload, usePageAt } from './use-page-at'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function fakeAdapter() {
  const emitted: Array<[string, unknown]> = []
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  const rt: RealtimeAdapter = {
    subscribeCollections: () => () => {},
    on(event, cb) {
      const set = listeners.get(event) ?? new Set()
      set.add(cb)
      listeners.set(event, set)
      return () => set.delete(cb)
    },
    emit(event, payload) {
      emitted.push([event, payload])
    }
  }
  const fire = (event: string) => {
    for (const cb of listeners.get(event) ?? []) cb({})
  }
  return { rt, emitted, fire }
}

function Probe(props: { app: string; path?: string }) {
  usePageAt(props)
  return null
}

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
  vi.useRealTimers()
})

describe('pageAtPayload', () => {
  it('keeps same-origin paths and labels the app', () => {
    expect(pageAtPayload('/claims/12', 'efp')).toEqual({ path: '/claims/12', app: 'efp' })
    expect(pageAtPayload('//evil.example', 'efp')).toBeNull()
    expect(pageAtPayload('javascript:alert(1)', 'efp')).toBeNull()
    expect(pageAtPayload(`/${'a'.repeat(300)}`, 'efp')?.path.length).toBe(200)
  })
})

describe('usePageAt', () => {
  it('sends page:at with the app on mount, on route change and after a reconnect', () => {
    const { rt, emitted, fire } = fakeAdapter()
    const render = (path: string) =>
      act(() =>
        root.render(
          createElement(
            RealtimeContext.Provider,
            { value: rt },
            createElement(Probe, { app: 'efp', path })
          )
        )
      )
    render('/home')
    expect(emitted).toEqual([['page:at', { path: '/home', app: 'efp' }]])
    render('/home')
    expect(emitted).toHaveLength(1)
    render('/claims/7')
    expect(emitted.at(-1)).toEqual(['page:at', { path: '/claims/7', app: 'efp' }])
    act(() => fire('auth:ok'))
    expect(emitted.at(-1)).toEqual(['page:at', { path: '/claims/7', app: 'efp' }])
    expect(emitted).toHaveLength(3)
  })

  it('follows window.location when the host passes no path', () => {
    vi.useFakeTimers()
    const { rt, emitted } = fakeAdapter()
    window.history.replaceState(null, '', '/start')
    act(() =>
      root.render(
        createElement(RealtimeContext.Provider, { value: rt }, createElement(Probe, { app: 'efp' }))
      )
    )
    expect(emitted).toEqual([['page:at', { path: '/start', app: 'efp' }]])
    window.history.pushState(null, '', '/next')
    act(() => {
      vi.advanceTimersByTime(1100)
    })
    expect(emitted.at(-1)).toEqual(['page:at', { path: '/next', app: 'efp' }])
  })

  it('does nothing without a realtime adapter', () => {
    expect(() =>
      act(() => root.render(createElement(Probe, { app: 'efp', path: '/x' })))
    ).not.toThrow()
  })
})
