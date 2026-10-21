// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../../context'
import { type LayoutBundle, newGroup, newPlacement } from '../../../lib/layout-ops'
import { type LayoutEditorHost, LayoutEditorHostContext } from '../host'
import { LayoutOverview } from '../overview/LayoutOverview'
import type { OverviewRow } from '../overview/types'
import type { CrossformResponse, FieldSearchResponse } from './crossform-api'

// The canvas renders the real record form; these tests are about the overview.
vi.mock('../EditorCanvas', () => ({
  EditorCanvas: ({ bundle }: { bundle: LayoutBundle }) => (
    <div data-stub-canvas={String(bundle.layout.id)} />
  )
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const row = (layout_id: number, name: string, over: Partial<OverviewRow> = {}): OverviewRow => ({
  layout_id,
  name,
  layout_type: 'grouped',
  slug: null,
  section: 'forms',
  reason: { kind: 'default' },
  is_default: false,
  new_menu: null,
  shape: { groups: 1, steps_or_tabs: 0, fields: 3 },
  references: [],
  warnings: [],
  ...over
})

const ROWS = [row(1, 'Standard', { is_default: true }), row(2, 'Sparing Order')]

const CROSSFORM: CrossformResponse = {
  thumbs: {
    '1': { blocks: [{ kind: 'section', label: 'Main', rows: [[6, 6], [12]] }], more: 0 },
    '2': { blocks: [{ kind: 'steps', label: 'Steps', count: 3, rows: [[12]] }], more: 1 }
  },
  labels: [
    {
      field: 'vendor',
      field_label: 'Vendor',
      variants: [
        { label: 'Vendor', layouts: [{ id: 1, name: 'Standard' }] },
        { label: 'Supplier', layouts: [{ id: 2, name: 'Sparing Order' }] }
      ]
    }
  ],
  duplicates: [
    {
      a: { id: 1, name: 'Standard' },
      b: { id: 2, name: 'Sparing Order' },
      similarity: 0.94,
      identical: 30,
      only_a: 0,
      only_b: 1,
      differing: 1,
      parent_id: 1,
      can_link: true
    }
  ]
}

const SEARCH: FieldSearchResponse = {
  fields: [
    {
      collection: 'orders',
      field: 'vendor',
      label: 'Vendor',
      placements: [
        {
          layout_id: 2,
          layout_name: 'Sparing Order',
          layout_type: 'grouped',
          section: 'Steps › Details',
          width: 6,
          visible: true,
          label: 'Supplier',
          label_hidden: false,
          inherited_from: null
        }
      ]
    },
    {
      collection: 'invoices',
      field: 'vendor',
      label: 'Vendor',
      placements: [
        {
          layout_id: 9,
          layout_name: 'Invoice',
          layout_type: 'grouped',
          section: null,
          width: 12,
          visible: true,
          label: null,
          label_hidden: false,
          inherited_from: null
        }
      ]
    }
  ],
  truncated: false
}

function bundle(id: number, label?: string): LayoutBundle {
  return {
    layout: { id, collection: 'orders', layout_type: 'grouped', parent_layout_id: null },
    groups: [newGroup('main', 'Main', 'section', null)],
    placements: [
      { ...newPlacement('vendor', 'main'), overrides: label ? { label } : null },
      { ...newPlacement('amount', 'main'), sort: 1 },
      ...(id === 2 ? [{ ...newPlacement('notes', 'main'), sort: 2 }] : [])
    ],
    rev: `rev-${id}`
  }
}

type Cmd = { _method: string; _path: string; _params?: Record<string, unknown>; _body?: unknown }

let root: Root
let el: HTMLDivElement

beforeEach(() => {
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  document.body.innerHTML = ''
})

function makeClient() {
  const calls: Cmd[] = []
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._path === '/collection-layouts/overview')
        return { data: { rows: ROWS, warning: null } }
      if (cmd._path === '/collection-layouts/crossform') return { data: CROSSFORM }
      if (cmd._path === '/collection-layouts/field-search') return { data: SEARCH }
      const b = cmd._path.match(/^\/collection-layouts\/(\d+)\/bundle$/)
      if (b) return bundle(Number(b[1]), Number(b[1]) === 2 ? 'Supplier' : undefined)
      const ops = cmd._path.match(/^\/collection-layouts\/(\d+)\/ops$/)
      if (ops) return bundle(Number(ops[1]))
      if (cmd._path.startsWith('/field-config/'))
        return { data: [{ field: 'vendor', label: 'Vendor' }] }
      if (cmd._path.startsWith('/collections/')) return { data: { display_template: null } }
      return { data: null }
    })
  }
  return { client, calls }
}

