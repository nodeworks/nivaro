// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../context'
import { CollectionBrowserView } from './CollectionBrowserView'

// Phone width (design review 2026-11-15): below md the list pins only the record's
// identifier; the view's other pins (State, Owners, a right-pinned column) scroll with the
// rest, and come back on a wider screen. The pager is one line.
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
let phone = true
window.matchMedia = ((q: string) => ({
  matches: phone && q === '(max-width: 767px)',
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

const th = (label: string) =>
  Array.from(document.querySelectorAll('thead th')).find((t) =>
    t.textContent?.trim().toLowerCase().startsWith(label)
  ) as HTMLElement | undefined

async function pinAmountRight() {
  for (let i = 0; i < 2; i++) {
    const btn = th('amount')?.querySelector('button[aria-label^="Pin"]') as HTMLButtonElement
    expect(btn).toBeTruthy()
    await act(async () => btn.click())
    await settle(4)
  }
  expect(th('amount')?.querySelector('button[aria-label^="Pin"]')?.getAttribute('aria-label')).toBe(
    'Pinned right — click to unpin'
  )
}

describe('CollectionBrowserView at phone width', () => {
  it('pins only the identifier column; a right pin scrolls', async () => {
    phone = true
    await mount()
    await pinAmountRight()
    expect(th('id')?.className).toContain('sticky')
    expect(th('id')?.style.left).not.toBe('')
    expect(th('amount')?.style.right).toBe('')
    expect(document.querySelector('[data-phone-pager]')).not.toBeNull()
  })

  it("keeps the view's pins on a wider screen", async () => {
    phone = false
    await mount()
    await pinAmountRight()
    expect(th('amount')?.style.right).not.toBe('')
  })
})
