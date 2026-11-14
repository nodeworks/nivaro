// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../context'
import { CollectionBrowserView } from './CollectionBrowserView'

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

const money = { type: 'number', decimals: 2, thousands: true, prefix: '$' }
type Cmd = { _method?: string; _path: string; _params?: Record<string, unknown>; _body?: unknown }
const calls: Cmd[] = []
let view: Record<string, unknown>
const freshView = () => ({
  id: 11,
  name: 'Default',
  user: 'someone-else',
  is_shared: true,
  is_default: true,
  filters: [],
  sort: null,
  columns: [
    { key: 'name', label: 'Name', pin: 'left' },
    { key: 'req', label: 'Requisition Amount', format: money, agg: 'sum' },
    { key: 'ft', label: 'Forecast Total', format: money },
    { key: 'left', label: 'Left to Forecast', format: money },
    { key: 'open', label: 'PO Open Amount', format: money }
  ]
})
const client = {
  url: 'http://test',
  getToken: () => null,
  request: vi.fn(async (cmd: Cmd) => {
    calls.push(cmd)
    const p = cmd._path
    if (p === '/collections/wf')
      return {
        data: {
          collection: 'wf',
          display_name: 'Workflows',
          display_template: '{{name}}',
          fields: [
            { field: 'id', type: 'integer', hidden: false },
            { field: 'name', type: 'string', hidden: false },
            {
              field: 'req',
              type: 'decimal',
              hidden: false,
              computed_type: 'rollup',
              computed_formula: '{"sources":[]}',
              computed_store: true
            },
            {
              field: 'ft',
              type: 'decimal',
              hidden: false,
              computed_type: 'rollup',
              computed_formula: '{"sources":[]}',
              computed_store: true
            },
            {
              field: 'left',
              type: 'decimal',
              hidden: false,
              computed_type: 'read',
              computed_formula: 'item.req - item.ft',
              computed_store: false,
              sql_filterable: true
            },
            {
              field: 'open',
              type: 'decimal',
              hidden: false,
              computed_type: 'rollup',
              computed_formula: '{"sources":[]}',
              computed_store: false
            }
          ],
          relations: [],
          browser_config: {}
        }
      }
    if (p === '/saved-views' && cmd._method !== 'POST') return { data: [view] }
    if (p === '/saved-views/11' && cmd._method === 'PATCH') {
      view = { ...view, ...(cmd._body as object) }
      return { data: view }
    }
    if (p === '/items/wf')
      return {
        data: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, name: `W${i + 1}`, req: 10 })),
        total: 5
      }
    if (p === '/items/wf/aggregate') {
      const field = String(cmd._params?.sum ?? '')
      const sums: Record<string, number> = { req: 50, ft: 20 }
      // the server totals stored columns only (a calculated field has no column)
      if (!(field in sums)) throw Object.assign(new Error('no stored field'), { status: 400 })
      return { data: [{ group: {}, sum: { [field]: sums[field] } }] }
    }
    return { data: null }
  })
}

let root: Root | null = null
beforeEach(() => {
  localStorage.clear()
  calls.length = 0
  view = freshView()
  window.history.replaceState({ usr: null, idx: 0 }, '', '/records/wf')
})
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

async function settle(n = 25) {
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
          <ItemEditAuthContext.Provider value={{ isAdmin: true } as never}>
            <CollectionBrowserView collection='wf' />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  await settle()
  await act(async () => new Promise((r) => setTimeout(r, 450)))
  await settle()
}
async function remount() {
  act(() => root?.unmount())
  document.body.replaceChildren()
  await mount()
}

const totalCells = () =>
  Array.from(document.querySelectorAll('[data-cbv-total-cell]')).map((c) =>
    c.getAttribute('data-cbv-total-cell')
  )
const menuFor = (label: string) =>
  Array.from(document.querySelectorAll('[data-cbv-col-menu]')).find((b) =>
    b.getAttribute('aria-label')?.startsWith(label)
  ) as HTMLElement | undefined

async function setSum(label: string) {
  const menu = menuFor(label)
  if (!menu) return false
  await act(async () => menu.click())
  await settle()
  const sum = document.querySelector('[data-cbv-col-total="sum"]') as HTMLElement | null
  if (!sum) return false
  await act(async () => sum.click())
  await settle()
  return true
}

const patchedAggs = () =>
  (
    (calls.filter((c) => c._method === 'PATCH').at(-1)?._body as {
      columns: Array<string | { key: string; agg?: string }>
    }) ?? { columns: [] }
  ).columns
    .filter((c): c is { key: string; agg: string } => typeof c !== 'string' && !!c.agg)
    .map((c) => `${c.key}:${c.agg}`)
const stored = () => JSON.parse(localStorage.getItem('nvr_cbv_totals_wf') ?? 'null')
const cellText = (key: string) =>
  document.querySelector(`[data-cbv-total-cell="${key}"]`)?.textContent ?? null
