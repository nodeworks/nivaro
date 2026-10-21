// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import {
  type GroupRow,
  type LayoutBundle,
  type LayoutOp,
  newGroup,
  newPlacement,
  type PlacementRow,
  ungroupedGroup
} from '../../lib/layout-ops'
import { HistoryPanel } from './HistoryPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

// History's "Piece" (#2716): the version's differing pieces are listed from the
// version bundle, and one click hands the editor the ops as a single labelled step.

type Cmd = { _method: string; _path: string }

const group = (key: string, sort: number, extra: Partial<GroupRow> = {}): GroupRow => ({
  ...newGroup(key, key[0].toUpperCase() + key.slice(1), 'section', null),
  sort,
  ...extra
})
const placed = (field: string, groupKey: string | null, sort: number): PlacementRow => ({
  ...newPlacement(field, groupKey),
  sort
})
const bundle = (groups: GroupRow[], placements: PlacementRow[]): LayoutBundle => ({
  layout: { id: 5, collection: 'orders', name: 'Main', layout_type: 'grouped' },
  groups: [...groups, ungroupedGroup(groups.length)],
  placements,
  rev: 'r'
})
const VERSION_BUNDLE = bundle(
  [group('main', 0), group('money', 1)],
  [placed('title', 'main', 0), placed('amount', 'money', 0)]
)
const CURRENT = bundle([group('main', 0)], [placed('title', 'main', 0)])
const VERSIONS = [
  {
    id: 11,
    version: 2,
    note: 'before save',
    created_at: '2026-10-18T14:00:00Z',
    created_by_name: 'Dana'
  }
]

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function settle(until: () => boolean) {
  for (let i = 0; i < 100 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
  expect(until()).toBe(true)
}
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null

describe('RestorePieceButton', () => {
  it('lists what differs and applies one piece as one labelled step', async () => {
    const calls: Cmd[] = []
    const client = {
      request: vi.fn(async (cmd: Cmd) => {
        calls.push(cmd)
        if (cmd._path === '/collection-layouts/5/versions') return { data: VERSIONS }
        if (cmd._path === '/collection-layouts/5/versions/11/bundle')
          return { data: { bundle: VERSION_BUNDLE, version: 2 } }
        if (cmd._path.endsWith('/diff'))
          return {
            data: {
              from: { version: 2, created_at: null, note: null },
              layout: [],
              groups: { added: [], removed: [], changed: [] },
              assignments: { added: [], removed: [], changed: [] },
              warnings: [],
              total: 0
            }
          }
        return { data: null }
      })
    }
    const onApply = vi.fn<(ops: LayoutOp[], label: string) => void>()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <HistoryPanel
              layoutId={5}
              bundle={CURRENT}
              onApply={onApply}
              fieldLabel={(f) => (f === 'amount' ? 'Amount due' : f)}
            />
          </NivaroProvider>
        </QueryClientProvider>
      )
    })
    await settle(() => !!q('[data-restore-piece="11"]'))
    act(() => q('[data-restore-piece="11"]')?.click())
    await settle(() => !!q('[data-restore-piece-row="g:money"]'))
    const popover = q('[data-restore-piece-popover]')
    expect(popover?.textContent).toContain('Restore a piece of v2')
    expect(q('[data-restore-piece-row="g:money"]')?.textContent).toContain('Back on the form')
    // The field alone cannot come back while its section is gone: shown, disabled, with the reason.
    const fieldRow = q('[data-restore-piece-row="f:amount:money"]')
    expect(fieldRow?.textContent).toContain('Amount due')
    expect(fieldRow?.textContent).toContain('in Money')
    expect(
      (q('[data-restore-piece-apply="f:amount:money"]') as HTMLButtonElement | null)?.disabled
    ).toBe(true)

    act(() => q('[data-restore-piece-apply="g:money"]')?.click())
    expect(onApply).toHaveBeenCalledTimes(1)
    const [ops, label] = onApply.mock.calls[0]
    expect(label).toBe('Restore section Money from v2')
    expect(ops.map((o) => o.op)).toEqual(['group_create', 'place'])
    expect(calls.some((c) => c._method === 'POST')).toBe(false)
    await settle(() => !q('[data-restore-piece-popover]'))
  })
})
