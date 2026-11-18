// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { LIVE_WINDOW_EVENT } from './live'
import { peopleQueryMatches, useUserSync } from './user-sync'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Host() {
  useUserSync()
  return null
}

// C1 (realtime gaps 2026-11-17): a retired notification sends no read:changed, so the bell
// badge kept "(1)" over an empty list until its poll.
describe('useUserSync — notification:retired', () => {
  it('re-reads the unread count, the lists and My Work', async () => {
    vi.useFakeTimers()
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries')
    const host = document.createElement('div')
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <Host />
        </QueryClientProvider>
      )
    })
    act(() => {
      window.dispatchEvent(
        new CustomEvent(LIVE_WINDOW_EVENT, {
          detail: { event: 'notification:retired', payload: { ids: [4] } }
        })
      )
    })
    await act(async () => {
      vi.advanceTimersByTime(1100)
    })
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] })?.queryKey)
    expect(keys).toContainEqual(['notification-count'])
    expect(keys).toContainEqual(['notifications'])
    expect(keys).toContainEqual(['my-work'])
    act(() => root.unmount())
    vi.useRealTimers()
  })
})

// Low (shared) 3: the people page header did not follow people:changed.
describe('people:changed — the people page header', () => {
  it("refetches the 'me' read when the person it answered with is named", () => {
    const ids = new Set(['AAA'])
    expect(peopleQueryMatches(['nvr-profile-user', 'me'], ids, { id: 'aaa' })).toBe(true)
    expect(peopleQueryMatches(['nvr-profile-user', 'me'], ids, { id: 'bbb' })).toBe(false)
    expect(peopleQueryMatches(['nvr-profile-user', 'aaa'], ids)).toBe(true)
  })
})