async function updateView() {
  await act(async () => (document.querySelector('[data-view-update="11"]') as HTMLElement).click())
  await settle()
}

describe('list totals and saved views (2026-11-14)', () => {
  it('a view update keeps every total on screen, through a reload of an older address', async () => {
    await mount()
    expect(totalCells()).toEqual(['req'])
    // a sort writes the list's address (?lv=) before the totals change — the address used to
    // keep the totals it was written with, and a reload put them back over the saved view
    const nameTh = Array.from(document.querySelectorAll('th[aria-sort]')).find((t) =>
      t.textContent?.startsWith('Name')
    ) as HTMLElement
    await act(async () => nameTh.click())
    await settle()
    expect(window.location.search).toContain('lv=')
    expect(await setSum('Forecast Total')).toBe(true)
    expect(await setSum('Left to Forecast')).toBe(true)
    expect(totalCells()).toEqual(['req', 'ft', 'left'])
    // Left to Forecast = Requisition Amount − Forecast Total: summed from their sums
    expect(cellText('left')).toBe('Sum$30.00')
    expect(
      document.querySelector('[data-cbv-total-cell="left"]')?.getAttribute('data-tip')
    ).toContain('worked out as Requisition Amount − Forecast Total')
    await updateView()
    expect(patchedAggs()).toEqual(['req:sum', 'ft:sum', 'left:sum'])
    await remount()
    expect(totalCells()).toEqual(['req', 'ft', 'left'])
    // the pill is active again; its ↺ writes the same totals, not an older set
    await updateView()
    expect(patchedAggs()).toEqual(['req:sum', 'ft:sum', 'left:sum'])
  })

  it('a column the list cannot total says why instead of offering Σ', async () => {
    await mount()
    const menu = menuFor('PO Open Amount') as HTMLElement
    await act(async () => menu.click())
    await settle()
    expect(document.querySelector('[data-cbv-col-total="sum"]')).toBeNull()
    const why = document.querySelector('[data-cbv-col-total-unavailable]')
    expect(why?.textContent).toBe('No total for this column')
    expect(why?.getAttribute('data-tip')).toMatch(/linked records/)
    // a calculated sum offers Sum alone, and says how it is worked out
    await act(async () => menu.click())
    await settle()
    await act(async () => (menuFor('Left to Forecast') as HTMLElement).click())
    await settle()
    expect(
      Array.from(document.querySelectorAll('[data-cbv-col-total]')).map((b) =>
        b.getAttribute('data-cbv-col-total')
      )
    ).toEqual(['off', 'sum'])
    expect(document.querySelector('[data-cbv-col-total-note]')?.textContent).toBe(
      'Sum only: worked out as Requisition Amount − Forecast Total.'
    )
  })

  it('a view’s totals never replace the person’s own choices', async () => {
    await mount()
    expect(await setSum('Forecast Total')).toBe(true)
    expect(stored()).toEqual({ v: 2, o: { ft: 'sum' } })
    window.history.replaceState({ usr: null, idx: 0 }, '', '/records/wf')
    await remount()
    // the view states Requisition Amount; the person's Forecast Total stays on top
    expect(totalCells()).toEqual(['req', 'ft'])
    expect(stored()).toEqual({ v: 2, o: { ft: 'sum' } })
    // turning the view's own total off is the person's choice too, and lasts
    await act(async () => (menuFor('Requisition Amount') as HTMLElement).click())
    await settle()
    await act(async () =>
      (document.querySelector('[data-cbv-col-total="off"]') as HTMLElement).click()
    )
    await settle()
    expect(totalCells()).toEqual(['ft'])
    window.history.replaceState({ usr: null, idx: 0 }, '', '/records/wf')
    await remount()
    expect(totalCells()).toEqual(['ft'])
    // choosing the view again keeps them
    const pill = document.querySelector('[data-view-pill="11"] button') as HTMLElement
    await act(async () => pill.click())
    await settle()
    expect(totalCells()).toEqual(['ft'])
  })

  it('reads the earlier stored shape as the person’s choices', async () => {
    localStorage.setItem('nvr_cbv_totals_wf', JSON.stringify({ ft: 'sum' }))
    await mount()
    expect(totalCells()).toEqual(['req', 'ft'])
  })

  it('saving the view with the totals on screen hands those choices back to the view', async () => {
    await mount()
    expect(await setSum('Forecast Total')).toBe(true)
    expect(stored()).toEqual({ v: 2, o: { ft: 'sum' } })
    await updateView()
    expect(patchedAggs()).toEqual(['req:sum', 'ft:sum'])
    expect(stored()).toBeNull()
    window.history.replaceState({ usr: null, idx: 0 }, '', '/records/wf')
    await remount()
    expect(totalCells()).toEqual(['req', 'ft'])
  })
})
