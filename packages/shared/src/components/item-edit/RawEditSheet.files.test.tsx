// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../../context'
import { RawEditSheet } from './RawEditSheet'
import type { CMSField, CMSRelation } from './types'

// Raw edit lists every alias field with the generic link picker. A record's files hang off a
// junction to the files table, which is read through /files and is never a collection the
// items API serves: the picker's own reads (GET /collections/nivaro_files, GET
// /items/nivaro_files?filter=…&picker=1) could only answer 404, on every open of a record
// that has files. The sheet says where files are edited and asks nothing.
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

const rel = (r: Partial<CMSRelation>) => r as CMSRelation

const RELATIONS: CMSRelation[] = [
  // orders.files ↔ files through orders_files
  rel({
    id: 1,
    many_collection: 'orders_files',
    many_field: 'orders_id',
    one_collection: 'orders',
    one_field: 'files',
    junction_field: 'directus_files_id'
  }),
  rel({
    id: 2,
    many_collection: 'orders_files',
    many_field: 'directus_files_id',
    one_collection: 'nivaro_files',
    one_field: null,
    junction_field: 'orders_id'
  }),
  // orders.tags ↔ tags through orders_tags: an ordinary link field
  rel({
    id: 3,
    many_collection: 'orders_tags',
    many_field: 'orders_id',
    one_collection: 'orders',
    one_field: 'tags',
    junction_field: 'tags_id'
  }),
  rel({
    id: 4,
    many_collection: 'orders_tags',
    many_field: 'tags_id',
    one_collection: 'tags',
    one_field: null,
    junction_field: 'orders_id'
  })
]

type Cmd = { _method?: string; _path: string; _params?: Record<string, unknown> }

function makeClient() {
  const calls: Cmd[] = []
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      const p = cmd._path
      if (/nivaro_files/.test(p)) throw Object.assign(new Error('Not found'), { status: 404 })
      if (p === '/field-config/orders')
        return {
          data: [
            field('title', 'Title'),
            field('files', 'Files', { interface: 'files', sort: 1 }),
            field('tags', 'Tags', { interface: 'list-m2m', sort: 2 })
          ]
        }
      if (p === '/collections/orders') return { data: { relations: RELATIONS } }
      if (p === '/items/orders/1') return { data: { id: 1, title: 'First' } }
      if (p === '/items/orders_files') return { data: [{ id: 10, directus_files_id: 'F1' }] }
      if (p === '/items/orders_tags') return { data: [{ id: 20, tags_id: 5 }] }
      if (p === '/collections/tags') return { data: { display_template: '{{name}}' } }
      if (p === '/items/tags') return { data: [{ id: 5, name: 'Urgent' }] }
      return { data: [] }
    })
  }
  return { client, calls }
}

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
const g = globalThis as Record<string, unknown>
g.ResizeObserver ??= NoopObserver
g.IntersectionObserver ??= NoopObserver
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
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

describe('raw edit on a record with files', () => {
  it('never reads the files table as a collection, and still offers the other link fields', async () => {
    const { client, calls } = makeClient()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () =>
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <ItemEditAuthContext.Provider value={{ isAdmin: true, userId: 'U1' }}>
              <RawEditSheet collection='orders' itemId='1' open onClose={() => {}} />
            </ItemEditAuthContext.Provider>
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    for (let i = 0; i < 60; i++) {
      if (calls.some((c) => c._path === '/items/orders_tags')) break
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10))
      })
    }
    for (let i = 0; i < 20; i++)
      await act(async () => {
        await new Promise((r) => setTimeout(r, 15))
      })
    const paths = calls.map((c) => c._path)
    // The ordinary link field works as before.
    expect(paths).toContain('/items/orders_tags')
    expect(paths.filter((p) => /nivaro_files/.test(p))).toEqual([])
    expect(document.body.querySelector('[data-raw-field="files"]')?.textContent).toMatch(
      /edit through the normal form/i
    )
  })
})
