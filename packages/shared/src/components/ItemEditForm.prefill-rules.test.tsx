// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../context'
import { ItemEditForm } from './ItemEditForm'
import type { ActiveLayoutData, CMSField, CMSRelation } from './item-edit/types'

// A new record opened with prefilled values (a deep link such as the MWF click-through,
// ?prefill=) runs the field rules those values trigger, fill-only-when-empty, the way a
// person's own pick does: an IR opened on a unit got its Project Type and Region.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function field(name: string, label: string, over: Partial<CMSField> = {}): CMSField {
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
    ...over
  }
}

const LAYOUT: ActiveLayoutData = {
  layout: {
    id: 7,
    name: 'Order form',
    tab_mode: null,
    validate_before_next: false,
    summary_enabled: false,
    summary_show_all: false,
    ai_enabled: false
  },
  groups: [
    { id: 1, key: 'main', label: 'Main', type: 'section', icon: null, sort: 0, is_collapsed: false }
  ],
  assignments: [
    { field: 'title', sort: 0, group_key: 'main', is_visible: true },
    { field: 'notes', sort: 1, group_key: 'main', is_visible: true }
  ],
  ungrouped_sort: 99
}

const FIELD_CONFIG: CMSField[] = [
  field('title', 'Title', { sort: 0 }),
  field('notes', 'Notes', { sort: 1 })
]

type Cmd = {
  _method?: string
  _path: string
  _params?: Record<string, unknown>
  _body?: unknown
}

const TITLE_DEFAULT = {
  id: 1,
  collection: 'orders',
  field: 'title',
  value: 'Rush order',
  context: {},
  updated_at: '2026-10-28T10:00:00.000Z'
}
// Per-test fixture: what the form is configured with and extra server answers.
let fx: {
  fieldConfig: CMSField[]
  relations: CMSRelation[]
  defaults: unknown[]
  fieldRules: unknown[]
  answer?: (cmd: Cmd) => unknown
} = { fieldConfig: FIELD_CONFIG, relations: [], defaults: [TITLE_DEFAULT], fieldRules: [] }
let serverDraft: unknown = null
function makeClient() {
  const calls: Cmd[] = []
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      const p = cmd._path
      const extra = fx.answer?.(cmd)
      if (extra !== undefined) return extra
      if (p === '/collection-layouts/active') return { data: LAYOUT }
      if (p === '/field-config/orders') return { data: fx.fieldConfig }
      if (p === '/data-model/relations/for/orders') return { data: fx.relations }
      if (p === '/field-rules') return { data: fx.fieldRules }
      if (p === '/collections/orders') return { data: { display_name: 'Orders' } }
      if (p === '/field-defaults/mine') return { data: fx.defaults }
      if (p === '/drafts/orders/new' && serverDraft) return { data: serverDraft }
      if ((cmd._method ?? 'GET').toUpperCase() !== 'GET') return { data: null }
      return { data: [] }
    })
  }
  return { client, calls }
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
  serverDraft = null
  fx = { fieldConfig: FIELD_CONFIG, relations: [], defaults: [TITLE_DEFAULT], fieldRules: [] }
  window.localStorage.clear()
})

async function settle(until: () => boolean) {
  for (let i = 0; i < 80 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
  await act(async () => {
    await new Promise((r) => setTimeout(r, 1000))
  })
}

async function mountNew(initialValues: Record<string, unknown>) {
  const { client, calls } = makeClient()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin: false, userId: 'u1' }}>
            <ItemEditForm collection='orders' documentTitle={false} initialValues={initialValues} />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  return { calls }
}

const input = (f: string) =>
  host.querySelector<HTMLInputElement>(`[data-field="${f}"] input, [data-field="${f}"] textarea`)
const RULE = {
  id: 1,
  collection: 'orders',
  trigger_field: 'title',
  target_field: 'notes',
  is_active: true
}

describe('ItemEditForm prefill runs field rules', () => {
  it('a prefilled trigger fills its empty target', async () => {
    fx.defaults = []
    fx.fieldRules = [RULE]
    fx.answer = (cmd) =>
      cmd._path === '/field-rules/evaluate' ? { data: { notes: 'Filled from title' } } : undefined
    const { calls } = await mountNew({ title: 'Unit 7' })
    await settle(() => input('notes')?.value === 'Filled from title')
    const ev = calls.find((c) => c._path === '/field-rules/evaluate')
    expect(ev?._body).toMatchObject({
      collection: 'orders',
      trigger_field: 'title',
      trigger_value: 'Unit 7'
    })
    expect(input('notes')?.value).toBe('Filled from title')
  })

  it('a prefilled target keeps its value', async () => {
    fx.defaults = []
    fx.fieldRules = [RULE]
    fx.answer = (cmd) =>
      cmd._path === '/field-rules/evaluate' ? { data: { notes: 'Filled from title' } } : undefined
    await mountNew({ title: 'Unit 7', notes: 'Mine' })
    await settle(() => false)
    expect(input('notes')?.value).toBe('Mine')
  })
})
