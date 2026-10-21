// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../../context'
import { LayoutOverview } from './LayoutOverview'
import type { OverviewRow } from './types'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Writes from the overview that can fail. Other views reorder by drag: the
// drop is driven through the DndContext's onDragEnd (jsdom has no layout for
// a real drag).
const h = vi.hoisted(() => ({
  onDragEnd: null as null | ((e: unknown) => void),
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() }
}))
vi.mock('sonner', () => ({ toast: h.toast }))
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>()
  return {
    ...actual,
    DndContext: (p: { onDragEnd?: (e: unknown) => void; children?: unknown }) => {
      h.onDragEnd = p.onDragEnd ?? null
      return createElement(actual.DndContext, p as never)
    }
  }
})

const row = (layout_id: number, name: string): OverviewRow => ({
  layout_id,
  name,
  layout_type: 'table',
  slug: null,
  section: 'other_views',
  reason: { kind: 'type_use', type_use: 'List drill-down columns' },
  is_default: false,
  new_menu: null,
  shape: { groups: 0, steps_or_tabs: 0, fields: 3 },
  references: [],
  warnings: []
})
const ROWS = [row(46, 'Drill Columns'), row(47, 'Materials Columns')]

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
  for (let i = 0; i < 50 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

const order = () =>
  Array.from(document.querySelectorAll('[data-layout-row]'))
    .map((r) => r.getAttribute('data-layout-row'))
    .filter((id) => id === '46' || id === '47')

describe('LayoutOverview writes', () => {
  beforeEach(() => h.toast.error.mockClear())

  it('a reorder the server refuses goes back to the stored order', async () => {
    const client = {
      request: vi.fn(async (cmd: { _method?: string; _path: string }) => {
        if (cmd._path === '/collection-layouts/overview') return { data: { rows: ROWS } }
        if (cmd._method === 'PATCH') throw Object.assign(new Error('nope'), { status: 500 })
        if (cmd._path.startsWith('/field-config/')) return { data: [] }
        return { data: null }
      })
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <LayoutOverview collection='inventory_request' onOpen={() => {}} />
          </NivaroProvider>
        </QueryClientProvider>
      )
    })
    await settle(() => order().length === 2)
    expect(order()).toEqual(['46', '47'])

    await act(async () => {
      h.onDragEnd?.({ active: { id: 47 }, over: { id: 46 } })
    })
    await settle(() => h.toast.error.mock.calls.length > 0)
    await settle(() => order()[0] === '46')
    expect(h.toast.error).toHaveBeenCalled()
    expect(order()).toEqual(['46', '47'])
  })

  it('Create first form says so when the new form could not be made the default', async () => {
    const onCreate = vi.fn()
    const client = {
      request: vi.fn(async (cmd: { _method?: string; _path: string }) => {
        if (cmd._path === '/collection-layouts/overview') return { data: { rows: [] } }
        if (cmd._method === 'POST' && cmd._path === '/collection-layouts')
          return { data: { id: 101 } }
        if (cmd._path === '/collection-layouts/101/activate')
          throw Object.assign(new Error('nope'), {
            status: 403,
            response: { error: 'Not allowed' }
          })
        if (cmd._path.startsWith('/field-config/')) return { data: [] }
        return { data: null }
      })
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <LayoutOverview collection='inventory_request' onOpen={() => {}} onCreate={onCreate} />
          </NivaroProvider>
        </QueryClientProvider>
      )
    })
    const create = () =>
      Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Create first form'
      )
    await settle(() => !!create())
    await act(async () => {
      create()?.click()
    })
    await settle(() => onCreate.mock.calls.length > 0)
    // The form exists, so it still opens; the failed default is said, not swallowed.
    expect(onCreate).toHaveBeenCalledWith('grouped', 101)
    expect(h.toast.error).toHaveBeenCalledWith(
      'Main form was created but not made the default: Not allowed'
    )
  })
})
