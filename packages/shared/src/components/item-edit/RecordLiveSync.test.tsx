// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { type RealtimeAdapter, RealtimeContext } from '../../lib/realtime'
import { purgeRecordQueries, type RecordGone, RecordLiveSync } from './RecordLiveSync'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function seed(qc: QueryClient) {
  qc.setQueryData(['item', 'workflows', '5'], { id: 5, title: 'Secret plan' })
  qc.setQueryData(['item', 'workflows', 5], { id: 5, title: 'Secret plan' })
  qc.setQueryData(['rrv-record', 'workflows', '5'], { id: 5, title: 'Secret plan' })
  qc.setQueryData(['revisions', 'workflows', '5'], [{ id: 1 }])
  qc.setQueryData(['comments', 'workflows', '5'], [{ id: 2, text: 'hush' }])
  qc.setQueryData(['pipeline-instance', 'workflows', '5', 'as-role'], { instance: {} })
  qc.setQueryData(['approval-brief', 'workflows', '5'], { text: 'x' })
  // Not this record:
  qc.setQueryData(['item', 'workflows', '6'], { id: 6 })
  qc.setQueryData(['item', 'orders', '5'], { id: 5 })
  qc.setQueryData(['cbv-items', 'workflows'], { data: [] })
}

function expectPurged(qc: QueryClient) {
  expect(qc.getQueryData(['item', 'workflows', '5'])).toBeUndefined()
  expect(qc.getQueryData(['item', 'workflows', 5])).toBeUndefined()
  expect(qc.getQueryData(['rrv-record', 'workflows', '5'])).toBeUndefined()
  expect(qc.getQueryData(['revisions', 'workflows', '5'])).toBeUndefined()
  expect(qc.getQueryData(['comments', 'workflows', '5'])).toBeUndefined()
  expect(qc.getQueryData(['pipeline-instance', 'workflows', '5', 'as-role'])).toBeUndefined()
  expect(qc.getQueryData(['approval-brief', 'workflows', '5'])).toBeUndefined()
  expect(qc.getQueryData(['item', 'workflows', '6'])).toEqual({ id: 6 })
  expect(qc.getQueryData(['item', 'orders', '5'])).toEqual({ id: 5 })
  expect(qc.getQueryData(['cbv-items', 'workflows'])).toEqual({ data: [] })
}

describe('purgeRecordQueries', () => {
  it('drops every cached query about the record and nothing else', () => {
    const qc = new QueryClient()
    seed(qc)
    purgeRecordQueries(qc, 'workflows', '5')
    expectPurged(qc)
  })
})

describe('lost access (#1925 / F7)', () => {
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

  it('an access-lost batch clears the form and its cached data', async () => {
    const listeners = new Map<string, Set<(p: unknown) => void>>()
    const rt: RealtimeAdapter = {
      subscribeCollections: () => () => {},
      on(event, cb) {
        const set = listeners.get(event) ?? new Set()
        set.add(cb)
        listeners.set(event, set)
        return () => set.delete(cb)
      },
      emit() {}
    }
    const client = {
      request: vi.fn(async (cmd: { _path?: string }) => {
        // The re-read as the viewer is refused; the trash says "not deleted".
        if (cmd._path === '/items/workflows/5')
          throw Object.assign(new Error('Forbidden'), { status: 403 })
        if (cmd._path === '/trash/record') return { data: null }
        return { data: null }
      })
    } as unknown as NivaroClient
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    seed(qc)
    const goneSeen: Array<RecordGone | null> = []

    // A stand-in for ItemEditForm: shows the record's values until told the
    // viewer lost access, then shows nothing of the record.
    function Form() {
      const [gone, setGone] = useState<RecordGone | null>(null)
      const { data } = useQuery({
        queryKey: ['item', 'workflows', '5'],
        queryFn: async () => ({ id: 5, title: 'Secret plan' }),
        enabled: !gone,
        staleTime: Number.POSITIVE_INFINITY
      })
      if (gone?.kind === 'access') return createElement('p', { 'data-lost': true }, 'gone')
      return createElement(
        'div',
        null,
        createElement('span', { 'data-title': true }, String(data?.title ?? '')),
        createElement(RecordLiveSync, {
          collection: 'workflows',
          itemId: '5',
          onGoneChange: (g: RecordGone | null) => {
            goneSeen.push(g)
            setGone(g)
          }
        })
      )
    }

    act(() =>
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client}>
            <RealtimeContext.Provider value={rt}>
              <Form />
            </RealtimeContext.Provider>
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    expect(host.querySelector('[data-title]')?.textContent).toBe('Secret plan')

    await act(async () => {
      for (const cb of listeners.get('access:changed') ?? []) cb({ at: 1 })
      // Debounce (300 ms) + jitter (< 1.5 s), then the refused re-read and
      // the trash lookup settle, then the deferred purge runs.
      await vi.advanceTimersByTimeAsync(2000)
      await vi.advanceTimersByTimeAsync(10)
    })

    expect(goneSeen.at(-1)).toEqual({ kind: 'access' })
    expect(host.querySelector('[data-title]')).toBeNull()
    expect(host.textContent).not.toContain('Secret plan')
    expectPurged(qc)
  })
})
