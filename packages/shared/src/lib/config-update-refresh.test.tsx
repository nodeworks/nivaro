// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configUpdateTouches, useConfigUpdateRefresh } from './config-update-refresh'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => vi.useRealTimers())

describe('configUpdateTouches', () => {
  it('a push naming no collection concerns every screen; otherwise only the named one', () => {
    expect(configUpdateTouches(undefined, ['orders'])).toBe(true)
    expect(configUpdateTouches('orders', ['orders', null])).toBe(true)
    expect(configUpdateTouches('invoices', ['orders'])).toBe(false)
  })
})

describe('useConfigUpdateRefresh', () => {
  it('re-reads an open list’s metadata once per push that names its collection', async () => {
    vi.useFakeTimers()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let reads = 0
    const obs = new QueryObserver(qc, {
      queryKey: ['cbv-collection-meta', 'orders'],
      queryFn: async () => ++reads,
      staleTime: 10 * 60_000
    })
    const off = obs.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(reads).toBe(1)
    function Probe() {
      useConfigUpdateRefresh(['orders'], [['cbv-collection-meta', 'orders']], { jitterMs: 0 })
      return null
    }
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Probe))))
    const push = (collection?: string) =>
      window.dispatchEvent(new CustomEvent('nvr:config-update', { detail: { collection } }))
    push('invoices')
    await vi.advanceTimersByTimeAsync(10)
    expect(reads).toBe(1)
    push('orders')
    push('orders')
    await vi.advanceTimersByTimeAsync(10)
    expect(reads).toBe(2)
    push(undefined)
    await vi.advanceTimersByTimeAsync(10)
    expect(reads).toBe(3)
    act(() => root.unmount())
    off()
  })
})
