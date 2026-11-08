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

type Cmd = { _method?: string; _path: string; _params?: Record<string, unknown> }

const TOTAL = 658
function makeClient(opts: { defaultView?: boolean }) {
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
      if (p === '/saved-views')
        return {
          data: opts.defaultView
            ? [
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
            : []
        }
      return { data: null }
    })
  }
  return { client, calls }
}

let root: Root | null = null
let qc: QueryClient
beforeEach(() => {
  sessionStorage.clear()
  // react-router stamps {idx: 0} (no key) on the entry the app first loaded on
  window.history.replaceState({ usr: null, idx: 0 }, '', '/records/workflows')
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000 } } })
})
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

async function settle() {
  for (let i = 0; i < 20; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
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
function pageLabel() {
  const spans = Array.from(document.querySelectorAll('span')).map((s) => s.textContent ?? '')
  return spans.find((t) => /^\d+ \/ \d+$/.test(t.trim()))?.trim()
}
async function clickNext() {
  const next = Array.from(document.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Next')
  )
  await act(async () => next?.click())
  await settle()
}
function popTo(state: unknown) {
  // what the browser hands back on Back: the entry's own state object
  window.history.replaceState(state, '', '/records/workflows')
}

describe('CollectionBrowserView — Back returns to the page the person left', () => {
  for (const defaultView of [false, true]) {
    it(`fresh load → page 2 → record → Back restores page 2 (default view: ${defaultView})`, async () => {
      const { client } = makeClient({ defaultView })
      await mount(client)
      expect(pageLabel()).toBe('1 / 27')
      await clickNext()
      expect(pageLabel()).toBe('2 / 27')
      const listEntry = window.history.state
      unmount()
      window.history.pushState({ usr: null, key: 'rec1', idx: 1 }, '', '/records/workflows/26')
      popTo(listEntry)
      await mount(client)
      expect(pageLabel()).toBe('2 / 27')
      await settle()
      expect(pageLabel()).toBe('2 / 27')
    })
  }
})
