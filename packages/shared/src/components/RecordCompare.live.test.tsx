// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../context'
import { type RealtimeAdapter, RealtimeContext } from '../lib/realtime'
import {
  changedCompareCells,
  compareSideHeads,
  RecordCompareDialog,
  stickyDiffRows
} from './RecordCompare'

// rt5 #16 — the side-by-side compare stays live: a write to either record re-reads it as the
// viewer and the moved cells update in place.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('compare column heads', () => {
  it('tell the sides apart: the record id leads when the names are the same', () => {
    expect(compareSideHeads(['MM26-1', 'MM26-2'], [1, 2])).toEqual([
      { primary: 'MM26-1', secondary: null },
      { primary: 'MM26-2', secondary: null }
    ])
    // No display value: just the id, never the placeholder sentence.
    expect(compareSideHeads(['No summary number', 'No summary number'], [3, 4])).toEqual([
      { primary: '#3', secondary: null },
      { primary: '#4', secondary: null }
    ])
    // A shared own text stays as the second line.
    expect(
      compareSideHeads(['No summary number · Pump A', 'No summary number · Pump A'], [5, 6])
    ).toEqual([
      { primary: '#5', secondary: 'Pump A' },
      { primary: '#6', secondary: 'Pump A' }
    ])
  })
})

describe('compare stays live — pure parts', () => {
  it('changedCompareCells names the fields that moved per side', () => {
    expect(
      changedCompareCells(
        [
          { id: 1, a: 1, b: 'x' },
          { id: 2, a: 1 }
        ],
        [
          { id: 1, a: '1.00', b: 'y', c: 3 },
          { id: 2, a: 1 }
        ]
      )
    ).toEqual([['b'], []])
    // A side first loaded now, or gone now, marks nothing.
    expect(changedCompareCells([null, { id: 2, a: 1 }], [{ id: 1, a: 2 }, null])).toEqual([[], []])
  })

  it('"Differences only" keeps rows it already showed, adds new differences', () => {
    const row = (field: string, differs: boolean) => ({
      field,
      label: field,
      cells: [],
      differs
    })
    const sections = [
      { key: 's', label: 'S', rows: [row('a', false), row('b', true), row('c', false)] }
    ]
    expect(
      stickyDiffRows(sections, new Set(['a'])).flatMap((s) => s.rows.map((r) => r.field))
    ).toEqual(['a', 'b'])
    expect(stickyDiffRows(sections, new Set())[0].rows.map((r) => r.field)).toEqual(['b'])
  })
})

describe('RecordCompareDialog live', () => {
  let root: Root | null = null
  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.replaceChildren()
  })

  it('re-reads a side when it is saved and shows the new value in place', async () => {
    const recs: Record<string, Record<string, unknown>> = {
      '1': { id: 1, title: 'Pump A', status: 'open' },
      '2': { id: 2, title: 'Pump B', status: 'open' }
    }
    const client = {
      url: 'http://test',
      getToken: () => null,
      request: vi.fn(async (cmd: { _path: string }) => {
        const m = cmd._path.match(/^\/items\/orders\/(\d+)$/)
        if (m) return { data: { ...recs[m[1]] } }
        return { data: null }
      })
    }
    const listeners: Array<(ev: unknown) => void> = []
    const rt: RealtimeAdapter = {
      subscribeCollections: (_c, cb) => {
        listeners.push(cb as (ev: unknown) => void)
        return () => {}
      },
      on: () => () => {},
      emit() {}
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () =>
      root?.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <RealtimeContext.Provider value={rt}>
              <RecordCompareDialog
                collection='orders'
                ids={[1, 2]}
                fields={[{ field: 'title' }, { field: 'status' }]}
                renderValue={(_f, v) => String(v)}
                onClose={() => {}}
              />
            </RealtimeContext.Provider>
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    const settle = async () => {
      for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
    }
    await settle()
    const statusCells = () =>
      Array.from(document.querySelectorAll('[data-compare-row="status"] [data-compare-cell]')).map(
        (e) => e.textContent
      )
    expect(statusCells()).toEqual(['open', 'open'])
    expect(document.querySelector('[data-compare-live]')).not.toBeNull()
    const reads = client.request.mock.calls.length

    // Someone approves record 2.
    recs['2'] = { ...recs['2'], status: 'approved' }
    for (const l of listeners)
      l({ collection: 'orders', item: '2', action: 'update', changed_fields: ['status'] })
    // The burst window (800 ms) passes, then the re-read lands.
    await act(async () => new Promise((r) => setTimeout(r, 900)))
    await settle()
    expect(statusCells()).toEqual(['open', 'approved'])
    // Only the changed side was read again (one burst = one read).
    const after = client.request.mock.calls
      .slice(reads)
      .map((c) => (c[0] as { _path: string })._path)
    expect(after.filter((p) => p === '/items/orders/2')).toHaveLength(1)
    expect(after).not.toContain('/items/orders/1')
    expect(
      document.querySelector('[data-compare-row="status"]')?.hasAttribute('data-differs')
    ).toBe(true)
  })
})
