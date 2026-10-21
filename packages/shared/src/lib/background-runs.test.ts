// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../context'
import {
  clock,
  OFFER_AFTER_MS,
  OFFER_ANYWAY_MS,
  requestSignature,
  runProgress,
  shouldOffer,
  signatureKey,
  type UseBackgroundRun,
  useBackgroundRun
} from './background-runs'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('offer rules', () => {
  it('offers a known-slow read after a moment and any read after a long wait', () => {
    expect(shouldOffer(OFFER_AFTER_MS - 1, { slow: true })).toBe(false)
    expect(shouldOffer(OFFER_AFTER_MS, { slow: true })).toBe(true)
    expect(shouldOffer(OFFER_AFTER_MS, { slow: false })).toBe(false)
    expect(shouldOffer(OFFER_AFTER_MS, undefined)).toBe(false)
    expect(shouldOffer(OFFER_ANYWAY_MS, { slow: false })).toBe(true)
  })

  it('progress follows the usual time and never claims done', () => {
    expect(runProgress(5000, 10_000)).toBe(0.5)
    expect(runProgress(50_000, 10_000)).toBe(0.95)
    expect(runProgress(5000, null)).toBeNull()
  })

  it('formats elapsed time as a clock', () => {
    expect(clock(14_000)).toBe('0:14')
    expect(clock(65_400)).toBe('1:05')
    expect(clock(-5)).toBe('0:00')
  })

  it('keys a request by method, url and body', () => {
    const a = requestSignature({ method: 'POST', url: '/custom-queries/q/execute', body: { a: 1 } })
    const b = requestSignature({ method: 'POST', url: '/custom-queries/q/execute', body: { a: 2 } })
    expect(a).not.toBe(b)
    expect(signatureKey(a)).not.toBe(signatureKey(b))
    expect(signatureKey(a)).toBe(signatureKey(a))
  })
})

describe('useBackgroundRun', () => {
  afterEach(() => {
    vi.useRealTimers()
    sessionStorage.clear()
  })

  it('offers a known-slow read, starts it, and fills the page query with the result', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const calls: Array<{ m: string; p: string; b?: unknown }> = []
    let status = 'running'
    const client = {
      request: vi.fn(async (c: { _method: string; _path: string; _body?: unknown }) => {
        calls.push({ m: c._method, p: c._path, b: c._body })
        if (c._path === '/background-runs/estimate')
          return { data: { slow: true, typical_ms: 9000 } }
        if (c._method === 'POST' && c._path === '/background-runs')
          return {
            data: {
              id: '00000000-0000-4000-8000-000000000001',
              status: 'running',
              started_at: new Date().toISOString(),
              finished_at: null,
              expected_ms: 9000,
              error: null,
              result_kept: false
            }
          }
        if (c._path.endsWith('/result')) return { data: [{ total: 7 }], cached: false }
        return {
          data: {
            id: '00000000-0000-4000-8000-000000000001',
            status,
            started_at: new Date().toISOString(),
            finished_at: status === 'running' ? null : new Date().toISOString(),
            expected_ms: 9000,
            error: null,
            result_kept: true
          }
        }
      })
    }
    const qc = new QueryClient()
    const key = ['nivaro-report-query', 'q', {}]
    const result: { current: UseBackgroundRun } = { current: null as never }
    function Probe() {
      result.current = useBackgroundRun({
        pending: true,
        request: { method: 'POST', url: '/custom-queries/q/execute', body: { params: {} } },
        label: 'Query q',
        queryKey: key,
        select: (b) => (b as { data: unknown }).data
      })
      return null
    }
    const host = document.createElement('div')
    const root = createRoot(host)
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: qc },
          createElement(NivaroProvider, { client } as never, createElement(Probe))
        )
      )
    })
    expect(result.current.phase).toBe('idle')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OFFER_AFTER_MS + 600)
    })
    await vi.waitFor(() => expect(result.current.phase).toBe('offer'))
    expect(result.current.typicalMs).toBe(9000)
    await act(async () => {
      result.current.start()
    })
    await vi.waitFor(() => expect(result.current.phase).toBe('running'))
    const started = calls.find((c) => c.m === 'POST' && c.p === '/background-runs')
    expect(started?.b).toMatchObject({
      method: 'POST',
      url: '/custom-queries/q/execute',
      body: { params: {} },
      label: 'Query q'
    })
    status = 'completed'
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100)
    })
    await vi.waitFor(() => expect(result.current.phase).toBe('done'))
    expect(qc.getQueryData(key)).toEqual([{ total: 7 }])
    act(() => root.unmount())
  })
})
