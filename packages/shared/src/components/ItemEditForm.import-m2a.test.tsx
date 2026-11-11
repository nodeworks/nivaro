// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../context'
import { ItemEditForm } from './ItemEditForm'
import type { CMSField, CMSRelation } from './item-edit/types'

// army11 (f2 / fix11-ir-bom): a BOM upload's internal_contact did not fill the
// IR's Ship-To Contact. The parse answers `m2m.internal_contact = ['<user id>']`
// for an M2A junction (inventory_request_internal_contact: item + collection,
// allowed additional_emails,directus_users). This feeds that exact shape into a
// new form and follows it to the create.

vi.mock('sonner', () => ({
  toast: Object.assign((..._a: unknown[]) => undefined, {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn()
  }),
  Toaster: () => null
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const USER = '46A4897B-0B6E-4F3B-9C52-1D2E3F405162'

const base = {
  type: 'string',
  interface: 'input',
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
  layout_assigned: true
}
const FIELDS = [
  { ...base, field: 'title', label: 'Title' },
  {
    ...base,
    field: 'internal_contact',
    label: 'Ship-To Contact',
    type: 'alias',
    interface: 'select-multiple-m2m',
    required: true,
    options: JSON.stringify({ max_values: 1 })
  }
] as unknown as CMSField[]
// The two relations exactly as EFP stores them (ids 439 / 440).
const RELATIONS = [
  {
    id: 439,
    many_collection: 'inventory_request_internal_contact',
    many_field: 'item',
    one_collection: null,
    one_field: null,
    one_collection_field: 'collection',
    one_allowed_collections: 'additional_emails,directus_users',
    junction_field: null
  },
  {
    id: 440,
    many_collection: 'inventory_request_internal_contact',
    many_field: 'inventory_request_id',
    one_collection: 'inventory_request',
    one_field: 'internal_contact',
    junction_field: 'item'
  }
] as unknown as CMSRelation[]

type Cmd = { _method?: string; _path: string; _body?: Record<string, unknown> }

function makeServer() {
  const created: Array<Record<string, unknown>> = []
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      const p = cmd._path
      const method = (cmd._method ?? 'GET').toUpperCase()
      if (p === '/collection-layouts/active')
        return {
          data: {
            layout: { id: 23, name: 'Non-Unit', slug: 'inv-non-unit' },
            groups: [{ id: 1, key: 'main', label: 'Main', type: 'section', icon: null, sort: 0 }],
            assignments: FIELDS.map((f, i) => ({
              field: f.field,
              sort: i + 1,
              group_key: 'main',
              is_visible: true
            })),
            ungrouped_sort: 99
          }
        }
      if (p === '/field-config/inventory_request') return { data: FIELDS }
      if (p === '/collections/inventory_request')
        return { data: { display_name: 'Inventory Requests', singular: 'Inventory Request' } }
      if (p === '/data-model/relations/for/inventory_request') return { data: RELATIONS }
      if (p === `/items/nivaro_users/${USER}` || p === `/users/${USER}`)
        return { data: { id: USER, first_name: 'Kristina', last_name: 'Davison' } }
      if (method === 'POST' && p === '/items/inventory_request') {
        const body = cmd._body ?? {}
        created.push(body)
        return { data: { id: 37900, ...body } }
      }
      return { data: method === 'GET' ? [] : null }
    })
  }
  return { client, created }
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
async function settle(until: () => boolean, rounds = 150) {
  for (let i = 0; i < rounds && !until(); i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
}

describe('BOM upload → Ship-To Contact (M2A internal_contact)', () => {
  it('the parsed contact is staged, shown and sent with the create', async () => {
    const srv = makeServer()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let save: (() => void) | null = null
    let links = 0
    await act(async () =>
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={srv.client as never}>
            <ItemEditAuthContext.Provider value={{ isAdmin: false, userId: 'KD' }}>
              <ItemEditForm
                collection='inventory_request'
                documentTitle={false}
                initialImportResult={{
                  values: { title: 'BOM ARMY11' },
                  lines: [],
                  issues: [],
                  file_id: null,
                  line_target_field: null,
                  nested_relation: null,
                  m2m: { internal_contact: [USER] }
                }}
                onDirtyChange={(_d, s) => {
                  links = s?.links ?? 0
                }}
                registerSaveHandler={(fn) => {
                  save = fn
                }}
              />
            </ItemEditAuthContext.Provider>
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    // Wait for the fields too: a save pressed before the form's fields load is
    // refused on purpose ("The form is still loading", INV-37593 guard).
    await settle(
      () =>
        links > 0 &&
        save != null &&
        !!host.textContent?.includes('Ship-To Contact') &&
        !!host.textContent?.includes('Title')
    )
    expect(links).toBe(1)
    await act(async () => save?.())
    await settle(() => srv.created.length > 0, 250)
    expect(srv.created).toHaveLength(1)
    const sent = JSON.stringify(srv.created[0].internal_contact ?? null).toLowerCase()
    expect(sent).toContain(USER.toLowerCase())
  })
})
