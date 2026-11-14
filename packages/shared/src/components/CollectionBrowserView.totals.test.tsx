// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../context'
import { CollectionBrowserView } from './CollectionBrowserView'

// Totals row (2026-11-13): a number column's footer figure is asked from
// GET /items/:c/aggregate with the list's own search + conditions (the server
// computes it over the whole filtered set as the viewer), one request per
// column, never riding the page read; the choice is remembered per list.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}
window.matchMedia ??= ((q: string) => ({
  matches: false,
  media: q,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent: () => false
})) as never
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), info: vi.fn(), error: vi.fn() })
}))

type Cmd = { _method?: string; _path: string; _params?: Record<string, unknown> }
const calls: Cmd[] = []
const client = {
  url: 'http://test',
  getToken: () => null,
  request: vi.fn(async (cmd: Cmd) => {
    calls.push(cmd)
    const p = cmd._path
    if (p === '/collections/orders')
      return {
        data: {
          collection: 'orders',
          display_name: 'Orders',
          display_template: '{{name}}',
          fields: [
            { field: 'id', type: 'integer', hidden: false },
            { field: 'name', type: 'string', hidden: false },
            { field: 'amount', type: 'decimal', hidden: false }
          ],
          relations: [],
          browser_config: {}
        }
      }
    if (p === '/items/orders')
      return {
        data: Array.from({ length: 25 }, (_, i) => ({ id: i + 1, name: `O${i + 1}`, amount: 10 })),
        total: 300
      }
    if (p === '/items/orders/aggregate') {
      const fn = ['sum', 'avg', 'min', 'max', 'count'].find((f) => cmd._params?.[f] === 'amount')
      return { data: [{ group: {}, [fn as string]: { amount: fn === 'avg' ? 12.345 : 3000 } }] }
    }
    return { data: null }
  })
}

let root: Root | null = null
beforeEach(() => {
  localStorage.clear()
  calls.length = 0
  window.history.replaceState({ usr: null, idx: 0 }, '', '/records/orders')
})
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

async function settle(n = 20) {
  for (let i = 0; i < n; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000 } } })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin: false } as never}>
            <CollectionBrowserView collection='orders' />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  await settle()
  // the totals read waits for the filters to settle (debounced)
  await act(async () => new Promise((r) => setTimeout(r, 450)))
  await settle()
}

const aggCalls = () => calls.filter((c) => c._path === '/items/orders/aggregate')

describe('CollectionBrowserView totals row', () => {
  it('shows no totals row and asks nothing until a column has one', async () => {
    await mount()
    expect(document.querySelector('[data-cbv-totals]')).toBeNull()
    expect(aggCalls()).toEqual([])
    // the page read never carries footer sums any more
    expect(calls.some((c) => c._path === '/items/orders' && c._params?.agg)).toBe(false)
  })

  it('reads a remembered Sum from the server over the whole filtered set', async () => {
    localStorage.setItem('nvr_cbv_totals_orders', JSON.stringify({ amount: 'sum' }))
    await mount()
    expect(aggCalls()).toHaveLength(1)
    expect(aggCalls()[0]?._params).toEqual({ sum: 'amount' })
    const cell = document.querySelector('[data-cbv-total-cell="amount"]')
    expect(cell?.textContent).toBe('Sum3,000')
    expect(cell?.getAttribute('data-tip')).toBe('Sum of Amount across all 300 matching records')
  })

  it('switches to Average from the column menu and remembers it', async () => {
    localStorage.setItem('nvr_cbv_totals_orders', JSON.stringify({ amount: 'sum' }))
    await mount()
    const menu = Array.from(document.querySelectorAll('[data-cbv-col-menu]')).find((b) =>
      b.getAttribute('aria-label')?.startsWith('Amount')
    ) as HTMLElement
    await act(async () => menu.click())
    await settle()
    await act(async () =>
      (document.querySelector('[data-cbv-col-total="avg"]') as HTMLElement).click()
    )
    await settle()
    expect(aggCalls().at(-1)?._params).toEqual({ avg: 'amount' })
    expect(document.querySelector('[data-cbv-total-cell="amount"]')?.textContent).toBe('Avg12.35')
    expect(JSON.parse(localStorage.getItem('nvr_cbv_totals_orders') ?? '{}')).toEqual({
      amount: 'avg'
    })
    // the page itself was not re-read for it (page 2 is only prefetched)
    expect(calls.filter((c) => c._path === '/items/orders' && c._params?.page !== 2)).toHaveLength(
      1
    )
  })
})
