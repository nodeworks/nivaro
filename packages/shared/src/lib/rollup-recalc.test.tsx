// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { relayLiveEvent } from './live'
import { announceWriteCommand } from './own-writes'
import {
  RECALC_LANDED_MS,
  RECALC_MAX_MS,
  RECALC_REREAD_MS,
  type RecalcState,
  useRollupRecalc
} from './rollup-recalc'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fields = [
  {
    field: 'total',
    computed_type: 'rollup',
    computed_formula: { related_collection: 'lines', fk_field: 'request', value_field: 'amount' }
  },
  { field: 'note' }
]
const LINE = '/items/lines/4?parent_collection=requests&parent_id=7'

let root: Root
let host: HTMLDivElement
let qc: QueryClient
let state: RecalcState
let updatedAt = 1

function Probe() {
  state = useRollupRecalc({
    collection: 'requests',
    itemId: 7,
    fields,
    dataUpdatedAt: updatedAt,
    queryKey: ['item', 'requests', 7]
  })
  return null
}
const render = () =>
  act(() => {
    root.render(createElement(QueryClientProvider, { client: qc }, createElement(Probe)))
  })

beforeEach(() => {
  vi.useFakeTimers()
  qc = new QueryClient()
  host = document.createElement('div')
  root = createRoot(host)
  updatedAt = 1
  render()
})
afterEach(() => {
  act(() => root.unmount())
  vi.useRealTimers()
})

describe('useRollupRecalc', () => {
  it('holds a total pending from a line write until the re-read after it lands', () => {
    const inv = vi.spyOn(qc, 'invalidateQueries')
    act(() => announceWriteCommand('start', 'PATCH', LINE))
    expect([...state.pending]).toEqual(['total'])
    act(() => announceWriteCommand('end', 'PATCH', LINE))
    // Still pending: the figure on screen is the old one until the re-read.
    expect(state.pending.has('total')).toBe(true)
    act(() => {
      vi.advanceTimersByTime(RECALC_REREAD_MS)
    })
    expect(inv).toHaveBeenCalledWith({ queryKey: ['item', 'requests', 7] })
    updatedAt = Date.now() + 1
    render()
    expect(state.pending.size).toBe(0)
    expect(state.landed.has('total')).toBe(true)
    act(() => {
      vi.advanceTimersByTime(RECALC_LANDED_MS)
    })
    expect(state.landed.size).toBe(0)
  })

  it('ignores writes to other records and collections that feed nothing', () => {
    act(() =>
      announceWriteCommand(
        'start',
        'PATCH',
        '/items/lines/4?parent_collection=requests&parent_id=8'
      )
    )
    act(() =>
      announceWriteCommand(
        'start',
        'PATCH',
        '/items/notes/1?parent_collection=requests&parent_id=7'
      )
    )
    expect(state.pending.size).toBe(0)
  })

  it('follows the server notice for someone else’s big save', () => {
    act(() =>
      relayLiveEvent('record:recalc', {
        collection: 'requests',
        item: '7',
        phase: 'start',
        fields: ['total', 'not_mine']
      })
    )
    expect([...state.pending]).toEqual(['total'])
    act(() =>
      relayLiveEvent('record:recalc', {
        collection: 'requests',
        item: '7',
        phase: 'done',
        fields: ['total']
      })
    )
    act(() => {
      vi.advanceTimersByTime(RECALC_REREAD_MS)
    })
    updatedAt = Date.now() + 1
    render()
    expect(state.pending.size).toBe(0)
  })

  it('never stays pending forever', () => {
    act(() => announceWriteCommand('start', 'POST', LINE))
    act(() => {
      vi.advanceTimersByTime(RECALC_MAX_MS)
    })
    expect(state.pending.size).toBe(0)
    expect(state.landed.size).toBe(0)
  })
})
