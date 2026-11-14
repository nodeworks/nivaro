// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../context'
import { decodeListLink, LIST_LINK_PARAM } from '../lib/list-link'
import { getNavTrail, recordNavigation, resetNavTrailForTests } from '../lib/nav-trail'
import { CollectionBrowserView } from './CollectionBrowserView'

/**
 * #21 Back to the exact list — the collection browser keeps what it shows on its own address
 * (`?lv=`), so Back from a record (or a record's back arrow opening that address) brings back
 * the same saved view and page, and the trail names it ("Open · page 2").
 */
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

const TOTAL = 658
const VIEWS = [
  {
    id: 9,
    name: 'Everything',
    collection: 'workflows',
    user: 'u1',
    is_shared: true,
    is_default: true,
    filters: [],
    sort: null,
    columns: null
  },
  {
    id: 10,
    name: 'My open',
    collection: 'workflows',
    user: 'u1',
    is_shared: false,
    is_default: false,
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
    sort: '-id',
    columns: null
  }
]

function makeClient() {
  const calls: Cmd[] = []
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
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
        const rows = Array.from({ length: 25 }, (_, i) => ({
          id: (page - 1) * 25 + i + 1,
          name: `W${(page - 1) * 25 + i + 1}`
        }))
        return { data: rows, total: TOTAL }
      }
      if (p === '/saved-views') return { data: VIEWS }
      return { data: null }
    })
  }
  return { client, calls }
}

let root: Root | null = null
let qc: QueryClient
beforeEach(() => {
  sessionStorage.clear()
  resetNavTrailForTests()
  window.history.replaceState({ usr: null, idx: 0, key: 'list1' }, '', '/records/workflows')
  recordNavigation({ action: 'PUSH', key: 'list1', idx: 0, path: '/records/workflows' })
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000 } } })
})
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

async function settle() {
  for (let i = 0; i < 25; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}
async function mount(client: unknown) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin: false } as never}>
            <CollectionBrowserView collection='workflows' />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  await settle()
}
function unmount() {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
}
const pageLabel = () =>
  Array.from(document.querySelectorAll('span'))
    .map((s) => s.textContent ?? '')
    .find((t) => /^\d+ \/ \d+$/.test(t.trim()))
    ?.trim()
const activePill = () => document.querySelector('[data-view-pill][data-active="true"]')
async function click(el: Element | null | undefined) {
  await act(async () => (el as HTMLElement | null)?.click())
  await settle()
}
const lvOnAddress = () =>
  decodeListLink(new URLSearchParams(window.location.search).get(LIST_LINK_PARAM), 'cbv:workflows')

describe('CollectionBrowserView — back to the exact list', () => {
  it('the default state keeps a clean address; a view + page ride it and come back', async () => {
    const { client } = makeClient()
    await mount(client)
    // Settled on the default view: nothing on the address.
    expect(activePill()?.getAttribute('data-view-pill')).toBe('9')
    expect(window.location.search).toBe('')

    // Pick "My open", go to page 2.
    const myOpen = document.querySelector('[data-view-pill="10"] button')
    await click(myOpen)
    expect(activePill()?.getAttribute('data-view-pill')).toBe('10')
    await click(
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Next'))
    )
    expect(pageLabel()).toBe('2 / 27')
    const state = lvOnAddress()
    expect(state).toMatchObject({ v: 10, p: 2, s: '-id' })
    // The trail names what the list shows, for the crumb that returns here.
    expect(getNavTrail().entries[0].detail).toBe('My open · page 2')
    // The trail's copy of the address follows the list's.
    expect(getNavTrail().entries[0].path).toBe(`/records/workflows${window.location.search}`)

    // Open a record, then come back to that address (Back, a crumb, a record's back arrow).
    const listAddress = window.location.pathname + window.location.search
    unmount()
    window.history.pushState({ usr: null, key: 'rec1', idx: 1 }, '', '/records/workflows/26')
    window.history.replaceState({ usr: null, key: 'list2', idx: 2 }, '', listAddress)
    await mount(client)
    expect(pageLabel()).toBe('2 / 27')
    expect(activePill()?.getAttribute('data-view-pill')).toBe('10')
    // The address still says so (a reload keeps it).
    expect(lvOnAddress()).toMatchObject({ v: 10, p: 2 })
  }, 20_000)

  it('a view the reader does not have is ignored (its settings still apply)', async () => {
    const { client } = makeClient()
    window.history.replaceState(
      { usr: null, idx: 0, key: 'list1' },
      '',
      `/records/workflows?${LIST_LINK_PARAM}=${btoa(
        JSON.stringify({ v: 1, k: 'cbv:workflows', s: { v: 999, p: 3 } })
      )
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')}`
    )
    await mount(client)
    expect(pageLabel()).toBe('3 / 27')
    expect(activePill()).toBeNull()
  }, 20_000)
})
