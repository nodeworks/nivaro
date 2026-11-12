// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../context'
import { ItemEditForm } from './ItemEditForm'
import type { CMSField } from './item-edit/types'

// First week live: a record page opened on a system table (a person's row in nivaro_users,
// reached from a link) sent every read a business record gets. The API refuses those for
// system tables by name, so each open logged a row of 400s, a 403 and a 404: last touch,
// origin, record links, "referenced by", the recap touch, the integrity check, the pipeline
// and its SLA clock. The page knows the table is a system table and does not ask.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn()
  })
}))

function field(name: string, label: string, extra: Partial<CMSField> = {}): CMSField {
  return {
    field: name,
    type: 'string',
    interface: 'input',
    label,
    required: false,
    hidden: false,
    readonly: false,
    sort: 0,
    group_key: 'main',
    options: null,
    computed_formula: null,
    computed_type: null,
    note: null,
    placeholder: null,
    repeater_schema: null,
    dependency_config: null,
    layout_assigned: true,
    ...extra
  }
}

type Cmd = { _method?: string; _path: string; _params?: Record<string, unknown> }

/** What the API refuses for a system table, as it refuses it. */
const REFUSED_FOR_SYSTEM: Array<[RegExp, number]> = [
  [/^\/last-touch\//, 400],
  [/^\/provenance\//, 400],
  [/^\/record-links\//, 400],
  [/^\/referenced-by\//, 400],
  [/^\/record-views\//, 400],
  [/^\/config-conformance\/record\//, 400],
  [/^\/access-explain\//, 400],
  [/^\/pipelines\/instance\//, 403],
  [/^\/sla\/status\//, 404]
]

function makeClient(collection: string, id: string) {
  const calls: Cmd[] = []
  const refused: string[] = []
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      const p = cmd._path
      const system = /^(nivaro_|directus_)/i.test(collection)
      const hit = REFUSED_FOR_SYSTEM.find(([re]) => re.test(p))
      if (system && hit && p.includes(`/${collection}/`)) {
        refused.push(`${hit[1]} ${p}`)
        throw Object.assign(new Error('Not a valid collection'), { status: hit[1] })
      }
      if (p === `/items/${collection}/${id}`) return { data: { id, title: 'First' } }
      if (p === `/pipelines/instance/${collection}/${id}`)
        return {
          data: { instance: { current_state: 's1' }, states: [], available_transitions: [] }
        }
      if (p === '/collection-layouts/active')
        return {
          data: {
            layout: { id: 7, name: 'Form', slug: 'form' },
            groups: [{ id: 1, key: 'main', label: 'Main', type: 'section', icon: null, sort: 0 }],
            assignments: [{ field: 'title', sort: 0, group_key: 'main', is_visible: true }],
            ungrouped_sort: 99
          }
        }
      if (p === `/field-config/${collection}`) return { data: [field('title', 'Title')] }
      if (p === `/data-model/relations/for/${collection}`) return { data: [] }
      if (p === `/collections/${collection}`)
        return { data: { display_name: 'Things', singular: 'Thing' } }
      if ((cmd._method ?? 'GET').toUpperCase() !== 'GET') return { data: null }
      return { data: [] }
    })
  }
  return { client, calls, refused }
}

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}
const g = globalThis as Record<string, unknown>
g.ResizeObserver ??= NoopObserver
g.IntersectionObserver ??= NoopObserver
window.matchMedia ??= ((q: string) => ({
  matches: false,
  media: q,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false
})) as typeof window.matchMedia
Element.prototype.scrollIntoView ??= () => {}
g.CSS ??= { escape: (v: string) => v }

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

const FULL_PAGE = {
  showHeader: true,
  showItemActions: true,
  showRevisions: true,
  showPipeline: true,
  showWorkflow: true,
  showComments: true,
  showTasks: true,
  showLockBanner: true
} as const

async function open(collection: string, id: string) {
  const made = makeClient(collection, id)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={made.client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin: true, userId: 'U1' }}>
            <ItemEditForm
              collection={collection}
              itemId={id}
              documentTitle={false}
              {...FULL_PAGE}
            />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  // The record, its layout and fields land; then everything they unlock goes out.
  for (let i = 0; i < 100; i++) {
    if (made.calls.some((c) => c._path === `/field-config/${collection}`)) break
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
  for (let i = 0; i < 30; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15))
    })
  return made
}

describe('a record page on a system table', () => {
  it('sends none of the reads the API refuses for system tables', async () => {
    const { refused, calls } = await open('nivaro_users', 'U9')
    // The page itself still loads: the record and its form.
    expect(calls.some((c) => c._path === '/items/nivaro_users/U9')).toBe(true)
    expect(calls.some((c) => c._path === '/field-config/nivaro_users')).toBe(true)
    expect(refused).toEqual([])
  })

  it('a business record still gets every one of them', async () => {
    const { calls } = await open('orders', '1')
    const paths = calls.map((c) => c._path)
    expect(paths).toContain('/last-touch/orders/1')
    expect(paths).toContain('/provenance/orders/1')
    expect(paths).toContain('/record-links/orders/1')
    expect(paths).toContain('/referenced-by/orders/1')
    expect(paths).toContain('/record-views/orders/1/touch')
    expect(paths).toContain('/config-conformance/record/orders/1')
    expect(paths).toContain('/pipelines/instance/orders/1')
  })
})