async function settle(until: () => boolean) {
  for (let i = 0; i < 60 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

const navigate = vi.fn()
const HOST: LayoutEditorHost = {
  isAdmin: true,
  navigate,
  warning: null,
  recordLink: () => '',
  layoutLink: (col, id) => `/data-model/${col}?tab=groups&layout=${id}`
}

async function mount(client: { request: unknown }, onOpen = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <LayoutEditorHostContext.Provider value={HOST}>
            <LayoutOverview collection='orders' onOpen={onOpen} />
          </LayoutEditorHostContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  return onOpen
}

const text = () => document.body.textContent ?? ''
function button(label: string | RegExp): HTMLButtonElement {
  const hit = Array.from(document.body.querySelectorAll('button')).find((b) =>
    typeof label === 'string'
      ? b.textContent?.trim() === label || b.getAttribute('aria-label') === label
      : label.test(b.textContent ?? '')
  )
  if (!hit) throw new Error(`No button ${label}`)
  return hit
}
async function click(b: HTMLElement) {
  await act(async () => {
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('across forms on the overview', () => {
  it('draws a sketch of each form', async () => {
    const { client } = makeClient()
    await mount(client)
    await settle(() => document.querySelectorAll('[data-layout-thumb]').length === 2)
    const thumbs = document.querySelectorAll('[data-layout-thumb]')
    expect(thumbs).toHaveLength(2)
    expect(thumbs[0].getAttribute('aria-label')).toBe('Sketch of Standard: 1 section')
    expect(thumbs[1].querySelectorAll('circle').length).toBeGreaterThanOrEqual(3)
  })

  it('unifies a label on every form that differs, one batch per form', async () => {
    const { client, calls } = makeClient()
    await mount(client)
    await settle(() => text().includes('1 field labelled differently'))
    await click(button(/1 field labelled differently/))
    expect(text()).toContain('“Supplier” on Sparing Order')
    await click(button('“Vendor”'))
    await settle(() => calls.some((c) => c._path === '/collection-layouts/2/ops'))
    const post = calls.find((c) => c._path === '/collection-layouts/2/ops')
    expect(post?._body).toMatchObject({
      base_rev: 'rev-2',
      ops: [
        {
          op: 'update_placement',
          at: { field: 'vendor', group_key: 'main' },
          patch: { label_override: null, overrides: null }
        }
      ]
    })
    expect(calls.some((c) => c._path === '/collection-layouts/1/ops')).toBe(false)
  })

  it('links a near copy to its parent after asking', async () => {
    const { client, calls } = makeClient()
    await mount(client)
    await settle(() => text().includes('2 forms are near copies'))
    await click(button(/2 forms are near copies/))
    expect(text()).toContain('Standard and Sparing Order are 94% the same')
    await click(button('Make Standard the parent…'))
    await click(button('Extend Standard'))
    await settle(() => calls.some((c) => c._path === '/collection-layouts/2/ops'))
    expect(calls.find((c) => c._path === '/collection-layouts/2/ops')?._body).toMatchObject({
      ops: [{ op: 'layout_update', patch: { parent_layout_id: 1 } }]
    })
  })

  it('compares two forms side by side', async () => {
    const { client } = makeClient()
    await mount(client)
    await settle(() => text().includes('2 forms are near copies'))
    await click(button(/2 forms are near copies/))
    await click(button('Compare side by side'))
    await settle(() => document.querySelectorAll('[data-stub-canvas]').length === 2)
    expect(text()).toContain('Compare forms')
    expect(text()).toContain('1 set up differently')
    expect(text()).toContain('1 only on Sparing Order')
    await click(button('List the differences'))
    expect(text()).toContain('Label: “Vendor” → “Supplier”')
    await click(button('Back to all forms'))
    expect(text()).toContain('Which form does each record get?')
  })

  it('finds a field across collections and opens the layout', async () => {
    const { client } = makeClient()
    const onOpen = await mount(client)
    await settle(() => text().includes('Find a field'))
    await click(button(/Find a field/))
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Find a field on every form"]'
    )
    if (!input) throw new Error('no input')
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      set?.call(input, 'vend')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle(() => text().includes('invoices.vendor'))
    expect(text()).toContain('Steps › Details · ½ · labelled “Supplier”')
    await click(document.querySelector('[data-field-placement="2"]') as HTMLElement)
    expect(onOpen).toHaveBeenCalledWith(2)
    await click(button(/Find a field/))
    await settle(() => text().includes('invoices.vendor'))
    await click(document.querySelector('[data-field-placement="9"]') as HTMLElement)
    expect(navigate).toHaveBeenCalledWith('/data-model/invoices?tab=groups&layout=9')
  })
})
