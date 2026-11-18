// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { useRowCommentCounts } from './RowComments'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Low (seamless) 3, realtime gaps 2026-11-17: adding or removing a line re-keyed the counts
// read and every comment badge blinked out until it answered.
describe('useRowCommentCounts', () => {
  it('keeps the last counts while a new set of rows is read', async () => {
    let release: (v: unknown) => void = () => {}
    let n = 0
    const client = {
      request: vi.fn(async () => {
        n++
        if (n === 1) return { data: { '1': 2 } }
        return new Promise((r) => {
          release = r
        })
      })
    }
    const seen: Array<Record<string, number>> = []
    function Probe({ ids }: { ids: string[] }) {
      seen.push(useRowCommentCounts('lines', ids, true))
      return null
    }
    const host = document.createElement('div')
    const root = createRoot(host)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = (ids: string[]) => (
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <Probe ids={ids} />
        </NivaroProvider>
      </QueryClientProvider>
    )
    await act(async () => root.render(view(['1'])))
    await act(() => new Promise((r) => setTimeout(r, 10)))
    expect(seen.at(-1)).toEqual({ '1': 2 })
    await act(async () => root.render(view(['1', '2'])))
    expect(seen.at(-1)).toEqual({ '1': 2 }) // not {} while the new read is out
    await act(async () => {
      release({ data: { '1': 2, '2': 1 } })
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(seen.at(-1)).toEqual({ '1': 2, '2': 1 })
    act(() => root.unmount())
  })
})
