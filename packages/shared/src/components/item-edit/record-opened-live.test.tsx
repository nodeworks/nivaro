// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { LIVE_WINDOW_EVENT } from '../../lib/live'
import {
  RECORD_OPENED_SETTLE_MS,
  useRefreshOnRecordOpened,
  viewersNoticeFor
} from './record-opened-live'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Realtime gaps 2026-11-17 (minor): OwnerOpenedLine and RecordViewersChip never refreshed.
describe('viewersNoticeFor', () => {
  it('matches this record only (an older server naming none counts)', () => {
    const is = viewersNoticeFor('workflows', '12')
    expect(is({ collection: 'workflows', item: 12 })).toBe(true)
    expect(is({ collection: 'workflows', item: 13 })).toBe(false)
    expect(is({})).toBe(true)
  })
})

describe('useRefreshOnRecordOpened', () => {
  it('re-reads once the viewers burst settles', async () => {
    vi.useFakeTimers()
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries')
    function Probe() {
      useRefreshOnRecordOpened('workflows', '12', ['record-viewers', 'workflows', '12'])
      return null
    }
    const host = document.createElement('div')
    const root = createRoot(host)
    await act(async () =>
      root.render(
        <QueryClientProvider client={qc}>
          <Probe />
        </QueryClientProvider>
      )
    )
    const send = (item: number) =>
      window.dispatchEvent(
        new CustomEvent(LIVE_WINDOW_EVENT, {
          detail: {
            event: 'record:viewers',
            payload: { collection: 'workflows', item, viewers: [] }
          }
        })
      )
    act(() => send(99))
    act(() => send(12))
    await act(async () => vi.advanceTimersByTime(RECORD_OPENED_SETTLE_MS + 10))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toEqual({ queryKey: ['record-viewers', 'workflows', '12'] })
    act(() => root.unmount())
    vi.useRealTimers()
  })
})
