// Army 10: list page 2 → open a record → Back landed on page 1 (both the browser's Back
// and a record's own back arrow). Real react-router browser history over jsdom's
// window.history (push/replace/popstate in the order the app makes them) and the real
// shared CollectionBrowserView, with the rows cached the way a host's 15 s staleTime does.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The shared SOURCE (not the built package admin resolves): loaded by a computed path so
// admin's tsc (ES2020 lib) does not type-check the whole shared tree; packages/shared's
// own tsc covers it.
const SHARED = '../../../packages/shared/src'
type Comp = (props: Record<string, unknown>) => ReactElement
let CollectionBrowserView: Comp
let ItemEditAuthContext: { Provider: Comp }
let NivaroProvider: Comp
let LIST_RETURN_STATE: Record<string, unknown>
beforeAll(async () => {
  const cbv = await import(/* @vite-ignore */ `${SHARED}/components/CollectionBrowserView`)
  const ctx = await import(/* @vite-ignore */ `${SHARED}/context`)
  const mem = await import(/* @vite-ignore */ `${SHARED}/lib/list-page-memory`)
  CollectionBrowserView = cbv.CollectionBrowserView
  ItemEditAuthContext = ctx.ItemEditAuthContext
  NivaroProvider = ctx.NivaroProvider
  LIST_RETURN_STATE = mem.LIST_RETURN_STATE
}, 60_000)

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), info: vi.fn(), error: vi.fn() })
}))

type Cmd = { _path: string; _params?: Record<string, unknown> }
const TOTAL = 658

const client = {
  url: 'http://test',
  getToken: () => null,
  request: vi.fn(async (cmd: Cmd) => {
    const p = cmd._path
    if (p === '/collections/workflows')
      return {
        data: {
          collection: 'workflows',
          display_name: 'Workflows',
          display_template: '{{name}}',
          fields: [
            { field: 'id', type: 'integer', hidden: false },
            { field: 'name', type: 'string', hidden: false }
          ],
          relations: [],
          browser_config: {}
        }
      }
    if (p === '/items/workflows') {
      const page = Number(cmd._params?.page ?? 1)
      return {
        data: Array.from({ length: 25 }, (_, i) => ({
          id: (page - 1) * 25 + i + 1,
          name: `W${(page - 1) * 25 + i + 1}`
        })),
        total: TOTAL
      }
    }
    // A role default view: its conditions land right after mount, like EFP's.
    if (p === '/saved-views')
      return {
        data: [
          {
            id: 9,
            name: 'Open',
            collection: 'workflows',
            user: 'u1',
            is_shared: true,
            is_default: true,
            filters: [
              {
                id: 'f1',
                path: ['name'],
                pathLabels: ['Name'],
                fieldType: 'string',
                op: '_contains',
                value: 'W'
              }
            ],
            sort: null,
            columns: null
          }
        ]
      }
    return { data: null }
  })
}

let root: Root | null = null
let router: ReturnType<typeof createBrowserRouter>

beforeEach(() => {
  sessionStorage.clear()
  // A full page load on the list: no react-router state on the entry yet.
  window.history.replaceState(null, '', '/records/workflows')
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000 } } })
  router = createBrowserRouter([
    {
      path: '/records/workflows',
      element: (
        <CollectionBrowserView
          collection='workflows'
          onOpenItem={(id: string | number) => void router.navigate(`/records/workflows/${id}`)}
        />
      )
    },
    { path: '/records/workflows/:id', element: <div data-record='1'>record</div> }
  ])
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root?.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin: false } as never}>
            <RouterProvider router={router} />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
})
afterEach(() => {
  act(() => root?.unmount())
  root = null
  router.dispose()
  document.body.replaceChildren()
})

async function settle() {
  for (let i = 0; i < 25; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}
function pageLabel() {
  return Array.from(document.querySelectorAll('span'))
    .map((s) => (s.textContent ?? '').trim())
    .find((t) => /^\d+ \/ \d+$/.test(t))
}
async function clickNext() {
  const next = Array.from(document.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Next')
  )
  await act(async () => next?.click())
  await settle()
}
async function browserBack() {
  await act(async () => {
    const popped = new Promise((r) => window.addEventListener('popstate', r, { once: true }))
    window.history.back()
    await popped
  })
  await settle()
}

describe('list page memory over real react-router history', () => {
  it('browser Back from a record opened on page 2 shows page 2, twice over', async () => {
    await settle()
    expect(pageLabel()).toBe('1 / 27')
    await clickNext()
    expect(pageLabel()).toBe('2 / 27')
    await act(async () => router.navigate('/records/workflows/26'))
    await settle()
    expect(document.querySelector('[data-record]')).not.toBeNull()
    await browserBack()
    expect(window.location.pathname).toBe('/records/workflows')
    expect(pageLabel()).toBe('2 / 27')
    // and again from the restored entry (page 3 this time)
    await clickNext()
    expect(pageLabel()).toBe('3 / 27')
    await act(async () => router.navigate('/records/workflows/51'))
    await settle()
    await browserBack()
    expect(pageLabel()).toBe('3 / 27')
  })

  it("a record's back arrow (a new entry carrying LIST_RETURN_STATE) shows the page left", async () => {
    await settle()
    await clickNext()
    expect(pageLabel()).toBe('2 / 27')
    await act(async () => router.navigate('/records/workflows/26'))
    await settle()
    await act(async () => router.navigate('/records/workflows', { state: LIST_RETURN_STATE }))
    await settle()
    expect(pageLabel()).toBe('2 / 27')
  })

  it('a plain visit to the list (nav link) starts on page 1', async () => {
    await settle()
    await clickNext()
    await act(async () => router.navigate('/records/workflows/26'))
    await settle()
    await act(async () => router.navigate('/records/workflows'))
    await settle()
    expect(pageLabel()).toBe('1 / 27')
  })

  it('a reload of the list entry keeps its page', async () => {
    await settle()
    await clickNext()
    // a reload keeps history.state and sessionStorage; the list mounts afresh
    act(() => root?.unmount())
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const fresh = createBrowserRouter([
      { path: '/records/workflows', element: <CollectionBrowserView collection='workflows' /> }
    ])
    act(() =>
      root?.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <ItemEditAuthContext.Provider value={{ isAdmin: false } as never}>
              <RouterProvider router={fresh} />
            </ItemEditAuthContext.Provider>
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    await settle()
    expect(pageLabel()).toBe('2 / 27')
    fresh.dispose()
  })
})
