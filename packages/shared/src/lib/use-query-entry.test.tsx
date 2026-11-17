// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, skipToken, useQuery } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useQueryEntryState } from './use-query-entry'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/*
 * Report "Reset cache" (2026-11-16, EFP prod): every query widget showed "Couldn't load this
 * query" right after `invalidateQueries(['nivaro-report-query'])`, with NO request sent. The
 * data-changed chip watched the rows' entry with `useQuery({queryKey, queryFn: skipToken})`.
 * Every observer writes its options onto the shared Query, the chip renders after the rows, so
 * the Query's queryFn became skipToken; invalidate → refetchQueries → query.fetch() with the
 * Query's own options → "Missing queryFn" rejection, shown as the widget's error. "Try again"
 * worked because observer.refetch() passes the rows observer's options.
 */

const KEY = ['nivaro-report-query', 'rpt-x', {}]
let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
})

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => {})
}

function mount(Watcher: () => null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const fn = vi.fn(async () => [{ n: fn.mock.calls.length }])
  const seen: { error: unknown; data: unknown } = { error: null, data: undefined }
  function Rows() {
    const { data, error } = useQuery({ queryKey: KEY, queryFn: fn, staleTime: 60_000 })
    seen.error = error
    seen.data = data
    return null
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() =>
    root.render(
      <QueryClientProvider client={qc}>
        <Rows />
        <Watcher />
      </QueryClientProvider>
    )
  )
  cleanup = () => {
    act(() => root.unmount())
    host.remove()
  }
  return { qc, fn, seen }
}

describe('watching a query entry without fetching it', () => {
  it('a skipToken observer beside the real one breaks invalidate (the bug)', async () => {
    const { qc, fn, seen } = mount(function Watcher() {
      // What the chip did: it read dataUpdatedAt, so it re-rendered (and re-set its options) on
      // every run, after the rows component above it.
      useQuery({ queryKey: KEY, queryFn: skipToken }).dataUpdatedAt
      return null
    })
    await flush()
    expect(fn).toHaveBeenCalledTimes(1)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['nivaro-report-query'] }).catch(() => {})
    })
    // Wait for the error to render (a fixed number of ticks is not enough on a busy runner).
    await vi.waitFor(async () => {
      await flush()
      expect(String((seen.error as Error)?.message)).toContain('Missing queryFn')
    })
    err.mockRestore()
    // No request went out, and the widget shows an error.
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('useQueryEntryState watches the entry and invalidate refetches with the real queryFn', async () => {
    const stamps: number[] = []
    const { qc, fn, seen } = mount(function Watcher() {
      const state = useQueryEntryState(KEY)
      stamps.push(state?.dataUpdatedAt ?? 0)
      return null
    })
    await flush()
    expect(fn).toHaveBeenCalledTimes(1)
    const first = stamps[stamps.length - 1]
    expect(first).toBeGreaterThan(0)
    await new Promise((r) => setTimeout(r, 2))
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['nivaro-report-query'] })
    })
    // A fixed number of ticks is not enough on a busy CI runner: wait for the second run.
    await vi.waitFor(async () => {
      await flush()
      expect(seen.data).toEqual([{ n: 2 }])
    })
    expect(fn).toHaveBeenCalledTimes(2)
    expect(seen.error).toBeNull()
    // The watcher re-rendered on the new run.
    expect(stamps[stamps.length - 1]).toBeGreaterThan(first)
  })

  it('the watcher alone never fetches and never keeps the entry from garbage collection', async () => {
    const qc = new QueryClient()
    const host = document.createElement('div')
    const root = createRoot(host)
    let state: unknown = 'unset'
    function Watcher() {
      state = useQueryEntryState(KEY)
      return null
    }
    act(() =>
      root.render(
        <QueryClientProvider client={qc}>
          <Watcher />
        </QueryClientProvider>
      )
    )
    expect(state).toBeUndefined()
    expect(qc.getQueryCache().find({ queryKey: KEY })).toBeUndefined()
    act(() => qc.setQueryData(KEY, [1]))
    expect((state as { data: unknown })?.data).toEqual([1])
    act(() => root.unmount())
  })
})
