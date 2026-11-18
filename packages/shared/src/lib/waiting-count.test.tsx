// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type RealtimeAdapter, RealtimeContext } from './realtime'
import { useWaitingCount, WAITING_COUNT_KEY, waitingCount } from './waiting-count'

const h = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('../context', async (orig) => ({
  ...((await orig()) as object),
  useOptionalNivaroClient: () => h.client
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// S14 (realtime gaps 2026-11-17): the tab count reads the cheap counts route, and a hidden tab
// does nothing until it is visible again.

describe('waitingCount', () => {
  it('adds owned, approvals and questions; ignores tasks', () => {
    expect(waitingCount({ owned: 2, approvals: 1, tasks: 9, questions: 3 })).toBe(6)
    expect(waitingCount(null)).toBe(0)
  })
})

describe('useWaitingCount', () => {
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
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  })

  function setup() {
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
    const calls: string[] = []
    const client = {
      request: vi.fn(async (cmd: { path?: string }) => {
        calls.push(String(cmd.path ?? JSON.stringify(cmd)))
        return { data: { owned: 1, approvals: 1, questions: 0 } }
      })
    }
    h.client = client
    const qc = new QueryClient()
    function Probe() {
      useWaitingCount(true)
      return null
    }
    act(() =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: qc },
          createElement(RealtimeContext.Provider, { value: rt }, createElement(Probe))
        )
      )
    )
    const fire = (event: string, payload: unknown) => {
      for (const cb of listeners.get(event) ?? []) cb(payload)
    }
    return { client, calls, qc, fire }
  }

  it('reads /my-work/counts under its own key, not the My Work page query', async () => {
    const { calls, qc } = setup()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(calls.join()).toContain('/my-work/counts')
    expect(qc.getQueryData(WAITING_COUNT_KEY)).toEqual({ owned: 1, approvals: 1, questions: 0 })
    expect(qc.getQueryData(['my-work'])).toBeUndefined()
  })

  it('a hidden tab ignores pokes, then refreshes once when it becomes visible', async () => {
    const { client, fire } = setup()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    const before = client.request.mock.calls.length
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    await act(async () => {
      fire('ops:changed', { topic: 'my-work', at: 1 })
      fire('notification:new', {})
      await vi.advanceTimersByTimeAsync(40_000)
    })
    expect(client.request.mock.calls.length).toBe(before)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(40_000)
    })
    expect(client.request.mock.calls.length).toBe(before + 1)
  })
})
